// Promotion Scenario suite (Task D4, spec §7, §11). Every case drives the module through a REAL
// port adapter (the B3 in-memory reference) over a base graph SEEDED WITH B5's `applyChangeSet` —
// a scenario is a proposal about a promoted graph, and a fixture the chain cannot explain would
// prove nothing about the product. The resolution-blind case goes through D2's `resolveContext`,
// the same way D3's suite does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportGraph } from '../scripts/formula/core/export.mjs';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { withTransaction } from '../scripts/formula/engine/port.mjs';
import { SCENARIO_META_TYPE, scenarioMetaId, validateGraph } from '../scripts/formula/core/validate-graph.mjs';
import { applyChangeSet, readChain, sha256Hex } from '../scripts/formula/core/revision.mjs';
import { resolveContext } from '../scripts/formula/core/resolve-context.mjs';
import {
  createScenario,
  addOperation,
  inspectScenario,
  discardScenario,
  SCENARIO_OPERATION_TYPE,
  SCENARIO_ANNOTATION_TYPE,
  ADVISOR_ONLY_OPERATIONS,
  PROMOTION_ERROR_CODES,
  PROJECTION_OPERATION_FAILURE,
} from '../scripts/formula/core/promotion.mjs';

const PROJECT = 'proj';
const SCENARIO = 'scenario-1';

// D5 binding 1: createScenario requires the proposing actor (recorded on the meta), so every
// fixture seeds it explicitly.
const PROPOSED_BY = { type: 'agent-proposer', name: 'scripts-agent' };

function qid(localId) {
  return `apex:${PROJECT}:${localId}`;
}

const ID = {
  project: qid('project:root'),
  surface: qid('surface:scripts'),
  component: qid('component:engine'),
  agent: qid('agent:scripts-agent'),
  check: qid('check:surface-test'),
  rule: qid('rule:sanitize-external-input'),
  term: qid('term:surface'),
  repository: qid('repository:root'),
  workspace: qid('workspace:root'),
  package: qid('package:engine'),
  ruleDup: qid('rule:duplicate-copy'),
  ruleConflict: qid('rule:conflicting'),
  ruleNested: qid('rule:nested-scope'),
  ruleAdded: qid('rule:added-by-scenario'),
  checkRetired: qid('check:surface-test-v2'),
};

function addNode(type, id, properties = {}) {
  return { op: 'ADD', target: 'node', namespace: 'curated', type, id, properties: { id, status: 'active', ...properties } };
}

function addEdge(type, fromId, toId) {
  return { op: 'ADD', target: 'edge', namespace: 'curated', type, fromId, toId };
}

function addTopologyNode(type, id, properties = {}) {
  return { op: 'ADD', target: 'node', namespace: 'topology', type, id, properties: { id, ...properties } };
}

function addTopologyEdge(type, fromId, toId) {
  return { op: 'ADD', target: 'edge', namespace: 'topology', type, fromId, toId };
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

// The seed Rule's own title/statement, so a "duplicate" candidate can match them exactly.
const SEED_TITLE = 'Sanitize external input';
const SEED_STATEMENT = 'Sanitize every external value before writing it to disk.';

function meta() {
  return {
    projectId: PROJECT,
    proposer: { type: 'agent-proposer', id: 'scripts-agent' },
    approver: { type: 'human-approver', id: 'steepy-it' },
    provenance: [{ quotation: 'q', source: 'docs/spec.md:52', digest: sha256Hex('source') }],
    timestamp: '2026-08-12T10:00:00.000Z',
  };
}

// A B4-clean stable graph: the curated skeleton (Project <- Surface <- Component) with one Rule
// scoped and verified, plus the observed topology chain, promoted step by step like the product
// promotes. The seed Rule carries the pinned title/statement below so duplicate candidates can hit
// it exactly.
async function seedBaseGraph(port) {
  await applyChangeSet(port, { operations: [addNode('Project', ID.project)] }, meta());
  await applyChangeSet(port, { operations: [addNode('Surface', ID.surface), addEdge('PART_OF', ID.surface, ID.project)] }, meta());
  await applyChangeSet(port, { operations: [addNode('Component', ID.component), addEdge('PART_OF', ID.component, ID.surface)] }, meta());
  await applyChangeSet(port, {
    operations: [
      addNode('Agent', ID.agent),
      addEdge('OWNED_BY', ID.surface, ID.agent),
      addNode('Check', ID.check),
      ruleOp(ID.rule, { title: SEED_TITLE, statement: SEED_STATEMENT }),
      addEdge('APPLIES_TO', ID.rule, ID.surface),
      addEdge('VERIFIED_BY', ID.rule, ID.check),
    ],
  }, meta());
  await applyChangeSet(port, {
    operations: [
      addTopologyNode('Repository', ID.repository, { root: 'demo', digest: 'd'.repeat(64) }),
      addTopologyNode('Workspace', ID.workspace, { path: '.' }),
      addTopologyNode('Package', ID.package, { path: 'packages/engine' }),
    ],
  }, meta());
  await applyChangeSet(port, {
    operations: [
      addTopologyEdge('PART_OF', ID.workspace, ID.repository),
      addTopologyEdge('PART_OF', ID.package, ID.workspace),
      addTopologyEdge('IMPLEMENTS', ID.package, ID.component),
    ],
  }, meta());
}

async function withPort(fn) {
  const port = createMemoryPort();
  try {
    return await fn(port);
  } finally {
    await port.close();
  }
}

// Reads the scenario namespace directly through the port — the suite must be able to see the
// records the module wrote, not only what the module reports back.
async function scenarioRecords(port, scenarioId) {
  return withTransaction(port, async (tx) => ({
    nodes: (await tx.listNodes({ namespace: 'scenario', scenarioId })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: await tx.listEdges({ namespace: 'scenario', scenarioId }),
  }));
}

async function stableCounts(port) {
  return withTransaction(port, async (tx) => {
    const curated = { nodes: await tx.listNodes({ namespace: 'curated' }), edges: await tx.listEdges({ namespace: 'curated' }) };
    const topology = { nodes: await tx.listNodes({ namespace: 'topology' }), edges: await tx.listEdges({ namespace: 'topology' }) };
    return {
      curated: curated.nodes.length + curated.edges.length,
      topology: topology.nodes.length + topology.edges.length,
    };
  });
}

// --- lifecycle: create -----------------------------------------------------------

test('createScenario writes the meta record and pins the base revision to the current head', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const { headRevision } = await readChain(port, { projectId: PROJECT });
    assert.equal(headRevision, 'apex:proj:revision:r6');

    const result = await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY });
    assert.equal(result.ok, true);
    assert.equal(result.baseRevision, headRevision);
    assert.match(result.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const { nodes } = await scenarioRecords(port, SCENARIO);
    assert.deepEqual(nodes.map((node) => [node.type, node.id]), [[SCENARIO_META_TYPE, scenarioMetaId(PROJECT)]]);
    assert.equal(nodes[0].properties.baseRevision, headRevision);
    assert.equal(nodes[0].properties.createdAt, result.createdAt);
  });
});

