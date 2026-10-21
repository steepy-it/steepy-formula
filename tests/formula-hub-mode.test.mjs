// Hub-mode suite (promotion-in-chain Task 3, spec D4 / plan decision 5).
//
// Two layers, per the tests standard:
//  1. UNIT (always runs): `detectHubMode` with injected `facts`/`fs` over mkdtemp dirs — every
//     row of the precedence table (graph-active, engine-unreachable, legacy, none, and the
//     scenario-arbitration precedence: engine up but uninitialized is NOT graph), the evidence
//     contract (an unreachable engine always carries a reason), the `portEngineFacts` seam the
//     CLI's `--port memory` uses, and the programmer-error throws. No live engine is ever probed.
//  2. CLI (always runs): `steepy-formula hub-mode` spawned as a real subprocess (prior art:
//     tests/formula-cli-context.test.mjs) in all three modes — graph through the
//     `--port memory --seed tests/fixtures/dogfood-export.jsonl` seam, legacy/none through temp
//     cwd dirs on the same memory seam (reachable-but-uninitialized, exactly the precedence
//     rule's premise) — asserting exit 0 and the mode line each time.
// The dogfood seed is a local-only checkpoint: the seeded cases (graph CLI, seeded port) skip
// with the explicit DOGFOOD_CHECKPOINT_SKIP reason when it is absent; everything else still runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { importGraph } from '../scripts/formula/core/export.mjs';
import { detectHubMode, HUB_MODES, portEngineFacts } from '../scripts/formula/core/hub-mode.mjs';
import { DOGFOOD_CHECKPOINT, DOGFOOD_CHECKPOINT_SKIP } from './helpers/dogfood-checkpoint.mjs';

const cliPath = fileURLToPath(new URL('../scripts/formula/cli.mjs', import.meta.url));

// --- temp fixtures and facts sources ---------------------------------------------------------------

const tempRoots = [];

test.after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// The legacy-mode marker (spec criterion 12): a Markdown Hub's navigation root.
function legacyHubDir() {
  const dir = tempDir('steepy-hub-mode-legacy-');
  mkdirSync(join(dir, '.apex'));
  writeFileSync(join(dir, '.apex', '_INDEX.md'), '# Legacy Markdown Hub\n');
  return dir;
}

const UNREACHABLE = () => ({ reachable: false, initialized: null, reason: 'server status: absent (docker daemon not running)' });
const LIVE_INITIALIZED = () => ({ reachable: true, initialized: true, detail: 'http://localhost:2480' });

function run(args, { cwd } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd });
}

// --- the mode vocabulary and the precedence table (injected facts/fs, mkdtemp dirs) ----------------

test('HUB_MODES is the closed three-mode vocabulary', () => {
  assert.deepEqual([...HUB_MODES], ['graph', 'legacy', 'none']);
});

test('graph-active: a reachable, initialized engine decides graph, evidence recorded', async () => {
  const result = await detectHubMode({
    projectId: 'demo',
    facts: LIVE_INITIALIZED,
    rootDir: tempDir('steepy-hub-mode-empty-'),
  });
  assert.deepEqual(result, {
    ok: true,
    mode: 'graph',
    evidence: { engine: { reachable: true, detail: 'http://localhost:2480' }, initialized: true, markdownHub: false },
  });
});

test('engine-unreachable: an unreachable engine is evidence with a reason, and an empty dir leaves none', async () => {
  const result = await detectHubMode({ projectId: 'demo', facts: UNREACHABLE, rootDir: tempDir('steepy-hub-mode-empty-') });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'none');
  assert.deepEqual(result.evidence, {
    engine: { reachable: false, reason: 'server status: absent (docker daemon not running)' },
    initialized: null,
    markdownHub: false,
  });
});

test('legacy: a present .apex/_INDEX.md decides legacy when the engine cannot serve the graph', async () => {
  const result = await detectHubMode({ projectId: 'demo', facts: UNREACHABLE, rootDir: legacyHubDir() });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'legacy');
  assert.deepEqual(result.evidence, {
    engine: { reachable: false, reason: 'server status: absent (docker daemon not running)' },
    initialized: null,
    markdownHub: true,
  });
});

test('precedence: an engine that is up but uninitialized is NOT graph — the markdown hub wins', async () => {
  const legacy = await detectHubMode({
    projectId: 'demo',
    facts: () => ({ reachable: true, initialized: false, detail: 'memory-port' }),
    rootDir: legacyHubDir(),
  });
  assert.deepEqual(legacy, {
    ok: true,
    mode: 'legacy',
    evidence: { engine: { reachable: true, detail: 'memory-port' }, initialized: false, markdownHub: true },
  });
  // and without the markdown hub the same facts leave none — there is no fourth mode
  const none = await detectHubMode({
    projectId: 'demo',
    facts: () => ({ reachable: true, initialized: false }),
    rootDir: tempDir('steepy-hub-mode-empty-'),
  });
  assert.equal(none.mode, 'none');
  assert.equal(none.evidence.initialized, false);
});

test('precedence: a reachable, initialized engine outranks a present markdown hub', async () => {
  const result = await detectHubMode({ projectId: 'demo', facts: LIVE_INITIALIZED, rootDir: legacyHubDir() });
  assert.equal(result.mode, 'graph');
  assert.equal(result.evidence.markdownHub, true);
});

// --- the evidence contract and the injection seams --------------------------------------------------

