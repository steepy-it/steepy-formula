// Signed export / restore / retention suite (Task B6, spec §22, success criteria 9 and 14).
// Every case that touches storage drives the module through a REAL port adapter (the B3
// in-memory reference), exactly like B4/B5's suites: the round-trip contract is "export the
// graph a real adapter holds, restore it into a fresh one, and have B4's validator plus B5's
// chain judgement come back green" — a hand-built plain-object fixture would not exercise any
// of that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { withTransaction } from '../scripts/formula/engine/port.mjs';
import { validateGraph, systemRecordId } from '../scripts/formula/core/validate-graph.mjs';
import { applyChangeSet, canonicalize, readChain, replayChain, sha256Hex, verifyChain } from '../scripts/formula/core/revision.mjs';
import {
  EXPORT_FORMAT_VERSION,
  EXPORT_NAMESPACES,
  EXPORT_VIOLATION_CODES,
  buildExportArtifact,
  exportGraph,
  importGraph,
  parseExportArtifact,
  pruneExportDirectory,
  pruneExports,
} from '../scripts/formula/core/export.mjs';

const PROJECT = 'proj';

const ID = {
  project: 'apex:proj:project:root',
  surface: 'apex:proj:surface:scripts',
  rule: 'apex:proj:rule:sanitize-external-input',
  ruleV2: 'apex:proj:rule:sanitize-external-input-v2',
  check: 'apex:proj:check:surface-test',
  agent: 'apex:proj:agent:scripts-agent',
  repository: 'apex:proj:repository:root',
};

function addNode(type, id, properties = {}, namespace = 'curated') {
  // Repository-derived types (topology namespace) carry only identity — no lifecycle `status`
  // (B1's `REPOSITORY_BASE_PROPERTIES`); everything else is a curated node with the base
  // `{ id, status }` shape.
  const base = namespace === 'topology' ? { id } : { id, status: 'active' };
  return { op: 'ADD', target: 'node', namespace, type, id, properties: { ...base, ...properties } };
}

function addEdge(type, fromId, toId, namespace = 'curated') {
  return { op: 'ADD', target: 'edge', namespace, type, fromId, toId };
}

function baseMeta(overrides = {}) {
  return {
    projectId: PROJECT,
    proposer: { type: 'agent-proposer', id: 'scripts-agent' },
    approver: { type: 'human-approver', id: 'steepy-it' },
    provenance: [{ quotation: 'Every approved promotion writes a signed export.', source: 'docs/spec.md:566', digest: 'a'.repeat(64) }],
    timestamp: '2026-08-12T10:00:00.000Z',
    ...overrides,
  };
}

async function applyOk(port, changeSet, metaOverrides = {}) {
  const result = await applyChangeSet(port, changeSet, baseMeta(metaOverrides));
  assert.deepEqual(result.violations, [], 'expected a clean apply');
  assert.equal(result.ok, true);
  return result.revision;
}

async function withPort(fn) {
  const port = createMemoryPort();
  try {
    return await fn(port);
  } finally {
    await port.close();
  }
}

function ruleOp(id, overrides = {}) {
  return {
    op: 'ADD',
    target: 'node',
    namespace: 'curated',
    type: 'Rule',
    id,
    properties: {
      id,
      title: 'Sanitize external input',
      statement: 'Sanitize every external value before writing it to disk.',
      status: 'active',
      strength: 'must',
      category: 'security',
      concern: 'external-input',
      provenance: { source: 'docs/spec.md', line: 52 },
      ...overrides,
    },
  };
}

