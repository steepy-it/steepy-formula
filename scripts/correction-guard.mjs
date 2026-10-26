#!/usr/bin/env node
// Correction guard: the durable, hash-chained persistence of a Gear-3 correction run and its lifecycle CLI.
//
// A run derives from its plan: `--plan .formula/work/plans/<name>.md` keeps its records under
// `.formula/work/tasks/<name>/correction/` as `record-1.json`, `record-2.json`, ... Each file holds one
// envelope `{ version: 1, seq, previous, actor: { drive, runId, attempt }, record: { kind, ...payload } }`
// serialized as `JSON.stringify(envelope) + '\n'`. `previous` is the SHA-256 of the previous record
// file's bytes (null for seq 1); `runId` and `attempt` are null on a manual drive. The head is found by
// reading the record names in order until the first absent one, and the one name after it is probed so a
// deleted middle record is caught; directories are never listed. Replay parses each record strictly (a
// duplicate JSON key is refused), validates the contiguous sequence, every `previous` digest, the closed
// envelope keys and the run's drive, then folds the records with the pure reducer in
// correction-state.mjs, passing each record's own `{ path, digest }`. Any replay failure is an integrity
// error.
//
// Every work-artifact read and write goes through work-paths.mjs. Records and artifacts are written
// create-only: a candidate record is applied to the replayed state before anything is written, so a
// refused transition writes nothing; a byte-identical existing file is a no-op and different bytes fail
// closed.
//
// Every mutating action replays the run, refuses an unopened or halted run, resolves its actor and then
// compares the observed source digest with the last recorded observation. A mismatch appends RUN_HALTED
// ('source drift outside an authorized writer dispatch') and fails as an integrity error. The one
// exemption is the window in which the open iteration's writer is authorized but not yet recorded, and
// only the action that records that writer may pass it. On an autopilot drive every mutating action
// carries a run id and attempt, bound to the implement phase manifest of that attempt; a manual drive
// refuses both, and reopening, a human grant, refuses them on every drive.
//
// The guard never runs a mutating git command and never writes source files. Data problems come back as
// `{ ok: false, code, message, identity }` with a CORRECTION_GUARD_CODES or reducer code; a TypeError is
// thrown only for a malformed call (an unknown input or seam key, a seam that is not a function).
//
// Usage: node scripts/correction-guard.mjs --repo-root <root> --plan <plan> --action <open|next|open-cycle|
// reserve|authorize|record-interruption|admit-retry|stop|reopen|project|verify> [options]; stdout carries
// exactly one JSON line.
//
// Exit codes:
//   0   success
//   1   refused transition or invalid input
//   2   usage error
//   3   integrity failure (run halted or evidence corrupt)
//   25  migrate refusal, checked before any output or write

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { planPhaseContext } from './autopilot-context.mjs';
import {
  CORRECTION_CODES,
  CORRECTION_RECORD_KINDS,
  applyCorrectionRecord,
  deriveCycleBindings,
  formatCorrectionSummaryBlock,
  nextCorrectionStep,
  parseCorrectionSummaryBlock,
  replayCorrectionRecords,
  summarizeCorrectionRun,
  validateRetryRequest,
} from './correction-state.mjs';
import { migrateRefusal } from './formula/core/markdown-hub.mjs';
import { observeSource } from './source-observation.mjs';
import { parseWorkPath, readWorkPath, writeWorkPath } from './work-paths.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export const CORRECTION_GUARD_CODES = deepFreeze({
  USAGE: 'USAGE',
  PLAN_INVALID: 'PLAN_INVALID',
  INPUT_INVALID: 'INPUT_INVALID',
  ACTOR_INVALID: 'ACTOR_INVALID',
  STEP_INVALID: 'STEP_INVALID',
  RUN_HALTED: CORRECTION_CODES.refusal.RUN_HALTED,
  INTEGRITY: CORRECTION_CODES.halt.INTEGRITY,
});

const CODES = CORRECTION_GUARD_CODES;
const REFUSAL = CORRECTION_CODES.refusal;
const KINDS = CORRECTION_RECORD_KINDS;
const ENVELOPE_KEYS = Object.freeze(['version', 'seq', 'previous', 'actor', 'record']);
const ACTOR_KEYS = Object.freeze(['drive', 'runId', 'attempt']);
const SEAM_KEYS = Object.freeze(['observe']);
const DRIVES = new Set(['manual', 'autopilot']);
const RUN_ID = /^[A-Za-z0-9-]+$/u;
const SCOPE = /^(?:task-[1-9]\d*|final)$/u;
const REOPEN_KEYS = Object.freeze(['version', 'scope', 'statement', 'remedy']);
const HEX64 = /^[0-9a-f]{64}$/u;
const PLANS_PREFIX = '.formula/work/plans/';
const DRIFT_REASON = 'source drift outside an authorized writer dispatch';
// The field of each record kind that carries the observed source digest; null for a kind that observes
// nothing. The last recorded observation is the drift guard's reference.
const OBSERVATION_FIELD = deepFreeze({
  [CORRECTION_RECORD_KINDS.RUN_OPENED]: 'observation',
  [CORRECTION_RECORD_KINDS.CYCLE_OPENED]: 'observation',
  [CORRECTION_RECORD_KINDS.ITERATION_RESERVED]: null,
  [CORRECTION_RECORD_KINDS.DISPATCH_AUTHORIZED]: 'observation',
  [CORRECTION_RECORD_KINDS.ITERATION_INTERRUPTED]: 'observation',
  [CORRECTION_RECORD_KINDS.RETRY_ADMITTED]: null,
  [CORRECTION_RECORD_KINDS.DIAGNOSIS_RECORDED]: 'after',
  [CORRECTION_RECORD_KINDS.CYCLE_STOPPED]: null,
  [CORRECTION_RECORD_KINDS.RUN_HALTED]: 'observation',
  [CORRECTION_RECORD_KINDS.WRITER_RECORDED]: 'observation',
  [CORRECTION_RECORD_KINDS.CHECKS_RECORDED]: 'observation',
  [CORRECTION_RECORD_KINDS.REVIEW_RECORDED]: 'after',
  [CORRECTION_RECORD_KINDS.ISOLATION_RECORDED]: 'observation',
  [CORRECTION_RECORD_KINDS.REOPEN_AUTHORIZED]: null,
});
// The leading lifecycle header of a plan, matched as task-results.mjs matches it; its status and
// consumed-by values change as the plan is consumed, so the plan digest normalizes exactly those two.
const PLAN_HEADER = /^((?:[ \t\r\n]*<!--(?!\s*steepy-workflow:)[\s\S]*?-->)*[ \t\r\n]*<!-- steepy-workflow: v1\r?\n)([\s\S]*?)(\r?\n-->)/u;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const serialize = (value) => `${JSON.stringify(value)}\n`;

