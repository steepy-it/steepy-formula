// Portable graph validator for the Stable Knowledge Graph (spec
// .formula/work/specs/2026-08-11-stable-knowledge-graph.md "Required graph invariants", §5, §6, §7,
// §10, §24). This is the governance heart: `GRAPH_INVALID` (failure table), promotion validation
// (§11) and schema migration (§27) all decide on the results returned here.
//
//   validateGraph(port, { projectId, scenarioIds?, options? })
//     -> { ok, violations: [{ code, message, identity }], warnings: [...] }
//
// `ok` is true exactly when `violations` is empty — warnings never block. Results are sorted by
// `code`, then by a canonical rendering of `identity`, so the same graph always produces the same
// bytes regardless of the order an adapter returned its records in.
//
// PORT-ONLY I/O (spec §20). Every read goes through the B3 port API inside ONE transaction, so the
// validator sees a consistent snapshot and runs identically on any adapter — memory, ArcadeDB,
// Neo4j. It touches no filesystem: facts the graph cannot hold (does a path selector still match?
// how full is the context budget?) arrive through `options` from the caller that measured them.
// It never throws on graph content — malformed content IS the output. It throws only on programmer
// error (no port, no projectId, an unknown input/option key), and it lets port errors propagate
// (an unavailable database is `KNOWLEDGE_GRAPH_UNAVAILABLE`, the caller's mapping, not a violation).
//
// NO TABLE IS RE-ENCODED HERE. Legal node types, required/unknown properties, legal relationship
// endpoints and the schema version come from `ontology.mjs` (B1); qualified-ID syntax and the
// cross-project rejection predicate come from `ids.mjs` (B2). Their violation objects are passed
// through verbatim, enriched with the offending node/edge identity. So `violations` may carry B1/B2
// codes as well as the B4-owned codes in `GRAPH_VIOLATION_CODES` — consumers must not assume the
// exported vocabulary is the closed set.
//
// THE GRAPH UNDER VALIDATION is the union of the `curated` and `topology` namespaces: one project's
// stable graph. Reading them together is deliberate — the port keeps namespaces disjoint and lets
// the same id exist in both, so a duplicate identity ACROSS namespaces is exactly the kind of fault
// no engine can catch for us. It is also what makes the two declared cross-namespace relationships
// (port.mjs `BRIDGE_RELATIONSHIPS`: `IMPLEMENTS` topology -> curated, `APPLIES_TO` curated ->
// topology) judgeable at all: their endpoints are resolved in the SAME ordered namespace pair the
// adapters linked them with (`resolveEdgeEndpoints`), never by bare id. The `system` namespace holds
// metadata (below) and the `scenario` namespace holds promotion scenarios; neither is part of the
// closed ontology, so neither is type-validated here.
//
// ---------------------------------------------------------------------------------------------
// SYSTEM RECORD CONTRACT (pinned here; B5 Revisions and D4/D5 promotion build on exactly this)
//
//   namespace `system`, id `apex:<projectId>:system:graph`, type `GraphMetadata`, properties:
//     { schemaVersion: <integer>, headRevision: <string qualified id | null> }
//
//   - The TYPE is part of the contract and is enforced: a record of another type is not this record
//     (`INVALID_METADATA_RECORD_TYPE`). Metadata records are outside the closed ontology, so nothing
//     else would ever notice.
//   - `schemaVersion` is compared to B1's `GRAPH_SCHEMA_VERSION`; absent record or absent property
//     is blocking, an unsupported value is blocking (spec: "obsolete or unsupported graph schema
//     version" → refuse normal operation, require an explicit migration).
//   - `headRevision` names the current head Revision node, or is `null` for a graph that has had no
//     promotion yet (an absent property reads as `null` — same meaning). B4 does NOT verify the
//     Revision chain — that is B5's replay.
//
// SCENARIO RECORD CONTRACT (same rationale)
//
//   namespace `scenario` + `scenarioId`, id `apex:<projectId>:scenario:meta`,
//   type `PromotionScenario`, properties: { baseRevision: <string qualified id | null>, ... }
//
//   - A scenario is checked only when the caller names it in `scenarioIds` (duplicates collapse):
//     the port partitions scenarios by `scenarioId` and offers no enumeration, so the graph itself
//     cannot tell us which scenarios are open. Its type is enforced like the system record's.
//   - `baseRevision` must equal the current `headRevision` (`null` === "based on the empty graph"),
//     otherwise the proposal can no longer be applied safely — blocking here, surfaced as
//     `PROMOTION_STALE` by D5. An absent record or absent property is blocking too: an unanchored
//     scenario cannot be shown to be safe.
//   - Scenario CONTENT is not structurally validated here: a scenario holds a delta, and D4 owns
//     materializing the applied graph before validating it.
// ---------------------------------------------------------------------------------------------

import {
  CURATED_NODE_TYPE_NAMES,
  GRAPH_SCHEMA_VERSION,
  isSupportedSchemaVersion,
  validateNodeProperties,
  validateRelationship,
} from './ontology.mjs';
import {
  assertSameProject,
  buildQualifiedId,
  isValidProjectId,
  parseQualifiedId,
  validateQualifiedId,
} from './ids.mjs';
import { SCENARIO_NAMESPACE, endpointNamespaces, withTransaction } from '../engine/port.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function violation(code, message, identity) {
  return { code, message, identity };
}

// --- namespaces read ---------------------------------------------------------------------------
// Names belong to the port's vocabulary (`NAMESPACES` in engine/port.mjs); they are spelled locally
// here rather than re-exported, so there is one owner of the strings.

const CURATED_NAMESPACE = 'curated';
const TOPOLOGY_NAMESPACE = 'topology';
const SYSTEM_NAMESPACE = 'system';

// The two namespaces whose union IS the stable graph (see header).
const STABLE_NAMESPACES = deepFreeze([CURATED_NAMESPACE, TOPOLOGY_NAMESPACE]);

// --- system / scenario record contract ---------------------------------------------------------

