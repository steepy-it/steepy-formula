import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold, main } from '../scripts/new-surface.mjs';
import {
  applyProjectScaffold,
  planRootInstructions,
  renderLegacyClaudeSpecialist,
} from '../scripts/project-scaffold.mjs';

// Ported from steepy-apex v0.9.4 tests/new-surface.test.mjs (task-15). Formula
// normalization: the scaffolder composes through the project-scaffold planner, so a
// fresh surface renders the full adapter triad; the mode-aware split adds the graph
// refusals below (the planner is the legacy file-writing channel only), and the
// retained skill-prose pins at the bottom of this file guard the skill-layer split.

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, '..', 'templates');

function tempHub() {
  return mkdtempSync(join(tmpdir(), 'steepy-new-surface-'));
}

function args(hubRoot, overrides = {}) {
  return {
    name: 'web',
    surfacePath: 'apps/web',
    agent: 'web-agent',
    hubRoot,
    templatesDir,
    testCmd: 'npm test',
    ...overrides,
  };
}

function adapterPaths(hubRoot, agent = 'web-agent') {
  return {
    claude: join(hubRoot, '.claude', 'agents', `${agent}.md`),
    codex: join(hubRoot, '.codex', 'agents', `${agent}.toml`),
    opencode: join(hubRoot, '.opencode', 'agents', `${agent}.md`),
  };
}

function snapshot(root) {
  const result = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isDirectory()) {
        result.push([`${rel}/`, null]);
        walk(path);
      } else if (entry.isSymbolicLink()) {
        result.push([rel, 'symlink']);
      } else {
        result.push([rel, readFileSync(path, 'utf8')]);
      }
    }
  }
  walk(root);
  return result;
}

function writeCurrentTriad(hubRoot) {
  const sourceHub = tempHub();
  const source = scaffold(args(sourceHub));
  for (const [adapter, sourcePath] of Object.entries(source.adapterPaths)) {
    const target = adapterPaths(hubRoot)[adapter];
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(sourcePath));
  }
}

test('fresh scaffold creates one standard and the Claude, Codex, and OpenCode adapter triad', () => {
  const hubRoot = tempHub();
  const indexPath = join(hubRoot, '.apex', '_INDEX.md');
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, 'CUSTOM INDEX\n');

  const result = scaffold(args(hubRoot));
  const expectedAdapters = adapterPaths(hubRoot);
  assert.deepEqual(Object.keys(result), [
    'standardPath', 'agentPath', 'adapterPaths', 'row', 'created', 'updated', 'preserved', 'otherWrites', 'mode',
  ]);
  assert.equal(result.mode, 'preparatory-unbound');
  assert.equal(result.standardPath, join(hubRoot, '.apex', 'standards', 'web.md'));
  assert.equal(result.agentPath, expectedAdapters.claude);
  assert.deepEqual(result.adapterPaths, expectedAdapters);
  assert.deepEqual(result.created, ['standard', 'claude', 'codex', 'opencode']);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.preserved, []);
  assert.deepEqual(result.otherWrites, []);
  assert.equal(result.row, '| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |');
  assert.equal(readFileSync(indexPath, 'utf8'), 'CUSTOM INDEX\n');
  const renderedStandard = readFileSync(result.standardPath, 'utf8');
  assert.match(renderedStandard, /```[\s\S]*npm test[\s\S]*```/);
  assert.doesNotMatch(renderedStandard, /`npm test`/);
  for (const path of Object.values(result.adapterPaths)) assert.ok(existsSync(path), path);
});

test('non-repair blocks an existing adapter before writing any missing target', () => {
  const sourceHub = tempHub();
  const source = scaffold(args(sourceHub));
  const hubRoot = tempHub();
  const paths = adapterPaths(hubRoot);
  mkdirSync(dirname(paths.claude), { recursive: true });
  writeFileSync(paths.claude, readFileSync(source.adapterPaths.claude));
  const before = snapshot(hubRoot);

  assert.throws(() => scaffold(args(hubRoot)), /already exists/i);
  assert.deepEqual(snapshot(hubRoot), before);
  assert.ok(!existsSync(join(hubRoot, '.apex', 'standards', 'web.md')));
  assert.ok(!existsSync(paths.codex));
  assert.ok(!existsSync(paths.opencode));
});