// --- refusals -------------------------------------------------------------------------------------

// Thrown inside an action and caught at its public boundary, where it becomes the failure envelope; it
// never escapes this module.
class GuardRefusal {
  constructor(code, message, identity) {
    this.code = code;
    this.message = message;
    this.identity = identity;
  }
}

function refuse(code, message, identity = {}) {
  throw new GuardRefusal(code, message, identity);
}

function guarded(action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof GuardRefusal) {
      return { ok: false, code: error.code, message: error.message, identity: error.identity };
    }
    throw error;
  }
}

// --- programmer-error guards ----------------------------------------------------------------------

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function closed(value, accepted, label, name) {
  if (!isPlainObject(value)) throw new TypeError(`${label}: ${name} must be a plain object`);
  for (const key of Object.keys(value)) {
    if (!accepted.includes(key)) {
      throw new TypeError(`${label}: unknown ${name} key '${key}'; accepted keys: ${accepted.join(', ')}`);
    }
  }
  return value;
}

function callContext(label, root, input, seams, accepted) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError(`${label}: root must be a non-empty string`);
  closed(input, accepted, label, 'input');
  closed(seams, SEAM_KEYS, label, 'seam');
  const observe = seams.observe ?? observeSource;
  if (typeof observe !== 'function') throw new TypeError(`${label}: the observe seam must be a function`);
  return { paths: runPaths(input.plan), observe };
}

// --- strict JSON ----------------------------------------------------------------------------------

// JSON.parse keeps the last of duplicate keys, including escaped aliases; a record must carry one
// unambiguous value per key, so the text is walked once more to refuse a repeated key.
function strictJson(text) {
  const value = JSON.parse(text);
  let at = 0;
  const whitespace = () => { while (at < text.length && /\s/u.test(text[at])) at += 1; };
  const string = () => {
    const start = at;
    at += 1;
    while (at < text.length) {
      if (text[at] === '\\') at += 2;
      else if (text[at++] === '"') return JSON.parse(text.slice(start, at));
    }
    throw new Error('invalid JSON string');
  };
  const walk = () => {
    whitespace();
    if (text[at] === '"') { string(); return; }
    if (text[at] === '{') {
      at += 1;
      whitespace();
      const found = new Set();
      while (text[at] !== '}') {
        whitespace();
        const key = string();
        if (found.has(key)) throw new Error(`duplicate JSON key '${key}'`);
        found.add(key);
        whitespace();
        at += 1;
        walk();
        whitespace();
        if (text[at] !== ',') break;
        at += 1;
      }
      at += 1;
      return;
    }
    if (text[at] === '[') {
      at += 1;
      whitespace();
      while (text[at] !== ']') {
        walk();
        whitespace();
        if (text[at] !== ',') break;
        at += 1;
      }
      at += 1;
      return;
    }
    while (at < text.length && !/[\s,}\]]/u.test(text[at])) at += 1;
  };
  walk();
  return value;
}

// --- paths ----------------------------------------------------------------------------------------

function runPaths(plan) {
  try {
    parseWorkPath(plan, 'work-output', 'plan');
  } catch (error) {
    refuse(CODES.PLAN_INVALID, `the plan must be ${PLANS_PREFIX}<name>.md: ${error.message}`, { plan: String(plan) });
  }
  const name = plan.slice(PLANS_PREFIX.length, -'.md'.length);
  const run = `.formula/work/tasks/${name}`;
  const dir = `${run}/correction`;
  return {
    plan,
    run,
    dir,
    record: (seq) => `${dir}/record-${seq}.json`,
    baseline: (scope, cycle) => `${dir}/${scope}-cycle-${cycle}-baseline.json`,
    manifest: (attempt) => `${run}/context/phase-implement-attempt-${attempt}.json`,
    index: `${run}/task-result-index.md`,
  };
}

const MISSING = (path) => [
  `work path: missing work artifact '${path}'`,
  `work path: missing ancestor directory for '${path}':`,
];

// The bytes at `path`, or null when it or an ancestor directory is absent; any other read failure (a
// symlink, a hard link, a non-file) propagates.
function readOptional(root, path) {
  try {
    return readWorkPath(root, path);
  } catch (error) {
    const [artifact, ancestor] = MISSING(path);
    if (error.message === artifact || error.message.startsWith(ancestor)) return null;
    throw error;
  }
}

// Durable evidence: an unreadable record or artifact is an integrity failure.
function readEvidence(root, path) {
  try {
    return readOptional(root, path);
  } catch (error) {
    return refuse(CODES.INTEGRITY, `cannot read ${path}: ${error.message}`, { path });
  }
}

// Writes `bytes` create-only. A byte-identical existing file is a no-op; different bytes fail closed.
function writeEvidence(root, path, bytes) {
  const existing = readEvidence(root, path);
  if (existing !== null) {
    if (existing.equals(bytes)) return false;
    refuse(CODES.INTEGRITY, `${path} already exists with different bytes`, { path });
  }
  try {
    writeWorkPath(root, path, bytes, { createOnly: true });
  } catch (error) {
    const raced = readEvidence(root, path);
    if (raced !== null && raced.equals(bytes)) return false;
    refuse(CODES.INTEGRITY, `cannot write ${path}: ${error.message}`, { path });
  }
  return true;
}

// --- replay ---------------------------------------------------------------------------------------

function isActor(actor) {
  if (!isPlainObject(actor) || !hasExactKeys(actor, ACTOR_KEYS)) return false;
  const { drive, runId, attempt } = actor;
  if (drive === 'manual') return runId === null && attempt === null;
  return drive === 'autopilot' && typeof runId === 'string' && RUN_ID.test(runId)
    && Number.isSafeInteger(attempt) && attempt >= 1;
}

