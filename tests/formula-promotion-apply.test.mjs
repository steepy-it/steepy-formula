// Promotion apply suite (Task D5, spec §11, §21, §22). The approve path: re-validate -> atomic apply
// via B5 `applyChangeSet` -> export-on-promotion via B6 -> consume-scenario, with the failure-table
// rollback guarantee, discard-residue re-assertion and empty-scenario refusal. Every case drives the
// module through a REAL port adapter (the B3 in-memory reference) over a base graph SEEDED WITH B5's
// `applyChangeSet`; the docker-gated live section runs the SAME apply/rollback/export flow against a
// real ArcadeDB — the plan's "first end-to-end promotion on the real engine" (detect docker; self-skip
// with an explicit printed diagnostic, never silently).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { portError, withTransaction } from '../scripts/formula/engine/port.mjs';
import { validateGraph } from '../scripts/formula/core/validate-graph.mjs';
import { applyChangeSet, readChain, verifyChain } from '../scripts/formula/core/revision.mjs';
import {
  PROMOTION_ERROR_CODES,
  applyPromotion,
  createScenario,
  discardScenario,
  promotionExportFileName,
  projectGraph,
} from '../scripts/formula/core/promotion.mjs';
import { EXPORT_FILE_EXTENSION, parseExportArtifact, pruneExportDirectory } from '../scripts/formula/core/export.mjs';
import { ARCADEDB_IMAGE, dockerGate, destroyContainer, startServer } from '../scripts/formula/engine/lifecycle.mjs';
import { createArcadeDbPort, createDatabase } from '../scripts/formula/engine/arcadedb.mjs';

const PROJECT = 'proj';
const SCENARIO = 'apply-1';

const PROPOSED_BY = { type: 'agent-proposer', name: 'scripts-agent' };
const APPROVER = { type: 'human-approver', id: 'steepy-it' };
const PROVENANCE = [{ quotation: 'Quoted evidence for this approval.', source: 'docs/spec.md:566', digest: 'a'.repeat(64) }];

function qid(localId) {
  return `apex:${PROJECT}:${localId}`;
}

const ID = {
  project: qid('project:root'),
  surface: qid('surface:scripts'),
  agent: qid('agent:scripts-agent'),
  check: qid('check:surface-test'),
  rule: qid('rule:sanitize-external-input'),
  term: qid('term:added'),
  ruleAdded: qid('rule:added-by-scenario'),
  ruleInvalid: qid('rule:missing-statement'),
  ruleA: qid('rule:apply-a'),
  ruleB: qid('rule:apply-b'),
};

function addNode(type, id, properties = {}) {
  return { op: 'ADD', target: 'node', namespace: 'curated', type, id, properties: { id, status: 'active', ...properties } };
}

function addEdge(type, fromId, toId) {
  return { op: 'ADD', target: 'edge', namespace: 'curated', type, fromId, toId };
}

function ruleOp(id, overrides = {}) {
  return addNode('Rule', id, {
    title: `Rule ${id}`,
    statement: 'A normative statement.',
    strength: 'must',
    category: 'engineering',
    concern: 'external-input',
    provenance: { source: 'spec', line: 52 },
    ...overrides,
  });
}

function baseMeta(overrides = {}) {
  return {
    projectId: PROJECT,
    proposer: { type: 'agent-proposer', id: 'scripts-agent' },
    approver: APPROVER,
    provenance: PROVENANCE,
    timestamp: '2026-08-12T10:00:00.000Z',
    ...overrides,
  };
}

// A B4-clean stable graph promoted the way the product promotes, leaving the head at r3.
async function seedBaseGraph(port) {
  await applyChangeSet(port, { operations: [addNode('Project', ID.project)] }, baseMeta());
  await applyChangeSet(port, { operations: [addNode('Surface', ID.surface), addEdge('PART_OF', ID.surface, ID.project)] }, baseMeta());
  await applyChangeSet(
    port,
    {
      operations: [
        addNode('Agent', ID.agent),
        addEdge('OWNED_BY', ID.surface, ID.agent),
        addNode('Check', ID.check),
        ruleOp(ID.rule),
        addEdge('APPLIES_TO', ID.rule, ID.surface),
        addEdge('VERIFIED_BY', ID.rule, ID.check),
      ],
    },
    baseMeta(),
  );
}

