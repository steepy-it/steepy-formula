// Schema-version guard, export/backup/restore CLI and the shadow schema migration (Task F4,
// spec §22, §27; failure table row "Schema version unsupported"). Three layers:
//
//  1. NON-DOCKER (always runs): the guard + shadow-build/validation/cutover flow on the memory
//     seam. The memory seam covers the §27 interruption boundary directly: an interruption BEFORE
//     cutover (dirty transform, failing backup) and DURING cutover (a cutover hook that throws
//     mid-replace) must leave the primary consistent — the transactional replace rolls the partial
//     clear back to the old graph, and the verified backup exists. The unsupported-version refusal
//     is pinned twice: the core `migrateSchema` guard, and the CLI normal-command refusal (exit 1).
//  2. CLI (non-docker): `graph export`, `graph restore` and `graph migrate-schema` on the memory
//     seam — exit 24 for the migration guard, exit 1 for a shadow that fails validation with the
//     primary untouched, and the restore pipeline (import -> validate + chain replay) exit 0.
//  3. DOCKER-GATED (C1/E2 pattern): the criterion-9 restore-into-a-clean-environment CLI test —
//     export -> destroy the database -> clean database -> restore -> validate + resolve a
//     representative context; the non-empty-database refusal and the `--force` overwrite; the
//     production `graph migrate-schema` against the live pinned engine; and the §27 shadow workflow
//     with a real transform (property rename) at the core level against the live engine.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { NO_NATIVE_CAPABILITIES, withTransaction } from '../scripts/formula/engine/port.mjs';
import { EXPORT_NAMESPACES, buildExportArtifact, importGraph } from '../scripts/formula/core/export.mjs';
import { applyChangeSet } from '../scripts/formula/core/revision.mjs';
import { detectTopology, writeTopology } from '../scripts/formula/core/topology.mjs';
import { GRAPH_SCHEMA_VERSION } from '../scripts/formula/core/ontology.mjs';
import { systemRecordId, validateGraph } from '../scripts/formula/core/validate-graph.mjs';
import {
  MIGRATE_ERROR_CODES,
  migrateSchema,
  replacePrimaryFromArtifact,
  versionBumpTransform,
} from '../scripts/formula/core/schema-migrate.mjs';
import {
  ARCADEDB_IMAGE,
  containerNameFor,
  destroyContainer,
  dockerGate,
  startServer,
} from '../scripts/formula/engine/lifecycle.mjs';
import {
  createArcadeDbPort,
  createDatabase,
  databaseNameFor,
  dropDatabase,
  listDatabases,
  runSql,
} from '../scripts/formula/engine/arcadedb.mjs';

const cliPath = fileURLToPath(new URL('../scripts/formula/cli.mjs', import.meta.url));
const PROJECT = 'f4';

function qid(projectId, localId) {
  return `apex:${projectId}:${localId}`;
}

// --- subprocess helper -------------------------------------------------------------------------

function run(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
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

function makeWorkspaceRoot() {
  const root = tempDir('steepy-f4-root-');
  mkdirSync(join(root, 'packages', 'engine'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'f4-root', private: true, workspaces: ['packages/*'] }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, 'packages', 'engine', 'package.json'),
    `${JSON.stringify({ name: '@f4/engine', version: '1.0.0' }, null, 2)}\n`,
  );
  return root;
}

const META = {
  projectId: PROJECT,
  proposer: { type: 'agent-proposer', id: 'scripts-agent' },
  approver: { type: 'human-approver', id: 'f4-tester' },
  provenance: [{ quotation: 'F4 schema-migration suite fixture.', source: 'tests/formula-schema-migrate.test.mjs:1', digest: 'f'.repeat(64) }],
};

function addNode(type, id, properties = {}, namespace = 'curated') {
  const base = namespace === 'topology' ? { id } : { id, status: 'active' };
  return { op: 'ADD', target: 'node', namespace, type, id, properties: { ...base, ...properties } };
}

