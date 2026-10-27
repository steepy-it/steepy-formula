import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORRECTION_CODES,
  CORRECTION_RECORD_KINDS,
  ITERATION_ALLOWANCE,
  applyCorrectionRecord,
  compareOutcomes,
  createCorrectionState,
  decideIsolation,
  deriveCycleBindings,
  formatCorrectionSummaryBlock,
  nextCorrectionStep,
  normalizeDefects,
  parseCorrectionSummaryBlock,
  rankCandidates,
  replayCorrectionRecords,
  reviewRubricBindings,
  summarizeCorrectionRun,
  validateRetryRequest,
  validateRubric,
} from '../scripts/correction-state.mjs';

// The module under test is pure (no filesystem, no subprocess), so every test is hermetic without a
// temporary directory: records and refs are in-memory literals.

const { stop: STOP, halt: HALT, refusal: REFUSAL } = CORRECTION_CODES;
const hex = (character) => character.repeat(64);
const PLAN_DIGEST = hex('a');
const OBSERVATION = hex('b');

const REF_PATH = (n) => `.formula/work/tasks/2026-10-26-plan/correction/record-${n}.json`;
const ref = (n, character = 'c') => ({ path: REF_PATH(n), digest: hex(character) });

function plan() {
  return [
    { task: '1', dependencies: [], complexity: 'mechanical', criterionIds: ['SC1', 'SC2'], testCommand: 'npm test' },
    { task: '2', dependencies: ['1'], complexity: 'design', criterionIds: ['SC3'], testCommand: 'npm test' },
    { task: '4', dependencies: ['1', '2'], complexity: 'integration', criterionIds: [], testCommand: 'node --test x' },
  ];
}

function runOpened(overrides = {}) {
  return { kind: 'RUN_OPENED', planDigest: PLAN_DIGEST, drive: 'manual', tasks: plan(), observation: OBSERVATION, ...overrides };
}

function ok(result) {
  assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.message}`);
  assertFailuresCarryDefects(result.state);
  return result.state;
}

// Invariant over every accepted state: an iteration that concluded with a failed outcome carries at
// least one defect, so no failure lacks feedback and a repeat is comparable.
function assertFailuresCarryDefects(state) {
  for (const cycle of Object.values(state.cycles)) {
    for (const { iteration, conclusion } of cycle.iterations) {
      if (conclusion?.via === 'outcome' && !conclusion.approved) {
        assert.ok(conclusion.defects.length > 0,
          `${cycle.scope}#${cycle.cycle} iteration ${iteration} concluded failed without a defect`);
      }
    }
  }
}

function refused(result, code) {
  assert.equal(result.ok, false, 'expected a refusal');
  assert.equal(result.code, code, result.message);
  assert.equal(typeof result.message, 'string');
  assert.equal(typeof result.identity, 'object');
  return result;
}

function apply(state, record, options) {
  return ok(applyCorrectionRecord(state, record, options));
}

function opened() {
  return apply(createCorrectionState(), runOpened());
}

function isDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeepFrozen);
}

test('vocabulary: allowance, deep-frozen codes and frozen record kinds', () => {
  assert.equal(ITERATION_ALLOWANCE, 3);
  assert.ok(isDeepFrozen(CORRECTION_CODES));
  assert.deepEqual(Object.keys(CORRECTION_CODES).sort(), ['halt', 'refusal', 'review', 'stop']);
  for (const code of ['APPROVED', 'EXHAUSTED', 'STAGNATED', 'COMPARISON_UNAVAILABLE', 'DIAGNOSIS_INCONCLUSIVE',
    'RETRY_EVIDENCE_MISSING', 'HUMAN_INTERRUPTED']) {
    assert.equal(STOP[code], code);
  }
  assert.equal(HALT.INTEGRITY, 'INTEGRITY');
  for (const code of ['RECORD_SCHEMA', 'RECORD_ORDER', 'RUN_NOT_OPEN', 'RUN_HALTED', 'CYCLE_NOT_OPEN',
    'CYCLE_TERMINAL', 'SCOPE_NOT_RUNNABLE', 'ALLOWANCE_EXHAUSTED', 'DIAGNOSIS_USED', 'DIAGNOSIS_REASON',
    'RETRY_REQUIRED', 'RETRY_INVALID', 'RETRY_REPEATED', 'RETRY_STATUS_ONLY', 'RETRY_EVIDENCE_UNBOUND',
    'ROLE_NOT_ALLOWED', 'ROLE_ALREADY_DISPATCHED', 'OUTCOME_ORDER', 'REOPEN_INVALID', 'FINAL_BYPASS',
    'ISOLATION_REQUIRED']) {
    assert.equal(REFUSAL[code], code);
  }
  assert.ok(Object.isFrozen(CORRECTION_RECORD_KINDS));
  assert.deepEqual(Object.keys(CORRECTION_RECORD_KINDS).sort(), [
    'CHECKS_RECORDED', 'CYCLE_OPENED', 'CYCLE_STOPPED', 'DIAGNOSIS_RECORDED', 'DISPATCH_AUTHORIZED',
    'ISOLATION_RECORDED', 'ITERATION_INTERRUPTED', 'ITERATION_RESERVED', 'REOPEN_AUTHORIZED', 'RETRY_ADMITTED',
    'REVIEW_RECORDED', 'RUN_HALTED', 'RUN_OPENED', 'WRITER_RECORDED',
  ]);
  for (const [name, value] of Object.entries(CORRECTION_RECORD_KINDS)) assert.equal(value, name);
  assert.throws(() => { CORRECTION_CODES.stop.EXHAUSTED = 'X'; }, TypeError);
  assert.throws(() => { CORRECTION_CODES.refusal.NEW = 'NEW'; }, TypeError);
});

test('createCorrectionState returns a deep-frozen empty state with no next step', () => {
  const state = createCorrectionState();
  assert.ok(isDeepFrozen(state));
  assert.equal(state.run, null);
  assert.equal(state.halted, null);
  assert.equal(state.records, 0);
  assert.deepEqual(state.cycles, {});
  assert.equal(nextCorrectionStep(state), null);
});

test('programmer errors throw TypeError: foreign state, non-plain record, unknown option keys', () => {
  const state = createCorrectionState();
  const record = { kind: 'RUN_OPENED', planDigest: PLAN_DIGEST, drive: 'manual', tasks: [], observation: OBSERVATION };
  for (const foreign of [null, undefined, {}, { ...state }, structuredClone(state)]) {
    assert.throws(() => applyCorrectionRecord(foreign, record), TypeError);
    assert.throws(() => nextCorrectionStep(foreign), TypeError);
    assert.throws(() => validateRetryRequest(foreign, {}), TypeError);
  }
  for (const bad of [null, undefined, 'RUN_OPENED', 7, [], new Map(), new (class Record {})()]) {
    assert.throws(() => applyCorrectionRecord(state, bad), TypeError);
  }
  assert.throws(() => applyCorrectionRecord(state, record, { refs: [] }), /accepted keys: ref/u);
  assert.throws(() => applyCorrectionRecord(state, record, 'ref'), TypeError);
  assert.throws(() => replayCorrectionRecords('records'), TypeError);
  assert.throws(() => replayCorrectionRecords([record], { ref: null }), /accepted keys: refs/u);
  assert.throws(() => replayCorrectionRecords([record], { refs: [] }), TypeError);
  assert.throws(() => replayCorrectionRecords([record], { refs: 'x' }), TypeError);
});

test('an unknown record kind is refused with RECORD_SCHEMA, never thrown', () => {
  const state = createCorrectionState();
  for (const record of [{ kind: 'RUN_STARTED' }, {}, { kind: 7 }, { kind: 'toString' }]) {
    const result = applyCorrectionRecord(state, record);
    assert.equal(result.ok, false);
    assert.equal(result.code, REFUSAL.RECORD_SCHEMA);
    assert.equal(typeof result.message, 'string');
    assert.equal(typeof result.identity, 'object');
  }
});

const commandBinding = (criterion, check, metric = 'failed-assertions') => ({
  criterion, check, kind: 'command', metric, direction: 'lower', threshold: 0,
});
const gateBinding = (criterion) => commandBinding(criterion, 'coherence-gate', 'violations');
const reviewBinding = (criterion) => ({
  criterion, check: 'review', kind: 'review', metric: 'severity', direction: 'lower', threshold: 0,
});
const rubricBinding = (criterion) => ({
  criterion, check: 'rubric', kind: 'rubric', metric: 'rubric-score', direction: 'higher', threshold: 8,
});
const GATE_CHECK = Object.freeze({ id: 'coherence-gate', command: 'builtin' });

// The openings deriveCycleBindings yields for the plan above: task 1 (mechanical) opts in to review
// with a rubric on SC1, and the final cycle opens on tasks 1 and 2 delivered (task 4 stopped; see
// `ready`).
function opening(scope) {
  const surfaceTest = (command) => ({ id: 'surface-test', command });
  switch (scope) {
    case 'task-2':
      return {
        checks: [surfaceTest('npm test'), { ...GATE_CHECK }],
        bindings: [commandBinding('SC3', 'surface-test'), gateBinding('SC3'), reviewBinding('SC3')],
        rubricCriteria: [],
        review: 'required',
      };
    case 'task-4':
      return {
        checks: [surfaceTest('node --test x'), { ...GATE_CHECK }], bindings: [], rubricCriteria: [], review: 'required',
      };
    case 'final':
      return {
        checks: [{ id: 'surface-test-1', command: 'npm test' }, { ...GATE_CHECK }],
        bindings: ['SC1', 'SC2', 'SC3'].flatMap((criterion) => [
          commandBinding(criterion, 'surface-test-1'), gateBinding(criterion), reviewBinding(criterion),
        ]),
        rubricCriteria: [],
        review: 'required',
      };
    default:
      return {
        checks: [surfaceTest('npm test'), { ...GATE_CHECK }],
        bindings: [commandBinding('SC1', 'surface-test'), gateBinding('SC1'), reviewBinding('SC1'), rubricBinding('SC1'),
          commandBinding('SC2', 'surface-test'), gateBinding('SC2'), reviewBinding('SC2')],
        rubricCriteria: ['SC1'],
        review: 'required',
      };
  }
}

function cycleOpened(scope = 'task-1', overrides = {}) {
  return {
    kind: 'CYCLE_OPENED', scope, cycle: 1, predecessor: null, ...opening(scope), observation: OBSERVATION, ...overrides,
  };
}

// Task 1 opened without review: it approves on its passed checks.
const SKIPPED_TASK_ONE = Object.freeze({
  bindings: [commandBinding('SC1', 'surface-test'), gateBinding('SC1'), commandBinding('SC2', 'surface-test'),
    gateBinding('SC2')],
  rubricCriteria: [],
  review: 'skipped',
});
const FINAL_CHECK_IDS = ['surface-test-1', 'coherence-gate'];

function isolationRecorded(scope = 'task-1', cycle = 1, mode = 'baseline-equal', observation = OBSERVATION) {
  return { kind: 'ISOLATION_RECORDED', scope, cycle, mode, observation };
}

const REOPEN_REMEDY = 'split the reservation guard from the dispatch guard before retrying';

// A human authorization to reopen `scope` at `cycle`, linked to its previous cycle.
function reopenAuthorized(scope = 'task-1', cycle = 2, overrides = {}) {
  const named = scope === 'final' ? 'the final review' : `Task ${scope.slice('task-'.length)}`;
  return {
    kind: 'REOPEN_AUTHORIZED', scope, cycle, predecessor: `${scope}#${cycle - 1}`,
    authorization: { path: `.formula/work/tasks/2026-10-26-plan/correction/reopen-${scope}-${cycle}.json`, digest: hex('4') },
    statement: `Reopen ${named}: ${REOPEN_REMEDY}.`, remedy: REOPEN_REMEDY, ...overrides,
  };
}

// Legal paths to each scope's opening. Scopes open one at a time, in plan order, once their
// prerequisites are approved: task 2 needs task 1, task 4 needs tasks 1 and 2, and the final needs every
// task concluded. Task 4 stops here and its isolation is proven, so the final opens on tasks 1 and 2.
function approvedOne() {
  return chain(opened(), [
    cycleOpened('task-1', SKIPPED_TASK_ONE), reserved(1, 'initial'), authorized(1, 'writer'), writerRecorded(1),
    checksRecorded(1),
  ]);
}

function approvedTwo() {
  return chain(approvedOne(), [
    cycleOpened('task-2'), reserved(1, 'initial', null, 'task-2'), authorized(1, 'writer', {}, 'task-2'),
    writerRecorded(1, 'DONE', {}, 'task-2'), checksRecorded(1, {}, {}, 'task-2'),
    authorized(1, 'task-reviewer', {}, 'task-2'), reviewRecorded(1, 'APPROVED', {}, 'task-reviewer', 'task-2'),
  ]);
}

function taskFourStopped() {
  return chain(approvedTwo(), [
    cycleOpened('task-4'), stopped(STOP.HUMAN_INTERRUPTED, 'task-4'), isolationRecorded('task-4'),
  ]);
}

function ready(scope = 'task-1') {
  return { 'task-1': opened, 'task-2': approvedOne, 'task-4': approvedTwo, final: taskFourStopped }[scope]();
}

test('RUN_OPENED opens the run once, as the first record, and keeps the plan', () => {
  const state = opened();
  assert.ok(isDeepFrozen(state));
  assert.equal(state.records, 1);
  assert.equal(state.run.planDigest, PLAN_DIGEST);
  assert.equal(state.run.drive, 'manual');
  assert.deepEqual(state.run.tasks, plan());
  // The run's first step opens the first runnable task.
  assert.deepEqual(nextCorrectionStep(state), { action: 'open-cycle', scope: 'task-1' });
  const autopilot = apply(createCorrectionState(), runOpened({ drive: 'autopilot' }));
  assert.equal(autopilot.run.drive, 'autopilot');

  const second = refused(applyCorrectionRecord(state, runOpened()), REFUSAL.RECORD_ORDER);
  assert.equal(second.identity.kind, 'RUN_OPENED');
});

test('RUN_OPENED refuses missing, extra and malformed payload values with RECORD_SCHEMA', () => {
  const empty = createCorrectionState();
  const { planDigest: _omitted, ...missing } = runOpened();
  refused(applyCorrectionRecord(empty, missing), REFUSAL.RECORD_SCHEMA);
  refused(applyCorrectionRecord(empty, runOpened({ extra: true })), REFUSAL.RECORD_SCHEMA);
  const task = (overrides) => ({ ...plan()[0], ...overrides });
  const malformed = [
    { planDigest: hex('A') },
    { planDigest: 'a'.repeat(63) },
    { drive: 'auto' },
    { observation: null },
    { tasks: [] },
    { tasks: 'all' },
    { tasks: [task({ task: '0' })] },
    { tasks: [task({ task: '01' })] },
    { tasks: [task({ task: 1 })] },
    { tasks: [task({ task: '2' }), task({ task: '1' })] },
    { tasks: [task({ task: '1' }), task({ task: '1' })] },
    { tasks: [task({ dependencies: ['1'] })] },
    { tasks: [task({}), task({ task: '2', dependencies: ['3'] })] },
    { tasks: [task({}), task({ task: '2' }), task({ task: '3', dependencies: ['2', '1'] })] },
    { tasks: [task({}), task({ task: '2', dependencies: ['1', '1'] })] },
    { tasks: [task({ complexity: 'hard' })] },
    { tasks: [task({ criterionIds: ['SC0'] })] },
    { tasks: [task({ criterionIds: ['sc1'] })] },
    { tasks: [task({ criterionIds: ['SC1', 'SC1'] })] },
    { tasks: [task({ criterionIds: 'SC1' })] },
    { tasks: [task({ testCommand: '' })] },
    { tasks: [task({ testCommand: 'npm test\nrm -rf /' })] },
    { tasks: [task({ testCommand: ' npm test' })] },
    { tasks: [{ ...task({}), surface: 'scripts' }] },
    { tasks: [(({ complexity: _c, ...rest }) => rest)(task({}))] },
    { tasks: ['1'] },
  ];
  for (const overrides of malformed) {
    const result = refused(applyCorrectionRecord(empty, runOpened(overrides)), REFUSAL.RECORD_SCHEMA);
    assert.doesNotMatch(result.message, /unknown record kind/u, JSON.stringify(overrides));
  }
});

test('records carry no time, token or spending fields: such keys are refused and no name uses them', () => {
  const empty = createCorrectionState();
  for (const key of ['deadline', 'timeoutMs', 'tokens', 'cost', 'timestamp', 'elapsedMs', 'currency']) {
    const result = refused(applyCorrectionRecord(empty, runOpened({ [key]: 1 })), REFUSAL.RECORD_SCHEMA);
    assert.match(result.message, new RegExp(key, 'u'));
  }
  const forbidden = /deadline|timeout|elapsed|token|cost|currency/iu;
  const names = [
    ...Object.values(CORRECTION_CODES).flatMap((group) => Object.keys(group)),
    ...Object.keys(CORRECTION_RECORD_KINDS),
    'ref', 'refs',
  ];
  for (const name of names) assert.doesNotMatch(name, forbidden);
});

test('a ref names the record file: it is kept in state, and a malformed ref is refused', () => {
  const state = ok(applyCorrectionRecord(createCorrectionState(), runOpened(), { ref: ref(1) }));
  assert.deepEqual(state.refs, [ref(1)]);
  assert.deepEqual(opened().refs, [null]);
  for (const bad of [
    'record-1.json', {}, { path: REF_PATH(1) }, { path: REF_PATH(1), digest: hex('C') },
    { path: '', digest: hex('c') }, { path: 'a\nb', digest: hex('c') }, { ...ref(1), extra: 1 }, [REF_PATH(1)],
  ]) {
    refused(applyCorrectionRecord(createCorrectionState(), runOpened(), { ref: bad }), REFUSAL.RECORD_SCHEMA);
  }
});

test('CYCLE_OPENED opens cycle 1 of a runnable scope and the next step reserves the initial iteration', () => {
  refused(applyCorrectionRecord(createCorrectionState(), cycleOpened()), REFUSAL.RUN_NOT_OPEN);
  const state = apply(opened(), cycleOpened());
  const cycle = state.cycles['task-1#1'];
  assert.equal(cycle.status, 'OPEN');
  assert.equal(cycle.stopReason, null);
  assert.equal(cycle.reserved, 0);
  assert.equal(cycle.diagnosisUsed, false);
  assert.deepEqual(cycle.admittedRemedies, []);
  assert.equal(cycle.nextRemedy, null);
  assert.deepEqual(cycle.checks, cycleOpened().checks);
  assert.deepEqual(cycle.bindings, cycleOpened().bindings);
  assert.deepEqual(state.cycleOrder, ['task-1#1']);
  assert.deepEqual(nextCorrectionStep(state),
    { action: 'reserve', scope: 'task-1', cycle: 1, iteration: 1, kind: 'initial' });

  // One cycle is open at a time, and a task opens only once its prerequisites are approved.
  refused(applyCorrectionRecord(state, cycleOpened('final')), REFUSAL.SCOPE_NOT_RUNNABLE);
  refused(applyCorrectionRecord(opened(), cycleOpened('task-4')), REFUSAL.SCOPE_NOT_RUNNABLE);
  const final = cycleState('final');
  assert.deepEqual(final.cycleOrder, ['task-1#1', 'task-2#1', 'task-4#1', 'final#1']);
  assert.deepEqual(nextCorrectionStep(final),
    { action: 'reserve', scope: 'final', cycle: 1, iteration: 1, kind: 'initial' });
});

test('CYCLE_OPENED refuses unrunnable scopes, reopening and malformed payloads', () => {
  const state = apply(opened(), cycleOpened());
  for (const scope of ['task-3', 'task-9']) {
    const result = refused(applyCorrectionRecord(opened(), cycleOpened(scope)), REFUSAL.SCOPE_NOT_RUNNABLE);
    assert.equal(result.identity.scope, scope);
    assert.equal(result.identity.cycle, 1);
  }
  refused(applyCorrectionRecord(state, cycleOpened()), REFUSAL.SCOPE_NOT_RUNNABLE);
  refused(applyCorrectionRecord(cycleState('final'), cycleOpened('final')), REFUSAL.REOPEN_INVALID);
  refused(applyCorrectionRecord(opened(), cycleOpened('task-2', { cycle: 2 })), REFUSAL.REOPEN_INVALID);
  refused(applyCorrectionRecord(opened(), cycleOpened('task-2', { predecessor: 'task-2#1' })), REFUSAL.REOPEN_INVALID);
  refused(applyCorrectionRecord(opened(), cycleOpened('final', { cycle: 2, predecessor: 'final#1' })),
    REFUSAL.REOPEN_INVALID);

  const check = { id: 'check-1', command: 'npm test' };
  const malformed = [
    { scope: 'task-0' }, { scope: 'Task-1' }, { scope: 'task' }, { scope: 'final-1' }, { scope: 1 },
    { cycle: 0 }, { cycle: '1' }, { cycle: 1.5 },
    { predecessor: 'task-1' }, { predecessor: 'x#1' }, { predecessor: 'task-1#0' }, { predecessor: '' },
    { checks: 'npm test' }, { checks: [{ id: 'check-1' }] }, { checks: [{ ...check, extra: 1 }] },
    { checks: [check, check] }, { checks: [{ id: 'a\nb', command: 'x' }] }, { checks: [{ id: 'a', command: '' }] },
    { bindings: [] }, { bindings: 'SC1' }, { bindings: ['SC1'] }, { bindings: [{ check: 'check-1' }] },
    { bindings: [{ criterion: '' }] }, { bindings: [{ criterion: 1 }] },
    { rubricCriteria: 'SC1' }, { rubricCriteria: [''] },
    { review: 'maybe' }, { observation: 'b' },
  ];
  for (const overrides of malformed) {
    const result = refused(applyCorrectionRecord(opened(), cycleOpened('task-1', overrides)), REFUSAL.RECORD_SCHEMA);
    assert.doesNotMatch(result.message, /unknown record kind/u, JSON.stringify(overrides));
  }
  for (const key of ['deadline', 'timeoutMs', 'tokens', 'cost']) {
    const result = refused(applyCorrectionRecord(opened(), cycleOpened('task-1', { [key]: 1 })), REFUSAL.RECORD_SCHEMA);
    assert.match(result.message, new RegExp(key, 'u'));
  }
  apply(opened(), cycleOpened('task-1', {
    bindings: [commandBinding('SC1', 'surface-test'), gateBinding('SC1'), commandBinding('SC2', 'surface-test'),
      gateBinding('SC2')],
    rubricCriteria: [],
    review: 'skipped',
  }));
});

function reserved(iteration, iterationKind, reason = null, scope = 'task-1', cycle = 1) {
  return { kind: 'ITERATION_RESERVED', scope, cycle, iteration, iterationKind, reason };
}

function interrupted(iteration, scope = 'task-1', cycle = 1, overrides = {}) {
  return {
    kind: 'ITERATION_INTERRUPTED', scope, cycle, iteration, reason: 'writer session lost', observation: OBSERVATION,
    ...overrides,
  };
}

// Applies each step in order; a step is a record or a [record, options] pair.
function chain(state, steps) {
  return steps.reduce((current, step) => (Array.isArray(step) ? apply(current, ...step) : apply(current, step)), state);
}

function cycleState(scope = 'task-1') {
  return apply(ready(scope), cycleOpened(scope));
}

test('reservation is monotonic: iteration 1 must be initial, and initial is allowed only at iteration 1', () => {
  const state = cycleState();
  for (const iterationKind of ['correction', 'diagnosis']) {
    const result = refused(applyCorrectionRecord(state, reserved(1, iterationKind, 'missing-retry-evidence')),
      REFUSAL.RECORD_ORDER);
    assert.deepEqual(result.identity, { kind: 'ITERATION_RESERVED', scope: 'task-1', cycle: 1, iteration: 1 });
  }
  refused(applyCorrectionRecord(state, reserved(2, 'initial')), REFUSAL.ALLOWANCE_EXHAUSTED);
  refused(applyCorrectionRecord(state, reserved(0, 'initial')), REFUSAL.RECORD_SCHEMA);
  const first = apply(state, reserved(1, 'initial'));
  assert.equal(first.cycles['task-1#1'].reserved, 1);
  refused(applyCorrectionRecord(first, reserved(1, 'initial')), REFUSAL.ALLOWANCE_EXHAUSTED);
  refused(applyCorrectionRecord(first, reserved(3, 'diagnosis', 'comparison-unavailable')), REFUSAL.ALLOWANCE_EXHAUSTED);
  refused(applyCorrectionRecord(first, reserved(2, 'diagnosis', 'comparison-unavailable')), REFUSAL.OUTCOME_ORDER);
  const concluded = apply(first, interrupted(1));
  refused(applyCorrectionRecord(concluded, reserved(2, 'initial')), REFUSAL.RECORD_ORDER);

  refused(applyCorrectionRecord(state, reserved(1, 'initial', 'missing-retry-evidence')), REFUSAL.DIAGNOSIS_REASON);
  for (const record of [reserved(1, 'first'), reserved(1, 'initial', 'because'), reserved('1', 'initial'),
    { ...reserved(1, 'initial'), kind: 'ITERATION_RESERVED', extra: 1 }]) {
    refused(applyCorrectionRecord(state, record), REFUSAL.RECORD_SCHEMA);
  }
  refused(applyCorrectionRecord(state, reserved(1, 'initial', null, 'task-2')), REFUSAL.CYCLE_NOT_OPEN);
  refused(applyCorrectionRecord(state, reserved(1, 'initial', null, 'task-1', 2)), REFUSAL.CYCLE_NOT_OPEN);
});

test('an interruption spends the slot: the next reservation is iteration 2', () => {
  const first = apply(cycleState(), reserved(1, 'initial'));
  const state = apply(first, interrupted(1));
  const cycle = state.cycles['task-1#1'];
  assert.equal(cycle.reserved, 1);
  assert.equal(cycle.status, 'OPEN');
  assert.equal(cycle.iterations[0].conclusion.via, 'interrupted');
  assert.deepEqual(nextCorrectionStep(state),
    { action: 'retry-or-diagnosis', scope: 'task-1', cycle: 1, iteration: 2, diagnosisAvailable: true });
  refused(applyCorrectionRecord(state, reserved(1, 'initial')), REFUSAL.ALLOWANCE_EXHAUSTED);
  const second = apply(state, reserved(2, 'diagnosis', 'missing-retry-evidence'));
  assert.equal(second.cycles['task-1#1'].reserved, 2);
  assert.equal(second.cycles['task-1#1'].diagnosisUsed, true);

  refused(applyCorrectionRecord(state, interrupted(1)), REFUSAL.OUTCOME_ORDER);
  refused(applyCorrectionRecord(first, interrupted(2)), REFUSAL.OUTCOME_ORDER);
  refused(applyCorrectionRecord(cycleState(), interrupted(1)), REFUSAL.OUTCOME_ORDER);
  refused(applyCorrectionRecord(first, interrupted(1, 'final')), REFUSAL.CYCLE_NOT_OPEN);
  for (const overrides of [{ reason: '' }, { reason: '   ' }, { reason: 7 }, { observation: 'x' }, { iteration: 0 }]) {
    refused(applyCorrectionRecord(first, interrupted(1, 'task-1', 1, overrides)), REFUSAL.RECORD_SCHEMA);
  }
});

test('an interruption applied with a ref records it as the evidence reference; without a ref it records none', () => {
  const first = apply(cycleState(), reserved(1, 'initial'));
  const withRef = apply(first, interrupted(1), { ref: ref(4) });
  assert.deepEqual(withRef.cycles['task-1#1'].iterations[0].conclusion.evidence,
    [{ path: REF_PATH(4), digest: hex('c'), source: 'interruption' }]);
  assert.deepEqual(withRef.refs.at(-1), ref(4));
  const withoutRef = apply(first, interrupted(1));
  assert.deepEqual(withoutRef.cycles['task-1#1'].iterations[0].conclusion.evidence, []);
});

test('the diagnosis slot: a reason is required and only one diagnosis per cycle is reserved', () => {
  const afterFirst = chain(cycleState(), [reserved(1, 'initial'), interrupted(1)]);
  const result = refused(applyCorrectionRecord(afterFirst, reserved(2, 'diagnosis')), REFUSAL.DIAGNOSIS_REASON);
  assert.equal(result.identity.iteration, 2);
  const afterDiagnosis = chain(afterFirst, [reserved(2, 'diagnosis', 'comparison-unavailable'), interrupted(2)]);
  assert.deepEqual(nextCorrectionStep(afterDiagnosis),
    { action: 'retry-or-diagnosis', scope: 'task-1', cycle: 1, iteration: 3, diagnosisAvailable: false });
  refused(applyCorrectionRecord(afterDiagnosis, reserved(3, 'diagnosis', 'missing-retry-evidence')),
    REFUSAL.DIAGNOSIS_USED);
  refused(applyCorrectionRecord(afterDiagnosis, reserved(3, 'correction')), REFUSAL.RETRY_REQUIRED);
  refused(applyCorrectionRecord(afterFirst, reserved(2, 'correction')), REFUSAL.RETRY_REQUIRED);
  refused(applyCorrectionRecord(afterFirst, reserved(2, 'correction', 'missing-retry-evidence')),
    REFUSAL.DIAGNOSIS_REASON);
});

function authorized(iteration, role, overrides = {}, scope = 'task-1', cycle = 1) {
  return {
    kind: 'DISPATCH_AUTHORIZED', scope, cycle, iteration, role, target: 'scripts/correction-state.mjs',
    ownerTask: null, affectedCriteria: [], observation: OBSERVATION, ...overrides,
  };
}

