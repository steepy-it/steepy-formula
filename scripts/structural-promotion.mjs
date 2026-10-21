#!/usr/bin/env node
// structural-promotion — map a structural init input file into a DRAFT promotion scenario.
//
// The shipped `steepy-formula promotion create` command interprets the typed-candidates file
// schema, whose closed kind vocabulary is `term`/`rule`/`decision`/`readme`
// (core/scenario-assembly.mjs) — it cannot express the structural skeleton the graph-first init
// interview produces (Project/Surface/Component/Check). This helper is that missing seam: it maps
// a structural input file into plain ADD operations and creates the draft scenario through the
// core library's `createScenario` (core/promotion.mjs) — the D4 lifecycle, never a re-implementation.
// Preview/apply/discard then flow through the ordinary `steepy-formula promotion` commands; this
// helper NEVER applies anything.
//
// USAGE (the thin argv wrapper):
//   node scripts/structural-promotion.mjs --project <id> --port <docker|memory> \
//        --input <structural.json> [--proposer <name>] <scenarioId>
//
// THE STRUCTURAL INPUT FILE SCHEMA (this module is its only interpreter; closed-input discipline —
// unknown keys are violations, never silently dropped):
//
//   {
//     "project":  { "id": "<projectId>" },          // REQUIRED; must match --project
//     "surfaces": [                                  // optional, default []
//       { "name": "<surface name>",                  // required non-empty string
//         "path": "<repo-relative path>",            // required non-empty string
//         "components": ["<component name>", ...],   // optional array of non-empty strings
//         "testCommand": "<approved test command>" } // optional non-empty string — see below
//     ],
//     "rules": [                                     // optional, default []
//       { "title": "...", "statement": "...", "concern": "...",
//         "strength": "must" | "should",
//         "appliesTo": ["<surface name declared above>" | "apex:<id>:surface|component|package:<slug>", ...] }
//     ],
//     "terms": [ { "term": "...", "definition": "..." } ]  // optional, default []
//   }
//
// THE MAPPING (plain ADD operations only — nothing is ever modified or superseded):
//   project      -> ADD Project root `apex:<id>:project:root` { id, status: 'active' }.
//   surface      -> ADD Surface `apex:<id>:surface:<slug(name)>` { id, status, ext_v1_path }
//                   + ADD PART_OF surface -> project root. The declared path rides the versioned
//                   extension namespace (the ontology gives Surface no declared `path` property,
//                   and UNKNOWN_PROPERTY is blocking).
//   component    -> ADD Component `apex:<id>:component:<slug>` { id, status }
//                   + ADD PART_OF component -> its surface.
//   testCommand  -> the surface's HUMAN-APPROVED verification: ADD Rule
//                   `apex:<id>:rule:<surfaceSlug>-verification` ("changes on <name> pass
//                   `<testCommand>`") + ADD APPLIES_TO rule -> surface, and ADD Check
//                   `apex:<id>:check:<surfaceSlug>-test` { id, status, ext_v1_command:
//                   <testCommand> } + ADD VERIFIED_BY rule -> check. The Check's approved test
//                   command is PERSISTED as the `ext_v1_command` extension property — the
//                   property graph-aware skills read from the resolved context. The caller (the
//                   init skill) writes `testCommand` only when the human approved the surface's
//                   verification Rule — this helper derives, it never invents.
//   rule         -> ADD Rule `apex:<id>:rule:<slug(title)>` + one ADD APPLIES_TO edge per
//                   `appliesTo` entry (a surface name declared in this document, or a qualified
//                   Surface/Component/Package id of this project for targets already in the graph).
//                   Two entries resolving onto the same target are a DUPLICATE_STRUCTURAL_ID
//                   violation up front — never left for the core to refuse at preview/apply.
//   term         -> ADD Term `apex:<id>:term:<slug(term)>` { id, status, ext_v1_definition }
//                   + ADD USED_BY term -> project root (the same anchoring the typed-candidates
//                   mapping uses, so the projection stays B4-clean).
//
// ALREADY-INITIALIZED GRAPHS: before creating the scenario, node/edge ADDs whose target already
// exists in the stable `curated` namespace are SKIPPED (and reported), so the same seam serves a
// virgin graph and an incremental promotion on an initialized one — the scenario carries only the
// genuinely new ADDs. An input fully covered by the existing graph is a structured
// NOTHING_TO_ADD failure, never an empty scenario (applyPromotion would refuse SCENARIO_EMPTY).
//
// CONVENTIONS (the core-module standard): structured results, never exceptions on data problems —
// a malformed entry becomes a `{ code, message, identity }` violation in the returned list, and
// one fault never suppresses the others. Functions throw only on programmer error (no port,
// invalid projectId, non-object input, malformed actor), exactly like `assembleScenario`.
//
// EXIT CODES (the wrapper; consistent with the sibling CLI's table, scripts/formula/cli.mjs):
//   0  draft scenario created
//   2  usage error: bad flags, unreadable/invalid --input JSON, structural-input violations
//   3  operational failure: engine unavailable, port/engine errors
//   4  nothing to do: the scenario id is already taken, or every op already exists in the graph
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { userInfo } from 'node:os';
import { buildQualifiedId, isValidProjectId, parseQualifiedId, validateQualifiedId } from './formula/core/ids.mjs';
import { EXTENSION_NAMESPACE_PREFIX, RULE_STRENGTHS } from './formula/core/ontology.mjs';
import { createScenario, inspectScenario, PROMOTION_ERROR_CODES } from './formula/core/promotion.mjs';
import { ACTOR_TYPES, isActorType } from './formula/core/revision.mjs';
import { withTransaction } from './formula/engine/port.mjs';
import { createMemoryPort } from './formula/engine/memory.mjs';
import { SERVER_STATUS, containerNameFor, serverStatus } from './formula/engine/lifecycle.mjs';
import { createArcadeDbPort, databaseNameFor } from './formula/engine/arcadedb.mjs';

