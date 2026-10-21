// Markdown Hub migration engine suite (Task G1, spec §13 steps 1-5). Every case drives the
// module against REAL fixture hub directory trees (`tests/fixtures/good-hub`, the
// `conflict-hub` planted duplicate/conflict variant, `modular-hub`) through the default
// node:fs facade — the fixtures ARE the real path, so no fake fs. The engine emits a D4
// Promotion Scenario through the B3 in-memory reference port, and the suite asserts the
// emitted scenario (every op an ADD, provenance on every node, deterministic) and the D4
// advisor's advisory findings at inspect time (planted duplicate/conflict flagged, nothing
// invented).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { inspectScenario } from '../scripts/formula/core/promotion.mjs';
import { MIGRATE_ERROR_CODES, MIGRATION_ACTOR_NAME, migrateMarkdown } from '../scripts/formula/core/migrate-markdown.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = (name) => join(here, 'fixtures', name);

const GOOD_HUB = fixtures('good-hub');
const CONFLICT_HUB = fixtures('conflict-hub');
const MODULAR_HUB = fixtures('modular-hub');

function qid(projectId, localId) {
  return `apex:${projectId}:${localId}`;
}

// Runs one migration on a FRESH memory port, so the scenario is always based on the empty
// graph head and repeated runs are comparable. The port stays OPEN — callers that inspect the
// scenario close it themselves.
async function migrate(hubDir, projectId, scenarioId, input = {}) {
  const port = createMemoryPort();
  const result = await migrateMarkdown(port, { hubDir, projectId, scenarioId, ...input });
  assert.ok(result.ok, `migration of ${hubDir} must succeed: ${JSON.stringify(result)}`);
  return { port, result };
}

// Like `migrate`, but the port is closed before the result is returned (result-only tests).
async function migrateOnce(hubDir, projectId, scenarioId, input = {}) {
  const { port, result } = await migrate(hubDir, projectId, scenarioId, input);
  await port.close();
  return result;
}

async function withPort(fn) {
  const port = createMemoryPort();
  try {
    return await fn(port);
  } finally {
    await port.close();
  }
}

function nodeOps(operations) {
  return operations.filter((op) => op.target === 'node');
}

function edgeOps(operations) {
  return operations.filter((op) => op.target === 'edge');
}

function opById(operations, id) {
  return operations.find((op) => op.id === id);
}

function nodeProperties(operations, id) {
  return opById(operations, id).properties;
}

function hasEdge(operations, type, fromId, toId) {
  return operations.some((op) => op.target === 'edge' && op.type === type && op.fromId === fromId && op.toId === toId);
}

// Every rule statement a migration emits must be a verbatim line of one of the hub files.
async function hubText(hubDir) {
  const parts = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.md')) parts.push(await readFile(full, 'utf8'));
    }
  }
  await walk(hubDir);
  return parts.join('\n');
}

// ----------------------------------------------------------------------------------------------
// scan + extract with file:line provenance (binding 1a/1b, 3)

