// Portable graph validator suite (Task B4). Every case drives `validateGraph` through a REAL
// port adapter (the B3 in-memory reference) rather than a hand-built graph object, because the
// validator's contract is "runs identically on any port adapter" (spec §20): a test that fed it
// plain arrays would not exercise the port reads at all.
//
// Fixture shape: `baseGraph()` returns a valid, minimal, spec-shaped graph. Each test clones it,
// plants exactly one fault, and asserts the resulting violation/warning — so a failure names the
// invariant that broke, not a wall of unrelated noise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { withTransaction } from '../scripts/formula/engine/port.mjs';
import {
  EXTENSION_NAMESPACE_PREFIX,
  GRAPH_SCHEMA_VERSION,
  RELATIONSHIP_TYPE_NAMES,
} from '../scripts/formula/core/ontology.mjs';
import {
  validateGraph,
  checkGraphState,
  GRAPH_VIOLATION_CODES,
  GRAPH_WARNING_CODES,
  ANCHOR_DIRECTIONS,
  ACYCLIC_RELATIONSHIPS,
  SYSTEM_RECORD_TYPE,
  SCENARIO_META_TYPE,
  DEFAULT_MAX_BODY_LENGTH,
  DEFAULT_BUDGET_NEAR_RATIO,
  systemRecordId,
  scenarioMetaId,
  overridesClosure,
  resolveOverrideGroup,
  APPLICABLE_RULE_STATUSES,
} from '../scripts/formula/core/validate-graph.mjs';

const PROJECT = 'proj';
const HEAD_REVISION = 'apex:proj:revision:r1';

// Spec §6-shaped qualified ids for the fixture, one per ontology node type.
const ID = {
  project: 'apex:proj:project:root',
  surface: 'apex:proj:surface:scripts',
  component: 'apex:proj:component:engine',
  rule: 'apex:proj:rule:sanitize-external-input',
  check: 'apex:proj:check:surface-test',
  decision: 'apex:proj:decision:graph-db-is-canonical',
  term: 'apex:proj:term:surface',
  agent: 'apex:proj:agent:scripts-agent',
  skill: 'apex:proj:skill:graph-migrate',
  repository: 'apex:proj:repository:root',
  workspace: 'apex:proj:workspace:root',
  package: 'apex:proj:package:engine',
};

function curatedNode(type, id, properties = {}) {
  return { type, id, properties: { id, status: 'active', ...properties } };
}

function ruleNode(id, overrides = {}) {
  return {
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
      provenance: { source: 'spec', line: 52 },
      ...overrides,
    },
  };
}

// A valid graph: the curated skeleton (Project <- Surface <- Component), one Rule with scope,
// verification and rationale, plus the observed topology chain in its own namespace.
//
// The topology chain carries a REAL cross-namespace `IMPLEMENTS` edge to the curated Component
// (port.mjs `BRIDGE_RELATIONSHIPS`, controller decision 2026-08-12): it lives in `topology`, the
// relationship's home namespace, and its target is a curated node. The other bridge —
// `APPLIES_TO` Rule -> Package, home `curated` — is exercised by the scope cases below.
function baseGraph() {
  return {
    system: { schemaVersion: GRAPH_SCHEMA_VERSION, headRevision: HEAD_REVISION },
    curated: {
      nodes: [
        curatedNode('Project', ID.project),
        curatedNode('Surface', ID.surface),
        curatedNode('Component', ID.component),
        curatedNode('Agent', ID.agent),
        curatedNode('Check', ID.check),
        curatedNode('Decision', ID.decision),
        curatedNode('Term', ID.term),
        curatedNode('Skill', ID.skill),
        ruleNode(ID.rule),
      ],
      edges: [
        { type: 'PART_OF', fromId: ID.surface, toId: ID.project },
        { type: 'PART_OF', fromId: ID.component, toId: ID.surface },
        { type: 'OWNED_BY', fromId: ID.surface, toId: ID.agent },
        { type: 'APPLIES_TO', fromId: ID.rule, toId: ID.surface },
        { type: 'VERIFIED_BY', fromId: ID.rule, toId: ID.check },
        { type: 'MOTIVATED_BY', fromId: ID.rule, toId: ID.decision },
        { type: 'USED_BY', fromId: ID.term, toId: ID.surface },
        { type: 'APPLIES_TO', fromId: ID.skill, toId: ID.surface },
      ],
    },
    topology: {
      nodes: [
        { type: 'Repository', id: ID.repository, properties: { id: ID.repository, root: 'demo', digest: 'd'.repeat(64) } },
        { type: 'Workspace', id: ID.workspace, properties: { id: ID.workspace, path: '.' } },
        { type: 'Package', id: ID.package, properties: { id: ID.package, path: 'packages/engine' } },
      ],
      edges: [
        { type: 'PART_OF', fromId: ID.workspace, toId: ID.repository },
        { type: 'PART_OF', fromId: ID.package, toId: ID.workspace },
        { type: 'IMPLEMENTS', fromId: ID.package, toId: ID.component },
      ],
    },
    scenarios: {},
  };
}

// Nodes of BOTH stable namespaces before any edge: a bridge edge's two endpoints live in two
// namespaces, so an edge-after-its-own-namespace seeding order could not create one.
async function seedGraph(port, graph) {
  await withTransaction(port, async (tx) => {
    if (graph.system) {
      await tx.createNode({
        namespace: 'system',
        type: graph.systemRecordType ?? SYSTEM_RECORD_TYPE,
        id: systemRecordId(PROJECT),
        properties: graph.system,
      });
    }
    for (const namespace of ['curated', 'topology']) {
      for (const node of (graph[namespace] ?? { nodes: [] }).nodes) await tx.createNode({ namespace, ...node });
    }
    for (const namespace of ['curated', 'topology']) {
      for (const edge of (graph[namespace] ?? { edges: [] }).edges) await tx.createEdge({ namespace, ...edge });
    }
    for (const [scenarioId, part] of Object.entries(graph.scenarios ?? {})) {
      for (const node of part.nodes ?? []) await tx.createNode({ namespace: 'scenario', scenarioId, ...node });
      for (const edge of part.edges ?? []) await tx.createEdge({ namespace: 'scenario', scenarioId, ...edge });
    }
  });
}

async function withGraph(graph, fn) {
  const port = createMemoryPort();
  await seedGraph(port, graph);
  try {
    return await fn(port);
  } finally {
    await port.close();
  }
}

// Seeds `graph` into a fresh memory port and validates it.
function validate(graph, input = {}) {
  return withGraph(graph, (port) => validateGraph(port, { projectId: PROJECT, ...input }));
}

function codesOf(items) {
  return items.map((item) => item.code);
}

// --- module contract -------------------------------------------------------------------------

test('a well-formed graph validates clean: no violations, no warnings', async () => {
  const result = await validate(baseGraph());
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.ok, true);
});

test('validateGraph throws (programmer error) when the port is missing or not a port', async () => {
  await assert.rejects(() => validateGraph(undefined, { projectId: PROJECT }), TypeError);
  await assert.rejects(() => validateGraph({}, { projectId: PROJECT }), TypeError);
});

test('validateGraph throws (programmer error) on a missing or malformed projectId', async () => {
  const port = createMemoryPort();
  try {
    await assert.rejects(() => validateGraph(port, {}), TypeError);
    await assert.rejects(() => validateGraph(port, { projectId: 'Not A Project' }), TypeError);
  } finally {
    await port.close();
  }
});

