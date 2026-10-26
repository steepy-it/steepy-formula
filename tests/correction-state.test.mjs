import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORRECTION_CODES,
  CORRECTION_RECORD_KINDS,
  ITERATION_ALLOWANCE,
  applyCorrectionRecord,
  createCorrectionState,
  nextCorrectionStep,
  replayCorrectionRecords,
  validateRetryRequest,
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
  assert.deepEqual(Object.keys(CORRECTION_CODES).sort(), ['halt', 'refusal', 'stop']);
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
    'CYCLE_OPENED', 'CYCLE_STOPPED', 'DIAGNOSIS_RECORDED', 'DISPATCH_AUTHORIZED', 'ITERATION_INTERRUPTED',
    'ITERATION_RESERVED', 'RETRY_ADMITTED', 'RUN_HALTED', 'RUN_OPENED',
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

function cycleOpened(scope = 'task-1', overrides = {}) {
  return {
    kind: 'CYCLE_OPENED',
    scope,
    cycle: 1,
    predecessor: null,
    checks: [{ id: 'check-1', command: 'npm test' }, { id: 'check-2', command: 'node --test tests/a.test.mjs' }],
    bindings: [{ criterion: 'SC1' }, { criterion: 'SC2', check: 'check-2' }],
    rubricCriteria: ['SC1'],
    review: 'required',
    observation: OBSERVATION,
    ...overrides,
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
  apply(opened(), cycleOpened('task-1', { checks: [], rubricCriteria: [], review: 'skipped' }));
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
  assert.deepEqual(nextCorrectionStep(reviewer),
    { action: 'record', scope: 'task-1', cycle: 1, iteration: 1, role: 'task-reviewer' });
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
    observedFailure: 'check-1 fails: the fourth reservation was accepted',
    evidence: ref(5),
    hypothesis: 'the allowance compares against the concluded count, not the reserved count',
    remedy: 'compare the requested iteration with the reserved count plus one',
    difference: 'the first attempt only bounded the concluded iterations',
    confirmingCheck: 'check-1',
    ...overrides,
  };
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
  for (const target of ['SC1', 'SC2', 'check-1', 'check-2']) {
    assert.deepEqual(validateRetryRequest(state, retryRequest({ target })), { ok: true }, target);
  }
  for (const target of ['SC3', 'SC9', 'check-9', '', 'review']) retryRefusal(state, { target }, REFUSAL.RETRY_INVALID);
  for (const confirmingCheck of ['check-1', 'check-2', 'review', 'rubric']) {
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
  const toolFailure = retryRequest({ kind: 'tool-failure', target: 'check-1' });
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
  for (const target of ['check-1', 'SC2']) {
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
  const request = retryRequest({ scope: 'final' });
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
    admitted(retryRequest({ scope: 'final' })), reserved(2, 'correction', null, 'final'),
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
    confirmingCheck: 'check-1',
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

  const rich = { criterion: 'SC1', check: 'check-1', threshold: 0.5, direction: null, meta: { tags: ['a', true, 2] } };
  const state = apply(opened(), cycleOpened('task-1', { bindings: [rich] }));
  assert.deepEqual(state.cycles['task-1#1'].bindings, [rich]);
  assert.ok(isDeepFrozen(state));
});
