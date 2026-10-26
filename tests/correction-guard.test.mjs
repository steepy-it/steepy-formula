import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORRECTION_GUARD_CODES,
  admitCorrectionRetry,
  authorizeCorrectionDispatch,
  checkCorrectionDrift,
  main,
  nextCorrectionAction,
  openCorrectionCycle,
  openCorrectionRun,
  projectCorrectionSummary,
  readCorrectionHead,
  recordCorrectionInterruption,
  reopenCorrectionScope,
  reserveCorrectionIteration,
  stopCorrectionCycle,
  verifyCorrectionRun,
} from '../scripts/correction-guard.mjs';
import { CORRECTION_CODES, deriveCycleBindings, parseCorrectionSummaryBlock } from '../scripts/correction-state.mjs';
import { observeSource } from '../scripts/source-observation.mjs';
import { parseTaskResultProjection } from '../scripts/task-results.mjs';

const PLAN = '.formula/work/plans/run.md';
const RUN = '.formula/work/tasks/run';
const CORRECTION = `${RUN}/correction`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const recordPath = (seq) => `${CORRECTION}/record-${seq}.json`;

function planTask(number, {
  complexity = 'integration', dependencies = 'none', testCommand = 'npm test', criteria = `SC${number}`,
} = {}) {
  return [
    `## Task ${number} — task ${number}`,
    '',
    '- **Surface:** scripts',
    `- **Complexity:** ${complexity}`,
    ...(dependencies === null ? [] : [`- **Dependencies:** ${dependencies}`]),
    ...(testCommand === null ? [] : [`- **Test command:** \`${testCommand}\``]),
    `- **Success criteria:** ${criteria}`,
    '',
  ].join('\n');
}

const planText = (...tasks) => `# Plan\n\n${tasks.join('\n')}`;
const PLAN_TWO = planText(planTask(1), planTask(2, { complexity: 'mechanical', dependencies: '1' }));

