#!/usr/bin/env node
// steepy-formula — the shipped binary for the Stable Knowledge Graph (spec §14; plan decision 2).
//
// THIN ADAPTER (§14): parsing + dispatch + exit codes only. Every behavior delegates to the core
// modules (engine/lifecycle.mjs, engine/arcadedb.mjs, engine/secrets.mjs, core/validate-graph.mjs,
// core/revision.mjs, core/topology.mjs, core/context-output.mjs, core/promotion.mjs) — no graph
// logic lives here.
//
// THIS CLI'S OWN EXIT-CODE TABLE (asserted by tests/formula-cli-graph.test.mjs,
// tests/formula-cli-context.test.mjs and tests/formula-schema-migrate.test.mjs — the two prior
// CLIs use 1 and 2 for usage; this one defines its own, do not assume it matches). F3 EXTENDS the
// F2 table; F4 EXTENDS the F3 table with row 24:
//   0  success
//   1  `graph validate` found blocking violations / the chain replay reported out-of-band writes /
//      `context resolve` hit GRAPH_INVALID / `graph restore` found validation or chain-replay
//      findings after import / a `graph migrate-schema` shadow graph failed validation (the
//      primary is left untouched) / a NORMAL command refused an unsupported schema version (the
//      failure table: "Refuse normal operation and require an explicit schema migration")
//   2  usage / parse error (unknown command, unknown flag, missing required argument, an invalid
//      `--project`/`STEEPY_PROJECT` id; a TypeError — programmer error — also surfaces here as an
//      explicit internal-error message)
//   3  operational failure (docker absent, server unavailable, container failed to start, the
//      refresh refused, a broken secret provider config, a missing/bad seed artifact, an
//      unreadable/invalid `.formula/config.json`, KNOWLEDGE_GRAPH_UNAVAILABLE, EXPORT_WRITE_FAILED,
//      an export/backup/restore operational failure, a restore overwrite refusal, a backup-first or
//      cutover failure in a migration, …)
//   4  NOT_FOUND / nothing to do (e.g. `graph status` on an uninitialized project, an unknown
//      promotion scenario, `promotion create` on an already-taken scenario id)
//  10  UNRESOLVED — `context resolve`: a path/target matched nothing or was ambiguous, with
//      candidates + reasons on stderr
//  11  RULE_CONFLICT — `context resolve`: applicable Rules share a concern with no OVERRIDES
//      resolution; the Rule IDs go to stderr
//  12  CONTEXT_OVERFLOW — `context resolve`: mandatory Layer 0 + Layer 1 exceed the budget
//      (`identity.measured`/`budget` on stderr); a `must` Rule is never truncated
//  20  PROMOTION_STALE — `promotion preview`/`apply`: the scenario's base revision has moved;
//      rebase/recompute before approval
//  21  declined — `promotion apply` without `--yes` and without a `y`/`yes` confirmation (the
//      refusal is always visible on stdout, never a silent no-op)
//  22  SCENARIO_INVALID — `promotion apply`: the projected graph breaks a blocking invariant
//  23  SCENARIO_EMPTY — `promotion apply`: the scenario holds no applied operations
//  24  UNSUPPORTED_SCHEMA — `graph migrate-schema` refused the migration guard: the current graph
//      declares a schema version this build cannot read (or none at all). Migration is the
//      explicit recovery path, so its refusal is a DISTINCT exit from the exit-1 refusal normal
//      commands surface for the same condition.
//
// A topology refresh failure inside a resolve reports Layer-0 `stale` and STILL resolves (D3
// semantics) — it is never a distinct exit.
//
// Commands (spec §14, §15 steps 1–2, §25, §9, §11, §22, §27):
//   steepy-formula graph init     [--project <id>] [--force]
//   steepy-formula graph validate [--project <id>] [--port memory] [--seed <file>]
//   steepy-formula graph status   [--project <id>] [--port memory] [--seed <file>] [--root <dir>]
//   steepy-formula graph refresh  [--project <id>] --root <dir> [--port memory] [--seed <file>]
//   steepy-formula graph export   [--project <id>] [--out <file>|-] [--port memory] [--seed <file>]
//   steepy-formula graph backup   [--project <id>] [--to <dir>] [--port memory] [--seed <file>]
//   steepy-formula graph restore  --project <id> --from <file> [--force] [--port memory]
//   steepy-formula graph migrate-schema --project <id> [--to <version>] [--port memory] [--seed <file>]
//   steepy-formula context resolve --project <id> (--path <p>... | --target <id>...)
//                                  [--root <dir>] [--include-rationale] [--budget <n>]
//                                  [--out <dir>|-] [--port memory] [--seed <file>]
//   steepy-formula promotion create  --project <id> --candidates <file.json> [--proposer <name>]
//                                    <scenarioId> [--port memory] [--seed <file>]
//   steepy-formula promotion preview --project <id> <scenarioId> [--port memory] [--seed <file>]
//   steepy-formula promotion apply   --project <id> <scenarioId> [--yes] [--approver <name>]
//                                    [--port memory] [--seed <file>]
//   steepy-formula promotion discard --project <id> <scenarioId> [--port memory] [--seed <file>]
//   steepy-formula hub-mode      [--project <id>] [--port memory] [--seed <file>]
//
// `graph export` (spec §22): B6 `exportGraph` writes the signed artifact (full stable graph +
// full Revision chain + head revision + digest). `--out <file>` defaults to
// `./<projectId>-export.jsonl` (recorded decision); `--out -` writes the artifact to stdout with
// the head/digest report on stderr (recorded decision), so the artifact bytes stay machine-clean.
// Exit 0 on success, 3 on operational failure.
//
// `graph backup` (spec §22, additive): the backup IS the engine-native online copy (ArcadeDB
// `BACKUP DATABASE`, capability `onlineBackup: true`) PLUS the portable signed export — recorded
// decision. The portable part runs on any port; the native part is docker-gated (reported `n/a`
// on the memory seam). Both outcomes are reported; a native failure exits 3 even though the
// portable artifact was written.
//
// `graph restore` (spec §22, criterion 9): B6 `importGraph` into the project database, then
// portable `validateGraph` + `replayChain`. Exit 0 only when both are clean; exit 1 on findings;
// import refusals (bad artifact, non-empty target) exit 3. A non-empty database is refused
// without `--force` (exit 3, recorded); with `--force` the CLI first writes a verified
// pre-restore backup, then drops/recreates the database and re-imports — and refuses to destroy
// a database it cannot first export (the exact "require the database to be restorable" refusal).
//
// `graph migrate-schema` (spec §27): the CLI over core/schema-migrate.mjs. The shipped transform
// stub is a version bump to `--to <version>` (default: the current `GRAPH_SCHEMA_VERSION`, so a
// bare `graph migrate-schema` is an idempotent, fully-validated no-op). The migration guard (the
// current graph is already unreadable) exits 24; a shadow that fails validation aborts with exit
// 1 and the primary untouched; backup-first and cutover failures exit 3. The engine-specific
// hooks (shadow database, online backup, transactional replace) are the CLI's thin glue to
// core/schema-migrate.mjs — the §27 procedure itself lives in the core.
//
// NORMAL-COMMAND SCHEMA GUARD: every read command (`validate`, `status`, `refresh`, `export`,
// `backup`) first reads the graph's system record and refuses (exit 1) when it declares an
// unsupported schema version, per the failure table. `migrate-schema` is the explicit recovery
// path and is exempt.
//
// `graph init` provisions the local engine (C1 lifecycle, docker-gated; on docker absence it exits
// 3 with the explicit diagnostic), resolves the `db-password` credential through the F1 provider
// chain (the ONLY credential source — `--password` flags are refused by not existing), verifies
// the database answers, detects Repository/Workspace/Package topology (D1), and adopts the
// `.formula/config.json` project binding (D2/D5): the binding guard refuses an explicit
// `--project`/`STEEPY_PROJECT` request that contradicts an existing binding BEFORE any engine
// work (exit 3; `--force` re-points it after provisioning succeeds). It does NOT commit
// a graph (spec §15 steps 3–9 belong to the G2 initialization skill). Re-init on an already
// provisioned project is IDEMPOTENT: `startServer` adopts the running container, the database is
// created only when absent, and the same summary is printed.
//
// `context resolve` delegates EVERYTHING to D3 `buildContextOutput` — the layers, the deterministic
// budget, the §25 digest check + refresh (only when `--root` is given) and the failure codes are
// D3/D2's, never re-derived here. It emits BOTH `context.json` (schema-versioned, first key) and
// `context.md` (its view) into `--out <dir>` (DEFAULT: the current working directory — recorded
// decision), or both to stdout under deterministic `=== context.json ===` / `=== context.md ===`
// separators when `--out -`. Filenames are deterministic: `context.json` and `context.md`.
// `--budget <n>` is the per-call override; `--include-rationale` maps to `options.includeRationale`.
//
// `promotion create/preview/apply/discard` delegate to the D5 assembly wrapper (`assembleScenario`,
// core/scenario-assembly.mjs — the typed-candidates file schema's only interpreter) and D4/D5
// `inspectScenario` / `applyPromotion` / `discardScenario` (the typed diff IS the preview report).
// `promotion create` reads the typed-candidates file, maps it per D5 and prints the created-scenario
// summary; readme candidates are reported out-of-graph for direct edit and NOTHING is applied. A
// missing/unreadable/invalid candidates file is a usage error (exit 2) carrying the wrapper's
// violation list. The PROPOSER is `{ type: 'agent-proposer', name }` — the actor type for the
// proposing side of this CLI-driven flow — where `<name>` is `--proposer <name>` if given, ELSE the
// OS user (`os.userInfo().username`), recorded decision (create never applies, so the human-approval
// boundary stays `promotion apply`). An already-taken scenario id is "nothing to do" (exit 4).
// `promotion apply` is the human-approval boundary: WITHOUT `--yes` it prompts on stdin and REFUSES
// (exit 21, visible on stdout) unless a `y`/`yes` confirmation is given. The APPROVER is typed via F1 `actor('human-approver', <name>)`
// where `<name>` is `--approver <name>` if given, ELSE the OS user (`os.userInfo().username`) —
// recorded decision. The proposer comes from the scenario meta (D5 reads it). The CLI supplies the
// provenance snapshot: `{ quotation, source: '<cli-provenance-source>', digest: sha256Hex(quotation) }`
// with the source convention `'cli:steepy-formula:<line>'` (line 1) — a `<file>:<line>`-shaped
// source per §21 — recorded decision. `promotion discard` reports exit 0 even for an unknown
// scenario (the port's discard is an idempotent no-op) — recorded decision.
//
// THE `--port memory` TEST SEAM (documented, record of plan decision): a subprocess cannot share an
// in-memory port, so the non-docker suite hands the process its graph with `--seed <file>`, an
// export artifact (core/export.mjs) imported into the fresh memory port before the command runs.
// `--seed` is memory-only — pointing it at a live engine is a usage error. The seam cannot carry a
// promotion scenario: the export deliberately excludes the `scenario` namespace (spec §11) and
// `importGraph` has no scenarioId passthrough, so the whole preview→apply→discard flow is exercised
// against the live engine (the plan's "memory-or-docker path").
//
// `hub-mode` (promotion-in-chain spec D4, plan decision 5) — the declaration every skill prose
// quotes instead of re-implementing detection (SC4, DP4): which documentation hub this repo uses
// right now. `graph` — the engine is reachable and the project initialized, and `.apex/_INDEX.md`
// is absent; `migrate` — `.apex/_INDEX.md` is present (it wins over graph), next: the
// `graph-migrate` skill; `none` — neither, next: the `init` skill. Detection lives ONLY in
// core/hub-mode.mjs (the Markdown-hub probe in core/markdown-hub.mjs) — this command parses,
// prints `hub-mode '<project>'` + a `mode:` line + exactly one `evidence:` line, then a `next:`
// line naming the core's next step for migrate and none (graph prints none), and ALWAYS exits 0:
// it is a declaration for a report, not a gate, and an unreachable engine is evidence, not a
// failure. The `--port memory`/`--seed` test seam only swaps the facts source (`portEngineFacts`
// over the seeded memory port); the mode decision never moves into the CLI.
//
// PROJECT IDENTITY (D3, plan task 2): every command resolves its project id through the fixed
// chain `--project` > `STEEPY_PROJECT` > `<cwd>/.formula/config.json` (core/project-config.mjs —
// the config root is the CWD, never `--root`) > `DEFAULT_PROJECT` ('demo', the single surviving
// literal default), and echoes exactly ONE `  project: <id> (<source>)` line per invocation with
// `source ∈ flag | env | config | fallback` (degradations are explicit) — inside the stdout report
// block, or on stderr when stdout must stay machine-clean (`graph export --out -`,
// `context resolve --out -`, `promotion preview`) or the command fails before printing a block.
// Invalid `--project`/`STEEPY_PROJECT` ids are usage errors (exit 2); config-file problems are
// operational (exit 3), never a silent fallback.
//
// SECURITY: secrets never appear in stdout/stderr. Credentials come only from the F1 provider
// chain; the only credential-related output is the redacted `describeSecret` summary and the
// provider's own warnings.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { tmpdir, userInfo } from 'node:os';
import { isValidProjectId } from './core/ids.mjs';
import { SERVER_STATUS, containerNameFor, serverStatus, startServer } from './engine/lifecycle.mjs';
import { createArcadeDbPort, createDatabase, databaseNameFor, dropDatabase, listDatabases, runSql } from './engine/arcadedb.mjs';
import { actor, describeSecret, resolveDatabaseSecret } from './engine/secrets.mjs';
import { createMemoryPort } from './engine/memory.mjs';
import { withTransaction } from './engine/port.mjs';
import { systemRecordId, validateGraph } from './core/validate-graph.mjs';
import { GRAPH_SCHEMA_VERSION, isSupportedSchemaVersion } from './core/ontology.mjs';
import { readChain, replayChain, sha256Hex } from './core/revision.mjs';
import { TOPOLOGY_CODES, detectTopology, readTopologyDigest, refreshTopology } from './core/topology.mjs';
import { EXPORT_VIOLATION_CODES, buildExportArtifact, exportGraph, importGraph, parseExportArtifact } from './core/export.mjs';
import {
  MIGRATE_ERROR_CODES,
  migrateSchema,
  readSchemaVersion,
  replacePrimaryFromArtifact,
  versionBumpTransform,
} from './core/schema-migrate.mjs';
import { RESOLVE_ERROR_CODES } from './core/resolve-context.mjs';
import { CONTEXT_OUTPUT_ERROR_CODES, buildContextOutput } from './core/context-output.mjs';
import { PROMOTION_ERROR_CODES, applyPromotion, discardScenario, inspectScenario } from './core/promotion.mjs';
import { SCENARIO_ASSEMBLY_ERROR_CODES, assembleScenario } from './core/scenario-assembly.mjs';
import { detectHubMode, portEngineFacts } from './core/hub-mode.mjs';
import { MARKDOWN_HUB_ENTRY } from './core/markdown-hub.mjs';
import { adoptProjectBinding, readProjectConfig } from './core/project-config.mjs';

