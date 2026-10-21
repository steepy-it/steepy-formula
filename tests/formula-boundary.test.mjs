// Boundary defense in depth + Studio read-only proof (Task E3, bake-off item 6, spec §19, §23).
//
// The adapter's product wiring: `createArcadeDbPort` accepts a `credentials` option that overrides
// the server's root pair, and `ensureReadonlyUser` provisions a per-database `readonly` server
// user (idempotent). The ENGINE is the enforcer — this suite asserts the engine's own
// authorization refusal (never an adapter-side check) and proves the read identity cannot mutate
// governance across BOTH protocols on the pinned release, while the write identity still promotes.
//
// All docker-gated: a live ArcadeDB (pinned `arcadedata/arcadedb:26.8.1`) is the only honest
// place to prove an engine-enforced boundary. Docker absent → self-skip with an explicit printed
// diagnostic, never silently (plan decision 4). The manual Studio click-through (spec §23) cannot
// be automated here; it is documented as a ledger note + report entry, pending human verification.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ARCADEDB_IMAGE,
  destroyContainer,
  dockerGate,
  startServer,
} from '../scripts/formula/engine/lifecycle.mjs';
import {
  NODE_TYPE,
  createArcadeDbPort,
  createDatabase,
  ensureReadonlyUser,
  runSql,
  serverCommand,
} from '../scripts/formula/engine/arcadedb.mjs';
import { isPortError, withTransaction } from '../scripts/formula/engine/port.mjs';
import { applyChangeSet, readChain, sha256Hex } from '../scripts/formula/core/revision.mjs';
import { buildQualifiedId } from '../scripts/formula/core/ids.mjs';
import { resolveContext } from '../scripts/formula/core/resolve-context.mjs';
import { generateFixture } from '../scripts/formula/core/fixture-gen.mjs';

const CONTAINER = 'apex-formula-boundary-test';

const gate = dockerGate();