// A complete, B4-valid curated + topology graph promoted the way the product promotes: one
// ChangeSet per step, including a topology write (chained too, per B5) and a SUPERSEDE so the
// exported system namespace carries more than a genesis revision.
async function promoteValidGraph(port) {
  await applyOk(port, { operations: [addNode('Project', ID.project)] });
  await applyOk(port, { operations: [addNode('Surface', ID.surface), addEdge('PART_OF', ID.surface, ID.project)] });
  await applyOk(port, {
    operations: [
      addNode('Agent', ID.agent),
      addEdge('OWNED_BY', ID.surface, ID.agent),
      addNode('Check', ID.check),
      ruleOp(ID.rule),
      addEdge('APPLIES_TO', ID.rule, ID.surface),
      addEdge('VERIFIED_BY', ID.rule, ID.check),
    ],
  });
  await applyOk(port, { operations: [addNode('Repository', ID.repository, {}, 'topology')] });
  await applyOk(port, {
    operations: [
      {
        op: 'SUPERSEDE',
        target: 'node',
        namespace: 'curated',
        supersededId: ID.rule,
        type: 'Rule',
        id: ID.ruleV2,
        properties: ruleOp(ID.ruleV2).properties,
      },
      // The superseding Rule needs its own explicit scope (B4: ACTIVE_RULE_WITHOUT_SCOPE) — a
      // SUPERSEDE materializes the node and the SUPERSEDES edge, never a scope edge.
      addEdge('APPLIES_TO', ID.ruleV2, ID.surface),
    ],
  });
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'steepy-export-'));
}

