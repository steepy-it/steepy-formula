// Deterministic context resolver suite (Task D2, spec §8). Every case drives `resolveContext`
// through a REAL port adapter (the B3 in-memory reference) over a fixture SEEDED WITH B5's
// `applyChangeSet`, not with raw port writes: the resolver is a read path that must coexist with
// the audit chain, and a fixture the chain cannot explain would prove nothing about the product.
//
// Fixture shape: `baseGraph()` returns a valid, spec-shaped graph — a curated skeleton
// (Project <- Surface <- Component) with Rules attached at all three levels of the resolution
// chain (Package, Component, Surface) plus the observed topology chain in its own namespace. Each
// test clones it and plants exactly what it needs, so a failure names the behavior that broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { withTransaction } from '../scripts/formula/engine/port.mjs';
import { validateGraph } from '../scripts/formula/core/validate-graph.mjs';
import { applyChangeSet, replayChain, sha256Hex } from '../scripts/formula/core/revision.mjs';
import { isLegalRelationshipEndpoints } from '../scripts/formula/core/ontology.mjs';
import { FIXTURE_TARGET_EDGES, generateFixture, loadFixture } from '../scripts/formula/core/fixture-gen.mjs';
import {
  resolveContext,
  RESOLVE_ERROR_CODES,
  UNRESOLVED_REASONS,
  MAX_UNRESOLVED_CANDIDATES,
  CHAIN_STEPS,
  TRACE_STEPS,
  CONTEXT_KINDS,
  RESOLVABLE_TARGET_KINDS,
  unavailableError,
} from '../scripts/formula/core/resolve-context.mjs';

const PROJECT = 'proj';

function qid(localId) {
  return `apex:${PROJECT}:${localId}`;
}

const ID = {
  project: qid('project:root'),
  surfaceScripts: qid('surface:scripts'),
  surfaceTests: qid('surface:tests'),
  componentEngine: qid('component:engine'),
  componentCli: qid('component:cli'),
  componentSuites: qid('component:suites'),
  agentScripts: qid('agent:scripts-agent'),
  agentEngine: qid('agent:engine-agent'),
  skillMigrate: qid('skill:graph-migrate'),
  checkSurfaceTest: qid('check:surface-test'),
  checkPortContract: qid('check:port-contract'),
  decisionGraphDb: qid('decision:graph-db-is-canonical'),
  termSurface: qid('term:surface'),
  termPort: qid('term:port'),
  ruleSanitize: qid('rule:sanitize-external-input'),
  rulePortOnly: qid('rule:engine-port-only'),
  rulePackage: qid('rule:package-manifest'),
  ruleTests: qid('rule:tests-narrow'),
  repository: qid('repository:root'),
  workspace: qid('workspace:root'),
  packageEngine: qid('package:engine'),
  packageEngineUtils: qid('package:engine-utils'),
  packageEngineSub: qid('package:engine-sub'),
  packageSuites: qid('package:suites'),
};

function curatedNode(type, id, properties = {}) {
  return { type, id, properties: { id, status: 'active', ...properties } };
}

function ruleNode(id, concern, overrides = {}) {
  return {
    type: 'Rule',
    id,
    properties: {
      id,
      title: `Rule ${id}`,
      statement: 'A normative statement.',
      status: 'active',
      strength: 'must',
      category: 'engineering',
      concern,
      provenance: { source: 'spec', line: 52 },
      ...overrides,
    },
  };
}

function packageNode(id, path) {
  return { type: 'Package', id, properties: { id, path } };
}

// A valid graph (B4-clean) that exercises the whole §8 chain: Rules attached at a Package, at a
// Component and at a Surface; two Surfaces so a multi-input union spans more than one branch; and
// package selectors that are string prefixes of one another without being segment prefixes.
function baseGraph() {
  return {
    curated: {
      nodes: [
        curatedNode('Project', ID.project),
        curatedNode('Surface', ID.surfaceScripts),
        curatedNode('Surface', ID.surfaceTests),
        curatedNode('Component', ID.componentEngine),
        curatedNode('Component', ID.componentCli),
        curatedNode('Component', ID.componentSuites),
        curatedNode('Agent', ID.agentScripts),
        curatedNode('Agent', ID.agentEngine),
        curatedNode('Skill', ID.skillMigrate),
        curatedNode('Check', ID.checkSurfaceTest),
        curatedNode('Check', ID.checkPortContract),
        curatedNode('Decision', ID.decisionGraphDb),
        curatedNode('Term', ID.termSurface),
        curatedNode('Term', ID.termPort),
        ruleNode(ID.ruleSanitize, 'external-input'),
        ruleNode(ID.rulePortOnly, 'port-io'),
        ruleNode(ID.rulePackage, 'package-scope'),
        ruleNode(ID.ruleTests, 'test-scope'),
      ],
      edges: [
        { type: 'PART_OF', fromId: ID.surfaceScripts, toId: ID.project },
        { type: 'PART_OF', fromId: ID.surfaceTests, toId: ID.project },
        { type: 'PART_OF', fromId: ID.componentEngine, toId: ID.surfaceScripts },
        { type: 'PART_OF', fromId: ID.componentCli, toId: ID.surfaceScripts },
        { type: 'PART_OF', fromId: ID.componentSuites, toId: ID.surfaceTests },
        { type: 'OWNED_BY', fromId: ID.surfaceScripts, toId: ID.agentScripts },
        { type: 'OWNED_BY', fromId: ID.componentEngine, toId: ID.agentEngine },
        { type: 'APPLIES_TO', fromId: ID.skillMigrate, toId: ID.surfaceScripts },
        { type: 'APPLIES_TO', fromId: ID.ruleSanitize, toId: ID.surfaceScripts },
        { type: 'VERIFIED_BY', fromId: ID.ruleSanitize, toId: ID.checkSurfaceTest },
        { type: 'MOTIVATED_BY', fromId: ID.ruleSanitize, toId: ID.decisionGraphDb },
        { type: 'APPLIES_TO', fromId: ID.rulePortOnly, toId: ID.componentEngine },
        { type: 'VERIFIED_BY', fromId: ID.rulePortOnly, toId: ID.checkPortContract },
        { type: 'APPLIES_TO', fromId: ID.rulePackage, toId: ID.packageEngine },
        { type: 'APPLIES_TO', fromId: ID.ruleTests, toId: ID.surfaceTests },
        { type: 'USED_BY', fromId: ID.termSurface, toId: ID.surfaceScripts },
        { type: 'USED_BY', fromId: ID.termPort, toId: ID.rulePortOnly },
      ],
    },
    topology: {
      nodes: [
        { type: 'Repository', id: ID.repository, properties: { id: ID.repository, root: 'demo', digest: 'd'.repeat(64) } },
        { type: 'Workspace', id: ID.workspace, properties: { id: ID.workspace, path: '.' } },
        packageNode(ID.packageEngine, 'packages/engine'),
        packageNode(ID.packageEngineUtils, 'packages/engine-utils'),
        packageNode(ID.packageEngineSub, 'packages/engine/sub'),
        packageNode(ID.packageSuites, 'packages/suites'),
      ],
      edges: [
        { type: 'PART_OF', fromId: ID.workspace, toId: ID.repository },
        { type: 'PART_OF', fromId: ID.packageEngine, toId: ID.workspace },
        { type: 'PART_OF', fromId: ID.packageEngineUtils, toId: ID.workspace },
        { type: 'PART_OF', fromId: ID.packageEngineSub, toId: ID.workspace },
        { type: 'PART_OF', fromId: ID.packageSuites, toId: ID.workspace },
        { type: 'IMPLEMENTS', fromId: ID.packageEngine, toId: ID.componentEngine },
        { type: 'IMPLEMENTS', fromId: ID.packageEngineUtils, toId: ID.componentCli },
        { type: 'IMPLEMENTS', fromId: ID.packageEngineSub, toId: ID.componentCli },
        { type: 'IMPLEMENTS', fromId: ID.packageSuites, toId: ID.componentSuites },
      ],
    },
  };
}

function meta() {
  return {
    projectId: PROJECT,
    proposer: { type: 'agent-proposer', id: 'scripts-agent' },
    approver: { type: 'human-approver', id: 'steepy-it' },
    provenance: [{ quotation: 'Deterministic context resolver.', source: 'docs/spec.md:271', digest: sha256Hex('spec') }],
    timestamp: '2026-08-12T10:00:00.000Z',
  };
}

