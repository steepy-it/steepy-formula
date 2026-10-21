import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from '../scripts/template.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const indexTpl = readFileSync(join(here, '..', 'templates', '_INDEX.md'), 'utf8');
const workflowRoot = join(here, '..', '.github', 'workflows');

test('a chosen git policy renders a Git policy directive line in _INDEX.md', () => {
  const out = renderTemplate(indexTpl, {
    projectName: 'demo',
    routingRows: '| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |',
    gitPolicyDirective: '4. **Git policy:** Do not run any `git` command without explicit user confirmation.',
  });
  assert.match(out, /4\. \*\*Git policy:\*\* Do not run any `git` command without explicit user confirmation\./);
  assert.match(out, /1\. \*\*Anti-orphan:\*\*/);
  assert.match(out, /2\. \*\*Living docs:\*\*/);
  assert.match(out, /3\. \*\*Work artifacts:\*\*/);
  assert.deepEqual([...out.matchAll(/^(\d+)\. \*\*/gm)].map((match) => match[1]), ['1', '2', '3', '4']);
});

test('skip / git-libero (empty directive) leaves required directives 1-3', () => {
  const out = renderTemplate(indexTpl, {
    projectName: 'demo',
    routingRows: '| `web` | [standards/web.md](standards/web.md) | `web-agent` | — |',
    gitPolicyDirective: '',
  });
  assert.doesNotMatch(out, /\*\*Git policy:\*\*/);
  assert.match(out, /1\. \*\*Anti-orphan:\*\*/);
  assert.match(out, /2\. \*\*Living docs:\*\*/);
  assert.match(out, /3\. \*\*Work artifacts:\*\*/);
  assert.deepEqual([...out.matchAll(/^(\d+)\. \*\*/gm)].map((match) => match[1]), ['1', '2', '3']);
});

test('graph-first init no longer renders the gitPolicyDirective placeholder — the _INDEX template keeps it for legacy hubs only', () => {
  const skill = readFileSync(join(here, '..', 'skills', 'init', 'SKILL.md'), 'utf8');
  assert.match(indexTpl, /\{\{gitPolicyDirective\}\}/, 'the legacy _INDEX template still carries the placeholder');
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
