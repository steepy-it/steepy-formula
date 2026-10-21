import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPH_SCHEMA_VERSION,
  EXTENSION_NAMESPACE_PREFIX,
  isExtensionProperty,
  isSupportedSchemaVersion,
  LIFECYCLE_STATES,
  isLifecycleState,
  RULE_STRENGTHS,
  NODE_CLASS,
  NODE_TYPES,
  CURATED_NODE_TYPE_NAMES,
  REPOSITORY_NODE_TYPE_NAMES,
  isKnownNodeType,
  getNodeType,
  validateNodeProperties,
  RELATIONSHIP_RULES,
  RELATIONSHIP_TYPE_NAMES,
  isKnownRelationshipType,
  isLegalRelationshipEndpoints,
  validateRelationship,
} from '../scripts/formula/core/ontology.mjs';

// Spec §4 — the two node tables, encoded verbatim (responsibility text must match exactly).
const EXPECTED_CURATED = {
  Project: 'Stable project namespace and semantic root.',
  Surface: 'Governed technical area and routing boundary.',
  Component: 'Curated subdivision or capability within a Surface.',
  Rule: 'Atomic normative statement.',
  Decision: 'Durable choice, rationale, alternatives, and consequences.',
  Term: 'Canonical vocabulary and disambiguation.',
  Check: 'Executable or inspectable verification of a rule.',
  Agent: 'Specialist ownership and operating guidance.',
  Skill: 'Applicable workflow capability.',
};

const EXPECTED_REPOSITORY_DERIVED = {
  Repository: 'Observed repository identity and root.',
  Workspace: 'Observed workspace boundary.',
  Package: 'Observed package/project matched by path selectors.',
};

// Spec §5 — every legal (relationship, from, to) endpoint pair, encoded verbatim.
const LEGAL_RELATIONSHIP_ENDPOINTS = [
  ['PART_OF', 'Component', 'Surface'],
  ['PART_OF', 'Surface', 'Project'],
  ['PART_OF', 'Package', 'Workspace'],
  ['PART_OF', 'Workspace', 'Repository'],
  ['IMPLEMENTS', 'Package', 'Component'],
  ['APPLIES_TO', 'Rule', 'Surface'],
  ['APPLIES_TO', 'Rule', 'Component'],
  ['APPLIES_TO', 'Rule', 'Package'],
  ['VERIFIED_BY', 'Rule', 'Check'],
  ['MOTIVATED_BY', 'Rule', 'Decision'],
  ['OVERRIDES', 'Rule', 'Rule'],
  ['OWNED_BY', 'Surface', 'Agent'],
  ['OWNED_BY', 'Component', 'Agent'],
  ['APPLIES_TO', 'Skill', 'Surface'],
  ['APPLIES_TO', 'Skill', 'Component'],
  // SUPERSEDES: "Stable node -> previous stable node" — one same-type pair per
  // curated node type (repository-derived nodes are refreshed, not superseded).
  ...Object.keys(EXPECTED_CURATED).map((t) => ['SUPERSEDES', t, t]),
  // USED_BY: "Term -> curated node" — one pair per curated node type.
  ...Object.keys(EXPECTED_CURATED).map((t) => ['USED_BY', 'Term', t]),
];

test('GRAPH_SCHEMA_VERSION starts at 1 and isSupportedSchemaVersion checks against it', () => {
  assert.equal(GRAPH_SCHEMA_VERSION, 1);
  assert.equal(isSupportedSchemaVersion(1), true);
  assert.equal(isSupportedSchemaVersion(2), false);
  assert.equal(isSupportedSchemaVersion('1'), false);
});

test('LIFECYCLE_STATES is exactly active/deprecated/superseded (spec §6)', () => {
  assert.deepEqual(LIFECYCLE_STATES, ['active', 'deprecated', 'superseded']);
  assert.equal(isLifecycleState('active'), true);
  assert.equal(isLifecycleState('deprecated'), true);
  assert.equal(isLifecycleState('superseded'), true);
  assert.equal(isLifecycleState('draft'), false);
  assert.equal(isLifecycleState('archived'), false);
});

