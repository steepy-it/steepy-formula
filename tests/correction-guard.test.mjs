import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync,
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
  proveCorrectionIsolation,
  readCorrectionHead,
  recordCorrectionChecks,
  recordCorrectionDiagnosis,
  recordCorrectionInterruption,
  recordCorrectionReview,
  recordCorrectionWriter,
  reopenCorrectionScope,
  reserveCorrectionIteration,
  stopCorrectionCycle,
  verifyCorrectionHandoff,
  verifyCorrectionRun,
} from '../scripts/correction-guard.mjs';
import { CORRECTION_CODES, deriveCycleBindings, parseCorrectionSummaryBlock } from '../scripts/correction-state.mjs';
import { beginReview, checkReview, setReviewReference } from '../scripts/reviewer-response.mjs';
import { observeSource } from '../scripts/source-observation.mjs';
import { beginTask, parseTaskResultProjection, projectTaskResults, recordTaskResult } from '../scripts/task-results.mjs';

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

// The file helpers of a repository at `root`.
function repoAt(root) {
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const bytes = (path) => readFileSync(join(root, path));
  return {
    root,
    git: (...args) => execFileSync('git', args, { cwd: root }),
    put,
    bytes,
    json: (path) => JSON.parse(bytes(path).toString('utf8')),
    exists: (path) => existsSync(join(root, path)),
  };
}

// A real temporary Git repository with one committed source file and the plan under the ignored work area.
// An async `fn` keeps the repository until it settles.
function withRepo(plan, fn) {
  const root = mkdtempSync(join(tmpdir(), 'steepy-correction-guard-'));
  const remove = () => rmSync(root, { recursive: true, force: true });
  const repo = repoAt(root);
  let pending = false;
  try {
    repo.git('init', '-q');
    repo.git('config', 'user.name', 'Test');
    repo.git('config', 'user.email', 'test@example.test');
    repo.git('config', 'commit.gpgsign', 'false');
    repo.put('.gitignore', '.formula/work/\n');
    repo.put('source.txt', 'baseline\n');
    repo.git('add', '.');
    repo.git('commit', '-qm', 'baseline');
    if (plan !== null) repo.put(PLAN, plan);
    const result = fn(repo);
    if (result instanceof Promise) {
      pending = true;
      return result.finally(remove);
    }
    return result;
  } finally {
    if (!pending) remove();
  }
}

// Builds a repository state once with `setup`, then runs each case on its own byte copy of it, so every
// case starts from the same records and source without replaying the setup.
function withCopies(plan, setup, cases, run) {
  return withRepo(plan, async (template) => {
    await setup(template);
    for (const testCase of cases) {
      const root = mkdtempSync(join(tmpdir(), 'steepy-correction-guard-'));
      try {
        cpSync(template.root, root, { recursive: true, verbatimSymlinks: true });
        await run(repoAt(root), testCase);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
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

// --- writer ---------------------------------------------------------------------------------------

const TASK_REPORT = `${RUN}/task-1-report.md`;
const EXECUTION = `${RUN}/task-1-execution-1`;
const MIB64 = 64 * 1024 * 1024;
const candidatePath = (iteration, scope = 'task-1', cycle = 1) => `${CORRECTION}/${scope}-cycle-${cycle}-iteration-${iteration}-candidate.json`;
const envelopeText = (fields) => `${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')}\n`;
const writerResponse = (overrides = {}) => envelopeText({
  status: 'DONE', artifact: TASK_REPORT, 'changed-paths': 'source.txt', signals: 'tdd:red-green', ...overrides,
});
const workOf = (observation, path) => observation.files.find((file) => file.path === path).work;

// A manual run whose task-1 iteration-1 writer is authorized to write the task report.
function manualWriterAuthorized(root) {
  openCorrectionRun(root, manual({ drive: 'manual' }));
  openCorrectionCycle(root, manual({ scope: 'task-1' }));
  reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
  authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 1, role: 'writer', target: TASK_REPORT }));
}

const recordWriter = (root, input = {}) => recordCorrectionWriter(root, manual({
  scope: 'task-1', iteration: 1, response: writerResponse(), ...input,
}));

test('the manual writer records its four-field envelope, the report digest and a candidate snapshot', () => withRepo(PLAN_TWO, ({ root, put, bytes, json }) => {
  manualWriterAuthorized(root);
  put('source.txt', 'changed by the writer\n');
  put('added.txt', 'added by the writer\n');
  put(TASK_REPORT, 'Implementation report.\n');
  const response = writerResponse({ 'changed-paths': 'added.txt, source.txt' });
  const result = recordWriter(root, { response });
  assert.equal(result.ok, true, result.message);
  const current = observeSource(root);
  const snapshot = bytes(candidatePath(1));
  assert.deepEqual(json(recordPath(5)).record, {
    kind: 'WRITER_RECORDED', scope: 'task-1', cycle: 1, iteration: 1, status: 'DONE',
    evidence: [{ path: TASK_REPORT, digest: sha256(bytes(TASK_REPORT)) }], responseDigest: sha256(Buffer.from(response)),
    observation: current.digest, candidate: { path: candidatePath(1), digest: sha256(snapshot) },
    changedPaths: ['added.txt', 'source.txt'],
  });
  const file = (path, text) => ({ path, work: { kind: 'file', mode: workOf(current, path).mode, base64: Buffer.from(text).toString('base64') } });
  assert.equal(snapshot.toString('utf8'), `${JSON.stringify({
    version: 1, observation: current,
    files: [file('added.txt', 'added by the writer\n'), file('source.txt', 'changed by the writer\n')],
  })}\n`);
  assert.deepEqual(result.candidate, { path: candidatePath(1), digest: sha256(snapshot) });
  assert.deepEqual(result.next, { action: 'checks', scope: 'task-1', cycle: 1, iteration: 1 });
  assert.deepEqual(checkCorrectionDrift(root, manual()), { ok: true, observation: current.digest, window: false },
    'the writer observation is the new drift reference');
}));

test('a candidate snapshot keeps a deleted path as null work and a symlink as its target bytes', () => withRepo(PLAN_TWO, ({ root, put, git, json }) => {
  put('doomed.txt', 'to be deleted\n');
  git('add', '.');
  git('commit', '-qm', 'doomed');
  manualWriterAuthorized(root);
  unlinkSync(join(root, 'doomed.txt'));
  symlinkSync('source.txt', join(root, 'link'));
  put(TASK_REPORT, 'report\n');
  const result = recordWriter(root);
  assert.equal(result.ok, true, result.message);
  const { files } = json(candidatePath(1));
  assert.deepEqual(files.map((entry) => [entry.path, entry.work?.kind ?? null]), [['doomed.txt', null], ['link', 'symlink']]);
  assert.equal(Buffer.from(files[1].work.base64, 'base64').toString('utf8'), 'source.txt');
  assert.deepEqual(json(recordPath(5)).record.changedPaths, ['doomed.txt', 'link']);
}));

test('a malformed manual writer response is recorded INVALID with its response digest', () => {
  const cases = Object.entries({
    'a missing field': envelopeText({ status: 'DONE', artifact: TASK_REPORT, signals: 'none' }),
    'fields out of order': envelopeText({ artifact: TASK_REPORT, status: 'DONE', 'changed-paths': 'none', signals: 'none' }),
    'an unknown status': writerResponse({ status: 'FINISHED' }),
    'another artifact than the authorized report': writerResponse({ artifact: `${RUN}/task-2-report.md` }),
    'a heading': `# Result\n${writerResponse()}`,
    'an invalid signal': writerResponse({ signals: 'not a signal' }),
    'an unsafe changed path': writerResponse({ 'changed-paths': '../escape' }),
    'invalid UTF-8': Buffer.concat([Buffer.from(writerResponse()), Buffer.from([0xff])]),
    'a semantic BLOCKED': writerResponse({ status: 'BLOCKED', 'changed-paths': 'none' }),
  });
  const setup = ({ root, put }) => {
    manualWriterAuthorized(root);
    put(TASK_REPORT, 'report\n');
  };
  return withCopies(PLAN_TWO, setup, cases, ({ root, json }, [label, response]) => {
    const result = recordWriter(root, { response });
    assert.equal(result.ok, true, `${label}: ${result.message}`);
    const { record } = json(recordPath(5));
    assert.equal(record.status, label === 'a semantic BLOCKED' ? 'BLOCKED' : 'INVALID', label);
    assert.equal(record.responseDigest, sha256(Buffer.from(response)), label);
    assert.equal(result.next.action, 'retry-or-diagnosis', label);
  });
});

test('the manual writer refuses a missing or empty report, a wrong drive input or a writer that is not next', () => withRepo(PLAN_TWO, ({ root, put, exists }) => {
  manualWriterAuthorized(root);
  put('source.txt', 'changed\n');
  assert.equal(recordWriter(root).code, CORRECTION_GUARD_CODES.INPUT_INVALID, 'a missing report');
  put(TASK_REPORT, ' \n');
  assert.equal(recordWriter(root).code, CORRECTION_GUARD_CODES.INPUT_INVALID, 'an empty report');
  put(TASK_REPORT, 'report\n');
  assert.equal(recordWriter(root, { execution: EXECUTION }).code, CORRECTION_GUARD_CODES.INPUT_INVALID, 'an execution on a manual drive');
  assert.equal(recordWriter(root, { response: undefined }).code, CORRECTION_GUARD_CODES.INPUT_INVALID, 'no response');
  assert.equal(recordWriter(root, { iteration: 2 }).code, CORRECTION_GUARD_CODES.STEP_INVALID, 'another iteration');
  assert.equal(recordWriter(root, { scope: 'task-2' }).code, CORRECTION_GUARD_CODES.STEP_INVALID, 'another scope');
  assert.equal(exists(recordPath(5)), false);
  assert.equal(exists(candidatePath(1)), false);
  assert.equal(recordWriter(root).ok, true);
  assert.equal(recordWriter(root).code, CORRECTION_GUARD_CODES.STEP_INVALID, 'a writer already recorded');
  assert.throws(() => recordCorrectionWriter(root, manual({ scope: 'task-1', iteration: 1, extra: true })), TypeError);
}));

test('two writer attempts keep two snapshots: the earlier one is unchanged and its base64 round-trips', () => withRepo(PLAN_TWO, ({ root, put, bytes, json }) => {
  manualWriterAuthorized(root);
  put('source.txt', 'first attempt\n');
  put(TASK_REPORT, 'report 1\n');
  assert.equal(recordWriter(root, { response: writerResponse({ status: 'BLOCKED' }) }).ok, true);
  const first = bytes(candidatePath(1));
  put(retryPath(1), `${JSON.stringify(retryRequest({ path: TASK_REPORT, digest: sha256(bytes(TASK_REPORT)) }))}\n`);
  assert.equal(admitCorrectionRetry(root, manual({ request: retryPath(1) })).ok, true);
  assert.equal(reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 2, kind: 'correction' })).ok, true);
  assert.equal(authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 2, role: 'writer', target: TASK_REPORT })).ok, true);
  put('source.txt', 'second attempt\n');
  put(TASK_REPORT, 'report 2\n');
  const second = recordWriter(root, { iteration: 2 });
  assert.equal(second.ok, true, second.message);
  assert.deepEqual(bytes(candidatePath(1)), first);
  const decode = (snapshot) => Buffer.from(snapshot.files[0].work.base64, 'base64').toString('utf8');
  assert.equal(decode(JSON.parse(first.toString('utf8'))), 'first attempt\n');
  assert.equal(decode(json(candidatePath(2))), 'second attempt\n');
  assert.notEqual(json(candidatePath(1)).observation.digest, json(candidatePath(2)).observation.digest);
}));

test('a candidate above 64 MiB of raw bytes appends RUN_HALTED and writes no snapshot', () => withRepo(PLAN_TWO, ({ root, put, json, exists }) => {
  manualWriterAuthorized(root);
  writeFileSync(join(root, 'large.bin'), Buffer.alloc(0));
  truncateSync(join(root, 'large.bin'), MIB64 + 1);
  put(TASK_REPORT, 'report\n');
  const result = recordWriter(root);
  assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY);
  assert.equal(result.message, 'candidate snapshot exceeds 64 MiB');
  const { record } = json(recordPath(5));
  assert.equal(record.kind, 'RUN_HALTED');
  assert.equal(record.reason, 'candidate snapshot exceeds 64 MiB');
  assert.equal(record.observation, observeSource(root).digest);
  assert.equal(exists(candidatePath(1)), false);
}));

// An autopilot run whose task-1 iteration-1 writer is authorized for the execution receipt EXECUTION,
// begun with task-results.
function autopilotWriterAuthorized({ root, put }) {
  put(manifestPath(1), manifest('run-1', 1));
  const actor = { runId: 'run-1', attempt: 1 };
  openCorrectionRun(root, manual({ drive: 'autopilot', ...actor }));
  openCorrectionCycle(root, manual({ scope: 'task-1', ...actor }));
  reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial', ...actor }));
  authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 1, role: 'writer', target: EXECUTION, ...actor }));
  beginTask(root, EXECUTION, {
    runId: 'run-1', attempt: 1, task: '1', execution: 1, role: 'implementer', report: TASK_REPORT, planPath: PLAN,
  });
  return actor;
}

function autopilotWriterReported(repo, response = `status: DONE\nartifact: ${TASK_REPORT}\nsignals: none\n`) {
  const actor = autopilotWriterAuthorized(repo);
  repo.put('source.txt', 'autopilot change\n');
  repo.put(TASK_REPORT, 'Implementation report.\n');
  recordTaskResult(repo.root, EXECUTION, response);
  return actor;
}

test('the autopilot writer binds a real task-results receipt and its frozen report', () => withRepo(PLAN_TWO, (repo) => {
  const { root, bytes, json } = repo;
  const actor = autopilotWriterReported(repo, `status: DONE_WITH_CONCERNS\nartifact: ${TASK_REPORT}\nsignals: none\n`);
  const result = recordCorrectionWriter(root, manual({ scope: 'task-1', iteration: 1, execution: EXECUTION, ...actor }));
  assert.equal(result.ok, true, result.message);
  const { record, actor: recorded } = json(recordPath(5));
  assert.deepEqual(recorded, { drive: 'autopilot', runId: 'run-1', attempt: 1 });
  assert.equal(record.status, 'DONE_WITH_CONCERNS');
  assert.deepEqual(record.evidence, [
    { path: `${EXECUTION}-result.json`, digest: sha256(bytes(`${EXECUTION}-result.json`)) },
    { path: `${EXECUTION}-report.md`, digest: sha256(bytes(`${EXECUTION}-report.md`)) },
  ]);
  assert.equal(record.responseDigest, null);
  assert.deepEqual(record.changedPaths, ['source.txt']);
  assert.equal(record.observation, observeSource(root).digest);
  assert.equal(record.candidate.path, candidatePath(1));
}));

