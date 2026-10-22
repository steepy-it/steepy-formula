// Database port contract for the Stable Knowledge Graph (spec
// .formula/work/specs/2026-08-11-stable-knowledge-graph.md §14 "CLI and core boundary", §20
// "Portable-first enforcement", success criterion 10). This module is the contract itself —
// vocabulary, error type, and pure argument validators shared by every adapter — not an
// implementation: `memory.mjs` (reference/test double) and the ArcadeDB adapter (task C1)
// implement the same surface and are both held to `tests/formula-engine-contract.test.mjs`.
//
// The port is MECHANISM, never POLICY. It speaks in qualified IDs and plain JSON objects, never
// vendor records (criterion 10), and it deliberately knows nothing about the ontology: legal node
// types, legal relationship endpoints, lifecycle transitions and cross-project rejection are owned
// by `core/ontology.mjs` (B1), `core/ids.mjs` (B2) and the portable validator (B4). What the port
// DOES guarantee is storage-level integrity that a real graph engine provides natively:
// namespace separation, scenario isolation, no dangling edge endpoints, and byte-exact round-trip
// of parameterized values.
//
// Error convention: operations reject with a `PortError` carrying the same triple the core
// validation modules return — `{ code, message, identity }` (see `core/ontology.mjs`). `code` is
// a stable machine-checkable reason from `PORT_ERROR_CODES`, `identity` locates the offending
// scope/record without parsing `message`. The pure `validate*` functions below never throw; they
// return a possibly-empty array of those violation objects, and `throwIfInvalid` converts.
//
// ---------------------------------------------------------------------------------------------
// THE PORT SURFACE (every method is async; the contract suite is its executable specification)
//
//   port.capabilities()  -> { roles, nativeConstraints, onlineBackup, atomicCutover } (booleans,
//                           measured by the adapter, never assumed by the core)
//   port.begin()         -> tx                     PORT_CLOSED after close()
//   port.close()         -> void                   idempotent
//
//   tx.commit() / tx.rollback() -> void            TRANSACTION_CLOSED once settled; a rolled-back
//                           transaction leaves no trace of ANY operation (create, update, delete,
//                           dropScenario), and its writes were never visible to another
//                           transaction. Every read and write goes through a tx.
//
// Scope: every node/edge operation takes `{ namespace, scenarioId?, ... }`. `scenarioId` is
// required in the `scenario` namespace and rejected in the others; namespaces are disjoint, so a
// list in one never returns another's records and the same id may exist in several scopes.
// Arguments are exhaustive — see OPERATION_ARGUMENTS: anything else is UNKNOWN_ARGUMENT, never
// silently dropped.
//
//   tx.createNode({ ...scope, type, id, properties? }) -> node        NODE_EXISTS
//   tx.getNode({ ...scope, id })                       -> node | null (null, never an error)
//   tx.updateNode({ ...scope, id, properties })        -> node        NODE_NOT_FOUND,
//                           MISSING_ARGUMENT when `properties` is omitted — it replaces the whole
//                           bag, so clearing it must be explicit (`{}`); `type`/`id` are immutable
//   tx.deleteNode({ ...scope, id })                    -> void        NODE_NOT_FOUND,
//                           NODE_HAS_EDGES while any edge still touches it
//   tx.listNodes({ ...scope, type? })                  -> node[]      (order unspecified)
//
//   tx.createEdge({ ...scope, type, fromId, toId })    -> edge        EDGE_EXISTS,
//                           EDGE_ENDPOINT_MISSING unless both endpoints exist in the same scope —
//                           or, for one of the two BRIDGE_RELATIONSHIPS created in its home
//                           namespace, in that namespace pair (see the table below)
//   tx.getEdge({ ...scope, type, fromId, toId })       -> edge | null
//   tx.deleteEdge({ ...scope, type, fromId, toId })    -> void        EDGE_NOT_FOUND
//   tx.listEdges({ ...scope, type?, fromId?, toId? })  -> edge[]      (order unspecified)
//   tx.dropScenario({ scenarioId })                    -> void        removes all and only that
//                           scenario's records; unknown scenario is a no-op
//
// Records are plain JSON objects, never vendor records (criterion 10), and always copies:
//   node = { namespace, scenarioId, type, id, properties }   scenarioId is null outside `scenario`
//   edge = { namespace, scenarioId, type, fromId, toId }     edges carry no properties in schema v1
//
//   withTransaction(port, fn)  commit on success, rollback on throw; the callback must NOT settle
//                              the transaction itself (TRANSACTION_ALREADY_SETTLED if it does).
// ---------------------------------------------------------------------------------------------

