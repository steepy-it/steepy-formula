import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EVIDENCE_ARTIFACT_PATH,
  EVIDENCE_RECORD_IDS,
  REQUIRED_CAPABILITIES,
  collectNpmPackagePaths,
  computePayloadIdentity,
  validateProductState,
  validateReleaseEvidence as validateEvidence,
} from '../scripts/validate-release-evidence.mjs';

// Schema 1 is retained solely as an explicitly requested historical audit.
const validateReleaseEvidence = (evidence, options) => validateEvidence(evidence, {
  ...options, allowLegacyAudit: true,
});

const OBSERVED_AT = '2026-09-01';
const NOW = new Date('2026-09-12T12:00:00Z');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'steepy-release-evidence-'));
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, 'adapters'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeJson(join(root, 'package.json'), {
    name: 'steepy-formula', version: '1.2.3', files: ['adapters/', 'docs/'],
  });
  writeJson(join(root, '.claude-plugin', 'plugin.json'), { name: 'steepy-formula', version: '1.2.3' });
  writeJson(join(root, '.codex-plugin', 'plugin.json'), { name: 'steepy-formula', version: '1.2.3' });
  writeFileSync(join(root, 'adapters', 'index.js'), 'export const ready = true;\n');
  writeFileSync(join(root, 'CHANGELOG.md'), '## v1.2.3 (2026-09-01)\n\n- Ready.\n');
  writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), 'redacted live evidence\n');
  writeFileSync(join(root, 'docs', 'native-test-evidence.json'), '{}\n');
  writeFileSync(join(root, 'docs', 'release-audit-remediation.md'), 'closure report\n');

  git(root, ['init']);
  git(root, ['config', 'user.email', 'release-evidence@example.test']);
  git(root, ['config', 'user.name', 'Release evidence test']);
  git(root, ['add', '--all']);
  git(root, ['commit', '-m', 'source fixture']);
  const sourceRevision = git(root, ['rev-parse', 'HEAD']);

  const packagePaths = collectNpmPackagePaths(root);
  const payloadSha256 = computePayloadIdentity(root, packagePaths);
  const artifactSha256 = sha256(readFileSync(join(root, EVIDENCE_ARTIFACT_PATH)));
  const records = EVIDENCE_RECORD_IDS.map((id) => ({
    id,
    sourceRevision,
    payloadSha256,
    productVersion: '1.2.3',
    host: {
      name: id,
      version: '1.0.0',
      platform: 'darwin-arm64',
      profile: 'isolated-release-canary',
    },
    observedAt: OBSERVED_AT,
    installation: {
      method: 'native local-package install',
      composition: ['final npm payload', 'isolated host profile'],
    },
    checks: REQUIRED_CAPABILITIES[id].map((capability) => ({
      capability,
      command: `redacted canary command for ${capability}`,
      result: 'PASS',
    })),
    artifact: {
      path: EVIDENCE_ARTIFACT_PATH,
      sha256: artifactSha256,
      redacted: true,
    },
    result: 'PASS',
  }));
  const evidence = { schemaVersion: 1, records };
  writeJson(join(root, 'docs', 'native-test-evidence.json'), evidence);
  return { root, packagePaths, payloadSha256, evidence, sourceRevision };
}

function withFixture(fn) {
  const fixture = makeFixture();
  try {
    const result = fn(fixture);
    if (result && typeof result.then === 'function') {
      return result.finally(() => rmSync(fixture.root, { recursive: true, force: true }));
    }
    rmSync(fixture.root, { recursive: true, force: true });
    return result;
  } catch (error) {
    rmSync(fixture.root, { recursive: true, force: true });
    throw error;
  }
}

test('accepts strict PASS records for plugin preflight and all five native harnesses', () => {
  withFixture(({ root, packagePaths, evidence, payloadSha256, sourceRevision }) => {
    assert.deepEqual(
      validateReleaseEvidence(evidence, { root, packagePaths, now: NOW }),
      { productVersion: '1.2.3', payloadSha256, sourceRevisions: [sourceRevision] },
    );
  });
});

test('requires one reachable source revision for every evidence record', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    const nonexistent = evidence.records.map((record) => ({
      ...record,
      sourceRevision: 'a'.repeat(40),
    }));
    assert.throws(
      () => validateReleaseEvidence({ schemaVersion: 1, records: nonexistent }, { root, packagePaths, now: NOW }),
      /source revision.*available|source revision.*reachable/i,
    );

    const split = [
      { ...evidence.records[0], sourceRevision: 'b'.repeat(40) },
      ...evidence.records.slice(1),
    ];
    assert.throws(
      () => validateReleaseEvidence({ schemaVersion: 1, records: split }, { root, packagePaths, now: NOW }),
      /source revisions must all match/,
    );
  });
});