// A promotable scenario: one new Rule on its own concern plus its explicit scope, so the projection
// is B4-clean and the advisor silent.
function promotableOps(ruleId = ID.ruleAdded, concern = 'scenario-only') {
  return [ruleOp(ruleId, { concern, title: `Brand new rule ${ruleId}` }), addEdge('APPLIES_TO', ruleId, ID.surface)];
}

async function withPort(fn) {
  const port = createMemoryPort();
  try {
    return await fn(port);
  } finally {
    await port.close();
  }
}

async function scenarioRecords(port, scenarioId) {
  return withTransaction(port, async (tx) => ({
    nodes: (await tx.listNodes({ namespace: 'scenario', scenarioId })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: await tx.listEdges({ namespace: 'scenario', scenarioId }),
  }));
}

async function stableRecords(port) {
  return withTransaction(port, async (tx) => {
    const out = {};
    for (const namespace of ['curated', 'topology']) {
      out[namespace] = {
        nodes: (await tx.listNodes({ namespace })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        edges: (await tx.listEdges({ namespace })).sort((a, b) => {
          const ka = `${a.type} ${a.fromId} ${a.toId}`;
          const kb = `${b.type} ${b.fromId} ${b.toId}`;
          return ka < kb ? -1 : ka > kb ? 1 : 0;
        }),
      };
    }
    return out;
  });
}

async function stableNodeIds(port, namespace) {
  return (await stableRecords(port))[namespace].nodes.map((node) => node.id);
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'steepy-promotion-apply-'));
}

// Injects a mid-apply failure on the port: `createNode` of the named (namespace, id) throws a
// PortError inside the promotion transaction, so `applyChangeSet` refuses and `withTransaction`
// rolls back atomically. Everything else passes through untouched.
function portFailingOnCreate(port, { namespace, id }) {
  return {
    async capabilities() {
      return port.capabilities();
    },
    async begin() {
      const tx = await port.begin();
      return new Proxy(tx, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          return async (...args) => {
            const input = args[0] ?? {};
            if (property === 'createNode' && input.namespace === namespace && input.id === id) {
              throw portError('INJECTED_FAILURE', `injected mid-apply failure creating node '${id}'.`, { namespace, id });
            }
            return value.apply(target, args);
          };
        },
      });
    },
    async close() {
      return port.close();
    },
  };
}

// --- binding 1: the proposer is recorded at create, not invented at apply -------------------------

test('createScenario requires the proposing actor and records it on the meta', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await assert.rejects(() => createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO }), TypeError);
    await assert.rejects(() => createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: 'nope' }), TypeError);
    await assert.rejects(() => createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: { type: 'not-an-actor', name: 'x' } }), TypeError);
    await assert.rejects(() => createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: { type: 'agent-proposer', name: '' } }), TypeError);

    const created = await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY });
    assert.equal(created.ok, true);
    assert.deepEqual(created.proposedBy, PROPOSED_BY);
    const { nodes } = await scenarioRecords(port, SCENARIO);
    assert.deepEqual(nodes[0].properties.proposedBy, PROPOSED_BY);
  });
});

// --- the additive D4 projection helper (shared, not duplicated) ----------------------------------

