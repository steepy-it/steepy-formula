// Schema migration for the Stable Knowledge Graph (spec
// .formula/work/specs/2026-08-11-stable-knowledge-graph.md §27 "Schema migration"; failure table row
// "Schema version unsupported"). Task F4. The ENGINE-INDEPENDENT §27 procedure:
//
//   migrateSchema(port, { projectId, transform, options? })
//     -> { ok: true, beforeVersion, afterVersion, atomicCutover, backupEvidence, postCutover }
//      | { ok: false, code, message, violations, ... }
//
//   guard -> shadow build -> complete validation -> cutover
//
// PORT-ONLY I/O (spec §20): every graph read/write goes through the B3 port API, so this module
// runs identically on the in-memory reference adapter and on ArcadeDB. What the port API cannot do
// — open a second database, run an engine backup, swap a database into place — arrives through the
// injected `options` (engine-conditional hooks the CLI or a test supplies), because reaching into
// an engine module here would make the core engine-dependent. It READS the adapter's capability
// map (`port.capabilities()`) and adapts, never assuming: where `atomicCutover` is true it swaps;
// where false it REQUIRES a verified backup first and performs a transactional replace.
//
// THE §27 PROCEDURE
//   1. Guard. A graph whose system record declares an unsupported schema version is refused
//      normal operation (failure table), and migration is only the recovery path for a graph THIS
//      BUILD CAN READ — so an already-unsupported version is refused here too: the caller must
//      restore a readable export first (or use a build that reads that version). A graph that
//      declares no version at all is refused the same way (there is nothing to migrate).
//   2. Shadow build. A full copy of the stable graph (nodes + edges + the system record — the
//      union `core/export.mjs` writes) is materialized in the shadow space and the injected
//      `transform(graph)` is applied to it. The transform contract is a whole-graph pure function:
//        graph = { nodes: [{ namespace, type, id, properties }], edges: [{ namespace, type,
//                  fromId, toId }], system: <GraphMetadata node> | null }
//      and it must return the same shape with the transformation applied. `versionBumpTransform`
//      (shipped below) is the stub contract: a schema-version bump only, the transform the CLI's
//      `--to <version>` flag wires in. The tests inject real transforms (a property rename).
//   3. Complete validation. B4 `validateGraph` judges the SHADOW graph; the chain replay's
//      findings are carried as post-cutover evidence (a content transform legitimately diverges
//      from what the chain explains — the schema version is the graph's own record of that). A
//      dirty transform aborts here, before anything touches the primary.
//   4. Cutover. The engine decides (below), then the migrated graph is re-validated on the
//      primary and the chain replay is reported.
//
// INTERRUPTION SAFETY (the spec integration boundary). An interruption BEFORE cutover leaves the
// primary untouched and consistent (the shadow space is discarded). The cutover itself MUST be
// structured so the worst case is "old graph intact + verified backup exists", and this module
// makes that a contract on the injected hook: where `atomicCutover` is false a verified backup (a
// integrity-checked export whose digest validation passed) is REQUIRED first and carried in the result as the
// recovery path. This module also ships the transactional replace (`replacePrimaryFromArtifact`) —
// clear the stable namespaces and re-import the transformed graph in ONE transaction, so an
// interruption rolls back to the old graph. It is the cutover mechanism on the in-memory reference
// adapter. MEASURED on the pinned ArcadeDB release, the same replace is NOT usable there: the
// engine refuses to delete and re-create the same edge within one transaction (its unique @out/@in
// edge index is not released until commit), so the ArcadeDB cutover hook uses the brief's
// drop/recreate/import mechanism instead (verified backup first, then drop/create/import the
// transformed graph) — on interruption the primary is restorable from that backup. The module
// READs the capability map and never assumes which mechanism an engine permits; the hook owns the
// engine-specific choice.
//
// This module exports no error constants that collide with B4/B5: `UNSUPPORTED_SCHEMA_VERSION`
// here is the MIGRATION guard's code (the current graph cannot be read), while B4's same-named
// code is the validator's finding — both spell the failure-table row, from the two sides of it.