test('task-scope initial iteration: one writer, then one task-reviewer, each once', () => {
  const state = apply(cycleState(), reserved(1, 'initial'));
  assert.deepEqual(nextCorrectionStep(state),
    { action: 'authorize', scope: 'task-1', cycle: 1, iteration: 1, role: 'writer' });
  for (const role of ['task-reviewer', 'final-reviewer', 'diagnostic']) {
    const result = refused(applyCorrectionRecord(state, authorized(1, role)), REFUSAL.ROLE_NOT_ALLOWED);
    assert.deepEqual(result.identity, { kind: 'DISPATCH_AUTHORIZED', scope: 'task-1', cycle: 1, iteration: 1 });
  }
  const writer = apply(state, authorized(1, 'writer'));
  assert.deepEqual(nextCorrectionStep(writer),
    { action: 'record', scope: 'task-1', cycle: 1, iteration: 1, role: 'writer' });
  refused(applyCorrectionRecord(writer, authorized(1, 'writer')), REFUSAL.ROLE_ALREADY_DISPATCHED);
  const reviewer = apply(writer, authorized(1, 'task-reviewer'));
  // The writer's outcome is recorded before the reviewer's.
  assert.deepEqual(nextCorrectionStep(reviewer),
    { action: 'record', scope: 'task-1', cycle: 1, iteration: 1, role: 'writer' });
  refused(applyCorrectionRecord(reviewer, authorized(1, 'task-reviewer')), REFUSAL.ROLE_ALREADY_DISPATCHED);
  refused(applyCorrectionRecord(reviewer, authorized(1, 'writer')), REFUSAL.ROLE_ALREADY_DISPATCHED);
  assert.deepEqual(reviewer.cycles['task-1#1'].iterations[0].dispatches.map((dispatch) => dispatch.role),
    ['writer', 'task-reviewer']);
});

test('final-scope initial iteration authorizes one final-reviewer only', () => {
  const state = apply(cycleState('final'), reserved(1, 'initial', null, 'final'));
  assert.deepEqual(nextCorrectionStep(state),
    { action: 'authorize', scope: 'final', cycle: 1, iteration: 1, role: 'final-reviewer' });
  for (const [role, overrides] of [['writer', { ownerTask: '1', affectedCriteria: ['SC1'] }],
    ['task-reviewer', { ownerTask: '1' }], ['diagnostic', {}]]) {
    refused(applyCorrectionRecord(state, authorized(1, role, overrides, 'final')), REFUSAL.ROLE_NOT_ALLOWED);
  }
  const reviewer = apply(state, authorized(1, 'final-reviewer', {}, 'final'));
  refused(applyCorrectionRecord(reviewer, authorized(1, 'final-reviewer', {}, 'final')),
    REFUSAL.ROLE_ALREADY_DISPATCHED);
  refused(applyCorrectionRecord(state, authorized(1, 'final-reviewer', { ownerTask: '1' }, 'final')),
    REFUSAL.ROLE_NOT_ALLOWED);
});

test('a diagnosis iteration authorizes one diagnostic only', () => {
  const state = chain(cycleState(), [
    reserved(1, 'initial'), interrupted(1), reserved(2, 'diagnosis', 'missing-retry-evidence'),
  ]);
  assert.deepEqual(nextCorrectionStep(state),
    { action: 'authorize', scope: 'task-1', cycle: 1, iteration: 2, role: 'diagnostic' });
  for (const role of ['writer', 'task-reviewer', 'final-reviewer']) {
    refused(applyCorrectionRecord(state, authorized(2, role)), REFUSAL.ROLE_NOT_ALLOWED);
  }
  const diagnostic = apply(state, authorized(2, 'diagnostic'));
  assert.deepEqual(nextCorrectionStep(diagnostic),
    { action: 'record', scope: 'task-1', cycle: 1, iteration: 2, role: 'diagnostic' });
  refused(applyCorrectionRecord(diagnostic, authorized(2, 'diagnostic')), REFUSAL.ROLE_ALREADY_DISPATCHED);
});

test('non-final authorizations carry no owner or affected criteria; dispatch order and schema hold', () => {
  const state = apply(cycleState(), reserved(1, 'initial'));
  refused(applyCorrectionRecord(state, authorized(1, 'writer', { ownerTask: '1' })), REFUSAL.ROLE_NOT_ALLOWED);
  refused(applyCorrectionRecord(state, authorized(1, 'writer', { affectedCriteria: ['SC1'] })), REFUSAL.ROLE_NOT_ALLOWED);
  refused(applyCorrectionRecord(state, authorized(2, 'writer')), REFUSAL.OUTCOME_ORDER);
  refused(applyCorrectionRecord(cycleState(), authorized(1, 'writer')), REFUSAL.OUTCOME_ORDER);
  refused(applyCorrectionRecord(apply(state, interrupted(1)), authorized(1, 'writer')), REFUSAL.OUTCOME_ORDER);
  refused(applyCorrectionRecord(state, authorized(1, 'writer', {}, 'task-2')), REFUSAL.CYCLE_NOT_OPEN);
  for (const overrides of [{ role: 'admin' }, { target: '' }, { target: 'a\nb' }, { ownerTask: 'x' },
    { ownerTask: 1 }, { affectedCriteria: 'SC1' }, { affectedCriteria: ['SC1', 'SC1'] }, { affectedCriteria: ['x'] },
    { observation: hex('Z') }]) {
    const result = refused(applyCorrectionRecord(state, authorized(1, 'writer', overrides)), REFUSAL.RECORD_SCHEMA);
    assert.doesNotMatch(result.message, /unknown record kind/u);
  }
  apply(state, authorized(1, 'writer', { target: 'receipt:task-1/' }));
});

function retryRequest(overrides = {}) {
  return {
    version: 1,
    scope: 'task-1',
    cycle: 1,
    iteration: 2,
    kind: 'defect',
    target: 'SC1',
    observedFailure: 'surface-test fails: the fourth reservation was accepted',
    evidence: ref(5),
    hypothesis: 'the allowance compares against the concluded count, not the reserved count',
    remedy: 'compare the requested iteration with the reserved count plus one',
    difference: 'the first attempt only bounded the concluded iterations',
    confirmingCheck: 'surface-test',
    ...overrides,
  };
}

// A final retry names the coherence gate, which every final cycle checks.
function finalRetryRequest(overrides = {}) {
  return retryRequest({ scope: 'final', target: 'coherence-gate', confirmingCheck: 'coherence-gate', ...overrides });
}

function admitted(request, overrides = {}) {
  const { scope, cycle, iteration } = request;
  return { kind: 'RETRY_ADMITTED', scope, cycle, iteration, request, requestDigest: hex('d'), ...overrides };
}

// Iteration 1 dispatched a writer and was interrupted; the interruption is bound as record 5.
function awaitingRetry(scope = 'task-1', initialRole = 'writer') {
  return chain(cycleState(scope), [
    reserved(1, 'initial', null, scope),
    authorized(1, initialRole, {}, scope),
    [interrupted(1, scope), { ref: ref(5) }],
  ]);
}

function retryRefusal(state, overrides, code) {
  return refused(validateRetryRequest(state, retryRequest(overrides)), code);
}

test('a correction requires an admitted retry, which permits exactly that correction iteration', () => {
  const state = awaitingRetry();
  assert.deepEqual(validateRetryRequest(state, retryRequest()), { ok: true });
  refused(applyCorrectionRecord(state, reserved(2, 'correction')), REFUSAL.RETRY_REQUIRED);
  const admittedState = apply(state, admitted(retryRequest()));
  const cycle = admittedState.cycles['task-1#1'];
  assert.deepEqual(cycle.admittedRemedies, [retryRequest().remedy]);
  assert.equal(cycle.nextRemedy, retryRequest().remedy);
  assert.equal(cycle.reserved, 1);
  assert.deepEqual(nextCorrectionStep(admittedState),
    { action: 'reserve', scope: 'task-1', cycle: 1, iteration: 2, kind: 'correction' });
  const correction = apply(admittedState, reserved(2, 'correction'));
  assert.equal(correction.cycles['task-1#1'].reserved, 2);
  assert.equal(correction.cycles['task-1#1'].nextRemedy, null);
  assert.deepEqual(correction.cycles['task-1#1'].admittedRemedies, [retryRequest().remedy]);
  assert.deepEqual(nextCorrectionStep(correction),
    { action: 'authorize', scope: 'task-1', cycle: 1, iteration: 2, role: 'writer' });

  refused(applyCorrectionRecord(admittedState, admitted(retryRequest({ remedy: 'a different remedy entirely' }))),
    REFUSAL.RECORD_ORDER);
  refused(applyCorrectionRecord(state, admitted(retryRequest(), { iteration: 3 })), REFUSAL.RETRY_INVALID);
  refused(applyCorrectionRecord(state, admitted(retryRequest(), { scope: 'final' })), REFUSAL.CYCLE_NOT_OPEN);
  refused(applyCorrectionRecord(state, admitted(retryRequest(), { requestDigest: 'd' })), REFUSAL.RECORD_SCHEMA);
  refused(applyCorrectionRecord(state, admitted(retryRequest({ evidence: { ...ref(5), digest: hex('e') } }))),
    REFUSAL.RETRY_EVIDENCE_UNBOUND);
  refused(applyCorrectionRecord(state, admitted(retryRequest(), { request: 'retry' })), REFUSAL.RETRY_INVALID);
});

test('an admitted retry must be executed as the correction for its iteration: no other kind is reserved', () => {
  const state = apply(awaitingRetry(), admitted(retryRequest()));
  for (const reason of ['missing-retry-evidence', 'comparison-unavailable']) {
    const result = refused(applyCorrectionRecord(state, reserved(2, 'diagnosis', reason)), REFUSAL.RECORD_ORDER);
    assert.deepEqual(result.identity, { kind: 'ITERATION_RESERVED', scope: 'task-1', cycle: 1, iteration: 2 });
    assert.match(result.message, /admitted retry/u);
  }
  const correction = apply(state, reserved(2, 'correction'));
  assert.equal(correction.cycles['task-1#1'].iterations[1].kind, 'correction');
});

test('retry requests are closed, name an open cycle whose previous iteration concluded, and the next slot', () => {
  const state = awaitingRetry();
  const { evidence: _evidence, ...missing } = retryRequest();
  refused(validateRetryRequest(state, missing), REFUSAL.RETRY_INVALID);
  for (const bad of [null, 'retry', [], { ...retryRequest(), extra: 1 }, { ...retryRequest(), deadline: 1 }]) {
    refused(validateRetryRequest(state, bad), REFUSAL.RETRY_INVALID);
  }
  for (const overrides of [{ version: 2 }, { version: '1' }, { kind: 'bug' }, { scope: 'task' }, { cycle: 0 },
    { iteration: 'two' }, { evidence: { path: REF_PATH(5) } }, { evidence: 'record-5.json' },
    { target: 1 }, { confirmingCheck: null }, { hypothesis: 3 }]) {
    retryRefusal(state, overrides, REFUSAL.RETRY_INVALID);
  }
  retryRefusal(state, { scope: 'task-2' }, REFUSAL.CYCLE_NOT_OPEN);
  const pending = chain(cycleState(), [reserved(1, 'initial'), authorized(1, 'writer')]);
  refused(validateRetryRequest(pending, retryRequest()), REFUSAL.OUTCOME_ORDER);
  refused(validateRetryRequest(cycleState(), retryRequest()), REFUSAL.OUTCOME_ORDER);
  for (const iteration of [1, 3, 4]) {
    const result = retryRefusal(state, { iteration }, REFUSAL.ALLOWANCE_EXHAUSTED);
    assert.deepEqual(result.identity, { scope: 'task-1', cycle: 1, iteration });
  }
});

test('retry target and confirming check name the cycle bindings and checks', () => {
  const state = awaitingRetry();
  for (const target of ['SC1', 'SC2', 'surface-test', 'coherence-gate']) {
    assert.deepEqual(validateRetryRequest(state, retryRequest({ target })), { ok: true }, target);
  }
  for (const target of ['SC3', 'SC9', 'check-9', '', 'review']) retryRefusal(state, { target }, REFUSAL.RETRY_INVALID);
  for (const confirmingCheck of ['surface-test', 'coherence-gate', 'review', 'rubric']) {
    assert.deepEqual(validateRetryRequest(state, retryRequest({ confirmingCheck })), { ok: true }, confirmingCheck);
  }
  for (const confirmingCheck of ['lint', 'SC1', '']) {
    retryRefusal(state, { confirmingCheck }, REFUSAL.RETRY_INVALID);
  }
});

test('retry text fields refuse empty and status-only values, and a hypothesis or difference equal to the remedy', () => {
  const state = awaitingRetry();
  const words = ['', '   ', 'DONE', 'done.', 'DONE_WITH_CONCERNS', 'Blocked!', 'needs_context', ' APPROVED ',
    'issues_found:', 'retry', 'Again...', '...', 'RETRY?!'];
  for (const field of ['observedFailure', 'hypothesis', 'remedy', 'difference']) {
    for (const word of words) {
      retryRefusal(state, { [field]: word }, REFUSAL.RETRY_STATUS_ONLY);
    }
    assert.deepEqual(validateRetryRequest(state, retryRequest({ [field]: `${retryRequest()[field]} (done)` })),
      { ok: true }, field);
  }
  const remedy = retryRequest().remedy;
  retryRefusal(state, { hypothesis: remedy }, REFUSAL.RETRY_INVALID);
  retryRefusal(state, { difference: `  ${remedy.toUpperCase().replaceAll(' ', '   ')} ` }, REFUSAL.RETRY_INVALID);
});

test('retry evidence must equal a reference of the latest concluded iteration', () => {
  const state = awaitingRetry();
  retryRefusal(state, { evidence: { ...ref(5), digest: hex('e') } }, REFUSAL.RETRY_EVIDENCE_UNBOUND);
  retryRefusal(state, { evidence: { ...ref(6), digest: hex('c') } }, REFUSAL.RETRY_EVIDENCE_UNBOUND);
  const unreferenced = chain(cycleState(), [reserved(1, 'initial'), interrupted(1)]);
  refused(validateRetryRequest(unreferenced, retryRequest()), REFUSAL.RETRY_EVIDENCE_UNBOUND);
  const toolFailure = retryRequest({ kind: 'tool-failure', target: 'surface-test' });
  assert.deepEqual(validateRetryRequest(state, toolFailure), { ok: true });
  const accepted = apply(state, admitted(toolFailure));
  assert.deepEqual(accepted.cycles['task-1#1'].admittedRemedies, [toolFailure.remedy]);
});

test('a remedy admitted earlier in the cycle cannot be admitted again', () => {
  const first = retryRequest();
  const state = chain(awaitingRetry(), [
    admitted(first), reserved(2, 'correction'), authorized(2, 'writer'), [interrupted(2), { ref: ref(7, 'f') }],
  ]);
  const evidence = ref(7, 'f');
  retryRefusal(state, { iteration: 3, evidence, remedy: ` ${first.remedy.toUpperCase().replaceAll(' ', '\t ')} ` },
    REFUSAL.RETRY_REPEATED);
  retryRefusal(state, { iteration: 3, evidence }, REFUSAL.RETRY_REPEATED);
  // The normalized remedy alone decides: a new target and hypothesis do not make an old remedy new.
  for (const target of ['surface-test', 'SC2']) {
    retryRefusal(state, {
      iteration: 3,
      evidence,
      target,
      hypothesis: 'the reservation counter is read before the write',
      remedy: ` ${first.remedy.toUpperCase().replaceAll(' ', '\t ')} `,
    }, REFUSAL.RETRY_REPEATED);
  }
  assert.deepEqual(validateRetryRequest(state, retryRequest({
    iteration: 3, evidence, remedy: 'reserve the slot before dispatching the writer',
  })), { ok: true });
  retryRefusal(state, { iteration: 3, evidence: ref(5) }, REFUSAL.RETRY_EVIDENCE_UNBOUND);
});

test('the third iteration concluding without approval stops EXHAUSTED; a fourth reservation is refused', () => {
  const second = retryRequest();
  const third = retryRequest({ iteration: 3, evidence: ref(6), remedy: 'reserve the slot before dispatching' });
  const reservedThird = chain(awaitingRetry(), [
    admitted(second), reserved(2, 'correction'), authorized(2, 'writer'), [interrupted(2), { ref: ref(6) }],
    admitted(third), reserved(3, 'correction'), authorized(3, 'writer'),
  ]);
  assert.equal(reservedThird.cycles['task-1#1'].reserved, 3);
  for (const kind of ['correction', 'diagnosis', 'initial']) {
    refused(applyCorrectionRecord(reservedThird, reserved(4, kind, kind === 'diagnosis' ? 'comparison-unavailable' : null)),
      REFUSAL.ALLOWANCE_EXHAUSTED);
  }
  const exhausted = apply(reservedThird, interrupted(3));
  const cycle = exhausted.cycles['task-1#1'];
  assert.equal(cycle.status, 'STOPPED');
  assert.equal(cycle.stopReason, STOP.EXHAUSTED);
  // A stopped task cycle must prove isolation before the run continues.
  assert.deepEqual(nextCorrectionStep(exhausted), { action: 'prove-isolation', scope: 'task-1', cycle: 1 });
  refused(applyCorrectionRecord(exhausted, reserved(4, 'correction')), REFUSAL.CYCLE_TERMINAL);
  refused(validateRetryRequest(exhausted, retryRequest({ iteration: 4, evidence: ref(6) })), REFUSAL.CYCLE_TERMINAL);
  refused(applyCorrectionRecord(exhausted, authorized(3, 'task-reviewer')), REFUSAL.CYCLE_TERMINAL);
});

test('a task-scope correction allows at most one writer, then the task-reviewer', () => {
  const state = chain(awaitingRetry(), [admitted(retryRequest()), reserved(2, 'correction')]);
  for (const role of ['final-reviewer', 'diagnostic']) {
    refused(applyCorrectionRecord(state, authorized(2, role)), REFUSAL.ROLE_NOT_ALLOWED);
  }
  const reviewerOnly = apply(state, authorized(2, 'task-reviewer'));
  refused(applyCorrectionRecord(reviewerOnly, authorized(2, 'writer')), REFUSAL.ROLE_NOT_ALLOWED);
  const writer = apply(state, authorized(2, 'writer'));
  refused(applyCorrectionRecord(writer, authorized(2, 'writer')), REFUSAL.ROLE_ALREADY_DISPATCHED);
  apply(writer, authorized(2, 'task-reviewer'));
});

test('a final-scope correction writer names its owner task and a subset of that task\'s criteria', () => {
  const request = finalRetryRequest();
  const state = chain(awaitingRetry('final', 'final-reviewer'), [
    admitted(request), reserved(2, 'correction', null, 'final'),
  ]);
  const writer = (overrides) => authorized(2, 'writer', overrides, 'final');
  for (const overrides of [{}, { affectedCriteria: ['SC1'] }, { ownerTask: '1' }, { ownerTask: '1', affectedCriteria: [] },
    { ownerTask: '9', affectedCriteria: ['SC1'] }, { ownerTask: '1', affectedCriteria: ['SC3'] },
    { ownerTask: '1', affectedCriteria: ['SC1', 'SC3'] }]) {
    refused(applyCorrectionRecord(state, writer(overrides)), REFUSAL.ROLE_NOT_ALLOWED);
  }
  const written = apply(state, writer({ ownerTask: '1', affectedCriteria: ['SC2', 'SC1'] }));
  const dispatch = written.cycles['final#1'].iterations[1].dispatches[0];
  assert.equal(dispatch.ownerTask, '1');
  assert.deepEqual(dispatch.affectedCriteria, ['SC2', 'SC1']);
  const taskReviewer = (overrides) => authorized(2, 'task-reviewer', overrides, 'final');
  refused(applyCorrectionRecord(written, taskReviewer({})), REFUSAL.ROLE_NOT_ALLOWED);
  refused(applyCorrectionRecord(written, taskReviewer({ ownerTask: '9' })), REFUSAL.ROLE_NOT_ALLOWED);
  const reviewed = apply(written, taskReviewer({ ownerTask: '1' }));
  refused(applyCorrectionRecord(reviewed, authorized(2, 'final-reviewer', { ownerTask: '1' }, 'final')),
    REFUSAL.ROLE_NOT_ALLOWED);
  const finalReviewed = apply(reviewed, authorized(2, 'final-reviewer', {}, 'final'));
  refused(applyCorrectionRecord(finalReviewed, writer({ ownerTask: '2', affectedCriteria: ['SC3'] })),
    REFUSAL.ROLE_ALREADY_DISPATCHED);
  const reviewersOnly = apply(state, authorized(2, 'final-reviewer', {}, 'final'));
  refused(applyCorrectionRecord(reviewersOnly, writer({ ownerTask: '1', affectedCriteria: ['SC1'] })),
    REFUSAL.ROLE_NOT_ALLOWED);
  apply(reviewersOnly, taskReviewer({ ownerTask: '2' }));
});

test('a final-scope task-reviewer carries no affected criteria and reviews the writer\'s owner task', () => {
  const state = chain(awaitingRetry('final', 'final-reviewer'), [
    admitted(finalRetryRequest()), reserved(2, 'correction', null, 'final'),
  ]);
  const taskReviewer = (overrides) => authorized(2, 'task-reviewer', overrides, 'final');
  const written = apply(state, authorized(2, 'writer', { ownerTask: '1', affectedCriteria: ['SC1'] }, 'final'));
  const criteria = refused(applyCorrectionRecord(written, taskReviewer({ ownerTask: '1', affectedCriteria: ['SC1'] })),
    REFUSAL.ROLE_NOT_ALLOWED);
  assert.deepEqual(criteria.identity, { kind: 'DISPATCH_AUTHORIZED', scope: 'final', cycle: 1, iteration: 2 });
  refused(applyCorrectionRecord(written, taskReviewer({ ownerTask: '2' })), REFUSAL.ROLE_NOT_ALLOWED);
  const reviewed = apply(written, taskReviewer({ ownerTask: '1' }));
  assert.deepEqual(reviewed.cycles['final#1'].iterations[1].dispatches.map(({ role, ownerTask }) => [role, ownerTask]),
    [['writer', '1'], ['task-reviewer', '1']]);
  refused(applyCorrectionRecord(state, taskReviewer({ ownerTask: '2', affectedCriteria: ['SC3'] })),
    REFUSAL.ROLE_NOT_ALLOWED);
  apply(state, taskReviewer({ ownerTask: '2' }));
});

const DIAGNOSIS_ARTIFACT = Object.freeze({
  path: '.formula/work/tasks/2026-10-26-plan/correction/task-1-cycle-1-iteration-2-diagnosis.json',
  digest: hex('9'),
});

function diagnosed(iteration, valid = true, overrides = {}, scope = 'task-1', cycle = 1) {
  return {
    kind: 'DIAGNOSIS_RECORDED', scope, cycle, iteration, valid,
    hypothesis: 'the guard compares against a stale candidate',
    remedy: 'refresh the candidate before comparing',
    confirmingCheck: 'surface-test',
    recommendation: 'compare against the reserved candidate snapshot',
    artifact: { ...DIAGNOSIS_ARTIFACT },
    before: hex('1'),
    after: hex('1'),
    ...overrides,
  };
}

// Iteration 1 interrupted (record 5), then the diagnosis reserved and its diagnostic authorized at slot 2.
function diagnosingAtTwo() {
  return chain(awaitingRetry(), [reserved(2, 'diagnosis', 'missing-retry-evidence'), authorized(2, 'diagnostic')]);
}

test('a valid diagnosis at slot 2 permits one correction at slot 3, bound to the diagnosis artifact', () => {
  const state = apply(diagnosingAtTwo(), diagnosed(2));
  const cycle = state.cycles['task-1#1'];
  assert.equal(cycle.status, 'OPEN');
  assert.equal(cycle.reserved, 2);
  assert.equal(cycle.diagnosis.valid, true);
  assert.equal(cycle.nextRemedy, null);
  assert.deepEqual(nextCorrectionStep(state),
    { action: 'retry-or-diagnosis', scope: 'task-1', cycle: 1, iteration: 3, diagnosisAvailable: false });
  const request = retryRequest({ iteration: 3, evidence: { ...DIAGNOSIS_ARTIFACT } });
  assert.deepEqual(validateRetryRequest(state, request), { ok: true });
  retryRefusal(state, { iteration: 3 }, REFUSAL.RETRY_EVIDENCE_UNBOUND);
  retryRefusal(state, { iteration: 3, evidence: { ...DIAGNOSIS_ARTIFACT }, kind: 'tool-failure' },
    REFUSAL.RETRY_EVIDENCE_UNBOUND);
  refused(applyCorrectionRecord(state, reserved(3, 'diagnosis', 'missing-retry-evidence')), REFUSAL.DIAGNOSIS_USED);
  const correction = chain(state, [admitted(request), reserved(3, 'correction'), authorized(3, 'writer')]);
  assert.equal(correction.cycles['task-1#1'].reserved, 3);
  refused(applyCorrectionRecord(correction, reserved(4, 'correction')), REFUSAL.ALLOWANCE_EXHAUSTED);
});

test('a valid diagnosis at slot 3 stops EXHAUSTED and keeps its recommendation as the next remedy', () => {
  const state = chain(awaitingRetry(), [
    admitted(retryRequest()), reserved(2, 'correction'), authorized(2, 'writer'), [interrupted(2), { ref: ref(6) }],
    reserved(3, 'diagnosis', 'comparison-unavailable'), authorized(3, 'diagnostic'), diagnosed(3),
  ]);
  const cycle = state.cycles['task-1#1'];
  assert.equal(cycle.status, 'STOPPED');
  assert.equal(cycle.stopReason, STOP.EXHAUSTED);
  assert.equal(cycle.nextRemedy, diagnosed(3).recommendation);
  assert.equal(cycle.diagnosis.recommendation, diagnosed(3).recommendation);
  assert.equal(cycle.reserved, 3);
  assert.deepEqual(nextCorrectionStep(state), { action: 'prove-isolation', scope: 'task-1', cycle: 1 });
  refused(applyCorrectionRecord(state, reserved(4, 'correction')), REFUSAL.CYCLE_TERMINAL);
});

test('an invalid diagnosis stops the cycle DIAGNOSIS_INCONCLUSIVE, at any slot', () => {
  const atTwo = apply(diagnosingAtTwo(), diagnosed(2, false, { hypothesis: '', remedy: '', recommendation: '' }));
  assert.equal(atTwo.cycles['task-1#1'].status, 'STOPPED');
  assert.equal(atTwo.cycles['task-1#1'].stopReason, STOP.DIAGNOSIS_INCONCLUSIVE);
  assert.deepEqual(nextCorrectionStep(atTwo), { action: 'prove-isolation', scope: 'task-1', cycle: 1 });
  refused(validateRetryRequest(atTwo, retryRequest({ iteration: 3, evidence: { ...DIAGNOSIS_ARTIFACT } })),
    REFUSAL.CYCLE_TERMINAL);
  const atThree = chain(awaitingRetry(), [
    admitted(retryRequest()), reserved(2, 'correction'), [interrupted(2), { ref: ref(6) }],
    reserved(3, 'diagnosis', 'comparison-unavailable'), authorized(3, 'diagnostic'), diagnosed(3, false),
  ]);
  assert.equal(atThree.cycles['task-1#1'].stopReason, STOP.DIAGNOSIS_INCONCLUSIVE);
  assert.equal(atThree.cycles['task-1#1'].nextRemedy, null);
});

test('a diagnosis record needs an authorized diagnostic in a diagnosis iteration and an unchanged tree', () => {
  const reservedOnly = chain(awaitingRetry(), [reserved(2, 'diagnosis', 'missing-retry-evidence')]);
  refused(applyCorrectionRecord(reservedOnly, diagnosed(2)), REFUSAL.OUTCOME_ORDER);
  const writerIteration = chain(cycleState(), [reserved(1, 'initial'), authorized(1, 'writer')]);
  refused(applyCorrectionRecord(writerIteration, diagnosed(1)), REFUSAL.ROLE_NOT_ALLOWED);
  const state = diagnosingAtTwo();
  refused(applyCorrectionRecord(state, diagnosed(3)), REFUSAL.OUTCOME_ORDER);
  const mismatch = refused(applyCorrectionRecord(state, diagnosed(2, true, { after: hex('2') })), HALT.INTEGRITY);
  assert.deepEqual(mismatch.identity, { kind: 'DIAGNOSIS_RECORDED', scope: 'task-1', cycle: 1, iteration: 2 });
  for (const overrides of [{ valid: 'yes' }, { hypothesis: '' }, { remedy: 3 }, { confirmingCheck: ' ' },
    { recommendation: null }, { artifact: { path: DIAGNOSIS_ARTIFACT.path } }, { artifact: 'x' }, { before: 'b' },
    { after: hex('G') }]) {
    const result = refused(applyCorrectionRecord(state, diagnosed(2, true, overrides)), REFUSAL.RECORD_SCHEMA);
    assert.doesNotMatch(result.message, /unknown record kind/u);
  }
  refused(applyCorrectionRecord(state, diagnosed(2, false, { hypothesis: 3 })), REFUSAL.RECORD_SCHEMA);
});

function stopped(reason, scope = 'task-1', cycle = 1, overrides = {}) {
  return { kind: 'CYCLE_STOPPED', scope, cycle, reason, note: 'stopped by the operator', ...overrides };
}

function halted(overrides = {}) {
  return {
    kind: 'RUN_HALTED', reason: 'the observation changed during the diagnosis',
    evidence: [{ ...DIAGNOSIS_ARTIFACT }], observation: OBSERVATION, ...overrides,
  };
}

test('CYCLE_STOPPED stops an open cycle explicitly; an unconcluded reserved iteration stays spent', () => {
  const pending = chain(cycleState(), [reserved(1, 'initial'), authorized(1, 'writer')]);
  const state = apply(pending, stopped(STOP.HUMAN_INTERRUPTED));
  const cycle = state.cycles['task-1#1'];
  assert.equal(cycle.status, 'STOPPED');
  assert.equal(cycle.stopReason, STOP.HUMAN_INTERRUPTED);
  assert.equal(cycle.stopNote, 'stopped by the operator');
  assert.equal(cycle.reserved, 1);
  assert.equal(cycle.iterations[0].conclusion, null);
  assert.deepEqual(nextCorrectionStep(state), { action: 'prove-isolation', scope: 'task-1', cycle: 1 });
  refused(applyCorrectionRecord(state, interrupted(1)), REFUSAL.CYCLE_TERMINAL);
  refused(applyCorrectionRecord(state, stopped(STOP.HUMAN_INTERRUPTED)), REFUSAL.CYCLE_TERMINAL);
  refused(applyCorrectionRecord(state, cycleOpened()), REFUSAL.REOPEN_INVALID);
  // Nothing opens before isolation is proven; then task 2, which depends on the stopped task 1, is blocked.
  refused(applyCorrectionRecord(state, cycleOpened('task-2')), REFUSAL.ISOLATION_REQUIRED);
  refused(applyCorrectionRecord(apply(state, isolationRecorded()), cycleOpened('task-2')), REFUSAL.SCOPE_NOT_RUNNABLE);

  const missing = apply(awaitingRetry(), stopped(STOP.RETRY_EVIDENCE_MISSING));
  assert.equal(missing.cycles['task-1#1'].stopReason, STOP.RETRY_EVIDENCE_MISSING);
  refused(applyCorrectionRecord(pending, stopped(STOP.HUMAN_INTERRUPTED, 'final')), REFUSAL.CYCLE_NOT_OPEN);
  for (const overrides of [{ reason: STOP.EXHAUSTED }, { reason: STOP.APPROVED }, { note: '' }, { note: 4 }]) {
    const result = refused(applyCorrectionRecord(pending, stopped(STOP.HUMAN_INTERRUPTED, 'task-1', 1, overrides)),
      REFUSAL.RECORD_SCHEMA);
    assert.doesNotMatch(result.message, /unknown record kind/u);
  }
});

