import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as bumpVersionMain } from '../scripts/bump-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const workflowCommands = [
  'inception',
  'init',
  'new-surface',
  'check',
  'brainstorm',
  'plan',
  'implement',
  'review',
];
const namespacedWorkflowCommands = workflowCommands.map((command) => `/steepy-formula:${command}`);

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

function assertNoGenericOwnerToken(value, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.doesNotMatch(text, /<owner>/, `${label} must not contain generic owner token`);
}

function assertNoBareWorkflowInvocations(text, label) {
  const commandAlternation = workflowCommands.join('|');
  const bareInvocation = new RegExp(`(^|[^\\w:.-])/(${commandAlternation})\\b`, 'm');
  assert.doesNotMatch(text, bareInvocation, `${label} must namespace public workflow slash commands`);
}

function assertIncludesNamespacedWorkflow(text, label) {
  for (const command of namespacedWorkflowCommands) {
    assert.ok(text.includes(command), `${label} must mention ${command}`);
  }
}

test('release identity uses steepy-formula and steepy-it consistently', () => {
  const pkg = readJson('package.json');
  const plugin = readJson('.claude-plugin/plugin.json');
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const codexPlugin = readJson('.codex-plugin/plugin.json');

  assert.equal(pkg.name, 'steepy-formula');
  assert.equal(pkg.author.name, 'steepy-it');
  assert.equal(plugin.name, 'steepy-formula');
  assert.equal(plugin.author.name, 'steepy-it');
  assert.equal(marketplace.name, 'steepy-formula');
  assert.equal(marketplace.owner.name, 'steepy-it');
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, 'steepy-formula');
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(codexPlugin.name, 'steepy-formula');

  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.private, false);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.engines.node, '>=24');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(plugin.version, pkg.version);
  assert.match(codexPlugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(codexPlugin.version, pkg.version);

  assertNoGenericOwnerToken(pkg, 'package.json');
  assertNoGenericOwnerToken(plugin, '.claude-plugin/plugin.json');
  assertNoGenericOwnerToken(marketplace, '.claude-plugin/marketplace.json');
  assertNoGenericOwnerToken(codexPlugin, '.codex-plugin/plugin.json');
});

test('search keywords stay identical across npm, both plugin manifests and the Claude marketplace entry', () => {
  const pkg = readJson('package.json');
  const plugin = readJson('.claude-plugin/plugin.json');
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const codexPlugin = readJson('.codex-plugin/plugin.json');

  assert.ok(Array.isArray(plugin.keywords) && plugin.keywords.length > 0, '.claude-plugin/plugin.json must declare keywords');
  for (const keyword of plugin.keywords) {
    assert.match(keyword, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `keyword ${keyword} must be lowercase and hyphenated`);
  }
  assert.equal(new Set(plugin.keywords).size, plugin.keywords.length, 'keywords must not repeat');
  assert.deepEqual(pkg.keywords, plugin.keywords, 'package.json keywords must match .claude-plugin/plugin.json');
  assert.deepEqual(codexPlugin.keywords, plugin.keywords, '.codex-plugin/plugin.json keywords must match .claude-plugin/plugin.json');
  assert.deepEqual(marketplace.plugins[0].keywords, plugin.keywords, 'marketplace entry keywords must match .claude-plugin/plugin.json');
  assert.equal(marketplace.plugins[0].category, 'development');
});

test('Claude plugin manifest links the directory listing to files that exist on main', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  const repoUrl = 'https://github.com/steepy-it/steepy-formula';

  assert.equal(plugin.homepage, repoUrl);
  assert.equal(plugin.repository, repoUrl);
  assert.equal(plugin.supportUrl, `${repoUrl}/issues`);
  for (const key of ['documentationUrl', 'privacyPolicyUrl', 'termsOfServiceUrl']) {
    const match = /^https:\/\/github\.com\/steepy-it\/steepy-formula\/(?:blob|tree)\/main\/(.+)$/.exec(plugin[key] ?? '');
    assert.ok(match, `${key} must point into steepy-it/steepy-formula on main`);
    assert.doesNotThrow(() => statSync(join(root, match[1])), `${key} target ${match[1]} must exist`);
  }
});

test('the privacy policy repeats the README external-services table', () => {
  const serviceRows = (relativePath, heading) => {
    const text = readFileSync(join(root, relativePath), 'utf8');
    const start = text.indexOf(`\n${heading}\n`);
    assert.ok(start >= 0, `${relativePath} must have a "${heading}" section`);
    const end = text.indexOf('\n## ', start + heading.length + 2);
    return text.slice(start, end < 0 ? undefined : end)
      .split('\n')
      .filter((line) => line.startsWith('| `/steepy-formula:'));
  };
  const readmeRows = serviceRows('README.md', '## Data and external services');

  assert.ok(readmeRows.length > 0, 'README must list the skills that reach external services');
  assert.deepEqual(serviceRows('PRIVACY.md', '## External services'), readmeRows);
});

test('CI covers the supported Node 24 floor without older runtimes', () => {
  const workflow = [
    readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
    readFileSync(join(root, '.github', 'workflows', 'validate.yml'), 'utf8'),
  ].join('\n');

  assert.match(workflow, /node-version:\s*\['24'\]/);
  assert.doesNotMatch(workflow, /node-version:\s*\[[^\]]*'20'/);
});

