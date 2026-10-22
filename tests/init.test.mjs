import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const templates = join(root, 'templates');
const skill = () => readFileSync(join(root, 'skills', 'init', 'SKILL.md'), 'utf8');

function sectionBetween(text, startHeading, endHeading) {
  const s = text.indexOf(startHeading);
  assert.ok(s !== -1, `missing heading '${startHeading}'`);
  const e = endHeading ? text.indexOf(endHeading, s + startHeading.length) : -1;
  return e === -1 ? text.slice(s) : text.slice(s, e);
}

// --- Skill-content invariants for the graph-first init flow (spec Architecture §1) --
// init is a Markdown procedure executed by the harness; these lock the graph-first
// flow: the engine gate runs before anything is written to the repo, Step 1 routes
// IMMEDIATELY from the status decision table (a virgin graph continues, an initialized
// one re-runs as repair, a migrate state hands off to graph-migrate), detection only
// proposes, Rules enter only through human approval, and no markdown hub is ever
// scaffolded on a virgin repo (the graph IS the hub).

test('init runs the pre-flight graph gate before writing any repo scaffolding artifact', () => {
  const text = skill();
  assert.match(text, /### Step 1 — Pre-flight/, 'the procedure must open with the pre-flight hard gate');
  assert.match(text, /graph init/, 'the gate provisions the engine via graph init');
  assert.match(text, /graph status/, 'the gate reads the project state via graph status');
  assert.match(text, /before writing any repo\s+scaffolding artifact/,
    'the gate ordering must be stated explicitly: gate first, repo artifacts after');
  assert.match(text, /exit 3/, 'a refused binding / engine failure (exit 3) stops the run');
  assert.match(text, /no repo file is written before\s+this gate passes/,
    'the stop must be concrete: no work area, agents, bootstrap skill, or CLAUDE.md before the gate');
});

test('init Step 1 decides IMMEDIATELY from the status decision table', () => {
  const text = skill();
  const step1 = sectionBetween(text, '### Step 1', '### Step 2');
  assert.match(step1, /Decide IMMEDIATELY/, 'the post-status routing is an immediate decision, not deferred to Step 8');

  // the hard pre-flight failure row stays FIRST: nothing is scaffolded past a failed gate
  assert.ok(step1.indexOf('**exit 3**') < step1.indexOf('EXPECTED virgin state'),
    'the engine/credential failure row precedes the virgin row');

  // engine reachable + initialized: no -> the EXPECTED virgin state; the run CONTINUES
  const virginRow = step1.split('\n').find((line) => line.includes('EXPECTED virgin state'));
  assert.ok(virginRow, 'the decision table carries the virgin row');
  assert.match(virginRow, /`initialized: no`/, 'the virgin row keys on initialized: no');
  assert.match(virginRow, /Continue to Step 2/, 'a virgin graph continues to detection/interview/scaffolding/scenario');
  assert.doesNotMatch(virginRow, /STOP/, 'the virgin state is the fresh-init success outcome, never a stop');
  assert.match(step1, /system record is only written\s+by the first promotion apply/,
    'the rationale is stated: only the first promotion apply writes the system record');

  // initialized: yes -> an init re-run: Step 8 repair semantics, no scaffolding, no mutation
  const rerunRow = step1.split('\n').find((line) => line.includes('`initialized: yes`'));
  assert.ok(rerunRow, 'the decision table carries the re-run row');
  assert.match(rerunRow, /Jump to Step 8/, 'an already-initialized project routes to Step 8 repair semantics');
  assert.match(rerunRow, /\*\*STOP\*\*/, 'the re-run row stops before any scaffolding or graph mutation');

  // hub-mode reports migrate -> the G8 stop, above `initialized: yes`, before scaffolding or mutation
  const migrateRow = step1.split('\n').find((line) => line.startsWith('|') && line.includes('`hub-mode` reports `migrate`'));
  assert.ok(migrateRow, 'the decision table carries the migrate row');
  assert.match(migrateRow, /graph-migrate/, 'a migrate state routes to the graph-migrate skill');
  assert.match(migrateRow, /\*\*STOP\*\*/, 'the migrate row stops before any scaffolding or graph mutation');
  assert.ok(step1.indexOf('`hub-mode` reports `migrate`') < step1.indexOf('`initialized: yes`'), 'the migrate row precedes the re-run row');
  assert.match(step1, /steepy-formula hub-mode/, 'Step 1 reads the mode with hub-mode');
  assert.doesNotMatch(step1, /_INDEX\.md|markdown hub|legacy/i);
});

test('init resolves credentials only through the F1 secret-provider chain, with no fallback', () => {
  const text = skill();
  assert.match(text, /F1 secret-provider chain/, 'credentials come only from the F1 chain');
  assert.doesNotMatch(text, /--password/, 'the skill must never invent a --password flag');
  assert.match(text, /No fallback is offered\./, 'no credential fallback is offered');
});

test('init pins the .formula/config.json binding contract', () => {
  const text = skill();
  assert.match(text, /\.formula\/config\.json/, 'the committed project binding must be named');
  assert.match(text, /!\.formula\/config\.json/, 'the gitignore exception must be stated');
  assert.match(text, /--force/, 're-pointing a mismatched binding requires an explicit --force');
  assert.match(text, /idempotent/i, 'graph init provisioning must be described as idempotent');
});

test('init drives the engine: detect-stack proposals, the structural helper, preview/apply, validate, resolve', () => {
  const text = skill();
  for (const literal of [
    'detect-stack.mjs',
    'structural-promotion.mjs',
    'createScenario',
    'promotion.mjs',
    'promotion preview',
    'promotion apply',
    'graph validate',
    'context resolve',
    'project-scaffold.mjs',
    'ext_v1_command',
  ]) {
    assert.ok(text.includes(literal), `init must reference '${literal}'`);
  }
  assert.match(text, /WITHOUT `--yes`/, 'promotion apply must run without --yes so the CLI prompts on stdin');
  assert.match(text, /CLI and the shipped structural-promotion\s+helper/,
    'the machines are named: the CLI and the shipped structural-promotion helper');
  assert.match(text, /the only machines the skill\s+touches/, 'nothing else is a machine — the skill re-implements no core logic');
});

test('init hard gate — never invents Rules from stack detection', () => {
  const text = skill();
  assert.match(text, /never invent Rules/i, 'the never-invent-Rules gate must be stated explicitly');
  assert.match(text, /Rules enter the graph only/i,
    'Rules must enter the graph only through the human-approved interview + scenario');
  assert.match(text, /PROPOSED/i, 'detected surfaces/components must be proposed, never final');
  assert.match(text, /If the human approves no Rules, the graph carries none/,
    'zero approved Rules must mean zero Rules carried');
});

test('init Step 4 leaves CLAUDE.md to the planner\'s claude-import operation, never a renderer write', () => {
  // A whole-file render-claude-md.mjs write after the planner apply replaced the managed
  // `@AGENTS.md` import with the retired `steepy:start` navigation document, so Claude no longer
  // loaded the AGENTS.md spine. The planner is the only CLAUDE.md writer.
  const text = skill();
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  const flat = step4.replace(/\s+/g, ' ');
  assert.match(flat, /`CLAUDE\.md` at the repo root is the planner's own `claude-import` operation/,
    'CLAUDE.md is named as the planner operation');
  assert.match(flat, /managed `@AGENTS\.md` import block/, 'the channel imports the AGENTS.md spine');
  assert.match(flat, /The planner is the only `CLAUDE\.md` writer/, 'no second writer exists');
  assert.match(flat, /retired `steepy:start` navigation channel is a `customized` conflict/,
    'a retired navigation channel resolves only through the emitted conflict choices');
  assert.doesNotMatch(text, /render-claude-md/, 'init never invokes the CLAUDE.md renderer');
  assert.doesNotMatch(text, /--upsert/, 'init offers no renderer upsert');
  assert.doesNotMatch(text, /\*\*overwrite\*\*/, 'init offers no whole-file overwrite of CLAUDE.md');
});

// Task 18 (apex v0.9.4 C4 pointers): init keeps its graph-first prose, but the
// portable scaffold is now generated through the common planner, and the
// bootstrapped navigation names hub-mode + context resolve in graph mode.
test('init Step 4 generates the portable scaffold through project-scaffold.mjs; the bootstrapped nav names hub-mode + context resolve', () => {
  const text = skill();
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.match(step4, /project-scaffold\.mjs/, 'the portable scaffold is generated through the planner, not hand-copied');
  assert.match(step4, /--hub <repo-root> --model <planner-model-json>/, 'the planner is driven through its public CLI');
  assert.match(step4, /--apply/, 'the planner apply channel is named');
  assert.ok(
    step4.indexOf('--model <planner-model-json>') < step4.indexOf('--apply'),
    'preview must precede apply',
  );
  assert.match(step4, /hubMode: 'graph'/, 'the planner model commits to the graph hub channel');
  assert.match(step4.replace(/\s+/g, ' '), /`projectId` qualifies the specialists' surface targets \(`apex:<projectId>:surface:<name>`\)/,
    'the planner model carries the bound project id for the adapter targets');
  assert.match(step4, /\.agents\/skills\/<projectName>-bootstrap\/SKILL\.md/,
    'the canonical project bootstrap path is named');
  assert.match(step4, /specialist adapter triads/, 'the per-surface specialist triads are planner-generated');
  assert.match(step4, /steepy-formula hub-mode/, 'the bootstrapped navigation names hub-mode');
  assert.match(step4, /steepy-formula context resolve/, 'the bootstrapped navigation names context resolve');
  assert.match(step4, /owns\s+their\s+generated\s+provenance/i, 'generated provenance stays with the planner');
  assert.doesNotMatch(step4, /bootstrap-skill-graph\.md/,
    'the hand-copied bootstrap template pointer is gone');
  assert.doesNotMatch(step4, /surface-agent-graph\.md/,
    'the hand-rendered agent template pointer is gone');
});

test('init Step 5 drives the structural-promotion helper, never a hand-built scenario', () => {
  const text = skill();
  const step5 = sectionBetween(text, '### Step 5', '### Step 6');

  // the corrected factual ground: promotion create EXISTS but carries only typed candidates
  assert.match(step5, /`promotion create`/, 'the shipped promotion create command is acknowledged');
  assert.match(step5, /typed knowledge candidates/, 'its closed vocabulary is named as the reason for the helper');
  assert.match(step5, /`term`\/`rule`\/`decision`\/`readme`/, 'the closed kind vocabulary is pinned');
  assert.doesNotMatch(text, /no create command/, "the false 'no create command' claim is gone");

  // the helper is the machine: structural input written under the gitignored work area
  assert.match(step5, /structural-promotion\.mjs/, 'the helper is invoked, its mapping never rebuilt agent-side');
  assert.match(step5, /\.formula\/work\/init-structural\.json/, 'the structural input is a local, gitignored work artifact');
  assert.match(step5, /createScenario/, 'the helper creates the draft through the core library');
  assert.match(step5, /Write `testCommand` ONLY for a surface whose verification Rule the human approved/,
    'the reachability judgment gates which surfaces carry a testCommand');
  assert.match(step5, /ext_v1_command/, 'the approved test command is persisted on the Check as ext_v1_command');

  // preview and apply flow through the ordinary promotion commands
  const step6 = sectionBetween(text, '### Step 6', '### Step 7');
  assert.match(step6, /promotion preview <scenario-id>/, 'preview flows through the shipped CLI');
  assert.match(step6, /promotion apply <scenario-id>/, 'apply flows through the shipped CLI');

  // and the Step 7 gate reads the command back from resolved context
  const step7 = sectionBetween(text, '### Step 7', '### Step 8');
  assert.match(step7, /ext_v1_command/, 'the resolved context must carry the Check with its ext_v1_command');
});

test('init Step 7 closure gate resolves each confirmed surface by its deterministic --target id — --path stays expectedly UNRESOLVED', () => {
  const text = skill();
  const step7 = sectionBetween(text, '### Step 7', '### Step 8');
  assert.match(step7, /context resolve --target apex:<projectId>:surface:<slug\(name\)>/,
    'the closure gate resolves deterministic surface targets, not representative paths');
  assert.match(step7, /one resolve per confirmed surface/,
    'every confirmed surface must be resolved by its target');
  assert.match(step7, /structural-promotion\.mjs/,
    'the target ids follow the structural convention of the helper that minted them');
  assert.match(step7, /ext_v1_command/, "each resolved context must carry the Check's ext_v1_command");
  assert.match(step7, /`--path` resolution is NOT\s+part of this gate/,
    'the gate must state that --path resolution is not part of it');
  assert.match(step7, /exits 10 UNRESOLVED/,
    'the gate must say a path resolve exits 10 UNRESOLVED on a freshly initialized graph');
  assert.match(step7, /expected on a freshly initialized graph, not an error/,
    'the missing topology bridge is expected, never a gate failure');
  assert.match(step7, /topology bridge/,
    'the reason is named: no topology bridge links Packages to the curated Components yet');
  assert.doesNotMatch(step7, /--path <representative-path>/,
    'the old path-based gate — which a fresh graph-first init fails by construction — must be gone');
});

test('init builds the whole curated skeleton through one promotion scenario', () => {
  const text = skill();
  const step5 = sectionBetween(text, '### Step 5', '### Step 6');
  assert.match(step5, /apex:<projectId>:project:root/, 'the Project root node id must be pinned');
  assert.match(step5, /PART_OF/, 'Surfaces/Components anchor via PART_OF');
  assert.match(step5, /APPLIES_TO/, 'Rules anchor via APPLIES_TO');
  assert.match(step5, /VERIFIED_BY/, 'Checks anchor via VERIFIED_BY from the verification Rule');
  assert.match(step5, /USED_BY/, 'Terms anchor via USED_BY from the Project root');
  assert.match(step5, /nothing applied/i, 'creating the scenario writes nothing to the stable graph');
});

test('init interviews the git policy as a Rule and the per-surface verification Rules with their Checks', () => {
  const text = skill();
  assert.match(text, /git policy/i);
  assert.match(text, /APPLIES_TO`? every confirmed Surface/,
    'the git policy is offered as a Rule candidate applying to every confirmed Surface');
  assert.match(text, /changes on <surface> pass\s+`<testCmd>`/,
    'the per-surface verification Rule default proposal must be pinned verbatim');
  assert.match(text, /a Check lands( in the graph)? only when its surface's verification Rule is approved/i,
    'the Check reachability judgment must be stated');
});

test('init creates a gitignored .formula/work area and never registers specs/plans sub-indexes', () => {
  const text = readFileSync(join(root, 'skills', 'init', 'SKILL.md'), 'utf8');
  assert.match(text, /\.formula\/work\/\.gitignore/);
  assert.match(text, /\*\n!\.gitignore/);
  assert.match(text, /\.formula\/work\/specs\//);
  assert.match(text, /\.formula\/work\/plans\//);
  assert.doesNotMatch(text, /templates\/specs-index\.md/);
  assert.doesNotMatch(text, /templates\/plans-index\.md/);
});

test('init never scaffolds a markdown hub', () => {
  const text = skill();
  const step4 = sectionBetween(text, '### Step 4', '### Step 5');
  assert.doesNotMatch(text, /_INDEX\.md/, 'init never names the Markdown index');
  assert.match(step4.replace(/\s+/g, ' '), /init never creates hub documents and never writes under `\.apex\/`; `\.formula\/` holds the committed binding plus the local `work\/`, `inception\/` and the init provenance receipts/,
    'the scaffolding step states that formula\'s local areas live under .formula/, never .apex/');
  assert.doesNotMatch(text, /new-surface\.mjs/, 'the planner generates the scaffold, not the new-surface scaffolder');
  assert.doesNotMatch(text, /\{\{gitPolicyDirective\}\}/, 'git policy is a graph Rule candidate, not a markdown placeholder');
});

test('init repair semantics — initialized graph reports only; a migrate state hands off to graph-migrate', () => {
  const text = skill();
  const step8 = sectionBetween(text, '### Step 8', '### Step 9');
  assert.match(step8, /Step 1's decision table routes here/, 'Step 8 is reached only through the Step 1 routing');
  assert.match(step8, /report only/i, 'an already-initialized graph gets a status/validate report only');
  assert.match(step8, /no re-scaffold/i, 'an already-initialized graph must not be re-scaffolded');
  assert.match(step8, /`hub-mode` reports `migrate`/, 'the migrate branch is keyed on hub-mode');
  assert.match(step8, /do not repair or migrate/i, 'init neither repairs nor migrates a Markdown hub');
  assert.match(step8, /graph-migrate/, 'the migrate branch hands off to the graph-migrate skill');
  assert.match(step8, /stop/i, 'the migrate branch stops after the pointer');
});

function jsonBlockAfter(text, heading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `missing heading '${heading}'`);
  const match = text.slice(start).match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, `missing JSON block after '${heading}'`);
  return JSON.parse(match[1]);
}

// C6 (apex v1.2.0 inception): init adds a certificate around the existing interview/planner
// procedure. Formula: init is graph-first, so the certificate binds the graph-mode scaffold
// operations and no Markdown hub document; the stable knowledge lands through the Step 6 promotion.
test('init prepares the graph-mode governance after zero-conflict preview and before apply, then finishes before the graph gates', () => {
  const text = skill();
  const verify = 'node <engine-root>/scripts/inception-state.mjs verify-complete --repo-root <repo-root>';
  const prepare = 'node <engine-root>/scripts/inception-governance.mjs prepare --repo-root <repo-root> --input <governance-input-json>';
  const apply = 'applyProjectScaffold({ hubRoot: repoRoot, plan })';
  const finish = 'node <engine-root>/scripts/inception-governance.mjs finish --repo-root <repo-root>';
  for (const command of [verify, prepare, apply, finish]) assert.ok(text.includes(command), `document ${command}`);
  assert.ok(text.indexOf('Continue until `conflicts`') < text.indexOf(prepare));
  assert.ok(text.indexOf(verify) < text.indexOf(prepare), 'the read-only gate precedes prepare');
  assert.ok(text.indexOf(prepare) < text.indexOf(apply), 'prepare precedes any planner writes');
  assert.ok(text.indexOf(apply) < text.indexOf(finish));
  assert.ok(text.indexOf(finish) < text.indexOf('### Step 5'), 'the certificate closes before the promotion is built');
  assert.ok(text.indexOf(finish) < text.lastIndexOf('steepy-formula graph validate'));
  assert.ok(!text.includes('inception-governance.mjs documents'), 'there is no documents step');
  const input = jsonBlockAfter(text, '#### Governance input shape');
  assert.deepEqual(Object.keys(input), ['schema', 'runId', 'completion', 'projectModel', 'documents']);
  assert.equal(input.schema, 'steepy-inception-governance-input/v1');
  assert.deepEqual(Object.keys(input.projectModel), ['projectName', 'projectId', 'description', 'devCommands', 'surfaces', 'resolutions', 'hubMode']);
  assert.equal(input.projectModel.hubMode, 'graph');
  assert.deepEqual(input.documents, []);
  const flat = text.replace(/\s+/g, ' ');
  assert.match(flat, /Graph mode certifies no Markdown hub document/);
  assert.match(flat, /\.formula\/work\/init\/.*governance-input\.json/);
  assert.match(flat, /never write this input inside the completed run/i);
  assert.match(flat, /any other `CLAUDE\.md` write would be application drift/i);
  assert.match(flat, /\.formula\/` is a reserved area of inception snapshots/);
});

test('init gives canonical receipt recovery precedence and keeps ordinary repair available', () => {
  const flat = skill().replace(/\s+/g, ' ');
  assert.match(flat, /steepy-inception-run\/v2.*complete/);
  assert.match(flat, /init-provenance\.pending\.json.*init-provenance\.json/);
  assert.match(flat, /before a fresh `verify-complete` gate: a pending receipt/i);
  assert.match(flat, /same retained governance input bytes/i);
  assert.match(flat, /ordinary repair is not certified/i);
  assert.match(flat, /Never exclude an entire provider directory/i);
  assert.match(flat, /verify-complete --repo-root <repo-root>/);
  assert.match(flat, /Never list `\.formula\/inception\/` or read its document bodies for init/);
});

test('T11-R1 pending branch skips fresh work and applies a validated retained operation plan', () => {
  const text = skill(); const flat = text.replace(/\s+/g, ' ');
  assert.match(flat, /pending init, jump directly to \*\*Pending certification recovery\*\*/i);
  assert.match(flat, /Skip Steps 2 and 3, fresh detection\/interview, model projection, and fresh preview/i);
  assert.match(flat, /scaffold-plan\.json/);
  assert.match(flat, /init-structural\.json/);
  assert.match(flat, /original zero-conflict plan.*before prepare/i);
  assert.match(flat, /validateProjectScaffoldPlan/);
  assert.match(flat, /applyProjectScaffold/);
  assert.match(flat, /Do not run `project-scaffold\.mjs --model \.\.\. --apply` for recovery/i);
});