export const SYSTEM_RECORD_TYPE = 'GraphMetadata';
export const SCENARIO_META_TYPE = 'PromotionScenario';

export function systemRecordId(projectId) {
  return buildQualifiedId(projectId, 'system:graph');
}

export function scenarioMetaId(projectId) {
  return buildQualifiedId(projectId, 'scenario:meta');
}

// --- vocabulary ----------------------------------------------------------------------------------

// Codes B4 itself raises. B1/B2 codes also appear in `violations` (see header) — this is the
// B4-owned set, not the closed set.
export const GRAPH_VIOLATION_CODES = deepFreeze({
  DUPLICATE_QUALIFIED_ID: 'DUPLICATE_QUALIFIED_ID',
  BROKEN_RELATIONSHIP_ENDPOINT: 'BROKEN_RELATIONSHIP_ENDPOINT',
  RELATIONSHIP_CYCLE: 'RELATIONSHIP_CYCLE',
  ACTIVE_RULE_WITHOUT_SCOPE: 'ACTIVE_RULE_WITHOUT_SCOPE',
  UNRESOLVED_RULE_CONFLICT: 'UNRESOLVED_RULE_CONFLICT',
  PROJECT_ROOT_MISSING: 'PROJECT_ROOT_MISSING',
  UNREACHABLE_FROM_PROJECT_ROOT: 'UNREACHABLE_FROM_PROJECT_ROOT',
  INVALID_METADATA_RECORD_TYPE: 'INVALID_METADATA_RECORD_TYPE',
  SCHEMA_VERSION_MISSING: 'SCHEMA_VERSION_MISSING',
  UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_SCHEMA_VERSION',
  SCENARIO_BASE_REVISION_MISSING: 'SCENARIO_BASE_REVISION_MISSING',
  SCENARIO_BASE_REVISION_INCOMPATIBLE: 'SCENARIO_BASE_REVISION_INCOMPATIBLE',
});

// Every warning the spec's warning list names. `SEMANTIC_NEAR_DUPLICATE` is defined but has no
// detector in V1: hybrid retrieval is deferred (§10), and the code exists so the vocabulary — and
// every consumer switching on it — is already complete when a detector arrives.
export const GRAPH_WARNING_CODES = deepFreeze({
  PACKAGE_SELECTOR_MATCHES_NOTHING: 'PACKAGE_SELECTOR_MATCHES_NOTHING',
  DEPRECATED_WITHOUT_REPLACEMENT: 'DEPRECATED_WITHOUT_REPLACEMENT',
  SHOULD_RULE_WITHOUT_CHECK: 'SHOULD_RULE_WITHOUT_CHECK',
  CONTEXT_NEAR_BUDGET: 'CONTEXT_NEAR_BUDGET',
  OVERSIZED_BODY: 'OVERSIZED_BODY',
  SEMANTIC_NEAR_DUPLICATE: 'SEMANTIC_NEAR_DUPLICATE',
});

// --- input contract ------------------------------------------------------------------------------

const INPUT_KEYS = deepFreeze(['projectId', 'scenarioIds', 'options']);
const OPTION_KEYS = deepFreeze(['packageSelectorMatchCounts', 'budget', 'maxBodyLength']);

// Characters of explanatory `body` beyond which a node is "excessively large" — roughly a thousand
// tokens, i.e. a body that will dominate any resolved context it appears in. A default (rather than
// options-only) so the warning is live in V1; D3 owns calibrating it as configuration.
export const DEFAULT_MAX_BODY_LENGTH = 4000;

// Share of the budget above which context counts as "close to" it.
export const DEFAULT_BUDGET_NEAR_RATIO = 0.9;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(input, accepted, what) {
  for (const key of Object.keys(input)) {
    if (!accepted.includes(key)) {
      throw new TypeError(`validateGraph: unknown ${what} '${key}'; accepted: ${accepted.join(', ')}.`);
    }
  }
}

function normalizeInput(port, input) {
  if (!port || typeof port.begin !== 'function') {
    throw new TypeError('validateGraph requires a port with a begin() method.');
  }
  if (!isPlainObject(input)) {
    throw new TypeError('validateGraph requires an input object with a projectId.');
  }
  rejectUnknownKeys(input, INPUT_KEYS, 'input key');

  const { projectId, scenarioIds = [], options = {} } = input;
  if (!isValidProjectId(projectId)) {
    throw new TypeError(`validateGraph requires a valid projectId, got ${JSON.stringify(projectId)}.`);
  }
  if (!Array.isArray(scenarioIds) || scenarioIds.some((id) => typeof id !== 'string' || id === '')) {
    throw new TypeError('validateGraph: scenarioIds must be an array of non-empty strings.');
  }
  if (!isPlainObject(options)) {
    throw new TypeError('validateGraph: options must be a plain object.');
  }
  rejectUnknownKeys(options, OPTION_KEYS, 'option');

  // Deduplicated: a caller naming the same scenario twice must not double every violation about it.
  return { projectId, scenarioIds: [...new Set(scenarioIds)], options: normalizeOptions(options) };
}

function isCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// Two warnings need facts no graph can hold: whether a path selector still matches anything on disk,
// and how full the context budget is. The validator does no filesystem or resolution work (port-only
// I/O), so the caller that measured them passes them in — D1's topology refresh and D3's budget
// accounting respectively. WITHOUT THEM THOSE TWO WARNINGS SIMPLY CANNOT FIRE, by design: silence
// here means "not measured", never "measured and fine".
function normalizeOptions(options) {
  const { packageSelectorMatchCounts, budget, maxBodyLength = DEFAULT_MAX_BODY_LENGTH } = options;

  // `null` is this function's OWN normalized value for "not measured" — tolerated so the function
  // is idempotent: `validateGraph` pre-normalizes its options and `checkGraphState` (which shares
  // this pass with it) normalizes again. Without that, the second pass would throw on its own output.
  if (
    packageSelectorMatchCounts !== undefined &&
    packageSelectorMatchCounts !== null &&
    (!isPlainObject(packageSelectorMatchCounts) || !Object.values(packageSelectorMatchCounts).every(isCount))
  ) {
    throw new TypeError('validateGraph: options.packageSelectorMatchCounts must map node ids to match counts.');
  }
  if (!(typeof maxBodyLength === 'number' && Number.isFinite(maxBodyLength) && maxBodyLength > 0)) {
    throw new TypeError('validateGraph: options.maxBodyLength must be a positive number of characters.');
  }

  return {
    packageSelectorMatchCounts: packageSelectorMatchCounts ?? null,
    budget: budget === undefined || budget === null ? null : normalizeBudget(budget),
    maxBodyLength,
  };
}