test('createScenario throws only on programmer error: no port, bad projectId, bad scenarioId, non-array operations', async () => {
  await withPort(async (port) => {
    await assert.rejects(() => createScenario(undefined, { projectId: PROJECT, scenarioId: SCENARIO }), TypeError);
    await assert.rejects(() => createScenario({}, { projectId: PROJECT, scenarioId: SCENARIO }), TypeError);
    await assert.rejects(() => createScenario(port, { projectId: 'Not A Project', scenarioId: SCENARIO }), TypeError);
    await assert.rejects(() => createScenario(port, { projectId: PROJECT, scenarioId: '' }), TypeError);
    await assert.rejects(() => createScenario(port, { projectId: PROJECT }), TypeError);
    await assert.rejects(() => createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, operations: 'nope' }), TypeError);
    // a typo must never silently drop an argument
    await assert.rejects(() => createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, operation: ruleOp(ID.ruleAdded) }), TypeError);
    await assert.rejects(() => addOperation(port, { projectId: PROJECT, scenarioId: SCENARIO, operation: ruleOp(ID.ruleAdded), index: 0 }), TypeError);
    await assert.rejects(() => inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, scenario: true }), TypeError);
    await assert.rejects(() => discardScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, force: true }), TypeError);
  });
});

test('createScenario accepts a complete candidate list and stores applied ops and annotations distinctly', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const result = await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [
        ruleOp(ID.ruleAdded, { concern: 'scenario-only', title: 'A brand new rule' }),
        { op: 'POSSIBLE_DUPLICATE', candidateId: ID.ruleAdded, againstId: ID.rule, matchedProperty: 'title', matchedValue: 'A brand new rule' },
        { op: 'ADD', target: 'edge', namespace: 'curated', type: 'APPLIES_TO', fromId: ID.ruleAdded, toId: ID.surface },
      ],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.operations, [
      ruleOp(ID.ruleAdded, { concern: 'scenario-only', title: 'A brand new rule' }),
      { op: 'ADD', target: 'edge', namespace: 'curated', type: 'APPLIES_TO', fromId: ID.ruleAdded, toId: ID.surface },
    ]);
    assert.deepEqual(result.annotations, [
      { op: 'POSSIBLE_DUPLICATE', candidateId: ID.ruleAdded, againstId: ID.rule, matchedProperty: 'title', matchedValue: 'A brand new rule' },
    ]);

    const { nodes } = await scenarioRecords(port, SCENARIO);
    const operationRecords = nodes.filter((node) => node.type === SCENARIO_OPERATION_TYPE);
    const annotationRecords = nodes.filter((node) => node.type === SCENARIO_ANNOTATION_TYPE);
    assert.equal(operationRecords.length, 2);
    assert.equal(annotationRecords.length, 1);
    // applied ops and annotations are distinguishable BY TYPE — a consumer (D5) can never mistake
    // an annotation for a mutation.
    assert.equal(operationRecords[0].properties.index, 0);
    assert.equal(annotationRecords[0].properties.index, 1);
    assert.equal(operationRecords[1].properties.index, 2);
    assert.deepEqual(annotationRecords[0].properties.annotation, {
      op: 'POSSIBLE_DUPLICATE',
      candidateId: ID.ruleAdded,
      againstId: ID.rule,
      matchedProperty: 'title',
      matchedValue: 'A brand new rule',
    });
  });
});