function parseEnvelope(bytes, path, seq, previous) {
  const fail = (message) => refuse(CODES.INTEGRITY, `${path} ${message}`, { record: seq, path });
  let envelope;
  try {
    envelope = strictJson(bytes.toString('utf8'));
  } catch (error) {
    fail(`is not strict JSON (${error.message})`);
  }
  if (!isPlainObject(envelope) || !hasExactKeys(envelope, ENVELOPE_KEYS)) {
    fail(`must be an envelope with exactly the keys: ${ENVELOPE_KEYS.join(', ')}`);
  }
  if (!Buffer.from(serialize(envelope)).equals(bytes)) fail('is not the canonical serialization of its envelope');
  if (envelope.version !== 1) fail('must have version 1');
  if (envelope.seq !== seq) fail(`must have seq ${seq}`);
  if (envelope.previous !== previous) {
    fail(seq === 1 ? 'must have a null previous digest' : `previous digest does not match record-${seq - 1}`);
  }
  if (!isActor(envelope.actor)) {
    fail('must carry an actor { drive, runId, attempt }: null ids on a manual drive, a run id and attempt '
      + 'on autopilot');
  }
  if (!isPlainObject(envelope.record)) fail('must carry a record object');
  return envelope;
}

// Replays the run: `{ state, head, envelopes, refs }`. Refuses INTEGRITY on any failure.
function load(root, paths) {
  const envelopes = [];
  const refs = [];
  let previous = null;
  for (let seq = 1; ; seq += 1) {
    const path = paths.record(seq);
    const bytes = readEvidence(root, path);
    if (bytes === null) break;
    envelopes.push(parseEnvelope(bytes, path, seq, previous));
    previous = sha256(bytes);
    refs.push({ path, digest: previous });
  }
  // One exact name past the first absent record: a record there means a middle record was deleted.
  const gap = paths.record(envelopes.length + 1);
  const beyond = paths.record(envelopes.length + 2);
  if (readEvidence(root, beyond) !== null) {
    refuse(CODES.INTEGRITY, `${gap} is missing before ${beyond}`, { record: envelopes.length + 1, path: gap });
  }
  if (envelopes.length > 0) {
    const [first] = envelopes;
    if (first.record.kind !== KINDS.RUN_OPENED) {
      refuse(CODES.INTEGRITY, `${refs[0].path} must open the run`, { record: 1, path: refs[0].path });
    }
    const mismatch = envelopes.findIndex((envelope) => envelope.actor.drive !== first.record.drive);
    if (mismatch !== -1) {
      refuse(CODES.INTEGRITY, `${refs[mismatch].path} actor drive differs from the run drive '${first.record.drive}'`,
        { record: mismatch + 1, path: refs[mismatch].path });
    }
  }
  const replayed = replayCorrectionRecords(envelopes.map((envelope) => envelope.record), { refs });
  if (!replayed.ok) {
    const { record } = replayed.identity;
    refuse(CODES.INTEGRITY, `${refs[record - 1].path} does not replay: ${replayed.message}`,
      { record, path: refs[record - 1].path, cause: replayed.code });
  }
  return {
    state: replayed.state,
    head: { seq: envelopes.length, digest: previous },
    envelopes,
    refs,
  };
}

// --- append ---------------------------------------------------------------------------------------

// Builds the next envelope for `record` and applies it to the replayed state; nothing is written. A
// refusal passes through with the reducer's code.
function stage(loaded, actor, record, paths) {
  const seq = loaded.head.seq + 1;
  const path = paths.record(seq);
  const bytes = Buffer.from(serialize({ version: 1, seq, previous: loaded.head.digest, actor, record }));
  const ref = { path, digest: sha256(bytes) };
  const applied = applyCorrectionRecord(loaded.state, record, { ref });
  if (!applied.ok) refuse(applied.code, applied.message, applied.identity);
  return { bytes, ref, state: applied.state, head: { seq, digest: ref.digest } };
}

function commit(root, staged) {
  writeEvidence(root, staged.ref.path, staged.bytes);
  return staged;
}

function mutation(action, staged) {
  return {
    ok: true,
    action,
    appended: true,
    head: staged.head,
    ref: staged.ref,
    next: nextCorrectionStep(staged.state),
  };
}

// --- plan -----------------------------------------------------------------------------------------

function planDigest(text) {
  const header = PLAN_HEADER.exec(text);
  if (header === null) return sha256(text);
  const fields = header[2].replace(/^status: (READY|CONSUMED)(?=\r?$)/mu, 'status: <lifecycle>')
    .replace(/^consumed-by: [^\r\n]+(?=\r?$)/mu, 'consumed-by: <lifecycle>');
  return sha256(header[1] + fields + header[3] + text.slice(header[0].length));
}

function readPlan(root, paths) {
  let text;
  try {
    text = readWorkPath(root, paths.plan, { encoding: 'utf8' });
  } catch (error) {
    refuse(CODES.PLAN_INVALID, `cannot read the plan: ${error.message}`, { plan: paths.plan });
  }
  let context;
  try {
    context = planPhaseContext(text);
  } catch (error) {
    refuse(CODES.PLAN_INVALID, error.message, { plan: paths.plan });
  }
  const untested = context.tasks.find((task) => task.testCommand === undefined);
  if (untested !== undefined) {
    refuse(CODES.PLAN_INVALID, `Task ${untested.task} is missing its Test command`,
      { plan: paths.plan, task: untested.task });
  }
  return {
    planDigest: planDigest(text),
    tasks: context.tasks.map(({ task, dependencies, complexity, criterionIds, testCommand }) => ({
      task, dependencies, complexity, criterionIds, testCommand,
    })),
  };
}

// Structural equality of JSON values: array order matters, object key order does not.
function sameValue(left, right) {
  if (left === right) return true;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const keys = Object.keys(left);
  return hasExactKeys(right, keys) && keys.every((key) => sameValue(left[key], right[key]));
}

// --- observation ----------------------------------------------------------------------------------

