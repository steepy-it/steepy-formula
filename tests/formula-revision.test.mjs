// ChangeSet / Revision chain suite (Task B5). Every case that touches storage drives the module
// through a REAL port adapter (the B3 in-memory reference) rather than a hand-built graph object:
// the audit backbone's contract is "the mutation and its record are written in ONE transaction on
// any adapter" (spec §21), and a test that fed it plain arrays would not exercise that at all.
//
// Fixture shape: `baseChangeSet()` / `baseMeta()` return the smallest well-formed inputs; each test
// clones them and plants exactly one fault, so a failure names the rule that broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { withTransaction } from '../scripts/formula/engine/port.mjs';
import { FIXTURE_TARGET_EDGES, generateFixture } from '../scripts/formula/core/fixture-gen.mjs';
import { GRAPH_SCHEMA_VERSION, RELATIONSHIP_TYPE_NAMES } from '../scripts/formula/core/ontology.mjs';
import { SYSTEM_RECORD_TYPE, systemRecordId, validateGraph } from '../scripts/formula/core/validate-graph.mjs';
import {
  ACTOR_TYPES,
  CHANGE_NAMESPACES,
  CHANGE_OPERATIONS,
  CHANGE_TARGETS,
  CHANGE_OPERATION_ARGUMENTS,
  CHANGE_SET_TYPE,
  isActorType,
  RECORDS_RELATIONSHIP,
  REVISION_PROPERTIES,
  REVISION_TYPE,
  REVISION_VIOLATION_CODES,
  SUPERSEDES_RELATIONSHIP,
  applyChangeOperations,
  applyChangeSet,
  canonicalize,
  historicalNodeIds,
  readChain,
  replayChain,
  verifyChain,
  verifyChainRecords,
  changeSetId,
  revisionHash,
  revisionId,
  sha256Hex,
  validateChangeSet,
  validateRevisionMeta,
} from '../scripts/formula/core/revision.mjs';

const PROJECT = 'proj';

const ID = {
  project: 'apex:proj:project:root',
  surface: 'apex:proj:surface:scripts',
  rule: 'apex:proj:rule:sanitize-external-input',
  ruleV2: 'apex:proj:rule:sanitize-external-input-v2',
  check: 'apex:proj:check:surface-test',
  term: 'apex:proj:term:surface',
  agent: 'apex:proj:agent:scripts-agent',
  decision: 'apex:proj:decision:graph-db-is-canonical',
  skill: 'apex:proj:skill:graph-migrate',
};

function addNode(type, id, properties = {}) {
  return { op: 'ADD', target: 'node', namespace: 'curated', type, id, properties: { id, status: 'active', ...properties } };
}

function addEdge(type, fromId, toId) {
  return { op: 'ADD', target: 'edge', namespace: 'curated', type, fromId, toId };
}

// The smallest well-formed ChangeSet: one curated node, nothing else.
function baseChangeSet() {
  return { operations: [addNode('Term', ID.term)] };
}

function baseMeta(overrides = {}) {
  return {
    projectId: PROJECT,
    proposer: { type: 'agent-proposer', id: 'scripts-agent' },
    approver: { type: 'human-approver', id: 'steepy-it' },
    provenance: [
      { quotation: 'Sanitize every external value before writing it to disk.', source: 'docs/spec.md:52', digest: sha256Hex('source file') },
    ],
    timestamp: '2026-08-12T10:00:00.000Z',
    ...overrides,
  };
}

function codesOf(items) {
  return items.map((item) => item.code);
}

// --- port helpers (reads go through the port, exactly as the module's writes do) -----------------

