// Shared engine-port contract suite (Task B3, bake-off protocol item 1's harness).
//
// `runEngineContractSuite(name, makePort)` is written ONCE and reused verbatim by every engine
// adapter: the in-memory reference adapter here, ArcadeDB at task C1, Neo4j CE at the
// conditional task E5. Every assertion goes through the port API declared in
// `scripts/formula/engine/port.mjs` — never through an adapter's internals — so a suite that is
// green here transfers to a live engine behind a docker gate without edits.
//
// FACTORY PRECONDITION — every test calls `makePort()` and closes the port it gets back, and it
// assumes each call yields a PRISTINE, EMPTY, ISOLATED store, disposed by `close()`. A factory
// that hands out fresh handles onto one shared store fails this suite: tests would see each
// other's records. A real engine therefore provisions (and drops) a dedicated database per call,
// e.g. for ArcadeDB:
//
//   const makePort = async () => {
//     const database = `apex_contract_${randomUUID().replaceAll('-', '')}`;
//     await createDatabase(server, database);                 // fresh, empty
//     return createArcadeDbPort({ ...config, database });     // close() drops it again
//   };
//   if (!dockerAvailable) test('arcadedb contract suite skipped: docker unavailable', { skip: true }, () => {});
//   else runEngineContractSuite('arcadedb', makePort);
//
// The first test below asserts the precondition, so a factory that violates it fails fast with a
// pointed diagnostic instead of a scatter of confusing downstream failures.
//
// Importing this module also registers the memory run below in the importing process — the
// reference adapter is simply verified twice, which is harmless and keeps the export trivial.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAMESPACES,
  SCENARIO_NAMESPACE,
  BRIDGE_RELATIONSHIPS,
  edgeEndpointMissing,
  endpointScopePairs,
  isNamespace,
  CAPABILITY_KEYS,
  validateCapabilities,
  PORT_ERROR_CODES,
  PortError,
  isPortError,
  withTransaction,
  normalizeScope,
  scopeOf,
  checkEdgeKey,
  nodeNotFound,
} from '../scripts/formula/engine/port.mjs';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';

// --- suite helpers (port API only) -----------------------------------------------------------

async function withPort(makePort, fn) {
  const port = await makePort();
  try {
    return await fn(port);
  } finally {
    await port.close();
  }
}

// Runs `fn(tx)` in a committed transaction and returns its result.
function inTx(port, fn) {
  return withTransaction(port, fn);
}

// Asserts that `promise` rejects with a PortError carrying `code`, and returns the error so the
// caller can inspect `identity`.
async function rejectsWithCode(promise, code, message) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== undefined, `expected a rejection with code '${code}' ${message ?? ''}`);
  assert.ok(isPortError(caught), `expected a PortError, got ${caught}`);
  assert.equal(caught.code, code, message);
  return caught;
}

const RULE_ID = 'apex:proj:rule:sanitize-external-input';
const SURFACE_ID = 'apex:proj:surface:scripts';
const COMPONENT_ID = 'apex:proj:component:engine';
const PACKAGE_ID = 'apex:proj:package:engine';
const WORKSPACE_ID = 'apex:proj:workspace:root';
const AGENT_ID = 'apex:proj:agent:scripts-agent';
const SYSTEM_ID = 'apex:proj:system:graph';

// Sorted ids of a listNodes query — list order is deliberately NOT part of the port contract
// (no engine guarantees one without an explicit sort).
async function idsOf(port, query) {
  const nodes = await inTx(port, (tx) => tx.listNodes(query));
  return nodes.map((node) => node.id).sort();
}

// Edge records of a listEdges query, in a deterministic order for comparison.
async function edgesOf(port, query) {
  const edges = await inTx(port, (tx) => tx.listEdges(query));
  return edges.sort((a, b) => `${a.type}${a.fromId}${a.toId}`.localeCompare(`${b.type}${b.fromId}${b.toId}`));
}

// The two endpoints most edge tests need, created in the scope under test.
async function seedEndpoints(tx, namespace, scenarioId) {
  await tx.createNode({ namespace, scenarioId, type: 'Rule', id: RULE_ID });
  await tx.createNode({ namespace, scenarioId, type: 'Surface', id: SURFACE_ID });
}

function seedCurated(port) {
  return inTx(port, (tx) => seedEndpoints(tx, 'curated'));
}

// The endpoints of both declared bridge relationships: a curated Rule and Component, plus the
// topology Package that is IMPLEMENTS's source and APPLIES_TO's target.
async function seedBridgeEndpoints(tx) {
  await seedEndpoints(tx, 'curated');
  await tx.createNode({ namespace: 'curated', type: 'Component', id: COMPONENT_ID });
  await tx.createNode({ namespace: 'topology', type: 'Package', id: PACKAGE_ID });
}

// Values an adapter must carry through parameterized inputs untouched: quote/comment breakouts,
// Cypher and template-literal injection shapes, JSON-shaped text, control whitespace, escapes and
// non-ASCII (including a right-to-left override).
const HOSTILE_STRINGS = [
  `O'Brien"; DROP DATABASE apex; --`,
  '`) MATCH (n) DETACH DELETE n //',
  '$scenarioId',
  '${injected}',
  '{"json":"shaped","n":[1,2]}',
  'line1\nline2\ttabbed',
  'back\\slash\\',
  'unicode: ü é 漢字 🙂',
  '\u202Ereversed',
];

// Scope of one promotion scenario, spread into an operation's argument object.
function scenario(suffix) {
  return { namespace: SCENARIO_NAMESPACE, scenarioId: `scenario-${suffix}` };
}

// One entry per namespace-scoped operation — `input` is a well-formed argument object that tests
// can extend or corrupt, `run` applies it. Lets scope and argument validation be asserted for
// every operation at once instead of picking a representative one.
function operations(namespace) {
  const edge = { namespace, type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID };
  return [
    { name: 'createNode', input: { namespace, type: 'Rule', id: RULE_ID, properties: {} }, run: (tx, i) => tx.createNode(i) },
    { name: 'getNode', input: { namespace, id: RULE_ID }, run: (tx, i) => tx.getNode(i) },
    { name: 'updateNode', input: { namespace, id: RULE_ID, properties: {} }, run: (tx, i) => tx.updateNode(i) },
    { name: 'deleteNode', input: { namespace, id: RULE_ID }, run: (tx, i) => tx.deleteNode(i) },
    { name: 'listNodes', input: { namespace }, run: (tx, i) => tx.listNodes(i) },
    { name: 'createEdge', input: { ...edge }, run: (tx, i) => tx.createEdge(i) },
    { name: 'getEdge', input: { ...edge }, run: (tx, i) => tx.getEdge(i) },
    { name: 'deleteEdge', input: { ...edge }, run: (tx, i) => tx.deleteEdge(i) },
    { name: 'listEdges', input: { namespace }, run: (tx, i) => tx.listEdges(i) },
  ];
}

function namespacedCalls(namespace) {
  return operations(namespace).map(({ name, input, run }) => ({ name, run: (tx) => run(tx, input) }));
}

