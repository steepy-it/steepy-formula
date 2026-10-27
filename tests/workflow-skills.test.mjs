import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProjectModel, renderProjectArtifact } from '../scripts/project-scaffold.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, '..', 'skills');
const root = join(here, '..');
const workflowCommands = [
  'inception',
  'init',
  'new-surface',
  'check',
  'brainstorm',
  'plan',
  'implement',
  'review',
  'loop-engineer',
];

function namespacedCommand(command) {
  return `/steepy-formula:${command}`;
}

function assertNoBareWorkflowInvocations(text, label) {
  const commandAlternation = workflowCommands.join('|');
  const bareInvocation = new RegExp(`(^|[^\\w:.-])/(${commandAlternation})\\b`, 'm');
  assert.doesNotMatch(text, bareInvocation, `${label} must namespace shipped workflow slash commands`);
}

function checkSkill(name, mustReference) {
  const path = join(skillsDir, name, 'SKILL.md');
  assert.ok(existsSync(path), `${name}/SKILL.md should exist`);
  const text = readFileSync(path, 'utf8');
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fmMatch, `${name} should have YAML frontmatter`);
  const fm = fmMatch[1];
  assert.match(fm, new RegExp(`name:\\s*${name}\\b`), `${name} frontmatter name must match dir`);
  assert.match(fm, /user-invocable:\s*true/, `${name} must be user-invocable`);
  for (const ref of mustReference) {
    assert.ok(text.includes(ref), `${name} must reference '${ref}' (hub integration)`);
  }
}

test('brainstorm: valid user-invocable skill, writes spec into .formula/work/specs/', () => {
  checkSkill('brainstorm', ['.formula/work/specs/', 'steepy-formula graph validate']);
});

test('brainstorm: local-work contract is explicit and forbids stable registration', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  assert.match(
    text,
    /description:\s+Turn an idea into a local working spec under \.formula\/work\/specs\/\./,
    'brainstorm description must describe the local working-spec contract'
  );
  assert.match(text, /5\. Finalize the approved draft/);
  assert.match(text, /6\. Validate the graph with `steepy-formula graph validate` \(deterministic gate\)\./);
  assert.match(text, /### Step 5 — Finalize the approved draft/);
  assert.match(text, /Create `\.formula\/work\/specs\/` if it does not exist\./);
  assert.match(text, /Do not create a specs sub-index\./);
  assert.match(text, /Specs are local workflow artifacts, not stable hub documentation\./);
  assert.doesNotMatch(text, /_INDEX\.md|validate-hub|\blegacy\b/i, 'brainstorm is graph-only: no Markdown hub, linter, or legacy branch');
  assert.doesNotMatch(text, /hub-governed spec/i);
});

test('brainstorm: Step 4 writes the draft into the spec file (gate), Step 5 finalizes it', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step4 = sectionBetween(text, '### Step 4 — Present the design (gate)', '### Step 5');
  assert.match(step4, /^status: DRAFT$/m, 'Step 4 must write the draft with the workflow header status: DRAFT');
  assert.match(step4, /\.formula\/work\/specs\//, 'Step 4 must write the draft to .formula/work/specs/');
  assert.match(
    step4,
    /no finalization,? no handoff,? no hub mutation until the user approves/i,
    'Step 4 must state the gate is unchanged: no finalization, no handoff, no hub mutation until approval'
  );

  const step5 = sectionBetween(text, '### Step 5 — Finalize the approved draft', '### Step 5.5');
  assert.match(
    step5,
    /leave the workflow header at `status: DRAFT` until the applicable approval gate completes/i,
    'Step 5 must keep the header DRAFT until the approval gate completes'
  );
});

test('brainstorm: Step 1.5 resolves CONFLICT — doc-wins, confirm, override→doc rewritten to the active rule', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step15 = sectionBetween(text, '### Step 1.5', '### Step 2 — Understand');
  assert.match(step15, /`file:line`/, 'CONFLICT resolution must cite file:line');
  assert.match(step15, /doc-wins/i, 'CONFLICT resolution must default to doc-wins');
  assert.match(step15, /confirm/i, 'CONFLICT resolution must require explicit user confirmation');
  assert.match(step15, /override/i, 'CONFLICT resolution must support an explicit override');
  assert.match(step15, /never touch the hub from here/i, 'an override must never mutate the hub from brainstorm');
  assert.match(step15, /typed deferred proposal/i, 'an override is recorded as a typed deferred proposal');
  assert.doesNotMatch(step15, /the doc changes|rewrite the governing doc/i, 'override must not rewrite a governing doc');
  assert.doesNotMatch(step15, /record the supersession/i, 'override must not prescribe a supersession ledger');
});

test('brainstorm: Step 1.5 resolves GAP — explore-first, consistency threshold, isolated precedent, no-precedent→brainstorm', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step15 = sectionBetween(text, '### Step 1.5', '### Step 2 — Understand');
  assert.match(step15, /explore the codebase first/i, 'GAP resolution must explore the codebase before brainstorming');
  assert.match(step15, /2–3|2-3/, 'GAP resolution must define a ≥2-3 occurrence consistency threshold');
  assert.match(step15, /do NOT brainstorm/, 'a consistent latent convention must skip the brainstorm');
  assert.match(step15, /typed deferred proposal/i, 'a consistent latent convention is recorded as a typed deferred proposal');
  assert.match(step15, /isolated precedent/i, 'a single isolated precedent must be named');
  assert.match(step15, /do not canonise automatically/i, 'an isolated precedent must not be auto-canonised');
  assert.match(step15, /no precedent/i, 'the no-precedent branch must be named');
  assert.match(step15, /genuine design gap/i, 'no precedent must be framed as a genuine design gap');
});

test('brainstorm: Step 2 is hub-aware grilling (gear 2-3), mutates no doc', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2 — Understand', '### Step 3');
  assert.match(step2, /Gear 2 and 3/, 'Step 2 grilling must be gated to gear 2 and 3');
  assert.match(step2, /resolved context's Terms/, 'Step 2 must sharpen terminology against the resolved context Terms');
  assert.match(step2, /Rule, Term, Decision, or a Work artifact\?/, 'Step 2 must name the graph node kinds');
  assert.match(step2, /graph reachability from the Project root/, 'Step 2 must probe graph reachability');
  assert.match(step2, /scenario/i, 'Step 2 must probe concrete edge-case scenarios');
  assert.match(step2, /drift/i, 'Step 2 must cross-reference code for Drift');
  assert.match(step2, /one at a time|one question/i, 'Step 2 must keep one-question-at-a-time discipline');
  assert.match(step2, /does not mutate|write nothing to the hub/i, 'Step 2 must state it mutates no hub doc');
  assert.match(step2, /Step 1\.5/, 'Step 2 must route already-durable deltas to the existing Step 1.5 channel');
  assert.match(step2, /captured in the spec/i, 'Step 2 must state speculative deltas are captured in the spec');
});

test('brainstorm: Step 4/5 carry canonical Out of Scope + Testing Decisions sections', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step4 = sectionBetween(text, '### Step 4 — Present the design (gate)', '### Step 5');
  assert.match(step4, /Out of Scope/, 'Step 4 section list must name Out of Scope');
  assert.match(step4, /Testing Decisions/, 'Step 4 section list must name Testing Decisions');
  assert.match(step4, /required at gear 3.*recommended at gear 2|required.*gear 3.*recommended.*gear 2/i, 'both sections must be required at gear 3, recommended at gear 2');
  assert.match(step4, /prior art/i, 'Testing Decisions must include prior art in the repo');
  assert.match(step4, /nothing excluded|never omitted/i, 'an empty Out of Scope must be a real statement at gear 3, never omitted');
  const step5 = sectionBetween(text, '### Step 5 — Finalize the approved draft', '### Step 5.5');
  assert.match(step5, /Out of Scope[\s\S]*Testing Decisions|Testing Decisions[\s\S]*Out of Scope/, 'Step 5 finalize checklist must cover both canonical sections');
});

test('brainstorm: Step 2 grilling has structure — design tree, facts/decisions split, explicit exit criterion', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2 — Understand', '### Step 3');
  assert.match(step2, /design tree|tree of.*decisions/i, 'Step 2 must frame open decisions as a design tree');
  assert.match(step2, /dependency order|prerequisites/i, 'Step 2 must order questions by dependency — no decision before its prerequisites');
  assert.match(step2, /facts/i, 'Step 2 must split facts from decisions');
  assert.match(step2, /never ask the user for something look-up-able|explore the codebase instead of asking/i, 'facts must be explored, not asked');
  assert.match(step2, /every branch.*visited|visited.*every branch/i, 'exit criterion must require every branch of the tree visited');
  assert.match(step2, /silently assumed/i, 'exit criterion must forbid silent assumptions');
  assert.match(step2, /shared understanding/i, 'exit criterion must require user-confirmed shared understanding');
  assert.doesNotMatch(step2, /until the idea is clear/i, 'the vague exit criterion must be replaced');
});

test('plan: valid user-invocable skill, writes plan into .formula/work/plans/', () => {
  checkSkill('plan', ['.formula/work/plans/', '.formula/work/specs/', '-agent', 'steepy-formula graph validate']);
});

test('plan: local-work contract is explicit and forbids stable registration', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  assert.match(
    text,
    /description:\s+Turn a local working spec into a step-by-step implementation plan\./,
    'plan description must describe the local working-plan contract'
  );
  assert.doesNotMatch(text, /default: the most recent dated spec file/i);
  assert.match(text, /If no\s+candidate exists, tell the user to run the `brainstorm` skill/);
  assert.match(text, /### Step 4 — Write the local working plan/);
  assert.match(text, /> Source spec: \[<topic>\]\(\.\.\/specs\/<YYYY-MM-DD-topic>\.md\)/);
  assert.match(text, /Create `\.formula\/work\/plans\/` if it does not exist\./);
  assert.match(text, /Do not create a plans sub-index\./);
  assert.match(text, /Plans are local workflow artifacts, not stable hub documentation\./);
  assert.doesNotMatch(text, /_INDEX\.md|validate-hub|testing-and-checklist|\blegacy\b/i, 'plan is graph-only: no Markdown hub, linter, or legacy branch');
});

test('chain skills: byte-identical canonical manual handoff contract', () => {
  const names = ['brainstorm', 'plan', 'implement', 'review', 'loop-engineer'];
  const blocks = names.map((name) => {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    return text.match(/<!-- steepy:manual-handoff:v1:start -->[\s\S]*?<!-- steepy:manual-handoff:v1:end -->/)?.[0];
  });
  assert.ok(blocks.every(Boolean), 'all five chain skills must carry the common manual-handoff block');
  assert.ok(blocks.every((block) => block === blocks[0]), 'the common manual-handoff block must be byte-identical');
  const block = blocks[0];
  for (const phrase of [
    'handoff: steepy-formula/v1', 'next:', 'required:', 'onDemand:', 'explicit `none`',
    'brainstorm has `required: none`, `onDemand: none`', 'plan has required `spec`',
    'Gear-2 direct implement has required `spec`',
    'fresh `loop-engineer` has',
    'duplicate keys', 'unknown keys', 'unknown roles', 'absolute paths', '`..`', 'globs',
    'never preloaded', 'Stable routing inputs stay outside',
    'active harness',
  ]) assert.ok(block.includes(phrase), `manual block must contain ${phrase}`);
  assert.match(block, /fails closed\s+without discovery/);
  assert.match(block, /Gear-3 implement → review\s+maps `criteria`, `task-results`, `branch-diff`/);
  assert.match(block, /No child inherits general\s+`\.formula\/work\/\*\*` access/);
});

test('chain skills: every declared transition emits exactly the destination accepted roles', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const block = text.match(/<!-- steepy:manual-handoff:v1:start -->([\s\S]*?)<!-- steepy:manual-handoff:v1:end -->/)?.[1];
  assert.ok(block, 'canonical manual-handoff block must exist');
  const acceptedAlternatives = new Map([
    ['plan', [['spec']]],
    ['implement', [['spec'], ['plan', 'source-spec']]],
    ['review', [
      ['branch-diff', 'criteria', 'task-results'],
      ['goal', 'loop-ledger'],
    ]],
  ]);
  const transitions = [
    ['Gear-2 brainstorm → implement', 'implement', ['spec']],
    ['brainstorm → plan', 'plan', ['spec']],
    ['plan → implement', 'implement', ['plan', 'source-spec']],
    ['Gear-3 implement → review', 'review', ['branch-diff', 'criteria', 'task-results']],
    ['loop-engineer → review', 'review', ['goal', 'loop-ledger']],
  ];
  for (const [transition, destination, emitted] of transitions) {
    const declaration = block.match(new RegExp(`${transition}\\s+maps ([^.;]+)`));
    assert.ok(declaration, `${transition} must be declared`);
    const declaredRoles = [...declaration[1].matchAll(/`([^`]+)`/g)].map((role) => role[1]).sort();
    assert.deepEqual(declaredRoles, emitted, `${transition} must emit its exact declared role set`);
    assert.ok(
      acceptedAlternatives.get(destination).some((roles) => JSON.stringify(roles) === JSON.stringify(emitted)),
      `${transition} must equal one mutually exclusive destination role alternative`
    );
  }
  assert.match(block, /regular Gear-3 `review` has required `criteria`, `task-results`, and `branch-diff`, `onDemand: none`/);
  assert.match(block, /Gear-4 `review` has required `goal` and `loop-ledger`, `onDemand: none`/);
  assert.match(block, /fresh `loop-engineer` has required `goal`, `onDemand: none`[\s\S]*resume[\s\S]*`loop-ledger` on demand/);
  assert.match(block, /mutually exclusive[\s\S]*never (?:merge|merged) or infer/i);
});

test('brainstorm and plan: versioned workflow headers and manual lifecycle are explicit', () => {
  const brainstorm = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const plan = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  assert.match(brainstorm, /phase: brainstorm[\s\S]*next: implement[^]*Gear 2[^]*next: plan[^]*Gear 3/i);
  assert.match(brainstorm, /Gear 2[^]*next: implement[^]*required:\n  spec: <exact-spec-path>[^]*onDemand: none/i);
  assert.match(brainstorm, /Gear 3[^]*next: plan[^]*required:\n  spec: <exact-spec-path>[^]*onDemand: none/i);
  assert.match(plan, /two exclusive manual entry paths/i);
  assert.match(plan, /only when no envelope or path was supplied/i);
  assert.match(plan, /immediate specs\s+directory[\s\S]*bounded `steepy-workflow` headers/i);
  assert.match(plan, /require user selection even when there is exactly one candidate/i);
  assert.match(plan, /phase: plan[\s\S]*status: DRAFT[\s\S]*next: implement[\s\S]*source: <exact-spec-path>[\s\S]*consumed-by: none/);
  assert.match(plan, /first[^]*plan to `status: READY`[^]*then[^]*spec to `status: CONSUMED`[^]*consumed-by: <plan-path>/i);
  assert.match(plan, /required:\n  plan: <plan-path>[\s\S]*onDemand:\n  source-spec: <spec-path>/);
});

test('implement: manual entry accepts the lean Gear-2 spec or exact plan provenance, with explicit resume capability', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const checklist = sectionBetween(text, '## Checklist', '## Procedure');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');

  assert.match(checklist, /Gear-2[^\n]*exact[^\n]*spec/i,
    'the checklist must name the direct Gear-2 spec capability');
  assert.match(checklist, /plan-backed[^\n]*plan[^\n]*source-spec/i,
    'the checklist must retain both plan-backed provenance capabilities');
  assert.doesNotMatch(step0, /an explicit plan path supplies the same capability/i,
    'a lone plan path must never authorize a source-spec header read');
  assert.match(step0, /direct[^]*both[^]*exact[^]*plan[^]*source-spec/i,
    'the direct form must explicitly bind both exact paths');
  assert.match(step0, /lone plan path[^]*(?:stop|reject|refuse)/i,
    'a lone plan path must fail closed before any source-spec header read');
  assert.match(step0, /source-spec header[^]*(?:only after|after)[^]*exact[^]*(?:capability|binding)/i,
    'the source-spec header read must follow acceptance of its own exact capability');
  assert.match(step0, /direct Gear-2[^]*required:\n\s+spec: <spec-path>[^]*onDemand: none/i,
    'the direct Gear-2 form must carry only the exact spec');
  assert.match(step0, /phase: brainstorm[^]*status: READY[^]*next: implement[^]*gear[^]*exactly 2/i,
    'a direct spec must be a READY brainstorm artifact routed to implement and must remain Gear 2');

  assert.doesNotMatch(step1, /read that exact ledger when present/i,
    'a derived existing ledger must not be read merely because it exists');
  assert.match(step1, /either derived artifact exists[^]*without its exact capability[^]*(?:stop|request)[^]*both resume bindings/i,
    'manual resume must stop unless both exact progress-ledger and task-results capabilities are present');
  assert.match(step1, /fresh run[^]*(?:create|initialize)[^]*ledger/i,
    'fresh-run output creation must remain allowed without historical read authority');
  // Formula adaptation (apex v1.2.0 port): apex also locks this entry rule in
  // `.apex/standards/skills.md`. That Markdown hub is archived here; the standard half rides the
  // canonical graph promotion, so only the repo-file halves are locked in this suite.
});

test('plan: manual recovery and bindings fail closed without candidate body reads', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  for (const phrase of ['exact', 'missing', 'malformed', 'wrong-state', 'wrong-role']) {
    assert.match(text, new RegExp(phrase, 'i'), `plan must state ${phrase} handling`);
  }
  assert.match(text, /headerless artifacts[\s\S]*ignored/i);
  assert.match(text, /never open or read a candidate body/i);
  assert.match(text, /After stable bootstrap orientation[\s\S]*read only the accepted spec body/i);
  assert.match(text, /never open a sibling or linked\s+work artifact/i);
});

test('plan: Step 0 accepts the exact manual spec capability before any verdict or body read', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  const manualGate = step0.search(/\*\*Manual\/no-manifest[^*]*preflight[^*]*\*\*/i);
  const verdictRead = step0.search(/read the verdict artifact/i);

  assert.ok(manualGate !== -1, 'Step 0 must contain the manual/no-manifest capability preflight');
  assert.ok(verdictRead !== -1, 'Step 0 must retain the verdict/gear read');
  assert.ok(manualGate < verdictRead, 'the manual capability preflight must precede the verdict read');

  const gate = step0.slice(manualGate, verdictRead);
  assert.match(gate, /exact `spec` capability[^.]*before any verdict or spec-body read/i,
    'manual entry must accept its exact spec capability before reading verdict or body content');
  assert.match(gate, /no envelope or path[\s\S]{0,420}bounded[\s\S]{0,120}headers[\s\S]{0,240}require user selection/i,
    'pathless recovery must remain header-only and require selection');
  assert.match(gate, /after selection[\s\S]{0,160}exact\s+binding/i,
    'recovery selection must be converted into an accepted exact binding');
  assert.match(gate, /do not read[^.]*selected[^.]*verdict[^.]*body[^.]*until[^.]*binding[^.]*accepted/i,
    'recovery must not read the selected verdict or body before accepting the binding');
});

test('plan: Step 2 documents expand–contract for wide refactors, no graph machinery', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /wide refactor/i, 'Step 2 must name the wide-refactor pattern');
  assert.match(step2, /expand\s*→\s*migrate\s*→\s*contract/i, 'Step 2 must state the expand → migrate → contract sequence');
  assert.match(step2, /beside the old/i, 'expand must add the new form beside the old');
  assert.match(step2, /batches/i, 'migration must proceed in batches sized by blast radius');
  assert.match(step2, /green between batches|suite green/i, 'the suite must stay green between batches');
  assert.match(step2, /no caller remains/i, 'contract must delete the old form when no caller remains');
  assert.match(step2, /ordinary sequential (plan\s+)?tasks/i, 'batches must be ordinary sequential tasks — no dependency-graph machinery');
  assert.match(step2, /lands green in one task.*not wide/i, 'the strict wide definition must be stated');
});

test('plan: Step 2 cuts tasks on a discovery criterion, not bite-sized alone', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.doesNotMatch(step2, /bite-sized/i, 'Step 2 must no longer name bite-sized as the task-cutting criterion');
  assert.match(step2, /\bdiscover\b/i, 'Step 2 must name discovery as the mis-cut signal');
  assert.match(step2, /stated only as a goal|only[^.]*as a goal/i, 'Step 2 must flag requirements stateable only as a goal');
  assert.match(step2, /sketch of a diff.*exact paths/i, 'Step 2 must require a diff-shaped requirement against exact paths');
  assert.match(step2, /split the task/i, 'Step 2 must offer splitting the task as a remedy');
  assert.match(step2, /discovery task/i, 'Step 2 must offer a preceding discovery task as a remedy');
  assert.match(step2, /missing facts/i, 'the discovery task deliverable must be the missing facts');
  assert.match(step2, /each ending in an independently testable deliverable/i, 'Step 2 must retain the independently testable deliverable clause');
  // M4 (final-review): the retired term must not survive outside the locked slice — the skill's own
  // purpose line is what an agent reads first.
  assert.doesNotMatch(text, /bite-sized/i, 'the retired bite-sized criterion must be gone from the whole skill, purpose line included');
});

test('plan: Step 3 binds each task to Complexity and Step 4.5 verifies it', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');
  assert.match(
    step3,
    /\*\*Complexity:\*\*\s*`mechanical\s*\|\s*integration\s*\|\s*design`/,
    'Step 3 must define a Complexity binding with exactly mechanical | integration | design'
  );
  assert.match(
    step3,
    /`implement` reads this line[\s\S]*model tier[\s\S]*reviewer/i,
    'Step 3 must state that implement reads Complexity for the model tier and the reviewer decision'
  );
  const step45 = sectionBetween(text, '### Step 4.5', '### Step 5');
  assert.match(
    step45,
    /4\.\s+\*\*Complexity present\*\*/,
    'Step 4.5 must have a checklist item #4 verifying Complexity is present'
  );
});

test('implement: valid user-invocable skill, enforces TDD against the surface test command', () => {
  checkSkill('implement', ['.formula/work/specs/', '.formula/work/plans/', 'failing test', '-agent']);
});

test('implement: hands off to review with the exact minimal review capability', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5 — Hand off', '## Model Selection');
  assert.match(step5, /Gear 3 only/i, 'the review handoff must be Gear-3 only');
  assert.match(step5, /Run the `review` skill in a new session/, 'handoff must still require a fresh session');
  assert.match(
    step5,
    /name the concrete inputs by repo-relative path/,
    'Step 5 must require the handoff message to carry the input paths'
  );
  assert.doesNotMatch(step5, /required:\n\s+plan:/, 'review must not receive the full plan');
  assert.match(step5, /required:\n\s+criteria: <criteria-path>\n\s+task-results: <task-result-index-path>\n\s+branch-diff: <branch-diff-path>\nonDemand: none/);
  assert.match(step5, /\.formula\/work\/tasks\/<plan-basename>\/task-result-index\.md/, 'handoff names the verified task-result-index path');
  assert.match(step5, /starts from those files, not from this conversation'?s memory/);
});

test('implement: manual entry supports mutually exclusive direct-spec and plan-backed forms, bounded and fail closed', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  assert.match(text, /two exclusive manual entry paths/i);
  assert.match(text, /required:\n\s+spec: <spec-path>\nonDemand: none/);
  assert.match(text, /required:\n\s+plan: <plan-path>\nonDemand:\n\s+source-spec: <spec-path>/);
  assert.match(text, /immediate specs and plans directories|immediate `?\.formula\/work\/specs\/`? and `?\.formula\/work\/plans\/`? directories/i);
  assert.match(text, /require user selection\s+even when there is exactly one candidate/i);
  assert.match(text, /explicit[\s\S]{0,100}(failure|invalid|malformed)[\s\S]{0,100}without (fallback|discovery)/i);
  assert.match(text, /optional `ledger\.md`[^]*canonical\s+`task-result-index\.md` solely from the accepted (?:spec or plan|entry artifact) basename/i);
  assert.doesNotMatch(text, /most recent dated plan/i);
  assert.match(text, /never search for a historical[^]*task directory or scan for a ledger\/index/i);
  assert.match(text, /If no candidate exists[^]*(?:brainstorm|plan)/i);
  assert.match(text, /\*\n!\.gitignore/, 'fallback .formula/work/.gitignore must be the two-line body');
  assert.doesNotMatch(text, /create it with content `\*`/, 'a bare * ignores the .gitignore itself');
});

test('implement: autopilot reads the phase manifest first while manual capabilities stay narrow', () => {
  const protocol = readFileSync(join(skillsDir, 'implement', 'autopilot-protocol.md'), 'utf8');
  assert.match(protocol, /conductor-supplied phase manifest/i);
  assert.match(protocol, /before any other task input/i);
  assert.match(protocol, /role and scope[\s\S]{0,100}implement phase/i);
  assert.match(protocol, /supplied correlation identity/i);
  assert.match(protocol, /every `required` input/i);
  assert.match(protocol, /`onDemand`[\s\S]{0,120}concrete named missing fact/i);
  assert.match(protocol, /authoritative input inventory/i);

  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step1, /Manual drive/i);
  assert.match(step1, /read the accepted plan body/i);
  assert.match(step1, /direct Gear-2[^]*read the accepted spec body/i);
  assert.match(step1, /Do not\s+preload the source spec/i);
});

test('implement: result index lifecycle and supporting metadata are interrupt safe', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  assert.match(text, /phase: implement\nstatus: DRAFT\nnext: review\nsource: <plan-path>\nconsumed-by: none\n-->\nsource-spec: <spec-path>\ncriteria: <criteria-path>\nbranch-diff: <branch-diff-path>/);
  assert.match(text, /Gear 2[^]*phase: implement\nstatus: DRAFT\nnext: none\nsource: <spec-or-plan-path>\nconsumed-by: none/i);
  assert.match(text, /(failure|interruption)[\s\S]{0,160}plan `READY`|plan remains[\s\S]{0,80}`READY`/i);
  assert.match(text, /Gear 3[^]*every task gate succeeds[^]*whole-branch review approves[^]*handoff verification[^]*first[^]*index to `status: READY`[^]*then[^]*plan to `status: CONSUMED`/i);
  assert.match(text, /Gear 2[^]*index as `status: READY`[^]*accepted spec or plan as `status: CONSUMED`/i,
    'Gear 2 must publish terminal evidence before consuming its input');
  assert.match(text, /exact resume carrying both `progress-ledger` and `task-results`[^]*perform only the\s+input-consumption write/i,
    'Gear 2 must repair only the permitted READY-index\/READY-input prefix');
  assert.match(text, /`CONSUMED` input paired\s+with a DRAFT\/mismatched index fails closed/i,
    'an impossible terminal pair must fail closed');
  assert.match(text, /source spec[\s\S]{0,220}named fact/i);
  assert.match(text, /consumer role, exact path, and concrete reason[\s\S]{0,100}ledger/i);
  assert.match(text, /canonical `Source`[\s\S]{0,120}`Heading` attribution/i);
  assert.match(text, /unmodified aggregate `git diff`/i);
});

test('implement: materializes a self-contained Task 7 brief verbatim', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');
  for (const field of [
    'Requirements and deliverables',
    'Relevant global constraints',
    'Surface',
    'Specialist agent',
    'Exact paths',
    'Test command',
    'Dependencies',
    'Complexity',
    'Success criteria',
  ]) {
    assert.match(step3, new RegExp(field, 'i'), `task brief must materialize ${field}`);
  }
  assert.match(step3, /verbatim/i, 'brief values must be copied verbatim from the approved plan');
  assert.match(step3, /direct Gear-2[^]*single[^]*Task 1[^]*accepted spec/i,
    'direct Gear-2 implementation must derive one self-contained task from the accepted spec');
  assert.match(step3, /cannot[^]*one independently testable task[^]*(?:offer|use|run)[^]*plan/i,
    'a direct spec that needs decomposition must stop before mutation and offer the optional plan');
  assert.match(step3, /implementer contract/i, 'the task brief must be the complete implementer contract');
  assert.match(step3, /no chat|conversation history/i, 'the brief must not depend on conversation context');
});

test('Gear 2 terminates in implement after surface tests and graph validate, without plan or review', () => {
  const brainstorm = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const implement = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const brainstormHandoff = sectionBetween(brainstorm, '### Step 8 — Hand off', '## Model Selection');
  const implementStep5 = sectionBetween(implement, '### Step 5 — Hand off', '## Model Selection');

  assert.match(brainstormHandoff, /Gear 2[^]*direct[^]*`implement` skill/i);
  assert.match(brainstormHandoff, /required:\n\s+spec: <exact-spec-path>\nonDemand: none/);
  assert.match(brainstormHandoff, /Do not route Gear 2 through[^]*`plan` unless[^]*explicitly requested/i);
  assert.match(implementStep5, /Gear 2[^]*surface test[^]*graph validate[^]*status: READY[^]*next: none[^]*status: CONSUMED/i);
  assert.match(implementStep5, /Gear 2[^]*(?:do not|does not|never)[^]*(?:invoke|hand off|handoff)[^]*review/i);
});

test('implement: SKILL is graph-only — graph validate gate, migrate stop, resolved-context standards', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /\blegacy\b|validate-hub|_INDEX\.md|testing-and-checklist|Markdown hub file/i, 'no legacy branch or validate-hub gate');
  const gear2 = sectionBetween(text, '- **Gear 2**', '- **Gear 3**');
  assert.match(gear2, /`steepy-formula graph validate`/);
  const step5 = sectionBetween(text, '### Step 5 — Hand off', '## Model Selection');
  assert.match(step5, /`steepy-formula graph validate`/);
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');
  assert.match(step3, /the owning standard is the resolved context's Rules/);
  assert.doesNotMatch(step3, /declares no mode|declared mode's values/i);
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.match(step4, /\[STANDARD_FILES\]` slot with the resolved context's Rules/);
  assert.match(text, /Stop and tell the user to run the `graph-migrate` skill \(invoke it the way your harness invokes skills\) before any other workflow\./);
});