const CURATED_NAMESPACE = 'curated';
const PROJECT_ROOT_LOCAL_ID = 'project:root';
const PROPOSER_ACTOR_TYPE = 'agent-proposer';

export const STRUCTURAL_ERROR_CODES = Object.freeze({
  INVALID_STRUCTURAL_INPUT: 'INVALID_STRUCTURAL_INPUT',
  NOTHING_TO_ADD: 'NOTHING_TO_ADD',
});

export const STRUCTURAL_VIOLATION_CODES = Object.freeze({
  UNKNOWN_STRUCTURAL_KEY: 'UNKNOWN_STRUCTURAL_KEY',
  MISSING_STRUCTURAL_FIELD: 'MISSING_STRUCTURAL_FIELD',
  INVALID_STRUCTURAL_VALUE: 'INVALID_STRUCTURAL_VALUE',
  PROJECT_MISMATCH: 'PROJECT_MISMATCH',
  UNKNOWN_APPLIES_TO_TARGET: 'UNKNOWN_APPLIES_TO_TARGET',
  DUPLICATE_STRUCTURAL_ID: 'DUPLICATE_STRUCTURAL_ID',
});

// The document's closed key vocabulary, and each entry kind's accepted keys.
const DOCUMENT_KEYS = Object.freeze(['project', 'surfaces', 'rules', 'terms']);
const SURFACE_KEYS = Object.freeze(['name', 'path', 'components', 'testCommand']);
const RULE_KEYS = Object.freeze(['title', 'statement', 'concern', 'strength', 'appliesTo']);
const TERM_KEYS = Object.freeze(['term', 'definition']);

// The node kinds a Rule may target through `appliesTo` when the entry is a qualified id.
const APPLIES_TO_KINDS = Object.freeze(['surface', 'component', 'package']);

const EXIT = { OK: 0, USAGE: 2, OPERATIONAL: 3, NOT_FOUND: 4 };

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

// The migration's slug discipline (core/scenario-assembly.mjs keeps it private, so ids minted here
// collide-or-match exactly the way its would): lowercase, non-[a-z0-9] runs collapse to '-',
// edges trimmed.
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