test('validateGraph throws on an unknown input or option key — a typo never silently disables a check', async () => {
  const port = createMemoryPort();
  try {
    await assert.rejects(() => validateGraph(port, { projectId: PROJECT, scenarioID: 's1' }), TypeError);
    await assert.rejects(
      () => validateGraph(port, { projectId: PROJECT, options: { maxBodyLenght: 10 } }),
      TypeError,
    );
  } finally {
    await port.close();
  }
});

test('graph content never throws: a wildly malformed node yields violations, not an exception', async () => {
  const graph = baseGraph();
  graph.curated.nodes.push({ type: 'Nonsense', id: 'not-a-qualified-id', properties: { weird: [1, 2] } });
  const result = await validate(graph);
  assert.equal(result.ok, false);
  assert.ok(result.violations.length > 0);
  assert.ok(codesOf(result.violations).every((code) => typeof code === 'string'));
});

// --- blocking: duplicate qualified ID ----------------------------------------------------------

test('blocking: the same qualified ID in two namespaces is a duplicate identity', async () => {
  const graph = baseGraph();
  // The port keeps namespaces disjoint and allows the same id in both, so only the validator can
  // see this collision.
  graph.topology.nodes.push({ type: 'Package', id: ID.component, properties: { id: ID.component } });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'DUPLICATE_QUALIFIED_ID');
  assert.equal(found.length, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(found[0].identity, { id: ID.component, namespaces: ['curated', 'topology'] });
  assert.match(found[0].message, /identifies exactly one node/);
});

// --- blocking: malformed identity (B2 passthrough) ---------------------------------------------

test('blocking: a node ID that is not a qualified ID is reported with the node identity', async () => {
  const graph = baseGraph();
  graph.curated.nodes.push({ type: 'Check', id: 'check:no-project', properties: { id: 'check:no-project', status: 'active' } });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'MALFORMED_QUALIFIED_ID');
  assert.equal(found.length, 1);
  assert.equal(found[0].identity.id, 'check:no-project');
  assert.equal(found[0].identity.namespace, 'curated');
  assert.equal(found[0].identity.type, 'Check');
});

// --- blocking: missing or malformed required properties (B1 passthrough) -----------------------

test('blocking: a Rule missing a required property is reported per property with its node identity', async () => {
  const graph = baseGraph();
  const rule = ruleNode('apex:proj:rule:no-statement', { concern: 'documentation' });
  delete rule.properties.statement;
  graph.curated.nodes.push(rule);
  graph.curated.edges.push({ type: 'APPLIES_TO', fromId: rule.id, toId: ID.surface });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'MISSING_REQUIRED_PROPERTY');
  assert.equal(found.length, 1);
  assert.equal(found[0].identity.id, rule.id);
  assert.equal(found[0].identity.property, 'statement');
});

test('blocking: a malformed enum value on a required property is reported', async () => {
  const graph = baseGraph();
  const rule = ruleNode('apex:proj:rule:bad-strength', { strength: 'maybe', concern: 'strength-domain' });
  graph.curated.nodes.push(rule);
  graph.curated.edges.push({ type: 'APPLIES_TO', fromId: rule.id, toId: ID.component });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'INVALID_PROPERTY_VALUE');
  assert.equal(found.length, 1);
  assert.equal(found[0].identity.id, rule.id);
  assert.equal(found[0].identity.property, 'strength');
});

// --- blocking: unknown node type ----------------------------------------------------------------

test('blocking: an unknown node type is rejected by the closed schema', async () => {
  const graph = baseGraph();
  graph.curated.nodes.push({ type: 'Policy', id: 'apex:proj:policy:x', properties: { id: 'apex:proj:policy:x' } });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'UNKNOWN_NODE_TYPE');
  assert.equal(found.length, 1);
  assert.equal(found[0].identity.id, 'apex:proj:policy:x');
  assert.equal(found[0].identity.type, 'Policy');
});

// --- blocking: unknown property outside the versioned extension namespace ----------------------

test('blocking: an unknown property outside the extension namespace is rejected', async () => {
  const graph = baseGraph();
  const rule = ruleNode('apex:proj:rule:extra-prop', { severity: 'high', concern: 'logging' });
  graph.curated.nodes.push(rule);
  graph.curated.edges.push({ type: 'APPLIES_TO', fromId: rule.id, toId: ID.surface });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'UNKNOWN_PROPERTY');
  assert.equal(found.length, 1);
  assert.equal(found[0].identity.property, 'severity');
  assert.equal(found[0].identity.id, rule.id);
});

test('a property inside the versioned extension namespace is accepted without interpretation', async () => {
  const graph = baseGraph();
  const rule = ruleNode('apex:proj:rule:embedded', {
    [`${EXTENSION_NAMESPACE_PREFIX}embedding`]: [0.1, 0.2],
    concern: 'retrieval',
  });
  graph.curated.nodes.push(rule);
  graph.curated.edges.push({ type: 'APPLIES_TO', fromId: rule.id, toId: ID.surface });
  const result = await validate(graph);
  assert.deepEqual(result.violations, []);
});

// --- blocking: broken relationship endpoint -----------------------------------------------------

// The port refuses to CREATE an edge whose endpoints are missing, so a dangling endpoint can only
// arrive from outside it: a lossy import, a schema migration, or an out-of-band write on an engine
// whose native constraints are absent (§20 says native enforcement is additive, never assumed).
// This read-through adapter reproduces exactly that — the graph is built through the real port, and
// one node then disappears from the reads while its edges survive.
function portWithNodeHidden(port, hiddenId) {
  return {
    capabilities: () => port.capabilities(),
    close: () => port.close(),
    async begin() {
      const tx = await port.begin();
      return {
        ...tx,
        async listNodes(input) {
          const nodes = await tx.listNodes(input);
          return nodes.filter((node) => node.id !== hiddenId);
        },
      };
    },
  };
}

test('blocking: a relationship endpoint that no node answers to is reported with both endpoint ids', async () => {
  await withGraph(baseGraph(), async (port) => {
    const result = await validateGraph(portWithNodeHidden(port, ID.check), { projectId: PROJECT });
    const found = result.violations.filter((v) => v.code === 'BROKEN_RELATIONSHIP_ENDPOINT');
    assert.equal(result.ok, false);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].identity, {
      relationship: 'VERIFIED_BY',
      fromId: ID.rule,
      toId: ID.check,
      endpoint: 'toId',
      missingId: ID.check,
      namespace: 'curated',
    });
  });
});

// --- blocking: unknown relationship type --------------------------------------------------------

test('blocking: an unknown relationship type is rejected by the closed schema', async () => {
  const graph = baseGraph();
  graph.curated.edges.push({ type: 'RELATES_TO', fromId: ID.rule, toId: ID.decision });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'UNKNOWN_RELATIONSHIP_TYPE');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, {
    relationship: 'RELATES_TO',
    fromId: ID.rule,
    toId: ID.decision,
    namespace: 'curated',
  });
});

// --- blocking: invalid relationship source or target type ---------------------------------------

test('blocking: a relationship between a source/target pair the ontology forbids is rejected', async () => {
  const graph = baseGraph();
  graph.curated.edges.push({ type: 'PART_OF', fromId: ID.rule, toId: ID.surface });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'INVALID_RELATIONSHIP_ENDPOINTS');
  assert.equal(found.length, 1);
  assert.equal(found[0].identity.fromType, 'Rule');
  assert.equal(found[0].identity.toType, 'Surface');
  assert.equal(found[0].identity.fromId, ID.rule);
  assert.equal(found[0].identity.toId, ID.surface);
});

