// Structural-promotion helper suite (init-graph-first). The graph-first init skill lands the
// interviewed skeleton (Project/Surface/Component/Rule/Check/Term) through ONE promotion scenario,
// and `promotion create`'s typed-candidates vocabulary (term/rule/decision/readme) cannot express
// that skeleton — scripts/structural-promotion.mjs is the seam that can. Every case drives the
// EXPORTED programmatic API in-process on the B3 memory port, exactly as the shared contract asks;
// preview/apply flow through the same core seams the shipped `steepy-formula promotion` commands
// drive (`inspectScenario`/`applyPromotion`), so what passes here is what the CLI would do.
// Port/apply mechanics are modeled on tests/formula-promotion.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { withTransaction } from '../scripts/formula/engine/port.mjs';
import { systemRecordId, validateGraph } from '../scripts/formula/core/validate-graph.mjs';
import { applyPromotion, inspectScenario, PROMOTION_ERROR_CODES } from '../scripts/formula/core/promotion.mjs';
import { resolveContext } from '../scripts/formula/core/resolve-context.mjs';
import {
  createStructuralScenario,
  structuralToOperations,
  STRUCTURAL_ERROR_CODES,
  STRUCTURAL_VIOLATION_CODES,
  main,
} from '../scripts/structural-promotion.mjs';

const PROJECT = 'demo';
const SCENARIO = 'init-1';

const PROPOSED_BY = { type: 'agent-proposer', name: 'init-skill' };
const APPROVER = { type: 'human-approver', id: 'steepy-it' };
const PROVENANCE = [{ quotation: 'Approved in the init interview.', source: 'docs/init-interview.md:1', digest: 'a'.repeat(64) }];

// The interviewed per-surface test command, verbatim — contract 5 pins it onto the Check as the
// `ext_v1_command` extension property, where graph-aware skills read it back from resolved context.
const TEST_CMD = 'npm test -- --suite scripts';

function qid(localId) {
  return `apex:${PROJECT}:${localId}`;
}

const ID = {
  root: qid('project:root'),
  scripts: qid('surface:scripts'),
  adapters: qid('surface:adapters'),
  engine: qid('component:engine'),
  verification: qid('rule:scripts-verification'),
  check: qid('check:scripts-test'),
  gitRule: qid('rule:no-git-without-confirmation'),
  term: qid('term:surface'),
};

// A realistic init-interview document: two confirmed surfaces (one with an approved verification
// Rule and therefore a Check, one without), the git-policy Rule scoped to both, and one Term.
function structuralInput() {
  return {
    project: { id: PROJECT },
    surfaces: [
      { name: 'scripts', path: 'scripts', components: ['engine'], testCommand: TEST_CMD },
      { name: 'adapters', path: 'adapters' },
    ],
    rules: [
      {
        title: 'No git without confirmation',
        statement: 'Never run a git command without explicit user confirmation.',
        concern: 'git-policy',
        strength: 'must',
        appliesTo: ['scripts', 'adapters'],
      },
    ],
    terms: [{ term: 'surface', definition: 'A governed technical area of the codebase.' }],
  };
}

async function withPort(fn) {
  const port = createMemoryPort();
  try {
    return await fn(port);
  } finally {
    await port.close();
  }
}

async function systemRecord(port) {
  return withTransaction(port, (tx) => tx.getNode({ namespace: 'system', id: systemRecordId(PROJECT) }));
}

async function curatedNode(port, id) {
  return withTransaction(port, (tx) => tx.getNode({ namespace: 'curated', id }));
}

// --- the pure mapping ------------------------------------------------------------------------------

