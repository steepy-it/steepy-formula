import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Locks the multi-harness release payload (spec criterion 11): everything a
// Codex/OpenCode/Pi/Claude Code install needs must actually land in the npm tarball,
// not just exist in the working tree. `npm pack --dry-run --json` is the only
// authoritative source for "what files[] + .npmignore/.gitignore resolve to" — it's
// somewhat slow (~1-3s), so it runs ONCE in before() and every test below shares the
// parsed file list.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let paths;
let cacheDir;
let packFilename;

before(() => {
  // A scratch --cache dir keeps this hermetic (no dependency on / mutation of the
  // invoking machine's real npm cache) and matches tests/release-metadata.test.mjs's
  // existing npm-pack-dry-run test. --dry-run means npm never writes a tarball to disk.
  cacheDir = mkdtempSync(join(tmpdir(), 'steepy-npm-pack-cache-'));
  const result = spawnSync(
    npmBin,
    ['--cache', cacheDir, 'pack', '--dry-run', '--json'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    0,
    `npm pack --dry-run --json must exit 0 — stderr:\n${result.stderr || '(empty)'}\nstdout:\n${result.stdout || '(empty)'}`,
  );

  let pack;
  try {
    [pack] = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`npm pack --dry-run --json produced non-JSON stdout: ${err.message}\n${result.stdout}`);
  }
  paths = pack.files.map((file) => file.path);
  packFilename = pack.filename;
});

after(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function assertPacked(required, label) {
  for (const path of required) {
    assert.ok(paths.includes(path), `${label ? `${label}: ` : ''}tarball must include ${path}`);
  }
}

test('npm tarball includes the Claude Code plugin manifest + marketplace file', () => {
  assertPacked(['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']);
});

test('npm tarball includes the Codex plugin manifest', () => {
  assertPacked(['.codex-plugin/plugin.json']);
});

test('npm tarball includes the Codex plugin visual assets', () => {
  assertPacked(['assets/plugin-icon.png', 'assets/plugin-icon.svg']);
});

test('npm tarball includes the .agents plugin marketplace file', () => {
  assertPacked(['.agents/plugins/marketplace.json']);
});

test('npm tarball includes the OpenCode, Pi, and dsh adapters, and the headless adapter', () => {
  assertPacked([
    'adapters/opencode/steepy-formula.js',
    'adapters/pi/steepy-formula.js',
    'adapters/dsh/steepy-formula.js',
    'adapters/headless.mjs',
  ]);
});

test('npm tarball includes the dsh cordis bundle patch manifest', () => {
  assertPacked(['cordis.patch.yml']);
});

test('npm tarball includes the MCP adapter', () => {
  assertPacked(['adapters/mcp/formula-mcp.mjs']);
});

test('npm tarball includes all eleven SKILL.md files', () => {
  const skillNames = [
    'inception',
    'init',
    'check',
    'new-surface',
    'discovery',
    'graph-migrate',
    'brainstorm',
    'plan',
    'implement',
    'review',
    'loop-engineer',
  ];
  assertPacked(skillNames.map((name) => `skills/${name}/SKILL.md`), 'eleven SKILL.md files');
});

test('npm tarball includes the six subagent prompt templates', () => {
  assertPacked([
    'skills/implement/implementer-prompt.md',
    'skills/implement/task-reviewer-prompt.md',
    'skills/implement/final-review-prompt.md',
    'skills/discovery/explore-surface-prompt.md',
    'skills/loop-engineer/loop-implementer-prompt.md',
    'skills/loop-engineer/loop-final-review-prompt.md',
  ], 'six prompt templates');
});

test('npm tarball includes the engine scripts', () => {
  assertPacked([
    'scripts/bump-version.mjs',
    'scripts/autopilot.mjs',
    'scripts/task-results.mjs',
    'scripts/source-observation.mjs',
    'scripts/capture-review-evidence.mjs',
    'scripts/workflow-state.mjs',
    'scripts/loop-engineer.mjs',
    'scripts/validate-release-evidence.mjs',
  ], 'engine scripts');
});

test('npm tarball includes receipt instructions and the v2 reviewer transport schema', () => {
  assertPacked([
    'skills/implement/task-results-protocol.md',
    'skills/implement/reviewer-recovery.md',
    'skills/implement/reviewer-response-v2.schema.json',
    'adapters/reviewer-response.mjs',
  ]);
  assert.ok(!paths.includes('skills/implement/reviewer-response.schema.json'), 'v1 reviewer schema must not ship');
});

// The canonical dogfood bootstrap under `.agents/skills/<project>-bootstrap/`
// joined this payload lock when the scaffold self-apply landed (Task 20) —
// the file is a product source committed exactly as the scaffold produced it.
test('npm tarball includes the portable scaffold runtime, v1 sources, and canonical dogfood bootstrap', () => {
  assertPacked([
    'scripts/project-scaffold.mjs',
    'scripts/live-scaffold-canary.mjs',
    '.agents/skills/steepy-formula-bootstrap/SKILL.md',
    'templates/AGENTS.md',
    'templates/claude-import.md',
    'templates/project-bootstrap-skill.md',
    'templates/claude-bootstrap-stub.md',
    'templates/surface-agent-claude.md',
    'templates/surface-agent-codex.toml',
    'templates/surface-agent-opencode.md',
  ], 'portable scaffold payload');
  assert.equal(paths.some((p) => p.startsWith('templates/prior/')), false, 'tarball must not include templates/prior/');
});

test('npm pack dry-run leaves no repository tarball behind', () => {
  assert.equal(
    existsSync(join(root, packFilename)),
    false,
    'npm pack --dry-run must not create its reported tarball in the repository',
  );
});

test('npm tarball ships no hooks', () => {
  assert.deepEqual(paths.filter((path) => path.startsWith('hooks/')), [], 'no packed path starts with hooks/');
});

function reachedEngineModules(entry) {
  const reached = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    if (reached.has(current)) continue;
    reached.add(current);
    const source = readFileSync(join(root, current), 'utf8');
    for (const match of source.matchAll(/from\s+'(\.[^']+\.mjs)'/g)) {
      queue.push(join(dirname(current), match[1]).split('\\').join('/'));
    }
  }
  return [...reached].sort();
}