function readState(port, namespace) {
  return withTransaction(port, async (tx) => ({
    nodes: (await tx.listNodes({ namespace })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: (await tx.listEdges({ namespace })).sort((a, b) =>
      canonicalize([a.type, a.fromId, a.toId]) < canonicalize([b.type, b.fromId, b.toId]) ? -1 : 1,
    ),
  }));
}

function readNode(port, namespace, id) {
  return withTransaction(port, (tx) => tx.getNode({ namespace, id }));
}

async function readMetadata(port) {
  const record = await readNode(port, 'system', systemRecordId(PROJECT));
  return record?.properties ?? null;
}

async function readRevisions(port) {
  const record = await withTransaction(port, (tx) => tx.listNodes({ namespace: 'system', type: REVISION_TYPE }));
  return record.map((node) => node.properties).sort((a, b) => a.sequence - b.sequence);
}

// Applies a ChangeSet and asserts it succeeded — for the many tests whose subject is a LATER step.
async function applyOk(port, changeSet, metaOverrides = {}) {
  const result = await applyChangeSet(port, changeSet, baseMeta(metaOverrides));
  assert.deepEqual(result.violations, [], 'expected a clean apply');
  assert.equal(result.ok, true);
  return result.revision;
}

async function withPort(fn) {
  const port = createMemoryPort();
  try {
    return await fn(port);
  } finally {
    await port.close();
  }
}

// --- primitives: identity ----------------------------------------------------------------------

test('revision and change-set ids are deterministic, project-qualified and sequence-derived', () => {
  assert.equal(revisionId(PROJECT, 1), 'apex:proj:revision:r1');
  assert.equal(revisionId(PROJECT, 42), 'apex:proj:revision:r42');
  assert.equal(changeSetId(PROJECT, 1), 'apex:proj:changeset:c1');
  assert.equal(changeSetId(PROJECT, 42), 'apex:proj:changeset:c42');
});

// --- primitives: canonical serialization -------------------------------------------------------

test('canonicalize is key-order independent at every depth', () => {
  const left = { b: 1, a: { d: [1, 2], c: 'x' } };
  const right = { a: { c: 'x', d: [1, 2] }, b: 1 };
  assert.equal(canonicalize(left), canonicalize(right));
  assert.equal(canonicalize(left), '{"a":{"c":"x","d":[1,2]},"b":1}');
});

test('canonicalize preserves array order — an operation list is a sequence, not a set', () => {
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
});

test('sha256Hex is plain node:crypto sha256 over the utf-8 string', () => {
  const expected = createHash('sha256').update('hello', 'utf8').digest('hex');
  assert.equal(sha256Hex('hello'), expected);
  assert.match(sha256Hex('hello'), /^[0-9a-f]{64}$/);
});

// --- primitives: the hash covers the whole revision payload ------------------------------------

function samplePayload() {
  return {
    id: revisionId(PROJECT, 2),
    sequence: 2,
    previousRevision: revisionId(PROJECT, 1),
    previousHash: sha256Hex('previous'),
    timestamp: '2026-08-12T10:00:00.000Z',
    proposer: { type: 'agent-proposer', id: 'scripts-agent' },
    approver: { type: 'human-approver', id: 'steepy-it' },
    provenance: [{ quotation: 'sanitize every external value', source: 'docs/spec.md:52', digest: sha256Hex('file') }],
    changeSetId: changeSetId(PROJECT, 2),
    changeSet: {
      id: changeSetId(PROJECT, 2),
      operations: [{ op: 'ADD', target: 'node', namespace: 'curated', type: 'Term', id: 'apex:proj:term:surface', properties: {} }],
    },
  };
}

test('revisionHash is stable and independent of key insertion order', () => {
  const payload = samplePayload();
  const shuffled = Object.fromEntries(Object.entries(payload).reverse());
  assert.equal(revisionHash(payload), revisionHash(shuffled));
});

test('every recorded field is load-bearing: mutating any one of them changes the hash', () => {
  const baseline = revisionHash(samplePayload());
  const mutations = {
    id: revisionId(PROJECT, 3),
    sequence: 3,
    previousRevision: revisionId(PROJECT, 99),
    previousHash: sha256Hex('tampered'),
    timestamp: '2026-08-12T11:00:00.000Z',
    proposer: { type: 'agent-proposer', id: 'other-agent' },
    approver: { type: 'human-approver', id: 'someone-else' },
    provenance: [{ quotation: 'other evidence', source: 'docs/spec.md:53', digest: sha256Hex('other') }],
    changeSetId: changeSetId(PROJECT, 99),
    changeSet: { id: changeSetId(PROJECT, 2), operations: [] },
  };
  for (const [field, value] of Object.entries(mutations)) {
    assert.notEqual(revisionHash({ ...samplePayload(), [field]: value }), baseline, `${field} is not hashed`);
  }
  // the hash input IS the recorded property set: everything but `hash`, with the ChangeSet content
  // standing in for the `changeSetId` that names it.
  assert.deepEqual(
    [...REVISION_PROPERTIES].sort(),
    [...Object.keys(mutations).filter((field) => field !== 'changeSet'), 'hash'].sort(),
  );
});

// --- vocabulary ---------------------------------------------------------------------------------

test('the four spec §26 actor types are pinned, and nothing else is an actor', () => {
  assert.deepEqual([...ACTOR_TYPES], ['human-approver', 'agent-proposer', 'migration', 'automated-topology-writer']);
  assert.ok(ACTOR_TYPES.every((type) => isActorType(type)));
  for (const value of ['human', 'robot', '', undefined, null]) assert.equal(isActorType(value), false);
});

test('the four spec §11 change operations are pinned, over node and edge targets', () => {
  assert.deepEqual([...CHANGE_OPERATIONS], ['ADD', 'MODIFY', 'SUPERSEDE', 'REMOVE']);
  assert.deepEqual([...CHANGE_TARGETS], ['node', 'edge']);
});

test('a ChangeSet may only touch the stable graph: curated and topology, never system or scenario', () => {
  assert.deepEqual([...CHANGE_NAMESPACES], ['curated', 'topology']);
});

test('every operation shape declares a closed argument list', () => {
  assert.deepEqual(Object.keys(CHANGE_OPERATION_ARGUMENTS).sort(), [
    'ADD:edge',
    'ADD:node',
    'MODIFY:node',
    'REMOVE:edge',
    'REMOVE:node',
    'SUPERSEDE:node',
  ]);
  for (const accepted of Object.values(CHANGE_OPERATION_ARGUMENTS)) {
    assert.ok(accepted.includes('op') && accepted.includes('target') && accepted.includes('namespace'));
  }
});

test('the memory port used by this suite is reachable (fixture sanity)', async () => {
  const port = createMemoryPort();
  try {
    assert.equal(typeof port.begin, 'function');
  } finally {
    await port.close();
  }
});

// --- ChangeSet validation (pure, pre-apply) -------------------------------------------------------

test('a well-formed ChangeSet validates clean', () => {
  assert.deepEqual(validateChangeSet(baseChangeSet()), []);
});

test('a ChangeSet is a plain object with a non-empty operations array', () => {
  for (const bad of [undefined, null, 'nope', [], { operations: [] }, { operations: 'nope' }]) {
    const found = validateChangeSet(bad);
    assert.equal(found.length, 1, `${JSON.stringify(bad)} should be rejected once`);
    assert.equal(found[0].code, REVISION_VIOLATION_CODES.INVALID_CHANGE_SET);
  }
});

test('an unknown key on the ChangeSet container is rejected, never ignored', () => {
  const found = validateChangeSet({ ...baseChangeSet(), opperations: [] });
  assert.deepEqual(codesOf(found), [REVISION_VIOLATION_CODES.INVALID_CHANGE_SET]);
  assert.deepEqual(found[0].identity, { key: 'opperations' });
});

test('an unknown operation or target is rejected with the offending value and index', () => {
  const unknownOp = validateChangeSet({ operations: [{ ...addNode('Term', ID.term), op: 'UPSERT' }] });
  assert.deepEqual(codesOf(unknownOp), [REVISION_VIOLATION_CODES.UNKNOWN_CHANGE_OPERATION]);
  assert.equal(unknownOp[0].identity.index, 0);
  assert.equal(unknownOp[0].identity.op, 'UPSERT');

  const unknownTarget = validateChangeSet({ operations: [{ ...addNode('Term', ID.term), target: 'property' }] });
  assert.deepEqual(codesOf(unknownTarget), [REVISION_VIOLATION_CODES.UNKNOWN_CHANGE_TARGET]);
  assert.equal(unknownTarget[0].identity.target, 'property');
});

test('MODIFY and SUPERSEDE have no edge form — edges carry no properties in schema v1', () => {
  const found = validateChangeSet({ operations: [{ op: 'MODIFY', target: 'edge', namespace: 'curated', id: ID.term, properties: {} }] });
  assert.deepEqual(codesOf(found), [REVISION_VIOLATION_CODES.UNSUPPORTED_OPERATION_TARGET]);
  assert.deepEqual(found[0].identity, { index: 0, op: 'MODIFY', target: 'edge' });
});

test('an unknown operation argument is rejected rather than silently dropped', () => {
  const found = validateChangeSet({ operations: [{ ...addNode('Term', ID.term), scenarioId: 's1' }] });
  assert.deepEqual(codesOf(found), [REVISION_VIOLATION_CODES.UNKNOWN_OPERATION_ARGUMENT]);
  assert.equal(found[0].identity.argument, 'scenarioId');
});

test('a missing required operation argument is reported per argument', () => {
  const op = addNode('Term', ID.term);
  delete op.type;
  delete op.id;
  const found = validateChangeSet({ operations: [op] });
  assert.deepEqual(codesOf(found), [
    REVISION_VIOLATION_CODES.MISSING_OPERATION_ARGUMENT,
    REVISION_VIOLATION_CODES.MISSING_OPERATION_ARGUMENT,
  ]);
  assert.deepEqual(
    found.map((item) => item.identity.argument).sort(),
    ['id', 'type'],
  );
});

test('properties are optional on ADD:node (the port defaults to an empty bag) and required on MODIFY', () => {
  const added = { op: 'ADD', target: 'node', namespace: 'curated', type: 'Term', id: ID.term };
  assert.deepEqual(validateChangeSet({ operations: [added] }), []);

  const modified = { op: 'MODIFY', target: 'node', namespace: 'curated', id: ID.term };
  const found = validateChangeSet({ operations: [modified] });
  assert.deepEqual(codesOf(found), [REVISION_VIOLATION_CODES.MISSING_OPERATION_ARGUMENT]);
  assert.equal(found[0].identity.argument, 'properties');
});

test('a ChangeSet may not touch the system or scenario namespace', () => {
  for (const namespace of ['system', 'scenario', 'nonsense']) {
    const found = validateChangeSet({ operations: [{ ...addNode('Term', ID.term), namespace }] });
    assert.deepEqual(codesOf(found), [REVISION_VIOLATION_CODES.INVALID_CHANGE_NAMESPACE]);
    assert.equal(found[0].identity.namespace, namespace);
  }
});

test('operation ids, types and property values are judged by the port’s own validators (B3), not re-encoded', () => {
  const badId = validateChangeSet({ operations: [{ ...addNode('Term', ID.term), id: '' }] });
  assert.deepEqual(codesOf(badId), ['INVALID_NODE_ID']);
  assert.equal(badId[0].identity.index, 0);

  const badType = validateChangeSet({ operations: [{ ...addNode('Term', ID.term), type: 42 }] });
  assert.deepEqual(codesOf(badType), ['INVALID_TYPE']);

  const badValue = validateChangeSet({ operations: [addNode('Term', ID.term, { when: new Date('2026-08-12') })] });
  assert.deepEqual(codesOf(badValue), ['UNSUPPORTED_PROPERTY_VALUE']);
});

test('every operation is judged: a ChangeSet reports faults from all of its operations at once', () => {
  const found = validateChangeSet({
    operations: [addNode('Term', ID.term), { ...addNode('Term', ID.check), namespace: 'system' }, { op: 'NOPE', target: 'node' }],
  });
  assert.deepEqual(codesOf(found), [
    REVISION_VIOLATION_CODES.INVALID_CHANGE_NAMESPACE,
    REVISION_VIOLATION_CODES.UNKNOWN_CHANGE_OPERATION,
  ]);
  assert.deepEqual(
    found.map((item) => item.identity.index),
    [1, 2],
  );
});

// --- Revision meta validation (actor identity §26, provenance snapshot §21) -----------------------

test('well-formed meta validates clean', () => {
  assert.deepEqual(validateRevisionMeta(baseMeta()), []);
});

test('meta requires a valid projectId — revision ids are project-qualified (§24)', () => {
  assert.deepEqual(codesOf(validateRevisionMeta(baseMeta({ projectId: 'Not A Project' }))), ['INVALID_PROJECT_ID']);
  assert.deepEqual(codesOf(validateRevisionMeta(baseMeta({ projectId: undefined }))), ['INVALID_PROJECT_ID']);
});

test('proposer and approver are distinct required fields, each a typed actor identity (§26)', () => {
  for (const role of ['proposer', 'approver']) {
    const missing = validateRevisionMeta(baseMeta({ [role]: undefined }));
    assert.deepEqual(codesOf(missing), [REVISION_VIOLATION_CODES.INVALID_ACTOR_IDENTITY]);
    assert.equal(missing[0].identity.role, role);

    const unknownType = validateRevisionMeta(baseMeta({ [role]: { type: 'robot', id: 'x' } }));
    assert.deepEqual(codesOf(unknownType), [REVISION_VIOLATION_CODES.INVALID_ACTOR_IDENTITY]);
    assert.equal(unknownType[0].identity.type, 'robot');

    const noId = validateRevisionMeta(baseMeta({ [role]: { type: 'migration' } }));
    assert.deepEqual(codesOf(noId), [REVISION_VIOLATION_CODES.INVALID_ACTOR_IDENTITY]);
  }
});

test('every one of the four actor types is accepted in either role — a migration approves itself', () => {
  for (const type of ACTOR_TYPES) {
    assert.deepEqual(validateRevisionMeta(baseMeta({ proposer: { type, id: 'a' }, approver: { type, id: 'b' } })), []);
  }
});

test('the provenance snapshot is a non-empty list of quotation + file:line source + source digest (§21)', () => {
  assert.deepEqual(codesOf(validateRevisionMeta(baseMeta({ provenance: undefined }))), [
    REVISION_VIOLATION_CODES.INVALID_PROVENANCE,
  ]);
  assert.deepEqual(codesOf(validateRevisionMeta(baseMeta({ provenance: [] }))), [REVISION_VIOLATION_CODES.INVALID_PROVENANCE]);

  const entry = baseMeta().provenance[0];
  const broken = [
    { ...entry, quotation: '' },
    { ...entry, source: 'docs/spec.md' },
    { ...entry, source: 'docs/spec.md:not-a-line' },
    { ...entry, digest: 'not-a-sha256' },
    { ...entry, extra: 'field' },
  ];
  for (const provenance of broken) {
    const found = validateRevisionMeta(baseMeta({ provenance: [provenance] }));
    assert.deepEqual(codesOf(found), [REVISION_VIOLATION_CODES.INVALID_PROVENANCE], JSON.stringify(provenance));
    assert.equal(found[0].identity.index, 0);
  }
});

test('the timestamp is an ISO-8601 UTC string, never a Date (the port’s JSON domain, B3)', () => {
  for (const timestamp of [new Date('2026-08-12'), '2026-08-12', '2026-08-12T10:00:00+02:00', 'yesterday', 1755000000000]) {
    assert.deepEqual(codesOf(validateRevisionMeta(baseMeta({ timestamp }))), [REVISION_VIOLATION_CODES.INVALID_TIMESTAMP]);
  }
  assert.deepEqual(validateRevisionMeta(baseMeta({ timestamp: '2026-08-12T10:00:00Z' })), []);
  assert.deepEqual(validateRevisionMeta(baseMeta({ timestamp: undefined })), []);
});

test('an unknown meta key is rejected — a typo must not silently drop an audit field', () => {
  const found = validateRevisionMeta(baseMeta({ aprover: { type: 'migration', id: 'x' } }));
  assert.deepEqual(codesOf(found), [REVISION_VIOLATION_CODES.INVALID_REVISION_META]);
  assert.deepEqual(found[0].identity, { key: 'aprover' });
});

test('an optional baseRevision must be a qualified id or null (the head the change was built on)', () => {
  assert.deepEqual(validateRevisionMeta(baseMeta({ baseRevision: null })), []);
  assert.deepEqual(validateRevisionMeta(baseMeta({ baseRevision: revisionId(PROJECT, 1) })), []);
  assert.deepEqual(codesOf(validateRevisionMeta(baseMeta({ baseRevision: 7 }))), [
    REVISION_VIOLATION_CODES.INVALID_BASE_REVISION,
  ]);
});

// --- applyChangeSet: the genesis revision ---------------------------------------------------------

test('the genesis apply writes the mutation, the ChangeSet, the Revision and the metadata record', async () => {
  await withPort(async (port) => {
    const revision = await applyOk(port, baseChangeSet());

    // the mutation
    const curated = await readState(port, 'curated');
    assert.deepEqual(
      curated.nodes.map((node) => [node.type, node.id]),
      [['Term', ID.term]],
    );

    // the record, in the system namespace, in the same transaction
    assert.equal(revision.id, revisionId(PROJECT, 1));
    assert.equal(revision.sequence, 1);
    assert.equal(revision.previousRevision, null);
    assert.equal(revision.previousHash, null);
    assert.equal(revision.changeSetId, changeSetId(PROJECT, 1));
    assert.match(revision.hash, /^[0-9a-f]{64}$/);

    const system = await readState(port, 'system');
    assert.deepEqual(
      system.nodes.map((node) => [node.type, node.id]).sort(),
      [
        [CHANGE_SET_TYPE, changeSetId(PROJECT, 1)],
        [REVISION_TYPE, revisionId(PROJECT, 1)],
        [SYSTEM_RECORD_TYPE, systemRecordId(PROJECT)],
      ].sort(),
    );
    assert.deepEqual(system.edges, [
      {
        namespace: 'system',
        scenarioId: null,
        type: RECORDS_RELATIONSHIP,
        fromId: revisionId(PROJECT, 1),
        toId: changeSetId(PROJECT, 1),
      },
    ]);

    // the ChangeSet node carries the operations verbatim
    const changeSet = await readNode(port, 'system', changeSetId(PROJECT, 1));
    assert.deepEqual(changeSet.properties, { id: changeSetId(PROJECT, 1), operations: baseChangeSet().operations });
  });
});

test('the genesis apply establishes the B4 metadata record with the schema version and the new head', async () => {
  await withPort(async (port) => {
    await applyOk(port, baseChangeSet());
    assert.deepEqual(await readMetadata(port), {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      headRevision: revisionId(PROJECT, 1),
    });
  });
});

test('the Revision node property set is pinned, and the hash covers all of it but itself', async () => {
  await withPort(async (port) => {
    const revision = await applyOk(port, baseChangeSet());
    assert.deepEqual(Object.keys(revision).sort(), [
      'approver',
      'changeSetId',
      'hash',
      'id',
      'previousHash',
      'previousRevision',
      'proposer',
      'provenance',
      'sequence',
      'timestamp',
    ]);
    assert.deepEqual(Object.keys(revision).sort(), [...REVISION_PROPERTIES].sort());
  });
});

test('the recorded hash is exactly sha256 over the canonical payload — recomputable by any auditor', async () => {
  await withPort(async (port) => {
    const revision = await applyOk(port, baseChangeSet());
    const changeSet = await readNode(port, 'system', changeSetId(PROJECT, 1));
    const { hash, ...payload } = revision;
    assert.equal(hash, revisionHash({ ...payload, changeSet: changeSet.properties }));
  });
});

test('the actor identity, timestamp and provenance snapshot are recorded verbatim (§21, §26)', async () => {
  await withPort(async (port) => {
    const meta = baseMeta();
    const revision = await applyOk(port, baseChangeSet());
    assert.deepEqual(revision.proposer, meta.proposer);
    assert.deepEqual(revision.approver, meta.approver);
    assert.deepEqual(revision.provenance, meta.provenance);
    assert.equal(revision.timestamp, meta.timestamp);
  });
});

test('an omitted timestamp is filled from the system clock as an ISO-8601 UTC string', async () => {
  await withPort(async (port) => {
    const result = await applyChangeSet(port, baseChangeSet(), baseMeta({ timestamp: undefined }));
    assert.equal(result.ok, true);
    assert.match(result.revision.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

// --- applyChangeSet: the chain --------------------------------------------------------------------

test('each apply links to the previous one and moves the head, in one chain', async () => {
  await withPort(async (port) => {
    const first = await applyOk(port, baseChangeSet());
    const second = await applyOk(port, { operations: [addNode('Check', ID.check)] });

    assert.equal(second.sequence, 2);
    assert.equal(second.id, revisionId(PROJECT, 2));
    assert.equal(second.previousRevision, first.id);
    assert.equal(second.previousHash, first.hash);
    assert.notEqual(second.hash, first.hash);
    assert.equal(second.changeSetId, changeSetId(PROJECT, 2));

    assert.equal((await readMetadata(port)).headRevision, second.id);
    assert.deepEqual((await readRevisions(port)).map((r) => r.sequence), [1, 2]);
  });
});

test('moving the head preserves every other property of the metadata record', async () => {
  await withPort(async (port) => {
    await applyOk(port, baseChangeSet());
    await withTransaction(port, async (tx) => {
      const current = await tx.getNode({ namespace: 'system', id: systemRecordId(PROJECT) });
      await tx.updateNode({
        namespace: 'system',
        id: systemRecordId(PROJECT),
        properties: { ...current.properties, exportedAt: '2026-08-12T09:00:00.000Z' },
      });
    });
    await applyOk(port, { operations: [addNode('Check', ID.check)] });
    assert.deepEqual(await readMetadata(port), {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      headRevision: revisionId(PROJECT, 2),
      exportedAt: '2026-08-12T09:00:00.000Z',
    });
  });
});

// --- applyChangeSet: the four operations ------------------------------------------------------------

test('ADD writes a node and an edge; MODIFY replaces the whole property bag', async () => {
  await withPort(async (port) => {
    await applyOk(port, {
      operations: [addNode('Surface', ID.surface), addNode('Agent', ID.agent), addEdge('OWNED_BY', ID.surface, ID.agent)],
    });
    const seeded = await readState(port, 'curated');
    assert.deepEqual(seeded.edges.map((edge) => [edge.type, edge.fromId, edge.toId]), [['OWNED_BY', ID.surface, ID.agent]]);

    await applyOk(port, {
      operations: [{ op: 'MODIFY', target: 'node', namespace: 'curated', id: ID.surface, properties: { id: ID.surface, status: 'deprecated' } }],
    });
    const surface = await readNode(port, 'curated', ID.surface);
    assert.deepEqual(surface.properties, { id: ID.surface, status: 'deprecated' });
  });
});

test('SUPERSEDE writes the replacement, flips the old node to superseded and links them (§6)', async () => {
  await withPort(async (port) => {
    await applyOk(port, { operations: [addNode('Rule', ID.rule, { title: 'v1' })] });
    await applyOk(port, {
      operations: [
        {
          op: 'SUPERSEDE',
          target: 'node',
          namespace: 'curated',
          supersededId: ID.rule,
          type: 'Rule',
          id: ID.ruleV2,
          properties: { id: ID.ruleV2, status: 'active', title: 'v2' },
        },
      ],
    });

    const old = await readNode(port, 'curated', ID.rule);
    const replacement = await readNode(port, 'curated', ID.ruleV2);
    assert.equal(old.properties.status, 'superseded');
    assert.equal(old.properties.title, 'v1', 'supersession must not rewrite the retired node beyond its status');
    assert.equal(replacement.properties.status, 'active');

    const { edges } = await readState(port, 'curated');
    assert.deepEqual(edges.map((edge) => [edge.type, edge.fromId, edge.toId]), [['SUPERSEDES', ID.ruleV2, ID.rule]]);
  });
});

test('SUPERSEDE refuses an illegal lifecycle transition (B2 owns the rule)', async () => {
  await withPort(async (port) => {
    await applyOk(port, { operations: [addNode('Rule', ID.rule, { status: 'superseded' })] });
    const result = await applyChangeSet(
      port,
      {
        operations: [
          {
            op: 'SUPERSEDE',
            target: 'node',
            namespace: 'curated',
            supersededId: ID.rule,
            type: 'Rule',
            id: ID.ruleV2,
            properties: { id: ID.ruleV2, status: 'active' },
          },
        ],
      },
      baseMeta(),
    );
    assert.equal(result.ok, false);
    assert.deepEqual(codesOf(result.violations), ['ILLEGAL_LIFECYCLE_TRANSITION']);
    assert.equal(await readNode(port, 'curated', ID.ruleV2), null);
    assert.equal((await readMetadata(port)).headRevision, revisionId(PROJECT, 1));
  });
});

test('REMOVE is an audited physical deletion of a node or an edge (§6 reserve)', async () => {
  await withPort(async (port) => {
    await applyOk(port, {
      operations: [addNode('Surface', ID.surface), addNode('Agent', ID.agent), addEdge('OWNED_BY', ID.surface, ID.agent)],
    });
    await applyOk(port, {
      operations: [
        { op: 'REMOVE', target: 'edge', namespace: 'curated', type: 'OWNED_BY', fromId: ID.surface, toId: ID.agent },
        { op: 'REMOVE', target: 'node', namespace: 'curated', id: ID.agent },
      ],
    });
    const state = await readState(port, 'curated');
    assert.deepEqual(state.nodes.map((node) => node.id), [ID.surface]);
    assert.deepEqual(state.edges, []);
  });
});

test('a ChangeSet may write the topology namespace — topology promotions are chained too', async () => {
  await withPort(async (port) => {
    await applyOk(
      port,
      {
        operations: [
          { op: 'ADD', target: 'node', namespace: 'topology', type: 'Repository', id: 'apex:proj:repository:root', properties: { id: 'apex:proj:repository:root' } },
        ],
      },
      { proposer: { type: 'automated-topology-writer', id: 'topology-refresh' }, approver: { type: 'automated-topology-writer', id: 'topology-refresh' } },
    );
    const topology = await readState(port, 'topology');
    assert.deepEqual(topology.nodes.map((node) => node.id), ['apex:proj:repository:root']);
  });
});

// --- applyChangeSet: refusals write nothing ---------------------------------------------------------

test('applyChangeSet throws only on programmer error: a missing port', async () => {
  await assert.rejects(() => applyChangeSet(undefined, baseChangeSet(), baseMeta()), TypeError);
  await assert.rejects(() => applyChangeSet({}, baseChangeSet(), baseMeta()), TypeError);
});

test('an invalid ChangeSet or meta is refused whole — no transaction, no partial state', async () => {
  await withPort(async (port) => {
    const badSet = await applyChangeSet(port, { operations: [addNode('Term', ID.term), { op: 'NOPE', target: 'node' }] }, baseMeta());
    assert.equal(badSet.ok, false);
    assert.equal(badSet.revision, null);
    assert.deepEqual(codesOf(badSet.violations), [REVISION_VIOLATION_CODES.UNKNOWN_CHANGE_OPERATION]);

    const badMeta = await applyChangeSet(port, baseChangeSet(), baseMeta({ approver: undefined }));
    assert.equal(badMeta.ok, false);
    assert.deepEqual(codesOf(badMeta.violations), [REVISION_VIOLATION_CODES.INVALID_ACTOR_IDENTITY]);

    assert.deepEqual((await readState(port, 'curated')).nodes, []);
    assert.deepEqual((await readState(port, 'system')).nodes, []);
  });
});

// --- applyChangeSet: atomicity (spec failure table: roll back; prior revision stays readable) -----

// A port whose transactions refuse to commit — the "injected failure" of the plan's deliverable, at
// the one point where a half-written promotion would be catastrophic.
function portWithFailingCommit(port, error) {
  return {
    capabilities: () => port.capabilities(),
    close: () => port.close(),
    async begin() {
      const tx = await port.begin();
      return new Proxy(tx, {
        get(target, property, receiver) {
          if (property === 'commit') {
            return async () => {
              throw error;
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

test('a failure late in the set rolls the whole set back: no partial state, prior head readable', async () => {
  await withPort(async (port) => {
    const first = await applyOk(port, baseChangeSet());

    const result = await applyChangeSet(
      port,
      { operations: [addNode('Surface', ID.surface), addEdge('OWNED_BY', ID.surface, ID.agent)] },
      baseMeta(),
    );

    assert.equal(result.ok, false);
    assert.equal(result.revision, null);
    assert.deepEqual(codesOf(result.violations), ['EDGE_ENDPOINT_MISSING']);
    assert.equal(result.violations[0].identity.id, ID.agent);

    // the successful first operation of the failed set left nothing behind
    assert.equal(await readNode(port, 'curated', ID.surface), null);
    assert.deepEqual((await readState(port, 'curated')).nodes.map((node) => node.id), [ID.term]);
    // and the prior revision is still the head
    assert.equal((await readMetadata(port)).headRevision, first.id);
    assert.deepEqual((await readRevisions(port)).map((r) => r.id), [first.id]);
  });
});

test('a commit that throws propagates (not a data problem) and leaves the graph untouched', async () => {
  await withPort(async (port) => {
    const first = await applyOk(port, baseChangeSet());
    const injected = new Error('injected commit failure');

    await assert.rejects(
      () => applyChangeSet(portWithFailingCommit(port, injected), { operations: [addNode('Check', ID.check)] }, baseMeta()),
      /injected commit failure/,
    );

    assert.equal(await readNode(port, 'curated', ID.check), null);
    assert.equal(await readNode(port, 'system', revisionId(PROJECT, 2)), null);
    assert.equal((await readMetadata(port)).headRevision, first.id);
  });
});

test('an id in the Revision history may never be re-created, even after a REMOVE (§6)', async () => {
  await withPort(async (port) => {
    await applyOk(port, baseChangeSet());
    await applyOk(port, { operations: [{ op: 'REMOVE', target: 'node', namespace: 'curated', id: ID.term }] });
    assert.equal(await readNode(port, 'curated', ID.term), null, 'the node really is gone from the graph');

    const result = await applyChangeSet(port, baseChangeSet(), baseMeta());
    assert.equal(result.ok, false);
    assert.deepEqual(codesOf(result.violations), ['ID_ALREADY_USED']);
    assert.equal(result.violations[0].identity.index, 0);
    assert.equal((await readMetadata(port)).headRevision, revisionId(PROJECT, 2));
  });
});

// The one exception, and its exact boundary. A repository-derived node is an OBSERVATION, and the
// filesystem legitimately un-does a deletion (a reverted commit, an undone rename, a directory
// moved back). A flat "never again" would wedge the topology refresh permanently — the second
// epoch could never be recorded, so no later refresh of any kind could be either. So a `topology`
// id whose previous epoch ENDED IN AN AUDITED REMOVE may start a new one; every other namespace
// keeps §6 literally (the test above), and the chain still explains both epochs.
const topologyPackageId = 'apex:proj:package:engine';

function addTopologyNode(id = topologyPackageId, path = 'packages/engine') {
  return { op: 'ADD', target: 'node', namespace: 'topology', type: 'Package', id, properties: { id, path } };
}

function removeTopologyNode(id = topologyPackageId) {
  return { op: 'REMOVE', target: 'node', namespace: 'topology', id };
}

test('a topology id removed in an audited REMOVE may start a NEW epoch; the chain explains both', async () => {
  await withPort(async (port) => {
    await applyOk(port, { operations: [addTopologyNode()] });
    await applyOk(port, { operations: [removeTopologyNode()] });
    assert.equal(await readNode(port, 'topology', topologyPackageId), null, 'the node really was gone');

    const restored = await applyChangeSet(
      port,
      { operations: [addTopologyNode(topologyPackageId, 'packages/engine-restored')] },
      baseMeta(),
    );
    assert.deepEqual(restored.violations, []);
    assert.equal(restored.ok, true);
    assert.equal((await readNode(port, 'topology', topologyPackageId)).properties.path, 'packages/engine-restored');

    // ADD -> REMOVE -> ADD replays cleanly: replay tracks LIVE state, so the second epoch is
    // explained by the chain and nothing is reported as unexplained or missing.
    const replay = await replayChain(port, { projectId: PROJECT });
    assert.deepEqual(replay.violations, []);
    assert.deepEqual(replay.unexplained, { nodes: [], edges: [] });
    assert.deepEqual(replay.missing, { nodes: [], edges: [] });

    // And it is repeatable: an observation may come and go as often as the repository does.
    await applyOk(port, { operations: [removeTopologyNode()] });
    await applyOk(port, { operations: [addTopologyNode()] });
    assert.deepEqual((await replayChain(port, { projectId: PROJECT })).violations, []);
  });
});

test('a LIVE topology id is still refused: only a closed epoch reopens', async () => {
  await withPort(async (port) => {
    await applyOk(port, { operations: [addTopologyNode()] });
    const again = await applyChangeSet(port, { operations: [addTopologyNode()] }, baseMeta());
    assert.equal(again.ok, false);
    assert.deepEqual(codesOf(again.violations), ['ID_ALREADY_USED']);

    // A MODIFY does not end an epoch either — the node is still there.
    await applyOk(port, {
      operations: [
        { op: 'MODIFY', target: 'node', namespace: 'topology', id: topologyPackageId, properties: { id: topologyPackageId, path: 'moved' } },
      ],
    });
    const afterModify = await applyChangeSet(port, { operations: [addTopologyNode()] }, baseMeta());
    assert.deepEqual(codesOf(afterModify.violations), ['ID_ALREADY_USED']);
  });
});

test('the epoch exception is scoped to topology: a curated id removed in the same chain stays burned', async () => {
  await withPort(async (port) => {
    await applyOk(port, { operations: [addNode('Term', ID.term), addTopologyNode()] });
    await applyOk(port, {
      operations: [{ op: 'REMOVE', target: 'node', namespace: 'curated', id: ID.term }, removeTopologyNode()],
    });

    const curated = await applyChangeSet(port, { operations: [addNode('Term', ID.term)] }, baseMeta());
    assert.equal(curated.ok, false);
    assert.deepEqual(codesOf(curated.violations), ['ID_ALREADY_USED']);

    const topology = await applyChangeSet(port, { operations: [addTopologyNode()] }, baseMeta());
    assert.equal(topology.ok, true, 'the same chain, the other namespace');
  });
});

test('a change built on a moved head is refused inside the transaction (D5 PROMOTION_STALE)', async () => {
  await withPort(async (port) => {
    const first = await applyOk(port, baseChangeSet());

    const stale = await applyChangeSet(port, { operations: [addNode('Check', ID.check)] }, baseMeta({ baseRevision: null }));
    assert.equal(stale.ok, false);
    assert.deepEqual(codesOf(stale.violations), [REVISION_VIOLATION_CODES.STALE_BASE_REVISION]);
    assert.deepEqual(stale.violations[0].identity, { baseRevision: null, headRevision: first.id });

    const fresh = await applyChangeSet(port, { operations: [addNode('Check', ID.check)] }, baseMeta({ baseRevision: first.id }));
    assert.equal(fresh.ok, true);
  });
});

test('a genesis change may declare it was built on the empty graph', async () => {
  await withPort(async (port) => {
    const result = await applyChangeSet(port, baseChangeSet(), baseMeta({ baseRevision: null }));
    assert.equal(result.ok, true);
    assert.equal(result.revision.sequence, 1);
  });
});

test('the chain refuses to grow on a graph it does not understand', async () => {
  // wrong metadata record type (B4's pinned contract)
  await withPort(async (port) => {
    await withTransaction(port, (tx) =>
      tx.createNode({ namespace: 'system', type: 'Nonsense', id: systemRecordId(PROJECT), properties: { headRevision: null } }),
    );
    const result = await applyChangeSet(port, baseChangeSet(), baseMeta());
    assert.deepEqual(codesOf(result.violations), ['INVALID_METADATA_RECORD_TYPE']);
    assert.deepEqual((await readState(port, 'curated')).nodes, []);
  });

  // unsupported schema version (failure table: refuse, require an explicit migration)
  await withPort(async (port) => {
    await withTransaction(port, (tx) =>
      tx.createNode({
        namespace: 'system',
        type: SYSTEM_RECORD_TYPE,
        id: systemRecordId(PROJECT),
        properties: { schemaVersion: GRAPH_SCHEMA_VERSION + 99, headRevision: null },
      }),
    );
    const result = await applyChangeSet(port, baseChangeSet(), baseMeta());
    assert.deepEqual(codesOf(result.violations), ['UNSUPPORTED_SCHEMA_VERSION']);
  });
});

test('a declared head that no longer exists refuses the append rather than starting a second chain', async () => {
  await withPort(async (port) => {
    const first = await applyOk(port, baseChangeSet());
    await withTransaction(port, async (tx) => {
      await tx.deleteEdge({ namespace: 'system', type: RECORDS_RELATIONSHIP, fromId: first.id, toId: changeSetId(PROJECT, 1) });
      await tx.deleteNode({ namespace: 'system', id: first.id });
    });

    const result = await applyChangeSet(port, { operations: [addNode('Check', ID.check)] }, baseMeta());
    assert.equal(result.ok, false);
    assert.deepEqual(codesOf(result.violations), [REVISION_VIOLATION_CODES.HEAD_REVISION_MISSING]);
    assert.equal(result.violations[0].identity.headRevision, first.id);
  });
});

test('a hand-edited Revision record refuses the append (its shape is part of the contract)', async () => {
  await withPort(async (port) => {
    const first = await applyOk(port, baseChangeSet());
    await withTransaction(port, (tx) =>
      tx.updateNode({ namespace: 'system', id: first.id, properties: { id: first.id, tampered: true } }),
    );
    const result = await applyChangeSet(port, { operations: [addNode('Check', ID.check)] }, baseMeta());
    assert.equal(result.ok, false);
    assert.deepEqual(codesOf(result.violations), [REVISION_VIOLATION_CODES.MALFORMED_REVISION_RECORD]);
  });
});

// --- reading and verifying the chain (§21: altering a past Revision breaks every later one) --------

// Rewrites a system record behind the module's back — the out-of-band write the audit exists to catch.
async function tamperWith(port, id, mutate) {
  await withTransaction(port, async (tx) => {
    const node = await tx.getNode({ namespace: 'system', id });
    await tx.updateNode({ namespace: 'system', id, properties: mutate({ ...node.properties }) });
  });
}

// Four revisions, so "every LATER revision" is a real claim and not an off-by-one.
async function chainOfFour(port) {
  const revisions = [];
  revisions.push(await applyOk(port, { operations: [addNode('Project', ID.project)] }));
  revisions.push(await applyOk(port, { operations: [addNode('Surface', ID.surface), addEdge('PART_OF', ID.surface, ID.project)] }));
  revisions.push(await applyOk(port, { operations: [addNode('Agent', ID.agent), addEdge('OWNED_BY', ID.surface, ID.agent)] }));
  revisions.push(await applyOk(port, { operations: [addNode('Term', ID.term)] }));
  return revisions;
}

test('readChain returns every Revision joined with its ChangeSet, in sequence order', async () => {
  await withPort(async (port) => {
    const written = await chainOfFour(port);
    const { revisions, headRevision, violations } = await readChain(port, { projectId: PROJECT });
    assert.deepEqual(violations, []);
    assert.equal(headRevision, written.at(-1).id);
    assert.deepEqual(revisions.map((revision) => revision.sequence), [1, 2, 3, 4]);
    assert.deepEqual(revisions[1].changeSet.operations, [
      addNode('Surface', ID.surface),
      addEdge('PART_OF', ID.surface, ID.project),
    ]);
  });
});

test('an untouched chain verifies clean, and so does a graph that has never been promoted', async () => {
  await withPort(async (port) => {
    await chainOfFour(port);
    const result = await verifyChain(port, { projectId: PROJECT });
    assert.deepEqual(result.violations, []);
    assert.equal(result.ok, true);
    assert.equal(result.revisions.length, 4);
  });
  await withPort(async (port) => {
    const empty = await verifyChain(port, { projectId: PROJECT });
    assert.deepEqual(empty.violations, []);
    assert.equal(empty.ok, true);
  });
});

test('altering a past Revision breaks its hash AND every later one (§21, git-style)', async () => {
  await withPort(async (port) => {
    const written = await chainOfFour(port);
    await tamperWith(port, written[1].id, (properties) => ({
      ...properties,
      approver: { type: 'human-approver', id: 'someone-who-never-approved-this' },
    }));

    const result = await verifyChain(port, { projectId: PROJECT });
    assert.equal(result.ok, false);
    const broken = result.violations
      .filter((item) => item.code === REVISION_VIOLATION_CODES.REVISION_HASH_MISMATCH)
      .map((item) => item.identity.sequence)
      .sort();
    assert.deepEqual(broken, [2, 3, 4], 'the tampered revision and every later one must break');
    const [first] = result.violations.filter((item) => item.identity.sequence === 2);
    assert.equal(first.identity.id, written[1].id);
    assert.equal(first.identity.recordedHash, written[1].hash);
    assert.notEqual(first.identity.expectedHash, written[1].hash);
  });
});

test('altering the recorded ChangeSet content breaks the chain — the change-set is hashed, not just named', async () => {
  await withPort(async (port) => {
    const written = await chainOfFour(port);
    await tamperWith(port, changeSetId(PROJECT, 2), (properties) => ({
      ...properties,
      operations: [...properties.operations, addNode('Skill', ID.skill)],
    }));

    const result = await verifyChain(port, { projectId: PROJECT });
    assert.equal(result.ok, false);
    const broken = result.violations
      .filter((item) => item.code === REVISION_VIOLATION_CODES.REVISION_HASH_MISMATCH)
      .map((item) => item.identity.sequence)
      .sort();
    assert.deepEqual(broken, [2, 3, 4]);
    assert.equal(result.revisions[1].id, written[1].id);
  });
});

test('a rewritten link (previousRevision / previousHash) is reported as a broken link', async () => {
  await withPort(async (port) => {
    const written = await chainOfFour(port);
    await tamperWith(port, written[2].id, (properties) => ({ ...properties, previousHash: sha256Hex('invented') }));

    const result = await verifyChain(port, { projectId: PROJECT });
    const links = result.violations.filter((item) => item.code === REVISION_VIOLATION_CODES.REVISION_LINK_BROKEN);
    assert.deepEqual(links.map((item) => item.identity.id), [written[2].id]);
    assert.equal(links[0].identity.expectedPreviousHash, written[1].hash);
  });
});

test('a Revision removed from the middle of the chain leaves a sequence gap', async () => {
  await withPort(async (port) => {
    const written = await chainOfFour(port);
    await withTransaction(port, async (tx) => {
      await tx.deleteEdge({
        namespace: 'system',
        type: RECORDS_RELATIONSHIP,
        fromId: written[1].id,
        toId: changeSetId(PROJECT, 2),
      });
      await tx.deleteNode({ namespace: 'system', id: written[1].id });
    });

    const result = await verifyChain(port, { projectId: PROJECT });
    assert.equal(result.ok, false);
    const gaps = result.violations.filter((item) => item.code === REVISION_VIOLATION_CODES.REVISION_SEQUENCE_BROKEN);
    assert.deepEqual(gaps.map((item) => item.identity.sequence), [3]);
    assert.equal(gaps[0].identity.expectedSequence, 2);
  });
});

test('a head that does not name the last Revision is reported', async () => {
  await withPort(async (port) => {
    const written = await chainOfFour(port);
    await withTransaction(port, async (tx) => {
      const record = await tx.getNode({ namespace: 'system', id: systemRecordId(PROJECT) });
      await tx.updateNode({
        namespace: 'system',
        id: systemRecordId(PROJECT),
        properties: { ...record.properties, headRevision: written[0].id },
      });
    });

    const result = await verifyChain(port, { projectId: PROJECT });
    const found = result.violations.filter((item) => item.code === REVISION_VIOLATION_CODES.REVISION_HEAD_MISMATCH);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].identity, { headRevision: written[0].id, actualHead: written[3].id });
  });
});

test('a declared head over an empty chain is reported rather than read as "no promotions yet"', async () => {
  await withPort(async (port) => {
    await withTransaction(port, (tx) =>
      tx.createNode({
        namespace: 'system',
        type: SYSTEM_RECORD_TYPE,
        id: systemRecordId(PROJECT),
        properties: { schemaVersion: GRAPH_SCHEMA_VERSION, headRevision: revisionId(PROJECT, 1) },
      }),
    );
    const result = await verifyChain(port, { projectId: PROJECT });
    assert.equal(result.ok, false);
    assert.deepEqual(codesOf(result.violations), [REVISION_VIOLATION_CODES.REVISION_HEAD_MISMATCH]);
    assert.deepEqual(result.violations[0].identity, { headRevision: revisionId(PROJECT, 1), actualHead: null });
  });
});

test('a Revision whose ChangeSet node was deleted is reported and cannot be certified', async () => {
  await withPort(async (port) => {
    const written = await chainOfFour(port);
    await withTransaction(port, async (tx) => {
      await tx.deleteEdge({
        namespace: 'system',
        type: RECORDS_RELATIONSHIP,
        fromId: written[1].id,
        toId: changeSetId(PROJECT, 2),
      });
      await tx.deleteNode({ namespace: 'system', id: changeSetId(PROJECT, 2) });
    });
    const result = await verifyChain(port, { projectId: PROJECT });
    assert.equal(result.ok, false);
    assert.ok(codesOf(result.violations).includes(REVISION_VIOLATION_CODES.MALFORMED_REVISION_RECORD));
    assert.ok(codesOf(result.violations).includes(REVISION_VIOLATION_CODES.REVISION_HASH_MISMATCH));
  });
});

test('chain reads throw only on programmer error: no port, no projectId', async () => {
  await withPort(async (port) => {
    await assert.rejects(() => verifyChain(undefined, { projectId: PROJECT }), TypeError);
    await assert.rejects(() => readChain(port, {}), TypeError);
    await assert.rejects(() => verifyChain(port, { projectId: 'Not A Project' }), TypeError);
    await assert.rejects(() => verifyChain(port, { projectId: PROJECT, unknownKey: 1 }), TypeError);
  });
});

// --- replay: out-of-band write detection (success criterion 13) -----------------------------------

// Writes straight to the port, bypassing the Promotion Service — an admin at the database console.
function outOfBand(port, fn) {
  return withTransaction(port, fn);
}

function ruleOp(id) {
  return {
    op: 'ADD',
    target: 'node',
    namespace: 'curated',
    type: 'Rule',
    id,
    properties: {
      id,
      title: 'Sanitize external input',
      statement: 'Sanitize every external value before writing it to disk.',
      status: 'active',
      strength: 'must',
      category: 'security',
      concern: 'external-input',
      provenance: { source: 'docs/spec.md', line: 52 },
    },
  };
}

// A complete, B4-valid curated graph, promoted the way the product promotes: one ChangeSet per step.
async function promoteValidGraph(port) {
  await applyOk(port, { operations: [addNode('Project', ID.project)] });
  await applyOk(port, {
    operations: [addNode('Surface', ID.surface), addEdge('PART_OF', ID.surface, ID.project)],
  });
  await applyOk(port, {
    operations: [
      addNode('Agent', ID.agent),
      addEdge('OWNED_BY', ID.surface, ID.agent),
      addNode('Check', ID.check),
      ruleOp(ID.rule),
      addEdge('APPLIES_TO', ID.rule, ID.surface),
      addEdge('VERIFIED_BY', ID.rule, ID.check),
    ],
  });
}

test('a graph built entirely through promotions replays clean', async () => {
  await withPort(async (port) => {
    await promoteValidGraph(port);
    const result = await replayChain(port, { projectId: PROJECT });
    assert.deepEqual(result.violations, []);
    assert.equal(result.ok, true);
    assert.deepEqual(result.unexplained, { nodes: [], edges: [] });
    assert.deepEqual(result.missing, { nodes: [], edges: [] });
  });
});

test('replay flags an out-of-band node with its exact identity (criterion 13)', async () => {
  await withPort(async (port) => {
    await promoteValidGraph(port);
    await outOfBand(port, (tx) =>
      tx.createNode({ namespace: 'curated', type: 'Decision', id: ID.decision, properties: { id: ID.decision, status: 'active' } }),
    );

    const result = await replayChain(port, { projectId: PROJECT });
    assert.equal(result.ok, false);
    const found = result.violations.filter((item) => item.code === REVISION_VIOLATION_CODES.UNEXPLAINED_NODE);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].identity, { namespace: 'curated', id: ID.decision, type: 'Decision' });
    assert.deepEqual(result.unexplained.nodes, [
      { namespace: 'curated', type: 'Decision', id: ID.decision, properties: { id: ID.decision, status: 'active' } },
    ]);
  });
});

test('replay flags an out-of-band edge with its exact identity (criterion 13)', async () => {
  await withPort(async (port) => {
    await promoteValidGraph(port);
    await outOfBand(port, (tx) => tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: ID.rule, toId: ID.agent }));

    const result = await replayChain(port, { projectId: PROJECT });
    assert.equal(result.ok, false);
    const found = result.violations.filter((item) => item.code === REVISION_VIOLATION_CODES.UNEXPLAINED_EDGE);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].identity, { namespace: 'curated', type: 'APPLIES_TO', fromId: ID.rule, toId: ID.agent });
    assert.deepEqual(result.unexplained.edges, [
      { namespace: 'curated', type: 'APPLIES_TO', fromId: ID.rule, toId: ID.agent },
    ]);
  });
});

test('replay flags an out-of-band property edit, naming the fields no Revision explains', async () => {
  await withPort(async (port) => {
    await promoteValidGraph(port);
    await outOfBand(port, async (tx) => {
      const node = await tx.getNode({ namespace: 'curated', id: ID.rule });
      await tx.updateNode({
        namespace: 'curated',
        id: ID.rule,
        properties: { ...node.properties, strength: 'should', statement: 'quietly rewritten' },
      });
    });

    const result = await replayChain(port, { projectId: PROJECT });
    assert.equal(result.ok, false);
    const found = result.violations.filter((item) => item.code === REVISION_VIOLATION_CODES.UNEXPLAINED_NODE_STATE);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].identity, {
      namespace: 'curated',
      id: ID.rule,
      type: 'Rule',
      fields: ['statement', 'strength'],
    });
  });
});

test('replay flags state the chain explains but the database no longer has (out-of-band deletion)', async () => {
  await withPort(async (port) => {
    await promoteValidGraph(port);
    await outOfBand(port, async (tx) => {
      await tx.deleteEdge({ namespace: 'curated', type: 'VERIFIED_BY', fromId: ID.rule, toId: ID.check });
      await tx.deleteNode({ namespace: 'curated', id: ID.check });
    });

    const result = await replayChain(port, { projectId: PROJECT });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.violations.filter((item) => item.code === REVISION_VIOLATION_CODES.MISSING_NODE).map((item) => item.identity.id),
      [ID.check],
    );
    assert.deepEqual(
      result.violations.filter((item) => item.code === REVISION_VIOLATION_CODES.MISSING_EDGE).map((item) => item.identity),
      [{ namespace: 'curated', type: 'VERIFIED_BY', fromId: ID.rule, toId: ID.check }],
    );
    assert.deepEqual(result.missing.nodes.map((node) => node.id), [ID.check]);
  });
});

test('replay covers the topology namespace too — no part of the stable graph is outside the audit', async () => {
  await withPort(async (port) => {
    await promoteValidGraph(port);
    await outOfBand(port, (tx) =>
      tx.createNode({
        namespace: 'topology',
        type: 'Package',
        id: 'apex:proj:package:engine',
        properties: { id: 'apex:proj:package:engine' },
      }),
    );
    const result = await replayChain(port, { projectId: PROJECT });
    const found = result.violations.filter((item) => item.code === REVISION_VIOLATION_CODES.UNEXPLAINED_NODE);
    assert.deepEqual(found.map((item) => item.identity.namespace), ['topology']);
  });
});

test('a supersession replays exactly — the retired node’s flipped status is explained', async () => {
  await withPort(async (port) => {
    await promoteValidGraph(port);
    await applyOk(port, {
      operations: [
        {
          op: 'SUPERSEDE',
          target: 'node',
          namespace: 'curated',
          supersededId: ID.rule,
          type: 'Rule',
          id: ID.ruleV2,
          properties: { ...ruleOp(ID.ruleV2).properties },
        },
        addEdge('APPLIES_TO', ID.ruleV2, ID.surface),
      ],
    });
    const result = await replayChain(port, { projectId: PROJECT });
    assert.deepEqual(result.violations, []);
  });
});

test('replay cannot certify materialized state on a broken chain — the chain faults come with it', async () => {
  await withPort(async (port) => {
    await promoteValidGraph(port);
    await tamperWith(port, revisionId(PROJECT, 2), (properties) => ({
      ...properties,
      approver: { type: 'migration', id: 'not-the-approver' },
    }));
    const result = await replayChain(port, { projectId: PROJECT });
    assert.equal(result.ok, false);
    assert.ok(codesOf(result.violations).includes(REVISION_VIOLATION_CODES.REVISION_HASH_MISMATCH));
  });
});

test('replay output is deterministic: the same graph reports the same bytes twice', async () => {
  await withPort(async (port) => {
    await promoteValidGraph(port);
    await outOfBand(port, async (tx) => {
      await tx.createNode({ namespace: 'curated', type: 'Term', id: ID.term, properties: { id: ID.term, status: 'active' } });
      await tx.createNode({ namespace: 'curated', type: 'Skill', id: ID.skill, properties: { id: ID.skill, status: 'active' } });
      await tx.createEdge({ namespace: 'curated', type: 'USED_BY', fromId: ID.term, toId: ID.surface });
      await tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: ID.skill, toId: ID.surface });
    });
    const first = await replayChain(port, { projectId: PROJECT });
    const second = await replayChain(port, { projectId: PROJECT });
    assert.equal(canonicalize(first.violations), canonicalize(second.violations));
    assert.equal(first.violations.length, 4);
    assert.deepEqual(
      [...first.violations].sort((a, b) => (canonicalize(a) < canonicalize(b) ? -1 : 1)),
      first.violations,
      'violations are sorted by code, then by canonical identity',
    );
  });
});

test('replay throws only on programmer error', async () => {
  await withPort(async (port) => {
    await assert.rejects(() => replayChain(port, { projectId: 'Not A Project' }), TypeError);
    await assert.rejects(() => replayChain(undefined, { projectId: PROJECT }), TypeError);
  });
});

// --- the historical id set (B2's non-reuse rule consumes it) ---------------------------------------

test('historicalNodeIds collects every id the chain ever bound, including removed and retired ones', async () => {
  await withPort(async (port) => {
    await applyOk(port, { operations: [addNode('Term', ID.term), addNode('Check', ID.check)] });
    await applyOk(port, { operations: [{ op: 'REMOVE', target: 'node', namespace: 'curated', id: ID.check }] });
    await applyOk(port, { operations: [addNode('Rule', ID.rule)] });
    await applyOk(port, {
      operations: [
        {
          op: 'SUPERSEDE',
          target: 'node',
          namespace: 'curated',
          supersededId: ID.rule,
          type: 'Rule',
          id: ID.ruleV2,
          properties: { id: ID.ruleV2, status: 'active' },
        },
      ],
    });

    const { revisions } = await readChain(port, { projectId: PROJECT });
    const history = historicalNodeIds(revisions);
    assert.ok(history instanceof Set);
    assert.deepEqual([...history].sort(), [ID.rule, ID.ruleV2, ID.check, ID.term].sort());
    assert.deepEqual([...historicalNodeIds([])], []);
  });
});

// --- integration with the portable validator (B4) ---------------------------------------------------

test('B4’s validator stays green on a graph full of Revisions — the audit is invisible to it', async () => {
  await withPort(async (port) => {
    await promoteValidGraph(port);
    const result = await validateGraph(port, { projectId: PROJECT });
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.ok, true);
    // and the head B4 reads is the one the chain wrote
    const { headRevision } = await readChain(port, { projectId: PROJECT });
    assert.equal((await readMetadata(port)).headRevision, headRevision);
  });
});