const BUDGET_KEYS = deepFreeze(['limit', 'used', 'nearRatio']);

// Rebuilt field by field rather than spread over a default: `{ nearRatio: undefined }` must mean
// "unspecified, use the default", not "compare against undefined" — which would quietly turn the
// warning off for a caller who thought they had configured it.
function normalizeBudget(budget) {
  if (!isPlainObject(budget)) {
    throw new TypeError('validateGraph: options.budget must be { limit: > 0, used: >= 0, nearRatio?: 0 < r <= 1 }.');
  }
  rejectUnknownKeys(budget, BUDGET_KEYS, 'options.budget key');

  const nearRatio = budget.nearRatio ?? DEFAULT_BUDGET_NEAR_RATIO;
  if (
    !(typeof budget.limit === 'number' && Number.isFinite(budget.limit) && budget.limit > 0) ||
    !isCount(budget.used) ||
    !(typeof nearRatio === 'number' && nearRatio > 0 && nearRatio <= 1)
  ) {
    throw new TypeError('validateGraph: options.budget must be { limit: > 0, used: >= 0, nearRatio?: 0 < r <= 1 }.');
  }
  return { limit: budget.limit, used: budget.used, nearRatio };
}

// --- reading (port API only, one transaction) -----------------------------------------------------

// Reads the stable graph plus the metadata records the invariants need. Sorting here (nodes by id,
// edges by type/from/to) is what makes the whole result deterministic: `listNodes`/`listEdges` order
// is explicitly NOT part of the port contract.
async function readGraph(port, projectId, scenarioIds) {
  return withTransaction(port, async (tx) => {
    const nodes = [];
    const edges = [];
    // Accumulate in a loop, not a spread: at the E1 scale fixture (25k curated nodes, 150k
    // relationships) `nodes.push(...listNodes(...))` blows the call stack on the spread argument
    // list. Behavior is identical; only the accumulation shape changed.
    for (const namespace of STABLE_NAMESPACES) {
      for (const node of await tx.listNodes({ namespace })) nodes.push(node);
      for (const edge of await tx.listEdges({ namespace })) edges.push(edge);
    }
    const system = await tx.getNode({ namespace: SYSTEM_NAMESPACE, id: systemRecordId(projectId) });
    const scenarios = [];
    for (const scenarioId of scenarioIds) {
      scenarios.push({
        scenarioId,
        meta: await tx.getNode({
          namespace: SCENARIO_NAMESPACE,
          scenarioId,
          id: scenarioMetaId(projectId),
        }),
      });
    }
    nodes.sort((a, b) => compareStrings(`${a.id} ${a.namespace}`, `${b.id} ${b.namespace}`));
    edges.sort((a, b) =>
      compareStrings(
        `${a.type} ${a.fromId} ${a.toId} ${a.namespace}`,
        `${b.type} ${b.fromId} ${b.toId} ${b.namespace}`,
      ),
    );
    return { nodes, edges, system, scenarios };
  });
}

// --- deterministic ordering -------------------------------------------------------------------

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Canonical rendering of an identity bag: keys sorted at every depth, so two identities built with
// different key insertion orders compare (and sort) identically.
function identityKey(identity) {
  return JSON.stringify(identity, (_key, value) =>
    isPlainObject(value)
      ? Object.fromEntries(Object.keys(value).sort(compareStrings).map((key) => [key, value[key]]))
      : value,
  );
}

function sortResults(items) {
  return [...items].sort(
    (a, b) => compareStrings(a.code, b.code) || compareStrings(identityKey(a.identity), identityKey(b.identity)),
  );
}

// --- endpoint resolution (spec §5 + the port's bridge table) --------------------------------------

// An edge is resolved in ITS OWN namespace pair, never by bare id. Most edges resolve inside their
// own namespace; the two declared bridge relationships (port.mjs `BRIDGE_RELATIONSHIPS`) resolve
// their far endpoint in the partner namespace when it is not in the home one — the same ordered
// search the adapters used to CREATE the edge, so the validator judges the endpoint the engine
// actually linked. Resolving by bare id would judge a topology edge against a curated namesake
// (itself a blocking DUPLICATE_QUALIFIED_ID) and report a second, invented endpoint-type fault.
function scopeKey(namespace, id) {
  return `${namespace} ${id}`;
}

function resolveEdgeEndpoints(edges, nodesByScope) {
  const resolved = new Map();
  for (const edge of edges) {
    const candidates = endpointNamespaces(edge.namespace, edge.type);
    const ends = {};
    for (const endpoint of ['fromId', 'toId']) {
      ends[endpoint] =
        candidates[endpoint]
          .map((namespace) => nodesByScope.get(scopeKey(namespace, edge[endpoint])))
          .find((node) => node !== undefined) ?? null;
    }
    resolved.set(edge, { from: ends.fromId, to: ends.toId });
  }
  return resolved;
}

// True when both endpoints of `edge` resolved — the precondition every graph-shaped check
// (cycles, scope, reachability, warnings) shares: a broken endpoint is reported once, by
// `checkEdges`, and the edge takes part in nothing else.
function isLinked(edge, endpoints) {
  const found = endpoints.get(edge);
  return Boolean(found?.from && found?.to);
}

// --- node-level checks (B1/B2 delegation) --------------------------------------------------------

