// Scenario assembly (promotion-in-chain plan decision 3 — the D5 typed-candidates mapping).
// Everything between "an agent holds a typed candidates file" and "a draft Promotion Scenario
// exists": the wrapper is the typed-candidates file schema's ONLY interpreter (SC4), and it never
// re-implements op semantics — node/edge records are built as B5 change operations and handed to
// D4's `createScenario` / `inspectScenario` verbatim.
//
//   CANDIDATE_KINDS                                                  -> ['term','rule','decision','readme']
//   candidatesToOperations(projectId, candidatesDocument)   (pure)   -> { operations, outOfGraph, violations }
//   assembleScenario(port, { projectId, scenarioId, candidates, proposedBy })
//                                                                     -> { ok, scenarioId, preview, outOfGraph } | failure
//
// THE MAPPING (spec D5; kinds the plan's decision 3 names):
//   term     -> ADD Term node `{ id, status: 'active', ext_v1_definition }` + ADD USED_BY edge
//               term -> `apex:<projectId>:project:root` — the exact anchoring the live repo's own
//               term promotions used (changeset c9): USED_BY is reverse-anchored, so a Term is
//               reachable from the Project root and the projection stays B4-clean. The definition
//               lives in the versioned extension namespace because the ontology gives Term no
//               declared `definition` property, and UNKNOWN_PROPERTY is blocking.
//   rule     -> ADD Rule node `{ id, title, statement, status: 'active', strength, category,
//               concern, provenance }` + ADD APPLIES_TO edge rule -> `appliesTo`. `category`
//               defaults to 'general' (the migration's fallback for an uncategorized rule) and
//               `provenance` is `{ source: 'typed-candidates:<n>', line: <n> }` — the migration's
//               { source, line } shape with the candidates document itself as the "file" and the
//               1-based candidate position as the line; the pure function knows no filesystem.
//   decision -> ADD Decision node `{ id, status: 'active', ext_v1_title, ext_v1_statement,
//               ext_v1_context }` (title/statement/context are extension properties — Decision's
//               declared schema is id+status only, the shape the repo's own decision nodes carry).
//               NOTE: the ontology offers no edge a NEW decision can send upward, so a decision
//               candidate alone cannot be anchored and projects UNREACHABLE_FROM_PROJECT_ROOT —
//               a D4 structural finding at preview, blocking at apply, by design: the human
//               resolves it (e.g. a MOTIVATED_BY edge from an existing rule in a richer set).
//   readme   -> NO graph operation (D5: no `Check` is ever generated either); the note is returned
//               in `outOfGraph` for direct edit as today.
//
//   Node ids are minted as `apex:<projectId>:<kind>:<slug-of-term/title>` and then checked
//   against the id discipline (`ids.mjs`): a slug that cannot head an id segment (digit-leading,
//   e.g. term "2FA token" -> 'term:2fa-token') is an INVALID_CANDIDATE_VALUE violation — the
//   candidate is reported, never silently re-ided, because the projection would otherwise carry
//   a BLOCKING INVALID_LOCAL_ID the scenario could never clear.
//
// CONVENTIONS (the core-module standard of promotion.mjs): structured results, never exceptions
// on data problems — a MALFORMED candidate becomes a `{ code, message, identity }` violation in
// the returned list, never a throw, and one fault never suppresses the others (every candidate is
// judged). Functions throw only on programmer error (no/invalid projectId, a non-document
// `candidates` argument, a malformed input object/actor) exactly like `normalizeScenarioInput`.
// PORT-ONLY I/O: `assembleScenario` touches the graph exclusively through D4's core APIs inside
// their own transactions; there is no `fs` to inject — `candidatesToOperations` is pure, which IS
// the hermetic seam (Task 3 tests need no injection). Closed-input discipline throughout: the
// document, each candidate, and `assembleScenario`'s input accept exactly their named keys.
import { buildQualifiedId, isValidProjectId, parseQualifiedId, validateQualifiedId } from './ids.mjs';
import { EXTENSION_NAMESPACE_PREFIX, RELATIONSHIP_RULES, RULE_STRENGTHS } from './ontology.mjs';
import { ACTOR_TYPES, isActorType } from './revision.mjs';
import { createScenario, inspectScenario } from './promotion.mjs';