test('requires current product bytes, modes, and paths to match the reachable source', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    const evidenceFor = (paths) => {
      const payloadSha256 = computePayloadIdentity(root, paths);
      return {
        schemaVersion: 1,
        records: evidence.records.map((record) => ({ ...record, payloadSha256 })),
      };
    };
    const expectSourceMismatch = (paths) => assert.throws(
      () => validateReleaseEvidence(evidenceFor(paths), { root, packagePaths: paths, now: NOW }),
      /source product identity mismatch/,
    );

    writeFileSync(join(root, 'adapters', 'index.js'), 'export const ready = false;\n');
    expectSourceMismatch(packagePaths);

    writeFileSync(join(root, 'adapters', 'index.js'), 'export const ready = true;\n');
    chmodSync(join(root, 'adapters', 'index.js'), 0o755);
    expectSourceMismatch(packagePaths);

    chmodSync(join(root, 'adapters', 'index.js'), 0o644);
    writeFileSync(join(root, 'docs', 'new-shipped-documentation.md'), 'new product input\n');
    expectSourceMismatch(collectNpmPackagePaths(root));
  });
});

test('rejects a source-only shipped file even when export-ignore hides it from archives', () => {
  withFixture(({ root, evidence, sourceRevision }) => {
    writeFileSync(join(root, 'adapters', 'removed.js'), 'export const removed = true;\n');
    writeFileSync(join(root, '.gitattributes'), 'adapters/removed.js export-ignore\n');
    git(root, ['add', '--all']);
    git(root, ['commit', '-m', 'source includes removed product input']);
    const source = git(root, ['rev-parse', 'HEAD']);

    rmSync(join(root, 'adapters', 'removed.js'));
    git(root, ['add', '--all']);
    git(root, ['commit', '-m', 'current removes product input']);
    const packagePaths = collectNpmPackagePaths(root);
    const payloadSha256 = computePayloadIdentity(root, packagePaths);
    const records = evidence.records.map((record) => ({ ...record, sourceRevision: source, payloadSha256 }));

    assert.notEqual(source, sourceRevision);
    assert.throws(
      () => validateReleaseEvidence({ schemaVersion: 1, records }, { root, packagePaths, now: NOW }),
      /source product identity mismatch/,
    );
  });
});

test('uses unchanged committed bytes when export-subst metadata is present', () => {
  withFixture(({ root, evidence }) => {
    writeFileSync(join(root, 'adapters', 'index.js'), 'export const revision = "$Format:%H$";\n');
    writeFileSync(join(root, '.gitattributes'), 'adapters/index.js export-subst\n');
    git(root, ['add', '--all']);
    git(root, ['commit', '-m', 'source with literal export substitution marker']);
    const sourceRevision = git(root, ['rev-parse', 'HEAD']);

    writeFileSync(join(root, 'docs', 'release-audit-remediation.md'), 'evidence-only follow-up\n');
    git(root, ['add', '--all']);
    git(root, ['commit', '-m', 'evidence-only follow-up']);
    const packagePaths = collectNpmPackagePaths(root);
    const payloadSha256 = computePayloadIdentity(root, packagePaths);
    const records = evidence.records.map((record) => ({ ...record, sourceRevision, payloadSha256 }));

    assert.doesNotThrow(
      () => validateReleaseEvidence({ schemaVersion: 1, records }, { root, packagePaths, now: NOW }),
    );
  });
});

test('accepts a reachable source when only an exact evidence-only artifact changed', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    writeFileSync(join(root, 'docs', 'release-audit-remediation.md'), 'final closure report\n');
    assert.doesNotThrow(
      () => validateReleaseEvidence(evidence, { root, packagePaths, now: NOW }),
    );
  });
});

test('payload identity changes for any shipped path, bytes, or mode', () => {
  withFixture(({ root, packagePaths, payloadSha256 }) => {
    writeFileSync(join(root, 'adapters', 'index.js'), 'export const ready = false;\n');
    assert.notEqual(computePayloadIdentity(root, packagePaths), payloadSha256);

    writeFileSync(join(root, 'adapters', 'index.js'), 'export const ready = true;\n');
    chmodSync(join(root, 'adapters', 'index.js'), 0o755);
    assert.notEqual(computePayloadIdentity(root, packagePaths), payloadSha256);

    writeFileSync(join(root, 'docs', 'other.md'), 'shipped\n');
    assert.notEqual(computePayloadIdentity(root, [...packagePaths, 'docs/other.md']), payloadSha256);
  });
});