test('a halted run refuses every later record and reports the halt as its next step', () => {
  refused(applyCorrectionRecord(createCorrectionState(), halted()), REFUSAL.RUN_NOT_OPEN);
  const state = diagnosingAtTwo();
  refused(applyCorrectionRecord(state, diagnosed(2, true, { after: hex('2') })), HALT.INTEGRITY);
  const stopped = apply(state, halted(), { ref: ref(9) });
  assert.deepEqual(stopped.halted,
    { reason: halted().reason, evidence: [{ ...DIAGNOSIS_ARTIFACT }], observation: OBSERVATION });
  assert.deepEqual(nextCorrectionStep(stopped), { action: 'halted', reason: halted().reason });
  for (const record of [diagnosed(2), runOpened(), cycleOpened('task-2'), reserved(3, 'correction'), halted(),
    { kind: 'NOT_A_KIND' }, { ...halted(), deadline: 1 }]) {
    const result = refused(applyCorrectionRecord(stopped, record), REFUSAL.RUN_HALTED);
    assert.equal(result.identity.kind, record.kind);
  }
  refused(validateRetryRequest(stopped, retryRequest({ iteration: 3, evidence: { ...DIAGNOSIS_ARTIFACT } })),
    REFUSAL.RUN_HALTED);
  apply(opened(), halted({ evidence: [] }));
  for (const overrides of [{ reason: '' }, { evidence: 'x' }, { evidence: [{ path: 'x' }] }, { observation: 'b' }]) {
    const result = refused(applyCorrectionRecord(opened(), halted(overrides)), REFUSAL.RECORD_SCHEMA);
    assert.doesNotMatch(result.message, /unknown record kind/u);
  }
});

// The final opening when no task is delivered: the coherence gate alone, binding no criterion.
const NOTHING_DELIVERED = Object.freeze(deriveCycleBindings({ scope: 'final', deliveredTasks: [] }));

// A valid run touching every record kind but RUN_HALTED and the outcome records, with the guard's refs
// for every record. Task 1 stops EXHAUSTED and proves isolation; tasks 2 and 4 depend on it, so the
// final opens on nothing delivered. A human then reopens task 1.
function validSequence() {
  const second = retryRequest();
  const records = [
    runOpened(),
    cycleOpened(),
    reserved(1, 'initial'),
    authorized(1, 'writer'),
    authorized(1, 'task-reviewer'),
    interrupted(1),
    admitted(second),
    reserved(2, 'correction'),
    authorized(2, 'writer'),
    interrupted(2),
    reserved(3, 'diagnosis', 'comparison-unavailable'),
    authorized(3, 'diagnostic'),
    diagnosed(3),
    isolationRecorded(),
    cycleOpened('final', NOTHING_DELIVERED),
    reserved(1, 'initial', null, 'final'),
    authorized(1, 'final-reviewer', {}, 'final'),
    stopped(STOP.HUMAN_INTERRUPTED, 'final'),
    reopenAuthorized(),
    cycleOpened('task-1', { cycle: 2, predecessor: 'task-1#1' }),
  ];
  const refs = records.map((_record, index) => ref(index + 1, 'abcdef0123456789'[index % 16]));
  refs[5] = ref(5);
  refs[9] = ref(6);
  return { records, refs };
}

test('replay of a valid sequence equals incremental application', () => {
  const { records, refs } = validSequence();
  const incremental = records.reduce((state, record, index) => apply(state, record, { ref: refs[index] }),
    createCorrectionState());
  const replayed = ok(replayCorrectionRecords(records, { refs }));
  assert.deepEqual(replayed, incremental);
  assert.ok(isDeepFrozen(replayed));
  assert.equal(replayed.records, records.length);
  assert.deepEqual(replayed.refs, refs);
  assert.equal(replayed.cycles['task-1#1'].stopReason, STOP.EXHAUSTED);
  assert.equal(replayed.cycles['final#1'].stopReason, STOP.HUMAN_INTERRUPTED);
  assert.deepEqual(nextCorrectionStep(replayed), nextCorrectionStep(incremental));
  assert.deepEqual(nextCorrectionStep(replayed),
    { action: 'reserve', scope: 'task-1', cycle: 2, iteration: 1, kind: 'initial' });
  apply(replayed, reserved(1, 'initial', null, 'task-1', 2));

  const prefix = records.slice(0, 6);
  const unreferenced = ok(replayCorrectionRecords(prefix));
  assert.deepEqual(unreferenced.refs, prefix.map(() => null));
  assert.deepEqual(unreferenced.cycles['task-1#1'].iterations[0].conclusion.evidence, []);
  assert.deepEqual(ok(replayCorrectionRecords(prefix, { refs: prefix.map(() => null) })), unreferenced);
  assert.deepEqual(ok(replayCorrectionRecords([])), createCorrectionState());
});

test('replay returns the first refusal, naming its 1-based record index', () => {
  const { records, refs } = validSequence();
  const broken = [...records.slice(0, 7), reserved(3, 'correction'), ...records.slice(7)];
  const brokenRefs = [...refs.slice(0, 7), null, ...refs.slice(7)];
  const result = refused(replayCorrectionRecords(broken, { refs: brokenRefs }), REFUSAL.ALLOWANCE_EXHAUSTED);
  assert.deepEqual(result.identity, { kind: 'ITERATION_RESERVED', scope: 'task-1', cycle: 1, iteration: 3, record: 8 });
  const first = refused(replayCorrectionRecords([cycleOpened(), runOpened()]), REFUSAL.RUN_NOT_OPEN);
  assert.equal(first.identity.record, 1);
  const badRefs = [...refs];
  badRefs[3] = { path: REF_PATH(4) };
  assert.equal(refused(replayCorrectionRecords(records, { refs: badRefs }), REFUSAL.RECORD_SCHEMA).identity.record, 4);
  assert.equal(refused(replayCorrectionRecords(records), REFUSAL.RETRY_EVIDENCE_UNBOUND).identity.record, 7);
  assert.throws(() => replayCorrectionRecords([runOpened(), 'CYCLE_OPENED']), TypeError);
});

test('every record kind has a closed payload: a missing or an unknown key is refused with RECORD_SCHEMA', () => {
  const samples = {
    RUN_OPENED: runOpened(),
    CYCLE_OPENED: cycleOpened(),
    ITERATION_RESERVED: reserved(1, 'initial'),
    DISPATCH_AUTHORIZED: authorized(1, 'writer'),
    ITERATION_INTERRUPTED: interrupted(1),
    RETRY_ADMITTED: admitted(retryRequest()),
    DIAGNOSIS_RECORDED: diagnosed(2),
    CYCLE_STOPPED: stopped(STOP.HUMAN_INTERRUPTED),
    RUN_HALTED: halted(),
    WRITER_RECORDED: writerRecorded(1),
    CHECKS_RECORDED: checksRecorded(1),
    REVIEW_RECORDED: reviewRecorded(1),
    ISOLATION_RECORDED: isolationRecorded(),
    REOPEN_AUTHORIZED: reopenAuthorized(),
  };
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(CORRECTION_RECORD_KINDS).sort());
  for (const [kind, record] of Object.entries(samples)) {
    for (const state of [createCorrectionState(), opened()]) {
      for (const key of Object.keys(record).filter((name) => name !== 'kind')) {
        const { [key]: _dropped, ...missing } = record;
        const result = refused(applyCorrectionRecord(state, missing), REFUSAL.RECORD_SCHEMA);
        assert.match(result.message, new RegExp(`missing: ${key}`, 'u'), `${kind} without ${key}`);
      }
      const extra = refused(applyCorrectionRecord(state, { ...record, note2: 'x' }), REFUSAL.RECORD_SCHEMA);
      assert.match(extra.message, /unknown: note2/u, kind);
    }
  }
});

test('stored values must be JSON-plain: anything else is refused with RECORD_SCHEMA, never thrown or kept live', () => {
  const binding = (extra) => cycleOpened('task-1', { bindings: [{ criterion: 'SC1', ...extra }] });
  const cyclic = { criterion: 'SC1' };
  cyclic.self = cyclic;
  const accessor = { criterion: 'SC1' };
  Object.defineProperty(accessor, 'live', { get: () => 1, enumerable: true });
  const hidden = { criterion: 'SC1' };
  Object.defineProperty(hidden, 'hidden', { value: 1, enumerable: false });
  class Ids extends Array {}
  const lazyTask = { ...plan()[0] };
  Object.defineProperty(lazyTask, 'testCommand', { get: () => 'npm test', enumerable: true });
  const lazyRef = { digest: hex('c') };
  Object.defineProperty(lazyRef, 'path', { get: () => REF_PATH(1), enumerable: true });
  const cases = [
    [opened(), binding({ f: () => 1 })],
    [opened(), binding({ bytes: new Uint8Array(2) })],
    [opened(), binding({ map: new Map([[1, 2]]) })],
    [opened(), binding({ when: new Date(0) })],
    [opened(), binding({ [Symbol('s')]: 1 })],
    [opened(), binding({ n: Number.NaN })],
    [opened(), binding({ n: Number.POSITIVE_INFINITY })],
    [opened(), binding({ u: undefined })],
    [opened(), binding({ nested: { deep: [1, () => 2] } })],
    [opened(), binding({ sparse: [1, , 3] })], // eslint-disable-line no-sparse-arrays
    [opened(), cycleOpened('task-1', { bindings: [cyclic] })],
    [opened(), cycleOpened('task-1', { bindings: [accessor] })],
    [opened(), cycleOpened('task-1', { bindings: [hidden] })],
    [opened(), { ...cycleOpened(), [Symbol('extra')]: 1 }],
    [createCorrectionState(), runOpened({ tasks: [{ ...plan()[0], criterionIds: Ids.from(['SC1']) }] })],
    [createCorrectionState(), runOpened({ tasks: [lazyTask] })],
  ];
  for (const [index, [state, record]] of cases.entries()) {
    let result;
    assert.doesNotThrow(() => { result = applyCorrectionRecord(state, record); }, `case ${index}`);
    const refusal = refused(result, REFUSAL.RECORD_SCHEMA);
    assert.match(refusal.message, /JSON-plain/u, `case ${index}`);
  }
  let lazy;
  assert.doesNotThrow(() => { lazy = applyCorrectionRecord(createCorrectionState(), runOpened(), { ref: lazyRef }); });
  refused(lazy, REFUSAL.RECORD_SCHEMA);

  const state = apply(opened(), cycleOpened());
  assert.deepEqual(state.cycles['task-1#1'].bindings, cycleOpened().bindings);
  assert.ok(isDeepFrozen(state));
});

// --- verification bindings ------------------------------------------------------------------------

test('deriveCycleBindings: a design or integration task binds each criterion to both checks and the review', () => {
  const [, design, integration] = plan();
  assert.deepEqual(deriveCycleBindings({ scope: 'task-2', task: design, rubricCriteria: ['SC3'] }), {
    checks: [{ id: 'surface-test', command: 'npm test' }, GATE_CHECK],
    bindings: [commandBinding('SC3', 'surface-test'), gateBinding('SC3'), reviewBinding('SC3'), rubricBinding('SC3')],
    review: 'required',
  });
  assert.deepEqual(deriveCycleBindings({ scope: 'task-2', task: design, rubricCriteria: [] }).bindings,
    [commandBinding('SC3', 'surface-test'), gateBinding('SC3'), reviewBinding('SC3')]);
  assert.deepEqual(deriveCycleBindings({ scope: 'task-4', task: integration, reviewOptIn: false }), {
    checks: [{ id: 'surface-test', command: 'node --test x' }, GATE_CHECK], bindings: [], review: 'required',
  });
});

test('deriveCycleBindings: a mechanical task skips review unless it opts in', () => {
  const [mechanical] = plan();
  assert.deepEqual(deriveCycleBindings({ scope: 'task-1', task: mechanical }), {
    checks: [{ id: 'surface-test', command: 'npm test' }, GATE_CHECK],
    bindings: [commandBinding('SC1', 'surface-test'), gateBinding('SC1'), commandBinding('SC2', 'surface-test'),
      gateBinding('SC2')],
    review: 'skipped',
  });
  assert.deepEqual(
    deriveCycleBindings({ scope: 'task-1', task: mechanical, rubricCriteria: ['SC1'], reviewOptIn: true }), {
      checks: [{ id: 'surface-test', command: 'npm test' }, GATE_CHECK],
      bindings: [commandBinding('SC1', 'surface-test'), gateBinding('SC1'), reviewBinding('SC1'), rubricBinding('SC1'),
        commandBinding('SC2', 'surface-test'), gateBinding('SC2'), reviewBinding('SC2')],
      review: 'required',
    });
});

test('deriveCycleBindings: the final scope numbers sorted distinct commands and binds every delivered criterion', () => {
  const tasks = plan();
  const expected = {
    checks: [{ id: 'surface-test-1', command: 'node --test x' }, { id: 'surface-test-2', command: 'npm test' }, GATE_CHECK],
    bindings: ['SC1', 'SC2', 'SC3'].flatMap((criterion) => [
      commandBinding(criterion, 'surface-test-1'), commandBinding(criterion, 'surface-test-2'), gateBinding(criterion),
      reviewBinding(criterion), ...(criterion === 'SC2' ? [rubricBinding(criterion)] : []),
    ]),
    review: 'required',
  };
  assert.deepEqual(deriveCycleBindings({ scope: 'final', deliveredTasks: tasks, rubricCriteria: ['SC2'] }),
    expected);
  assert.deepEqual(deriveCycleBindings({
    scope: 'final', deliveredTasks: [tasks[2], tasks[0], tasks[1]], rubricCriteria: ['SC2'], reviewOptIn: false,
  }), expected);
  assert.deepEqual(deriveCycleBindings({ scope: 'final', deliveredTasks: [tasks[1]] }), {
    checks: [{ id: 'surface-test-1', command: 'npm test' }, GATE_CHECK],
    bindings: [commandBinding('SC3', 'surface-test-1'), gateBinding('SC3'), reviewBinding('SC3')],
    review: 'required',
  });
  assert.deepEqual(deriveCycleBindings({ scope: 'final', deliveredTasks: [] }),
    { checks: [GATE_CHECK], bindings: [], review: 'required' });
  const first = deriveCycleBindings({ scope: 'final', deliveredTasks: tasks });
  first.bindings.pop();
  first.checks[0].command = 'changed';
  assert.deepEqual(deriveCycleBindings({ scope: 'final', deliveredTasks: tasks }).checks[0],
    { id: 'surface-test-1', command: 'node --test x' });
});

test('deriveCycleBindings throws TypeError on a malformed call', () => {
  const [mechanical, design] = plan();
  const calls = [
    undefined, null, 'task-1',
    { scope: 'task-1', task: mechanical, extra: 1 },
    { scope: 'task-0', task: mechanical },
    { scope: 'task-1' },
    { scope: 'task-1', task: design },
    { scope: 'task-1', task: { ...mechanical, surface: 'scripts' } },
    { scope: 'task-1', task: mechanical, deliveredTasks: [mechanical] },
    { scope: 'task-1', task: mechanical, rubricCriteria: ['SC3'], reviewOptIn: true },
    { scope: 'task-1', task: mechanical, rubricCriteria: ['SC1', 'SC1'], reviewOptIn: true },
    { scope: 'task-1', task: mechanical, rubricCriteria: 'SC1', reviewOptIn: true },
    // A rubric is scored by a review, so a rubric criterion with a skipped review could never be met.
    { scope: 'task-1', task: mechanical, rubricCriteria: ['SC1'] },
    { scope: 'task-1', task: mechanical, reviewOptIn: 'yes' },
    { scope: 'final', task: mechanical, deliveredTasks: [] },
    { scope: 'final' },
    { scope: 'final', deliveredTasks: [mechanical, mechanical] },
    { scope: 'final', deliveredTasks: [mechanical], rubricCriteria: ['SC3'] },
    { scope: 'final', deliveredTasks: ['1'] },
  ];
  for (const [index, call] of calls.entries()) {
    assert.throws(() => deriveCycleBindings(call), { name: 'TypeError', message: /^deriveCycleBindings: /u },
      `call ${index}`);
  }
});

test('CYCLE_OPENED is refused with RECORD_SCHEMA unless checks, bindings and review equal the derivation', () => {
  const [mechanical] = plan();
  const derived = deriveCycleBindings({
    scope: 'task-1', task: mechanical, rubricCriteria: ['SC1'], reviewOptIn: true,
  });
  apply(opened(), { ...cycleOpened(), ...derived });
  // Equality is structural: binding key order is irrelevant.
  const reordered = derived.bindings.map(({ threshold, direction, metric, kind, check, criterion }) => ({
    threshold, direction, metric, kind, check, criterion,
  }));
  apply(opened(), cycleOpened('task-1', { bindings: reordered }));
  for (const scope of ['task-2', 'task-4', 'final']) apply(ready(scope), cycleOpened(scope));

  const { bindings, checks } = cycleOpened();
  const weakened = bindings.map((entry, index) => (index === 0 ? { ...entry, threshold: 1 } : entry));
  const mismatches = [
    ['task-1', { bindings: [...bindings].reverse() }],
    ['task-1', { bindings: bindings.filter((entry) => entry.check !== 'review') }],
    ['task-1', { bindings: weakened }],
    ['task-1', { bindings: [...bindings, rubricBinding('SC2')] }],
    ['task-1', { checks: [checks[0]] }],
    ['task-1', { checks: [{ ...checks[0], command: 'npm run lint' }, checks[1]] }],
    ['task-1', { checks: [...checks].reverse() }],
    ['task-1', { rubricCriteria: [] }],
    ['task-1', { rubricCriteria: ['SC1', 'SC1'] }],
    ['task-1', { rubricCriteria: ['SC3'] }],
    ['task-1', { review: 'skipped' }],
    ['task-2', { review: 'skipped', bindings: [commandBinding('SC3', 'surface-test'), gateBinding('SC3')] }],
    ['task-4', { checks: [{ id: 'surface-test', command: 'npm test' }, GATE_CHECK] }],
    ['final', { bindings: [commandBinding('SC1', 'surface-test-1')] }],
    // The final derivation covers exactly the delivered tasks, here tasks 1 and 2.
    ['final', NOTHING_DELIVERED],
    ['final', { checks: [{ id: 'surface-test-1', command: 'node --test x' }, GATE_CHECK] }],
    ['final', { review: 'skipped' }],
    ['final', { rubricCriteria: ['SC1'] }],
  ];
  for (const [scope, overrides] of mismatches) {
    let result;
    assert.doesNotThrow(() => { result = applyCorrectionRecord(ready(scope), cycleOpened(scope, overrides)); });
    const refusal = refused(result, REFUSAL.RECORD_SCHEMA);
    assert.deepEqual(refusal.identity, { kind: 'CYCLE_OPENED', scope, cycle: 1 }, JSON.stringify(overrides));
  }
  // The unrunnable-scope and reopen refusals keep precedence over the derivation.
  refused(applyCorrectionRecord(opened(), cycleOpened('task-3', { bindings: [] })), REFUSAL.SCOPE_NOT_RUNNABLE);
  refused(applyCorrectionRecord(opened(), cycleOpened('task-2', { cycle: 2, bindings: [] })), REFUSAL.REOPEN_INVALID);
});

// --- defect identity ------------------------------------------------------------------------------

const REVIEW_CODES = CORRECTION_CODES.review;

function defectEntry(overrides = {}) {
  return {
    criterion: 'SC1',
    check: 'review',
    dimension: null,
    cause: 'missing-test',
    severity: 'critical',
    expected: 'a test pins the fourth reservation refusal',
    observed: 'no test reserves a fourth iteration',
    proof: 'tests/correction-state.test.mjs has no fourth-reservation case',
    correction: 'add a test reserving iteration 4 and assert ALLOWANCE_EXHAUSTED',
    nextCheck: 'surface-test',
    supersedes: null,
    justification: null,
    ...overrides,
  };
}

