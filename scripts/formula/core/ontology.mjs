// Stable Knowledge Graph ontology — the closed typed schema for the Stable Graph
// (spec .formula/work/specs/2026-08-11-stable-knowledge-graph.md §3-§6, §10, "Required graph
// invariants"). Data tables + pure validation functions only: no I/O, no dependencies, no
// engine coupling — this module must run identically in every adapter/harness (spec §20).
// Later tasks build on it: B2 (ids.mjs) owns qualified-ID construction/parsing and lifecycle
// transitions; B3 (engine port) owns namespace separation (curated/topology/scenario/system);
// B4 (validator) walks a whole graph and raises GRAPH_INVALID from violations shaped like the
// ones returned here.
//
// Violation shape returned by every validate* function below:
//   { code: string, message: string, identity: object }
// `code` is a stable machine-checkable reason, `message` is human-readable, `identity` carries
// the offending type/property/relationship/endpoint so a caller can locate the fault without
// parsing `message`.

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function violation(code, message, identity) {
  return { code, message, identity };
}

// --- Graph schema version + versioned extension namespace (spec §10 + invariants) ---------

// Bump on an ontology-breaking change; schema migration (spec §27) builds the transformed
// graph in a shadow space and validates it before cutover.
export const GRAPH_SCHEMA_VERSION = 1;

// Reserved for future semantic metadata (embeddings, indexes) so hybrid retrieval (spec §10)
// never requires a schema migration. Any property name with this prefix is accepted on any
// node/edge WITHOUT interpretation by this module. Tied to GRAPH_SCHEMA_VERSION so a future
// schema version reserves its own namespace rather than silently reusing this one.
export const EXTENSION_NAMESPACE_PREFIX = `ext_v${GRAPH_SCHEMA_VERSION}_`;

export function isExtensionProperty(propertyName) {
  return typeof propertyName === 'string' && propertyName.startsWith(EXTENSION_NAMESPACE_PREFIX);
}

export function isSupportedSchemaVersion(version) {
  return version === GRAPH_SCHEMA_VERSION;
}

// --- Lifecycle (spec §6) --------------------------------------------------------------------

export const LIFECYCLE_STATES = deepFreeze(['active', 'deprecated', 'superseded']);

export function isLifecycleState(value) {
  return LIFECYCLE_STATES.includes(value);
}

// --- Rule strength (spec §3) ----------------------------------------------------------------

export const RULE_STRENGTHS = deepFreeze(['must', 'should']);

// Property-value domains checked by validateNodeProperties, keyed by property name. Both keys
// are lifecycle/strength enums explicitly named by the spec; free-text fields (title, category,
// concern, ...) carry no closed value domain and are left as presence-only checks.
const PROPERTY_ENUMS = deepFreeze({
  status: LIFECYCLE_STATES,
  strength: RULE_STRENGTHS,
});

// --- Node types (spec §4) -------------------------------------------------------------------

export const NODE_CLASS = deepFreeze({
  CURATED: 'curated',
  REPOSITORY_DERIVED: 'repository-derived',
});

// Common baseline for curated node types beyond Rule: every curated (human-governed) node
// carries an immutable id (spec §6) and a lifecycle status (spec §6, general to "Identity and
// lifecycle" — not scoped to Rule alone). Spec §4 gives no richer per-type property table for
// Project/Surface/Component/Decision/Term/Check/Agent/Skill, so this module does not invent one.
const CURATED_BASE_PROPERTIES = deepFreeze({ required: ['id', 'status'], optional: [] });

// Repository-derived nodes are deterministically observed and refreshed (spec §25 topology
// refresh; canonical terminology "Repository topology subgraph"), not authored with a lifecycle
// status — so identity is the only property required of every one of them, and what a detector
// additionally OBSERVED is declared per type below.
//
// A Package is "matched by path selectors" (spec §4): the selector is not decoration, it is the
// observation the node exists to carry, and the topology refresh compares it to decide whether a
// renamed DIRECTORY is the same Package (a path change) — so it is required. POSIX-relative to the
// repository root, `.` for the root package.
const PACKAGE_PROPERTIES = deepFreeze({ required: ['id', 'path'], optional: [] });