test('implement: autopilot creates every task-role manifest with strict CLI args and deterministic paths before dispatch', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'autopilot-protocol.md'), 'utf8');
  assert.match(text, /node <engine-root>\/scripts\/autopilot-context\.mjs/);
  for (const role of ['implementer', 'task-reviewer', 'fix', 'final-review']) {
    assert.match(text, new RegExp(`--role ${role}\\b`), `must invoke the context CLI for ${role}`);
  }
  for (const path of [
    'task-N-implement.json',
    'task-N-review-<iteration>.json',
    'task-N-fix-<iteration>.json',
    'final-review-<iteration>.json',
  ]) {
    assert.ok(text.includes(path), `must define deterministic manifest path ${path}`);
  }
  assert.match(text, /missing or invalid manifest[\s\S]{0,180}correlated `BLOCKED`/i);
  assert.match(text, /no (child )?dispatch/i);
  assert.match(text, /--brief[\s\S]*--standard[\s\S]*--artifact-output/,
    'role commands must use named paths and declare authoritative artifact outputs');
});

test('implement: role inventories are exact and never eagerly pass upstream bodies', () => {
  const skill = readFileSync(join(skillsDir, 'implement', 'autopilot-protocol.md'), 'utf8');
  const implementer = readFileSync(join(skillsDir, 'implement', 'implementer-prompt.md'), 'utf8');
  const reviewer = readFileSync(join(skillsDir, 'implement', 'task-reviewer-prompt.md'), 'utf8');
  const finalReviewer = readFileSync(join(skillsDir, 'implement', 'final-review-prompt.md'), 'utf8');

  assert.match(implementer, /required` inventory is exactly the task brief and (?:exact )?selected owning (?:surface )?standards/i);
  assert.match(reviewer, /required` inventory is exactly the task brief, implementer report, task diff, and (?:exact )?selected owning (?:surface )?standards/i);
  assert.match(reviewer, /ownership map[\s\S]{0,120}`onDemand`[\s\S]{0,160}named suspected ownership conflict/i);
  assert.doesNotMatch(`${skill}\n${implementer}\n${reviewer}\n${finalReviewer}`, /\blegacy\b|validate-hub|_INDEX\.md|routing table|mini-routing|modular (?:core|leaf)/i,
    'implement autopilot protocol and prompts are graph-only');
  assert.match(finalReviewer, /required` inventory is exactly the success-criteria source, task-result index, aggregate branch diff, and relevant standards/i);
  assert.match(skill, /Fix `required` inventory is exactly the task brief, authoritative reviewer issue artifact, current task diff, and exact selected owning standards/i);
  assert.match(skill, /Never eagerly pass[\s\S]{0,180}(full spec|spec body)[\s\S]{0,180}(full plan|plan body)[\s\S]{0,180}(hub index|ownership map)[\s\S]{0,180}transcript/i);
  assert.match(implementer, /efficiency protocol[\s\S]{0,180}not[\s\S]{0,80}(access control|sandbox)/i);
  assert.match(implementer, /repository (source|code) files[\s\S]{0,180}(inspect|read)[\s\S]{0,180}(implement|test|verify)/i);
  assert.match(implementer, /`onDemand`[\s\S]{0,180}upstream context[\s\S]{0,180}concrete[\s\S]{0,120}(reason|missing fact)/i);
  assert.doesNotMatch(implementer, /Do not read[\s\S]{0,160}other undeclared file/i);
});

test('implement: skill defines the conductor result-index grammar and canonical branch diff name exactly', () => {
  const skill = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const canonical = '- Task <id>: <DONE|DONE_WITH_CONCERNS>; artifact: <sanitized repo-relative path>; changed-paths: <comma list or none>; signals: <short machine-readable IDs or none>';
  assert.ok(skill.includes(canonical), 'skill must define the exact task-result-index bullet grammar');
  assert.match(skill, /task-result-index\.md[\s\S]{0,240}exact bullet grammar/i);
  assert.doesNotMatch(skill, /branch\.diff\b/);
  assert.ok(skill.includes('.formula/work/tasks/<plan-basename>/branch-diff.txt'));
});

test('implement: final review consumes a deterministic criteria-only artifact, never the full spec', () => {
  const skill = readFileSync(join(skillsDir, 'implement', 'autopilot-protocol.md'), 'utf8');
  const finalReviewer = readFileSync(join(skillsDir, 'implement', 'final-review-prompt.md'), 'utf8');
  const finalCommand = skill.split('\n').find((line) => line.includes('--role final-review')) ?? '';

  assert.ok(
    finalCommand.includes('--criteria .formula/work/tasks/<plan-basename>/success-criteria.md'),
    'final-review CLI must require the deterministic task-local criteria-only artifact'
  );
  assert.doesNotMatch(
    finalCommand,
    /--criteria \.formula\/work\/specs\//,
    'the full source spec must never be a final-review required input'
  );
  assert.match(skill, /materialize[\s\S]{0,180}`success-criteria\.md`/i);
  assert.match(skill, /canonical source attribution[\s\S]{0,180}spec path[\s\S]{0,180}heading/i);
  assert.match(skill, /verbatim[\s\S]{0,180}success.criteria[\s\S]{0,180}no unrelated spec sections/i);
  assert.match(finalReviewer, /criteria-only artifact/i);
  assert.match(finalReviewer, /never[\s\S]{0,120}full (source )?spec/i);
  assert.match(finalReviewer, /no unrelated spec sections/i);
});

test('implement: durable artifacts and exact four-field child envelopes keep detail off the parent context', () => {
  const files = ['SKILL.md', 'implementer-prompt.md', 'task-reviewer-prompt.md', 'final-review-prompt.md'];
  const texts = files.map((file) => readFileSync(join(skillsDir, 'implement', file), 'utf8'));
  const envelope = [
    'status: <enum>',
    'artifact: <sanitized repo-relative path>',
    'changed-paths: <comma list or none>',
    'signals: <short machine-readable IDs or none>',
  ].join('\n');
  for (const [index, text] of texts.entries()) {
    assert.ok(text.includes(index >= 2 ? envelope.replace('changed-paths: <comma list or none>', 'changed-paths: none') : envelope), `${files[index]} must carry the exact four-field envelope`);
    assert.match(text, /exactly four fields/i, `${files[index]} must prohibit extra response fields`);
    assert.match(text, /no headings|headings/i, `${files[index]} must prohibit response headings`);
    assert.match(text, /no .*commits.*tests.*prose concern details.*diff.*report.*test transcript/is,
      `${files[index]} must keep verbose payloads out of the envelope`);
  }

  const skill = texts[0];
  for (const artifact of ['task-N-report.md', 'task-N-review.md', 'task-N-issues.md', 'final-review.md', 'final-review-issues.md']) {
    assert.ok(skill.includes(artifact), `controller must define authoritative artifact ${artifact}`);
  }
  assert.match(skill, /validate[\s\S]{0,180}four-field shape[\s\S]{0,180}status[\s\S]{0,180}sanitized repo-relative[\s\S]{0,180}signals/i);
  assert.match(skill, /malformed envelope[\s\S]{0,180}(BLOCKED|degradation)/i,
    'a malformed child envelope names its BLOCKED or degradation handling');
  assert.match(skill, /opens? the artifact only when[\s\S]{0,160}(next decision|action status)/i);
  assert.match(skill, /ledger[\s\S]{0,100}task-result index[\s\S]{0,180}compact outcome[\s\S]{0,100}artifact reference/i);
});

test('artifact-first child contracts share ordered fields while status domains and placeholders stay role-specific', () => {
  const emitters = [
    ['implement/SKILL.md', 'controller'],
    ['implement/implementer-prompt.md', 'implementer'],
    ['implement/task-reviewer-prompt.md', 'reviewer'],
    ['implement/final-review-prompt.md', 'reviewer'],
  ];
  const orderedFields = ['status', 'artifact', 'changed-paths', 'signals'];

  for (const [relativePath, role] of emitters) {
    const text = readFileSync(join(skillsDir, relativePath), 'utf8');
    const envelope = text.match(/^[ \t]*status: <[^\n]+>\n[ \t]*artifact: <[^\n]+>\n[ \t]*changed-paths: (?:<[^\n]+>|none)\n[ \t]*signals: <[^\n]+>$/m)?.[0];
    assert.ok(envelope, `${relativePath} must emit the four-field ${role} result contract`);
    assert.deepEqual(
      envelope.split('\n').map((line) => line.trimStart().slice(0, line.trimStart().indexOf(':'))),
      orderedFields,
      `${relativePath} must preserve the canonical ordered field names`
    );
  }

  // Formula adaptation (apex v1.2.0 port): apex also locks the ordered shape and role-specific
  // status domains in `.apex/standards/skills.md`. That Markdown hub is archived here; the standard
  // half rides the canonical graph promotion, so only the repo-file halves are locked below.

  const implementSkill = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const implementer = readFileSync(join(skillsDir, 'implement', 'implementer-prompt.md'), 'utf8');
  const taskReviewer = readFileSync(join(skillsDir, 'implement', 'task-reviewer-prompt.md'), 'utf8');
  const finalReviewer = readFileSync(join(skillsDir, 'implement', 'final-review-prompt.md'), 'utf8');
  assert.match(implementSkill, /Implementer\/fix statuses are `DONE`,\s*\n`DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`/);
  assert.match(implementSkill, /reviewer statuses are `APPROVED`, `ISSUES_FOUND`,\s*\n`NEEDS_CONTEXT`, or `BLOCKED`/);
  assert.match(implementer, /DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT/);
  for (const [relativePath, text] of [
    ['implement/task-reviewer-prompt.md', taskReviewer],
    ['implement/final-review-prompt.md', finalReviewer],
  ]) {
    assert.match(text, /APPROVED \| ISSUES_FOUND \| BLOCKED \| NEEDS_CONTEXT/,
      `${relativePath} must preserve the reviewer-only status domain`);
  }
});

test('implement: multi-task parent state contains envelopes only while durable artifacts feed the next role', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const proof = sectionBetween(text, '### Multi-task artifact-flow proof', '### Step 4');
  assert.match(proof, /Task 1[\s\S]*Task 2/i);
  assert.match(proof, /parent[\s\S]{0,120}(only|solely)[\s\S]{0,120}four-field envelopes/i);
  assert.match(proof, /task-N-report\.md[\s\S]{0,180}task reviewer/i);
  assert.match(proof, /task-N-issues\.md[\s\S]{0,180}fix/i);
  assert.match(proof, /task-result-index\.md[\s\S]{0,180}final reviewer/i);
  assert.match(proof, /no (artifact )?bod(y|ies)[\s\S]{0,120}parent/i);
});

test('review: valid user-invocable skill, verifies bounded work artifacts and stable docs', () => {
  checkSkill('review', ['task-results', 'branch-diff', 'steepy-formula graph validate']);
});

test('review: verifies bounded local work artifacts and promotion of durable knowledge', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  assert.match(text, /manual[^]*criteria[^]*task-result[^]*diff/i);
  assert.match(text, /Eagerly read exactly the accepted `criteria`, `task-results`, and\n`branch-diff` artifacts/);
  assert.doesNotMatch(text, /_INDEX\.md|testing-and-checklist\.md/, 'review orients from the graph alone');
  assert.match(text, /If the work changed a durable convention, standard, domain term, architecture decision, user-facing workflow, or README behavior, verify that the durable knowledge was promoted into stable versioned docs/);
  assert.match(text, /Specs and plans themselves are not sufficient evidence of durable documentation\./);
  assert.match(text, /any invariant violation or broken replay is incomplete work/);
});

test('review: Step 2 sweeps only bounded criteria and compact index insights', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  const manifestSweep = sectionBetween(step2, '- **Manifest-backed autopilot:**', '- **Manual/no-manifest:**');
  const manualSweep = sectionBetween(step2, '- **Manual/no-manifest:**', 'A recorded **discovery** occurrence');
  const discoverySweep = sectionBetween(step2, 'A recorded **discovery** occurrence', 'For each candidate:');
  assert.match(step2, /Insight sweep/, 'Step 2 must contain an active insight sweep');
  assert.match(manifestSweep, /criteria-only artifact[^.]*task-result index/i,
    'manifest review must derive insight evidence from its criteria/index inventory');
  assert.match(manifestSweep, /`signals`[^.]*`DONE_WITH_CONCERNS`|`DONE_WITH_CONCERNS`[^.]*`signals`/i,
    'manifest review must use compact concern status and signals');
  assert.match(manualSweep, /accepted criteria artifact[^.]*accepted task-result index/i,
    'manual review must derive insight evidence from its accepted criteria/index inventory');
  assert.match(manualSweep, /`DONE_WITH_CONCERNS`[^.]*`signals`|`signals`[^.]*`DONE_WITH_CONCERNS`/i,
    'manual review must use compact concern status and signals');
  assert.match(discoverySweep, /both regular-review branches[^.]*accepted task-result index/i,
    'both regular-review branches must derive discovery evidence from the accepted compact index');
  assert.doesNotMatch(
    step2,
    /(?:read|reading|open|consult|inspect|locate)[^.\n]{0,120}(?:the )?per-task (?:files?|reports?|reviews?)/i,
    'regular review must never direct a per-task-file read'
  );
  assert.match(text, /Sweep unpromoted insights/, 'the checklist must carry the insight sweep');
});

test('review: Step 2 insight sweep reports a recorded discovery occurrence as a rebuttal to the plan task-cutting criterion', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /discovery[\s\S]{0,200}rebuttal[\s\S]{0,120}task-cutting criterion/i,
    'the sweep must report a recorded discovery occurrence as a rebuttal to the plan task-cutting criterion');
  assert.match(step2, /distinct from other\s+concerns/i,
    'the discovery occurrence must be reported distinct from other concerns');
  assert.match(step2, /No richer source\s+or per-task file read is authorized by a concern/i,
    'the manifest-backed branch must stay on its already-declared inventory, no new source');
});

test('review: Step 5 resolves a version bump (or no-release label) before offering the PR', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5', '## Model Selection');
  assert.match(step5, /bump-version\.mjs/, 'Step 5 must run bump-version.mjs before opening the PR');
  assert.match(step5, /CHANGELOG\.md/, 'Step 5 must add a CHANGELOG.md section for the bump');
  assert.match(step5, /no-release/, 'Step 5 must document the no-release label escape hatch');
  assert.match(step5, /version-gate\.yml/, 'Step 5 must scope-gate the bump on the target repo owning version-gate.yml');
});

test('review: Step 5 applies the scenario directly on the human\'s explicit yes, never in autopilot', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5', '## Model Selection').replace(/\s+/g, ' ');
  assert.match(step5, /steepy-formula promotion apply <scenario-id> --yes \[--approver <name>\]/,
    'Step 5 applies the scenario directly on the human gate');
  assert.match(step5, /pass `--yes` only after the human's explicit yes, only for the scenario id whose preview the human saw, never on silence/,
    '--yes is passed only after the human\'s explicit yes, for the previewed scenario');
  assert.match(step5, /never a `--yes` supplied by a conductor or in autopilot/,
    'autopilot and conductors never supply --yes');
});

test('review: gains an autopilot branch — Step 0 BLOCKED note, Autopilot paragraph stops before bump/PR at READY_FOR_PR', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');

  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /drive:\s*autopilot/i, 'Step 0 must mention drive: autopilot');
  assert.match(step0, / — review — BLOCKED — /, 'Step 0 must describe appending " — review — BLOCKED — " to the status file');
  assert.match(step0, /autopilot-status\.md/, 'Step 0 must reference autopilot-status.md');
  assert.match(step0, /CONFLICT/, 'Step 0 must call out a discovered CONFLICT as always a halt');

  // the existing Step 5 bump/PR lock must stay green — the Autopilot paragraph must not
  // weaken or remove any of its required substrings
  const step5 = sectionBetween(text, '### Step 5', '## Model Selection');
  assert.match(step5, /bump-version\.mjs/);
  assert.match(step5, /CHANGELOG\.md/);
  assert.match(step5, /no-release/);
  assert.match(step5, /version-gate\.yml/);

  const autopilotSection = sectionBetween(text, '### Step 4', '## Model Selection');
  assert.match(autopilotSection, /\*\*Autopilot:\*\*/, 'Step 4/5 must carry an Autopilot paragraph');
  assert.match(autopilotSection, /drive:\s*autopilot/i, 'Autopilot paragraph must mention drive: autopilot');
  assert.match(autopilotSection, / — review — READY_FOR_PR — /, 'Autopilot paragraph must describe appending " — review — READY_FOR_PR — " to the status file');
  assert.match(autopilotSection, /autopilot-status\.md/, 'Autopilot paragraph must reference autopilot-status.md');
  assert.match(autopilotSection, /no version bump|no bump/i, 'Autopilot paragraph must state the run stops before any version bump');
});

// Task 16 retired the legacy bootstrap template; the graph variant remains shipped
// (graph-migrate regenerates from it). Task 18 (apex v0.9.4): init generates its
// portable scaffold through project-scaffold.mjs, whose bootstrap template is the
// canonical thin router below.
const bootstrapTemplates = ['bootstrap-skill-graph.md'];

test('bootstrap template includes the workflow-chain router step', () => {
  for (const file of bootstrapTemplates) {
    const tpl = readFileSync(join(here, '..', 'templates', file), 'utf8');
    assert.ok(tpl.includes(namespacedCommand('brainstorm')),
      `${file}: router should mention the namespaced brainstorm entry point`);
    assert.ok(tpl.includes(namespacedCommand('plan')), `${file}: must mention plan`);
    assert.ok(tpl.includes(namespacedCommand('implement')), `${file}: must mention implement`);
    assert.ok(tpl.includes(namespacedCommand('review')), `${file}: must mention review`);
    assert.match(tpl, /\.formula\/work\/specs\//, `${file}: router should detect local spec presence`);
    assert.match(tpl, /\.formula\/work\/plans\//, `${file}: router should detect local plan presence`);
    assertNoBareWorkflowInvocations(tpl, `templates/${file}`);
  }
  const graphTpl = readFileSync(join(here, '..', 'templates', 'bootstrap-skill-graph.md'), 'utf8');
  assert.doesNotMatch(graphTpl, /_INDEX\.md/,
    'the graph bootstrap template must not reference the markdown hub');
});

test('bootstrap template includes the coverage-verdict and gear-selection steps', () => {
  for (const file of bootstrapTemplates) {
    const tpl = readFileSync(join(here, '..', 'templates', file), 'utf8');
    assert.match(tpl, /Step 2\.5 — Coverage verdict/, `${file}: must add Step 2.5 for the coverage verdict`);
    for (const verdict of ['COVERED', 'CONFLICT', 'GAP']) {
      assert.ok(tpl.includes(verdict), `${file}: coverage verdict step must define the ${verdict} verdict`);
    }
    assert.match(tpl, /`file:line`/, `${file}: COVERED/CONFLICT verdicts must require a file:line citation`);
    assert.match(tpl, /Step 2\.6 — Gear selection/, `${file}: must add Step 2.6 for gear selection`);
    assert.match(tpl, /Gear 1|\| 1 \|/, `${file}: gear step must define Gear 1`);
    assert.match(tpl, /Gear 2|\| 2 \|/, `${file}: gear step must define Gear 2`);
    assert.match(tpl, /Gear 3|\| 3 \|/, `${file}: gear step must define Gear 3`);
    assert.match(tpl, /\| 4 \|/, `${file}: gear step must define Gear 4`);
    assert.ok(tpl.includes(namespacedCommand('loop-engineer')),
      `${file}: gear 4 must cite the namespaced loop-engineer invocation`);
    assert.match(tpl, /ask the user for\s+one confirmation before starting the ceremony/i,
      `${file}: Step 2.6 must declare the gear and ask for one confirmation before the ceremony starts`);
    assert.match(tpl, /force|override/i, `${file}: Step 2.6 must let the user force a different gear, recorded as an override`);
    assert.match(tpl, /goal contract/i, `${file}: Step 2.6 must interview the user on the goal contract fields on gear-4 confirmation`);
    assert.match(tpl, /\.formula\/work\/loops\//, `${file}: Step 2.6 must write the goal contract under .formula/work/loops/`);
    assert.match(tpl, /verdict artifact/i, `${file}: gear step must describe the verdict artifact`);
    assert.match(tpl, /\.formula\/work\//, `${file}: verdict artifact must be recorded under .formula/work/`);
    assert.match(tpl, /confirmed, not re-asked/,
      `${file}: Step 2.6 gear-4 branch must state that fields already present are confirmed, not re-asked`);
    assert.match(tpl, /only missing fields/,
      `${file}: Step 2.6 gear-4 branch must state that only missing fields are interviewed`);
    assert.match(tpl, /(invoked inline|chained inline)[^.]*loop-engineer/i,
      `${file}: Step 2.6 gear-4 branch must note it may be invoked/chained inline by loop-engineer`);
  }
});

test('bootstrap template Step 3 loads the Surface core plus only the Components matching the task', () => {
  for (const file of bootstrapTemplates) {
    const tpl = readFileSync(join(here, '..', 'templates', file), 'utf8');
    assert.match(tpl, /zero match|core only/i, `${file}: Step 3 must state that zero matches falls back to the core only`);
    assert.match(
      tpl.replace(/\s+/g, ' '),
      /the resolve already did the sub-area scoping/,
      `${file}: Step 3 must credit the resolve with the sub-area scoping`
    );
  }
});

// Both bootstraps (the planner-rendered router and graph-migrate's graph template)
// carry the migrate and none stops, so the migration hint reaches users at the start
// of a task.
test('both bootstraps stop on migrate and none with the graph-migrate and init skills', () => {
  const router = renderProjectArtifact('project-bootstrap', normalizeProjectModel({
    projectName: 'demo-project',
    description: 'A portable demo project.',
    devCommands: ['npm test'],
    surfaces: [{ name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'npm test' }],
    resolutions: {},
    hubMode: 'graph',
  }));
  const graphTemplate = readFileSync(join(here, '..', 'templates', 'bootstrap-skill-graph.md'), 'utf8');
  for (const [label, text] of [['project-bootstrap', router], ['bootstrap-skill-graph.md', graphTemplate]]) {
    const flat = text.replace(/\s+/g, ' ');
    assert.ok(flat.includes('run the `graph-migrate` skill'), `${label}: the migrate stop names the graph-migrate skill`);
    assert.ok(flat.includes('run the `init` skill'), `${label}: the none stop names the init skill`);
    assert.match(flat, /If it reports `migrate`, stop and tell the user to run the `graph-migrate` skill;/,
      `${label}: migrate stops the task`);
    assert.match(flat, /if it reports `none`, stop and tell the user to run the `init` skill\./,
      `${label}: none stops the task`);
  }
});

// Task 18 (apex v0.9.4): the canonical planner bootstrap is a thin AGENTS.md +
// orientation + ownership + semantic-routing skill. Formula's template is
// mode-aware — the per-mode navigation rides the {{orientation}} placeholder
// filled by project-scaffold.mjs (graph: hub-mode + context resolve).
test('canonical bootstrap routes root and orientation context to ownership and semantic workflow skills', () => {
  const tpl = readFileSync(join(here, '..', 'templates', 'project-bootstrap-skill.md'), 'utf8');
  assert.match(tpl, /Read `AGENTS\.md` in full/u, 'router should read the harness-neutral root spine');
  assert.match(tpl, /\{\{orientation\}\}/, 'the mode-aware orientation placeholder carries the per-mode navigation');
  assert.match(tpl, /owning surface and specialist agent/, 'router should name ownership before changes');
  assert.match(tpl, /semantic skill name/i, 'router should invoke workflow skills by their semantic names');
  assert.match(tpl, /test command and `steepy-formula graph validate`/, 'router should run validation before completion');
  assertNoBareWorkflowInvocations(tpl, 'templates/project-bootstrap-skill.md');
});

test('thin Claude stub and canonical bootstrap stay routing-only; workflow skills never depend on a bootstrap ceremony branch', () => {
  const tpl = readFileSync(join(here, '..', 'templates', 'project-bootstrap-skill.md'), 'utf8');
  const stub = readFileSync(join(here, '..', 'templates', 'claude-bootstrap-stub.md'), 'utf8');
  const loopEngineer = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  assert.match(tpl, /steepy:generated:[^\n]+:v1/, 'bootstrap must carry the permanent v1 generation marker');
  assert.match(tpl, /name: \{\{projectName\}\}-bootstrap/, 'bootstrap name must use the project placeholder');
  assert.match(tpl, /user-invocable: true/, 'bootstrap must remain user-invocable');
  assert.match(tpl, /Read `AGENTS\.md` in full/, 'bootstrap must load root instructions');
  assert.match(tpl, /owning surface and specialist agent/u, 'bootstrap must name routed ownership');
  assert.match(tpl, /semantic skill name/u, 'bootstrap must route workflows semantically');
  assert.doesNotMatch(tpl, /coverage verdict|gear selection|ratification|git branch|workflow state/iu,
    'canonical bootstrap must not regain the retired ceremony procedure');
  assert.match(stub, /Read `\.agents\/skills\/\{\{projectName\}\}-bootstrap\/SKILL\.md` in full/u);
  assert.doesNotMatch(stub, /\.apex\/_INDEX|## Procedure|coverage verdict|gear/iu,
    'Claude must remain a thin delegation stub');
  assert.doesNotMatch(loopEngineer,
    /auto-chain[^\n]*bootstrap|bootstrap[^\n]*(?:sole author|ratification signature|writes\/completes `goal\.md`)/iu,
    'workflow skills must not depend on a deleted bootstrap ceremony branch');
});

function reviewerBody(name, file) {
  const path = join(skillsDir, name, file);
  assert.ok(existsSync(path), `${name}/${file} should exist`);
  const text = readFileSync(path, 'utf8');
  for (const marker of ['Status', 'Approved', 'Issues Found']) {
    assert.ok(text.includes(marker), `${name}/${file} must define output marker '${marker}'`);
  }
  assert.match(text, /STANDARD_(?:FILES?|INPUTS)/, `${name}/${file} must reference the surface standard`);
  assert.match(text, /Completeness/, `${name}/${file} must check Completeness`);
  assert.match(text, /Calibration/i, `${name}/${file} must include a Calibration section`);
  return text;
}

function wiredAfterValidate(name, promptFile) {
  const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
  assert.ok(text.includes(promptFile), `${name} SKILL must cite ${promptFile}`);
  const vIdx = text.indexOf('validate-hub.mjs');
  const rIdx = text.indexOf(promptFile);
  assert.ok(vIdx !== -1, `${name} SKILL must still run validate-hub`);
  assert.ok(rIdx > vIdx, `${name} reviewer dispatch must come after validate-hub`);
  return text;
}

test('brainstorm: gear-3 spec gate is a human review, not a subagent', () => {
  const dir = join(skillsDir, 'brainstorm');
  assert.ok(!existsSync(join(dir, 'spec-reviewer-prompt.md')),
    'the spec-reviewer subagent prompt must be retired');
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /spec-reviewer-prompt\.md/, 'brainstorm must not dispatch a spec-reviewer subagent');
  const step7 = sectionBetween(text, '### Step 7', '### Step 8');
  assert.match(step7, /Gear 3 only/i, 'the spec human gate is gear-3 only');
  assert.match(step7, /human/i, 'Step 7 must be a human review gate');
  assert.match(step7, /review it|review the (written )?spec/i, 'Step 7 must ask the user to review the written spec');
  assert.doesNotMatch(step7, /Dispatch a fresh/i, 'Step 7 must not dispatch a subagent reviewer');
});

test('brainstorm: Step 7 offers the drive-mode choice — manual default, autopilot launches the conductor', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step7 = sectionBetween(text, '### Step 7', '### Step 8');
  assert.match(step7, /#### Drive mode \(gear 3, on approval\)/, 'Step 7 must carry a Drive mode subsection');
  assert.match(step7, /drive `manual` or\s*\n?\s*`autopilot`/i, 'Step 7 must ask the drive-mode question');
  assert.match(step7, /`manual`\*\*? \(default\)/i, 'manual must be named as the default');
  assert.match(step7, /proceed to Step 8/i, 'manual must proceed to Step 8');
  assert.match(step7, /canonical envelope/i, 'manual must emit the canonical envelope');
  assert.match(step7, /adapters\/headless\.mjs/, 'Step 7 must cite the headless adapter map');
  assert.match(step7, /no headless (one-shot )?mode/i, 'Step 7 must name the no-headless-mode degradation');
  assert.match(step7, /do not offer autopilot/i, 'a harness with no headless mode must not be offered autopilot');
  assert.match(step7, /branch name \(suggest/i, 'autopilot must anticipate the branch-name decision');
  assert.match(step7, /commit authorization \(per-task commits\)/i, 'autopilot must anticipate the commit-auth decision');
  assert.match(step7, /Create the branch/, 'autopilot must create the branch');
  assert.match(step7, /harness`? = the current harness/i, 'the contract harness field must be the current harness');
  assert.doesNotMatch(step7, /^\s*budget:/m, 'new gear-3 autopilot contracts must not author a budget field');
  assert.match(step7, /`budget` field is rejected on fresh and resumed gear-3 contracts/i);
  assert.match(step7, /do not author it/i);
  assert.match(step7, /commit-auth: per-task/, 'the contract must fill commit-auth: per-task');
  assert.match(step7, /blast-radius: branch-only, no-push, stop-before-PR/, 'the contract must fill the blast-radius value');
  assert.match(step7, /launch the conductor in background/i, 'Step 7 must describe the launch as launching the conductor in background');
  assert.match(step7, /node <engine-root>\/scripts\/autopilot\.mjs <spec-path>/, 'Step 7 must launch autopilot.mjs on the spec path');
  assert.match(step7, /\.formula\/work\/tasks\/<spec-basename>\/autopilot-status\.md/, 'Step 7 must report the status file path');
  assert.match(step7, /phase-<n>\.log/, 'Step 7 must report the phase log path');
  assert.match(step7, /READY_FOR_PR/, 'Step 7 must name the READY_FOR_PR halt state');
  assert.match(step7, /version-bump\/PR decision \(review Step 5\) stays human/i, 'Step 7 must state the version-bump/PR decision stays human');
  assert.match(step7, /interactive session/i, 'Step 7 must state the version-bump/PR decision runs in an interactive session');
  assert.match(step7, /no new question is asked at gears 1-2/i, 'the manual path must state no new question at gears 1-2');
  assert.match(step7, /answering `manual` changes nothing downstream/i, 'the manual path must state manual changes nothing downstream');
  assert.doesNotMatch(step7, /dispatch a fresh/i, 'Step 7 must not use the forbidden phrase "dispatch a fresh"');
});