function observeRoot(observe, root) {
  let observation;
  try {
    observation = observe(root);
  } catch (error) {
    refuse(CODES.INTEGRITY, `cannot observe the source: ${error.message}`, {});
  }
  if (!isPlainObject(observation) || typeof observation.digest !== 'string' || !HEX64.test(observation.digest)) {
    throw new TypeError('the observe seam must return a source observation with a 64-hex digest');
  }
  return observation;
}

// --- drift guard ----------------------------------------------------------------------------------

// The last recorded observation and the record that carries it, or null before the run is opened.
function lastObservation(loaded) {
  for (let index = loaded.envelopes.length - 1; index >= 0; index -= 1) {
    const { record } = loaded.envelopes[index];
    const field = OBSERVATION_FIELD[record.kind];
    if (field !== null) return { digest: record[field], ref: loaded.refs[index] };
  }
  return null;
}

// Whether the open iteration's writer is authorized and not yet recorded: the one window in which the
// source may legitimately change, and only for the action that records that writer.
function writerWindowOpen(state) {
  const step = nextCorrectionStep(state);
  return step?.action === 'record' && step.role === 'writer';
}

// The drift of `observation` from the last recorded one: null when they agree, or when the authorized
// writer window is passed and open.
function driftOf(loaded, observation, authorizedWriterWindow) {
  const last = lastObservation(loaded);
  if (last === null || observation.digest === last.digest) return null;
  if (authorizedWriterWindow && writerWindowOpen(loaded.state)) return null;
  return { expected: last.digest, observed: observation.digest, evidence: last.ref };
}

// The failure envelope of a halted run.
function halted(state) {
  return { ok: false, code: CODES.RUN_HALTED, message: `the run is halted: ${state.halted.reason}`, identity: {} };
}

// --- actor ----------------------------------------------------------------------------------------

const isSupplied = (value) => value !== undefined && value !== null;

// The actor of a mutating action. A manual drive refuses a run id or attempt. An autopilot drive
// requires both, bound to the implement phase manifest of that attempt: its run id and attempt, the
// implement phase and role, and task result protocol 2.
function resolveActor(root, paths, drive, { runId, attempt }) {
  if (drive === 'manual') {
    if (isSupplied(runId) || isSupplied(attempt)) {
      refuse(CODES.ACTOR_INVALID, 'a manual drive takes no run id or attempt', { drive });
    }
    return { drive, runId: null, attempt: null };
  }
  if (!isSupplied(runId) || !isSupplied(attempt)) {
    refuse(CODES.ACTOR_INVALID, 'an autopilot drive requires a run id and an attempt', { drive });
  }
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || !Number.isSafeInteger(attempt) || attempt < 1) {
    refuse(CODES.ACTOR_INVALID, 'the run id must be letters, digits and hyphens and the attempt a positive integer',
      { drive });
  }
  const path = paths.manifest(attempt);
  const identity = { drive, runId, attempt, manifest: path };
  let bytes;
  try {
    bytes = readOptional(root, path);
  } catch (error) {
    refuse(CODES.ACTOR_INVALID, `cannot read the phase manifest: ${error.message}`, identity);
  }
  if (bytes === null) refuse(CODES.ACTOR_INVALID, `the phase manifest ${path} is missing`, identity);
  let manifest;
  try {
    manifest = strictJson(bytes.toString('utf8'));
  } catch (error) {
    refuse(CODES.ACTOR_INVALID, `the phase manifest is not strict JSON (${error.message})`, identity);
  }
  if (manifest?.runId !== runId || manifest.attempt !== attempt || manifest.scope?.phase !== 'implement'
    || manifest.scope?.role !== 'implement') {
    refuse(CODES.ACTOR_INVALID, 'the phase manifest does not correlate with this run id and attempt', identity);
  }
  if (manifest.contract?.taskResultProtocol !== 2) {
    refuse(CODES.ACTOR_INVALID, 'the phase manifest does not use task result protocol 2', identity);
  }
  return { drive, runId, attempt };
}

// --- mutation preparation -------------------------------------------------------------------------

// Every mutating action replays the run, refuses an unopened or halted one, and compares the observed
// source with the last recorded observation; a drift appends RUN_HALTED and fails as an integrity
// error. `drive` is the drive a not-yet-opened run is opened with; `authorizedWriterWindow` is passed
// only by the action that records the authorized writer.
function prepare(root, paths, observe, input, { drive = null, authorizedWriterWindow = false } = {}) {
  const loaded = load(root, paths);
  const { run } = loaded.state;
  if (run === null && drive === null) refuse(REFUSAL.RUN_NOT_OPEN, 'the correction run was never opened', {});
  if (loaded.state.halted !== null) {
    const { code, message } = halted(loaded.state);
    refuse(code, message, { head: loaded.head });
  }
  const actor = resolveActor(root, paths, run?.drive ?? drive, input);
  const observation = observeRoot(observe, root);
  const drift = driftOf(loaded, observation, authorizedWriterWindow);
  if (drift !== null) {
    const halt = commit(root, stage(loaded, actor, {
      kind: KINDS.RUN_HALTED, reason: DRIFT_REASON, evidence: [drift.evidence], observation: drift.observed,
    }, paths));
    refuse(CODES.INTEGRITY, DRIFT_REASON, { expected: drift.expected, observed: drift.observed, halt: halt.ref });
  }
  return { loaded, actor, observation };
}

function latestCycle(state, scope) {
  const key = state.cycleOrder.findLast((entry) => state.cycles[entry].scope === scope);
  return key === undefined ? null : state.cycles[key];
}

// The number of the latest cycle of `scope`, or 1 when the scope never opened one; the reducer refuses
// a record naming a cycle that is not open.
function cycleOf(state, scope) {
  return latestCycle(state, scope)?.cycle ?? 1;
}

// The bytes of an input artifact named by its exact path: a file of `family` in this run's correction
// directory. Never a directory listing.
function readInputArtifact(root, paths, path, family) {
  try {
    parseWorkPath(path, 'work-output', family);
  } catch (error) {
    refuse(CODES.INPUT_INVALID, `expected a ${family} path: ${error.message}`, { path: String(path) });
  }
  if (!path.startsWith(`${paths.dir}/`)) {
    refuse(CODES.INPUT_INVALID, `${path} is not in this run's correction directory ${paths.dir}`, { path });
  }
  let bytes;
  try {
    bytes = readOptional(root, path);
  } catch (error) {
    refuse(CODES.INPUT_INVALID, `cannot read ${path}: ${error.message}`, { path });
  }
  if (bytes === null) refuse(CODES.INPUT_INVALID, `${path} is missing`, { path });
  return bytes;
}

