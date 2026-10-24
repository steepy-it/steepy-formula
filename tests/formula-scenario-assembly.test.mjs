// Scenario-assembly suite (promotion-in-chain Task 3, plan decision 3 — the D5 typed-candidates
// mapping and the `promotion create` wrapper).
//
// Three layers, per the tests standard:
//  1. PURE UNIT (always runs): `candidatesToOperations` — the exact op vocabulary per kind (term
//     -> Term + USED_BY anchor to the project root, rule -> Rule + APPLIES_TO, decision ->
//     Decision, readme -> out-of-graph with ZERO operations, never a Check), order preservation,
//     and every malformed-candidate violation: the I1 digit-leading slug pin, the M1 appliesTo
//     absent/malformed pins, duplicate ids, unknown kinds/keys — with none suppressed.
//  2. END-TO-END (always runs): `assembleScenario` over the B3 memory port seeded with B5
//     `applyChangeSet` — create + typed-diff preview, advisor pass-through, a clean set yielding
//     structural.valid, INVALID_CANDIDATES creating nothing — plus the I1 repro on the dogfood
//     seed the review round named (the local-only checkpoint: that one case skips with the
//     explicit DOGFOOD_CHECKPOINT_SKIP reason when it is absent).
//  3. CLI: every refusal path (missing file / bad JSON / non-object JSON / unknown kind / I1 /
//     M1) exits 2 on the `--port memory` seam; the happy path runs there too (exit 0 + summary).
//     The cross-process "a SECOND subprocess previews the created scenario" is docker-gated:
//     the memory seam cannot carry the scenario namespace across processes (spec §11), so it
//     lives against the live pinned engine like tests/formula-cli-context.test.mjs's flow.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { withTransaction } from '../scripts/formula/engine/port.mjs';
import { applyChangeSet, sha256Hex } from '../scripts/formula/core/revision.mjs';
import { buildExportArtifact, importGraph } from '../scripts/formula/core/export.mjs';
import {
  CANDIDATE_KINDS,
  CANDIDATE_VIOLATION_CODES,
  SCENARIO_ASSEMBLY_ERROR_CODES,
  assembleScenario,
  candidatesToOperations,
} from '../scripts/formula/core/scenario-assembly.mjs';
import { ARCADEDB_IMAGE, containerNameFor, destroyContainer, dockerGate, startServer } from '../scripts/formula/engine/lifecycle.mjs';
import { createArcadeDbPort, createDatabase, databaseNameFor } from '../scripts/formula/engine/arcadedb.mjs';
import { DOGFOOD_CHECKPOINT, DOGFOOD_CHECKPOINT_SKIP } from './helpers/dogfood-checkpoint.mjs';

const cliPath = fileURLToPath(new URL('../scripts/formula/cli.mjs', import.meta.url));

const PROJECT = 'assembly';
const CLI_PROJECT = 'assembly-cli';
const SCENARIO = 'assembly-1';
const PROPOSED_BY = { type: 'agent-proposer', name: 'tests-agent' };

function qid(localId) {
  return `apex:${PROJECT}:${localId}`;
}

// The seed Rule's id deliberately does NOT slug from its title, so a duplicate candidate carrying
// the same title mints a DIFFERENT id and the collision is the advisor's to report, not the
// mapper's.
const ID = {
  surface: qid('surface:tests'),
  rule: qid('rule:hermetic-suites'),
};

const SEED_TITLE = 'Keep test suites hermetic';
const SEED_STATEMENT = 'A suite scaffolds into its own mkdtemp directory and never writes into the repository.';

function addNode(type, id, properties = {}) {
  return { op: 'ADD', target: 'node', namespace: 'curated', type, id, properties: { id, status: 'active', ...properties } };
}

function addEdge(type, fromId, toId) {
  return { op: 'ADD', target: 'edge', namespace: 'curated', type, fromId, toId };
}

function baseMeta(projectId = PROJECT) {
  return {
    projectId,
    proposer: { type: 'agent-proposer', id: 'tests-agent' },
    approver: { type: 'human-approver', id: 'steepy-it' },
    provenance: [{ quotation: 'Scenario-assembly suite fixture.', source: 'tests/formula-scenario-assembly.test.mjs:1', digest: sha256Hex('fixture') }],
  };
}

