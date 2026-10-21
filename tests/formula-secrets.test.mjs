// Adapter-based secret provider chain + typed actor helpers (Task F1, spec §26).
//
// The chain is: OS keychain first (capability-checked), then the local non-committed
// `.formula/secrets.json`, then environment variables for CI — first hit wins, and a total
// miss resolves to NOT_FOUND, never a thrown crash. Every external accessor is injected: the
// keychain runner (fake here), the file `fs` (REAL — the file/perm paths are exercised against
// actual on-disk files in a temp dir, per the brief's "file and env paths real"), and the
// environment object. Only the keychain is mocked.
//
// The typed-actor helpers must consume B5's vocabulary (isActorType / ACTOR_TYPES /
// validateRevisionMeta) — they are the one source of truth every Revision writer uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTOR_TYPES,
  isActorType,
  validateRevisionMeta,
} from '../scripts/formula/core/revision.mjs';
import {
  ENV_PREFIX,
  KEYCHAIN_CAPABILITY_PROBE,
  KEYCHAIN_SERVICE,
  SECRETS_FILE_NAME,
  SECRET_VIOLATION_CODES,
  actor,
  actorFrom,
  describeSecret,
  envVarFor,
  keychainCapable,
  resolveDatabaseSecret,
} from '../scripts/formula/engine/secrets.mjs';

// --- the two documented naming conventions under test -----------------------------------------

test('the env-var convention maps every slot to a STEEPY_FORMULA_* variable', () => {
  assert.equal(ENV_PREFIX, 'STEEPY_FORMULA_');
  assert.equal(envVarFor('db-password'), 'STEEPY_FORMULA_DB_PASSWORD');
  assert.equal(envVarFor('graph-token'), 'STEEPY_FORMULA_GRAPH_TOKEN');
  assert.equal(envVarFor('db-password'), `STEEPY_FORMULA_${'db-password'.toUpperCase().replaceAll('-', '_')}`);
});

test('the keychain service name and the secrets file name are the documented constants', () => {
  assert.equal(KEYCHAIN_SERVICE, 'steepy-formula');
  assert.equal(SECRETS_FILE_NAME, '.formula/secrets.json');
});

// --- typed actor helpers (the one source of truth for Revision writers) ------------------------

test('actor builds the closed { type, id } shape every actor type accepts', () => {
  for (const type of ACTOR_TYPES) {
    const identity = actor(type, 'someone');
    assert.deepEqual(identity, { type, id: 'someone' });
    assert.equal(isActorType(identity.type), true);
    const violations = validateRevisionMeta({
      projectId: 'demo',
      proposer: identity,
      approver: identity,
      provenance: [{ quotation: 'quoted', source: 'docs/spec.md:52', digest: 'a'.repeat(64) }],
    });
    assert.deepEqual(violations, [], type);
  }
});

test('actor rejects an unknown type and a blank name as programmer error', () => {
  for (const type of ['root', '', 'HUMAN-APPROVER', 42, null, undefined]) {
    assert.throws(() => actor(type, 'x'), TypeError, String(type));
  }
  for (const name of ['', 42, null, undefined]) {
    assert.throws(() => actor('human-approver', name), TypeError, String(name));
  }
  assert.deepEqual(actor('human-approver', 'someone'), { type: 'human-approver', id: 'someone' });
});

test('actorFrom is the same helper under its spelled-out name', () => {
  assert.equal(actorFrom, actor);
  assert.deepEqual(actorFrom('migration', 'schema-v2'), { type: 'migration', id: 'schema-v2' });
});

// --- fakes --------------------------------------------------------------------------------------

const OK = { status: 0, stdout: '', stderr: '' };
const NOT_FOUND = { status: 44, stdout: '', stderr: 'SecKeychainSearchCopyNext: The specified item could not be found.' };
const ENOENT = { error: new Error('spawn security ENOENT'), status: null, stdout: '', stderr: '' };

function findArgs(slot, service = KEYCHAIN_SERVICE) {
  return `find-generic-password -a ${slot} -s ${service} -w`;
}