export function runEngineContractSuite(name, makePort) {
  describe(`engine port contract — ${name}`, () => {
    // --- factory precondition (asserted first: every later test depends on it) ------------------

    test('makePort() yields a pristine store: every namespace is empty on a fresh port', async () => {
      await withPort(makePort, async (port) => {
        for (const namespace of NAMESPACES) {
          const scope = namespace === SCENARIO_NAMESPACE ? scenario('probe') : { namespace };
          const diagnostic = `namespace '${namespace}' must be empty on a fresh port — makePort() must provision an isolated store per call`;
          assert.deepEqual(await inTx(port, (tx) => tx.listNodes(scope)), [], diagnostic);
          assert.deepEqual(await inTx(port, (tx) => tx.listEdges(scope)), [], diagnostic);
        }
      });
    });

    test('two ports from the same factory are isolated: writes to one are invisible to the other', async () => {
      await withPort(makePort, async (first) => {
        await inTx(first, (tx) => tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID }));
        await withPort(makePort, async (second) => {
          assert.deepEqual(
            await idsOf(second, { namespace: 'curated' }),
            [],
            'makePort() must provision an isolated store per call, not a handle onto a shared one',
          );
        });
      });
    });

    // --- capability map (spec §19, §20: additive native capabilities, declared never assumed) --

    test('capabilities() declares exactly the contract capability keys as booleans', async () => {
      await withPort(makePort, async (port) => {
        const capabilities = await port.capabilities();
        assert.deepEqual(validateCapabilities(capabilities), []);
        assert.deepEqual(Object.keys(capabilities).sort(), [...CAPABILITY_KEYS].sort());
      });
    });

    test('a caller cannot tamper with the declared capability map', async () => {
      await withPort(makePort, async (port) => {
        const first = await port.capabilities();
        const declaredRoles = first.roles;
        try {
          first.roles = !declaredRoles;
        } catch {
          // A frozen declaration is an equally valid way to satisfy this contract.
        }
        const second = await port.capabilities();
        assert.deepEqual(validateCapabilities(second), []);
        assert.equal(second.roles, declaredRoles, 'the flip must not stick');
      });
    });

    // --- port lifecycle ------------------------------------------------------------------------

    test('close() is idempotent and begin() after close rejects with PORT_CLOSED', async () => {
      const port = await makePort();
      await port.close();
      await port.close();
      await rejectsWithCode(port.begin(), PORT_ERROR_CODES.PORT_CLOSED);
    });

    // --- transactions --------------------------------------------------------------------------

    test('a committed write is visible to a later transaction', async () => {
      await withPort(makePort, async (port) => {
        const tx = await port.begin();
        await tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: { status: 'active' } });
        await tx.commit();

        const read = await port.begin();
        const node = await read.getNode({ namespace: 'curated', id: RULE_ID });
        await read.rollback();
        assert.equal(node.id, RULE_ID);
      });
    });

    test('a rolled-back transaction leaves no trace', async () => {
      await withPort(makePort, async (port) => {
        const tx = await port.begin();
        await tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: { status: 'active' } });
        await tx.rollback();

        const read = await port.begin();
        assert.equal(await read.getNode({ namespace: 'curated', id: RULE_ID }), null);
        assert.deepEqual(await read.listNodes({ namespace: 'curated' }), []);
        await read.rollback();
      });
    });

    test('rollback also undoes updates, deletions and a scenario drop', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await seedEndpoints(tx, 'curated');
          await tx.updateNode({ namespace: 'curated', id: RULE_ID, properties: { status: 'active' } });
          await tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID });
          await seedEndpoints(tx, SCENARIO_NAMESPACE, 'scenario-a');
          await tx.createEdge({ ...scenario('a'), type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID });
        });

        const tx = await port.begin();
        await tx.updateNode({ namespace: 'curated', id: RULE_ID, properties: { status: 'deprecated' } });
        await tx.deleteEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID });
        await tx.deleteNode({ namespace: 'curated', id: SURFACE_ID });
        await tx.dropScenario({ scenarioId: 'scenario-a' });
        await tx.rollback();

        const rule = await inTx(port, (tx2) => tx2.getNode({ namespace: 'curated', id: RULE_ID }));
        assert.deepEqual(rule.properties, { status: 'active' }, 'the update must be undone');
        assert.deepEqual(await idsOf(port, { namespace: 'curated' }), [RULE_ID, SURFACE_ID].sort());
        assert.equal((await edgesOf(port, { namespace: 'curated' })).length, 1, 'the edge deletion must be undone');
        assert.deepEqual(await idsOf(port, scenario('a')), [RULE_ID, SURFACE_ID].sort());
        assert.equal((await edgesOf(port, scenario('a'))).length, 1, 'the scenario drop must be undone');
      });
    });

    test('a transaction reads its own uncommitted writes', async () => {
      await withPort(makePort, async (port) => {
        const tx = await port.begin();
        await tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: { status: 'active' } });
        const node = await tx.getNode({ namespace: 'curated', id: RULE_ID });
        assert.equal(node.id, RULE_ID);
        await tx.rollback();
      });
    });

    test('uncommitted writes are invisible to another open transaction', async () => {
      await withPort(makePort, async (port) => {
        const writer = await port.begin();
        await writer.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: { status: 'active' } });

        const reader = await port.begin();
        assert.equal(await reader.getNode({ namespace: 'curated', id: RULE_ID }), null);
        await reader.rollback();

        await writer.commit();
      });
    });

    test('a settled transaction rejects every further call with TRANSACTION_CLOSED', async () => {
      await withPort(makePort, async (port) => {
        const committed = await port.begin();
        await committed.commit();
        await rejectsWithCode(committed.commit(), PORT_ERROR_CODES.TRANSACTION_CLOSED, 'commit after commit');
        await rejectsWithCode(committed.rollback(), PORT_ERROR_CODES.TRANSACTION_CLOSED, 'rollback after commit');
        await rejectsWithCode(
          committed.getNode({ namespace: 'curated', id: RULE_ID }),
          PORT_ERROR_CODES.TRANSACTION_CLOSED,
          'read after commit',
        );

        const rolledBack = await port.begin();
        await rolledBack.rollback();
        await rejectsWithCode(rolledBack.rollback(), PORT_ERROR_CODES.TRANSACTION_CLOSED, 'rollback after rollback');
        await rejectsWithCode(
          rolledBack.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: {} }),
          PORT_ERROR_CODES.TRANSACTION_CLOSED,
          'write after rollback',
        );
      });
    });

    test('withTransaction commits on success and returns the callback result', async () => {
      await withPort(makePort, async (port) => {
        const created = await withTransaction(port, async (tx) => {
          await tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: { status: 'active' } });
          return 'done';
        });
        assert.equal(created, 'done');

        const node = await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: RULE_ID }));
        assert.equal(node.id, RULE_ID);
      });
    });

    test('withTransaction rolls back and rethrows when the callback throws', async () => {
      await withPort(makePort, async (port) => {
        const boom = new Error('boom');
        await assert.rejects(
          withTransaction(port, async (tx) => {
            await tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: { status: 'active' } });
            throw boom;
          }),
          (error) => error === boom,
        );

        const node = await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: RULE_ID }));
        assert.equal(node, null);
      });
    });

    test('withTransaction owns the transaction lifecycle: a callback that settles it is an error', async () => {
      await withPort(makePort, async (port) => {
        // Committing inside the callback: the write is durable (withTransaction must not attempt a
        // second commit and must not report a misleading TRANSACTION_CLOSED), but the contract
        // breach is reported so it cannot hide in code B5/D5 build atomicity on.
        const committed = await rejectsWithCode(
          withTransaction(port, async (tx) => {
            await tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: { status: 'active' } });
            await tx.commit();
          }),
          PORT_ERROR_CODES.TRANSACTION_ALREADY_SETTLED,
          'callback committed',
        );
        assert.deepEqual(committed.identity, { settledBy: 'commit' });
        assert.equal((await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: RULE_ID }))).id, RULE_ID);

        // Rolling back inside the callback: same report, and the discarded write stays discarded.
        const rolledBack = await rejectsWithCode(
          withTransaction(port, async (tx) => {
            await tx.createNode({ namespace: 'curated', type: 'Surface', id: SURFACE_ID, properties: {} });
            await tx.rollback();
          }),
          PORT_ERROR_CODES.TRANSACTION_ALREADY_SETTLED,
          'callback rolled back',
        );
        assert.deepEqual(rolledBack.identity, { settledBy: 'rollback' });
        assert.equal(await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: SURFACE_ID })), null);
      });
    });

    test('withTransaction propagates the original failure even when rollback also fails', async () => {
      await withPort(makePort, async (port) => {
        const boom = new Error('boom');
        await assert.rejects(
          withTransaction(port, async (tx) => {
            await tx.rollback(); // the callback settles the transaction itself
            throw boom;
          }),
          (error) => error === boom,
        );
      });
    });

    // --- typed node CRUD (criterion 10: stable IDs and plain objects, never vendor records) ----

    test('createNode returns exactly the contract node record, and getNode returns an equal one', async () => {
      await withPort(makePort, async (port) => {
        const properties = { status: 'active', strength: 'must', tags: ['a', 'b'], nested: { file: 'x.mjs', line: 3 } };
        const created = await inTx(port, (tx) =>
          tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties }),
        );
        assert.deepEqual(Object.keys(created).sort(), ['id', 'namespace', 'properties', 'scenarioId', 'type']);
        assert.deepEqual(created, {
          namespace: 'curated',
          scenarioId: null,
          type: 'Rule',
          id: RULE_ID,
          properties,
        });
        const read = await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: RULE_ID }));
        assert.deepEqual(read, created);
      });
    });

    test('getNode returns null for an id that was never created', async () => {
      await withPort(makePort, async (port) => {
        assert.equal(await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: RULE_ID })), null);
      });
    });

    test('creating the same id twice in one namespace rejects with NODE_EXISTS', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, (tx) => tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: {} }));
        const error = await rejectsWithCode(
          inTx(port, (tx) => tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: {} })),
          PORT_ERROR_CODES.NODE_EXISTS,
        );
        assert.deepEqual(error.identity, { namespace: 'curated', scenarioId: null, id: RULE_ID });
      });
    });

    test('updateNode replaces the property bag and leaves type and id untouched', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, (tx) =>
          tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: { status: 'active', body: 'old' } }),
        );
        const updated = await inTx(port, (tx) =>
          tx.updateNode({ namespace: 'curated', id: RULE_ID, properties: { status: 'deprecated' } }),
        );
        assert.deepEqual(updated, {
          namespace: 'curated',
          scenarioId: null,
          type: 'Rule',
          id: RULE_ID,
          properties: { status: 'deprecated' },
        });
        assert.deepEqual(await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: RULE_ID })), updated);
      });
    });

    test('updateNode and deleteNode reject with NODE_NOT_FOUND for an absent id', async () => {
      await withPort(makePort, async (port) => {
        const onUpdate = await rejectsWithCode(
          inTx(port, (tx) => tx.updateNode({ namespace: 'curated', id: RULE_ID, properties: {} })),
          PORT_ERROR_CODES.NODE_NOT_FOUND,
        );
        assert.deepEqual(onUpdate.identity, { namespace: 'curated', scenarioId: null, id: RULE_ID });
        await rejectsWithCode(
          inTx(port, (tx) => tx.deleteNode({ namespace: 'curated', id: RULE_ID })),
          PORT_ERROR_CODES.NODE_NOT_FOUND,
        );
      });
    });

    test('deleteNode removes the node', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, (tx) => tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: {} }));
        await inTx(port, (tx) => tx.deleteNode({ namespace: 'curated', id: RULE_ID }));
        assert.equal(await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: RULE_ID })), null);
        assert.deepEqual(await inTx(port, (tx) => tx.listNodes({ namespace: 'curated' })), []);
      });
    });

    test('listNodes is namespace-scoped and filters by type (order is not part of the contract)', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: {} });
          await tx.createNode({ namespace: 'curated', type: 'Surface', id: SURFACE_ID, properties: {} });
          await tx.createNode({ namespace: 'topology', type: 'Package', id: PACKAGE_ID, properties: {} });
        });

        assert.deepEqual(await idsOf(port, { namespace: 'curated' }), [RULE_ID, SURFACE_ID].sort());
        assert.deepEqual(await idsOf(port, { namespace: 'curated', type: 'Rule' }), [RULE_ID]);
        assert.deepEqual(await idsOf(port, { namespace: 'topology' }), [PACKAGE_ID]);
        assert.deepEqual(await idsOf(port, { namespace: 'system' }), []);
        assert.deepEqual(await idsOf(port, { namespace: 'curated', type: 'Decision' }), []);
      });
    });

    test('the same id in two namespaces addresses two independent nodes', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: { origin: 'curated' } });
          await tx.createNode({ namespace: 'system', type: 'Rule', id: RULE_ID, properties: { origin: 'system' } });
        });
        const curated = await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: RULE_ID }));
        const system = await inTx(port, (tx) => tx.getNode({ namespace: 'system', id: RULE_ID }));
        assert.deepEqual(curated.properties, { origin: 'curated' });
        assert.deepEqual(system.properties, { origin: 'system' });

        await inTx(port, (tx) => tx.deleteNode({ namespace: 'curated', id: RULE_ID }));
        assert.equal(await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: RULE_ID })), null);
        assert.notEqual(await inTx(port, (tx) => tx.getNode({ namespace: 'system', id: RULE_ID })), null);
      });
    });

    test('records are copies: mutating an argument or a returned record cannot reach stored state', async () => {
      await withPort(makePort, async (port) => {
        const properties = { status: 'active', tags: ['a'] };
        const created = await inTx(port, (tx) =>
          tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties }),
        );
        properties.status = 'mutated-after-create';
        properties.tags.push('b');
        try {
          created.properties.status = 'mutated-returned-record';
          created.id = 'apex:proj:rule:other';
        } catch {
          // A frozen returned record satisfies this contract too.
        }

        const read = await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: RULE_ID }));
        assert.deepEqual(read.properties, { status: 'active', tags: ['a'] });
        assert.equal(read.id, RULE_ID);
      });
    });

    // --- scope + argument validation (identical codes on every adapter) ------------------------

    test('every namespaced operation rejects an unknown namespace with UNKNOWN_NAMESPACE', async () => {
      await withPort(makePort, async (port) => {
        for (const call of namespacedCalls('work')) {
          const error = await rejectsWithCode(inTx(port, call.run), PORT_ERROR_CODES.UNKNOWN_NAMESPACE, call.name);
          assert.deepEqual(error.identity, { namespace: 'work' }, call.name);
        }
      });
    });

    test('every namespaced operation rejects a missing namespace argument with UNKNOWN_NAMESPACE', async () => {
      await withPort(makePort, async (port) => {
        for (const call of namespacedCalls(undefined)) {
          await rejectsWithCode(inTx(port, call.run), PORT_ERROR_CODES.UNKNOWN_NAMESPACE, call.name);
        }
      });
    });

    test('a malformed node id rejects with INVALID_NODE_ID', async () => {
      await withPort(makePort, async (port) => {
        for (const bad of ['', 42, null, undefined, {}]) {
          const error = await rejectsWithCode(
            inTx(port, (tx) => tx.createNode({ namespace: 'curated', type: 'Rule', id: bad, properties: {} })),
            PORT_ERROR_CODES.INVALID_NODE_ID,
            `id ${String(bad)}`,
          );
          assert.deepEqual(error.identity, { argument: 'id', value: bad });
          await rejectsWithCode(
            inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: bad })),
            PORT_ERROR_CODES.INVALID_NODE_ID,
            `getNode id ${String(bad)}`,
          );
        }
      });
    });

    test('a malformed type rejects with INVALID_TYPE', async () => {
      await withPort(makePort, async (port) => {
        for (const bad of ['', 42, null, undefined]) {
          const error = await rejectsWithCode(
            inTx(port, (tx) => tx.createNode({ namespace: 'curated', type: bad, id: RULE_ID, properties: {} })),
            PORT_ERROR_CODES.INVALID_TYPE,
            `type ${String(bad)}`,
          );
          assert.deepEqual(error.identity, { value: bad });
        }
        await rejectsWithCode(
          inTx(port, (tx) => tx.listNodes({ namespace: 'curated', type: 42 })),
          PORT_ERROR_CODES.INVALID_TYPE,
          'listNodes type filter',
        );
      });
    });

    test('a non-object property bag rejects with INVALID_PROPERTIES_VALUE, an omitted one defaults to empty', async () => {
      await withPort(makePort, async (port) => {
        const badBags = [
          ['null', null],
          ['a string', 'status=active'],
          ['a number', 42],
          ['an array', ['status']],
          ['a Date', new Date(0)],
          ['a Map', new Map()],
          ['a null-prototype object', Object.create(null)],
        ];
        for (const [label, bad] of badBags) {
          const error = await rejectsWithCode(
            inTx(port, (tx) => tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: bad })),
            PORT_ERROR_CODES.INVALID_PROPERTIES_VALUE,
            `properties: ${label}`,
          );
          assert.deepEqual(error.identity, { value: bad }, label);
        }
        const created = await inTx(port, (tx) => tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID }));
        assert.deepEqual(created.properties, {});
      });
    });

    // --- no silent drops: an argument the port cannot honour is an error, never ignored ---------

    test('every operation rejects an unknown argument with UNKNOWN_ARGUMENT', async () => {
      await withPort(makePort, async (port) => {
        for (const { name, input, run } of operations('curated')) {
          const error = await rejectsWithCode(
            inTx(port, (tx) => run(tx, { ...input, tpye: 'Rule' })),
            PORT_ERROR_CODES.UNKNOWN_ARGUMENT,
            name,
          );
          assert.deepEqual(error.identity, { argument: 'tpye' }, name);
        }

        const onDrop = await rejectsWithCode(
          inTx(port, (tx) => tx.dropScenario({ scenarioId: 'scenario-a', namespace: SCENARIO_NAMESPACE })),
          PORT_ERROR_CODES.UNKNOWN_ARGUMENT,
          'dropScenario',
        );
        assert.deepEqual(onDrop.identity, { argument: 'namespace' });
      });
    });

    test('createEdge rejects properties rather than dropping them (edges carry none in schema v1)', async () => {
      await withPort(makePort, async (port) => {
        await seedCurated(port);
        const error = await rejectsWithCode(
          inTx(port, (tx) =>
            tx.createEdge({
              namespace: 'curated',
              type: 'APPLIES_TO',
              fromId: RULE_ID,
              toId: SURFACE_ID,
              properties: { weight: 1 },
            }),
          ),
          PORT_ERROR_CODES.UNKNOWN_ARGUMENT,
        );
        assert.deepEqual(error.identity, { argument: 'properties' });
        assert.deepEqual(await edgesOf(port, { namespace: 'curated' }), []);
      });
    });

    test('updateNode requires an explicit property bag — an omitted one never silently wipes it', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, (tx) =>
          tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: { status: 'active' } }),
        );

        const error = await rejectsWithCode(
          inTx(port, (tx) => tx.updateNode({ namespace: 'curated', id: RULE_ID })),
          PORT_ERROR_CODES.MISSING_ARGUMENT,
        );
        assert.deepEqual(error.identity, { argument: 'properties' });

        const node = await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: RULE_ID }));
        assert.deepEqual(node.properties, { status: 'active' }, 'the stored bag must be untouched');

        const cleared = await inTx(port, (tx) =>
          tx.updateNode({ namespace: 'curated', id: RULE_ID, properties: {} }),
        );
        assert.deepEqual(cleared.properties, {}, 'clearing the bag stays possible — explicitly');
      });
    });

    // --- typed edge CRUD (spec §5: an edge is identified by type + canonical direction) --------

    test('createEdge returns exactly the contract edge record, and getEdge returns an equal one', async () => {
      await withPort(makePort, async (port) => {
        const created = await inTx(port, async (tx) => {
          await seedEndpoints(tx, 'curated');
          return tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID });
        });
        assert.deepEqual(Object.keys(created).sort(), ['fromId', 'namespace', 'scenarioId', 'toId', 'type']);
        assert.deepEqual(created, {
          namespace: 'curated',
          scenarioId: null,
          type: 'APPLIES_TO',
          fromId: RULE_ID,
          toId: SURFACE_ID,
        });
        const read = await inTx(port, (tx) =>
          tx.getEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID }),
        );
        assert.deepEqual(read, created);
      });
    });

    test('getEdge returns null for an edge that was never created', async () => {
      await withPort(makePort, async (port) => {
        const read = await inTx(port, async (tx) => {
          await seedEndpoints(tx, 'curated');
          return tx.getEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID });
        });
        assert.equal(read, null);
      });
    });

    test('an edge is keyed by (type, fromId, toId): re-creating it rejects, another type does not', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await seedEndpoints(tx, 'curated');
          await tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID });
        });

        const error = await rejectsWithCode(
          inTx(port, (tx) =>
            tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID }),
          ),
          PORT_ERROR_CODES.EDGE_EXISTS,
        );
        assert.deepEqual(error.identity, {
          namespace: 'curated',
          scenarioId: null,
          type: 'APPLIES_TO',
          fromId: RULE_ID,
          toId: SURFACE_ID,
        });

        await inTx(port, (tx) =>
          tx.createEdge({ namespace: 'curated', type: 'OWNED_BY', fromId: RULE_ID, toId: SURFACE_ID }),
        );
        assert.equal((await edgesOf(port, { namespace: 'curated' })).length, 2);
      });
    });

    test('createEdge rejects a missing endpoint with EDGE_ENDPOINT_MISSING — no dangling edges', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, (tx) => tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID }));

        const missingTo = await rejectsWithCode(
          inTx(port, (tx) =>
            tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID }),
          ),
          PORT_ERROR_CODES.EDGE_ENDPOINT_MISSING,
        );
        assert.deepEqual(missingTo.identity, {
          namespace: 'curated',
          scenarioId: null,
          endpoint: 'toId',
          id: SURFACE_ID,
        });

        const missingFrom = await rejectsWithCode(
          inTx(port, (tx) =>
            tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: PACKAGE_ID, toId: RULE_ID }),
          ),
          PORT_ERROR_CODES.EDGE_ENDPOINT_MISSING,
        );
        assert.equal(missingFrom.identity.endpoint, 'fromId');
      });
    });

    test('an endpoint living in another namespace does not satisfy EDGE_ENDPOINT_MISSING', async () => {
      // A relationship OUTSIDE the closed bridge table (below) may never span namespaces, whatever
      // its scope: `PART_OF` from a curated node to a topology one is a missing endpoint, not a
      // cross-namespace edge.
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID });
          await tx.createNode({ namespace: 'topology', type: 'Package', id: PACKAGE_ID });
        });
        await rejectsWithCode(
          inTx(port, (tx) =>
            tx.createEdge({ namespace: 'curated', type: 'PART_OF', fromId: RULE_ID, toId: PACKAGE_ID }),
          ),
          PORT_ERROR_CODES.EDGE_ENDPOINT_MISSING,
        );
      });
    });

    // --- bridge relationships (controller decision 2026-08-12: the closed cross-namespace table) -
    //
    // Exactly two relationship types may span two namespaces, each with its declared
    // (fromNamespace -> toNamespace) pair and its HOME namespace — the scope the edge is created
    // in, stored in, and listed from. Everything else keeps strict same-namespace enforcement
    // (the test above). The record shape does not change: a bridge edge is an ordinary edge
    // record whose endpoints happen to resolve in two namespaces, and the pair is derivable from
    // (home namespace, type) through `BRIDGE_RELATIONSHIPS`.

    test('a bridge relationship spans its declared pair and lives in its home namespace', async () => {
      await withPort(makePort, async (port) => {
        const created = await inTx(port, async (tx) => {
          await seedBridgeEndpoints(tx);
          return tx.createEdge({ namespace: 'topology', type: 'IMPLEMENTS', fromId: PACKAGE_ID, toId: COMPONENT_ID });
        });
        assert.deepEqual(Object.keys(created).sort(), ['fromId', 'namespace', 'scenarioId', 'toId', 'type']);
        assert.deepEqual(created, {
          namespace: 'topology',
          scenarioId: null,
          type: 'IMPLEMENTS',
          fromId: PACKAGE_ID,
          toId: COMPONENT_ID,
        });

        const read = await inTx(port, (tx) =>
          tx.getEdge({ namespace: 'topology', type: 'IMPLEMENTS', fromId: PACKAGE_ID, toId: COMPONENT_ID }),
        );
        assert.deepEqual(read, created);

        // Listed in its home namespace, and only there.
        assert.deepEqual(await edgesOf(port, { namespace: 'topology' }), [created]);
        assert.deepEqual(await edgesOf(port, { namespace: 'topology', type: 'IMPLEMENTS' }), [created]);
        assert.deepEqual(await edgesOf(port, { namespace: 'topology', fromId: PACKAGE_ID }), [created]);
        assert.deepEqual(await edgesOf(port, { namespace: 'topology', toId: COMPONENT_ID }), [created]);
        assert.deepEqual(await edgesOf(port, { namespace: 'curated' }), []);
      });
    });

    test('the other bridge relationship runs the other way, from its own home namespace', async () => {
      await withPort(makePort, async (port) => {
        const created = await inTx(port, async (tx) => {
          await seedBridgeEndpoints(tx);
          return tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: PACKAGE_ID });
        });
        assert.deepEqual(created, {
          namespace: 'curated',
          scenarioId: null,
          type: 'APPLIES_TO',
          fromId: RULE_ID,
          toId: PACKAGE_ID,
        });
        assert.deepEqual(await edgesOf(port, { namespace: 'curated' }), [created]);
        assert.deepEqual(await edgesOf(port, { namespace: 'topology' }), []);

        await inTx(port, (tx) =>
          tx.deleteEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: PACKAGE_ID }),
        );
        assert.deepEqual(await edgesOf(port, { namespace: 'curated' }), []);
        await rejectsWithCode(
          inTx(port, (tx) =>
            tx.deleteEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: PACKAGE_ID }),
          ),
          PORT_ERROR_CODES.EDGE_NOT_FOUND,
        );
      });
    });

    test('a bridge type still forms ordinary same-namespace edges, in its home namespace and elsewhere', async () => {
      // `APPLIES_TO` is Rule -> Surface (curated) as often as Rule -> Package (bridge), and a
      // promotion scenario holds its own copy of the curated delta: the bridge pair EXTENDS where
      // an endpoint may be found, it never replaces the same-namespace form.
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await seedEndpoints(tx, 'curated');
          await tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID });
          await seedEndpoints(tx, SCENARIO_NAMESPACE, 'scenario-a');
          await tx.createEdge({ ...scenario('a'), type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID });
        });
        assert.equal((await edgesOf(port, { namespace: 'curated' })).length, 1);
        assert.equal((await edgesOf(port, scenario('a'))).length, 1);
      });
    });

    test('a bridge edge makes both of its endpoints undeletable — dangling is impossible across namespaces', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await seedBridgeEndpoints(tx);
          await tx.createEdge({ namespace: 'topology', type: 'IMPLEMENTS', fromId: PACKAGE_ID, toId: COMPONENT_ID });
          await tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: PACKAGE_ID });
        });

        // The curated endpoint of an edge whose record lives in `topology` …
        const onTarget = await rejectsWithCode(
          inTx(port, (tx) => tx.deleteNode({ namespace: 'curated', id: COMPONENT_ID })),
          PORT_ERROR_CODES.NODE_HAS_EDGES,
        );
        assert.deepEqual(onTarget.identity, { namespace: 'curated', scenarioId: null, id: COMPONENT_ID });
        // … the topology endpoint of an edge whose record lives in `curated` …
        await rejectsWithCode(
          inTx(port, (tx) => tx.deleteNode({ namespace: 'topology', id: PACKAGE_ID })),
          PORT_ERROR_CODES.NODE_HAS_EDGES,
        );
        // … and the curated source of that same edge.
        await rejectsWithCode(
          inTx(port, (tx) => tx.deleteNode({ namespace: 'curated', id: RULE_ID })),
          PORT_ERROR_CODES.NODE_HAS_EDGES,
        );

        await inTx(port, async (tx) => {
          await tx.deleteEdge({ namespace: 'topology', type: 'IMPLEMENTS', fromId: PACKAGE_ID, toId: COMPONENT_ID });
          await tx.deleteEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: PACKAGE_ID });
          await tx.deleteNode({ namespace: 'curated', id: COMPONENT_ID });
          await tx.deleteNode({ namespace: 'topology', id: PACKAGE_ID });
        });
        assert.deepEqual(await idsOf(port, { namespace: 'topology' }), []);
        assert.deepEqual(await idsOf(port, { namespace: 'curated' }), [RULE_ID, SURFACE_ID].sort());
      });
    });

    test('an illegal namespace span is refused: wrong type, wrong direction, wrong home, scenario or system', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await seedBridgeEndpoints(tx);
          await tx.createNode({ namespace: 'system', type: 'GraphMetadata', id: SYSTEM_ID });
          await tx.createNode({ ...scenario('a'), type: 'Rule', id: RULE_ID });
        });

        const illegal = [
          // A relationship outside the bridge table, in a bridge namespace pair.
          ['wrong type', { namespace: 'topology', type: 'PART_OF', fromId: PACKAGE_ID, toId: COMPONENT_ID }],
          // IMPLEMENTS runs topology -> curated, never the other way.
          ['wrong direction', { namespace: 'topology', type: 'IMPLEMENTS', fromId: COMPONENT_ID, toId: PACKAGE_ID }],
          // … and only from its home namespace: `curated` is APPLIES_TO's home, not IMPLEMENTS's.
          ['wrong home', { namespace: 'curated', type: 'IMPLEMENTS', fromId: PACKAGE_ID, toId: COMPONENT_ID }],
          // The bridge pair is (curated, topology) — a Surface is not the far end of APPLIES_TO here.
          ['wrong pair', { namespace: 'topology', type: 'APPLIES_TO', fromId: PACKAGE_ID, toId: SURFACE_ID }],
          // No bridge ever involves a scenario …
          ['scenario source', { ...scenario('a'), type: 'APPLIES_TO', fromId: RULE_ID, toId: PACKAGE_ID }],
          ['scenario target', { namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SYSTEM_ID }],
          // … or the system namespace.
          ['system source', { namespace: 'topology', type: 'IMPLEMENTS', fromId: SYSTEM_ID, toId: COMPONENT_ID }],
        ];
        for (const [label, input] of illegal) {
          await rejectsWithCode(
            inTx(port, (tx) => tx.createEdge(input)),
            PORT_ERROR_CODES.EDGE_ENDPOINT_MISSING,
            label,
          );
        }

        for (const namespace of ['curated', 'topology', 'system']) {
          assert.deepEqual(await edgesOf(port, { namespace }), [], `${namespace}: no half-created edge`);
        }
        assert.deepEqual(await edgesOf(port, scenario('a')), []);
      });
    });

    test('a rolled-back bridge edge leaves no trace in either namespace', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, (tx) => seedBridgeEndpoints(tx));
        const tx = await port.begin();
        await tx.createEdge({ namespace: 'topology', type: 'IMPLEMENTS', fromId: PACKAGE_ID, toId: COMPONENT_ID });
        await tx.rollback();

        assert.deepEqual(await edgesOf(port, { namespace: 'topology' }), []);
        assert.equal(
          await inTx(port, (tx2) =>
            tx2.getEdge({ namespace: 'topology', type: 'IMPLEMENTS', fromId: PACKAGE_ID, toId: COMPONENT_ID }),
          ),
          null,
        );
        // The endpoints are free again: the rolled-back edge does not hold them hostage.
        await inTx(port, async (tx2) => {
          await tx2.deleteNode({ namespace: 'curated', id: COMPONENT_ID });
          await tx2.deleteNode({ namespace: 'topology', id: PACKAGE_ID });
        });
      });
    });

    test('deleteEdge removes the edge and rejects an absent one with EDGE_NOT_FOUND', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await seedEndpoints(tx, 'curated');
          await tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID });
        });
        await inTx(port, (tx) =>
          tx.deleteEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID }),
        );
        assert.deepEqual(await edgesOf(port, { namespace: 'curated' }), []);

        const error = await rejectsWithCode(
          inTx(port, (tx) =>
            tx.deleteEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID }),
          ),
          PORT_ERROR_CODES.EDGE_NOT_FOUND,
        );
        assert.deepEqual(error.identity, {
          namespace: 'curated',
          scenarioId: null,
          type: 'APPLIES_TO',
          fromId: RULE_ID,
          toId: SURFACE_ID,
        });
      });
    });

    test('listEdges is namespace-scoped and filters by type, fromId and toId', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await seedEndpoints(tx, 'curated');
          await tx.createNode({ namespace: 'curated', type: 'Agent', id: AGENT_ID });
          await tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID });
          await tx.createEdge({ namespace: 'curated', type: 'OWNED_BY', fromId: SURFACE_ID, toId: AGENT_ID });
          await tx.createNode({ namespace: 'topology', type: 'Package', id: PACKAGE_ID });
          await tx.createNode({ namespace: 'topology', type: 'Workspace', id: WORKSPACE_ID });
          await tx.createEdge({ namespace: 'topology', type: 'PART_OF', fromId: PACKAGE_ID, toId: WORKSPACE_ID });
        });

        assert.equal((await edgesOf(port, { namespace: 'curated' })).length, 2);
        assert.deepEqual(await edgesOf(port, { namespace: 'curated', type: 'OWNED_BY' }), [
          { namespace: 'curated', scenarioId: null, type: 'OWNED_BY', fromId: SURFACE_ID, toId: AGENT_ID },
        ]);
        assert.equal((await edgesOf(port, { namespace: 'curated', fromId: RULE_ID })).length, 1);
        assert.equal((await edgesOf(port, { namespace: 'curated', toId: AGENT_ID })).length, 1);
        assert.equal((await edgesOf(port, { namespace: 'curated', fromId: PACKAGE_ID })).length, 0);
        assert.equal((await edgesOf(port, { namespace: 'topology' })).length, 1);
        assert.deepEqual(await edgesOf(port, { namespace: 'system' }), []);
      });
    });

    test('deleting a node that still has edges rejects with NODE_HAS_EDGES, in either direction', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await seedEndpoints(tx, 'curated');
          await tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID });
        });

        const onSource = await rejectsWithCode(
          inTx(port, (tx) => tx.deleteNode({ namespace: 'curated', id: RULE_ID })),
          PORT_ERROR_CODES.NODE_HAS_EDGES,
        );
        assert.deepEqual(onSource.identity, { namespace: 'curated', scenarioId: null, id: RULE_ID });
        await rejectsWithCode(
          inTx(port, (tx) => tx.deleteNode({ namespace: 'curated', id: SURFACE_ID })),
          PORT_ERROR_CODES.NODE_HAS_EDGES,
        );

        await inTx(port, async (tx) => {
          await tx.deleteEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID });
          await tx.deleteNode({ namespace: 'curated', id: RULE_ID });
        });
        assert.equal(await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: RULE_ID })), null);
      });
    });

    test('a malformed edge endpoint id rejects with INVALID_NODE_ID naming the argument', async () => {
      await withPort(makePort, async (port) => {
        await seedCurated(port);
        const badFrom = await rejectsWithCode(
          inTx(port, (tx) => tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: '', toId: SURFACE_ID })),
          PORT_ERROR_CODES.INVALID_NODE_ID,
        );
        assert.deepEqual(badFrom.identity, { argument: 'fromId', value: '' });

        const badTo = await rejectsWithCode(
          inTx(port, (tx) => tx.getEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: 42 })),
          PORT_ERROR_CODES.INVALID_NODE_ID,
        );
        assert.deepEqual(badTo.identity, { argument: 'toId', value: 42 });

        await rejectsWithCode(
          inTx(port, (tx) => tx.createEdge({ namespace: 'curated', type: '', fromId: RULE_ID, toId: SURFACE_ID })),
          PORT_ERROR_CODES.INVALID_TYPE,
        );
      });
    });

    // --- scenario isolation (spec §11: a Promotion Scenario never contaminates current context) -

    test('the scenario namespace requires a scenarioId on every operation', async () => {
      await withPort(makePort, async (port) => {
        for (const call of namespacedCalls(SCENARIO_NAMESPACE)) {
          const error = await rejectsWithCode(inTx(port, call.run), PORT_ERROR_CODES.MISSING_SCENARIO_ID, call.name);
          assert.deepEqual(error.identity, { namespace: SCENARIO_NAMESPACE }, call.name);
        }
      });
    });

    test('every other namespace refuses a scenarioId with UNEXPECTED_SCENARIO_ID', async () => {
      await withPort(makePort, async (port) => {
        for (const namespace of ['curated', 'topology', 'system']) {
          const error = await rejectsWithCode(
            inTx(port, (tx) => tx.listNodes({ namespace, scenarioId: 'scenario-a' })),
            PORT_ERROR_CODES.UNEXPECTED_SCENARIO_ID,
            namespace,
          );
          assert.deepEqual(error.identity, { namespace, scenarioId: 'scenario-a' }, namespace);
        }
      });
    });

    test('a malformed scenarioId rejects with INVALID_SCENARIO_ID', async () => {
      await withPort(makePort, async (port) => {
        for (const bad of ['', 42, {}]) {
          const error = await rejectsWithCode(
            inTx(port, (tx) => tx.listNodes({ namespace: SCENARIO_NAMESPACE, scenarioId: bad })),
            PORT_ERROR_CODES.INVALID_SCENARIO_ID,
            String(bad),
          );
          assert.deepEqual(error.identity, { value: bad });
        }
      });
    });

    test('the same id in two scenarios addresses two independent nodes', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await tx.createNode({ ...scenario('a'), type: 'Rule', id: RULE_ID, properties: { origin: 'a' } });
          await tx.createNode({ ...scenario('b'), type: 'Rule', id: RULE_ID, properties: { origin: 'b' } });
        });

        const inA = await inTx(port, (tx) => tx.getNode({ ...scenario('a'), id: RULE_ID }));
        const inB = await inTx(port, (tx) => tx.getNode({ ...scenario('b'), id: RULE_ID }));
        assert.deepEqual(inA.properties, { origin: 'a' });
        assert.deepEqual(inA.scenarioId, 'scenario-a');
        assert.deepEqual(inB.properties, { origin: 'b' });

        assert.deepEqual(await idsOf(port, scenario('a')), [RULE_ID]);
        assert.deepEqual(await idsOf(port, scenario('c')), []);
      });
    });

    test('scenario records never leak into another namespace and vice versa', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: { origin: 'curated' } });
          await tx.createNode({ ...scenario('a'), type: 'Rule', id: RULE_ID, properties: { origin: 'a' } });
        });

        const curated = await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: RULE_ID }));
        assert.deepEqual(curated.properties, { origin: 'curated' });
        assert.equal(curated.scenarioId, null);
        assert.deepEqual(await idsOf(port, { namespace: 'curated' }), [RULE_ID]);
        assert.deepEqual(await idsOf(port, scenario('a')), [RULE_ID]);
      });
    });

    test('an edge cannot span two scenarios: its endpoints must live in the same scope', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await seedEndpoints(tx, SCENARIO_NAMESPACE, 'scenario-a');
          await tx.createNode({ ...scenario('b'), type: 'Surface', id: SURFACE_ID });
        });

        await rejectsWithCode(
          inTx(port, (tx) => tx.createEdge({ ...scenario('b'), type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID })),
          PORT_ERROR_CODES.EDGE_ENDPOINT_MISSING,
        );

        await inTx(port, (tx) =>
          tx.createEdge({ ...scenario('a'), type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID }),
        );
        assert.equal((await edgesOf(port, scenario('a'))).length, 1);
        assert.deepEqual(await edgesOf(port, scenario('b')), []);
        assert.deepEqual(await edgesOf(port, { namespace: 'curated' }), []);
      });
    });

    test('dropScenario removes all and only that scenario, leaving every other scope intact', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          await seedEndpoints(tx, 'curated');
          await tx.createEdge({ namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID });
          for (const suffix of ['a', 'b']) {
            await seedEndpoints(tx, SCENARIO_NAMESPACE, `scenario-${suffix}`);
            await tx.createEdge({ ...scenario(suffix), type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID });
          }
        });

        await inTx(port, (tx) => tx.dropScenario({ scenarioId: 'scenario-a' }));

        assert.deepEqual(await idsOf(port, scenario('a')), []);
        assert.deepEqual(await edgesOf(port, scenario('a')), []);
        assert.deepEqual(await idsOf(port, scenario('b')), [RULE_ID, SURFACE_ID].sort());
        assert.equal((await edgesOf(port, scenario('b'))).length, 1);
        assert.deepEqual(await idsOf(port, { namespace: 'curated' }), [RULE_ID, SURFACE_ID].sort());
        assert.equal((await edgesOf(port, { namespace: 'curated' })).length, 1);
      });
    });

    test('dropScenario on an unknown scenario is a no-op, and validates its scenarioId', async () => {
      await withPort(makePort, async (port) => {
        await seedCurated(port);
        await inTx(port, (tx) => tx.dropScenario({ scenarioId: 'never-created' }));
        assert.deepEqual(await idsOf(port, { namespace: 'curated' }), [RULE_ID, SURFACE_ID].sort());

        await rejectsWithCode(
          inTx(port, (tx) => tx.dropScenario({})),
          PORT_ERROR_CODES.MISSING_SCENARIO_ID,
        );
        await rejectsWithCode(
          inTx(port, (tx) => tx.dropScenario({ scenarioId: '' })),
          PORT_ERROR_CODES.INVALID_SCENARIO_ID,
        );
      });
    });

    // --- parameterized inputs (spec §17: query inputs are parameterized, never assembled) -------
    //
    // Ids and property VALUES are data and must survive byte-exact. Node/edge TYPES and property
    // NAMES are not: they come from the closed ontology (`core/ontology.mjs`), so an adapter may
    // map them onto engine schema identifiers and the suite never feeds hostile ones.

    test('hostile ids round-trip byte-exact through node and edge operations', async () => {
      await withPort(makePort, async (port) => {
        await inTx(port, async (tx) => {
          for (const hostile of HOSTILE_STRINGS) {
            await tx.createNode({ namespace: 'curated', type: 'Rule', id: hostile, properties: { statement: hostile } });
          }
          for (let index = 1; index < HOSTILE_STRINGS.length; index += 1) {
            await tx.createEdge({
              namespace: 'curated',
              type: 'OVERRIDES',
              fromId: HOSTILE_STRINGS[0],
              toId: HOSTILE_STRINGS[index],
            });
          }
        });

        for (const hostile of HOSTILE_STRINGS) {
          const node = await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: hostile }));
          assert.equal(node.id, hostile);
          assert.equal(node.properties.statement, hostile);
        }
        assert.deepEqual(await idsOf(port, { namespace: 'curated' }), [...HOSTILE_STRINGS].sort());

        const edges = await edgesOf(port, { namespace: 'curated', fromId: HOSTILE_STRINGS[0] });
        assert.deepEqual(edges.map((edge) => edge.toId).sort(), HOSTILE_STRINGS.slice(1).sort());

        const last = HOSTILE_STRINGS.at(-1);
        await inTx(port, async (tx) => {
          await tx.deleteEdge({ namespace: 'curated', type: 'OVERRIDES', fromId: HOSTILE_STRINGS[0], toId: last });
          await tx.deleteNode({ namespace: 'curated', id: last });
        });
        assert.equal(await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: last })), null);
      });
    });

    test('every portable property value round-trips deep-equal', async () => {
      await withPort(makePort, async (port) => {
        const properties = {
          statement: HOSTILE_STRINGS[0],
          empty: '',
          strength: 'must',
          enabled: false,
          weight: -1.5,
          count: Number.MAX_SAFE_INTEGER,
          zero: 0,
          missing: null,
          tags: ['a', 1, true, null, ['nested', { deep: 'value' }]],
          emptyList: [],
          emptyBag: {},
          provenance: { file: 'scripts/formula/engine/port.mjs', line: 42, quote: "he said 'hi'" },
          ext_v1_embedding: [0.1, 0.2],
        };
        const created = await inTx(port, (tx) =>
          tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties }),
        );
        assert.deepEqual(created.properties, properties);
        const read = await inTx(port, (tx) => tx.getNode({ namespace: 'curated', id: RULE_ID }));
        assert.deepEqual(read.properties, properties);

        const updated = await inTx(port, (tx) =>
          tx.updateNode({ namespace: 'curated', id: RULE_ID, properties: { ...properties, enabled: true } }),
        );
        assert.equal(updated.properties.enabled, true);
        assert.deepEqual(updated.properties.provenance, properties.provenance);
      });
    });

    test('a value outside the portable JSON domain rejects with UNSUPPORTED_PROPERTY_VALUE', async () => {
      const circular = { self: null };
      circular.self = circular;
      const unsupported = [
        ['undefinedValue', undefined, 'undefined'],
        ['notANumber', Number.NaN, 'number'],
        ['infinite', Number.POSITIVE_INFINITY, 'number'],
        ['fn', () => 'nope', 'function'],
        ['sym', Symbol('nope'), 'symbol'],
        ['big', 10n, 'bigint'],
        ['when', new Date(0), 'object'],
        ['lookup', new Map(), 'object'],
        // A null-prototype object is not what comes back out (engines and structuredClone alike
        // rebuild it with Object.prototype), so it cannot honour the byte-exact round-trip.
        ['bare', Object.create(null), 'object'],
        ['deep.bare', { bare: Object.create(null) }, 'object'],
        // The offending value is the back-reference itself, so the path points at it.
        ['circular.self', circular, 'object'],
      ];

      await withPort(makePort, async (port) => {
        for (const [property, value, valueType] of unsupported) {
          const bag = { [property.split('.')[0]]: value };
          const error = await rejectsWithCode(
            inTx(port, (tx) => tx.createNode({ namespace: 'curated', type: 'Rule', id: RULE_ID, properties: bag })),
            PORT_ERROR_CODES.UNSUPPORTED_PROPERTY_VALUE,
            property,
          );
          assert.deepEqual(error.identity, { property, valueType }, property);
        }

        const nested = await rejectsWithCode(
          inTx(port, (tx) =>
            tx.createNode({
              namespace: 'curated',
              type: 'Rule',
              id: RULE_ID,
              properties: { provenance: { captured: [{ at: new Date(0) }] } },
            }),
          ),
          PORT_ERROR_CODES.UNSUPPORTED_PROPERTY_VALUE,
          'nested',
        );
        assert.deepEqual(nested.identity, { property: 'provenance.captured.0.at', valueType: 'object' });

        await rejectsWithCode(
          inTx(port, (tx) =>
            tx.updateNode({ namespace: 'curated', id: RULE_ID, properties: { when: new Date(0) } }),
          ),
          PORT_ERROR_CODES.UNSUPPORTED_PROPERTY_VALUE,
          'updateNode',
        );

        assert.deepEqual(await idsOf(port, { namespace: 'curated' }), []);
      });
    });
  });
}