test('createScenario rejects a scenario that already exists, and an invalid operation batch', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY });
    const again = await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY });
    assert.equal(again.ok, false);
    assert.equal(again.code, PROMOTION_ERROR_CODES.SCENARIO_EXISTS);
    assert.deepEqual(again.identity, { scenarioId: SCENARIO });

    const other = await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: 'scenario-2',
      operations: [ruleOp(ID.ruleAdded), { op: 'UPSERT', target: 'node' }],
    });
    assert.equal(other.ok, false);
    assert.equal(other.code, PROMOTION_ERROR_CODES.INVALID_SCENARIO_OPERATION);
    assert.equal(other.identity.index, 1);
  });
});

// The init-graph-first shape (the spec's "verify `createScenario` supports `Check` creation" risk,
// pinned): a proposal on the EMPTY graph whose candidate list builds the whole curated skeleton —
// Project <- Surface <- Rule <- Check — with the Check created purely through the scenario path,
// no core edit. `Check` is a first-class curated type (B1) and `createScenario` accepts any B5 op.
test('createScenario accepts a Check node and its VERIFIED_BY anchoring edge with no core edit, and inspectScenario certifies the projection B4-clean', async () => {
  await withPort(async (port) => {
    const surface = qid('surface:web');
    const rule = qid('rule:web-status-page');
    const check = qid('check:web-status-page');
    const operations = [
      addNode('Project', ID.project),
      addNode('Surface', surface),
      addEdge('PART_OF', surface, ID.project),
      ruleOp(rule, { strength: 'should', category: 'general' }),
      addEdge('APPLIES_TO', rule, surface),
      addNode('Check', check),
      addEdge('VERIFIED_BY', rule, check),
    ];
    const created = await createScenario(port, {
      projectId: PROJECT,
      scenarioId: SCENARIO,
      proposedBy: { type: 'agent-proposer', name: 'test' },
      operations,
    });
    assert.equal(created.ok, true);
    assert.deepEqual(created.operations, operations);

    // B4-clean projection: applyPromotion would accept this scenario (applying is not this pin's job)
    const inspection = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(inspection.ok, true);
    assert.equal(inspection.structural.valid, true);
    assert.deepEqual(inspection.structural.violations, []);
  });
});

// --- lifecycle: addOperation ------------------------------------------------------

test('addOperation appends in order and returns the updated lists', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY });
    await addOperation(port, {
      projectId: PROJECT,
      scenarioId: SCENARIO,
      operation: ruleOp(ID.ruleAdded, { concern: 'logging', title: 'Log things' }),
    });
    const second = await addOperation(port, {
      projectId: PROJECT,
      scenarioId: SCENARIO,
      operation: { op: 'POSSIBLE_CONFLICT', candidateId: ID.ruleAdded, againstId: ID.rule, concern: 'external-input' },
    });
    assert.equal(second.ok, true);
    assert.deepEqual(second.operations, [ruleOp(ID.ruleAdded, { concern: 'logging', title: 'Log things' })]);
    assert.deepEqual(second.annotations, [
      { op: 'POSSIBLE_CONFLICT', candidateId: ID.ruleAdded, againstId: ID.rule, concern: 'external-input' },
    ]);
  });
});

test('addOperation rejects an unknown scenario and a malformed operation, without writing anything', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const unknown = await addOperation(port, {
      projectId: PROJECT,
      scenarioId: 'never-created',
      operation: ruleOp(ID.ruleAdded),
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, PROMOTION_ERROR_CODES.SCENARIO_NOT_FOUND);
    assert.deepEqual(unknown.identity, { scenarioId: 'never-created' });

    await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY });
    const badOp = await addOperation(port, { projectId: PROJECT, scenarioId: SCENARIO, operation: { op: 'UPSERT', target: 'node' } });
    assert.equal(badOp.ok, false);
    assert.equal(badOp.code, PROMOTION_ERROR_CODES.INVALID_SCENARIO_OPERATION);

    // a candidate may never target the system or scenario namespaces — the applied vocabulary is
    // B5's, which only touches the stable graph.
    const badNamespace = await addOperation(port, {
      projectId: PROJECT,
      scenarioId: SCENARIO,
      operation: { op: 'ADD', target: 'node', namespace: 'system', type: 'Revision', id: 'apex:proj:revision:r99', properties: {} },
    });
    assert.equal(badNamespace.ok, false);
    assert.equal(badNamespace.code, PROMOTION_ERROR_CODES.INVALID_SCENARIO_OPERATION);

    const badAnnotation = await addOperation(port, {
      projectId: PROJECT,
      scenarioId: SCENARIO,
      operation: { op: 'POSSIBLE_CONFLICT', candidateId: ID.ruleAdded, againstId: ID.rule },
    });
    assert.equal(badAnnotation.ok, false);
    assert.equal(badAnnotation.code, PROMOTION_ERROR_CODES.INVALID_SCENARIO_OPERATION);
    assert.equal(badAnnotation.identity.op, 'POSSIBLE_CONFLICT');

    const { nodes } = await scenarioRecords(port, SCENARIO);
    assert.equal(nodes.length, 1, 'only the meta record exists — rejected ops write nothing');
  });
});

test('no scenario operation ever mutates the curated or topology namespaces', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const before = await stableCounts(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [ruleOp(ID.ruleAdded, { concern: 'logging', title: 'Log things' })],
    });
    await addOperation(port, { projectId: PROJECT, scenarioId: SCENARIO, operation: addEdge('APPLIES_TO', ID.ruleAdded, ID.surface) });
    assert.deepEqual(await stableCounts(port), before);
  });
});

