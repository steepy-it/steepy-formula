// E4 — performance envelope + operational ergonomics against pinned-stable ArcadeDB (spec §16
// acceptance targets, bake-off items 5 and 8). Every number this suite reports is MEASURED on the
// pinned `arcadedata/arcadedb:26.8.1` image at the full E1 scale (500 packages / 25,000 curated
// nodes / 150,000 edges) — never documented, never "should be".
//
// Envelope targets (plan wording; spec §16 acceptance targets):
//   warm resolveContext < 1 s  — MEASURED 1.67–1.97 s on this machine (2026-08-18, Apple M5 Pro,
//       arcadedb:26.8.1, full E1 fixture): the spec target is NOT met by the current D2 resolver
//       design (a whole-graph Bolt read ~1.7 s for the 149k-edge curated namespace dominates).
//       RATIFIED 2026-08-18 (controller + user decision): the assertion is a generous 5 s
//       regression ceiling, the measured number stays recorded, and an explicit follow-up task
//       owns a scoped/cached resolver read path. Spec §16 remains an acceptance target, never a
//       met claim.
//   incremental topology refresh < 5 s  (HARD, passes)
//   full rebuild < 60 s                (HARD, passes)
//
// CI environment (RATIFIED 2026-08-19, controller + user decision): the shared GitHub
// `ubuntu-latest` runner measures the same operations ~4x slower than the M5 Pro dev machine —
// MEASURED warm resolve median 7305–7365 ms and incremental refresh 6970–7010 ms on runs
// 32240071754 / 32242172848. The ceilings scale 2x when GITHUB_ACTIONS is set so a slow shared
// VM is a recorded, not failed, envelope; dev machines keep the strict ceilings.
// Everything else (startup, RAM, upgrade result, CI notes, warm-up behavior) is recorded.
//
// FIXTURE LOADING — the fastest honest path, recorded (deviation, see the task report). The
// brief's two named paths are both per-record port round-trips over Bolt: `applyChangeSet` (the
// E2 pattern) measured 1.31–1.61 ms/op → ~5–6 min at full scale, and `importGraph` is the same
// shape (~1.4 ms/record measured by E2's restore drill). This suite loads the fixture with
// batched raw-Bolt UNWIND statements (500 records/statement) — measured 3.5 s for the whole
// fixture, a ~100× speedup — then writes the `GraphMetadata` system record exactly as
// `loadFixture` does. The loaded graph is byte-identical to the memory-port fixture (same seed,
// same property JSON), B4-valid, and needs no audit chain: nothing in this suite asserts
// `replayChain`. The deviation is recorded in the ledger and report.
//
// Hygiene: docker-gated with the established explicit diagnostic; one hermetic container, created
// in `before`, destroyed in `after`; no test-order dependence (the load test runs first and every
// later test consumes the shared graph); the suite stays within a few minutes.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCADEDB_IMAGE,
  destroyContainer,
  dockerGate,
  dockerRun,
  startServer,
} from '../scripts/formula/engine/lifecycle.mjs';
import {
  EDGE_TYPE,
  NODE_TYPE,
  createArcadeDbPort,
  createDatabase,
  openDriver,
} from '../scripts/formula/engine/arcadedb.mjs';
import { generateFixture } from '../scripts/formula/core/fixture-gen.mjs';
import { GRAPH_SCHEMA_VERSION } from '../scripts/formula/core/ontology.mjs';
import { SYSTEM_RECORD_TYPE, systemRecordId, validateGraph } from '../scripts/formula/core/validate-graph.mjs';
import { resolveContext } from '../scripts/formula/core/resolve-context.mjs';
import { DEFAULT_CONTEXT_BUDGET, buildContextOutput } from '../scripts/formula/core/context-output.mjs';
import { refreshTopology, TOPOLOGY_CODES } from '../scripts/formula/core/topology.mjs';

const CONTAINER = 'apex-formula-envelope-test';
const PROJECT = 'fixture';
const BATCH = 500;
const WARM_RESOLVES = 5;

