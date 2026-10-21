import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOGFOOD_CHECKPOINT_PRESENT, DOGFOOD_CHECKPOINT_SKIP, readDogfoodRecords } from './helpers/dogfood-checkpoint.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');
// Formula: the stable knowledge lives in the canonical graph, not in `.apex/*.md`. The inception
// glossary, conventions and standards that apex locks in its Markdown hub are locked here in the
// local-only dogfood checkpoint, where the apex v1.2.0 port promoted them (r20). Without it the
// graph tests skip with the explicit DOGFOOD_CHECKPOINT_SKIP reason; the doc tests always run.
const checkpoint = DOGFOOD_CHECKPOINT_PRESENT ? readDogfoodRecords() : [];
const curated = new Map(checkpoint
  .filter((record) => record.recordType === 'node' && record.namespace === 'curated' && record.properties?.status !== 'superseded')
  .map((record) => [record.id.replace(/^apex:steepy-formula:/, ''), record]));
const definition = (local) => curated.get(`term:${local}`)?.properties?.ext_v1_definition ?? null;
const statement = (local) => (curated.get(`rule:${local}`)?.properties?.statement ?? '').replace(/\s+/g, ' ');
const appliesTo = (local) => checkpoint
  .filter((record) => record.recordType === 'edge' && record.type === 'APPLIES_TO' && record.fromId === `apex:steepy-formula:rule:${local}`)
  .map((record) => record.toId.replace(/^apex:steepy-formula:/, ''));

test('the graph defines every inception term', { skip: DOGFOOD_CHECKPOINT_SKIP }, () => {
  for (const term of ['inception-run', 'run-descriptor', 'representative-path', 'decision-register',
    'effect-log', 'inception-checkpoint', 'resume-note', 'inception-source']) {
    assert.ok(definition(term), `term:${term} must be promoted`);
  }
  assert.match(definition('inception-run'), /handoff[\s\S]*workflow envelope/i);
  assert.match(definition('run-descriptor'), /\.apex\/inception\/run\.json[\s\S]*inception-state\.mjs/);
  assert.match(definition('decision-register'), /DR-n/);
  assert.match(definition('effect-log'), /append-only[\s\S]*intent[\s\S]*outcome[\s\S]*workflow event log/i);
  assert.match(definition('inception-checkpoint'), /immutable[\s\S]*digest[\s\S]*non-blocking checkpoint/i);
  assert.match(definition('inception-source'), /discovery[\s\S]*complete/i);
  assert.equal(curated.get('skill:inception')?.properties?.status, 'active', 'skill:inception must be promoted');
});

test('the chain/standalone term places inception outside both families', { skip: DOGFOOD_CHECKPOINT_SKIP }, () => {
  const entry = definition('chain-skill-standalone-skill');
  assert.ok(entry);
  assert.match(entry, /`inception`[\s\S]*pre-hub[\s\S]*outside/i);
  assert.match(entry, /five/i);
  assert.match(entry, /loop-engineer/);
  assert.match(entry, /gear 4/i);
  assert.match(entry, /eleven canonical skills/);
});

test('the inception placement rule states the substance rules', { skip: DOGFOOD_CHECKPOINT_SKIP }, () => {
  const rule = statement('inception-is-a-pre-hub-run-outside-the-chain');
  assert.deepEqual(appliesTo('inception-is-a-pre-hub-run-outside-the-chain'), ['surface:project']);
  assert.match(rule, /not a gear[\s\S]*outside the chain[\s\S]*headless/i);
  assert.match(rule, /`\.apex\/inception\/`/);
  assert.match(rule, /own `\.gitignore` \(`\*`\) written first/);
  assert.match(rule, /stable links into it are errors/);
  assert.match(rule, /`\.apex\/inception\/run\.json`[\s\S]*`scripts\/inception-state\.mjs`/);
  assert.match(rule, /`\.apex\/inception\/abandoned\/<run-id>\/`[\s\S]*deletes nothing/i);
  assert.match(rule, /never creates hub knowledge/i);
  assert.match(rule, /inception → `init` → `discovery` \(inception source\) → gears/);
  assert.match(rule, /single human approval[\s\S]*digests[\s\S]*never self-approves/i);
  assert.match(rule, /`\.formula\/` is a reserved area[\s\S]*`\.formula\/config\.json` graph binding counts as an existing hub/);
  const evidence = statement('inception-evidence-is-exact-and-never-replayed');
  assert.match(evidence, /intent before and an outcome after[\s\S]*uncertain effect is never repeated/i);
  assert.match(evidence, /every required automatic and manual check/);
  const source = statement('discovery-inception-source-lands-through-one-graph-promotion');
  assert.match(source, /`verified`[\s\S]*`rule`[\s\S]*`unverified`[\s\S]*design choice[\s\S]*`future`[\s\S]*never a rule, a spec, or a started task/);
  assert.match(source, /accepted or rejected with a reason/);
  assert.match(source, /Candidate text never names `\.apex\/inception\/`/);
});