test('the autopilot writer records a semantic non-success as reported and a malformed one as INVALID', () => {
  for (const [response, status] of [
    [`status: BLOCKED\nartifact: ${TASK_REPORT}\nsignals: none\n`, 'BLOCKED'],
    ['garbage\n', 'INVALID'],
  ]) {
    withRepo(PLAN_TWO, (repo) => {
      const actor = autopilotWriterReported(repo, response);
      const result = recordCorrectionWriter(repo.root, manual({ scope: 'task-1', iteration: 1, execution: EXECUTION, ...actor }));
      assert.equal(result.ok, true, result.message);
      assert.equal(repo.json(recordPath(5)).record.status, status);
    });
  }
});

test('the autopilot writer refuses a pending receipt, another execution or a response, writing nothing', () => withRepo(PLAN_TWO, (repo) => {
  const { root, put, exists } = repo;
  const actor = autopilotWriterAuthorized(repo);
  put('source.txt', 'autopilot change\n');
  const writer = (input) => recordCorrectionWriter(root, manual({ scope: 'task-1', iteration: 1, ...actor, ...input }));
  assert.equal(writer({ execution: EXECUTION }).code, CORRECTION_GUARD_CODES.RECEIPT_PENDING);
  assert.equal(writer({ execution: `${RUN}/task-1-execution-2` }).code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  assert.equal(writer({}).code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  assert.equal(writer({ execution: EXECUTION, response: writerResponse() }).code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  assert.equal(exists(recordPath(5)), false);
  assert.equal(exists(candidatePath(1)), false);
}));

// The run is halted: the record at `seq` is RUN_HALTED, and every later action refuses the halted run.
function assertHalted(repo, seq, label, actor = {}) {
  assert.equal(repo.json(recordPath(seq)).record.kind, 'RUN_HALTED', label);
  assert.equal(nextCorrectionAction(repo.root, manual()).code, CORRECTION_GUARD_CODES.RUN_HALTED, label);
  const later = recordCorrectionInterruption(repo.root, manual({ scope: 'task-1', iteration: 1, reason: 'crash', ...actor }));
  assert.equal(later.code, CORRECTION_GUARD_CODES.RUN_HALTED, label);
  assert.equal(repo.exists(recordPath(seq + 1)), false, label);
}

const receiptFiles = (state) => ['baseline.json', 'capture.json', 'result.json', 'report.md'].map((stage) => `${state}-${stage}`);

test('receipt or report drift after the writer reported halts the run (exit 3)', () => {
  const drifts = {
    'a source edit after the receipt': [(put) => put('source.txt', 'edited after the receipt\n'), 'task source snapshot drift'],
    'a report-only edit after the receipt': [(put) => put(TASK_REPORT, 'edited report\n'), 'task report drift'],
  };
  for (const [label, [drift, cause]] of Object.entries(drifts)) {
    withRepo(PLAN_TWO, (repo) => {
      const actor = autopilotWriterReported(repo);
      drift(repo.put);
      const result = cli(repo.root, ['--action', 'record-writer', '--scope', 'task-1', '--iteration', '1',
        '--execution', EXECUTION, '--run-id', 'run-1', '--attempt', '1']);
      assert.equal(result.status, 3, label);
      assert.equal(result.json.code, CORRECTION_GUARD_CODES.INTEGRITY, label);
      assert.equal(result.json.message, `the execution receipt does not verify: ${cause}`, label);
      const { record } = repo.json(recordPath(5));
      assert.equal(record.reason, result.json.message, label);
      assert.deepEqual(record.evidence, receiptFiles(EXECUTION).map((path) => ({ path, digest: sha256(repo.bytes(path)) })), label);
      assert.equal(record.observation, observeSource(repo.root).digest, label);
      assert.equal(repo.exists(candidatePath(1)), false, label);
      assertHalted(repo, 5, label, actor);
    });
  }
});

test('an integrity failure after the preparation of an evidence action halts the run', async () => {
  const halts = {
    'a corrupt cycle baseline before the writer': (repo) => {
      manualWriterAuthorized(repo.root);
      repo.put(baselinePath('task-1', 1), '{"version":1,"observation":null}\n');
      repo.put(TASK_REPORT, 'report\n');
      return [recordWriter(repo.root), 5];
    },
    'a candidate snapshot left with other bytes': (repo) => {
      manualWriterAuthorized(repo.root);
      repo.put('source.txt', 'changed by the writer\n');
      repo.put(candidatePath(1), 'stale\n');
      repo.put(TASK_REPORT, 'report\n');
      return [recordWriter(repo.root), 5];
    },
    'a capture that wrote no evidence': async (repo) => {
      manualWriterRecorded(repo);
      const collectEvidence = async () => ({ commands: [] });
      return [await verifyCheck(repo.root, { collectEvidence }), 6];
    },
    'a symlinked review artifact': async (repo) => {
      await manualReviewAuthorized(repo);
      symlinkSync(join(repo.root, 'source.txt'), join(repo.root, REVIEW));
      repo.put(DEFECTS, defectsBody());
      return [recordReview(repo.root), 8];
    },
    'a symlinked diagnosis artifact': (repo) => {
      diagnosisAuthorized(repo.root);
      repo.put(`${CORRECTION}/elsewhere.json`, diagnosisBody());
      symlinkSync(join(repo.root, CORRECTION, 'elsewhere.json'), join(repo.root, DIAGNOSIS));
      return [recordDiagnosis(repo.root), 7];
    },
  };
  for (const [label, act] of Object.entries(halts)) {
    await withRepo(PLAN_TWO, async (repo) => {
      const [result, seq] = await act(repo);
      assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY, `${label}: ${result.message}`);
      assert.equal(repo.json(recordPath(seq)).record.reason, result.message, label);
      assertHalted(repo, seq, label);
    });
  }
});

test('the record-writer CLI reads the manual response from stdin', () => withRepo(PLAN_TWO, ({ root, put, json }) => {
  manualWriterAuthorized(root);
  put('source.txt', 'changed\n');
  put(TASK_REPORT, 'report\n');
  const response = writerResponse();
  const result = cli(root, ['--action', 'record-writer', '--scope', 'task-1', '--iteration', '1'], { input: response });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(recordPath(5)).record.responseDigest, sha256(Buffer.from(response)));
}));

// --- checks ---------------------------------------------------------------------------------------

const checkEvidencePath = (k, iteration = 1, scope = 'task-1', cycle = 1) => `${CORRECTION}/${scope}-cycle-${cycle}-iteration-${iteration}-check-${k}-evidence.md`;
const CHECKS_HALT = 'source changed during the checks';

// The manual task-1 iteration-1 writer recorded DONE with one source change.
function manualWriterRecorded(repo) {
  manualWriterAuthorized(repo.root);
  repo.put('source.txt', 'changed by the writer\n');
  repo.put(TASK_REPORT, 'Implementation report.\n');
  const result = recordWriter(repo.root);
  assert.equal(result.ok, true, result.message);
}

// An injected collector standing in for collectReviewEvidence: it writes the evidence file and reports a
// surface test and the coherence gate, running `during` while the commands would run.
function collector({ surface = {}, gate = {}, during = () => {} } = {}) {
  const calls = [];
  const collectEvidence = async (options) => {
    calls.push(options);
    writeFileSync(join(options.repoRoot, options.evidencePath), `# Review evidence\n\n${options.testCommand}\n`);
    during(options);
    const command = (label, excerpt, overrides) => ({ label, exitCode: 0, passed: true, excerpt, ...overrides });
    const commands = [
      ...(options.gateOnly ? [] : [command('surface-test', '# fail 0\n', surface)]),
      command('coherence-gate', '  violations: 0\n', gate),
    ];
    return { schemaVersion: 1, artifact: options.evidencePath, allPassed: commands.every((entry) => entry.passed), commands };
  };
  return { collectEvidence, calls };
}

const verifyCheck = (root, seams, input = {}) => recordCorrectionChecks(root, manual({ scope: 'task-1', iteration: 1, ...input }), seams);

test('verify-check records passing checks from the injected collector with their evidence digests', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, bytes, json } = repo;
  manualWriterRecorded(repo);
  const { collectEvidence, calls } = collector({
    surface: { excerpt: '# tests 4\n# pass 4\n# fail 0\n' }, gate: { excerpt: 'graph validate\n  violations: 0\n' },
  });
  const result = await verifyCheck(root, { collectEvidence, graphGateArgs: ['--port', 'memory'] });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(calls, [{
    repoRoot: root, evidencePath: checkEvidencePath(1), testCommand: 'npm test', graphGateArgs: ['--port', 'memory'],
  }]);
  const evidence = { path: checkEvidencePath(1), digest: sha256(bytes(checkEvidencePath(1))) };
  assert.deepEqual(json(recordPath(6)).record, {
    kind: 'CHECKS_RECORDED', scope: 'task-1', cycle: 1, iteration: 1, observation: observeSource(root).digest,
    checks: [
      { id: 'surface-test', exitCode: 0, passed: true, metric: 0, evidence },
      { id: 'coherence-gate', exitCode: 0, passed: true, metric: 0, evidence },
    ],
  });
  assert.deepEqual(result.next, { action: 'authorize', scope: 'task-1', cycle: 1, iteration: 1, role: 'task-reviewer' });
}));

test('verify-check parses the last failure count and violation count, else a null metric', async () => {
  const cases = [
    ['a failure with # fail 3', { exitCode: 1, passed: false, excerpt: '# fail 1\n# subtest\n# fail 3\n' }, {}, [3, 0]],
    ['a missing summary', { exitCode: 1, passed: false, excerpt: 'Error: cannot find module\n' }, {}, [null, 0]],
    ['CRLF output', { exitCode: 1, passed: false, excerpt: '# tests 5\r\n# fail 2\r\n' }, {}, [2, 0]],
    ['coherence-gate violations', {}, { exitCode: 1, passed: false, excerpt: '  violations: 5\n...\n  violations: 2\n' }, [0, 2]],
    ['a gate without a count', {}, { exitCode: 1, passed: false, excerpt: 'engine unreachable\n' }, [0, null]],
  ];
  for (const [label, surface, gate, metrics] of cases) {
    await withRepo(PLAN_TWO, async (repo) => {
      manualWriterRecorded(repo);
      const result = await verifyCheck(repo.root, { collectEvidence: collector({ surface, gate }).collectEvidence });
      assert.equal(result.ok, true, `${label}: ${result.message}`);
      const { checks } = repo.json(recordPath(6)).record;
      assert.deepEqual(checks.map((check) => check.metric), metrics, label);
      assert.deepEqual(checks.map((check) => check.passed), [surface.passed ?? true, gate.passed ?? true], label);
      assert.deepEqual(checks.map((check) => check.exitCode), [surface.exitCode ?? 0, gate.exitCode ?? 0], label);
      assert.equal(result.next.action, 'retry-or-diagnosis', label);
    });
  }
});

test('a source change during the checks appends RUN_HALTED and records no checks', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, put, json } = repo;
  manualWriterRecorded(repo);
  const expected = observeSource(root).digest;
  const { collectEvidence } = collector({ during: () => put('source.txt', 'mutated by the test command\n') });
  const result = await verifyCheck(root, { collectEvidence });
  assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY);
  assert.equal(result.message, CHECKS_HALT);
  const { record } = json(recordPath(6));
  assert.equal(record.kind, 'RUN_HALTED');
  assert.equal(record.reason, CHECKS_HALT);
  assert.equal(record.observation, observeSource(root).digest);
  assert.notEqual(record.observation, expected);
  assert.deepEqual(record.evidence.map((item) => item.path), [checkEvidencePath(1)]);
  put('source.txt', 'changed by the writer\n');
  assert.equal(nextCorrectionAction(root, manual()).code, CORRECTION_GUARD_CODES.RUN_HALTED);
}));

test('verify-check runs nothing unless the checks are the next step', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, put, bytes, exists } = repo;
  manualWriterAuthorized(root);
  const { collectEvidence, calls } = collector();
  assert.equal((await verifyCheck(root, { collectEvidence })).code, CORRECTION_GUARD_CODES.STEP_INVALID, 'before the writer');
  put('source.txt', 'changed by the writer\n');
  put(TASK_REPORT, 'report\n');
  assert.equal(recordWriter(root).ok, true);
  assert.equal((await verifyCheck(root, { collectEvidence }, { iteration: 2 })).code, CORRECTION_GUARD_CODES.STEP_INVALID);
  assert.equal(calls.length, 0);
  assert.equal(exists(checkEvidencePath(1)), false);
  assert.equal((await verifyCheck(root, { collectEvidence })).ok, true);
  const recorded = bytes(checkEvidencePath(1));
  assert.equal((await verifyCheck(root, { collectEvidence })).code, CORRECTION_GUARD_CODES.STEP_INVALID, 'checks already recorded');
  assert.equal(calls.length, 1);
  assert.deepEqual(bytes(checkEvidencePath(1)), recorded, 'recorded evidence is never overwritten');
}));

test('a reducer integrity refusal of the checks appends RUN_HALTED before any command runs', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, put, bytes, json } = repo;
  manualWriterAuthorized(root);
  put('source.txt', 'changed by a writer that then blocked\n');
  put(TASK_REPORT, 'report 1\n');
  assert.equal(recordWriter(root, { response: writerResponse({ status: 'BLOCKED' }) }).ok, true);
  put(retryPath(1), `${JSON.stringify(retryRequest({ path: TASK_REPORT, digest: sha256(bytes(TASK_REPORT)) }))}\n`);
  assert.equal(admitCorrectionRetry(root, manual({ request: retryPath(1) })).ok, true);
  assert.equal(reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 2, kind: 'correction' })).ok, true);
  // No writer: the checks would verify the opening tree, which the blocked writer changed.
  assert.equal(authorizeCorrectionDispatch(root, manual({
    scope: 'task-1', iteration: 2, role: 'task-reviewer', target: `${RUN}/task-1-review.md`,
  })).ok, true);
  const { collectEvidence, calls } = collector();
  const result = await verifyCheck(root, { collectEvidence }, { iteration: 2 });
  assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY, result.message);
  assert.equal(calls.length, 0);
  const { record } = json(recordPath(9));
  assert.equal(record.kind, 'RUN_HALTED');
  assert.match(record.reason, /iteration candidate/u);
  assert.equal(record.observation, observeSource(root).digest);
}));

test('a collector failure refuses the checks without recording them', () => withRepo(PLAN_TWO, async (repo) => {
  manualWriterRecorded(repo);
  const collectEvidence = async () => { throw new Error('process-group convergence timed out'); };
  const result = await verifyCheck(repo.root, { collectEvidence });
  assert.equal(result.code, CORRECTION_GUARD_CODES.CAPTURE_FAILED);
  assert.match(result.message, /convergence/u);
  assert.equal(repo.exists(recordPath(6)), false);
}));