const fileName = (path) => path.slice(path.lastIndexOf('/') + 1);

// The plan tasks, in plan order, whose task scope has an approved cycle.
function deliveredTasks(state) {
  const approved = new Set(Object.values(state.cycles)
    .filter((entry) => entry.status === 'APPROVED').map((entry) => entry.scope));
  return state.run.tasks.filter((entry) => approved.has(`task-${entry.task}`));
}

function describeStep(step) {
  return [step.action, step.scope, step.cycle === undefined ? null : `cycle ${step.cycle}`]
    .filter((part) => part !== null && part !== undefined).join(' ');
}

// --- actions --------------------------------------------------------------------------------------

const HEAD_KEYS = Object.freeze(['plan']);
const DRIFT_KEYS = Object.freeze(['plan', 'authorizedWriterWindow']);
const OPEN_KEYS = Object.freeze(['plan', 'drive', 'runId', 'attempt']);
const ACTOR_INPUT = Object.freeze(['runId', 'attempt']);
const CYCLE_KEYS = Object.freeze(['plan', 'scope', 'rubricCriteria', 'reviewOptIn', ...ACTOR_INPUT]);
const RESERVE_KEYS = Object.freeze(['plan', 'scope', 'iteration', 'kind', 'reason', ...ACTOR_INPUT]);
const AUTHORIZE_KEYS = Object.freeze([
  'plan', 'scope', 'iteration', 'role', 'target', 'ownerTask', 'affectedCriteria', ...ACTOR_INPUT,
]);
const INTERRUPTION_KEYS = Object.freeze(['plan', 'scope', 'iteration', 'reason', ...ACTOR_INPUT]);
const RETRY_KEYS = Object.freeze(['plan', 'request', ...ACTOR_INPUT]);
const STOP_KEYS = Object.freeze(['plan', 'scope', 'reason', 'note', ...ACTOR_INPUT]);
const REOPEN_INPUT_KEYS = Object.freeze(['plan', 'authorization', ...ACTOR_INPUT]);
const PROJECT_KEYS = Object.freeze(['plan', 'taskResultIndex', ...ACTOR_INPUT]);

// Runs an exported action: the call contract, which throws a TypeError for a malformed call, then
// `build(context)`, both behind the refusal boundary.
function act(label, root, input, seams, accepted, build) {
  return guarded(() => build(callContext(label, root, input, seams, accepted)));
}

// Prepares the mutation and appends the record `build` derives from the replayed state and observation.
function appendRecord(action, root, paths, observe, input, build) {
  const { loaded, actor, observation } = prepare(root, paths, observe, input);
  const record = build({ state: loaded.state, observation });
  return mutation(action, commit(root, stage(loaded, actor, record, paths)));
}

export function readCorrectionHead(root, input, seams = {}) {
  return act('readCorrectionHead', root, input, seams, HEAD_KEYS, ({ paths }) => {
    const { head } = load(root, paths);
    return { ok: true, seq: head.seq, digest: head.digest };
  });
}

// Opens the run from its plan, refusing an unparseable plan or a task without a Test command before any
// write. Repeating it with an identical payload is a no-op; a different payload is refused.
export function openCorrectionRun(root, input, seams = {}) {
  return act('openCorrectionRun', root, input, seams, OPEN_KEYS, ({ paths, observe }) => {
    const { drive } = input;
    if (!DRIVES.has(drive)) {
      refuse(CODES.INPUT_INVALID, `drive must be one of: ${[...DRIVES].join(', ')}`, { drive: String(drive) });
    }
    const plan = readPlan(root, paths);
    const { loaded, actor, observation } = prepare(root, paths, observe, input, { drive });
    const record = {
      kind: KINDS.RUN_OPENED,
      planDigest: plan.planDigest,
      drive,
      tasks: plan.tasks,
      observation: observation.digest,
    };
    if (loaded.state.run !== null) {
      if (!sameValue(loaded.envelopes[0].record, record)) {
        refuse(REFUSAL.RECORD_ORDER, 'the run is already open with a different payload', { record: 1 });
      }
      return {
        ok: true, action: 'open', appended: false, head: loaded.head, ref: loaded.refs[0],
        next: nextCorrectionStep(loaded.state),
      };
    }
    return mutation('open', commit(root, stage(loaded, actor, record, paths)));
  });
}

// Read-only: the head and the run's next step. A halted run is reported as a failure carrying both.
export function nextCorrectionAction(root, input, seams = {}) {
  return act('nextCorrectionAction', root, input, seams, HEAD_KEYS, ({ paths }) => {
    const { state, head } = load(root, paths);
    const next = nextCorrectionStep(state);
    if (state.halted !== null) return { ...halted(state), head, next };
    return { ok: true, head, next };
  });
}

// The drift check alone, read-only: `{ ok: true, observation, window }`, or the drift as an integrity
// failure without halting the run. `authorizedWriterWindow` exempts the source change of an authorized,
// not yet recorded writer; `window` reports whether that exemption was open.
export function checkCorrectionDrift(root, input, seams = {}) {
  return act('checkCorrectionDrift', root, input, seams, DRIFT_KEYS, ({ paths, observe }) => {
    const { authorizedWriterWindow = false } = input;
    if (typeof authorizedWriterWindow !== 'boolean') {
      throw new TypeError('checkCorrectionDrift: authorizedWriterWindow must be a boolean');
    }
    const loaded = load(root, paths);
    if (loaded.state.run === null) refuse(REFUSAL.RUN_NOT_OPEN, 'the correction run was never opened', {});
    const observation = observeRoot(observe, root);
    const drift = driftOf(loaded, observation, authorizedWriterWindow);
    if (drift !== null) refuse(CODES.INTEGRITY, DRIFT_REASON, { expected: drift.expected, observed: drift.observed });
    const window = authorizedWriterWindow && writerWindowOpen(loaded.state);
    return { ok: true, observation: observation.digest, window };
  });
}