// A real temporary Git repository with one committed source file and the plan under the ignored work area.
function withRepo(plan, fn) {
  const root = mkdtempSync(join(tmpdir(), 'steepy-correction-guard-'));
  const git = (...args) => execFileSync('git', args, { cwd: root });
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const bytes = (path) => readFileSync(join(root, path));
  const json = (path) => JSON.parse(bytes(path).toString('utf8'));
  const exists = (path) => existsSync(join(root, path));
  try {
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.test');
    git('config', 'commit.gpgsign', 'false');
    put('.gitignore', '.formula/work/\n');
    put('source.txt', 'baseline\n');
    git('add', '.');
    git('commit', '-qm', 'baseline');
    if (plan !== null) put(PLAN, plan);
    return fn({ root, git, put, bytes, json, exists });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- codes and input contract ---------------------------------------------------------------------

test('CORRECTION_GUARD_CODES is a deep-frozen vocabulary with the guard codes', () => {
  for (const code of ['USAGE', 'PLAN_INVALID', 'INTEGRITY', 'ACTOR_INVALID']) {
    assert.equal(CORRECTION_GUARD_CODES[code], code);
  }
  assert.ok(Object.isFrozen(CORRECTION_GUARD_CODES));
  assert.throws(() => { CORRECTION_GUARD_CODES.EXTRA = 'EXTRA'; }, TypeError);
});

test('inputs and seams are closed: an unknown key is a TypeError naming the accepted keys', () => withRepo(PLAN_TWO, ({ root }) => {
  assert.throws(() => openCorrectionRun(root, { plan: PLAN, drive: 'manual', extra: 1 }),
    (error) => error instanceof TypeError && /accepted keys: .*plan.*drive/u.test(error.message));
  assert.throws(() => readCorrectionHead(root, { plan: PLAN }, { clock: () => 0 }),
    (error) => error instanceof TypeError && /observe/u.test(error.message));
  assert.throws(() => readCorrectionHead(root, { plan: PLAN }, { observe: 'not a function' }), TypeError);
  assert.throws(() => readCorrectionHead(root, 'not an object'), TypeError);
}));

// --- open -----------------------------------------------------------------------------------------

test('open rejects an invalid plan with PLAN_INVALID before any record exists', () => {
  const cases = [
    ['missing Dependencies', planText(planTask(1, { dependencies: null })), /missing Dependencies/u],
    ['a forward dependency', planText(planTask(1, { dependencies: '2' }), planTask(2)), /forward dependency/u],
    ['no Test command', planText(planTask(1), planTask(2, { testCommand: null })), /Task 2 .*Test command/u],
  ];
  for (const [label, plan, message] of cases) {
    withRepo(plan, ({ root, exists }) => {
      const result = openCorrectionRun(root, { plan: PLAN, drive: 'manual' });
      assert.equal(result.ok, false, label);
      assert.equal(result.code, CORRECTION_GUARD_CODES.PLAN_INVALID, label);
      assert.match(result.message, message, label);
      assert.equal(exists(CORRECTION), false, label);
    });
  }
  withRepo(null, ({ root, exists }) => {
    const missing = openCorrectionRun(root, { plan: PLAN, drive: 'manual' });
    assert.equal(missing.code, CORRECTION_GUARD_CODES.PLAN_INVALID);
    const outside = openCorrectionRun(root, { plan: 'docs/plan.md', drive: 'manual' });
    assert.equal(outside.code, CORRECTION_GUARD_CODES.PLAN_INVALID);
    assert.equal(exists(CORRECTION), false);
  });
});

test('open writes record-1 as the canonical RUN_OPENED envelope and reports the head', () => withRepo(PLAN_TWO, ({ root, bytes, git }) => {
  assert.deepEqual(readCorrectionHead(root, { plan: PLAN }), { ok: true, seq: 0, digest: null });
  const result = openCorrectionRun(root, { plan: PLAN, drive: 'manual' });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.appended, true);
  const written = bytes(recordPath(1));
  const envelope = JSON.parse(written.toString('utf8'));
  assert.equal(written.toString('utf8'), `${JSON.stringify(envelope)}\n`);
  assert.deepEqual(Object.keys(envelope), ['version', 'seq', 'previous', 'actor', 'record']);
  assert.deepEqual(envelope.actor, { drive: 'manual', runId: null, attempt: null });
  assert.equal(envelope.version, 1);
  assert.equal(envelope.seq, 1);
  assert.equal(envelope.previous, null);
  assert.equal(envelope.record.kind, 'RUN_OPENED');
  assert.equal(envelope.record.drive, 'manual');
  assert.equal(envelope.record.planDigest, sha256(bytes(PLAN)));
  assert.match(envelope.record.observation, /^[0-9a-f]{64}$/u);
  assert.deepEqual(envelope.record.tasks, [
    { task: '1', dependencies: [], complexity: 'integration', criterionIds: ['SC1'], testCommand: 'npm test' },
    { task: '2', dependencies: ['1'], complexity: 'mechanical', criterionIds: ['SC2'], testCommand: 'npm test' },
  ]);
  assert.deepEqual(result.head, { seq: 1, digest: sha256(written) });
  assert.deepEqual(result.ref, { path: recordPath(1), digest: sha256(written) });
  assert.deepEqual(result.next, { action: 'open-cycle', scope: 'task-1' });
  assert.deepEqual(readCorrectionHead(root, { plan: PLAN }), { ok: true, seq: 1, digest: sha256(written) });
  assert.equal(git('status', '--porcelain').toString(), '', 'the guard writes only under the ignored work area');
}));

test('open is a no-op for an identical payload and refuses a different one', () => withRepo(PLAN_TWO, ({ root, bytes, put, exists }) => {
  assert.equal(openCorrectionRun(root, { plan: PLAN, drive: 'manual' }).ok, true);
  const first = bytes(recordPath(1));
  const again = openCorrectionRun(root, { plan: PLAN, drive: 'manual' });
  assert.equal(again.ok, true);
  assert.equal(again.appended, false);
  assert.deepEqual(again.head, { seq: 1, digest: sha256(first) });
  const otherDrive = openCorrectionRun(root, { plan: PLAN, drive: 'autopilot', runId: 'run-1', attempt: 1 });
  assert.equal(otherDrive.ok, false);
  put(PLAN, planText(planTask(1), planTask(2, { dependencies: '1' })));
  const otherPlan = openCorrectionRun(root, { plan: PLAN, drive: 'manual' });
  assert.equal(otherPlan.ok, false);
  assert.match(otherPlan.message, /different/u);
  assert.deepEqual(bytes(recordPath(1)), first);
  assert.equal(exists(recordPath(2)), false);
}));

test('the plan digest normalizes only the lifecycle header status and consumed-by values', () => {
  const header = (status, consumedBy) => `<!-- steepy-workflow: v1\nphase: plan\nstatus: ${status}\nnext: implement\n`
    + `source: .formula/work/specs/run.md\nconsumed-by: ${consumedBy}\n-->\n`;
  const body = PLAN_TWO;
  const normalized = sha256(`${header('<lifecycle>', '<lifecycle>')}${body}`);
  withRepo(`${header('READY', 'none')}${body}`, ({ root, json, put }) => {
    assert.equal(openCorrectionRun(root, { plan: PLAN, drive: 'manual' }).ok, true);
    assert.equal(json(recordPath(1)).record.planDigest, normalized);
    put(PLAN, `${header('CONSUMED', `${RUN}/task-result-index.md`)}${body}`);
    const consumed = openCorrectionRun(root, { plan: PLAN, drive: 'manual' });
    assert.equal(consumed.ok, true, consumed.message);
    assert.equal(consumed.appended, false);
    put(PLAN, `${header('READY', 'none')}${body}\nAn edited requirement.\n`);
    assert.equal(openCorrectionRun(root, { plan: PLAN, drive: 'manual' }).ok, false);
  });
});

test('open refuses an unknown drive as invalid input', () => withRepo(PLAN_TWO, ({ root, exists }) => {
  const result = openCorrectionRun(root, { plan: PLAN, drive: 'cruise' });
  assert.equal(result.code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  assert.equal(exists(CORRECTION), false);
}));

// --- cycle lifecycle ------------------------------------------------------------------------------

const baselinePath = (scope, cycle) => `${CORRECTION}/${scope}-cycle-${cycle}-baseline.json`;
const manual = (input = {}) => ({ plan: PLAN, ...input });

test('open-cycle writes the full baseline observation, then CYCLE_OPENED with the derived bindings', () => withRepo(PLAN_TWO, ({ root, bytes, json }) => {
  openCorrectionRun(root, manual({ drive: 'manual' }));
  const result = openCorrectionCycle(root, manual({ scope: 'task-1', rubricCriteria: ['SC1'], reviewOptIn: false }));
  assert.equal(result.ok, true, result.message);
  const observation = observeSource(root);
  const baseline = bytes(baselinePath('task-1', 1));
  assert.equal(baseline.toString('utf8'), `${JSON.stringify({ version: 1, observation })}\n`);
  assert.deepEqual(result.baseline, { path: baselinePath('task-1', 1), digest: sha256(baseline) });
  const { record } = json(recordPath(2));
  const derived = deriveCycleBindings({
    scope: 'task-1',
    task: { task: '1', dependencies: [], complexity: 'integration', criterionIds: ['SC1'], testCommand: 'npm test' },
    rubricCriteria: ['SC1'],
    reviewOptIn: false,
  });
  assert.deepEqual(record, {
    kind: 'CYCLE_OPENED', scope: 'task-1', cycle: 1, predecessor: null, checks: derived.checks,
    bindings: derived.bindings, rubricCriteria: ['SC1'], review: derived.review, observation: observation.digest,
  });
  assert.deepEqual(result.next, { action: 'reserve', scope: 'task-1', cycle: 1, iteration: 1, kind: 'initial' });
}));

test('open-cycle refuses a scope that is not runnable or a rubric outside it, writing nothing', () => withRepo(PLAN_TWO, ({ root, exists }) => {
  openCorrectionRun(root, manual({ drive: 'manual' }));
  const blocked = openCorrectionCycle(root, manual({ scope: 'task-2' }));
  assert.equal(blocked.code, CORRECTION_CODES.refusal.SCOPE_NOT_RUNNABLE);
  const rubric = openCorrectionCycle(root, manual({ scope: 'task-1', rubricCriteria: ['SC2'] }));
  assert.equal(rubric.code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  assert.match(rubric.message, /SC2/u);
  assert.equal(exists(baselinePath('task-2', 1)), false);
  assert.equal(exists(baselinePath('task-1', 1)), false);
  assert.equal(exists(recordPath(2)), false);
}));

test('open-cycle reuses a byte-identical baseline left by a crash and fails closed on a different one', () => {
  withRepo(PLAN_TWO, ({ root, put, json }) => {
    openCorrectionRun(root, manual({ drive: 'manual' }));
    put(baselinePath('task-1', 1), `${JSON.stringify({ version: 1, observation: observeSource(root) })}\n`);
    const result = openCorrectionCycle(root, manual({ scope: 'task-1' }));
    assert.equal(result.ok, true, result.message);
    assert.equal(json(recordPath(2)).record.kind, 'CYCLE_OPENED');
  });
  withRepo(PLAN_TWO, ({ root, put, exists }) => {
    openCorrectionRun(root, manual({ drive: 'manual' }));
    put(baselinePath('task-1', 1), '{"version":1,"observation":null}\n');
    const result = openCorrectionCycle(root, manual({ scope: 'task-1' }));
    assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY);
    assert.equal(exists(recordPath(2)), false);
  });
});

test('reserve, authorize and next persist the iteration counters in the records', () => withRepo(PLAN_TWO, ({ root, json }) => {
  openCorrectionRun(root, manual({ drive: 'manual' }));
  openCorrectionCycle(root, manual({ scope: 'task-1' }));
  const reserved = reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
  assert.equal(reserved.ok, true, reserved.message);
  assert.deepEqual(json(recordPath(3)).record, {
    kind: 'ITERATION_RESERVED', scope: 'task-1', cycle: 1, iteration: 1, iterationKind: 'initial', reason: null,
  });
  assert.deepEqual(reserved.next, { action: 'authorize', scope: 'task-1', cycle: 1, iteration: 1, role: 'writer' });
  const again = reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
  assert.equal(again.code, CORRECTION_CODES.refusal.ALLOWANCE_EXHAUSTED);
  const authorized = authorizeCorrectionDispatch(root, manual({
    scope: 'task-1', iteration: 1, role: 'writer', target: 'scripts-agent',
  }));
  assert.equal(authorized.ok, true, authorized.message);
  assert.deepEqual(json(recordPath(4)).record, {
    kind: 'DISPATCH_AUTHORIZED', scope: 'task-1', cycle: 1, iteration: 1, role: 'writer', target: 'scripts-agent',
    ownerTask: null, affectedCriteria: [], observation: observeSource(root).digest,
  });
  const next = nextCorrectionAction(root, manual());
  assert.deepEqual(next, {
    ok: true,
    head: { seq: 4, digest: authorized.head.digest },
    next: { action: 'record', scope: 'task-1', cycle: 1, iteration: 1, role: 'writer' },
  });
}));

test('an interruption concludes the iteration with its own record as evidence and requires a retry', () => withRepo(PLAN_TWO, ({ root, bytes, json }) => {
  openCorrectionRun(root, manual({ drive: 'manual' }));
  openCorrectionCycle(root, manual({ scope: 'task-1' }));
  reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
  const interrupted = recordCorrectionInterruption(root, manual({ scope: 'task-1', iteration: 1, reason: 'the harness crashed' }));
  assert.equal(interrupted.ok, true, interrupted.message);
  assert.deepEqual(interrupted.ref, { path: recordPath(4), digest: sha256(bytes(recordPath(4))) });
  assert.deepEqual(json(recordPath(4)).record, {
    kind: 'ITERATION_INTERRUPTED', scope: 'task-1', cycle: 1, iteration: 1, reason: 'the harness crashed',
    observation: observeSource(root).digest,
  });
  assert.deepEqual(interrupted.next, {
    action: 'retry-or-diagnosis', scope: 'task-1', cycle: 1, iteration: 2, diagnosisAvailable: true,
  });
  const correction = reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 2, kind: 'correction' }));
  assert.equal(correction.code, CORRECTION_CODES.refusal.RETRY_REQUIRED);
}));