test('the one relationship a SUPERSEDE materializes is B1’s, not a private name', () => {
  assert.ok(RELATIONSHIP_TYPE_NAMES.includes(SUPERSEDES_RELATIONSHIP));
});

// --- stored operations are JSON-canonical -----------------------------------------------------------

test('an explicitly undefined argument is normalized away: JSON has no undefined, and the hash must be stable', async () => {
  await withPort(async (port) => {
    // `{ ...op, properties: undefined }` is an everyday JS idiom; the ChangeSet is stored as JSON, so
    // the key must not reach the database — and must not change the hash either.
    const withUndefined = { op: 'ADD', target: 'node', namespace: 'curated', type: 'Term', id: ID.term, properties: undefined };
    const revision = await applyOk(port, { operations: [withUndefined] });
    const stored = await readNode(port, 'system', changeSetId(PROJECT, 1));
    assert.deepEqual(stored.properties.operations, [
      { op: 'ADD', target: 'node', namespace: 'curated', type: 'Term', id: ID.term },
    ]);

    await withPort(async (other) => {
      const twin = await applyOk(other, {
        operations: [{ op: 'ADD', target: 'node', namespace: 'curated', type: 'Term', id: ID.term }],
      });
      assert.equal(twin.hash, revision.hash, 'the same change must hash the same however it was spelled');
    });

    const replayed = await replayChain(port, { projectId: PROJECT });
    assert.deepEqual(replayed.violations, []);
  });
});

