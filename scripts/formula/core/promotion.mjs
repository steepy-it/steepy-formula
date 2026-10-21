// Promotion Scenarios — model, lifecycle, duplicate/conflict advisor and typed diff (spec §7, §11;
// plan task D4), plus the atomic approve path (task D5). Everything between "an agent assembled a
// complete candidate change" and the atomic apply: D5 owns apply, and `applyPromotion` — the only
// mutation entry point D5 adds — calls B5's `applyChangeSet`, the sole writer of the promotion
// transaction.
//
//   createScenario(port, { projectId, scenarioId, proposedBy, operations? }) -> scenario | failure
//   addOperation(port, { projectId, scenarioId, operation })      -> scenario | failure
//   inspectScenario(port, { projectId, scenarioId })              -> inspection | failure
//   discardScenario(port, { projectId, scenarioId })              -> { ok: true }
//   applyPromotion(port, { projectId, scenarioId, approver, provenance, exportDir?, retention?,
//                          fs?, clock? })                         -> applied | failure
//
// PORT-ONLY I/O (spec §20): every read and write goes through the B3 port API inside short
// transactions, so the module runs identically on the memory adapter and on ArcadeDB. Structured
// results, never exceptions on data problems: every function returns `{ ok: true, ... }` on success
// or `{ ok: false, code, message, identity }` — the `{ code, message, identity }` triple the whole
// core speaks. Functions throw only on programmer error (no port, a malformed projectId/scenarioId,
// a non-array `operations` argument); anything a PortError names (NODE_EXISTS, PORT_CLOSED, ...) is
// converted to a structured failure carrying the port's own code.
//
// ---------------------------------------------------------------------------------------------
// THE SCENARIO MODEL
//
// A scenario is a caller-supplied `scenarioId` (non-empty string) living ENTIRELY in the port's
// `scenario` namespace under that id (B3 partitions the namespace by `scenarioId`). It is created
// with ONE meta record — type `PromotionScenario` (`SCENARIO_META_TYPE`), id
// `scenarioMetaId(projectId)`, properties `{ baseRevision, createdAt }`, where `baseRevision` is the
// Revision-chain head at creation (B5 `readChain`) — and its candidate operations are stored as
// ordered scenario-scoped records, never in curated/topology. Two record types, distinguishable BY
// TYPE so a consumer (D5) can never mistake an annotation for a mutation:
//
//   `ScenarioOperation`  one applied candidate — op ∈ B5's vocabulary (ADD / MODIFY / SUPERSEDE /
//                        REMOVE over node/edge), shape-checked by B5's `validateChangeSet`, stored
//                        whole in the record's `operation` property. Only these ever feed apply (D5).
//   `ScenarioAnnotation` one advisor-only op — `POSSIBLE_DUPLICATE` or `POSSIBLE_CONFLICT`, the
//                        closed two-op vocabulary (`ADVISOR_ONLY_OPERATIONS`) a caller records
//                        itself; NOT an applied operation, never `applyChangeSet` input, rendered in
//                        the diff. Stored in the record's `annotation` property.
//
// Every record carries `index` (its global append position) so the candidate list is deterministic;
// record ids are `scenario:op-<n>` / `scenario:annotation-<n>`.
//
// LIFECYCLE — the documented state machine. The only states are `draft` (meta present) and
// `discarded` (nothing left); inspect/preview is a read-only DERIVATION, not a transition (there is
// no approved state here — approval is D5's, gated on rebase).
//
//   createScenario   ∅        -> draft      rejected SCENARIO_EXISTS when the id is already taken;
//                                            the id is reusable after discard
//   addOperation     draft    -> draft      rejected SCENARIO_NOT_FOUND when the scenario is unknown
//   inspectScenario  draft    -> draft      read-only; unknown id -> SCENARIO_NOT_FOUND
//   discardScenario  any      -> ∅          idempotent — an unknown scenario is a no-op (B3)
//
// No scenario operation ever touches the curated/topology namespaces.
//
// ---------------------------------------------------------------------------------------------
// THE ADVISOR (spec §7 same-concern detection) — re-derived at EVERY inspect, never stored, so the
// preview is always current. Advisory findings carry the two ids, the concern/similarity evidence
// and a suggested resolution; they never block the scenario (that is the point of "before stable
// mutation" — the human chooses keep-one / disjoint scopes / explicit override/supersession).
//
//   POSSIBLE_CONFLICT  two applicable Rules (active/deprecated — `APPLICABLE_RULE_STATUSES`) sharing
//                      a `concern` with no valid OVERRIDES path between them, resolved by exactly
//                      B4's `overridesClosure` + `resolveOverrideGroup` so the advisor and the
//                      validator agree. Scope comparison uses the HIERARCHICAL OVERLAP notion the
//                      controller mandated (B4 design boundary (c)): a Rule covers every scope
//                      target AND every descendant of it along PART_OF/IMPLEMENTS, so a proposed
//                      Rule on a Component conflicts with an existing one on the parent Surface —
//                      a pair B4's shared-APPLIES_TO-target check cannot see. That makes the advisor
//                      strictly at least as strict as B4 (every shared target is a location both
//                      cover), never more lenient. Pairs both sides of which are STABLE are left to
//                      B4 (they surface as projection findings), so the advisor reports the
//                      scenario's own contribution.
//   POSSIBLE_DUPLICATE a proposed ADD whose normalized title/statement matches a stable Rule of the
//                      same kind, or another proposed ADD. V1 heuristics only — exact and
//                      normalized-blank-insensitive (whitespace runs collapse to one space, both
//                      ends trimmed); the semantic near-duplicate detector stays deferred (§10), no
//                      embeddings are built.
//
// ---------------------------------------------------------------------------------------------
// STRUCTURAL VALIDATION OF THE SCENARIO-APPLIED GRAPH (binding 6)
//
// The projection = the CURRENT stable graph + the scenario's applied ops (POSSIBLE_* ignored),
// applied deterministically by B5's pure `applyChangeOperations` — the SAME state machine the chain
// replays, not a re-derivation — and judged by B4's `checkGraphState` (additive export: the exact
// blocking-invariant + warning machinery `validateGraph` runs, over in-memory records). Projection
// failures (an op that cannot apply, e.g. a MODIFY of a node the graph does not hold) are surfaced
// as `OPERATION_NOT_APPLICABLE` findings alongside the invariant violations. One fault never
// suppresses the others (B4 design boundary (d)): the projection applies every op and reports every
// failure. The scenario is not "valid" until this projection is clean.
//
// ---------------------------------------------------------------------------------------------
// PROMOTION_STALE (binding 7, failure table row)
//
// At create, `baseRevision` is pinned to the chain head. At inspect/preview, it is compared against
// the CURRENT head (`readChain`); on mismatch the scenario is stale — `inspectScenario` reports
// `stale: { code: 'PROMOTION_STALE', scenarioId, baseRevision, headRevision }` and the typed diff
// header states it, so a stale preview is never shown as current. A stale scenario stays
// inspectable and discardable; only approval (D5) is gated on rebase.
// ---------------------------------------------------------------------------------------------
// THE APPROVE PATH (task D5 — applyPromotion)
//
//   applyPromotion(port, { projectId, scenarioId, approver, provenance, exportDir?, retention?,
//                          fs?, clock? }) -> { ok, scenarioId, applied, headRevision,
//                                              scenarioConsumed, export } | failure
//
// The human-approval boundary and the ONLY new mutation entry point D5 adds. Re-validates, never
// trusts the last inspect: the scenario must exist (`SCENARIO_NOT_FOUND`), hold at least one
// applied operation (`SCENARIO_EMPTY`), be based on the current chain head (`PROMOTION_STALE` —
// D4's inspect-time staleness is advisory; THIS check is the authority at the boundary), and
// project to a B4-clean graph (`SCENARIO_INVALID`, the D4 rout-forward: a scenario whose candidate
// introduces a blocking conflict is structurally NOT valid until the human resolves it, §7). The
// approver identity and the provenance snapshot are judged by B5's `validateRevisionMeta` — passed
// through, never re-derived. Only `ScenarioOperation` records reach the ChangeSet (annotations are
// filtered by record type). The change is applied via B5 `applyChangeSet` in ONE transaction
// (mutation + Revision + head), so a mid-apply failure rolls back atomically and the prior revision
// stays readable. On success the signed export (B6) is written into `exportDir` and retention is
// pruned; a post-commit export failure is REPORTED (`EXPORT_WRITE_FAILED`), never rolled back — the
// promotion is durable and the export is a derived, regenerable artifact (§22, criterion 14). The
// scenario is then consumed (`dropScenario`): its change is permanently recorded in the Revision
// chain and the proposal is disposable by design. Export names embed the promoted head revision and
// a timestamp (`promotionExportFileName`); with no `exportDir` configured the export step is
// skipped and `export` is `null`.
// ---------------------------------------------------------------------------------------------