test('next reports a null step before the run is opened', () => withRepo(PLAN_TWO, ({ root }) => {
  assert.deepEqual(nextCorrectionAction(root, manual()), { ok: true, head: { seq: 0, digest: null }, next: null });
  const reserved = reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
  assert.equal(reserved.code, CORRECTION_CODES.refusal.RUN_NOT_OPEN);
}));

// --- replay integrity -----------------------------------------------------------------------------

// Writes the next record envelope by hand, chained to the current head, exactly as the format is
// specified: it stands in for actions that record outcomes and checks the on-disk format independently.
function appendEnvelope({ root, bytes, exists, put }, record, actor = { drive: 'manual', runId: null, attempt: null }) {
  let seq = 1;
  while (exists(recordPath(seq))) seq += 1;
  const previous = seq === 1 ? null : sha256(bytes(recordPath(seq - 1)));
  put(recordPath(seq), `${JSON.stringify({ version: 1, seq, previous, actor, record })}\n`);
  return { path: recordPath(seq), digest: sha256(bytes(recordPath(seq))) };
}

// A run with four records: RUN_OPENED, CYCLE_OPENED, ITERATION_RESERVED and DISPATCH_AUTHORIZED.
function fourRecords(root) {
  openCorrectionRun(root, manual({ drive: 'manual' }));
  openCorrectionCycle(root, manual({ scope: 'task-1' }));
  reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
  authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 1, role: 'writer', target: 'scripts-agent' }));
}

function assertIntegrity(root, exists, label) {
  for (const result of [readCorrectionHead(root, manual()), nextCorrectionAction(root, manual())]) {
    assert.equal(result.ok, false, label);
    assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY, label);
  }
  const mutation = recordCorrectionInterruption(root, manual({ scope: 'task-1', iteration: 1, reason: 'crash' }));
  assert.equal(mutation.code, CORRECTION_GUARD_CODES.INTEGRITY, label);
  assert.equal(exists(recordPath(5)), false, label);
  const command = cli(root, ['--action', 'verify']);
  assert.equal(command.status, 3, label);
  assert.equal(command.json.code, CORRECTION_GUARD_CODES.INTEGRITY, label);
}

test('a corrupted byte, a deleted middle record or an edited previous digest is an integrity failure', () => {
  const tamperings = {
    'a corrupted byte in a middle record': ({ put, bytes }) => put(recordPath(2),
      bytes(recordPath(2)).toString('utf8').replace('"scope":"task-1"', '"scope":"task-2"')),
    'a corrupted byte that breaks the head record': ({ put, bytes }) => {
      const text = bytes(recordPath(4)).toString('utf8');
      put(recordPath(4), `${text.slice(0, 10)}#${text.slice(11)}`);
    },
    'a deleted middle record': ({ root }) => unlinkSync(join(root, recordPath(2))),
    'an edited previous digest': ({ put, bytes }) => {
      const envelope = JSON.parse(bytes(recordPath(3)).toString('utf8'));
      envelope.previous = 'f'.repeat(64);
      put(recordPath(3), `${JSON.stringify(envelope)}\n`);
    },
    'a non-canonical serialization': ({ put, bytes }) => {
      put(recordPath(4), `${JSON.stringify(JSON.parse(bytes(recordPath(4)).toString('utf8')), null, 2)}\n`);
    },
    'a duplicate JSON key': ({ put, bytes }) => {
      const text = bytes(recordPath(4)).toString('utf8');
      put(recordPath(4), text.replace('{"version":1,', '{"version":1,"version":1,'));
    },
    'an actor of another drive': ({ put, bytes }) => {
      const envelope = JSON.parse(bytes(recordPath(4)).toString('utf8'));
      envelope.actor = { drive: 'autopilot', runId: 'run-1', attempt: 1 };
      put(recordPath(4), `${JSON.stringify(envelope)}\n`);
    },
    'an open envelope key': ({ put, bytes }) => {
      const envelope = JSON.parse(bytes(recordPath(4)).toString('utf8'));
      envelope.note = 'added';
      put(recordPath(4), `${JSON.stringify(envelope)}\n`);
    },
  };
  for (const [label, tamper] of Object.entries(tamperings)) {
    withRepo(PLAN_TWO, (repo) => {
      fourRecords(repo.root);
      tamper(repo);
      assertIntegrity(repo.root, repo.exists, label);
    });
  }
});

test('a record that does not replay is an integrity failure naming the record', () => withRepo(PLAN_TWO, (repo) => {
  fourRecords(repo.root);
  appendEnvelope(repo, { kind: 'ITERATION_RESERVED', scope: 'task-1', cycle: 1, iteration: 3, iterationKind: 'correction', reason: null });
  const result = nextCorrectionAction(repo.root, manual());
  assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY);
  assert.equal(result.identity.record, 5);
  assert.equal(result.identity.cause, CORRECTION_CODES.refusal.ALLOWANCE_EXHAUSTED);
}));