test('structuralToOperations maps the document onto the pinned node types, edge labels, and id conventions', () => {
  const { operations, violations } = structuralToOperations(PROJECT, structuralInput());
  assert.deepEqual(violations, []);

  // plain curated ADDs only — the init transaction never modifies or supersedes anything
  for (const operation of operations) {
    assert.equal(operation.op, 'ADD');
    assert.equal(operation.namespace, 'curated');
  }

  const nodes = new Map(operations.filter((op) => op.target === 'node').map((op) => [op.id, op]));
  const edges = operations.filter((op) => op.target === 'edge').map((op) => `${op.type} ${op.fromId} -> ${op.toId}`);

  assert.equal(nodes.get(ID.root).type, 'Project');
  assert.equal(nodes.get(ID.scripts).type, 'Surface');
  assert.equal(nodes.get(ID.scripts).properties.ext_v1_path, 'scripts');
  assert.equal(nodes.get(ID.adapters).type, 'Surface');
  assert.equal(nodes.get(ID.engine).type, 'Component');
  assert.equal(nodes.get(ID.gitRule).type, 'Rule');
  assert.equal(nodes.get(ID.term).type, 'Term');

  // the surface's approved verification: Rule (statement carries the command as prose — the
  // fallback graph-aware skills read) + Check with the command PERSISTED as ext_v1_command
  const rule = nodes.get(ID.verification);
  assert.equal(rule.type, 'Rule');
  assert.equal(rule.properties.statement, `changes on scripts pass \`${TEST_CMD}\``);
  const check = nodes.get(ID.check);
  assert.equal(check.type, 'Check');
  assert.equal(check.properties.ext_v1_command, TEST_CMD);

  assert.ok(edges.includes(`PART_OF ${ID.scripts} -> ${ID.root}`));
  assert.ok(edges.includes(`PART_OF ${ID.adapters} -> ${ID.root}`));
  assert.ok(edges.includes(`PART_OF ${ID.engine} -> ${ID.scripts}`));
  assert.ok(edges.includes(`APPLIES_TO ${ID.verification} -> ${ID.scripts}`));
  assert.ok(edges.includes(`VERIFIED_BY ${ID.verification} -> ${ID.check}`));
  assert.ok(edges.includes(`APPLIES_TO ${ID.gitRule} -> ${ID.scripts}`));
  assert.ok(edges.includes(`APPLIES_TO ${ID.gitRule} -> ${ID.adapters}`));
  assert.ok(edges.includes(`USED_BY ${ID.term} -> ${ID.root}`));

  // no approved testCommand -> no invented verification Rule and no Check (the reachability
  // judgment and the never-invent-Rules gate, mechanically enforced)
  assert.ok(!nodes.has(qid('rule:adapters-verification')));
  assert.ok(!nodes.has(qid('check:adapters-test')));
});

// --- end-to-end on the memory port: draft -> preview -> apply -> resolve --------------------------

test('e2e: the draft scenario previews clean, and the first apply initializes the graph with the Check command resolvable', async () => {
  await withPort(async (port) => {
    // virgin by construction: the system record does not exist before the first promotion apply —
    // the very fact the init skill's Step 1 gate reads as `initialized: no`.
    assert.equal(await systemRecord(port), null, 'a freshly provisioned graph has no system record (initialized: no)');

    const created = await createStructuralScenario(port, {
      projectId: PROJECT,
      scenarioId: SCENARIO,
      structural: structuralInput(),
      proposedBy: PROPOSED_BY,
    });
    assert.equal(created.ok, true);
    assert.equal(created.scenarioId, SCENARIO);
    assert.deepEqual(created.skipped, []);
    assert.equal(created.preview.structural.valid, true);
    assert.deepEqual(created.preview.structural.violations, []);

    // the helper created a DRAFT: nothing applied, the stable graph still empty and uninitialized
    assert.equal(await systemRecord(port), null, 'creating the scenario writes nothing to the stable graph');
    assert.equal(await curatedNode(port, ID.root), null);

    // preview through the same core seam `steepy-formula promotion preview` drives
    const preview = await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO });
    assert.equal(preview.ok, true);
    assert.equal(preview.stale, false);
    assert.match(preview.diff, new RegExp(`ADD node curated Check ${ID.check}`));

    // apply through the same core seam `steepy-formula promotion apply` drives
    const applied = await applyPromotion(port, { projectId: PROJECT, scenarioId: SCENARIO, approver: APPROVER, provenance: PROVENANCE });
    assert.equal(applied.ok, true);

    // the first apply establishes the system record: `graph status` now reports initialized: yes
    const system = await systemRecord(port);
    assert.ok(system !== null, 'the first promotion apply establishes the system record (initialized: yes)');
    assert.match(system.properties.headRevision, new RegExp(`^apex:${PROJECT}:revision:r\\d+$`));
    assert.equal(typeof system.properties.schemaVersion, 'number');

    // the Check carries the approved test command verbatim as ext_v1_command
    const check = await curatedNode(port, ID.check);
    assert.equal(check.type, 'Check');
    assert.equal(check.properties.ext_v1_command, TEST_CMD);

    // the promoted graph is B4-clean — the same gate `steepy-formula graph validate` runs
    const verdict = await validateGraph(port, { projectId: PROJECT });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.violations, []);

    // and resolved context serves the command back: the property graph-aware skills read
    const resolved = await resolveContext(port, { projectId: PROJECT, targets: ['surface:scripts'] });
    assert.equal(resolved.ok, true);
    assert.deepEqual(
      resolved.context.checks.map((item) => [item.id, item.properties.ext_v1_command]),
      [[ID.check, TEST_CMD]],
    );
    const servedRule = resolved.context.rules.find((item) => item.id === ID.verification);
    assert.ok(servedRule, 'the verification Rule resolves with its Check');
    assert.ok(servedRule.properties.statement.includes(TEST_CMD), 'the Rule statement prose is the fallback carrier');
    assert.ok(resolved.context.rules.some((item) => item.id === ID.gitRule), 'the git-policy Rule applies to the surface');
    assert.deepEqual(
      resolved.diagnostics.checkVerifiers,
      [{ id: ID.check, ruleIds: [ID.verification] }],
    );
  });
});