test('npm tarball includes the inception helper, its reached engine modules, and its prompts', () => {
  const modules = reachedEngineModules('scripts/inception-state.mjs');
  assert.ok(modules.includes('scripts/inception-state.mjs'));
  assert.ok(modules.includes('scripts/write-all.mjs') && modules.includes('scripts/sanitize.mjs'));
  assertPacked(modules, 'inception helper imports');
  assertPacked([
    'scripts/inception-protocol.mjs',
    'scripts/inception-snapshot.mjs',
    'scripts/capture-inception-evidence.mjs',
    'scripts/inception-governance.mjs',
    'skills/inception/SKILL.md',
    'skills/inception/research-prompt.md',
    'skills/inception/bootstrap-part-prompt.md',
    'skills/discovery/explore-inception-prompt.md',
    'skills/discovery/SKILL.md',
    'skills/init/SKILL.md',
    'docs/inception.md',
    'docs/inception-acceptance.md',
    'docs/architecture.md',
  ], 'inception skill files');
});

test('npm tarball includes the release tooling, the Claude directory icon, and the user guides', () => {
  assertPacked([
    'scripts/version-policy.mjs',
    'scripts/write-all.mjs',
    'scripts/push-version-guard.mjs',
    'scripts/publish-directory-branch.mjs',
    'scripts/extract-changelog.mjs',
    '.claude-plugin/icon.png',
    'docs/installation.md',
    'docs/getting-started.md',
    'docs/publication-readiness.md',
    'docs/release-evidence.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
  ], 'release tooling and guides');
  // The gears diagram describes the legacy Markdown hub ("Stable knowledge in .apex/"), so
  // formula does not ship it.
  assert.ok(!paths.includes('assets/workflow-gears.png'), 'the legacy gears diagram must not ship');
});

test('npm tarball includes the graph CLI entry and the engine adapter', () => {
  assertPacked([
    'bin/steepy-formula',
    'scripts/formula/cli.mjs',
    'scripts/formula/engine/arcadedb.mjs',
    'scripts/formula/engine/lifecycle.mjs',
    'scripts/formula/engine/secrets.mjs',
  ], 'graph CLI payload');
});

// Claude Code puts an enabled plugin's bin/ on the Bash tool's PATH; generated project
// instructions call `steepy-formula` by name, so the shim must be executable and forward verbatim.
test('the plugin bin/ shim is executable and forwards to the graph CLI', { skip: process.platform === 'win32' }, () => {
  const shim = join(root, 'bin', 'steepy-formula');
  const viaShim = spawnSync(shim, ['--help'], { encoding: 'utf8' });
  const direct = spawnSync(process.execPath, [join(root, 'scripts', 'formula', 'cli.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(viaShim.error, undefined, 'the shim must be directly executable');
  assert.equal(viaShim.status, direct.status);
  assert.equal(viaShim.stdout, direct.stdout);
  assert.equal(viaShim.stderr, direct.stderr);
});
