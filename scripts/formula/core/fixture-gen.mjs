// Deterministic scale fixture generator for the Stable Knowledge Graph (spec
// .formula/work/specs/2026-08-11-stable-knowledge-graph.md §16 "Performance envelope", plan task E1).
// Produces the acceptance fixture the bake-off measures against — 500 Packages, 25,000 curated
// stable nodes, 150,000 relationships — plus any smaller valid scale for smoke tests. Consumed by
// E2 (eliminatory veto) and E4 (envelope measurement), and by D3's context-budget calibration.
//
//   generateFixture(seed, { scale? }) -> fixture
//   fixtureStats(nodes, edges)         -> { curatedNodes, topologyNodes, packages, totalEdges, ... }
//   loadFixture(port, { projectId, fixture })  writes nodes+edges+system metadata in ONE transaction
//
// CONTRACT OF THE GENERATED FIXTURE:
//   - the DEFAULT fixture (scale 1) holds EXACTLY 25,000 curated nodes, 500 Packages and 150,000
//     relationships (asserted by the suite, and by the code below at scale 1);
//   - the same seed always produces the identical fixture (byte-identical `digest`); a different
//     seed produces a different fixture — strength, category and the package targets each Rule
//     APPLIES_TO are drawn from a seeded pure-JS PRNG, so the wiring varies while the counts do
//     not;
//   - the fixture is VALID under B4 (`checkGraphState` → no violations, no warnings): every
//     curated node is semantically reachable from the Project root, every active Rule has a scope
//     and a concern (unique per Rule, so no unresolved conflict can arise), every Rule has at
//     least one VERIFIED_BY Check, every Check/Decision/Agent is anchored by at least one edge,
//     no cycles, no duplicate qualified IDs, no cross-project edges;
//   - topology nodes (Repository/Workspace/Package) live in the `topology` namespace, the curated
//     graph in `curated`; Package→Component is the IMPLEMENTS bridge (home `topology`), Rule→
//     Package APPLIES_TO is the APPLIES_TO bridge (home `curated`) — the two declared
//     cross-namespace relationships (port.mjs `BRIDGE_RELATIONSHIPS`);
//   - `loadFixture` writes the `GraphMetadata` system record (schema version) so `validateGraph`
//     passes; loading is direct port CRUD in ONE transaction — this is a generated TEST fixture,
//     not a governed promotion, so no `applyChangeSet` and no Revision chain are involved.
//
// EDGE BUDGET (scale 1, exactly 150,000): topology 1,020 (500 Package→Workspace + 20
// Workspace→Repository + 500 IMPLEMENTS); curated 148,980 (20 Surface→Project + 200
// Component→Surface + 126,000 Rule APPLIES_TO [7 per Rule] + 18,050 VERIFIED_BY [1 per Rule,
// 50 Rules with a second Check] + 2,631 MOTIVATED_BY [1 per Decision + 1,031 extras] + 1,500
// USED_BY + 380 OWNED_BY + 199 Skill APPLIES_TO). The MOTIVATED_BY extra is derived so the grand
// total lands exactly on 150,000 at scale 1.

import { GRAPH_SCHEMA_VERSION } from './ontology.mjs';
import { buildQualifiedId, isValidProjectId } from './ids.mjs';
import { systemRecordId, SYSTEM_RECORD_TYPE } from './validate-graph.mjs';
import { canonicalize, sha256Hex } from './revision.mjs';
import { withTransaction } from '../engine/port.mjs';

// --- envelope (spec §16 acceptance targets) -------------------------------------------------------

export const FIXTURE_TARGET_PACKAGES = 500;
export const FIXTURE_TARGET_CURATED_NODES = 25000;
export const FIXTURE_TARGET_EDGES = 150000;

export const FIXTURE_ENVELOPE = deepFreeze({
  projectId: 'fixture',
  surfaces: 20,
  componentsPerSurface: 10,
  rules: 18000,
  checks: 3100,
  decisions: 1600,
  terms: 1500,
  agents: 380,
  skills: 199,
  workspaces: 20,
  packages: FIXTURE_TARGET_PACKAGES,
});

// Every Rule gets exactly 7 APPLIES_TO targets (its Component, that Component's Surface, and 5
// Packages); Rule strength is `must` with this probability (the rest `should`).
export const RULE_TARGETS_PER_RULE = 7;
export const RULE_PACKAGE_TARGETS_PER_RULE = 5;
export const MUST_RATIO = 0.3;

