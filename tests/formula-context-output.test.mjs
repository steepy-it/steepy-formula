// Layered context output for the Stable Knowledge Graph (Task D3, spec §9 + §25). Every case
// drives `buildContextOutput` through a REAL port adapter (the B3 in-memory reference) over a
// fixture seeded through B5 `applyChangeSet` — the same discipline `formula-resolve.test.mjs`
// (D2) uses, reused here rather than re-invented, since this module's whole job is to wrap
// `resolveContext` (D2) and `refreshTopology` (D1) rather than re-derive their answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { applyChangeSet, sha256Hex } from '../scripts/formula/core/revision.mjs';
import { RESOLVE_ERROR_CODES, resolveContext } from '../scripts/formula/core/resolve-context.mjs';
import { TOPOLOGY_CODES } from '../scripts/formula/core/topology.mjs';
import {
  buildContextOutput,
  CONTEXT_SCHEMA_VERSION,
  DEFAULT_CONTEXT_BUDGET,
  CONTEXT_OUTPUT_ERROR_CODES,
  TOPOLOGY_OUTCOMES,
} from '../scripts/formula/core/context-output.mjs';

const PROJECT = 'proj';

function qid(localId) {
  return `apex:${PROJECT}:${localId}`;
}

// --- fixture -------------------------------------------------------------------------------------
//
// One Package -> Component -> Surface -> Project chain, deliberately shaped to exercise EVERY
// layer-assignment branch in one graph (spec §9 binding semantics #1):
//   rule:must-1     (must)    -> component:c1     -> check:must-only, check:both, decision:d1
//   rule:should-1   (should)  -> surface:s1        -> check:should-only, check:both
//   check:both is VERIFIED_BY BOTH rules — the "stronger claim wins" case (must Layer 1).
//   agent:owner (OWNED_BY surface:s1) and skill:sk1 (APPLIES_TO surface:s1) are always Layer 1.
//   term:t1 (USED_BY rule:must-1) is always Layer 2.
//   decision:d1 (MOTIVATED_BY rule:must-1) is Layer 3, excluded unless the rationale flag is set.
const ID = {
  project: qid('project:root'),
  surface: qid('surface:s1'),
  component: qid('component:c1'),
  package: qid('package:p1'),
  workspace: qid('workspace:root'),
  repository: qid('repository:root'),
  agent: qid('agent:owner'),
  skill: qid('skill:sk1'),
  term: qid('term:t1'),
  decision: qid('decision:d1'),
  ruleMust: qid('rule:must-1'),
  ruleShould: qid('rule:should-1'),
  checkMustOnly: qid('check:must-only'),
  checkShouldOnly: qid('check:should-only'),
  checkBoth: qid('check:both'),
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
      provenance: { source: 'spec', line: 9 },
      ...overrides,
    },
  };
}

function packageNode(id, path) {
  return { type: 'Package', id, properties: { id, path } };
}

function baseGraph() {
  return {
    curated: {
      nodes: [
        curatedNode('Project', ID.project),
        curatedNode('Surface', ID.surface),
        curatedNode('Component', ID.component),
        curatedNode('Agent', ID.agent),
        curatedNode('Skill', ID.skill),
        curatedNode('Term', ID.term),
        curatedNode('Decision', ID.decision),
        curatedNode('Check', ID.checkMustOnly),
        curatedNode('Check', ID.checkShouldOnly),
        curatedNode('Check', ID.checkBoth),
        ruleNode(ID.ruleMust, 'must-concern', { strength: 'must' }),
        ruleNode(ID.ruleShould, 'should-concern', { strength: 'should' }),
      ],
      edges: [
        { type: 'PART_OF', fromId: ID.surface, toId: ID.project },
        { type: 'PART_OF', fromId: ID.component, toId: ID.surface },
        { type: 'OWNED_BY', fromId: ID.surface, toId: ID.agent },
        { type: 'APPLIES_TO', fromId: ID.skill, toId: ID.surface },
        { type: 'APPLIES_TO', fromId: ID.ruleMust, toId: ID.component },
        { type: 'APPLIES_TO', fromId: ID.ruleShould, toId: ID.surface },
        { type: 'VERIFIED_BY', fromId: ID.ruleMust, toId: ID.checkMustOnly },
        { type: 'VERIFIED_BY', fromId: ID.ruleShould, toId: ID.checkShouldOnly },
        { type: 'VERIFIED_BY', fromId: ID.ruleMust, toId: ID.checkBoth },
        { type: 'VERIFIED_BY', fromId: ID.ruleShould, toId: ID.checkBoth },
        { type: 'MOTIVATED_BY', fromId: ID.ruleMust, toId: ID.decision },
        { type: 'USED_BY', fromId: ID.term, toId: ID.ruleMust },
      ],
    },
    topology: {
      nodes: [
        { type: 'Repository', id: ID.repository, properties: { id: ID.repository, root: 'demo', digest: 'd'.repeat(64) } },
        { type: 'Workspace', id: ID.workspace, properties: { id: ID.workspace, path: '.' } },
        packageNode(ID.package, 'packages/p1'),
      ],
      edges: [
        { type: 'PART_OF', fromId: ID.workspace, toId: ID.repository },
        { type: 'PART_OF', fromId: ID.package, toId: ID.workspace },
        { type: 'IMPLEMENTS', fromId: ID.package, toId: ID.component },
      ],
    },
  };
}

