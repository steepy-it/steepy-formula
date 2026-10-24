// Deterministic context resolver for the Stable Knowledge Graph (spec §8, success criterion 4).
//
//   resolveContext(port, { projectId, paths?, targets?, options? })
//     -> { ok: true, code: null, projectId, input, context, diagnostics }
//     -> { ok: false, code, message, identity, projectId, input, ... }
//
// PORT-ONLY I/O (spec §20), READ-ONLY: the two stable namespaces (`curated`, `topology`) are read
// inside ONE transaction, so the traversal sees a consistent snapshot and runs identically on any
// adapter. The `scenario` namespace is never read — promotion scenarios are proposals, not context.
//
// The B4 gate that precedes the traversal reads its OWN transaction, so a write landing between the
// two is validated by neither. That seam is why `options.validation` exists: a caller holding both
// (D3 validates, then resolves) can pass its verdict in, and the write-side discipline that closes
// it for good — one snapshot shared by both — belongs to whoever owns the read-consistency policy,
// not to a resolver that must not itself hold a transaction open across a whole-graph validation.
import { isPortError, withTransaction } from '../engine/port.mjs';
import { buildQualifiedId, isValidLocalId, isValidProjectId, isValidQualifiedId, parseQualifiedId } from './ids.mjs';
import { APPLICABLE_RULE_STATUSES, overridesClosure, resolveOverrideGroup, validateGraph } from './validate-graph.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// --- vocabulary ---------------------------------------------------------------------------------

const STABLE_NAMESPACES = deepFreeze(['curated', 'topology']);

// The §8 chain, encoded once: from an anchor of type `from`, the `via` relationship (walked from
// its source) reaches the next anchor of type `to`. Every triple is legal per B1's
// RELATIONSHIP_RULES — the suite pins that, so this table cannot drift from the ontology.
export const CHAIN_STEPS = deepFreeze([
  { from: 'Package', via: 'IMPLEMENTS', to: 'Component' },
  { from: 'Component', via: 'PART_OF', to: 'Surface' },
  { from: 'Surface', via: 'PART_OF', to: 'Project' },
]);

// The two trace steps that are NOT graph edges: the seed input itself, and the selector match that
// turned a path into a Package.
export const TRACE_STEPS = deepFreeze({
  INPUT_PATH: 'input:path',
  INPUT_TARGET: 'input:target',
  PATH_SELECTOR: 'path-selector',
  TARGET_ID: 'target-id',
});

// Returned node kinds, in the fixed order the result buckets carry them.
export const CONTEXT_KINDS = deepFreeze(['Rule', 'Check', 'Agent', 'Skill', 'Term', 'Decision']);

const BUCKETS = deepFreeze({
  Rule: 'rules',
  Check: 'checks',
  Agent: 'agents',
  Skill: 'skills',
  Term: 'terms',
  Decision: 'decisions',
});

const ANCHOR_TYPES = deepFreeze(['Package', 'Component', 'Surface', 'Project']);

// Spec §6: a superseded node is excluded from operational context, a deprecated one is still served
// WITH a warning. Applied to every RETURNED item, whatever attached it — a superseded Check on an
// active Rule is as excluded as a superseded Rule. Anchors of the chain are a routing position
// rather than returned knowledge, so the walk passes through them regardless of their status.
const EXCLUDED_STATUS = 'superseded';
const DEPRECATED_STATUS = 'deprecated';

// What an explicit target may name: an anchor of the chain, or a curated node returned as context.
// Everything else the graph holds (Repository, Workspace, and the metadata records outside the
// closed ontology) is not a resolution entry point.
export const RESOLVABLE_TARGET_KINDS = deepFreeze([...ANCHOR_TYPES, ...CONTEXT_KINDS]);

// The failure table rows this module owns (spec "Failure and recovery behavior").
export const RESOLVE_ERROR_CODES = deepFreeze({
  UNRESOLVED: 'UNRESOLVED',
  RULE_CONFLICT: 'RULE_CONFLICT',
  GRAPH_INVALID: 'GRAPH_INVALID',
  KNOWLEDGE_GRAPH_UNAVAILABLE: 'KNOWLEDGE_GRAPH_UNAVAILABLE',
});

// Why one input did not resolve. Machine-checkable, so a CLI/MCP caller can react (offer the
// candidates, ask for a narrower path) without parsing prose.
export const UNRESOLVED_REASONS = deepFreeze({
  NO_PACKAGE_MATCHES_PATH: 'no-package-matches-path',
  AMBIGUOUS_PACKAGE_SELECTOR: 'ambiguous-package-selector',
  PATH_NOT_REPO_RELATIVE: 'path-not-repo-relative',
  UNKNOWN_TARGET: 'unknown-target',
  TARGET_OUTSIDE_PROJECT: 'target-outside-project',
  MALFORMED_TARGET: 'malformed-target',
  UNSUPPORTED_TARGET_KIND: 'unsupported-target-kind',
  SUPERSEDED_TARGET: 'superseded-target',
});