import { join } from 'node:path';
import { buildQualifiedId, isValidProjectId } from './ids.mjs';
import {
  APPLICABLE_RULE_STATUSES,
  SCENARIO_META_TYPE,
  checkGraphState,
  overridesClosure,
  resolveOverrideGroup,
  scenarioMetaId,
} from './validate-graph.mjs';
import { EXPORT_FILE_EXTENSION, exportGraph, pruneExportDirectory } from './export.mjs';
import {
  ACTOR_TYPES,
  CHANGE_OPERATIONS,
  applyChangeOperations,
  applyChangeSet,
  canonicalize,
  isActorType,
  readChain,
  validateChangeSet,
  validateRevisionMeta,
} from './revision.mjs';
import { isPortError, withTransaction } from '../engine/port.mjs';

const SCENARIO_NAMESPACE = 'scenario';
const STABLE_NAMESPACES = deepFreeze(['curated', 'topology']);
const RULE_TYPE = 'Rule';
const SCOPE_RELATIONSHIPS = deepFreeze(['PART_OF', 'IMPLEMENTS']);

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

function failure(code, message, identity) {
  return { ok: false, code, message, identity };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function jsonValue(value) {
  return JSON.stringify(value);
}

// --- vocabulary -----------------------------------------------------------------------------------

// Record types in the scenario namespace: applied candidates vs advisor-only annotations,
// distinguishable by type so D5 can filter and can never promote an annotation.
export const SCENARIO_OPERATION_TYPE = 'ScenarioOperation';
export const SCENARIO_ANNOTATION_TYPE = 'ScenarioAnnotation';

// The two advisor-only operations. They are records in the scenario namespace, never
// `applyChangeSet` input, never part of the applied change; they are listable/inspectable and
// rendered in the typed diff.
export const ADVISOR_ONLY_OPERATIONS = deepFreeze(['POSSIBLE_DUPLICATE', 'POSSIBLE_CONFLICT']);

// Structural finding code for an applied candidate that the projection could not apply (the
// projection analog of B5's `OPERATION_NOT_REPLAYABLE` for a tampered chain).
export const PROJECTION_OPERATION_FAILURE = 'OPERATION_NOT_APPLICABLE';

// The codes THIS module returns. Violations from B1 (`MISSING_REQUIRED_PROPERTY`, ...) and B4
// (`GRAPH_VIOLATION_CODES`) surface as structural findings, never here; codes from B5's
// `validateRevisionMeta` and from the port are forwarded verbatim by `applyPromotion`.
export const PROMOTION_ERROR_CODES = deepFreeze({
  SCENARIO_NOT_FOUND: 'SCENARIO_NOT_FOUND',
  SCENARIO_EXISTS: 'SCENARIO_EXISTS',
  INVALID_SCENARIO_OPERATION: 'INVALID_SCENARIO_OPERATION',
  PROMOTION_STALE: 'PROMOTION_STALE',
  SCENARIO_EMPTY: 'SCENARIO_EMPTY',
  SCENARIO_INVALID: 'SCENARIO_INVALID',
  EXPORT_WRITE_FAILED: 'EXPORT_WRITE_FAILED',
});

// Closed shape of an advisor-only annotation. `concern` is mandatory on a POSSIBLE_CONFLICT (that
// is the evidence §7 names); `matchedProperty`/`matchedValue` document a POSSIBLE_DUPLICATE.
const ADVISOR_ONLY_OPERATION_ARGUMENTS = deepFreeze({
  POSSIBLE_DUPLICATE: ['op', 'candidateId', 'againstId', 'matchedProperty', 'matchedValue'],
  POSSIBLE_CONFLICT: ['op', 'candidateId', 'againstId', 'concern'],
});

// --- identity -------------------------------------------------------------------------------------

function scenarioOperationId(projectId, sequence) {
  return buildQualifiedId(projectId, `scenario:op-${sequence}`);
}

function scenarioAnnotationId(projectId, sequence) {
  return buildQualifiedId(projectId, `scenario:annotation-${sequence}`);
}

// --- errors ---------------------------------------------------------------------------------------

// Carries a refusal decided INSIDE a transaction out through `withTransaction` (which rolls back on
// any throw) — the same pattern B5's `ApplyRejection` uses.
class DataRejection extends Error {
  constructor(code, message, identity) {
    super(message);
    this.name = 'DataRejection';
    this.code = code;
    this.message = message;
    this.identity = identity;
  }
}

// Converts the rejection channel back to the structured-failure channel: a `DataRejection` returns
// its own failure, a `PortError` becomes a failure carrying the port's code (a data/engine problem,
// never a crash), and anything else — a real infrastructure bug — propagates.
function rejectWith(error, extra = {}) {
  if (error instanceof DataRejection) return failure(error.code, error.message, { ...error.identity, ...extra });
  if (isPortError(error)) return failure(error.code, error.message, { ...error.identity, ...extra });
  throw error;
}

// --- input contract -------------------------------------------------------------------------------

function normalizeScenarioInput(port, input, caller) {
  if (!port || typeof port.begin !== 'function') {
    throw new TypeError(`${caller} requires a port with a begin() method.`);
  }
  if (!isPlainObject(input)) {
    throw new TypeError(`${caller} requires an input object with a projectId and a scenarioId.`);
  }
  const { projectId, scenarioId } = input;
  if (!isValidProjectId(projectId)) {
    throw new TypeError(`${caller} requires a valid projectId, got ${JSON.stringify(projectId ?? null)}.`);
  }
  if (typeof scenarioId !== 'string' || scenarioId === '') {
    throw new TypeError(`${caller} requires a non-empty scenarioId string, got ${JSON.stringify(scenarioId ?? null)}.`);
  }
  return { projectId, scenarioId };
}

// A typo must never silently drop an argument — the same closed-input discipline B4/B5/D2/D3 use.
function rejectUnknownKeys(input, accepted, caller) {
  for (const key of Object.keys(input)) {
    if (accepted.includes(key)) continue;
    throw new TypeError(`${caller}: unknown input key '${key}'; accepted: ${accepted.join(', ')}.`);
  }
}

// The proposing actor is REQUIRED at create and recorded on the meta (`proposedBy`) so the audit
// always distinguishes proposer from approver (§26) — the proposer is never invented at apply
// (binding 1). Recorded as `{ type, name }` (the proposing agent's human-readable identity); B5's
// Revision records it as `{ type, id }` when the apply happens.
function validateProposedBy(proposedBy) {
  if (!isPlainObject(proposedBy) || !isActorType(proposedBy.type) || typeof proposedBy.name !== 'string' || proposedBy.name === '') {
    throw new TypeError(
      `createScenario requires the proposing actor { type, name } with type one of: ${ACTOR_TYPES.join(', ')} and a non-empty name; got ${JSON.stringify(proposedBy ?? null)}.`,
    );
  }
  return proposedBy;
}

// --- operation validation -------------------------------------------------------------------------

// Validates ONE candidate operation: applied ops go through B5's `validateChangeSet` (the applied
// vocabulary is B5's, targeting only the stable namespaces), advisor-only ops through the closed
// annotation shape. Returns `null` when clean, else a structured failure. `validateChangeSet` is
// checked whole so the annotation ops can never sneak through it, and applied ops can never sneak
// through the annotation validator — the two vocabularies are disjoint by construction.
function validateScenarioOperation(operation, index = 0) {
  if (!isPlainObject(operation)) {
    return failure(
      PROMOTION_ERROR_CODES.INVALID_SCENARIO_OPERATION,
      'A scenario operation must be a plain object with an op.',
      { index, value: operation },
    );
  }
  const { op } = operation;
  if (CHANGE_OPERATIONS.includes(op)) {
    const found = validateChangeSet({ operations: [operation] });
    if (found.length === 0) return null;
    const [first] = found;
    return failure(
      PROMOTION_ERROR_CODES.INVALID_SCENARIO_OPERATION,
      `Operation ${index} is not a well-formed change operation: ${first.message}`,
      { ...first.identity, index, op, operation },
    );
  }
  if (ADVISOR_ONLY_OPERATIONS.includes(op)) return validateAnnotation(operation, index);
  return failure(
    PROMOTION_ERROR_CODES.INVALID_SCENARIO_OPERATION,
    `Unknown scenario op '${op}'; expected one of: ${CHANGE_OPERATIONS.join(', ')}, ${ADVISOR_ONLY_OPERATIONS.join(', ')}.`,
    { index, op },
  );
}

function validateAnnotation(annotation, index) {
  const { op } = annotation;
  const accepted = ADVISOR_ONLY_OPERATION_ARGUMENTS[op];
  const badKey = Object.keys(annotation).find((key) => !accepted.includes(key));
  if (badKey) {
    return failure(
      PROMOTION_ERROR_CODES.INVALID_SCENARIO_OPERATION,
      `Annotation '${op}' does not accept key '${badKey}'; accepted: ${accepted.join(', ')}.`,
      { index, op, argument: badKey },
    );
  }
  const { candidateId, againstId, concern, matchedProperty, matchedValue } = annotation;
  if (typeof candidateId !== 'string' || candidateId === '') {
    return failure(PROMOTION_ERROR_CODES.INVALID_SCENARIO_OPERATION, `Annotation '${op}' requires a candidateId.`, {
      index,
      op,
      candidateId,
    });
  }
  if (typeof againstId !== 'string' || againstId === '') {
    return failure(PROMOTION_ERROR_CODES.INVALID_SCENARIO_OPERATION, `Annotation '${op}' requires an againstId.`, {
      index,
      op,
      candidateId,
      againstId,
    });
  }
  if (op === 'POSSIBLE_CONFLICT' && (typeof concern !== 'string' || concern === '')) {
    return failure(
      PROMOTION_ERROR_CODES.INVALID_SCENARIO_OPERATION,
      `A '${op}' annotation requires a non-empty concern — that is the evidence §7 names.`,
      { index, op, candidateId, againstId },
    );
  }
  if (matchedProperty !== undefined && !['title', 'statement'].includes(matchedProperty)) {
    return failure(
      PROMOTION_ERROR_CODES.INVALID_SCENARIO_OPERATION,
      `matchedProperty must be 'title' or 'statement', got ${JSON.stringify(matchedProperty)}.`,
      { index, op, candidateId, againstId, matchedProperty },
    );
  }
  if (matchedProperty !== undefined && (typeof matchedValue !== 'string' || matchedValue === '')) {
    return failure(
      PROMOTION_ERROR_CODES.INVALID_SCENARIO_OPERATION,
      `A '${op}' annotation with a matchedProperty requires a non-empty matchedValue.`,
      { index, op, candidateId, againstId, matchedProperty },
    );
  }
  return null;
}

function isAppliedOperation(operation) {
  return CHANGE_OPERATIONS.includes(operation.op);
}

// --- reading --------------------------------------------------------------------------------------

// The scenario's meta plus its ordered records — applied ops first-class, annotations first-class,
// each in append order. `meta` is the raw node (or null): the caller decides whether a record there
// is a scenario.
async function readScenarioState(tx, projectId, scenarioId) {
  const meta = await tx.getNode({ namespace: SCENARIO_NAMESPACE, scenarioId, id: scenarioMetaId(projectId) });
  const operations = [];
  const annotations = [];
  for (const node of await tx.listNodes({ namespace: SCENARIO_NAMESPACE, scenarioId })) {
    if (node.type === SCENARIO_OPERATION_TYPE) operations.push({ index: node.properties.index, operation: node.properties.operation });
    if (node.type === SCENARIO_ANNOTATION_TYPE) annotations.push({ index: node.properties.index, annotation: node.properties.annotation });
  }
  operations.sort((a, b) => a.index - b.index);
  annotations.sort((a, b) => a.index - b.index);
  return { meta, operations, annotations };
}

// The stable graph (curated + topology), read inside a caller-supplied transaction so the scenario
// state and the base graph share one consistent snapshot. The reads accumulate in a plain loop,
// never `push(...(await tx.listNodes(...)))`: a spread of the whole curated namespace would throw
// `RangeError: Maximum call stack size exceeded` at the E1 fixture scale (25,000 curated nodes /
// 150,000 edges). Same amendment E1 made in validate-graph.mjs and resolve-context.mjs.
async function readStableGraphIn(tx) {
  const nodes = [];
  const edges = [];
  for (const namespace of STABLE_NAMESPACES) {
    for (const node of await tx.listNodes({ namespace })) nodes.push(node);
    for (const edge of await tx.listEdges({ namespace })) edges.push(edge);
  }
  return { nodes, edges };
}

// --- lifecycle: create ----------------------------------------------------------------------------

// Creates a scenario pinned to the current chain head. The proposing actor (`proposedBy`, required)
// is recorded on the meta. An optional complete candidate list is stored in append order. Returns
// `{ ok, scenarioId, baseRevision, createdAt, proposedBy, operations, annotations }`.
export async function createScenario(port, input = {}) {
  const { projectId, scenarioId } = normalizeScenarioInput(port, input, 'createScenario');
  rejectUnknownKeys(input, ['projectId', 'scenarioId', 'operations', 'proposedBy'], 'createScenario');
  const proposedBy = validateProposedBy(input.proposedBy);
  const operations = input.operations ?? [];
  if (!Array.isArray(operations)) {
    throw new TypeError('createScenario: operations must be an array of candidate operations.');
  }
  for (const [index, operation] of operations.entries()) {
    const found = validateScenarioOperation(operation, index);
    if (found) return { ...found, identity: { ...found.identity, scenarioId } };
  }

  try {
    // The base revision is read BEFORE the write transaction: creation pins the head, and the head
    // cannot move between this read and the write on the single-writer port. D5 owns the apply-time
    // stale re-check inside the transaction; D4 records the snapshot the scenario was based on.
    const { headRevision } = await readChain(port, { projectId });
    const createdAt = new Date().toISOString();
    const written = await withTransaction(port, async (tx) => {
      const metaId = scenarioMetaId(projectId);
      const existing = await tx.getNode({ namespace: SCENARIO_NAMESPACE, scenarioId, id: metaId });
      if (existing) {
        throw new DataRejection(
          PROMOTION_ERROR_CODES.SCENARIO_EXISTS,
          `Promotion Scenario '${scenarioId}' already exists; discard it before recreating.`,
          { scenarioId },
        );
      }
      await tx.createNode({
        namespace: SCENARIO_NAMESPACE,
        scenarioId,
        type: SCENARIO_META_TYPE,
        id: metaId,
        properties: { baseRevision: headRevision, createdAt, proposedBy },
      });
      let opSequence = 0;
      let annotationSequence = 0;
      for (const [index, operation] of operations.entries()) {
        if (isAppliedOperation(operation)) {
          opSequence += 1;
          await tx.createNode({
            namespace: SCENARIO_NAMESPACE,
            scenarioId,
            type: SCENARIO_OPERATION_TYPE,
            id: scenarioOperationId(projectId, opSequence),
            properties: { index, operation },
          });
        } else {
          annotationSequence += 1;
          await tx.createNode({
            namespace: SCENARIO_NAMESPACE,
            scenarioId,
            type: SCENARIO_ANNOTATION_TYPE,
            id: scenarioAnnotationId(projectId, annotationSequence),
            properties: { index, annotation: operation },
          });
        }
      }
      return readScenarioState(tx, projectId, scenarioId);
    });
    return {
      ok: true,
      scenarioId,
      baseRevision: written.meta.properties.baseRevision,
      createdAt: written.meta.properties.createdAt,
      proposedBy: written.meta.properties.proposedBy,
      operations: written.operations.map((entry) => entry.operation),
      annotations: written.annotations.map((entry) => entry.annotation),
    };
  } catch (error) {
    return rejectWith(error, { scenarioId });
  }
}

// --- lifecycle: addOperation ----------------------------------------------------------------------

// Appends one candidate operation (applied op or advisor-only annotation) to a draft scenario.
// Returns the updated `{ ok, scenarioId, operations, annotations }`.
export async function addOperation(port, input = {}) {
  const { projectId, scenarioId } = normalizeScenarioInput(port, input, 'addOperation');
  rejectUnknownKeys(input, ['projectId', 'scenarioId', 'operation'], 'addOperation');
  const found = validateScenarioOperation(input.operation, 0);
  if (found) return { ...found, identity: { ...found.identity, scenarioId } };

  try {
    const written = await withTransaction(port, async (tx) => {
      const meta = await tx.getNode({ namespace: SCENARIO_NAMESPACE, scenarioId, id: scenarioMetaId(projectId) });
      if (!meta) {
        throw new DataRejection(
          PROMOTION_ERROR_CODES.SCENARIO_NOT_FOUND,
          `Promotion Scenario '${scenarioId}' does not exist; create it before adding operations.`,
          { scenarioId },
        );
      }
      const existing = await readScenarioState(tx, projectId, scenarioId);
      // `index` is the global append position; records are only ever added (never edited), so the
      // running count is the next index. Per-type sequences keep the record ids dense.
      const nextIndex = existing.operations.length + existing.annotations.length;
      if (isAppliedOperation(input.operation)) {
        await tx.createNode({
          namespace: SCENARIO_NAMESPACE,
          scenarioId,
          type: SCENARIO_OPERATION_TYPE,
          id: scenarioOperationId(projectId, existing.operations.length + 1),
          properties: { index: nextIndex, operation: input.operation },
        });
      } else {
        await tx.createNode({
          namespace: SCENARIO_NAMESPACE,
          scenarioId,
          type: SCENARIO_ANNOTATION_TYPE,
          id: scenarioAnnotationId(projectId, existing.annotations.length + 1),
          properties: { index: nextIndex, annotation: input.operation },
        });
      }
      return readScenarioState(tx, projectId, scenarioId);
    });
    return {
      ok: true,
      scenarioId,
      operations: written.operations.map((entry) => entry.operation),
      annotations: written.annotations.map((entry) => entry.annotation),
    };
  } catch (error) {
    return rejectWith(error, { scenarioId });
  }
}

// --- lifecycle: inspect ---------------------------------------------------------------------------

// Re-derives the whole preview: meta + ordered ops + advisor findings + structural projection
// verdict + staleness + the typed textual diff. Read-only.
export async function inspectScenario(port, input = {}) {
  const { projectId, scenarioId } = normalizeScenarioInput(port, input, 'inspectScenario');
  rejectUnknownKeys(input, ['projectId', 'scenarioId'], 'inspectScenario');

  try {
    const [{ state, baseGraph }, chain] = await Promise.all([
      withTransaction(port, async (tx) => ({
        state: await readScenarioState(tx, projectId, scenarioId),
        baseGraph: await readStableGraphIn(tx),
      })),
      readChain(port, { projectId }),
    ]);

    const meta = state.meta;
    if (!meta || meta.type !== SCENARIO_META_TYPE) {
      return failure(
        PROMOTION_ERROR_CODES.SCENARIO_NOT_FOUND,
        `Promotion Scenario '${scenarioId}' does not exist.`,
        { scenarioId },
      );
    }

    const baseRevision = meta.properties.baseRevision;
    const headRevision = chain.headRevision;
    const stale =
      baseRevision === headRevision
        ? false
        : { code: PROMOTION_ERROR_CODES.PROMOTION_STALE, scenarioId, baseRevision, headRevision };

    const operations = state.operations.map((entry) => entry.operation);
    const projection = projectGraph(baseGraph, operations);
    const checked = checkGraphState(projection.nodes, projection.edges, projectId);
    const findings = sortFindings([
      ...projection.failures.map((item) =>
        violation(
          PROJECTION_OPERATION_FAILURE,
          `Operation ${item.index}: ${item.reason}.`,
          { scenarioId, index: item.index, op: item.op, target: item.target },
        ),
      ),
      ...checked.violations,
    ]);
    const warnings = sortFindings(checked.warnings);
    const structural = { valid: findings.length === 0, violations: findings, warnings };

    const advisor = runAdvisor(projection, operations);

    const diff = renderTypedDiff({
      scenarioId,
      baseRevision,
      headRevision,
      stale,
      operations: state.operations,
      annotations: state.annotations,
      advisor,
      structural,
      baseGraph,
      projection,
    });

    return {
      ok: true,
      scenarioId,
      meta: { baseRevision, createdAt: meta.properties.createdAt },
      operations,
      annotations: state.annotations.map((entry) => entry.annotation),
      advisor,
      structural,
      stale,
      diff,
    };
  } catch (error) {
    return rejectWith(error, { scenarioId });
  }
}

// --- lifecycle: discard ---------------------------------------------------------------------------

// Removes the meta and every record of that scenario; unknown scenario is a no-op (B3), so discard
// is idempotent — the lifecycle's terminal transition.
export async function discardScenario(port, input = {}) {
  const { scenarioId } = normalizeScenarioInput(port, input, 'discardScenario');
  rejectUnknownKeys(input, ['projectId', 'scenarioId'], 'discardScenario');
  try {
    await withTransaction(port, (tx) => tx.dropScenario({ scenarioId }));
    return { ok: true, scenarioId };
  } catch (error) {
    return rejectWith(error, { scenarioId });
  }
}

// --- lifecycle: apply (D5 — the approve path) ----------------------------------------------------

const APPLY_INPUT_KEYS = deepFreeze(['projectId', 'scenarioId', 'approver', 'provenance', 'exportDir', 'retention', 'fs', 'clock']);

// Programmer-error throws only (no port, no/invalid projectId or scenarioId, an unknown input key,
// a mis-typed optional). `approver` and `provenance` are deliberately NOT shape-checked here: they
// are data, judged by B5's `validateRevisionMeta` and refused cleanly on the failure path.
function normalizeApplyInput(port, input) {
  if (!port || typeof port.begin !== 'function') {
    throw new TypeError('applyPromotion requires a port with a begin() method.');
  }
  if (!isPlainObject(input)) {
    throw new TypeError('applyPromotion requires an input object with a projectId and a scenarioId.');
  }
  rejectUnknownKeys(input, APPLY_INPUT_KEYS, 'applyPromotion');
  const { projectId, scenarioId } = input;
  if (!isValidProjectId(projectId)) {
    throw new TypeError(`applyPromotion requires a valid projectId, got ${JSON.stringify(projectId ?? null)}.`);
  }
  if (typeof scenarioId !== 'string' || scenarioId === '') {
    throw new TypeError(`applyPromotion requires a non-empty scenarioId string, got ${JSON.stringify(scenarioId ?? null)}.`);
  }
  if (input.exportDir !== undefined && (typeof input.exportDir !== 'string' || input.exportDir === '')) {
    throw new TypeError('applyPromotion: exportDir must be a non-empty directory path string.');
  }
  if (input.retention !== undefined && !isPlainObject(input.retention)) {
    throw new TypeError('applyPromotion: retention must be a plain object of the form { keepLast, keepDaily }.');
  }
  if (input.fs !== undefined && !isPlainObject(input.fs)) {
    throw new TypeError('applyPromotion: fs must be a plain object of injectable fs functions.');
  }
  if (input.clock !== undefined && typeof input.clock !== 'function') {
    throw new TypeError('applyPromotion: clock must be a function returning an ISO-8601 timestamp string.');
  }
  return {
    projectId,
    scenarioId,
    approver: input.approver,
    provenance: input.provenance,
    exportDir: input.exportDir,
    retention: input.retention,
    fs: input.fs,
    clock: input.clock,
  };
}

function defaultClock() {
  return new Date().toISOString();
}

// One export per promoted state (§22, criterion 14): the name embeds the head revision's sequence
// (`apex:proj:revision:r7` -> `r7`) and a filesystem-safe timestamp, so no two states collide and a
// later retention pass can order them by their own header. ':' and '.' (the timestamp's separators)
// are not portable filename characters, so they become '-'.
export function promotionExportFileName(projectId, headRevision, timestamp) {
  const sequence =
    typeof headRevision === 'string' && headRevision.length > 0 ? headRevision.slice(headRevision.lastIndexOf(':') + 1) : 'r0';
  return `export-${projectId}-${sequence}-${timestamp.replace(/[^\dA-Za-z-]/g, '-')}${EXPORT_FILE_EXTENSION}`;
}

// Retention default for export-on-promotion: keep the last 10 exports plus one per calendar day
// beyond that window (spec §22 "for example last N exports plus one per day"). Deliberately NOT B6's
// bare default (`keepLast 0`), which would prune the export a promotion just wrote — defeating the
// §22 event-driven backup.
export const DEFAULT_EXPORT_RETENTION = deepFreeze({ keepLast: 10, keepDaily: true });

// The export runs AFTER the promotion committed, so a failure here is REPORTED, never rolled back —
// the promotion is durable in the database and the export is a derived, regenerable artifact
// (`graph export` exists later in task F4). Any throw from the export or the retention pass becomes
// `EXPORT_WRITE_FAILED` carrying the underlying error.
async function writePromotionExport(port, { projectId, scenarioId, headRevision, exportDir, retention, fs, clock }) {
  try {
    const timestamp = (clock ?? defaultClock)();
    const filePath = join(exportDir, promotionExportFileName(projectId, headRevision, timestamp));
    const written = await exportGraph(port, { projectId, filePath, fs, clock });
    const pruned = await pruneExportDirectory(exportDir, retention ?? DEFAULT_EXPORT_RETENTION, { fs });
    return { ok: true, filePath, pruned, ...written };
  } catch (error) {
    return {
      ok: false,
      code: PROMOTION_ERROR_CODES.EXPORT_WRITE_FAILED,
      message: `The promotion was committed, but the signed export could not be written or pruned: ${error?.message ?? String(error)}`,
      identity: { scenarioId, headRevision, error: error?.message ?? String(error) },
    };
  }
}

// The approve path (see the header note). Returns `{ ok, scenarioId, applied: { operations,
// revision }, headRevision, scenarioConsumed, export }` on success; `export` is `null` when no
// `exportDir` is configured.
export async function applyPromotion(port, input = {}) {
  const { projectId, scenarioId, approver, provenance, exportDir, retention, fs, clock } = normalizeApplyInput(port, input);

  try {
    // Re-validation reads in one consistent snapshot: the scenario's records, the current stable
    // graph, and the chain head. Never trust the last inspect — this boundary check is the authority.
    const [{ state, baseGraph }, chain] = await Promise.all([
      withTransaction(port, async (tx) => ({
        state: await readScenarioState(tx, projectId, scenarioId),
        baseGraph: await readStableGraphIn(tx),
      })),
      readChain(port, { projectId }),
    ]);

    const meta = state.meta;
    if (!meta || meta.type !== SCENARIO_META_TYPE) {
      return failure(PROMOTION_ERROR_CODES.SCENARIO_NOT_FOUND, `Promotion Scenario '${scenarioId}' does not exist.`, { scenarioId });
    }

    const operations = state.operations.map((entry) => entry.operation);
    if (operations.length === 0) {
      return failure(
        PROMOTION_ERROR_CODES.SCENARIO_EMPTY,
        `Promotion Scenario '${scenarioId}' holds no applied operations; a promotion with nothing to promote is a caller error.`,
        { scenarioId },
      );
    }

    const baseRevision = meta.properties.baseRevision;
    const headRevision = chain.headRevision;
    if (baseRevision !== headRevision) {
      return failure(
        PROMOTION_ERROR_CODES.PROMOTION_STALE,
        `Promotion Scenario '${scenarioId}' is based on revision ${JSON.stringify(baseRevision)} but the graph head is ${JSON.stringify(headRevision)}; rebase and recompute before approving.`,
        { scenarioId, baseRevision, headRevision },
      );
    }

    // Structural re-validation over the scenario-applied projection (binding 2c, D4 rout-forward 2):
    // a scenario whose applied graph B4 cannot certify is NOT promotable — resolve it first.
    const projection = projectGraph(baseGraph, operations);
    const checked = checkGraphState(projection.nodes, projection.edges, projectId);
    const findings = sortFindings([
      ...projection.failures.map((item) =>
        violation(PROJECTION_OPERATION_FAILURE, `Operation ${item.index}: ${item.reason}.`, { scenarioId, index: item.index, op: item.op, target: item.target }),
      ),
      ...checked.violations,
    ]);
    if (findings.length > 0) {
      return failure(
        PROMOTION_ERROR_CODES.SCENARIO_INVALID,
        `Promotion Scenario '${scenarioId}' is not structurally valid against the current graph; resolve the ${findings.length} blocking finding(s) before approving.`,
        { scenarioId, violations: findings },
      );
    }

    // Approver, provenance and the scenario's own proposer are judged by B5's `validateRevisionMeta`
    // — its rules, forwarded verbatim, never re-derived (binding 2d). The proposer was recorded at
    // create as `{ type, name }`; the Revision records it as B5's `{ type, id }`.
    const auditMeta = {
      projectId,
      proposer: { type: meta.properties.proposedBy.type, id: meta.properties.proposedBy.name },
      approver,
      provenance,
      baseRevision,
    };
    const metaViolations = validateRevisionMeta(auditMeta);
    if (metaViolations.length > 0) {
      const [first] = metaViolations;
      return failure(first.code, first.message, { ...first.identity, scenarioId, violations: metaViolations });
    }

    // Apply atomically: the ChangeSet holds the scenario's `ScenarioOperation` records ONLY
    // (annotations are filtered by record type in `readScenarioState` — D4 rout-forward 1), and B5
    // `applyChangeSet` is the sole writer of the promotion transaction. On refusal the port rolls
    // back and the prior revision stays readable.
    const applied = await applyChangeSet(port, { operations }, auditMeta);
    if (!applied.ok) {
      const [first] = applied.violations;
      return failure(first.code, first.message, { ...first.identity, scenarioId, violations: applied.violations });
    }

    // Export-on-promotion (§22, criterion 14) — after a committed apply, REPORTED on failure, never
    // rolled back. An omitted `exportDir` skips the step and reports `export: null`.
    const exportOutcome = exportDir
      ? await writePromotionExport(port, {
          projectId,
          scenarioId,
          headRevision: applied.revision.id,
          exportDir,
          retention,
          fs,
          clock,
        })
      : null;

    // Consume the scenario: the applied change is permanently recorded in the Revision chain, so the
    // disposable proposal is dropped whether or not the derived export succeeded.
    await discardScenario(port, { projectId, scenarioId });

    return {
      ok: true,
      scenarioId,
      applied: { operations, revision: applied.revision },
      headRevision: applied.revision.id,
      scenarioConsumed: true,
      export: exportOutcome,
    };
  } catch (error) {
    return rejectWith(error, { scenarioId });
  }
}

// --- the projected scenario-applied graph (binding 6) ----------------------------------------------

// Base stable graph + the scenario's applied ops (POSSIBLE_* ignored), projected through B5's pure
// `applyChangeOperations` — the same op semantics the chain replays. Returns record arrays plus the
// per-op failures. Exported additively so D5's apply-time re-validation projects through exactly
// this helper — never a second copy of the semantics.
export function projectGraph(base, operations) {
  const nodes = new Map();
  const edges = new Map();
  for (const node of base.nodes) {
    nodes.set(canonicalize([node.namespace, node.id]), {
      namespace: node.namespace,
      type: node.type,
      id: node.id,
      properties: node.properties,
    });
  }
  for (const edge of base.edges) {
    edges.set(canonicalize([edge.namespace, edge.type, edge.fromId, edge.toId]), {
      namespace: edge.namespace,
      type: edge.type,
      fromId: edge.fromId,
      toId: edge.toId,
    });
  }
  const applied = operations.filter(isAppliedOperation);
  const projected = applyChangeOperations(nodes, edges, applied);
  return { nodes: [...projected.nodes.values()], edges: [...projected.edges.values()], failures: projected.failures };
}

// --- the advisor ----------------------------------------------------------------------------------

// Which Rules the scenario itself proposes (ADD of a Rule, SUPERSEDE that creates a Rule, or a
// MODIFY of an existing Rule). A MODIFY carries no type, so its target's type is read from the
// projected graph.
function proposedRuleIdsOf(operations, projection) {
  const byScope = new Map();
  for (const node of projection.nodes) byScope.set(`${node.namespace}\u0000${node.id}`, node);
  const ids = new Set();
  for (const operation of operations) {
    if (operation.target !== 'node') continue;
    if (operation.op === 'MODIFY') {
      if (byScope.get(`${operation.namespace}\u0000${operation.id}`)?.type === RULE_TYPE) ids.add(operation.id);
      continue;
    }
    if (operation.type === RULE_TYPE) ids.add(operation.id);
  }
  return ids;
}

function runAdvisor(projection, operations) {
  const proposedRuleIds = proposedRuleIdsOf(operations, projection);
  return {
    conflicts: findConflicts(projection, proposedRuleIds),
    duplicates: findDuplicates(projection, proposedRuleIds),
  };
}

// POSSIBLE_CONFLICT with hierarchical scope overlap. A Rule covers a scope target AND every
// descendant of it along PART_OF / IMPLEMENTS (a Component is a descendant of the Surface that
// contains it, a Package of the Component it IMPLEMENTS — "both reach the same Package chain"). The
// contest is settled PER LOCATION, exactly like B4 settles per shared target: the Rules covering
// that location are resolved by `resolveOverrideGroup` under B4's `overridesClosure`, and every
// surviving pair is a conflict. Every pair B4 would flag is a pair sharing a target, and a shared
// target is a location both cover — so the advisor is at least as strict as the validator, never
// more lenient, and the hierarchical extension adds the parent/anchor cases B4 deliberately leaves
// to resolution time (D2).
function findConflicts(projection, proposedRuleIds) {
  const { nodes, edges } = projection;
  const applicable = nodes.filter((node) => node.type === RULE_TYPE && APPLICABLE_RULE_STATUSES.includes(node.properties?.status));
  if (applicable.length === 0) return [];

  const byConcern = new Map();
  for (const node of applicable) {
    const concern = node.properties?.concern;
    if (typeof concern !== 'string' || concern === '') continue; // absent/malformed: B1 reported it
    if (!byConcern.has(concern)) byConcern.set(concern, new Set());
    byConcern.get(concern).add(node.id);
  }

  const overridden = overridesClosure(applicable.map((node) => node.id), edges);

  // Per-Rule scope targets: the toIds of its APPLIES_TO edges (raw records; a dangling APPLIES_TO is
  // already a projection finding, and counting it here can only make the advisor stricter).
  const targetsByRule = new Map();
  for (const edge of edges) {
    if (edge.type !== 'APPLIES_TO') continue;
    if (!targetsByRule.has(edge.fromId)) targetsByRule.set(edge.fromId, new Set());
    targetsByRule.get(edge.fromId).add(edge.toId);
  }

  // Descendant closure over PART_OF / IMPLEMENTS — children point up, so children(toId) holds the
  // nodes `toId` contains.
  const children = new Map();
  for (const edge of edges) {
    if (!SCOPE_RELATIONSHIPS.includes(edge.type)) continue;
    if (!children.has(edge.toId)) children.set(edge.toId, []);
    children.get(edge.toId).push(edge.fromId);
  }
  for (const list of children.values()) list.sort(compareStrings);
  const descendantsMemo = new Map();
  const descendantsOf = (id) => {
    if (!descendantsMemo.has(id)) {
      const seen = new Set([id]);
      const queue = [id];
      while (queue.length > 0) {
        for (const child of children.get(queue.shift()) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          queue.push(child);
        }
      }
      descendantsMemo.set(id, seen);
    }
    return descendantsMemo.get(id);
  };

  // location -> Rules covering it. A Rule covers every descendant of every scope target.
  const coveringRules = new Map();
  for (const rule of applicable) {
    const covered = new Set();
    for (const target of targetsByRule.get(rule.id) ?? []) {
      for (const descendant of descendantsOf(target)) covered.add(descendant);
    }
    for (const location of covered) {
      if (!coveringRules.has(location)) coveringRules.set(location, new Set());
      coveringRules.get(location).add(rule.id);
    }
  }

  const conflicts = new Map();
  for (const [concern, group] of byConcern) {
    for (const [location, here] of coveringRules) {
      const present = [...here].filter((id) => group.has(id));
      if (present.length < 2) continue;
      const { survivors } = resolveOverrideGroup(present, overridden);
      for (let i = 0; i < survivors.length; i += 1) {
        for (let j = i + 1; j < survivors.length; j += 1) {
          const [left, right] = [survivors[i], survivors[j]].sort(compareStrings);
          const key = `${left}\u0000${right}`;
          if (!conflicts.has(key)) conflicts.set(key, { concern, ruleIds: [left, right], locations: [] });
          conflicts.get(key).locations.push(location);
        }
      }
    }
  }

  const findings = [];
  for (const record of conflicts.values()) {
    // A pair settled entirely among stable Rules is B4's report, not the advisor's.
    if (!proposedRuleIds.has(record.ruleIds[0]) && !proposedRuleIds.has(record.ruleIds[1])) continue;
    record.locations.sort(compareStrings);
    findings.push({
      kind: 'POSSIBLE_CONFLICT',
      concern: record.concern,
      ruleIds: record.ruleIds,
      locations: record.locations,
      suggestedResolution: 'keep one; keep both under non-overlapping scopes; or add an explicit OVERRIDES (or SUPERSEDES) resolution.',
    });
  }
  findings.sort(
    (a, b) =>
      compareStrings(a.concern, b.concern) ||
      compareStrings(a.ruleIds[0], b.ruleIds[0]) ||
      compareStrings(a.ruleIds[1], b.ruleIds[1]),
  );
  return findings;
}

// POSSIBLE_DUPLICATE: V1 lexical heuristic over Rule title/statement, exact under
// normalized-blank-insensitive comparison. One finding per pair, listing every matched property.
function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function findDuplicates(projection, proposedRuleIds) {
  // A SUPERSEDED Rule is out of operational context (spec §6), and a replacement rule routinely
  // carries the meaning it replaces — comparing the two would flag every intentional replacement as
  // a duplicate. Compare only against Rules that are not retired in the projection.
  const rules = projection.nodes.filter((node) => node.type === RULE_TYPE && node.properties?.status !== 'superseded');
  if (rules.length < 2) return [];

  // normalized property value -> [rule ids]; only Rules with a non-empty title/statement can match.
  const byProperty = new Map();
  for (const property of ['title', 'statement']) byProperty.set(property, new Map());
  for (const rule of rules) {
    for (const [property, index] of byProperty) {
      const normalized = normalizeText(rule.properties?.[property]);
      if (normalized === '') continue;
      if (!index.has(normalized)) index.set(normalized, []);
      index.get(normalized).push(rule.id);
    }
  }

  const matchesByPair = new Map();
  for (const [property, index] of byProperty) {
    for (const [normalized, ids] of index) {
      if (ids.length < 2) continue;
      const sorted = [...ids].sort(compareStrings);
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          const [left, right] = [sorted[i], sorted[j]];
          if (!proposedRuleIds.has(left) && !proposedRuleIds.has(right)) continue;
          const key = `${left}\u0000${right}`;
          if (!matchesByPair.has(key)) {
            matchesByPair.set(key, { left, right, matched: [] });
          }
          matchesByPair.get(key).matched.push({ property, value: normalized });
        }
      }
    }
  }

  const findings = [];
  for (const { left, right, matched } of matchesByPair.values()) {
    const candidateId = proposedRuleIds.has(left) ? left : right;
    const againstId = candidateId === left ? right : left;
    findings.push({
      kind: 'POSSIBLE_DUPLICATE',
      candidateId,
      againstId,
      matched: matched.sort((a, b) => compareStrings(a.property, b.property)),
      suggestedResolution: 'keep one, or supersede the duplicate',
    });
  }
  findings.sort((a, b) => compareStrings(a.candidateId, b.candidateId) || compareStrings(a.againstId, b.againstId));
  return findings;
}