test('RULE_STRENGTHS is exactly must/should (spec §3)', () => {
  assert.deepEqual(RULE_STRENGTHS, ['must', 'should']);
});

test('NODE_CLASS distinguishes curated from repository-derived', () => {
  assert.equal(NODE_CLASS.CURATED, 'curated');
  assert.equal(NODE_CLASS.REPOSITORY_DERIVED, 'repository-derived');
});

test('NODE_TYPES has exactly the 9 curated + 3 repository-derived types, no more, no less', () => {
  const names = Object.keys(NODE_TYPES).sort();
  const expected = [...Object.keys(EXPECTED_CURATED), ...Object.keys(EXPECTED_REPOSITORY_DERIVED)].sort();
  assert.deepEqual(names, expected);
});

test('every curated node type carries its verbatim spec §4 responsibility and class', () => {
  for (const [name, responsibility] of Object.entries(EXPECTED_CURATED)) {
    const def = getNodeType(name);
    assert.ok(def, `missing node type ${name}`);
    assert.equal(def.class, NODE_CLASS.CURATED, `${name} should be curated`);
    assert.equal(def.responsibility, responsibility, `${name} responsibility text must match spec verbatim`);
  }
});

test('every repository-derived node type carries its verbatim spec §4 responsibility and class', () => {
  for (const [name, responsibility] of Object.entries(EXPECTED_REPOSITORY_DERIVED)) {
    const def = getNodeType(name);
    assert.ok(def, `missing node type ${name}`);
    assert.equal(def.class, NODE_CLASS.REPOSITORY_DERIVED, `${name} should be repository-derived`);
    assert.equal(def.responsibility, responsibility, `${name} responsibility text must match spec verbatim`);
  }
});

test('CURATED_NODE_TYPE_NAMES / REPOSITORY_NODE_TYPE_NAMES partition NODE_TYPES', () => {
  assert.deepEqual([...CURATED_NODE_TYPE_NAMES].sort(), Object.keys(EXPECTED_CURATED).sort());
  assert.deepEqual([...REPOSITORY_NODE_TYPE_NAMES].sort(), Object.keys(EXPECTED_REPOSITORY_DERIVED).sort());
});

test('isKnownNodeType / getNodeType agree on known and unknown types', () => {
  assert.equal(isKnownNodeType('Rule'), true);
  assert.equal(isKnownNodeType('Repository'), true);
  assert.equal(isKnownNodeType('SourceFile'), false); // V1 creates no node per source file
  assert.equal(getNodeType('SourceFile'), undefined);
});

test('Rule declares its spec §3 required fields plus an optional explanatory body', () => {
  const rule = getNodeType('Rule');
  const required = new Set(rule.properties.required);
  for (const field of ['id', 'title', 'statement', 'status', 'strength', 'category', 'concern', 'provenance']) {
    assert.ok(required.has(field), `Rule.properties.required must include '${field}'`);
  }
  assert.ok(rule.properties.optional.includes('body'));
});

test('validateNodeProperties: unknown node type is a single UNKNOWN_NODE_TYPE violation', () => {
  const violations = validateNodeProperties('Widget', { id: 'apex:proj:widget:x' });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'UNKNOWN_NODE_TYPE');
  assert.match(violations[0].message, /Widget/);
  assert.deepEqual(violations[0].identity, { type: 'Widget' });
});

test('validateNodeProperties: a malformed (non-object) properties bag is a structured violation, not a thrown error', () => {
  for (const bad of [null, 'oops', 42, true, ['id']]) {
    const violations = validateNodeProperties('Project', bad);
    assert.equal(violations.length, 1, `${JSON.stringify(bad)} should produce exactly one violation`);
    assert.equal(violations[0].code, 'INVALID_PROPERTIES_VALUE');
    assert.deepEqual(violations[0].identity, { type: 'Project', value: bad });
  }
});

test('validateNodeProperties: an omitted properties argument defaults to {} (reports missing-required, does not throw)', () => {
  const violations = validateNodeProperties('Project');
  const props = violations.map((v) => v.identity.property).sort();
  assert.deepEqual(props, ['id', 'status']);
});

