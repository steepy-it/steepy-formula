// Pure correction state for Gear-3 evidence-driven correction.
//
// A correction run is a sequence of plain records `{ kind, ...payload }`. This module folds them into
// a deep-frozen state and refuses any record that would break the run's invariants: one bounded
// allowance of iterations per cycle, a single diagnosis slot charged to that allowance, retries
// admitted only with bound evidence, and dispatch roles authorized once per iteration.
//
// Each cycle opens with the verification its scope derives (`deriveCycleBindings`): the command checks,
// the review and the rubric every criterion is bound to, none of which can be dropped or weakened. An
// iteration concludes with an outcome (writer, checks, review) whose defects carry stable ids
// (`normalizeDefects`); a failed correction is compared with the previous comparable outcome on metric
// deltas alone (`compareOutcomes`), so stagnation, an unavailable comparison and exhaustion stop the
// cycle, and approval needs every check, the review, the rubric and one observed tree. Candidates are
// ranked by the evidence attributed to each (`rankCandidates`).
//
// The module is pure: no filesystem, no subprocess, no other scripts/ import. Data problems come back
// as `{ ok: false, code, message, identity }`; `TypeError` is thrown only for programmer error (a
// state this module did not produce, a non-plain record, an unknown option key). Records carry no
// timestamps, and no record key, code or option names a clock-, usage- or spend-based condition.

export const ITERATION_ALLOWANCE = 3;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function vocabulary(names) {
  return Object.fromEntries(names.map((name) => [name, name]));
}

export const CORRECTION_CODES = deepFreeze({
  // Why a cycle stopped. `APPROVED` is the one successful stop.
  stop: vocabulary([
    'APPROVED',
    'EXHAUSTED',
    'STAGNATED',
    'COMPARISON_UNAVAILABLE',
    'DIAGNOSIS_INCONCLUSIVE',
    'RETRY_EVIDENCE_MISSING',
    'HUMAN_INTERRUPTED',
  ]),
  // A refusal after which the guard must halt the whole run.
  halt: vocabulary(['INTEGRITY']),
  // Why a single record or retry request was refused.
  refusal: vocabulary([
    'RECORD_SCHEMA',
    'RECORD_ORDER',
    'RUN_NOT_OPEN',
    'RUN_HALTED',
    'CYCLE_NOT_OPEN',
    'CYCLE_TERMINAL',
    'SCOPE_NOT_RUNNABLE',
    'ALLOWANCE_EXHAUSTED',
    'DIAGNOSIS_USED',
    'DIAGNOSIS_REASON',
    'DIAGNOSIS_REQUIRED',
    'RETRY_REQUIRED',
    'RETRY_INVALID',
    'RETRY_REPEATED',
    'RETRY_STATUS_ONLY',
    'RETRY_EVIDENCE_UNBOUND',
    'ROLE_NOT_ALLOWED',
    'ROLE_ALREADY_DISPATCHED',
    'OUTCOME_ORDER',
    'REOPEN_INVALID',
    'FINAL_BYPASS',
    'ISOLATION_REQUIRED',
  ]),
  // Why a reviewer's report is not a valid review; the guard records such a review as INVALID.
  review: vocabulary([
    'DEFECT_SCHEMA',
    'DEFECT_UNBOUND',
    'DEFECT_SUPERSEDES',
    'DEFECT_DUPLICATE',
    'RUBRIC_SCHEMA',
    'RUBRIC_COVERAGE',
    'RUBRIC_UNSUPPORTED',
    'STATUS_INCONSISTENT',
  ]),
});

export const CORRECTION_RECORD_KINDS = deepFreeze(vocabulary([
  'RUN_OPENED',
  'CYCLE_OPENED',
  'ITERATION_RESERVED',
  'DISPATCH_AUTHORIZED',
  'ITERATION_INTERRUPTED',
  'RETRY_ADMITTED',
  'DIAGNOSIS_RECORDED',
  'CYCLE_STOPPED',
  'RUN_HALTED',
  'WRITER_RECORDED',
  'CHECKS_RECORDED',
  'REVIEW_RECORDED',
]));

const REFUSAL = CORRECTION_CODES.refusal;
const APPLY_OPTION_KEYS = Object.freeze(['ref']);
const REPLAY_OPTION_KEYS = Object.freeze(['refs']);
const DRIVES = new Set(['manual', 'autopilot']);
const COMPLEXITIES = new Set(['mechanical', 'integration', 'design']);
const PLAN_TASK_FIELDS = Object.freeze(['task', 'dependencies', 'complexity', 'criterionIds', 'testCommand']);
const REF_FIELDS = Object.freeze(['path', 'digest']);
const CHECK_FIELDS = Object.freeze(['id', 'command']);
const REVIEW_MODES = new Set(['required', 'skipped']);
const ITERATION_KINDS = new Set(['initial', 'correction', 'diagnosis']);
const DIAGNOSIS_REASONS = new Set(['missing-retry-evidence', 'comparison-unavailable']);
const STOP = CORRECTION_CODES.stop;
const HALT = CORRECTION_CODES.halt;
const ROLES = new Set(['writer', 'task-reviewer', 'final-reviewer', 'diagnostic']);
const REVIEWER_ROLES = new Set(['task-reviewer', 'final-reviewer']);
const RETRY_FIELDS = Object.freeze([
  'version', 'scope', 'cycle', 'iteration', 'kind', 'target', 'observedFailure', 'evidence', 'hypothesis', 'remedy',
  'difference', 'confirmingCheck',
]);
const RETRY_KINDS = new Set(['defect', 'tool-failure']);
const RETRY_TEXT_FIELDS = Object.freeze(['observedFailure', 'hypothesis', 'remedy', 'difference']);
// A retry text field that says only this (after trimming and trailing punctuation) carries no evidence.
const STATUS_WORDS = new Set([
  'done', 'done_with_concerns', 'blocked', 'needs_context', 'approved', 'issues_found', 'retry', 'again',
]);
const REVIEW_CONFIRMATIONS = Object.freeze(['review', 'rubric']);
// Evidence a tool-failure retry may bind to: an interrupted dispatch's own record, and the evidence of a
// writer that did not succeed or of an incomplete or invalid review.
const TOOL_FAILURE_SOURCES = new Set(['interruption', 'writer-failure', 'review-failure']);
const WRITER_STATUSES = new Set(['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT', 'INVALID']);
const ACCEPTED_WRITER_STATUSES = new Set(['DONE', 'DONE_WITH_CONCERNS']);
const CHECK_RESULT_FIELDS = Object.freeze(['id', 'exitCode', 'passed', 'metric', 'evidence']);
const REVIEW_STATUSES = new Set(['APPROVED', 'ISSUES_FOUND', 'BLOCKED', 'NEEDS_CONTEXT', 'INVALID']);
const VERDICT_STATUSES = new Set(['APPROVED', 'ISSUES_FOUND']);
// A final-scope correction of such a task needs an approved task review before the final review.
const TASK_REVIEWED_COMPLEXITIES = new Set(['integration', 'design']);
const EXPLICIT_STOPS = new Set([STOP.RETRY_EVIDENCE_MISSING, STOP.HUMAN_INTERRUPTED]);
// The roles each iteration kind may authorize, by scope kind, in dispatch order: a writer always
// precedes the reviewers, and each role is authorized at most once per iteration.
const PERMITTED_ROLES = deepFreeze({
  task: {
    initial: ['writer', 'task-reviewer'],
    correction: ['writer', 'task-reviewer'],
    diagnosis: ['diagnostic'],
  },
  final: {
    initial: ['final-reviewer'],
    correction: ['writer', 'task-reviewer', 'final-reviewer'],
    diagnosis: ['diagnostic'],
  },
});
const DERIVE_KEYS = Object.freeze(['scope', 'task', 'deliveredTasks', 'rubricCriteria', 'reviewOptIn']);
const NORMALIZE_KEYS = Object.freeze(['bindings', 'entries', 'previous']);
const RUBRIC_KEYS = Object.freeze(['bindings', 'rubric', 'defects']);
const REVIEW_RUBRIC_KEYS = Object.freeze(['scope', 'bindings', 'role', 'ownerTask']);
const REVIEW_INVALID = CORRECTION_CODES.review;
const DEFECT_FIELDS = Object.freeze([
  'criterion', 'check', 'dimension', 'cause', 'severity', 'expected', 'observed', 'proof', 'correction', 'nextCheck',
  'supersedes', 'justification',
]);
const FEEDBACK_FIELDS = Object.freeze(['expected', 'observed', 'proof', 'correction', 'nextCheck']);
const RUBRIC_DIMENSIONS = Object.freeze(['coverage', 'correctness', 'clarity', 'usability']);
const RUBRIC_ENTRY_FIELDS = Object.freeze(['criterion', ...RUBRIC_DIMENSIONS, 'constraints']);
const SCORE_FIELDS = Object.freeze(['score', 'evidence']);
const CONSTRAINT_FIELDS = Object.freeze(['id', 'satisfied', 'evidence']);
const FULL_SCORE = 2;
// The severity ordinal is a review defect's metric: lower is better.
const SEVERITY_ORDINAL = Object.freeze({ critical: 3, important: 2, minor: 1 });
const BLOCKING_SEVERITIES = new Set(['critical', 'important']);
const CAUSE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CAUSE_MAX_LENGTH = 64;
const COHERENCE_GATE = Object.freeze({ id: 'coherence-gate', command: 'builtin' });
// Four rubric dimensions scored 0-2 each: a rubric criterion passes only at the full 8.
const RUBRIC_THRESHOLD = 8;
// The command check ids a derivation produces; every command binding's direction is `lower`.
const COMMAND_CHECK = /^(?:surface-test(?:-[1-9]\d*)?|coherence-gate)$/u;
const SCOPE = /^(?:task-([1-9]\d*)|final)$/u;
const CYCLE_REFERENCE = /^(?:task-[1-9]\d*|final)#[1-9]\d*$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const TASK_ID = /^[1-9]\d*$/u;
const CRITERION_ID = /^SC[1-9]\d*$/u;

// --- refusals -------------------------------------------------------------------------------------

// Thrown inside a record handler and caught at the public boundary, where it becomes the failure
// envelope; it never escapes this module.
class Refusal {
  constructor(code, message, identity) {
    this.code = code;
    this.message = message;
    this.identity = identity;
  }
}

function refuse(code, message, identity = {}) {
  throw new Refusal(code, message, identity);
}

function failure({ code, message, identity }) {
  return { ok: false, code, message, identity };
}

// --- value predicates -----------------------------------------------------------------------------

function isHex64(value) {
  return typeof value === 'string' && HEX64.test(value);
}

function isLine(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\u0000\r\n]/u.test(value);
}