test('good-hub migration: extracts typed candidates with file:line provenance on every op', async () => {
  const result = await migrateOnce(GOOD_HUB, 'good', 'migrate-good');
  const { operations, candidates, meta } = result;

  // The proposing actor is the F1 migration actor (createScenario's { type, name } shape).
  assert.equal(result.proposedBy.type, 'migration');
  assert.equal(result.proposedBy.name, MIGRATION_ACTOR_NAME);
  assert.equal(result.scenario.proposedBy.type, 'migration');

  // Every operation is an ADD, in the curated namespace.
  assert.ok(operations.length > 0, 'scenario must carry operations');
  for (const op of operations) {
    assert.equal(op.op, 'ADD');
    assert.equal(op.namespace, 'curated');
  }

  // Typed candidates each carry { file, line, quotation }.
  // The good-hub web agent is the generated (apex v1.1.0) adapter, whose body carries no normative
  // line; the agent-body Rule extraction is covered by its own inline hub below.
  assert.ok(candidates.length >= 9, `expected at least 9 candidates, got ${candidates.length}`);
  for (const candidate of candidates) {
    assert.equal(typeof candidate.file, 'string');
    assert.equal(typeof candidate.line, 'number');
    assert.equal(typeof candidate.quotation, 'string');
  }

  const P = qid('good', 'project:root');
  const S = qid('good', 'surface:web');
  const A = qid('good', 'agent:web-agent');
  const SK = qid('good', 'skill:web-check');
  const T1 = qid('good', 'term:surface');
  const T2 = qid('good', 'term:rule');
  const C = qid('good', 'check:web-node-test-tests-web-test-mjs');
  const R1 = qid('good', 'rule:web-every-external-value');
  const R2 = qid('good', 'rule:web-session-cookies');
  const R3 = qid('good', 'rule:web-frontend-code');

  const nodes = nodeOps(operations);
  assert.deepEqual(nodes.map((n) => n.id).sort(), [P, S, A, SK, T1, T2, C, R1, R2, R3].sort());

  // Project / Surface / Agent / Skill / Term / Check carry the extension-namespaced file:line note.
  assert.deepEqual(nodeProperties(operations, P).ext_v1_provenance, { source: '.apex/_INDEX.md:1', line: 1 });
  assert.deepEqual(nodeProperties(operations, S).ext_v1_provenance, { source: '.apex/standards/web.md:1', line: 1 });
  assert.deepEqual(nodeProperties(operations, A).ext_v1_provenance, { source: '.claude/agents/web-agent.md:2', line: 2 });
  assert.deepEqual(nodeProperties(operations, SK).ext_v1_provenance, { source: '.claude/skills/web-check/SKILL.md:2', line: 2 });
  assert.deepEqual(nodeProperties(operations, T1).ext_v1_provenance, { source: '.apex/glossary.md:3', line: 3 });
  assert.deepEqual(nodeProperties(operations, T2).ext_v1_provenance, { source: '.apex/glossary.md:4', line: 4 });
  assert.deepEqual(nodeProperties(operations, C).ext_v1_provenance, { source: '.apex/standards/web.md:19', line: 19 });

  // Rules carry the B1 Rule provenance shape { source: '<file>:<line>', line } plus the
  // required Rule properties.
  assert.deepEqual(nodeProperties(operations, R1), {
    id: R1,
    title: 'Every external value',
    statement: 'Every external value must be sanitized before it is written to disk.',
    status: 'active',
    strength: 'must',
    category: 'conventions',
    concern: 'every-external-value',
    provenance: { source: '.apex/standards/web.md:7', line: 7 },
  });
  assert.deepEqual(nodeProperties(operations, R2), {
    id: R2,
    title: 'Session cookies',
    statement: 'Session cookies should expire after thirty minutes of inactivity.',
    status: 'active',
    strength: 'should',
    category: 'conventions',
    concern: 'session-cookies',
    provenance: { source: '.apex/standards/web.md:8', line: 8 },
  });
  assert.deepEqual(nodeProperties(operations, R3), {
    id: R3,
    title: 'Frontend code',
    statement: 'Frontend code must never block on the network during page load.',
    status: 'active',
    strength: 'must',
    category: 'anti-patterns',
    concern: 'frontend-code',
    provenance: { source: '.apex/standards/web.md:12', line: 12 },
  });

  // Proposed topology: Surface PART_OF Project, Agent OWNED_BY Surface, Skill APPLIES_TO the
  // surface, Terms USED_BY the Project, each Rule APPLIES_TO the surface it came from and
  // VERIFIED_BY its surface's check.
  assert.ok(hasEdge(operations, 'PART_OF', S, P));
  assert.ok(hasEdge(operations, 'OWNED_BY', S, A));
  assert.ok(hasEdge(operations, 'APPLIES_TO', SK, S));
  assert.ok(hasEdge(operations, 'USED_BY', T1, P));
  assert.ok(hasEdge(operations, 'USED_BY', T2, P));
  for (const rule of [R1, R2, R3]) {
    assert.ok(hasEdge(operations, 'APPLIES_TO', rule, S), `rule ${rule} must APPLIES_TO the web surface`);
    assert.ok(hasEdge(operations, 'VERIFIED_BY', rule, C), `rule ${rule} must be VERIFIED_BY the web check`);
  }

  // Extraction meta: recognized counts, nothing silently skipped on a current-style hub.
  assert.equal(meta.recognized.surfaces, 1);
  assert.equal(meta.recognized.components, 0);
  assert.equal(meta.recognized.agents, 1);
  assert.equal(meta.recognized.skills, 1);
  assert.equal(meta.recognized.terms, 2);
  assert.equal(meta.recognized.checks, 1);
  assert.equal(meta.recognized.rules, 3);
  assert.equal(meta.recognized.decisions, 0);
  assert.deepEqual(meta.skipped, []);
});

