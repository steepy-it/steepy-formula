// The project-identity binding END-TO-END suite (plan 2026-08-20-project-identity-binding Task 7,
// success criterion SC2): every command group — graph, context, promotion, hub-mode — resolves its
// project id from the PERSISTED `<cwd>/.formula/config.json` binding (D3's third link) inside a
// real subprocess and echoes exactly one `  project: <id> (config)` line, plus the bare-repo tail
// `demo (fallback)`. The precedence-chain unit half (flag > env > config > fallback, the broken
// config refusal) lives in tests/formula-cli-graph.test.mjs; this suite proves the persisted
// binding actually drives whole commands end to end.
//
// Hermetic by construction (tests standard): a fresh `mkdtempSync` cwd per case carrying a real
// `.formula/config.json` (written through the core's own `writeProjectConfig`), `STEEPY_PROJECT`
// explicitly deleted from the spawned env, and the documented `--port memory`/`--seed` test seam —
// no docker, no engine container (these commands run without one). The seed artifact is the
// local-only dogfood checkpoint (tests/fixtures/dogfood-export.jsonl, project 'steepy-formula',
// gated B4-clean + chain-clean by tests/dogfood-hub.test.mjs), so `graph validate` and
// `context resolve` run against a genuinely valid graph; each case's config binds that same id.
// Without the checkpoint (a fresh clone, CI) those two seeded cases skip with the explicit
// DOGFOOD_CHECKPOINT_SKIP reason; the seedless cases always run.
// The CLI is driven as a real subprocess (`spawnSync(process.execPath, [cliPath, ...args],
// { cwd, env })` — prior art tests/formula-cli-graph.test.mjs:36), asserting observable behavior
// only: exit codes, stdout/stderr, and the artifacts a command writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeProjectConfig } from '../scripts/formula/core/project-config.mjs';
import { DOGFOOD_CHECKPOINT, DOGFOOD_CHECKPOINT_SKIP } from './helpers/dogfood-checkpoint.mjs';

const cliPath = fileURLToPath(new URL('../scripts/formula/cli.mjs', import.meta.url));
const PROJECT = 'steepy-formula'; // the dogfood checkpoint's project id — the binding binds it

// --- hermetic fixtures -----------------------------------------------------------------------------

const tempRoots = [];

test.after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// A fresh cwd carrying a real persisted binding for PROJECT (the third link of the D3 chain).
function configBoundRoot() {
  const root = tempDir('steepy-e2e-bind-');
  writeProjectConfig(root, PROJECT);
  return root;
}

// Real-subprocess invocation with the resolution chain's env link explicitly removed, so the
// config file in `cwd` is the highest active link.
function runResolvedFromDisk(args, { cwd } = {}) {
  const env = { ...process.env };
  delete env.STEEPY_PROJECT; // hermetic: the chain's env link is exactly what the test sets (nothing)
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env });
}

// The one-echo contract: exactly one `  project: <id> (<source>)` line per invocation, wherever it
// rides (the stdout report block, or stderr when stdout must stay machine-clean / the command
// failed before printing a block).
const countEchoes = (result) => (result.stdout + result.stderr).match(/^ {2}project:/gm)?.length ?? 0;

// --- every command group resolves from the persisted binding (SC2) --------------------------------

test('graph validate resolves from the persisted binding and echoes (config) in its stdout block', { skip: DOGFOOD_CHECKPOINT_SKIP }, () => {
  const result = runResolvedFromDisk(['graph', 'validate', '--port', 'memory', '--seed', DOGFOOD_CHECKPOINT], {
    cwd: configBoundRoot(),
  });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /graph validate 'steepy-formula'/);
  assert.match(result.stdout, /project:\s+steepy-formula \(config\)/);
  assert.match(result.stdout, /verdict:\s+clean/, 'the seeded dogfood checkpoint validates clean');
  assert.equal(countEchoes(result), 1, 'exactly one echo line per invocation');
});

test('context resolve resolves from the persisted binding and echoes (config) in its stdout summary', { skip: DOGFOOD_CHECKPOINT_SKIP }, () => {
  const out = tempDir('steepy-e2e-resolve-out-');
  const result = runResolvedFromDisk(
    ['context', 'resolve', '--path', '.', '--port', 'memory', '--seed', DOGFOOD_CHECKPOINT, '--out', out],
    { cwd: configBoundRoot() },
  );
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /context resolve 'steepy-formula'/);
  assert.match(result.stdout, /project:\s+steepy-formula \(config\)/);
  assert.equal(countEchoes(result), 1, 'exactly one echo line per invocation');
  // The resolved id drives the operation, not just the echo: both artifacts land in --out carrying it.
  assert.ok(existsSync(join(out, 'context.json')), 'context.json is written to --out');
  assert.ok(existsSync(join(out, 'context.md')), 'context.md is written to --out');
  const json = JSON.parse(readFileSync(join(out, 'context.json'), 'utf8'));
  assert.equal(json.projectId, PROJECT);
});

test('promotion preview of an unknown scenario still resolves from the persisted binding (echo on stderr, exit 4)', () => {
  const result = runResolvedFromDisk(['promotion', 'preview', 'no-such-scenario', '--port', 'memory'], {
    cwd: configBoundRoot(),
  });
  // Exit-table row 4: an unknown promotion scenario is NOT_FOUND — the task brief allows exit 4.
  assert.equal(result.status, 4, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  // preview keeps stdout machine-clean, so the echo rides stderr BEFORE the failure diagnostic.
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /project:\s+steepy-formula \(config\)/);
  assert.match(result.stderr, /does not exist/);
  assert.equal(countEchoes(result), 1, 'exactly one echo line per invocation');
});

test('hub-mode resolves from the persisted binding and echoes (config) in its stdout block', () => {
  const result = runResolvedFromDisk(['hub-mode', '--port', 'memory'], { cwd: configBoundRoot() });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /hub-mode 'steepy-formula'/);
  assert.match(result.stdout, /project:\s+steepy-formula \(config\)/);
  assert.match(result.stdout, /mode:\s+/);
  assert.equal(countEchoes(result), 1, 'exactly one echo line per invocation');
});

// --- the chain's tail: a bare repository never silently falls back ---------------------------------

test('an empty cwd with no env resolves the fallback and echoes demo (fallback)', () => {
  const result = runResolvedFromDisk(['hub-mode', '--port', 'memory'], { cwd: tempDir('steepy-e2e-empty-') });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /project:\s+demo \(fallback\)/);
  assert.equal(countEchoes(result), 1, 'exactly one echo line per invocation');
});
