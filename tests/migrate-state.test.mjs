// The `migrate` hub-mode state end to end: a repository that still carries a steepy-apex Markdown
// hub (`.apex/_INDEX.md`).
//
//  1. GRAPH PRIMITIVES NEVER REFUSE (G6): from a migrate-state temp repo, `hub-mode` declares
//     `migrate` (even over a seeded, initialized graph) while `graph validate`, `context resolve`
//     and `promotion preview` keep their normal exit codes — none of them prints the refusal.
//  2. WORKFLOW SCRIPTS REFUSE (G5): every row of REFUSING_SCRIPTS runs from a fresh migrate-state
//     temp repo and must exit MIGRATE_REFUSAL_EXIT (25) with `<prefix>: <MIGRATE_REFUSAL_MESSAGE>`
//     as an exact stderr line, an empty stdout, and the temp repo byte-identical — the refusal
//     comes before any stdout line or filesystem write.
//
// Hermetic (G7): `.apex/_INDEX.md` is created only inside mkdtemp dirs, never in this repository;
// the graph is seeded through `buildSeed` (tests/helpers/graph-seed.mjs), never the local-only
// dogfood checkpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATE_REFUSAL_EXIT, MIGRATE_REFUSAL_MESSAGE } from '../scripts/formula/core/markdown-hub.mjs';
import { PROJECT, buildSeed } from './helpers/graph-seed.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'scripts', 'formula', 'cli.mjs');

// The workflow scripts that refuse in the migrate state, one row each (Tasks 4–10 extend it):
//   { script: 'scripts/<name>.mjs', args: (root) => [...argv after the script path], prefix? }
// `root` is the fresh migrate-state temp repo, also the subprocess cwd. The expected stderr prefix
// defaults to the script's basename without `.mjs` (the scripts' own `<name>: …` diagnostic
// convention); `prefix` overrides it for a script whose diagnostics carry another fixed prefix.
const REFUSING_SCRIPTS = [
  // Read-only verification still refuses: the refusal fires right after parse for every mode.
  { script: 'scripts/autopilot-context.mjs', args: (root) => ['--verify-plan', '--repo-root', root, '--plan', '.apex/work/plans/topic.md'] },
  // The conductor CLI refuses before its spec checks, so no spec needs to exist.
  { script: 'scripts/autopilot.mjs', args: () => ['.apex/work/specs/topic.md'] },
  // The CLAUDE.md renderer refuses before it writes; its diagnostics carry the `steepy ` prefix.
  {
    script: 'scripts/render-claude-md.mjs',
    prefix: 'steepy render-claude-md',
    args: (root) => ['--hub', root, '--project', 'demo-project', '--upsert', '--mode', 'graph'],
  },
  // The loop controller refuses a fresh graph run before runner availability, graph resolution or
  // any loop state; its diagnostics carry the `loop controller [<CODE>]` prefix.
  {
    script: 'scripts/loop-engineer.mjs',
    prefix: 'loop controller [MIGRATE_REQUIRED]',
    args: (root) => [
      '--repo-root', root, '--goal', '.apex/work/loops/2026-10-21-topic/goal.md', '--harness', 'pi',
      '--commit-authorized', '--graph-target', 'apex:demo-project:surface:scripts',
    ],
  },
];

// --- temp fixtures -----------------------------------------------------------------------------

const tempRoots = [];

test.after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// A repository in the migrate state: it still carries the Markdown hub's navigation root.
function migrateStateRepo() {
  const root = tempDir('steepy-migrate-state-');
  mkdirSync(join(root, '.apex'));
  writeFileSync(join(root, '.apex', '_INDEX.md'), '# Markdown Hub\n');
  return root;
}

// Every path under `root` with its bytes (files) or kind (directories), for a no-write assertion.
function treeSnapshot(root) {
  const entries = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) {
        entries[path] = 'dir';
        walk(path);
      } else {
        entries[path] = readFileSync(join(root, path)).toString('base64');
      }
    }
  };
  walk('');
  return entries;
}

