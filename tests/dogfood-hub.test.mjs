// The dogfood gate AFTER the G4 cutover: the repo's coherence authority is the CANONICAL GRAPH,
// not the Markdown hub (spec criterion 12 — no Markdown in operational reads). This suite imports
// the local-only recovery-checkpoint export (`tests/fixtures/dogfood-export.jsonl`, never pushed;
// the signed export of THIS repo's graph at head `r16` — the migrated graph plus the apex-v0.8.x port's
// promoted write-backs, the r14 retirement of `skill:graph-init` after PR #4 absorbed it
// into `skill:init`, the r15 automated topology refresh that re-observed the repository
// digest, and the r16 rename promotion that superseded `skill:steepy-apex-bootstrap`
// with `skill:steepy-formula-bootstrap`) into an in-memory port and asserts:
//
//   - the migrated graph validates clean (B4) and its Revision chain replays clean (B5);
//   - representative context resolution serves the migrated governance (by path and by target);
//   - the migrated graph carries the expected governance nodes (surfaces, agents, skills,
//     terms, the decision-model/gear rules, the engine bake-off Decision);
//   - CLAUDE.md navigation points at the resolver, never the archived Markdown hub.
//
// Without the checkpoint (a fresh clone, CI) the graph tests skip with the explicit
// DOGFOOD_CHECKPOINT_SKIP reason; the repo-file tests below always run.
//
// The legacy `.apex/` Markdown hub is archived (and removed once THIS gate validates the
// checkpoint). Since the Task 20 scaffold self-apply, the repo's own portable artifacts live on
// disk as produced by `scripts/project-scaffold.mjs` in graph mode: the AGENTS.md spine, the
// CLAUDE.md managed import channel, the per-mode bootstrap under `.agents/skills/`, its Claude
// stub under `.claude/skills/`, and the per-surface claude/codex/opencode agent triads. `.apex/work/**`
// remains gitignored operational state: its tracked two-line .gitignore keeps `.apex/` present in
// a clone (the OpenCode adapter registers project specialists only under an existing `.apex/`), and
// the root .gitignore also ignores `/.apex/work/` (apex v1.0.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { withTransaction } from '../scripts/formula/engine/port.mjs';
import { importGraph } from '../scripts/formula/core/export.mjs';
import { validateGraph } from '../scripts/formula/core/validate-graph.mjs';
import { readChain, verifyChain } from '../scripts/formula/core/revision.mjs';
import { resolveContext } from '../scripts/formula/core/resolve-context.mjs';
import { collectReviewEvidence } from '../scripts/capture-review-evidence.mjs';
import { buildSeed, PROJECT as SEED_PROJECT } from './helpers/graph-seed.mjs';
import { DOGFOOD_CHECKPOINT, DOGFOOD_CHECKPOINT_SKIP } from './helpers/dogfood-checkpoint.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'steepy-formula';
const qid = (localId) => `apex:${PROJECT}:${localId}`;

// Loads the local dogfood checkpoint into a FRESH in-memory port. Every test drives the
// canonical graph through the real core (B4/B5/D2), never hand-built bytes; each caller is
// gated on DOGFOOD_CHECKPOINT_SKIP.
async function withDogfoodGraph(fn) {
  const port = createMemoryPort();
  try {
    const restored = await importGraph(port, { filePath: DOGFOOD_CHECKPOINT, fs: { readFileSync } });
    assert.equal(restored.ok, true, `the dogfood checkpoint must import cleanly: ${JSON.stringify(restored)}`);
    assert.deepEqual(restored.violations ?? [], []);
    return await fn(port);
  } finally {
    await port.close();
  }
}

test('the dogfood export is the repo graph: head r20, B4-clean, chain intact', { skip: DOGFOOD_CHECKPOINT_SKIP }, () =>
  withDogfoodGraph(async (port) => {
    const validation = await validateGraph(port, { projectId: PROJECT });
    assert.equal(validation.ok, true, `migrated graph must validate clean: ${validation.violations.map((v) => v.message).join('; ')}`);
    assert.deepEqual(validation.violations, []);

    const chain = await readChain(port, { projectId: PROJECT });
    assert.equal(chain.headRevision, qid('revision:r20'));
    assert.equal(chain.revisions.length, 20);
    const verdict = await verifyChain(port, { projectId: PROJECT });
    assert.equal(verdict.ok, true, `the Revision chain must replay clean: ${JSON.stringify(verdict.violations)}`);

    const content = validation.warnings ?? [];
    // Advisory warnings are allowed and recorded; the migrated rules' VERIFIED_BY wiring is a
    // follow-up (the G1 extraction wires checks only within a standard's Testing section). What
    // must never regress is the BLOCKING state — violations stay empty.
    for (const warning of content) {
      assert.equal(warning.code, 'SHOULD_RULE_WITHOUT_CHECK', `unexpected advisory warning ${JSON.stringify(warning)}`);
    }
  }));

test('the v0.10.0 capability-bounded knowledge is promoted and served (terms + rules)', { skip: DOGFOOD_CHECKPOINT_SKIP }, () =>
  withDogfoodGraph(async (port) => {
    const byPath = await resolveContext(port, { projectId: PROJECT, paths: ['.'] });
    assert.equal(byPath.ok, true, JSON.stringify(byPath));
    const terms = byPath.context.terms.map((t) => t.id);
    const rules = byPath.context.rules.map((r) => r.id);

    for (const term of ['term:work-input-capability', 'term:manual-handoff-envelope', 'term:workflow-artifact-state']) {
      assert.ok(terms.includes(qid(term)), `${term} must be promoted and served for the repo-root path`);
    }
    for (const rule of [
      'rule:work-input-capability-is-default-deny',
      'rule:manual-and-autopilot-share-semantics-not-transports',
      'rule:workflow-artifacts-carry-bidirectional-lifecycle-provenance',
    ]) {
      assert.ok(rules.includes(qid(rule)), `${rule} must be promoted and served for the repo-root path`);
    }

    const defaultDeny = byPath.context.rules.find((r) => r.id === qid('rule:work-input-capability-is-default-deny'));
    assert.match(defaultDeny.properties.statement, /never selects a\s+most-recent artifact/);
    assert.match(defaultDeny.properties.statement, /phase-local and transitive/);

    const lifecycle = byPath.context.rules.find((r) => r.id === qid('rule:workflow-artifacts-carry-bidirectional-lifecycle-provenance'));
    assert.match(lifecycle.properties.statement, /`DRAFT` → `READY` → `CONSUMED`/);

    const envelopeTerm = byPath.context.terms.find((t) => t.id === qid('term:manual-handoff-envelope'));
    assert.match(envelopeTerm.properties.ext_v1_definition, /steepy-formula\/v1/);
    assert.match(envelopeTerm.properties.ext_v1_definition, /model-enforced/);
  }));