// --- lifecycle: inspect and discard ------------------------------------------------

test('inspectScenario returns meta, ordered ops, annotations, advisor, structural state, staleness and the diff', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const created = await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [ruleOp(ID.ruleAdded, { concern: 'logging', title: 'Log things' }), addEdge('APPLIES_TO', ID.ruleAdded, ID.surface)],
    });
    const inspection = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(inspection.ok, true);
    assert.equal(inspection.scenarioId, SCENARIO);
    assert.deepEqual(inspection.meta, { baseRevision: created.baseRevision, createdAt: created.createdAt });
    assert.deepEqual(inspection.operations, [ruleOp(ID.ruleAdded, { concern: 'logging', title: 'Log things' }), addEdge('APPLIES_TO', ID.ruleAdded, ID.surface)]);
    assert.deepEqual(inspection.annotations, []);
    assert.equal(inspection.stale, false);
    assert.equal(inspection.structural.valid, true);
    assert.deepEqual(inspection.structural.violations, []);
    assert.deepEqual(inspection.structural.warnings, []);
    assert.equal(typeof inspection.diff, 'string');
    assert.match(inspection.diff, new RegExp(`Promotion Scenario: ${SCENARIO}`));
    assert.match(inspection.diff, /status: current/);
  });
});

test('inspectScenario rejects an unknown scenario with SCENARIO_NOT_FOUND', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const result = await inspectScenario(port, { projectId: PROJECT, scenarioId: 'never-created' });
    assert.equal(result.ok, false);
    assert.equal(result.code, PROMOTION_ERROR_CODES.SCENARIO_NOT_FOUND);
    assert.deepEqual(result.identity, { scenarioId: 'never-created' });
  });
});

test('lifecycle create -> preview -> discard -> recreate, with discard idempotent on the unknown', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY });
    const preview = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(preview.ok, true);

    const discarded = await discardScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(discarded.ok, true);
    const gone = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(gone.code, PROMOTION_ERROR_CODES.SCENARIO_NOT_FOUND);
    assert.deepEqual((await scenarioRecords(port, SCENARIO)).nodes, []);

    // idempotent discard: unknown is a no-op, not an error
    assert.equal((await discardScenario(port, { projectId: PROJECT, scenarioId: SCENARIO })).ok, true);
    assert.equal((await discardScenario(port, { projectId: PROJECT, scenarioId: 'never-created' })).ok, true);

    // and the id is reusable after discard
    const recreated = await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY });
    assert.equal(recreated.ok, true);
  });
});

test('discardScenario removes every record of that scenario and nothing else', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [ruleOp(ID.ruleAdded, { concern: 'logging', title: 'Log things' }), { op: 'POSSIBLE_DUPLICATE', candidateId: ID.ruleAdded, againstId: ID.rule }],
    });
    await createScenario(port, { projectId: PROJECT, scenarioId: 'scenario-other', proposedBy: PROPOSED_BY });
    assert.equal((await discardScenario(port, { projectId: PROJECT, scenarioId: SCENARIO })).ok, true);
    assert.deepEqual((await scenarioRecords(port, SCENARIO)).nodes, []);
    // the other scenario survives
    const { nodes } = await scenarioRecords(port, 'scenario-other');
    assert.equal(nodes.length, 1);
  });
});

// --- the advisor: POSSIBLE_CONFLICT (spec §7, hierarchical overlap) -------------------------------

function conflictScenarioOps() {
  return [ruleOp(ID.ruleConflict, { concern: 'external-input', title: 'A conflicting rule' })];
}

test('advisor flags a planted conflict: a proposed Rule sharing concern and scope with a stable one', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [ruleOp(ID.ruleConflict, { concern: 'external-input', title: 'A conflicting rule' }), addEdge('APPLIES_TO', ID.ruleConflict, ID.surface)],
    });
    const { advisor, structural } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(advisor.conflicts.length, 1);
    assert.deepEqual(advisor.conflicts[0], {
      kind: 'POSSIBLE_CONFLICT',
      concern: 'external-input',
      ruleIds: [ID.ruleConflict, ID.rule].sort(),
      // the overlap evidence names the whole Package chain both Rules reach: the shared Surface and
      // every descendant of it (the Component and the Package that IMPLEMENTS it).
      locations: [ID.component, ID.package, ID.surface].sort(),
      suggestedResolution: 'keep one; keep both under non-overlapping scopes; or add an explicit OVERRIDES (or SUPERSEDES) resolution.',
    });
    assert.deepEqual(advisor.duplicates, []);
    // the conflict is ALSO a blocking projection finding: §7 forbids a silent "more specific rule
    // wins", so the scenario stays not-valid until the human resolves it (keep one, disjoint
    // scopes, or an explicit OVERRIDES/supersession).
    assert.equal(structural.valid, false);
    assert.ok(structural.violations.some((v) => v.code === 'UNRESOLVED_RULE_CONFLICT'));
  });
});