import { isValidProjectId } from './ids.mjs';
import { EXPORT_NAMESPACES, buildExportArtifact, parseExportArtifact } from './export.mjs';
import { GRAPH_SCHEMA_VERSION, isSupportedSchemaVersion } from './ontology.mjs';
import { SYSTEM_RECORD_TYPE, systemRecordId, validateGraph } from './validate-graph.mjs';
import { replayChain } from './revision.mjs';
import { withTransaction } from '../engine/port.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function violation(code, message, identity) {
  return { code, message, identity };
}

// --- vocabulary ----------------------------------------------------------------------------------

const SYSTEM_NAMESPACE = 'system';

export const MIGRATE_ERROR_CODES = deepFreeze({
  UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_SCHEMA_VERSION',
  SCHEMA_VERSION_MISSING: 'SCHEMA_VERSION_MISSING',
  SHADOW_VALIDATION_FAILED: 'SHADOW_VALIDATION_FAILED',
  VERIFIED_BACKUP_REQUIRED: 'VERIFIED_BACKUP_REQUIRED',
  VERIFIED_BACKUP_FAILED: 'VERIFIED_BACKUP_FAILED',
  CUTOVER_FAILED: 'CUTOVER_FAILED',
});

// --- input contract ------------------------------------------------------------------------------

const INPUT_KEYS = deepFreeze(['projectId', 'transform', 'options']);
const OPTION_KEYS = deepFreeze(['openShadow', 'closeShadow', 'backup', 'cutover']);

function requirePort(port, caller) {
  if (!port || typeof port.begin !== 'function') {
    throw new TypeError(`${caller} requires a port with a begin() method.`);
  }
}

function normalizeInput(port, input) {
  requirePort(port, 'migrateSchema');
  if (!isPlainObject(input)) {
    throw new TypeError('migrateSchema requires an input object with a projectId, transform and options.');
  }
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.includes(key)) {
      throw new TypeError(`migrateSchema: unknown input key '${key}'; accepted: ${INPUT_KEYS.join(', ')}.`);
    }
  }
  if (!isValidProjectId(input.projectId)) {
    throw new TypeError(`migrateSchema requires a valid projectId, got ${JSON.stringify(input.projectId ?? null)}.`);
  }
  if (typeof input.transform !== 'function') {
    throw new TypeError('migrateSchema requires a transform(graph) function — the whole-graph transform the shadow build applies.');
  }
  const options = input.options ?? {};
  if (!isPlainObject(options)) {
    throw new TypeError('migrateSchema: options must be a plain object of engine-conditional hooks.');
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) {
      throw new TypeError(`migrateSchema: unknown option '${key}'; accepted: ${OPTION_KEYS.join(', ')}.`);
    }
  }
  for (const key of OPTION_KEYS) {
    if (options[key] !== undefined && typeof options[key] !== 'function') {
      throw new TypeError(`migrateSchema: option '${key}' must be a function.`);
    }
  }
  return { projectId: input.projectId, transform: input.transform, options };
}

// --- reading the current schema version (the guard's fact) ----------------------------------------

// Returns the system record's declared `schemaVersion`, or null when the graph declares none (no
// record, or a record without the property). Exported so the CLI's normal-command refusal guard
// reads the same fact the same way.
export async function readSchemaVersion(port, projectId) {
  requirePort(port, 'readSchemaVersion');
  if (!isValidProjectId(projectId)) {
    throw new TypeError(`readSchemaVersion requires a valid projectId, got ${JSON.stringify(projectId)}.`);
  }
  const system = await withTransaction(port, (tx) =>
    tx.getNode({ namespace: SYSTEM_NAMESPACE, id: systemRecordId(projectId) }),
  );
  return system?.properties?.schemaVersion ?? null;
}

function refusal(code, message, violations = [], extra = {}) {
  return { ok: false, code, message, violations, ...extra };
}

// --- shadow build --------------------------------------------------------------------------------

