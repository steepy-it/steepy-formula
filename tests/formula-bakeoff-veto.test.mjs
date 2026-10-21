// E2 — eliminatory bake-off veto suite against pinned-stable ArcadeDB (spec §23 items 2–4,
// success criterion 13, B5 rout-forward (c)). Every eliminatory test genuinely crashes or
// restarts the engine and asserts against the POST-restart state; a test that never crashed would
// never veto. The engine's own recovery verdict is what the suite records — not a simulation.
//
// The four eliminatory groups:
//   item 2  atomicity  — SIGKILL the CLIENT mid-promotion (one real apply in flight from a child
//                        process), prove from a fresh connection that the ONE-transaction apply
//                        left either the whole ChangeSet committed or nothing at all — no third
//                        state — and that a re-apply on the recovered graph succeeds cleanly.
//   item 3  durability — `docker kill` (SIGKILL, power loss) while a background writer has a big
//                        in-flight promotion and acknowledged commits behind it; restart the SAME
//                        container (WAL recovery) and prove the head is exactly the last
//                        acknowledged commit, verifyChain + validateGraph green, exact record
//                        counts (no torn records, no partial writes).
//   item 4  restore    — signed export -> destroy container + volume -> clean container -> import
//                        -> portable validation (validateGraph + verifyChain) green + byte-identical
//                        resolveContext equivalence for representative inputs.
//   item 5  OOB admin  — ADMIN writes a node+edge straight through the engine, bypassing the
//                        Promotion Service; chain replay reports the injected records with their
//                        EXACT identity (criterion 13). Detection, not prevention: ArcadeDB's
//                        per-database groups cannot stop the machine owner.
//   item 6  replay mem — B5 rout-forward (c): replay at the full E1 scale (25,521 nodes / 150,000
//                        edges) — peak memory + time recorded (soft ceiling against an O(n²)
//                        blow-up). Runs on the in-memory port: the measurement target is the JS
//                        replay path (port-only I/O), engine-independent, and 100x faster than the
//                        real engine (the brief budgets full scale only where the target requires
//                        it; the memory/time numbers are recorded in the ledger).
//
// Hygiene: docker-gated with the established explicit diagnostic on absence; every eliminatory
// test owns a hermetic container (created + destroyed in the test's own finally, belt-and-braces
// suite `after` destroys all four); no dependence on test order. Pinned
// `arcadedata/arcadedb:26.8.1` via lifecycle.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCADEDB_IMAGE,
  destroyContainer,
  dockerGate,
  dockerRun,
  startServer,
} from '../scripts/formula/engine/lifecycle.mjs';
import { EDGE_TYPE, NODE_TYPE, createArcadeDbPort, createDatabase, openDriver } from '../scripts/formula/engine/arcadedb.mjs';
import { applyChangeSet, readChain, replayChain, sha256Hex, verifyChain } from '../scripts/formula/core/revision.mjs';
import { exportGraph, importGraph } from '../scripts/formula/core/export.mjs';
import { resolveContext } from '../scripts/formula/core/resolve-context.mjs';
import { generateFixture } from '../scripts/formula/core/fixture-gen.mjs';
import { buildQualifiedId } from '../scripts/formula/core/ids.mjs';
import { validateGraph } from '../scripts/formula/core/validate-graph.mjs';

