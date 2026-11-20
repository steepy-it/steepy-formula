// Manual/autopilot agreement for Gear-3 evidence-driven correction. One scripted partial run is driven
// twice: by hand through the correction guard library (drive manual, scripted four-field child responses,
// the injected `collectEvidence` check seam), and by the autopilot conductor through the fake harness
// (drive autopilot, mode `correction-partial`). Both must end in the same summary once observation digests
// and paths are dropped, and an integrity failure (a corrupted guard record, a source edit outside a writer
// dispatch) must halt the whole run in both drives. Hermetic: per-test temporary Git repositories, the fake
// harness only through `commandFor`, no real harness binary, no time, token or cost condition.
import { after, before, describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headlessCommand } from '../adapters/headless.mjs';
import { runConductor } from '../scripts/autopilot.mjs';
import {
  CORRECTION_GUARD_CODES,
  admitCorrectionRetry,
  authorizeCorrectionDispatch,
  openCorrectionCycle,
  openCorrectionRun,
  projectCorrectionSummary,
  proveCorrectionIsolation,
  recordCorrectionChecks,
  recordCorrectionReview,
  recordCorrectionWriter,
  reserveCorrectionIteration,
  verifyCorrectionHandoff,
  verifyCorrectionRun,
} from '../scripts/correction-guard.mjs';
import { parseCorrectionSummaryBlock } from '../scripts/correction-state.mjs';
import { fakeResolveHubContext } from './helpers/fake-hub-context.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUARD_SCRIPT = join(ROOT, 'scripts', 'correction-guard.mjs');
const STUB = join(ROOT, 'tests', 'fixtures', 'fake-harness.mjs');
const PLAN = '.formula/work/plans/topic.md';
const RUN = '.formula/work/tasks/topic';
const CORRECTION = `${RUN}/correction`;
const INDEX = `${RUN}/task-result-index.md`;
const RUN_ID = '16161616-1616-4161-8161-161616161616';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The scripted plan: Task 1 is approved at iteration 1; Task 2 fails its surface test with `# fail 2`
// twice (an admitted retry at iteration 2, then STAGNATED); Task 3 depends on Task 2 and is blocked; the
// final review approves the delivered work.
const PLAN_TEXT = `# Plan\n${[['1', 'none'], ['2', 'none'], ['3', '2']].map(([id, dependencies]) =>
  `\n## Task ${id} — task ${id}\n\n- **Surface:** \`scripts\`\n- **Test command:** \`npm test\`\n- **Complexity:** \`integration\`\n- **Dependencies:** ${dependencies}\n- **Success criteria:** SC${id}\n`).join('')}`;
const FAILURES = 2;
// Task 2's retry request, the same in both drives (the fake harness writes these exact fields), so its
// remedy is the stopped task's next remedy in both summaries.
const RETRY = Object.freeze({
  kind: 'defect',
  target: 'SC2',
  observedFailure: 'the Task 2 surface test failed 2 assertions',
  hypothesis: 'the writer left the Task 2 case unhandled',
  remedy: 'handle the Task 2 case the surface test exercises',
  difference: 'the correction handles the failing case',
  confirmingCheck: 'surface-test',
});
const FAILING_EVIDENCE = `${CORRECTION}/task-2-cycle-1-iteration-1-check-1-evidence.md`;
const AUTOPILOT_ENV = Object.freeze({
  FAKE_HARNESS_PLAN_TEXT: PLAN_TEXT,
  FAKE_HARNESS_MODE_IMPLEMENT: 'correction-partial',
  FAKE_HARNESS_MODE_REVIEW: 'correction-partial',
  FAKE_HARNESS_PARTIAL_SURFACE_FAIL: String(FAILURES),
});
const DRIFT_REASON = /source drift outside an authorized writer dispatch/u;
const noDispatch = () => { throw new Error('must not dispatch'); };

const ok = (result, label) => {
  assert.equal(result.ok, true, `${label}: ${result.code}: ${result.message}`);
  return result;
};

