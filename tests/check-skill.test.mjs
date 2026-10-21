// Pins the mode-aware check skill (skills/check/SKILL.md): the hub-mode declaration
// runs first and picks the coherence gate — `steepy-formula graph validate` in graph
// mode, the validate-hub linter (exactly as before) in legacy mode, and a route to
// init in mode `none`. The regression this suite guards: on a graph-first repo,
// `.apex/` holds only `work/`, which validate-hub's archived-state carve-out treats
// as coherent — so a check that only runs validate-hub prints a false green while
// validating nothing. The graph branch must therefore run the graph gate and must
// never fall back to the legacy linter. The model-mapping freshness verifier joins
// the check report in BOTH mode branches, before that branch's coherence gate.
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

test('check: frontmatter stays discoverable and its description is mode-aware, not markdown-hub-only', () => {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, 'check must keep YAML frontmatter');
  assert.match(fm[1], /name:\s*check\b/, 'frontmatter name must stay check');
  assert.match(fm[1], /user-invocable:\s*true/, 'check must stay user-invocable');
  assert.match(fm[1], /hub-mode/, 'the description must name the hub-mode declaration');
  assert.match(fm[1], /graph validate/, 'the description must name the graph-mode gate');
  assert.match(fm[1], /validate-hub/, 'the description must still name the legacy gate');
  assert.doesNotMatch(
    fm[1],
    /description:.*hub coherence linter \(validate-hub\)/,
    'the old markdown-hub-only description scope must be gone'
  );
});

test('check: the hub-mode declaration runs first and is quoted as the single authority', () => {
  const declaration = sectionBetween(text, '1. **Declare the hub mode first.**', '2. **Graph mode**');
  assert.match(declaration, /`steepy-formula hub-mode`/, 'the declaration must run steepy-formula hub-mode');
  assert.match(declaration, /`mode:` line/, 'the declaration must quote the mode: line');
  assert.match(declaration, /single authority/, 'the prose must defer detection to the command');
  assert.match(declaration, /never re-implements its detection/, 'the prose must never re-implement detection');
  // The decision table carries one row per declared mode.
  assert.match(declaration, /\| `graph` \| `steepy-formula graph validate` \(step 2\) \|/);
  assert.match(declaration, /\| `legacy` \| `node <engine-root>\/scripts\/validate-hub\.mjs \.` \(step 3\) \|/);
  assert.match(declaration, /\| `none` \|.*`init` skill/, 'mode none must route to the init skill');
  assert.match(declaration, /instead of reporting a coherent hub/, 'mode none must never report coherence');
  // The declaration precedes both gate branches in the procedure body.
  const body = text.replace(/^---\n[\s\S]*?\n---/, '');
  assert.ok(
    body.indexOf('**Declare the hub mode first.**') < body.indexOf('steepy-formula graph validate'),
    'the declaration must precede the graph gate'
  );
  assert.ok(
    body.indexOf('**Declare the hub mode first.**') < body.indexOf('validate-hub.mjs'),
    'the declaration must precede the legacy gate'
  );
});

test('check graph branch: runs `steepy-formula graph validate`, reports violations, and never falls back to validate-hub', () => {
  const graph = sectionBetween(text, '2. **Graph mode**', '3. **Legacy mode**');
  assert.match(graph, /```bash\n\s*steepy-formula graph validate\n\s*```/, 'the graph gate must be the fenced graph validate command');
  assert.match(graph, /revision-chain replay/, 'a green graph gate means invariants + replay clean');
  assert.match(graph, /\[CODE\] message/, 'violations must be reported from the printed [CODE] message lines');
  assert.match(graph, /Never fall back to `validate-hub\.mjs` in graph mode/, 'the false-green fallback must be forbidden explicitly');
  assert.match(graph, /false green/, 'the rationale must name the false green');
  assert.doesNotMatch(
    graph,
    /```[^`]*validate-hub/,
    'the graph branch must never instruct running the legacy linter'
  );
  const flatGraph = graph.replace(/\s+/g, ' ');
  assert.ok(flatGraph.includes('`steepy-formula context resolve --target apex:<projectId>:surface:<slug(name)>`'),
    'the optional resolver spot-check must be target-based on the deterministic surface id');
  assert.match(flatGraph, /topology bridge exists/,
    'the --path spot-check must be scoped to where the topology bridge exists');
  assert.match(flatGraph, /exits 10 UNRESOLVED — expected, not a violation/,
    'a path resolve on a freshly graph-first-initialized repo exits 10 UNRESOLVED — expected, never a violation');
  assert.match(graph, /context resolve --path/, 'the bridge-scoped --path spot-check must still be named');
});

test('check legacy branch: the validate-hub gate is unchanged', () => {
  const legacy = sectionBetween(text, '3. **Legacy mode**', '4. **Report**');
  assert.match(legacy, /exactly as today/, 'the legacy branch must claim byte-compatible behavior');
  assert.match(legacy, /node <engine-root>\/scripts\/validate-hub\.mjs \./, 'the legacy gate must keep the explicit `.` cwd argument');
  assert.match(legacy, /`steepy validate-hub: OK`/, 'the legacy OK line must still be quoted');
  assert.match(legacy, /orphan docs not linked from `_INDEX\.md`/, 'the legacy violation guidance must survive');
  assert.doesNotMatch(legacy, /graph validate/, 'the legacy branch must not mix in the graph gate');
});

test('check report: names the declared mode and which gate ran', () => {
  assert.match(text, /4\. \*\*Report\*\* — name the declared hub mode, which gate ran, and whether it is green\./);
});

test('check: both mode branches run the model-mapping freshness verifier before their gate, STALE as a finding', () => {
  // The verifier port is mode-aware in formula: the freshness report joins the check
  // report in BOTH the graph and the legacy branch, running before that branch's
  // coherence gate, with STALE surfaced as a finding for human ratification.
  const branches = [
    ['graph', sectionBetween(text, '2. **Graph mode**', '3. **Legacy mode**'), 'steepy-formula graph validate'],
    ['legacy', sectionBetween(text, '3. **Legacy mode**', '4. **Report**'), 'validate-hub.mjs'],
  ];
  for (const [name, branch, gate] of branches) {
    assert.match(
      branch,
      /node <engine-root>\/scripts\/verify-model-mappings\.mjs/,
      `the ${name} branch must run the freshness verifier via the engine-root path`
    );
    const vIdx = branch.indexOf('verify-model-mappings.mjs');
    const gateIdx = branch.indexOf(gate);
    assert.ok(vIdx !== -1 && gateIdx !== -1 && vIdx < gateIdx,
      `the ${name} branch must run the verifier before its coherence gate`);
    assert.ok(branch.includes('`OK | STALE | UNKNOWN`'),
      `the ${name} branch must carry the per-row verdict vocabulary`);
    assert.match(branch, /`STALE`[^\n]*human-ratified table patch/,
      `the ${name} branch must tie STALE to a human-ratified table patch`);
    assert.match(branch, /as a finding/,
      `the ${name} branch must report STALE as a finding`);
    assert.match(branch, /script prints the prepared patch/,
      `the ${name} branch must point at the script-printed prepared patch`);
    assert.match(branch, /`UNKNOWN` is informational \(source unreachable/,
      `the ${name} branch must mark UNKNOWN informational (offline degradation)`);
    assert.match(branch, /never as a failure/,
      `the ${name} branch must never block on UNKNOWN`);
  }
});
