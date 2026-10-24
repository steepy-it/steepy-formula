import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIFECYCLE_STATES } from '../scripts/formula/core/ontology.mjs';
import {
  QUALIFIED_ID_PREFIX,
  buildQualifiedId,
  parseQualifiedId,
  isValidProjectId,
  isValidLocalId,
  isValidQualifiedId,
  validateQualifiedId,
  validateIdNotReused,
  LIFECYCLE_TRANSITIONS,
  isLegalLifecycleTransition,
  validateLifecycleTransition,
  assertSameProject,
} from '../scripts/formula/core/ids.mjs';

// Spec §6 examples, verbatim.
const VALID_LOCAL_IDS = ['rule:sanitize-external-input', 'decision:graph-db-is-canonical', 'check:surface-test'];

// --- construction (spec §6: `apex:<projectId>:<localId>`) ----------------------------------

test('QUALIFIED_ID_PREFIX is "apex" (spec §6 template apex:<projectId>:<localId>)', () => {
  assert.equal(QUALIFIED_ID_PREFIX, 'apex');
});

test('buildQualifiedId joins projectId + localId under the apex: prefix, verbatim spec §6 examples', () => {
  for (const localId of VALID_LOCAL_IDS) {
    assert.equal(buildQualifiedId('steepy-formula', localId), `apex:steepy-formula:${localId}`);
  }
});

// --- parsing -----------------------------------------------------------------------------

test('parseQualifiedId splits a well-formed id into projectId/kind/slug/localId', () => {
  assert.deepEqual(parseQualifiedId('apex:steepy-formula:rule:sanitize-external-input'), {
    projectId: 'steepy-formula',
    kind: 'rule',
    slug: 'sanitize-external-input',
    localId: 'rule:sanitize-external-input',
  });
});

test('parseQualifiedId returns null (never throws) for non-string input', () => {
  for (const bad of [null, undefined, 42, true, {}, ['apex', 'proj', 'rule', 'x']]) {
    assert.equal(parseQualifiedId(bad), null);
  }
});

test('parseQualifiedId returns null for the wrong segment count', () => {
  assert.equal(parseQualifiedId('apex:proj:rule'), null); // missing slug
  assert.equal(parseQualifiedId('apex:proj:rule:x:extra'), null); // extra segment
  assert.equal(parseQualifiedId('apex'), null);
});

test('parseQualifiedId returns null for a wrong prefix', () => {
  assert.equal(parseQualifiedId('notapex:proj:rule:x'), null);
});

test('buildQualifiedId output round-trips through parseQualifiedId', () => {
  const built = buildQualifiedId('proj', 'rule:sanitize-external-input');
  assert.deepEqual(parseQualifiedId(built), {
    projectId: 'proj',
    kind: 'rule',
    slug: 'sanitize-external-input',
    localId: 'rule:sanitize-external-input',
  });
});

// --- validation (structural predicates) ----------------------------------------------------

test('isValidProjectId accepts lowercase-hyphenated identifiers, rejects the rest', () => {
  assert.equal(isValidProjectId('steepy-formula'), true);
  assert.equal(isValidProjectId('proj'), true);
  assert.equal(isValidProjectId('Proj'), false); // uppercase
  assert.equal(isValidProjectId('proj_1'), false); // underscore
  assert.equal(isValidProjectId('1proj'), false); // leading digit
  assert.equal(isValidProjectId(''), false);
  assert.equal(isValidProjectId(' proj'), false); // whitespace
  assert.equal(isValidProjectId(null), false);
});

test('isValidLocalId accepts spec §6 examples verbatim, rejects malformed shapes', () => {
  for (const localId of VALID_LOCAL_IDS) {
    assert.equal(isValidLocalId(localId), true, localId);
  }
  assert.equal(isValidLocalId('rule'), false); // missing slug
  assert.equal(isValidLocalId('rule:x:y'), false); // too many colons
  assert.equal(isValidLocalId('Rule:x'), false); // uppercase kind
  assert.equal(isValidLocalId('rule:X'), false); // uppercase slug
  assert.equal(isValidLocalId('rule:'), false); // empty slug
  assert.equal(isValidLocalId(':x'), false); // empty kind
  assert.equal(isValidLocalId(42), false);
});