test('a routed agent body Rule is extracted with its agent file:line provenance and the surface scope', async () => {
  const hub = await mkdtemp(join(tmpdir(), 'apex-migrate-agent-rule-'));
  try {
    await mkdir(join(hub, '.apex', 'standards'), { recursive: true });
    await mkdir(join(hub, '.claude', 'agents'), { recursive: true });
    await writeFile(
      join(hub, '.apex', '_INDEX.md'),
      '# Index\n- [Conventions](conventions.md)\n\n' +
        '| Surface | Docs | Agent |\n|---|---|---|\n| `web` | [standards/web.md](standards/web.md) | `web-agent` |\n',
    );
    await writeFile(join(hub, '.apex', 'conventions.md'), '# Conventions\n');
    await writeFile(
      join(hub, '.apex', 'standards', 'web.md'),
      '# web standard\n\n> Owning surface: `web`.\n\n- Pages must load over HTTPS.\n',
    );
    await writeFile(
      join(hub, '.claude', 'agents', 'web-agent.md'),
      '---\nname: web-agent\n---\n\nWeb agent.\n\n- Web pages must include a canonical viewport meta tag.\n',
    );

    const { operations } = await migrateOnce(hub, 'agentrule', 'migrate-agent-rule');
    const rule = qid('agentrule', 'rule:web-web-pages');
    assert.deepEqual(nodeProperties(operations, rule), {
      id: rule,
      title: 'Web pages',
      statement: 'Web pages must include a canonical viewport meta tag.',
      status: 'active',
      strength: 'must',
      category: 'general',
      concern: 'web-pages',
      provenance: { source: '.claude/agents/web-agent.md:7', line: 7 },
    });
    assert.ok(hasEdge(operations, 'APPLIES_TO', rule, qid('agentrule', 'surface:web')));
  } finally {
    await rm(hub, { recursive: true, force: true });
  }
});

test('every op in every emitted scenario carries file:line provenance (binding 3)', async () => {
  for (const [hubDir, projectId, scenarioId] of [
    [GOOD_HUB, 'good', 'migrate-good'],
    [CONFLICT_HUB, 'conflict', 'migrate-conflict'],
    [MODULAR_HUB, 'mod', 'migrate-mod'],
  ]) {
    const result = await migrateOnce(hubDir, projectId, scenarioId);
    const nodes = nodeOps(result.operations);
    const edges = edgeOps(result.operations);

    // Every node op: Rule nodes carry `provenance`, every other curated node carries the
    // extension-namespaced file:line note; both shapes carry { source: '<file>:<line>', line }.
    for (const op of nodes) {
      const note = op.type === 'Rule' ? op.properties.provenance : op.properties.ext_v1_provenance;
      assert.ok(note, `node ${op.id} must carry a provenance note`);
      assert.match(note.source, /^.+:\d+$/, `node ${op.id} provenance source must be <file>:<line>`);
      assert.equal(typeof note.line, 'number');
    }

    // Every edge op: both endpoints are nodes that themselves carry provenance.
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const op of edges) {
      assert.ok(nodeIds.has(op.fromId), `edge fromId ${op.fromId} must be a provenanced node`);
      assert.ok(nodeIds.has(op.toId), `edge toId ${op.toId} must be a provenanced node`);
    }
  }
});