test('replay reports a node re-created out-of-band under a different type', async () => {
  await withPort(async (port) => {
    await applyOk(port, { operations: [addNode('Term', ID.term)] });
    await outOfBand(port, async (tx) => {
      await tx.deleteNode({ namespace: 'curated', id: ID.term });
      await tx.createNode({ namespace: 'curated', type: 'Skill', id: ID.term, properties: { id: ID.term, status: 'active' } });
    });

    const result = await replayChain(port, { projectId: PROJECT });
    const found = result.violations.filter((item) => item.code === REVISION_VIOLATION_CODES.UNEXPLAINED_NODE_STATE);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].identity, { namespace: 'curated', id: ID.term, type: 'Skill', fields: ['type'] });
  });
});

test('verifyChainRecords judges a chain with no port at all — B6 verifies an exported chain offline', async () => {
  await withPort(async (port) => {
    const written = await chainOfFour(port);
    const { revisions, headRevision } = await readChain(port, { projectId: PROJECT });
    assert.deepEqual(verifyChainRecords(revisions, headRevision), []);
    assert.deepEqual(verifyChainRecords(), [], 'no chain and no head is a graph never promoted, not a fault');

    // the same tamper detection, on records that never came from a database
    const exported = structuredClone(revisions);
    exported[1].timestamp = '2020-01-01T00:00:00.000Z';
    const found = verifyChainRecords(exported, headRevision);
    assert.deepEqual(
      found.filter((item) => item.code === REVISION_VIOLATION_CODES.REVISION_HASH_MISMATCH).map((item) => item.identity.sequence),
      [2, 3, 4],
    );
    assert.equal(written.length, 4);
  });
});