const EXIT = {
  OK: 0,
  VALIDATE_FAILED: 1,
  USAGE: 2,
  OPERATIONAL: 3,
  NOT_FOUND: 4,
  UNRESOLVED: 10,
  RULE_CONFLICT: 11,
  CONTEXT_OVERFLOW: 12,
  PROMOTION_STALE: 20,
  DECLINED: 21,
  SCENARIO_INVALID: 22,
  SCENARIO_EMPTY: 23,
  UNSUPPORTED_SCHEMA: 24,
};

const DEFAULT_PROJECT = 'demo';

// The CLI's provenance-source convention for `promotion apply` (recorded decision): a §21-shaped
// `<file>:<line>` source naming the CLI itself — `cli:steepy-formula` is the "file", line 1 is the
// fixed approval-event line. The digest is `sha256Hex(quotation)`.
const CLI_PROVENANCE_SOURCE = 'cli:steepy-formula:1';

// The two namespaces whose union IS the stable graph (B4's read scope).
const STABLE_NAMESPACES = ['curated', 'topology'];

const USAGE = `usage: steepy-formula <graph|context|promotion> <command> [options]
       steepy-formula hub-mode [--project <id>] [--port memory] [--seed <file>]

graph:
  init     provision the local engine, resolve credentials, detect topology and adopt the
           .formula/config.json binding (docker-gated; --force re-points a mismatched binding)
  validate validate the portable graph invariants and replay the revision chain (exit 1 on faults)
  status   report the server status, initialization, head revision and counts (exit 4 when none)
  refresh  refresh the observed topology on demand (spec §25)
  export   write the signed export artifact to --out <file> (default ./<projectId>-export.jsonl)
           or stdout with --out -; reports the head revision + digest
  backup   the engine-native online backup (docker-gated) PLUS the portable signed export
  restore  import a signed export --from <file>, then validate + replay the chain (--force
           overwrites a non-empty database after a verified pre-restore backup)
  migrate-schema  run the §27 shadow schema migration (guard, shadow build, validation, cutover);
           --to <version> sets the target version (default: the current schema version)

context:
  resolve  --project <id> --path <p>... | --target <id>... [--root <dir>]
           [--include-rationale] [--budget <n>] [--out <dir>|-] [--port memory] [--seed <file>]
           emit context.json + context.md (schema-versioned) for the resolved path/target set

promotion:
  create   --project <id> --candidates <file.json> [--proposer <name>] <scenarioId>
           [--port memory] [--seed <file>]
           map a typed-candidates file into a draft promotion scenario (terms/rules/decisions
           become graph operations, readme notes are reported out-of-graph; nothing is applied)
  preview  --project <id> <scenarioId> [--port memory] [--seed <file>]
           print the typed diff report (previewable scenarios exit 0)
  apply    --project <id> <scenarioId> [--yes] [--approver <name>] [--port memory] [--seed <file>]
           the human-approval boundary: prompts unless --yes, refuses without confirmation
  discard  --project <id> <scenarioId> [--port memory] [--seed <file>]
           idempotent discard of a proposal (unknown scenario is a no-op, exit 0)

hub-mode (top level, no subcommand):
  hub-mode  declare this repo's documentation-hub mode — 'graph' (engine reachable +
            initialized, .apex/_INDEX.md absent), 'migrate' (.apex/_INDEX.md present; next:
            the graph-migrate skill) or 'none' (next: the init skill) — with one evidence
            line and, for migrate and none, one next line; ALWAYS exit 0 (a declaration for
            reports, not a gate; an unreachable engine is evidence, not a failure)

common options:
  --project <id>  project id (flag > STEEPY_PROJECT env > .formula/config.json > demo)
  --root <dir>    repository root to observe (required for graph refresh; enables the §25 digest
                  check + refresh in context resolve)
  --port <name>   test seam: 'memory' uses the in-memory reference port (default: the local engine)
  --seed <file>   test seam: import an export artifact into the memory port first (memory-only)

exit codes: 0 success · 1 validate failed / graph invalid / restore findings / normal-command
            schema refusal / shadow validation failed · 2 usage/parse error ·
            3 operational failure · 4 nothing to do / not found ·
            10 unresolved · 11 rule conflict · 12 context overflow ·
            20 promotion stale · 21 promotion declined · 22 scenario invalid · 23 scenario empty ·
            24 migration guard refused (unsupported schema version)`;

