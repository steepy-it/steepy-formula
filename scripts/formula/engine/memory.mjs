// In-memory reference adapter for the engine port (Task B3). It is the test double every core
// module (B4 validator, B5 revisions, D2 resolver, D4/D5 promotion) develops against, and the
// executable reference for what `scripts/formula/engine/port.mjs` requires — it passes the same
// `tests/formula-engine-contract.test.mjs` suite as the ArcadeDB adapter (C1).
//
// Storage model: two Maps (nodes, edges) keyed by the full scope tuple, holding deep-frozen plain
// records; reads hand back structured clones so a caller can never reach into stored state. An
// edge entry wraps its record with the two namespaces its endpoints resolved in (the same for
// every edge but the declared cross-namespace bridges — see `BRIDGE_RELATIONSHIPS` in port.mjs).
// A transaction works on its own Map copies taken at `begin()`; `commit()` swaps them in,
// `rollback()` drops them — so a rolled-back transaction leaves no trace and uncommitted writes
// are invisible elsewhere. Single-writer by design (spec §19 sole-writer boundary): overlapping
// write transactions are last-commit-wins and are outside the port contract.
import {
  checkEdgeKey,
  deepFreeze,
  edgeEndpointMissing,
  endpointScopePairs,
  NO_NATIVE_CAPABILITIES,
  PORT_ERROR_CODES,
  SCENARIO_NAMESPACE,
  nodeNotFound,
  normalizeScope,
  portError,
  scopeOf,
  throwIfInvalid,
  validateArgumentKeys,
  validateNodeId,
  validateProperties,
  validateRequiredArgument,
  validateScope,
  validateTypeName,
} from './port.mjs';

// Validates a scope on its own (used by dropScenario, which builds its scope from a scenarioId).
// The rest of the scope glue — `normalizeScope`, `scopeOf`, `checkEdgeKey`, `nodeNotFound` — is
// shared with every other adapter from `port.mjs`, so validation ORDER cannot drift between them.
function checkScope(scope) {
  throwIfInvalid(validateScope(scope));
  return normalizeScope(scope);
}

function nodeKey(scope, id) {
  return JSON.stringify([scope.namespace, scope.scenarioId, id]);
}

function inScope(record, scope) {
  return record.namespace === scope.namespace && record.scenarioId === scope.scenarioId;
}

function edgeKey(scope, type, fromId, toId) {
  return JSON.stringify([scope.namespace, scope.scenarioId, type, fromId, toId]);
}

// An edge is stored under its HOME scope, but its endpoints may live in another namespace (the
// closed BRIDGE_RELATIONSHIPS table), so the resolved endpoint namespaces are kept alongside the
// record: they are what `deleteNode` consults to keep dangling endpoints impossible in BOTH
// namespaces. They are storage bookkeeping, never part of the returned record — the pair is
// derivable from (home namespace, type) by anyone who needs it.
function touchesNode(entry, scope, id) {
  const { record } = entry;
  if (record.scenarioId !== scope.scenarioId) return false;
  return (
    (entry.fromNamespace === scope.namespace && record.fromId === id) ||
    (entry.toNamespace === scope.namespace && record.toId === id)
  );
}