// A candidate list is a HINT, not context: it is capped so a failure on a large monorepo stays a
// readable answer rather than a listing of the graph. `candidateCount` always reports the true
// total, so a caller can tell a short list from a truncated one.
export const MAX_UNRESOLVED_CANDIDATES = 10;

// --- input contract -----------------------------------------------------------------------------

const INPUT_KEYS = deepFreeze(['projectId', 'paths', 'targets', 'options']);
const OPTION_KEYS = deepFreeze(['validation']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(input, accepted, what) {
  for (const key of Object.keys(input)) {
    if (!accepted.includes(key)) {
      throw new TypeError(`resolveContext: unknown ${what} '${key}'; accepted: ${accepted.join(', ')}.`);
    }
  }
}

function isStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '');
}

// A repo-relative POSIX path in canonical form: no `./` prefix, no duplicate or trailing slash.
// `.` is the repository root itself.
//
// The trailing-slash strip deliberately spares a slash at position 0 (`(?!^)`): without it `'/'`
// collapses to `''` and then to `'.'`, so the filesystem root would come out the other side looking
// like the repository root and MATCH it. An absolute path must stay absolute all the way to
// `isRepoRelative`, which is the one place entitled to reject it.
function normalizePath(path) {
  const collapsed = path.replace(/\/+/g, '/').replace(/^(\.\/)+/, '').replace(/(?!^)\/+$/, '');
  return collapsed === '' ? '.' : collapsed;
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareStrings);
}

// `options.validation` is a B4 verdict a caller has ALREADY computed for this graph state (D3
// validates, then resolves) handed in so resolution does not pay for a second whole-graph pass. It
// must be SHAPED like one: an injected `{ ok: true }` carrying no lists would silently disable the
// blocking gate for the first caller that mistyped it, which is the one failure this module must
// never have. Freshness is the caller's to assert — we honor the verdict we are given.
function normalizeOptions(options) {
  if (!isPlainObject(options)) {
    throw new TypeError('resolveContext: options must be an object.');
  }
  rejectUnknownKeys(options, OPTION_KEYS, 'option');

  const { validation } = options;
  if (validation === undefined) return {};
  const shaped =
    isPlainObject(validation) &&
    typeof validation.ok === 'boolean' &&
    Array.isArray(validation.violations) &&
    Array.isArray(validation.warnings);
  if (!shaped) {
    throw new TypeError(
      'resolveContext: options.validation must be a validateGraph result — { ok: boolean, violations: [], warnings: [] }.',
    );
  }
  return { validation };
}

function normalizeInput(port, input) {
  if (!port || typeof port.begin !== 'function') {
    throw new TypeError('resolveContext requires a port with a begin() method.');
  }
  if (!isPlainObject(input)) {
    throw new TypeError('resolveContext requires an input object with a projectId and at least one path or target.');
  }
  rejectUnknownKeys(input, INPUT_KEYS, 'input key');

  const { projectId, paths = [], targets = [], options = {} } = input;
  if (!isValidProjectId(projectId)) {
    throw new TypeError(`resolveContext requires a valid projectId, got ${JSON.stringify(projectId ?? null)}.`);
  }
  if (!isStringList(paths)) {
    throw new TypeError('resolveContext: paths must be an array of non-empty strings.');
  }
  if (!isStringList(targets)) {
    throw new TypeError('resolveContext: targets must be an array of non-empty strings.');
  }

  const normalized = { paths: sortedUnique(paths.map(normalizePath)), targets: sortedUnique(targets) };
  if (normalized.paths.length + normalized.targets.length === 0) {
    throw new TypeError('resolveContext requires at least one path or target (spec §8).');
  }
  return { projectId, ...normalized, options: normalizeOptions(options) };
}

// --- reading ------------------------------------------------------------------------------------

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// One transaction over the two stable namespaces — the same snapshot discipline B4 reads with.
// The reads accumulate in a plain loop, never `push(...(await tx.listNodes(...)))`: a spread of the
// whole curated namespace would throw `RangeError: Maximum call stack size exceeded` at the E1
// fixture scale (25,000 curated nodes / 150,000 edges), where E4 measures the warm latency. Same
// amendment E1 made in validate-graph.mjs and E2 in revision.mjs.
async function readGraph(port) {
  return withTransaction(port, async (tx) => {
    const nodes = [];
    const edges = [];
    for (const namespace of STABLE_NAMESPACES) {
      for (const node of await tx.listNodes({ namespace })) nodes.push(node);
      for (const edge of await tx.listEdges({ namespace })) edges.push(edge);
    }
    return { nodes, edges };
  });
}