// --- the typed textual diff report (the ratified review UX) ----------------------------------------

// Deterministic plain-text rendering of exactly the ratified list — properties, relationships,
// conflicts, supersessions, suspected duplicates — plus the header (base revision, the revision it
// was rendered against, staleness, structural verdict) and the structural findings/warnings the
// human must see. Stable ordering everywhere: operations in append order, property keys and edge
// lists sorted, findings sorted by code then canonical identity.
function renderTypedDiff(ctx) {
  const { scenarioId, baseRevision, headRevision, stale, operations, annotations, advisor, structural, baseGraph, projection } = ctx;
  const lines = [];
  lines.push(`Promotion Scenario: ${scenarioId}`);
  lines.push(`  base revision: ${baseRevision === null ? 'null' : baseRevision}`);
  lines.push(`  rendered against: ${headRevision === null ? 'null' : headRevision}`);
  lines.push(`  status: ${stale ? 'PROMOTION_STALE' : 'current'}`);
  lines.push(`  structural: ${structural.valid ? 'valid' : `${structural.violations.length} blocking finding(s)`}`);

  const merged = [...operations, ...annotations].sort((a, b) => a.index - b.index);
  lines.push('');
  if (merged.length === 0) lines.push('Operations: (none)');
  else {
    lines.push(`Operations (${merged.length}):`);
    for (const entry of merged) lines.push(`  ${renderOperationLine(entry)}`);
  }

  lines.push('');
  const nodeOps = operations.filter((entry) => ['ADD', 'MODIFY', 'SUPERSEDE'].includes(entry.operation.op) && entry.operation.target === 'node');
  if (nodeOps.length === 0) lines.push('Properties: (none)');
  else {
    lines.push('Properties:');
    for (const { operation } of nodeOps) lines.push(...renderProperties(operation, baseGraph));
  }

  lines.push('');
  const edgeOps = operations.filter((entry) => entry.operation.target === 'edge');
  const removeNodeOps = operations.filter((entry) => entry.operation.op === 'REMOVE' && entry.operation.target === 'node');
  if (edgeOps.length + removeNodeOps.length === 0) lines.push('Relationships: (none)');
  else {
    lines.push('Relationships:');
    for (const { operation } of edgeOps) {
      lines.push(`  ${operation.op} edge ${operation.type} ${operation.fromId} -> ${operation.toId} (${operation.namespace})`);
    }
    for (const { operation } of removeNodeOps) {
      const dangling = projection.edges
        .filter((edge) => edge.fromId === operation.id || edge.toId === operation.id)
        .map((edge) => `${edge.type} ${edge.fromId} -> ${edge.toId}`)
        .sort(compareStrings);
      const listed = dangling.length > 0 ? `: ${dangling.join(', ')}` : '';
      lines.push(
        `  REMOVE node ${operation.id} (${operation.namespace}) — ${dangling.length} live relationship(s) left dangling${listed}`,
      );
    }
  }

  lines.push('');
  const supersessions = operations.filter((entry) => entry.operation.op === 'SUPERSEDE');
  if (supersessions.length === 0) lines.push('Supersessions: (none)');
  else {
    lines.push('Supersessions:');
    for (const { operation } of supersessions) {
      lines.push(`  SUPERSEDE node ${operation.id} replaces ${operation.supersededId} (${operation.namespace} ${operation.type})`);
    }
  }

  lines.push('');
  lines.push('Conflicts (advisor):');
  const conflictLines = [];
  for (const finding of advisor.conflicts) {
    conflictLines.push(`  POSSIBLE_CONFLICT ${finding.ruleIds[0]} <-> ${finding.ruleIds[1]}`);
    conflictLines.push(`    concern: ${finding.concern}`);
    conflictLines.push(`    overlapping scope: ${finding.locations.join(', ')}`);
  }
  for (const { annotation } of annotations.filter((entry) => entry.annotation.op === 'POSSIBLE_CONFLICT')) {
    conflictLines.push(`  recorded POSSIBLE_CONFLICT ${annotation.candidateId} <-> ${annotation.againstId}`);
    if (annotation.concern !== undefined) conflictLines.push(`    concern: ${annotation.concern}`);
  }
  if (conflictLines.length === 0) lines.push('  (none)');
  else lines.push(...conflictLines);

  lines.push('');
  lines.push('Suspected duplicates (advisor):');
  const duplicateLines = [];
  for (const finding of advisor.duplicates) {
    duplicateLines.push(`  POSSIBLE_DUPLICATE ${finding.candidateId} ~ ${finding.againstId}`);
    for (const { property, value } of finding.matched) {
      duplicateLines.push(`    matched ${property}: ${jsonValue(value)}`);
    }
  }
  for (const { annotation } of annotations.filter((entry) => entry.annotation.op === 'POSSIBLE_DUPLICATE')) {
    duplicateLines.push(`  recorded POSSIBLE_DUPLICATE ${annotation.candidateId} ~ ${annotation.againstId}`);
    if (annotation.matchedProperty !== undefined) {
      duplicateLines.push(`    matched ${annotation.matchedProperty}: ${jsonValue(annotation.matchedValue)}`);
    }
  }
  if (duplicateLines.length === 0) lines.push('  (none)');
  else lines.push(...duplicateLines);

  lines.push('');
  if (structural.violations.length === 0) lines.push('Structural findings:', '  none');
  else {
    lines.push(`Structural findings (${structural.violations.length}):`);
    for (const item of structural.violations) lines.push(`  [${item.code}] ${item.message}`);
  }
  lines.push('');
  if (structural.warnings.length === 0) lines.push('Structural warnings:', '  none');
  else {
    lines.push(`Structural warnings (${structural.warnings.length}):`);
    for (const item of structural.warnings) lines.push(`  [${item.code}] ${item.message}`);
  }

  return `${lines.join('\n')}\n`;
}