test('an endpoint of unknown node type is reported once, on the node — never a second time per edge', async () => {
  const graph = baseGraph();
  graph.curated.nodes.push({ type: 'Policy', id: 'apex:proj:policy:x', properties: { id: 'apex:proj:policy:x' } });
  graph.curated.edges.push({ type: 'PART_OF', fromId: 'apex:proj:policy:x', toId: ID.surface });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'UNKNOWN_NODE_TYPE');
  assert.equal(found.length, 1);
  assert.equal(found[0].identity.id, 'apex:proj:policy:x');
});

// --- blocking: cycles in PART_OF / OVERRIDES / SUPERSEDES (spec §7) -----------------------------

test('blocking: a PART_OF cycle is reported once, as a canonically ordered ring', async () => {
  const graph = baseGraph();
  graph.curated.edges.push({ type: 'PART_OF', fromId: ID.surface, toId: ID.component });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'RELATIONSHIP_CYCLE');
  assert.equal(result.ok, false);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, { relationship: 'PART_OF', cycle: [ID.component, ID.surface] });
  assert.match(found[0].message, /PART_OF/);
});

test('blocking: an OVERRIDES cycle between two Rules is reported', async () => {
  const graph = baseGraph();
  const first = ruleNode('apex:proj:rule:a', { concern: 'cycle-a' });
  const second = ruleNode('apex:proj:rule:b', { concern: 'cycle-b' });
  graph.curated.nodes.push(first, second);
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: first.id, toId: ID.surface },
    { type: 'APPLIES_TO', fromId: second.id, toId: ID.surface },
    { type: 'OVERRIDES', fromId: first.id, toId: second.id },
    { type: 'OVERRIDES', fromId: second.id, toId: first.id },
  );
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'RELATIONSHIP_CYCLE');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, { relationship: 'OVERRIDES', cycle: [first.id, second.id] });
});

test('blocking: a SUPERSEDES cycle between two Rules is reported', async () => {
  const graph = baseGraph();
  const first = ruleNode('apex:proj:rule:a', { concern: 'cycle-a', status: 'superseded' });
  const second = ruleNode('apex:proj:rule:b', { concern: 'cycle-b', status: 'superseded' });
  graph.curated.nodes.push(first, second);
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: first.id, toId: ID.surface },
    { type: 'APPLIES_TO', fromId: second.id, toId: ID.surface },
    { type: 'SUPERSEDES', fromId: first.id, toId: second.id },
    { type: 'SUPERSEDES', fromId: second.id, toId: first.id },
  );
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'RELATIONSHIP_CYCLE');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, { relationship: 'SUPERSEDES', cycle: [first.id, second.id] });
});

test('blocking: a node that supersedes itself is a one-node cycle', async () => {
  const graph = baseGraph();
  graph.curated.edges.push({ type: 'SUPERSEDES', fromId: ID.rule, toId: ID.rule });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'RELATIONSHIP_CYCLE');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, { relationship: 'SUPERSEDES', cycle: [ID.rule] });
});

test('a legal SUPERSEDES chain (no cycle) stays clean', async () => {
  const graph = baseGraph();
  const older = ruleNode('apex:proj:rule:older', { status: 'superseded', concern: 'external-input' });
  graph.curated.nodes.push(older);
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: older.id, toId: ID.surface },
    { type: 'SUPERSEDES', fromId: ID.rule, toId: older.id },
  );
  const result = await validate(graph);
  assert.deepEqual(result.violations, []);
});

// --- blocking: active Rule missing concern / strength / APPLIES_TO ------------------------------

test('blocking: an active Rule with no APPLIES_TO relationship has no scope', async () => {
  const graph = baseGraph();
  const rule = ruleNode('apex:proj:rule:unscoped', { concern: 'logging' });
  graph.curated.nodes.push(rule);
  // Anchored to the skeleton so this case isolates the missing SCOPE, not reachability.
  graph.curated.edges.push({ type: 'SUPERSEDES', fromId: ID.rule, toId: rule.id });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'ACTIVE_RULE_WITHOUT_SCOPE');
  assert.equal(result.ok, false);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, { id: rule.id, type: 'Rule', namespace: 'curated', status: 'active' });
});

test('blocking: an active Rule missing concern or strength is caught by the closed schema (B1)', async () => {
  const graph = baseGraph();
  const rule = ruleNode('apex:proj:rule:no-concern');
  delete rule.properties.concern;
  delete rule.properties.strength;
  graph.curated.nodes.push(rule);
  graph.curated.edges.push({ type: 'APPLIES_TO', fromId: rule.id, toId: ID.component });
  const result = await validate(graph);
  const missing = result.violations
    .filter((v) => v.code === 'MISSING_REQUIRED_PROPERTY' && v.identity.id === rule.id)
    .map((v) => v.identity.property);
  assert.deepEqual(missing.sort(), ['concern', 'strength']);
});

test('a deprecated Rule without APPLIES_TO is not held to the active-Rule scope invariant', async () => {
  const graph = baseGraph();
  const rule = ruleNode('apex:proj:rule:retired', { status: 'deprecated', concern: 'logging' });
  graph.curated.nodes.push(rule);
  graph.curated.edges.push({ type: 'SUPERSEDES', fromId: ID.rule, toId: rule.id });
  const result = await validate(graph);
  assert.deepEqual(codesOf(result.violations), []);
});

// --- blocking: unresolved conflict among applicable active/deprecated Rules (spec §7) ------------

// Two Rules sharing a concern and a scope target, with no explicit OVERRIDES between them.
function graphWithConflict(overrides = {}) {
  const graph = baseGraph();
  const first = ruleNode('apex:proj:rule:tabs', { concern: 'indentation', ...overrides.first });
  const second = ruleNode('apex:proj:rule:spaces', { concern: 'indentation', ...overrides.second });
  graph.curated.nodes.push(first, second);
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: first.id, toId: overrides.firstTarget ?? ID.surface },
    { type: 'APPLIES_TO', fromId: second.id, toId: overrides.secondTarget ?? ID.surface },
  );
  return { graph, first, second };
}

test('blocking: two applicable Rules sharing a concern with no OVERRIDES is an unresolved conflict', async () => {
  const { graph, first, second } = graphWithConflict();
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'UNRESOLVED_RULE_CONFLICT');
  assert.equal(result.ok, false);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, {
    concern: 'indentation',
    ruleIds: [second.id, first.id].sort(),
    targets: [ID.surface],
  });
  assert.match(found[0].message, /indentation/);
});

test('a valid explicit OVERRIDES resolves the conflict (spec §7)', async () => {
  const { graph, first, second } = graphWithConflict();
  graph.curated.edges.push({ type: 'OVERRIDES', fromId: first.id, toId: second.id });
  const result = await validate(graph);
  assert.deepEqual(result.violations, []);
});

// ONE new Rule superseding SEVERAL older same-concern ones is ordinary authoring, and the losers
// have no OVERRIDES between THEM — nor should they need one. A pair-at-a-time gate reports that
// loser pair as unresolved and BLOCKS a graph the product is supposed to accept, which is why
// resolution is settled over the group (`resolveOverrideGroup`) before any pair is judged.
test('one winner overriding SEVERAL same-concern Rules resolves them all — losers never conflict with each other', async () => {
  const { graph, first, second } = graphWithConflict();
  const winner = ruleNode('apex:proj:rule:winner', { concern: 'indentation' });
  graph.curated.nodes.push(winner);
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: winner.id, toId: ID.surface },
    { type: 'OVERRIDES', fromId: winner.id, toId: first.id },
    { type: 'OVERRIDES', fromId: winner.id, toId: second.id },
  );
  const result = await validate(graph);
  assert.deepEqual(result.violations, []);
});

