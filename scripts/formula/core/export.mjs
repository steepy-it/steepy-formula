// Signed export, restore and retention for the Stable Knowledge Graph (spec
// .apex/work/specs/2026-08-11-stable-knowledge-graph.md §22 "Backup and disaster recovery",
// success criteria 9 and 14). This is the "the database can be deleted and rebuilt" guarantee:
// a portable dump of everything a fresh port needs to reconstruct the same stable state, plus a
// pure retention decision function so old exports can be pruned deterministically.
//
//   buildExportArtifact(port, { projectId, clock? })  -> { header, records, trailer, text }
//   exportGraph(port, { projectId, filePath, clock?, fs? }) -> { ok, filePath, projectId,
//                                                                 headRevision, digest, counts }
//   parseExportArtifact(text)                          -> { ok, violations, header, records, trailer }
//   importGraph(port, { filePath | text, fs? })        -> { ok, violations, headRevision, counts, projectId }
//   pruneExports(listing, config)                      -> { keep: [name...], drop: [name...] }   // pure
//   pruneExportDirectory(directory, config, { fs? })   -> { keep, drop }                          // thin fs wrapper
//
// PORT-ONLY I/O for the graph read/write (spec §20): `buildExportArtifact` and the writing half
// of `importGraph` touch nothing but the B3 port API inside ONE transaction, so an export taken
// off the memory adapter restores identically off ArcadeDB. The ONLY filesystem access in this
// module is the artifact bytes themselves (`exportGraph`/`importGraph`) and the retention
// wrapper (`pruneExportDirectory`) — that is this module's job (spec §22: "the core
// automatically writes the signed export"), and both fs surfaces are injectable so the suite
// never has to touch the real disk to prove the decision logic.
//
// ---------------------------------------------------------------------------------------------
// EXPORT SCOPE (spec §22 "signed export ... full stable graph plus Revision chain")
//
// Exactly the namespaces that constitute STABLE state: `curated`, `topology` and `system`
// (Revisions, ChangeSets, the GraphMetadata record — B5's whole audit backbone). The `scenario`
// namespace is NEVER exported: a Promotion Scenario is a disposable proposal, not applied state
// (§11), and the port offers no enumeration of open scenarios in the first place. An export is
// therefore exactly what a restore needs to reconstruct `validateGraph` + `verifyChain` +
// `replayChain` green on a fresh port — nothing more, nothing that could re-inject a discarded
// proposal.
//
// RAW RECORDS, NOT `readChain` ENTRIES. `readChain`'s revisions carry a joined `changeSet` key
// (11 keys, not the 10-key closed `REVISION_PROPERTIES` shape) — convenient for an auditor, fatal
// for a re-import, which writes Revision nodes back with `createNode` and would fail the closed
// shape check (`MALFORMED_REVISION_RECORD`) on the way in. This module reads `system` the same
// way `curated`/`topology` are read — one untyped `listNodes`/`listEdges` pass per namespace —
// so every record it writes on import is byte-for-byte what the port itself returned, `ChangeSet`
// and `Revision` alike, `changeSet` join included nowhere.
//
// DETERMINISTIC BYTES (spec criterion 14 "declares the head revision", brief "enables diffing").
// Records are grouped by a fixed namespace order (`EXPORT_NAMESPACES`), nodes before edges within
// each, both sorted by identity — never by port-returned order, which is explicitly not part of
// the port contract (B4/B5 make the same choice for the same reason). Two exports of the same
// graph state, given the same injected clock, are byte-identical.
//
// DIGEST AND HEAD REVISION (brief: "the digest and the declared head revision live in a
// header/trailer line"). The header line names the project and the head revision this export
// represents (never a second authority — it is read straight off the `GraphMetadata` record);
// the trailer line names the sha256 digest of every line before it (header + records), computed
// over the RAW TEXT actually written, so any byte-level tampering — not just a semantic edit —
// is caught. `importGraph` recomputes and compares this digest BEFORE opening a transaction:
// mismatch is a structured violation and not one write happens.
//
// FRESH TARGET ONLY (brief: "no merge semantics in V1"). `importGraph` refuses a target where any
// of `EXPORT_NAMESPACES` already holds a node or an edge — checked inside the same transaction
// that then writes, so there is no window between the check and the write.
// ---------------------------------------------------------------------------------------------

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isValidProjectId } from './ids.mjs';
import { systemRecordId } from './validate-graph.mjs';
import { canonicalize, sha256Hex } from './revision.mjs';
import { isPortError, withTransaction } from '../engine/port.mjs';

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

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function requirePort(port, caller) {
  if (!port || typeof port.begin !== 'function') {
    throw new TypeError(`${caller} requires a port with a begin() method.`);
  }
}

