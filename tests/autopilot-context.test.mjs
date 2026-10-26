import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import {
  existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildFinalReviewManifest,
  buildFixManifest,
  buildImplementManifest,
  buildImplementerManifest,
  buildPhaseManifest,
  buildPlanManifest,
  buildReviewManifest,
  buildTaskManifest,
  buildTaskReviewerManifest,
  deriveImplicatedStandardPaths,
  manifestReferencePrompt,
  materializeSuccessCriteria,
  parseSuccessCriteria,
  planPhaseContext,
  reviewPhaseContext,
  resolveGraphHubContext,
  specPhaseContext,
  validateContextManifest,
  writeContextManifest,
} from '../scripts/autopilot-context.mjs';
import { phasePrompt } from '../scripts/autopilot.mjs';
import { MIGRATE_REFUSAL_EXIT, MIGRATE_REFUSAL_MESSAGE } from '../scripts/formula/core/markdown-hub.mjs';
import { writeProjectConfig } from '../scripts/formula/core/project-config.mjs';
import { DOGFOOD_CHECKPOINT, DOGFOOD_CHECKPOINT_SKIP } from './helpers/dogfood-checkpoint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, '..', 'scripts', 'autopilot-context.mjs');
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'autopilot-context', 'scenario.json'), 'utf8'));
// The run's graph-resolved context (`steepy-formula context resolve` → `context.md`): the one
// path every implicated surface binds in a phase manifest. Task-role `--standard` /
// `--hub-index` values are resolved contexts too (P14): one per surface in this scenario.
const contextPath = fixture.contextPath;
const scriptsContext = fixture.surfaces.scripts;
const adaptersContext = fixture.surfaces.adapters;
const PURPOSE_UPSTREAM = 'upstream context if the task brief is insufficient; missing facts resolve through the graph resolver (steepy-formula context resolve)';