// The file helpers of a temporary Git repository at `root`.
function repoAt(root) {
  return {
    root,
    put(path, text) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    },
    bytes: (path) => readFileSync(join(root, path)),
  };
}

// Every temporary repository of this file: each test removes its own, and the file's `after` hook removes
// any that a failed setup left behind.
const temporary = new Set();
function removeAll(...roots) {
  for (const root of roots) {
    if (root === undefined) continue;
    rmSync(root, { recursive: true, force: true });
    temporary.delete(root);
  }
}
after(() => removeAll(...temporary));

// A temporary Git repository on `branch` whose committed baseline ignores the work area, as a governed hub.
function gitRepo(prefix, branch) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporary.add(root);
  const git = (...args) => execFileSync('git', args, { cwd: root });
  git('init', '-q', '-b', branch);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, '.gitignore'), '.formula/work/\n');
  mkdirSync(join(root, '.formula'), { recursive: true });
  writeFileSync(join(root, '.formula', '.gitkeep'), '');
  git('add', '.gitignore', '.formula');
  git('commit', '-q', '-m', 'baseline');
  return root;
}

// Runs the guard CLI in a new process: its exit code and its one JSON line.
function guardCli(root, args) {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT, '--repo-root', root, '--plan', PLAN, ...args],
    { cwd: root, encoding: 'utf8' });
  return { status: result.status, json: JSON.parse(result.stdout) };
}

// Every record of the run in order, read by its exact name up to the first absent one.
function guardRecords(root) {
  const records = [];
  for (let seq = 1; existsSync(join(root, CORRECTION, `record-${seq}.json`)); seq += 1) {
    records.push(JSON.parse(readFileSync(join(root, CORRECTION, `record-${seq}.json`), 'utf8')));
  }
  return records;
}

const summaryOf = (root) => parseCorrectionSummaryBlock(readFileSync(join(root, INDEX), 'utf8'));

// --- manual drive ---------------------------------------------------------------------------------

const manual = (input = {}) => ({ plan: PLAN, ...input });
const reportOf = (task) => `${RUN}/task-${task}-report.md`;
const reviewOf = (scope) => `${RUN}/${scope}-review.md`;
const defectsOf = (scope, iteration) => `${CORRECTION}/${scope}-cycle-1-iteration-${iteration}-defects.json`;
const fields = (values) => `${Object.entries(values).map(([key, value]) => `${key}: ${value}`).join('\n')}\n`;

// Stands in for collectReviewEvidence behind the guard's `collectEvidence` seam, as the fake harness's
// collector does: it writes the exact evidence file it is given and reports the surface test with
// `failures` failed assertions (none for a gate-only capture) and a passing coherence gate. No command runs.
function collector(failures = 0) {
  return async ({ repoRoot, evidencePath, testCommand, gateOnly = false }) => {
    writeFileSync(join(repoRoot, evidencePath), `# Synthetic check evidence\n\n${gateOnly ? 'coherence gate only'
      : `surface test: ${testCommand}`}\n# fail ${failures}\nviolations: 0\n`);
    const command = (label, failed, excerpt) => ({ label, passed: failed === 0, exitCode: failed === 0 ? 0 : 1, excerpt });
    return {
      commands: [...(gateOnly ? [] : [command('surface-test', failures, `# fail ${failures}\n`)]),
        command('coherence-gate', 0, 'violations: 0\n')],
    };
  };
}

// The manual writer of `scope` iteration `iteration`: authorized for `task`'s report, `work` runs inside its
// window, and its scripted four-field response is recorded with the report it names.
function manualWriter(repo, { scope, iteration, task, changedPaths = 'none', work = () => {} }) {
  ok(authorizeCorrectionDispatch(repo.root, manual({ scope, iteration, role: 'writer', target: reportOf(task) })),
    `authorize the ${scope} writer`);
  work();
  repo.put(reportOf(task), `Task ${task} iteration ${iteration} report.\n`);
  ok(recordCorrectionWriter(repo.root, manual({ scope, iteration, response: fields({
    status: 'DONE', artifact: reportOf(task), 'changed-paths': changedPaths, signals: 'tdd:red-green',
  }) })), `record the ${scope} writer`);
}