// Exported so adapters freeze their stored records with the same helper (memory.mjs does).
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function violation(code, message, identity) {
  return { code, message, identity };
}

// --- Namespaces (spec §1: curated knowledge, repository topology, promotion scenarios and -----
// system metadata must stay distinguishable by namespace) ---------------------------------------

// Disjoint storage namespaces. A read or write is always scoped to exactly one of them; listing
// one namespace never returns another's records.
export const NAMESPACES = deepFreeze(['curated', 'topology', 'scenario', 'system']);

// The one namespace whose records are additionally partitioned by `scenarioId` (spec §11):
// scenario records are required to carry one, records in every other namespace must not.
export const SCENARIO_NAMESPACE = 'scenario';

export function isNamespace(value) {
  return NAMESPACES.includes(value);
}

// --- Bridge relationships (controller decision 2026-08-12) --------------------------------------
//
// THE CLOSED TABLE OF CROSS-NAMESPACE RELATIONSHIPS. Namespace separation is the port's promise,
// and spec §5 makes two relationships first-class ACROSS that separation: an observed Package
// IMPLEMENTS a curated Component, and a curated Rule APPLIES_TO an observed Package. Exactly these
// two types may span two namespaces; every other relationship keeps strict same-namespace
// enforcement, in every scope.
//
// Each entry declares:
//   fromNamespace / toNamespace  the ONE ordered pair the relationship may span;
//   homeNamespace                where the edge record lives, is created, and is listed — always
//                                one of the two endpoints', because an edge belongs to the side
//                                that owns its lifecycle:
//     IMPLEMENTS  home `topology` — an observed mapping, refreshed with the topology by the
//                 automated topology writer;
//     APPLIES_TO  home `curated`  — curated normative scope, never touched by a topology refresh.
// A scenario or system record is never part of a bridge pair: promotion scenarios are isolated
// (§11) and the system namespace holds audit/metadata records, not graph content.
//
// THE PAIR EXTENDS, IT DOES NOT REPLACE. `APPLIES_TO` is Rule -> Surface (curated) as often as
// Rule -> Package (bridge), so in its home namespace an endpoint is looked up in that namespace
// FIRST and in the declared partner only if it is not there (`endpointScopePairs`). The port stays
// mechanism: it never learns which NODE TYPES an endpoint pair may carry — that is the ontology's
// closed table (`core/ontology.mjs`), enforced on the resulting graph by the portable validator.
export const BRIDGE_RELATIONSHIPS = deepFreeze({
  IMPLEMENTS: { fromNamespace: 'topology', toNamespace: 'curated', homeNamespace: 'topology' },
  APPLIES_TO: { fromNamespace: 'curated', toNamespace: 'topology', homeNamespace: 'curated' },
});

// The bridge rule a (namespace, type) pair activates, or `null`. A bridge is only ever activated
// from its HOME namespace: `IMPLEMENTS` written in `curated` is an ordinary same-namespace edge.
export function bridgeRelationshipFor(namespace, type) {
  const rule = Object.hasOwn(BRIDGE_RELATIONSHIPS, type) ? BRIDGE_RELATIONSHIPS[type] : null;
  return rule && rule.homeNamespace === namespace ? rule : null;
}

