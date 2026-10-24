// ArcadeDB adapter + local server lifecycle (Task C1).
//
// Two layers, deliberately in one file:
//
//  1. UNIT (always runs, no docker): the pure pieces of `lifecycle.mjs` and `arcadedb.mjs` —
//     the pinned image tag, the localhost-only port bindings (spec §28), the identifier guards
//     that keep an external name out of a docker argv / an SQL admin command, the status state
//     machine (driven through injected fakes so every state is covered without docker), and the
//     property codec.
//  2. LIVE (docker-gated): the shared engine-port contract suite from
//     `formula-engine-contract.test.mjs` run verbatim against a real ArcadeDB, the container
//     state machine, and the capability MEASUREMENT that fills `ARCADEDB_CAPABILITIES`.
//
// Plan decision 4: when docker (or the pinned image) is unavailable the live layer SELF-SKIPS
// with an explicit printed reason — never silently. `npm test` stays green either way.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runEngineContractSuite } from './formula-engine-contract.test.mjs';
import { CAPABILITY_KEYS, validateCapabilities, PORT_ERROR_CODES, isPortError } from '../scripts/formula/engine/port.mjs';
import {
  ARCADEDB_IMAGE,
  CONTAINER_BOLT_PORT,
  CONTAINER_HTTP_PORT,
  LOOPBACK,
  SERVER_STATUS,
  assertContainerName,
  buildCreateArgs,
  containerNameFor,
  containerStateFrom,
  createContainer,
  destroyContainer,
  dockerGate,
  hostPortFrom,
  resolveRootPassword,
  serverStatus,
  startServer,
  stopContainer,
  volumeNameFor,
} from '../scripts/formula/engine/lifecycle.mjs';
import {
  ARCADEDB_CAPABILITIES,
  EDGE_TYPE,
  NODE_TYPE,
  SCHEMA_STATEMENTS,
  assertDatabaseName,
  createArcadeDbPort,
  createDatabase,
  databaseNameFor,
  decodeProperties,
  dropDatabase,
  encodeProperties,
  listDatabases,
  openDriver,
  runSql,
  serverCommand,
} from '../scripts/formula/engine/arcadedb.mjs';

// --- unit: the pinned release ------------------------------------------------------------------

test('the ArcadeDB image is pinned to an exact stable release >= 26.8.1', () => {
  const match = /^arcadedata\/arcadedb:(\d+)\.(\d+)\.(\d+)$/.exec(ARCADEDB_IMAGE);
  assert.ok(match, `image must be pinned to an exact release tag, got '${ARCADEDB_IMAGE}'`);
  assert.ok(!/latest|snapshot/i.test(ARCADEDB_IMAGE), 'a floating or snapshot tag is not a pin');
  const [, year, month, patch] = match.map(Number);
  assert.ok(
    year > 26 || (year === 26 && (month > 8 || (month === 8 && patch >= 1))),
    `pinned release must be >= 26.8.1, got '${ARCADEDB_IMAGE}'`,
  );
});

// --- unit: the container is bound to localhost only (spec §28) ---------------------------------

test('buildCreateArgs publishes every port on the loopback interface only', () => {
  const args = buildCreateArgs({ name: 'apex-graph-demo', password: 'secret-pw', httpPort: 2480, boltPort: 7687 });
  const published = args.filter((arg, index) => args[index - 1] === '-p');
  assert.deepEqual(published, [`${LOOPBACK}:2480:${CONTAINER_HTTP_PORT}`, `${LOOPBACK}:7687:${CONTAINER_BOLT_PORT}`]);
  assert.ok(published.every((mapping) => mapping.startsWith(`${LOOPBACK}:`)), 'a 0.0.0.0 binding would expose the graph');
  assert.equal(args.at(-1), ARCADEDB_IMAGE, 'the image is the last argument and is the pinned one');
  assert.deepEqual(args.slice(0, 3), ['create', '--name', 'apex-graph-demo']);
});