// --- error shapes --------------------------------------------------------------------------------

class UsageError extends Error {}
class OperationalError extends Error {}

// --- project identity (D3 precedence + the one-echo contract) --------------------------------------
//
// resolveProjectId is the D3 chain: `--project` > `STEEPY_PROJECT` > `<cwd>/.formula/config.json`
// > DEFAULT_PROJECT. Every resolution carries its source (`flag | env | config | fallback` —
// PROJECT_SOURCES); nothing silently falls back. Invalid ids from the flag or the env stay USAGE
// errors (exit 2, the pre-existing path); a config file that exists but cannot serve a binding is
// OPERATIONAL (exit 3 — the core's error names the exact path), never a silent 'demo'.
function resolveProjectId({ values, env, cwd }) {
  if (values.project !== undefined) {
    if (!isValidProjectId(values.project)) {
      throw new UsageError(`invalid --project '${values.project}': expected [a-z][a-z0-9-]* (see core/ids.mjs).`);
    }
    return { projectId: values.project, source: 'flag' };
  }
  if (env.STEEPY_PROJECT !== undefined) {
    if (!isValidProjectId(env.STEEPY_PROJECT)) {
      throw new UsageError(`invalid STEEPY_PROJECT '${env.STEEPY_PROJECT}': expected [a-z][a-z0-9-]* (see core/ids.mjs).`);
    }
    return { projectId: env.STEEPY_PROJECT, source: 'env' };
  }
  let bound;
  try {
    bound = readProjectConfig(cwd);
  } catch (error) {
    // A data condition from the core (unreadable file, invalid JSON, invalid id) — operational.
    throw new OperationalError(error.message);
  }
  if (bound !== null) return { projectId: bound.projectId, source: 'config' };
  return { projectId: DEFAULT_PROJECT, source: 'fallback' };
}

// The one-echo state: the invocation's resolution (set by parseShared once it resolves) and
// whether the echo line has been printed. Exactly ONE `  project: <id> (<source>)` line per
// invocation — inside the stdout report block when the command prints one, on stderr when stdout
// must stay machine-clean (`graph export --out -`, `context resolve --out -`, `promotion
// preview`), and — deferred to `main` — on stderr when the command fails before printing any
// block, so it never interleaves with machine-clean stdout.
let resolvedProject = null;
let projectEchoed = false;

function projectEchoText({ projectId, projectSource }) {
  return `  project:   ${projectId} (${projectSource})`;
}

// The report-block echo: returns the line for the command's block and marks the invocation echoed.
function projectEchoLine(resolution) {
  projectEchoed = true;
  return projectEchoText(resolution);
}

// init keeps its own block alignment (the full init rework is task 3): its pre-existing
// `project:` line only gains the source but still counts as the invocation's one echo.
function markProjectEchoed() {
  projectEchoed = true;
}

// The deferred failure echo: for an invocation that resolved but ended without printing its echo
// (a failure before any report block). No-op when nothing resolved (usage/parse failures and
// failed resolutions have no id to echo) or when a block already carried the line.
function echoProjectResolution() {
  if (resolvedProject === null || projectEchoed) return;
  projectEchoed = true;
  console.error(projectEchoText(resolvedProject));
}

// --- argument parsing (node:util parseArgs, strict per-CLI schema per the scripts standard) -------

const INIT_OPTIONS = { project: { type: 'string' }, force: { type: 'boolean' } };
const SHARED_OPTIONS = { project: { type: 'string' }, port: { type: 'string' }, seed: { type: 'string' }, root: { type: 'string' } };
const EXPORT_OPTIONS = { project: { type: 'string' }, port: { type: 'string' }, seed: { type: 'string' }, out: { type: 'string' } };
const BACKUP_OPTIONS = { project: { type: 'string' }, port: { type: 'string' }, seed: { type: 'string' }, to: { type: 'string' } };
const RESTORE_OPTIONS = { project: { type: 'string' }, port: { type: 'string' }, from: { type: 'string' }, force: { type: 'boolean' } };
const MIGRATE_OPTIONS = { project: { type: 'string' }, port: { type: 'string' }, seed: { type: 'string' }, to: { type: 'string' } };
const CONTEXT_OPTIONS = {
  project: { type: 'string' },
  port: { type: 'string' },
  seed: { type: 'string' },
  root: { type: 'string' },
  path: { type: 'string', multiple: true },
  target: { type: 'string', multiple: true },
  budget: { type: 'string' },
  out: { type: 'string' },
  'include-rationale': { type: 'boolean' },
};
const PROMOTION_PREVIEW_OPTIONS = { project: { type: 'string' }, port: { type: 'string' }, seed: { type: 'string' } };
const PROMOTION_CREATE_OPTIONS = {
  project: { type: 'string' },
  port: { type: 'string' },
  seed: { type: 'string' },
  candidates: { type: 'string' },
  proposer: { type: 'string' },
};
const PROMOTION_APPLY_OPTIONS = {
  project: { type: 'string' },
  port: { type: 'string' },
  seed: { type: 'string' },
  approver: { type: 'string' },
  yes: { type: 'boolean' },
};
const PROMOTION_DISCARD_OPTIONS = { project: { type: 'string' }, port: { type: 'string' }, seed: { type: 'string' } };
const HUB_MODE_OPTIONS = { project: { type: 'string' }, port: { type: 'string' }, seed: { type: 'string' } };

// The shared per-command flag contract every command group validates: the project identity
// (resolveProjectId's D3 chain — every command receives `{ projectId, projectSource }`) and the
// memory-port test seam (`--port memory` + `--seed`, which is memory-only).
function parseShared(values) {
  const { projectId, source } = resolveProjectId({ values, env: process.env, cwd: process.cwd() });
  resolvedProject = { projectId, projectSource: source };
  if (values.port !== undefined && values.port !== 'memory') {
    throw new UsageError(`unknown --port '${values.port}'; the only supported value is 'memory'.`);
  }
  if (values.seed !== undefined && values.port !== 'memory') {
    throw new UsageError('--seed is a memory-port test seam and requires --port memory.');
  }
  return { projectId, projectSource: source, ...values };
}

function parseOptions(args, schema, { requireRoot = false, usageLabel } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: schema, strict: true, allowPositionals: false }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  const parsed = parseShared(values);
  if (requireRoot && values.root === undefined) {
    throw new UsageError(`--root <dir> is required for \`graph ${usageLabel}\`.`);
  }
  return parsed;
}

// `context resolve` — at least one `--path` or `--target` is required (else exit 2, usage), and
// `--budget` must be a positive integer (the per-call override D3 validates too — here it is a
// usage error, not a data condition).
function parseContextOptions(args) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: CONTEXT_OPTIONS, strict: true, allowPositionals: false }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  const parsed = parseShared(values);
  const paths = values.path ?? [];
  const targets = values.target ?? [];
  if (paths.length + targets.length === 0) {
    throw new UsageError('`context resolve` requires at least one --path or --target.');
  }
  let budget;
  if (values.budget !== undefined) {
    budget = Number(values.budget);
    if (!Number.isInteger(budget) || budget <= 0) {
      throw new UsageError(`--budget must be a positive integer, got '${values.budget}'.`);
    }
  }
  return {
    ...parsed,
    paths,
    targets,
    root: values.root,
    budget,
    out: values.out,
    includeRationale: values['include-rationale'] === true,
  };
}

// The promotion commands take exactly one `<scenarioId>` positional (allowed explicitly — every
// other command is positional-free).
function parsePromotionOptions(args, schema, { usageLabel }) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({ args, options: schema, strict: true, allowPositionals: true }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  const parsed = parseShared(values);
  if (positionals.length !== 1) {
    throw new UsageError(`\`promotion ${usageLabel}\` requires exactly one <scenarioId> positional.`);
  }
  const [scenarioId] = positionals;
  if (typeof scenarioId !== 'string' || scenarioId === '') {
    throw new UsageError(`\`promotion ${usageLabel}\` requires a non-empty <scenarioId>.`);
  }
  return { ...parsed, scenarioId };
}

// --- port opening --------------------------------------------------------------------------------

async function loadSeed(port, filePath) {
  const imported = await importGraph(port, { filePath });
  if (!imported.ok) {
    throw new OperationalError(
      `cannot load seed '${filePath}': ${imported.violations.map((v) => v.message).join('; ')}`,
    );
  }
}

// Opens the port a command reads (and possibly writes) through. `--port memory` builds the
// in-memory reference port and, when `--seed` is given, imports the artifact into it; otherwise
// the local ArcadeDB port for the project's database is returned (server must be ready).
async function openPort({ projectId, port, seed }) {
  if (port === 'memory') {
    const memory = createMemoryPort();
    if (seed) await loadSeed(memory, seed);
    return memory;
  }
  return createArcadeDbPort({ server: await liveServer(projectId), database: databaseNameFor(projectId) });
}

async function liveServer(projectId) {
  const state = await serverStatus({ name: containerNameFor(projectId) });
  if (state.status !== SERVER_STATUS.READY) {
    const detail = state.reason ? `; ${state.reason}` : '';
    throw new OperationalError(`graph server '${containerNameFor(projectId)}' is not ready (status: ${state.status}${detail}).`);
  }
  return state;
}

