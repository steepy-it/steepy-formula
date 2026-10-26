// Pure correction state for Gear-3 evidence-driven correction.
//
// A correction run is a sequence of plain records `{ kind, ...payload }`. This module folds them into
// a deep-frozen state and refuses any record that would break the run's invariants: one bounded
// allowance of iterations per cycle, a single diagnosis slot charged to that allowance, retries
// admitted only with bound evidence, and dispatch roles authorized once per iteration.
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
// Evidence a tool-failure retry may bind to: an interrupted dispatch's own record.
const TOOL_FAILURE_SOURCES = new Set(['interruption']);
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

function produce(state) {
  deepFreeze(state);
  PRODUCED.add(state);
  return state;
}

function assertState(state, label) {
  if (!PRODUCED.has(state)) {
    throw new TypeError(`${label}: state must be produced by createCorrectionState or applyCorrectionRecord`);
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
  schema(Array.isArray(bindings) && bindings.length > 0
    && bindings.every((binding) => isPlainObject(binding) && typeof binding.criterion === 'string'
      && binding.criterion.length > 0),
  'bindings must be a non-empty array of objects naming a criterion', identity);
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
    reserved: 0,
    diagnosisUsed: false,
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
  if (iterationKind === 'diagnosis') {
    if (reason === null) refuse(REFUSAL.DIAGNOSIS_REASON, 'a diagnosis iteration requires a reason', identity);
    if (cycle.diagnosisUsed) refuse(REFUSAL.DIAGNOSIS_USED, 'this cycle already reserved its diagnosis', identity);
  } else if (reason !== null) {
    refuse(REFUSAL.DIAGNOSIS_REASON, `a ${iterationKind} iteration carries no diagnosis reason`, identity);
  }
  if (iterationKind === 'correction' && !cycle.retries.some((retry) => retry.iteration === iteration)) {
    refuse(REFUSAL.RETRY_REQUIRED, `a correction at iteration ${iteration} requires an admitted retry`, identity);
  }
  cycle.iterations.push({ iteration, kind: iterationKind, reason, dispatches: [], conclusion: null });
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
// affects; a final-scope task-reviewer names the task it reviews; every other dispatch names none.
function checkOwnership(draft, cycle, record, identity) {
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
  if (entry.kind === 'initial' && REVIEWER_ROLES.has(role) && permitted.includes('writer')
    && !dispatched.includes('writer')) {
    refuse(REFUSAL.ROLE_NOT_ALLOWED, `an initial iteration authorizes the writer before the ${role}`, identity);
  }
  checkOwnership(draft, cycle, record, identity);
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
    schema(ref === null || isDigestReference(ref),
      'ref must be { path, digest } with a single-line path and a lowercase 64-hex digest', identity);
    const { fields, apply } = RECORDS[kind];
    const payload = Object.keys(record).filter((key) => key !== 'kind');
    const missing = fields.filter((key) => !Object.hasOwn(record, key));
    const extra = payload.filter((key) => !fields.includes(key));
    const detail = [
      missing.length ? `missing: ${missing.join(', ')}` : '',
      extra.length ? `unknown: ${extra.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    schema(detail === '', `${kind} payload must have exactly the keys: ${fields.join(', ')}; ${detail}`, identity);
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
  if (latest.conclusion === null) {
    const step = { ...at, iteration: latest.iteration };
    if (latest.dispatches.length === 0) return { action: 'authorize', ...step, role: permittedRoles(cycle, latest)[0] };
    return { action: 'record', ...step, role: latest.dispatches.at(-1).role };
  }
  const iteration = cycle.reserved + 1;
  if (cycle.retries.some((retry) => retry.iteration === iteration)) {
    return { action: 'reserve', ...at, iteration, kind: 'correction' };
  }
  return { action: 'retry-or-diagnosis', ...at, iteration, diagnosisAvailable: !cycle.diagnosisUsed };
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
