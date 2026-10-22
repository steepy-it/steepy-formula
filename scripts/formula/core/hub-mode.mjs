// Hub-mode detection (spec D4 of the promotion-in-chain work; plan decision 5) — the ONE place a
// repository's documentation-hub mode is decided. The mode answers "which hub does this repo use
// right now?" for every skill prose that must declare it, and names the step that comes next:
//
//   graph    the Stable Knowledge Graph is operational — the engine is reachable AND the project's
//            graph is initialized (the system record exists), the SAME facts `graph status` reads
//            (server readiness + the system record `statusFacts` probes in cli.mjs) — AND no
//            steepy-apex area is left (`<rootDir>/.apex` absent). Next: nothing.
//   migrate  a steepy-apex `.apex/` area is still present, with or without a Markdown hub.
//            Next: the `graph-migrate` skill moves a hub into the graph and removes the area;
//            until then the workflow scripts refuse (markdown-hub.mjs `migrateRefusal`) while the
//            graph primitives (`graph *`, `promotion *`, `context resolve`, `hub-mode`) keep working.
//   none     neither. Next: the `init` skill.
//
//   detectHubMode({ projectId, facts?, fs?, rootDir? }) -> { ok: true, mode, next, evidence }
//
//     projectId  REQUIRED — the caller names the project (the CLI's D3 chain resolves it); there
//                is no private default, a missing id is a TypeError like an invalid one.
//
//     mode      'graph' | 'migrate' | 'none' (the HUB_MODES vocabulary)
//     next      the skill that comes next — HUB_MODE_NEXT_STEPS[mode]: 'graph-migrate' for
//               migrate, 'init' for none, null for graph
//     evidence  { engine: { reachable, detail?, reason? }, initialized, legacyArea, markdownHub }
//               `initialized` is true/false once the engine answered, null when it could not;
//               an unreachable engine ALWAYS carries a `reason` — evidence records why.
//               `markdownHub` (only ever true inside a present `legacyArea`) tells graph-migrate
//               whether there is a hub to extract or only leftover local state to remove.
//
// Precedence: `migrate` iff the `.apex` area exists — it wins even over a reachable,
// initialized engine; otherwise `graph` iff reachable AND initialized; otherwise `none`. An engine
// that is up but uninitialized is NOT graph — the scenario-arbitration rule (Task 3's precedence
// case).
//
// DETECTION LIVES ONLY HERE (SC4, deferred proposal DP4): neither the CLI nor any skill prose
// re-implements the decision. The CLI parses options, prints the declaration and exits; prose
// invokes `steepy-formula hub-mode` and quotes the output. The probes themselves are the fs-only
// `legacyAreaPresent` and `markdownHubPresent` (markdown-hub.mjs), shared with the refusing workflow scripts —
// this module imports it, never the reverse (this module pulls in the engine).
//
// CONVENTIONS (core-module standard of promotion.mjs): structured results, never exceptions on
// data problems — an unreachable engine, a missing docker daemon or a failing port read is
// EVIDENCE, folded into the result; functions throw only on programmer error (a malformed input,
// an unknown input key, a mis-shaped injected facts/fs — TypeErrors). `facts` and `fs` are
// injectable so tests are hermetic; the defaults are the live engine facts (this is the one core
// module that touches engine lifecycle, because the default facts source is part of the detection
// contract) and `node:fs`. The module performs NO writes — detection is read-only, so nothing
// ever needs sanitizing on this path.

import { existsSync as defaultExistsSync, lstatSync as defaultLstatSync } from 'node:fs';
import { isValidProjectId } from './ids.mjs';
import { legacyAreaPresent, markdownHubPresent } from './markdown-hub.mjs';
import { systemRecordId } from './validate-graph.mjs';
import { SERVER_STATUS, containerNameFor, serverStatus } from '../engine/lifecycle.mjs';
import { createArcadeDbPort, databaseNameFor } from '../engine/arcadedb.mjs';
import { withTransaction } from '../engine/port.mjs';

const DETECT_INPUT_KEYS = ['projectId', 'facts', 'fs', 'rootDir'];

// --- vocabulary -----------------------------------------------------------------------------------

export const HUB_MODES = deepFreeze(['graph', 'migrate', 'none']);

// The skill each mode names as the next step (the CLI prints it as the `next:` line); graph has none.
export const HUB_MODE_NEXT_STEPS = deepFreeze({ graph: null, migrate: 'graph-migrate', none: 'init' });

// --- helpers --------------------------------------------------------------------------------------

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

// A typo must never silently drop an argument — the same closed-input discipline promotion.mjs uses.
function rejectUnknownKeys(input, accepted, caller) {
  for (const key of Object.keys(input)) {
    if (accepted.includes(key)) continue;
    throw new TypeError(`${caller}: unknown input key '${key}'; accepted: ${accepted.join(', ')}.`);
  }
}

// --- the facts sources ----------------------------------------------------------------------------