// ----------------------------------------------------------------------------------------------
// nothing invented (binding 2, spec criterion 2)

test('the engine never invents a Rule: fabricated titles are absent and every statement is in the source', async () => {
  const result = await migrateOnce(GOOD_HUB, 'good', 'migrate-good');
  const blob = await hubText(GOOD_HUB);

  const FABRICATED = 'All pages must be paged in via server-side rendering';
  for (const op of nodeOps(result.operations)) {
    if (op.type !== 'Rule') continue;
    assert.notEqual(op.properties.title, FABRICATED, 'a Rule title absent from every scanned file must never appear');
    assert.ok(blob.includes(op.properties.statement), `Rule statement must be a verbatim source line: ${op.properties.statement}`);
  }
});

test('a hub that names no rules still proposes no Rules (nothing inferred from stack or prose alone)', async () => {
  // conflict-hub's agent doc and glossary are prose-only; only the standards/conventions rules
  // (each a verbatim normative line) may be proposed.
  const result = await migrateOnce(CONFLICT_HUB, 'conflict', 'migrate-conflict');
  const ruleIds = nodeOps(result.operations)
    .filter((op) => op.type === 'Rule')
    .map((op) => op.id);
  assert.deepEqual(ruleIds.sort(), [
    qid('conflict', 'rule:every-external-value'),
    qid('conflict', 'rule:web-every-external-value'),
    qid('conflict', 'rule:web-sessions'),
    qid('conflict', 'rule:web-sessions-2'),
  ].sort());
});

// ----------------------------------------------------------------------------------------------
// topology/scope proposals (binding 1c)

test('a conventions rule is proposed with provenance and NO fabricated surface scope', async () => {
  const result = await migrateOnce(CONFLICT_HUB, 'conflict', 'migrate-conflict');
  const convention = qid('conflict', 'rule:every-external-value');
  const surfaceRule = qid('conflict', 'rule:web-every-external-value');

  assert.ok(opById(result.operations, convention), 'the conventions rule must be extracted, never lost');
  assert.deepEqual(nodeProperties(result.operations, convention).provenance, {
    source: '.apex/conventions.md:3',
    line: 3,
  });
  // No fabricated cross-surface scope: the conventions rule has no APPLIES_TO edge at all.
  assert.equal(
    result.operations.some((op) => op.target === 'edge' && op.type === 'APPLIES_TO' && op.fromId === convention),
    false,
    'a project-wide conventions rule must not be scoped to an invented surface',
  );
  assert.ok(hasEdge(result.operations, 'APPLIES_TO', surfaceRule, qid('conflict', 'surface:web')));
});

test('modular standard leaves become Components only because the core names them; leaf rules scope to the Component', async () => {
  const result = await migrateOnce(MODULAR_HUB, 'mod', 'migrate-mod');
  const S = qid('mod', 'surface:web');
  const COMP = qid('mod', 'component:web-auth');
  const coreRule = qid('mod', 'rule:web-the-web-surface');
  const leafRule = qid('mod', 'rule:web-auth-session-tokens');
  const check = qid('mod', 'check:web-node-test-tests-web-core-test-mjs');

  assert.ok(opById(result.operations, COMP), 'the linked leaf standard must propose a Component');
  assert.deepEqual(nodeProperties(result.operations, COMP).ext_v1_provenance, {
    source: '.apex/standards/web/web-core.md:14',
    line: 14,
  });
  assert.ok(hasEdge(result.operations, 'PART_OF', COMP, S));

  assert.ok(hasEdge(result.operations, 'APPLIES_TO', coreRule, S));
  assert.ok(hasEdge(result.operations, 'APPLIES_TO', leafRule, COMP));
  assert.ok(hasEdge(result.operations, 'VERIFIED_BY', coreRule, check));
  assert.ok(hasEdge(result.operations, 'VERIFIED_BY', leafRule, check));
  assert.equal(result.meta.recognized.components, 2,
    'the modular fixture carries two linked leaves (web-auth, web-data), so both become Components');
});