// The contest is settled PER TARGET: an OVERRIDES only resolves a clash where the winner itself
// applies. Here the winner beats `first` on the surface it shares with it, but `second` clashes with
// `first` on a DIFFERENT target the winner never touches — that conflict is still unresolved.
test('an OVERRIDES does not excuse a clash on a target the winner does not apply to', async () => {
  const { graph, first, second } = graphWithConflict({ secondTarget: ID.component });
  const winner = ruleNode('apex:proj:rule:winner', { concern: 'indentation' });
  graph.curated.nodes.push(winner);
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: first.id, toId: ID.component },
    { type: 'APPLIES_TO', fromId: winner.id, toId: ID.surface },
    { type: 'OVERRIDES', fromId: winner.id, toId: first.id },
  );
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'UNRESOLVED_RULE_CONFLICT');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, {
    concern: 'indentation',
    ruleIds: [first.id, second.id].sort(),
    targets: [ID.component],
  });
});

// A pair clashing in several places is ONE violation listing every shared target, not one per
// target — the report is about the pair, and the targets are where to look.
test('a pair overlapping on several targets is reported once, with all of them', async () => {
  const { graph, first, second } = graphWithConflict();
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: first.id, toId: ID.component },
    { type: 'APPLIES_TO', fromId: second.id, toId: ID.component },
  );
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'UNRESOLVED_RULE_CONFLICT');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity.targets, [ID.component, ID.surface].sort());
});

test('a transitive OVERRIDES path resolves the conflict between its ends', async () => {
  const { graph, first, second } = graphWithConflict();
  const middle = ruleNode('apex:proj:rule:middle', { concern: 'indentation' });
  graph.curated.nodes.push(middle);
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: middle.id, toId: ID.surface },
    { type: 'OVERRIDES', fromId: first.id, toId: middle.id },
    { type: 'OVERRIDES', fromId: middle.id, toId: second.id },
  );
  const result = await validate(graph);
  assert.deepEqual(result.violations, []);
});

test('a transitive OVERRIDES path through a DEPRECATED Rule resolves the conflict — it is still applicable', async () => {
  const { graph, first, second } = graphWithConflict();
  const middle = ruleNode('apex:proj:rule:middle', { concern: 'indentation', status: 'deprecated' });
  graph.curated.nodes.push(middle);
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: middle.id, toId: ID.surface },
    { type: 'OVERRIDES', fromId: first.id, toId: middle.id },
    { type: 'OVERRIDES', fromId: middle.id, toId: second.id },
  );
  const result = await validate(graph);
  assert.deepEqual(result.violations, []);
});

test('a SUPERSEDED Rule cannot carry a resolution: an OVERRIDES path routed through one leaves the conflict unresolved', async () => {
  const { graph, first, second } = graphWithConflict();
  // Retired intermediary: excluded from operational context (spec §6), so D2 would still collect
  // `first` and `second` together and raise RULE_CONFLICT. The blocking gate must say so first.
  const retired = ruleNode('apex:proj:rule:retired-middle', { concern: 'indentation', status: 'superseded' });
  graph.curated.nodes.push(retired);
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: retired.id, toId: ID.surface },
    { type: 'OVERRIDES', fromId: first.id, toId: retired.id },
    { type: 'OVERRIDES', fromId: retired.id, toId: second.id },
  );
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'UNRESOLVED_RULE_CONFLICT');
  assert.equal(result.ok, false);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, {
    concern: 'indentation',
    ruleIds: [first.id, second.id].sort(),
    targets: [ID.surface],
  });
});

test('Rules sharing a concern under non-overlapping scopes do not conflict', async () => {
  const { graph } = graphWithConflict({ secondTarget: ID.component });
  const result = await validate(graph);
  assert.deepEqual(result.violations, []);
});

test('a superseded Rule never conflicts — it is out of operational context (spec §6)', async () => {
  const { graph } = graphWithConflict({ second: { status: 'superseded' } });
  const result = await validate(graph);
  assert.deepEqual(result.violations, []);
});

test('a deprecated Rule still conflicts — it is still served, with a warning (spec §6)', async () => {
  const { graph } = graphWithConflict({ second: { status: 'deprecated' } });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'UNRESOLVED_RULE_CONFLICT');
  assert.equal(found.length, 1);
});

// `overridesClosure` is this module's conflict-resolution rule, exported additively for D2's
// resolution-time gate (spec §8): D2 collects Rules ACROSS hierarchy levels, so it assembles
// conflicting pairs this whole-graph check does not (it judges shared APPLIES_TO targets only), and
// it must resolve them by exactly the same rule rather than a second implementation of it.
test('APPLICABLE_RULE_STATUSES is the lifecycle set that still enters operational context (spec §6)', () => {
  assert.deepEqual([...APPLICABLE_RULE_STATUSES], ['active', 'deprecated']);
});

test('overridesClosure: transitive resolution, restricted to the applicable Rules it is given', () => {
  const edges = [
    { type: 'OVERRIDES', fromId: 'a', toId: 'b' },
    { type: 'OVERRIDES', fromId: 'b', toId: 'c' },
    { type: 'OVERRIDES', fromId: 'c', toId: 'd' },
    { type: 'APPLIES_TO', fromId: 'a', toId: 'surface' },
  ];
  const overridden = overridesClosure(['a', 'b', 'c'], edges);
  assert.deepEqual([...overridden('a')].sort(), ['b', 'c']);
  assert.deepEqual([...overridden('b')].sort(), ['c']);
  assert.deepEqual([...overridden('c')].sort(), [], 'a non-applicable endpoint carries no adjacency');
  assert.deepEqual([...overridden('never-heard-of-it')].sort(), []);
});

// `resolveOverrideGroup` is the second half of the same rule, and it is now load-bearing in TWO
// modules (B4 per shared target, D2 per resolution scope) — so it is pinned directly, not only
// through its callers.
test('resolveOverrideGroup: one winner over several losers leaves exactly one survivor', () => {
  const overridden = overridesClosure(['w', 'x', 'y', 'z'], [
    { type: 'OVERRIDES', fromId: 'w', toId: 'x' },
    { type: 'OVERRIDES', fromId: 'w', toId: 'y' },
    { type: 'OVERRIDES', fromId: 'w', toId: 'z' },
  ]);
  const { survivors, losers } = resolveOverrideGroup(['z', 'w', 'y', 'x'], overridden);
  assert.deepEqual(survivors, ['w'], 'the losers must not conflict with each other');
  assert.deepEqual([...losers.entries()].sort(), [['x', 'w'], ['y', 'w'], ['z', 'w']]);
});

test('resolveOverrideGroup: a Rule beaten by several winners records the first in id order', () => {
  const overridden = overridesClosure(['a-win', 'b-win', 'loser'], [
    { type: 'OVERRIDES', fromId: 'b-win', toId: 'loser' },
    { type: 'OVERRIDES', fromId: 'a-win', toId: 'loser' },
  ]);
  // Fed in an order that would pick 'b-win' if insertion order decided it.
  const { survivors, losers } = resolveOverrideGroup(['b-win', 'loser', 'a-win'], overridden);
  assert.deepEqual(survivors, ['a-win', 'b-win']);
  assert.equal(losers.get('loser'), 'a-win');
});

test('resolveOverrideGroup: with nothing overriding anything, everyone survives and every pair is a conflict', () => {
  const overridden = overridesClosure(['a', 'b', 'c'], []);
  const { survivors, losers } = resolveOverrideGroup(['c', 'a', 'b'], overridden);
  assert.deepEqual(survivors, ['a', 'b', 'c'], 'sorted, so the report order does not depend on input order');
  assert.equal(losers.size, 0);
});