function runCli(args, { cwd }) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });
}

function assertNoRefusal(result) {
  assert.ok(!result.stdout.includes(MIGRATE_REFUSAL_MESSAGE), 'a graph primitive never prints the refusal (stdout)');
  assert.ok(!result.stderr.includes(MIGRATE_REFUSAL_MESSAGE), 'a graph primitive never prints the refusal (stderr)');
  assert.notEqual(result.status, MIGRATE_REFUSAL_EXIT, 'a graph primitive never exits with the refusal code');
}

// --- graph primitives keep working in the migrate state (G6) ----------------------------------------

test('migrate state: hub-mode declares migrate over a seeded, initialized graph and names graph-migrate (exit 0)', async () => {
  const { file } = await buildSeed();
  const result = runCli(['hub-mode', '--project', PROJECT, '--port', 'memory', '--seed', file], { cwd: migrateStateRepo() });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ {2}mode:\s+migrate$/m);
  assert.match(result.stdout, /initialized:\s+yes/);
  assert.match(result.stdout, /\.apex\/_INDEX\.md:\s+present/);
  assert.match(result.stdout, /^ {2}next:\s+run the `graph-migrate` skill$/m);
  assertNoRefusal(result);
});

test('migrate state: graph validate on the seeded graph still exits 0 with a clean verdict', async () => {
  const { file } = await buildSeed();
  const result = runCli(['graph', 'validate', '--project', PROJECT, '--port', 'memory', '--seed', file], { cwd: migrateStateRepo() });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /verdict:\s+clean/);
  assertNoRefusal(result);
});

test('migrate state: context resolve on the seeded graph still exits 0 and writes both artifacts', async () => {
  const { file } = await buildSeed();
  const out = tempDir('steepy-migrate-state-out-');
  const result = runCli([
    'context', 'resolve', '--project', PROJECT,
    '--path', 'packages/alpha/index.mjs',
    '--port', 'memory', '--seed', file,
    '--out', out,
  ], { cwd: migrateStateRepo() });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /schema:\s+v1/);
  assert.equal(JSON.parse(readFileSync(join(out, 'context.json'), 'utf8')).projectId, PROJECT);
  assert.match(readFileSync(join(out, 'context.md'), 'utf8'), /^# Context \(schema v1\)/);
  assertNoRefusal(result);
});

test('migrate state: promotion preview of an unknown scenario keeps its normal not-found exit (4)', () => {
  const result = runCli(['promotion', 'preview', '--project', PROJECT, '--port', 'memory', 'no-such-scenario'], { cwd: migrateStateRepo() });
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stderr, /promotion scenario 'no-such-scenario' does not exist/);
  assertNoRefusal(result);
});

// --- workflow scripts refuse in the migrate state (G5) ----------------------------------------------

for (const { script, args, prefix } of REFUSING_SCRIPTS) {
  const name = basename(script, '.mjs');
  const line = `${prefix ?? name}: ${MIGRATE_REFUSAL_MESSAGE}`;
  test(`migrate state: ${name} refuses with exit ${MIGRATE_REFUSAL_EXIT} before any stdout line or filesystem write`, () => {
    const root = migrateStateRepo();
    const before = treeSnapshot(root);
    const result = spawnSync(process.execPath, [join(repoRoot, script), ...args(root)], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, MIGRATE_REFUSAL_EXIT, result.stdout + result.stderr);
    assert.equal(result.stdout, '', 'the refusal precedes any stdout line');
    assert.ok(
      result.stderr.split('\n').includes(line),
      `stderr must carry '${prefix ?? name}: <MIGRATE_REFUSAL_MESSAGE>', got:\n${result.stderr}`,
    );
    assert.deepEqual(treeSnapshot(root), before, 'the refusal precedes any filesystem write');
  });
}
