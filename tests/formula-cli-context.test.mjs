// The `steepy-formula` CLI context + promotion commands (Task F3, spec §9/§11/§14/§25).
//
// The CLI is driven as a REAL SUBPROCESS (tests standard): `spawnSync(process.execPath, [cliPath,
// ...args], { input, env })`, asserting `status`/`stdout`/`stderr`. Two layers:
//
//  1. NON-DOCKER (always runs): the `context resolve` happy path + EVERY failure-table exit code
//     (0/1/2/3/10/11/12) on the documented `--port memory` test seam, plus the promotion
//     commands' scenario-less boundary behavior (declined-without-confirmation → 21, unknown
//     scenario → 4, idempotent discard → 0). Seed artifacts are built IN-PROCESS from real core
//     calls (`writeTopology`, `applyChangeSet`) and each seeded graph is asserted B4-clean, so the
//     resolve verdicts are genuinely produced by D3/D2, never by a hand-built byte string.
//  2. DOCKER-GATED: the whole preview→confirm→apply→discard flow against the live pinned ArcadeDB
//     engine (scenario created in-process via real `createScenario` against the same database the
//     CLI subprocesses open), plus `context resolve` against the live engine — the C1/E2 pattern;
//     explicit diagnostic on docker absence, never silent.
//
// The memory seam CANNOT carry a promotion scenario: the export artifact deliberately excludes the
// `scenario` namespace (spec §11 — scenarios are disposable proposals, never stable state), and
// `importGraph` has no scenarioId passthrough. The whole flow therefore lives on the docker path
// (the plan's "memory-or-docker path"); the memory seam pins the scenario-less exit-code surface.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { withTransaction } from '../scripts/formula/engine/port.mjs';
import { buildExportArtifact } from '../scripts/formula/core/export.mjs';
import { applyChangeSet, readChain, sha256Hex } from '../scripts/formula/core/revision.mjs';
import { detectTopology, writeTopology } from '../scripts/formula/core/topology.mjs';
import { validateGraph } from '../scripts/formula/core/validate-graph.mjs';
import { createScenario, applyPromotion } from '../scripts/formula/core/promotion.mjs';
import { createArcadeDbPort, createDatabase, databaseNameFor } from '../scripts/formula/engine/arcadedb.mjs';
import { ARCADEDB_IMAGE, containerNameFor, destroyContainer, dockerGate, startServer } from '../scripts/formula/engine/lifecycle.mjs';

const cliPath = fileURLToPath(new URL('../scripts/formula/cli.mjs', import.meta.url));
const PROJECT = 'cli-ctx';

function qid(projectId, localId) {
  return `apex:${projectId}:${localId}`;
}

// --- subprocess helper -------------------------------------------------------------------------

function run(args, { input, env = {} } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    input,
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

function makeWorkspaceRoot() {
  const root = tempDir('steepy-cli-ctx-root-');
  mkdirSync(join(root, 'packages', 'engine'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'ctx-root', private: true, workspaces: ['packages/*'] }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, 'packages', 'engine', 'package.json'),
    `${JSON.stringify({ name: '@ctx/engine', version: '1.0.0' }, null, 2)}\n`,
  );
  return root;
}

function addPackage(root, name) {
  mkdirSync(join(root, 'packages', name), { recursive: true });
  writeFileSync(
    join(root, 'packages', name, 'package.json'),
    `${JSON.stringify({ name: `@ctx/${name}`, version: '1.0.0' }, null, 2)}\n`,
  );
}

const META = {
  projectId: PROJECT,
  proposer: { type: 'agent-proposer', id: 'scripts-agent' },
  approver: { type: 'human-approver', id: 'steepy-it' },
  provenance: [{ quotation: 'CLI context suite fixture.', source: 'tests/formula-cli-context.test.mjs:1', digest: sha256Hex('fixture') }],
};

function addNode(type, id, properties = {}) {
  return { op: 'ADD', target: 'node', namespace: 'curated', type, id, properties: { id, status: 'active', ...properties } };
}