test('standard destination staging failure leaves the standard and all adapters absent', () => {
  const hubRoot = tempHub();
  const standardsDir = join(hubRoot, '.apex', 'standards');
  const standardPath = join(standardsDir, 'web.md');
  const paths = adapterPaths(hubRoot);
  mkdirSync(standardsDir, { recursive: true });
  chmodSync(standardsDir, 0o555);

  try {
    assert.throws(() => scaffold(args(hubRoot)), /EACCES|permission denied/i);
    assert.equal(existsSync(standardPath), false);
    for (const path of Object.values(paths)) assert.equal(existsSync(path), false, path);
    assert.equal(readdirSync(standardsDir).some((name) => name.includes('.steepy-new-surface-')), false);
  } finally {
    chmodSync(standardsDir, 0o755);
  }
});

test('repair preserves a standard and current Claude adapter while creating missing adapters', () => {
  const hubRoot = tempHub();
  const standardPath = join(hubRoot, '.apex', 'standards', 'web.md');
  mkdirSync(dirname(standardPath), { recursive: true });
  writeFileSync(standardPath, 'CUSTOM STANDARD\n');
  const sourceHub = tempHub();
  const source = scaffold(args(sourceHub));
  const paths = adapterPaths(hubRoot);
  mkdirSync(dirname(paths.claude), { recursive: true });
  writeFileSync(paths.claude, readFileSync(source.adapterPaths.claude));

  const result = scaffold(args(hubRoot, { repair: true }));
  assert.equal(readFileSync(standardPath, 'utf8'), 'CUSTOM STANDARD\n');
  assert.equal(readFileSync(paths.claude, 'utf8'), readFileSync(source.adapterPaths.claude, 'utf8'));
  assert.ok(existsSync(paths.codex));
  assert.ok(existsSync(paths.opencode));
  assert.deepEqual(result.created, ['codex', 'opencode']);
  assert.deepEqual(result.preserved, ['standard', 'claude']);
});

test('repair creates a missing standard while preserving a current adapter triad', () => {
  const hubRoot = tempHub();
  writeCurrentTriad(hubRoot);
  const before = Object.fromEntries(Object.entries(adapterPaths(hubRoot))
    .map(([adapter, path]) => [adapter, readFileSync(path, 'utf8')]));

  const result = scaffold(args(hubRoot, { repair: true }));
  assert.ok(existsSync(result.standardPath));
  for (const [adapter, path] of Object.entries(result.adapterPaths)) {
    assert.equal(readFileSync(path, 'utf8'), before[adapter]);
  }
  assert.deepEqual(result.created, ['standard']);
  assert.deepEqual(result.preserved, ['claude', 'codex', 'opencode']);
});

// Formula keeps exact recognition of its own pre-portable (formula <= v1.2.3) Claude
// specialist: an untouched one is upgraded in place, while any other unmarked
// specialist (below) stays a refused conflict.
test('repair migrates an exact legacy Claude specialist and creates missing siblings', () => {
  const hubRoot = tempHub();
  const paths = adapterPaths(hubRoot);
  mkdirSync(dirname(paths.claude), { recursive: true });
  const legacy = renderLegacyClaudeSpecialist({
    name: 'web', path: 'apps/web', agent: 'web-agent', testCmd: 'npm test',
  });
  writeFileSync(paths.claude, legacy);

  const result = scaffold(args(hubRoot, { repair: true }));
  assert.notEqual(readFileSync(paths.claude, 'utf8'), legacy);
  assert.match(readFileSync(paths.claude, 'utf8'), /steepy:generated:web-agent-claude:v1/);
  assert.deepEqual(result.created, ['standard', 'codex', 'opencode']);
  assert.deepEqual(result.updated, ['claude']);
  assert.deepEqual(result.preserved, []);
});

