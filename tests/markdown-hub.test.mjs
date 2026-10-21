// The fs-only markdown-hub helper (scripts/formula/core/markdown-hub.mjs) — the ONE place a
// steepy-apex Markdown hub (`.apex/_INDEX.md`) is detected, shared by `hub-mode` and every workflow
// script that refuses to run in the `migrate` state.
//
// Hermetic: a present hub is created only inside mkdtemp dirs, never in this repository; the
// injected-`fs` cases never touch the disk at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKDOWN_HUB_ENTRY,
  MIGRATE_REFUSAL_EXIT,
  MIGRATE_REFUSAL_MESSAGE,
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

// --- the exported contract ---------------------------------------------------------------------

test('the contract constants: entry path, dedicated refusal exit 25, one-line message naming graph-migrate', () => {
  assert.equal(MARKDOWN_HUB_ENTRY, '.apex/_INDEX.md');
  assert.equal(MIGRATE_REFUSAL_EXIT, 25);
  assert.equal(
    MIGRATE_REFUSAL_MESSAGE,
    'this repository still carries a steepy-apex Markdown hub (.apex/_INDEX.md); run the graph-migrate skill to move it into the Stable Knowledge Graph first.',
  );
  assert.doesNotMatch(MIGRATE_REFUSAL_MESSAGE, /\n/, 'the refusal message is one line');
});

// --- markdownHubPresent --------------------------------------------------------------------------

test('markdownHubPresent: a root holding .apex/_INDEX.md is present', () => {
  assert.equal(markdownHubPresent(markdownHubDir()), true);
});

test('markdownHubPresent: a root without .apex/_INDEX.md is absent (an .apex/ alone is not a hub)', () => {
  assert.equal(markdownHubPresent(tempDir('steepy-markdown-hub-empty-')), false);
  const apexOnly = tempDir('steepy-markdown-hub-apex-only-');
  mkdirSync(join(apexOnly, '.apex', 'work'), { recursive: true });
  assert.equal(markdownHubPresent(apexOnly), false);
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

test('migrateRefusal: no Markdown hub means no refusal (null)', () => {
  assert.equal(migrateRefusal(tempDir('steepy-markdown-hub-empty-')), null);
  assert.equal(migrateRefusal('/virtual/repo', { fs: { existsSync: () => false } }), null);
});

test('migrateRefusal: a Markdown hub yields the frozen { code: 25, message } naming graph-migrate', () => {
  const refusal = migrateRefusal(markdownHubDir());
  assert.deepEqual(refusal, { code: 25, message: MIGRATE_REFUSAL_MESSAGE });
  assert.equal(Object.isFrozen(refusal), true);
  assert.match(refusal.message, /graph-migrate/);
  assert.deepEqual(
    migrateRefusal('/virtual/repo', { fs: { existsSync: () => true } }),
    { code: MIGRATE_REFUSAL_EXIT, message: MIGRATE_REFUSAL_MESSAGE },
  );
});

test('migrateRefusal validates like markdownHubPresent: TypeError on a bad rootDir or fs', () => {
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