// --- review round: the audit must not be extensible behind the chain's back -----------------------

test('a field appended to a Revision payload changes its hash — the hash is not an allowlist', () => {
  const payload = samplePayload();
  assert.notEqual(
    revisionHash({ ...payload, approvalNote: 'signed off in a meeting' }),
    revisionHash(payload),
    'an unlisted recorded property must be inside the hash',
  );
  // the one field that can never be part of its own input
  assert.equal(revisionHash({ ...payload, hash: 'whatever' }), revisionHash(payload));
});

test('fields forged onto a past Revision out-of-band break the chain and never reach consumers', async () => {
  await withPort(async (port) => {
    const [first, second] = [await applyOk(port, baseChangeSet()), await applyOk(port, { operations: [addNode('Check', ID.check)] })];

    // an admin appends plausible-looking audit fields to the FIRST revision, leaving every pinned
    // field untouched — the forgery §21 promises to catch.
    await tamperWith(port, first.id, (properties) => ({
      ...properties,
      approvalNote: 'approved verbally by the CTO',
      baseRevision: 'apex:proj:revision:r0',
      supersededBy: second.id,
    }));

    const verified = await verifyChain(port, { projectId: PROJECT });
    assert.equal(verified.ok, false, 'a forged field must break verification');
    const malformed = verified.violations.filter((item) => item.code === REVISION_VIOLATION_CODES.MALFORMED_REVISION_RECORD);
    assert.deepEqual(malformed.map((item) => item.identity.id), [first.id]);

    const replayed = await replayChain(port, { projectId: PROJECT });
    assert.equal(replayed.ok, false);

    const { revisions, violations } = await readChain(port, { projectId: PROJECT });
    assert.ok(violations.length > 0);
    assert.ok(
      revisions.every((revision) => !('approvalNote' in revision)),
      'a forged record must never be handed to a consumer as a chain member',
    );
  });
});