// The ordered (fromNamespace, toNamespace) pairs an edge's endpoints may be resolved in: the
// same-namespace pair first, then the declared bridge pair when the scope activates one. Shared by
// every adapter so resolution ORDER — which decides the outcome when the same id exists in both
// namespaces, itself a blocking DUPLICATE_QUALIFIED_ID for the validator — cannot drift.
export function endpointScopePairs(namespace, type) {
  const same = { fromNamespace: namespace, toNamespace: namespace };
  const rule = bridgeRelationshipFor(namespace, type);
  return rule
    ? [same, { fromNamespace: rule.fromNamespace, toNamespace: rule.toNamespace }]
    : [same];
}

// Per endpoint, the ordered namespaces it may be resolved in — the `endpointScopePairs` view an
// endpoint-at-a-time consumer (the validator's endpoint resolution, an adapter's existence probe)
// needs. Deduplicated, home first.
export function endpointNamespaces(namespace, type) {
  const pairs = endpointScopePairs(namespace, type);
  return {
    fromId: [...new Set(pairs.map((pair) => pair.fromNamespace))],
    toId: [...new Set(pairs.map((pair) => pair.toNamespace))],
  };
}

// RETURNS (never throws) the EDGE_ENDPOINT_MISSING rejection for a `createEdge` whose endpoints do
// not resolve into any legal pair, exactly like `nodeNotFound` returns its own. Shared by every
// adapter because BLAME is observable: which endpoint is named, and in which namespaces it was
// looked for, is part of what the contract suite pins — two adapters must not tell the caller two
// different stories about the same rejection.
//
// `exists(namespace, id)` is the adapter's existence predicate over its own storage (already
// probed, so this stays synchronous). The at-fault endpoint is the one that exists in NO namespace
// this edge may reach; when both exist somewhere but not together, the fault is the SPAN itself —
// a bridge used in the wrong direction, whose two ends happen to sit in the mirror-image
// namespaces — and the message says so rather than blaming a node that is plainly there.
export function edgeEndpointMissing(scope, input, pairs, exists) {
  const reachable = { fromId: pairs.map((pair) => pair.fromNamespace), toId: pairs.map((pair) => pair.toNamespace) };
  for (const endpoint of ['fromId', 'toId']) {
    const namespaces = [...new Set(reachable[endpoint])];
    if (namespaces.some((namespace) => exists(namespace, input[endpoint]))) continue;
    return portError(
      PORT_ERROR_CODES.EDGE_ENDPOINT_MISSING,
      `Edge endpoint '${input[endpoint]}' does not exist in namespace '${namespaces.join("' or '")}'.`,
      { ...scope, endpoint, id: input[endpoint] },
    );
  }
  return portError(
    PORT_ERROR_CODES.EDGE_ENDPOINT_MISSING,
    `Edge ${input.type} ${input.fromId} -> ${input.toId} does not span a legal namespace pair from '${scope.namespace}'.`,
    { ...scope, endpoint: 'fromId', id: input.fromId },
  );
}

// --- Capability map (spec §19, §20: native capabilities are ADDITIVE and declared, never --------
// assumed by the core) ---------------------------------------------------------------------------

// - roles:             the engine can enforce a read-only identity server-side (§19 defense in depth)
// - nativeConstraints: the engine can enforce required/type/endpoint constraints itself (§20 additive)
// - onlineBackup:      the engine can back up without stopping (§22)
// - atomicCutover:     the engine can atomically swap a shadow graph into place (§27 schema migration)
export const CAPABILITY_KEYS = deepFreeze(['roles', 'nativeConstraints', 'onlineBackup', 'atomicCutover']);

// Baseline declaration for an adapter with no native capability at all. The portable core behaves
// identically on such an adapter (§20) — that is the point of the map: gaps are recorded, never
// silent. Adapters fill their own map from measurement, not from vendor documentation.
export const NO_NATIVE_CAPABILITIES = deepFreeze(
  Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])),
);