test('payload identity excludes only the three declared evidence-only artifacts', () => {
  withFixture(({ root, packagePaths, payloadSha256 }) => {
    writeFileSync(join(root, 'docs', 'native-test-evidence.json'), '{"new":"record"}\n');
    writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), 'replacement redacted evidence\n');
    writeFileSync(join(root, 'docs', 'release-audit-remediation.md'), 'replacement closure report\n');
    assert.equal(computePayloadIdentity(root, packagePaths), payloadSha256);

    writeFileSync(join(root, 'docs', 'native-test-evidence-copy.md'), 'not excluded\n');
    assert.notEqual(
      computePayloadIdentity(root, [...packagePaths, 'docs/native-test-evidence-copy.md']),
      payloadSha256,
    );

    writeFileSync(join(root, 'docs', 'release-audit-remediation-copy.md'), 'not excluded\n');
    assert.notEqual(
      computePayloadIdentity(root, [...packagePaths, 'docs/release-audit-remediation-copy.md']),
      payloadSha256,
    );

    writeFileSync(join(root, 'docs', 'other-shipped-documentation.md'), 'not excluded\n');
    assert.notEqual(
      computePayloadIdentity(root, [...packagePaths, 'docs/other-shipped-documentation.md']),
      payloadSha256,
    );
  });
});

test('rejects missing, duplicate, unknown, failed, skipped, or pending records', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    const invalidCases = [
      [evidence.records.slice(1), /missing evidence record/],
      [[...evidence.records, evidence.records[0]], /duplicate evidence record/],
      [[...evidence.records, { ...evidence.records[0], id: 'other' }], /unknown evidence record/],
      [evidence.records.map((record, index) => index ? record : { ...record, result: 'FAIL' }), /must be PASS/],
      [evidence.records.map((record, index) => index ? record : { ...record, result: 'SKIPPED' }), /must be PASS/],
      [evidence.records.map((record, index) => index ? record : { ...record, result: 'PENDING' }), /must be PASS/],
    ];
    for (const [records, expected] of invalidCases) {
      assert.throws(
        () => validateReleaseEvidence({ schemaVersion: 1, records }, { root, packagePaths, now: NOW }),
        expected,
      );
    }
  });
});

test('rejects stale/future evidence, mismatched payload/source/version, and incomplete checks', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    const replaceFirst = (change) => [
      { ...evidence.records[0], ...change },
      ...evidence.records.slice(1),
    ];
    for (const [change, expected] of [
      [{ observedAt: '2026-07-01' }, /stale/],
      [{ observedAt: '2026-09-13' }, /future/],
      [{ payloadSha256: 'b'.repeat(64) }, /payload identity mismatch/],
      [{ productVersion: '1.2.2' }, /product version mismatch/],
      [{ sourceRevision: 'not-a-commit' }, /source revision/],
      [{ checks: evidence.records[0].checks.slice(1) }, /missing capability/],
    ]) {
      assert.throws(
        () => validateReleaseEvidence(
          { schemaVersion: 1, records: replaceFirst(change) },
          { root, packagePaths, now: NOW },
        ),
        expected,
      );
    }
  });
});

test('requires native Codex dispatch and capability-specific Pi/DeepSeek checks', () => {
  assert.ok(REQUIRED_CAPABILITIES.codex.includes('native-specialist-dispatch'));
  assert.deepEqual(REQUIRED_CAPABILITIES.pi, [
    'package-extension-load', 'skill-invocation', 'session-transitions',
  ]);
  assert.deepEqual(REQUIRED_CAPABILITIES['deepseek-harness'], [
    'plugin-load', 'commands', 'model-callable-skill-tool', 'bootstrap-lifecycle',
  ]);
});

test('rejects unredacted, missing, or digest-mismatched evidence artifacts', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    const first = evidence.records[0];
    for (const [artifact, expected] of [
      [{ ...first.artifact, redacted: false }, /must be redacted/],
      [{ ...first.artifact, path: 'docs/missing.md' }, /artifact path/],
      [{ ...first.artifact, sha256: 'b'.repeat(64) }, /artifact digest mismatch/],
    ]) {
      const records = [{ ...first, artifact }, ...evidence.records.slice(1)];
      assert.throws(
        () => validateReleaseEvidence({ schemaVersion: 1, records }, { root, packagePaths, now: NOW }),
        expected,
      );
    }
  });
});

test('rejects an empty evidence artifact even when its digest matches', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), '');
    const artifact = { ...evidence.records[0].artifact, sha256: sha256(Buffer.alloc(0)) };
    const records = evidence.records.map((record) => ({ ...record, artifact }));
    assert.throws(
      () => validateReleaseEvidence({ schemaVersion: 1, records }, { root, packagePaths, now: NOW }),
      /artifact must not be empty/,
    );
  });
});