async function manualChecks(root, scope, iteration, failures = 0) {
  return ok(await recordCorrectionChecks(root, manual({ scope, iteration }), { collectEvidence: collector(failures) }),
    `the ${scope} checks`);
}

// The authorized manual `role` review of `scope` iteration `iteration`: an approval with an empty defects
// artifact and its scripted four-field response.
function manualApproval(repo, { scope, iteration, role }) {
  repo.put(reviewOf(scope), `Approved by the ${role}.\n`);
  repo.put(defectsOf(scope, iteration), `${JSON.stringify({
    version: 1, scope, cycle: 1, iteration, verdict: 'APPROVED', defects: [], rubric: [],
  })}\n`);
  const recorded = ok(recordCorrectionReview(repo.root, manual({ scope, iteration, role, defects: defectsOf(scope, iteration),
    response: fields({ status: 'APPROVED', artifact: reviewOf(scope), 'changed-paths': 'none', signals: 'review:clean' }) })),
  `record the ${role}`);
  assert.equal(recorded.status, 'APPROVED');
}

// The scripted run, driven by hand through the guard library up to its terminal projection.
async function manualPartialRun() {
  const repo = repoAt(gitRepo('steepy-agreement-manual-', 'gear3-topic'));
  const { root } = repo;
  repo.put(PLAN, PLAN_TEXT);
  ok(openCorrectionRun(root, manual({ drive: 'manual' })), 'open');
  // Task 1: one writer delivers it, its checks pass and its task reviewer approves it.
  ok(openCorrectionCycle(root, manual({ scope: 'task-1' })), 'open task-1');
  ok(reserveCorrectionIteration(root, manual({ scope: 'task-1', iteration: 1, kind: 'initial' })), 'reserve task-1');
  manualWriter(repo, { scope: 'task-1', iteration: 1, task: '1', changedPaths: 'task-1.txt',
    work: () => repo.put('task-1.txt', 'task 1 delivered\n') });
  await manualChecks(root, 'task-1', 1);
  ok(authorizeCorrectionDispatch(root, manual({ scope: 'task-1', iteration: 1, role: 'task-reviewer', target: reviewOf('task-1') })),
    'authorize the task-1 reviewer');
  manualApproval(repo, { scope: 'task-1', iteration: 1, role: 'task-reviewer' });
  // Task 2: its writers change no source and its surface test fails `# fail 2` twice; the admitted retry's
  // correction repeats the failure, so the cycle stagnates on its opening tree (baseline-equal).
  ok(openCorrectionCycle(root, manual({ scope: 'task-2' })), 'open task-2');
  ok(reserveCorrectionIteration(root, manual({ scope: 'task-2', iteration: 1, kind: 'initial' })), 'reserve task-2');
  manualWriter(repo, { scope: 'task-2', iteration: 1, task: '2' });
  await manualChecks(root, 'task-2', 1, FAILURES);
  const request = `${CORRECTION}/task-2-cycle-1-retry-2.json`;
  repo.put(request, `${JSON.stringify({ version: 1, scope: 'task-2', cycle: 1, iteration: 2, ...RETRY,
    evidence: { path: FAILING_EVIDENCE, digest: sha256(repo.bytes(FAILING_EVIDENCE)) } })}\n`);
  ok(admitCorrectionRetry(root, manual({ request })), 'admit the task-2 retry');
  ok(reserveCorrectionIteration(root, manual({ scope: 'task-2', iteration: 2, kind: 'correction' })), 'reserve the correction');
  manualWriter(repo, { scope: 'task-2', iteration: 2, task: '2' });
  await manualChecks(root, 'task-2', 2, FAILURES);
  assert.equal(ok(proveCorrectionIsolation(root, manual({ scope: 'task-2' })), 'prove isolation').mode, 'baseline-equal');
  // Task 3 is blocked: the final cycle opens on the PENDING summary projected into the manual index.
  ok(openCorrectionCycle(root, manual({ scope: 'final' })), 'open final');
  repo.put(INDEX, `# Results\n\n- Task 1: DONE; artifact: ${reportOf('1')}; changed-paths: task-1.txt; signals: tdd:red-green\n`);
  ok(projectCorrectionSummary(root, manual({ taskResultIndex: INDEX })), 'project the pending summary');
  ok(reserveCorrectionIteration(root, manual({ scope: 'final', iteration: 1, kind: 'initial' })), 'reserve final');
  ok(authorizeCorrectionDispatch(root, manual({ scope: 'final', iteration: 1, role: 'final-reviewer', target: reviewOf('final') })),
    'authorize the final reviewer');
  await manualChecks(root, 'final', 1);
  manualApproval(repo, { scope: 'final', iteration: 1, role: 'final-reviewer' });
  ok(projectCorrectionSummary(root, manual({ taskResultIndex: INDEX })), 'project the terminal summary');
  return repo;
}