test('the v0.10.0 surface-scoped rules are promoted on their owning surfaces', { skip: DOGFOOD_CHECKPOINT_SKIP }, () =>
  withDogfoodGraph(async (port) => {
    const probes = [
      // r20 superseded the prior-canonical cohort rule (apex v1.2.0 dropped every compatibility path).
      ['rule:scaffold-repair-recognizes-only-current-or-own-legacy-renderings', 'surface:scripts'],
      ['rule:generated-bootstraps-carry-the-work-boundary', 'surface:templates'],
      ['rule:stable-docs-never-link-concrete-work-artifacts', 'surface:tests'],
    ];
    for (const [ruleLocalId, surfaceTarget] of probes) {
      const resolved = await resolveContext(port, { projectId: PROJECT, targets: [qid(surfaceTarget)] });
      assert.equal(resolved.ok, true, JSON.stringify(resolved));
      assert.ok(
        resolved.context.rules.some((r) => r.id === qid(ruleLocalId)),
        `${ruleLocalId} must resolve for its owning surface target ${surfaceTarget}`,
      );
    }
    const workLink = await resolveContext(port, { projectId: PROJECT, targets: [qid('surface:tests')] });
    const rule = workLink.context.rules.find((r) => r.id === qid('rule:stable-docs-never-link-concrete-work-artifacts'));
    assert.match(rule.properties.statement, /never links to concrete `\.apex\/work\/\*\*` artifacts/);
  }));

// v0.11.0 port (r19): the work-path confinement knowledge and the superseded review-architecture
// rule. The old delegable-collection Rule and its Check are superseded — the replacement must be
// served where the old one was, and the supersession must be visible on the chain.
test('the v0.11.0 work-path knowledge is promoted and the review-capture rule superseded (r19)', { skip: DOGFOOD_CHECKPOINT_SKIP }, () =>
  withDogfoodGraph(async (port) => {
    const byPath = await resolveContext(port, { projectId: PROJECT, paths: ['.'] });
    assert.equal(byPath.ok, true, JSON.stringify(byPath));
    assert.ok(
      byPath.context.terms.some((t) => t.id === qid('term:work-path-capability')),
      'the work-path capability Term must be promoted and served for the repo-root path',
    );
    const scripts = await resolveContext(port, { projectId: PROJECT, targets: [qid('surface:scripts')] });
    assert.equal(scripts.ok, true, JSON.stringify(scripts));
    const workPathRule = scripts.context.rules.find((r) => r.id === qid('rule:work-path-io-rides-the-capability-primitive'));
    assert.ok(workPathRule, 'the work-path I/O Rule must resolve for its owning scripts surface');
    assert.match(workPathRule.properties.statement, /zero bytes read or written outside the repository/);
    assert.match(workPathRule.properties.statement, /canonical `\.apex\/work\/specs\/` source spec/);

    const term = byPath.context.terms.find((t) => t.id === qid('term:work-path-capability'));
    assert.match(term.properties.ext_v1_definition, /rejects — never normalizes — alias forms/);
    assert.match(term.properties.ext_v1_definition, /device\/inode identity/);

    const curated = await withTransaction(port, (tx) => tx.listNodes({ namespace: 'curated' }));
    const byId = new Map(curated.map((node) => [node.id, node]));
    const supersededRule = byId.get(qid('rule:review-evidence-collection-delegable-judgement-not'));
    assert.equal(supersededRule?.properties?.status, 'superseded',
      'the delegable-collection Rule must be superseded by the r19 promotion');
    const replacement = byId.get(qid('rule:review-evidence-capture-is-deterministic-and-receipt-bounded'));
    assert.equal(replacement?.properties?.status, 'active');
    assert.match(replacement.properties.statement, /deterministic inline script, never an LLM delegation path/);
    assert.match(replacement.properties.statement, /bounded JSON receipt/);
    assert.match(replacement.properties.statement, /remain in the review session/);

    const skills = await resolveContext(port, { projectId: PROJECT, targets: [qid('surface:skills')] });
    assert.equal(skills.ok, true, JSON.stringify(skills));
    assert.ok(
      skills.context.rules.some((r) => r.id === qid('rule:review-evidence-capture-is-deterministic-and-receipt-bounded')),
      'the replacement Rule must resolve for the skills surface the old rule applied to',
    );
    assert.ok(
      !skills.context.rules.some((r) => r.id === qid('rule:review-evidence-collection-delegable-judgement-not')),
      'the superseded Rule must be out of operational context for the skills surface',
    );

    const supersededCheck = byId.get(qid('check:skills-evidence-collection-judgement-boundary'));
    assert.equal(supersededCheck?.properties?.status, 'superseded',
      'the stale evidence-collection Check must be superseded by the r19 promotion');
    const newCheck = byId.get(qid('check:skills-inline-evidence-capture-locks'));
    assert.equal(newCheck?.properties?.status, 'active');
    assert.match(newCheck.properties.ext_v1_title, /collector prompt template is retired/);
  }));