// Mints `apex:<projectId>:<kind>:<slug(text)>`, reporting (never silently re-iding) a name whose
// slug breaks the id discipline — the projection would otherwise carry a blocking
// INVALID_LOCAL_ID the scenario could never clear.
function mintId(projectId, kind, text, identity, violations) {
  const slug = slugify(text);
  if (slug === '') {
    violations.push(
      violation(
        STRUCTURAL_VIOLATION_CODES.INVALID_STRUCTURAL_VALUE,
        `${identity.entry} has a name that slugifies to an empty id: ${JSON.stringify(text)}.`,
        { ...identity, value: text },
      ),
    );
    return null;
  }
  const id = buildQualifiedId(projectId, `${kind}:${slug}`);
  if (validateQualifiedId(id).length > 0) {
    violations.push(
      violation(
        STRUCTURAL_VIOLATION_CODES.INVALID_STRUCTURAL_VALUE,
        `${identity.entry} slugifies to '${kind}:${slug}', which breaks the id discipline (minted id '${id}' would never validate).`,
        { ...identity, value: text, id },
      ),
    );
    return null;
  }
  return id;
}

function requireText(entry, keys, entryLabel, identityBase, violations) {
  let clean = true;
  for (const field of keys) {
    const value = entry[field];
    if (value === undefined) {
      violations.push(
        violation(STRUCTURAL_VIOLATION_CODES.MISSING_STRUCTURAL_FIELD, `${entryLabel} is missing required field '${field}'.`, {
          ...identityBase,
          field,
        }),
      );
      clean = false;
    } else if (!isNonEmptyString(value)) {
      violations.push(
        violation(
          STRUCTURAL_VIOLATION_CODES.INVALID_STRUCTURAL_VALUE,
          `${entryLabel} field '${field}' must be a non-empty string, got ${JSON.stringify(value)}.`,
          { ...identityBase, field, value },
        ),
      );
      clean = false;
    }
  }
  return clean;
}

function rejectUnknownEntryKeys(entry, accepted, entryLabel, identityBase, violations) {
  let clean = true;
  for (const key of Object.keys(entry)) {
    if (accepted.includes(key)) continue;
    violations.push(
      violation(STRUCTURAL_VIOLATION_CODES.UNKNOWN_STRUCTURAL_KEY, `${entryLabel} does not accept key '${key}'; accepted: ${accepted.join(', ')}.`, {
        ...identityBase,
        key,
      }),
    );
    clean = false;
  }
  return clean;
}

function optionalArray(document, key, violations) {
  const value = document[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    violations.push(
      violation(STRUCTURAL_VIOLATION_CODES.INVALID_STRUCTURAL_VALUE, `'${key}' must be an array when present, got ${JSON.stringify(value)}.`, {
        field: key,
        value,
      }),
    );
    return [];
  }
  return value;
}

// --- the pure mapping ------------------------------------------------------------------------------