export function openCorrectionCycle(root, input, seams = {}) {
  return act('openCorrectionCycle', root, input, seams, CYCLE_KEYS, ({ paths, observe }) => {
    const { scope, rubricCriteria = [], reviewOptIn = false } = input;
    const { loaded, actor, observation } = prepare(root, paths, observe, input);
    const { state } = loaded;
    const step = nextCorrectionStep(state);
    if (step.action === 'prove-isolation') {
      refuse(REFUSAL.ISOLATION_REQUIRED, `cycle ${step.scope}#${step.cycle} stopped; its isolation must be proven `
        + 'before any cycle opens', { scope: String(scope) });
    }
    if (step.action !== 'open-cycle' || step.scope !== scope) {
      refuse(REFUSAL.SCOPE_NOT_RUNNABLE, `scope '${String(scope)}' is not the next to open; the next step is `
        + `${describeStep(step)}`, { scope: String(scope) });
    }
    const final = scope === 'final';
    let derived;
    try {
      derived = deriveCycleBindings({
        scope,
        task: final ? null : state.run.tasks.find((entry) => `task-${entry.task}` === scope),
        deliveredTasks: final ? deliveredTasks(state) : null,
        rubricCriteria,
        reviewOptIn,
      });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      refuse(CODES.INPUT_INVALID, error.message, { scope });
    }
    const cycle = step.cycle ?? 1;
    const record = {
      kind: KINDS.CYCLE_OPENED,
      scope,
      cycle,
      predecessor: step.predecessor ?? null,
      checks: derived.checks,
      bindings: derived.bindings,
      rubricCriteria,
      review: derived.review,
      observation: observation.digest,
    };
    // The record is validated before the baseline is written, so a refused cycle leaves no baseline.
    const staged = stage(loaded, actor, record, paths);
    const path = paths.baseline(scope, cycle);
    const bytes = Buffer.from(serialize({ version: 1, observation }));
    writeEvidence(root, path, bytes);
    return { ...mutation('open-cycle', commit(root, staged)), baseline: { path, digest: sha256(bytes) } };
  });
}

export function reserveCorrectionIteration(root, input, seams = {}) {
  return act('reserveCorrectionIteration', root, input, seams, RESERVE_KEYS, ({ paths, observe }) =>
    appendRecord('reserve', root, paths, observe, input, ({ state }) => ({
      kind: KINDS.ITERATION_RESERVED,
      scope: input.scope,
      cycle: cycleOf(state, input.scope),
      iteration: input.iteration,
      iterationKind: input.kind,
      reason: input.reason ?? null,
    })));
}

export function authorizeCorrectionDispatch(root, input, seams = {}) {
  return act('authorizeCorrectionDispatch', root, input, seams, AUTHORIZE_KEYS, ({ paths, observe }) =>
    appendRecord('authorize', root, paths, observe, input, ({ state, observation }) => ({
      kind: KINDS.DISPATCH_AUTHORIZED,
      scope: input.scope,
      cycle: cycleOf(state, input.scope),
      iteration: input.iteration,
      role: input.role,
      target: input.target,
      ownerTask: input.ownerTask ?? null,
      affectedCriteria: input.affectedCriteria ?? [],
      observation: observation.digest,
    })));
}

// The interruption's evidence is its own record: the result's `ref` is the reference a later retry
// request cites.
export function recordCorrectionInterruption(root, input, seams = {}) {
  return act('recordCorrectionInterruption', root, input, seams, INTERRUPTION_KEYS, ({ paths, observe }) =>
    appendRecord('record-interruption', root, paths, observe, input, ({ state, observation }) => ({
      kind: KINDS.ITERATION_INTERRUPTED,
      scope: input.scope,
      cycle: cycleOf(state, input.scope),
      iteration: input.iteration,
      reason: input.reason,
      observation: observation.digest,
    })));
}

// Admits the retry request at its exact `correction-retry` path: strict JSON, validated against the
// replayed state and named for its own scope and cycle, recorded with the SHA-256 of its bytes.
export function admitCorrectionRetry(root, input, seams = {}) {
  return act('admitCorrectionRetry', root, input, seams, RETRY_KEYS, ({ paths, observe }) => {
    const { loaded, actor } = prepare(root, paths, observe, input);
    const path = input.request;
    const bytes = readInputArtifact(root, paths, path, 'correction-retry');
    let request;
    try {
      request = strictJson(bytes.toString('utf8'));
    } catch (error) {
      refuse(REFUSAL.RETRY_INVALID, `the retry request is not strict JSON (${error.message})`, { path });
    }
    const checked = validateRetryRequest(loaded.state, request);
    if (!checked.ok) refuse(checked.code, checked.message, checked.identity);
    if (!fileName(path).startsWith(`${request.scope}-cycle-${request.cycle}-retry-`)) {
      refuse(REFUSAL.RETRY_INVALID, `${path} is not named for ${request.scope} cycle ${request.cycle}`, { path });
    }
    const record = {
      kind: KINDS.RETRY_ADMITTED,
      scope: request.scope,
      cycle: request.cycle,
      iteration: request.iteration,
      request,
      requestDigest: sha256(bytes),
    };
    return mutation('admit-retry', commit(root, stage(loaded, actor, record, paths)));
  });
}

export function stopCorrectionCycle(root, input, seams = {}) {
  return act('stopCorrectionCycle', root, input, seams, STOP_KEYS, ({ paths, observe }) =>
    appendRecord('stop', root, paths, observe, input, ({ state }) => ({
      kind: KINDS.CYCLE_STOPPED,
      scope: input.scope,
      cycle: cycleOf(state, input.scope),
      reason: input.reason,
      note: input.note,
    })));
}