const PROJECT = 'fixture'; // the fixture generator's own project — fixture node ids are apex:fixture:*
const SMOKE_SCALE = 0.02;
const CONTAINERS = ['apex-bakeoff-atomicity', 'apex-bakeoff-durability', 'apex-bakeoff-restore', 'apex-bakeoff-oob'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const gate = dockerGate();

if (!gate.ok) {
  test(`bake-off veto suite (docker-gated): ${gate.reason}`, (t) => {
    t.diagnostic(`SKIPPED — ${gate.reason} (pinned image ${ARCADEDB_IMAGE})`);
    t.skip(gate.reason);
  });
} else {
  after(async () => {
    for (const name of CONTAINERS) await destroyContainer(name, { removeVolume: true }).catch(() => {});
  });

  // --- helpers ---------------------------------------------------------------------------------

  function baseMeta(projectId = PROJECT) {
    return {
      projectId,
      proposer: { type: 'agent-proposer', id: 'e2-writer' },
      approver: { type: 'human-approver', id: 'e2-approver' },
      provenance: [
        { quotation: 'E2 bake-off veto suite.', source: 'tests/formula-bakeoff-veto.test.mjs:1', digest: sha256Hex('e2') },
      ],
      timestamp: '2026-08-12T10:00:00.000Z',
    };
  }

  // One curated Component + PART_OF onto the fixture's surface:s0 — a B4-valid promotion a
  // promoted graph can carry, used for baselines and the write-load loop.
  function componentPromotion(projectId, label, seq) {
    const component = buildQualifiedId(projectId, `component:${label}${seq}`);
    const surface = buildQualifiedId(projectId, 'surface:s0');
    return [
      { op: 'ADD', target: 'node', namespace: 'curated', type: 'Component', id: component, properties: { id: component, status: 'active' } },
      { op: 'ADD', target: 'edge', namespace: 'curated', type: 'PART_OF', fromId: component, toId: surface },
    ];
  }

  // One topology Workspace with no edge dependencies — an endpoint-free add that appends cleanly
  // whatever the recovered head is (used for the post-crash re-apply).
  function workspacePromotion(projectId, label, seq) {
    const id = buildQualifiedId(projectId, `workspace:${label}${seq}`);
    return [
      { op: 'ADD', target: 'node', namespace: 'topology', type: 'Workspace', id, properties: { id, path: `workspaces/${label}-${seq}` } },
    ];
  }

  function fixtureChangeSet(fixture) {
    return {
      operations: [
        ...fixture.nodes.map((node) => ({ op: 'ADD', target: 'node', namespace: node.namespace, type: node.type, id: node.id, properties: node.properties })),
        ...fixture.edges.map((edge) => ({ op: 'ADD', target: 'edge', namespace: edge.namespace, type: edge.type, fromId: edge.fromId, toId: edge.toId })),
      ],
    };
  }

  // Recursively sorts every object's keys, mirroring the signed export's canonicalization. The
  // export format stores property bags with sorted keys (deterministic artifact bytes); a source
  // graph authored with insertion-ordered bags therefore comes back from a restore with a
  // different key ORDER but identical VALUES. The restore drill compares the same graph's context
  // byte-for-byte, so its source fixture is normalized to the same canonical form — this is what
  // makes "same graph in, same context bytes out" a real, key-order-independent assertion.
  function sortedKeys(value) {
    if (Array.isArray(value)) return value.map(sortedKeys);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = sortedKeys(value[key]);
      return out;
    }
    return value;
  }

  async function setupServer(name) {
    await destroyContainer(name, { removeVolume: true });
    const server = await startServer({ name, timeoutMs: 120_000 });
    const database = `apex_bakeoff_${randomUUID().replaceAll('-', '')}`;
    await createDatabase(server, database);
    const port = createArcadeDbPort({ server, database });
    return { server, database, port };
  }

  async function countStable(port) {
    const tx = await port.begin();
    try {
      let nodes = 0;
      let edges = 0;
      for (const namespace of ['curated', 'topology']) {
        nodes += (await tx.listNodes({ namespace })).length;
        edges += (await tx.listEdges({ namespace })).length;
      }
      return { nodes, edges };
    } finally {
      await tx.rollback();
    }
  }

  // A child Node process running a module script (cwd = repo root, so its relative imports
  // resolve). A JSON config is written to its stdin; the child owns its own engine connection.
  function spawnEval(script, { input } = {}) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (input !== undefined) {
      child.stdin.write(JSON.stringify(input) + '\n');
      child.stdin.end();
    }
    return child;
  }

  // Line-oriented reader over a child's stdout, with a promise-based wait for a matching line.
  function lineSink(child) {
    let buffer = '';
    let stderr = '';
    const listeners = new Set();
    const lines = [];
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === '') continue;
        lines.push(line);
        for (const listener of [...listeners]) listener(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    return {
      lines,
      stderr: () => stderr,
      waitFor(match, timeoutMs = 60_000, what = 'a matching line') {
        const existing = lines.find((line) => (typeof match === 'function' ? match(line) : line.includes(match)));
        if (existing !== undefined) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            listeners.delete(listener);
            reject(new Error(`timed out waiting for ${what} (have: ${lines.join(' | ') || 'nothing'}; stderr: ${stderr.slice(0, 300)})`));
          }, timeoutMs);
          const listener = (line) => {
            if (typeof match === 'function' ? match(line) : line.includes(match)) {
              clearTimeout(timer);
              listeners.delete(listener);
              resolve(line);
            }
          };
          listeners.add(listener);
        });
      },
    };
  }

  function exitOf(child, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the child did not exit in time')), timeoutMs);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  }

  // The child script the atomicity test drives: reads the endpoint + base revision from stdin,
  // signals APPLY_STARTED, then applies the smoke fixture as ONE ChangeSet on its OWN connection.
  // The parent kills it with SIGKILL mid-apply.
  const ATOMICITY_SCRIPT = `
import { createArcadeDbPort } from './scripts/formula/engine/arcadedb.mjs';
import { applyChangeSet } from './scripts/formula/core/revision.mjs';
import { generateFixture } from './scripts/formula/core/fixture-gen.mjs';
const config = JSON.parse(await new Promise((resolve) => {
  let buf = '';
  process.stdin.on('data', (chunk) => { buf += chunk; if (buf.includes('\\n')) resolve(buf.slice(0, buf.indexOf('\\n'))); });
  process.stdin.on('end', () => { if (buf) resolve(buf); });
}));
const port = createArcadeDbPort({ server: config.server, database: config.database });
const fixture = generateFixture('atomicity-smoke', { scale: 0.02 });
const operations = [
  ...fixture.nodes.map((n) => ({ op: 'ADD', target: 'node', namespace: n.namespace, type: n.type, id: n.id, properties: n.properties })),
  ...fixture.edges.map((e) => ({ op: 'ADD', target: 'edge', namespace: e.namespace, type: e.type, fromId: e.fromId, toId: e.toId })),
];
console.log('APPLY_STARTED');
const result = await applyChangeSet(port, { operations }, config.meta);
console.log('APPLY_DONE ' + (result.ok ? result.revision.id : 'FAIL'));
await port.close();
process.exit(0);
`;

  // The background writer the durability test kills under: small B4-valid promotions in a loop,
  // ACKing each acknowledged commit, and every 4th iteration a big in-flight promotion the parent
  // docker-kills the container over. Connection loss mid-write must leave the engine rolled back
  // to exactly the last ACK.
  const DURABILITY_WRITER_SCRIPT = `
import { createArcadeDbPort } from './scripts/formula/engine/arcadedb.mjs';
import { applyChangeSet } from './scripts/formula/core/revision.mjs';
const config = JSON.parse(await new Promise((resolve) => {
  let buf = '';
  process.stdin.on('data', (chunk) => { buf += chunk; if (buf.includes('\\n')) resolve(buf.slice(0, buf.indexOf('\\n'))); });
  process.stdin.on('end', () => { if (buf) resolve(buf); });
}));
const port = createArcadeDbPort({ server: config.server, database: config.database });
console.log('WRITER_READY');
let seq = 0;
for (;;) {
  seq += 1;
  const projectId = config.projectId;
  const isBig = seq % 4 === 0;
  const operations = isBig
    ? Array.from({ length: 1200 }, (_, k) => {
        const id = \`apex:\${projectId}:workspace:w-big-\${seq}-\${k}\`;
        return { op: 'ADD', target: 'node', namespace: 'topology', type: 'Workspace', id, properties: { id, path: \`workspaces/w-big-\${seq}-\${k}\` } };
      })
    : [
        { op: 'ADD', target: 'node', namespace: 'curated', type: 'Component', id: \`apex:\${projectId}:component:dw\${seq}\`, properties: { id: \`apex:\${projectId}:component:dw\${seq}\`, status: 'active' } },
        { op: 'ADD', target: 'edge', namespace: 'curated', type: 'PART_OF', fromId: \`apex:\${projectId}:component:dw\${seq}\`, toId: \`apex:\${projectId}:surface:s0\` },
      ];
  if (isBig) console.log('BIG_APPLY_START');
  try {
    const result = await applyChangeSet(port, { operations }, config.meta);
    if (result.ok) console.log('ACK ' + result.revision.id);
    else console.log('WRITER_FAIL ' + JSON.stringify(result.violations[0] ?? null));
  } catch (error) {
    console.log('WRITER_ERROR ' + (error && error.message ? String(error.message).slice(0, 200) : String(error)));
    process.exit(2);
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
}
`;

  // --- item 2: promotion atomicity (client kill mid-promotion) ---------------------------------

  test('item 2 — atomicity: SIGKILL mid-promotion leaves no half-applied ChangeSet and an intact chain', { timeout: 300_000 }, async (t) => {
    const name = CONTAINERS[0];
    const { server, database, port } = await setupServer(name);
    const projectId = PROJECT;
    try {
      // A self-contained baseline (endpoint-free, ids outside the fixture's): the one apply that
      // establishes the graph and its first Revision before the mid-promotion kill.
      const baselineTerm = buildQualifiedId(projectId, 'term:atomicity-base');
      const baseline = await applyChangeSet(
        port,
        {
          operations: [
            { op: 'ADD', target: 'node', namespace: 'curated', type: 'Term', id: baselineTerm, properties: { id: baselineTerm, status: 'active' } },
          ],
        },
        baseMeta(),
      );
      assert.equal(baseline.ok, true, `baseline apply failed: ${JSON.stringify(baseline.violations[0] ?? null)}`);
      const baselineHead = baseline.revision.id;
      const baselineCounts = await countStable(port);
      const smoke = generateFixture('atomicity-smoke', { scale: SMOKE_SCALE });

      const tSpawn = Date.now();
      const child = spawnEval(ATOMICITY_SCRIPT, { input: { server, database, projectId, meta: { ...baseMeta(), baseRevision: baselineHead } } });
      const sink = lineSink(child);
      await sink.waitFor('APPLY_STARTED', 60_000, 'the child to signal the apply start');
      const tStart = Date.now();
      // The smoke ChangeSet is seconds of work on the engine — this kill lands deterministically
      // inside the ONE-transaction apply. SIGKILL the CLIENT: no graceful teardown.
      await sleep(750);
      child.kill('SIGKILL');
      const exit = await exitOf(child, 10_000);
      const tKill = Date.now();
      assert.equal(exit.signal, 'SIGKILL', `the child must have been killed mid-apply, got exit ${JSON.stringify(exit)}`);
      t.diagnostic(`atomicity: spawn->start ${tStart - tSpawn}ms, start->kill ${tKill - tStart}ms, child exited via ${exit.signal}`);

      // Fresh connection against the still-running server.
      const chain = await readChain(port, { projectId });
      const verify = await verifyChain(port, { projectId });
      assert.equal(verify.ok, true, `the chain must verify after the kill: ${verify.violations.map((v) => v.code).join(',')}`);
      const applied = chain.revisions.length - 1;
      assert.ok(applied === 0 || applied === 1, `there is no third state: ${chain.revisions.length} revisions on a one-apply head`);
      const counts = await countStable(port);
      assert.equal(
        counts.nodes,
        baselineCounts.nodes + applied * smoke.nodes.length,
        `nodes are exactly the baseline or the baseline + the whole ChangeSet (got ${counts.nodes})`,
      );
      assert.equal(
        counts.edges,
        baselineCounts.edges + applied * smoke.edges.length,
        `edges are exactly the baseline or the baseline + the whole ChangeSet (got ${counts.edges})`,
      );
      if (applied === 0) assert.equal(chain.headRevision, baselineHead, 'rolled back: the head must be unchanged');
      else assert.notEqual(chain.headRevision, baselineHead, 'committed: the head must have advanced');

      // Re-apply a fresh promotion on the recovered state must succeed cleanly.
      const reapply = await applyChangeSet(port, { operations: workspacePromotion(projectId, 'reapply', 1) }, baseMeta());
      assert.equal(reapply.ok, true, `re-apply on the recovered graph must succeed: ${JSON.stringify(reapply.violations[0] ?? null)}`);
      const replay = await replayChain(port, { projectId });
      assert.equal(replay.ok, true, `replay after recovery must be green: ${replay.violations.map((v) => v.code).join(',')}`);

      t.diagnostic(
        `atomicity verdict: ${applied === 0 ? 'rolled back (head unchanged)' : 'whole ChangeSet committed (head advanced)'}, ` +
          `head=${chain.headRevision}, nodes=${counts.nodes}, edges=${counts.edges}, re-apply ok, replay green`,
      );
    } finally {
      await port.close().catch(() => {});
      await destroyContainer(name, { removeVolume: true });
    }
  });

  // --- item 3: durability (docker kill under write load) ---------------------------------------

  test('item 3 — durability: docker kill under write load; WAL recovery with exactly the acknowledged head', { timeout: 300_000 }, async (t) => {
    const name = CONTAINERS[1];
    const { server, database, port } = await setupServer(name);
    const projectId = PROJECT;
    try {
      // The smoke fixture becomes revision 1 through the promotion service — a chain-explained
      // baseline the writer then appends to (loadFixture's direct port CRUD is not awaited and is
      // not safe on the Bolt adapter, and a chain-explained graph is the honest baseline anyway).
      const smoke = generateFixture('durability-smoke', { scale: SMOKE_SCALE });
      const seeded = await applyChangeSet(port, fixtureChangeSet(smoke), baseMeta());
      assert.equal(seeded.ok, true, `fixture apply failed: ${JSON.stringify(seeded.violations[0] ?? null)}`);
      const baseline = await applyChangeSet(port, { operations: componentPromotion(projectId, 'base', 1) }, baseMeta());
      assert.equal(baseline.ok, true, `baseline apply failed: ${JSON.stringify(baseline.violations[0] ?? null)}`);
      const baselineCounts = await countStable(port);

      const writer = spawnEval(DURABILITY_WRITER_SCRIPT, { input: { server, database, projectId, meta: baseMeta() } });
      const sink = lineSink(writer);
      try {
        await sink.waitFor('WRITER_READY', 60_000, 'the writer to come up');
        await sink.waitFor((line) => line.startsWith('ACK'), 120_000, 'the first acknowledged commit');
        await sink.waitFor('BIG_APPLY_START', 120_000, 'the writer to start its big in-flight apply');
        // The big apply is seconds of work — kill the CONTAINER while it is in flight (SIGKILL to
        // the JVM, power loss, no graceful shutdown). WAL recovery is exercised on boot.
        await sleep(300);
        const killed = dockerRun(['kill', name]);
        assert.equal(killed.ok, true, `docker kill failed: ${killed.stderr}`);
        const acked = sink.lines.filter((line) => line.startsWith('ACK')).map((line) => line.slice(4));
        const lastAcked = acked[acked.length - 1];
        t.diagnostic(
          `durability: container SIGKILLed ~300ms into the big apply, ${acked.length} acknowledged commits before it, lastAcked=${lastAcked}`,
        );

        writer.kill('SIGKILL');
        await exitOf(writer, 10_000).catch(() => {});

        // Restart the SAME container (the writable layer survives docker kill; the server must
        // recover from its WAL on boot).
        const tRestart = Date.now();
        const restarted = await startServer({ name, timeoutMs: 120_000 });
        const restartMs = Date.now() - tRestart;
        t.diagnostic(`durability: container restart after docker kill -> ready in ${restartMs}ms`);

        const port2 = createArcadeDbPort({ server: restarted, database });
        try {
          const chain = await readChain(port2, { projectId });
          assert.equal(
            chain.headRevision,
            lastAcked,
            `head must be exactly the last acknowledged commit, never a partial one (got ${chain.headRevision}, lastAcked ${lastAcked})`,
          );
          const verify = await verifyChain(port2, { projectId });
          assert.equal(verify.ok, true, `verifyChain after recovery: ${verify.violations.map((v) => v.code).join(',')}`);
          const validation = await validateGraph(port2, { projectId });
          assert.equal(validation.ok, true, `validateGraph after recovery: ${validation.violations.map((v) => v.code).join(',')}`);
          const counts = await countStable(port2);
          const promoted = chain.revisions.length;
          assert.equal(
            counts.nodes,
            baselineCounts.nodes + (promoted - 2),
            `nodes must be exactly the acknowledged commits (got ${counts.nodes}, expected ${baselineCounts.nodes + (promoted - 2)})`,
          );
          assert.equal(
            counts.edges,
            baselineCounts.edges + (promoted - 2),
            `edges must be exactly the acknowledged commits (got ${counts.edges}, expected ${baselineCounts.edges + (promoted - 2)})`,
          );
          t.diagnostic(
            `durability verdict: head=${chain.headRevision} (exactly lastAcked), revisions=${chain.revisions.length}, ` +
              `nodes=${counts.nodes}, edges=${counts.edges}, verify+validate green, restart ${restartMs}ms`,
          );
        } finally {
          await port2.close().catch(() => {});
        }
      } finally {
        writer.kill('SIGKILL');
        await port.close().catch(() => {});
      }
    } finally {
      await destroyContainer(name, { removeVolume: true });
    }
  });

  // --- item 4: restore drill --------------------------------------------------------------------

  test('item 4 — restore drill: signed export -> clean container -> validation + context equivalence', { timeout: 300_000 }, async (t) => {
    const name = CONTAINERS[2];
    const { server, database, port } = await setupServer(name);
    const projectId = PROJECT;
    const tmpDir = mkdtempSync(join(tmpdir(), 'steepy-bakeoff-restore-'));
    const filePath = join(tmpDir, 'export.jsonl');
    try {
      const smoke = generateFixture('restore-smoke', { scale: SMOKE_SCALE });
      // Normalize the source fixture's property bags to the signed export's canonical key order
      // (see `sortedKeys`): the export stores bags with sorted keys, so an insertion-ordered
      // source would come back from the restore with the same VALUES in a different key order, and
      // the drill's byte-for-byte context assertion must compare like with like.
      const canonicalSmoke = {
        ...smoke,
        nodes: smoke.nodes.map((node) => ({ ...node, properties: sortedKeys(node.properties) })),
      };
      const seeded = await applyChangeSet(port, fixtureChangeSet(canonicalSmoke), baseMeta());
      assert.equal(seeded.ok, true, `fixture apply failed: ${JSON.stringify(seeded.violations[0] ?? null)}`);
      for (let i = 1; i <= 3; i += 1) {
        const applied = await applyChangeSet(port, { operations: componentPromotion(projectId, 'restore', i) }, baseMeta());
        assert.equal(applied.ok, true, `restore baseline ${i} failed: ${JSON.stringify(applied.violations[0] ?? null)}`);
      }

      const resolveInput = { projectId, paths: [smoke.packagePaths[0]], targets: [buildQualifiedId(projectId, 'rule:r0')] };
      const sourceContext = await resolveContext(port, resolveInput);
      assert.equal(sourceContext.ok, true, `source resolveContext failed: ${sourceContext.code}`);
      const sourceBytes = JSON.stringify(sourceContext);

      const exported = await exportGraph(port, { projectId, filePath });
      assert.equal(exported.ok, true);
      t.diagnostic(
        `restore: exported ${exported.counts.nodes} nodes / ${exported.counts.edges} edges, head ${exported.headRevision}, digest ${exported.digest.slice(0, 16)}…`,
      );

      // Destroy the container AND its volume — the database is truly gone.
      const tTeardown = Date.now();
      await destroyContainer(name, { removeVolume: true });
      const cleanServer = await startServer({ name, timeoutMs: 120_000 });
      const containerRebuildMs = Date.now() - tTeardown;
      await createDatabase(cleanServer, database);
      const cleanPort = createArcadeDbPort({ server: cleanServer, database });
      try {
        const tImport = Date.now();
        const imported = await importGraph(cleanPort, { filePath });
        const importMs = Date.now() - tImport;
        assert.equal(imported.ok, true, `import failed: ${JSON.stringify(imported.violations?.[0] ?? null)}`);
        assert.equal(imported.headRevision, exported.headRevision, 'the restored head must match the exported head');
        assert.deepEqual(imported.counts, exported.counts, 'the restored counts must match the exported counts');
        t.diagnostic(`restore: container destroy+rebuild ${containerRebuildMs}ms, import ${importMs}ms (${imported.counts.nodes} nodes / ${imported.counts.edges} edges)`);

        const validation = await validateGraph(cleanPort, { projectId });
        assert.equal(validation.ok, true, `restored graph must validate: ${validation.violations.map((v) => v.code).join(',')}`);
        const chain = await verifyChain(cleanPort, { projectId });
        assert.equal(chain.ok, true, `restored chain must verify: ${chain.violations.map((v) => v.code).join(',')}`);

        const restoredContext = await resolveContext(cleanPort, resolveInput);
        assert.equal(restoredContext.ok, true, `restored resolveContext failed: ${restoredContext.code}`);
        assert.equal(JSON.stringify(restoredContext), sourceBytes, 'resolveContext output must be byte-identical');
        assert.deepEqual(restoredContext, sourceContext);
        t.diagnostic(`restore verdict: byte-identical resolveContext (${sourceBytes.length} bytes), validate+verify green`);
      } finally {
        await cleanPort.close().catch(() => {});
      }
    } finally {
      await port.close().catch(() => {});
      await destroyContainer(name, { removeVolume: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --- item 5: out-of-band admin write (criterion 13) -------------------------------------------

  test('item 5 — out-of-band admin write is reported by chain replay with the exact identity', { timeout: 300_000 }, async (t) => {
    const name = CONTAINERS[3];
    const { server, database, port } = await setupServer(name);
    const projectId = PROJECT;
    try {
      // Apply the smoke fixture AS a promotion so the whole graph is chain-explained and the
      // baseline replay is clean — a full-graph OOB write would bury the detection in noise.
      const smoke = generateFixture('oob-smoke', { scale: SMOKE_SCALE });
      const applied = await applyChangeSet(port, fixtureChangeSet(smoke), baseMeta());
      assert.equal(applied.ok, true, `fixture apply failed: ${JSON.stringify(applied.violations[0] ?? null)}`);
      const second = await applyChangeSet(port, { operations: componentPromotion(projectId, 'oob', 1) }, baseMeta());
      assert.equal(second.ok, true, JSON.stringify(second.violations[0] ?? null));
      const baselineReplay = await replayChain(port, { projectId });
      assert.equal(baselineReplay.ok, true, `baseline replay must be green: ${baselineReplay.violations.map((v) => v.code).join(',')}`);

      // ADMIN (root) writes straight into the engine, bypassing the Promotion Service — the exact
      // threat §19/§21 describe. ArcadeDB's per-database groups cannot stop the machine owner; the
      // point of criterion 13 is DETECTION, and the Revision chain provides it.
      const injectedId = `oob-injected-${randomUUID()}`;
      const targetId = buildQualifiedId(projectId, 'component:c0');
      const driver = openDriver(server);
      const session = driver.session({ database });
      try {
        await session.run(`CREATE (n:${NODE_TYPE} {ns:$ns, sid:$sid, t:$t, id:$id, p:$p})`, {
          ns: 'curated',
          sid: '',
          t: 'Term',
          id: injectedId,
          p: JSON.stringify({ id: injectedId, status: 'active' }),
        });
        await session.run(
          `MATCH (a:${NODE_TYPE} {ns:$ns, sid:$sid, id:$fromId}), (b:${NODE_TYPE} {ns:$ns, sid:$sid, id:$toId}) CREATE (a)-[e:${EDGE_TYPE} {t:$t}]->(b)`,
          { ns: 'curated', sid: '', t: 'USED_BY', fromId: injectedId, toId: targetId },
        );
      } finally {
        await session.close();
        await driver.close();
      }

      const replay = await replayChain(port, { projectId });
      assert.equal(replay.ok, false, 'the injected records must make replay report a non-clean verdict');
      assert.deepEqual(
        replay.violations.map((v) => v.code).sort(),
        ['UNEXPLAINED_EDGE', 'UNEXPLAINED_NODE'],
        'the ONLY findings are the two injected records — no noise from the chain itself',
      );
      const nodeFinding = replay.violations.find((v) => v.code === 'UNEXPLAINED_NODE');
      assert.deepEqual(
        nodeFinding.identity,
        { namespace: 'curated', id: injectedId, type: 'Term' },
        'the unexplained node must carry the EXACT injected identity',
      );
      const edgeFinding = replay.violations.find((v) => v.code === 'UNEXPLAINED_EDGE');
      assert.deepEqual(
        edgeFinding.identity,
        { namespace: 'curated', type: 'USED_BY', fromId: injectedId, toId: targetId },
        'the unexplained edge must carry the EXACT injected identity',
      );

      // The chain itself is unharmed: the injection is DATA, and the hash chain still verifies.
      const verify = await verifyChain(port, { projectId });
      assert.equal(verify.ok, true, `the hash chain must still verify: ${verify.violations.map((v) => v.code).join(',')}`);
      t.diagnostic(
        `oob verdict: replay reports exactly ${JSON.stringify(nodeFinding.identity)} and ${JSON.stringify(edgeFinding.identity)}; verifyChain stays green`,
      );
    } finally {
      await port.close().catch(() => {});
      await destroyContainer(name, { removeVolume: true });
    }
  });

  // --- item 6: replay memory/time at E1 scale (B5 rout-forward c) -------------------------------

  const REPLAY_MEASURE_SCRIPT = `
import { createMemoryPort } from './scripts/formula/engine/memory.mjs';
import { generateFixture } from './scripts/formula/core/fixture-gen.mjs';
import { applyChangeSet, replayChain, sha256Hex } from './scripts/formula/core/revision.mjs';
import { performance } from 'node:perf_hooks';
const projectId = 'fixture';
const fixture = generateFixture('e2-replay-memory', { scale: 1 });
const operations = [
  ...fixture.nodes.map((n) => ({ op: 'ADD', target: 'node', namespace: n.namespace, type: n.type, id: n.id, properties: n.properties })),
  ...fixture.edges.map((e) => ({ op: 'ADD', target: 'edge', namespace: e.namespace, type: e.type, fromId: e.fromId, toId: e.toId })),
];
const port = createMemoryPort();
const applied = await applyChangeSet(port, { operations }, {
  projectId,
  proposer: { type: 'agent-proposer', id: 'e2' },
  approver: { type: 'human-approver', id: 'e2' },
  provenance: [{ quotation: 'E2 replay memory.', source: 'tests/formula-bakeoff-veto.test.mjs:1', digest: sha256Hex('replay') }],
  timestamp: '2026-08-12T10:00:00.000Z',
});
if (!applied.ok) throw new Error('apply failed: ' + JSON.stringify(applied.violations[0] ?? null));
global.gc();
const before = process.memoryUsage();
let peakHeap = before.heapUsed;
let peakRss = before.rss;
const sampler = setInterval(() => {
  const now = process.memoryUsage();
  if (now.heapUsed > peakHeap) peakHeap = now.heapUsed;
  if (now.rss > peakRss) peakRss = now.rss;
}, 1);
const t0 = performance.now();
const replay = await replayChain(port, { projectId });
const t1 = performance.now();
clearInterval(sampler);
global.gc();
const after = process.memoryUsage();
console.log('REPLAY_MEASURE ' + JSON.stringify({
  ok: replay.ok,
  violations: replay.violations.length,
  nodes: fixture.nodes.length,
  edges: fixture.edges.length,
  // The replay runs on a port that already holds the whole graph in JS, so its marginal heap
  // (delta) is ~0 — it reuses the heap the apply grew. The O(graph) number this measurement
  // records is the process high-water mark the replay needs: the materialized graph IS the
  // replay's working set, so peak heap/rss during replay are the honest O(graph) values.
  replayHeapPeakBytes: peakHeap,
  replayRssPeakBytes: peakRss,
  replayHeapPeakDeltaBytes: peakHeap - before.heapUsed,
  replayRssPeakDeltaBytes: peakRss - before.rss,
  retainedHeapBytes: after.heapUsed - before.heapUsed,
  elapsedMs: Math.round((t1 - t0) * 100) / 100,
}));
`;

  test('item 6 — replay at E1 scale: peak memory and time recorded, soft ceiling against O(n²)', { timeout: 300_000 }, async (t) => {
    const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', REPLAY_MEASURE_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    const exit = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    assert.equal(exit.code, 0, `the replay measurement child failed (${exit.signal ?? exit.code}): ${err.slice(0, 500)}`);
    const line = out.split('\n').find((l) => l.startsWith('REPLAY_MEASURE '));
    assert.ok(line, `no measurement emitted (stderr: ${err.slice(0, 300)})`);
    const measure = JSON.parse(line.slice('REPLAY_MEASURE '.length));
    assert.equal(measure.ok, true, `replay at E1 scale must be green: ${measure.violations} violations`);
    assert.equal(measure.nodes, 25521, 'the full E1 fixture node count');
    assert.equal(measure.edges, 150000, 'the full E1 fixture edge count');
    // Soft ceiling: a generous bound that catches a quadratic-memory blow-up, never a legitimate
    // linear O(graph) working set. The measured numbers are the recorded evidence.
    assert.ok(measure.replayHeapPeakBytes < 2 * 1024 ** 3, `replay heap peak ${measure.replayHeapPeakBytes}B exceeds the 2GiB ceiling`);
    assert.ok(measure.replayRssPeakBytes < 3 * 1024 ** 3, `replay rss peak ${measure.replayRssPeakBytes}B exceeds the 3GiB ceiling`);
    t.diagnostic(
      `replay at E1 scale: ${measure.nodes} nodes / ${measure.edges} edges, peak heap ${(measure.replayHeapPeakBytes / 1048576).toFixed(1)} MiB, ` +
        `peak rss ${(measure.replayRssPeakBytes / 1048576).toFixed(1)} MiB, heap delta ${(measure.replayHeapPeakDeltaBytes / 1048576).toFixed(1)} MiB, ` +
        `${measure.elapsedMs} ms`,
    );
  });
}
