// Task H2 — the end-to-end suite for the Stable Knowledge Graph (spec "End-to-end boundaries").
//
// Closes the five E2E boundaries as GREEN tests, each hermetic on the in-memory reference port
// with real temp directories, exercising the REAL product path end to end:
//
//   1. init → first graph → inspect → resolve: a multi-package workspace fixture initialized
//      F2/G2-style (topology refresh + an approved init promotion scenario), inspected, validated
//      and resolved on a representative package path;
//   2. evidence → Rule + Check promotion → new context observed: a promotion carrying a NEW Rule,
//      its Check and the VERIFIED_BY edge is previewed and approved, and resolveContext on the
//      affected path now serves the promoted items — byte-diffed against the before state;
//   3. supersede a Rule: a supersession is promoted through the same scenario path; history is
//      preserved (the old node remains superseded, the Revision chain records both promotions) and
//      the old Rule leaves normal context (the new one is served instead);
//   4. delete the Work Graph: a work-graph temp dir is added then removed; resolveContext stays
//      byte-identical and the deletion provably touches nothing in the port — the canonical DB is
//      the single authority;
//   5. migrate a current-style .apex fixture and cut over with no Markdown fallback: the G1
//      extraction of tests/fixtures/good-hub is previewed, applied as ONE transaction, validated,
//      then the legacy hub leaves normal reads and resolution still answers from the graph alone —
//      on a closed port resolution is a named KNOWLEDGE_GRAPH_UNAVAILABLE, never a Markdown read.
//
// The SCALE boundary (500 Packages / 25,000 stable nodes / 150,000 relationships) is an explicit
// POINTER to E4 (tests/formula-envelope.test.mjs, docker-gated full-E1 run on the pinned image);
// this suite does not re-run the 150k-edge load — see the pointer test at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { withTransaction } from '../scripts/formula/engine/port.mjs';
import { validateGraph } from '../scripts/formula/core/validate-graph.mjs';
import { applyChangeSet, readChain, verifyChain } from '../scripts/formula/core/revision.mjs';
import { TOPOLOGY_CODES, refreshTopology } from '../scripts/formula/core/topology.mjs';
import { applyPromotion, createScenario, inspectScenario } from '../scripts/formula/core/promotion.mjs';
import { migrateMarkdown } from '../scripts/formula/core/migrate-markdown.mjs';
import { RESOLVE_ERROR_CODES, resolveContext } from '../scripts/formula/core/resolve-context.mjs';
import {
  FIXTURE_TARGET_CURATED_NODES,
  FIXTURE_TARGET_EDGES,
  FIXTURE_TARGET_PACKAGES,
} from '../scripts/formula/core/fixture-gen.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = (name) => join(here, 'fixtures', name);

const PROPOSED_BY = { type: 'agent-proposer', name: 'scripts-agent' };
const APPROVER = { type: 'human-approver', id: 'steepy-it' };
const PROVENANCE = [{ quotation: 'Approved evidence for this promotion.', source: 'docs/evidence.md:1', digest: 'a'.repeat(64) }];

function qid(projectId, localId) {
  return `apex:${projectId}:${localId}`;
}

function addNode(namespace, type, id, properties = {}) {
  return { op: 'ADD', target: 'node', namespace, type, id, properties: { id, ...properties } };
}

function addEdge(namespace, type, fromId, toId) {
  return { op: 'ADD', target: 'edge', namespace, type, fromId, toId };
}

function ruleProperties(id, concern, overrides = {}) {
  return {
    id,
    title: `Rule ${concern}`,
    statement: `A normative statement governing ${concern}.`,
    status: 'active',
    strength: 'must',
    category: 'engineering',
    concern,
    provenance: { source: 'docs/evidence.md:10', line: 10 },
    ...overrides,
  };
}

function baseMeta(projectId) {
  return {
    projectId,
    proposer: { type: 'agent-proposer', id: 'scripts-agent' },
    approver: APPROVER,
    provenance: [{ quotation: 'E2E seeding evidence.', source: 'docs/e2e.md:1', digest: 'a'.repeat(64) }],
    timestamp: '2026-08-12T10:00:00.000Z',
  };
}