test('single-file standards propose NO Components (nothing invented)', async () => {
  const good = await migrateOnce(GOOD_HUB, 'good', 'migrate-good');
  assert.equal(nodeOps(good.operations).some((op) => op.type === 'Component'), false);
});

// ----------------------------------------------------------------------------------------------
// deterministic emission (binding 4)

test('the same hub migrates to byte-identical scenarios across runs', async () => {
  const run = async () => {
    const port = createMemoryPort();
    try {
      const result = await migrateMarkdown(port, { hubDir: GOOD_HUB, projectId: 'good', scenarioId: 'migrate-good' });
      assert.ok(result.ok);
      const inspection = await inspectScenario(port, { projectId: 'good', scenarioId: 'migrate-good' });
      return { operations: result.operations, diff: inspection.diff };
    } finally {
      await port.close();
    }
  };
  const first = await run();
  const second = await run();
  assert.deepEqual(second.operations, first.operations);
  assert.equal(second.diff, first.diff, 'inspectScenario diff must be byte-identical across runs');
});

// ----------------------------------------------------------------------------------------------
// planted duplicates and conflicts are flagged as advisory findings (binding 1d)

test('planted duplicate and planted conflict are flagged as advisor findings on the scenario', async () => {
  const { port, result } = await migrate(CONFLICT_HUB, 'conflict', 'migrate-conflict');
  try {
    const inspection = await inspectScenario(port, { projectId: 'conflict', scenarioId: 'migrate-conflict' });
    assert.ok(inspection.ok);

    // Planted conflict: two Rules sharing concern `sessions` on the same proposed surface scope
    // with no OVERRIDES path.
    assert.deepEqual(
      inspection.advisor.conflicts,
      [{
        kind: 'POSSIBLE_CONFLICT',
        concern: 'sessions',
        ruleIds: [qid('conflict', 'rule:web-sessions'), qid('conflict', 'rule:web-sessions-2')],
        locations: [qid('conflict', 'surface:web')],
        suggestedResolution: 'keep one; keep both under non-overlapping scopes; or add an explicit OVERRIDES (or SUPERSEDES) resolution.',
      }],
    );

    // Planted duplicate: a conventions line that is verbatim a web-standard line.
    const plantedDuplicate = inspection.advisor.duplicates.find(
      (finding) =>
        finding.candidateId === qid('conflict', 'rule:every-external-value') &&
        finding.againstId === qid('conflict', 'rule:web-every-external-value'),
    );
    assert.ok(plantedDuplicate, 'the planted cross-file duplicate must be flagged as a POSSIBLE_DUPLICATE');
    assert.equal(plantedDuplicate.kind, 'POSSIBLE_DUPLICATE');
    assert.deepEqual(
      plantedDuplicate.matched,
      [
        { property: 'statement', value: 'Every external value must be sanitized before it is written to disk.' },
        { property: 'title', value: 'Every external value' },
      ],
    );

    // The planted conflict is genuinely blocking (B4 shares the concern+scope judgement).
    assert.equal(inspection.structural.valid, false);
    assert.ok(
      inspection.structural.violations.some((v) => v.code === 'UNRESOLVED_RULE_CONFLICT'),
      'the planted same-concern conflict must surface as a blocking structural finding too',
    );
  } finally {
    await port.close();
  }
});