// apex v1.2.0 port (r20): the Gear-3/Gear-4 controller, inception and release knowledge, adapted to
// formula's graph-first init (empty certified document set, graph-only inception source, r1 window).
test('the apex v1.2.0 knowledge is promoted and the superseded rules are out of context (r20)', { skip: DOGFOOD_CHECKPOINT_SKIP }, () =>
  withDogfoodGraph(async (port) => {
    const byPath = await resolveContext(port, { projectId: PROJECT, paths: ['.'] });
    assert.equal(byPath.ok, true, JSON.stringify(byPath));
    const terms = new Map(byPath.context.terms.map((t) => [t.id, t]));
    for (const term of ['workflow-event-log', 'attempt-reservation', 'reconciliation-required-halt', 'clean-terminal-outcome',
      'inception-run', 'run-descriptor', 'representative-path', 'decision-register', 'effect-log', 'inception-checkpoint',
      'resume-note', 'inception-source', 'persisted-unit', 'verification-cycle', 'control-contract', 'application-snapshot',
      'recognized-lease', 'capture-receipt']) {
      assert.ok(terms.has(qid(`term:${term}`)), `term:${term} must be promoted and served`);
    }
    assert.match(terms.get(qid('term:inception-source')).properties.ext_v1_definition, /only in graph mode[\s\S]*revision:r1[\s\S]*inception-<runId>/);
    assert.match(terms.get(qid('term:application-snapshot')).properties.ext_v1_definition, /\.formula/);
    assert.match(terms.get(qid('term:artifact-first-completion')).properties.ext_v1_definition, /status\/artifact\/signals|`status`, `artifact`, `signals`/);

    const rulesFor = async (surface) => {
      const resolved = await resolveContext(port, { projectId: PROJECT, targets: [qid(`surface:${surface}`)] });
      assert.equal(resolved.ok, true, JSON.stringify(resolved));
      return new Map(resolved.context.rules.map((r) => [r.id, r]));
    };
    const skills = await rulesFor('skills');
    const scripts = await rulesFor('scripts');
    const gear4 = scripts.get(qid('rule:gear-4-runs-only-through-the-packaged-controller'));
    assert.ok(gear4 && skills.has(gear4.id), 'the Gear-4 controller rule must resolve for scripts and skills');
    assert.match(gear4.properties.statement, /--graph-target apex:<projectId>:surface:<surface>/);
    assert.match(gear4.properties.statement, /HUB_MODE_DRIFT/);
    assert.match(gear4.properties.statement, /Terminal review is the sole owner of the Gear-4 coherence gate/);
    const certify = scripts.get(qid('rule:graph-init-after-inception-certifies-scaffold-only'));
    assert.match(certify.properties.statement, /empty Markdown document set/);
    assert.match(certify.properties.statement, /init-provenance\.json/);
    const source = skills.get(qid('rule:discovery-inception-source-lands-through-one-graph-promotion'));
    assert.match(source.properties.statement, /only in graph mode/);
    assert.match(source.properties.statement, /one promotion scenario `inception-<runId>`/);
    const manual = skills.get(qid('rule:gear-2-short-circuits-to-implement'));
    assert.match(manual.properties.statement, /mutually exclusive/);
    assert.match(manual.properties.statement, /`progress-ledger`[\s\S]*`task-results`/);
    const envelope = skills.get(qid('rule:artifact-first-completion-drive-selected-envelope'));
    assert.match(envelope.properties.statement, /DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT/);
    assert.match(envelope.properties.statement, /APPROVED \| ISSUES_FOUND \| BLOCKED \| NEEDS_CONTEXT/);
    assert.ok(skills.get(qid('rule:unplanned-discovery-is-an-explicit-signal')).properties.statement.includes('discovery:unplanned'));
    const lifecycle = skills.get(qid('rule:workflow-artifacts-carry-bidirectional-lifecycle-provenance'));
    assert.match(lifecycle.properties.statement, /READY[\s\S]*CONSUMED/);
    const adapters = (await rulesFor('templates')).get(qid('rule:specialist-adapters-orient-through-the-declared-hub-mode'));
    assert.match(adapters.properties.statement, /Specialist for the <surface> surface\. Use it for changes under <path>\./);

    const curated = await withTransaction(port, (tx) => tx.listNodes({ namespace: 'curated' }));
    const byId = new Map(curated.map((node) => [node.id, node]));
    for (const superseded of ['rule:prior-canonical-recognition-is-exact', 'rule:artifact-first-completion-four-field-envelope',
      'rule:anti-chatter-during-plan-execution-narrate-at-most-one-line-between-tasks-and', 'check:scripts-artifact-first-envelope']) {
      assert.equal(byId.get(qid(superseded))?.properties?.status, 'superseded', `${superseded} must be superseded at r20`);
    }
    assert.ok(!scripts.has(qid('rule:prior-canonical-recognition-is-exact')), 'the superseded cohort rule is out of operational context');
    assert.equal(byId.get(qid('skill:inception'))?.properties?.status, 'active');
  }));

test('the migrated graph serves representative context (by path and by target)', { skip: DOGFOOD_CHECKPOINT_SKIP }, () =>
  withDogfoodGraph(async (port) => {
    const byPath = await resolveContext(port, { projectId: PROJECT, paths: ['.'] });
    assert.equal(byPath.ok, true, JSON.stringify(byPath));
    assert.ok(byPath.context.rules.length >= 20, `path resolution must serve the project-wide governance, got ${byPath.context.rules.length}`);
    assert.ok(
      byPath.context.rules.some((r) => r.id.includes('durable-decisions')),
      'the project-wide conventions Rules must be served for the repo-root path',
    );

    const byTarget = await resolveContext(port, { projectId: PROJECT, targets: [qid('rule:durable-decisions')] });
    assert.equal(byTarget.ok, true, JSON.stringify(byTarget));
    assert.ok(byTarget.context.rules.some((r) => r.id === qid('rule:durable-decisions')));
  }));