test('replay tells an absent property from a null-valued one, both ways', async () => {
  // a promoted null-valued property, deleted out-of-band
  await withPort(async (port) => {
    await applyOk(port, { operations: [addNode('Term', ID.term, { owner: null })] });
    await outOfBand(port, async (tx) => {
      const node = await tx.getNode({ namespace: 'curated', id: ID.term });
      const { owner: _dropped, ...rest } = node.properties;
      await tx.updateNode({ namespace: 'curated', id: ID.term, properties: rest });
    });

    const result = await replayChain(port, { projectId: PROJECT });
    const found = result.violations.filter((item) => item.code === REVISION_VIOLATION_CODES.UNEXPLAINED_NODE_STATE);
    assert.equal(found.length, 1, 'a deleted null-valued property is still a deleted property');
    assert.deepEqual(found[0].identity.fields, ['owner']);
  });

  // an unpromoted null-valued property, added out-of-band
  await withPort(async (port) => {
    await applyOk(port, { operations: [addNode('Term', ID.term)] });
    await outOfBand(port, async (tx) => {
      const node = await tx.getNode({ namespace: 'curated', id: ID.term });
      await tx.updateNode({ namespace: 'curated', id: ID.term, properties: { ...node.properties, deprecatedBy: null } });
    });

    const result = await replayChain(port, { projectId: PROJECT });
    const found = result.violations.filter((item) => item.code === REVISION_VIOLATION_CODES.UNEXPLAINED_NODE_STATE);
    assert.equal(found.length, 1, 'a null-valued property no Revision explains is still unexplained state');
    assert.deepEqual(found[0].identity.fields, ['deprecatedBy']);
  });
});