test('a capture that changes the source and then rejects halts the run instead of failing the capture', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, put, bytes, json } = repo;
  manualWriterRecorded(repo);
  const collectEvidence = async (options) => {
    writeFileSync(join(options.repoRoot, options.evidencePath), '# Review evidence\n\npartial\n');
    put('source.txt', 'mutated by the test command before it timed out\n');
    throw new Error('process-group convergence timed out');
  };
  const result = await verifyCheck(root, { collectEvidence });
  assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY);
  assert.equal(result.message, CHECKS_HALT);
  const { record } = json(recordPath(6));
  assert.deepEqual(record, {
    kind: 'RUN_HALTED', reason: CHECKS_HALT,
    evidence: [{ path: checkEvidencePath(1), digest: sha256(bytes(checkEvidencePath(1))) }],
    observation: observeSource(root).digest,
  });
  assertHalted(repo, 6, 'a rejected capture that changed the source');
}));

test('only verify-check takes the collector seams, and they are checked', () => withRepo(PLAN_TWO, async (repo) => {
  const { root } = repo;
  manualWriterRecorded(repo);
  const { collectEvidence } = collector();
  await assert.rejects(verifyCheck(root, { collectEvidence, clock: () => 0 }), TypeError);
  await assert.rejects(verifyCheck(root, { collectEvidence: 'collect' }), TypeError);
  await assert.rejects(verifyCheck(root, { collectEvidence, graphGateArgs: '--port memory' }), TypeError);
  assert.throws(() => recordCorrectionWriter(root, manual({ scope: 'task-1', iteration: 1, response: writerResponse() }), { collectEvidence }), TypeError);
  assert.equal(repo.exists(recordPath(6)), false);
}));

// Two mechanical tasks with different test commands: each approves on its checks alone.
const PLAN_MECHANICAL = planText(
  planTask(1, { complexity: 'mechanical', testCommand: 'npm test' }),
  planTask(2, { complexity: 'mechanical', testCommand: 'node --test tests/two.test.mjs' }),
);

test('a final cycle captures every surface test, each with its own evidence, and the last coherence gate', () => withRepo(PLAN_MECHANICAL, async (repo) => {
  const { root, put, bytes, json } = repo;
  assert.equal(openCorrectionRun(root, manual({ drive: 'manual' })).ok, true);
  for (const task of ['1', '2']) {
    const scope = `task-${task}`;
    const report = `${RUN}/task-${task}-report.md`;
    assert.equal(openCorrectionCycle(root, manual({ scope })).ok, true);
    reserveCorrectionIteration(root, manual({ scope, iteration: 1, kind: 'initial' }));
    authorizeCorrectionDispatch(root, manual({ scope, iteration: 1, role: 'writer', target: report }));
    put(`${scope}.txt`, `${scope} delivered\n`);
    put(report, 'report\n');
    assert.equal(recordCorrectionWriter(root, manual({ scope, iteration: 1, response: writerResponse({ artifact: report }) })).ok, true);
    const checked = await recordCorrectionChecks(root, manual({ scope, iteration: 1 }), { collectEvidence: collector().collectEvidence });
    assert.equal(checked.ok, true, checked.message);
  }
  assert.equal(openCorrectionCycle(root, manual({ scope: 'final' })).ok, true);
  reserveCorrectionIteration(root, manual({ scope: 'final', iteration: 1, kind: 'initial' }));
  authorizeCorrectionDispatch(root, manual({ scope: 'final', iteration: 1, role: 'final-reviewer', target: `${RUN}/final-review.md` }));
  const { collectEvidence, calls } = collector();
  const result = await recordCorrectionChecks(root, manual({ scope: 'final', iteration: 1 }), { collectEvidence });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(calls.map((call) => [call.evidencePath, call.testCommand]), [
    [checkEvidencePath(1, 1, 'final'), 'node --test tests/two.test.mjs'],
    [checkEvidencePath(2, 1, 'final'), 'npm test'],
  ]);
  const digest = (k) => ({ path: checkEvidencePath(k, 1, 'final'), digest: sha256(bytes(checkEvidencePath(k, 1, 'final'))) });
  const { record } = json(recordPath(readCorrectionHead(root, manual()).seq));
  assert.equal(record.kind, 'CHECKS_RECORDED');
  assert.deepEqual(record.checks.map((check) => [check.id, check.evidence]), [
    ['surface-test-1', digest(1)], ['surface-test-2', digest(2)], ['coherence-gate', digest(2)],
  ]);
}));

const PLAN_ONE = planText(planTask(1));
const FINAL_REVIEW = `${RUN}/final-review.md`;
const finalDefectsPath = (iteration, role = '') => `${CORRECTION}/final-cycle-1-iteration-${iteration}${role}-defects.json`;

// A one-task plan whose task stopped and proved its isolation: the final cycle opens with no delivered
// task, so its only check is the coherence gate, and its final reviewer is authorized.
function gateOnlyFinalAuthorized({ root, json }) {
  interruptedRun(root);
  assert.equal(stopCorrectionCycle(root, manual({ scope: 'task-1', reason: 'HUMAN_INTERRUPTED', note: 'paused' })).ok, true);
  assert.equal(proveCorrectionIsolation(root, manual({ scope: 'task-1' })).ok, true);
  assert.equal(openCorrectionCycle(root, manual({ scope: 'final' })).ok, true);
  assert.deepEqual(json(recordPath(7)).record.checks, [{ id: 'coherence-gate', command: 'builtin' }]);
  reserveCorrectionIteration(root, manual({ scope: 'final', iteration: 1, kind: 'initial' }));
  assert.equal(authorizeCorrectionDispatch(root, manual({
    scope: 'final', iteration: 1, role: 'final-reviewer', target: FINAL_REVIEW,
  })).ok, true);
}

test('a final cycle without a delivered task captures the coherence gate alone and can conclude', () => withRepo(PLAN_ONE, async (repo) => {
  const { root, put, bytes, json } = repo;
  gateOnlyFinalAuthorized(repo);
  const { collectEvidence, calls } = collector({ gate: { excerpt: 'graph validate\n  violations: 0\n' } });
  const checked = await recordCorrectionChecks(root, manual({ scope: 'final', iteration: 1 }),
    { collectEvidence, graphGateArgs: ['--port', 'memory'] });
  assert.equal(checked.ok, true, checked.message);
  const path = checkEvidencePath(1, 1, 'final');
  assert.deepEqual(calls, [{ repoRoot: root, evidencePath: path, gateOnly: true, graphGateArgs: ['--port', 'memory'] }]);
  assert.deepEqual(json(recordPath(10)).record, {
    kind: 'CHECKS_RECORDED', scope: 'final', cycle: 1, iteration: 1, observation: observeSource(root).digest,
    checks: [{ id: 'coherence-gate', exitCode: 0, passed: true, metric: 0, evidence: { path, digest: sha256(bytes(path)) } }],
  });
  put(FINAL_REVIEW, 'Status: Approved\n');
  put(finalDefectsPath(1), defectsBody({ scope: 'final' }));
  const reviewed = recordCorrectionReview(root, manual({
    scope: 'final', iteration: 1, role: 'final-reviewer', defects: finalDefectsPath(1),
    response: reviewResponse({ artifact: FINAL_REVIEW }),
  }));
  assert.equal(reviewed.ok, true, reviewed.message);
  assert.equal(reviewed.status, 'APPROVED');
  assert.equal(reviewed.next.action, 'terminal');
  assert.equal(reviewed.next.summary.outcome, 'PARTIAL');
  assert.equal(reviewed.next.summary.final.status, 'APPROVED');
}));

test('a source change during a gate-only capture halts the run', () => withRepo(PLAN_ONE, async (repo) => {
  const { root, put, json } = repo;
  gateOnlyFinalAuthorized(repo);
  const { collectEvidence } = collector({ during: () => put('source.txt', 'mutated during the gate\n') });
  const result = await recordCorrectionChecks(root, manual({ scope: 'final', iteration: 1 }), { collectEvidence });
  assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY);
  assert.equal(result.message, CHECKS_HALT);
  const { record } = json(recordPath(10));
  assert.deepEqual([record.kind, record.observation], ['RUN_HALTED', observeSource(root).digest]);
  assert.deepEqual(record.evidence.map((item) => item.path), [checkEvidencePath(1, 1, 'final')]);
}));

// --- review ---------------------------------------------------------------------------------------

const REVIEW = `${RUN}/task-1-review.md`;
const ISSUES = `${RUN}/task-1-issues.md`;
const DEFECTS = `${CORRECTION}/task-1-cycle-1-iteration-1-defects.json`;
const REVIEW_STATE = `${RUN}/task-1-review-guard-attempt-1-iteration-1`;
const REVIEW_HALT = 'unauthorized repository change during review';

const defectsBody = (overrides = {}) => `${JSON.stringify({
  version: 1, scope: 'task-1', cycle: 1, iteration: 1, verdict: 'APPROVED', defects: [], rubric: [], ...overrides,
})}\n`;
const reviewResponse = (overrides = {}) => envelopeText({
  status: 'APPROVED', artifact: REVIEW, 'changed-paths': 'none', signals: 'none', ...overrides,
});
const defectEntry = (overrides = {}) => ({
  criterion: 'SC1', check: 'review', dimension: null, cause: 'missing-test', severity: 'critical',
  expected: 'a regression test', observed: 'no test covers it', proof: 'tests/x.test.mjs', correction: 'add the test',
  nextCheck: 'review', supersedes: null, justification: null, ...overrides,
});
const rubricDefect = (dimension, overrides = {}) => defectEntry({
  check: 'rubric', dimension, cause: 'vague-names', severity: 'important', nextCheck: 'rubric', ...overrides,
});
const score = (value) => ({ score: value, evidence: 'scored against the diff' });
const rubricEntry = (criterion, scores = {}, constraints = []) => ({
  criterion, coverage: score(scores.coverage ?? 2), correctness: score(scores.correctness ?? 2),
  clarity: score(scores.clarity ?? 2), usability: score(scores.usability ?? 2), constraints,
});

// A manual task-1 iteration whose writer and passing checks are recorded and whose task reviewer is
// authorized to write REVIEW.
async function manualReviewAuthorized(repo, { rubricCriteria = [] } = {}) {
  const { root, put } = repo;
  openCorrectionRun(root, manual({ drive: 'manual' }));
  openCorrectionCycle(root, manual({ scope: 'task-1', rubricCriteria }));
  reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
  authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 1, role: 'writer', target: TASK_REPORT }));
  put('source.txt', 'changed by the writer\n');
  put(TASK_REPORT, 'Implementation report.\n');
  assert.equal(recordWriter(root).ok, true);
  assert.equal((await verifyCheck(root, { collectEvidence: collector().collectEvidence })).ok, true);
  const authorized = authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 1, role: 'task-reviewer', target: REVIEW }));
  assert.equal(authorized.ok, true, authorized.message);
}

const recordReview = (root, input = {}) => recordCorrectionReview(root, manual({
  scope: 'task-1', iteration: 1, role: 'task-reviewer', defects: DEFECTS, response: reviewResponse(), ...input,
}));

test('a manual APPROVED review is recorded with its artifact and defects digests on the authorized tree', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, put, bytes, json } = repo;
  await manualReviewAuthorized(repo);
  put(REVIEW, 'Status: Approved\n');
  put(DEFECTS, defectsBody());
  const result = recordReview(root);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.status, 'APPROVED');
  const observation = observeSource(root).digest;
  assert.deepEqual(json(recordPath(8)).record, {
    kind: 'REVIEW_RECORDED', scope: 'task-1', cycle: 1, iteration: 1, role: 'task-reviewer', ownerTask: null,
    status: 'APPROVED', defects: [], rubric: [],
    evidence: [{ path: REVIEW, digest: sha256(bytes(REVIEW)) }, { path: DEFECTS, digest: sha256(bytes(DEFECTS)) }],
    before: observation, after: observation,
  });
  assert.deepEqual(result.next, { action: 'open-cycle', scope: 'task-2' });
}));

test('a correction review is judged against the previous comparable outcome: a defect may supersede only a reported one', async () => {
  const defects2 = `${CORRECTION}/task-1-cycle-1-iteration-2-defects.json`;
  const setup = async (repo) => {
    const { root, put, bytes } = repo;
    await manualReviewAuthorized(repo);
    put(REVIEW, 'Status: Issues Found\n');
    put(ISSUES, '- add the regression test\n');
    put(DEFECTS, defectsBody({ verdict: 'ISSUES_FOUND', defects: [defectEntry()] }));
    assert.equal(recordReview(root, { response: reviewResponse({ status: 'ISSUES_FOUND', artifact: ISSUES }) }).status, 'ISSUES_FOUND');
    put(retryPath(1), `${JSON.stringify(retryRequest({ path: ISSUES, digest: sha256(bytes(ISSUES)) }, {
      kind: 'defect', confirmingCheck: 'review', observedFailure: 'the review found no regression test',
      hypothesis: 'the writer skipped the regression case', remedy: 'add the regression test',
      difference: 'the correction adds the missing case',
    }))}\n`);
    assert.equal(admitCorrectionRetry(root, manual({ request: retryPath(1) })).ok, true);
    reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 2, kind: 'correction' }));
    authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 2, role: 'writer', target: TASK_REPORT }));
    put('source.txt', 'corrected by the writer\n');
    put(TASK_REPORT, 'report 2\n');
    assert.equal(recordWriter(root, { iteration: 2 }).ok, true);
    assert.equal((await verifyCheck(root, { collectEvidence: collector().collectEvidence }, { iteration: 2 })).ok, true);
    authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 2, role: 'task-reviewer', target: REVIEW }));
  };
  const superseding = (supersedes) => defectEntry({
    cause: 'missing-edge-test', severity: 'important', supersedes,
    justification: 'the regression test landed; its edge case is still missing',
  });
  const cases = [
    ['a defect superseding the reported one', superseding('SC1/review/missing-test'), 'ISSUES_FOUND'],
    ['a defect superseding one never reported', superseding('SC1/review/never-reported'), 'INVALID'],
  ];
  await withCopies(PLAN_TWO, setup, cases, ({ root, put, json }, [label, entry, status]) => {
    put(defects2, defectsBody({ iteration: 2, verdict: 'ISSUES_FOUND', defects: [entry] }));
    const result = recordReview(root, { iteration: 2, defects: defects2, response: reviewResponse({ status: 'ISSUES_FOUND', artifact: ISSUES }) });
    assert.equal(result.ok, true, `${label}: ${result.message}`);
    assert.equal(json(result.ref.path).record.status, status, label);
  });
});

test('a manual ISSUES_FOUND review names its issues artifact and records the reviewer defects', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, put, bytes, json } = repo;
  await manualReviewAuthorized(repo);
  put(REVIEW, 'Status: Issues Found\n');
  put(ISSUES, '- add the regression test\n');
  put(DEFECTS, defectsBody({ verdict: 'ISSUES_FOUND', defects: [defectEntry()] }));
  const result = recordReview(root, { response: reviewResponse({ status: 'ISSUES_FOUND', artifact: ISSUES }) });
  assert.equal(result.ok, true, result.message);
  const { record } = json(recordPath(8));
  assert.equal(record.status, 'ISSUES_FOUND');
  assert.deepEqual(record.defects, [defectEntry()]);
  assert.deepEqual(record.evidence.map((item) => item.path), [REVIEW, ISSUES, DEFECTS]);
  assert.equal(record.evidence[1].digest, sha256(bytes(ISSUES)));
  assert.equal(result.next.action, 'retry-or-diagnosis');
}));