test('resolveOverrideGroup: a transitive chain leaves only the top, and duplicates in the input do not double-count', () => {
  const overridden = overridesClosure(['top', 'mid', 'low'], [
    { type: 'OVERRIDES', fromId: 'top', toId: 'mid' },
    { type: 'OVERRIDES', fromId: 'mid', toId: 'low' },
  ]);
  const { survivors, losers } = resolveOverrideGroup(['low', 'mid', 'top', 'low'], overridden);
  assert.deepEqual(survivors, ['top']);
  assert.deepEqual([...losers.entries()].sort(), [['low', 'mid'], ['mid', 'top']]);
});

test('overridesClosure terminates on an OVERRIDES cycle (blocking on its own, but it must not hang)', () => {
  const overridden = overridesClosure(new Set(['a', 'b']), [
    { type: 'OVERRIDES', fromId: 'a', toId: 'b' },
    { type: 'OVERRIDES', fromId: 'b', toId: 'a' },
  ]);
  assert.deepEqual([...overridden('a')].sort(), ['a', 'b']);
});

// --- blocking: curated node not semantically reachable from its Project root (spec §5) ----------

test('blocking: a curated node with no anchor to the Project root is unreachable', async () => {
  const graph = baseGraph();
  graph.curated.nodes.push(curatedNode('Check', 'apex:proj:check:orphan'));
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'UNREACHABLE_FROM_PROJECT_ROOT');
  assert.equal(result.ok, false);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, {
    id: 'apex:proj:check:orphan',
    type: 'Check',
    namespace: 'curated',
  });
});

test('blocking: curated nodes with no Project root at all report the missing root once, not one violation per node', async () => {
  const graph = baseGraph();
  graph.curated.nodes = graph.curated.nodes.filter((node) => node.type !== 'Project');
  graph.curated.edges = graph.curated.edges.filter((edge) => edge.toId !== ID.project);
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'PROJECT_ROOT_MISSING');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, { projectId: PROJECT });
  assert.deepEqual(result.violations.filter((v) => v.code === 'UNREACHABLE_FROM_PROJECT_ROOT'), []);
});

test('an empty curated graph has nothing to be unreachable', async () => {
  const graph = baseGraph();
  graph.curated = { nodes: [], edges: [] };
  graph.topology = { nodes: [], edges: [] };
  const result = await validate(graph);
  assert.deepEqual(result.violations, []);
});

test('reachability follows the canonical anchoring edges down the whole chain, across the bridge', async () => {
  const graph = baseGraph();
  // A topology Package that IMPLEMENTS a reachable curated Component, a curated Rule scoped to
  // that Package across the other bridge, and a superseded Rule whose only anchor is the
  // SUPERSEDES edge that retired it. Both bridges are real cross-namespace edges.
  const pkg = 'apex:proj:package:cli';
  const scoped = ruleNode('apex:proj:rule:package-scoped', { concern: 'packaging' });
  const retired = ruleNode('apex:proj:rule:retired', { status: 'superseded', concern: 'history' });
  graph.topology.nodes.push({ type: 'Package', id: pkg, properties: { id: pkg, path: 'packages/cli' } });
  graph.topology.edges.push(
    { type: 'PART_OF', fromId: pkg, toId: ID.workspace },
    { type: 'IMPLEMENTS', fromId: pkg, toId: ID.component },
  );
  graph.curated.nodes.push(scoped, retired);
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: scoped.id, toId: pkg },
    { type: 'SUPERSEDES', fromId: scoped.id, toId: retired.id },
  );
  const result = await validate(graph);
  assert.deepEqual(result.violations, []);
});

test('an active Rule scoped only across the bridge (to a Package) has a scope', async () => {
  const graph = baseGraph();
  const scoped = ruleNode('apex:proj:rule:package-only', { concern: 'packaging' });
  graph.curated.nodes.push(scoped);
  graph.curated.edges.push({ type: 'APPLIES_TO', fromId: scoped.id, toId: ID.package });
  const result = await validate(graph);
  assert.deepEqual(result.violations, []);
});

test('topology nodes are structurally validated but exempt from the reachability invariant', async () => {
  const graph = baseGraph();
  // Detached from every chain, and never connected to the Project root by construction.
  graph.topology.nodes.push({
    type: 'Package',
    id: 'apex:proj:package:detached',
    properties: { id: 'apex:proj:package:detached', path: 'packages/detached' },
  });
  const result = await validate(graph);
  assert.deepEqual(result.violations, []);
});

// --- bridge-edge endpoint resolution (controller decision 2026-08-12) ---------------------------

test('an edge resolves its endpoints in ITS namespace pair, not by bare id', async () => {
  // The same qualified id carried by a curated Component and a topology Package is blocking on its
  // own (DUPLICATE_QUALIFIED_ID). It must not ALSO be judged as the wrong endpoint type: the
  // topology PART_OF edge below names the Package in its own namespace, and PART_OF Package ->
  // Workspace is legal, while PART_OF Component -> Workspace would not be.
  const graph = baseGraph();
  graph.topology.nodes.push({
    type: 'Package',
    id: ID.surface,
    properties: { id: ID.surface, path: 'packages/twin' },
  });
  graph.topology.edges.push({ type: 'PART_OF', fromId: ID.surface, toId: ID.workspace });
  const result = await validate(graph);
  assert.deepEqual(
    result.violations.map((v) => v.code),
    ['DUPLICATE_QUALIFIED_ID'],
  );
});

test('a bridge edge resolves its far endpoint in the declared partner namespace, and is type-checked there', async () => {
  const graph = baseGraph();
  // IMPLEMENTS is Package -> Component. Pointing it at the curated Surface instead is an endpoint
  // pair the ontology refuses — and the validator can only say so because it resolved the target
  // across the bridge into `curated` in the first place.
  graph.topology.edges.push({ type: 'IMPLEMENTS', fromId: ID.package, toId: ID.surface });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'INVALID_RELATIONSHIP_ENDPOINTS');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, {
    relationship: 'IMPLEMENTS',
    fromType: 'Package',
    toType: 'Surface',
    fromId: ID.package,
    toId: ID.surface,
    namespace: 'topology',
  });
});

// --- blocking: cross-project relationship (spec §24) --------------------------------------------

test('blocking: a relationship whose endpoints belong to different projects is rejected', async () => {
  const graph = baseGraph();
  const foreign = 'apex:other:surface:scripts';
  graph.curated.nodes.push(curatedNode('Surface', foreign));
  graph.curated.edges.push({ type: 'APPLIES_TO', fromId: ID.rule, toId: foreign });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'CROSS_PROJECT_RELATIONSHIP');
  assert.equal(found.length, 1);
  assert.equal(found[0].identity.fromId, ID.rule);
  assert.equal(found[0].identity.toId, foreign);
  assert.equal(found[0].identity.fromProjectId, 'proj');
  assert.equal(found[0].identity.toProjectId, 'other');
});


// --- blocking: obsolete or unsupported graph schema version --------------------------------------

test('blocking: a graph with no system schema-version record is refused', async () => {
  const graph = baseGraph();
  graph.system = null;
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'SCHEMA_VERSION_MISSING');
  assert.equal(result.ok, false);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, { id: systemRecordId(PROJECT), namespace: 'system' });
});

test('blocking: a system record without a schemaVersion property is refused', async () => {
  const graph = baseGraph();
  graph.system = { headRevision: HEAD_REVISION };
  const result = await validate(graph);
  assert.deepEqual(codesOf(result.violations), ['SCHEMA_VERSION_MISSING']);
});