// Validates an adapter's declared capability map: exactly the contract keys, every value boolean.
// Returns structured violations; never throws.
export function validateCapabilities(capabilities) {
  if (!isPlainObject(capabilities)) {
    return [
      violation(PORT_ERROR_CODES.INVALID_CAPABILITIES_VALUE, `Capability map must be a plain object, got ${describeValue(capabilities)}.`, {
        value: capabilities,
      }),
    ];
  }
  const violations = [];
  for (const key of CAPABILITY_KEYS) {
    if (!(key in capabilities)) {
      violations.push(violation(PORT_ERROR_CODES.MISSING_CAPABILITY, `Capability map is missing '${key}'.`, { capability: key }));
    } else if (typeof capabilities[key] !== 'boolean') {
      violations.push(
        violation(
          PORT_ERROR_CODES.INVALID_CAPABILITY_VALUE,
          `Capability '${key}' must be a boolean, got ${describeValue(capabilities[key])}.`,
          { capability: key, value: capabilities[key] },
        ),
      );
    }
  }
  for (const key of Object.keys(capabilities)) {
    if (!CAPABILITY_KEYS.includes(key)) {
      violations.push(violation(PORT_ERROR_CODES.UNKNOWN_CAPABILITY, `Unknown capability '${key}'.`, { capability: key }));
    }
  }
  return violations;
}

// --- Errors ------------------------------------------------------------------------------------

// The port's whole code vocabulary: every code an operation may reject with, plus the codes
// `validateCapabilities` reports. Adapters map engine-specific failures onto it so the core (and
// the contract suite) never branches on vendor error text.
export const PORT_ERROR_CODES = deepFreeze({
  PORT_CLOSED: 'PORT_CLOSED',
  TRANSACTION_CLOSED: 'TRANSACTION_CLOSED',
  TRANSACTION_ALREADY_SETTLED: 'TRANSACTION_ALREADY_SETTLED',
  UNKNOWN_NAMESPACE: 'UNKNOWN_NAMESPACE',
  MISSING_SCENARIO_ID: 'MISSING_SCENARIO_ID',
  UNEXPECTED_SCENARIO_ID: 'UNEXPECTED_SCENARIO_ID',
  INVALID_SCENARIO_ID: 'INVALID_SCENARIO_ID',
  INVALID_NODE_ID: 'INVALID_NODE_ID',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_PROPERTIES_VALUE: 'INVALID_PROPERTIES_VALUE',
  NODE_EXISTS: 'NODE_EXISTS',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  NODE_HAS_EDGES: 'NODE_HAS_EDGES',
  EDGE_EXISTS: 'EDGE_EXISTS',
  EDGE_NOT_FOUND: 'EDGE_NOT_FOUND',
  EDGE_ENDPOINT_MISSING: 'EDGE_ENDPOINT_MISSING',
  UNSUPPORTED_PROPERTY_VALUE: 'UNSUPPORTED_PROPERTY_VALUE',
  UNKNOWN_ARGUMENT: 'UNKNOWN_ARGUMENT',
  MISSING_ARGUMENT: 'MISSING_ARGUMENT',
  INVALID_CAPABILITIES_VALUE: 'INVALID_CAPABILITIES_VALUE',
  MISSING_CAPABILITY: 'MISSING_CAPABILITY',
  INVALID_CAPABILITY_VALUE: 'INVALID_CAPABILITY_VALUE',
  UNKNOWN_CAPABILITY: 'UNKNOWN_CAPABILITY',
});

export class PortError extends Error {
  constructor(code, message, identity = {}) {
    super(message);
    this.name = 'PortError';
    this.code = code;
    this.identity = identity;
  }
}

export function portError(code, message, identity) {
  return new PortError(code, message, identity);
}

export function isPortError(value) {
  return value instanceof PortError;
}

// Converts the violation array produced by the pure validators into the port's throwing channel:
// the first violation becomes a `PortError` with the same code/message/identity.
export function throwIfInvalid(violations) {
  if (Array.isArray(violations) && violations.length > 0) {
    const [first] = violations;
    throw portError(first.code, first.message, first.identity);
  }
}