const CATEGORIES = deepFreeze(['security', 'testing', 'architecture', 'api', 'data', 'quality', 'performance', 'process']);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// --- seeded PRNG (pure JS, no dependencies; FNV-1a string hash -> mulberry32) -----------------------

function hashSeed(seed) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed | 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- scale ----------------------------------------------------------------------------------------

function scaleCounts(scale) {
  const max1 = (value) => Math.max(1, Math.round(value * scale));
  const envelope = FIXTURE_ENVELOPE;
  return {
    projectId: envelope.projectId,
    surfaces: max1(envelope.surfaces),
    componentsPerSurface: max1(envelope.componentsPerSurface),
    rules: max1(envelope.rules),
    checks: max1(envelope.checks),
    decisions: max1(envelope.decisions),
    terms: max1(envelope.terms),
    agents: max1(envelope.agents),
    skills: max1(envelope.skills),
    workspaces: max1(envelope.workspaces),
    packages: max1(envelope.packages),
  };
}

// Every edge type except MOTIVATED_BY, counted at the given scale. MOTIVATED_BY is the absorbing
// type whose extra edges land the grand total exactly on the target at scale 1.
function nonMotivatedEdgeTotal(cfg) {
  const components = cfg.surfaces * cfg.componentsPerSurface;
  const topology = cfg.packages * 2 + cfg.workspaces;
  const curated =
    cfg.surfaces +
    components +
    cfg.rules * RULE_TARGETS_PER_RULE +
    (cfg.rules + Math.min(cfg.rules, 50)) +
    cfg.terms +
    cfg.agents +
    cfg.skills;
  return topology + curated;
}

// The MOTIVATED_BY edges on top of the one-per-Decision baseline that make scale 1 land exactly on
// FIXTURE_TARGET_EDGES. Derived, never hardcoded: if the envelope changes, this stays correct.
const MOTIVATED_EXTRA = FIXTURE_TARGET_EDGES - nonMotivatedEdgeTotal(scaleCounts(1)) - FIXTURE_ENVELOPE.decisions;

// --- construction ---------------------------------------------------------------------------------

function nodeRecords(cfg, random) {
  const components = cfg.surfaces * cfg.componentsPerSurface;
  const qid = (localId) => buildQualifiedId(cfg.projectId, localId);
  const nodes = [];
  const push = (namespace, type, localId, properties) =>
    nodes.push({ namespace, type, id: qid(localId), properties: { id: qid(localId), ...properties } });

  push('curated', 'Project', 'project:root', { status: 'active' });
  for (let index = 0; index < cfg.surfaces; index += 1) {
    push('curated', 'Surface', `surface:s${index}`, { status: 'active' });
  }
  for (let index = 0; index < components; index += 1) {
    push('curated', 'Component', `component:c${index}`, { status: 'active' });
  }
  for (let index = 0; index < cfg.checks; index += 1) {
    push('curated', 'Check', `check:k${index}`, { status: 'active' });
  }
  for (let index = 0; index < cfg.decisions; index += 1) {
    push('curated', 'Decision', `decision:d${index}`, { status: 'active' });
  }
  for (let index = 0; index < cfg.terms; index += 1) {
    push('curated', 'Term', `term:t${index}`, { status: 'active' });
  }
  for (let index = 0; index < cfg.agents; index += 1) {
    push('curated', 'Agent', `agent:a${index}`, { status: 'active' });
  }
  for (let index = 0; index < cfg.skills; index += 1) {
    push('curated', 'Skill', `skill:y${index}`, { status: 'active' });
  }
  for (let index = 0; index < cfg.rules; index += 1) {
    const strength = random() < MUST_RATIO ? 'must' : 'should';
    const category = CATEGORIES[Math.floor(random() * CATEGORIES.length)];
    push('curated', 'Rule', `rule:r${index}`, {
      status: 'active',
      title: `Rule ${index}: ${category}`,
      statement: `Rule ${index} governs ${category} behaviour.`,
      strength,
      category,
      concern: `concern-${index}`,
      provenance: { source: 'fixture-gen', line: index },
    });
  }

  push('topology', 'Repository', 'repository:root', {});
  for (let index = 0; index < cfg.workspaces; index += 1) {
    push('topology', 'Workspace', `workspace:w${index}`, { path: index === 0 ? '.' : `workspaces/ws-${index}` });
  }
  for (let index = 0; index < cfg.packages; index += 1) {
    push('topology', 'Package', `package:p${index}`, { path: `packages/pkg-${String(index).padStart(3, '0')}` });
  }

  return { nodes, components };
}