test('repair refuses an unmarked Claude specialist without writing siblings', () => {
  const hubRoot = tempHub();
  const paths = adapterPaths(hubRoot);
  mkdirSync(dirname(paths.claude), { recursive: true });
  const content = '---\nname: web-agent\nmodel: sonnet\n---\nYou specialize in web work.\n';
  writeFileSync(paths.claude, content);
  assert.throws(() => scaffold(args(hubRoot, { repair: true })), /customized|conflict/i);
  assert.equal(readFileSync(paths.claude, 'utf8'), content);
  assert.equal(existsSync(paths.codex), false);
  assert.equal(existsSync(paths.opencode), false);
});

for (const [label, target, content, pattern] of [
  ['customized', 'claude', 'CUSTOM SPECIALIST\n', /customized|conflict/i],
  ['malformed', 'codex', '# steepy:generated:web-agent-codex:v2\n', /malformed|unknown-version|conflict/i],
]) {
  test(`repair blocks a ${label} adapter with zero writes`, () => {
    const hubRoot = tempHub();
    const path = adapterPaths(hubRoot)[target];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    const before = snapshot(hubRoot);
    assert.throws(() => scaffold(args(hubRoot, { repair: true })), pattern);
    assert.deepEqual(snapshot(hubRoot), before);
  });
}

test('repair blocks a symlink adapter with zero writes outside the hub', () => {
  const hubRoot = tempHub();
  const outside = tempHub();
  const outsidePath = join(outside, 'sentinel.md');
  writeFileSync(outsidePath, 'OUTSIDE\n');
  const claudePath = adapterPaths(hubRoot).claude;
  mkdirSync(dirname(claudePath), { recursive: true });
  symlinkSync(outsidePath, claudePath);
  const before = snapshot(hubRoot);

  assert.throws(() => scaffold(args(hubRoot, { repair: true })), /symlink|conflict/i);
  assert.deepEqual(snapshot(hubRoot), before);
  assert.equal(readFileSync(outsidePath, 'utf8'), 'OUTSIDE\n');
});

test('repair preserves a modular standard core and does not create the single-file form', () => {
  const hubRoot = tempHub();
  const corePath = join(hubRoot, '.apex', 'standards', 'web', 'web-core.md');
  const singlePath = join(hubRoot, '.apex', 'standards', 'web.md');
  mkdirSync(dirname(corePath), { recursive: true });
  writeFileSync(corePath, 'CUSTOM CORE\n');

  const result = scaffold(args(hubRoot, { repair: true }));
  assert.equal(result.standardPath, corePath);
  assert.equal(readFileSync(corePath, 'utf8'), 'CUSTOM CORE\n');
  assert.equal(existsSync(singlePath), false);
  assert.deepEqual(result.created, ['claude', 'codex', 'opencode']);
  assert.deepEqual(result.preserved, ['standard']);
});

test('repair rerun is a byte- and timestamp-preserving no-op with the Claude alias intact', () => {
  const hubRoot = tempHub();
  const first = scaffold(args(hubRoot));
  const watched = [first.standardPath, ...Object.values(first.adapterPaths)];
  const before = watched.map((path) => ({ path, bytes: readFileSync(path), mtime: lstatSync(path).mtimeMs }));

  const rerun = scaffold(args(hubRoot, { repair: true }));
  assert.equal(rerun.agentPath, rerun.adapterPaths.claude);
  assert.deepEqual(rerun.created, []);
  assert.deepEqual(rerun.preserved, ['standard', 'claude', 'codex', 'opencode']);
  for (const prior of before) {
    assert.deepEqual(readFileSync(prior.path), prior.bytes);
    assert.equal(lstatSync(prior.path).mtimeMs, prior.mtime);
  }
});

