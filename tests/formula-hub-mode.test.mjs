// Hub-mode suite (promotion-in-chain Task 3, spec D4 / plan decision 5; graph-only formula: the
// `migrate` state replaces `legacy`).
//
// Two layers, per the tests standard:
//  1. UNIT (always runs): `detectHubMode` with injected `facts`/`fs` over mkdtemp dirs — every
//     row of the precedence table (graph-active, engine-unreachable, migrate, none, and the two
//     precedence rules: a present Markdown hub decides migrate even over an initialized engine,
//     and an engine that is up but uninitialized is NOT graph), the `next` step each mode names,
//     the evidence contract (an unreachable engine always carries a reason), the
//     `portEngineFacts` seam the CLI's `--port memory` uses, and the programmer-error throws. No
//     live engine is ever probed.
//  2. CLI (always runs): `steepy-formula hub-mode` spawned as a real subprocess (prior art:
//     tests/formula-cli-context.test.mjs) in all three modes — graph through the `--port memory
//     --seed <buildSeed()>` seam (tests/helpers/graph-seed.mjs), migrate/none through temp cwd
//     dirs on the same memory seam — asserting exit 0, the mode line, exactly one evidence line,
//     and the `next:` line migrate and none print (graph prints none).
// The dogfood seed is a local-only checkpoint: the pre-existing seeded cases (graph CLI, seeded
// port) skip with the explicit DOGFOOD_CHECKPOINT_SKIP reason when it is absent; everything else,
// including the buildSeed graph case, still runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { importGraph } from '../scripts/formula/core/export.mjs';
import { detectHubMode, HUB_MODES, HUB_MODE_NEXT_STEPS, portEngineFacts } from '../scripts/formula/core/hub-mode.mjs';
import { DOGFOOD_CHECKPOINT, DOGFOOD_CHECKPOINT_SKIP } from './helpers/dogfood-checkpoint.mjs';
import { PROJECT as SEED_PROJECT, buildSeed } from './helpers/graph-seed.mjs';

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

// The migrate-mode marker (spec criterion 12): a Markdown Hub's navigation root.
function markdownHubDir() {
  const dir = tempDir('steepy-hub-mode-markdown-');
  mkdirSync(join(dir, '.apex'));
  writeFileSync(join(dir, '.apex', '_INDEX.md'), '# Markdown Hub\n');
  return dir;
}

const UNREACHABLE = () => ({ reachable: false, initialized: null, reason: 'server status: absent (docker daemon not running)' });
const LIVE_INITIALIZED = () => ({ reachable: true, initialized: true, detail: 'http://localhost:2480' });

function run(args, { cwd } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd });
}

// --- the mode vocabulary and the precedence table (injected facts/fs, mkdtemp dirs) ----------------

test('HUB_MODES is the closed three-mode vocabulary', () => {
  assert.deepEqual([...HUB_MODES], ['graph', 'migrate', 'none']);
  assert.equal(Object.isFrozen(HUB_MODES), true);
});

test('HUB_MODE_NEXT_STEPS is the frozen per-mode next step: graph-migrate, init, or nothing for graph', () => {
  assert.deepEqual({ ...HUB_MODE_NEXT_STEPS }, { graph: null, migrate: 'graph-migrate', none: 'init' });
  assert.deepEqual(Object.keys(HUB_MODE_NEXT_STEPS).sort(), [...HUB_MODES].sort(), 'one next step per mode');
  assert.equal(Object.isFrozen(HUB_MODE_NEXT_STEPS), true);
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
    next: null,
    evidence: { engine: { reachable: true, detail: 'http://localhost:2480' }, initialized: true, legacyArea: false, markdownHub: false },
  });
});

test('engine-unreachable: an unreachable engine is evidence with a reason, and an empty dir leaves none', async () => {
  const result = await detectHubMode({ projectId: 'demo', facts: UNREACHABLE, rootDir: tempDir('steepy-hub-mode-empty-') });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'none');
  assert.equal(result.next, 'init');
  assert.deepEqual(result.evidence, {
    engine: { reachable: false, reason: 'server status: absent (docker daemon not running)' },
    initialized: null,
    legacyArea: false,
    markdownHub: false,
  });
});

test('migrate: a present .apex/_INDEX.md decides migrate when the engine cannot serve the graph', async () => {
  const result = await detectHubMode({ projectId: 'demo', facts: UNREACHABLE, rootDir: markdownHubDir() });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'migrate');
  assert.equal(result.next, 'graph-migrate');
  assert.deepEqual(result.evidence, {
    engine: { reachable: false, reason: 'server status: absent (docker daemon not running)' },
    initialized: null,
    legacyArea: true,
    markdownHub: true,
  });
});

test('precedence: an engine that is up but uninitialized is NOT graph — the markdown hub decides migrate', async () => {
  const migrate = await detectHubMode({
    projectId: 'demo',
    facts: () => ({ reachable: true, initialized: false, detail: 'memory-port' }),
    rootDir: markdownHubDir(),
  });
  assert.deepEqual(migrate, {
    ok: true,
    mode: 'migrate',
    next: 'graph-migrate',
    evidence: { engine: { reachable: true, detail: 'memory-port' }, initialized: false, legacyArea: true, markdownHub: true },
  });
  // and without the markdown hub the same facts leave none — there is no fourth mode
  const none = await detectHubMode({
    projectId: 'demo',
    facts: () => ({ reachable: true, initialized: false }),
    rootDir: tempDir('steepy-hub-mode-empty-'),
  });
  assert.equal(none.mode, 'none');
  assert.equal(none.next, 'init');
  assert.equal(none.evidence.initialized, false);
});

