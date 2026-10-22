// ChangeSet, hash-chained Revisions and transactional apply — the audit backbone of the Stable
// Knowledge Graph (spec .formula/work/specs/2026-08-11-stable-knowledge-graph.md §21 "Revision and
// audit model", §26 "actor identity", §11 "Promotion workflow", success criterion 13).
//
//   applyChangeSet(port, changeSet, meta) -> { ok, revision, violations }
//   readChain(port, { projectId })        -> { revisions, headRevision, violations }
//   verifyChain(port, { projectId })      -> { ok, revisions, headRevision, violations }
//   replayChain(port, { projectId })      -> { ok, violations, unexplained, missing }
//   historicalNodeIds(revisions)          -> Set of every node id the chain still reserves (§6)
//   historicalNodeEpochs(revisions)       -> the last node op per (namespace, id)
//
// PORT-ONLY I/O (spec §20), exactly like the validator (B4): every read and every write goes
// through the B3 port API, so this module runs identically on the memory adapter and on ArcadeDB.
// It touches no filesystem — a provenance snapshot arrives already measured from the caller.
//
// Structured results, never exceptions on data problems: every function returns
// `{ code, message, identity }` violations, the same triple `ontology.mjs`/`ids.mjs`/`port.mjs`
// return. `applyChangeSet` throws only on programmer error (no port) and re-throws anything that is
// not a `PortError` (an infrastructure failure is not a data problem, and swallowing it would
// report a rolled-back promotion as a mere violation).
//
// ---------------------------------------------------------------------------------------------
// PINNED CONTRACT — Revision and ChangeSet records (D5 promotion apply, B6 export, E2 injection
// and F2 `graph validate` all build on exactly this)
//
// Both are typed nodes in the `system` namespace, "distinct from the curated subgraph" (§21), so
// the closed ontology (B1) never sees them and B4's validator — which reads the curated+topology
// union plus one metadata record — stays green on a graph full of Revisions.
//
//   type `Revision`,  id `apex:<projectId>:revision:r<sequence>`   (CLOSED property set —
//     `REVISION_PROPERTIES`; any other key makes the record MALFORMED_REVISION_RECORD)
//     { id, sequence, previousRevision, previousHash, hash, timestamp,
//       proposer: { type, id }, approver: { type, id },
//       provenance: [{ quotation, source, digest }, ...],
//       changeSetId }
//
//   type `ChangeSet`, id `apex:<projectId>:changeset:c<sequence>`
//     { id, operations: [ ... ] }
//
//   edge  `RECORDS`  Revision -> ChangeSet (same namespace; the Explorer navigates it, §23)
//
// - IDs are SEQUENCE-derived, not hash-derived: the hash covers the id (so a renumbered Revision
//   breaks its own hash), which a hash-derived id could not do without becoming self-referential.
//   `r<n>`/`c<n>` keeps them valid `apex:<projectId>:<kind>:<slug>` ids under B2 (a slug must start
//   with a letter, so a bare number would be malformed).
// - `sequence` is 1-based and contiguous; revision 1 is the genesis, with
//   `previousRevision === null` and `previousHash === null`.
// - `previousRevision` IS the base revision the change was applied on (§11: a proposal "references
//   its base graph revision"), which is why no second `baseRevision` field is stored. `meta
//   .baseRevision`, when a caller supplies it, is an EXPECTATION checked against the head inside the
//   transaction — D5's stale-promotion guard, not another copy of the same fact.
// - `headRevision` on B4's `GraphMetadata` record (`apex:<projectId>:system:graph`) is kept in sync
//   with the chain head IN THE SAME TRANSACTION as the mutation and the Revision.
//
// HASHING (§21 `hash(previous Revision hash + change-set content)`)
//   hash = sha256(canonicalize(every recorded property except `hash`, plus the ChangeSet content))
// `canonicalize` is JSON with object keys sorted at every depth and array order preserved, so the
// bytes are the same on every engine and in every insertion order. NOT an allowlist of fields: an
// allowlist would leave any property appended to a past Revision outside the chain. A superset of the
// spec's minimum, deliberately — if actor identity, timestamp or provenance were unhashed, an auditor
// could rewrite who approved a change without breaking the chain, which is what §26 exists to
// prevent. The Revision property set is CLOSED (`REVISION_PROPERTIES`) and enforced on read, so a
// record carrying an extra field is not a Revision and never reaches a consumer as one.
//
// REPLAY SCOPE: the `curated` and `topology` namespaces — the same union B4 validates, and exactly
// the namespaces a ChangeSet may touch (`CHANGE_NAMESPACES`). Topology writes ARE chained: D1's
// automated writer promotes through this same `applyChangeSet` with the
// `automated-topology-writer` actor type, so no part of the stable graph is outside the audit.
// Being observed rather than authored is also why a `topology` id — and only a topology id — may be
// bound again after an audited removal (`REOPENABLE_NAMESPACE`); replay needs nothing for that,
// because it tracks LIVE state, so ADD -> REMOVE -> ADD already replays as one node.
// The `system` namespace is not replayed: what `verifyChain` catches there is tampering with the
// Revision/ChangeSet records themselves (through the hash chain and the closed record shape) and any
// record of an unexpected TYPE parked in it. The CONTENT of the `GraphMetadata` record beyond the
// head revision — its schema version — stays B4's judgement, not this module's.
// ---------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { GRAPH_SCHEMA_VERSION, isSupportedSchemaVersion } from './ontology.mjs';
import { isValidProjectId, parseQualifiedId, validateIdNotReused, validateLifecycleTransition } from './ids.mjs';
import { GRAPH_VIOLATION_CODES, SYSTEM_RECORD_TYPE, systemRecordId } from './validate-graph.mjs';
import {
  isPortError,
  validateNodeId,
  validateProperties,
  validateTypeName,
  withTransaction,
} from '../engine/port.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// --- record vocabulary ---------------------------------------------------------------------------

// The namespace the audit lives in — "distinct from the curated subgraph" (§21). Spelled locally, as
// B4 does: namespace strings are the port's vocabulary and have exactly one owner.
const SYSTEM_NAMESPACE = 'system';

export const REVISION_TYPE = 'Revision';
export const CHANGE_SET_TYPE = 'ChangeSet';
// System-namespace edge, outside the closed ontology (like the record types themselves): it makes the
// audit navigable in the Explorer (§23) without inventing a curated relationship.
export const RECORDS_RELATIONSHIP = 'RECORDS';
// B1 owns the relationship table; this is the one name a SUPERSEDE operation materializes, spelled
// here and pinned against `RELATIONSHIP_TYPE_NAMES` by the suite so it cannot drift.
export const SUPERSEDES_RELATIONSHIP = 'SUPERSEDES';

// Spec §26: the four typed actor identities. Proposer and approver are separate fields on every
// Revision (the audit must distinguish who proposed from who approved), but neither field is
// restricted to a subset of these types: a migration and an automated topology writer legitimately
// propose and approve their own revisions — there is no human in a topology refresh.
export const ACTOR_TYPES = deepFreeze(['human-approver', 'agent-proposer', 'migration', 'automated-topology-writer']);

export function isActorType(value) {
  return ACTOR_TYPES.includes(value);
}

// --- change operations (spec §11) -----------------------------------------------------------------

export const CHANGE_OPERATIONS = deepFreeze(['ADD', 'MODIFY', 'SUPERSEDE', 'REMOVE']);
export const CHANGE_TARGETS = deepFreeze(['node', 'edge']);

// The stable graph, and only the stable graph. `system` is excluded because a ChangeSet must never
// rewrite the audit record that describes it; `scenario` because a scenario is the PROPOSAL, not the
// applied change (and its records are scenario-partitioned, spec §11).
export const CHANGE_NAMESPACES = deepFreeze(['curated', 'topology']);