function readNamespaces(port, namespaces) {
  return withTransaction(port, async (tx) => {
    const out = {};
    for (const namespace of namespaces) {
      out[namespace] = {
        nodes: (await tx.listNodes({ namespace })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        edges: (await tx.listEdges({ namespace })).sort((a, b) => {
          const ka = `${a.type} ${a.fromId} ${a.toId}`;
          const kb = `${b.type} ${b.fromId} ${b.toId}`;
          return ka < kb ? -1 : ka > kb ? 1 : 0;
        }),
      };
    }
    return out;
  });
}

// --- artifact shape on an empty graph (batch A) -----------------------------------------------

test('buildExportArtifact on a never-promoted graph declares a null head and zero counts', async () => {
  await withPort(async (port) => {
    const artifact = await buildExportArtifact(port, { projectId: PROJECT, clock: () => '2026-08-12T00:00:00.000Z' });
    assert.equal(artifact.header.recordType, 'header');
    assert.equal(artifact.header.formatVersion, EXPORT_FORMAT_VERSION);
    assert.equal(artifact.header.projectId, PROJECT);
    assert.equal(artifact.header.headRevision, null);
    assert.deepEqual(artifact.header.counts, { nodes: 0, edges: 0 });
    assert.equal(artifact.header.exportedAt, '2026-08-12T00:00:00.000Z');
    assert.deepEqual(artifact.records, []);
    assert.equal(artifact.trailer.recordType, 'trailer');
    assert.match(artifact.trailer.digest, /^[0-9a-f]{64}$/);
    // Two lines: header + trailer, nothing in between, trailing newline, each a canonical
    // (sorted-key) JSON line — never insertion-order `JSON.stringify`.
    assert.equal(artifact.text, `${canonicalize(artifact.header)}\n${canonicalize(artifact.trailer)}\n`);
  });
});

test('buildExportArtifact declares the head revision it represents', async () => {
  await withPort(async (port) => {
    await promoteValidGraph(port);
    const { headRevision } = await readChain(port, { projectId: PROJECT });
    const artifact = await buildExportArtifact(port, { projectId: PROJECT });
    assert.equal(artifact.header.headRevision, headRevision);
    assert.ok(artifact.header.headRevision);
  });
});

test('buildExportArtifact excludes the scenario namespace entirely', async () => {
  await withPort(async (port) => {
    await promoteValidGraph(port);
    await withTransaction(port, (tx) =>
      tx.createNode({
        namespace: 'scenario',
        scenarioId: 's1',
        type: 'PromotionScenario',
        id: 'apex:proj:scenario:meta',
        properties: { baseRevision: null },
      }),
    );
    const artifact = await buildExportArtifact(port, { projectId: PROJECT });
    assert.ok(artifact.records.every((record) => record.namespace !== 'scenario'));
    assert.deepEqual([...EXPORT_NAMESPACES], ['curated', 'topology', 'system']);
  });
});

test('buildExportArtifact orders records deterministically regardless of insertion order', async () => {
  const artifactA = await withPort(async (port) => {
    await applyOk(port, { operations: [addNode('Term', 'apex:proj:term:c'), addNode('Term', 'apex:proj:term:a'), addNode('Term', 'apex:proj:term:b')] });
    return buildExportArtifact(port, { projectId: PROJECT, clock: () => '2026-08-12T00:00:00.000Z' });
  });
  const artifactB = await withPort(async (port) => {
    await applyOk(port, { operations: [addNode('Term', 'apex:proj:term:a')] });
    await applyOk(port, { operations: [addNode('Term', 'apex:proj:term:b')] });
    await applyOk(port, { operations: [addNode('Term', 'apex:proj:term:c')] });
    return buildExportArtifact(port, { projectId: PROJECT, clock: () => '2026-08-12T00:00:00.000Z' });
  });
  // Different chains (different sequence of ChangeSets) so the system-namespace records differ,
  // but the curated node ordering — the part under test — must be identical either way.
  const nodeIdsA = artifactA.records.filter((r) => r.recordType === 'node' && r.type === 'Term').map((r) => r.id);
  const nodeIdsB = artifactB.records.filter((r) => r.recordType === 'node' && r.type === 'Term').map((r) => r.id);
  assert.deepEqual(nodeIdsA, ['apex:proj:term:a', 'apex:proj:term:b', 'apex:proj:term:c']);
  assert.deepEqual(nodeIdsA, nodeIdsB);
});

test('buildExportArtifact is byte-identical across repeated exports of the same graph state (criterion 14 spirit)', async () => {
  await withPort(async (port) => {
    await promoteValidGraph(port);
    const clock = () => '2026-08-12T00:00:00.000Z';
    const first = await buildExportArtifact(port, { projectId: PROJECT, clock });
    const second = await buildExportArtifact(port, { projectId: PROJECT, clock });
    assert.equal(first.text, second.text);
  });
});

test('buildExportArtifact throws on programmer error, never on graph content', async () => {
  await assert.rejects(() => buildExportArtifact(undefined, { projectId: PROJECT }), TypeError);
  await withPort(async (port) => {
    await assert.rejects(() => buildExportArtifact(port, { projectId: 'not valid!' }), TypeError);
    await assert.rejects(() => buildExportArtifact(port, { projectId: PROJECT, bogus: true }), TypeError);
  });
});

// --- round trip: export -> import into a fresh port -> validator + chain green (batch B) --------

test('export -> import into a fresh port: validateGraph green, verifyChain/replayChain green, structurally equal', async () => {
  const dir = tmpDir();
  try {
    const filePath = join(dir, 'export.jsonl');
    const before = await withPort(async (sourcePort) => {
      await promoteValidGraph(sourcePort);
      const result = await exportGraph(sourcePort, { projectId: PROJECT, filePath, clock: () => '2026-08-12T00:00:00.000Z' });
      assert.equal(result.ok, true);
      assert.equal(result.filePath, filePath);
      const { headRevision } = await readChain(sourcePort, { projectId: PROJECT });
      assert.equal(result.headRevision, headRevision);
      return readNamespaces(sourcePort, EXPORT_NAMESPACES);
    });

    assert.ok(existsSync(filePath));

    await withPort(async (targetPort) => {
      const imported = await importGraph(targetPort, { filePath });
      assert.deepEqual(imported.violations, []);
      assert.equal(imported.ok, true);
      assert.equal(imported.projectId, PROJECT);

      const validated = await validateGraph(targetPort, { projectId: PROJECT });
      assert.deepEqual(validated.violations, []);
      assert.equal(validated.ok, true);

      const verified = await verifyChain(targetPort, { projectId: PROJECT });
      assert.deepEqual(verified.violations, []);
      assert.equal(verified.ok, true);

      const replayed = await replayChain(targetPort, { projectId: PROJECT });
      assert.deepEqual(replayed.violations, []);
      assert.equal(replayed.ok, true);
      assert.deepEqual(replayed.unexplained, { nodes: [], edges: [] });
      assert.deepEqual(replayed.missing, { nodes: [], edges: [] });

      const after = await readNamespaces(targetPort, EXPORT_NAMESPACES);
      assert.deepEqual(after, before);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bridge-bearing graph round-trips: import creates all nodes before any edge (E2 restore drill)', async () => {
  // E2's restore drill surfaced that importGraph created edges in export record order — a
  // curated-home bridge edge (APPLIES_TO -> a topology Package) is written before the topology
  // node block, so createEdge failed EDGE_ENDPOINT_MISSING on exactly the cross-namespace edges
  // a real graph carries. This is the regression: a graph with both declared bridges restores
  // into a fresh port and validates green.
  const text = await withPort(async (sourcePort) => {
    await applyOk(sourcePort, { operations: [addNode('Project', ID.project)] });
    await applyOk(sourcePort, { operations: [addNode('Surface', ID.surface), addEdge('PART_OF', ID.surface, ID.project)] });
    await applyOk(sourcePort, {
      operations: [addNode('Component', 'apex:proj:component:c0'), addEdge('PART_OF', 'apex:proj:component:c0', ID.surface)],
    });
    await applyOk(sourcePort, {
      operations: [addNode('Check', ID.check), ruleOp(ID.rule), addEdge('VERIFIED_BY', ID.rule, ID.check), addEdge('APPLIES_TO', ID.rule, ID.surface)],
    });
    await applyOk(sourcePort, { operations: [addNode('Repository', ID.repository, {}, 'topology')] });
    await applyOk(sourcePort, {
      operations: [
        addNode('Workspace', 'apex:proj:workspace:w0', { path: '.' }, 'topology'),
        addEdge('PART_OF', 'apex:proj:workspace:w0', ID.repository, 'topology'),
      ],
    });
    await applyOk(sourcePort, {
      operations: [
        addNode('Package', 'apex:proj:package:p0', { path: 'packages/pkg-000' }, 'topology'),
        addEdge('PART_OF', 'apex:proj:package:p0', 'apex:proj:workspace:w0', 'topology'),
        addEdge('IMPLEMENTS', 'apex:proj:package:p0', 'apex:proj:component:c0', 'topology'),
      ],
    });
    // The record-order-breaking bridge: a curated-home APPLIES_TO whose endpoint is a topology
    // Package — exported in the curated edge block, before any topology node.
    await applyOk(sourcePort, { operations: [addEdge('APPLIES_TO', ID.rule, 'apex:proj:package:p0')] });
    const artifact = await buildExportArtifact(sourcePort, { projectId: PROJECT });
    return artifact.text;
  });

  await withPort(async (targetPort) => {
    const imported = await importGraph(targetPort, { text });
    assert.equal(imported.ok, true, JSON.stringify(imported.violations?.[0] ?? null));
    const validated = await validateGraph(targetPort, { projectId: PROJECT });
    assert.deepEqual(validated.violations, []);
    assert.equal(validated.ok, true);
  });
});

test('importGraph accepts an in-memory artifact via `text`, no filesystem involved', async () => {
  const text = await withPort(async (sourcePort) => {
    await promoteValidGraph(sourcePort);
    const artifact = await buildExportArtifact(sourcePort, { projectId: PROJECT });
    return artifact.text;
  });

  await withPort(async (targetPort) => {
    const imported = await importGraph(targetPort, { text });
    assert.equal(imported.ok, true);
    const validated = await validateGraph(targetPort, { projectId: PROJECT });
    assert.equal(validated.ok, true);
  });
});

test('a graph with nothing promoted round-trips to an empty, still-valid-shape target', async () => {
  await withPort(async (sourcePort) => {
    const artifact = await buildExportArtifact(sourcePort, { projectId: PROJECT });
    await withPort(async (targetPort) => {
      const imported = await importGraph(targetPort, { text: artifact.text });
      assert.equal(imported.ok, true);
      assert.equal(imported.headRevision, null);
      const after = await readNamespaces(targetPort, EXPORT_NAMESPACES);
      for (const namespace of EXPORT_NAMESPACES) {
        assert.deepEqual(after[namespace], { nodes: [], edges: [] });
      }
    });
  });
});

// --- import refuses a non-empty target (batch C) -------------------------------------------------

test('importGraph refuses a non-empty target and writes nothing', async () => {
  const text = await withPort(async (sourcePort) => {
    await promoteValidGraph(sourcePort);
    const artifact = await buildExportArtifact(sourcePort, { projectId: PROJECT });
    return artifact.text;
  });

  await withPort(async (targetPort) => {
    // A raw out-of-band write (bypassing `applyChangeSet`, which would also create the
    // `system` GraphMetadata record) so this test isolates ONE non-empty namespace.
    await withTransaction(targetPort, (tx) =>
      tx.createNode({ namespace: 'curated', type: 'Term', id: 'apex:proj:term:already-here', properties: { id: 'apex:proj:term:already-here', status: 'active' } }),
    );
    const before = await readNamespaces(targetPort, EXPORT_NAMESPACES);

    const imported = await importGraph(targetPort, { text });
    assert.equal(imported.ok, false);
    assert.equal(imported.violations.length, 1);
    assert.equal(imported.violations[0].code, EXPORT_VIOLATION_CODES.NON_EMPTY_IMPORT_TARGET);
    assert.deepEqual(imported.violations[0].identity, { namespaces: ['curated'] });

    const after = await readNamespaces(targetPort, EXPORT_NAMESPACES);
    assert.deepEqual(after, before);
  });
});

test('importGraph refuses a target whose only content is in the system namespace', async () => {
  const text = await withPort(async (sourcePort) => {
    await promoteValidGraph(sourcePort);
    const artifact = await buildExportArtifact(sourcePort, { projectId: PROJECT });
    return artifact.text;
  });

  await withPort(async (targetPort) => {
    await withTransaction(targetPort, (tx) =>
      tx.createNode({ namespace: 'system', type: 'GraphMetadata', id: systemRecordId(PROJECT), properties: { schemaVersion: 1, headRevision: null } }),
    );
    const imported = await importGraph(targetPort, { text });
    assert.equal(imported.ok, false);
    assert.equal(imported.violations[0].code, EXPORT_VIOLATION_CODES.NON_EMPTY_IMPORT_TARGET);
    assert.deepEqual(imported.violations[0].identity, { namespaces: ['system'] });
  });
});

// --- digest verification and malformed artifacts (batch D) ---------------------------------------

test('importGraph verifies the digest before writing anything: a tampered record is refused', async () => {
  const text = await withPort(async (sourcePort) => {
    await promoteValidGraph(sourcePort);
    const artifact = await buildExportArtifact(sourcePort, { projectId: PROJECT });
    return artifact.text;
  });
  const tampered = text.replace('"Check"', '"Decision"');
  assert.notEqual(tampered, text);

  await withPort(async (targetPort) => {
    const imported = await importGraph(targetPort, { text: tampered });
    assert.equal(imported.ok, false);
    assert.equal(imported.violations.length, 1);
    assert.equal(imported.violations[0].code, EXPORT_VIOLATION_CODES.EXPORT_DIGEST_MISMATCH);

    const after = await readNamespaces(targetPort, EXPORT_NAMESPACES);
    for (const namespace of EXPORT_NAMESPACES) assert.deepEqual(after[namespace], { nodes: [], edges: [] });
  });
});

test('importGraph verifies the digest before writing anything: a tampered trailer is refused', async () => {
  const text = await withPort(async (sourcePort) => {
    await promoteValidGraph(sourcePort);
    const artifact = await buildExportArtifact(sourcePort, { projectId: PROJECT });
    return artifact.text;
  });
  const lines = text.split('\n').filter((line) => line.length > 0);
  const trailer = JSON.parse(lines[lines.length - 1]);
  trailer.digest = '0'.repeat(64);
  const tampered = `${[...lines.slice(0, -1), JSON.stringify(trailer)].join('\n')}\n`;

  const parsed = parseExportArtifact(tampered);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.violations[0].code, EXPORT_VIOLATION_CODES.EXPORT_DIGEST_MISMATCH);
});

test('parseExportArtifact reports a malformed artifact as a structured violation, never a throw', () => {
  assert.throws(() => parseExportArtifact(42), TypeError);

  const tooShort = parseExportArtifact('{"recordType":"header"}\n');
  assert.equal(tooShort.ok, false);
  assert.equal(tooShort.violations[0].code, EXPORT_VIOLATION_CODES.MALFORMED_EXPORT_ARTIFACT);

  const badJson = parseExportArtifact('not json at all\n{"recordType":"trailer","digest":"x"}\n');
  assert.equal(badJson.ok, false);
  assert.equal(badJson.violations[0].code, EXPORT_VIOLATION_CODES.MALFORMED_EXPORT_ARTIFACT);

  const badRecordType = parseExportArtifact(
    '{"recordType":"header","formatVersion":1,"projectId":"proj","headRevision":null,"exportedAt":"x","counts":{"nodes":0,"edges":0}}\n' +
      '{"recordType":"bogus"}\n' +
      `{"recordType":"trailer","digest":"${'0'.repeat(64)}"}\n`,
  );
  assert.equal(badRecordType.ok, false);
  assert.equal(badRecordType.violations[0].code, EXPORT_VIOLATION_CODES.MALFORMED_EXPORT_ARTIFACT);
});

test('parseExportArtifact refuses an unsupported format version', () => {
  const header = canonicalize({
    recordType: 'header',
    formatVersion: 999,
    projectId: PROJECT,
    headRevision: null,
    exportedAt: '2026-08-12T00:00:00.000Z',
    counts: { nodes: 0, edges: 0 },
  });
  const trailer = canonicalize({ recordType: 'trailer', digest: sha256Hex([header].join('\n')) });
  const result = parseExportArtifact(`${header}\n${trailer}\n`);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].code, EXPORT_VIOLATION_CODES.UNSUPPORTED_EXPORT_FORMAT_VERSION);
});

test('importGraph throws on programmer error (no port, unknown key, neither/both of filePath+text)', async () => {
  await assert.rejects(() => importGraph(undefined, { text: 'x' }), TypeError);
  await withPort(async (port) => {
    await assert.rejects(() => importGraph(port, {}), TypeError);
    await assert.rejects(() => importGraph(port, { text: 'x', filePath: 'y' }), TypeError);
    await assert.rejects(() => importGraph(port, { text: 'x', bogus: true }), TypeError);
  });
});

// --- retention: pure decision function (batch E) --------------------------------------------------

test('pruneExports keeps exactly the N most recent when keepDaily is off', () => {
  const listing = [
    { name: 'e1', timestamp: '2026-08-08T00:00:00.000Z' },
    { name: 'e2', timestamp: '2026-08-09T00:00:00.000Z' },
    { name: 'e3', timestamp: '2026-08-10T00:00:00.000Z' },
    { name: 'e4', timestamp: '2026-08-11T00:00:00.000Z' },
    { name: 'e5', timestamp: '2026-08-12T00:00:00.000Z' },
  ];
  const decision = pruneExports(listing, { keepLast: 2, keepDaily: false });
  assert.deepEqual(decision.keep, ['e5', 'e4']);
  assert.deepEqual(decision.drop, ['e3', 'e2', 'e1']);
});

test('pruneExports keeps one export per day beyond the last-N window when keepDaily is on', () => {
  const listing = [
    { name: 'day1-a', timestamp: '2026-08-10T01:00:00.000Z' },
    { name: 'day1-b', timestamp: '2026-08-10T23:00:00.000Z' }, // most recent of day 1
    { name: 'day2-a', timestamp: '2026-08-11T01:00:00.000Z' },
    { name: 'day2-b', timestamp: '2026-08-11T23:00:00.000Z' }, // most recent of day 2, and inside last-1
  ];
  const decision = pruneExports(listing, { keepLast: 1, keepDaily: true });
  // last-1 keeps day2-b; keepDaily then keeps the most-recent-per-day for every OTHER day: day1-b.
  assert.deepEqual(new Set(decision.keep), new Set(['day2-b', 'day1-b']));
  assert.deepEqual(new Set(decision.drop), new Set(['day2-a', 'day1-a']));
});

test('pruneExports with keepLast 0 and keepDaily true keeps exactly one export per day', () => {
  const listing = [
    { name: 'a', timestamp: '2026-08-10T01:00:00.000Z' },
    { name: 'b', timestamp: '2026-08-10T23:00:00.000Z' },
    { name: 'c', timestamp: '2026-08-11T05:00:00.000Z' },
  ];
  const decision = pruneExports(listing, { keepLast: 0, keepDaily: true });
  assert.deepEqual(new Set(decision.keep), new Set(['b', 'c']));
  assert.deepEqual(decision.drop, ['a']);
});

test('pruneExports with keepLast 0 and keepDaily false drops everything', () => {
  const listing = [{ name: 'a', timestamp: '2026-08-10T01:00:00.000Z' }];
  const decision = pruneExports(listing, { keepLast: 0, keepDaily: false });
  assert.deepEqual(decision, { keep: [], drop: ['a'] });
});

test('pruneExports on an empty listing keeps and drops nothing', () => {
  assert.deepEqual(pruneExports([], { keepLast: 5, keepDaily: true }), { keep: [], drop: [] });
});

test('pruneExports defaults to keepLast 0, keepDaily false when config omits them', () => {
  const listing = [{ name: 'a', timestamp: '2026-08-10T01:00:00.000Z' }];
  assert.deepEqual(pruneExports(listing, {}), { keep: [], drop: ['a'] });
});

test('pruneExports is deterministic: the same listing and config always produce the same decision', () => {
  const listing = [
    { name: 'e1', timestamp: '2026-08-08T00:00:00.000Z' },
    { name: 'e2', timestamp: '2026-08-09T00:00:00.000Z' },
    { name: 'e3', timestamp: '2026-08-10T00:00:00.000Z' },
  ];
  const config = { keepLast: 1, keepDaily: true };
  assert.deepEqual(pruneExports(listing, config), pruneExports(listing, config));
  assert.deepEqual(pruneExports([...listing].reverse(), config), pruneExports(listing, config));
});

test('pruneExports throws on programmer error: bad listing shape or bad config', () => {
  assert.throws(() => pruneExports('nope', { keepLast: 1 }), TypeError);
  assert.throws(() => pruneExports([{ name: 'a' }], { keepLast: 1 }), TypeError);
  assert.throws(() => pruneExports([{ name: 'a', timestamp: 'x' }], { keepLast: -1 }), TypeError);
  assert.throws(() => pruneExports([{ name: 'a', timestamp: 'x' }], { keepLast: 1, keepDaily: 'yes' }), TypeError);
  assert.throws(() => pruneExports([{ name: 'a', timestamp: 'x' }], { bogus: true }), TypeError);
});

// --- retention on disk: thin fs wrapper (batch F) --------------------------------------------------

test('pruneExportDirectory reads timestamps from each artifact header and deletes exactly the drop set', async () => {
  const dir = tmpDir();
  try {
    const clocks = ['2026-08-08T00:00:00.000Z', '2026-08-09T00:00:00.000Z', '2026-08-10T00:00:00.000Z'];
    const files = [];
    for (const [index, iso] of clocks.entries()) {
      const filePath = join(dir, `export-${index}.jsonl`);
      await withPort(async (port) => {
        if (index === clocks.length - 1) await promoteValidGraph(port);
        await exportGraph(port, { projectId: PROJECT, filePath, clock: () => iso });
      });
      files.push(filePath);
    }
    // A non-export .jsonl file in the same directory must not confuse the wrapper.
    const unrelated = join(dir, 'unrelated.jsonl');
    writeFileSync(unrelated, '{"not":"an export"}\n');

    const decision = pruneExportDirectory(dir, { keepLast: 1, keepDaily: false });
    assert.deepEqual(decision.keep, ['export-2.jsonl']);
    assert.deepEqual(new Set(decision.drop), new Set(['export-0.jsonl', 'export-1.jsonl']));

    assert.ok(existsSync(files[2]));
    assert.ok(!existsSync(files[0]));
    assert.ok(!existsSync(files[1]));
    assert.ok(existsSync(unrelated), 'the unrelated .jsonl file must survive retention untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneExportDirectory accepts an injected fs and never touches the real disk when given one', () => {
  const files = {
    'export-old.jsonl': `${canonicalize({ recordType: 'header', formatVersion: 1, projectId: PROJECT, headRevision: null, exportedAt: '2026-08-01T00:00:00.000Z', counts: { nodes: 0, edges: 0 } })}\n{"recordType":"trailer","digest":"x"}\n`,
    'export-new.jsonl': `${canonicalize({ recordType: 'header', formatVersion: 1, projectId: PROJECT, headRevision: null, exportedAt: '2026-08-12T00:00:00.000Z', counts: { nodes: 0, edges: 0 } })}\n{"recordType":"trailer","digest":"y"}\n`,
  };
  const deleted = [];
  const fakeFs = {
    readdirSync: () => Object.keys(files),
    readFileSync: (path) => files[path.split('/').pop()],
    unlinkSync: (path) => deleted.push(path.split('/').pop()),
  };

  const decision = pruneExportDirectory('/fake/dir', { keepLast: 1, keepDaily: false }, { fs: fakeFs });
  assert.deepEqual(decision.keep, ['export-new.jsonl']);
  assert.deepEqual(decision.drop, ['export-old.jsonl']);
  assert.deepEqual(deleted, ['export-old.jsonl']);
});