// A B4-clean stable graph in the promotion suite's minimal shape (head lands at r3), with the
// seed Rule's title/statement pinned so duplicate candidates can match them exactly.
async function seedBaseGraph(port, projectId = PROJECT) {
  const id = {
    project: `apex:${projectId}:project:root`,
    surface: `apex:${projectId}:surface:tests`,
    agent: `apex:${projectId}:agent:tests-agent`,
    check: `apex:${projectId}:check:tests-suite`,
    rule: `apex:${projectId}:rule:hermetic-suites`,
  };
  const rule = addNode('Rule', id.rule, {
    title: SEED_TITLE,
    statement: SEED_STATEMENT,
    strength: 'must',
    category: 'engineering',
    concern: 'test-isolation',
    provenance: { source: 'spec', line: 52 },
  });
  await applyChangeSet(port, { operations: [addNode('Project', id.project)] }, baseMeta(projectId));
  await applyChangeSet(port, { operations: [addNode('Surface', id.surface), addEdge('PART_OF', id.surface, id.project)] }, baseMeta(projectId));
  await applyChangeSet(
    port,
    {
      operations: [
        addNode('Agent', id.agent),
        addEdge('OWNED_BY', id.surface, id.agent),
        addNode('Check', id.check),
        rule,
        addEdge('APPLIES_TO', id.rule, id.surface),
        addEdge('VERIFIED_BY', id.rule, id.check),
      ],
    },
    baseMeta(projectId),
  );
}

async function withPort(fn) {
  const port = createMemoryPort();
  try {
    return await fn(port);
  } finally {
    await port.close();
  }
}

// Reads the scenario namespace directly through the port — the suite must see what the wrapper
// actually wrote (or did not write), not only what it reports back.
function scenarioNodes(port, scenarioId) {
  return withTransaction(port, (tx) => tx.listNodes({ namespace: 'scenario', scenarioId }));
}

// --- temp fixtures and subprocess helpers -----------------------------------------------------------

const tempRoots = [];

test.after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function candidatesFile(document, text = `${JSON.stringify(document, null, 2)}\n`) {
  const file = join(tempDir('steepy-assembly-candidates-'), 'candidates.json');
  writeFileSync(file, text);
  return file;
}

// Builds a seed export artifact for the CLI's memory seam from a real B5-seeded memory port —
// the same in-process seeding pattern tests/formula-cli-context.test.mjs uses.
async function buildSeedFile(projectId = CLI_PROJECT) {
  const port = createMemoryPort();
  try {
    await seedBaseGraph(port, projectId);
    const artifact = await buildExportArtifact(port, { projectId });
    const file = join(tempDir('steepy-assembly-seed-'), 'seed.json');
    writeFileSync(file, artifact.text);
    return file;
  } finally {
    await port.close();
  }
}

