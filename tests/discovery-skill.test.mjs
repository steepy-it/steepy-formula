import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { withTransaction } from '../scripts/formula/engine/port.mjs';
import { importGraph } from '../scripts/formula/core/export.mjs';
import { DOGFOOD_CHECKPOINT, DOGFOOD_CHECKPOINT_SKIP } from './helpers/dogfood-checkpoint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const skillsDir = join(root, 'skills');
const promptPath = join(skillsDir, 'discovery', 'explore-surface-prompt.md');
const skillPath = join(skillsDir, 'discovery', 'SKILL.md');
const initSkillPath = join(skillsDir, 'init', 'SKILL.md');
const implementSkillPath = join(skillsDir, 'implement', 'SKILL.md');
const readmePath = join(root, 'README.md');

// Reuses the bare-invocation guard style from tests/workflow-skills.test.mjs.
const workflowCommands = ['init', 'new-surface', 'check', 'brainstorm', 'plan', 'implement', 'review'];

function assertNoBareWorkflowInvocations(text, label) {
  const commandAlternation = workflowCommands.join('|');
  const bareInvocation = new RegExp(`(^|[^\\w:.-])/(${commandAlternation})\\b`, 'm');
  assert.doesNotMatch(text, bareInvocation, `${label} must namespace shipped workflow slash commands`);
}

test('discovery: explore-surface-prompt.md exists', () => {
  assert.ok(existsSync(promptPath), 'skills/discovery/explore-surface-prompt.md should exist');
});

test('discovery: explore-surface-prompt.md instructs a per-area structured findings report', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(text, /observed conventions/i, 'must cover observed conventions');
  assert.match(text, /candidate anti-patterns/i, 'must cover candidate anti-patterns');
  assert.match(text, /candidate glossary terms/i, 'must cover candidate glossary terms');
  assert.match(text, /discovered doc files/i, 'must cover discovered doc files');
});

test('discovery: explore-surface-prompt.md enforces file:line evidence and no invention', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(text, /`file:line`/, 'must require file:line evidence on every finding');
  assert.match(text, /invent nothing/i, 'must instruct the explorer to invent nothing');
  assert.match(text, /drop/i, 'must instruct dropping unverifiable claims rather than guessing');
});

test('discovery: explore-surface-prompt.md sets an explicit model tier', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(text, /model:\s*(cheap|standard|most-capable)\b/, 'must set an explicit model tier');
});

test('discovery: explore-surface-prompt.md uses abstract tiers only, no concrete model ids', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.doesNotMatch(
    text,
    /\b(haiku|sonnet|opus)\b/,
    'must not hardcode a concrete model id — use the abstract tier'
  );
});

test('discovery: explore-surface-prompt.md accepts [REPORT_FILE] and writes the full report to it', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(text, /\[REPORT_FILE\]/, 'must name the [REPORT_FILE] dispatch parameter');
  assert.match(
    text,
    /writ(e|es|ing)[\s\S]{0,80}\[REPORT_FILE\]|\[REPORT_FILE\][\s\S]{0,80}writ(e|es|ing)/i,
    'must instruct writing the full report to [REPORT_FILE]'
  );
  assert.match(text, /full report/i, 'must call for the full report, not a partial one');
});

test('discovery: explore-surface-prompt.md returns only a terse (≤15-line) status', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(text, /≤\s*15|15\s*lines?/, 'must impose a terse ≤15-line return status');
});

test('discovery: explorer completion is self-contained, with counts in the report and no numeric schema dependency', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.doesNotMatch(text, /implementer-prompt\.md|\.md:\d+(?:-\d+)?/);
  assert.match(text, /status: <DONE\|BLOCKED>\n\s+artifact: \[REPORT_FILE\]\n\s+changed-paths: none\n\s+signals: <short IDs or none>/);
  assert.match(text, /item counts per area[^]*report/i);
  // Graph-only: the explorer's one hub input is the Step 0 resolved context, passed as [HUB_CONTEXT].
  assert.doesNotMatch(text, /HUB_MODE/, 'the explorer prompt carries no hub-mode parameter');
  assert.match(text, /\*\*Hub context:\*\* \[HUB_CONTEXT\]/);
  const skill = readFileSync(skillPath, 'utf8');
  assert.match(skill, /explore-surface-prompt\.md[^]*Output Format/i);
  assert.doesNotMatch(skill, /HUB_MODE/, 'the skill dispatches no hub-mode parameter');
  assert.match(skill, /\[HUB_CONTEXT\]/);
  assert.match(skill, /BLOCKED[^]*report[^]*stop[^]*interview/i);
});