export function createMemoryPort() {
  let committed = { nodes: new Map(), edges: new Map() };
  let closed = false;

  function createTransaction() {
    const state = { nodes: new Map(committed.nodes), edges: new Map(committed.edges) };
    let open = true;

    function requireOpen() {
      if (!open) {
        throw portError(
          PORT_ERROR_CODES.TRANSACTION_CLOSED,
          'This transaction is already committed or rolled back.',
          {},
        );
      }
    }

    return {
      async commit() {
        requireOpen();
        open = false;
        committed = state;
      },
      async rollback() {
        requireOpen();
        open = false;
      },
      async createNode(input = {}) {
        requireOpen();
        const scope = scopeOf('createNode', input);
        throwIfInvalid([
          ...validateTypeName(input.type),
          ...validateNodeId(input.id),
          ...validateProperties(input.properties),
        ]);

        const key = nodeKey(scope, input.id);
        if (state.nodes.has(key)) {
          throw portError(
            PORT_ERROR_CODES.NODE_EXISTS,
            `Node '${input.id}' already exists in namespace '${scope.namespace}'.`,
            { ...scope, id: input.id },
          );
        }

        const record = deepFreeze({
          ...scope,
          type: input.type,
          id: input.id,
          properties: structuredClone(input.properties ?? {}),
        });
        state.nodes.set(key, record);
        return structuredClone(record);
      },
      async getNode(input = {}) {
        requireOpen();
        const scope = scopeOf('getNode', input);
        throwIfInvalid(validateNodeId(input.id));
        const record = state.nodes.get(nodeKey(scope, input.id));
        return record ? structuredClone(record) : null;
      },
      async updateNode(input = {}) {
        requireOpen();
        const scope = scopeOf('updateNode', input);
        throwIfInvalid([
          ...validateNodeId(input.id),
          ...validateRequiredArgument(input, 'properties'),
          ...validateProperties(input.properties),
        ]);

        const key = nodeKey(scope, input.id);
        const current = state.nodes.get(key);
        if (!current) throw nodeNotFound(scope, input.id);

        const record = deepFreeze({
          ...scope,
          type: current.type,
          id: current.id,
          properties: structuredClone(input.properties ?? {}),
        });
        state.nodes.set(key, record);
        return structuredClone(record);
      },
      async deleteNode(input = {}) {
        requireOpen();
        const scope = scopeOf('deleteNode', input);
        throwIfInvalid(validateNodeId(input.id));

        const key = nodeKey(scope, input.id);
        if (!state.nodes.has(key)) throw nodeNotFound(scope, input.id);

        // Referential integrity is the port's job (dangling endpoints must be impossible);
        // WHICH edges are legal is the ontology's, enforced by the portable validator. Every edge
        // is examined, not just this namespace's: a bridge edge stored in the OTHER namespace
        // still pins this node down.
        const attached = [...state.edges.values()].some((entry) => touchesNode(entry, scope, input.id));
        if (attached) {
          throw portError(
            PORT_ERROR_CODES.NODE_HAS_EDGES,
            `Node '${input.id}' still has edges in namespace '${scope.namespace}'; remove them first.`,
            { ...scope, id: input.id },
          );
        }

        state.nodes.delete(key);
      },
      async listNodes(input = {}) {
        requireOpen();
        const scope = scopeOf('listNodes', input);
        if (input.type !== undefined) throwIfInvalid(validateTypeName(input.type));
        return [...state.nodes.values()]
          .filter((record) => inScope(record, scope) && (input.type === undefined || record.type === input.type))
          .map((record) => structuredClone(record));
      },
      async createEdge(input = {}) {
        requireOpen();
        const scope = scopeOf('createEdge', input);
        checkEdgeKey(input);

        // Same-namespace pair first, then the declared bridge pair when this scope activates one.
        // Blame for a pair that does not resolve is the port's, not this adapter's (`port.mjs`).
        const pairs = endpointScopePairs(scope.namespace, input.type);
        const exists = (namespace, id) => state.nodes.has(nodeKey({ ...scope, namespace }, id));
        const resolved = pairs.find(
          (pair) => exists(pair.fromNamespace, input.fromId) && exists(pair.toNamespace, input.toId),
        );
        if (!resolved) throw edgeEndpointMissing(scope, input, pairs, exists);

        const key = edgeKey(scope, input.type, input.fromId, input.toId);
        if (state.edges.has(key)) {
          throw portError(
            PORT_ERROR_CODES.EDGE_EXISTS,
            `Edge ${input.type} ${input.fromId} -> ${input.toId} already exists in namespace '${scope.namespace}'.`,
            { ...scope, type: input.type, fromId: input.fromId, toId: input.toId },
          );
        }

        const record = deepFreeze({ ...scope, type: input.type, fromId: input.fromId, toId: input.toId });
        state.edges.set(key, deepFreeze({ record, ...resolved }));
        return structuredClone(record);
      },
      async getEdge(input = {}) {
        requireOpen();
        const scope = scopeOf('getEdge', input);
        checkEdgeKey(input);
        const entry = state.edges.get(edgeKey(scope, input.type, input.fromId, input.toId));
        return entry ? structuredClone(entry.record) : null;
      },
      async deleteEdge(input = {}) {
        requireOpen();
        const scope = scopeOf('deleteEdge', input);
        checkEdgeKey(input);

        const key = edgeKey(scope, input.type, input.fromId, input.toId);
        if (!state.edges.has(key)) {
          throw portError(
            PORT_ERROR_CODES.EDGE_NOT_FOUND,
            `Edge ${input.type} ${input.fromId} -> ${input.toId} does not exist in namespace '${scope.namespace}'.`,
            { ...scope, type: input.type, fromId: input.fromId, toId: input.toId },
          );
        }
        state.edges.delete(key);
      },
      async listEdges(input = {}) {
        requireOpen();
        const scope = scopeOf('listEdges', input);
        if (input.type !== undefined) throwIfInvalid(validateTypeName(input.type));
        if (input.fromId !== undefined) throwIfInvalid(validateNodeId(input.fromId, 'fromId'));
        if (input.toId !== undefined) throwIfInvalid(validateNodeId(input.toId, 'toId'));
        // A bridge edge is listed from its HOME namespace — the scope it is stored under — and
        // from there only, which is exactly what `inScope` on the stored record says.
        return [...state.edges.values()]
          .map((entry) => entry.record)
          .filter(
            (record) =>
              inScope(record, scope) &&
              (input.type === undefined || record.type === input.type) &&
              (input.fromId === undefined || record.fromId === input.fromId) &&
              (input.toId === undefined || record.toId === input.toId),
          )
          .map((record) => structuredClone(record));
      },
      async dropScenario(input = {}) {
        requireOpen();
        // Same rules as any scenario-scoped operation: a scenarioId is required and must be a
        // non-empty string. Dropping an unknown scenario is a no-op, not an error.
        throwIfInvalid(validateArgumentKeys('dropScenario', input));
        const scope = checkScope({ namespace: SCENARIO_NAMESPACE, scenarioId: input.scenarioId });
        for (const [key, record] of state.nodes) {
          if (inScope(record, scope)) state.nodes.delete(key);
        }
        // No bridge pair involves a scenario, so every edge a scenario can hold is its own.
        for (const [key, entry] of state.edges) {
          if (inScope(entry.record, scope)) state.edges.delete(key);
        }
      },
    };
  }

  return {
    async capabilities() {
      return { ...NO_NATIVE_CAPABILITIES };
    },
    async begin() {
      if (closed) {
        throw portError(PORT_ERROR_CODES.PORT_CLOSED, 'This port is closed; begin() is no longer available.', {});
      }
      return createTransaction();
    },
    async close() {
      closed = true;
    },
  };
}