function normalized(entries, previous = [], bindings = cycleOpened().bindings) {
  const result = normalizeDefects({ bindings, entries, previous });
  assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.message}`);
  return result.defects;
}

function defectRefusal(entries, code, previous = []) {
  const result = normalizeDefects({ bindings: cycleOpened().bindings, entries, previous });
  assert.equal(result.ok, false, `expected ${code}`);
  assert.equal(result.code, code, result.message);
  assert.equal(typeof result.message, 'string');
  assert.equal(typeof result.identity, 'object');
  return result;
}

test('normalizeDefects derives ids, blocking and the review severity metric', () => {
  const entries = [
    defectEntry(),
    defectEntry({ criterion: 'SC2', cause: 'unclear-name', severity: 'important' }),
    defectEntry({ cause: 'typo', severity: 'minor' }),
    defectEntry({ check: 'rubric', dimension: 'coverage', cause: 'no-edge-cases', severity: 'minor' }),
  ];
  const defects = normalized(entries);
  assert.deepEqual(defects.map(({ id, blocking, metric }) => [id, blocking, metric]), [
    ['SC1/review/missing-test', true, 3],
    ['SC2/review/unclear-name', true, 2],
    ['SC1/review/typo', false, 1],
    // A rubric defect's metric is its dimension score, which only the rubric carries.
    ['SC1/rubric:coverage/no-edge-cases', false, null],
  ]);
  assert.deepEqual(defects[0], { id: 'SC1/review/missing-test', ...defectEntry(), blocking: true, metric: 3 });
  assert.deepEqual(normalized([]), []);
  assert.equal(normalized([defectEntry({ cause: `a${'-b'.repeat(31)}a` })])[0].cause.length, 64);
});

test('normalizeDefects refuses entries with open or malformed keys, unbound criteria and duplicates', () => {
  assert.ok(Object.isFrozen(REVIEW_CODES));
  for (const code of ['DEFECT_SCHEMA', 'DEFECT_UNBOUND', 'DEFECT_SUPERSEDES', 'DEFECT_DUPLICATE']) {
    assert.equal(REVIEW_CODES[code], code);
  }
  const { cause: _cause, ...missing } = defectEntry();
  const malformed = [
    missing, { ...defectEntry(), extra: 1 }, 'SC1', null,
    defectEntry({ check: 'writer' }), defectEntry({ check: 'surface-test' }),
    defectEntry({ dimension: 'coverage' }), defectEntry({ check: 'rubric', dimension: null }),
    defectEntry({ check: 'rubric', dimension: 'style' }),
    defectEntry({ cause: 'Missing-Test' }), defectEntry({ cause: 'missing test' }), defectEntry({ cause: '-missing' }),
    defectEntry({ cause: 'missing--test' }), defectEntry({ cause: '' }), defectEntry({ cause: 'a'.repeat(65) }),
    defectEntry({ severity: 'major' }), defectEntry({ criterion: 7 }),
    ...['expected', 'observed', 'proof', 'correction', 'nextCheck'].flatMap((field) => [
      defectEntry({ [field]: '' }), defectEntry({ [field]: '  ' }), defectEntry({ [field]: null }),
    ]),
    defectEntry({ supersedes: 'SC1/review/old' }),
    defectEntry({ justification: 'the cause was misnamed' }),
    defectEntry({ supersedes: 'SC1/review/old', justification: ' ' }),
  ];
  for (const [index, entry] of malformed.entries()) {
    const result = defectRefusal([defectEntry({ cause: 'fine' }), entry], REVIEW_CODES.DEFECT_SCHEMA);
    assert.equal(result.identity.entry, 1, `case ${index}`);
  }
  defectRefusal('none', REVIEW_CODES.DEFECT_SCHEMA);
  for (const entry of [defectEntry({ criterion: 'SC9' }), defectEntry({ criterion: 'SC3' }),
    // SC2 is not a rubric criterion of the task-1 opening.
    defectEntry({ criterion: 'SC2', check: 'rubric', dimension: 'clarity' })]) {
    defectRefusal([entry], REVIEW_CODES.DEFECT_UNBOUND);
  }
  const noReview = cycleOpened('task-1', { review: 'skipped' }).bindings.filter((entry) => entry.check !== 'review');
  const unreviewed = normalizeDefects({ bindings: noReview, entries: [defectEntry()], previous: [] });
  assert.equal(unreviewed.code, REVIEW_CODES.DEFECT_UNBOUND);
  defectRefusal([defectEntry(), defectEntry({ observed: 'said differently' })], REVIEW_CODES.DEFECT_DUPLICATE);
  defectRefusal([defectEntry({ supersedes: 'SC1/review/old', justification: 'renamed after the fix' })],
    REVIEW_CODES.DEFECT_SUPERSEDES);
});

test('normalizeDefects: a renamed cause keeps the previous id unless it supersedes it with a justification', () => {
  const previous = normalized([defectEntry(), defectEntry({ check: 'rubric', dimension: 'clarity', cause: 'vague' })]);
  const renamed = normalized([defectEntry({ cause: 'absent-test' })], previous);
  assert.equal(renamed[0].id, 'SC1/review/missing-test');
  assert.equal(renamed[0].cause, 'absent-test');
  const rubricRenamed = normalized([defectEntry({ check: 'rubric', dimension: 'clarity', cause: 'unclear' })], previous);
  assert.equal(rubricRenamed[0].id, 'SC1/rubric:clarity/vague');
  // Another dimension or criterion is not the same defect.
  assert.equal(normalized([defectEntry({ check: 'rubric', dimension: 'usability', cause: 'unclear' })], previous)[0].id,
    'SC1/rubric:usability/unclear');
  assert.equal(normalized([defectEntry({ criterion: 'SC2', cause: 'absent-test' })], previous)[0].id,
    'SC2/review/absent-test');
  const superseding = normalized([defectEntry({
    cause: 'absent-test', supersedes: 'SC1/review/missing-test', justification: 'the test exists; its assertion is wrong',
  })], previous);
  assert.equal(superseding[0].id, 'SC1/review/absent-test');
  // A previous id still reported under its own cause is not free to absorb a second, renamed defect.
  assert.deepEqual(normalized([defectEntry(), defectEntry({ cause: 'absent-test' })], previous).map((entry) => entry.id),
    ['SC1/review/missing-test', 'SC1/review/absent-test']);
  assert.deepEqual(normalized([defectEntry({ cause: 'absent-test' }), defectEntry({ cause: 'flaky-test' })], previous)
    .map((entry) => entry.id), ['SC1/review/missing-test', 'SC1/review/flaky-test']);
  assert.deepEqual(normalized([defectEntry({ cause: 'absent-test' }), defectEntry()], previous).map((entry) => entry.id),
    ['SC1/review/absent-test', 'SC1/review/missing-test']);
});

test('normalizeDefects throws TypeError on a malformed call', () => {
  const { bindings } = cycleOpened();
  for (const call of [undefined, [], { bindings, entries: [] }, { bindings, entries: [], previous: [], extra: 1 },
    { bindings: 'SC1', entries: [], previous: [] }, { bindings, entries: [], previous: 'none' },
    { bindings, entries: [], previous: [{ criterion: 'SC1' }] }]) {
    assert.throws(() => normalizeDefects(call), { name: 'TypeError', message: /^normalizeDefects: /u });
  }
  assert.equal(normalizeDefects({ bindings, entries: [], previous: null }).ok, true);
});

// --- rubric ---------------------------------------------------------------------------------------

const RUBRIC_DIMENSIONS = ['coverage', 'correctness', 'clarity', 'usability'];

function rubricEntry(criterion = 'SC1', scores = {}, constraints = [{ id: 'node-builtins-only', satisfied: true,
  evidence: 'the module imports nothing' }]) {
  const entry = { criterion, constraints };
  for (const dimension of RUBRIC_DIMENSIONS) {
    entry[dimension] = { score: scores[dimension] ?? 2, evidence: `${dimension} evidence for ${criterion}` };
  }
  return entry;
}

function rubricDefect(dimension = 'clarity', overrides = {}) {
  return defectEntry({ check: 'rubric', dimension, cause: 'vague-names', severity: 'minor', ...overrides });
}

function rubricResult(rubric, defects = [], bindings = cycleOpened().bindings) {
  return validateRubric({ bindings, rubric, defects });
}

function rubricRefusal(rubric, code, defects = []) {
  const result = rubricResult(rubric, defects);
  assert.equal(result.ok, false, `expected ${code}`);
  assert.equal(result.code, code, result.message);
  assert.equal(typeof result.message, 'string');
  assert.equal(typeof result.identity, 'object');
  return result;
}

test('validateRubric approves only 8/8 with every constraint satisfied', () => {
  assert.deepEqual(rubricResult([rubricEntry()]), {
    ok: true, approved: true, criteria: [{ criterion: 'SC1', score: 8, constraintsSatisfied: true, approved: true }],
  });
  const sevenOfEight = rubricResult([rubricEntry('SC1', { clarity: 1 })], [rubricDefect()]);
  assert.deepEqual(sevenOfEight, {
    ok: true, approved: false, criteria: [{ criterion: 'SC1', score: 7, constraintsSatisfied: true, approved: false }],
  });
  const normalizedSupport = normalized([rubricDefect('coverage')]);
  assert.equal(rubricResult([rubricEntry('SC1', { coverage: 0 })], normalizedSupport).criteria[0].score, 6);
  // An unsatisfied constraint is backed by a blocking review defect on its criterion.
  const unsatisfied = rubricResult([rubricEntry('SC1', {}, [
    { id: 'node-builtins-only', satisfied: true, evidence: 'no imports' },
    { id: 'no-time-conditions', satisfied: false, evidence: 'a deadline option exists' },
  ])], [defectEntry({ cause: 'deadline-option' })]);
  assert.deepEqual(unsatisfied.criteria, [{ criterion: 'SC1', score: 8, constraintsSatisfied: false, approved: false }]);
  assert.equal(unsatisfied.approved, false);
  assert.deepEqual(rubricResult([rubricEntry('SC1', {}, [])]).approved, true);
  // A scope without rubric criteria takes an empty rubric.
  assert.deepEqual(rubricResult([], [], cycleOpened('task-2').bindings), { ok: true, approved: true, criteria: [] });
});

test('validateRubric: a score below 2 without a rubric defect carrying a correction is unsupported', () => {
  assert.ok(Object.isFrozen(REVIEW_CODES));
  for (const code of ['RUBRIC_SCHEMA', 'RUBRIC_COVERAGE', 'RUBRIC_UNSUPPORTED']) assert.equal(REVIEW_CODES[code], code);
  const low = [rubricEntry('SC1', { clarity: 1 })];
  const unsupported = rubricRefusal(low, REVIEW_CODES.RUBRIC_UNSUPPORTED);
  assert.deepEqual(unsupported.identity, { criterion: 'SC1', dimension: 'clarity' });
  rubricRefusal(low, REVIEW_CODES.RUBRIC_UNSUPPORTED, [rubricDefect('coverage')]);
  rubricRefusal(low, REVIEW_CODES.RUBRIC_UNSUPPORTED, [rubricDefect('clarity', { criterion: 'SC2' })]);
  rubricRefusal(low, REVIEW_CODES.RUBRIC_UNSUPPORTED, [defectEntry()]);
  rubricRefusal(low, REVIEW_CODES.RUBRIC_UNSUPPORTED, [rubricDefect('clarity', { correction: '  ' })]);
  rubricRefusal([rubricEntry('SC1', { usability: 0 })], REVIEW_CODES.RUBRIC_UNSUPPORTED, [rubricDefect('clarity')]);
});

test('validateRubric needs exactly one well-formed entry per rubric criterion', () => {
  rubricRefusal([], REVIEW_CODES.RUBRIC_COVERAGE);
  rubricRefusal([rubricEntry(), rubricEntry()], REVIEW_CODES.RUBRIC_COVERAGE);
  rubricRefusal([rubricEntry(), rubricEntry('SC2')], REVIEW_CODES.RUBRIC_COVERAGE);
  rubricRefusal([rubricEntry('SC9')], REVIEW_CODES.RUBRIC_COVERAGE);
  const entry = rubricEntry();
  const { usability: _usability, ...missing } = entry;
  const constraint = entry.constraints[0];
  const malformed = [
    missing, { ...entry, extra: 1 }, 'SC1', null, { ...entry, criterion: 1 },
    { ...entry, clarity: { score: 3, evidence: 'x' } }, { ...entry, clarity: { score: -1, evidence: 'x' } },
    { ...entry, clarity: { score: 1.5, evidence: 'x' } }, { ...entry, clarity: { score: '2', evidence: 'x' } },
    { ...entry, clarity: { score: 2, evidence: '' } }, { ...entry, clarity: { score: 2 } },
    { ...entry, clarity: { score: 2, evidence: 'x', note: 'y' } }, { ...entry, clarity: 2 },
    { ...entry, constraints: 'none' }, { ...entry, constraints: [{ ...constraint, satisfied: 'yes' }] },
    { ...entry, constraints: [{ ...constraint, evidence: ' ' }] }, { ...entry, constraints: [{ ...constraint, id: '' }] },
    { ...entry, constraints: [{ id: constraint.id, satisfied: true }] },
    { ...entry, constraints: [{ ...constraint, extra: 1 }] }, { ...entry, constraints: [constraint, constraint] },
  ];
  for (const [index, bad] of malformed.entries()) {
    const result = rubricRefusal([bad], REVIEW_CODES.RUBRIC_SCHEMA);
    assert.equal(result.identity.entry, 0, `case ${index}`);
  }
  rubricRefusal('8/8', REVIEW_CODES.RUBRIC_SCHEMA);
});

test('validateRubric throws TypeError on a malformed call', () => {
  const { bindings } = cycleOpened();
  for (const call of [undefined, [], { bindings, rubric: [] }, { bindings, rubric: [], defects: [], extra: 1 },
    { bindings: null, rubric: [], defects: [] }]) {
    assert.throws(() => validateRubric(call), { name: 'TypeError', message: /^validateRubric: /u });
  }
});

test('validateRubric returns a structured failure, never a throw, for malformed reviewer defects', () => {
  const bindings = [commandBinding('SC3', 'surface-test'), gateBinding('SC3'), reviewBinding('SC3'), rubricBinding('SC3')];
  const rubric = [rubricEntry('SC3', {}, [])];
  for (const [defects, identity] of [[['SC1'], { entry: 0 }], [[null], { entry: 0 }], ['none', {}],
    [[defectEntry(), 7], { entry: 1 }]]) {
    let result;
    assert.doesNotThrow(() => { result = validateRubric({ bindings, rubric, defects }); });
    assert.equal(result.ok, false);
    assert.equal(result.code, REVIEW_CODES.DEFECT_SCHEMA, result.message);
    assert.equal(typeof result.message, 'string');
    assert.deepEqual(result.identity, identity);
  }
  assert.equal(validateRubric({ bindings, rubric, defects: [{}] }).ok, true);
});

// --- outcome comparison ---------------------------------------------------------------------------

// A defect as an outcome carries it; criterion, check and dimension are read from its id.
function outcomeDefect(id, metric, overrides = {}) {
  const [criterion, checkPart] = id.split('/');
  const [check, dimension = null] = checkPart.split(':');
  return { id, criterion, check, dimension, metric, observed: `observed ${metric}`, ...overrides };
}

const outcome = (...defects) => ({ defects });

function comparison(previous, current, bindings = cycleOpened().bindings) {
  return compareOutcomes(previous, current, bindings);
}

test('compareOutcomes: a repeated command defect improving 3 to 1 continues; 3 to 3 stagnates', () => {
  const id = 'SC1/surface-test/command-failed';
  assert.deepEqual(comparison(outcome(outcomeDefect(id, 3)), outcome(outcomeDefect(id, 1))), {
    verdict: 'progress', defects: [{ id, previous: 3, current: 1, result: 'improved' }],
  });
  assert.deepEqual(comparison(outcome(outcomeDefect(id, 3)), outcome(outcomeDefect(id, 3))), {
    verdict: 'stagnant', defects: [{ id, previous: 3, current: 3, result: 'stagnant' }],
  });
  assert.equal(comparison(outcome(outcomeDefect(id, 3)), outcome(outcomeDefect(id, 4))).verdict, 'stagnant');
  const gate = 'SC2/coherence-gate/command-failed';
  assert.equal(comparison(outcome(outcomeDefect(gate, 2)), outcome(outcomeDefect(gate, 0))).verdict, 'progress');
  // Longer text and a new hypothesis are not progress: only the metric on a comparable check counts.
  const reworded = outcomeDefect(id, 3, { observed: 'three assertions still fail after a much longer rewrite',
    hypothesis: 'a different hypothesis' });
  assert.equal(comparison(outcome(outcomeDefect(id, 3)), outcome(reworded)).verdict, 'stagnant');
});

test('compareOutcomes: review severity improves downward and rubric scores improve upward', () => {
  const review = 'SC1/review/missing-test';
  assert.deepEqual(comparison(outcome(outcomeDefect(review, 3)), outcome(outcomeDefect(review, 2))).defects,
    [{ id: review, previous: 3, current: 2, result: 'improved' }]);
  assert.equal(comparison(outcome(outcomeDefect(review, 2)), outcome(outcomeDefect(review, 2))).verdict, 'stagnant');
  const rubric = 'SC1/rubric:clarity/vague-names';
  assert.equal(comparison(outcome(outcomeDefect(rubric, 0)), outcome(outcomeDefect(rubric, 1))).verdict, 'progress');
  assert.equal(comparison(outcome(outcomeDefect(rubric, 1)), outcome(outcomeDefect(rubric, 1))).verdict, 'stagnant');
  assert.equal(comparison(outcome(outcomeDefect(rubric, 1)), outcome(outcomeDefect(rubric, 0))).verdict, 'stagnant');
});

test('compareOutcomes: a missing metric is unavailable, stagnation outranks it, and a new id is not stagnation', () => {
  const id = 'SC1/surface-test/command-failed';
  const writer = '*/writer/blocked';
  assert.deepEqual(comparison(outcome(outcomeDefect(id, null)), outcome(outcomeDefect(id, 1))), {
    verdict: 'unavailable', defects: [{ id, previous: null, current: 1, result: 'unavailable' }],
  });
  assert.equal(comparison(outcome(outcomeDefect(id, 2)), outcome(outcomeDefect(id, null))).verdict, 'unavailable');
  assert.equal(comparison(outcome(outcomeDefect(writer, null)), outcome(outcomeDefect(writer, null))).verdict,
    'unavailable');
  const review = 'SC1/review/missing-test';
  assert.equal(comparison(outcome(outcomeDefect(id, null), outcomeDefect(review, 3)),
    outcome(outcomeDefect(id, null), outcomeDefect(review, 3))).verdict, 'stagnant');
  assert.deepEqual(comparison(outcome(outcomeDefect(id, 3)), outcome(outcomeDefect(review, 3))), {
    verdict: 'progress', defects: [{ id: review, previous: null, current: 3, result: 'new' }],
  });
  assert.deepEqual(comparison(null, outcome(outcomeDefect(id, 3))), { verdict: 'none', defects: [] });
  assert.deepEqual(comparison(outcome(outcomeDefect(id, 3)), outcome()), { verdict: 'progress', defects: [] });
  // A defect whose check is not bound has no direction, so it is not comparable.
  const unbound = 'SC9/review/missing-test';
  assert.equal(comparison(outcome(outcomeDefect(unbound, 3)), outcome(outcomeDefect(unbound, 1))).verdict,
    'unavailable');
});

test('compareOutcomes judges a repeated id by its worst current against its best previous metric', () => {
  const id = 'SC1/review/missing-test';
  assert.deepEqual(comparison(outcome(outcomeDefect(id, 3)), outcome(outcomeDefect(id, 1), outcomeDefect(id, 3))).defects,
    [{ id, previous: 3, current: 3, result: 'stagnant' }]);
  assert.equal(comparison(outcome(outcomeDefect(id, 3), outcomeDefect(id, 2)), outcome(outcomeDefect(id, 2))).verdict,
    'stagnant');
});

test('compareOutcomes throws TypeError on a malformed call', () => {
  const current = outcome(outcomeDefect('SC1/review/missing-test', 3));
  for (const args of [[undefined, current, []], [{}, current, []], [null, null, []], [null, { defects: 'x' }, []],
    [null, current, 'bindings'], [null, outcome({ id: 'x' }), []]]) {
    assert.throws(() => compareOutcomes(...args), { name: 'TypeError', message: /^compareOutcomes: /u });
  }
});

// --- outcome records ------------------------------------------------------------------------------

const CANDIDATE = (n) => hex(String(n));
const OUTCOME_PATH = (scope, n, role) =>
  `.formula/work/tasks/2026-10-26-plan/correction/${scope}-cycle-1-iteration-${n}-${role}.json`;

function writerRecorded(iteration, status = 'DONE', overrides = {}, scope = 'task-1', cycle = 1) {
  return {
    kind: 'WRITER_RECORDED', scope, cycle, iteration, status,
    evidence: [{ path: OUTCOME_PATH(scope, iteration, 'writer'), digest: hex('e') }],
    responseDigest: hex('f'),
    observation: CANDIDATE(iteration),
    candidate: { path: OUTCOME_PATH(scope, iteration, 'candidate'), digest: hex('7') },
    changedPaths: ['scripts/correction-state.mjs', 'tests/correction-state.test.mjs'],
    ...overrides,
  };
}

// Iteration 1 of task-1 with its writer authorized.
function writing(scope = 'task-1') {
  return chain(cycleState(scope), [reserved(1, 'initial', null, scope), authorized(1, 'writer', {}, scope)]);
}

function assertFeedback(defect) {
  for (const field of ['expected', 'observed', 'proof', 'correction', 'nextCheck']) {
    assert.equal(typeof defect[field], 'string', field);
    assert.ok(defect[field].trim().length > 0, field);
  }
}

test('WRITER_RECORDED records an accepted writer once, without concluding the iteration', () => {
  for (const status of ['DONE', 'DONE_WITH_CONCERNS']) {
    const state = apply(writing(), writerRecorded(1, status), { ref: ref(5) });
    const entry = state.cycles['task-1#1'].iterations[0];
    assert.equal(entry.conclusion, null);
    assert.deepEqual(entry.writer, {
      status, accepted: true, evidence: writerRecorded(1).evidence, responseDigest: hex('f'), observation: CANDIDATE(1),
      candidate: writerRecorded(1).candidate, changedPaths: writerRecorded(1).changedPaths, ref: ref(5),
    });
    refused(applyCorrectionRecord(state, writerRecorded(1, status)), REFUSAL.OUTCOME_ORDER);
  }
  apply(writing(), writerRecorded(1, 'DONE', { responseDigest: null, changedPaths: [] }));
  refused(applyCorrectionRecord(apply(cycleState(), reserved(1, 'initial')), writerRecorded(1)), REFUSAL.OUTCOME_ORDER);
  const reviewerOnly = chain(awaitingRetry(), [admitted(retryRequest()), reserved(2, 'correction'),
    authorized(2, 'task-reviewer')]);
  refused(applyCorrectionRecord(reviewerOnly, writerRecorded(2)), REFUSAL.OUTCOME_ORDER);
  refused(applyCorrectionRecord(writing(), writerRecorded(2)), REFUSAL.OUTCOME_ORDER);
  refused(applyCorrectionRecord(writing(), writerRecorded(1, 'DONE', {}, 'task-2')), REFUSAL.CYCLE_NOT_OPEN);
});

test('WRITER_RECORDED refuses malformed payloads with RECORD_SCHEMA', () => {
  const state = writing();
  const reference = { path: 'a.json', digest: hex('e') };
  for (const overrides of [
    { status: 'OK' }, { status: 'done' }, { evidence: [] }, { evidence: reference }, { evidence: [{ path: 'a.json' }] },
    { responseDigest: 'f' }, { observation: hex('Z') }, { candidate: null }, { candidate: { path: 'a.json' } },
    { changedPaths: ['b', 'a'] }, { changedPaths: ['a', 'a'] }, { changedPaths: [''] }, { changedPaths: 'a' },
    { changedPaths: ['a\nb'] },
  ]) {
    const result = refused(applyCorrectionRecord(state, writerRecorded(1, 'DONE', overrides)), REFUSAL.RECORD_SCHEMA);
    assert.doesNotMatch(result.message, /unknown record kind/u, JSON.stringify(overrides));
  }
  // Code-unit order: uppercase sorts before lowercase.
  apply(state, writerRecorded(1, 'DONE', { changedPaths: ['B.md', 'a.md'] }));
});

test('a non-success writer concludes the iteration failed with a guard defect carrying feedback', () => {
  for (const [status, cause] of [['BLOCKED', 'blocked'], ['NEEDS_CONTEXT', 'needs_context'], ['INVALID', 'invalid']]) {
    const state = apply(writing(), writerRecorded(1, status), { ref: ref(5) });
    const cycle = state.cycles['task-1#1'];
    const { conclusion } = cycle.iterations[0];
    assert.equal(cycle.status, 'OPEN');
    assert.equal(conclusion.via, 'outcome');
    assert.equal(conclusion.approved, false);
    assert.equal(conclusion.defects.length, 1);
    const [defect] = conclusion.defects;
    assert.equal(defect.id, `*/writer/${cause}`);
    assert.deepEqual([defect.criterion, defect.check, defect.dimension, defect.cause, defect.metric, defect.severity,
      defect.blocking, defect.supersedes, defect.justification],
    ['*', 'writer', null, cause, null, 'critical', true, null, null]);
    assertFeedback(defect);
    assert.equal(defect.nextCheck, 'writer');
    assert.match(defect.observed, new RegExp(status, 'u'));
    assert.ok(defect.proof.includes(writerRecorded(1).evidence[0].path) && defect.proof.includes(hex('e')));
    assert.deepEqual(conclusion.evidence, [
      { ...writerRecorded(1).evidence[0], source: 'writer-failure' }, { ...ref(5), source: 'writer-failure' },
    ]);
    refused(applyCorrectionRecord(state, writerRecorded(1)), REFUSAL.OUTCOME_ORDER);
    // A writer failure is a tool failure: a tool-failure retry may bind to its evidence.
    const toolFailure = retryRequest({ kind: 'tool-failure', evidence: { ...writerRecorded(1).evidence[0] } });
    assert.deepEqual(validateRetryRequest(state, toolFailure), { ok: true });
    assert.deepEqual(validateRetryRequest(state, retryRequest({ evidence: ref(5) })), { ok: true });
  }
});

const FAILED = (metric = 3, exitCode = 1) => ({ exitCode, passed: false, metric });

// Every check of the scope's opening passes on the iteration's candidate unless `results` says otherwise.
function checksRecorded(iteration, results = {}, overrides = {}, scope = 'task-1', cycle = 1,
  ids = opening(scope).checks.map((check) => check.id)) {
  return {
    kind: 'CHECKS_RECORDED', scope, cycle, iteration, observation: CANDIDATE(iteration),
    checks: ids.map((id) => ({
      id, exitCode: 0, passed: true, metric: 0, evidence: { path: OUTCOME_PATH(scope, iteration, id), digest: hex('8') },
      ...results[id],
    })),
    ...overrides,
  };
}

function written(scope = 'task-1') {
  return apply(writing(scope), writerRecorded(1, 'DONE', {}, scope));
}

test('CHECKS_RECORDED must cover exactly the cycle checks: an unexecuted mandatory check is refused', () => {
  const state = written();
  const [surface, gate] = checksRecorded(1).checks;
  for (const checks of [[surface], [gate], [], [surface, gate, { ...gate, id: 'lint' }], [surface, gate, gate],
    [surface, { ...gate, id: 'coherence' }]]) {
    const result = refused(applyCorrectionRecord(state, checksRecorded(1, {}, { checks })), REFUSAL.RECORD_SCHEMA);
    assert.deepEqual(result.identity, { kind: 'CHECKS_RECORDED', scope: 'task-1', cycle: 1, iteration: 1 });
  }
  apply(state, checksRecorded(1, {}, { checks: [gate, surface] }));
  for (const result of [{ exitCode: 1.5 }, { exitCode: '0' }, { passed: 'yes' }, { metric: -1 }, { metric: 1.5 },
    { metric: '0' }, { evidence: { path: 'a.json' } }, { evidence: null }]) {
    refused(applyCorrectionRecord(state, checksRecorded(1, { 'surface-test': result })), REFUSAL.RECORD_SCHEMA);
  }
  refused(applyCorrectionRecord(state, checksRecorded(1, {}, { checks: [{ ...surface, extra: 1 }, gate] })),
    REFUSAL.RECORD_SCHEMA);
  refused(applyCorrectionRecord(state, checksRecorded(1, {}, { observation: 'b' })), REFUSAL.RECORD_SCHEMA);
  // A pass contradicted by its own exit code or metric is refused; the builtin gate may have no exit code.
  for (const result of [{ exitCode: 1 }, { metric: 2 }, { exitCode: null, metric: 1 }]) {
    refused(applyCorrectionRecord(state, checksRecorded(1, { 'coherence-gate': result })), REFUSAL.RECORD_SCHEMA);
  }
  apply(state, checksRecorded(1, { 'coherence-gate': { exitCode: null, metric: 0 }, 'surface-test': { metric: null } }));
  apply(state, checksRecorded(1, { 'coherence-gate': FAILED(0, 0) }));
});

test('CHECKS_RECORDED follows an accepted writer, or an iteration without one, once', () => {
  refused(applyCorrectionRecord(writing(), checksRecorded(1)), REFUSAL.OUTCOME_ORDER);
  const blocked = apply(writing(), writerRecorded(1, 'BLOCKED'));
  refused(applyCorrectionRecord(blocked, checksRecorded(1)), REFUSAL.OUTCOME_ORDER);
  const checked = apply(written(), checksRecorded(1));
  assert.deepEqual(checked.cycles['task-1#1'].iterations[0].checks,
    { observation: CANDIDATE(1), results: checksRecorded(1).checks, ref: null });
  assert.equal(checked.cycles['task-1#1'].iterations[0].conclusion, null);
  refused(applyCorrectionRecord(checked, checksRecorded(1)), REFUSAL.OUTCOME_ORDER);
  refused(applyCorrectionRecord(written(), checksRecorded(2)), REFUSAL.OUTCOME_ORDER);
  // A task's initial iteration checks its writer's candidate, never the untouched baseline.
  const unwritten = apply(cycleState(), reserved(1, 'initial'));
  refused(applyCorrectionRecord(unwritten, checksRecorded(1, {}, { observation: OBSERVATION })), REFUSAL.OUTCOME_ORDER);
  // No writer authorized in a final iteration: the checks verify the opening observation.
  const finalBaseline = chain(cycleState('final'), [reserved(1, 'initial', null, 'final'),
    checksRecorded(1, {}, { observation: OBSERVATION }, 'final')]);
  assert.equal(finalBaseline.cycles['final#1'].iterations[0].checks.observation, OBSERVATION);
  // No writer may follow recorded checks.
  const reviewerOnly = chain(written(), [checksRecorded(1, { 'surface-test': FAILED() }),
    admitted(retryRequest({ evidence: { path: OUTCOME_PATH('task-1', 1, 'surface-test'), digest: hex('8') } })),
    reserved(2, 'correction'), checksRecorded(2, {}, { observation: CANDIDATE(1) })]);
  refused(applyCorrectionRecord(reviewerOnly, authorized(2, 'writer')), REFUSAL.OUTCOME_ORDER);
  const diagnosing = diagnosingAtTwo();
  refused(applyCorrectionRecord(diagnosing, checksRecorded(2, {}, { observation: OBSERVATION })), REFUSAL.OUTCOME_ORDER);
});

test('CHECKS_RECORDED must verify the iteration candidate, or the guard halts', () => {
  const mismatch = refused(applyCorrectionRecord(written(), checksRecorded(1, {}, { observation: OBSERVATION })),
    HALT.INTEGRITY);
  assert.deepEqual(mismatch.identity, { kind: 'CHECKS_RECORDED', scope: 'task-1', cycle: 1, iteration: 1 });
  const unwritten = apply(cycleState('final'), reserved(1, 'initial', null, 'final'));
  refused(applyCorrectionRecord(unwritten, checksRecorded(1, {}, {}, 'final')), HALT.INTEGRITY);
  // Without a writer of its own, a later iteration verifies the latest accepted writer's candidate.
  const failedReview = chain(written(), [checksRecorded(1, { 'surface-test': FAILED() }, {}),
    admitted(retryRequest({ evidence: { path: OUTCOME_PATH('task-1', 1, 'surface-test'), digest: hex('8') } })),
    reserved(2, 'correction'), authorized(2, 'task-reviewer')]);
  refused(applyCorrectionRecord(failedReview, checksRecorded(2, {}, { observation: OBSERVATION })), HALT.INTEGRITY);
  apply(failedReview, checksRecorded(2, {}, { observation: CANDIDATE(1) }));
});

test('failed checks conclude the iteration with a critical defect per bound criterion, carrying the metric', () => {
  const state = apply(written(), checksRecorded(1, { 'surface-test': FAILED(3) }), { ref: ref(7) });
  const { conclusion } = state.cycles['task-1#1'].iterations[0];
  assert.equal(conclusion.via, 'outcome');
  assert.equal(conclusion.approved, false);
  assert.deepEqual(conclusion.defects.map(({ id, severity, blocking, metric }) => [id, severity, blocking, metric]), [
    ['SC1/surface-test/command-failed', 'critical', true, 3],
    ['SC2/surface-test/command-failed', 'critical', true, 3],
  ]);
  const [defect] = conclusion.defects;
  assertFeedback(defect);
  assert.equal(defect.expected, 'exit 0 with 0 failed assertions');
  assert.equal(defect.observed, 'exit 1, 3 failed assertions');
  assert.equal(defect.correction, 'make surface-test pass without weakening it');
  assert.equal(defect.nextCheck, 'surface-test');
  const evidence = { path: OUTCOME_PATH('task-1', 1, 'surface-test'), digest: hex('8') };
  assert.ok(defect.proof.includes(evidence.path) && defect.proof.includes(evidence.digest));
  assert.deepEqual(conclusion.evidence, [{ ...evidence, source: 'checks' }, { ...ref(7), source: 'checks' }]);
  // Failed checks are defect evidence, not a tool failure.
  assert.deepEqual(validateRetryRequest(state, retryRequest({ evidence })), { ok: true });
  refused(validateRetryRequest(state, retryRequest({ kind: 'tool-failure', evidence })), REFUSAL.RETRY_EVIDENCE_UNBOUND);

  const both = apply(written(),
    checksRecorded(1, { 'surface-test': FAILED(null, null), 'coherence-gate': FAILED(2, null) }));
  const defects = both.cycles['task-1#1'].iterations[0].conclusion.defects;
  assert.deepEqual(defects.map(({ id, metric }) => [id, metric]), [
    ['SC1/surface-test/command-failed', null], ['SC1/coherence-gate/command-failed', 2],
    ['SC2/surface-test/command-failed', null], ['SC2/coherence-gate/command-failed', 2],
  ]);
  assert.equal(defects[1].expected, 'exit 0 with 0 violations');
  assert.equal(defects[1].observed, 'no exit code, 2 violations');
  assert.equal(defects[0].observed, 'no exit code, an unknown number of failed assertions');
  // A failed check that binds no criterion still yields a defect.
  const unbound = chain(cycleState('task-4'), [reserved(1, 'initial', null, 'task-4'), authorized(1, 'writer', {}, 'task-4'),
    writerRecorded(1, 'DONE', {}, 'task-4'), checksRecorded(1, { 'surface-test': FAILED(1) }, {}, 'task-4')]);
  assert.deepEqual(unbound.cycles['task-4#1'].iterations[0].conclusion.defects.map((entry) => entry.id),
    ['*/surface-test/command-failed']);
});

function reviewRecorded(iteration, status = 'APPROVED', overrides = {}, role = 'task-reviewer', scope = 'task-1',
  cycle = 1) {
  return {
    kind: 'REVIEW_RECORDED', scope, cycle, iteration, role, ownerTask: null, status, defects: [],
    rubric: opening(scope).rubricCriteria.map((criterion) => rubricEntry(criterion)),
    evidence: [{ path: OUTCOME_PATH(scope, iteration, role), digest: hex('6') }],
    before: CANDIDATE(iteration), after: CANDIDATE(iteration), ...overrides,
  };
}

// Iteration 1 of task-1: writer recorded, checks passed, task-reviewer authorized.
function reviewing() {
  return chain(written(), [checksRecorded(1), authorized(1, 'task-reviewer')]);
}

test('REVIEW_RECORDED needs its authorized reviewer, passed checks and the checked observation, once', () => {
  refused(applyCorrectionRecord(apply(written(), checksRecorded(1)), reviewRecorded(1)), REFUSAL.OUTCOME_ORDER);
  refused(applyCorrectionRecord(apply(written(), authorized(1, 'task-reviewer')), reviewRecorded(1)),
    REFUSAL.OUTCOME_ORDER);
  const failedChecks = chain(written(), [authorized(1, 'task-reviewer'), checksRecorded(1, { 'surface-test': FAILED() })]);
  refused(applyCorrectionRecord(failedChecks, reviewRecorded(1)), REFUSAL.OUTCOME_ORDER);
  const state = reviewing();
  refused(applyCorrectionRecord(state, reviewRecorded(1, 'APPROVED', { ownerTask: '1' })), REFUSAL.ROLE_NOT_ALLOWED);
  refused(applyCorrectionRecord(state, reviewRecorded(1, 'APPROVED', {}, 'final-reviewer')), REFUSAL.OUTCOME_ORDER);
  const blocked = apply(state, reviewRecorded(1, 'BLOCKED'));
  refused(applyCorrectionRecord(blocked, reviewRecorded(1)), REFUSAL.OUTCOME_ORDER);
  for (const overrides of [{ before: CANDIDATE(2), after: CANDIDATE(2) }, { after: CANDIDATE(2) }]) {
    const result = refused(applyCorrectionRecord(state, reviewRecorded(1, 'APPROVED', overrides)), HALT.INTEGRITY);
    assert.deepEqual(result.identity, { kind: 'REVIEW_RECORDED', scope: 'task-1', cycle: 1, iteration: 1 });
  }
  for (const overrides of [{ role: 'writer' }, { ownerTask: 'x' }, { status: 'OK' }, { defects: 'none' },
    { rubric: 'none' }, { evidence: 'x' }, { evidence: [{ path: 'a.json' }] }, { before: 'b' }, { after: hex('Z') }]) {
    const result = refused(applyCorrectionRecord(state, reviewRecorded(1, 'APPROVED', overrides)), REFUSAL.RECORD_SCHEMA);
    assert.doesNotMatch(result.message, /unknown record kind/u, JSON.stringify(overrides));
  }
});

test('an incomplete or invalid review concludes the iteration failed with a guard defect carrying feedback', () => {
  for (const [status, cause] of [['BLOCKED', 'review-blocked'], ['NEEDS_CONTEXT', 'review-needs_context'],
    ['INVALID', 'review-invalid']]) {
    // The guard records garbage reviewer output as INVALID: its defects and rubric are kept out of state.
    const state = apply(reviewing(), reviewRecorded(1, status, { defects: [{ any: 'thing' }], rubric: ['8/8'] }),
      { ref: ref(9) });
    const cycle = state.cycles['task-1#1'];
    const { conclusion, reviews } = cycle.iterations[0];
    assert.equal(cycle.status, 'OPEN');
    assert.equal(conclusion.approved, false);
    assert.equal(conclusion.by, 'review');
    assert.deepEqual(reviews.map((review) => [review.role, review.status, review.defects]), [['task-reviewer', status, []]]);
    const [defect] = conclusion.defects;
    assert.equal(conclusion.defects.length, 1);
    assert.equal(defect.id, `*/review/${cause}`);
    assert.deepEqual([defect.check, defect.cause, defect.metric, defect.severity, defect.blocking],
      ['review', cause, null, 'critical', true]);
    assertFeedback(defect);
    assert.equal(defect.nextCheck, 'review');
    const evidence = reviewRecorded(1).evidence[0];
    assert.ok(defect.proof.includes(evidence.path) && defect.proof.includes(evidence.digest));
    assert.deepEqual(conclusion.evidence,
      [{ ...evidence, source: 'review-failure' }, { ...ref(9), source: 'review-failure' }]);
    assert.deepEqual(validateRetryRequest(state, retryRequest({ kind: 'tool-failure', evidence: { ...evidence } })),
      { ok: true });
    // Proof needs evidence: an incomplete review without any is refused.
    refused(applyCorrectionRecord(reviewing(), reviewRecorded(1, status, { evidence: [] })), REFUSAL.RECORD_SCHEMA);
  }
});

test('ISSUES_FOUND concludes the iteration failed with normalized defects; the rubric metric is its score', () => {
  const entries = [defectEntry(), rubricDefect('clarity', { severity: 'important' })];
  const state = apply(reviewing(), reviewRecorded(1, 'ISSUES_FOUND', {
    defects: entries, rubric: [rubricEntry('SC1', { clarity: 1 })], evidence: [],
  }), { ref: ref(9) });
  const { conclusion, reviews } = state.cycles['task-1#1'].iterations[0];
  assert.equal(conclusion.approved, false);
  assert.deepEqual(conclusion.defects.map(({ id, metric, blocking }) => [id, metric, blocking]), [
    ['SC1/review/missing-test', 3, true], ['SC1/rubric:clarity/vague-names', 1, true],
  ]);
  assert.deepEqual(conclusion.defects, reviews[0].defects);
  assert.deepEqual(reviews[0].rubric,
    { approved: false, criteria: [{ criterion: 'SC1', score: 7, constraintsSatisfied: true, approved: false }] });
  assert.deepEqual(conclusion.evidence, [{ ...ref(9), source: 'review' }]);
  assert.deepEqual(validateRetryRequest(state, retryRequest({ evidence: ref(9) })), { ok: true });
  refused(validateRetryRequest(state, retryRequest({ kind: 'tool-failure', evidence: ref(9) })),
    REFUSAL.RETRY_EVIDENCE_UNBOUND);
});

test('a review whose report is not valid is refused with its review code: the guard records it INVALID', () => {
  const state = reviewing();
  const minor = defectEntry({ severity: 'minor' });
  const cases = [
    [reviewRecorded(1, 'APPROVED', { defects: [defectEntry()] }), REVIEW_CODES.STATUS_INCONSISTENT],
    [reviewRecorded(1, 'ISSUES_FOUND'), REVIEW_CODES.STATUS_INCONSISTENT],
    [reviewRecorded(1, 'ISSUES_FOUND', { defects: [minor] }), REVIEW_CODES.STATUS_INCONSISTENT],
    [reviewRecorded(1, 'ISSUES_FOUND', { defects: [{ ...defectEntry(), extra: 1 }] }), REVIEW_CODES.DEFECT_SCHEMA],
    [reviewRecorded(1, 'ISSUES_FOUND', { defects: [defectEntry({ criterion: 'SC3' })] }), REVIEW_CODES.DEFECT_UNBOUND],
    [reviewRecorded(1, 'APPROVED', { rubric: [rubricEntry('SC1', { clarity: 1 })] }), REVIEW_CODES.RUBRIC_UNSUPPORTED],
    [reviewRecorded(1, 'APPROVED', { rubric: [] }), REVIEW_CODES.RUBRIC_COVERAGE],
    [reviewRecorded(1, 'APPROVED', { rubric: [{ criterion: 'SC1' }] }), REVIEW_CODES.RUBRIC_SCHEMA],
  ];
  for (const [record, code] of cases) {
    const result = refused(applyCorrectionRecord(state, record), code);
    assert.deepEqual(result.identity, { kind: 'REVIEW_RECORDED', scope: 'task-1', cycle: 1, iteration: 1 });
    assert.match(result.message, /INVALID/u);
  }
  const invalid = apply(state, reviewRecorded(1, 'INVALID', { rubric: [rubricEntry('SC1', { clarity: 1 })] }));
  assert.equal(invalid.cycles['task-1#1'].iterations[0].conclusion.defects[0].id, '*/review/review-invalid');
});

// Final cycle, iteration 2: a correction whose writer changes `ownerTask` and has passed the checks.
function finalCorrection(ownerTask, affectedCriteria, taskReviewer = false) {
  return chain(awaitingRetry('final', 'final-reviewer'), [
    admitted(finalRetryRequest()), reserved(2, 'correction', null, 'final'),
    authorized(2, 'writer', { ownerTask, affectedCriteria }, 'final'),
    ...(taskReviewer ? [authorized(2, 'task-reviewer', { ownerTask }, 'final')] : []),
    writerRecorded(2, 'DONE', {}, 'final'), checksRecorded(2, {}, {}, 'final'),
    authorized(2, 'final-reviewer', {}, 'final'),
  ]);
}

test('a final correction of an integration or design task needs an approved task review first', () => {
  const finalReview = (status = 'APPROVED') => reviewRecorded(2, status, {}, 'final-reviewer', 'final');
  const designOwned = finalCorrection('2', ['SC3']);
  const bypass = refused(applyCorrectionRecord(designOwned, finalReview('BLOCKED')), REFUSAL.FINAL_BYPASS);
  assert.deepEqual(bypass.identity, { kind: 'REVIEW_RECORDED', scope: 'final', cycle: 1, iteration: 2 });
  // Without a writer the task-reviewer's task owns the correction: task 4 is an integration task.
  const reviewOnly = chain(awaitingRetry('final', 'final-reviewer'), [
    admitted(finalRetryRequest()), reserved(2, 'correction', null, 'final'),
    authorized(2, 'task-reviewer', { ownerTask: '4' }, 'final'),
    checksRecorded(2, {}, { observation: OBSERVATION }, 'final'),
    authorized(2, 'final-reviewer', {}, 'final'),
  ]);
  const unwrittenReview = (role, status, ownerTask = null) => reviewRecorded(2, status,
    { ownerTask, before: OBSERVATION, after: OBSERVATION }, role, 'final');
  refused(applyCorrectionRecord(reviewOnly, unwrittenReview('final-reviewer', 'BLOCKED')), REFUSAL.OUTCOME_ORDER);
  apply(apply(reviewOnly, unwrittenReview('task-reviewer', 'APPROVED', '4')), unwrittenReview('final-reviewer', 'BLOCKED'));
  // A mechanical owner task needs no task review.
  apply(finalCorrection('1', ['SC1']), finalReview('BLOCKED'));
  const pending = finalCorrection('2', ['SC3'], true);
  refused(applyCorrectionRecord(pending, finalReview('BLOCKED')), REFUSAL.OUTCOME_ORDER);
  const taskReview = reviewRecorded(2, 'APPROVED', { ownerTask: '2' }, 'task-reviewer', 'final');
  const taskApproved = apply(pending, taskReview);
  assert.equal(taskApproved.cycles['final#1'].iterations[1].conclusion, null);
  apply(taskApproved, finalReview('BLOCKED'));
  const taskBlocked = apply(pending, { ...taskReview, status: 'BLOCKED' });
  assert.equal(taskBlocked.cycles['final#1'].iterations[1].conclusion.defects[0].id, '*/review/review-blocked');
  refused(applyCorrectionRecord(taskBlocked, finalReview()), REFUSAL.OUTCOME_ORDER);
});

// --- approval -------------------------------------------------------------------------------------

function approvedTaskOne() {
  return chain(reviewing(), [reviewRecorded(1)]);
}

test('approval requires the accepted writer, every check, the approved review and one observation', () => {
  const state = approvedTaskOne();
  const cycle = state.cycles['task-1#1'];
  assert.equal(cycle.status, 'APPROVED');
  assert.equal(cycle.stopReason, STOP.APPROVED);
  assert.equal(cycle.approvedObservation, CANDIDATE(1));
  assert.deepEqual([cycle.iterations[0].conclusion.approved, cycle.iterations[0].conclusion.observation],
    [true, CANDIDATE(1)]);
  // Task 2 depends on the approved task 1: it is the next runnable task.
  assert.deepEqual(nextCorrectionStep(state), { action: 'open-cycle', scope: 'task-2' });
  refused(applyCorrectionRecord(state, reviewRecorded(1)), REFUSAL.CYCLE_TERMINAL);
  refused(applyCorrectionRecord(state, cycleOpened()), REFUSAL.SCOPE_NOT_RUNNABLE);
  // Passed checks alone do not approve a cycle whose review is required.
  assert.equal(reviewing().cycles['task-1#1'].status, 'OPEN');
  assert.equal(reviewing().cycles['task-1#1'].iterations[0].conclusion, null);
  // A failed check or a contradicting observation never reaches approval.
  refused(applyCorrectionRecord(chain(written(), [authorized(1, 'task-reviewer'), checksRecorded(1, { 'coherence-gate':
    FAILED(1) })]), reviewRecorded(1)), REFUSAL.OUTCOME_ORDER);
  refused(applyCorrectionRecord(reviewing(), reviewRecorded(1, 'APPROVED', { before: OBSERVATION, after: OBSERVATION })),
    HALT.INTEGRITY);
});

test('a rubric scoring 7/8, or with an unsatisfied constraint, does not approve the cycle', () => {
  const seven = apply(reviewing(), reviewRecorded(1, 'APPROVED', {
    defects: [rubricDefect('usability')], rubric: [rubricEntry('SC1', { usability: 1 })],
  }));
  const cycle = seven.cycles['task-1#1'];
  assert.equal(cycle.status, 'OPEN');
  assert.equal(cycle.approvedObservation, null);
  const { conclusion } = cycle.iterations[0];
  assert.equal(conclusion.approved, false);
  assert.deepEqual(conclusion.defects.map(({ id, metric, blocking }) => [id, metric, blocking]),
    [['SC1/rubric:usability/vague-names', 1, false]]);
  // An APPROVED review with an unsatisfied, unbacked constraint is not a valid review.
  refused(applyCorrectionRecord(reviewing(), reviewRecorded(1, 'APPROVED', {
    rubric: [rubricEntry('SC1', {}, [{ id: 'node-builtins-only', satisfied: false, evidence: 'imports a package' }])],
  })), REVIEW_CODES.RUBRIC_UNSUPPORTED);
});

test('a mechanical task without review approves on its passed checks and authorizes no reviewer', () => {
  const skipped = cycleOpened('task-1', {
    bindings: [commandBinding('SC1', 'surface-test'), gateBinding('SC1'), commandBinding('SC2', 'surface-test'),
      gateBinding('SC2')],
    rubricCriteria: [],
    review: 'skipped',
  });
  const state = chain(opened(), [skipped, reserved(1, 'initial'), authorized(1, 'writer')]);
  refused(applyCorrectionRecord(state, authorized(1, 'task-reviewer')), REFUSAL.ROLE_NOT_ALLOWED);
  const approved = chain(state, [writerRecorded(1, 'DONE_WITH_CONCERNS'), checksRecorded(1)]);
  assert.equal(approved.cycles['task-1#1'].status, 'APPROVED');
  assert.equal(approved.cycles['task-1#1'].approvedObservation, CANDIDATE(1));
  const failed = chain(state, [writerRecorded(1), checksRecorded(1, { 'surface-test': FAILED(2) })]);
  assert.equal(failed.cycles['task-1#1'].status, 'OPEN');
});

test('the final cycle opens on the delivered tasks and approves only on the final review', () => {
  const tasks = plan();
  // Tasks 1 and 2 are approved and task 4 stopped: the final binds only the delivered tasks, so the
  // stopped task's `node --test x` is not among its checks.
  const delivered = deriveCycleBindings({ scope: 'final', deliveredTasks: [tasks[0], tasks[1]] });
  const state = taskFourStopped();
  refused(applyCorrectionRecord(state, cycleOpened('final', NOTHING_DELIVERED)), REFUSAL.RECORD_SCHEMA);
  const finalOpened = apply(state, cycleOpened('final', delivered));
  assert.deepEqual(finalOpened.cycles['final#1'].checks,
    [{ id: 'surface-test-1', command: 'npm test' }, { id: 'coherence-gate', command: 'builtin' }]);
  const ids = delivered.checks.map((check) => check.id);
  const finalReview = (iteration, status = 'APPROVED', overrides = {}) => reviewRecorded(iteration, status,
    { before: OBSERVATION, after: OBSERVATION, rubric: [], ...overrides }, 'final-reviewer', 'final');
  const approved = chain(finalOpened, [
    reserved(1, 'initial', null, 'final'), authorized(1, 'final-reviewer', {}, 'final'),
    checksRecorded(1, {}, { observation: OBSERVATION }, 'final', 1, ids), finalReview(1),
  ]);
  assert.equal(approved.cycles['final#1'].status, 'APPROVED');
  assert.equal(approved.cycles['final#1'].approvedObservation, OBSERVATION);
  // Every surface-test-<k> binds every final criterion.
  const failing = chain(finalOpened, [
    reserved(1, 'initial', null, 'final'), authorized(1, 'final-reviewer', {}, 'final'),
    checksRecorded(1, { 'surface-test-1': FAILED(4) }, { observation: OBSERVATION }, 'final', 1, ids),
  ]);
  assert.deepEqual(failing.cycles['final#1'].iterations[0].conclusion.defects.map((defect) => defect.id),
    ['SC1/surface-test-1/command-failed', 'SC2/surface-test-1/command-failed', 'SC3/surface-test-1/command-failed']);
  // In a final correction, an approved task review leaves the iteration open for the final review.
  const correcting = chain(failing, [
    admitted(finalRetryRequest({ target: 'SC1', confirmingCheck: 'surface-test-1',
      evidence: { path: OUTCOME_PATH('final', 1, 'surface-test-1'), digest: hex('8') } })),
    reserved(2, 'correction', null, 'final'),
    authorized(2, 'writer', { ownerTask: '1', affectedCriteria: ['SC1'] }, 'final'),
    authorized(2, 'task-reviewer', { ownerTask: '1' }, 'final'), writerRecorded(2, 'DONE', {}, 'final'),
    checksRecorded(2, {}, {}, 'final', 1, ids), authorized(2, 'final-reviewer', {}, 'final'),
    reviewRecorded(2, 'APPROVED', { ownerTask: '1', rubric: [] }, 'task-reviewer', 'final'),
  ]);
  assert.equal(correcting.cycles['final#1'].status, 'OPEN');
  assert.equal(correcting.cycles['final#1'].iterations[1].conclusion, null);
  const finalApproved = apply(correcting, finalReview(2, 'APPROVED', { before: CANDIDATE(2), after: CANDIDATE(2) }));
  assert.equal(finalApproved.cycles['final#1'].status, 'APPROVED');
  assert.equal(finalApproved.cycles['final#1'].approvedObservation, CANDIDATE(2));
});

// --- stagnation -----------------------------------------------------------------------------------

const checkEvidence = (iteration, id = 'surface-test', scope = 'task-1') => ({
  path: OUTCOME_PATH(scope, iteration, id), digest: hex('8'),
});
const REMEDIES = {
  2: 'compare the requested iteration with the reserved count plus one',
  3: 'reserve the slot before dispatching the writer',
};

// Admits the retry for `iteration` bound to `evidence`, reserves it and records an accepted writer.
function rewritten(state, iteration, evidence) {
  return chain(state, [
    admitted(retryRequest({ iteration, evidence, remedy: REMEDIES[iteration] })), reserved(iteration, 'correction'),
    authorized(iteration, 'writer'), writerRecorded(iteration),
  ]);
}

function cycleOf(state) {
  return state.cycles['task-1#1'];
}

test('a repeated command defect improving 3 to 1 awaits a retry; staying at 3 stops the cycle STAGNATED', () => {
  const first = chain(written(), [checksRecorded(1, { 'surface-test': FAILED(3) })]);
  const improved = apply(rewritten(first, 2, checkEvidence(1)), checksRecorded(2, { 'surface-test': FAILED(1) }));
  assert.equal(cycleOf(improved).status, 'OPEN');
  assert.deepEqual(cycleOf(improved).iterations[1].conclusion.comparison.defects.map(({ id, result }) => [id, result]), [
    ['SC1/surface-test/command-failed', 'improved'], ['SC2/surface-test/command-failed', 'improved'],
  ]);
  assert.deepEqual(nextCorrectionStep(improved),
    { action: 'retry-or-diagnosis', scope: 'task-1', cycle: 1, iteration: 3, diagnosisAvailable: true });
  const stagnant = apply(rewritten(first, 2, checkEvidence(1)), checksRecorded(2, { 'surface-test': FAILED(3) }));
  assert.equal(cycleOf(stagnant).status, 'STOPPED');
  assert.equal(cycleOf(stagnant).stopReason, STOP.STAGNATED);
  assert.equal(cycleOf(stagnant).iterations[1].conclusion.comparison.verdict, 'stagnant');
  assert.deepEqual(nextCorrectionStep(stagnant), { action: 'prove-isolation', scope: 'task-1', cycle: 1 });
  // Stagnation on the last slot is reported as STAGNATED, not EXHAUSTED.
  const third = apply(rewritten(improved, 3, checkEvidence(2)), checksRecorded(3, { 'surface-test': FAILED(1) }));
  assert.equal(cycleOf(third).stopReason, STOP.STAGNATED);
  const exhausted = apply(rewritten(improved, 3, checkEvidence(2)), checksRecorded(3, { 'surface-test': FAILED(0, 1) }));
  assert.equal(cycleOf(exhausted).stopReason, STOP.EXHAUSTED);
});

// Iteration 1 of task-1 ends ISSUES_FOUND with `entries`; its review evidence binds the retry.
function issuesFound(entries) {
  return apply(reviewing(), reviewRecorded(1, 'ISSUES_FOUND', { defects: entries }));
}

function reviewedAgain(state, entries) {
  return chain(rewritten(state, 2, reviewRecorded(1).evidence[0]), [
    checksRecorded(2), authorized(2, 'task-reviewer'), reviewRecorded(2, 'ISSUES_FOUND', { defects: entries }),
  ]);
}

test('a review defect from critical to important improves; staying critical stagnates', () => {
  const first = issuesFound([defectEntry()]);
  const improved = reviewedAgain(first, [defectEntry({ severity: 'important' })]);
  assert.equal(cycleOf(improved).status, 'OPEN');
  assert.deepEqual(cycleOf(improved).iterations[1].conclusion.comparison.defects,
    [{ id: 'SC1/review/missing-test', previous: 3, current: 2, result: 'improved' }]);
  assert.equal(cycleOf(reviewedAgain(first, [defectEntry({ observed: 'reworded at length' })])).stopReason,
    STOP.STAGNATED);
});

test('a renamed cause without supersedes is forged progress; with supersedes and a justification it is new', () => {
  const first = issuesFound([defectEntry()]);
  const forged = reviewedAgain(first, [defectEntry({ cause: 'absent-test' })]);
  assert.equal(cycleOf(forged).iterations[1].conclusion.defects[0].id, 'SC1/review/missing-test');
  assert.equal(cycleOf(forged).stopReason, STOP.STAGNATED);
  const superseding = reviewedAgain(first, [defectEntry({
    cause: 'absent-test',
    supersedes: 'SC1/review/missing-test',
    justification: 'the missing test was added; it asserts the wrong code',
  })]);
  assert.equal(cycleOf(superseding).status, 'OPEN');
  assert.deepEqual(cycleOf(superseding).iterations[1].conclusion.comparison.defects,
    [{ id: 'SC1/review/absent-test', previous: null, current: 3, result: 'new' }]);
});

test('a missing metric requires the diagnosis, then stops COMPARISON_UNAVAILABLE once the diagnosis is used', () => {
  assert.equal(REFUSAL.DIAGNOSIS_REQUIRED, 'DIAGNOSIS_REQUIRED');
  const first = chain(written(), [checksRecorded(1, { 'surface-test': FAILED(null) })]);
  const unavailable = apply(rewritten(first, 2, checkEvidence(1)), checksRecorded(2, { 'surface-test': FAILED(null) }));
  const cycle = cycleOf(unavailable);
  assert.equal(cycle.status, 'OPEN');
  assert.equal(cycle.diagnosisRequired, true);
  assert.equal(cycle.iterations[1].conclusion.comparison.verdict, 'unavailable');
  assert.deepEqual(nextCorrectionStep(unavailable), {
    action: 'reserve', scope: 'task-1', cycle: 1, iteration: 3, kind: 'diagnosis', reason: 'comparison-unavailable',
  });
  const retry = retryRequest({ iteration: 3, evidence: checkEvidence(2), remedy: REMEDIES[3] });
  const blocked = refused(validateRetryRequest(unavailable, retry), REFUSAL.DIAGNOSIS_REQUIRED);
  assert.deepEqual(blocked.identity, { scope: 'task-1', cycle: 1, iteration: 3 });
  refused(applyCorrectionRecord(unavailable, admitted(retry)), REFUSAL.DIAGNOSIS_REQUIRED);
  const diagnosed3 = chain(unavailable, [reserved(3, 'diagnosis', 'comparison-unavailable'), authorized(3, 'diagnostic'),
    diagnosed(3)]);
  assert.equal(cycleOf(diagnosed3).diagnosisRequired, false);
  assert.equal(cycleOf(diagnosed3).stopReason, STOP.EXHAUSTED);

  // The diagnosis already spent at slot 2: the correction at slot 3 compares with iteration 1.
  const spent = chain(first, [reserved(2, 'diagnosis', 'missing-retry-evidence'), authorized(2, 'diagnostic'),
    diagnosed(2)]);
  const after = apply(rewritten(spent, 3, { ...DIAGNOSIS_ARTIFACT }), checksRecorded(3, { 'surface-test': FAILED(2) }));
  assert.equal(cycleOf(after).stopReason, STOP.COMPARISON_UNAVAILABLE);
  assert.equal(cycleOf(after).diagnosisRequired, false);
  // Unused, but no slot remains for it.
  const known = chain(written(), [checksRecorded(1, { 'surface-test': FAILED(3) })]);
  const improving = apply(rewritten(known, 2, checkEvidence(1)), checksRecorded(2, { 'surface-test': FAILED(2) }));
  const last = apply(rewritten(improving, 3, checkEvidence(2)), checksRecorded(3, { 'surface-test': FAILED(null) }));
  assert.equal(cycleOf(last).stopReason, STOP.COMPARISON_UNAVAILABLE);
  // A writer that keeps reporting BLOCKED has no metric either.
  const blockedTwice = chain(apply(writing(), writerRecorded(1, 'BLOCKED')), [
    admitted(retryRequest({ evidence: writerRecorded(1).evidence[0] })), reserved(2, 'correction'),
    authorized(2, 'writer'), writerRecorded(2, 'BLOCKED'),
  ]);
  assert.equal(cycleOf(blockedTwice).diagnosisRequired, true);
});

test('a different defect is not stagnation but still needs an admitted retry and a free slot', () => {
  const first = chain(written(), [checksRecorded(1, { 'surface-test': FAILED(3) })]);
  const different = apply(rewritten(first, 2, checkEvidence(1)), checksRecorded(2, { 'coherence-gate': FAILED(1) }));
  assert.equal(cycleOf(different).status, 'OPEN');
  assert.equal(cycleOf(different).iterations[1].conclusion.comparison.verdict, 'progress');
  refused(applyCorrectionRecord(different, reserved(3, 'correction')), REFUSAL.RETRY_REQUIRED);
  const third = apply(rewritten(different, 3, checkEvidence(2, 'coherence-gate')),
    checksRecorded(3, { 'surface-test': FAILED(5) }));
  assert.equal(cycleOf(third).stopReason, STOP.EXHAUSTED);
  // The previous comparable outcome skips interruptions: iteration 3 compares with iteration 1.
  const interruptedTwo = chain(first, [admitted(retryRequest({ evidence: checkEvidence(1) })), reserved(2, 'correction'),
    authorized(2, 'writer'), [interrupted(2), { ref: ref(6) }]]);
  const afterInterruption = apply(rewritten(interruptedTwo, 3, ref(6)), checksRecorded(3, { 'surface-test': FAILED(3) }));
  assert.equal(cycleOf(afterInterruption).stopReason, STOP.STAGNATED);
});

// --- candidate ranking ----------------------------------------------------------------------------

const ranked = (state, key = 'task-1#1') => rankCandidates(state.cycles[key]);
const order = (state, key) => ranked(state, key).map((candidate) => candidate.iteration);

test('rankCandidates: the verified candidate beats the unverified baseline', () => {
  const opening = ranked(cycleState());
  assert.deepEqual(opening, [{
    iteration: 0, observation: OBSERVATION, candidate: null, verified: false, verifiedBy: null, blocking: null,
    satisfied: 0, commandMetric: null, rubricScore: null, approved: false,
  }]);
  const failed = chain(written(), [checksRecorded(1, { 'surface-test': FAILED(3) })]);
  const [best, baseline] = ranked(failed);
  assert.deepEqual(best, {
    iteration: 1, observation: CANDIDATE(1), candidate: writerRecorded(1).candidate, verified: true, verifiedBy: 1,
    // Two failed surface-test bindings block; the two gate bindings are satisfied.
    blocking: 2, satisfied: 2, commandMetric: 3, rubricScore: 0, approved: false,
  });
  assert.equal(baseline.iteration, 0);
  assert.equal(baseline.verified, false);
  // An accepted writer not yet verified ranks after the baseline: ties keep the earlier candidate.
  assert.deepEqual(order(written()), [0, 1]);
});

test('rankCandidates orders by blocking defects, satisfied bindings, metric sums, then the earlier iteration', () => {
  const first = chain(written(), [checksRecorded(1, { 'surface-test': FAILED(3), 'coherence-gate': FAILED(1) })]);
  const fewerBlocking = apply(rewritten(first, 2, checkEvidence(1)), checksRecorded(2, { 'surface-test': FAILED(9) }));
  assert.deepEqual(order(fewerBlocking), [2, 1, 0]);
  const lower = chain(written(), [checksRecorded(1, { 'surface-test': FAILED(3) })]);
  const better = apply(rewritten(lower, 2, checkEvidence(1)), checksRecorded(2, { 'surface-test': FAILED(1) }));
  assert.deepEqual(order(better), [2, 1, 0]);
  const tied = apply(rewritten(lower, 2, checkEvidence(1)), checksRecorded(2, { 'surface-test': FAILED(3) }));
  assert.deepEqual(order(tied), [1, 2, 0]);
  // A failed check with no metric ranks after a known one.
  const unknown = apply(rewritten(lower, 2, checkEvidence(1)), checksRecorded(2, { 'surface-test': FAILED(null) }));
  assert.deepEqual(order(unknown), [1, 2, 0]);
  assert.equal(ranked(unknown)[1].commandMetric, null);
  // The review and the rubric count: issues found leave fewer bindings satisfied.
  const twoIssues = issuesFound([defectEntry({ severity: 'important' }),
    defectEntry({ criterion: 'SC2', cause: 'unclear-name' })]);
  const [candidate] = ranked(twoIssues);
  assert.deepEqual([candidate.blocking, candidate.satisfied, candidate.rubricScore], [2, 5, 8]);
  const oneIssue = reviewedAgain(twoIssues,
    [defectEntry({ criterion: 'SC2', cause: 'unclear-name', severity: 'important' })]);
  assert.equal(cycleOf(oneIssue).status, 'OPEN');
  assert.deepEqual(ranked(oneIssue).map(({ iteration, blocking, satisfied }) => [iteration, blocking, satisfied]),
    [[2, 1, 6], [1, 2, 5], [0, null, 0]]);
});

test('rankCandidates attributes verification and approval only to the candidate an iteration verified', () => {
  // Iteration 2's writer restores the opening tree: the same digest as the baseline, but its own candidate.
  const failed = chain(written(), [checksRecorded(1, { 'surface-test': FAILED(3) })]);
  const restored = chain(failed, [
    admitted(retryRequest({ evidence: checkEvidence(1) })), reserved(2, 'correction'), authorized(2, 'writer'),
    writerRecorded(2, 'DONE', { observation: OBSERVATION }),
    checksRecorded(2, {}, { observation: OBSERVATION }), authorized(2, 'task-reviewer'),
    reviewRecorded(2, 'APPROVED', { before: OBSERVATION, after: OBSERVATION }),
  ]);
  assert.equal(cycleOf(restored).approvedObservation, OBSERVATION);
  const candidates = ranked(restored);
  const summary = ({ iteration, verified, verifiedBy, approved }) => [iteration, verified, verifiedBy, approved];
  assert.deepEqual(candidates.map(summary),
    [[2, true, 2, true], [1, true, 1, false], [0, false, null, false]]);
  assert.deepEqual([candidates[0].blocking, candidates[0].satisfied, candidates[0].rubricScore], [0, 7, 8]);
  // A writerless correction verifies the latest accepted candidate, not the baseline.
  const reviewOnly = chain(failed, [
    admitted(retryRequest({ evidence: checkEvidence(1) })), reserved(2, 'correction'), authorized(2, 'task-reviewer'),
    checksRecorded(2, {}, { observation: CANDIDATE(1) }),
  ]);
  assert.deepEqual(ranked(reviewOnly).map(({ iteration, verifiedBy }) => [iteration, verifiedBy]), [[1, 2], [0, null]]);
  // Without any writer, the checks verify the baseline.
  const baseline = chain(cycleState('final'), [reserved(1, 'initial', null, 'final'),
    checksRecorded(1, {}, { observation: OBSERVATION }, 'final')]);
  assert.deepEqual(ranked(baseline, 'final#1').map(summary), [[0, true, 1, false]]);
});

test('rankCandidates throws TypeError for a cycle this module did not produce', () => {
  const state = cycleState();
  for (const foreign of [undefined, null, {}, state, structuredClone(state.cycles['task-1#1']),
    { ...state.cycles['task-1#1'] }]) {
    assert.throws(() => rankCandidates(foreign), { name: 'TypeError', message: /^rankCandidates: /u });
  }
});

test('nextCorrectionStep names the next outcome: the writer, then the checks, then each authorized reviewer', () => {
  const at = { scope: 'task-1', cycle: 1, iteration: 1 };
  assert.deepEqual(nextCorrectionStep(written()), { action: 'checks', ...at });
  assert.deepEqual(nextCorrectionStep(apply(written(), authorized(1, 'task-reviewer'))), { action: 'checks', ...at });
  const checked = apply(written(), checksRecorded(1));
  assert.deepEqual(nextCorrectionStep(checked), { action: 'authorize', ...at, role: 'task-reviewer' });
  assert.deepEqual(nextCorrectionStep(reviewing()), { action: 'record', ...at, role: 'task-reviewer' });
  // A final iteration checks the tree before its final review is recorded.
  const finalAt = { scope: 'final', cycle: 1, iteration: 1 };
  const finalReviewer = chain(cycleState('final'), [reserved(1, 'initial', null, 'final'),
    authorized(1, 'final-reviewer', {}, 'final')]);
  assert.deepEqual(nextCorrectionStep(finalReviewer), { action: 'checks', ...finalAt });
  const finalChecked = apply(finalReviewer, checksRecorded(1, {}, { observation: OBSERVATION }, 'final'));
  assert.deepEqual(nextCorrectionStep(finalChecked), { action: 'record', ...finalAt, role: 'final-reviewer' });
  // A final correction records its authorized task review before the final review.
  const correcting = finalCorrection('2', ['SC3'], true);
  assert.deepEqual(nextCorrectionStep(correcting),
    { action: 'record', scope: 'final', cycle: 1, iteration: 2, role: 'task-reviewer' });
  // Without a review, the checks conclude the iteration.
  const skipped = chain(opened(), [cycleOpened('task-1', {
    bindings: [commandBinding('SC1', 'surface-test'), gateBinding('SC1'), commandBinding('SC2', 'surface-test'),
      gateBinding('SC2')],
    rubricCriteria: [],
    review: 'skipped',
  }), reserved(1, 'initial'), authorized(1, 'writer'), writerRecorded(1)]);
  assert.deepEqual(nextCorrectionStep(skipped), { action: 'checks', ...at });
});

test('replay of an outcome sequence equals incremental application and keeps the state frozen', () => {
  const records = [
    runOpened(), cycleOpened(), reserved(1, 'initial'), authorized(1, 'writer'), writerRecorded(1),
    checksRecorded(1, { 'surface-test': FAILED(3) }),
    admitted(retryRequest({ evidence: checkEvidence(1) })), reserved(2, 'correction'), authorized(2, 'writer'),
    writerRecorded(2), checksRecorded(2), authorized(2, 'task-reviewer'),
    reviewRecorded(2, 'APPROVED', { defects: [rubricDefect('clarity')], rubric: [rubricEntry('SC1', { clarity: 1 })] }),
    // The approving-but-failed review of iteration 2 is record 13; its ref binds the retry.
    admitted(retryRequest({ iteration: 3, evidence: ref(13, '6'), remedy: REMEDIES[3] })),
    reserved(3, 'correction'), authorized(3, 'writer'), writerRecorded(3), checksRecorded(3),
    authorized(3, 'task-reviewer'), reviewRecorded(3),
  ];
  const refs = records.map((_record, index) => ref(index + 1, 'abcdef0123456789'[index % 16]));
  const incremental = records.reduce((state, record, index) => apply(state, record, { ref: refs[index] }),
    createCorrectionState());
  const replayed = ok(replayCorrectionRecords(records, { refs }));
  assert.deepEqual(replayed, incremental);
  assert.ok(isDeepFrozen(replayed));
  assert.equal(cycleOf(replayed).status, 'APPROVED');
  assert.equal(cycleOf(replayed).approvedObservation, CANDIDATE(3));
  assert.deepEqual(rankCandidates(cycleOf(replayed)).map(({ iteration, approved }) => [iteration, approved]),
    [[3, true], [2, false], [1, false], [0, false]]);
});

test('outcome records refuse malformed nested data without throwing', () => {
  const weird = [null, 1, 'x', [null], [1], [[]], [{}], [{ criterion: 'toString' }], [{ __proto__: null }]];
  const cases = [];
  for (const value of weird) {
    cases.push([reviewing(), reviewRecorded(1, 'APPROVED', { defects: value })]);
    cases.push([reviewing(), reviewRecorded(1, 'ISSUES_FOUND', { rubric: value })]);
    cases.push([written(), checksRecorded(1, {}, { checks: value })]);
    cases.push([writing(), writerRecorded(1, 'DONE', { evidence: value })]);
  }
  for (const [index, [state, record]] of cases.entries()) {
    let result;
    assert.doesNotThrow(() => { result = applyCorrectionRecord(state, record); }, `case ${index}`);
    assert.equal(result.ok, false, `case ${index}`);
  }
});

// --- fix 1: unsatisfied rubric constraints ---------------------------------------------------------

const violatedRubric = (criterion = 'SC1', id = 'node-builtins-only') =>
  [rubricEntry(criterion, {}, [{ id, satisfied: false, evidence: 'the module imports a package' }])];

test('validateRubric: an unsatisfied constraint needs a blocking review defect with a correction on its criterion', () => {
  const violated = [rubricEntry('SC1', {}, [
    { id: 'node-builtins-only', satisfied: true, evidence: 'no imports' },
    { id: 'no-time-conditions', satisfied: false, evidence: 'a deadline option exists' },
  ])];
  const unbacked = rubricRefusal(violated, REVIEW_CODES.RUBRIC_UNSUPPORTED);
  assert.deepEqual(unbacked.identity, { criterion: 'SC1', constraint: 'no-time-conditions' });
  for (const defects of [
    [defectEntry({ severity: 'minor' })],
    [rubricDefect('clarity', { severity: 'critical' })],
    [defectEntry({ criterion: 'SC2' })],
    [defectEntry({ correction: '  ' })],
  ]) {
    rubricRefusal(violated, REVIEW_CODES.RUBRIC_UNSUPPORTED, defects);
  }
  for (const defects of [[defectEntry()], [defectEntry({ severity: 'important' })], normalized([defectEntry()])]) {
    assert.deepEqual(rubricResult(violated, defects), {
      ok: true, approved: false, criteria: [{ criterion: 'SC1', score: 8, constraintsSatisfied: false, approved: false }],
    });
  }
});

test('REVIEW_RECORDED: an unsatisfied constraint is refused unbacked, inconsistent if APPROVED, else carries feedback', () => {
  const opening = cycleOpened('task-2', {
    bindings: [commandBinding('SC3', 'surface-test'), gateBinding('SC3'), reviewBinding('SC3'), rubricBinding('SC3')],
    rubricCriteria: ['SC3'],
  });
  const state = chain(approvedOne(), [opening, reserved(1, 'initial', null, 'task-2'), authorized(1, 'writer', {}, 'task-2'),
    writerRecorded(1, 'DONE', {}, 'task-2'), checksRecorded(1, {}, {}, 'task-2'),
    authorized(1, 'task-reviewer', {}, 'task-2')]);
  const review = (status, defects) => reviewRecorded(1, status, { defects, rubric: violatedRubric('SC3', 'k') },
    'task-reviewer', 'task-2');
  const unbacked = refused(applyCorrectionRecord(state, review('APPROVED', [])), REVIEW_CODES.RUBRIC_UNSUPPORTED);
  assert.deepEqual(unbacked.identity, { kind: 'REVIEW_RECORDED', scope: 'task-2', cycle: 1, iteration: 1 });
  const backing = defectEntry({ criterion: 'SC3', cause: 'constraint-violated' });
  refused(applyCorrectionRecord(state, review('APPROVED', [backing])), REVIEW_CODES.STATUS_INCONSISTENT);
  const issues = apply(state, review('ISSUES_FOUND', [backing]));
  const { conclusion } = issues.cycles['task-2#1'].iterations[0];
  assert.equal(conclusion.approved, false);
  assert.deepEqual(conclusion.defects.map((defect) => defect.id), ['SC3/review/constraint-violated']);
  assertFeedback(conclusion.defects[0]);
});

test('a repeated unsatisfied constraint stagnates instead of reading as progress with no defect', () => {
  refused(applyCorrectionRecord(reviewing(), reviewRecorded(1, 'APPROVED', { rubric: violatedRubric() })),
    REVIEW_CODES.RUBRIC_UNSUPPORTED);
  const backing = [defectEntry({ cause: 'third-party-import' })];
  const first = apply(reviewing(), reviewRecorded(1, 'ISSUES_FOUND', { defects: backing, rubric: violatedRubric() }));
  const second = chain(rewritten(first, 2, reviewRecorded(1).evidence[0]), [
    checksRecorded(2), authorized(2, 'task-reviewer'),
    reviewRecorded(2, 'ISSUES_FOUND', { defects: backing, rubric: violatedRubric() }),
  ]);
  const { comparison } = cycleOf(second).iterations[1].conclusion;
  assert.notDeepEqual(comparison, { verdict: 'progress', defects: [] });
  assert.equal(comparison.verdict, 'stagnant');
  assert.equal(cycleOf(second).stopReason, STOP.STAGNATED);
});

// --- fix 1: final-correction steps ----------------------------------------------------------------

// Task 1 (mechanical, review skipped) and task 2 (design) approved and task 4 stopped with its isolation
// proven, then the final cycle opened on tasks 1 and 2.
function deliveredFinal(rubricCriteria = []) {
  const [mechanical, design] = plan();
  return apply(taskFourStopped(), cycleOpened('final', {
    ...deriveCycleBindings({ scope: 'final', deliveredTasks: [mechanical, design], rubricCriteria }), rubricCriteria,
  }));
}

// The final review of iteration 1 finds an SC3 issue; iteration 2's writer changes `ownerTask` and passes the checks.
function finalOwnedBy(ownerTask, affectedCriteria, rubricCriteria = [], finalRubric = []) {
  const finalReview = reviewRecorded(1, 'ISSUES_FOUND', {
    before: OBSERVATION, after: OBSERVATION, rubric: finalRubric,
    defects: [defectEntry({ criterion: 'SC3', cause: 'missing-design-note' })],
  }, 'final-reviewer', 'final');
  return chain(deliveredFinal(rubricCriteria), [
    reserved(1, 'initial', null, 'final'), authorized(1, 'final-reviewer', {}, 'final'),
    checksRecorded(1, {}, { observation: OBSERVATION }, 'final', 1, FINAL_CHECK_IDS), finalReview,
    admitted(finalRetryRequest({ target: 'SC3', confirmingCheck: 'review', evidence: finalReview.evidence[0] })),
    reserved(2, 'correction', null, 'final'), authorized(2, 'writer', { ownerTask, affectedCriteria }, 'final'),
    writerRecorded(2, 'DONE', {}, 'final'), checksRecorded(2, {}, {}, 'final', 1, FINAL_CHECK_IDS),
  ]);
}

test('nextCorrectionStep steers a design-owned final correction through an approved task review', () => {
  const at = { scope: 'final', cycle: 1, iteration: 2 };
  const state = finalOwnedBy('2', ['SC3']);
  const authorizeTaskReview = { action: 'authorize', ...at, role: 'task-reviewer', ownerTask: '2' };
  assert.deepEqual(nextCorrectionStep(state), authorizeTaskReview);
  const finalFirst = apply(state, authorized(2, 'final-reviewer', {}, 'final'));
  assert.deepEqual(nextCorrectionStep(finalFirst), authorizeTaskReview);
  // Following the steps to the end never meets FINAL_BYPASS.
  const taskReviewer = apply(finalFirst, authorized(2, 'task-reviewer', { ownerTask: '2' }, 'final'));
  assert.deepEqual(nextCorrectionStep(taskReviewer), { action: 'record', ...at, role: 'task-reviewer' });
  const taskApproved = apply(taskReviewer,
    reviewRecorded(2, 'APPROVED', { ownerTask: '2', rubric: [] }, 'task-reviewer', 'final'));
  assert.deepEqual(nextCorrectionStep(taskApproved), { action: 'record', ...at, role: 'final-reviewer' });
  const approved = apply(taskApproved, reviewRecorded(2, 'APPROVED', { rubric: [] }, 'final-reviewer', 'final'));
  assert.equal(approved.cycles['final#1'].status, 'APPROVED');
  const direct = chain(state, [authorized(2, 'task-reviewer', { ownerTask: '2' }, 'final'),
    reviewRecorded(2, 'APPROVED', { ownerTask: '2', rubric: [] }, 'task-reviewer', 'final')]);
  assert.deepEqual(nextCorrectionStep(direct), { action: 'authorize', ...at, role: 'final-reviewer' });
  // A mechanical owner steps straight to the final review.
  assert.deepEqual(nextCorrectionStep(finalOwnedBy('1', ['SC1'])), { action: 'authorize', ...at, role: 'final-reviewer' });
});

// --- fix 1: comparable command defects without a criterion ---------------------------------------

test('compareOutcomes compares a command-check defect without a bound criterion, and reports raw metrics', () => {
  for (const id of ['*/surface-test/command-failed', '*/surface-test-2/command-failed', '*/coherence-gate/command-failed']) {
    assert.deepEqual(comparison(outcome(outcomeDefect(id, 3)), outcome(outcomeDefect(id, 3)), []),
      { verdict: 'stagnant', defects: [{ id, previous: 3, current: 3, result: 'stagnant' }] });
    assert.equal(comparison(outcome(outcomeDefect(id, 3)), outcome(outcomeDefect(id, 1)), []).verdict, 'progress');
  }
  // Without a direction the result is unavailable, but the known metrics are still reported.
  const unbound = 'SC9/review/missing-test';
  assert.deepEqual(comparison(outcome(outcomeDefect(unbound, 3)), outcome(outcomeDefect(unbound, 1))).defects,
    [{ id: unbound, previous: 3, current: 1, result: 'unavailable' }]);
  assert.deepEqual(comparison(outcome(outcomeDefect(unbound, 3)), outcome(outcomeDefect('SC8/review/x', 2))).defects,
    [{ id: 'SC8/review/x', previous: null, current: 2, result: 'new' }]);
});

test('a task without criteria stagnates on a repeated command failure', () => {
  const firstFailure = chain(cycleState('task-4'), [
    reserved(1, 'initial', null, 'task-4'), authorized(1, 'writer', {}, 'task-4'), writerRecorded(1, 'DONE', {}, 'task-4'),
    checksRecorded(1, { 'surface-test': FAILED(3) }, {}, 'task-4'),
    admitted(retryRequest({
      scope: 'task-4', target: 'surface-test', evidence: checkEvidence(1, 'surface-test', 'task-4'),
    })),
    reserved(2, 'correction', null, 'task-4'), authorized(2, 'writer', {}, 'task-4'),
    writerRecorded(2, 'DONE', {}, 'task-4'),
  ]);
  const repeated = apply(firstFailure, checksRecorded(2, { 'surface-test': FAILED(3) }, {}, 'task-4'));
  assert.equal(repeated.cycles['task-4#1'].stopReason, STOP.STAGNATED);
  assert.equal(repeated.cycles['task-4#1'].diagnosisRequired, false);
  const improved = apply(firstFailure, checksRecorded(2, { 'surface-test': FAILED(1) }, {}, 'task-4'));
  assert.equal(improved.cycles['task-4#1'].status, 'OPEN');
  assert.deepEqual(improved.cycles['task-4#1'].iterations[1].conclusion.comparison.defects,
    [{ id: '*/surface-test/command-failed', previous: 3, current: 1, result: 'improved' }]);
});

// --- fix 1: rubric bindings for a review ---------------------------------------------------------

test('reviewRubricBindings keeps a final-scope task review to its owner task\'s rubric criteria', () => {
  const [mechanical, design] = plan();
  const { bindings } = deriveCycleBindings({
    scope: 'final', deliveredTasks: [mechanical, design], rubricCriteria: ['SC1', 'SC3'],
  });
  const ownerRubric = reviewRubricBindings({ scope: 'final', bindings, role: 'task-reviewer', ownerTask: mechanical });
  assert.deepEqual(ownerRubric, [rubricBinding('SC1')]);
  assert.deepEqual(reviewRubricBindings({ scope: 'final', bindings, role: 'final-reviewer', ownerTask: null }),
    [rubricBinding('SC1'), rubricBinding('SC3')]);
  assert.deepEqual(reviewRubricBindings({
    scope: 'task-1', bindings: cycleOpened().bindings, role: 'task-reviewer', ownerTask: null,
  }), [rubricBinding('SC1')]);
  // The filtered call validates a task review that scores only its owner task's criteria.
  assert.equal(validateRubric({ bindings: ownerRubric, rubric: [rubricEntry('SC1')], defects: [] }).ok, true);
  assert.equal(validateRubric({ bindings, rubric: [rubricEntry('SC1')], defects: [] }).code,
    REVIEW_CODES.RUBRIC_COVERAGE);
  for (const call of [
    undefined,
    { scope: 'final', bindings, role: 'task-reviewer' },
    { scope: 'final', bindings, role: 'task-reviewer', ownerTask: mechanical, extra: 1 },
    { scope: 'final', bindings, role: 'task-reviewer', ownerTask: null },
    { scope: 'final', bindings, role: 'task-reviewer', ownerTask: '1' },
    { scope: 'final', bindings, role: 'writer', ownerTask: null },
    { scope: 'final', bindings, role: 'final-reviewer', ownerTask: mechanical },
    { scope: 'task-1', bindings, role: 'task-reviewer', ownerTask: mechanical },
    { scope: 'task', bindings, role: 'task-reviewer', ownerTask: null },
    { scope: 'task-1', bindings, role: 'final-reviewer', ownerTask: null },
    { scope: 'final', bindings: 'all', role: 'final-reviewer', ownerTask: null },
  ]) {
    assert.throws(() => reviewRubricBindings(call), { name: 'TypeError', message: /^reviewRubricBindings: /u });
  }
});

test('REVIEW_RECORDED scores a final-scope task review on its owner task\'s rubric criteria only', () => {
  const state = apply(finalOwnedBy('2', ['SC3'], ['SC1', 'SC3'], [rubricEntry('SC1'), rubricEntry('SC3')]),
    authorized(2, 'task-reviewer', { ownerTask: '2' }, 'final'));
  const taskReview = (rubric) => reviewRecorded(2, 'APPROVED', { ownerTask: '2', rubric }, 'task-reviewer', 'final');
  refused(applyCorrectionRecord(state, taskReview([rubricEntry('SC1'), rubricEntry('SC3')])), REVIEW_CODES.RUBRIC_COVERAGE);
  const reviewed = apply(state, taskReview([rubricEntry('SC3')]));
  assert.deepEqual(reviewed.cycles['final#1'].iterations[1].reviews[0].rubric.criteria.map((item) => item.criterion),
    ['SC3']);
});

// --- run-level scheduling -------------------------------------------------------------------------

// Task 2 depends on task 1, task 3 on task 2, and task 4 on nothing. Every task is mechanical, so it
// skips review and approves on its passed checks.
function closurePlan() {
  return ['1', '2', '3', '4'].map((task) => ({
    task, dependencies: { 2: ['1'], 3: ['2'] }[task] ?? [], complexity: 'mechanical', criterionIds: [`SC${task}`],
    testCommand: 'npm test',
  }));
}

function closureRun(overrides = {}) {
  return apply(createCorrectionState(), runOpened({ tasks: closurePlan(), ...overrides }));
}

function taskOpened(task, overrides = {}) {
  const scope = `task-${task}`;
  const planned = closurePlan().find((entry) => entry.task === task);
  return {
    kind: 'CYCLE_OPENED', scope, cycle: 1, predecessor: null, ...deriveCycleBindings({ scope, task: planned }),
    rubricCriteria: [], observation: OBSERVATION, ...overrides,
  };
}

// The records that open, write and check `task` (of the closure plan) to approval in `cycle`.
function approvalRecords(task, cycle = 1) {
  const scope = `task-${task}`;
  return [
    taskOpened(task, { cycle, predecessor: cycle === 1 ? null : `${scope}#${cycle - 1}` }),
    reserved(1, 'initial', null, scope, cycle), authorized(1, 'writer', {}, scope, cycle),
    writerRecorded(1, 'DONE', {}, scope, cycle), checksRecorded(1, {}, {}, scope, cycle),
  ];
}

