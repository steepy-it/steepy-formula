// Layered context output for the Stable Knowledge Graph (spec §9 "Context layers and output
// contracts", §25 "Topology refresh ownership"). This module owns nothing D1/D2 already own — it
// PARTITIONS an already-resolved answer into Layers 0-3, applies the deterministic context budget,
// and renders the two output artifacts:
//
//   buildContextOutput(port, { projectId, paths?, targets?, rootDir?, options? })
//     -> { ok: true, code: null, projectId, input, json, markdown }
//     -> { ok: false, code, message, identity, projectId, input, ... }   (D2's codes, unchanged)
//     -> { ok: false, code: 'CONTEXT_OVERFLOW', message, identity: { measured, budget }, ... }
//
//   options = { includeRationale?: boolean, budget?: integer, fs?: object }
//
// LAYER ASSIGNMENT (spec §9, controller binding semantics #1) is computed from `resolveContext`'s
// `context` + `diagnostics` and NOTHING ELSE:
//   Layer 0 — every `diagnostics` field except `checkVerifiers` (an INDEX for this module's own
//             layer assignment, not itself a diagnostic — deliberately excluded, pinned by test),
//             plus the §25 topology refresh outcome, the budget's own `truncated` record, and
//             `excludedByRationale` (below). Never budgeted, never truncated: a diagnostic that
//             vanishes under pressure is worse than none.
//   Layer 1 — `must` Rules; Agents; Skills; Checks reachable via VERIFIED_BY from a `must` Rule
//             THAT IS ITSELF PART OF THIS ANSWER. A Check named as an explicit target (spec §8)
//             with no such Rule in the answer — `diagnostics.checkVerifiers` has no entry for it —
//             is Layer 2, never Layer 1: Layer 1 is "required Checks", and nothing in the answer
//             requires a Check whose verifying Rule was never resolved; letting a caller enlarge
//             the never-truncated Layer 1 floor just by naming Checks would make CONTEXT_OVERFLOW's
//             threshold caller-controlled.
//   Layer 2 — `should` Rules; Terms; Checks reachable ONLY from a `should` Rule (or from no Rule
//             the answer resolved at all — see above).
//   Layer 3 — Decisions, plus the `provenance` property of Layer 1-2 items — excluded by default,
//             included only behind `options.includeRationale`. A Decision the resolution actually
//             reached but the flag alone silenced is named in `layer0.excludedByRationale` — an
//             explicit `targets: ['decision:...']` seed getting `ok: true` with every layer empty
//             and no explanation would otherwise be the same silent drop this module exists to
//             forbid everywhere else.
// A Check reached by BOTH a `must` and a `should` Rule is Layer 1 ("the stronger claim wins"),
// decided from `diagnostics.checkVerifiers` (D2's additive export of the FULL VERIFIED_BY
// multiplicity — a served Check's own `trace` can only ever name one derivation).
//
// THE BUDGET is a character count over context.json's canonical `JSON.stringify` — "the SERIALIZED
// output" in the spec's own words, and the artifact every other measure (context.md) is a VIEW of.
// A token estimator is deliberately not built: §17 forbids the dependency a real one would need,
// and a fake one would be more misleading than an honest character count. `DEFAULT_CONTEXT_BUDGET`
// is PROVISIONAL — spec §9 calibrates it on the E1 large-monorepo fixture; nobody should read this
// number as ratified. Layer 0 + Layer 1 together are the never-truncated floor: if THAT alone
// exceeds the budget, resolution refuses with `CONTEXT_OVERFLOW` rather than truncate a `must`
// Rule. Otherwise Layer 3 items drop first, then Layer 2, in REVERSE result order (the last item
// of the fixed kind-then-id order first) — deterministic, and every drop is reported in
// `layer0.truncated`.
//
// THE §25 DIGEST CHECK runs before resolution, and ONLY when a `rootDir` is supplied — the digest
// check needs a filesystem, and D2's own unit tests (and any caller with no filesystem, e.g. an
// MCP session) must keep working with none. `refreshTopology` already contains the §25 digest
// comparison as its own fast path (a no-op write when the recorded digest matches), so this module
// calls it unconditionally when a `rootDir` is given rather than re-deriving that comparison here.
// A refusal (`TOPOLOGY_STALE` / a B5-refused write) is reported in Layer 0 and NEVER re-raised as a
// resolution failure (spec §25 failure table) — the graph answers from the last valid topology.
//
// TWO TRANSACTIONS, ONE FEWER SEAM. `resolveContext` (D2) already exposes `options.validation` so a
// caller holding a B4 verdict can avoid a second whole-graph pass; this module IS that caller. It
// validates exactly once — after any topology refresh, before the traversal — and hands the verdict
// straight to `resolveContext`. That closes the "validated twice" waste but not the underlying race:
// a write landing between this module's own `validateGraph` transaction and D2's `readGraph`
// transaction is still seen by neither. Closing THAT for good needs a snapshot shared across both
// calls, which needs a port capability neither `resolveContext` nor this module owns (see D2's own
// header: a resolver "must not itself hold a transaction open across a whole-graph validation").
// Left as the documented remaining window, not silently accepted — see the D3 task report.
import { isPortError } from '../engine/port.mjs';
import { isValidProjectId } from './ids.mjs';
import { resolveContext, unavailableError } from './resolve-context.mjs';
import { TOPOLOGY_CODES, refreshTopology } from './topology.mjs';
import { validateGraph } from './validate-graph.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- vocabulary ----------------------------------------------------------------------------------