test('schema is closed and rejects unredacted supported credential forms in commands and artifacts', () => {
  withFixture(({ root, packagePaths, evidence }) => {
    assert.throws(
      () => validateReleaseEvidence(
        { schemaVersion: 1, records: [{ ...evidence.records[0], extra: true }, ...evidence.records.slice(1)] },
        { root, packagePaths, now: NOW },
      ),
      /unknown field/,
    );
    for (const command of [
      'DEEPSEEK_API_KEY=unredacted-value command',
      'curl -H "Authorization: Bearer unredacted-value"',
      'tool --token unredacted-value',
      'curl -H "Cookie: session=unredacted-value"',
      'curl -H "X-Api-Key: unredacted-value"',
    ]) {
      const checks = evidence.records[0].checks.map((check, index) => (
        index ? check : { ...check, command }
      ));
      assert.throws(
        () => validateReleaseEvidence(
          { schemaVersion: 1, records: [{ ...evidence.records[0], checks }, ...evidence.records.slice(1)] },
          { root, packagePaths, now: NOW },
        ),
        /credential-like/,
      );
    }

    writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), 'Authorization: Bearer unredacted-value\n');
    const artifact = { ...evidence.records[0].artifact, sha256: sha256(readFileSync(join(root, EVIDENCE_ARTIFACT_PATH))) };
    const records = evidence.records.map((record) => ({ ...record, artifact }));
    assert.throws(
      () => validateReleaseEvidence({ schemaVersion: 1, records }, { root, packagePaths, now: NOW }),
      /credential-like/,
    );

    writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), 'Authorization: Bearer <redacted>\nCookie: session=[redacted]\nX-Api-Key: REDACTED\n');
    const redactedArtifact = {
      ...artifact,
      sha256: sha256(readFileSync(join(root, EVIDENCE_ARTIFACT_PATH))),
    };
    for (const command of [
      'DEEPSEEK_API_KEY=<redacted> command',
      'curl -H "Authorization: Bearer <redacted>"',
      'tool --token=[redacted]',
      'curl -H "Cookie: session=[redacted]"',
      'curl -H "X-Api-Key: REDACTED"',
    ]) {
      const checks = evidence.records[0].checks.map((check, index) => (
        index ? check : { ...check, command }
      ));
      const redactedRecords = [
        { ...evidence.records[0], checks, artifact: redactedArtifact },
        ...evidence.records.slice(1).map((record) => ({ ...record, artifact: redactedArtifact })),
      ];
      assert.doesNotThrow(
        () => validateReleaseEvidence({ schemaVersion: 1, records: redactedRecords }, { root, packagePaths, now: NOW }),
      );
    }
  });
});

test('product validation rejects malformed, divergent, or incomplete bump state', () => {
  withFixture(({ root, packagePaths }) => {
    assert.equal(validateProductState(root, packagePaths).productVersion, '1.2.3');

    writeJson(join(root, '.codex-plugin', 'plugin.json'), { name: 'steepy-formula', version: '1.2.2' });
    assert.throws(() => validateProductState(root, packagePaths), /incomplete bump/);
    writeJson(join(root, '.codex-plugin', 'plugin.json'), { name: 'steepy-formula', version: '1.2.3' });

    writeFileSync(join(root, '.steepy-version-transaction.json'), '{}\n');
    assert.throws(() => validateProductState(root, packagePaths), /incomplete bump/);
    rmSync(join(root, '.steepy-version-transaction.json'));

    writeFileSync(join(root, 'CHANGELOG.md'), '## v1.2.2 (2026-08-01)\n');
    assert.throws(() => validateProductState(root, packagePaths), /CHANGELOG/);
  });
});

// Synthetic validation inputs only: these are never native acceptance observations.
const LAUNCH_ROWS = ['candidate-preflight', 'claude-code/macos', 'claude-code/linux', 'codex/macos', 'codex/linux'];
const SKILLS = ['inception', 'init', 'check', 'new-surface', 'discovery', 'brainstorm', 'plan', 'implement', 'review', 'loop-engineer', 'graph-migrate'];
const INCEPTION_CASES = [
  'inception-a', 'inception-b',
  'reconnaissance-architecture-interruption', 'research-child-interruption',
  'approval-interruption', 'bootstrap-intent-outcome-interruption',
  'verification-capture-interruption', 'complete-closing-note-interruption',
  'required-check-fails', 'manual-confirmation-missing', 'application-fix-verification',
  'unchanged-verification-resume', 'complete-init-discovery', 'application-drift-after-complete-init',
  'final-abandon-interrupted', 'publication-before-staging', 'publication-after-staging',
  'publication-ordered-target-prefixes', 'publication-final-descriptor-replacement',
  'publication-foreign-divergent-targets', 'v1-descriptor-refusal-all-commands',
  'collector-zero-red-command', 'versioned-copy-validation',
];
const PREFLIGHT_CASES = ['manifest-version-lockstep', 'version-transaction-complete', 'npm-package-composition', 'hub-coherence'];
const NATIVE_CASES = ['clean-install-load', 'eleven-skill-discovery', 'skill-invocation', 'init-bootstrap',
  'specialist-behavior-dispatch', 'discovery-context-coherence', 'brainstorm-plan-implement-review', ...INCEPTION_CASES];

const HUMAN_GATED_CASES = ['init-bootstrap', 'discovery-context-coherence',
  'brainstorm-plan-implement-review', 'inception-a', 'inception-b',
  'approval-interruption', 'complete-init-discovery'];