function addTopologyNode(type, id, properties = {}) {
  return { op: 'ADD', target: 'node', namespace: 'topology', type, id, properties: { id, ...properties } };
}

function addEdge(type, fromId, toId) {
  return { op: 'ADD', target: 'edge', namespace: 'curated', type, fromId, toId };
}

function addTopologyEdge(type, fromId, toId) {
  return { op: 'ADD', target: 'edge', namespace: 'topology', type, fromId, toId };
}

function ruleOp(id, concern, overrides = {}) {
  return addNode('Rule', id, {
    title: `Rule ${id}`,
    statement: 'A normative statement.',
    strength: 'must',
    category: 'engineering',
    concern,
    provenance: { source: 'spec', line: 52 },
    ...overrides,
  });
}

// A B4-clean, resolvable graph: topology written by real D1 detection (Package 'engine' at
// packages/engine) plus the curated skeleton D2/D5 prove clean — Project/Surface/Component/Agent/
// Check/Rule/Term/Decision with the §8 chain wired through IMPLEMENTS. `conflict` plants a
// same-concern Rule pair at two hierarchy levels (a shape B4 passes but D2's gate flags).
function curatedOps(projectId, { conflict = false } = {}) {
  const ID = {
    project: qid(projectId, 'project:root'),
    surface: qid(projectId, 'surface:scripts'),
    component: qid(projectId, 'component:engine'),
    agent: qid(projectId, 'agent:scripts-agent'),
    check: qid(projectId, 'check:surface-test'),
    rule: qid(projectId, 'rule:sanitize-external-input'),
    rulePackage: qid(projectId, 'rule:package-manifest'),
    term: qid(projectId, 'term:surface'),
    decision: qid(projectId, 'decision:graph-db-is-canonical'),
    package: qid(projectId, 'package:ctx-engine'),
    namingSurface: qid(projectId, 'rule:naming-surface'),
    namingEngine: qid(projectId, 'rule:naming-engine'),
  };
  const ops = [
    addNode('Project', ID.project),
    addNode('Surface', ID.surface),
    addNode('Component', ID.component),
    addNode('Agent', ID.agent),
    addNode('Check', ID.check),
    addNode('Term', ID.term),
    addNode('Decision', ID.decision),
    ruleOp(ID.rule, 'external-input'),
    ruleOp(ID.rulePackage, 'package-scope'),
    addEdge('PART_OF', ID.surface, ID.project),
    addEdge('PART_OF', ID.component, ID.surface),
    addEdge('OWNED_BY', ID.surface, ID.agent),
    addEdge('APPLIES_TO', ID.rule, ID.surface),
    addEdge('VERIFIED_BY', ID.rule, ID.check),
    addEdge('MOTIVATED_BY', ID.rule, ID.decision),
    addEdge('USED_BY', ID.term, ID.rule),
    addEdge('APPLIES_TO', ID.rulePackage, ID.package),
    addTopologyEdge('IMPLEMENTS', ID.package, ID.component),
  ];
  if (conflict) {
    ops.push(
      ruleOp(ID.namingSurface, 'naming'),
      ruleOp(ID.namingEngine, 'naming'),
      addEdge('APPLIES_TO', ID.namingSurface, ID.surface),
      addEdge('APPLIES_TO', ID.namingEngine, ID.component),
    );
  }
  return ops;
}