test('the migrated governance is present: surfaces, agents, skills, terms, rules, the bake-off Decision', { skip: DOGFOOD_CHECKPOINT_SKIP }, () =>
  withDogfoodGraph(async (port) => {
    // Surfaces/Components/Project are routing ANCHORS, not served items — read the graph directly.
    const curated = await withTransaction(port, (tx) => tx.listNodes({ namespace: 'curated' }));
    const byId = new Map(curated.map((node) => [node.id, node]));
    const has = (local) => byId.has(qid(local));

    // the four governed surfaces + the project-wide surface
    assert.ok(has('surface:scripts') && has('surface:skills') && has('surface:templates') && has('surface:tests') && has('surface:adapters'));
    assert.ok(has('surface:project'), 'the synthesized project-wide Surface must be in the graph');

    // agents and the eleven shipped skills (incl. the gear-4 loop-engineer, graph-migrate and the
    // pre-hub inception skill promoted at r20)
    assert.ok(has('agent:scripts-agent') && has('agent:skills-agent') && has('agent:templates-agent') && has('agent:tests-agent') && has('agent:adapters-agent'));
    for (const skill of ['inception', 'loop-engineer', 'graph-migrate', 'brainstorm', 'plan', 'implement', 'review', 'check', 'discovery', 'new-surface', 'init']) {
      assert.ok(has(`skill:${skill}`), `skill:${skill} must be migrated`);
    }
    // the retired standalone graph-init skill stays materialized as history, never as active
    // governance: r14 marked it superseded when PR #4 absorbed its guarantees into skill:init
    const graphInit = byId.get(qid('skill:graph-init'));
    assert.ok(graphInit, 'the retired skill:graph-init node must stay materialized as history');
    assert.equal(graphInit.properties.status, 'superseded', 'skill:graph-init must be superseded, not active');

    // glossary vocabulary
    for (const term of ['gear', 'goal-contract', 'loop-ledger', 'keep-discard', 'verifier', 'verdict-artifact', 'routing-table', 'surface']) {
      assert.ok(has(`term:${term}`), `term:${term} must be migrated`);
    }

    // the decision-model / gear / ceremony Rules carry their verbatim statements
    const ceremony = byId.get(qid('rule:the-ceremony-cost-envelope-and-gear-4-starts-autonomous-work-autonomy'));
    assert.ok(ceremony, 'the ceremony/gear-4 Rule must be migrated');
    assert.match(ceremony.properties.statement, /autonomy must never/, 'the Rule statement is the verbatim source line');

    // the engine bake-off Decision node
    const decision = byId.get(qid('decision:engine-bake-off'));
    assert.ok(decision, 'the bake-off Decision node must be migrated');
    assert.match(decision.properties.ext_v1_statement, /arcadedb|ArcadeDB/i);

    // the package→component mapping that makes path resolution work
    const topology = await withTransaction(port, (tx) => tx.listEdges({ namespace: 'topology' }));
    assert.ok(
      topology.some((e) => e.type === 'IMPLEMENTS' && e.fromId === qid('package:steepy-formula') && e.toId === qid('component:steepy-formula')),
      'the root package must IMPLEMENTS the dogfood Component',
    );
  }));

test('the ported write-backs are promoted into the canonical graph (v0.8.0–v0.8.6 batches, r5–r13)', { skip: DOGFOOD_CHECKPOINT_SKIP }, () =>
  withDogfoodGraph(async (port) => {
    const curated = await withTransaction(port, (tx) => tx.listNodes({ namespace: 'curated' }));
    const byId = new Map(curated.map((node) => [node.id, node]));
    const has = (local) => byId.has(qid(local));

    // v0.8.0 context-efficient autopilot batch (scenario port-apex-v08x-a1)
    for (const rule of [
      'rule:context-manifests-role-local-required-on-demand',
      'rule:no-work-timer-or-fixed-consumption-quota',
      'rule:artifact-first-completion-four-field-envelope',
      'rule:conductor-derives-review-evidence',
      'rule:unrouted-owning-surface-halts-cross-cutting-ignored',
      'rule:resource-usage-ledger-observational-only',
      'rule:distinct-phase-aggregates-not-summed-without-scope-evidence',
      'rule:adapters-apply-or-degrade-concrete-models',
    ]) {
      assert.ok(has(rule), `${rule} must be promoted`);
    }
    for (const term of ['term:context-manifest', 'term:artifact-first-completion', 'term:resource-usage-ledger', 'term:implementer-status']) {
      assert.ok(has(term), `${term} must be promoted`);
    }

    // v0.8.1 closed model-tier ladder batch (scenario port-apex-v08x-t3)
    assert.ok(has('rule:model-tier-ladder-closed-at-three-rungs'), 'the closed-ladder Rule must be promoted');

    // v0.8.2 turn-discipline + evidence-collector batch (scenario port-apex-v08x-t4)
    for (const rule of [
      'rule:session-per-phase-declared-never-imposed',
      'rule:review-evidence-collection-delegable-judgement-not',
      'rule:plan-cuts-tasks-on-knowable-diffs-not-goals',
    ]) {
      assert.ok(has(rule), `${rule} must be promoted`);
    }
    const sessionPerPhase = byId.get(qid('rule:session-per-phase-declared-never-imposed'));
    assert.match(sessionPerPhase.properties.statement, /17\.0M/, 'the promoted rule carries the measured single-phase figure');
    assert.match(sessionPerPhase.properties.statement, /19\.6M/, 'the promoted rule carries the measured mixed-phase figure');
    assert.match(sessionPerPhase.properties.statement, /3\.6M/, 'the promoted rule carries the measured autopilot figure');

    // v0.8.3 task-event observability batch (scenario port-apex-v08x-t5)
    assert.ok(has('term:agent-task-events'), 'the agent-task-events Term must be promoted');
    assert.ok(has('rule:task-events-are-agent-identity-evidence'), 'the agent-identity-evidence Rule must be promoted');

    // v0.8.4 cost-observability + tier-routing batch (scenario port-apex-v08x-t6)
    for (const term of ['term:cost-report-headless-channel', 'term:cost-report-interactive-channel']) {
      assert.ok(has(term), `${term} must be promoted`);
    }
    for (const rule of [
      'rule:phase-controller-tier-standard',
      'rule:usage-ledger-needs-a-reader',
      'rule:tier-must-state-its-unit-of-work',
      'rule:stable-docs-state-active-rule-only',
    ]) {
      assert.ok(has(rule), `${rule} must be promoted`);
    }

    // v0.8.5 real OpenCode event decoding batch (scenario port-apex-v08x-t8)
    assert.ok(has('term:opencode-step-events'), 'the opencode-step-events Term must be promoted');
    assert.ok(has('rule:session-capabilities-promote-on-event-evidence'),
      'the event-evidence capability-promotion Rule must be promoted');

    // v0.8.6 cost-report measurement-integrity batch (scenario port-apex-v08x-t9):
    // refines the t6 tier rule (plan-phase child keeps the spec Complexity binding) and
    // extends the interactive-channel Term with the messageIdField dedupe trap.
    assert.ok(has('rule:cost-report-measures-what-it-claims'),
      'the measurement-integrity Rule must be promoted');
    const tierRule = byId.get(qid('rule:phase-controller-tier-standard'));
    assert.match(tierRule.properties.statement, /plan phase child is the exception/,
      'the refined tier rule must carve out the plan phase child');
    const interactiveTerm = byId.get(qid('term:cost-report-interactive-channel'));
    assert.match(interactiveTerm.properties.ext_v1_definition, /message\.id/,
      'the interactive-channel Term must document the messageId dedupe trap');

    // every promoted Rule from the port is VERIFIED_BY a Check (no SHOULD_RULE_WITHOUT_CHECK regressions)
    const edges = await withTransaction(port, (tx) => tx.listEdges({ namespace: 'curated' }));
    const verifiedBy = new Set(edges.filter((e) => e.type === 'VERIFIED_BY').map((e) => e.fromId));
    for (const local of [
      'rule:context-manifests-role-local-required-on-demand',
      'rule:model-tier-ladder-closed-at-three-rungs',
      'rule:session-per-phase-declared-never-imposed',
      'rule:task-events-are-agent-identity-evidence',
      'rule:phase-controller-tier-standard',
      'rule:session-capabilities-promote-on-event-evidence',
      'rule:cost-report-measures-what-it-claims',
    ]) {
      assert.ok(verifiedBy.has(qid(local)), `${local} must be VERIFIED_BY a Check`);
    }
  }));