// Nodes of BOTH stable namespaces before any edge: a bridge edge (Rule APPLIES_TO Package) has its
// two endpoints in two namespaces, so an edge-after-its-own-namespace order could not create one.
function changeSetFor(graph) {
  const operations = [];
  for (const namespace of ['curated', 'topology']) {
    for (const node of graph[namespace]?.nodes ?? []) {
      operations.push({ op: 'ADD', target: 'node', namespace, type: node.type, id: node.id, properties: node.properties });
    }
  }
  for (const namespace of ['curated', 'topology']) {
    for (const edge of graph[namespace]?.edges ?? []) {
      operations.push({ op: 'ADD', target: 'edge', namespace, type: edge.type, fromId: edge.fromId, toId: edge.toId });
    }
  }
  return { operations };
}

async function seedGraph(port, graph) {
  const applied = await applyChangeSet(port, changeSetFor(graph), meta());
  assert.deepEqual(applied.violations, [], 'the fixture must apply cleanly through the audit chain');
  // Scenario records are written straight through the port: a ChangeSet may only touch the stable
  // namespaces (B5 `CHANGE_NAMESPACES`), which is exactly why a scenario is not stable knowledge.
  if (!graph.scenarios) return;
  await withTransaction(port, async (tx) => {
    for (const [scenarioId, part] of Object.entries(graph.scenarios)) {
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

function resolve(graph, input) {
  return withGraph(graph, (port) => resolveContext(port, { projectId: PROJECT, ...input }));
}

function idsOf(items) {
  return items.map((item) => item.id);
}

function sortedIdsOf(items) {
  return idsOf(items).sort();
}

function allItems(result) {
  return Object.values(result.context).flat();
}

// --- module contract ---------------------------------------------------------------------------

// The resolver re-states the §8 chain as its own table, so the ontology can drift out from under it
// silently — B1 is the single source of truth for what an edge may connect. This is the pin that
// makes `CHAIN_STEPS`'s "cannot drift" claim true rather than aspirational.
test('every CHAIN_STEPS triple is a legal relationship per B1 — the chain cannot drift from the ontology', () => {
  for (const step of CHAIN_STEPS) {
    assert.equal(
      isLegalRelationshipEndpoints(step.via, step.from, step.to),
      true,
      `${step.from} --${step.via}--> ${step.to} is not in B1's RELATIONSHIP_RULES`,
    );
  }
});

// The other relationships the traversal walks are named inline rather than tabled; pin them too, or
// a B1 rename would leave the resolver quietly collecting nothing.
test('every relationship the traversal collects along is legal per B1', () => {
  const walked = [
    ['APPLIES_TO', 'Rule', 'Surface'],
    ['APPLIES_TO', 'Rule', 'Component'],
    ['APPLIES_TO', 'Rule', 'Package'],
    ['APPLIES_TO', 'Skill', 'Surface'],
    ['APPLIES_TO', 'Skill', 'Component'],
    ['OWNED_BY', 'Surface', 'Agent'],
    ['OWNED_BY', 'Component', 'Agent'],
    ['VERIFIED_BY', 'Rule', 'Check'],
    ['MOTIVATED_BY', 'Rule', 'Decision'],
    ['OVERRIDES', 'Rule', 'Rule'],
    ['USED_BY', 'Term', 'Rule'],
    ['SUPERSEDES', 'Rule', 'Rule'],
  ];
  for (const [relationship, from, to] of walked) {
    assert.equal(isLegalRelationshipEndpoints(relationship, from, to), true, `${from} --${relationship}--> ${to}`);
  }
});

test('the exported vocabularies are frozen and self-consistent', () => {
  for (const vocabulary of [CHAIN_STEPS, TRACE_STEPS, CONTEXT_KINDS, RESOLVABLE_TARGET_KINDS]) {
    assert.equal(Object.isFrozen(vocabulary), true);
  }
  // Every kind that can be RETURNED must also be nameable as an explicit target, or a caller could
  // receive an item it cannot then ask for by name.
  for (const kind of CONTEXT_KINDS) assert.equal(RESOLVABLE_TARGET_KINDS.includes(kind), true, kind);
  // Every anchor the chain walks must be nameable too — a Package target is the documented
  // equivalent of a path into it.
  for (const step of CHAIN_STEPS) {
    assert.equal(RESOLVABLE_TARGET_KINDS.includes(step.from), true, step.from);
    assert.equal(RESOLVABLE_TARGET_KINDS.includes(step.to), true, step.to);
  }
});

test('resolveContext throws (programmer error) when the port is missing or is not a port', async () => {
  await assert.rejects(() => resolveContext(undefined, { projectId: PROJECT, paths: ['a'] }), TypeError);
  await assert.rejects(() => resolveContext({}, { projectId: PROJECT, paths: ['a'] }), TypeError);
});

test('resolveContext throws (programmer error) on a missing or malformed projectId', async () => {
  const port = createMemoryPort();
  try {
    await assert.rejects(() => resolveContext(port, { paths: ['a'] }), TypeError);
    await assert.rejects(() => resolveContext(port, { projectId: 'Not A Project', paths: ['a'] }), TypeError);
  } finally {
    await port.close();
  }
});

test('resolveContext throws on an unknown input key — a typo never silently drops an input', async () => {
  const port = createMemoryPort();
  try {
    await assert.rejects(() => resolveContext(port, { projectId: PROJECT, path: ['a'] }), TypeError);
    await assert.rejects(() => resolveContext(port, { projectId: PROJECT, paths: ['a'], target: ['b'] }), TypeError);
  } finally {
    await port.close();
  }
});

test('resolveContext requires at least one path or target (spec §8)', async () => {
  const port = createMemoryPort();
  try {
    await assert.rejects(() => resolveContext(port, { projectId: PROJECT }), TypeError);
    await assert.rejects(() => resolveContext(port, { projectId: PROJECT, paths: [], targets: [] }), TypeError);
  } finally {
    await port.close();
  }
});

test('resolveContext throws when paths or targets are not a list of non-empty strings', async () => {
  const port = createMemoryPort();
  try {
    await assert.rejects(() => resolveContext(port, { projectId: PROJECT, paths: 'packages/engine' }), TypeError);
    await assert.rejects(() => resolveContext(port, { projectId: PROJECT, paths: [''] }), TypeError);
    await assert.rejects(() => resolveContext(port, { projectId: PROJECT, targets: [42] }), TypeError);
  } finally {
    await port.close();
  }
});

// --- the main traversal (spec §8: path -> Package -> Component -> Surface -> Rule -> ...) --------

test('a single path collects the Rules attached at EVERY level of its chain', async () => {
  const result = await resolve(baseGraph(), { paths: ['packages/engine/src/sanitize.mjs'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(sortedIdsOf(result.context.rules), [ID.rulePortOnly, ID.rulePackage, ID.ruleSanitize].sort());
});

test('a path never collects a Rule from a sibling branch of the graph', async () => {
  const result = await resolve(baseGraph(), { paths: ['packages/engine/src/sanitize.mjs'] });
  assert.equal(result.context.rules.some((rule) => rule.id === ID.ruleTests), false);
});

test('the chain expands to Checks, Agents, Skills, Terms and Decisions', async () => {
  const result = await resolve(baseGraph(), { paths: ['packages/engine/src/sanitize.mjs'] });
  assert.deepEqual(sortedIdsOf(result.context.checks), [ID.checkPortContract, ID.checkSurfaceTest].sort());
  assert.deepEqual(sortedIdsOf(result.context.agents), [ID.agentEngine, ID.agentScripts].sort());
  assert.deepEqual(sortedIdsOf(result.context.skills), [ID.skillMigrate]);
  assert.deepEqual(sortedIdsOf(result.context.terms), [ID.termPort, ID.termSurface].sort());
  assert.deepEqual(sortedIdsOf(result.context.decisions), [ID.decisionGraphDb]);
});

// D3 needs the FULL set of surviving Rules that VERIFIED_BY a served Check, not merely the one
// derivation the item's own `trace` kept (first-collected wins) — a Check verified by both a
// `must` and a `should` Rule must still be told apart from one verified only by a `should` Rule,
// which the single kept trace cannot answer (spec §9 binding semantics #1: "the stronger claim
// wins"). Additive per the D2 integration constraint ("export a D2 internal with a test").
test('diagnostics.checkVerifiers names every surviving Rule that VERIFIED_BY a served Check', async () => {
  const graph = baseGraph();
  const extra = qid('rule:extra-should');
  graph.curated.nodes.push(ruleNode(extra, 'extra-concern', { strength: 'should' }));
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: extra, toId: ID.componentEngine },
    { type: 'VERIFIED_BY', fromId: extra, toId: ID.checkPortContract },
  );
  const result = await resolve(graph, { paths: ['packages/engine/src/a.mjs'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Array.isArray(result.diagnostics.checkVerifiers));

  // Every Check the result actually serves must be indexed — D3 has no other way to classify it.
  const indexed = new Set(result.diagnostics.checkVerifiers.map((entry) => entry.id));
  for (const check of result.context.checks) assert.ok(indexed.has(check.id), check.id);

  const entry = result.diagnostics.checkVerifiers.find((found) => found.id === ID.checkPortContract);
  assert.deepEqual(entry.ruleIds, [ID.rulePortOnly, extra].sort());
});

// A Rule beaten in the ONLY scope it was applicable in never survives, so it must never appear as
// a verifier — the multiplicity D3 is given must already be lifecycle/conflict-filtered, exactly
// like `context.rules` itself.
test('diagnostics.checkVerifiers never names a Rule that lost the conflict gate', async () => {
  const graph = withCrossLevelConflict(baseGraph());
  graph.curated.edges.push(
    { type: 'VERIFIED_BY', fromId: qid('rule:naming-surface'), toId: ID.checkSurfaceTest },
    { type: 'OVERRIDES', fromId: qid('rule:naming-engine'), toId: qid('rule:naming-surface') },
  );
  const result = await resolve(graph, { paths: ['packages/engine/src/a.mjs'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  // The Check stays served — `baseGraph()` already VERIFIED_BYs it from `ruleSanitize`, which
  // survives untouched — so its entry legitimately exists. What must be absent is the BEATEN Rule.
  const entry = result.diagnostics.checkVerifiers.find((found) => found.id === ID.checkSurfaceTest);
  assert.ok(entry, 'the surviving Rule must still verify it');
  assert.deepEqual(entry.ruleIds, [ID.ruleSanitize]);
  assert.equal(entry.ruleIds.includes(qid('rule:naming-surface')), false, 'the beaten Rule must never verify anything in the served answer');
});

test('a package selector matches only on segment boundaries, and the deepest selector wins', async () => {
  // 'packages/engine' is a string prefix of 'packages/engine-utils' but not a path prefix of it,
  // and 'packages/engine/sub' is deeper than 'packages/engine' for a file inside it.
  const utils = await resolve(baseGraph(), { paths: ['packages/engine-utils/index.mjs'] });
  assert.deepEqual(sortedIdsOf(utils.context.rules), [ID.ruleSanitize]);
  const sub = await resolve(baseGraph(), { paths: ['packages/engine/sub/deep.mjs'] });
  assert.deepEqual(sortedIdsOf(sub.context.rules), [ID.ruleSanitize]);
});

test('every returned item carries the graph path that made it applicable', async () => {
  const result = await resolve(baseGraph(), { paths: ['packages/engine/src/sanitize.mjs'] });
  const items = allItems(result);
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.ok(Array.isArray(item.trace) && item.trace.length > 0, `${item.id} has no trace`);
    assert.equal(item.trace.at(-1).to, item.id, `${item.id}'s trace does not end at the item`);
    for (const step of item.trace) {
      assert.equal(typeof step.via, 'string');
      assert.equal(typeof step.to, 'string');
    }
  }
});

test('the trace is the ordered chain the spec sketches: path -> Package -> Component -> Surface -> Rule', async () => {
  const result = await resolve(baseGraph(), { paths: ['packages/engine/src/sanitize.mjs'] });
  const rule = result.context.rules.find((item) => item.id === ID.ruleSanitize);
  assert.deepEqual(rule.trace, [
    { via: 'input:path', to: 'packages/engine/src/sanitize.mjs' },
    { via: 'path-selector', to: ID.packageEngine },
    { via: 'IMPLEMENTS', to: ID.componentEngine },
    { via: 'PART_OF', to: ID.surfaceScripts },
    { via: 'APPLIES_TO', to: ID.ruleSanitize },
  ]);
  const check = result.context.checks.find((item) => item.id === ID.checkSurfaceTest);
  assert.deepEqual(check.trace, [...rule.trace, { via: 'VERIFIED_BY', to: ID.checkSurfaceTest }]);
});

test('every item carries its kind, lifecycle status and property bag', async () => {
  const result = await resolve(baseGraph(), { paths: ['packages/engine/src/sanitize.mjs'] });
  const rule = result.context.rules.find((item) => item.id === ID.ruleSanitize);
  assert.equal(rule.kind, 'Rule');
  assert.equal(rule.status, 'active');
  assert.equal(rule.properties.concern, 'external-input');
  assert.equal(result.context.agents[0].kind, 'Agent');
});

test('the fixture is seeded through the audit chain and replays green (read path coexists with B5)', async () => {
  await withGraph(baseGraph(), async (port) => {
    const resolved = await resolveContext(port, { projectId: PROJECT, paths: ['packages/engine/src/sanitize.mjs'] });
    assert.equal(resolved.ok, true);
    const replay = await replayChain(port, { projectId: PROJECT });
    assert.deepEqual(replay.violations, []);
    assert.deepEqual(replay.unexplained, { nodes: [], edges: [] });
    assert.deepEqual(replay.missing, { nodes: [], edges: [] });
    assert.equal(replay.ok, true);
  });
});

// --- multi-input union, deduplication and determinism (spec §8) ---------------------------------

test('multiple paths produce the UNION of their applicable context, deduplicated by qualified id', async () => {
  const result = await resolve(baseGraph(), {
    paths: ['packages/engine/src/a.mjs', 'packages/suites/b.test.mjs'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(sortedIdsOf(result.context.rules), [ID.rulePortOnly, ID.rulePackage, ID.ruleSanitize, ID.ruleTests].sort());
  assert.equal(new Set(idsOf(allItems(result))).size, allItems(result).length, 'an item is returned at most once');
});

test('results are ordered by kind (Rule, Check, Agent, Skill, Term, Decision) then by qualified id', async () => {
  const result = await resolve(baseGraph(), { paths: ['packages/engine/src/a.mjs'] });
  assert.deepEqual(Object.keys(result.context), ['rules', 'checks', 'agents', 'skills', 'terms', 'decisions']);
  assert.deepEqual(idsOf(result.context.rules), [ID.rulePortOnly, ID.rulePackage, ID.ruleSanitize]);
  assert.deepEqual(idsOf(result.context.checks), [ID.checkPortContract, ID.checkSurfaceTest]);
  assert.deepEqual(idsOf(result.context.agents), [ID.agentEngine, ID.agentScripts]);
  assert.deepEqual(idsOf(result.context.terms), [ID.termPort, ID.termSurface]);
});

test('inputs are normalized: non-canonical and repeated paths collapse before processing', async () => {
  const result = await resolve(baseGraph(), {
    paths: ['./packages/engine//src/a.mjs', 'packages/engine/src/a.mjs', 'packages/engine/src/a.mjs/'],
  });
  assert.deepEqual(result.input.paths, ['packages/engine/src/a.mjs']);
});

test('a duplicated derivation keeps the FIRST trace in deterministic input order, not in call order', async () => {
  // 'packages/engine-utils/...' sorts before 'packages/engine/...', so the shared Surface rule is
  // derived through the engine-utils branch whatever order the caller passed the paths in.
  const expected = [
    { via: 'input:path', to: 'packages/engine-utils/x.mjs' },
    { via: 'path-selector', to: ID.packageEngineUtils },
    { via: 'IMPLEMENTS', to: ID.componentCli },
    { via: 'PART_OF', to: ID.surfaceScripts },
    { via: 'APPLIES_TO', to: ID.ruleSanitize },
  ];
  for (const paths of [
    ['packages/engine-utils/x.mjs', 'packages/engine/x.mjs'],
    ['packages/engine/x.mjs', 'packages/engine-utils/x.mjs'],
  ]) {
    const result = await resolve(baseGraph(), { paths });
    const rule = result.context.rules.find((item) => item.id === ID.ruleSanitize);
    assert.deepEqual(rule.trace, expected, `input order ${paths.join(', ')} changed the trace`);
  }
});

// A chain settled in ONE scope, plus a different winner beating the chain's middle in ANOTHER —
// the shape that catches a gate resolving a chain across scope boundaries. `naming-alt` sorts FIRST,
// so a global min-winner-by-id tie-break picks it, and it governs none of the engine code the chain
// governed. Ids: alt < low < mid < top.
function withOverridesAcrossScopes(graph) {
  const [alt, low, mid, top] = ['alt', 'low', 'mid', 'top'].map((slug) => qid(`rule:naming-${slug}`));
  graph.curated.nodes.push(...[alt, low, mid, top].map((id) => ruleNode(id, 'naming')));
  graph.curated.edges.push(
    // Engine scope: a three-level chain, top beats mid beats low.
    { type: 'APPLIES_TO', fromId: top, toId: ID.packageEngine },
    { type: 'APPLIES_TO', fromId: mid, toId: ID.componentEngine },
    { type: 'APPLIES_TO', fromId: low, toId: ID.surfaceScripts },
    { type: 'OVERRIDES', fromId: top, toId: mid },
    { type: 'OVERRIDES', fromId: mid, toId: low },
    // Suites scope: mid also reaches there, where a DIFFERENT Rule beats it.
    { type: 'APPLIES_TO', fromId: mid, toId: ID.surfaceTests },
    { type: 'APPLIES_TO', fromId: alt, toId: ID.surfaceTests },
    { type: 'OVERRIDES', fromId: alt, toId: mid },
  );
  return graph;
}

test('a chain is walked within the scope that settled it — never out to a winner governing other code', async () => {
  const [alt, low, mid, top] = ['alt', 'low', 'mid', 'top'].map((slug) => qid(`rule:naming-${slug}`));
  await withGraph(withOverridesAcrossScopes(baseGraph()), async (port) => {
    const validation = await validateGraph(port, { projectId: PROJECT });
    assert.deepEqual(validation.violations, [], 'the fixture must be B4-clean, or this proves nothing');

    const result = await resolveContext(port, {
      projectId: PROJECT,
      paths: ['packages/engine/src/a.mjs', 'packages/suites/b.mjs'],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const naming = idsOf(result.context.rules).filter((id) => id.startsWith(qid('rule:naming-')));
    assert.deepEqual(naming, [alt, top], 'one survivor per scope');

    // `low` was governed by the engine chain, so what replaces it must be the chain's own survivor —
    // `alt` sorts first but governs the tests surface and would be a false answer.
    assert.deepEqual(result.diagnostics.overridden, [
      { id: low, overriddenBy: top, concern: 'naming' },
      { id: mid, overriddenBy: top, concern: 'naming' },
    ]);
  });
});

// `baseGraph()` alone has no OVERRIDES, so it never reaches the conflict gate — the part with the
// most order-dependent state (per-scope contests, the cross-scope tie-break, the winner walk and the
// served-trace choice). Both fixtures run, so determinism is pinned where it is actually hard.
function reverseSeedOrder(graph) {
  for (const namespace of ['curated', 'topology']) {
    graph[namespace].nodes.reverse();
    graph[namespace].edges.reverse();
  }
  return graph;
}

// Two Rules on ONE anchor (different concerns, so both survive) sharing a Check and a Term: which
// Rule is collected first decides the derivation those two inherit, and that order comes from the
// anchor's APPLIES_TO adjacency list. Without the index-time sort it is the port's list order —
// which is exactly what reversing the seed order changes.
function withSharedDerivations(graph) {
  const [first, second] = [qid('rule:shared-a'), qid('rule:shared-b')];
  graph.curated.nodes.push(
    ruleNode(first, 'shared-concern-a'),
    ruleNode(second, 'shared-concern-b'),
    curatedNode('Check', qid('check:shared')),
    curatedNode('Term', qid('term:shared')),
  );
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: first, toId: ID.componentEngine },
    { type: 'APPLIES_TO', fromId: second, toId: ID.componentEngine },
    { type: 'VERIFIED_BY', fromId: first, toId: qid('check:shared') },
    { type: 'VERIFIED_BY', fromId: second, toId: qid('check:shared') },
    { type: 'USED_BY', fromId: qid('term:shared'), toId: first },
    { type: 'USED_BY', fromId: qid('term:shared'), toId: second },
  );
  return graph;
}

test('the same input on the same graph state is BYTE-IDENTICAL, whatever order the graph was seeded in', async () => {
  const forward = ['packages/engine/src/a.mjs', 'packages/suites/b.mjs'];
  const backward = [...forward].reverse();
  for (const build of [
    baseGraph,
    () => withOverridesAcrossScopes(baseGraph()),
    () => withSharedDerivations(baseGraph()),
    () => withSharedDerivations(withOverridesAcrossScopes(baseGraph())),
  ]) {
    const inOrder = await resolve(build(), { paths: forward });
    const reversed = await resolve(reverseSeedOrder(build()), { paths: backward });
    assert.equal(inOrder.ok, true, JSON.stringify(inOrder));
    assert.equal(JSON.stringify(reversed), JSON.stringify(inOrder));
  }
});

// --- explicit targets (spec §8: paths and/or explicit targets) ----------------------------------

test('an explicit Package target resolves exactly the chain a path into that package resolves', async () => {
  const byTarget = await resolve(baseGraph(), { targets: [ID.packageEngine] });
  const byPath = await resolve(baseGraph(), { paths: ['packages/engine/src/a.mjs'] });
  assert.equal(byTarget.ok, true, JSON.stringify(byTarget));
  assert.deepEqual(idsOf(allItems(byTarget)), idsOf(allItems(byPath)));
});

test('a target may be a local <kind>:<slug> id, resolved within the project', async () => {
  const local = await resolve(baseGraph(), { targets: ['component:engine'] });
  const qualified = await resolve(baseGraph(), { targets: [ID.componentEngine] });
  assert.equal(local.ok, true, JSON.stringify(local));
  assert.deepEqual(idsOf(allItems(local)), idsOf(allItems(qualified)));
  // The walk goes UP the chain: the Package-level rule below the Component is not collected.
  assert.deepEqual(idsOf(local.context.rules), [ID.rulePortOnly, ID.ruleSanitize]);
});

test('a Surface target collects the Surface level and nothing below it', async () => {
  const result = await resolve(baseGraph(), { targets: ['surface:scripts'] });
  assert.deepEqual(idsOf(result.context.rules), [ID.ruleSanitize]);
  assert.deepEqual(idsOf(result.context.agents), [ID.agentScripts]);
  assert.deepEqual(idsOf(result.context.skills), [ID.skillMigrate]);
  assert.deepEqual(idsOf(result.context.terms), [ID.termSurface]);
});

test('a Rule target is collected and expanded along VERIFIED_BY and MOTIVATED_BY — never widened', async () => {
  const result = await resolve(baseGraph(), { targets: ['rule:sanitize-external-input'] });
  assert.deepEqual(idsOf(result.context.rules), [ID.ruleSanitize]);
  assert.deepEqual(idsOf(result.context.checks), [ID.checkSurfaceTest]);
  assert.deepEqual(idsOf(result.context.decisions), [ID.decisionGraphDb]);
  assert.deepEqual(idsOf(result.context.agents), []);
  assert.deepEqual(idsOf(result.context.skills), []);
});

test('a leaf target (a Check) resolves to itself alone — resolution never falls back to the graph', async () => {
  const result = await resolve(baseGraph(), { targets: ['check:surface-test'] });
  assert.deepEqual(idsOf(allItems(result)), [ID.checkSurfaceTest]);
});

test("a target's trace starts at the raw input and names the node it resolved to", async () => {
  const result = await resolve(baseGraph(), { targets: ['component:engine'] });
  const rule = result.context.rules.find((item) => item.id === ID.rulePortOnly);
  assert.deepEqual(rule.trace, [
    { via: 'input:target', to: 'component:engine' },
    { via: 'target-id', to: ID.componentEngine },
    { via: 'APPLIES_TO', to: ID.rulePortOnly },
  ]);
});

test('paths and targets union, and paths are processed first so their derivation wins', async () => {
  const result = await resolve(baseGraph(), {
    paths: ['packages/engine-utils/x.mjs'],
    targets: [ID.componentEngine],
  });
  assert.deepEqual(sortedIdsOf(result.context.rules), [ID.rulePortOnly, ID.ruleSanitize].sort());
  const rule = result.context.rules.find((item) => item.id === ID.ruleSanitize);
  assert.equal(rule.trace[0].via, 'input:path');
  assert.deepEqual(result.input, { paths: ['packages/engine-utils/x.mjs'], targets: [ID.componentEngine] });
});

// --- UNRESOLVED: ambiguous or missing match, never a whole-graph fallback (spec §8) -------------

// Twelve sibling packages under `apps/`, so a near-miss candidate list has something to truncate.
function withManyPackages(graph) {
  for (let index = 0; index < 12; index += 1) {
    const id = qid(`package:app-${String(index).padStart(2, '0')}`);
    graph.topology.nodes.push(packageNode(id, `apps/app-${String(index).padStart(2, '0')}`));
    graph.topology.edges.push({ type: 'PART_OF', fromId: id, toId: ID.workspace });
    graph.topology.edges.push({ type: 'IMPLEMENTS', fromId: id, toId: ID.componentCli });
  }
  return graph;
}

test('a path that matches no package selector is UNRESOLVED with the nearest candidates and a reason', async () => {
  const result = await resolve(baseGraph(), { paths: ['services/api/index.mjs'] });
  assert.equal(result.ok, false);
  assert.equal(result.code, RESOLVE_ERROR_CODES.UNRESOLVED);
  assert.equal(result.context, undefined, 'a failed resolution returns no partial context');
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].kind, 'path');
  assert.equal(result.unresolved[0].input, 'services/api/index.mjs');
  assert.equal(result.unresolved[0].reason, UNRESOLVED_REASONS.NO_PACKAGE_MATCHES_PATH);
  assert.equal(typeof result.message, 'string');
  assert.equal(typeof result.identity, 'object');
});

test('near-miss candidates are the packages sharing the longest path prefix, capped and counted', async () => {
  const result = await resolve(withManyPackages(baseGraph()), { paths: ['apps/app-99/index.mjs'] });
  assert.equal(result.ok, false);
  const [entry] = result.unresolved;
  assert.equal(entry.candidateCount, 12);
  assert.equal(entry.candidates.length, MAX_UNRESOLVED_CANDIDATES);
  assert.deepEqual(entry.candidates[0], { id: qid('package:app-00'), kind: 'Package', selector: 'apps/app-00' });
  assert.equal(entry.candidates.every((candidate) => candidate.selector.startsWith('apps/')), true);
});

test('two packages carrying the SAME selector make a path ambiguous — both are reported', async () => {
  const graph = baseGraph();
  const twin = qid('package:engine-twin');
  graph.topology.nodes.push(packageNode(twin, 'packages/engine'));
  graph.topology.edges.push({ type: 'PART_OF', fromId: twin, toId: ID.workspace });
  graph.topology.edges.push({ type: 'IMPLEMENTS', fromId: twin, toId: ID.componentCli });

  const result = await resolve(graph, { paths: ['packages/engine/src/a.mjs'] });
  assert.equal(result.ok, false);
  assert.equal(result.code, RESOLVE_ERROR_CODES.UNRESOLVED);
  const [entry] = result.unresolved;
  assert.equal(entry.reason, UNRESOLVED_REASONS.AMBIGUOUS_PACKAGE_SELECTOR);
  assert.deepEqual(idsOf(entry.candidates), [ID.packageEngine, twin].sort());
});

// `/` and `//` are the interesting ones: they are the absolute paths whose normalization has
// nothing LEFT once slashes are collapsed, so a canonicalizer that strips them turns the filesystem
// root into `.` — the repository root — and matches the root selector instead of refusing.
test('an absolute path or one escaping the repository root is UNRESOLVED, not silently matched', async () => {
  for (const path of ['/etc/passwd', '../outside/x.mjs', '/', '//', '/../etc']) {
    const result = await resolve(baseGraph(), { paths: [path] });
    assert.equal(result.ok, false, path);
    assert.equal(result.unresolved[0].reason, UNRESOLVED_REASONS.PATH_NOT_REPO_RELATIVE, path);
  }
});

test('an unknown target is UNRESOLVED with the same-kind near misses as candidates', async () => {
  const result = await resolve(baseGraph(), { targets: ['rule:no-such-rule'] });
  assert.equal(result.ok, false);
  const [entry] = result.unresolved;
  assert.equal(entry.kind, 'target');
  assert.equal(entry.reason, UNRESOLVED_REASONS.UNKNOWN_TARGET);
  assert.deepEqual(idsOf(entry.candidates), [ID.rulePortOnly, ID.rulePackage, ID.ruleSanitize, ID.ruleTests].sort());
  assert.equal(entry.candidates.every((candidate) => candidate.kind === 'Rule'), true);
});

test('a malformed target, a foreign-project target and an unsupported kind each report their reason', async () => {
  const cases = [
    ['not-an-id', UNRESOLVED_REASONS.MALFORMED_TARGET],
    ['apex:other:rule:sanitize-external-input', UNRESOLVED_REASONS.TARGET_OUTSIDE_PROJECT],
    ['workspace:root', UNRESOLVED_REASONS.UNSUPPORTED_TARGET_KIND],
  ];
  for (const [target, reason] of cases) {
    const result = await resolve(baseGraph(), { targets: [target] });
    assert.equal(result.ok, false, target);
    assert.equal(result.unresolved[0].reason, reason, target);
  }
});

test('one unresolved input fails the whole resolution: mandatory knowledge is never partially served', async () => {
  const result = await resolve(baseGraph(), {
    paths: ['packages/engine/src/a.mjs', 'services/api/index.mjs'],
    targets: ['rule:no-such-rule'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, RESOLVE_ERROR_CODES.UNRESOLVED);
  assert.deepEqual(
    result.unresolved.map((entry) => entry.input),
    ['services/api/index.mjs', 'rule:no-such-rule'],
  );
  assert.deepEqual(result.identity.unresolvedInputs, ['services/api/index.mjs', 'rule:no-such-rule']);
});

// --- lifecycle (spec §6): deprecated is served with a warning, superseded never ------------------

// A deprecated Rule and a superseded one (with its replacement), both attached to the Surface the
// engine package resolves through, plus a superseded Check hanging off an active Rule.
function withLifecycle(graph) {
  graph.curated.nodes.push(
    ruleNode(qid('rule:legacy-naming'), 'naming', { status: 'deprecated', strength: 'should' }),
    ruleNode(qid('rule:retired-sanitize'), 'external-input', { status: 'superseded' }),
    curatedNode('Check', qid('check:retired'), { status: 'superseded' }),
  );
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: qid('rule:legacy-naming'), toId: ID.surfaceScripts },
    { type: 'APPLIES_TO', fromId: qid('rule:retired-sanitize'), toId: ID.surfaceScripts },
    { type: 'SUPERSEDES', fromId: ID.ruleSanitize, toId: qid('rule:retired-sanitize') },
    { type: 'VERIFIED_BY', fromId: ID.rulePortOnly, toId: qid('check:retired') },
  );
  return graph;
}

test('a deprecated Rule is still served, carrying a per-item deprecation marker and a diagnostic', async () => {
  const result = await resolve(withLifecycle(baseGraph()), { paths: ['packages/engine/src/a.mjs'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const legacy = result.context.rules.find((item) => item.id === qid('rule:legacy-naming'));
  assert.equal(legacy.status, 'deprecated');
  assert.equal(legacy.deprecated, true);
  assert.equal(result.context.rules.find((item) => item.id === ID.ruleSanitize).deprecated, false);
  assert.deepEqual(result.diagnostics.deprecated, [{ id: qid('rule:legacy-naming'), kind: 'Rule' }]);
});

test('a superseded node NEVER enters resolved context, whatever attaches it', async () => {
  const result = await resolve(withLifecycle(baseGraph()), { paths: ['packages/engine/src/a.mjs'] });
  assert.equal(result.context.rules.some((item) => item.id === qid('rule:retired-sanitize')), false);
  assert.equal(result.context.checks.some((item) => item.id === qid('check:retired')), false);
  assert.equal(allItems(result).every((item) => item.status !== 'superseded'), true);
});

// The same lifecycle rule, one level down: `check:retired` is VERIFIED_BY the (surviving, active)
// `rulePortOnly`, so a naive verifier index would list it. `checkVerifiers` must obey the same
// choke point as `context.checks` itself, or D3 would classify a Check that is not even served.
test('diagnostics.checkVerifiers never names a superseded Check, even when a surviving Rule VERIFIED_BYs it', async () => {
  const result = await resolve(withLifecycle(baseGraph()), { paths: ['packages/engine/src/a.mjs'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const entry = result.diagnostics.checkVerifiers.find((found) => found.id === qid('check:retired'));
  assert.equal(entry, undefined);
});

test('explicitly targeting a superseded node is UNRESOLVED, with its replacement as the candidate', async () => {
  const result = await resolve(withLifecycle(baseGraph()), { targets: ['rule:retired-sanitize'] });
  assert.equal(result.ok, false);
  assert.equal(result.unresolved[0].reason, UNRESOLVED_REASONS.SUPERSEDED_TARGET);
  assert.deepEqual(idsOf(result.unresolved[0].candidates), [ID.ruleSanitize]);
});

// CONTROLLER ADJUDICATION (raised by the D2 review): a superseded ANCHOR still routes, and the
// active Rules attached to it are still served. §6 excludes a superseded node from operational
// context — that is about what is SERVED, and the anchor itself is never served: it is a routing
// position, and the Rules are separately-governed active nodes with their own lifecycle. The
// alternative is worse: refusing to route would make a path whose Component was retired resolve to
// NOTHING, which §8 forbids far more explicitly than it forbids this. Following SUPERSEDES to the
// replacement anchor would be inventing a semantic no section states. Pinned here so the behavior is
// a decision rather than an accident; flagged to D3/D4 as a spec question.
test('a superseded ANCHOR still routes, and the active Rules attached to it are still served', async () => {
  const graph = baseGraph();
  const retired = qid('component:retired');
  const rule = qid('rule:on-retired');
  graph.curated.nodes.push(
    curatedNode('Component', retired, { status: 'superseded' }),
    ruleNode(rule, 'retired-scope'),
  );
  graph.curated.edges.push(
    { type: 'PART_OF', fromId: retired, toId: ID.surfaceScripts },
    { type: 'SUPERSEDES', fromId: ID.componentEngine, toId: retired },
    { type: 'APPLIES_TO', fromId: rule, toId: retired },
  );
  // A package still mapped onto the retired Component — the shape topology refresh leaves behind.
  graph.topology.nodes.push(packageNode(qid('package:legacy'), 'packages/legacy'));
  graph.topology.edges.push(
    { type: 'PART_OF', fromId: qid('package:legacy'), toId: ID.workspace },
    { type: 'IMPLEMENTS', fromId: qid('package:legacy'), toId: retired },
  );

  await withGraph(graph, async (port) => {
    const validation = await validateGraph(port, { projectId: PROJECT });
    assert.deepEqual(validation.violations, [], 'the fixture must be B4-clean, or this proves nothing');

    const result = await resolveContext(port, { projectId: PROJECT, paths: ['packages/legacy/x.mjs'] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(idsOf(result.context.rules).includes(rule), true, 'the path must not resolve to nothing');
    // The anchor routed, but it is not itself context, and nothing superseded is returned.
    assert.equal(allItems(result).every((item) => item.status !== 'superseded'), true);
    assert.equal(allItems(result).some((item) => item.id === retired), false);
  });
});

// --- scenario isolation (spec §11): a proposal is never operational context ----------------------

test('an OPEN promotion scenario is invisible to resolution', async () => {
  const graph = baseGraph();
  // Self-contained inside the scenario namespace (no bridge relationship reaches a scenario), so
  // the only thing that could surface it is the resolver reading a namespace it must never read.
  graph.scenarios = {
    's1': {
      nodes: [
        curatedNode('Surface', ID.surfaceScripts),
        ruleNode(qid('rule:scenario-only'), 'external-input'),
      ],
      edges: [{ type: 'APPLIES_TO', fromId: qid('rule:scenario-only'), toId: ID.surfaceScripts }],
    },
  };
  await withGraph(graph, async (port) => {
    const live = await withTransaction(port, (tx) =>
      tx.getNode({ namespace: 'scenario', scenarioId: 's1', id: qid('rule:scenario-only') }),
    );
    assert.ok(live, 'precondition: the scenario really holds the rule');
    const result = await resolveContext(port, { projectId: PROJECT, paths: ['packages/engine/src/a.mjs'] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(idsOf(allItems(result)).includes(qid('rule:scenario-only')), false);
  });
});

// --- RULE_CONFLICT: the resolution-time gate B4 cannot run (spec §7 + §8) ------------------------

// Two Rules sharing a concern, attached at two DIFFERENT levels of one chain — a shape the
// whole-graph validator passes (it judges shared APPLIES_TO targets) and a resolution rooted in the
// nested Component collects together.
function withCrossLevelConflict(graph, overrides = {}) {
  graph.curated.nodes.push(
    ruleNode(qid('rule:naming-surface'), 'naming'),
    ruleNode(qid('rule:naming-engine'), 'naming', overrides),
  );
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: qid('rule:naming-surface'), toId: ID.surfaceScripts },
    { type: 'APPLIES_TO', fromId: qid('rule:naming-engine'), toId: ID.componentEngine },
  );
  return graph;
}

test('the conflicting fixture is VALID for B4 — the gate D2 runs is one B4 structurally cannot', async () => {
  await withGraph(withCrossLevelConflict(baseGraph()), async (port) => {
    const validation = await validateGraph(port, { projectId: PROJECT });
    assert.deepEqual(validation.violations, []);
  });
});

test('two applicable Rules sharing a concern with no OVERRIDES between them is RULE_CONFLICT', async () => {
  const result = await resolve(withCrossLevelConflict(baseGraph()), { paths: ['packages/engine/src/a.mjs'] });
  assert.equal(result.ok, false);
  assert.equal(result.code, RESOLVE_ERROR_CODES.RULE_CONFLICT);
  assert.equal(result.context, undefined);
  assert.equal(result.conflicts.length, 1);
  const [conflict] = result.conflicts;
  assert.equal(conflict.concern, 'naming');
  assert.deepEqual(conflict.ruleIds, [qid('rule:naming-engine'), qid('rule:naming-surface')]);
  assert.deepEqual(conflict.anchors, [
    { ruleId: qid('rule:naming-engine'), anchorIds: [ID.componentEngine] },
    { ruleId: qid('rule:naming-surface'), anchorIds: [ID.surfaceScripts] },
  ]);
  assert.deepEqual(result.identity.conflicts, [{ concern: 'naming', ruleIds: conflict.ruleIds }]);
});

test('an explicit OVERRIDES resolves the conflict: the loser is dropped and recorded on the winner', async () => {
  const graph = withCrossLevelConflict(baseGraph());
  graph.curated.edges.push({
    type: 'OVERRIDES',
    fromId: qid('rule:naming-engine'),
    toId: qid('rule:naming-surface'),
  });
  const result = await resolve(graph, { paths: ['packages/engine/src/a.mjs'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.context.rules.some((item) => item.id === qid('rule:naming-surface')), false);
  const winner = result.context.rules.find((item) => item.id === qid('rule:naming-engine'));
  assert.deepEqual(winner.trace.at(-1), { via: 'OVERRIDES', to: qid('rule:naming-surface') });
  assert.deepEqual(result.diagnostics.overridden, [
    { id: qid('rule:naming-surface'), overriddenBy: qid('rule:naming-engine'), concern: 'naming' },
  ]);
});

// ONE new Rule superseding SEVERAL older same-concern ones is the ordinary authoring shape, and the
// two losers have no OVERRIDES between THEM — nor should they need one. A pair-at-a-time gate that
// judges every pair independently reports that loser pair as an unresolved conflict, hard-failing
// the read path on a graph the product itself certifies valid. Resolution is decided over the GROUP:
// a Rule beaten by anyone in the group is out of the contest before any pair is judged.
test('one winner overriding SEVERAL same-concern Rules resolves them all — losers never conflict with each other', async () => {
  const graph = withCrossLevelConflict(baseGraph());
  graph.curated.nodes.push(ruleNode(qid('rule:naming-cli'), 'naming'));
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: qid('rule:naming-cli'), toId: ID.componentEngine },
    // The Component-level Rule beats BOTH the Surface-level one and this third one.
    { type: 'OVERRIDES', fromId: qid('rule:naming-engine'), toId: qid('rule:naming-surface') },
    { type: 'OVERRIDES', fromId: qid('rule:naming-engine'), toId: qid('rule:naming-cli') },
  );

  await withGraph(graph, async (port) => {
    const validation = await validateGraph(port, { projectId: PROJECT });
    assert.deepEqual(validation.violations, [], 'the fixture must be B4-clean, or this proves nothing');

    const result = await resolveContext(port, { projectId: PROJECT, paths: ['packages/engine/src/a.mjs'] });
    assert.equal(result.ok, true, JSON.stringify(result));
    const naming = idsOf(result.context.rules).filter((id) => id.startsWith(qid('rule:naming-')));
    assert.deepEqual(naming, [qid('rule:naming-engine')], 'the single winner survives');
    assert.deepEqual(result.diagnostics.overridden, [
      { id: qid('rule:naming-cli'), overriddenBy: qid('rule:naming-engine'), concern: 'naming' },
      { id: qid('rule:naming-surface'), overriddenBy: qid('rule:naming-engine'), concern: 'naming' },
    ]);
  });
});

// A loser is out of the contest, so it cannot make a SURVIVOR conflict either: the only real
// conflict here is between the two Rules that nothing overrode.
test('an overridden Rule is out of the contest entirely — only surviving Rules can conflict', async () => {
  const graph = withCrossLevelConflict(baseGraph());
  // At the PACKAGE level — a third distinct level, so no two of the three share an APPLIES_TO
  // target and the graph stays B4-clean while all three are applicable together here.
  graph.curated.nodes.push(ruleNode(qid('rule:naming-package'), 'naming'));
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: qid('rule:naming-package'), toId: ID.packageEngine },
    { type: 'OVERRIDES', fromId: qid('rule:naming-engine'), toId: qid('rule:naming-surface') },
  );

  await withGraph(graph, async (port) => {
    const validation = await validateGraph(port, { projectId: PROJECT });
    assert.deepEqual(validation.violations, [], 'the fixture must be B4-clean, or this proves nothing');

    const result = await resolveContext(port, { projectId: PROJECT, paths: ['packages/engine/src/a.mjs'] });
    assert.equal(result.ok, false);
    assert.equal(result.code, RESOLVE_ERROR_CODES.RULE_CONFLICT);
    assert.equal(result.conflicts.length, 1, 'the beaten Rule must not appear in a second conflict');
    assert.deepEqual(result.conflicts[0].ruleIds, [qid('rule:naming-engine'), qid('rule:naming-package')]);
  });
});

// APPLICABILITY IS PER SEED, NOT PER ANSWER. Asking about two unrelated packages in one call must
// not invent a contradiction between the Rules governing each: they never apply to the same code,
// which is exactly what "overlapping applicability" means. Each input answers for itself and the
// answers union — a union is not an applicability scope.
function withDisjointSameConcern(graph) {
  graph.curated.nodes.push(
    ruleNode(qid('rule:naming-scripts'), 'naming'),
    ruleNode(qid('rule:naming-tests'), 'naming'),
  );
  graph.curated.edges.push(
    { type: 'APPLIES_TO', fromId: qid('rule:naming-scripts'), toId: ID.surfaceScripts },
    { type: 'APPLIES_TO', fromId: qid('rule:naming-tests'), toId: ID.surfaceTests },
  );
  return graph;
}

test('same-concern Rules on DISJOINT chains do not conflict, however many inputs collect them together', async () => {
  const graph = withDisjointSameConcern(baseGraph());
  await withGraph(graph, async (port) => {
    const validation = await validateGraph(port, { projectId: PROJECT });
    assert.deepEqual(validation.violations, [], 'the fixture must be B4-clean, or this proves nothing');

    // Each alone resolves; the two together must not turn into a contradiction.
    for (const paths of [['packages/engine/a.mjs'], ['packages/suites/b.mjs'], ['packages/engine/a.mjs', 'packages/suites/b.mjs']]) {
      const result = await resolveContext(port, { projectId: PROJECT, paths });
      assert.equal(result.ok, true, `${JSON.stringify(paths)} -> ${JSON.stringify(result)}`);
    }
    const union = await resolveContext(port, {
      projectId: PROJECT,
      paths: ['packages/engine/a.mjs', 'packages/suites/b.mjs'],
    });
    const naming = idsOf(union.context.rules).filter((id) => id.startsWith(qid('rule:naming-')));
    assert.deepEqual(naming, [qid('rule:naming-scripts'), qid('rule:naming-tests')], 'both are served');

    // Naming two Rules explicitly is a fetch, not an assertion that they govern the same code.
    const byTarget = await resolveContext(port, {
      projectId: PROJECT,
      targets: ['rule:naming-scripts', 'rule:naming-tests'],
    });
    assert.equal(byTarget.ok, true, JSON.stringify(byTarget));
  });
});

// The other side of the same coin: a Rule beaten within one input's scope is still served for a
// SECOND input whose scope its winner never reached. Dropping it there would delete the only Rule
// governing that package — mandatory knowledge lost to a precedence that does not apply.
test('a Rule overridden in one input\'s scope is still served for another input the winner does not govern', async () => {
  const broad = qid('rule:naming-broad');
  const engineRule = qid('rule:naming-engine');
  const graph = baseGraph();
  graph.curated.nodes.push(ruleNode(broad, 'naming'), ruleNode(engineRule, 'naming'));
  graph.curated.edges.push(
    // The broad Rule governs BOTH Surfaces — including `scripts`, which IS on the engine chain, so
    // it is genuinely collected and genuinely beaten there rather than merely absent.
    { type: 'APPLIES_TO', fromId: broad, toId: ID.surfaceScripts },
    { type: 'APPLIES_TO', fromId: broad, toId: ID.surfaceTests },
    { type: 'APPLIES_TO', fromId: engineRule, toId: ID.componentEngine },
    { type: 'OVERRIDES', fromId: engineRule, toId: broad },
  );
  // Expansion hangs off the Rule's trace, so the correction has to reach it too — a Check rooted at
  // the scope its Rule LOST in is the same defect one level down.
  graph.curated.nodes.push(curatedNode('Check', qid('check:naming-broad')));
  graph.curated.edges.push({ type: 'VERIFIED_BY', fromId: broad, toId: qid('check:naming-broad') });

  await withGraph(graph, async (port) => {
    const validation = await validateGraph(port, { projectId: PROJECT });
    assert.deepEqual(validation.violations, [], 'the fixture must be B4-clean, or this proves nothing');

    // Within the engine package alone, the specific Rule wins and the broad one is dropped OUTRIGHT.
    const engine = await resolveContext(port, { projectId: PROJECT, paths: ['packages/engine/a.mjs'] });
    assert.equal(engine.ok, true, JSON.stringify(engine));
    assert.equal(idsOf(engine.context.rules).includes(broad), false, 'beaten here, so not served here');
    assert.deepEqual(engine.diagnostics.overridden, [{ id: broad, overriddenBy: engineRule, concern: 'naming' }]);

    // Add a second input the winner does not govern: the broad Rule must come back, because it is
    // the only Rule governing THAT package.
    const union = await resolveContext(port, {
      projectId: PROJECT,
      paths: ['packages/engine/a.mjs', 'packages/suites/b.mjs'],
    });
    assert.equal(union.ok, true, JSON.stringify(union));
    assert.equal(idsOf(union.context.rules).includes(broad), true, 'still governs packages/suites');
    assert.equal(idsOf(union.context.rules).includes(engineRule), true);
    assert.deepEqual(union.diagnostics.overridden, [], 'it was not dropped from the answer');

    // Served, but the caller must be able to tell WHERE it does not apply — and its trace must name
    // an input it actually governs, never the one it lost in.
    assert.deepEqual(union.diagnostics.overriddenInScope, [
      { id: broad, overriddenBy: engineRule, concern: 'naming', input: 'packages/engine/a.mjs' },
    ]);
    const served = union.context.rules.find((item) => item.id === broad);
    assert.deepEqual(served.trace[0], { via: TRACE_STEPS.INPUT_PATH, to: 'packages/suites/b.mjs' });
    // Everything derived from that Rule inherits the corrected derivation.
    const check = union.context.checks.find((item) => item.id === qid('check:naming-broad'));
    assert.deepEqual(check.trace[0], { via: TRACE_STEPS.INPUT_PATH, to: 'packages/suites/b.mjs' });
    assert.deepEqual(check.trace.at(-1), { via: 'VERIFIED_BY', to: qid('check:naming-broad') });
  });
});

// On a chain (top beats mid beats low) the INTERMEDIATE is dropped too, so "what applies instead of
// low?" must not answer with `mid` — a Rule that is not in the result. Both diagnostics and the
// winner's trace name the Rule actually served in its place.
test('a transitive OVERRIDES chain names the SURVIVING winner, never a Rule that was itself dropped', async () => {
  const graph = baseGraph();
  const top = qid('rule:naming-top');
  const mid = qid('rule:naming-mid');
  const low = qid('rule:naming-low');
  graph.curated.nodes.push(ruleNode(top, 'naming'), ruleNode(mid, 'naming'), ruleNode(low, 'naming'));
  graph.curated.edges.push(
    // Three different levels of one chain, so no two share a target and B4 stays clean.
    { type: 'APPLIES_TO', fromId: top, toId: ID.packageEngine },
    { type: 'APPLIES_TO', fromId: mid, toId: ID.componentEngine },
    { type: 'APPLIES_TO', fromId: low, toId: ID.surfaceScripts },
    { type: 'OVERRIDES', fromId: top, toId: mid },
    { type: 'OVERRIDES', fromId: mid, toId: low },
  );

  await withGraph(graph, async (port) => {
    const validation = await validateGraph(port, { projectId: PROJECT });
    assert.deepEqual(validation.violations, [], 'the fixture must be B4-clean, or this proves nothing');

    const result = await resolveContext(port, { projectId: PROJECT, paths: ['packages/engine/src/a.mjs'] });
    assert.equal(result.ok, true, JSON.stringify(result));
    const naming = idsOf(result.context.rules).filter((id) => id.startsWith(qid('rule:naming-')));
    assert.deepEqual(naming, [top], 'only the top of the chain survives');

    // Neither diagnostic may name `mid`, which is not in the answer.
    assert.deepEqual(result.diagnostics.overridden, [
      { id: low, overriddenBy: top, concern: 'naming' },
      { id: mid, overriddenBy: top, concern: 'naming' },
    ]);
    const winner = result.context.rules.find((item) => item.id === top);
    const dropped = winner.trace.filter((step) => step.via === 'OVERRIDES').map((step) => step.to);
    assert.deepEqual(dropped.sort(), [low, mid], 'every dropped Rule is recorded on the surviving winner');
  });
});

test('Rules sharing a concern that are NOT collected together do not conflict', async () => {
  // The engine-utils package resolves through Component `cli`, so only the Surface-level Rule of
  // the pair is applicable there.
  const result = await resolve(withCrossLevelConflict(baseGraph()), { paths: ['packages/engine-utils/x.mjs'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(idsOf(result.context.rules).includes(qid('rule:naming-surface')), true);
});

test('a superseded Rule never reaches the conflict gate — lifecycle is filtered first (spec §6)', async () => {
  const result = await resolve(withCrossLevelConflict(baseGraph(), { status: 'superseded' }), {
    paths: ['packages/engine/src/a.mjs'],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(idsOf(result.context.rules).includes(qid('rule:naming-engine')), false);
});

test('a deprecated Rule still conflicts — it is still served, so it still contradicts (spec §6)', async () => {
  const result = await resolve(withCrossLevelConflict(baseGraph(), { status: 'deprecated' }), {
    paths: ['packages/engine/src/a.mjs'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, RESOLVE_ERROR_CODES.RULE_CONFLICT);
});

// --- failure table: GRAPH_INVALID and KNOWLEDGE_GRAPH_UNAVAILABLE -------------------------------

// An active Rule with no APPLIES_TO — a blocking B4 invariant the audit chain happily records.
function withInvariantBreach(graph) {
  graph.curated.nodes.push(ruleNode(qid('rule:scopeless'), 'external-input'));
  return graph;
}

test('a graph that violates a blocking invariant resolves to GRAPH_INVALID with the violations attached', async () => {
  const result = await resolve(withInvariantBreach(baseGraph()), { paths: ['packages/engine/src/a.mjs'] });
  assert.equal(result.ok, false);
  assert.equal(result.code, RESOLVE_ERROR_CODES.GRAPH_INVALID);
  assert.equal(result.context, undefined);
  assert.ok(result.violations.some((found) => found.code === 'ACTIVE_RULE_WITHOUT_SCOPE'));
  assert.equal(result.identity.projectId, PROJECT);
  assert.equal(result.identity.violationCount, result.violations.length);
});

test('a closed port is KNOWLEDGE_GRAPH_UNAVAILABLE — never a Markdown fallback, never a crash', async () => {
  const port = createMemoryPort();
  await seedGraph(port, baseGraph());
  await port.close();
  const result = await resolveContext(port, { projectId: PROJECT, paths: ['packages/engine/src/a.mjs'] });
  assert.equal(result.ok, false);
  assert.equal(result.code, RESOLVE_ERROR_CODES.KNOWLEDGE_GRAPH_UNAVAILABLE);
  assert.equal(result.identity.portCode, 'PORT_CLOSED');
  assert.equal(typeof result.message, 'string');
});

// Additive export, same precedent as `checkVerifiers`: D3 does its OWN port I/O (the §25 digest
// check, the exactly-once `validateGraph` call) before ever reaching `resolveContext`, and must
// report a PortError there in the identical shape — so the two modules report "the graph is
// unavailable" as one function, never two copies that could drift.
test('unavailableError (exported additively) shapes a KNOWLEDGE_GRAPH_UNAVAILABLE failure from a port error', () => {
  const error = { code: 'PORT_CLOSED', message: 'the port is closed', identity: { adapter: 'memory' } };
  const input = { paths: ['a'], targets: [] };
  const result = unavailableError(PROJECT, input, error);
  assert.equal(result.ok, false);
  assert.equal(result.code, RESOLVE_ERROR_CODES.KNOWLEDGE_GRAPH_UNAVAILABLE);
  assert.equal(result.projectId, PROJECT);
  assert.deepEqual(result.input, input);
  assert.deepEqual(result.identity, { projectId: PROJECT, portCode: 'PORT_CLOSED', adapter: 'memory' });
  assert.match(result.message, /PORT_CLOSED/);
  assert.match(result.message, /the port is closed/);
});

test('a pre-computed validation result is honored, so D3 can cache it instead of re-validating', async () => {
  const clean = { ok: true, violations: [], warnings: [] };
  const proceeded = await resolve(withInvariantBreach(baseGraph()), {
    paths: ['packages/engine/src/a.mjs'],
    options: { validation: clean },
  });
  assert.equal(proceeded.ok, true, JSON.stringify(proceeded));

  const injected = { ok: false, violations: [{ code: 'INJECTED', message: 'from the cache', identity: {} }], warnings: [] };
  const refused = await resolve(baseGraph(), {
    paths: ['packages/engine/src/a.mjs'],
    options: { validation: injected },
  });
  assert.equal(refused.code, RESOLVE_ERROR_CODES.GRAPH_INVALID);
  assert.deepEqual(refused.violations, injected.violations);
});

test('resolveContext throws on an unknown option or a malformed injected validation result', async () => {
  const port = createMemoryPort();
  try {
    const paths = ['packages/engine/src/a.mjs'];
    await assert.rejects(() => resolveContext(port, { projectId: PROJECT, paths, options: { cache: true } }), TypeError);
    await assert.rejects(() => resolveContext(port, { projectId: PROJECT, paths, options: { validation: 'ok' } }), TypeError);
    await assert.rejects(() => resolveContext(port, { projectId: PROJECT, paths, options: { validation: { ok: true } } }), TypeError);
  } finally {
    await port.close();
  }
});

// E4 owns the resolver's read accumulation: `readGraph` once accumulated
// `nodes.push(...(await tx.listNodes(...)))` — a spread of the whole curated namespace that throws
// `RangeError: Maximum call stack size exceeded` at the E1 scale (25,521 nodes / 150,000 edges).
// E4's warm-latency measurement runs the resolver at exactly that scale, so the read must
// accumulate with a plain loop (the same amendment E1 made in validate-graph.mjs and E2 in
// revision.mjs). Full fixture on the in-memory port — the same store the E1 suite uses.
test('resolveContext accumulates the graph read in a loop, not a spread, at fixture scale (E4)', async () => {
  const fixture = generateFixture('e4-resolve-accumulation');
  assert.equal(fixture.stats.totalEdges, FIXTURE_TARGET_EDGES, 'the scale must exceed the engine spread-argument limit');
  assert.equal(fixture.nodes.length, 25521, 'the full E1 fixture node count');

  const port = createMemoryPort();
  await loadFixture(port, { projectId: fixture.projectId, fixture });
  const result = await resolveContext(port, {
    projectId: fixture.projectId,
    paths: [fixture.packagePaths[0]],
    targets: [`apex:${fixture.projectId}:rule:r0`],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  // A package chain collects Rules at every level (Package-scope ~180 + Component-scope ~90 +
  // Surface-scope ~900, seed-dependent). The exact counts are seed details; the scale is the
  // contract — an accumulation bug collapses the whole answer to a crash, not to a wrong count.
  assert.ok(result.context.rules.length > 500, `rules ${result.context.rules.length}`);
  assert.ok(result.context.checks.length > 300, `checks ${result.context.checks.length}`);
  assert.ok(result.context.decisions.length > 100, `decisions ${result.context.decisions.length}`);
});
