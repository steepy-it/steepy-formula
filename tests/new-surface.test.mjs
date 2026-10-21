import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// skills/new-surface/SKILL.md — mode-aware prose pins. The regression guarded
// here: on a graph-first repo (no markdown hub) the old skill scaffolded
// .apex/standards/<name>.md and told the operator to paste a routing row into a
// nonexistent _INDEX.md — making .apex/ non-work-only with no index, which
// flips validate-hub (and the Stop hook) permanently red. The graph branch
// must create no markdown-hub file and instead render the graph-mode agent and
// promote the Surface (verification Rule + Check with ext_v1_command) through
// the structural-promotion helper.
// ---------------------------------------------------------------------------

const skillText = readFileSync(join(here, '..', 'skills', 'new-surface', 'SKILL.md'), 'utf8');

function sectionBetween(body, startMarker, endMarker) {
  const start = body.indexOf(startMarker);
  assert.ok(start >= 0, `section marker not found: ${startMarker}`);
  if (endMarker === null) return body.slice(start);
  const end = body.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `section end marker not found after '${startMarker}': ${endMarker}`);
  return body.slice(start, end);
}

test('new-surface skill: description is mode-aware and the hub-mode declaration routes the run', () => {
  const fm = skillText.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, 'SKILL.md must keep YAML frontmatter');
  assert.match(fm[1], /name:\s*new-surface\b/);
  assert.match(fm[1], /user-invocable:\s*true/);
  assert.match(fm[1], /hub-mode/, 'the description must name the hub-mode declaration');
  assert.match(fm[1], /graph/, 'the description must name the graph route');
  assert.match(fm[1], /legacy/, 'the description must name the legacy route');

  const declaration = sectionBetween(skillText, '2. **Declare the hub mode.**', '### Legacy mode');
  assert.match(declaration, /`steepy-formula hub-mode`/, 'the declaration must run steepy-formula hub-mode');
  assert.match(declaration, /`mode:` line/, 'the declaration must quote the mode: line');
  assert.match(declaration, /single authority/, 'detection must stay with the command');
  assert.match(declaration, /\| `legacy` \| Steps 3–5/, 'the legacy row must route to the markdown scaffold steps');
  assert.match(declaration, /\| `graph` \| Steps 6–9/, 'the graph row must route to the promotion steps');
  assert.match(declaration, /Never scaffold `\.apex\/standards\/`/, 'the graph row must forbid the standards scaffold');
  assert.match(declaration, /never touch `\.apex\/_INDEX\.md`/, 'the graph row must forbid touching _INDEX.md');
  assert.match(declaration, /permanently red/, 'the rationale must name the linter/Stop-hook consequence');
  assert.match(declaration, /\| `none` \|.*`init` skill/, 'mode none must route to init and stop');
  // The declaration precedes both branches.
  assert.ok(skillText.indexOf('**Declare the hub mode.**') < skillText.indexOf('### Legacy mode'));
  assert.ok(skillText.indexOf('**Declare the hub mode.**') < skillText.indexOf('### Graph mode'));
});

test('new-surface skill step 1 gathers the specialist agent alongside name, path, and test command', () => {
  const gather = sectionBetween(skillText, '## Procedure', '2. **Declare the hub mode.**');
  assert.match(gather, /four pieces of information/i, 'the gathered input set is four pieces now');
  assert.match(gather, /Specialist agent/i, 'the specialist agent must be gathered');
  assert.match(gather, /defaulting to `<name>-agent` only when the user accepts it/,
    'the <name>-agent default is accepted, never assumed');
});

test('new-surface skill legacy branch: planner-composed scaffolder invocation + validate-hub gate', () => {
  const legacy = sectionBetween(skillText, '### Legacy mode', '### Graph mode');
  assert.match(legacy, /node <engine-root>\/scripts\/new-surface\.mjs/, 'the legacy branch must run the shipped scaffolder');
  for (const flag of ['--name <name>', '--path <path>', '--agent <agent>', '--test "<testCmd>"', '--hub <repo-root>']) {
    assert.ok(legacy.includes(flag), `the scaffolder invocation must keep ${flag}`);
  }
  assert.match(legacy, /node <engine-root>\/scripts\/validate-hub\.mjs \./, 'the legacy verify step must keep validate-hub with the explicit `.`');
  assert.doesNotMatch(legacy, /structural-promotion/, 'the legacy branch must not mix in the graph promotion');
});