// Exactly which keys each `<op>:<target>` shape accepts, mirroring the port's OPERATION_ARGUMENTS
// discipline (B3): anything else is a violation, never a silently dropped field. `MODIFY` and
// `SUPERSEDE` exist only for nodes — edges carry no properties in schema v1, so there is nothing on
// an edge to modify, and lifecycle supersession is a node concept (§6).
export const CHANGE_OPERATION_ARGUMENTS = deepFreeze({
  'ADD:node': ['op', 'target', 'namespace', 'type', 'id', 'properties'],
  'ADD:edge': ['op', 'target', 'namespace', 'type', 'fromId', 'toId'],
  'MODIFY:node': ['op', 'target', 'namespace', 'id', 'properties'],
  'SUPERSEDE:node': ['op', 'target', 'namespace', 'supersededId', 'type', 'id', 'properties'],
  'REMOVE:node': ['op', 'target', 'namespace', 'id'],
  'REMOVE:edge': ['op', 'target', 'namespace', 'type', 'fromId', 'toId'],
});

// --- identity ------------------------------------------------------------------------------------

export function revisionId(projectId, sequence) {
  return `apex:${projectId}:revision:r${sequence}`;
}

export function changeSetId(projectId, sequence) {
  return `apex:${projectId}:changeset:c${sequence}`;
}

// --- canonical serialization and hashing (§21) -----------------------------------------------------