test('brainstorm: autopilot contracts default to safe logs, disclose exact capture, and hand off live artifacts without changing manual drive', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step7 = sectionBetween(text, '### Step 7', '### Step 8');
  assert.match(step7, /log-mode:\s*safe/i, 'gear-3 autopilot contracts must write log-mode: safe by default');
  assert.match(step7, /explicitly requests? sensitive exact capture/i, 'exact logging must require an explicit sensitive-capture request');
  assert.match(step7, /exact raw logs may contain secrets/i, 'exact logging must warn that raw logs may contain secrets');
  assert.match(step7, /EXACT_LOGGING/, 'exact logging must emit or record EXACT_LOGGING');
  assert.match(step7, /phase-<n>-attempt-<m>\.log/, 'launch handoff must name each readable attempt log');
  assert.match(step7, /phase-<n>-attempt-<m>\.raw\.jsonl/, 'launch handoff must name each raw attempt log');
  assert.match(step7, /aggregate `?phase-<n>\.log`?/i, 'launch handoff must name the aggregate phase log');
  assert.match(step7, /native open\/resume reference when supported/i, 'launch handoff must report native open/resume references when available');
  assert.match(step7, /no-steer/i, 'autopilot handoff must make the no-steer rule explicit');
  assert.match(step7, /stop-before-PR/i, 'autopilot handoff must make the stop-before-PR boundary explicit');
  assert.match(step7, /`manual`\*\*? \(default\)/i, 'manual drive must remain the default');
  assert.match(step7, /no new question is asked at gears 1-2/i, 'new logging behavior must not add a manual or lower-gear question');
});

test('brainstorm: finalized specs carry one allowed Feature complexity and the human gate validates it', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5', '### Step 5.5');
  assert.match(
    step5,
    /exactly one `Feature complexity: mechanical \| integration \| design`/,
    'the finalized spec format must require exactly one Feature complexity field'
  );
  const step55 = sectionBetween(text, '### Step 5.5', '### Write-back routing');
  assert.match(step55, /Feature complexity/i, 'self-review must inspect Feature complexity');
  assert.match(step55, /mechanical \| integration \| design/, 'self-review must enforce the allowed complexity vocabulary');
  const step7 = sectionBetween(text, '### Step 7', '### Step 8');
  assert.match(step7, /Feature complexity/i, 'the human gate must validate Feature complexity before handoff');
  assert.doesNotMatch(step7, /resource[- ]profile|resource profile/i, 'budget removal must not add a replacement resource-profile question');
});

test('brainstorm: gear-2 specs carry the same machine contract as gear-3 specs', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5', '### Step 5.5');
  assert.doesNotMatch(step5, /every new gear-3 spec/i, 'Step 5 must not scope the machine contract to gear 3: direct Gear-2 implement consumes it');
  assert.match(step5, /every new gear-2 and gear-3 spec/i, 'Step 5 must apply the machine contract to gear-2 specs');
  const contract = step5.slice(step5.indexOf('every new gear-2 and gear-3 spec'), step5.indexOf('Do not place cross-cutting'));
  assert.match(contract, /`- \*\*Feature complexity:\*\*/, 'Feature complexity must sit in the machine-contract list, not after it');
  const ceremony = sectionBetween(text, '### Ceremony by gear', '### Step 1 ');
  assert.match(ceremony, /light spec that still carries the\s+Step 5 machine contract/i, 'the gear-2 light spec must still carry the Step 5 machine contract');
});

test('plan: gear-3 plan gate is a human review, not a subagent', () => {
  const dir = join(skillsDir, 'plan');
  assert.ok(!existsSync(join(dir, 'plan-reviewer-prompt.md')),
    'the plan-reviewer subagent prompt must be retired');
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /plan-reviewer-prompt\.md/, 'plan must not dispatch a plan-reviewer subagent');
  const step6 = sectionBetween(text, '### Step 6', '### Step 7');
  assert.match(step6, /Gear 3 only/i, 'the plan human gate is gear-3 only');
  assert.match(step6, /human/i, 'Step 6 must be a human review gate');
  assert.match(step6, /review it|review the (written )?plan/i, 'Step 6 must ask the user to review the written plan');
  assert.doesNotMatch(step6, /Dispatch a fresh/i, 'Step 6 must not dispatch a subagent reviewer');
});

test('plan: Step 6 gains autopilot branch — drive: autopilot → non-blocking checkpoint, append DONE to status file', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step6 = sectionBetween(text, '### Step 6', '### Step 7');
  assert.match(step6, /drive:\s*autopilot/i, 'Step 6 must mention drive: autopilot');
  assert.match(step6, /autopilot-status\.md/, 'Step 6 must reference autopilot-status.md');
  assert.match(step6, / — plan — DONE — /, 'Step 6 must describe appending " — plan — DONE — " to status file');
  assert.match(step6, /superseded|non-blocking/i, 'Step 6 must use a supersession word (superseded or non-blocking)');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /drive:\s*autopilot/i, 'Step 0 must mention drive: autopilot');
  assert.match(step0, /BLOCKED/i, 'Step 0 must mention BLOCKED for autopilot runs');
  assert.match(step0, /autopilot-status\.md/, 'Step 0 must reference autopilot-status.md');
  // Verify existing plan locks still pass
  assert.match(step6, /Gear 3 only/i, 'the plan human gate must remain gear-3 only');
  assert.match(step6, /human/i, 'Step 6 must remain a human review gate');
  assert.match(step6, /review it|review the (written )?plan/i, 'Step 6 must still ask the user to review the written plan');
  assert.doesNotMatch(step6, /Dispatch a fresh/i, 'Step 6 must not use the phrase "dispatch a fresh"');
});

test('plan: autopilot consumes its phase manifest first; manual discovery remains unchanged', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /conductor-supplied phase manifest/i, 'autopilot plan must name the conductor-supplied phase manifest');
  assert.match(step0, /read[\s\S]{0,80}manifest (?:first|before any other)/i, 'autopilot plan must read the manifest first');
  assert.match(step0, /validate[^.]*role[^.]*scope|validate[^.]*scope[^.]*role/i, 'autopilot plan must validate manifest role and scope');
  assert.match(step0, /every `required`|all `required`/i, 'autopilot plan must eagerly read every required input');
  assert.match(step0, /do not preload `onDemand`/i, 'autopilot plan must not preload onDemand inputs');
  assert.match(step0, /concrete named missing fact/i, 'onDemand reads must require a concrete named missing fact');
  assert.match(step0, /record[^.]*read/i, 'onDemand reads must be recorded');
  assert.match(step0, /only when `drive: autopilot`|applies only when `drive: autopilot`/i,
    'phase-manifest authority must be autopilot-only');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step1, /Manual drive/i, 'Step 1 must explicitly preserve manual-drive discovery');
  assert.match(step1, /read only the accepted spec body/i, 'manual drive must read the selected full spec only');
  assert.match(step1, /`steepy-formula hub-mode`/, 'manual drive must orient through the declared hub mode');
  assert.match(step1, /`steepy-formula context resolve --path <p>\.\.\.`/, 'manual drive must orient through context resolve');
  assert.doesNotMatch(step1, /_INDEX\.md|testing-and-checklist|mini-routing|modular core|\bleaf\b|\bleaves\b/i,
    'plan Step 1 carries no Markdown-hub, routing-table, or modular-leaf reading');
});

test('plan: each task is a self-contained spec-to-brief contract with every mandatory field', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');
  for (const field of [
    'Requirements and deliverables',
    'Relevant global constraints',
    'Surface',
    'Specialist agent',
    'Exact paths',
    'Test command',
    'Dependencies',
    'Complexity',
    'Success criteria',
  ]) {
    assert.ok(step3.includes(`**${field}:**`), `plan task format must include ${field}`);
  }
  assert.match(step3, /repository-relative/i, 'task paths must be repository-relative');
  assert.match(step3, /canonical path \+ heading/i, 'large upstream references must use canonical path + heading');
  assert.match(step3, /No requirement may live only in conversation/i,
    'the plan must prohibit requirements that exist only in conversation');
  assert.match(step3, /mechanical \| integration \| design/, 'task complexity must use the allowed vocabulary');
  assert.match(step3, /## Task <positive integer>/i, 'plan must define the canonical machine-readable task boundary');
  assert.match(step3, /SC1/i, 'plan must define the canonical success-criterion ID grammar');
});

test('brainstorm: canonical autopilot metadata and success-criteria grammar is explicit', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5', '### Step 5.5');
  assert.match(step5, /## Success criteria/, 'brainstorm must require exactly one canonical success-criteria H2');
  assert.match(step5, /SC1/, 'brainstorm must assign stable criterion IDs');
  assert.match(step5, /Cross-cutting surfaces/, 'brainstorm must separate cross-cutting metadata from ownership');
});

test('plan: autopilot writes exactly the manifest-declared output while manual naming remains dated', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step4 = sectionBetween(text, '### Step 4', '### Step 4.5');
  assert.match(step4, /Autopilot[\s\S]*exactly[\s\S]*manifest[^.]*`outputs`/i);
  assert.match(step4, /Manual drive[\s\S]*YYYY-MM-DD-<topic>\.md/i);
});

test('plan: self-review gates completeness, binding, ordering, coverage, safe paths, and context independence', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step45 = sectionBetween(text, '### Step 4.5', '### Step 5');
  assert.match(step45, /every mandatory field/i, 'self-review must check every mandatory field');
  assert.match(step45, /known surface/i, 'self-review must validate a known surface');
  assert.match(step45, /specialist[^.]*\.claude\/agents\/<surface>-agent\.md/i, 'self-review must validate the specialist agent by naming convention');
  assert.match(step45, /dependency ordering/i, 'self-review must validate dependency ordering');
  assert.match(step45, /criteria coverage/i, 'self-review must validate criteria coverage');
  assert.match(step45, /allowed complexity/i, 'self-review must validate allowed complexity');
  assert.match(step45, /safe repository-relative paths/i, 'self-review must validate safe paths');
  assert.match(step45, /context independence/i, 'self-review must validate context independence');
  assert.match(step45, /before[^.]*DONE|before[^.]*human approval/i,
    'the plan may not complete or seek approval before the self-review gate passes');
});

test('plan: Step 4.5 checklist adds the discovery criterion without renumbering the first seven checks', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  const step45 = sectionBetween(text, '### Step 4.5', '### Step 5');
  assert.match(step45, /1\.\s+\*\*Every mandatory field\*\*/, 'checklist item 1 must stay Every mandatory field');
  assert.match(step45, /2\.\s+\*\*Binding consistency\*\*/, 'checklist item 2 must stay Binding consistency');
  assert.match(step45, /3\.\s+\*\*Dependency ordering\*\*/, 'checklist item 3 must stay Dependency ordering');
  assert.match(step45, /4\.\s+\*\*Complexity present\*\*/, 'checklist item 4 must stay Complexity present');
  assert.match(step45, /5\.\s+\*\*Criteria coverage\*\*/, 'checklist item 5 must stay Criteria coverage');
  assert.match(step45, /6\.\s+\*\*Safe repository-relative paths\*\*/, 'checklist item 6 must stay Safe repository-relative paths');
  assert.match(step45, /7\.\s+\*\*Context independence\*\*/, 'checklist item 7 must stay Context independence');
  assert.match(step45, /8\.\s+\*\*[^*]+\*\*/, 'an 8th checklist item must be added for the discovery criterion');
  const item8 = step45.match(/8\.\s+\*\*[^\n]*/)?.[0] ?? '';
  assert.match(item8, /stated only as a goal|only[^.]*as a goal/i, 'checklist item 8 must check no task is stateable only as a goal');
  assert.match(item8, /split|discovery task/i, 'checklist item 8 must name the split-or-precede-with-discovery remedy');
});

test('review: autopilot manifest and manual capability inventories are authoritative and exclude transcripts', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /conductor-supplied phase manifest/i, 'autopilot review must name the conductor-supplied phase manifest');
  assert.match(step0, /read[\s\S]{0,80}manifest (?:first|before any other)/i, 'autopilot review must read the manifest first');
  assert.match(step0, /validate[^.]*role[^.]*scope|validate[^.]*scope[^.]*role/i, 'autopilot review must validate manifest role and scope');
  assert.match(step0, /every `required`|all `required`/i, 'autopilot review must eagerly read every required input');
  assert.match(step0, /do not preload `onDemand`/i, 'autopilot review must not preload onDemand inputs');
  assert.match(step0, /concrete named missing fact/i, 'review onDemand reads must require a concrete named missing fact');
  assert.match(step0, /record[^.]*read/i, 'review onDemand reads must be recorded');
  assert.match(step0, /only when `drive: autopilot`|applies only when `drive: autopilot`/i,
    'review manifest authority must be autopilot-only');
  assert.match(step0, /manifest[^.]*failure[\s\S]{0,200}BLOCKED|BLOCKED[\s\S]{0,200}manifest[^.]*failure/i,
    'manifest failures must use the correlated BLOCKED protocol');
  assert.match(step0, /manifest\.contract\.(?:verdict|gear|drive)/,
    'manifest-backed review must take Step-0 scalars from manifest.contract');
  assert.match(step0, /do not read[^.]*spec/i,
    'manifest-backed review must prohibit the undeclared full-spec read');
  const manualBranch = step0.match(/\*\*Manual\/no-manifest[^]*?(?=\n\n|\n- \*\*)/)?.[0];
  assert.ok(manualBranch, 'review Step 0 must preserve a local manual/no-manifest branch');
  assert.match(manualBranch, /manual handoff/i);
  assert.match(manualBranch, /criteria[^]*task-results[^]*branch-diff/i);

  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  for (const inventory of [
    'success-criteria source',
    'task/result index',
    'aggregate diff',
    'relevant standards',
    'test commands',
  ]) {
    assert.match(step1, new RegExp(inventory.replace('/', '\\/'), 'i'), `review manifest must inventory ${inventory}`);
  }
  assert.match(step1, /exclude[^.]*per-task transcripts[^.]*conversations/i,
    'review must exclude per-task transcripts and conversations');
  assert.match(step1, /Manual drive/i, 'Step 1 must explicitly define manual review loading');
  assert.match(step1, /Eagerly read exactly[^]*criteria[^]*task-results[^]*branch-diff/i);
  assert.doesNotMatch(step1, /modular core|mini-routing|matching\s+leaf|zero\s+(?:leaves\s+)?match/i,
    'review carries no modular-leaf matching');

  const checklist = sectionBetween(text, '## Checklist', '## Procedure');
  const regularChecklist = checklist.replace(/\(gear 4:[^)]*\)/giu, '');
  assert.match(checklist,
    /manual[^\n]*criteria[^\n]*task-result index[^\n]*branch diff[^\n]*graph orientation/i,
    'regular manual review must name its exact bounded inventory');
  assert.match(checklist, /gear 4[^\n]*goal contract[^\n]*loop ledger/i,
    'the mutually exclusive Gear-4 inventory must remain explicit');
  assert.doesNotMatch(regularChecklist,
    /(?:read|load|locate|consult|inspect|sweep)[^\n]*(?:\bspec\b|\bplan\b|progress[- ]ledger)/i,
    'regular manual review must not name spec, plan, or progress-ledger reads');
  assert.match(checklist,
    /manual[^\n]*insight[^\n]*accepted criteria[^\n]*task-result index[^\n]*(?:status[^\n]*signals|signals[^\n]*status)/i,
    'manual insight sweep must use only accepted criteria and compact task-index status/signals');
  assert.match(checklist, /manifest[^\n]*criteria|criteria[^\n]*manifest/i,
    'review checklist must name manifest-backed criteria evidence');
});

test('implement: autopilot takes the standard input from the conductor-resolved context', () => {
  const protocol = readFileSync(join(skillsDir, 'implement', 'autopilot-protocol.md'), 'utf8');
  assert.match(protocol, /## Step 1 — input inventory and resolved-context standards/);
  assert.match(protocol, /conductor-resolved `context\.md`/);
  assert.match(protocol, /never (?:guess|manufacture)/i);
  assert.match(protocol, /--standard <resolved-context-path>/);
  assert.match(protocol, /--hub-index <resolved-context-path>/);
  assert.match(protocol, /once per resolved context path/i);
  assert.match(protocol, /the resolved context's Surfaces listing/);
  assert.doesNotMatch(protocol, /exact-standard-path-from-routing|mode-ownership-map|mini-routing|routing index|routing read/i);
  assert.doesNotMatch(protocol, /--standard \.apex\/standards\/<(?:surface|relevant-surface)>\.md/);
  assert.match(protocol, /manifest\.contract\.(?:verdict|gear|drive)/,
    'manifest-backed implement must take scalars from manifest.contract');
  const autopilotBranch = protocol.match(/\*\*Manifest-backed autopilot:[\s\S]*?(?=\n\*\*)/)?.[0];
  assert.ok(autopilotBranch, 'autopilot-protocol.md needs an explicit manifest-backed branch');
  assert.doesNotMatch(autopilotBranch, /(?:must|always) (?:read|locate)[^.]*spec/i);
  assert.match(protocol, /spec[^.]*`onDemand`[\s\S]{0,180}concrete (?:named )?(?:missing fact|insufficiency)/i,
    'implement may read the onDemand spec only for concrete insufficiency');

  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /Manual\/no-manifest[\s\S]*spec head/i);
});

test('review: self-verifies evidence — no evidence-reviewer subagent and no collector prompt', () => {
  const dir = join(skillsDir, 'review');
  assert.ok(!existsSync(join(dir, 'evidence-reviewer-prompt.md')),
    'the evidence-reviewer subagent prompt must be retired');
  assert.ok(!existsSync(join(dir, 'evidence-prompt.md')),
    'the evidence-collector prompt must be retired — collection is deterministic and inline');
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /evidence-reviewer-prompt\.md/, 'review must not dispatch an evidence-reviewer subagent');
  assert.doesNotMatch(text, /evidence-prompt\.md/, 'review must not dispatch an evidence-collector subagent');
  assert.ok(text.includes('steepy-formula graph validate'), 'review SKILL must keep the graph validate gate');
  assert.doesNotMatch(text, /validate-hub/, 'review SKILL carries no validate-hub gate');
  assert.match(text, /self-verif/i, 'review must state it self-verifies the criteria');
  assert.match(text, /real command output/i, 'review must verify criteria from real command output');
  assert.match(text, /dispatches \*\*no\s+subagent reviewer or evidence collector\*\*/i,
    'Step 0 must state no subagent reviewer or evidence collector is dispatched');
  assert.match(text, /Judgement is never delegated/i);
});

test('review: deterministic capture keeps verbatim evidence on disk behind a bounded receipt', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /capture-review-evidence\.mjs/);
  assert.match(step2, /--evidence '<evidence-path>'[^\n]*--test-command '<exact surface test command>'/);
  assert.match(step2, /--verifier-command '<exact verifier command>'/);
  assert.match(step2, /verbatim output[^.]*on disk|verbatim[^.]*proof/i);
  assert.match(step2, /bounded JSON receipt/i);
  assert.match(step2, /do\s+not open or preload the complete `evidence-report\.md`/i);
  assert.match(step2, /smallest exact line or byte range/i);
  assert.match(step2, /stale evidence[^.]*replaced rather than merged/i);
  assert.doesNotMatch(step2, /task\/subagent tool|dispatch the collector|evidence-prompt\.md/i);
  assert.equal(existsSync(join(skillsDir, 'review', 'evidence-prompt.md')), false);
});

test('review: the capture gate wiring is the built-in graph validate gate — one form, no override, no skip', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  const wiring = sectionBetween(step2, 'The coherence gate is the capture', 'For Gear 4 append');
  assert.match(wiring, /built-in gate[^.]*`steepy-formula graph validate`/i,
    'the capture script\'s built-in gate is graph validate');
  assert.match(wiring, /labeled\s+`coherence-gate`/i, 'the gate receipt slot is labeled coherence-gate');
  assert.doesNotMatch(text, /--gate-command|--no-gate/, 'review passes neither --gate-command nor --no-gate');
  assert.match(step2, /then `coherence-gate`\)/i, 'the receipt label validation ends with coherence-gate');
  assert.doesNotMatch(text, /validate-hub|`legacy`|\blegacy\b/i, 'review carries no validate-hub or legacy wording');
});

test('implement: ships an implementer prompt that dispatches the surface agent under TDD', () => {
  const path = join(skillsDir, 'implement', 'implementer-prompt.md');
  assert.ok(existsSync(path), 'implement must ship implementer-prompt.md');
  const text = readFileSync(path, 'utf8');
  assert.match(text, /-agent/, 'implementer prompt must dispatch the <surface>-agent');
  assert.match(text, /testing-and-checklist\.md|test command/i,
    'implementer prompt must reference the surface test command');
  assert.match(text, /STOP/, 'implementer prompt must keep a red-flag STOP signal');
  assert.match(text, /failing test/, 'implementer prompt must keep the TDD failing-test discipline');
});

test('implement: implementer prompt requires recording a discovery-vs-specified occurrence as a concern', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'implementer-prompt.md'), 'utf8');
  const durable = sectionBetween(text, '## Durable report and response');
  assert.match(durable, /discover\*\*[\s\S]{0,120}rather than execute what the brief specified/i,
    'the prompt must name the discover-vs-specified occurrence');
  assert.match(durable, /record\s+that occurrence in \[REPORT_FILE\][\s\S]{0,80}flag it as a concern[\s\S]{0,40}DONE_WITH_CONCERNS/i,
    'the occurrence must be recorded in the report file and flagged via DONE_WITH_CONCERNS');

  // M3 (final-review): NEEDS_CONTEXT and DONE_WITH_CONCERNS must not fire on the same trigger.
  assert.match(durable, /cannot resolve by reading the repository[\s\S]{0,120}NEEDS_CONTEXT/i,
    'ambiguity unresolvable from the repository routes to NEEDS_CONTEXT');
  assert.match(durable, /did close by discovering[\s\S]{0,140}DONE_WITH_CONCERNS/i,
    'a gap the implementer did close by discovering routes to DONE_WITH_CONCERNS');
  assert.match(text, /DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT/,
    'the status enum stays exactly as it is');
});

test('implement: ships a hub-aware task-reviewer prompt', () => {
  const text = reviewerBody('implement', 'task-reviewer-prompt.md');
  assert.match(text, /spec compliance/i, 'task-reviewer must check spec compliance');
});

test('implement: ships a whole-branch final-review prompt', () => {
  const path = join(skillsDir, 'implement', 'final-review-prompt.md');
  assert.ok(existsSync(path), 'implement must ship final-review-prompt.md');
  const text = readFileSync(path, 'utf8');
  for (const marker of ['Status', 'Approved', 'Issues Found']) {
    assert.ok(text.includes(marker), `final-review-prompt.md must define output marker '${marker}'`);
  }
  assert.match(text, /whole-branch|cross-task|all tasks/i,
    'final review must be whole-branch in scope');
});

test('implement: wires implementer -> task review -> final review -> handoff, in order', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const iImpl = text.indexOf('implementer-prompt.md');
  const iTask = text.indexOf('task-reviewer-prompt.md');
  const iFinal = text.indexOf('final-review-prompt.md');
  const iHandoff = text.indexOf('next step is the `review` skill');
  assert.ok(iImpl !== -1 && iTask !== -1 && iFinal !== -1 && iHandoff !== -1,
    'SKILL must cite all three prompts and the abstract `review` skill handoff');
  assert.ok(iImpl < iTask, 'implementer dispatch must precede the task review');
  assert.ok(iTask < iFinal, 'task review must precede the whole-branch final review');
  assert.ok(iFinal < iHandoff, 'final review must precede the `review` skill handoff');
});

test('shipped workflow handoffs use namespaced slash invocations', () => {
  const shippedInstructionFiles = [
    'skills/brainstorm/SKILL.md',
    'skills/plan/SKILL.md',
    'skills/implement/SKILL.md',
    'skills/implement/final-review-prompt.md',
    // terminal review emits only its human envelope; loop-engineer still hands off to review
    'skills/loop-engineer/SKILL.md',
    'skills/loop-engineer/loop-implementer-prompt.md',
    'skills/loop-engineer/loop-final-review-prompt.md',
    'templates/bootstrap-skill-graph.md',
    'templates/project-bootstrap-skill.md',
  ];

  for (const relativePath of shippedInstructionFiles) {
    const text = readFileSync(join(root, relativePath), 'utf8');
    assertNoBareWorkflowInvocations(text, relativePath);
  }
});

test('implement: gates commits, keeps the ledger under .formula/work/tasks/, runs sequentially', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  assert.match(text, /\.formula\/work\/tasks\//, 'SKILL must place the progress ledger under .formula/work/tasks/');
  assert.match(text, /commit/i, 'SKILL must address per-task commit authorization');
  assert.match(text, /sequential/i, 'SKILL must state sequential execution');
});

test('loop-engineer: valid gear-4 chain skill — frontmatter, Checklist, Step 0, both prompts wired', () => {
  const path = join(skillsDir, 'loop-engineer', 'SKILL.md');
  assert.ok(existsSync(path), 'loop-engineer/SKILL.md should exist');
  const text = readFileSync(path, 'utf8');
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fmMatch, 'loop-engineer should have YAML frontmatter');
  const fm = fmMatch[1];
  assert.match(fm, /name:\s*loop-engineer\b/, 'frontmatter name must be loop-engineer');
  assert.match(fm, /user-invocable:\s*true/, 'loop-engineer must be user-invocable');
  assert.match(fm, /argument-hint:/, 'loop-engineer frontmatter must declare argument-hint (seeds the goal field)');
  assert.match(text, /## Checklist/, 'loop-engineer must carry a ## Checklist');
  assert.match(text, /### Step 0 — Read the gear/, 'loop-engineer must read the gear at Step 0');
  assert.ok(text.includes('loop-implementer-prompt.md'), 'loop-engineer must cite the implementer prompt');
  assert.ok(text.includes('loop-final-review-prompt.md'), 'loop-engineer must cite the final-review prompt');
});

test('loop-engineer: Step 0 proceeds only on an exact complete ratified contract and otherwise refuses before autonomy', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0 — Read the gear', '### Step 1');
  // existing locks kept green under the four-outcome rewrite
  assert.match(step0, /goal contract|goal\.md/, 'Step 0 must read the goal contract artifact');
  assert.match(step0, /required:[^]*goal: <goal-path>/, 'Step 0 must require the exact goal capability');
  assert.match(step0, /gear[\s:`-]*4/i, 'Step 0 must gate on gear 4');
  assert.match(step0, /refuse/i, 'Step 0 must refuse on a non-gear-4 artifact');
  assert.match(step0, /never recompute/i, 'Step 0 must never recompute the gear inline');
  assert.match(step0, /never fabricate/i, 'Step 0 must never fabricate a field value');
  assert.match(step0, /absent[\s\S]{0,180}refuse|missing[\s\S]{0,180}refuse/i,
    'missing or partial contracts must refuse');
  assert.match(step0, /before any iteration, branch mutation, or commit question/i,
    'refusal must precede every autonomous or mutating action');
  assert.match(step0, /navigation and semantic-skill routing only/i,
    'Step 0 must preserve the approved bootstrap boundary');
  assert.doesNotMatch(step0, /auto-chain|completion interview|writes\/completes `goal\.md`/i,
    'Step 0 must not restore the retired bootstrap ceremony branch');
});