// A second Component (`c2`, also PART_OF `surface:s1`) plus a second Package (`p2`, IMPLEMENTS
// `c2`), and a same-concern Rule pair: `override-winner` APPLIES_TO `component:c1`,
// `override-loser` APPLIES_TO `surface:s1` (so it is ALSO applicable on the `p1` chain, where the
// winner beats it) — `winner OVERRIDES loser`. On the `p1` chain alone this is a plain drop
// (`diagnostics.overridden`); unioned with a `p2` chain (where the winner never applies, so the
// loser survives there) it becomes `diagnostics.overriddenInScope` instead (D2's own distinction).
const OVERRIDE_ID = {
  componentTwo: qid('component:c2'),
  packageTwo: qid('package:p2'),
  winner: qid('rule:override-winner'),
  loser: qid('rule:override-loser'),
};

function withOverrides(graph) {
  graph.curated.nodes.push(
    curatedNode('Component', OVERRIDE_ID.componentTwo),
    ruleNode(OVERRIDE_ID.winner, 'override-concern'),
    ruleNode(OVERRIDE_ID.loser, 'override-concern'),
  );
  graph.curated.edges.push(
    { type: 'PART_OF', fromId: OVERRIDE_ID.componentTwo, toId: ID.surface },
    { type: 'APPLIES_TO', fromId: OVERRIDE_ID.winner, toId: ID.component },
    { type: 'APPLIES_TO', fromId: OVERRIDE_ID.loser, toId: ID.surface },
    { type: 'OVERRIDES', fromId: OVERRIDE_ID.winner, toId: OVERRIDE_ID.loser },
  );
  graph.topology.nodes.push(packageNode(OVERRIDE_ID.packageTwo, 'packages/p2'));
  graph.topology.edges.push(
    { type: 'PART_OF', fromId: OVERRIDE_ID.packageTwo, toId: ID.workspace },
    { type: 'IMPLEMENTS', fromId: OVERRIDE_ID.packageTwo, toId: OVERRIDE_ID.componentTwo },
  );
  return graph;
}

function meta() {
  return {
    projectId: PROJECT,
    proposer: { type: 'agent-proposer', id: 'scripts-agent' },
    approver: { type: 'human-approver', id: 'steepy-it' },
    provenance: [{ quotation: 'Layered context output.', source: 'docs/spec.md:9', digest: sha256Hex('spec') }],
    timestamp: '2026-08-12T10:00:00.000Z',
  };
}

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

function build(graph, input) {
  return withGraph(graph, (port) => buildContextOutput(port, { projectId: PROJECT, paths: ['packages/p1/x.mjs'], ...input }));
}

// The independent oracle for the exhaustiveness test: every id `resolveContext` (D2) itself
// resolves for the same input, asked directly rather than through the module under test.
async function withGraphIds(graph) {
  return withGraph(graph, async (port) => {
    const resolved = await resolveContext(port, { projectId: PROJECT, paths: ['packages/p1/x.mjs'] });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    return Object.values(resolved.context).flat().map((item) => item.id);
  });
}

function reverseSeedOrder(graph) {
  for (const namespace of ['curated', 'topology']) {
    graph[namespace].nodes.reverse();
    graph[namespace].edges.reverse();
  }
  return graph;
}

// --- module contract ------------------------------------------------------------------------------

test('buildContextOutput throws (programmer error) when the port is missing or is not a port', async () => {
  await assert.rejects(() => buildContextOutput(undefined, { projectId: PROJECT, paths: ['a'] }), TypeError);
  await assert.rejects(() => buildContextOutput({}, { projectId: PROJECT, paths: ['a'] }), TypeError);
});

test('buildContextOutput throws (programmer error) on a missing or malformed projectId', async () => {
  const port = createMemoryPort();
  try {
    await assert.rejects(() => buildContextOutput(port, { paths: ['a'] }), TypeError);
    await assert.rejects(() => buildContextOutput(port, { projectId: 'Not A Project', paths: ['a'] }), TypeError);
  } finally {
    await port.close();
  }
});

test('buildContextOutput throws on an unknown input key or option', async () => {
  const port = createMemoryPort();
  try {
    await assert.rejects(() => buildContextOutput(port, { projectId: PROJECT, paths: ['a'], bogus: 1 }), TypeError);
    await assert.rejects(
      () => buildContextOutput(port, { projectId: PROJECT, paths: ['a'], options: { bogus: 1 } }),
      TypeError,
    );
  } finally {
    await port.close();
  }
});

test('buildContextOutput throws on a malformed rootDir, includeRationale or budget', async () => {
  const port = createMemoryPort();
  try {
    await assert.rejects(() => buildContextOutput(port, { projectId: PROJECT, paths: ['a'], rootDir: '' }), TypeError);
    await assert.rejects(() => buildContextOutput(port, { projectId: PROJECT, paths: ['a'], rootDir: 42 }), TypeError);
    await assert.rejects(
      () => buildContextOutput(port, { projectId: PROJECT, paths: ['a'], options: { includeRationale: 'yes' } }),
      TypeError,
    );
    await assert.rejects(
      () => buildContextOutput(port, { projectId: PROJECT, paths: ['a'], options: { budget: 0 } }),
      TypeError,
    );
    await assert.rejects(
      () => buildContextOutput(port, { projectId: PROJECT, paths: ['a'], options: { budget: 1.5 } }),
      TypeError,
    );
  } finally {
    await port.close();
  }
});