// --- the already-initialized seam ------------------------------------------------------------------

test('on an initialized graph, existing ADDs are skipped and a fully-covered input refuses NOTHING_TO_ADD', async () => {
  await withPort(async (port) => {
    await createStructuralScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, structural: structuralInput(), proposedBy: PROPOSED_BY });
    await applyPromotion(port, { projectId: PROJECT, scenarioId: SCENARIO, approver: APPROVER, provenance: PROVENANCE });

    // incremental: the same document plus one new surface — only the genuinely new ADDs ride
    const incremental = structuralInput();
    incremental.surfaces.push({ name: 'skills', path: 'skills' });
    const second = await createStructuralScenario(port, { projectId: PROJECT, scenarioId: 'init-2', structural: incremental, proposedBy: PROPOSED_BY });
    assert.equal(second.ok, true);
    assert.deepEqual(
      second.operations.filter((op) => op.target === 'node').map((op) => op.id),
      [qid('surface:skills')],
    );
    assert.ok(second.skipped.length > 0, 'the already-promoted skeleton is skipped, not re-added');
    const appliedTwo = await applyPromotion(port, { projectId: PROJECT, scenarioId: 'init-2', approver: APPROVER, provenance: PROVENANCE });
    assert.equal(appliedTwo.ok, true);

    // an input the stable graph fully covers is a structured refusal, never an empty scenario
    const third = await createStructuralScenario(port, { projectId: PROJECT, scenarioId: 'init-3', structural: incremental, proposedBy: PROPOSED_BY });
    assert.equal(third.ok, false);
    assert.equal(third.code, STRUCTURAL_ERROR_CODES.NOTHING_TO_ADD);
    assert.equal((await inspectScenario(port, { projectId: PROJECT, scenarioId: 'init-3' })).code, PROMOTION_ERROR_CODES.SCENARIO_NOT_FOUND);
  });
});

test('a taken scenario id is refused through the core SCENARIO_EXISTS, nothing overwritten', async () => {
  await withPort(async (port) => {
    const first = await createStructuralScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, structural: structuralInput(), proposedBy: PROPOSED_BY });
    assert.equal(first.ok, true);
    const again = await createStructuralScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, structural: structuralInput(), proposedBy: PROPOSED_BY });
    assert.equal(again.ok, false);
    assert.equal(again.code, PROMOTION_ERROR_CODES.SCENARIO_EXISTS);
  });
});

// --- structured violations: closed-input discipline ------------------------------------------------

test('a malformed structural input is one structured refusal carrying every violation, and creates nothing', async () => {
  await withPort(async (port) => {
    const bad = {
      project: { id: 'other' }, // PROJECT_MISMATCH
      surfaces: [{ name: 'scripts' }], // MISSING_STRUCTURAL_FIELD (path)
      rules: [{ title: 'x', statement: 'y', concern: 'z', strength: 'must', appliesTo: ['nope'] }], // UNKNOWN_APPLIES_TO_TARGET
      bogus: true, // UNKNOWN_STRUCTURAL_KEY
    };
    const result = await createStructuralScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, structural: bad, proposedBy: PROPOSED_BY });
    assert.equal(result.ok, false);
    assert.equal(result.code, STRUCTURAL_ERROR_CODES.INVALID_STRUCTURAL_INPUT);
    const codes = result.identity.violations.map((violation) => violation.code);
    for (const code of [
      STRUCTURAL_VIOLATION_CODES.PROJECT_MISMATCH,
      STRUCTURAL_VIOLATION_CODES.MISSING_STRUCTURAL_FIELD,
      STRUCTURAL_VIOLATION_CODES.UNKNOWN_APPLIES_TO_TARGET,
      STRUCTURAL_VIOLATION_CODES.UNKNOWN_STRUCTURAL_KEY,
    ]) {
      assert.ok(codes.includes(code), `one fault never suppresses the others: expected ${code} in ${codes.join(', ')}`);
    }
    assert.equal((await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO })).code, PROMOTION_ERROR_CODES.SCENARIO_NOT_FOUND);
  });
});