test('blocking: a schema version the ontology does not support is refused (spec §27 migration)', async () => {
  const graph = baseGraph();
  graph.system = { schemaVersion: GRAPH_SCHEMA_VERSION + 1, headRevision: HEAD_REVISION };
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'UNSUPPORTED_SCHEMA_VERSION');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, {
    id: systemRecordId(PROJECT),
    namespace: 'system',
    schemaVersion: GRAPH_SCHEMA_VERSION + 1,
    supportedVersion: GRAPH_SCHEMA_VERSION,
  });
});

// --- blocking: Promotion Scenario based on an incompatible graph revision (spec §11) -------------

function scenarioMeta(properties, type = SCENARIO_META_TYPE) {
  return { type, id: scenarioMetaId(PROJECT), properties };
}

test('a scenario based on the current head revision is compatible', async () => {
  const graph = baseGraph();
  graph.scenarios = { 's1': { nodes: [scenarioMeta({ baseRevision: HEAD_REVISION })] } };
  const result = await validate(graph, { scenarioIds: ['s1'] });
  assert.deepEqual(result.violations, []);
});

test('blocking: a scenario whose base revision is no longer the head cannot be applied safely', async () => {
  const graph = baseGraph();
  graph.scenarios = { 's1': { nodes: [scenarioMeta({ baseRevision: 'apex:proj:revision:r0' })] } };
  const result = await validate(graph, { scenarioIds: ['s1'] });
  const found = result.violations.filter((v) => v.code === 'SCENARIO_BASE_REVISION_INCOMPATIBLE');
  assert.equal(result.ok, false);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, {
    scenarioId: 's1',
    baseRevision: 'apex:proj:revision:r0',
    headRevision: HEAD_REVISION,
  });
});

test('blocking: a named scenario with no meta record, or none declaring baseRevision, is unanchored', async () => {
  const absent = await validate(baseGraph(), { scenarioIds: ['s1'] });
  assert.deepEqual(codesOf(absent.violations), ['SCENARIO_BASE_REVISION_MISSING']);
  assert.equal(absent.violations[0].identity.scenarioId, 's1');

  const graph = baseGraph();
  graph.scenarios = { 's1': { nodes: [scenarioMeta({ label: 'draft' })] } };
  const undeclared = await validate(graph, { scenarioIds: ['s1'] });
  assert.deepEqual(codesOf(undeclared.violations), ['SCENARIO_BASE_REVISION_MISSING']);
});

test('a scenario on a graph with no promotion yet declares baseRevision null and is compatible', async () => {
  const graph = baseGraph();
  graph.system = { schemaVersion: GRAPH_SCHEMA_VERSION, headRevision: null };
  graph.scenarios = { 's1': { nodes: [scenarioMeta({ baseRevision: null })] } };
  const result = await validate(graph, { scenarioIds: ['s1'] });
  assert.deepEqual(result.violations, []);
});

test('scenarios are checked only when named, and their content is not structurally validated here', async () => {
  const graph = baseGraph();
  graph.scenarios = {
    's1': {
      nodes: [
        scenarioMeta({ baseRevision: 'apex:proj:revision:stale' }),
        { type: 'Nonsense', id: 'apex:proj:rule:draft', properties: { nothing: 'valid' } },
      ],
    },
  };
  const result = await validate(graph);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});

// --- warnings ------------------------------------------------------------------------------------

test('warnings never block: ok stays true and violations stay empty', async () => {
  const graph = baseGraph();
  graph.curated.nodes = graph.curated.nodes.map((node) =>
    node.id === ID.check ? curatedNode('Check', ID.check, { status: 'deprecated' }) : node,
  );
  const result = await validate(graph);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
});

test('warning: a Package whose path selector currently matches nothing', async () => {
  const graph = baseGraph();
  const options = { packageSelectorMatchCounts: { [ID.package]: 0 } };
  const result = await validate(graph, { options });
  const found = result.warnings.filter((w) => w.code === 'PACKAGE_SELECTOR_MATCHES_NOTHING');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, {
    id: ID.package,
    type: 'Package',
    namespace: 'topology',
    matchCount: 0,
  });

  const matching = await validate(graph, { options: { packageSelectorMatchCounts: { [ID.package]: 3 } } });
  assert.deepEqual(matching.warnings, []);
  const unmeasured = await validate(graph);
  assert.deepEqual(unmeasured.warnings, []);
});

test('warning: a deprecated node with no replacement', async () => {
  const graph = baseGraph();
  graph.curated.nodes = graph.curated.nodes.map((node) =>
    node.id === ID.check ? curatedNode('Check', ID.check, { status: 'deprecated' }) : node,
  );
  const result = await validate(graph);
  const found = result.warnings.filter((w) => w.code === 'DEPRECATED_WITHOUT_REPLACEMENT');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, { id: ID.check, type: 'Check', namespace: 'curated' });

  // A SUPERSEDES edge pointing at it is the replacement, so the warning goes away.
  const replaced = baseGraph();
  replaced.curated.nodes = replaced.curated.nodes.map((node) =>
    node.id === ID.check ? curatedNode('Check', ID.check, { status: 'deprecated' }) : node,
  );
  replaced.curated.nodes.push(curatedNode('Check', 'apex:proj:check:new'));
  replaced.curated.edges.push(
    { type: 'VERIFIED_BY', fromId: ID.rule, toId: 'apex:proj:check:new' },
    { type: 'SUPERSEDES', fromId: 'apex:proj:check:new', toId: ID.check },
  );
  assert.deepEqual((await validate(replaced)).warnings, []);
});

test('warning: a `should` Rule with no Check', async () => {
  const graph = baseGraph();
  const rule = ruleNode('apex:proj:rule:prefer-small-files', { strength: 'should', concern: 'file-size' });
  graph.curated.nodes.push(rule);
  graph.curated.edges.push({ type: 'APPLIES_TO', fromId: rule.id, toId: ID.component });
  const result = await validate(graph);
  const found = result.warnings.filter((w) => w.code === 'SHOULD_RULE_WITHOUT_CHECK');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, { id: rule.id, type: 'Rule', namespace: 'curated' });

  const verified = baseGraph();
  const checked = ruleNode('apex:proj:rule:prefer-small-files', { strength: 'should', concern: 'file-size' });
  verified.curated.nodes.push(checked);
  verified.curated.edges.push(
    { type: 'APPLIES_TO', fromId: checked.id, toId: ID.component },
    { type: 'VERIFIED_BY', fromId: checked.id, toId: ID.check },
  );
  assert.deepEqual((await validate(verified)).warnings, []);
});

test('a superseded `should` Rule raises no missing-Check warning — it is out of operational context', async () => {
  const graph = baseGraph();
  const rule = ruleNode('apex:proj:rule:retired-guidance', {
    strength: 'should',
    status: 'superseded',
    concern: 'file-size',
  });
  graph.curated.nodes.push(rule);
  graph.curated.edges.push({ type: 'SUPERSEDES', fromId: ID.rule, toId: rule.id });
  assert.deepEqual((await validate(graph)).warnings, []);
});

test('warning: context close to the configured budget, measured by the caller', async () => {
  const graph = baseGraph();
  const result = await validate(graph, { options: { budget: { limit: 1000, used: 950 } } });
  const found = result.warnings.filter((w) => w.code === 'CONTEXT_NEAR_BUDGET');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, { limit: 1000, used: 950, nearRatio: DEFAULT_BUDGET_NEAR_RATIO });

  const roomy = await validate(graph, { options: { budget: { limit: 1000, used: 100 } } });
  assert.deepEqual(roomy.warnings, []);
  const unconfigured = await validate(graph);
  assert.deepEqual(unconfigured.warnings, []);
});