// `root` names the observed repository root, `digest` is the deterministic digest of the topology
// inputs the refresh compares before answering (spec §25). Both are OPTIONAL: a Repository node
// that predates a digest-carrying refresh is not invalid, it is merely unmeasured.
const REPOSITORY_PROPERTIES = deepFreeze({ required: ['id'], optional: ['root', 'digest'] });

// The observed workspace boundary's own path selector, POSIX-relative to the repository root
// (`.` for the root workspace). Optional for the same reason: an unmeasured boundary is not a
// broken one.
const WORKSPACE_PROPERTIES = deepFreeze({ required: ['id'], optional: ['path'] });

// Rule is the one node type with an explicit spec §3 property list. "explicit scope via
// relationships" is intentionally NOT listed as a property: it is satisfied by APPLIES_TO
// edges, not a node field, and is a graph-level (not property-level) invariant owned by B4.
// "provenance and audit metadata" is modeled as one opaque required field, `provenance`; its
// internal shape is not specified by the ontology and is left to the engine/audit layer.
const RULE_PROPERTIES = deepFreeze({
  required: ['id', 'title', 'statement', 'status', 'strength', 'category', 'concern', 'provenance'],
  optional: ['body'],
});

// No graph node per source file (spec §4) — paths are selectors, not a node type.
export const NODE_TYPES = deepFreeze({
  Project: {
    class: NODE_CLASS.CURATED,
    responsibility: 'Stable project namespace and semantic root.',
    properties: CURATED_BASE_PROPERTIES,
  },
  Surface: {
    class: NODE_CLASS.CURATED,
    responsibility: 'Governed technical area and routing boundary.',
    properties: CURATED_BASE_PROPERTIES,
  },
  Component: {
    class: NODE_CLASS.CURATED,
    responsibility: 'Curated subdivision or capability within a Surface.',
    properties: CURATED_BASE_PROPERTIES,
  },
  Rule: {
    class: NODE_CLASS.CURATED,
    responsibility: 'Atomic normative statement.',
    properties: RULE_PROPERTIES,
  },
  Decision: {
    class: NODE_CLASS.CURATED,
    responsibility: 'Durable choice, rationale, alternatives, and consequences.',
    properties: CURATED_BASE_PROPERTIES,
  },
  Term: {
    class: NODE_CLASS.CURATED,
    responsibility: 'Canonical vocabulary and disambiguation.',
    properties: CURATED_BASE_PROPERTIES,
  },
  Check: {
    class: NODE_CLASS.CURATED,
    responsibility: 'Executable or inspectable verification of a rule.',
    properties: CURATED_BASE_PROPERTIES,
  },
  Agent: {
    class: NODE_CLASS.CURATED,
    responsibility: 'Specialist ownership and operating guidance.',
    properties: CURATED_BASE_PROPERTIES,
  },
  Skill: {
    class: NODE_CLASS.CURATED,
    responsibility: 'Applicable workflow capability.',
    properties: CURATED_BASE_PROPERTIES,
  },
  Repository: {
    class: NODE_CLASS.REPOSITORY_DERIVED,
    responsibility: 'Observed repository identity and root.',
    properties: REPOSITORY_PROPERTIES,
  },
  Workspace: {
    class: NODE_CLASS.REPOSITORY_DERIVED,
    responsibility: 'Observed workspace boundary.',
    properties: WORKSPACE_PROPERTIES,
  },
  Package: {
    class: NODE_CLASS.REPOSITORY_DERIVED,
    responsibility: 'Observed package/project matched by path selectors.',
    properties: PACKAGE_PROPERTIES,
  },
});

export const CURATED_NODE_TYPE_NAMES = deepFreeze(
  Object.keys(NODE_TYPES).filter((name) => NODE_TYPES[name].class === NODE_CLASS.CURATED),
);