// Start at 1 (spec §9 binding semantics #5); bump on any breaking change to the `context.json`
// shape below. Calibration of `DEFAULT_CONTEXT_BUDGET` never bumps this — only a shape change does.
export const CONTEXT_SCHEMA_VERSION = 1;

// Characters of `JSON.stringify(context.json)`. CALIBRATED default (spec §9) on the E1
// large-monorepo fixture — measured 780,783 characters for a representative package path
// (rationale off; 893,589 with rationale on) at the full 500-package / 25,000-node / 150,000-edge
// scale, so this 1,000,000-character ceiling fits the measured realistic context with ~28%
// headroom. This number is configuration, not contract.
export const DEFAULT_CONTEXT_BUDGET = 1000000;

export const CONTEXT_OUTPUT_ERROR_CODES = deepFreeze({
  CONTEXT_OVERFLOW: 'CONTEXT_OVERFLOW',
});

export const TOPOLOGY_OUTCOMES = deepFreeze({
  NOT_PERFORMED: 'not-performed',
  UNCHANGED: 'unchanged',
  REFRESHED: 'refreshed',
  STALE: 'stale',
});

// --- input contract --------------------------------------------------------------------------------

const INPUT_KEYS = deepFreeze(['projectId', 'paths', 'targets', 'rootDir', 'options']);
const OPTION_KEYS = deepFreeze(['includeRationale', 'budget', 'fs']);

function rejectUnknownKeys(input, accepted, what) {
  for (const key of Object.keys(input)) {
    if (!accepted.includes(key)) {
      throw new TypeError(`buildContextOutput: unknown ${what} '${key}'; accepted: ${accepted.join(', ')}.`);
    }
  }
}

function normalizeOptions(options) {
  if (!isPlainObject(options)) {
    throw new TypeError('buildContextOutput: options must be an object.');
  }
  rejectUnknownKeys(options, OPTION_KEYS, 'option');
  const { includeRationale = false, budget = DEFAULT_CONTEXT_BUDGET, fs } = options;
  if (typeof includeRationale !== 'boolean') {
    throw new TypeError('buildContextOutput: options.includeRationale must be a boolean.');
  }
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new TypeError('buildContextOutput: options.budget must be a positive integer.');
  }
  if (fs !== undefined && !isPlainObject(fs)) {
    throw new TypeError('buildContextOutput: options.fs must be an object.');
  }
  return { includeRationale, budget, fs };
}