// --- namespace + error vocabulary (engine-independent, asserted once) -------------------------

test('NAMESPACES are exactly the four disjoint spec namespaces', () => {
  assert.deepEqual(NAMESPACES, ['curated', 'topology', 'scenario', 'system']);
  assert.equal(SCENARIO_NAMESPACE, 'scenario');
  for (const namespace of NAMESPACES) assert.equal(isNamespace(namespace), true, namespace);
  for (const bad of ['work', 'Curated', '', null, undefined, 42]) assert.equal(isNamespace(bad), false, String(bad));
});

test('BRIDGE_RELATIONSHIPS is the closed, frozen table of cross-namespace relationships', () => {
  assert.ok(Object.isFrozen(BRIDGE_RELATIONSHIPS));
  assert.deepEqual(Object.keys(BRIDGE_RELATIONSHIPS).sort(), ['APPLIES_TO', 'IMPLEMENTS']);
  assert.deepEqual(BRIDGE_RELATIONSHIPS.IMPLEMENTS, {
    fromNamespace: 'topology',
    toNamespace: 'curated',
    homeNamespace: 'topology',
  });
  assert.deepEqual(BRIDGE_RELATIONSHIPS.APPLIES_TO, {
    fromNamespace: 'curated',
    toNamespace: 'topology',
    homeNamespace: 'curated',
  });

  for (const [type, rule] of Object.entries(BRIDGE_RELATIONSHIPS)) {
    assert.ok(Object.isFrozen(rule), type);
    assert.notEqual(rule.fromNamespace, rule.toNamespace, `${type}: a bridge spans two namespaces`);
    assert.ok(
      rule.homeNamespace === rule.fromNamespace || rule.homeNamespace === rule.toNamespace,
      `${type}: the home namespace must be one of the two endpoints' — it is where the record lives`,
    );
    for (const namespace of [rule.fromNamespace, rule.toNamespace]) {
      assert.ok(isNamespace(namespace), `${type}: ${namespace}`);
      assert.ok(
        namespace !== SCENARIO_NAMESPACE && namespace !== 'system',
        `${type}: a scenario or system record is never part of a bridge pair`,
      );
    }
  }
});