test('loop-engineer: Step 1 missing-field routes back to the Step 0 refusal', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step1, /mandatory field/i, 'Step 1 must keep the mandatory-field list');
  assert.match(step1, /Step 0/, 'a missing mandatory field must route back to Step 0');
  assert.match(step1, /refusal/i, 'a missing mandatory field routes to the Step 0 refusal');
  assert.doesNotMatch(step1, /auto-chain|completion interview/i, 'missing fields never start hidden authoring');
});

test('loop-engineer: delegates the deterministic run to the packaged controller and emits its review capability', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  assert.match(text, /node <engine-root>\/scripts\/loop-engineer\.mjs --repo-root \. --goal '<goal-path>' --harness '<active-harness>' --commit-authorized/);
  assert.match(text, /fresh[^]*omits `--resume` and `--ledger`/i);
  assert.match(text, /--resume --ledger '<loop-ledger-path>'/);
  assert.match(text, /active supported harness[^]*`adapters\/headless\.mjs`/i);
  assert.match(text, /runner-unavailable[^]*(?:stop|refuse)/i);
  assert.match(text, /controller output[^]*`status`[^]*`runId`[^]*`terminal`[^]*`goal`[^]*`loop-ledger`/i);
  assert.match(text, /validated terminal result[^]*exact returned paths[^]*canonical\s+Gear-4 review handoff/i);
  assert.doesNotMatch(text, /For iteration `i` from 1 to `budget`/);
  assert.doesNotMatch(text, /run at most \*\*2 fix passes beyond the budget\*\*/i);
  assert.doesNotMatch(text, /append one line: iteration/i);
  assert.doesNotMatch(text, /perform this review yourself in a fresh dedicated pass/i);
});

test('loop-engineer: closes exact target routing, ordered standards, and concrete model tiers into the CLI boundary', () => {
  const skill = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step1 = sectionBetween(skill, '### Step 1', '### Step 2');
  const step2 = sectionBetween(skill, '### Step 2', '### Step 3');
  assert.match(step1, /`apex:<projectId>:surface:<surface>`/u);
  assert.match(step2, /--graph-target 'apex:<projectId>:surface:<surface>'/u);
  assert.doesNotMatch(`${step1}\n${step2}`, /--routing-index|--standard\b|exact routing row|mini-routing|\.apex\/standards\/<surface>\.md/iu,
    'one graph argument set: no routing-index, standard flags, routing row, or standards path');

  for (const file of ['loop-implementer-prompt.md', 'loop-final-review-prompt.md']) {
    const prompt = readFileSync(join(skillsDir, 'loop-engineer', file), 'utf8');
    assert.match(prompt, /^\s*model: \[MODEL_TIER\](?:\s+#.*)?$/mu, `${file}: concrete tier placeholder`);
    assert.match(prompt, /\[ROUTING_INDEX\]/u, `${file}: routed index placeholder`);
    assert.match(prompt, /\[STANDARD_INPUTS\]/u, `${file}: ordered standard inventory placeholder`);
    assert.doesNotMatch(prompt, /\.apex\/standards\/\[SURFACE\]\.md|\.apex\/standards\/<surface>\.md|_INDEX\.md|\blegacy\b/iu,
      `${file}: no synthesized standard path, Markdown index, or legacy wording`);
  }
});

test('loop-engineer: the skill authorizes and routes but never becomes the state controller', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const boundary = sectionBetween(text, '### Controller responsibility boundary', '### Step 0');
  for (const phrase of [
    'allocate attempts',
    'keep/discard policy',
    'interpret ledger Markdown as state',
    'perform Git recovery',
    'grant extra fixes',
    'inline runner fallback',
  ]) {
    assert.ok(boundary.includes(phrase), `controller boundary must prohibit: ${phrase}`);
  }
  assert.match(boundary, /scripts own deterministic state/i);
  assert.match(text, /Authorize controller-owned commits for this run\?/);
  assert.match(text, /boolean and metric[^.]*require `yes`/i);
  assert.match(text, /ask exactly once[^.]*before[^.]*controller/i);
  const resultHandling = sectionBetween(text, '### Step 3', '## Model Selection');
  assert.match(resultHandling, /do not (?:open|read|parse)[^]*goal or ledger[^]*lifecycle/i,
    'the skill must not recover controller state from Markdown projections');
  assert.match(resultHandling, /fail[^]*only[^]*result[^/]*path mismatch/i,
    'the skill must fail closed only on controller result/path mismatch');
  assert.doesNotMatch(resultHandling, /verify[^]*(?:goal[^]*`CONSUMED`|ledger[^]*`READY`)/i,
    'the skill must not independently verify terminal lifecycle markers');
});

test('loop-engineer: ships a loop-implementer prompt that dispatches the surface agent', () => {
  const path = join(skillsDir, 'loop-engineer', 'loop-implementer-prompt.md');
  assert.ok(existsSync(path), 'loop-engineer must ship loop-implementer-prompt.md');
  const text = readFileSync(path, 'utf8');
  assert.match(text, /-agent/, 'the loop implementer prompt must dispatch the <surface>-agent');
  assert.match(text, /STOP/, 'the loop implementer prompt must keep a red-flag STOP signal');
  assert.match(
    text,
    /DONE\s*\|\s*DONE_WITH_CONCERNS\s*\|\s*BLOCKED\s*\|\s*NEEDS_CONTEXT/,
    'the loop implementer prompt must define the status enum'
  );
  assert.match(text, /run-<run-id>-attempt-<attempt>-report\.md/, 'the loop implementer prompt must use the controller-owned immutable attempt report path');
  assert.match(text, /blast[ -]radius/i, 'the loop implementer prompt must constrain the implementer to the blast radius');
  assert.match(text, /goal contract/i, 'the loop implementer prompt must brief the implementer with the goal contract');
  assert.match(text, /[Nn]ever commit/, 'the implementer must never commit — the controller commits after the verifier decides keep/discard');
  assert.match(text, /never run Git|no Git/i, 'the implementer must not perform Git operations');
  assert.doesNotMatch(text, /Commit authorized/i, 'commit authorization is controller state and must not be delegated to the implementer');
  assert.match(text, /exactly four fields/i);
  assert.match(text, /status: DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT\n\s*artifact: \[REPORT_FILE\]\n\s*changed-paths: <comma-separated repo-relative paths or none>\n\s*signals: <short machine-readable IDs or none>/);
});

// v0.8.2 port adaptation: apex locks the enum in `.apex/glossary.md` too; that hub is archived
// here and the entry lives as the canonical graph's `term:implementer-status` (locked on the
// dogfood checkpoint once it is re-exported past r4). The repo-file halves stay locked below.
test('non-regression: the implementer status enum stays exactly DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT across implementer-prompt, implement SKILL, and loop-implementer-prompt', () => {
  const implementerPrompt = readFileSync(join(skillsDir, 'implement', 'implementer-prompt.md'), 'utf8');
  assert.match(implementerPrompt, /Allowed status values are\s*\n\s*DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT\./,
    'implementer-prompt.md must keep the exact enum sentence unchanged');

  const implementSkill = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  assert.match(implementSkill, /Implementer\/fix statuses are `DONE`,\s*\n`DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`/,
    'implement/SKILL.md must keep the exact enum sentence unchanged');

  const loopImplementerPrompt = readFileSync(join(skillsDir, 'loop-engineer', 'loop-implementer-prompt.md'), 'utf8');
  assert.match(loopImplementerPrompt, /\*\*Status:\*\* DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT/,
    'loop-implementer-prompt.md must keep the exact enum sentence unchanged');
});

test('loop-engineer: ships a whole-branch loop final-review prompt over the goal contract', () => {
  const text = reviewerBody('loop-engineer', 'loop-final-review-prompt.md');
  assert.match(text, /whole-branch|loop branch|entire loop/i, 'the loop final review must be whole-branch in scope');
  assert.match(text, /goal contract/i, 'the loop final review must use the goal contract as the criterion');
  assert.match(text, /run-<run-id>-review-<review>-report\.md/, 'the reviewer must write the immutable controller-owned review report');
  assert.match(text, /read-only/i);
  assert.match(text, /never run Git|no Git/i);
  assert.match(text, /exactly four fields/i);
  assert.match(text, /status: DONE\n\s*artifact: <controller-supplied report path>\n\s*changed-paths: none\n\s*signals: approved \| issues-found/);
});

test('loop-engineer: Step 1 declares the hub mode via steepy-formula hub-mode — the prose never re-implements detection', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step1, /Run `steepy-formula hub-mode` and carry its declared\s+mode/,
    'Step 1 must invoke steepy-formula hub-mode and carry the declared mode');
  assert.match(step1, /`graph`, `migrate`, or `none`/,
    'the declaration must name the three declared modes');
  const declaration = step1.split(/\n\n+/).find((p) => p.includes('Hub-mode declaration'));
  assert.ok(declaration, 'Step 1 must carry the hub-mode declaration paragraph');
  assert.match(declaration, /always exits 0/, 'the hub-mode command is a declaration, not a gate');
  assert.doesNotMatch(declaration, /_INDEX\.md/,
    'the declaration must not probe .apex/_INDEX.md existence to detect the mode');
});

test('loop-engineer: Step 1 graph branch resolves the hub context from the graph — no _INDEX/standards/testing-and-checklist requirement', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  const graphBranch = sectionBetween(step1, '- **`graph`**', '- **`none`**');
  assert.match(graphBranch, /steepy-formula context resolve --path/);
  assert.match(graphBranch, /context\.json/);
  assert.match(graphBranch, /context\.md/);
  assert.match(graphBranch, /ext_v1_command/);
  assert.match(graphBranch, /verification Rule/);
  assert.match(graphBranch, /\.claude\/agents\/<name>-agent\.md/);
  assert.match(graphBranch, /`apex:<projectId>:surface:<surface>`/);
  assert.doesNotMatch(graphBranch, /_INDEX\.md|\.apex\/standards|testing-and-checklist\.md/);
  assert.doesNotMatch(step1, /_INDEX\.md|\.apex\/standards|\blegacy\b/i, 'Step 1 carries no Markdown hub or legacy branch');
});

test('loop-engineer: terminal review owns the declared mode gate; the controller report names it', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const boundary = sectionBetween(text, '### Controller responsibility boundary', '### Step 0');
  assert.match(boundary, /terminal review owns the declared hub mode's mandatory coherence gate/);
  assert.ok(boundary.includes('`steepy-formula graph validate`'));
  assert.doesNotMatch(boundary, /validate-hub|\blegacy\b/i);
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');
  assert.match(step3, /report the hub mode declared at Step 1 and name the coherence gate/);
  assert.match(step3, /`steepy-formula graph validate`/);
  assert.doesNotMatch(step3, /validate-hub|\blegacy\b/i);
  assert.match(step3, /never runs\s+or claims it/);
});

test('loop-engineer: Step 1 mode migrate stops and routes to the graph-migrate skill', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  const migrateBranch = sectionBetween(step1, '- **`migrate`**', '- **`none`**');
  assert.ok(migrateBranch.includes('Stop and tell the user to run the `graph-migrate` skill (invoke it the way your harness invokes skills) before any other workflow.'));
  assert.ok(text.includes('stop in `migrate` and `none`'), 'checklist names the migrate stop');
});

test('loop-engineer: Step 1 mode none routes to the init skill', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  const noneBranch = sectionBetween(step1, '- **`none`**', 'If the declared mode');
  assert.match(noneBranch, /no graph hub exists/);
  assert.doesNotMatch(noneBranch, /either channel/, 'there is one channel, the graph');
  assert.match(noneBranch, /run the `init` skill[\s\S]{0,80}first,?\s+and stop/i);
});

test('loop-engineer: both prompts bind the controller routing slots by declared mode; Step 2 carries the one graph argument set', () => {
  for (const file of ['loop-implementer-prompt.md', 'loop-final-review-prompt.md']) {
    const prompt = readFileSync(join(skillsDir, 'loop-engineer', file), 'utf8');
    assert.match(prompt, /\[ROUTING_INDEX\]/u);
    assert.match(prompt, /\[STANDARD_INPUTS\]/u);
    assert.match(prompt, /The controller binds both routing slots to the graph:\s+both\s+slots\s+name\s+the\s+one\s+controller-resolved\s+surface\s+context \(`context\.md` for\s+\[SURFACE\] under the loop's `hub-context\/` directory/u);
    assert.doesNotMatch(prompt, /\[SURFACE_CONTEXT\]|\[OWNERSHIP_MAP\]/u);
  }
  const impl = readFileSync(join(skillsDir, 'loop-engineer', 'loop-implementer-prompt.md'), 'utf8');
  assert.match(impl, /ext_v1_command/);
  const skill = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(skill, '### Step 2', '### Step 3');
  assert.ok(step2.includes("--commit-authorized --graph-target 'apex:<projectId>:surface:<surface>'\n"));
  assert.ok(step2.includes("--commit-authorized --graph-target 'apex:<projectId>:surface:<surface>' --resume --ledger '<loop-ledger-path>'"));
  assert.doesNotMatch(step2, /--routing-index|--standard\b|mixed|\*\*Graph mode|\*\*Legacy mode|\blegacy\b/i);
  assert.match(step2, /HUB_MODE_DRIFT[^]*recorded graph binding is missing or differs/);
});

const WHOLE_BRANCH_REVIEW_SENTENCE = 'The whole-branch review runs at the reviewer tier — `standard`, rising to `most-capable` when the branch is large or subtle — not at whatever model the harness happens to offer.';

const MODEL_SECTION_WITH_REVIEW = `## Model Selection

Always set \`model:\` explicitly when dispatching a subagent. An omitted model inherits the session model (usually the most capable and most expensive) and silently defeats this policy.

Pick the tier by task complexity and risk:

| Signal | Tier |
|--------|------|
| Mechanical / transcription (1-2 files, complete spec) | cheap |
| Integration / multi-file / judgment | standard |
| Design / architecture / high-risk or subtle change | most-capable |

Reviewers floor at **standard** and rise to **most-capable** when the artifact is high-risk or subtle.

**Turn count beats token price.** The cheapest model often takes 2-3× the turns on multi-step work — more wall-clock and context overall. Make a mid-tier model the floor for reviewers and for implementers working from prose; reserve the cheapest tier for transcription tasks whose exact code the plan already contains.

Translate the tier to a concrete model by judgment at dispatch time using your harness's available models. The three tiers are the whole ladder — \`most-capable\` is its top rung, not an open-ended "best available". A model that sits above that rung is outside the ladder: never reach it from a tier, and record a one-line reason in the ledger when you override to it. The whole-branch review runs at the reviewer tier — \`standard\`, rising to \`most-capable\` when the branch is large or subtle — not at whatever model the harness happens to offer. On a harness without per-dispatch model choice, everything runs on the session model — record that in the ledger.`;

const MODEL_SECTION_WITHOUT_REVIEW = `## Model Selection

Always set \`model:\` explicitly when dispatching a subagent. An omitted model inherits the session model (usually the most capable and most expensive) and silently defeats this policy.

Pick the tier by task complexity and risk:

| Signal | Tier |
|--------|------|
| Mechanical / transcription (1-2 files, complete spec) | cheap |
| Integration / multi-file / judgment | standard |
| Design / architecture / high-risk or subtle change | most-capable |

Reviewers floor at **standard** and rise to **most-capable** when the artifact is high-risk or subtle.

**Turn count beats token price.** The cheapest model often takes 2-3× the turns on multi-step work — more wall-clock and context overall. Make a mid-tier model the floor for reviewers and for implementers working from prose; reserve the cheapest tier for transcription tasks whose exact code the plan already contains.

Translate the tier to a concrete model by judgment at dispatch time using your harness's available models. The three tiers are the whole ladder — \`most-capable\` is its top rung, not an open-ended "best available". A model that sits above that rung is outside the ladder: never reach it from a tier, and record a one-line reason in the ledger when you override to it. On a harness without per-dispatch model choice, everything runs on the session model — record that in the ledger.`;

function modelSection(name) {
  const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
  const start = text.indexOf('## Model Selection');
  assert.ok(start !== -1, `${name} must contain a ## Model Selection section`);
  let rest = text.slice(start);
  const next = rest.indexOf('\n## ', 1);
  if (next !== -1) rest = rest.slice(0, next);
  return rest.trimEnd();
}

test('the five chain skills carry the canonical Model Selection block (with/without the whole-branch-review sentence)', () => {
  for (const s of ['implement', 'review']) {
    assert.equal(modelSection(s), MODEL_SECTION_WITH_REVIEW, `${s} Model Selection block must keep the whole-branch-review sentence`);
  }
  for (const s of ['brainstorm', 'plan', 'loop-engineer']) {
    assert.equal(modelSection(s), MODEL_SECTION_WITHOUT_REVIEW, `${s} Model Selection block must drop the whole-branch-review sentence`);
  }
});

test('SC7: the whole-branch-review sentence is absent in brainstorm/plan/loop-engineer and present in implement/review', () => {
  for (const s of ['brainstorm', 'plan', 'loop-engineer']) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
    assert.ok(!text.includes(WHOLE_BRANCH_REVIEW_SENTENCE), `${s} must not carry the whole-branch-review sentence`);
  }
  for (const s of ['implement', 'review']) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
    assert.ok(text.includes(WHOLE_BRANCH_REVIEW_SENTENCE), `${s} must carry the whole-branch-review sentence`);
  }
});

test('SC8: autopilot-protocol.md exists, is harness-neutral, and is named only under the drive: autopilot branch', () => {
  const protocolPath = join(skillsDir, 'implement', 'autopilot-protocol.md');
  assert.ok(existsSync(protocolPath), 'implement must ship autopilot-protocol.md');
  const protocol = readFileSync(protocolPath, 'utf8');
  assert.doesNotMatch(protocol, /CLAUDE_/, 'autopilot-protocol.md must be free of CLAUDE_* references');
  assert.doesNotMatch(protocol, /\/Users\/|\/home\/|~\//, 'autopilot-protocol.md must be free of machine-specific absolute paths');

  const skill = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const offenders = [];
  for (const para of skill.split(/\n\n+/)) {
    if (para.includes('autopilot-protocol.md') && !/drive:\s*autopilot/i.test(para)) {
      offenders.push(para.slice(0, 120));
    }
  }
  assert.deepEqual(offenders, [], 'autopilot-protocol.md may be named only under the drive: autopilot branch');
});

test('every reviewer prompt sets an explicit model tier (never a bare general-purpose dispatch)', () => {
  const prompts = [
    ['implement', 'task-reviewer-prompt.md'],
    ['implement', 'final-review-prompt.md'],
    ['loop-engineer', 'loop-final-review-prompt.md'],
  ];
  for (const [name, file] of prompts) {
    const text = readFileSync(join(skillsDir, name, file), 'utf8');
    const pattern = name === 'loop-engineer'
      ? /model:\s*\[MODEL_TIER\]/u
      : /model:\s*(cheap|standard|most-capable)\b/u;
    assert.match(text, pattern, `${name}/${file} must set an explicit controller-resolved model tier`);
  }
});

test('reviewer prompts use abstract tiers only — no concrete model ids (single alias source)', () => {
  // The tier vocabulary (cheap/standard/most-capable) is the canonical abstraction —
  // concrete model choice is deferred to dispatch time per harness (see the Model
  // Selection block in the workflow SKILLs, locked identical by the test above).
  // Reviewer prompts must reference tiers only, so a future model rename touches
  // nothing here.
  const prompts = [
    ['implement', 'task-reviewer-prompt.md'],
    ['implement', 'final-review-prompt.md'],
    ['loop-engineer', 'loop-final-review-prompt.md'],
  ];
  for (const [name, file] of prompts) {
    const text = readFileSync(join(skillsDir, name, file), 'utf8');
    assert.doesNotMatch(
      text,
      /\b(haiku|sonnet|opus)\b/,
      `${name}/${file} must not hardcode a concrete model id — use the abstract tier`
    );
  }
});

test('the four non-loop prompt templates keep the D1 harness-neutral dispatch conditional and drop general-purpose', () => {
  const prompts = [
    ['implement', 'implementer-prompt.md'],
    ['implement', 'task-reviewer-prompt.md'],
    ['implement', 'final-review-prompt.md'],
    ['discovery', 'explore-surface-prompt.md'],
  ];
  for (const [name, file] of prompts) {
    const text = readFileSync(join(skillsDir, name, file), 'utf8');
    assert.doesNotMatch(
      text,
      /general-purpose/,
      `${name}/${file} must not name the Claude-specific general-purpose agent type`
    );
    assert.match(
      text,
      /harness (provides|has) (a |no )?task(\/subagent)? tool/i,
      `${name}/${file} must gain the D1 harness-neutral dispatch conditional (mirrors T3/T4)`
    );
    assert.match(
      text,
      /otherwise|inline/i,
      `${name}/${file} must state the inline fallback for a harness with no task tool`
    );
    assert.match(
      text,
      /degradation/i,
      `${name}/${file} must state the degradation is recorded (ledger/run output)`
    );
    assert.doesNotMatch(
      text,
      /\/steepy-formula:/,
      `${name}/${file} must hand off to the next skill abstractly (e.g. "the \`review\` skill"), ` +
        'never via a hardcoded /steepy-formula: slash form — see T3/T4 SKILL.md handoff style'
    );
  }
});

test('loop prompt templates are controller-invoked role contracts with no inline-runner fallback', () => {
  for (const file of ['loop-implementer-prompt.md', 'loop-final-review-prompt.md']) {
    const text = readFileSync(join(skillsDir, 'loop-engineer', file), 'utf8');
    assert.match(text, /packaged deterministic controller/i);
    assert.doesNotMatch(text, /otherwise run .* inline|perform .* yourself inline/i);
    assert.doesNotMatch(text, /general-purpose/);
    assert.doesNotMatch(text, /\/steepy-formula:/);
  }
});

function sectionBetween(text, startHeading, endHeading) {
  const s = text.indexOf(startHeading);
  assert.ok(s !== -1, `missing heading '${startHeading}'`);
  const e = endHeading ? text.indexOf(endHeading, s + startHeading.length) : -1;
  return e === -1 ? text.slice(s) : text.slice(s, e);
}

// Content-contract checks, NOT a runtime manual parser or proof of model obedience.
function contractRows(text, heading) {
  const section = sectionBetween(text, heading);
  const table = section.match(/^\| .*(?:\n\|.*)*/m)?.[0];
  assert.ok(table, `missing contract table: ${heading}`);
  return table.split('\n').filter((line) => line.startsWith('| '))
    .slice(2).map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
}

function assertRegularReviewBumpFixture(fixture) {
  assert.deepEqual(Object.keys(fixture.inputs), ['criteria', 'task-results', 'branch-diff']);
  assert.ok(!('spec' in fixture.inputs), 'regular-review bump fixtures must not gain a full spec');
  const explicitBreakingEvidence = [
    /Release impact:\s*breaking change/i.test(fixture.inputs.criteria),
    /signals:\s*[^\n;]*\brelease:breaking\b/i.test(fixture.inputs['task-results']),
    /^\+.*BREAKING CHANGE:/im.test(fixture.inputs['branch-diff']),
  ];
  const derivedAction = explicitBreakingEvidence.every(Boolean) ? 'major' : 'ask-human';
  assert.equal(fixture.declaredAction, derivedAction);
}

test('manual publication contract covers each exact resume capability and every interruption prefix', () => {
  const expectedRoutes = [
    ['plan', 'spec', 'output-plan', 'none', 'brainstorm', 'plan', 'implement'],
    ['implement-2-direct', 'spec', 'task-results', 'progress-ledger', 'brainstorm', 'implement', 'none'],
    ['implement-2-plan', 'plan', 'task-results', 'source-spec,progress-ledger', 'plan', 'implement', 'none'],
    ['implement-3', 'plan', 'task-results', 'source-spec,progress-ledger', 'plan', 'implement', 'review'],
    ['review-3', 'task-results', 'review-report', 'criteria,branch-diff', 'implement', 'review', 'none'],
  ];
  const allowed = new Map([
    ['READY/absent', 'fresh-create'], ['READY/DRAFT', 'resume-work'],
    ['READY/READY', 'finish-consumption'], ['CONSUMED/READY', 'no-op'],
  ]);
  const expectedStates = [];
  for (const input of ['absent', 'DRAFT', 'READY', 'CONSUMED']) {
    for (const output of ['absent', 'DRAFT', 'READY', 'CONSUMED']) {
      expectedStates.push([input, output, allowed.get(`${input}/${output}`) ?? 'reject']);
    }
  }
  for (const name of ['brainstorm', 'plan', 'implement', 'review', 'loop-engineer']) {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    assert.deepEqual(contractRows(text, '### Exact publication pairs'), expectedRoutes, name);
    assert.deepEqual(contractRows(text, '### Publication interruption prefixes'), expectedStates, name);
    const common = sectionBetween(text, '## Manual handoff envelope', '<!-- steepy:manual-handoff:v1:end -->');
    assert.match(common, /output\.source[^]*input path[^]*input\.consumed-by[^]*output path/i);
    assert.match(common, /before[^]*fresh-only READY[^]*gate/i);
    assert.match(common, /finish-consumption[^]*revalidate[^]*approval[^]*verification[^]*only[^]*input-consumption/i);
    assert.match(common, /no-op[^]*revalidate[^]*no[^]*redispatch/i);
    assert.match(common, /missing[^]*capabilit[^]*mismatch[^]*fail closed/i);
    assert.match(common, /manual drive you are the enforcement: no parser, manifest, or validator checks this contract/i);
  }
});

test('phase-local entry and publication rules admit only verified exact-pair recovery', () => {
  for (const [name, role] of [['plan', 'output-plan'], ['implement', 'task-results'], ['review', 'review-report']]) {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
    assert.ok(step0.includes(`onDemand.${role}`), `${name} resume explicitly binds its output`);
    assert.match(step0, /before[^]*fresh-only[^]*gate/i, name);
    assert.match(step0, /CONSUMED[^]*READY[^]*no-op/i, name);
    assert.match(step0, /READY[^]*READY[^]*finish-consumption/i, name);
  }
  const review = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step4 = sectionBetween(review, '### Step 4', '### Step 5');
  assert.match(step4, /phase: review\nstatus: DRAFT\nnext: none\nsource: <task-result-index-path>\nconsumed-by: none/);
  assert.match(step4, /first[^]*report[^]*`status: READY`[^]*then[^]*index[^]*`status: CONSUMED`/i);
  assert.doesNotMatch(readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8'), /Perform both edits together/i);
  for (const name of ['plan', 'implement']) {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    assert.match(text, /record[^]*approval[^]*verification[^]*before[^]*READY/i, name);
  }
});

test('fresh brainstorm derives coverage and ratifies every gear without historical work reads', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /fresh entry[^]*human request[^]*stable[^]*repository/i);
  assert.match(step0, /no[^]*historical[^]*spec[^]*log[^]*verdict/i);
  assert.doesNotMatch(step0, /Read the verdict artifact[^]*spec head|Artifact absent and full gear-3|upstream workflow chain first/i);
  assert.match(step0, /Gear 3[^]*valid[^]*fresh entry/i);
  const step1 = sectionBetween(text, '### Step 1 —', '### Step 1.5');
  assert.doesNotMatch(step1, /Read the owning surface standard `\.apex\/standards\/<surface>\.md`/i);
  const step4 = sectionBetween(text, '### Step 4 —', '### Step 5 —');
  assert.ok(/existing target[^]*stop[^]*no[^]*read[^]*overwrite/i.test(step4), 'fresh brainstorm must not reuse a historical draft');
});

