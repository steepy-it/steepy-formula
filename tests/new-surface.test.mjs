import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// skills/new-surface/SKILL.md — graph-only prose pins. The skill documents one
// procedure: render the graph-mode agent and promote the Surface (verification
// Rule + Check with ext_v1_command) through the structural-promotion helper.
// It creates no standards doc and no Markdown hub file.
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

test('new-surface skill: description is graph-only and the hub-mode declaration routes the run', () => {
  const fm = skillText.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, 'SKILL.md must keep YAML frontmatter');
  assert.match(fm[1], /name:\s*new-surface\b/);
  assert.match(fm[1], /user-invocable:\s*true/);
  assert.match(fm[1], /Add a surface: render the graph sub-agent and promote Surface \+ verification Rule \+ Check into the graph\./);
  assert.doesNotMatch(skillText, /\blegacy\b/i, 'the skill must never use the word legacy');
  assert.doesNotMatch(skillText, /_INDEX\.md/, 'the skill must never name the Markdown hub index');

  const declaration = sectionBetween(skillText, '2. **Declare the hub mode.**', '3. **Render the specialist agent**');
  assert.match(declaration, /`steepy-formula hub-mode`/, 'the declaration must run steepy-formula hub-mode');
  assert.match(declaration, /`mode:` line/, 'the declaration must quote the mode: line');
  assert.match(declaration, /`graph`, `migrate`, or `none`/, 'the mode list is exactly graph, migrate, or none');
  assert.match(declaration, /single authority/, 'detection must stay with the command');
  assert.match(declaration, /\| `graph` \| Continue with Steps 3–6/, 'the graph row must continue to the promotion steps');
  assert.match(declaration, /never create a standards doc/, 'the graph row must forbid a standards doc');
  assert.doesNotMatch(declaration, /permanently red/);
  assert.match(declaration, /\| `migrate` \|[^\n]*Stop and tell the user to run the `graph-migrate` skill \(invoke it the way your harness invokes skills\) before any other workflow\./,
    'the migrate row carries the exact stop sentence');
  assert.match(declaration, /\| `none` \|.*`init` skill/, 'mode none must route to init and stop');
  assert.ok(skillText.indexOf('**Declare the hub mode.**') < skillText.indexOf('3. **Render the specialist agent**'));
  assert.doesNotMatch(skillText, /### (Legacy|Graph) mode/, 'no per-mode sections remain');
});

test('new-surface skill step 1 gathers the specialist agent alongside name, path, and test command', () => {
  const gather = sectionBetween(skillText, '## Procedure', '2. **Declare the hub mode.**');
  assert.match(gather, /four pieces of information/i, 'the gathered input set is four pieces now');
  assert.match(gather, /Specialist agent/i, 'the specialist agent must be gathered');
  assert.match(gather, /defaulting to `<name>-agent` only when the user accepts it/,
    'the <name>-agent default is accepted, never assumed');
});

test('new-surface skill: creates no markdown-hub file — agent rendered from surface-agent-graph.md, no standards doc, no _INDEX.md', () => {
  const graph = sectionBetween(skillText, '3. **Render the specialist agent**', null);
  assert.match(graph, /`\.claude\/agents\/<surface-name>-agent\.md`/, 'the graph branch must create the deterministic agent file');
  assert.match(graph, /<engine-root>\/templates\/surface-agent-graph\.md/, 'the agent must be rendered from the graph-mode template');
  assert.match(graph, /`\{\{name\}\}` and `\{\{path\}\}`/, 'the render must substitute the template placeholders');
  assert.match(graph, /agent file\s+`\.claude\/agents\/<name>-agent\.md`/, 'binding must be deterministic by surface name');
  assert.doesNotMatch(graph, /\.apex\/standards\//, 'the graph branch must never name a standards path');
  assert.doesNotMatch(graph, /_INDEX\.md/, 'the graph branch must never name _INDEX.md');
  assert.doesNotMatch(graph, /validate-hub|new-surface\.mjs|routing table/, 'no deleted machinery is named');
});

test('new-surface skill: drives the structural-promotion helper with its real flags and input shape, then preview/apply', () => {
  const graph = sectionBetween(skillText, '3. **Render the specialist agent**', null);
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