test('projectGraph (D4 projection helper) is additive: applies applied ops, ignores annotations, reports failures', () => {
  const base = {
    nodes: [addNode('Project', ID.project), addNode('Surface', ID.surface)],
    edges: [addEdge('PART_OF', ID.surface, ID.project)],
  };
  const projection = projectGraph(base, [
    ruleOp(ID.ruleAdded, { concern: 'scenario-only', title: 'Brand new rule' }),
    { op: 'POSSIBLE_DUPLICATE', candidateId: ID.ruleAdded, againstId: ID.rule, matchedProperty: 'title', matchedValue: 'x' },
    addEdge('APPLIES_TO', ID.ruleAdded, ID.surface),
  ]);
  assert.deepEqual(projection.failures, []);
  assert.equal(projection.nodes.length, 3);
  assert.equal(projection.edges.length, 2);
  assert.ok(projection.nodes.some((node) => node.id === ID.ruleAdded && node.type === 'Rule'));
  assert.ok(projection.edges.some((edge) => edge.type === 'APPLIES_TO' && edge.fromId === ID.ruleAdded));

  const failing = projectGraph(base, [{ op: 'MODIFY', target: 'node', namespace: 'curated', id: ID.rule, properties: { id: ID.rule, status: 'deprecated' } }]);
  assert.deepEqual(failing.failures, [{ index: 0, op: 'MODIFY', target: 'node', reason: `node '${ID.rule}' does not exist` }]);
});

// --- happy path: apply + Revision + consume + export + retention ---------------------------------

test('happy path apply: head advances, Revision carries proposer+approver+provenance, scenario consumed, export written with the new head, retention kept', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const { headRevision: base } = await readChain(port, { projectId: PROJECT });
    assert.equal(base, 'apex:proj:revision:r3');
    await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY, operations: promotableOps() });

    const dir = tmpDir();
    try {
      const result = await applyPromotion(port, {
        projectId: PROJECT,
        scenarioId: SCENARIO,
        approver: APPROVER,
        provenance: PROVENANCE,
        exportDir: dir,
        retention: { keepLast: 2, keepDaily: false },
        clock: () => '2026-08-12T12:00:00.000Z',
      });
      assert.equal(result.ok, true);
      assert.equal(result.scenarioId, SCENARIO);
      assert.equal(result.scenarioConsumed, true);
      assert.equal(result.headRevision, 'apex:proj:revision:r4');
      assert.equal(result.applied.operations.length, 2);

      // the chain grew: head advanced, the new Revision records the scenario's proposer, the
      // caller's approver and the self-contained provenance, chained onto the base revision
      const { headRevision, revisions } = await readChain(port, { projectId: PROJECT });
      assert.equal(headRevision, 'apex:proj:revision:r4');
      assert.equal(revisions.length, 4);
      const [latest] = revisions.slice(-1);
      assert.equal(latest.previousRevision, base);
      assert.deepEqual(latest.proposer, { type: 'agent-proposer', id: 'scripts-agent' });
      assert.deepEqual(latest.approver, APPROVER);
      assert.deepEqual(latest.provenance, PROVENANCE);
      assert.equal((await verifyChain(port, { projectId: PROJECT })).ok, true);

      // the promoted node is materialized in the stable graph, and the graph is B4-green
      assert.ok((await stableNodeIds(port, 'curated')).includes(ID.ruleAdded));
      assert.equal((await validateGraph(port, { projectId: PROJECT })).ok, true);

      // the scenario is consumed: no scenario-namespace records remain
      assert.deepEqual((await scenarioRecords(port, SCENARIO)).nodes, []);

      // the export was written with the new head revision, name embeds the revision and a timestamp
      const names = readdirSync(dir).filter((name) => name.endsWith(EXPORT_FILE_EXTENSION));
      assert.deepEqual(names, [`export-proj-r4-2026-08-12T12-00-00-000Z${EXPORT_FILE_EXTENSION}`]);
      const artifact = parseExportArtifact(readFileSync(join(dir, names[0]), 'utf8'));
      assert.equal(artifact.ok, true);
      assert.equal(artifact.header.headRevision, headRevision);

      // retention, re-run, keeps exactly the fresh export
      const decision = pruneExportDirectory(dir, { keepLast: 2, keepDaily: false });
      assert.deepEqual(decision.keep, [names[0]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('applyPromotion with no exportDir applies and consumes but reports export: null', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY, operations: promotableOps() });
    const result = await applyPromotion(port, { projectId: PROJECT, scenarioId: SCENARIO, approver: APPROVER, provenance: PROVENANCE });
    assert.equal(result.ok, true);
    assert.equal(result.headRevision, 'apex:proj:revision:r4');
    assert.equal(result.export, null);
    assert.equal(result.scenarioConsumed, true);
    assert.deepEqual((await scenarioRecords(port, SCENARIO)).nodes, []);
  });
});