// Task 18 (apex v0.9.4 port + the Task 15 accumulated forward requirement): the
// legacy branch states the planner-composed reality — the three stale-prose fixes.
test('new-surface skill legacy branch states the planner-composed active-v1/preparatory-unbound reality', () => {
  const legacy = sectionBetween(skillText, '### Legacy mode', '### Graph mode');
  // the planner contract both modes share
  assert.match(legacy, /project-scaffold\.mjs/, 'the legacy branch must name the common project planner');
  assert.match(legacy, /active-v1[\s\S]*real Project identity[\s\S]*full Project model/iu,
    'active-v1 derives the real Project identity and routes through the full Project model');
  assert.match(legacy, /preparatory-unbound[\s\S]*without pretending to update a Project/iu,
    'preparatory-unbound must stay explicit about not updating a nonexistent Project identity');
  assert.match(legacy, /standard[\s\S]*create-only/iu, 'the standard remains create-only');
  assert.match(legacy, /plans all four[\s\S]*before the first[\s\S]*write/i,
    'preparatory-unbound plans all four artifacts before the first write');
  assert.match(legacy, /root,\s+routing\s+row,\s+standard,\s+and\s+triad\s+agree/iu,
    'active-v1: the public workflow already made the artifacts agree');
  assert.match(legacy, /bytes, modes, and mtimes unchanged/iu,
    'the --repair rerun must be a byte/mode/mtime-preserving no-op');
  // fix 1 — the surface result is four artifacts, not "the two files it created"
  assert.match(legacy, /four artifacts/i, 'the surface result must be stated as four artifacts');
  for (const path of [
    '.apex/standards/<name>.md',
    '.claude/agents/<agent>.md',
    '.codex/agents/<agent>.toml',
    '.opencode/agents/<agent>.md',
  ]) {
    assert.ok(legacy.includes(path), `the surface result must name ${path}`);
  }
  assert.doesNotMatch(legacy, /two files/, 'the stale "two files" print claim must be gone');
  // fix 2 — on bound (active-v1) legacy hubs the script inserts the routing row itself
  assert.match(legacy, /inserts the routing row\s+itself/i,
    'active-v1: the script inserts the routing row itself (staged, create-only)');
  assert.match(legacy, /active-v1 root instructions and routing are\s+coherent with the surface result/,
    'active-v1: the coherence line the script prints must be quoted');
  assert.match(legacy, /preparatory-unbound\*\* mode only,\s+the\s+paste-row flow survives/i,
    'the paste-row flow must survive only on preparatory-unbound hubs');
  assert.doesNotMatch(legacy, /intentionally does not edit/,
    'the stale "intentionally does not edit _INDEX.md" claim must be gone');
  // fix 3 — conflict resolution for active-v1 hubs with a customized spine
  assert.match(legacy, /--resolution <id=choice>/, 'conflicts route through --resolution <id=choice>');
  assert.match(legacy, /customized\s+spine/, 'the customized-spine conflict example must be named');
});

test('new-surface skill graph branch: creates no markdown-hub file — agent rendered from surface-agent-graph.md, no standards doc, no _INDEX.md', () => {
  const graph = sectionBetween(skillText, '### Graph mode', null);
  assert.match(graph, /`\.claude\/agents\/<surface-name>-agent\.md`/, 'the graph branch must create the deterministic agent file');
  assert.match(graph, /<engine-root>\/templates\/surface-agent-graph\.md/, 'the agent must be rendered from the graph-mode template');
  assert.match(graph, /`\{\{name\}\}` and `\{\{path\}\}`/, 'the render must substitute the template placeholders');
  assert.match(graph, /NOT invoked/, 'the legacy scaffolder must be explicitly not invoked');
  assert.match(graph, /no routing table in graph\s+mode/, 'binding must be deterministic, no routing table');
  assert.doesNotMatch(graph, /\.apex\/standards\//, 'the graph branch must never name a standards path');
  assert.doesNotMatch(graph, /_INDEX\.md/, 'the graph branch must never name _INDEX.md');
  assert.doesNotMatch(graph, /validate-hub/, 'the graph branch must never run the legacy linter');
});

test('new-surface skill graph branch: drives the structural-promotion helper with its real flags and input shape, then preview/apply', () => {
  const graph = sectionBetween(skillText, '### Graph mode', null);
  // The helper invocation, with the flags scripts/structural-promotion.mjs actually parses.
  assert.match(graph, /node <engine-root>\/scripts\/structural-promotion\.mjs/, 'the graph branch must drive the shipped helper');
  assert.match(graph, /--project <projectId> --port docker/, 'the helper must be invoked with --project and --port docker');
  assert.match(graph, /--input \.apex\/work\/new-surface-<surface-name>\.json new-surface-<surface-name>/,
    'the helper must take the work-area structural input and a scenario id positional');
  // The structural input carries the surface and its approved test command.
  assert.match(graph, /"project": \{ "id": "<projectId>" \}/, 'the input must declare the project id');
  assert.match(graph, /"name": "<surface-name>", "path": "<surface-path>"/, 'the input must carry the surface name and path');
  assert.match(graph, /"testCommand": "<test-command>"/, 'the input must carry the approved test command');
  // The mapping the helper performs: Surface + verification Rule + Check with ext_v1_command.
  assert.match(graph, /`PART_OF` → the\s+Project root/, 'the Surface must be attached to the Project root');
  assert.match(graph, /verification Rule/, 'the test command must derive the verification Rule');
  assert.match(graph, /`APPLIES_TO` → the Surface/, 'the Rule must apply to the Surface');
  assert.match(graph, /`ext_v1_command`/, 'the Check must persist the command as ext_v1_command');
  assert.match(graph, /`VERIFIED_BY`/, 'the Rule must be VERIFIED_BY the Check');
  assert.match(graph, /works on an initialized graph/, 'the helper must be usable post-init (existing ADDs skipped)');
  // Preview/apply flow through the ordinary promotion commands, human-gated.
  assert.match(graph, /steepy-formula promotion preview new-surface-<surface-name>/);
  assert.match(graph, /steepy-formula promotion apply new-surface-<surface-name>/);
  assert.match(graph, /WITHOUT `--yes`/, 'apply must stay interactively human-gated');
  assert.match(graph, /exit 21/, 'the CLI refusal exit code must be named');
  // Closing verification: graph gate + resolver spot-check serving the command back.
  assert.match(graph, /steepy-formula graph validate\n\s*steepy-formula context resolve --target apex:<projectId>:surface:<slug\(name\)>/,
    'the verify step must run graph validate then a target-based context resolve spot-check');
  assert.doesNotMatch(graph, /context resolve --path <surface-path>\n/,
    'the fenced verify spot-check must not prescribe --path (UNRESOLVED on a curated-only graph)');
  assert.match(graph, /Check carrying the approved test command as\s+`ext_v1_command`/,
    'the resolved context must serve the command back from the Check');
});