// Maps the parsed structural document to plain-ADD scenario operations. PURE: no port, no fs, no
// clock. Returns `{ operations, violations }`; operations preserve document order (append order is
// the scenario's contract). Throws only on programmer error, mirroring `candidatesToOperations`.
export function structuralToOperations(projectId, structural) {
  if (!isValidProjectId(projectId)) {
    throw new TypeError(`structuralToOperations requires a valid projectId, got ${JSON.stringify(projectId ?? null)}.`);
  }
  if (!isPlainObject(structural)) {
    throw new TypeError('structuralToOperations requires the parsed structural document (a plain object).');
  }

  const violations = [];
  for (const key of Object.keys(structural)) {
    if (DOCUMENT_KEYS.includes(key)) continue;
    violations.push(
      violation(STRUCTURAL_VIOLATION_CODES.UNKNOWN_STRUCTURAL_KEY, `A structural document does not accept key '${key}'; accepted: ${DOCUMENT_KEYS.join(', ')}.`, {
        key,
      }),
    );
  }

  if (!isPlainObject(structural.project) || !isNonEmptyString(structural.project.id)) {
    violations.push(
      violation(STRUCTURAL_VIOLATION_CODES.MISSING_STRUCTURAL_FIELD, `A structural document requires 'project' of the form { "id": "<projectId>" }.`, {
        field: 'project',
      }),
    );
  } else if (structural.project.id !== projectId) {
    violations.push(
      violation(
        STRUCTURAL_VIOLATION_CODES.PROJECT_MISMATCH,
        `The structural document declares project '${structural.project.id}', but this run targets '${projectId}'; the two must agree.`,
        { declared: structural.project.id, requested: projectId },
      ),
    );
  }

  const surfaces = optionalArray(structural, 'surfaces', violations);
  const rules = optionalArray(structural, 'rules', violations);
  const terms = optionalArray(structural, 'terms', violations);

  const rootId = buildQualifiedId(projectId, PROJECT_ROOT_LOCAL_ID);
  const operations = [nodeOp('Project', rootId, { id: rootId, status: 'active' })];
  const surfaceIdByName = new Map();

  for (const [index, surface] of surfaces.entries()) {
    const entryLabel = `Surface ${index}`;
    const identityBase = { entry: entryLabel, index, kind: 'surface' };
    if (!isPlainObject(surface)) {
      violations.push(violation(STRUCTURAL_VIOLATION_CODES.INVALID_STRUCTURAL_VALUE, `${entryLabel} must be a plain object.`, { ...identityBase, value: surface }));
      continue;
    }
    if (!rejectUnknownEntryKeys(surface, SURFACE_KEYS, entryLabel, identityBase, violations)) continue;
    if (!requireText(surface, ['name', 'path'], entryLabel, identityBase, violations)) continue;
    if (surface.testCommand !== undefined && !isNonEmptyString(surface.testCommand)) {
      violations.push(
        violation(STRUCTURAL_VIOLATION_CODES.INVALID_STRUCTURAL_VALUE, `${entryLabel} field 'testCommand' must be a non-empty string when present.`, {
          ...identityBase,
          field: 'testCommand',
          value: surface.testCommand,
        }),
      );
      continue;
    }

    const surfaceId = mintId(projectId, 'surface', surface.name, { ...identityBase, field: 'name' }, violations);
    if (surfaceId === null) continue;
    surfaceIdByName.set(surface.name, surfaceId);
    operations.push(
      nodeOp('Surface', surfaceId, { id: surfaceId, status: 'active', [extProperty('path')]: surface.path }),
      edgeOp('PART_OF', surfaceId, rootId),
    );

    for (const [componentIndex, componentName] of (surface.components ?? []).entries()) {
      if (!isNonEmptyString(componentName)) {
        violations.push(
          violation(
            STRUCTURAL_VIOLATION_CODES.INVALID_STRUCTURAL_VALUE,
            `${entryLabel} component ${componentIndex} must be a non-empty string, got ${JSON.stringify(componentName)}.`,
            { ...identityBase, field: 'components', componentIndex, value: componentName },
          ),
        );
        continue;
      }
      const componentId = mintId(projectId, 'component', componentName, { ...identityBase, field: 'components', componentIndex }, violations);
      if (componentId === null) continue;
      operations.push(nodeOp('Component', componentId, { id: componentId, status: 'active' }), edgeOp('PART_OF', componentId, surfaceId));
    }

    // The surface's human-approved verification (see the header): the caller writes `testCommand`
    // only when the interview approved the verification Rule — a Check never lands without it.
    if (surface.testCommand !== undefined) {
      const surfaceSlug = slugify(surface.name);
      const ruleId = buildQualifiedId(projectId, `rule:${surfaceSlug}-verification`);
      const checkId = buildQualifiedId(projectId, `check:${surfaceSlug}-test`);
      const line = index + 1;
      const statement = `changes on ${surface.name} pass \`${surface.testCommand}\``;
      operations.push(
        nodeOp('Rule', ruleId, {
          id: ruleId,
          title: statement,
          statement,
          status: 'active',
          strength: 'must',
          category: 'verification',
          concern: 'verification',
          provenance: { source: `structural-input:${line}`, line },
        }),
        edgeOp('APPLIES_TO', ruleId, surfaceId),
        nodeOp('Check', checkId, { id: checkId, status: 'active', [extProperty('command')]: surface.testCommand }),
        edgeOp('VERIFIED_BY', ruleId, checkId),
      );
    }
  }

  for (const [index, rule] of rules.entries()) {
    const entryLabel = `Rule ${index}`;
    const identityBase = { entry: entryLabel, index, kind: 'rule' };
    if (!isPlainObject(rule)) {
      violations.push(violation(STRUCTURAL_VIOLATION_CODES.INVALID_STRUCTURAL_VALUE, `${entryLabel} must be a plain object.`, { ...identityBase, value: rule }));
      continue;
    }
    if (!rejectUnknownEntryKeys(rule, RULE_KEYS, entryLabel, identityBase, violations)) continue;
    if (!requireText(rule, ['title', 'statement', 'concern'], entryLabel, identityBase, violations)) continue;
    if (!RULE_STRENGTHS.includes(rule.strength)) {
      violations.push(
        violation(
          STRUCTURAL_VIOLATION_CODES.INVALID_STRUCTURAL_VALUE,
          `${entryLabel} field 'strength' must be one of: ${RULE_STRENGTHS.join(', ')}, got ${JSON.stringify(rule.strength)}.`,
          { ...identityBase, field: 'strength', value: rule.strength },
        ),
      );
      continue;
    }
    if (!Array.isArray(rule.appliesTo) || rule.appliesTo.length === 0) {
      violations.push(
        violation(STRUCTURAL_VIOLATION_CODES.MISSING_STRUCTURAL_FIELD, `${entryLabel} requires a non-empty 'appliesTo' array of scope targets.`, {
          ...identityBase,
          field: 'appliesTo',
        }),
      );
      continue;
    }

    const targets = [];
    const targetIndexById = new Map();
    let targetsClean = true;
    for (const [targetIndex, target] of rule.appliesTo.entries()) {
      const parsed = isNonEmptyString(target) ? parseQualifiedId(target) : null;
      let resolvedId = null;
      if (parsed !== null) {
        if (parsed.projectId === projectId && APPLIES_TO_KINDS.includes(parsed.kind)) {
          resolvedId = target;
        } else {
          violations.push(
            violation(
              STRUCTURAL_VIOLATION_CODES.UNKNOWN_APPLIES_TO_TARGET,
              `${entryLabel} 'appliesTo' entry ${targetIndex} names '${target}', which is not a ${APPLIES_TO_KINDS.join('/')} id of project '${projectId}'.`,
              { ...identityBase, field: 'appliesTo', targetIndex, value: target },
            ),
          );
          targetsClean = false;
          continue;
        }
      } else if (isNonEmptyString(target) && surfaceIdByName.has(target)) {
        resolvedId = surfaceIdByName.get(target);
      } else {
        violations.push(
          violation(
            STRUCTURAL_VIOLATION_CODES.UNKNOWN_APPLIES_TO_TARGET,
            `${entryLabel} 'appliesTo' entry ${targetIndex} names ${JSON.stringify(target)}, which is neither a surface declared in this document nor a qualified ${APPLIES_TO_KINDS.join('/')} id.`,
            { ...identityBase, field: 'appliesTo', targetIndex, value: target },
          ),
        );
        targetsClean = false;
        continue;
      }
      // The duplicate-node-id convention applied to the rule's scope: two entries resolving onto
      // the same target (a repeated name, or a name plus its qualified id) are reported up front —
      // otherwise the core would refuse the duplicate APPLIES_TO edge only at preview/apply
      // (SCENARIO_INVALID), long after this seam could have named the faulty entry.
      if (targetIndexById.has(resolvedId)) {
        violations.push(
          violation(
            STRUCTURAL_VIOLATION_CODES.DUPLICATE_STRUCTURAL_ID,
            `${entryLabel} 'appliesTo' entries ${targetIndexById.get(resolvedId)} and ${targetIndex} both map onto '${resolvedId}'; a scope target is never repeated.`,
            { ...identityBase, field: 'appliesTo', targetIndex, value: target, id: resolvedId },
          ),
        );
        targetsClean = false;
        continue;
      }
      targetIndexById.set(resolvedId, targetIndex);
      targets.push(resolvedId);
    }
    if (!targetsClean) continue;

    const ruleId = mintId(projectId, 'rule', rule.title, { ...identityBase, field: 'title' }, violations);
    if (ruleId === null) continue;
    const line = index + 1;
    operations.push(
      nodeOp('Rule', ruleId, {
        id: ruleId,
        title: rule.title,
        statement: rule.statement,
        status: 'active',
        strength: rule.strength,
        category: 'general',
        concern: rule.concern,
        provenance: { source: `structural-input:${line}`, line },
      }),
      ...targets.map((target) => edgeOp('APPLIES_TO', ruleId, target)),
    );
  }

  for (const [index, term] of terms.entries()) {
    const entryLabel = `Term ${index}`;
    const identityBase = { entry: entryLabel, index, kind: 'term' };
    if (!isPlainObject(term)) {
      violations.push(violation(STRUCTURAL_VIOLATION_CODES.INVALID_STRUCTURAL_VALUE, `${entryLabel} must be a plain object.`, { ...identityBase, value: term }));
      continue;
    }
    if (!rejectUnknownEntryKeys(term, TERM_KEYS, entryLabel, identityBase, violations)) continue;
    if (!requireText(term, ['term', 'definition'], entryLabel, identityBase, violations)) continue;
    const termId = mintId(projectId, 'term', term.term, { ...identityBase, field: 'term' }, violations);
    if (termId === null) continue;
    operations.push(
      nodeOp('Term', termId, { id: termId, status: 'active', [extProperty('definition')]: term.definition }),
      edgeOp('USED_BY', termId, rootId),
    );
  }

  // An id is never reused (spec §6): two entries minting the same node id are reported, and the
  // later duplicate is dropped from the operation list.
  const seenNodeIds = new Map();
  const deduped = [];
  for (const operation of operations) {
    if (operation.target === 'node') {
      if (seenNodeIds.has(operation.id)) {
        violations.push(
          violation(STRUCTURAL_VIOLATION_CODES.DUPLICATE_STRUCTURAL_ID, `Two structural entries both map onto node '${operation.id}'; an id is never reused (spec §6).`, {
            id: operation.id,
          }),
        );
        continue;
      }
      seenNodeIds.set(operation.id, true);
    }
    deduped.push(operation);
  }

  return { operations: deduped, violations };
}