test('unsafe values are rejected before planning or writing', () => {
  const hubRoot = tempHub();
  assert.throws(() => scaffold(args(hubRoot, { name: '../../pwned' })), /invalid (surface )?name/i);
  assert.throws(() => scaffold(args(hubRoot, { agent: '../escape' })), /invalid agent name/i);
  assert.throws(() => scaffold(args(hubRoot, { surfacePath: 'apps/../../etc' })), /unsafe path/i);
  assert.throws(() => scaffold(args(hubRoot, { testCmd: 'npm test\nmalicious' })), /unsafe testCmd/i);
  for (const testCmd of ['```', '````', '  ```   ']) {
    assert.throws(() => scaffold(args(hubRoot, { testCmd })), /testCmd.*Markdown fence/i);
  }
  for (const testCmd of ['node --test \ud800', 'node --test \udfff']) {
    assert.throws(() => scaffold(args(hubRoot, { testCmd })), /testCmd.*UTF-8/i);
  }
  assert.deepEqual(snapshot(hubRoot), []);
});

test('preparatory new-surface preserves valid Unicode and harmless shell backticks byte-exactly', () => {
  const hubRoot = tempHub();
  const testCmd = 'node -e "console.log(`café 😀`)"';
  const result = scaffold(args(hubRoot, { testCmd }));
  const standard = readFileSync(result.standardPath, 'utf8');

  assert.ok(standard.includes(`\`\`\`sh\n${testCmd}\n\`\`\``));
  assert.doesNotMatch(standard, /�/u);
});

test('main keeps init compatibility and creates the complete triad', () => {
  const hubRoot = tempHub();
  const code = main(['--name', 'web', '--path', 'apps/web', '--hub', hubRoot, '--test', 'npm test']);
  assert.equal(code, 0);
  assert.ok(existsSync(join(hubRoot, '.apex', 'standards', 'web.md')));
  for (const path of Object.values(adapterPaths(hubRoot))) assert.ok(existsSync(path), path);
});

test('main maps usage and scaffold failures to their established exit codes', () => {
  assert.equal(main([]), 2);
  assert.equal(main(['--name', '../../pwned', '--path', 'x', '--hub', tempHub()]), 1);
});

test('the real standard templates retain their required structure', () => {
  const standard = readFileSync(join(templatesDir, 'surface-standard.md'), 'utf8');
  for (const heading of ['## Scope', '## Conventions', '## Anti-patterns', '## Testing']) {
    assert.ok(standard.includes(heading), heading);
  }
  for (const placeholder of ['{{name}}', '{{path}}', '{{testCmd}}']) {
    assert.ok(standard.includes(placeholder), placeholder);
  }
  for (const prompt of ['Owns', 'Does NOT own', 'Exemplar']) {
    assert.ok(standard.includes(prompt), prompt);
  }
  const core = readFileSync(join(templatesDir, 'surface-standard-core.md'), 'utf8');
  for (const heading of ['## Scope', '## Conventions', '## Sub-area routing', '## Testing']) {
    assert.ok(core.includes(heading), heading);
  }
  assert.ok(core.includes('| Sub-area | When to read it (path/topic) | Doc |'));
  for (const placeholder of ['{{name}}', '{{path}}', '{{testCmd}}']) {
    assert.ok(core.includes(placeholder), placeholder);
  }
  for (const prompt of ['Owns', 'Does NOT own', 'Exemplar']) {
    assert.ok(core.includes(prompt), prompt);
  }
  assert.ok(core.includes('zero matches'));
  for (const template of ['surface-agent-claude.md', 'surface-agent-codex.toml', 'surface-agent-opencode.md']) {
    assert.ok(existsSync(join(templatesDir, template)), template);
  }
});

// --- mode-aware split (formula): the planner is the legacy file-writing channel -----
// Graph-mode surfaces are promoted into the canonical Stable Knowledge Graph through
// the structural-promotion seam (skills/new-surface graph branch); this scaffolder
// must refuse the graph channel before any planning or write.

test('a declared graph mode and off-vocabulary modes are refused before any planning or write', () => {
  const hubRoot = tempHub();
  const before = snapshot(hubRoot);
  assert.throws(() => scaffold(args(hubRoot, { hubMode: 'graph' })), /structural-promotion|graph-mode/iu);
  assert.throws(() => scaffold(args(hubRoot, { hubMode: 'none' })), /hubMode/iu);
  assert.deepEqual(snapshot(hubRoot), before);
});