function seedFixture(repoRoot) {
  for (const [path, contents] of Object.entries(fixture.files)) {
    const absolute = join(repoRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
}

function materialize(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'steepy-context-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  seedFixture(repoRoot);
  return repoRoot;
}

const base = {
  runId: 'run-2026-08-13',
  modelTier: 'most-capable',
  testCommand: 'npm test',
  criterionIds: ['SC3', 'SC5'],
  outputs: ['.formula/work/tasks/context-efficient/task-1-report.md'],
};

test('implementer manifest records bytes, preserves order, and keeps upstream artifacts non-eager', (t) => {
  const repoRoot = materialize(t);
  const manifest = buildImplementerManifest({
    ...base,
    repoRoot,
    task: 1,
    briefPath: '.formula/work/tasks/context-efficient/task-1-brief.md',
    standardPath: scriptsContext,
    planPath: '.formula/work/plans/context-efficient.md',
    specPath: '.formula/work/specs/context-efficient.md',
    hubIndexPath: contextPath,
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.scope.role, 'implementer');
  assert.deepEqual(manifest.required.map(({ path }) => path), [
    '.formula/work/tasks/context-efficient/task-1-brief.md',
    scriptsContext,
  ]);
  assert.deepEqual(manifest.required.map(({ bytes }) => bytes), [
    statSync(join(repoRoot, '.formula/work/tasks/context-efficient/task-1-brief.md')).size,
    statSync(join(repoRoot, scriptsContext)).size,
  ]);
  assert.deepEqual(manifest.onDemand.map(({ path }) => path), [
    '.formula/work/plans/context-efficient.md',
    '.formula/work/specs/context-efficient.md',
    contextPath,
  ]);
  assert.ok(!JSON.stringify(manifest).includes('Node built-ins only'));
});

test('validator rejects traversal, absolute paths, unknown roles, and missing required inputs', (t) => {
  const repoRoot = materialize(t);
  const valid = buildImplementerManifest({
    ...base, repoRoot, task: 1,
    briefPath: '.formula/work/tasks/context-efficient/task-1-brief.md',
    standardPath: scriptsContext,
  });

  assert.throws(
    () => validateContextManifest({ ...valid, outputs: ['../escape.md'] }, { repoRoot }),
    /unsafe output path/,
  );
  assert.throws(
    () => validateContextManifest({ ...valid, required: [{ ...valid.required[0], path: '/etc/passwd' }] }, { repoRoot }),
    /unsafe required path/,
  );
  assert.throws(
    () => validateContextManifest({ ...valid, scope: { ...valid.scope, role: 'oracle' } }, { repoRoot }),
    /unknown context role/,
  );
  assert.throws(
    () => buildImplementerManifest({ ...base, repoRoot, task: 1, briefPath: 'missing.md', standardPath: scriptsContext }),
    /required input does not exist/,
  );
});

test('validator enforces a closed schema and compatible phase, role, and task scope', (t) => {
  const repoRoot = materialize(t);
  const valid = buildImplementerManifest({
    ...base, repoRoot, task: 1,
    briefPath: '.formula/work/tasks/context-efficient/task-1-brief.md',
    standardPath: scriptsContext,
  });

  assert.throws(
    () => validateContextManifest({ ...valid, artifactBody: 'copied artifact' }, { repoRoot }),
    /unexpected manifest property 'artifactBody'/,
  );
  assert.throws(
    () => validateContextManifest({ ...valid, scope: { ...valid.scope, invented: 'value' } }, { repoRoot }),
    /unexpected scope property 'invented'/,
  );
  assert.throws(
    () => validateContextManifest({
      ...valid,
      required: [{ ...valid.required[0], contents: 'copied input' }, valid.required[1]],
    }, { repoRoot }),
    /unexpected required\[0\] property 'contents'/,
  );
  assert.throws(
    () => validateContextManifest({ ...valid, scope: { ...valid.scope, phase: 'plan' } }, { repoRoot }),
    /role 'implementer' requires phase 'implement'/,
  );
  assert.throws(
    () => validateContextManifest({ ...valid, scope: { phase: 'implement', role: 'implement', task: 1 } }, { repoRoot }),
    /phase role 'implement' must not declare a task|unexpected scope property 'task'/,
  );

  const callerOwned = structuredClone(valid);
  const normalized = validateContextManifest(callerOwned, { repoRoot });
  assert.notEqual(normalized, callerOwned);
  assert.notEqual(normalized.scope, callerOwned.scope);
  assert.notEqual(normalized.required[0], callerOwned.required[0]);
  assert.deepEqual(normalized, callerOwned);
});

test('writer produces byte-identical JSON for identical inputs', (t) => {
  const repoRoot = materialize(t);
  const input = {
    ...base, repoRoot, task: 1,
    briefPath: '.formula/work/tasks/context-efficient/task-1-brief.md',
    standardPath: scriptsContext,
  };
  const first = buildTaskManifest('implementer', input);
  const second = buildTaskManifest('implementer', input);
  writeContextManifest(first, { repoRoot, manifestPath: '.formula/work/tasks/context-efficient/context/phase-plan-attempt-1.json' });
  writeContextManifest(second, { repoRoot, manifestPath: '.formula/work/tasks/context-efficient/context/phase-plan-attempt-2.json' });
  assert.deepEqual(first, second);
  assert.equal(
    readFileSync(join(repoRoot, '.formula/work/tasks/context-efficient/context/phase-plan-attempt-1.json'), 'utf8'),
    readFileSync(join(repoRoot, '.formula/work/tasks/context-efficient/context/phase-plan-attempt-2.json'), 'utf8'),
  );
});

test('manifest writes pin the typed manifest family and reject conveniences, aliases, and wrong types', (t) => {
  const repoRoot = materialize(t);
  const manifest = buildTaskManifest('implementer', {
    ...base, repoRoot, task: 1,
    briefPath: '.formula/work/tasks/context-efficient/task-1-brief.md',
    standardPath: scriptsContext,
  });
  const ctx = (name) => `.formula/work/tasks/context-efficient/context/${name}`;
  for (const name of [
    'phase-plan-attempt-1.json',
    'phase-implement-attempt-2.json',
    'phase-review-attempt-3.json',
    'phase-4-attempt-1.json',
    'task-1-implement.json',
    'task-1-review.json',
    'task-1-fix.json',
    'task-2-implement-1.json',
    'task-2-review-4.json',
    'final-review.json',
  ]) {
    const result = writeContextManifest(manifest, { repoRoot, manifestPath: ctx(name) });
    assert.equal(result.path, ctx(name), name);
    assert.equal(JSON.parse(readFileSync(join(repoRoot, ctx(name)), 'utf8')).scope.role, 'implementer', name);
  }
  for (const name of [
    'first.json',
    'notes.json',
    'phase-deploy-attempt-1.json',
    'phase-01-attempt-1.json',
    'phase-plan-attempt-01.json',
    'phase-plan-attempt-0.json',
    'task-0-implement.json',
    'task-1-implementer.json',
    'task-1-implement-0.json',
    'final-review.json.bak',
    'phase-1-attempt-1.raw.jsonl',
  ]) {
    assert.throws(() => writeContextManifest(manifest, { repoRoot, manifestPath: ctx(name) }), /work path/u, name);
    assert.equal(existsSync(join(repoRoot, ctx(name))), false, `${name} must not partially write`);
  }
  for (const [manifestPath, reason] of [
    [`./${ctx('phase-plan-attempt-1.json')}`, /work path/u],
    ['.apex//work/tasks/context-efficient/context/phase-plan-attempt-1.json', /work path/u],
    [`${ctx('phase-plan-attempt-1.json')}/`, /work path/u],
    [`/${ctx('phase-plan-attempt-1.json')}`, /unsafe manifest path/u],
    ['.formula/work/tasks/context-efficient/context/../context/phase-plan-attempt-1.json', /unsafe manifest path/u],
    ['.formula/work/tasks/context-efficient/autopilot-status.md', /this call site expects manifest/u],
    ['.formula/work/specs/context-efficient.md', /this call site expects work-output/u],
  ]) {
    assert.throws(() => writeContextManifest(manifest, { repoRoot, manifestPath }), reason, manifestPath);
  }
});

test('task role builders expose exactly the approved eager inventories', (t) => {
  const repoRoot = materialize(t);
  const common = { ...base, repoRoot, task: 1 };
  const briefPath = '.formula/work/tasks/context-efficient/task-1-brief.md';
  const standardPath = scriptsContext;
  const reportPath = '.formula/work/tasks/context-efficient/task-1-report.md';
  const taskDiffPath = '.formula/work/tasks/context-efficient/task-1.diff';
  const issuePath = '.formula/work/tasks/context-efficient/task-1-review.md';
  const standardPaths = [standardPath, adaptersContext];

  const reviewer = buildTaskReviewerManifest({ ...common, briefPath, reportPath, taskDiffPath, standardPaths, hubIndexPath: contextPath });
  assert.deepEqual(reviewer.required.map((item) => item.path), [briefPath, reportPath, taskDiffPath, ...standardPaths]);
  assert.deepEqual(reviewer.onDemand.map((item) => item.path), [contextPath]);

  const fix = buildFixManifest({ ...common, briefPath, issuePath, taskDiffPath, standardPaths });
  assert.deepEqual(fix.required.map((item) => item.path), [briefPath, issuePath, taskDiffPath, ...standardPaths]);
  assert.throws(
    () => buildImplementerManifest({ ...common, briefPath, standardPaths: [standardPath, standardPath] }),
    /duplicate standard path/i,
  );

  const finalReview = buildFinalReviewManifest({
    ...base, repoRoot,
    criteriaPath: '.formula/work/tasks/context-efficient/success-criteria.md',
    taskResultIndexPath: '.formula/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.formula/work/tasks/context-efficient/branch-diff.txt',
    standardPaths: [scriptsContext, adaptersContext],
  });
  assert.deepEqual(finalReview.required.map((item) => item.path), [
    '.formula/work/tasks/context-efficient/success-criteria.md',
    '.formula/work/tasks/context-efficient/task-result-index.md',
    '.formula/work/tasks/context-efficient/branch-diff.txt',
    scriptsContext,
    adaptersContext,
  ]);
  assert.throws(() => buildFinalReviewManifest({
    ...base, repoRoot,
    criteriaPath: '.formula/work/specs/context-efficient.md',
    taskResultIndexPath: '.formula/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.formula/work/tasks/context-efficient/branch-diff.txt',
    standardPaths: [],
  }), /final-review requires at least one relevant standard/);
  assert.throws(() => buildFinalReviewManifest({
    ...base, repoRoot,
    criteriaPath: '.formula/work/specs/context-efficient.md',
    taskResultIndexPath: '.formula/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.formula/work/tasks/context-efficient/branch-diff.txt',
    standardPaths: [scriptsContext],
  }), /criteria-only artifact.*is a spec path/i);

  const validReview = buildFinalReviewManifest({
    ...base, repoRoot,
    criteriaPath: '.formula/work/tasks/context-efficient/success-criteria.md',
    taskResultIndexPath: '.formula/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.formula/work/tasks/context-efficient/branch-diff.txt',
    standardPaths: [scriptsContext],
  });
  const specStat = statSync(join(repoRoot, '.formula/work/specs/context-efficient.md'));
  assert.throws(() => validateContextManifest({
    ...validReview,
    required: validReview.required.map((entry) => entry.purpose === 'success-criteria source'
      ? { ...entry, path: '.formula/work/specs/context-efficient.md', bytes: specStat.size }
      : entry),
  }, { repoRoot }), /criteria-only artifact.*is a spec path/i);
});

test('criteria materializer writes deterministic attributed criteria-only bytes', (t) => {
  const repoRoot = materialize(t);
  const specPath = '.formula/work/specs/sequential-criteria.md';
  writeFileSync(join(repoRoot, specPath), [
    '# Context-efficient autopilot',
    '',
    'Owning surface: scripts',
    '',
    '## Success criteria',
    '',
    '- SC1: role inventories retain required facts.',
    '- SC2: comparative prompt footprints shrink.',
    '',
  ].join('\n'));
  const outputPath = '.formula/work/tasks/context-efficient/success-criteria.md';
  const first = materializeSuccessCriteria({
    repoRoot,
    specPath,
    outputPath,
  });
  const firstText = readFileSync(join(repoRoot, outputPath), 'utf8');
  const second = materializeSuccessCriteria({
    repoRoot,
    specPath,
    outputPath,
  });
  assert.equal(firstText, readFileSync(join(repoRoot, outputPath), 'utf8'));
  assert.equal(first.path, outputPath);
  assert.equal(first.bytes, second.bytes);
  assert.match(firstText, /Source: `\.formula\/work\/specs\/sequential-criteria\.md`/);
  assert.match(firstText, /Heading: `## Success criteria`/);
  assert.match(firstText, /SC1: role inventories retain required facts/);
  assert.match(firstText, /SC2: comparative prompt footprints shrink/);
  assert.doesNotMatch(firstText, /Owning surface|Cross-cutting surfaces/);
});

test('criteria paths ride the typed grammar: aliases and wrong-type forms fail closed at both call sites', (t) => {
  const repoRoot = materialize(t);
  const specPath = '.formula/work/specs/sequential-criteria.md';
  writeFileSync(join(repoRoot, specPath), [
    '# Sequential fixture',
    '',
    '## Success criteria',
    '',
    '- SC1: first.',
    '- SC2: second.',
    '',
  ].join('\n'));
  const canonical = '.formula/work/tasks/context-efficient/success-criteria.md';
  const finalReview = (criteriaPath) => buildFinalReviewManifest({
    ...base, repoRoot,
    criteriaPath,
    taskResultIndexPath: '.formula/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.formula/work/tasks/context-efficient/branch-diff.txt',
    standardPaths: [scriptsContext],
  });
  assert.equal(finalReview(canonical).required[0].path, canonical);
  for (const criteriaPath of [
    `./${canonical}`,
    '.apex//work/tasks/context-efficient/success-criteria.md',
    '.formula/work//tasks/context-efficient/success-criteria.md',
    `${canonical}/`,
    '.formula/work/tasks/context-efficient/./success-criteria.md',
    '.formula/work/specs/sequential-criteria.md',
    '.formula/work/plans/context-efficient.md',
    '.formula/work/tasks/context-efficient/autopilot-status.md',
    '.formula/work/tasks/context-efficient/branch-diff.txt',
    '.formula/work/tasks/context-efficient/task-result-index.md',
    '.formula/work/tasks/context-efficient/context/task-1-implement.json',
    '.formula/work/tasks/context-efficient/ledger.md',
    contextPath,
    'scripts/autopilot-context.mjs',
  ]) {
    assert.throws(() => finalReview(criteriaPath), /criteria-only artifact/u, criteriaPath);
    assert.throws(
      () => materializeSuccessCriteria({ repoRoot, specPath, outputPath: criteriaPath }),
      /criteria-only artifact/u,
      criteriaPath,
    );
  }
  for (const [criteriaPath, reason] of [
    [`/${canonical}`, /unsafe review criteria path/u],
    ['.formula/work/tasks/../tasks/context-efficient/success-criteria.md', /unsafe review criteria path/u],
  ]) {
    assert.throws(() => finalReview(criteriaPath), reason, criteriaPath);
  }
  for (const [source, reason] of [
    ['.formula/work/tasks/context-efficient/success-criteria.md', /criteria source must be a canonical spec under/u],
    ['.formula/work/plans/context-efficient.md', /criteria source must be a canonical spec under/u],
    ['./.formula/work/specs/sequential-criteria.md', /criteria source must be a canonical spec under/u],
    ['.formula/work/specs/nested/sequential-criteria.md', /criteria source must be a canonical spec under/u],
    ['scripts/autopilot-context.mjs', /criteria source must be a canonical spec under/u],
  ]) {
    assert.throws(
      () => materializeSuccessCriteria({ repoRoot, specPath: source, outputPath: canonical }),
      reason,
      source,
    );
  }
});

test('symlinked criteria, manifest, and spec-source targets and ancestors fail closed with the outside sentinel untouched', (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'steepy-context-confine-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const sequentialSpecContents = [
    '# Sequential fixture',
    '',
    '## Success criteria',
    '',
    '- SC1: first.',
    '- SC2: second.',
    '',
  ].join('\n');
  const scenarios = [
    {
      family: 'criteria',
      path: '.formula/work/tasks/confine-run/success-criteria.md',
      positions: [2, 3, 4],
      seed: (repoRoot) => {
        mkdirSync(join(repoRoot, '.formula', 'work', 'specs'), { recursive: true });
        writeFileSync(join(repoRoot, '.formula/work/specs/sequential-criteria.md'), sequentialSpecContents);
      },
      write: (repoRoot) => materializeSuccessCriteria({
        repoRoot,
        specPath: '.formula/work/specs/sequential-criteria.md',
        outputPath: '.formula/work/tasks/confine-run/success-criteria.md',
      }),
    },
    {
      family: 'manifest',
      path: '.formula/work/tasks/confine-run/context/phase-plan-attempt-1.json',
      positions: [3, 4, 5],
      seed: seedFixture,
      write: (repoRoot) => writeContextManifest(buildTaskManifest('implementer', {
        ...base, repoRoot, task: 1,
        briefPath: '.formula/work/tasks/context-efficient/task-1-brief.md',
        standardPath: scriptsContext,
      }), { repoRoot, manifestPath: '.formula/work/tasks/confine-run/context/phase-plan-attempt-1.json' }),
    },
    {
      family: 'spec-source',
      path: '.formula/work/specs/sequential-criteria.md',
      positions: [2, 3],
      seed: (repoRoot) => {
        mkdirSync(join(repoRoot, '.formula', 'work'), { recursive: true });
      },
      write: (repoRoot) => materializeSuccessCriteria({
        repoRoot,
        specPath: '.formula/work/specs/sequential-criteria.md',
        outputPath: '.formula/work/tasks/confine-run/success-criteria.md',
      }),
    },
  ];
  for (const scenario of scenarios) {
    const segments = scenario.path.split('/').slice(0, -1);
    const targetName = scenario.path.split('/').at(-1);
    for (const position of scenario.positions) {
      const label = `${scenario.family} position ${position}`;
      const repo = join(outer, `${scenario.family}-${position}-repo`);
      const outside = join(outer, `${scenario.family}-${position}-outside`);
      mkdirSync(repo);
      mkdirSync(outside);
      scenario.seed(repo);
      let sentinelPath;
      const linkPath = position < segments.length
        ? join(repo, ...segments.slice(0, position + 1))
        : join(repo, ...segments, targetName);
      if (position < segments.length) {
        const mirror = join(outside, 'mirror');
        sentinelPath = join(mirror, ...segments.slice(position + 1), targetName);
        mkdirSync(dirname(sentinelPath), { recursive: true });
        writeFileSync(sentinelPath, 'outside sentinel\n');
        mkdirSync(join(repo, ...segments.slice(0, position)), { recursive: true });
        symlinkSync(mirror, linkPath, 'dir');
      } else {
        sentinelPath = join(outside, 'sentinel.md');
        writeFileSync(sentinelPath, 'outside sentinel\n');
        mkdirSync(join(repo, ...segments), { recursive: true });
        symlinkSync(sentinelPath, linkPath, 'file');
      }
      const before = readdirSync(repo, { recursive: true }).sort();
      assert.throws(() => scenario.write(repo), /work path: .*(symlink|escape|non-directory|non-file|identity)/u, label);
      assert.equal(readFileSync(sentinelPath, 'utf8'), 'outside sentinel\n', `${label} outside sentinel untouched`);
      assert.equal(lstatSync(linkPath).isSymbolicLink(), true, `${label} symlink preserved`);
      assert.deepEqual(readdirSync(repo, { recursive: true }).sort(), before, `${label} no partial write inside the repo`);
      assert.equal(before.some((entry) => entry.includes('steepy-work-')), false, `${label} no temp residue`);
    }
  }
});

test('the exported success-criteria parser pins the shared strict grammar', () => {
  assert.deepEqual(parseSuccessCriteria('SC4'), { criterionIds: ['SC4'] });
  assert.deepEqual(parseSuccessCriteria('**SC1**, `SC2` prose').criterionIds, ['SC1', 'SC2']);
  assert.deepEqual(parseSuccessCriteria('SC1, SC3').criterionIds, ['SC1', 'SC3']);
  const section = parseSuccessCriteria('# Spec\n\n## Success criteria\n\n- SC1: a\n- SC2: b\n', { section: true, label: 'criteria source' });
  assert.deepEqual(section.criterionIds, ['SC1', 'SC2']);
  assert.equal(section.heading, '## Success criteria');
  assert.equal(section.section, '## Success criteria\n\n- SC1: a\n- SC2: b');
  assert.throws(() => parseSuccessCriteria('SC3, SC2'), /strictly increasing.*SC3.*SC2/i);
  const hugeHigh = `SC${'9'.repeat(400)}`;
  const hugeLow = `SC${'8'.repeat(400)}`;
  assert.throws(() => parseSuccessCriteria(`${hugeHigh}, ${hugeLow}`), /strictly increasing/i);
  assert.throws(() => parseSuccessCriteria('## Success criteria\n\n- SC2: only\n', { section: true }), /must start at SC1/i);
  assert.throws(() => parseSuccessCriteria('none', { section: true, label: 'criteria source' }), /exactly one '## Success criteria' heading; found 0/i);
});

test('the SC negative matrix keeps spec sequencing strict while task mappings may skip IDs', (t) => {
  const repoRoot = materialize(t);
  const specPath = '.formula/work/specs/sc-matrix.md';
  const outputPath = '.formula/work/tasks/sc-matrix-run/success-criteria.md';
  for (const [label, criteriaField, criteriaSection, reason] of [
    ['missing', 'none', '- Deliver every criterion.', /missing success-criterion IDs/i],
    ['duplicate', 'SC1, SC1', '- SC1: first\n- SC1: repeated', /duplicate success-criterion ID 'SC1'/i],
    ['out-of-order', 'SC2, SC1', '- SC2: second\n- SC1: first', /strictly (?:sequential|increasing)/i],
    ['leading zero', 'SC01', '- SC01: zero padded', /'SC01'.*no leading zeros/i],
  ]) {
    const fixture = `# Fixture\n\n## Task 1 — probe\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Dependencies:** none\n- **Success criteria:** ${criteriaField}\n\n## Success criteria\n\n${criteriaSection}\n`;
    assert.throws(() => planPhaseContext(fixture), reason, `${label} must fail the plan-side parse`);
    writeFileSync(join(repoRoot, specPath), fixture);
    assert.throws(
      () => materializeSuccessCriteria({ repoRoot, specPath, outputPath }),
      reason,
      `${label} must fail the spec-side parse`,
    );
    assert.equal(existsSync(join(repoRoot, outputPath)), false, `${label} must not partially write`);
  }
  const gapFixture = '# Fixture\n\n## Task 1 — probe\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Dependencies:** none\n- **Success criteria:** SC1, SC3\n\n## Success criteria\n\n- SC1: first\n- SC3: third\n';
  assert.deepEqual(planPhaseContext(gapFixture).criterionIds, ['SC1', 'SC3']);
  writeFileSync(join(repoRoot, specPath), gapFixture);
  assert.throws(
    () => materializeSuccessCriteria({ repoRoot, specPath, outputPath }),
    /strictly sequential.*SC1.*SC3/i,
  );
  assert.equal(existsSync(join(repoRoot, outputPath)), false);
  const secondHeading = '# Fixture\n\n## Success criteria\n\n- SC1: first\n\n## Success criteria\n\n- SC1: repeated\n';
  assert.throws(() => planPhaseContext(secondHeading), /no Task headings/i);
  writeFileSync(join(repoRoot, specPath), secondHeading);
  assert.throws(
    () => materializeSuccessCriteria({ repoRoot, specPath, outputPath }),
    /exactly one '## Success criteria' heading; found 2/i,
  );
});

test('markdown routing accepts canonical emphasis and rejects unsupported field aliases', () => {
  const spec = [
    '- **Owning surface**: scripts',
    '- **Cross-cutting surfaces:** `adapters`, prose',
    '- **Feature complexity**: design',
  ].join('\n');
  assert.deepEqual(specPhaseContext(spec), {
    owningSurface: 'scripts',
    crossCuttingSurfaces: ['adapters', 'prose'],
    complexity: 'design',
    modelTier: 'most-capable',
    evidence: 'spec:Feature-complexity=design',
  });

  const canonical = '# Plan\n\n## Task 1 — canonical\n\n- **Surface**: `scripts`\n- **Complexity**: integration\n- **Dependencies**: none\n- **Success criteria**: SC1, SC2\n';
  const unsupported = '# Plan\n\n## Task 1 — unsupported\n\n- **Surface:** `scripts`\n- **Complexity:** integration\n- **Dependencies:** none\n- **Spec criteria:** SC1, SC2\n';
  assert.deepEqual(planPhaseContext(canonical).criterionIds, ['SC1', 'SC2']);
  assert.throws(() => planPhaseContext(unsupported), /missing Success criteria/);
  assert.throws(() => planPhaseContext(canonical.replace('Surface', 'Owning surface')), /missing Surface/);
});

test('spec metadata rejects combined ownership and missing complexity', () => {
  for (const ownership of ['scripts (cross-cutting: `adapters`)', '`scripts`, `adapters`']) {
    assert.throws(() => specPhaseContext(`- **Owning surface:** ${ownership}\n- **Feature complexity:** integration`), /exactly one surface/);
  }
  assert.throws(() => specPhaseContext('- **Owning surface:** scripts'), /missing Feature complexity/);
});

test('ownership stays strict: owning and per-task surfaces bind the resolved context and are never reported as unrouted', () => {
  for (const ownership of [
    { owningSurface: 'ghost' },
    { tasks: [{ owningSurface: 'ghost' }] },
    // Cross-cutting is advisory only until the same surface is also an ownership fact.
    { crossCuttingSurfaces: ['ghost'], tasks: [{ surface: 'ghost' }] },
  ]) {
    const ignored = [];
    assert.deepEqual(
      deriveImplicatedStandardPaths({ ownership, contextPath, onUnroutedSurface: (surface) => ignored.push(surface) }),
      [contextPath],
      `${JSON.stringify(ownership)} must bind the resolved context`,
    );
    assert.deepEqual(ignored, [], `${JSON.stringify(ownership)} is an ownership fact, never advisory prose`);
  }

  for (const [ownership, reason] of [
    [{ tasks: [{}] }, /tasks\[0\] is missing owningSurface/],
    [{ tasks: ['scripts'] }, /tasks\[0\] must be an object/],
    [{ tasks: 'scripts' }, /tasks must be a list/],
    [{ owningSurface: 'scripts\nsecond line' }, /unsafe owningSurface/],
    ['scripts', /ownership must be an object/],
  ]) {
    assert.throws(() => deriveImplicatedStandardPaths({ ownership, contextPath }), reason, JSON.stringify(ownership));
  }

  assert.throws(
    () => deriveImplicatedStandardPaths({ ownership: { owningSurface: 'scripts' }, contextPath, onUnroutedSurface: 'nope' }),
    /onUnroutedSurface must be a function/,
  );
});

test('a canonical spec with cross-cutting surfaces builds its plan manifest', (t) => {
  const repoRoot = materialize(t);
  const route = specPhaseContext([
    '- **Owning surface:** `scripts`',
    '- **Cross-cutting surfaces:** `adapters`, stable hub docs',
    '- **Feature complexity:** design',
  ].join('\n'));
  const ignored = [];
  const manifest = buildPlanManifest({
    ...base, repoRoot,
    modelTier: route.modelTier,
    specPath: '.formula/work/specs/context-efficient.md',
    contextPath,
    owningSurface: route.owningSurface,
    crossCuttingSurfaces: route.crossCuttingSurfaces,
    onUnroutedSurface: (surface) => ignored.push(surface),
  });
  assert.deepEqual(manifest.required.map((item) => item.path), [
    '.formula/work/specs/context-efficient.md', contextPath,
  ]);
  assert.deepEqual(manifest.onDemand.map((item) => item.path), []);
  // P12: every cross-cutting entry that is not also an ownership fact is reported and skipped —
  // a registered surface name (`adapters`) and prose alike; the owning surface's resolved
  // context already carries what the graph knows about it.
  assert.deepEqual(ignored, ['adapters', 'stable hub docs']);
});

test('plan routing fails closed when task boundaries or criterion IDs are absent', () => {
  assert.throws(() => planPhaseContext(
    '# Plan\n\n### 1. No canonical task boundary\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n',
  ), /no Task headings/i);
  assert.throws(() => planPhaseContext(
    '# Plan\n\n## Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Dependencies:** none\n- **Success criteria:** none\n',
  ), /missing success-criterion IDs/i);
  for (const heading of ['## Task zero', '## Task 0', '## Task -1', '## Task 1a']) {
    assert.throws(() => planPhaseContext(
      `# Plan\n\n${heading}\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Dependencies:** none\n- **Success criteria:** SC1\n`,
    ), /invalid H2 Task heading/i, `${heading} must fail as a malformed canonical boundary`);
  }
  assert.throws(() => planPhaseContext(
    '# Plan\n\n### Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n',
  ), /no Task headings/i, 'nested Task prose remains ignored');
  for (const [label, taskHeadings, reason] of [
    ['duplicate', ['## Task 1', '## Task 1'], /duplicate plan task id '1'/i],
    ['descending', ['## Task 2', '## Task 1'], /strictly increasing.*2.*1/i],
    ['non-increasing', ['## Task 3', '## Task 2'], /strictly increasing.*3.*2/i],
    ['unsafe', ['## Task 9007199254740992'], /safe integer/i],
  ]) {
    const plan = `# Plan\n\n${taskHeadings.map((heading) => `${heading}\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Dependencies:** none\n- **Success criteria:** SC1\n`).join('\n')}`;
    assert.throws(() => planPhaseContext(plan), reason, `${label} task order must fail closed`);
  }
  for (const invalidHeading of ['## Task 0', '## Task 02', '## Task -1', '## Task x', '## Task 1a']) {
    const mixed = `# Plan\n\n## Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Dependencies:** none\n- **Success criteria:** SC1\n\n${invalidHeading}\n\n- **Surface:** adapters\n- **Complexity:** mechanical\n- **Dependencies:** none\n- **Success criteria:** SC2\n`;
    assert.throws(
      () => planPhaseContext(mixed),
      /invalid H2 Task heading|positive safe integer/i,
      `${invalidHeading} must not disappear after a valid task`,
    );
  }
});

test('review routing accepts only the canonical task-result-index bullet grammar', () => {
  const plan = '# Plan\n\n## Task 1\n\n- **Surface:** `scripts`\n- **Complexity:** `mechanical`\n- **Dependencies:** none\n- **Success criteria:** SC1\n\n## Task 2\n\n- **Surface:** `adapters`\n- **Complexity:** `integration`\n- **Dependencies:** none\n- **Success criteria:** SC2\n';
  const canonical = '# Results\n\n- Task 1: DONE; artifact: .formula/work/tasks/topic/task-1-report.md; changed-paths: none; signals: tdd:red-green\n- Task 2: DONE_WITH_CONCERNS; artifact: .formula/work/tasks/topic/task-2-report.md; changed-paths: adapters/example.mjs; signals: follow-up:telemetry\n';
  assert.deepEqual(reviewPhaseContext(plan, canonical).tasks.map(({ task }) => task), ['1', '2']);
  assert.deepEqual(
    reviewPhaseContext(plan, canonical.replaceAll('\n', '\r\n')).tasks.map(({ task }) => task),
    ['1', '2'],
    'canonical CRLF indexes must parse identically',
  );
  assert.throws(
    () => reviewPhaseContext(plan, canonical.split('\n').filter((line) => !line.startsWith('- Task 2:')).join('\n')),
    /omits plan task ids: 2/i,
  );
  for (const shorthand of [
    '# Results\n\n- Task 1: DONE\n',
    '# Results\n\n- Task 1: DONE; report: task-1-report.md\n',
    '# Results\n\n* Task 1: DONE; artifact: .formula/work/tasks/topic/task-1-report.md; changed-paths: none; signals: none\n',
  ]) {
    assert.throws(() => reviewPhaseContext(plan, shorthand), /malformed reviewed task entry/i);
  }
});

test('review routing reads v2 receipt projections with literal steepysite paths', () => {
  const plan = '# Plan\n\n## Task 1\n\n- **Surface:** web\n- **Complexity:** integration\n- **Dependencies:** none\n- **Success criteria:** SC1\n';
  const entry = { task: '1', status: 'DONE', artifact: '.formula/work/tasks/topic/task-1-report.md',
    changedPaths: ['apps/web/app/admin/(protected)/generation/[id]/page.tsx', 'src/a,b;c è.ts'],
    signals: [], receipt: '.formula/work/tasks/topic/task-1-execution-1' };
  const index = `# Results\n<!-- steepy-task-results: v2 -->\n\`\`\`json\n${JSON.stringify([entry])}\n\`\`\`\n<!-- /steepy-task-results -->\n`;
  assert.deepEqual(reviewPhaseContext(plan, index).tasks.map(({ task }) => task), ['1']);
  assert.throws(() => reviewPhaseContext(plan, index.replace('"task":"1"', '"task":"2"')), /unknown reviewed task|correlation mismatch/);
  assert.throws(() => reviewPhaseContext(plan, index.replace('v2', 'v99')), /version|protocol|projection/i);
  assert.throws(() => reviewPhaseContext(plan, index + '- Task 1: DONE; artifact: x.md; changed-paths: none; signals: none\n'), /mixed|projection/i);
});

test('discovery signals survive the real review manifest boundary without loading per-task reports', (t) => {
  const repoRoot = materialize(t);
  const indexPath = '.formula/work/tasks/context-efficient/task-result-index.md';
  const plan = '# Plan\n\n## Task 1\n\n- **Surface:** `scripts`\n- **Complexity:** `integration`\n- **Dependencies:** none\n- **Success criteria:** SC3\n';
  for (const signals of [['discovery:unplanned', 'tdd:red-green'], ['review:same-session'], []]) {
    const entry = { task: '1', status: 'DONE_WITH_CONCERNS', artifact: '.formula/work/tasks/context-efficient/task-1-report.md',
      changedPaths: [], signals, receipt: '.formula/work/tasks/context-efficient/task-1-execution-1' };
    const index = `# Results\n\n<!-- steepy-task-results: v2 -->\n\`\`\`json\n${JSON.stringify([entry], null, 2)}\n\`\`\`\n<!-- /steepy-task-results -->\n`;
    writeFileSync(join(repoRoot, indexPath), index);
    const manifest = buildReviewManifest({
      ...base, repoRoot,
      criteriaPath: '.formula/work/tasks/context-efficient/success-criteria.md',
      taskResultIndexPath: indexPath,
      branchDiffPath: '.formula/work/tasks/context-efficient/branch-diff.txt',
      tasks: reviewPhaseContext(plan, index).tasks, contextPath,
    });
    const declaredIndex = manifest.required.find(({ path }) => path === indexPath);
    assert.ok(declaredIndex);
    assert.equal(readFileSync(join(repoRoot, declaredIndex.path), 'utf8'), index);
    assert.equal(declaredIndex.bytes, Buffer.byteLength(index));
    assert.ok(![...manifest.required, ...manifest.onDemand].some(({ path }) => path.endsWith('task-1-report.md')));
  }
  // The manifest preserves bytes; the skill, not this transport, interprets the signal.
  const protocol = readFileSync(join(here, '..', 'skills/implement/autopilot-protocol.md'), 'utf8');
  assert.match(protocol, /preserve[^]*discovery:unplanned[^]*task-result index/i);
  assert.match(protocol, /ordinary concerns[^]*not[^]*discovery/i);
});

test('SC6: the phase-controller tier is floored and capped at standard, named with distribution evidence', () => {
  const mixedPlan = [
    '# Plan',
    '',
    '## Task 1 — bump a constant',
    '',
    '- **Surface:** `scripts`',
    '- **Complexity:** `mechanical`',
    '- **Dependencies:** none',
    '- **Success criteria:** SC1',
    '',
    '## Task 2 — redesign the tier ladder',
    '',
    '- **Surface:** `scripts`',
    '- **Complexity:** `design`',
    '- **Dependencies:** none',
    '- **Success criteria:** SC2',
    '',
  ].join('\n');

  const implement = planPhaseContext(mixedPlan);
  assert.equal(implement.modelTier, 'standard');
  assert.notEqual(implement.modelTier, 'most-capable');
  assert.match(implement.evidence, /phase-controller-tier=standard/);
  assert.match(implement.evidence, /distribution=mechanical:1,integration:0,design:1/);

  const entries = ['1', '2'].map((task) => ({ task, status: 'DONE', artifact: `.formula/work/tasks/topic/task-${task}-report.md`,
    changedPaths: [], signals: ['tdd:red-green'], receipt: `.formula/work/tasks/topic/task-${task}-execution-1` }));
  const index = `# Results\n\n<!-- steepy-task-results: v2 -->\n\`\`\`json\n${JSON.stringify(entries, null, 2)}\n\`\`\`\n<!-- /steepy-task-results -->\n`;
  const review = reviewPhaseContext(mixedPlan, index);
  assert.equal(review.modelTier, 'standard');
  assert.notEqual(review.modelTier, 'most-capable');
  assert.match(review.evidence, /result-index:reviewed-tasks=1,2/);
  assert.match(review.evidence, /phase-controller-tier=standard/);
  assert.match(review.evidence, /distribution=mechanical:1,integration:0,design:1/);
});

test('phase builders list the resolved context exactly once and preserve scalar contract metadata', (t) => {
  const repoRoot = materialize(t);
  const entries = (list) => list.map(({ path, purpose }) => [path, purpose]);
  const plan = buildPlanManifest({
    ...base, repoRoot,
    specPath: '.formula/work/specs/context-efficient.md',
    contextPath,
    owningSurface: 'scripts',
    crossCuttingSurfaces: ['adapters'],
    contract: { commitAuth: 'yes', drive: 'autopilot' },
  });
  assert.deepEqual(entries(plan.required), [
    ['.formula/work/specs/context-efficient.md', 'approved specification'],
    [contextPath, 'implicated surface standard'],
  ]);
  assert.deepEqual(plan.onDemand, []);
  assert.deepEqual(plan.contract, { commitAuth: 'yes', drive: 'autopilot' });

  const implement = buildImplementManifest({
    ...base, repoRoot,
    planPath: '.formula/work/plans/context-efficient.md',
    ledgerPath: '.formula/work/tasks/context-efficient/ledger.md',
    specPath: '.formula/work/specs/context-efficient.md',
    contextPath,
    tasks: [{ surface: 'scripts' }, { surface: 'adapters' }],
  });
  assert.deepEqual(entries(implement.required), [
    ['.formula/work/plans/context-efficient.md', 'approved implementation plan'],
  ]);
  assert.deepEqual(entries(implement.onDemand), [
    [contextPath, 'implicated surface standard'],
    ['.formula/work/tasks/context-efficient/ledger.md', 'implementation task ledger'],
    ['.formula/work/specs/context-efficient.md', PURPOSE_UPSTREAM],
  ]);

  const review = buildReviewManifest({
    ...base, repoRoot,
    criteriaPath: '.formula/work/tasks/context-efficient/success-criteria.md',
    taskResultIndexPath: '.formula/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.formula/work/tasks/context-efficient/branch-diff.txt',
    contextPath,
    tasks: [{ owningSurface: 'scripts' }, { owningSurface: 'adapters' }],
  });
  assert.deepEqual(entries(review.required), [
    ['.formula/work/tasks/context-efficient/success-criteria.md', 'success-criteria source'],
    ['.formula/work/tasks/context-efficient/task-result-index.md', 'plan and task-result index'],
    ['.formula/work/tasks/context-efficient/branch-diff.txt', 'aggregate branch diff'],
    [contextPath, 'implicated surface standard'],
  ]);
  assert.deepEqual(review.onDemand, []);

  // The legacy routing purposes are gone: no phase manifest names a routing table, a testing
  // checklist, or a conditional (leaf) standard — the resolved context stands for all of them.
  for (const manifest of [plan, implement, review]) {
    const purposes = [...manifest.required, ...manifest.onDemand].map(({ purpose }) => purpose);
    for (const legacy of ['surface routing table', 'testing checklist', 'conditional surface standard']) {
      assert.ok(!purposes.includes(legacy), `${manifest.scope.role} must not carry the '${legacy}' purpose`);
    }
  }

  assert.deepEqual(buildPhaseManifest('review', {
    ...base, repoRoot,
    criteriaPath: '.formula/work/tasks/context-efficient/success-criteria.md',
    taskResultIndexPath: '.formula/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.formula/work/tasks/context-efficient/branch-diff.txt',
    tasks: [{ surface: 'scripts' }], contextPath,
  }), buildReviewManifest({
    ...base, repoRoot,
    criteriaPath: '.formula/work/tasks/context-efficient/success-criteria.md',
    taskResultIndexPath: '.formula/work/tasks/context-efficient/task-result-index.md',
    branchDiffPath: '.formula/work/tasks/context-efficient/branch-diff.txt',
    tasks: [{ surface: 'scripts' }], contextPath,
  }));
});

test('comparative fixture retains required facts with lower eager input and prompt bytes', (t) => {
  const repoRoot = materialize(t);
  const manifest = buildImplementerManifest({
    ...base, repoRoot, task: 1,
    briefPath: '.formula/work/tasks/context-efficient/task-1-brief.md',
    standardPath: scriptsContext,
    planPath: '.formula/work/plans/context-efficient.md',
  });
  const eagerText = manifest.required.map(({ path }) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
  const baselineText = fixture.baselineEager.map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
  const prompt = manifestReferencePrompt({
    phase: 'implement',
    manifestPath: '.formula/work/tasks/context-efficient/context/task-1-implement.json',
    skill: 'steepy-formula:implement',
    runId: base.runId,
    attempt: 1,
  });

  for (const fact of ['Surface: scripts', 'Test command: npm test', 'Criteria: SC3, SC5', 'Node built-ins only']) {
    assert.ok(eagerText.includes(fact), `required fact remains reachable: ${fact}`);
  }
  assert.ok(!eagerText.includes('UNRELATED_CONTEXT_SENTINEL_7B1D9E'));
  assert.ok(!eagerText.includes('This other task report must not be eager'));
  assert.ok(Buffer.byteLength(eagerText) < Buffer.byteLength(baselineText));
  assert.ok(Buffer.byteLength(prompt) < Buffer.byteLength(baselineText));
  assert.ok(!JSON.stringify(manifest).includes('UNRELATED_CONTEXT_SENTINEL_7B1D9E'));
});

test('a plan task id stops at the id, whatever separator the heading uses next', () => {
  for (const heading of ['## Task 1 — dash', '## Task 1: colon', '## Task 1', '## Task 1) paren', '## Task 1. dot']) {
    const plan = `# Plan\n\n${heading}\n\n- **Surface:** \`scripts\`\n- **Complexity:** \`integration\`\n- **Dependencies:** none\n- **Success criteria:** SC1\n`;
    assert.deepEqual(
      planPhaseContext(plan).tasks.map(({ task }) => task), ['1'],
      `${heading} must bind to task id 1, not to its punctuation`,
    );
  }
});

test('nested Task prose does not create or split canonical plan tasks', () => {
  const plan = '# Plan\n\n## Task 1 — outer\n\n- **Surface:** `scripts`\n- **Complexity:** `integration`\n- **Dependencies:** none\n- **Success criteria:** SC1\n\n### Task 99 — nested prose\n\n- **Complexity:** design\n- **Success criteria:** SC99\n\n## Task 2 — next\n\n- **Surface:** `adapters`\n- **Complexity:** `mechanical`\n- **Dependencies:** none\n- **Success criteria:** SC2\n';
  assert.deepEqual(planPhaseContext(plan).tasks.map(({ task, complexity }) => [task, complexity]), [
    ['1', 'integration'], ['2', 'mechanical'],
  ]);
});

test('phase prompts shrink independently while required-input bytes obey the workflow-total SC5 contract', (t) => {
  const repoRoot = materialize(t);
  const manifests = {
    plan: buildPlanManifest({
      ...base, repoRoot,
      specPath: '.formula/work/specs/context-efficient.md',
      contextPath,
      owningSurface: 'scripts', crossCuttingSurfaces: ['adapters'],
    }),
    implement: buildImplementManifest({
      ...base, repoRoot,
      planPath: '.formula/work/plans/context-efficient.md',
      ledgerPath: '.formula/work/tasks/context-efficient/ledger.md',
      specPath: '.formula/work/specs/context-efficient.md',
      contextPath,
      tasks: [{ owningSurface: 'scripts' }, { owningSurface: 'adapters' }],
    }),
    review: buildReviewManifest({
      ...base, repoRoot,
      criteriaPath: '.formula/work/tasks/context-efficient/success-criteria.md',
      taskResultIndexPath: '.formula/work/tasks/context-efficient/task-result-index.md',
      branchDiffPath: '.formula/work/tasks/context-efficient/branch-diff.txt',
      contextPath,
      tasks: [{ owningSurface: 'scripts' }, { owningSurface: 'adapters' }],
    }),
  };
  const requiredFacts = {
    plan: ['Owning surface: scripts', 'Run npm test', 'Node built-ins only'],
    implement: ['## Task 1', 'Surface: scripts', 'Criteria: SC3, SC5'],
    review: ['SC3: role inventories retain required facts', '- Task 2: DONE_WITH_CONCERNS', '+export const routed = true', 'Keep provider details adapter-local'],
  };
  let currentWorkflowRequiredBytes = 0;
  let baselineWorkflowRequiredBytes = 0;
  for (const [phase, manifest] of Object.entries(manifests)) {
    const eager = manifest.required.map(({ path }) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
    const generatedPrompt = phasePrompt(phase, '/repo/.formula/work/specs/context-efficient.md', {
      runId: base.runId,
      attempt: 1,
      manifestPath: `.formula/work/tasks/context-efficient/context/phase-${phase}-attempt-1.json`,
    });
    const baseline = fixture.baselinePhases[phase];
    const currentRequiredBytes = manifest.required.reduce((total, { bytes }) => total + bytes, 0);
    const baselineRequiredBytes = baseline.eager
      .reduce((total, path) => total + statSync(join(repoRoot, path)).size, 0);
    assert.ok(Buffer.byteLength(generatedPrompt) < Buffer.byteLength(baseline.prompt),
      `${phase} generated prompt bytes must strictly shrink independently of required inputs`);
    if (phase === 'plan') {
      assert.equal(currentRequiredBytes, baselineRequiredBytes,
        'plan required bytes do not grow: approved spec + the resolved context equal baseline');
    } else {
      assert.ok(currentRequiredBytes < baselineRequiredBytes,
        `${phase} required-input bytes must strictly shrink against its matching honest baseline inventory`);
    }
    currentWorkflowRequiredBytes += currentRequiredBytes;
    baselineWorkflowRequiredBytes += baselineRequiredBytes;
    for (const fact of requiredFacts[phase]) assert.ok(eager.includes(fact), `${phase} eagerly retains ${fact}`);
    assert.doesNotMatch(eager, /UNRELATED_CONTEXT_SENTINEL_7B1D9E/);
  }
  assert.ok(currentWorkflowRequiredBytes < baselineWorkflowRequiredBytes,
    'SC5 total required-input bytes means the representative three-phase workflow total, which must strictly shrink');
  assert.deepEqual(manifests.implement.required.map(({ path }) => path), [
    '.formula/work/plans/context-efficient.md',
  ]);
});

test('the plan verifier runs planPhaseContext and rejects options outside its role', (t) => {
  const repoRoot = materialize(t);
  const planPath = '.formula/work/plans/verify-plan.md';
  const run = (extra = []) => spawnSync(process.execPath, [scriptPath,
    '--verify-plan', '--repo-root', repoRoot, '--plan', planPath, ...extra,
  ], { encoding: 'utf8' });

  writeFileSync(join(repoRoot, planPath), '# Plan\n\n### Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Success criteria:** SC1\n');
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /plan rejected:.*no Task headings/i);

  writeFileSync(join(repoRoot, planPath), '# Plan\n\n## Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Dependencies:** none\n- **Success criteria:** SC1\n');
  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /plan OK — 1 task\(s\): 1/);

  for (const [invalidPlan, reason] of [
    ['# Plan\n\n## Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Dependencies:** none\n- **Success criteria:** SC1\n\n## Task 1\n\n- **Surface:** adapters\n- **Complexity:** mechanical\n- **Dependencies:** none\n- **Success criteria:** SC2\n', /duplicate plan task id '1'/i],
    ['# Plan\n\n## Task 2\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Dependencies:** none\n- **Success criteria:** SC1\n\n## Task 1\n\n- **Surface:** adapters\n- **Complexity:** mechanical\n- **Dependencies:** none\n- **Success criteria:** SC2\n', /strictly increasing/i],
    ['# Plan\n\n## Task 9007199254740992\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Dependencies:** none\n- **Success criteria:** SC1\n', /safe integer/i],
    ...['## Task 0', '## Task 02', '## Task -1', '## Task x', '## Task 1a'].map((heading) => [
      `# Plan\n\n## Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Dependencies:** none\n- **Success criteria:** SC1\n\n${heading}\n\n- **Surface:** adapters\n- **Complexity:** mechanical\n- **Dependencies:** none\n- **Success criteria:** SC2\n`,
      /invalid H2 Task heading|positive safe integer/i,
    ]),
  ]) {
    writeFileSync(join(repoRoot, planPath), invalidPlan);
    const invalid = run();
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, reason);
  }

  for (const extra of [['--test-command', 'npm test'], ['--role', 'implementer'], ['--task-result-index', 'x.md']]) {
    const misused = run(extra);
    assert.equal(misused.status, 2, `${extra[0]} must be rejected by verify-plan`);
    assert.match(misused.stderr, /--verify-plan --repo-root/);
  }
});

test('the plan verifier surfaces non-canonical success-criteria bytes as a fixable refusal', (t) => {
  const repoRoot = materialize(t);
  const planPath = '.formula/work/plans/sc-grammar.md';
  writeFileSync(
    join(repoRoot, planPath),
    '# Plan\n\n## Task 1\n\n- **Surface:** scripts\n- **Complexity:** integration\n- **Dependencies:** none\n- **Success criteria:** SC01\n',
  );
  const rejected = spawnSync(process.execPath, [scriptPath,
    '--verify-plan', '--repo-root', repoRoot, '--plan', planPath,
  ], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /plan rejected:.*'SC01'.*no leading zeros/i);
});

test('manifest reference validates and derives its one invocation from the skill argument', () => {
  const input = {
    phase: 'plan',
    manifestPath: '.formula/work/tasks/topic/context/phase-plan-attempt-1.json',
    skill: 'steepy-formula:plan',
    runId: base.runId,
    attempt: 1,
  };
  assert.match(manifestReferencePrompt(input), /steepy-formula 'plan' skill/);
  assert.throws(
    () => manifestReferencePrompt({ ...input, skill: 'steepy-formula:review' }),
    /skill.*plan/i,
  );
});

test('the handoff verifier runs the review-phase parse where implement can still fix it', (t) => {
  const repoRoot = materialize(t);
  const planPath = '.formula/work/plans/handoff.md';
  const indexPath = '.formula/work/tasks/context-efficient/task-result-index.md';
  writeFileSync(
    join(repoRoot, planPath),
    '# Plan\n\n## Task 1: colon heading\n\n- **Surface:** `scripts`\n- **Complexity:** `integration`\n- **Dependencies:** none\n- **Success criteria:** SC3\n',
  );
  const verify = (index) => {
    writeFileSync(join(repoRoot, indexPath), index);
    return spawnSync(process.execPath, [scriptPath,
      '--verify-handoff', '--repo-root', repoRoot,
      '--plan', planPath, '--task-result-index', indexPath,
    ], { encoding: 'utf8' });
  };

  const accepted = verify('# Results\n\n- Task 1: DONE; artifact: .formula/work/tasks/context-efficient/task-1-report.md; changed-paths: none; signals: tdd:red-green\n');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /handoff OK — 1 reviewed task\(s\): 1/);

  for (const [index, reason] of [
    ['# Results\n\n  * Task 1: DONE; artifact: a.md; changed-paths: none; signals: none\n', /malformed reviewed task entry/],
    ['# Results\n\n- Task 1: DONE\n', /malformed reviewed task entry/],
    ['# Results\n\n- Task 9: DONE; artifact: a.md; changed-paths: none; signals: none\n', /unknown reviewed task id '9'/],
    ['# Results\n\nno bullets at all\n', /no reviewed task entries/],
  ]) {
    const rejected = verify(index);
    assert.equal(rejected.status, 1, index);
    assert.match(rejected.stderr, /handoff rejected/);
    assert.match(rejected.stderr, reason);
  }

  const misused = spawnSync(process.execPath, [scriptPath,
    '--verify-handoff', '--repo-root', repoRoot,
    '--plan', planPath, '--task-result-index', indexPath, '--role', 'implementer',
  ], { encoding: 'utf8' });
  assert.equal(misused.status, 2, 'the verifier takes only its own three inputs');
  assert.match(misused.stderr, /--verify-handoff --repo-root/);

  const testCommandMisuse = spawnSync(process.execPath, [scriptPath,
    '--verify-handoff', '--repo-root', repoRoot,
    '--plan', planPath, '--task-result-index', indexPath, '--test-command', 'npm test',
  ], { encoding: 'utf8' });
  assert.equal(testCommandMisuse.status, 2, 'handoff verification rejects task-role metadata');
});