test('buildCreateArgs asks docker for an ephemeral host port when one is not given', () => {
  const args = buildCreateArgs({ name: 'apex-graph-demo', password: 'secret-pw' });
  const published = args.filter((arg, index) => args[index - 1] === '-p');
  assert.deepEqual(published, [`${LOOPBACK}::${CONTAINER_HTTP_PORT}`, `${LOOPBACK}::${CONTAINER_BOLT_PORT}`]);
});

test('buildCreateArgs injects the root password through the container environment, once', () => {
  const args = buildCreateArgs({ name: 'apex-graph-demo', password: 'secret-pw' });
  const env = args.filter((arg, index) => args[index - 1] === '-e');
  const settings = env.filter((value) => value.includes('secret-pw'));
  assert.equal(settings.length, 1, 'the password must appear exactly once, in ARCADEDB_SETTINGS');
  assert.match(settings[0], /^ARCADEDB_SETTINGS=.*-Darcadedb\.server\.rootPassword=secret-pw/);
  assert.ok(
    args.every((arg) => arg !== 'secret-pw'),
    'the password must never be a bare argv entry',
  );
});

test('buildCreateArgs enables the Bolt protocol plugin explicitly', () => {
  // MEASURED on the pinned release: ArcadeDB auto-discovers MCP and the backup scheduler but NOT
  // Neo4j-Bolt — without this setting the server starts, answers HTTP, reports itself ready, and
  // then closes every Bolt connection ("Connection was closed by server"). The whole adapter
  // depends on it, so it is pinned here rather than left to a default.
  const args = buildCreateArgs({ name: 'apex-graph-demo', password: 'secret-pw' });
  const settings = args.find((value) => value.startsWith('ARCADEDB_SETTINGS='));
  assert.match(settings, /-Darcadedb\.server\.plugins=\S*com\.arcadedb\.bolt\.BoltProtocolPlugin/);
});

test('buildCreateArgs mounts a named volume only when one is asked for', () => {
  const withVolume = buildCreateArgs({ name: 'apex-graph-demo', password: 'pw', volume: 'apex-graph-demo-data' });
  assert.ok(withVolume.includes('-v'), 'a volume was requested');
  assert.ok(withVolume.some((arg) => arg.startsWith('apex-graph-demo-data:/')), 'the volume is mounted on the data path');
  const withoutVolume = buildCreateArgs({ name: 'apex-graph-demo', password: 'pw' });
  assert.ok(!withoutVolume.includes('-v'), 'an ephemeral container has no volume');
});

// --- unit: identifier guards (an external name must never reach argv / an admin command) -------

test('assertContainerName rejects everything that is not a plain container slug', () => {
  for (const good of ['apex-graph-demo', 'apex_graph_1', 'a', 'A1.b-c']) {
    assert.equal(assertContainerName(good), good, good);
  }
  for (const bad of ['', '-rm', '.hidden', 'a b', 'a;rm -rf /', 'a/b', 'a$(id)', 'x'.repeat(129), 42, null, undefined]) {
    assert.throws(() => assertContainerName(bad), /container name/i, String(bad));
  }
});

test('containerNameFor gives each project its own container and refuses a hostile project id', () => {
  // §24: one server per project, so two projects on one machine must not collide.
  assert.equal(containerNameFor('demo'), 'apex-graph-demo');
  assert.notEqual(containerNameFor('demo'), containerNameFor('other'));
  assert.equal(volumeNameFor(containerNameFor('demo')), 'apex-graph-demo-data');
  for (const bad of ['a/b', 'a b', '--privileged', 'a;id', '']) {
    assert.throws(() => containerNameFor(bad), /container name/i, String(bad));
  }
});

test('assertDatabaseName rejects anything that could break out of the admin SQL command', () => {
  for (const good of ['apex_demo', 'apex_contract_0af3', 'A9']) {
    assert.equal(assertDatabaseName(good), good, good);
  }
  for (const bad of ['', '1db', 'my-db', 'a b', 'a;drop database x', '../etc', 'x'.repeat(65), 42, null, undefined]) {
    assert.throws(() => assertDatabaseName(bad), /database name/i, String(bad));
  }
});