function normalizeInput(port, input) {
  if (!port || typeof port.begin !== 'function') {
    throw new TypeError('buildContextOutput requires a port with a begin() method.');
  }
  if (!isPlainObject(input)) {
    throw new TypeError('buildContextOutput requires an input object with a projectId and at least one path or target.');
  }
  rejectUnknownKeys(input, INPUT_KEYS, 'input key');
  const { projectId, paths = [], targets = [], rootDir, options = {} } = input;
  if (!isValidProjectId(projectId)) {
    throw new TypeError(`buildContextOutput requires a valid projectId, got ${JSON.stringify(projectId ?? null)}.`);
  }
  if (rootDir !== undefined && (typeof rootDir !== 'string' || rootDir === '')) {
    throw new TypeError('buildContextOutput: rootDir must be a non-empty string when supplied.');
  }
  return { projectId, paths, targets, rootDir: rootDir ?? null, options: normalizeOptions(options) };
}

// --- the §25 digest check / incremental refresh ----------------------------------------------------

// `refreshTopology` already IS the §25 comparison (a `TOPOLOGY_UNCHANGED` fast path when the
// recorded digest matches a fresh `detectTopology`), so this calls it unconditionally rather than
// re-deriving the digest comparison here. Never throws on a refusal — a stale or rejected refresh
// is reported, never re-raised (spec §25 failure table); a PortError propagates to the caller's own
// KNOWLEDGE_GRAPH_UNAVAILABLE mapping, same as every other port read in this module.
async function checkTopology(port, projectId, rootDir, fs) {
  if (rootDir === null) {
    return { performed: false, outcome: TOPOLOGY_OUTCOMES.NOT_PERFORMED, digest: null, changes: null, diagnostics: [] };
  }
  const result = await refreshTopology(port, rootDir, { projectId }, fs !== undefined ? { fs } : {});
  if (result.ok) {
    const refreshed = result.code === TOPOLOGY_CODES.TOPOLOGY_WRITTEN;
    return {
      performed: true,
      outcome: refreshed ? TOPOLOGY_OUTCOMES.REFRESHED : TOPOLOGY_OUTCOMES.UNCHANGED,
      digest: result.digest,
      changes: refreshed ? result.outcome : null,
      diagnostics: [],
    };
  }
  // TOPOLOGY_STALE (detection refused) or TOPOLOGY_REJECTED (B5 refused the derived ChangeSet):
  // either way nothing was written, so the graph still holds the last valid topology.
  return {
    performed: true,
    outcome: TOPOLOGY_OUTCOMES.STALE,
    digest: result.digest ?? null,
    changes: null,
    diagnostics: result.diagnostics ?? [],
  };
}

// --- layer assignment (spec §9 binding semantics #1) -------------------------------------------------

function isMustRule(rule) {
  return rule.properties?.strength === 'must';
}

// Every resolved item lands in exactly one layer — asserted exhaustively by the test suite, not
// merely eyeballed. `checkVerifiers` is D2's additive export: the FULL set of surviving Rules that
// VERIFIED_BY each served Check, since a Check's own `trace` can only ever name one derivation.
function assignLayers(context, checkVerifiers) {
  const verifiersOf = new Map(checkVerifiers.map((entry) => [entry.id, entry.ruleIds]));
  const mustRuleIds = new Set(context.rules.filter(isMustRule).map((rule) => rule.id));

  const layer1Rules = [];
  const layer2Rules = [];
  for (const rule of context.rules) (isMustRule(rule) ? layer1Rules : layer2Rules).push(rule);

  const layer1Checks = [];
  const layer2Checks = [];
  for (const check of context.checks) {
    // A served Check may have NO verifier at all in this answer — not an invariant break: an
    // explicit `targets: ['check:...']` seed (spec §8) keeps a Check directly, without walking
    // VERIFIED_BY (only Rules and chain anchors expand — see `resolve-context.mjs`'s seed
    // handling), so `checkVerifiers` legitimately carries no entry for it. A missing entry and an
    // (unreachable in practice, but harmless) empty one mean the same thing here.
    //
    // CONTROLLER RULING: such a Check goes to Layer 2, never Layer 1. Two reasons: (a) §9's Layer 1
    // is "…and required Checks" — required BY a `must` Rule that is itself part of the answer; a
    // Check nothing in the answer requires is not "required". (b) Layer 1 is the never-truncated
    // floor (spec: never truncate a `must` Rule) — letting a caller enlarge it just by NAMING
    // Checks as targets would make `CONTEXT_OVERFLOW`'s threshold caller-controlled.
    const ruleIds = verifiersOf.get(check.id) ?? [];
    (ruleIds.some((id) => mustRuleIds.has(id)) ? layer1Checks : layer2Checks).push(check);
  }

  return {
    layer1: { rules: layer1Rules, checks: layer1Checks, agents: context.agents, skills: context.skills },
    layer2: { rules: layer2Rules, checks: layer2Checks, terms: context.terms },
    layer3: { decisions: context.decisions },
  };
}