test('task-role CLI uses strict role-specific named paths and writes a valid manifest', (t) => {
  const repoRoot = materialize(t);
  const output = '.formula/work/tasks/context-efficient/context/task-1-review.json';
  const result = spawnSync(process.execPath, [scriptPath,
    '--repo-root', repoRoot,
    '--role', 'task-reviewer',
    '--run-id', base.runId,
    '--task', '1',
    '--model-tier', 'standard',
    '--test-command', 'npm test',
    '--criterion', 'SC3',
    '--brief', '.formula/work/tasks/context-efficient/task-1-brief.md',
    '--report', '.formula/work/tasks/context-efficient/task-1-report.md',
    '--task-diff', '.formula/work/tasks/context-efficient/task-1.diff',
    '--standard', scriptsContext,
    '--hub-index', contextPath,
    '--output', output,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(repoRoot, output), 'utf8'));
  assert.equal(manifest.scope.role, 'task-reviewer');
  assert.deepEqual(manifest.criterionIds, ['SC3']);

  const pluralOutput = '.formula/work/tasks/context-efficient/context/task-1-implement-2.json';
  const plural = spawnSync(process.execPath, [scriptPath,
    '--repo-root', repoRoot, '--role', 'implementer', '--run-id', base.runId,
    '--task', '1', '--model-tier', 'standard', '--brief', '.formula/work/tasks/context-efficient/task-1-brief.md',
    '--standard', scriptsContext, '--standard', adaptersContext,
    '--output', pluralOutput,
  ], { encoding: 'utf8' });
  assert.equal(plural.status, 0, plural.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(repoRoot, pluralOutput), 'utf8')).required.slice(1).map(({ path }) => path), [
    scriptsContext, adaptersContext,
  ]);
  const duplicate = spawnSync(process.execPath, [scriptPath,
    '--repo-root', repoRoot, '--role', 'implementer', '--run-id', base.runId,
    '--task', '1', '--model-tier', 'standard', '--brief', '.formula/work/tasks/context-efficient/task-1-brief.md',
    '--standard', scriptsContext, '--standard', scriptsContext,
    '--output', pluralOutput,
  ], { encoding: 'utf8' });
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /duplicate standard path/i);

  const rejected = spawnSync(process.execPath, [scriptPath, '--role', 'implementer', '--prompt', 'unconstrained'], { encoding: 'utf8' });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /Unknown option.*prompt|unknown option.*prompt/i);

  const missingFinalStandard = spawnSync(process.execPath, [scriptPath,
    '--repo-root', repoRoot,
    '--role', 'final-review',
    '--run-id', base.runId,
    '--model-tier', 'standard',
    '--criteria', '.formula/work/tasks/context-efficient/success-criteria.md',
    '--task-result-index', '.formula/work/tasks/context-efficient/task-result-index.md',
    '--branch-diff', '.formula/work/tasks/context-efficient/branch-diff.txt',
    '--output', '.formula/work/tasks/context-efficient/context/final-review.json',
  ], { encoding: 'utf8' });
  assert.equal(missingFinalStandard.status, 1);
  assert.match(missingFinalStandard.stderr, /final-review requires at least one relevant standard/);
});