test('an active graph-mode hub (graph navigation spine) is refused before every write', () => {
  const hubRoot = tempHub();
  applyProjectScaffold({
    hubRoot,
    plan: planRootInstructions({
      hubRoot,
      model: {
        projectName: 'portable-demo',
        description: 'Portable demo project.',
        devCommands: ['npm test'],
        surfaces: [],
        resolutions: {},
        hubMode: 'graph',
      },
      templatesDir,
    }),
  });
  const before = snapshot(hubRoot);

  assert.throws(
    () => scaffold(args(hubRoot, { name: 'api', surfacePath: 'services/api', agent: 'api-agent' })),
    /structural-promotion|graph-mode/iu,
  );
  assert.deepEqual(snapshot(hubRoot), before);
  assert.equal(existsSync(join(hubRoot, '.apex')), false,
    'a graph-mode refusal must never scaffold .apex/standards/ or an _INDEX.md');
});

// ---------------------------------------------------------------------------
// skills/new-surface/SKILL.md — mode-aware prose pins. The regression guarded
// here: on a graph-first repo (no markdown hub) the old skill scaffolded
// .apex/standards/<name>.md and told the operator to paste a routing row into a
// nonexistent _INDEX.md — making .apex/ non-work-only with no index, which
// flips validate-hub (and the Stop hook) permanently red. The graph branch
// must create no markdown-hub file and instead render the graph-mode agent and
// promote the Surface (verification Rule + Check with ext_v1_command) through
// the structural-promotion helper.
// ---------------------------------------------------------------------------

const skillText = readFileSync(join(here, '..', 'skills', 'new-surface', 'SKILL.md'), 'utf8');

function sectionBetween(body, startMarker, endMarker) {
  const start = body.indexOf(startMarker);
  assert.ok(start >= 0, `section marker not found: ${startMarker}`);
  if (endMarker === null) return body.slice(start);
  const end = body.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `section end marker not found after '${startMarker}': ${endMarker}`);
  return body.slice(start, end);
}

test('new-surface skill: description is mode-aware and the hub-mode declaration routes the run', () => {
  const fm = skillText.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, 'SKILL.md must keep YAML frontmatter');
  assert.match(fm[1], /name:\s*new-surface\b/);
  assert.match(fm[1], /user-invocable:\s*true/);
  assert.match(fm[1], /hub-mode/, 'the description must name the hub-mode declaration');
  assert.match(fm[1], /graph/, 'the description must name the graph route');
  assert.match(fm[1], /legacy/, 'the description must name the legacy route');

  const declaration = sectionBetween(skillText, '2. **Declare the hub mode.**', '### Legacy mode');
  assert.match(declaration, /`steepy-formula hub-mode`/, 'the declaration must run steepy-formula hub-mode');
  assert.match(declaration, /`mode:` line/, 'the declaration must quote the mode: line');
  assert.match(declaration, /single authority/, 'detection must stay with the command');
  assert.match(declaration, /\| `legacy` \| Steps 3–5/, 'the legacy row must route to the markdown scaffold steps');
  assert.match(declaration, /\| `graph` \| Steps 6–9/, 'the graph row must route to the promotion steps');
  assert.match(declaration, /Never scaffold `\.apex\/standards\/`/, 'the graph row must forbid the standards scaffold');
  assert.match(declaration, /never touch `\.apex\/_INDEX\.md`/, 'the graph row must forbid touching _INDEX.md');
  assert.match(declaration, /permanently red/, 'the rationale must name the linter/Stop-hook consequence');
  assert.match(declaration, /\| `none` \|.*`init` skill/, 'mode none must route to init and stop');
  // The declaration precedes both branches.
  assert.ok(skillText.indexOf('**Declare the hub mode.**') < skillText.indexOf('### Legacy mode'));
  assert.ok(skillText.indexOf('**Declare the hub mode.**') < skillText.indexOf('### Graph mode'));
});