test('a record parked in the system namespace is reported, without freezing governance', async () => {
  await withPort(async (port) => {
    await applyOk(port, baseChangeSet());
    await outOfBand(port, (tx) =>
      tx.createNode({ namespace: 'system', type: 'Rule', id: ID.rule, properties: { id: ID.rule, status: 'active' } }),
    );

    const result = await verifyChain(port, { projectId: PROJECT });
    const found = result.violations.filter((item) => item.code === 'UNEXPECTED_SYSTEM_RECORD');
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].identity, { namespace: 'system', id: ID.rule, type: 'Rule' });
    assert.equal(result.ok, false);
    assert.equal(REVISION_VIOLATION_CODES.UNEXPECTED_SYSTEM_RECORD, 'UNEXPECTED_SYSTEM_RECORD');

    // the chain itself is intact, so a promotion is still allowed: a stray record is a reporting
    // matter for `graph validate`, not a reason to freeze the Promotion Service.
    const next = await applyChangeSet(port, { operations: [addNode('Check', ID.check)] }, baseMeta());
    assert.equal(next.ok, true);
    assert.equal(next.revision.sequence, 2);
  });
});

// --- the pure projection (D4 additive export) ------------------------------------------------------
//
// `applyChangeOperations` is the SAME state-machine `replayOperations` runs over a chain, exposed
// for a caller (D4's promotion preview) that materializes a base graph + candidate ops IN MEMORY
// without a port. It must share the exact op semantics — that is the whole point of the export — so
// these tests pin the projection against the same four operations + SUPERSEDE the replay suite does.

