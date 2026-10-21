// Ported from steepy-apex v0.9.4 tests/render-claude-md.test.mjs (task-16).
// Formula normalization: the `--mode graph` flag and the graph-mode rendering
// survive whole (init/graph-migrate channel), so the apex CLI cases run in the
// default legacy mode (the stub+import channel) and the graph channel keeps its
// own pinned cases; `projectModelFromArgs` output carries `hubMode` (formula's
// Project model requires the declared hub mode), and formula keeps the pure
// `renderClaudeMd` compatibility renderer (graph root document, or the exact
// formula <= v1.2.3 legacy CLAUDE.md that the scaffold recognizes as `legacy`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  main,
  navBlock,
  projectModelFromArgs,
  renderClaudeMd,
  STEEPY_END,
  STEEPY_START,
  upsertSteepyBlock,
} from '../scripts/render-claude-md.mjs';
import { parseProjectInstructions } from '../scripts/project-scaffold.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'render-claude-md.mjs');

function tempHub() {
  return mkdtempSync(join(tmpdir(), 'steepy-render-root-'));
}

function rootArgs(hub, extra = []) {
  return [
    '--hub', hub,
    '--project', 'portable-demo',
    '--description', 'One portable project.',
    '--dev', '- test: `npm test`',
    '--surface', '- web (apps/web)',
    ...extra,
  ];
}

test('root arguments translate to the public Project model v1', () => {
  assert.deepEqual(projectModelFromArgs({
    project: 'portable-demo',
    description: 'One portable project.',
    dev: ['- test: `npm test`'],
    surface: ['- web (apps/web)'],
  }), {
    projectName: 'portable-demo',
    description: 'One portable project.',
    devCommands: ['npm test'],
    surfaces: [{ name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'npm test' }],
    resolutions: {},
    hubMode: 'legacy',
  });
});

test('pure compatibility renderer keeps omitted and explicitly empty surfaces valid', () => {
  const omitted = renderClaudeMd({ projectName: 'portable-demo' });
  const explicit = renderClaudeMd({ projectName: 'portable-demo', surfaces: [] });

  assert.equal(explicit, omitted);
  assert.match(omitted, /^# portable-demo$/mu);
  assert.match(omitted, /^## Surfaces$/mu);
  assert.doesNotMatch(omitted, /^- [a-z0-9-]+ \([^)]+\)$/mu);
});

test('CLI preserves its flag schema and creates the managed AGENTS.md + CLAUDE.md pair', () => {
  const hub = tempHub();
  const result = spawnSync(process.execPath, [script, ...rootArgs(hub)], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(hub, 'AGENTS.md'), 'utf8'), /steepy:managed:project-instructions:v1:start/);
  assert.match(readFileSync(join(hub, 'CLAUDE.md'), 'utf8'), /steepy:managed:claude-import:v1:start/);
  assert.equal(main(['--project', 'portable-demo', '--unknown']), 1);
  assert.equal(main(['--project', 'portable-demo']), 1);
});

test('CLI round-trips a reserved heading in the fixed Project description slot', () => {
  const hub = tempHub();
  const result = spawnSync(process.execPath, [script, ...rootArgs(hub).map((value, index, values) => (
    values[index - 1] === '--description' ? '## Development commands' : value
  ))], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseProjectInstructions(readFileSync(join(hub, 'AGENTS.md'), 'utf8')).description,
    '## Development commands');
});

test('CLI rejects a literal managed Project delimiter before root writes', () => {
  const hub = tempHub();
  const argv = rootArgs(hub).map((value, index, values) => (
    values[index - 1] === '--description'
      ? '<!-- steepy:managed:project-instructions:v1:end -->'
      : value
  ));
  const result = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /managed Project.*marker/i);
  assert.equal(existsSync(join(hub, 'AGENTS.md')), false);
  assert.equal(existsSync(join(hub, 'CLAUDE.md')), false);
});