// Seeds a memory port with the topology (from a real temp workspace) + curated ops and asserts the
// result is B4-clean, then returns the export artifact on disk (the `--seed` seam) plus the root.
async function buildSeed({ projectId = PROJECT, conflict = false } = {}) {
  const port = createMemoryPort();
  const root = makeWorkspaceRoot();
  try {
    const detection = await detectTopology(root);
    const written = await writeTopology(port, detection, { projectId });
    assert.equal(written.ok, true, `topology write failed: ${written.message}`);
    const applied = await applyChangeSet(port, { operations: curatedOps(projectId, { conflict }) }, { ...META, projectId });
    assert.equal(applied.ok, true, applied.violations.map((v) => v.message).join('; '));
    const validation = await validateGraph(port, { projectId });
    assert.deepEqual(validation.violations, [], `the seed must be B4-clean: ${validation.violations.map((v) => v.message).join('; ')}`);
    const artifact = await buildExportArtifact(port, { projectId });
    const file = join(tempDir('steepy-cli-context-seed-'), 'seed.json');
    writeFileSync(file, artifact.text);
    return { file, root };
  } finally {
    await port.close();
  }
}

// --- usage (non-docker) ------------------------------------------------------------------------

test('usage: `context resolve` without any --path or --target exits 2', () => {
  const result = run(['context', 'resolve', '--project', PROJECT]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /usage:/);
  assert.match(result.stderr, /--path/);
});

test('usage: an unknown context subcommand exits 2', () => {
  const result = run(['context', 'list']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /unknown subcommand/);
});

test('usage: an unknown promotion subcommand exits 2', () => {
  const result = run(['promotion', 'clone']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /unknown subcommand/);
});

test('usage: `promotion preview` without a scenarioId positional exits 2', () => {
  const result = run(['promotion', 'preview', '--project', PROJECT]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /scenarioId/);
});

test('usage: a non-integer --budget exits 2', async () => {
  const { file } = await buildSeed();
  const result = run(['context', 'resolve', '--project', PROJECT, '--path', 'packages/engine/src/a.mjs', '--port', 'memory', '--seed', file, '--budget', 'huge']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /budget/);
});

// --- context resolve: happy path + every error code (memory seam) -------------------------------