test('an unreachable engine ALWAYS carries a reason: a taciturn or throwing source is normalized', async () => {
  const taciturn = await detectHubMode({ projectId: 'demo', facts: () => ({ reachable: false }), rootDir: tempDir('steepy-hub-mode-empty-') });
  assert.equal(taciturn.evidence.engine.reason, 'unreachable (the facts source gave no reason)');

  const throwing = await detectHubMode({
    projectId: 'demo',
    facts: async () => {
      throw new Error('docker daemon not running');
    },
    rootDir: tempDir('steepy-hub-mode-empty-'),
  });
  assert.equal(throwing.ok, true, 'a throwing facts source is evidence, never a crash');
  assert.equal(throwing.mode, 'none');
  assert.equal(throwing.evidence.engine.reason, 'docker daemon not running');
  assert.equal(throwing.evidence.initialized, null);
});

test('the fs seam is the markdown-hub probe: an injected existsSync decides markdownHub', async () => {
  const root = tempDir('steepy-hub-mode-fs-');
  const result = await detectHubMode({
    projectId: 'demo',
    facts: UNREACHABLE,
    rootDir: root,
    fs: { existsSync: (path) => path === join(root, '.apex/_INDEX.md') },
  });
  assert.equal(result.mode, 'legacy');
  assert.equal(result.evidence.markdownHub, true);
});

test('portEngineFacts: the memory-port seam the CLI uses — a seeded port is initialized, an empty one is not', async (t) => {
  await t.test('a port seeded with the dogfood checkpoint is initialized and decides graph', { skip: DOGFOOD_CHECKPOINT_SKIP }, async () => {
    const seeded = createMemoryPort();
    try {
      assert.equal((await importGraph(seeded, { filePath: DOGFOOD_CHECKPOINT })).ok, true);
      assert.deepEqual(await portEngineFacts(seeded, 'steepy-formula'), { reachable: true, initialized: true });
      const detected = await detectHubMode({
        projectId: 'steepy-formula',
        facts: (id) => portEngineFacts(seeded, id),
        rootDir: tempDir('steepy-hub-mode-empty-'),
      });
      assert.equal(detected.mode, 'graph');
    } finally {
      await seeded.close();
    }
  });

  const empty = createMemoryPort();
  try {
    assert.deepEqual(await portEngineFacts(empty, 'demo'), { reachable: true, initialized: false });
  } finally {
    await empty.close();
  }
});

test('detectHubMode throws only on programmer error: mis-shaped input, facts, fs or projectId', async () => {
  await assert.rejects(() => detectHubMode('nope'), TypeError);
  await assert.rejects(() => detectHubMode({ bogus: true }), TypeError);
  await assert.rejects(() => detectHubMode({ projectId: 'Not A Project', facts: LIVE_INITIALIZED, rootDir: '.' }), TypeError);
  // SC4 (single-default authority): the core carries NO private default anymore — a missing
  // projectId is the programmer error it always was for an invalid one, never a silent 'demo'.
  await assert.rejects(() => detectHubMode({ facts: LIVE_INITIALIZED, rootDir: '.' }), /requires a valid projectId/);
  await assert.rejects(() => detectHubMode({ projectId: 'demo', facts: 'nope', rootDir: '.' }), TypeError);
  await assert.rejects(() => detectHubMode({ projectId: 'demo', facts: () => 'nope', rootDir: '.' }), TypeError);
  await assert.rejects(() => detectHubMode({ projectId: 'demo', facts: () => ({ reachable: 'yes' }), rootDir: '.' }), TypeError);
  await assert.rejects(() => detectHubMode({ projectId: 'demo', facts: () => ({ reachable: true, initialized: 'no' }), rootDir: '.' }), TypeError);
  await assert.rejects(() => detectHubMode({ projectId: 'demo', facts: LIVE_INITIALIZED, rootDir: '.', fs: {} }), TypeError);
  await assert.rejects(() => detectHubMode({ projectId: 'demo', facts: LIVE_INITIALIZED, rootDir: '' }), TypeError);
});

// --- the CLI declaration (real subprocess, hermetic memory seam) ------------------------------------

test("CLI: hub-mode on a seeded memory port declares graph (exit 0, mode line + evidence)", { skip: DOGFOOD_CHECKPOINT_SKIP }, () => {
  const result = run(['hub-mode', '--project', 'steepy-formula', '--port', 'memory', '--seed', DOGFOOD_CHECKPOINT]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /hub-mode 'steepy-formula'/);
  assert.match(result.stdout, /project:\s+steepy-formula \(flag\)/);
  assert.match(result.stdout, /mode:\s+graph/);
  assert.match(result.stdout, /initialized:\s+yes/);
});

test('CLI: hub-mode from a legacy temp root on the memory seam declares legacy (exit 0)', () => {
  const result = run(['hub-mode', '--project', 'hub-seam', '--port', 'memory'], { cwd: legacyHubDir() });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /hub-mode 'hub-seam'/);
  assert.match(result.stdout, /project:\s+hub-seam \(flag\)/);
  assert.match(result.stdout, /mode:\s+legacy/);
  assert.match(result.stdout, /initialized:\s+no/);
  assert.match(result.stdout, /\.apex\/_INDEX\.md:\s+present/);
});

test('CLI: hub-mode from an empty temp root on the memory seam declares none (exit 0)', () => {
  const result = run(['hub-mode', '--project', 'hub-seam', '--port', 'memory'], { cwd: tempDir('steepy-hub-mode-empty-') });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /project:\s+hub-seam \(flag\)/);
  assert.match(result.stdout, /mode:\s+none/);
  assert.match(result.stdout, /initialized:\s+no/);
  assert.match(result.stdout, /\.apex\/_INDEX\.md:\s+absent/);
});

test('CLI: hub-mode is a declaration, but usage errors still exit 2', () => {
  const result = run(['hub-mode', '--bogus']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /usage:/);
});