// --- the rationale flag (spec §9 binding semantics #2) -----------------------------------------------

// "Rationale" = Layer 3 in full, plus the `provenance` property on Layer 1-2 items. Without the
// flag an item keeps its identity, statement and trace, minus that one property.
function withoutProvenance(item) {
  if (!item.properties || !('provenance' in item.properties)) return item;
  const { provenance, ...rest } = item.properties;
  return { ...item, properties: rest };
}

function shapeItems(items, includeRationale) {
  return includeRationale ? items : items.map(withoutProvenance);
}

// --- the deterministic budget (spec §9 binding semantics #3-#4) --------------------------------------

const EMPTY_LAYER2 = deepFreeze({ rules: [], checks: [], terms: [] });
const EMPTY_LAYER3 = deepFreeze({ decisions: [] });

function envelopeSize(schemaVersion, projectId, input, layer0, layer1, layer2, layer3) {
  return JSON.stringify({ schemaVersion, projectId, input, layer0, layer1, layer2, layer3 }).length;
}

// The drop order: Layer 3 before Layer 2, each in REVERSE result order (the fixed kind-then-id
// order `resolveContext` already sorted its buckets in) — the LAST item drops FIRST, so the drop is
// deterministic without being arbitrary.
function buildDropQueue(layer2, layer3) {
  const layer3Queue = layer3.decisions.map((item) => ({ layer: 3, bucket: 'decisions', id: item.id })).reverse();
  const layer2Forward = [
    ...layer2.rules.map((item) => ({ layer: 2, bucket: 'rules', id: item.id })),
    ...layer2.checks.map((item) => ({ layer: 2, bucket: 'checks', id: item.id })),
    ...layer2.terms.map((item) => ({ layer: 2, bucket: 'terms', id: item.id })),
  ];
  return [...layer3Queue, ...layer2Forward.reverse()];
}

function withoutId(layer, bucket, id) {
  return { ...layer, [bucket]: layer[bucket].filter((item) => item.id !== id) };
}

// Returns `{ overflow: true, measured, budget }` or `{ overflow: false, layer2, layer3, truncated }`.
// Layer 0 and Layer 1 are NEVER truncated (spec: "never truncate a `must` Rule"); their combined
// size, computed with an EMPTY Layer 2/3 and an empty `truncated` list, is the floor this budget
// check is against — `truncated` itself is reported in Layer 0 (never budgeted), so it can only
// grow the final artifact past the nominal budget by the size of its own bookkeeping.
function applyBudget({ schemaVersion, projectId, input, layer0, layer1, layer2, layer3, budget }) {
  const floorLayer0 = { ...layer0, truncated: [] };
  const floorSize = envelopeSize(schemaVersion, projectId, input, floorLayer0, layer1, EMPTY_LAYER2, EMPTY_LAYER3);
  if (floorSize > budget) {
    return { overflow: true, measured: floorSize, budget };
  }

  let currentLayer2 = layer2;
  let currentLayer3 = layer3;
  const truncated = [];
  const dropQueue = buildDropQueue(layer2, layer3);
  let size = envelopeSize(schemaVersion, projectId, input, floorLayer0, layer1, currentLayer2, currentLayer3);

  let cursor = 0;
  while (size > budget && cursor < dropQueue.length) {
    const drop = dropQueue[cursor];
    cursor += 1;
    if (drop.layer === 3) currentLayer3 = withoutId(currentLayer3, drop.bucket, drop.id);
    else currentLayer2 = withoutId(currentLayer2, drop.bucket, drop.id);
    truncated.push({ id: drop.id, layer: drop.layer });
    size = envelopeSize(schemaVersion, projectId, input, floorLayer0, layer1, currentLayer2, currentLayer3);
  }

  return { overflow: false, layer2: currentLayer2, layer3: currentLayer3, truncated };
}