function approvedTask(state, task, cycle = 1) {
  return chain(state, approvalRecords(task, cycle));
}

// The final opening on the closure-plan tasks `delivered`.
function closureFinal(delivered, overrides = {}) {
  return {
    kind: 'CYCLE_OPENED', scope: 'final', cycle: 1, predecessor: null,
    ...deriveCycleBindings({
      scope: 'final', deliveredTasks: closurePlan().filter((entry) => delivered.includes(entry.task)),
    }),
    rubricCriteria: [], observation: OBSERVATION, ...overrides,
  };
}

// The records that reserve the initial final iteration and approve it: checks, then the final review.
function finalApprovalRecords(cycle = 1) {
  return [
    reserved(1, 'initial', null, 'final', cycle), authorized(1, 'final-reviewer', {}, 'final', cycle),
    checksRecorded(1, {}, { observation: OBSERVATION }, 'final', cycle, FINAL_CHECK_IDS),
    reviewRecorded(1, 'APPROVED', { before: OBSERVATION, after: OBSERVATION, rubric: [] }, 'final-reviewer', 'final',
      cycle),
  ];
}

function approvedFinal(state, cycle = 1) {
  return chain(state, finalApprovalRecords(cycle));
}

test('prerequisite closure: a stopped task blocks its transitive dependents, and an independent task still runs', () => {
  const run = closureRun();
  assert.deepEqual(nextCorrectionStep(run), { action: 'open-cycle', scope: 'task-1' });
  for (const task of ['2', '3', '4']) {
    const result = refused(applyCorrectionRecord(run, taskOpened(task)), REFUSAL.SCOPE_NOT_RUNNABLE);
    assert.deepEqual(result.identity, { kind: 'CYCLE_OPENED', scope: `task-${task}`, cycle: 1 });
  }
  refused(applyCorrectionRecord(run, closureFinal([])), REFUSAL.SCOPE_NOT_RUNNABLE);
  const stoppedOne = chain(run, [taskOpened('1'), stopped(STOP.HUMAN_INTERRUPTED)]);
  assert.deepEqual(nextCorrectionStep(stoppedOne), { action: 'prove-isolation', scope: 'task-1', cycle: 1 });
  refused(applyCorrectionRecord(stoppedOne, taskOpened('4')), REFUSAL.ISOLATION_REQUIRED);
  refused(applyCorrectionRecord(stoppedOne, closureFinal([])), REFUSAL.ISOLATION_REQUIRED);
  const isolated = apply(stoppedOne, isolationRecorded());
  // Tasks 2 and 3 are blocked by task 1; task 4 is independent and runs.
  assert.deepEqual(summarizeCorrectionRun(isolated).blocked, [{ task: '2', causes: ['1'] }, { task: '3', causes: ['1'] }]);
  assert.deepEqual(nextCorrectionStep(isolated), { action: 'open-cycle', scope: 'task-4' });
  for (const task of ['2', '3']) refused(applyCorrectionRecord(isolated, taskOpened(task)), REFUSAL.SCOPE_NOT_RUNNABLE);
  refused(applyCorrectionRecord(isolated, closureFinal([])), REFUSAL.SCOPE_NOT_RUNNABLE);
  const four = approvedTask(isolated, '4');
  assert.equal(four.cycles['task-4#1'].status, 'APPROVED');
  assert.deepEqual(nextCorrectionStep(four), { action: 'open-cycle', scope: 'final' });
  for (const task of ['2', '3', '4']) refused(applyCorrectionRecord(four, taskOpened(task)), REFUSAL.SCOPE_NOT_RUNNABLE);
  refused(applyCorrectionRecord(four, taskOpened('1')), REFUSAL.REOPEN_INVALID);
});