test('scripts and tests knowledge carry the inception pointers', { skip: DOGFOOD_CHECKPOINT_SKIP }, () => {
  const hub = statement('scripts-validate-hub-mjs-exits-0-coherent-no-hub-or-1-violations');
  assert.match(hub, /exits 0 for a coherent hub, no hub, a pre-hub inception run/);
  assert.match(hub, /never follow a descendant symlink into `\.apex\/work`, `\.apex\/inception`/);
  assert.match(statement('graph-init-after-inception-certifies-scaffold-only'), /empty Markdown document set/);
  assert.match(statement('hermetic-tests-are-never-native-evidence'), /eleven-skill/);
  assert.match(statement('hermetic-tests-are-never-native-evidence'), /native inception acceptance stays NOT RUN/);
});

test('no curated graph text links into .apex/inception/', { skip: DOGFOOD_CHECKPOINT_SKIP }, () => {
  for (const [id, record] of curated) {
    for (const value of Object.values(record.properties ?? {})) {
      if (typeof value === 'string') assert.doesNotMatch(value, /\]\([^)]*\.apex\/inception\//, `${id} links into the inception area`);
    }
  }
});

const readme = read('README.md');
const guideDoc = () => read('docs', 'inception.md');
const norm = (text) => text.replace(/\s+/g, ' ');

test('README lists inception first and links its guide', () => {
  const skillsTable = readme.slice(readme.indexOf('## Skills'), readme.indexOf('## Data and external services'));
  const rows = skillsTable.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Skill') && !line.startsWith('|---'));
  assert.equal(
    rows[0],
    '| [`/steepy-formula:inception`](docs/inception.md) | Turn an idea and its materials into a verified first version before the hub exists. |',
  );
  const getStarted = readme.slice(readme.indexOf('## Get started'), readme.indexOf('## Skills'));
  assert.match(norm(getStarted), /starting from an idea or a prototype\? run `\/steepy-formula:inception` first\. it ends by pointing to `\/steepy-formula:init` and `\/steepy-formula:discovery`/i);
});

test('README external-services table names inception reach and authorization', () => {
  const section = readme.slice(readme.indexOf('## Data and external services'), readme.indexOf('## Documentation'));
  const row = section.split('\n').find((line) => line.startsWith('| `/steepy-formula:inception`'));
  assert.ok(row, 'inception row missing');
  assert.match(row, /official project documentation and package registries/i);
  assert.match(row, /Git hosting only after your authorization/i);
  assert.match(row, /research queries and installs/i);
  assert.match(row, /only after you authorize each one/i);
});

test('workflow doc places inception before the hub and outside the gears', () => {
  const workflow = read('docs', 'workflow.md');
  const start = workflow.indexOf('## Before the hub: inception');
  assert.ok(start >= 0);
  assert.ok(start < workflow.indexOf('## Every task gets classified'));
  const section = norm(workflow.slice(start, workflow.indexOf('## Every task gets classified')));
  assert.match(section, /before a hub exists/i);
  assert.match(section, /not a gear/i);
  assert.match(section, /not part of the Gear-3 chain/i);
  assert.match(section, /different artifacts/i);
  assert.match(section, /\[inception guide\]\(inception\.md\)/);
});