// --- the scenario creator --------------------------------------------------------------------------

function normalizeCreateInput(port, input) {
  if (!port || typeof port.begin !== 'function') {
    throw new TypeError('createStructuralScenario requires a port with a begin() method.');
  }
  if (!isPlainObject(input)) {
    throw new TypeError('createStructuralScenario requires an input object with a projectId and a scenarioId.');
  }
  for (const key of Object.keys(input)) {
    if (['projectId', 'scenarioId', 'structural', 'proposedBy'].includes(key)) continue;
    throw new TypeError(`createStructuralScenario: unknown input key '${key}'; accepted: projectId, scenarioId, structural, proposedBy.`);
  }
  const { projectId, scenarioId, structural, proposedBy } = input;
  if (!isValidProjectId(projectId)) {
    throw new TypeError(`createStructuralScenario requires a valid projectId, got ${JSON.stringify(projectId ?? null)}.`);
  }
  if (!isNonEmptyString(scenarioId)) {
    throw new TypeError(`createStructuralScenario requires a non-empty scenarioId string, got ${JSON.stringify(scenarioId ?? null)}.`);
  }
  if (!isPlainObject(structural)) {
    throw new TypeError('createStructuralScenario requires the parsed structural document as `structural` (a plain object).');
  }
  if (!isPlainObject(proposedBy) || !isActorType(proposedBy.type) || !isNonEmptyString(proposedBy.name)) {
    throw new TypeError(
      `createStructuralScenario requires the proposing actor { type, name } with type one of: ${ACTOR_TYPES.join(', ')} and a non-empty name; got ${JSON.stringify(proposedBy ?? null)}.`,
    );
  }
  return { projectId, scenarioId, structural, proposedBy };
}

