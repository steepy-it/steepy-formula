import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from '../scripts/template.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, '..', 'templates');

// The portable v1 template set (apex v0.9.4 port, full adaptation). Task 16
// retired the three legacy sources (root CLAUDE document, legacy bootstrap
// skill, legacy surface agent): project-scaffold.mjs renders every portable
// artifact from this set and render-claude-md.mjs renders the graph CLAUDE.md
// from its own inline template, so the retired files are deleted
// (USER-ADJUDICATED at pre-flight, deferred from Task 13 to this task).
const v1Templates = [
  'AGENTS.md',
  'claude-import.md',
  'project-bootstrap-skill.md',
  'claude-bootstrap-stub.md',
  'surface-agent-claude.md',
  'surface-agent-codex.toml',
  'surface-agent-opencode.md',
];

// G1 (9→10 skills) + apex v1.2.0 inception (10→11): every skill-enumeration shape
// in the generated set covers exactly the eleven canonical skills, graph-migrate and
// inception included, in the adapters' invocation order.
const ELEVEN_SKILLS = [
  'inception', 'init', 'check', 'new-surface', 'discovery', 'brainstorm', 'plan',
  'implement', 'review', 'loop-engineer', 'graph-migrate',
];

const renderVars = {
  projectName: 'demo-project',
  description: 'A portable demo project.',
  devCommands: '- `npm test`',
  surfaceList: '- `web` (`apps/web`) — `web-agent`',
  surface: 'web',
  path: 'apps/web',
  agent: 'web-agent',
  model: 'confirmed-model',
};

// The graph vocabulary (the core formula adaptation): a scaffold renders graph-mode
// artifacts only, so each of these placeholders is supplied by the renderer with the
// one canonical graph rendering pinned below. Graph renderings navigate via
// `steepy-formula hub-mode` + `steepy-formula context resolve` and never mention
// `.apex/_INDEX.md`. The navigation and the orientation carry the migrate and none
// stops right after the hub-mode declaration.

const MODE_STOPS =
  'If it reports `migrate`, stop and tell the user to run the `graph-migrate` skill; ' +
  'if it reports `none`, stop and tell the user to run the `init` skill.';

const graphNavigation =
  'For every task, use the `demo-project-bootstrap` skill first. If that skill is unavailable, ' +
  'run `steepy-formula hub-mode` and quote the `mode:` line. If it reports `migrate`, stop and tell ' +
  'the user to run the `graph-migrate` skill; if it reports `none`, stop and tell the user to run ' +
  'the `init` skill. Otherwise, resolve the task context with ' +
  '`steepy-formula context resolve --path <task-path>` (fallback ' +
  '`--target apex:<projectId>:surface:<slug>`) and load exactly what it returns.';

const graphOrientation = [
  '2. Declare the hub mode: run `steepy-formula hub-mode` and quote the `mode:` line. If it reports `migrate`, stop and tell the user to run the `graph-migrate` skill; if it reports `none`, stop and tell the user to run the `init` skill.',
  '3. Resolve the task context: run `steepy-formula context resolve --path <task-path>` for the paths the task will touch (fallback `--target apex:<projectId>:surface:<slug>`) and load exactly the layers the resolve returns (context.json + context.md).',
].join('\n');

const graphStandardOrientation =
  "resolve this surface's context with `steepy-formula context resolve --target apex:demo-project:surface:web` " +
  '(context.json + context.md) and follow the resolved rules and terms before working on this surface — ' +
  'never copy them into this adapter.';

const graphVars = {
  ...renderVars,
  navigation: graphNavigation,
  orientation: graphOrientation,
  standardOrientation: graphStandardOrientation,
};

function template(name) {
  return readFileSync(join(templatesDir, name), 'utf8');
}