function isTaskId(value) {
  return typeof value === 'string' && TASK_ID.test(value) && Number.isSafeInteger(Number(value));
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isDigestReference(value) {
  return isPlainObject(value) && hasExactKeys(value, REF_FIELDS) && isLine(value.path) && isHex64(value.digest);
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function isUniqueArray(values, predicate) {
  return Array.isArray(values) && values.every(predicate) && new Set(values).size === values.length;
}

// Structural equality of JSON-plain values: array order matters, object key order does not.
function sameValue(left, right) {
  if (left === right) return true;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const keys = Object.keys(left);
  return hasExactKeys(right, keys) && keys.every((key) => sameValue(left[key], right[key]));
}

// JSON-plain: a string, finite number, boolean, null, or a plain array or object of the same, built
// only from enumerable own data properties with string keys and no cycles. Only such values are stored,
// so nothing escapes the failure envelope, the structured clone or the deep freeze.
function isJsonPlain(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : !isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value).filter((key) => !(array && key === 'length'));
  if (array && keys.length !== value.length) return false;
  ancestors.add(value);
  const plain = keys.every((key, index) => {
    if (typeof key !== 'string' || (array && key !== String(index))) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor.enumerable && Object.hasOwn(descriptor, 'value') && isJsonPlain(descriptor.value, ancestors);
  });
  ancestors.delete(value);
  return plain;
}

// --- programmer-error guards ----------------------------------------------------------------------

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOptions(options, accepted, label) {
  if (options === undefined) return {};
  if (!isPlainObject(options)) throw new TypeError(`${label}: options must be a plain object`);
  for (const key of Object.keys(options)) {
    if (!accepted.includes(key)) {
      throw new TypeError(`${label}: unknown option '${key}'; accepted keys: ${accepted.join(', ')}`);
    }
  }
  return options;
}

// Every state this module returns is registered here, so a hand-built or cloned state is a
// programmer error rather than a silently trusted input.
const PRODUCED = new WeakSet();
const PRODUCED_CYCLES = new WeakSet();

function produce(state) {
  deepFreeze(state);
  PRODUCED.add(state);
  for (const cycle of Object.values(state.cycles)) PRODUCED_CYCLES.add(cycle);
  return state;
}

function assertState(state, label) {
  if (!PRODUCED.has(state)) {
    throw new TypeError(`${label}: state must be produced by createCorrectionState or applyCorrectionRecord`);
  }
}

// --- verification bindings ------------------------------------------------------------------------

function isPlanTask(task) {
  return isPlainObject(task) && hasExactKeys(task, PLAN_TASK_FIELDS) && isTaskId(task.task)
    && Array.isArray(task.dependencies) && task.dependencies.every(isTaskId) && COMPLEXITIES.has(task.complexity)
    && isUniqueArray(task.criterionIds, (id) => typeof id === 'string' && CRITERION_ID.test(id))
    && isLine(task.testCommand);
}

function binding(criterion, check, kind, metric, direction, threshold) {
  return { criterion, check, kind, metric, direction, threshold };
}

// The problem with a binding derivation input, or null. The exported derivation throws it as a
// TypeError (a malformed call); the CYCLE_OPENED handler refuses it as a malformed record.
function bindingInputProblem({ scope, task, deliveredTasks, rubricCriteria, reviewOptIn }) {
  if (typeof scope !== 'string' || !SCOPE.test(scope)) return "scope must be 'task-<N>' or 'final'";
  if (typeof reviewOptIn !== 'boolean') return 'reviewOptIn must be a boolean';
  let criteria;
  if (scope === 'final') {
    if (task !== null) return 'the final scope takes deliveredTasks, not a task';
    if (!Array.isArray(deliveredTasks) || !deliveredTasks.every(isPlanTask)) {
      return 'deliveredTasks must be an array of plan tasks';
    }
    if (new Set(deliveredTasks.map((entry) => entry.task)).size !== deliveredTasks.length) {
      return 'deliveredTasks must name each task once';
    }
    criteria = deliveredTasks.flatMap((entry) => entry.criterionIds);
  } else {
    if (deliveredTasks !== null) return 'a task scope takes a task, not deliveredTasks';
    if (!isPlanTask(task) || task.task !== taskOfScope(scope)) return `task must be the plan task of scope '${scope}'`;
    criteria = task.criterionIds;
  }
  if (!isUniqueArray(rubricCriteria, (id) => typeof id === 'string')) {
    return 'rubricCriteria must be an array of unique criterion IDs';
  }
  const outside = rubricCriteria.filter((id) => !criteria.includes(id));
  if (outside.length > 0) return `rubricCriteria ${outside.join(', ')} are not criteria of scope '${scope}'`;
  if (rubricCriteria.length > 0 && reviewMode(scope, task, reviewOptIn) === 'skipped') {
    return 'a rubric is scored by a review, so rubricCriteria require a review';
  }
  return null;
}

function reviewMode(scope, task, reviewOptIn) {
  return scope === 'final' || task.complexity !== 'mechanical' || reviewOptIn ? 'required' : 'skipped';
}

// Every criterion binds to every command check (pass at zero failures), then to the review when one is
// required, then to the rubric when it is a rubric criterion.
function bindCriteria(criteria, surfaceTests, review, rubricCriteria) {
  return criteria.flatMap((criterion) => [
    ...surfaceTests.map((check) => binding(criterion, check.id, 'command', 'failed-assertions', 'lower', 0)),
    binding(criterion, COHERENCE_GATE.id, 'command', 'violations', 'lower', 0),
    ...(review === 'required' ? [binding(criterion, 'review', 'review', 'severity', 'lower', 0)] : []),
    ...(rubricCriteria.includes(criterion)
      ? [binding(criterion, 'rubric', 'rubric', 'rubric-score', 'higher', RUBRIC_THRESHOLD)] : []),
  ]);
}

// Assumes an input bindingInputProblem accepted.
function deriveBindings({ scope, task, deliveredTasks, rubricCriteria, reviewOptIn }) {
  if (scope === 'final') {
    const delivered = [...deliveredTasks].sort((left, right) => Number(left.task) - Number(right.task));
    const commands = [...new Set(delivered.map((entry) => entry.testCommand))].sort();
    const surfaceTests = commands.map((command, index) => ({ id: `surface-test-${index + 1}`, command }));
    const criteria = [...new Set(delivered.flatMap((entry) => entry.criterionIds))];
    return {
      checks: [...surfaceTests, { ...COHERENCE_GATE }],
      bindings: bindCriteria(criteria, surfaceTests, 'required', rubricCriteria),
      review: 'required',
    };
  }
  const review = reviewMode(scope, task, reviewOptIn);
  const surfaceTests = [{ id: 'surface-test', command: task.testCommand }];
  return {
    checks: [...surfaceTests, { ...COHERENCE_GATE }],
    bindings: bindCriteria(task.criterionIds, surfaceTests, review, rubricCriteria),
    review,
  };
}

// --- defect identity ------------------------------------------------------------------------------

function defectId(criterion, check, dimension, cause) {
  return `${criterion}/${check}${dimension === null ? '' : `:${dimension}`}/${cause}`;
}

function isBound(bindings, criterion, check) {
  return bindings.some((entry) => entry.criterion === criterion && entry.check === check);
}

function defectEntryProblem(entry) {
  if (!isPlainObject(entry) || !hasExactKeys(entry, DEFECT_FIELDS)) {
    return `must have exactly the keys: ${DEFECT_FIELDS.join(', ')}`;
  }
  const { criterion, check, dimension, cause, severity, supersedes, justification } = entry;
  if (typeof criterion !== 'string') return 'criterion must be a string';
  if (check !== 'review' && check !== 'rubric') return "check must be 'review' or 'rubric'";
  if (check === 'review' ? dimension !== null : !RUBRIC_DIMENSIONS.includes(dimension)) {
    return `dimension must be null for review and one of ${RUBRIC_DIMENSIONS.join(', ')} for rubric`;
  }
  if (typeof cause !== 'string' || cause.length > CAUSE_MAX_LENGTH || !CAUSE.test(cause)) {
    return `cause must be lowercase hyphenated words of at most ${CAUSE_MAX_LENGTH} characters`;
  }
  if (typeof severity !== 'string' || !Object.hasOwn(SEVERITY_ORDINAL, severity)) {
    return `severity must be one of: ${Object.keys(SEVERITY_ORDINAL).join(', ')}`;
  }
  const empty = FEEDBACK_FIELDS.find((field) => !isText(entry[field]));
  if (empty !== undefined) return `${empty} must be a non-empty string`;
  if (supersedes !== null && typeof supersedes !== 'string') return 'supersedes must be null or a defect id';
  if (supersedes === null ? justification !== null : !isText(justification)) {
    return 'justification must be a non-empty string exactly when supersedes names a defect';
  }
  return null;
}

// Normalizes a reviewer's defect entries against the cycle bindings and the defects of the previous
// comparable outcome, refusing with a `review` code. An entry that shares criterion, check and
// dimension with an unclaimed previous defect but names a new cause, without superseding it, keeps the
// previous id: renaming a defect is not progress.
function normalizeEntries(bindings, entries, previous) {
  if (!Array.isArray(entries)) refuse(REVIEW_INVALID.DEFECT_SCHEMA, 'defects must be an array');
  for (const [index, entry] of entries.entries()) {
    const problem = defectEntryProblem(entry);
    if (problem !== null) refuse(REVIEW_INVALID.DEFECT_SCHEMA, `defect ${index} ${problem}`, { entry: index });
  }
  const previousIds = new Set(previous.map((defect) => defect.id));
  for (const [index, { criterion, check, supersedes }] of entries.entries()) {
    if (!isBound(bindings, criterion, check)) {
      refuse(REVIEW_INVALID.DEFECT_UNBOUND, `defect ${index}: ${criterion} is not bound to the ${check} check`,
        { entry: index });
    }
    if (supersedes !== null && !previousIds.has(supersedes)) {
      refuse(REVIEW_INVALID.DEFECT_SUPERSEDES, `defect ${index} supersedes ${supersedes}, which the previous `
        + 'outcome does not report', { entry: index });
    }
  }
  const reported = entries.map(({ criterion, check, dimension, cause }) =>
    defectId(criterion, check, dimension, cause));
  const claimed = new Set(reported);
  const defects = entries.map((entry, index) => {
    let id = reported[index];
    if (!previousIds.has(id) && entry.supersedes === null) {
      const renamed = previous.find((defect) => !claimed.has(defect.id) && defect.criterion === entry.criterion
        && defect.check === entry.check && defect.dimension === entry.dimension);
      if (renamed !== undefined) {
        id = renamed.id;
        claimed.add(id);
      }
    }
    const fields = Object.fromEntries(DEFECT_FIELDS.map((field) => [field, entry[field]]));
    return {
      id,
      ...fields,
      blocking: BLOCKING_SEVERITIES.has(entry.severity),
      // A rubric defect's metric is its dimension score, attached from the rubric that carries it.
      metric: entry.check === 'review' ? SEVERITY_ORDINAL[entry.severity] : null,
    };
  });
  const seen = new Set();
  for (const [index, { id }] of defects.entries()) {
    if (seen.has(id)) refuse(REVIEW_INVALID.DEFECT_DUPLICATE, `defect ${index} repeats ${id}`, { entry: index });
    seen.add(id);
  }
  return defects;
}

// --- rubric ---------------------------------------------------------------------------------------

// The rubric bindings a review scores: all of the cycle's, or, for a final-scope task review, only
// those of its owner task's criteria (`owner` is that plan task, else null).
function rubricBindingsFor(bindings, owner) {
  return bindings.filter((bound) => bound.check === 'rubric'
    && (owner === null || owner.criterionIds.includes(bound.criterion))).map((bound) => ({ ...bound }));
}

function rubricEntryProblem(entry) {
  if (!isPlainObject(entry) || !hasExactKeys(entry, RUBRIC_ENTRY_FIELDS)) {
    return `must have exactly the keys: ${RUBRIC_ENTRY_FIELDS.join(', ')}`;
  }
  if (typeof entry.criterion !== 'string') return 'criterion must be a string';
  for (const dimension of RUBRIC_DIMENSIONS) {
    const value = entry[dimension];
    if (!isPlainObject(value) || !hasExactKeys(value, SCORE_FIELDS) || ![0, 1, FULL_SCORE].includes(value.score)
      || !isText(value.evidence)) {
      return `${dimension} must be { score: 0 | 1 | 2, evidence } with non-empty evidence`;
    }
  }
  const { constraints } = entry;
  if (!Array.isArray(constraints) || !constraints.every((constraint) => isPlainObject(constraint)
    && hasExactKeys(constraint, CONSTRAINT_FIELDS) && isLine(constraint.id) && typeof constraint.satisfied === 'boolean'
    && isText(constraint.evidence))) {
    return 'constraints must be an array of { id, satisfied (boolean), evidence } with non-empty evidence';
  }
  if (new Set(constraints.map((constraint) => constraint.id)).size !== constraints.length) {
    return 'constraints must name each id once';
  }
  return null;
}

// Validates a reviewer's rubric against the rubric bindings, refusing with a `review` code: one
// entry per rubric criterion, every score below 2 backed by a rubric defect on the same criterion and
// dimension that carries a correction, and every unsatisfied constraint backed by a blocking (critical
// or important) review defect on the same criterion that carries a correction. A criterion is approved
// only at 8/8 with every constraint satisfied, so a review reporting an unsatisfied constraint is
// ISSUES_FOUND: no failure lacks a defect, and a repeated violation stays comparable.
function checkRubric(bindings, rubric, defects) {
  if (!Array.isArray(rubric)) refuse(REVIEW_INVALID.RUBRIC_SCHEMA, 'rubric must be an array');
  for (const [index, entry] of rubric.entries()) {
    const problem = rubricEntryProblem(entry);
    if (problem !== null) refuse(REVIEW_INVALID.RUBRIC_SCHEMA, `rubric entry ${index} ${problem}`, { entry: index });
  }
  const criteria = [...new Set(bindings.filter((entry) => entry.check === 'rubric').map((entry) => entry.criterion))];
  for (const [index, { criterion }] of rubric.entries()) {
    if (!criteria.includes(criterion)) {
      refuse(REVIEW_INVALID.RUBRIC_COVERAGE, `rubric entry ${index}: ${criterion} is not a rubric criterion`,
        { entry: index });
    }
  }
  return criteria.map((criterion) => {
    const entries = rubric.filter((entry) => entry.criterion === criterion);
    if (entries.length !== 1) {
      refuse(REVIEW_INVALID.RUBRIC_COVERAGE, `${criterion} needs exactly one rubric entry, found ${entries.length}`,
        { criterion });
    }
    const [entry] = entries;
    for (const dimension of RUBRIC_DIMENSIONS) {
      const { score } = entry[dimension];
      const supported = score === FULL_SCORE || defects.some((defect) => defect.check === 'rubric'
        && defect.criterion === criterion && defect.dimension === dimension && isText(defect.correction));
      if (!supported) {
        refuse(REVIEW_INVALID.RUBRIC_UNSUPPORTED, `${criterion} ${dimension} scored ${score} without a rubric defect `
          + 'carrying a correction', { criterion, dimension });
      }
    }
    for (const constraint of entry.constraints.filter((item) => !item.satisfied)) {
      const backed = defects.some((defect) => defect.check === 'review' && defect.criterion === criterion
        && BLOCKING_SEVERITIES.has(defect.severity) && isText(defect.correction));
      if (!backed) {
        refuse(REVIEW_INVALID.RUBRIC_UNSUPPORTED, `${criterion} constraint ${constraint.id} is unsatisfied without a `
          + 'blocking review defect carrying a correction', { criterion, constraint: constraint.id });
      }
    }
    const score = RUBRIC_DIMENSIONS.reduce((total, dimension) => total + entry[dimension].score, 0);
    const constraintsSatisfied = entry.constraints.every((constraint) => constraint.satisfied);
    return { criterion, score, constraintsSatisfied, approved: score === RUBRIC_THRESHOLD && constraintsSatisfied };
  });
}

// --- outcome comparison ---------------------------------------------------------------------------

// The binding direction of a defect's (criterion, check); a command-check defect that binds no
// criterion (`*/<check>/command-failed`) compares like every command binding: lower is better.
function directionOf(bindings, defect) {
  const bound = bindings.find((entry) => entry.criterion === defect.criterion && entry.check === defect.check);
  if (bound !== undefined) return bound.direction;
  return COMMAND_CHECK.test(defect.check) ? 'lower' : null;
}

// One metric per id: the worst of a repeated current id and the best of a repeated previous id, so a
// duplicate can never manufacture improvement. Null when any occurrence has no metric.
function mergedMetric(defects, direction, pick) {
  const metrics = defects.map((defect) => defect.metric);
  if (metrics.some((metric) => !Number.isFinite(metric))) return null;
  const lowerIsBetter = direction === 'lower';
  const best = lowerIsBetter ? Math.min(...metrics) : Math.max(...metrics);
  const worst = lowerIsBetter ? Math.max(...metrics) : Math.min(...metrics);
  return pick === 'best' ? best : worst;
}

// A side's reported metric: merged in the binding direction, else the raw metric of a lone occurrence.
function shownMetric(defects, direction, pick) {
  if (direction !== null) return mergedMetric(defects, direction, pick);
  return defects.length === 1 && Number.isFinite(defects[0].metric) ? defects[0].metric : null;
}

function compare(previous, current, bindings) {
  if (previous === null) return { verdict: 'none', defects: [] };
  const ids = [...new Set(current.defects.map((defect) => defect.id))];
  const defects = ids.map((id) => {
    const now = current.defects.filter((defect) => defect.id === id);
    const before = previous.defects.filter((defect) => defect.id === id);
    const direction = directionOf(bindings, now[0]);
    const metric = shownMetric(now, direction, 'worst');
    if (before.length === 0) return { id, previous: null, current: metric, result: 'new' };
    const earlier = shownMetric(before, direction, 'best');
    if (direction === null || earlier === null || metric === null) {
      return { id, previous: earlier, current: metric, result: 'unavailable' };
    }
    const improved = direction === 'lower' ? metric < earlier : metric > earlier;
    return { id, previous: earlier, current: metric, result: improved ? 'improved' : 'stagnant' };
  });
  const results = new Set(defects.map((defect) => defect.result));
  let verdict = 'progress';
  if (results.has('stagnant')) verdict = 'stagnant';
  else if (results.has('unavailable')) verdict = 'unavailable';
  return { verdict, defects };
}

// --- candidate ranking ----------------------------------------------------------------------------

const UNVERIFIED = Object.freeze({
  verified: false, verifiedBy: null, blocking: null, satisfied: 0, commandMetric: null, rubricScore: null,
});

// What one verifying iteration established about its candidate: blocking defects (each criterion of a
// failed command check counts), satisfied mandatory bindings, the command metric sum (null when a
// failed check has no metric) and the verdict review's rubric total.
function verificationScore(cycle, entry) {
  const results = new Map(entry.checks.results.map((result) => [result.id, result]));
  const verdict = entry.reviews.find((review) => review.role === verdictRole(cycle));
  const reviewDefects = entry.reviews.flatMap((review) => review.defects);
  const reviewsValid = entry.reviews.every((review) => VERDICT_STATUSES.has(review.status));
  const failedChecks = [...results.values()].filter((result) => !result.passed);
  const blocking = failedChecks.reduce((total, result) => total
    + Math.max(1, cycle.bindings.filter((bound) => bound.check === result.id).length), 0)
    + new Set(reviewDefects.filter((defect) => defect.blocking).map((defect) => defect.id)).size
    + entry.reviews.filter((review) => !VERDICT_STATUSES.has(review.status)).length;
  const satisfied = cycle.bindings.filter((bound) => {
    if (bound.kind === 'command') return results.get(bound.check)?.passed === true;
    if (bound.kind === 'review') {
      return verdict !== undefined && reviewsValid && !reviewDefects.some((defect) => defect.blocking
        && defect.check === 'review' && defect.criterion === bound.criterion);
    }
    return verdict?.rubric?.criteria.some((item) => item.criterion === bound.criterion && item.approved) === true;
  }).length;
  const commandMetric = [...results.values()].reduce((sum, result) => {
    if (sum === null) return null;
    if (result.passed) return sum + (result.metric ?? 0);
    return result.metric === null ? null : sum + result.metric;
  }, 0);
  const rubricScore = (verdict?.rubric?.criteria ?? []).reduce((total, item) => total + item.score, 0);
  return { verified: true, verifiedBy: entry.iteration, blocking, satisfied, commandMetric, rubricScore };
}

function compareCandidates(left, right) {
  if (left.verified !== right.verified) return left.verified ? -1 : 1;
  if (left.verified) {
    if (left.blocking !== right.blocking) return left.blocking - right.blocking;
    if (left.satisfied !== right.satisfied) return right.satisfied - left.satisfied;
    const leftMetric = left.commandMetric ?? Number.POSITIVE_INFINITY;
    const rightMetric = right.commandMetric ?? Number.POSITIVE_INFINITY;
    if (leftMetric !== rightMetric) return leftMetric < rightMetric ? -1 : 1;
    if (left.rubricScore !== right.rubricScore) return right.rubricScore - left.rubricScore;
  }
  return left.iteration - right.iteration;
}

// Runs a pure check that refuses through Refusal and returns its value, or the failure envelope.
function attempt(check) {
  try {
    return { ok: true, value: check() };
  } catch (error) {
    if (error instanceof Refusal) return failure(error);
    throw error;
  }
}

function assertBindings(bindings, label) {
  if (!Array.isArray(bindings) || !bindings.every((entry) => isPlainObject(entry)
    && typeof entry.criterion === 'string' && typeof entry.check === 'string')) {
    throw new TypeError(`${label}: bindings must be an array of { criterion, check, ... } bindings`);
  }
}

function assertDefects(defects, label, name) {
  if (!Array.isArray(defects) || !defects.every((defect) => isPlainObject(defect) && typeof defect.id === 'string'
    && typeof defect.criterion === 'string' && typeof defect.check === 'string')) {
    throw new TypeError(`${label}: ${name} must be an array of normalized defects`);
  }
}

// --- record handlers ------------------------------------------------------------------------------

function identityOf(record) {
  const identity = { kind: record.kind ?? null };
  for (const key of ['scope', 'cycle', 'iteration']) {
    if (Object.hasOwn(record, key)) identity[key] = record[key];
  }
  return identity;
}

function schema(condition, message, identity) {
  if (!condition) refuse(REFUSAL.RECORD_SCHEMA, message, identity);
}

function openRun(draft, record, { identity }) {
  const { planDigest, drive, tasks, observation } = record;
  schema(isHex64(planDigest), 'planDigest must be a lowercase 64-hex digest', identity);
  schema(DRIVES.has(drive), `drive must be one of: ${[...DRIVES].join(', ')}`, identity);
  schema(isHex64(observation), 'observation must be a lowercase 64-hex digest', identity);
  schema(Array.isArray(tasks) && tasks.length > 0, 'tasks must be a non-empty array', identity);
  const earlier = [];
  for (const [index, task] of tasks.entries()) {
    const label = `tasks[${index}]`;
    schema(isPlainObject(task) && hasExactKeys(task, PLAN_TASK_FIELDS),
      `${label} must have exactly the keys: ${PLAN_TASK_FIELDS.join(', ')}`, identity);
    schema(isTaskId(task.task), `${label}.task must be a positive-integer string`, identity);
    const number = Number(task.task);
    schema(earlier.length === 0 || number > Number(earlier.at(-1)),
      `${label}.task '${task.task}' must be strictly greater than the previous task`, identity);
    const { dependencies } = task;
    schema(Array.isArray(dependencies)
      && dependencies.every((dependency, position) => earlier.includes(dependency)
        && (position === 0 || Number(dependency) > Number(dependencies[position - 1]))),
    `${label}.dependencies must name earlier tasks in increasing order`, identity);
    schema(COMPLEXITIES.has(task.complexity), `${label}.complexity must be one of: ${[...COMPLEXITIES].join(', ')}`,
      identity);
    schema(isUniqueArray(task.criterionIds, (id) => typeof id === 'string' && CRITERION_ID.test(id)),
      `${label}.criterionIds must be unique SC<n> identifiers`, identity);
    schema(isLine(task.testCommand), `${label}.testCommand must be a non-empty single line`, identity);
    earlier.push(task.task);
  }
  draft.run = { planDigest, drive, observation, tasks: structuredClone(tasks) };
}

function cycleKey(scope, cycle) {
  return `${scope}#${cycle}`;
}

// The plan tasks, in plan order, whose task scope has an approved cycle.
function deliveredTasks(draft) {
  const approved = new Set(Object.values(draft.cycles)
    .filter((entry) => entry.status === 'APPROVED').map((entry) => entry.scope));
  return draft.run.tasks.filter((entry) => approved.has(`task-${entry.task}`));
}

function taskOfScope(scope) {
  const match = SCOPE.exec(scope);
  return match?.[1] ?? null;
}

function openCycle(draft, record, { identity }) {
  const { scope, cycle, predecessor, checks, bindings, rubricCriteria, review, observation } = record;
  schema(typeof scope === 'string' && SCOPE.test(scope), "scope must be 'task-<N>' or 'final'", identity);
  schema(isPositiveInteger(cycle), 'cycle must be a positive integer', identity);
  schema(predecessor === null || (typeof predecessor === 'string' && CYCLE_REFERENCE.test(predecessor)),
    "predecessor must be null or '<scope>#<n>'", identity);
  schema(Array.isArray(checks)
    && checks.every((check) => isPlainObject(check) && hasExactKeys(check, CHECK_FIELDS)
      && isLine(check.id) && isLine(check.command))
    && new Set(checks.map((check) => check.id)).size === checks.length,
  'checks must be { id, command } single-line entries with unique ids', identity);
  schema(Array.isArray(bindings), 'bindings must be an array', identity);
  schema(Array.isArray(rubricCriteria) && rubricCriteria.every(isLine),
    'rubricCriteria must be an array of non-empty single-line strings', identity);
  schema(REVIEW_MODES.has(review), `review must be one of: ${[...REVIEW_MODES].join(', ')}`, identity);
  schema(isHex64(observation), 'observation must be a lowercase 64-hex digest', identity);

  const task = taskOfScope(scope);
  if (task !== null) {
    if (!draft.run.tasks.some((entry) => entry.task === task)) {
      refuse(REFUSAL.SCOPE_NOT_RUNNABLE, `scope '${scope}' names no task of the plan`, identity);
    }
    const blocking = Object.values(draft.cycles)
      .find((entry) => entry.scope === scope && (entry.status === 'OPEN' || entry.status === 'APPROVED'));
    if (blocking !== undefined) {
      refuse(REFUSAL.SCOPE_NOT_RUNNABLE,
        `scope '${scope}' already has a ${blocking.status.toLowerCase()} cycle ${blocking.cycle}`, identity);
    }
  }
  if (cycle !== 1 || predecessor !== null) {
    refuse(REFUSAL.REOPEN_INVALID, 'only cycle 1 with a null predecessor can be opened', identity);
  }
  const key = cycleKey(scope, cycle);
  if (Object.hasOwn(draft.cycles, key)) refuse(REFUSAL.REOPEN_INVALID, `cycle ${key} was already opened`, identity);

  // The verification a cycle opens with is not negotiable: it must be exactly the derivation for its
  // scope, so no criterion, check or threshold can be dropped or weakened.
  const final = task === null;
  const input = {
    scope,
    task: final ? null : planTask(draft, task),
    deliveredTasks: final ? deliveredTasks(draft) : null,
    rubricCriteria,
    reviewOptIn: review === 'required',
  };
  const problem = bindingInputProblem(input);
  schema(problem === null, problem, identity);
  const derived = deriveBindings(input);
  schema(sameValue(checks, derived.checks) && sameValue(bindings, derived.bindings) && review === derived.review,
    `checks, bindings and review must equal the derivation for scope '${scope}'`, identity);

  draft.cycles[key] = {
    scope,
    cycle,
    predecessor,
    checks: structuredClone(checks),
    bindings: structuredClone(bindings),
    rubricCriteria: [...rubricCriteria],
    review,
    observation,
    status: 'OPEN',
    stopReason: null,
    stopNote: null,
    approvedObservation: null,
    reserved: 0,
    diagnosisUsed: false,
    diagnosisRequired: false,
    diagnosis: null,
    retries: [],
    admittedRemedies: [],
    nextRemedy: null,
    iterations: [],
  };
  draft.cycleOrder.push(key);
}

// Resolves the OPEN cycle a record names, refusing an unknown or terminal cycle.
function requireOpenCycle(draft, record, identity) {
  const { scope, cycle } = record;
  schema(typeof scope === 'string' && SCOPE.test(scope), "scope must be 'task-<N>' or 'final'", identity);
  schema(isPositiveInteger(cycle), 'cycle must be a positive integer', identity);
  const key = cycleKey(scope, cycle);
  if (!Object.hasOwn(draft.cycles, key)) refuse(REFUSAL.CYCLE_NOT_OPEN, `cycle ${key} was never opened`, identity);
  const entry = draft.cycles[key];
  if (entry.status !== 'OPEN') {
    refuse(REFUSAL.CYCLE_TERMINAL, `cycle ${key} is ${entry.status.toLowerCase()} (${entry.stopReason})`, identity);
  }
  return entry;
}

// The latest reserved iteration, which must be the one the record names and still unconcluded.
function requireCurrentIteration(cycle, iteration, identity) {
  schema(isPositiveInteger(iteration), 'iteration must be a positive integer', identity);
  const entry = cycle.iterations.at(-1);
  if (entry === undefined || entry.iteration !== iteration || entry.conclusion !== null) {
    refuse(REFUSAL.OUTCOME_ORDER, `iteration ${iteration} is not the reserved, unconcluded iteration`, identity);
  }
  return entry;
}

function stopCycle(cycle, reason, note = null) {
  cycle.status = 'STOPPED';
  cycle.stopReason = reason;
  cycle.stopNote = note;
}

// Concludes an iteration without approval. The slot stays spent; once the allowance is used up the
// cycle stops unless a more specific stop already applied.
function concludeIteration(cycle, entry, conclusion) {
  entry.conclusion = conclusion;
  if (cycle.status === 'OPEN' && entry.iteration >= ITERATION_ALLOWANCE) stopCycle(cycle, STOP.EXHAUSTED);
}

function reserveIteration(draft, record, { identity }) {
  const cycle = requireOpenCycle(draft, record, identity);
  const { iteration, iterationKind, reason } = record;
  schema(isPositiveInteger(iteration), 'iteration must be a positive integer', identity);
  schema(ITERATION_KINDS.has(iterationKind), `iterationKind must be one of: ${[...ITERATION_KINDS].join(', ')}`,
    identity);
  schema(reason === null || DIAGNOSIS_REASONS.has(reason),
    `reason must be null or one of: ${[...DIAGNOSIS_REASONS].join(', ')}`, identity);
  if (iteration !== cycle.reserved + 1 || iteration > ITERATION_ALLOWANCE) {
    refuse(REFUSAL.ALLOWANCE_EXHAUSTED,
      `iteration ${iteration} is not the next of ${ITERATION_ALLOWANCE} (${cycle.reserved} reserved)`, identity);
  }
  if (iteration > 1 && cycle.iterations.at(-1).conclusion === null) {
    refuse(REFUSAL.OUTCOME_ORDER, `iteration ${iteration - 1} has not concluded`, identity);
  }
  if ((iteration === 1) !== (iterationKind === 'initial')) {
    refuse(REFUSAL.RECORD_ORDER, 'iteration 1 must be initial, and initial is allowed only at iteration 1', identity);
  }
  const retryAdmitted = cycle.retries.some((retry) => retry.iteration === iteration);
  if (retryAdmitted && iterationKind !== 'correction') {
    refuse(REFUSAL.RECORD_ORDER,
      `an admitted retry must be executed as the correction for iteration ${iteration}`, identity);
  }
  if (iterationKind === 'diagnosis') {
    if (reason === null) refuse(REFUSAL.DIAGNOSIS_REASON, 'a diagnosis iteration requires a reason', identity);
    if (cycle.diagnosisUsed) refuse(REFUSAL.DIAGNOSIS_USED, 'this cycle already reserved its diagnosis', identity);
  } else if (reason !== null) {
    refuse(REFUSAL.DIAGNOSIS_REASON, `a ${iterationKind} iteration carries no diagnosis reason`, identity);
  }
  if (iterationKind === 'correction' && !retryAdmitted) {
    refuse(REFUSAL.RETRY_REQUIRED, `a correction at iteration ${iteration} requires an admitted retry`, identity);
  }
  cycle.iterations.push({
    iteration, kind: iterationKind, reason, dispatches: [], writer: null, checks: null, reviews: [], conclusion: null,
  });
  cycle.reserved += 1;
  if (iterationKind === 'correction') cycle.nextRemedy = null;
  if (iterationKind === 'diagnosis') cycle.diagnosisUsed = true;
}

function interruptIteration(draft, record, { ref, identity }) {
  const cycle = requireOpenCycle(draft, record, identity);
  const { iteration, reason, observation } = record;
  schema(isText(reason), 'reason must be a non-empty string', identity);
  schema(isHex64(observation), 'observation must be a lowercase 64-hex digest', identity);
  const entry = requireCurrentIteration(cycle, iteration, identity);
  // The interruption's own record file is its evidence; without that reference nothing can bind to it.
  const evidence = ref === null ? [] : [{ path: ref.path, digest: ref.digest, source: 'interruption' }];
  concludeIteration(cycle, entry, { via: 'interrupted', reason, observation, evidence });
}

// The criterion IDs a cycle binds to evidence. Each binding names its criterion; the remaining
// binding keys are not interpreted here.
function boundCriterionIds(cycle) {
  return new Set(cycle.bindings.map((binding) => binding.criterion));
}

function normalizeText(value) {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function isStatusOnly(value) {
  const bare = value.trim().replace(/[\p{P}\s]+$/u, '');
  return bare.length === 0 || STATUS_WORDS.has(bare.toLowerCase());
}

// This cycle and every predecessor cycle it names, newest first.
function cycleLineage(cycles, cycle) {
  const lineage = [cycle];
  let current = cycle;
  while (current.predecessor !== null && Object.hasOwn(cycles, current.predecessor)) {
    current = cycles[current.predecessor];
    lineage.push(current);
  }
  return lineage;
}

// The evidence references a retry may bind to: those of the latest concluded iteration, plus the
// artifact of the cycle's valid diagnosis.
function admissibleEvidence(cycle) {
  const latest = cycle.iterations.at(-1);
  const references = latest?.conclusion?.evidence ?? [];
  const diagnosis = cycle.diagnosis?.valid ? [{ ...cycle.diagnosis.artifact, source: 'diagnosis' }] : [];
  return [...references, ...diagnosis];
}

function checkRetryRequest(state, request) {
  if (state.halted !== null) refuse(REFUSAL.RUN_HALTED, 'the run is halted; no retry is admitted');
  if (!isPlainObject(request)) refuse(REFUSAL.RETRY_INVALID, 'a retry request must be a plain object');
  const identity = {};
  for (const key of ['scope', 'cycle', 'iteration']) if (Object.hasOwn(request, key)) identity[key] = request[key];
  const invalid = (condition, message) => { if (!condition) refuse(REFUSAL.RETRY_INVALID, message, identity); };
  invalid(hasExactKeys(request, RETRY_FIELDS), `a retry request has exactly the keys: ${RETRY_FIELDS.join(', ')}`);
  const { scope, cycle: cycleNumber, iteration, kind, target, evidence, remedy, confirmingCheck } = request;
  invalid(request.version === 1, 'version must be 1');
  invalid(typeof scope === 'string' && SCOPE.test(scope), "scope must be 'task-<N>' or 'final'");
  invalid(isPositiveInteger(cycleNumber), 'cycle must be a positive integer');
  invalid(isPositiveInteger(iteration), 'iteration must be a positive integer');
  invalid(RETRY_KINDS.has(kind), `kind must be one of: ${[...RETRY_KINDS].join(', ')}`);
  invalid(typeof target === 'string', 'target must be a string');
  invalid(typeof confirmingCheck === 'string', 'confirmingCheck must be a string');
  invalid(isDigestReference(evidence), 'evidence must be { path, digest } with a lowercase 64-hex digest');
  for (const field of RETRY_TEXT_FIELDS) invalid(typeof request[field] === 'string', `${field} must be a string`);

  const key = cycleKey(scope, cycleNumber);
  if (!Object.hasOwn(state.cycles, key)) refuse(REFUSAL.CYCLE_NOT_OPEN, `cycle ${key} was never opened`, identity);
  const cycle = state.cycles[key];
  if (cycle.status !== 'OPEN') {
    refuse(REFUSAL.CYCLE_TERMINAL, `cycle ${key} is ${cycle.status.toLowerCase()} (${cycle.stopReason})`, identity);
  }
  const latest = cycle.iterations.at(-1);
  if (latest === undefined || latest.conclusion === null) {
    refuse(REFUSAL.OUTCOME_ORDER, 'a retry follows a concluded iteration', identity);
  }
  if (cycle.diagnosisRequired) {
    refuse(REFUSAL.DIAGNOSIS_REQUIRED, `cycle ${key} could not compare its outcomes; it needs its diagnosis first`,
      identity);
  }
  if (iteration !== cycle.reserved + 1 || iteration > ITERATION_ALLOWANCE) {
    refuse(REFUSAL.ALLOWANCE_EXHAUSTED,
      `iteration ${iteration} is not the next of ${ITERATION_ALLOWANCE} (${cycle.reserved} reserved)`, identity);
  }
  const checkIds = cycle.checks.map((check) => check.id);
  invalid(boundCriterionIds(cycle).has(target) || checkIds.includes(target),
    `target '${target}' is neither a bound criterion nor a check of cycle ${key}`);
  invalid(checkIds.includes(confirmingCheck) || REVIEW_CONFIRMATIONS.includes(confirmingCheck),
    `confirmingCheck '${confirmingCheck}' is neither a check of cycle ${key} nor review or rubric`);

  const bound = admissibleEvidence(cycle)
    .filter((reference) => kind !== 'tool-failure' || TOOL_FAILURE_SOURCES.has(reference.source))
    .some((reference) => reference.path === evidence.path && reference.digest === evidence.digest);
  if (!bound) {
    refuse(REFUSAL.RETRY_EVIDENCE_UNBOUND, `${kind} evidence ${evidence.path} is not a reference of the latest `
      + 'concluded iteration or of a valid diagnosis', identity);
  }

  for (const field of RETRY_TEXT_FIELDS) {
    if (isStatusOnly(request[field])) {
      refuse(REFUSAL.RETRY_STATUS_ONLY, `${field} is empty or only a status word`, identity);
    }
  }
  const normalizedRemedy = normalizeText(remedy);
  invalid(normalizeText(request.hypothesis) !== normalizedRemedy, 'hypothesis must differ from remedy');
  invalid(normalizeText(request.difference) !== normalizedRemedy, 'difference must differ from remedy');

  const earlier = cycleLineage(state.cycles, cycle).flatMap((entry) => entry.retries);
  const triple = (retry) => [retry.target, normalizeText(retry.hypothesis), normalizeText(retry.remedy)].join('\u0000');
  if (earlier.some((retry) => normalizeText(retry.remedy) === normalizedRemedy || triple(retry) === triple(request))) {
    refuse(REFUSAL.RETRY_REPEATED, 'this remedy was already admitted in this cycle or a predecessor', identity);
  }
}

function admitRetry(draft, record, { identity }) {
  const cycle = requireOpenCycle(draft, record, identity);
  const { iteration, request, requestDigest } = record;
  schema(isPositiveInteger(iteration), 'iteration must be a positive integer', identity);
  schema(isHex64(requestDigest), 'requestDigest must be a lowercase 64-hex digest', identity);
  if (isPlainObject(request)
    && (request.scope !== record.scope || request.cycle !== record.cycle || request.iteration !== iteration)) {
    refuse(REFUSAL.RETRY_INVALID, 'the request must name the same scope, cycle and iteration as the record', identity);
  }
  if (cycle.retries.some((retry) => retry.iteration === iteration)) {
    refuse(REFUSAL.RECORD_ORDER, `a retry is already admitted for iteration ${iteration}`, identity);
  }
  try {
    checkRetryRequest(draft, request);
  } catch (error) {
    if (error instanceof Refusal) refuse(error.code, error.message, identity);
    throw error;
  }
  const { kind, target, evidence, hypothesis, remedy, confirmingCheck } = request;
  cycle.retries.push({
    iteration, kind, target, evidence: { path: evidence.path, digest: evidence.digest }, hypothesis, remedy,
    confirmingCheck, requestDigest,
  });
  cycle.admittedRemedies.push(remedy);
  cycle.nextRemedy = remedy;
}

function permittedRoles(cycle, entry) {
  return PERMITTED_ROLES[cycle.scope === 'final' ? 'final' : 'task'][entry.kind];
}

function planTask(draft, task) {
  return draft.run.tasks.find((entry) => entry.task === task) ?? null;
}

// Owner rules: a final-scope writer names the plan task it changes and the criteria that change
// affects; a final-scope task-reviewer names the task it reviews (the writer's task when this iteration
// authorized a writer) and no criteria; every other dispatch names none.
function checkOwnership(draft, cycle, entry, record, identity) {
  const { role, ownerTask, affectedCriteria } = record;
  const final = cycle.scope === 'final';
  if (final && (role === 'writer' || role === 'task-reviewer')) {
    const owner = ownerTask === null ? null : planTask(draft, ownerTask);
    if (owner === null) {
      refuse(REFUSAL.ROLE_NOT_ALLOWED, `a final-scope ${role} requires a plan-task ownerTask`, identity);
    }
    if (role === 'writer' && affectedCriteria.length === 0) {
      refuse(REFUSAL.ROLE_NOT_ALLOWED, 'a final-scope writer requires non-empty affectedCriteria', identity);
    }
    if (role === 'task-reviewer' && affectedCriteria.length > 0) {
      refuse(REFUSAL.ROLE_NOT_ALLOWED,
        'a final-scope task-reviewer carries affectedCriteria: []; affected criteria belong to the writer', identity);
    }
    const writer = entry.dispatches.find((dispatch) => dispatch.role === 'writer');
    if (role === 'task-reviewer' && writer !== undefined && writer.ownerTask !== ownerTask) {
      refuse(REFUSAL.ROLE_NOT_ALLOWED,
        `a final-scope task-reviewer reviews the writer's task ${writer.ownerTask}, not ${ownerTask}`, identity);
    }
    const outside = affectedCriteria.filter((id) => !owner.criterionIds.includes(id));
    if (outside.length > 0) {
      refuse(REFUSAL.ROLE_NOT_ALLOWED,
        `affectedCriteria ${outside.join(', ')} are not criteria of task ${owner.task}`, identity);
    }
  } else if (ownerTask !== null || affectedCriteria.length > 0) {
    refuse(REFUSAL.ROLE_NOT_ALLOWED, `a ${cycle.scope === 'final' ? 'final' : 'task'}-scope ${role} carries `
      + 'ownerTask: null and affectedCriteria: []', identity);
  }
}

function authorizeDispatch(draft, record, { identity }) {
  const cycle = requireOpenCycle(draft, record, identity);
  const { iteration, role, target, ownerTask, affectedCriteria, observation } = record;
  schema(ROLES.has(role), `role must be one of: ${[...ROLES].join(', ')}`, identity);
  schema(isLine(target), 'target must be a non-empty single line', identity);
  schema(ownerTask === null || isTaskId(ownerTask), 'ownerTask must be null or a task ID', identity);
  schema(isUniqueArray(affectedCriteria, (id) => typeof id === 'string' && CRITERION_ID.test(id)),
    'affectedCriteria must be unique SC<n> identifiers', identity);
  schema(isHex64(observation), 'observation must be a lowercase 64-hex digest', identity);
  const entry = requireCurrentIteration(cycle, iteration, identity);
  const permitted = permittedRoles(cycle, entry);
  const dispatched = entry.dispatches.map((dispatch) => dispatch.role);
  if (!permitted.includes(role)) {
    refuse(REFUSAL.ROLE_NOT_ALLOWED, `a ${entry.kind} iteration of scope ${cycle.scope} authorizes only `
      + `${permitted.join(', ')}`, identity);
  }
  if (dispatched.includes(role)) {
    refuse(REFUSAL.ROLE_ALREADY_DISPATCHED, `${role} was already authorized in iteration ${iteration}`, identity);
  }
  if (role === 'writer' && dispatched.some((name) => REVIEWER_ROLES.has(name))) {
    refuse(REFUSAL.ROLE_NOT_ALLOWED, 'a writer must be authorized before the reviewers', identity);
  }
  if (role === 'task-reviewer' && cycle.review === 'skipped') {
    refuse(REFUSAL.ROLE_NOT_ALLOWED, `cycle ${cycle.scope}#${cycle.cycle} skips review`, identity);
  }
  if (role === 'writer' && entry.checks !== null) {
    refuse(REFUSAL.OUTCOME_ORDER, `the checks of iteration ${iteration} were recorded; no writer may follow`, identity);
  }
  if (entry.kind === 'initial' && REVIEWER_ROLES.has(role) && permitted.includes('writer')
    && !dispatched.includes('writer')) {
    refuse(REFUSAL.ROLE_NOT_ALLOWED, `an initial iteration authorizes the writer before the ${role}`, identity);
  }
  checkOwnership(draft, cycle, entry, record, identity);
  entry.dispatches.push({ role, target, ownerTask, affectedCriteria: [...affectedCriteria], observation });
}

function recordDiagnosis(draft, record, { identity }) {
  const cycle = requireOpenCycle(draft, record, identity);
  const { iteration, valid, artifact, before, after } = record;
  const fields = ['hypothesis', 'remedy', 'confirmingCheck', 'recommendation'];
  schema(typeof valid === 'boolean', 'valid must be a boolean', identity);
  for (const field of fields) {
    schema(valid ? isText(record[field]) : typeof record[field] === 'string',
      `${field} must be ${valid ? 'a non-empty string for a valid diagnosis' : 'a string'}`, identity);
  }
  schema(isDigestReference(artifact), 'artifact must be { path, digest } with a lowercase 64-hex digest', identity);
  schema(isHex64(before) && isHex64(after), 'before and after must be lowercase 64-hex digests', identity);
  const entry = requireCurrentIteration(cycle, iteration, identity);
  if (entry.kind !== 'diagnosis') {
    refuse(REFUSAL.ROLE_NOT_ALLOWED, `iteration ${iteration} is a ${entry.kind} iteration, not a diagnosis`, identity);
  }
  if (!entry.dispatches.some((dispatch) => dispatch.role === 'diagnostic')) {
    refuse(REFUSAL.OUTCOME_ORDER, 'a diagnosis is recorded only after its diagnostic is authorized', identity);
  }
  // A diagnostic must leave the observed tree unchanged; a mismatch is an integrity fault the guard
  // answers by halting the run.
  if (before !== after) refuse(HALT.INTEGRITY, 'the observation changed during the diagnosis', identity);
  const diagnosis = { iteration, valid, artifact: { path: artifact.path, digest: artifact.digest } };
  for (const field of fields) diagnosis[field] = record[field];
  cycle.diagnosis = diagnosis;
  if (valid) cycle.diagnosisRequired = false;
  if (!valid) stopCycle(cycle, STOP.DIAGNOSIS_INCONCLUSIVE);
  else if (iteration >= ITERATION_ALLOWANCE) cycle.nextRemedy = diagnosis.recommendation;
  concludeIteration(cycle, entry, {
    via: 'diagnosis', evidence: [{ path: artifact.path, digest: artifact.digest, source: 'diagnosis' }],
  });
}

function stopCycleExplicitly(draft, record, { identity }) {
  const cycle = requireOpenCycle(draft, record, identity);
  const { reason, note } = record;
  schema(EXPLICIT_STOPS.has(reason), `reason must be one of: ${[...EXPLICIT_STOPS].join(', ')}`, identity);
  schema(isText(note), 'note must be a non-empty string', identity);
  stopCycle(cycle, reason, note);
}

// --- outcomes -------------------------------------------------------------------------------------

function reference({ path, digest }, source) {
  return source === undefined ? { path, digest } : { path, digest, source };
}

function proofOf(evidence) {
  return `${evidence.path}@${evidence.digest}`;
}

// A defect the guard derives from an outcome rather than from a reviewer. It always carries the
// feedback fields, so no failure lacks them.
function guardDefect({ criterion, check, cause, metric, expected, observed, proof, correction, nextCheck }) {
  return {
    id: defectId(criterion, check, null, cause), criterion, check, dimension: null, cause, severity: 'critical',
    expected, observed, proof: proofOf(proof), correction, nextCheck, supersedes: null, justification: null,
    blocking: true, metric,
  };
}

// The latest earlier iteration of the cycle that concluded with an outcome: not a diagnosis, not an
// interruption. Its defects are the previous comparable outcome.
function previousOutcome(cycle, iteration) {
  return cycle.iterations.findLast((entry) => entry.iteration < iteration && entry.conclusion?.via === 'outcome')
    ?? null;
}

// Concludes an iteration with its outcome. Approval stops the cycle APPROVED on the observation. A
// failed correction is compared with the previous comparable outcome: stagnation stops the cycle
// STAGNATED; an unavailable comparison requires the cycle's diagnosis while it is unused and a slot
// remains, else stops it COMPARISON_UNAVAILABLE. Any other failure awaits an admitted retry, or stops
// EXHAUSTED on the last slot. Only metric deltas on the cycle's fixed bindings count as progress.
function concludeOutcome(cycle, entry, { by, approved, observation, defects, evidence }) {
  if (approved) {
    entry.conclusion = { via: 'outcome', by, approved, observation, defects, evidence, comparison: null };
    cycle.status = 'APPROVED';
    cycle.stopReason = STOP.APPROVED;
    cycle.approvedObservation = observation;
    return;
  }
  const previous = entry.kind === 'correction' ? previousOutcome(cycle, entry.iteration) : null;
  const comparison = previous === null ? null : compare(previous.conclusion, { defects }, cycle.bindings);
  if (comparison?.verdict === 'stagnant') {
    stopCycle(cycle, STOP.STAGNATED);
  } else if (comparison?.verdict === 'unavailable') {
    if (!cycle.diagnosisUsed && entry.iteration < ITERATION_ALLOWANCE) cycle.diagnosisRequired = true;
    else stopCycle(cycle, STOP.COMPARISON_UNAVAILABLE);
  }
  concludeIteration(cycle, entry, { via: 'outcome', by, approved, observation, defects, evidence, comparison });
}

// The reviewer whose verdict concludes an iteration: the final reviewer in the final scope.
function verdictRole(cycle) {
  return cycle.scope === 'final' ? 'final-reviewer' : 'task-reviewer';
}

// An iteration approves its cycle when its writer (if any) is accepted, every command check passed,
// the verdict review is APPROVED when review is required, every recorded review is APPROVED with no
// blocking defect and a rubric at 8/8 with every constraint satisfied, and the writer, the checks and
// every review observed one and the same tree.
function approves(cycle, entry) {
  const { writer, checks, reviews } = entry;
  if (entry.dispatches.some((dispatch) => dispatch.role === 'writer') && writer?.accepted !== true) return false;
  if (checks === null || !checks.results.every((result) => result.passed)) return false;
  if (cycle.review === 'required'
    && !reviews.some((review) => review.role === verdictRole(cycle) && review.status === 'APPROVED')) {
    return false;
  }
  if (!reviews.every((review) => review.status === 'APPROVED' && review.rubric?.approved === true
    && review.defects.every((defect) => !defect.blocking))) {
    return false;
  }
  const observations = new Set([
    checks.observation,
    ...(writer === null ? [] : [writer.observation]),
    ...reviews.map((review) => review.observation),
  ]);
  return observations.size === 1;
}

function recordWriter(draft, record, { ref, identity }) {
  const cycle = requireOpenCycle(draft, record, identity);
  const { iteration, status, evidence, responseDigest, observation, candidate, changedPaths } = record;
  schema(WRITER_STATUSES.has(status), `status must be one of: ${[...WRITER_STATUSES].join(', ')}`, identity);
  schema(Array.isArray(evidence) && evidence.length > 0 && evidence.every(isDigestReference),
    'evidence must be a non-empty array of { path, digest } references', identity);
  schema(responseDigest === null || isHex64(responseDigest), 'responseDigest must be null or a 64-hex digest',
    identity);
  schema(isHex64(observation), 'observation must be a lowercase 64-hex digest', identity);
  schema(isDigestReference(candidate), 'candidate must be { path, digest } with a lowercase 64-hex digest', identity);
  schema(Array.isArray(changedPaths) && changedPaths.every(isLine)
    && changedPaths.every((path, index) => index === 0 || changedPaths[index - 1] < path),
  'changedPaths must be sorted, unique single-line paths', identity);
  const entry = requireCurrentIteration(cycle, iteration, identity);
  if (!entry.dispatches.some((dispatch) => dispatch.role === 'writer')) {
    refuse(REFUSAL.OUTCOME_ORDER, `iteration ${iteration} authorized no writer`, identity);
  }
  if (entry.writer !== null) refuse(REFUSAL.OUTCOME_ORDER, `the writer of iteration ${iteration} was already recorded`,
    identity);
  const accepted = ACCEPTED_WRITER_STATUSES.has(status);
  entry.writer = {
    status, accepted, evidence: evidence.map((item) => reference(item)), responseDigest, observation,
    candidate: reference(candidate), changedPaths: [...changedPaths], ref: ref === null ? null : reference(ref),
  };
  if (accepted) return;
  const defect = guardDefect({
    criterion: '*', check: 'writer', cause: status.toLowerCase(), metric: null,
    expected: 'writer status DONE or DONE_WITH_CONCERNS',
    observed: `writer status ${status}`,
    proof: evidence[0],
    correction: `resolve what made the writer report ${status} and dispatch it again without weakening any criterion`,
    nextCheck: 'writer',
  });
  const references = ref === null ? evidence : [...evidence, ref];
  concludeOutcome(cycle, entry, {
    by: 'writer', approved: false, observation, defects: [defect],
    evidence: references.map((item) => reference(item, 'writer-failure')),
  });
}

// The iteration whose accepted writer produced the candidate an iteration verifies: its own, otherwise
// the cycle's latest earlier one; null means the baseline (the cycle's opening observation).
function candidateOwner(cycle, entry) {
  if (entry.writer?.accepted) return entry;
  return cycle.iterations.findLast((other) => other.iteration < entry.iteration && other.writer?.accepted) ?? null;
}

function candidateObservation(cycle, entry) {
  return candidateOwner(cycle, entry)?.writer.observation ?? cycle.observation;
}

function isCheckResult(result) {
  return isPlainObject(result) && hasExactKeys(result, CHECK_RESULT_FIELDS) && isLine(result.id)
    && (result.exitCode === null || Number.isSafeInteger(result.exitCode)) && typeof result.passed === 'boolean'
    && (result.metric === null || (Number.isSafeInteger(result.metric) && result.metric >= 0))
    && isDigestReference(result.evidence);
}

function metricNoun(check) {
  return check === COHERENCE_GATE.id ? 'violations' : 'failed assertions';
}

function checkFailureDefect(criterion, result) {
  const noun = metricNoun(result.id);
  return guardDefect({
    criterion, check: result.id, cause: 'command-failed', metric: result.metric,
    expected: `exit 0 with 0 ${noun}`,
    observed: `${result.exitCode === null ? 'no exit code' : `exit ${result.exitCode}`}, `
      + `${result.metric === null ? 'an unknown number of' : result.metric} ${noun}`,
    proof: result.evidence,
    correction: `make ${result.id} pass without weakening it`,
    nextCheck: result.id,
  });
}

function recordChecks(draft, record, { ref, identity }) {
  const cycle = requireOpenCycle(draft, record, identity);
  const { iteration, observation, checks } = record;
  schema(isHex64(observation), 'observation must be a lowercase 64-hex digest', identity);
  schema(Array.isArray(checks) && checks.every(isCheckResult), 'checks must be { id, exitCode (integer or null), '
    + 'passed (boolean), metric (non-negative integer or null), evidence ({ path, digest }) } results', identity);
  const expected = cycle.checks.map((check) => check.id);
  const ids = checks.map((result) => result.id);
  const missing = expected.filter((id) => !ids.includes(id));
  schema(missing.length === 0, `an unexecuted mandatory check is not optional; missing: ${missing.join(', ')}`,
    identity);
  schema(ids.length === expected.length && new Set(ids).size === ids.length,
    `checks must record exactly the cycle checks once each: ${expected.join(', ')}`, identity);
  const contradicted = checks.filter((result) => result.passed
    && ((result.exitCode !== null && result.exitCode !== 0) || (result.metric !== null && result.metric > 0)));
  schema(contradicted.length === 0, `a check recorded passed has a non-zero exit code or metric: `
    + `${contradicted.map((result) => result.id).join(', ')}`, identity);
  const entry = requireCurrentIteration(cycle, iteration, identity);
  if (entry.kind === 'diagnosis') refuse(REFUSAL.OUTCOME_ORDER, 'a diagnosis iteration records no checks', identity);
  if (entry.checks !== null) refuse(REFUSAL.OUTCOME_ORDER, `the checks of iteration ${iteration} were already recorded`,
    identity);
  // The checks follow an authorized writer's record; a task's initial iteration always has a writer,
  // so its checks never verify the untouched baseline.
  const writerExpected = entry.dispatches.some((dispatch) => dispatch.role === 'writer')
    || (entry.kind === 'initial' && permittedRoles(cycle, entry).includes('writer'));
  if (writerExpected && entry.writer === null) {
    refuse(REFUSAL.OUTCOME_ORDER, 'the checks follow the record of the iteration writer', identity);
  }
  const candidate = candidateObservation(cycle, entry);
  if (observation !== candidate) {
    refuse(HALT.INTEGRITY, `the checks observed ${observation}, not the iteration candidate ${candidate}`, identity);
  }
  entry.checks = {
    observation,
    results: checks.map((result) => ({ ...result, evidence: reference(result.evidence) })),
    ref: ref === null ? null : reference(ref),
  };
  const failed = cycle.checks.map((check) => checks.find((result) => result.id === check.id))
    .filter((result) => !result.passed);
  if (failed.length === 0) {
    // Without a review, passed checks are the verdict.
    if (cycle.review === 'skipped') {
      concludeOutcome(cycle, entry, {
        by: 'checks', approved: approves(cycle, entry), observation, defects: [],
        evidence: (ref === null ? [] : [ref]).map((item) => reference(item, 'checks')),
      });
    }
    return;
  }
  // Each criterion bound to a failed check gets a defect; a failed check binding none still gets one.
  const failedIds = new Set(failed.map((result) => result.id));
  const defects = cycle.bindings.filter((bound) => failedIds.has(bound.check))
    .map((bound) => checkFailureDefect(bound.criterion,
      failed.find((result) => result.id === bound.check)));
  for (const result of failed) {
    if (!cycle.bindings.some((bound) => bound.check === result.id)) {
      defects.push(checkFailureDefect('*', result));
    }
  }
  const references = [...failed.map((result) => result.evidence), ...(ref === null ? [] : [ref])];
  concludeOutcome(cycle, entry, {
    by: 'checks', approved: false, observation, defects,
    evidence: references.map((item) => reference(item, 'checks')),
  });
}

// The plan task a final-scope correction changes: its writer's owner task, else its task-reviewer's.
// `state` is a draft or a produced state: only its run plan is read.
function correctionOwner(state, entry) {
  const owned = entry.dispatches.find((dispatch) => dispatch.role === 'writer')
    ?? entry.dispatches.find((dispatch) => dispatch.role === 'task-reviewer');
  if (owned === undefined || owned.ownerTask === null) return null;
  return planTask(state, owned.ownerTask);
}

// The final review is recorded last: after every authorized task review and, when the correction
// changes an integration or design task, after an approved one.
function checkFinalReviewOrder(draft, cycle, entry, identity) {
  const taskReviewed = entry.reviews.some((review) => review.role === 'task-reviewer');
  if (entry.dispatches.some((dispatch) => dispatch.role === 'task-reviewer') && !taskReviewed) {
    refuse(REFUSAL.OUTCOME_ORDER, 'the authorized task-reviewer is recorded before the final-reviewer', identity);
  }
  const owner = cycle.scope === 'final' && entry.kind === 'correction' ? correctionOwner(draft, entry) : null;
  if (owner !== null && TASK_REVIEWED_COMPLEXITIES.has(owner.complexity)
    && !entry.reviews.some((review) => review.role === 'task-reviewer' && review.status === 'APPROVED')) {
    refuse(REFUSAL.FINAL_BYPASS, `a final-scope correction of ${owner.complexity} task ${owner.task} needs an `
      + 'approved task review before the final review', identity);
  }
}

function reviewFailureDefect(role, status, evidence) {
  return guardDefect({
    criterion: '*', check: 'review', cause: `review-${status.toLowerCase()}`, metric: null,
    expected: 'a complete, valid review: APPROVED, or ISSUES_FOUND with a blocking defect',
    observed: `${role} status ${status}`,
    proof: evidence,
    correction: `obtain a complete, valid ${role} review without weakening any criterion`,
    nextCheck: 'review',
  });
}

// Validates an APPROVED or ISSUES_FOUND report and returns its normalized defects (each rubric defect
// carrying its dimension score as metric) and rubric verdict. An invalid report is refused with its
// `review` code: the guard records such a review as INVALID instead.
function assessReview(draft, cycle, entry, record, identity) {
  const { role, ownerTask, status, defects, rubric } = record;
  const invalid = (failed) => refuse(failed.code, `the ${role} report is not a valid review (${failed.message}); `
    + 'the guard records it as INVALID', identity);
  const previous = previousOutcome(cycle, entry.iteration)?.conclusion.defects ?? [];
  const normalized = attempt(() => normalizeEntries(cycle.bindings, defects, previous));
  if (!normalized.ok) invalid(normalized);
  // A final-scope task review scores only the rubric criteria of the task it reviews.
  const owner = cycle.scope === 'final' && role === 'task-reviewer' ? planTask(draft, ownerTask) : null;
  const scored = attempt(() => checkRubric(rubricBindingsFor(cycle.bindings, owner), rubric, normalized.value));
  if (!scored.ok) invalid(scored);
  const blocking = normalized.value.some((defect) => defect.blocking);
  if ((status === 'APPROVED') === blocking) {
    invalid({
      code: REVIEW_INVALID.STATUS_INCONSISTENT,
      message: status === 'APPROVED' ? 'APPROVED with a blocking defect' : 'ISSUES_FOUND without a blocking defect',
    });
  }
  const scores = new Map(rubric.map((item) => [item.criterion, item]));
  return {
    defects: normalized.value.map((defect) => (defect.check === 'rubric'
      ? { ...defect, metric: scores.get(defect.criterion)?.[defect.dimension].score ?? null } : defect)),
    rubric: { approved: scored.value.every((item) => item.approved), criteria: scored.value },
  };
}

function recordReview(draft, record, { ref, identity }) {
  const cycle = requireOpenCycle(draft, record, identity);
  const { iteration, role, ownerTask, status, defects, rubric, evidence, before, after } = record;
  schema(REVIEWER_ROLES.has(role), `role must be one of: ${[...REVIEWER_ROLES].join(', ')}`, identity);
  schema(ownerTask === null || isTaskId(ownerTask), 'ownerTask must be null or a task ID', identity);
  schema(REVIEW_STATUSES.has(status), `status must be one of: ${[...REVIEW_STATUSES].join(', ')}`, identity);
  schema(Array.isArray(defects), 'defects must be an array', identity);
  schema(Array.isArray(rubric), 'rubric must be an array', identity);
  schema(Array.isArray(evidence) && evidence.every(isDigestReference),
    'evidence must be an array of { path, digest } references', identity);
  schema(VERDICT_STATUSES.has(status) || evidence.length > 0,
    `a review recorded ${status} needs evidence to prove it`, identity);
  schema(isHex64(before) && isHex64(after), 'before and after must be lowercase 64-hex digests', identity);
  const entry = requireCurrentIteration(cycle, iteration, identity);
  const dispatch = entry.dispatches.find((item) => item.role === role);
  if (dispatch === undefined) refuse(REFUSAL.OUTCOME_ORDER, `iteration ${iteration} authorized no ${role}`, identity);
  if (entry.reviews.some((review) => review.role === role)) {
    refuse(REFUSAL.OUTCOME_ORDER, `the ${role} of iteration ${iteration} was already recorded`, identity);
  }
  if (dispatch.ownerTask !== ownerTask) {
    refuse(REFUSAL.ROLE_NOT_ALLOWED, `the ${role} was authorized for owner task ${dispatch.ownerTask}, `
      + `not ${ownerTask}`, identity);
  }
  if (entry.checks === null) refuse(REFUSAL.OUTCOME_ORDER, 'a review follows the recorded checks', identity);
  // A reviewer must judge the checked tree and leave it unchanged; a mismatch is an integrity fault the
  // guard answers by halting the run.
  if (before !== entry.checks.observation || before !== after) {
    refuse(HALT.INTEGRITY, 'the review did not observe the checked tree unchanged', identity);
  }
  if (role === 'final-reviewer') checkFinalReviewOrder(draft, cycle, entry, identity);

  const references = ref === null ? evidence : [...evidence, ref];
  const review = {
    role, ownerTask, status, defects: [], rubric: null, evidence: evidence.map((item) => reference(item)),
    observation: before, ref: ref === null ? null : reference(ref),
  };
  if (!VERDICT_STATUSES.has(status)) {
    entry.reviews.push(review);
    concludeOutcome(cycle, entry, {
      by: 'review', approved: false, observation: before, defects: [reviewFailureDefect(role, status, evidence[0])],
      evidence: references.map((item) => reference(item, 'review-failure')),
    });
    return;
  }
  Object.assign(review, assessReview(draft, cycle, entry, record, identity));
  entry.reviews.push(review);
  // ISSUES_FOUND concludes the iteration failed; an APPROVED task review in the final scope leaves it
  // open for the final review, whose verdict concludes it.
  if (status === 'ISSUES_FOUND' || role === verdictRole(cycle)) {
    concludeOutcome(cycle, entry, {
      by: 'review', approved: status === 'APPROVED' && approves(cycle, entry), observation: before,
      defects: entry.reviews.flatMap((item) => item.defects),
      evidence: references.map((item) => reference(item, 'review')),
    });
  }
}

function haltRun(draft, record, { identity }) {
  const { reason, evidence, observation } = record;
  schema(isText(reason), 'reason must be a non-empty string', identity);
  schema(Array.isArray(evidence) && evidence.every(isDigestReference),
    'evidence must be an array of { path, digest } references', identity);
  schema(isHex64(observation), 'observation must be a lowercase 64-hex digest', identity);
  draft.halted = {
    reason, evidence: evidence.map(({ path, digest }) => ({ path, digest })), observation,
  };
}

// One entry per record kind: its closed payload keys and the handler that folds it into a mutable
// draft of the state (or refuses). Later record kinds extend this table.
const RECORDS = Object.freeze({
  RUN_OPENED: { fields: ['planDigest', 'drive', 'tasks', 'observation'], apply: openRun },
  CYCLE_OPENED: {
    fields: ['scope', 'cycle', 'predecessor', 'checks', 'bindings', 'rubricCriteria', 'review', 'observation'],
    apply: openCycle,
  },
  ITERATION_RESERVED: { fields: ['scope', 'cycle', 'iteration', 'iterationKind', 'reason'], apply: reserveIteration },
  DISPATCH_AUTHORIZED: {
    fields: ['scope', 'cycle', 'iteration', 'role', 'target', 'ownerTask', 'affectedCriteria', 'observation'],
    apply: authorizeDispatch,
  },
  RETRY_ADMITTED: { fields: ['scope', 'cycle', 'iteration', 'request', 'requestDigest'], apply: admitRetry },
  DIAGNOSIS_RECORDED: {
    fields: [
      'scope', 'cycle', 'iteration', 'valid', 'hypothesis', 'remedy', 'confirmingCheck', 'recommendation', 'artifact',
      'before', 'after',
    ],
    apply: recordDiagnosis,
  },
  ITERATION_INTERRUPTED: {
    fields: ['scope', 'cycle', 'iteration', 'reason', 'observation'],
    apply: interruptIteration,
  },
  CYCLE_STOPPED: { fields: ['scope', 'cycle', 'reason', 'note'], apply: stopCycleExplicitly },
  RUN_HALTED: { fields: ['reason', 'evidence', 'observation'], apply: haltRun },
  WRITER_RECORDED: {
    fields: [
      'scope', 'cycle', 'iteration', 'status', 'evidence', 'responseDigest', 'observation', 'candidate', 'changedPaths',
    ],
    apply: recordWriter,
  },
  CHECKS_RECORDED: { fields: ['scope', 'cycle', 'iteration', 'observation', 'checks'], apply: recordChecks },
  REVIEW_RECORDED: {
    fields: [
      'scope', 'cycle', 'iteration', 'role', 'ownerTask', 'status', 'defects', 'rubric', 'evidence', 'before', 'after',
    ],
    apply: recordReview,
  },
});

// --- public API -----------------------------------------------------------------------------------

export function createCorrectionState() {
  return produce({
    version: 1,
    records: 0,
    refs: [],
    run: null,
    halted: null,
    cycles: {},
    cycleOrder: [],
  });
}

export function applyCorrectionRecord(state, record, options) {
  assertState(state, 'applyCorrectionRecord');
  if (!isPlainObject(record)) throw new TypeError('applyCorrectionRecord: record must be a plain object');
  const { ref = null } = assertOptions(options, APPLY_OPTION_KEYS, 'applyCorrectionRecord');
  try {
    const identity = identityOf(record);
    if (state.halted !== null) refuse(REFUSAL.RUN_HALTED, 'the run is halted; no later record is accepted', identity);
    const { kind } = record;
    if (typeof kind !== 'string' || !Object.hasOwn(RECORDS, kind)) {
      refuse(REFUSAL.RECORD_SCHEMA, `unknown record kind ${JSON.stringify(kind)}`, identity);
    }
    schema(ref === null || (isJsonPlain(ref) && isDigestReference(ref)),
      'ref must be a JSON-plain { path, digest } with a single-line path and a lowercase 64-hex digest', identity);
    const { fields, apply } = RECORDS[kind];
    const payload = Object.keys(record).filter((key) => key !== 'kind');
    const missing = fields.filter((key) => !Object.hasOwn(record, key));
    const extra = payload.filter((key) => !fields.includes(key));
    const detail = [
      missing.length ? `missing: ${missing.join(', ')}` : '',
      extra.length ? `unknown: ${extra.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    schema(detail === '', `${kind} payload must have exactly the keys: ${fields.join(', ')}; ${detail}`, identity);
    schema(isJsonPlain(record), `${kind} must be JSON-plain: strings, finite numbers, booleans, null, `
      + 'and plain arrays or objects of the same', identity);
    if (kind === CORRECTION_RECORD_KINDS.RUN_OPENED) {
      if (state.records !== 0) refuse(REFUSAL.RECORD_ORDER, 'RUN_OPENED is allowed only as the first record', identity);
    } else if (state.run === null) {
      refuse(REFUSAL.RUN_NOT_OPEN, `${kind} requires an opened run`, identity);
    }
    const draft = structuredClone(state);
    apply(draft, record, { ref, identity });
    draft.records += 1;
    draft.refs.push(ref === null ? null : { path: ref.path, digest: ref.digest });
    return { ok: true, state: produce(draft) };
  } catch (error) {
    if (error instanceof Refusal) return failure(error);
    throw error;
  }
}

export function replayCorrectionRecords(records, options) {
  if (!Array.isArray(records)) throw new TypeError('replayCorrectionRecords: records must be an array');
  const { refs = null } = assertOptions(options, REPLAY_OPTION_KEYS, 'replayCorrectionRecords');
  if (refs !== null && (!Array.isArray(refs) || refs.length !== records.length)) {
    throw new TypeError('replayCorrectionRecords: refs must be an array the same length as records');
  }
  let state = createCorrectionState();
  for (const [index, record] of records.entries()) {
    const result = applyCorrectionRecord(state, record, refs === null ? undefined : { ref: refs[index] });
    if (!result.ok) return { ...result, identity: { ...result.identity, record: index + 1 } };
    state = result.state;
  }
  return { ok: true, state };
}

// The next step inside an unconcluded iteration: its first authorization, then the outcomes in order
// (the writer's, the checks, each authorized reviewer's), then the verdict reviewer's authorization. A
// final correction of an integration or design task first authorizes the task review of its owner
// task, which the final review requires.
function iterationStep(state, cycle, entry, step) {
  const dispatched = (role) => entry.dispatches.some((dispatch) => dispatch.role === role);
  if (entry.kind === 'diagnosis') {
    return { action: dispatched('diagnostic') ? 'record' : 'authorize', ...step, role: 'diagnostic' };
  }
  if (dispatched('writer') && entry.writer === null) return { action: 'record', ...step, role: 'writer' };
  if (entry.dispatches.length === 0 && entry.checks === null) {
    return { action: 'authorize', ...step, role: permittedRoles(cycle, entry)[0] };
  }
  if (entry.checks === null) return { action: 'checks', ...step };
  const owner = cycle.scope === 'final' && entry.kind === 'correction' ? correctionOwner(state, entry) : null;
  if (owner !== null && TASK_REVIEWED_COMPLEXITIES.has(owner.complexity) && !dispatched('task-reviewer')) {
    return { action: 'authorize', ...step, role: 'task-reviewer', ownerTask: owner.task };
  }
  const pending = ['task-reviewer', 'final-reviewer']
    .find((role) => dispatched(role) && !entry.reviews.some((review) => review.role === role));
  if (pending !== undefined) return { action: 'record', ...step, role: pending };
  return { action: 'authorize', ...step, role: verdictRole(cycle) };
}

// The step for the most recently opened cycle; null before any cycle exists.
export function nextCorrectionStep(state) {
  assertState(state, 'nextCorrectionStep');
  if (state.halted !== null) return { action: 'halted', reason: state.halted.reason };
  const key = state.cycleOrder.at(-1);
  if (key === undefined) return null;
  const cycle = state.cycles[key];
  const at = { scope: cycle.scope, cycle: cycle.cycle };
  if (cycle.status !== 'OPEN') return { action: 'stopped', ...at, reason: cycle.stopReason };
  const latest = cycle.iterations.at(-1);
  if (latest === undefined) return { action: 'reserve', ...at, iteration: 1, kind: 'initial' };
  if (latest.conclusion === null) return iterationStep(state, cycle, latest, { ...at, iteration: latest.iteration });
  const iteration = cycle.reserved + 1;
  if (cycle.retries.some((retry) => retry.iteration === iteration)) {
    return { action: 'reserve', ...at, iteration, kind: 'correction' };
  }
  if (cycle.diagnosisRequired) {
    return { action: 'reserve', ...at, iteration, kind: 'diagnosis', reason: 'comparison-unavailable' };
  }
  return { action: 'retry-or-diagnosis', ...at, iteration, diagnosisAvailable: !cycle.diagnosisUsed };
}

// The checks, bindings and review mode a cycle of `scope` must open with. A task scope takes its plan
// task; the final scope takes the delivered (approved) plan tasks. Returns fresh plain objects.
export function deriveCycleBindings(input) {
  if (!isPlainObject(input)) throw new TypeError('deriveCycleBindings: input must be a plain object');
  assertOptions(input, DERIVE_KEYS, 'deriveCycleBindings');
  const { scope, task = null, deliveredTasks = null, rubricCriteria = [], reviewOptIn = false } = input;
  const normalized = { scope, task, deliveredTasks, rubricCriteria, reviewOptIn };
  const problem = bindingInputProblem(normalized);
  if (problem !== null) throw new TypeError(`deriveCycleBindings: ${problem}`);
  return deriveBindings(normalized);
}

// Normalizes a reviewer's defect entries: `{ ok: true, defects }`, or a failure with a
// `CORRECTION_CODES.review` code for which the guard records the review as INVALID. `previous` is the
// defect list of the previous comparable outcome, or null when there is none. Called standalone, a
// rubric defect's `metric` is null: its dimension score lives in the rubric, and only REVIEW_RECORDED
// attaches it, so compare state outcomes rather than standalone results.
export function normalizeDefects(input) {
  if (!isPlainObject(input)) throw new TypeError('normalizeDefects: input must be a plain object');
  assertOptions(input, NORMALIZE_KEYS, 'normalizeDefects');
  const missing = NORMALIZE_KEYS.filter((key) => !Object.hasOwn(input, key));
  if (missing.length > 0) throw new TypeError(`normalizeDefects: missing ${missing.join(', ')}`);
  const { bindings, entries, previous } = input;
  assertBindings(bindings, 'normalizeDefects');
  if (previous !== null) assertDefects(previous, 'normalizeDefects', 'previous');
  const result = attempt(() => normalizeEntries(bindings, entries, previous ?? []));
  return result.ok ? { ok: true, defects: result.value } : result;
}

// Validates a reviewer's rubric: `{ ok: true, approved, criteria }`, or a failure with a
// `CORRECTION_CODES.review` code for which the guard records the review as INVALID. `defects` are the
// review's defects, normalized or the reviewer's own entries: untrusted data, so a non-array or a
// non-object entry is a DEFECT_SCHEMA failure, never a throw. `bindings` name the rubric criteria; for a
// final-scope task review pass `reviewRubricBindings(...)`, which keeps only the owner task's criteria.
// `TypeError` is thrown only for a malformed call (input shape, unknown or missing keys, bindings).
export function validateRubric(input) {
  if (!isPlainObject(input)) throw new TypeError('validateRubric: input must be a plain object');
  assertOptions(input, RUBRIC_KEYS, 'validateRubric');
  const missing = RUBRIC_KEYS.filter((key) => !Object.hasOwn(input, key));
  if (missing.length > 0) throw new TypeError(`validateRubric: missing ${missing.join(', ')}`);
  const { bindings, rubric, defects } = input;
  assertBindings(bindings, 'validateRubric');
  const result = attempt(() => {
    if (!Array.isArray(defects)) refuse(REVIEW_INVALID.DEFECT_SCHEMA, 'defects must be an array');
    const malformed = defects.findIndex((defect) => !isPlainObject(defect));
    if (malformed !== -1) {
      refuse(REVIEW_INVALID.DEFECT_SCHEMA, `defect ${malformed} must be an object`, { entry: malformed });
    }
    return checkRubric(bindings, rubric, defects);
  });
  if (!result.ok) return result;
  return { ok: true, approved: result.value.every((entry) => entry.approved), criteria: result.value };
}

// The rubric bindings a review of `role` scores in a cycle of `scope` with `bindings`: every rubric
// binding, except that a final-scope task review scores only its owner task's criteria. `ownerTask` is
// that plan task for a final-scope task review and null otherwise. Pass the result to `validateRubric`.
export function reviewRubricBindings(input) {
  if (!isPlainObject(input)) throw new TypeError('reviewRubricBindings: input must be a plain object');
  assertOptions(input, REVIEW_RUBRIC_KEYS, 'reviewRubricBindings');
  const missing = REVIEW_RUBRIC_KEYS.filter((key) => !Object.hasOwn(input, key));
  if (missing.length > 0) throw new TypeError(`reviewRubricBindings: missing ${missing.join(', ')}`);
  const { scope, bindings, role, ownerTask } = input;
  if (typeof scope !== 'string' || !SCOPE.test(scope)) {
    throw new TypeError("reviewRubricBindings: scope must be 'task-<N>' or 'final'");
  }
  if (scope === 'final' ? !REVIEWER_ROLES.has(role) : role !== 'task-reviewer') {
    throw new TypeError(`reviewRubricBindings: no ${String(role)} reviews scope '${scope}'`);
  }
  assertBindings(bindings, 'reviewRubricBindings');
  const ownerReview = scope === 'final' && role === 'task-reviewer';
  if (ownerReview ? !isPlanTask(ownerTask) : ownerTask !== null) {
    throw new TypeError('reviewRubricBindings: ownerTask must be the reviewed plan task for a final-scope task '
      + 'review, and null otherwise');
  }
  return rubricBindingsFor(bindings, ownerReview ? ownerTask : null);
}

// Compares a concluded correction outcome with the previous comparable outcome of its cycle (null when
// there is none). Each current defect whose id the previous outcome reports is improved (strictly
// better metric in its binding's direction; a command-check defect binding no criterion compares
// lower-is-better), stagnant, or unavailable (a missing metric or no direction); other ids are new. The verdict is 'none' without a previous outcome, else 'stagnant' when
// any defect stagnated, else 'unavailable' when any comparison was, else 'progress'. Outcomes are
// objects carrying a `defects` array of normalized defects, such as an iteration's state conclusion;
// a rubric defect taken from standalone `normalizeDefects` output has no metric and compares as
// unavailable. Known metrics are reported even when a result is unavailable.
export function compareOutcomes(previous, current, bindings) {
  const isOutcome = (value) => isPlainObject(value) && Array.isArray(value.defects);
  if (previous !== null && !isOutcome(previous)) {
    throw new TypeError('compareOutcomes: previous must be null or an outcome with a defects array');
  }
  if (!isOutcome(current)) throw new TypeError('compareOutcomes: current must be an outcome with a defects array');
  if (previous !== null) assertDefects(previous.defects, 'compareOutcomes', 'previous.defects');
  assertDefects(current.defects, 'compareOutcomes', 'current.defects');
  assertBindings(bindings, 'compareOutcomes');
  return compare(previous, current, bindings);
}

// Ranks a cycle's candidates, best first: the baseline (iteration 0, the opening observation) and every
// iteration with an accepted writer. A candidate is verified by the latest iteration whose checks
// verified it; evidence and approval are attributed only to the candidate that iteration verified,
// never to another candidate with the same digest. Order: verified first, then fewer blocking
// defects, more satisfied mandatory bindings, the lower command metric sum, the higher rubric total,
// and the earlier iteration.
export function rankCandidates(cycleState) {
  if (!PRODUCED_CYCLES.has(cycleState)) {
    throw new TypeError('rankCandidates: cycleState must be a cycle of a state this module produced');
  }
  const cycle = cycleState;
  const candidates = [
    { iteration: 0, observation: cycle.observation, candidate: null },
    ...cycle.iterations.filter((entry) => entry.writer?.accepted).map((entry) => ({
      iteration: entry.iteration, observation: entry.writer.observation, candidate: reference(entry.writer.candidate),
    })),
  ];
  const verifiers = new Map();
  for (const entry of cycle.iterations) {
    if (entry.checks !== null) verifiers.set(candidateOwner(cycle, entry)?.iteration ?? 0, entry);
  }
  return candidates.map((candidate) => {
    const verifier = verifiers.get(candidate.iteration);
    if (verifier === undefined) return { ...candidate, ...UNVERIFIED, approved: false };
    return { ...candidate, ...verificationScore(cycle, verifier), approved: verifier.conclusion?.approved === true };
  }).sort(compareCandidates);
}

export function validateRetryRequest(state, request) {
  assertState(state, 'validateRetryRequest');
  try {
    checkRetryRequest(state, request);
    return { ok: true };
  } catch (error) {
    if (error instanceof Refusal) return failure(error);
    throw error;
  }
}