// Maps the structural document (pure), drops the ADDs the stable graph already holds (the
// already-initialized seam), creates the draft through D4 `createScenario`, then re-derives the
// preview through D4 `inspectScenario`. Returns `{ ok, scenarioId, operations, skipped, preview }`
// or a structured failure; NOTHING is applied here.
export async function createStructuralScenario(port, input = {}) {
  const { projectId, scenarioId, structural, proposedBy } = normalizeCreateInput(port, input);
  const mapped = structuralToOperations(projectId, structural);
  if (mapped.violations.length > 0) {
    return failure(
      STRUCTURAL_ERROR_CODES.INVALID_STRUCTURAL_INPUT,
      `The structural input holds ${mapped.violations.length} violation(s); nothing was created.`,
      { scenarioId, violations: mapped.violations },
    );
  }

  const existing = await withTransaction(port, async (tx) => {
    const nodeIds = new Set();
    const edgeKeys = new Set();
    for (const node of await tx.listNodes({ namespace: CURATED_NAMESPACE })) nodeIds.add(node.id);
    for (const edge of await tx.listEdges({ namespace: CURATED_NAMESPACE })) {
      edgeKeys.add(`${edge.type} ${edge.fromId} ${edge.toId}`);
    }
    return { nodeIds, edgeKeys };
  });

  const operations = [];
  const skipped = [];
  for (const operation of mapped.operations) {
    const exists =
      operation.target === 'node'
        ? existing.nodeIds.has(operation.id)
        : existing.edgeKeys.has(`${operation.type} ${operation.fromId} ${operation.toId}`);
    (exists ? skipped : operations).push(operation);
  }
  if (operations.length === 0) {
    return failure(
      STRUCTURAL_ERROR_CODES.NOTHING_TO_ADD,
      `Every structural operation already exists in the stable graph of '${projectId}'; nothing to promote.`,
      { scenarioId, skipped: skipped.length },
    );
  }

  const created = await createScenario(port, { projectId, scenarioId, proposedBy, operations });
  if (!created.ok) return created;
  const preview = await inspectScenario(port, { projectId, scenarioId });
  if (!preview.ok) return preview;
  return { ok: true, scenarioId, operations, skipped, preview };
}