// --- D2 failures pass through unchanged (spec §25) -------------------------------------------------

test('an UNRESOLVED input from resolveContext passes through unchanged — no layers invented', async () => {
  const result = await build(baseGraph(), { paths: ['nowhere/x.mjs'] });
  assert.equal(result.ok, false);
  assert.equal(result.code, RESOLVE_ERROR_CODES.UNRESOLVED);
  assert.equal(result.json, undefined);
  assert.equal(result.markdown, undefined);
  assert.equal(typeof result.message, 'string');
  assert.equal(typeof result.identity, 'object');
});

test('a closed port is KNOWLEDGE_GRAPH_UNAVAILABLE — never a partial artifact, never a crash', async () => {
  const port = createMemoryPort();
  await seedGraph(port, baseGraph());
  await port.close();
  const result = await buildContextOutput(port, { projectId: PROJECT, paths: ['packages/p1/x.mjs'] });
  assert.equal(result.ok, false);
  assert.equal(result.code, RESOLVE_ERROR_CODES.KNOWLEDGE_GRAPH_UNAVAILABLE);
  assert.equal(result.json, undefined);
});

// --- the digest check is optional (spec §9 binding semantics #7) -----------------------------------

test('with no rootDir the digest check is skipped entirely, and Layer 0 records that it was not performed', async () => {
  const result = await build(baseGraph(), {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.json.layer0.topology, {
    performed: false,
    outcome: TOPOLOGY_OUTCOMES.NOT_PERFORMED,
    digest: null,
    changes: null,
    diagnostics: [],
  });
});

// --- §25: the digest check, incremental refresh, and its outcome in Layer 0 ------------------------
//
// `refreshTopology` (D1) is exercised end-to-end by `formula-topology.test.mjs`; these cases are
// narrower — they pin only what D3 does with the OUTCOME, through the injectable `fs` facade
// `detectTopology` already accepts, so no real directory tree is needed.
const FAKE_ROOT = '/fake-repo';

function relativeSelector(path) {
  return (path.startsWith(FAKE_ROOT) ? path.slice(FAKE_ROOT.length) : path).replace(/^\/+/, '');
}

// A minimal in-memory `{ readFile, readdir }` facade matching `nodeFsFacade`'s shape (D1
// `topology.mjs`), built from a flat `{ 'relative/path': object|string }` map — no real filesystem
// touched, consistent with this module's own no-new-dependencies discipline.
function fakeFs(files) {
  return {
    async readFile(path) {
      const relative = relativeSelector(path);
      if (!(relative in files)) {
        const error = new Error(`no such file: ${relative}`);
        error.code = 'ENOENT';
        throw error;
      }
      const content = files[relative];
      return typeof content === 'string' ? content : `${JSON.stringify(content)}\n`;
    },
    async readdir(path) {
      const relative = relativeSelector(path);
      const prefix = relative === '' ? '' : `${relative}/`;
      const names = new Set();
      for (const filePath of Object.keys(files)) {
        if (!filePath.startsWith(prefix)) continue;
        const [first] = filePath.slice(prefix.length).split('/');
        if (first) names.add(first);
      }
      if (names.size === 0) {
        const error = new Error(`no such directory: ${relative}`);
        error.code = 'ENOENT';
        throw error;
      }
      return [...names].map((name) => ({ name, directory: Object.keys(files).some((f) => f.startsWith(`${prefix}${name}/`)) }));
    },
  };
}

// One package ('p1', under `packages/*`) — the root itself declares no `name`, so it is a
// container, not a package, keeping the desired graph to exactly Repository + one Workspace + one
// Package (spec §4/§25).
function workspaceFiles() {
  return {
    'package.json': { private: true, workspaces: ['packages/*'] },
    'packages/p1/package.json': { name: 'p1', version: '1.0.0' },
  };
}

// A curated-only fixture (no topology namespace data at all): the FIRST refresh against it has
// nothing to compare — `readTopologyDigest` returns `null`, which never equals a real digest, so
// the refresh runs unconditionally (the digest-changed case per spec §25).
function curatedOnlyGraph() {
  const graph = baseGraph();
  graph.topology = { nodes: [], edges: [] };
  return graph;
}

test('a digest change (no prior topology at all) runs the refresh and reports it in Layer 0, with what moved', async () => {
  await withGraph(curatedOnlyGraph(), async (port) => {
    const result = await buildContextOutput(port, {
      projectId: PROJECT,
      paths: ['packages/p1/x.mjs'],
      rootDir: FAKE_ROOT,
      options: { fs: fakeFs(workspaceFiles()) },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const { topology } = result.json.layer0;
    assert.equal(topology.performed, true);
    assert.equal(topology.outcome, TOPOLOGY_OUTCOMES.REFRESHED);
    assert.equal(typeof topology.digest, 'string');
    assert.deepEqual(topology.changes.added.sort(), [ID.repository, qid('workspace:packages'), ID.package].sort());
    // The refresh ran BEFORE resolution: the path into the brand-new Package now resolves (empty
    // context — the refresh never invents an IMPLEMENTS edge — but resolvable, where before the
    // refresh the Package did not exist at all).
    assert.deepEqual(result.json.layer1.rules, []);
  });
});

test('an unchanged repository does not write, and Layer 0 reports it', async () => {
  await withGraph(curatedOnlyGraph(), async (port) => {
    const call = () =>
      buildContextOutput(port, {
        projectId: PROJECT,
        paths: ['packages/p1/x.mjs'],
        rootDir: FAKE_ROOT,
        options: { fs: fakeFs(workspaceFiles()) },
      });
    const first = await call();
    assert.equal(first.json.layer0.topology.outcome, TOPOLOGY_OUTCOMES.REFRESHED);

    const second = await call();
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.deepEqual(second.json.layer0.topology, {
      performed: true,
      outcome: TOPOLOGY_OUTCOMES.UNCHANGED,
      digest: first.json.layer0.topology.digest,
      changes: null,
      diagnostics: [],
    });
  });
});

test('a refresh that cannot read the repository is reported STALE, and resolution still answers from the last valid topology', async () => {
  const result = await build(baseGraph(), {
    rootDir: FAKE_ROOT,
    options: { fs: fakeFs({}) }, // no root manifest at all
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const { topology } = result.json.layer0;
  assert.equal(topology.performed, true);
  assert.equal(topology.outcome, TOPOLOGY_OUTCOMES.STALE);
  assert.ok(topology.diagnostics.length > 0);
  // The graph's PRE-EXISTING topology (baseGraph's `packages/p1`) is still what resolution reads —
  // a refusal to refresh is never re-raised as a resolution failure (spec §25 failure table).
  assert.deepEqual(result.json.layer1.rules.map((item) => item.id), [ID.ruleMust]);
});

// --- schemaVersion is the FIRST key (spec §9 binding semantics #5) --------------------------------

test('context.json carries schemaVersion as its first key', async () => {
  const result = await build(baseGraph(), {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(Object.keys(result.json)[0], 'schemaVersion');
  assert.equal(result.json.schemaVersion, CONTEXT_SCHEMA_VERSION);
  assert.equal(result.json.projectId, PROJECT);
});

// --- layer assignment (spec §9 binding semantics #1) ------------------------------------------------

test('Layer 1 holds must Rules, Agents, Skills, and the Check reached by a must Rule', async () => {
  const result = await build(baseGraph(), {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.json.layer1.rules.map((item) => item.id), [ID.ruleMust]);
  assert.deepEqual(result.json.layer1.agents.map((item) => item.id), [ID.agent]);
  assert.deepEqual(result.json.layer1.skills.map((item) => item.id), [ID.skill]);
  assert.deepEqual(
    result.json.layer1.checks.map((item) => item.id).sort(),
    [ID.checkMustOnly, ID.checkBoth].sort(),
  );
});

test('Layer 2 holds should Rules, Terms, and the Check reached ONLY by a should Rule', async () => {
  const result = await build(baseGraph(), {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.json.layer2.rules.map((item) => item.id), [ID.ruleShould]);
  assert.deepEqual(result.json.layer2.terms.map((item) => item.id), [ID.term]);
  assert.deepEqual(result.json.layer2.checks.map((item) => item.id), [ID.checkShouldOnly]);
});

// `check:both` is VERIFIED_BY BOTH a must and a should Rule — the ONE case that distinguishes "the
// stronger claim wins" from "first Rule collected wins" (which `resolveContext`'s own `trace` would
// give, since it only ever keeps ONE derivation). This is the load-bearing assertion of the whole
// layer-assignment feature.
test('a Check reached by both a must and a should Rule is Layer 1 — the stronger claim wins', async () => {
  const result = await build(baseGraph(), {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.json.layer1.checks.some((item) => item.id === ID.checkBoth), true);
  assert.equal(result.json.layer2.checks.some((item) => item.id === ID.checkBoth), false);
});

test('Layer 3 holds Decisions only when explicitly requested', async () => {
  const withoutFlag = await build(baseGraph(), {});
  assert.deepEqual(withoutFlag.json.layer3.decisions, []);

  const withFlag = await build(baseGraph(), { options: { includeRationale: true } });
  assert.deepEqual(withFlag.json.layer3.decisions.map((item) => item.id), [ID.decision]);
});

// The rationale flag silences Layer 3 entirely (spec §9 binding semantics #2), which is
// indistinguishable at the JSON level from "nothing was resolved" — a caller who names a Decision
// by TARGET and gets `ok: true` with every layer empty and no explanation is in exactly the family
// of silent drop the brief forbids (§9: "silent truncation is the one thing this must never do").
// `layer0.excludedByRationale` names every Decision that resolution actually reached and the
// rationale flag alone kept out — new field, `schemaVersion` is 1 and unshipped so this is not a
// contract break.
test('a Decision excluded ONLY by the rationale flag is named in layer0.excludedByRationale', async () => {
  const withoutFlag = await withGraph(baseGraph(), (port) =>
    buildContextOutput(port, { projectId: PROJECT, targets: ['decision:d1'] }),
  );
  assert.equal(withoutFlag.ok, true, JSON.stringify(withoutFlag));
  assert.deepEqual(withoutFlag.json.layer3.decisions, [], 'precondition: Layer 3 really is silent');
  assert.deepEqual(withoutFlag.json.layer0.excludedByRationale, [{ id: ID.decision, layer: 3 }]);

  const withFlag = await withGraph(baseGraph(), (port) =>
    buildContextOutput(port, { projectId: PROJECT, targets: ['decision:d1'], options: { includeRationale: true } }),
  );
  assert.equal(withFlag.ok, true, JSON.stringify(withFlag));
  assert.deepEqual(withFlag.json.layer3.decisions.map((item) => item.id), [ID.decision]);
  assert.deepEqual(withFlag.json.layer0.excludedByRationale, [], 'nothing is silenced once the flag is set');
});

test('layer0.excludedByRationale is empty when resolution reaches no Decision at all', async () => {
  const result = await withGraph(baseGraph(), (port) =>
    buildContextOutput(port, { projectId: PROJECT, targets: ['agent:owner'] }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.json.layer0.excludedByRationale, []);
});

// `layer0` hand-builds its object from named `diagnostics` fields rather than spreading D2's
// `diagnostics` wholesale — deliberately (`checkVerifiers` is an INDEX for layer assignment, not a
// diagnostic, and must not leak into Layer 0 as if it were one). That hand-listing is exactly the
// kind of thing that silently drifts when D2 adds a field later: this guards it, so a future
// `diagnostics` key with no opinion here fails LOUD instead of vanishing from Layer 0 quietly.
test('Layer 0 accounts for every D2 diagnostics field except the documented index (checkVerifiers)', async () => {
  const result = await build(baseGraph(), {});
  assert.equal(result.ok, true, JSON.stringify(result));
  const resolved = await withGraph(baseGraph(), (port) =>
    resolveContext(port, { projectId: PROJECT, paths: ['packages/p1/x.mjs'] }),
  );
  assert.equal(resolved.ok, true, JSON.stringify(resolved));

  const NOT_A_LAYER0_DIAGNOSTIC = ['checkVerifiers']; // an index, documented and deliberate
  for (const key of Object.keys(resolved.diagnostics)) {
    if (NOT_A_LAYER0_DIAGNOSTIC.includes(key)) continue;
    assert.ok(key in result.json.layer0, `Layer 0 is missing D2 diagnostics field '${key}'`);
  }
});

// Every resolved item lands in EXACTLY one layer — not eyeballed, asserted: the union of every
// layer bucket's ids, deduplicated, must equal the union of every `context` bucket's ids, with no
// id appearing twice across the four layers.
test('every resolved item lands in exactly one layer (exhaustiveness)', async () => {
  const result = await build(baseGraph(), { options: { includeRationale: true } });
  assert.equal(result.ok, true, JSON.stringify(result));

  const resolved = await withGraphIds(baseGraph());
  const layerIds = [
    ...result.json.layer1.rules,
    ...result.json.layer1.checks,
    ...result.json.layer1.agents,
    ...result.json.layer1.skills,
    ...result.json.layer2.rules,
    ...result.json.layer2.checks,
    ...result.json.layer2.terms,
    ...result.json.layer3.decisions,
  ].map((item) => item.id);

  assert.equal(new Set(layerIds).size, layerIds.length, 'no item is double-counted across layers');
  assert.deepEqual(layerIds.slice().sort(), resolved.slice().sort());
});

// The rationale flag strips `provenance` from Layer 1-2 items when unset, and restores it — plus
// Layer 3 in full — when set. Identity, statement (via `properties`) and `trace` survive either way.
test('the rationale flag governs Layer 1-2 provenance and Layer 3 presence, nothing else', async () => {
  const withoutFlag = await build(baseGraph(), {});
  const must = withoutFlag.json.layer1.rules.find((item) => item.id === ID.ruleMust);
  assert.equal('provenance' in must.properties, false);
  assert.equal(must.properties.title, `Rule ${ID.ruleMust}`);
  assert.ok(Array.isArray(must.trace) && must.trace.length > 0);

  const withFlag = await build(baseGraph(), { options: { includeRationale: true } });
  const mustWithRationale = withFlag.json.layer1.rules.find((item) => item.id === ID.ruleMust);
  assert.deepEqual(mustWithRationale.properties.provenance, { source: 'spec', line: 9 });
});

// --- target-seeded input coverage (spec §8: paths AND/OR explicit targets) -------------------------
//
// Every case above seeds through `paths`. `resolveContext` treats a Check named as an explicit
// TARGET differently from one reached by chain expansion (§8 — only Rules and chain anchors expand;
// a directly-targeted Check is kept standalone, per `resolve-context.mjs`'s seed handling), so
// `diagnostics.checkVerifiers` legitimately has NO entry for a Check reached that way. `Check` is a
// `RESOLVABLE_TARGET_KINDS` member and D2 answers `ok: true` for it — this module must too (binding
// semantics #8: never throw on a data condition).

test('a Check named as an explicit target, with no verifying Rule in the answer, lands in Layer 2 — not a throw', async () => {
  const result = await withGraph(baseGraph(), (port) =>
    buildContextOutput(port, { projectId: PROJECT, targets: ['check:should-only'] }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.json.layer2.checks.map((item) => item.id), [ID.checkShouldOnly]);
  assert.deepEqual(result.json.layer1.checks, []);
});

// The more counter-intuitive half of the same rule: `check:must-only` IS verified by a `must` Rule
// in the GRAPH, but that Rule is not part of THIS answer (only the Check was targeted) — so nothing
// in the answer actually REQUIRES it. §9's Layer 1 is "required Checks", not "Checks that could be
// required by some Rule somewhere in the graph" — and letting a caller inflate the never-truncated
// Layer 1 floor just by naming Checks would make `CONTEXT_OVERFLOW`'s threshold caller-controlled.
test('a Check that IS must-verified in the graph still lands in Layer 2 when that Rule is absent from this answer', async () => {
  const result = await withGraph(baseGraph(), (port) =>
    buildContextOutput(port, { projectId: PROJECT, targets: ['check:must-only'] }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.json.layer2.checks.map((item) => item.id), [ID.checkMustOnly]);
});

// Targeting the VERIFYING Rule too pulls the Check back to Layer 1 through the normal expansion —
// pinning that the fix above narrows nothing beyond the specific gap. `rule:must-1` VERIFIED_BYs
// BOTH `check:must-only` and `check:both` (fixture), so targeting it pulls both into Layer 1.
test('a Check lands in Layer 1 when its must Rule IS part of this answer too', async () => {
  const result = await withGraph(baseGraph(), (port) =>
    buildContextOutput(port, { projectId: PROJECT, targets: ['check:must-only', 'rule:must-1'] }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    result.json.layer1.checks.map((item) => item.id).sort(),
    [ID.checkMustOnly, ID.checkBoth].sort(),
  );
});

// From the INPUT CONTRACT (`RESOLVABLE_TARGET_KINDS`), not from the fixture already made green
// above: every kind `resolveContext` can RETURN as a context item (`CONTEXT_KINDS`) is reachable as
// a direct target and must resolve — and land in exactly one layer — with no path anywhere in the
// call.
test('every returnable kind, reached ONLY via direct targets (no path), resolves and lands in exactly one layer', async () => {
  const targets = [
    'rule:must-1',
    'rule:should-1',
    'check:must-only',
    'check:should-only',
    'check:both',
    'agent:owner',
    'skill:sk1',
    'term:t1',
    'decision:d1',
  ];
  const result = await withGraph(baseGraph(), (port) =>
    buildContextOutput(port, { projectId: PROJECT, targets, options: { includeRationale: true } }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));

  const oracleIds = await withGraph(baseGraph(), async (port) => {
    const resolved = await resolveContext(port, { projectId: PROJECT, targets });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    return Object.values(resolved.context).flat().map((item) => item.id);
  });

  const layerIds = [
    ...result.json.layer1.rules,
    ...result.json.layer1.checks,
    ...result.json.layer1.agents,
    ...result.json.layer1.skills,
    ...result.json.layer2.rules,
    ...result.json.layer2.checks,
    ...result.json.layer2.terms,
    ...result.json.layer3.decisions,
  ].map((item) => item.id);

  assert.equal(new Set(layerIds).size, layerIds.length, 'no item is double-counted across layers');
  assert.deepEqual(layerIds.slice().sort(), oracleIds.slice().sort());
  // Spot checks, so a future regression names the WRONG layer rather than merely an incomplete union.
  assert.equal(result.json.layer1.rules.some((item) => item.id === ID.ruleMust), true);
  assert.equal(result.json.layer2.rules.some((item) => item.id === ID.ruleShould), true);
  assert.equal(result.json.layer1.checks.some((item) => item.id === ID.checkBoth), true);
  assert.equal(result.json.layer1.agents.some((item) => item.id === ID.agent), true);
  assert.equal(result.json.layer1.skills.some((item) => item.id === ID.skill), true);
  assert.equal(result.json.layer2.terms.some((item) => item.id === ID.term), true);
  assert.equal(result.json.layer3.decisions.some((item) => item.id === ID.decision), true);
});

// --- determinism (spec §9 binding semantics #5): same input + same graph state -> byte-identical --

test('the same input on the same graph state is BYTE-IDENTICAL, whatever order the graph was seeded in', async () => {
  const forward = await build(baseGraph(), { options: { includeRationale: true } });
  const backward = await build(reverseSeedOrder(baseGraph()), { options: { includeRationale: true } });
  assert.equal(forward.ok, true, JSON.stringify(forward));
  assert.equal(JSON.stringify(backward.json), JSON.stringify(forward.json));

  // The determinism claim matters MOST where the order-dependent state actually lives — the drop
  // queue built from the (reverse) result order — so run it again at a budget that genuinely
  // truncates (verified below, not assumed), not only at the default (unbounded) budget above.
  const truncatingBudget = 3300;
  const forwardTruncated = await build(baseGraph(), { options: { includeRationale: true, budget: truncatingBudget } });
  const backwardTruncated = await build(reverseSeedOrder(baseGraph()), {
    options: { includeRationale: true, budget: truncatingBudget },
  });
  assert.equal(forwardTruncated.ok, true, JSON.stringify(forwardTruncated));
  assert.ok(forwardTruncated.json.layer0.truncated.length > 0, 'precondition: this budget must actually truncate something');
  assert.equal(JSON.stringify(backwardTruncated.json), JSON.stringify(forwardTruncated.json));
});

// --- the deterministic budget (spec §9 binding semantics #3-#4) ------------------------------------
//
// Every size in this block is measured empirically against THIS fixture (probed once, then pinned
// as a literal) rather than computed inline — computing the expected size with the same arithmetic
// the module uses would test the arithmetic against itself and prove nothing.
const FLOOR_SIZE = 2616; // layer0 + layer1 alone, rationale off, layer2/layer3 empty
const FULL_SIZE = 4025; // the whole fixture, rationale off

test('Layer 0 + Layer 1 alone exceeding the budget is CONTEXT_OVERFLOW, never a truncated must Rule', async () => {
  const result = await build(baseGraph(), { options: { budget: FLOOR_SIZE - 1 } });
  assert.equal(result.ok, false);
  assert.equal(result.code, CONTEXT_OUTPUT_ERROR_CODES.CONTEXT_OVERFLOW);
  assert.equal(result.identity.measured, FLOOR_SIZE);
  assert.equal(result.identity.budget, FLOOR_SIZE - 1);
  assert.equal(result.json, undefined);
});

test('a budget that exactly fits the floor size does NOT overflow', async () => {
  const result = await build(baseGraph(), { options: { budget: FLOOR_SIZE } });
  assert.equal(result.ok, true, JSON.stringify(result));
  // Layer 2 has nothing left to give at exactly the floor — everything optional is truncated.
  assert.deepEqual(
    result.json.layer0.truncated.map((entry) => entry.id).sort(),
    [ID.term, ID.checkShouldOnly, ID.ruleShould].sort(),
  );
});

test('a budget that fits the whole answer truncates nothing', async () => {
  const result = await build(baseGraph(), { options: { budget: FULL_SIZE } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.json.layer0.truncated, []);
  assert.deepEqual(result.json.layer2.rules.map((item) => item.id), [ID.ruleShould]);
});

// Reverse result order (spec §9 binding semantics #4): Layer 2's fixed kind-then-id order is
// [rule:should-1, check:should-only, term:t1] — the LAST item (term:t1) drops FIRST.
test('a partial overflow drops the LAST Layer 2 item first, in reverse result order', async () => {
  const oneOver = await build(baseGraph(), { options: { budget: FULL_SIZE - 1 } });
  assert.equal(oneOver.ok, true, JSON.stringify(oneOver));
  assert.deepEqual(oneOver.json.layer0.truncated, [{ id: ID.term, layer: 2 }]);
  assert.equal(oneOver.json.layer2.terms.some((item) => item.id === ID.term), false);
  assert.deepEqual(oneOver.json.layer2.checks.map((item) => item.id), [ID.checkShouldOnly]);
  assert.deepEqual(oneOver.json.layer2.rules.map((item) => item.id), [ID.ruleShould]);

  const twoOver = await build(baseGraph(), { options: { budget: 3550 } });
  assert.equal(twoOver.ok, true, JSON.stringify(twoOver));
  assert.deepEqual(twoOver.json.layer0.truncated, [
    { id: ID.term, layer: 2 },
    { id: ID.checkShouldOnly, layer: 2 },
  ]);
  assert.deepEqual(twoOver.json.layer2.rules.map((item) => item.id), [ID.ruleShould]);
});

// Layer 3 drops entirely BEFORE any Layer 2 item — even though Layer 3's own item (`decision:d1`)
// is smaller than the Layer 2 items still being kept at this budget.
test('Layer 3 items drop before Layer 2 items', async () => {
  const result = await build(baseGraph(), { options: { includeRationale: true, budget: 4200 } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.json.layer0.truncated, [{ id: ID.decision, layer: 3 }]);
  assert.deepEqual(result.json.layer3.decisions, []);
  // Layer 2 is untouched — the whole budget shortfall was absorbed by Layer 3 alone.
  assert.deepEqual(result.json.layer2.rules.map((item) => item.id), [ID.ruleShould]);
  assert.deepEqual(result.json.layer2.terms.map((item) => item.id), [ID.term]);
});

// The flag moves the floor in BOTH directions at once on `baseGraph()`: ON adds `properties.
// provenance` back to Layer 1's one Rule, but ALSO empties `layer0.excludedByRationale` (which is
// non-empty OFF, since the fixture's one Decision is always reached). Those two happen to net out
// to the exact same floor size on this fixture — which is precisely why this test measures both
// floors AT RUNTIME (`budget: 1` forces `CONTEXT_OVERFLOW`, whose `identity.measured` reports the
// true floor) on a fixture engineered so the flag's cost strictly dominates, rather than trusting a
// hand-picked literal that this exact coincidence would have made silently vacuous.
function withDominantProvenance(graph) {
  const rule = graph.curated.nodes.find((node) => node.id === ID.ruleMust);
  rule.properties.provenance = { source: 'spec', line: 9, quotation: 'x'.repeat(200) };
  return graph;
}

test('the rationale flag raising the floor can turn a fitting budget into CONTEXT_OVERFLOW', async () => {
  const graph = withDominantProvenance(baseGraph());
  const probeWithout = await build(graph, { options: { budget: 1 } });
  const probeWith = await build(graph, { options: { includeRationale: true, budget: 1 } });
  assert.equal(probeWithout.ok, false);
  assert.equal(probeWith.ok, false);
  const floorWithout = probeWithout.identity.measured;
  const floorWith = probeWith.identity.measured;
  assert.ok(floorWith > floorWithout, `precondition: rationale must raise the floor (${floorWith} vs ${floorWithout})`);

  const budget = floorWith - 1;
  const fitsWithoutRationale = await build(graph, { options: { budget } });
  assert.equal(fitsWithoutRationale.ok, true, JSON.stringify(fitsWithoutRationale));

  const withFlag = await build(graph, { options: { includeRationale: true, budget } });
  assert.equal(withFlag.ok, false);
  assert.equal(withFlag.identity.measured, floorWith);
});

// context.md is a VIEW of context.json (spec §9 binding semantics #6): it must never contain an
// item absent from context.json. Asserted by construction — grep every item id context.json
// carries and confirm the markdown mentions it, then confirm a TRUNCATED id does not appear.
test('context.md never contains an item absent from context.json', async () => {
  const result = await build(baseGraph(), { options: { includeRationale: true, budget: FULL_SIZE - 1 } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const present = [
    ...result.json.layer1.rules,
    ...result.json.layer1.checks,
    ...result.json.layer1.agents,
    ...result.json.layer1.skills,
    ...result.json.layer2.rules,
    ...result.json.layer2.checks,
    ...result.json.layer2.terms,
    ...result.json.layer3.decisions,
  ];
  assert.ok(present.length > 0);
  for (const item of present) assert.ok(result.markdown.includes(item.id), `markdown is missing ${item.id}`);

  assert.ok(result.json.layer0.truncated.length > 0, 'precondition: something was actually truncated');
  for (const dropped of result.json.layer0.truncated) {
    assert.equal(present.some((item) => item.id === dropped.id), false, `${dropped.id} should have been dropped from json too`);
    // The actual view invariant: a dropped id may legitimately be MENTIONED once, in Layer 0's own
    // `truncated` listing (which is itself part of context.json) — but it must never ALSO be
    // rendered as a served item in a Layer 1-3 section. Exactly one occurrence proves that; a
    // markdown built from pre-truncation layer data would render it a second time and this would
    // catch it, where a blanket "does not appear at all" assertion would wrongly fail on the
    // Layer 0 listing itself.
    const occurrences = result.markdown.split(dropped.id).length - 1;
    assert.equal(occurrences, 1, `${dropped.id} must appear exactly once in markdown (Layer 0's truncated listing only)`);
  }
});

// §9 lists CONFLICTS among Layer 0's diagnostics, and context.md is what an agent/human actually
// reads — `overridden` (dropped outright) and `overriddenInScope` (served, but not for this input)
// must both reach the rendered artifact, not just the JSON one. (`unresolved` is always `[]` on a
// success path — D2's own comment — so it is not rendered; nothing to show.)
test("context.md renders Layer 0's overridden Rules", async () => {
  const result = await build(withOverrides(baseGraph()), { paths: ['packages/p1/x.mjs'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.json.layer0.overridden, [
    { id: OVERRIDE_ID.loser, overriddenBy: OVERRIDE_ID.winner, concern: 'override-concern' },
  ]);
  assert.ok(result.markdown.includes(OVERRIDE_ID.loser), 'the overridden Rule id must be rendered');
  assert.ok(result.markdown.includes(OVERRIDE_ID.winner), 'what replaced it must be rendered too');
});

test("context.md renders Layer 0's overriddenInScope Rules", async () => {
  const result = await build(withOverrides(baseGraph()), {
    paths: ['packages/p1/x.mjs', 'packages/p2/y.mjs'],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.json.layer0.overriddenInScope, [
    { id: OVERRIDE_ID.loser, overriddenBy: OVERRIDE_ID.winner, concern: 'override-concern', input: 'packages/p1/x.mjs' },
  ]);
  // The loser is actually SERVED here (D2: beaten in one scope, kept in another) — its markdown
  // mention in the Layer 0 section is IN ADDITION to its normal layer rendering, not instead of it.
  assert.ok(result.json.layer1.rules.some((item) => item.id === OVERRIDE_ID.loser), 'still served (must strength)');
  assert.ok(result.markdown.includes('packages/p1/x.mjs'), 'the scope it does NOT apply in must be named');
});

// Same reasoning as the two tests above, applied to the OTHER silent-drop this round fixed: a
// human/agent reading context.md (not context.json) must be told a Decision was silenced by the
// rationale flag too, or the artifact they actually read still goes quiet with no explanation.
test("context.md renders layer0.excludedByRationale", async () => {
  const result = await withGraph(baseGraph(), (port) =>
    buildContextOutput(port, { projectId: PROJECT, targets: ['decision:d1'] }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.json.layer0.excludedByRationale, [{ id: ID.decision, layer: 3 }]);
  assert.ok(result.markdown.includes(ID.decision), 'the silenced Decision id must be rendered');
});

test('DEFAULT_CONTEXT_BUDGET is a positive integer configuration value', () => {
  assert.equal(Number.isInteger(DEFAULT_CONTEXT_BUDGET), true);
  assert.ok(DEFAULT_CONTEXT_BUDGET > 0);
});

test('CONTEXT_OUTPUT_ERROR_CODES declares CONTEXT_OVERFLOW', () => {
  assert.equal(CONTEXT_OUTPUT_ERROR_CODES.CONTEXT_OVERFLOW, 'CONTEXT_OVERFLOW');
});