// The namespace strings are the port's vocabulary (`NAMESPACES` in engine/port.mjs); spelled
// locally, exactly as B4 and B5 do, so there is one owner of the strings.
const SYSTEM_NAMESPACE = 'system';

// --- vocabulary ----------------------------------------------------------------------------------

// Bump on a breaking change to the artifact shape; `parseExportArtifact` refuses anything else
// rather than guessing at a format it was not built to read.
export const EXPORT_FORMAT_VERSION = 1;

// Fixed order: this IS the deterministic grouping the header comment promises. `scenario` is
// deliberately absent (see header) and `EXPORT_NAMESPACES` is also the set `importGraph` checks
// for freshness before writing anything.
export const EXPORT_NAMESPACES = deepFreeze(['curated', 'topology', 'system']);

export const EXPORT_VIOLATION_CODES = deepFreeze({
  UNSUPPORTED_EXPORT_FORMAT_VERSION: 'UNSUPPORTED_EXPORT_FORMAT_VERSION',
  MALFORMED_EXPORT_ARTIFACT: 'MALFORMED_EXPORT_ARTIFACT',
  EXPORT_DIGEST_MISMATCH: 'EXPORT_DIGEST_MISMATCH',
  NON_EMPTY_IMPORT_TARGET: 'NON_EMPTY_IMPORT_TARGET',
});

// --- reading the graph (port API only, one transaction) -------------------------------------------

// Reads every namespace that constitutes stable state, in the fixed export order, nodes sorted by
// id then edges sorted by (type, fromId, toId) — deterministic regardless of what order the
// adapter returned them in (`listNodes`/`listEdges` order is explicitly not part of the port
// contract, same rationale as B4's `readGraph` and B5's chain reads).
async function readExportRecords(tx, projectId) {
  const records = [];
  let nodeCount = 0;
  let edgeCount = 0;

  for (const namespace of EXPORT_NAMESPACES) {
    const nodes = [...(await tx.listNodes({ namespace }))].sort((a, b) => compareStrings(a.id, b.id));
    for (const node of nodes) {
      records.push({ recordType: 'node', namespace: node.namespace, type: node.type, id: node.id, properties: node.properties });
      nodeCount += 1;
    }

    const edges = [...(await tx.listEdges({ namespace }))].sort((a, b) =>
      compareStrings(`${a.type} ${a.fromId} ${a.toId}`, `${b.type} ${b.fromId} ${b.toId}`),
    );
    for (const edge of edges) {
      records.push({ recordType: 'edge', namespace: edge.namespace, type: edge.type, fromId: edge.fromId, toId: edge.toId });
      edgeCount += 1;
    }
  }

  const metadata = await tx.getNode({ namespace: SYSTEM_NAMESPACE, id: systemRecordId(projectId) });
  const headRevision = metadata?.properties?.headRevision ?? null;
  return { records, headRevision, counts: { nodes: nodeCount, edges: edgeCount } };
}

// --- building the artifact (pure once the port read is done) --------------------------------------

const BUILD_INPUT_KEYS = deepFreeze(['projectId', 'clock']);

function defaultClock() {
  return new Date().toISOString();
}

// Programmer-error throws only (no port, no/invalid projectId, an unknown input key, a
// non-function clock) — never on graph content, matching B4/B5's convention.
function normalizeExportInput(input, caller) {
  if (!isPlainObject(input)) {
    throw new TypeError(`${caller} requires an input object with a projectId.`);
  }
  for (const key of Object.keys(input)) {
    if (!BUILD_INPUT_KEYS.includes(key)) {
      throw new TypeError(`${caller}: unknown input key '${key}'; accepted: ${BUILD_INPUT_KEYS.join(', ')}.`);
    }
  }
  if (!isValidProjectId(input.projectId)) {
    throw new TypeError(`${caller} requires a valid projectId, got ${JSON.stringify(input.projectId ?? null)}.`);
  }
  const clock = input.clock ?? defaultClock;
  if (typeof clock !== 'function') {
    throw new TypeError(`${caller}: clock must be a function returning an ISO-8601 timestamp string.`);
  }
  return { projectId: input.projectId, clock };
}