test('warning: an excessively large explanatory body', async () => {
  const graph = baseGraph();
  const long = ruleNode('apex:proj:rule:essay', {
    concern: 'prose',
    body: 'x'.repeat(DEFAULT_MAX_BODY_LENGTH + 1),
  });
  graph.curated.nodes.push(long);
  graph.curated.edges.push({ type: 'APPLIES_TO', fromId: long.id, toId: ID.component });
  const result = await validate(graph);
  const found = result.warnings.filter((w) => w.code === 'OVERSIZED_BODY');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, {
    id: long.id,
    type: 'Rule',
    namespace: 'curated',
    bodyLength: DEFAULT_MAX_BODY_LENGTH + 1,
    maxBodyLength: DEFAULT_MAX_BODY_LENGTH,
  });

  const shorter = baseGraph();
  const modest = ruleNode('apex:proj:rule:essay', { concern: 'prose', body: 'x'.repeat(20) });
  shorter.curated.nodes.push(modest);
  shorter.curated.edges.push({ type: 'APPLIES_TO', fromId: modest.id, toId: ID.component });
  assert.deepEqual((await validate(shorter)).warnings, []);
  // The threshold is configuration (D3 calibrates it), so a caller can tighten it.
  const tightened = await validate(shorter, { options: { maxBodyLength: 10 } });
  assert.deepEqual(codesOf(tightened.warnings), ['OVERSIZED_BODY']);
});

test('warning: the semantic near-duplicate code exists in the vocabulary, with detection deferred (§10)', async () => {
  assert.equal(GRAPH_WARNING_CODES.SEMANTIC_NEAR_DUPLICATE, 'SEMANTIC_NEAR_DUPLICATE');
  const graph = baseGraph();
  // Two Rules a semantic detector would flag: same title and statement, different ids and scopes.
  const twin = ruleNode('apex:proj:rule:sanitize-external-input-copy', { concern: 'external-input-copy' });
  graph.curated.nodes.push(twin);
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: twin.id, toId: ID.component },
    { type: 'VERIFIED_BY', fromId: twin.id, toId: ID.check },
  );
  const result = await validate(graph);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.violations, []);
});

// --- determinism and result shape ----------------------------------------------------------------

// One graph, several independent faults: an orphan node, a duplicate id, a conflict and a warning.
function messyGraph() {
  const graph = baseGraph();
  const tabs = ruleNode('apex:proj:rule:tabs', { concern: 'indentation' });
  const spaces = ruleNode('apex:proj:rule:spaces', { concern: 'indentation' });
  graph.curated.nodes.push(
    curatedNode('Check', 'apex:proj:check:orphan'),
    curatedNode('Decision', 'apex:proj:decision:orphan'),
    tabs,
    spaces,
  );
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: tabs.id, toId: ID.surface },
    { type: 'APPLIES_TO', fromId: spaces.id, toId: ID.surface },
    // Chosen so the two violations sort one way by edge (type) and the other by identity (fromId):
    // ALPHA_LINK is emitted first, ZETA_LINK sorts first. Only an identity comparator can tell them apart.
    { type: 'ALPHA_LINK', fromId: tabs.id, toId: spaces.id },
    { type: 'ZETA_LINK', fromId: spaces.id, toId: tabs.id },
  );
  // Two ids colliding across namespaces, so several violations share a code and their relative
  // order is a real property to pin — not an accident of a one-violation-per-code fixture.
  graph.topology.nodes.push(
    { type: 'Package', id: ID.component, properties: { id: ID.component } },
    { type: 'Package', id: ID.surface, properties: { id: ID.surface } },
  );
  return graph;
}

test('the same graph always produces byte-identical results, whatever order the adapter stored it in', async () => {
  const forwards = await validate(messyGraph());
  const reversed = messyGraph();
  reversed.curated.nodes.reverse();
  reversed.topology.nodes.reverse();
  // Edges are re-ordered too, as far as endpoint availability allows.
  reversed.curated.edges = [...reversed.curated.edges].reverse();
  const backwards = await validate(reversed);
  assert.equal(JSON.stringify(backwards), JSON.stringify(forwards));
});

test('results are sorted by code, then by identity', async () => {
  const result = await validate(messyGraph());
  const codes = codesOf(result.violations);
  assert.deepEqual([...codes].sort(), codes);
  assert.ok(codes.length > 3, `expected several violations, got ${codes.join(', ')}`);

  const conflicts = result.violations.filter((v) => v.code === 'UNRESOLVED_RULE_CONFLICT');
  assert.equal(conflicts.length, 1);
});

test('every violation and warning carries a code, a human message and an identity bag', async () => {
  const graph = messyGraph();
  const deprecated = ruleNode('apex:proj:rule:old', { status: 'deprecated', concern: 'legacy' });
  graph.curated.nodes.push(deprecated);
  graph.curated.edges.push({ type: 'APPLIES_TO', fromId: deprecated.id, toId: ID.component });
  const result = await validate(graph);
  assert.ok(result.warnings.length > 0);
  for (const item of [...result.violations, ...result.warnings]) {
    assert.deepEqual(Object.keys(item).sort(), ['code', 'identity', 'message']);
    assert.equal(typeof item.code, 'string');
    assert.ok(item.message.length > 0, `empty message for ${item.code}`);
    assert.equal(typeof item.identity, 'object');
    assert.ok(Object.keys(item.identity).length > 0, `empty identity for ${item.code}`);
  }
});

test('the exported code vocabularies are frozen and self-consistent', () => {
  for (const vocabulary of [GRAPH_VIOLATION_CODES, GRAPH_WARNING_CODES]) {
    assert.ok(Object.isFrozen(vocabulary));
    for (const [key, value] of Object.entries(vocabulary)) assert.equal(key, value);
  }
});

test('every B4-owned code the validator can raise is declared in a vocabulary', async () => {
  const declared = new Set([...Object.values(GRAPH_VIOLATION_CODES), ...Object.values(GRAPH_WARNING_CODES)]);
  // Codes B1/B2 own and this module only forwards.
  const forwarded = new Set([
    'UNKNOWN_NODE_TYPE',
    'MISSING_REQUIRED_PROPERTY',
    'UNKNOWN_PROPERTY',
    'INVALID_PROPERTY_VALUE',
    'INVALID_PROPERTIES_VALUE',
    'UNKNOWN_RELATIONSHIP_TYPE',
    'INVALID_RELATIONSHIP_ENDPOINTS',
    'MALFORMED_QUALIFIED_ID',
    'INVALID_PROJECT_ID',
    'INVALID_LOCAL_ID',
    'CROSS_PROJECT_RELATIONSHIP',
  ]);
  const result = await validate(messyGraph());
  for (const item of [...result.violations, ...result.warnings]) {
    assert.ok(declared.has(item.code) || forwarded.has(item.code), `undeclared code ${item.code}`);
  }
});

// --- options hardening ----------------------------------------------------------------------------

test('an explicitly undefined budget.nearRatio falls back to the default instead of silently disabling the warning', async () => {
  const result = await validate(baseGraph(), {
    options: { budget: { limit: 1000, used: 950, nearRatio: undefined } },
  });
  assert.deepEqual(codesOf(result.warnings), ['CONTEXT_NEAR_BUDGET']);
  assert.equal(result.warnings[0].identity.nearRatio, DEFAULT_BUDGET_NEAR_RATIO);
});