test('new-surface skill step 1 gathers the specialist agent alongside name, path, and test command', () => {
  const gather = sectionBetween(skillText, '## Procedure', '2. **Declare the hub mode.**');
  assert.match(gather, /four pieces of information/i, 'the gathered input set is four pieces now');
  assert.match(gather, /Specialist agent/i, 'the specialist agent must be gathered');
  assert.match(gather, /defaulting to `<name>-agent` only when the user accepts it/,
    'the <name>-agent default is accepted, never assumed');
});

test('new-surface skill legacy branch: planner-composed scaffolder invocation + validate-hub gate', () => {
  const legacy = sectionBetween(skillText, '### Legacy mode', '### Graph mode');
  assert.match(legacy, /node <engine-root>\/scripts\/new-surface\.mjs/, 'the legacy branch must run the shipped scaffolder');
  for (const flag of ['--name <name>', '--path <path>', '--agent <agent>', '--test "<testCmd>"', '--hub <repo-root>']) {
    assert.ok(legacy.includes(flag), `the scaffolder invocation must keep ${flag}`);
  }
  assert.match(legacy, /node <engine-root>\/scripts\/validate-hub\.mjs \./, 'the legacy verify step must keep validate-hub with the explicit `.`');
  assert.doesNotMatch(legacy, /structural-promotion/, 'the legacy branch must not mix in the graph promotion');
});

// Task 18 (apex v0.9.4 port + the Task 15 accumulated forward requirement): the
// legacy branch states the planner-composed reality — the three stale-prose fixes.
test('new-surface skill legacy branch states the planner-composed active-v1/preparatory-unbound reality', () => {
  const legacy = sectionBetween(skillText, '### Legacy mode', '### Graph mode');
  // the planner contract both modes share
  assert.match(legacy, /project-scaffold\.mjs/, 'the legacy branch must name the common project planner');
  assert.match(legacy, /active-v1[\s\S]*real Project identity[\s\S]*full Project model/iu,
    'active-v1 derives the real Project identity and routes through the full Project model');
  assert.match(legacy, /preparatory-unbound[\s\S]*without pretending to update a Project/iu,
    'preparatory-unbound must stay explicit about not updating a nonexistent Project identity');
  assert.match(legacy, /standard[\s\S]*create-only/iu, 'the standard remains create-only');
  assert.match(legacy, /plans all four[\s\S]*before the first[\s\S]*write/i,
    'preparatory-unbound plans all four artifacts before the first write');
  assert.match(legacy, /root,\s+routing\s+row,\s+standard,\s+and\s+triad\s+agree/iu,
    'active-v1: the public workflow already made the artifacts agree');
  assert.match(legacy, /bytes, modes, and mtimes unchanged/iu,
    'the --repair rerun must be a byte/mode/mtime-preserving no-op');
  // fix 1 — the surface result is four artifacts, not "the two files it created"
  assert.match(legacy, /four artifacts/i, 'the surface result must be stated as four artifacts');
  for (const path of [
    '.apex/standards/<name>.md',
    '.claude/agents/<agent>.md',
    '.codex/agents/<agent>.toml',
    '.opencode/agents/<agent>.md',
  ]) {
    assert.ok(legacy.includes(path), `the surface result must name ${path}`);
  }
  assert.doesNotMatch(legacy, /two files/, 'the stale "two files" print claim must be gone');
  // fix 2 — on bound (active-v1) legacy hubs the script inserts the routing row itself
  assert.match(legacy, /inserts the routing row\s+itself/i,
    'active-v1: the script inserts the routing row itself (staged, create-only)');
  assert.match(legacy, /active-v1 root instructions and routing are\s+coherent with the surface result/,
    'active-v1: the coherence line the script prints must be quoted');
  assert.match(legacy, /preparatory-unbound\*\* mode only,\s+the\s+paste-row flow survives/i,
    'the paste-row flow must survive only on preparatory-unbound hubs');
  assert.doesNotMatch(legacy, /intentionally does not edit/,
    'the stale "intentionally does not edit _INDEX.md" claim must be gone');
  // fix 3 — conflict resolution for active-v1 hubs with a customized spine
  assert.match(legacy, /--resolution <id=choice>/, 'conflicts route through --resolution <id=choice>');
  assert.match(legacy, /customized\s+spine/, 'the customized-spine conflict example must be named');
});