// The failure-table schema guard for NORMAL graph commands: when the system record declares a
// schema version this build cannot read, refuse (exit 1) and demand the explicit migration. The
// version fact comes from the core (`readSchemaVersion`), never re-derived here; an absent version
// (nothing declared) is NOT this guard's row — the validator reports SCHEMA_VERSION_MISSING.
async function guardSchemaVersion(port, projectId) {
  const version = await readSchemaVersion(port, projectId);
  if (version === null || isSupportedSchemaVersion(version)) return null;
  console.error(
    `steepy-formula: [UNSUPPORTED_SCHEMA_VERSION] graph '${projectId}' declares schema version ${JSON.stringify(version)}, but this build reads version ${GRAPH_SCHEMA_VERSION}. Refusing normal operation — an explicit schema migration (\`graph migrate-schema\`) or a restore of a supported export is required.`,
  );
  return EXIT.VALIDATE_FAILED;
}

// --- graph status facts (port-only, one transaction per fact) -------------------------------------

async function graphCounts(port, projectId) {
  return withTransaction(port, async (tx) => {
    let nodes = 0;
    let edges = 0;
    for (const namespace of STABLE_NAMESPACES) {
      nodes += (await tx.listNodes({ namespace })).length;
      edges += (await tx.listEdges({ namespace })).length;
    }
    return { nodes, edges };
  });
}

// --- commands ------------------------------------------------------------------------------------

// `graph init` — provision the local engine (C1), resolve credentials (F1), verify the database
// answers (§15 step 1), detect topology (§15 step 2), adopt the project binding (D2/D5).
// Idempotent by construction. The BINDING GUARD runs FIRST, before any engine work: an explicit
// request (`flag`/`env` source) that contradicts the shared `.formula/config.json` binding
// refuses up front (exit 3, `--force` is the explicit re-point) — nothing is provisioned and
// nothing is written, which keeps the refusal free of engine interaction. Adoption itself (the
// written/unchanged/rewritten decision and its summary line) happens only AFTER provisioning
// succeeds, so a failed init never binds the repository; the guard's pre-check is therefore a
// read-only `readProjectConfig` (an eager `adoptProjectBinding` would WRITE the binding when no
// config exists — before the engine has provably answered).
async function cmdInit({ projectId, projectSource, force }) {
  if (projectSource === 'flag' || projectSource === 'env') {
    let bound;
    try {
      bound = readProjectConfig(process.cwd());
    } catch (error) {
      // A config that exists but cannot serve a binding is operational — same row as the
      // resolution chain, never a silent provision past a broken binding file.
      throw new OperationalError(error.message);
    }
    if (bound !== null && bound.projectId !== projectId && force !== true) {
      console.error(
        `steepy-formula: graph init refused: '${join(process.cwd(), '.formula', 'config.json')}' binds '${bound.projectId}', but '${projectId}' was requested; pass --force to re-point the shared binding.`,
      );
      return EXIT.OPERATIONAL;
    }
  }

  const secret = resolveDatabaseSecret('db-password');
  if (!secret.ok && secret.code !== 'NOT_FOUND') {
    throw new OperationalError(`cannot resolve database credentials: ${JSON.stringify(describeSecret(secret))}`);
  }
  if (secret.warning) console.error(`steepy-formula: ${secret.warning.message}`);

  const server = await startServer({ name: containerNameFor(projectId), password: secret.ok ? secret.value : undefined });
  const database = databaseNameFor(projectId);
  if (!(await listDatabases(server)).includes(database)) await createDatabase(server, database);
  await runSql(server, database, 'SELECT count(*) AS c FROM ApexNode');

  const detection = await detectTopology(process.cwd());

  // 'refused' is unreachable here: the pre-guard already refused a non-forced mismatch, and a
  // config/fallback source cannot mismatch through the precedence chain.
  const adoption = adoptProjectBinding({
    root: process.cwd(),
    requested: projectId,
    requestedSource: projectSource,
    force: force === true,
  });
  const bindingLine =
    adoption.action === 'rewritten'
      ? `  binding:   rewritten ${adoption.previousId} -> ${adoption.projectId} (.formula/config.json)`
      : adoption.action === 'written'
        ? '  binding:   written .formula/config.json'
        : '  binding:   unchanged (.formula/config.json)';

  markProjectEchoed();
  const lines = [
    `initialized graph project '${projectId}'`,
    `  project:    ${projectId} (${projectSource})`,
    `  engine:     ${server.httpUrl}`,
    `  database:   ${database}`,
    `  credentials: ${secret.ok ? secret.source : 'per-run'}`,
    detection.ok
      ? `  topology:   ${detection.workspaces.length} workspaces, ${detection.packages.length} packages (${detection.detector})`
      : `  topology:   not detected (${detection.code})`,
    bindingLine,
  ];
  console.log(lines.join('\n'));
  return EXIT.OK;
}

// `graph validate` — portable validator (B4) + revision-chain replay (B5). Exit 1 on a validate
// verdict, never 2: an invalid graph is a finding, not a usage error.
async function cmdValidate({ projectId, projectSource, port, seed }) {
  const graphPort = await openPort({ projectId, port, seed });
  let validator;
  let replay;
  try {
    const refused = await guardSchemaVersion(graphPort, projectId);
    if (refused !== null) return refused;
    validator = await validateGraph(graphPort, { projectId });
    replay = await replayChain(graphPort, { projectId });
  } finally {
    await graphPort.close?.();
  }

  const verdict = !validator.ok && !replay.ok
    ? 'violations + out-of-band-writes'
    : !validator.ok
      ? 'violations'
      : !replay.ok
        ? 'out-of-band-writes'
        : 'clean';

  const lines = [
    `graph validate '${projectId}'`,
    projectEchoLine({ projectId, projectSource }),
    `  verdict:   ${verdict}`,
    `  violations: ${validator.violations.length}`,
    `  warnings:   ${validator.warnings.length}`,
  ];
  for (const v of validator.violations) lines.push(`  [${v.code}] ${v.message}`);
  for (const w of validator.warnings) lines.push(`  warning [${w.code}] ${w.message}`);
  lines.push(`  chain:      ${replay.violations.length === 0 ? 'clean' : `${replay.violations.length} violations`}`);
  for (const v of replay.violations) lines.push(`  [${v.code}] ${v.message}`);
  lines.push(`  unexplained nodes: ${renderIds(replay.unexplained.nodes)}`);
  lines.push(`  unexplained edges: ${renderEdges(replay.unexplained.edges)}`);
  lines.push(`  missing nodes: ${renderIds(replay.missing.nodes)}`);
  lines.push(`  missing edges: ${renderEdges(replay.missing.edges)}`);
  console.log(lines.join('\n'));

  return validator.ok && replay.ok ? EXIT.OK : EXIT.VALIDATE_FAILED;
}

const renderIds = (records) => (records.length === 0 ? '(none)' : records.map((r) => r.id).join(', '));
const renderEdges = (records) =>
  records.length === 0 ? '(none)' : records.map((e) => `${e.type} ${e.fromId} -> ${e.toId}`).join(', ');

async function statusFacts(port, projectId, { root }) {
  const system = await withTransaction(port, (tx) =>
    tx.getNode({ namespace: 'system', id: systemRecordId(projectId) }),
  );
  if (system === null) return { initialized: false, head: null, nodes: 0, edges: 0, staleness: 'unknown' };
  const { nodes, edges } = await graphCounts(port, projectId);
  const { headRevision } = await readChain(port, { projectId });

  let staleness = 'unknown';
  if (root !== undefined) {
    const detection = await detectTopology(root);
    const recorded = await readTopologyDigest(port, { projectId });
    staleness = !detection.ok ? 'stale' : recorded === detection.digest ? 'fresh' : 'stale';
  }
  return { initialized: true, head: headRevision, nodes, edges, staleness };
}

// `graph status` — server status (C1), initialization (system record present), head revision,
// stable-graph counts, scenario count (n/a: the port offers no scenario enumeration), staleness.
function printStatus({ projectId, projectSource, server, engine, facts }) {
  const lines = [
    `graph status '${projectId}'`,
    projectEchoLine({ projectId, projectSource }),
    `  server:      ${server}`,
    `  engine:      ${engine}`,
    `  initialized: ${facts.initialized ? 'yes' : 'no'}`,
    `  head:        ${facts.head ?? 'none'}`,
    `  nodes:       ${facts.nodes}`,
    `  edges:       ${facts.edges}`,
    `  scenarios:   n/a`,
    `  staleness:   ${facts.staleness}`,
  ];
  if (facts.reason) lines.push(`  reason:      ${facts.reason}`);
  console.log(lines.join('\n'));
}

async function cmdStatus({ projectId, projectSource, port, seed, root }) {
  let graphPort;
  let server;
  let engine;
  if (port === 'memory') {
    graphPort = createMemoryPort();
    if (seed) await loadSeed(graphPort, seed);
    server = 'memory-port';
    engine = 'n/a';
  } else {
    const state = await serverStatus({ name: containerNameFor(projectId) });
    if (state.status !== SERVER_STATUS.READY) {
      printStatus({ projectId, projectSource, server: state.status, engine: 'n/a', facts: { initialized: false, head: null, nodes: 0, edges: 0, staleness: 'unknown', reason: state.reason } });
      console.error(`steepy-formula: graph server '${containerNameFor(projectId)}' is unavailable (status: ${state.status}).`);
      return EXIT.OPERATIONAL;
    }
    graphPort = createArcadeDbPort({ server: state, database: databaseNameFor(projectId) });
    server = state.status;
    engine = state.httpUrl;
  }

  let facts;
  try {
    const refused = await guardSchemaVersion(graphPort, projectId);
    if (refused !== null) return refused;
    facts = await statusFacts(graphPort, projectId, { root });
  } finally {
    await graphPort.close?.();
  }
  printStatus({ projectId, projectSource, server, engine, facts });
  if (!facts.initialized) console.error(`steepy-formula: graph '${projectId}' is not initialized (nothing to do).`);
  return facts.initialized ? EXIT.OK : EXIT.NOT_FOUND;
}