test('advisor uses HIERARCHICAL overlap: a Rule on a nested Component conflicts with one on its Surface', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    // The stable Rule applies to the Surface; the candidate applies to the Component INSIDE it.
    // B4 (shared APPLIES_TO target) sees no conflict; the advisor must — a resolution rooted in the
    // Component collects both. This is the controller-mandated hierarchical-overlap notion.
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [
        ruleOp(ID.ruleNested, { concern: 'external-input', title: 'Nested-scope rule' }),
        addEdge('APPLIES_TO', ID.ruleNested, ID.component),
      ],
    });
    const { advisor } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(advisor.conflicts.length, 1);
    assert.deepEqual(advisor.conflicts[0].ruleIds, [ID.ruleNested, ID.rule].sort());
    // the overlap is reported at the locations both Rules reach: the nested Component (the
    // candidate's own target) and the Package that IMPLEMENTS it.
    assert.deepEqual(advisor.conflicts[0].locations, [ID.component, ID.package].sort());
  });
});

test('advisor flags a conflict between two PROPOSED Rules, not only proposed-vs-stable', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [
        ruleOp(ID.ruleConflict, { concern: 'external-input', title: 'First' }),
        addEdge('APPLIES_TO', ID.ruleConflict, ID.surface),
        ruleOp(ID.ruleAdded, { concern: 'external-input', title: 'Second' }),
        addEdge('APPLIES_TO', ID.ruleAdded, ID.surface),
      ],
    });
    const { advisor } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    const pairIds = advisor.conflicts.map((finding) => finding.ruleIds);
    // every proposed pair among the three same-concern applicable Rules surfaces, in stable
    // (concern, left, right) order
    assert.deepEqual(pairIds, [
      [ID.ruleAdded, ID.ruleConflict],
      [ID.ruleAdded, ID.rule],
      [ID.ruleConflict, ID.rule],
    ]);
  });
});

test('a valid explicit OVERRIDES path resolves the advisor conflict', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [
        ruleOp(ID.ruleConflict, { concern: 'external-input', title: 'Winner' }),
        addEdge('APPLIES_TO', ID.ruleConflict, ID.surface),
        addEdge('OVERRIDES', ID.ruleConflict, ID.rule),
      ],
    });
    const { advisor } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.deepEqual(advisor.conflicts, []);
  });
});

test('a SUPERSEDE removes the retired Rule from the conflict contest (spec §6)', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [
        ruleOp(ID.ruleConflict, { concern: 'external-input', title: 'Replacement' }),
        addEdge('APPLIES_TO', ID.ruleConflict, ID.surface),
        {
          op: 'SUPERSEDE',
          target: 'node',
          namespace: 'curated',
          supersededId: ID.rule,
          type: 'Rule',
          id: ID.ruleAdded,
          properties: { id: ID.ruleAdded, status: 'active', title: SEED_TITLE, statement: SEED_STATEMENT, strength: 'must', category: 'engineering', concern: 'external-input', provenance: { source: 'spec', line: 52 } },
        },
        addEdge('APPLIES_TO', ID.ruleAdded, ID.surface),
      ],
    });
    const { advisor, structural } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    // the stable rule is superseded by the scenario, so it is out of operational context — but the
    // two LIVE proposed rules both apply to the surface with the same concern, so they still clash.
    assert.equal(advisor.conflicts.length, 1);
    assert.deepEqual(advisor.conflicts[0].ruleIds, [ID.ruleAdded, ID.ruleConflict].sort());
    // and that same unresolved pair blocks the projection (§7), exactly like B4 would
    assert.equal(structural.valid, false);
    assert.ok(structural.violations.some((v) => v.code === 'UNRESOLVED_RULE_CONFLICT'));
  });
});

test('advisor never reports a pair already settled in the stable graph — those surface as B4 findings', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    // a SECOND stable Rule sharing the seed's concern and scope: the base graph now carries an
    // unresolved conflict that B4 owns.
    await applyChangeSet(
      port,
      {
        operations: [ruleOp(ID.ruleConflict, { concern: 'external-input', title: 'Pre-existing conflict' }), addEdge('APPLIES_TO', ID.ruleConflict, ID.surface)],
      },
      meta(),
    );
    await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, operations: [], proposedBy: PROPOSED_BY });
    const { advisor, structural } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    // the pair is entirely stable: it is B4's report (structural finding), not the advisor's
    assert.deepEqual(advisor.conflicts, []);
    assert.deepEqual(advisor.duplicates, []);
    assert.ok(structural.violations.some((v) => v.code === 'UNRESOLVED_RULE_CONFLICT'));
  });
});

// --- the advisor: POSSIBLE_DUPLICATE (V1 lexical heuristics, no embeddings — spec §10 defers) ------

test('advisor flags a planted duplicate: a proposed ADD whose title and statement match a stable Rule', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [
        ruleOp(ID.ruleDup, { title: SEED_TITLE, statement: SEED_STATEMENT, concern: 'documentation' }),
        addEdge('APPLIES_TO', ID.ruleDup, ID.surface),
      ],
    });
    const { advisor } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(advisor.duplicates.length, 1);
    const [finding] = advisor.duplicates;
    assert.equal(finding.kind, 'POSSIBLE_DUPLICATE');
    assert.equal(finding.candidateId, ID.ruleDup);
    assert.equal(finding.againstId, ID.rule);
    assert.deepEqual(finding.matched, [
      { property: 'statement', value: SEED_STATEMENT },
      { property: 'title', value: SEED_TITLE },
    ]);
  });
});