test('fresh root invocation without --surface creates only the root pair', () => {
  const hub = tempHub();
  const result = spawnSync(process.execPath, [script,
    '--hub', hub,
    '--project', 'portable-demo',
    '--description', 'One portable project.',
    '--dev', '- test: `npm test`',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const agents = readFileSync(join(hub, 'AGENTS.md'), 'utf8');
  assert.match(agents, /steepy:managed:project-instructions:v1:start/);
  assert.doesNotMatch(agents, /- `[^`]+` \(`[^`]+`\) — `[^`]+`/);
  assert.match(readFileSync(join(hub, 'CLAUDE.md'), 'utf8'), /steepy:managed:claude-import:v1:start/);
});

test('identical no-surface upsert keeps the fresh root pair canonical and byte-stable', () => {
  const hub = tempHub();
  const args = [
    '--hub', hub,
    '--project', 'portable-demo',
    '--description', 'One portable project.',
    '--dev', '- test: `npm test`',
  ];
  const fresh = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(fresh.status, 0, fresh.stderr);
  const agentsBefore = readFileSync(join(hub, 'AGENTS.md'));
  const claudeBefore = readFileSync(join(hub, 'CLAUDE.md'));

  const upsert = spawnSync(process.execPath, [script, ...args, '--upsert'], { encoding: 'utf8' });

  assert.equal(upsert.status, 0, upsert.stderr);
  const agentsAfter = readFileSync(join(hub, 'AGENTS.md'));
  const claudeAfter = readFileSync(join(hub, 'CLAUDE.md'));
  assert.deepEqual(agentsAfter, agentsBefore);
  assert.deepEqual(claudeAfter, claudeBefore);
  assert.doesNotMatch(agentsAfter.toString('utf8'), /root-agent|`root` \(`root`\)/);
  assert.equal((agentsAfter.toString('utf8').match(/steepy:managed:project-instructions:v1:start/g) || []).length, 1);
  assert.equal((claudeAfter.toString('utf8').match(/steepy:managed:claude-import:v1:start/g) || []).length, 1);
});

test('upsert safely adds both managed blocks without rewriting unmarked user-owned bytes', () => {
  const hub = tempHub();
  const agentsPrefix = Buffer.from('\uFEFF# User agent notes\r\nKeep this exactly.\r\n', 'utf8');
  const claudePrefix = Buffer.from('\uFEFF# Claude-only notes\r\nKeep this exactly too.\r\n', 'utf8');
  writeFileSync(join(hub, 'AGENTS.md'), agentsPrefix);
  writeFileSync(join(hub, 'CLAUDE.md'), claudePrefix);

  const result = spawnSync(process.execPath, [script, ...rootArgs(hub, ['--upsert'])], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const agents = readFileSync(join(hub, 'AGENTS.md'));
  const claude = readFileSync(join(hub, 'CLAUDE.md'));
  assert.deepEqual(agents.subarray(0, agentsPrefix.length), agentsPrefix);
  assert.deepEqual(claude.subarray(0, claudePrefix.length), claudePrefix);
  assert.match(agents.toString('utf8'), /\r\n<!-- steepy:managed:project-instructions:v1:start -->/);
  assert.match(claude.toString('utf8'), /\r\n<!-- steepy:managed:claude-import:v1:start -->/);
});

test('unmanaged @AGENTS.md import blocks the wrapper without writing either root file', () => {
  const hub = tempHub();
  const agents = Buffer.from('# User agent notes\n', 'utf8');
  const claude = Buffer.from('# Claude-only notes\n@AGENTS.md\n', 'utf8');
  writeFileSync(join(hub, 'AGENTS.md'), agents);
  writeFileSync(join(hub, 'CLAUDE.md'), claude);

  const result = spawnSync(process.execPath, [script, ...rootArgs(hub, ['--upsert'])], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.deepEqual(readFileSync(join(hub, 'AGENTS.md')), agents);
  assert.deepEqual(readFileSync(join(hub, 'CLAUDE.md')), claude);
});

// --- formula graph channel: the flag and its rendering survive whole ----------

test('navBlock graph variant declares hub-mode and context resolve, never _INDEX.md', () => {
  const b = navBlock({ projectName: 'demo', mode: 'graph' });
  assert.ok(b.startsWith(STEEPY_START), 'graph nav block must start with the steepy marker');
  assert.ok(b.trimEnd().endsWith(STEEPY_END), 'graph nav block must end with the steepy marker');
  assert.match(b, /run the `demo-bootstrap` skill/);
  assert.match(b, /steepy-formula hub-mode/);
  assert.match(b, /steepy-formula context resolve/);
  assert.doesNotMatch(b, /_INDEX\.md/, 'the graph nav block must not point at the markdown hub');
});

test('renderClaudeMd with mode graph embeds the graph nav block in the full root document', () => {
  const out = renderClaudeMd({
    projectName: 'demo',
    description: 'A demo project.',
    devCommands: ['- test: `vitest run`'],
    surfaces: ['- web (apps/web)'],
    mode: 'graph',
  });
  assert.match(out, /^# demo$/m);
  assert.match(out, /A demo project\./);
  assert.match(out, /- test: `vitest run`/);
  assert.match(out, /- web \(apps\/web\)/);
  assert.match(out, /run the `demo-bootstrap` skill/);
  assert.match(out, /steepy-formula hub-mode/);
  assert.match(out, /steepy-formula context resolve/);
  assert.doesNotMatch(out, /_INDEX\.md/, 'graph-mode CLAUDE.md must not point at the markdown hub');
});

test('renderClaudeMd default mode is byte-identical to explicit legacy mode', () => {
  const input = {
    projectName: 'demo',
    description: 'A demo project.',
    devCommands: ['- test: `vitest run`'],
    surfaces: ['- web (apps/web)'],
  };
  assert.equal(renderClaudeMd(input), renderClaudeMd({ ...input, mode: 'legacy' }));
});

test('upsertSteepyBlock replaces a legacy block with a graph block in place', () => {
  const legacy = navBlock({ projectName: 'demo' });
  const seeded = `# proj\n\n${legacy}\n\n## License\nMIT\n`;
  const updated = upsertSteepyBlock(seeded, navBlock({ projectName: 'demo', mode: 'graph' }));
  assert.match(updated, /## License\nMIT/, 'user content after the markers must survive');
  assert.match(updated, /steepy-formula context resolve/);
  assert.doesNotMatch(updated, /_INDEX\.md/, 'the replaced block must not leave legacy nav behind');
  assert.equal((updated.match(/<!-- steepy:start -->/g) || []).length, 1);
  assert.equal((updated.match(/## AI navigation/g) || []).length, 1);
});

test('graph-mode CLI fresh render writes the full root document, never the portable spine', () => {
  const hub = tempHub();
  const result = spawnSync(process.execPath, [script,
    '--hub', hub,
    '--project', 'portable-demo',
    '--description', 'One portable project.',
    '--dev', '- test: `npm test`',
    '--surface', '- web (apps/web)',
    '--mode', 'graph',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(join(hub, 'CLAUDE.md'), 'utf8');
  assert.match(text, /^# portable-demo$/m);
  assert.match(text, /One portable project\./);
  assert.match(text, /- test: `npm test`/);
  assert.match(text, /- web \(apps\/web\)/);
  assert.match(text, /steepy-formula hub-mode/);
  assert.match(text, /steepy-formula context resolve/);
  assert.doesNotMatch(text, /_INDEX\.md/, 'the graph root document must not point at the markdown hub');
  assert.equal(existsSync(join(hub, 'AGENTS.md')), false, 'the graph channel must not write the AGENTS.md spine');
});

test('graph-mode CLI upsert stays byte-stable and never writes the portable spine', () => {
  const hub = tempHub();
  const args = ['--hub', hub, '--project', 'portable-demo', '--upsert', '--mode', 'graph'];
  const first = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const claudeBefore = readFileSync(join(hub, 'CLAUDE.md'), 'utf8');
  assert.match(claudeBefore, /steepy-formula context resolve/);
  assert.doesNotMatch(claudeBefore, /_INDEX\.md/);

  const second = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(hub, 'CLAUDE.md'), 'utf8'), claudeBefore);
  assert.equal(existsSync(join(hub, 'AGENTS.md')), false, 'the graph channel must not write the AGENTS.md spine');
});

test('CLI rejects an unknown --mode without writing anything', () => {
  const hub = tempHub();
  const result = spawnSync(process.execPath, [script,
    '--hub', hub,
    '--project', 'portable-demo',
    '--mode', 'dual',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--mode/);
  assert.equal(existsSync(join(hub, 'CLAUDE.md')), false);
  assert.equal(existsSync(join(hub, 'AGENTS.md')), false);
});