// --- drift guard ----------------------------------------------------------------------------------

const DRIFT = 'source drift outside an authorized writer dispatch';

test('a source edit between actions appends RUN_HALTED and every later action refuses the halted run', () => withRepo(PLAN_TWO, ({ root, put, json, bytes, exists }) => {
  openCorrectionRun(root, manual({ drive: 'manual' }));
  openCorrectionCycle(root, manual({ scope: 'task-1' }));
  const expected = json(recordPath(2)).record.observation;
  put('source.txt', 'edited outside any dispatch\n');
  const observed = observeSource(root).digest;
  const result = reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY);
  assert.equal(result.message, DRIFT);
  assert.equal(result.identity.expected, expected);
  assert.equal(result.identity.observed, observed);
  const halt = json(recordPath(3));
  assert.deepEqual(halt.record, {
    kind: 'RUN_HALTED', reason: DRIFT,
    evidence: [{ path: recordPath(2), digest: sha256(bytes(recordPath(2))) }], observation: observed,
  });
  assert.deepEqual(halt.actor, { drive: 'manual', runId: null, attempt: null });
  put('source.txt', 'baseline\n');
  const later = reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
  assert.equal(later.code, CORRECTION_GUARD_CODES.RUN_HALTED);
  assert.equal(exists(recordPath(4)), false);
  const next = nextCorrectionAction(root, manual());
  assert.equal(next.ok, false);
  assert.equal(next.code, CORRECTION_GUARD_CODES.RUN_HALTED);
  assert.deepEqual(next.next, { action: 'halted', reason: DRIFT });
  assert.equal(next.head.seq, 3);
}));

test('an untracked source file is drift, while work-area writes are not', () => withRepo(PLAN_TWO, ({ root, put, json }) => {
  openCorrectionRun(root, manual({ drive: 'manual' }));
  put(`${RUN}/notes.md`, 'work-area notes are not source\n');
  assert.equal(openCorrectionCycle(root, manual({ scope: 'task-1' })).ok, true);
  put('new-file.txt', 'untracked source\n');
  const result = reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
  assert.equal(result.message, DRIFT);
  assert.equal(json(recordPath(3)).record.kind, 'RUN_HALTED');
}));

test('the drift check exempts only an authorized, unrecorded writer when the window is passed', () => {
  withRepo(PLAN_TWO, ({ root, put, exists }) => {
    openCorrectionRun(root, manual({ drive: 'manual' }));
    openCorrectionCycle(root, manual({ scope: 'task-1' }));
    reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
    authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 1, role: 'writer', target: 'scripts-agent' }));
    put('source.txt', 'the writer changed this\n');
    const outside = checkCorrectionDrift(root, manual());
    assert.equal(outside.code, CORRECTION_GUARD_CODES.INTEGRITY);
    assert.equal(outside.message, DRIFT);
    const window = checkCorrectionDrift(root, manual({ authorizedWriterWindow: true }));
    assert.deepEqual(window, { ok: true, observation: observeSource(root).digest, window: true });
    assert.equal(exists(recordPath(5)), false, 'the drift check writes nothing');
    const interrupted = recordCorrectionInterruption(root, manual({ scope: 'task-1', iteration: 1, reason: 'crash' }));
    assert.equal(interrupted.message, DRIFT, 'only the writer-recording action may pass the window');
  });
  withRepo(PLAN_TWO, ({ root, put }) => {
    openCorrectionRun(root, manual({ drive: 'manual' }));
    openCorrectionCycle(root, manual({ scope: 'task-1' }));
    reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
    assert.deepEqual(checkCorrectionDrift(root, manual({ authorizedWriterWindow: true })),
      { ok: true, observation: observeSource(root).digest, window: false });
    put('source.txt', 'no writer is authorized\n');
    const result = checkCorrectionDrift(root, manual({ authorizedWriterWindow: true }));
    assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY);
    assert.throws(() => checkCorrectionDrift(root, manual({ authorizedWriterWindow: 'yes' })), TypeError);
  });
});

// --- actor ----------------------------------------------------------------------------------------

const manifestPath = (attempt) => `${RUN}/context/phase-implement-attempt-${attempt}.json`;
const manifest = (runId, attempt, overrides = {}) => `${JSON.stringify({
  schemaVersion: 1, runId, attempt, scope: { phase: 'implement', role: 'implement' },
  contract: { taskResultProtocol: 2 }, ...overrides,
})}\n`;

test('an autopilot drive requires a run id and attempt matching the implement phase manifest', () => withRepo(PLAN_TWO, ({ root, put, json, exists }) => {
  const open = (input) => openCorrectionRun(root, manual({ drive: 'autopilot', ...input }));
  const refusals = [
    ['no run id or attempt', {}, null],
    ['an attempt without a run id', { attempt: 1 }, null],
    ['an invalid run id', { runId: 'bad id', attempt: 1 }, null],
    ['an invalid attempt', { runId: 'run-1', attempt: 0 }, null],
    ['a missing manifest', { runId: 'run-1', attempt: 1 }, null],
    ['a mismatched run id', { runId: 'run-1', attempt: 1 }, manifest('run-2', 1)],
    ['a mismatched attempt', { runId: 'run-1', attempt: 1 }, manifest('run-1', 2)],
    ['another phase', { runId: 'run-1', attempt: 1 }, manifest('run-1', 1, { scope: { phase: 'review', role: 'implement' } })],
    ['another role', { runId: 'run-1', attempt: 1 }, manifest('run-1', 1, { scope: { phase: 'implement', role: 'plan' } })],
    ['another protocol', { runId: 'run-1', attempt: 1 }, manifest('run-1', 1, { contract: { taskResultProtocol: 1 } })],
    ['a duplicate manifest key', { runId: 'run-1', attempt: 1 }, manifest('run-1', 1).replace('{"schemaVersion":1,', '{"runId":"run-1","schemaVersion":1,')],
  ];
  for (const [label, input, content] of refusals) {
    if (content !== null) put(manifestPath(1), content);
    const result = open(input);
    assert.equal(result.code, CORRECTION_GUARD_CODES.ACTOR_INVALID, label);
    assert.equal(exists(recordPath(1)), false, label);
  }
  put(manifestPath(1), manifest('run-1', 1));
  const opened = open({ runId: 'run-1', attempt: 1 });
  assert.equal(opened.ok, true, opened.message);
  assert.deepEqual(json(recordPath(1)).actor, { drive: 'autopilot', runId: 'run-1', attempt: 1 });

  const cycle = (input) => openCorrectionCycle(root, manual({ scope: 'task-1', ...input }));
  assert.equal(cycle({}).code, CORRECTION_GUARD_CODES.ACTOR_INVALID);
  assert.equal(cycle({ runId: 'run-1' }).code, CORRECTION_GUARD_CODES.ACTOR_INVALID);
  assert.equal(cycle({ runId: 'run-1', attempt: 2 }).code, CORRECTION_GUARD_CODES.ACTOR_INVALID);
  put(manifestPath(2), manifest('run-1', 2));
  const resumed = cycle({ runId: 'run-1', attempt: 2 });
  assert.equal(resumed.ok, true, resumed.message);
  assert.deepEqual(json(recordPath(2)).actor, { drive: 'autopilot', runId: 'run-1', attempt: 2 });
  assert.equal(exists(recordPath(3)), false);
}));

