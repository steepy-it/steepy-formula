// The `steepy-formula` CLI graph lifecycle commands (Task F2, spec §14/§15/§25).
//
// The CLI is driven as a REAL SUBPROCESS (tests standard): `spawnSync(process.execPath, [cliPath,
// ...args])`, asserting `status`/`stdout`/`stderr`. Two layers:
//
//  1. NON-DOCKER (always runs): the usage surface and the whole exit-code table (0/1/2/3/4) on the
//     documented `--port memory` test seam — a subprocess cannot share an in-memory port, so the
//     graph is handed to the process with `--seed <file>`, an export artifact (core/export.mjs)
//     imported into a fresh memory port before the command runs. The suite builds the artifacts
//     IN-PROCESS (`buildSeed`, tests/helpers/graph-seed.mjs) from real core calls (`writeTopology`,
//     `applyChangeSet`, direct port writes), so the validate verdicts (clean / blocking violations
//     / out-of-band writes) are genuinely produced by the validator and the chain replay, never by
//     a hand-built byte string.
//  2. DOCKER-GATED: `graph init` (provision + idempotent re-init) and `graph status` against a live
//     pinned ArcadeDB — the C1/E2 pattern; explicit diagnostic on docker absence, never silent.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProjectConfig, writeProjectConfig } from '../scripts/formula/core/project-config.mjs';
import { containerNameFor, destroyContainer, dockerGate } from '../scripts/formula/engine/lifecycle.mjs';
import { PROJECT, ROGUE_PACKAGE, buildSeed, makeWorkspaceRoot } from './helpers/graph-seed.mjs';

const cliPath = fileURLToPath(new URL('../scripts/formula/cli.mjs', import.meta.url));

// --- subprocess helper -------------------------------------------------------------------------