// --- context.md (spec §9 binding semantics #6): a VIEW, never a source of new items -----------------

function mdLine(item) {
  return `- \`${item.id}\` (${item.status}${item.deprecated ? ', deprecated' : ''})`;
}

function mdSection(title, items) {
  if (items.length === 0) return `### ${title}\n\n_none_\n`;
  return `### ${title}\n\n${items.map(mdLine).join('\n')}\n`;
}

function renderMarkdown(json) {
  const lines = [`# Context (schema v${json.schemaVersion})`, '', `Project: \`${json.projectId}\``, ''];

  lines.push('## Layer 0 — diagnostics', '');
  lines.push(`Topology: ${json.layer0.topology.outcome}`, '');
  if (json.layer0.truncated.length > 0) {
    lines.push('### Truncated', '', ...json.layer0.truncated.map((entry) => `- \`${entry.id}\` (layer ${entry.layer})`), '');
  }
  // Conflicts (§9 lists them in Layer 0): `overridden` = dropped from the answer outright, with
  // what replaced it; `overriddenInScope` = still SERVED, but not for the named input. `unresolved`
  // is always `[]` on a success path (D2's own comment) so there is nothing to render for it.
  if (json.layer0.overridden.length > 0) {
    lines.push(
      '### Overridden',
      '',
      ...json.layer0.overridden.map((entry) => `- \`${entry.id}\` -> \`${entry.overriddenBy}\` (${entry.concern})`),
      '',
    );
  }
  if (json.layer0.overriddenInScope.length > 0) {
    lines.push(
      '### Overridden in scope',
      '',
      ...json.layer0.overriddenInScope.map(
        (entry) => `- \`${entry.id}\` -> \`${entry.overriddenBy}\` (${entry.concern}, not for \`${entry.input}\`)`,
      ),
      '',
    );
  }
  if (json.layer0.excludedByRationale.length > 0) {
    lines.push(
      '### Excluded by the rationale flag',
      '',
      ...json.layer0.excludedByRationale.map((entry) => `- \`${entry.id}\` (layer ${entry.layer})`),
      '',
    );
  }
  if (json.layer0.warnings.length > 0) {
    lines.push('### Warnings', '', ...json.layer0.warnings.map((warning) => `- ${warning.code ?? JSON.stringify(warning)}`), '');
  }

  lines.push('## Layer 1 — mandatory', '');
  lines.push(mdSection('Rules', json.layer1.rules));
  lines.push(mdSection('Checks', json.layer1.checks));
  lines.push(mdSection('Agents', json.layer1.agents));
  lines.push(mdSection('Skills', json.layer1.skills));

  lines.push('## Layer 2 — guidance', '');
  lines.push(mdSection('Rules', json.layer2.rules));
  lines.push(mdSection('Checks', json.layer2.checks));
  lines.push(mdSection('Terms', json.layer2.terms));

  lines.push('## Layer 3 — explanation', '');
  lines.push(mdSection('Decisions', json.layer3.decisions));

  return `${lines.join('\n')}\n`;
}

// --- failures --------------------------------------------------------------------------------------

function failure(code, message, identity, projectId, input) {
  return { ok: false, code, message, identity, projectId, input };
}