test('CLAUDE.md is the managed import channel for the AGENTS.md spine, never the archived hub (criterion 12)', () => {
  // The scaffold self-apply retired the legacy whole-file CLAUDE.md (title + steepy:start nav
  // block + dev commands): a drifted legacy rendering classifies `customized`, and the `replace`
  // resolution installs the canonical managed import block. The navigation authority is the
  // imported AGENTS.md spine, which points at the resolver.
  const claude = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /<!-- steepy:managed:claude-import:v1:start -->/);
  assert.match(claude, /<!-- steepy:managed:claude-import:v1:end -->/);
  assert.match(claude, /(^|\n)@AGENTS\.md(\n|$)/, 'the channel imports the spine');
  assert.doesNotMatch(claude, /\.apex\/_INDEX\.md/, 'CLAUDE.md must not route through the archived Markdown hub');
  assert.doesNotMatch(claude, /<!-- steepy:start -->/, 'the legacy nav channel is retired, not preserved');
  assert.doesNotMatch(claude, /steepy-apex/, 'identity hygiene: no unsanctioned upstream name');
  const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
  assert.match(agents, /steepy-formula context resolve/, 'the imported spine points at the canonical resolver');
});

test('criterion 12: the archived Markdown hub is absent from normal reads (only .apex/work remains)', () => {
  for (const f of ['_INDEX.md', 'conventions.md', 'glossary.md', 'testing-and-checklist.md', 'standards']) {
    assert.equal(existsSync(join(repoRoot, '.apex', f)), false, `.apex/${f} must be archived out of normal reads`);
  }
  assert.equal(existsSync(join(repoRoot, '.apex', 'work')), true, '.apex/work stays as the gitignored operational state');
});