// Seeding through B5's applyChangeSet — the same audit chain the product promotes through — so the
// base graph every boundary starts from is B4-clean and its chain replays clean.
async function seedBaseGraph(port, projectId) {
  const REPO = qid(projectId, 'repository:root');
  const WS = qid(projectId, 'workspace:root');
  const PKG = qid(projectId, 'package:demo-web');
  const P = qid(projectId, 'project:root');
  const S = qid(projectId, 'surface:web');
  const C = qid(projectId, 'component:web');
  const A = qid(projectId, 'agent:web-agent');
  const SK = qid(projectId, 'skill:web-check');
  const CH = qid(projectId, 'check:web-test');
  const R = qid(projectId, 'rule:external-input');

  const topology = await applyChangeSet(
    port,
    {
      operations: [
        addNode('topology', 'Repository', REPO, { root: 'demo', digest: 'd'.repeat(64) }),
        addNode('topology', 'Workspace', WS, { path: '.' }),
        addNode('topology', 'Package', PKG, { path: 'packages/web' }),
        addEdge('topology', 'PART_OF', PKG, WS),
        addEdge('topology', 'PART_OF', WS, REPO),
      ],
    },
    baseMeta(projectId),
  );
  assert.deepEqual(topology.violations, [], 'the topology seeding must apply cleanly');

  const curated = await applyChangeSet(
    port,
    {
      operations: [
        addNode('curated', 'Project', P, { status: 'active' }),
        addNode('curated', 'Surface', S, { status: 'active' }),
        addNode('curated', 'Component', C, { status: 'active' }),
        addNode('curated', 'Agent', A, { status: 'active' }),
        addNode('curated', 'Skill', SK, { status: 'active' }),
        addNode('curated', 'Check', CH, { status: 'active' }),
        addNode('curated', 'Rule', R, ruleProperties(R, 'external-input')),
        addEdge('topology', 'IMPLEMENTS', PKG, C),
        addEdge('curated', 'PART_OF', S, P),
        addEdge('curated', 'PART_OF', C, S),
        addEdge('curated', 'OWNED_BY', S, A),
        addEdge('curated', 'APPLIES_TO', SK, S),
        addEdge('curated', 'APPLIES_TO', R, S),
        addEdge('curated', 'VERIFIED_BY', R, CH),
      ],
    },
    baseMeta(projectId),
  );
  assert.deepEqual(curated.violations, [], 'the curated seeding must apply cleanly');
}

// A real directory tree for the topology detector, mirroring the D1 suite's fixture builder.
async function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'steepy-e2e-workspace-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, ...relative.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  }
  return root;
}

