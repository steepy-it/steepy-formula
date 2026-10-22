// The fs-only steepy-apex area helper (scripts/formula/core/markdown-hub.mjs) — the ONE place a
// leftover `.apex/` (the `migrate` state) and a steepy-apex Markdown hub inside it
// (`.apex/_INDEX.md`) are detected, shared by `hub-mode` and every workflow script that refuses
// to run in the `migrate` state.
//
// Hermetic: `.apex/` entries are created only inside mkdtemp dirs, never in this repository; the
// injected-`fs` cases never touch the disk at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_AREA,
  MARKDOWN_HUB_ENTRY,
  MIGRATE_REFUSAL_EXIT,
  MIGRATE_REFUSAL_MESSAGE,
  legacyAreaPresent,
  markdownHubPresent,
  migrateRefusal,
} from '../scripts/formula/core/markdown-hub.mjs';

const modulePath = fileURLToPath(new URL('../scripts/formula/core/markdown-hub.mjs', import.meta.url));

// --- temp fixtures -----------------------------------------------------------------------------

const tempRoots = [];

test.after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function markdownHubDir() {
  const dir = tempDir('steepy-markdown-hub-present-');
  mkdirSync(join(dir, '.apex'));
  writeFileSync(join(dir, '.apex', '_INDEX.md'), '# Markdown Hub\n');
  return dir;
}

// A leftover formula v1 area: local state only, no Markdown hub.
function leftoverAreaDir() {
  const dir = tempDir('steepy-markdown-hub-leftover-');
  mkdirSync(join(dir, '.apex', 'work', 'specs'), { recursive: true });
  return dir;
}

const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

// --- the exported contract ---------------------------------------------------------------------

test('the contract constants: area and entry paths, dedicated refusal exit 25, one-line message naming graph-migrate', () => {
  assert.equal(LEGACY_AREA, '.apex');
  assert.equal(MARKDOWN_HUB_ENTRY, '.apex/_INDEX.md');
  assert.equal(MIGRATE_REFUSAL_EXIT, 25);
  assert.equal(
    MIGRATE_REFUSAL_MESSAGE,
    'this repository still carries a steepy-apex .apex/ area; run the graph-migrate skill to migrate it into the Stable Knowledge Graph and remove it first.',
  );
  assert.doesNotMatch(MIGRATE_REFUSAL_MESSAGE, /\n/, 'the refusal message is one line');
  assert.doesNotMatch(MIGRATE_REFUSAL_MESSAGE, /_INDEX/, 'the refusal never narrows the area to its hub entry');
});

// --- legacyAreaPresent ---------------------------------------------------------------------------

test('legacyAreaPresent: any .apex entry is present — a hub, leftover local state, a file, or a dangling link', () => {
  assert.equal(legacyAreaPresent(markdownHubDir()), true);
  assert.equal(legacyAreaPresent(leftoverAreaDir()), true);
  const file = tempDir('steepy-markdown-hub-file-');
  writeFileSync(join(file, '.apex'), 'not a directory');
  assert.equal(legacyAreaPresent(file), true);
  const dangling = tempDir('steepy-markdown-hub-dangling-');
  symlinkSync(join(dangling, 'missing'), join(dangling, '.apex'));
  assert.equal(legacyAreaPresent(dangling), true);
});

test('legacyAreaPresent: a root without .apex is absent, whatever .formula/ holds', () => {
  assert.equal(legacyAreaPresent(tempDir('steepy-markdown-hub-empty-')), false);
  const formulaOnly = tempDir('steepy-markdown-hub-formula-only-');
  mkdirSync(join(formulaOnly, '.formula', 'work'), { recursive: true });
  assert.equal(legacyAreaPresent(formulaOnly), false);
});

