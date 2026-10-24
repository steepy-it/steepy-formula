// ArcadeDB adapter for the engine port (Task C1), spoken over the Neo4j Bolt wire protocol with
// the pinned `neo4j-driver`. It implements exactly `scripts/formula/engine/port.mjs` and is held
// to the same `tests/formula-engine-contract.test.mjs` suite as the in-memory reference adapter:
// the suite is the specification, this file is one implementation of it.
//
// ---------------------------------------------------------------------------------------------
// STORAGE MODEL — namespaces are a LOGICAL dimension, not separate stores
//
//   (:ApexNode { ns, sid, t, id, p })  -[:ApexEdge { t }]->  (:ApexNode { … })
//
// One vertex type and one edge type; the port's namespace/scenario/type triple lives in
// PROPERTIES, not in labels. Three consequences, all deliberate:
//  1. every query is fully parameterized. A label or a relationship type cannot be a Cypher
//     parameter in any engine, so mapping the port's `type` onto a label would mean assembling it
//     into the query text — the one thing spec §17/§23 forbids. Here `type` is just data.
//  2. `namespace` is one property, so the cross-namespace edge decision (D1, 2026-08-12) landed as
//     a query change and not a migration: nothing is physically partitioned, and a bridge edge is
//     an ordinary `ApexEdge` whose two endpoints simply carry different `ns` values.
//  3. `sid` (scenario id) is '' outside the scenario namespace rather than null, because the
//     unique index below is a composite over (ns, sid, id) and a null key is not a portable index
//     key. '' can never collide with a real scenario id — the port rejects an empty one.
//
// PROPERTY BAG — one JSON string, MEASURED not assumed
// The whole property bag is stored as a single JSON-encoded STRING property `p`. The obvious
// alternative (flatten the bag onto the vertex) was measured against the pinned release and fails
// the port's byte-exact round-trip: ArcadeDB's openCypher `SET` applies Neo4j property-value
// semantics — `SetStep.validatePropertyValue` rejects maps ("Property values can not be maps",
// "…can not contain map values") — and a `null` property value is DROPPED on write, so
// `{ missing: null }` comes back `{}`. CREATE does accept an embedded document, but an adapter
// whose update path cannot express what its create path stored is not an adapter. JSON encoding
// round-trips the entire portable domain (nested objects, mixed arrays, nulls, empty containers,
// hostile strings) through both paths, so that is what ships. The cost is honest: property-level
// server-side constraints and property-level queries are not available on `p`.
//
// CONCURRENCY
// Single-writer by design (spec §19 sole-writer boundary), like the reference adapter. Two
// transactions writing the same record concurrently are outside the port contract: here the
// engine's MVCC raises a concurrent-modification failure at commit rather than the memory
// adapter's last-commit-wins, and that failure surfaces as an engine error, not a PortError.
//
// ERROR MAPPING
// Every condition in the port's vocabulary (NODE_EXISTS, EDGE_ENDPOINT_MISSING, NODE_HAS_EDGES, …)
// is decided by an explicit pre-check inside the same transaction, never by parsing a vendor error
// string: ArcadeDB reports a constraint violation over Bolt as a generic
// `Neo.DatabaseError.General.UnknownError` whose message is the offending Cypher, which carries no
// machine-checkable cause. The engine's own constraints (unique index, mandatory properties, edge
// referential integrity) stay in place underneath as defense in depth — see the measured
// capability map below.
// ---------------------------------------------------------------------------------------------
import neo4j from 'neo4j-driver';
import { randomUUID } from 'node:crypto';
import { isValidProjectId } from '../core/ids.mjs';
import {
  BRIDGE_RELATIONSHIPS,
  PORT_ERROR_CODES,
  SCENARIO_NAMESPACE,
  checkEdgeKey,
  deepFreeze,
  edgeEndpointMissing,
  endpointScopePairs,
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

// --- capability map (spec §19, §20 — declared, and MEASURED, never assumed) ----------------------

// Every entry here is measured against the pinned release by
// `tests/formula-arcadedb.test.mjs → 'capabilities are measured against the live engine'`, which
// fails if this declaration and the measurement disagree. None of it is vendor documentation.
//
//  roles             true  — a server user in the per-database `readonly` group reads over Bolt AND
//                            HTTP and is refused every mutation by the engine: writes and deletes
//                            over Bolt ("User 'x' is not allowed to update schema"), writes and DDL
//                            over HTTP ("not allowed to create records" / "not allowed to update
//                            schema"), and every server command ("Only root user is authorized").
//                            Re-measured end-to-end by `tests/formula-boundary.test.mjs` (task E3).
//  nativeConstraints true  — the engine refuses a duplicate (ns, sid, id) through the unique index
//                            and a record missing a mandatory property, without any help from this
//                            adapter; it also refuses to delete a vertex that still has edges.
//  onlineBackup      true  — `BACKUP DATABASE` completes while the server keeps answering queries.
//  atomicCutover     false — the server command vocabulary (create/drop/open/close/backup/restore/
//                            import) has no database swap or rename, so a shadow graph cannot be
//                            moved into place in one step; the SQL type rename that exists is DDL
//                            applied outside the transaction, so a two-step swap is not atomic.
export const ARCADEDB_CAPABILITIES = deepFreeze({
  roles: true,
  nativeConstraints: true,
  onlineBackup: true,
  atomicCutover: false,
});

// --- storage schema -------------------------------------------------------------------------------

export const NODE_TYPE = 'ApexNode';
export const EDGE_TYPE = 'ApexEdge';

// Created once per database at provisioning time. The mandatory/notnull properties and the unique
// composite index are the engine-side half of the port's integrity promise (`nativeConstraints`).
export const SCHEMA_STATEMENTS = deepFreeze([
  `CREATE VERTEX TYPE ${NODE_TYPE}`,
  `CREATE PROPERTY ${NODE_TYPE}.ns STRING (mandatory true, notnull true)`,
  `CREATE PROPERTY ${NODE_TYPE}.sid STRING (mandatory true, notnull true)`,
  `CREATE PROPERTY ${NODE_TYPE}.t STRING (mandatory true, notnull true)`,
  `CREATE PROPERTY ${NODE_TYPE}.id STRING (mandatory true, notnull true)`,
  `CREATE PROPERTY ${NODE_TYPE}.p STRING (mandatory true, notnull true)`,
  `CREATE INDEX ON ${NODE_TYPE} (ns, sid, id) UNIQUE`,
  `CREATE EDGE TYPE ${EDGE_TYPE}`,
  `CREATE PROPERTY ${EDGE_TYPE}.t STRING (mandatory true, notnull true)`,
  `CREATE INDEX ON ${EDGE_TYPE} (@out, @in, t) UNIQUE`,
]);

// Every statement below is a constant: no value is ever concatenated into query text.
//
// The edge statements take the two endpoint namespaces ($fns, $tns) SEPARATELY rather than one
// $ns: they are equal for every edge except the declared cross-namespace bridges (port.mjs
// `BRIDGE_RELATIONSHIPS`), and a namespace is a parameter here, never a label — so the bridge
// costs a parameter, not a schema change (the storage-model note above anticipated exactly this).
const QUERIES = deepFreeze({
  createNode: `CREATE (n:${NODE_TYPE} {ns:$ns, sid:$sid, t:$t, id:$id, p:$p}) RETURN n.t AS t`,
  getNode: `MATCH (n:${NODE_TYPE} {ns:$ns, sid:$sid, id:$id}) RETURN n.t AS t, n.p AS p`,
  updateNode: `MATCH (n:${NODE_TYPE} {ns:$ns, sid:$sid, id:$id}) SET n.p = $p RETURN n.t AS t`,
  deleteNode: `MATCH (n:${NODE_TYPE} {ns:$ns, sid:$sid, id:$id}) DELETE n`,
  degree: `MATCH (n:${NODE_TYPE} {ns:$ns, sid:$sid, id:$id})--() RETURN count(*) AS c`,
  listNodes: `MATCH (n:${NODE_TYPE} {ns:$ns, sid:$sid}) WHERE ($t IS NULL OR n.t = $t) RETURN n.t AS t, n.id AS id, n.p AS p`,
  endpoints:
    `MATCH (n:${NODE_TYPE} {sid:$sid}) WHERE (n.ns = $fns OR n.ns = $tns) AND (n.id = $fromId OR n.id = $toId) ` +
    `RETURN n.ns AS ns, n.id AS id`,
  createEdge:
    `MATCH (a:${NODE_TYPE} {ns:$fns, sid:$sid, id:$fromId}), (b:${NODE_TYPE} {ns:$tns, sid:$sid, id:$toId}) ` +
    `CREATE (a)-[e:${EDGE_TYPE} {t:$t}]->(b) RETURN count(e) AS c`,
  getEdge:
    `MATCH (a:${NODE_TYPE} {ns:$fns, sid:$sid, id:$fromId})-[e:${EDGE_TYPE} {t:$t}]->` +
    `(b:${NODE_TYPE} {ns:$tns, sid:$sid, id:$toId}) RETURN count(e) AS c`,
  deleteEdge:
    `MATCH (a:${NODE_TYPE} {ns:$fns, sid:$sid, id:$fromId})-[e:${EDGE_TYPE} {t:$t}]->` +
    `(b:${NODE_TYPE} {ns:$tns, sid:$sid, id:$toId}) DELETE e`,
  listEdges:
    `MATCH (a:${NODE_TYPE} {ns:$fns, sid:$sid})-[e:${EDGE_TYPE}]->(b:${NODE_TYPE} {ns:$tns, sid:$sid}) ` +
    `WHERE ($t IS NULL OR e.t = $t) AND ($fromId IS NULL OR a.id = $fromId) AND ($toId IS NULL OR b.id = $toId) ` +
    `RETURN e.t AS t, a.id AS fromId, b.id AS toId`,
  dropScenario: `MATCH (n:${NODE_TYPE} {ns:$ns, sid:$sid}) DETACH DELETE n`,
});

// --- the property codec -----------------------------------------------------------------------------

// The bag is validated by `validateProperties` before it gets here, so it is already inside the
// portable JSON domain: `JSON.stringify` cannot lose anything (no undefined, no NaN, no cycles)
// and `JSON.parse` rebuilds plain, `Object.prototype`-backed objects — which is what the port's
// byte-exact round-trip promises.
export function encodeProperties(properties) {
  return JSON.stringify(properties ?? {});
}

// A bag that cannot be read back is CORRUPTION, and this port promises a byte-exact round-trip —
// so it must not be answered with `{}`, which would hand the caller plausible-looking data and
// hide the damage forever (and, through `updateNode`, overwrite the rest of the real bag with it).
// Nothing a caller passes can reach here: the value comes from storage this adapter wrote, so a
// failure means the record, the schema or the adapter is broken. That is a fault, not a violation
// of the port's data contract, hence a plain Error rather than a PORT_ERROR_CODES entry.
export function decodeProperties(encoded) {
  if (typeof encoded !== 'string') {
    throw new Error(`corrupt stored properties: expected a JSON string, got ${encoded === null ? 'null' : typeof encoded}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    throw new Error(`corrupt stored properties: ${error.message} (stored value: ${JSON.stringify(encoded.slice(0, 120))}).`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`corrupt stored properties: expected a JSON object, got ${JSON.stringify(parsed)?.slice(0, 120)}.`);
  }
  return parsed;
}

// --- server administration (HTTP API — Bolt has no DDL for databases) ---------------------------------

// A database name is interpolated into the server's admin command (`create database <name>`) and
// becomes a directory on the server, so it is held to a strict identifier: no quotes, no spaces,
// no separators, nothing that could traverse a path or close a command.
const DATABASE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function assertDatabaseName(name) {
  if (typeof name !== 'string' || !DATABASE_NAME_PATTERN.test(name)) {
    throw new Error(
      `unsafe database name '${String(name)}': expected [A-Za-z][A-Za-z0-9_]{0,63} — the name reaches a server admin command.`,
    );
  }
  return name;
}

// One deterministic database per project (§24), so every CLI command maps the same project to the
// same store and re-init can recreate it. The project-id rule is looser than the database-name rule
// (hyphens, lowercase only), so the hyphen is folded to an underscore under a product prefix —
// the result is still validated against the stricter rule rather than trusted to the replacement.
export function databaseNameFor(projectId) {
  if (!isValidProjectId(projectId)) {
    throw new Error(
      `databaseNameFor: invalid project id '${String(projectId)}': expected [a-z][a-z0-9-]* (see core/ids.mjs).`,
    );
  }
  return assertDatabaseName(`apex_graph_${projectId.replaceAll('-', '_')}`);
}

function assertServer(server) {
  for (const key of ['httpUrl', 'boltUrl', 'username', 'password']) {
    if (typeof server?.[key] !== 'string' || server[key] === '') {
      throw new Error(`invalid server descriptor: '${key}' is required (got ${JSON.stringify(server?.[key])}).`);
    }
  }
  return server;
}

// A `credentials` override is a full pair: one identity per port, so a read-credential port can
// never fall back to the server's root pair (spec §19). Anything short of that is a typo waiting
// to silently pick up the root credentials, so it is refused outright.
function assertCredentialPair(credentials) {
  if (
    typeof credentials !== 'object' ||
    credentials === null ||
    Array.isArray(credentials) ||
    typeof credentials.username !== 'string' ||
    credentials.username === '' ||
    typeof credentials.password !== 'string' ||
    credentials.password === ''
  ) {
    throw new Error('invalid credentials option: expected { username, password } with non-empty strings.');
  }
  return credentials;
}

function authHeader(server) {
  return `Basic ${Buffer.from(`${server.username}:${server.password}`).toString('base64')}`;
}

async function httpJson(server, path, body) {
  const response = await fetch(`${server.httpUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(server) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(`ArcadeDB ${path} failed (${response.status}): ${payload?.detail ?? payload?.error ?? text.slice(0, 200)}`);
  }
  return payload;
}

// Server-level admin command (`create database`, `drop database`, `create user`, …).
export function serverCommand(server, command) {
  return httpJson(assertServer(server), '/api/v1/server', { command });
}

// Runs SQL (or `sqlscript`) against one database and returns its result rows. Used for schema
// provisioning and for the capability probes — never on the port's data path, which is Bolt only.
export async function runSql(server, database, command, language = 'sql') {
  assertServer(server);
  assertDatabaseName(database);
  const payload = await httpJson(server, `/api/v1/command/${database}`, { language, command });
  return payload?.result ?? [];
}

// --- read-only provisioning (task E3, spec §19) -----------------------------------------------------

// Creates a server user in the per-database `readonly` group, or confirms one already exists.
// Idempotent: an existing user is a no-op success ONLY when the supplied credentials still
// authenticate AND the identity is genuinely read-only on the database — the engine itself refused
// a duplicate re-create (403 "already exists"), so returning here means this helper did the
// verification, and any drift (a changed password, a user promoted to a writable group) is thrown
// loudly rather than silently accepted.
//
// The pinned release has no `list users`/`get user`/`update user` server command, so group
// membership cannot be read directly: it is verified behaviorally, as the C1 capability probe
// measured it — a read succeeds over HTTP and a data write is refused by the ENGINE with an
// authorization message. If a pre-existing user turns out to be a writer, the probe record is
// removed before the helper throws, so even the error path leaves the database clean.
export async function ensureReadonlyUser(server, { username, password, database } = {}) {
  assertServer(server);
  assertDatabaseName(database);
  if (typeof username !== 'string' || username === '' || typeof password !== 'string' || password === '') {
    throw new Error('invalid credentials: { username, password } must be non-empty strings.');
  }

  const create = `create user ${JSON.stringify({ name: username, password, databases: { [database]: ['readonly'] } })}`;
  try {
    await serverCommand(server, create);
    return { created: true, username, database, group: 'readonly' };
  } catch (error) {
    if (!/already exists/i.test(error.message)) throw error;
  }

  // The user exists — verify it is exactly the identity we promise. First the password: a read
  // through the supplied credentials must succeed, or the caller is holding dead credentials.
  const probe = { ...server, username, password };
  try {
    await runSql(probe, database, `SELECT count(*) AS c FROM ${NODE_TYPE}`, 'sql');
  } catch (error) {
    throw new Error(
      `ensureReadonlyUser: user '${username}' already exists on database '${database}' but the supplied password does not authenticate (${error.message}).`,
    );
  }

  // Then read-only-ness: a data write over HTTP by this identity must be refused by the engine.
  const probeId = `ensure-readonly-probe-${randomUUID()}`;
  let writeRefused = false;
  try {
    await runSql(
      probe,
      database,
      `CREATE VERTEX ${NODE_TYPE} SET ns = 'curated', sid = '', t = 'Rule', id = '${probeId}', p = '{}'`,
      'sql',
    );
  } catch (error) {
    if (/not allowed/i.test(error.message)) {
      writeRefused = true;
    } else {
      throw new Error(
        `ensureReadonlyUser: cannot verify user '${username}' is read-only on database '${database}' (${error.message}).`,
      );
    }
  }
  if (!writeRefused) {
    // The pre-existing user can write: undo the probe record, then refuse loudly.
    await runSql(probe, database, `DELETE FROM ${NODE_TYPE} WHERE id = '${probeId}'`, 'sql').catch(() => {});
    throw new Error(
      `ensureReadonlyUser: user '${username}' already exists on database '${database}' and can write — it is not in the readonly group.`,
    );
  }
  return { created: false, username, database, group: 'readonly' };
}

export async function listDatabases(server) {
  const payload = await httpJson(assertServer(server), '/api/v1/databases');
  return payload?.result ?? [];
}

// One database per project (§24) — and, in the contract suite, one database per port so every
// test gets a pristine, isolated store. Creation and schema are one call each.
export async function createDatabase(server, database) {
  assertDatabaseName(database);
  await serverCommand(server, `create database ${database}`);
  await runSql(server, database, SCHEMA_STATEMENTS.join(';\n'), 'sqlscript');
  return database;
}

export async function dropDatabase(server, database) {
  assertDatabaseName(database);
  await serverCommand(server, `drop database ${database}`);
  return database;
}

// --- the driver ----------------------------------------------------------------------------------------

// `disableLosslessIntegers` keeps `count(*)` a plain JS number; property values never travel as
// engine integers (they are inside the JSON string), so nothing else is affected.
export function openDriver(server) {
  assertServer(server);
  return neo4j.driver(server.boltUrl, neo4j.auth.basic(server.username, server.password), {
    disableLosslessIntegers: true,
  });
}

// --- port helpers -------------------------------------------------------------------------------------

// The scope glue (`scopeOf`, `normalizeScope`, `checkEdgeKey`, `nodeNotFound`) is imported from
// `port.mjs`, not reimplemented: it is shared with the reference adapter precisely so the error
// codes, identity bags and validation ORDER the contract suite pins cannot drift between them.
// What is genuinely ArcadeDB's own is below.

// The stored scope columns. `sid` is '' outside the scenario namespace (see the header note).
function scopeParams(scope) {
  return { ns: scope.namespace, sid: scope.scenarioId ?? '' };
}

// The scope columns of one edge's two endpoints. `pair` is an entry of `endpointScopePairs`: the
// same namespace twice for an ordinary edge, the declared pair for a bridge.
function edgeScopeParams(scope, pair) {
  return { fns: pair.fromNamespace, tns: pair.toNamespace, sid: scope.scenarioId ?? '' };
}

function nodeRecord(scope, type, id, encoded) {
  return deepFreeze({ ...scope, type, id, properties: decodeProperties(encoded) });
}

function edgeRecord(scope, type, fromId, toId) {
  return deepFreeze({ ...scope, type, fromId, toId });
}

// --- the port -------------------------------------------------------------------------------------------

// `server` is the descriptor `lifecycle.startServer()` returns; `database` must already exist
// (`createDatabase`). `dropDatabaseOnClose` is what lets the contract suite's factory hand out a
// disposable store per call — production ports own their project database and never drop it.
//
// `credentials` overrides the server's root pair for EVERY operation this port makes as an
// identity — the Bolt driver and, on close, the `dropDatabaseOnClose` drop. A port built with
// read credentials therefore cannot drop its database (the engine refuses); that is deliberate
// (spec §19): the port holds only the identity it was built with, so a read path can never mutate
// governance. Give a read-credential port `dropDatabaseOnClose: false` (the default) and let the
// container/administrator own the database lifecycle.
export function createArcadeDbPort({ server, database, dropDatabaseOnClose = false, credentials } = {}) {
  assertDatabaseName(database);
  const effective = credentials === undefined ? server : { ...server, ...assertCredentialPair(credentials) };
  assertServer(effective);

  const driver = openDriver(effective);
  let closed = false;

  function createTransaction(session, tx) {
    let open = true;

    function requireOpen() {
      if (!open) {
        throw portError(PORT_ERROR_CODES.TRANSACTION_CLOSED, 'This transaction is already committed or rolled back.', {});
      }
    }

    // Every read and write goes through the engine transaction, so a rolled-back transaction
    // leaves no trace and an uncommitted write is invisible elsewhere — enforced by the engine,
    // not simulated here.
    async function run(query, parameters) {
      const result = await tx.run(query, parameters);
      return result.records;
    }

    async function settle(action) {
      requireOpen();
      open = false;
      try {
        await tx[action]();
      } finally {
        await session.close();
      }
    }

    async function readNode(scope, id) {
      const rows = await run(QUERIES.getNode, { ...scopeParams(scope), id });
      return rows.length > 0 ? { type: rows[0].get('t'), properties: rows[0].get('p') } : null;
    }

    // The pair an existing edge was stored under, or null. Tried in `endpointScopePairs` order —
    // same-namespace first — so an adapter never disagrees with the reference one about which
    // edge a (type, fromId, toId) triple names. At most two round-trips, and exactly one for
    // every relationship outside the bridge table.
    async function findEdgePair(scope, type, fromId, toId) {
      for (const pair of endpointScopePairs(scope.namespace, type)) {
        const rows = await run(QUERIES.getEdge, { ...edgeScopeParams(scope, pair), t: type, fromId, toId });
        if (rows.length > 0 && Number(rows[0].get('c')) > 0) return pair;
      }
      return null;
    }

    return {
      async commit() {
        await settle('commit');
      },
      async rollback() {
        await settle('rollback');
      },
      async createNode(input = {}) {
        requireOpen();
        const scope = scopeOf('createNode', input);
        throwIfInvalid([
          ...validateTypeName(input.type),
          ...validateNodeId(input.id),
          ...validateProperties(input.properties),
        ]);

        if (await readNode(scope, input.id)) {
          throw portError(
            PORT_ERROR_CODES.NODE_EXISTS,
            `Node '${input.id}' already exists in namespace '${scope.namespace}'.`,
            { ...scope, id: input.id },
          );
        }

        const encoded = encodeProperties(input.properties);
        await run(QUERIES.createNode, { ...scopeParams(scope), t: input.type, id: input.id, p: encoded });
        return nodeRecord(scope, input.type, input.id, encoded);
      },
      async getNode(input = {}) {
        requireOpen();
        const scope = scopeOf('getNode', input);
        throwIfInvalid(validateNodeId(input.id));
        const found = await readNode(scope, input.id);
        return found ? nodeRecord(scope, found.type, input.id, found.properties) : null;
      },
      async updateNode(input = {}) {
        requireOpen();
        const scope = scopeOf('updateNode', input);
        throwIfInvalid([
          ...validateNodeId(input.id),
          ...validateRequiredArgument(input, 'properties'),
          ...validateProperties(input.properties),
        ]);

        const encoded = encodeProperties(input.properties);
        const rows = await run(QUERIES.updateNode, { ...scopeParams(scope), id: input.id, p: encoded });
        if (rows.length === 0) throw nodeNotFound(scope, input.id);
        return nodeRecord(scope, rows[0].get('t'), input.id, encoded);
      },
      async deleteNode(input = {}) {
        requireOpen();
        const scope = scopeOf('deleteNode', input);
        throwIfInvalid(validateNodeId(input.id));

        if (!(await readNode(scope, input.id))) throw nodeNotFound(scope, input.id);

        // Referential integrity is the port's promise (no dangling endpoints). The engine enforces
        // it too — a connected vertex cannot be deleted — but the port owes the caller a
        // NODE_HAS_EDGES code rather than a vendor message, so the degree is checked explicitly.
        const rows = await run(QUERIES.degree, { ...scopeParams(scope), id: input.id });
        if (rows.length > 0 && Number(rows[0].get('c')) > 0) {
          throw portError(
            PORT_ERROR_CODES.NODE_HAS_EDGES,
            `Node '${input.id}' still has edges in namespace '${scope.namespace}'; remove them first.`,
            { ...scope, id: input.id },
          );
        }
        await run(QUERIES.deleteNode, { ...scopeParams(scope), id: input.id });
      },
      async listNodes(input = {}) {
        requireOpen();
        const scope = scopeOf('listNodes', input);
        if (input.type !== undefined) throwIfInvalid(validateTypeName(input.type));
        const rows = await run(QUERIES.listNodes, { ...scopeParams(scope), t: input.type ?? null });
        return rows.map((row) => nodeRecord(scope, row.get('t'), row.get('id'), row.get('p')));
      },
      async createEdge(input = {}) {
        requireOpen();
        const scope = scopeOf('createEdge', input);
        checkEdgeKey(input);

        // One probe over every namespace this edge may reach, then the pair is resolved here —
        // same-namespace first, the declared bridge pair second (`endpointScopePairs`).
        const pairs = endpointScopePairs(scope.namespace, input.type);
        const rows = await run(QUERIES.endpoints, {
          ...edgeScopeParams(scope, pairs[pairs.length - 1]),
          fromId: input.fromId,
          toId: input.toId,
        });
        const present = new Set(rows.map((row) => `${row.get('ns')} ${row.get('id')}`));
        const exists = (namespace, id) => present.has(`${namespace} ${id}`);

        const resolved = pairs.find(
          (pair) => exists(pair.fromNamespace, input.fromId) && exists(pair.toNamespace, input.toId),
        );
        // Blame is the port's, shared with the reference adapter so both tell one story.
        if (!resolved) throw edgeEndpointMissing(scope, input, pairs, exists);

        if (await findEdgePair(scope, input.type, input.fromId, input.toId)) {
          throw portError(
            PORT_ERROR_CODES.EDGE_EXISTS,
            `Edge ${input.type} ${input.fromId} -> ${input.toId} already exists in namespace '${scope.namespace}'.`,
            { ...scope, type: input.type, fromId: input.fromId, toId: input.toId },
          );
        }

        await run(QUERIES.createEdge, {
          ...edgeScopeParams(scope, resolved),
          t: input.type,
          fromId: input.fromId,
          toId: input.toId,
        });
        return edgeRecord(scope, input.type, input.fromId, input.toId);
      },
      async getEdge(input = {}) {
        requireOpen();
        const scope = scopeOf('getEdge', input);
        checkEdgeKey(input);
        const pair = await findEdgePair(scope, input.type, input.fromId, input.toId);
        return pair ? edgeRecord(scope, input.type, input.fromId, input.toId) : null;
      },
      async deleteEdge(input = {}) {
        requireOpen();
        const scope = scopeOf('deleteEdge', input);
        checkEdgeKey(input);

        const pair = await findEdgePair(scope, input.type, input.fromId, input.toId);
        if (!pair) {
          throw portError(
            PORT_ERROR_CODES.EDGE_NOT_FOUND,
            `Edge ${input.type} ${input.fromId} -> ${input.toId} does not exist in namespace '${scope.namespace}'.`,
            { ...scope, type: input.type, fromId: input.fromId, toId: input.toId },
          );
        }
        await run(QUERIES.deleteEdge, {
          ...edgeScopeParams(scope, pair),
          t: input.type,
          fromId: input.fromId,
          toId: input.toId,
        });
      },
      async listEdges(input = {}) {
        requireOpen();
        const scope = scopeOf('listEdges', input);
        if (input.type !== undefined) throwIfInvalid(validateTypeName(input.type));
        if (input.fromId !== undefined) throwIfInvalid(validateNodeId(input.fromId, 'fromId'));
        if (input.toId !== undefined) throwIfInvalid(validateNodeId(input.toId, 'toId'));

        // The same-namespace listing, plus one listing per bridge relationship whose HOME is this
        // namespace (a bridge edge is listed from its home and nowhere else). A type filter that
        // excludes the bridge type skips its query entirely.
        const queries = [{ pair: { fromNamespace: scope.namespace, toNamespace: scope.namespace }, t: input.type ?? null }];
        for (const [type, rule] of Object.entries(BRIDGE_RELATIONSHIPS)) {
          if (rule.homeNamespace !== scope.namespace) continue;
          if (input.type !== undefined && input.type !== type) continue;
          queries.push({ pair: { fromNamespace: rule.fromNamespace, toNamespace: rule.toNamespace }, t: type });
        }

        const records = [];
        for (const query of queries) {
          const rows = await run(QUERIES.listEdges, {
            ...edgeScopeParams(scope, query.pair),
            t: query.t,
            fromId: input.fromId ?? null,
            toId: input.toId ?? null,
          });
          records.push(...rows.map((row) => edgeRecord(scope, row.get('t'), row.get('fromId'), row.get('toId'))));
        }
        return records;
      },
      async dropScenario(input = {}) {
        requireOpen();
        throwIfInvalid(validateArgumentKeys('dropScenario', input));
        const raw = { namespace: SCENARIO_NAMESPACE, scenarioId: input.scenarioId };
        throwIfInvalid(validateScope(raw));
        const scope = normalizeScope(raw);
        // DETACH DELETE removes the scenario's edges with its nodes in one statement; an unknown
        // scenario simply matches nothing, which is the required no-op.
        await run(QUERIES.dropScenario, scopeParams(scope));
      },
    };
  }

  return {
    async capabilities() {
      return { ...ARCADEDB_CAPABILITIES };
    },
    async begin() {
      if (closed) {
        throw portError(PORT_ERROR_CODES.PORT_CLOSED, 'This port is closed; begin() is no longer available.', {});
      }
      // One session per transaction: a Bolt session carries at most one explicit transaction, and
      // the contract requires two concurrently open transactions to be genuinely independent.
      const session = driver.session({ database });
      return createTransaction(session, session.beginTransaction());
    },
    async close() {
      if (closed) return;
      closed = true;
      // The driver must go first: the database cannot be dropped while a session still holds it.
      await driver.close();
      if (dropDatabaseOnClose) await dropDatabase(effective, database);
    },
  };
}
