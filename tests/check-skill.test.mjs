// Pins the check skill (skills/check/SKILL.md): the hub-mode declaration runs first
// and picks the coherence gate — `steepy-formula graph validate` in graph mode, a
// stop that routes to the `graph-migrate` skill in migrate mode, and a route to init
// in mode `none`. The model-mapping freshness verifier joins the check report before
// the graph gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillPath = join(here, '..', 'skills', 'check', 'SKILL.md');
const text = readFileSync(skillPath, 'utf8');

function sectionBetween(body, startMarker, endMarker) {
  const start = body.indexOf(startMarker);
  assert.ok(start >= 0, `section marker not found: ${startMarker}`);
  const end = body.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `section end marker not found after '${startMarker}': ${endMarker}`);
  return body.slice(start, end);
}

test('check: frontmatter stays discoverable and its description names the graph gate only', () => {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, 'check must keep YAML frontmatter');
  assert.match(fm[1], /name:\s*check\b/, 'frontmatter name must stay check');
  assert.match(fm[1], /user-invocable:\s*true/, 'check must stay user-invocable');
  assert.match(fm[1], /graph validate/, 'the description must name the graph gate');
  assert.doesNotMatch(fm[1], /validate-hub/, 'the description must not name the removed linter');
  assert.doesNotMatch(fm[1], /hub-mode/, 'the description is mode-free');
});

test('check: the hub-mode declaration runs first and is quoted as the single authority', () => {
  const declaration = sectionBetween(text, '1. **Declare the hub mode first.**', '2. **Validate the graph**');
  assert.match(declaration, /`steepy-formula hub-mode`/, 'the declaration must run steepy-formula hub-mode');
  assert.match(declaration, /`mode:` line/, 'the declaration must quote the mode: line');
  assert.ok(declaration.includes('`graph`, `migrate`, or `none`'), 'the mode list must be graph, migrate, or none');
  assert.match(declaration, /single authority/, 'the prose must defer detection to the command');
  assert.match(declaration, /never re-implements its detection/, 'the prose must never re-implement detection');
  assert.match(declaration, /\| `graph` \| `steepy-formula graph validate` \(step 2\) \|/);
  assert.match(declaration, /\| `migrate` \|.*Stop and tell the user to run the `graph-migrate` skill \(invoke it the way your harness invokes skills\) before any other workflow\./);
  assert.match(declaration, /\| `none` \|.*`init` skill/, 'mode none must route to the init skill');
  assert.match(declaration, /instead of reporting a coherent hub/, 'mode none must never report coherence');
  assert.doesNotMatch(text, /validate-hub/, 'the removed linter must not appear');
  assert.doesNotMatch(text, /legacy/i, 'the word legacy must not appear');
  assert.doesNotMatch(text, /_INDEX\.md/, 'the Markdown hub index must not be named');
});

test('check graph branch: runs `steepy-formula graph validate` and reports violations', () => {
  const graph = sectionBetween(text, '2. **Validate the graph**', '3. **Report**');
  assert.match(graph, /```bash\n\s*steepy-formula graph validate\n\s*```/, 'the graph gate must be the fenced graph validate command');
  assert.match(graph, /revision-chain replay/, 'a green graph gate means invariants + replay clean');
  assert.match(graph, /\[CODE\] message/, 'violations must be reported from the printed [CODE] message lines');
  const flatGraph = graph.replace(/\s+/g, ' ');
  assert.ok(flatGraph.includes('`steepy-formula context resolve --target apex:<projectId>:surface:<slug(name)>`'),
    'the optional resolver spot-check must be target-based on the deterministic surface id');
  assert.match(flatGraph, /topology bridge exists/,
    'the --path spot-check must be scoped to where the topology bridge exists');
  assert.match(flatGraph, /exits 10 UNRESOLVED — expected, not a violation/,
    'a path resolve on a freshly graph-first-initialized repo exits 10 UNRESOLVED — expected, never a violation');
  assert.match(graph, /context resolve --path/, 'the bridge-scoped --path spot-check must still be named');
});

test('check report: names the declared mode and that graph validate ran', () => {
  assert.match(text, /3\. \*\*Report\*\* — name the declared hub mode, confirm `steepy-formula graph validate` ran, and whether it is green\./);
});

test('check: the graph branch runs the model-mapping freshness verifier before its gate, STALE as a finding', () => {
  const branch = sectionBetween(text, '2. **Validate the graph**', '3. **Report**');
  assert.match(branch, /node <engine-root>\/scripts\/verify-model-mappings\.mjs/,
    'the branch must run the freshness verifier via the engine-root path');
  const vIdx = branch.indexOf('verify-model-mappings.mjs');
  const gateIdx = branch.indexOf('steepy-formula graph validate');
  assert.ok(vIdx !== -1 && gateIdx !== -1 && vIdx < gateIdx,
    'the branch must run the verifier before its coherence gate');
  assert.ok(branch.includes('`OK | STALE | UNKNOWN`'), 'the branch must carry the per-row verdict vocabulary');
  assert.match(branch, /`STALE`[^\n]*human-ratified table patch/, 'STALE must tie to a human-ratified table patch');
  assert.match(branch, /as a finding/, 'STALE must be reported as a finding');
  assert.match(branch, /script prints the prepared patch/, 'point at the script-printed prepared patch');
  assert.match(branch, /`UNKNOWN` is informational \(source unreachable/, 'UNKNOWN is informational');
  assert.match(branch, /never as a failure/, 'never block on UNKNOWN');
});