test('isValidQualifiedId accepts a well-formed qualified id and rejects malformed ones', () => {
  assert.equal(isValidQualifiedId('apex:steepy-formula:rule:sanitize-external-input'), true);
  assert.equal(isValidQualifiedId('apex:steepy-formula:decision:graph-db-is-canonical'), true);
  assert.equal(isValidQualifiedId('apex:steepy-formula:check:surface-test'), true);
  assert.equal(isValidQualifiedId('apex:Steepy:rule:x'), false); // bad project segment
  assert.equal(isValidQualifiedId('apex:proj:Rule:x'), false); // bad local id
  assert.equal(isValidQualifiedId('apex:proj:rule'), false); // wrong shape
  assert.equal(isValidQualifiedId(null), false);
});

// --- validation (structured violations) -----------------------------------------------------

test('validateQualifiedId: a well-formed id is clean', () => {
  assert.deepEqual(validateQualifiedId('apex:steepy-formula:rule:sanitize-external-input'), []);
});

test('validateQualifiedId: a non-string value is a single MALFORMED_QUALIFIED_ID violation', () => {
  const violations = validateQualifiedId(42);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'MALFORMED_QUALIFIED_ID');
  assert.deepEqual(violations[0].identity, { value: 42 });
});

test('validateQualifiedId: wrong segment count or wrong prefix is MALFORMED_QUALIFIED_ID', () => {
  for (const bad of ['apex:proj:rule', 'apex:proj:rule:x:extra', 'notapex:proj:rule:x', 'garbage']) {
    const violations = validateQualifiedId(bad);
    assert.equal(violations.length, 1, bad);
    assert.equal(violations[0].code, 'MALFORMED_QUALIFIED_ID', bad);
    assert.deepEqual(violations[0].identity, { value: bad });
  }
});

test('validateQualifiedId: a bad project segment is INVALID_PROJECT_ID', () => {
  const violations = validateQualifiedId('apex:Bad_Project:rule:x');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'INVALID_PROJECT_ID');
  assert.equal(violations[0].identity.projectId, 'Bad_Project');
});

test('validateQualifiedId: a bad local id (kind or slug) is INVALID_LOCAL_ID', () => {
  const violations = validateQualifiedId('apex:proj:Rule:x');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'INVALID_LOCAL_ID');
  assert.equal(violations[0].identity.localId, 'Rule:x');
});

test('validateQualifiedId: both a bad project segment and a bad local id report both violations', () => {
  const violations = validateQualifiedId('apex:Bad_Project:Rule:x');
  const codes = violations.map((v) => v.code).sort();
  assert.deepEqual(codes, ['INVALID_LOCAL_ID', 'INVALID_PROJECT_ID']);
});

// --- immutability / non-reuse (spec §6: an ID is never reused) -----------------------------

test('validateIdNotReused: an id absent from history is clean, for an array or a Set', () => {
  const id = 'apex:proj:rule:x';
  assert.deepEqual(validateIdNotReused(id, ['apex:proj:rule:other']), []);
  assert.deepEqual(validateIdNotReused(id, new Set(['apex:proj:rule:other'])), []);
  assert.deepEqual(validateIdNotReused(id, []), []);
  assert.deepEqual(validateIdNotReused(id, undefined), []);
});

test('validateIdNotReused: an id present in history is ID_ALREADY_USED, for an array or a Set', () => {
  const id = 'apex:proj:rule:x';
  for (const history of [[id, 'apex:proj:rule:other'], new Set([id])]) {
    const violations = validateIdNotReused(id, history);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].code, 'ID_ALREADY_USED');
    assert.deepEqual(violations[0].identity, { value: id });
  }
});

test('validateIdNotReused: a malformed history argument is treated as empty, never throws', () => {
  const id = 'apex:proj:rule:x';
  for (const bad of [null, 'not-a-collection', 42, {}]) {
    assert.deepEqual(validateIdNotReused(id, bad), []);
  }
});

// --- lifecycle transitions (spec §6) --------------------------------------------------------

test('LIFECYCLE_TRANSITIONS is exactly the three legal edges from spec §6', () => {
  assert.deepEqual(LIFECYCLE_TRANSITIONS, [
    { from: 'active', to: 'deprecated' },
    { from: 'active', to: 'superseded' },
    { from: 'deprecated', to: 'superseded' },
  ]);
});

test('isLegalLifecycleTransition accepts every legal transition', () => {
  assert.equal(isLegalLifecycleTransition('active', 'deprecated'), true);
  assert.equal(isLegalLifecycleTransition('active', 'superseded'), true);
  assert.equal(isLegalLifecycleTransition('deprecated', 'superseded'), true);
});