// --- Pure argument validators (shared by every adapter so codes cannot drift) -------------------

// Exactly which arguments each operation accepts. Anything else is rejected rather than ignored:
// a silently dropped field is a data-loss shape (`createEdge({ ...properties })` losing edge data,
// a typo'd `tpye` creating an untyped node), and callers like B5's ChangeSet apply must find out
// at the call site, not from a later diff. One table so every adapter accepts the same shape.
export const OPERATION_ARGUMENTS = deepFreeze({
  createNode: ['namespace', 'scenarioId', 'type', 'id', 'properties'],
  getNode: ['namespace', 'scenarioId', 'id'],
  updateNode: ['namespace', 'scenarioId', 'id', 'properties'],
  deleteNode: ['namespace', 'scenarioId', 'id'],
  listNodes: ['namespace', 'scenarioId', 'type'],
  createEdge: ['namespace', 'scenarioId', 'type', 'fromId', 'toId'],
  getEdge: ['namespace', 'scenarioId', 'type', 'fromId', 'toId'],
  deleteEdge: ['namespace', 'scenarioId', 'type', 'fromId', 'toId'],
  listEdges: ['namespace', 'scenarioId', 'type', 'fromId', 'toId'],
  dropScenario: ['scenarioId'],
});

// Reports every argument the named operation does not accept. A non-object input reports nothing
// here — `validateScope` (or `validateScenarioId`) already reports it.
export function validateArgumentKeys(operation, input) {
  const accepted = OPERATION_ARGUMENTS[operation];
  if (!isPlainObject(input)) return [];
  return Object.keys(input)
    .filter((key) => !accepted.includes(key))
    .map((key) =>
      violation(
        PORT_ERROR_CODES.UNKNOWN_ARGUMENT,
        `Operation '${operation}' does not accept argument '${key}'; accepted: ${accepted.join(', ')}.`,
        { argument: key },
      ),
    );
}

// `updateNode` replaces the whole property bag, so an omitted one is a request the port refuses to
// guess at: it would silently wipe every property. Clearing stays possible, explicitly, with `{}`.
export function validateRequiredArgument(input, argument) {
  if (!isPlainObject(input) || input[argument] === undefined) {
    return [
      violation(PORT_ERROR_CODES.MISSING_ARGUMENT, `Argument '${argument}' is required.`, { argument }),
    ];
  }
  return [];
}

// Validates the scope every namespaced operation carries: a known namespace, plus a `scenarioId`
// that is required in the scenario namespace (isolation, spec §11) and forbidden everywhere else.
// Malformed input is reported, never thrown on.
export function validateScope(scope) {
  const namespace = scope?.namespace;
  const scenarioId = scope?.scenarioId;

  if (!isNamespace(namespace)) {
    return [
      violation(
        PORT_ERROR_CODES.UNKNOWN_NAMESPACE,
        `Unknown namespace '${String(namespace)}'. Expected one of: ${NAMESPACES.join(', ')}.`,
        { namespace },
      ),
    ];
  }

  if (namespace === SCENARIO_NAMESPACE) {
    if (scenarioId === undefined || scenarioId === null) {
      return [
        violation(
          PORT_ERROR_CODES.MISSING_SCENARIO_ID,
          `Namespace '${SCENARIO_NAMESPACE}' requires a scenarioId — scenario records are isolated per scenario.`,
          { namespace },
        ),
      ];
    }
    if (typeof scenarioId !== 'string' || scenarioId === '') {
      return [
        violation(PORT_ERROR_CODES.INVALID_SCENARIO_ID, 'A scenarioId must be a non-empty string.', { value: scenarioId }),
      ];
    }
  } else if (scenarioId !== undefined && scenarioId !== null) {
    return [
      violation(
        PORT_ERROR_CODES.UNEXPECTED_SCENARIO_ID,
        `Namespace '${namespace}' does not accept a scenarioId — only '${SCENARIO_NAMESPACE}' records are scenario-scoped.`,
        { namespace, scenarioId },
      ),
    ];
  }

  return [];
}