test('blocked tasks never get a cycle and consume no iteration, through to the end of the run', () => {
  const four = approvedTask(chain(closureRun(), [taskOpened('1'), stopped(STOP.HUMAN_INTERRUPTED), isolationRecorded()]),
    '4');
  const finished = approvedFinal(apply(four, closureFinal(['4'])));
  assert.equal(finished.cycles['final#1'].status, 'APPROVED');
  assert.deepEqual(finished.cycleOrder, ['task-1#1', 'task-4#1', 'final#1']);
  assert.equal(nextCorrectionStep(finished).action, 'terminal');
  for (const task of ['2', '3']) {
    assert.ok(!Object.keys(finished.cycles).some((key) => key.startsWith(`task-${task}#`)));
    refused(applyCorrectionRecord(finished, taskOpened(task)), REFUSAL.SCOPE_NOT_RUNNABLE);
  }
});

// --- isolation ------------------------------------------------------------------------------------

// Task 1 (review required) reaches a verified candidate whose checks all pass, but its review finds an
// issue; the cycle then stops.
function stoppedWithPassingCandidate() {
  return chain(reviewing(), [reviewRecorded(1, 'ISSUES_FOUND', { defects: [defectEntry()] }),
    stopped(STOP.RETRY_EVIDENCE_MISSING)]);
}

test('decideIsolation: baseline-equal for the opening tree, retained-best for a verified passing best candidate', () => {
  const state = stoppedWithPassingCandidate();
  const decide = (observation) => decideIsolation(state, { scope: 'task-1', cycle: 1, observation });
  assert.deepEqual(decide(OBSERVATION), { proven: true, mode: 'baseline-equal' });
  assert.deepEqual(decide(CANDIDATE(1)), { proven: true, mode: 'retained-best' });
  assert.deepEqual(decide(hex('5')), {
    proven: false,
    recovery: {
      bestCandidate: { iteration: 1, observation: CANDIDATE(1), snapshot: writerRecorded(1).candidate },
      baselineObservation: OBSERVATION,
      changedPaths: writerRecorded(1).changedPaths,
    },
  });
  // A best candidate whose checks failed is not retained.
  const failed = chain(written(), [checksRecorded(1, { 'surface-test': FAILED(3) }), stopped(STOP.RETRY_EVIDENCE_MISSING)]);
  assert.equal(decideIsolation(failed, { scope: 'task-1', cycle: 1, observation: CANDIDATE(1) }).proven, false);
  // An unverified candidate ranks after the baseline, which is then the best candidate.
  const unverified = apply(written(), stopped(STOP.HUMAN_INTERRUPTED));
  assert.deepEqual(decideIsolation(unverified, { scope: 'task-1', cycle: 1, observation: CANDIDATE(1) }), {
    proven: false,
    recovery: {
      bestCandidate: { iteration: 0, observation: OBSERVATION, snapshot: null },
      baselineObservation: OBSERVATION,
      changedPaths: writerRecorded(1).changedPaths,
    },
  });
});

test('decideIsolation: the recovery names the sorted union of every writer\'s changed paths', () => {
  const first = chain(written(), [checksRecorded(1, { 'surface-test': FAILED(3) })]);
  const state = chain(first, [
    admitted(retryRequest({ evidence: checkEvidence(1) })), reserved(2, 'correction'), authorized(2, 'writer'),
    writerRecorded(2, 'BLOCKED', { changedPaths: ['docs/a.md', 'scripts/correction-state.mjs'] }),
    stopped(STOP.HUMAN_INTERRUPTED),
  ]);
  const decision = decideIsolation(state, { scope: 'task-1', cycle: 1, observation: hex('5') });
  assert.deepEqual(decision.recovery.changedPaths,
    ['docs/a.md', 'scripts/correction-state.mjs', 'tests/correction-state.test.mjs']);
});

test('decideIsolation throws TypeError on a malformed call', () => {
  const state = stoppedWithPassingCandidate();
  const input = { scope: 'task-1', cycle: 1, observation: OBSERVATION };
  for (const foreign of [null, {}, structuredClone(state)]) {
    assert.throws(() => decideIsolation(foreign, input), { name: 'TypeError', message: /^decideIsolation: /u });
  }
  for (const call of [undefined, 'task-1', { ...input, extra: 1 }, { scope: 'task-1', cycle: 1 },
    { ...input, scope: 'task' }, { ...input, cycle: 0 }, { ...input, observation: 'b' }, { ...input, scope: 'task-2' },
    { ...input, cycle: 2 }]) {
    assert.throws(() => decideIsolation(state, call), { name: 'TypeError', message: /^decideIsolation: /u });
  }
});

test('ISOLATION_RECORDED must match a proven decision for the latest stopped task cycle', () => {
  const state = stoppedWithPassingCandidate();
  assert.deepEqual(nextCorrectionStep(state), { action: 'prove-isolation', scope: 'task-1', cycle: 1 });
  const retained = apply(state, isolationRecorded('task-1', 1, 'retained-best', CANDIDATE(1)));
  assert.deepEqual(retained.cycles['task-1#1'].isolation, { mode: 'retained-best', observation: CANDIDATE(1) });
  // Tasks 2 and 4 depend on the stopped task 1, so the final opens on nothing delivered.
  assert.deepEqual(nextCorrectionStep(retained), { action: 'open-cycle', scope: 'final' });
  apply(retained, cycleOpened('final', NOTHING_DELIVERED));
  const baseline = apply(state, isolationRecorded());
  assert.deepEqual(baseline.cycles['task-1#1'].isolation, { mode: 'baseline-equal', observation: OBSERVATION });

  // The mode must be the proven one.
  refused(applyCorrectionRecord(state, isolationRecorded('task-1', 1, 'baseline-equal', CANDIDATE(1))),
    REFUSAL.RECORD_SCHEMA);
  refused(applyCorrectionRecord(state, isolationRecorded('task-1', 1, 'retained-best', OBSERVATION)),
    REFUSAL.RECORD_SCHEMA);
  for (const record of [isolationRecorded('task-1', 1, 'restored'), isolationRecorded('final'),
    isolationRecorded('task-1', 0), isolationRecorded('task-1', 1, 'baseline-equal', 'b')]) {
    const result = refused(applyCorrectionRecord(state, record), REFUSAL.RECORD_SCHEMA);
    assert.doesNotMatch(result.message, /unknown record kind/u);
  }
  // Only the latest stopped task cycle, once, with no cycle open.
  refused(applyCorrectionRecord(baseline, isolationRecorded()), REFUSAL.RECORD_ORDER);
  refused(applyCorrectionRecord(opened(), isolationRecorded()), REFUSAL.RECORD_ORDER);
  refused(applyCorrectionRecord(cycleState(), isolationRecorded()), REFUSAL.RECORD_ORDER);
  refused(applyCorrectionRecord(approvedOne(), isolationRecorded()), REFUSAL.RECORD_ORDER);
  refused(applyCorrectionRecord(state, isolationRecorded('task-2')), REFUSAL.RECORD_ORDER);
  refused(applyCorrectionRecord(state, isolationRecorded('task-1', 2)), REFUSAL.RECORD_ORDER);
});