// Builds the whole artifact — header, ordered records, trailer and the exact text `exportGraph`
// writes to disk — from one consistent snapshot of the port. Pure beyond that read: no filesystem,
// so this is what the suite drives to prove determinism and digest correctness without touching
// disk at all.
export async function buildExportArtifact(port, input = {}) {
  requirePort(port, 'buildExportArtifact');
  const { projectId, clock } = normalizeExportInput(input, 'buildExportArtifact');

  const { records, headRevision, counts } = await withTransaction(port, (tx) => readExportRecords(tx, projectId));

  const header = {
    recordType: 'header',
    formatVersion: EXPORT_FORMAT_VERSION,
    projectId,
    headRevision,
    exportedAt: clock(),
    counts,
  };

  const headerLine = canonicalize(header);
  const recordLines = records.map((record) => canonicalize(record));
  const digest = sha256Hex([headerLine, ...recordLines].join('\n'));
  const trailer = { recordType: 'trailer', digest };

  const text = `${[headerLine, ...recordLines, canonicalize(trailer)].join('\n')}\n`;

  return { header, records, trailer, text };
}

// --- exporting to disk (thin, injectable fs) -------------------------------------------------------

const EXPORT_GRAPH_INPUT_KEYS = deepFreeze([...BUILD_INPUT_KEYS, 'filePath', 'fs']);

function normalizeExportGraphInput(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('exportGraph requires an input object with a projectId and filePath.');
  }
  for (const key of Object.keys(input)) {
    if (!EXPORT_GRAPH_INPUT_KEYS.includes(key)) {
      throw new TypeError(`exportGraph: unknown input key '${key}'; accepted: ${EXPORT_GRAPH_INPUT_KEYS.join(', ')}.`);
    }
  }
  if (typeof input.filePath !== 'string' || input.filePath === '') {
    throw new TypeError('exportGraph requires a non-empty filePath to write the artifact to.');
  }
  const { projectId, clock } = normalizeExportInput({ projectId: input.projectId, clock: input.clock }, 'exportGraph');
  const fs = input.fs ?? { writeFileSync };
  if (typeof fs.writeFileSync !== 'function') {
    throw new TypeError('exportGraph: fs.writeFileSync must be a function.');
  }
  return { projectId, clock, filePath: input.filePath, fs };
}

// Writes the export artifact for `projectId` to `filePath`. This is the export-on-promotion hook
// point (spec §22): D5 calls this once, after every approved promotion, with a real filesystem;
// the suite calls it with an injected `fs` so no test needs a real disk. Returns the same summary
// a caller would want to log or feed into `pruneExportDirectory`'s listing.
export async function exportGraph(port, input = {}) {
  const { filePath, fs, ...artifactInput } = normalizeExportGraphInput(input);
  const artifact = await buildExportArtifact(port, artifactInput);
  fs.writeFileSync(filePath, artifact.text, 'utf8');
  return {
    ok: true,
    filePath,
    projectId: artifact.header.projectId,
    headRevision: artifact.header.headRevision,
    digest: artifact.trailer.digest,
    counts: artifact.header.counts,
  };
}

// --- parsing and verifying an artifact (pure, no fs) ------------------------------------------------

function parseJsonLine(line, label) {
  let value;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return { ok: false, violation: violation(EXPORT_VIOLATION_CODES.MALFORMED_EXPORT_ARTIFACT, `The ${label} line is not valid JSON: ${error.message}.`, { label }) };
  }
  if (!isPlainObject(value)) {
    return { ok: false, violation: violation(EXPORT_VIOLATION_CODES.MALFORMED_EXPORT_ARTIFACT, `The ${label} line must be a JSON object.`, { label }) };
  }
  return { ok: true, value };
}

const invalid = (violations) => ({ ok: false, violations, header: null, records: [], trailer: null });