test('validateNodeProperties: an unknown type short-circuits before any malformed-properties check', () => {
  const violations = validateNodeProperties('Widget', null);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'UNKNOWN_NODE_TYPE');
});

test('validateNodeProperties: a complete curated node (Project) with id+status is clean', () => {
  const violations = validateNodeProperties('Project', { id: 'apex:proj:project:root', status: 'active' });
  assert.deepEqual(violations, []);
});

test('validateNodeProperties: Project missing id and status reports both as MISSING_REQUIRED_PROPERTY', () => {
  const violations = validateNodeProperties('Project', {});
  const codes = violations.map((v) => v.code);
  const props = violations.map((v) => v.identity.property).sort();
  assert.deepEqual(codes, ['MISSING_REQUIRED_PROPERTY', 'MISSING_REQUIRED_PROPERTY']);
  assert.deepEqual(props, ['id', 'status']);
});

test('validateNodeProperties: a Package requires its path selector alongside its id', () => {
  // Spec §4: "Observed package/project matched by path selectors" — the selector IS the
  // observation, so a Package without one cannot be matched against the repository (and D1's
  // topology refresh would have nothing to compare on a rename).
  assert.deepEqual(validateNodeProperties('Package', { id: 'apex:proj:package:core', path: 'packages/core' }), []);
  const violations = validateNodeProperties('Package', {});
  assert.deepEqual(
    violations.map((v) => v.identity.property).sort(),
    ['id', 'path'],
  );
  assert.ok(violations.every((v) => v.code === 'MISSING_REQUIRED_PROPERTY'));
});

test('validateNodeProperties: Repository and Workspace carry optional observation properties', () => {
  // Only identity is required of an observed node; `root`/`digest`/`path` are what a refresh
  // records when it has observed them (the repository digest is D1's staleness comparison).
  assert.deepEqual(validateNodeProperties('Repository', { id: 'apex:proj:repository:root' }), []);
  assert.deepEqual(
    validateNodeProperties('Repository', {
      id: 'apex:proj:repository:root',
      root: 'steepy-formula',
      digest: 'a'.repeat(64),
    }),
    [],
  );
  assert.deepEqual(validateNodeProperties('Workspace', { id: 'apex:proj:workspace:packages' }), []);
  assert.deepEqual(
    validateNodeProperties('Workspace', { id: 'apex:proj:workspace:packages', path: 'packages' }),
    [],
  );

  // Each optional property belongs to exactly one type — they are not a shared free-for-all.
  const strayDigest = validateNodeProperties('Workspace', { id: 'apex:proj:workspace:packages', digest: 'x' });
  assert.deepEqual(strayDigest.map((v) => v.code), ['UNKNOWN_PROPERTY']);
  const strayRoot = validateNodeProperties('Package', {
    id: 'apex:proj:package:core',
    path: 'packages/core',
    root: '.',
  });
  assert.deepEqual(strayRoot.map((v) => v.code), ['UNKNOWN_PROPERTY']);
});

test('validateNodeProperties: a fully valid Rule is clean', () => {
  const violations = validateNodeProperties('Rule', {
    id: 'apex:proj:rule:sanitize-external-input',
    title: 'Sanitize external input',
    statement: 'External values must be sanitized before disk writes.',
    status: 'active',
    strength: 'must',
    category: 'security',
    concern: 'input-handling',
    provenance: { createdBy: 'agent:scripts-agent', createdAt: '2026-08-12T00:00:00Z' },
  });
  assert.deepEqual(violations, []);
});

test('validateNodeProperties: Rule missing strength/category/concern reports each', () => {
  const violations = validateNodeProperties('Rule', {
    id: 'apex:proj:rule:x',
    title: 'x',
    statement: 'x.',
    status: 'active',
    provenance: {},
  });
  const props = violations.map((v) => v.identity.property).sort();
  assert.deepEqual(props, ['category', 'concern', 'strength']);
  assert.ok(violations.every((v) => v.code === 'MISSING_REQUIRED_PROPERTY'));
});

