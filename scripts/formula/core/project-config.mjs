// Project identity binding (plan .formula/work/plans/2026-08-20-project-identity-binding.md Task 1;
// spec .formula/work/specs/2026-08-20-project-identity-binding.md D2/D3) — the ONE place a
// repository's bound project id lives on disk: `<root>/.formula/config.json`, normalized to
// `{"projectId": "<id>"}` (2-space JSON + trailing newline).
//
// The D3 precedence chain is the CLI's (`--project` > `STEEPY_PROJECT` > `.formula/config.json` >
// `'demo'`); this module owns the third link plus the adoption decision that guards it. Echo
// sources are exactly `flag | env | config | fallback` (PROJECT_SOURCES). The adoption table:
//
//   no config present            -> written     (any source — the chain tail binds a bare repo)
//   config matches requested     -> unchanged   (no write, the file is not even touched)
//   config differs + flag | env  -> refused     (an explicit request never silently wins)
//                    ... + force -> rewritten   (carrying previousId for the old -> new echo)
//
// A differing `config`/`fallback` source cannot reach adoption: a config-sourced request IS the
// config, and a fallback source implies no config exists — both orderings fall out of the
// precedence chain, so the table above has no branch for them.
//
// CONVENTIONS (core-module standard of hub-mode.mjs): closed input keys, `TypeError` on
// programmer error, `Error` on data conditions. A config file that exists but is unreadable,
// invalid JSON, or carries an invalid projectId THROWS (operational — the CLI maps it to exit
// 3, never a silent fallback); a missing file reads as `null`. Unknown top-level keys are
// ignored on read and dropped on write (spec D2 forward compatibility). `validateProjectConfig`
// is the single validation authority — the read and the write path throw its errors, so the
// file-shape rules live in exactly one place.
//
// EXTERNAL-INPUT NOTE (rule apex:steepy-formula:rule:sanitize-external-input): the only external
// value this module writes is the projectId, and it reaches disk solely after passing the
// `isValidProjectId` allowlist ([a-z][a-z0-9-]* — strictly narrower than sanitize.mjs's
// assertSafeLine) and JSON.stringify encoding; unknown keys read from an existing file are never
// echoed back (writes are normalized). No path-shaped or free-text external value is written.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isValidProjectId } from './ids.mjs';

const CONFIG_DIR = '.formula';
const CONFIG_FILE = 'config.json';
const GITIGNORE_FILE = '.gitignore';

const VALIDATE_CONTEXT_KEYS = ['path'];
const ADOPT_INPUT_KEYS = ['root', 'requested', 'requestedSource', 'force'];

// --- vocabulary ------------------------------------------------------------------------------------

// The D3 echo-source vocabulary (exactly these four; the CLI's resolution echoes one of them
// beside every resolved project id — degradations are explicit).
export const PROJECT_SOURCES = deepFreeze(['flag', 'env', 'config', 'fallback']);

// --- helpers ---------------------------------------------------------------------------------------

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

// A typo must never silently drop an argument — the same closed-input discipline hub-mode.mjs uses.
function rejectUnknownKeys(input, accepted, caller) {
  for (const key of Object.keys(input)) {
    if (accepted.includes(key)) continue;
    throw new TypeError(`${caller}: unknown input key '${key}'; accepted: ${accepted.join(', ')}.`);
  }
}

function requireRoot(root, caller) {
  if (typeof root !== 'string' || root === '') {
    throw new TypeError(`${caller}: root must be a non-empty directory path string, got ${JSON.stringify(root ?? null)}.`);
  }
}

function configPathFor(root) {
  return join(root, CONFIG_DIR, CONFIG_FILE);
}

// --- the single validation authority ---------------------------------------------------------------

// Validates a parsed-or-candidate config value and returns the normalized `{ projectId }`.
// `context.path` (optional) lands in every data-error message so both the read path (the file
// that declares the id) and the write path (the file that would receive it) name the exact
// location. Data conditions throw `Error` — parsed JSON can be any shape, so nothing here is a
// programmer error; a malformed `context` (a call-site argument) is a `TypeError`.
export function validateProjectConfig(candidate, context = {}) {
  if (!isPlainObject(context)) {
    throw new TypeError('validateProjectConfig: context must be an object with at most a `path` string.');
  }
  rejectUnknownKeys(context, VALIDATE_CONTEXT_KEYS, 'validateProjectConfig');
  if (context.path !== undefined && typeof context.path !== 'string') {
    throw new TypeError(`validateProjectConfig: context.path must be a string, got ${JSON.stringify(context.path)}.`);
  }
  const where = context.path !== undefined ? `'${context.path}'` : 'the config candidate';
  if (!isPlainObject(candidate)) {
    throw new Error(`validateProjectConfig: ${where} must be a JSON object, got ${JSON.stringify(candidate ?? null)}.`);
  }
  if (!isValidProjectId(candidate.projectId)) {
    throw new Error(
      `validateProjectConfig: ${where} carries an invalid projectId ${JSON.stringify(candidate.projectId ?? null)}; expected [a-z][a-z0-9-]* (core/ids.mjs).`,
    );
  }
  return { projectId: candidate.projectId };
}

