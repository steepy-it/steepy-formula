// Project-config suite (project-identity-binding Task 1, spec D2/D3).
//
// UNIT layer (always runs): the core module over mkdtempSync roots — never a write into this
// repo (tests surface standard). Every assertion is observable behavior: return values,
// thrown error names/messages, and the exact bytes on disk. The decision table under test:
//
//   readProjectConfig      absent -> null · unreadable/invalid-JSON/invalid-id -> operational
//                          Error naming the exact path (+ value for a bad id) · unknown
//                          top-level keys ignored (spec D2 forward compatibility)
//   writeProjectConfig     validate first, then atomic write (temp + rename, same dir); the
//                          file shape is normalized `{"projectId": "<id>"}` — 2-space JSON +
//                          trailing newline
//   adoptProjectBinding    the D3-adoption matrix: no-config write (explicit or fallback
//                          source), matching-config no-op, explicit-source mismatch refusal,
//                          --force rewrite carrying previousId for the old -> new echo
//
// Error discipline (core-module standard of hub-mode.mjs): `Error` on data conditions
// (operational — the CLI maps them to exit 3), `TypeError` on programmer error (closed input
// keys, mis-shaped arguments).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_SOURCES,
  adoptProjectBinding,
  readProjectConfig,
  validateProjectConfig,
  writeProjectConfig,
} from '../scripts/formula/core/project-config.mjs';

// --- temp fixtures ---------------------------------------------------------------------------------

const tempRoots = [];

test.after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function configPath(root) {
  return join(root, '.formula', 'config.json');
}

// A hand-placed config file with arbitrary (valid-JSON, valid-id) bytes — for proving that a
// code path did NOT rewrite the file, the bytes must be distinguishable from the normalized shape.
function placeRawConfig(root, text) {
  mkdirSync(join(root, '.formula'), { recursive: true });
  writeFileSync(configPath(root), text);
  return text;
}

// --- readProjectConfig ------------------------------------------------------------------------------

test('readProjectConfig: an absent config is null — never a silent fallback', () => {
  assert.equal(readProjectConfig(tempDir('steepy-projcfg-absent-')), null);
});

test('readProjectConfig: a round-trip through writeProjectConfig returns the bound id', () => {
  const root = tempDir('steepy-projcfg-roundtrip-');
  writeProjectConfig(root, 'acme-web');
  assert.deepEqual(readProjectConfig(root), { projectId: 'acme-web' });
});

test('readProjectConfig: unknown top-level keys are ignored (spec D2 forward compatibility)', () => {
  const root = tempDir('steepy-projcfg-unknown-');
  placeRawConfig(root, '{"projectId": "acme-web", "schemaVersion": 7, "future": {"nested": true}}');
  assert.deepEqual(readProjectConfig(root), { projectId: 'acme-web' });
});

test('readProjectConfig: an unreadable file is an operational Error naming the exact path', () => {
  const root = tempDir('steepy-projcfg-unreadable-');
  // A directory where the file should be: a read fails deterministically (EISDIR) without
  // depending on file permissions or process privileges.
  mkdirSync(configPath(root), { recursive: true });
  assert.throws(
    () => readProjectConfig(root),
    (error) => {
      assert.equal(error.name, 'Error', 'a data condition, not a programmer TypeError');
      assert.ok(error.message.includes(configPath(root)), `path named in: ${error.message}`);
      return true;
    },
  );
});

test('readProjectConfig: invalid JSON is an operational Error naming the exact path', () => {
  const root = tempDir('steepy-projcfg-badjson-');
  placeRawConfig(root, 'not json {');
  assert.throws(
    () => readProjectConfig(root),
    (error) => {
      assert.equal(error.name, 'Error');
      assert.ok(error.message.includes(configPath(root)), `path named in: ${error.message}`);
      return true;
    },
  );
});

test('readProjectConfig: JSON that is not an object is an operational Error naming the exact path', () => {
  for (const text of ['"demo"', '42', 'null']) {
    const root = tempDir('steepy-projcfg-shape-');
    placeRawConfig(root, text);
    assert.throws(
      () => readProjectConfig(root),
      (error) => {
        assert.equal(error.name, 'Error');
        assert.ok(error.message.includes(configPath(root)), `path named in: ${error.message}`);
        return true;
      },
    );
  }
});

test('readProjectConfig: an invalid projectId throws naming the path AND the value', () => {
  const root = tempDir('steepy-projcfg-badid-');
  placeRawConfig(root, '{"projectId": "Not Valid"}');
  assert.throws(
    () => readProjectConfig(root),
    (error) => {
      assert.equal(error.name, 'Error');
      assert.ok(error.message.includes(configPath(root)), `path named in: ${error.message}`);
      assert.ok(error.message.includes('Not Valid'), `value named in: ${error.message}`);
      return true;
    },
  );
});