function probeArgs() {
  return findArgs(KEYCHAIN_CAPABILITY_PROBE);
}

// A fake `security` runner keyed by the joined argv. Calls are recorded so a test can assert
// exactly what reached the CLI (e.g. that a skipped keychain never performed the find).
function runnerWith(results) {
  const calls = [];
  const runner = (argv) => {
    calls.push(argv.join(' '));
    return results[argv.join(' ')] ?? NOT_FOUND;
  };
  runner.calls = calls;
  return runner;
}

function keychainHit(slot, value, service = KEYCHAIN_SERVICE) {
  return { [probeArgs()]: OK, [findArgs(slot, service)]: { status: 0, stdout: `${value}\n`, stderr: '' } };
}

// A real on-disk `.formula/secrets.json` in a temp dir, so the file path is exercised for real.
function tempSecretsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'steepy-secrets-'));
  mkdirSync(join(dir, '.formula'));
  return dir;
}

function writeSecretsFile(dir, contents) {
  const filePath = join(dir, SECRETS_FILE_NAME);
  writeFileSync(filePath, contents, { mode: 0o600 });
  return filePath;
}

function noFileOptions(dir) {
  return { filePath: join(dir, '.formula', 'secrets.json') };
}

function withFile(dir, contents, env = {}) {
  const filePath = writeSecretsFile(dir, contents);
  return { filePath, env };
}

// The real macOS keychain must never answer a test: on a machine where `graph init` stored the real
// password it wins the chain, and a failing assertion would print it. Tests that are not about the
// keychain link pass this runner, which reports the `security` CLI as absent.
function absentKeychain() {
  return runnerWith({ [probeArgs()]: ENOENT });
}

// --- precedence: first hit wins -----------------------------------------------------------------