test('databaseNameFor maps one project to exactly one legal database, folding hyphens', () => {
  assert.equal(databaseNameFor('demo'), 'apex_graph_demo');
  assert.equal(databaseNameFor('cli-graph-abc123'), 'apex_graph_cli_graph_abc123');
  for (const bad of ['', 'Not A Project', 'UPPER', 42, null, undefined]) {
    assert.throws(() => databaseNameFor(bad), /project id/i, String(bad));
  }
  // The mapping must always land inside the database-name rule, never assume it.
  assert.equal(assertDatabaseName(databaseNameFor('a-b-c')), databaseNameFor('a-b-c'));
});

test('resolveRootPassword prefers the environment and otherwise derives a fresh per-run secret', () => {
  assert.equal(resolveRootPassword({ APEX_GRAPH_PASSWORD: 'from-env' }), 'from-env');
  const first = resolveRootPassword({});
  const second = resolveRootPassword({});
  assert.notEqual(first, second, 'a derived password is per-run, never a committed constant');
  assert.ok(first.length >= 24, 'a derived password must not be guessable');
});

// --- unit: the status state machine (every state, no docker required) --------------------------

const INSPECT_RUNNING = JSON.stringify([
  {
    State: { Status: 'running', Running: true },
    NetworkSettings: {
      Ports: {
        '2480/tcp': [{ HostIp: '127.0.0.1', HostPort: '49160' }],
        '7687/tcp': [{ HostIp: '127.0.0.1', HostPort: '49161' }],
      },
    },
  },
]);

test('containerStateFrom reads the container state out of a docker inspect payload', () => {
  assert.equal(containerStateFrom(INSPECT_RUNNING), 'running');
  assert.equal(containerStateFrom(JSON.stringify([{ State: { Status: 'created' } }])), 'created');
  assert.equal(containerStateFrom(JSON.stringify([{ State: { Status: 'exited' } }])), 'exited');
  for (const bad of ['', 'not json', '[]', '{}']) assert.equal(containerStateFrom(bad), null, bad);
});

test('hostPortFrom reads the published loopback port for a container port', () => {
  assert.equal(hostPortFrom(INSPECT_RUNNING, CONTAINER_HTTP_PORT), 49160);
  assert.equal(hostPortFrom(INSPECT_RUNNING, CONTAINER_BOLT_PORT), 49161);
  assert.equal(hostPortFrom(JSON.stringify([{ State: {}, NetworkSettings: { Ports: {} } }]), 2480), null);
  assert.equal(hostPortFrom('not json', 2480), null);
});

// A fake `docker` runner: one canned result per subcommand, so the whole status machine is
// exercised without a docker daemon.
function fakeDocker(results) {
  return (args) => {
    const key = args[0] === 'inspect' ? 'inspect' : args.join(' ');
    const result = results[key] ?? results[args[0]];
    if (!result) return { ok: false, status: 127, stdout: '', stderr: `unexpected docker ${args.join(' ')}` };
    return { ok: true, status: 0, stdout: '', stderr: '', ...result };
  };
}

test('serverStatus reports every distinguishable state of the local server', async () => {
  const noDocker = await serverStatus({
    name: 'apex-graph-demo',
    docker: () => ({ ok: false, status: 127, stdout: '', stderr: 'docker: command not found' }),
  });
  assert.equal(noDocker.status, SERVER_STATUS.NO_DOCKER);
  assert.match(noDocker.reason, /docker/i);

  const absent = await serverStatus({
    name: 'apex-graph-demo',
    docker: fakeDocker({ version: { stdout: '29.6.1' }, inspect: { ok: false, status: 1, stderr: 'No such object' } }),
  });
  assert.equal(absent.status, SERVER_STATUS.ABSENT);

  const created = await serverStatus({
    name: 'apex-graph-demo',
    docker: fakeDocker({ version: { stdout: '29.6.1' }, inspect: { stdout: JSON.stringify([{ State: { Status: 'created' } }]) } }),
  });
  assert.equal(created.status, SERVER_STATUS.CREATED);

  const stopped = await serverStatus({
    name: 'apex-graph-demo',
    docker: fakeDocker({ version: { stdout: '29.6.1' }, inspect: { stdout: JSON.stringify([{ State: { Status: 'exited' } }]) } }),
  });
  assert.equal(stopped.status, SERVER_STATUS.STOPPED);

  const starting = await serverStatus({
    name: 'apex-graph-demo',
    docker: fakeDocker({ version: { stdout: '29.6.1' }, inspect: { stdout: INSPECT_RUNNING } }),
    probeReady: async () => false,
  });
  assert.equal(starting.status, SERVER_STATUS.STARTING);
  assert.equal(starting.httpPort, 49160, 'the published ports are reported as soon as the container runs');

  const ready = await serverStatus({
    name: 'apex-graph-demo',
    docker: fakeDocker({ version: { stdout: '29.6.1' }, inspect: { stdout: INSPECT_RUNNING } }),
    probeReady: async () => true,
  });
  assert.equal(ready.status, SERVER_STATUS.READY);
  assert.equal(ready.boltPort, 49161);
  assert.equal(ready.boltUrl, `bolt://${LOOPBACK}:49161`);
  assert.equal(ready.httpUrl, `http://${LOOPBACK}:49160`);
});