test('endpointScopePairs offers the same-namespace pair first, then the declared bridge pair', () => {
  // A bridge pair EXTENDS where an endpoint may be found, in the home namespace only.
  assert.deepEqual(endpointScopePairs('topology', 'IMPLEMENTS'), [
    { fromNamespace: 'topology', toNamespace: 'topology' },
    { fromNamespace: 'topology', toNamespace: 'curated' },
  ]);
  assert.deepEqual(endpointScopePairs('curated', 'APPLIES_TO'), [
    { fromNamespace: 'curated', toNamespace: 'curated' },
    { fromNamespace: 'curated', toNamespace: 'topology' },
  ]);
  // Outside the home namespace, and for every other relationship, one same-namespace pair only.
  for (const [namespace, type] of [
    ['curated', 'IMPLEMENTS'],
    ['topology', 'APPLIES_TO'],
    ['curated', 'PART_OF'],
    ['topology', 'PART_OF'],
    [SCENARIO_NAMESPACE, 'APPLIES_TO'],
    ['system', 'IMPLEMENTS'],
  ]) {
    assert.deepEqual(
      endpointScopePairs(namespace, type),
      [{ fromNamespace: namespace, toNamespace: namespace }],
      `${namespace}/${type}`,
    );
  }
});

test('the shared endpoint-blame helper names the at-fault endpoint, or the span itself', () => {
  // Blame is observable, so it lives in port.mjs and both adapters return exactly this — the same
  // reason `nodeNotFound` and the scope glue do. It RETURNS the rejection; the caller throws.
  const scope = { namespace: 'topology', scenarioId: null };
  const pairs = endpointScopePairs('topology', 'IMPLEMENTS');
  const input = { type: 'IMPLEMENTS', fromId: PACKAGE_ID, toId: COMPONENT_ID };

  const nothingExists = edgeEndpointMissing(scope, input, pairs, () => false);
  assert.equal(isPortError(nothingExists), true, 'it RETURNS the error so the caller decides when to throw');
  assert.equal(nothingExists.code, PORT_ERROR_CODES.EDGE_ENDPOINT_MISSING);
  assert.deepEqual(nothingExists.identity, { namespace: 'topology', scenarioId: null, endpoint: 'fromId', id: PACKAGE_ID });

  // The source is there, the target is nowhere this edge may reach: the target is blamed, and the
  // message names BOTH namespaces that were searched.
  const targetMissing = edgeEndpointMissing(scope, input, pairs, (namespace, id) => namespace === 'topology' && id === PACKAGE_ID);
  assert.equal(targetMissing.identity.endpoint, 'toId');
  assert.match(targetMissing.message, /'topology' or 'curated'/);

  // Both endpoints exist, but never in ONE legal pair. Unreachable through today's table (every
  // bridge keeps its home namespace on one side, so a resolvable endpoint pair always exists) —
  // this is the guard for a future table entry where both sides could vary, and it must blame the
  // SPAN rather than a node that is plainly there.
  const twoSidedPairs = [
    { fromNamespace: 'topology', toNamespace: 'topology' },
    { fromNamespace: 'curated', toNamespace: 'curated' },
  ];
  const noLegalPair = edgeEndpointMissing(scope, input, twoSidedPairs, (namespace, id) =>
    (namespace === 'topology' && id === PACKAGE_ID) || (namespace === 'curated' && id === COMPONENT_ID),
  );
  assert.match(noLegalPair.message, /does not span a legal namespace pair/);
  assert.equal(noLegalPair.identity.endpoint, 'fromId');

  // A relationship outside the table has one pair, so one namespace is named.
  const sameNamespace = edgeEndpointMissing(scope, input, endpointScopePairs('topology', 'PART_OF'), () => false);
  assert.match(sameNamespace.message, /does not exist in namespace 'topology'\./);
});