test('publication preflight refuses existing unbound review output before collection and guards unconsumed links', () => {
  const review = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(review, '### Step 0', '### Ceremony');
  assert.ok(/existing[^]*report[^]*without[^]*capability[^]*stop[^]*before[^]*collection/i.test(step0));
  for (const name of ['brainstorm', 'plan', 'implement', 'review', 'loop-engineer']) {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const common = sectionBetween(text, '## Manual handoff envelope', '<!-- steepy:manual-handoff:v1:end -->');
    assert.ok(/unconsumed input[^]*consumed-by: none/i.test(common), name);
  }
  const workflow = readFileSync(join(root, 'docs/workflow.md'), 'utf8');
  assert.doesNotMatch(workflow, /chain skills read the gear from the spec's verdict header|review time[^\n]*against the local spec\/plan/i);
});

test('terminal resume shortcuts retain gear and supporting-input provenance checks', () => {
  const implement = sectionBetween(readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8'), '### Step 0', '### Ceremony');
  assert.ok(/every resume[^]*gear[^]*phase[^]*next[^]*before[^]*terminal shortcut/i.test(implement));
  const review = sectionBetween(readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8'), '### Step 0', '### Ceremony');
  assert.ok(/every resume[^]*criteria[^]*branch.diff[^]*metadata[^]*content[^]*before[^]*terminal shortcut/i.test(review));
});

test('regular review derives release proposals only from criteria, compact index and diff', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5', '## Model Selection');
  assert.match(step5, /derive[^]*bump type[^]*criteria[^]*task-result index[^]*branch diff/i);
  assert.doesNotMatch(step5, /derive[^\n]*from the spec/i);
  assert.match(step5, /insufficient[^]*ask[^]*human[^]*no[^]*spec[^]*read/i);
  assert.match(step5, /Ask one confirmation question/);
});

test('regular-review bump fixtures use only authorized inputs for major or human clarification', () => {
  const breakingChange = {
    inputs: {
      criteria: 'SC1: Existing clients receive a migration path. Release impact: breaking change.',
      'task-results': '- Task 1: DONE; artifact: task-1-report.md; changed-paths: src/api.mjs; signals: release:breaking',
      'branch-diff': '- oldApi(request)\n+ newApi(request)\n+ BREAKING CHANGE: remove oldApi',
    },
    declaredAction: 'major',
  };
  const insufficientEvidence = {
    inputs: {
      criteria: 'SC1: Update the public behavior.',
      'task-results': '- Task 1: DONE; artifact: task-1-report.md; changed-paths: src/api.mjs; signals: none',
      'branch-diff': '+ adjust behavior',
    },
    declaredAction: 'ask-human',
  };
  assertRegularReviewBumpFixture(breakingChange);
  assertRegularReviewBumpFixture(insufficientEvidence);

  const missingDiff = structuredClone(breakingChange);
  delete missingDiff.inputs['branch-diff'];
  assert.throws(() => assertRegularReviewBumpFixture(missingDiff));

  const wrongUpstreamInput = structuredClone(breakingChange);
  wrongUpstreamInput.inputs.spec = '# Full spec (unauthorized)';
  assert.throws(() => assertRegularReviewBumpFixture(wrongUpstreamInput));

  const weakenedEvidence = [
    ['criteria', 'SC1: Existing clients receive a documented migration path.'],
    ['task-results', '- Task 1: DONE; artifact: task-1-report.md; changed-paths: src/api.mjs; signals: none'],
    ['branch-diff', '- oldApi(request)\n+ newApi(request)'],
  ];
  for (const [role, replacement] of weakenedEvidence) {
    const mutation = structuredClone(breakingChange);
    mutation.inputs[role] = replacement;
    assert.throws(() => assertRegularReviewBumpFixture(mutation), `${role} evidence must affect derivation`);
  }

  const wrongBump = structuredClone(breakingChange);
  wrongBump.declaredAction = 'minor';
  assert.throws(() => assertRegularReviewBumpFixture(wrongBump));

  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5', '## Model Selection');
  assert.match(step5, /breaking change[^]*`major`/i);
  assert.match(step5, /evidence is insufficient[^]*ask the human/i);
  assert.match(step5, /no spec, plan, ledger, or per-task report read is authorized/i);
});

test('unplanned discovery has an explicit signal preserved through the compact task index', () => {
  const prompt = readFileSync(join(skillsDir, 'implement', 'implementer-prompt.md'), 'utf8');
  assert.match(prompt, /discover[^]*DONE_WITH_CONCERNS[^]*discovery:unplanned/i);
  for (const file of ['SKILL.md', 'autopilot-protocol.md']) {
    const text = readFileSync(join(skillsDir, 'implement', file), 'utf8');
    assert.match(text, /preserve[^]*discovery:unplanned[^]*task-result index/i, file);
    assert.match(text, /ordinary concerns[^]*not[^]*discovery/i, file);
  }
  const review = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const expected = [
    ['DONE_WITH_CONCERNS', 'discovery:unplanned', 'unplanned-discovery'],
    ['DONE_WITH_CONCERNS', 'other-or-none', 'ordinary-or-unattributed-concern'],
    ['DONE', 'discovery:unplanned', 'inconsistent-result'],
    ['DONE', 'other-or-none', 'no-discovery-evidence'],
  ];
  assert.deepEqual(contractRows(review, '### Discovery signal interpretation'), expected);
  assert.match(review, /never infer discovery[^]*DONE_WITH_CONCERNS alone/i);
  // Formula adaptation (apex v1.2.0 port): apex also reads `.apex/standards/skills.md` and
  // `.apex/conventions.md` here. That Markdown hub is archived; those halves ride the canonical
  // graph promotion, and the shipped docs half stays locked.
  for (const path of ['docs/workflow.md']) {
    const stable = readFileSync(join(root, path), 'utf8');
    assert.ok(stable.includes('discovery:unplanned'), path);
    assert.match(stable, /output[^]*READY[^]*input[^]*CONSUMED/i, path);
  }
});

test('downstream plan and implement read only the accepted artifact gear at Step 0', () => {
  for (const s of ['plan', 'implement']) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
    assert.match(text, /### Step 0 — Read the gear/, `${s} must have a Step 0 gear-read step`);
    assert.match(text, /verdict artifact/i, `${s} Step 0 must reference the verdict artifact`);
    if (s === 'implement') assert.match(text, /accepted plan's contract metadata/i, 'implement takes gear from the accepted plan contract');
    else assert.match(text, /`\.formula\/work\/`/, `${s} Step 0 must locate the verdict artifact under .formula/work/`);
    assert.match(text, /gear-1\/2 work/i, `${s} Step 0 must branch on artifact-absent gear-1/2 recompute`);
    assert.match(text, /recompute the coverage verdict inline/i, `${s} Step 0 must recompute the verdict inline when the artifact is absent for gear-1/2 work`);
    assert.match(text, /do not proceed\s+blind/i, `${s} Step 0 must refuse to proceed blind when full gear-3 ceremony is required and the artifact is absent`);
    assert.match(text, /### Ceremony by gear/, `${s} must have a "Ceremony by gear" subsection`);
    const step0Idx = text.indexOf('### Step 0 — Read the gear');
    const step1Idx = text.indexOf('### Step 1');
    assert.ok(step0Idx !== -1 && step1Idx !== -1 && step0Idx < step1Idx, `${s} Step 0 must precede Step 1`);
  }
});
test('brainstorm, plan, implement: Step 0 bounces gear-4 work to the abstract loop-engineer skill, Ceremony declares it', () => {
  for (const s of ['brainstorm', 'plan', 'implement']) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
    const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
    assert.match(
      step0,
      /gear\W{0,3}4[\s\S]*?`loop-engineer` skill/i,
      `${s} Step 0 must bounce an artifact present with gear 4 to the abstract \`loop-engineer\` skill`
    );
    assert.doesNotMatch(
      step0,
      /\/steepy-formula:/,
      `${s} Step 0 must not use a Claude-only namespaced slash invocation`
    );
    const ceremony = sectionBetween(text, '### Ceremony by gear', '### Step 1');
    assert.match(
      ceremony,
      /Gear 4[\s\S]{0,200}`loop-engineer` skill/i,
      `${s} Ceremony by gear must carry a Gear 4 line bouncing to the abstract \`loop-engineer\` skill`
    );
  }
});

test('review: Step 0/Ceremony accepts gear 4 — verifier re-run + loop ledger as evidence, alongside self-verify', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const section = sectionBetween(text, '### Step 0', '### Step 1');
  assert.match(section, /Gear 4/, 'review must address gear 4 in Step 0/Ceremony');
  assert.match(section, /verifier/i, 'review gear-4 verification must re-run the verifier from the goal contract');
  assert.match(section, /ledger/i, 'review gear-4 verification must cite the loop ledger as evidence');
  assert.match(section, /self-verif/i, 'review gear-4 verification sits alongside the existing self-verify, not replacing it');
});

test('review: Steps 1-2 wire Gear 4 through exact goal + ledger capabilities and verifier evidence', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step1, /accepted goal and loop-ledger paths/);
  assert.match(step1, /loop ledger is primary/i);
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /Gear 4/, 'Step 2 must carry a gear-4 verification branch');
  assert.match(step2, /verifier/i, 'Step 2 gear-4 verification must re-run the verifier as the criterion');
  assert.match(step2, /boolean[\s\S]{0,120}metric|metric[\s\S]{0,120}boolean/i, 'Step 2 gear-4 verification must branch on the mode');
  assert.match(step1, /public capability[^]*exactly[^]*goal[^+]*\+[^]*loop-ledger/i,
    'Gear-4 review must preserve the exact public goal+ledger capability');
  assert.match(step1, /--validate-terminal --goal '<goal-path>' --ledger '<loop-ledger-path>'/i,
    'Gear-4 review must invoke the deterministic terminal validator');
  assert.match(step1, /derives[^]*`events\.jsonl`[^]*internally[^]*recomputes[^]*events-sha256/i,
    'the controller must derive and authenticate its private event source');
  assert.match(step1, /read-only[^]*zero[^]*(?:lifecycle|Git)[^]*mutation/i,
    'terminal validation must remain read-only');
  assert.match(step1, /closed bounded\s+receipt[^]*branch-review[^]*attempt-budget/i,
    'review must consume exact controller facts from a bounded receipt');
  assert.doesNotMatch(step1, /canonical SHA-256 syntax is required/i,
    'syntax-only digest checks are not evidence');
  assert.match(step2, /surface test[^]*goal verifier[^]*coherence-gate/i,
    'Gear-4 evidence capture must retain the bounded surface-test → verifier → hub-gate order');
});

test('review: manual entry is capability-bounded and fails closed without artifact discovery', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step0, /manual handoff[^]*accepts exactly[^]*criteria[^]*task-results[^]*branch-diff/i);
  assert.match(step0, /pathless recovery[^]*(?:headers only|header-only)[^]*task-result index(?:es)?[^]*require[^]*selection/i);
  assert.match(step0, /explicit[^]*(?:malformed|stale|failure)[^]*never[^]*fall(?:s)? back/i);
  assert.match(step1, /eagerly read[^]*exactly[^]*criteria[^]*task-results[^]*branch-diff/i);
  assert.doesNotMatch(step1, /Identify the spec under review|most recent dated/);
  assert.match(step1, /Never locate or read the spec, plan, progress ledger/i);
  assert.match(step1, /task briefs/);
  assert.match(step1, /task[^]{0,30}reports/);
  assert.match(step1, /task[^]{0,30}reviews/);
  assert.match(step1, /sibling work files/);
});

test('review: regular evidence and terminal lifecycle use exact current-run capabilities', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.match(step2, /regular review[^]*`\.formula\/work\/tasks\/<plan-basename>\/evidence-report\.md`/i);
  assert.match(step2, /surface test[^]*optional goal verifier[^]*coherence gate/i);
  assert.match(step2, /receipt[^]*artifact path[^]*timestamps[^]*pass state/i);
  assert.doesNotMatch(step2, /\[TASK_DIR\]|per-task files under/);
  assert.match(step4, /criterion-by-criterion judgement[^]*review-report\.md/i);
  assert.match(step4, /task-result index/i);
  assert.match(step4, /`status: CONSUMED`/);
  assert.match(step4, /`consumed-by: <review-report-path>`/);
  assert.match(step4, /next: human[^]*required:\n\s+evidence: <review-report-path>\nonDemand: none/i);
  assert.match(step4, /human action/i);
});

test('loop-engineer: exact fresh/resume capabilities and lifecycle replace most-recent defaults', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Step 1');
  assert.match(step0, /fresh[^]*required[^]*goal[^]*onDemand: none/i);
  assert.match(step0, /resume[^]*onDemand[^]*loop-ledger/i);
  assert.match(step0, /pathless recovery[^]*(?:headers only|header-only)[^]*require[^]*selection/i);
  assert.doesNotMatch(step0, /default to the most recent/i);
  assert.match(step0, /phase: goal-contract[^]*status: READY[^]*next: loop-engineer/i);
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /fresh invocation/i);
  assert.match(step2, /resume invocation/i);
  assert.match(step2, /controller owns[^]*ledger[^]*lifecycle/i);
  assert.match(step2, /`HALTED`[^]*(?:permanently abandoned|not resumable)/i);
  assert.match(step2, /new[^]*ratified goal[^]*(?:distinct|new)[^]*(?:goal path|loop workspace)/i);
  assert.doesNotMatch(step2, /`HALTED`[^]*later exact resume handoff/i);
  const step5 = sectionBetween(text, '### Step 5', '## Model Selection');
  assert.match(step5, /controller[^]*validated terminal[^]*exact returned[^]*goal[^]*loop-ledger/i);
  assert.doesNotMatch(step5, /goal[^]*CONSUMED|loop ledger[^]*READY/i);
  assert.match(step5, /required:\n\s+goal: <goal-path>\n\s+loop-ledger: <loop-ledger-path>\nonDemand: none/i);
});

test('loop-engineer: Gear-4 handoff emits known native review invocation beside canonical envelope', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5', '## Model Selection');
  assert.match(step5, /active harness[^]*native[^]*review invocation[^]*when known/i);
  assert.match(step5, /(?:unknown|unavailable)[\s\S]*do not[\s\S]*invent syntax/i);
  assert.match(step5, /handoff: steepy-formula\/v1\nnext: review\nrequired:\n\s+goal: <goal-path>\n\s+loop-ledger: <loop-ledger-path>\nonDemand: none/);
});

test('review: terminal human handoff emits no subsequent skill invocation', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.match(step4, /next: human[^]*required:\n\s+evidence: <review-report-path>\nonDemand: none/i);
  assert.match(step4, /emit no native skill invocation/i);
});

test('review: Gear-4 review validates provenance and consumes only after terminal evidence', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /default to the most recent/i);
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step1, /loop ledger[^]*primary/i);
  assert.match(step1, /goal[^]*status: CONSUMED[^]*consumed-by[^]*loop-ledger/i);
  assert.match(step1, /terminal validator[^]*events[^]*sole authority/i);
  assert.match(step1, /receipt[^]*branch-review[^]*verdict[^]*issues-found/i);
  assert.match(step1, /receipt[^]*attempt-budget[^]*reserved[^]*budget[^]*exhausted/i);
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.match(step4, /write[^]*terminal review report[^]*before[^]*ledger[^]*status: CONSUMED/i);
});

test('review: Gear-4 terminal review judges each claimed outcome without calling negative completion success', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');

  assert.match(step2, /`GOAL_REACHED`[^]*boolean[^]*green[^]*metric[^]*strict\s+improvement[^]*approved branch review/i);
  assert.match(step2, /`BUDGET_EXHAUSTED`[^]*red boolean verifier[^]*full budget spent/i);
  assert.match(step2, /`NO_IMPROVEMENT`[^]*reproduced metric baseline[^]*no strict improvement/i);
  assert.match(step2, /`REVIEW_REJECTED`[^]*boolean[^]*green[^]*metric[^]*strict\s+improvement[^]*never[^]*(?:red|equal)[^]*unresolved\s+review issues[^]*no remaining mutation budget/i);
  assert.match(step2, /red verifier[^]*not[^]*invalid execution/i);
  assert.match(step4, /faithfully proven negative outcome[^]*approved terminal review[^]*not goal\s+success/i);
  assert.match(step4, /consume[^]*READY[^]*loop ledger[^]*review-report\.md/i);
  assert.match(step4, /negative outcome[^]*(?:suppress|no)[^]*(?:release|PR)/i);
  assert.match(step4, /new goal contract[^]*another run/i);
});

test('review capture and loop prompts preserve bounded role-local access', () => {
  const review = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(review, '### Step 2', '### Step 3');
  assert.match(step2, /Resolve the current output path from the accepted primary\s+artifact, never by directory discovery/i);
  assert.match(step2, /never fall back to a whole-file read/i);
  for (const file of ['loop-implementer-prompt.md', 'loop-final-review-prompt.md']) {
    const prompt = readFileSync(join(skillsDir, 'loop-engineer', file), 'utf8');
    assert.match(prompt, /exact role-local|only the exact/i);
    assert.match(prompt, /do not[^]*explore[^]*\.formula\/work/i);
  }
});

test('brainstorm, plan, implement, review: the inline-recompute branch ratifies the gear with the user (identical sentence)', () => {
  const ratificationSentences = [];
  for (const s of ['brainstorm', 'plan', 'implement', 'review']) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
    const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
    assert.match(step0, /confirm/i, `${s} Step 0 inline-recompute branch must ask the user to confirm the recomputed gear`);
    assert.match(
      step0,
      /force|override/i,
      `${s} Step 0 inline-recompute branch must let the user force a different gear, recorded as an override`
    );
    const sentenceMatch = step0.match(/Declare the recomputed\s+verdict[\s\S]*?Then\s+proceed\./);
    assert.ok(sentenceMatch, `${s} Step 0 must contain the ratification sentence verbatim`);
    ratificationSentences.push(sentenceMatch[0]);
  }
  const [first, ...rest] = ratificationSentences;
  for (const sentence of rest) {
    assert.equal(sentence, first, 'the ratification sentence must be byte-identical across all four chain skills');
  }
});

test('brainstorm: ceremony scales by gear, Step 7 human gate gated to gear 3', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  assert.match(text, /Gear 1[\s\S]{0,300}produce NO spec/i, 'gear 1 must produce no spec');
  assert.match(text, /Gear 2[\s\S]{0,300}skip Step 7/i, 'gear 2 must skip Step 7');
  const step7 = sectionBetween(text, '### Step 7', '### Step 8');
  assert.match(step7, /Gear 3 only/i, 'Step 7 reviewer must be gated to gear 3 only');
});

test('plan: ceremony scales by gear, Step 6 human gate gated to gear 3', () => {
  const text = readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf8');
  assert.match(text, /Gear 1[\s\S]{0,300}no plan needed/i, 'gear 1 needs no plan');
  assert.match(text, /Gear 2[\s\S]{0,300}skip only the human\s+question in Step 6[\s\S]{0,160}shared lifecycle transition/i,
    'gear 2 must skip only the human question and still complete the shared lifecycle transition');
  const step6 = sectionBetween(text, '### Step 6', '### Step 7');
  assert.match(step6, /Gear 3 only/i, 'Step 6 reviewer must be gated to gear 3 only');
});

test('implement: ceremony scales by gear, task + whole-branch reviewers gated to gear 3, refuses gear-3 entry with no upstream artifact', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  assert.match(text, /Gear 1[\s\S]{0,300}not an implement entry/i, 'gear 1 is not an implement entry point');
  assert.match(text, /Gear 2[\s\S]{0,400}skip the\s+Step 3\.4 task reviewer and the Step 4 whole-branch review/i,
    'gear 2 must skip both the Step 3.4 task reviewer and the Step 4 whole-branch review');
  assert.match(text, /Gear-3 refuse rule[\s\S]{0,300}refuse[\s\S]{0,200}upstream workflow chain/i,
    'gear-3 entry with no upstream artifact must be refused and bounced to the upstream workflow chain');
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');
  assert.match(step3, /Gear 3 only/i, 'Step 3 task-reviewer sub-step must be gated to gear 3 only');
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.match(step4, /Gear 3 only/i, 'Step 4 whole-branch review must be gated to gear 3 only');
});

test('implement: task-reviewer is conditional on non-mechanical tasks, final review always', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');
  assert.match(step3, /mechanical|transcription/i, 'per-task review must be skippable for mechanical tasks');
  assert.match(step3, /judgement|judgment/i, 'per-task review runs for tasks that carry judgement');
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.match(step4, /Gear 3 only/i, 'the whole-branch review stays gear-3');
});

test('implement: Step 3 derives dispatch tier + skip-reviewer from plan Complexity, ledger records model/review/escalation', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');

  // 1. dispatch tier derived from the plan's Complexity line
  assert.ok(
    step3.includes(
      "Pick the model from the task's `Complexity` line: mechanical → cheap, integration → standard, design → most-capable"
    ),
    'Step 3 dispatch must derive the tier from Complexity (mechanical → cheap, integration → standard, design → most-capable)'
  );

  // 2. an override must carry a reason recorded in the ledger
  assert.ok(
    step3.includes('To override, record a one-line reason in the ledger'),
    'an override must carry a one-line reason recorded in the ledger'
  );
  assert.ok(
    step3.includes("If the plan has no `Complexity` lines, classify the task yourself at dispatch"),
    'a plan without Complexity lines must fall back to classifying at dispatch time'
  );

  // 3. Step 3.4 reads the same Complexity field for the skip-reviewer decision
  assert.ok(
    step3.includes(
      "the task's `Complexity` line decides: `integration`/`design` → review, `mechanical` → skip"
    ),
    'Step 3.4 review/skip decision must be anchored to the plan Complexity field'
  );

  // 4. ledger line format uses abstract tiers (no vendor model ids) and records a review outcome
  assert.ok(
    step3.includes('`Task N: complete (model: standard, review: 1 iteration, commits <base7>..<head7>)`'),
    'ledger example must show an abstract model tier and review: N iteration(s) alongside a commit range'
  );
  assert.ok(
    step3.includes('`Task N: complete (model: cheap, review: skipped (mechanical), no commit)`'),
    'ledger example must show an abstract model tier and review: skipped (mechanical) with no commit'
  );
  assert.doesNotMatch(
    step3,
    /\b(haiku|sonnet|opus)\b/,
    'Step 3 must not name a concrete vendor model — abstract tiers only'
  );

  // 4b. ledger records the no-per-dispatch-choice case and any degradation exercised (D1/D2)
  assert.ok(
    step3.includes('session model'),
    'ledger recording must cover the harness with no per-dispatch model choice (session model)'
  );
  assert.match(
    step3,
    /inline impl(ementation)?[\s\S]{0,80}same-session review/i,
    'ledger recording must note degradations exercised (inline implementation + same-session review pass)'
  );

  // 5. a BLOCKED escalation is recorded on the task's ledger line
  assert.ok(
    step3.includes("add `escalated: <from>→<to>` to the task's ledger line"),
    'a BLOCKED escalation must be recorded on the ledger line as escalated: <from>→<to>'
  );
});

test('implement: gains an autopilot branch — Step 0 note, Step 2 Autopilot paragraph (drive/commit-auth/BLOCKED), Step 5 appends DONE to status file', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  const protocol = readFileSync(join(skillsDir, 'implement', 'autopilot-protocol.md'), 'utf8');

  assert.match(protocol, /drive:\s*autopilot/i, 'autopilot-protocol.md must mention drive: autopilot');
  assert.match(protocol, /BLOCKED/i, 'autopilot-protocol.md must mention BLOCKED for autopilot runs');
  assert.match(protocol, /autopilot-status\.md/, 'autopilot-protocol.md must reference autopilot-status.md');
  assert.match(protocol, /\*\*Autopilot:\*\*/, 'autopilot-protocol.md must carry an Autopilot paragraph');
  assert.match(protocol, /commit-auth/i, 'autopilot-protocol.md must mention commit-auth');
  assert.match(protocol, / — implement — DONE — /, 'autopilot-protocol.md must describe appending " — implement — DONE — " to the status file');

  const step2 = sectionBetween(text, '### Step 2 — Confirm branch and authorize commits', '### Step 2.5');
  // existing manual-path text stays intact
  assert.match(step2, /Check the current branch \(`git branch --show-current`\)\./, 'Step 2 manual-path branch check must remain intact');
  assert.match(step2, /Then ask: \*\*"Commit after each reviewed-clean task this run\?"\*\*/, 'Step 2 manual-path commit question must remain intact');
});

test('autopilot phase skills: status markers preserve the four-field protocol and carry only conductor-supplied correlated identity', () => {
  for (const [name, terminal] of [['plan', 'DONE'], ['implement', 'DONE'], ['review', 'READY_FOR_PR']]) {
    const text = name === 'implement'
      ? readFileSync(join(skillsDir, 'implement', 'autopilot-protocol.md'), 'utf8')
      : readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    assert.match(text, /phasePrompt[\s\S]{0,220}authoritative/i, `${name} must treat phasePrompt identity as authoritative`);
    assert.match(text, /do not derive[\s\S]{0,100}(?:filename|filenames)/i, `${name} must not derive identity from filenames`);
    assert.match(text, /do not invent/i, `${name} must not invent correlation identity`);
    assert.match(text, /run-id=<conductor-supplied>[\s\S]{0,80}attempt=<positive supplied>/i, `${name} status examples must echo supplied run-id and positive attempt`);
    assert.match(text, new RegExp(` — ${name} — ${terminal} — run-id=<conductor-supplied> attempt=<positive supplied>`), `${name} completion marker must keep identity in the note field`);
    assert.match(text, /without supplied run\/attempt identity[\s\S]{0,220}exit non-zero without appending/i, `${name} must block uncorrelated children without writing a new-protocol marker`);
    assert.match(text, /Only versioned, correlated status is supported; uncorrelated markers never complete a phase/i, `${name} must prohibit uncorrelated completion markers`);
  }
});

test('implement: has a pre-flight input-conflict scan before the per-task loop', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'SKILL.md'), 'utf8');
  assert.match(text, /### Step 2\.5 — Pre-flight input scan/, 'must add a Step 2.5 pre-flight scan');
  const step25 = sectionBetween(text, '### Step 2.5', '### Step 3');
  assert.match(step25, /one batched question|batch/i, 'pre-flight conflicts must be batched into one question');
  assert.match(step25, /direct Gear-2[^]*one[^]*independently testable task[^]*optional plan/i,
    'direct Gear-2 ambiguity must stop before mutation and route to the optional plan');
  const i25 = text.indexOf('### Step 2.5');
  const i3 = text.indexOf('### Step 3 —');
  assert.ok(i25 !== -1 && i3 !== -1 && i25 < i3, 'Step 2.5 must precede the per-task loop');
});

test('review: ceremony self-verifies across all gears, no Step 3b subagent', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /### Step 3b/, 'the Step 3b evidence-reviewer sub-step must be removed');
  const ceremony = sectionBetween(text, '### Ceremony by gear', '### Step 1');
  assert.match(ceremony, /All gears/i, 'ceremony must self-verify across all gears');
  assert.match(ceremony, /self-verif/i, 'ceremony must state the review self-verifies');
});

// v0.11.0 port: the delegable collector is gone — evidence collection is the deterministic
// inline capture, and the collection/judgement split becomes the disk/receipt boundary.
test('review: inline evidence capture and in-session judgement are locked across the protocol', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');

  const checklist = sectionBetween(text, '## Checklist', '## Procedure');
  assert.match(checklist, /Run `capture-review-evidence\.mjs` once/i);
  assert.match(checklist, /verbatim command output[^]*`evidence-report\.md`/i);
  assert.match(checklist, /compact JSON receipt[^]*judge every criterion in\s+session/i);

  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /dispatches \*\*no\s+subagent reviewer or evidence collector\*\*/i);
  assert.match(step0, /inline and deterministically/i);
  assert.match(step0, /Judgement is never delegated/i);

  const ceremony = sectionBetween(text, '### Ceremony by gear', '### Step 1');
  assert.match(ceremony, /deterministic inline\s+capture/i);
  assert.match(ceremony, /complete command bytes[^.]*durable on disk/i);
  assert.match(ceremony, /only the bounded receipt\s+enters model context/i);
  assert.match(ceremony, /Verification and judgement are never delegated, at any gear/i);
  assert.doesNotMatch(ceremony, /dispatch[^.]*collector/i);
});

// Promotion-in-chain pins (Tasks 4-5 prose, task 6): the hub-mode declaration and the Promotion
// Scenario contracts. SC1/SC2/SC7 (review), SC3/SC5/SC8 (brainstorm), SC4 (both skills).

test('review: Step 2 assembles the Promotion Scenario — typed candidates file, promotion create + preview, typed diff in the report', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /\*\*The sweep assembles the Promotion Scenario\.\*\*/,
    'Step 2 must carry the scenario-assembly branch');
  assert.ok(step2.includes('.formula/work/tasks/<plan-basename>/promotion-candidates.json'),
    'the sweep must write the typed candidates file at the canonical plan-directory path');
  assert.ok(step2.includes('steepy-formula promotion create --project <id> --candidates <file.json> [--proposer <name>] <scenario-id>'),
    'assembly must create the scenario via promotion create');
  assert.ok(step2.includes('steepy-formula promotion preview <scenario-id>'),
    'assembly must preview via the binding-resolved promotion preview — no --project flag, matching the other skills');
  assert.doesNotMatch(step2, /promotion preview --project/,
    'the preview must resolve the project from the persisted binding, never a --project flag');
  assert.match(step2, /Quote the preview's typed diff verbatim into the\s+Step 4 report/,
    'the preview typed diff must be quoted verbatim into the Step 4 report');
  assert.match(step2, /apply nothing here: Step 5 owns the apply/,
    'Step 2 must apply nothing — Step 5 owns the apply');
  assert.match(step2, /Durable knowledge rides the Promotion Scenario/,
    'the durable-knowledge check must name the scenario as the promotion channel');
  assert.match(step2, /\(term, rule, decision, readme\)/,
    'the sweep triage lists the graph kinds');
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.match(step4, /quotes the Step 2 `promotion preview` typed diff verbatim/,
    'the Step 4 report must quote the Step 2 promotion preview typed diff verbatim');
});