test('user-facing docs advertise the supported Node 24 runtime floor', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');

  assert.match(readme, /alt="node ≥ 24"/);
  assert.match(readme, /shields\.io\/badge\/node-%E2%89%A5%2024-/);
  assert.match(readme, /\*\*Node\.js >= 24\*\*/);
  assert.match(contributing, /You need Node\.js >= 24\./);
  assert.doesNotMatch(readme, /node(?:\.js)?(?:%20|\s)+(?:%E2%89%A5|≥|>=)(?:%20|\s)*20/i);
  assert.doesNotMatch(contributing, /Node(?:\.js)?\s+(?:≥|>=)\s*20/i);
});

test('public safety copy uses a command-family effects matrix and current native inventory', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const security = readFileSync(join(root, 'SECURITY.md'), 'utf8');
  const community = readFileSync(join(root, 'COMMUNITY_SUBMISSION.md'), 'utf8');
  const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');

  for (const text of [readme, security, community, contributing]) {
    assert.match(text, /Command-family effects matrix/i);
    assert.match(text, /filesystem\s+reads[–-]writes[–-]subprocesses[–-]temporary\s+state[–-]providers\/network/i);
  }
  assert.match(community, /eleven canonical skills/i);
  assert.match(community, /loop-engineer/i);
  assert.match(community, /five native harnesses/i);
  assert.doesNotMatch(community, /Codex adapters are separate future work/i);
});