// Every materialized record the canonical DB holds, serialized deterministically — the port-side
// evidence for "deleting the Work Graph touches nothing in the port".
async function snapshotPort(port) {
  return withTransaction(port, async (tx) => {
    const out = {};
    for (const namespace of ['curated', 'topology', 'system']) {
      const nodes = await tx.listNodes({ namespace });
      const edges = await tx.listEdges({ namespace });
      out[namespace] = {
        nodes: nodes
          .map((node) => ({ type: node.type, id: node.id, properties: node.properties }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        edges: edges.map((edge) => `${edge.type} ${edge.fromId} -> ${edge.toId}`).sort(),
      };
    }
    return JSON.stringify(out);
  });
}

// --- boundary 1: init → first graph → inspect → resolve ------------------------------------------

test('boundary 1 — init a multi-package workspace, approve its first graph, inspect and resolve it', async () => {
  const projectId = 'e2e';
  const root = await makeTree({
    'package.json': { name: 'demo-root', private: true, workspaces: ['packages/*'] },
    'packages/web/package.json': { name: '@demo/web' },
    'packages/api/package.json': { name: '@demo/api' },
  });
  const port = createMemoryPort();
  try {
    const P = qid(projectId, 'project:root');
    const SW = qid(projectId, 'surface:web');
    const SA = qid(projectId, 'surface:api');
    const CW = qid(projectId, 'component:web');
    const CA = qid(projectId, 'component:api');
    const A = qid(projectId, 'agent:web-agent');
    const SK = qid(projectId, 'skill:web-check');
    const CHW = qid(projectId, 'check:web-test');
    const CHA = qid(projectId, 'check:api-test');
    const RW = qid(projectId, 'rule:web-external-input');
    const RA = qid(projectId, 'rule:api-strict-cors');

    // The observed topology is written by the automated topology writer (D1, spec §25).
    const refreshed = await refreshTopology(port, root, { projectId, actorId: 'e2e-init' });
    assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
    assert.equal(refreshed.code, TOPOLOGY_CODES.TOPOLOGY_WRITTEN);

    // The init promotion scenario (G2 steps 3-8): the Surface/Component mappings for the observed
    // packages plus the human-approved initial governance — never Rules invented from detection.
    const created = await createScenario(port, {
      projectId,
      scenarioId: 'init',
      proposedBy: PROPOSED_BY,
      operations: [
        addNode('curated', 'Project', P, { status: 'active' }),
        addNode('curated', 'Surface', SW, { status: 'active' }),
        addNode('curated', 'Surface', SA, { status: 'active' }),
        addNode('curated', 'Component', CW, { status: 'active' }),
        addNode('curated', 'Component', CA, { status: 'active' }),
        addNode('curated', 'Agent', A, { status: 'active' }),
        addNode('curated', 'Skill', SK, { status: 'active' }),
        addNode('curated', 'Check', CHW, { status: 'active' }),
        addNode('curated', 'Check', CHA, { status: 'active' }),
        addNode('curated', 'Rule', RW, ruleProperties(RW, 'external-input')),
        addNode('curated', 'Rule', RA, ruleProperties(RA, 'strict-cors')),
        addEdge('topology', 'IMPLEMENTS', qid(projectId, 'package:demo-web'), CW),
        addEdge('topology', 'IMPLEMENTS', qid(projectId, 'package:demo-api'), CA),
        addEdge('curated', 'PART_OF', SW, P),
        addEdge('curated', 'PART_OF', SA, P),
        addEdge('curated', 'PART_OF', CW, SW),
        addEdge('curated', 'PART_OF', CA, SA),
        addEdge('curated', 'OWNED_BY', SW, A),
        addEdge('curated', 'APPLIES_TO', SK, SW),
        addEdge('curated', 'APPLIES_TO', RW, SW),
        addEdge('curated', 'VERIFIED_BY', RW, CHW),
        addEdge('curated', 'APPLIES_TO', RA, SA),
        addEdge('curated', 'VERIFIED_BY', RA, CHA),
      ],
    });
    assert.equal(created.ok, true, JSON.stringify(created));

    // G2 Step 6: the inspection IS the green preview gate before approval.
    const inspection = await inspectScenario(port, { projectId, scenarioId: 'init' });
    assert.equal(inspection.ok, true, JSON.stringify(inspection));
    assert.equal(inspection.structural.valid, true, JSON.stringify(inspection.structural.violations));

    // G2 Step 8: commit the initial graph transaction.
    const applied = await applyPromotion(port, { projectId, scenarioId: 'init', approver: APPROVER, provenance: PROVENANCE });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.headRevision, qid(projectId, 'revision:r2'));

    // G2 Step 9: the invariants are green and representative paths resolve the initial governance.
    const validation = await validateGraph(port, { projectId });
    assert.equal(validation.ok, true, validation.violations.map((v) => v.message).join('; '));
    assert.deepEqual(validation.violations, []);

    const web = await resolveContext(port, { projectId, paths: ['packages/web/src/app.mjs'] });
    assert.equal(web.ok, true, JSON.stringify(web));
    assert.ok(web.context.rules.some((r) => r.id === RW), 'the web Rule must resolve for the web package');
    assert.ok(web.context.checks.some((c) => c.id === CHW), 'the web Check must resolve for the web package');
    assert.ok(web.context.agents.some((a) => a.id === A), 'the web agent must resolve for the web package');
    assert.ok(web.context.skills.some((s) => s.id === SK), 'the web skill must resolve for the web package');

    const api = await resolveContext(port, { projectId, paths: ['packages/api/main.ts'] });
    assert.equal(api.ok, true, JSON.stringify(api));
    assert.ok(api.context.rules.some((r) => r.id === RA), 'the api Rule must resolve for the api package');
  } finally {
    await port.close();
    await rmSync(root, { recursive: true, force: true });
  }
});

// --- boundary 2: evidence → Rule + Check promotion → new context observed ------------------------

test('boundary 2 — promote a Rule + its Check from evidence and observe the new context', async () => {
  const projectId = 'e2e';
  const port = createMemoryPort();
  try {
    await seedBaseGraph(port, projectId);
    const S = qid(projectId, 'surface:web');
    const NEW_RULE = qid(projectId, 'rule:e2e-guard');
    const NEW_CHECK = qid(projectId, 'check:e2e-guard');
    const path = 'packages/web/src/app.mjs';

    const before = await resolveContext(port, { projectId, paths: [path] });
    assert.equal(before.ok, true, JSON.stringify(before));
    assert.equal(before.context.rules.some((r) => r.id === NEW_RULE), false, 'the proposed Rule must not be served before approval');

    // The evidence-driven scenario: a NEW Rule, its Check and the VERIFIED_BY obligation.
    const created = await createScenario(port, {
      projectId,
      scenarioId: 'evidence',
      proposedBy: PROPOSED_BY,
      operations: [
        addNode(
          'curated',
          'Rule',
          NEW_RULE,
          ruleProperties(NEW_RULE, 'e2e-guard', { statement: 'Every e2e boundary must be closed by a green test.' }),
        ),
        addNode('curated', 'Check', NEW_CHECK, { status: 'active' }),
        addEdge('curated', 'APPLIES_TO', NEW_RULE, S),
        addEdge('curated', 'VERIFIED_BY', NEW_RULE, NEW_CHECK),
      ],
    });
    assert.equal(created.ok, true, JSON.stringify(created));

    // Preview the typed diff before approving — the ratified review step, never a blind apply.
    const preview = await inspectScenario(port, { projectId, scenarioId: 'evidence' });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.structural.valid, true, JSON.stringify(preview.structural.violations));
    assert.match(preview.diff, /e2e-guard/, 'the typed diff must name the promoted Rule');

    const applied = await applyPromotion(port, { projectId, scenarioId: 'evidence', approver: APPROVER, provenance: PROVENANCE });
    assert.equal(applied.ok, true, JSON.stringify(applied));

    // The observation: the promoted Rule and Check are now part of the served context, and the
    // context changed byte-wise — stripping the promoted items restores the before state exactly.
    const after = await resolveContext(port, { projectId, paths: [path] });
    assert.equal(after.ok, true, JSON.stringify(after));
    assert.ok(after.context.rules.some((r) => r.id === NEW_RULE), 'the promoted Rule must be served');
    assert.ok(after.context.checks.some((c) => c.id === NEW_CHECK), 'the promoted Check must be served');
    assert.notEqual(JSON.stringify(after.context), JSON.stringify(before.context), 'the promotion must change the observed context');
    for (const bucket of ['agents', 'skills', 'terms', 'decisions']) {
      assert.deepEqual(after.context[bucket], before.context[bucket], `${bucket} must be unchanged`);
    }
    assert.deepEqual(
      after.context.rules.filter((r) => r.id !== NEW_RULE),
      before.context.rules,
      'the only Rule change is the promoted one',
    );
    assert.deepEqual(
      after.context.checks.filter((c) => c.id !== NEW_CHECK),
      before.context.checks,
      'the only Check change is the promoted one',
    );
  } finally {
    await port.close();
  }
});