test('isLegalLifecycleTransition rejects every illegal transition, including reactivation and same-state', () => {
  const illegal = [
    ['deprecated', 'active'], // reactivation is not in spec
    ['superseded', 'active'],
    ['superseded', 'deprecated'],
    ['active', 'active'],
    ['deprecated', 'deprecated'],
    ['superseded', 'superseded'], // no transition out of superseded
  ];
  for (const [from, to] of illegal) {
    assert.equal(isLegalLifecycleTransition(from, to), false, `${from} -> ${to} should be illegal`);
  }
});

test('validateLifecycleTransition: every legal transition validates cleanly', () => {
  assert.deepEqual(validateLifecycleTransition('active', 'deprecated'), []);
  assert.deepEqual(validateLifecycleTransition('active', 'superseded'), []);
  assert.deepEqual(validateLifecycleTransition('deprecated', 'superseded'), []);
});

test('validateLifecycleTransition: reactivation (deprecated->active) is ILLEGAL_LIFECYCLE_TRANSITION', () => {
  const violations = validateLifecycleTransition('deprecated', 'active');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'ILLEGAL_LIFECYCLE_TRANSITION');
  assert.deepEqual(violations[0].identity, { from: 'deprecated', to: 'active' });
});

test('validateLifecycleTransition: no transition out of superseded, for either target', () => {
  for (const to of ['active', 'deprecated']) {
    const violations = validateLifecycleTransition('superseded', to);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].code, 'ILLEGAL_LIFECYCLE_TRANSITION');
  }
});

test('validateLifecycleTransition: same-state transition is illegal for every state', () => {
  for (const state of LIFECYCLE_STATES) {
    const violations = validateLifecycleTransition(state, state);
    assert.equal(violations.length, 1, state);
    assert.equal(violations[0].code, 'ILLEGAL_LIFECYCLE_TRANSITION', state);
  }
});

test('validateLifecycleTransition: an unknown state on either side is UNKNOWN_LIFECYCLE_STATE, never throws', () => {
  let violations = validateLifecycleTransition('draft', 'active');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'UNKNOWN_LIFECYCLE_STATE');
  assert.deepEqual(violations[0].identity, { state: 'draft' });

  violations = validateLifecycleTransition('active', 'archived');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'UNKNOWN_LIFECYCLE_STATE');
  assert.deepEqual(violations[0].identity, { state: 'archived' });
});

// --- cross-project rejection (spec §24) -----------------------------------------------------

test('assertSameProject: two ids in the same project are clean', () => {
  const violations = assertSameProject('apex:proj:rule:x', 'apex:proj:surface:scripts');
  assert.deepEqual(violations, []);
});

test('assertSameProject: ids from different projects report CROSS_PROJECT_RELATIONSHIP', () => {
  const violations = assertSameProject('apex:proj-a:rule:x', 'apex:proj-b:surface:scripts');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'CROSS_PROJECT_RELATIONSHIP');
  assert.deepEqual(violations[0].identity, {
    fromId: 'apex:proj-a:rule:x',
    toId: 'apex:proj-b:surface:scripts',
    fromProjectId: 'proj-a',
    toProjectId: 'proj-b',
  });
});

test('assertSameProject: a malformed endpoint is MALFORMED_QUALIFIED_ID, never throws', () => {
  const violations = assertSameProject('not-a-qualified-id', 'apex:proj:rule:x');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'MALFORMED_QUALIFIED_ID');
  assert.deepEqual(violations[0].identity, { value: 'not-a-qualified-id' });
});

test('assertSameProject: both endpoints malformed reports both violations', () => {
  const violations = assertSameProject('bad-from', 'bad-to');
  assert.equal(violations.length, 2);
  assert.ok(violations.every((v) => v.code === 'MALFORMED_QUALIFIED_ID'));
  assert.deepEqual(violations.map((v) => v.identity.value).sort(), ['bad-from', 'bad-to']);
});

// --- frozen data ------------------------------------------------------------------------------

test('LIFECYCLE_TRANSITIONS is frozen against accidental mutation', () => {
  assert.ok(Object.isFrozen(LIFECYCLE_TRANSITIONS));
  assert.ok(Object.isFrozen(LIFECYCLE_TRANSITIONS[0]));
});