test('an invalid defects artifact or reviewer response records the review INVALID', async () => {
  const cases = [
    ['a duplicate key', defectsBody().replace('{"version":1,', '{"version":1,"version":1,'), reviewResponse()],
    ['another version', defectsBody({ version: 2 }), reviewResponse()],
    ['an open key', defectsBody({ note: 'extra' }), reviewResponse()],
    ['another scope', defectsBody({ scope: 'task-2' }), reviewResponse()],
    ['another cycle', defectsBody({ cycle: 2 }), reviewResponse()],
    ['another iteration', defectsBody({ iteration: 2 }), reviewResponse()],
    ['a verdict that is not the status', defectsBody({ verdict: 'ISSUES_FOUND', defects: [defectEntry()] }), reviewResponse()],
    ['APPROVED with a blocking defect', defectsBody({ defects: [defectEntry()] }), reviewResponse()],
    ['ISSUES_FOUND without a blocking defect', defectsBody({ verdict: 'ISSUES_FOUND', defects: [defectEntry({ severity: 'minor' })] }),
      reviewResponse({ status: 'ISSUES_FOUND', artifact: ISSUES })],
    ['a defect schema error', defectsBody({ verdict: 'ISSUES_FOUND', defects: [{ ...defectEntry(), extra: 1 }] }),
      reviewResponse({ status: 'ISSUES_FOUND', artifact: ISSUES })],
    ['an unbound defect', defectsBody({ verdict: 'ISSUES_FOUND', defects: [defectEntry({ criterion: 'SC3' })] }),
      reviewResponse({ status: 'ISSUES_FOUND', artifact: ISSUES })],
    ['a missing defects artifact', null, reviewResponse()],
    ['changed paths reported by a reviewer', defectsBody(), reviewResponse({ 'changed-paths': 'source.txt' })],
    ['another artifact', defectsBody(), reviewResponse({ artifact: ISSUES })],
    ['a missing issues artifact', defectsBody({ verdict: 'ISSUES_FOUND', defects: [defectEntry()] }),
      reviewResponse({ status: 'ISSUES_FOUND', artifact: ISSUES })],
  ];
  const setup = async (repo) => {
    await manualReviewAuthorized(repo);
    repo.put(REVIEW, 'Status: Approved\n');
  };
  await withCopies(PLAN_TWO, setup, cases, ({ root, put, bytes, json }, [label, body, response]) => {
    if (body !== null) put(DEFECTS, body);
    const result = recordReview(root, { response });
    assert.equal(result.ok, true, `${label}: ${result.message}`);
    assert.equal(result.status, 'INVALID', label);
    const { record } = json(recordPath(8));
    assert.deepEqual([record.status, record.defects, record.rubric], ['INVALID', [], []], label);
    const evidence = [{ path: REVIEW, digest: sha256(bytes(REVIEW)) }];
    if (body !== null) evidence.push({ path: DEFECTS, digest: sha256(bytes(DEFECTS)) });
    assert.deepEqual(record.evidence, evidence, label);
    assert.equal(result.next.action, 'retry-or-diagnosis', label);
  });
});

test('the rubric rules are enforced: an unsupported score or unsatisfied constraint is INVALID', async () => {
  const unsatisfied = [{ id: 'no-network', satisfied: false, evidence: 'the test opens a socket' }];
  const cases = [
    ['a full rubric', 'APPROVED', { rubric: [rubricEntry('SC1')] }, 'APPROVED'],
    ['a missing rubric entry', 'APPROVED', { rubric: [] }, 'INVALID'],
    ['a score below 2 without a rubric defect', 'APPROVED', { rubric: [rubricEntry('SC1', { clarity: 1 })] }, 'INVALID'],
    ['a score below 2 with its rubric defect', 'ISSUES_FOUND',
      { verdict: 'ISSUES_FOUND', rubric: [rubricEntry('SC1', { clarity: 1 })], defects: [rubricDefect('clarity')] }, 'ISSUES_FOUND'],
    ['an unsatisfied constraint without a blocking review defect', 'ISSUES_FOUND',
      { verdict: 'ISSUES_FOUND', rubric: [rubricEntry('SC1', { clarity: 1 }, unsatisfied)], defects: [rubricDefect('clarity')] }, 'INVALID'],
    ['an unsatisfied constraint with a blocking review defect', 'ISSUES_FOUND',
      { verdict: 'ISSUES_FOUND', rubric: [rubricEntry('SC1', {}, unsatisfied)], defects: [defectEntry({ cause: 'opens-socket' })] }, 'ISSUES_FOUND'],
  ];
  const setup = async (repo) => {
    await manualReviewAuthorized(repo, { rubricCriteria: ['SC1'] });
    repo.put(REVIEW, 'review\n');
    repo.put(ISSUES, 'issues\n');
  };
  await withCopies(PLAN_TWO, setup, cases, ({ root, put, json }, [label, status, body, recorded]) => {
    put(DEFECTS, defectsBody(body));
    const result = recordReview(root, { response: reviewResponse({ status, artifact: status === 'APPROVED' ? REVIEW : ISSUES }) });
    assert.equal(result.ok, true, `${label}: ${result.message}`);
    assert.equal(json(recordPath(8)).record.status, recorded, label);
  });
});

test('a reviewer that reports BLOCKED or NEEDS_CONTEXT is recorded with that status and its artifact', async () => {
  for (const status of ['BLOCKED', 'NEEDS_CONTEXT']) {
    await withRepo(PLAN_TWO, async (repo) => {
      const { root, put, bytes, json } = repo;
      await manualReviewAuthorized(repo);
      put(REVIEW, 'Status: Blocked — the diff is missing\n');
      const result = recordReview(root, { response: reviewResponse({ status }) });
      assert.equal(result.ok, true, result.message);
      const { record } = json(recordPath(8));
      assert.deepEqual([record.status, record.defects, record.rubric], [status, [], []]);
      assert.deepEqual(record.evidence, [{ path: REVIEW, digest: sha256(bytes(REVIEW)) }]);
    });
  }
});

test('record-review refuses another role, owner task, defects path or a review that is not next', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, put, exists } = repo;
  await manualReviewAuthorized(repo);
  put(REVIEW, 'Status: Approved\n');
  put(DEFECTS, defectsBody());
  assert.equal(recordReview(root, { role: 'writer' }).code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  assert.equal(recordReview(root, { role: 'final-reviewer' }).code, CORRECTION_GUARD_CODES.STEP_INVALID);
  assert.equal(recordReview(root, { iteration: 2 }).code, CORRECTION_GUARD_CODES.STEP_INVALID);
  assert.equal(recordReview(root, { ownerTask: '1' }).code, CORRECTION_CODES.refusal.ROLE_NOT_ALLOWED);
  assert.equal(recordReview(root, { defects: `${RUN}/defects.json` }).code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  assert.equal(recordReview(root, { defects: '.formula/work/tasks/other/correction/task-1-cycle-1-iteration-1-defects.json' }).code,
    CORRECTION_GUARD_CODES.INPUT_INVALID);
  for (const misnamed of ['task-2-cycle-1-iteration-1', 'task-1-cycle-2-iteration-1', 'task-1-cycle-1-iteration-2']) {
    put(`${CORRECTION}/${misnamed}-defects.json`, defectsBody());
    assert.equal(recordReview(root, { defects: `${CORRECTION}/${misnamed}-defects.json` }).code,
      CORRECTION_GUARD_CODES.INPUT_INVALID, `the defects of ${misnamed}`);
  }
  assert.equal(recordReview(root, { reviewState: REVIEW_STATE }).code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  assert.equal(recordReview(root, { response: undefined }).code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  const owned = cli(root, ['--action', 'record-review', '--scope', 'task-1', '--iteration', '1', '--role', 'task-reviewer',
    '--defects', DEFECTS, '--owner-task', '1'], { input: reviewResponse() });
  assert.equal(owned.status, 1);
  assert.equal(owned.json.code, CORRECTION_CODES.refusal.ROLE_NOT_ALLOWED, '--owner-task is the ownerTask input');
  assert.equal(exists(recordPath(8)), false);
}));

test('a source change during the review appends RUN_HALTED naming the unauthorized change', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, put, json, exists } = repo;
  await manualReviewAuthorized(repo);
  put(REVIEW, 'Status: Approved\n');
  put(DEFECTS, defectsBody());
  put('source.txt', 'the reviewer edited the source\n');
  const result = cli(root, ['--action', 'record-review', '--scope', 'task-1', '--iteration', '1', '--role', 'task-reviewer',
    '--defects', DEFECTS], { input: reviewResponse() });
  assert.equal(result.status, 3);
  assert.equal(result.json.message, REVIEW_HALT);
  const { record } = json(recordPath(8));
  assert.deepEqual([record.kind, record.reason, record.observation], ['RUN_HALTED', REVIEW_HALT, observeSource(root).digest]);
  put('source.txt', 'changed by the writer\n');
  assert.equal(recordReview(root).code, CORRECTION_GUARD_CODES.RUN_HALTED, 'an unauthorized mutation stops the whole run');
  assert.equal(exists(recordPath(9)), false);
}));

test('a reducer integrity refusal of the review appends RUN_HALTED: the reviewer was authorized before the checked tree', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, put, json } = repo;
  openCorrectionRun(root, manual({ drive: 'manual' }));
  openCorrectionCycle(root, manual({ scope: 'task-1' }));
  reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
  authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 1, role: 'writer', target: TASK_REPORT }));
  assert.equal(authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 1, role: 'task-reviewer', target: REVIEW })).ok, true);
  put('source.txt', 'changed by the writer\n');
  put(TASK_REPORT, 'report\n');
  assert.equal(recordWriter(root).ok, true);
  assert.equal((await verifyCheck(root, { collectEvidence: collector().collectEvidence })).ok, true);
  put(REVIEW, 'Status: Approved\n');
  put(DEFECTS, defectsBody());
  const result = recordReview(root);
  assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY);
  assert.equal(result.message, REVIEW_HALT);
  const { record } = json(recordPath(8));
  assert.deepEqual([record.kind, record.reason], ['RUN_HALTED', REVIEW_HALT]);
}));

const FINAL_ISSUES = `${RUN}/final-review-issues.md`;

test('a final-scope correction records its writer, checks, the owner task review and the final review, each with its own defects', () => withRepo(PLAN_ONE, async (repo) => {
  const { root, put, bytes, json } = repo;
  const collect = { collectEvidence: collector().collectEvidence };
  const recordOf = (result) => json(result.ref.path).record;
  const digestOf = (path) => ({ path, digest: sha256(bytes(path)) });
  // Task 1 is approved by its own cycle.
  openCorrectionRun(root, manual({ drive: 'manual' }));
  openCorrectionCycle(root, manual({ scope: 'task-1' }));
  reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' }));
  authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 1, role: 'writer', target: TASK_REPORT }));
  put('source.txt', 'changed by the writer\n');
  put(TASK_REPORT, 'report 1\n');
  assert.equal(recordWriter(root).ok, true);
  assert.equal((await verifyCheck(root, collect)).ok, true);
  authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 1, role: 'task-reviewer', target: REVIEW }));
  put(REVIEW, 'Status: Approved\n');
  put(DEFECTS, defectsBody());
  assert.deepEqual(recordReview(root).next, { action: 'open-cycle', scope: 'final' });
  // The final review finds an issue in task 1.
  openCorrectionCycle(root, manual({ scope: 'final' }));
  reserveCorrectionIteration(root, manual({ scope: 'final', iteration: 1, kind: 'initial' }));
  authorizeCorrectionDispatch(root, manual({ scope: 'final', iteration: 1, role: 'final-reviewer', target: FINAL_REVIEW }));
  assert.equal((await recordCorrectionChecks(root, manual({ scope: 'final', iteration: 1 }), collect)).ok, true);
  put(FINAL_REVIEW, 'Status: Issues Found\n');
  put(FINAL_ISSUES, '- task 1 lacks a regression test\n');
  put(finalDefectsPath(1), defectsBody({ scope: 'final', verdict: 'ISSUES_FOUND', defects: [defectEntry()] }));
  const found = recordCorrectionReview(root, manual({
    scope: 'final', iteration: 1, role: 'final-reviewer', defects: finalDefectsPath(1),
    response: reviewResponse({ status: 'ISSUES_FOUND', artifact: FINAL_ISSUES }),
  }));
  assert.equal(found.status, 'ISSUES_FOUND', found.message);
  const retry = `${CORRECTION}/final-cycle-1-retry-1.json`;
  put(retry, `${JSON.stringify(retryRequest(digestOf(FINAL_ISSUES), {
    scope: 'final', kind: 'defect', observedFailure: 'the final review found no regression test for task 1',
    hypothesis: 'the task 1 writer skipped the edge case', remedy: 'add the regression test to task 1',
    difference: 'the correction targets the edge case', confirmingCheck: 'review',
  }))}\n`);
  assert.equal(admitCorrectionRetry(root, manual({ request: retry })).ok, true);
  // The correction of task 1: its writer, the checks, then the owner task review and the final review.
  reserveCorrectionIteration(root, manual({ scope: 'final', iteration: 2, kind: 'correction' }));
  const writer = authorizeCorrectionDispatch(root, manual({
    scope: 'final', iteration: 2, role: 'writer', target: TASK_REPORT, ownerTask: '1', affectedCriteria: ['SC1'],
  }));
  assert.equal(writer.ok, true, writer.message);
  put('source.txt', 'corrected by the final writer\n');
  put(TASK_REPORT, 'report 2\n');
  const written = recordCorrectionWriter(root, manual({ scope: 'final', iteration: 2, response: writerResponse({ status: 'DONE' }) }));
  assert.equal(written.ok, true, written.message);
  assert.equal(recordOf(written).status, 'DONE');
  const checked = await recordCorrectionChecks(root, manual({ scope: 'final', iteration: 2 }), collect);
  assert.equal(checked.ok, true, checked.message);
  assert.deepEqual(checked.next, { action: 'authorize', scope: 'final', cycle: 1, iteration: 2, role: 'task-reviewer', ownerTask: '1' });
  authorizeCorrectionDispatch(root, manual({ scope: 'final', iteration: 2, role: 'task-reviewer', target: REVIEW, ownerTask: '1' }));
  put(REVIEW, 'Status: Approved after the final correction\n');
  const taskDefects = finalDefectsPath(2, '-task-reviewer');
  put(taskDefects, defectsBody({ scope: 'final', iteration: 2 }));
  put(finalDefectsPath(2), defectsBody({ scope: 'final', iteration: 2 }));
  const taskReview = (defects) => recordCorrectionReview(root, manual({
    scope: 'final', iteration: 2, role: 'task-reviewer', ownerTask: '1', defects, response: reviewResponse(),
  }));
  assert.equal(taskReview(finalDefectsPath(2)).code, CORRECTION_GUARD_CODES.INPUT_INVALID,
    'a final-scope task review never takes the verdict reviewer\'s defects');
  const reviewed = taskReview(taskDefects);
  assert.equal(reviewed.status, 'APPROVED', reviewed.message);
  assert.deepEqual(recordOf(reviewed).evidence, [digestOf(REVIEW), digestOf(taskDefects)]);
  authorizeCorrectionDispatch(root, manual({ scope: 'final', iteration: 2, role: 'final-reviewer', target: FINAL_REVIEW }));
  put(FINAL_REVIEW, 'Status: Approved\n');
  const final = recordCorrectionReview(root, manual({
    scope: 'final', iteration: 2, role: 'final-reviewer', defects: finalDefectsPath(2), response: reviewResponse({ artifact: FINAL_REVIEW }),
  }));
  assert.equal(final.status, 'APPROVED', final.message);
  assert.deepEqual(recordOf(final).evidence, [digestOf(FINAL_REVIEW), digestOf(FINAL_ISSUES), digestOf(finalDefectsPath(2))]);
  assert.equal(final.next.action, 'terminal');
  assert.equal(final.next.summary.outcome, 'COMPLETE');
}));