function withLaunchFixture(fn) {
  return withFixture((fixture) => {
    const records = LAUNCH_ROWS.map((id) => {
      const preflight = id === 'candidate-preflight';
      const [name, os] = preflight ? ['candidate-preflight', 'linux'] : id.split('/');
      return {
        ...structuredClone(fixture.evidence.records[0]), id,
        host: { name, version: name === 'claude-code' ? '2.1.207' : name === 'codex' ? '0.144.0-alpha.4' : '24.22.1',
          platform: os, architecture: 'arm64', profile: 'isolated-release-canary' },
        installation: { method: 'native local-package install', composition: ['final npm payload', 'isolated host profile'],
          clean: true, installedReleaseDisabled: true },
        checks: (preflight ? PREFLIGHT_CASES : NATIVE_CASES).map((capability) => ({
          capability, command: `synthetic unit procedure for ${capability}`, result: 'PASS',
          observation: `synthetic unit observation for ${capability}`,
          humanApprovals: !HUMAN_GATED_CASES.includes(capability) ? [] : [{ kind: 'human', approver: 'synthetic-fixture-human', response: 'Synthetic fixture approval; validation input only' }],
          degradation: 'none',
        })),
        ...(preflight ? {} : { skills: [...SKILLS] }),
      };
    });
    const evidence = { schemaVersion: 2, records };
    return fn({ ...fixture, evidence, validate: (value = evidence) => validateEvidence(value, {
      root: fixture.root, packagePaths: fixture.packagePaths, now: NOW,
    }) });
  });
}

test('schema 2 accepts the candidate and four distinct launch host/OS rows', () => {
  withLaunchFixture(({ validate, payloadSha256, sourceRevision }) => {
    assert.deepEqual(validate(), { productVersion: '1.2.3', payloadSha256, sourceRevisions: [sourceRevision] });
  });
});

test('publication refuses legacy schema 1 unless explicitly requested as an optional audit', () => {
  withFixture(({ evidence, root, packagePaths }) => {
    assert.throws(() => validateEvidence(evidence, { root, packagePaths, now: NOW }));
    assert.doesNotThrow(() => validateEvidence(evidence, { root, packagePaths, now: NOW, allowLegacyAudit: true }));
  });
});

test('schema 2 rejects every absent row and experimental substitutions', async (t) => {
  await withLaunchFixture(async ({ evidence, validate }) => {
    for (const id of LAUNCH_ROWS) await t.test(`missing ${id}`, () => {
      assert.throws(() => validate({ ...evidence, records: evidence.records.filter((r) => r.id !== id) }));
    });
    for (const id of ['opencode', 'pi', 'deepseek-harness', 'unknown']) await t.test(`substitution ${id}`, () => {
      const copy = structuredClone(evidence); copy.records[1].id = id;
      assert.throws(() => validate(copy));
    });
    await t.test('duplicate row', () => assert.throws(() => validate({ ...evidence, records: [...evidence.records, evidence.records[1]] })));
  });
});

test('schema 2 independently requires every launch observation, including the full inception inventory', async (t) => {
  // Keep cases explicit rather than deriving expected requirements from implementation exports.
  for (const capability of NATIVE_CASES) await t.test(capability, () => withLaunchFixture(({ evidence, validate }) => {
    const copy = structuredClone(evidence);
    copy.records[1].checks = copy.records[1].checks.filter((c) => c.capability !== capability);
    assert.throws(() => validate(copy));
  }));
});