// Facts from ANY open port: reachable unless the port read itself fails, initialized iff the
// project's system record exists — the exact read `statusFacts` performs for `graph status`.
// Exported so the CLI's `--port memory` seam swaps the facts source without re-deriving anything.
export async function portEngineFacts(port, projectId) {
  try {
    const system = await withTransaction(port, (tx) => tx.getNode({ namespace: 'system', id: systemRecordId(projectId) }));
    return { reachable: true, initialized: system !== null };
  } catch (error) {
    return { reachable: false, initialized: null, reason: error?.message ?? String(error) };
  }
}

// The DEFAULT facts source — the live local engine, probed exactly the way `graph status` probes
// it: server readiness first (an unready/absent/no-docker server is unreachable, with the status
// machine's own reason), then the system record through the project's database port.
export async function liveEngineFacts(projectId) {
  const state = await serverStatus({ name: containerNameFor(projectId) });
  if (state.status !== SERVER_STATUS.READY) {
    const detail = state.reason ? ` (${state.reason})` : '';
    return { reachable: false, initialized: null, reason: `server status: ${state.status}${detail}` };
  }
  const port = createArcadeDbPort({ server: state, database: databaseNameFor(projectId) });
  try {
    const facts = await portEngineFacts(port, projectId);
    return facts.reachable ? { ...facts, detail: state.httpUrl } : facts;
  } finally {
    await port.close?.();
  }
}

// A facts result is programmer-supplied data (injected seam or this module's own sources): shape
// errors are TypeErrors. The normalized form always records WHY an unreachable engine is
// unreachable, so the evidence carries the reason even when the source omitted one.
function normalizeEngineFacts(facts) {
  if (!isPlainObject(facts)) {
    throw new TypeError(
      `detectHubMode: the facts source must resolve to { reachable, initialized? }, got ${JSON.stringify(facts ?? null)}.`,
    );
  }
  const { reachable, initialized, reason, detail } = facts;
  if (typeof reachable !== 'boolean') {
    throw new TypeError(
      `detectHubMode: the facts source must report reachable as a boolean, got ${JSON.stringify(reachable ?? null)}.`,
    );
  }
  if (initialized !== undefined && initialized !== null && typeof initialized !== 'boolean') {
    throw new TypeError(
      `detectHubMode: the facts source must report initialized as a boolean or null, got ${JSON.stringify(initialized)}.`,
    );
  }
  const engine = { reachable };
  if (detail !== undefined && detail !== null) engine.detail = String(detail);
  if (reason !== undefined && reason !== null) engine.reason = String(reason);
  if (!engine.reachable && engine.reason === undefined) engine.reason = 'unreachable (the facts source gave no reason)';
  return { engine, initialized: reachable ? initialized === true : null };
}

// --- detection ------------------------------------------------------------------------------------

// The single mode decision (plan decision 5). Read-only; never writes, never throws on a data
// problem. `facts` defaults to the live engine source, `fs` to node:fs, `rootDir` to the cwd —
// the CLI runs it exactly once per invocation and prose quotes the command output verbatim.
export async function detectHubMode(input = {}) {
  if (!isPlainObject(input)) {
    throw new TypeError('detectHubMode requires an input object.');
  }
  rejectUnknownKeys(input, DETECT_INPUT_KEYS, 'detectHubMode');
  // No private default (SC4, single-default authority): the caller names the project (the CLI's
  // D3 chain resolves it); a missing id is the same programmer error an invalid one always was.
  const projectId = input.projectId;
  if (!isValidProjectId(projectId)) {
    throw new TypeError(`detectHubMode requires a valid projectId, got ${JSON.stringify(input.projectId ?? null)}.`);
  }
  const factsProvider = input.facts ?? liveEngineFacts;
  if (typeof factsProvider !== 'function') {
    throw new TypeError('detectHubMode: facts must be a function of the projectId resolving to { reachable, initialized? }.');
  }
  const fs = input.fs ?? { existsSync: defaultExistsSync, lstatSync: defaultLstatSync };
  if (typeof fs?.existsSync !== 'function' || typeof fs?.lstatSync !== 'function') {
    throw new TypeError('detectHubMode: fs must expose existsSync(path) and lstatSync(path) functions.');
  }
  const rootDir = input.rootDir ?? process.cwd();
  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new TypeError(`detectHubMode: rootDir must be a non-empty directory path string, got ${JSON.stringify(input.rootDir ?? null)}.`);
  }

  let resolved;
  try {
    resolved = await factsProvider(projectId);
  } catch (error) {
    // A throwing facts source is an unreachable engine — evidence, never a crash.
    resolved = { reachable: false, initialized: null, reason: error?.message ?? String(error) };
  }
  const { engine, initialized } = normalizeEngineFacts(resolved);
  const legacyArea = legacyAreaPresent(rootDir, fs);
  const markdownHub = legacyArea && markdownHubPresent(rootDir, fs);

  const mode = legacyArea ? 'migrate' : (engine.reachable && initialized ? 'graph' : 'none');
  return { ok: true, mode, next: HUB_MODE_NEXT_STEPS[mode], evidence: { engine, initialized, legacyArea, markdownHub } };
}