// --- unit: the property codec ------------------------------------------------------------------

test('the property codec round-trips the whole portable JSON domain byte-exact', () => {
  const bags = [
    {},
    { status: 'active', enabled: false, weight: -1.5, count: Number.MAX_SAFE_INTEGER, zero: 0, missing: null },
    { tags: ['a', 1, true, null, ['nested', { deep: 'value' }]], emptyList: [], emptyBag: {} },
    { hostile: `O'Brien"; DROP DATABASE apex; --`, backslash: 'back\\slash\\', control: 'line1\nline2\ttabbed' },
    { unicode: 'unicode: ü é 漢字 🙂', rtl: '‮reversed', dollar: '${injected}' },
  ];
  for (const bag of bags) {
    const encoded = encodeProperties(bag);
    assert.equal(typeof encoded, 'string', 'the engine stores the bag as one scalar string property');
    assert.deepEqual(decodeProperties(encoded), bag);
  }
  assert.deepEqual(decodeProperties(encodeProperties(undefined)), {}, 'an omitted bag encodes as empty');
});

test('decodeProperties refuses a corrupt bag instead of returning an empty one', () => {
  // A port that promises byte-exact round-trip must not answer a damaged record with `{}` — that
  // turns corruption into plausible-looking data. Unreadable storage is a fault, not a value.
  for (const corrupt of ['{"unterminated": ', 'not json at all', '[1,2]', '"a string"', '42', 'null', '', undefined, null, 42]) {
    assert.throws(() => decodeProperties(corrupt), /propert/i, JSON.stringify(corrupt) ?? String(corrupt));
  }
});

// --- unit: the declared capability map ----------------------------------------------------------

test('ARCADEDB_CAPABILITIES is a frozen, contract-shaped declaration', () => {
  assert.deepEqual(validateCapabilities(ARCADEDB_CAPABILITIES), []);
  assert.deepEqual(Object.keys(ARCADEDB_CAPABILITIES).sort(), [...CAPABILITY_KEYS].sort());
  assert.ok(Object.isFrozen(ARCADEDB_CAPABILITIES));
  // The values are MEASURED by 'capabilities are measured against the live engine' below; this
  // pins what the adapter claims so a silent edit cannot drift away from the measurement.
  assert.deepEqual(ARCADEDB_CAPABILITIES, {
    roles: true,
    nativeConstraints: true,
    onlineBackup: true,
    atomicCutover: false,
  });
});

test('the storage schema is namespace-logical: one node type and one edge type, scoped by property', () => {
  // Namespaces are a property dimension, not physically separate stores, so a later port
  // amendment for declared cross-namespace edge types (pending decision D1) stays cheap.
  assert.equal(NODE_TYPE, 'ApexNode');
  assert.equal(EDGE_TYPE, 'ApexEdge');
  const schema = SCHEMA_STATEMENTS.join('\n');
  assert.match(schema, /CREATE VERTEX TYPE ApexNode/);
  assert.match(schema, /CREATE EDGE TYPE ApexEdge/);
  assert.match(schema, /CREATE INDEX ON ApexNode \(ns, sid, id\) UNIQUE/);
  assert.ok(Object.isFrozen(SCHEMA_STATEMENTS));
});