function run(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

// --- the pure D5 mapping: one candidate set, every kind ---------------------------------------------

test('a term maps to exactly TWO operations: the Term node and its USED_BY anchor to the project root (C1)', () => {
  assert.deepEqual([...CANDIDATE_KINDS], ['term', 'rule', 'decision', 'readme']);
  const { operations, outOfGraph, violations } = candidatesToOperations(PROJECT, {
    candidates: [{ kind: 'term', term: 'Typed candidates file', definition: 'The JSON document an agent hands to promotion create.' }],
  });
  assert.deepEqual(violations, []);
  assert.deepEqual(outOfGraph, []);
  assert.deepEqual(operations, [
    {
      op: 'ADD',
      target: 'node',
      namespace: 'curated',
      type: 'Term',
      id: qid('term:typed-candidates-file'),
      properties: { id: qid('term:typed-candidates-file'), status: 'active', ext_v1_definition: 'The JSON document an agent hands to promotion create.' },
    },
    { op: 'ADD', target: 'edge', namespace: 'curated', type: 'USED_BY', fromId: qid('term:typed-candidates-file'), toId: qid('project:root') },
  ]);
});

test('a rule maps to a Rule node carrying concern/strength/status plus the explicit APPLIES_TO scope', () => {
  const { operations, outOfGraph, violations } = candidatesToOperations(PROJECT, {
    candidates: [
      { kind: 'rule', title: 'Suites stay hermetic', statement: 'A suite never writes into the repository it tests.', concern: 'hermeticity', strength: 'must', appliesTo: ID.surface },
      { kind: 'rule', title: 'Prefer observable assertions', statement: 'Assert exit codes, stdout and returned structures.', concern: 'assertions', strength: 'should', appliesTo: ID.surface },
    ],
  });
  assert.deepEqual(violations, []);
  assert.deepEqual(outOfGraph, []);
  assert.deepEqual(operations, [
    {
      op: 'ADD',
      target: 'node',
      namespace: 'curated',
      type: 'Rule',
      id: qid('rule:suites-stay-hermetic'),
      properties: {
        id: qid('rule:suites-stay-hermetic'),
        title: 'Suites stay hermetic',
        statement: 'A suite never writes into the repository it tests.',
        status: 'active',
        strength: 'must',
        category: 'general',
        concern: 'hermeticity',
        provenance: { source: 'typed-candidates:1', line: 1 },
      },
    },
    { op: 'ADD', target: 'edge', namespace: 'curated', type: 'APPLIES_TO', fromId: qid('rule:suites-stay-hermetic'), toId: ID.surface },
    {
      op: 'ADD',
      target: 'node',
      namespace: 'curated',
      type: 'Rule',
      id: qid('rule:prefer-observable-assertions'),
      properties: {
        id: qid('rule:prefer-observable-assertions'),
        title: 'Prefer observable assertions',
        statement: 'Assert exit codes, stdout and returned structures.',
        status: 'active',
        strength: 'should',
        category: 'general',
        concern: 'assertions',
        provenance: { source: 'typed-candidates:2', line: 2 },
      },
    },
    { op: 'ADD', target: 'edge', namespace: 'curated', type: 'APPLIES_TO', fromId: qid('rule:prefer-observable-assertions'), toId: ID.surface },
  ]);
});

test('a decision maps to a single Decision node with the extension-shaped title/statement/context', () => {
  const { operations, outOfGraph, violations } = candidatesToOperations(PROJECT, {
    candidates: [{ kind: 'decision', title: 'Graph DB is canonical', statement: 'The Stable Knowledge Graph is the operational authority.', context: 'Markdown hubs rot; the graph is validated.' }],
  });
  assert.deepEqual(violations, []);
  assert.deepEqual(outOfGraph, []);
  assert.deepEqual(operations, [
    {
      op: 'ADD',
      target: 'node',
      namespace: 'curated',
      type: 'Decision',
      id: qid('decision:graph-db-is-canonical'),
      properties: {
        id: qid('decision:graph-db-is-canonical'),
        status: 'active',
        ext_v1_title: 'Graph DB is canonical',
        ext_v1_statement: 'The Stable Knowledge Graph is the operational authority.',
        ext_v1_context: 'Markdown hubs rot; the graph is validated.',
      },
    },
  ]);
});

test('a readme candidate produces ZERO graph operations — the note lands in outOfGraph', () => {
  const { operations, outOfGraph, violations } = candidatesToOperations(PROJECT, {
    candidates: [{ kind: 'readme', note: 'Document the wrapper in the README.' }],
  });
  assert.deepEqual(violations, []);
  assert.deepEqual(operations, []);
  assert.deepEqual(outOfGraph, [{ kind: 'readme', note: 'Document the wrapper in the README.' }]);
});

test('a mixed document maps every kind in candidate order and NEVER generates a Check', () => {
  const { operations, outOfGraph, violations } = candidatesToOperations(PROJECT, {
    candidates: [
      { kind: 'term', term: 'Surface standard', definition: 'The contract a surface module follows.' },
      { kind: 'rule', title: 'Suites stay hermetic', statement: 'A suite never writes into the repository it tests.', concern: 'hermeticity', strength: 'must', appliesTo: ID.surface },
      { kind: 'decision', title: 'Graph DB is canonical', statement: 'The Stable Knowledge Graph is the operational authority.', context: 'Markdown hubs rot; the graph is validated.' },
      { kind: 'readme', note: 'Update the wrapper section.' },
    ],
  });
  assert.deepEqual(violations, []);
  assert.deepEqual(outOfGraph, [{ kind: 'readme', note: 'Update the wrapper section.' }]);
  // term(2) + rule(2) + decision(1); the readme contributes none — and no Check, ever (D5)
  assert.deepEqual(
    operations.map((op) => `${op.target} ${op.type}`),
    ['node Term', 'edge USED_BY', 'node Rule', 'edge APPLIES_TO', 'node Decision'],
  );
  assert.ok(operations.every((op) => op.type !== 'Check'), 'no Check operation is ever generated');
});

// --- the pure D5 mapping: violations (I1, M1, completeness) -----------------------------------------

test('I1: a digit-leading term slug ("2FA token") is INVALID_CANDIDATE_VALUE — reported, never re-ided; a normal term stays clean', () => {
  const { operations, violations } = candidatesToOperations(PROJECT, {
    candidates: [
      { kind: 'term', term: '2FA token', definition: 'A one-time authentication value.' },
      { kind: 'term', term: 'Refresh token', definition: 'A rotating authentication value.' },
    ],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATE_VALUE);
  assert.deepEqual(violations[0].identity, { index: 0, kind: 'term', field: 'term', value: '2FA token', id: qid('term:2fa-token') });
  assert.match(violations[0].message, /term:2fa-token/);
  // the healthy sibling still maps — one fault never suppresses the rest of the document
  assert.deepEqual(operations.map((op) => op.id ?? op.fromId), [qid('term:refresh-token'), qid('term:refresh-token')]);
});

test('M1: a rule with appliesTo absent is MISSING_CANDIDATE_FIELD; present-but-malformed stays INVALID_CANDIDATE_TARGET', () => {
  const absent = candidatesToOperations(PROJECT, {
    candidates: [{ kind: 'rule', title: 'Suites stay hermetic', statement: 'A suite never writes into the repository it tests.', concern: 'hermeticity', strength: 'must' }],
  });
  assert.deepEqual(absent.operations, []);
  assert.equal(absent.violations.length, 1);
  assert.equal(absent.violations[0].code, CANDIDATE_VIOLATION_CODES.MISSING_CANDIDATE_FIELD);
  assert.deepEqual(absent.violations[0].identity, { index: 0, kind: 'rule', field: 'appliesTo' });

  // not a qualified id / a foreign project / a node kind a Rule cannot be APPLIES_TO
  for (const badTarget of ['not-a-qualified-id', 'apex:other-project:surface:tests', qid('rule:hermetic-suites')]) {
    const malformed = candidatesToOperations(PROJECT, {
      candidates: [{ kind: 'rule', title: 'Suites stay hermetic', statement: 'A suite never writes into the repository it tests.', concern: 'hermeticity', strength: 'must', appliesTo: badTarget }],
    });
    assert.deepEqual(malformed.operations, [], `target '${badTarget}' must not map`);
    assert.equal(malformed.violations.length, 1);
    assert.equal(malformed.violations[0].code, CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATE_TARGET);
    assert.equal(malformed.violations[0].identity.value, badTarget);
  }
});

test('malformed candidates become violations, never throws: non-object, unknown kind, unknown key, missing/empty fields, bad strength', () => {
  const { operations, violations } = candidatesToOperations(PROJECT, {
    candidates: [
      'just a string',
      { kind: 'glossary', term: 'X', definition: 'D.' },
      { kind: 'term', term: 'X', definiton: 'typo' },
      { kind: 'term', term: 'X' },
      { kind: 'term', term: '', definition: 'D.' },
      { kind: 'readme' },
      { kind: 'rule', title: 'T', statement: 'S.', concern: 'c', strength: 'always', appliesTo: ID.surface },
    ],
  });
  assert.deepEqual(operations, []);
  assert.deepEqual(
    violations.map((found) => found.code),
    [
      CANDIDATE_VIOLATION_CODES.MALFORMED_CANDIDATE,
      CANDIDATE_VIOLATION_CODES.UNKNOWN_CANDIDATE_KIND,
      CANDIDATE_VIOLATION_CODES.UNKNOWN_CANDIDATE_KEY,
      CANDIDATE_VIOLATION_CODES.MISSING_CANDIDATE_FIELD,
      CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATE_VALUE,
      CANDIDATE_VIOLATION_CODES.MISSING_CANDIDATE_FIELD,
      CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATE_VALUE,
    ],
  );
  assert.deepEqual(violations[3].identity, { index: 3, kind: 'term', field: 'definition' });
  assert.deepEqual(violations[5].identity, { index: 5, kind: 'readme', field: 'note' });
  assert.equal(violations[6].identity.field, 'strength');
});

test('violation completeness: EVERY malformed candidate in one document is reported, none suppressed', () => {
  const { operations, violations } = candidatesToOperations(PROJECT, {
    candidates: [
      { kind: 'glossary' },
      { kind: 'term', term: '2FA token', definition: 'D.' },
      { kind: 'rule', title: 'T', statement: 'S.', concern: 'c', strength: 'must' },
      { kind: 'rule', title: 'U', statement: 'S.', concern: 'c', strength: 'must', appliesTo: 'nope' },
    ],
  });
  assert.deepEqual(operations, []);
  assert.deepEqual(
    violations.map((found) => [found.identity.index, found.code]),
    [
      [0, CANDIDATE_VIOLATION_CODES.UNKNOWN_CANDIDATE_KIND],
      [1, CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATE_VALUE],
      [2, CANDIDATE_VIOLATION_CODES.MISSING_CANDIDATE_FIELD],
      [3, CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATE_TARGET],
    ],
  );
});

test('the document itself is judged: a non-array candidates value or an unknown document key is INVALID_CANDIDATES', () => {
  const notArray = candidatesToOperations(PROJECT, { candidates: 'nope' });
  assert.deepEqual(notArray.operations, []);
  assert.equal(notArray.violations.length, 1);
  assert.equal(notArray.violations[0].code, CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATES);
  assert.equal(notArray.violations[0].identity.candidates, 'nope');

  const unknownKey = candidatesToOperations(PROJECT, { candidates: [], extra: true });
  assert.equal(unknownKey.violations.length, 1);
  assert.equal(unknownKey.violations[0].code, CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATES);
  assert.deepEqual(unknownKey.violations[0].identity, { key: 'extra' });
});

test('two candidates that slug onto the same node id are a DUPLICATE_CANDIDATE_ID, never a silent merge', () => {
  const { violations } = candidatesToOperations(PROJECT, {
    candidates: [
      { kind: 'term', term: 'Surface standard', definition: 'First.' },
      { kind: 'term', term: 'Surface  Standard!', definition: 'Second.' },
    ],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, CANDIDATE_VIOLATION_CODES.DUPLICATE_CANDIDATE_ID);
  assert.equal(violations[0].identity.id, qid('term:surface-standard'));
});

test('candidatesToOperations throws only on programmer error', () => {
  assert.throws(() => candidatesToOperations('Not A Project', { candidates: [] }), TypeError);
  assert.throws(() => candidatesToOperations(PROJECT, 'nope'), TypeError);
  assert.throws(() => candidatesToOperations(PROJECT, null), TypeError);
});

// --- the assembler: end-to-end on the memory port ---------------------------------------------------

test('assembleScenario: a clean candidate set creates the scenario and returns the typed-diff preview, structural.valid', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const result = await assembleScenario(port, {
      projectId: PROJECT,
      scenarioId: SCENARIO,
      proposedBy: PROPOSED_BY,
      candidates: {
        candidates: [
          { kind: 'term', term: 'Typed candidates file', definition: 'The JSON document an agent hands to promotion create.' },
          { kind: 'rule', title: 'Suites stay hermetic', statement: 'A suite never writes into the repository it tests.', concern: 'hermeticity', strength: 'must', appliesTo: ID.surface },
          { kind: 'readme', note: 'Document the wrapper in the README.' },
        ],
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.scenarioId, SCENARIO);
    assert.deepEqual(result.outOfGraph, [{ kind: 'readme', note: 'Document the wrapper in the README.' }]);

    const { preview } = result;
    assert.equal(preview.ok, true);
    assert.equal(preview.scenarioId, SCENARIO);
    assert.equal(preview.operations.length, 4, 'term(2) + rule(2); the readme is out-of-graph');
    assert.equal(preview.structural.valid, true);
    assert.deepEqual(preview.structural.violations, []);
    assert.deepEqual(preview.advisor, { conflicts: [], duplicates: [] });
    assert.equal(preview.stale, false);
    assert.equal(preview.meta.baseRevision, 'apex:assembly:revision:r3');
    assert.equal(typeof preview.diff, 'string');
    assert.match(preview.diff, new RegExp(`Promotion Scenario: ${SCENARIO}`));
    assert.match(preview.diff, /status: current/);
    assert.match(preview.diff, /ADD node curated Term apex:assembly:term:typed-candidates-file/);
    assert.match(preview.diff, /ADD edge curated USED_BY apex:assembly:term:typed-candidates-file -> apex:assembly:project:root/);
    assert.match(preview.diff, /ADD node curated Rule apex:assembly:rule:suites-stay-hermetic/);

    // the scenario really exists in the port, not only in the returned preview
    assert.ok((await scenarioNodes(port, SCENARIO)).length > 0);
  });
});

test('assembleScenario: advisor findings pass through the preview untouched', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const result = await assembleScenario(port, {
      projectId: PROJECT,
      scenarioId: SCENARIO,
      proposedBy: PROPOSED_BY,
      candidates: {
        candidates: [
          { kind: 'rule', title: SEED_TITLE, statement: SEED_STATEMENT, concern: 'documentation', strength: 'must', appliesTo: ID.surface },
        ],
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.preview.advisor.duplicates.length, 1);
    assert.deepEqual(result.preview.advisor.duplicates[0], {
      kind: 'POSSIBLE_DUPLICATE',
      candidateId: qid('rule:keep-test-suites-hermetic'),
      againstId: ID.rule,
      matched: [
        { property: 'statement', value: SEED_STATEMENT },
        { property: 'title', value: SEED_TITLE },
      ],
      suggestedResolution: 'keep one, or supersede the duplicate',
    });
  });
});

test('assembleScenario: a malformed set is a structured INVALID_CANDIDATES failure and NOTHING is created', async () => {
  await withPort(async (port) => {
    await seedBaseGraph(port);
    const result = await assembleScenario(port, {
      projectId: PROJECT,
      scenarioId: SCENARIO,
      proposedBy: PROPOSED_BY,
      candidates: { candidates: [{ kind: 'term', term: '2FA token', definition: 'A one-time authentication value.' }] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, SCENARIO_ASSEMBLY_ERROR_CODES.INVALID_CANDIDATES);
    assert.equal(result.identity.scenarioId, SCENARIO);
    assert.deepEqual(
      result.identity.violations.map((found) => found.code),
      [CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATE_VALUE],
    );
    assert.deepEqual(await scenarioNodes(port, SCENARIO), []);
  });
});

test('I1 repro on the dogfood seed: a "2FA token" term refuses with nothing created', { skip: DOGFOOD_CHECKPOINT_SKIP }, async () => {
  const port = createMemoryPort();
  try {
    assert.equal((await importGraph(port, { filePath: DOGFOOD_CHECKPOINT })).ok, true);
    const result = await assembleScenario(port, {
      projectId: 'steepy-formula',
      scenarioId: 'i1-repro',
      proposedBy: PROPOSED_BY,
      candidates: { candidates: [{ kind: 'term', term: '2FA token', definition: 'A one-time authentication value.' }] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, SCENARIO_ASSEMBLY_ERROR_CODES.INVALID_CANDIDATES);
    assert.ok(result.identity.violations.some((found) => found.code === CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATE_VALUE));
    assert.deepEqual(await scenarioNodes(port, 'i1-repro'), []);
  } finally {
    await port.close();
  }
});

test('assembleScenario throws only on programmer error', async () => {
  await withPort(async (port) => {
    const input = { projectId: PROJECT, scenarioId: SCENARIO, candidates: { candidates: [] }, proposedBy: PROPOSED_BY };
    await assert.rejects(() => assembleScenario(undefined, input), TypeError);
    await assert.rejects(() => assembleScenario({}, input), TypeError);
    await assert.rejects(() => assembleScenario(port, { ...input, projectId: 'Not A Project' }), TypeError);
    await assert.rejects(() => assembleScenario(port, { ...input, scenarioId: '' }), TypeError);
    await assert.rejects(() => assembleScenario(port, { ...input, candidates: 'nope' }), TypeError);
    await assert.rejects(() => assembleScenario(port, { ...input, proposedBy: undefined }), TypeError);
    await assert.rejects(() => assembleScenario(port, { ...input, proposedBy: { type: 'not-an-actor', name: 'x' } }), TypeError);
    await assert.rejects(() => assembleScenario(port, { ...input, bogus: true }), TypeError);
  });
});

// --- the CLI: refusal paths exit 2 on the memory seam -----------------------------------------------

test('CLI: promotion create without --candidates exits 2', () => {
  const result = run(['promotion', 'create', '--project', CLI_PROJECT, 'no-file', '--port', 'memory']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /requires --candidates/);
});

test('CLI: a missing candidates file exits 2', () => {
  const result = run([
    'promotion', 'create', '--project', CLI_PROJECT, 'missing-file',
    '--candidates', join(tempDir('steepy-assembly-missing-'), 'nope.json'),
    '--port', 'memory',
  ]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /cannot read --candidates file/);
});

test('CLI: a candidates file that is not valid JSON exits 2', () => {
  const file = candidatesFile(null, '{not json\n');
  const result = run(['promotion', 'create', '--project', CLI_PROJECT, 'bad-json', '--candidates', file, '--port', 'memory']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /not valid JSON/);
});

test('CLI: a candidates file holding a JSON non-object exits 2', () => {
  const file = candidatesFile([{ kind: 'term' }]);
  const result = run(['promotion', 'create', '--project', CLI_PROJECT, 'array-doc', '--candidates', file, '--port', 'memory']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /must hold a JSON object/);
});

test('CLI: an unknown kind exits 2 with the violation on stderr and nothing created', () => {
  const file = candidatesFile({ candidates: [{ kind: 'glossary', term: 'X', definition: 'D.' }] });
  const result = run(['promotion', 'create', '--project', CLI_PROJECT, 'bad-kind', '--candidates', file, '--port', 'memory']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /\[UNKNOWN_CANDIDATE_KIND\]/);
  assert.match(result.stderr, /nothing was created/);
});

test('CLI (I1): a "2FA token" term exits 2 with INVALID_CANDIDATE_VALUE and nothing created', () => {
  const file = candidatesFile({ candidates: [{ kind: 'term', term: '2FA token', definition: 'A one-time authentication value.' }] });
  const result = run(['promotion', 'create', '--project', CLI_PROJECT, 'i1-cli', '--candidates', file, '--port', 'memory']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /\[INVALID_CANDIDATE_VALUE\]/);
  assert.match(result.stderr, /2fa-token/);
  assert.match(result.stderr, /nothing was created/);
});

test('CLI (M1): appliesTo absent exits 2 with MISSING_CANDIDATE_FIELD and nothing created', () => {
  const file = candidatesFile({
    candidates: [{ kind: 'rule', title: 'Suites stay hermetic', statement: 'A suite never writes into the repository it tests.', concern: 'hermeticity', strength: 'must' }],
  });
  const result = run(['promotion', 'create', '--project', CLI_PROJECT, 'm1-absent', '--candidates', file, '--port', 'memory']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /\[MISSING_CANDIDATE_FIELD\]/);
  assert.match(result.stderr, /appliesTo/);
  assert.match(result.stderr, /nothing was created/);
});

test('CLI (M1): a present-but-malformed appliesTo exits 2 with INVALID_CANDIDATE_TARGET', () => {
  const file = candidatesFile({
    candidates: [{ kind: 'rule', title: 'Suites stay hermetic', statement: 'A suite never writes into the repository it tests.', concern: 'hermeticity', strength: 'must', appliesTo: 'nope' }],
  });
  const result = run(['promotion', 'create', '--project', CLI_PROJECT, 'm1-malformed', '--candidates', file, '--port', 'memory']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /\[INVALID_CANDIDATE_TARGET\]/);
  assert.match(result.stderr, /nothing was created/);
});

test('CLI: every malformed candidate in one file is reported on stderr, none suppressed', () => {
  const file = candidatesFile({
    candidates: [
      { kind: 'glossary' },
      { kind: 'term', term: '2FA token', definition: 'D.' },
      { kind: 'rule', title: 'T', statement: 'S.', concern: 'c', strength: 'must' },
      { kind: 'rule', title: 'U', statement: 'S.', concern: 'c', strength: 'must', appliesTo: 'nope' },
    ],
  });
  const result = run(['promotion', 'create', '--project', CLI_PROJECT, 'all-bad', '--candidates', file, '--port', 'memory']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  for (const code of ['UNKNOWN_CANDIDATE_KIND', 'INVALID_CANDIDATE_VALUE', 'MISSING_CANDIDATE_FIELD', 'INVALID_CANDIDATE_TARGET']) {
    assert.match(result.stderr, new RegExp(`\\[${code}\\]`), `the ${code} finding must be reported`);
  }
  assert.match(result.stderr, /4 malformed candidate\(s\); nothing was created/);
});

// --- the CLI: the happy path ------------------------------------------------------------------------

test('CLI: promotion create on the memory seam maps a clean file and exits 0 with the summary', async () => {
  const seed = await buildSeedFile();
  const file = candidatesFile({
    candidates: [
      { kind: 'term', term: 'Typed candidates file', definition: 'The JSON document an agent hands to promotion create.' },
      { kind: 'rule', title: 'Suites stay hermetic', statement: 'A suite never writes into the repository it tests.', concern: 'hermeticity', strength: 'must', appliesTo: `apex:${CLI_PROJECT}:surface:tests` },
      { kind: 'readme', note: 'Document the wrapper in the README.' },
    ],
  });
  const result = run([
    'promotion', 'create', '--project', CLI_PROJECT, 'asm-cli',
    '--proposer', 'tests-agent', '--candidates', file,
    '--port', 'memory', '--seed', seed,
  ]);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`promotion create '${CLI_PROJECT}' asm-cli`));
  assert.match(result.stdout, /proposed by:\s+tests-agent \(agent-proposer\)/);
  assert.match(result.stdout, /base revision: apex:assembly-cli:revision:r3/);
  assert.match(result.stdout, /operations:\s+4 graph, 1 out-of-graph/);
  assert.match(result.stdout, /structural:\s+valid/);
  assert.match(result.stdout, /status:\s+current/);
  assert.match(result.stdout, /out-of-graph\[0\]: readme "Document the wrapper in the README\."/);
  assert.match(result.stdout, new RegExp(`next:\\s+steepy-formula promotion preview --project ${CLI_PROJECT} asm-cli`));
});

// --- the CLI: cross-process preview (docker-gated — the memory seam cannot carry scenarios) ----------

const gate = dockerGate();

if (!gate.ok) {
  test(`promotion create CLI suite (docker-gated): ${gate.reason}`, (t) => {
    t.diagnostic(`SKIPPED — ${gate.reason} (pinned image ${ARCADEDB_IMAGE})`);
    t.skip(gate.reason);
  });
} else {
  describe('promotion create CLI (docker-gated)', () => {
    const projectId = `asm-cli-${randomUUID().slice(0, 12).replaceAll('-', '')}`;
    const name = containerNameFor(projectId);
    let server = null;

    before(async () => {
      await destroyContainer(name, { removeVolume: true }); // a crashed earlier run leaves no trap
      server = await startServer({ name, timeoutMs: 90_000 });
    });

    after(async () => {
      await destroyContainer(name, { removeVolume: true });
      server = null;
    });

    test('live: create exits 0 and a SECOND subprocess previews the created scenario (exit 0)', async () => {
      const database = databaseNameFor(projectId);
      // no dropDatabaseOnClose here: the database must survive this port so the CLI subprocesses
      // can open it — the container itself is destroyed in after()
      const port = createArcadeDbPort({ server, database });
      try {
        await createDatabase(server, database);
        await seedBaseGraph(port, projectId);
      } finally {
        await port.close();
      }

      const file = candidatesFile({
        candidates: [
          { kind: 'term', term: 'Typed candidates file', definition: 'The JSON document an agent hands to promotion create.' },
          { kind: 'rule', title: 'Suites stay hermetic', statement: 'A suite never writes into the repository it tests.', concern: 'hermeticity', strength: 'must', appliesTo: `apex:${projectId}:surface:tests` },
          { kind: 'readme', note: 'Document the wrapper in the README.' },
        ],
      });
      const created = run(['promotion', 'create', '--project', projectId, 'live-create', '--proposer', 'tests-agent', '--candidates', file]);
      assert.equal(created.status, 0, `stdout:\n${created.stdout}\nstderr:\n${created.stderr}`);
      assert.match(created.stdout, new RegExp(`promotion create '${projectId}' live-create`));
      assert.match(created.stdout, /operations:\s+4 graph, 1 out-of-graph/);
      assert.match(created.stdout, /structural:\s+valid/);

      // the scenario outlives the creating process — a second subprocess previews it
      const preview = run(['promotion', 'preview', '--project', projectId, 'live-create']);
      assert.equal(preview.status, 0, `stdout:\n${preview.stdout}\nstderr:\n${preview.stderr}`);
      assert.match(preview.stdout, /Promotion Scenario: live-create/);
      assert.match(preview.stdout, /status: current/);
      assert.match(preview.stdout, /ADD node curated Term/);
      assert.match(preview.stdout, /ADD edge curated USED_BY .* -> .*:project:root/);
    });
  });
}