// A node id is opaque to the port: any non-empty string, including hostile ones. Qualified-ID
// syntax (`apex:<projectId>:<localId>`) is `core/ids.mjs`'s business, not the port's.
// `argument` names the offending parameter ('id', 'fromId', 'toId') for the caller's identity bag.
export function validateNodeId(value, argument = 'id') {
  if (typeof value !== 'string' || value === '') {
    return [
      violation(PORT_ERROR_CODES.INVALID_NODE_ID, `Argument '${argument}' must be a non-empty node id string.`, { argument, value }),
    ];
  }
  return [];
}

// A node/edge type is any non-empty string here; which types are legal, and which endpoint pairs a
// relationship permits, is `core/ontology.mjs`'s closed schema, enforced by the validator (B4).
export function validateTypeName(value) {
  if (typeof value !== 'string' || value === '') {
    return [violation(PORT_ERROR_CODES.INVALID_TYPE, 'A node or edge type must be a non-empty string.', { value })];
  }
  return [];
}

// Strictly `Object.prototype`-backed: a null-prototype object is deliberately NOT plain here.
// Engines (and `structuredClone`) rebuild it with `Object.prototype`, so accepting one would break
// the byte-exact round-trip the port promises.
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) === null) return 'a null-prototype object';
    return `a non-plain object (${value.constructor?.name ?? 'unknown'})`;
  }
  return typeof value;
}

// The portable property-value domain: exactly what JSON can carry — string, finite number,
// boolean, null, arrays, and plain nested objects. Everything else (undefined, NaN/Infinity,
// functions, symbols, bigint, Date/Map/Set and other class instances, cycles) is rejected rather
// than silently coerced, because engines coerce differently and §20 requires identical behavior
// on every one of them. Callers encode richer values themselves (e.g. an ISO-8601 timestamp
// string), so what comes back out is byte-identical to what went in on any adapter.
function collectValueViolations(value, path, violations, seen) {
  const type = typeof value;
  if (value === null || type === 'string' || type === 'boolean') return;

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      violations.push(
        violation(
          PORT_ERROR_CODES.UNSUPPORTED_PROPERTY_VALUE,
          `Property '${path}' must be a finite number; NaN and Infinity are not portable.`,
          { property: path, valueType: 'number' },
        ),
      );
    }
    return;
  }

  if (type !== 'object') {
    violations.push(
      violation(
        PORT_ERROR_CODES.UNSUPPORTED_PROPERTY_VALUE,
        `Property '${path}' has unsupported value type '${type}'; use a string, finite number, boolean, null, array or plain object.`,
        { property: path, valueType: type },
      ),
    );
    return;
  }

  if (!Array.isArray(value) && !isPlainObject(value)) {
    violations.push(
      violation(
        PORT_ERROR_CODES.UNSUPPORTED_PROPERTY_VALUE,
        `Property '${path}' is ${describeValue(value)}; only plain objects and arrays are portable.`,
        { property: path, valueType: 'object' },
      ),
    );
    return;
  }

  if (seen.has(value)) {
    violations.push(
      violation(PORT_ERROR_CODES.UNSUPPORTED_PROPERTY_VALUE, `Property '${path}' is a circular reference.`, {
        property: path,
        valueType: 'object',
      }),
    );
    return;
  }

  seen.add(value);
  const entries = Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value);
  for (const [key, item] of entries) collectValueViolations(item, `${path}.${key}`, violations, seen);
  seen.delete(value);
}