function nodeIdentity(node, extra = {}) {
  return { id: node.id, type: node.type, namespace: node.namespace, ...extra };
}

// Duplicate qualified ID: the same id carried by more than one node of the stable graph. Within one
// scope the port already makes this impossible (NODE_EXISTS); ACROSS namespaces it is legal storage
// (the port lets the same id exist in several scopes) and a domain-level identity collision, so this
// validator is the only place it can be caught.
function checkDuplicateIds(nodes, violations) {
  const byId = new Map();
  for (const node of nodes) {
    if (!byId.has(node.id)) byId.set(node.id, []);
    byId.get(node.id).push(node);
  }
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    const namespaces = group.map((node) => node.namespace).sort(compareStrings);
    violations.push(
      violation(
        GRAPH_VIOLATION_CODES.DUPLICATE_QUALIFIED_ID,
        `Qualified ID '${id}' is carried by ${group.length} nodes (namespaces: ${namespaces.join(', ')}); an ID identifies exactly one node.`,
        { id, namespaces },
      ),
    );
  }
}

// Identity syntax (B2) and the closed typed schema (B1), verbatim — enriched with the node identity
// so a caller can locate the fault without parsing messages.
function checkNodes(nodes, violations) {
  for (const node of nodes) {
    for (const found of validateQualifiedId(node.id)) {
      violations.push(violation(found.code, found.message, { ...found.identity, ...nodeIdentity(node) }));
    }
    for (const found of validateNodeProperties(node.type, node.properties)) {
      violations.push(violation(found.code, found.message, { ...found.identity, ...nodeIdentity(node) }));
    }
  }
}

// --- edge-level checks ---------------------------------------------------------------------------

function edgeIdentity(edge, extra = {}) {
  return { relationship: edge.type, fromId: edge.fromId, toId: edge.toId, namespace: edge.namespace, ...extra };
}

// Per edge, in this order — each step is skipped once an earlier one has already condemned the edge,
// so one fault produces one violation instead of a pile of consequential noise:
//   1. both endpoints must resolve to a node of the graph (BROKEN_RELATIONSHIP_ENDPOINT);
//   2. the ontology's closed relationship table (B1) judges the triple, minus the UNKNOWN_NODE_TYPE
//      findings the node check already made;
//   3. both endpoints must belong to the same project (B2, spec §24).
function checkEdges(edges, endpoints, violations) {
  for (const edge of edges) {
    const found = endpoints.get(edge);
    let broken = false;
    for (const [endpoint, node] of [['fromId', found.from], ['toId', found.to]]) {
      if (node) continue;
      const id = edge[endpoint];
      broken = true;
      violations.push(
        violation(
          GRAPH_VIOLATION_CODES.BROKEN_RELATIONSHIP_ENDPOINT,
          `Relationship '${edge.type}' ${edge.fromId} -> ${edge.toId} has a broken ${endpoint} endpoint: no node '${id}' exists.`,
          edgeIdentity(edge, { endpoint, missingId: id }),
        ),
      );
    }
    if (broken) continue;

    const fromType = found.from.type;
    const toType = found.to.type;

    // B1 judges the whole triple in one call, and everything it says is forwarded verbatim — except
    // UNKNOWN_NODE_TYPE, which `checkNodes` already reported against the offending node; repeating it
    // once per incident edge would turn one fault into a pile. Nothing here re-states B1's tables.
    for (const found of validateRelationship(edge.type, fromType, toType)) {
      if (found.code === 'UNKNOWN_NODE_TYPE') continue;
      violations.push(violation(found.code, found.message, { ...found.identity, ...edgeIdentity(edge) }));
    }

    for (const found of assertSameProject(edge.fromId, edge.toId)) {
      // Malformed endpoint ids were already reported against their nodes; only the cross-project
      // judgement is this check's own contribution.
      if (found.code !== 'CROSS_PROJECT_RELATIONSHIP') continue;
      violations.push(violation(found.code, found.message, { ...found.identity, ...edgeIdentity(edge) }));
    }
  }
}

// --- cycles (spec §7: cycles in PART_OF, OVERRIDES and SUPERSEDES are invalid) -------------------

// The three hierarchies that must stay acyclic: containment, conflict resolution, and lifecycle
// history. Each is walked on its OWN edges — a ring that alternates relationship types is not a
// cycle in any of them, and calling it one would block legal graphs.
export const ACYCLIC_RELATIONSHIPS = deepFreeze(['PART_OF', 'OVERRIDES', 'SUPERSEDES']);

// Rotates a ring so it starts at its smallest id: `b -> c -> a` and `c -> a -> b` are the same cycle
// and must produce the same identity, whichever node the walk happened to enter it from.
function canonicalCycle(ring) {
  let start = 0;
  for (let index = 1; index < ring.length; index += 1) {
    if (compareStrings(ring[index], ring[start]) < 0) start = index;
  }
  return [...ring.slice(start), ...ring.slice(0, start)];
}

// Iterative depth-first search (an explicit stack — a curated graph is small, but a validator must
// not blow the call stack on a pathological import). Nodes and successors are visited in sorted
// order so the reported ring is the same on every adapter and every run.
function findCycles(relationship, edges, endpoints) {
  const successors = new Map();
  for (const edge of edges) {
    if (edge.type !== relationship) continue;
    if (!isLinked(edge, endpoints)) continue;
    if (!successors.has(edge.fromId)) successors.set(edge.fromId, []);
    successors.get(edge.fromId).push(edge.toId);
  }
  for (const list of successors.values()) list.sort(compareStrings);

  const cycles = new Map();
  const state = new Map(); // id -> 'open' while on the current path, 'done' once fully explored
  for (const root of [...successors.keys()].sort(compareStrings)) {
    if (state.has(root)) continue;
    const path = [];
    const stack = [{ id: root, next: 0 }];
    state.set(root, 'open');
    path.push(root);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const children = successors.get(frame.id) ?? [];
      if (frame.next >= children.length) {
        state.set(frame.id, 'done');
        path.pop();
        stack.pop();
        continue;
      }
      const child = children[frame.next];
      frame.next += 1;
      if (state.get(child) === 'open') {
        const ring = canonicalCycle(path.slice(path.indexOf(child)));
        cycles.set(ring.join(' -> '), ring);
        continue;
      }
      if (state.get(child) === 'done') continue;
      state.set(child, 'open');
      path.push(child);
      stack.push({ id: child, next: 0 });
    }
  }
  return [...cycles.values()];
}