// An autopilot task-1 iteration whose receipt-bound writer and checks are recorded and whose task reviewer
// is authorized for the review guard REVIEW_STATE, begun with reviewer-response.
async function autopilotReviewAuthorized(repo) {
  const { root } = repo;
  const actor = autopilotWriterReported(repo);
  assert.equal(recordCorrectionWriter(root, manual({ scope: 'task-1', iteration: 1, execution: EXECUTION, ...actor })).ok, true);
  const checked = await recordCorrectionChecks(root, manual({ scope: 'task-1', iteration: 1, ...actor }), { collectEvidence: collector().collectEvidence });
  assert.equal(checked.ok, true, checked.message);
  assert.equal(authorizeCorrectionDispatch(root, manual({
    scope: 'task-1', iteration: 1, role: 'task-reviewer', target: REVIEW_STATE, ...actor,
  })).ok, true);
  beginReview(root, REVIEW_STATE, {
    runId: 'run-1', attempt: 1, iteration: 1, task: '1', report: REVIEW, issues: ISSUES, execution: EXECUTION,
  });
  return actor;
}

test('the autopilot review binds the reviewer-response receipt, its artifacts and the defects digest', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, put, bytes, json } = repo;
  const actor = await autopilotReviewAuthorized(repo);
  put(REVIEW, 'Status: Approved\n');
  assert.equal(checkReview(root, REVIEW_STATE, `status: APPROVED\nartifact: ${REVIEW}\nsignals: none\n`).accepted, true);
  put(DEFECTS, defectsBody());
  const review = (input) => recordCorrectionReview(root, manual({
    scope: 'task-1', iteration: 1, role: 'task-reviewer', defects: DEFECTS, ...actor, ...input,
  }));
  assert.equal(review({ reviewState: `${RUN}/task-1-review-guard-attempt-1-iteration-2` }).code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  assert.equal(review({ reviewState: REVIEW_STATE, response: reviewResponse() }).code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  const result = review({ reviewState: REVIEW_STATE });
  assert.equal(result.ok, true, result.message);
  const digest = (path) => ({ path, digest: sha256(bytes(path)) });
  const { record } = json(recordPath(8));
  assert.equal(record.status, 'APPROVED');
  assert.deepEqual(record.evidence, [
    digest(`${REVIEW_STATE}-baseline.json`), digest(`${REVIEW_STATE}-original.json`), digest(REVIEW), digest(DEFECTS),
  ]);
}));

test('an autopilot review receipt whose stored result saw the source change halts the run', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, put, bytes, json } = repo;
  const actor = await autopilotReviewAuthorized(repo);
  put(REVIEW, 'Status: Approved\n');
  put('source.txt', 'edited by the reviewer\n');
  assert.equal(checkReview(root, REVIEW_STATE, `status: APPROVED\nartifact: ${REVIEW}\nsignals: none\n`).status, 'BLOCKED');
  put('source.txt', 'autopilot change\n');
  put(DEFECTS, defectsBody());
  const result = recordCorrectionReview(root, manual({
    scope: 'task-1', iteration: 1, role: 'task-reviewer', defects: DEFECTS, reviewState: REVIEW_STATE, ...actor,
  }));
  assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY);
  assert.equal(result.message, REVIEW_HALT);
  const { record } = json(recordPath(8));
  assert.deepEqual([record.kind, record.reason], ['RUN_HALTED', REVIEW_HALT]);
  assert.deepEqual(record.evidence, [`${REVIEW_STATE}-baseline.json`, `${REVIEW_STATE}-original.json`]
    .map((path) => ({ path, digest: sha256(bytes(path)) })));
  assert.equal(record.observation, observeSource(root).digest);
  assertHalted(repo, 8, 'the review receipt', actor);
}));

test('an autopilot review whose result was never stored halts the run citing the receipt that exists', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, put, bytes, json } = repo;
  const actor = await autopilotReviewAuthorized(repo);
  put(REVIEW, 'Status: Approved\n');
  put(DEFECTS, defectsBody());
  const result = recordCorrectionReview(root, manual({
    scope: 'task-1', iteration: 1, role: 'task-reviewer', defects: DEFECTS, reviewState: REVIEW_STATE, ...actor,
  }));
  assert.equal(result.code, CORRECTION_GUARD_CODES.INTEGRITY);
  assert.match(result.message, /^the review receipt does not verify: /u);
  assert.deepEqual(json(recordPath(8)).record.evidence,
    [{ path: `${REVIEW_STATE}-baseline.json`, digest: sha256(bytes(`${REVIEW_STATE}-baseline.json`)) }]);
  assertHalted(repo, 8, 'a review receipt without its result', actor);
}));

// --- diagnosis ------------------------------------------------------------------------------------

const DIAGNOSIS = `${CORRECTION}/task-1-cycle-1-iteration-2-diagnosis.json`;
const DIAGNOSIS_HALT = 'unauthorized repository change during diagnosis';
const diagnosisBody = (overrides = {}) => `${JSON.stringify({
  version: 1, scope: 'task-1', cycle: 1, iteration: 2,
  hypothesis: 'the harness exhausted its memory on the large fixture', remedy: 'dispatch the writer with the fixture trimmed',
  confirmingCheck: 'surface-test', recommendation: 'split the fixture before the next writer',
  evidence: [{ path: 'source.txt', digest: sha256(Buffer.from('baseline\n')) }], ...overrides,
})}\n`;
const diagnosisResponse = (overrides = {}) => envelopeText({
  status: 'DIAGNOSED', artifact: DIAGNOSIS, 'changed-paths': 'none', signals: 'none', ...overrides,
});

// Task-1 iteration 1 was interrupted; iteration 2 is the diagnosis, whose diagnostic is authorized to
// write DIAGNOSIS.
function diagnosisAuthorized(root, actor = {}, target = DIAGNOSIS) {
  if (Object.keys(actor).length === 0) openCorrectionRun(root, manual({ drive: 'manual' }));
  openCorrectionCycle(root, manual({ scope: 'task-1', ...actor }));
  reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial', ...actor }));
  recordCorrectionInterruption(root, manual({ scope: 'task-1', iteration: 1, reason: 'the harness crashed', ...actor }));
  reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 2, kind: 'diagnosis', reason: 'missing-retry-evidence', ...actor }));
  const authorized = authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 2, role: 'diagnostic', target, ...actor }));
  assert.equal(authorized.ok, true, authorized.message);
}

const recordDiagnosis = (root, input = {}) => recordCorrectionDiagnosis(root, manual({
  scope: 'task-1', iteration: 2, response: diagnosisResponse(), ...input,
}));

test('a valid manual diagnosis is recorded with its artifact digest on the unchanged tree', () => withRepo(PLAN_TWO, ({ root, put, bytes, json }) => {
  diagnosisAuthorized(root);
  put(DIAGNOSIS, diagnosisBody({
    evidence: [{ path: 'source.txt', digest: sha256(Buffer.from('baseline\n')) }, { path: recordPath(4), digest: sha256(bytes(recordPath(4))) }],
  }));
  const result = recordDiagnosis(root);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.valid, true);
  const observation = observeSource(root).digest;
  assert.deepEqual(json(recordPath(7)).record, {
    kind: 'DIAGNOSIS_RECORDED', scope: 'task-1', cycle: 1, iteration: 2, valid: true,
    hypothesis: 'the harness exhausted its memory on the large fixture', remedy: 'dispatch the writer with the fixture trimmed',
    confirmingCheck: 'surface-test', recommendation: 'split the fixture before the next writer',
    artifact: { path: DIAGNOSIS, digest: sha256(bytes(DIAGNOSIS)) }, before: observation, after: observation,
  });
  assert.deepEqual(result.next, { action: 'retry-or-diagnosis', scope: 'task-1', cycle: 1, iteration: 3, diagnosisAvailable: false });
}));

test('a diagnosis is valid only when DIAGNOSED, complete, bound to a check and backed by current bytes', () => {
  const cases = [
    ['INCONCLUSIVE', diagnosisBody(), diagnosisResponse({ status: 'INCONCLUSIVE' })],
    ['BLOCKED', diagnosisBody(), diagnosisResponse({ status: 'BLOCKED' })],
    ['an empty hypothesis', diagnosisBody({ hypothesis: ' ' }), diagnosisResponse()],
    ['an empty recommendation', diagnosisBody({ recommendation: '' }), diagnosisResponse()],
    ['an unbound confirming check', diagnosisBody({ confirmingCheck: 'lint' }), diagnosisResponse()],
    ['a stale source digest', diagnosisBody({ evidence: [{ path: 'source.txt', digest: '0'.repeat(64) }] }), diagnosisResponse()],
    ['an unobserved source path', diagnosisBody({ evidence: [{ path: 'missing.txt', digest: '0'.repeat(64) }] }), diagnosisResponse()],
    ['a stale work artifact digest', diagnosisBody({ evidence: [{ path: recordPath(4), digest: '0'.repeat(64) }] }), diagnosisResponse()],
    ['another iteration', diagnosisBody({ iteration: 1 }), diagnosisResponse()],
    ['an open key', diagnosisBody({ note: 'extra' }), diagnosisResponse()],
    ['a duplicate key', diagnosisBody().replace('{"version":1,', '{"version":1,"version":1,'), diagnosisResponse()],
    ['another artifact', diagnosisBody(), diagnosisResponse({ artifact: `${CORRECTION}/task-1-cycle-1-iteration-3-diagnosis.json` })],
    ['an unknown status', diagnosisBody(), diagnosisResponse({ status: 'DONE' })],
    ['reported changed paths', diagnosisBody(), diagnosisResponse({ 'changed-paths': 'source.txt' })],
    ['an autopilot three-field response on a manual drive', diagnosisBody(),
      envelopeText({ status: 'DIAGNOSED', artifact: DIAGNOSIS, signals: 'none' })],
  ];
  return withCopies(PLAN_TWO, ({ root }) => diagnosisAuthorized(root), cases, ({ root, put, json }, [label, body, response]) => {
    put(DIAGNOSIS, body);
    const result = recordDiagnosis(root, { response });
    assert.equal(result.ok, true, `${label}: ${result.message}`);
    assert.equal(result.valid, false, label);
    assert.equal(json(recordPath(7)).record.valid, false, label);
    assert.deepEqual(result.next, { action: 'prove-isolation', scope: 'task-1', cycle: 1 }, label);
  });
});

test('an autopilot diagnosis response with a changed-paths field is invalid', () => withRepo(PLAN_TWO, ({ root, put, json }) => {
  put(manifestPath(1), manifest('run-1', 1));
  const actor = { runId: 'run-1', attempt: 1 };
  openCorrectionRun(root, manual({ drive: 'autopilot', ...actor }));
  diagnosisAuthorized(root, actor);
  put(DIAGNOSIS, diagnosisBody());
  const four = recordDiagnosis(root, { ...actor });
  assert.equal(four.ok, true, four.message);
  assert.equal(four.valid, false);
  assert.equal(json(recordPath(7)).record.valid, false);
}));

test('an autopilot diagnosis with the three-field response is valid', () => withRepo(PLAN_TWO, ({ root, put, json }) => {
  put(manifestPath(1), manifest('run-1', 1));
  const actor = { runId: 'run-1', attempt: 1 };
  openCorrectionRun(root, manual({ drive: 'autopilot', ...actor }));
  diagnosisAuthorized(root, actor);
  put(DIAGNOSIS, diagnosisBody());
  const result = recordDiagnosis(root, { ...actor, response: envelopeText({ status: 'DIAGNOSED', artifact: DIAGNOSIS, signals: 'none' }) });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.valid, true);
  assert.equal(json(recordPath(7)).record.valid, true);
}));

test('record-diagnosis refuses a missing artifact, another target or a diagnosis that is not next', () => {
  withRepo(PLAN_TWO, ({ root, put, exists }) => {
    diagnosisAuthorized(root);
    assert.equal(recordDiagnosis(root).code, CORRECTION_GUARD_CODES.INPUT_INVALID, 'a missing artifact');
    put(DIAGNOSIS, diagnosisBody());
    assert.equal(recordDiagnosis(root, { response: undefined }).code, CORRECTION_GUARD_CODES.INPUT_INVALID, 'no response');
    assert.equal(recordDiagnosis(root, { iteration: 3 }).code, CORRECTION_GUARD_CODES.STEP_INVALID);
    assert.equal(exists(recordPath(7)), false);
  });
  withRepo(PLAN_TWO, ({ root, put, exists }) => {
    diagnosisAuthorized(root, {}, `${RUN}/diagnosis.md`);
    put(DIAGNOSIS, diagnosisBody());
    assert.equal(recordDiagnosis(root).code, CORRECTION_GUARD_CODES.INPUT_INVALID, 'a target that is not the diagnosis path');
    assert.equal(exists(recordPath(7)), false);
  });
});

test('a source change during the diagnosis appends RUN_HALTED and exits 3', () => withRepo(PLAN_TWO, ({ root, put, json }) => {
  diagnosisAuthorized(root);
  put(DIAGNOSIS, diagnosisBody());
  put('source.txt', 'the diagnostic edited the source\n');
  const result = cli(root, ['--action', 'record-diagnosis', '--scope', 'task-1', '--iteration', '2'], { input: diagnosisResponse() });
  assert.equal(result.status, 3);
  assert.equal(result.json.message, DIAGNOSIS_HALT);
  const { record } = json(recordPath(7));
  assert.deepEqual([record.kind, record.reason, record.observation], ['RUN_HALTED', DIAGNOSIS_HALT, observeSource(root).digest]);
}));

