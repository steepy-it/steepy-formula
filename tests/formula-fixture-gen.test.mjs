// E1 — deterministic scale fixture generator (spec §16). The acceptance fixture for the bake-off
// (E2/E4) and D3's budget calibration: 500 Packages, 25,000 curated nodes, 150,000 relationships,
// B4-valid, reproducible. Full-scale generation + load are asserted here; smoke scale exercises the
// same loader path fast so `npm test` stays quick.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { checkGraphState, validateGraph } from '../scripts/formula/core/validate-graph.mjs';
import {
  FIXTURE_TARGET_CURATED_NODES,
  FIXTURE_TARGET_EDGES,
  FIXTURE_TARGET_PACKAGES,
  generateFixture,
  loadFixture,
} from '../scripts/formula/core/fixture-gen.mjs';

function seedFixture(seed = 'e1-seed') {
  return generateFixture(seed);
}

test('default fixture hits the envelope counts exactly', () => {
  const fixture = seedFixture();
  assert.equal(fixture.stats.packages, FIXTURE_TARGET_PACKAGES);
  assert.equal(fixture.stats.curatedNodes, FIXTURE_TARGET_CURATED_NODES);
  assert.equal(fixture.stats.totalEdges, FIXTURE_TARGET_EDGES);
  assert.equal(fixture.nodes.length, FIXTURE_TARGET_CURATED_NODES + 521); // + Repository/Workspace/Package
});

test('default fixture node-type breakdown is exact', () => {
  const { nodesByType } = seedFixture().stats;
  assert.equal(nodesByType['curated:Project'], 1);
  assert.equal(nodesByType['curated:Surface'], 20);
  assert.equal(nodesByType['curated:Component'], 200);
  assert.equal(nodesByType['curated:Rule'], 18000);
  assert.equal(nodesByType['curated:Check'], 3100);
  assert.equal(nodesByType['curated:Decision'], 1600);
  assert.equal(nodesByType['curated:Term'], 1500);
  assert.equal(nodesByType['curated:Agent'], 380);
  assert.equal(nodesByType['curated:Skill'], 199);
  assert.equal(nodesByType['topology:Repository'], 1);
  assert.equal(nodesByType['topology:Workspace'], 20);
  assert.equal(nodesByType['topology:Package'], FIXTURE_TARGET_PACKAGES);
});

test('default fixture edge-type breakdown is exact', () => {
  const { edgesByType } = seedFixture().stats;
  assert.equal(edgesByType['curated:PART_OF'], 220); // 20 Surface→Project + 200 Component→Surface
  assert.equal(edgesByType['topology:PART_OF'], 520); // 500 Package→Workspace + 20 Workspace→Repository
  assert.equal(edgesByType['topology:IMPLEMENTS'], 500);
  assert.equal(edgesByType['curated:APPLIES_TO'], 126199); // 18,000 Rules × 7 + 199 Skill scopes
  assert.equal(edgesByType['curated:VERIFIED_BY'], 18050);
  assert.equal(edgesByType['curated:MOTIVATED_BY'], 2631);
  assert.equal(edgesByType['curated:USED_BY'], 1500);
  assert.equal(edgesByType['curated:OWNED_BY'], 380);
});

test('generated fixture is B4-clean: no violations and no warnings', () => {
  const fixture = seedFixture();
  const { violations, warnings } = checkGraphState(fixture.nodes, fixture.edges, fixture.projectId);
  assert.deepEqual(violations, []);
  assert.deepEqual(warnings, []);
});

test('every curated node is reachable from the Project root', () => {
  const fixture = seedFixture();
  const { violations } = checkGraphState(fixture.nodes, fixture.edges, fixture.projectId);
  const reachability = violations.filter((v) => v.code === 'UNREACHABLE_FROM_PROJECT_ROOT');
  assert.deepEqual(reachability, []);
});

test('full-scale fixture loads through the in-memory port and validates green', async () => {
  const fixture = seedFixture();
  const port = createMemoryPort();
  await loadFixture(port, { projectId: fixture.projectId, fixture });
  const result = await validateGraph(port, { projectId: fixture.projectId });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('same seed produces the identical fixture and digest', () => {
  const first = seedFixture('fixed');
  const second = seedFixture('fixed');
  assert.equal(first.digest, second.digest);
  assert.equal(first.digest.length, 64); // sha256 hex
  assert.deepEqual(first.stats, second.stats);
});

test('different seeds produce different digests', () => {
  const first = seedFixture('seed-a');
  const second = seedFixture('seed-b');
  assert.notEqual(first.digest, second.digest);
});

test('smoke-scale fixture loads and validates green through the same loader', async () => {
  const fixture = generateFixture('smoke', { scale: 0.02 });
  const port = createMemoryPort();
  await loadFixture(port, { projectId: fixture.projectId, fixture });
  const result = await validateGraph(port, { projectId: fixture.projectId });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('packagePaths expose a deterministic selector list for resolution benchmarks', () => {
  const fixture = seedFixture();
  assert.equal(fixture.packagePaths.length, FIXTURE_TARGET_PACKAGES);
  assert.equal(fixture.packagePaths[0], 'packages/pkg-000');
  assert.equal(fixture.packagePaths[499], 'packages/pkg-499');
});

test('generateFixture rejects malformed seeds and options', () => {
  assert.throws(() => generateFixture(''), TypeError);
  assert.throws(() => generateFixture(42), TypeError);
  assert.throws(() => generateFixture('x', { scale: 0 }), TypeError);
  assert.throws(() => generateFixture('x', { scale: 1.5 }), TypeError);
  assert.throws(() => generateFixture('x', { scale: NaN }), TypeError);
  assert.throws(() => generateFixture('x', { bogus: true }), TypeError);
});

test('loadFixture rejects a bad port, projectId, and fixture shape', async () => {
  const fixture = seedFixture();
  await assert.rejects(async () => loadFixture(null, { projectId: 'fixture', fixture }), TypeError);
  await assert.rejects(
    async () => loadFixture(createMemoryPort(), { projectId: 'Bad Project', fixture }),
    TypeError,
  );
  await assert.rejects(
    async () => loadFixture(createMemoryPort(), { projectId: 'fixture', fixture: { nodes: [] } }),
    TypeError,
  );
});