function checkCycles(edges, endpoints, violations) {
  for (const relationship of ACYCLIC_RELATIONSHIPS) {
    for (const cycle of findCycles(relationship, edges, endpoints)) {
      violations.push(
        violation(
          GRAPH_VIOLATION_CODES.RELATIONSHIP_CYCLE,
          `Cycle in '${relationship}': ${[...cycle, cycle[0]].join(' -> ')}.`,
          { relationship, cycle },
        ),
      );
    }
  }
}

// --- Rule scope and conflicts (spec §7) ----------------------------------------------------------

const RULE_TYPE = 'Rule';

// Superseded Rules are excluded from operational context (spec §6), so they can neither be the
// applicable side of a conflict nor be conflicted with. Deprecated ones are still served — with a
// warning — so they still conflict. Exported because D2's resolution-time conflict gate must judge
// applicability by exactly this set.
export const APPLICABLE_RULE_STATUSES = deepFreeze(['active', 'deprecated']);
const APPLICABLE_STATUSES = APPLICABLE_RULE_STATUSES;

function statusOf(node) {
  return node.properties?.status;
}

// Scope targets per Rule: the APPLIES_TO edges that actually land on a node. A dangling APPLIES_TO
// is already blocking as a broken endpoint and must not be allowed to pass for a scope.
function scopeTargets(edges, endpoints) {
  const targets = new Map();
  for (const edge of edges) {
    if (edge.type !== 'APPLIES_TO') continue;
    if (!isLinked(edge, endpoints)) continue;
    if (!targets.has(edge.fromId)) targets.set(edge.fromId, new Set());
    targets.get(edge.fromId).add(edge.toId);
  }
  return targets;
}

// "active Rule missing ... at least one APPLIES_TO relationship". The concern/strength half of the
// same invariant is the closed schema's (B1 requires both on every Rule) and is reported from
// `checkNodes` — re-checking it here would only duplicate its violations.
function checkActiveRuleScope(nodes, targets, violations) {
  for (const node of nodes) {
    if (node.type !== RULE_TYPE || statusOf(node) !== 'active') continue;
    if (targets.has(node.id)) continue;
    violations.push(
      violation(
        GRAPH_VIOLATION_CODES.ACTIVE_RULE_WITHOUT_SCOPE,
        `Active Rule '${node.id}' has no APPLIES_TO relationship: an active Rule must declare its explicit scope.`,
        nodeIdentity(node, { status: 'active' }),
      ),
    );
  }
}

