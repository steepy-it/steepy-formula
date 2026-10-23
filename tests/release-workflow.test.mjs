import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function readWorkflow(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

test('release.yml: triggers on push to main and defaults to contents: read', () => {
  const workflow = readWorkflow('.github/workflows/release.yml');

  assert.match(workflow, /^name:\s*Release\s*$/m);
  assert.match(workflow, /on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
});

test('release.yml: invokes the reusable validation without mandatory release audit evidence', () => {
  const workflow = readWorkflow('.github/workflows/release.yml');

  assert.match(workflow, /validation:\s*\n\s*uses:\s*\.\/\.github\/workflows\/validate\.yml/);
  assert.doesNotMatch(workflow, /require-release-evidence/);
});

test('release.yml: publishing explicitly needs successful validation and alone grants write', () => {
  const workflow = readWorkflow('.github/workflows/release.yml');

  assert.match(workflow, /publish:\s*\n\s*needs:\s*validation/);
  assert.match(workflow, /if:\s*needs\.validation\.result == 'success'/);
  assert.match(workflow, /publish:[\s\S]*?permissions:\s*\n\s*contents:\s*write/);
  assert.equal((workflow.match(/contents:\s*write/g) ?? []).length, 1);
});

test('release.yml: delegates publication to the tested coordinator on the exact candidate', () => {
  const workflow = readWorkflow('.github/workflows/release.yml');
  assert.match(workflow, /fetch-depth:\s*0/, 'publication needs full history');
  assert.match(workflow, /node scripts\/release-publication\.mjs --source "\$GITHUB_SHA"/, 'workflow must invoke the behavior-tested coordinator');
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/, 'only publication uses its GitHub token');
  assert.doesNotMatch(workflow, /git push|gh release create|publish-directory-branch\.mjs/, 'all external mutations pass through the coordinator');
  assert.doesNotMatch(workflow, /--force|force-with-lease|--corrective/, 'automatic publication cannot authorize correction or force');
});

test('release.yml: serializes publication without cancelling an in-flight mutation', () => {
  const workflow = readWorkflow('.github/workflows/release.yml');
  assert.match(workflow, /concurrency:[\s\S]*?group:\s*[^\n]+[\s\S]*?cancel-in-progress:\s*false/, 'release runs serialize and recheck remote main');
  const group = /concurrency:\s*\n\s*group:\s*([^\n]+)/.exec(workflow)?.[1];
  assert.ok(group, 'publication concurrency declares a stable group');
  assert.doesNotMatch(group, /github\.(?:run_id|run_number|run_attempt|sha)\b/, 'per-run or per-commit groups cannot serialize publication');
  for (const [, expression] of group.matchAll(/\$\{\{(.*?)\}\}/g)) {
    assert.match(expression.trim(), /^github\.(?:repository|workflow|ref|ref_name)$/, 'publication group expressions must use a stable repository, workflow or branch scope');
  }
});

test('version-gate.yml: dedicated workflow (not a job in ci.yml), reacts to label toggles on PRs', () => {
  const workflow = readWorkflow('.github/workflows/version-gate.yml');

  assert.match(workflow, /^name:\s*Version gate\s*$/m);
  assert.match(
    workflow,
    /pull_request:\s*\n\s*types:\s*\[opened, synchronize, reopened, labeled, unlabeled\]/,
  );
});

test('version-gate.yml: passes when the PR carries the no-release label', () => {
  const workflow = readWorkflow('.github/workflows/version-gate.yml');

  assert.ok(workflow.includes('no-release'), 'version-gate.yml must reference the no-release label');
  assert.match(
    workflow,
    /contains\(github\.event\.pull_request\.labels\.\*\.name, 'no-release'\)/,
  );
});

test('version-gate.yml: compares .claude-plugin/plugin.json versions between the PR and main', () => {
  const workflow = readWorkflow('.github/workflows/version-gate.yml');

  assert.match(workflow, /git fetch origin main/);
  assert.ok(
    workflow.includes('git show FETCH_HEAD:.claude-plugin/plugin.json'),
    "version-gate.yml must read main's version via git show FETCH_HEAD:.claude-plugin/plugin.json",
  );
  assert.match(workflow, /scripts\/version-policy\.mjs/);
  assert.match(workflow, /validateVersionTransition/);
  assert.match(workflow, /scripts\/bump-version\.mjs/);
});

test('version-gate.yml: no-release skips only increment while retaining validity/downgrade checks', () => {
  const workflow = readWorkflow('.github/workflows/version-gate.yml');

  assert.doesNotMatch(workflow, /if:\s*\$\{\{\s*!contains\(/);
  assert.match(workflow, /NO_RELEASE:/);
  assert.match(workflow, /requireIncrement:\s*process\.env\.NO_RELEASE !== 'true'/);
});

test('version-gate.yml is a standalone workflow file, not a job appended to ci.yml', () => {
  const ci = readWorkflow('.github/workflows/ci.yml');

  assert.doesNotMatch(ci, /version-gate/i);
  assert.doesNotMatch(ci, /no-release/);
});

test('validate.yml: reusable Node 24 test, coherence, package, and product checks', () => {
  const workflow = readWorkflow('.github/workflows/validate.yml');

  assert.match(workflow, /workflow_call:/);
  assert.doesNotMatch(workflow, /require-release-evidence:/);
  assert.match(workflow, /node-version:\s*\['24'\]/);
  // Formula pins one runtime dependency (neo4j-driver): the lockfile install precedes the suite.
  assert.match(workflow, /run: npm ci\s*\n\s*- name: Run test suite\s*\n\s*run: npm test/);
  assert.doesNotMatch(workflow, /validate-hub/);
  assert.match(workflow, /npm pack --dry-run --json/);
  assert.match(workflow, /node scripts\/bump-version\.mjs --check/);
  assert.match(workflow, /node scripts\/validate-release-evidence\.mjs --product-only/);
  assert.doesNotMatch(workflow, /node scripts\/validate-release-evidence\.mjs\s*$/m);
  assert.doesNotMatch(workflow, /\b(?:claude|codex|opencode|pi|dsh)\s+(?:exec|run|--print|plugin)/);
});

test('validate.yml: publication checks do not consume release audit evidence files', () => {
  const workflow = readWorkflow('.github/workflows/validate.yml');
  assert.doesNotMatch(workflow, /native-test-evidence|^  release-evidence:/m);
});

test('ci.yml invokes reusable validation without requiring unavailable live evidence', () => {
  const workflow = readWorkflow('.github/workflows/ci.yml');

  assert.match(workflow, /uses:\s*\.\/\.github\/workflows\/validate\.yml/);
  assert.doesNotMatch(workflow, /require-release-evidence:\s*true/);
});

test('workflows: external Actions remain SHA-pinned and PR validation stays read-only and credential-free', () => {
  for (const path of ['release.yml', 'validate.yml', 'ci.yml', 'version-gate.yml']) {
    const workflow = readWorkflow(`.github/workflows/${path}`);
    for (const [, action] of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
      if (!action.startsWith('./')) assert.match(action, /@[a-f0-9]{40}$/, `${path}: ${action} must be pinned`);
    }
    if (path !== 'release.yml') {
      assert.doesNotMatch(workflow, /contents:\s*write|secrets\.|secrets:\s*inherit|GH_TOKEN:|ANTHROPIC_API_KEY|OPENAI_API_KEY/, `${path}: ordinary PR validation needs no native credentials or write token`);
    }
  }
});