// --- boundary 3: supersede a Rule (history kept, old Rule out of normal context) ----------------

test('boundary 3 — supersede a Rule: history preserved, the old Rule leaves normal context', async () => {
  const projectId = 'e2e';
  const port = createMemoryPort();
  try {
    await seedBaseGraph(port, projectId);
    const S = qid(projectId, 'surface:web');
    const OLD = qid(projectId, 'rule:packaging');
    const NEW = qid(projectId, 'rule:packaging-v2');
    const path = 'packages/web/src/app.mjs';

    // Scenario A: promote the Rule that will be superseded.
    const first = await createScenario(port, {
      projectId,
      scenarioId: 'supersede-a',
      proposedBy: PROPOSED_BY,
      operations: [
        addNode(
          'curated',
          'Rule',
          OLD,
          ruleProperties(OLD, 'packaging', { statement: 'Package artifacts must pin their engine version.' }),
        ),
        addEdge('curated', 'APPLIES_TO', OLD, S),
      ],
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    const appliedFirst = await applyPromotion(port, { projectId, scenarioId: 'supersede-a', approver: APPROVER, provenance: PROVENANCE });
    assert.equal(appliedFirst.ok, true, JSON.stringify(appliedFirst));
    assert.equal(appliedFirst.headRevision, qid(projectId, 'revision:r3'));

    const servedBefore = await resolveContext(port, { projectId, paths: [path] });
    assert.equal(servedBefore.ok, true, JSON.stringify(servedBefore));
    assert.ok(servedBefore.context.rules.some((r) => r.id === OLD), 'the promoted Rule must be served before the supersession');

    // Scenario B: NEW supersedes OLD through the lifecycle op — the status flip and the SUPERSEDES
    // edge are the SUPERSEDE operation's semantics (B5), not something the scenario re-invents.
    const second = await createScenario(port, {
      projectId,
      scenarioId: 'supersede-b',
      proposedBy: PROPOSED_BY,
      operations: [
        {
          op: 'SUPERSEDE',
          target: 'node',
          namespace: 'curated',
          supersededId: OLD,
          type: 'Rule',
          id: NEW,
          properties: ruleProperties(NEW, 'packaging', {
            statement: 'Package artifacts must pin their engine version and its sha256.',
          }),
        },
        addEdge('curated', 'APPLIES_TO', NEW, S),
      ],
    });
    assert.equal(second.ok, true, JSON.stringify(second));
    const appliedSecond = await applyPromotion(port, { projectId, scenarioId: 'supersede-b', approver: APPROVER, provenance: PROVENANCE });
    assert.equal(appliedSecond.ok, true, JSON.stringify(appliedSecond));

    // History preserved: the old node remains materialized with status superseded, and the
    // SUPERSEDES edge runs from the new Rule to the old one.
    const oldNode = await withTransaction(port, (tx) => tx.getNode({ namespace: 'curated', id: OLD }));
    assert.ok(oldNode, 'the superseded Rule node must remain in the graph (history preserved)');
    assert.equal(oldNode.properties.status, 'superseded');
    const supersedes = await withTransaction(port, (tx) =>
      tx.getEdge({ namespace: 'curated', type: 'SUPERSEDES', fromId: NEW, toId: OLD }),
    );
    assert.ok(supersedes, 'a SUPERSEDES edge must run from the new Rule to the old one');

    // The Revision records remain and the chain is intact — both promotions are on the record.
    const chain = await readChain(port, { projectId });
    assert.equal(chain.headRevision, qid(projectId, 'revision:r4'));
    assert.equal(chain.revisions.length, 4, 'both promotions must be recorded in the chain');
    assert.equal((await verifyChain(port, { projectId })).ok, true, 'the chain must replay clean');

    // Normal context: the new Rule is served, the superseded one is not.
    const after = await resolveContext(port, { projectId, paths: [path] });
    assert.equal(after.ok, true, JSON.stringify(after));
    assert.ok(after.context.rules.some((r) => r.id === NEW), 'the replacing Rule must be served');
    assert.equal(after.context.rules.some((r) => r.id === OLD), false, 'the superseded Rule must leave normal context');

    const validation = await validateGraph(port, { projectId });
    assert.equal(validation.ok, true, validation.violations.map((v) => v.message).join('; '));
    assert.deepEqual(validation.violations, []);
  } finally {
    await port.close();
  }
});

// --- boundary 4: delete the Work Graph → stable context unchanged -------------------------------

test('boundary 4 — delete the Work Graph: stable context is unchanged', async () => {
  const projectId = 'e2e';
  const port = createMemoryPort();
  const workRoot = mkdtempSync(join(tmpdir(), 'steepy-e2e-work-'));
  try {
    await seedBaseGraph(port, projectId);
    const path = 'packages/web/src/app.mjs';

    // A work graph beside the canonical port: specs, plans, task briefs, loop contracts — exactly
    // the gitignored `.formula/work/**` operational state, and nothing the port can see.
    const structure = {
      'specs/e2e-boundaries.md': '# End-to-end boundaries\n- every boundary must be a green test.\n',
      'plans/step-1.md': '# Plan step 1\n- seed the workspace.\n',
      'tasks/task-H2-brief.md': '# Task H2\n- implement the e2e suite.\n',
      'loops/goal-contract.md': '# Goal contract\n- iterate until the suite is green.\n',
    };
    for (const [relative, content] of Object.entries(structure)) {
      const target = join(workRoot, ...relative.split('/'));
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content, 'utf8');
    }

    const withWork = await resolveContext(port, { projectId, paths: [path] });
    assert.equal(withWork.ok, true, JSON.stringify(withWork));
    const bytesWithWork = JSON.stringify(withWork);
    const portBefore = await snapshotPort(port);

    // Delete the work graph, then delete the whole temp tree to prove no residual read path.
    rmSync(workRoot, { recursive: true, force: true });
    assert.equal(existsSync(workRoot), false, 'the work graph must be gone');

    const withoutWork = await resolveContext(port, { projectId, paths: [path] });
    assert.equal(withoutWork.ok, true, JSON.stringify(withoutWork));
    assert.equal(JSON.stringify(withoutWork), bytesWithWork, 'resolveContext must be byte-identical without the work files');
    assert.deepEqual(withoutWork.context, withWork.context);

    // The deletion provably touched nothing in the port: the canonical records and the chain are
    // byte-identical before and after.
    assert.equal(await snapshotPort(port), portBefore, 'deleting the Work Graph must touch nothing in the port');
  } finally {
    await port.close();
    await rmSync(workRoot, { recursive: true, force: true });
  }
});

// --- boundary 5: migrate a current-style .apex fixture and cut over with no Markdown fallback ----

test('boundary 5 — migrate a .apex fixture, cut over, and prove there is no Markdown fallback', async () => {
  const projectId = 'mig';
  const hub = mkdtempSync(join(tmpdir(), 'steepy-e2e-migrate-'));
  cpSync(fixtures('good-hub'), join(hub, 'good-hub'), { recursive: true });
  const hubDir = join(hub, 'good-hub');
  const port = createMemoryPort();
  try {
    // G1 (Step 6): the extraction writes the D4 promotion scenario.
    const migrated = await migrateMarkdown(port, { hubDir, projectId, scenarioId: 'migrate-good' });
    assert.equal(migrated.ok, true, JSON.stringify(migrated));

    // The typed diff is the preview gate before approval.
    const inspection = await inspectScenario(port, { projectId, scenarioId: 'migrate-good' });
    assert.equal(inspection.ok, true, JSON.stringify(inspection));
    assert.equal(inspection.structural.valid, true, JSON.stringify(inspection.structural.violations));

    // G3/G4 (Step 8): apply the migration as ONE transaction.
    const applied = await applyPromotion(port, { projectId, scenarioId: 'migrate-good', approver: APPROVER, provenance: PROVENANCE });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.headRevision, qid(projectId, 'revision:r1'));

    // G4 (Step 9): the migrated graph validates and its chain replays clean.
    const validation = await validateGraph(port, { projectId });
    assert.equal(validation.ok, true, validation.violations.map((v) => v.message).join('; '));
    assert.equal((await verifyChain(port, { projectId })).ok, true, 'the migrated chain must replay clean');

    // The canonical DB answers resolveContext with the migrated governance.
    const resolved = await resolveContext(port, { projectId, targets: ['surface:web'] });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    assert.ok(resolved.context.rules.some((r) => r.id === qid(projectId, 'rule:web-every-external-value')));
    assert.ok(resolved.context.checks.some((c) => c.id === qid(projectId, 'check:web-node-test-tests-web-test-mjs')));
    assert.ok(resolved.context.agents.some((a) => a.id === qid(projectId, 'agent:web-agent')));
    assert.ok(resolved.context.skills.some((s) => s.id === qid(projectId, 'skill:web-check')));

    // G4 cutover (Step 10) at fixture level: the legacy Markdown hub leaves normal reads...
    rmSync(join(hubDir, '.apex'), { recursive: true, force: true });
    assert.equal(existsSync(join(hubDir, '.apex', '_INDEX.md')), false, 'the legacy hub must be gone from normal reads');

    // ...and resolution still answers from the canonical graph alone.
    const afterCutover = await resolveContext(port, { projectId, targets: ['surface:web'] });
    assert.equal(afterCutover.ok, true, JSON.stringify(afterCutover));
    assert.deepEqual(afterCutover.context, resolved.context, 'cutover must not change what the canonical DB answers');

    // No Markdown fallback: on an unavailable graph, resolution is a NAMED failure — the resolver
    // never reaches for a doc read.
    await port.close();
    const unavailable = await resolveContext(port, { projectId, targets: ['surface:web'] });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.code, RESOLVE_ERROR_CODES.KNOWLEDGE_GRAPH_UNAVAILABLE);
    assert.equal(unavailable.context, undefined, 'an unavailable graph must never yield context — there is no Markdown fallback');
  } finally {
    await port.close();
    await rmSync(hub, { recursive: true, force: true });
  }
});

// --- scale boundary → explicit pointer to E4 -----------------------------------------------------

test('scale boundary (500 Packages / 25,000 stable nodes / 150,000 relationships) → POINTER to E4', () => {
  // E4 (tests/formula-envelope.test.mjs) owns the full-scale run: loading the E1 fixture at
  // 500/25k/150k on the pinned ArcadeDB image and measuring the envelope. This suite does not
  // re-run that 150k-edge load; the pointer is pinned here so it cannot rot silently — the
  // envelope numbers come from the same constants E1 asserts, and the owning suite must exist.
  assert.equal(FIXTURE_TARGET_PACKAGES, 500);
  assert.equal(FIXTURE_TARGET_CURATED_NODES, 25000);
  assert.equal(FIXTURE_TARGET_EDGES, 150000);
  assert.equal(existsSync(join(here, 'formula-envelope.test.mjs')), true, 'E4 must exist — it owns the scale boundary');
});