// --- autopilot drive ------------------------------------------------------------------------------

// The fake harness in place of the real headless binary, through the conductor's `commandFor` seam.
const stubCommandFor = (harness, prompt, options) => {
  const descriptor = headlessCommand(harness, prompt, options);
  return descriptor === null ? null : {
    ...descriptor,
    cmd: process.execPath,
    args: [STUB, prompt, harness, JSON.stringify(descriptor), ...(descriptor.resolvedModel ? ['--model', descriptor.resolvedModel] : [])],
  };
};

const SPEC_TEXT = `<!-- verdict: GAP | gear: 3
drive: autopilot
branch: gear3-topic
commit-auth: per-task
harness: claude
blast-radius: branch-only, no-push, stop-before-PR
-->

# Topic spec

- **Owning surface:** \`scripts\`
- **Feature complexity:** \`design\`

## Success criteria

1. SC1 — Task 1 delivers its change.
2. SC2 — Task 2 delivers its change.
3. SC3 — Task 3 builds on Task 2.
`;

// A temporary Git repository holding the spec, plus the paths the conductor derives from it.
function makeRun() {
  const dir = gitRepo('steepy-agreement-autopilot-', 'gear3-topic');
  mkdirSync(join(dir, '.formula', 'work', 'specs'), { recursive: true });
  const specPath = join(dir, '.formula', 'work', 'specs', 'topic.md');
  writeFileSync(specPath, SPEC_TEXT);
  return { dir, specPath, statusFile: join(dir, RUN, 'autopilot-status.md') };
}