function parseCodexAdapterToml(text) {
  const parsed = {};
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '' || line.startsWith('#')) continue;
    const assignment = line.match(/^([A-Za-z][A-Za-z0-9_-]*) = (.*)$/);
    assert.ok(assignment, `invalid TOML line ${index + 1}: ${line}`);
    const [, key, value] = assignment;
    assert.ok(!(key in parsed), `duplicate TOML key: ${key}`);
    if (value === '"""') {
      const body = [];
      index += 1;
      while (index < lines.length && lines[index] !== '"""') {
        assert.doesNotMatch(
          lines[index],
          /"""/,
          `unexpected TOML multiline delimiter inside ${key}`,
        );
        body.push(lines[index]);
        index += 1;
      }
      assert.ok(index < lines.length, `unterminated TOML multiline basic string: ${key}`);
      parsed[key] = body.join('\n');
      continue;
    }
    assert.match(value, /^"(?:[^"\\]|\\[btnfr"\\]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8})*"$/);
    parsed[key] = JSON.parse(value);
  }
  return parsed;
}

test('renderTemplate substitutes vars and throws on missing', () => {
  assert.equal(renderTemplate('hi {{x}}', { x: 'there' }), 'hi there');
  assert.throws(() => renderTemplate('{{missing}}', {}), /missing/);
});

test('v1 root instruction templates contain only their managed blocks, with graph navigation', () => {
  const agents = renderTemplate(template('AGENTS.md'), graphVars);
  assert.match(agents, /^<!-- steepy:managed:project-instructions:v1:start -->\n/);
  assert.match(agents, /\n<!-- steepy:managed:project-instructions:v1:end -->\n$/);
  assert.doesNotMatch(agents, /steepy:generated:/);
  assert.match(agents, /demo-project/);
  assert.match(agents, /A portable demo project\./);
  assert.match(agents, /npm test/);
  assert.match(agents, /web-agent/);
  assert.match(agents, /`demo-project-bootstrap`/);
  assert.match(agents, /steepy-formula hub-mode/, 'graph navigation must declare the hub mode');
  assert.match(agents, /steepy-formula context resolve/, 'graph navigation must resolve from the graph');
  assert.doesNotMatch(agents, /_INDEX\.md/, 'graph navigation must never reference the markdown hub');
  assert.ok(
    agents.includes(`quote the \`mode:\` line. ${MODE_STOPS} Otherwise, resolve the task context`),
    'graph navigation must stop on migrate and none right after the hub-mode declaration',
  );

  assert.equal(
    template('claude-import.md'),
    '<!-- steepy:managed:claude-import:v1:start -->\n@AGENTS.md\n<!-- steepy:managed:claude-import:v1:end -->\n',
  );
});

test('v1 generated templates render complete provenance and native thin graph adapters', () => {
  const generatedNames = v1Templates.slice(2);
  const rendered = Object.fromEntries(
    generatedNames.map((name) => [name, renderTemplate(template(name), graphVars)]),
  );

  for (const [name, text] of Object.entries(rendered)) {
    assert.doesNotMatch(text, /\{\{\w+\}\}/, `${name} leaked a placeholder`);
  }

  const skill = rendered['project-bootstrap-skill.md'];
  assert.match(
    skill,
    /^---\n[\s\S]*?\n---\n<!-- steepy:generated:demo-project-bootstrap:v1 -->\n/,
  );
  assert.match(skill, /`AGENTS\.md`/);
  assert.match(skill, /steepy-formula hub-mode/);
  assert.match(skill, /steepy-formula context resolve/);
  assert.doesNotMatch(skill, /_INDEX\.md/, 'graph bootstrap skill must not read the markdown hub');
  assert.ok(
    skill.includes(`quote the \`mode:\` line. ${MODE_STOPS}\n`),
    'graph bootstrap skill must stop on migrate and none right after the hub-mode declaration',
  );
  assert.match(
    skill,
    /^description: Project entry point for demo-project\. Loads the root instructions and routes work through the Stable Knowledge Graph\.$/m,
  );
  assert.match(
    skill,
    /^6\. Run the owning surface's test command and `steepy-formula graph validate` before reporting completion\.$/m,
  );
  assert.doesNotMatch(skill, /governed hub|hub coherence gate|\blegacy\b/i);
  assert.match(
    skill,
    /Do not ordinarily enumerate, search, or read under `\.formula\/work\/\*\*`/,
  );
  assert.match(
    skill,
    /accepted handoff.*exact work inputs|exact work inputs.*accepted handoff/is,
  );
  assert.match(
    skill,
    /pathless workflow invocation.*bounded workflow-header recovery discovery/i,
  );
  assert.match(
    skill,
    /exact paths or a broader work-area scope.*explicitly delimits/i,
  );
  assert.match(
    skill,
    /child agents.*only the phase orchestrator interprets a handoff/i,
  );
  assert.doesNotMatch(
    skill,
    /phase role maps|lifecycle transitions|envelope grammar|harness-specific invocation syntax|shared protocol reference/i,
  );
  assert.doesNotMatch(skill, /CLAUDE\.md|\/steepy-formula:/);

  const stub = rendered['claude-bootstrap-stub.md'];
  assert.match(
    stub,
    /^---\n[\s\S]*?\n---\n<!-- steepy:generated:demo-project-bootstrap-stub:v1 -->\n/,
  );
  assert.match(
    stub,
    /`\.agents\/skills\/demo-project-bootstrap\/SKILL\.md`/,
  );
  assert.doesNotMatch(stub, /\.apex\/_INDEX|## Procedure/);

  const adapters = [
    ['surface-agent-claude.md', '<!-- steepy:generated:web-agent-claude:v1 -->'],
    ['surface-agent-codex.toml', '# steepy:generated:web-agent-codex:v1'],
    ['surface-agent-opencode.md', '<!-- steepy:generated:web-agent-opencode:v1 -->'],
  ];
  for (const [name, provenance] of adapters) {
    const text = rendered[name];
    assert.match(text, /web-agent/);
    assert.match(text, /apps\/web/);
    assert.match(text, /demo-project-bootstrap/);
    if (name === 'surface-agent-codex.toml') {
      assert.match(text, /# Project description: A portable demo project\./);
    } else {
      // Apex v1.1.0: Claude and OpenCode descriptions name the surface and its path.
      assert.match(text, /^  Specialist for the web surface\. Use it for changes under apps\/web\.$/m);
      assert.doesNotMatch(text, /A portable demo project\./);
    }
    assert.equal(text.split(provenance).length - 1, 1, `${name} must carry one provenance marker`);
    assert.doesNotMatch(text, /Surface non-negotiables|Anti-patterns|## Conventions/);
    assert.doesNotMatch(text, /\.apex\/standards\//, `${name} must not hard-code a standards path`);
    assert.match(
      text,
      /steepy-formula context resolve --target apex:demo-project:surface:web/,
      'graph adapter must resolve its surface from the graph',
    );
    assert.doesNotMatch(text, /_INDEX\.md/, 'graph adapter must not route through the markdown hub');
  }
  assert.match(
    rendered['surface-agent-claude.md'],
    /^---\n[\s\S]*?\n---\n<!-- steepy:generated:web-agent-claude:v1 -->\n/,
  );
  assert.match(rendered['surface-agent-claude.md'], /^model: confirmed-model$/m);
  assert.match(rendered['surface-agent-codex.toml'], /^# steepy:generated:web-agent-codex:v1\n/);
  assert.doesNotMatch(rendered['surface-agent-codex.toml'], /^model\s*=/m);
  assert.match(
    rendered['surface-agent-opencode.md'],
    /^---\n[\s\S]*?\n---\n<!-- steepy:generated:web-agent-opencode:v1 -->\n/,
  );
});

test('Codex adapter remains valid TOML for a quote-bearing safe-line description', () => {
  const rendered = renderTemplate(template('surface-agent-codex.toml'), {
    ...graphVars,
    description: 'The "portable" project',
  });
  const parsed = parseCodexAdapterToml(rendered);

  assert.equal(parsed.name, 'web-agent');
  assert.equal(parsed.description, 'Specialist agent for web work.');
  assert.equal(parsed.model, undefined);
  assert.match(rendered, /# Project description: The "portable" project/);
  assert.match(parsed.developer_instructions, /demo-project-bootstrap/);
});

test('Codex adapter remains valid TOML for a quote-bearing safe relative path', () => {
  const path = 'apps/"""quoted"/web';
  const rendered = renderTemplate(template('surface-agent-codex.toml'), {
    ...graphVars,
    description: 'The "portable" project',
    path,
  });
  const parsed = parseCodexAdapterToml(rendered);

  assert.equal(parsed.name, 'web-agent');
  assert.equal(parsed.description, 'Specialist agent for web work.');
  assert.equal(parsed.model, undefined);
  assert.match(rendered, /# Project description: The "portable" project/);
  assert.ok(rendered.includes(`# Surface path: ${path}`));
  assert.match(parsed.developer_instructions, /demo-project-bootstrap/);
  assert.doesNotMatch(parsed.developer_instructions, /apps\//);
});

test('graph-mode Codex adapter resolves its standard from the graph and remains valid TOML', () => {
  const rendered = renderTemplate(template('surface-agent-codex.toml'), graphVars);
  const parsed = parseCodexAdapterToml(rendered);

  assert.equal(parsed.name, 'web-agent');
  assert.equal(parsed.model, undefined);
  assert.match(
    parsed.developer_instructions,
    /steepy-formula context resolve --target apex:demo-project:surface:web/,
  );
  assert.doesNotMatch(parsed.developer_instructions, /\.apex\/standards\//);
});

test('the generated bootstrap skill allowlists exactly the eleven canonical skills including graph-migrate and inception', () => {
  const rendered = renderTemplate(template('project-bootstrap-skill.md'), graphVars);
  // The orientation step names `graph-migrate` and `init` on its own (the migrate and
  // none stops), so only the allowlist sentence is enumerated.
  const allowlist = rendered.match(/one of the eleven canonical skills: ([^\n]*)/)?.[1] ?? '';
  const enumerated = [...allowlist.matchAll(/`([a-z][a-z-]*)`/g)]
    .map((match) => match[1])
    .filter((name) => ELEVEN_SKILLS.includes(name));
  assert.deepEqual(
    enumerated,
    ELEVEN_SKILLS,
    'the bootstrap skill must enumerate exactly the eleven canonical skills in order',
  );
  const raw = template('project-bootstrap-skill.md');
  assert.ok(raw.includes('`graph-migrate`'), 'graph-migrate must be part of the shipped allowlist');
  assert.ok(raw.includes('`inception`'), 'inception must be part of the shipped allowlist');
  assert.match(raw, /one of the eleven canonical skills:/);
});

test('the graph channel stays wired: graph variants carry the graph orientation; the retired legacy sources are gone', () => {
  // Task 16's retirement: the three retired-in-apex sources no longer exist, and
  // nothing under scripts/, skills/, adapters/, or tests/ references them (pinned
  // by the retirement guard below). The two graph variants stay as the graph
  // channel for init/graph-migrate's rendering.
  const retired = retiredTemplateNames();
  for (const name of retired) {
    assert.equal(existsSync(join(templatesDir, name)), false, `retired template must not exist: ${name}`);
  }
  for (const name of ['bootstrap-skill-graph.md', 'surface-agent-graph.md']) {
    assert.ok(existsSync(join(templatesDir, name)), `graph channel variant must exist: ${name}`);
  }

  // The graph channel carries the graph orientation the renderings parameterize.
  const graphBootstrap = template('bootstrap-skill-graph.md');
  assert.match(graphBootstrap, /steepy-formula hub-mode/);
  assert.match(graphBootstrap, /steepy-formula context resolve/);
  assert.doesNotMatch(graphBootstrap, /_INDEX\.md/, 'the graph bootstrap channel must not reference the markdown hub');
  const flatGraphBootstrap = graphBootstrap.replace(/\s+/g, ' ');
  assert.ok(
    flatGraphBootstrap.includes(`quote the \`mode:\` line. ${MODE_STOPS} If the \`steepy-formula\` command is not found`),
    'the graph bootstrap channel stops on migrate and none, then keeps the CLI-not-found stop',
  );
  assert.match(
    graphBootstrap,
    /^description: Per-task entry point for \{\{projectName\}\}\. Declares the hub mode, /m,
    'the graph bootstrap description is mode-neutral',
  );
  assert.match(
    graphBootstrap,
    /^Orientation comes from `steepy-formula hub-mode` and `steepy-formula context resolve`\.$/m,
  );
  assert.match(flatGraphBootstrap, /the resolve already did the sub-area scoping — beyond the layers there is nothing to read\./);
  assert.doesNotMatch(
    graphBootstrap,
    /\blegacy\b|markdown index|this bootstrap applies when it reports|in graph mode/i,
    'the graph bootstrap channel carries no mode-variant or retired-hub wording',
  );
  const graphAgent = template('surface-agent-graph.md');
  assert.match(graphAgent, /steepy-formula context resolve --target/);
  assert.doesNotMatch(graphAgent, /\.apex\/standards\//, 'the graph agent channel must not point at the legacy standards tree');

  // The canonical graph renderings stay consistent with those channels.
  assert.match(graphVars.navigation, /steepy-formula hub-mode/);
  assert.match(graphVars.navigation, /steepy-formula context resolve/);
  assert.doesNotMatch(graphVars.navigation, /_INDEX\.md/);
  assert.match(graphVars.orientation, /steepy-formula hub-mode/);
  assert.match(graphVars.orientation, /steepy-formula context resolve/);
  assert.doesNotMatch(graphVars.orientation, /_INDEX\.md/);
  assert.match(graphVars.standardOrientation, /steepy-formula context resolve --target/);
  assert.doesNotMatch(graphVars.standardOrientation, /\.apex\/standards\//);
});

// Same file-walk shape as the apex v0.9.4 retirement guard (task-16). The names
// are assembled from split halves so this file's own guard literals never spell
// a retired source path (the guard scans tests/ too).
function retiredTemplateNames() {
  return [
    ['CL', 'AUDE.md'],
    ['bootstrap', '-skill.md'],
    ['surface-agent', '.md'],
    ['_IN', 'DEX.md'],
    ['routing', '-row.md'],
    ['surface-standard', '.md'],
    ['surface-standard', '-core.md'],
  ].map(([prefix, suffix]) => `${prefix}${suffix}`);
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

test('final v1 layout excludes retired template sources and consumer reads', () => {
  const retiredSources = retiredTemplateNames().map((name) => `templates/${name}`);

  for (const directory of ['scripts', 'skills', 'adapters', 'tests']) {
    for (const path of sourceFiles(join(here, '..', directory))) {
      // The frozen dogfood export is graph data (provenance prose), not a consumer read.
      if (path.endsWith(join('tests', 'fixtures', 'dogfood-export.jsonl'))) continue;
      const source = readFileSync(path, 'utf8');
      for (const retiredSource of retiredSources) {
        assert.doesNotMatch(
          source,
          new RegExp(retiredSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          `${path} must not reference retired template source ${retiredSource}`,
        );
      }
    }
  }

  // Apex also pinned .apex/standards/templates.md here; formula's hub is the
  // canonical graph (no markdown templates standard exists), so the layout
  // contract is carried by this suite plus the deleted files themselves.
});

test('placeholder vocabulary is complete and documented — every code-rendered var is supplied (G10)', () => {
  const expectedPlaceholders = {
    'AGENTS.md': ['description', 'devCommands', 'navigation', 'projectName', 'surfaceList'],
    'claude-import.md': [],
    'project-bootstrap-skill.md': ['orientation', 'projectName'],
    'claude-bootstrap-stub.md': ['projectName'],
    'surface-agent-claude.md': ['agent', 'model', 'path', 'projectName', 'standardOrientation', 'surface'],
    'surface-agent-codex.toml': ['agent', 'description', 'path', 'projectName', 'standardOrientation', 'surface'],
    'surface-agent-opencode.md': ['agent', 'model', 'path', 'projectName', 'standardOrientation', 'surface'],
  };
  for (const [name, expected] of Object.entries(expectedPlaceholders)) {
    const raw = template(name);
    assert.doesNotMatch(raw, /\r/, `${name} must use LF line endings`);
    const found = [...new Set([...raw.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]))].sort();
    assert.deepEqual(found, expected, `${name} placeholder vocabulary must stay wired to the renderer`);
    for (const key of expected) {
      assert.ok(key in graphVars, `${name}: var ${key} missing from the graph render vars`);
    }
  }
});