// Everything reachable from `start` along `successors`, cycle-safe (an OVERRIDES cycle is blocking
// on its own, but this walk must still terminate on one).
function reachableFrom(start, successors) {
  const seen = new Set();
  const queue = [start];
  while (queue.length > 0) {
    for (const next of successors.get(queue.shift()) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

// THE CONFLICT-RESOLUTION RULE, on its own: given the applicable Rule ids and the graph's edges,
// `overridesClosure(ids, edges)(id)` is the set of Rules `id` overrides, directly or transitively.
//
// A resolution path may only run through Rules that are themselves applicable. A SUPERSEDED Rule is
// excluded from operational context (spec §6), so it is not there to override anything: routing
// A -> M(superseded) -> B would certify a graph on which D2 still collects A and B together and
// raises RULE_CONFLICT. Endpoints that are not applicable Rules therefore carry no adjacency.
//
// Exported for D2 (spec §8): its resolution-time gate assembles conflicting pairs this whole-graph
// check does not see (it judges shared APPLIES_TO targets only, while a resolution collects across
// hierarchy levels) and must resolve them by THIS rule, not a second copy of it. Memoized per id and
// computed lazily — a graph may hold far more applicable Rules than conflicting pairs.
export function overridesClosure(applicableIds, edges) {
  const ids = applicableIds instanceof Set ? applicableIds : new Set(applicableIds);
  const overrides = new Map();
  for (const edge of edges) {
    if (edge.type !== 'OVERRIDES') continue;
    if (!ids.has(edge.fromId) || !ids.has(edge.toId)) continue;
    if (!overrides.has(edge.fromId)) overrides.set(edge.fromId, []);
    overrides.get(edge.fromId).push(edge.toId);
  }
  const memo = new Map();
  return (id) => {
    if (!memo.has(id)) memo.set(id, reachableFrom(id, overrides));
    return memo.get(id);
  };
}

// THE OTHER HALF OF THE RULE: given ids that are applicable TOGETHER, who is still in the contest.
//
// Resolution is settled over the GROUP, never pair by pair. One new Rule superseding SEVERAL older
// same-concern ones is ordinary authoring, and those losers have no OVERRIDES between THEM — nor
// should they need one. Judging each pair independently reports that loser pair as an unresolved
// conflict on a graph whose own edges settle it: a false blocking violation here, a false
// RULE_CONFLICT in D2, both on a shape the product is supposed to accept.
//
// Returns `{ survivors, losers }`. `survivors` are the ids nothing in the group overrode, sorted —
// and no two of them can override each other, since that is exactly what being a survivor means, so
// EVERY surviving pair is a genuine conflict. `losers` maps each beaten id to the winner that beat
// it (the first in id order when several did — the same tie-break results are ordered by).
export function resolveOverrideGroup(ids, overridden) {
  const group = [...new Set(ids)].sort(compareStrings);
  const losers = new Map();
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      const [left, right] = [group[i], group[j]];
      const loser = overridden(left).has(right) ? right : overridden(right).has(left) ? left : null;
      if (loser === null) continue;
      const winner = loser === right ? left : right;
      if (!losers.has(loser) || compareStrings(winner, losers.get(loser)) < 0) losers.set(loser, winner);
    }
  }
  return { survivors: group.filter((id) => !losers.has(id)), losers };
}

// SCOPE OF CONFLICT DETECTION (spec §7, plan task B4): two applicable Rules conflict when they share
// a `concern` AND at least one APPLIES_TO target — i.e. some node is in both scopes. A valid
// explicit OVERRIDES path in either direction resolves it; nothing else does, because §7 forbids a
// silent "more specific rule wins".
//
// DELIBERATE BOUNDARY: overlap is judged on the ATTACHED TARGETS, not on the containment hierarchy.
// A Rule on a Surface and a Rule on a Component inside that Surface are not reported here, even
// though a resolution rooted in that Component collects both. Detecting those is resolution-time
// work — D2 raises `RULE_CONFLICT` for the applicable set it actually assembled, and D4's advisor
// surfaces candidates before promotion. Widening this predicate later strictly widens what blocks.
function checkRuleConflicts(nodes, edges, targets, violations) {
  const applicable = nodes.filter(
    (node) => node.type === RULE_TYPE && APPLICABLE_STATUSES.includes(statusOf(node)),
  );

  const byConcern = new Map();
  for (const node of applicable) {
    const concern = node.properties?.concern;
    if (typeof concern !== 'string' || concern === '') continue; // absent/malformed: B1 reported it
    if (!byConcern.has(concern)) byConcern.set(concern, []);
    byConcern.get(concern).push(node);
  }

  const overridden = overridesClosure(applicable.map((node) => node.id), edges);

  for (const concern of [...byConcern.keys()].sort(compareStrings)) {
    const group = [...byConcern.get(concern)].sort((a, b) => compareStrings(a.id, b.id));

    // The contest is settled PER TARGET, because that is where a conflict lives: a Rule that
    // overrides another somewhere else in the graph does not resolve a clash on a target it does not
    // itself apply to. Grouping by concern alone would let a distant OVERRIDES silently excuse it.
    const byTarget = new Map();
    for (const node of group) {
      for (const target of targets.get(node.id) ?? []) {
        if (!byTarget.has(target)) byTarget.set(target, []);
        byTarget.get(target).push(node.id);
      }
    }

    // Pairs are reported ONCE, listing every target they clash on — so a pair overlapping in three
    // places is one violation with three targets, not three violations.
    const sharedByPair = new Map();
    for (const target of [...byTarget.keys()].sort(compareStrings)) {
      const here = byTarget.get(target);
      if (here.length < 2) continue;
      const { survivors } = resolveOverrideGroup(here, overridden);
      for (let i = 0; i < survivors.length; i += 1) {
        for (let j = i + 1; j < survivors.length; j += 1) {
          const key = `${survivors[i]} ${survivors[j]}`;
          if (!sharedByPair.has(key)) sharedByPair.set(key, { left: survivors[i], right: survivors[j], targets: [] });
          sharedByPair.get(key).targets.push(target);
        }
      }
    }

    for (const key of [...sharedByPair.keys()].sort(compareStrings)) {
      // The key only ORDERS the report; the ids are carried, never re-parsed out of it.
      const { left, right, targets: shared } = sharedByPair.get(key);
      violations.push(
        violation(
          GRAPH_VIOLATION_CODES.UNRESOLVED_RULE_CONFLICT,
          `Rules '${left}' and '${right}' share concern '${concern}' on overlapping scope (${shared.join(', ')}) with no explicit OVERRIDES between them.`,
          { concern, ruleIds: [left, right], targets: shared },
        ),
      );
    }
  }
}

// --- semantic reachability from the Project root (spec §5, amended 2026-08-12) --------------------

// Which end of each relationship the OTHER end anchors — the complete B1 relationship vocabulary,
// with the direction each edge carries "belongs to the governed project" in:
//   'reverse' — the SOURCE is anchored by its target: a Surface belongs because of the Project it is
//               PART_OF, a Rule/Skill because of the scope it APPLIES_TO, a Term because of the node
//               that USED_BY names, a Package because of the Component it IMPLEMENTS;
//   'forward' — the TARGET is anchored by its source: a Check/Decision/Agent belongs because the
//               Rule/Surface pointing at it does, and a superseded node stays anchored by the node
//               that replaced it (spec §6 keeps it for history and trace queries — losing its own
//               scope edges must not make the graph invalid);
//   null      — anchors nothing: OVERRIDES links two Rules that each carry their own scope already.
// EVERY relationship B1 declares must appear here, `null` included: a missing entry would anchor
// nothing and turn every node tied to the skeleton by that edge into a blocking UNREACHABLE false
// positive. The suite pins this table against `RELATIONSHIP_TYPE_NAMES` so a new B1 relationship
// cannot be added without a decision here.
export const ANCHOR_DIRECTIONS = deepFreeze({
  PART_OF: 'reverse',
  IMPLEMENTS: 'reverse',
  APPLIES_TO: 'reverse',
  USED_BY: 'reverse',
  VERIFIED_BY: 'forward',
  MOTIVATED_BY: 'forward',
  OWNED_BY: 'forward',
  SUPERSEDES: 'forward',
  OVERRIDES: null,
});

// "curated stable node not semantically reachable from its Project root" is a CURATED-node invariant:
// repository-derived nodes are observed, refreshed from the filesystem (spec §25) and legitimately
// hang off the topology chain instead, so they are walked through but never required to be reachable.
function checkReachability(nodes, edges, endpoints, projectId, violations) {
  const curated = nodes.filter((node) => CURATED_NODE_TYPE_NAMES.includes(node.type));
  if (curated.length === 0) return;

  const roots = curated.filter(
    (node) => node.type === 'Project' && parseQualifiedId(node.id)?.projectId === projectId,
  );
  if (roots.length === 0) {
    violations.push(
      violation(
        GRAPH_VIOLATION_CODES.PROJECT_ROOT_MISSING,
        `No Project node for '${projectId}': the curated graph has no semantic root to be reachable from.`,
        { projectId },
      ),
    );
    return;
  }

  const anchored = new Map(); // id -> ids it makes reachable
  for (const edge of edges) {
    const direction = ANCHOR_DIRECTIONS[edge.type];
    if (!direction) continue;
    if (!isLinked(edge, endpoints)) continue;
    const [anchor, dependent] = direction === 'reverse' ? [edge.toId, edge.fromId] : [edge.fromId, edge.toId];
    if (!anchored.has(anchor)) anchored.set(anchor, []);
    anchored.get(anchor).push(dependent);
  }

  const reachable = new Set(roots.map((node) => node.id));
  const queue = [...reachable].sort(compareStrings);
  while (queue.length > 0) {
    for (const next of anchored.get(queue.shift()) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }

  for (const node of curated) {
    if (reachable.has(node.id)) continue;
    violations.push(
      violation(
        GRAPH_VIOLATION_CODES.UNREACHABLE_FROM_PROJECT_ROOT,
        `Curated node '${node.id}' is not semantically reachable from the Project root of '${projectId}'.`,
        nodeIdentity(node),
      ),
    );
  }
}

// --- schema version and scenario base revision (see the SYSTEM RECORD CONTRACT in the header) ------

// The pinned contract is an id, a TYPE and a property bag; a record of the wrong type is not that
// record. B5 writes the system record and D4 the scenario one, so the type is checked here rather
// than trusted — the closed ontology deliberately does not cover metadata records, which means
// nothing else would ever notice.
function checkRecordType(record, expectedType, identity, violations) {
  if (!record || record.type === expectedType) return;
  violations.push(
    violation(
      GRAPH_VIOLATION_CODES.INVALID_METADATA_RECORD_TYPE,
      `Record '${identity.id}' in namespace '${identity.namespace}' has type '${record.type}', expected '${expectedType}'.`,
      { ...identity, type: record.type, expectedType },
    ),
  );
}

// Returns the declared head revision, or `undefined` when the graph cannot tell us — in which case
// the scenario comparison below is skipped rather than decided against an invented head.
function checkSchemaVersion(system, projectId, violations) {
  const identity = { id: systemRecordId(projectId), namespace: SYSTEM_NAMESPACE };
  checkRecordType(system, SYSTEM_RECORD_TYPE, identity, violations);
  if (!system || !('schemaVersion' in (system.properties ?? {}))) {
    violations.push(
      violation(
        GRAPH_VIOLATION_CODES.SCHEMA_VERSION_MISSING,
        `No graph schema version declared: expected a '${SYSTEM_RECORD_TYPE}' record '${identity.id}' in the '${SYSTEM_NAMESPACE}' namespace carrying schemaVersion ${GRAPH_SCHEMA_VERSION}.`,
        identity,
      ),
    );
    return undefined;
  }

  const { schemaVersion, headRevision } = system.properties;
  if (!isSupportedSchemaVersion(schemaVersion)) {
    violations.push(
      violation(
        GRAPH_VIOLATION_CODES.UNSUPPORTED_SCHEMA_VERSION,
        `Graph schema version ${JSON.stringify(schemaVersion)} is not supported (this build reads version ${GRAPH_SCHEMA_VERSION}); an explicit schema migration is required.`,
        { ...identity, schemaVersion, supportedVersion: GRAPH_SCHEMA_VERSION },
      ),
    );
  }
  return headRevision === undefined ? null : headRevision;
}

// Only the scenarios the caller names are checked: the port partitions the scenario namespace by
// `scenarioId` and offers no enumeration, so the graph cannot reveal which scenarios are open.
function checkScenarios(scenarios, headRevision, projectId, violations) {
  for (const { scenarioId, meta } of scenarios) {
    const identity = { scenarioId, id: scenarioMetaId(projectId), namespace: SCENARIO_NAMESPACE };
    checkRecordType(meta, SCENARIO_META_TYPE, identity, violations);
    if (!meta || !('baseRevision' in (meta.properties ?? {}))) {
      violations.push(
        violation(
          GRAPH_VIOLATION_CODES.SCENARIO_BASE_REVISION_MISSING,
          `Promotion Scenario '${scenarioId}' declares no baseRevision: expected a '${SCENARIO_META_TYPE}' record '${identity.id}' in its scenario scope.`,
          identity,
        ),
      );
      continue;
    }
    if (headRevision === undefined) continue; // no readable head: the schema violation stands alone
    const { baseRevision } = meta.properties;
    if (baseRevision === headRevision) continue;
    violations.push(
      violation(
        GRAPH_VIOLATION_CODES.SCENARIO_BASE_REVISION_INCOMPATIBLE,
        `Promotion Scenario '${scenarioId}' is based on revision ${JSON.stringify(baseRevision)} but the graph head is ${JSON.stringify(headRevision)}; it can no longer be applied safely.`,
        { scenarioId, baseRevision, headRevision },
      ),
    );
  }
}

// --- warnings ------------------------------------------------------------------------------------

// Advisory only — they never affect `ok`. `SEMANTIC_NEAR_DUPLICATE` has no detector here: hybrid
// retrieval is deferred to a later version (spec §10), and inventing a lexical heuristic in its place
// would put warnings in front of humans that the shipped design never promised.
function checkWarnings(nodes, edges, endpoints, options, warnings) {
  const superseding = new Set(
    edges.filter((edge) => edge.type === 'SUPERSEDES' && endpoints.get(edge)?.from).map((edge) => edge.toId),
  );
  const verified = new Set(
    edges.filter((edge) => edge.type === 'VERIFIED_BY' && endpoints.get(edge)?.to).map((edge) => edge.fromId),
  );

  for (const node of nodes) {
    const properties = node.properties ?? {};

    // A Package whose selector no longer matches anything is stale mapping, not an invalid graph —
    // the topology refresh (spec §25) is what repairs it. Only measured Packages are judged: an id
    // absent from the map was not measured.
    const matchCount = options.packageSelectorMatchCounts?.[node.id];
    if (node.type === 'Package' && matchCount === 0) {
      warnings.push(
        violation(
          GRAPH_WARNING_CODES.PACKAGE_SELECTOR_MATCHES_NOTHING,
          `Package '${node.id}' currently matches no path in the repository.`,
          nodeIdentity(node, { matchCount }),
        ),
      );
    }

    // Deprecated means "still served, until replacement is complete" (spec §6) — with nothing
    // SUPERSEDES-ing it, that replacement does not exist yet.
    if (properties.status === 'deprecated' && !superseding.has(node.id)) {
      warnings.push(
        violation(
          GRAPH_WARNING_CODES.DEPRECATED_WITHOUT_REPLACEMENT,
          `Deprecated node '${node.id}' has no replacement: nothing SUPERSEDES it.`,
          nodeIdentity(node),
        ),
      );
    }

    // Superseded Rules are out of operational context, so a missing Check on one is not actionable.
    if (
      node.type === RULE_TYPE &&
      properties.strength === 'should' &&
      APPLICABLE_STATUSES.includes(properties.status) &&
      !verified.has(node.id)
    ) {
      warnings.push(
        violation(
          GRAPH_WARNING_CODES.SHOULD_RULE_WITHOUT_CHECK,
          `'should' Rule '${node.id}' has no Check: nothing verifies it (VERIFIED_BY).`,
          nodeIdentity(node),
        ),
      );
    }

    if (typeof properties.body === 'string' && properties.body.length > options.maxBodyLength) {
      warnings.push(
        violation(
          GRAPH_WARNING_CODES.OVERSIZED_BODY,
          `Node '${node.id}' has an explanatory body of ${properties.body.length} characters (over ${options.maxBodyLength}); it will dominate any context that includes it.`,
          nodeIdentity(node, { bodyLength: properties.body.length, maxBodyLength: options.maxBodyLength }),
        ),
      );
    }
  }

  const { budget } = options;
  if (budget && budget.used / budget.limit >= budget.nearRatio) {
    warnings.push(
      violation(
        GRAPH_WARNING_CODES.CONTEXT_NEAR_BUDGET,
        `Context uses ${budget.used} of a ${budget.limit} budget, at or above ${budget.nearRatio} of it.`,
        { limit: budget.limit, used: budget.used, nearRatio: budget.nearRatio },
      ),
    );
  }
}

// --- entry point ---------------------------------------------------------------------------------

// The spec's "Required graph invariants" list, in order, one check each:
//   duplicate qualified ID                          checkDuplicateIds
//   missing/malformed properties, unknown node type,
//   unknown property, malformed identity            checkNodes           (B1 + B2)
//   broken endpoint, unknown relationship type,
//   invalid endpoint types, cross-project edge      checkEdges           (B1 + B2)
//   cycles in PART_OF/OVERRIDES/SUPERSEDES          checkCycles
//   active Rule without scope                       checkActiveRuleScope (+ B1 for concern/strength)
//   unresolved conflict among applicable Rules      checkRuleConflicts
//   curated node unreachable from the Project root  checkReachability
//   obsolete/unsupported schema version             checkSchemaVersion
//   scenario on an incompatible base revision       checkScenarios
// and the warning list, all six, in                 checkWarnings
export async function validateGraph(port, input = {}) {
  const { projectId, scenarioIds, options } = normalizeInput(port, input);
  const graph = await readGraph(port, projectId, scenarioIds);

  const { violations, warnings } = checkGraphState(graph.nodes, graph.edges, projectId, options);

  // The two metadata checks read records only the port can hand over — the system record and the
  // named scenarios' meta records — so they stay here, on top of the in-memory invariant pass.
  const headRevision = checkSchemaVersion(graph.system, projectId, violations);
  checkScenarios(graph.scenarios, headRevision, projectId, violations);

  return { ok: violations.length === 0, violations: sortResults(violations), warnings: sortResults(warnings) };
}

// The blocking-invariant and warning checks over an IN-MEMORY stable graph — exported additively so
// a caller holding graph state it did NOT read from the port is judged by exactly this module's
// machinery. `validateGraph` reads the curated+topology union in one transaction and delegates to
// this; D4's promotion preview materializes base graph + candidate operations in memory and validates
// the result here, so a scenario-applied graph is certified by the same checks, never a second copy
// of them. Nodes/edges are port record shapes (`{ namespace, type, id, properties }` /
// `{ namespace, type, fromId, toId }`). `options` is the `validateGraph` option bag (normalized
// inside). The system/scenario metadata checks are deliberately NOT here: they read records only
// `validateGraph` fetches from the port, and a projection has none. Returns `{ violations, warnings }`
// in check order — sorting is the caller's rendering decision (`validateGraph` sorts by code then a
// canonical identity rendering).
export function checkGraphState(nodes, edges, projectId, options = {}) {
  const violations = [];
  const warnings = [];

  // Scope-keyed, because the same id may legally sit in both stable namespaces at the storage
  // level — which is itself blocking (`checkDuplicateIds`), but must not also make every edge
  // resolve to the wrong node. First node of a given (namespace, id) wins.
  const nodesByScope = new Map();
  for (const node of nodes) {
    const key = scopeKey(node.namespace, node.id);
    if (!nodesByScope.has(key)) nodesByScope.set(key, node);
  }
  const endpoints = resolveEdgeEndpoints(edges, nodesByScope);

  checkDuplicateIds(nodes, violations);
  checkNodes(nodes, violations);
  checkEdges(edges, endpoints, violations);
  checkCycles(edges, endpoints, violations);

  const targets = scopeTargets(edges, endpoints);
  checkActiveRuleScope(nodes, targets, violations);
  checkRuleConflicts(nodes, edges, targets, violations);
  checkReachability(nodes, edges, endpoints, projectId, violations);

  checkWarnings(nodes, edges, endpoints, normalizeOptions(options), warnings);

  return { violations, warnings };
}