// The envelope targets, stated once and asserted verbatim below.
// RATIFIED 2026-08-18 (controller + user decision): the spec §16 < 1 s warm-resolve target is
// currently NOT met (measured median 1671–1968 ms, full E1 fixture, pinned image). The assertion
// is a generous regression ceiling; the measured number is recorded in the ledger/report and an
// explicit follow-up task owns the resolver read-path optimization. Spec §16 stays an acceptance
// target, not a met claim.
// RATIFIED 2026-08-19 (controller + user decision): on the shared GitHub runner the same
// operations measure ~4x slower (warm resolve 7305–7365 ms, incremental refresh 6970–7010 ms,
// runs 32240071754 / 32242172848) — ceilings scale 2x under GITHUB_ACTIONS; dev machines keep
// the strict values.
const CI_SCALE = process.env.GITHUB_ACTIONS === 'true' ? 2 : 1;
const TARGET_WARM_RESOLVE_MS = 5000 * CI_SCALE;
const TARGET_INCREMENTAL_REFRESH_MS = 5000 * CI_SCALE;
const TARGET_FULL_REBUILD_MS = 60000 * CI_SCALE;

// The registry this image is pulled from, probed live for the upgrade finding.
const REGISTRY_URL = 'https://hub.docker.com/v2/repositories/arcadedata/arcadedb/tags?page_size=100&ordering=last_updated';

const gate = dockerGate();

