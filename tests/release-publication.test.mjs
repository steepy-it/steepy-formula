import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Contract: publishRelease({ source, version, cwd }, { run }) returns { ok }.
// run is a spawnSync-compatible command seam. Git is real, local and file-only;
// only the GitHub and validator/publisher subprocess edges are controlled here.
const load = () => import('../scripts/release-publication.mjs');
const answer = (status = 0, stdout = '', stderr = '') => ({ status, stdout, stderr });

function fixture(t, { missingRelease = 'HTTP 404: Not Found' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'formula-publication-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'work');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    HOME: root, XDG_CONFIG_HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-config'),
    GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  mkdirSync(cwd);
  git('init', '-q', '--bare', join(root, 'remote.git'));
  git('init', '-q', '-b', 'main');
  mkdirSync(join(cwd, '.claude-plugin'));
  writeFileSync(join(cwd, '.claude-plugin/plugin.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(cwd, 'README.md'), 'fixture');
  git('add', '.'); git('commit', '-qm', 'candidate');
  const source = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', join(root, 'remote.git'));
  git('push', '-q', 'origin', 'main');
  git('commit', '--allow-empty', '-qm', 'newer main');
  const newer = git('rev-parse', 'HEAD');
  git('checkout', '--detach', source);
  const state = {
    release: null, ghError: null, ghFailure: null, evidenceValid: true, failAt: null, after: null, actions: [], calls: [],
    receipt: { status: 'PASS', mode: 'publication', schemaVersion: 2, candidateRevision: source,
      sourceRevisions: [source], productVersion: '1.0.0', payloadSha256: 'a'.repeat(64) },
  };
  const record = (action, mutate) => {
    state.actions.push(action);
    if (state.failAt === action) return answer(1, '', 'controlled interruption');
    const result = mutate();
    state.after?.(action);
    return result;
  };
  const run = (command, args, options = {}) => {
    state.calls.push({ command, args: [...args] });
    if (command === 'git') {
      assert.ok(!args.some((arg) => arg === '--force' || arg.startsWith('--force-with-lease')), 'never force');
      const perform = () => spawnSync(command, args, { ...options, cwd, env, encoding: 'utf8' });
      if (args[0] === 'push') return record('tag', perform);
      return perform();
    }
    if (command === 'gh') {
      assert.equal(args[0], 'release');
      if (args[1] === 'view') {
        assert.ok(args.includes('--json'), 'query release identity, not just existence');
        if (state.ghFailure) return state.ghFailure;
        if (state.ghError) return answer(1, '', state.ghError);
        return state.release ? answer(0, JSON.stringify(state.release)) : answer(1, '', missingRelease);
      }
      assert.equal(args[1], 'create', 'no implicit edit/delete or retarget');
      assert.equal(args[2], 'v1.0.0');
      assert.ok(args.includes('--verify-tag'), 'GitHub must not implicitly create a missing tag');
      return record('release', () => {
        state.release = { tagName: 'v1.0.0', isDraft: false };
        return answer();
      });
    }
    assert.ok(command === process.execPath || basename(command) === 'node', `unexpected executable ${command}`);
    const script = basename(args[0]);
    if (script === 'validate-release-evidence.mjs') {
      if (args.includes('--product-only')) return answer(0, JSON.stringify({ status: 'PASS', productVersion: '1.0.0', payloadSha256: 'a'.repeat(64) }));
      assert.ok(args.includes('--publication'), 'publication requires native launch evidence');
      return state.evidenceValid ? answer(0, JSON.stringify(state.receipt)) : answer(1, '', 'invalid evidence');
    }
    if (script === 'extract-changelog.mjs') return answer(0, 'release notes');
    assert.equal(script, 'publish-directory-branch.mjs');
    assert.ok(args.includes('--push'), 'successful publication must update the directory remote, not only build a commit');
    assert.equal(args[args.indexOf('--source') + 1], source);
    assert.ok(args.includes('--publication'), 'directory push revalidates evidence at its own mutation boundary');
    assert.equal(args[args.indexOf('--expected-main') + 1], source, 'directory push rechecks main at its own mutation boundary');
    assert.ok(!args.includes('--corrective'), 'ordinary coordinator cannot authorize correction');
    return record('directory', () => answer());
  };
  const invoke = async (overrides = {}) => (await load()).publishRelease({ source, version: '1.0.0', cwd, ...overrides }, { run });
  const tag = (revision = source, annotated = false) => {
    git('tag', ...(annotated ? ['-a', '-m', 'release'] : []), 'v1.0.0', revision);
    git('push', '-q', 'origin', 'refs/tags/v1.0.0');
  };
  return { state, invoke, git, tag, source, newer };
}

test('valid candidate publishes tag, Release, then directory and exact retry does not duplicate tag/Release', async (t) => {
  const fx = fixture(t);
  assert.equal((await fx.invoke()).ok, true);
  assert.deepEqual(fx.state.actions, ['tag', 'release', 'directory']);
  fx.state.actions = [];
  assert.equal((await fx.invoke()).ok, true);
  assert.deepEqual(fx.state.actions, ['directory'], 'directory owns exact tree no-op detection');
});

for (const reason of ['invalid evidence', 'stale main', 'wrong candidate receipt', 'wrong version receipt', 'wrong payload receipt', 'legacy audit receipt', 'caller version mismatch']) {
  test(`${reason} causes no external mutations`, async (t) => {
    const fx = fixture(t);
    let overrides = {};
    if (reason === 'invalid evidence') fx.state.evidenceValid = false;
    if (reason === 'stale main') fx.git('push', '-q', 'origin', `${fx.newer}:refs/heads/main`);
    if (reason === 'wrong candidate receipt') fx.state.receipt.candidateRevision = fx.newer;
    if (reason === 'wrong version receipt') fx.state.receipt.productVersion = '9.0.0';
    if (reason === 'wrong payload receipt') fx.state.receipt.payloadSha256 = 'b'.repeat(64);
    if (reason === 'legacy audit receipt') fx.state.receipt.mode = 'legacy-audit';
    if (reason === 'caller version mismatch') overrides = { version: '9.0.0' };
    assert.equal((await fx.invoke(overrides)).ok, false);
    assert.deepEqual(fx.state.actions, []);
  });
}

for (const annotated of [false, true]) {
  for (const matching of [false, true]) {
    test(`${annotated ? 'annotated' : 'lightweight'} remote tag ${matching ? 'matches and recovers missing release' : 'mismatch refuses without mutation'}`, async (t) => {
      const fx = fixture(t);
      fx.tag(matching ? fx.source : fx.newer, annotated);
      // A stale local tag must not override the remote authority.
      fx.git('tag', '-d', 'v1.0.0');
      fx.git('tag', 'v1.0.0', matching ? fx.newer : fx.source);
      assert.equal((await fx.invoke()).ok, matching);
      assert.deepEqual(fx.state.actions, matching ? ['release', 'directory'] : []);
    });
  }
}

for (const release of [{ tagName: 'vOTHER', isDraft: false }, { tagName: 'v1.0.0', isDraft: true }]) {
  test(`existing ${release.isDraft ? 'draft' : 'wrong-tag'} Release refuses, never edits`, async (t) => {
    const fx = fixture(t);
    fx.tag(); fx.state.release = release;
    assert.equal((await fx.invoke()).ok, false);
    assert.deepEqual(fx.state.actions, []);
  });
}

for (const stage of ['tag', 'release', 'directory']) {
  test(`interruption at ${stage} stops downstream actions and same candidate resumes`, async (t) => {
    const fx = fixture(t);
    fx.state.failAt = stage;
    assert.equal((await fx.invoke()).ok, false);
    const prefix = ['tag', 'release', 'directory'].slice(0, ['tag', 'release', 'directory'].indexOf(stage) + 1);
    assert.deepEqual(fx.state.actions, prefix);
    fx.state.failAt = null; fx.state.actions = [];
    assert.equal((await fx.invoke()).ok, true);
    assert.deepEqual(fx.state.actions, ['tag', 'release', 'directory'].slice(prefix.length - 1));
  });
}

for (const stage of ['tag', 'release']) {
  for (const invalidated of ['main', 'evidence']) {
    test(`${invalidated} changes after ${stage}: zero subsequent mutation`, async (t) => {
      const fx = fixture(t);
      fx.state.after = (action) => {
        if (action !== stage) return;
        if (invalidated === 'main') fx.git('push', '-q', 'origin', `${fx.newer}:refs/heads/main`);
        else fx.state.evidenceValid = false;
      };
      assert.equal((await fx.invoke()).ok, false);
      assert.deepEqual(fx.state.actions, stage === 'tag' ? ['tag'] : ['tag', 'release']);
    });
  }
}

for (const error of [
  'HTTP 403: Forbidden',
  'connection timed out',
  'authentication required: run gh auth login',
  'unexpected GitHub CLI error',
  'repository not found',
  'release not found: authentication required',
]) {
  test(`release lookup ${error} is not treated as a missing release`, async (t) => {
    const fx = fixture(t);
    fx.tag(); fx.state.ghError = error;
    assert.equal((await fx.invoke()).ok, false);
    assert.deepEqual(fx.state.actions, []);
  });
}

test('each external mutation is preceded by fresh publication evidence and remote main verification', async (t) => {
  const fx = fixture(t);
  let checked = 0;
  fx.state.after = () => {
    const sinceLastMutation = fx.state.calls.slice(checked);
    assert.ok(sinceLastMutation.some(({ args }) => args.some((arg) => arg.endsWith('validate-release-evidence.mjs')) && args.includes('--publication')), 'fresh evidence before each external action');
    assert.ok(sinceLastMutation.some(({ command, args }) => command === 'git' && args.includes('ls-remote') && args.some((arg) => arg === 'refs/heads/main' || arg === 'main')), 'remote main checked before each external action');
    checked = fx.state.calls.length;
  };
  assert.equal((await fx.invoke()).ok, true);
});


for (const existingTag of [false, true]) {
  test(`normalized gh absence publishes ${existingTag ? 'exact-tag missing-release retry' : 'new candidate'}`, async (t) => {
    const fx = fixture(t, { missingRelease: 'release not found\n' });
    if (existingTag) fx.tag();
    assert.equal((await fx.invoke()).ok, true, 'the explicit gh missing-release response permits creation');
    assert.deepEqual(fx.state.actions, existingTag ? ['release', 'directory'] : ['tag', 'release', 'directory']);
  });
}

for (const [label, failure] of [
  ['spawn error', { ...answer(null, '', 'release not found\n'), error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }],
  ['unexpected exit status', answer(2, '', 'release not found\n')],
]) {
  test(`normalized absence text with ${label} remains uncertain and refuses`, async (t) => {
    const fx = fixture(t);
    fx.tag(); fx.state.ghFailure = failure;
    assert.equal((await fx.invoke()).ok, false);
    assert.deepEqual(fx.state.actions, []);
  });
}
