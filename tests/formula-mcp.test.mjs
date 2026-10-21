// H1 — MCP adapter: the ratified read tools + the gated apply tool (spec §14). The adapter is
// driven through a memory port over a seeded graph (the established applyChangeSet discipline),
// and every read tool's output is compared against the core's own contract objects — never a
// re-derived serialization.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { applyChangeSet } from '../scripts/formula/core/revision.mjs';
import { buildContextOutput } from '../scripts/formula/core/context-output.mjs';
import { inspectScenario } from '../scripts/formula/core/promotion.mjs';
import { createMcpServer, READ_TOOLS, applyToolDefinition } from '../adapters/mcp/formula-mcp.mjs';

const PROJECT = 'mcp';
const qid = (local) => `apex:${PROJECT}:${local}`;

const META = {
  projectId: PROJECT,
  proposer: { type: 'agent-proposer', id: 'mcp-agent' },
  approver: { type: 'human-approver', id: 'mcp-reviewer' },
  provenance: [{ quotation: 'MCP suite fixture.', source: 'tests/formula-mcp.test.mjs:1', digest: 'a'.repeat(64) }],
};

function addNode(type, localId, properties = {}) {
  const id = qid(localId);
  return { op: 'ADD', target: 'node', namespace: 'curated', type, id, properties: { id, status: 'active', ...properties } };
}

function addEdge(type, fromLocal, toLocal) {
  return { op: 'ADD', target: 'edge', namespace: 'curated', type, fromId: qid(fromLocal), toId: qid(toLocal) };
}

async function seedGraph() {
  const port = createMemoryPort();
  await applyChangeSet(port, { operations: [addNode('Project', 'project:root')] }, META);
  await applyChangeSet(
    port,
    {
      operations: [
        addNode('Surface', 'surface:web'),
        addEdge('PART_OF', 'surface:web', 'project:root'),
        addNode('Rule', 'rule:https-only', {
          title: 'Serve over HTTPS',
          statement: 'Pages must serve over HTTPS.',
          strength: 'must',
          category: 'security',
          concern: 'https',
          provenance: { source: 'fixture:1', line: 1 },
        }),
        addEdge('APPLIES_TO', 'rule:https-only', 'surface:web'),
        addNode('Check', 'check:tls'),
        addEdge('VERIFIED_BY', 'rule:https-only', 'check:tls'),
        addNode('Decision', 'decision:drop-http'),
        addEdge('MOTIVATED_BY', 'rule:https-only', 'decision:drop-http'),
      ],
    },
    META,
  );
  return port;
}

function toolNames(server) {
  return server.tools.map((tool) => tool.name).sort();
}

test('the tool list is exactly the ratified read set without the human-approval capability', async () => {
  const port = createMemoryPort();
  try {
    const server = createMcpServer({ port, projectId: PROJECT });
    assert.deepEqual(
      toolNames(server),
      ['get_node', 'graph_status', 'preview_promotion', 'resolve_context', 'trace_rule'],
      'without humanApproval the tool list is exactly the five ratified read tools',
    );
    assert.ok(!server.tools.some((t) => t.name === 'apply_promotion'));
    assert.ok(!server.tools.some((t) => /query|cypher|execute/.test(t.name)), 'no arbitrary-query tool');
  } finally {
    await port.close();
  }
});

test('apply_promotion is registered only under the human-approval capability', async () => {
  const port = createMemoryPort();
  try {
    const read = createMcpServer({ port, projectId: PROJECT, capabilities: { humanApproval: false } });
    assert.ok(!read.tools.some((t) => t.name === 'apply_promotion'));
    const declined = await read.handleTool('apply_promotion', { scenarioId: 'x', approver: 'me' });
    assert.equal(declined.isError, true);
    assert.match(declined.content[0].text, /CLI-only|not registered/);

    const write = createMcpServer({ port, projectId: PROJECT, capabilities: { humanApproval: true } });
    assert.deepEqual(
      toolNames(write),
      ['apply_promotion', 'get_node', 'graph_status', 'preview_promotion', 'resolve_context', 'trace_rule'],
    );
    const definition = write.tools.find((t) => t.name === 'apply_promotion');
    assert.deepEqual(definition, applyToolDefinition());
  } finally {
    await port.close();
  }
});

test('resolve_context returns the same contract objects as buildContextOutput', async () => {
  const port = await seedGraph();
  try {
    const server = createMcpServer({ port, projectId: PROJECT });
    const viaMcp = await server.handleTool('resolve_context', { targets: [qid('rule:https-only')] });
    assert.equal(viaMcp.isError, undefined);
    const mcpPayload = JSON.parse(viaMcp.content[0].text);

    const direct = await buildContextOutput(port, { projectId: PROJECT, targets: [qid('rule:https-only')] });
    assert.equal(direct.ok, true);
    assert.equal(JSON.stringify(mcpPayload.json), JSON.stringify(direct.json), 'the context.json contract object must be byte-identical');
    assert.equal(mcpPayload.markdown, direct.markdown);
    assert.match(JSON.stringify(direct.json), /"schemaVersion":1/);
  } finally {
    await port.close();
  }
});