const CURATED_NAMESPACE = 'curated';
const PROJECT_ROOT_LOCAL_ID = 'project:root';

// The codes THIS module returns. Violations inside `candidatesToOperations` carry their own codes
// (see CANDIDATE_VIOLATION_CODES) and surface to a caller as `identity.violations` of the one
// failure code below; core failures from `createScenario`/`inspectScenario` are forwarded verbatim.
export const SCENARIO_ASSEMBLY_ERROR_CODES = deepFreeze({ INVALID_CANDIDATES: 'INVALID_CANDIDATES' });

export const CANDIDATE_VIOLATION_CODES = deepFreeze({
  INVALID_CANDIDATES: 'INVALID_CANDIDATES',
  MALFORMED_CANDIDATE: 'MALFORMED_CANDIDATE',
  UNKNOWN_CANDIDATE_KIND: 'UNKNOWN_CANDIDATE_KIND',
  UNKNOWN_CANDIDATE_KEY: 'UNKNOWN_CANDIDATE_KEY',
  MISSING_CANDIDATE_FIELD: 'MISSING_CANDIDATE_FIELD',
  INVALID_CANDIDATE_VALUE: 'INVALID_CANDIDATE_VALUE',
  INVALID_CANDIDATE_TARGET: 'INVALID_CANDIDATE_TARGET',
  DUPLICATE_CANDIDATE_ID: 'DUPLICATE_CANDIDATE_ID',
});

// The closed kind vocabulary of the typed-candidates file schema.
export const CANDIDATE_KINDS = deepFreeze(['term', 'rule', 'decision', 'readme']);

// Exactly which keys each kind accepts — a typo must never silently drop a field.
const CANDIDATE_ARGUMENTS = deepFreeze({
  term: ['kind', 'term', 'definition'],
  rule: ['kind', 'title', 'statement', 'concern', 'strength', 'appliesTo'],
  decision: ['kind', 'title', 'statement', 'context'],
  readme: ['kind', 'note'],
});

// Fields every kind requires as non-empty strings beyond `kind` itself.
const REQUIRED_TEXT_FIELDS = deepFreeze({
  term: ['term', 'definition'],
  rule: ['title', 'statement', 'concern'],
  decision: ['title', 'statement', 'context'],
  readme: ['note'],
});

// The node types a Rule may legally be APPLIES_TO, derived from B1's own table (never re-encoded):
// APPLIES_TO from Rule is declared for Surface/Component/Package.
const RULE_APPLIES_TO_TYPES = deepFreeze(
  RELATIONSHIP_RULES.filter((rule) => rule.relationship === 'APPLIES_TO' && rule.from === 'Rule').map((rule) => rule.to),
);

// The migration's fallback category for a rule no section categorized — reused so both graph
// writers speak the same vocabulary.
const DEFAULT_RULE_CATEGORY = 'general';

const DOCUMENT_KEYS = deepFreeze(['candidates']);

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

