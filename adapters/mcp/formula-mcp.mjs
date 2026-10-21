// steepy-formula MCP adapter (spec §14 ratified exposure). The product's own MCP server is the
// domain adapter over the core — it drives `scripts/formula/core/*` directly. This is a DELIBERATE
// divergence from the harness-adapter anti-pattern ("never import engine scripts from adapter
// code"): that rule governs the HARNESS shims (`adapters/opencode`, `adapters/pi`) which wire
// discovery/invocation into a host. The MCP adapter is the server §14 describes ("the CLI and
// future MCP server are adapters over that core") — it exists precisely to expose the core's
// domain contract as MCP tools. Documented divergence.
//
//   createMcpServer({ port, projectId, capabilities? }) -> { tools, handleTool }
//
// The tool set is exactly the ratified V1 exposure:
//   resolve_context, get_node, trace_rule, graph_status, preview_promotion
//   + apply_promotion ONLY when `capabilities.humanApproval` is true (else CLI-only apply).
// No arbitrary-query tool exists for normal agents. Every read tool returns the core's own
// contract objects (buildContextOutput's json/markdown, inspectScenario's diff, the port record
// shapes, the Revision chain) — never a re-derived serialization.
//
// ESM, no dependencies, no build step, no CLAUDE_* env, no absolute paths.

import { buildContextOutput } from '../../scripts/formula/core/context-output.mjs';
import { inspectScenario, applyPromotion } from '../../scripts/formula/core/promotion.mjs';
import { validateGraph } from '../../scripts/formula/core/validate-graph.mjs';
import { readChain, sha256Hex } from '../../scripts/formula/core/revision.mjs';
import { withTransaction } from '../../scripts/formula/engine/port.mjs';

// --- tool definitions ----------------------------------------------------------------------------

export const READ_TOOLS = Object.freeze([
  {
    name: 'resolve_context',
    description: 'Resolve the canonical context for task paths and/or explicit targets (context.json + context.md).',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Task paths (repository-relative).' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Explicit stable ids (apex:<project>:<local>).' },
        rootDir: { type: 'string', description: 'Repository root for the optional topology digest check.' },
        includeRationale: { type: 'boolean', description: 'Include Layer 3 rationale (default false).' },
        budget: { type: 'number', description: 'Per-call context budget override.' },
      },
    },
  },
  {
    name: 'get_node',
    description: 'Get a stable node and its relationships by qualified id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Qualified node id (apex:<project>:<local>).' } },
      required: ['id'],
    },
  },
  {
    name: 'trace_rule',
    description: 'Trace why a Rule is applicable: its scope path from the Project root, concern/strength, overrides, and verification.',
    inputSchema: {
      type: 'object',
      properties: { ruleId: { type: 'string', description: 'Qualified Rule id (apex:<project>:rule:<slug>).' } },
      required: ['ruleId'],
    },
  },
  {
    name: 'graph_status',
    description: 'Canonical graph status: head revision, validation verdict, node/edge counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'preview_promotion',
    description: 'Preview a promotion scenario: the typed diff report, advisor findings, structural verdict, and staleness.',
    inputSchema: {
      type: 'object',
      properties: { scenarioId: { type: 'string', description: 'Scenario id.' } },
      required: ['scenarioId'],
    },
  },
]);

// The apply tool is registered ONLY under an explicit human-approval capability (spec §14).
export function applyToolDefinition() {
  return {
    name: 'apply_promotion',
    description: 'Apply a promotion scenario (requires a host human-approval capability).',
    inputSchema: {
      type: 'object',
      properties: {
        scenarioId: { type: 'string', description: 'Scenario id.' },
        approver: { type: 'string', description: 'Approving human identity.' },
      },
      required: ['scenarioId', 'approver'],
    },
  };
}

export function toolList(capabilities = {}) {
  const tools = [...READ_TOOLS];
  if (capabilities.humanApproval === true) tools.push(applyToolDefinition());
  return tools;
}

// --- error helpers ------------------------------------------------------------------------------

function toolError(code, message, identity) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message, identity }) }],
  };
}

function toolOk(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] };
}

// --- handlers ------------------------------------------------------------------------------------

async function resolveContextHandler(port, projectId, args) {
  const options = {};
  if (typeof args.includeRationale === 'boolean') options.includeRationale = args.includeRationale;
  if (Number.isInteger(args.budget) && args.budget > 0) options.budget = args.budget;
  const result = await buildContextOutput(port, {
    projectId,
    paths: args.paths,
    targets: args.targets,
    rootDir: args.rootDir,
    options,
  });
  if (!result.ok) return toolError(result.code, result.message, result.identity);
  return toolOk({ json: result.json, markdown: result.markdown });
}

async function getNodeHandler(port, projectId, args) {
  const { id } = args;
  const graph = await withTransaction(port, async (tx) => {
    // Accumulate in a loop, not a spread: at the E1 fixture scale (25k curated nodes, 150k
    // relationships) `nodes.push(...listNodes(...))` blows the call stack on the spread argument
    // list (same amendment as validate-graph.mjs / resolve-context.mjs).
    const nodes = [];
    const edges = [];
    for (const namespace of ['curated', 'topology']) {
      for (const node of await tx.listNodes({ namespace })) nodes.push(node);
      for (const edge of await tx.listEdges({ namespace })) edges.push(edge);
    }
    return { nodes, edges };
  });
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) return toolError('NODE_NOT_FOUND', `No stable node '${id}' exists.`, { id });
  const relationships = graph.edges.filter((edge) => edge.fromId === id || edge.toId === id);
  return toolOk({ node, relationships });
}