test('precedence: a present markdown hub decides migrate even over a reachable, initialized engine', async () => {
  const result = await detectHubMode({ projectId: 'demo', facts: LIVE_INITIALIZED, rootDir: markdownHubDir() });
  assert.deepEqual(result, {
    ok: true,
    mode: 'migrate',
    next: 'graph-migrate',
    evidence: { engine: { reachable: true, detail: 'http://localhost:2480' }, initialized: true, legacyArea: true, markdownHub: true },
  });
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

test('the fs seam carries both probes: lstatSync decides the area, existsSync the hub inside it', async () => {
  const root = tempDir('steepy-hub-mode-fs-');
  const area = (present) => (path) => {
    if (present && path === join(root, '.apex')) return {};
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const hub = (path) => path === join(root, '.apex/_INDEX.md');
  const withHub = await detectHubMode({ projectId: 'demo', facts: UNREACHABLE, rootDir: root, fs: { lstatSync: area(true), existsSync: hub } });
  assert.equal(withHub.mode, 'migrate');
  assert.deepEqual([withHub.evidence.legacyArea, withHub.evidence.markdownHub], [true, true]);
  const leftover = await detectHubMode({ projectId: 'demo', facts: UNREACHABLE, rootDir: root, fs: { lstatSync: area(true), existsSync: () => false } });
  assert.equal(leftover.mode, 'migrate');
  assert.deepEqual([leftover.evidence.legacyArea, leftover.evidence.markdownHub], [true, false]);
  // the hub probe only counts inside a present area
  const absent = await detectHubMode({ projectId: 'demo', facts: UNREACHABLE, rootDir: root, fs: { lstatSync: area(false), existsSync: hub } });
  assert.equal(absent.mode, 'none');
  assert.deepEqual([absent.evidence.legacyArea, absent.evidence.markdownHub], [false, false]);
});

test('migrate: leftover local state without a Markdown hub still decides migrate, even over an initialized engine', async () => {
  const root = tempDir('steepy-hub-mode-leftover-');
  mkdirSync(join(root, '.apex', 'work', 'specs'), { recursive: true });
  const result = await detectHubMode({ projectId: 'demo', facts: LIVE_INITIALIZED, rootDir: root });
  assert.deepEqual(result, {
    ok: true,
    mode: 'migrate',
    next: 'graph-migrate',
    evidence: { engine: { reachable: true, detail: 'http://localhost:2480' }, initialized: true, legacyArea: true, markdownHub: false },
  });
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
  // An empty temp cwd: the declaration must not read the developer's own checkout.
  const result = run(['hub-mode', '--project', 'steepy-formula', '--port', 'memory', '--seed', DOGFOOD_CHECKPOINT], {
    cwd: tempDir('steepy-hub-mode-seeded-'),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /hub-mode 'steepy-formula'/);
  assert.match(result.stdout, /project:\s+steepy-formula \(flag\)/);
  assert.match(result.stdout, /mode:\s+graph/);
  assert.match(result.stdout, /initialized:\s+yes/);
});

const evidenceLines = (stdout) => stdout.match(/^ {2}evidence:/gm)?.length ?? 0;
const nextLines = (stdout) => stdout.match(/^ {2}next:/gm)?.length ?? 0;

test('CLI: hub-mode on a buildSeed graph from an empty temp root declares graph and prints no next: line', async () => {
  const { file } = await buildSeed();
  const result = run(['hub-mode', '--project', SEED_PROJECT, '--port', 'memory', '--seed', file], {
    cwd: tempDir('steepy-hub-mode-empty-'),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /mode:\s+graph$/m);
  assert.match(result.stdout, /initialized:\s+yes/);
  assert.match(result.stdout, /\.apex\/:\s+absent$/m);
  assert.equal(evidenceLines(result.stdout), 1, 'exactly one evidence: line');
  assert.equal(nextLines(result.stdout), 0, 'graph names no next step');
});

test('CLI: hub-mode from a markdown-hub temp root on the memory seam declares migrate and names graph-migrate (exit 0)', () => {
  const result = run(['hub-mode', '--project', 'hub-seam', '--port', 'memory'], { cwd: markdownHubDir() });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /hub-mode 'hub-seam'/);
  assert.match(result.stdout, /project:\s+hub-seam \(flag\)/);
  assert.match(result.stdout, /mode:\s+migrate$/m);
  assert.match(result.stdout, /initialized:\s+no/);
  assert.match(result.stdout, /\.apex\/:\s+present \(Markdown hub\)$/m);
  assert.equal(evidenceLines(result.stdout), 1, 'exactly one evidence: line');
  assert.equal(nextLines(result.stdout), 1, 'exactly one next: line');
  assert.match(result.stdout, /^ {2}next:\s+run the `graph-migrate` skill$/m);
});

test('CLI: hub-mode from an empty temp root on the memory seam declares none and names init (exit 0)', () => {
  const result = run(['hub-mode', '--project', 'hub-seam', '--port', 'memory'], { cwd: tempDir('steepy-hub-mode-empty-') });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /project:\s+hub-seam \(flag\)/);
  assert.match(result.stdout, /mode:\s+none$/m);
  assert.match(result.stdout, /initialized:\s+no/);
  assert.match(result.stdout, /\.apex\/:\s+absent$/m);
  assert.equal(evidenceLines(result.stdout), 1, 'exactly one evidence: line');
  assert.equal(nextLines(result.stdout), 1, 'exactly one next: line');
  assert.match(result.stdout, /^ {2}next:\s+run the `init` skill$/m);
});

test('CLI: hub-mode is a declaration, but usage errors still exit 2', () => {
  const result = run(['hub-mode', '--bogus']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /usage:/);
});