test('schema 2 rejects malformed identity, environment, lifecycle and case evidence', async (t) => {
  const mutations = {
    'unsupported schema version': (r, document) => { document.schemaVersion = 99; },
    'duplicate check': (r) => r.checks.push(r.checks[0]),
    'unknown check': (r) => { r.checks[0].capability = 'invented'; },
    'missing observation': (r) => { delete r.checks[0].observation; },
    'blank observation': (r) => { r.checks[0].observation = ''; },
    'missing procedure': (r) => { delete r.checks[0].command; },
    'unknown case key': (r) => { r.checks[0].invented = true; },
    'unknown record key': (r) => { r.invented = true; },
    'unknown host key': (r) => { r.host.invented = true; },
    'wrong platform': (r) => { r.host.platform = 'windows'; },
    'wrong host': (r) => { r.host.name = 'codex'; },
    'malformed version': (r) => { r.host.version = 'latest'; },
    'missing architecture': (r) => { delete r.host.architecture; },
    'malformed architecture': (r) => { r.host.architecture = 'invalid architecture!'; },
    'unclean installation': (r) => { r.installation.clean = false; },
    'installed release active': (r) => { r.installation.installedReleaseDisabled = false; },
    'missing skill': (r) => { r.skills.pop(); },
    'duplicate skill': (r) => { r.skills[0] = r.skills[1]; },
    'unknown skill': (r) => { r.skills[0] = 'invented'; },
    'missing approval': (r) => { r.checks.find((c) => c.capability === 'approval-interruption').humanApprovals = []; },
    'model self approval': (r) => { r.checks.find((c) => c.capability === 'approval-interruption').humanApprovals[0].kind = 'model'; },
    'missing degradation': (r) => { delete r.checks[0].degradation; },
    'malformed date': (r) => { r.observedAt = '2026-02-30'; },
    'noncanonical date': (r) => { r.observedAt = '2026-9-1'; },
    '31 days old': (r) => { r.observedAt = '2026-08-12'; },
    'future date': (r) => { r.observedAt = '2026-09-13'; },
    'wrong product version': (r) => { r.productVersion = '1.2.2'; },
    'wrong payload': (r) => { r.payloadSha256 = 'b'.repeat(64); },
    'unreachable source': (r) => { r.sourceRevision = 'a'.repeat(40); },
    'wrong artifact digest': (r) => { r.artifact.sha256 = 'a'.repeat(64); },
    'wrong artifact path': (r) => { r.artifact.path = 'docs/native-test-evidence-copy.md'; },
    'credential in observation': (r) => { r.checks[0].observation = 'Authorization: Bearer unredacted-value'; },
    'credential in procedure': (r) => { r.checks[0].command = 'tool --token unredacted-value'; },
    'credential in approval': (r) => { r.checks.find((c) => c.capability === 'approval-interruption').humanApprovals[0].response = 'API_KEY=unredacted-value'; },
    'credential in degradation': (r) => { r.checks[0].degradation = 'TOKEN=unredacted-value'; },
  };
  for (const result of ['FAIL', 'SKIPPED', 'NOT RUN', 'PENDING']) {
    mutations[`record ${result}`] = (r) => { r.result = result; };
    mutations[`case ${result}`] = (r) => { r.checks[0].result = result; };
  }
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => withLaunchFixture(({ evidence, validate }) => {
    const copy = structuredClone(evidence); mutate(copy.records[1], copy); assert.throws(() => validate(copy));
  }));
});

test('schema 2 accepts exactly 30-day evidence and evidence-only follow-up commits', () => {
  withLaunchFixture(({ root, evidence, validate }) => {
    for (const r of evidence.records) r.observedAt = '2026-08-13';
    writeFileSync(join(root, 'docs', 'release-audit-remediation.md'), 'evidence-only follow-up\n');
    writeJson(join(root, 'docs', 'native-test-evidence.json'), evidence);
    git(root, ['add', '--all']); git(root, ['commit', '-m', 'evidence-only follow-up']);
    assert.doesNotThrow(() => validate());
  });
});

test('schema 2 binds launch evidence to shipped documentation bytes, modes and paths', async (t) => {
  for (const mutation of ['bytes', 'mode', 'path']) await t.test(mutation, () => withLaunchFixture(({ root, evidence, packagePaths }) => {
    let paths = packagePaths;
    if (mutation === 'bytes') writeFileSync(join(root, 'adapters', 'index.js'), 'changed product\n');
    if (mutation === 'mode') chmodSync(join(root, 'adapters', 'index.js'), 0o755);
    if (mutation === 'path') {
      writeFileSync(join(root, 'docs', 'ordinary-product.md'), 'shipped documentation\n');
      paths = [...paths, 'docs/ordinary-product.md'];
    }
    const payloadSha256 = computePayloadIdentity(root, paths);
    for (const r of evidence.records) r.payloadSha256 = payloadSha256;
    assert.throws(() => validateEvidence(evidence, { root, packagePaths: paths, now: NOW }));
  }));
});

test('schema 2 rejects credential-bearing artifacts even with the matching digest', () => {
  withLaunchFixture(({ root, evidence, validate }) => {
    writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), 'Authorization: Bearer unredacted-value\n');
    for (const r of evidence.records) r.artifact.sha256 = sha256(readFileSync(join(root, EVIDENCE_ARTIFACT_PATH)));
    assert.throws(() => validate());
  });
});

test('schema 2 independently requires attributed human responses for each human-gated flow', async (t) => {
  await withLaunchFixture(async ({ evidence, validate }) => {
    const mutations = {
      'missing approvals': (check) => { delete check.humanApprovals; },
      'empty approvals': (check) => { check.humanApprovals = []; },
      'missing approver': (check) => { delete check.humanApprovals[0].approver; },
      'blank approver': (check) => { check.humanApprovals[0].approver = ''; },
      'missing response': (check) => { delete check.humanApprovals[0].response; },
      'blank response': (check) => { check.humanApprovals[0].response = ''; },
      'missing attribution kind': (check) => { delete check.humanApprovals[0].kind; },
      'model self approval': (check) => { check.humanApprovals[0].kind = 'model'; },
    };
    for (const capability of HUMAN_GATED_CASES) {
      for (const [name, mutate] of Object.entries(mutations)) await t.test(`${capability}: ${name}`, () => {
        const copy = structuredClone(evidence);
        mutate(copy.records[1].checks.find((check) => check.capability === capability));
        assert.throws(() => validate(copy));
      });
    }
  });
});