test('applyPromotion prunes older exports per the retention config and the default keeps the fresh one', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const dir = tmpDir();
    try {
      const run = async (scenarioId, ruleId, concern, clock) => {
        await createScenario(port, {
          projectId: PROJECT,
          scenarioId,
          proposedBy: PROPOSED_BY,
          operations: promotableOps(ruleId, concern),
        });
        const result = await applyPromotion(port, {
          projectId: PROJECT,
          scenarioId,
          approver: APPROVER,
          provenance: PROVENANCE,
          exportDir: dir,
          retention: { keepLast: 1, keepDaily: false },
          clock,
        });
        assert.equal(result.ok, true);
      };
      await run('apply-a', ID.ruleA, 'scenario-only', () => '2026-08-10T00:00:00.000Z');
      await run('apply-b', ID.ruleB, 'packaging', () => '2026-08-11T00:00:00.000Z');

      // keepLast 1 pruned the first promotion's export on the second promotion
      const names = readdirSync(dir).filter((name) => name.endsWith(EXPORT_FILE_EXTENSION));
      assert.deepEqual(names, [`export-proj-r5-2026-08-11T00-00-00-000Z${EXPORT_FILE_EXTENSION}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await withPort(async (port) => {
    await seedBaseGraph(port);
    const dir = tmpDir();
    try {
      // with no retention config, DEFAULT_EXPORT_RETENTION applies and the just-written export is
      // kept (never pruned by the very promotion that wrote it)
      await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY, operations: promotableOps() });
      const result = await applyPromotion(port, {
        projectId: PROJECT,
        scenarioId: SCENARIO,
        approver: APPROVER,
        provenance: PROVENANCE,
        exportDir: dir,
        clock: () => '2026-08-12T12:00:00.000Z',
      });
      assert.equal(result.ok, true);
      assert.equal(result.export.ok, true);
      assert.deepEqual(result.export.pruned.drop, []);
      const names = readdirSync(dir).filter((name) => name.endsWith(EXPORT_FILE_EXTENSION));
      assert.equal(names.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- refusals: stale, dirty projection, empty, invalid approver/provenance, unknown --------------

test('applyPromotion refuses a PROMOTION_STALE scenario: the base revision moved', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const created = await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY, operations: promotableOps() });
    await applyChangeSet(port, { operations: [addNode('Term', ID.term)] }, baseMeta());
    const { headRevision } = await readChain(port, { projectId: PROJECT });
    assert.notEqual(headRevision, created.baseRevision);

    const result = await applyPromotion(port, { projectId: PROJECT, scenarioId: SCENARIO, approver: APPROVER, provenance: PROVENANCE });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROMOTION_ERROR_CODES.PROMOTION_STALE);
    assert.deepEqual(result.identity, { scenarioId: SCENARIO, baseRevision: created.baseRevision, headRevision });

    // nothing was applied and the scenario is intact
    const { headRevision: after } = await readChain(port, { projectId: PROJECT });
    assert.equal(after, headRevision);
    assert.equal((await scenarioRecords(port, SCENARIO)).nodes.length, 3);
  });
});

test('applyPromotion refuses a dirty projection: a candidate B4 cannot certify is not promotable', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const brokenRule = ruleOp(ID.ruleInvalid, { concern: 'scenario-only', title: 'Incomplete' });
    delete brokenRule.properties.statement;
    await createScenario(port, {
      projectId: PROJECT,
      scenarioId: SCENARIO,
      proposedBy: PROPOSED_BY,
      operations: [brokenRule, addEdge('APPLIES_TO', ID.ruleInvalid, ID.surface)],
    });
    const result = await applyPromotion(port, { projectId: PROJECT, scenarioId: SCENARIO, approver: APPROVER, provenance: PROVENANCE });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROMOTION_ERROR_CODES.SCENARIO_INVALID);
    assert.ok(result.identity.violations.some((found) => found.code === 'MISSING_REQUIRED_PROPERTY'));

    const { headRevision } = await readChain(port, { projectId: PROJECT });
    assert.equal(headRevision, 'apex:proj:revision:r3');
    assert.equal((await scenarioRecords(port, SCENARIO)).nodes.length, 3);
  });
});

test('applyPromotion refuses an empty scenario: nothing, or only annotations, cannot be promoted', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, { projectId: PROJECT, scenarioId: 'empty', proposedBy: PROPOSED_BY, operations: [] });
    const result = await applyPromotion(port, { projectId: PROJECT, scenarioId: 'empty', approver: APPROVER, provenance: PROVENANCE });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROMOTION_ERROR_CODES.SCENARIO_EMPTY);
    assert.deepEqual(result.identity, { scenarioId: 'empty' });

    await createScenario(port, {
      projectId: PROJECT,
      scenarioId: 'annotations-only',
      proposedBy: PROPOSED_BY,
      operations: [{ op: 'POSSIBLE_DUPLICATE', candidateId: ID.rule, againstId: ID.rule }],
    });
    const second = await applyPromotion(port, { projectId: PROJECT, scenarioId: 'annotations-only', approver: APPROVER, provenance: PROVENANCE });
    assert.equal(second.ok, false);
    assert.equal(second.code, PROMOTION_ERROR_CODES.SCENARIO_EMPTY);

    const { headRevision } = await readChain(port, { projectId: PROJECT });
    assert.equal(headRevision, 'apex:proj:revision:r3');
  });
});

test('applyPromotion refuses an invalid approver or provenance, judged by validateRevisionMeta', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY, operations: promotableOps() });

    const badApprover = await applyPromotion(port, { projectId: PROJECT, scenarioId: SCENARIO, approver: { type: 'not-an-actor', id: 'x' }, provenance: PROVENANCE });
    assert.equal(badApprover.ok, false);
    assert.equal(badApprover.code, 'INVALID_ACTOR_IDENTITY');

    const badProvenance = await applyPromotion(port, { projectId: PROJECT, scenarioId: SCENARIO, approver: APPROVER, provenance: [] });
    assert.equal(badProvenance.ok, false);
    assert.equal(badProvenance.code, 'INVALID_PROVENANCE');

    const { headRevision } = await readChain(port, { projectId: PROJECT });
    assert.equal(headRevision, 'apex:proj:revision:r3');
    assert.equal((await scenarioRecords(port, SCENARIO)).nodes.length, 3);
  });
});

test('applyPromotion refuses an unknown scenario with SCENARIO_NOT_FOUND', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const result = await applyPromotion(port, { projectId: PROJECT, scenarioId: 'never-created', approver: APPROVER, provenance: PROVENANCE });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROMOTION_ERROR_CODES.SCENARIO_NOT_FOUND);
  });
});

test('applyPromotion throws only on programmer error', async () => {
  await withPort(async (port) => {
    await assert.rejects(() => applyPromotion(undefined, { projectId: PROJECT, scenarioId: SCENARIO }), TypeError);
    await assert.rejects(() => applyPromotion(port, { projectId: 'Not A Project', scenarioId: SCENARIO }), TypeError);
    await assert.rejects(() => applyPromotion(port, { projectId: PROJECT, scenarioId: '' }), TypeError);
    await assert.rejects(() => applyPromotion(port, { projectId: PROJECT }), TypeError);
    await assert.rejects(() => applyPromotion(port, { projectId: PROJECT, scenarioId: SCENARIO, bogus: true }), TypeError);
    await assert.rejects(() => applyPromotion(port, { projectId: PROJECT, scenarioId: SCENARIO, exportDir: 42 }), TypeError);
    await assert.rejects(() => applyPromotion(port, { projectId: PROJECT, scenarioId: SCENARIO, retention: 'keep' }), TypeError);
    await assert.rejects(() => applyPromotion(port, { projectId: PROJECT, scenarioId: SCENARIO, clock: 'noon' }), TypeError);
  });
});

// --- the failure table: rollback, and discard-residue re-assertion -------------------------------

test('a mid-apply injected failure rolls back atomically: prior revision stays readable, no residue', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const failing = portFailingOnCreate(port, { namespace: 'curated', id: ID.ruleAdded });
    await createScenario(failing, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY, operations: promotableOps() });

    const result = await applyPromotion(failing, { projectId: PROJECT, scenarioId: SCENARIO, approver: APPROVER, provenance: PROVENANCE });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INJECTED_FAILURE');

    // the prior canonical revision remains the head and is still readable; the chain is intact
    const { headRevision, revisions } = await readChain(port, { projectId: PROJECT });
    assert.equal(headRevision, 'apex:proj:revision:r3');
    assert.equal(revisions.length, 3);
    assert.equal((await verifyChain(port, { projectId: PROJECT })).ok, true);
    // no residue in the stable graph, and the scenario is intact (never consumed)
    assert.ok(!(await stableNodeIds(port, 'curated')).includes(ID.ruleAdded));
    assert.equal((await scenarioRecords(port, SCENARIO)).nodes.length, 3);
  });
});

test('a post-commit export failure is REPORTED, never rolled back: the promotion is durable', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY, operations: promotableOps() });
    const failingFs = { writeFileSync() { throw new Error('disk full'); } };

    const result = await applyPromotion(port, {
      projectId: PROJECT,
      scenarioId: SCENARIO,
      approver: APPROVER,
      provenance: PROVENANCE,
      exportDir: '/nowhere',
      fs: failingFs,
    });
    // the promotion committed and the scenario was consumed...
    assert.equal(result.ok, true);
    assert.equal(result.headRevision, 'apex:proj:revision:r4');
    assert.equal(result.scenarioConsumed, true);
    // ...and the export failure is reported with an explicit code, never rolled back
    assert.equal(result.export.ok, false);
    assert.equal(result.export.code, PROMOTION_ERROR_CODES.EXPORT_WRITE_FAILED);
    assert.equal(result.export.identity.headRevision, 'apex:proj:revision:r4');

    const { headRevision, revisions } = await readChain(port, { projectId: PROJECT });
    assert.equal(headRevision, 'apex:proj:revision:r4');
    assert.equal(revisions.length, 4);
    assert.equal((await verifyChain(port, { projectId: PROJECT })).ok, true);
    assert.ok((await stableNodeIds(port, 'curated')).includes(ID.ruleAdded));
    assert.deepEqual((await scenarioRecords(port, SCENARIO)).nodes, []);
  });
});

test('discard leaves no residue: no scenario records remain and the stable context is byte-identical', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const stableBefore = JSON.stringify(await stableRecords(port));
    await createScenario(port, {
      projectId: PROJECT,
      scenarioId: SCENARIO,
      proposedBy: PROPOSED_BY,
      operations: [...promotableOps(), { op: 'POSSIBLE_DUPLICATE', candidateId: ID.ruleAdded, againstId: ID.rule }],
    });
    await discardScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.deepEqual((await scenarioRecords(port, SCENARIO)).nodes, []);
    assert.equal(JSON.stringify(await stableRecords(port)), stableBefore);
  });
});

test('promotionExportFileName embeds the head revision and a filesystem-safe timestamp', () => {
  assert.equal(
    promotionExportFileName('proj', 'apex:proj:revision:r7', '2026-08-12T10:30:45.123Z'),
    `export-proj-r7-2026-08-12T10-30-45-123Z${EXPORT_FILE_EXTENSION}`,
  );
});

// --- live: docker-gated ArcadeDB — the first end-to-end promotion on the real engine -------------

const gate = dockerGate();
const CONTAINER = 'apex-formula-promotion-test';

if (!gate.ok) {
  test(`ArcadeDB live promotion suite (docker-gated): ${gate.reason}`, (t) => {
    t.diagnostic(`SKIPPED — ${gate.reason} (pinned image ${ARCADEDB_IMAGE})`);
    t.skip(gate.reason);
  });
} else {
  describe('arcadedb live promotion (docker-gated)', () => {
    let server = null;

    before(async () => {
      await destroyContainer(CONTAINER, { removeVolume: true }); // a crashed earlier run leaves no trap
      server = await startServer({ name: CONTAINER, timeoutMs: 90_000 });
    });

    after(async () => {
      await destroyContainer(CONTAINER, { removeVolume: true });
      server = null;
    });

    test('live ArcadeDB: happy-path apply, Revision with proposer+approver, scenario consumed, export written', async () => {
      const database = `apex_d5_${randomUUID().replaceAll('-', '')}`;
      await createDatabase(server, database);
      const port = createArcadeDbPort({ server, database, dropDatabaseOnClose: true });
      const dir = tmpDir();
      try {
        await seedBaseGraph(port);
        const { headRevision: base } = await readChain(port, { projectId: PROJECT });
        assert.equal(base, 'apex:proj:revision:r3');
        await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY, operations: promotableOps() });

        const result = await applyPromotion(port, {
          projectId: PROJECT,
          scenarioId: SCENARIO,
          approver: APPROVER,
          provenance: PROVENANCE,
          exportDir: dir,
          retention: { keepLast: 2, keepDaily: false },
          clock: () => '2026-08-12T12:00:00.000Z',
        });
        assert.equal(result.ok, true);
        assert.equal(result.headRevision, 'apex:proj:revision:r4');

        const { headRevision, revisions } = await readChain(port, { projectId: PROJECT });
        assert.equal(headRevision, 'apex:proj:revision:r4');
        const [latest] = revisions.slice(-1);
        assert.equal(latest.previousRevision, base);
        assert.deepEqual(latest.proposer, { type: 'agent-proposer', id: 'scripts-agent' });
        assert.deepEqual(latest.approver, APPROVER);
        assert.deepEqual(latest.provenance, PROVENANCE);
        assert.equal((await verifyChain(port, { projectId: PROJECT })).ok, true);
        assert.equal((await validateGraph(port, { projectId: PROJECT })).ok, true);
        assert.deepEqual((await scenarioRecords(port, SCENARIO)).nodes, []);

        const names = readdirSync(dir).filter((name) => name.endsWith(EXPORT_FILE_EXTENSION));
        assert.deepEqual(names, [`export-proj-r4-2026-08-12T12-00-00-000Z${EXPORT_FILE_EXTENSION}`]);
        const artifact = parseExportArtifact(readFileSync(join(dir, names[0]), 'utf8'));
        assert.equal(artifact.ok, true);
        assert.equal(artifact.header.headRevision, headRevision);
      } finally {
        await port.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('live ArcadeDB: injected mid-apply failure rolls back atomically, prior revision stays readable', async () => {
      const database = `apex_d5_${randomUUID().replaceAll('-', '')}`;
      await createDatabase(server, database);
      const port = createArcadeDbPort({ server, database, dropDatabaseOnClose: true });
      try {
        await seedBaseGraph(port);
        const failing = portFailingOnCreate(port, { namespace: 'curated', id: ID.ruleAdded });
        await createScenario(failing, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY, operations: promotableOps() });

        const result = await applyPromotion(failing, { projectId: PROJECT, scenarioId: SCENARIO, approver: APPROVER, provenance: PROVENANCE });
        assert.equal(result.ok, false);
        assert.equal(result.code, 'INJECTED_FAILURE');

        const { headRevision, revisions } = await readChain(port, { projectId: PROJECT });
        assert.equal(headRevision, 'apex:proj:revision:r3');
        assert.equal(revisions.length, 3);
        assert.equal((await verifyChain(port, { projectId: PROJECT })).ok, true);
        assert.ok(!(await stableNodeIds(port, 'curated')).includes(ID.ruleAdded));
        assert.equal((await scenarioRecords(port, SCENARIO)).nodes.length, 3);
      } finally {
        await port.close();
      }
    });
  });
}