// Apex v1.0.6 port: the undefined "gate 8" became the Step 5 version-bump/PR decision; the
// graph-mode no-scenario ruling now names that interactive Step 5 session.
test('review: autopilot review creates NO scenario — typed candidates listed for the Step 5 human', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step2 = sectionBetween(text, '### Step 2', '### Step 3');
  assert.match(step2, /Autopilot review creates NO scenario/,
    'autopilot review must create no Promotion Scenario');
  assert.match(step2, /PROMOTION_STALE/,
    'the no-scenario ruling must be justified by the PROMOTION_STALE draft state');
  assert.match(step2, /List the typed candidates — same schema, as report entries — and nothing more/,
    'autopilot must list the typed candidates as report entries, nothing more');
  assert.match(step2, /the interactive Step 5 session creates, previews, and applies when the human acts/,
    'create/preview/apply belongs to the interactive Step 5 session');
  assert.doesNotMatch(text, /gate[- ]8/i, 'the undefined gate-8 name must not return');
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.match(step4, /No scenario was created at Step 2/,
    'the Step 4 autopilot report must reaffirm that no scenario was created');
});

test('review: Step 3 coherence gate is the receipt-gated graph validate + sanity context resolve', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step3 = sectionBetween(text, '### Step 3', '### Step 4');
  assert.match(step3, /The Step 2 capture runs the coherence gate as its final command/i,
    'the gate must ride the Step 2 capture receipt, not a separate collection');
  assert.match(step3, /require the current receipt's final command to have `label: coherence-gate`/,
    'review must gate on the receipt coherence-gate command');
  assert.match(step3, /its bounded excerpt showing `violations: 0` and a clean revision-chain replay/,
    'the graph gate excerpt must bind violations: 0 and a clean chain');
  assert.match(step3, /plus one sanity\s+`steepy-formula context resolve` of a representative path or target/i,
    'review must add a sanity context resolve of a representative path or target');
  assert.doesNotMatch(step3, /\*\*(?:Legacy|Graph) mode:\*\*|validate-hub|Mode `none`/,
    'Step 3 carries no mode branches');
});

test('review: Step 0 declares the hub mode via steepy-formula hub-mode — the prose never re-implements detection', () => {
  const text = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0', '### Ceremony');
  assert.match(step0, /Run `steepy-formula hub-mode` before anything else/,
    'Step 0 must invoke steepy-formula hub-mode before anything else');
  assert.match(step0, /always exits 0/,
    'the declaration must state the command always exits 0 — a declaration, not a gate');
  assert.match(step0, /this prose never\s+re-implements its detection — the command is the single authority/,
    'the prose must never re-implement the mode detection');
  assert.match(step0, /`graph`, `migrate`, or `none`/, 'Step 0 declaration lists exactly graph, migrate, none');
  const migrateBullet = step0.match(/- \*\*`migrate` mode:\*\*[\s\S]*?(?=\n- \*\*|\n\n)/)?.[0];
  assert.ok(migrateBullet, 'Step 0 must carry the migrate stop bullet');
  assert.match(migrateBullet,
    /Stop and tell the user to run the `graph-migrate` skill \(invoke it the way your harness invokes skills\) before any other workflow\./,
    'the migrate bullet carries the exact stop sentence');
  const noneBullet = step0.match(/- \*\*Mode `none`:\*\*[\s\S]*?(?=\n- \*\*|\n\n)/)?.[0];
  assert.ok(noneBullet, 'Step 0 must carry the mode none stop bullet');
  assert.match(noneBullet, /`init` skill/, 'mode none names the init skill');
  assert.doesNotMatch(step0, /`legacy`|\blegacy\b|validate-hub/i, 'Step 0 carries no legacy branch');
  const declaration = step0.match(/\*\*Hub-mode declaration \(once per run\)\.\*\*[\s\S]*?(?=\n\n)/)?.[0] ?? '';
  assert.ok(declaration, 'Step 0 must carry the hub-mode declaration paragraph');
  assert.doesNotMatch(declaration, /initialized:/,
    'the declaration must not read the engine facts initialized: field itself');
  assert.doesNotMatch(declaration, /_INDEX\.md/,
    'the declaration must not probe .apex/_INDEX.md existence to detect the mode');
});

test('brainstorm: NEVER mutates the hub — every delta is a typed deferred proposal', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step15 = sectionBetween(text, '### Step 1.5', '### Step 2 — Understand');
  assert.match(step15, /Brainstorm NEVER mutates the\s+hub — no graph mutation, no `\.apex\/\*\.md` edit/,
    'brainstorm must forbid both graph mutation and .apex/*.md edits');
  assert.match(step15, /every delta \(a term, a latent convention, a\s+CONFLICT override\) is recorded in the spec as a\s+typed\s+deferred proposal/,
    'every delta must be recorded in the spec as a typed deferred proposal');
  const writeBack = sectionBetween(text, '### Write-back routing', '### Step 6');
  assert.match(writeBack, /brainstorm never writes back to the graph/i,
    'the routing section must close the write-back channel');
  assert.match(writeBack, /every delta is a typed deferred proposal \(Step 5\)/i,
    'the routing section must route every delta to the typed deferred proposal channel');
  assert.doesNotMatch(writeBack, /\.apex\/(glossary|conventions)\.md|\blegacy\b/i, 'no Markdown write-back channel survives');
});

test('brainstorm: typed deferred proposals use the promotion candidate schema — term/rule/decision, never a canonised hub edit', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step5 = sectionBetween(text, '### Step 5 — Finalize the approved draft', '### Step 5.5');
  assert.match(step5, /typed deferred proposal/,
    'Step 5 must name the typed deferred proposal channel');
  assert.match(step5, /never a canonised hub edit/,
    'a deferred proposal must never be a canonised hub edit');
  assert.match(step5, /the same typed-candidates file `steepy-formula promotion create` reads/,
    'the proposal schema must be the same typed-candidates file promotion create reads');
  assert.match(step5, /`term` — `term` \+ `definition`/, 'the term candidate shape must be pinned');
  assert.match(step5, /`rule` — `title` \+ `statement`/, 'the rule candidate shape must be pinned');
  assert.match(step5, /`strength` \(`must`\|`should`\)/, 'rule strength must use the must|should vocabulary');
  assert.match(step5, /`appliesTo`/, 'a rule must scope itself via appliesTo');
  assert.match(step5, /`decision` — `title` \+ `statement` \+ `context`/, 'the decision candidate shape must be pinned');
});

test('brainstorm: Step 1.5 declares the hub mode via steepy-formula hub-mode — the prose never re-implements detection', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step15 = sectionBetween(text, '### Step 1.5', '### Step 2 — Understand');
  assert.match(step15, /run `steepy-formula hub-mode` and carry its declared\s+mode/,
    'Step 1.5 must invoke steepy-formula hub-mode and carry the declared mode');
  assert.match(step15, /The command always exits 0/,
    'the declaration must state the command always exits 0 — a declaration, not a gate');
  assert.match(step15, /this prose never\s+re-implements its detection — the command is the single authority/,
    'the prose must never re-implement the mode detection');
  const declaration = step15.match(/\*\*Hub-mode declaration \(once per run\)\.\*\*[\s\S]*?(?=\n\n)/)?.[0] ?? '';
  assert.ok(declaration, 'Step 1.5 must carry the hub-mode declaration paragraph');
  assert.doesNotMatch(declaration, /initialized:/,
    'the declaration must not read the engine facts initialized: field itself');
  assert.doesNotMatch(declaration, /_INDEX\.md/,
    'the declaration must not probe .apex/_INDEX.md existence to detect the mode');
  assert.match(step15, /`graph`, `migrate`, or `none`/, 'Step 1.5 declaration lists exactly graph, migrate, none');
  assert.doesNotMatch(step15, /`legacy`|\blegacy\b/i, 'Step 1.5 carries no legacy branch');
});

// Mode-aware orientation (init-graph-first): each chain skill's Step 1 declares the hub mode and
// its graph branch orients from the canonical graph alone — a graph-first repo has no
// .apex/_INDEX.md, no standards/, no testing-and-checklist.md to read, so the graph branch must
// require none of them.
test('workflow chain: Step 1 orientation is mode-aware — the graph branch requires no markdown-hub read', () => {
  // Every chain skill is graph-only: it carries the migrate stop and no legacy bullet.
  const step1Bounds = {
    brainstorm: { bounds: ['### Step 1 — Orient against the hub', '### Step 1.5'] },
    plan: { bounds: ['### Step 1 — Load the spec and the hub', '### Step 2'] },
    implement: { bounds: ['### Step 1 — Load the accepted input and derive current-run artifacts', '### Step 2'] },
    review: { bounds: ['### Step 1 — Load bounded review inputs and the hub', '### Step 2'] },
  };
  for (const [s, { bounds: [start, end] }] of Object.entries(step1Bounds)) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
    const step1 = sectionBetween(text, start, end);
    if (s === 'review') {
      assert.match(step1, /mode declared at Step 0/i,
        'review Step 1 must reuse the Step 0 hub-mode declaration, never re-detect');
    } else {
      assert.match(step1, /`steepy-formula hub-mode`/,
        `${s} Step 1 must declare the hub mode via steepy-formula hub-mode`);
    }

    const graphBullet = step1.match(/- \*\*`graph` mode:\*\*[\s\S]*?(?=\n- \*\*)/)?.[0];
    assert.ok(graphBullet, `${s} Step 1 must carry a graph-mode orientation bullet`);
    assert.match(graphBullet, /`steepy-formula context resolve --path <p>\.\.\.`/,
      `${s} graph orientation must resolve context from the canonical graph`);
    assert.match(graphBullet, /\.claude\/agents\/<(?:surface|name)>-agent\.md/,
      `${s} graph orientation must bind the specialist agent by deterministic naming convention`);
    assert.match(graphBullet, /`steepy-formula graph status`/,
      `${s} graph branch must diagnose the not-initialized signal via graph status, not a missing _INDEX.md`);
    assert.doesNotMatch(graphBullet, /_INDEX\.md|testing-and-checklist|\.apex\/standards\//,
      `${s} graph orientation must require no _INDEX.md, standards/, or testing-and-checklist read`);

    assert.match(step1, /`graph`, `migrate`, or `none`/, `${s} Step 1 mode list is exactly graph, migrate, none`);
    const migrateBullet = step1.match(/- \*\*`migrate` mode:\*\*[\s\S]*?(?=\n- \*\*|\n\n)/)?.[0];
    assert.ok(migrateBullet, `${s} Step 1 must carry the migrate stop bullet`);
    assert.match(migrateBullet,
      /Stop and tell the user to run the `graph-migrate` skill \(invoke it the way your harness invokes skills\) before any other workflow\./,
      `${s} migrate bullet carries the exact stop sentence`);
    assert.doesNotMatch(step1, /`legacy`|\blegacy\b/i, `${s} Step 1 carries no legacy branch`);
    assert.doesNotMatch(text, /testing-and-checklist\.md/, `${s} never names testing-and-checklist.md`);
    assert.doesNotMatch(step1, /_INDEX\.md/, `${s} Step 1 never names .apex/_INDEX.md`);

    if (s !== 'brainstorm') {
      assert.match(graphBullet, /ext_v1_command/,
        `${s} graph orientation must source the surface test command from the Check's ext_v1_command`);
      assert.match(graphBullet, /verification Rule's statement/,
        `${s} graph test-command sourcing must fall back to the verification Rule's statement prose`);
    }

    assert.match(step1, /- \*\*Mode `none`:\*\*/, `${s} Step 1 must handle mode none explicitly`);
  }
});

// Deterministic --target fallback (init-graph-first follow-up): a freshly graph-first-initialized
// repo carries no topology bridge (Package → curated Component IMPLEMENTS), so `context resolve
// --path` exits 10 UNRESOLVED there by construction — while the deterministic surface targets
// resolve fine. Every graph orientation that leads with --path must therefore teach the same
// fallback, in one shared passage reused verbatim (modulo line wrapping) across the five
// chain/loop skills and the graph bootstrap template's navigation step.
const TARGET_FALLBACK_PASSAGE =
  'On exit 10 UNRESOLVED — normal in a freshly graph-first-initialized repo, where no ' +
  'topology bridge links the detected Packages to the curated Components yet — fall back to ' +
  'the deterministic surface targets: ' +
  '`steepy-formula context resolve --target apex:<projectId>:surface:<slug(name)>` for each ' +
  'owning surface, every part derived, never guessed — surface names from ' +
  "`.claude/agents/<name>-agent.md` (CLAUDE.md's Surfaces section is the fallback listing), " +
  "the project id from the hub-mode declaration's `hub-mode '<projectId>'` echo, `slug(name)` " +
  'lowercase with non-alphanumeric runs collapsed to `-` — and never target the bare project ' +
  'root on its own: it resolves empty.';

test('graph orientation: the deterministic --target fallback passage is shared verbatim by the five chain/loop skills and the graph bootstrap template', () => {
  const carriers = [
    join(skillsDir, 'brainstorm', 'SKILL.md'),
    join(skillsDir, 'plan', 'SKILL.md'),
    join(skillsDir, 'implement', 'SKILL.md'),
    join(skillsDir, 'review', 'SKILL.md'),
    join(skillsDir, 'loop-engineer', 'SKILL.md'),
    join(here, '..', 'templates', 'bootstrap-skill-graph.md'),
  ];
  for (const file of carriers) {
    const flat = readFileSync(file, 'utf8').replace(/\s+/g, ' ');
    assert.ok(flat.includes(TARGET_FALLBACK_PASSAGE),
      `${file} must carry the shared --target fallback passage verbatim (wording identical across all six carriers)`);
  }
});

test('brainstorm: manual handoff names the plan skill, a NEW session, and the relative plan path', () => {
  const text = readFileSync(join(skillsDir, 'brainstorm', 'SKILL.md'), 'utf8');
  const step7 = sectionBetween(text, '### Step 7 — Human review gate', '### Step 8');
  assert.match(step7, /handoff: steepy-formula\/v1[\s\S]*next: plan[\s\S]*spec: <exact-spec-path>[\s\S]*onDemand: none/,
    'the manual drive choice must emit the canonical brainstorm→plan envelope');
  const step8 = sectionBetween(text, '### Step 8 — Hand off', '## Model Selection');
  assert.match(step8, /run the `plan` skill in a NEW session, with the relative path of the plan document/,
    'the handoff must name the plan skill, a NEW session, and the relative plan path');
  assert.match(step8, /`\.formula\/work\/plans\/<date>-<topic>\.md`/,
    'the handoff must state the conventional relative plan path');
});

test('standalone skills (init, check, new-surface, discovery, graph-migrate) are harness-neutral — Engine-root block, no Claude-only slash/env syntax', () => {
  for (const name of ['init', 'check', 'new-surface', 'discovery', 'graph-migrate']) {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const engineRootBlock =
      `> **Engine root:** this skill's base directory is \`<engine-root>/skills/${name}/\`; engine\n` +
      `> scripts live two levels up, at \`<engine-root>/scripts/\`. Resolve them relative to the base\n` +
      `> directory your harness reports for this skill.`;
    assert.ok(text.includes(engineRootBlock), `${name} must carry the byte-exact Engine-root block`);
    assert.doesNotMatch(text, /\$\{CLAUDE_PLUGIN_ROOT\}/, `${name} must not reference \${CLAUDE_PLUGIN_ROOT}`);
    assert.doesNotMatch(text, /\/steepy-formula:/, `${name} must name skills abstractly, not with /steepy-formula: slash syntax`);
  }
});

// Task 18 (apex v0.9.4): init, new-surface, and loop-engineer keep core prose
// harness-neutral and delegate generated-marker ownership to the planner.
test('init and new-surface stay marker-free; loop-engineer owns workflow lifecycle headers', () => {
  for (const name of ['init', 'new-surface', 'loop-engineer']) {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const core = text.replace(/<!-- steepy:manual-handoff:v1:start -->[\s\S]*?<!-- steepy:manual-handoff:v1:end -->\n*/u, '');
    assert.doesNotMatch(text, /CLAUDE_[A-Z0-9_]*/u, `${name} must not use Claude environment variables`);
    assert.doesNotMatch(text, /\/steepy(?:-apex)?:/u, `${name} must use semantic skill names`);
    if (name === 'loop-engineer') assert.match(core, /<!-- steepy-workflow: v1/);
    else assert.doesNotMatch(core, /<!--\s*steepy(?::|-)/iu, `${name} must delegate non-handoff marker ownership to the planner`);
  }
});