// --- read / write ----------------------------------------------------------------------------------

// Reads `<root>/.formula/config.json`. `null` when the file is absent; an operational `Error`
// naming the exact path (and, for a bad id, the value) when it exists but cannot serve a
// binding — never a silent fallback.
export function readProjectConfig(root) {
  requireRoot(root, 'readProjectConfig');
  const configPath = configPathFor(root);
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`readProjectConfig: cannot read '${configPath}': ${error?.message ?? String(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`readProjectConfig: invalid JSON in '${configPath}': ${error?.message ?? String(error)}`);
  }
  return validateProjectConfig(parsed, { path: configPath });
}

// Validates first (the same authority as the read path), then writes atomically: a temp file in
// the SAME directory (same filesystem, so renameSync is atomic) renamed over the target, with
// the `.formula` directory created first. Returns the normalized `{ projectId }`.
export function writeProjectConfig(root, projectId) {
  requireRoot(root, 'writeProjectConfig');
  const configPath = configPathFor(root);
  const normalized = validateProjectConfig({ projectId }, { path: configPath });
  mkdirSync(join(root, CONFIG_DIR), { recursive: true });
  const tempPath = join(root, CONFIG_DIR, `.${CONFIG_FILE}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`);
    renameSync(tempPath, configPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // best-effort cleanup — the rename/write error below is the real failure
    }
    throw new Error(`writeProjectConfig: cannot write '${configPath}': ${error?.message ?? String(error)}`);
  }
  return normalized;
}

// --- the self-contained ignore file ---------------------------------------------------------------

// Everything under `.formula/` stays local except the committed binding and this file itself —
// the work area, an inception run, the init provenance receipts, secrets and engine state —
// whatever the repository's root `.gitignore` says.
export const FORMULA_GITIGNORE = '*\n!.gitignore\n!config.json\n';

// Create-only: writes `.formula/.gitignore` when absent and never rewrites an existing one (a
// repository may have tuned it). Returns 'written' or 'kept'.
export function ensureFormulaGitignore(root) {
  requireRoot(root, 'ensureFormulaGitignore');
  const ignorePath = join(root, CONFIG_DIR, GITIGNORE_FILE);
  mkdirSync(join(root, CONFIG_DIR), { recursive: true });
  try {
    writeFileSync(ignorePath, FORMULA_GITIGNORE, { flag: 'wx' });
    return 'written';
  } catch (error) {
    if (error?.code === 'EEXIST') return 'kept';
    throw new Error(`ensureFormulaGitignore: cannot write '${ignorePath}': ${error?.message ?? String(error)}`);
  }
}

// --- adoption --------------------------------------------------------------------------------------

// The D3-adoption decision (table in the module header). `requestedSource` is validated
// against PROJECT_SOURCES to keep the call site honest about the precedence chain, but the
// decision itself never branches on it: a differing non-explicit source cannot occur through
// the chain (config-sourced requests ARE the config; a fallback source implies no config).
export function adoptProjectBinding(input = {}) {
  if (!isPlainObject(input)) {
    throw new TypeError('adoptProjectBinding requires an input object.');
  }
  rejectUnknownKeys(input, ADOPT_INPUT_KEYS, 'adoptProjectBinding');
  const { root, requested, requestedSource, force = false } = input;
  requireRoot(root, 'adoptProjectBinding');
  if (!isValidProjectId(requested)) {
    throw new TypeError(`adoptProjectBinding requires a valid requested project id, got ${JSON.stringify(requested ?? null)}.`);
  }
  if (!PROJECT_SOURCES.includes(requestedSource)) {
    throw new TypeError(
      `adoptProjectBinding: requestedSource must be one of ${PROJECT_SOURCES.join(', ')}; got ${JSON.stringify(requestedSource ?? null)}.`,
    );
  }
  if (typeof force !== 'boolean') {
    throw new TypeError(`adoptProjectBinding: force must be a boolean, got ${JSON.stringify(force)}.`);
  }

  const existing = readProjectConfig(root);
  if (existing === null) {
    writeProjectConfig(root, requested);
    return { action: 'written', projectId: requested };
  }
  if (existing.projectId === requested) {
    return { action: 'unchanged', projectId: existing.projectId };
  }
  if (!force) {
    return { action: 'refused', projectId: existing.projectId };
  }
  writeProjectConfig(root, requested);
  return { action: 'rewritten', projectId: requested, previousId: existing.projectId };
}