function addEdge(type, fromId, toId, namespace = 'curated') {
  return { op: 'ADD', target: 'edge', namespace, type, fromId, toId };
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

// A B4-clean, resolvable curated + topology graph — the same skeleton F3's suite uses, plus one
// Rule that carries an optional `body` so the real property-rename transform has something to
// rename.
function curatedOps(projectId) {
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
    package: qid(projectId, 'package:f4-engine'),
  };
  return [
    addNode('Project', ID.project),
    addNode('Surface', ID.surface),
    addNode('Component', ID.component),
    addNode('Agent', ID.agent),
    addNode('Check', ID.check),
    addNode('Term', ID.term),
    addNode('Decision', ID.decision),
    ruleOp(ID.rule, 'external-input', { body: 'Every external value must be sanitized.' }),
    ruleOp(ID.rulePackage, 'package-scope'),
    addEdge('PART_OF', ID.surface, ID.project),
    addEdge('PART_OF', ID.component, ID.surface),
    addEdge('OWNED_BY', ID.surface, ID.agent),
    addEdge('APPLIES_TO', ID.rule, ID.surface),
    addEdge('VERIFIED_BY', ID.rule, ID.check),
    addEdge('MOTIVATED_BY', ID.rule, ID.decision),
    addEdge('USED_BY', ID.term, ID.rule),
    addEdge('APPLIES_TO', ID.rulePackage, ID.package),
    addEdge('IMPLEMENTS', ID.package, ID.component, 'topology'),
  ];
}

async function seedPort(projectId, port) {
  const root = makeWorkspaceRoot();
  const detection = await detectTopology(root);
  const written = await writeTopology(port, detection, { projectId });
  assert.equal(written.ok, true, `topology write failed: ${written.message}`);
  const applied = await applyChangeSet(port, { operations: curatedOps(projectId) }, { ...META, projectId });
  assert.equal(applied.ok, true, applied.violations.map((v) => v.message).join('; '));
  const validation = await validateGraph(port, { projectId });
  assert.deepEqual(validation.violations, [], `the seed must be B4-clean: ${validation.violations.map((v) => v.message).join('; ')}`);
  return root;
}

// Builds a valid seeded memory port (B4-clean, promoted, with a Rule carrying `body`).
async function buildValidPort() {
  const port = createMemoryPort();
  await seedPort(PROJECT, port);
  return port;
}

function writeArtifact(prefix, artifact) {
  const file = join(tempDir(prefix), 'seed.jsonl');
  writeFileSync(file, artifact.text);
  return file;
}

async function validSeedFile() {
  const port = await buildValidPort();
  try {
    const artifact = await buildExportArtifact(port, { projectId: PROJECT });
    return writeArtifact('steepy-f4-seed-', artifact);
  } finally {
    await port.close();
  }
}

// A seed whose system record declares schema version 2 — the failure-table row this build must
// refuse: normal commands exit 1, the migration guard exits 24.
async function unsupportedSeedFile() {
  const port = await buildValidPort();
  try {
    await withTransaction(port, async (tx) => {
      const system = await tx.getNode({ namespace: 'system', id: systemRecordId(PROJECT) });
      await tx.updateNode({
        namespace: 'system',
        id: systemRecordId(PROJECT),
        properties: { ...system.properties, schemaVersion: 2 },
      });
    });
    const artifact = await buildExportArtifact(port, { projectId: PROJECT });
    return writeArtifact('steepy-f4-unsupported-', artifact);
  } finally {
    await port.close();
  }
}

// --- transforms --------------------------------------------------------------------------------

// The real transform the brief's tests inject: rename an optional property across the graph
// (`body` -> `ext_v1_body` — an extension-namespaced name, so the result stays B4-clean).
function renameTransform(from, to) {
  return (graph) => ({
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (!node.properties || node.properties[from] === undefined) return node;
      const { [from]: _removed, ...rest } = node.properties;
      return { ...node, properties: { ...rest, [to]: _removed } };
    }),
  });
}

// A DIRTY transform: rename a required property away (`title` -> `ext_v1_title`), so the shadow
// graph is missing a required property and must fail B4 validation BEFORE cutover.
function dirtyTransform() {
  return (graph) => ({
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.type !== 'Rule' || node.properties?.title === undefined) return node;
      const { title, ...rest } = node.properties;
      return { ...node, properties: { ...rest, ext_v1_title: title } };
    }),
  });
}

// --- memory-seam hooks for the core-level calls -------------------------------------------------

async function replaceInTransaction(port, artifact) {
  await replacePrimaryFromArtifact(port, artifact, PROJECT);
}

// `backup`: 'ok' (default) | 'none' (omit the hook) | 'fail' (the hook reports failure).
function memoryHooks({ primaryPort, backup = 'ok', cutoverImpl = null }) {
  const backupHook =
    backup === 'none'
      ? undefined
      : async () => {
          if (backup === 'fail') return { ok: false, text: '', filePath: null };
          const artifact = await buildExportArtifact(primaryPort, { projectId: PROJECT });
          return { ok: true, text: artifact.text, filePath: '/fake/verified-backup.jsonl' };
        };
  return {
    openShadow: async () => createMemoryPort(),
    closeShadow: async (shadowPort) => {
      await shadowPort.close();
    },
    ...(backupHook ? { backup: backupHook } : {}),
    cutover:
      cutoverImpl ??
      (async (shadowPort) => {
        const artifact = await buildExportArtifact(shadowPort, { projectId: PROJECT });
        await replaceInTransaction(primaryPort, artifact);
        return { port: primaryPort, dispose: async () => {} };
      }),
  };
}