function renderOperationLine(entry) {
  if (entry.operation) {
    const { operation, index } = entry;
    const prefix = `[${index}] ${operation.op} ${operation.target} ${operation.namespace}`;
    if (operation.target === 'node') {
      const type = operation.type ? ` ${operation.type}` : '';
      const replaces = operation.op === 'SUPERSEDE' ? ` (replaces ${operation.supersededId})` : '';
      return `${prefix}${type} ${operation.id}${replaces}`;
    }
    return `${prefix} ${operation.type} ${operation.fromId} -> ${operation.toId}`;
  }
  const { annotation, index } = entry;
  const separator = annotation.op === 'POSSIBLE_CONFLICT' ? '<->' : '~';
  return `[${index}] ${annotation.op} annotation ${annotation.candidateId} ${separator} ${annotation.againstId}`;
}

function renderProperties(operation, baseGraph) {
  const lines = [];
  if (operation.op === 'MODIFY') {
    lines.push(`  MODIFY node ${operation.id} (${operation.namespace})`);
    const base = baseGraph.nodes.find((node) => node.namespace === operation.namespace && node.id === operation.id);
    lines.push(...propertyDiffLines(base?.properties ?? {}, operation.properties ?? {}));
    return lines;
  }
  lines.push(`  ${operation.op} node ${operation.id} (${operation.namespace} ${operation.type})`);
  for (const key of Object.keys(operation.properties ?? {}).sort(compareStrings)) {
    lines.push(`    ${key}: ${jsonValue(operation.properties[key])}`);
  }
  return lines;
}

function propertyDiffLines(oldProps, newProps) {
  const lines = [];
  const keys = new Set([...Object.keys(oldProps), ...Object.keys(newProps)]);
  for (const key of [...keys].sort(compareStrings)) {
    const inOld = Object.hasOwn(oldProps, key);
    const inNew = Object.hasOwn(newProps, key);
    if (!inOld) lines.push(`    ${key}: ${jsonValue(newProps[key])} (added)`);
    else if (!inNew) lines.push(`    ${key}: (removed)`);
    else if (canonicalize(oldProps[key]) !== canonicalize(newProps[key])) {
      lines.push(`    ${key}: ${jsonValue(oldProps[key])} -> ${jsonValue(newProps[key])}`);
    }
  }
  return lines;
}

// --- deterministic finding ordering ---------------------------------------------------------------

function identityKey(identity) {
  return JSON.stringify(identity, (_key, value) =>
    isPlainObject(value) ? Object.fromEntries(Object.keys(value).sort(compareStrings).map((key) => [key, value[key]])) : value,
  );
}

function sortFindings(items) {
  return [...items].sort(
    (a, b) => compareStrings(a.code, b.code) || compareStrings(identityKey(a.identity), identityKey(b.identity)),
  );
}