// `graph refresh` — the §25 on-demand refresh (D1), reporting the TOPOLOGY_CODES outcome and
// preserving the last valid topology on failure (exit 3, never a silent drop).
async function cmdRefresh({ projectId, projectSource, root, port, seed }) {
  const graphPort = await openPort({ projectId, port, seed });
  let result;
  try {
    const refused = await guardSchemaVersion(graphPort, projectId);
    if (refused !== null) return refused;
    result = await refreshTopology(graphPort, root, { projectId, actorId: 'steepy-formula-cli' });
  } finally {
    await graphPort.close?.();
  }

  const outcome =
    result.code === TOPOLOGY_CODES.TOPOLOGY_WRITTEN
      ? 'refreshed'
      : result.code === TOPOLOGY_CODES.TOPOLOGY_UNCHANGED
        ? 'unchanged'
        : result.code === TOPOLOGY_CODES.TOPOLOGY_STALE
          ? 'stale'
          : result.code === TOPOLOGY_CODES.TOPOLOGY_REJECTED
            ? 'rejected'
            : result.code;

  const lines = [
    `graph refresh '${projectId}'`,
    projectEchoLine({ projectId, projectSource }),
    `  result:    ${outcome}`,
    `  revision:  ${result.revision?.id ?? '-'}`,
    `  digest:    ${result.digest ?? '-'}`,
  ];
  if (!result.ok) lines.push(`  detail:    ${result.message}`);
  console.log(lines.join('\n'));

  if (!result.ok) {
    console.error(`steepy-formula: refresh of graph '${projectId}' failed: ${result.message}`);
    return EXIT.OPERATIONAL;
  }
  return EXIT.OK;
}

// --- export / backup / restore / migrate-schema (F4 — spec §22, §27) --------------------------------

// `graph export` — B6 `exportGraph` to the signed artifact. `--out` defaults to
// `./<projectId>-export.jsonl` (recorded decision); `--out -` writes the artifact to stdout with
// the head/digest report on stderr (recorded decision), keeping the artifact bytes machine-clean.
async function cmdExport({ projectId, projectSource, port, seed, out }) {
  const graphPort = await openPort({ projectId, port, seed });
  try {
    const refused = await guardSchemaVersion(graphPort, projectId);
    if (refused !== null) return refused;

    if (out === '-') {
      const artifact = await buildExportArtifact(graphPort, { projectId });
      process.stdout.write(artifact.text);
      console.error(`graph export '${projectId}'`);
      console.error(projectEchoLine({ projectId, projectSource }));
      console.error(`  head:   ${artifact.header.headRevision ?? 'none'}`);
      console.error(`  digest: ${artifact.trailer.digest}`);
      return EXIT.OK;
    }

    const filePath = out ?? join(process.cwd(), `${projectId}-export.jsonl`);
    const result = await exportGraph(graphPort, { projectId, filePath });
    console.log(`graph export '${projectId}'`);
    console.log(projectEchoLine({ projectId, projectSource }));
    console.log(`  file:   ${result.filePath}`);
    console.log(`  head:   ${result.headRevision ?? 'none'}`);
    console.log(`  digest: ${result.digest}`);
    console.log(`  counts: ${result.counts.nodes} nodes, ${result.counts.edges} edges`);
    return EXIT.OK;
  } finally {
    await graphPort.close?.();
  }
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// `graph backup` — additive per §22 (recorded decision): the backup IS the engine-native online
// copy PLUS the portable signed export. The portable part runs on any port; the native part is
// docker-gated. Both outcomes are reported; a native failure exits 3 even though the portable
// artifact was written.
async function cmdBackup({ projectId, projectSource, port, seed, to }) {
  const dir = to ?? process.cwd();
  mkdirSync(dir, { recursive: true });
  const portableFile = join(dir, `${projectId}-export-${backupTimestamp()}.jsonl`);

  let graphPort;
  let server;
  if (port === 'memory') {
    graphPort = createMemoryPort();
    if (seed) await loadSeed(graphPort, seed);
  } else {
    server = await liveServer(projectId);
    graphPort = createArcadeDbPort({ server, database: databaseNameFor(projectId) });
  }

  let refused = null;
  let exported = null;
  try {
    refused = await guardSchemaVersion(graphPort, projectId);
    if (refused === null) {
      exported = await exportGraph(graphPort, { projectId, filePath: portableFile });
    }
  } finally {
    await graphPort.close?.();
  }
  if (refused !== null) return refused;

  console.log(`graph backup '${projectId}'`);
  console.log(projectEchoLine({ projectId, projectSource }));
  console.log(`  portable:   ${portableFile}`);
  console.log(`  head:       ${exported.headRevision ?? 'none'}`);
  console.log(`  digest:     ${exported.digest}`);

  if (port === 'memory') {
    console.log('  native:     n/a (memory seam — no engine)');
    return EXIT.OK;
  }

  try {
    const rows = await runSql(server, databaseNameFor(projectId), 'BACKUP DATABASE');
    const row = rows[0] ?? {};
    if (row.result !== 'OK' || typeof row.backupFile !== 'string') {
      console.log(`  native:     FAILED (unexpected result: ${JSON.stringify(row)})`);
      console.error(`steepy-formula: the engine-native backup of graph '${projectId}' failed (unexpected result).`);
      return EXIT.OPERATIONAL;
    }
    console.log(`  native:     OK (${row.backupFile})`);
    return EXIT.OK;
  } catch (error) {
    console.log('  native:     FAILED');
    console.error(`steepy-formula: the engine-native backup of graph '${projectId}' failed: ${error.message}. The portable export was still written.`);
    return EXIT.OPERATIONAL;
  }
}

// Reports validate + chain replay on a restored port. Exit 0 only when both are clean; exit 1 on
// findings (restore-validation-failed -> 1 per the F4 exit extension).
async function verifyRestoredGraph(port, projectId, from, projectSource) {
  const validator = await validateGraph(port, { projectId });
  const replay = await replayChain(port, { projectId });
  const clean = validator.ok && replay.ok;
  console.log(`graph restore '${projectId}'`);
  console.log(projectEchoLine({ projectId, projectSource }));
  console.log(`  from:      ${from}`);
  console.log(`  validated: ${validator.ok ? 'clean' : `${validator.violations.length} violations`}`);
  for (const v of validator.violations) console.log(`  [${v.code}] ${v.message}`);
  console.log(`  chain:     ${replay.violations.length === 0 ? 'clean' : `${replay.violations.length} violations`}`);
  for (const v of replay.violations) console.log(`  [${v.code}] ${v.message}`);
  return clean ? EXIT.OK : EXIT.VALIDATE_FAILED;
}

// The `--force` overwrite on a non-empty live database: a verified pre-restore backup FIRST (the
// "require the database to be restorable" refusal — an unexportable database is never destroyed),
// then drop/recreate/import. Returns a fresh port bound to the recreated database. The backup is
// written under a temp dir (recorded decision), never the working directory.
async function forceOverwrite(server, database, projectId) {
  const dir = mkdtempSync(join(tmpdir(), 'steepy-formula-prestore-'));
  const backupFile = join(dir, `${projectId}-pre-restore.jsonl`);
  const prePort = createArcadeDbPort({ server, database });
  try {
    await exportGraph(prePort, { projectId, filePath: backupFile });
  } finally {
    await prePort.close();
  }
  const verified = parseExportArtifact(readFileSync(backupFile, 'utf8'));
  if (!verified.ok) {
    throw new OperationalError(
      `cannot --force restore: the current graph of '${projectId}' is not restorable (${verified.violations[0]?.message}); refusing to destroy it.`,
    );
  }
  await dropDatabase(server, database);
  await createDatabase(server, database);
  return createArcadeDbPort({ server, database });
}

// `graph restore` — B6 `importGraph` into the project database, then portable validation + chain
// replay. Exit 0 only when both are clean; exit 1 on findings; import refusals exit 3. A non-empty
// target is refused without `--force`; with `--force` the current content is backed up and verified
// first (the criterion-9 restore-into-a-clean-environment path).
async function cmdRestore({ projectId, projectSource, port, from, force }) {
  if (from === undefined) {
    throw new UsageError('`graph restore` requires --from <file>.');
  }

  if (port === 'memory') {
    const graphPort = createMemoryPort();
    try {
      const imported = await importGraph(graphPort, { filePath: from });
      if (!imported.ok) {
        for (const v of imported.violations) console.error(`steepy-formula: [${v.code}] ${v.message}`);
        console.error(`steepy-formula: restore of graph '${projectId}' failed; nothing was written.`);
        return EXIT.OPERATIONAL;
      }
      // `await` is load-bearing: without it the finally closes the port before the async body runs.
      return await verifyRestoredGraph(graphPort, projectId, from, projectSource);
    } finally {
      await graphPort.close();
    }
  }

  const server = await liveServer(projectId);
  const database = databaseNameFor(projectId);
  if (!(await listDatabases(server)).includes(database)) await createDatabase(server, database);

  let graphPort = createArcadeDbPort({ server, database });
  try {
    const imported = await importGraph(graphPort, { filePath: from });
    if (!imported.ok) {
      const nonEmpty = imported.violations.some((v) => v.code === EXPORT_VIOLATION_CODES.NON_EMPTY_IMPORT_TARGET);
      if (nonEmpty && !force) {
        console.error('steepy-formula: refusing to overwrite a non-empty graph database: pass --force to replace it (a verified pre-restore backup is written first).');
        return EXIT.OPERATIONAL;
      }
      if (nonEmpty && force) {
        await graphPort.close();
        graphPort = await forceOverwrite(server, database, projectId);
        const forced = await importGraph(graphPort, { filePath: from });
        if (!forced.ok) {
          for (const v of forced.violations) console.error(`steepy-formula: [${v.code}] ${v.message}`);
          console.error(`steepy-formula: restore of graph '${projectId}' failed after the forced overwrite; restore it from the pre-restore backup.`);
          return EXIT.OPERATIONAL;
        }
        return await verifyRestoredGraph(graphPort, projectId, from, projectSource);
      }
      for (const v of imported.violations) console.error(`steepy-formula: [${v.code}] ${v.message}`);
      console.error(`steepy-formula: restore of graph '${projectId}' failed; nothing was written.`);
      return EXIT.OPERATIONAL;
    }
    return await verifyRestoredGraph(graphPort, projectId, from, projectSource);
  } finally {
    await graphPort.close?.();
  }
}

function parseTargetVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new UsageError(`--to must be a positive integer schema version, got '${value}'.`);
  }
  return version;
}