test('readProjectConfig: a missing projectId is the same operational Error naming the path', () => {
  const root = tempDir('steepy-projcfg-noid-');
  placeRawConfig(root, '{}');
  assert.throws(
    () => readProjectConfig(root),
    (error) => {
      assert.equal(error.name, 'Error');
      assert.ok(error.message.includes(configPath(root)), `path named in: ${error.message}`);
      return true;
    },
  );
});

// --- validateProjectConfig (the single validation authority) ----------------------------------------

test('validateProjectConfig: returns the normalized { projectId }, dropping unknown keys', () => {
  assert.deepEqual(validateProjectConfig({ projectId: 'acme-web', anything: 1 }), { projectId: 'acme-web' });
});

test('validateProjectConfig: a non-object candidate is a data Error; a known path lands in the message', () => {
  for (const candidate of ['demo', 42, null, true, []]) {
    assert.throws(
      () => validateProjectConfig(candidate, { path: '/tmp/repo/.formula/config.json' }),
      (error) => {
        assert.equal(error.name, 'Error', 'parsed JSON can be any shape — data, not programmer error');
        assert.ok(error.message.includes('/tmp/repo/.formula/config.json'), `path named in: ${error.message}`);
        return true;
      },
    );
  }
});

test('validateProjectConfig: an invalid projectId names the value (and the path when known)', () => {
  assert.throws(
    () => validateProjectConfig({ projectId: 'Bad_Id' }, { path: '/tmp/repo/.formula/config.json' }),
    (error) => {
      assert.equal(error.name, 'Error');
      assert.ok(error.message.includes('Bad_Id'), `value named in: ${error.message}`);
      assert.ok(error.message.includes('/tmp/repo/.formula/config.json'), `path named in: ${error.message}`);
      return true;
    },
  );
});

test('validateProjectConfig: programmer errors are TypeErrors (unknown context key, non-string path)', () => {
  assert.throws(() => validateProjectConfig({ projectId: 'x' }, { bogus: 1 }), TypeError);
  assert.throws(() => validateProjectConfig({ projectId: 'x' }, { path: 7 }), TypeError);
});

// --- writeProjectConfig -----------------------------------------------------------------------------

test('writeProjectConfig: normalized bytes on disk — 2-space JSON + trailing newline, exactly', () => {
  const root = tempDir('steepy-projcfg-bytes-');
  writeProjectConfig(root, 'acme-web');
  assert.equal(readFileSync(configPath(root), 'utf8'), '{\n  "projectId": "acme-web"\n}\n');
});

test('writeProjectConfig: creates the .formula directory and leaves no temp file behind', () => {
  const root = tempDir('steepy-projcfg-mkdir-');
  writeProjectConfig(root, 'acme-web');
  assert.deepEqual(readdirSync(join(root, '.formula')), ['config.json']);
});

test('writeProjectConfig: validates first — an invalid id is an Error naming the target path and value', () => {
  const root = tempDir('steepy-projcfg-writebad-');
  assert.throws(
    () => writeProjectConfig(root, 'Bad_Id'),
    (error) => {
      assert.equal(error.name, 'Error');
      assert.ok(error.message.includes(configPath(root)), `path named in: ${error.message}`);
      assert.ok(error.message.includes('Bad_Id'), `value named in: ${error.message}`);
      return true;
    },
  );
  assert.equal(readProjectConfig(root), null, 'nothing was written');
});

// --- adoptProjectBinding: the D3-adoption matrix ----------------------------------------------------

test('adopt: no config + an explicit flag request writes the binding', () => {
  const root = tempDir('steepy-adopt-write-');
  const result = adoptProjectBinding({ root, requested: 'acme-web', requestedSource: 'flag' });
  assert.deepEqual(result, { action: 'written', projectId: 'acme-web' });
  assert.deepEqual(readProjectConfig(root), { projectId: 'acme-web' });
});

test('adopt: no config + the fallback source also writes (the precedence tail binds a bare repo)', () => {
  const root = tempDir('steepy-adopt-fallback-');
  const result = adoptProjectBinding({ root, requested: 'demo', requestedSource: 'fallback' });
  assert.deepEqual(result, { action: 'written', projectId: 'demo' });
  assert.deepEqual(readProjectConfig(root), { projectId: 'demo' });
});

test('adopt: a matching config is unchanged — the file bytes are not even touched', () => {
  const root = tempDir('steepy-adopt-unchanged-');
  const raw = placeRawConfig(root, '{"projectId":"acme-web","note":"hand-written"}');
  const result = adoptProjectBinding({ root, requested: 'acme-web', requestedSource: 'flag' });
  assert.deepEqual(result, { action: 'unchanged', projectId: 'acme-web' });
  assert.equal(readFileSync(configPath(root), 'utf8'), raw, 'no rewrite: still the hand-written bytes');
});