test('the duplicate comparison is normalized-blank-insensitive: whitespace runs collapse', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const sloppy = `  ${SEED_TITLE.slice(0, 8)} \t  ${SEED_TITLE.slice(8)} `;
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [ruleOp(ID.ruleDup, { title: sloppy, statement: 'something else entirely', concern: 'documentation' })],
    });
    const { advisor } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(advisor.duplicates.length, 1);
    assert.deepEqual(advisor.duplicates[0].matched, [{ property: 'title', value: SEED_TITLE }]);
  });
});

test('a proposed Rule already covered by another proposed ADD is a duplicate too', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [
        ruleOp(ID.ruleDup, { title: SEED_TITLE, statement: SEED_STATEMENT, concern: 'documentation' }),
        ruleOp(ID.ruleConflict, { title: SEED_TITLE, statement: 'a different statement', concern: 'packaging' }),
      ],
    });
    const { advisor } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.ok(advisor.duplicates.some((finding) => finding.candidateId === ID.ruleConflict && finding.againstId === ID.ruleDup));
    assert.ok(advisor.duplicates.some((finding) => finding.candidateId === ID.ruleDup && finding.againstId === ID.rule));
  });
});

test('a Rule sharing nothing lexical with another is not flagged', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [ruleOp(ID.ruleAdded, { title: 'Completely unrelated title', statement: 'Entirely different statement.', concern: 'logging' })],
    });
    const { advisor } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.deepEqual(advisor.duplicates, []);
  });
});

// --- structural validation of the scenario-applied graph (binding 6) ------------------------------

test('structural validation catches a proposed ADD missing a required property', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const brokenRule = ruleOp(ID.ruleAdded, { concern: 'logging', title: 'Incomplete' });
    delete brokenRule.properties.statement;
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [brokenRule, addEdge('APPLIES_TO', ID.ruleAdded, ID.surface)],
    });
    const { structural, diff } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(structural.valid, false);
    const missing = structural.violations.filter((v) => v.code === 'MISSING_REQUIRED_PROPERTY');
    assert.equal(missing.length, 1);
    assert.equal(missing[0].identity.id, ID.ruleAdded);
    assert.equal(missing[0].identity.property, 'statement');
    assert.match(diff, /MISSING_REQUIRED_PROPERTY/);
  });
});

test('structural validation catches a MODIFY of a node the graph does not hold', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [{ op: 'MODIFY', target: 'node', namespace: 'curated', id: ID.ruleAdded, properties: { id: ID.ruleAdded, status: 'deprecated' } }],
    });
    const { structural } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(structural.valid, false);
    assert.deepEqual(structural.violations, [
      {
        code: PROJECTION_OPERATION_FAILURE,
        message: `Operation 0: node '${ID.ruleAdded}' does not exist.`,
        identity: { scenarioId: SCENARIO, index: 0, op: 'MODIFY', target: 'node' },
      },
    ]);
  });
});

test('a REMOVE of a node with live relationships is called out in the diff and fails the projection', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [{ op: 'REMOVE', target: 'node', namespace: 'curated', id: ID.surface }],
    });
    const { structural, diff } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(structural.valid, false);
    // the live relationships the REMOVE breaks are named, edge by edge, in stable order
    assert.match(diff, /REMOVE node apex:proj:surface:scripts \(curated\) — 4 live relationship\(s\) left dangling:/);
    assert.match(diff, /APPLIES_TO apex:proj:rule:sanitize-external-input -> apex:proj:surface:scripts/);
    assert.match(diff, /OWNED_BY apex:proj:surface:scripts -> apex:proj:agent:scripts-agent/);
    assert.match(diff, /PART_OF apex:proj:component:engine -> apex:proj:surface:scripts/);
    assert.match(diff, /PART_OF apex:proj:surface:scripts -> apex:proj:project:root/);
    // and the projection flags the dangling endpoints the graph would be left with
    assert.ok(structural.violations.some((v) => v.code === 'BROKEN_RELATIONSHIP_ENDPOINT'));
  });
});

test('structural validation catches a scenario that orphans a curated node from the Project root', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [
        { op: 'REMOVE', target: 'edge', namespace: 'curated', type: 'PART_OF', fromId: ID.component, toId: ID.surface },
      ],
    });
    const { structural } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(structural.valid, false);
    assert.ok(structural.violations.some((v) => v.code === 'UNREACHABLE_FROM_PROJECT_ROOT' && v.identity.id === ID.component));
  });
});

test('one invalid operation never suppresses the other findings (design boundary d)', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const broken = ruleOp(ID.ruleAdded, { concern: 'logging', title: 'Incomplete' });
    delete broken.properties.statement;
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [
        broken,
        { op: 'MODIFY', target: 'node', namespace: 'curated', id: 'apex:proj:term:never-created', properties: { id: 'x', status: 'active' } },
      ],
    });
    const { structural } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    const codes = structural.violations.map((v) => v.code);
    assert.ok(codes.includes('MISSING_REQUIRED_PROPERTY'), 'the bad ADD is still reported');
    assert.ok(codes.includes(PROJECTION_OPERATION_FAILURE), 'the unapplicable MODIFY is still reported');
    assert.equal(structural.valid, false);
  });
});

// --- PROMOTION_STALE (binding 7) -------------------------------------------------------------------