// The engine-conditional hooks for `migrateSchema` (the CLI's thin glue — the §27 procedure is
// core/schema-migrate.mjs). The portable signed export IS the verified backup evidence; the
// engine-native online backup rides along as `engineNative`. The cutover is the core's
// transactional replace (`replacePrimaryFromArtifact`): one transaction clears and re-imports the
// primary, so an interruption rolls back to the old graph while the verified backup remains.
async function portableBackupEvidence(port, projectId) {
  const dir = mkdtempSync(join(tmpdir(), 'steepy-formula-verified-backup-'));
  const filePath = join(dir, `${projectId}-verified-backup.jsonl`);
  await exportGraph(port, { projectId, filePath });
  return { ok: true, text: readFileSync(filePath, 'utf8'), filePath };
}

function memoryMigrateHooks(primaryPort, projectId) {
  return {
    openShadow: async () => createMemoryPort(),
    closeShadow: async (shadowPort) => {
      await shadowPort.close();
    },
    backup: async () => portableBackupEvidence(primaryPort, projectId),
    cutover: async (shadowPort) => {
      const artifact = await buildExportArtifact(shadowPort, { projectId });
      await replacePrimaryFromArtifact(primaryPort, artifact, projectId);
      return { port: primaryPort, dispose: async () => {} };
    },
  };
}

function arcadeMigrateHooks(primaryPort, server, database, projectId) {
  const shadowDatabase = `${database}_shadow`;
  return {
    openShadow: async () => {
      await dropDatabase(server, shadowDatabase).catch(() => {});
      await createDatabase(server, shadowDatabase);
      return createArcadeDbPort({ server, database: shadowDatabase });
    },
    closeShadow: async (shadowPort) => {
      await shadowPort.close();
      await dropDatabase(server, shadowDatabase).catch(() => {});
    },
    backup: async () => {
      const native = await runSql(server, database, 'BACKUP DATABASE');
      const row = native[0] ?? {};
      const evidence = await portableBackupEvidence(primaryPort, projectId);
      return {
        ...evidence,
        engineNative: row.result === 'OK' ? row.backupFile : `unexpected: ${JSON.stringify(row)}`,
      };
    },
    // MEASURED on the pinned release: ArcadeDB refuses to delete and re-create the SAME edge
    // within one transaction (its unique @out/@in edge index is not released until commit), so
    // the in-place transactional replace is unusable here. The cutover is therefore the brief's
    // drop/recreate/import mechanism: the verified backup (required, atomicCutover is false)
    // exists before the drop, and the transformed graph is imported into a freshly recreated
    // database — the worst case on interruption is a restorable primary + the verified backup.
    cutover: async (shadowPort) => {
      const artifact = await buildExportArtifact(shadowPort, { projectId });
      await dropDatabase(server, database);
      await createDatabase(server, database);
      const fresh = createArcadeDbPort({ server, database });
      const imported = await importGraph(fresh, { text: artifact.text });
      if (!imported.ok) {
        await fresh.close();
        throw new Error(`importing the transformed graph failed: ${imported.violations[0]?.message}`);
      }
      return { port: fresh, dispose: async () => fresh.close() };
    },
  };
}

function migrateFailureExit(projectId, result) {
  switch (result.code) {
    case MIGRATE_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION:
    case MIGRATE_ERROR_CODES.SCHEMA_VERSION_MISSING:
      console.error(`steepy-formula: [${result.code}] ${result.message}`);
      return EXIT.UNSUPPORTED_SCHEMA;
    case MIGRATE_ERROR_CODES.SHADOW_VALIDATION_FAILED:
      for (const v of result.violations ?? []) console.error(`steepy-formula: [${v.code}] ${v.message}`);
      console.error(`steepy-formula: schema migration of graph '${projectId}' aborted: the transformed shadow graph does not validate; the primary was left untouched.`);
      return EXIT.VALIDATE_FAILED;
    case MIGRATE_ERROR_CODES.VERIFIED_BACKUP_REQUIRED:
    case MIGRATE_ERROR_CODES.VERIFIED_BACKUP_FAILED:
    case MIGRATE_ERROR_CODES.CUTOVER_FAILED:
      console.error(`steepy-formula: [${result.code}] ${result.message}`);
      if (result.backupEvidence?.digest) {
        console.error(`steepy-formula: a verified backup exists (digest ${result.backupEvidence.digest.slice(0, 16)}…) — restore from it if needed.`);
      }
      return EXIT.OPERATIONAL;
    default:
      console.error(`steepy-formula: ${result.message ?? String(result.code)}`);
      return EXIT.OPERATIONAL;
  }
}

// `graph migrate-schema` — the CLI over core `migrateSchema`. The shipped transform stub bumps the
// schema version to `--to <version>` (default the current `GRAPH_SCHEMA_VERSION`); the engine-
// conditional hooks are this CLI's glue. Reports the before/after version, the verified-backup
// evidence and the post-cutover validation + chain replay.
async function cmdMigrateSchema({ projectId, projectSource, port, seed, to }) {
  const targetVersion = to === undefined ? GRAPH_SCHEMA_VERSION : parseTargetVersion(to);
  const graphPort = await openPort({ projectId, port, seed });

  let hooks;
  if (port === 'memory') {
    hooks = memoryMigrateHooks(graphPort, projectId);
  } else {
    const server = await liveServer(projectId);
    hooks = arcadeMigrateHooks(graphPort, server, databaseNameFor(projectId), projectId);
  }

  let result;
  try {
    result = await migrateSchema(graphPort, {
      projectId,
      transform: versionBumpTransform(targetVersion),
      options: hooks,
    });
  } finally {
    await graphPort.close?.();
  }

  if (!result.ok) return migrateFailureExit(projectId, result);

  console.log(`graph migrate-schema '${projectId}'`);
  console.log(projectEchoLine({ projectId, projectSource }));
  console.log(`  schema:     v${result.beforeVersion} -> v${result.afterVersion}`);
  console.log(`  cutover:    ${result.atomicCutover ? 'atomic' : 'non-atomic (verified backup first)'}`);
  if (result.backupEvidence) {
    const at = result.backupEvidence.filePath ? ` at ${result.backupEvidence.filePath}` : '';
    console.log(`  backup:     verified (digest ${result.backupEvidence.digest.slice(0, 16)}…)${at}`);
    if (result.backupEvidence.engineNative) console.log(`  native:     ${result.backupEvidence.engineNative}`);
  } else {
    console.log('  backup:     not required (atomic cutover)');
  }
  const chain = result.postCutover.chain.ok ? 'clean' : `${result.postCutover.chain.violations.length} findings`;
  console.log(`  post-check: validated ${result.postCutover.validated ? 'clean' : 'violations'}, chain ${chain}`);
  return EXIT.OK;
}

// --- context resolve (D3 — spec §9, §25) -----------------------------------------------------------

// Maps a D3/D2 structured failure to its DISTINCT exit code, printing the machine-checkable
// diagnostics (candidates + reasons, Rule IDs, measured/budget, the blocking violations) to stderr.
// Every failure-table row maps to its own code; nothing is invented and nothing falls through to a
// generic code without being named.
function contextFailureExit(projectId, result) {
  switch (result.code) {
    case RESOLVE_ERROR_CODES.UNRESOLVED:
      for (const entry of result.unresolved ?? []) {
        console.error(`steepy-formula: unresolved ${entry.kind} '${entry.input}': ${entry.reason}`);
        for (const candidate of entry.candidates ?? []) {
          const selector = candidate.selector !== null && candidate.selector !== undefined ? ` (${candidate.selector})` : '';
          console.error(`steepy-formula:   candidate: ${candidate.id}${selector}`);
        }
        if ((entry.candidateCount ?? 0) > (entry.candidates?.length ?? 0)) {
          console.error(`steepy-formula:   (${entry.candidateCount} total)`);
        }
      }
      return EXIT.UNRESOLVED;
    case RESOLVE_ERROR_CODES.RULE_CONFLICT:
      for (const found of result.conflicts ?? []) {
        console.error(`steepy-formula: [RULE_CONFLICT] ${found.ruleIds.join(', ')} share concern '${found.concern}' with no explicit OVERRIDES resolution.`);
      }
      return EXIT.RULE_CONFLICT;
    case CONTEXT_OUTPUT_ERROR_CODES.CONTEXT_OVERFLOW:
      console.error(
        `steepy-formula: [CONTEXT_OVERFLOW] Layer 0 + Layer 1 require ${result.identity.measured} characters, exceeding the ${result.identity.budget}-character budget; narrow the scope.`,
      );
      return EXIT.CONTEXT_OVERFLOW;
    case RESOLVE_ERROR_CODES.GRAPH_INVALID:
      for (const violation of result.violations ?? []) console.error(`steepy-formula: [${violation.code}] ${violation.message}`);
      return EXIT.VALIDATE_FAILED;
    case RESOLVE_ERROR_CODES.KNOWLEDGE_GRAPH_UNAVAILABLE:
      console.error(`steepy-formula: [KNOWLEDGE_GRAPH_UNAVAILABLE] ${result.message}`);
      return EXIT.OPERATIONAL;
    default:
      console.error(`steepy-formula: ${result.message ?? String(result.code)}`);
      return EXIT.OPERATIONAL;
  }
}