// Indexes the snapshot for traversal: nodes by qualified id, and edges by (type, endpoint) in both
// directions with every adjacency list sorted, so a walk never depends on the port's list order.
function indexGraph(graph) {
  const byId = new Map();
  for (const node of graph.nodes) {
    if (!byId.has(node.id)) byId.set(node.id, node);
  }

  const out = new Map();
  const into = new Map();
  const push = (index, key, value) => {
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(value);
  };
  for (const edge of graph.edges) {
    push(out, `${edge.type} ${edge.fromId}`, edge.toId);
    push(into, `${edge.type} ${edge.toId}`, edge.fromId);
  }
  for (const index of [out, into]) {
    for (const list of index.values()) list.sort(compareStrings);
  }

  const nodes = [...byId.values()].sort((a, b) => compareStrings(a.id, b.id));
  const packages = nodes.filter((node) => node.type === 'Package' && typeof node.properties?.path === 'string');

  return {
    node: (id) => byId.get(id) ?? null,
    out: (type, id) => out.get(`${type} ${id}`) ?? [],
    into: (type, id) => into.get(`${type} ${id}`) ?? [],
    nodes,
    packages,
    edges: graph.edges,
  };
}

// --- path -> Package ------------------------------------------------------------------------------

// Segment-aligned containment: `packages/a` matches `packages/a` and `packages/a/src/x.mjs`, never
// `packages/ab/y.mjs`. The root selector `.` contains every repo-relative path.
function selectorMatches(path, selector) {
  if (selector === '.') return true;
  return path === selector || path.startsWith(`${selector}/`);
}

function selectorDepth(selector) {
  return selector === '.' ? 0 : selector.split('/').length;
}

// The deepest (longest) matching selector wins: a nested package beats the workspace root it sits
// in. Two DISTINCT packages can only tie by carrying the SAME selector — every other pair of
// matching selectors is nested, so one of them is strictly deeper.
function matchPackages(path, packages) {
  const matching = packages.filter((node) => selectorMatches(path, node.properties.path));
  if (matching.length === 0) return [];
  const deepest = Math.max(...matching.map((node) => selectorDepth(node.properties.path)));
  return matching.filter((node) => selectorDepth(node.properties.path) === deepest);
}

// Repo-relative POSIX only: an absolute path and a `..` escape name something outside the observed
// repository, and no package selector could honestly match them.
function isRepoRelative(path) {
  return !path.startsWith('/') && !path.split('/').includes('..');
}

// How many leading path segments two selectors share — the "nearest" measure behind a no-match
// candidate list. Deliberately structural: no fuzzy string distance, no new dependency.
function sharedSegments(path, selector) {
  if (selector === '.') return 0;
  const left = path.split('/');
  const right = selector.split('/');
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared += 1;
  return shared;
}

// The packages sharing the longest segment prefix with `path`; all of them when none shares any,
// because "the repository has these packages, none of them is yours" is the honest answer.
function nearestPackages(path, packages) {
  if (packages.length === 0) return [];
  const best = Math.max(...packages.map((node) => sharedSegments(path, node.properties.path)));
  return best === 0 ? packages : packages.filter((node) => sharedSegments(path, node.properties.path) === best);
}

function candidateOf(node) {
  return { id: node.id, kind: node.type, selector: node.type === 'Package' ? node.properties.path : null };
}

function candidatesOf(nodes) {
  const sorted = [...nodes].sort((a, b) => compareStrings(a.id, b.id));
  return { candidates: sorted.slice(0, MAX_UNRESOLVED_CANDIDATES).map(candidateOf), candidateCount: sorted.length };
}

function unresolvedInput(kind, input, reason, nodes = []) {
  return { kind, input, reason, ...candidatesOf(nodes) };
}

// One path -> the Package that owns it, or the reason it owns nothing.
function resolvePath(path, index) {
  if (!isRepoRelative(path)) {
    return { unresolved: unresolvedInput('path', path, UNRESOLVED_REASONS.PATH_NOT_REPO_RELATIVE) };
  }
  const matching = matchPackages(path, index.packages);
  if (matching.length === 1) return { node: matching[0] };
  if (matching.length > 1) {
    return { unresolved: unresolvedInput('path', path, UNRESOLVED_REASONS.AMBIGUOUS_PACKAGE_SELECTOR, matching) };
  }
  return {
    unresolved: unresolvedInput('path', path, UNRESOLVED_REASONS.NO_PACKAGE_MATCHES_PATH, nearestPackages(path, index.packages)),
  };
}