function overflowError(projectId, input, measured, budget) {
  return failure(
    CONTEXT_OUTPUT_ERROR_CODES.CONTEXT_OVERFLOW,
    `Layer 0 + Layer 1 alone require ${measured} characters, exceeding the ${budget}-character context budget; narrow the scope or refactor the governance model.`,
    { measured, budget },
    projectId,
    input,
  );
}

// --- entry point -----------------------------------------------------------------------------------

export async function buildContextOutput(port, input = {}) {
  const { projectId, paths, targets, rootDir, options } = normalizeInput(port, input);
  const echo = { paths, targets, rootDir };

  // ALL port I/O for this module's OWN steps sits in this one block — a bug below must surface as
  // the crash it is, never as a false "the graph is unavailable" (same discipline as D2).
  let topology;
  let resolved;
  try {
    topology = await checkTopology(port, projectId, rootDir, options.fs);
    // Validate exactly once, after any topology refresh, and hand the verdict to `resolveContext`
    // rather than let it validate again — see the module header's seam note.
    const validation = await validateGraph(port, { projectId });
    resolved = await resolveContext(port, { projectId, paths, targets, options: { validation } });
  } catch (error) {
    if (isPortError(error)) return unavailableError(projectId, echo, error);
    throw error;
  }

  // D2's failure codes pass through UNCHANGED (spec §25): there is no resolved context to
  // partition, so no Layer 0-3 shape is invented on top of them.
  if (!resolved.ok) return resolved;

  const { context, diagnostics } = resolved;
  const { layer1, layer2, layer3 } = assignLayers(context, diagnostics.checkVerifiers);

  const shapedLayer1 = {
    rules: shapeItems(layer1.rules, options.includeRationale),
    checks: shapeItems(layer1.checks, options.includeRationale),
    agents: shapeItems(layer1.agents, options.includeRationale),
    skills: shapeItems(layer1.skills, options.includeRationale),
  };
  const shapedLayer2Full = {
    rules: shapeItems(layer2.rules, options.includeRationale),
    checks: shapeItems(layer2.checks, options.includeRationale),
    terms: shapeItems(layer2.terms, options.includeRationale),
  };
  // Layer 3 is excluded by default — not merely stripped of provenance like Layer 1-2, ABSENT —
  // and is included in FULL (with provenance) only behind the flag.
  const layer3Full = options.includeRationale ? layer3 : EMPTY_LAYER3;
  // A caller may explicitly TARGET a Decision (spec §8) and, with the flag off, get `ok: true` with
  // every layer empty and no explanation — silence indistinguishable from "nothing resolved". Named
  // here so it never is: every Decision this resolution actually reached that the flag alone kept
  // out of Layer 3 (never budget-truncated — this runs before the budget stage entirely).
  const excludedByRationale = options.includeRationale
    ? []
    : layer3.decisions.map((item) => ({ id: item.id, layer: 3 }));

  const jsonInput = { ...resolved.input, rootDir };
  const layer0Base = {
    deprecated: diagnostics.deprecated,
    overridden: diagnostics.overridden,
    overriddenInScope: diagnostics.overriddenInScope,
    unresolved: diagnostics.unresolved,
    warnings: diagnostics.warnings,
    topology,
    excludedByRationale,
  };

  const budgeted = applyBudget({
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    projectId,
    input: jsonInput,
    layer0: layer0Base,
    layer1: shapedLayer1,
    layer2: shapedLayer2Full,
    layer3: layer3Full,
    budget: options.budget,
  });
  if (budgeted.overflow) {
    return overflowError(projectId, echo, budgeted.measured, budgeted.budget);
  }

  const json = {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    projectId,
    input: jsonInput,
    layer0: { ...layer0Base, truncated: budgeted.truncated },
    layer1: shapedLayer1,
    layer2: budgeted.layer2,
    layer3: budgeted.layer3,
  };

  return { ok: true, code: null, projectId, input: echo, json, markdown: renderMarkdown(json) };
}