export const REPOSITORY_NODE_TYPE_NAMES = deepFreeze(
  Object.keys(NODE_TYPES).filter((name) => NODE_TYPES[name].class === NODE_CLASS.REPOSITORY_DERIVED),
);

export function isKnownNodeType(type) {
  return Object.prototype.hasOwnProperty.call(NODE_TYPES, type);
}

export function getNodeType(type) {
  return NODE_TYPES[type];
}

function isPropertiesBag(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Validates a node's properties against its declared type schema (closed typed schema): every
// required property must be present, every present property must be either declared
// (required/optional) or inside the versioned extension namespace, and enum-valued properties
// (status, strength) must take a legal value. Does not touch relationships or graph-wide
// invariants (reachability, conflicts, cycles) — those are B4's job. A malformed (non-object,
// null, or array) `properties` argument returns a structured `INVALID_PROPERTIES_VALUE`
// violation instead of throwing — this function reports malformed input, it never crashes on it.
export function validateNodeProperties(type, properties = {}) {
  if (!isKnownNodeType(type)) {
    return [violation('UNKNOWN_NODE_TYPE', `Unknown node type '${type}'.`, { type })];
  }
  if (!isPropertiesBag(properties)) {
    return [
      violation(
        'INVALID_PROPERTIES_VALUE',
        `Node type '${type}' properties must be a plain object, got ${Array.isArray(properties) ? 'an array' : properties === null ? 'null' : typeof properties}.`,
        { type, value: properties },
      ),
    ];
  }
  const violations = [];
  const { required, optional } = NODE_TYPES[type].properties;
  const declared = new Set([...required, ...optional]);

  for (const key of required) {
    if (!(key in properties) || properties[key] === undefined || properties[key] === null) {
      violations.push(
        violation(
          'MISSING_REQUIRED_PROPERTY',
          `Node type '${type}' is missing required property '${key}'.`,
          { type, property: key },
        ),
      );
    }
  }

  for (const key of Object.keys(properties)) {
    if (declared.has(key) || isExtensionProperty(key)) continue;
    violations.push(
      violation(
        'UNKNOWN_PROPERTY',
        `Node type '${type}' has unknown property '${key}' outside the extension namespace '${EXTENSION_NAMESPACE_PREFIX}'.`,
        { type, property: key },
      ),
    );
  }

  for (const [key, allowedValues] of Object.entries(PROPERTY_ENUMS)) {
    if (!declared.has(key) || !(key in properties)) continue;
    const value = properties[key];
    if (value !== undefined && value !== null && !allowedValues.includes(value)) {
      violations.push(
        violation(
          'INVALID_PROPERTY_VALUE',
          `Node type '${type}' property '${key}' has invalid value '${value}' (expected one of: ${allowedValues.join(', ')}).`,
          { type, property: key, value },
        ),
      );
    }
  }

  return violations;
}

// --- Relationships (spec §5) ----------------------------------------------------------------
// Relationship directions are canonical: an edge is created once on its semantic source, never
// mirrored as an inverse edge (spec §5). Encoded as a flat rule table (one entry per legal
// (relationship, from, to) triple) mirroring the spec table's rows one-for-one, plus the two
// generic rows spelled out generically in spec text rather than as a type list:
//   - SUPERSEDES "Stable node -> previous stable node": one same-type pair per curated node
//     type. Repository-derived nodes are excluded — they are incrementally refreshed from the
//     observed repository (spec §25), not superseded through the promotion/lifecycle workflow.
//   - USED_BY "Term -> curated node": one pair per curated node type (Term included).
const SUPERSEDES_MEANING = 'Lifecycle replacement and history.';
const USED_BY_MEANING = 'Vocabulary use and traceability.';

export const RELATIONSHIP_RULES = deepFreeze([
  { relationship: 'PART_OF', from: 'Component', to: 'Surface', meaning: 'Curated governance hierarchy up to the Project root.' },
  { relationship: 'PART_OF', from: 'Surface', to: 'Project', meaning: 'Curated governance hierarchy up to the Project root.' },
  { relationship: 'PART_OF', from: 'Package', to: 'Workspace', meaning: 'Observed repository topology chain.' },
  { relationship: 'PART_OF', from: 'Workspace', to: 'Repository', meaning: 'Observed repository topology chain.' },
  { relationship: 'IMPLEMENTS', from: 'Package', to: 'Component', meaning: 'Observed package-to-governance mapping.' },
  { relationship: 'APPLIES_TO', from: 'Rule', to: 'Surface', meaning: 'Explicit normative scope.' },
  { relationship: 'APPLIES_TO', from: 'Rule', to: 'Component', meaning: 'Explicit normative scope.' },
  { relationship: 'APPLIES_TO', from: 'Rule', to: 'Package', meaning: 'Explicit normative scope.' },
  { relationship: 'VERIFIED_BY', from: 'Rule', to: 'Check', meaning: 'Verification obligation or evidence.' },
  { relationship: 'MOTIVATED_BY', from: 'Rule', to: 'Decision', meaning: 'Rationale and history.' },
  { relationship: 'OVERRIDES', from: 'Rule', to: 'Rule', meaning: 'Explicit conflict resolution.' },
  ...CURATED_NODE_TYPE_NAMES.map((t) => ({ relationship: 'SUPERSEDES', from: t, to: t, meaning: SUPERSEDES_MEANING })),
  { relationship: 'OWNED_BY', from: 'Surface', to: 'Agent', meaning: 'Specialist ownership.' },
  { relationship: 'OWNED_BY', from: 'Component', to: 'Agent', meaning: 'Specialist ownership.' },
  { relationship: 'APPLIES_TO', from: 'Skill', to: 'Surface', meaning: 'Workflow routing.' },
  { relationship: 'APPLIES_TO', from: 'Skill', to: 'Component', meaning: 'Workflow routing.' },
  ...CURATED_NODE_TYPE_NAMES.map((t) => ({ relationship: 'USED_BY', from: 'Term', to: t, meaning: USED_BY_MEANING })),
]);

export const RELATIONSHIP_TYPE_NAMES = deepFreeze([...new Set(RELATIONSHIP_RULES.map((r) => r.relationship))]);

export function isKnownRelationshipType(relationship) {
  return RELATIONSHIP_TYPE_NAMES.includes(relationship);
}

export function isLegalRelationshipEndpoints(relationship, fromType, toType) {
  return RELATIONSHIP_RULES.some((r) => r.relationship === relationship && r.from === fromType && r.to === toType);
}

// Validates one candidate edge in isolation: relationship name known, both endpoint node types
// known, and the (from, to) pair legal for that relationship per the canonical direction table.
// Does not check that the endpoint nodes actually exist in a graph — that is a B3/B4 concern.
export function validateRelationship(relationship, fromType, toType) {
  const violations = [];

  if (!isKnownRelationshipType(relationship)) {
    return [
      violation('UNKNOWN_RELATIONSHIP_TYPE', `Unknown relationship type '${relationship}'.`, { relationship }),
    ];
  }

  if (!isKnownNodeType(fromType)) {
    violations.push(
      violation('UNKNOWN_NODE_TYPE', `Unknown node type '${fromType}' used as relationship source.`, { type: fromType }),
    );
  }
  if (!isKnownNodeType(toType)) {
    violations.push(
      violation('UNKNOWN_NODE_TYPE', `Unknown node type '${toType}' used as relationship target.`, { type: toType }),
    );
  }
  if (violations.length > 0) return violations;

  if (!isLegalRelationshipEndpoints(relationship, fromType, toType)) {
    return [
      violation(
        'INVALID_RELATIONSHIP_ENDPOINTS',
        `Relationship '${relationship}' does not permit ${fromType} -> ${toType}.`,
        { relationship, fromType, toType },
      ),
    ];
  }

  return violations;
}