test('validateCapabilities reports a missing, non-boolean, unknown or malformed declaration', () => {
  const declared = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false]));
  assert.deepEqual(validateCapabilities({ ...declared, roles: true }), []);

  const missing = validateCapabilities({ roles: true });
  assert.deepEqual(
    missing.map((v) => v.code),
    Array(3).fill(PORT_ERROR_CODES.MISSING_CAPABILITY),
  );
  assert.deepEqual(
    missing.map((v) => v.identity.capability),
    CAPABILITY_KEYS.filter((key) => key !== 'roles'),
  );

  const wrongType = validateCapabilities({ ...declared, roles: 'yes' });
  assert.equal(wrongType.length, 1);
  assert.equal(wrongType[0].code, PORT_ERROR_CODES.INVALID_CAPABILITY_VALUE);
  assert.deepEqual(wrongType[0].identity, { capability: 'roles', value: 'yes' });

  const unknown = validateCapabilities({ ...declared, quantumJoins: true });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].code, PORT_ERROR_CODES.UNKNOWN_CAPABILITY);
  assert.deepEqual(unknown[0].identity, { capability: 'quantumJoins' });

  for (const bad of [null, 'roles', 42, ['roles'], new Map()]) {
    const violations = validateCapabilities(bad);
    assert.equal(violations.length, 1, String(bad));
    assert.equal(violations[0].code, PORT_ERROR_CODES.INVALID_CAPABILITIES_VALUE, String(bad));
    assert.deepEqual(violations[0].identity, { value: bad });
  }
});