test('a manual drive refuses a run id or attempt', () => withRepo(PLAN_TWO, ({ root, put, exists }) => {
  put(manifestPath(1), manifest('run-1', 1));
  assert.equal(openCorrectionRun(root, manual({ drive: 'manual', runId: 'run-1', attempt: 1 })).code,
    CORRECTION_GUARD_CODES.ACTOR_INVALID);
  assert.equal(exists(recordPath(1)), false);
  openCorrectionRun(root, manual({ drive: 'manual' }));
  for (const input of [{ runId: 'run-1' }, { attempt: 1 }, { runId: 'run-1', attempt: 1 }]) {
    assert.equal(openCorrectionCycle(root, manual({ scope: 'task-1', ...input })).code, CORRECTION_GUARD_CODES.ACTOR_INVALID);
  }
  assert.equal(exists(recordPath(2)), false);
}));

// --- retry, stop and reopen -----------------------------------------------------------------------

const retryPath = (n, scope = 'task-1', cycle = 1) => `${CORRECTION}/${scope}-cycle-${cycle}-retry-${n}.json`;
const reopenPath = (scope = 'task-1', cycle = 1) => `${CORRECTION}/${scope}-cycle-${cycle}-reopen.json`;

function interruptedRun(root) {
  openCorrectionRun(root, manual({ drive: 'manual' }));
  openCorrectionCycle(root, manual({ scope: 'task-1' }));
  reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
  return recordCorrectionInterruption(root, manual({ scope: 'task-1', iteration: 1, reason: 'the harness crashed' })).ref;
}

const retryRequest = (evidence, overrides = {}) => ({
  version: 1, scope: 'task-1', cycle: 1, iteration: 2, kind: 'tool-failure', target: 'SC1',
  observedFailure: 'the harness exited before the writer reported', evidence,
  hypothesis: 'the dispatch ran out of memory', remedy: 'dispatch the writer with a smaller context',
  difference: 'the context is halved', confirmingCheck: 'surface-test', ...overrides,
});

test('admit-retry records the strict request with the digest of its bytes', () => withRepo(PLAN_TWO, ({ root, put, bytes, json }) => {
  const evidence = interruptedRun(root);
  put(retryPath(1), `${JSON.stringify(retryRequest(evidence))}\n`);
  const admitted = admitCorrectionRetry(root, manual({ request: retryPath(1) }));
  assert.equal(admitted.ok, true, admitted.message);
  assert.deepEqual(json(recordPath(5)).record, {
    kind: 'RETRY_ADMITTED', scope: 'task-1', cycle: 1, iteration: 2, request: retryRequest(evidence),
    requestDigest: sha256(bytes(retryPath(1))),
  });
  assert.deepEqual(admitted.next, { action: 'reserve', scope: 'task-1', cycle: 1, iteration: 2, kind: 'correction' });
  const reserved = reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 2, kind: 'correction' }));
  assert.equal(reserved.ok, true, reserved.message);
}));

test('admit-retry refuses a misplaced, missing, duplicate-keyed, misnamed or unbound request, writing nothing', () => withRepo(PLAN_TWO, ({ root, put, exists }) => {
  const evidence = interruptedRun(root);
  const valid = `${JSON.stringify(retryRequest(evidence))}\n`;
  put(`${RUN}/retry.json`, valid);
  const cases = [
    ['a path outside the correction family', `${RUN}/retry.json`, CORRECTION_GUARD_CODES.INPUT_INVALID],
    ['another run', '.formula/work/tasks/other/correction/task-1-cycle-1-retry-1.json', CORRECTION_GUARD_CODES.INPUT_INVALID],
    ['a missing request', retryPath(1), CORRECTION_GUARD_CODES.INPUT_INVALID],
  ];
  for (const [label, request, code] of cases) {
    assert.equal(admitCorrectionRetry(root, manual({ request })).code, code, label);
  }
  put(retryPath(2), valid.replace('{"version":1,', '{"version":1,"version":1,'));
  assert.equal(admitCorrectionRetry(root, manual({ request: retryPath(2) })).code, CORRECTION_CODES.refusal.RETRY_INVALID);
  put(retryPath(3, 'task-1', 2), valid);
  assert.equal(admitCorrectionRetry(root, manual({ request: retryPath(3, 'task-1', 2) })).code,
    CORRECTION_CODES.refusal.RETRY_INVALID);
  put(retryPath(4), `${JSON.stringify(retryRequest(evidence, { remedy: 'retry' }))}\n`);
  assert.equal(admitCorrectionRetry(root, manual({ request: retryPath(4) })).code, CORRECTION_CODES.refusal.RETRY_STATUS_ONLY);
  put(retryPath(5), `${JSON.stringify(retryRequest({ path: `${RUN}/other.md`, digest: '0'.repeat(64) }))}\n`);
  assert.equal(admitCorrectionRetry(root, manual({ request: retryPath(5) })).code,
    CORRECTION_CODES.refusal.RETRY_EVIDENCE_UNBOUND);
  assert.equal(exists(recordPath(5)), false);
}));

test('stop records an explicit stop and the run then requires the isolation proof', () => withRepo(PLAN_TWO, ({ root, json }) => {
  interruptedRun(root);
  const invalid = stopCorrectionCycle(root, manual({ scope: 'task-1', reason: 'EXHAUSTED', note: 'not explicit' }));
  assert.equal(invalid.code, CORRECTION_CODES.refusal.RECORD_SCHEMA);
  const stopped = stopCorrectionCycle(root, manual({ scope: 'task-1', reason: 'HUMAN_INTERRUPTED', note: 'paused by the user' }));
  assert.equal(stopped.ok, true, stopped.message);
  assert.deepEqual(json(recordPath(5)).record, {
    kind: 'CYCLE_STOPPED', scope: 'task-1', cycle: 1, reason: 'HUMAN_INTERRUPTED', note: 'paused by the user',
  });
  assert.deepEqual(stopped.next, { action: 'prove-isolation', scope: 'task-1', cycle: 1 });
  assert.equal(openCorrectionCycle(root, manual({ scope: 'task-2' })).code, CORRECTION_CODES.refusal.ISOLATION_REQUIRED);
}));

// A stopped task-1 cycle 1 whose isolation is proven baseline-equal (recorded by hand, standing in for
// the isolation-recording action).
function stoppedAndIsolated(repo) {
  interruptedRun(repo.root);
  stopCorrectionCycle(repo.root, manual({ scope: 'task-1', reason: 'HUMAN_INTERRUPTED', note: 'paused by the user' }));
  appendEnvelope(repo, {
    kind: 'ISOLATION_RECORDED', scope: 'task-1', cycle: 1, mode: 'baseline-equal', observation: observeSource(repo.root).digest,
  });
}

const reopenBody = (overrides = {}) => `${JSON.stringify({
  version: 1, scope: 'task-1', statement: 'I reopen Task 1 with a different parser.', remedy: 'parse with a streaming reader',
  ...overrides,
})}\n`;