test('legacyAreaPresent: the injected fs seam probes exactly <rootDir>/.apex; only ENOENT/ENOTDIR mean absent', () => {
  const probed = [];
  assert.equal(legacyAreaPresent('/virtual/repo', { lstatSync: (path) => { probed.push(path); return {}; } }), true);
  assert.deepEqual(probed, [join('/virtual/repo', '.apex')]);
  assert.equal(legacyAreaPresent('/virtual/repo', { lstatSync: enoent }), false);
  const enotdir = () => { throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' }); };
  assert.equal(legacyAreaPresent('/virtual/repo', { lstatSync: enotdir }), false);
  // an entry that cannot be inspected is treated as present: the scripts refuse rather than guess
  const eacces = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  assert.equal(legacyAreaPresent('/virtual/repo', { lstatSync: eacces }), true);
});

test('legacyAreaPresent throws a TypeError on a non-string or empty rootDir, or an fs without lstatSync', () => {
  for (const rootDir of [undefined, null, 42, '', {}]) {
    assert.throws(() => legacyAreaPresent(rootDir), TypeError, `rootDir ${JSON.stringify(rootDir)}`);
  }
  for (const fs of [null, {}, { lstatSync: 'nope' }, 'fs']) {
    assert.throws(() => legacyAreaPresent('/virtual/repo', fs), TypeError, `fs ${JSON.stringify(fs)}`);
  }
});

// --- markdownHubPresent --------------------------------------------------------------------------

test('markdownHubPresent: a root holding .apex/_INDEX.md is present', () => {
  assert.equal(markdownHubPresent(markdownHubDir()), true);
});

test('markdownHubPresent: a root without .apex/_INDEX.md is absent (leftover local state is not a hub)', () => {
  assert.equal(markdownHubPresent(tempDir('steepy-markdown-hub-empty-')), false);
  assert.equal(markdownHubPresent(leftoverAreaDir()), false);
});

test('markdownHubPresent: the injected fs seam decides, probing exactly <rootDir>/.apex/_INDEX.md', () => {
  const probed = [];
  const present = markdownHubPresent('/virtual/repo', {
    existsSync: (path) => {
      probed.push(path);
      return path === join('/virtual/repo', '.apex/_INDEX.md');
    },
  });
  assert.equal(present, true);
  assert.deepEqual(probed, [join('/virtual/repo', '.apex/_INDEX.md')]);
  assert.equal(markdownHubPresent('/virtual/repo', { existsSync: () => false }), false);
  // only a literal `true` counts as present — a truthy non-boolean is not a hub
  assert.equal(markdownHubPresent('/virtual/repo', { existsSync: () => 'yes' }), false);
});

test('markdownHubPresent throws a TypeError on a non-string or empty rootDir, or an fs without existsSync', () => {
  for (const rootDir of [undefined, null, 42, '', {}]) {
    assert.throws(() => markdownHubPresent(rootDir), TypeError, `rootDir ${JSON.stringify(rootDir)}`);
  }
  for (const fs of [null, {}, { existsSync: 'nope' }, 'fs']) {
    assert.throws(() => markdownHubPresent('/virtual/repo', fs), TypeError, `fs ${JSON.stringify(fs)}`);
  }
});

// --- migrateRefusal ------------------------------------------------------------------------------

test('migrateRefusal: no .apex area means no refusal (null)', () => {
  assert.equal(migrateRefusal(tempDir('steepy-markdown-hub-empty-')), null);
  assert.equal(migrateRefusal('/virtual/repo', { fs: { lstatSync: enoent } }), null);
});

test('migrateRefusal: a hub or leftover local state yields the frozen { code: 25, message } naming graph-migrate', () => {
  for (const root of [markdownHubDir(), leftoverAreaDir()]) {
    const refusal = migrateRefusal(root);
    assert.deepEqual(refusal, { code: 25, message: MIGRATE_REFUSAL_MESSAGE });
    assert.equal(Object.isFrozen(refusal), true);
    assert.match(refusal.message, /graph-migrate/);
  }
  assert.deepEqual(
    migrateRefusal('/virtual/repo', { fs: { lstatSync: () => ({}) } }),
    { code: MIGRATE_REFUSAL_EXIT, message: MIGRATE_REFUSAL_MESSAGE },
  );
});

test('migrateRefusal validates like legacyAreaPresent: TypeError on a bad rootDir or fs', () => {
  assert.throws(() => migrateRefusal(''), TypeError);
  assert.throws(() => migrateRefusal(42), TypeError);
  assert.throws(() => migrateRefusal('/virtual/repo', { fs: {} }), TypeError);
  assert.throws(() => migrateRefusal('/virtual/repo', { fs: null }), TypeError);
});

// --- the module stays fs-only (it must be importable without pulling in the engine) ----------------

test('the module imports only node: builtins', () => {
  const source = readFileSync(modulePath, 'utf8');
  const specifiers = [
    ...source.matchAll(/^\s*import\s[^'"]*?from\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/^\s*export\s[^'"]*?from\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g),
  ].map((match) => match[1]);
  assert.ok(specifiers.length > 0, 'the module imports at least one builtin');
  for (const specifier of specifiers) {
    assert.match(specifier, /^node:/, `${specifier} is not a node: builtin`);
  }
  assert.deepEqual([...new Set(specifiers)].sort(), ['node:fs', 'node:path']);
});