test('PORT_ERROR_CODES is the single vocabulary: every code is its own key and is frozen', () => {
  for (const [key, value] of Object.entries(PORT_ERROR_CODES)) assert.equal(value, key);
  assert.ok(Object.isFrozen(PORT_ERROR_CODES));
});

// The scope glue every adapter composes out of the validators above. It lives in `port.mjs` so
// two adapters cannot drift apart in the ORDER they validate (which decides which code a caller
// sees when an argument object is wrong in more than one way) — asserted here once, engine-free.
test('the shared scope glue normalizes a scope and reports scope faults before argument faults', () => {
  assert.deepEqual(normalizeScope({ namespace: 'curated' }), { namespace: 'curated', scenarioId: null });
  assert.deepEqual(normalizeScope({ namespace: 'curated', scenarioId: 'scenario-a' }), {
    namespace: 'curated',
    scenarioId: null,
  });
  assert.deepEqual(normalizeScope({ namespace: SCENARIO_NAMESPACE, scenarioId: 'scenario-a' }), {
    namespace: SCENARIO_NAMESPACE,
    scenarioId: 'scenario-a',
  });

  assert.deepEqual(scopeOf('getNode', { namespace: 'curated', id: RULE_ID }), { namespace: 'curated', scenarioId: null });

  // A malformed scope wins over a malformed argument name: the scope decides which store the
  // caller is even talking about.
  assert.throws(
    () => scopeOf('getNode', { namespace: 'work', tpye: 'Rule' }),
    (error) => error.code === PORT_ERROR_CODES.UNKNOWN_NAMESPACE,
  );
  assert.throws(
    () => scopeOf('getNode', { namespace: 'curated', tpye: 'Rule' }),
    (error) => error.code === PORT_ERROR_CODES.UNKNOWN_ARGUMENT && error.identity.argument === 'tpye',
  );
  assert.throws(
    () => scopeOf('getNode', { namespace: SCENARIO_NAMESPACE }),
    (error) => error.code === PORT_ERROR_CODES.MISSING_SCENARIO_ID,
  );
});

