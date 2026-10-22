// Adapter-based secret provider chain + typed actor identity helpers (Task F1, spec §26).
//
//   resolveDatabaseSecret(name, options?) -> { ok, value, source, warning?, code? } | NOT_FOUND
//   actor(type, name) / actorFrom(type, name) -> { type, id }   (one source of truth, §26)
//   describeSecret(result)                    -> redacted { name, ok, source, code?, warning? }
//
// The chain resolves a NAMED SLOT, first hit wins, and every external accessor is injected so
// tests never touch the machine:
//   (a) OS keychain — `security find-generic-password -a <slot> -s steepy-formula -w`. The
//       capability check (is the `security` CLI present and reachable?) is part of the chain:
//       a missing CLI skips this link, never a crash. A missing keychain item is a NORMAL
//       NOT_FOUND at this link, not an error.
//   (b) local config file `.formula/secrets.json` — a flat JSON object mapping slot → secret.
//       The file must be gitignored (the repo `.gitignore` carries `.formula/*` plus the
//       `!.formula/config.json` exception) and
//       readable only by its owner: anything wider surfaces as a `SECRET_FILE_PERMISSIVE`
//       warning in the result, never silently accepted. A file that exists but cannot be read
//       or parsed is a STRUCTURED error (`SECRET_FILE_UNREADABLE` / `SECRET_FILE_MALFORMED` /
//       `SECRET_FILE_BAD_ENTRY`) — a data condition, not a thrown crash — and it short-circuits
//       the chain so a broken local config can never be silently masked by CI env.
//   (c) environment variables for CI — the documented convention `STEEPY_FORMULA_<SLOT>`
//       (`db-password` → `STEEPY_FORMULA_DB_PASSWORD`).
//
// A total miss resolves to `{ ok: false, code: 'NOT_FOUND', name }`; the caller decides what a
// missing credential means. The provider never prints or returns-to-a-logger a secret value:
// `describeSecret` is the only shape a caller should log, and it carries no `value`.
//
// SLOT NAMING CONVENTION (documented, spec §26): a slot is a lowercase kebab-case name such as
// `db-password` or `graph-token`. It becomes (1) the macOS keychain ACCOUNT name, (2) a key in
// `.formula/secrets.json`, and (3) an env var name — so it is held to a strict identifier that
// is also a safe argv entry for the `security` CLI (flag injection would otherwise be possible).
//
// The typed-actor helpers CONSUME B5's vocabulary (`ACTOR_TYPES` / `isActorType` /
// `validateRevisionMeta`) rather than re-declaring it: they are the one place every Revision
// writer (D5 apply, D1 topology writer, future F2/F3 CLI approver) builds its `{ type, id }`.
//
// This module has NO CLI and no CLI entry guard — command surfaces belong to F2/F3.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACTOR_TYPES, isActorType } from '../core/revision.mjs';
import { deepFreeze } from './port.mjs';

// --- documented constants (spec §26) ------------------------------------------------------------

// The macOS keychain service name: every slot is stored under this service, `<slot>` as the account.
export const KEYCHAIN_SERVICE = 'steepy-formula';

// The local non-committed config file, relative to the project root. Gitignored + 0600-enforced.
export const SECRETS_FILE_NAME = '.formula/secrets.json';

// The CI env-var prefix: `STEEPY_FORMULA_<SLOT>` with the slot uppercased and `-` → `_`.
export const ENV_PREFIX = 'STEEPY_FORMULA_';

// Capability probe account: `security find-generic-password` on a name that can never be a real
// slot. A missing item (status 44) still proves the CLI exists and is reachable; a spawn error
// (ENOENT) means the CLI is absent and the link is skipped.
export const KEYCHAIN_CAPABILITY_PROBE = '__steepy_formula_capability_probe__';

export const SECRET_VIOLATION_CODES = deepFreeze({
  NOT_FOUND: 'NOT_FOUND',
  SECRET_FILE_UNREADABLE: 'SECRET_FILE_UNREADABLE',
  SECRET_FILE_MALFORMED: 'SECRET_FILE_MALFORMED',
  SECRET_FILE_BAD_ENTRY: 'SECRET_FILE_BAD_ENTRY',
  SECRET_FILE_PERMISSIVE: 'SECRET_FILE_PERMISSIVE',
});

// --- defaults -----------------------------------------------------------------------------------

const defaultRunner = (argv) => spawnSync('security', argv, { encoding: 'utf8' });

const defaultFs = { readFileSync, statSync };

const defaultFilePath = () => join(process.cwd(), SECRETS_FILE_NAME);

// --- slot validation (programmer error only — a slot becomes a keychain argv entry) --------------

const SECRET_SLOT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function assertSecretSlot(name) {
  if (typeof name !== 'string' || !SECRET_SLOT_PATTERN.test(name)) {
    throw new TypeError(
      `resolveDatabaseSecret: invalid slot '${String(name)}': expected [a-z][a-z0-9-]{0,63} — a slot becomes a keychain account and an env var name.`,
    );
  }
  return name;
}

// --- the keychain link (macOS, capability-checked) ------------------------------------------------

// `security` present and `security find-generic-password` reachable — a spawn error (absent CLI)
// is the only thing that is NOT capable; any exit status (including a missing-item 44) proves the
// command runs.
export function keychainCapable(runner = defaultRunner, { service = KEYCHAIN_SERVICE } = {}) {
  const result = runner(['find-generic-password', '-a', KEYCHAIN_CAPABILITY_PROBE, '-s', service, '-w']);
  return !result || result.error === undefined || result.error === null;
}

