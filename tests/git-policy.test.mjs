import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workflowRoot = join(here, '..', '.github', 'workflows');

test('graph-first init never renders the gitPolicyDirective placeholder or the numbered markdown directive', () => {
  const skill = readFileSync(join(here, '..', 'skills', 'init', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /\{\{gitPolicyDirective\}\}/, 'graph-first init never renders the markdown hub template');
  assert.doesNotMatch(skill, /4\. \*\*Git policy:\*\*/, 'the numbered markdown directive belongs to the legacy hub, not the graph-first flow');
  assert.match(skill, /git policy/i, 'init still interviews the git policy');
  assert.match(skill, /APPLIES_TO`? every confirmed Surface/,
    'the git policy is offered as a Rule candidate applying to every confirmed Surface');
});

test('every external workflow action is pinned to an approved full upstream SHA', () => {
  const workflows = ['ci.yml', 'release.yml', 'validate.yml', 'version-gate.yml'];
  const approved = new Map([
    ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
    ['actions/setup-node', '820762786026740c76f36085b0efc47a31fe5020'],
  ]);

  for (const name of workflows) {
    const workflow = readFileSync(join(workflowRoot, name), 'utf8');
    for (const match of workflow.matchAll(/uses:\s*([^\s@]+)@([^\s#]+)/g)) {
      assert.equal(match[2], approved.get(match[1]), `${name}: ${match[1]} must use its verified pin`);
    }
    assert.doesNotMatch(workflow, /uses:\s*actions\/[^\s@]+@v\d+/);
  }
});

test('workflow pin provenance names official upstream URLs and verification date', () => {
  const validate = readFileSync(join(workflowRoot, 'validate.yml'), 'utf8');

  assert.match(validate, /https:\/\/github\.com\/actions\/checkout\/releases\/tag\/v7\.0\.1/);
  assert.match(validate, /https:\/\/github\.com\/actions\/setup-node\/commit\/820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(validate, /verified 2026-09-/);
});