test('createArcadeDbPort refuses a malformed target before it can reach the engine', () => {
  const server = { httpUrl: `http://${LOOPBACK}:2480`, boltUrl: `bolt://${LOOPBACK}:7687`, username: 'root', password: 'pw' };
  assert.throws(() => createArcadeDbPort({ server, database: 'no-hyphens-allowed' }), /database name/i);
  assert.throws(() => createArcadeDbPort({ database: 'apex_demo' }), /server/i);
});

// --- live: docker-gated ------------------------------------------------------------------------

// Faults in the PROBE, not decisions by the engine. A capability measurement that accepts one of
// these accepts a typo forever: a renamed property or a broken statement would "prove" the
// constraint it was meant to exercise.
const PROBE_FAULT_CODES = [
  'Neo.ClientError.Statement.SyntaxError',
  'Neo.ClientError.Statement.ParameterMissing',
  'Neo.ClientError.Statement.TypeError',
  'ServiceUnavailable',
  'SessionExpired',
];

// Asserts the engine REFUSED something, and that the refusal is attributable to the engine's own
// rule rather than to a mistake in the probe. Returns the error so a caller can assert its content.
async function engineRefused(promise, label) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `${label}: the engine ACCEPTED what the capability claim says it refuses`);
  assert.ok(
    !PROBE_FAULT_CODES.includes(error.code),
    `${label}: this is a broken probe, not an engine refusal — ${error.code}: ${error.message}`,
  );
  return error;
}

// Post-state check: a refusal is only real if the write is genuinely not there afterwards.
async function countNodes(session, id) {
  const rows = await session.run(`MATCH (n:${NODE_TYPE} {ns:$ns, sid:$sid, id:$id}) RETURN count(*) AS c`, {
    ns: 'curated',
    sid: '',
    id,
  });
  return rows.records[0].get('c');
}

const gate = dockerGate();
const CONTAINER = 'apex-formula-contract-test';