test('an unprovable isolation refuses ISOLATION_RECORDED with INTEGRITY, and the run must halt', () => {
  const state = stoppedWithPassingCandidate();
  for (const mode of ['baseline-equal', 'retained-best']) {
    const result = refused(applyCorrectionRecord(state, isolationRecorded('task-1', 1, mode, hex('5'))), HALT.INTEGRITY);
    assert.deepEqual(result.identity, { kind: 'ISOLATION_RECORDED', scope: 'task-1', cycle: 1 });
  }
  // The guard answers with RUN_HALTED: never a task-local result, and nothing continues.
  const haltedRun = apply(state, halted({ reason: 'isolation could not be proven', observation: hex('5') }));
  assert.deepEqual(nextCorrectionStep(haltedRun), { action: 'halted', reason: 'isolation could not be proven' });
  assert.equal(haltedRun.cycles['task-1#1'].isolation, null);
  refused(applyCorrectionRecord(haltedRun, isolationRecorded()), REFUSAL.RUN_HALTED);
  refused(applyCorrectionRecord(haltedRun, cycleOpened('final', NOTHING_DELIVERED)), REFUSAL.RUN_HALTED);
});

// --- final review ---------------------------------------------------------------------------------

// Closure plan: task 1 stopped with its isolation proven (blocking tasks 2 and 3), task 4 approved,
// then the final cycle opened on the partial delivery: task 4 alone.
function partialFinal() {
  const four = approvedTask(chain(closureRun(), [taskOpened('1'), stopped(STOP.HUMAN_INTERRUPTED), isolationRecorded()]),
    '4');
  return apply(four, closureFinal(['4']));
}

const FINAL_REVIEW_EVIDENCE = Object.freeze({ path: OUTCOME_PATH('final', 1, 'final-reviewer'), digest: hex('6') });

// The partial final's initial iteration finds an SC4 issue; the correction at iteration 2 is reserved.
function partialFinalCorrection() {
  return chain(partialFinal(), [
    reserved(1, 'initial', null, 'final'), authorized(1, 'final-reviewer', {}, 'final'),
    checksRecorded(1, {}, { observation: OBSERVATION }, 'final', 1, FINAL_CHECK_IDS),
    reviewRecorded(1, 'ISSUES_FOUND', {
      before: OBSERVATION, after: OBSERVATION, rubric: [],
      defects: [defectEntry({ criterion: 'SC4', cause: 'missing-note' })],
    }, 'final-reviewer', 'final'),
    admitted(finalRetryRequest({ target: 'SC4', confirmingCheck: 'review', evidence: { ...FINAL_REVIEW_EVIDENCE } })),
    reserved(2, 'correction', null, 'final'),
  ]);
}

test('the final cycle opens only once every task concluded, and runs on a partial delivery', () => {
  const state = partialFinal();
  assert.deepEqual(state.cycles['final#1'].checks,
    [{ id: 'surface-test-1', command: 'npm test' }, { id: 'coherence-gate', command: 'builtin' }]);
  assert.deepEqual([...new Set(state.cycles['final#1'].bindings.map((entry) => entry.criterion))], ['SC4']);
  // The derivation must name exactly the delivered tasks: never a stopped or blocked one.
  const four = approvedTask(chain(closureRun(), [taskOpened('1'), stopped(STOP.HUMAN_INTERRUPTED), isolationRecorded()]),
    '4');
  for (const delivered of [[], ['1', '4'], ['2', '4']]) {
    refused(applyCorrectionRecord(four, closureFinal(delivered)), REFUSAL.RECORD_SCHEMA);
  }
  // The initial final iteration has no writer: the checks, then the final review.
  const initial = apply(state, reserved(1, 'initial', null, 'final'));
  refused(applyCorrectionRecord(initial, authorized(1, 'writer', { ownerTask: '4', affectedCriteria: ['SC4'] }, 'final')),
    REFUSAL.ROLE_NOT_ALLOWED);
  const reviewer = apply(initial, authorized(1, 'final-reviewer', {}, 'final'));
  const finalReview = reviewRecorded(1, 'APPROVED', { before: OBSERVATION, after: OBSERVATION, rubric: [] },
    'final-reviewer', 'final');
  refused(applyCorrectionRecord(reviewer, finalReview), REFUSAL.OUTCOME_ORDER);
  const approved = chain(reviewer, [checksRecorded(1, {}, { observation: OBSERVATION }, 'final', 1, FINAL_CHECK_IDS),
    finalReview]);
  assert.equal(approved.cycles['final#1'].status, 'APPROVED');
  assert.equal(approved.cycles['final#1'].approvedObservation, OBSERVATION);
  assert.equal(nextCorrectionStep(approved).action, 'terminal');
});

test('a final correction writer must own an approved task: a stopped or blocked owner is a FINAL_BYPASS', () => {
  const state = partialFinalCorrection();
  const writer = (ownerTask) => authorized(2, 'writer', { ownerTask, affectedCriteria: [`SC${ownerTask}`] }, 'final');
  for (const ownerTask of ['1', '2', '3']) {
    const result = refused(applyCorrectionRecord(state, writer(ownerTask)), REFUSAL.FINAL_BYPASS);
    assert.deepEqual(result.identity, { kind: 'DISPATCH_AUTHORIZED', scope: 'final', cycle: 1, iteration: 2 });
    assert.match(result.message, ownerTask === '1' ? /stopped/u : /blocked/u);
  }
  const accepted = apply(state, writer('4'));
  assert.deepEqual(accepted.cycles['final#1'].iterations[1].dispatches.map(({ role, ownerTask }) => [role, ownerTask]),
    [['writer', '4']]);
  // An owner outside the plan is still refused as an unknown owner.
  refused(applyCorrectionRecord(state, writer('9')), REFUSAL.ROLE_NOT_ALLOWED);
});

test('final records never change task cycle counters or statuses, and final approval binds its observation', () => {
  const before = partialFinal();
  const after = chain(partialFinalCorrection(), [
    authorized(2, 'writer', { ownerTask: '4', affectedCriteria: ['SC4'] }, 'final'), writerRecorded(2, 'DONE', {}, 'final'),
    checksRecorded(2, {}, {}, 'final', 1, FINAL_CHECK_IDS), authorized(2, 'final-reviewer', {}, 'final'),
    reviewRecorded(2, 'APPROVED', { rubric: [] }, 'final-reviewer', 'final'),
  ]);
  for (const key of ['task-1#1', 'task-4#1']) assert.deepEqual(after.cycles[key], before.cycles[key], key);
  assert.deepEqual(after.cycleOrder, ['task-1#1', 'task-4#1', 'final#1']);
  const final = after.cycles['final#1'];
  assert.equal(final.status, 'APPROVED');
  assert.equal(final.approvedObservation, CANDIDATE(2));
  assert.equal(final.reserved, 2);
  assert.equal(nextCorrectionStep(after).action, 'terminal');
});

// --- reopening ------------------------------------------------------------------------------------

// Closure plan: task 1 admits one remedy, stagnates and proves isolation; tasks 2 and 3 are blocked,
// task 4 approves and the final approves the partial delivery. The run is terminal.
function partialRunRecords() {
  return [
    runOpened({ tasks: closurePlan() }),
    taskOpened('1'), reserved(1, 'initial'), authorized(1, 'writer'), writerRecorded(1),
    checksRecorded(1, { 'surface-test': FAILED(3) }),
    admitted(retryRequest({ evidence: checkEvidence(1) })), reserved(2, 'correction'), authorized(2, 'writer'),
    writerRecorded(2), checksRecorded(2, { 'surface-test': FAILED(3) }),
    isolationRecorded(),
    ...approvalRecords('4'),
    closureFinal(['4']), ...finalApprovalRecords(),
  ];
}

function partialTerminal() {
  return chain(createCorrectionState(), partialRunRecords());
}

// After the partial run, task 1 is reopened and approved in cycle 2, tasks 2 and 3 then run, and the
// final reruns once on the full delivery, linked to the first final cycle.
function completedRunRecords() {
  return [
    ...partialRunRecords(),
    reopenAuthorized(), ...approvalRecords('1', 2), ...approvalRecords('2'), ...approvalRecords('3'),
    closureFinal(['1', '2', '3', '4'], { cycle: 2, predecessor: 'final#1' }), ...finalApprovalRecords(2),
  ];
}

test('REOPEN_AUTHORIZED needs a stopped scope, no open cycle and a running run', () => {
  const state = partialTerminal();
  assert.equal(state.cycles['task-1#1'].stopReason, STOP.STAGNATED);
  assert.equal(nextCorrectionStep(state).action, 'terminal');
  // An approved scope, a scope that never ran, a scope outside the plan and an approved final.
  for (const scope of ['task-4', 'task-2', 'task-9', 'final']) {
    const result = refused(applyCorrectionRecord(state, reopenAuthorized(scope)), REFUSAL.REOPEN_INVALID);
    assert.deepEqual(result.identity, { kind: 'REOPEN_AUTHORIZED', scope, cycle: 2 });
  }
  // No cycle may be open.
  const isolated = chain(createCorrectionState(), partialRunRecords().slice(0, 12));
  refused(applyCorrectionRecord(apply(isolated, taskOpened('4')), reopenAuthorized()), REFUSAL.REOPEN_INVALID);
  apply(isolated, reopenAuthorized());
  // A halted run accepts no reopen.
  refused(applyCorrectionRecord(apply(state, halted()), reopenAuthorized()), REFUSAL.RUN_HALTED);
  // The cycle is the scope's latest plus one, linked to it.
  refused(applyCorrectionRecord(state, reopenAuthorized('task-1', 3)), REFUSAL.REOPEN_INVALID);
  refused(applyCorrectionRecord(state, reopenAuthorized('task-1', 2, { predecessor: 'task-4#1' })), REFUSAL.REOPEN_INVALID);
  // The cycle number is checked on its own: the right predecessor does not admit a skipped cycle.
  refused(applyCorrectionRecord(state, reopenAuthorized('task-1', 3, { predecessor: 'task-1#1' })), REFUSAL.REOPEN_INVALID);
  const reopened = apply(state, reopenAuthorized());
  assert.deepEqual(reopened.reopens.map(({ scope, cycle, predecessor }) => [scope, cycle, predecessor]),
    [['task-1', 2, 'task-1#1']]);
  assert.deepEqual(reopened.cycles, state.cycles);
  // One authorization per reopen.
  refused(applyCorrectionRecord(reopened, reopenAuthorized('task-1', 2, { remedy: 'yet another remedy' })),
    REFUSAL.REOPEN_INVALID);
  for (const overrides of [{ statement: '' }, { statement: '   ' }, { statement: 4 }, { remedy: '' }, { remedy: null },
    { authorization: 'reopen.json' }, { authorization: { path: 'reopen.json' } }, { predecessor: 'task-1' },
    { predecessor: null }, { cycle: 0 }, { scope: 'task' }]) {
    const result = refused(applyCorrectionRecord(state, reopenAuthorized('task-1', 2, overrides)), REFUSAL.RECORD_SCHEMA);
    assert.doesNotMatch(result.message, /unknown record kind/u, JSON.stringify(overrides));
  }
});

test('REOPEN_AUTHORIZED: the statement names the scope literally and the remedy is new to the scope', () => {
  const state = partialTerminal();
  for (const statement of ['Reopen task 1 with a new remedy.', 'Reopen Task 10 with a new remedy.',
    'Reopen Task 4 with a new remedy.', 'Reopen the final review.', 'Reopen Task1.']) {
    refused(applyCorrectionRecord(state, reopenAuthorized('task-1', 2, { statement })), REFUSAL.REOPEN_INVALID);
  }
  apply(state, reopenAuthorized('task-1', 2, { statement: 'Task 1, again: please.' }));
  // The remedy task 1#1 admitted, in any spacing or case.
  const admittedRemedy = retryRequest().remedy;
  for (const remedy of [admittedRemedy, `  ${admittedRemedy.toUpperCase().replaceAll(' ', '\t ')} `]) {
    refused(applyCorrectionRecord(state, reopenAuthorized('task-1', 2, { remedy })), REFUSAL.REOPEN_INVALID);
  }
  // A diagnosis's remedy and recommendation count as recommended.
  const diagnosedStop = chain(diagnosingAtTwo(), [diagnosed(2), stopped(STOP.RETRY_EVIDENCE_MISSING), isolationRecorded()]);
  for (const remedy of [diagnosed(2).remedy, diagnosed(2).recommendation]) {
    refused(applyCorrectionRecord(diagnosedStop, reopenAuthorized('task-1', 2, { remedy })), REFUSAL.REOPEN_INVALID);
  }
  apply(diagnosedStop, reopenAuthorized());
  // An earlier reopen's remedy, and the remedies of the reopened cycle, count for the next reopen.
  const stoppedAgain = chain(state, [reopenAuthorized(), taskOpened('1', { cycle: 2, predecessor: 'task-1#1' }),
    stopped(STOP.HUMAN_INTERRUPTED, 'task-1', 2), isolationRecorded('task-1', 2)]);
  refused(applyCorrectionRecord(stoppedAgain, reopenAuthorized('task-1', 3)), REFUSAL.REOPEN_INVALID);
  refused(applyCorrectionRecord(stoppedAgain, reopenAuthorized('task-1', 3, { remedy: admittedRemedy })),
    REFUSAL.REOPEN_INVALID);
  apply(stoppedAgain, reopenAuthorized('task-1', 3, { remedy: 'guard the reservation with the cycle number' }));
});

test('a reopen opens a linked cycle with a fresh allowance; the old cycle stays; dependents wait for approval', () => {
  const state = partialTerminal();
  const authorizedState = apply(state, reopenAuthorized());
  assert.deepEqual(nextCorrectionStep(authorizedState),
    { action: 'open-cycle', scope: 'task-1', cycle: 2, predecessor: 'task-1#1' });
  // The authorization alone unblocks nothing, in the summary as in the schedule.
  assert.deepEqual(summarizeCorrectionRun(authorizedState).blocked,
    [{ task: '2', causes: ['1'] }, { task: '3', causes: ['1'] }]);
  for (const task of ['2', '3']) {
    refused(applyCorrectionRecord(authorizedState, taskOpened(task)), REFUSAL.SCOPE_NOT_RUNNABLE);
  }
  // The new cycle must be the authorized one.
  refused(applyCorrectionRecord(authorizedState, taskOpened('1')), REFUSAL.REOPEN_INVALID);
  refused(applyCorrectionRecord(authorizedState, taskOpened('1', { cycle: 2 })), REFUSAL.REOPEN_INVALID);
  refused(applyCorrectionRecord(authorizedState, taskOpened('1', { cycle: 3, predecessor: 'task-1#2' })),
    REFUSAL.REOPEN_INVALID);
  refused(applyCorrectionRecord(state, taskOpened('1', { cycle: 2, predecessor: 'task-1#1' })), REFUSAL.REOPEN_INVALID);
  const reopened = apply(authorizedState, taskOpened('1', { cycle: 2, predecessor: 'task-1#1' }));
  const cycle = reopened.cycles['task-1#2'];
  assert.deepEqual([cycle.status, cycle.predecessor, cycle.reserved, cycle.diagnosisUsed, cycle.iterations.length],
    ['OPEN', 'task-1#1', 0, false, 0]);
  assert.deepEqual(reopened.cycles['task-1#1'], state.cycles['task-1#1']);
  assert.deepEqual(nextCorrectionStep(reopened),
    { action: 'reserve', scope: 'task-1', cycle: 2, iteration: 1, kind: 'initial' });
  refused(applyCorrectionRecord(reopened, taskOpened('2')), REFUSAL.SCOPE_NOT_RUNNABLE);
  // A fresh allowance of three, with a fresh diagnosis slot.
  const third = chain(reopened, [reserved(1, 'initial', null, 'task-1', 2), interrupted(1, 'task-1', 2),
    reserved(2, 'diagnosis', 'missing-retry-evidence', 'task-1', 2)]);
  assert.deepEqual([third.cycles['task-1#2'].reserved, third.cycles['task-1#2'].diagnosisUsed], [2, true]);

  // Approval, not the authorization, unblocks task 2; then task 3 follows, and the final reruns once.
  const approvedAgain = chain(reopened, approvalRecords('1', 2).slice(1));
  assert.equal(approvedAgain.cycles['task-1#2'].status, 'APPROVED');
  assert.deepEqual(nextCorrectionStep(approvedAgain), { action: 'open-cycle', scope: 'task-2' });
  const delivered = approvedTask(approvedTask(approvedAgain, '2'), '3');
  assert.deepEqual(nextCorrectionStep(delivered),
    { action: 'open-cycle', scope: 'final', cycle: 2, predecessor: 'final#1' });
  const all = ['1', '2', '3', '4'];
  refused(applyCorrectionRecord(delivered, closureFinal(all)), REFUSAL.REOPEN_INVALID);
  refused(applyCorrectionRecord(delivered, closureFinal(all, { cycle: 2 })), REFUSAL.REOPEN_INVALID);
  refused(applyCorrectionRecord(delivered, closureFinal(all, { cycle: 3, predecessor: 'final#2' })),
    REFUSAL.REOPEN_INVALID);
  const rerun = apply(delivered, closureFinal(all, { cycle: 2, predecessor: 'final#1' }));
  assert.deepEqual([rerun.cycles['final#2'].reserved, rerun.cycles['final#2'].predecessor], [0, 'final#1']);
  const complete = approvedFinal(rerun, 2);
  assert.equal(complete.cycles['final#2'].status, 'APPROVED');
  assert.equal(nextCorrectionStep(complete).action, 'terminal');
  // Only one final cycle per task reopen.
  refused(applyCorrectionRecord(complete, closureFinal(all, { cycle: 3, predecessor: 'final#2' })),
    REFUSAL.REOPEN_INVALID);
});

test('the final review reopens only on its own authorization naming it literally', () => {
  const stoppedFinal = chain(partialFinal(), [reserved(1, 'initial', null, 'final'),
    authorized(1, 'final-reviewer', {}, 'final'), stopped(STOP.HUMAN_INTERRUPTED, 'final')]);
  assert.equal(nextCorrectionStep(stoppedFinal).action, 'terminal');
  const rerun = closureFinal(['4'], { cycle: 2, predecessor: 'final#1' });
  refused(applyCorrectionRecord(stoppedFinal, rerun), REFUSAL.REOPEN_INVALID);
  for (const statement of ['Reopen the Final Review.', 'Reopen Task 4.', 'Reopen the final.']) {
    refused(applyCorrectionRecord(stoppedFinal, reopenAuthorized('final', 2, { statement })), REFUSAL.REOPEN_INVALID);
  }
  const reopened = apply(stoppedFinal, reopenAuthorized('final'));
  assert.deepEqual(nextCorrectionStep(reopened), { action: 'open-cycle', scope: 'final', cycle: 2, predecessor: 'final#1' });
  const second = apply(reopened, rerun);
  assert.deepEqual([second.cycles['final#2'].status, second.cycles['final#2'].reserved], ['OPEN', 0]);
  assert.deepEqual(second.cycles['final#1'], stoppedFinal.cycles['final#1']);
});

test('a reopened cycle refuses a retry repeating a predecessor cycle\'s remedy or (target, hypothesis, remedy)', () => {
  const failedOnce = chain(partialTerminal(), [
    reopenAuthorized(), taskOpened('1', { cycle: 2, predecessor: 'task-1#1' }),
    reserved(1, 'initial', null, 'task-1', 2), authorized(1, 'writer', {}, 'task-1', 2),
    writerRecorded(1, 'DONE', {}, 'task-1', 2), checksRecorded(1, { 'surface-test': FAILED(2) }, {}, 'task-1', 2),
  ]);
  const request = (overrides = {}) => retryRequest({ cycle: 2, evidence: checkEvidence(1), ...overrides });
  // task-1#1 admitted retryRequest(): the same triple repeats.
  refused(validateRetryRequest(failedOnce, request()), REFUSAL.RETRY_REPEATED);
  refused(applyCorrectionRecord(failedOnce, admitted(request())), REFUSAL.RETRY_REPEATED);
  // The normalized remedy alone repeats, whatever the target and hypothesis.
  const remedy = ` ${retryRequest().remedy.toUpperCase().replaceAll(' ', '\t ')} `;
  refused(validateRetryRequest(failedOnce, request({
    target: 'surface-test', hypothesis: 'the counter is read before it is written', remedy,
  })), REFUSAL.RETRY_REPEATED);
  assert.deepEqual(validateRetryRequest(failedOnce, request({ remedy: 'bound the reservation to the cycle number' })),
    { ok: true });
});

test('replay after a resume yields identical counters, states and steps', () => {
  const records = completedRunRecords();
  const refs = records.map((_record, index) => ref(index + 1, 'abcdef0123456789'[index % 16]));
  const replayed = ok(replayCorrectionRecords(records, { refs }));
  const incremental = records.reduce((state, record, index) => apply(state, record, { ref: refs[index] }),
    createCorrectionState());
  assert.deepEqual(replayed, incremental);
  // A resume replays the persisted prefix and continues with the remaining records.
  for (const cut of [12, 20, records.length - 3]) {
    const resumed = records.slice(cut).reduce((state, record, index) => apply(state, record, { ref: refs[cut + index] }),
      ok(replayCorrectionRecords(records.slice(0, cut), { refs: refs.slice(0, cut) })));
    assert.deepEqual(resumed, replayed, `cut ${cut}`);
  }
  const counters = (state) => state.cycleOrder.map((key) => {
    const { reserved: count, diagnosisUsed, status, concluded } = state.cycles[key];
    return [key, count, diagnosisUsed, status, concluded];
  });
  assert.deepEqual(counters(replayed), counters(incremental));
  assert.deepEqual(replayed.cycleOrder,
    ['task-1#1', 'task-4#1', 'final#1', 'task-1#2', 'task-2#1', 'task-3#1', 'final#2']);
  assert.deepEqual(nextCorrectionStep(replayed), nextCorrectionStep(incremental));
  assert.equal(nextCorrectionStep(replayed).action, 'terminal');
});

// --- terminal summary -----------------------------------------------------------------------------

test('blocking causes are the stopped roots of every blocking path, sorted by task number', () => {
  const tasks = [['2', []], ['10', []], ['11', ['2', '10']], ['12', ['11']]].map(([task, dependencies]) => ({
    task, dependencies, complexity: 'mechanical', criterionIds: [`SC${task}`], testCommand: 'npm test',
  }));
  const open = (task) => ({
    kind: 'CYCLE_OPENED', scope: `task-${task}`, cycle: 1, predecessor: null,
    ...deriveCycleBindings({ scope: `task-${task}`, task: tasks.find((entry) => entry.task === task) }),
    rubricCriteria: [], observation: OBSERVATION,
  });
  const state = chain(createCorrectionState(), [
    runOpened({ tasks }),
    open('2'), stopped(STOP.HUMAN_INTERRUPTED, 'task-2'), isolationRecorded('task-2'),
    open('10'), stopped(STOP.HUMAN_INTERRUPTED, 'task-10'), isolationRecorded('task-10'),
  ]);
  const summary = summarizeCorrectionRun(state);
  assert.deepEqual(summary.blocked, [{ task: '11', causes: ['2', '10'] }, { task: '12', causes: ['2', '10'] }]);
  assert.deepEqual(summary.stopped.map((entry) => entry.task), ['2', '10']);
  // The step is the final, so the run is not yet terminal: only decided criteria are reported.
  assert.equal(summary.outcome, 'PENDING');
  assert.deepEqual(summary.criteria, { SC2: 'failed', SC10: 'failed', SC11: 'blocked', SC12: 'blocked' });
  assert.deepEqual(Object.keys(summary.criteria), ['SC2', 'SC10', 'SC11', 'SC12']);
});

test('summary of a PARTIAL run: the stopped task, its blocked dependents, and every criterion classified', () => {
  const state = partialTerminal();
  const summary = summarizeCorrectionRun(state);
  assert.ok(isDeepFrozen(summary));
  assert.deepEqual(summary, {
    version: 1,
    outcome: 'PARTIAL',
    approval: 'UNAPPROVED',
    planDigest: PLAN_DIGEST,
    completed: ['4'],
    stopped: [{
      task: '1', cycle: 1, reason: STOP.STAGNATED, iterations: { reserved: 2, diagnosis: 0 },
      unresolvedDefects: ['SC1/surface-test/command-failed'],
      comparison: [{ defect: 'SC1/surface-test/command-failed', previous: 3, current: 3, verdict: 'stagnant' }],
      bestCandidate: { iteration: 1, observation: CANDIDATE(1), snapshot: writerRecorded(1).candidate },
      execution: null,
      nextRemedy: retryRequest().remedy,
    }],
    blocked: [{ task: '2', causes: ['1'] }, { task: '3', causes: ['1'] }],
    criteria: { SC1: 'failed', SC2: 'blocked', SC3: 'blocked', SC4: 'satisfied' },
    final: {
      cycle: 1, status: 'APPROVED', reason: STOP.APPROVED, iterations: { reserved: 1, diagnosis: 0 },
      approvedObservation: OBSERVATION, unresolvedDefects: [], comparison: [], bestCandidate: null, nextRemedy: null,
    },
    cycles: [
      { scope: 'task-1', cycle: 1, predecessor: null, status: 'STOPPED', reason: STOP.STAGNATED, reserved: 2, diagnosis: 0 },
      { scope: 'task-4', cycle: 1, predecessor: null, status: 'APPROVED', reason: STOP.APPROVED, reserved: 1, diagnosis: 0 },
      { scope: 'final', cycle: 1, predecessor: null, status: 'APPROVED', reason: STOP.APPROVED, reserved: 1, diagnosis: 0 },
    ],
    halt: null,
  });
  assert.deepEqual(nextCorrectionStep(state), { action: 'terminal', summary });
  assert.ok(isDeepFrozen(nextCorrectionStep(state)));
});

test('summary of a COMPLETE run: every task and the rerun final approved', () => {
  const state = chain(createCorrectionState(), completedRunRecords());
  const summary = summarizeCorrectionRun(state);
  assert.deepEqual([summary.outcome, summary.approval], ['COMPLETE', 'APPROVED']);
  assert.deepEqual(summary.completed, ['1', '2', '3', '4']);
  assert.deepEqual([summary.stopped, summary.blocked, summary.halt], [[], [], null]);
  assert.deepEqual(summary.criteria, { SC1: 'satisfied', SC2: 'satisfied', SC3: 'satisfied', SC4: 'satisfied' });
  assert.deepEqual(summary.final, {
    cycle: 2, status: 'APPROVED', reason: STOP.APPROVED, iterations: { reserved: 1, diagnosis: 0 },
    approvedObservation: OBSERVATION, unresolvedDefects: [], comparison: [], bestCandidate: null, nextRemedy: null,
  });
  assert.deepEqual(summary.cycles.map(({ scope, cycle, predecessor, status }) => [scope, cycle, predecessor, status]), [
    ['task-1', 1, null, 'STOPPED'], ['task-4', 1, null, 'APPROVED'], ['final', 1, null, 'APPROVED'],
    ['task-1', 2, 'task-1#1', 'APPROVED'], ['task-2', 1, null, 'APPROVED'], ['task-3', 1, null, 'APPROVED'],
    ['final', 2, 'final#1', 'APPROVED'],
  ]);
  // Before the rerun final concluded, the same run was PENDING: approval is never partial.
  const pending = chain(createCorrectionState(), completedRunRecords().slice(0, -1));
  assert.deepEqual([summarizeCorrectionRun(pending).outcome, summarizeCorrectionRun(pending).approval],
    ['PENDING', 'UNAPPROVED']);
  assert.deepEqual(summarizeCorrectionRun(pending).criteria, {});
});

test('summary criteria: a final stopped at terminal fails every criterion it did not approve', () => {
  const finalOpened = partialFinal();
  const withDefect = chain(finalOpened, [
    reserved(1, 'initial', null, 'final'), authorized(1, 'final-reviewer', {}, 'final'),
    checksRecorded(1, {}, { observation: OBSERVATION }, 'final', 1, FINAL_CHECK_IDS),
    reviewRecorded(1, 'ISSUES_FOUND', {
      before: OBSERVATION, after: OBSERVATION, rubric: [], defects: [defectEntry({ criterion: 'SC4', cause: 'missing-note' })],
    }, 'final-reviewer', 'final'),
    stopped(STOP.RETRY_EVIDENCE_MISSING, 'final'),
  ]);
  const interruptedFinal = chain(finalOpened, [reserved(1, 'initial', null, 'final'), stopped(STOP.HUMAN_INTERRUPTED, 'final')]);
  for (const state of [withDefect, interruptedFinal]) {
    const summary = summarizeCorrectionRun(state);
    assert.deepEqual([summary.outcome, summary.approval], ['PARTIAL', 'UNAPPROVED']);
    assert.deepEqual(summary.criteria, { SC1: 'failed', SC2: 'blocked', SC3: 'blocked', SC4: 'failed' });
    assert.equal(summary.final.status, 'STOPPED');
    assert.equal(summary.final.approvedObservation, null);
  }
  assert.equal(summarizeCorrectionRun(interruptedFinal).final.reason, STOP.HUMAN_INTERRUPTED);
  // Reopening task 1 makes the run PENDING again: the stopped final's defect no longer decides SC4.
  const reopened = apply(withDefect, reopenAuthorized());
  assert.deepEqual(nextCorrectionStep(reopened),
    { action: 'open-cycle', scope: 'task-1', cycle: 2, predecessor: 'task-1#1' });
  const reopenedSummary = summarizeCorrectionRun(reopened);
  assert.equal(reopenedSummary.outcome, 'PENDING');
  assert.deepEqual(reopenedSummary.criteria, { SC1: 'failed', SC2: 'blocked', SC3: 'blocked' });
  // An open final is not terminal: its criteria stay undecided.
  const open = summarizeCorrectionRun(finalOpened);
  assert.equal(open.outcome, 'PENDING');
  assert.deepEqual(open.criteria, { SC1: 'failed', SC2: 'blocked', SC3: 'blocked' });
  assert.deepEqual(open.final, {
    cycle: 1, status: 'OPEN', reason: null, iterations: { reserved: 0, diagnosis: 0 }, approvedObservation: null,
    unresolvedDefects: [], comparison: [], bestCandidate: null, nextRemedy: null,
  });
});

