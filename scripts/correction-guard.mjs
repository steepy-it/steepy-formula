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
// The evidence actions record an iteration's outcomes only at the run's next step. `record-writer` binds
// the writer (an autopilot execution receipt verified by task-results, or a manual four-field response and
// its task report) and writes the candidate snapshot `<scope>-cycle-<c>-iteration-<i>-candidate.json`
// with the current bytes of every path changed since the cycle baseline; above 64 MiB the run halts.
// `verify-check` runs each surface test with the coherence gate through the capture collector into
// `<scope>-cycle-<c>-iteration-<i>-check-<k>-evidence.md`, and halts the run when the source moves off
// the candidate. `record-review` binds the reviewer (a reviewer-response receipt or a manual response)
// with its defects artifact, recording an invalid one INVALID; `record-diagnosis` binds the diagnostic's
// artifact and decides its validity; `prove-isolation` proves a stopped task cycle isolated or halts the
// run with recovery evidence. A review or diagnosis that changed the source halts the run, as does any
// record the reducer refuses as an integrity fault.
//
// The guard never runs a mutating git command and never writes source files. Data problems come back as
// `{ ok: false, code, message, identity }` with a CORRECTION_GUARD_CODES or reducer code; a TypeError is
// thrown only for a malformed call (an unknown input or seam key, a seam that is not a function).
//
// Usage: node scripts/correction-guard.mjs --repo-root <root> --plan <plan> --action <open|next|open-cycle|
// reserve|authorize|record-interruption|admit-retry|stop|reopen|project|verify|record-writer|verify-check|
// record-review|record-diagnosis|prove-isolation> [options]; stdout carries exactly one JSON line, and the
// manual writer, reviewer and diagnostic responses arrive on stdin. `main` resolves to the exit code.
//
// Exit codes:
//   0   success
//   1   refused transition or invalid input
//   2   usage error
//   3   integrity failure (run halted or evidence corrupt)
//   25  migrate refusal, checked before any output or write