// --- traversal -------------------------------------------------------------------------------------

function traceStep(via, to) {
  return { via, to };
}

// Walks the §8 chain upward from one start anchor, breadth first: Package -> Component -> Surface
// -> Project. Returns every anchor reached, each with the trace that reached it, in visit order.
function walkChain(start, startTrace, index) {
  const anchors = [];
  const seen = new Set([start.id]);
  const queue = [{ node: start, trace: startTrace }];
  while (queue.length > 0) {
    const current = queue.shift();
    anchors.push(current);
    for (const step of CHAIN_STEPS) {
      if (step.from !== current.node.type) continue;
      for (const nextId of index.out(step.via, current.node.id)) {
        const next = index.node(nextId);
        if (!next || next.type !== step.to || seen.has(nextId)) continue;
        seen.add(nextId);
        queue.push({ node: next, trace: [...current.trace, traceStep(step.via, nextId)] });
      }
    }
  }
  return anchors;
}

// Every node of `type` on the far end of `relationship`, in sorted id order.
function neighbours(index, direction, relationship, id, type) {
  const ids = direction === 'out' ? index.out(relationship, id) : index.into(relationship, id);
  return ids.map((found) => index.node(found)).filter((node) => node && node.type === type);
}

// --- seeds ---------------------------------------------------------------------------------------

// The nodes an unknown target could plausibly have meant: same local KIND, nothing fuzzier. A
// levenshtein-style near miss would need a dependency (§17 keeps this module dependency-free) and
// would invent a similarity the graph does not define; the kind is a fact the id itself carries.
function sameKindNodes(id, index) {
  const kind = parseQualifiedId(id)?.kind;
  return index.nodes.filter((node) => parseQualifiedId(node.id)?.kind === kind);
}

// One target -> the node it names, or the reason it names none. A target is a qualified id
// (`apex:<projectId>:<kind>:<slug>`) or a local `<kind>:<slug>` one qualified with this project.
function resolveTarget(target, projectId, index) {
  let id = null;
  if (isValidQualifiedId(target)) {
    const parsed = parseQualifiedId(target);
    if (parsed.projectId !== projectId) {
      return { unresolved: unresolvedInput('target', target, UNRESOLVED_REASONS.TARGET_OUTSIDE_PROJECT) };
    }
    id = target;
  } else if (isValidLocalId(target)) {
    id = buildQualifiedId(projectId, target);
  } else {
    return { unresolved: unresolvedInput('target', target, UNRESOLVED_REASONS.MALFORMED_TARGET) };
  }

  const node = index.node(id);
  if (!node) {
    return { unresolved: unresolvedInput('target', target, UNRESOLVED_REASONS.UNKNOWN_TARGET, sameKindNodes(id, index)) };
  }
  if (!RESOLVABLE_TARGET_KINDS.includes(node.type)) {
    return { unresolved: unresolvedInput('target', target, UNRESOLVED_REASONS.UNSUPPORTED_TARGET_KIND) };
  }
  if (node.properties?.status === EXCLUDED_STATUS) {
    // Excluded from context (§6) — so asking for it by name is a failed resolution, not an empty
    // success. The node that SUPERSEDES it is exactly the candidate the caller wants.
    const replacements = index.into('SUPERSEDES', node.id).map((id) => index.node(id)).filter(Boolean);
    return { unresolved: unresolvedInput('target', target, UNRESOLVED_REASONS.SUPERSEDED_TARGET, replacements) };
  }
  return { node };
}

// Every input turned into the node resolution starts from, with the trace that leads to it: paths
// first (in normalized order), then targets. An input that resolves to nothing is collected as an
// UNRESOLVED entry — it is never skipped, because a partial answer to "what applies here" is worse
// than no answer (spec §8: never fall back to loading the whole graph either).
function seedsOf(paths, targets, projectId, index) {
  const seeds = [];
  const unresolved = [];
  const take = (found, trace) => (found.node ? seeds.push({ node: found.node, trace: trace(found.node) }) : unresolved.push(found.unresolved));

  for (const path of paths) {
    take(resolvePath(path, index), (node) => [
      traceStep(TRACE_STEPS.INPUT_PATH, path),
      traceStep(TRACE_STEPS.PATH_SELECTOR, node.id),
    ]);
  }
  for (const target of targets) {
    take(resolveTarget(target, projectId, index), (node) => [
      traceStep(TRACE_STEPS.INPUT_TARGET, target),
      traceStep(TRACE_STEPS.TARGET_ID, node.id),
    ]);
  }
  return { seeds, unresolved };
}