test('adopt: a flag-source mismatch is refused and the existing binding survives', () => {
  const root = tempDir('steepy-adopt-refuse-');
  placeRawConfig(root, '{"projectId": "old-proj"}');
  const result = adoptProjectBinding({ root, requested: 'acme-web', requestedSource: 'flag' });
  assert.deepEqual(result, { action: 'refused', projectId: 'old-proj' });
  assert.deepEqual(readProjectConfig(root), { projectId: 'old-proj' });
});

test('adopt: an env-source mismatch is refused too (every explicit source is guarded)', () => {
  const root = tempDir('steepy-adopt-refuse-env-');
  placeRawConfig(root, '{"projectId": "old-proj"}');
  const result = adoptProjectBinding({ root, requested: 'acme-web', requestedSource: 'env' });
  assert.deepEqual(result, { action: 'refused', projectId: 'old-proj' });
});

test('adopt: force rewrites and returns previousId for the old -> new echo', () => {
  const root = tempDir('steepy-adopt-rewrite-');
  placeRawConfig(root, '{"projectId": "old-proj"}');
  const result = adoptProjectBinding({ root, requested: 'acme-web', requestedSource: 'flag', force: true });
  assert.deepEqual(result, { action: 'rewritten', projectId: 'acme-web', previousId: 'old-proj' });
  assert.deepEqual(readProjectConfig(root), { projectId: 'acme-web' });
  assert.equal(readFileSync(configPath(root), 'utf8'), '{\n  "projectId": "acme-web"\n}\n', 'normalized on rewrite');
});

test('adopt: a corrupt config surfaces the operational Error — never a silent fallback', () => {
  const root = tempDir('steepy-adopt-corrupt-');
  placeRawConfig(root, 'not json');
  assert.throws(
    () => adoptProjectBinding({ root, requested: 'acme-web', requestedSource: 'flag' }),
    (error) => {
      assert.equal(error.name, 'Error');
      assert.ok(error.message.includes(configPath(root)), `path named in: ${error.message}`);
      return true;
    },
  );
});

test('PROJECT_SOURCES is the closed D3 echo-source vocabulary', () => {
  assert.deepEqual([...PROJECT_SOURCES], ['flag', 'env', 'config', 'fallback']);
});

// --- programmer errors are TypeErrors (core-module standard) ----------------------------------------

test('adoptProjectBinding throws TypeErrors on mis-shaped input', () => {
  const root = tempDir('steepy-adopt-te-');
  assert.throws(() => adoptProjectBinding('nope'), TypeError);
  assert.throws(() => adoptProjectBinding({ root, requested: 'x', requestedSource: 'flag', bogus: true }), TypeError);
  assert.throws(() => adoptProjectBinding({ root, requested: 'Bad Id', requestedSource: 'flag' }), TypeError);
  assert.throws(() => adoptProjectBinding({ root, requested: 'x', requestedSource: 'cli' }), TypeError);
  assert.throws(() => adoptProjectBinding({ root, requested: 'x', requestedSource: 'flag', force: 'yes' }), TypeError);
  assert.throws(() => adoptProjectBinding({ root: '', requested: 'x', requestedSource: 'flag' }), TypeError);
});

test('readProjectConfig / writeProjectConfig throw TypeErrors on a bad root', () => {
  assert.throws(() => readProjectConfig(123), TypeError);
  assert.throws(() => readProjectConfig(''), TypeError);
  assert.throws(() => writeProjectConfig(7, 'x'), TypeError);
  assert.throws(() => writeProjectConfig('', 'x'), TypeError);
});

// --- the binding file is a committed repository artifact ---------------------------------------------

// D2: `.formula/config.json` is the repository's SHARED identity, so the repo's own `.gitignore`
// must carve it out of the ignored `.formula/` state directory. The ignore line is `.formula/*`,
// not `.formula/`: Git cannot re-include a file inside an ignored directory (the same reason the
// skills exception pairs `.claude/skills/*` with `!.claude/skills/steepy-formula-bootstrap`).
// Read-only check — this suite never writes into the repo.
test('the repo .gitignore carries the !.formula/config.json exception directly after .formula/*', () => {
  const lines = readFileSync(fileURLToPath(new URL('../.gitignore', import.meta.url)), 'utf8').split('\n');
  const ignoredAt = lines.indexOf('.formula/*');
  assert.notEqual(ignoredAt, -1, '.formula/* stays ignored (secrets.json etc.)');
  assert.equal(lines.indexOf('.formula/'), -1, 'a bare .formula/ pattern would hide the binding too');
  assert.equal(lines[ignoredAt + 1], '!.formula/config.json', 'the binding file is the immediate exception');
});