test('criterion 12: the session navigation layer points at the resolver, never the archived hub', () => {
  // The whole-branch review caught the navigation gap: the canonical per-mode bootstrap skill
  // (self-applied by the portable scaffold under .agents/skills/), the thin specialist agent
  // triads, and the adapter boot prompts must not route operational reads to the archived
  // Markdown hub (no .apex/_INDEX.md, no .apex/standards/) and must reference the resolver.
  const files = [
    join(repoRoot, '.agents', 'skills', 'steepy-formula-bootstrap', 'SKILL.md'),
    ...['adapters', 'scripts', 'skills', 'templates', 'tests'].map((s) => join(repoRoot, '.claude', 'agents', `${s}-agent.md`)),
    join(repoRoot, 'adapters', 'opencode', 'steepy-formula.js'),
    join(repoRoot, 'adapters', 'pi', 'steepy-formula.js'),
    join(repoRoot, 'CONTRIBUTING.md'),
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\.apex\/_INDEX\.md/, `${file} must not route through the archived hub index`);
    assert.doesNotMatch(text, /read `?\.apex\/standards\//, `${file} must not read the archived surface standards`);
    assert.match(text, /steepy-formula context resolve|context resolve/, `${file} must point at the canonical resolver`);
  }
});

test('the repo keeps .apex/work as gitignored operational state', () => {
  const ignore = readFileSync(join(repoRoot, '.apex', 'work', '.gitignore'), 'utf8');
  assert.equal(ignore, '*\n!.gitignore\n');
});

test('the repository ignores the entire local work tree from its root', () => {
  // apex v1.0.0: local workflow artifacts must never enter release history.
  assert.ok(readFileSync(join(repoRoot, '.gitignore'), 'utf8').split('\n').includes('/.apex/work/'),
    'the repository must ignore the entire local work tree from its root');
});

test('terminal review evidence cannot report reviewed-clean when its owned graph gate is red', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'steepy-terminal-review-red-graph-'));
  try {
    writeFileSync(join(repo, '.gitignore'), '');
    const { file } = await buildSeed({ term: true });
    const receipt = await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: '.apex/work/loops/2026-09-04-red-hub/evidence-report.md',
      testCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(0)')}`,
      graphGateArgs: ['--port', 'memory', '--seed', file, '--project', SEED_PROJECT],
    });
    assert.equal(receipt.commands[0].passed, true);
    assert.equal(receipt.commands.at(-1).label, 'coherence-gate');
    assert.equal(receipt.commands.at(-1).passed, false);
    assert.equal(receipt.allPassed, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- the scaffold self-apply artifact set (Task 20): committed AS PRODUCED by the scaffold ------

test('the portable scaffold self-apply: AGENTS.md spine, CLAUDE.md import channel, adapter triads', () => {
  // The repo's own portable artifacts, produced by `scripts/project-scaffold.mjs` in graph mode:
  // the AGENTS.md spine carries the graph navigation (`hub-mode` + `context resolve`, zero
  // `_INDEX.md` references), CLAUDE.md carries the managed claude-import block (the pre-existing
  // `steepy` nav block survives per the no-op preservation behavior), and every surface gets its
  // opencode + codex + claude agent triad pointing at the resolver, never at copied standards.
  const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
  assert.match(agents, /<!-- steepy:managed:project-instructions:v1:start -->/);
  assert.match(agents, /<!-- steepy:managed:project-instructions:v1:end -->/);
  assert.match(agents, /^# steepy-formula$/m, 'the spine title carries the fork identity');
  assert.match(agents, /^Your AI documentation stops rotting\.$/m);
  assert.match(agents, /## Development commands/);
  assert.match(agents, /- `npm test`/);
  assert.match(agents, /## Confirmed surfaces/);
  assert.match(agents, /## Project navigation/);
  assert.match(agents, /steepy-formula hub-mode` and quote the `mode:` line/, 'the spine navigation is graph-mode');
  assert.match(
    agents,
    /quote the `mode:` line\. If it reports `migrate`, stop and tell the user to run the `graph-migrate` skill; if it reports `none`, stop and tell the user to run the `init` skill\. Otherwise, resolve the task context/,
    'the spine navigation stops on migrate and none right after the hub-mode declaration',
  );
  assert.match(agents, /steepy-formula context resolve --path <task-path>/);
  assert.doesNotMatch(agents, /_INDEX\.md/, 'the spine never routes through the legacy hub index');
  for (const s of ['adapters', 'scripts', 'skills', 'templates', 'tests']) {
    assert.ok(agents.includes(`- \`${s}\` (\`${s}\`) — \`${s}-agent\``), `the spine lists the ${s} surface row`);
  }

  const claude = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /<!-- steepy:managed:claude-import:v1:start -->/);
  assert.match(claude, /<!-- steepy:managed:claude-import:v1:end -->/);
  assert.match(claude, /(^|\n)@AGENTS\.md(\n|$)/, 'the managed import channel imports the spine');
  // No-op preservation verification: the pre-apply CLAUDE.md carried NO steepy:managed blocks
  // (its legacy steepy:start channel classified `customized` and was replaced per the pinned
  // legacy-drift contract), so nothing managed existed to preserve and no stale legacy markers
  // or upstream-name bytes survive in the produced channel.
  assert.doesNotMatch(claude, /<!-- steepy:start -->/, 'the legacy nav channel is retired wholesale');
  assert.doesNotMatch(claude, /steepy-apex/, 'identity hygiene: no unsanctioned upstream name in a touched file');

  for (const s of ['adapters', 'scripts', 'skills', 'templates', 'tests']) {
    const openCode = readFileSync(join(repoRoot, '.opencode', 'agents', `${s}-agent.md`), 'utf8');
    assert.match(openCode, /^mode: subagent$/m, `${s}: opencode adapter uses the native thin syntax`);
    assert.match(openCode, new RegExp(`^# ${s}-agent$`, 'm'));
    assert.match(openCode, new RegExp(`steepy:generated:${s}-agent-opencode:v1`));
    assert.match(openCode, /steepy-formula context resolve --target apex:steepy-formula:surface:/,
      `${s}: the opencode adapter points at the resolver`);
    const codex = readFileSync(join(repoRoot, '.codex', 'agents', `${s}-agent.toml`), 'utf8');
    assert.match(codex, new RegExp(`^name = "${s}-agent"$`, 'm'));
    assert.match(codex, /developer_instructions = """/);
    assert.match(codex, new RegExp(`steepy:generated:${s}-agent-codex:v1`));
    assert.match(codex, /steepy-formula context resolve --target apex:steepy-formula:surface:/,
      `${s}: the codex adapter points at the resolver`);
    const claudeAgent = readFileSync(join(repoRoot, '.claude', 'agents', `${s}-agent.md`), 'utf8');
    assert.match(claudeAgent, new RegExp(`^name: ${s}-agent$`, 'm'));
    assert.match(claudeAgent, new RegExp(`steepy:generated:${s}-agent-claude:v1`));
    assert.match(claudeAgent, new RegExp(`specialist agent for the \`${s}\` surface at \`${s}\`\\.`),
      `${s}: the claude adapter declares its surface`);
    assert.match(claudeAgent, /steepy-formula context resolve --target apex:steepy-formula:surface:/,
      `${s}: the claude adapter points at the resolver`);
  }
});

test('the canonical per-mode bootstrap orients through the graph resolver', () => {
  const skill = readFileSync(
    join(repoRoot, '.agents', 'skills', 'steepy-formula-bootstrap', 'SKILL.md'),
    'utf8'
  );
  assert.match(skill, /^name: steepy-formula-bootstrap$/m);
  assert.match(skill, /steepy:generated:steepy-formula-bootstrap:v1/);
  assert.match(skill, /Read `AGENTS\.md` in full for the project overview/);
  assert.match(
    skill,
    /^description: Project entry point for steepy-formula\. Loads the root instructions and routes work through the Stable Knowledge Graph\.$/m,
  );
  assert.match(skill, /steepy-formula hub-mode` and quote the `mode:` line/, 'graph orientation declares the hub mode');
  assert.match(
    skill,
    /quote the `mode:` line\. If it reports `migrate`, stop and tell the user to run the `graph-migrate` skill; if it reports `none`, stop and tell the user to run the `init` skill\.$/m,
    'graph orientation stops on migrate and none',
  );
  assert.doesNotMatch(skill, /this bootstrap applies when it reports/);
  assert.match(skill, /steepy-formula context resolve --path <task-path>/, 'graph orientation resolves task context');
  assert.match(skill, /State the owning surface and specialist agent before changing files\./);
  assert.match(
    skill,
    /one of the eleven canonical skills: `inception`, `init`, `check`, `new-surface`, `discovery`, `brainstorm`, `plan`, `implement`, `review`, `loop-engineer`, `graph-migrate`/,
    'the workflow invocation list names all eleven skills',
  );
  assert.match(skill, /Run the owning surface's test command and `steepy-formula graph validate` before reporting completion\./);
  assert.doesNotMatch(skill, /_INDEX\.md/, 'the graph-mode bootstrap never routes through the legacy hub index');
  assert.doesNotMatch(skill, /steepy-apex/, 'identity hygiene: the regenerated bootstrap carries the fork identity only');
});

test('the Claude bootstrap stub imports the canonical bootstrap; the superseded apex-named skill is gone', () => {
  const stub = readFileSync(
    join(repoRoot, '.claude', 'skills', 'steepy-formula-bootstrap', 'SKILL.md'),
    'utf8'
  );
  assert.match(stub, /^name: steepy-formula-bootstrap$/m);
  assert.match(stub, /steepy:generated:steepy-formula-bootstrap-stub:v1/);
  assert.match(
    stub,
    /Read `\.agents\/skills\/steepy-formula-bootstrap\/SKILL\.md` in full and execute that canonical bootstrap exactly\./,
    'the stub is the import channel for the canonical bootstrap',
  );
  assert.doesNotMatch(stub, /steepy-apex/, 'identity hygiene: the stub carries the fork identity only');
  assert.equal(
    existsSync(join(repoRoot, '.claude', 'skills', 'steepy-apex-bootstrap')),
    false,
    'the superseded .claude/skills/steepy-apex-bootstrap/ must be deleted by the rename fold',
  );
});
// --- v0.8.2/v0.8.4 port adaptation -----------------------------------------------------------------
// Apex v0.8.2 and v0.8.4 lock its Markdown hub (conventions.md / glossary.md / standards/*.md).
// That hub is archived here: the durable content is promoted into the canonical graph as
// Rule/Term/Check nodes — v0.8.2's (session-per-phase with the 17.0M/19.6M/3.6M measurements,
// evidence-collection judgement boundary, plan task-cutting criterion) and v0.8.4's
// (phase-controller tier routing, the cost-report reader loop, the tier-unit pricing rule, the
// doc-wins supersession refinement, the cost-report channel vocabulary). Presence locks for the
// promoted nodes go on the dogfood checkpoint once it is re-exported past r4 (Task 7 of the
// port plan); the migrated decision-model / review-architecture / invariants / glossary
// equivalents are already locked above on the r4 checkpoint. What survives here is the
// repo-file half of the same write-back: the chain skill sources under skills/.

test('chain skill sources lock the context protocol and canonical review handoff artifacts (repo-file half)', () => {
  const planSkill = readFileSync(join(repoRoot, 'skills', 'plan', 'SKILL.md'), 'utf8');
  const reviewSkill = readFileSync(join(repoRoot, 'skills', 'review', 'SKILL.md'), 'utf8');
  const implementSkill = readFileSync(join(repoRoot, 'skills', 'implement', 'SKILL.md'), 'utf8');
  const autopilotProtocol = readFileSync(join(repoRoot, 'skills', 'implement', 'autopilot-protocol.md'), 'utf8');
  const autopilotContext = readFileSync(join(repoRoot, 'scripts', 'autopilot-context.mjs'), 'utf8');
  assert.match(implementSkill, /- Task <id>: <DONE\|DONE_WITH_CONCERNS>;/);
  assert.match(
    implementSkill,
    /verify the (?:task-result )?handoff[^.]{0,80}before claiming completion/i,
    'implement must parse its own handoff first'
  );
  assert.match(
    autopilotContext,
    /H2 Task-like/,
    'the plan parser discovers every H2 Task-like boundary before validating identifiers'
  );
  assert.doesNotMatch(autopilotProtocol, /mini-routing|zero matches/i, 'autopilot protocol carries no modular routing');
  assert.match(autopilotProtocol, /conductor-resolved `context\.md`/);
  assert.match(autopilotProtocol, /Repeat `--criterion` and every role's `--standard` once per value/);
  // plan is graph-only (no modular leaves); review keeps the leaf-matching locks until its own task.
  for (const [phase, skillText] of [['review', reviewSkill]]) {
    assert.match(skillText, /[Zz]ero matches\s+(?:means|meaning) core only/i, `${phase} must lock zero-match core-only semantics`);
    assert.match(skillText, /[Nn]ever read\s+all leaves[^.]*fallback/i, `${phase} must prohibit a read-all fallback`);
  }
  assert.doesNotMatch(planSkill, /[Zz]ero matches|[Nn]ever read\s+all leaves/, 'plan carries no modular-leaf matching');
  const planValidation = planSkill.match(/### Step 5 — Validate[\s\S]*?(?=### Step 6)/)?.[0];
  assert.ok(planValidation, 'plan must keep a local deterministic validation contract');
  assert.match(planValidation, /--verify-plan/);
  assert.match(planValidation, /before appending `DONE`/i);
});

test('stable documentation locks the context-efficient autopilot contract and never links local work', () => {
  const stableDocs = ['docs/architecture.md', 'docs/workflow.md', 'README.md'];
  for (const relativePath of stableDocs) {
    const text = readFileSync(join(repoRoot, relativePath), 'utf8');
    assert.doesNotMatch(
      text,
      /\]\([^)]*\.apex\/work\//,
      `${relativePath} must not link stable documentation into local .apex/work artifacts`
    );
  }

  const architecture = readFileSync(join(repoRoot, 'docs', 'architecture.md'), 'utf8');
  const workflow = readFileSync(join(repoRoot, 'docs', 'workflow.md'), 'utf8');
  assert.match(workflow, /verdict\/gear\/drive come from manifest contract scalars/i);
  assert.match(workflow, /every matching leaf[^.]*concrete reason/i);
  assert.doesNotMatch(architecture, /phase timeout/i, 'healthy work must not halt on a phase timeout');
  assert.match(architecture, /finite phase\/task lifecycle/i);
  assert.match(architecture, /effective abstract controller tier/i);
  assert.match(architecture, /exact retransmissions[^.]*deduplicat/i,
    'architecture must scope dedupe to retransmissions');
  for (const [name, text] of [['workflow', workflow], ['architecture', architecture]]) {
    assert.match(text, /distinct[^.]*phase[^.]*aggregate[\s\S]{0,220}(?:must not|cannot|not safe to) (?:be )?summ/i,
      `${name} must prohibit summing distinct phase aggregates without scope evidence`);
  }
  assert.match(architecture, /I\/O integrity timeout/i);
  assert.doesNotMatch(architecture, /artifact-first child completion/i, 'the conductor must not own envelope validation');
  assert.match(architecture, /implement skill\/controller/i, 'architecture must assign envelope validation to implement');

  assert.doesNotMatch(workflow, /budget timeout/i, 'gear-3 workflow must not have a budget timeout');
  assert.match(workflow, /resource JSONL/i);
  // apex v1.2.0 dropped the legacy numeric budget compatibility: the field is now rejected.
  assert.doesNotMatch(workflow, /legacy numeric budget/i);
  assert.match(
    workflow,
    /the `budget` field is rejected on fresh and resumed gear-3 contracts/i,
    'workflow must state that gear-3 contracts reject the budget field on fresh and resumed runs'
  );
  assert.match(workflow, /I\/O integrity timeout/i);
  assert.match(workflow, /stop-before-PR/i);

  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /efficiency/i);
  assert.match(readme, /observability/i);
  assert.match(readme, /docs\/workflow\.md/);
});

// v0.11.0 port: the delegable collector prompt is gone — review evidence collection is the
// deterministic inline capture script, and the judgement stays in the review session.
test('skills/review ships the deterministic inline capture — no collector prompt, judgement in session', () => {
  assert.equal(
    existsSync(join(repoRoot, 'skills', 'review', 'evidence-prompt.md')),
    false,
    'the collector prompt template must be retired',
  );
  const review = readFileSync(join(repoRoot, 'skills', 'review', 'SKILL.md'), 'utf8');
  assert.match(review, /capture-review-evidence\.mjs/,
    'review must collect command evidence through the deterministic capture script');
  assert.match(review, /Judgement is never delegated/,
    'the judgement stays in the review session');
});

// --- project identity binding (plan 2026-08-20-project-identity-binding, task 7): the prose half ---
// Tasks 2–6 made `.formula/config.json` the persisted project binding (D3's third link); the
// graph-first init skill absorbed the binding guarantees when the standalone graph-init skill
// was retired — an explicit `--project` remains an override. This pin holds that prose in
// place (SC5): the init skill must keep documenting the binding, and its fenced
// preview/apply/discard/validate/context-resolve blocks must keep resolving from it.
// Per-invocation `--project` is the Step 1 `graph init` block's business alone; the e2e half
// of the contract is tests/formula-project-binding-e2e.test.mjs.

test('init skill documents the persisted .formula/config.json binding and keeps --project out of non-init fenced command blocks', () => {
  const skill = readFileSync(join(repoRoot, 'skills', 'init', 'SKILL.md'), 'utf8');

  // The persisted binding is documented: that init persists it, the file that carries it, the
  // gitignore exception that keeps it shared, and that the committed binding is the project-id
  // authority. graph-init phrased the last as "the persisted `.formula/config.json` binding
  // supplies the project id"; init absorbed the guarantee into its Step 1 authority bullet —
  // a mismatched explicit --project against the committed config is refused up front.
  assert.match(skill, /Init persists the project binding/, 'the skill must state that init persists the binding');
  assert.match(skill, /the project id lives in `\.formula\/config\.json`/, 'the binding file must be named');
  assert.match(skill, /!\.formula\/config\.json/, 'the gitignored-`.formula/` exception must be documented so the binding stays shared');
  assert.match(
    skill,
    /A mismatched explicit `--project` \(or `STEEPY_PROJECT`\) against a committed config refuses\s+up front/,
    'the persisted binding is the project-id authority — a mismatched explicit --project must be refused up front',
  );

  // Every FENCED `steepy-formula` command block whose subcommand is in the non-init set must carry
  // no `--project`. `promotion discard` is inline prose today — the scan pins it the moment it is
  // ever fenced; the existence lock covers the four subcommands that are fenced now, so a
  // restructuring that drops the fences cannot silently void the pin.
  const nonInitSubcommands = ['validate', 'preview', 'apply', 'discard', 'resolve'];
  const fencedBodies = [...skill.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((body) => body.includes('steepy-formula'));
  assert.ok(fencedBodies.length >= 5, 'the skill must keep its fenced steepy-formula command blocks');
  const pinned = new Set();
  for (const body of fencedBodies) {
    for (const invocation of body.matchAll(/steepy-formula\s+(?:graph|context|promotion)\s+([a-z-]+)/g)) {
      const subcommand = invocation[1];
      if (!nonInitSubcommands.includes(subcommand)) continue;
      pinned.add(subcommand);
      assert.doesNotMatch(
        body,
        /--project/,
        `the fenced ${subcommand} block must resolve its project from the persisted binding, not --project:\n${body.trim()}`,
      );
    }
  }
  for (const subcommand of ['validate', 'preview', 'apply', 'resolve']) {
    assert.ok(pinned.has(subcommand), `a fenced ${subcommand} block must exist to carry the pin`);
  }
});

// v0.10.0 portable invariant, adapted for the graph-mode hub: stable Markdown (the
// archived-hub successor surfaces — skills, templates, and the root instruction
// docs) never links a concrete `.apex/work/**` artifact; the graph carries stable
// knowledge and work artifacts stay unlinked local state.
function stableMarkdownPaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'work' ? [] : stableMarkdownPaths(absolute);
    return entry.isFile() && entry.name.endsWith('.md') ? [absolute] : [];
  });
}

test('stable workflow Markdown never links a concrete .apex/work artifact', () => {
  const surfaces = [
    join(repoRoot, 'skills'),
    join(repoRoot, 'templates'),
    join(repoRoot, 'docs'),
    join(repoRoot, '.agents'),
    join(repoRoot, '.claude'),
  ];
  for (const surface of surfaces) {
    for (const path of stableMarkdownPaths(surface)) {
      assert.doesNotMatch(
        readFileSync(path, 'utf8'),
        /\]\([^)]*\.apex\/work\//,
        `${path} must not link a concrete work artifact`,
      );
    }
  }
  for (const rootDoc of ['AGENTS.md', 'CLAUDE.md', 'README.md']) {
    assert.doesNotMatch(
      readFileSync(join(repoRoot, rootDoc), 'utf8'),
      /\]\([^)]*\.apex\/work\//,
      `${rootDoc} must not link a concrete work artifact`,
    );
  }
});