// --- result ------------------------------------------------------------------------------------

function itemOf(node, trace) {
  return {
    kind: node.type,
    id: node.id,
    status: node.properties?.status ?? null,
    deprecated: node.properties?.status === DEPRECATED_STATUS,
    properties: structuredClone(node.properties ?? {}),
    trace,
  };
}

function emptyContext() {
  const context = {};
  for (const kind of CONTEXT_KINDS) context[BUCKETS[kind]] = [];
  return context;
}

// --- the conflict gate (spec §7 at resolution time) ------------------------------------------------

// B4 certifies a graph by judging Rules that share a concern AND an APPLIES_TO TARGET. A resolution
// collects across the hierarchy, so a Rule on a Surface and a Rule on a Component inside it can be
// applicable TOGETHER here on a graph B4 passed — this is where that pair is judged, by exactly B4's
// rule (`overridesClosure`), never a second copy of it.
//
// The closure runs over every APPLICABLE Rule in the graph, not merely the collected ones: an
// OVERRIDES path B4 accepted may route through a Rule that is applicable but out of this
// resolution's scope, and re-deciding it here would contradict the certificate the graph carries.
//
// THE UNIT OF THE CONTEST IS ONE SEED, NOT THE ANSWER. B4 settles per shared APPLIES_TO target
// because that is where applicability overlaps; the resolution-time equivalent is the scope ONE
// input reached, since every Rule collected along one chain governs that same code. A union of
// inputs is not an applicability scope: two Rules reached by two unrelated paths never govern the
// same code, and judging them together would invent a contradiction out of the caller asking two
// questions at once — on a graph B4 certified, at exactly the multi-input union §8 requires.
//
// This is the one place D2 answers a question B4 cannot even ask, so the consequences are spelled
// out rather than left to be re-derived. All deliberate:
//   * a pair conflicts only if SOME single seed made both applicable — conflicts found in several
//     scopes are reported once;
//   * a Rule beaten in one scope but surviving in another is still SERVED, because in that other
//     scope its winner never applied and dropping it would delete the only Rule governing that
//     input's code;
//   * such a Rule therefore carries the trace of a scope where it SURVIVED, not the first scope that
//     collected it. The trace is what made an item applicable, and the losing derivation names the
//     one input the item does NOT govern — the most misleading thing it could say. The scopes it
//     lost in are reported separately (`overriddenInScope`), so the flat union is disambiguated by
//     data rather than by the caller guessing.
//
// Returns `{ conflicts, losers, servedTrace, overriddenInScope }`: `conflicts` is non-empty when
// something is unresolved (the caller raises RULE_CONFLICT); `losers` maps each Rule beaten in EVERY
// scope to the surviving Rule served in its place; `servedTrace` gives each served Rule the
// derivation to carry; `overriddenInScope` records the drops that did not remove a Rule from the
// answer.
function conflictGate(scopes, anchorsByRule, index) {
  const applicableIds = index.nodes
    .filter((node) => node.type === 'Rule' && APPLICABLE_RULE_STATUSES.includes(node.properties?.status))
    .map((node) => node.id);
  const overridden = overridesClosure(applicableIds, index.edges);

  const conflicts = new Map();
  const servedTrace = new Map();
  const beatenIn = new Map();
  const perScope = [];

  for (const scope of scopes) {
    const byConcern = new Map();
    const traceById = new Map();
    for (const { node, trace } of scope.entries) {
      if (!traceById.has(node.id)) traceById.set(node.id, trace);
      const concern = node.properties?.concern;
      if (typeof concern !== 'string' || concern === '') continue; // absent/malformed: B1 reported it
      if (!byConcern.has(concern)) byConcern.set(concern, []);
      byConcern.get(concern).push(node.id);
    }

    for (const concern of [...byConcern.keys()].sort(compareStrings)) {
      const { survivors, losers } = resolveOverrideGroup(byConcern.get(concern), overridden);
      const surviving = new Set(survivors);
      // The FIRST scope (in normalized input order) where a Rule survived decides its derivation.
      for (const id of survivors) {
        if (!servedTrace.has(id)) servedTrace.set(id, traceById.get(id));
      }

      for (const [loser, winner] of losers) {
        // A chain (top beats mid beats low) drops the intermediate too, so walk up to a Rule that
        // survived THIS scope — the answer to "what applies here instead?" has to be something that
        // applies HERE. Staying inside the scope is the point: a winner from another input governs
        // other code and would be a false answer.
        let served = winner;
        const seen = new Set([loser]);
        while (!surviving.has(served) && losers.has(served) && !seen.has(served)) {
          seen.add(served);
          served = losers.get(served);
        }
        perScope.push({ id: loser, overriddenBy: served, concern, input: scope.input });
        if (!beatenIn.has(loser)) beatenIn.set(loser, { id: loser, overriddenBy: served, concern });
      }

      for (let i = 0; i < survivors.length; i += 1) {
        for (let j = i + 1; j < survivors.length; j += 1) {
          const ruleIds = [survivors[i], survivors[j]];
          conflicts.set(`${concern} ${ruleIds[0]} ${ruleIds[1]}`, { concern, ruleIds });
        }
      }
    }
  }

  // Surviving SOMEWHERE is enough to be served — see the header. What is left is beaten everywhere
  // it was applicable, so nothing in the answer depends on it.
  const losers = new Map();
  for (const [id, record] of beatenIn) {
    if (!servedTrace.has(id)) losers.set(id, record);
  }
  // The other half: still served, but not for THIS input. Rules dropped OUTRIGHT are left out —
  // they are absent from the answer, so per-input blame for them is a question about history rather
  // than about what applies. `losers` therefore names one winner and makes no claim about which
  // input it governs; a Rule beaten by DIFFERENT winners in different scopes reports only the first
  // (in input order). Enriching that is D3's call, since D3 owns the schema these feed.
  const overriddenInScope = perScope
    .filter((record) => servedTrace.has(record.id))
    .sort((a, b) => compareStrings(a.id, b.id) || compareStrings(a.input, b.input));

  return {
    conflicts: [...conflicts.values()]
      .sort((a, b) => compareStrings(a.concern, b.concern) || compareStrings(a.ruleIds[0], b.ruleIds[0]) || compareStrings(a.ruleIds[1], b.ruleIds[1]))
      .map((found) => ({
        ...found,
        anchors: found.ruleIds.map((ruleId) => ({ ruleId, anchorIds: [...(anchorsByRule.get(ruleId) ?? [])].sort(compareStrings) })),
      })),
    losers,
    servedTrace,
    overriddenInScope,
  };
}