async function traceRuleHandler(port, projectId, args) {
  const { ruleId } = args;
  const graph = await withTransaction(port, async (tx) => {
    // Accumulate in a loop, not a spread: same stack-overflow amendment as getNodeHandler above.
    const nodes = [];
    const edges = [];
    for (const namespace of ['curated', 'topology']) {
      for (const node of await tx.listNodes({ namespace })) nodes.push(node);
      for (const edge of await tx.listEdges({ namespace })) edges.push(edge);
    }
    return { nodes, edges };
  });
  const rule = graph.nodes.find((candidate) => candidate.id === ruleId && candidate.type === 'Rule');
  if (!rule) return toolError('RULE_NOT_FOUND', `No Rule '${ruleId}' exists.`, { ruleId });

  // scope targets (APPLIES_TO) + their PART_OF chain up to the Project root
  const appliesTo = graph.edges.filter((edge) => edge.type === 'APPLIES_TO' && edge.fromId === ruleId);
  const scopePath = [];
  for (const edge of appliesTo) {
    const hop = { target: edge.toId };
    const chain = [edge.toId];
    let current = edge.toId;
    for (let depth = 0; depth < 8; depth += 1) {
      const parent = graph.edges.find((candidate) => candidate.type === 'PART_OF' && candidate.fromId === current);
      if (!parent) break;
      chain.push(parent.toId);
      current = parent.toId;
      if (parent.toId === ruleId || parent.toId === chain[0]) break;
    }
    hop.chain = chain;
    scopePath.push(hop);
  }

  const overriddenBy = graph.edges.filter((edge) => edge.type === 'OVERRIDES' && edge.toId === ruleId).map((edge) => edge.fromId);
  const overrides = graph.edges.filter((edge) => edge.type === 'OVERRIDES' && edge.fromId === ruleId).map((edge) => edge.toId);
  const verifiedBy = graph.edges.filter((edge) => edge.type === 'VERIFIED_BY' && edge.fromId === ruleId).map((edge) => edge.toId);
  const motivatedBy = graph.edges.filter((edge) => edge.type === 'MOTIVATED_BY' && edge.fromId === ruleId).map((edge) => edge.toId);

  return toolOk({
    rule,
    scopePath,
    overrides,
    overriddenBy,
    verifiedBy,
    motivatedBy,
  });
}

async function graphStatusHandler(port, projectId) {
  const chain = await readChain(port, { projectId });
  const validation = await validateGraph(port, { projectId });
  const counts = await withTransaction(port, async (tx) => {
    const curated = (await tx.listNodes({ namespace: 'curated' })).length;
    const topology = (await tx.listNodes({ namespace: 'topology' })).length;
    const edges = (await tx.listEdges({ namespace: 'curated' })).length + (await tx.listEdges({ namespace: 'topology' })).length;
    return { curatedNodes: curated, topologyNodes: topology, edges };
  });
  return toolOk({
    headRevision: chain.headRevision,
    revisions: chain.revisions.length,
    validationOk: validation.ok,
    violations: validation.violations,
    warnings: validation.warnings,
    counts,
  });
}

async function previewPromotionHandler(port, projectId, args) {
  const { scenarioId } = args;
  const inspection = await inspectScenario(port, { projectId, scenarioId });
  if (!inspection.ok) return toolError(inspection.code, inspection.message, inspection.identity);
  return toolOk({
    scenarioId,
    diff: inspection.diff,
    advisor: inspection.advisor,
    structural: inspection.structural,
    stale: inspection.stale,
  });
}

async function applyPromotionHandler(port, projectId, args) {
  const { scenarioId, approver } = args;
  const quotation = 'MCP apply_promotion (host human-approval capability).';
  const applied = await applyPromotion(port, {
    projectId,
    scenarioId,
    approver: { type: 'human-approver', id: approver },
    provenance: [{ quotation, source: 'mcp:apply_promotion:1', digest: sha256Hex(quotation) }],
  });
  if (!applied.ok) return toolError(applied.code, applied.message, applied.identity);
  return toolOk({
    applied: applied.applied,
    headRevision: applied.headRevision,
    scenarioConsumed: applied.scenarioConsumed,
    export: applied.export,
  });
}

// --- server --------------------------------------------------------------------------------------

export function createMcpServer({ port, projectId, capabilities = {} }) {
  if (!port || typeof port.begin !== 'function') {
    throw new TypeError('createMcpServer requires a port with a begin() method.');
  }
  if (typeof projectId !== 'string' || projectId === '') {
    throw new TypeError('createMcpServer requires a non-empty projectId.');
  }
  const tools = toolList(capabilities);
  const hasApply = capabilities.humanApproval === true;

  async function handleTool(name, args = {}) {
    switch (name) {
      case 'resolve_context':
        return resolveContextHandler(port, projectId, args);
      case 'get_node':
        return getNodeHandler(port, projectId, args);
      case 'trace_rule':
        return traceRuleHandler(port, projectId, args);
      case 'graph_status':
        return graphStatusHandler(port, projectId);
      case 'preview_promotion':
        return previewPromotionHandler(port, projectId, args);
      case 'apply_promotion':
        if (!hasApply) {
          return toolError('TOOL_NOT_REGISTERED', 'apply_promotion is not registered: this host has no human-approval capability; apply remains CLI-only.', { name });
        }
        return applyPromotionHandler(port, projectId, args);
      default:
        return toolError('UNKNOWN_TOOL', `Unknown MCP tool '${name}'.`, { name });
    }
  }

  return { tools, handleTool };
}