// Reopening is a human grant: a run id or attempt is refused, so autopilot can never reopen a scope.
// The authorization at its exact `correction-reopen` path holds `{ version: 1, scope, statement,
// remedy }`; it opens the cycle after the scope's latest one, linked to it.
export function reopenCorrectionScope(root, input, seams = {}) {
  return act('reopenCorrectionScope', root, input, seams, REOPEN_INPUT_KEYS, ({ paths, observe }) => {
    if (isSupplied(input.runId) || isSupplied(input.attempt)) {
      refuse(CODES.ACTOR_INVALID, 'autopilot cannot grant reopening; a reopen takes no run id or attempt', {});
    }
    const { loaded, actor } = prepare(root, paths, observe, input);
    const path = input.authorization;
    const bytes = readInputArtifact(root, paths, path, 'correction-reopen');
    const invalid = (message) => refuse(REFUSAL.REOPEN_INVALID, message, { path });
    let body;
    try {
      body = strictJson(bytes.toString('utf8'));
    } catch (error) {
      invalid(`the reopen authorization is not strict JSON (${error.message})`);
    }
    if (!isPlainObject(body) || !hasExactKeys(body, REOPEN_KEYS) || body.version !== 1) {
      invalid(`the reopen authorization must be { version: 1, scope, statement, remedy }`);
    }
    const { scope, statement, remedy } = body;
    if (typeof scope !== 'string' || !SCOPE.test(scope)) invalid("the reopen scope must be 'task-<N>' or 'final'");
    if (!fileName(path).startsWith(`${scope}-cycle-`)) invalid(`${path} is not named for ${scope}`);
    const latest = latestCycle(loaded.state, scope);
    if (latest === null) invalid(`only a stopped scope is reopened; '${scope}' never ran`);
    const record = {
      kind: KINDS.REOPEN_AUTHORIZED,
      scope,
      cycle: latest.cycle + 1,
      predecessor: `${scope}#${latest.cycle}`,
      authorization: { path, digest: sha256(bytes) },
      statement,
      remedy,
    };
    return mutation('reopen', commit(root, stage(loaded, actor, record, paths)));
  });
}

// `text` with its correction summary block replaced by `block`, or with `block` appended after a
// separating newline; every other byte is kept.
function withSummaryBlock(text, block, path) {
  let existing;
  try {
    existing = parseCorrectionSummaryBlock(text);
  } catch (error) {
    refuse(CODES.INTEGRITY, `${path} carries a malformed correction summary block: ${error.message}`, { path });
  }
  if (existing === null) return text === '' ? `${block}\n` : `${text}\n${block}\n`;
  const open = block.slice(0, block.indexOf('\n'));
  const close = block.slice(block.lastIndexOf('\n') + 1);
  const start = text.indexOf(open);
  const end = text.indexOf(close, start);
  if (start === -1 || end === -1) {
    refuse(CODES.INTEGRITY, `${path} carries a correction summary block with foreign markers`, { path });
  }
  return text.slice(0, start) + block + text.slice(end + close.length);
}

// Projects the run summary into the task result index, only once the next step concerns the final
// cycle or the run is terminal. Manual task bullets, the v2 receipt block and every other byte stay.
export function projectCorrectionSummary(root, input, seams = {}) {
  return act('projectCorrectionSummary', root, input, seams, PROJECT_KEYS, ({ paths, observe }) => {
    if (input.taskResultIndex !== paths.index) {
      refuse(CODES.INPUT_INVALID, `taskResultIndex must be this run's index ${paths.index}`,
        { taskResultIndex: String(input.taskResultIndex) });
    }
    const { loaded } = prepare(root, paths, observe, input);
    const { state, head } = loaded;
    const next = nextCorrectionStep(state);
    if (next.action !== 'terminal' && next.scope !== 'final') {
      refuse(CODES.STEP_INVALID, `the summary is projected at a final-cycle step or terminal; the next step is `
        + `${describeStep(next)}`, {});
    }
    const summary = summarizeCorrectionRun(state);
    const before = readEvidence(root, paths.index) ?? Buffer.alloc(0);
    const text = before.toString('utf8');
    if (!Buffer.from(text).equals(before)) {
      refuse(CODES.INTEGRITY, `${paths.index} is not valid UTF-8`, { path: paths.index });
    }
    let block;
    try {
      block = formatCorrectionSummaryBlock(summary);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      refuse(CODES.INPUT_INVALID, `the summary cannot be projected: ${error.message}`, {});
    }
    const after = withSummaryBlock(text, block, paths.index);
    const changed = after !== text;
    if (changed) {
      try {
        writeWorkPath(root, paths.index, after);
      } catch (error) {
        refuse(CODES.INTEGRITY, `cannot write ${paths.index}: ${error.message}`, { path: paths.index });
      }
    }
    return { ok: true, action: 'project', changed, taskResultIndex: paths.index, head, summary, next };
  });
}

// Read-only full replay plus the drift check: `{ ok, head, next, summary }`. A halted run or a drift is
// reported as a failure carrying the same report; no record is ever written.
export function verifyCorrectionRun(root, input, seams = {}) {
  return act('verifyCorrectionRun', root, input, seams, HEAD_KEYS, ({ paths, observe }) => {
    const loaded = load(root, paths);
    const { state, head } = loaded;
    if (state.run === null) refuse(REFUSAL.RUN_NOT_OPEN, 'the correction run was never opened', {});
    const report = { head, next: nextCorrectionStep(state), summary: summarizeCorrectionRun(state) };
    if (state.halted !== null) return { ...halted(state), ...report };
    const drift = driftOf(loaded, observeRoot(observe, root), false);
    if (drift !== null) {
      const identity = { expected: drift.expected, observed: drift.observed };
      return { ok: false, code: CODES.INTEGRITY, message: DRIFT_REASON, identity, ...report };
    }
    return { ok: true, ...report };
  });
}

// --- CLI ------------------------------------------------------------------------------------------

const USAGE = `usage: node scripts/correction-guard.mjs --repo-root <root> --plan .formula/work/plans/<name>.md
         --action <action> [options]

actions:
  open                 --drive manual|autopilot
  next
  open-cycle           --scope <task-N|final> [--rubric-criteria SC1,SC2] [--review-opt-in]
  reserve              --scope <scope> --iteration <n> --kind initial|correction|diagnosis
                       [--reason missing-retry-evidence|comparison-unavailable]
  authorize            --scope <scope> --iteration <n> --role <role> --target <target>
                       [--owner-task <n>] [--affected-criteria SC1,SC2]
  record-interruption  --scope <scope> --iteration <n> --reason <text>
  admit-retry          --request <the exact correction-retry path>
  stop                 --scope <scope> --reason RETRY_EVIDENCE_MISSING|HUMAN_INTERRUPTED --note <text>
  reopen               --authorization <the exact correction-reopen path>
  project              --task-result-index <the run's task-result-index.md>
  verify

Every mutating action (all but next and verify) takes --run-id <id> --attempt <n> on an autopilot drive
and refuses them on a manual drive; reopen refuses them on every drive.
Stdout carries exactly one JSON line.

Exit codes:
  0   success
  1   refused transition or invalid input
  2   usage error
  3   integrity failure (run halted or evidence corrupt)
  25  migrate refusal, checked before any output or write
`;