// `context resolve` — D3 `buildContextOutput` is the engine; the CLI only parses, maps exits and
// emits the two artifacts. Both artifacts always go out together: to `--out <dir>` (default the
// current working directory) as `context.json` + `context.md`, or to stdout under deterministic
// `=== context.json ===` / `=== context.md ===` separators when `--out -`.
async function cmdContextResolve({ projectId, projectSource, port, seed, root, paths, targets, budget, out, includeRationale }) {
  const graphPort = await openPort({ projectId, port, seed });
  let result;
  try {
    result = await buildContextOutput(graphPort, {
      projectId,
      paths,
      targets,
      rootDir: root,
      options: { includeRationale: includeRationale === true, budget },
    });
  } finally {
    await graphPort.close?.();
  }
  if (!result.ok) return contextFailureExit(projectId, result);

  const jsonText = JSON.stringify(result.json, null, 2);
  const markdownText = result.markdown;

  if (out === '-') {
    console.error(projectEchoLine({ projectId, projectSource }));
    console.log('=== context.json ===');
    console.log(jsonText);
    console.log('=== context.md ===');
    process.stdout.write(markdownText);
  } else {
    const dir = out ?? process.cwd();
    mkdirSync(dir, { recursive: true });
    const jsonPath = join(dir, 'context.json');
    const mdPath = join(dir, 'context.md');
    writeFileSync(jsonPath, jsonText, 'utf8');
    writeFileSync(mdPath, markdownText, 'utf8');
    const pathCount = result.input.paths.length;
    const targetCount = result.input.targets.length;
    console.log(`context resolve '${projectId}'`);
    console.log(projectEchoLine({ projectId, projectSource }));
    console.log(`  inputs:     ${pathCount} path${pathCount === 1 ? '' : 's'}, ${targetCount} target${targetCount === 1 ? '' : 's'}`);
    console.log(`  schema:     v${result.json.schemaVersion}`);
    console.log(`  files:      ${jsonPath}, ${mdPath}`);
  }
  return EXIT.OK;
}

// --- promotion (D4/D5 — spec §11) ------------------------------------------------------------------

// The interactive human-approval boundary: prompts on stdin and confirms ONLY a `y`/`yes` answer;
// EOF or anything else is a refusal. The prompt is the only thing written to stdout before the
// decision, so a refusal is never a silent no-op.
function confirmApply(scenarioId) {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.question(`apply promotion scenario '${scenarioId}'? [y/N] `, (answer) => {
      const value = (answer ?? '').trim().toLowerCase();
      done(value === 'y' || value === 'yes');
    });
    rl.on('close', () => done(false));
  });
}

// The approver's NAME: `--approver <name>` wins; otherwise the invoking OS user (`userInfo`). The
// identity itself is always F1 `actor('human-approver', <name>)` — never a raw string.
function approverName(flag) {
  if (flag !== undefined) return flag;
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

// One compact line per applied operation, for the apply report (the ChangeSet the human approved).
function renderOperation(operation) {
  if (operation.target === 'node') {
    const replaces = operation.op === 'SUPERSEDE' ? ` (replaces ${operation.supersededId})` : '';
    return `${operation.op} ${operation.target} ${operation.namespace} ${operation.type} ${operation.id}${replaces}`;
  }
  return `${operation.op} ${operation.target} ${operation.namespace} ${operation.type} ${operation.fromId} -> ${operation.toId}`;
}

// `promotion create` — reads the typed-candidates file, maps it per D5 through the assembly wrapper
// (the file schema's only interpreter), creates the draft scenario and prints the summary. A
// missing/unreadable/invalid JSON file is a UsageError (exit 2); a file whose candidates violate the
// schema is a UsageError carrying the wrapper's whole violation list. Nothing is applied here.
const PROPOSER_ACTOR_TYPE = 'agent-proposer';

function readCandidatesDocument(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read --candidates file '${filePath}': ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`--candidates file '${filePath}' is not valid JSON: ${error.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`--candidates file '${filePath}' must hold a JSON object of the form { "candidates": [...] }.`);
  }
  return parsed;
}

async function cmdPromotionCreate({ projectId, projectSource, port, seed, scenarioId, candidates, proposer }) {
  if (candidates === undefined) {
    throw new UsageError('`promotion create` requires --candidates <file.json>.');
  }
  const document = readCandidatesDocument(candidates);
  const name = approverName(proposer);

  const graphPort = await openPort({ projectId, port, seed });
  let result;
  try {
    result = await assembleScenario(graphPort, {
      projectId,
      scenarioId,
      candidates: document,
      proposedBy: { type: PROPOSER_ACTOR_TYPE, name },
    });
  } finally {
    await graphPort.close?.();
  }
  if (!result.ok) {
    if (result.code === SCENARIO_ASSEMBLY_ERROR_CODES.INVALID_CANDIDATES) {
      for (const found of result.identity.violations ?? []) console.error(`steepy-formula: [${found.code}] ${found.message}`);
      throw new UsageError(
        `--candidates file '${candidates}' holds ${result.identity.violations?.length ?? 0} malformed candidate(s); nothing was created.`,
      );
    }
    if (result.code === PROMOTION_ERROR_CODES.SCENARIO_EXISTS) {
      console.error(`steepy-formula: ${result.message}`);
      return EXIT.NOT_FOUND;
    }
    if (result.code === PROMOTION_ERROR_CODES.SCENARIO_NOT_FOUND) {
      console.error(`steepy-formula: promotion scenario '${scenarioId}' does not exist.`);
      return EXIT.NOT_FOUND;
    }
    console.error(`steepy-formula: ${result.message ?? String(result.code)}`);
    return EXIT.OPERATIONAL;
  }

  const preview = result.preview;
  console.log(`promotion create '${projectId}' ${scenarioId}`);
  console.log(projectEchoLine({ projectId, projectSource }));
  console.log(`  proposed by:   ${name} (${PROPOSER_ACTOR_TYPE})`);
  console.log(`  base revision: ${preview.meta.baseRevision === null ? 'null' : preview.meta.baseRevision}`);
  console.log(`  operations:    ${preview.operations.length} graph, ${result.outOfGraph.length} out-of-graph`);
  console.log(`  structural:    ${preview.structural.valid ? 'valid' : `${preview.structural.violations.length} blocking finding(s)`}`);
  console.log(`  status:        ${preview.stale ? 'PROMOTION_STALE (rebase before apply)' : 'current'}`);
  for (const [index, item] of result.outOfGraph.entries()) {
    console.log(`  out-of-graph[${index}]: ${item.kind} ${JSON.stringify(item.note)}`);
  }
  console.log(`  next:          steepy-formula promotion preview --project ${projectId} ${scenarioId}`);
  return EXIT.OK;
}

// `promotion preview` — the typed diff report verbatim is the preview; staleness is carried by the
// exit code (20), never hidden.
async function cmdPromotionPreview({ projectId, projectSource, port, seed, scenarioId }) {
  // The diff on stdout IS the report, so the echo rides stderr BEFORE it (and before any
  // not-found error) — stdout stays machine-clean (Echo-line contract).
  console.error(projectEchoLine({ projectId, projectSource }));
  const graphPort = await openPort({ projectId, port, seed });
  let inspection;
  try {
    inspection = await inspectScenario(graphPort, { projectId, scenarioId });
  } finally {
    await graphPort.close?.();
  }
  if (!inspection.ok) {
    if (inspection.code === PROMOTION_ERROR_CODES.SCENARIO_NOT_FOUND) {
      console.error(`steepy-formula: promotion scenario '${scenarioId}' does not exist.`);
      return EXIT.NOT_FOUND;
    }
    console.error(`steepy-formula: ${inspection.message ?? String(inspection.code)}`);
    return EXIT.OPERATIONAL;
  }
  process.stdout.write(inspection.diff);
  if (inspection.stale) {
    console.error(
      `steepy-formula: promotion scenario '${scenarioId}' is PROMOTION_STALE (base ${inspection.stale.baseRevision}, head ${inspection.stale.headRevision}); rebase before apply.`,
    );
    return EXIT.PROMOTION_STALE;
  }
  return EXIT.OK;
}

// `promotion apply` — the human-approval boundary. Refuses (21) without confirmation; on approval
// delegates to D5 `applyPromotion` and reports the applied ChangeSet + head revision + export
// outcome. Every D5 error code maps to its own exit.
async function cmdPromotionApply({ projectId, projectSource, port, seed, scenarioId, yes, approver }) {
  if (!yes) {
    const confirmed = await confirmApply(scenarioId);
    if (!confirmed) {
      console.log(`promotion apply '${projectId}' ${scenarioId}`);
      console.log(projectEchoLine({ projectId, projectSource }));
      console.log('  result: declined');
      console.error(`steepy-formula: promotion of scenario '${scenarioId}' was declined: no confirmation given.`);
      return EXIT.DECLINED;
    }
  }

  const name = approverName(approver);
  const approverActor = actor('human-approver', name);
  const quotation = `Human approval of scenario '${scenarioId}' by '${name}' via the steepy-formula CLI.`;
  const provenance = [{ quotation, source: CLI_PROVENANCE_SOURCE, digest: sha256Hex(quotation) }];

  const graphPort = await openPort({ projectId, port, seed });
  let applied;
  try {
    applied = await applyPromotion(graphPort, { projectId, scenarioId, approver: approverActor, provenance });
  } finally {
    await graphPort.close?.();
  }
  if (!applied.ok) {
    switch (applied.code) {
      case PROMOTION_ERROR_CODES.SCENARIO_NOT_FOUND:
        console.error(`steepy-formula: promotion scenario '${scenarioId}' does not exist.`);
        return EXIT.NOT_FOUND;
      case PROMOTION_ERROR_CODES.PROMOTION_STALE:
        console.error(
          `steepy-formula: promotion scenario '${scenarioId}' is stale (base ${applied.identity.baseRevision}, head ${applied.identity.headRevision}); rebase and recompute before approving.`,
        );
        return EXIT.PROMOTION_STALE;
      case PROMOTION_ERROR_CODES.SCENARIO_INVALID:
        for (const violation of applied.identity.violations ?? []) console.error(`steepy-formula: [${violation.code}] ${violation.message}`);
        console.error(`steepy-formula: promotion scenario '${scenarioId}' is not structurally valid; resolve its blocking findings before approving.`);
        return EXIT.SCENARIO_INVALID;
      case PROMOTION_ERROR_CODES.SCENARIO_EMPTY:
        console.error(`steepy-formula: promotion scenario '${scenarioId}' holds no applied operations; nothing to promote.`);
        return EXIT.SCENARIO_EMPTY;
      default:
        console.error(`steepy-formula: ${applied.message ?? String(applied.code)}`);
        return EXIT.OPERATIONAL;
    }
  }

  console.log(`promotion apply '${projectId}' ${scenarioId}`);
  console.log(projectEchoLine({ projectId, projectSource }));
  const operations = applied.applied?.operations ?? [];
  for (const [index, operation] of operations.entries()) {
    console.log(`  op[${index}]: ${renderOperation(operation)}`);
  }
  console.log(`  revision:  ${applied.headRevision}`);
  console.log(`  consumed:  ${applied.scenarioConsumed}`);
  console.log(`  export:    ${applied.export === null ? 'none' : applied.export.ok ? 'written' : 'failed'}`);
  return EXIT.OK;
}

// `promotion discard` — idempotent (the port's discard of an unknown scenario is a no-op), so the
// CLI reports exit 0 either way.
async function cmdPromotionDiscard({ projectId, projectSource, port, seed, scenarioId }) {
  const graphPort = await openPort({ projectId, port, seed });
  let result;
  try {
    result = await discardScenario(graphPort, { projectId, scenarioId });
  } finally {
    await graphPort.close?.();
  }
  if (!result.ok) {
    console.error(`steepy-formula: ${result.message ?? String(result.code)}`);
    return EXIT.OPERATIONAL;
  }
  console.log(`promotion discard '${projectId}' ${scenarioId}`);
  console.log(projectEchoLine({ projectId, projectSource }));
  console.log(`  discarded: ${result.ok}`);
  return EXIT.OK;
}

// --- hub-mode (promotion-in-chain spec D4, plan decision 5) ----------------------------------------

// The declaration command. The CLI NEVER decides the mode or its next step (SC4): `detectHubMode`
// is the single authority. The `--port memory`/`--seed` seam swaps only the facts source — the
// seeded memory port probed by the core's own `portEngineFacts` — so hermetic runs see the same
// decision path.
async function cmdHubMode({ projectId, projectSource, port, seed }) {
  const memory = port === 'memory' ? createMemoryPort() : null;
  if (memory && seed) await loadSeed(memory, seed);
  let result;
  try {
    const facts = memory
      ? async (id) => {
          const base = await portEngineFacts(memory, id);
          return base.reachable ? { ...base, detail: 'memory-port' } : base;
        }
      : undefined;
    result = await detectHubMode({ projectId, ...(facts ? { facts } : {}) });
  } finally {
    await memory?.close();
  }

  const engine = result.evidence.engine;
  const engineLine = engine.reachable
    ? `engine reachable${engine.detail ? ` at ${engine.detail}` : ''}`
    : `engine unreachable (${engine.reason})`;
  const initialized = result.evidence.initialized === null ? 'unknown' : result.evidence.initialized ? 'yes' : 'no';
  const markdownHub = result.evidence.markdownHub ? 'present' : 'absent';

  console.log(`hub-mode '${projectId}'`);
  console.log(projectEchoLine({ projectId, projectSource }));
  console.log(`  mode:     ${result.mode}`);
  console.log(`  evidence: ${engineLine}; initialized: ${initialized}; ${MARKDOWN_HUB_ENTRY}: ${markdownHub}`);
  if (result.next !== null) console.log(`  next:     run the \`${result.next}\` skill`);
  return EXIT.OK;
}