test('reopen refuses a run id or attempt: autopilot cannot grant reopening', () => withRepo(PLAN_TWO, (repo) => {
  stoppedAndIsolated(repo);
  repo.put(reopenPath(), reopenBody());
  for (const input of [{ runId: 'run-1' }, { attempt: 1 }, { runId: 'run-1', attempt: 1 }]) {
    const result = reopenCorrectionScope(repo.root, manual({ authorization: reopenPath(), ...input }));
    assert.equal(result.code, CORRECTION_GUARD_CODES.ACTOR_INVALID);
  }
  assert.equal(repo.exists(recordPath(7)), false);
}));

test('an autopilot drive cannot reopen at all', () => withRepo(PLAN_TWO, ({ root, put }) => {
  put(manifestPath(1), manifest('run-1', 1));
  openCorrectionRun(root, manual({ drive: 'autopilot', runId: 'run-1', attempt: 1 }));
  put(reopenPath(), reopenBody());
  assert.equal(reopenCorrectionScope(root, manual({ authorization: reopenPath() })).code, CORRECTION_GUARD_CODES.ACTOR_INVALID);
}));

test('the manual reopen flow authorizes the reopen and opens the linked cycle', () => withRepo(PLAN_TWO, (repo) => {
  const { root, put, bytes, json } = repo;
  stoppedAndIsolated(repo);
  put(reopenPath(), reopenBody());
  const reopened = reopenCorrectionScope(root, manual({ authorization: reopenPath() }));
  assert.equal(reopened.ok, true, reopened.message);
  assert.deepEqual(json(recordPath(7)).record, {
    kind: 'REOPEN_AUTHORIZED', scope: 'task-1', cycle: 2, predecessor: 'task-1#1',
    authorization: { path: reopenPath(), digest: sha256(bytes(reopenPath())) },
    statement: 'I reopen Task 1 with a different parser.', remedy: 'parse with a streaming reader',
  });
  assert.deepEqual(reopened.next, { action: 'open-cycle', scope: 'task-1', cycle: 2, predecessor: 'task-1#1' });
  const opened = openCorrectionCycle(root, manual({ scope: 'task-1' }));
  assert.equal(opened.ok, true, opened.message);
  const { record } = json(recordPath(8));
  assert.equal(record.kind, 'CYCLE_OPENED');
  assert.equal(record.cycle, 2);
  assert.equal(record.predecessor, 'task-1#1');
  assert.equal(opened.baseline.path, baselinePath('task-1', 2));
}));

test('reopen refuses a malformed, misnamed or never-run authorization, writing nothing', () => withRepo(PLAN_TWO, (repo) => {
  const { root, put, exists } = repo;
  stoppedAndIsolated(repo);
  const cases = [
    ['an open key', reopenPath(), reopenBody({ extra: true })],
    ['another version', reopenPath(), reopenBody({ version: 2 })],
    ['a duplicate key', reopenPath(), reopenBody().replace('{"version":1,', '{"version":1,"version":1,')],
    ['a misnamed file', reopenPath('task-2'), reopenBody()],
    ['a scope that never ran', reopenPath('task-2'), reopenBody({ scope: 'task-2', statement: 'Reopen Task 2.' })],
  ];
  for (const [label, path, body] of cases) {
    put(path, body);
    assert.equal(reopenCorrectionScope(root, manual({ authorization: path })).code, CORRECTION_CODES.refusal.REOPEN_INVALID, label);
  }
  assert.equal(reopenCorrectionScope(root, manual({ authorization: `${RUN}/reopen.json` })).code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  put(reopenPath(), reopenBody({ statement: 'Reopen it please.' }));
  assert.equal(reopenCorrectionScope(root, manual({ authorization: reopenPath() })).code, CORRECTION_CODES.refusal.REOPEN_INVALID);
  assert.equal(exists(recordPath(7)), false);
}));

// --- summary projection ---------------------------------------------------------------------------

const INDEX = `${RUN}/task-result-index.md`;
const OPEN_MARKER = '<!-- steepy-correction-summary: v1 -->';
const CLOSE_MARKER = '<!-- /steepy-correction-summary -->';
const project = (root, input = {}) => projectCorrectionSummary(root, manual({ taskResultIndex: INDEX, ...input }));
const occurrences = (text, marker) => text.split(marker).length - 1;

test('project is allowed only at a final-cycle step or terminal, for the run index', () => withRepo(PLAN_TWO, (repo) => {
  const { root, put, bytes, exists } = repo;
  openCorrectionRun(root, manual({ drive: 'manual' }));
  put(INDEX, '# Index\n');
  assert.equal(project(root).code, CORRECTION_GUARD_CODES.STEP_INVALID);
  interruptedRun(root);
  stopCorrectionCycle(root, manual({ scope: 'task-1', reason: 'HUMAN_INTERRUPTED', note: 'paused by the user' }));
  assert.equal(project(root).code, CORRECTION_GUARD_CODES.STEP_INVALID, 'prove-isolation is not final-cycle related');
  assert.equal(project(root, { taskResultIndex: `${RUN}/other-index.md` }).code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  assert.deepEqual(bytes(INDEX).toString('utf8'), '# Index\n');
  assert.equal(exists(`${RUN}/other-index.md`), false);
}));

test('project appends the summary block to a bullet index, then replaces it keeping every other byte', () => withRepo(PLAN_TWO, (repo) => {
  const { root, put, bytes } = repo;
  const original = '# Task results\n\n- Task 1: manual bullet kept verbatim\nReviewer gate Task 1: none';
  put(INDEX, original);
  stoppedAndIsolated(repo);
  const first = project(root);
  assert.equal(first.ok, true, first.message);
  assert.equal(first.changed, true);
  const appended = bytes(INDEX).toString('utf8');
  assert.ok(appended.startsWith(`${original}\n${OPEN_MARKER}\n`), 'the block follows a separating newline');
  assert.ok(appended.endsWith(`${CLOSE_MARKER}\n`));
  const summary = parseCorrectionSummaryBlock(appended);
  assert.equal(summary.outcome, 'PENDING');
  assert.deepEqual(summary.completed, []);
  assert.deepEqual(summary.stopped.map((entry) => [entry.task, entry.reason]), [['1', 'HUMAN_INTERRUPTED']]);
  assert.deepEqual(summary.blocked, [{ task: '2', causes: ['1'] }]);
  assert.equal(summary.final, null);
  assert.deepEqual(first.summary, summary);

  const edited = `${appended}\nA note written after the block.\n`;
  put(INDEX, edited);
  openCorrectionCycle(root, manual({ scope: 'final' }));
  const second = project(root);
  assert.equal(second.ok, true, second.message);
  const replaced = bytes(INDEX).toString('utf8');
  const start = edited.indexOf(OPEN_MARKER);
  const end = edited.indexOf(CLOSE_MARKER) + CLOSE_MARKER.length;
  assert.ok(replaced.startsWith(edited.slice(0, start)));
  assert.ok(replaced.endsWith(edited.slice(end)));
  assert.equal(occurrences(replaced, OPEN_MARKER), 1);
  assert.equal(parseCorrectionSummaryBlock(replaced).final.status, 'OPEN');

  const unchanged = project(root);
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.changed, false);
  assert.equal(bytes(INDEX).toString('utf8'), replaced);
}));

test('project keeps a v2 receipt block intact and parseable', () => withRepo(PLAN_TWO, (repo) => {
  const { root, put, bytes } = repo;
  const receipts = '# Task results\n\n<!-- steepy-task-results: v2 -->\n```json\n[]\n```\n<!-- /steepy-task-results -->\n'
    + 'Reviewer gate final: pending\n';
  put(INDEX, receipts);
  stoppedAndIsolated(repo);
  assert.equal(project(root).ok, true);
  const appended = bytes(INDEX).toString('utf8');
  assert.ok(appended.startsWith(`${receipts}\n${OPEN_MARKER}`));
  assert.deepEqual(parseTaskResultProjection(appended), []);
  openCorrectionCycle(root, manual({ scope: 'final' }));
  assert.equal(project(root).ok, true);
  const replaced = bytes(INDEX).toString('utf8');
  assert.ok(replaced.startsWith(receipts));
  assert.deepEqual(parseTaskResultProjection(replaced), []);
  assert.equal(occurrences(replaced, OPEN_MARKER), 1);
}));

test('project creates an absent index and refuses a malformed summary block without writing', () => withRepo(PLAN_TWO, (repo) => {
  const { root, put, bytes, exists } = repo;
  stoppedAndIsolated(repo);
  assert.equal(exists(INDEX), false);
  assert.equal(project(root).ok, true);
  assert.ok(bytes(INDEX).toString('utf8').startsWith(`${OPEN_MARKER}\n`));
  const duplicated = `# Index\n${OPEN_MARKER}\n${OPEN_MARKER}\n${CLOSE_MARKER}\n`;
  put(INDEX, duplicated);
  const result = project(root);
  assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY);
  assert.equal(bytes(INDEX).toString('utf8'), duplicated);
}));