test('applyChangeOperations projects a candidate op list onto in-memory state without a port', () => {
  const seed = new Map([
    [
      canonicalize(['curated', ID.term]),
      { namespace: 'curated', type: 'Term', id: ID.term, properties: { id: ID.term, status: 'active' } },
    ],
  ]);
  const seedEdges = new Map();
  const missingCheck = 'apex:proj:check:never-created';
  const { nodes, edges, failures } = applyChangeOperations(seed, seedEdges, [
    addNode('Check', ID.check),
    { op: 'MODIFY', target: 'node', namespace: 'curated', id: ID.term, properties: { id: ID.term, status: 'deprecated' } },
    { op: 'MODIFY', target: 'node', namespace: 'curated', id: missingCheck, properties: { id: missingCheck, status: 'deprecated' } },
    addEdge('VERIFIED_BY', ID.check, ID.term),
  ]);
  // the one op that cannot apply (MODIFY of a node the state does not hold) is reported with its
  // index, and does not stop the rest of the projection.
  assert.deepEqual(failures, [
    { index: 2, op: 'MODIFY', target: 'node', reason: `node '${missingCheck}' does not exist` },
  ]);
  assert.equal(nodes.get(canonicalize(['curated', ID.check])).type, 'Check');
  assert.equal(nodes.get(canonicalize(['curated', ID.term])).properties.status, 'deprecated');
  assert.deepEqual([...edges.values()], [{ namespace: 'curated', type: 'VERIFIED_BY', fromId: ID.check, toId: ID.term }]);
  assert.equal(seed.size, 1, 'the input state is not mutated');
  assert.equal(seedEdges.size, 0);
});

test('applyChangeOperations applies SUPERSEDE exactly as the chain replays it', () => {
  const nodes = new Map([
    [
      canonicalize(['curated', ID.rule]),
      { namespace: 'curated', type: 'Rule', id: ID.rule, properties: { id: ID.rule, status: 'active' } },
    ],
  ]);
  const { nodes: out, edges, failures } = applyChangeOperations(nodes, new Map(), [
    {
      op: 'SUPERSEDE',
      target: 'node',
      namespace: 'curated',
      supersededId: ID.rule,
      type: 'Rule',
      id: ID.ruleV2,
      properties: { id: ID.ruleV2, status: 'active' },
    },
  ]);
  assert.deepEqual(failures, []);
  assert.equal(out.get(canonicalize(['curated', ID.rule])).properties.status, 'superseded');
  assert.equal(out.get(canonicalize(['curated', ID.ruleV2])).properties.status, 'active');
  assert.deepEqual([...edges.values()], [
    { namespace: 'curated', type: SUPERSEDES_RELATIONSHIP, fromId: ID.ruleV2, toId: ID.rule },
  ]);
});

test('applyChangeOperations reports a SUPERSEDE of a missing node, and does not lose the edge', () => {
  const { nodes: out, edges, failures } = applyChangeOperations(new Map(), new Map(), [
    {
      op: 'SUPERSEDE',
      target: 'node',
      namespace: 'curated',
      supersededId: ID.rule,
      type: 'Rule',
      id: ID.ruleV2,
      properties: { id: ID.ruleV2, status: 'active' },
    },
  ]);
  assert.deepEqual(failures, [
    { index: 0, op: 'SUPERSEDE', target: 'node', reason: `superseded node '${ID.rule}' does not exist` },
  ]);
  assert.equal(out.get(canonicalize(['curated', ID.ruleV2])).type, 'Rule');
  assert.deepEqual([...edges.values()], [
    { namespace: 'curated', type: SUPERSEDES_RELATIONSHIP, fromId: ID.ruleV2, toId: ID.rule },
  ]);
});

test('replayChain accumulates the materialized graph in a loop, not a spread, at fixture scale (E2)', async () => {
  // E2's replay measurement runs at the full E1 scale (150k curated edges). The materialized read
  // must accumulate with a plain loop: `edges.push(...listEdges(...))` spreads a 149k-element
  // argument list, which blows the call stack (the same defect E1 amended in validate-graph.mjs
  // readGraph). The whole fixture is applied as ONE revision so the replay is green end to end.
  const fixture = generateFixture('replay-accumulation');
  assert.equal(fixture.stats.totalEdges, FIXTURE_TARGET_EDGES);
  assert.ok(fixture.stats.totalEdges > 125_000, 'the scale must exceed the engine spread-argument limit');

  const operations = [
    ...fixture.nodes.map((node) => ({ op: 'ADD', target: 'node', namespace: node.namespace, type: node.type, id: node.id, properties: node.properties })),
    ...fixture.edges.map((edge) => ({ op: 'ADD', target: 'edge', namespace: edge.namespace, type: edge.type, fromId: edge.fromId, toId: edge.toId })),
  ];

  const port = createMemoryPort();
  const applied = await applyChangeSet(
    port,
    { operations },
    {
      projectId: fixture.projectId,
      proposer: { type: 'agent-proposer', id: 'e2-writer' },
      approver: { type: 'human-approver', id: 'e2-approver' },
      provenance: [{ quotation: 'E2 replay accumulation.', source: 'tests/formula-revision.test.mjs:1618', digest: sha256Hex('replay') }],
      timestamp: '2026-08-12T10:00:00.000Z',
    },
  );
  assert.equal(applied.ok, true, JSON.stringify(applied.violations[0] ?? null));

  const replayed = await replayChain(port, { projectId: fixture.projectId });
  assert.equal(replayed.ok, true, replayed.violations.map((v) => v.code).join(','));
  assert.deepEqual(replayed.violations, []);
  assert.deepEqual(replayed.unexplained, { nodes: [], edges: [] });
  assert.deepEqual(replayed.missing, { nodes: [], edges: [] });
});