test('resolve: a seeded graph emits context.json (schemaVersion first) + context.md, exit 0', async () => {
  const { file } = await buildSeed();
  const out = tempDir('steepy-cli-out-');
  const result = run([
    'context', 'resolve', '--project', PROJECT,
    '--path', 'packages/engine/src/a.mjs',
    '--port', 'memory', '--seed', file,
    '--out', out,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /context resolve 'cli-ctx'/);
  assert.match(result.stdout, /project:\s+cli-ctx \(flag\)/);
  assert.match(result.stdout, /schema:\s+v1/);
  assert.match(result.stdout, /files:/);

  const json = JSON.parse(readFileSync(join(out, 'context.json'), 'utf8'));
  assert.deepEqual(Object.keys(json)[0], 'schemaVersion', 'schemaVersion must be the first key');
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.projectId, PROJECT);
  assert.equal(json.layer0.topology.outcome, 'not-performed');
  const ruleIds = json.layer1.rules.map((r) => r.id);
  assert.ok(ruleIds.includes(qid(PROJECT, 'rule:sanitize-external-input')), 'the surface rule must be Layer 1 (must)');
  assert.ok(ruleIds.includes(qid(PROJECT, 'rule:package-manifest')), 'the package rule must be Layer 1 (must)');
  assert.ok(json.layer1.checks.some((c) => c.id === qid(PROJECT, 'check:surface-test')));
  assert.ok(json.layer2.terms.some((t) => t.id === qid(PROJECT, 'term:surface')));
  assert.deepEqual(json.layer3.decisions, [], 'decisions are Layer 3 and excluded without --include-rationale');

  const md = readFileSync(join(out, 'context.md'), 'utf8');
  assert.match(md, /^# Context \(schema v1\)/);
  assert.match(md, /## Layer 1 — mandatory/);
  assert.match(md, /## Layer 2 — guidance/);
  assert.match(md, /## Layer 3 — explanation/);
});

test('resolve: --target seeds a resolution and --include-rationale keeps the decision', async () => {
  const { file } = await buildSeed();
  const out = tempDir('steepy-cli-out-');
  const result = run([
    'context', 'resolve', '--project', PROJECT,
    '--target', qid(PROJECT, 'surface:scripts'),
    '--include-rationale',
    '--port', 'memory', '--seed', file,
    '--out', out,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const json = JSON.parse(readFileSync(join(out, 'context.json'), 'utf8'));
  const decisionIds = json.layer3.decisions.map((d) => d.id);
  assert.ok(decisionIds.includes(qid(PROJECT, 'decision:graph-db-is-canonical')), '--include-rationale keeps Layer 3 decisions');
  const md = readFileSync(join(out, 'context.md'), 'utf8');
  assert.match(md, new RegExp(qid(PROJECT, 'decision:graph-db-is-canonical').replaceAll(':', '\\:')));
});

test('resolve: --out - emits both artifacts to stdout, exit 0', async () => {
  const { file } = await buildSeed();
  const result = run([
    'context', 'resolve', '--project', PROJECT,
    '--path', 'packages/engine/src/a.mjs',
    '--port', 'memory', '--seed', file,
    '--out', '-',
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^=== context\.json ===\n\{/);
  assert.match(result.stdout, /^=== context\.md ===\n# Context \(schema v1\)/m);
  // the echo rides stderr in `--out -` mode — stdout stays machine-clean
  assert.match(result.stderr, /project:\s+cli-ctx \(flag\)/);
  assert.doesNotMatch(result.stdout, /^ {2}project:/m);
});

test('resolve: --root runs the §25 digest check; an unchanged repository resolves fresh', async () => {
  const { file, root } = await buildSeed();
  const out = tempDir('steepy-cli-out-');
  const result = run([
    'context', 'resolve', '--project', PROJECT,
    '--path', 'packages/engine/src/a.mjs',
    '--root', root,
    '--port', 'memory', '--seed', file,
    '--out', out,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const json = JSON.parse(readFileSync(join(out, 'context.json'), 'utf8'));
  assert.equal(json.layer0.topology.outcome, 'unchanged', 'the recorded digest matches the repo, so the refresh is a no-op');
});

test('resolve: a newly observed package is refreshed into the answer (topology refreshed, exit 0)', async () => {
  const { file, root } = await buildSeed();
  addPackage(root, 'beta');
  const out = tempDir('steepy-cli-out-');
  const result = run([
    'context', 'resolve', '--project', PROJECT,
    '--path', 'packages/beta/src/x.mjs',
    '--root', root,
    '--port', 'memory', '--seed', file,
    '--out', out,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const json = JSON.parse(readFileSync(join(out, 'context.json'), 'utf8'));
  assert.equal(json.layer0.topology.outcome, 'refreshed', 'the new package was detected and written before resolving');
});

test('resolve: an unresolvable path exits 10 with candidates + reasons on stderr', async () => {
  const { file } = await buildSeed();
  const result = run([
    'context', 'resolve', '--project', PROJECT,
    '--path', '/etc/passwd',
    '--port', 'memory', '--seed', file,
    '--out', tempDir('steepy-cli-out-'),
  ]);
  assert.equal(result.status, 10, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  // the invocation failed before printing a block — the echo still prints, on stderr
  assert.match(result.stderr, /project:\s+cli-ctx \(flag\)/);
  assert.match(result.stderr, /unresolved path '\/etc\/passwd': path-not-repo-relative/);
});

test('resolve: an unknown target exits 10 with same-kind candidates + reasons on stderr', async () => {
  const { file } = await buildSeed();
  const result = run([
    'context', 'resolve', '--project', PROJECT,
    '--target', qid(PROJECT, 'rule:ghost'),
    '--port', 'memory', '--seed', file,
    '--out', tempDir('steepy-cli-out-'),
  ]);
  assert.equal(result.status, 10, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unresolved target 'apex:cli-ctx:rule:ghost': unknown-target/);
  assert.match(result.stderr, /candidate:/);
});

test('resolve: applicable rules in conflict exit 11 with the Rule IDs on stderr', async () => {
  const { file } = await buildSeed({ conflict: true });
  const result = run([
    'context', 'resolve', '--project', PROJECT,
    '--path', 'packages/engine/src/a.mjs',
    '--port', 'memory', '--seed', file,
    '--out', tempDir('steepy-cli-out-'),
  ]);
  assert.equal(result.status, 11, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /RULE_CONFLICT/);
  assert.match(result.stderr, new RegExp(qid(PROJECT, 'rule:naming-engine').replaceAll(':', '\\:')));
  assert.match(result.stderr, new RegExp(qid(PROJECT, 'rule:naming-surface').replaceAll(':', '\\:')));
  assert.match(result.stderr, /naming/);
});

test('resolve: mandatory context over the budget exits 12 with measured/budget on stderr', async () => {
  const { file } = await buildSeed();
  const result = run([
    'context', 'resolve', '--project', PROJECT,
    '--path', 'packages/engine/src/a.mjs',
    '--budget', '1',
    '--port', 'memory', '--seed', file,
    '--out', tempDir('steepy-cli-out-'),
  ]);
  assert.equal(result.status, 12, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /CONTEXT_OVERFLOW/);
  assert.match(result.stderr, /1-character budget/);
});

test('resolve: a graph breaking a blocking invariant exits 1 (GRAPH_INVALID) with the violations on stderr', () => {
  const result = run([
    'context', 'resolve', '--project', PROJECT,
    '--path', 'packages/engine/src/a.mjs',
    '--port', 'memory',
    '--out', tempDir('steepy-cli-out-'),
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /\[SCHEMA_VERSION_MISSING\]/);
});

test('resolve: a missing seed artifact is an operational failure (exit 3), never a crash', () => {
  const result = run([
    'context', 'resolve', '--project', PROJECT,
    '--path', 'packages/engine/src/a.mjs',
    '--port', 'memory',
    '--seed', join(tempDir('steepy-cli-missing-'), 'nope.json'),
    '--out', tempDir('steepy-cli-out-'),
  ]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /steepy-formula:/);
});

// --- promotion: the scenario-less exit-code surface (memory seam) --------------------------------

// The memory seam cannot carry a scenario (spec §11: the export deliberately excludes the
// `scenario` namespace), so these pin the boundary/error codes; the whole flow is docker-gated.

test('promotion apply refuses without confirmation: stdin n exits 21 and the refusal is visible', async () => {
  const { file } = await buildSeed();
  const result = run(
    ['promotion', 'apply', '--project', PROJECT, 'does-not-exist', '--port', 'memory', '--seed', file],
    { input: 'n\n' },
  );
  assert.equal(result.status, 21, result.stdout + result.stderr);
  assert.match(result.stdout, /declined/, 'the refusal must be visible on stdout, never a silent no-op');
  assert.match(result.stdout, /project:\s+cli-ctx \(flag\)/);
  assert.match(result.stderr, /declined/);
});

test('promotion apply refuses on EOF with no answer (exit 21)', async () => {
  const { file } = await buildSeed();
  const result = run(['promotion', 'apply', '--project', PROJECT, 'does-not-exist', '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 21, result.stdout + result.stderr);
  assert.match(result.stdout, /declined/);
});

test('promotion apply: a confirmed but unknown scenario proceeds to apply and exits 4 (NOT_FOUND)', async () => {
  const { file } = await buildSeed();
  const result = run(
    ['promotion', 'apply', '--project', PROJECT, 'does-not-exist', '--port', 'memory', '--seed', file],
    { input: 'y\n' },
  );
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stderr, /does not exist/);
});

test('promotion apply --yes on an unknown scenario exits 4', async () => {
  const { file } = await buildSeed();
  const result = run(['promotion', 'apply', '--project', PROJECT, 'does-not-exist', '--yes', '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stderr, /does not exist/);
});

test('promotion preview on an unknown scenario exits 4', async () => {
  const { file } = await buildSeed();
  const result = run(['promotion', 'preview', '--project', PROJECT, 'does-not-exist', '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stderr, /does not exist/);
});

test('promotion discard of an unknown scenario is an idempotent no-op (exit 0)', async () => {
  const { file } = await buildSeed();
  const result = run(['promotion', 'discard', '--project', PROJECT, 'does-not-exist', '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /discarded:\s+true/);
});

// --- docker-gated: the whole flow against the live pinned engine ---------------------------------

const gate = dockerGate();

if (!gate.ok) {
  test(`formula CLI context suite (docker-gated): ${gate.reason}`, (t) => {
    t.diagnostic(`SKIPPED — ${gate.reason} (pinned image ${ARCADEDB_IMAGE})`);
    t.skip(gate.reason);
  });
} else {
  describe('formula CLI context + promotion (docker-gated)', () => {
    const projectId = `cli-ctx-${randomUUID().slice(0, 12).replaceAll('-', '')}`;
    const scenarioId = 'cli-flow';
    const scenarioRule = qid(projectId, 'rule:added-by-scenario');
    const surface = qid(projectId, 'surface:scripts');
    const name = containerNameFor(projectId);
    const database = databaseNameFor(projectId);
    let server = null;

    before(async () => {
      await destroyContainer(name, { removeVolume: true }); // a crashed earlier run leaves no trap
      server = await startServer({ name, timeoutMs: 90_000 });
    });

    after(async () => {
      await destroyContainer(name, { removeVolume: true });
      server = null;
    });

    // Seeds the live engine once: topology from a real workspace root, the curated skeleton, and a
    // promotable scenario (one new Rule + its explicit scope on a fresh concern, so the projection
    // is B4-clean and the advisor silent — the D5 promotable shape).
    async function seedLive() {
      const root = makeWorkspaceRoot();
      const port = createArcadeDbPort({ server, database });
      try {
        await createDatabase(server, database);
        const detection = await detectTopology(root);
        const written = await writeTopology(port, detection, { projectId });
        assert.equal(written.ok, true, `topology write failed: ${written.message}`);
        const applied = await applyChangeSet(port, { operations: curatedOps(projectId) }, { ...META, projectId });
        assert.equal(applied.ok, true, applied.violations.map((v) => v.message).join('; '));
        const validation = await validateGraph(port, { projectId });
        assert.deepEqual(validation.violations, [], `the live seed must be B4-clean: ${validation.violations.map((v) => v.message).join('; ')}`);
        const created = await createScenario(port, {
          projectId,
          scenarioId,
          proposedBy: { type: 'agent-proposer', name: 'scripts-agent' },
          operations: [
            { op: 'ADD', target: 'node', namespace: 'curated', type: 'Rule', id: scenarioRule, properties: { id: scenarioRule, title: 'Brand new rule', statement: 'A normative statement.', status: 'active', strength: 'must', category: 'engineering', concern: 'scenario-only', provenance: { source: 'spec', line: 52 } } },
            { op: 'ADD', target: 'edge', namespace: 'curated', type: 'APPLIES_TO', fromId: scenarioRule, toId: surface },
          ],
        });
        assert.equal(created.ok, true, created.message ?? JSON.stringify(created));
      } finally {
        await port.close();
      }
      return root;
    }

    test('live: context resolve against the seeded engine emits both artifacts (exit 0)', async () => {
      const root = await seedLive();
      const out = tempDir('steepy-cli-live-out-');
      const result = run([
        'context', 'resolve', '--project', projectId,
        '--path', 'packages/engine/src/a.mjs',
        '--root', root,
        '--out', out,
      ]);
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      const json = JSON.parse(readFileSync(join(out, 'context.json'), 'utf8'));
      assert.deepEqual(Object.keys(json)[0], 'schemaVersion');
      assert.equal(json.projectId, projectId);
      assert.equal(json.layer0.topology.outcome, 'unchanged');
      assert.ok(json.layer1.rules.some((r) => r.id === qid(projectId, 'rule:package-manifest')));
      assert.match(readFileSync(join(out, 'context.md'), 'utf8'), /^# Context \(schema v1\)/);
    });

    test('live: promotion preview prints the typed diff report (exit 0)', () => {
      const result = run(['promotion', 'preview', '--project', projectId, scenarioId]);
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Promotion Scenario: ${scenarioId}`));
      assert.match(result.stdout, /status: current/);
      assert.match(result.stdout, /Operations \(2\):/);
      assert.match(result.stdout, /base revision: apex:cli-ctx-[0-9a-f]+:revision:r2/);
    });

    test('live: promotion apply refuses without confirmation (stdin n -> exit 21, refusal visible)', () => {
      const result = run(['promotion', 'apply', '--project', projectId, scenarioId], { input: 'n\n' });
      assert.equal(result.status, 21, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, /declined/);
    });

    test('live: promotion apply --yes commits the ChangeSet and advances the head (exit 0)', async () => {
      const before = await withLivePort((port) => readChain(port, { projectId }));
      const result = run(['promotion', 'apply', '--project', projectId, scenarioId, '--yes', '--approver', 'f3-live-tester']);
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, /promotion apply/);
      assert.match(result.stdout, /ADD node curated Rule apex:cli-ctx-[0-9a-f]+:rule:added-by-scenario/);
      assert.match(result.stdout, /revision:\s+apex:cli-ctx-[0-9a-f]+:revision:r3/);
      assert.match(result.stdout, /consumed:\s+true/);
      assert.match(result.stdout, /export:\s+none/);

      const after = await withLivePort((port) => readChain(port, { projectId }));
      assert.notEqual(after.headRevision, before.headRevision);
      assert.equal(after.headRevision, qid(projectId, 'revision:r3'));
      const [latest] = after.revisions.slice(-1);
      assert.deepEqual(latest.approver, { type: 'human-approver', id: 'f3-live-tester' });
      assert.ok(latest.provenance[0].source.endsWith(':1'), 'the CLI provenance source follows the <file>:<line> convention');
    });

    test('live: promotion discard after apply is an idempotent no-op (exit 0)', () => {
      const result = run(['promotion', 'discard', '--project', projectId, scenarioId]);
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, /discarded:\s+true/);
    });

    test('live: promotion preview of a stale scenario exits 20 with the staleness diagnostic', async () => {
      const staleId = 'stale-flow';
      const staleRule = qid(projectId, 'rule:stale-rule');
      await withLivePort(async (port) => {
        const created = await createScenario(port, {
          projectId,
          scenarioId: staleId,
          proposedBy: { type: 'agent-proposer', name: 'scripts-agent' },
          operations: [
            { op: 'ADD', target: 'node', namespace: 'curated', type: 'Rule', id: staleRule, properties: { id: staleRule, title: 'Stale rule', statement: 'A normative statement.', status: 'active', strength: 'must', category: 'engineering', concern: 'stale-concern', provenance: { source: 'spec', line: 52 } } },
            { op: 'ADD', target: 'edge', namespace: 'curated', type: 'APPLIES_TO', fromId: staleRule, toId: surface },
          ],
        });
        assert.equal(created.ok, true, created.message ?? JSON.stringify(created));
        // advance the head behind the scenario's back, so its base revision is stale
        const moverId = 'head-mover';
        const moverRule = qid(projectId, 'rule:head-mover');
        const mover = await createScenario(port, {
          projectId,
          scenarioId: moverId,
          proposedBy: { type: 'agent-proposer', name: 'scripts-agent' },
          operations: [
            { op: 'ADD', target: 'node', namespace: 'curated', type: 'Rule', id: moverRule, properties: { id: moverRule, title: 'Head mover', statement: 'A normative statement.', status: 'active', strength: 'must', category: 'engineering', concern: 'head-mover-concern', provenance: { source: 'spec', line: 52 } } },
            { op: 'ADD', target: 'edge', namespace: 'curated', type: 'APPLIES_TO', fromId: moverRule, toId: surface },
          ],
        });
        assert.equal(mover.ok, true, mover.message ?? JSON.stringify(mover));
        const approved = await applyPromotion(port, {
          projectId,
          scenarioId: moverId,
          approver: { type: 'human-approver', id: 'f3-live-tester' },
          provenance: [{ quotation: 'head mover', source: 'cli:steepy-formula:1', digest: sha256Hex('head mover') }],
        });
        assert.equal(approved.ok, true, approved.message ?? JSON.stringify(approved));
      });

      const result = run(['promotion', 'preview', '--project', projectId, staleId]);
      assert.equal(result.status, 20, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, /status: PROMOTION_STALE/, 'the diff header must state the staleness');
      assert.match(result.stderr, /PROMOTION_STALE/);
      assert.match(result.stderr, /rebase before apply/);
    });

    test('live: promotion apply of a scenario with no applied operations exits 23 (SCENARIO_EMPTY)', async () => {
      const emptyId = 'empty-flow';
      await withLivePort(async (port) => {
        const created = await createScenario(port, {
          projectId,
          scenarioId: emptyId,
          proposedBy: { type: 'agent-proposer', name: 'scripts-agent' },
          operations: [],
        });
        assert.equal(created.ok, true, created.message ?? JSON.stringify(created));
      });
      const result = run(['promotion', 'apply', '--project', projectId, emptyId, '--yes']);
      assert.equal(result.status, 23, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stderr, /holds no applied operations/);
    });

    test('live: promotion apply of a scenario with a dirty projection exits 22 (SCENARIO_INVALID)', async () => {
      const invalidId = 'invalid-flow';
      await withLivePort(async (port) => {
        const created = await createScenario(port, {
          projectId,
          scenarioId: invalidId,
          proposedBy: { type: 'agent-proposer', name: 'scripts-agent' },
          operations: [
            // an APPLIES_TO edge to a target that does not exist breaks the projected graph's
            // endpoint invariant — the projection is dirty, so apply must refuse with the
            // blocking finding (SCENARIO_INVALID).
            { op: 'ADD', target: 'edge', namespace: 'curated', type: 'APPLIES_TO', fromId: qid(projectId, 'rule:package-manifest'), toId: qid(projectId, 'surface:does-not-exist') },
          ],
        });
        assert.equal(created.ok, true, created.message ?? JSON.stringify(created));
      });
      const result = run(['promotion', 'apply', '--project', projectId, invalidId, '--yes']);
      assert.equal(result.status, 22, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stderr, /not structurally valid/);
    });

    test('live: promotion apply confirmed via the prompt (stdin y) commits and exits 0', async () => {
      const confirmedId = 'confirm-flow';
      const confirmRule = qid(projectId, 'rule:confirm-rule');
      await withLivePort(async (port) => {
        const created = await createScenario(port, {
          projectId,
          scenarioId: confirmedId,
          proposedBy: { type: 'agent-proposer', name: 'scripts-agent' },
          operations: [
            { op: 'ADD', target: 'node', namespace: 'curated', type: 'Rule', id: confirmRule, properties: { id: confirmRule, title: 'Confirmed rule', statement: 'A normative statement.', status: 'active', strength: 'must', category: 'engineering', concern: 'confirm-concern', provenance: { source: 'spec', line: 52 } } },
            { op: 'ADD', target: 'edge', namespace: 'curated', type: 'APPLIES_TO', fromId: confirmRule, toId: surface },
          ],
        });
        assert.equal(created.ok, true, created.message ?? JSON.stringify(created));
      });
      const result = run(['promotion', 'apply', '--project', projectId, confirmedId], { input: 'y\n' });
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, /promotion apply/);
      assert.match(result.stdout, /consumed:\s+true/);
      assert.match(result.stdout, /revision:/);
    });

    async function withLivePort(fn) {
      const port = createArcadeDbPort({ server, database });
      try {
        return await fn(port);
      } finally {
        await port.close();
      }
    }
  });
}
