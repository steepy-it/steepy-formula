// Qualified identity and lifecycle rules for the Stable Knowledge Graph (spec
// .apex/work/specs/2026-08-11-stable-knowledge-graph.md §6 "Identity and lifecycle", §24
// "Multi-project deployment"). Pure data + pure validation functions only: no I/O, no
// dependencies, no engine coupling — this module must run identically in every
// adapter/harness (spec §20), matching `ontology.mjs` (Task B1). Later tasks build on it: B3
// (engine port) mints/parses qualified IDs through this module; B4 (validator) walks a whole
// graph and calls `assertSameProject` on every relationship endpoint pair plus
// `validateIdNotReused` against the Revision chain.
//
// Violation shape returned by every validate*/assert* function below, matching `ontology.mjs`:
//   { code: string, message: string, identity: object }
// `code` is a stable machine-checkable reason, `message` is human-readable, `identity` carries
// the offending value so a caller can locate the fault without parsing `message`. No function
// here throws on malformed input — malformed input is reported as a structured violation.

import { isLifecycleState } from './ontology.mjs';

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

// --- Qualified identity (spec §6: `apex:<projectId>:<localId>`, §24: always project-qualified) -

// Local IDs are human-readable `<kind>:<slug>` pairs (spec §6 examples:
// `rule:sanitize-external-input`, `decision:graph-db-is-canonical`, `check:surface-test`).
// Both the project segment and each local-id segment share this lowercase-hyphenated shape.
const IDENTIFIER_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;

export const QUALIFIED_ID_PREFIX = 'apex';

// Builds `apex:<projectId>:<localId>` per spec §6. Pure string formatting — no validation. Use
// `validateQualifiedId` (or validate the parts up front with `isValidProjectId`/
// `isValidLocalId`) to check the result is well-formed before persisting it.
export function buildQualifiedId(projectId, localId) {
  return `${QUALIFIED_ID_PREFIX}:${projectId}:${localId}`;
}

// Splits a qualified ID into its components. Returns `null` (never throws) if `qualifiedId` is
// not a string or does not have the `apex:<projectId>:<kind>:<slug>` shape (exactly 4
// colon-separated segments, first one `apex`). Does not check that `projectId`/`kind`/`slug`
// individually match the identifier segment shape — use `validateQualifiedId` for full
// validation.
export function parseQualifiedId(qualifiedId) {
  if (typeof qualifiedId !== 'string') return null;
  const parts = qualifiedId.split(':');
  if (parts.length !== 4 || parts[0] !== QUALIFIED_ID_PREFIX) return null;
  const [, projectId, kind, slug] = parts;
  return { projectId, kind, slug, localId: `${kind}:${slug}` };
}

export function isValidProjectId(value) {
  return typeof value === 'string' && IDENTIFIER_SEGMENT_PATTERN.test(value);
}

// Validates a standalone local ID (`<kind>:<slug>`, spec §6), independent of any project
// qualification — useful when constructing a new qualified ID from parts already in hand.
export function isValidLocalId(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 2 && parts.every((part) => IDENTIFIER_SEGMENT_PATTERN.test(part));
}

export function isValidQualifiedId(value) {
  return validateQualifiedId(value).length === 0;
}

// Full structural validation of a qualified ID: string type, `apex:<projectId>:<kind>:<slug>`
// shape, and per-segment identifier syntax. Returns a possibly-empty array of structured
// violations; never throws, even on wildly malformed input.
export function validateQualifiedId(qualifiedId) {
  if (typeof qualifiedId !== 'string') {
    return [
      violation(
        'MALFORMED_QUALIFIED_ID',
        `Qualified ID must be a string matching 'apex:<projectId>:<kind>:<slug>', got ${typeof qualifiedId}.`,
        { value: qualifiedId },
      ),
    ];
  }

  const parts = qualifiedId.split(':');
  if (parts.length !== 4 || parts[0] !== QUALIFIED_ID_PREFIX) {
    return [
      violation(
        'MALFORMED_QUALIFIED_ID',
        `Qualified ID '${qualifiedId}' does not match 'apex:<projectId>:<kind>:<slug>'.`,
        { value: qualifiedId },
      ),
    ];
  }

  const [, projectId, kind, slug] = parts;
  const localId = `${kind}:${slug}`;
  const violations = [];

  if (!isValidProjectId(projectId)) {
    violations.push(
      violation(
        'INVALID_PROJECT_ID',
        `Project id '${projectId}' in '${qualifiedId}' is not a valid lowercase-hyphenated identifier.`,
        { value: qualifiedId, projectId },
      ),
    );
  }

  if (!isValidLocalId(localId)) {
    violations.push(
      violation(
        'INVALID_LOCAL_ID',
        `Local id '${localId}' in '${qualifiedId}' does not match '<kind>:<slug>'.`,
        { value: qualifiedId, localId },
      ),
    );
  }

  return violations;
}