test('duplicate appliesTo scope targets are rejected up front, mirroring the duplicate-node-id path', async () => {
  // a literal repeat: the same declared surface name twice
  const literal = structuralInput();
  literal.rules[0].appliesTo = ['scripts', 'scripts'];
  const mapped = structuralToOperations(PROJECT, literal);
  const dup = mapped.violations.filter((found) => found.code === STRUCTURAL_VIOLATION_CODES.DUPLICATE_STRUCTURAL_ID);
  assert.equal(dup.length, 1, JSON.stringify(mapped.violations, null, 2));
  assert.match(dup[0].message, /both map onto/, 'the wording mirrors the duplicate-node-id violation');
  assert.equal(dup[0].identity.id, ID.scripts);
  assert.equal(dup[0].identity.targetIndex, 1, 'the later duplicate entry is the one named');

  // a resolved repeat: a declared surface name and its qualified id map onto the same target
  const mixed = structuralInput();
  mixed.rules[0].appliesTo = ['scripts', ID.scripts];
  const mixedDup = structuralToOperations(PROJECT, mixed).violations.filter(
    (found) => found.code === STRUCTURAL_VIOLATION_CODES.DUPLICATE_STRUCTURAL_ID,
  );
  assert.equal(mixedDup.length, 1);
  assert.equal(mixedDup[0].identity.id, ID.scripts);

  // the duplicate is a structured INVALID_STRUCTURAL_INPUT refusal at this seam — never left for
  // the core to refuse only at preview/apply (SCENARIO_INVALID) — and nothing is created
  await withPort(async (port) => {
    const result = await createStructuralScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, structural: literal, proposedBy: PROPOSED_BY });
    assert.equal(result.ok, false);
    assert.equal(result.code, STRUCTURAL_ERROR_CODES.INVALID_STRUCTURAL_INPUT);
    assert.ok(result.identity.violations.some((found) => found.code === STRUCTURAL_VIOLATION_CODES.DUPLICATE_STRUCTURAL_ID));
    assert.equal((await inspectScenario(port, { projectId: PROJECT, scenarioId: SCENARIO })).code, PROMOTION_ERROR_CODES.SCENARIO_NOT_FOUND);
  });
});

test('programmer error throws, data problems never do — the core-module split', async () => {
  await withPort(async (port) => {
    await assert.rejects(() => createStructuralScenario(undefined, { projectId: PROJECT, scenarioId: SCENARIO, structural: {}, proposedBy: PROPOSED_BY }), TypeError);
    await assert.rejects(() => createStructuralScenario(port, { projectId: 'Not A Project', scenarioId: SCENARIO, structural: {}, proposedBy: PROPOSED_BY }), TypeError);
    await assert.rejects(() => createStructuralScenario(port, { projectId: PROJECT, scenarioId: '', structural: {}, proposedBy: PROPOSED_BY }), TypeError);
    await assert.rejects(() => createStructuralScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, structural: 'nope', proposedBy: PROPOSED_BY }), TypeError);
    await assert.rejects(() => createStructuralScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, structural: {}, proposedBy: { type: 'not-an-actor', name: 'x' } }), TypeError);
    // a typo must never silently drop an argument
    await assert.rejects(() => createStructuralScenario(port, { projectId: PROJECT, scenarioId: SCENARIO, structurl: {}, proposedBy: PROPOSED_BY }), TypeError);
    assert.throws(() => structuralToOperations('Not A Project', {}), TypeError);
    assert.throws(() => structuralToOperations(PROJECT, 'nope'), TypeError);
  });
});

// --- the thin argv wrapper -------------------------------------------------------------------------

test('the argv wrapper: usage errors exit 2, a memory-port dry-run exits 0', async () => {
  assert.equal(await main([]), 2, 'missing --project is a usage error');
  assert.equal(await main(['--project', PROJECT, '--port', 'teleport', '--input', 'x.json', 's1']), 2, 'unknown --port is a usage error');
  assert.equal(await main(['--project', PROJECT, '--port', 'memory', 's1']), 2, 'missing --input is a usage error');
  assert.equal(await main(['--project', PROJECT, '--port', 'memory', '--input', 'x.json']), 2, 'missing <scenarioId> is a usage error');

  const dir = mkdtempSync(join(tmpdir(), 'steepy-structural-'));
  assert.equal(await main(['--project', PROJECT, '--port', 'memory', '--input', join(dir, 'missing.json'), 's1']), 2, 'an unreadable --input file is a usage error');

  const invalid = join(dir, 'invalid.json');
  writeFileSync(invalid, JSON.stringify({ project: { id: 'other' } }));
  assert.equal(await main(['--project', PROJECT, '--port', 'memory', '--input', invalid, 's1']), 2, 'structural violations are a usage error');

  const file = join(dir, 'structural.json');
  writeFileSync(file, JSON.stringify(structuralInput()));
  assert.equal(await main(['--project', PROJECT, '--port', 'memory', '--input', file, 'dry-run-1']), 0, 'a memory-port run is a mapping/validation dry-run');
});