function run(args, { cwd = process.cwd(), env = {} } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

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

function addPackage(root, name) {
  mkdirSync(join(root, 'packages', name), { recursive: true });
  writeFileSync(
    join(root, 'packages', name, 'package.json'),
    `${JSON.stringify({ name: `@cli/${name}`, version: '1.0.0' }, null, 2)}\n`,
  );
}

// --- usage / exit-code table (non-docker) --------------------------------------------------------

test('usage: no arguments exits 2 with the usage on stderr and nothing on stdout', () => {
  const result = run([]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /usage:/);
  assert.doesNotMatch(result.stdout + result.stderr, /\u001b\[/, 'no ANSI/color in non-TTY output');
});

test('usage: an unknown command group exits 2', () => {
  const result = run(['context', 'resolve']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test('usage: `graph` with no subcommand exits 2', () => {
  const result = run(['graph']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test('usage: an unknown subcommand exits 2', () => {
  const result = run(['graph', 'migrate']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown subcommand/);
});

test('usage: an unknown flag exits 2', () => {
  const result = run(['graph', 'status', '--bogus']);
  assert.equal(result.status, 2);
});

test('usage: an invalid --project id exits 2', () => {
  const result = run(['graph', 'status', '--project', 'Not A Project']);
  assert.equal(result.status, 2);
});

test('usage: refresh without the required --root exits 2', () => {
  const result = run(['graph', 'refresh', '--project', PROJECT]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--root/);
});

test('usage: --seed without --port memory exits 2 (the seed seam is memory-only)', () => {
  const result = run(['graph', 'validate', '--project', PROJECT, '--seed', '/tmp/x']);
  assert.equal(result.status, 2);
});

test('usage: an unknown --port value exits 2', () => {
  const result = run(['graph', 'validate', '--port', 'neo4j']);
  assert.equal(result.status, 2);
});

test('usage: init accepts no test-seam flags', () => {
  const result = run(['graph', 'init', '--port', 'memory']);
  assert.equal(result.status, 2);
});

// --- validate verdicts (memory seam) --------------------------------------------------------------

test('validate: an empty memory port is merely invalid, never a usage error (exit 1)', () => {
  const result = run(['graph', 'validate', '--project', PROJECT, '--port', 'memory']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /verdict:\s+violations/);
  assert.match(result.stdout, /\[SCHEMA_VERSION_MISSING\]/);
});

test('validate: a clean audited graph exits 0 with a clean verdict', async () => {
  const { file } = await buildSeed();
  const result = run(['graph', 'validate', '--project', PROJECT, '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /project:\s+cli-proj \(flag\)/);
  assert.match(result.stdout, /verdict:\s+clean/);
  assert.match(result.stdout, /violations: 0/);
  assert.match(result.stdout, /warnings:\s+0/);
  assert.match(result.stdout, /chain:\s+clean/);
});

test('validate: blocking validator violations exit 1 and are printed with their code', async () => {
  const { file } = await buildSeed({ term: true });
  const result = run(['graph', 'validate', '--project', PROJECT, '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /verdict:\s+violations/);
  assert.match(result.stdout, /\[PROJECT_ROOT_MISSING\]/);
  assert.match(result.stdout, /chain:\s+clean/, 'a promoted write must not also be an out-of-band write');
});

test('validate: an out-of-band write is reported with the unexplained node and exits 1', async () => {
  const { file } = await buildSeed({ rogue: true });
  const result = run(['graph', 'validate', '--project', PROJECT, '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /verdict:\s+out-of-band-writes/);
  assert.match(result.stdout, /\[UNEXPLAINED_NODE\]/);
  assert.match(result.stdout, new RegExp(`unexplained nodes: ${ROGUE_PACKAGE}`));
  assert.match(result.stdout, /unexplained edges: \(none\)/);
  assert.match(result.stdout, /missing nodes: \(none\)/);
});

test('validate: a missing seed file is an operational failure (exit 3), never a crash', () => {
  const result = run([
    'graph', 'validate', '--project', PROJECT, '--port', 'memory',
    '--seed', join(tempDir('steepy-cli-missing-'), 'nope.json'),
  ]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /steepy-formula:/);
});

// --- status (memory seam) -------------------------------------------------------------------------

test('status: nothing initialized on the memory seam exits 4', () => {
  const result = run(['graph', 'status', '--project', PROJECT, '--port', 'memory']);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /server:\s+memory-port/);
  assert.match(result.stdout, /initialized:\s+no/);
  assert.match(result.stdout, /head:\s+none/);
});

test('status: a seeded graph reports head, counts and freshness (exit 0)', async () => {
  const { file, root } = await buildSeed();
  const result = run([
    'graph', 'status', '--project', PROJECT, '--port', 'memory', '--seed', file, '--root', root,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /server:\s+memory-port/);
  assert.match(result.stdout, /project:\s+cli-proj \(flag\)/);
  assert.match(result.stdout, /initialized:\s+yes/);
  assert.match(result.stdout, /head:\s+apex:cli-proj:revision:r1/);
  assert.match(result.stdout, /nodes:\s+\d+/);
  assert.match(result.stdout, /edges:\s+\d+/);
  assert.match(result.stdout, /scenarios:\s+n\/a/);
  assert.match(result.stdout, /staleness:\s+fresh/);
});

test('status: the same graph against a changed repository reports stale', async () => {
  const { file, root } = await buildSeed();
  addPackage(root, 'beta');
  const result = run([
    'graph', 'status', '--project', PROJECT, '--port', 'memory', '--seed', file, '--root', root,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /staleness:\s+stale/);
});

// --- refresh (memory seam) ------------------------------------------------------------------------

test('refresh: an unchanged repository reports unchanged and exits 0', async () => {
  const { file, root } = await buildSeed();
  const result = run([
    'graph', 'refresh', '--project', PROJECT, '--port', 'memory', '--seed', file, '--root', root,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /project:\s+cli-proj \(flag\)/);
  assert.match(result.stdout, /result:\s+unchanged/);
  assert.match(result.stdout, /revision:\s+-/);
  assert.match(result.stdout, /digest:\s+[0-9a-f]{64}/);
});

test('refresh: a changed repository is written as the next audited revision (exit 0)', async () => {
  const { file, root } = await buildSeed();
  addPackage(root, 'beta');
  const result = run([
    'graph', 'refresh', '--project', PROJECT, '--port', 'memory', '--seed', file, '--root', root,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /result:\s+refreshed/);
  assert.match(result.stdout, /revision:\s+apex:cli-proj:revision:r2/);
});

test('refresh: an unobservable repository is stale, preserves the last topology, and exits 3', async () => {
  const { file } = await buildSeed();
  const emptyRoot = tempDir('steepy-cli-empty-');
  writeFileSync(join(emptyRoot, 'README.md'), 'no package.json here');
  const result = run([
    'graph', 'refresh', '--project', PROJECT, '--port', 'memory', '--seed', file, '--root', emptyRoot,
  ]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /result:\s+stale/);
  assert.match(result.stdout, /detail:\s+.*preserved/);
  assert.match(result.stderr, /refresh/);
});

// --- project resolution chain (D3: --project > STEEPY_PROJECT > .formula/config.json > demo) ------

// The resolver tests drive `hub-mode` on the memory seam from controlled cwd/env boxes: it is the
// cheapest exit-0 command and its report block carries the ONE echo line every resolution prints
// (`  project: <id> (<source>)` — degradations are explicit), so the precedence chain is asserted
// through observable subprocess behavior, exactly the way the suite drives everything else.
function runResolved(args, { cwd, env: overrides = {} } = {}) {
  const env = { ...process.env };
  delete env.STEEPY_PROJECT; // hermetic: the chain's env link is exactly what the test sets
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env });
}

const countEchoes = (result) => (result.stdout + result.stderr).match(/^ {2}project:/gm)?.length ?? 0;

function configBoundRoot(projectId) {
  const root = tempDir('steepy-cli-resolve-');
  writeProjectConfig(root, projectId);
  return root;
}

test('resolution: --project beats STEEPY_PROJECT and the bound config (flag)', () => {
  const result = runResolved(['hub-mode', '--project', 'flag-proj', '--port', 'memory'], {
    cwd: configBoundRoot('cfg-proj'),
    env: { STEEPY_PROJECT: 'env-proj' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /project:\s+flag-proj \(flag\)/);
  assert.equal(countEchoes(result), 1, 'exactly one echo line per invocation');
});

test('resolution: STEEPY_PROJECT beats the bound config (env)', () => {
  const result = runResolved(['hub-mode', '--port', 'memory'], {
    cwd: configBoundRoot('cfg-proj'),
    env: { STEEPY_PROJECT: 'env-proj' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /project:\s+env-proj \(env\)/);
  assert.equal(countEchoes(result), 1, 'exactly one echo line per invocation');
});

test('resolution: <cwd>/.formula/config.json binds the project (config)', () => {
  const result = runResolved(['hub-mode', '--port', 'memory'], { cwd: configBoundRoot('cfg-proj') });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /project:\s+cfg-proj \(config\)/);
  assert.equal(countEchoes(result), 1, 'exactly one echo line per invocation');
});

test('resolution: nothing set falls back to demo (fallback)', () => {
  const result = runResolved(['hub-mode', '--port', 'memory'], { cwd: tempDir('steepy-cli-resolve-empty-') });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /project:\s+demo \(fallback\)/);
  assert.equal(countEchoes(result), 1, 'exactly one echo line per invocation');
});

test('resolution: a broken .formula/config.json is operational (exit 3) naming the exact path', () => {
  const root = tempDir('steepy-cli-resolve-bad-');
  mkdirSync(join(root, '.formula'), { recursive: true });
  writeFileSync(join(root, '.formula', 'config.json'), '{not json\n');
  const result = runResolved(['hub-mode', '--port', 'memory'], { cwd: root });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /steepy-formula:/);
  assert.match(result.stderr, /\.formula[/\\]config\.json/);
});

test('resolution: an invalid STEEPY_PROJECT id is a usage error (exit 2)', () => {
  const result = runResolved(['hub-mode', '--port', 'memory'], {
    cwd: tempDir('steepy-cli-resolve-empty-'),
    env: { STEEPY_PROJECT: 'Not A Project' },
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /STEEPY_PROJECT/);
  assert.match(result.stderr, /usage:/);
});

// --- init binding guard (hermetic: the refusal happens BEFORE any engine work) ---------------------
//
// The D5 guard refuses an explicit request (a `flag`/`env` source) that contradicts the shared
// `.formula/config.json` binding BEFORE docker provisioning, so the refusal is hermetically
// observable: exit 3, the diagnostic on stderr naming the current binding, the requested id and
// the --force instruction, an empty stdout (no engine interaction at all — the guard ran first),
// exactly one echo line, and the existing binding untouched on disk. The --force rewrite and the
// no-config write PROVISION the engine, so their coverage stays docker-gated below.
test('init guard: a --project mismatch with a bound config refuses before any engine work (exit 3)', () => {
  const root = configBoundRoot('old-proj');
  const result = runResolved(['graph', 'init', '--project', 'acme-web'], { cwd: root });
  assert.equal(result.status, 3, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.equal(result.stdout, '', 'the refusal prints no init summary');
  assert.doesNotMatch(result.stdout + result.stderr, /engine:|docker|container/i, 'no engine output — the guard refused first');
  assert.match(result.stderr, /steepy-formula:/);
  assert.match(result.stderr, /old-proj/, 'the current config value is named');
  assert.match(result.stderr, /acme-web/, 'the requested id is named');
  assert.match(result.stderr, /--force/, 'the --force instruction is given');
  assert.equal(countEchoes(result), 1, 'exactly one echo line per invocation');
  assert.deepEqual(readProjectConfig(root), { projectId: 'old-proj' }, 'the refusal wrote nothing');
});

test('init guard: a STEEPY_PROJECT mismatch refuses identically', () => {
  const root = configBoundRoot('old-proj');
  const result = runResolved(['graph', 'init'], { cwd: root, env: { STEEPY_PROJECT: 'env-proj' } });
  assert.equal(result.status, 3, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.equal(result.stdout, '', 'the refusal prints no init summary');
  assert.doesNotMatch(result.stdout + result.stderr, /engine:|docker|container/i, 'no engine output — the guard refused first');
  assert.match(result.stderr, /old-proj/);
  assert.match(result.stderr, /env-proj/);
  assert.match(result.stderr, /--force/);
  assert.equal(countEchoes(result), 1, 'exactly one echo line per invocation');
  assert.deepEqual(readProjectConfig(root), { projectId: 'old-proj' }, 'the refusal wrote nothing');
});

test('init guard: --force is an accepted init flag (an unknown flag would mask the invalid id)', () => {
  const result = runResolved(['graph', 'init', '--force', '--project', 'Not A Project'], {
    cwd: tempDir('steepy-cli-init-parse-'),
  });
  assert.equal(result.status, 2, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.match(result.stderr, /invalid --project/, 'the invalid id is the reported error, so --force parsed');
  assert.doesNotMatch(result.stderr, /Unknown option/, 'a parse-strict refusal of --force must not mask the id error');
});

// --- docker-gated: init + status against the live pinned engine -----------------------------------

const gate = dockerGate();

if (!gate.ok) {
  test(`formula CLI graph suite (docker-gated): ${gate.reason}`, (t) => {
    t.diagnostic(`SKIPPED — ${gate.reason} (pinned image arcadedata/arcadedb:26.8.1)`);
    t.skip(gate.reason);
  });
} else {
  describe('formula CLI graph lifecycle (docker-gated)', () => {
    const projectId = `cli-graph-${randomUUID().slice(0, 12).replaceAll('-', '')}`;
    const password = `pw-${randomUUID()}`;
    const name = containerNameFor(projectId);
    // The subprocess cwd for init: adoption writes `.formula/config.json` into the INVOCATION's
    // cwd, so these tests must never run against the repo itself (tests standard: never write
    // into this repo) — and a leftover repo binding would trip the mismatch guard on the next
    // run. A real workspace root keeps topology detection deterministic.
    const root = makeWorkspaceRoot();

    before(async () => {
      await destroyContainer(name, { removeVolume: true }); // a crashed earlier run leaves no trap
    });

    after(async () => {
      await destroyContainer(name, { removeVolume: true });
    });

    test('graph init provisions the local engine and prints a machine-friendly summary', () => {
      const result = run(['graph', 'init', '--project', projectId], {
        cwd: root,
        env: { STEEPY_FORMULA_DB_PASSWORD: password },
      });
      assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
      assert.match(result.stdout, /initialized graph project/);
      assert.ok(result.stdout.includes(projectId));
      assert.match(result.stdout, new RegExp(`project:\\s+${projectId} \\(flag\\)`));
      assert.match(result.stdout, /engine:\s+http:\/\/127\.0\.0\.1:\d+/);
      assert.match(result.stdout, /database:\s+apex_graph_/);
      assert.match(result.stdout, /binding:\s+written \.formula\/config\.json/);
      assert.match(result.stdout, /topology:\s+\d+ workspaces?, \d+ packages?/);
      assert.deepEqual(readProjectConfig(root), { projectId }, 'the binding was adopted on disk');
      assert.ok(
        !result.stdout.includes(password) && !result.stderr.includes(password),
        'the secret must never appear in stdout or stderr',
      );
    });

    test('re-init is idempotent: the same command succeeds again against the same server', () => {
      const result = run(['graph', 'init', '--project', projectId], {
        cwd: root,
        env: { STEEPY_FORMULA_DB_PASSWORD: password },
      });
      assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
      assert.match(result.stdout, /initialized graph project/);
      assert.match(result.stdout, /binding:\s+unchanged \(\.formula\/config\.json\)/);
    });

    test('graph init --force re-points a mismatched binding after provisioning succeeds', () => {
      writeProjectConfig(root, 'old-proj'); // now the explicit request contradicts the binding
      const result = run(['graph', 'init', '--force', '--project', projectId], {
        cwd: root,
        env: { STEEPY_FORMULA_DB_PASSWORD: password },
      });
      assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
      assert.match(
        result.stdout,
        new RegExp(`binding:\\s+rewritten old-proj -> ${projectId} \\(\\.formula/config\\.json\\)`),
      );
      assert.deepEqual(readProjectConfig(root), { projectId }, 'the binding was re-pointed on disk');
    });

    test('graph status on the live engine reports server ready, nothing initialized (exit 4)', () => {
      const result = run(['graph', 'status', '--project', projectId]);
      assert.equal(result.status, 4, result.stdout + result.stderr);
      assert.match(result.stdout, /server:\s+ready/);
      assert.match(result.stdout, /initialized:\s+no/);
      assert.match(result.stdout, /head:\s+none/);
    });
  });
}