test('project refuses a summary whose recorded text would forge a summary marker', () => withRepo(PLAN_TWO, (repo) => {
  const { root, put, bytes } = repo;
  const evidence = interruptedRun(root);
  put(retryPath(1), `${JSON.stringify(retryRequest(evidence, { remedy: `${OPEN_MARKER} parse with a streaming reader` }))}\n`);
  assert.equal(admitCorrectionRetry(root, manual({ request: retryPath(1) })).ok, true);
  stopCorrectionCycle(root, manual({ scope: 'task-1', reason: 'HUMAN_INTERRUPTED', note: 'paused by the user' }));
  appendEnvelope(repo, {
    kind: 'ISOLATION_RECORDED', scope: 'task-1', cycle: 1, mode: 'baseline-equal', observation: observeSource(root).digest,
  });
  put(INDEX, '# Index\n');
  const result = project(root);
  assert.equal(result.code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  assert.match(result.message, /marker/u);
  assert.equal(bytes(INDEX).toString('utf8'), '# Index\n');
}));

// --- verify ---------------------------------------------------------------------------------------

test('verify replays the run and checks drift without writing a record', () => withRepo(PLAN_TWO, (repo) => {
  const { root, put, exists } = repo;
  assert.equal(verifyCorrectionRun(root, manual()).code, CORRECTION_CODES.refusal.RUN_NOT_OPEN);
  fourRecords(root);
  const verified = verifyCorrectionRun(root, manual());
  assert.equal(verified.ok, true, verified.message);
  assert.deepEqual(Object.keys(verified), ['ok', 'head', 'next', 'summary']);
  assert.equal(verified.head.seq, 4);
  assert.deepEqual(verified.next, { action: 'record', scope: 'task-1', cycle: 1, iteration: 1, role: 'writer' });
  assert.equal(verified.summary.outcome, 'PENDING');
  assert.deepEqual(verified.summary.cycles.map((cycle) => [cycle.scope, cycle.status, cycle.reserved]), [['task-1', 'OPEN', 1]]);

  put('source.txt', 'drifted\n');
  const drifted = verifyCorrectionRun(root, manual());
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, CORRECTION_GUARD_CODES.INTEGRITY);
  assert.equal(drifted.message, DRIFT);
  assert.equal(drifted.head.seq, 4);
  assert.equal(drifted.summary.outcome, 'PENDING');
  assert.equal(exists(recordPath(5)), false, 'verify never halts the run');

  recordCorrectionInterruption(root, manual({ scope: 'task-1', iteration: 1, reason: 'crash' }));
  const halted = verifyCorrectionRun(root, manual());
  assert.equal(halted.code, CORRECTION_GUARD_CODES.RUN_HALTED);
  assert.deepEqual(halted.next, { action: 'halted', reason: DRIFT });
  assert.equal(halted.summary.outcome, 'HALTED');
  assert.equal(halted.head.seq, 5);
}));

// --- CLI ------------------------------------------------------------------------------------------

const SCRIPT = fileURLToPath(new URL('../scripts/correction-guard.mjs', import.meta.url));

// Runs the CLI in a new process. Every invocation that is not a migrate refusal prints exactly one JSON
// line on stdout.
function cli(root, args, { plan = PLAN } = {}) {
  const argv = [SCRIPT, '--repo-root', root, ...(plan === null ? [] : ['--plan', plan]), ...args];
  const result = spawnSync(process.execPath, argv, { cwd: root, encoding: 'utf8' });
  if (result.status !== 25) {
    assert.match(result.stdout, /^[^\n]+\n$/u, `one JSON line on stdout for ${args.join(' ')}`);
  }
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, json: result.status === 25 ? null : JSON.parse(result.stdout) };
}

function exitTable(text) {
  const section = text.slice(text.indexOf('Exit codes:'));
  return Object.fromEntries([...section.matchAll(/^(?:\/\/)?\s+(\d+)\s{2,}(.+)$/gmu)].map(([, code, meaning]) => [code, meaning.trim()]));
}

const EXIT_TABLE = {
  0: 'success',
  1: 'refused transition or invalid input',
  2: 'usage error',
  3: 'integrity failure (run halted or evidence corrupt)',
  25: 'migrate refusal, checked before any output or write',
};

test('the usage text and the header document the exit codes, and the CLI uses them', () => withRepo(PLAN_TWO, (repo) => {
  const { root, put } = repo;
  const usage = cli(root, [], { plan: null });
  assert.equal(usage.status, 2);
  assert.equal(usage.json.code, CORRECTION_GUARD_CODES.USAGE);
  assert.deepEqual(exitTable(usage.stderr), EXIT_TABLE);
  const source = readFileSync(SCRIPT, 'utf8');
  assert.deepEqual(exitTable(source.slice(0, source.indexOf('\nimport '))), EXIT_TABLE);

  assert.equal(cli(root, ['--action', 'open', '--drive', 'manual']).status, 0);
  assert.equal(cli(root, ['--action', 'open-cycle', '--scope', 'task-2']).json.code, CORRECTION_CODES.refusal.SCOPE_NOT_RUNNABLE);
  assert.equal(cli(root, ['--action', 'open-cycle', '--scope', 'task-2']).status, 1);
  put('source.txt', 'drifted\n');
  const drift = cli(root, ['--action', 'open-cycle', '--scope', 'task-1']);
  assert.equal(drift.status, 3);
  assert.equal(drift.json.message, DRIFT);
  assert.equal(cli(root, ['--action', 'next']).status, 3, 'every action on a halted run exits 3');
  assert.equal(cli(root, ['--action', 'verify']).status, 3);
}));