// Properties are a plain object whose values all live in the portable JSON domain; an omitted bag
// means "no properties".
export function validateProperties(properties = {}) {
  if (!isPlainObject(properties)) {
    return [
      violation(PORT_ERROR_CODES.INVALID_PROPERTIES_VALUE, `Properties must be a plain object, got ${describeValue(properties)}.`, {
        value: properties,
      }),
    ];
  }
  const violations = [];
  for (const [key, value] of Object.entries(properties)) {
    collectValueViolations(value, key, violations, new Set([properties]));
  }
  return violations;
}

// --- Shared scope glue (the composition every adapter would otherwise repeat) -------------------
//
// The validators above are the vocabulary; these four are the sentences every adapter builds out
// of them, and they live here for the same reason the codes do: two adapters must not drift apart
// in the ORDER they validate. That order is observable — it decides which code a caller sees when
// an argument object is wrong in more than one way (an unknown namespace AND a typo'd argument
// name reports UNKNOWN_NAMESPACE, because which store the caller means is the prior question).

// `scenarioId` is null outside the scenario namespace, so a normalized scope can be part of every
// storage key and of every returned record.
export function normalizeScope(scope) {
  return {
    namespace: scope.namespace,
    scenarioId: scope.namespace === SCENARIO_NAMESPACE ? scope.scenarioId : null,
  };
}

// Validates the scope AND the argument names of one namespace-scoped operation, then normalizes.
// Throws the first violation; returns the scope the adapter should store and echo back.
export function scopeOf(operation, input) {
  throwIfInvalid([...validateScope(input), ...validateArgumentKeys(operation, input)]);
  return normalizeScope(input);
}

// The three arguments that identify one edge; validated identically by create/get/delete.
export function checkEdgeKey(input) {
  throwIfInvalid([
    ...validateTypeName(input.type),
    ...validateNodeId(input.fromId, 'fromId'),
    ...validateNodeId(input.toId, 'toId'),
  ]);
}

// RETURNS (never throws) the NODE_NOT_FOUND rejection, so a caller can decide when to raise it.
export function nodeNotFound(scope, id) {
  return portError(PORT_ERROR_CODES.NODE_NOT_FOUND, `Node '${id}' does not exist in namespace '${scope.namespace}'.`, {
    ...scope,
    id,
  });
}

// --- Transaction helper ------------------------------------------------------------------------

// Runs `fn(tx)` inside one transaction: commit on success, rollback on failure, original error
// rethrown even if the rollback itself fails (the reason the callback threw must not be masked).
// Adapter-independent — it uses nothing but the port API, so every consumer (B5 `applyChangeSet`,
// D5 promotion apply) gets identical atomicity on any engine.
//
// THE CALLBACK MUST NOT SETTLE THE TRANSACTION: `withTransaction` owns its lifecycle. A callback
// that calls `commit()`/`rollback()` itself is a contract breach, and a silent one would be
// dangerous — a later `commit()` on the settled transaction would surface as `TRANSACTION_CLOSED`
// long after the work had durably committed. So the helper detects the settle, honours it (no
// second commit is attempted, the callback's outcome stands) and reports
// `TRANSACTION_ALREADY_SETTLED`, naming which call settled it. A callback that both settles and
// throws still propagates its own error — that is the more informative failure.
export async function withTransaction(port, fn) {
  const tx = await port.begin();
  let settledBy = null;
  const guarded = new Proxy(tx, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property !== 'commit' && property !== 'rollback') return value.bind(target);
      return async (...args) => {
        settledBy = property;
        return value.apply(target, args);
      };
    },
  });

  let result;
  try {
    result = await fn(guarded);
  } catch (error) {
    if (settledBy === null) {
      try {
        await tx.rollback();
      } catch {
        // Deliberately swallowed: the callback's failure is the reportable one.
      }
    }
    throw error;
  }

  if (settledBy !== null) {
    throw portError(
      PORT_ERROR_CODES.TRANSACTION_ALREADY_SETTLED,
      `The withTransaction callback called ${settledBy}() itself; withTransaction owns the transaction lifecycle.`,
      { settledBy },
    );
  }

  await tx.commit();
  return result;
}