// --- Non-reuse (spec §6: an ID is never reused) ---------------------------------------------

// Checks a candidate qualified ID against a history of previously-used qualified IDs (as later
// supplied by the Revision chain — spec §21). `history` may be an array or a Set; any other
// value (including omitted) is treated as empty history rather than thrown on. Replacing the
// meaning of a node never reuses its ID — it creates a new node connected with `SUPERSEDES`
// (spec §6), so a hit here is always a structured violation, never a silent overwrite.
export function validateIdNotReused(qualifiedId, history) {
  const seen = history instanceof Set ? history : Array.isArray(history) ? new Set(history) : new Set();
  if (seen.has(qualifiedId)) {
    return [
      violation(
        'ID_ALREADY_USED',
        `Qualified ID '${qualifiedId}' already exists in history and cannot be reused.`,
        { value: qualifiedId },
      ),
    ];
  }
  return [];
}

// --- Lifecycle transitions (spec §6) ----------------------------------------------------------

// The only legal edges: active->deprecated, active->superseded, deprecated->superseded.
// Deprecated->active re-activation is deliberately absent — not in spec; a wrongly deprecated
// rule is fixed by a new supersession or an audited correction, out of this module's scope.
// No transition out of `superseded`. Same-state transitions are illegal (not a transition).
export const LIFECYCLE_TRANSITIONS = deepFreeze([
  { from: 'active', to: 'deprecated' },
  { from: 'active', to: 'superseded' },
  { from: 'deprecated', to: 'superseded' },
]);

export function isLegalLifecycleTransition(from, to) {
  return LIFECYCLE_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

// Validates one candidate lifecycle transition. Unknown states are reported per side
// (`UNKNOWN_LIFECYCLE_STATE`); a same-state or otherwise illegal transition between two known
// states is `ILLEGAL_LIFECYCLE_TRANSITION`. Never throws.
export function validateLifecycleTransition(from, to) {
  const violations = [];

  if (!isLifecycleState(from)) {
    violations.push(
      violation('UNKNOWN_LIFECYCLE_STATE', `Unknown lifecycle state '${from}' as transition source.`, { state: from }),
    );
  }
  if (!isLifecycleState(to)) {
    violations.push(
      violation('UNKNOWN_LIFECYCLE_STATE', `Unknown lifecycle state '${to}' as transition target.`, { state: to }),
    );
  }
  if (violations.length > 0) return violations;

  if (!isLegalLifecycleTransition(from, to)) {
    return [
      violation(
        'ILLEGAL_LIFECYCLE_TRANSITION',
        `Lifecycle transition '${from}' -> '${to}' is illegal.`,
        { from, to },
      ),
    ];
  }

  return violations;
}

// --- Cross-project rejection (spec §24: IDs are always project-qualified; cross-project ------
// stable relationships are rejected by the portable validator) --------------------------------

// Structured predicate consumable by B4's whole-graph validator: given the qualified IDs of a
// relationship's two endpoints, reports a violation unless both belong to the same project.
// Malformed endpoints are reported (one violation per malformed side) instead of thrown; a
// project mismatch is only checked once both endpoints parse.
export function assertSameProject(fromId, toId) {
  const violations = [];
  const from = parseQualifiedId(fromId);
  const to = parseQualifiedId(toId);

  if (!from) {
    violations.push(
      violation(
        'MALFORMED_QUALIFIED_ID',
        `Qualified ID '${fromId}' does not match 'apex:<projectId>:<kind>:<slug>'.`,
        { value: fromId },
      ),
    );
  }
  if (!to) {
    violations.push(
      violation(
        'MALFORMED_QUALIFIED_ID',
        `Qualified ID '${toId}' does not match 'apex:<projectId>:<kind>:<slug>'.`,
        { value: toId },
      ),
    );
  }
  if (violations.length > 0) return violations;

  if (from.projectId !== to.projectId) {
    return [
      violation(
        'CROSS_PROJECT_RELATIONSHIP',
        `Relationship endpoints belong to different projects ('${from.projectId}' vs '${to.projectId}').`,
        { fromId, toId, fromProjectId: from.projectId, toProjectId: to.projectId },
      ),
    ];
  }

  return [];
}