if (!gate.ok) {
  test(`formula envelope suite (docker-gated): ${gate.reason}`, (t) => {
    t.diagnostic(`SKIPPED — ${gate.reason} (pinned image ${ARCADEDB_IMAGE})`);
    t.skip(gate.reason);
  });
} else {
  let server = null;
  let port = null;
  let fixture = null;
  let workspaceRoot = null;
  let startupMs = null;

  // --- raw-Bolt batched loader (see the header: the fastest honest path, recorded) --------------

  // Writes every fixture node and edge plus the `GraphMetadata` system record into the database.
  // `UNWIND` batches collapse ~550k per-record Bolt round-trips (what a promotion or an import
  // costs) into ~340 statements. Endpoint namespaces for the two declared bridge relationships
  // (port.mjs `BRIDGE_RELATIONSHIPS`) are derived from the fixture's own node-id -> namespace
  // map, exactly as the port would resolve them.
  async function loadFullFixture(database, input, target = server) {
    const idNs = new Map(input.nodes.map((node) => [node.id, node.namespace]));
    const nodeRows = input.nodes.map((node) => ({
      ns: node.namespace,
      sid: '',
      t: node.type,
      id: node.id,
      p: JSON.stringify(node.properties ?? {}),
    }));
    const edgeRows = input.edges.map((edge) => ({
      t: edge.type,
      sid: '',
      fns: idNs.get(edge.fromId) ?? edge.namespace,
      tns: idNs.get(edge.toId) ?? edge.namespace,
      fromId: edge.fromId,
      toId: edge.toId,
    }));
    const driver = openDriver(target);
    const session = driver.session({ database });
    try {
      for (let index = 0; index < nodeRows.length; index += BATCH) {
        await session.run(
          `UNWIND $rows AS r CREATE (n:${NODE_TYPE} {ns:r.ns, sid:r.sid, t:r.t, id:r.id, p:r.p})`,
          { rows: nodeRows.slice(index, index + BATCH) },
        );
      }
      for (let index = 0; index < edgeRows.length; index += BATCH) {
        await session.run(
          `UNWIND $rows AS r MATCH (a:${NODE_TYPE} {ns:r.fns, sid:r.sid, id:r.fromId}), ` +
            `(b:${NODE_TYPE} {ns:r.tns, sid:r.sid, id:r.toId}) CREATE (a)-[e:${EDGE_TYPE} {t:r.t}]->(b)`,
          { rows: edgeRows.slice(index, index + BATCH) },
        );
      }
      await session.run(`CREATE (n:${NODE_TYPE} {ns:$ns, sid:$sid, t:$t, id:$id, p:$p})`, {
        ns: 'system',
        sid: '',
        t: SYSTEM_RECORD_TYPE,
        id: systemRecordId(PROJECT),
        p: JSON.stringify({ schemaVersion: GRAPH_SCHEMA_VERSION, headRevision: null }),
      });
    } finally {
      await session.close();
      await driver.close();
    }
  }

  // --- the topology fixture: a real npm-workspaces tree the D1 detector can observe -------------

  // The tree mirrors the fixture's Package identities so the refresh diff is about REAL change,
  // not id churn: a package directory `packages/pkg-000` carrying the npm name `p0` slugifies to
  // the fixture's own `apex:fixture:package:p0` (topology.mjs `packageSlug`), with the same
  // `packages/pkg-000` path property. The root manifest declares `packages/*` and no name, so the
  // root is a container, not a package.
  function buildWorkspaceTree(root) {
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({ private: true, workspaces: ['packages/*'] }, null, 2)}\n`);
    for (let index = 0; index < 500; index += 1) {
      const dir = join(root, 'packages', `pkg-${String(index).padStart(3, '0')}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        `${JSON.stringify({ name: `p${index}`, version: '1.0.0' }, null, 2)}\n`,
      );
    }
  }

  function refreshMeta() {
    return { projectId: PROJECT, actorId: 'e4-envelope-writer' };
  }

  // One measurement of `fn`, reported as a diagnostic and returned in ms.
  async function timed(fn) {
    const start = performance.now();
    const result = await fn();
    return { result, ms: performance.now() - start };
  }

  describe('formula performance envelope (docker-gated, full E1 fixture, pinned image)', () => {
    before(async () => {
      await destroyContainer(CONTAINER, { removeVolume: true }); // a crashed earlier run leaves no trap
      const t0 = performance.now();
      server = await startServer({ name: CONTAINER, timeoutMs: 120_000 });
      startupMs = performance.now() - t0;
      fixture = generateFixture('e4-envelope', { scale: 1 });
      workspaceRoot = mkdtempSync(join(tmpdir(), 'steepy-envelope-topology-'));
      buildWorkspaceTree(workspaceRoot);
    });

    after(async () => {
      await port?.close().catch(() => {});
      await destroyContainer(CONTAINER, { removeVolume: true });
      if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
      server = null;
      port = null;
      fixture = null;
    });

    // --- envelope load + validation ---------------------------------------------------------------

    test('loads the full E1 fixture B4-clean on the pinned image (envelope scale)', { timeout: 180_000 }, async (t) => {
      const database = `apex_env_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      await createDatabase(server, database);
      port = createArcadeDbPort({ server, database });
      const { ms: loadMs } = await timed(() => loadFullFixture(database, fixture));
      t.diagnostic(
        `envelope load: ${fixture.nodes.length} nodes / ${fixture.edges.length} edges in ${loadMs.toFixed(0)}ms ` +
          `(batched raw-Bolt UNWIND, ${Math.ceil((fixture.nodes.length + fixture.edges.length) / BATCH)} statements)`,
      );
      assert.equal(fixture.nodes.length, 25521, 'the full E1 fixture node count');
      assert.equal(fixture.edges.length, 150000, 'the full E1 fixture edge count');

      const validation = await validateGraph(port, { projectId: PROJECT });
      assert.equal(validation.ok, true, `the full-scale graph must validate: ${validation.violations.map((v) => v.code).join(',')}`);
      assert.deepEqual(validation.violations, []);
      assert.deepEqual(validation.warnings, []);
      t.diagnostic(`validateGraph at full scale: ok, ${validation.violations.length} violations / ${validation.warnings.length} warnings`);
    });

    // --- warm resolveContext < 1 s (HARD) -----------------------------------------------------------

    test('warm resolveContext on a representative package path is under the regression ceiling (measured; spec target not met)', { timeout: 180_000 }, async (t) => {
      assert.ok(port, 'the load test must have run first');
      // The warm caller's discipline (D3): validate once, hand the verdict to the resolver.
      const validation = await validateGraph(port, { projectId: PROJECT });
      assert.equal(validation.ok, true);
      const input = {
        projectId: PROJECT,
        paths: [fixture.packagePaths[0]],
        targets: [`apex:${PROJECT}:rule:r0`],
      };
      const options = { options: { validation } };

      // Warm-up: the first resolve primes engine storage caches. Recorded, not measured as the target.
      const warmUp = await resolveContext(port, { ...input, ...options });
      assert.equal(warmUp.ok, true, JSON.stringify(warmUp));
      assert.ok(warmUp.context.rules.length > 500, `rules ${warmUp.context.rules.length}`);

      const samples = [];
      for (let index = 0; index < WARM_RESOLVES; index += 1) {
        const { ms } = await timed(() => resolveContext(port, { ...input, ...options }));
        samples.push(ms);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const rounded = samples.map((ms) => ms.toFixed(0));
      t.diagnostic(
        `warm resolveContext: samples ${rounded.join(', ')}ms, median ${median.toFixed(0)}ms, ` +
          `items rules=${warmUp.context.rules.length} checks=${warmUp.context.checks.length} terms=${warmUp.context.terms.length} decisions=${warmUp.context.decisions.length}`,
      );
      // Regression ceiling (ratified 2026-08-18): the spec §16 target is < 1 s and is NOT met —
      // measured median 1671–1968 ms on this machine (M5 Pro, arcadedb:26.8.1, full E1 fixture).
      // The measured number is the record; this ceiling only catches a pathological regression.
      // Follow-up: a scoped/cached resolver read path (the whole-graph Bolt read dominates).
      assert.ok(
        median < TARGET_WARM_RESOLVE_MS,
        `warm resolveContext median ${median.toFixed(0)}ms >= the ${TARGET_WARM_RESOLVE_MS}ms regression ceiling`,
      );
    });

    // --- DEFAULT_CONTEXT_BUDGET calibration on the fixture (spec §9, binding 4) ----------------------

    test('DEFAULT_CONTEXT_BUDGET fits the measured full-scale context with headroom (calibration)', { timeout: 180_000 }, async (t) => {
      assert.ok(port, 'the load test must have run first');
      const input = {
        projectId: PROJECT,
        paths: [fixture.packagePaths[0]],
        targets: [`apex:${PROJECT}:rule:r0`],
      };
      const unbounded = await buildContextOutput(port, { ...input, options: { budget: Number.MAX_SAFE_INTEGER } });
      assert.equal(unbounded.ok, true, JSON.stringify(unbounded));
      const measured = JSON.stringify(unbounded.json).length;
      t.diagnostic(
        `calibrated context: measured serialized context.json ${measured} characters (rationale off), ` +
          `DEFAULT_CONTEXT_BUDGET=${DEFAULT_CONTEXT_BUDGET} (headroom ${((DEFAULT_CONTEXT_BUDGET / measured - 1) * 100).toFixed(1)}%)`,
      );
      // The committed default must fit the measured realistic context (the budget's own unit).
      assert.ok(measured <= DEFAULT_CONTEXT_BUDGET, `measured ${measured} > default ${DEFAULT_CONTEXT_BUDGET}`);

      const withDefault = await buildContextOutput(port, { ...input });
      assert.equal(withDefault.ok, true, `the default budget must not overflow: ${withDefault.code}`);
      assert.deepEqual(withDefault.json.layer0.truncated, [], 'a realistic full-scale answer must not truncate under the default');
    });

    // --- topology refresh: incremental < 5 s, full rebuild < 60 s (HARD) --------------------------------

    test('incremental topology refresh under 5 seconds and full rebuild under 60 seconds (envelope HARD)', { timeout: 240_000 }, async (t) => {
      assert.ok(port, 'the load test must have run first');
      // Initial refresh against the fixture's own topology: a real full write — the tree re-parents
      // every Package onto its single `packages` workspace and rewrites the Repository record. This
      // is the full-scale "full rebuild" the spec's 60 s target covers.
      const initial = await timed(() => refreshTopology(port, workspaceRoot, refreshMeta(), {}));
      assert.equal(initial.result.ok, true, `initial refresh refused: ${initial.result.code}`);
      assert.equal(initial.result.code, TOPOLOGY_CODES.TOPOLOGY_WRITTEN);
      const written = initial.result.outcome;
      t.diagnostic(
        `full rebuild (initial write): ${initial.ms.toFixed(0)}ms — added ${written.added.length}, modified ${written.modified.length}, ` +
          `removed ${written.removed.length}, orphaned ${written.orphaned.length}`,
      );
      assert.ok(initial.ms < TARGET_FULL_REBUILD_MS, `full rebuild ${initial.ms.toFixed(0)}ms >= the 60s envelope target`);

      // Incremental change: one new package directory. The refresh detects it, diffs, and writes
      // exactly one Package node + one PART_OF edge. The < 5 s hard target is on THIS path.
      const addedDir = join(workspaceRoot, 'packages', 'pkg-500');
      mkdirSync(addedDir, { recursive: true });
      writeFileSync(join(addedDir, 'package.json'), `${JSON.stringify({ name: 'p500', version: '1.0.0' }, null, 2)}\n`);
      const incremental = await timed(() => refreshTopology(port, workspaceRoot, refreshMeta(), {}));
      assert.equal(incremental.result.ok, true, `incremental refresh refused: ${incremental.result.code}`);
      assert.equal(incremental.result.code, TOPOLOGY_CODES.TOPOLOGY_WRITTEN);
      assert.deepEqual(incremental.result.outcome.added, [`apex:${PROJECT}:package:p500`], 'the incremental diff must add exactly the new package');
      t.diagnostic(`incremental refresh (one package added): ${incremental.ms.toFixed(0)}ms — added 1 node + 1 edge`);
      assert.ok(incremental.ms < TARGET_INCREMENTAL_REFRESH_MS, `incremental refresh ${incremental.ms.toFixed(0)}ms >= the 5s envelope target`);

      // No-op refresh: the digest fast path (§25) — measured, not asserted (a recorded ergonomic).
      const unchanged = await timed(() => refreshTopology(port, workspaceRoot, refreshMeta(), {}));
      assert.equal(unchanged.result.code, TOPOLOGY_CODES.TOPOLOGY_UNCHANGED);
      t.diagnostic(`no-op refresh (digest fast path): ${unchanged.ms.toFixed(0)}ms — ${unchanged.result.code}`);

      // Full rebuild with `{ full: true }`: skips the digest comparison, re-derives the whole
      // desired graph, diffs against the current one. On an up-to-date tree that diff is empty.
      const rebuilt = await timed(() => refreshTopology(port, workspaceRoot, refreshMeta(), { full: true }));
      assert.equal(rebuilt.result.ok, true, `full rebuild refused: ${rebuilt.result.code}`);
      assert.equal(rebuilt.result.code, TOPOLOGY_CODES.TOPOLOGY_UNCHANGED);
      t.diagnostic(`full rebuild ({ full: true }, tree unchanged): ${rebuilt.ms.toFixed(0)}ms — ${rebuilt.result.code}`);
      assert.ok(rebuilt.ms < TARGET_FULL_REBUILD_MS, `full rebuild ${rebuilt.ms.toFixed(0)}ms >= the 60s envelope target`);
    });

    // --- operational ergonomics (bake-off item 8) ------------------------------------------------------

    test('operational ergonomics: container startup and steady RAM footprint are recorded', { timeout: 60_000 }, async (t) => {
      assert.ok(port, 'the load test must have run first');
      // Startup as `startServer` sees it: container create -> readiness probe green, timed in the
      // `before` hook (a fresh container; the hook destroys any prior one first).
      const status = await dockerRun(['stats', '--no-stream', '--format', '{{.MemUsage}}', CONTAINER]);
      assert.equal(status.ok, true, `docker stats failed: ${status.stderr}`);
      const mem = status.stdout.trim().split('/')[0].trim();
      t.diagnostic(
        `docker startup (startServer, fresh container): ${startupMs.toFixed(0)}ms; ` +
          `steady RAM footprint (docker stats, --no-stream): ${mem} while serving the full E1 fixture; ` +
          `docker ${gate.dockerVersion}, image ${ARCADEDB_IMAGE}`,
      );
      assert.match(mem, /[0-9]/, `no memory figure parsed from '${status.stdout.trim()}'`);
    });

    test('in-place upgrade between consecutive engine versions with data: registry probe recorded', { timeout: 120_000 }, async (t) => {
      // The pinned release is 26.8.1. A "consecutive stable tag" means the next stable patch/minor
      // on the registry after it — never a -SNAPSHOT (the bake-off protocol pins exact stable
      // releases). Probed live so the finding is measured, not remembered.
      let tags = [];
      let probeError = null;
      try {
        const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(15_000) });
        const payload = await response.json();
        tags = (payload.results ?? []).map((entry) => entry.name);
      } catch (error) {
        probeError = error?.message ?? String(error);
      }
      if (probeError !== null) {
        t.diagnostic(`upgrade: registry probe failed (${probeError}); no upgrade performed, finding recorded`);
        assert.ok(true, 'registry unreachable — recorded, not invented');
        return;
      }

      const stable = tags.filter((name) => !name.includes('SNAPSHOT') && name !== 'latest' && name !== ARCADEDB_IMAGE);
      const nextStable = stable
        .map((name) => name.split('.').map(Number))
        .filter((parts) => parts.length === 3 && parts.every(Number.isFinite))
        .filter((parts) => parts.join('.') > '26.8.1')
        .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
        .map((parts) => parts.join('.'))[0] ?? null;

      t.diagnostic(
        `upgrade: registry tags probed = ${JSON.stringify(tags.slice(0, 12))}…; consecutive stable tag after 26.8.1: ${nextStable ?? 'none'}`,
      );

      if (nextStable === null) {
        // Honest finding, recorded (brief binding 5): no consecutive stable tag exists — the next
        // entry on the registry is 26.9.1-SNAPSHOT, which the bake-off protocol forbids. No fake
        // upgrade is invented; the graph stays on the pinned image and is asserted healthy.
        t.diagnostic(
          'upgrade: NO consecutive stable tag after 26.8.1 on the registry (only 26.9.1-SNAPSHOT and latest follow) — ' +
            'the in-place upgrade drill is not applicable; the running graph is asserted healthy instead',
        );
        const validation = await validateGraph(port, { projectId: PROJECT });
        assert.equal(validation.ok, true, `the pinned-image graph must still validate: ${validation.violations.map((v) => v.code).join(',')}`);
        const resolved = await resolveContext(port, {
          projectId: PROJECT,
          paths: [fixture.packagePaths[0]],
          targets: [`apex:${PROJECT}:rule:r0`],
        });
        assert.equal(resolved.ok, true, JSON.stringify(resolved));
        return;
      }

      // A consecutive stable tag EXISTS — perform the in-place upgrade drill: a volume-backed
      // container loaded with data, swapped onto the newer image with the data volume intact.
      const nextImage = `arcadedata/arcadedb:${nextStable}`;
      const pulled = dockerRun(['pull', nextImage], { timeoutMs: 600_000 });
      assert.equal(pulled.ok, true, `could not pull ${nextImage}: ${pulled.stderr}`);
      const volumeName = `${CONTAINER}-upgrade-data`;
      dockerRun(['volume', 'rm', '-f', volumeName]);
      const upgradeName = `${CONTAINER}-upgrade`;
      const seeded = await startServer({ name: upgradeName, volume: volumeName, timeoutMs: 120_000 });
      const upgradeDatabase = `apex_env_upgrade_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      await createDatabase(seeded, upgradeDatabase);
      const upgradeFixture = generateFixture('e4-upgrade', { scale: 0.05 });
      const upgradePort = createArcadeDbPort({ server: seeded, database: upgradeDatabase });
      // The drill loads into the volume-backed upgrade container, not the suite's main server.
      await loadFullFixture(upgradeDatabase, upgradeFixture, seeded);
      await upgradePort.close();
      await destroyContainer(upgradeName, { removeVolume: false, volume: volumeName });

      const upgraded = await startServer({ name: upgradeName, volume: volumeName, image: nextImage, timeoutMs: 120_000 });
      const upgradedPort = createArcadeDbPort({ server: upgraded, database: upgradeDatabase });
      try {
        const validation = await validateGraph(upgradedPort, { projectId: upgradeFixture.projectId });
        assert.equal(validation.ok, true, `post-upgrade graph must validate: ${validation.violations.map((v) => v.code).join(',')}`);
        const resolved = await resolveContext(upgradedPort, {
          projectId: upgradeFixture.projectId,
          paths: [upgradeFixture.packagePaths[0]],
        });
        assert.equal(resolved.ok, true, JSON.stringify(resolved));
        t.diagnostic(`upgrade: ${ARCADEDB_IMAGE} -> ${nextImage} with data volume intact — validate + resolve green`);
      } finally {
        await upgradedPort.close().catch(() => {});
        await destroyContainer(upgradeName, { removeVolume: true, volume: volumeName });
      }
    });
  });
}