test('the shared edge-key check and NODE_NOT_FOUND rejection are identical for every adapter', () => {
  assert.equal(checkEdgeKey({ type: 'APPLIES_TO', fromId: RULE_ID, toId: SURFACE_ID }), undefined);
  const cases = [
    [{ type: '', fromId: RULE_ID, toId: SURFACE_ID }, PORT_ERROR_CODES.INVALID_TYPE, { value: '' }],
    [{ type: 'T', fromId: 42, toId: SURFACE_ID }, PORT_ERROR_CODES.INVALID_NODE_ID, { argument: 'fromId', value: 42 }],
    [{ type: 'T', fromId: RULE_ID, toId: '' }, PORT_ERROR_CODES.INVALID_NODE_ID, { argument: 'toId', value: '' }],
  ];
  for (const [input, code, identity] of cases) {
    assert.throws(
      () => checkEdgeKey(input),
      (error) => isPortError(error) && error.code === code && JSON.stringify(error.identity) === JSON.stringify(identity),
      JSON.stringify(input),
    );
  }

  const error = nodeNotFound({ namespace: 'curated', scenarioId: null }, RULE_ID);
  assert.equal(isPortError(error), true, 'it RETURNS the error so the caller decides when to throw');
  assert.equal(error.code, PORT_ERROR_CODES.NODE_NOT_FOUND);
  assert.deepEqual(error.identity, { namespace: 'curated', scenarioId: null, id: RULE_ID });
});

test('PortError carries the violation-object triple (code, message, identity)', () => {
  const error = new PortError('NODE_NOT_FOUND', 'nope', { id: RULE_ID });
  assert.ok(error instanceof Error);
  assert.equal(isPortError(error), true);
  assert.equal(error.name, 'PortError');
  assert.equal(error.code, 'NODE_NOT_FOUND');
  assert.equal(error.message, 'nope');
  assert.deepEqual(error.identity, { id: RULE_ID });
  assert.equal(isPortError(new Error('plain')), false);
});

// --- the reference adapter runs the shared suite ----------------------------------------------

runEngineContractSuite('memory', () => createMemoryPort());