// --- dispatch ------------------------------------------------------------------------------------

async function dispatchGraph(command, rest) {
  if (command === undefined) throw new UsageError('missing subcommand; expected `graph <init|validate|status|refresh|export|backup|restore|migrate-schema>`');
  switch (command) {
    case 'init':
      return cmdInit(parseOptions(rest, INIT_OPTIONS, { usageLabel: 'init' }));
    case 'validate':
      return cmdValidate(parseOptions(rest, SHARED_OPTIONS, { usageLabel: 'validate' }));
    case 'status':
      return cmdStatus(parseOptions(rest, SHARED_OPTIONS, { usageLabel: 'status' }));
    case 'refresh':
      return cmdRefresh(parseOptions(rest, SHARED_OPTIONS, { requireRoot: true, usageLabel: 'refresh' }));
    case 'export':
      return cmdExport(parseOptions(rest, EXPORT_OPTIONS, { usageLabel: 'export' }));
    case 'backup':
      return cmdBackup(parseOptions(rest, BACKUP_OPTIONS, { usageLabel: 'backup' }));
    case 'restore':
      return cmdRestore(parseOptions(rest, RESTORE_OPTIONS, { usageLabel: 'restore' }));
    case 'migrate-schema':
      return cmdMigrateSchema(parseOptions(rest, MIGRATE_OPTIONS, { usageLabel: 'migrate-schema' }));
    default:
      throw new UsageError(`unknown subcommand '${command}'; expected one of: init, validate, status, refresh, export, backup, restore, migrate-schema`);
  }
}

function dispatchContext(command, rest) {
  if (command === undefined) throw new UsageError('missing subcommand; expected `context resolve`');
  if (command !== 'resolve') {
    throw new UsageError(`unknown subcommand '${command}'; expected one of: resolve`);
  }
  return cmdContextResolve(parseContextOptions(rest));
}

function dispatchPromotion(command, rest) {
  if (command === undefined) throw new UsageError('missing subcommand; expected `promotion <create|preview|apply|discard>`');
  switch (command) {
    case 'create':
      return cmdPromotionCreate(parsePromotionOptions(rest, PROMOTION_CREATE_OPTIONS, { usageLabel: 'create' }));
    case 'preview':
      return cmdPromotionPreview(parsePromotionOptions(rest, PROMOTION_PREVIEW_OPTIONS, { usageLabel: 'preview' }));
    case 'apply':
      return cmdPromotionApply(parsePromotionOptions(rest, PROMOTION_APPLY_OPTIONS, { usageLabel: 'apply' }));
    case 'discard':
      return cmdPromotionDiscard(parsePromotionOptions(rest, PROMOTION_DISCARD_OPTIONS, { usageLabel: 'discard' }));
    default:
      throw new UsageError(`unknown subcommand '${command}'; expected one of: create, preview, apply, discard`);
  }
}

async function dispatch(argv) {
  const [group, command, ...rest] = argv;
  if (group === undefined) throw new UsageError('missing command; expected `graph`, `context`, `promotion` or `hub-mode`');
  switch (group) {
    case 'graph':
      return dispatchGraph(command, rest);
    case 'context':
      return dispatchContext(command, rest);
    case 'promotion':
      return dispatchPromotion(command, rest);
    case 'hub-mode':
      // A top-level command with no subcommand: everything after the group word is options.
      return cmdHubMode(parseOptions([command, ...rest].filter((arg) => arg !== undefined), HUB_MODE_OPTIONS, { usageLabel: 'hub-mode' }));
    default:
      throw new UsageError(`unknown command group '${group}'; expected one of: graph, context, promotion, hub-mode`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const code = await dispatch(argv);
    // A command that returned without printing its echo (a failure before any report block —
    // guard refusals, structured failure exits, thrown errors) still declares its resolution.
    echoProjectResolution();
    return code;
  } catch (error) {
    echoProjectResolution();
    if (error instanceof UsageError) {
      console.error(`steepy-formula: ${error.message}`);
      console.error(USAGE.trimEnd());
      return EXIT.USAGE;
    }
    if (error instanceof TypeError) {
      // Programmer error — a core module rejected an argument the CLI itself built. Surfaced as
      // a bug (exit 2) with an explicit label, never silently mapped to a data condition.
      console.error(`steepy-formula: internal error (TypeError): ${error.message}`);
      return EXIT.USAGE;
    }
    console.error(`steepy-formula: ${error.message ?? String(error)}`);
    return EXIT.OPERATIONAL;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`steepy-formula: ${error?.message ?? String(error)}`);
      process.exit(EXIT.OPERATIONAL);
    });
}