test('changed cross-skill contract references resolve named headings and reject stale anchors', () => {
  const references = [
    {
      sourcePath: skillPath,
      targetPath: promptPath,
      targetLabel: 'skills/discovery/explore-surface-prompt.md',
      heading: 'Output Format',
    },
    {
      sourcePath: implementSkillPath,
      targetPath: initSkillPath,
      targetLabel: 'skills/init/SKILL.md',
      heading: 'Step 4 — Disk scaffolding (after the gate, disk-minimal)',
    },
  ];
  for (const reference of references) assertNamedHeadingReference(reference);

  for (const path of [skillPath, promptPath, implementSkillPath]) {
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      /(?:skills\/)?[^\s`]+\.md:\d+(?:-\d+)?/,
      `${path} must not retain numeric Markdown anchors`,
    );
  }

  assert.throws(() => assertNamedHeadingReference({
    ...references[0],
    heading: 'Then return ONLY (lines 47-52)',
  }));
  assert.throws(() => assertNamedHeadingReference({
    ...references[1],
    heading: 'Step 4.5',
  }));
});

test('discovery: explore-surface-prompt.md turns findings into item cards with the 4 named fields', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(text, /Proposed doc text/, 'must name the Proposed doc text field');
  assert.match(text, /Occurrences/, 'must name the Occurrences field');
  assert.match(text, /isolated precedent/i, 'must name the isolated precedent marker');
  assert.match(text, /Why it matters/, 'must name the Why it matters field');
});

test('discovery: SKILL.md exists with frontmatter name: discovery and user-invocable: true', () => {
  assert.ok(existsSync(skillPath), 'skills/discovery/SKILL.md should exist');
  const text = readFileSync(skillPath, 'utf8');
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fmMatch, 'discovery SKILL.md should have YAML frontmatter');
  assert.match(fmMatch[1], /name:\s*discovery\b/, 'frontmatter name must be discovery');
  assert.match(fmMatch[1], /user-invocable:\s*true/, 'must be user-invocable');
});

test('discovery: SKILL.md states the precondition — hub absent → run the abstract init skill and stop', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(text, /the `init` skill/, 'must point the user at the init skill by abstract name');
  assert.doesNotMatch(text, /\/steepy-formula:/, 'must not use a Claude-only namespaced slash invocation');
  assert.match(text, /absent/i, 'must name the absent-hub precondition');
  assert.match(text, /stop/i, 'must instruct the skill to stop when the hub is missing');
  assert.match(
    flat(text),
    /Stop and tell the user to run the `graph-migrate` skill \(invoke it the way your harness invokes skills\) before any other workflow\./,
    'the migrate mode must carry the exact graph-migrate stop',
  );
});

test('discovery: SKILL.md has a run-scoping step (surface + cross-cutting docs)', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step1, /scope/i, 'run-scoping step must use the word "scope"');
  assert.match(step1, /surface/i, 'run-scoping step must reference surface(s)');
  assert.match(
    step1,
    /cross-cutting|terms|rules/i,
    'run-scoping step must reference the cross-cutting terms and rules'
  );
});

test('discovery: SKILL.md names the full area taxonomy — Scope, Conventions, Anti-patterns, Testing', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(text, /\bScope\b/, 'must name Scope as a taxonomy area');
  assert.match(text, /\bConventions\b/, 'must name Conventions as a taxonomy area');
  assert.match(text, /\bAnti-patterns\b/, 'must name Anti-patterns as a taxonomy area');
  assert.match(text, /\bTesting\b/, 'must name Testing as a taxonomy area');
});

test('discovery: SKILL.md describes the seeded interview — accept / correct / skip', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(text, /accept/i, 'seeded interview must describe accepting an item');
  assert.match(text, /correct/i, 'seeded interview must describe correcting an item');
  assert.match(text, /skip/i, 'seeded interview must describe skipping an item');
});

test('discovery: SKILL.md has an emergent-area re-ask before drafting', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(text, /emergent|new area(s)?/i, 'must name the emergent/new-area case');
  assert.match(text, /ask/i, 'must ask the user before folding an emergent area in');
});

test('discovery: SKILL.md carries additive + diff-gated write-back language', () => {
  const text = readFileSync(skillPath, 'utf8');
  const additiveDiffGated = /diff-gated/i.test(text)
    || (/additive/i.test(text) && /(never overwrite|never clobber)/i.test(text));
  assert.ok(additiveDiffGated, 'must state the write-back is diff-gated, or additive + never overwrite/clobber');
});

test('discovery: SKILL.md dispatches explore-surface-prompt.md and sets model: explicitly near the dispatch', () => {
  const text = readFileSync(skillPath, 'utf8');
  const idx = text.indexOf('explore-surface-prompt.md');
  assert.ok(idx !== -1, 'must dispatch skills/discovery/explore-surface-prompt.md');
  const window = text.slice(idx, idx + 700);
  assert.match(window, /model:\s*(cheap|standard|most-capable)\b/, 'must set an explicit model tier near the dispatch');
});

test('discovery: SKILL.md namespaces every shipped workflow slash invocation', () => {
  const text = readFileSync(skillPath, 'utf8');
  assertNoBareWorkflowInvocations(text, 'skills/discovery/SKILL.md');
});

test('discovery: SKILL.md states it dispatches no reviewer subagent', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(text, /no reviewer subagent|no subagent reviewer/i, 'must state no reviewer subagent is dispatched');
});

test('discovery: SKILL.md is standalone — no chain Step 0 gear-read heading, no verdict-artifact phrase', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.doesNotMatch(text, /### Step 0 — Read the gear/, 'must not copy the chain skills\' gear-read Step 0');
  assert.doesNotMatch(text, /verdict artifact/i, 'must not reference a verdict artifact (chain-only concept)');
});

test('discovery: init SKILL.md Step 9 points the user at the abstract discovery skill to populate the scaffolded graph', () => {
  const text = readFileSync(initSkillPath, 'utf8');
  const step9 = sectionBetween(text, '### Step 9', undefined);
  assert.match(step9, /the `discovery` skill/, 'Step 9 must point the user at the discovery skill by abstract name');
  assert.doesNotMatch(step9, /\/steepy-formula:/, 'Step 9 must not use a Claude-only namespaced slash invocation');
  assert.match(step9, /populate/i, 'Step 9 pointer must frame discovery as populating the graph');
  assert.match(step9, /empty|scaffold/i, 'Step 9 pointer must name the graph as scaffolded/empty');
  assert.match(step9, /graph\s+channel/i, 'in graph mode the pointer must route discovery through its graph channel');
});

test('discovery: README.md Commands table registers the namespaced discovery command', () => {
  const text = readFileSync(readmePath, 'utf8');
  assert.match(text, /\/steepy-formula:discovery\b/, 'README must mention /steepy-formula:discovery');
});

test('discovery: the skills-standard registration survives in the canonical graph (G4 cutover)', { skip: DOGFOOD_CHECKPOINT_SKIP }, async () => {
  // The .apex/ Markdown hub is archived after the dogfood cutover; the standard's registration of
  // the discovery skill now lives in the canonical graph (the migrated skill:discovery node).
  const port = createMemoryPort();
  try {
    const restored = await importGraph(port, { filePath: DOGFOOD_CHECKPOINT, fs: { readFileSync } });
    assert.equal(restored.ok, true, `the dogfood checkpoint must import: ${JSON.stringify(restored)}`);
    const nodes = await withTransaction(port, (tx) => tx.listNodes({ namespace: 'curated' }));
    assert.ok(
      nodes.some((node) => node.id === 'apex:steepy-formula:skill:discovery'),
      'skill:discovery must be registered in the canonical graph',
    );
  } finally {
    await port.close();
  }
});

test('discovery: SKILL.md Step 2.2 passes [REPORT_FILE] and the interviewer reads the report from file', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(text, /\[REPORT_FILE\]/, 'must name the [REPORT_FILE] dispatch parameter');
  assert.match(
    text,
    /read(?:s)?[\s\S]{0,80}report[\s\S]{0,40}file|report file[\s\S]{0,80}read(?:s)?/i,
    'must instruct reading the report from the report file before the interview'
  );
});

test('discovery: SKILL.md Step 2.4 imposes a write-back preview with an explicit destination before acceptance', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /preview/i, 'must name the write-back preview');
  assert.match(
    step2,
    /destination|→\s*section|section\s*(of|→)/i,
    'must require an explicit destination doc/section in the preview'
  );
});

test('discovery: SKILL.md Step 2.4 forbids bare-ID options and requires printing the full card before acceptance prompts', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /bare ID|T1,\s*T2/i, 'must forbid bare-ID (T1, T2, …) options in the acceptance prompt');
});

test('discovery: SKILL.md Step 2.4 asks in harness-neutral prose — one question, numbered options, recommendation (D3)', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  // Flatten hard-wrapped prose so the lock pins the verbatim wording, not the wrap points.
  const flat = step2.replace(/\s+/g, ' ');
  assert.doesNotMatch(step2, /AskUserQuestion/, 'must not name the Claude-only AskUserQuestion tool');
  assert.match(
    flat,
    /ask one question at a time, with numbered options and a recommendation; use your harness's question UI if it has one/i,
    'must carry the ratified plain-prose questioning instruction (D3)'
  );
});

test('discovery: SKILL.md Step 2.2 dispatch is harness-conditional with an inline fallback (D1)', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  const flat = step2.replace(/\s+/g, ' ');
  assert.match(
    flat,
    /If your harness provides a task\/subagent tool[\s\S]{0,200}explore-surface-prompt\.md/i,
    'Step 2.2 must gate the subagent dispatch on the harness having a task/subagent tool'
  );
  assert.match(
    flat,
    /otherwise[\s\S]{0,140}inline[\s\S]{0,200}report/i,
    'Step 2.2 must fall back to an inline exploration pass and state the degradation in the run report'
  );
});

test('discovery: SKILL.md Step 0 declares the hub mode via steepy-formula hub-mode — the prose never re-implements detection', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Step 1');
  assert.match(step0, /[Rr]un `steepy-formula hub-mode` and carry its declared\s+mode/,
    'Step 0 must invoke steepy-formula hub-mode and carry the declared mode');
  assert.match(step0, /The command always exits 0/,
    'the declaration must state the command always exits 0 — a declaration, not a gate');
  assert.match(step0, /this prose never\s+re-implements its detection — the command is the single authority/,
    'the prose must never re-implement the mode detection');
  const declaration = step0.match(/\*\*Hub-mode declaration \(once per run\)\.\*\*[\s\S]*?(?=\n\n)/)?.[0] ?? '';
  assert.ok(declaration, 'Step 0 must carry the hub-mode declaration paragraph');
  assert.doesNotMatch(declaration, /_INDEX\.md/,
    'the declaration must not probe .apex/_INDEX.md existence to detect the mode');
  assert.match(step0, /`none`[\s\S]{0,220}the `init` skill[\s\S]{0,140}graph-first[\s\S]{0,80}stop/,
    'the none branch must tell the user to run the init skill (graph-first) and stop');
  assert.match(flat(step0), /`graph`, `migrate`, or `none`/, 'the mode list is exactly graph, migrate, or none');
  assert.match(
    flat(step0),
    /\*\*`migrate`\*\* → Stop and tell the user to run the `graph-migrate` skill \(invoke it the way your harness invokes skills\) before any other workflow\./,
    'the migrate branch must stop and point at graph-migrate',
  );
});

test('discovery: SKILL.md graph write-back rides typed candidates → promotion create/preview/apply — never an inline graph mutation', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step25 = sectionBetween(text, '5. **Write-back.**', '### Step 3');
  assert.match(step25, /promotion create/, 'the graph channel must name promotion create');
  assert.match(step25, /promotion preview/, 'the graph channel must name promotion preview');
  assert.match(step25, /promotion apply/, 'the graph channel must name promotion apply');
  assert.match(
    step25,
    /\.formula\/work\/discovery\/YYYY-MM-DD-<surface>-candidates\.json/,
    'the graph channel must name the typed candidates file path pattern'
  );
  assert.match(step25, /never an inline graph mutation/i,
    'the graph channel must forbid inline graph mutation');
  assert.match(step25, /without `--yes`/, 'apply must run at the human gate, without --yes');
  assert.match(step25, /scenario-assembly\.mjs/, 'the graph channel must name the closed-schema wrapper');
  assert.match(step25, /only interpreter/i, 'the wrapper must be the schema\'s only interpreter');
  // Flatten hard-wrapped prose so the pins lock the verbatim wording, not the wrap points.
  const flat = step25.replace(/\s+/g, ' ');
  assert.match(flat, /kind: ?'term', term, definition/, 'the term candidate shape must be pinned');
  assert.match(
    flat,
    /kind: ?'rule', title, statement, concern, strength, appliesTo/,
    'the rule candidate shape must be pinned with appliesTo'
  );
  assert.match(
    flat,
    /kind: ?'decision', title, statement, context/,
    'the decision candidate shape must be pinned with its three required text fields'
  );
  assert.match(
    flat,
    /no upward edge[\s\S]{0,120}apply blocks/,
    'the decision shape must carry the schema\'s anchoring caveat — unreachable at preview, blocking at apply'
  );
  assert.match(flat, /kind: ?'readme', note/, 'the readme candidate shape must be pinned');
});

test('discovery: SKILL.md Step 3 coherence gate is the graph gate', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');
  assert.match(step3, /graph validate/, 'graph mode must gate on steepy-formula graph validate');
  assert.match(step3, /context resolve/, 'graph mode must sanity context resolve after an applied scenario');
  assert.doesNotMatch(step3, /validate-hub|legacy|migrate/i, 'the gate is the graph gate only');
});

// The Markdown-hub files graph-first init never creates: no passage of the skill, and no dispatch
// of the explorer, may require reading any of them.
const MARKDOWN_HUB_FILE = /_INDEX\.md|\bstandards\/|conventions\.md|glossary\.md/;

test('discovery: SKILL.md requires no Markdown-hub file — every passage is doc-free', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.doesNotMatch(text, MARKDOWN_HUB_FILE, 'the skill must not require _INDEX.md, standards/, conventions.md, or glossary.md');
  const passages = [
    ['Step 0 mode branch', sectionBetween(text, '- **`graph`** →', 'Then read the hub')],
    ['Step 0 state read', sectionBetween(text, 'Then read the hub', '### Step 1')],
    ['Step 1 scoping', sectionBetween(text, '### Step 1', '### Step 2')],
    ['Step 2.2 explorer inputs', sectionBetween(text, 'Pass it the surface name/path', 'It reads the surface')],
    ['Step 2.4 routing', sectionBetween(text, '4. **Seeded interview.**', '5. **Write-back.**')],
    ['Step 2.5 write-back', sectionBetween(text, '5. **Write-back.**', 'Then drive the CLI')],
    ['Step 3 gate', sectionBetween(text, '### Step 3', '### Step 4')],
  ];
  for (const [label, passage] of passages) {
    assert.doesNotMatch(passage, MARKDOWN_HUB_FILE, `${label}: must not require a Markdown hub file`);
    assert.doesNotMatch(passage, /legacy/i, `${label}: must not branch on a second channel`);
  }
});

test('discovery: SKILL.md Step 0 graph bullet routes every stage graph-first', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Step 1');
  const flat0 = step0.replace(/\s+/g, ' ');
  assert.match(
    flat0,
    /Step 1 scoping offers the recorded terms and rules from the Step 0 `context resolve`/,
    'the graph bullet must send Step 1 scoping to the resolved context',
  );
  assert.match(
    flat0,
    /Step 2\.2 hands the explorer that resolved context/,
    'the graph bullet must hand the explorer the resolved context',
  );
  assert.match(
    flat0,
    /Step 2\.4 routes accepted items to typed candidate kinds, not doc sections/,
    'the graph bullet must route Step 2.4 acceptances to typed candidate kinds',
  );
});

test('discovery: SKILL.md Step 0 graph state read derives its surface targets deterministically', () => {
  const text = readFileSync(skillPath, 'utf8');
  const stateRead = sectionBetween(text, 'Then read the hub', '### Step 1');
  const flat = stateRead.replace(/\s+/g, ' ');
  assert.match(
    flat,
    /`\.claude\/agents\/<name>-agent\.md` → surface `<name>`/,
    'surface names must derive from the specialist agent files by naming convention'
  );
  assert.match(
    flat,
    /CLAUDE\.md's Surfaces section/,
    'the CLAUDE.md Surfaces section must be named as the fallback listing'
  );
  assert.match(
    flat,
    /hub-mode '<projectId>'/,
    "the project id must come from the hub-mode declaration's echo line"
  );
  assert.match(
    flat,
    /`apex:<projectId>:surface:<slug\(name\)>`/,
    'the surface node id must follow the structural qualified-id convention'
  );
  assert.match(
    flat,
    /structural-promotion\.mjs/,
    'the qualified-id convention must be sourced from structural-promotion.mjs'
  );
  assert.match(
    flat,
    /context resolve --target <surface node id>/,
    'the state read must target the derived surface node ids'
  );
  assert.match(
    flat,
    /bare project-root target returns an empty context/,
    'the empty project-root resolve must be demoted with an explicit warning'
  );
  assert.match(
    flat,
    /derived surface node ids are the `appliesTo` targets/,
    'the derived surface ids must be named as the Step 2.5 appliesTo targets'
  );
});

test('discovery: graph-mode explorer inputs are pinned — Step 0 resolved context in, hub docs out', () => {
  const skill = readFileSync(skillPath, 'utf8');
  const step2 = sectionBetween(skill, '### Step 2', '### Step 3');
  const flat = step2.replace(/\s+/g, ' ');
  assert.doesNotMatch(flat, /\[HUB_MODE\]/, 'the dispatch passes no hub-mode parameter');
  assert.match(
    flat,
    /the Step 0 resolved context \(`context\.json` \+ `context\.md`\) as `\[HUB_CONTEXT\]`[\s\S]{0,140}and nothing else/,
    'the hub input must be the Step 0 resolved context and nothing else'
  );
  assert.match(
    flat,
    /no Markdown hub doc exists/,
    'the dispatch must state that no Markdown hub doc exists'
  );
  const prompt = readFileSync(promptPath, 'utf8');
  assert.doesNotMatch(prompt, /\[HUB_MODE\]/, 'the prompt carries no [HUB_MODE] dispatch parameter');
  assert.match(prompt, /\[HUB_CONTEXT\]/, 'the prompt must accept the [HUB_CONTEXT] dispatch parameter');
  assert.match(
    prompt,
    /only hub input/i,
    'the prompt must bind the explorer to [HUB_CONTEXT] as its only hub input'
  );
});

test('discovery: explorer prompt requires no Markdown-hub file and carries no split proposal', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.doesNotMatch(text, MARKDOWN_HUB_FILE, 'the prompt must reference no Markdown-hub file');
  assert.doesNotMatch(text, /split proposal|legacy|HUB_MODE|standard filename/i, 'the prompt carries no second-channel or split-proposal text');
  assert.match(flat(text), /\(canonical Stable Knowledge Graph\)/, 'the prompt names the canonical Stable Knowledge Graph');
});

test('discovery: SKILL.md Step 2.4 graph routing targets the typed candidate kinds, never a doc section', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step24 = sectionBetween(text, '4. **Seeded interview.**', '5. **Write-back.**');
  const flat = step24.replace(/\s+/g, ' ');
  assert.match(
    flat,
    /One of the typed candidate kinds Step 2\.5 promotes — never a doc section/,
    'graph-mode routing must target the typed candidate kinds, never a doc section'
  );
  assert.match(flat, /glossary term → `term`/, 'a glossary term must route to the term kind');
  assert.match(flat, /convention or anti-pattern → `rule`/, 'a convention or anti-pattern must route to the rule kind');
  assert.doesNotMatch(
    flat,
    /left cross-surface/,
    'the schema requires appliesTo on every rule — an unscoped cross-surface rule option is unexpressible and must be gone'
  );
  assert.match(
    flat,
    /exactly one target per\s*rule/,
    'the routing must state the candidates schema admits exactly one appliesTo target per rule'
  );
  assert.match(
    flat,
    /one rule candidate per surface it applies to \(same statement, each with its own `appliesTo`\)/,
    'a multi-surface pattern must fan out into one rule candidate per surface'
  );
  assert.match(
    flat,
    /genuinely global pattern routes to `decision` or `readme`/,
    'a genuinely global pattern must route to decision or readme, never an unscoped rule'
  );
  assert.match(flat, /rationale worth recording → `decision`/, 'a recorded rationale must route to the decision kind');
  assert.match(flat, /out-of-graph note → `readme`/, 'an out-of-graph note must route to the readme kind');
  assert.match(
    flat,
    /the `readme` note it would become/,
    'a discovered doc in graph mode must preview as the readme note it becomes'
  );
});

function sectionBetween(text, startHeading, endHeading) {
  const s = text.indexOf(startHeading);
  assert.ok(s !== -1, `missing heading '${startHeading}'`);
  const e = endHeading ? text.indexOf(endHeading, s + startHeading.length) : -1;
  return e === -1 ? text.slice(s) : text.slice(s, e);
}

function assertNamedHeadingReference({ sourcePath, targetPath, targetLabel, heading }) {
  const source = readFileSync(sourcePath, 'utf8');
  const target = readFileSync(targetPath, 'utf8');
  assert.ok(source.includes(targetLabel), `${sourcePath} must name ${targetLabel}`);
  assert.ok(source.includes(`"${heading}"`), `${sourcePath} must reference heading "${heading}"`);
  const headingLine = target.split('\n').some((line) => {
    const match = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    return match?.[1] === heading;
  });
  assert.ok(headingLine, `${targetPath} must contain heading "${heading}"`);
}

// Inception source (inception v1): SC11 and SC12. Appended blocks; the blocks above stay unchanged.
// Formula: the source runs on the graph channel only — accepted decisions land as typed candidates
// through one promotion scenario, and its one-time window is the initialization revision.
const inceptionPromptPath = join(skillsDir, 'discovery', 'explore-inception-prompt.md');
const STEP_2A = '### Step 2a — Inception source (complete run only)';

// Flatten hard-wrapped prose so a lock pins the wording, not the wrap points.
function flat(text) {
  return text.replace(/\s+/g, ' ');
}

test('discovery inception source (SC11): Step 1 offers only a v2 complete candidate without body reads', () => {
  const step1 = flat(sectionBetween(readFileSync(skillPath, 'utf8'), '### Step 1', '### Step 2'));
  assert.match(step1, /If `\.formula\/inception\/run\.json` exists, its `schema` is `steepy-inception-run\/v2`.*`status` is `complete`/);
  assert.match(step1, /offer the \*\*inception source\*\*/);
  assert.match(step1, /Read only that one file.*never list `\.formula\/inception\/`/);
  assert.match(step1, /candidate.*not.*verified/i);
  assert.match(step1, /unsupported run format.*ordinary discovery/i);
  assert.doesNotMatch(step1, /documents\[\]|verification\.path/);
  // The window is the certified initialization revision, so the gate must precede any promotion.
  assert.match(step1, /chooses the inception source, run Step 2a right after this step, before Step 2/);
  assert.match(step1, /window is the certified initialization revision/);
  assert.match(step1, /any promotion before the gate ends the source/);
  assert.doesNotMatch(step1, /legacy|Markdown hub/i);
});

test('discovery inception source (SC11): Step 2a sits between Step 2 and Step 3 and runs only on the user\'s choice', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step2 = text.indexOf('### Step 2 — Per-surface iterative loop');
  const step2a = text.indexOf(STEP_2A);
  const step3 = text.indexOf('### Step 3 — Coherence gate');
  assert.ok(step2 !== -1 && step2a > step2 && step3 > step2a, 'Step 2a must sit between Step 2 and Step 3');
  const section = flat(sectionBetween(text, STEP_2A, '### Step 3'));
  assert.match(section, /Run this step only when the user chose the inception source in Step 1\./);
  assert.match(section, /It runs right after Step 1 and before Step 2/);
  assert.match(section, /never list `\.formula\/inception\/`/, 'Step 2a must never list the area');
  assert.match(section, /A stop in this step ends only the inception source; Step 2, Step 3 and Step 4 still run\./);
});

test('discovery inception source (SC11): complete gate precedes source body reads and failures stop only the source', () => {
  const raw = sectionBetween(readFileSync(skillPath, 'utf8'), STEP_2A, '### Step 3');
  const section = flat(raw);
  const gate = raw.indexOf('node <engine-root>/scripts/inception-state.mjs verify-complete --repo-root .');
  const read = raw.indexOf('Only after');
  assert.ok(gate >= 0 && read > gate, 'verify-complete must come before document body reads');
  assert.match(section, /Before reading.*approval.*document.*summary.*report.*run:/i);
  assert.match(section, /`ok: true`.*`runId`.*`completion`.*`inputPaths`.*`checks`.*`coverage`/);
  assert.match(section, /unsupported run format.*tamper.*application-drift/);
  assert.match(section, /`steepy-formula graph status` must report `head:` equal to `apex:<projectId>:revision:r1`/);
  assert.match(section, /graph changed since the certified init/);
  assert.match(section, /ordinary discovery.*surfaces already selected/i);
  assert.match(section, /Never.*design choices/i);
  assert.match(section, /complete run.*immutable/i);
  assert.doesNotMatch(section, /verify-approval|verification\.path|last element.*approvals|documents\[\]\.path/);
  assert.match(section, /decision-register\.md.*not among.*`inputPaths`/);
});

test('discovery inception source (SC11): Step 2a passes exactly the verified returned inputPaths as [INPUT_PATHS] with an explicit model:', () => {
  const text = readFileSync(skillPath, 'utf8');
  const raw = sectionBetween(text, STEP_2A, '### Step 3');
  const section = flat(raw);
  assert.match(section, /`\[REPORT_FILE\] = \.formula\/work\/discovery\/YYYY-MM-DD-inception\.md`/);
  assert.match(
    section,
    /If your harness provides a task\/subagent tool, dispatch a fresh subagent using `skills\/discovery\/explore-inception-prompt\.md`/,
  );
  const idx = raw.indexOf('explore-inception-prompt.md');
  assert.ok(idx !== -1, 'Step 2a must dispatch skills/discovery/explore-inception-prompt.md');
  assert.match(raw.slice(idx, idx + 300), /model: standard/, 'must set model: standard explicitly near the dispatch');
  assert.match(
    section,
    /Pass `\[INPUT_PATHS\]` = exactly the successful gate\x27s `inputPaths` array, unchanged — no other run path\./,
  );
  assert.match(section, /as `\[HUB_CONTEXT\]`, the Step 0 resolved context/);
  assert.match(
    section,
    /Otherwise run the same prompt inline over the same inputs, and state the inline degradation in the run's report/,
  );
  assert.match(section, /`skills\/discovery\/explore-inception-prompt\.md` → "Output Format"/);
});

test('discovery inception source (SC11): the surface flow text is otherwise unchanged', () => {
  const text = readFileSync(skillPath, 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Step 1');
  assert.match(
    flat(step0),
    /\*\*`none`\*\* → the hub is absent: tell the user to run the `init` skill \(invoke it the way your harness invokes skills\) — the graph-first entry point — and \*\*stop\*\*\. `discovery` populates an existing hub, it does not create one\./,
    'Step 0 must keep its absent-hub stop',
  );
  assert.doesNotMatch(step0, /inception/i, 'Step 0 must not change for the inception source');
  const surfaceLoop = sectionBetween(text, '### Step 2 — Per-surface iterative loop', '### Step 2a');
  assert.doesNotMatch(surfaceLoop, /inception/i, 'the per-surface loop must not change for the inception source');
  assert.match(
    flat(surfaceLoop),
    /If your harness provides a task\/subagent tool, dispatch a fresh subagent per surface using `skills\/discovery\/explore-surface-prompt\.md`; otherwise perform the exploration inline in a dedicated pass over the same inputs, and state the inline degradation in the run's report \(Step 4\)\. When you dispatch, always set `model: standard` explicitly/,
    'Step 2 must keep its explorer dispatch',
  );
  const firstSurfacePrompt = text.indexOf('explore-surface-prompt.md');
  assert.ok(
    firstSurfacePrompt > text.indexOf('### Step 2 — Per-surface iterative loop') && firstSurfacePrompt < text.indexOf(STEP_2A),
    'the first mention of explore-surface-prompt.md must stay in Step 2.2',
  );
});

test('discovery inception source (SC12): Step 2a walks the decision register, one card per DR-n, under the Step 2.4 interview', () => {
  const text = readFileSync(skillPath, 'utf8');
  const section = flat(sectionBetween(text, STEP_2A, '### Step 3'));
  assert.match(section, /one item card per `DR-n`/);
  assert.match(section, /Proposed doc text/);
  assert.match(section, /Evidence \(the local file and line; it is for the interview only\)/);
  assert.match(section, /Verification status \(from the verified summary's `coverage` entries\)/);
  assert.match(section, /Promotion class/);
  assert.match(section, /write-back preview: the typed candidate exactly as it will land in the candidates file/);
  assert.match(section, /accept \/ correct \/ skip interview as Step 2\.4/);
  assert.match(section, /Never use bare IDs \(DR-1, DR-2, …\) as option labels/, 'the bare-ID ban must cover DR-n');
  assert.match(section, /A skip is a rejection: ask the user for its reason\./);
});

test('discovery inception source (SC12): Step 2a states the three promotion rules', () => {
  const text = readFileSync(skillPath, 'utf8');
  const section = flat(sectionBetween(text, STEP_2A, '### Step 3'));
  assert.match(section, /Approved and verified \(`verified`\) → may land as a `rule` candidate scoped `appliesTo` one surface node id/);
  assert.match(
    section,
    /Approved but unverified \(`unverified`\) → lands as a `decision` candidate recording a design choice, never as a rule asserting an existing component\./,
  );
  assert.match(
    section,
    /A future flow \(`future`\) → lands as a `decision` candidate whose context marks the future flow, never as a rule, a spec, or a started task\./,
  );
});

test('discovery inception source (SC12): write-back is one typed promotion scenario and never names the area', () => {
  const text = readFileSync(skillPath, 'utf8');
  const raw = sectionBetween(text, STEP_2A, '### Step 3');
  const section = flat(raw);
  assert.match(section, /into one candidates file `\.formula\/work\/discovery\/YYYY-MM-DD-inception-candidates\.json` \(the Step 2\.5 schema\)/);
  assert.match(section, /Candidate text never names, cites, or links `\.formula\/inception\/`/);
  for (const command of [
    'steepy-formula promotion create --project <id> --candidates <file.json> [--proposer <name>] inception-<runId>',
    'steepy-formula promotion preview inception-<runId>',
    'steepy-formula promotion apply inception-<runId>',
  ]) assert.ok(raw.includes(command), `Step 2a must drive ${command}`);
  assert.match(section, /apply only at the human gate, without `--yes`/);
  assert.doesNotMatch(section, /`conventions\.md`|`glossary\.md`|_INDEX\.md/, 'the graph channel writes no Markdown hub doc');
});

test('discovery inception source (SC12): every decision ends accepted or rejected with a reason under ## Decision outcomes', () => {
  const text = readFileSync(skillPath, 'utf8');
  const section = flat(sectionBetween(text, STEP_2A, '### Step 3'));
  assert.match(section, /Every register decision ends accepted \(promoted\) or rejected with a reason\./);
  assert.match(
    section,
    /Record the outcomes in `\[REPORT_FILE\]` under `## Decision outcomes`, one line per decision: `DR-n — accepted` or `DR-n — rejected: <reason>`\./,
  );
  assert.doesNotMatch(section, /Re-runs follow the new-or-drifted rule/);
  assert.match(section, /The import is one-time\./);
  assert.match(section, /the graph head moves past the initialization revision, so a later run's gate refuses the source.*ordinary discovery/);
  // An interrupted interview must not consume the one-time import: the promotion waits for the last decision.
  assert.match(section, /this source batches its write: promote nothing until every register decision is decided/);
  assert.match(section, /next run's gate still passes and the import starts again/);
  assert.match(section, /record the decision outcomes \(item 6\) and write every accepted candidate, verbatim as previewed, into one candidates file/);
  assert.match(section, /If the apply was refused, nothing landed and the window stays open; the run's `\[REPORT_FILE\]` still lists every accepted decision under `## Decision outcomes`/);
  const step4 = flat(sectionBetween(text, '### Step 4', '## Model Selection'));
  assert.match(step4, /inception source[^]*`## Decision outcomes`/, 'Step 4 must report the inception decision outcomes');
});

test('discovery inception source (SC12): Model Selection covers the inception explorer', () => {
  const text = readFileSync(skillPath, 'utf8');
  const model = flat(sectionBetween(text, '## Model Selection'));
  assert.match(
    model,
    /Always set `model:` explicitly when dispatching the Explore subagent in Step 2\.2 and the inception explorer in Step 2a\.2/,
  );
  assert.match(model, /Never hardcode a concrete model id in `explore-surface-prompt\.md` or `explore-inception-prompt\.md`\./);
  assert.match(model, /no reviewer subagent/i);
});

test('discovery inception source (SC12): explore-inception-prompt.md is an explorer at the standard tier with its placeholders', () => {
  assert.ok(existsSync(inceptionPromptPath), 'skills/discovery/explore-inception-prompt.md should exist');
  const text = readFileSync(inceptionPromptPath, 'utf8');
  assert.match(text, /```\nSubagent \(explorer\):\n {2}model: standard\b/, 'must be a fenced explorer with model: standard');
  for (const placeholder of ['[INPUT_PATHS]', '[REPORT_FILE]', '[HUB_CONTEXT]']) {
    assert.ok(text.includes(placeholder), `must name the ${placeholder} placeholder`);
  }
  assert.doesNotMatch(text, /\b(haiku|sonnet|opus)\b/, 'must not hardcode a concrete model id');
  assert.doesNotMatch(text, /general-purpose|\/steepy-formula:|CLAUDE_/);
  assert.doesNotMatch(text, /[^\s`]+\.md:\d+/, 'must not carry numeric Markdown anchors');
  const body = flat(text);
  assert.match(body, /If your harness provides a task\/subagent tool, dispatch a fresh explorer subagent/);
  assert.match(
    body,
    /Otherwise perform the exploration yourself in a dedicated pass over the same inputs, and state the inline degradation in the run's report\./,
  );
});

test('discovery inception source (SC12): explore-inception-prompt.md reads exactly its inputs and never lists the area or writes hub or code', () => {
  assert.ok(existsSync(inceptionPromptPath), 'skills/discovery/explore-inception-prompt.md should exist');
  const body = flat(readFileSync(inceptionPromptPath, 'utf8'));
  assert.match(body, /Read exactly the files in \[INPUT_PATHS\] and \[HUB_CONTEXT\]\./);
  assert.doesNotMatch(body, /\[GLOSSARY_PATH\]|\[CONVENTIONS_PATH\]|\[STANDARD_PATHS\]/, 'the graph-channel explorer reads no Markdown hub doc');
  assert.match(
    body,
    /Never list `\.formula\/inception\/` or read anything else under it, never read under `\.formula\/work\/`, and never write to the hub or the codebase\./,
  );
});

test('discovery inception source (SC12): explore-inception-prompt.md writes one card per DR-n with file:line evidence and invents nothing', () => {
  assert.ok(existsSync(inceptionPromptPath), 'skills/discovery/explore-inception-prompt.md should exist');
  const text = readFileSync(inceptionPromptPath, 'utf8');
  const body = flat(text);
  assert.match(body, /One item card per `DR-n` row of the decision register, in register order/);
  for (const field of ['Proposed doc text', 'Evidence', 'Verification status', 'Promotion class', 'Destination']) {
    assert.match(text, new RegExp(`\\*\\*${field}:\\*\\*`), `each card must carry the ${field} field`);
  }
  assert.match(text, /`file:line`/, 'must require file:line evidence');
  assert.match(text, /## Invent Nothing/);
  assert.match(body, /`verified` → `existing rule`/);
  assert.match(body, /`unverified` → `design choice`/);
  assert.match(body, /`future` → `future context`/);
  assert.match(body, /The Proposed doc text never names, cites, or links `\.formula\/inception\/`/);
  assert.match(body, /the interviewer records `## Decision outcomes`/);
});

test('discovery inception source (SC12): explore-inception-prompt.md returns only the four-field status', () => {
  assert.ok(existsSync(inceptionPromptPath), 'skills/discovery/explore-inception-prompt.md should exist');
  const text = readFileSync(inceptionPromptPath, 'utf8');
  assert.match(text, /status: <DONE\|BLOCKED>\n\s+artifact: \[REPORT_FILE\]\n\s+changed-paths: none\n\s+signals: <short IDs or none>/);
  assert.match(text, /≤\s*15/, 'must impose a terse ≤15-line return');
  assertNamedHeadingReference({
    sourcePath: skillPath,
    targetPath: inceptionPromptPath,
    targetLabel: 'skills/discovery/explore-inception-prompt.md',
    heading: 'Output Format',
  });
});

test('discovery inception source (SC12): explore-surface-prompt.md gains the inception read boundary in its read paragraph', () => {
  const text = readFileSync(promptPath, 'utf8');
  assert.match(
    text,
    /beyond what is needed to confirm a finding\.\n {4}Never read under `\.formula\/work\/` or `\.formula\/inception\/`: inception material reaches discovery only\s+through its inception source\./,
  );
});


test('discovery inception explorer consumes verified summary coverage without following descriptor refs', () => {
  const body = flat(readFileSync(inceptionPromptPath, 'utf8'));
  assert.match(body, /successful `verify-complete`.*`inputPaths`/);
  assert.match(body, /verified summary.*`checks`.*`coverage`/);
  assert.match(body, /Never follow.*refs.*raw evidence/i);
  assert.match(body, /no.*gate.*BLOCKED/i);
  assert.match(body, /`coverage`.*`id`.*`status`/);
  assert.match(body, /`DR-1` → `dr-1`/);
  assert.doesNotMatch(body, /descriptor.*verification\.path|latest.*approval|## Coverage.*rows/);
});