test('keychain beats file beats env when all three links hold the slot', () => {
  const dir = tempSecretsDir();
  try {
    const { filePath, env } = withFile(dir, JSON.stringify({ 'db-password': 'from-file' }), {
      STEEPY_FORMULA_DB_PASSWORD: 'from-env',
    });
    const runner = runnerWith(keychainHit('db-password', 'from-keychain'));
    const result = resolveDatabaseSecret('db-password', { runner, filePath, env });
    assert.deepEqual(result, { ok: true, name: 'db-password', value: 'from-keychain', source: 'keychain' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file beats env when the keychain has no item', () => {
  const dir = tempSecretsDir();
  try {
    const { filePath, env } = withFile(dir, JSON.stringify({ 'db-password': 'from-file' }), {
      STEEPY_FORMULA_DB_PASSWORD: 'from-env',
    });
    const runner = runnerWith({ [probeArgs()]: OK });
    const result = resolveDatabaseSecret('db-password', { runner, filePath, env });
    assert.deepEqual(result, { ok: true, name: 'db-password', value: 'from-file', source: 'file' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('env alone resolves when the keychain is absent and the file is missing', () => {
  const dir = tempSecretsDir();
  try {
    const runner = runnerWith({ [probeArgs()]: ENOENT });
    const result = resolveDatabaseSecret('db-password', {
      runner,
      ...noFileOptions(dir),
      env: { STEEPY_FORMULA_DB_PASSWORD: 'from-env' },
    });
    assert.deepEqual(result, { ok: true, name: 'db-password', value: 'from-env', source: 'env' });
    assert.deepEqual(runner.calls, [probeArgs()], 'a skipped keychain never performs the find');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keychain alone resolves when the file is missing and the env is empty', () => {
  const dir = tempSecretsDir();
  try {
    const runner = runnerWith(keychainHit('db-password', 'from-keychain'));
    const result = resolveDatabaseSecret('db-password', { runner, ...noFileOptions(dir), env: {} });
    assert.deepEqual(result, { ok: true, name: 'db-password', value: 'from-keychain', source: 'keychain' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file alone resolves when the keychain is absent and the env is empty', () => {
  const dir = tempSecretsDir();
  try {
    const { filePath } = withFile(dir, JSON.stringify({ 'db-password': 'from-file' }));
    const runner = runnerWith({ [probeArgs()]: ENOENT });
    const result = resolveDatabaseSecret('db-password', { runner, filePath, env: {} });
    assert.deepEqual(result, { ok: true, name: 'db-password', value: 'from-file', source: 'file' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- keychain capability handling ---------------------------------------------------------------

test('keychainCapable is true when security answers and false when the CLI is absent', () => {
  assert.equal(keychainCapable(runnerWith({ [probeArgs()]: OK })), true);
  assert.equal(keychainCapable(runnerWith({ [probeArgs()]: NOT_FOUND })), true, 'a missing item still proves the CLI works');
  assert.equal(keychainCapable(runnerWith({ [probeArgs()]: ENOENT })), false);
});

test('an absent keychain CLI is skipped, never fatal', () => {
  const dir = tempSecretsDir();
  try {
    const runner = runnerWith({ [probeArgs()]: ENOENT });
    const result = resolveDatabaseSecret('db-password', { runner, ...noFileOptions(dir), env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_FOUND');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing keychain item is a normal miss, not an error, and the chain continues', () => {
  const dir = tempSecretsDir();
  try {
    const runner = runnerWith({ [probeArgs()]: OK });
    const result = resolveDatabaseSecret('db-password', { runner, ...noFileOptions(dir), env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_FOUND');
    assert.ok(runner.calls.includes(findArgs('db-password')), 'the find must actually run before concluding');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the keychain find reaches the CLI with the documented account and service', () => {
  const dir = tempSecretsDir();
  try {
    const runner = runnerWith(keychainHit('db-password', 'pw'));
    resolveDatabaseSecret('db-password', { runner, ...noFileOptions(dir), env: {} });
    assert.deepEqual(runner.calls, [probeArgs(), findArgs('db-password')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the file link: permissions and structure ---------------------------------------------------

test('a 0600 secrets file resolves without a permission warning', () => {
  const dir = tempSecretsDir();
  try {
    const { filePath } = withFile(dir, JSON.stringify({ 'db-password': 'from-file' }));
    const result = resolveDatabaseSecret('db-password', { runner: absentKeychain(), filePath, env: {} });
    assert.deepEqual(result, { ok: true, name: 'db-password', value: 'from-file', source: 'file' });
    assert.equal(result.warning, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a world-readable secrets file is surfaced as a warning, never silently accepted', () => {
  const dir = tempSecretsDir();
  try {
    const { filePath } = withFile(dir, JSON.stringify({ 'db-password': 'from-file' }));
    chmodSync(filePath, 0o644);
    const result = resolveDatabaseSecret('db-password', { runner: absentKeychain(), filePath, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.value, 'from-file');
    assert.equal(result.source, 'file');
    assert.equal(result.warning?.code, SECRET_VIOLATION_CODES.SECRET_FILE_PERMISSIVE);
    assert.match(result.warning.message, /0600/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the permission warning is carried onto an env fallback, not dropped', () => {
  const dir = tempSecretsDir();
  try {
    const { filePath } = withFile(dir, JSON.stringify({ other: 'x' }));
    chmodSync(filePath, 0o644);
    const result = resolveDatabaseSecret('db-password', {
      runner: absentKeychain(),
      filePath,
      env: { STEEPY_FORMULA_DB_PASSWORD: 'from-env' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.name, 'db-password');
    assert.equal(result.value, 'from-env');
    assert.equal(result.source, 'env');
    assert.equal(result.warning?.code, SECRET_VIOLATION_CODES.SECRET_FILE_PERMISSIVE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the file link: structured errors, never throws on data -------------------------------------

test('a malformed secrets file resolves to a structured error, not a throw', () => {
  const dir = tempSecretsDir();
  try {
    const { filePath } = withFile(dir, '{ not json');
    const result = resolveDatabaseSecret('db-password', { runner: absentKeychain(), filePath, env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, SECRET_VIOLATION_CODES.SECRET_FILE_MALFORMED);
    assert.equal(result.name, 'db-password');
    assert.equal(result.value, undefined);
    assert.match(result.message, /parse/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-object secrets file resolves to a structured error, not a throw', () => {
  const dir = tempSecretsDir();
  try {
    const { filePath } = withFile(dir, '[1,2,3]');
    const result = resolveDatabaseSecret('db-password', { runner: absentKeychain(), filePath, env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, SECRET_VIOLATION_CODES.SECRET_FILE_MALFORMED);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a slot mapped to a non-string resolves to a structured error, not a throw', () => {
  const dir = tempSecretsDir();
  try {
    const { filePath } = withFile(dir, JSON.stringify({ 'db-password': 12345 }));
    const result = resolveDatabaseSecret('db-password', { runner: absentKeychain(), filePath, env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, SECRET_VIOLATION_CODES.SECRET_FILE_BAD_ENTRY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- total miss ---------------------------------------------------------------------------------

test('a missing secret at every link resolves to NOT_FOUND, never a throw', () => {
  const dir = tempSecretsDir();
  try {
    const runner = runnerWith({ [probeArgs()]: OK });
    const result = resolveDatabaseSecret('db-password', { runner, ...noFileOptions(dir), env: {} });
    assert.deepEqual(result, { ok: false, code: 'NOT_FOUND', name: 'db-password' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- slot validation (programmer error only) ----------------------------------------------------

test('resolveDatabaseSecret refuses a slot that is not a safe keychain account name', () => {
  for (const bad of ['', 'UPPER', 'a b', 'a/b', 'a;id', 42, null, undefined, 'x'.repeat(65)]) {
    assert.throws(() => resolveDatabaseSecret(bad, { runner: absentKeychain(), env: {} }), TypeError, String(bad));
  }
  const dir = tempSecretsDir();
  try {
    assert.equal(resolveDatabaseSecret('db-password', { runner: absentKeychain(), ...noFileOptions(dir), env: {} }).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- redacted logging ---------------------------------------------------------------------------

test('describeSecret gives a caller a redacted { name, ok, source } summary, never the value', () => {
  const dir = tempSecretsDir();
  try {
    const { filePath } = withFile(dir, JSON.stringify({ 'db-password': 'from-file' }));
    const found = resolveDatabaseSecret('db-password', { runner: absentKeychain(), filePath, env: {} });
    const summary = describeSecret(found);
    assert.equal('value' in summary, false, 'the secret value must never reach a log summary');
    assert.deepEqual(summary, { name: 'db-password', ok: true, source: 'file' });

    const missing = resolveDatabaseSecret('graph-token', { runner: absentKeychain(), filePath, env: {} });
    assert.deepEqual(describeSecret(missing), { name: 'graph-token', ok: false, code: 'NOT_FOUND' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDatabaseSecret never prints the secret value', () => {
  const dir = tempSecretsDir();
  try {
    const logs = [];
    const original = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      const { filePath } = withFile(dir, JSON.stringify({ 'db-password': 'super-secret-value' }));
      resolveDatabaseSecret('db-password', { runner: absentKeychain(), filePath, env: {} });
    } finally {
      console.log = original;
    }
    assert.deepEqual(logs, [], 'the provider must be silent; only callers may log a redacted summary');
    assert.ok(logs.every((line) => !line.includes('super-secret-value')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the repo must ignore the local secrets file ------------------------------------------------

// `.formula/*`, not `.formula/`: Git cannot re-include a file inside an ignored directory, so a bare
// directory pattern would silently hide the committed `.formula/config.json` binding as well.
test('the repo .gitignore ignores .formula/ contents but keeps the config.json binding committable', () => {
  const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(gitignore, /^\.formula\/\*\s*$/m, '.gitignore must ignore everything under .formula/');
  assert.doesNotMatch(gitignore, /^\.formula\/\s*$/m, 'a bare .formula/ pattern cannot be re-included');
  assert.match(gitignore, /^!\.formula\/config\.json\s*$/m, 'the project binding must stay committable');
});