// Parses and verifies a JSONL export artifact end to end: shape, format version, per-record
// legality of `recordType`, and finally the digest — computed over the RAW TEXT of every line
// before the trailer, so any byte-level edit (not just a semantic one) is caught. Never throws on
// a malformed artifact; a hand-corrupted file is data, not a crash.
export function parseExportArtifact(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseExportArtifact requires a string artifact.');
  }

  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines.length < 2) {
    return invalid([
      violation(EXPORT_VIOLATION_CODES.MALFORMED_EXPORT_ARTIFACT, 'An export artifact must contain at least a header line and a trailer line.', {}),
    ]);
  }

  const headerLine = lines[0];
  const trailerLine = lines[lines.length - 1];
  const recordLines = lines.slice(1, -1);

  const header = parseJsonLine(headerLine, 'header');
  const trailer = parseJsonLine(trailerLine, 'trailer');
  const shapeViolations = [];
  if (!header.ok) shapeViolations.push(header.violation);
  if (!trailer.ok) shapeViolations.push(trailer.violation);
  if (shapeViolations.length > 0) return invalid(shapeViolations);

  if (header.value.recordType !== 'header') {
    shapeViolations.push(
      violation(EXPORT_VIOLATION_CODES.MALFORMED_EXPORT_ARTIFACT, `Expected the first line to be a 'header' record, got ${JSON.stringify(header.value.recordType)}.`, {}),
    );
  }
  if (trailer.value.recordType !== 'trailer' || typeof trailer.value.digest !== 'string') {
    shapeViolations.push(
      violation(EXPORT_VIOLATION_CODES.MALFORMED_EXPORT_ARTIFACT, "Expected the last line to be a 'trailer' record carrying a string digest.", {}),
    );
  }
  if (shapeViolations.length > 0) return invalid(shapeViolations);

  if (header.value.formatVersion !== EXPORT_FORMAT_VERSION) {
    return invalid([
      violation(
        EXPORT_VIOLATION_CODES.UNSUPPORTED_EXPORT_FORMAT_VERSION,
        `Export format version ${JSON.stringify(header.value.formatVersion)} is not supported (this build reads version ${EXPORT_FORMAT_VERSION}).`,
        { formatVersion: header.value.formatVersion, supportedVersion: EXPORT_FORMAT_VERSION },
      ),
    ]);
  }

  const records = [];
  const recordViolations = [];
  recordLines.forEach((line, index) => {
    const parsed = parseJsonLine(line, `record ${index}`);
    if (!parsed.ok) {
      recordViolations.push(parsed.violation);
      return;
    }
    if (parsed.value.recordType !== 'node' && parsed.value.recordType !== 'edge') {
      recordViolations.push(
        violation(
          EXPORT_VIOLATION_CODES.MALFORMED_EXPORT_ARTIFACT,
          `Record ${index} has unknown recordType ${JSON.stringify(parsed.value.recordType)}; expected 'node' or 'edge'.`,
          { index },
        ),
      );
      return;
    }
    records.push(parsed.value);
  });
  if (recordViolations.length > 0) return invalid(recordViolations);

  const computedDigest = sha256Hex([headerLine, ...recordLines].join('\n'));
  if (computedDigest !== trailer.value.digest) {
    return invalid([
      violation(
        EXPORT_VIOLATION_CODES.EXPORT_DIGEST_MISMATCH,
        `The export artifact's content digest does not match its trailer: expected ${trailer.value.digest}, computed ${computedDigest}. Refusing to import.`,
        { expectedDigest: trailer.value.digest, computedDigest },
      ),
    ]);
  }

  return { ok: true, violations: [], header: header.value, records, trailer: trailer.value };
}

// --- importing into a fresh port --------------------------------------------------------------------

// Carries a pre-write refusal (non-empty target) out through `withTransaction`, which rolls back
// on any throw. Module-private, same shape as B5's `ApplyRejection`: callers see violations, not
// this class.
class ImportRejection extends Error {
  constructor(violations) {
    super(violations[0]?.message ?? 'Import rejected.');
    this.name = 'ImportRejection';
    this.violations = violations;
  }
}

const IMPORT_INPUT_KEYS = deepFreeze(['filePath', 'text', 'fs']);