test('validateNodeProperties: Rule strength must be must|should — anything else is INVALID_PROPERTY_VALUE', () => {
  const base = {
    id: 'apex:proj:rule:x',
    title: 'x',
    statement: 'x.',
    status: 'active',
    category: 'security',
    concern: 'input-handling',
    provenance: {},
  };
  assert.deepEqual(validateNodeProperties('Rule', { ...base, strength: 'must' }), []);
  assert.deepEqual(validateNodeProperties('Rule', { ...base, strength: 'should' }), []);
  const violations = validateNodeProperties('Rule', { ...base, strength: 'may' });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'INVALID_PROPERTY_VALUE');
  assert.equal(violations[0].identity.property, 'strength');
  assert.equal(violations[0].identity.value, 'may');
});

test('validateNodeProperties: status must be a known lifecycle state', () => {
  const violations = validateNodeProperties('Project', { id: 'apex:proj:project:root', status: 'archived' });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'INVALID_PROPERTY_VALUE');
  assert.equal(violations[0].identity.property, 'status');
});

test('validateNodeProperties: an undeclared property outside the extension namespace is UNKNOWN_PROPERTY', () => {
  const violations = validateNodeProperties('Project', {
    id: 'apex:proj:project:root',
    status: 'active',
    color: 'blue',
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'UNKNOWN_PROPERTY');
  assert.equal(violations[0].identity.property, 'color');
});

test('validateNodeProperties: a property inside the extension namespace is accepted without interpretation', () => {
  const violations = validateNodeProperties('Project', {
    id: 'apex:proj:project:root',
    status: 'active',
    [`${EXTENSION_NAMESPACE_PREFIX}embedding`]: [0.1, 0.2, 0.3],
  });
  assert.deepEqual(violations, []);
});

test('extension namespace: prefix is versioned off GRAPH_SCHEMA_VERSION and gates isExtensionProperty', () => {
  assert.equal(EXTENSION_NAMESPACE_PREFIX, `ext_v${GRAPH_SCHEMA_VERSION}_`);
  assert.equal(isExtensionProperty('ext_v1_embedding'), true);
  assert.equal(isExtensionProperty('ext_v1_'), true);
  assert.equal(isExtensionProperty('embedding'), false);
  assert.equal(isExtensionProperty('ext_v2_embedding'), false); // different schema version, not this namespace
  assert.equal(isExtensionProperty(''), false);
});

test('RELATIONSHIP_TYPE_NAMES is exactly the 9 unique relationship names from spec §5', () => {
  const expected = [
    'PART_OF',
    'IMPLEMENTS',
    'APPLIES_TO',
    'VERIFIED_BY',
    'MOTIVATED_BY',
    'OVERRIDES',
    'SUPERSEDES',
    'OWNED_BY',
    'USED_BY',
  ].sort();
  assert.deepEqual([...RELATIONSHIP_TYPE_NAMES].sort(), expected);
});

test('isKnownRelationshipType recognizes exactly the spec §5 relationship names', () => {
  assert.equal(isKnownRelationshipType('PART_OF'), true);
  assert.equal(isKnownRelationshipType('USED_BY'), true);
  assert.equal(isKnownRelationshipType('DEPENDS_ON'), false);
});

test('every legal endpoint pair from spec §5 is accepted by isLegalRelationshipEndpoints and validateRelationship', () => {
  for (const [relationship, from, to] of LEGAL_RELATIONSHIP_ENDPOINTS) {
    assert.equal(
      isLegalRelationshipEndpoints(relationship, from, to),
      true,
      `${relationship} ${from} -> ${to} should be legal`,
    );
    assert.deepEqual(
      validateRelationship(relationship, from, to),
      [],
      `${relationship} ${from} -> ${to} should validate cleanly`,
    );
  }
});

test('RELATIONSHIP_RULES contains exactly the legal endpoint set (no extra, no missing)', () => {
  const actual = RELATIONSHIP_RULES.map((r) => `${r.relationship}:${r.from}->${r.to}`).sort();
  const expected = LEGAL_RELATIONSHIP_ENDPOINTS.map(([r, f, t]) => `${r}:${f}->${t}`).sort();
  assert.deepEqual(actual, expected);
});

test('validateRelationship rejects a reversed direction (PART_OF is directional)', () => {
  const violations = validateRelationship('PART_OF', 'Project', 'Surface');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'INVALID_RELATIONSHIP_ENDPOINTS');
  assert.deepEqual(violations[0].identity, { relationship: 'PART_OF', fromType: 'Project', toType: 'Surface' });
});