// --- failures --------------------------------------------------------------------------------------

// The `{ code, message, identity }` convention every core module speaks, wrapped in the resolver's
// envelope: `projectId` and the normalized `input` are echoed on success and failure alike, so a
// caller (CLI, MCP) can report WHAT was asked without keeping its own copy.
function failure(code, message, identity, projectId, input, detail = {}) {
  return { ok: false, code, message, identity, projectId, input, ...detail };
}

function ruleConflictError(projectId, input, conflicts) {
  const listed = conflicts.map((found) => `'${found.concern}' (${found.ruleIds.join(', ')})`).join('; ');
  return failure(
    RESOLVE_ERROR_CODES.RULE_CONFLICT,
    `${conflicts.length} applicable rule conflict${conflicts.length === 1 ? '' : 's'} have no explicit OVERRIDES resolution: ${listed}.`,
    { projectId, conflicts: conflicts.map((found) => ({ concern: found.concern, ruleIds: found.ruleIds })) },
    projectId,
    input,
    { conflicts },
  );
}

// B4's verdict, passed straight through. Resolution serves MANDATORY knowledge, so answering out of
// a graph whose blocking invariants are broken would mean answering from a source we have just been
// told is untrustworthy — and the violations themselves are what the caller must act on, so they
// travel intact rather than being summarized into prose.
function graphInvalidError(projectId, input, validation) {
  const { violations, warnings } = validation;
  return failure(
    RESOLVE_ERROR_CODES.GRAPH_INVALID,
    `The knowledge graph breaks ${violations.length} blocking invariant${violations.length === 1 ? '' : 's'}; context cannot be resolved from it until they are repaired.`,
    { projectId, violationCount: violations.length },
    projectId,
    input,
    { violations, warnings },
  );
}

// The engine could not be read at all. This is the row of the failure table that must NOT degrade
// into a plausible answer: no Markdown fallback, no partial context, no raw driver stack — a named
// code carrying the port's own so a caller can tell "closed" from "unreachable". Exported
// additively (same precedent as `checkVerifiers`): D3 does its OWN port I/O before ever reaching
// `resolveContext` (the §25 digest check, the exactly-once `validateGraph` call) and must report a
// PortError there in this identical shape, rather than maintain a second copy that could drift.
export function unavailableError(projectId, input, error) {
  return failure(
    RESOLVE_ERROR_CODES.KNOWLEDGE_GRAPH_UNAVAILABLE,
    `The knowledge graph is unavailable (${error.code}): ${error.message}`,
    { projectId, portCode: error.code, ...error.identity },
    projectId,
    input,
  );
}