// Deterministic JSON over the portable property domain the port guarantees (string, finite number,
// boolean, null, array, plain object — B3 rejects everything else, so a payload that reached here
// contains nothing exotic): object keys sorted at every depth, array order preserved, no whitespace.
// `undefined` is NOT in that domain and renders as `null`, which is why operations are normalized
// (`normalizeOperations`) before they are hashed or stored: an undefined-valued key would otherwise
// hash differently from the identical ChangeSet written without the key.
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// The CLOSED property set of a Revision record: exactly these keys, no more and no fewer. A record
// carrying anything else is not a Revision (`MALFORMED_REVISION_RECORD`) — without that closure an
// auditor could append plausible-looking fields (`approvalNote`, a second `baseRevision`) to a past
// Revision and hand them to every consumer, which is the forgery §21 exists to prevent.
export const REVISION_PROPERTIES = deepFreeze([
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

// The chain hash covers EVERYTHING the payload carries except `hash` itself — never an allowlist.
// An allowlist would leave any unlisted recorded property outside the chain, so appending one to a
// past Revision would break nothing; the ChangeSet node was already hashed this way (its whole stored
// property object enters the hash), and the Revision now matches it.
//
// Callers pass the Revision's recorded properties plus `changeSet` = the FULL ChangeSet content
// (`{ id, operations }`), so the change a Revision explains is inside the hash and not merely named
// by `changeSetId`. Passing `hash` is harmless: it is stripped, since nothing can hash itself.
export function revisionHash(payload) {
  const { hash: _selfExcluded, ...hashed } = isPlainObject(payload) ? payload : {};
  return sha256Hex(canonicalize(hashed));
}

// --- violation vocabulary --------------------------------------------------------------------------

// The codes THIS module raises. Violations from B2 (`INVALID_PROJECT_ID`, `ID_ALREADY_USED`,
// `ILLEGAL_LIFECYCLE_TRANSITION`), from B3 (`INVALID_NODE_ID`, `INVALID_TYPE`,
// `UNSUPPORTED_PROPERTY_VALUE`, every port error code) and from B4 (`INVALID_METADATA_RECORD_TYPE`,
// `UNSUPPORTED_SCHEMA_VERSION`) are forwarded verbatim, so a consumer must not assume this is the
// closed set — exactly the convention B4 documents.
export const REVISION_VIOLATION_CODES = deepFreeze({
  INVALID_CHANGE_SET: 'INVALID_CHANGE_SET',
  INVALID_CHANGE_OPERATION: 'INVALID_CHANGE_OPERATION',
  UNKNOWN_CHANGE_OPERATION: 'UNKNOWN_CHANGE_OPERATION',
  UNKNOWN_CHANGE_TARGET: 'UNKNOWN_CHANGE_TARGET',
  UNSUPPORTED_OPERATION_TARGET: 'UNSUPPORTED_OPERATION_TARGET',
  UNKNOWN_OPERATION_ARGUMENT: 'UNKNOWN_OPERATION_ARGUMENT',
  MISSING_OPERATION_ARGUMENT: 'MISSING_OPERATION_ARGUMENT',
  INVALID_CHANGE_NAMESPACE: 'INVALID_CHANGE_NAMESPACE',
  INVALID_REVISION_META: 'INVALID_REVISION_META',
  INVALID_ACTOR_IDENTITY: 'INVALID_ACTOR_IDENTITY',
  INVALID_PROVENANCE: 'INVALID_PROVENANCE',
  INVALID_TIMESTAMP: 'INVALID_TIMESTAMP',
  INVALID_BASE_REVISION: 'INVALID_BASE_REVISION',
  STALE_BASE_REVISION: 'STALE_BASE_REVISION',
  HEAD_REVISION_MISSING: 'HEAD_REVISION_MISSING',
  MALFORMED_REVISION_RECORD: 'MALFORMED_REVISION_RECORD',
  UNEXPECTED_SYSTEM_RECORD: 'UNEXPECTED_SYSTEM_RECORD',
  REVISION_HASH_MISMATCH: 'REVISION_HASH_MISMATCH',
  REVISION_LINK_BROKEN: 'REVISION_LINK_BROKEN',
  REVISION_SEQUENCE_BROKEN: 'REVISION_SEQUENCE_BROKEN',
  REVISION_HEAD_MISMATCH: 'REVISION_HEAD_MISMATCH',
  UNEXPLAINED_NODE: 'UNEXPLAINED_NODE',
  UNEXPLAINED_NODE_STATE: 'UNEXPLAINED_NODE_STATE',
  UNEXPLAINED_EDGE: 'UNEXPLAINED_EDGE',
  MISSING_NODE: 'MISSING_NODE',
  MISSING_EDGE: 'MISSING_EDGE',
  OPERATION_NOT_REPLAYABLE: 'OPERATION_NOT_REPLAYABLE',
});

function violation(code, message, identity) {
  return { code, message, identity };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- ChangeSet validation (pure, runs before any transaction is opened) ---------------------------

// Arguments that may be omitted. `properties` on ADD:node means "no properties" (the port defaults
// to an empty bag); on MODIFY:node and SUPERSEDE:node it is required, because `updateNode` REPLACES
// the whole bag and the port refuses to guess (B3 `MISSING_ARGUMENT`).
const OPTIONAL_OPERATION_ARGUMENTS = deepFreeze({ 'ADD:node': ['properties'] });

const CHANGE_OPERATION_REQUIRED = deepFreeze(
  Object.fromEntries(
    Object.entries(CHANGE_OPERATION_ARGUMENTS).map(([shape, accepted]) => [
      shape,
      accepted.filter((key) => key !== 'op' && key !== 'target' && !(OPTIONAL_OPERATION_ARGUMENTS[shape] ?? []).includes(key)),
    ]),
  ),
);

const CHANGE_SET_KEYS = deepFreeze(['operations']);

// Which port validator judges each argument's VALUE. Nothing about ids, types or property domains is
// re-encoded here: `id`/`fromId`/`toId`/`supersededId` are node ids, `type` is a type name, and
// `properties` must live in the portable JSON domain — all three tables belong to B3, and the
// closed ontology (legal types, legal endpoints) belongs to B1 and is enforced on the RESULTING
// graph by B4, never twice.
const ARGUMENT_VALIDATORS = deepFreeze({
  type: (value) => validateTypeName(value),
  id: (value) => validateNodeId(value, 'id'),
  fromId: (value) => validateNodeId(value, 'fromId'),
  toId: (value) => validateNodeId(value, 'toId'),
  supersededId: (value) => validateNodeId(value, 'supersededId'),
  properties: (value) => validateProperties(value),
});

// Validates one operation in isolation, in one order so a single fault yields a single violation:
// shape (op/target/known combination) -> argument names -> required arguments -> argument values.
// `index` is carried into every identity so a caller can point at the offending operation without
// parsing messages.
function validateOperation(operation, index) {
  if (!isPlainObject(operation)) {
    return [
      violation(
        REVISION_VIOLATION_CODES.INVALID_CHANGE_OPERATION,
        `Operation ${index} must be a plain object.`,
        { index, value: operation },
      ),
    ];
  }

  const { op, target } = operation;
  if (!CHANGE_OPERATIONS.includes(op)) {
    return [
      violation(
        REVISION_VIOLATION_CODES.UNKNOWN_CHANGE_OPERATION,
        `Operation ${index} has unknown op '${op}'; expected one of: ${CHANGE_OPERATIONS.join(', ')}.`,
        { index, op },
      ),
    ];
  }
  if (!CHANGE_TARGETS.includes(target)) {
    return [
      violation(
        REVISION_VIOLATION_CODES.UNKNOWN_CHANGE_TARGET,
        `Operation ${index} has unknown target '${target}'; expected one of: ${CHANGE_TARGETS.join(', ')}.`,
        { index, op, target },
      ),
    ];
  }

  const shape = `${op}:${target}`;
  const accepted = CHANGE_OPERATION_ARGUMENTS[shape];
  if (!accepted) {
    return [
      violation(
        REVISION_VIOLATION_CODES.UNSUPPORTED_OPERATION_TARGET,
        `Operation ${index}: '${op}' does not apply to a ${target}.`,
        { index, op, target },
      ),
    ];
  }

  const violations = [];
  const where = { index, op, target };

  for (const key of Object.keys(operation)) {
    if (accepted.includes(key)) continue;
    violations.push(
      violation(
        REVISION_VIOLATION_CODES.UNKNOWN_OPERATION_ARGUMENT,
        `Operation ${index} ('${shape}') does not accept argument '${key}'; accepted: ${accepted.join(', ')}.`,
        { ...where, argument: key },
      ),
    );
  }
  for (const key of CHANGE_OPERATION_REQUIRED[shape]) {
    if (operation[key] !== undefined) continue;
    violations.push(
      violation(
        REVISION_VIOLATION_CODES.MISSING_OPERATION_ARGUMENT,
        `Operation ${index} ('${shape}') is missing required argument '${key}'.`,
        { ...where, argument: key },
      ),
    );
  }
  if (violations.length > 0) return violations;

  if (!CHANGE_NAMESPACES.includes(operation.namespace)) {
    return [
      violation(
        REVISION_VIOLATION_CODES.INVALID_CHANGE_NAMESPACE,
        `Operation ${index} targets namespace '${operation.namespace}'; a ChangeSet may only touch: ${CHANGE_NAMESPACES.join(', ')}.`,
        { ...where, namespace: operation.namespace },
      ),
    ];
  }

  for (const [key, validate] of Object.entries(ARGUMENT_VALIDATORS)) {
    if (!accepted.includes(key) || operation[key] === undefined) continue;
    for (const found of validate(operation[key])) {
      violations.push(violation(found.code, `Operation ${index}: ${found.message}`, { ...found.identity, ...where }));
    }
  }

  return violations;
}

// Validates a whole ChangeSet: the container shape plus every operation. Violations are emitted in
// operation order (the input is an ordered list, so the output is already deterministic — nothing is
// sorted here, unlike the read paths below where the port's list order is not contractual).
// An invalid ChangeSet is never partially applied: `applyChangeSet` refuses the whole set.
export function validateChangeSet(changeSet) {
  if (!isPlainObject(changeSet)) {
    return [
      violation(
        REVISION_VIOLATION_CODES.INVALID_CHANGE_SET,
        'A ChangeSet must be a plain object of the form { operations: [...] }.',
        { value: changeSet },
      ),
    ];
  }
  const violations = [];
  for (const key of Object.keys(changeSet)) {
    if (CHANGE_SET_KEYS.includes(key)) continue;
    violations.push(
      violation(
        REVISION_VIOLATION_CODES.INVALID_CHANGE_SET,
        `A ChangeSet does not accept key '${key}'; accepted: ${CHANGE_SET_KEYS.join(', ')}.`,
        { key },
      ),
    );
  }
  if (!Array.isArray(changeSet.operations) || changeSet.operations.length === 0) {
    violations.push(
      violation(
        REVISION_VIOLATION_CODES.INVALID_CHANGE_SET,
        'A ChangeSet must carry a non-empty `operations` array — an empty promotion records nothing.',
        { operations: changeSet.operations },
      ),
    );
    return violations;
  }
  changeSet.operations.forEach((operation, index) => violations.push(...validateOperation(operation, index)));
  return violations;
}

// --- Revision meta validation (§26 actor identity, §21 provenance snapshot) ------------------------

const META_KEYS = deepFreeze(['projectId', 'proposer', 'approver', 'provenance', 'timestamp', 'baseRevision']);
const PROVENANCE_KEYS = deepFreeze(['quotation', 'source', 'digest']);

// `file:line` (spec §21). The path part is opaque — any non-empty string — because it may be an
// absolute path, a repository-relative one, or a work-graph note; the LINE is what must be exact.
const SOURCE_LOCATION_PATTERN = /^.+:[1-9]\d*$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
// ISO-8601 in UTC only: two revisions must be comparable byte-for-byte across machines, and the port
// carries JSON values, never a Date (B3).
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function validateActor(actor, role) {
  if (!isPlainObject(actor) || !isActorType(actor.type) || typeof actor.id !== 'string' || actor.id === '') {
    return [
      violation(
        REVISION_VIOLATION_CODES.INVALID_ACTOR_IDENTITY,
        `The ${role} must be a typed actor identity { type, id } with type one of: ${ACTOR_TYPES.join(', ')}.`,
        { role, type: isPlainObject(actor) ? actor.type : undefined, value: actor },
      ),
    ];
  }
  return [];
}

function validateProvenanceEntry(entry, index) {
  const bad = (reason) => [
    violation(
      REVISION_VIOLATION_CODES.INVALID_PROVENANCE,
      `Provenance entry ${index} ${reason}: expected { quotation, source: '<file>:<line>', digest: <sha256 hex> }.`,
      { index, value: entry },
    ),
  ];
  if (!isPlainObject(entry)) return bad('is not a plain object');
  for (const key of Object.keys(entry)) {
    if (!PROVENANCE_KEYS.includes(key)) return bad(`does not accept key '${key}'`);
  }
  if (typeof entry.quotation !== 'string' || entry.quotation === '') return bad('has no evidence quotation');
  if (typeof entry.source !== 'string' || !SOURCE_LOCATION_PATTERN.test(entry.source)) return bad('has no <file>:<line> source');
  if (typeof entry.digest !== 'string' || !SHA256_HEX_PATTERN.test(entry.digest)) return bad('has no sha256 source digest');
  return [];
}

// Validates the audit metadata a Revision records. `timestamp` may be omitted (the system clock is
// the authority and `applyChangeSet` fills it); everything else is mandatory, because a Revision
// without a typed proposer, a typed approver and a self-contained provenance snapshot is not an
// audit record — spec §21 is explicit that deleting the Work Graph must never break the trail.
export function validateRevisionMeta(meta) {
  if (!isPlainObject(meta)) {
    return [
      violation(REVISION_VIOLATION_CODES.INVALID_REVISION_META, 'Revision meta must be a plain object.', { value: meta }),
    ];
  }
  const violations = [];
  for (const key of Object.keys(meta)) {
    if (META_KEYS.includes(key)) continue;
    violations.push(
      violation(
        REVISION_VIOLATION_CODES.INVALID_REVISION_META,
        `Revision meta does not accept key '${key}'; accepted: ${META_KEYS.join(', ')}.`,
        { key },
      ),
    );
  }

  if (!isValidProjectId(meta.projectId)) {
    // B2's code, kept verbatim so a caller switching on it does not need to know which module spoke.
    violations.push(
      violation(
        'INVALID_PROJECT_ID',
        `Revision meta requires a valid projectId, got ${JSON.stringify(meta.projectId ?? null)}.`,
        { projectId: meta.projectId },
      ),
    );
  }

  violations.push(...validateActor(meta.proposer, 'proposer'), ...validateActor(meta.approver, 'approver'));

  if (!Array.isArray(meta.provenance) || meta.provenance.length === 0) {
    violations.push(
      violation(
        REVISION_VIOLATION_CODES.INVALID_PROVENANCE,
        'Revision meta requires a non-empty provenance snapshot: every Revision is self-contained (§21).',
        { value: meta.provenance },
      ),
    );
  } else {
    meta.provenance.forEach((entry, index) => violations.push(...validateProvenanceEntry(entry, index)));
  }

  if (meta.timestamp !== undefined && (typeof meta.timestamp !== 'string' || !ISO_UTC_TIMESTAMP_PATTERN.test(meta.timestamp))) {
    violations.push(
      violation(
        REVISION_VIOLATION_CODES.INVALID_TIMESTAMP,
        'A Revision timestamp must be an ISO-8601 UTC string such as 2026-08-12T10:00:00.000Z.',
        { timestamp: meta.timestamp },
      ),
    );
  }

  if (meta.baseRevision !== undefined && meta.baseRevision !== null && typeof meta.baseRevision !== 'string') {
    violations.push(
      violation(
        REVISION_VIOLATION_CODES.INVALID_BASE_REVISION,
        'baseRevision must be a Revision id string, or null for a change built on the empty graph.',
        { baseRevision: meta.baseRevision },
      ),
    );
  }

  return violations;
}

// --- reading the chain (port API only) ---------------------------------------------------------

// A malformed Revision record is DATA, not a crash: a hand-edited system namespace is exactly the
// out-of-band write this module exists to detect. Records that fail this shape check are reported
// and excluded from the ordered chain, so the linkage checks below never dereference garbage.
//
// The key set is CLOSED, not merely sufficient: a record with an extra property is rejected here, and
// (belt and braces) any extra property that reached the hash input would break the hash too. A purely
// positive check would let `{ ...revision, approvalNote: '...' }` pass as a Revision and be served to
// consumers as one.
function isWellFormedRevision(properties) {
  if (!isPlainObject(properties)) return false;
  const keys = Object.keys(properties);
  if (keys.length !== REVISION_PROPERTIES.length || !keys.every((key) => REVISION_PROPERTIES.includes(key))) {
    return false;
  }
  return (
    typeof properties.id === 'string' &&
    Number.isInteger(properties.sequence) &&
    properties.sequence >= 1 &&
    typeof properties.hash === 'string' &&
    (properties.previousRevision === null || typeof properties.previousRevision === 'string') &&
    (properties.previousHash === null || typeof properties.previousHash === 'string') &&
    typeof properties.changeSetId === 'string'
  );
}

function belongsToProject(id, projectId) {
  return parseQualifiedId(id)?.projectId === projectId;
}

// The only node types that belong in the audit namespace. Anything else parked there was written
// outside the Promotion Service and is reported — the closed ontology (B1) deliberately does not
// cover this namespace, and B4 reads only the one metadata record, so nothing else would notice.
const SYSTEM_NODE_TYPES = deepFreeze([REVISION_TYPE, CHANGE_SET_TYPE, SYSTEM_RECORD_TYPE]);

// Reads one project's whole chain inside a caller-supplied transaction: every Revision, joined with
// the ChangeSet it RECORDS, ordered by sequence, plus the declared head from B4's metadata record.
// One place does this, so `applyChangeSet` (which needs the head and the id history), `verifyChain`
// and `replayChain` all see the same records the same way.
//
// One untyped listing of the namespace rather than one call per type: it is the same single pass, and
// it is the only way to see a record whose type belongs to no part of the audit at all.
async function readChainRecords(tx, projectId) {
  const violations = [];
  const changeSets = new Map();
  const revisionNodes = [];

  for (const node of await tx.listNodes({ namespace: SYSTEM_NAMESPACE })) {
    if (!SYSTEM_NODE_TYPES.includes(node.type)) {
      violations.push(
        violation(
          REVISION_VIOLATION_CODES.UNEXPECTED_SYSTEM_RECORD,
          `Record '${node.id}' of type '${node.type}' sits in the '${SYSTEM_NAMESPACE}' namespace, which holds only ${SYSTEM_NODE_TYPES.join(', ')} records.`,
          { namespace: SYSTEM_NAMESPACE, id: node.id, type: node.type },
        ),
      );
      continue;
    }
    if (!belongsToProject(node.id, projectId)) continue;
    if (node.type === CHANGE_SET_TYPE) changeSets.set(node.id, node.properties);
    if (node.type === REVISION_TYPE) revisionNodes.push(node);
  }

  const revisions = [];
  for (const node of revisionNodes) {
    if (!isWellFormedRevision(node.properties)) {
      violations.push(
        violation(
          REVISION_VIOLATION_CODES.MALFORMED_REVISION_RECORD,
          `Revision record '${node.id}' does not carry the pinned Revision shape (exactly: ${REVISION_PROPERTIES.join(', ')}); it cannot take part in the chain.`,
          { id: node.id, namespace: SYSTEM_NAMESPACE },
        ),
      );
      continue;
    }
    revisions.push({ ...node.properties, changeSet: changeSets.get(node.properties.changeSetId) ?? null });
  }
  revisions.sort((a, b) => a.sequence - b.sequence);

  const metadata = await tx.getNode({ namespace: SYSTEM_NAMESPACE, id: systemRecordId(projectId) });
  const headRevision = metadata?.properties?.headRevision ?? null;
  return { revisions, headRevision, metadata, violations };
}

// --- id history and epochs (§6 "an ID is never reused", and its one scoped exception) -------------

// The ONE namespace whose ids may be bound again after an audited removal. A curated id is authored
// and its meaning is permanent (§6: replacing a meaning creates a new node with a SUPERSEDES edge).
// A `topology` id is an OBSERVATION of a repository that legitimately un-does deletions — a reverted
// commit, an undone rename, a directory moved back. Without this exception the first such restore
// would wedge the topology refresh permanently: the second epoch could never be recorded, so no
// LATER refresh of any kind could be either, the stored digest would never converge, and D3's
// staleness check would fail every resolution with a shape the failure table never anticipated.
export const REOPENABLE_NAMESPACE = 'topology';

function epochKey(namespace, id) {
  return canonicalize([namespace, id]);
}

// The LAST node operation the chain recorded for each (namespace, id) — one entry per identity, in
// chain order, so the final entry is the state of its epoch. `SUPERSEDE` binds two ids: the new node
// (`id`) and the retired one (`supersededId`), which stays materialized and therefore bound.
export function historicalNodeEpochs(revisions) {
  const epochs = new Map();
  for (const revision of revisions ?? []) {
    for (const operation of revision?.changeSet?.operations ?? []) {
      if (operation?.target !== 'node') continue;
      const namespace = operation.namespace;
      for (const [id, op] of [
        [operation.id, operation.op],
        [operation.supersededId, 'SUPERSEDE'],
      ]) {
        if (typeof id !== 'string') continue;
        epochs.set(epochKey(namespace, id), { namespace, id, op });
      }
    }
  }
  return epochs;
}

// Every node id the chain still RESERVES, for B2's non-reuse rule. A physically removed node
// (`REMOVE`, §6 reserve) stays reserved — that is the whole point: the port's NODE_EXISTS only sees
// what is still materialized, so only the chain can refuse a resurrected id — EXCEPT in
// `REOPENABLE_NAMESPACE`, where an epoch closed by an audited REMOVE releases its id for a new one.
// Release is by ID, not by (namespace, id): an id another namespace still holds stays reserved
// everywhere, because re-binding it would put one qualified id on two live nodes (B4's blocking
// DUPLICATE_QUALIFIED_ID). Edge endpoints are not collected: they reference ids bound elsewhere.
export function historicalNodeIds(revisions) {
  const epochs = [...historicalNodeEpochs(revisions).values()];
  const ids = new Set(epochs.map((epoch) => epoch.id));
  for (const epoch of epochs) {
    if (epoch.namespace !== REOPENABLE_NAMESPACE || epoch.op !== 'REMOVE') continue;
    // Released only if NO epoch — in any namespace — still holds this id.
    if (epochs.some((other) => other.id === epoch.id && !(other.namespace === REOPENABLE_NAMESPACE && other.op === 'REMOVE'))) {
      continue;
    }
    ids.delete(epoch.id);
  }
  return ids;
}

// --- applying a ChangeSet (spec §11 "atomic database transaction", §21 "same transaction") --------

// Carries a refusal decided INSIDE the transaction out through `withTransaction`, which rolls back on
// any throw. Module-private on purpose: callers see violations, never this class.
class ApplyRejection extends Error {
  constructor(violations) {
    super(violations[0]?.message ?? 'ChangeSet rejected.');
    this.name = 'ApplyRejection';
    this.violations = violations;
  }
}

function reject(code, message, identity) {
  throw new ApplyRejection([violation(code, message, identity)]);
}

// Reads the head of the chain and refuses to append to a graph we do not understand: a metadata
// record of the wrong type, an unsupported schema version (failure table: "refuse normal operation
// and require an explicit schema migration"), a declared head that does not exist, or a caller whose
// declared `baseRevision` is no longer the head (D5 surfaces that as PROMOTION_STALE — checking it
// INSIDE the transaction is what closes the window between D5's check and this write).
//
// It returns the whole chain, not just the head, because the §6 non-reuse rule needs the id history:
// that makes an apply O(revisions), read inside the promotion transaction. Deliberate at the V1
// envelope — a promotion is a rare, human-approved event, and the alternative (a materialized id
// index) would be a second source of truth for exactly the fact the chain already holds.
async function readHeadForAppend(tx, projectId, meta) {
  const { revisions, headRevision, metadata, violations } = await readChainRecords(tx, projectId);
  // A record parked in the audit namespace is reported by `graph validate`, but it says nothing about
  // the CHAIN's integrity, so it must not freeze the Promotion Service. Everything else here does.
  const blocking = violations.filter((found) => found.code !== REVISION_VIOLATION_CODES.UNEXPECTED_SYSTEM_RECORD);
  if (blocking.length > 0) throw new ApplyRejection(blocking);

  const identity = { id: systemRecordId(projectId), namespace: SYSTEM_NAMESPACE };
  if (metadata && metadata.type !== SYSTEM_RECORD_TYPE) {
    reject(
      GRAPH_VIOLATION_CODES.INVALID_METADATA_RECORD_TYPE,
      `Record '${identity.id}' in namespace '${SYSTEM_NAMESPACE}' has type '${metadata.type}', expected '${SYSTEM_RECORD_TYPE}'.`,
      { ...identity, type: metadata.type, expectedType: SYSTEM_RECORD_TYPE },
    );
  }
  if (metadata && !isSupportedSchemaVersion(metadata.properties?.schemaVersion)) {
    reject(
      GRAPH_VIOLATION_CODES.UNSUPPORTED_SCHEMA_VERSION,
      `Graph schema version ${JSON.stringify(metadata.properties?.schemaVersion ?? null)} is not supported (this build writes version ${GRAPH_SCHEMA_VERSION}); an explicit schema migration is required.`,
      { ...identity, schemaVersion: metadata.properties?.schemaVersion ?? null, supportedVersion: GRAPH_SCHEMA_VERSION },
    );
  }

  const head = headRevision === null ? null : revisions.find((revision) => revision.id === headRevision);
  if (headRevision !== null && !head) {
    reject(
      REVISION_VIOLATION_CODES.HEAD_REVISION_MISSING,
      `The metadata record declares head revision '${headRevision}', but no such Revision exists; the chain cannot be extended.`,
      { ...identity, headRevision },
    );
  }
  if (meta.baseRevision !== undefined && meta.baseRevision !== headRevision) {
    reject(
      REVISION_VIOLATION_CODES.STALE_BASE_REVISION,
      `This change was built on revision ${JSON.stringify(meta.baseRevision)} but the graph head is ${JSON.stringify(headRevision)}; it can no longer be applied safely.`,
      { baseRevision: meta.baseRevision, headRevision },
    );
  }

  return { revisions, head, metadata };
}

// One operation against the open transaction. Ontology legality (is this a legal node type? a legal
// relationship endpoint pair?) is NOT judged here — B1 owns those tables and B4 judges the RESULTING
// graph, which is how D4/D5 validate a promotion before approving it. What IS judged here is the one
// domain rule no one else can see at write time: a supersession's lifecycle transition (B2, §6).
async function applyOperation(tx, operation, index) {
  const { op, target, namespace } = operation;
  switch (`${op}:${target}`) {
    case 'ADD:node':
      await tx.createNode({ namespace, type: operation.type, id: operation.id, properties: operation.properties });
      return;
    case 'ADD:edge':
      await tx.createEdge({ namespace, type: operation.type, fromId: operation.fromId, toId: operation.toId });
      return;
    case 'MODIFY:node':
      await tx.updateNode({ namespace, id: operation.id, properties: operation.properties });
      return;
    case 'REMOVE:node':
      await tx.deleteNode({ namespace, id: operation.id });
      return;
    case 'REMOVE:edge':
      await tx.deleteEdge({ namespace, type: operation.type, fromId: operation.fromId, toId: operation.toId });
      return;
    case 'SUPERSEDE:node': {
      const superseded = await tx.getNode({ namespace, id: operation.supersededId });
      if (!superseded) {
        reject(
          'NODE_NOT_FOUND',
          `Operation ${index}: node '${operation.supersededId}' does not exist in namespace '${namespace}'.`,
          { index, op, target, namespace, id: operation.supersededId },
        );
      }
      for (const found of validateLifecycleTransition(superseded.properties?.status, 'superseded')) {
        throw new ApplyRejection([
          violation(found.code, `Operation ${index}: ${found.message}`, {
            ...found.identity,
            index,
            op,
            target,
            namespace,
            id: operation.supersededId,
          }),
        ]);
      }
      await tx.createNode({ namespace, type: operation.type, id: operation.id, properties: operation.properties });
      await tx.updateNode({
        namespace,
        id: operation.supersededId,
        properties: { ...superseded.properties, status: 'superseded' },
      });
      await tx.createEdge({
        namespace,
        type: SUPERSEDES_RELATIONSHIP,
        fromId: operation.id,
        toId: operation.supersededId,
      });
      return;
    }
    default:
      // Unreachable: `validateChangeSet` closed the shape set before the transaction was opened.
      // Spelled out anyway, so a new operation shape cannot silently inherit another one's behavior.
      reject(
        REVISION_VIOLATION_CODES.UNSUPPORTED_OPERATION_TARGET,
        `Operation ${index}: '${op}' does not apply to a ${target}.`,
        { index, op, target },
      );
  }
}

// Projects every operation onto the keys its shape accepts, dropping keys whose value is `undefined`.
// Nothing is lost — unknown keys were already refused by `validateChangeSet`, and `undefined` is not
// a JSON value the port could store. It is also what keeps the hash honest: `{ ...op, properties:
// undefined }` is an everyday JS idiom, and without this it would canonicalize differently from the
// identical ChangeSet written without the key.
function normalizeOperations(operations) {
  return operations.map((operation) => {
    const normalized = {};
    for (const key of CHANGE_OPERATION_ARGUMENTS[`${operation.op}:${operation.target}`]) {
      if (operation[key] !== undefined) normalized[key] = operation[key];
    }
    return normalized;
  });
}

function requirePort(port, caller) {
  if (!port || typeof port.begin !== 'function') {
    throw new TypeError(`${caller} requires a port with a begin() method.`);
  }
}

// Applies a ChangeSet and records the Revision that explains it, in ONE transaction (§21: "a change
// and its record can never diverge, even across a crash"). Returns
// `{ ok, revision, violations }` — `revision` is the written Revision's properties on success and
// `null` on refusal, and a refusal leaves NO trace: the whole set is rolled back, the previous head
// stays readable (failure table: "roll back atomically; prior canonical revision remains readable").
//
// Every `PortError` becomes a violation carrying the port's own code (NODE_EXISTS,
// EDGE_ENDPOINT_MISSING, NODE_HAS_EDGES, ...) so a caller can branch on it — including infrastructure
// codes such as PORT_CLOSED, which D2/D5 map to `KNOWLEDGE_GRAPH_UNAVAILABLE`. Anything that is not a
// PortError (a driver blowing up on commit) propagates untouched: that is not a data problem, and
// reporting it as a mere violation would hide a broken engine.
export async function applyChangeSet(port, changeSet, meta) {
  requirePort(port, 'applyChangeSet');

  const violations = [...validateChangeSet(changeSet), ...validateRevisionMeta(meta)];
  if (violations.length > 0) return { ok: false, revision: null, violations };

  const { projectId, proposer, approver, provenance } = meta;
  const timestamp = meta.timestamp ?? new Date().toISOString();
  const operations = normalizeOperations(changeSet.operations);

  try {
    const revision = await withTransaction(port, async (tx) => {
      const { revisions, head, metadata } = await readHeadForAppend(tx, projectId, meta);

      // §6: an ID is never reused. The port only knows what is still materialized, so the chain's own
      // history is the only place a resurrected (removed, then re-added) id can be caught.
      const history = historicalNodeIds(revisions);
      const reused = [];
      operations.forEach((operation, index) => {
        if (operation.op !== 'ADD' && operation.op !== 'SUPERSEDE') return;
        for (const found of validateIdNotReused(operation.id, history)) {
          reused.push(violation(found.code, `Operation ${index}: ${found.message}`, { ...found.identity, index, op: operation.op }));
        }
      });
      if (reused.length > 0) throw new ApplyRejection(reused);

      for (const [index, operation] of operations.entries()) await applyOperation(tx, operation, index);

      const sequence = head ? head.sequence + 1 : 1;
      const content = { id: changeSetId(projectId, sequence), operations };
      // Every recorded field except `hash`, plus the full ChangeSet content — the exact input an
      // auditor recomputes from the two stored records (`verifyChainRecords` does precisely this).
      const record = {
        id: revisionId(projectId, sequence),
        sequence,
        previousRevision: head ? head.id : null,
        previousHash: head ? head.hash : null,
        timestamp,
        proposer,
        approver,
        provenance,
        changeSetId: content.id,
      };
      const properties = { ...record, hash: revisionHash({ ...record, changeSet: content }) };

      await tx.createNode({ namespace: SYSTEM_NAMESPACE, type: CHANGE_SET_TYPE, id: content.id, properties: content });
      await tx.createNode({ namespace: SYSTEM_NAMESPACE, type: REVISION_TYPE, id: properties.id, properties });
      await tx.createEdge({
        namespace: SYSTEM_NAMESPACE,
        type: RECORDS_RELATIONSHIP,
        fromId: properties.id,
        toId: content.id,
      });

      if (metadata) {
        await tx.updateNode({
          namespace: SYSTEM_NAMESPACE,
          id: systemRecordId(projectId),
          properties: { ...metadata.properties, headRevision: properties.id },
        });
      } else {
        // First promotion on a fresh graph: the metadata record B4 requires does not exist yet, and
        // this is the only writer that can establish it — with the schema version this build writes.
        await tx.createNode({
          namespace: SYSTEM_NAMESPACE,
          type: SYSTEM_RECORD_TYPE,
          id: systemRecordId(projectId),
          properties: { schemaVersion: GRAPH_SCHEMA_VERSION, headRevision: properties.id },
        });
      }

      return structuredClone(properties);
    });
    return { ok: true, revision, violations: [] };
  } catch (error) {
    if (error instanceof ApplyRejection) return { ok: false, revision: null, violations: error.violations };
    if (isPortError(error)) {
      return { ok: false, revision: null, violations: [violation(error.code, error.message, error.identity)] };
    }
    throw error;
  }
}

// --- verifying the chain (§21: "altering a past Revision breaks every later one") ------------------

const CHAIN_INPUT_KEYS = deepFreeze(['projectId']);

// Programmer error throws (no port, no projectId, an unknown input key) — data problems never do.
// Same split as B4's validator, so a typo cannot silently disable an audit.
function normalizeChainInput(port, input, caller) {
  requirePort(port, caller);
  if (!isPlainObject(input)) throw new TypeError(`${caller} requires an input object with a projectId.`);
  for (const key of Object.keys(input)) {
    if (!CHAIN_INPUT_KEYS.includes(key)) {
      throw new TypeError(`${caller}: unknown input key '${key}'; accepted: ${CHAIN_INPUT_KEYS.join(', ')}.`);
    }
  }
  if (!isValidProjectId(input.projectId)) {
    throw new TypeError(`${caller} requires a valid projectId, got ${JSON.stringify(input.projectId ?? null)}.`);
  }
  return input.projectId;
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Deterministic output regardless of the order an adapter returned its records in — `listNodes` order
// is explicitly NOT part of the port contract, so the same graph must still produce the same bytes.
function sortViolations(items) {
  return [...items].sort(
    (a, b) => compareStrings(a.code, b.code) || compareStrings(canonicalize(a.identity), canonicalize(b.identity)),
  );
}

// Reads one project's chain: every Revision joined with the ChangeSet it RECORDS, in sequence order,
// plus the head the metadata record declares. Structural faults that stop a record from taking part
// in the chain at all come back in `violations`; the linkage/hash judgement is `verifyChainRecords`.
export async function readChain(port, input = {}) {
  const projectId = normalizeChainInput(port, input, 'readChain');
  const { revisions, headRevision, violations } = await withTransaction(port, (tx) => readChainRecords(tx, projectId));
  return { revisions, headRevision, violations: sortViolations(violations) };
}

// Pure chain judgement, port-free so B6 can verify an EXPORTED chain offline with the same code:
//
//   1. sequence: 1-based and contiguous. Only the FIRST discontinuity is reported — every later
//      revision is shifted by the same fault, and listing them all would bury it.
//   2. linkage: each record must name its predecessor's id and hash (the genesis names null/null).
//   3. hash: recomputed from the genesis forward, each revision over the RECOMPUTED hash of its
//      predecessor rather than the one it recorded. That is what makes tampering cascade: alter one
//      past Revision and every later hash stops matching, git-style (§21).
//   4. head: the metadata record must name the last revision (null on a graph never promoted).
export function verifyChainRecords(revisions = [], headRevision = null) {
  const violations = [];
  let previous = null;
  let previousComputedHash = null;
  let sequenceBroken = false;

  for (const [index, revision] of revisions.entries()) {
    const expectedSequence = index + 1;
    if (!sequenceBroken && revision.sequence !== expectedSequence) {
      violations.push(
        violation(
          REVISION_VIOLATION_CODES.REVISION_SEQUENCE_BROKEN,
          `Revision '${revision.id}' has sequence ${revision.sequence} where the chain expects ${expectedSequence}: a Revision is missing or was renumbered.`,
          { id: revision.id, sequence: revision.sequence, expectedSequence },
        ),
      );
      sequenceBroken = true;
    }

    const expectedPreviousRevision = previous ? previous.id : null;
    const expectedPreviousHash = previous ? previous.hash : null;
    if (revision.previousRevision !== expectedPreviousRevision || revision.previousHash !== expectedPreviousHash) {
      violations.push(
        violation(
          REVISION_VIOLATION_CODES.REVISION_LINK_BROKEN,
          `Revision '${revision.id}' records a predecessor the chain does not confirm (${JSON.stringify(revision.previousRevision)}, expected ${JSON.stringify(expectedPreviousRevision)}).`,
          {
            id: revision.id,
            sequence: revision.sequence,
            previousRevision: revision.previousRevision,
            expectedPreviousRevision,
            previousHash: revision.previousHash,
            expectedPreviousHash,
          },
        ),
      );
    }

    if (!revision.changeSet) {
      violations.push(
        violation(
          REVISION_VIOLATION_CODES.MALFORMED_REVISION_RECORD,
          `Revision '${revision.id}' records ChangeSet '${revision.changeSetId}', but no such ChangeSet exists: the change it explains is gone.`,
          { id: revision.id, changeSetId: revision.changeSetId, namespace: SYSTEM_NAMESPACE },
        ),
      );
    }

    const computed = revisionHash({ ...revision, previousHash: previousComputedHash, changeSet: revision.changeSet ?? null });
    if (computed !== revision.hash) {
      violations.push(
        violation(
          REVISION_VIOLATION_CODES.REVISION_HASH_MISMATCH,
          `Revision '${revision.id}' does not hash to its recorded value: its content, or that of an earlier Revision, was altered.`,
          { id: revision.id, sequence: revision.sequence, recordedHash: revision.hash, expectedHash: computed },
        ),
      );
    }

    previousComputedHash = computed;
    previous = revision;
  }

  const actualHead = revisions.length > 0 ? revisions[revisions.length - 1].id : null;
  if ((headRevision ?? null) !== actualHead) {
    violations.push(
      violation(
        REVISION_VIOLATION_CODES.REVISION_HEAD_MISMATCH,
        `The metadata record declares head revision ${JSON.stringify(headRevision ?? null)}, but the chain ends at ${JSON.stringify(actualHead)}.`,
        { headRevision: headRevision ?? null, actualHead },
      ),
    );
  }

  return violations;
}

// Reads and judges one project's chain in one transaction: `{ ok, revisions, headRevision, violations }`.
export async function verifyChain(port, input = {}) {
  const projectId = normalizeChainInput(port, input, 'verifyChain');
  const { revisions, headRevision, violations } = await withTransaction(port, (tx) => readChainRecords(tx, projectId));
  const found = [...violations, ...verifyChainRecords(revisions, headRevision)];
  return { ok: found.length === 0, revisions, headRevision, violations: sortViolations(found) };
}

// --- replay: state no Revision explains (§21, success criterion 13) --------------------------------

function nodeKey(namespace, id) {
  return canonicalize([namespace, id]);
}

function edgeKey(namespace, type, fromId, toId) {
  return canonicalize([namespace, type, fromId, toId]);
}

function nodeRecord(namespace, type, id, properties) {
  return { namespace, type, id, properties: properties ?? {} };
}

function edgeRecord(namespace, type, fromId, toId) {
  return { namespace, type, fromId, toId };
}

// THE FOUR OPERATIONS (+ SUPERSEDE) TURNING ONE GRAPH STATE INTO THE NEXT. Extracted from the per-
// revision loop below so that replay (over the chain) and D4's promotion projection (over a base
// graph + candidate operations, in memory) apply a change through ONE function — never two copies of
// the semantics. Returns the list of reasons this operation cannot apply (empty = clean): a MODIFY of
// a node the state does not hold, a REMOVE of one it never had, a SUPERSEDE whose target is missing.
// Like replay, it is TOLERANT: an operation that cannot apply is reported and does not stop the rest,
// and the SUPERSEDE edge is recorded even when its retired endpoint is missing (the chain replay and
// the projection both see the same state that way).
//
// State maps are keyed by `nodeKey`/`edgeKey` and hold `nodeRecord`/`edgeRecord` values, exactly the
// shape `replayOperations` builds.
function applyChangeOperation(nodes, edges, operation) {
  const { namespace, type, id, fromId, toId, properties, supersededId } = operation;
  switch (`${operation.op}:${operation.target}`) {
    case 'ADD:node': {
      const key = nodeKey(namespace, id);
      if (nodes.has(key)) return [`node '${id}' already exists`];
      nodes.set(key, nodeRecord(namespace, type, id, properties));
      return [];
    }
    case 'ADD:edge': {
      const key = edgeKey(namespace, type, fromId, toId);
      if (edges.has(key)) return ['the edge already exists'];
      edges.set(key, edgeRecord(namespace, type, fromId, toId));
      return [];
    }
    case 'MODIFY:node': {
      const key = nodeKey(namespace, id);
      const current = nodes.get(key);
      if (!current) return [`node '${id}' does not exist`];
      nodes.set(key, nodeRecord(namespace, current.type, id, properties));
      return [];
    }
    case 'REMOVE:node': {
      const key = nodeKey(namespace, id);
      if (!nodes.delete(key)) return [`node '${id}' does not exist`];
      return [];
    }
    case 'REMOVE:edge': {
      if (!edges.delete(edgeKey(namespace, type, fromId, toId))) return ['the edge does not exist'];
      return [];
    }
    case 'SUPERSEDE:node': {
      const key = nodeKey(namespace, id);
      if (nodes.has(key)) return [`node '${id}' already exists`];
      nodes.set(key, nodeRecord(namespace, type, id, properties));
      const retired = nodes.get(nodeKey(namespace, supersededId));
      if (!retired) {
        edges.set(
          edgeKey(namespace, SUPERSEDES_RELATIONSHIP, id, supersededId),
          edgeRecord(namespace, SUPERSEDES_RELATIONSHIP, id, supersededId),
        );
        return [`superseded node '${supersededId}' does not exist`];
      }
      nodes.set(
        nodeKey(namespace, supersededId),
        nodeRecord(namespace, retired.type, supersededId, { ...retired.properties, status: 'superseded' }),
      );
      edges.set(
        edgeKey(namespace, SUPERSEDES_RELATIONSHIP, id, supersededId),
        edgeRecord(namespace, SUPERSEDES_RELATIONSHIP, id, supersededId),
      );
      return [];
    }
    default:
      return ['its op/target combination is not a known operation'];
  }
}

// Applies a list of candidate operations (already validated by `validateChangeSet`) to an in-memory
// graph state — Maps of `nodeRecord`/`edgeRecord`, the same shape replay builds — and returns the
// resulting state plus the operations that could not be applied. This is the pure projection D4's
// promotion preview uses to validate the scenario-applied graph WITHOUT touching the port, sharing
// exactly the op semantics the chain itself would replay. The input Maps are NOT mutated; every
// `failure` carries `{ index, op, target, reason }` so a caller can surface each fault without
// parsing messages.
export function applyChangeOperations(nodes, edges, operations) {
  const projected = { nodes: new Map(nodes), edges: new Map(edges) };
  const failures = [];
  (operations ?? []).forEach((operation, index) => {
    if (!isPlainObject(operation)) {
      failures.push({ index, op: null, target: null, reason: 'it is not a plain operation object' });
      return;
    }
    for (const reason of applyChangeOperation(projected.nodes, projected.edges, operation)) {
      failures.push({ index, op: operation.op, target: operation.target, reason });
    }
  });
  return { nodes: projected.nodes, edges: projected.edges, failures };
}

// Rebuilds the state the chain explains, operation by operation, in sequence order. Deliberately
// TOLERANT: a step that cannot apply (a MODIFY of a node no Revision created, a REMOVE of something
// that was never there) is reported as `OPERATION_NOT_REPLAYABLE` and skipped rather than thrown on —
// on a tampered chain that IS the diagnosis, and a diagnostic that crashes diagnoses nothing. The
// per-operation state machine lives in `applyChangeOperation`, shared with D4's projection.
function replayOperations(revisions, violations) {
  const nodes = new Map();
  const edges = new Map();

  for (const revision of revisions) {
    const operations = Array.isArray(revision.changeSet?.operations) ? revision.changeSet.operations : [];
    operations.forEach((operation, index) => {
      const reason = isPlainObject(operation) ? applyChangeOperation(nodes, edges, operation) : ['it is not a plain operation object'];
      for (const why of reason) {
        violations.push(
          violation(
            REVISION_VIOLATION_CODES.OPERATION_NOT_REPLAYABLE,
            `Operation ${index} of Revision '${revision.id}' cannot be replayed: ${why}.`,
            { revision: revision.id, index, op: operation?.op ?? null, target: operation?.target ?? null },
          ),
        );
      }
    });
  }

  return { nodes, edges };
}

// Which properties (and the type) of a materialized node the chain does not account for. `type` sorts
// first when it differs; property names are sorted, so the field list is the same on every run.
function divergentFields(expected, actual) {
  const fields = expected.type === actual.type ? [] : ['type'];
  const expectedProperties = expected.properties ?? {};
  const actualProperties = actual.properties ?? {};
  const keys = new Set([...Object.keys(expectedProperties), ...Object.keys(actualProperties)]);
  for (const key of [...keys].sort(compareStrings)) {
    // PRESENCE is compared separately from value: `canonicalize(undefined)` and `canonicalize(null)`
    // are both 'null', so a value check alone would miss a promoted `owner: null` deleted out of band,
    // and an unpromoted `deprecatedBy: null` added out of band — a null-valued property is a property.
    const inExpected = Object.hasOwn(expectedProperties, key);
    const inActual = Object.hasOwn(actualProperties, key);
    if (inExpected !== inActual || canonicalize(expectedProperties[key]) !== canonicalize(actualProperties[key])) {
      fields.push(key);
    }
  }
  return fields;
}

function sortRecords(records) {
  return [...records].sort((a, b) => compareStrings(canonicalize(a), canonicalize(b)));
}

// Diffs the replayed state against what the database actually holds, both ways: state the chain does
// not explain (the out-of-band WRITE of criterion 13) and state it explains that is gone (the
// out-of-band DELETE — the same fault seen from the other side, and equally unaudited).
function diffMaterialized(expected, materialized, violations) {
  const actualNodes = new Map(materialized.nodes.map((node) => [nodeKey(node.namespace, node.id), node]));
  const actualEdges = new Map(
    materialized.edges.map((edge) => [edgeKey(edge.namespace, edge.type, edge.fromId, edge.toId), edge]),
  );

  const unexplainedNodes = [];
  const unexplainedEdges = [];
  const divergent = [];
  for (const [key, node] of actualNodes) {
    const explained = expected.nodes.get(key);
    if (!explained) {
      unexplainedNodes.push(nodeRecord(node.namespace, node.type, node.id, node.properties));
      continue;
    }
    const fields = divergentFields(explained, node);
    if (fields.length > 0) divergent.push({ node, fields });
  }
  for (const [key, edge] of actualEdges) {
    if (expected.edges.has(key)) continue;
    unexplainedEdges.push(edgeRecord(edge.namespace, edge.type, edge.fromId, edge.toId));
  }

  const missingNodes = [...expected.nodes].filter(([key]) => !actualNodes.has(key)).map(([, node]) => node);
  const missingEdges = [...expected.edges].filter(([key]) => !actualEdges.has(key)).map(([, edge]) => edge);

  for (const node of sortRecords(unexplainedNodes)) {
    violations.push(
      violation(
        REVISION_VIOLATION_CODES.UNEXPLAINED_NODE,
        `Node '${node.id}' exists in namespace '${node.namespace}' but no Revision explains it: it was written outside the Promotion Service.`,
        { namespace: node.namespace, id: node.id, type: node.type },
      ),
    );
  }
  for (const { node, fields } of divergent.sort((a, b) => compareStrings(canonicalize(a.node), canonicalize(b.node)))) {
    violations.push(
      violation(
        REVISION_VIOLATION_CODES.UNEXPLAINED_NODE_STATE,
        `Node '${node.id}' in namespace '${node.namespace}' holds state no Revision explains (${fields.join(', ')}).`,
        { namespace: node.namespace, id: node.id, type: node.type, fields },
      ),
    );
  }
  for (const edge of sortRecords(unexplainedEdges)) {
    violations.push(
      violation(
        REVISION_VIOLATION_CODES.UNEXPLAINED_EDGE,
        `Edge ${edge.type} ${edge.fromId} -> ${edge.toId} exists in namespace '${edge.namespace}' but no Revision explains it.`,
        { namespace: edge.namespace, type: edge.type, fromId: edge.fromId, toId: edge.toId },
      ),
    );
  }
  for (const node of sortRecords(missingNodes)) {
    violations.push(
      violation(
        REVISION_VIOLATION_CODES.MISSING_NODE,
        `The chain explains node '${node.id}' in namespace '${node.namespace}', but it is not materialized: it was deleted outside the Promotion Service.`,
        { namespace: node.namespace, id: node.id, type: node.type },
      ),
    );
  }
  for (const edge of sortRecords(missingEdges)) {
    violations.push(
      violation(
        REVISION_VIOLATION_CODES.MISSING_EDGE,
        `The chain explains edge ${edge.type} ${edge.fromId} -> ${edge.toId} in namespace '${edge.namespace}', but it is not materialized.`,
        { namespace: edge.namespace, type: edge.type, fromId: edge.fromId, toId: edge.toId },
      ),
    );
  }

  return {
    unexplained: { nodes: sortRecords(unexplainedNodes), edges: sortRecords(unexplainedEdges) },
    missing: { nodes: sortRecords(missingNodes), edges: sortRecords(missingEdges) },
  };
}

// Replays the whole chain against the materialized graph and reports every difference — the
// out-of-band write detection of success criterion 13, with the exact nodes and edges.
//
//   { ok, violations, unexplained: { nodes, edges }, missing: { nodes, edges } }
//
// The chain is VERIFIED first and its violations come back in the same list: a chain that does not
// hash-verify cannot certify anything about materialized state, so replay must not report "clean"
// on one. Scope is `CHANGE_NAMESPACES` (curated + topology) — the namespaces a ChangeSet can touch.
// The `system` namespace is judged by the chain verification instead (hash chain, closed record
// shape, unexpected record types), not by this diff.
// A node that IS explained but holds different content is reported as `UNEXPLAINED_NODE_STATE` with
// the differing field names; it is not repeated in `unexplained.nodes`, which lists only records the
// chain never created at all.
export async function replayChain(port, input = {}) {
  const projectId = normalizeChainInput(port, input, 'replayChain');
  const { revisions, headRevision, violations, materialized } = await withTransaction(port, async (tx) => {
    const chain = await readChainRecords(tx, projectId);
    // Every curated/topology record is read, not just this project's: one database holds one project
    // (§24, and B4's `readGraph` reads the same namespaces the same way), so a record carrying another
    // project's id here is itself unexplained state rather than a neighbour to be filtered out.
    const nodes = [];
    const edges = [];
    // Accumulate in a loop, not a spread: at the E1 scale fixture (150k relationships)
    // `edges.push(...listEdges(...))` blows the call stack on the spread argument list — the same
    // amendment E1 made in validate-graph.mjs readGraph. Behavior is identical; only the shape
    // changed.
    for (const namespace of CHANGE_NAMESPACES) {
      for (const node of await tx.listNodes({ namespace })) nodes.push(node);
      for (const edge of await tx.listEdges({ namespace })) edges.push(edge);
    }
    return { ...chain, materialized: { nodes, edges } };
  });

  const found = [...violations, ...verifyChainRecords(revisions, headRevision)];
  const expected = replayOperations(revisions, found);
  const { unexplained, missing } = diffMaterialized(expected, materialized, found);

  return { ok: found.length === 0, violations: sortViolations(found), unexplained, missing };
}