test('schema 2 allows empty approval arrays on checks without a human gate', () => {
  withLaunchFixture(({ evidence, validate }) => {
    for (const record of evidence.records) {
      for (const check of record.checks) {
        if (!HUMAN_GATED_CASES.includes(check.capability)) assert.deepEqual(check.humanApprovals, []);
      }
    }
    assert.doesNotThrow(() => validate());
  });
});

test('schema 2 independently validates every candidate-preflight check', async (t) => {
  await withLaunchFixture(async ({ evidence, validate }) => {
    for (const capability of PREFLIGHT_CASES) await t.test(`missing ${capability}`, () => {
      const copy = structuredClone(evidence);
      copy.records[0].checks = copy.records[0].checks.filter((check) => check.capability !== capability);
      assert.throws(() => validate(copy));
    });
    const mutations = {
      'empty inventory': (record) => { record.checks = []; },
      'duplicate check': (record) => { record.checks.push(structuredClone(record.checks[0])); },
      'unknown check': (record) => { record.checks[0].capability = 'invented'; },
    };
    for (const result of ['FAIL', 'SKIPPED', 'NOT RUN', 'PENDING']) {
      mutations[`check ${result}`] = (record) => { record.checks[0].result = result; };
    }
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
      const copy = structuredClone(evidence); mutate(copy.records[0]);
      assert.throws(() => validate(copy));
    });
  });
});

test('schema 2 rejects unknown fields at every remaining closed-object boundary', async (t) => {
  await withLaunchFixture(async ({ evidence, validate }) => {
    const mutations = {
      document: (copy) => { copy.invented = true; },
      installation: (copy) => { copy.records[1].installation.invented = true; },
      artifact: (copy) => { copy.records[1].artifact.invented = true; },
      approval: (copy) => {
        copy.records[1].checks.find((check) => check.capability === 'approval-interruption').humanApprovals[0].invented = true;
      },
    };
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
      const copy = structuredClone(evidence); mutate(copy);
      assert.throws(() => validate(copy));
    });
  });
});

// Exercise the shared credential scanner through complete schema-2 inputs, not
// through an implementation regex export. Every value below is synthetic.
const QUOTED_CREDENTIAL_FORMS = [
  ['assignment', (value) => `API_KEY=${value}`],
  ['flag whitespace', (value) => `tool --token ${value}`],
  ['flag equals', (value) => `tool --password=${value}`],
  ['authorization header', (value) => `Authorization: Bearer ${value}`],
  ['API header', (value) => `X-Api-Key: ${value}`],
  ['cookie header', (value) => `Cookie: session=${value}`],
];

function replaceArtifact(root, evidence, text) {
  const bytes = Buffer.from(`${text}\n`);
  writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), bytes);
  for (const record of evidence.records) record.artifact.sha256 = sha256(bytes);
}

test('schema 2 rejects quoted credentials in fields and matching-digest artifacts', async (t) => {
  await withLaunchFixture(async ({ root, evidence, validate }) => {
    for (const quote of ['"', "'"]) {
      for (const [form, format] of QUOTED_CREDENTIAL_FORMS) {
        const credential = format(`${quote}synthetic secret with whitespace${quote}`);
        for (const field of ['command', 'observation', 'degradation', 'human response']) {
          await t.test(`${form}, ${quote}, ${field}`, () => {
            const copy = structuredClone(evidence);
            const check = copy.records[1].checks.find((c) => c.capability === 'approval-interruption');
            if (field === 'human response') check.humanApprovals[0].response = credential;
            else check[field] = credential;
            assert.throws(() => validate(copy), /credential/i);
          });
        }
        await t.test(`${form}, ${quote}, artifact`, () => {
          const copy = structuredClone(evidence);
          replaceArtifact(root, copy, credential);
          try { assert.throws(() => validate(copy), /credential/i); }
          finally { writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), 'redacted live evidence\n'); }
        });
      }
    }
  });
});

test('schema 2 accepts quoted complete redaction markers but rejects markers with extra content', async (t) => {
  await withLaunchFixture(async ({ root, evidence, validate }) => {
    for (const quote of ['"', "'"]) {
      for (const marker of ['<redacted>', '[redacted]', 'REDACTED']) {
        await t.test(`complete ${quote}${marker}${quote}`, () => {
          const copy = structuredClone(evidence);
          const commands = QUOTED_CREDENTIAL_FORMS.map(([, format]) => format(`${quote}${marker}${quote}`));
          copy.records[1].checks[0].command = commands.join('; ');
          replaceArtifact(root, copy, commands.join('\n'));
          try { assert.doesNotThrow(() => validate(copy)); }
          finally { writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), 'redacted live evidence\n'); }
        });
        for (const suffix of [' extra-secret', '-extra-secret']) {
          await t.test(`incomplete marker ${quote}${marker}${suffix}${quote}`, () => {
            const copy = structuredClone(evidence);
            copy.records[1].checks[0].command = `tool --token ${quote}${marker}${suffix}${quote}`;
            assert.throws(() => validate(copy), /credential/i);
          });
        }
      }
    }
  });
});