function unresolvedError(projectId, input, unresolved) {
  const inputs = unresolved.map((entry) => entry.input);
  const listed = unresolved.map((entry) => `'${entry.input}' (${entry.reason})`).join(', ');
  return failure(
    RESOLVE_ERROR_CODES.UNRESOLVED,
    `${inputs.length} input${inputs.length === 1 ? '' : 's'} did not resolve: ${listed}.`,
    { projectId, unresolvedInputs: inputs },
    projectId,
    input,
    { unresolved },
  );
}

// --- entry point ----------------------------------------------------------------------------------

export async function resolveContext(port, input = {}) {
  const { projectId, paths, targets, options } = normalizeInput(port, input);
  const echo = { paths, targets };

  // ALL port I/O sits in this one block, and nothing else does: a bug in the traversal below must
  // surface as the crash it is, never as a false "the graph is unavailable".
  let index;
  let validation;
  try {
    validation = options.validation ?? (await validateGraph(port, { projectId }));
    if (!validation.ok) return graphInvalidError(projectId, echo, validation);
    index = indexGraph(await readGraph(port));
  } catch (error) {
    if (isPortError(error)) return unavailableError(projectId, echo, error);
    throw error;
  }

  // id -> { node, trace } for everything collected, first derivation winning.
  const collected = new Map();
  const anchors = [];
  const rules = [];
  const visitedAnchors = new Set();
  // The ONE choke point every returned item passes through, so the lifecycle filter cannot be
  // forgotten on a collection path added later.
  const keep = (node, trace) => {
    if (node.properties?.status === EXCLUDED_STATUS) return false;
    if (!collected.has(node.id)) collected.set(node.id, { node, trace });
    return true;
  };
  // EVERY anchor that attaches a Rule is recorded, not just the one whose derivation the trace kept:
  // a conflict report must name what made each side applicable. Returns whether the Rule is in play,
  // so a caller can build its scope from what SURVIVED the lifecycle filter (spec §6: a superseded
  // Rule is not there to contradict anything).
  const anchorsByRule = new Map();
  const keepRule = (node, trace, anchorId = null) => {
    const fresh = !collected.has(node.id);
    if (!keep(node, trace)) return false;
    if (fresh) rules.push({ node, trace });
    if (anchorId === null) return true;
    if (!anchorsByRule.has(node.id)) anchorsByRule.set(node.id, new Set());
    anchorsByRule.get(node.id).add(anchorId);
    return true;
  };

  // Rules attached at ANY level of the chain, plus the anchor's own owner and skills. The Rules go
  // into `scope` — the applicability scope of the seed being walked, which is what the conflict gate
  // is judged over. An anchor already visited by an EARLIER seed still contributes here: `keep` is
  // first-derivation-wins so the result does not move, but this seed's scope must be complete or its
  // contest would be judged on a fragment of what applies to it.
  const collectAt = (anchor, scope) => {
    for (const rule of neighbours(index, 'into', 'APPLIES_TO', anchor.node.id, 'Rule')) {
      const trace = [...anchor.trace, traceStep('APPLIES_TO', rule.id)];
      if (keepRule(rule, trace, anchor.node.id)) scope.push({ node: rule, trace });
    }
    for (const agent of neighbours(index, 'out', 'OWNED_BY', anchor.node.id, 'Agent')) {
      keep(agent, [...anchor.trace, traceStep('OWNED_BY', agent.id)]);
    }
    for (const skill of neighbours(index, 'into', 'APPLIES_TO', anchor.node.id, 'Skill')) {
      keep(skill, [...anchor.trace, traceStep('APPLIES_TO', skill.id)]);
    }
  };

  // Seeds in normalized order — paths first, then targets — so which derivation an item keeps is
  // decided by the INPUT, never by the order the caller happened to pass it in.
  const { seeds, unresolved } = seedsOf(paths, targets, projectId, index);
  if (unresolved.length > 0) return unresolvedError(projectId, echo, unresolved);

  // One entry per seed: the Rules that seed made applicable, tagged with the raw input that reached
  // them so a per-scope diagnostic can name it. Separate scopes, never merged.
  const scopes = [];
  for (const seed of seeds) {
    const entries = [];
    if (ANCHOR_TYPES.includes(seed.node.type)) {
      for (const anchor of walkChain(seed.node, seed.trace, index)) {
        if (!visitedAnchors.has(anchor.node.id)) {
          visitedAnchors.add(anchor.node.id);
          anchors.push(anchor);
        }
        collectAt(anchor, entries);
      }
    } else if (seed.node.type === 'Rule') {
      // A Rule named outright is its own scope: naming two Rules in one call is a fetch, not a claim
      // that they govern the same code.
      if (keepRule(seed.node, seed.trace)) entries.push({ node: seed.node, trace: seed.trace });
    } else if (BUCKETS[seed.node.type]) {
      keep(seed.node, seed.trace);
    }
    // `trace[0]` is the seed step the input itself put there (`input:path` / `input:target`).
    if (entries.length > 0) scopes.push({ input: seed.trace[0].to, entries });
  }

  // The gate runs on the assembled Rule set, BEFORE expansion: a Rule dropped by an OVERRIDES must
  // not drag its Checks and Decisions into the answer.
  const { conflicts, losers, servedTrace, overriddenInScope } = conflictGate(scopes, anchorsByRule, index);
  if (conflicts.length > 0) return ruleConflictError(projectId, echo, conflicts);
  for (const loser of losers.keys()) collected.delete(loser);
  const surviving = rules.filter((rule) => !losers.has(rule.node.id));
  // A Rule that lost in the first scope that collected it, and is served because a LATER scope kept
  // it, must not carry the losing derivation — that trace names the one input it does not govern.
  for (const rule of surviving) {
    const served = servedTrace.get(rule.node.id);
    if (!served) continue;
    rule.trace = served;
    collected.get(rule.node.id).trace = served;
  }
  for (const [id, beaten] of [...losers].sort((a, b) => compareStrings(a[0], b[0]))) {
    const winner = collected.get(beaten.overriddenBy);
    if (winner) winner.trace = [...winner.trace, traceStep('OVERRIDES', id)];
  }

  // Every SURVIVING Rule that VERIFIED_BY a served Check, not merely the one `keep` happened to
  // collect first: a Check's own `trace` can only ever name ONE derivation, so a Check verified by
  // both a `must` and a `should` Rule would otherwise be indistinguishable from one verified by a
  // `should` Rule alone. D3 needs that full multiplicity to decide "the stronger claim wins"
  // (spec §9 binding semantics #1) without re-walking VERIFIED_BY itself.
  const checkVerifiers = new Map();
  for (const rule of surviving) {
    for (const check of neighbours(index, 'out', 'VERIFIED_BY', rule.node.id, 'Check')) {
      if (keep(check, [...rule.trace, traceStep('VERIFIED_BY', check.id)])) {
        if (!checkVerifiers.has(check.id)) checkVerifiers.set(check.id, new Set());
        checkVerifiers.get(check.id).add(rule.node.id);
      }
    }
    for (const decision of neighbours(index, 'out', 'MOTIVATED_BY', rule.node.id, 'Decision')) {
      keep(decision, [...rule.trace, traceStep('MOTIVATED_BY', decision.id)]);
    }
  }

  // Terms are the last pass: vocabulary used by anything already collected (anchors included).
  for (const source of [...anchors, ...collected.values()]) {
    for (const term of neighbours(index, 'into', 'USED_BY', source.node.id, 'Term')) {
      keep(term, [...source.trace, traceStep('USED_BY', term.id)]);
    }
  }

  const context = emptyContext();
  for (const { node, trace } of collected.values()) {
    if (ANCHOR_TYPES.includes(node.type)) continue;
    context[BUCKETS[node.type]].push(itemOf(node, trace));
  }
  // Collection ORDER decides which derivation an item keeps; RESULT order is the contract:
  // by kind (the fixed `CONTEXT_KINDS` bucket order), then by qualified id.
  for (const bucket of Object.values(context)) bucket.sort((a, b) => compareStrings(a.id, b.id));

  return {
    ok: true,
    code: null,
    projectId,
    input: echo,
    context,
    diagnostics: {
      deprecated: Object.values(context)
        .flat()
        .filter((item) => item.deprecated)
        .map((item) => ({ id: item.id, kind: item.kind })),
      overridden: [...losers.values()].sort((a, b) => compareStrings(a.id, b.id)),
      // Served, but NOT for this input: the flat union carries Rules whose applicability differs
      // per input, and this is what says so. D3 partitions on it.
      overriddenInScope,
      unresolved: [],
      // B4's non-blocking findings, carried rather than dropped: the gate above already computed
      // them, and D3 reports them in Layer 0.
      warnings: validation.warnings,
      // `[{ id: checkId, ruleIds: [ruleId, ...] }]`, sorted — every surviving Rule reaching this
      // Check via VERIFIED_BY, not just the one its own `trace` kept. See the comment above the
      // collection loop.
      checkVerifiers: [...checkVerifiers.entries()]
        .sort((a, b) => compareStrings(a[0], b[0]))
        .map(([id, ruleIds]) => ({ id, ruleIds: [...ruleIds].sort(compareStrings) })),
    },
  };
}