function normalizeImportInput(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('importGraph requires an input object with exactly one of filePath or text.');
  }
  for (const key of Object.keys(input)) {
    if (!IMPORT_INPUT_KEYS.includes(key)) {
      throw new TypeError(`importGraph: unknown input key '${key}'; accepted: ${IMPORT_INPUT_KEYS.join(', ')}.`);
    }
  }
  const hasFilePath = typeof input.filePath === 'string' && input.filePath !== '';
  const hasText = typeof input.text === 'string';
  if (hasFilePath === hasText) {
    throw new TypeError('importGraph requires exactly one of filePath or text.');
  }
  const fs = input.fs ?? { readFileSync };
  if (hasFilePath && typeof fs.readFileSync !== 'function') {
    throw new TypeError('importGraph: fs.readFileSync must be a function.');
  }
  return { filePath: hasFilePath ? input.filePath : null, text: hasText ? input.text : null, fs };
}

const emptyImportResult = (violations) => ({ ok: false, violations, headRevision: null, counts: null, projectId: null });

// Verifies the digest BEFORE touching the port at all (brief: "Import verifies digest before
// writing anything; mismatch -> structured error, no writes"), then imports into a FRESH port
// only: any of `EXPORT_NAMESPACES` already holding a node or edge is refused with
// `NON_EMPTY_IMPORT_TARGET` and, again, no write happens — the freshness check and every
// `createNode`/`createEdge` run inside the SAME transaction, so there is no merge semantics and
// no window between the check and the write (V1 has no update/merge path by design).
export async function importGraph(port, input = {}) {
  requirePort(port, 'importGraph');
  const { filePath, text: providedText, fs } = normalizeImportInput(input);
  const text = providedText ?? fs.readFileSync(filePath, 'utf8');

  const parsed = parseExportArtifact(text);
  if (!parsed.ok) return emptyImportResult(parsed.violations);

  const { header, records } = parsed;

  try {
    await withTransaction(port, async (tx) => {
      const nonEmpty = [];
      for (const namespace of EXPORT_NAMESPACES) {
        const [nodes, edges] = await Promise.all([tx.listNodes({ namespace }), tx.listEdges({ namespace })]);
        if (nodes.length > 0 || edges.length > 0) nonEmpty.push(namespace);
      }
      if (nonEmpty.length > 0) {
        throw new ImportRejection([
          violation(
            EXPORT_VIOLATION_CODES.NON_EMPTY_IMPORT_TARGET,
            `Refusing to import into a non-empty target: namespace(s) ${nonEmpty.join(', ')} already hold records. importGraph only writes into a fresh port — there is no merge semantics in V1.`,
            { namespaces: nonEmpty },
          ),
        ]);
      }

      // ALL nodes before ALL edges, never record order. `readExportRecords` groups records by
      // namespace (nodes then edges per namespace, `EXPORT_NAMESPACES` order), so a curated-home
      // bridge edge (APPLIES_TO whose endpoint is a topology Package) sits in the curated block
      // that precedes every topology node — creating edges in record order fails
      // EDGE_ENDPOINT_MISSING on exactly the cross-namespace edges a real graph carries (surfaced
      // by the E2 restore drill). The artifact is a whole-graph snapshot, so endpoint existence is
      // guaranteed by construction; the only correct order is nodes-then-edges, inside the same
      // transaction as the freshness check.
      for (const record of records) {
        if (record.recordType !== 'node') continue;
        await tx.createNode({ namespace: record.namespace, type: record.type, id: record.id, properties: record.properties });
      }
      for (const record of records) {
        if (record.recordType !== 'edge') continue;
        await tx.createEdge({ namespace: record.namespace, type: record.type, fromId: record.fromId, toId: record.toId });
      }
    });
  } catch (error) {
    if (error instanceof ImportRejection) return emptyImportResult(error.violations);
    if (isPortError(error)) return emptyImportResult([violation(error.code, error.message, error.identity)]);
    throw error;
  }

  return { ok: true, violations: [], headRevision: header.headRevision, counts: header.counts, projectId: header.projectId };
}

// --- retention (spec §22 "retention configurable ... last N plus one per day") ---------------------

const RETENTION_KEYS = deepFreeze(['keepLast', 'keepDaily']);