function keychainFind(runner, slot, service) {
  const result = runner(['find-generic-password', '-a', slot, '-s', service, '-w']);
  // The CLI vanished mid-chain (or this is a fake that dropped it): treat as absent, never crash.
  if (!result || result.error) return undefined;
  if (result.status === 0 && typeof result.stdout === 'string') {
    const value = result.stdout.trim();
    if (value !== '') return value;
  }
  return undefined;
}

// --- the file link -------------------------------------------------------------------------------

function octal(mode) {
  return `0o${(mode & 0o777).toString(8)}`;
}

// Reads one slot from `.formula/secrets.json`. Returns `{ value }`, `{ value, warning }`, or
// `{ error }`. A missing file (ENOENT) is a normal miss at this link — only a file that EXISTS
// but misbehaves is a structured error.
function fileSecret(slot, { fs, filePath }) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { value: undefined };
    return {
      error: {
        code: SECRET_VIOLATION_CODES.SECRET_FILE_UNREADABLE,
        message: `cannot stat ${filePath}: ${String(error.message).slice(0, 120)}.`,
      },
    };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return {
      error: {
        code: SECRET_VIOLATION_CODES.SECRET_FILE_UNREADABLE,
        message: `cannot read ${filePath}: ${String(error.message).slice(0, 120)}.`,
      },
    };
  }

  let secrets;
  try {
    secrets = JSON.parse(raw);
  } catch (error) {
    return {
      error: {
        code: SECRET_VIOLATION_CODES.SECRET_FILE_MALFORMED,
        message: `cannot parse ${filePath}: ${String(error.message).slice(0, 120)}.`,
      },
    };
  }
  if (secrets === null || typeof secrets !== 'object' || Array.isArray(secrets)) {
    return {
      error: {
        code: SECRET_VIOLATION_CODES.SECRET_FILE_MALFORMED,
        message: `expected a flat JSON object of slot -> secret at ${filePath}, got ${JSON.stringify(secrets)?.slice(0, 120)}.`,
      },
    };
  }

  // 0600-enforced: any group/other permission bit is a warning-worthy condition — reported in the
  // result, never silently accepted. (The file-type bits sit above 0o777 and are masked out.)
  const warning =
    (stat.mode & 0o077) !== 0
      ? {
          code: SECRET_VIOLATION_CODES.SECRET_FILE_PERMISSIVE,
          message: `${filePath} is readable by more than its owner (mode ${octal(stat.mode)}); expected 0600.`,
        }
      : undefined;

  const entry = secrets[slot];
  if (entry === undefined) return { value: undefined, warning };
  if (typeof entry !== 'string' || entry === '') {
    return {
      error: {
        code: SECRET_VIOLATION_CODES.SECRET_FILE_BAD_ENTRY,
        message: `slot '${slot}' in ${filePath} must map to a non-empty string.`,
      },
    };
  }
  return { value: entry, warning };
}

// --- the env link --------------------------------------------------------------------------------

export function envVarFor(slot) {
  return `${ENV_PREFIX}${slot.toUpperCase().replaceAll('-', '_')}`;
}

// --- the chain -----------------------------------------------------------------------------------

// First hit wins: keychain -> file -> env. Never throws on data; TypeError only on programmer
// error (a bad slot name). `options` carries the injectable seams — the keychain `runner`, the
// file `fs` + `filePath`, the `env` object, and the keychain `service` — with production defaults.
export function resolveDatabaseSecret(name, options = {}) {
  const slot = assertSecretSlot(name);
  const {
    runner = defaultRunner,
    fs = defaultFs,
    env = process.env,
    filePath = defaultFilePath(),
    service = KEYCHAIN_SERVICE,
  } = options ?? {};

  if (keychainCapable(runner, { service })) {
    const fromKeychain = keychainFind(runner, slot, service);
    if (fromKeychain !== undefined) return { ok: true, name: slot, value: fromKeychain, source: 'keychain' };
  }

  const file = fileSecret(slot, { fs, filePath });
  if (file.error) return { ok: false, name: slot, ...file.error };
  if (file.value !== undefined) {
    const found = { ok: true, name: slot, value: file.value, source: 'file' };
    if (file.warning) found.warning = file.warning;
    return found;
  }

  const fromEnv = env[envVarFor(slot)];
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    const found = { ok: true, name: slot, value: fromEnv, source: 'env' };
    if (file.warning) found.warning = file.warning;
    return found;
  }

  // A permission warning discovered at the file link survives onto the NOT_FOUND result.
  return file.warning
    ? { ok: false, code: SECRET_VIOLATION_CODES.NOT_FOUND, name: slot, warning: file.warning }
    : { ok: false, code: SECRET_VIOLATION_CODES.NOT_FOUND, name: slot };
}

// The redacted summary a caller may log: never carries `value`, and carries a `warning` only when
// one surfaced. This is the ceiling for provider logging (C1's decodeProperties 120-char note
// applies to any error text the caller chooses to embed elsewhere).
export function describeSecret(result) {
  if (!result || typeof result !== 'object') return { ok: false };
  const summary = { name: result.name, ok: result.ok };
  if (result.ok) summary.source = result.source;
  else if (result.code !== undefined) summary.code = result.code;
  if (result.warning) summary.warning = result.warning;
  return summary;
}

// --- typed actor helpers (spec §26) ---------------------------------------------------------------

// Builds the closed `{ type, id: name }` shape `validateRevisionMeta` accepts. `type` is judged by
// B5's `isActorType` and `name` must be a non-empty string — anything else is programmer error.
export function actor(type, name) {
  if (!isActorType(type)) {
    throw new TypeError(`actor: unknown actor type '${String(type)}'; expected one of: ${ACTOR_TYPES.join(', ')}.`);
  }
  if (typeof name !== 'string' || name === '') {
    throw new TypeError('actor: name must be a non-empty string.');
  }
  return { type, id: name };
}

export const actorFrom = actor;