test('the record-diagnosis CLI reads the response from stdin', () => withRepo(PLAN_TWO, ({ root, put, json }) => {
  diagnosisAuthorized(root);
  put(DIAGNOSIS, diagnosisBody());
  const result = cli(root, ['--action', 'record-diagnosis', '--scope', 'task-1', '--iteration', '2'], { input: diagnosisResponse() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(recordPath(7)).record.valid, true);
}));

// --- isolation ------------------------------------------------------------------------------------

const stop = (root) => stopCorrectionCycle(root, manual({ scope: 'task-1', reason: 'HUMAN_INTERRUPTED', note: 'paused by the user' }));
const prove = (root, input = {}) => proveCorrectionIsolation(root, manual({ scope: 'task-1', ...input }));

test('a stopped cycle on its opening tree proves baseline-equal isolation', () => withRepo(PLAN_TWO, ({ root, json }) => {
  interruptedRun(root);
  assert.equal(stop(root).ok, true);
  const result = prove(root);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.mode, 'baseline-equal');
  assert.deepEqual(json(recordPath(6)).record, {
    kind: 'ISOLATION_RECORDED', scope: 'task-1', cycle: 1, mode: 'baseline-equal', observation: observeSource(root).digest,
  });
  assert.deepEqual(result.next, { action: 'open-cycle', scope: 'final' });
}));

test('a stopped cycle on its verified best candidate whose checks passed proves retained-best isolation', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, put, json } = repo;
  await manualReviewAuthorized(repo);
  put(REVIEW, 'Status: Issues Found\n');
  put(ISSUES, '- add the regression test\n');
  put(DEFECTS, defectsBody({ verdict: 'ISSUES_FOUND', defects: [defectEntry()] }));
  assert.equal(recordReview(root, { response: reviewResponse({ status: 'ISSUES_FOUND', artifact: ISSUES }) }).status, 'ISSUES_FOUND');
  assert.equal(stop(root).ok, true);
  const result = prove(root);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.mode, 'retained-best');
  assert.deepEqual(json(recordPath(10)).record, {
    kind: 'ISOLATION_RECORDED', scope: 'task-1', cycle: 1, mode: 'retained-best', observation: observeSource(root).digest,
  });
}));

