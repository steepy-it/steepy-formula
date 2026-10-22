import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectReviewEvidence,
  RECEIPT_EXCERPT_BYTES,
} from '../scripts/capture-review-evidence.mjs';
import { MIGRATE_REFUSAL_EXIT, MIGRATE_REFUSAL_MESSAGE } from '../scripts/formula/core/markdown-hub.mjs';
import { classifyWorkPath } from '../scripts/work-paths.mjs';
import { buildSeed, PROJECT } from './helpers/graph-seed.mjs';

const FORMULA_CLI = new URL('../scripts/formula/cli.mjs', import.meta.url).pathname;
// Hermetic graph gate: the built-in `graph validate` runs against a clean in-memory seed.
const CLEAN_SEED = await buildSeed();
const RED_SEED = await buildSeed({ term: true });
const seedArgs = ({ file }) => ['--port', 'memory', '--seed', file, '--project', PROJECT];
const CLEAN_GATE_ARGS = seedArgs(CLEAN_SEED);
const RED_GATE_ARGS = seedArgs(RED_SEED);

const scriptPath = new URL('../scripts/capture-review-evidence.mjs', import.meta.url);
const EVIDENCE = '.formula/work/tasks/demo/evidence-report.md';
const GROUPS_SUPPORTED = process.platform === 'linux' || process.platform === 'darwin';

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'steepy-review-evidence-'));
  return repo;
}

function graphValidateCommand(args) {
  return [process.execPath, FORMULA_CLI, 'graph', 'validate', ...args]
    .map((part) => JSON.stringify(part))
    .join(' ');
}

function nodeCommand(source) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

test('work-path grammar admits only canonical task and loop review evidence reports', () => {
  assert.equal(classifyWorkPath(EVIDENCE).family, 'evidence');
  assert.equal(
    classifyWorkPath('.formula/work/loops/2026-09-02-demo/evidence-report.md').family,
    'evidence',
  );
  assert.equal(classifyWorkPath('.formula/work/tasks/demo/review-report.md').family, 'review-report');
  assert.equal(
    classifyWorkPath('.formula/work/loops/2026-09-02-demo/review-report.md').family,
    'review-report',
  );
  for (const path of [
    '.formula/work/tasks/demo/evidence.txt',
    '.formula/work/tasks/demo/nested/evidence-report.md',
    '.formula/work/loops/demo/other.md',
  ]) {
    assert.throws(() => classifyWorkPath(path), /work path/u, path);
  }
});