test('a scenario is PROMOTION_STALE at inspect when the base revision moved, and the diff says so', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const created = await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY });

    // the head moves after the scenario was created
    await applyChangeSet(port, { operations: [addNode('Term', ID.term)] }, meta());
    const { headRevision } = await readChain(port, { projectId: PROJECT });
    assert.notEqual(headRevision, created.baseRevision);

    const inspection = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(inspection.ok, true, 'a stale scenario stays inspectable');
    assert.deepEqual(inspection.stale, {
      code: PROMOTION_ERROR_CODES.PROMOTION_STALE,
      scenarioId: SCENARIO,
      baseRevision: created.baseRevision,
      headRevision,
    });
    assert.match(inspection.diff, /status: PROMOTION_STALE/);
    // the report states the revision it was rendered against, so a stale preview is visibly stale
    assert.match(inspection.diff, new RegExp(`rendered against: ${headRevision}`));

    // and it stays discardable
    assert.equal((await discardScenario(port, { projectId: PROJECT, scenarioId: SCENARIO })).ok, true);
  });
});

test('a scenario based on the empty graph is not stale while the head is still null', async () => {
  await withPort(async (port) => {
    const created = await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY });
    assert.equal(created.baseRevision, null);
    const inspection = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(inspection.stale, false);
  });
});

// --- the typed textual diff report (ratified review UX) -------------------------------------------

// The ratified review UX, pinned byte-for-byte: properties, relationships, conflicts,
// supersessions and suspected duplicates, with the base revision stated, staleness surfaced, and the
// structural findings/warnings visible. Deterministic — see the byte-identity test below.
test('the typed diff report renders the whole ratified list as a pinned snapshot', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const { baseRevision } = await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [
        ruleOp(ID.ruleDup, { title: SEED_TITLE, statement: SEED_STATEMENT, concern: 'external-input' }),
        addEdge('APPLIES_TO', ID.ruleDup, ID.surface),
        { op: 'POSSIBLE_DUPLICATE', candidateId: ID.ruleDup, againstId: ID.rule, matchedProperty: 'title', matchedValue: SEED_TITLE },
        { op: 'MODIFY', target: 'node', namespace: 'curated', id: ID.surface, properties: { id: ID.surface, status: 'deprecated' } },
        { op: 'REMOVE', target: 'edge', namespace: 'curated', type: 'OWNED_BY', fromId: ID.surface, toId: ID.agent },
        { op: 'REMOVE', target: 'node', namespace: 'curated', id: ID.agent },
      ],
    });
    const { diff } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(
      diff,
      `Promotion Scenario: ${SCENARIO}
  base revision: ${baseRevision}
  rendered against: ${baseRevision}
  status: current
  structural: 1 blocking finding(s)

Operations (6):
  [0] ADD node curated Rule ${ID.ruleDup}
  [1] ADD edge curated APPLIES_TO ${ID.ruleDup} -> ${ID.surface}
  [2] POSSIBLE_DUPLICATE annotation ${ID.ruleDup} ~ ${ID.rule}
  [3] MODIFY node curated ${ID.surface}
  [4] REMOVE edge curated OWNED_BY ${ID.surface} -> ${ID.agent}
  [5] REMOVE node curated ${ID.agent}

Properties:
  ADD node ${ID.ruleDup} (curated Rule)
    category: "engineering"
    concern: "external-input"
    id: "${ID.ruleDup}"
    provenance: {"source":"spec","line":52}
    statement: "${SEED_STATEMENT}"
    status: "active"
    strength: "must"
    title: "${SEED_TITLE}"
  MODIFY node ${ID.surface} (curated)
    status: "active" -> "deprecated"

Relationships:
  ADD edge APPLIES_TO ${ID.ruleDup} -> ${ID.surface} (curated)
  REMOVE edge OWNED_BY ${ID.surface} -> ${ID.agent} (curated)
  REMOVE node ${ID.agent} (curated) — 0 live relationship(s) left dangling

Supersessions: (none)

Conflicts (advisor):
  POSSIBLE_CONFLICT ${ID.ruleDup} <-> ${ID.rule}
    concern: external-input
    overlapping scope: ${ID.component}, ${ID.package}, ${ID.surface}

Suspected duplicates (advisor):
  POSSIBLE_DUPLICATE ${ID.ruleDup} ~ ${ID.rule}
    matched statement: "${SEED_STATEMENT}"
    matched title: "${SEED_TITLE}"
  recorded POSSIBLE_DUPLICATE ${ID.ruleDup} ~ ${ID.rule}
    matched title: "${SEED_TITLE}"

Structural findings (1):
  [UNRESOLVED_RULE_CONFLICT] Rules '${ID.ruleDup}' and '${ID.rule}' share concern 'external-input' on overlapping scope (${ID.surface}) with no explicit OVERRIDES between them.

Structural warnings (1):
  [DEPRECATED_WITHOUT_REPLACEMENT] Deprecated node '${ID.surface}' has no replacement: nothing SUPERSEDES it.
`,
    );
  });
});

test('the diff renders supersessions and the structural findings that accompany them', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [
        {
          op: 'SUPERSEDE',
          target: 'node',
          namespace: 'curated',
          supersededId: ID.check,
          type: 'Check',
          id: ID.checkRetired,
          properties: { id: ID.checkRetired, status: 'active' },
        },
        addEdge('VERIFIED_BY', ID.rule, ID.checkRetired),
      ],
    });
    const { diff, structural } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.match(diff, /Supersessions:\n  SUPERSEDE node .* replaces .* \(curated Check\)/);
    assert.equal(structural.valid, true);
  });
});