// Rebuilds the full stable graph (export records -> port record shapes) plus the GraphMetadata
// node as the transform's convenience `system` field. The transform operates on the whole copy —
// nodes, edges and the system record alike — which is exactly the §27 "full copy of the stable
// graph (nodes + edges + system record)".
function graphFromRecords(records) {
  const nodes = [];
  const edges = [];
  for (const record of records) {
    if (record.recordType === 'node') {
      nodes.push({ namespace: record.namespace, type: record.type, id: record.id, properties: record.properties });
    } else {
      edges.push({ namespace: record.namespace, type: record.type, fromId: record.fromId, toId: record.toId });
    }
  }
  const system = nodes.find((node) => node.namespace === SYSTEM_NAMESPACE && node.type === SYSTEM_RECORD_TYPE) ?? null;
  return { nodes, edges, system };
}

function graphVersion(graph) {
  const system = graph.nodes.find((node) => node.namespace === SYSTEM_NAMESPACE && node.type === SYSTEM_RECORD_TYPE);
  return system?.properties?.schemaVersion;
}

function applyTransform(transform, graph) {
  let transformed;
  try {
    transformed = transform(graph);
  } catch (error) {
    throw new Error(`migrateSchema: the transform threw while building the shadow graph: ${error.message}`);
  }
  if (!isPlainObject(transformed) || !Array.isArray(transformed.nodes) || !Array.isArray(transformed.edges)) {
    throw new TypeError('migrateSchema: transform must return { nodes: [...], edges: [...] } — a full transformed copy of the graph.');
  }
  return { nodes: transformed.nodes, edges: transformed.edges, system: transformed.system ?? graph.system };
}

// Writes the transformed graph into the shadow space in one transaction: all nodes before all
// edges (the E2 restore-drill lesson — a bridge edge's far endpoint must exist first).
async function writeGraph(port, graph) {
  await withTransaction(port, async (tx) => {
    for (const node of graph.nodes) {
      await tx.createNode({ namespace: node.namespace, type: node.type, id: node.id, properties: node.properties });
    }
    for (const edge of graph.edges) {
      await tx.createEdge({ namespace: edge.namespace, type: edge.type, fromId: edge.fromId, toId: edge.toId });
    }
  });
}

// --- the transactional replace (the non-atomic cutover mechanism) ----------------------------------

// Clears the stable namespaces of `port` and imports `artifact`'s records in ONE transaction. This
// is what makes the during-cutover worst case "old graph intact" instead of a half-migrated
// primary: an interruption (any throw — a failed create, an aborted process before commit) rolls
// the whole replace back to the old graph. It is the cutover mechanism for adapters that release
// index entries within a transaction (the in-memory reference adapter is one; see the header note
// on the measured ArcadeDB limitation). The verified backup (REQUIRED where `atomicCutover` is
// false) is the recovery path on every engine. Exported because the CLI and the suites share
// exactly this mechanism.
export async function replacePrimaryFromArtifact(port, artifact, projectId) {
  requirePort(port, 'replacePrimaryFromArtifact');
  if (!artifact || !Array.isArray(artifact.records)) {
    throw new TypeError('replacePrimaryFromArtifact requires an artifact from buildExportArtifact with a records array.');
  }
  if (!isValidProjectId(projectId)) {
    throw new TypeError(`replacePrimaryFromArtifact requires a valid projectId, got ${JSON.stringify(projectId)}.`);
  }
  await withTransaction(port, async (tx) => {
    for (const namespace of EXPORT_NAMESPACES) {
      for (const edge of await tx.listEdges({ namespace })) {
        await tx.deleteEdge({ namespace, type: edge.type, fromId: edge.fromId, toId: edge.toId });
      }
    }
    for (const namespace of EXPORT_NAMESPACES) {
      for (const node of await tx.listNodes({ namespace })) {
        await tx.deleteNode({ namespace, id: node.id });
      }
    }
    for (const record of artifact.records) {
      if (record.recordType !== 'node') continue;
      await tx.createNode({ namespace: record.namespace, type: record.type, id: record.id, properties: record.properties });
    }
    for (const record of artifact.records) {
      if (record.recordType !== 'edge') continue;
      await tx.createEdge({ namespace: record.namespace, type: record.type, fromId: record.fromId, toId: record.toId });
    }
  });
}