test('collector streams the complete transcript to disk and returns a bounded receipt', async () => {
  const repo = fixture();
  const payload = 'X'.repeat(120_000);
  let writeCalls = 0;
  try {
    const receipt = await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      graphGateArgs: CLEAN_GATE_ARGS,
      testCommand: nodeCommand(`process.stdout.write(${JSON.stringify(payload)})`),
      writeToFd(fd, buffer, offset, length) {
        writeCalls += 1;
        return writeSync(fd, buffer, offset, Math.min(length, 11));
      },
    });

    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.artifact, EVIDENCE);
    assert.equal(receipt.allPassed, true);
    assert.deepEqual(receipt.commands.map(({ label }) => label), ['surface-test', 'coherence-gate']);

    const testResult = receipt.commands[0];
    assert.equal(testResult.exitCode, 0);
    assert.equal(testResult.outputBytes, Buffer.byteLength(payload));
    assert.equal(testResult.outputLines, 1);
    assert.equal(
      testResult.outputSha256,
      createHash('sha256').update(payload).digest('hex'),
    );
    assert.equal(Buffer.byteLength(testResult.excerpt), RECEIPT_EXCERPT_BYTES);
    assert.equal(testResult.excerptTruncated, true);
    assert.ok(writeCalls > 10_000, 'positive short writes must be retried to completion');

    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.match(report, /^# Review evidence/mu);
    assert.ok(report.includes(payload), 'the full command output must remain durable on disk');
    assert.ok(report.includes(testResult.outputSha256), 'the report must bind the transcript to its receipt hash');
    assert.ok(
      Buffer.byteLength(JSON.stringify(receipt)) < 5_000,
      'the model-facing receipt must stay bounded independently of command output size',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('capture failure after an accepted prefix converges the group, closes once, and starts no next command', {
  timeout: 5_000,
  skip: !GROUPS_SUPPORTED,
}, async () => {
  const repo = fixture();
  const pidPath = join(repo, 'capture-descendant.pid');
  const readyPath = join(repo, 'capture-descendant.ready');
  const descendant = [
    "const fs=require('node:fs');",
    "process.on('SIGTERM',()=>{});",
    `fs.writeFileSync(${JSON.stringify(readyPath)},'ready');`,
    'setTimeout(()=>process.exit(0),1800);',
  ].join('');
  const leader = [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});`,
    `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
    'const begin=()=>{',
    `if(!fs.existsSync(${JSON.stringify(readyPath)})){setTimeout(begin,5);return;}`,
    "process.on('SIGTERM',()=>process.stdout.write(['AFTER','FAILURE','SHOULD','NOT','PERSIST'].join('_')));",
    "process.stdout.write('CAPTURE_FAILURE_MARKER-and-more-output');",
    'setTimeout(()=>process.exit(0),1800);',
    '};begin();',
  ].join('');
  let markerCalls = 0;
  let closeCalls = 0;
  const started = Date.now();
  try {
    await assert.rejects(() => collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand(leader),
      killGraceMs: 50,
      processGroupConvergenceMs: 800,
      streamSettlementMs: 800,
      writeToFd(fd, buffer, offset, length) {
        const remaining = buffer.subarray(offset, offset + length);
        if (remaining.indexOf(Buffer.from('CAPTURE_FAILURE_MARKER')) === 0) {
          markerCalls += 1;
          if (markerCalls === 2) throw new Error('injected capture write failure');
          return writeSync(fd, buffer, offset, Math.min(length, 7));
        }
        if (markerCalls === 1) {
          markerCalls += 1;
          throw new Error('injected capture write failure');
        }
        return writeSync(fd, buffer, offset, length);
      },
      closeFd(fd) {
        closeCalls += 1;
        closeSync(fd);
      },
    }), /injected capture write failure/u);

    assert.equal(closeCalls, 1);
    assert.ok(Date.now() - started < 1_200, `capture teardown took ${Date.now() - started}ms`);
    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.match(report, /CAPTURE/u);
    assert.doesNotMatch(report, /AFTER_FAILURE_SHOULD_NOT_PERSIST/u);
    const descendantPid = Number(readFileSync(pidPath, 'utf8'));
    assert.throws(() => process.kill(descendantPid, 0));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('capture failure settles cleanup without waiting for a leader that denied group signals', {
  timeout: 5_000,
  skip: !GROUPS_SUPPORTED,
}, async () => {
  const repo = fixture();
  const leader = [
    "process.on('SIGTERM',()=>{});",
    "process.stdout.write('WRITE_FAULT');",
    'setTimeout(()=>process.exit(0),3000);',
  ].join('');
  const signals = [];
  let groupPid = null;
  let closeCalls = 0;
  let collector;
  try {
    collector = collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand(leader),
      killGraceMs: 20,
      processGroupConvergenceMs: 50,
      streamSettlementMs: 50,
      writeToFd(fd, buffer, offset, length) {
        const remaining = buffer.subarray(offset, offset + length);
        if (remaining.indexOf(Buffer.from('WRITE_FAULT')) === 0) {
          throw new Error('injected write failure');
        }
        return writeSync(fd, buffer, offset, length);
      },
      processGroupSignal(pid, signal) {
        groupPid = pid;
        signals.push(signal);
        throw Object.assign(new Error('injected signal denied'), { code: 'EPERM' });
      },
      closeFd(fd) {
        closeCalls += 1;
        closeSync(fd);
      },
    });
    const outcome = await Promise.race([
      collector.then(
        (value) => ({ kind: 'fulfilled', value }),
        (error) => ({ kind: 'rejected', error }),
      ),
      new Promise((resolveTimeout) => {
        setTimeout(() => resolveTimeout({ kind: 'timeout' }), 500);
      }),
    ]);

    assert.equal(outcome.kind, 'rejected', 'collector must settle before external fixture rescue');
    assert.match(outcome.error.message, /injected write failure/u);
    assert.match(outcome.error.cleanupError?.message ?? '', /process-group convergence timed out/u);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(closeCalls, 1);
    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
  } finally {
    if (Number.isInteger(groupPid)) {
      try { process.kill(-groupPid, 'SIGKILL'); } catch { /* fixture group already exited */ }
    }
    await collector?.catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a null capture failure after an accepted prefix rejects, closes once, and starts no next command', {
  timeout: 5_000,
  skip: !GROUPS_SUPPORTED,
}, async () => {
  const repo = fixture();
  let markerWrites = 0;
  let closeCalls = 0;
  try {
    await assert.rejects(() => collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand("process.stdout.write('NULL_CAPTURE_FAILURE')"),
      writeToFd(fd, buffer, offset, length) {
        const remaining = buffer.subarray(offset, offset + length);
        if (remaining.indexOf(Buffer.from('NULL_CAPTURE_FAILURE')) === 0) {
          markerWrites += 1;
          return writeSync(fd, buffer, offset, Math.min(length, 6));
        }
        if (markerWrites === 1) {
          markerWrites += 1;
          throw null;
        }
        return writeSync(fd, buffer, offset, length);
      },
      closeFd(fd) {
        closeCalls += 1;
        closeSync(fd);
      },
    }), /capture failed with non-Error reason: null/u);

    assert.equal(markerWrites, 2);
    assert.equal(closeCalls, 1);
    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.match(report, /NULL_C/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an escaped inherited-pipe holder is outside containment but local stream teardown stays bounded', {
  timeout: 4_000,
  skip: !GROUPS_SUPPORTED,
}, async () => {
  const repo = fixture();
  const pidPath = join(repo, 'escaped-descendant.pid');
  const escaped = "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),2500);";
  const leader = [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(escaped)}],{detached:true,stdio:['ignore','inherit','inherit']});`,
    'child.unref();',
    `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
    "process.stdout.write('leader-complete');",
  ].join('');
  let closeCalls = 0;
  let escapedPid = null;
  const started = Date.now();
  try {
    await assert.rejects(() => collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand(leader),
      killGraceMs: 50,
      processGroupConvergenceMs: 300,
      streamSettlementMs: 100,
      closeFd(fd) {
        closeCalls += 1;
        closeSync(fd);
      },
    }), /stream settlement timed out/u);
    assert.equal(closeCalls, 1);
    assert.ok(Date.now() - started < 1_000, `escaped-pipe teardown took ${Date.now() - started}ms`);
    escapedPid = Number(readFileSync(pidPath, 'utf8'));
    assert.doesNotThrow(() => process.kill(escapedPid, 0));
  } finally {
    if (Number.isInteger(escapedPid)) {
      try { process.kill(-escapedPid, 'SIGKILL'); } catch { /* fixture process already exited */ }
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test('normal and nonzero leaders converge signal-ignoring inherited-pipe descendants before continuing', {
  timeout: 7_000,
  skip: !GROUPS_SUPPORTED,
}, async () => {
  for (const exitCode of [0, 7]) {
    const repo = fixture();
    const pidPath = join(repo, `capture-descendant-${exitCode}.pid`);
    const readyPath = join(repo, `capture-descendant-${exitCode}.ready`);
    const descendant = [
      "const fs=require('node:fs');",
      "process.on('SIGTERM',()=>{});",
      `fs.writeFileSync(${JSON.stringify(readyPath)},'ready');`,
      'setTimeout(()=>process.exit(0),1800);',
    ].join('');
    const leader = [
      "const fs=require('node:fs');",
      "const {spawn}=require('node:child_process');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});`,
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
      'const finish=()=>{',
      `if(!fs.existsSync(${JSON.stringify(readyPath)})){setTimeout(finish,5);return;}`,
      `process.stdout.write('leader-output',()=>process.exit(${exitCode}));`,
      '};finish();',
    ].join('');
    const started = Date.now();
    try {
      const receipt = await collectReviewEvidence({
        repoRoot: repo,
        evidencePath: EVIDENCE,
        gateCommand: nodeCommand("process.stdout.write('violations: 0')"),
        testCommand: nodeCommand(leader),
        killGraceMs: 50,
        processGroupConvergenceMs: 800,
        streamSettlementMs: 800,
      });
      assert.equal(receipt.commands[0].exitCode, exitCode);
      assert.equal(receipt.commands[1].label, 'coherence-gate');
      assert.ok(Date.now() - started < 1_200, `exit ${exitCode} took ${Date.now() - started}ms`);
      const descendantPid = Number(readFileSync(pidPath, 'utf8'));
      assert.throws(() => process.kill(descendantPid, 0), undefined, `exit ${exitCode}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('collector refuses unsupported process-group platforms before creating evidence', async () => {
  const repo = fixture();
  try {
    await assert.rejects(() => collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand("process.stdout.write('must-not-run')"),
      platform: 'aix',
    }), /unsupported platform/u);
    assert.equal(existsSync(join(repo, EVIDENCE)), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('receipt remains bounded for non-UTF-8 and JSON-escaped command output', async () => {
  const repo = fixture();
  try {
    const receipt = await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      graphGateArgs: CLEAN_GATE_ARGS,
      testCommand: nodeCommand('process.stdout.write(Buffer.alloc(120_000, 255))'),
      verifierCommand: nodeCommand('process.stdout.write(Buffer.alloc(120_000, 0))'),
    });

    assert.equal(receipt.commands[0].outputBytes, 120_000);
    assert.equal(receipt.commands[1].outputBytes, 120_000);
    assert.ok(Buffer.byteLength(receipt.commands[0].excerpt) <= RECEIPT_EXCERPT_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(receipt.commands[1].excerpt)) <= RECEIPT_EXCERPT_BYTES + 2);
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 5_000);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a red test remains collected evidence, runs the graph gate, and exits the CLI successfully', () => {
  const repo = fixture();
  try {
    const result = spawnSync(process.execPath, [
      scriptPath.pathname,
      '--repo-root', repo,
      '--evidence', EVIDENCE,
      '--test-command', nodeCommand("process.stdout.write('failure-detail'); process.exit(7)"),
      '--gate-command', graphValidateCommand(CLEAN_GATE_ARGS),
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.length < 5_000, 'stdout must contain a compact receipt, not the transcript');
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.allPassed, false);
    assert.equal(receipt.commands[0].exitCode, 7);
    assert.equal(receipt.commands[0].excerpt, 'failure-detail');
    assert.equal(receipt.commands[1].label, 'coherence-gate');
    assert.equal(receipt.commands[1].exitCode, 0);

    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.match(report, /failure-detail/u);
    assert.match(report, /Exit code: 7/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a new collection replaces stale evidence instead of merging history', async () => {
  const repo = fixture();
  try {
    await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      graphGateArgs: CLEAN_GATE_ARGS,
      testCommand: nodeCommand("process.stdout.write('first-run-only')"),
    });
    await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      graphGateArgs: CLEAN_GATE_ARGS,
      testCommand: nodeCommand("process.stdout.write('second-run-only')"),
    });

    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.doesNotMatch(report, /first-run-only/u);
    assert.match(report, /second-run-only/u);
    assert.equal((report.match(/^# Review evidence$/gmu) ?? []).length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the library refuses a migrate-state repository before any evidence write or command spawn', async () => {
  const repo = fixture();
  try {
    mkdirSync(join(repo, '.apex'));
    writeFileSync(join(repo, '.apex', '_INDEX.md'), '# Markdown Hub\n');
    await assert.rejects(() => collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: 'touch ran-surface-test',
      graphGateArgs: CLEAN_GATE_ARGS,
    }), (error) => {
      assert.equal(error.message, MIGRATE_REFUSAL_MESSAGE);
      assert.equal(error.exitCode, MIGRATE_REFUSAL_EXIT);
      return true;
    });
    assert.equal(existsSync(join(repo, 'ran-surface-test')), false, 'the test command never ran');
    assert.equal(existsSync(join(repo, EVIDENCE)), false, 'no evidence artifact was written');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('invalid CLI input fails closed before creating an evidence artifact', () => {
  const repo = fixture();
  const outside = join(repo, 'outside.md');
  try {
    const result = spawnSync(process.execPath, [
      scriptPath.pathname,
      '--repo-root', repo,
      '--evidence', '../outside.md',
      '--test-command', 'npm test',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^steepy capture-review-evidence: /u);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(outside), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI refuses an existing symlinked evidence target without changing its referent', () => {
  const repo = fixture();
  const target = join(repo, 'outside.md');
  try {
    writeFileSync(target, 'sentinel');
    const evidenceAbs = join(repo, EVIDENCE);
    const parent = evidenceAbs.slice(0, evidenceAbs.lastIndexOf('/'));
    mkdirSync(parent, { recursive: true });
    symlinkSync(target, evidenceAbs, 'file');

    const result = spawnSync(process.execPath, [
      scriptPath.pathname,
      '--repo-root', repo,
      '--evidence', EVIDENCE,
      '--test-command', 'npm test',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink target blocks/u);
    assert.equal(readFileSync(target, 'utf8'), 'sentinel');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('gateCommand replaces the built-in linter under the coherence-gate receipt label', async () => {
  const repo = fixture();
  try {
    const receipt = await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand("process.stdout.write('ok')"),
      gateCommand: nodeCommand("process.stdout.write('violations: 0'); process.stdout.write(' chain clean')"),
    });

    assert.deepEqual(
      receipt.commands.map(({ label }) => label),
      ['surface-test', 'coherence-gate'],
    );
    assert.equal(receipt.allPassed, true);
    const gate = receipt.commands[1];
    assert.equal(gate.exitCode, 0);
    assert.match(gate.excerpt, /violations: 0/u);

    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.match(report, /## coherence-gate/u);
    assert.match(report, /violations: 0 chain clean/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a red gateCommand marks the collection failed while persisting its transcript', async () => {
  const repo = fixture();
  try {
    const receipt = await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand("process.stdout.write('ok')"),
      gateCommand: nodeCommand("process.stderr.write('[CODE] broken invariant'); process.exit(3)"),
    });

    assert.equal(receipt.allPassed, false);
    const gate = receipt.commands[1];
    assert.equal(gate.label, 'coherence-gate');
    assert.equal(gate.exitCode, 3);
    assert.match(gate.excerpt, /\[CODE\] broken invariant/u);

    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.match(report, /Exit code: 3/u);
    assert.match(report, /All commands passed: false/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI --gate-command overrides the built-in graph validate invocation', () => {
  const repo = fixture();
  try {
    const result = spawnSync(process.execPath, [
      scriptPath.pathname,
      '--repo-root', repo,
      '--evidence', EVIDENCE,
      '--test-command', nodeCommand("process.stdout.write('ok')"),
      '--gate-command', nodeCommand("process.stdout.write('graph gate ran')"),
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.deepEqual(
      receipt.commands.map(({ label }) => label),
      ['surface-test', 'coherence-gate'],
    );
    assert.equal(receipt.allPassed, true);
    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.match(report, /graph gate ran/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the built-in gate is steepy-formula graph validate and a clean graph passes', async () => {
  const repo = fixture();
  try {
    const receipt = await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand("process.stdout.write('ok')"),
      graphGateArgs: CLEAN_GATE_ARGS,
    });
    assert.deepEqual(receipt.commands.map(({ label }) => label), ['surface-test', 'coherence-gate']);
    assert.equal(receipt.allPassed, true);
    assert.equal(receipt.commands[1].exitCode, 0);
    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.match(report, /Command JSON: "steepy-formula graph validate"/u);
    assert.match(report, /verdict:\s+clean/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the built-in gate on a red graph blocks reviewed-clean and records the violation code', async () => {
  const repo = fixture();
  try {
    const receipt = await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand("process.stdout.write('ok')"),
      graphGateArgs: RED_GATE_ARGS,
    });
    assert.equal(receipt.commands[0].passed, true);
    assert.equal(receipt.commands[1].label, 'coherence-gate');
    assert.equal(receipt.commands[1].exitCode, 1);
    assert.equal(receipt.allPassed, false);
    const report = readFileSync(join(repo, EVIDENCE), 'utf8');
    assert.match(report, /verdict:\s+violations/u);
    assert.match(report, /PROJECT_ROOT_MISSING/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('graphGateArgs must be an array of strings', async () => {
  const repo = fixture();
  try {
    for (const bad of ['--port memory', [1], null]) {
      await assert.rejects(() => collectReviewEvidence({
        repoRoot: repo,
        evidencePath: EVIDENCE,
        testCommand: nodeCommand("process.stdout.write('ok')"),
        graphGateArgs: bad,
      }), TypeError);
    }
    assert.equal(existsSync(join(repo, EVIDENCE)), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the CLI rejects --no-gate with the usage error and creates no evidence', () => {
  const repo = fixture();
  try {
    const result = spawnSync(process.execPath, [
      scriptPath.pathname,
      '--repo-root', repo,
      '--evidence', EVIDENCE,
      '--test-command', nodeCommand("process.stdout.write('ok')"),
      '--no-gate',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /steepy capture-review-evidence:/u);
    assert.equal(existsSync(join(repo, EVIDENCE)), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the coherence-gate capture rides the same writer and process-group convergence seams', {
  timeout: 5_000,
  skip: !GROUPS_SUPPORTED,
}, async () => {
  const repo = fixture();
  const pidPath = join(repo, 'gate-descendant.pid');
  const readyPath = join(repo, 'gate-descendant.ready');
  const descendant = [
    "const fs=require('node:fs');",
    "process.on('SIGTERM',()=>{});",
    `fs.writeFileSync(${JSON.stringify(readyPath)},'ready');`,
    'setTimeout(()=>process.exit(0),1800);',
  ].join('');
  const gateLeader = [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});`,
    `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
    'const finish=()=>{',
    `if(!fs.existsSync(${JSON.stringify(readyPath)})){setTimeout(finish,5);return;}`,
    "process.stdout.write('GRAPH_GATE_OUTPUT',()=>process.exit(0));",
    '};finish();',
  ].join('');
  let gateWrites = 0;
  let closeCalls = 0;
  const started = Date.now();
  try {
    const receipt = await collectReviewEvidence({
      repoRoot: repo,
      evidencePath: EVIDENCE,
      testCommand: nodeCommand("process.stdout.write('ok')"),
      gateCommand: nodeCommand(gateLeader),
      killGraceMs: 50,
      processGroupConvergenceMs: 800,
      streamSettlementMs: 800,
      writeToFd(fd, buffer, offset, length) {
        if (buffer.subarray(offset, offset + length).includes('GRAPH_GATE_OUTPUT')) gateWrites += 1;
        return writeSync(fd, buffer, offset, length);
      },
      closeFd(fd) {
        closeCalls += 1;
        closeSync(fd);
      },
    });
    assert.deepEqual(receipt.commands.map(({ label }) => label), ['surface-test', 'coherence-gate']);
    assert.equal(receipt.commands[1].exitCode, 0);
    assert.ok(gateWrites > 0, 'the gate transcript is written through the injected writer');
    assert.equal(closeCalls, 1);
    assert.ok(Date.now() - started < 1_500, `gate convergence took ${Date.now() - started}ms`);
    const descendantPid = Number(readFileSync(pidPath, 'utf8'));
    assert.throws(() => process.kill(descendantPid, 0), undefined, 'the gate group is converged');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