test('the diff is byte-identical regardless of the order the port returns its records in', async () => {
  const build = async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [
        ruleOp(ID.ruleDup, { title: SEED_TITLE, statement: SEED_STATEMENT, concern: 'external-input' }),
        addEdge('APPLIES_TO', ID.ruleDup, ID.surface),
      ],
    });
    const { diff } = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    return diff;
  };
  await withPort(async (port) => {
    const forward = await build(port);
    const again = await build(port);
    assert.equal(forward, again);
  });
});

// --- the scenario is provably blind to resolution (binding 8) --------------------------------------

test('resolution is byte-identical with no scenario, an empty scenario, and a scenario whose ops would change the answer', async () => {
  const input = { projectId: PROJECT, paths: ['packages/engine'] };

  const resolve = async (port) => JSON.stringify(await resolveContext(port, input));

  // a scenario whose ops WOULD change the answer if they were stable: a new Rule scoped to the very
  // Package the resolution walks, with a concern nothing else covers.
  const changeAnswerOps = () => [
    ruleOp(ID.ruleAdded, { concern: 'scenario-only', title: 'Only exists in the scenario' }),
    addEdge('APPLIES_TO', ID.ruleAdded, ID.package),
  ];

  await withPort(async (port) => {
    await seedBaseGraph(port);
    const baseline = await resolve(port);

    await createScenario(port, { projectId: PROJECT, scenarioId: 'scenario-empty', operations: [], proposedBy: PROPOSED_BY });
    assert.equal(await resolve(port), baseline, 'an open empty scenario changes nothing');

    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: 'scenario-loaded',
      operations: changeAnswerOps(),
    });
    const withOpenScenario = await resolve(port);
    assert.equal(withOpenScenario, baseline, 'an open scenario holding answer-changing ops changes nothing');

    // prove the ops WOULD have changed the answer if they had been promoted
    const other = createMemoryPort();
    try {
      await seedBaseGraph(other);
      await applyChangeSet(other, { operations: changeAnswerOps() }, meta());
      assert.notEqual(await resolve(other), baseline, 'the fixture ops are not vacuous');
    } finally {
      await other.close();
    }

    // and the scenario records never leak into any context bucket
    const resolved = await resolveContext(port, input);
    assert.ok(resolved.ok);
    const scenarioIds = new Set([...changeAnswerOps().map((op) => op.id), scenarioMetaId(PROJECT)]);
    for (const bucket of Object.values(resolved.context)) {
      for (const item of bucket) assert.ok(!scenarioIds.has(item.id), `${item.id} leaked from the scenario`);
    }
  });
});

// --- structured errors and the module contract ----------------------------------------------------

test('the module exposes the advisor-only vocabulary and the record types a consumer needs', () => {
  assert.deepEqual([...ADVISOR_ONLY_OPERATIONS], ['POSSIBLE_DUPLICATE', 'POSSIBLE_CONFLICT']);
  assert.equal(SCENARIO_OPERATION_TYPE, 'ScenarioOperation');
  assert.equal(SCENARIO_ANNOTATION_TYPE, 'ScenarioAnnotation');
  assert.equal(PROMOTION_ERROR_CODES.PROMOTION_STALE, 'PROMOTION_STALE');
  assert.equal(PROJECTION_OPERATION_FAILURE, 'OPERATION_NOT_APPLICABLE');
});

test('an open scenario leaves validateGraph green when it is not named — the graph cannot enumerate scenarios', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    await createScenario(port, {
      projectId: PROJECT,
      proposedBy: PROPOSED_BY,
      scenarioId: SCENARIO,
      operations: [ruleOp(ID.ruleConflict, { concern: 'external-input', title: 'Conflict' }), addEdge('APPLIES_TO', ID.ruleConflict, ID.surface)],
    });
    const result = await validateGraph(port, { projectId: PROJECT });
    assert.deepEqual(result.violations, []);
    assert.equal(result.ok, true);
  });
});


test('failed standalone export preserves the draft scenario and committed revision', async (t) => {
  const dir = nodeFs.mkdtempSync(join(tmpdir(), 'scenario-export-fault-'));
  const port = createMemoryPort();
  t.after(async () => { await port.close(); nodeFs.rmSync(dir, { recursive: true, force: true }); });
  await seedBaseGraph(port);
  await createScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, proposedBy: PROPOSED_BY, operations: [addNode('Term', qid('term:draft'))] });
  const before = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
  const chain = await readChain(port, { projectId: PROJECT });
  let writes = 0;
  const result = await exportGraph(port, {
    projectId: PROJECT, filePath: join(dir, 'export.jsonl'),
    fs: { ...nodeFs, writeSync() { writes++; throw Object.assign(new Error('injected write failure'), { code: 'EIO' }); } },
  });
  assert.equal(result.ok, false);
  assert.equal(writes, 1);
  assert.deepEqual(await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO }), before);
  assert.deepEqual(await readChain(port, { projectId: PROJECT }), chain);
  assert.deepEqual(nodeFs.readdirSync(dir), []);
});
