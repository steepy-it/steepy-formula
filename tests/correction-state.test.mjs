import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORRECTION_CODES,
  CORRECTION_RECORD_KINDS,
  ITERATION_ALLOWANCE,
  applyCorrectionRecord,
  compareOutcomes,
  createCorrectionState,
  deriveCycleBindings,
  nextCorrectionStep,
  normalizeDefects,
  rankCandidates,
  replayCorrectionRecords,
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
  return result.state;
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
    'ITERATION_INTERRUPTED', 'ITERATION_RESERVED', 'RETRY_ADMITTED', 'REVIEW_RECORDED', 'RUN_HALTED', 'RUN_OPENED',
    'WRITER_RECORDED',
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
// with a rubric on SC1, and the final cycle opens before any task is delivered.
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
      return { checks: [{ ...GATE_CHECK }], bindings: [], rubricCriteria: [], review: 'required' };
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

test('RUN_OPENED opens the run once, as the first record, and keeps the plan', () => {
  const state = opened();
  assert.ok(isDeepFrozen(state));
  assert.equal(state.records, 1);
  assert.equal(state.run.planDigest, PLAN_DIGEST);
  assert.equal(state.run.drive, 'manual');
  assert.deepEqual(state.run.tasks, plan());
  assert.equal(nextCorrectionStep(state), null);
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

  const both = apply(state, cycleOpened('final'));
  assert.deepEqual(both.cycleOrder, ['task-1#1', 'final#1']);
  assert.deepEqual(nextCorrectionStep(both),
    { action: 'reserve', scope: 'final', cycle: 1, iteration: 1, kind: 'initial' });
  apply(opened(), cycleOpened('task-4'));
});

test('CYCLE_OPENED refuses unrunnable scopes, reopening and malformed payloads', () => {
  const state = apply(opened(), cycleOpened());
  for (const scope of ['task-3', 'task-9']) {
    const result = refused(applyCorrectionRecord(opened(), cycleOpened(scope)), REFUSAL.SCOPE_NOT_RUNNABLE);
    assert.equal(result.identity.scope, scope);
    assert.equal(result.identity.cycle, 1);
  }
  refused(applyCorrectionRecord(state, cycleOpened()), REFUSAL.SCOPE_NOT_RUNNABLE);
  const withFinal = apply(state, cycleOpened('final'));
  refused(applyCorrectionRecord(withFinal, cycleOpened('final')), REFUSAL.REOPEN_INVALID);
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
  return apply(opened(), cycleOpened(scope));
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

// The final cycle opens before any task is delivered, so it binds no criterion: its retries name the gate.
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
  assert.deepEqual(nextCorrectionStep(exhausted), { action: 'stopped', scope: 'task-1', cycle: 1, reason: STOP.EXHAUSTED });
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
  assert.deepEqual(nextCorrectionStep(state), { action: 'stopped', scope: 'task-1', cycle: 1, reason: STOP.EXHAUSTED });
  refused(applyCorrectionRecord(state, reserved(4, 'correction')), REFUSAL.CYCLE_TERMINAL);
});

test('an invalid diagnosis stops the cycle DIAGNOSIS_INCONCLUSIVE, at any slot', () => {
  const atTwo = apply(diagnosingAtTwo(), diagnosed(2, false, { hypothesis: '', remedy: '', recommendation: '' }));
  assert.equal(atTwo.cycles['task-1#1'].status, 'STOPPED');
  assert.equal(atTwo.cycles['task-1#1'].stopReason, STOP.DIAGNOSIS_INCONCLUSIVE);
  assert.deepEqual(nextCorrectionStep(atTwo),
    { action: 'stopped', scope: 'task-1', cycle: 1, reason: STOP.DIAGNOSIS_INCONCLUSIVE });
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
  assert.deepEqual(nextCorrectionStep(state),
    { action: 'stopped', scope: 'task-1', cycle: 1, reason: STOP.HUMAN_INTERRUPTED });
  refused(applyCorrectionRecord(state, interrupted(1)), REFUSAL.CYCLE_TERMINAL);
  refused(applyCorrectionRecord(state, stopped(STOP.HUMAN_INTERRUPTED)), REFUSAL.CYCLE_TERMINAL);
  refused(applyCorrectionRecord(state, cycleOpened()), REFUSAL.REOPEN_INVALID);
  apply(state, cycleOpened('task-2'));

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

// A valid run touching every record kind but RUN_HALTED, with the guard's refs for every record.
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
    cycleOpened('final'),
    reserved(1, 'initial', null, 'final'),
    authorized(1, 'final-reviewer', {}, 'final'),
    stopped(STOP.HUMAN_INTERRUPTED, 'final'),
    cycleOpened('task-2'),
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
    { action: 'reserve', scope: 'task-2', cycle: 1, iteration: 1, kind: 'initial' });
  apply(replayed, reserved(1, 'initial', null, 'task-2'));

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
  for (const scope of ['task-2', 'task-4', 'final']) apply(opened(), cycleOpened(scope));

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
    ['final', { checks: [{ id: 'surface-test-1', command: 'npm test' }, GATE_CHECK] }],
    ['final', { review: 'skipped' }],
    ['final', { rubricCriteria: ['SC1'] }],
  ];
  for (const [scope, overrides] of mismatches) {
    let result;
    assert.doesNotThrow(() => { result = applyCorrectionRecord(opened(), cycleOpened(scope, overrides)); });
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
  const unsatisfied = rubricResult([rubricEntry('SC1', {}, [
    { id: 'node-builtins-only', satisfied: true, evidence: 'no imports' },
    { id: 'no-time-conditions', satisfied: false, evidence: 'a deadline option exists' },
  ])]);
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
    { bindings: null, rubric: [], defects: [] }, { bindings, rubric: [], defects: 'none' },
    { bindings, rubric: [], defects: ['SC1'] }]) {
    assert.throws(() => validateRubric(call), { name: 'TypeError', message: /^validateRubric: /u });
  }
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
  assert.deepEqual(nextCorrectionStep(state), { action: 'stopped', scope: 'task-1', cycle: 1, reason: STOP.APPROVED });
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
  const unsatisfied = apply(reviewing(), reviewRecorded(1, 'APPROVED', {
    rubric: [rubricEntry('SC1', {}, [{ id: 'node-builtins-only', satisfied: false, evidence: 'imports a package' }])],
  }));
  assert.equal(unsatisfied.cycles['task-1#1'].status, 'OPEN');
  assert.equal(unsatisfied.cycles['task-1#1'].iterations[0].conclusion.approved, false);
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
  const delivered = deriveCycleBindings({ scope: 'final', deliveredTasks: [tasks[0]] });
  const state = approvedTaskOne();
  refused(applyCorrectionRecord(state, cycleOpened('final')), REFUSAL.RECORD_SCHEMA);
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
    ['SC1/surface-test-1/command-failed', 'SC2/surface-test-1/command-failed']);
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
  assert.deepEqual(nextCorrectionStep(stagnant), { action: 'stopped', scope: 'task-1', cycle: 1, reason: STOP.STAGNATED });
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