test('task-role CLI accepts only protocol 2', (t) => {
  const repoRoot = materialize(t);
  const output = '.formula/work/tasks/context-efficient/context/task-1-implement.json';
  const run = (protocol) => spawnSync(process.execPath, [scriptPath,
    '--repo-root', repoRoot, '--role', 'implementer', '--run-id', base.runId,
    '--task', '1', '--model-tier', 'standard', '--brief', '.formula/work/tasks/context-efficient/task-1-brief.md',
    '--standard', scriptsContext, '--task-result-protocol', protocol,
    '--output', output,
  ], { encoding: 'utf8' });
  const refused = run('1');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--task-result-protocol must be 2/);
  assert.equal(existsSync(join(repoRoot, output)), false, 'a refused protocol must not write a manifest');
  const accepted = run('2');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(readFileSync(join(repoRoot, output), 'utf8')).contract.taskResultProtocol, 2);
});

test('the CLI refuses unclassifiable manifest names and non-canonical criteria paths as real subprocesses', (t) => {
  const repoRoot = materialize(t);
  const unclassified = spawnSync(process.execPath, [scriptPath,
    '--repo-root', repoRoot, '--role', 'implementer', '--run-id', base.runId,
    '--task', '1', '--model-tier', 'standard',
    '--brief', '.formula/work/tasks/context-efficient/task-1-brief.md',
    '--standard', scriptsContext,
    '--output', '.formula/work/tasks/refused-run/context/first.json',
  ], { encoding: 'utf8' });
  assert.equal(unclassified.status, 1);
  assert.equal(unclassified.stdout, '');
  assert.match(unclassified.stderr, /unrecognized work artifact/u);
  assert.equal(
    existsSync(join(repoRoot, '.formula/work/tasks/refused-run')),
    false,
    'a refused manifest name must not create the run or context directory',
  );

  const aliasedCriteria = spawnSync(process.execPath, [scriptPath,
    '--repo-root', repoRoot, '--role', 'final-review', '--run-id', base.runId,
    '--model-tier', 'standard',
    '--criteria', './.formula/work/tasks/context-efficient/success-criteria.md',
    '--task-result-index', '.formula/work/tasks/context-efficient/task-result-index.md',
    '--branch-diff', '.formula/work/tasks/context-efficient/branch-diff.txt',
    '--standard', scriptsContext,
    '--output', '.formula/work/tasks/refused-run/context/final-review.json',
  ], { encoding: 'utf8' });
  assert.equal(aliasedCriteria.status, 1);
  assert.equal(aliasedCriteria.stdout, '');
  assert.match(aliasedCriteria.stderr, /criteria-only artifact/u);
  assert.equal(
    existsSync(join(repoRoot, '.formula/work/tasks/refused-run')),
    false,
    'a refused criteria path must not create the run or context directory',
  );
});