test('validateRelationship rejects an illegal endpoint type not in the table', () => {
  assert.equal(isLegalRelationshipEndpoints('APPLIES_TO', 'Rule', 'Repository'), false);
  const violations = validateRelationship('APPLIES_TO', 'Rule', 'Repository');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'INVALID_RELATIONSHIP_ENDPOINTS');
});

test('validateRelationship: OVERRIDES is Rule -> Rule only, not Decision -> Decision', () => {
  assert.deepEqual(validateRelationship('OVERRIDES', 'Rule', 'Rule'), []);
  assert.equal(isLegalRelationshipEndpoints('OVERRIDES', 'Decision', 'Decision'), false);
});

test('validateRelationship: SUPERSEDES pairs curated types with themselves, never a repository-derived type', () => {
  for (const t of CURATED_NODE_TYPE_NAMES) {
    assert.equal(isLegalRelationshipEndpoints('SUPERSEDES', t, t), true, `SUPERSEDES ${t}->${t} should be legal`);
  }
  for (const t of REPOSITORY_NODE_TYPE_NAMES) {
    assert.equal(isLegalRelationshipEndpoints('SUPERSEDES', t, t), false, `SUPERSEDES ${t}->${t} should be illegal`);
  }
  assert.equal(isLegalRelationshipEndpoints('SUPERSEDES', 'Rule', 'Decision'), false); // cross-type
});

test('validateRelationship: USED_BY only fires from Term, to any curated node, never to repository-derived', () => {
  for (const t of CURATED_NODE_TYPE_NAMES) {
    assert.equal(isLegalRelationshipEndpoints('USED_BY', 'Term', t), true, `USED_BY Term->${t} should be legal`);
  }
  for (const t of REPOSITORY_NODE_TYPE_NAMES) {
    assert.equal(isLegalRelationshipEndpoints('USED_BY', 'Term', t), false, `USED_BY Term->${t} should be illegal`);
  }
  assert.equal(isLegalRelationshipEndpoints('USED_BY', 'Rule', 'Term'), false); // wrong source type
});

test('validateRelationship: OWNED_BY only from Surface or Component to Agent', () => {
  assert.deepEqual(validateRelationship('OWNED_BY', 'Surface', 'Agent'), []);
  assert.deepEqual(validateRelationship('OWNED_BY', 'Component', 'Agent'), []);
  assert.equal(isLegalRelationshipEndpoints('OWNED_BY', 'Project', 'Agent'), false);
});

test('validateRelationship reports UNKNOWN_RELATIONSHIP_TYPE for a name outside spec §5', () => {
  const violations = validateRelationship('DEPENDS_ON', 'Rule', 'Rule');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'UNKNOWN_RELATIONSHIP_TYPE');
  assert.deepEqual(violations[0].identity, { relationship: 'DEPENDS_ON' });
});

test('validateRelationship reports UNKNOWN_NODE_TYPE for unknown endpoint types (both sides, if both unknown)', () => {
  const violations = validateRelationship('PART_OF', 'Ghost', 'Phantom');
  assert.equal(violations.length, 2);
  assert.ok(violations.every((v) => v.code === 'UNKNOWN_NODE_TYPE'));
  assert.deepEqual(violations.map((v) => v.identity.type).sort(), ['Ghost', 'Phantom']);
});

test('ontology data tables are frozen against accidental mutation', () => {
  assert.ok(Object.isFrozen(NODE_TYPES));
  assert.ok(Object.isFrozen(NODE_TYPES.Rule));
  assert.ok(Object.isFrozen(NODE_TYPES.Rule.properties));
  assert.ok(Object.isFrozen(NODE_TYPES.Rule.properties.required));
  assert.ok(Object.isFrozen(RELATIONSHIP_RULES));
  assert.ok(Object.isFrozen(LIFECYCLE_STATES));
  assert.ok(Object.isFrozen(RULE_STRENGTHS));
});