const STRING = { type: 'string' };
const CLI_OPTIONS = Object.freeze({
  'repo-root': STRING,
  plan: STRING,
  action: STRING,
  drive: STRING,
  scope: STRING,
  iteration: STRING,
  kind: STRING,
  reason: STRING,
  note: STRING,
  role: STRING,
  target: STRING,
  'owner-task': STRING,
  'affected-criteria': STRING,
  request: STRING,
  authorization: STRING,
  'task-result-index': STRING,
  'rubric-criteria': STRING,
  'review-opt-in': { type: 'boolean' },
  'run-id': STRING,
  attempt: STRING,
});
const ACTOR_OPTIONS = Object.freeze(['run-id', 'attempt']);
const INTEGER_OPTIONS = new Set(['iteration', 'attempt']);
const LIST_OPTIONS = new Set(['affected-criteria', 'rubric-criteria']);
const CLI_ACTIONS = Object.freeze({
  open: { run: openCorrectionRun, required: ['drive'], optional: ACTOR_OPTIONS },
  next: { run: nextCorrectionAction, required: [], optional: [] },
  'open-cycle': {
    run: openCorrectionCycle, required: ['scope'], optional: ['rubric-criteria', 'review-opt-in', ...ACTOR_OPTIONS],
  },
  reserve: {
    run: reserveCorrectionIteration, required: ['scope', 'iteration', 'kind'], optional: ['reason', ...ACTOR_OPTIONS],
  },
  authorize: {
    run: authorizeCorrectionDispatch,
    required: ['scope', 'iteration', 'role', 'target'],
    optional: ['owner-task', 'affected-criteria', ...ACTOR_OPTIONS],
  },
  'record-interruption': {
    run: recordCorrectionInterruption, required: ['scope', 'iteration', 'reason'], optional: ACTOR_OPTIONS,
  },
  'admit-retry': { run: admitCorrectionRetry, required: ['request'], optional: ACTOR_OPTIONS },
  stop: { run: stopCorrectionCycle, required: ['scope', 'reason', 'note'], optional: ACTOR_OPTIONS },
  reopen: { run: reopenCorrectionScope, required: ['authorization'], optional: ACTOR_OPTIONS },
  project: { run: projectCorrectionSummary, required: ['task-result-index'], optional: ACTOR_OPTIONS },
  verify: { run: verifyCorrectionRun, required: [], optional: [] },
});
const IO_KEYS = Object.freeze(['stdout', 'stderr']);

class UsageError {
  constructor(message) {
    this.message = message;
  }
}

function usage(message) {
  throw new UsageError(message);
}

const camelCase = (name) => name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());

function optionValue(name, value) {
  if (INTEGER_OPTIONS.has(name)) {
    if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
      usage(`--${name} must be a positive integer`);
    }
    return Number(value);
  }
  if (LIST_OPTIONS.has(name)) return value === '' ? [] : value.split(',').map((item) => item.trim());
  return value;
}

// The action and its library input. Options are strict, each given at most once, and only those of the
// action are accepted.
function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: CLI_OPTIONS, strict: true, allowPositionals: false, tokens: true });
  } catch (error) {
    usage(error.message);
  }
  const { values, tokens } = parsed;
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) usage(`--${token.name} is given more than once`);
    seen.add(token.name);
  }
  if (values.plan === undefined) usage('--plan is required');
  if (values.action === undefined) usage('--action is required');
  const { action } = values;
  if (!Object.hasOwn(CLI_ACTIONS, action)) usage(`unknown action '${action}'`);
  const spec = CLI_ACTIONS[action];
  const accepted = new Set(['repo-root', 'plan', 'action', ...spec.required, ...spec.optional]);
  for (const name of Object.keys(values)) {
    if (!accepted.has(name)) usage(`--${name} is not an option of --action ${action}`);
  }
  for (const name of spec.required) {
    if (values[name] === undefined) usage(`--action ${action} requires --${name}`);
  }
  const root = resolve(values['repo-root'] ?? '.');
  let directory = false;
  try {
    directory = statSync(root).isDirectory();
  } catch {
    directory = false;
  }
  if (!directory) usage(`--repo-root must be an existing directory: ${root}`);
  const input = { plan: values.plan };
  for (const name of [...spec.required, ...spec.optional]) {
    if (values[name] !== undefined) input[camelCase(name)] = optionValue(name, values[name]);
  }
  return { root, run: spec.run, input };
}

function exitCodeFor(result) {
  if (result.ok) return 0;
  if (result.code === CODES.USAGE) return 2;
  if (result.code === CODES.INTEGRITY || result.code === CODES.RUN_HALTED) return 3;
  return 1;
}

// The repository root for the migrate probe, read leniently so the refusal precedes every usage error.
function repoRootOf(argv) {
  const { values } = parseArgs({ args: argv, options: CLI_OPTIONS, strict: false, allowPositionals: true });
  return resolve(typeof values['repo-root'] === 'string' ? values['repo-root'] : '.');
}

export function main(argv = process.argv.slice(2), io = {}) {
  closed(io, IO_KEYS, 'main', 'io');
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  if (typeof stdout?.write !== 'function' || typeof stderr?.write !== 'function') {
    throw new TypeError('main: io.stdout and io.stderr must have a write function');
  }
  const migrate = migrateRefusal(repoRootOf(argv));
  if (migrate !== null) {
    stderr.write(`correction-guard: ${migrate.message}\n`);
    return migrate.code;
  }
  let result;
  try {
    const { root, run, input } = parseCli(argv);
    result = run(root, input);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    result = { ok: false, code: CODES.USAGE, message: error.message, identity: {} };
    stderr.write(USAGE);
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) stderr.write(`correction-guard: ${result.message}\n`);
  return exitCodeFor(result);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