test('the representative good-hub migration is structurally valid with no advisory findings', async () => {
  const { port } = await migrate(GOOD_HUB, 'good', 'migrate-good');
  try {
    const inspection = await inspectScenario(port, { projectId: 'good', scenarioId: 'migrate-good' });
    assert.ok(inspection.ok);
    assert.equal(inspection.structural.valid, true, `expected a clean projection: ${JSON.stringify(inspection.structural.violations)}`);
    assert.deepEqual(inspection.advisor.conflicts, []);
    assert.deepEqual(inspection.advisor.duplicates, []);
  } finally {
    await port.close();
  }
});

// ----------------------------------------------------------------------------------------------
// decisions from explicit ADR-style records

test('a decision/ADR record is extracted as a Decision candidate with provenance', async () => {
  const hub = await mkdtemp(join(tmpdir(), 'apex-migrate-decisions-'));
  try {
    await mkdir(join(hub, '.apex', 'standards'), { recursive: true });
    await mkdir(join(hub, '.apex', 'decisions'), { recursive: true });
    await mkdir(join(hub, '.claude', 'agents'), { recursive: true });
    await writeFile(
      join(hub, '.apex', '_INDEX.md'),
      '# Index\n- [Conventions](conventions.md)\n- [Decisions](decisions/drop-http.md)\n\n' +
        '| Surface | Docs | Agent |\n|---|---|---|\n| `web` | [standards/web.md](standards/web.md) | `web-agent` |\n',
    );
    await writeFile(join(hub, '.apex', 'conventions.md'), '# Conventions\n');
    await writeFile(
      join(hub, '.apex', 'standards', 'web.md'),
      '# web standard\n\n> Owning surface: `web`.\n\n- Pages must load over HTTPS.\n',
    );
    await writeFile(
      join(hub, '.apex', 'decisions', 'drop-http.md'),
      '# Drop the HTTP fallback\n\nStatus: accepted\n\nDecision: serve every asset over HTTPS only.\n',
    );
    await writeFile(join(hub, '.claude', 'agents', 'web-agent.md'), '---\nname: web-agent\n---\n\nWeb agent.\n');

    const result = await migrateOnce(hub, 'dec', 'migrate-decisions');
    const decisionId = qid('dec', 'decision:drop-the-http-fallback');
    assert.ok(opById(result.operations, decisionId), 'the ADR record must propose a Decision node');
    assert.deepEqual(nodeProperties(result.operations, decisionId).ext_v1_provenance, {
      source: '.apex/decisions/drop-http.md:1',
      line: 1,
    });
    assert.equal(result.meta.recognized.decisions, 1);
  } finally {
    await rm(hub, { recursive: true, force: true });
  }
});