test('schema 2 rejects normalized absence placeholders at each mandatory human gate', async (t) => {
  await withLaunchFixture(async ({ evidence, validate }) => {
    for (const capability of HUMAN_GATED_CASES) {
      for (const field of ['approver', 'response']) {
        for (const placeholder of ['none', ' NoNe ', 'NOT RUN', ' not   run ', 'PENDING', ' PeNdInG ']) {
          await t.test(`${capability}: ${field}=${JSON.stringify(placeholder)}`, () => {
            const copy = structuredClone(evidence);
            copy.records[1].checks.find((check) => check.capability === capability).humanApprovals[0][field] = placeholder;
            assert.throws(() => validate(copy));
          });
        }
      }
    }
    // The baseline carries actual attributed fixture text on gated checks and
    // empty arrays on ungated checks; placeholder rejection must preserve it.
    await t.test('attributed human text and ungated empty arrays remain valid', () => {
      assert.doesNotThrow(() => validate());
    });
  });
});

test('schema 2 credential boundaries require a complete marker across adjacent chunks', async (t) => {
  const boundaryCases = [
    ['unquoted marker plus text chunk, assignment', (q) => `API_KEY=REDACTED${q}synthetic-secret${q}`],
    ['unquoted marker plus space chunk, flag', (q) => `tool --token REDACTED${q} synthetic-secret${q}`],
    ['unquoted marker plus semicolon chunk, API header', (q) => `X-Api-Key: REDACTED${q};synthetic-secret${q}`],
    ['quoted marker plus unquoted suffix, cookie', (q) => `Cookie: session=${q}REDACTED${q}synthetic-secret`],
    ['quoted marker plus quoted suffix, flag equals', (q) => `tool --password=${q}REDACTED${q}${q} synthetic-secret${q}`],
    ['outer-quoted authorization header with content before close', (q) => `curl -H ${q}Authorization: Bearer REDACTED synthetic-secret${q}`],
    ['outer-quoted cookie with semicolon content before close', (q) => `curl -H ${q}Cookie: session=REDACTED;synthetic-secret${q}`],
    ['unterminated quoted marker, assignment', (q) => `API_KEY=${q}REDACTED`],
    ['mismatched quoted marker, flag', (q) => `tool --token ${q}REDACTED${q === '"' ? "'" : '"'}`],
    ['empty quoted value, API header', (q) => `X-Api-Key: ${q}${q}`],
    ['unterminated suffix after marker, cookie', (q) => `Cookie: session=REDACTED${q} synthetic-secret`],
    ['empty unquoted value, assignment', () => 'API_KEY='],
  ];
  await withLaunchFixture(async ({ root, evidence, validate }) => {
    for (const quote of ['"', "'"]) {
      for (const [name, format] of boundaryCases) {
        const text = format(quote);
        await t.test(`${name}, ${quote}, field`, () => {
          const copy = structuredClone(evidence);
          copy.records[1].checks[0].command = text;
          assert.throws(() => validate(copy), /credential/i);
        });
        await t.test(`${name}, ${quote}, matching-digest artifact`, () => {
          const copy = structuredClone(evidence);
          replaceArtifact(root, copy, text);
          try { assert.throws(() => validate(copy), /credential/i); }
          finally { writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), 'redacted live evidence\n'); }
        });
      }
    }
  });
});

test('schema 2 credential boundaries preserve complete markers and outer-quoted redacted headers', async (t) => {
  await withLaunchFixture(async ({ root, evidence, validate }) => {
    for (const marker of ['<redacted>', '[redacted]', 'REDACTED']) {
      for (const quote of ['"', "'"]) await t.test(`${quote}${marker}${quote}`, () => {
        const texts = [
          `API_KEY=${marker}`, `tool --token ${marker}`, `Cookie: session=${marker}`,
          `API_KEY=${quote}${marker}${quote}`, `tool --token ${quote}${marker}${quote}`,
          `curl -H ${quote}Authorization: Bearer ${marker}${quote}`,
          `curl -H ${quote}X-Api-Key: ${marker}${quote}`,
          `curl -H ${quote}Cookie: session=${marker}${quote}`,
        ];
        const copy = structuredClone(evidence);
        copy.records[1].checks[0].command = texts.join('; ');
        replaceArtifact(root, copy, texts.join('\n'));
        try { assert.doesNotThrow(() => validate(copy)); }
        finally { writeFileSync(join(root, EVIDENCE_ARTIFACT_PATH), 'redacted live evidence\n'); }
      });
    }
  });
});
