// Tests for the graph-only CLAUDE.md renderer (scripts/render-claude-md.mjs): the full root
// document carrying the graph navigation block, the `--upsert` managed-block channel, argument
// validation, and the migrate-state refusal (the refusal rows live in migrate-state.test.mjs too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATE_REFUSAL_EXIT, MIGRATE_REFUSAL_MESSAGE } from '../scripts/formula/core/markdown-hub.mjs';
import {
  main,
  navBlock,
  renderClaudeMd,
  STEEPY_END,
  STEEPY_START,
  upsertSteepyBlock,
} from '../scripts/render-claude-md.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'render-claude-md.mjs');

function tempHub() {
  return mkdtempSync(join(tmpdir(), 'steepy-render-root-'));
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('navBlock graph variant declares hub-mode and context resolve, never _INDEX.md', () => {
  const b = navBlock({ projectName: 'demo' });
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

test('upsertSteepyBlock replaces a pre-graph block with the graph block in place', () => {
  const legacy = [
    STEEPY_START,
    '## AI navigation',
    'Before touching code: run the `demo-bootstrap` skill, or read',
    '`.apex/_INDEX.md` (the navigation hub / DAG root).',
    'Specialist agents live in `.claude/agents/`.',
    STEEPY_END,
  ].join('\n');
  const seeded = `# proj\n\n${legacy}\n\n## License\nMIT\n`;
  const updated = upsertSteepyBlock(seeded, navBlock({ projectName: 'demo' }));
  assert.match(updated, /## License\nMIT/, 'user content after the markers must survive');
  assert.match(updated, /steepy-formula context resolve/);
  assert.doesNotMatch(updated, /_INDEX\.md/, 'the replaced block must not leave legacy nav behind');
  assert.equal((updated.match(/<!-- steepy:start -->/g) || []).length, 1);
  assert.equal((updated.match(/## AI navigation/g) || []).length, 1);
});

test('CLI fresh render writes the full root document, never the portable spine', () => {
  const hub = tempHub();
  const result = spawnSync(process.execPath, [script,
    '--hub', hub,
    '--project', 'portable-demo',
    '--description', 'One portable project.',
    '--dev', '- test: `npm test`',
    '--surface', '- web (apps/web)',
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

test('CLI upsert stays byte-stable and never writes the portable spine', () => {
  const hub = tempHub();
  const args = ['--hub', hub, '--project', 'portable-demo', '--upsert'];
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

test('CLI accepts an explicit --mode graph (init and graph-migrate pass it)', () => {
  const hub = tempHub();
  const result = run(['--hub', hub, '--project', 'portable-demo', '--upsert', '--mode', 'graph']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(hub, 'CLAUDE.md'), 'utf8'), /steepy-formula context resolve/);
});

test('CLI rejects --mode legacy without writing anything', () => {
  const hub = tempHub();
  const result = run(['--hub', hub, '--project', 'portable-demo', '--mode', 'legacy']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--mode/);
  assert.equal(existsSync(join(hub, 'CLAUDE.md')), false);
});

test('CLI no longer accepts --templates', () => {
  const hub = tempHub();
  const result = run(['--hub', hub, '--project', 'portable-demo', '--templates', hub]);
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(hub, 'CLAUDE.md')), false);
});

test('CLI validates arguments before writing', () => {
  assert.equal(main(['--project', 'portable-demo', '--unknown']), 1);
  assert.equal(main(['--hub', tempHub()]), 1);
});

test('CLI rejects a description with a line break before writing', () => {
  const hub = tempHub();
  const result = run(['--hub', hub, '--project', 'portable-demo', '--description', 'a\nb']);
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(hub, 'CLAUDE.md')), false);
});

test('CLI refuses in the migrate state: exit 25, shared message, no file written', () => {
  const hub = tempHub();
  mkdirSync(join(hub, '.apex'));
  writeFileSync(join(hub, '.apex', '_INDEX.md'), '# index\n');
  const result = run(['--hub', hub, '--project', 'portable-demo', '--upsert']);
  assert.equal(result.status, MIGRATE_REFUSAL_EXIT, result.stderr);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.split('\n').includes(`steepy render-claude-md: ${MIGRATE_REFUSAL_MESSAGE}`), result.stderr);
  assert.equal(existsSync(join(hub, 'CLAUDE.md')), false);
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