// --- the version-bump transform stub --------------------------------------------------------------

// The shipped transform stub (its contract, recorded): a pure whole-graph transform that bumps
// every system `GraphMetadata` record's `schemaVersion` to `targetVersion` and changes nothing
// else. `--to 1` (the CLI default, the current GRAPH_SCHEMA_VERSION) is therefore an idempotent
// no-op bump; `--to <v>` for any other version produces a shadow graph this build cannot validate,
// which aborts the migration at the validation gate — exactly the "dirty transform" safety the
// tests assert. Future builds ship the real version-2 transform here.
export function versionBumpTransform(targetVersion) {
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new TypeError(`versionBumpTransform requires a positive integer target version, got ${JSON.stringify(targetVersion)}.`);
  }
  return (graph) => ({
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.namespace === SYSTEM_NAMESPACE && node.type === SYSTEM_RECORD_TYPE
        ? { ...node, properties: { ...(node.properties ?? {}), schemaVersion: targetVersion } }
        : node,
    ),
  });
}

// --- the §27 procedure ----------------------------------------------------------------------------

// options:
//   openShadow   async () -> shadowPort        the engine-conditional shadow space (a second
//                                               database for ArcadeDB, a second memory port for the
//                                               reference adapter)
//   closeShadow  async (shadowPort) -> void    cleanup; called on EVERY path (success and refusal),
//                                               so a shadow database never leaks
//   backup       async () -> { ok, text, filePath?, ... }   REQUIRED when atomicCutover is false:
//                                               an integrity-checked export whose digest validation passes (the
//                                               "verified backup" of §27). Extra fields ride along in
//                                               the result's backupEvidence.
//   cutover      async (shadowPort, { verifiedBackup }) -> { port, dispose? }   the engine-conditional
//                                               swap (atomicCutover: true) or replace (false). MUST
//                                               return the port bound to the primary; `dispose` is
//                                               called after post-cutover verification when present.
export async function migrateSchema(port, input = {}) {
  const { projectId, transform, options } = normalizeInput(port, input);

  // 1. GUARD — the failure-table row: a client on an unsupported schema version is refused normal
  //    operation, and migration is the explicit recovery path for a graph this build can READ.
  const current = await readSchemaVersion(port, projectId);
  if (current === null) {
    return refusal(
      MIGRATE_ERROR_CODES.SCHEMA_VERSION_MISSING,
      `Graph '${projectId}' declares no schema version (no ${SYSTEM_RECORD_TYPE} record '${systemRecordId(projectId)}' carrying schemaVersion ${GRAPH_SCHEMA_VERSION}); there is no graph to migrate.`,
    );
  }
  if (!isSupportedSchemaVersion(current)) {
    return refusal(
      MIGRATE_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
      `Graph schema version ${JSON.stringify(current)} is not supported (this build reads version ${GRAPH_SCHEMA_VERSION}); a graph this build cannot read cannot be migrated by it — restore a readable export first, or use a build that reads version ${JSON.stringify(current)}.`,
      [],
      { schemaVersion: current, supportedVersion: GRAPH_SCHEMA_VERSION },
    );
  }

  const capabilities = await port.capabilities();
  const atomicCutover = capabilities?.atomicCutover === true;

  // 2. SHADOW BUILD — a full copy of the stable graph in the shadow space, transformed.
  const artifact = await buildExportArtifact(port, { projectId });
  const parsed = parseExportArtifact(artifact.text);
  if (!parsed.ok) {
    throw new Error('migrateSchema: the build export artifact did not parse — programmer error.');
  }
  const graph = graphFromRecords(parsed.records);

  let transformed;
  try {
    transformed = applyTransform(transform, graph);
  } catch (error) {
    return refusal(
      MIGRATE_ERROR_CODES.SHADOW_VALIDATION_FAILED,
      error.message,
      [violation('TRANSFORM_FAILED', error.message, {})],
    );
  }

  let shadowPort = null;
  try {
    shadowPort = await options.openShadow();
    await writeGraph(shadowPort, transformed);

    // 3. COMPLETE VALIDATION — a dirty transform aborts before anything touches the primary.
    const shadowValidation = await validateGraph(shadowPort, { projectId });
    if (!shadowValidation.ok) {
      return refusal(
        MIGRATE_ERROR_CODES.SHADOW_VALIDATION_FAILED,
        `The transformed shadow graph of '${projectId}' does not validate; the primary was left untouched.`,
        shadowValidation.violations,
      );
    }

    // 4. CUTOVER — the engine decides. Where atomicCutover is false, a verified backup is REQUIRED
    //    first: the module reads the capability map and adapts, never assumes.
    let verifiedBackup = null;
    if (!atomicCutover) {
      if (typeof options.backup !== 'function') {
        return refusal(
          MIGRATE_ERROR_CODES.VERIFIED_BACKUP_REQUIRED,
          `The engine reports atomicCutover: false, so a verified backup of graph '${projectId}' is REQUIRED before the schema migration can proceed; no backup hook was provided.`,
        );
      }
      const backupResult = await options.backup();
      if (!backupResult?.ok || typeof backupResult.text !== 'string') {
        return refusal(
          MIGRATE_ERROR_CODES.VERIFIED_BACKUP_FAILED,
          `The engine backup of graph '${projectId}' did not produce a verified integrity-checked export; the migration was aborted before anything touched the primary.${backupResult?.message ? ` ${backupResult.message}` : ''}`,
          [],
          { backupFailure: backupResult ?? null },
        );
      }
      const verified = parseExportArtifact(backupResult.text);
      if (!verified.ok) {
        return refusal(
          MIGRATE_ERROR_CODES.VERIFIED_BACKUP_FAILED,
          `The engine backup of graph '${projectId}' is not a valid integrity-checked export (${verified.violations[0]?.message}); the migration was aborted.`,
          verified.violations,
        );
      }
      const { ok: _ok, text: _text, violations: _violations, ...evidence } = backupResult;
      verifiedBackup = { filePath: backupResult.filePath ?? null, digest: verified.trailer.digest, ...evidence };
    }

    let primaryPort;
    let cutoverResult;
    try {
      cutoverResult = await options.cutover(shadowPort, { verifiedBackup });
      primaryPort = cutoverResult?.port;
      if (!primaryPort) {
        throw new TypeError('the cutover hook must return { port } — the port bound to the primary graph.');
      }
    } catch (error) {
      return refusal(
        MIGRATE_ERROR_CODES.CUTOVER_FAILED,
        `The cutover of graph '${projectId}' was interrupted (${error.message}); the primary is untouched or restorable, and a verified backup exists.`,
        [],
        { backupEvidence: verifiedBackup },
      );
    }

    // 5. POST-CUTOVER VERIFICATION — the transformed graph must be B4-clean on the primary; the
    //    chain replay is carried as evidence (a content transform legitimately diverges from what
    //    the chain explains — the schema version is the graph's own record of that).
    const postValidation = await validateGraph(primaryPort, { projectId });
    if (!postValidation.ok) {
      return refusal(
        MIGRATE_ERROR_CODES.CUTOVER_FAILED,
        `The migrated graph of '${projectId}' does not validate after cutover; restore it from the verified backup.`,
        postValidation.violations,
        { backupEvidence: verifiedBackup },
      );
    }
    const chain = await replayChain(primaryPort, { projectId });

    await (cutoverResult.dispose?.() ?? Promise.resolve());

    return {
      ok: true,
      beforeVersion: current,
      afterVersion: graphVersion(transformed),
      atomicCutover,
      backupEvidence: verifiedBackup,
      postCutover: { validated: true, violations: [], chain: { ok: chain.ok, violations: chain.violations } },
    };
  } finally {
    if (shadowPort !== null) {
      await options.closeShadow(shadowPort).catch(() => {});
    }
  }
}