test('an unprovable isolation halts with recovery evidence and leaves every source byte and Git state unchanged', () => withRepo(PLAN_TWO, async (repo) => {
  const { root, put, bytes, json, git } = repo;
  manualWriterRecorded(repo);
  const failing = collector({ surface: { exitCode: 1, passed: false, excerpt: '# fail 3\n' } });
  assert.equal((await verifyCheck(root, { collectEvidence: failing.collectEvidence })).ok, true);
  assert.equal(stop(root).ok, true);
  const sources = ['.gitignore', 'source.txt'];
  const before = sources.map((path) => bytes(path));
  const gitBefore = [git('rev-parse', 'HEAD').toString(), git('status', '--porcelain').toString(), bytes('.git/index')];
  const snapshot = json(recordPath(5)).record.candidate;
  const baseline = { path: baselinePath('task-1', 1), digest: sha256(bytes(baselinePath('task-1', 1))) };
  const result = cli(root, ['--action', 'prove-isolation', '--scope', 'task-1']);
  assert.equal(result.status, 3);
  assert.equal(result.json.code, CORRECTION_GUARD_CODES.INTEGRITY);
  const { record } = json(recordPath(8));
  assert.equal(record.kind, 'RUN_HALTED');
  assert.match(record.reason, /isolation of task-1#1 is unprovable.*source\.txt/u);
  assert.deepEqual(record.evidence, [snapshot, baseline]);
  assert.equal(record.observation, observeSource(root).digest);
  assert.deepEqual(result.json.identity.recovery, {
    bestCandidate: { iteration: 1, observation: record.observation, snapshot },
    baseline,
    changedPaths: ['source.txt'],
  });
  assert.deepEqual(sources.map((path) => bytes(path)), before, 'the guard never restores a source file');
  assert.deepEqual([git('rev-parse', 'HEAD').toString(), git('status', '--porcelain').toString(), bytes('.git/index')], gitBefore);
  put('source.txt', 'baseline\n');
  assert.equal(prove(root).code, CORRECTION_GUARD_CODES.RUN_HALTED, 'the halted run stays halted');
}));

test('prove-isolation refuses a scope whose isolation is not the next step, writing nothing', () => withRepo(PLAN_TWO, ({ root, exists }) => {
  interruptedRun(root);
  assert.equal(prove(root).code, CORRECTION_GUARD_CODES.STEP_INVALID, 'the cycle is still open');
  assert.equal(stop(root).ok, true);
  assert.equal(prove(root, { scope: 'task-2' }).code, CORRECTION_GUARD_CODES.STEP_INVALID);
  assert.equal(exists(recordPath(6)), false);
  assert.equal(cli(root, ['--action', 'prove-isolation', '--scope', 'task-1']).status, 0);
  assert.equal(prove(root).code, CORRECTION_GUARD_CODES.STEP_INVALID, 'isolation is proven once');
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
function cli(root, args, { plan = PLAN, input = '' } = {}) {
  const argv = [SCRIPT, '--repo-root', root, ...(plan === null ? [] : ['--plan', plan]), ...args];
  const result = spawnSync(process.execPath, argv, { cwd: root, encoding: 'utf8', input });
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
  3: 'integrity failure (run halted, evidence corrupt or an unauthorized dispatch)',
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
    [['--action', 'record-review', '--scope', 'task-1', '--iteration', '1', '--role', 'task-reviewer'], /--defects/u],
    [['--action', 'record-writer', '--scope', 'task-1', '--iteration', '1', '--review-state', 'x'], /--review-state/u],
    [['--action', 'verify-check', '--scope', 'task-1'], /--iteration/u],
    [['--action', 'record-diagnosis', '--scope', 'task-1', '--iteration', '2', '--defects', 'x'], /--defects/u],
    [['--action', 'prove-isolation', '--scope', 'task-1', '--iteration', '1'], /--iteration/u],
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

test('main resolves the exit code in-process and writes one JSON line to the injected stdout', () => withRepo(PLAN_TWO, async ({ root }) => {
  const out = [];
  const err = [];
  const io = { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } };
  assert.equal(await main(['--repo-root', root, '--plan', PLAN, '--action', 'open', '--drive', 'manual'], io), 0);
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]).action, 'open');
  assert.deepEqual(err, []);
  assert.equal(await main(['--repo-root', root, '--plan', PLAN, '--action', 'reopen', '--authorization', reopenPath(), '--run-id', 'r'], io), 1);
  assert.equal(JSON.parse(out[1]).code, CORRECTION_GUARD_CODES.ACTOR_INVALID);
  await assert.rejects(main([], { stdout: io.stdout, log: io.stdout }), TypeError);
  await assert.rejects(main([], { ...io, stdin: 'not a function' }), TypeError);
}));

test('main reads a manual response from the injected stdin only for the actions that take one', () => withRepo(PLAN_TWO, async ({ root, put, json }) => {
  manualWriterAuthorized(root);
  put('source.txt', 'changed\n');
  put(TASK_REPORT, 'report\n');
  const reads = [];
  const out = [];
  const io = {
    stdout: { write: (text) => out.push(text) }, stderr: { write: () => {} },
    stdin: () => { reads.push(true); return Buffer.from(writerResponse()); },
  };
  assert.equal(await main(['--repo-root', root, '--plan', PLAN, '--action', 'next'], io), 0);
  assert.equal(reads.length, 0);
  assert.equal(await main(['--repo-root', root, '--plan', PLAN, '--action', 'record-writer', '--scope', 'task-1', '--iteration', '1'], io), 0);
  assert.equal(reads.length, 1);
  assert.equal(json(recordPath(5)).record.responseDigest, sha256(Buffer.from(writerResponse())));
}));

test('on an autopilot drive a response-taking action without its receipt option refuses without reading stdin', () => withRepo(PLAN_TWO, async (repo) => {
  const { root } = repo;
  autopilotWriterAuthorized(repo);
  const reads = [];
  const out = [];
  const io = {
    stdout: { write: (text) => out.push(text) }, stderr: { write: () => {} },
    stdin: () => { reads.push(true); return Buffer.from(writerResponse()); },
  };
  const actor = ['--run-id', 'run-1', '--attempt', '1'];
  const writer = await main(['--repo-root', root, '--plan', PLAN, '--action', 'record-writer', '--scope', 'task-1',
    '--iteration', '1', ...actor], io);
  assert.equal(writer, 1);
  assert.equal(JSON.parse(out.at(-1)).code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  const review = await main(['--repo-root', root, '--plan', PLAN, '--action', 'record-review', '--scope', 'task-1',
    '--iteration', '1', '--role', 'task-reviewer', '--defects', DEFECTS, ...actor], io);
  assert.equal(review, 1);
  assert.deepEqual(reads, [], 'stdin is never read for an autopilot receipt-bound action');
}));

test('the verify-check CLI refuses a step that is not the checks without running any command', () => withRepo(PLAN_TWO, ({ root, exists }) => {
  manualWriterAuthorized(root);
  const result = cli(root, ['--action', 'verify-check', '--scope', 'task-1', '--iteration', '1']);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, CORRECTION_GUARD_CODES.STEP_INVALID);
  assert.equal(exists(checkEvidencePath(1)), false);
}));

// --- verify-handoff -------------------------------------------------------------------------------

const AUTOPILOT = Object.freeze({ runId: 'run-1', attempt: 1 });
const ap = (input = {}) => manual({ ...AUTOPILOT, ...input });
const exec = (task, n) => `${RUN}/task-${task}-execution-${n}`;
const reportOf = (task) => `${RUN}/task-${task}-report.md`;
const reviewOf = (task) => `${RUN}/task-${task}-review.md`;
const issuesOf = (task) => `${RUN}/task-${task}-issues.md`;
const guardState = (scope, iteration) => `${RUN}/${scope}-review-guard-attempt-1-iteration-${iteration}`;
const defectsOf = (scope, iteration, role) => `${CORRECTION}/${scope}-cycle-1-iteration-${iteration}`
  + `${scope === 'final' && role === 'task-reviewer' ? '-task-reviewer' : ''}-defects.json`;
// Task 3 depends on the stopped Task 2 (blocked); in the fork plan it is independent and runs after it.
const PLAN_PARTIAL = planText(planTask(1), planTask(2), planTask(3, { complexity: 'mechanical', dependencies: '2' }));
const PLAN_FORK = planText(planTask(1), planTask(2), planTask(3));
const handoff = (root, input = {}) => verifyCorrectionHandoff(root, { planPath: PLAN, indexPath: INDEX, ...input });
const ok = (result) => { assert.equal(result.ok, true, `${result.code}: ${result.message}`); return result; };
const nextAction = (root) => nextCorrectionAction(root, manual()).next;

// Authorizes `role` for `target` in `scope` iteration `iteration` on the run's drive.
function authorizeRole(root, actor, { scope, iteration, role, target, ownerTask, affectedCriteria }) {
  return ok(authorizeCorrectionDispatch(root, { ...actor, scope, iteration, role, target,
    ...(ownerTask === undefined ? {} : { ownerTask, affectedCriteria: affectedCriteria ?? [] }) }));
}

// The autopilot writer of `scope` iteration `iteration`: execution `n` of `task`, authorized by the guard,
// begun and recorded with task-results with `work` inside it, then recorded by the guard.
function apWriter({ root, put }, { scope, iteration, task, n, role = 'implementer', status = 'DONE', previous, parent, work, ownerTask, affectedCriteria }) {
  authorizeRole(root, ap(), { scope, iteration, role: 'writer', target: exec(task, n), ownerTask, affectedCriteria });
  beginTask(root, exec(task, n), { ...AUTOPILOT, task, execution: n, role, report: reportOf(task), planPath: PLAN,
    ...(previous ? { previousState: previous } : {}), ...(parent ? { parentState: parent } : {}) });
  work?.();
  put(reportOf(task), `Report of ${task}.${n}\n`);
  recordTaskResult(root, exec(task, n), `status: ${status}\nartifact: ${reportOf(task)}\nsignals: none\n`);
  return ok(recordCorrectionWriter(root, ap({ scope, iteration, execution: exec(task, n) })));
}

async function checksOf(root, actor, scope, iteration) {
  return ok(await recordCorrectionChecks(root, { ...actor, scope, iteration }, { collectEvidence: collector().collectEvidence }));
}

// The autopilot review `state` of `scope` iteration `iteration` by `role` (already authorized for `state`),
// begun, checked with `verdict` and recorded with its defects.
function apReview({ root, put }, { scope, iteration, role, state, verdict = 'APPROVED', task, execution, ownerTask, defects = [] }) {
  const final = role === 'final-reviewer';
  const [report, issues] = final ? [FINAL_REVIEW, FINAL_ISSUES] : [reviewOf(task), issuesOf(task)];
  const guardIteration = Number(state.slice(state.lastIndexOf('-') + 1));
  beginReview(root, state, { ...AUTOPILOT, iteration: guardIteration, task: final ? 'final' : task, report, issues,
    ...(final ? { plan: PLAN, index: INDEX } : { execution }) });
  put(report, `${verdict} by the ${role} of ${scope} iteration ${iteration}\n`);
  if (verdict === 'ISSUES_FOUND') put(issues, `- the issue found in ${scope} iteration ${iteration}\n`);
  assert.equal(checkReview(root, state, `status: ${verdict}\nartifact: ${verdict === 'ISSUES_FOUND' ? issues : report}\nsignals: none\n`).status, verdict);
  const path = defectsOf(scope, iteration, role);
  put(path, defectsBody({ scope, iteration, verdict, defects }));
  const recorded = ok(recordCorrectionReview(root, ap({ scope, iteration, role, defects: path, reviewState: state,
    ...(ownerTask === undefined ? {} : { ownerTask }) })));
  assert.equal(recorded.status, verdict);
  return recorded;
}

// Task `task` approved in its own cycle by one autopilot writer (execution 1 after `parent`) and its review.
async function apApprovedTask(repo, task, parent) {
  const scope = `task-${task}`;
  ok(openCorrectionCycle(repo.root, ap({ scope })));
  ok(reserveCorrectionIteration(repo.root, ap({ scope, iteration: 1, kind: 'initial' })));
  apWriter(repo, { scope, iteration: 1, task, n: 1, parent, work: () => repo.put(`task-${task}.txt`, `task ${task} delivered\n`) });
  await checksOf(repo.root, ap(), scope, 1);
  authorizeRole(repo.root, ap(), { scope, iteration: 1, role: 'task-reviewer', target: guardState(scope, 1) });
  apReview(repo, { scope, iteration: 1, role: 'task-reviewer', state: guardState(scope, 1), task, execution: exec(task, 1) });
}

// Retries `scope` (task N or final) at iteration 2 for the issue its iteration 1 review reported.
function retryForIssue({ root, put, bytes }, actor, scope, issuesPath, target) {
  put(retryPath(1, scope), `${JSON.stringify(retryRequest({ path: issuesPath, digest: sha256(bytes(issuesPath)) }, {
    scope, kind: 'defect', target, confirmingCheck: 'review', observedFailure: `the review of ${scope} found an issue`,
    hypothesis: 'the writer skipped the regression case', remedy: 'add the regression case', difference: 'the correction adds the case',
  }))}\n`);
  ok(admitCorrectionRetry(root, { ...actor, request: retryPath(1, scope) }));
  ok(reserveCorrectionIteration(root, { ...actor, scope, iteration: 2, kind: 'correction' }));
}

// Stops `scope` unless its cycle already stopped on its own, then proves its isolation in `mode`.
function stopAndIsolate(root, actor, scope, mode) {
  if (nextAction(root).action !== 'prove-isolation') {
    ok(stopCorrectionCycle(root, { ...actor, scope, reason: 'HUMAN_INTERRUPTED', note: 'stopped by the user' }));
  }
  assert.equal(ok(proveCorrectionIsolation(root, { ...actor, scope })).mode, mode);
}

// An autopilot run through the guard. Task 1 is approved. Task 2 stops in `shape`:
//   retained      its DONE writer (a source change, passing checks) gets an ISSUES_FOUND review: retained-best;
//   blocked-leaf  as retained, then its correction writer reports BLOCKED without a change: retained-best;
//   revert        as blocked-leaf, but the BLOCKED writer restores the opening tree: baseline-equal.
// In the fork plan Task 3 then runs, its parent the retained execution or, after baseline-equal, Task 1's.
// The final review opens on the PENDING summary and records `finalVerdict` (unless `finalReview` is false);
// an ISSUES_FOUND final stops.
async function autopilotHandoff(repo, { plan = PLAN_PARTIAL, shape = 'retained', finalVerdict = 'APPROVED', beforeFinalReview, finalReview = true } = {}) {
  const { root, put } = repo;
  const fork = plan === PLAN_FORK;
  put(manifestPath(1), manifest('run-1', 1));
  ok(openCorrectionRun(root, ap({ drive: 'autopilot' })));
  await apApprovedTask(repo, '1');
  ok(openCorrectionCycle(root, ap({ scope: 'task-2' })));
  ok(reserveCorrectionIteration(root, ap({ scope: 'task-2', iteration: 1, kind: 'initial' })));
  apWriter(repo, { scope: 'task-2', iteration: 1, task: '2', n: 1, parent: exec(1, 1), work: () => put('task-2.txt', 'task 2 attempt\n') });
  await checksOf(root, ap(), 'task-2', 1);
  authorizeRole(root, ap(), { scope: 'task-2', iteration: 1, role: 'task-reviewer', target: guardState('task-2', 1) });
  apReview(repo, { scope: 'task-2', iteration: 1, role: 'task-reviewer', state: guardState('task-2', 1), verdict: 'ISSUES_FOUND',
    task: '2', execution: exec(2, 1), defects: [defectEntry({ criterion: 'SC2' })] });
  if (shape !== 'retained') {
    retryForIssue(repo, ap(), 'task-2', issuesOf('2'), 'SC2');
    apWriter(repo, { scope: 'task-2', iteration: 2, task: '2', n: 2, role: 'fix', status: 'BLOCKED', previous: exec(2, 1), parent: exec(2, 1),
      work: shape === 'revert' ? () => unlinkSync(join(root, 'task-2.txt')) : undefined });
  }
  stopAndIsolate(root, ap(), 'task-2', shape === 'revert' ? 'baseline-equal' : 'retained-best');
  if (fork) await apApprovedTask(repo, '3', shape === 'revert' ? exec(1, 1) : exec(2, 1));
  projectTaskResults(root, { indexPath: INDEX, states: fork ? [exec(1, 1), exec(3, 1)] : [exec(1, 1)] });
  ok(openCorrectionCycle(root, ap({ scope: 'final' })));
  ok(projectCorrectionSummary(root, ap({ taskResultIndex: INDEX })));
  ok(reserveCorrectionIteration(root, ap({ scope: 'final', iteration: 1, kind: 'initial' })));
  authorizeRole(root, ap(), { scope: 'final', iteration: 1, role: 'final-reviewer', target: guardState('final', 1) });
  await checksOf(root, ap(), 'final', 1);
  for (const task of fork ? ['1', '3'] : ['1']) setReviewReference(root, { indexPath: INDEX, state: guardState(`task-${task}`, 1) });
  setReviewReference(root, { indexPath: INDEX, state: guardState('final', 1) });
  await beforeFinalReview?.(repo);
  if (!finalReview) return;
  apReview(repo, { scope: 'final', iteration: 1, role: 'final-reviewer', state: guardState('final', 1), verdict: finalVerdict,
    defects: finalVerdict === 'ISSUES_FOUND' ? [defectEntry()] : [] });
  if (finalVerdict === 'ISSUES_FOUND') ok(stopCorrectionCycle(root, ap({ scope: 'final', reason: 'HUMAN_INTERRUPTED', note: 'stopped by the user' })));
  assert.equal(nextAction(root).action, 'terminal');
  ok(projectCorrectionSummary(root, ap({ taskResultIndex: INDEX })));
}

const summaryOf = (repo) => parseCorrectionSummaryBlock(repo.bytes(INDEX).toString('utf8'));

test('a partial autopilot handoff with an accepted retained execution verifies UNAPPROVED', () => withRepo(PLAN_PARTIAL, async (repo) => {
  await autopilotHandoff(repo);
  const summary = summaryOf(repo);
  assert.deepEqual([summary.outcome, summary.completed, summary.blocked], ['PARTIAL', ['1'], [{ task: '3', causes: ['2'] }]]);
  assert.equal(summary.stopped[0].execution, exec(2, 1));
  const head = readCorrectionHead(repo.root, manual()).seq;
  const verified = ok(handoff(repo.root, AUTOPILOT));
  assert.deepEqual(Object.keys(verified), ['ok', 'outcome', 'approval', 'summary']);
  assert.deepEqual([verified.outcome, verified.approval], ['PARTIAL', 'UNAPPROVED']);
  assert.deepEqual(verified.summary, summary);
  assert.equal(readCorrectionHead(repo.root, manual()).seq, head, 'verify-handoff appends no record');
}));

test('the partial lineage shapes hand off: a BLOCKED leaf, a revert to the baseline and forks around both', async () => {
  for (const [label, plan, shape, executionOf2] of [
    ['a BLOCKED leaf last', PLAN_PARTIAL, 'blocked-leaf', exec(2, 1)],
    ['A: a fork around the BLOCKED leaf', PLAN_FORK, 'blocked-leaf', exec(2, 1)],
    ['B: a revert to the baseline, nothing after', PLAN_PARTIAL, 'revert', null],
    ['C: a revert, then a fork from the pre-cycle tip', PLAN_FORK, 'revert', null],
  ]) {
    await withRepo(plan, async (repo) => {
      await autopilotHandoff(repo, { plan, shape });
      const summary = summaryOf(repo);
      assert.equal(summary.stopped[0].execution, executionOf2, label);
      assert.deepEqual(summary.completed, plan === PLAN_FORK ? ['1', '3'] : ['1'], label);
      const verified = handoff(repo.root, AUTOPILOT);
      assert.equal(verified.ok, true, `${label}: ${verified.code}: ${verified.message}`);
      assert.deepEqual([verified.outcome, verified.approval], ['PARTIAL', 'UNAPPROVED'], label);
    });
  }
});

test('a stopped final hands off UNAPPROVED from its stored ISSUES_FOUND review', () => withRepo(PLAN_PARTIAL, async (repo) => {
  await autopilotHandoff(repo, { finalVerdict: 'ISSUES_FOUND' });
  const verified = ok(handoff(repo.root, AUTOPILOT));
  assert.deepEqual([verified.outcome, verified.approval, verified.summary.final.status], ['PARTIAL', 'UNAPPROVED', 'STOPPED']);
}));

test('a complete autopilot run hands off APPROVED', () => withRepo(PLAN_ONE, async (repo) => {
  const { root, put } = repo;
  put(manifestPath(1), manifest('run-1', 1));
  ok(openCorrectionRun(root, ap({ drive: 'autopilot' })));
  await apApprovedTask(repo, '1');
  projectTaskResults(root, { indexPath: INDEX, states: [exec(1, 1)] });
  ok(openCorrectionCycle(root, ap({ scope: 'final' })));
  ok(reserveCorrectionIteration(root, ap({ scope: 'final', iteration: 1, kind: 'initial' })));
  authorizeRole(root, ap(), { scope: 'final', iteration: 1, role: 'final-reviewer', target: guardState('final', 1) });
  await checksOf(root, ap(), 'final', 1);
  setReviewReference(root, { indexPath: INDEX, state: guardState('task-1', 1) });
  setReviewReference(root, { indexPath: INDEX, state: guardState('final', 1) });
  apReview(repo, { scope: 'final', iteration: 1, role: 'final-reviewer', state: guardState('final', 1) });
  ok(projectCorrectionSummary(root, ap({ taskResultIndex: INDEX })));
  const verified = ok(handoff(root, AUTOPILOT));
  assert.deepEqual([verified.outcome, verified.approval], ['COMPLETE', 'APPROVED']);
}));

test('verify-handoff refuses a run that is not terminal, a tampered summary block and an index that does not route', () => withRepo(PLAN_PARTIAL, async (repo) => {
  const { root, put, bytes } = repo;
  let pending = null;
  await autopilotHandoff(repo, { beforeFinalReview: () => { pending = handoff(root, AUTOPILOT); } });
  assert.equal(pending.code, CORRECTION_GUARD_CODES.HANDOFF_NOT_TERMINAL, pending.message);
  const index = bytes(INDEX).toString('utf8');
  put(INDEX, index.replace('"reason": "HUMAN_INTERRUPTED"', '"reason": "EXHAUSTED"'));
  assert.equal(parseCorrectionSummaryBlock(bytes(INDEX).toString('utf8')).stopped[0].reason, 'EXHAUSTED', 'the tampered block still parses');
  const tampered = handoff(root, AUTOPILOT);
  assert.equal(tampered.code, CORRECTION_GUARD_CODES.INTEGRITY, tampered.message);
  put(INDEX, index.replace(/<!-- steepy-task-results: v2 -->[\s\S]*<!-- \/steepy-task-results -->\n/u, ''));
  const unrouted = handoff(root, AUTOPILOT);
  assert.equal(unrouted.code, CORRECTION_GUARD_CODES.HANDOFF_INVALID, unrouted.message);
  assert.match(unrouted.message, /no reviewed task entries/u);
  put(INDEX, index);
  ok(handoff(root, AUTOPILOT));
  // A drift passes through as the integrity failure it is, and no record is appended.
  const head = readCorrectionHead(root, manual()).seq;
  put('source.txt', 'drifted after the run\n');
  const drifted = handoff(root, AUTOPILOT);
  assert.deepEqual([drifted.code, drifted.message], [CORRECTION_GUARD_CODES.INTEGRITY, DRIFT]);
  assert.equal(readCorrectionHead(root, manual()).seq, head);
}));

test('verify-handoff binds the autopilot actor and the reviewer handoff', () => withRepo(PLAN_PARTIAL, async (repo) => {
  const { root, put } = repo;
  await autopilotHandoff(repo);
  assert.equal(handoff(root).code, CORRECTION_GUARD_CODES.ACTOR_INVALID);
  assert.equal(handoff(root, { runId: 'run-1', attempt: 2 }).code, CORRECTION_GUARD_CODES.ACTOR_INVALID);
  assert.equal(handoff(root, { ...AUTOPILOT, indexPath: `${RUN}/other-index.md` }).code, CORRECTION_GUARD_CODES.INPUT_INVALID);
  assert.throws(() => handoff(root, { ...AUTOPILOT, extra: true }), TypeError);
  // An approval the final review no longer binds.
  put(reviewOf('1'), 'edited after the approval\n');
  const reviewed = handoff(root, AUTOPILOT);
  assert.equal(reviewed.code, CORRECTION_GUARD_CODES.HANDOFF_INVALID, reviewed.message);
}));

test('an execution or a review gate the guard never authorized is an unauthorized dispatch (exit 3)', async () => {
  // Task 1's first execution ran outside the guard; its retry is the authorized writer.
  await withRepo(PLAN_PARTIAL, async (repo) => {
    const { root, put } = repo;
    put(manifestPath(1), manifest('run-1', 1));
    ok(openCorrectionRun(root, ap({ drive: 'autopilot' })));
    ok(openCorrectionCycle(root, ap({ scope: 'task-1' })));
    ok(reserveCorrectionIteration(root, ap({ scope: 'task-1', iteration: 1, kind: 'initial' })));
    authorizeRole(root, ap(), { scope: 'task-1', iteration: 1, role: 'writer', target: exec(1, 2) });
    beginTask(root, exec(1, 1), { ...AUTOPILOT, task: '1', execution: 1, role: 'implementer', report: reportOf('1'), planPath: PLAN });
    put(reportOf('1'), 'Blocked outside the guard.\n');
    recordTaskResult(root, exec(1, 1), `status: BLOCKED\nartifact: ${reportOf('1')}\nsignals: none\n`);
    beginTask(root, exec(1, 2), { ...AUTOPILOT, task: '1', execution: 2, role: 'retry', report: reportOf('1'), planPath: PLAN,
      previousState: exec(1, 1), parentState: exec(1, 1) });
    put('task-1.txt', 'task 1 delivered\n');
    put(reportOf('1'), 'Done after the retry.\n');
    recordTaskResult(root, exec(1, 2), `status: DONE\nartifact: ${reportOf('1')}\nsignals: none\n`);
    ok(recordCorrectionWriter(root, ap({ scope: 'task-1', iteration: 1, execution: exec(1, 2) })));
    await checksOf(root, ap(), 'task-1', 1);
    authorizeRole(root, ap(), { scope: 'task-1', iteration: 1, role: 'task-reviewer', target: guardState('task-1', 1) });
    apReview(repo, { scope: 'task-1', iteration: 1, role: 'task-reviewer', state: guardState('task-1', 1), task: '1', execution: exec(1, 2) });
    ok(openCorrectionCycle(root, ap({ scope: 'task-2' })));
    ok(reserveCorrectionIteration(root, ap({ scope: 'task-2', iteration: 1, kind: 'initial' })));
    ok(recordCorrectionInterruption(root, ap({ scope: 'task-2', iteration: 1, reason: 'the harness crashed' })));
    stopAndIsolate(root, ap(), 'task-2', 'baseline-equal');
    projectTaskResults(root, { indexPath: INDEX, states: [exec(1, 2)] });
    ok(openCorrectionCycle(root, ap({ scope: 'final' })));
    ok(projectCorrectionSummary(root, ap({ taskResultIndex: INDEX })));
    ok(reserveCorrectionIteration(root, ap({ scope: 'final', iteration: 1, kind: 'initial' })));
    authorizeRole(root, ap(), { scope: 'final', iteration: 1, role: 'final-reviewer', target: guardState('final', 1) });
    await checksOf(root, ap(), 'final', 1);
    setReviewReference(root, { indexPath: INDEX, state: guardState('task-1', 1) });
    setReviewReference(root, { indexPath: INDEX, state: guardState('final', 1) });
    apReview(repo, { scope: 'final', iteration: 1, role: 'final-reviewer', state: guardState('final', 1) });
    ok(projectCorrectionSummary(root, ap({ taskResultIndex: INDEX })));
    const refused = handoff(root, AUTOPILOT);
    assert.equal(refused.code, CORRECTION_GUARD_CODES.UNAUTHORIZED_DISPATCH, refused.message);
    assert.deepEqual(refused.identity, { execution: exec(1, 1) });
    const result = cli(root, ['--action', 'verify-handoff', '--task-result-index', INDEX, '--run-id', 'run-1', '--attempt', '1']);
    assert.equal(result.status, 3);
    assert.equal(result.json.code, CORRECTION_GUARD_CODES.UNAUTHORIZED_DISPATCH);
  });
  // The final approval the index names was reviewed outside the guard.
  await withRepo(PLAN_PARTIAL, async (repo) => {
    const { root, put } = repo;
    const outside = guardState('final', 2);
    await autopilotHandoff(repo);
    setReviewReference(root, { indexPath: INDEX, state: outside, previousState: guardState('final', 1) });
    beginReview(root, outside, { ...AUTOPILOT, iteration: 2, task: 'final', report: FINAL_REVIEW, issues: FINAL_ISSUES, plan: PLAN, index: INDEX });
    put(FINAL_REVIEW, 'approved outside the guard\n');
    assert.equal(checkReview(root, outside, `status: APPROVED\nartifact: ${FINAL_REVIEW}\nsignals: none\n`).accepted, true);
    const refused = handoff(root, AUTOPILOT);
    assert.equal(refused.code, CORRECTION_GUARD_CODES.UNAUTHORIZED_DISPATCH, refused.message);
    assert.deepEqual(refused.identity, { reviewState: outside });
  });
});

test('a final-scope fix after the task approval invalidates the stale approval at the handoff', () => withRepo(PLAN_PARTIAL, async (repo) => {
  const { root, put } = repo;
  await autopilotHandoff(repo, { finalReview: false });
  // The final review finds an issue in Task 1; the final correction fixes it from the retained lineage.
  apReview(repo, { scope: 'final', iteration: 1, role: 'final-reviewer', state: guardState('final', 1), verdict: 'ISSUES_FOUND',
    defects: [defectEntry()] });
  retryForIssue(repo, ap(), 'final', FINAL_ISSUES, 'SC1');
  apWriter(repo, { scope: 'final', iteration: 2, task: '1', n: 2, role: 'fix', previous: exec(1, 1), parent: exec(2, 1),
    ownerTask: '1', affectedCriteria: ['SC1'], work: () => put('task-1.txt', 'task 1 fixed by the final correction\n') });
  await checksOf(root, ap(), 'final', 2);
  authorizeRole(root, ap(), { scope: 'final', iteration: 2, role: 'task-reviewer', target: guardState('task-1', 2), ownerTask: '1' });
  apReview(repo, { scope: 'final', iteration: 2, role: 'task-reviewer', state: guardState('task-1', 2), task: '1', execution: exec(1, 2), ownerTask: '1' });
  projectTaskResults(root, { indexPath: INDEX, states: [exec(1, 2)] });
  setReviewReference(root, { indexPath: INDEX, state: guardState('task-1', 2), previousState: guardState('task-1', 1) });
  authorizeRole(root, ap(), { scope: 'final', iteration: 2, role: 'final-reviewer', target: guardState('final', 2) });
  setReviewReference(root, { indexPath: INDEX, state: guardState('final', 2), previousState: guardState('final', 1) });
  apReview(repo, { scope: 'final', iteration: 2, role: 'final-reviewer', state: guardState('final', 2) });
  assert.equal(nextAction(root).action, 'terminal');
  ok(projectCorrectionSummary(root, ap({ taskResultIndex: INDEX })));
  ok(handoff(root, AUTOPILOT));
  // Pointing Task 1 back at its stale approval of execution 1 no longer verifies.
  const index = repo.bytes(INDEX).toString('utf8');
  put(INDEX, index.replace(`Reviewer gate Task 1: ${guardState('task-1', 2)}`, `Reviewer gate Task 1: ${guardState('task-1', 1)}`));
  const stale = handoff(root, AUTOPILOT);
  assert.equal(stale.code, CORRECTION_GUARD_CODES.HANDOFF_INVALID, stale.message);
  // The stale review's own artifact was rewritten by the final-scope task review, so it proves nothing now.
  assert.equal(stale.message, 'the reviewer handoff does not verify: invalid approval evidence for Task 1');
}));

test('the verify-handoff CLI prints the handoff and reuses an earlier final approval only when named', () => withRepo(PLAN_PARTIAL, async (repo) => {
  const { root, put } = repo;
  await autopilotHandoff(repo);
  const args = ['--action', 'verify-handoff', '--task-result-index', INDEX];
  const verified = cli(root, [...args, '--run-id', 'run-1', '--attempt', '1']);
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual([verified.json.ok, verified.json.outcome, verified.json.approval], [true, 'PARTIAL', 'UNAPPROVED']);
  const usage = cli(root, ['--action', 'verify-handoff']);
  assert.deepEqual([usage.status, usage.json.code], [2, CORRECTION_GUARD_CODES.USAGE]);
  // A later attempt hands off the attempt-1 final approval only through --resume-final naming its state.
  put(manifestPath(2), manifest('run-2', 2));
  const later = [...args, '--run-id', 'run-2', '--attempt', '2'];
  const unnamed = cli(root, later);
  assert.deepEqual([unnamed.status, unnamed.json.code], [1, CORRECTION_GUARD_CODES.HANDOFF_INVALID]);
  const resumed = cli(root, [...later, '--resume-final', guardState('final', 1)]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.json.outcome, 'PARTIAL');
  const misnamed = cli(root, [...later, '--resume-final', guardState('final', 2)]);
  assert.deepEqual([misnamed.status, misnamed.json.code], [1, CORRECTION_GUARD_CODES.INPUT_INVALID]);
  const pendingIndex = repo.bytes(INDEX).toString('utf8').replace('"outcome": "PARTIAL"', '"outcome": "PENDING"');
  put(INDEX, pendingIndex);
  assert.equal(cli(root, [...args, '--run-id', 'run-1', '--attempt', '1']).status, 3, 'a block that is not the run summary');
}));

// The manual writer of `scope` iteration `iteration` writing `task`'s report, with `work` inside it.
function mWriter({ root, put }, { scope, iteration, task, work, ownerTask, affectedCriteria }) {
  authorizeRole(root, manual(), { scope, iteration, role: 'writer', target: reportOf(task), ownerTask, affectedCriteria });
  work?.();
  put(reportOf(task), `Report of ${scope} iteration ${iteration}\n`);
  return ok(recordCorrectionWriter(root, manual({ scope, iteration, response: writerResponse({ artifact: reportOf(task) }) })));
}

// The manual `role` review of `scope` iteration `iteration` with `verdict`, authorized here unless `authorized`.
function mReview({ root, put }, { scope, iteration, role, task, verdict = 'APPROVED', defects = [], ownerTask, authorized = false }) {
  const [report, issues] = role === 'final-reviewer' ? [FINAL_REVIEW, FINAL_ISSUES] : [reviewOf(task), issuesOf(task)];
  if (!authorized) authorizeRole(root, manual(), { scope, iteration, role, target: report, ownerTask });
  put(report, `${verdict} by the ${role} of ${scope} iteration ${iteration}\n`);
  if (verdict === 'ISSUES_FOUND') put(issues, `- the issue found in ${scope} iteration ${iteration}\n`);
  const path = defectsOf(scope, iteration, role);
  put(path, defectsBody({ scope, iteration, verdict, defects }));
  const recorded = ok(recordCorrectionReview(root, manual({ scope, iteration, role, defects: path,
    response: reviewResponse({ status: verdict, artifact: verdict === 'ISSUES_FOUND' ? issues : report }),
    ...(ownerTask === undefined ? {} : { ownerTask }) })));
  assert.equal(recorded.status, verdict);
}

async function mApprovedTask(repo, task) {
  const scope = `task-${task}`;
  ok(openCorrectionCycle(repo.root, manual({ scope })));
  ok(reserveCorrectionIteration(repo.root, manual({ scope, iteration: 1, kind: 'initial' })));
  mWriter(repo, { scope, iteration: 1, task, work: () => repo.put(`task-${task}.txt`, `task ${task} delivered\n`) });
  await checksOf(repo.root, manual(), scope, 1);
  mReview(repo, { scope, iteration: 1, role: 'task-reviewer', task });
}

const bullet = (task) => `- Task ${task}: DONE; artifact: ${reportOf(task)}; changed-paths: task-${task}.txt; signals: none\n`;

// A manual run with Task 1 approved and its final cycle open on the manual result index, whose final
// iteration 1 records the final review with `verdict`.
async function manualFinalReviewed(repo, verdict) {
  const { root, put } = repo;
  ok(openCorrectionRun(root, manual({ drive: 'manual' })));
  await mApprovedTask(repo, '1');
  ok(openCorrectionCycle(root, manual({ scope: 'final' })));
  put(INDEX, `# Results\n\n${bullet('1')}`);
  ok(projectCorrectionSummary(root, manual({ taskResultIndex: INDEX })));
  ok(reserveCorrectionIteration(root, manual({ scope: 'final', iteration: 1, kind: 'initial' })));
  authorizeRole(root, manual(), { scope: 'final', iteration: 1, role: 'final-reviewer', target: FINAL_REVIEW });
  await checksOf(root, manual(), 'final', 1);
  mReview(repo, { scope: 'final', iteration: 1, role: 'final-reviewer', verdict, authorized: true,
    defects: verdict === 'ISSUES_FOUND' ? [defectEntry()] : [] });
}

test('a partial manual handoff verifies its recorded evidence and source', () => withRepo(PLAN_PARTIAL, async (repo) => {
  const { root, put } = repo;
  ok(openCorrectionRun(root, manual({ drive: 'manual' })));
  await mApprovedTask(repo, '1');
  ok(openCorrectionCycle(root, manual({ scope: 'task-2' })));
  ok(reserveCorrectionIteration(root, manual({ scope: 'task-2', iteration: 1, kind: 'initial' })));
  mWriter(repo, { scope: 'task-2', iteration: 1, task: '2', work: () => put('task-2.txt', 'task 2 attempt\n') });
  await checksOf(root, manual(), 'task-2', 1);
  mReview(repo, { scope: 'task-2', iteration: 1, role: 'task-reviewer', task: '2', verdict: 'ISSUES_FOUND', defects: [defectEntry({ criterion: 'SC2' })] });
  stopAndIsolate(root, manual(), 'task-2', 'retained-best');
  ok(openCorrectionCycle(root, manual({ scope: 'final' })));
  put(INDEX, `# Results\n\n${bullet('1')}`);
  ok(projectCorrectionSummary(root, manual({ taskResultIndex: INDEX })));
  ok(reserveCorrectionIteration(root, manual({ scope: 'final', iteration: 1, kind: 'initial' })));
  authorizeRole(root, manual(), { scope: 'final', iteration: 1, role: 'final-reviewer', target: FINAL_REVIEW });
  await checksOf(root, manual(), 'final', 1);
  mReview(repo, { scope: 'final', iteration: 1, role: 'final-reviewer', authorized: true });
  ok(projectCorrectionSummary(root, manual({ taskResultIndex: INDEX })));
  const summary = summaryOf(repo);
  assert.deepEqual([summary.stopped[0].execution, summary.blocked], [null, [{ task: '3', causes: ['2'] }]]);
  const verified = ok(handoff(root));
  assert.deepEqual([verified.outcome, verified.approval], ['PARTIAL', 'UNAPPROVED']);
  assert.equal(handoff(root, AUTOPILOT).code, CORRECTION_GUARD_CODES.ACTOR_INVALID, 'a manual drive takes no run id or attempt');
  // A recorded evidence file edited after the run is an integrity failure.
  put(reviewOf('1'), 'edited after the approval\n');
  const tampered = cli(root, ['--action', 'verify-handoff', '--task-result-index', INDEX]);
  assert.equal(tampered.status, 3);
  assert.deepEqual([tampered.json.code, tampered.json.identity.path], [CORRECTION_GUARD_CODES.INTEGRITY, reviewOf('1')]);
}));

test('a manual final-scope correction hands off COMPLETE: the latest recording of each path governs', () => withRepo(PLAN_ONE, async (repo) => {
  const { root, put, bytes, json } = repo;
  await manualFinalReviewed(repo, 'ISSUES_FOUND');
  retryForIssue(repo, manual(), 'final', FINAL_ISSUES, 'SC1');
  mWriter(repo, { scope: 'final', iteration: 2, task: '1', ownerTask: '1', affectedCriteria: ['SC1'],
    work: () => put('task-1.txt', 'task 1 fixed by the final correction\n') });
  await checksOf(root, manual(), 'final', 2);
  mReview(repo, { scope: 'final', iteration: 2, role: 'task-reviewer', task: '1', ownerTask: '1' });
  mReview(repo, { scope: 'final', iteration: 2, role: 'final-reviewer' });
  ok(projectCorrectionSummary(root, manual({ taskResultIndex: INDEX })));
  const verified = ok(handoff(root));
  assert.deepEqual([verified.outcome, verified.approval], ['COMPLETE', 'APPROVED']);
  // Task 1's own approval recorded the report and review the final correction rewrote: superseded, not stale.
  const taskWriter = json(recordPath(5)).record;
  assert.equal(taskWriter.kind, 'WRITER_RECORDED');
  assert.notEqual(taskWriter.evidence[0].digest, sha256(bytes(reportOf('1'))));
  // The superseding recording is checked: its file edited after the fact exits 3.
  put(reportOf('1'), 'edited after the final correction\n');
  const tampered = cli(root, ['--action', 'verify-handoff', '--task-result-index', INDEX]);
  assert.equal(tampered.status, 3);
  assert.deepEqual([tampered.json.code, tampered.json.identity.path], [CORRECTION_GUARD_CODES.INTEGRITY, reportOf('1')]);
}));

test('a manual stopped final whose correction left an unchecked change is an integrity failure', () => withRepo(PLAN_ONE, async (repo) => {
  const { root, put } = repo;
  await manualFinalReviewed(repo, 'ISSUES_FOUND');
  retryForIssue(repo, manual(), 'final', FINAL_ISSUES, 'SC1');
  mWriter(repo, { scope: 'final', iteration: 2, task: '1', ownerTask: '1', affectedCriteria: ['SC1'],
    work: () => put('task-1.txt', 'an unchecked final correction\n') });
  ok(stopCorrectionCycle(root, manual({ scope: 'final', reason: 'HUMAN_INTERRUPTED', note: 'stopped before the checks' })));
  assert.equal(nextAction(root).action, 'terminal');
  ok(projectCorrectionSummary(root, manual({ taskResultIndex: INDEX })));
  assert.equal(summaryOf(repo).final.status, 'STOPPED');
  const refused = handoff(root);
  assert.equal(refused.code, CORRECTION_GUARD_CODES.INTEGRITY, refused.message);
  assert.match(refused.message, /checks observation/u);
}));