async function ruleNode(port, projectId, id) {
  return withTransaction(port, (tx) => tx.getNode({ namespace: 'curated', id }));
}

// --- guard: unsupported schema version (failure table row) --------------------------------------

test('guard: migrateSchema refuses a graph whose current schema version is unsupported', async () => {
  const port = await buildValidPort();
  try {
    await withTransaction(port, async (tx) => {
      const system = await tx.getNode({ namespace: 'system', id: systemRecordId(PROJECT) });
      await tx.updateNode({
        namespace: 'system',
        id: systemRecordId(PROJECT),
        properties: { ...system.properties, schemaVersion: 2 },
      });
    });
    const result = await migrateSchema(port, {
      projectId: PROJECT,
      transform: versionBumpTransform(GRAPH_SCHEMA_VERSION),
      options: memoryHooks({ primaryPort: port }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, MIGRATE_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION);
    assert.match(result.message, /cannot be migrated/);
  } finally {
    await port.close();
  }
});

test('guard: migrateSchema refuses a graph that declares no schema version at all', async () => {
  const port = createMemoryPort();
  try {
    const result = await migrateSchema(port, {
      projectId: PROJECT,
      transform: versionBumpTransform(GRAPH_SCHEMA_VERSION),
      options: memoryHooks({ primaryPort: port }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, MIGRATE_ERROR_CODES.SCHEMA_VERSION_MISSING);
  } finally {
    await port.close();
  }
});

test('normal-command refusal: `graph validate` on an unsupported-version port exits 1 with the refusal', async () => {
  const file = await unsupportedSeedFile();
  const result = run(['graph', 'validate', '--project', PROJECT, '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /UNSUPPORTED_SCHEMA_VERSION/);
  assert.match(result.stdout + result.stderr, /explicit schema migration/);
});

test('normal-command refusal: `graph status` on an unsupported-version port exits 1', async () => {
  const file = await unsupportedSeedFile();
  const result = run(['graph', 'status', '--project', PROJECT, '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /UNSUPPORTED_SCHEMA_VERSION/);
});

test('CLI migration guard: `graph migrate-schema` on an unsupported-version port exits 24 (distinct)', async () => {
  const file = await unsupportedSeedFile();
  const result = run(['graph', 'migrate-schema', '--project', PROJECT, '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 24, result.stdout + result.stderr);
  assert.match(result.stderr, /UNSUPPORTED_SCHEMA_VERSION/);
});

// --- shadow migration on the memory seam (the §27 procedure) -----------------------------------

test('migrateSchema: a clean transform migrates the primary in place, atomically (memory seam)', async () => {
  const port = await buildValidPort();
  try {
    const result = await migrateSchema(port, {
      projectId: PROJECT,
      transform: renameTransform('body', 'ext_v1_body'),
      options: memoryHooks({ primaryPort: port }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.beforeVersion, 1);
    assert.equal(result.afterVersion, 1);
    assert.equal(result.atomicCutover, false);
    assert.match(result.backupEvidence.digest, /^[0-9a-f]{64}$/);
    assert.equal(result.postCutover.validated, true);

    const rule = await ruleNode(port, PROJECT, qid(PROJECT, 'rule:sanitize-external-input'));
    assert.equal(rule.properties.body, undefined);
    assert.equal(rule.properties.ext_v1_body, 'Every external value must be sanitized.');
    const validation = await validateGraph(port, { projectId: PROJECT });
    assert.equal(validation.ok, true, validation.violations.map((v) => v.message).join('; '));
  } finally {
    await port.close();
  }
});

test('migrateSchema: a dirty transform aborts BEFORE cutover and leaves the primary untouched', async () => {
  const port = await buildValidPort();
  try {
    const result = await migrateSchema(port, {
      projectId: PROJECT,
      transform: dirtyTransform(),
      options: memoryHooks({ primaryPort: port }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, MIGRATE_ERROR_CODES.SHADOW_VALIDATION_FAILED);
    assert.ok(result.violations.some((v) => v.code === 'MISSING_REQUIRED_PROPERTY'));

    const rule = await ruleNode(port, PROJECT, qid(PROJECT, 'rule:sanitize-external-input'));
    assert.equal(rule.properties.title, 'Rule apex:f4:rule:sanitize-external-input');
    assert.equal(rule.properties.ext_v1_title, undefined, 'the dirty transform must not have landed');
    const validation = await validateGraph(port, { projectId: PROJECT });
    assert.equal(validation.ok, true, 'the primary must still be the old, valid graph');
  } finally {
    await port.close();
  }
});

test('migrateSchema: a failing backup aborts BEFORE cutover and leaves the primary untouched', async () => {
  const port = await buildValidPort();
  try {
    const result = await migrateSchema(port, {
      projectId: PROJECT,
      transform: renameTransform('body', 'ext_v1_body'),
      options: memoryHooks({ primaryPort: port, backup: 'fail' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, MIGRATE_ERROR_CODES.VERIFIED_BACKUP_FAILED);
    const rule = await ruleNode(port, PROJECT, qid(PROJECT, 'rule:sanitize-external-input'));
    assert.equal(rule.properties.body, 'Every external value must be sanitized.');
    assert.equal(rule.properties.ext_v1_body, undefined);
  } finally {
    await port.close();
  }
});

test('migrateSchema: where atomicCutover is false and no backup hook is supplied, it refuses', async () => {
  const port = await buildValidPort();
  try {
    const result = await migrateSchema(port, {
      projectId: PROJECT,
      transform: versionBumpTransform(GRAPH_SCHEMA_VERSION),
      options: memoryHooks({ primaryPort: port, backup: 'none' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, MIGRATE_ERROR_CODES.VERIFIED_BACKUP_REQUIRED);
  } finally {
    await port.close();
  }
});

test('migrateSchema: an interruption DURING cutover rolls back to the old graph and keeps the verified backup', async () => {
  const port = await buildValidPort();
  try {
    const interruptingCutover = async () => {
      // Simulate an interruption mid-replace: clear part of the primary inside a transaction and
      // then die. The transaction must roll back — the primary stays the old, consistent graph.
      await withTransaction(port, async (tx) => {
        for (const namespace of EXPORT_NAMESPACES) {
          for (const edge of await tx.listEdges({ namespace })) {
            await tx.deleteEdge({ namespace, type: edge.type, fromId: edge.fromId, toId: edge.toId });
          }
        }
        for (const namespace of EXPORT_NAMESPACES) {
          for (const node of await tx.listNodes({ namespace })) {
            await tx.deleteNode({ namespace, id: node.id });
          }
        }
        throw new Error('interrupted mid-cutover');
      });
      return { port };
    };
    const result = await migrateSchema(port, {
      projectId: PROJECT,
      transform: renameTransform('body', 'ext_v1_body'),
      options: memoryHooks({ primaryPort: port, cutoverImpl: interruptingCutover }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, MIGRATE_ERROR_CODES.CUTOVER_FAILED);
    assert.match(result.backupEvidence.digest, /^[0-9a-f]{64}$/, 'a verified backup must exist');

    const validation = await validateGraph(port, { projectId: PROJECT });
    assert.equal(validation.ok, true, 'the primary must be the old, consistent graph after the interrupted cutover');
    const rule = await ruleNode(port, PROJECT, qid(PROJECT, 'rule:sanitize-external-input'));
    assert.equal(rule.properties.body, 'Every external value must be sanitized.');
    assert.equal(rule.properties.ext_v1_body, undefined);
  } finally {
    await port.close();
  }
});

test('migrateSchema: where atomicCutover is true it swaps and does NOT require a backup', async () => {
  const port = await buildValidPort();
  try {
    const atomic = {
      ...port,
      capabilities: async () => ({ ...NO_NATIVE_CAPABILITIES, atomicCutover: true }),
    };
    const result = await migrateSchema(atomic, {
      projectId: PROJECT,
      transform: renameTransform('body', 'ext_v1_body'),
      options: {
        openShadow: async () => createMemoryPort(),
        closeShadow: async (shadowPort) => {
          await shadowPort.close();
        },
        cutover: async (shadowPort) => {
          const artifact = await buildExportArtifact(shadowPort, { projectId: PROJECT });
          await replaceInTransaction(port, artifact);
          return { port, dispose: async () => {} };
        },
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.atomicCutover, true);
    assert.equal(result.backupEvidence, null, 'an atomic cutover must not require a backup');
    const rule = await ruleNode(port, PROJECT, qid(PROJECT, 'rule:sanitize-external-input'));
    assert.equal(rule.properties.ext_v1_body, 'Every external value must be sanitized.');
  } finally {
    await port.close();
  }
});

// --- CLI migrate-schema on the memory seam ------------------------------------------------------

test('CLI: `graph migrate-schema --to 1` on a valid seed reports before/after and verified backup (exit 0)', async () => {
  const file = await validSeedFile();
  const result = run(['graph', 'migrate-schema', '--project', PROJECT, '--to', '1', '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /project:\s+f4 \(flag\)/);
  assert.match(result.stdout, /schema:\s+v1 -> v1/);
  assert.match(result.stdout, /backup:\s+verified/);
  assert.match(result.stdout, /post-check:\s+validated clean, chain clean/);
});

test('CLI: `graph migrate-schema --to 2` fails shadow validation and leaves the primary untouched (exit 1)', async () => {
  const file = await validSeedFile();
  const result = run(['graph', 'migrate-schema', '--project', PROJECT, '--to', '2', '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /UNSUPPORTED_SCHEMA_VERSION/);
  assert.match(result.stderr, /primary was left untouched/);
});

test('CLI: `graph migrate-schema` with a non-integer --to exits 2', async () => {
  const file = await validSeedFile();
  const result = run(['graph', 'migrate-schema', '--project', PROJECT, '--to', 'bogus', '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
});

// --- CLI export / restore on the memory seam ----------------------------------------------------

test('CLI: `graph export --out <file>` reports the head revision and digest (exit 0)', async () => {
  const port = await buildValidPort();
  let file;
  try {
    const artifact = await buildExportArtifact(port, { projectId: PROJECT });
    file = writeArtifact('steepy-f4-export-', artifact);
  } finally {
    await port.close();
  }
  const out = join(tempDir('steepy-f4-export-out-'), 'export.jsonl');
  const result = run(['graph', 'export', '--project', PROJECT, '--out', out, '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /graph export 'f4'/);
  assert.match(result.stdout, /project:\s+f4 \(flag\)/);
  assert.match(result.stdout, /head:\s+apex:f4:revision:r\d+/);
  assert.match(result.stdout, /digest:\s+[0-9a-f]{64}/);
  assert.ok(existsSync(out));
});

test('CLI: `graph export --out -` writes the artifact to stdout and the report to stderr', async () => {
  const file = await validSeedFile();
  const result = run(['graph', 'export', '--project', PROJECT, '--out', '-', '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"recordType":"header"/);
  assert.match(result.stdout, /"recordType":"trailer"/);
  // the echo rides stderr with the head/digest report — the artifact bytes stay machine-clean
  assert.match(result.stderr, /project:\s+f4 \(flag\)/);
  assert.doesNotMatch(result.stdout, /^ {2}project:/m);
  assert.match(result.stderr, /head:/);
  assert.match(result.stderr, /digest:/);
});

test('CLI: `graph restore --from` on the memory seam imports, validates and replays (exit 0)', async () => {
  const file = await validSeedFile();
  const result = run(['graph', 'restore', '--project', PROJECT, '--from', file, '--port', 'memory']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /graph restore 'f4'/);
  assert.match(result.stdout, /project:\s+f4 \(flag\)/);
  assert.match(result.stdout, /validated:\s+clean/);
  assert.match(result.stdout, /chain:\s+clean/);
});

test('CLI: `graph restore` without --from exits 2', () => {
  const result = run(['graph', 'restore', '--project', PROJECT, '--port', 'memory']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
});

test('CLI: a corrupt export restores as an operational failure (exit 3), never a crash', () => {
  const bad = join(tempDir('steepy-f4-bad-'), 'bad.jsonl');
  writeFileSync(bad, '{"recordType":"header"}\nnot json\n');
  const result = run(['graph', 'restore', '--project', PROJECT, '--from', bad, '--port', 'memory']);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /steepy-formula:/);
});

test('CLI: `graph backup` on the memory seam writes the portable export (native n/a, exit 0)', async () => {
  const file = await validSeedFile();
  const to = tempDir('steepy-f4-backup-');
  const result = run(['graph', 'backup', '--project', PROJECT, '--to', to, '--port', 'memory', '--seed', file]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /graph backup 'f4'/);
  assert.match(result.stdout, /project:\s+f4 \(flag\)/);
  assert.match(result.stdout, /portable:/);
  assert.match(result.stdout, /digest:\s+[0-9a-f]{64}/);
  assert.match(result.stdout, /native:\s+n\/a/);
  const written = readdirSync(to).filter((name) => name.endsWith('.jsonl'));
  assert.equal(written.length, 1);
});

// --- docker-gated: restore-into-a-clean-environment + the live migration ------------------------

const gate = dockerGate();

if (!gate.ok) {
  test(`formula schema-migration suite (docker-gated): ${gate.reason}`, (t) => {
    t.diagnostic(`SKIPPED — ${gate.reason} (pinned image ${ARCADEDB_IMAGE})`);
    t.skip(gate.reason);
  });
} else {
  describe('formula schema migration (docker-gated)', () => {
    const projectId = `f4-live-${randomUUID().slice(0, 12).replaceAll('-', '')}`;
    const name = containerNameFor(projectId);
    const database = databaseNameFor(projectId);
    const surface = qid(projectId, 'surface:scripts');
    const rule = qid(projectId, 'rule:sanitize-external-input');
    let server = null;
    let exportFile = null;

    before(async () => {
      await destroyContainer(name, { removeVolume: true }); // a crashed earlier run leaves no trap
      server = await startServer({ name, timeoutMs: 90_000 });
    });

    after(async () => {
      await destroyContainer(name, { removeVolume: true });
      server = null;
    });

    async function withLivePort(fn) {
      const port = createArcadeDbPort({ server, database });
      try {
        return await fn(port);
      } finally {
        await port.close();
      }
    }

    test('seed the live engine and `graph export` the digest-verified artifact (exit 0)', async () => {
      await createDatabase(server, database);
      await withLivePort((port) => seedPort(projectId, port));
      const out = join(tempDir('steepy-f4-live-export-'), 'export.jsonl');
      const result = run(['graph', 'export', '--project', projectId, '--out', out]);
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, /head:\s+apex:f4-live-[0-9a-f]+:revision:r\d+/);
      assert.match(result.stdout, /digest:\s+[0-9a-f]{64}/);
      assert.ok(existsSync(out));
      exportFile = out;
    });

    test('live `graph backup` writes the portable artifact and runs the engine-native online backup (exit 0)', async () => {
      const to = tempDir('steepy-f4-live-backup-');
      const result = run(['graph', 'backup', '--project', projectId, '--to', to]);
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, /portable:/);
      assert.match(result.stdout, /digest:\s+[0-9a-f]{64}/);
      assert.match(result.stdout, /native:\s+OK \(/);
      const written = readdirSync(to).filter((name) => name.endsWith('.jsonl'));
      assert.equal(written.length, 1);
    });

    test('restore-into-a-clean-environment (criterion 9): destroy the database, restore, validate + resolve context', async () => {
      assert.ok(exportFile, 'the previous test must have exported');
      await dropDatabase(server, database);
      await createDatabase(server, database);

      const restored = run(['graph', 'restore', '--project', projectId, '--from', exportFile]);
      assert.equal(restored.status, 0, `stdout:\n${restored.stdout}\nstderr:\n${restored.stderr}`);
      assert.match(restored.stdout, /validated:\s+clean/);
      assert.match(restored.stdout, /chain:\s+clean/);

      const validation = await withLivePort((port) => validateGraph(port, { projectId }));
      assert.equal(validation.ok, true, validation.violations.map((v) => v.message).join('; '));

      const out = tempDir('steepy-f4-live-ctx-');
      const resolved = run([
        'context', 'resolve', '--project', projectId, '--target', surface, '--out', out,
      ]);
      assert.equal(resolved.status, 0, `stdout:\n${resolved.stdout}\nstderr:\n${resolved.stderr}`);
      const json = JSON.parse(readFileSync(join(out, 'context.json'), 'utf8'));
      assert.equal(json.projectId, projectId);
    });

    test('restore refuses a non-empty database without --force (exit 3) and overwrites with --force (exit 0)', () => {
      const refused = run(['graph', 'restore', '--project', projectId, '--from', exportFile]);
      assert.equal(refused.status, 3, refused.stdout + refused.stderr);
      assert.match(refused.stderr, /refusing to overwrite/);

      const forced = run(['graph', 'restore', '--project', projectId, '--from', exportFile, '--force']);
      assert.equal(forced.status, 0, `stdout:\n${forced.stdout}\nstderr:\n${forced.stderr}`);
      assert.match(forced.stdout, /validated:\s+clean/);
      assert.match(forced.stdout, /chain:\s+clean/);
    });

    test('live `graph migrate-schema --to 1` runs the §27 procedure against the engine (exit 0)', async () => {
      const result = run(['graph', 'migrate-schema', '--project', projectId, '--to', '1']);
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, /schema:\s+v1 -> v1/);
      assert.match(result.stdout, /backup:\s+verified/);
      assert.match(result.stdout, /post-check:\s+validated clean, chain clean/);
      assert.ok(!(await listDatabases(server)).includes(`${database}_shadow`), 'the shadow database must be cleaned up');
      const validation = await withLivePort((port) => validateGraph(port, { projectId }));
      assert.equal(validation.ok, true, validation.violations.map((v) => v.message).join('; '));
    });

    test('live core-level migrateSchema with a real transform (property rename) cuts over to the shadow-transformed graph', async () => {
      const shadowDatabase = `${database}_shadow`;
      const liveHooks = {
        openShadow: async () => {
          await dropDatabase(server, shadowDatabase).catch(() => {});
          await createDatabase(server, shadowDatabase);
          return createArcadeDbPort({ server, database: shadowDatabase });
        },
        closeShadow: async (shadowPort) => {
          await shadowPort.close();
          await dropDatabase(server, shadowDatabase).catch(() => {});
        },
        backup: async () => {
          const native = await runSql(server, database, 'BACKUP DATABASE');
          return { ok: true, text: await liveExportText(), filePath: '/tmp/f4-live-verified-backup.jsonl', native: native[0]?.backupFile };
        },
        cutover: async (shadowPort) => {
          const artifact = await buildExportArtifact(shadowPort, { projectId });
          await dropDatabase(server, database);
          await createDatabase(server, database);
          const fresh = createArcadeDbPort({ server, database });
          const imported = await importGraph(fresh, { text: artifact.text });
          if (!imported.ok) {
            await fresh.close();
            throw new Error(`importing the transformed graph failed: ${imported.violations[0]?.message}`);
          }
          return { port: fresh, dispose: async () => fresh.close() };
        },
      };

      async function liveExportText() {
        return withLivePort(async (port) => {
          const artifact = await buildExportArtifact(port, { projectId });
          return artifact.text;
        });
      }

      const result = await migrateSchema(createArcadeDbPort({ server, database }), {
        projectId,
        transform: renameTransform('body', 'ext_v1_body'),
        options: liveHooks,
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.postCutover.validated, true);

      const migrated = await withLivePort(async (port) => {
        const rule = await ruleNode(port, projectId, qid(projectId, 'rule:sanitize-external-input'));
        const validation = await validateGraph(port, { projectId });
        return { rule, validation };
      });
      assert.equal(migrated.rule.properties.body, undefined);
      assert.equal(migrated.rule.properties.ext_v1_body, 'Every external value must be sanitized.');
      assert.equal(migrated.validation.ok, true, migrated.validation.violations.map((v) => v.message).join('; '));
      assert.ok(!(await listDatabases(server)).includes(shadowDatabase), 'the shadow database must be dropped after cutover');
    });
  });
}


for (const evidence of ['failed', 'corrupt']) {
  test(`migration refuses ${evidence} backup evidence before any cutover`, async () => {
    const port = await buildValidPort();
    try {
      const before = await buildExportArtifact(port, { projectId: PROJECT, clock: () => '2026-10-23T00:00:00.000Z' });
      let cutovers = 0;
      const hooks = memoryHooks({ primaryPort: port, cutoverImpl: async () => { cutovers++; throw new Error('must not cut over'); } });
      hooks.backup = async () => ({ ok: evidence !== 'failed', text: evidence === 'failed' ? before.text : 'corrupt backup', filePath: '/unused' });
      const result = await migrateSchema(port, { projectId: PROJECT, transform: renameTransform('body', 'ext_v1_body'), options: hooks });
      assert.equal(result.ok, false);
      assert.equal(result.code, MIGRATE_ERROR_CODES.VERIFIED_BACKUP_FAILED);
      assert.equal(cutovers, 0);
      assert.equal((await buildExportArtifact(port, { projectId: PROJECT, clock: () => '2026-10-23T00:00:00.000Z' })).text, before.text);
    } finally { await port.close(); }
  });
}

for (const failure of ['open', 'directory-sync', 'corrupt']) {
  test(`CLI forced restore refuses ${failure} backup before destructive engine calls`, async () => {
    const dir = tempDir('force-backup-fault-');
    const port = await buildValidPort();
    let seed;
    try { seed = await buildExportArtifact(port, { projectId: PROJECT }); } finally { await port.close(); }
    const seedFile = join(dir, 'seed.jsonl');
    writeFileSync(seedFile, seed.text);
    const runner = join(dir, 'runner.mjs');
    const receipt = join(dir, 'receipt.json');
    const moduleUrl = (path) => new URL(path, import.meta.url).href;
    // Redirect only external engine/lifecycle edges. The seeded memory port, artifact parser,
    // forced-restore orchestration and all graph transactions execute the production modules.
    writeFileSync(runner, `
      import fs from 'node:fs';
      import { registerHooks, syncBuiltinESMExports } from 'node:module';
      import { dirname } from 'node:path';
      import { createMemoryPort } from ${JSON.stringify(moduleUrl('../scripts/formula/engine/memory.mjs'))};
      import { importGraph, buildExportArtifact } from ${JSON.stringify(moduleUrl('../scripts/formula/core/export.mjs'))};
      const port = createMemoryPort();
      const seeded = await importGraph(port, { filePath: ${JSON.stringify(seedFile)} });
      if (!seeded.ok) throw new Error('seed import failed');
      const clock = () => '2026-10-23T00:00:00.000Z';
      const before = (await buildExportArtifact(port, { projectId: ${JSON.stringify(PROJECT)}, clock })).text;
      const calls = [];
      globalThis.restoreTestPort = { ...port, close: async () => {} };
      globalThis.restoreTestCalls = calls;
      registerHooks({ load(url, context, next) {
        if (url === ${JSON.stringify(moduleUrl('../scripts/formula/engine/arcadedb.mjs'))}) return { format: 'module', shortCircuit: true, source: \
          "export * from " + JSON.stringify(url + '?original') + "; export const createArcadeDbPort = () => globalThis.restoreTestPort; export const databaseNameFor = p => p; export const listDatabases = async () => [" + JSON.stringify(${JSON.stringify(PROJECT)}) + "]; export const dropDatabase = async () => { globalThis.restoreTestCalls.push('drop'); }; export const createDatabase = async () => { globalThis.restoreTestCalls.push('create'); };" };
        if (url === ${JSON.stringify(moduleUrl('../scripts/formula/engine/lifecycle.mjs'))}) return { format: 'module', shortCircuit: true, source: \
          "export * from " + JSON.stringify(url + '?original') + "; export const SERVER_STATUS = { READY: 'ready' }; export const serverStatus = async () => ({ status: 'ready' });" };
        return next(url, context);
      }});
      const open = fs.openSync, sync = fs.fsyncSync, read = fs.readFileSync, mkdir = fs.mkdtempSync;
      const dirs = new Set(), dirFds = new Set();
      let fired = false;
      fs.mkdtempSync = (prefix, ...args) => {
        if (String(prefix).includes('steepy-formula-prestore-')) { const path = mkdir(${JSON.stringify(join(dir, 'prestore-'))}, ...args); dirs.add(fs.realpathSync(path)); return path; }
        return mkdir(prefix, ...args);
      };
      fs.openSync = (path, flags, mode) => {
        if (${JSON.stringify(failure)} === 'open' && typeof flags === 'number' && (flags & fs.constants.O_CREAT) && dirs.has(fs.realpathSync(dirname(String(path))))) {
          fired = true; throw Object.assign(new Error('injected backup open failure'), { code: 'EIO' });
        }
        const fd = open(path, flags, mode); if (fs.fstatSync(fd).isDirectory() && dirs.has(fs.realpathSync(path))) dirFds.add(fd); return fd;
      };
      fs.fsyncSync = (fd) => { if (${JSON.stringify(failure)} === 'directory-sync' && dirFds.has(fd)) { fired = true; throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' }); } return sync(fd); };
      fs.readFileSync = (path, ...args) => { if (${JSON.stringify(failure)} === 'corrupt' && String(path).endsWith('-pre-restore.jsonl')) { fired = true; return 'corrupt backup'; } return read(path, ...args); };
      syncBuiltinESMExports();
      const { main } = await import(${JSON.stringify(moduleUrl('../scripts/formula/cli.mjs'))});
      const status = await main(['graph', 'restore', '--project', ${JSON.stringify(PROJECT)}, '--from', ${JSON.stringify(seedFile)}, '--force']);
      const after = (await buildExportArtifact(port, { projectId: ${JSON.stringify(PROJECT)}, clock })).text;
      fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ calls, unchanged: before === after, fired }));
      await port.close(); process.exitCode = status;
    `);
    const result = spawnSync(process.execPath, [runner], { encoding: 'utf8', env: process.env });
    assert.ok(existsSync(receipt), result.stdout + result.stderr);
    const observed = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.equal(observed.fired, true, 'the requested backup boundary was exercised');
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.deepEqual(observed.calls, [], 'never drop or recreate after a failed or unverified backup');
    assert.equal(observed.unchanged, true);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /internal error|TypeError/);
  });
}
