#!/usr/bin/env node
// Exit codes: 0 published, 1 refused/uncertain remote outcome, 2 usage, 25 migrate.
// Remote operations are deliberately separate: this is not a cross-service transaction.
// On any uncertain outcome stop; a retry observes each remote identity again.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseVersion } from './version-policy.mjs';
import { migrateRefusal, MIGRATE_REFUSAL_EXIT } from './formula/core/markdown-hub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST = /^[0-9a-f]{64}$/;
export const PUBLICATION_CODES = Object.freeze({ REFUSED: 'PUBLICATION_REFUSED' });
const fail = (message) => { throw new Error(message); };
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new TypeError(`accepted keys: ${keys.join(', ')}`);
  }
}
function boundary(run, cwd) {
  return async (command, args, options = {}) => {
    const result = await run(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
    if (result?.error || result?.status !== 0) fail(`${command === 'git' ? `git ${args[0]}` : 'publication command'} failed; observe remote state before retrying`);
    return result.stdout;
  };
}

// Shared by the coordinator and the directory subprocess at its final push boundary.
export async function verifyPublicationCandidate(input, deps = {}) {
  closed(input, ['source', 'version', 'cwd', 'payloadSha256']);
  closed(deps, ['run']);
  const { source, version, cwd, payloadSha256 } = input;
  const run = deps.run ?? spawnSync;
  const command = boundary(run, cwd);
  const head = (await command('git', ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (!SHA.test(source) || head !== source) fail(`candidate mismatch: expected ${source}, checkout ${head}`);
  await command('git', ['diff', '--quiet', 'HEAD', '--']);
  const manifest = JSON.parse(await command('git', ['show', `${source}:.claude-plugin/plugin.json`]));
  parseVersion(version);
  if (manifest.version !== version) fail('candidate version mismatch');
  const product = JSON.parse(await command(process.execPath, [join(HERE, 'validate-release-evidence.mjs'), '--product-only']));
  const receipt = JSON.parse(await command(process.execPath, [join(HERE, 'validate-release-evidence.mjs'), '--publication']));
  const keys = ['status', 'mode', 'schemaVersion', 'candidateRevision', 'sourceRevisions', 'productVersion', 'payloadSha256'];
  if (Object.keys(receipt).some((key) => !keys.includes(key)) || Object.keys(receipt).length !== keys.length
    || receipt.status !== 'PASS' || receipt.mode !== 'publication' || receipt.schemaVersion !== 2
    || receipt.candidateRevision !== source || receipt.productVersion !== version
    || !Array.isArray(receipt.sourceRevisions) || receipt.sourceRevisions.length !== 1 || !SHA.test(receipt.sourceRevisions[0])
    || !DIGEST.test(receipt.payloadSha256) || product.status !== 'PASS' || product.productVersion !== version
    || receipt.payloadSha256 !== product.payloadSha256 || (payloadSha256 && receipt.payloadSha256 !== payloadSha256)) {
    fail('publication evidence receipt does not bind candidate, version and payload');
  }
  return receipt;
}

export async function verifyRemoteMain(input, deps = {}) {
  closed(input, ['source', 'cwd']); closed(deps, ['run']);
  const command = boundary(deps.run ?? spawnSync, input.cwd);
  const lines = (await command('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'])).trim().split('\n');
  if (lines.length !== 1 || lines[0] !== `${input.source}\trefs/heads/main`) fail(`stale candidate ${input.source}: remote main changed or is unknown`);
}

export async function publishRelease(input, deps = {}) {
  closed(input, ['source', 'version', 'cwd']); closed(deps, ['run']);
  const { cwd = process.cwd() } = input;
  const run = deps.run ?? spawnSync;
  if (typeof run !== 'function') throw new TypeError('run must be a function');
  const command = boundary(run, cwd);
  try {
    const refusal = migrateRefusal(cwd);
    if (refusal) return { ok: false, code: MIGRATE_REFUSAL_EXIT, message: refusal.message, identity: null };
    if (typeof input.source !== 'string' || !SHA.test(input.source)) fail('source must be a full commit identity');
    const source = input.source;
    const version = input.version ?? JSON.parse(await command('git', ['show', `${source}:.claude-plugin/plugin.json`])).version;
    parseVersion(version);
    const tag = `v${version}`;
    const receipt = await verifyPublicationCandidate({ source, version, cwd }, { run });
    const fresh = async () => {
      await verifyPublicationCandidate({ source, version, cwd, payloadSha256: receipt.payloadSha256 }, { run });
      await verifyRemoteMain({ source, cwd }, { run });
    };
    const remoteTag = async () => {
      const output = await command('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
      const refs = new Map();
      for (const line of output.trim().split('\n').filter(Boolean)) {
        const [sha, ref, ...extra] = line.split(/\s+/);
        if (!SHA.test(sha) || ![`refs/tags/${tag}`, `refs/tags/${tag}^{}`].includes(ref) || extra.length || refs.has(ref)) fail('unknown remote tag identity');
        refs.set(ref, sha);
      }
      if (refs.has(`refs/tags/${tag}^{}`) && !refs.has(`refs/tags/${tag}`)) fail('incomplete remote tag identity');
      const actual = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
      if (actual && actual !== source) fail(`tag ${tag} mismatch: expected ${source}, remote ${actual}; maintainer reconciliation required`);
      return actual ?? null;
    };
    const remoteRelease = async () => {
      const result = await run('gh', ['release', 'view', tag, '--json', 'tagName,isDraft'], { cwd, encoding: 'utf8' });
      if (result?.error || result?.status !== 0) {
        const missing = typeof result?.stderr === 'string'
          && (result.stderr.trim() === 'release not found' || /\bHTTP 404: Not Found\b/.test(result.stderr));
        if (!result?.error && result?.status === 1 && missing) return null;
        fail('release lookup uncertain; observe remote state before retrying');
      }
      const release = JSON.parse(result.stdout);
      if (release.tagName !== tag || release.isDraft !== false) fail(`release ${tag} binding mismatch or draft; maintainer must reconcile or publish the verified draft separately`);
      return release;
    };
    await verifyRemoteMain({ source, cwd }, { run });
    let existingTag = await remoteTag();
    let existingRelease = await remoteRelease();
    if (existingRelease && !existingTag) fail('release exists without its remote tag; maintainer reconciliation required');
    if (!existingTag) {
      await fresh();
      // No local tag is trusted or changed. A plain tag refspec is create-only:
      // Git refuses replacing an existing remote tag with another object.
      await command('git', ['push', 'origin', `${source}:refs/tags/${tag}`]);
    }
    existingTag = await remoteTag();
    if (!existingTag) fail('remote tag absent after publication');
    existingRelease = await remoteRelease();
    if (!existingRelease) {
      const notesDir = mkdtempSync(join(tmpdir(), 'steepy-release-notes-'));
      try {
        const notes = await run(process.execPath, [join(HERE, 'extract-changelog.mjs'), version], { cwd, encoding: 'utf8' });
        const notesFile = join(notesDir, 'notes.md');
        writeFileSync(notesFile, notes?.status === 0 ? notes.stdout : `Release ${tag} — see CHANGELOG.md\n`, { flag: 'wx', mode: 0o600 });
        await fresh();
        if (!await remoteTag()) fail('remote tag disappeared before release');
        if (!await remoteRelease()) await command('gh', ['release', 'create', tag, '--verify-tag', '--title', tag, '--notes-file', notesFile]);
      } finally { rmSync(notesDir, { recursive: true, force: true }); }
    }
    await fresh();
    if (!await remoteTag() || !await remoteRelease()) fail('published tag/release disappeared before directory publication');
    await command(process.execPath, [join(HERE, 'publish-directory-branch.mjs'), '--source', source,
      '--branch', 'claude-directory', '--expected-main', source, '--publication', '--push']);
    return { ok: true, source, version, payloadSha256: receipt.payloadSha256 };
  } catch (error) {
    // Never echo subprocess stderr (it can contain credential-bearing remote URLs).
    return { ok: false, code: PUBLICATION_CODES.REFUSED, message: error instanceof SyntaxError ? 'invalid publication response' : error.message, identity: null };
  }
}

export async function main(argv = process.argv.slice(2)) {
  const refusal = migrateRefusal(process.cwd());
  if (refusal) { console.error(refusal.message); return MIGRATE_REFUSAL_EXIT; }
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false,
      options: { source: { type: 'string' }, version: { type: 'string' } } }));
    if (!SHA.test(values.source ?? '')) throw new Error();
  } catch {
    console.error('usage: release-publication --source <full-commit> [--version X.Y.Z]\nExit codes: 0 published, 1 refused, 2 usage, 25 migrate.');
    return 2;
  }
  const result = await publishRelease({ ...values, cwd: process.cwd() });
  if (!result.ok) { console.error(result.message); return result.code === MIGRATE_REFUSAL_EXIT ? MIGRATE_REFUSAL_EXIT : 1; }
  console.log(JSON.stringify(result));
  return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