function normalizeRetentionConfig(config) {
  if (!isPlainObject(config)) {
    throw new TypeError('pruneExports requires a config object { keepLast, keepDaily }.');
  }
  for (const key of Object.keys(config)) {
    if (!RETENTION_KEYS.includes(key)) {
      throw new TypeError(`pruneExports: unknown config key '${key}'; accepted: ${RETENTION_KEYS.join(', ')}.`);
    }
  }
  const { keepLast = 0, keepDaily = false } = config;
  if (!Number.isInteger(keepLast) || keepLast < 0) {
    throw new TypeError('pruneExports: config.keepLast must be a non-negative integer.');
  }
  if (typeof keepDaily !== 'boolean') {
    throw new TypeError('pruneExports: config.keepDaily must be a boolean.');
  }
  return { keepLast, keepDaily };
}

// The UTC calendar date an ISO-8601 timestamp falls on — the unit "one per day" is measured in.
function dayOf(timestamp) {
  return timestamp.slice(0, 10);
}

// Pure retention decision: given a listing of `{ name, timestamp }` (timestamps arrive as DATA —
// from an export's own `exportedAt`, never measured against the current clock here, so this
// function is deterministic and unit-testable without any clock dependence) and a config
// `{ keepLast, keepDaily }`, decides which exports to keep. "Last N plus one per day" (spec §22
// example): the `keepLast` most recent exports are always kept; when `keepDaily` is set, every
// calendar day not already covered by that window keeps its own most-recent export too. Ties
// (same timestamp) break on `name` so the decision is reproducible run to run.
export function pruneExports(listing, config = {}) {
  if (!Array.isArray(listing)) {
    throw new TypeError('pruneExports requires a listing array of { name, timestamp } entries.');
  }
  listing.forEach((item, index) => {
    if (!isPlainObject(item) || typeof item.name !== 'string' || item.name === '' || typeof item.timestamp !== 'string' || item.timestamp === '') {
      throw new TypeError(`pruneExports: listing[${index}] must be { name: non-empty string, timestamp: non-empty string }.`);
    }
  });
  const { keepLast, keepDaily } = normalizeRetentionConfig(config);

  const byName = new Map(listing.map((item) => [item.name, item.timestamp]));
  const sorted = [...listing].sort((a, b) => compareStrings(b.timestamp, a.timestamp) || compareStrings(a.name, b.name));

  const keep = new Set(sorted.slice(0, keepLast).map((item) => item.name));

  if (keepDaily) {
    const coveredDays = new Set([...keep].map((name) => dayOf(byName.get(name))));
    for (const item of sorted) {
      const day = dayOf(item.timestamp);
      if (coveredDays.has(day)) continue;
      coveredDays.add(day);
      keep.add(item.name);
    }
  }

  return {
    keep: sorted.filter((item) => keep.has(item.name)).map((item) => item.name),
    drop: sorted.filter((item) => !keep.has(item.name)).map((item) => item.name),
  };
}

// --- retention on disk (thin, injectable fs) ---------------------------------------------------

export const EXPORT_FILE_EXTENSION = '.jsonl';

// A file's timestamp comes from ITS OWN header (`exportedAt`), never from filesystem mtime — the
// artifact metadata sourcing the brief calls for, and immune to a filesystem that does not
// preserve mtimes across a copy. A `.jsonl` file that is not one of our artifacts (or fails to
// parse) is silently skipped rather than crashing retention on an unrelated file in the directory
// — mechanism, not policy.
function readExportedAt(text) {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const parsed = parseJsonLine(firstLine, 'header');
  if (!parsed.ok || parsed.value.recordType !== 'header' || typeof parsed.value.exportedAt !== 'string') return null;
  return parsed.value.exportedAt;
}

// Lists `directory`, builds the `{ name, timestamp }` listing from each export's own header, asks
// `pruneExports` for the decision, and deletes exactly the files it names to drop. The fs surface
// is three functions, all injectable, so the suite can prove the decision is applied without
// touching the real filesystem.
export function pruneExportDirectory(directory, config, { fs = { readdirSync, readFileSync, unlinkSync } } = {}) {
  const names = fs.readdirSync(directory).filter((name) => name.endsWith(EXPORT_FILE_EXTENSION));
  const listing = [];
  for (const name of names) {
    const text = fs.readFileSync(join(directory, name), 'utf8');
    const timestamp = readExportedAt(text);
    if (timestamp === null) continue;
    listing.push({ name, timestamp });
  }

  const decision = pruneExports(listing, config);
  for (const name of decision.drop) {
    fs.unlinkSync(join(directory, name));
  }
  return decision;
}