test('new-surface carries no stale wording and repair preserves no artifacts claim', () => {
  const text = readFileSync(join(skillsDir, 'new-surface', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /\bstale\b/i);
  assert.doesNotMatch(text, /repair\s+preserves existing artifacts/i);
});

test('loop-engineer keeps bootstrap navigation separate from goal authorization', () => {
  const text = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0 — Read the gear', '### Step 1');
  assert.match(step0, /generated project bootstrap[^.]*root\/index navigation and semantic-skill routing only/i);
  assert.match(step0, /goal\.md[\s\S]*absent[\s\S]*refuse before any iteration, branch mutation, or commit question/i);
  assert.match(step0, /human-authored, gear-4-ratified goal contract/i);
  assert.doesNotMatch(step0, /\.agents\/skills\/<projectName>-bootstrap\/SKILL\.md|fallback/i);
  assert.doesNotMatch(step0, /CLAUDE\.md|\.claude\/skills/i);
});

test('workflow-skills suite uses only live bootstrap template sources', () => {
  const suiteSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const retiredSources = [
    ['CL', 'AUDE.md'],
    ['bootstrap', '-skill.md'],
    ['surface-agent', '.md'],
  ].map(([prefix, suffix]) => `templates/${prefix}${suffix}`);

  for (const retiredSource of retiredSources) {
    assert.doesNotMatch(
      suiteSource,
      new RegExp(retiredSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `workflow-skills suite must not name retired source ${retiredSource}`
    );
  }
  assert.match(
    suiteSource,
    /templates\/project-bootstrap-skill\.md/,
    'workflow-skills suite must name the permanent bootstrap template source'
  );
});

test('init: valid standalone initialization skill, drives the shipped steepy-formula CLI', () => {
  checkSkill('init', [
    'detect-stack.mjs',
    'graph init',
    'graph status',
    'context resolve',
    'promotion preview',
    'promotion apply',
    'graph validate',
  ]);
});

test('init: the procedure covers pre-flight → detection → interview → scaffolding → scenario → preview/gate → gates → repair in order', () => {
  const text = readFileSync(join(skillsDir, 'init', 'SKILL.md'), 'utf8');
  const phases = [
    ['pre-flight', /### Step \d+ — [^\n]*Pre-flight/],
    ['detection', /### Step \d+ — [^\n]*detection/i],
    ['interview', /### Step \d+ — [^\n]*Interview/],
    ['scaffolding', /### Step \d+ — [^\n]*scaffolding/i],
    ['scenario', /### Step \d+ — [^\n]*scenario/i],
    ['preview/gate', /### Step \d+ — [^\n]*Preview/],
    ['gates', /### Step \d+ — [^\n]*Gates/],
    ['repair', /### Step \d+ — [^\n]*Repair/],
  ];
  let prev = -1;
  for (const [label, re] of phases) {
    const match = text.match(re);
    assert.ok(match, `the procedure must carry a numbered step heading for ${label}`);
    const at = text.indexOf(match[0]);
    assert.ok(at > prev, `${label} must follow the previous phase in the numbered procedure`);
    prev = at;
  }
});

test('init: hard gate — never invents Rules from stack detection', () => {
  const text = readFileSync(join(skillsDir, 'init', 'SKILL.md'), 'utf8');
  assert.match(text, /never invent Rules/i, 'the never-invent-Rules gate must be stated explicitly');
  assert.match(text, /Rules enter the graph only/i, 'Rules must enter the graph only through the human-approved interview + scenario');
  assert.match(text, /PROPOSED/i, 'detected Surface/Component mappings must be proposed, never final');
  assert.match(text, /F1|secret provider/i, 'credentials must come only through the F1 secret-provider chain');
  assert.doesNotMatch(text, /--password/, 'the skill must never invent a --password flag');
});

test('graph-migrate: valid standalone migration skill, drives the shipped steepy-formula CLI', () => {
  checkSkill('graph-migrate', [
    '.apex/_INDEX.md',
    'migrate-markdown',
    'promotion preview',
    'promotion apply',
    'promotion discard',
    'graph validate',
    'context resolve',
    'graph export',
  ]);
});

test('graph-migrate: the §13 steps 6-10 procedure is present with one subsection per step', () => {
  const text = readFileSync(join(skillsDir, 'graph-migrate', 'SKILL.md'), 'utf8');
  for (let n = 6; n <= 10; n++) {
    assert.match(text, new RegExp(`### Step ${n} —`), `procedure must carry a subsection for ### Step ${n}`);
  }
  const first = text.indexOf('### Step 6');
  const last = text.indexOf('### Step 10');
  assert.ok(first !== -1 && last !== -1 && first < last, 'Step 6 must precede Step 10 in the procedure');
});

test('graph-migrate: Step 0 declares the hub mode, picks the path from its evidence, and binds the engine', () => {
  const text = readFileSync(join(skillsDir, 'graph-migrate', 'SKILL.md'), 'utf8');
  const step0 = sectionBetween(text, '### Step 0 —', '### Step 6');
  assert.match(step0, /steepy-formula hub-mode/, 'Step 0 declares the hub mode first');
  assert.ok(step0.replace(/\s+/g, ' ').includes('`graph`, `migrate`, or `none`'), 'Step 0 uses the exact mode list');
  assert.match(step0, /`graph`[^\n]*Nothing to migrate[^\n]*STOP/, 'graph: nothing to migrate');
  assert.match(step0, /`none`[^\n]*`init` skill[^\n]*STOP/, 'none: route to init');
  assert.match(step0, /`\.apex\/: present \(no Markdown hub\)`[^\n]*cleanup path/, 'leftover state takes the cleanup path');
  assert.match(step0, /`\.apex\/: present \(Markdown hub\)`[^\n]*Provision and bind the engine/, 'a hub is extracted after provisioning');
  assert.match(step0, /never probes the area's contents itself/, 'the path choice reads only the evidence line');
  assert.doesNotMatch(step0, /exists?\b[^\n]*_INDEX\.md|_INDEX\.md[^\n]*exists?\b/, 'the prose never probes _INDEX.md itself');
  assert.match(step0, /steepy-formula graph init \[--project <project-id>\]/, 'Step 0 provisions the engine');
  assert.match(step0, /existing `\.formula\/config\.json` binding wins/, 'an existing binding decides the project id');
  assert.match(step0, /exit 3[\s\S]{0,120}STOP/i, 'a failed provisioning stops before anything moves');
});

test('graph-migrate: the cleanup path names what is discarded and needs an explicit answer', () => {
  const text = readFileSync(join(skillsDir, 'graph-migrate', 'SKILL.md'), 'utf8');
  const cleanup = sectionBetween(text, '**The cleanup path (no Markdown Hub).**', '### Step 6');
  for (const named of ['`.apex/work/`', '`.apex/inception/`', 'inception-source import', '`.apex/init-provenance.json`', '`.apex/init-provenance.pending.json`']) {
    assert.ok(cleanup.includes(named), `the cleanup path names ${named}`);
  }
  assert.match(cleanup, /deletions in `git status`/, 'tracked files show as deletions');
  assert.match(cleanup, /silence never\s+proceeds/, 'an explicit answer is required');
  assert.match(cleanup, /delete the `\.apex` entry entirely/, 'the whole area goes');
  assert.match(cleanup, /`\.formula\/work\/` area per init's Step 4 shape/, 'the new work area follows init');
  assert.match(cleanup, /re-run\s+`steepy-formula hub-mode`/, 'the cleanup re-declares the mode');
  assert.match(cleanup, /Nothing is extracted and the graph is not touched/, 'cleanup never writes the graph');
});

test('graph-migrate: encodes the archive-then-remove closure and the no-dual-authority rule', () => {
  const text = readFileSync(join(skillsDir, 'graph-migrate', 'SKILL.md'), 'utf8');
  assert.match(text, /archive/i, 'step 10 must archive the legacy hub at cutover');
  assert.match(text, /\.apex-legacy-archive\//, 'step 10 must name the archive location convention');
  assert.match(text, /no[- ]dual[- ]authority/i, 'the no-dual-authority rule must be stated explicitly');
  assert.match(text, /graph export/, 'the recovery checkpoint is a digest-verified export (graph export)');
  assert.match(text, /graph validate/, 'the recovery checkpoint must be a graph-validate-verified export');
  assert.match(
    text,
    /archive[\s\S]{0,160}verify[\s\S]{0,160}export[\s\S]{0,160}validate[\s\S]{0,160}regenerate[\s\S]{0,160}(remove|delete)/i,
    'the step-10 closure ordering must be archive → verify → export → validate → regenerate → then remove'
  );
  assert.doesNotMatch(text, /--password/, 'the skill must never invent a --password flag');
});

test('graph-migrate: cutover regenerates the graph-mode disk artifacts between export validation and archive removal', () => {
  const text = readFileSync(join(skillsDir, 'graph-migrate', 'SKILL.md'), 'utf8');
  assert.match(
    text,
    /\*\*Validate the export\*\*[\s\S]{0,2500}\*\*Regenerate the graph-mode disk artifacts\*\*[\s\S]{0,2500}\*\*Then remove the archive\*\*/,
    'the regeneration sub-step must sit between "Validate the export" and "Then remove the archive"'
  );
  assert.match(
    text,
    /bootstrap-skill-graph\.md/,
    "the bootstrap skill must be regenerated from templates/bootstrap-skill-graph.md (init's template — no second variant)"
  );
  assert.match(
    text,
    /templates\/surface-agent-graph\.md/,
    'surface agents must be regenerated from templates/surface-agent-graph.md (the graph-mode variant)'
  );
  assert.doesNotMatch(
    text,
    /templates\/surface-agent\.md/u,
    'the regeneration must never reference the retired .apex/standards-pointing surface agent template'
  );
  assert.match(
    text,
    /render-claude-md\.mjs[^\n]*--upsert[^\n]*--mode graph/,
    'CLAUDE.md must be upserted via render-claude-md.mjs in graph mode'
  );
  assert.match(
    text,
    /\.claude\/skills\/steepy-apex-bootstrap/,
    'the superseded steepy-apex bootstrap skill directory must be named for removal'
  );
  assert.doesNotMatch(
    text,
    /\.apex-work-staging|Restore the work area/,
    'formula\'s old local state is never staged or restored: it leaves with the archive'
  );
  assert.match(
    text,
    /whole `\.apex\/` area[\s\S]{0,400}discarded with the archive and never restored/,
    'the archive step must take the whole area and tell the user its local state is discarded'
  );
  assert.match(
    text,
    /\.formula\/work\/specs\/[\s\S]{0,200}\.formula\/work\/plans\/[\s\S]{0,300}\.gitignore/,
    'the work area must be re-created with specs/ and plans/ plus its .gitignore'
  );
  assert.match(
    text,
    /Any failure in this sub-step[^\n]*keeps the archive in place/,
    'a regeneration failure must keep the archive in place (the closure fallback rule)'
  );
  assert.match(
    text,
    /report the head revision[\s\S]{0,200}regenerated/,
    'the closing report must list the regenerated artifacts'
  );
});

test('surface-agent-graph template: graph-mode agent resolves context target-first from the graph, never .apex/standards', () => {
  const tpl = readFileSync(join(here, '..', 'templates', 'surface-agent-graph.md'), 'utf8');
  const fm = tpl.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, 'surface-agent-graph template must have YAML front-matter');
  assert.match(fm[1], /^model:\s*(opus|sonnet|haiku)\b/m,
    'agent template front-matter must set a concrete model alias');
  for (const ph of ['{{name}}', '{{path}}']) {
    assert.ok(tpl.includes(ph), `surface-agent-graph template must keep the ${ph} placeholder`);
  }
  const flat = tpl.replace(/\s+/g, ' ');
  assert.ok(flat.includes('`steepy-formula context resolve --target apex:<projectId>:surface:<slug of {{name}}>`'),
    'per-task guidance must lead with the deterministic --target resolve on the surface id derived from {{name}}');
  assert.match(flat, /hub-mode '<projectId>'/,
    "the project id must come from steepy-formula hub-mode's project echo");
  assert.match(flat, /lowercase with non-alphanumeric runs collapsed to `-`/,
    'the slug rule must be stated: lowercase, non-alphanumeric runs collapsed to -');
  assert.ok(flat.includes('`steepy-formula context resolve --path {{path}}`'),
    'the --path {{path}} resolve stays the noted alternative');
  assert.match(flat, /topology bridge exists/,
    'the --path alternative must be scoped to where the topology bridge exists');
  assert.match(tpl, /ext_v1_command/,
    "the test command must come from the resolved Check's ext_v1_command extension property");
  assert.match(tpl, /statement prose/,
    "a Check without ext_v1_command must fall back to the verification Rule's statement prose");
  assert.doesNotMatch(tpl, /\.apex\/standards\//,
    'the graph-mode template must not point at .apex/standards/');
});

test('terminal review, not the loop controller, owns the mandatory hub coherence gate', () => {
  const loop = readFileSync(join(skillsDir, 'loop-engineer', 'SKILL.md'), 'utf8');
  const review = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  const controllerBoundary = sectionBetween(loop, '### Controller responsibility boundary', '### Step 0');
  const reviewEvidence = sectionBetween(review, '### Step 2', '### Step 3');
  assert.doesNotMatch(controllerBoundary, /loop-engineer\.mjs[^]*validate-hub/u);
  assert.match(controllerBoundary, /terminal review owns[^]*steepy-formula graph validate/u);
  assert.doesNotMatch(controllerBoundary, /validate-hub/u);
  assert.match(reviewEvidence, /capture-review-evidence\.mjs[^]*steepy-formula graph validate/u);
  assert.doesNotMatch(reviewEvidence, /validate-hub/u);
  // Formula adaptation (apex v1.2.0 port): apex also locks the sole-owner rule in
  // `.apex/standards/skills.md`; that archived hub's half rides the canonical graph promotion.
});

test('check: reports model-mapping freshness verdicts before the graph gate, never blocking on UNKNOWN', () => {
  const text = readFileSync(join(skillsDir, 'check', 'SKILL.md'), 'utf8');
  assert.ok(
    text.includes('node <engine-root>/scripts/verify-model-mappings.mjs'),
    'check must run the freshness verifier through the engine-root path'
  );
  const branch = sectionBetween(text, '2. **Validate the graph**', '3. **Report**');
  const vIdx = branch.indexOf('verify-model-mappings.mjs');
  const gIdx = branch.indexOf('steepy-formula graph validate');
  assert.ok(vIdx !== -1, 'the graph flow must run the freshness verifier');
  assert.ok(gIdx !== -1 && vIdx < gIdx, 'the verifier must run before the coherence gate');
  assert.ok(text.includes('`OK | STALE | UNKNOWN`'),
    'the step must carry the per-row verdict vocabulary');
  assert.match(text, /`STALE`[^\n]*human-ratified table patch/,
    'STALE must require a human-ratified table patch');
  assert.match(text, /script prints the prepared patch/,
    'the step must point at the script-printed prepared patch');
  assert.match(text, /`UNKNOWN` is informational \(source unreachable/,
    'UNKNOWN must be informational (source unreachable)');
  assert.match(text, /never as a failure/,
    'the step must never block on UNKNOWN (declared offline degradation)');
});

test('docs/architecture.md documents the shipped Stable Knowledge Graph product architecture', () => {
  const architecture = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8');

  for (const required of [
    'domain core',
    'ontology',
    'validator',
    'revisions',
    'export/restore',
    'topology',
    'resolver',
    'promotion',
    'schema migration',
    'engine port',
    'memory',
    'ArcadeDB',
    'capability map',
    'CLI',
    'MCP server',
    'mutation boundary',
    'sole-writer promotion service',
    'read credentials',
    'export-on-promotion',
    'retention',
    'hash-chained Revisions',
    'replay detection',
    'Stable Knowledge Graph',
    'semantic reachability from Project',
    'bounded dependency policy',
    'graph-migrate',
    'one-time migration',
  ]) {
    assert.match(architecture, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `architecture must document: ${required}`);
  }
});

test('live-observability docs lock the bridge boundary, safe logging contract, and conservative native capabilities', () => {
  const architecture = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8');
  const workflow = readFileSync(join(root, 'docs', 'workflow.md'), 'utf8');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');

  for (const required of [
    '`adapters/headless.mjs`',
    '`adapters/headless-events.mjs`',
    '`scripts/autopilot-observability.mjs`',
    '`scripts/autopilot.mjs`',
    'common event envelope',
    'raw-first',
    'bounded backpressure',
    'Node >= 24',
    'zero runtime dependencies',
  ]) {
    assert.ok(architecture.includes(required), `architecture must document: ${required}`);
  }

  for (const required of [
    'phase-<n>-attempt-<m>.log',
    'phase-<n>-attempt-<m>.raw.jsonl',
    'phase-<n>.log',
    'safe',
    'exact',
    'no-steer',
    'new attempt',
    'interruption',
    'timeout',
    'yes | unavailable | unproven',
    'OpenCode',
    'unproven',
    'https://code.claude.com/docs/en/cli-usage',
    'https://developers.openai.com/codex/cli/reference',
    'https://developers.openai.com/codex/noninteractive',
    'https://opencode.ai/docs/it/cli/',
  ]) {
    assert.ok(workflow.includes(required), `workflow must document: ${required}`);
  }
  assert.match(workflow, /exact[\s\S]{0,300}never changes[\s\S]{0,160}(?:live|readable)/i,
    'exact mode must not change curated live/readable output');
  assert.match(workflow, /safe[\s\S]{0,240}(?:best-effort|not a mathematical secrecy guarantee)/i,
    'safe redaction must be documented as best effort, not a secrecy guarantee');
  assert.match(workflow, /### Native capability matrix/,
    'capability matrix must retain its explicit capability scope');

  for (const required of [
    'claude -p <prompt> --dangerously-skip-permissions --allowedTools Task,Bash,Glob,Grep,Read,Edit,Write,TodoWrite,Skill --output-format stream-json --verbose --forward-subagent-text --name <display-name>',
    'codex exec --dangerously-bypass-approvals-and-sandbox --color never --json <prompt>',
    'opencode run --auto --format json --title <display-name> <prompt>',
  ]) {
    assert.ok(workflow.includes(required), `workflow must show the complete mapped command: ${required}`);
  }
  assert.match(workflow, /Native session identity \| Native discovery \| Native open\/resume/,
    'the matrix must distinguish observed session identity from discoverability and resume success');
  assert.match(workflow, /Claude Code[^\n]*\| yes \| unproven \| yes \| unproven \| unproven:[^\n]*\| yes \| unavailable \| unavailable \|/,
    'Claude agent/subagent identity, discovery, and successful native resumption must remain unproven on formula (inherited apex claims do not promote cells)');
  assert.match(workflow, /Codex[^\n]*\| yes \| unavailable \| yes \| yes:[^\n]*\| yes:[^\n]*\| unavailable \| unavailable \| unavailable \|/,
    'Codex documented discovery and resume baseline must stay separate from its locally unavailable canary');
  assert.match(workflow, /OpenCode[^\n]*\| yes \| unavailable \| yes \| yes:[^\n]*\| yes:[^\n]*\| yes \| unavailable \| unavailable \|/,
    'OpenCode identity, discovery, and open/resume are yes on real event evidence (sessionID on every structured event)');
  assert.match(workflow, /flag-only[^\n]*?(?:never|does not)[^\n]*promot/i,
    'workflow must prohibit flag-only capability promotion explicitly');

  assert.match(readme, /live observability/i, 'README must summarize live observability');
  assert.ok(readme.includes('[docs/workflow.md](docs/workflow.md)'), 'README must link to detailed workflow docs');
  assert.ok(readme.includes('[docs/architecture.md](docs/architecture.md)'), 'README must link to detailed architecture docs');
});

test('all five chain skills declare session-per-phase discipline: entry declaration + autopilot no-op in Step 0, new-session instruction at handoff', () => {
  const handoffHeadings = {
    brainstorm: '### Step 8 — Hand off',
    plan: '### Step 7 — Hand off',
    implement: '### Step 5 — Hand off',
    review: '### Step 5 — Offer a pull request',
    'loop-engineer': '### Step 5 — Hand off',
  };
  const step0EndHeadings = {
    brainstorm: '### Ceremony by gear',
    plan: '### Ceremony by gear',
    implement: '### Ceremony by gear',
    review: '### Ceremony by gear',
    'loop-engineer': '### Step 1',
  };

  for (const s of ['brainstorm', 'plan', 'implement', 'review', 'loop-engineer']) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');

    // (b) In ingresso — Step 0 declares whether this session already ran another chain phase,
    // and names the cost when it did. Declares, never blocks. Anchored to Step 0 alone (not the
    // sibling "Ceremony by gear" subsection) so this slice can actually falsify a wrong placement.
    const step0 = sectionBetween(text, '### Step 0 — Read the gear', step0EndHeadings[s]);
    assert.match(step0, /already run an earlier phase/i, `${s} Step 0 must declare whether an earlier phase already ran this session`);
    assert.match(step0, /same session/i, `${s} Step 0 declaration must name the same-session case`);
    assert.match(step0, /every turn/i, `${s} Step 0 declaration must name the per-turn cost of an already-grown session`);
    assert.match(step0, /never refuse or gate/i, `${s} Step 0 declaration must never block or refuse sound work`);
    assert.match(step0, /determined with certainty/i, `${s} Step 0 declaration must cover the case it cannot determine session history with certainty`);

    // (c) No-op in autopilot — same paragraph, names the conductor's per-phase headless session
    // as the mechanism already enforcing this, so the declaration is a no-op there.
    assert.match(step0, /drive:\s*autopilot/i, `${s} Step 0 declaration must address drive: autopilot`);
    assert.match(step0, /no-op/i, `${s} Step 0 declaration must state the autopilot no-op`);
    assert.match(step0, /scripts\/autopilot\.mjs/, `${s} Step 0 declaration must cite the conductor (scripts/autopilot.mjs) as the enforcing mechanism`);

    // (a) In uscita — the hand off / terminal section instructs a new session for what comes next.
    const handoff = sectionBetween(text, handoffHeadings[s], '## Model Selection');
    assert.match(handoff, /new session/i, `${s} handoff must instruct running the next work in a new session`);
    assert.match(handoff, /does not serve/i, `${s} handoff must state this phase's context does not serve the next work`);
    assert.match(handoff, /every turn/i, `${s} handoff must state every turn of the next work would pay to carry this phase's context`);
  }
});

test('task reviewer explicitly rejects a review-file pointer for ISSUES_FOUND', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'task-reviewer-prompt.md'), 'utf8');
  assert.match(text, /ISSUES_FOUND artifact must be task-N-issues\.md/);
  assert.match(text, /A link from the review file to the issue file does not satisfy/);
  assert.match(text, /status: ISSUES_FOUND\n    artifact: \[ISSUE_FILE\]/);
});


test('reviewer recovery ships only the v2 schema and has no response-only correction', () => {
  const recovery = readFileSync(join(skillsDir, 'implement/reviewer-recovery.md'), 'utf8');
  assert.ok(!existsSync(join(skillsDir, 'implement/reviewer-response.schema.json')));
  const schema = JSON.parse(readFileSync(join(skillsDir, 'implement/reviewer-response-v2.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['status', 'artifact', 'signals']);
  for (const file of ['SKILL.md', 'autopilot-protocol.md']) assert.match(readFileSync(join(skillsDir, 'implement', file), 'utf8'), /reviewer-recovery\.md/);
  for (const file of ['task-reviewer-prompt.md', 'final-review-prompt.md']) {
    const prompt = readFileSync(join(skillsDir, 'implement', file), 'utf8');
    assert.doesNotMatch(prompt, /changed-paths: <comma/);
    assert.match(prompt, /artifacts is required and excluded from `changed-paths`/);
  }
  for (const action of ['begin', 'check', 'inspect']) assert.ok(recovery.includes(`--action ${action}`));
  assert.doesNotMatch(recovery, /--action (?:reserve|correct)\b|REPAIRABLE|response-only correction/);
  assert.match(recovery, /never another implementation/);
  assert.match(recovery, /do not invent a schema flag/);
});

test('receipt protocol selects semantic transport and records exact restart capabilities', () => {
  const protocol = readFileSync(join(skillsDir, 'implement/task-results-protocol.md'), 'utf8');
  for (const action of ['begin', 'record', 'inspect', 'resume', 'project', 'verify']) {
    assert.ok(protocol.includes(`--action ${action}`), action);
  }
  assert.match(protocol, /manifest\.contract\.taskResultProtocol/);
  assert.match(protocol, /TASK_RESULT_PROTOCOL/);
  assert.doesNotMatch(protocol, /legacy|protocol 1/i);
  assert.match(protocol, /before[^]*dispatch[^]*ledger/i);
  assert.match(protocol, /parentState[^]*all tasks/i);
  assert.match(protocol, /previousState[^]*same.task/i);
  assert.match(protocol, /baseline.only[^]*pending/i);
  assert.match(protocol, /capture[^]*without[^]*redispatch/i);
  assert.match(protocol, /review.pending/i);
  assert.match(protocol, /never[^]*manufacture[^]*historical baseline/i);
  assert.match(protocol, /JSON[^]*changedPaths[^]*executionChangedPaths/);
  assert.match(protocol, /outputs[^]*not[^]*read permission/i);
});

test('autopilot prompts specify only status, artifact, signals; manual drive keeps four fields', () => {
  for (const file of ['SKILL.md', 'implementer-prompt.md', 'task-reviewer-prompt.md', 'final-review-prompt.md', 'diagnosis-prompt.md']) {
    const text = readFileSync(join(skillsDir, 'implement', file), 'utf8');
    assert.match(text, /status[^]*artifact[^]*signals/);
    assert.match(text, /changed-paths:/, 'manual-drive grammar remains documented');
    assert.doesNotMatch(text, /legacy/i, file);
    assert.doesNotMatch(text, /protocol 1/i, file);
    assert.match(text, /autopilot[^]*status[^]*artifact[^]*signals/i, file);
    assert.match(text, /changed-paths[^\n]*malformed/i, file);
  }
  const recovery = readFileSync(join(skillsDir, 'implement/reviewer-recovery.md'), 'utf8');
  assert.match(recovery, /--execution/);
  assert.match(recovery, /reviewer-response-v2\.schema\.json/);
  // Task 14: reviewer recovery now names the correction guard and its record paths; any other
  // correction wording would reintroduce the retired response correction.
  assert.doesNotMatch(recovery.replace(/correction-guard\.mjs|correction guard|\/correction\//g, ''), /correction/i,
    'reviewer recovery names only the correction guard and its record paths, never a response correction');
  const schema = JSON.parse(readFileSync(join(skillsDir, 'implement/reviewer-response-v2.schema.json'), 'utf8'));
  assert.deepEqual(schema.required, ['status', 'artifact', 'signals']);
  assert.equal(schema.additionalProperties, false);
});

// SC8: autopilot text shows no four-field example and no protocol-1 path; every
// four-field example in a mixed file is labelled as the manual-drive grammar.
test('autopilot sections carry no four-field example and mixed files label manual four-field examples', () => {
  for (const file of ['reviewer-recovery.md', 'task-results-protocol.md', 'autopilot-protocol.md']) {
    const text = readFileSync(join(skillsDir, 'implement', file), 'utf8');
    assert.doesNotMatch(text, /^\s*changed-paths: /m, file);
    assert.doesNotMatch(text, /legacy|protocol 1/i, file);
  }
  const review = readFileSync(join(skillsDir, 'review', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(sectionBetween(review, '**Autopilot preflight:**', '**Manual/no-manifest:**'), /legacy|protocol 1/i);
  const field = /^\s*(?:status|artifact|changed-paths|signals): /;
  for (const file of ['SKILL.md', 'implementer-prompt.md', 'task-reviewer-prompt.md', 'final-review-prompt.md', 'diagnosis-prompt.md']) {
    const lines = readFileSync(join(skillsDir, 'implement', file), 'utf8').split('\n');
    const fourField = [], threeField = [];
    lines.forEach((line, i) => {
      if (!/^\s*status: /.test(line)) return;
      if (lines.slice(i + 1, i + 4).some((next) => /^\s*changed-paths:/.test(next))) {
        let j = i - 1;
        while (j >= 0 && (!lines[j].trim() || /^\s*```/.test(lines[j]) || field.test(lines[j]))) j--;
        assert.match(lines[j] ?? '', /manual/i, `${file}:${i + 1} four-field example must be labelled manual drive`);
        fourField.push(i);
      } else if (/^\s*artifact: /.test(lines[i + 1] ?? '') && /^\s*signals: /.test(lines[i + 2] ?? '')) threeField.push(i);
    });
    assert.ok(fourField.length > 0, `${file} keeps the manual four-field grammar`);
    if (file !== 'SKILL.md') assert.ok(threeField.length > 0, `${file} shows the three-field autopilot shape`);
    for (const i of threeField) assert.ok(i > fourField[0], `${file}:${i + 1} autopilot example must follow the first manual block`);
  }
});

// Task 13: structured defects, the prose rubric and the read-only diagnosis prompt.
const RUBRIC_TABLE = [
  '| Dimension | 0 | 1 | 2 |',
  '| --- | --- | --- | --- |',
  '| Coverage | Mandatory deliverable absent | Required elements partly present | Every required element has an exact content reference |',
  '| Correctness | Contradiction or demonstrable error | Required fact unverified | Facts checked; assumptions explicit; no known contradiction |',
  '| Clarity | Reader cannot determine the required action | A named ambiguity remains | Actors, inputs, actions and outcomes are unambiguous |',
  '| Usability | Required procedure cannot be performed | A concrete prerequisite or step is missing | Procedure can be followed with declared inputs and checks |',
].join('\n');

test('reviewer prompts lock the defects artifact, the rubric table and the feedback fields', () => {
  for (const [file, slot] of [['task-reviewer-prompt.md', 'DEFECTS_FILE'], ['final-review-prompt.md', 'DEFECTS_FILE']]) {
    const text = readFileSync(join(skillsDir, 'implement', file), 'utf8');
    assert.match(text, /\*\*Defects artifact:\*\* \[DEFECTS_FILE\]/, `${file} declares the defects slot`);
    assert.match(text, /strict JSON/, `${file} requires strict JSON`);
    for (const key of ['version', 'scope', 'cycle', 'iteration', 'verdict', 'defects', 'rubric']) {
      assert.ok(text.includes(`\`${key}\``), `${file} names defects key ${key}`);
    }
    for (const key of ['criterion', 'check', 'dimension', 'cause', 'severity', 'expected', 'observed', 'proof',
      'correction', 'nextCheck', 'supersedes', 'justification']) {
      assert.ok(text.includes(`\`${key}\``), `${file} names defect field ${key}`);
    }
    assert.match(text, /`review` \| `rubric`/, `${file} names the check values`);
    assert.match(text, /`critical` \| `important` \| `minor`/, `${file} names the severities`);
    assert.match(text, /`APPROVED` \| `ISSUES_FOUND`/, `${file} names the verdict values`);
    assert.match(text, /kebab-case/, `${file} requires a stable kebab-case cause`);
    assert.match(text, /never weaken a criterion/i, `${file} forbids weakening a criterion`);
    assert.match(text, /8\/8/, `${file} requires 8/8`);
    assert.match(text, /unsupported\s+score\s+is\s+invalid\s+feedback/i, `${file} rejects unsupported scores`);
    assert.match(text, /artifacts is required and excluded from `changed-paths`/, `${file} keeps the changed-paths exclusion`);
    assert.ok(text.includes(RUBRIC_TABLE.split('\n').map((l) => `    ${l}`).join('\n')), `${file} carries the rubric table verbatim`);
    assert.doesNotMatch(text, /legacy/i, file);
    assert.doesNotMatch(text, /\.formula\/work\/tasks\/[^\s`]*defects/i, `${file} names no concrete defects path`);
  }
});

test('reviewer prompts pin the guard-facing verdict, binding, shape and pairing sentences', () => {
  for (const file of ['task-reviewer-prompt.md', 'final-review-prompt.md']) {
    const text = readFileSync(join(skillsDir, 'implement', file), 'utf8').replace(/\s+/g, ' ');
    const pins = [
      [/ISSUES_FOUND exactly when at least one defect is `critical` or `important`/, 'verdict is ISSUES_FOUND exactly when a blocking defect exists'],
      [/otherwise `APPROVED`/, 'otherwise the verdict is APPROVED'],
      [/holds only `minor` defects when approved/, 'an approved defects array holds only minor defects'],
      [/below 2[^.]*must be `critical` or `important`/, 'a sub-2 rubric defect is blocking'],
      [/unsatisfied constraint[^.]*`critical` or `important` `review` defect/, 'an unsatisfied constraint needs a blocking review defect'],
      [/`criterion` must be one of the criteria the brief or manifest binds for the dispatched scope/, 'criterion comes from the dispatch bindings'],
      [/`check: rubric` only for a rubric-bound criterion/, 'rubric check only for rubric-bound criteria'],
      [/nearest (?:bound )?criterion[^.]*as a `review` defect/, 'an unbound finding attaches to the nearest bound criterion as a review defect'],
      [/never invent a criterion/i, 'never invent a criterion'],
      [/exactly one entry per rubric-bound criterion of the reviewed scope and none other/, 'rubric has one entry per rubric-bound criterion'],
      [/`satisfied` is `true` or `false`/, 'constraint satisfied is boolean'],
      [/`id` is a unique single-line string/, 'constraint id is unique single-line'],
      [/`evidence` is non-empty/, 'constraint evidence is non-empty'],
      [/`<criterion>\/<check>\[:<dimension>\]\/<cause>`/, 'supersedes id form'],
      [/`supersedes` and `justification` are both null/, 'supersedes and justification pair as null'],
      [/`dimension` \(null for `review`/, 'dimension is null for review'],
      [/at most 64 characters/, 'cause cap is 64 characters'],
      [/\{ "score": 0 \| 1 \| 2, "evidence": "<concrete evidence>" \}/, 'rubric dimension shape'],
      [/`constraints` \(an array of \{ "id", "satisfied", "evidence" \}/, 'constraints shape'],
    ];
    for (const [re, message] of pins) assert.match(text, re, `${file}: ${message}`);
  }
  const diagnosis = readFileSync(join(skillsDir, 'implement', 'diagnosis-prompt.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(diagnosis, /\{ "path", "digest" \}/, 'diagnosis evidence reference shape');
  assert.match(diagnosis, /lowercase 64-hex/, 'diagnosis digest is 64-hex');
  assert.match(diagnosis, /`confirmingCheck`[^.]*`review` or `rubric`/, 'diagnosis confirmingCheck set');
});

test('implementer prompt names the applied remedy and forbids editing criteria or tests to hide a failure', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'implementer-prompt.md'), 'utf8');
  assert.match(text, /correction dispatch[^]*admitted remedy[^]*confirming check/i, 'correction report names remedy and confirming check');
  assert.match(text, /never edit[^.]*criteria[^.]*tests[^.]*failure\s+disappear/i, 'implementer never edits criteria or tests to hide a failure');
});

test('diagnosis prompt is a harness-neutral read-only diagnostic with the guard-accepted artifact', () => {
  const text = readFileSync(join(skillsDir, 'implement', 'diagnosis-prompt.md'), 'utf8');
  assert.match(text, /model: standard/, 'diagnosis names an explicit standard tier');
  assert.match(text, /most-capable/, 'diagnosis rises to most-capable for design');
  assert.match(text, /read-only/i, 'diagnosis is read-only');
  assert.match(text, /never edits? source, stages? or commits?/i, 'diagnosis never edits, stages or commits');
  for (const key of ['version', 'scope', 'cycle', 'iteration', 'hypothesis', 'remedy', 'confirmingCheck',
    'recommendation', 'evidence']) {
    assert.ok(text.includes(`\`${key}\``), `diagnosis names key ${key}`);
  }
  assert.match(text, /DIAGNOSED \| INCONCLUSIVE \| BLOCKED \| NEEDS_CONTEXT/, 'diagnosis statuses are exact');
  assert.match(text, /no task\/subagent tool/i, 'diagnosis names the no-subagent-tool case');
  assert.match(text, /inline[^]*degradation/i, 'diagnosis declares the inline degradation');
  assert.match(text, /changed-paths: none/, 'manual drive adds changed-paths: none');
  assert.doesNotMatch(text, /legacy|\$\{CLAUDE_PLUGIN_ROOT\}/i, 'diagnosis stays harness-neutral');
});

// Task 14: the implement skill and its protocols drive Gear-3 correction through the shipped
// correction guard in both drives. Prose is flattened so line wrapping never decides a lock.
const implementText = (file) => readFileSync(join(skillsDir, 'implement', file), 'utf8');
const flatText = (text) => text.replace(/\s+/g, ' ');
const guardStep = () => sectionBetween(implementText('SKILL.md'), '### Step 2.7', '### Step 3');

// The per-action options of the shipped guard, read from its own usage text so a lock can never
// accept a flag the CLI does not parse: `accepted` holds every option of the action, `required`
// those its usage lines show outside `[...]`.
function guardUsageOptions() {
  const source = readFileSync(join(root, 'scripts', 'correction-guard.mjs'), 'utf8');
  const usage = source.slice(source.indexOf('const USAGE = `'), source.indexOf('`;', source.indexOf('const USAGE = `')));
  const lines = usage.slice(usage.indexOf('actions:\n') + 'actions:\n'.length).split('\n');
  const actions = new Map();
  let current = null;
  for (const line of lines) {
    if (line.trim() === '') break;
    const head = line.match(/^ {2}([a-z-]+)(?:\s|$)/);
    if (head) {
      current = head[1];
      actions.set(current, { accepted: new Set(), required: new Set() });
    }
    for (const [, flag] of line.matchAll(/--([a-z-]+)/g)) actions.get(current).accepted.add(flag);
    for (const [, flag] of line.replace(/\[[^\]]*\]/g, '').matchAll(/--([a-z-]+)/g)) actions.get(current).required.add(flag);
  }
  // The usage note: every mutating action and verify-handoff take --run-id/--attempt; next and
  // verify never do, and reopen refuses them on every drive.
  for (const [action, { accepted }] of actions) {
    if (!IDENTITY_FREE_ACTIONS.includes(action)) {
      accepted.add('run-id');
      accepted.add('attempt');
    }
  }
  return actions;
}
const IDENTITY_FREE_ACTIONS = ['next', 'verify', 'reopen'];

// Whether a code span names a guard command. project, verify and verify-handoff are also
// task-results or reviewer-response actions: a span naming another script is never the guard's, a
// project span is the guard's without task-results' --states, a verify span without its
// --expected-tasks, and a verify-handoff span only without reviewer-response's --plan.
function isGuardSpan(span, actions) {
  if (span.includes('correction-guard.mjs')) return true;
  if (/(?:task-results|reviewer-response|autopilot-context)\.mjs/.test(span)) return false;
  const named = (action) => new RegExp(`--action ${action}(?:\\s|$)`).test(span);
  if ([...actions.keys()].some((action) => !['project', 'verify', 'verify-handoff'].includes(action) && named(action))) return true;
  if (named('project')) return !/--states\b/.test(span);
  if (named('verify')) return !/--expected-tasks\b/.test(span);
  if (named('verify-handoff')) return !/--plan\b/.test(span);
  return false;
}

// Every code span (inline or fenced line) of `text` that names a guard command.
function guardSpans(text, actions) {
  const spans = [];
  const prose = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => {
    spans.push(...body.split('\n'));
    return '';
  });
  for (const [, span] of prose.matchAll(/`([^`]+)`/g)) spans.push(span.replace(/\s+/g, ' '));
  return spans.filter((span) => isGuardSpan(span, actions));
}

test('implement: every documented correction-guard command line uses only flags the shipped CLI parses', () => {
  const actions = guardUsageOptions();
  assert.ok(actions.size >= 17 && actions.get('stop').required.has('scope') && !actions.get('reserve').required.has('reason'),
    'the guard usage text parses into its actions with their required and optional flags');
  let checked = 0;
  for (const file of ['SKILL.md', 'autopilot-protocol.md', 'task-results-protocol.md', 'reviewer-recovery.md']) {
    for (const span of guardSpans(implementText(file), actions)) {
      const named = [...span.matchAll(/--action ([a-z-]+)/g)].map((match) => match[1]);
      assert.ok(named.length <= 1, `${file}: one guard action per command span: ${span}`);
      if (named.length === 0) continue;
      const [action] = named;
      assert.ok(actions.has(action), `${file}: --action ${action} is a shipped guard action`);
      const flags = [...span.matchAll(/--([a-z-]+)/g)].map((match) => match[1]);
      for (const flag of flags) {
        if (['repo-root', 'plan', 'action'].includes(flag)) continue;
        assert.ok(actions.get(action).accepted.has(flag), `${file}: --${flag} is not an option of the guard's --action ${action}: ${span}`);
      }
      assert.equal(flags.includes('run-id'), flags.includes('attempt'), `${file}: --run-id and --attempt travel together: ${span}`);
      // A bare `--action <a>` names the action; a span with any option is a command line.
      if (span.includes('correction-guard.mjs') || flags.some((flag) => flag !== 'action')) {
        for (const flag of actions.get(action).required) {
          assert.ok(flags.includes(flag), `--${flag} is required by the guard's --action ${action}: ${span}`);
        }
        if (['autopilot-protocol.md', 'reviewer-recovery.md'].includes(file) && !IDENTITY_FREE_ACTIONS.includes(action)) {
          assert.ok(flags.includes('run-id') && flags.includes('attempt'), `an autopilot-only guard span carries --run-id and --attempt: ${span}`);
        }
      }
      checked += 1;
    }
  }
  assert.ok(checked >= 15, 'the lock actually checks the documented guard command lines');
});

test('implement: a malformed Gear-3 child envelope routes through the guard, never an unconditional autopilot exit', () => {
  const protocol = flatText(sectionBetween(implementText('SKILL.md'), '#### Artifact-first child protocol', '### Multi-task artifact-flow proof'));
  assert.doesNotMatch(protocol, /malformed envelope is never trusted: autopilot records correlated `BLOCKED` and exits/,
    'a malformed envelope no longer forces an unconditional autopilot BLOCKED exit');
  assert.match(protocol, /autopilot appends correlated `BLOCKED` only for a whole-run halt/, 'autopilot appends BLOCKED only for a whole-run halt');
  assert.match(protocol, /In Gear 3 \(both drives\) the guard records a malformed child envelope as an `INVALID` writer or review that concludes the iteration/,
    'Gear 3 records a malformed envelope as an INVALID writer or review');
  assert.match(protocol, /admitted `tool-failure` retry within the allowance[^.]*else the cycle stops task-locally/,
    'a malformed envelope is retried through a tool-failure retry or the cycle stops task-locally');
  assert.match(protocol, /Manual drive records the explicit same-session\/degraded handling in the ledger/, 'the manual ledger clause is kept');
});

test('implement: Step 2.7 opens the correction guard before any dispatch in both drives, Gear 2 unchanged', () => {
  const text = implementText('SKILL.md');
  const i25 = text.indexOf('### Step 2.5 — Pre-flight input scan');
  const i27 = text.indexOf('### Step 2.7 — Gear-3 correction guard (both drives)');
  const i3 = text.indexOf('### Step 3 —');
  assert.ok(i25 !== -1 && i27 > i25 && i3 > i27, 'Step 2.7 sits between Step 2.5 and Step 3');
  const step27 = guardStep();
  const prose = flatText(step27);
  assert.match(prose, /\*\*Gear 3 only\.\*\* Gear 2 runs no guard and is unchanged\./, 'Step 2.7 applies to Gear 3 only; Gear 2 is unchanged');
  assert.ok(step27.includes('node <engine-root>/scripts/correction-guard.mjs --repo-root . --plan <plan-path> --action open --drive <manual|autopilot>'),
    'the guard opens with the exact shipped open command');
  assert.match(prose, /Before Task 1, run/, 'the guard opens before Task 1');
  assert.match(prose, /A rejected plan stops before any dispatch with the parser message\. There is no fallback: the user re-runs the `plan` skill/,
    'a rejected plan stops before any dispatch, without fallback');
  assert.match(prose, /`\.formula\/work\/tasks\/<plan-basename>\/correction\/` are machine-replay state derived from the plan basename/,
    'guard records are machine-replay state derived from the plan basename');
  assert.match(prose, /not model read capabilities and need no new handoff role/, 'guard records grant no read capability and no handoff role');
  assert.ok(text.indexOf('--action open --drive') < text.indexOf('**Implement.**'), 'the guard opens before the implementer dispatch');
  const checklist = sectionBetween(text, '## Checklist', '## Procedure');
  assert.match(checklist, /Gear 3[^\n]*correction guard[^\n]*Step 2\.7/, 'the checklist names the Gear-3 correction guard step');
});

test('implement: next decides each Gear-3 step, and reserve and authorize precede every dispatch', () => {
  const prose = flatText(guardStep());
  assert.match(prose, /`next` decides the step/, 'next decides the step');
  assert.match(prose, /`open-cycle` opens each scope/, 'open-cycle opens each scope');
  assert.match(prose, /`reserve` runs before every dispatch/, 'reserve runs before every dispatch');
  assert.match(prose, /`authorize` binds each dispatch to its exact target/, 'authorize binds each dispatch to its exact target');
  for (const action of ['next', 'open-cycle', 'reserve', 'authorize', 'record-writer', 'verify-check', 'record-review', 'admit-retry',
    'record-diagnosis', 'prove-isolation', 'stop', 'record-interruption', 'reopen']) {
    assert.ok(prose.includes(`--action ${action}`), `Step 2.7 documents --action ${action}`);
  }
  const order = ['--action record-writer', '--action verify-check', 'dispatch the reviewer', '--action record-review'].map((s) => prose.indexOf(s));
  assert.ok(order.every((index, k) => index !== -1 && (k === 0 || index > order[k - 1])),
    'each iteration records the writer, runs verify-check, dispatches the reviewer, then records the review');
  assert.match(prose, /record the review with the defects artifact/, 'the review is recorded with its defects artifact');
  assert.match(prose, /`--role writer\|task-reviewer\|final-reviewer\|diagnostic`/, 'authorize names the guard roles exactly');
  const step3 = flatText(sectionBetween(implementText('SKILL.md'), '### Step 3', '### Step 4'));
  assert.match(step3, /Each dispatch is preceded by `reserve` and `authorize`/, 'Step 3 precedes each dispatch with reserve and authorize');
  assert.match(step3, /Mark a task complete only when the guard approves its cycle/, 'a task completes only on guard approval');
});

test('implement: the guard allowance is three iterations with one diagnosis and no separate retry allowance or spend limit', () => {
  const prose = flatText(guardStep());
  assert.match(prose, /three iterations per task cycle and per final-review cycle/i, 'three iterations per task and final-review cycle');
  assert.match(prose, /at most one diagnosis, charged to the same allowance/i, 'one diagnosis charged to the same allowance');
  assert.match(prose, /no separate fix or retry allowance/i, 'no separate fix or retry allowance');
  assert.match(prose, /No time, token or cost limit applies: token and cost stay observational/, 'no time, token or cost limit; spend stays observational');
  const results = flatText(implementText('task-results-protocol.md'));
  assert.match(results, /A retry never exceeds the cycle allowance/, 'a task-results retry never exceeds the cycle allowance');
});

test('implement: a failed iteration continues only by an admitted retry or the one diagnosis; guard stops stand', () => {
  const step27 = guardStep();
  const prose = flatText(step27);
  assert.ok(step27.includes('.formula/work/tasks/<plan-basename>/correction/<scope>-cycle-<c>-retry-<i>.json'), 'the retry request path is exact');
  for (const key of ['version', 'scope', 'cycle', 'iteration', 'kind', 'target', 'observedFailure', 'evidence', 'hypothesis', 'remedy',
    'difference', 'confirmingCheck']) {
    assert.ok(prose.includes(`\`${key}\``), `the retry request lists field ${key}`);
  }
  assert.match(prose, /exactly the twelve keys/, 'the retry request has exactly twelve keys');
  assert.match(prose, /`--kind diagnosis --reason missing-retry-evidence\|comparison-unavailable`/, 'the single diagnosis is reserved with its reason');
  assert.match(prose,
    /`diagnosis-prompt\.md` \(`model: standard`, `most-capable` for a design task\)[^.]*in autopilot through its manifest; in manual drive pass the prompt's manual fallback inputs directly[^.]*`\[DIAGNOSIS_FILE\]` set to the authorized diagnostic target[^.]*record the no-manifest degradation/,
    'the diagnosis dispatches diagnosis-prompt.md at an explicit tier, through its manifest in autopilot and its direct fallback inputs in manual drive');
  assert.match(prose, /Stagnation, exhaustion, an unavailable comparison and an inconclusive diagnosis are the guard's decision/,
    'stagnation, exhaustion and inconclusive-diagnosis stops are the guard\'s decision');
  // M-9: the check IDs and the admissible evidence of a retry request, as the reducer ships them.
  assert.match(prose, /`surface-test` and `coherence-gate` in a task cycle, `surface-test-<k>` and `coherence-gate` in the final cycle/,
    'the retry request names the shipped check IDs per scope');
  assert.match(prose, /the printed `ref` of the action that recorded it/, 'a retry cites the printed ref of the recording action');
  assert.match(prose, /after a diagnosis, the diagnosis artifact/, 'after a diagnosis the retry cites the diagnosis artifact');
  assert.match(prose, /a `tool-failure` retry cites only interruption, writer-failure or review-failure evidence/,
    'a tool-failure retry cites only interruption, writer-failure or review-failure evidence');
  // M-6: the evidence-missing stop also carries a remedy the bound plan cannot admit.
  assert.match(prose, /or the remedy is one the bound plan cannot admit \(such as a plan split\), stop the cycle/,
    'the RETRY_EVIDENCE_MISSING stop covers a remedy the bound plan cannot admit');
});

test('implement: a controller tells an unopened run from a resumed one, and Step 1 resolves outside the source tree in Gear 3', () => {
  const prose = flatText(guardStep());
  assert.match(prose, /On resume, run `--action next` first: `next: null` with head `seq: 0` means the run was never opened — run `open`; any other step resumes from it/,
    'next with head seq 0 tells an unopened run from a resumed one');
  const step1 = flatText(sectionBetween(implementText('SKILL.md'), '### Step 1', '### Step 2'));
  assert.match(step1, /in Gear 3 add `--out <dir>` outside the source tree, per Step 2\.7/, 'Step 1 carries the Gear-3 --out form of its resolve');
});

test('implement: task-local stops prove isolation and continue; exit 3 and source drift halt the whole run', () => {
  const text = implementText('SKILL.md');
  const discipline = flatText(sectionBetween(text, '## Execution discipline', '## Checklist'));
  assert.match(discipline,
    /The only reasons to stop mid-run are a whole-run halt \(guard integrity or unauthorized mutation\), a genuine human question in manual drive, a direct Gear-2 decomposition stop, or the guard's terminal step/,
    'the only mid-run stops are a whole-run halt, a manual human question, a Gear-2 decomposition stop or the terminal step');
  assert.match(discipline, /A task-local stop continues with the next runnable independent task, and dependency-blocked tasks are never dispatched/,
    'a task-local stop continues; dependency-blocked tasks are never dispatched');
  assert.doesNotMatch(discipline, /unresolved \*\*BLOCKED\*\*/, 'an unresolved BLOCKED is no longer a run stop');
  const prose = flatText(guardStep());
  assert.match(prose, /After a task-local stop, run `--action prove-isolation --scope task-N`/, 'a task-local stop proves isolation');
  assert.match(prose, /Exit 3 from any guard action halts the whole run: report it and never continue/, 'exit 3 halts the whole run');
  assert.match(prose, /source change outside an authorized writer dispatch[^.]*halts the whole run \(exit 3\) by design/,
    'a source change outside an authorized writer dispatch halts the run');
  assert.match(prose, /re-running `open` after editing files/, 'editing files then re-running open halts');
  assert.match(prose, /recording an interruption after a crashed writer left changes/, 'an interruption over a crashed writer\'s changes halts');
  assert.match(prose, /context resolution[^.]*writes its output outside the source tree/, 'context resolution writes outside the source tree');
  assert.match(prose, /`steepy-formula context resolve[^`]*--out [^`]+`/, 'the context resolve instruction carries --out');
  assert.match(prose, /after a task-local stop the next execution builds on the retained execution or on the pre-cycle lineage tip/,
    'the continuation references the lineage parent rule');
});

test('implement: Step 3 binds the guard to every dispatch and drops the task split', () => {
  const step3 = sectionBetween(implementText('SKILL.md'), '### Step 3', '### Step 4');
  const prose = flatText(step3);
  assert.doesNotMatch(prose, /re-review until \*\*Status: Approved\*\*/, 'Step 3 no longer re-reviews until a Status line');
  assert.match(prose, /re-review until the guard approves or stops the cycle/, 'Step 3 re-reviews until the guard approves or stops the cycle');
  assert.doesNotMatch(prose, /or split the task/, 'a task is never split inside an approved plan');
  assert.ok(prose.includes('or stop the cycle and record a plan split as the next remedy (the approved plan is bound; a split needs a new plan)'),
    'a split is recorded as the next remedy of a stopped cycle');
  assert.match(prose, /a split needs a new plan\) \(Gear 3; in Gear 2, which runs no guard, it is the decomposition stop\)/,
    'the cycle-stop remedy is scoped to Gear 3, and Gear 2 keeps its decomposition stop');
  assert.match(prose, /Each dispatch is preceded by `reserve` and `authorize` — one `reserve` per iteration before its first dispatch, and an `authorize` before each dispatch/,
    'reserve runs once per iteration, authorize before each dispatch');
  assert.ok(prose.includes("add `escalated: <from>→<to>` to the task's ledger line"), 'the escalation ledger marker is kept verbatim');
  assert.ok(prose.includes('Never force the same model to retry unchanged'), 'the unchanged-retry prohibition is kept verbatim');
  assert.match(prose, /In manual drive, a NEEDS_CONTEXT answered by the human is a retry whose remedy is the supplied context, and it consumes an iteration/,
    'a human-answered NEEDS_CONTEXT is a retry that spends an iteration');
});

test('implement: the final-review cycle runs on partial delivery after the summary projection', () => {
  const step4 = sectionBetween(implementText('SKILL.md'), '### Step 4', '### Step 5');
  const prose = flatText(step4);
  assert.match(prose, /The whole-branch review is the final-review cycle of three iterations, and it runs even when tasks stopped/,
    'the final-review cycle runs even when tasks stopped');
  const project = prose.indexOf('--action project --task-result-index');
  const openFinal = prose.indexOf('--action open-cycle --scope final');
  assert.ok(project !== -1 && openFinal !== -1 && project < openFinal, 'project runs before the final cycle opens');
  assert.match(prose, /before any final-review baseline and before any reviewer dispatch/, 'project precedes the final baseline and dispatch');
  assert.match(prose, /a partial index must already declare its stopped and blocked tasks/, 'a partial index declares stopped and blocked tasks');
  assert.match(prose, /Run `project` again at terminal/, 'project runs again at terminal');
  assert.match(prose, /A final fix names its approved owner task and affected criteria/, 'a final fix names its owner task and criteria');
  assert.match(prose, /A stopped or blocked deliverable is never completed this way; it needs a reopen — of the stopped task itself, or for a blocked task, of the stopped task that blocks it\./,
    'stopped work needs its own reopen, and a blocked task needs its stopped cause reopened');
  assert.doesNotMatch(prose, /re-review until \*\*Status: Approved\*\*/, 'Step 4 no longer re-reviews until a Status line');
  assert.match(prose, /until the guard approves or stops the final cycle/, 'Step 4 runs until the guard approves or stops the final cycle');
  const protocol = flatText(sectionBetween(implementText('autopilot-protocol.md'), '## Step 4', '## Step 5'));
  assert.match(protocol, /project[^.]*before the final `reviewer-response\.mjs --action begin`, and again at terminal/,
    'autopilot projects the summary before the final reviewer baseline and at terminal');
});

test('implement: defects artifacts are named per scope and role, the owner task review in a final iteration role-qualified', () => {
  const prose = flatText(guardStep());
  assert.ok(prose.includes('correction/<scope>-cycle-<c>-iteration-<i>-defects.json'), 'the plain defects name per scope');
  assert.ok(prose.includes('correction/final-cycle-<c>-iteration-<i>-task-reviewer-defects.json'),
    'an owner task review in a final-scope iteration uses the role-qualified defects name');
  assert.match(prose, /`\[DEFECTS_FILE\]`/, 'the reviewer prompt slot is filled with the defects path');
  const protocol = implementText('autopilot-protocol.md');
  const line = (marker) => protocol.split('\n').find((entry) => entry.includes(marker)) ?? '';
  assert.ok(line('--role task-reviewer').includes('--artifact-output .formula/work/tasks/<plan-basename>/correction/task-N-cycle-<c>-iteration-<i>-defects.json'),
    'the task-reviewer manifest declares its defects artifact output');
  assert.ok(line('--role final-review ').includes('--artifact-output .formula/work/tasks/<plan-basename>/correction/final-cycle-<c>-iteration-<i>-defects.json'),
    'the final-review manifest declares the plain final defects artifact output');
  assert.ok(protocol.includes('--artifact-output .formula/work/tasks/<plan-basename>/correction/final-cycle-<c>-iteration-<i>-task-reviewer-defects.json'),
    'an owner task review inside a final-scope iteration declares the role-qualified defects output');
});

test('implement: Step 5 verifies the terminal guard handoff and states a PARTIAL outcome as unapproved partial delivery', () => {
  const step5 = sectionBetween(implementText('SKILL.md'), '### Step 5 — Hand off', '## Model Selection');
  const prose = flatText(step5);
  for (const action of ['project', 'verify-handoff']) {
    assert.ok(step5.includes(`node <engine-root>/scripts/correction-guard.mjs --repo-root . --plan .formula/work/plans/<plan-basename>.md --action ${action} --task-result-index .formula/work/tasks/<plan-basename>/task-result-index.md`),
      `Step 5 runs the guard's ${action} at terminal`);
  }
  assert.match(prose, /After the guard reports `terminal`/, 'the terminal verification follows the guard terminal step');
  assert.match(prose, /unapproved partial delivery/, 'a PARTIAL outcome is unapproved partial delivery');
  assert.match(prose, /completed, stopped and blocked task IDs, the failed criteria, the best candidates and the next remedies/,
    'a PARTIAL outcome lists IDs, failed criteria, best candidates and next remedies');
  assert.match(prose, /the next remedies \(a reopen needs a remedy different from these\), and any plan split recorded in the ledger/,
    'a PARTIAL outcome also lists a ledger-recorded plan split, which the summary does not carry');
  assert.ok(prose.includes('Run the `review` skill in a new session'), 'the review handoff envelope is unchanged');
});

test('autopilot: guard actions carry correlated identity, a partial run appends PARTIAL and never DONE, and autopilot never reopens', () => {
  const protocol = implementText('autopilot-protocol.md');
  const prose = flatText(protocol);
  assert.ok(protocol.includes('<ISO timestamp> — implement — PARTIAL — run-id=<conductor-supplied> attempt=<positive supplied> <summary>'),
    'a terminal partial appends the correlated PARTIAL marker');
  assert.match(prose, /never `DONE`/, 'a partial run never appends DONE');
  assert.ok(protocol.includes('<ISO timestamp> — implement — DONE — run-id=<conductor-supplied> attempt=<positive supplied> <commit range>'),
    'the DONE marker text for complete runs is unchanged');
  assert.match(prose, /Never reopen/, 'autopilot never reopens');
  assert.doesNotMatch(prose, /unresolvable protocol failure/, 'autopilot names no undefined protocol-failure stop');
  assert.match(prose, /Only a whole-run halt \(exit 3 from any guard action\) appends/, 'autopilot appends BLOCKED mid-loop only for a whole-run halt');
  assert.match(prose, /--run-id <supplied-run-id> --attempt <supplied-attempt>[^.]*every mutating guard action and `verify-handoff`/,
    'every mutating guard action and verify-handoff carry the supplied identity');
  assert.match(prose, /`next` and `verify` take neither/, 'the read-only guard actions take no identity');
  assert.doesNotMatch(prose, /split the task/, 'autopilot never splits a task');
  assert.match(prose, /non-human remedies[^.]*only through admitted retries within the allowance/, 'autopilot remedies run only as admitted retries');
  assert.match(prose, /A task-local stop continues with the next runnable task/, 'autopilot continues after a task-local stop');
  for (const [role, output] of [['diagnosis', 'context/task-N-diagnosis-<i>.json'], ['final-diagnosis', 'context/final-diagnosis-<i>.json']]) {
    const command = protocol.split('\n').find((entry) => entry.includes(`--role ${role} `)) ?? '';
    assert.ok(command.startsWith('node <engine-root>/scripts/autopilot-context.mjs --repo-root . '), `the ${role} manifest has a canonical command`);
    assert.ok(command.includes(`--output .formula/work/tasks/<plan-basename>/${output}`), `the ${role} manifest is written at ${output}`);
    assert.match(command, /--evidence <exact-evidence-path>/, `the ${role} manifest names its evidence`);
  }
  assert.match(prose, /Repeat `--evidence` once per evidence path/, 'evidence paths repeat --evidence');
});

test('implement: reopening is manual-only with a verbatim authorization, and resume keeps counters', () => {
  const prose = flatText(guardStep());
  assert.match(prose, /#### Resume and reopening/, 'Step 2.7 carries the Resume and reopening subsection');
  assert.match(prose, /Resume never resets counters and never redispatches captured work/, 'resume keeps counters and captured work');
  assert.match(prose, /A reserved dispatch whose execution is uncertain stays spent[^.]*`--action record-interruption/,
    'an uncertain reserved dispatch stays spent and is recorded as an interruption');
  assert.match(prose, /A captured execution resumes through `task-results\.mjs`[^.]*then `record-writer`, without a new reservation/,
    'a captured execution resumes through task-results then record-writer');
  assert.ok(prose.includes('`--action stop --scope <scope> --reason HUMAN_INTERRUPTED --note <text>`'), 'an explicit user interruption is a HUMAN_INTERRUPTED stop');
  assert.match(prose, /Reopening a stopped scope happens only in manual drive/, 'reopening is manual-only');
  assert.match(prose, /explicit words naming the scope, plus a new remedy, are written verbatim to `\.formula\/work\/tasks\/<plan-basename>\/correction\/<scope>-cycle-<c>-reopen\.json`/,
    'the human authorization is written verbatim to the reopen artifact');
  assert.match(prose, /then `--action reopen --authorization [^`]+` must succeed/, 'reopen must succeed before the scope reopens');
  assert.match(prose, /Autopilot never reopens: it hands the request back to the human/, 'autopilot hands reopening back to the human');
  // I-1: the guard's reopen acceptance rules (correction-state.mjs authorizeReopen).
  assert.match(prose, /The human's words must name the scope literally, as `Task <N>` for `task-<N>` or `final review` for `final`/,
    'the reopen statement names the scope literally as Task <N> or final review');
  assert.match(prose, /The remedy must be new to the scope:[^.]*never the summary's `nextRemedy`/,
    'the reopen remedy is new to the scope, never the summary nextRemedy');
  assert.match(prose, /ask the human again; never rewrite their words/, 'words that fail the rules are asked again, never rewritten');
  assert.match(prose, /Only a stopped scope with no open cycle is reopened/, 'only a stopped scope with no open cycle is reopened');
  assert.match(prose, /A dependency-blocked task never ran and is never reopened: reopen the stopped task that blocks it/,
    'a blocked task is completed by reopening its stopped cause');
});

test('task-results protocol pins the post-stop parent rule and binds retries to the guard', () => {
  const prose = flatText(implementText('task-results-protocol.md'));
  assert.match(prose,
    /After a task-local stop, the next execution's `parentState` is the stopped cycle's retained execution \(`retained-best`\), or the lineage tip the stopped cycle started from[^.]*\(`baseline-equal`\)/,
    'after a task-local stop the parent is the retained execution or the pre-cycle lineage tip');
  assert.match(prose, /A non-accepted execution is never the parent of another task's execution/, 'a non-accepted execution never parents another task');
  assert.match(prose, /Before implement DONE or PARTIAL, run receipt verify, canonical handoff verification, reviewer verify-handoff and the guard's `verify-handoff`/,
    'the handoff checklist covers PARTIAL and the guard verify-handoff');
  assert.match(prose, /a `--role retry` execution also requires an admitted guard retry and a reserved correction iteration/,
    'a retry execution requires an admitted guard retry and a reserved correction iteration');
});

test('reviewer recovery binds every reviewer dispatch to the guard and verifies partial handoffs through the guard', () => {
  const recovery = implementText('reviewer-recovery.md');
  const prose = flatText(recovery);
  assert.match(prose, /Every reviewer dispatch is a guard-authorized dispatch in the current iteration/, 'every reviewer dispatch is guard-authorized');
  assert.match(prose, /A reviewer redispatch after a failure consumes a new iteration through an admitted `tool-failure` retry/,
    'a reviewer redispatch spends a new iteration through a tool-failure retry');
  assert.match(prose, /`--action record-review[^`]*--review-state <[^`]*--defects <[^`]*`/, 'each review is recorded with its review state and defects');
  assert.match(prose, /Partial verification uses the guard's `--action verify-handoff`/, 'partial verification uses the guard verify-handoff');
  assert.doesNotMatch(prose, /requires final approval/, 'the reviewer handoff no longer claims it always requires final approval');
  assert.match(prose, /`status: UNAPPROVED`/, 'a stopped final verifies as UNAPPROVED, never success');
  assert.match(prose,
    /owner task's review inside a final-scope iteration uses the task prefix `task-<n>-review-guard-attempt-<attempt>-iteration-<iteration>` with reviewer-response `--task <n>`, while its guard calls use `--scope final --owner-task <n>`/,
    'the reviewer-response prefix scope of an owner task review differs from its guard scope');
});

// Global graph-only lock (Task 20): no skill outside graph-migrate carries a Markdown-hub reference,
// every workflow skill stops in migrate state with the one canonical sentence, and the mode list is exact.
function skillFilesExceptMigrate(dir = skillsDir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === skillsDir && entry.name === 'graph-migrate') continue;
      out.push(...skillFilesExceptMigrate(full));
    } else if (/\.(md|json|mjs|txt|ya?ml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('global skills lock (a): no skill file outside graph-migrate references the Markdown hub, its linter, or legacy', () => {
  const files = skillFilesExceptMigrate();
  assert.ok(files.length > 20, 'the lock must actually walk the skills tree');
  const forbidden = /validate-hub|stop-hook|\.apex\/_INDEX\.md|\.apex\/standards|\.apex\/glossary\.md|\.apex\/conventions\.md|testing-and-checklist|\blegacy\b/i;
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), forbidden, `${file.slice(root.length + 1)} is graph-only`);
  }
});

test('global skills lock (b): every workflow skill and both entry skills carry the exact migrate stop sentence', () => {
  const sentence = 'Stop and tell the user to run the `graph-migrate` skill (invoke it the way your harness invokes skills) before any other workflow.';
  for (const name of ['init', 'discovery', 'brainstorm', 'plan', 'implement', 'review', 'loop-engineer', 'new-surface', 'check', 'inception']) {
    const flat = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    assert.ok(flat.includes(sentence), `${name} carries the G8 migrate stop sentence`);
  }
});

test('global skills lock (c): every skill that declares the hub mode uses the exact mode list', () => {
  const list = '`graph`, `migrate`, or `none`';
  let declaring = 0;
  for (const name of readdirSync(skillsDir)) {
    if (name === 'graph-migrate') continue;
    const path = join(skillsDir, name, 'SKILL.md');
    if (!existsSync(path)) continue;
    const flat = readFileSync(path, 'utf8').replace(/\s+/g, ' ');
    if (!flat.includes('hub-mode')) continue;
    declaring++;
    assert.ok(flat.includes(list), `${name} declares the mode with the G8 list`);
    assert.doesNotMatch(flat, /`graph`,? or `legacy`|`legacy`/i, `${name} has no other mode list`);
  }
  assert.ok(declaring >= 10, 'init, inception and the workflow skills all declare the mode');
});

test('init and inception: migrate state stops before any scaffolding or run', () => {
  const init = readFileSync(join(skillsDir, 'init', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(init, /steepy-formula hub-mode/);
  assert.match(init, /\| `hub-mode` reports `migrate` \|/);
  assert.doesNotMatch(init, /No legacy fallback/i);
  assert.match(init, /No fallback is offered\./);
  assert.match(init, /init never creates hub documents and never writes under `\.apex\/`; `\.formula\/` holds the committed binding plus the local `work\/`, `inception\/` and the init provenance receipts/);
  assert.match(init, /no `documents` step exists/);
  const inception = readFileSync(join(skillsDir, 'inception', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(inception, /neither a graph binding `\.formula\/config\.json` nor an unmigrated steepy-apex hub/);
  const step0 = inception.slice(inception.indexOf('Step 0'));
  assert.ok(step0.indexOf('steepy-formula hub-mode') !== -1 && step0.indexOf('steepy-formula hub-mode') < step0.indexOf('Stop and tell the user'),
    'inception runs hub-mode before its migrate stop');
  assert.match(inception, /exit 25/);
});

test('current export guidance states digest and chain integrity without author authentication', () => {
  for (const file of ['README.md', 'docs/getting-started.md', 'docs/architecture.md', 'skills/graph-migrate/SKILL.md']) {
    const text = readFileSync(join(root, file), 'utf8').replace(/\s+/g, ' ');
    assert.match(text, /SHA-256/i, `${file}: export integrity uses SHA-256`);
    assert.match(text, /hash.chain/i, `${file}: Revision trail is hash-chained`);
    assert.match(text, /(?:does not|do not|no|without|not)[^.]*authenticat[^.]*author|author[^.]*authenticat[^.]*(?:not|absent)/i, `${file}: digest and chain do not authenticate the author`);
    // Scope the rejection to current export claims, leaving historical quotations and Git signing alone.
    assert.doesNotMatch(text, /(?:writes? (?:the |a )?|capture a state as a \*\*|portable artifact is the |checkpoint, the )(?:\*\*)?signed (?:export|state)|artifact is signed \(digest\)/i, `${file}: current exports must not be described as cryptographically signed`);
  }
});


test('architecture scopes automatic export guarantees to configured callers', () => {
  const text = readFileSync(join(root, 'docs/architecture.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(text, /(?:configures|configur(?:ed|able))[^.]*`?exportDir`?|`?exportDir`?[^.]*configur/i, 'automatic export requires caller configuration');
  assert.match(text, /shipped CLI does not configure one today|shipped CLI[^.]*export: none/i, 'CLI does not claim automatic export');
  assert.doesNotMatch(text, /RPO\s*=\s*0\s+by construction/i, 'optional automatic exports do not establish an unconditional zero-loss guarantee');
});