test('every CLI mode refuses a migrate-state repository with exit 25 before any stdout line or write', (t) => {
  const repoRoot = materialize(t);
  mkdirSync(join(repoRoot, '.apex'));
  writeFileSync(join(repoRoot, '.apex', '_INDEX.md'), '# Markdown Hub\n');
  const snapshot = () => readdirSync(repoRoot, { recursive: true }).sort().map((entry) => {
    const absolute = join(repoRoot, entry);
    return [entry, statSync(absolute).isFile() ? readFileSync(absolute, 'utf8') : 'dir'];
  });
  const before = snapshot();
  const plan = '.formula/work/plans/context-efficient.md';
  const output = '.formula/work/tasks/context-efficient/context/task-1-implement.json';
  for (const [mode, args] of [
    ['--verify-plan', ['--verify-plan', '--repo-root', repoRoot, '--plan', plan]],
    ['--verify-handoff', ['--verify-handoff', '--repo-root', repoRoot, '--plan', plan,
      '--task-result-index', '.formula/work/tasks/context-efficient/task-result-index.md']],
    ['--role', ['--repo-root', repoRoot, '--role', 'implementer', '--run-id', base.runId, '--task', '1',
      '--model-tier', 'standard', '--brief', '.formula/work/tasks/context-efficient/task-1-brief.md',
      '--standard', scriptsContext, '--output', output]],
  ]) {
    const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
    assert.equal(result.status, MIGRATE_REFUSAL_EXIT, `${mode}: ${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, '', `${mode} refuses before any stdout line`);
    assert.deepEqual(result.stderr.split('\n').filter(Boolean), [`autopilot-context: ${MIGRATE_REFUSAL_MESSAGE}`], mode);
    assert.match(result.stderr, /graph-migrate/, `${mode} names the graph-migrate skill`);
  }
  assert.equal(existsSync(join(repoRoot, output)), false, 'the role mode writes no manifest');
  assert.deepEqual(snapshot(), before, 'no mode writes anything in the migrate state');
});

test('fixture repositories are removed after subtest cleanup', async (t) => {
  let repoRoot;
  await t.test('materialized fixture', (child) => {
    repoRoot = materialize(child);
    assert.equal(existsSync(repoRoot), true);
  });
  assert.equal(existsSync(repoRoot), false);
});

// --- formula criterion-5 adaptation: hub/upstream resolve through the graph resolver ---
// The seeded resolver cases need the local-only dogfood checkpoint and skip with the explicit
// DOGFOOD_CHECKPOINT_SKIP reason when it is absent.

test('resolveGraphHubContext takes the project id from explicit > repo config > the CLI chain, never a baked-in default', { skip: DOGFOOD_CHECKPOINT_SKIP }, (t) => {
  // Explicit id wins over a conflicting repo binding — an override, passed through as-is.
  const overrideRoot = materialize(t);
  writeProjectConfig(overrideRoot, 'other-proj');
  const override = resolveGraphHubContext({
    repoRoot: overrideRoot,
    outputPath: '.formula/work/tasks/context-efficient/context/hub-context-override',
    projectId: 'steepy-formula',
    args: ['--path', '.', '--port', 'memory', '--seed', DOGFOOD_CHECKPOINT],
  });
  assert.equal(override.projectId, 'steepy-formula');
  assert.equal(override.contextPath, '.formula/work/tasks/context-efficient/context/hub-context-override/context.md');
  assert.equal(existsSync(join(overrideRoot, override.contextPath)), true);

  // No explicit id + a config present in the temp repo -> the spawn receives that bound id.
  // The seed only serves 'steepy-formula', so a successful resolve reporting the bound id
  // proves the config value reached the CLI (never the resolver through archived Markdown).
  const boundRoot = materialize(t);
  writeProjectConfig(boundRoot, 'steepy-formula');
  const bound = resolveGraphHubContext({
    repoRoot: boundRoot,
    outputPath: '.formula/work/tasks/context-efficient/context/hub-context-bound',
    args: ['--path', '.', '--port', 'memory', '--seed', DOGFOOD_CHECKPOINT],
  });
  assert.equal(bound.projectId, 'steepy-formula');
  assert.equal(bound.contextPath, '.formula/work/tasks/context-efficient/context/hub-context-bound/context.md');
  assert.equal(existsSync(join(boundRoot, bound.contextPath)), true);
  assert.ok(bound.bytes > 0, 'the resolver context artifact must be non-empty');
  const text = readFileSync(join(boundRoot, bound.contextPath), 'utf8');
  assert.match(text, /steepy-formula/, 'the resolver artifact serves the canonical graph');
  assert.ok(!text.includes('.apex/_INDEX.md'), 'hub context must never route through the archived Markdown hub');

  // No explicit id + a config binding a DIFFERENT project -> the BOUND id (not a lingering
  // adapter-side default) reaches the CLI: the resolver fails against this steepy-formula
  // seed naming the bound project.
  const mismatchRoot = materialize(t);
  writeProjectConfig(mismatchRoot, 'other-proj');
  assert.throws(
    () => resolveGraphHubContext({
      repoRoot: mismatchRoot,
      outputPath: '.formula/work/tasks/context-efficient/context/hub-context-mismatch',
      args: ['--path', '.', '--port', 'memory', '--seed', DOGFOOD_CHECKPOINT],
    }),
    /other-proj/,
    'the config-bound id must be what the spawned CLI resolves',
  );

  // No explicit id + no config -> `--project` is omitted entirely, so the CLI's own chain
  // applies against the same repo root. 'demo' can only originate from the CLI's own
  // DEFAULT_PROJECT fallback (SC4 — no second literal default lives in this adapter), and
  // the failure echo `project: demo (fallback)` is exactly that chain, made visible.
  const bareRoot = materialize(t);
  assert.throws(
    () => resolveGraphHubContext({
      repoRoot: bareRoot,
      outputPath: '.formula/work/tasks/context-efficient/context/hub-context-bare',
      args: ['--path', '.', '--port', 'memory', '--seed', DOGFOOD_CHECKPOINT],
    }),
    /project:\s+demo \(fallback\)/,
    'no --project in the spawned args lets the CLI chain fall back to demo',
  );
});

test('the resolved context is the only path: every implicated surface binds it once and cross-cutting entries are reported', () => {
  const ignored = [];
  assert.deepEqual(
    deriveImplicatedStandardPaths({
      ownership: {
        owningSurface: 'scripts',
        // `scripts` is also the owner, so it stays strict; `adapters` and the prose are advisory.
        crossCuttingSurfaces: ['scripts', 'adapters', 'stable hub docs'],
        tasks: [{ surface: 'scripts' }, { owningSurface: 'templates' }],
      },
      contextPath,
      onUnroutedSurface: (surface) => ignored.push(surface),
    }),
    [contextPath],
    'any number of strict surfaces binds the one resolved context exactly once',
  );
  assert.deepEqual(ignored, ['adapters', 'stable hub docs'], 'each skipped cross-cutting entry is reported once, in order');

  assert.deepEqual(
    deriveImplicatedStandardPaths({ ownership: { crossCuttingSurfaces: ['stable hub docs'] }, contextPath }),
    [],
    'advisory-only ownership binds nothing, and the reporting callback stays optional',
  );

  for (const [badPath, reason] of [
    [undefined, /unsafe contextPath/],
    ['', /unsafe contextPath/],
    ['../escape.md', /unsafe contextPath/],
    ['/abs/context.md', /unsafe contextPath/],
  ]) {
    assert.throws(
      () => deriveImplicatedStandardPaths({ ownership: { owningSurface: 'scripts' }, contextPath: badPath }),
      reason,
      String(badPath),
    );
  }
});

test('the hub and upstream purposes name the canonical graph resolver (criterion 5)', (t) => {
  const repoRoot = materialize(t);
  const manifest = buildImplementerManifest({
    ...base,
    repoRoot,
    task: 1,
    briefPath: '.formula/work/tasks/context-efficient/task-1-brief.md',
    standardPath: scriptsContext,
    planPath: '.formula/work/plans/context-efficient.md',
    specPath: '.formula/work/specs/context-efficient.md',
    hubIndexPath: contextPath,
  });
  const hub = manifest.onDemand.find((entry) => entry.purpose.includes('graph-resolved hub context'));
  assert.ok(hub, 'the hub on-demand input must carry the graph-resolved hub purpose');
  assert.equal(hub.path, contextPath);
  const upstream = manifest.onDemand.find((entry) => entry.purpose.includes('graph resolver'));
  assert.ok(upstream, 'the upstream purpose must resolve through the graph resolver');
});

function resumeManifestInput(repoRoot, resumeInputs) {
  return {
    ...base, repoRoot, resumeInputs,
    planPath: '.formula/work/plans/context-efficient.md',
    specPath: '.formula/work/specs/context-efficient.md',
    ledgerPath: '.formula/work/tasks/context-efficient/ledger.md',
    taskResultIndexPath: '.formula/work/tasks/context-efficient/task-result-index.md',
    contextPath,
    tasks: [{ surface: 'scripts' }],
  };
}

test('explicit resume inputs add only exact on-demand references without reading bodies or listing siblings', (t) => {
  const repoRoot = materialize(t);
  const paths = [
    '.formula/work/tasks/context-efficient/task-1-brief.md',
    '.formula/work/tasks/context-efficient/task-1-report.md',
    '.formula/work/tasks/context-efficient/task-1-diff.txt',
    '.formula/work/tasks/context-efficient/context/task-1-review.json',
    '.formula/work/tasks/context-efficient/task-1-review-guard-attempt-1-iteration-1-original.json',
  ];
  for (const path of paths) {
    mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
    writeFileSync(join(repoRoot, path), 'EXPLICIT_RESUME_BODY_SENTINEL');
  }
  const ordinary = buildImplementManifest(resumeManifestInput(repoRoot));
  const originals = { readFileSync: fs.readFileSync, readdirSync: fs.readdirSync };
  const accesses = [];
  let manifest;
  try {
    for (const name of Object.keys(originals)) fs[name] = (...args) => {
      accesses.push([name, args[0]]);
      throw new Error('resume inventory must inspect metadata only');
    };
    syncBuiltinESMExports();
    manifest = buildImplementManifest(resumeManifestInput(repoRoot, paths));
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
  assert.deepEqual(accesses, []);
  assert.deepEqual(manifest.required, ordinary.required);
  assert.deepEqual(manifest.onDemand.slice(0, ordinary.onDemand.length), ordinary.onDemand);
  assert.deepEqual(manifest.onDemand.slice(ordinary.onDemand.length).map(({ path, read, available, bytes }) =>
    ({ path, read, available, bytes })), paths.map((path) =>
    ({ path, read: 'on-demand', available: true, bytes: Buffer.byteLength('EXPLICIT_RESUME_BODY_SENTINEL') })));
  assert.doesNotMatch(JSON.stringify(manifest), /EXPLICIT_RESUME_BODY_SENTINEL/);
});

test('explicit resume inputs reject aliases, globs, other runs, missing files, duplicates and base capabilities', (t) => {
  const repoRoot = materialize(t);
  const path = '.formula/work/tasks/context-efficient/task-1-brief.md';
  for (const paths of [
    null, path, [path, path], [path.replace('task-1', '*')],
    [path.replace('context-efficient/', 'another-run/')],
    [path.replace('/task-1', '/../task-1')], [path.replace('/task-1', '/./task-1')],
    [path.replace('/task-1', '//task-1')], [path + '/'], [join(repoRoot, path)],
    [path.replace('task-1', 'task-999')],
    ['.formula/work/tasks/context-efficient/ledger.md'],
    ['.formula/work/tasks/context-efficient/task-result-index.md'],
  ]) assert.throws(() => buildImplementManifest(resumeManifestInput(repoRoot, paths)), undefined, JSON.stringify(paths));
});

test('explicit resume inputs reject linked ancestors, linked targets, hardlinks and directories', (t) => {
  const repoRoot = materialize(t);
  const path = '.formula/work/tasks/context-efficient/task-999-report.md';
  const outside = join(repoRoot, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel.md'), 'private');
  const target = join(repoRoot, path);
  for (const kind of ['symlink', 'hardlink', 'directory']) {
    if (kind === 'symlink') symlinkSync(join(outside, 'sentinel.md'), target);
    if (kind === 'hardlink') linkSync(join(outside, 'sentinel.md'), target);
    if (kind === 'directory') mkdirSync(target);
    assert.throws(() => buildImplementManifest(resumeManifestInput(repoRoot, [path])), /symlink|hard.link|ordinary|non-file/);
    rmSync(target, { recursive: true });
  }
  const nested = '.formula/work/tasks/context-efficient/linked';
  symlinkSync(outside, join(repoRoot, nested));
  assert.throws(() => buildImplementManifest(resumeManifestInput(repoRoot, [nested + '/sentinel.md'])), /symlink/);
  assert.equal(readFileSync(join(outside, 'sentinel.md'), 'utf8'), 'private');
});

test('explicit resume inputs reject physical duplicates and base aliases independent of path spelling', (t) => {
  const repoRoot = materialize(t);
  const prefix = '.formula/work/tasks/context-efficient/';
  const original = fs.lstatSync;
  for (const name of ['ledger.md', 'task-result-index.md', 'task-1-report.md']) {
    const path = prefix + name;
    const alias = prefix + 'alias-' + name;
    writeFileSync(join(repoRoot, path), 'existing evidence');
    writeFileSync(join(repoRoot, alias), 'existing evidence');
    const target = join(fs.realpathSync(repoRoot), path);
    const aliasTarget = join(fs.realpathSync(repoRoot), alias);
    // Model a filesystem alias with a single-link target on every CI platform.
    fs.lstatSync = (candidate, ...args) => original(candidate === aliasTarget ? target : candidate, ...args);
    syncBuiltinESMExports();
    try {
      const variants = name === 'task-1-report.md' ? [[path, alias], [alias, path]] : [[alias]];
      for (const paths of variants) {
        assert.throws(() => buildImplementManifest(resumeManifestInput(repoRoot, paths)),
          /duplicate or already inventoried resume input/, JSON.stringify(paths));
      }
    } finally {
      fs.lstatSync = original;
      syncBuiltinESMExports();
    }
  }
});

test('explicit resume inputs distinguish native case aliases from physically distinct case variants', (t) => {
  const repoRoot = materialize(t);
  const prefix = '.formula/work/tasks/context-efficient/';
  for (const name of ['ledger.md', 'task-result-index.md', 'task-1-report.md']) {
    const path = prefix + name;
    const alias = prefix + name.toUpperCase();
    writeFileSync(join(repoRoot, path), 'existing evidence');
    const isAlias = existsSync(join(repoRoot, alias));
    if (!isAlias) writeFileSync(join(repoRoot, alias), 'distinct evidence');
    const paths = name === 'task-1-report.md' ? [path, alias] : [alias];
    if (isAlias) {
      assert.throws(() => buildImplementManifest(resumeManifestInput(repoRoot, paths)),
        /duplicate or already inventoried resume input/, name);
    } else {
      const manifest = buildImplementManifest(resumeManifestInput(repoRoot, paths));
      assert.deepEqual(manifest.onDemand.slice(-paths.length).map(({ path }) => path), paths);
    }
  }
});