function distinctPackages(random, packageCount) {
  const picked = new Set();
  while (picked.size < RULE_PACKAGE_TARGETS_PER_RULE) {
    picked.add(Math.floor(random() * packageCount));
  }
  return [...picked];
}

function edgeRecords(cfg, components, scale, random) {
  const qid = (localId) => buildQualifiedId(cfg.projectId, localId);
  const edges = [];
  const push = (namespace, type, fromLocal, toLocal) =>
    edges.push({ namespace, type, fromId: qid(fromLocal), toId: qid(toLocal) });

  for (let index = 0; index < cfg.packages; index += 1) {
    push('topology', 'PART_OF', `package:p${index}`, `workspace:w${index % cfg.workspaces}`);
  }
  for (let index = 0; index < cfg.workspaces; index += 1) {
    push('topology', 'PART_OF', `workspace:w${index}`, 'repository:root');
  }
  for (let index = 0; index < cfg.packages; index += 1) {
    push('topology', 'IMPLEMENTS', `package:p${index}`, `component:c${index % components}`);
  }

  for (let index = 0; index < cfg.surfaces; index += 1) {
    push('curated', 'PART_OF', `surface:s${index}`, 'project:root');
  }
  for (let index = 0; index < components; index += 1) {
    push('curated', 'PART_OF', `component:c${index}`, `surface:s${Math.floor(index / cfg.componentsPerSurface)}`);
  }

  for (let index = 0; index < cfg.rules; index += 1) {
    const component = index % components;
    const surface = Math.floor(component / cfg.componentsPerSurface);
    push('curated', 'APPLIES_TO', `rule:r${index}`, `component:c${component}`);
    push('curated', 'APPLIES_TO', `rule:r${index}`, `surface:s${surface}`);
    for (const picked of distinctPackages(random, cfg.packages)) {
      push('curated', 'APPLIES_TO', `rule:r${index}`, `package:p${picked}`);
    }
  }

  for (let index = 0; index < cfg.rules; index += 1) {
    push('curated', 'VERIFIED_BY', `rule:r${index}`, `check:k${index % cfg.checks}`);
  }
  const secondChecks = Math.min(cfg.rules, 50);
  for (let index = 0; index < secondChecks; index += 1) {
    push('curated', 'VERIFIED_BY', `rule:r${index}`, `check:k${(index * 7 + 1) % cfg.checks}`);
  }

  for (let index = 0; index < cfg.decisions; index += 1) {
    push('curated', 'MOTIVATED_BY', `rule:r${index % cfg.rules}`, `decision:d${index}`);
  }
  const motivatedExtra = Math.round(MOTIVATED_EXTRA * scale);
  for (let index = 0; index < motivatedExtra; index += 1) {
    push('curated', 'MOTIVATED_BY', `rule:r${(index * 7 + 3) % cfg.rules}`, `decision:d${index % cfg.decisions}`);
  }

  for (let index = 0; index < cfg.terms; index += 1) {
    push('curated', 'USED_BY', `term:t${index}`, `component:c${index % components}`);
  }
  for (let index = 0; index < cfg.agents; index += 1) {
    if (index < cfg.surfaces) push('curated', 'OWNED_BY', `surface:s${index}`, `agent:a${index}`);
    else push('curated', 'OWNED_BY', `component:c${(index - cfg.surfaces) % components}`, `agent:a${index}`);
  }
  for (let index = 0; index < cfg.skills; index += 1) {
    if (index % 2 === 0) push('curated', 'APPLIES_TO', `skill:y${index}`, `surface:s${index % cfg.surfaces}`);
    else push('curated', 'APPLIES_TO', `skill:y${index}`, `component:c${index % components}`);
  }

  return edges;
}

// --- deterministic ordering for the digest ----------------------------------------------------------

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortNodes(nodes) {
  return [...nodes].sort((a, b) => compareStrings(a.namespace, b.namespace) || compareStrings(a.id, b.id));
}

function sortEdges(edges) {
  return [...edges].sort(
    (a, b) =>
      compareStrings(a.namespace, b.namespace) ||
      compareStrings(a.type, b.type) ||
      compareStrings(a.fromId, b.fromId) ||
      compareStrings(a.toId, b.toId),
  );
}

// --- stats ----------------------------------------------------------------------------------------