// Runs the conductor with the fixture env set and its console captured, so the suite output stays pristine.
async function drive(run, env, opts = {}) {
  const home = join(run.dir, '.formula', 'work', 'test-home');
  const vars = { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), FAKE_HARNESS_STATUS: run.statusFile, ...env };
  const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  const out = [];
  const err = [];
  const [log, error] = [console.log, console.error];
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  const sink = (lines) => ({
    on() { return this; },
    off() { return this; },
    write(chunk, callback) { lines.push(String(chunk)); callback?.(); return true; },
  });
  try {
    const code = await runConductor(run.specPath, {
      commandFor: stubCommandFor, cwd: run.dir, resolveHubContext: fakeResolveHubContext,
      opencodeConfig: { env: vars, homedir: () => home }, liveStdout: sink(out), liveStderr: sink(err), ...opts,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    [console.log, console.error] = [log, error];
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const statusOf = (run) => (existsSync(run.statusFile) ? readFileSync(run.statusFile, 'utf8') : '');
const linesWith = (text, needle) => text.split('\n').filter((line) => line.includes(needle));

// The same scripted run, driven by the autopilot conductor; `review` is the review phase's fake mode.
async function autopilotPartialRun(review = 'correction-partial') {
  const run = makeRun();
  const result = await drive(run, { ...AUTOPILOT_ENV, FAKE_HARNESS_MODE_REVIEW: review }, { runId: RUN_ID });
  return { run, result };
}

// --- agreement ------------------------------------------------------------------------------------

// A summary without its observation digests and paths: the final's approved observation, and each stopped
// task's best candidate observation, its candidate snapshot reference and its retained execution.
function normalized(summary) {
  return {
    ...summary,
    stopped: summary.stopped.map((entry) => {
      const { observation, snapshot, ...bestCandidate } = entry.bestCandidate;
      const { execution, ...rest } = entry;
      return { ...rest, bestCandidate };
    }),
    final: summary.final === null ? null : (({ approvedObservation, ...final }) => final)(summary.final),
  };
}

describe('one scripted partial run driven manually and by autopilot', () => {
  let manualRepo;
  let autopilot;

  before(async () => {
    manualRepo = await manualPartialRun();
    autopilot = await autopilotPartialRun();
  });

  after(() => removeAll(manualRepo?.root, autopilot?.run.dir));

  it('ends PARTIAL and unapproved in both drives with the same normalized summary', () => {
    assert.equal(autopilot.result.code, 3, autopilot.result.err);
    const handoff = verifyCorrectionHandoff(manualRepo.root, { planPath: PLAN, indexPath: INDEX });
    ok(handoff, 'the manual verify-handoff');
    const cli = guardCli(manualRepo.root, ['--action', 'verify-handoff', '--task-result-index', INDEX]);
    assert.equal(cli.status, 0, cli.json.message);
    const verified = ok(verifyCorrectionHandoff(autopilot.run.dir, { planPath: PLAN, indexPath: INDEX, runId: RUN_ID, attempt: 1 }),
      'the autopilot verify-handoff');
    const drives = { manual: handoff.summary, autopilot: verified.summary };
    assert.deepEqual(summaryOf(manualRepo.root), drives.manual, 'the manual index carries the verified summary');
    assert.deepEqual(summaryOf(autopilot.run.dir), drives.autopilot, 'the autopilot index carries the verified summary');
    for (const [drive, summary] of Object.entries(drives)) {
      assert.deepEqual([summary.outcome, summary.approval], ['PARTIAL', 'UNAPPROVED'], drive);
      assert.deepEqual(summary.completed, ['1'], drive);
      assert.deepEqual(summary.stopped.map(({ task, reason, iterations }) => ({ task, reason, iterations })),
        [{ task: '2', reason: 'STAGNATED', iterations: { reserved: 2, diagnosis: 0 } }], drive);
      // Task 2 stagnated on its repeated surface-test failure, not on a review defect.
      assert.deepEqual(summary.stopped[0].unresolvedDefects, ['SC2/surface-test/command-failed'], drive);
      assert.deepEqual(summary.stopped[0].comparison,
        [{ defect: 'SC2/surface-test/command-failed', previous: FAILURES, current: FAILURES, verdict: 'stagnant' }], drive);
      assert.equal(summary.stopped[0].nextRemedy, RETRY.remedy, drive);
      // Its baseline-equal isolation retains no execution on either drive.
      assert.equal(summary.stopped[0].execution, null, drive);
      assert.deepEqual(summary.blocked, [{ task: '3', causes: ['2'] }], drive);
      assert.deepEqual(summary.criteria, { SC1: 'satisfied', SC2: 'failed', SC3: 'blocked' }, drive);
      assert.equal(summary.final.status, 'APPROVED', drive);
    }
    assert.deepEqual(normalized(drives.manual), normalized(drives.autopilot));
    // Both drives took the same guarded steps.
    const kinds = (root) => guardRecords(root).map(({ record }) => `${record.kind} ${record.scope ?? ''}`.trim());
    assert.deepEqual(kinds(manualRepo.root), kinds(autopilot.run.dir));
  });

  it('keeps every guard record and both summaries free of any deadline, timeout, token or cost key', () => {
    const forbidden = /deadline|time-?out|token|cost/iu;
    const named = [];
    const walk = (value, at) => {
      if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${at}[${index}]`));
      else if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          if (forbidden.test(key)) named.push(`${at}.${key}`);
          walk(item, `${at}.${key}`);
        }
      }
    };
    for (const [drive, root] of [['manual', manualRepo.root], ['autopilot', autopilot.run.dir]]) {
      const records = guardRecords(root);
      assert.ok(records.length > 20, `${drive} recorded its run`);
      records.forEach((envelope, index) => walk(envelope, `${drive} record-${index + 1}`));
      walk(summaryOf(root), `${drive} summary`);
    }
    assert.deepEqual(named, []);
  });
});

test('the correction state and guard modules import neither the cost report nor autopilot observability', () => {
  const specifiers = (path) => [...readFileSync(join(ROOT, path), 'utf8')
    .matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/gu)].map((match) => match[1]);
  const guard = specifiers('scripts/correction-guard.mjs');
  assert.ok(guard.includes('./correction-state.mjs'), 'the import scan reads the guard imports');
  for (const [path, imports] of [['scripts/correction-state.mjs', specifiers('scripts/correction-state.mjs')], ['scripts/correction-guard.mjs', guard]]) {
    const observing = imports.filter((specifier) => /(?:^|\/)(?:cost-report|autopilot-observability)\.mjs$/u.test(specifier));
    assert.deepEqual(observing, [], `${path} imports ${observing.join(', ')}`);
  }
});

// --- integrity ------------------------------------------------------------------------------------

// Rewrites record-<seq> in place as another canonical envelope, one digit of its observation changed: it
// still parses, but the next record's `previous` link no longer matches. Returns the restore.
function corruptRecord(root, seq) {
  const path = join(root, CORRECTION, `record-${seq}.json`);
  const original = readFileSync(path);
  const envelope = JSON.parse(original.toString('utf8'));
  assert.equal(envelope.record.kind, 'CYCLE_OPENED');
  const { observation } = envelope.record;
  envelope.record.observation = `${observation.slice(0, -1)}${observation.endsWith('0') ? '1' : '0'}`;
  writeFileSync(path, `${JSON.stringify(envelope)}\n`);
  return () => writeFileSync(path, original);
}
const BROKEN_CHAIN = /record-3\.json previous digest does not match record-2/u;

// An autopilot run of the scripted plan whose implementation ended PHASE_PARTIAL and whose review child
// crashed, so a restart is pending at the review phase.
async function reviewPendingRun() {
  const { run, result } = await autopilotPartialRun('fail');
  assert.equal(result.code, 1, result.err);
  const status = statusOf(run);
  assert.match(status, / — CONDUCTOR — PHASE_PARTIAL — [^\n]*phase=implement attempt=1 child-event=PARTIAL\n/u);
  assert.match(linesWith(status, ' — HALTED — ')[0], /phase=review attempt=1: child exited 1/u);
  return { run, status };
}

// The restarts of that run that check the guard before anything is reserved or spawned: the review resume,
// which re-verifies the partial handoff, and the startup check of an implement attempt whose conductor
// stopped between the child's exit and GUARD_CHECKED.
const restarts = (status) => ({
  'the review resume': status,
  'the implement startup check': status.slice(0, status.indexOf('\n', status.indexOf(' — implement — PARTIAL — ')) + 1),
});

// Restarts the run from each restart status: each halts on `reason`, reserving and spawning nothing and
// appending no guard record.
async function assertRestartsHalt(run, status, reason) {
  const records = readdirSync(join(run.dir, CORRECTION)).filter((name) => name.startsWith('record-')).length;
  for (const [label, text] of Object.entries(restarts(status))) {
    writeFileSync(run.statusFile, text);
    const result = await drive(run, AUTOPILOT_ENV, { commandFor: noDispatch });
    assert.equal(result.code, 1, `${label}: ${result.err}`);
    const appended = statusOf(run).slice(text.length);
    const halted = linesWith(appended, ' — HALTED — ');
    assert.equal(halted.length, 1, `${label}:\n${appended}`);
    assert.match(halted[0], reason, label);
    for (const event of ['ATTEMPT_RESERVED', 'SPAWNED', 'GUARD_HEAD', 'GUARD_CHECKED', 'PHASE_ACCEPTED', 'PHASE_PARTIAL']) {
      assert.equal(linesWith(appended, ` — ${event} — `).length, 0, `${label}: ${event}`);
    }
    assert.equal(readdirSync(join(run.dir, CORRECTION)).filter((name) => name.startsWith('record-')).length, records, label);
  }
  writeFileSync(run.statusFile, status);
}

// Once the integrity failure is undone, the review resume completes the partial run.
async function assertCleanResumeCompletes(run) {
  const resumed = await drive(run, AUTOPILOT_ENV);
  assert.equal(resumed.code, 3, resumed.err);
  assert.match(statusOf(run), / — CONDUCTOR — PHASE_PARTIAL — [^\n]*phase=review attempt=2 child-event=PARTIAL_REVIEWED\n/u);
}

describe('integrity failures halt the whole run in both drives', () => {
  it('a corrupted guard record: manual verify reports INTEGRITY (CLI exit 3) and the conductor restart halts', async () => {
    const repo = await manualPartialRun();
    const { run, status } = await reviewPendingRun();
    try {
      const restoreManual = corruptRecord(repo.root, 2);
      const verified = verifyCorrectionRun(repo.root, manual());
      assert.equal(verified.code, CORRECTION_GUARD_CODES.INTEGRITY, verified.message);
      assert.match(verified.message, BROKEN_CHAIN);
      const cli = guardCli(repo.root, ['--action', 'verify']);
      assert.deepEqual([cli.status, cli.json.code], [3, CORRECTION_GUARD_CODES.INTEGRITY]);
      // Nothing carries on: the projection appends no record and the handoff is refused (exit 3).
      const records = guardRecords(repo.root).length;
      assert.equal(projectCorrectionSummary(repo.root, manual({ taskResultIndex: INDEX })).code, CORRECTION_GUARD_CODES.INTEGRITY);
      assert.equal(guardRecords(repo.root).length, records, 'the corrupted run appends no record');
      assert.equal(guardCli(repo.root, ['--action', 'verify-handoff', '--task-result-index', INDEX]).status, 3);
      restoreManual();
      ok(verifyCorrectionRun(repo.root, manual()), 'the restored manual run');

      const restoreAutopilot = corruptRecord(run.dir, 2);
      await assertRestartsHalt(run, status, BROKEN_CHAIN);
      restoreAutopilot();
      await assertCleanResumeCompletes(run);
    } finally {
      removeAll(repo.root, run.dir);
    }
  });

  it('a source edit outside a writer dispatch halts both drives before the review', async () => {
    const repo = await manualPartialRun();
    const { run, status } = await reviewPendingRun();
    try {
      // The manual drive's handoff projection halts the run (RUN_HALTED), and every later action refuses it.
      const before = guardRecords(repo.root).length;
      repo.put('drifted.txt', 'edited outside any writer dispatch\n');
      const projected = projectCorrectionSummary(repo.root, manual({ taskResultIndex: INDEX }));
      assert.equal(projected.code, CORRECTION_GUARD_CODES.INTEGRITY, projected.message);
      assert.match(projected.message, DRIFT_REASON);
      const halt = guardRecords(repo.root);
      assert.equal(halt.length, before + 1);
      assert.equal(halt.at(-1).record.kind, 'RUN_HALTED');
      assert.match(halt.at(-1).record.reason, DRIFT_REASON);
      assert.equal(verifyCorrectionRun(repo.root, manual()).code, CORRECTION_GUARD_CODES.RUN_HALTED);
      for (const args of [['--action', 'verify'], ['--action', 'verify-handoff', '--task-result-index', INDEX]]) {
        const cli = guardCli(repo.root, args);
        assert.deepEqual([cli.status, cli.json.code], [3, CORRECTION_GUARD_CODES.RUN_HALTED], args.join(' '));
      }
      assert.equal(projectCorrectionSummary(repo.root, manual({ taskResultIndex: INDEX })).code, CORRECTION_GUARD_CODES.RUN_HALTED);
      assert.equal(guardRecords(repo.root).length, before + 1, 'a halted run appends nothing more');

      writeFileSync(join(run.dir, 'drifted.txt'), 'edited outside any writer dispatch\n');
      await assertRestartsHalt(run, status, DRIFT_REASON);
      rmSync(join(run.dir, 'drifted.txt'));
      await assertCleanResumeCompletes(run);
    } finally {
      removeAll(repo.root, run.dir);
    }
  });
});