if (!gate.ok) {
  test(`ArcadeDB live suite (docker-gated): ${gate.reason}`, (t) => {
    t.diagnostic(`SKIPPED — ${gate.reason} (pinned image ${ARCADEDB_IMAGE})`);
    t.skip(gate.reason);
  });
} else {
  let server = null;

  describe('arcadedb live server', () => {
    before(async () => {
      await destroyContainer(CONTAINER, { removeVolume: true }); // a crashed earlier run leaves no trap
      server = await startServer({ name: CONTAINER, timeoutMs: 90_000 });
    });

    after(async () => {
      await destroyContainer(CONTAINER, { removeVolume: true });
      server = null;
    });

    test('the lifecycle helper walks absent -> created -> ready -> stopped -> absent', async () => {
      const name = `${CONTAINER}-lifecycle`;
      const password = resolveRootPassword({});
      await destroyContainer(name, { removeVolume: true });
      try {
        assert.equal((await serverStatus({ name })).status, SERVER_STATUS.ABSENT);
        await createContainer({ name, password });
        assert.equal((await serverStatus({ name })).status, SERVER_STATUS.CREATED, 'created but never started');
        // startServer is idempotent: it must adopt the existing container (and read its password
        // back) rather than trying to create a second one.
        const started = await startServer({ name, timeoutMs: 90_000 });
        assert.equal((await serverStatus({ name })).status, SERVER_STATUS.READY);
        assert.equal(started.password, password, 'the adopted container keeps its own credentials');
        assert.equal(started.boltUrl, `bolt://${LOOPBACK}:${started.boltPort}`);
        await stopContainer(name);
        assert.equal((await serverStatus({ name })).status, SERVER_STATUS.STOPPED);
      } finally {
        await destroyContainer(name, { removeVolume: true });
      }
      assert.equal((await serverStatus({ name })).status, SERVER_STATUS.ABSENT);
    });

    test('a database is provisioned with the storage schema and dropped without residue', async () => {
      const database = `apex_probe_${randomUUID().replaceAll('-', '')}`;
      await createDatabase(server, database);
      assert.ok((await listDatabases(server)).includes(database));
      const types = await runSql(server, database, 'SELECT name FROM schema:types');
      assert.deepEqual(
        types.map((row) => row.name).sort(),
        [EDGE_TYPE, NODE_TYPE].sort(),
      );
      await dropDatabase(server, database);
      assert.ok(!(await listDatabases(server)).includes(database));
    });

    test('capabilities are measured against the live engine, never copied from documentation', async (t) => {
      const database = `apex_caps_${randomUUID().replaceAll('-', '')}`;
      const user = `apex_reader_${randomUUID().slice(0, 8).replaceAll('-', '')}`;
      const password = `Rd-${randomUUID()}`;
      await createDatabase(server, database);
      const root = openDriver(server);
      const reader = openDriver({ ...server, username: user, password });
      const measured = {};
      try {
        const session = root.session({ database });
        const create = (id) =>
          session.run(`CREATE (n:${NODE_TYPE} {ns:$ns, sid:$sid, t:$t, id:$id, p:$p}) RETURN n.id AS id`, {
            ns: 'curated',
            sid: '',
            t: 'Rule',
            id,
            p: '{}',
          });
        await create('measured');

        // nativeConstraints: the engine itself must refuse a duplicate identity and a record
        // missing a mandatory property — the adapter's own pre-checks are bypassed here on purpose.
        // Each probe is a CONTROLLED measurement: the same statement (or the same statement minus
        // one property) was accepted a moment earlier, the refusal must not be a fault in the probe
        // itself, and the post-state must show the write really did not land.
        const duplicate = await engineRefused(create('measured'), 'duplicate (ns, sid, id)');
        assert.equal(await countNodes(session, 'measured'), 1, 'the duplicate must not have landed');

        const mandatory = await engineRefused(
          session.run(`CREATE (n:${NODE_TYPE} {ns:$ns, sid:$sid, id:$id, p:$p}) RETURN n.id AS id`, {
            ns: 'curated',
            sid: '',
            id: 'no-type',
            p: '{}',
          }),
          'record missing the mandatory property t',
        );
        assert.equal(await countNodes(session, 'no-type'), 0, 'the incomplete record must not have landed');
        measured.nativeConstraints = Boolean(duplicate && mandatory);

        // roles: a server-side read-only identity must be able to read and unable to write.
        await serverCommand(
          server,
          `create user ${JSON.stringify({ name: user, password, databases: { [database]: ['readonly'] } })}`,
        );
        const readerSession = reader.session({ database });
        let readerRead = false;
        let readerWriteRefused = false;
        let readerDeleteRefused = false;
        try {
          const rows = await readerSession.run(`MATCH (n:${NODE_TYPE}) RETURN count(*) AS c`);
          readerRead = rows.records[0].get('c') === 1;

          // The same statement the root user just ran successfully — only the identity differs, so
          // an authorization message is attributable to the role and nothing else.
          const write = await engineRefused(
            readerSession.run(`CREATE (n:${NODE_TYPE} {ns:$ns, sid:$sid, t:$t, id:$id, p:$p}) RETURN n.id AS id`, {
              ns: 'curated',
              sid: '',
              t: 'Rule',
              id: 'by-reader',
              p: '{}',
            }),
            'write by a readonly identity',
          );
          assert.match(write.message, /not allowed/i, 'the refusal must be an authorization decision');
          assert.equal(await countNodes(session, 'by-reader'), 0, 'the readonly write must not have landed');
          readerWriteRefused = true;

          const remove = await engineRefused(
            readerSession.run(`MATCH (n:${NODE_TYPE}) DETACH DELETE n`),
            'delete by a readonly identity',
          );
          assert.match(remove.message, /not allowed to delete/i, 'the refusal must name the delete permission');
          assert.equal(await countNodes(session, 'measured'), 1, 'the readonly delete must not have landed');
          readerDeleteRefused = true;
        } finally {
          await readerSession.close();
        }
        measured.roles = readerRead && readerWriteRefused && readerDeleteRefused;

        // onlineBackup: a backup taken while the server keeps serving, with no stop/restart.
        const backup = await runSql(server, database, 'BACKUP DATABASE');
        assert.equal(backup[0]?.result, 'OK', 'the backup must report success');
        assert.match(String(backup[0]?.backupFile), new RegExp(`^${database}-backup-\\d+-\\d+\\.zip$`), 'a real archive');
        const stillServing = await session.run(`MATCH (n:${NODE_TYPE}) RETURN count(*) AS c`);
        assert.equal(stillServing.records[0].get('c'), 1, 'the server must still answer after the backup');
        assert.ok((await listDatabases(server)).includes(database), 'the database must still be mounted');
        measured.onlineBackup = true;

        // atomicCutover: the server command vocabulary has no database swap/rename, so a shadow
        // graph cannot be moved into place in one atomic step. The refusal must be "no such
        // command" — not a permission or a name problem — and nothing may have moved.
        let renameRefused = false;
        await serverCommand(server, `rename database ${database} to ${database}_next`).catch((error) => {
          assert.match(error.message, /not valid/i, 'the server must reject the command itself');
          renameRefused = true;
        });
        const databases = await listDatabases(server);
        assert.ok(databases.includes(database) && !databases.includes(`${database}_next`), 'nothing was renamed');
        measured.atomicCutover = !renameRefused;

        await session.close();
        t.diagnostic(`measured capabilities: ${JSON.stringify(measured)}`);
        assert.deepEqual(measured, { ...ARCADEDB_CAPABILITIES }, 'the declared map must match the measurement');
      } finally {
        await reader.close();
        await root.close();
        await serverCommand(server, `drop user ${user}`).catch(() => {});
        await dropDatabase(server, database).catch(() => {});
      }
    });

    test('the adapter never assembles a value into Cypher: a hostile id cannot execute', async () => {
      const database = `apex_inject_${randomUUID().replaceAll('-', '')}`;
      await createDatabase(server, database);
      const port = createArcadeDbPort({ server, database, dropDatabaseOnClose: true });
      try {
        const tx = await port.begin();
        await tx.createNode({ namespace: 'curated', type: 'Rule', id: '`) MATCH (n) DETACH DELETE n //' });
        await tx.createNode({ namespace: 'curated', type: 'Rule', id: 'survivor' });
        await tx.commit();
        const read = await port.begin();
        const ids = (await read.listNodes({ namespace: 'curated' })).map((node) => node.id).sort();
        await read.rollback();
        assert.deepEqual(ids, ['`) MATCH (n) DETACH DELETE n //', 'survivor'].sort());
      } finally {
        await port.close();
      }
    });

    test('an operation on a dropped database fails as an ENGINE error, never as a port code', async () => {
      // Infrastructure failure has no entry in PORT_ERROR_CODES, so it must NOT be dressed up as
      // one: a caller that sees a PortError is entitled to believe the vocabulary's meaning (here,
      // that the port was closed or the record was missing — both false and both misleading).
      const database = `apex_gone_${randomUUID().replaceAll('-', '')}`;
      await createDatabase(server, database);
      const port = createArcadeDbPort({ server, database });
      await dropDatabase(server, database);

      let caught = null;
      try {
        const tx = await port.begin();
        await tx.createNode({ namespace: 'curated', type: 'Rule', id: 'ghost' });
        await tx.commit();
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, 'writing to a database that no longer exists must not succeed silently');
      assert.equal(isPortError(caught), false, `an engine failure must stay an engine failure, got ${caught.code}`);
      assert.match(caught.message, /nosuchdb|does not exist|apex_gone/i, 'the engine says what is wrong');
      await port.close();
    });

    // The factory contract: a fresh, isolated, empty database per call, dropped by close().
    runEngineContractSuite('arcadedb', async () => {
      const database = `apex_contract_${randomUUID().replaceAll('-', '')}`;
      await createDatabase(server, database);
      return createArcadeDbPort({ server, database, dropDatabaseOnClose: true });
    });
  });
}