test('preview_promotion returns the same diff as inspectScenario', async () => {
  const port = await seedGraph();
  try {
    const { createScenario } = await import('../scripts/formula/core/promotion.mjs');
    await createScenario(port, {
      projectId: PROJECT,
      scenarioId: 'demo',
      proposedBy: { type: 'agent-proposer', name: 'mcp-agent' },
      operations: [addNode('Term', 'term:https', { ext_v1_provenance: { source: 'fixture:2', line: 2 } })],
    });
    const server = createMcpServer({ port, projectId: PROJECT });
    const viaMcp = await server.handleTool('preview_promotion', { scenarioId: 'demo' });
    assert.equal(viaMcp.isError, undefined);
    const mcpPayload = JSON.parse(viaMcp.content[0].text);

    const direct = await inspectScenario(port, { projectId: PROJECT, scenarioId: 'demo' });
    assert.equal(direct.ok, true);
    assert.equal(mcpPayload.diff, direct.diff);
    assert.deepEqual(mcpPayload.advisor, direct.advisor);
    assert.equal(mcpPayload.stale, direct.stale);
  } finally {
    await port.close();
  }
});

test('get_node returns the stable node and its relationships', async () => {
  const port = await seedGraph();
  try {
    const server = createMcpServer({ port, projectId: PROJECT });
    const result = await server.handleTool('get_node', { id: qid('rule:https-only') });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.node.type, 'Rule');
    assert.equal(payload.node.id, qid('rule:https-only'));
    const types = payload.relationships.map((edge) => edge.type).sort();
    assert.deepEqual(types, ['APPLIES_TO', 'MOTIVATED_BY', 'VERIFIED_BY']);

    const missing = await server.handleTool('get_node', { id: qid('rule:ghost') });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /NODE_NOT_FOUND/);
  } finally {
    await port.close();
  }
});

test('trace_rule reports the scope chain, verification, and motivation', async () => {
  const port = await seedGraph();
  try {
    const server = createMcpServer({ port, projectId: PROJECT });
    const result = await server.handleTool('trace_rule', { ruleId: qid('rule:https-only') });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.rule.id, qid('rule:https-only'));
    assert.equal(payload.rule.properties.strength, 'must');
    assert.equal(payload.scopePath[0].chain[0], qid('surface:web'));
    assert.ok(payload.scopePath[0].chain.includes(qid('project:root')), 'the scope chain reaches the Project root');
    assert.deepEqual(payload.verifiedBy, [qid('check:tls')]);
    assert.deepEqual(payload.motivatedBy, [qid('decision:drop-http')]);

    const missing = await server.handleTool('trace_rule', { ruleId: qid('rule:ghost') });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /RULE_NOT_FOUND/);
  } finally {
    await port.close();
  }
});

test('graph_status reports the head revision, validation verdict, and counts', async () => {
  const port = await seedGraph();
  try {
    const server = createMcpServer({ port, projectId: PROJECT });
    const result = await server.handleTool('graph_status', {});
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.headRevision, qid('revision:r2'));
    assert.equal(payload.revisions, 2);
    assert.equal(payload.validationOk, true);
    assert.deepEqual(payload.violations, []);
    assert.equal(payload.counts.curatedNodes, 5);
  } finally {
    await port.close();
  }
});

test('unknown tools and malformed servers are structured errors or TypeErrors', async () => {
  const port = createMemoryPort();
  try {
    const server = createMcpServer({ port, projectId: PROJECT });
    const unknown = await server.handleTool('no_such_tool');
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /UNKNOWN_TOOL/);
  } finally {
    await port.close();
  }
  assert.throws(() => createMcpServer({ port: null, projectId: PROJECT }), TypeError);
  assert.throws(() => createMcpServer({ port, projectId: '' }), TypeError);
});

test('apply_promotion under the capability delegates to the D5 promotion path', async () => {
  const port = await seedGraph();
  try {
    const { createScenario } = await import('../scripts/formula/core/promotion.mjs');
    await createScenario(port, {
      projectId: PROJECT,
      scenarioId: 'promotable',
      proposedBy: { type: 'agent-proposer', name: 'mcp-agent' },
      operations: [addNode('Term', 'term:ready'), addEdge('USED_BY', 'term:ready', 'project:root')],
    });
    const server = createMcpServer({ port, projectId: PROJECT, capabilities: { humanApproval: true } });
    const result = await server.handleTool('apply_promotion', { scenarioId: 'promotable', approver: 'mcp-human' });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.scenarioConsumed, true);
    assert.equal(payload.headRevision, qid('revision:r3'));
  } finally {
    await port.close();
  }
});