test('usage errors exit 2 with one JSON line and write nothing', () => withRepo(PLAN_TWO, ({ root, exists }) => {
  const cases = [
    [['--action', 'bogus'], /unknown action/u],
    [['--action', 'open'], /--drive/u],
    [['--action', 'open', '--drive', 'manual', '--scope', 'task-1'], /--scope/u],
    [['--action', 'open', '--drive', 'manual', '--drive', 'manual'], /--drive/u],
    [['--action', 'open', '--drive', 'manual', 'extra'], /extra/u],
    [['--action', 'open', '--drive', 'manual', '--bogus', 'x'], /bogus/u],
    [['--action', 'reserve', '--scope', 'task-1', '--iteration', 'one', '--kind', 'initial'], /--iteration/u],
    [['--action', 'open', '--drive', 'autopilot', '--run-id', 'r', '--attempt', '0'], /--attempt/u],
    [['--action', 'next', '--run-id', 'r'], /--run-id/u],
  ];
  for (const [args, message] of cases) {
    const result = cli(root, args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.json.ok, false, args.join(' '));
    assert.equal(result.json.code, CORRECTION_GUARD_CODES.USAGE, args.join(' '));
    assert.match(result.json.message, message, args.join(' '));
    assert.match(result.stderr, /Exit codes:/u, args.join(' '));
  }
  assert.equal(cli(root, ['--action', 'next'], { plan: null }).status, 2);
  const missingRoot = spawnSync(process.execPath, [SCRIPT, '--repo-root', join(root, 'missing'), '--plan', PLAN, '--action', 'next'], { encoding: 'utf8' });
  assert.equal(missingRoot.status, 2);
  assert.equal(exists(CORRECTION), false);
}));

test('a .apex entry in any form makes the CLI exit 25 before any output or write', () => {
  for (const form of ['directory', 'file', 'dangling link']) {
    withRepo(PLAN_TWO, ({ root, put, exists }) => {
      if (form === 'directory') put('.apex/_INDEX.md', '# hub\n');
      if (form === 'file') put('.apex', 'legacy\n');
      if (form === 'dangling link') symlinkSync(join(root, 'nowhere'), join(root, '.apex'));
      for (const args of [['--action', 'open', '--drive', 'manual'], ['--action', 'bogus']]) {
        const result = cli(root, args);
        assert.equal(result.status, 25, `${form}: ${args.join(' ')}`);
        assert.equal(result.stdout, '', form);
        assert.match(result.stderr, /^correction-guard: .*graph-migrate[^\n]*\n$/u, form);
      }
      assert.equal(exists(CORRECTION), false, form);
    });
  }
});

test('counters persist across processes: a reservation then a crash leaves iteration 1 spent and a retry required', () => withRepo(PLAN_TWO, ({ root }) => {
  assert.equal(cli(root, ['--action', 'open', '--drive', 'manual']).status, 0);
  assert.equal(cli(root, ['--action', 'open-cycle', '--scope', 'task-1']).status, 0);
  const reserved = cli(root, ['--action', 'reserve', '--scope', 'task-1', '--iteration', '1', '--kind', 'initial']);
  assert.equal(reserved.status, 0);
  // The process that reserved iteration 1 is gone; a new one sees the reservation spent.
  const afterCrash = cli(root, ['--action', 'next']);
  assert.deepEqual(afterCrash.json.next, { action: 'authorize', scope: 'task-1', cycle: 1, iteration: 1, role: 'writer' });
  const again = cli(root, ['--action', 'reserve', '--scope', 'task-1', '--iteration', '1', '--kind', 'initial']);
  assert.equal(again.status, 1);
  assert.equal(again.json.code, CORRECTION_CODES.refusal.ALLOWANCE_EXHAUSTED);
  const interrupted = cli(root, ['--action', 'record-interruption', '--scope', 'task-1', '--iteration', '1', '--reason', 'the session crashed']);
  assert.equal(interrupted.status, 0);
  assert.deepEqual(interrupted.json.ref, { path: recordPath(4), digest: interrupted.json.head.digest });
  const next = cli(root, ['--action', 'next']);
  assert.deepEqual(next.json.next, { action: 'retry-or-diagnosis', scope: 'task-1', cycle: 1, iteration: 2, diagnosisAvailable: true });
  const correction = cli(root, ['--action', 'reserve', '--scope', 'task-1', '--iteration', '2', '--kind', 'correction']);
  assert.equal(correction.status, 1);
  assert.equal(correction.json.code, CORRECTION_CODES.refusal.RETRY_REQUIRED);
  const verified = cli(root, ['--action', 'verify']);
  assert.equal(verified.status, 0);
  assert.equal(verified.json.summary.cycles[0].reserved, 1);
}));

test('per-action options are the kebab-case forms of the library input keys', () => withRepo(planText(planTask(1, { complexity: 'mechanical' })), ({ root, json }) => {
  cli(root, ['--action', 'open', '--drive', 'manual']);
  const opened = cli(root, ['--action', 'open-cycle', '--scope', 'task-1', '--rubric-criteria', 'SC1', '--review-opt-in']);
  assert.equal(opened.status, 0, opened.stderr);
  assert.deepEqual([json(recordPath(2)).record.rubricCriteria, json(recordPath(2)).record.review], [['SC1'], 'required']);
  cli(root, ['--action', 'reserve', '--scope', 'task-1', '--iteration', '1', '--kind', 'initial']);
  const owned = cli(root, ['--action', 'authorize', '--scope', 'task-1', '--iteration', '1', '--role', 'writer',
    '--target', 'scripts-agent', '--owner-task', '1', '--affected-criteria', 'SC1']);
  assert.equal(owned.status, 1);
  assert.equal(owned.json.code, CORRECTION_CODES.refusal.ROLE_NOT_ALLOWED);
  assert.match(owned.json.message, /ownerTask: null and affectedCriteria: \[\]/u);
}));

test('main returns the exit code in-process and writes one JSON line to the injected stdout', () => withRepo(PLAN_TWO, ({ root }) => {
  const out = [];
  const err = [];
  const io = { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } };
  assert.equal(main(['--repo-root', root, '--plan', PLAN, '--action', 'open', '--drive', 'manual'], io), 0);
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]).action, 'open');
  assert.deepEqual(err, []);
  assert.equal(main(['--repo-root', root, '--plan', PLAN, '--action', 'reopen', '--authorization', reopenPath(), '--run-id', 'r'], io), 1);
  assert.equal(JSON.parse(out[1]).code, CORRECTION_GUARD_CODES.ACTOR_INVALID);
  assert.throws(() => main([], { stdout: io.stdout, log: io.stdout }), TypeError);
}));