test('summary of a stopped task: the next remedy, the autopilot execution and the diagnosis count', () => {
  // An explicit stop's note outranks a valid diagnosis recommendation: it is the latest decision on the cycle.
  const diagnosedStop = chain(diagnosingAtTwo(), [diagnosed(2), stopped(STOP.RETRY_EVIDENCE_MISSING), isolationRecorded()]);
  const [entry] = summarizeCorrectionRun(diagnosedStop).stopped;
  assert.deepEqual(entry, {
    task: '1', cycle: 1, reason: STOP.RETRY_EVIDENCE_MISSING, iterations: { reserved: 2, diagnosis: 1 },
    unresolvedDefects: [], comparison: [], bestCandidate: { iteration: 0, observation: OBSERVATION, snapshot: null },
    execution: null, nextRemedy: stopped(STOP.RETRY_EVIDENCE_MISSING).note,
  });
  // Without an explicit stop, an admitted remedy or a valid recommendation there is no next remedy.
  const inconclusive = chain(diagnosingAtTwo(), [diagnosed(2, false)]);
  assert.equal(summarizeCorrectionRun(inconclusive).stopped[0].reason, STOP.DIAGNOSIS_INCONCLUSIVE);
  assert.equal(summarizeCorrectionRun(inconclusive).stopped[0].nextRemedy, null);
  // An explicit stop with nothing admitted or recommended still reports its note as the next remedy.
  const bare = chain(closureRun(), [taskOpened('1'), stopped(STOP.HUMAN_INTERRUPTED)]);
  assert.equal(summarizeCorrectionRun(bare).stopped[0].nextRemedy, stopped(STOP.HUMAN_INTERRUPTED).note);
  // An autopilot run whose stopped task proved baseline-equal isolation retains none of its executions.
  const autopilot = partialRunRecords().map((record) => {
    if (record.kind === 'RUN_OPENED') return { ...record, drive: 'autopilot' };
    if (record.kind === 'DISPATCH_AUTHORIZED' && record.role === 'writer') {
      return { ...record, target: `receipt:${record.scope}/iteration-${record.iteration}/` };
    }
    return record;
  });
  const autopilotState = chain(createCorrectionState(), autopilot);
  assert.equal(autopilotState.cycles['task-1#1'].isolation.mode, 'baseline-equal');
  assert.equal(summarizeCorrectionRun(autopilotState).stopped[0].execution, null);
});

test('summary of a halted run is HALTED and carries the halt', () => {
  const state = apply(stoppedWithPassingCandidate(), halted({ reason: 'isolation could not be proven' }));
  const summary = summarizeCorrectionRun(state);
  assert.deepEqual([summary.outcome, summary.approval], ['HALTED', 'UNAPPROVED']);
  assert.deepEqual(summary.halt, { reason: 'isolation could not be proven', evidence: [{ ...DIAGNOSIS_ARTIFACT }] });
  assert.deepEqual(summary.criteria, { SC1: 'failed', SC2: 'failed', SC3: 'blocked' });
  assert.deepEqual(summary.blocked, [{ task: '2', causes: ['1'] }, { task: '4', causes: ['1'] }]);
});

test('summarizeCorrectionRun throws TypeError for a state it did not produce or a run never opened', () => {
  for (const foreign of [undefined, null, {}, structuredClone(opened())]) {
    assert.throws(() => summarizeCorrectionRun(foreign), { name: 'TypeError', message: /^summarizeCorrectionRun: /u });
  }
  assert.throws(() => summarizeCorrectionRun(createCorrectionState()),
    { name: 'TypeError', message: /^summarizeCorrectionRun: /u });
});

// --- summary block --------------------------------------------------------------------------------

const BLOCK_OPEN = '<!-- steepy-correction-summary: v1 -->';
const BLOCK_CLOSE = '<!-- /steepy-correction-summary -->';

function block(json) {
  return `${BLOCK_OPEN}\n\`\`\`json\n${json}\n\`\`\`\n${BLOCK_CLOSE}`;
}

test('the summary block is the exact fenced JSON between its markers, and round-trips', () => {
  for (const state of [partialTerminal(), chain(createCorrectionState(), completedRunRecords()), opened()]) {
    const summary = summarizeCorrectionRun(state);
    const text = formatCorrectionSummaryBlock(summary);
    assert.equal(text, block(JSON.stringify(summary, null, 2)));
    const parsed = parseCorrectionSummaryBlock(`# Handoff\n\nprose before\n\n${text}\n\nprose after\n`);
    assert.deepEqual(parsed, summary);
    assert.ok(isDeepFrozen(parsed));
  }
  for (const text of ['', 'no summary here', '```json\n{}\n```', '<!-- steepy-other: v1 -->']) {
    assert.equal(parseCorrectionSummaryBlock(text), null);
  }
});

test('parseCorrectionSummaryBlock throws Error on bad markers, bad JSON, duplicate or unknown keys and HALTED', () => {
  const summary = summarizeCorrectionRun(partialTerminal());
  const json = JSON.stringify(summary, null, 2);
  const good = block(json);
  const withKey = (target, key) => JSON.stringify(target(structuredClone(summary), key), null, 2);
  const cases = [
    [`${good}\n${good}`, /duplicate/u],
    [`${BLOCK_OPEN}\n${good}`, /duplicate/u],
    [`${good}\n${BLOCK_CLOSE}`, /duplicate/u],
    [good.slice(0, good.indexOf(BLOCK_CLOSE)), /unmatched/u],
    [good.slice(good.indexOf('```json')), /unmatched/u],
    [`${BLOCK_CLOSE}\n${BLOCK_OPEN}`, /unmatched/u],
    [good.replace(': v1 -->', ': v2 -->'), /v1/u],
    [good.replace('```json\n', '```\n'), /fence/u],
    [block(`${json},`), /JSON/u],
    [block('{ "version": 1, '), /JSON/u],
    [block(json.replace('"version": 1,', '"version": 1,\n  "version": 1,')), /duplicate key/u],
    [block(json.replace('"task": "1",', '"task": "1",\n      "task": "1",')), /duplicate key/u],
    [block(withKey((value) => Object.assign(value, { extra: true }))), /unknown keys: extra/u],
    [block(withKey((value) => { value.stopped[0].note = 'x'; return value; })), /unknown keys: note/u],
    [block(withKey((value) => { value.final.deadline = 1; return value; })), /unknown keys: deadline/u],
    [block(withKey((value) => { value.cycles[0].cost = 1; return value; })), /unknown keys: cost/u],
    [block(withKey((value) => { delete value.halt; return value; })), /missing keys: halt/u],
    [block(withKey((value) => { value.criteria.SC1 = 'partial'; return value; })), /criteria/u],
    [block(withKey((value) => { value.approval = 'APPROVED'; return value; })), /approval/u],
    [block(withKey((value) => { value.outcome = 'HALTED'; return value; })), /halted/u],
    [block('[]'), /summary/u],
  ];
  for (const [index, [text, message]] of cases.entries()) {
    assert.throws(() => parseCorrectionSummaryBlock(text),
      (error) => error.constructor === Error && message.test(error.message), `case ${index}`);
  }
  assert.throws(() => parseCorrectionSummaryBlock(42), TypeError);
});

test('a halted run never projects a handoff: formatting its summary is refused', () => {
  const haltedRun = apply(stoppedWithPassingCandidate(), halted());
  const summary = summarizeCorrectionRun(haltedRun);
  assert.equal(summary.outcome, 'HALTED');
  assert.throws(() => formatCorrectionSummaryBlock(summary), { name: 'TypeError', message: /halted/u });
  // The parser refuses it too, even when written by hand.
  assert.throws(() => parseCorrectionSummaryBlock(block(JSON.stringify(summary, null, 2))), /halted/u);
  for (const bad of [undefined, null, {}, { ...summarizeCorrectionRun(opened()), extra: 1 }]) {
    assert.throws(() => formatCorrectionSummaryBlock(bad), { name: 'TypeError', message: /^formatCorrectionSummaryBlock: /u });
  }
  // A value that would forge a marker can never reach the block.
  const forged = { ...structuredClone(summarizeCorrectionRun(partialTerminal())) };
  forged.stopped[0].nextRemedy = `${BLOCK_CLOSE} injected`;
  assert.throws(() => formatCorrectionSummaryBlock(forged), { name: 'TypeError', message: /marker/u });
});

// --- reopen scheduling ----------------------------------------------------------------------------

test('a reopen may precede the isolation proof, but its cycle waits for it, then outranks a runnable task', () => {
  const unisolated = apply(chain(createCorrectionState(), partialRunRecords().slice(0, 11)), reopenAuthorized());
  assert.deepEqual(nextCorrectionStep(unisolated), { action: 'prove-isolation', scope: 'task-1', cycle: 1 });
  refused(applyCorrectionRecord(unisolated, taskOpened('1', { cycle: 2, predecessor: 'task-1#1' })),
    REFUSAL.ISOLATION_REQUIRED);
  // Task 4 is runnable, but the authorized reopen of task 1 comes first.
  const isolated = apply(unisolated, isolationRecorded());
  assert.deepEqual(nextCorrectionStep(isolated), { action: 'open-cycle', scope: 'task-1', cycle: 2, predecessor: 'task-1#1' });
  refused(applyCorrectionRecord(isolated, taskOpened('4')), REFUSAL.SCOPE_NOT_RUNNABLE);
  const reopened = apply(isolated, taskOpened('1', { cycle: 2, predecessor: 'task-1#1' }));
  assert.equal(reopened.cycles['task-1#2'].status, 'OPEN');
});

test('a final reopen waits until no task is runnable, and the final then reruns only once', () => {
  const stoppedFinal = chain(partialFinal(), [reserved(1, 'initial', null, 'final'),
    authorized(1, 'final-reviewer', {}, 'final'), stopped(STOP.HUMAN_INTERRUPTED, 'final')]);
  const both = chain(stoppedFinal, [reopenAuthorized('final'), reopenAuthorized()]);
  // The task reopen opens first, whatever the authorization order.
  assert.deepEqual(nextCorrectionStep(both), { action: 'open-cycle', scope: 'task-1', cycle: 2, predecessor: 'task-1#1' });
  const all = ['1', '2', '3', '4'];
  const rerun = closureFinal(all, { cycle: 2, predecessor: 'final#1' });
  refused(applyCorrectionRecord(both, rerun), REFUSAL.SCOPE_NOT_RUNNABLE);
  const taskOne = chain(both, approvalRecords('1', 2));
  // Task 2 became runnable: the final may not open while a task is runnable.
  assert.deepEqual(nextCorrectionStep(taskOne), { action: 'open-cycle', scope: 'task-2' });
  refused(applyCorrectionRecord(taskOne, rerun), REFUSAL.SCOPE_NOT_RUNNABLE);
  const delivered = approvedTask(approvedTask(taskOne, '2'), '3');
  assert.deepEqual(nextCorrectionStep(delivered), { action: 'open-cycle', scope: 'final', cycle: 2, predecessor: 'final#1' });
  const complete = approvedFinal(apply(delivered, rerun), 2);
  assert.equal(summarizeCorrectionRun(complete).outcome, 'COMPLETE');
  refused(applyCorrectionRecord(complete, closureFinal(all, { cycle: 3, predecessor: 'final#2' })),
    REFUSAL.REOPEN_INVALID);
});

// --- fix 1: summary discrimination ----------------------------------------------------------------

// Stops the final cycle opened in `state`: by an interruption with no outcome, or after a final review
// finds an SC4 issue.
function stoppedFinals(state) {
  return [
    chain(state, [reserved(1, 'initial', null, 'final'), stopped(STOP.HUMAN_INTERRUPTED, 'final')]),
    chain(state, [
      reserved(1, 'initial', null, 'final'), authorized(1, 'final-reviewer', {}, 'final'),
      checksRecorded(1, {}, { observation: OBSERVATION }, 'final', 1, FINAL_CHECK_IDS),
      reviewRecorded(1, 'ISSUES_FOUND', {
        before: OBSERVATION, after: OBSERVATION, rubric: [],
        defects: [defectEntry({ criterion: 'SC4', cause: 'missing-note' })],
      }, 'final-reviewer', 'final'),
      stopped(STOP.RETRY_EVIDENCE_MISSING, 'final'),
    ]),
  ];
}

test('summary: every task approved but the final stopped is PARTIAL and unapproved', () => {
  const delivered = chain(closureRun(), [
    ...approvalRecords('1'), ...approvalRecords('2'), ...approvalRecords('3'), ...approvalRecords('4'),
  ]);
  for (const state of stoppedFinals(apply(delivered, closureFinal(['1', '2', '3', '4'])))) {
    assert.equal(nextCorrectionStep(state).action, 'terminal');
    const summary = summarizeCorrectionRun(state);
    assert.deepEqual([summary.outcome, summary.approval], ['PARTIAL', 'UNAPPROVED']);
    assert.deepEqual([summary.completed, summary.stopped, summary.blocked], [['1', '2', '3', '4'], [], []]);
    assert.deepEqual([summary.final.status, summary.final.approvedObservation], ['STOPPED', null]);
    assert.deepEqual(summary.criteria, { SC1: 'failed', SC2: 'failed', SC3: 'failed', SC4: 'failed' });
    const parsed = parseCorrectionSummaryBlock(formatCorrectionSummaryBlock(summary));
    assert.deepEqual([parsed.outcome, parsed.approval], ['PARTIAL', 'UNAPPROVED']);
  }
});

test('summary criteria: failed outranks blocked, and a stopped final\'s unresolved defect fails its criterion', () => {
  // Task 3 (blocked by the stopped task 1) and task 4 (approved) both carry SC4.
  const tasks = closurePlan().map((entry) => (entry.task === '3' ? { ...entry, criterionIds: ['SC3', 'SC4'] } : entry));
  const open = (task) => ({
    kind: 'CYCLE_OPENED', scope: `task-${task}`, cycle: 1, predecessor: null,
    ...deriveCycleBindings({ scope: `task-${task}`, task: tasks.find((entry) => entry.task === task) }),
    rubricCriteria: [], observation: OBSERVATION,
  });
  const finalOpened = chain(createCorrectionState(), [
    runOpened({ tasks }),
    open('1'), stopped(STOP.HUMAN_INTERRUPTED), isolationRecorded(),
    open('4'), reserved(1, 'initial', null, 'task-4'), authorized(1, 'writer', {}, 'task-4'),
    writerRecorded(1, 'DONE', {}, 'task-4'), checksRecorded(1, {}, {}, 'task-4'),
    {
      kind: 'CYCLE_OPENED', scope: 'final', cycle: 1, predecessor: null,
      ...deriveCycleBindings({ scope: 'final', deliveredTasks: [tasks[3]] }), rubricCriteria: [], observation: OBSERVATION,
    },
  ]);
  const [, withDefect] = stoppedFinals(finalOpened);
  const summary = summarizeCorrectionRun(withDefect);
  assert.equal(summary.outcome, 'PARTIAL');
  assert.deepEqual(summary.criteria, { SC1: 'failed', SC2: 'blocked', SC3: 'blocked', SC4: 'failed' });
});

test('summary nextRemedy: a valid diagnosis recommendation outranks an admitted remedy', () => {
  const state = chain(awaitingRetry(), [
    admitted(retryRequest()), reserved(2, 'correction'), authorized(2, 'writer'), [interrupted(2), { ref: ref(6) }],
    reserved(3, 'diagnosis', 'comparison-unavailable'), authorized(3, 'diagnostic'), diagnosed(3),
  ]);
  // The cycle admitted a remedy, so the recommendation has something to outrank.
  assert.deepEqual(state.cycles['task-1#1'].admittedRemedies, [retryRequest().remedy]);
  assert.equal(state.cycles['task-1#1'].stopReason, STOP.EXHAUSTED);
  assert.equal(summarizeCorrectionRun(state).stopped[0].nextRemedy, diagnosed(3).recommendation);
});

test('summary execution: a reopened cycle stopped without its isolation proof retains no execution yet', () => {
  const records = [
    ...partialRunRecords(), reopenAuthorized(), taskOpened('1', { cycle: 2, predecessor: 'task-1#1' }),
    reserved(1, 'initial', null, 'task-1', 2), authorized(1, 'writer', {}, 'task-1', 2),
    writerRecorded(1, 'DONE', {}, 'task-1', 2), checksRecorded(1, { 'surface-test': FAILED(2) }, {}, 'task-1', 2),
    stopped(STOP.HUMAN_INTERRUPTED, 'task-1', 2),
  ].map((record) => {
    if (record.kind === 'RUN_OPENED') return { ...record, drive: 'autopilot' };
    if (record.kind === 'DISPATCH_AUTHORIZED' && record.role === 'writer') {
      return { ...record, target: `receipt:${record.scope}/c${record.cycle}/i${record.iteration}/` };
    }
    return record;
  });
  const state = chain(createCorrectionState(), records);
  assert.equal(state.cycles['task-1#2'].isolation, null);
  assert.deepEqual(summarizeCorrectionRun(state).stopped.map(({ task, cycle, execution }) => [task, cycle, execution]),
    [['1', 2, null]]);
});

// The writer target of task 1's iteration `n` in the autopilot runs below.
const RECEIPT = (n) => `.formula/work/tasks/2026-10-26-plan/task-1-execution-${n}`;

// An autopilot run whose task 1 writer (iteration 1) reached a verified candidate whose checks pass, whose
// review found an issue, and whose correction writer (iteration 2) recorded `secondStatus` on `secondObservation`.
function autopilotCorrected(secondStatus, secondObservation = CANDIDATE(1)) {
  const reviewEvidence = reviewRecorded(1, 'ISSUES_FOUND').evidence[0];
  return chain(createCorrectionState(), [
    runOpened({ drive: 'autopilot' }), cycleOpened('task-1'), reserved(1, 'initial'),
    authorized(1, 'writer', { target: RECEIPT(1) }), writerRecorded(1), checksRecorded(1), authorized(1, 'task-reviewer'),
    reviewRecorded(1, 'ISSUES_FOUND', { defects: [defectEntry()] }),
    admitted(retryRequest({ evidence: { path: reviewEvidence.path, digest: reviewEvidence.digest }, confirmingCheck: 'review' })),
    reserved(2, 'correction'), authorized(2, 'writer', { target: RECEIPT(2) }),
    writerRecorded(2, secondStatus, { observation: secondObservation }),
  ]);
}

const stopIfOpen = (state) => (state.cycles['task-1#1'].status === 'OPEN' ? apply(state, stopped(STOP.HUMAN_INTERRUPTED)) : state);
const executionOf = (state) => summarizeCorrectionRun(state).stopped[0].execution;

test('summary execution: the retained writer of a retained-best isolation, never the newest writer', () => {
  // The correction writer reported BLOCKED without changing the tree: the iteration 1 candidate is retained.
  const blockedLeaf = stopIfOpen(autopilotCorrected('BLOCKED'));
  assert.equal(executionOf(blockedLeaf), null, 'no isolation is recorded yet');
  const retained = apply(blockedLeaf, isolationRecorded('task-1', 1, 'retained-best', CANDIDATE(1)));
  assert.equal(summarizeCorrectionRun(retained).stopped[0].bestCandidate.iteration, 1);
  assert.equal(executionOf(retained), RECEIPT(1));
  // The same stop proven on the opening tree retains none of the task's executions.
  assert.equal(executionOf(apply(blockedLeaf, isolationRecorded())), null);
  // A later accepted correction whose checks failed ranks below the verified candidate: it is not retained.
  const regressed = stopIfOpen(apply(autopilotCorrected('DONE', CANDIDATE(2)), checksRecorded(2, { 'surface-test': FAILED(3) })));
  assert.equal(executionOf(apply(regressed, isolationRecorded('task-1', 1, 'retained-best', CANDIDATE(1)))), RECEIPT(1));
  // A manual drive never names an execution.
  const manualRetained = chain(createCorrectionState(), [
    runOpened(), cycleOpened('task-1'), reserved(1, 'initial'), authorized(1, 'writer', { target: RECEIPT(1) }),
    writerRecorded(1), checksRecorded(1), stopped(STOP.HUMAN_INTERRUPTED),
    isolationRecorded('task-1', 1, 'retained-best', CANDIDATE(1)),
  ]);
  assert.equal(executionOf(manualRetained), null);
});

test('summary execution: a no-change best candidate is recorded baseline-equal and retains no execution', () => {
  const unchanged = chain(createCorrectionState(), [
    runOpened({ drive: 'autopilot' }), cycleOpened('task-1'), reserved(1, 'initial'),
    authorized(1, 'writer', { target: RECEIPT(1) }), writerRecorded(1, 'DONE', { observation: OBSERVATION }),
    checksRecorded(1, {}, { observation: OBSERVATION }), stopped(STOP.HUMAN_INTERRUPTED),
  ]);
  // The best candidate is the verified writer's, but its tree is the opening tree: the proof is baseline-equal.
  assert.equal(rankCandidates(unchanged.cycles['task-1#1'])[0].iteration, 1);
  assert.deepEqual(decideIsolation(unchanged, { scope: 'task-1', cycle: 1, observation: OBSERVATION }),
    { proven: true, mode: 'baseline-equal' });
  const isolated = apply(unchanged, isolationRecorded());
  assert.equal(executionOf(isolated), null);
});

// --- final-review fix: what a stopped final and an explicit stop report ---------------------------

// The summary fields of a cycle's best-ranked candidate.
function bestOf(cycle) {
  const { iteration, observation, candidate } = rankCandidates(cycle)[0];
  return { iteration, observation, snapshot: candidate };
}

// The partial final (task 4 delivered) fails its coherence gate at 3, a correction of task 4 improves it
// to 2, and the next correction stays at 2: the final stops STAGNATED after two admitted remedies.
function stagnatedFinal() {
  const correction = (iteration, metric) => [
    admitted(finalRetryRequest({
      iteration, evidence: checkEvidence(iteration - 1, 'coherence-gate', 'final'), remedy: REMEDIES[iteration],
    })),
    reserved(iteration, 'correction', null, 'final'),
    authorized(iteration, 'writer', { ownerTask: '4', affectedCriteria: ['SC4'] }, 'final'),
    writerRecorded(iteration, 'DONE', {}, 'final'),
    checksRecorded(iteration, { 'coherence-gate': FAILED(metric) }, {}, 'final', 1, FINAL_CHECK_IDS),
  ];
  return chain(partialFinal(), [
    reserved(1, 'initial', null, 'final'), authorized(1, 'final-reviewer', {}, 'final'),
    checksRecorded(1, { 'coherence-gate': FAILED(3) }, { observation: OBSERVATION }, 'final', 1, FINAL_CHECK_IDS),
    ...correction(2, 2), ...correction(3, 2),
  ]);
}

test('summary of a stopped final: its unresolved defects, best candidate and an explicit stop\'s note', () => {
  const delivered = chain(closureRun(), [
    ...approvalRecords('1'), ...approvalRecords('2'), ...approvalRecords('3'), ...approvalRecords('4'),
  ]);
  const [interruptedFinal, withDefect] = stoppedFinals(apply(delivered, closureFinal(['1', '2', '3', '4'])));
  const baseline = { iteration: 0, observation: OBSERVATION, snapshot: null };
  assert.deepEqual(summarizeCorrectionRun(withDefect).final, {
    cycle: 1, status: 'STOPPED', reason: STOP.RETRY_EVIDENCE_MISSING, iterations: { reserved: 1, diagnosis: 0 },
    approvedObservation: null, unresolvedDefects: ['SC4/review/missing-note'], comparison: [], bestCandidate: baseline,
    nextRemedy: stopped(STOP.RETRY_EVIDENCE_MISSING).note,
  });
  assert.deepEqual(summarizeCorrectionRun(interruptedFinal).final, {
    cycle: 1, status: 'STOPPED', reason: STOP.HUMAN_INTERRUPTED, iterations: { reserved: 1, diagnosis: 0 },
    approvedObservation: null, unresolvedDefects: [], comparison: [], bestCandidate: baseline,
    nextRemedy: stopped(STOP.HUMAN_INTERRUPTED).note,
  });
  for (const state of [interruptedFinal, withDefect]) {
    const summary = summarizeCorrectionRun(state);
    assert.deepEqual(summary.final.bestCandidate, bestOf(state.cycles['final#1']));
    assert.deepEqual(parseCorrectionSummaryBlock(formatCorrectionSummaryBlock(summary)), summary);
  }
});

test('summary of a final stopped STAGNATED: its comparison, best-ranked candidate and latest admitted remedy', () => {
  const state = stagnatedFinal();
  assert.equal(nextCorrectionStep(state).action, 'terminal');
  const summary = summarizeCorrectionRun(state);
  assert.deepEqual([summary.outcome, summary.approval], ['PARTIAL', 'UNAPPROVED']);
  // The correction at iteration 2 ranks first: verified, the lowest gate metric, the earlier of the two at 2.
  assert.deepEqual(bestOf(state.cycles['final#1']),
    { iteration: 2, observation: CANDIDATE(2), snapshot: writerRecorded(2, 'DONE', {}, 'final').candidate });
  assert.deepEqual(summary.final, {
    cycle: 1, status: 'STOPPED', reason: STOP.STAGNATED, iterations: { reserved: 3, diagnosis: 0 },
    approvedObservation: null,
    unresolvedDefects: ['SC4/coherence-gate/command-failed'],
    comparison: [{ defect: 'SC4/coherence-gate/command-failed', previous: 2, current: 2, verdict: 'stagnant' }],
    bestCandidate: bestOf(state.cycles['final#1']),
    nextRemedy: REMEDIES[3],
  });
  assert.deepEqual(parseCorrectionSummaryBlock(formatCorrectionSummaryBlock(summary)), summary);
});

test('summary nextRemedy: an explicit stop\'s note, then a valid recommendation, then the latest admitted remedy', () => {
  const note = 'split task 1: the reservation guard and the dispatch guard need separate plans';
  // Slot 2 diagnosed validly, slot 3's retry admitted: the cycle has a recommendation and an admitted remedy.
  const recommendedAndAdmitted = chain(diagnosingAtTwo(), [
    diagnosed(2), admitted(retryRequest({ iteration: 3, evidence: { ...DIAGNOSIS_ARTIFACT } })),
  ]);
  const cycle = recommendedAndAdmitted.cycles['task-1#1'];
  assert.equal(cycle.diagnosis.valid, true);
  assert.deepEqual(cycle.admittedRemedies, [retryRequest().remedy]);
  for (const reason of [STOP.RETRY_EVIDENCE_MISSING, STOP.HUMAN_INTERRUPTED]) {
    const state = apply(recommendedAndAdmitted, stopped(reason, 'task-1', 1, { note }));
    assert.equal(summarizeCorrectionRun(state).stopped[0].nextRemedy, note, reason);
  }
  // The same cycle exhausted without an explicit stop reports its recommendation.
  const exhausted = chain(recommendedAndAdmitted, [
    reserved(3, 'correction'), authorized(3, 'writer'), [interrupted(3), { ref: ref(7) }],
  ]);
  assert.equal(exhausted.cycles['task-1#1'].stopReason, STOP.EXHAUSTED);
  assert.equal(summarizeCorrectionRun(exhausted).stopped[0].nextRemedy, diagnosed(2).recommendation);
  // An explicit stop after an admitted remedy alone still reports its note; a stagnant stop the remedy.
  const admittedOnly = chain(awaitingRetry(), [admitted(retryRequest())]);
  assert.equal(summarizeCorrectionRun(apply(admittedOnly, stopped(STOP.HUMAN_INTERRUPTED, 'task-1', 1, { note })))
    .stopped[0].nextRemedy, note);
  assert.equal(summarizeCorrectionRun(partialTerminal()).stopped[0].nextRemedy, retryRequest().remedy);
});

test('the final\'s stop fields are empty unless it STOPPED, and the summary block refuses any other pairing', () => {
  const approved = summarizeCorrectionRun(partialTerminal());
  const open = summarizeCorrectionRun(partialFinal());
  const stagnated = summarizeCorrectionRun(stagnatedFinal());
  for (const summary of [approved, open]) {
    assert.deepEqual(
      [summary.final.unresolvedDefects, summary.final.comparison, summary.final.bestCandidate, summary.final.nextRemedy],
      [[], [], null, null], summary.final.status);
  }
  for (const summary of [approved, open, stagnated]) {
    assert.deepEqual(parseCorrectionSummaryBlock(formatCorrectionSummaryBlock(summary)), summary);
  }
  const edited = (summary, edit) => {
    const value = structuredClone(summary);
    edit(value.final);
    return value;
  };
  const cases = [
    edited(stagnated, (final) => { final.bestCandidate = null; }),
    edited(stagnated, (final) => { final.bestCandidate = { iteration: 2, observation: 'x', snapshot: null }; }),
    edited(stagnated, (final) => { final.bestCandidate.cost = 1; }),
    edited(stagnated, (final) => { final.comparison[0].verdict = 'better'; }),
    edited(stagnated, (final) => { final.unresolvedDefects = [7]; }),
    edited(stagnated, (final) => { final.nextRemedy = 7; }),
    edited(stagnated, (final) => { delete final.nextRemedy; }),
    edited(approved, (final) => { final.bestCandidate = structuredClone(stagnated.final.bestCandidate); }),
    edited(approved, (final) => { final.unresolvedDefects = ['SC4/review/missing-note']; }),
    edited(approved, (final) => { final.comparison = structuredClone(stagnated.final.comparison); }),
    edited(open, (final) => { final.nextRemedy = REMEDIES[3]; }),
  ];
  for (const [index, summary] of cases.entries()) {
    assert.throws(() => formatCorrectionSummaryBlock(summary), { name: 'TypeError', message: /final/u }, `format ${index}`);
    assert.throws(() => parseCorrectionSummaryBlock(block(JSON.stringify(summary, null, 2))),
      (error) => error.constructor === Error && /final/u.test(error.message), `parse ${index}`);
  }
  // A final's next remedy cannot forge a marker either.
  const forged = edited(stagnated, (final) => { final.nextRemedy = `${BLOCK_CLOSE} injected`; });
  assert.throws(() => formatCorrectionSummaryBlock(forged), { name: 'TypeError', message: /marker/u });
});