test('an unknown key inside options.budget throws rather than being dropped', async () => {
  const port = createMemoryPort();
  try {
    await assert.rejects(
      () => validateGraph(port, { projectId: PROJECT, options: { budget: { limit: 10, used: 1, warnAt: 0.5 } } }),
      TypeError,
    );
    await assert.rejects(
      () => validateGraph(port, { projectId: PROJECT, options: { budget: { limit: 0, used: 1 } } }),
      TypeError,
    );
  } finally {
    await port.close();
  }
});

test('with no readable head revision, a scenario is never judged against an invented one', async () => {
  const graph = baseGraph();
  graph.system = null;
  graph.scenarios = { 's1': { nodes: [scenarioMeta({ baseRevision: 'apex:proj:revision:r0' })] } };
  const result = await validate(graph, { scenarioIds: ['s1'] });
  assert.deepEqual(codesOf(result.violations), ['SCHEMA_VERSION_MISSING']);
});

// --- review follow-ups ----------------------------------------------------------------------------

test('every relationship the ontology declares has an explicit reachability decision', () => {
  // A relationship type added to B1 with no entry here would anchor nothing, and every node whose
  // only tie to the skeleton is that new edge would turn into a blocking UNREACHABLE false positive.
  // `in` is deliberate: an explicit `null` ("anchors nothing") counts as a decision, a gap does not.
  for (const relationship of RELATIONSHIP_TYPE_NAMES) {
    assert.ok(relationship in ANCHOR_DIRECTIONS, `${relationship} has no anchoring decision`);
  }
  for (const relationship of Object.keys(ANCHOR_DIRECTIONS)) {
    assert.ok(RELATIONSHIP_TYPE_NAMES.includes(relationship), `${relationship} is not an ontology relationship`);
  }
  for (const relationship of ACYCLIC_RELATIONSHIPS) {
    assert.ok(RELATIONSHIP_TYPE_NAMES.includes(relationship), `${relationship} is not an ontology relationship`);
  }
});

test('within one code, results are ordered by identity — not by the order the checks emitted them', async () => {
  const result = await validate(messyGraph());
  const unknown = result.violations.filter((v) => v.code === 'UNKNOWN_RELATIONSHIP_TYPE');
  assert.equal(unknown.length, 2);
  assert.deepEqual(
    unknown.map((v) => v.identity.relationship),
    ['ZETA_LINK', 'ALPHA_LINK'],
  );
  assert.deepEqual(
    unknown.map((v) => v.identity.fromId),
    ['apex:proj:rule:spaces', 'apex:proj:rule:tabs'],
  );
});

test('duplicate scenarioIds are collapsed: one scenario is judged once', async () => {
  const graph = baseGraph();
  graph.scenarios = { 's1': { nodes: [scenarioMeta({ baseRevision: 'apex:proj:revision:r0' })] } };
  const result = await validate(graph, { scenarioIds: ['s1', 's1', 's1'] });
  assert.deepEqual(codesOf(result.violations), ['SCENARIO_BASE_REVISION_INCOMPATIBLE']);
});

test('an unknown relationship type is reported even when an endpoint node type is unknown too', async () => {
  const graph = baseGraph();
  graph.curated.nodes.push({ type: 'Policy', id: 'apex:proj:policy:x', properties: { id: 'apex:proj:policy:x' } });
  graph.curated.edges.push({ type: 'GOVERNS', fromId: 'apex:proj:policy:x', toId: ID.surface });
  const result = await validate(graph);
  const found = result.violations.filter((v) => v.code === 'UNKNOWN_RELATIONSHIP_TYPE');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity, {
    relationship: 'GOVERNS',
    fromId: 'apex:proj:policy:x',
    toId: ID.surface,
    namespace: 'curated',
  });
  // The unknown node type stays reported exactly once, on the node itself.
  assert.equal(result.violations.filter((v) => v.code === 'UNKNOWN_NODE_TYPE').length, 1);
});

test('blocking: a system record of the wrong type does not satisfy the pinned contract', async () => {
  const graph = baseGraph();
  graph.systemRecordType = 'TotallyWrongType';
  const result = await validate(graph);
  assert.equal(result.ok, false);
  assert.deepEqual(codesOf(result.violations), ['INVALID_METADATA_RECORD_TYPE']);
  assert.deepEqual(result.violations[0].identity, {
    id: systemRecordId(PROJECT),
    namespace: 'system',
    type: 'TotallyWrongType',
    expectedType: SYSTEM_RECORD_TYPE,
  });
});

test('blocking: a scenario meta record of the wrong type does not satisfy the pinned contract', async () => {
  const graph = baseGraph();
  graph.scenarios = { 's1': { nodes: [scenarioMeta({ baseRevision: HEAD_REVISION }, 'Draft')] } };
  const result = await validate(graph, { scenarioIds: ['s1'] });
  assert.deepEqual(codesOf(result.violations), ['INVALID_METADATA_RECORD_TYPE']);
  assert.deepEqual(result.violations[0].identity, {
    scenarioId: 's1',
    id: scenarioMetaId(PROJECT),
    namespace: 'scenario',
    type: 'Draft',
    expectedType: SCENARIO_META_TYPE,
  });
});

// --- pure invariant checks over an in-memory graph (D4 additive export) ----------------------------
//
// `checkGraphState` is exactly the block `validateGraph` runs after its one-transaction read, exported
// so a caller holding graph state it did NOT read from the port — D4's promotion projection, base
// graph + candidate ops applied in memory — is judged by the same machinery, never a second copy.

function stableRecords(graph) {
  const nodes = [
    ...graph.curated.nodes.map((node) => ({ namespace: 'curated', ...node })),
    ...graph.topology.nodes.map((node) => ({ namespace: 'topology', ...node })),
  ];
  const edges = [
    ...graph.curated.edges.map((edge) => ({ namespace: 'curated', ...edge })),
    ...graph.topology.edges.map((edge) => ({ namespace: 'topology', ...edge })),
  ];
  return { nodes, edges };
}

test('checkGraphState judges an in-memory graph with exactly the port-fed machinery', () => {
  const clean = checkGraphState(...Object.values(stableRecords(baseGraph())), PROJECT);
  assert.deepEqual(clean.violations, []);
  assert.deepEqual(clean.warnings, []);

  const broken = baseGraph();
  broken.curated.edges.push({ type: 'PART_OF', fromId: ID.surface, toId: ID.component });
  const found = checkGraphState(...Object.values(stableRecords(broken)), PROJECT);
  assert.deepEqual(
    [...found.violations.map((v) => v.code)].sort(),
    // INVALID_RELATIONSHIP_ENDPOINTS is B1's own code, forwarded verbatim — see the module header.
    ['INVALID_RELATIONSHIP_ENDPOINTS', GRAPH_VIOLATION_CODES.RELATIONSHIP_CYCLE].sort(),
  );
});

test('checkGraphState surfaces the same conflict an overlapping scope plants, without the port', () => {
  const graph = baseGraph();
  const scoped = ruleNode('apex:proj:rule:duplicate-concern', { concern: 'external-input' });
  graph.curated.nodes.push(scoped);
  graph.curated.edges.push({ type: 'APPLIES_TO', fromId: scoped.id, toId: ID.surface });
  const { violations } = checkGraphState(...Object.values(stableRecords(graph)), PROJECT);
  const found = violations.filter((v) => v.code === GRAPH_VIOLATION_CODES.UNRESOLVED_RULE_CONFLICT);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].identity.ruleIds, [ID.rule, scoped.id].sort());
});