test('new-surface skill graph branch: creates no markdown-hub file — agent rendered from surface-agent-graph.md, no standards doc, no _INDEX.md', () => {
  const graph = sectionBetween(skillText, '### Graph mode', null);
  assert.match(graph, /`\.claude\/agents\/<surface-name>-agent\.md`/, 'the graph branch must create the deterministic agent file');
  assert.match(graph, /<engine-root>\/templates\/surface-agent-graph\.md/, 'the agent must be rendered from the graph-mode template');
  assert.match(graph, /`\{\{name\}\}` and `\{\{path\}\}`/, 'the render must substitute the template placeholders');
  assert.match(graph, /NOT invoked/, 'the legacy scaffolder must be explicitly not invoked');
  assert.match(graph, /no routing table in graph\s+mode/, 'binding must be deterministic, no routing table');
  assert.doesNotMatch(graph, /\.apex\/standards\//, 'the graph branch must never name a standards path');
  assert.doesNotMatch(graph, /_INDEX\.md/, 'the graph branch must never name _INDEX.md');
  assert.doesNotMatch(graph, /validate-hub/, 'the graph branch must never run the legacy linter');
});

test('new-surface skill graph branch: drives the structural-promotion helper with its real flags and input shape, then preview/apply', () => {
  const graph = sectionBetween(skillText, '### Graph mode', null);
  // The helper invocation, with the flags scripts/structural-promotion.mjs actually parses.
  assert.match(graph, /node <engine-root>\/scripts\/structural-promotion\.mjs/, 'the graph branch must drive the shipped helper');
  assert.match(graph, /--project <projectId> --port docker/, 'the helper must be invoked with --project and --port docker');
  assert.match(graph, /--input \.apex\/work\/new-surface-<surface-name>\.json new-surface-<surface-name>/,
    'the helper must take the work-area structural input and a scenario id positional');
  // The structural input carries the surface and its approved test command.
  assert.match(graph, /"project": \{ "id": "<projectId>" \}/, 'the input must declare the project id');
  assert.match(graph, /"name": "<surface-name>", "path": "<surface-path>"/, 'the input must carry the surface name and path');
  assert.match(graph, /"testCommand": "<test-command>"/, 'the input must carry the approved test command');
  // The mapping the helper performs: Surface + verification Rule + Check with ext_v1_command.
  assert.match(graph, /`PART_OF` → the\s+Project root/, 'the Surface must be attached to the Project root');
  assert.match(graph, /verification Rule/, 'the test command must derive the verification Rule');
  assert.match(graph, /`APPLIES_TO` → the Surface/, 'the Rule must apply to the Surface');
  assert.match(graph, /`ext_v1_command`/, 'the Check must persist the command as ext_v1_command');
  assert.match(graph, /`VERIFIED_BY`/, 'the Rule must be VERIFIED_BY the Check');
  assert.match(graph, /works on an initialized graph/, 'the helper must be usable post-init (existing ADDs skipped)');
  // Preview/apply flow through the ordinary promotion commands, human-gated.
  assert.match(graph, /steepy-formula promotion preview new-surface-<surface-name>/);
  assert.match(graph, /steepy-formula promotion apply new-surface-<surface-name>/);
  assert.match(graph, /WITHOUT `--yes`/, 'apply must stay interactively human-gated');
  assert.match(graph, /exit 21/, 'the CLI refusal exit code must be named');
  // Closing verification: graph gate + resolver spot-check serving the command back.
  assert.match(graph, /steepy-formula graph validate\n\s*steepy-formula context resolve --target apex:<projectId>:surface:<slug\(name\)>/,
    'the verify step must run graph validate then a target-based context resolve spot-check');
  assert.doesNotMatch(graph, /context resolve --path <surface-path>\n/,
    'the fenced verify spot-check must not prescribe --path (UNRESOLVED on a curated-only graph)');
  assert.match(graph, /Check carrying the approved test command as\s+`ext_v1_command`/,
    'the resolved context must serve the command back from the Check');
});