function failure(code, message, identity) {
  return { ok: false, code, message, identity };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

// The migration's slug discipline, reused verbatim so ids minted here collide-or-match exactly the
// way migrate-markdown's would: lowercase, non-[a-z0-9] runs collapse to '-', edges trimmed.
function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extProperty(name) {
  return `${EXTENSION_NAMESPACE_PREFIX}${name}`;
}

function nodeOp(type, id, properties) {
  return { op: 'ADD', target: 'node', namespace: CURATED_NAMESPACE, type, id, properties };
}

function edgeOp(type, fromId, toId) {
  return { op: 'ADD', target: 'edge', namespace: CURATED_NAMESPACE, type, fromId, toId };
}

// --- the pure D5 mapping ---------------------------------------------------------------------------

// Maps ONE candidate. Returns `{ operations, outOfGraph }` (either may be empty) or
// `{ violation }` — malformed input is reported, never thrown, and never suppresses the remaining
// candidates.
function mapCandidate(projectId, candidate, index) {
  if (!isPlainObject(candidate)) {
    return {
      violation: violation(
        CANDIDATE_VIOLATION_CODES.MALFORMED_CANDIDATE,
        `Candidate ${index} must be a plain object with a 'kind'.`,
        { index, value: candidate },
      ),
    };
  }
  const { kind } = candidate;
  if (!CANDIDATE_KINDS.includes(kind)) {
    return {
      violation: violation(
        CANDIDATE_VIOLATION_CODES.UNKNOWN_CANDIDATE_KIND,
        `Candidate ${index} has unknown kind ${JSON.stringify(kind ?? null)}; expected one of: ${CANDIDATE_KINDS.join(', ')}.`,
        { index, kind },
      ),
    };
  }
  const accepted = CANDIDATE_ARGUMENTS[kind];
  const badKey = Object.keys(candidate).find((key) => !accepted.includes(key));
  if (badKey) {
    return {
      violation: violation(
        CANDIDATE_VIOLATION_CODES.UNKNOWN_CANDIDATE_KEY,
        `Candidate ${index} (kind '${kind}') does not accept key '${badKey}'; accepted: ${accepted.join(', ')}.`,
        { index, kind, key: badKey },
      ),
    };
  }

  const violations = [];
  for (const field of REQUIRED_TEXT_FIELDS[kind]) {
    const value = candidate[field];
    if (value === undefined) {
      violations.push(
        violation(CANDIDATE_VIOLATION_CODES.MISSING_CANDIDATE_FIELD, `Candidate ${index} (kind '${kind}') is missing required field '${field}'.`, {
          index,
          kind,
          field,
        }),
      );
    } else if (!isNonEmptyString(value)) {
      violations.push(
        violation(
          CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATE_VALUE,
          `Candidate ${index} (kind '${kind}') field '${field}' must be a non-empty string, got ${JSON.stringify(value)}.`,
          { index, kind, field, value },
        ),
      );
    }
  }
  if (violations.length > 0) return { violation: violations[0], skippedViolations: violations.slice(1) };

  if (kind === 'readme') {
    // No graph operation (D5) — the note is edited directly, exactly as today.
    return { operations: [], outOfGraph: [{ kind, note: candidate.note }] };
  }

  const title = kind === 'term' ? candidate.term : candidate.title;
  const titleField = kind === 'term' ? 'term' : 'title';
  const slug = slugify(title);
  if (slug === '') {
    return {
      violation: violation(
        CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATE_VALUE,
        `Candidate ${index} (kind '${kind}') has a title/term that slugifies to an empty id: ${JSON.stringify(title)}.`,
        { index, kind, field: titleField, value: title },
      ),
    };
  }
  const localKind = kind === 'term' ? 'term' : kind === 'rule' ? 'rule' : 'decision';
  const id = buildQualifiedId(projectId, `${localKind}:${slug}`);
  if (validateQualifiedId(id).length > 0) {
    return {
      violation: violation(
        CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATE_VALUE,
        `Candidate ${index} (kind '${kind}') slugifies '${titleField}' to '${localKind}:${slug}', which breaks the id discipline: every id segment starts with a lowercase letter followed by [a-z0-9-] (minted id '${id}' would never validate).`,
        { index, kind, field: titleField, value: title, id },
      ),
    };
  }

  if (kind === 'term') {
    const properties = { id, status: 'active', [extProperty('definition')]: candidate.definition };
    return {
      operations: [
        nodeOp('Term', id, properties),
        edgeOp('USED_BY', id, buildQualifiedId(projectId, PROJECT_ROOT_LOCAL_ID)),
      ],
      outOfGraph: [],
    };
  }

  if (kind === 'decision') {
    const properties = {
      id,
      status: 'active',
      [extProperty('title')]: candidate.title,
      [extProperty('statement')]: candidate.statement,
      [extProperty('context')]: candidate.context,
    };
    return { operations: [nodeOp('Decision', id, properties)], outOfGraph: [] };
  }

  // kind === 'rule'
  if (!RULE_STRENGTHS.includes(candidate.strength)) {
    return {
      violation: violation(
        CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATE_VALUE,
        `Candidate ${index} (kind 'rule') field 'strength' must be one of: ${RULE_STRENGTHS.join(', ')}, got ${JSON.stringify(candidate.strength)}.`,
        { index, kind, field: 'strength', value: candidate.strength },
      ),
    };
  }
  const target = ruleAppliesToTarget(projectId, candidate.appliesTo, index);
  if ('violation' in target) return target;
  const line = index + 1;
  const properties = {
    id,
    title: candidate.title,
    statement: candidate.statement,
    status: 'active',
    strength: candidate.strength,
    category: DEFAULT_RULE_CATEGORY,
    concern: candidate.concern,
    provenance: { source: `typed-candidates:${line}`, line },
  };
  return {
    operations: [nodeOp('Rule', id, properties), edgeOp('APPLIES_TO', id, target.appliesTo)],
    outOfGraph: [],
  };
}

// `appliesTo` absent is a MISSING field; present but malformed, it fails below. A present value
// must be a well-formed qualified id of THIS project naming a node type the ontology lets a Rule
// be APPLIES_TO (B1's own table, via the local-id kind). Graph EXISTENCE is not judged here —
// the pure function has no graph; the D4 projection reports a dangling endpoint.
function ruleAppliesToTarget(projectId, appliesTo, index) {
  if (appliesTo === undefined) {
    return {
      violation: violation(
        CANDIDATE_VIOLATION_CODES.MISSING_CANDIDATE_FIELD,
        `Candidate ${index} (kind 'rule') is missing required field 'appliesTo'.`,
        { index, kind: 'rule', field: 'appliesTo' },
      ),
    };
  }
  const reject = (reason, identity) => ({
    violation: violation(
      CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATE_TARGET,
      `Candidate ${index} (kind 'rule') field 'appliesTo' ${reason}; expected an existing ${RULE_APPLIES_TO_TYPES.join('/')} node id of project '${projectId}'.`,
      { index, kind: 'rule', field: 'appliesTo', ...identity },
    ),
  });
  const parsed = parseQualifiedId(appliesTo);
  if (!parsed) return reject(`is not a qualified id 'apex:<projectId>:<kind>:<slug>'`, { value: appliesTo });
  if (parsed.projectId !== projectId) {
    return reject(`belongs to project '${parsed.projectId}'`, { value: appliesTo, projectId: parsed.projectId });
  }
  const type = RULE_APPLIES_TO_TYPES.find((name) => name.toLowerCase() === parsed.kind);
  if (!type) return reject(`names node kind '${parsed.kind}'`, { value: appliesTo, kind: parsed.kind });
  return { appliesTo };
}

// Maps a parsed typed-candidates document to scenario operations. PURE: no port, no fs, no clock.
// `candidates` is the parsed DOCUMENT — `{ candidates: [...] }`, the file's whole shape (this
// module is that schema's only interpreter). Returns `{ operations, outOfGraph, violations }`;
// operations preserve candidate order (append order is the scenario's contract).
export function candidatesToOperations(projectId, candidates) {
  if (!isValidProjectId(projectId)) {
    throw new TypeError(`candidatesToOperations requires a valid projectId, got ${JSON.stringify(projectId ?? null)}.`);
  }
  if (!isPlainObject(candidates)) {
    throw new TypeError('candidatesToOperations requires the parsed typed-candidates document (a plain object holding a `candidates` array).');
  }
  const violations = [];
  for (const key of Object.keys(candidates)) {
    if (DOCUMENT_KEYS.includes(key)) continue;
    violations.push(
      violation(
        CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATES,
        `A typed-candidates document does not accept key '${key}'; accepted: ${DOCUMENT_KEYS.join(', ')}.`,
        { key },
      ),
    );
  }
  if (!Array.isArray(candidates.candidates)) {
    violations.push(
      violation(
        CANDIDATE_VIOLATION_CODES.INVALID_CANDIDATES,
        `A typed-candidates document must hold a 'candidates' array, got ${Array.isArray(candidates.candidates) ? 'an array' : JSON.stringify(candidates.candidates ?? null)}.`,
        { candidates: candidates.candidates },
      ),
    );
    return { operations: [], outOfGraph: [], violations };
  }
  if (violations.length > 0) return { operations: [], outOfGraph: [], violations };

  const operations = [];
  const outOfGraph = [];
  const seenIds = new Map();
  for (const [index, candidate] of candidates.candidates.entries()) {
    const mapped = mapCandidate(projectId, candidate, index);
    if (mapped.violation) violations.push(mapped.violation);
    if (mapped.skippedViolations) violations.push(...mapped.skippedViolations);
    if (mapped.violation) continue;
    outOfGraph.push(...mapped.outOfGraph);
    for (const operation of mapped.operations) {
      if (operation.target === 'node') {
        const key = `${operation.namespace}\u0000${operation.id}`;
        if (seenIds.has(key)) {
          violations.push(
            violation(
              CANDIDATE_VIOLATION_CODES.DUPLICATE_CANDIDATE_ID,
              `Candidates ${seenIds.get(key)} and ${index} both map onto node '${operation.id}'; an id is never reused (spec §6).`,
              { index, id: operation.id },
            ),
          );
          continue;
        }
        seenIds.set(key, index);
      }
      operations.push(operation);
    }
  }
  return { operations, outOfGraph, violations };
}

// --- the assembler ---------------------------------------------------------------------------------

const ASSEMBLE_INPUT_KEYS = deepFreeze(['projectId', 'scenarioId', 'candidates', 'proposedBy']);

// Programmer-error throws only (mirroring `normalizeScenarioInput`/`validateProposedBy`); data
// problems are structured results. The proposing actor is REQUIRED (D4 records it on the meta).
function normalizeAssembleInput(port, input) {
  if (!port || typeof port.begin !== 'function') {
    throw new TypeError('assembleScenario requires a port with a begin() method.');
  }
  if (!isPlainObject(input)) {
    throw new TypeError('assembleScenario requires an input object with a projectId and a scenarioId.');
  }
  rejectUnknownKeys(input, ASSEMBLE_INPUT_KEYS, 'assembleScenario');
  const { projectId, scenarioId, candidates, proposedBy } = input;
  if (!isValidProjectId(projectId)) {
    throw new TypeError(`assembleScenario requires a valid projectId, got ${JSON.stringify(projectId ?? null)}.`);
  }
  if (typeof scenarioId !== 'string' || scenarioId === '') {
    throw new TypeError(`assembleScenario requires a non-empty scenarioId string, got ${JSON.stringify(scenarioId ?? null)}.`);
  }
  if (!isPlainObject(candidates)) {
    throw new TypeError('assembleScenario requires the parsed typed-candidates document as `candidates` (a plain object holding a `candidates` array).');
  }
  if (!isPlainObject(proposedBy) || !isActorType(proposedBy.type) || !isNonEmptyString(proposedBy.name)) {
    throw new TypeError(
      `assembleScenario requires the proposing actor { type, name } with type one of: ${ACTOR_TYPES.join(', ')} and a non-empty name; got ${JSON.stringify(proposedBy ?? null)}.`,
    );
  }
  return { projectId, scenarioId, candidates, proposedBy };
}

function rejectUnknownKeys(input, accepted, caller) {
  for (const key of Object.keys(input)) {
    if (accepted.includes(key)) continue;
    throw new TypeError(`${caller}: unknown input key '${key}'; accepted: ${accepted.join(', ')}.`);
  }
}

// Maps the candidates (pure D5), creates the scenario through D4 `createScenario`, then re-derives
// the preview through D4 `inspectScenario`. Returns `{ ok, scenarioId, preview, outOfGraph }` —
// `preview` is the full inspection (meta, operations, advisor, structural, stale, typed diff) — or
// forwards a core failure verbatim. Malformed candidates are a structured `INVALID_CANDIDATES`
// failure carrying every violation; NOTHING is created in that case.
export async function assembleScenario(port, input = {}) {
  const { projectId, scenarioId, candidates, proposedBy } = normalizeAssembleInput(port, input);
  const mapped = candidatesToOperations(projectId, candidates);
  if (mapped.violations.length > 0) {
    return failure(
      SCENARIO_ASSEMBLY_ERROR_CODES.INVALID_CANDIDATES,
      `The typed-candidates set holds ${mapped.violations.length} malformed candidate(s); nothing was created.`,
      { scenarioId, violations: mapped.violations },
    );
  }
  const created = await createScenario(port, { projectId, scenarioId, proposedBy, operations: mapped.operations });
  if (!created.ok) return created;
  const preview = await inspectScenario(port, { projectId, scenarioId });
  if (!preview.ok) return preview;
  return { ok: true, scenarioId, preview, outOfGraph: mapped.outOfGraph };
}