// --- the thin argv wrapper -------------------------------------------------------------------------

function proposerName(flag) {
  if (flag !== undefined) return flag;
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

// Opens the port exactly the way the shipped CLI does (scripts/formula/cli.mjs `openPort`):
// `docker` reads the running project container's state — its credentials ride the serverStatus
// state, read back from the container environment; `graph init` (with the F1 secret-provider
// chain) is the only credential-provisioning path, never this helper. `memory` builds the
// in-memory reference port — a hermetic seam whose state dies with the process (a subprocess run
// on it is a mapping/validation dry-run; the in-process programmatic API is the real memory seam).
async function openPort({ projectId, port }) {
  if (port === 'memory') return createMemoryPort();
  const state = await serverStatus({ name: containerNameFor(projectId) });
  if (state.status !== SERVER_STATUS.READY) {
    const detail = state.reason ? `; ${state.reason}` : '';
    throw new Error(`graph server '${containerNameFor(projectId)}' is not ready (status: ${state.status}${detail}); run \`steepy-formula graph init\` first.`);
  }
  return createArcadeDbPort({ server: state, database: databaseNameFor(projectId) });
}

function usageError(message) {
  console.error(`steepy structural-promotion: ${message}`);
  console.error(
    'usage: node structural-promotion.mjs --project <id> --port <docker|memory> --input <structural.json> [--proposer <name>] <scenarioId>',
  );
  return EXIT.USAGE;
}

export async function main(argv = process.argv.slice(2)) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        project: { type: 'string' },
        port: { type: 'string' },
        input: { type: 'string' },
        proposer: { type: 'string' },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    return usageError(error.message);
  }
  if (!isValidProjectId(values.project)) {
    return usageError(`--project <id> is required and must match [a-z][a-z0-9-]*, got ${JSON.stringify(values.project ?? null)}.`);
  }
  const port = values.port ?? 'docker';
  if (!['docker', 'memory'].includes(port)) {
    return usageError(`unknown --port '${values.port}'; expected 'docker' or 'memory'.`);
  }
  if (values.input === undefined) {
    return usageError('--input <structural.json> is required.');
  }
  if (positionals.length !== 1 || !isNonEmptyString(positionals[0])) {
    return usageError('exactly one non-empty <scenarioId> positional is required.');
  }
  const [scenarioId] = positionals;

  let structural;
  try {
    structural = JSON.parse(readFileSync(values.input, 'utf8'));
  } catch (error) {
    return usageError(`cannot read --input file '${values.input}' as JSON: ${error.message}`);
  }
  if (!isPlainObject(structural)) {
    return usageError(`--input file '${values.input}' must hold a JSON object (the structural document).`);
  }

  const name = proposerName(values.proposer);
  let graphPort;
  try {
    graphPort = await openPort({ projectId: values.project, port });
  } catch (error) {
    console.error(`steepy structural-promotion: ${error.message}`);
    return EXIT.OPERATIONAL;
  }

  let result;
  try {
    result = await createStructuralScenario(graphPort, {
      projectId: values.project,
      scenarioId,
      structural,
      proposedBy: { type: PROPOSER_ACTOR_TYPE, name },
    });
  } catch (error) {
    console.error(`steepy structural-promotion: ${error.message}`);
    return EXIT.OPERATIONAL;
  } finally {
    await graphPort.close?.();
  }

  if (!result.ok) {
    if (result.code === STRUCTURAL_ERROR_CODES.INVALID_STRUCTURAL_INPUT) {
      for (const found of result.identity.violations ?? []) console.error(`steepy structural-promotion: [${found.code}] ${found.message}`);
      return usageError(`--input file '${values.input}' holds ${result.identity.violations?.length ?? 0} violation(s); nothing was created.`);
    }
    if (result.code === STRUCTURAL_ERROR_CODES.NOTHING_TO_ADD || result.code === PROMOTION_ERROR_CODES.SCENARIO_EXISTS) {
      console.error(`steepy structural-promotion: ${result.message}`);
      return EXIT.NOT_FOUND;
    }
    console.error(`steepy structural-promotion: ${result.message ?? String(result.code)}`);
    return EXIT.OPERATIONAL;
  }

  const preview = result.preview;
  console.log(`structural promotion '${values.project}' ${scenarioId}`);
  console.log(`  proposed by:   ${name} (${PROPOSER_ACTOR_TYPE})`);
  console.log(`  base revision: ${preview.meta.baseRevision === null ? 'null' : preview.meta.baseRevision}`);
  console.log(`  operations:    ${result.operations.length} added, ${result.skipped.length} skipped (already in the stable graph)`);
  console.log(`  structural:    ${preview.structural.valid ? 'valid' : `${preview.structural.violations.length} blocking finding(s)`}`);
  console.log(`  status:        ${preview.stale ? 'PROMOTION_STALE (rebase before apply)' : 'current'}`);
  // The binding-resolved shape the skills teach (init Step 6, new-surface step 8): post-init the
  // committed `.formula/config.json` binding carries the project id, so no --project flag rides.
  console.log(`  next:          steepy-formula promotion preview ${scenarioId}`);
  return EXIT.OK;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`steepy structural-promotion: ${error?.message ?? String(error)}`);
      process.exit(EXIT.OPERATIONAL);
    });
}