test('an unrouted agent Rule is emitted unscoped, never silently lost and never fabricated a scope', async () => {
  const hub = await mkdtemp(join(tmpdir(), 'apex-migrate-unrouted-'));
  try {
    await mkdir(join(hub, '.apex', 'standards'), { recursive: true });
    await mkdir(join(hub, '.claude', 'agents'), { recursive: true });
    await writeFile(
      join(hub, '.apex', '_INDEX.md'),
      '# Index\n- [Conventions](conventions.md)\n\n' +
        '| Surface | Docs | Agent |\n|---|---|---|\n| `web` | [standards/web.md](standards/web.md) | `web-agent` |\n',
    );
    await writeFile(join(hub, '.apex', 'conventions.md'), '# Conventions\n');
    await writeFile(
      join(hub, '.apex', 'standards', 'web.md'),
      '# web standard\n\n> Owning surface: `web`.\n\n- Pages must load over HTTPS.\n',
    );
    // The routed agent carries no normative line; the UNLISTED agent carries one. The routing
    // table knows only web-agent, so the unlisted agent's Rule has no surface to scope to — it
    // must be emitted unscoped (the conventions discipline), never silently dropped (criterion 2).
    await writeFile(join(hub, '.claude', 'agents', 'web-agent.md'), '---\nname: web-agent\n---\n\nWeb agent.\n');
    await writeFile(
      join(hub, '.claude', 'agents', 'unlisted-agent.md'),
      '---\nname: unlisted-agent\n---\n\nUnlisted agent.\n\n- Unlisted agents must never expose API keys.\n',
    );

    const result = await migrateOnce(hub, 'unr', 'migrate-unrouted');
    const unroutedRule = qid('unr', 'rule:unlisted-agents');
    assert.ok(opById(result.operations, unroutedRule), 'the unrouted agent Rule must be extracted, never lost');
    assert.deepEqual(nodeProperties(result.operations, unroutedRule).provenance, {
      source: '.claude/agents/unlisted-agent.md:7',
      line: 7,
    });
    assert.equal(
      result.operations.some((op) => op.target === 'edge' && op.type === 'APPLIES_TO' && op.fromId === unroutedRule),
      false,
      'an unrouted agent Rule must not gain a fabricated surface scope',
    );
  } finally {
    await rm(hub, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------------------------
// structured errors and programmer-error hygiene (binding 5)
test('structured failures: missing hub, hub without _INDEX, hub with no candidates', async () => {
  const missing = await withPort((port) =>
    migrateMarkdown(port, { hubDir: join(tmpdir(), 'does-not-exist-apex-migrate'), projectId: 'proj', scenarioId: 's' }),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.code, MIGRATE_ERROR_CODES.HUB_NOT_FOUND);
  assert.equal(typeof missing.message, 'string');
  assert.ok(missing.identity);

  const bare = await mkdtemp(join(tmpdir(), 'apex-migrate-bare-'));
  try {
    await mkdir(join(bare, '.apex'), { recursive: true });
    const noIndex = await withPort((port) =>
      migrateMarkdown(port, { hubDir: bare, projectId: 'proj', scenarioId: 's' }),
    );
    assert.equal(noIndex.ok, false);
    assert.equal(noIndex.code, MIGRATE_ERROR_CODES.HUB_INVALID);
  } finally {
    await rm(bare, { recursive: true, force: true });
  }

  const noSurfaces = await mkdtemp(join(tmpdir(), 'apex-migrate-nosurf-'));
  try {
    await mkdir(join(noSurfaces, '.apex'), { recursive: true });
    await writeFile(join(noSurfaces, '.apex', '_INDEX.md'), '# Index\n- [Conventions](conventions.md)\n');
    await writeFile(join(noSurfaces, '.apex', 'conventions.md'), '# Conventions\n');
    const none = await withPort((port) =>
      migrateMarkdown(port, { hubDir: noSurfaces, projectId: 'proj', scenarioId: 's' }),
    );
    assert.equal(none.ok, false);
    assert.equal(none.code, MIGRATE_ERROR_CODES.NO_CANDIDATES);
  } finally {
    await rm(noSurfaces, { recursive: true, force: true });
  }
});

test('programmer errors throw TypeError', async () => {
  const port = createMemoryPort();
  try {
    await assert.rejects(() => migrateMarkdown(port, { projectId: 'proj', scenarioId: 's' }), TypeError); // no hubDir
    await assert.rejects(() => migrateMarkdown(port, { hubDir: GOOD_HUB, projectId: 'Not A Project', scenarioId: 's' }), TypeError);
    await assert.rejects(
      () => migrateMarkdown(port, { hubDir: GOOD_HUB, projectId: 'proj', scenarioId: 's', fs: {} }),
      TypeError, // injected fs missing readFile/readdir
    );
    await assert.rejects(
      () => migrateMarkdown(port, { hubDir: GOOD_HUB, projectId: 'proj', scenarioId: 's', mystery: true }),
      TypeError, // unknown input key
    );
    await assert.rejects(() => migrateMarkdown(undefined, { hubDir: GOOD_HUB, projectId: 'proj', scenarioId: 's' }), TypeError);
  } finally {
    await port.close();
  }
});