import { createHash } from 'node:crypto';
import {
  closeSync, constants as FS_CONSTANTS, openSync, readFileSync, readlinkSync, statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { planPhaseContext } from './autopilot-context.mjs';
import { collectReviewEvidence } from './capture-review-evidence.mjs';
import {
  CORRECTION_CODES,
  CORRECTION_RECORD_KINDS,
  applyCorrectionRecord,
  decideIsolation,
  deriveCycleBindings,
  formatCorrectionSummaryBlock,
  nextCorrectionStep,
  normalizeDefects,
  parseCorrectionSummaryBlock,
  replayCorrectionRecords,
  reviewRubricBindings,
  summarizeCorrectionRun,
  validateRetryRequest,
  validateRubric,
} from './correction-state.mjs';
import { migrateRefusal } from './formula/core/markdown-hub.mjs';
import { inspectReview } from './reviewer-response.mjs';
import { assertSafeRelPath } from './sanitize.mjs';
import { changedSourcePaths, observeSource, validateSourceObservation } from './source-observation.mjs';
import { inspectTaskResult } from './task-results.mjs';
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
  RECEIPT_PENDING: 'RECEIPT_PENDING',
  CAPTURE_FAILED: 'CAPTURE_FAILED',
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
const SNAPSHOT_LIMIT = 64 * 1024 * 1024;
const SNAPSHOT_REASON = 'candidate snapshot exceeds 64 MiB';
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

function refusalEnvelope(error) {
  if (!(error instanceof GuardRefusal)) throw error;
  return { ok: false, code: error.code, message: error.message, identity: error.identity };
}

function guarded(action) {
  try {
    return action();
  } catch (error) {
    return refusalEnvelope(error);
  }
}

async function guardedAsync(action) {
  try {
    return await action();
  } catch (error) {
    return refusalEnvelope(error);
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

function callContext(label, root, input, seams, accepted, seamKeys = SEAM_KEYS) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError(`${label}: root must be a non-empty string`);
  closed(input, accepted, label, 'input');
  closed(seams, seamKeys, label, 'seam');
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
function prepare(root, paths, observe, input, {
  drive = null, authorizedWriterWindow = false, driftReason = DRIFT_REASON,
} = {}) {
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
    haltRun(root, paths, loaded, actor, {
      reason: driftReason, evidence: [drift.evidence], observation: drift.observed,
      identity: { expected: drift.expected, observed: drift.observed },
    });
  }
  return { loaded, actor, observation };
}

// Appends RUN_HALTED to the replayed run and refuses INTEGRITY: the whole run stops. `identity` joins the
// failure envelope beside the halt record's reference.
function haltRun(root, paths, loaded, actor, { reason, evidence, observation, identity = {} }) {
  const halt = commit(root, stage(loaded, actor, { kind: KINDS.RUN_HALTED, reason, evidence, observation }, paths));
  return refuse(CODES.INTEGRITY, reason, { ...identity, halt: halt.ref });
}

// Stages an evidence record. A reducer refusal with the halt code is an integrity fault that stops the
// whole run: RUN_HALTED is appended instead, with `reason` (else the reducer's message) and `evidence`
// (else the record carrying the last recorded observation), and the current observation.
function stageOrHalt(root, paths, prepared, record, { reason = null, evidence = null } = {}) {
  const { loaded, actor, observation } = prepared;
  try {
    return stage(loaded, actor, record, paths);
  } catch (error) {
    if (!(error instanceof GuardRefusal) || error.code !== CORRECTION_CODES.halt.INTEGRITY) throw error;
    const last = lastObservation(loaded);
    return haltRun(root, paths, loaded, actor, {
      reason: reason ?? error.message,
      evidence: evidence ?? (last === null ? [] : [last.ref]),
      observation: observation.digest,
      identity: { cause: error.message },
    });
  }
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
function act(label, root, input, seams, accepted, build, seamKeys = SEAM_KEYS) {
  return guarded(() => build(callContext(label, root, input, seams, accepted, seamKeys)));
}

// `act` for an action that awaits an injected collector: a malformed call rejects with a TypeError.
function actAsync(label, root, input, seams, accepted, build, seamKeys = SEAM_KEYS) {
  return guardedAsync(() => build(callContext(label, root, input, seams, accepted, seamKeys)));
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

// --- evidence -------------------------------------------------------------------------------------

// A step, or the step an evidence action expects, in words.
const describeAt = (step) => [
  step.action, step.scope, step.cycle === undefined ? null : `cycle ${step.cycle}`,
  step.iteration === undefined ? null : `iteration ${step.iteration}`, step.role ?? null,
].filter((part) => part !== null && part !== undefined).join(' ');

// The run's next step, which must match `expected` (its action, scope, iteration and role); anything
// else is refused before any evidence is read or written.
function expectStep(state, expected) {
  const step = nextCorrectionStep(state);
  if (!Object.entries(expected).every(([key, value]) => step?.[key] === value)) {
    const next = step === null ? 'none' : describeAt(step);
    refuse(CODES.STEP_INVALID, `the next step is ${next}, not ${describeAt(expected)}`, { next: step });
  }
  return step;
}

// The cycle and the unconcluded iteration a step concerns.
function stepIteration(state, step) {
  const cycle = state.cycles[`${step.scope}#${step.cycle}`];
  return { cycle, entry: cycle.iterations.at(-1) };
}

// The bytes of a child's response: a string is taken as its UTF-8 bytes. A missing response is a refusal.
function responseBytes(response, label) {
  if (!isSupplied(response)) refuse(CODES.INPUT_INVALID, `${label} requires the child's response`, {});
  if (typeof response === 'string') return Buffer.from(response, 'utf8');
  if (response instanceof Uint8Array) return Buffer.from(response);
  throw new TypeError(`${label}: response must be a string or a Buffer`);
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const SIGNAL = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/u;

// The ordered `field: value` lines of a child's response, or null when it is not exactly those fields:
// strict UTF-8, one optional trailing newline, no heading, no other line, every value a non-empty line.
function parseFields(bytes, fields) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  const lines = text.replace(/\r?\n$/u, '').split(/\r?\n/u);
  if (lines.length !== fields.length) return null;
  const value = {};
  for (const [index, field] of fields.entries()) {
    const prefix = `${field}: `;
    if (!lines[index].startsWith(prefix)) return null;
    const content = lines[index].slice(prefix.length);
    if (content.length === 0 || content.trim() !== content || CONTROL.test(content)) return null;
    value[field] = content;
  }
  return value;
}

const isSafePath = (value) => {
  try {
    assertSafeRelPath(value);
    return value.split('/').every((segment) => segment !== '' && segment !== '.');
  } catch {
    return false;
  }
};

// A comma list of unique items each satisfying `valid`, or `none`.
function isListOrNone(value, valid) {
  if (value === 'none') return true;
  const items = value.split(/,\s*/u);
  return items.every((item) => item !== 'none' && valid(item)) && new Set(items).size === items.length;
}

const isSignals = (value) => isListOrNone(value, (item) => SIGNAL.test(item));

// The bytes at a dispatch target in this run of `family`, which must be present and non-empty.
function readTargetArtifact(root, paths, target, family, label) {
  try {
    parseWorkPath(target, 'work-output', family);
  } catch (error) {
    refuse(CODES.INPUT_INVALID, `the authorized target of ${label} is not a ${family} path: ${error.message}`,
      { target });
  }
  if (!target.startsWith(`${paths.run}/`)) {
    refuse(CODES.INPUT_INVALID, `the authorized target ${target} is not in this run ${paths.run}`, { target });
  }
  const bytes = readEvidence(root, target);
  if (bytes === null || bytes.toString('utf8').trim() === '') {
    refuse(CODES.INPUT_INVALID, `${label} ${target} is missing or empty`, { target });
  }
  return bytes;
}

const IMPLEMENTER_STATUSES = new Set(['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT']);
const MANUAL_FIELDS = Object.freeze(['status', 'artifact', 'changed-paths', 'signals']);

// The manual writer: its four-field response and the task report it names. A malformed response, or one
// naming another artifact than the authorized report, is recorded INVALID.
function manualWriter(root, paths, dispatch, input) {
  if (isSupplied(input.execution)) {
    refuse(CODES.INPUT_INVALID, 'a manual drive records its writer from the response, not an execution receipt', {});
  }
  const bytes = responseBytes(input.response, 'a manual writer');
  const report = readTargetArtifact(root, paths, dispatch.target, 'task-report', 'the writer report');
  const fields = parseFields(bytes, MANUAL_FIELDS);
  const valid = fields !== null && IMPLEMENTER_STATUSES.has(fields.status) && fields.artifact === dispatch.target
    && isListOrNone(fields['changed-paths'], isSafePath) && isSignals(fields.signals);
  return {
    status: valid ? fields.status : 'INVALID',
    evidence: [{ path: dispatch.target, digest: sha256(report) }],
    responseDigest: sha256(bytes),
  };
}

// The autopilot writer: the execution receipt the writer was authorized for, verified by task-results
// against the current source and report. A receipt without a semantic status is recorded INVALID.
function autopilotWriter(root, dispatch, input) {
  if (isSupplied(input.response)) {
    refuse(CODES.INPUT_INVALID, 'an autopilot writer is recorded from its execution receipt, not a response', {});
  }
  const { execution } = input;
  if (execution !== dispatch.target) {
    refuse(CODES.INPUT_INVALID, `execution must be the authorized writer target ${dispatch.target}`,
      { execution: String(execution) });
  }
  let receipt;
  try {
    receipt = inspectTaskResult(root, execution);
  } catch (error) {
    refuse(CODES.INTEGRITY, `the execution receipt does not verify: ${error.message}`, { execution });
  }
  if (receipt.status === 'PENDING') {
    refuse(CODES.RECEIPT_PENDING, `the execution receipt ${execution} is pending; resume it first`, { execution });
  }
  const evidence = [`${execution}-result.json`, `${execution}-report.md`].map((path) => {
    const bytes = readEvidence(root, path);
    if (bytes === null) refuse(CODES.INTEGRITY, `${path} is missing`, { path });
    return { path, digest: sha256(bytes) };
  });
  const semantic = receipt.accepted || receipt.retryable;
  return { status: semantic ? receipt.status : 'INVALID', evidence, responseDigest: null };
}

// The full observation a cycle opened with, from its baseline artifact, which must match the cycle.
function cycleBaseline(root, paths, cycle) {
  const path = paths.baseline(cycle.scope, cycle.cycle);
  const corrupt = (message) => refuse(CODES.INTEGRITY, `${path} ${message}`, { path });
  const bytes = readEvidence(root, path);
  if (bytes === null) corrupt('is missing');
  let body;
  try {
    body = strictJson(bytes.toString('utf8'));
    if (!isPlainObject(body) || !hasExactKeys(body, ['version', 'observation']) || body.version !== 1) {
      throw new Error('it must be { version: 1, observation }');
    }
    validateSourceObservation(body.observation);
  } catch (error) {
    corrupt(`is not a cycle baseline (${error.message})`);
  }
  if (body.observation.digest !== cycle.observation) corrupt('does not match the observation its cycle opened with');
  return { ref: { path, digest: sha256(bytes) }, observation: body.observation };
}

// The current bytes of a changed source path, bound to the observation: a symlink's own target bytes,
// never followed; any other difference from the observed size or digest is an integrity failure.
function sourceBytes(root, path, work) {
  const target = join(root, path);
  let bytes;
  try {
    if (work.kind === 'symlink') {
      bytes = readlinkSync(target, { encoding: 'buffer' });
    } else {
      const fd = openSync(target, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
      try {
        bytes = readFileSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  } catch (error) {
    refuse(CODES.INTEGRITY, `cannot read ${path} for the candidate snapshot: ${error.message}`, { path });
  }
  if (bytes.length !== work.size || sha256(bytes) !== work.digest) {
    refuse(CODES.INTEGRITY, `${path} changed while the candidate snapshot was taken`, { path });
  }
  return bytes;
}

// The candidate snapshot of the current observation against the cycle baseline: every changed path with
// its current bytes, or null work when it is absent. Above the raw byte limit the run halts.
function candidateSnapshot(root, paths, prepared, baseline, at) {
  const { loaded, actor, observation } = prepared;
  let changedPaths;
  try {
    changedPaths = changedSourcePaths(baseline.observation, observation);
  } catch (error) {
    throw new TypeError(`the observe seam must return a valid source observation: ${error.message}`);
  }
  const current = new Map(observation.files.map((file) => [file.path, file.work]));
  const works = changedPaths.map((path) => ({ path, work: current.get(path) ?? null }));
  const total = works.reduce((sum, { work }) => sum + (work?.size ?? 0), 0);
  if (total > SNAPSHOT_LIMIT) {
    haltRun(root, paths, loaded, actor, {
      reason: SNAPSHOT_REASON, evidence: [baseline.ref], observation: observation.digest,
      identity: { bytes: total, limit: SNAPSHOT_LIMIT },
    });
  }
  const files = works.map(({ path, work }) => ({
    path,
    work: work === null ? null
      : { kind: work.kind, mode: work.mode, base64: sourceBytes(root, path, work).toString('base64') },
  }));
  const bytes = Buffer.from(serialize({ version: 1, observation, files }));
  const path = `${paths.dir}/${at.scope}-cycle-${at.cycle}-iteration-${at.iteration}-candidate.json`;
  return { ref: { path, digest: sha256(bytes) }, bytes, changedPaths };
}

const WRITER_KEYS = Object.freeze(['plan', 'scope', 'iteration', 'execution', 'response', ...ACTOR_INPUT]);

// Records the authorized writer of the open iteration, the one action that may pass the writer window:
// on autopilot from its verified execution receipt, on a manual drive from its four-field response and
// task report. The candidate snapshot is written once the record is validated, then the record, whose
// observation becomes the drift reference.
export function recordCorrectionWriter(root, input, seams = {}) {
  return act('recordCorrectionWriter', root, input, seams, WRITER_KEYS, ({ paths, observe }) => {
    const prepared = prepare(root, paths, observe, input, { authorizedWriterWindow: true });
    const { loaded, actor, observation } = prepared;
    const { state } = loaded;
    const { scope, iteration } = input;
    const step = expectStep(state, { action: 'record', scope, iteration, role: 'writer' });
    const { cycle, entry } = stepIteration(state, step);
    const dispatch = entry.dispatches.find((item) => item.role === 'writer');
    const writer = state.run.drive === 'autopilot'
      ? autopilotWriter(root, dispatch, input)
      : manualWriter(root, paths, dispatch, input);
    const baseline = cycleBaseline(root, paths, cycle);
    const snapshot = candidateSnapshot(root, paths, prepared, baseline, step);
    const staged = stage(loaded, actor, {
      kind: KINDS.WRITER_RECORDED,
      scope: step.scope,
      cycle: step.cycle,
      iteration: step.iteration,
      status: writer.status,
      evidence: writer.evidence,
      responseDigest: writer.responseDigest,
      observation: observation.digest,
      candidate: snapshot.ref,
      changedPaths: snapshot.changedPaths,
    }, paths);
    writeEvidence(root, snapshot.ref.path, snapshot.bytes);
    return { ...mutation('record-writer', commit(root, staged)), candidate: snapshot.ref };
  });
}

const CHECKS_KEYS = Object.freeze(['plan', 'scope', 'iteration', ...ACTOR_INPUT]);
const CHECKS_SEAM_KEYS = Object.freeze([...SEAM_KEYS, 'collectEvidence', 'graphGateArgs']);
const CHECKS_REASON = 'source changed during the checks';
const COHERENCE_GATE = 'coherence-gate';
const FAILED_ASSERTIONS = /^# fail (\d+)$/gmu;
const VIOLATIONS = /violations:\s*(\d+)/gu;
const UNCHECKED = '0'.repeat(64);

// The count of the last match of `pattern` in a command's excerpt, or null without one.
function lastCount(pattern, excerpt) {
  const matches = typeof excerpt === 'string' ? [...excerpt.matchAll(pattern)] : [];
  const count = matches.length === 0 ? null : Number(matches.at(-1)[1]);
  return Number.isSafeInteger(count) ? count : null;
}

// The surface-test command (first) and coherence-gate command (last) of a collector receipt.
function receiptCommands(receipt) {
  const commands = Array.isArray(receipt?.commands) ? receipt.commands : [];
  const surface = commands[0];
  const gate = commands.findLast((command) => command?.label === COHERENCE_GATE);
  const valid = (command) => isPlainObject(command) && typeof command.passed === 'boolean'
    && (command.exitCode === null || Number.isSafeInteger(command.exitCode));
  if (surface?.label !== 'surface-test' || !valid(surface) || !valid(gate)) {
    throw new TypeError('the collectEvidence seam must resolve to a receipt with surface-test and coherence-gate '
      + 'commands');
  }
  return { surface, gate };
}

// Verifies the checks of the open iteration: each surface test with the built-in coherence gate through
// the collector, into its own evidence file, on the iteration candidate. The record is validated before
// any command runs, the source is observed after every capture and must stay the candidate, and only
// then are the results recorded.
export function recordCorrectionChecks(root, input, seams = {}) {
  return actAsync('recordCorrectionChecks', root, input, seams, CHECKS_KEYS, async ({ paths, observe }) => {
    const collect = seams.collectEvidence ?? collectReviewEvidence;
    const graphGateArgs = seams.graphGateArgs ?? [];
    if (typeof collect !== 'function') {
      throw new TypeError('recordCorrectionChecks: the collectEvidence seam must be a function');
    }
    if (!Array.isArray(graphGateArgs) || !graphGateArgs.every((arg) => typeof arg === 'string')) {
      throw new TypeError('recordCorrectionChecks: the graphGateArgs seam must be an array of strings');
    }
    const prepared = prepare(root, paths, observe, input);
    const { loaded, observation } = prepared;
    const step = expectStep(loaded.state, { action: 'checks', scope: input.scope, iteration: input.iteration });
    const { cycle } = stepIteration(loaded.state, step);
    const at = `${paths.dir}/${step.scope}-cycle-${step.cycle}-iteration-${step.iteration}`;
    const evidencePath = (k) => `${at}-check-${k}-evidence.md`;
    const record = (checks) => ({
      kind: KINDS.CHECKS_RECORDED, scope: step.scope, cycle: step.cycle, iteration: step.iteration,
      observation: observation.digest, checks,
    });
    // The order and the candidate are the reducer's to judge, before any command runs.
    stageOrHalt(root, paths, prepared, record(cycle.checks.map((check) => ({
      id: check.id, exitCode: null, passed: false, metric: null, evidence: { path: evidencePath(1), digest: UNCHECKED },
    }))));
    const surfaces = cycle.checks.filter((entry) => entry.id !== COHERENCE_GATE);
    if (surfaces.length === 0) {
      refuse(CODES.CAPTURE_FAILED,
        `cycle ${step.scope}#${step.cycle} has no surface test to capture the coherence gate with`,
        { scope: step.scope, cycle: step.cycle });
    }
    const results = new Map();
    const captured = [];
    let gate = null;
    for (const [index, check] of surfaces.entries()) {
      const path = evidencePath(index + 1);
      let receipt;
      try {
        receipt = await collect({ repoRoot: root, evidencePath: path, testCommand: check.command, graphGateArgs });
      } catch (error) {
        if (error instanceof TypeError) throw error;
        refuse(CODES.CAPTURE_FAILED, `the ${check.id} capture failed: ${error.message}`, { check: check.id });
      }
      const bytes = readEvidence(root, path);
      if (bytes === null) refuse(CODES.INTEGRITY, `the ${check.id} capture wrote no evidence ${path}`, { path });
      const evidence = { path, digest: sha256(bytes) };
      captured.push(evidence);
      const after = observeRoot(observe, root);
      if (after.digest !== observation.digest) {
        haltRun(root, paths, loaded, prepared.actor, {
          reason: CHECKS_REASON, evidence: captured, observation: after.digest,
          identity: { expected: observation.digest, observed: after.digest, check: check.id },
        });
      }
      const commands = receiptCommands(receipt);
      const { surface } = commands;
      results.set(check.id, {
        id: check.id, exitCode: surface.exitCode, passed: surface.passed,
        metric: lastCount(FAILED_ASSERTIONS, surface.excerpt), evidence,
      });
      gate = { command: commands.gate, evidence };
    }
    results.set(COHERENCE_GATE, {
      id: COHERENCE_GATE, exitCode: gate.command.exitCode, passed: gate.command.passed,
      metric: lastCount(VIOLATIONS, gate.command.excerpt), evidence: gate.evidence,
    });
    const staged = stageOrHalt(root, paths, prepared, record(cycle.checks.map((check) => results.get(check.id))));
    return mutation('verify-check', commit(root, staged));
  }, CHECKS_SEAM_KEYS);
}

const REVIEW_KEYS = Object.freeze([
  'plan', 'scope', 'iteration', 'role', 'defects', 'ownerTask', 'reviewState', 'response', ...ACTOR_INPUT,
]);
const REVIEW_REASON = 'unauthorized repository change during review';
const REVIEWER_ROLES = new Set(['task-reviewer', 'final-reviewer']);
const REVIEWER_STATUSES = new Set(['APPROVED', 'ISSUES_FOUND', 'BLOCKED', 'NEEDS_CONTEXT']);
const VERDICTS = new Set(['APPROVED', 'ISSUES_FOUND']);
const REVIEW_REFUSALS = new Set(Object.values(CORRECTION_CODES.review));
const DEFECTS_KEYS = Object.freeze(['version', 'scope', 'cycle', 'iteration', 'verdict', 'defects', 'rubric']);

const isNonEmpty = (bytes) => bytes !== null && bytes.toString('utf8').trim() !== '';

// The digest references of the non-empty artifacts among `artifacts`, in order.
function nonEmptyEvidence(root, artifacts) {
  return artifacts.map((path) => ({ path, bytes: readEvidence(root, path) }))
    .filter(({ bytes }) => isNonEmpty(bytes)).map(({ path, bytes }) => ({ path, digest: sha256(bytes) }));
}

// The manual reviewer: its four-field response with `changed-paths: none`, naming the authorized review
// artifact, or its issues artifact for ISSUES_FOUND, which must be non-empty. Anything else is INVALID.
function manualReviewer(root, paths, dispatch, input) {
  if (isSupplied(input.reviewState)) {
    refuse(CODES.INPUT_INVALID, 'a manual drive records its reviewer from the response, not a review guard state', {});
  }
  const bytes = responseBytes(input.response, 'a manual reviewer');
  const review = dispatch.target;
  let family = null;
  try {
    family = parseWorkPath(review, 'work-output', 'review-artifact').family;
  } catch {
    family = null;
  }
  if (family === null || !review.startsWith(`${paths.run}/`) || !review.endsWith('-review.md')) {
    refuse(CODES.INPUT_INVALID, `the authorized reviewer target ${review} is not a review artifact of this run`,
      { target: review });
  }
  const issues = review === `${paths.run}/final-review.md`
    ? `${paths.run}/final-review-issues.md` : review.replace(/-review\.md$/u, '-issues.md');
  const evidence = nonEmptyEvidence(root, [review, issues]);
  const fields = parseFields(bytes, MANUAL_FIELDS);
  const named = fields?.status === 'ISSUES_FOUND' ? issues : review;
  const valid = fields !== null && REVIEWER_STATUSES.has(fields.status) && fields['changed-paths'] === 'none'
    && isSignals(fields.signals) && fields.artifact === named && evidence.some((item) => item.path === named);
  return { status: valid ? fields.status : 'INVALID', evidence };
}

// The autopilot reviewer: the reviewer-response receipt the reviewer was authorized for, which must
// verify on resume. A receipt without a semantic status is INVALID.
function autopilotReviewer(root, dispatch, input) {
  if (isSupplied(input.response)) {
    refuse(CODES.INPUT_INVALID, 'an autopilot reviewer is recorded from its review guard state, not a response', {});
  }
  const prefix = input.reviewState;
  if (prefix !== dispatch.target) {
    refuse(CODES.INPUT_INVALID, `reviewState must be the authorized reviewer target ${dispatch.target}`,
      { reviewState: String(prefix) });
  }
  let result;
  try {
    result = inspectReview(root, prefix);
  } catch (error) {
    refuse(CODES.INTEGRITY, `the review receipt does not verify: ${error.message}`, { reviewState: prefix });
  }
  if (!Object.hasOwn(result, 'observation')) {
    refuse(CODES.INTEGRITY, `the review receipt ${prefix} does not verify on resume: ${result.reason}`,
      { reviewState: prefix });
  }
  const [baselinePath, originalPath] = [`${prefix}-baseline.json`, `${prefix}-original.json`];
  const baselineBytes = readEvidence(root, baselinePath);
  const { config } = JSON.parse(baselineBytes.toString('utf8'));
  return {
    status: result.envelope === undefined ? 'INVALID' : result.status,
    evidence: [
      { path: baselinePath, digest: sha256(baselineBytes) },
      { path: originalPath, digest: sha256(readEvidence(root, originalPath)) },
      ...nonEmptyEvidence(root, [config.report, config.issues]),
    ],
  };
}

// The reviewer's defects artifact judged against the cycle: its scope, cycle, iteration and verdict, its
// defects normalized against the bindings and the previous comparable outcome, and its rubric validated
// for the reviewed criteria. Anything that does not hold makes the review INVALID.
function assessDefects(state, step, ownerTask, status, bytes) {
  const invalid = { status: 'INVALID', defects: [], rubric: [] };
  if (bytes === null) return invalid;
  let body;
  try {
    body = strictJson(bytes.toString('utf8'));
  } catch {
    return invalid;
  }
  if (!isPlainObject(body) || !hasExactKeys(body, DEFECTS_KEYS) || body.version !== 1 || body.scope !== step.scope
    || body.cycle !== step.cycle || body.iteration !== step.iteration || body.verdict !== status) {
    return invalid;
  }
  const { cycle } = stepIteration(state, step);
  const previous = cycle.iterations.findLast((entry) => entry.iteration < step.iteration
    && entry.conclusion?.via === 'outcome')?.conclusion.defects ?? null;
  const normalized = normalizeDefects({ bindings: cycle.bindings, entries: body.defects, previous });
  if (!normalized.ok) return invalid;
  const owner = step.scope === 'final' && step.role === 'task-reviewer'
    ? state.run.tasks.find((task) => task.task === ownerTask) : null;
  const rubric = validateRubric({
    bindings: reviewRubricBindings({ scope: step.scope, bindings: cycle.bindings, role: step.role, ownerTask: owner }),
    rubric: body.rubric,
    defects: normalized.defects,
  });
  if (!rubric.ok) return invalid;
  return { status, defects: body.defects, rubric: body.rubric };
}

// Records the authorized reviewer of the open iteration with its defects artifact. The review must leave
// the authorized tree unchanged: a change appends RUN_HALTED. A review whose contents the reducer refuses
// is recorded INVALID.
export function recordCorrectionReview(root, input, seams = {}) {
  return act('recordCorrectionReview', root, input, seams, REVIEW_KEYS, ({ paths, observe }) => {
    if (!REVIEWER_ROLES.has(input.role)) {
      refuse(CODES.INPUT_INVALID, `role must be one of: ${[...REVIEWER_ROLES].join(', ')}`,
        { role: String(input.role) });
    }
    try {
      parseWorkPath(input.defects, 'work-output', 'correction-defects');
      if (!input.defects.startsWith(`${paths.dir}/`)) throw new Error(`it is not in ${paths.dir}`);
    } catch (error) {
      refuse(CODES.INPUT_INVALID, `defects must be a correction-defects path of this run: ${error.message}`,
        { defects: String(input.defects) });
    }
    const prepared = prepare(root, paths, observe, input, { driftReason: REVIEW_REASON });
    const { loaded, observation } = prepared;
    const { state } = loaded;
    const { scope, iteration, role } = input;
    const step = expectStep(state, { action: 'record', scope, iteration, role });
    const { entry } = stepIteration(state, step);
    const dispatch = entry.dispatches.find((item) => item.role === step.role);
    const ownerTask = input.ownerTask ?? null;
    if (ownerTask !== dispatch.ownerTask) {
      refuse(REFUSAL.ROLE_NOT_ALLOWED,
        `the ${step.role} was authorized for owner task ${dispatch.ownerTask}, not ${ownerTask}`,
        { ownerTask: String(ownerTask) });
    }
    const reviewer = state.run.drive === 'autopilot'
      ? autopilotReviewer(root, dispatch, input)
      : manualReviewer(root, paths, dispatch, input);
    const defectsBytes = readEvidence(root, input.defects);
    const evidence = [
      ...reviewer.evidence, ...(defectsBytes === null ? [] : [{ path: input.defects, digest: sha256(defectsBytes) }]),
    ];
    const assessed = VERDICTS.has(reviewer.status)
      ? assessDefects(state, step, ownerTask, reviewer.status, defectsBytes)
      : { status: reviewer.status, defects: [], rubric: [] };
    if (evidence.length === 0) {
      refuse(CODES.INPUT_INVALID, `the ${step.role} left no artifact to prove its ${assessed.status} review`, {});
    }
    const record = ({ status, defects, rubric }) => ({
      kind: KINDS.REVIEW_RECORDED, scope: step.scope, cycle: step.cycle, iteration: step.iteration, role: step.role,
      ownerTask, status, defects, rubric, evidence, before: dispatch.observation, after: observation.digest,
    });
    let recorded = assessed;
    let staged;
    try {
      staged = stageOrHalt(root, paths, prepared, record(recorded), { reason: REVIEW_REASON });
    } catch (error) {
      if (!(error instanceof GuardRefusal) || !REVIEW_REFUSALS.has(error.code)) throw error;
      recorded = { status: 'INVALID', defects: [], rubric: [] };
      staged = stageOrHalt(root, paths, prepared, record(recorded), { reason: REVIEW_REASON });
    }
    return { ...mutation('record-review', commit(root, staged)), status: recorded.status };
  });
}

const DIAGNOSIS_KEYS = Object.freeze(['plan', 'scope', 'iteration', 'response', ...ACTOR_INPUT]);
const DIAGNOSIS_REASON = 'unauthorized repository change during diagnosis';
const AUTOPILOT_DIAGNOSIS_FIELDS = Object.freeze(['status', 'artifact', 'signals']);
const DIAGNOSIS_BODY_KEYS = Object.freeze([
  'version', 'scope', 'cycle', 'iteration', 'hypothesis', 'remedy', 'confirmingCheck', 'recommendation', 'evidence',
]);
const DIAGNOSIS_TEXT_FIELDS = Object.freeze(['hypothesis', 'remedy', 'confirmingCheck', 'recommendation']);
const REVIEW_CONFIRMATIONS = Object.freeze(['review', 'rubric']);
const WORK_AREA = '.formula/work/';

const isText = (value) => typeof value === 'string' && value.trim().length > 0;

// The diagnosis artifact in its strict shape for the step, or null.
function diagnosisBody(bytes, step) {
  let body;
  try {
    body = strictJson(bytes.toString('utf8'));
  } catch {
    return null;
  }
  const shaped = isPlainObject(body) && hasExactKeys(body, DIAGNOSIS_BODY_KEYS) && body.version === 1
    && body.scope === step.scope && body.cycle === step.cycle && body.iteration === step.iteration
    && DIAGNOSIS_TEXT_FIELDS.every((field) => typeof body[field] === 'string')
    && Array.isArray(body.evidence) && body.evidence.every((item) => isPlainObject(item)
      && hasExactKeys(item, ['path', 'digest']) && typeof item.path === 'string' && HEX64.test(item.digest));
  return shaped ? body : null;
}

// Whether an evidence reference matches current bytes: a work artifact read through work-paths, any other
// path by its digest in the current source observation.
function matchesCurrentBytes(root, observation, { path, digest }) {
  if (path.startsWith(WORK_AREA)) {
    try {
      return sha256(readWorkPath(root, path)) === digest;
    } catch {
      return false;
    }
  }
  return observation.files.find((file) => file.path === path)?.work?.digest === digest;
}

// Records the authorized diagnostic of the open diagnosis iteration from its response and its artifact at
// the authorized diagnostic target. The diagnosis is valid only when DIAGNOSED, complete, confirmed by a
// bound check, review or rubric, and backed by evidence that matches current bytes; it must leave the
// authorized tree unchanged, else RUN_HALTED is appended.
export function recordCorrectionDiagnosis(root, input, seams = {}) {
  return act('recordCorrectionDiagnosis', root, input, seams, DIAGNOSIS_KEYS, ({ paths, observe }) => {
    const prepared = prepare(root, paths, observe, input, { driftReason: DIAGNOSIS_REASON });
    const { loaded, observation } = prepared;
    const { state } = loaded;
    const { scope, iteration } = input;
    const step = expectStep(state, { action: 'record', scope, iteration, role: 'diagnostic' });
    const { cycle, entry } = stepIteration(state, step);
    const dispatch = entry.dispatches.find((item) => item.role === 'diagnostic');
    const target = `${paths.dir}/${step.scope}-cycle-${step.cycle}-iteration-${step.iteration}-diagnosis.json`;
    if (dispatch.target !== target) {
      refuse(CODES.INPUT_INVALID, `the diagnostic is authorized for ${dispatch.target}, not the diagnosis ${target}`,
        { target: dispatch.target });
    }
    const bytes = responseBytes(input.response, 'a diagnosis');
    const artifact = readEvidence(root, target);
    if (artifact === null) refuse(CODES.INPUT_INVALID, `the diagnosis ${target} is missing`, { target });
    const fields = parseFields(bytes, state.run.drive === 'autopilot' ? AUTOPILOT_DIAGNOSIS_FIELDS : MANUAL_FIELDS);
    // DIAGNOSED is the one valid status; INCONCLUSIVE, BLOCKED, NEEDS_CONTEXT or a malformed response is not.
    const diagnosed = fields !== null && fields.status === 'DIAGNOSED' && fields.artifact === target
      && isSignals(fields.signals) && (fields['changed-paths'] ?? 'none') === 'none';
    const body = diagnosisBody(artifact, step);
    const confirmations = new Set([...cycle.checks.map((check) => check.id), ...REVIEW_CONFIRMATIONS]);
    const valid = diagnosed && body !== null
      && ['hypothesis', 'remedy', 'recommendation'].every((field) => isText(body[field]))
      && confirmations.has(body.confirmingCheck)
      && body.evidence.every((reference) => matchesCurrentBytes(root, observation, reference));
    const record = {
      kind: KINDS.DIAGNOSIS_RECORDED, scope: step.scope, cycle: step.cycle, iteration: step.iteration, valid,
      ...Object.fromEntries(DIAGNOSIS_TEXT_FIELDS.map((field) => [field, body?.[field] ?? ''])),
      artifact: { path: target, digest: sha256(artifact) },
      before: dispatch.observation,
      after: observation.digest,
    };
    const staged = stageOrHalt(root, paths, prepared, record, { reason: DIAGNOSIS_REASON });
    return { ...mutation('record-diagnosis', commit(root, staged)), valid };
  });
}

const ISOLATION_KEYS = Object.freeze(['plan', 'scope', ...ACTOR_INPUT]);

// Proves the isolation of the latest stopped task cycle from the current observation: its opening tree
// (baseline-equal) or its verified best candidate (retained-best). An unprovable isolation appends
// RUN_HALTED with what a human needs to recover: the best candidate snapshot, the cycle baseline artifact
// and the changed paths. Read-only towards the source: no file is written and no Git command mutates.
export function proveCorrectionIsolation(root, input, seams = {}) {
  return act('proveCorrectionIsolation', root, input, seams, ISOLATION_KEYS, ({ paths, observe }) => {
    const prepared = prepare(root, paths, observe, input);
    const { loaded, actor, observation } = prepared;
    const { state } = loaded;
    const step = expectStep(state, { action: 'prove-isolation', scope: input.scope });
    const decision = decideIsolation(state, { scope: step.scope, cycle: step.cycle, observation: observation.digest });
    if (!decision.proven) {
      const { bestCandidate, changedPaths } = decision.recovery;
      const baseline = cycleBaseline(root, paths, state.cycles[`${step.scope}#${step.cycle}`]);
      haltRun(root, paths, loaded, actor, {
        reason: `the isolation of ${step.scope}#${step.cycle} is unprovable; changed paths: `
          + `${changedPaths.length === 0 ? 'none' : changedPaths.join(', ')}`,
        evidence: [...(bestCandidate.snapshot === null ? [] : [bestCandidate.snapshot]), baseline.ref],
        observation: observation.digest,
        identity: { recovery: { bestCandidate, baseline: baseline.ref, changedPaths } },
      });
    }
    const staged = stageOrHalt(root, paths, prepared, {
      kind: KINDS.ISOLATION_RECORDED, scope: step.scope, cycle: step.cycle, mode: decision.mode,
      observation: observation.digest,
    });
    return { ...mutation('prove-isolation', commit(root, staged)), mode: decision.mode };
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
  record-writer        --scope <scope> --iteration <n> [--execution <the authorized execution receipt>]
  verify-check         --scope <scope> --iteration <n>
  record-review        --scope <scope> --iteration <n> --role task-reviewer|final-reviewer
                       --defects <the exact correction-defects path> [--owner-task <n>]
                       [--review-state <the authorized review guard state>]
  record-diagnosis     --scope <scope> --iteration <n>
  prove-isolation      --scope <task-N>

Every mutating action (all but next and verify) takes --run-id <id> --attempt <n> on an autopilot drive
and refuses them on a manual drive; reopen refuses them on every drive.
record-writer and record-review on a manual drive (no --execution, no --review-state) read the child's
four-field response from stdin; record-diagnosis reads the diagnostic's response from stdin on every drive.
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
  execution: STRING,
  defects: STRING,
  'review-state': STRING,
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
  'record-writer': {
    run: recordCorrectionWriter,
    required: ['scope', 'iteration'],
    optional: ['execution', ...ACTOR_OPTIONS],
    stdin: (values) => values.execution === undefined,
  },
  'verify-check': { run: recordCorrectionChecks, required: ['scope', 'iteration'], optional: ACTOR_OPTIONS },
  'record-review': {
    run: recordCorrectionReview,
    required: ['scope', 'iteration', 'role', 'defects'],
    optional: ['owner-task', 'review-state', ...ACTOR_OPTIONS],
    stdin: (values) => values['review-state'] === undefined,
  },
  'record-diagnosis': {
    run: recordCorrectionDiagnosis, required: ['scope', 'iteration'], optional: ACTOR_OPTIONS, stdin: () => true,
  },
  'prove-isolation': { run: proveCorrectionIsolation, required: ['scope'], optional: ACTOR_OPTIONS },
});
const IO_KEYS = Object.freeze(['stdout', 'stderr', 'stdin']);

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
  return { root, run: spec.run, input, stdin: spec.stdin?.(values) ?? false };
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

export async function main(argv = process.argv.slice(2), io = {}) {
  closed(io, IO_KEYS, 'main', 'io');
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? (() => readFileSync(0));
  if (typeof stdout?.write !== 'function' || typeof stderr?.write !== 'function') {
    throw new TypeError('main: io.stdout and io.stderr must have a write function');
  }
  if (typeof stdin !== 'function') throw new TypeError('main: io.stdin must be a function returning the stdin bytes');
  const migrate = migrateRefusal(repoRootOf(argv));
  if (migrate !== null) {
    stderr.write(`correction-guard: ${migrate.message}\n`);
    return migrate.code;
  }
  let result;
  try {
    const { root, run, input, stdin: reads } = parseCli(argv);
    if (reads) input.response = stdin();
    result = await run(root, input);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    result = { ok: false, code: CODES.USAGE, message: error.message, identity: {} };
    stderr.write(USAGE);
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) stderr.write(`correction-guard: ${result.message}\n`);
  return exitCodeFor(result);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