test('scripts/bump-version.mjs bumps package.json, .claude-plugin/plugin.json, and .codex-plugin/plugin.json in lockstep (three-way)', () => {
  // Mirrors tests/bump-version.test.mjs's temp-copy fixture pattern, extended with the
  // third manifest. This is the suite that actually falsifies bump-version's write
  // behavior: the static identity assert above only locks the CURRENT repo state
  // (already 0.5.0 everywhere since T6), so it can't catch a bump script that forgets
  // to write .codex-plugin/plugin.json.
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'steepy-release-metadata-bump-'));
  try {
    writeFileSync(
      join(fixtureRoot, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.2.3' }, null, 2) + '\n',
    );
    mkdirSync(join(fixtureRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(fixtureRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.2.3' }, null, 2) + '\n',
    );
    mkdirSync(join(fixtureRoot, '.codex-plugin'), { recursive: true });
    writeFileSync(
      join(fixtureRoot, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.2.3' }, null, 2) + '\n',
    );

    const origLog = console.log;
    console.log = () => {};
    let code;
    try {
      code = bumpVersionMain(['patch'], fixtureRoot);
    } finally {
      console.log = origLog;
    }
    assert.equal(code, 0);

    for (const rel of ['package.json', join('.claude-plugin', 'plugin.json'), join('.codex-plugin', 'plugin.json')]) {
      const version = JSON.parse(readFileSync(join(fixtureRoot, rel), 'utf8')).version;
      assert.equal(version, '1.2.4', `${rel} must be bumped by scripts/bump-version.mjs`);
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('npm package uses an explicit release files allowlist', () => {
  const pkg = readJson('package.json');

  assert.deepEqual(pkg.files, [
    '.agents/',
    '.claude-plugin/',
    '.codex-plugin/',
    'adapters/',
    'assets/',
    'bin/',
    'docs/',
    'scripts/',
    'skills/',
    'templates/',
    'README.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'LICENSE',
    'NOTICE',
    'RELEASE.md',
    'cordis.patch.yml',
  ]);

  const filesText = pkg.files.join('\n');
  for (const localOnly of [
    '.claude/settings.local.json',
    '.apex/work',
    'tests/',
    '.worktrees',
  ]) {
    assert.doesNotMatch(filesText, new RegExp(localOnly.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('package.json exports a dsh adapter subpath, and cordis.patch.yml row uses the matching package specifier (not a profile-relative path)', () => {
  // Regression guard for C1: a `.`-relative `name` in cordis.patch.yml resolves against
  // the profile directory when this file is loaded as a composed BUNDLE patch layer
  // (not the package root, which only holds for the profile's own file-backed
  // cordis.patch.yml). The fix is a package-specifier row backed by an explicit exports
  // subpath, so the two files must move together — assert both halves here.
  const pkg = readJson('package.json');
  const dshExportKey = Object.keys(pkg.exports).find((key) => key !== '.');

  assert.ok(dshExportKey, 'package.json exports must declare a dsh adapter subpath alongside "."');
  assert.equal(
    pkg.exports[dshExportKey],
    './adapters/dsh/steepy-formula.js',
    `package.json exports["${dshExportKey}"] must map to ./adapters/dsh/steepy-formula.js`,
  );
  assert.equal(
    pkg.exports['.'],
    './adapters/opencode/steepy-formula.js',
    'package.json exports must keep "." pointing at the OpenCode adapter',
  );

  const expectedSpecifier = `${pkg.name}${dshExportKey.slice(1)}`;
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');

  assert.doesNotMatch(
    patch,
    /name:\s*\.\//,
    'cordis.patch.yml row name must not be a `.`-relative specifier: a bundle patch layer composed ' +
      'into a profile resolves relative names against the profile directory, not the package root',
  );
  assert.match(
    patch,
    new RegExp(`name:\\s*${expectedSpecifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
    `cordis.patch.yml row name must be the package specifier "${expectedSpecifier}" matching the exports subpath key`,
  );
});

test('npm dry-run package excludes local development state', () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'steepy-npm-cache-'));
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  try {
    const result = spawnSync(
      npmBin,
      ['--cache', cacheDir, 'pack', '--dry-run', '--json'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const [pack] = JSON.parse(result.stdout);
    const paths = pack.files.map((file) => file.path);

    for (const required of [
      '.claude-plugin/plugin.json',
      'docs/workflow.md',
      'docs/architecture.md',
      'skills/init/SKILL.md',
      'templates/bootstrap-skill-graph.md',
      'package.json',
      'README.md',
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'docs/installation.md',
      'LICENSE',
    ]) {
      assert.ok(paths.includes(required), `package must include ${required}`);
    }

    for (const path of paths) {
      assert.ok(!path.startsWith('.claude/'), `package must not include ${path}`);
      assert.ok(!path.startsWith('.apex/work/'), `package must not include ${path}`);
      assert.ok(!path.startsWith('tests/'), `package must not include ${path}`);
      assert.ok(!path.startsWith('.worktrees/'), `package must not include ${path}`);
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('README and linked guides document install paths and release safety notes', () => {
  const readme = ['README.md', 'docs/installation.md', 'RELEASE.md', 'docs/architecture.md']
    .map((path) => readFileSync(join(root, path), 'utf8')).join('\n');

  assert.match(readme, /\/plugin marketplace add steepy-it\/steepy-formula/);
  assert.match(readme, /\/plugin install steepy-formula@steepy-formula/);
  assert.match(readme, /\/plugin install steepy-formula@claude-community/);
  assert.doesNotMatch(readme, /<owner>\/steepy/);
  assert.doesNotMatch(readme, /steepy@steepy/);
  assert.doesNotMatch(readme, /Initialize steepy in your repo\./);
  assert.match(readme, /Initialize steepy-formula in your repo\./);
  assertIncludesNamespacedWorkflow(readme, 'README');
  assertNoBareWorkflowInvocations(readme, 'README');

  for (const required of [
    'writes the gitignored `.apex/work/` local work area',
    'graph-first init creates no other `.apex/` files',
    'writes Claude Code agent and skill artifacts',
    'runs Node.js scripts from the plugin package',
    'Core workflows do not require network access to third-party services; the runtime dependency set is a single pinned package (`neo4j-driver`, Apache-2.0) kept behind the engine adapter.',
    'Command-family effects matrix',
  ]) {
    assert.ok(readme.includes(required), `README must mention: ${required}`);
  }
  assert.doesNotMatch(
    readme,
    /writes `\.apex\/` governance files/,
    'README must not overstate graph-first init as writing `.apex/` governance files',
  );
});

test('README describes a graph-only product: tagline, modes, gate timing, and no hooks', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const lines = readme.split('\n');

  assert.ok(
    lines.includes(readJson('.claude-plugin/plugin.json').description),
    'the README tagline must be the plugin description, verbatim',
  );
  assert.doesNotMatch(readme, /Stop hook|stop-hook|validate-hub|hooks\/hooks|\blinter\b/i,
    'README must not name the removed Stop hook, its wiring, or the Markdown linter');
  assert.doesNotMatch(readme, /\blegacy\b/i, 'README carries no legacy-mode branch');
  assert.match(readme, /The plugin ships no hooks/, 'README trust section must say the plugin ships no hooks');
  assert.match(readme, /\*\*Graph-aware workflow chain\*\*/);
  assert.doesNotMatch(readme, /Hub-aware workflow chain/);

  const honest = readme.slice(readme.indexOf('## Keeping the docs honest'), readme.indexOf('## Data and external services'));
  assert.match(honest, /`check`\/`review` time/, 'the gate runs at check/review time');
  assert.match(
    honest,
    /migration hint reaches you through `steepy-formula hub-mode` and the generated bootstrap at the start of a task/,
    'the migration hint reaches the user through hub-mode and the generated bootstrap',
  );
  assert.doesNotMatch(honest, /end of (?:each|a) (?:assistant )?turn|turn to end/i, 'no end-of-turn gate is claimed');

  const hubModeRow = lines.find((line) => line.startsWith('| `steepy-formula hub-mode` |'));
  assert.ok(hubModeRow, 'the CLI table must carry the hub-mode row');
  for (const required of ['`graph`', '`migrate`', '`none`', '`graph-migrate`', '`init`']) {
    assert.ok(hubModeRow.includes(required), `the hub-mode row must name ${required}`);
  }

  const migrateRow = lines.find((line) => line.startsWith('| `/steepy-formula:graph-migrate` |'));
  assert.ok(migrateRow, 'the skills table must carry the graph-migrate row');
  assert.match(migrateRow, /Migrate a steepy-apex `\.apex\/` hub into the graph/);
});

test('README pins the local .apex/work contract and drops stale stable-hub workflow claims', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');

  assert.match(
    readme,
    /the local `\.apex\/work\/` area for gitignored specs\/plans/,
    'README quick start must promise the local .apex/work area for gitignored specs/plans',
  );
  assert.match(
    readme,
    /\/steepy-formula:init` - Initialize steepy-formula in your repo\.[\s\S]{0,250}the local `\.apex\/work\/` area for gitignored specs\/plans/,
    'README quick start must tie init to the local .apex/work gitignored specs/plans promise',
  );

  for (const required of [
    '.apex/work/',
    'gitignored',
    'local work artifact',
  ]) {
    assert.ok(readme.includes(required), `README must mention: ${required}`);
  }

  assert.doesNotMatch(readme, /specs, plans, and code all flow \*through\* the hub/i);
  assert.doesNotMatch(readme, /writes governed artifacts into the hub/i);
  assert.doesNotMatch(readme, /hub-governed spec/i);
  assert.doesNotMatch(readme, /verified \*through\* the hub/i);
});

test('RELEASE.md documents validation, smoke test, release, and rollback steps', () => {
  const release = readFileSync(join(root, 'RELEASE.md'), 'utf8');

  for (const required of [
    'steepy-it',
    'steepy-it/steepy-formula',
    'steepy-formula@claude-community',
    'claude plugin validate .',
    '/plugin validate .',
    '/plugin marketplace add /path/to/steepy-formula',
    '/plugin install steepy-formula@steepy-formula',
    'claude --plugin-dir .',
    '/steepy-formula:init',
    '/steepy-formula:check',
    'scripts/bump-version.mjs',
    '.github/workflows/release.yml',
    'Rollback',
    'docs/release-evidence.md',
    '`.codex-plugin/plugin.json` in three-way lockstep',
    'claude.ai/directory/manage',
    '`claude-directory`',
    'scripts/publish-directory-branch.mjs',
  ]) {
    assert.ok(release.includes(required), `RELEASE.md must mention: ${required}`);
  }
  assertIncludesNamespacedWorkflow(release, 'RELEASE.md');
  assertNoBareWorkflowInvocations(release, 'RELEASE.md');

  assert.match(release, /Claude Code community\/public distribution/);
  assert.doesNotMatch(release, /official Anthropic/i);
  assert.doesNotMatch(release, /<owner>/);
  assert.doesNotMatch(release, /steepy@steepy/);
  assert.doesNotMatch(release, /admin-settings\/directory\/submissions|platform\.claude\.com\/plugins\/submit/);
  assert.doesNotMatch(release, /GitHub Releases only/);
  assert.doesNotMatch(release, /pinned to a commit SHA/);
  assert.doesNotMatch(release, /\.png\b/i);
});

test('release evidence reference documents the optional release audit verification and release independence', () => {
  const release = readFileSync(join(root, 'docs/release-evidence.md'), 'utf8');

  for (const required of [
    'scripts/validate-release-evidence.mjs',
    'docs/native-test-evidence.json',
    'docs/native-test-evidence.md',
    'plugin-preflight',
    'Claude Code',
    'Codex',
    'OpenCode',
    'Pi',
    'DeepSeek Harness',
    'native-specialist-dispatch',
    'evidence-only commit',
    'it does not block publication',
  ]) {
    assert.ok(release.includes(required), `RELEASE.md must mention: ${required}`);
  }
  assert.match(release, /30 days/);
  assert.match(release, /schema validates documented records[\s\S]*does not prove/i);
});

test('architecture release-evidence inventory matches the validator closed exclusion set', () => {
  const validator = readFileSync(join(root, 'scripts', 'validate-release-evidence.mjs'), 'utf8');
  const setMatch = validator.match(/const EXCLUDED_EVIDENCE_PATHS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(setMatch, 'validator must declare its closed evidence-only exclusion set');
  const identifiers = [...setMatch[1].matchAll(/\b(EVIDENCE_[A-Z_]+_PATH)\b/g)]
    .map((match) => match[1]);
  const constants = new Map(
    [...validator.matchAll(/export const (EVIDENCE_[A-Z_]+_PATH) = '([^']+)';/g)]
      .map((match) => [match[1], match[2]]),
  );
  const excludedPaths = identifiers.map((identifier) => constants.get(identifier));
  assert.ok(excludedPaths.every(Boolean), 'each exclusion-set identifier must name an exported path');

  const architecture = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8');
  const row = architecture.match(/^\| `validate-release-evidence\.mjs` \| ([^\n]+) \|$/m);
  assert.ok(row, 'architecture must inventory validate-release-evidence.mjs');
  const documentedPaths = [...row[1].matchAll(/`(docs\/[^`]+)`/g)].map((match) => match[1]);
  assert.deepEqual(
    documentedPaths,
    excludedPaths,
    'architecture inventory must name exactly the validator closed evidence-only exclusion set',
  );
  assert.match(row[1], /no documentation directory or path family is excluded/i);
});

test('RELEASE.md smoke test uses local gitignored apex work artifacts', () => {
  const release = readFileSync(join(root, 'RELEASE.md'), 'utf8');

  for (const required of [
    '.apex/work/.gitignore',
    '.apex/work/specs/',
    '.apex/work/plans/',
  ]) {
    assert.ok(release.includes(required), `RELEASE.md smoke test must mention: ${required}`);
  }

  assert.doesNotMatch(release, /\.apex\/specs\/_INDEX\.md/);
  assert.doesNotMatch(release, /\.apex\/plans\/_INDEX\.md/);
});

test('Installation guide documents native five-harness install journeys', () => {
  const readme = readFileSync(join(root, 'docs/installation.md'), 'utf8');

  for (const heading of ['### Claude Code', '### Codex', '### OpenCode', '### Pi', '### DeepSeek Harness']) {
    assert.ok(readme.includes(heading), `Installation guide must have a "${heading}" installation heading`);
  }

  for (const required of [
    'codex plugin marketplace add steepy-it/steepy-formula',
    'steepy-formula@git+https://github.com/steepy-it/steepy-formula.git#vX.Y.Z',
    'pi install git:github.com/steepy-it/steepy-formula@vX.Y.Z',
    'the package is not published yet',
  ]) {
    assert.ok(readme.includes(required), `Installation guide must mention: ${required}`);
  }

  assert.doesNotMatch(
    readme,
    /steepy-formula is a \[Claude Code\]\(https:\/\/docs\.claude\.com\/en\/docs\/claude-code\) plugin, installed through a marketplace\./,
    'Installation guide must not frame steepy-formula as a Claude-Code-only plugin installed through a marketplace',
  );
});

test('README documents the shipped graph product: CLI families, canonical authority, engine, Explorer, docker lifecycle', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');

  for (const required of [
    'steepy-formula graph',
    'steepy-formula context',
    'steepy-formula promotion',
  ]) {
    assert.ok(readme.includes(required), `README must document the ${required} CLI family`);
  }

  for (const required of [
    'Stable Knowledge Graph',
    'canonical graph',
    'ArcadeDB',
    'Studio',
    'docker',
  ]) {
    assert.ok(readme.includes(required), `README must mention: ${required}`);
  }

  assert.doesNotMatch(readme, /legacy migration semantics|Legacy Markdown semantics/i,
    'README replaces the legacy-semantics framing with the "Coming from steepy-apex" note');
  const comingFrom = readme.indexOf('Coming from steepy-apex');
  assert.ok(comingFrom >= 0, 'README must carry the "Coming from steepy-apex" note');
  assert.match(
    readme.slice(comingFrom, comingFrom + 600),
    /`\/steepy-formula:graph-migrate`/,
    'the "Coming from steepy-apex" note must point at graph-migrate',
  );
  assert.doesNotMatch(
    readme,
    /read[^\n]*\.apex\/_INDEX\.md/i,
    'README must not instruct reading the archived .apex/_INDEX.md',
  );
});

test('RELEASE.md documents the multi-harness live-canary evidence matrix', () => {
  const release = readFileSync(join(root, 'RELEASE.md'), 'utf8');

  assert.ok(
    release.includes('## Multi-harness live-canary evidence matrix (mandatory)'),
    'RELEASE.md must have the multi-harness live-canary evidence matrix heading',
  );

  for (const step of [
    'Install via the native mechanism (local-dev path)',
    'Fresh session starts clean',
    'All eleven skills discoverable',
    '`init` → interview → scaffold',
    'Coherence gate exits 0 in the fixture',
    '`check` runs successfully',
    'One `brainstorm → plan → implement → review` chain on a toy change',
    'Orchestration native, or degradation declared in output (inline specialist, session model)',
    'Zero Claude dependency: no `CLAUDE_*` env needed, no reads from `~/.claude`',
  ]) {
    assert.ok(release.includes(step), `RELEASE.md evidence matrix must include step: ${step}`);
  }

  for (const required of [
    'R2 — Codex namespacing',
    'R3 — OpenCode frontmatter tolerance.',
    'D4 — end-of-turn gate approximation.',
    'OpenCode install scope',
    '/steepy-formula:loop-engineer',
    '`.codex-plugin/plugin.json` in three-way lockstep',
  ]) {
    assert.ok(release.includes(required), `RELEASE.md must mention: ${required}`);
  }

  assert.match(
    release,
    /tested path is the local\s+tarball\/worktree install/,
    'RELEASE.md must scope the OpenCode canary to the local tarball/worktree install (npm stays untested)',
  );

  assert.doesNotMatch(
    release,
    /updates `package\.json` and `\.claude-plugin\/plugin\.json`/,
    'RELEASE.md must not retain the old two-way (package.json + claude-plugin only) lockstep phrasing',
  );
});

test('RELEASE.md canary matrix carries the model-mapping freshness canary and the filled, dated D2 tier-dispatch canary', () => {
  const release = readFileSync(join(root, 'RELEASE.md'), 'utf8');

  for (const required of [
    'Model-mapping freshness canary',
    'node <engine-root>/scripts/verify-model-mappings.mjs',
    'adapters/model-mappings.mjs',
    '`OK`',
    '`STALE`',
    '`UNKNOWN`',
    'D2 tier-dispatch canary',
    'placeholder dated 2026-08-20, filled 2026-08-20',
    'zai-coding-plan/glm-5.2-highspeed',
    'agent=steepy-standard',
    'model=zai-coding-plan/glm-5.2',
    'steepy-standard canary ok',
  ]) {
    assert.ok(release.includes(required), `RELEASE.md must mention: ${required}`);
  }

  assert.match(release, /`STALE`[^\n]*human-ratified/,
    'the freshness canary must tie STALE to a human-ratified patch before release');
  assert.match(release, /`UNKNOWN`[\s\S]{0,120}informational/,
    'the freshness canary must mark UNKNOWN informational (offline degradation)');
  assert.match(release, /Task 7[\s\S]{0,120}tier-dispatch work/,
    'the D2 canary must attribute the fill to Task 7 of the 2026-08-20 tier-dispatch work');
  assert.match(release, /subagent_type: "steepy-standard"/,
    'the D2 canary must record the dispatch as direct task-tool evidence');
});

test('docs/architecture.md documents the adapters surface and multi-harness test suites', () => {
  const architecture = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8');

  assert.ok(
    architecture.includes('## `adapters/` — the harness adapters'),
    'docs/architecture.md must have the adapters section heading',
  );

  for (const required of [
    '`.claude-plugin/` manifest + marketplace — the pre-existing plugin, unchanged behavior.',
    '`.codex-plugin/plugin.json` (points at `skills/`)',
    '`adapters/opencode/steepy-formula.js` — a config hook pushes `skills/` into `config.skills.paths`',
    '`adapters/model-mappings.mjs` (the provider-keyed tier tables with per-row provenance)',
    '`adapters/pi/steepy-formula.js` — `session_start` bootstrap injection',
    '`adapters/dsh/steepy-formula.js`, wired via the root `cordis.patch.yml`',
    '**Multi-harness:** `portability-contract`',
    '`canary-structural` (isolated-HOME, env-scrubbed engine runs through literal skill-relative paths)',
    '`npm-pack` (the tarball carries every manifest, adapter, skill, and script)',
  ]) {
    assert.ok(architecture.includes(required), `docs/architecture.md must mention: ${required}`);
  }

  assert.doesNotMatch(
    architecture,
    /is a Claude Code plugin with \*\*zero runtime dependencies\*\*/,
    'docs/architecture.md must not frame steepy-formula as Claude-Code-only',
  );
});

test('docs/architecture.md tabulates every scripts/*.mjs engine exactly once', () => {
  const architecture = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8');
  const heading = '## `scripts/` — the engine';
  const sectionStart = architecture.indexOf(heading);
  assert.notEqual(sectionStart, -1, 'docs/architecture.md must have the scripts section heading');
  const sectionEnd = architecture.indexOf('\n## ', sectionStart + heading.length);
  const section = architecture.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);
  const documented = [...section.matchAll(/^\| `([^`]+\.mjs)` \|/gmu)]
    .map((match) => match[1]);
  const actual = readdirSync(join(root, 'scripts'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => entry.name)
    .sort();

  assert.equal(
    new Set(documented).size,
    documented.length,
    'each scripts/*.mjs engine must appear exactly once in the architecture table',
  );
  assert.deepEqual(
    documented.toSorted(),
    actual,
    'the architecture table must match the complete scripts/*.mjs inventory',
  );
});

test('public docs describe the implemented deterministic Gear-4 controller boundary', () => {
  const architecture = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8');
  const workflow = readFileSync(join(root, 'docs', 'workflow.md'), 'utf8');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');

  for (const script of ['workflow-state.mjs', 'loop-engineer.mjs']) {
    assert.ok(
      architecture.includes(`| \`${script}\` |`),
      `docs/architecture.md must tabulate ${script}`,
    );
  }
  assert.match(
    architecture,
    /events\.jsonl[\s\S]*authoritative[\s\S]*ledger\.md[\s\S]*projection/i,
    'architecture must show events as authority and the ledger as a projection',
  );
  assert.match(
    architecture,
    /ATTEMPT_RESERVED[\s\S]*before[\s\S]*(?:runner|side effect|mutation)/i,
    'architecture must place durable reservation before an attempt runner or mutation',
  );
  assert.match(
    architecture,
    /work-paths\.mjs[^\n]*`spec \| goal \| criteria \| work-output`/i,
    'architecture must carry the implementation work-type order exactly',
  );

  const gear4 = workflow.match(/## Gear 4: Loop Engineer([\s\S]*?)(?=\n## |$)/)?.[1];
  assert.ok(gear4, 'docs/workflow.md must have a Gear 4 section');
  assert.match(gear4, /terminal controller/i);
  assert.match(gear4, /commit\s+authorization[\s\S]*mandatory|mandatory[\s\S]*commit\s+authorization/i);
  for (const outcome of ['GOAL_REACHED', 'BUDGET_EXHAUSTED', 'NO_IMPROVEMENT', 'REVIEW_REJECTED']) {
    assert.ok(gear4.includes(`\`${outcome}\``), `Gear 4 must define ${outcome}`);
  }
  assert.match(
    gear4,
    /every clean (?:terminal )?(?:result|outcome)[\s\S]*branch reviewed[\s\S]*not necessarily[\s\S]*branch-review approved/i,
  );
  assert.match(
    gear4,
    /`REVIEW_REJECTED`[\s\S]*exhausted[\s\S]*goal-acceptable[\s\S]*(?:boolean[^]*green|metric[^]*strict improvement)[\s\S]*unresolved issues/i,
  );
  assert.match(
    gear4,
    /terminal-review approval[\s\S]*(?:distinct|separate)[\s\S]*controller(?:'s)? branch-review verdict/i,
  );
  assert.match(gear4, /crash-safe resume/i);
  assert.match(gear4, /Claude[\s\S]*Codex[\s\S]*OpenCode/);
  assert.match(gear4, /Pi[\s\S]*DeepSeek[\s\S]*`runner-unavailable`/i);
  assert.match(gear4, /fake-runner[\s\S]*not[\s\S]*five-provider LIVE|five-provider LIVE[\s\S]*not[\s\S]*fake-runner/i);
  assert.match(gear4, /APEX-P1-04[\s\S]*open/i);

  assert.match(
    readme,
    /bounded autonomous loop/i,
  );
  assert.match(gear4, /four outcomes/i);
  assert.match(readme, /Claude, Codex, and OpenCode[\s\S]*Pi and DeepSeek[\s\S]*runner-unavailable/i);
  const workflowSummary = readFileSync(join(root, 'docs/workflow.md'), 'utf8');
  const workflowGear4 = workflowSummary.match(/^- \*\*Gear-4 terminal controller\*\* — ([^\n]+)$/mu)?.[1];
  assert.ok(workflowGear4, 'Workflow guide must retain the Gear-4 capability and evidence summary');
  assert.match(workflowGear4, /fake-runner[\s\S]*runtime-only evidence/i);
  assert.match(workflowGear4, /five-provider LIVE[\s\S]*APEX-P1-04[\s\S]*remains open/i);
});

test('CHANGELOG.md carries a heading for the current plugin.json version', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

  const escapedVersion = plugin.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    changelog,
    new RegExp(`## v${escapedVersion} \\(`),
    `CHANGELOG.md must have a "## v${plugin.version} (" heading for the current plugin.json version`,
  );
});

test('COMMUNITY_SUBMISSION.md contains marketplace review copy and safety disclosure', () => {
  const submission = readFileSync(join(root, 'COMMUNITY_SUBMISSION.md'), 'utf8');

  for (const required of [
    'steepy-formula',
    'steepy-it',
    'Your AI documentation stops rotting',
    'claude.ai/directory/manage',
    '`claude-directory`',
    'five native harnesses',
    'Command-family effects matrix',
    'writes the gitignored `.apex/work/` local work area',
    'graph-first init creates no other `.apex/` files',
    'writes Claude Code agent and skill artifacts',
    'runs Node.js scripts from the plugin package',
    'Core workflows do not require network access to third-party services; the runtime dependency set is a single pinned package (`neo4j-driver`, Apache-2.0) kept behind the engine adapter.',
    'Apache-2.0',
  ]) {
    assert.ok(submission.includes(required), `COMMUNITY_SUBMISSION.md must mention: ${required}`);
  }
  assert.doesNotMatch(submission, /Stop hook|stop-hook|validate-hub|routing-table|\blegacy\b/i,
    'COMMUNITY_SUBMISSION.md describes a graph-only product: no Stop hook, linter, routing table, or legacy mode');
  const migrateScenario = submission.split('\n').find((line) => line.includes('`.apex/_INDEX.md`'));
  assert.ok(migrateScenario, 'the reviewer scenarios must cover a repository carrying a steepy-apex hub');
  assert.match(migrateScenario, /run `hub-mode`[\s\S]*reports `migrate` and names `graph-migrate`/i);

  assert.doesNotMatch(
    submission,
    /writes `\.apex\/` governance files/,
    'COMMUNITY_SUBMISSION.md must not overstate graph-first init as writing `.apex/` governance files',
  );
  assert.doesNotMatch(submission, /official Anthropic/i);
  assert.doesNotMatch(submission, /admin-settings\/directory\/submissions|platform\.claude\.com\/plugins\/submit/);
  assert.doesNotMatch(submission, /\.png\b/i);
  assert.doesNotMatch(submission, /<owner>/);
  assertIncludesNamespacedWorkflow(submission, 'COMMUNITY_SUBMISSION.md');
  assertNoBareWorkflowInvocations(submission, 'COMMUNITY_SUBMISSION.md');
});

function pngChunkTypes(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const types = [];
  let o = 8;
  while (o < buffer.length) {
    const length = buffer.readUInt32BE(o);
    const type = buffer.toString('latin1', o + 4, o + 8);
    types.push(type);
    o += 12 + length;
    if (type === 'IEND') break;
  }
  return types;
}

test('.claude-plugin/icon.png is a byte copy of the Codex icon within directory bounds', () => {
  const icon = readFileSync(join(root, '.claude-plugin/icon.png'));
  const codexIcon = readFileSync(join(root, 'assets/plugin-icon.png'));
  assert.ok(icon.equals(codexIcon), 'Claude icon must be a byte copy of the Codex icon');
  pngChunkTypes(icon);
  const width = icon.readUInt32BE(16);
  const height = icon.readUInt32BE(20);
  assert.equal(width, height, 'icon must be square');
  assert.ok(width >= 512 && width <= 2048, `icon width ${width} out of bounds`);
  assert.ok(icon.byteLength < 2 * 1024 * 1024, 'icon must stay under 2 MiB');
  assert.equal(Object.hasOwn(readJson('.claude-plugin/plugin.json'), 'icon'), false);
});

test('tracked PNGs outside tests/ carry no caBX chunk', () => {
  const listed = spawnSync('git', ['ls-files', '-z', '--', '*.png'], { cwd: root, encoding: 'utf8' });
  assert.equal(listed.status, 0);
  const files = listed.stdout.split('\0').filter((f) => f && !f.startsWith('tests/'));
  // Formula does not ship apex's gears diagram: it pictures the legacy Markdown hub
  // ("Stable knowledge in .apex/"), not the graph-first product.
  assert.ok(!files.includes('assets/workflow-gears.png'), 'the legacy gears diagram must not be tracked');
  for (const required of ['assets/plugin-icon.png', '.claude-plugin/icon.png']) {
    assert.ok(files.includes(required), `${required} must be tracked`);
  }
  for (const file of files) {
    const types = pngChunkTypes(readFileSync(join(root, file)));
    assert.ok(!types.includes('caBX'), `${file} must not carry a caBX chunk`);
  }
});

test('docs/workflow.md does not reference the gears diagram', () => {
  const workflow = readFileSync(join(root, 'docs/workflow.md'), 'utf8');
  assert.ok(!workflow.includes('workflow-gears.png'));
  assert.doesNotMatch(workflow, /<img\b|<picture\b|<a\b/i);
});

test('manifest descriptions are graph-only and identical across every carrier', () => {
  const pluginForm = 'Land governed project knowledge in a canonical Stable Knowledge Graph, route work by surface, and keep it coherent with graph validation.';
  const marketplaceForm = 'Steepy plugin marketplace: governed project knowledge in a canonical Stable Knowledge Graph, routed by surface and kept coherent with graph validation.';
  const claudeMarketplace = readJson('.claude-plugin/marketplace.json');
  const agentsMarketplace = readJson('.agents/plugins/marketplace.json');
  const submission = readFileSync(join(root, 'COMMUNITY_SUBMISSION.md'), 'utf8');
  const shortDescription = submission.split(/^## Short description\s*$/m)[1].split(/^## /m)[0].trim();
  const pluginForms = {
    'package.json': readJson('package.json').description,
    '.claude-plugin/plugin.json': readJson('.claude-plugin/plugin.json').description,
    '.codex-plugin/plugin.json': readJson('.codex-plugin/plugin.json').description,
    '.claude-plugin/marketplace.json plugins[0]': claudeMarketplace.plugins[0].description,
    '.agents/plugins/marketplace.json plugins[0]': agentsMarketplace.plugins[0].description,
    'COMMUNITY_SUBMISSION.md short description': shortDescription,
  };
  const marketplaceForms = {
    '.claude-plugin/marketplace.json': claudeMarketplace.description,
    '.agents/plugins/marketplace.json': agentsMarketplace.description,
  };
  for (const [label, value] of Object.entries(pluginForms)) {
    assert.equal(value, pluginForm, `${label} must carry the plugin description`);
    assert.doesNotMatch(value, /legacy|Markdown hub|mode-aware/i, label);
  }
  for (const [label, value] of Object.entries(marketplaceForms)) {
    assert.equal(value, marketplaceForm, `${label} must carry the marketplace description`);
    assert.doesNotMatch(value, /legacy|Markdown hub|mode-aware/i, label);
  }
});

test('RELEASE.md is graph-only: no linter step, no Stop hook, and D4 gates at check/review time', () => {
  const release = readFileSync(join(root, 'RELEASE.md'), 'utf8');

  // The linter survives only in the dated 2026-07-15 canary note (dated evidence stays dated).
  const linterParagraphs = release.split(/\n\s*\n/).filter((paragraph) => /validate-hub/.test(paragraph));
  assert.equal(linterParagraphs.length, 1, 'validate-hub may appear only in the dated canary note');
  assert.match(linterParagraphs[0], /^\*\*Graph-first cells in rows 4–6/);
  assert.doesNotMatch(release, /The Stop hook stays quiet|hooks\/hooks|stop-hook|legacy hubs/,
    'RELEASE.md must not promise the removed Stop hook, its wiring, or legacy-hub canary cells');
  assert.doesNotMatch(release, /--hub-mode/, 'the canary commands carry no --hub-mode flag');
  assert.doesNotMatch(release, /can publish only after tests, hub coherence/,
    'the release workflow runs no hub-coherence job');

  const d4Start = release.indexOf('- **D4 — end-of-turn gate approximation.**');
  assert.ok(d4Start >= 0, 'the D4 verification row must stay');
  const d4 = release.slice(d4Start, release.indexOf('**Harness quirks observed'));
  assert.match(d4, /No harness ships an end-of-turn hook/);
  assert.match(d4, /`steepy-formula graph validate`\) runs at `check`\s*\/\s*`review` time/);
  assert.match(d4, /\*\*Resolved 2026-07-15/, 'the dated resolution stays dated');
  assert.doesNotMatch(d4, /hooks\/hooks|stays in the package/, 'D4 claims no shipped hook wiring');
});

test('contributor guide, GitHub templates, and the workflow-chain caption name the graph gate only', () => {
  const read = (path) => readFileSync(join(root, path), 'utf8');

  const contributing = read('CONTRIBUTING.md');
  assert.doesNotMatch(contributing, /validate-hub|legacy linter/);
  assert.match(contributing, /\*\*Knowledge stays coherent\*\* — the canonical graph passes `steepy-formula graph validate`\./);

  const pullRequest = read('.github/pull_request_template.md');
  assert.doesNotMatch(pullRequest, /validate-hub|anything the linter reads/);
  assert.match(pullRequest, /^- \[ \] [^\n]*`steepy-formula graph validate`/m);

  const bugReport = read('.github/ISSUE_TEMPLATE/bug_report.yml');
  assert.doesNotMatch(bugReport, /validate-hub/);
  assert.match(bugReport, /Output of the failing command — or of `steepy-formula graph validate` if the graph is involved\./);

  const featureRequest = read('.github/ISSUE_TEMPLATE/feature_request.yml');
  assert.doesNotMatch(featureRequest, /routing table|pre-1\.0/);

  const chain = read('assets/workflow-chain.svg');
  assert.doesNotMatch(chain, /validate-hub/);
  assert.match(chain, />graph validate gate → PR</);
});

test('CHANGELOG.md records the graph-only break under Unreleased, above v1.0.0, without picking a version', () => {
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const unreleased = changelog.search(/^## Unreleased$/m);
  const v100 = changelog.indexOf('## v1.0.0 (');
  assert.ok(unreleased >= 0, 'CHANGELOG.md must carry a "## Unreleased" heading');
  assert.ok(unreleased < v100, '"## Unreleased" must sit above "## v1.0.0"');
  const entry = changelog.slice(unreleased, v100);

  assert.match(entry, /\*\*Breaking:\*\*/);
  assert.match(entry, /graph-only/);
  assert.match(entry, /`\.apex\/_INDEX\.md`[\s\S]*`(?:steepy-formula )?hub-mode` reports `migrate`[\s\S]*exit 25[\s\S]*`graph-migrate`/);
  for (const removed of [
    '`scripts/validate-hub.mjs`',
    'Stop hook',
    '`hooks/`',
    '`scripts/new-surface.mjs`',
    // Split so this suite never reads as a consumer of a retired template source
    // (tests/template.test.mjs scans tests/ for the literal paths).
    ...[['_IN', 'DEX.md'], ['routing', '-row.md']].map(([prefix, suffix]) => `\`templates/${prefix}${suffix}\``),
    '`render-claude-md.mjs`',
    '`--routing-index`',
    '`--standard`',
    '`--hub-mode`',
    '`--no-gate`',
  ]) {
    assert.ok(entry.includes(removed), `the Unreleased entry must name the removal of ${removed}`);
  }
  assert.match(entry, /OpenCode[^\n]*`\.formula\/config\.json`/);
  assert.match(entry, /generated bootstrap and `AGENTS\.md` navigation[\s\S]*`migrate`[\s\S]*`graph-migrate`[\s\S]*`none`[\s\S]*`init`[\s\S]*`customized`/);
  assert.match(entry, /allowlist sentence/);
});