// Formula: eleven skills (graph-migrate included); dsh and OpenCode register `steepy-formula-<skill>`.
test('architecture doc counts eleven skills, lists the helper, and has the effects row', () => {
  const architecture = read('docs', 'architecture.md');
  assert.match(architecture, /the 11 skills/);
  assert.doesNotMatch(architecture, /\bnine\b/i);
  assert.match(architecture, /registers eleven `steepy-formula-<skill>` commands/);
  assert.match(architecture, /\| `inception-state\.mjs` \|/);
  assert.match(architecture, /\| Inception \| Writes `\.apex\/inception\/` and the application's files; runs the approved tools \(installs, generators, builds, tests\); may reach official sources and package registries; remote operations only after explicit authorization\. \|/);
  assert.doesNotMatch(read('docs', 'installation.md'), /\bnine\b/i);
});

test('installation guide gives inception syntax for every harness and an upgrade section', () => {
  const installation = read('docs', 'installation.md');
  const firstRun = installation.slice(installation.indexOf('## First run and troubleshooting'));
  for (const command of ['`/steepy-formula:inception`', '`$inception`', '`/steepy-formula-inception`', '`/skill:inception`', '`skill: "inception"`']) {
    assert.ok(firstRun.includes(command), `first-run table gives ${command}`);
  }
  assert.match(installation, /## Upgrading an existing hub[\s\S]*is customized[\s\S]*`replace`/);
  assert.match(readme, /\(docs\/installation\.md#upgrading-an-existing-hub\)/);
  assert.doesNotMatch(readme, /\*\*Version \d/, 'README must not pin a version that the bump does not update');
});

test('inception guide covers the flow, helper, harnesses, and limits', () => {
  const guide = norm(guideDoc());
  for (const harness of ['Claude Code', 'Codex', 'OpenCode', 'Pi', 'DeepSeek Harness']) {
    assert.ok(guide.includes(harness), `guide names ${harness}`);
  }
  assert.match(guide, /no headless or autopilot mode on any harness/i);
  assert.match(guide, /three sessions[\s\S]*two pauses/i);
  assert.match(guide, /`\.apex\/inception\/run\.json`/);
  assert.match(guide, /`\.apex\/inception\/project\/decision-register\.md`/);
  assert.match(guide, /`configured`[\s\S]*`executed`[\s\S]*`succeeded`[\s\S]*`not-executed`[\s\S]*`failed`/);
  assert.match(guide, /`verified`[\s\S]*`unverified`[\s\S]*`future`/);
  assert.match(guide, /`--option=<value>`/);
  assert.match(guide, /symlinked ancestor directory[\s\S]*named twice/i);
  assert.match(guide, /canonical[\s\S]*key order/i);
  assert.match(guide, /missing `_INDEX\.md`/);
  assert.match(guide, /no preset (application )?stack/i);
  assert.match(guide, /deferred/i);
  assert.match(guide, /delete[\s\S]*after (the )?discovery/i);
  for (const cmd of ['classify', 'start', 'transition', 'resume-note', 'approve', 'verify-approval',
    'effect intent', 'effect outcome', 'effect status', 'checkpoint create', 'checkpoint verify', 'abandon']) {
    assert.ok(guide.includes(`inception-state.mjs ${cmd}`), `guide lists ${cmd}`);
  }
});

test('community and security copy count eleven skills with inception first', () => {
  const community = read('COMMUNITY_SUBMISSION.md');
  assert.match(community, /- Eleven canonical skills: `\/steepy-formula:inception`, `\/steepy-formula:init`/);
  assert.match(community, /\*\*Command-family effects matrix:\*\*[^\n]*inception runs/);
  assert.match(read('SECURITY.md'), /inception runs[^\n]*\n?[^\n]*native\s+installation\/canaries|native\s+installation\/canaries[^\n]*inception runs|inception runs/);
});

test('RELEASE.md confirms eleven commands including inception', () => {
  const release = read('RELEASE.md');
  assert.match(release, /Confirm all eleven commands:/);
  assert.match(release, /```text\n\/steepy-formula:inception\n\/steepy-formula:init\n/);
});

test('acceptance protocol covers both scenarios, evidence matrix, and setup rule', () => {
  const doc = norm(read('docs', 'inception-acceptance.md'));
  assert.match(doc, /release gate after review/i);
  assert.match(doc, /not a review criterion/i);
  assert.match(doc, /Scenario A[\s\S]*empty repository[\s\S]*`init`[\s\S]*`discovery`[\s\S]*inception source/i);
  assert.match(doc, /Scenario B[\s\S]*starter[\s\S]*(design system|prototype)[\s\S]*`init`[\s\S]*`discovery`[\s\S]*inception source/i);
  assert.match(doc, /`git clone`[\s\S]*validate-hub\.mjs \.`[\s\S]*OK[\s\S]*without `\.apex\/inception\/` and `\.apex\/work\/`[\s\S]*`steepy-formula graph validate` is clean/i);
  assert.match(doc, /interruption[\s\S]*between an effect's intent and its outcome[\s\S]*new session/i);
  assert.ok(doc.includes('| Run | Harness version | Plugin commit | Capabilities | Observed outcome | Observed human approver |'));
  for (const row of ['Claude Code A (with interruption)', 'Claude Code B', 'Codex A', 'Codex B']) {
    assert.match(doc, new RegExp(`\\| ${row.replace(/[()]/g, '\\$&')} \\|[^\\n]*NOT RUN`), `${row} row is NOT RUN`);
  }
  assert.match(doc, /hand-written command sequence[\s\S]*not a proof/i);
  assert.match(doc, /model's approval is never recorded as a human approver/i);
  assert.match(doc, /packaged plugin[\s\S]*installed steepy-formula release[\s\S]*disabled[\s\S]*`missing _INDEX\.md`/i);
  assert.match(doc, /Scenario C is deferred out of v1/i);
  assert.match(norm(guideDoc()), /\[native acceptance protocol\]\(inception-acceptance\.md\)/);
});

test('v2 guide binds completion to approved checks and captured evidence, never editable results', () => {
  const guide = norm(guideDoc());
  for (const schema of ['steepy-inception-run/v2', 'steepy-inception-checks/v2', 'steepy-inception-capture/v2']) assert.ok(guide.includes(schema));
  assert.match(guide, /required[\s\S]*automatic[\s\S]*manual[\s\S]*both/i);
  assert.match(guide, /all required automatic and manual checks[\s\S]*new cycle/i);
  assert.match(guide, /verification\/results\.md[\s\S]*projection[\s\S]*never edit/i);
  assert.match(guide, /capture-inception-evidence\.mjs[\s\S]*stdout\.bin[\s\S]*stderr\.bin[\s\S]*exit 0[\s\S]*red/i);
  assert.doesNotMatch(guide, /--verification\b|checkpoint create[^|\n]*--file\b/);
  for (const command of ['inspect', 'resume-check', 'unit begin', 'unit finish', 'unit reconcile', 'unit close-incomplete', 'publish resume', 'block resolve', 'effect reconcile', 'verification begin', 'verification resume', 'verification attest', 'verification status', 'verification summarize', 'verify-complete']) {
    assert.ok(guide.includes(`inception-state.mjs ${command}`), `guide lists ${command}`);
  }
});

test('v2 recovery distinguishes proven observation from replay and writer takeover', () => {
  const guide = norm(guideDoc());
  assert.match(guide, /Resume decision table[\s\S]*pending[\s\S]*reservation/i);
  assert.match(guide, /automatically[\s\S]*correlation[\s\S]*ambiguous[\s\S]*human/i);
  assert.match(guide, /writerStopped[\s\S]*verbatim[\s\S]*live or unverifiable PID/i);
  assert.match(guide, /--previous-unit[\s\S]*new ID[\s\S]*never infer/i);
  assert.match(guide, /abandon-intent\.json[\s\S]*after.*run\.json[\s\S]*no automatic restart/i);
});

test('v2 post-complete docs preserve the original init plan and reject source drift', () => {
  const guide = norm(guideDoc());
  assert.match(guide, /init-provenance\.pending\.json[\s\S]*init-provenance\.json/);
  assert.match(guide, /original validated plan[\s\S]*public.*apply[\s\S]*not.*replan/i);
  assert.match(guide, /managed block[\s\S]*prefix[\s\S]*suffix/i);
  assert.match(guide, /application drift[\s\S]*ordinary discovery[\s\S]*no.*fallback/i);
  assert.match(guide, /unsupported run format[\s\S]*refuses[\s\S]*No tool migrates, archives, deletes/);
  const architecture = read('docs', 'architecture.md');
  for (const module of ['inception-protocol.mjs', 'inception-snapshot.mjs', 'capture-inception-evidence.mjs', 'inception-governance.mjs']) assert.ok(architecture.includes(`| \`${module}\` |`));
  const protocolRow = architecture.split('\n').find(line => line.startsWith('| `inception-protocol.mjs` |'));
  assert.match(protocolRow, /token-bound publication/i);
  assert.doesNotMatch(protocolRow, /does not write files/i);
});

test('native protocol requires every recovery and verification case without claiming execution', () => {
  const doc = norm(read('docs', 'inception-acceptance.md'));
  for (const phase of ['reconnaissance', 'architecture', 'research', 'approval', 'bootstrap', 'verification', 'complete']) assert.ok(doc.includes(phase));
  assert.match(doc, /automatically[\s\S]*correlation[\s\S]*ambiguous[\s\S]*human/i);
  assert.match(doc, /required check fails[\s\S]*manual.*missing[\s\S]*all required automatic and manual/i);
  assert.match(doc, /init-provenance[\s\S]*application drift[\s\S]*ordinary discovery[\s\S]*abandon.*--resume/i);
  assert.doesNotMatch(doc, /must not mark it succeeded without a human decision/i);
});

test('pre-merge rules agree across skills and guides', () => {
  // Formula: init is graph-first and certifies no Markdown document, so it never runs `documents`.
  const init = norm(read('skills', 'init', 'SKILL.md'));
  assert.ok(!init.includes('inception-governance.mjs documents --repo-root'));
  assert.match(init, /Graph mode certifies no Markdown hub document/);
  assert.match(init, /`inception-governance\.mjs documents` command has nothing to write and is not run/);
  const inception = norm(read('skills', 'inception', 'SKILL.md'));
  assert.match(inception, /Git status leaves out the same reserved areas, recognized scaffold leases and approved exclusions/i);
  assert.match(inception, /recognized scaffold lease is not divergence/i);
  assert.doesNotMatch(inception, /with only reserved protocol areas excluded/i);
  assert.match(inception, /Before approval the helper inventories `\.` excluding only the reserved protocol areas, recognized scaffold leases and the exclusions bound at `start`; Gitignore is not the inventory rule/i);
  assert.match(inception, /contract's exclusions replace the start ones/i);
  // Literal to the helper is not literal to the shell or Git: the skill quotes and uses literal pathspecs.
  assert.match(inception, /Single-quote every path argument/);
  assert.match(inception, /git add -- ':\(literal\)<path>'/);
  assert.match(inception, /new decision document[\s\S]*only in the approval phase/i);
  assert.match(inception, /A blocked run with a divergent approval still takes `transition --to active` and then `transition --to approval`: neither compares the working documents/);
  assert.match(inception, /Older approvals and a reserved completion verify their frozen copies/);
  assert.match(inception, /Changes outside the intent scope never prevent recording the observed result/);
  assert.match(inception, /only the human accepts those paths, through `unit reconcile` with their explicit statement/);
  const discovery = norm(read('skills', 'discovery', 'SKILL.md'));
  assert.match(discovery, /does not cover every registered decision document/i);
  assert.match(discovery, /uncovered decision/);
  const guide = norm(read('docs', 'inception.md'));
  assert.match(guide, /A recognized lease is a repository-root directory/);
  for (const suffix of [/\.stale-<token>/, /\.retired-<token>/, /\.candidate-<pid>-<token>/]) assert.match(guide, suffix);
  assert.match(guide, /Git status uses the same excluded set as the inventory/);
  assert.match(guide, /the helper never reads a path, exclusion or allowed path as a pattern/);
  assert.match(guide, /covered by the latest approval/);
  assert.match(guide, /outcome records the observed result even when the effect changed paths outside its declared scope/);
  assert.match(guide, /a blocked run with an edited approved document can still return to approval; a reserved completion binds from the frozen copies/);
  assert.match(guide, /While that intention is prepared, `classify` reports `resume-abandon` and every other `inception-state\.mjs` writer refuses/);
  assert.match(guide, /It promotes nothing until the last decision, then lands every accepted one as a typed graph candidate in a single promotion scenario/);
  assert.match(guide, /inception-governance\.mjs documents/);
  assert.match(guide, /formula's `init` produces graph-mode models only/);
  assert.doesNotMatch(guide, /recognized active lease/);
  const architecture = read('docs', 'architecture.md').split('\n');
  assert.match(architecture.find(line => line.startsWith('| `inception-snapshot.mjs` |')), /recognized scaffold lease/);
  assert.match(architecture.find(line => line.startsWith('| `inception-governance.mjs` |')), /writes the certified stable documents/);
  const acceptance = read('docs', 'inception-acceptance.md').split('\n');
  assert.match(acceptance.find(line => /complete → init → discovery/.test(line)), /Graph mode certifies no Markdown document[\s\S]*`\.formula\/`[\s\S]*reserved area/);
});

test('the graph promotes the pre-merge inception rules', { skip: DOGFOOD_CHECKPOINT_SKIP }, () => {
  const lease = definition('recognized-lease');
  assert.ok(lease, 'term:recognized-lease must be promoted');
  assert.match(lease, /stale[\s\S]*retired[\s\S]*candidate/);
  assert.match(lease, /0600/);
  assert.match(lease, /live or dead/i);
  assert.match(definition('application-snapshot'), /Git status/);
  assert.match(definition('application-snapshot'), /\.formula/);
  const evidence = statement('inception-evidence-is-exact-and-never-replayed');
  assert.match(evidence, /never by recency/);
  assert.match(evidence, /every decision-register row `DR-n` needs a contract coverage entry `dr-n`/);
  const certify = statement('graph-init-after-inception-certifies-scaffold-only');
  assert.match(certify, /Pending recovery reapplies the original validated plan with idempotent apply, never fresh replanning/);
  assert.match(certify, /`adoptUnmanagedClaudeImport`/);
  const source = statement('discovery-inception-source-lands-through-one-graph-promotion');
  assert.match(source, /Nothing is promoted until every decision is decided/);
  assert.match(source, /`apex:<projectId>:revision:r1`/);
});