export function fixtureStats(nodes, edges) {
  const curatedNodes = nodes.filter((node) => node.namespace === 'curated').length;
  const topologyNodes = nodes.filter((node) => node.namespace === 'topology').length;
  const packages = nodes.filter((node) => node.namespace === 'topology' && node.type === 'Package').length;
  const nodesByType = {};
  const edgesByType = {};
  for (const node of nodes) {
    nodesByType[`${node.namespace}:${node.type}`] = (nodesByType[`${node.namespace}:${node.type}`] ?? 0) + 1;
  }
  for (const edge of edges) {
    edgesByType[`${edge.namespace}:${edge.type}`] = (edgesByType[`${edge.namespace}:${edge.type}`] ?? 0) + 1;
  }
  return { curatedNodes, topologyNodes, packages, totalEdges: edges.length, nodesByType, edgesByType };
}

// --- public API -----------------------------------------------------------------------------------

function normalizeGenerateInput(seed, options) {
  if (typeof seed !== 'string' || seed === '') {
    throw new TypeError('generateFixture requires a non-empty string seed.');
  }
  if (options === undefined || options === null) options = {};
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('generateFixture options must be a plain object.');
  }
  for (const key of Object.keys(options)) {
    if (key !== 'scale') {
      throw new TypeError(`generateFixture: unknown option '${key}'; accepted: scale.`);
    }
  }
  const scale = options.scale ?? 1;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new TypeError('generateFixture scale must be a finite number in (0, 1].');
  }
  return { scale };
}

// Generates the deterministic fixture. The same (seed, scale) always produces the identical
// `digest`; at scale 1 the counts are exactly the §16 envelope.
export function generateFixture(seed, options = {}) {
  const { scale } = normalizeGenerateInput(seed, options);
  const cfg = scaleCounts(scale);
  if (cfg.packages < RULE_PACKAGE_TARGETS_PER_RULE || cfg.rules < cfg.checks || cfg.checks < 1 || cfg.componentsPerSurface < 1) {
    throw new TypeError(
      `generateFixture scale ${scale} is too small: it yields packages ${cfg.packages}, rules ${cfg.rules}, checks ${cfg.checks} — packages must be >= ${RULE_PACKAGE_TARGETS_PER_RULE}, rules must be >= checks, both must be >= 1.`,
    );
  }

  const random = mulberry32(hashSeed(seed));
  const { nodes, components } = nodeRecords(cfg, random);
  const edges = edgeRecords(cfg, components, scale, random);

  const sortedNodes = sortNodes(nodes);
  const sortedEdges = sortEdges(edges);
  const digest = sha256Hex(canonicalize({ nodes: sortedNodes, edges: sortedEdges }));
  const stats = fixtureStats(sortedNodes, sortedEdges);

  return {
    projectId: cfg.projectId,
    seed,
    scale,
    nodes: sortedNodes,
    edges: sortedEdges,
    packagePaths: Array.from({ length: cfg.packages }, (_, index) => `packages/pkg-${String(index).padStart(3, '0')}`),
    digest,
    stats,
  };
}

// Writes a generated fixture into the port in ONE transaction: all curated + topology nodes, all
// edges (bridges included, from their home namespaces), then the `GraphMetadata` system record so
// `validateGraph` passes. Direct port CRUD — a test fixture loader, never a promotion path.
export async function loadFixture(port, input = {}) {
  if (!port || typeof port.begin !== 'function') {
    throw new TypeError('loadFixture requires a port with a begin() method.');
  }
  const { projectId, fixture } = input;
  for (const key of Object.keys(input)) {
    if (!['projectId', 'fixture'].includes(key)) {
      throw new TypeError(`loadFixture: unknown input key '${key}'; accepted: projectId, fixture.`);
    }
  }
  if (!isValidProjectId(projectId)) {
    throw new TypeError(`loadFixture requires a valid projectId, got ${JSON.stringify(projectId)}.`);
  }
  if (!fixture || !Array.isArray(fixture.nodes) || !Array.isArray(fixture.edges)) {
    throw new TypeError('loadFixture requires a fixture with nodes and edges arrays.');
  }

  return withTransaction(port, async (tx) => {
    for (const node of fixture.nodes) {
      tx.createNode({ namespace: node.namespace, type: node.type, id: node.id, properties: node.properties });
    }
    for (const edge of fixture.edges) {
      tx.createEdge({ namespace: edge.namespace, type: edge.type, fromId: edge.fromId, toId: edge.toId });
    }
    tx.createNode({
      namespace: 'system',
      type: SYSTEM_RECORD_TYPE,
      id: systemRecordId(projectId),
      properties: { schemaVersion: GRAPH_SCHEMA_VERSION, headRevision: null },
    });
  });
}