if (!gate.ok) {
  test(`ArcadeDB live boundary suite (docker-gated): ${gate.reason}`, (t) => {
    t.diagnostic(`SKIPPED — ${gate.reason} (pinned image ${ARCADEDB_IMAGE})`);
    t.skip(gate.reason);
  });
} else {
  let server = null;

  describe('arcadedb live boundary (docker-gated)', () => {
    before(async () => {
      await destroyContainer(CONTAINER, { removeVolume: true }); // a crashed earlier run leaves no trap
      server = await startServer({ name: CONTAINER, timeoutMs: 90_000 });
    });

    after(async () => {
      await destroyContainer(CONTAINER, { removeVolume: true });
      server = null;
    });

    // --- helpers --------------------------------------------------------------------------------

    function freshDatabase() {
      return `apex_boundary_${randomUUID().replaceAll('-', '')}`;
    }

    function freshUser() {
      return `apex_reader_${randomUUID().slice(0, 8).replaceAll('-', '')}`;
    }

    function baseMeta(projectId) {
      return {
        projectId,
        proposer: { type: 'agent-proposer', id: 'e3-writer' },
        approver: { type: 'human-approver', id: 'e3-approver' },
        provenance: [
          {
            quotation: 'E3 boundary defense suite.',
            source: 'tests/formula-boundary.test.mjs:1',
            digest: sha256Hex('e3'),
          },
        ],
        timestamp: '2026-08-12T10:00:00.000Z',
      };
    }

    function addNode(type, id) {
      return { op: 'ADD', target: 'node', namespace: 'curated', type, id, properties: { id, status: 'active' } };
    }

    function fixtureChangeSet(fixture) {
      return {
        operations: [
          ...fixture.nodes.map((node) => ({
            op: 'ADD',
            target: 'node',
            namespace: node.namespace,
            type: node.type,
            id: node.id,
            properties: node.properties,
          })),
          ...fixture.edges.map((edge) => ({
            op: 'ADD',
            target: 'edge',
            namespace: edge.namespace,
            type: edge.type,
            fromId: edge.fromId,
            toId: edge.toId,
          })),
        ],
      };
    }

    // The ids currently materialized in a namespace, read through a WORKING identity so a
    // "no landing record" assertion is decided by a writer, never by the identity under test.
    async function curatedNodeIds(port) {
      return withTransaction(port, (tx) => tx.listNodes({ namespace: 'curated' }).then((nodes) => nodes.map((node) => node.id)));
    }

    // --- the boundary ---------------------------------------------------------------------------

    test('ensureReadonlyUser provisions idempotently and the user lands in the readonly group', async (t) => {
      const database = freshDatabase();
      await createDatabase(server, database);
      const username = freshUser();
      const password = `Rd-${randomUUID()}`;

      const first = await ensureReadonlyUser(server, { username, password, database });
      assert.equal(first.created, true);
      assert.equal(first.username, username);
      assert.equal(first.database, database);
      assert.equal(first.group, 'readonly');

      // The ENGINE would refuse the duplicate outright — so the second call succeeding is the
      // helper's own idempotency, not the engine silently tolerating a re-create.
      await assert.rejects(
        serverCommand(server, `create user ${JSON.stringify({ name: username, password, databases: { [database]: ['readonly'] } })}`),
        /already exists/i,
      );

      const second = await ensureReadonlyUser(server, { username, password, database });
      assert.equal(second.created, false);

      // Group membership is a BEHAVIORAL fact on this engine (no `list users`/`get user` server
      // command exists on the pinned release): the identity reads and is refused writes.
      const probe = { ...server, username, password };
      const read = await runSql(probe, database, `SELECT count(*) AS c FROM ${NODE_TYPE}`, 'sql');
      assert.equal(read[0].c, 0);
      await assert.rejects(
        runSql(
          probe,
          database,
          `CREATE VERTEX ${NODE_TYPE} SET ns = 'curated', sid = '', t = 'Rule', id = 'probe-write', p = '{}'`,
          'sql',
        ),
        /not allowed/i,
      );

      const readPort = createArcadeDbPort({ server, database, credentials: { username, password } });
      try {
        await assert.rejects(
          withTransaction(readPort, (tx) => tx.createNode({ namespace: 'curated', type: 'Rule', id: 'probe-write' })),
          /not allowed/i,
        );
      } finally {
        await readPort.close();
      }
      t.diagnostic(`provisioned read-only user ${username} on ${database} (created:true, re-run:false)`);
    });

    test('the read identity reads over HTTP and Bolt and every mutation is refused by the ENGINE with no landing record', async (t) => {
      const database = freshDatabase();
      const projectId = 'bnd';
      const PROJECT_ID = buildQualifiedId(projectId, 'project:root');
      await createDatabase(server, database);
      const writePort = createArcadeDbPort({ server, database });
      const seeded = await applyChangeSet(writePort, { operations: [addNode('Project', PROJECT_ID)] }, baseMeta(projectId));
      assert.equal(seeded.ok, true, `baseline apply failed: ${JSON.stringify(seeded.violations?.[0] ?? null)}`);

      const username = freshUser();
      const password = `Rd-${randomUUID()}`;
      await ensureReadonlyUser(server, { username, password, database });
      const readServer = { ...server, username, password };
      const readPort = createArcadeDbPort({ server, database, credentials: { username, password } });
      try {
        // reads work over BOTH protocols (defense in depth is a real read-only identity)
        const httpRead = await runSql(readServer, database, `SELECT count(*) AS c FROM ${NODE_TYPE} WHERE ns = 'curated'`, 'sql');
        assert.equal(httpRead[0].c, 1, 'the read identity must read over HTTP');
        const boltRead = await withTransaction(readPort, (tx) => tx.listNodes({ namespace: 'curated' }));
        assert.equal(boltRead.length, 1, 'the read identity must read over Bolt');

        // Bolt write refused by the ENGINE, not the adapter: an engine error carrying an
        // authorization message, and no landing record.
        await assert.rejects(
          withTransaction(readPort, (tx) => tx.createNode({ namespace: 'curated', type: 'Rule', id: 'read-write' })),
          (error) => {
            assert.equal(isPortError(error), false, 'the refusal must be the engine\'s, never a port code');
            assert.match(error.message, /not allowed/i, 'the refusal must be an authorization decision');
            return true;
          },
        );
        assert.ok(!(await curatedNodeIds(writePort)).includes('read-write'), 'the refused Bolt write must not have landed');

        // Bolt delete of an EXISTING record refused by the engine, record still present.
        await assert.rejects(
          withTransaction(readPort, (tx) => tx.deleteNode({ namespace: 'curated', id: PROJECT_ID })),
          /not allowed/i,
        );
        assert.ok((await curatedNodeIds(writePort)).includes(PROJECT_ID), 'the refused delete must not have landed');

        // HTTP write refused by the engine, no landing record.
        await assert.rejects(
          runSql(
            readServer,
            database,
            `CREATE VERTEX ${NODE_TYPE} SET ns = 'curated', sid = '', t = 'Rule', id = 'http-write', p = '{}'`,
            'sql',
          ),
          /not allowed/i,
        );
        assert.ok(!(await curatedNodeIds(writePort)).includes('http-write'), 'the refused HTTP write must not have landed');

        // Governance-level HTTP write refused: a non-root identity cannot run server commands.
        await assert.rejects(serverCommand(readServer, `drop database ${database}`), /only root user/i);
        t.diagnostic('read identity: Bolt+HTTP reads ok; Bolt+HTTP writes and server commands refused by the engine');
      } finally {
        await readPort.close();
      }
      await writePort.close();
    });

    test('the write identity still promotes the graph the read identity cannot mutate', async (t) => {
      const database = freshDatabase();
      const projectId = 'bnd';
      const PROJECT_ID = buildQualifiedId(projectId, 'project:root');
      const SURFACE_ID = buildQualifiedId(projectId, 'surface:s0');
      await createDatabase(server, database);
      const writePort = createArcadeDbPort({ server, database });
      try {
        const r1 = await applyChangeSet(writePort, { operations: [addNode('Project', PROJECT_ID)] }, baseMeta(projectId));
        assert.equal(r1.ok, true);
        const { headRevision: h1 } = await readChain(writePort, { projectId });
        assert.equal(h1, 'apex:bnd:revision:r1');

        const username = freshUser();
        const password = `Rd-${randomUUID()}`;
        await ensureReadonlyUser(server, { username, password, database });
        const readPort = createArcadeDbPort({ server, database, credentials: { username, password } });
        try {
          // the read identity sees the baseline but still cannot mutate it
          const seen = await withTransaction(readPort, (tx) => tx.listNodes({ namespace: 'curated' }));
          assert.deepEqual(seen.map((node) => node.type), ['Project']);
          await assert.rejects(
            withTransaction(readPort, (tx) => tx.createNode({ namespace: 'curated', type: 'Rule', id: 'by-reader' })),
            /not allowed/i,
          );

          // the write identity promotes the SAME graph: r1 -> r2 with a real Revision record
          const r2 = await applyChangeSet(
            writePort,
            {
              operations: [addNode('Surface', SURFACE_ID), { op: 'ADD', target: 'edge', namespace: 'curated', type: 'PART_OF', fromId: SURFACE_ID, toId: PROJECT_ID }],
            },
            baseMeta(projectId),
          );
          assert.equal(r2.ok, true, `promotion failed: ${JSON.stringify(r2.violations?.[0] ?? null)}`);
          const { headRevision: h2, revisions } = await readChain(writePort, { projectId });
          assert.equal(h2, 'apex:bnd:revision:r2');
          assert.equal(revisions.length, 2);

          // the read path reflects the promotion (read identity reads current state, never writes it)
          const after = await withTransaction(readPort, (tx) => tx.listNodes({ namespace: 'curated' }));
          assert.deepEqual(after.map((node) => node.type).sort(), ['Project', 'Surface'].sort());
        } finally {
          await readPort.close();
        }
      } finally {
        await writePort.close();
      }
      t.diagnostic('write identity promoted r1 -> r2 on the same graph the read identity cannot mutate');
    });

    test('resolveContext is byte-identical through the read and write identities', async (t) => {
      const database = freshDatabase();
      await createDatabase(server, database);
      const writePort = createArcadeDbPort({ server, database });
      const smoke = generateFixture('boundary-resolve', { scale: 0.02 });
      const applied = await applyChangeSet(writePort, fixtureChangeSet(smoke), baseMeta(smoke.projectId));
      assert.equal(applied.ok, true, `fixture apply failed: ${JSON.stringify(applied.violations?.[0] ?? null)}`);

      const username = freshUser();
      const password = `Rd-${randomUUID()}`;
      await ensureReadonlyUser(server, { username, password, database });
      const readPort = createArcadeDbPort({ server, database, credentials: { username, password } });
      try {
        const input = {
          projectId: smoke.projectId,
          paths: [smoke.packagePaths[0]],
          targets: [buildQualifiedId(smoke.projectId, 'rule:r0')],
        };
        const viaWrite = await resolveContext(writePort, input);
        const viaRead = await resolveContext(readPort, input);
        assert.equal(viaWrite.ok, true, `write-identity resolve failed: ${viaWrite.code}`);
        assert.equal(viaRead.ok, true, `read-identity resolve failed: ${viaRead.code}`);
        assert.equal(JSON.stringify(viaRead), JSON.stringify(viaWrite), 'read identity must not degrade the read result');
        assert.deepEqual(viaRead, viaWrite);
        t.diagnostic(`byte-identical resolveContext under both identities (${JSON.stringify(viaRead).length} bytes)`);
      } finally {
        await readPort.close();
      }
      await writePort.close();
    });
  });
}
