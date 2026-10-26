# Architecture

How the product is built. Read this to contribute or to understand the machinery; day-to-day usage is covered by the [README](../README.md).

steepy-formula is a multi-harness product — one canonical core installed natively in Claude Code, Codex, OpenCode, Pi, and DeepSeek Harness. The harness/ceremony machinery runs on Node.js built-ins only (Node >= 24); the Stable Knowledge Graph engine adds exactly one pinned runtime dependency behind the engine adapter (the **bounded dependency policy** — it supersedes the former zero-runtime-dependency rule for the graph fork).

## Command-family effects matrix

Filesystem reads–writes–subprocesses–temporary state–providers/network are not one global permission claim. Local validators read a repository while scaffolders and version transactions write it; the graph families (`graph`, `context`, `promotion`) run a local Docker engine, read the database credential from the secret-provider chain, and write curated knowledge only through a confirmed promotion (repository topology refreshes, restores, and schema migrations are explicit commands); observability may read a configured session store; review and controller workflows run tests, Git, and supported harness subprocesses with confined work state; release-evidence validation runs Git and `npm pack --dry-run` with a temporary cache but never a provider; live model-mapping verification can contact OpenCode/provider provenance; installation and native canaries use the selected host's cache, credentials, and network. Dated observations remain version-specific evidence rather than a current-runtime guarantee. The per-family table is under [Trust & safety](#trust--safety).

```
steepy-formula/
├── .claude-plugin/      # Claude Code plugin.json + marketplace.json + directory listing icon
├── .codex-plugin/       # Codex plugin.json (skills, interface)
├── .agents/plugins/     # marketplace.json — the repo as a Codex marketplace root
├── adapters/            # OpenCode plugin + Pi extension + dsh (DeepSeek Harness) plugin + MCP server (thin, dependency-free wiring)
├── skills/              # the 11 skills — the canonical, harness-neutral core
├── scripts/             # Node executables the skills invoke
│   └── formula/         # the Stable Knowledge Graph engine (core + engine adapters + CLI)
├── templates/           # the markdown the scaffolders render into a repo
└── tests/               # node --test suite + fixtures
```

## The Stable Knowledge Graph product

The **Stable Knowledge Graph** is the canonical authority for repository knowledge: a typed, persistent, queryable graph database. A repository that still carries a steepy-apex `.apex/` Markdown hub is a one-time migration source: the `graph-migrate` skill moves it into the graph. The governance content itself lives in the graph: the migrated rules, the defined terms, and the ratified decisions.

### Canonical terminology

- **Stable Knowledge Graph** — the durable governance graph used to direct work in a repository; the only authority for stable knowledge.
- **Hub** — redefined from the former Markdown DAG: the Hub IS the Stable Knowledge Graph.
- **Promotion** — a reviewed transaction that changes the Stable Knowledge Graph.
- **Promotion Scenario** — an isolated preview of proposed graph changes before approval.
- **Typed deferred proposal** — a speculative delta recorded in a spec with its target graph type (Term/Rule/Decision), concern, and scope; the input unit that review's sweep assembles into a Promotion Scenario.
- **Concern** — the stable subject on which rules may agree, conflict, or override one another.
- **Context resolution** — deterministic traversal that returns the knowledge applicable to task paths or explicit targets.
- **Work Graph** — the disposable operational state (specs, plans, ledgers, sessions, raw evidence) under `.formula/work/`, gitignored and safe to delete.

### Domain core (`scripts/formula/core/`)

The engine-independent domain core owns every graph behavior — it is the canonical authority for schema validation, audit, and export (portable-first enforcement):

| Module | Responsibility |
|---|---|
| `ontology.mjs` | The closed typed schema: curated node types (Project, Surface, Component, Rule, Decision, Term, Check, Agent, Skill) and repository-derived types (Repository, Workspace, Package), the canonical relationship table, lifecycle states, and the versioned extension-namespace rule. |
| `ids.mjs` | Project-qualified identity (`apex:<projectId>:<localId>`), immutability and non-reuse, cross-project rejection. |
| `validate-graph.mjs` | The portable graph **validator**: every blocking invariant (duplicate IDs, illegal types/endpoints, cycles, unresolved concern conflicts, **semantic reachability from Project**) plus advisory warnings; runs identically on any engine. |
| `revision.mjs` | The audit model: typed ChangeSet operations, **hash-chained Revisions** (git-style, in-graph, written in the promotion transaction), chain verification and **replay detection** for out-of-band writes. |
| `export.mjs` | The SHA-256 integrity-checked portable export/restore (full graph + Revision chain + head revision + digest), import, and retention pruning. |
| `topology.mjs` | Repository/Workspace/Package detection and refresh with the automated-writer actor identity. |
| `resolve-context.mjs` | The deterministic context **resolver** traversal (path → Package → Component → Surface → Rule → Check/Agent/Skill/Term). |
| `context-output.mjs` | The Layer 0–3 context layers, deterministic budget, and the versioned `context.json` / `context.md` contracts. |
| `promotion.mjs` | Promotion Scenarios, the advisor, the typed diff report, and the sole-writer apply path with export-on-promotion. |
| `scenario-assembly.mjs` | The typed-candidates → operations mapping behind `promotion create`: terms, rules, and decisions become graph operations (rules carry concern/strength and an APPLIES_TO edge; readme notes are reported out-of-graph; no `Check` is ever generated); reuses `promotion.mjs` for create/inspect — the schema's only interpreter. |
| `hub-mode.mjs` | The one-per-run documentation-hub mode detection (`graph` / `migrate` / `none`; `migrate` whenever a `.apex/` area is present, even over an initialized graph) behind the top-level `hub-mode` CLI declaration, with the next skill to run (`graph-migrate` for `migrate`, `init` for `none`) — the single tested authority the chain skills invoke instead of re-implementing detection. |
| `schema-migrate.mjs` | The shadow-build schema migration workflow (transform → validate → cutover). |
| `markdown-hub.mjs` | Recognizes a leftover steepy-apex `.apex/` area in any form (the `migrate` state) and a Markdown hub inside it (`.apex/_INDEX.md`), and carries the shared refusal (exit 25) every workflow script raises while the area is present. |
| `migrate-markdown.mjs` | The one-time steepy-apex Markdown extraction with `file:line` provenance. |

### Engine port and adapters

`scripts/formula/engine/port.mjs` is the database port contract — the vocabulary, error triple, and pure argument validators shared by every adapter; it speaks qualified IDs and plain JSON, never vendor records (mechanism, never policy). Two adapters implement it, both held to the same `tests/formula-engine-contract.test.mjs`:

- `memory.mjs` — the in-memory reference/test double.
- `arcadedb.mjs` — the shipped engine adapter over the Neo4j Bolt wire protocol using the pinned `neo4j-driver`, against ArcadeDB (pinned stable release). `lifecycle.mjs` owns the local docker lifecycle: create/start/stop/status/destroy for a loopback-bound server (localhost-first).

The **capability map** is measured, never assumed: `roles: true`, `nativeConstraints: true`, `onlineBackup: true`, `atomicCutover: false`. Degradations are recorded in the adapter, never silent.

### CLI

`scripts/formula/cli.mjs` is the thin `steepy-formula` bin — parsing, dispatch, and a documented exit-code table only; every behavior delegates to the core. Command families:

- `steepy-formula graph` — `init` (local engine lifecycle + topology), `validate`, `status`, `refresh`, `export`, `backup`, `restore`, `migrate-schema`.
- `steepy-formula context resolve --path <p>... | --target <id>...` — emits `context.json` + `context.md` with the deterministic budget and failure codes.
- `steepy-formula promotion create|preview|apply|discard` — `create` maps a typed candidates file into a draft scenario (invalid candidates exit 2 with the violation list; nothing is applied; the proposer is a typed `agent-proposer` actor); the typed diff IS the preview; `apply` refuses (exit 21) without an explicit human confirmation; the approver is a typed actor.
- `steepy-formula hub-mode` — the top-level declaration command for the repo's documentation-hub mode (`graph` / `migrate` / `none`) with one evidence line (its `.apex/:` field reads `absent`, `present (Markdown hub)`, or `present (no Markdown hub)`) and, in `migrate` and `none`, a `next:` line naming the skill to run (`graph-migrate` or `init`); always exit 0 — a declaration for reports, not a gate.

### MCP server

`adapters/mcp/formula-mcp.mjs` exposes the read tools (`resolve_context`, `get_node`, `trace_rule`, `graph_status`, `preview_promotion`) and registers `apply_promotion` **only** when the host declares a human-approval capability — otherwise apply remains CLI-only.

### Mutation boundary

The **sole-writer promotion service** is the only normal writer by architecture: write credentials exist only inside the promotion path; `context resolve` and the Explorer receive **read credentials** (a per-database read-only group where the engine provides roles). Where the engine cannot enforce the distinction, the Revision hash chain detects bypasses inconsistent with retained history; it does not prevent writes or authenticate their producer. On a local-first deployment nothing stops the machine owner — the boundary targets accidents and agents.

### Backup contract

The graph mutates only through promotions, so backup is event-driven: after every approved promotion the core writes the SHA-256 integrity-checked export (**export-on-promotion**; no unconditional zero-loss guarantee) when the caller configures `exportDir`, with configurable **retention** (default: last 10 plus one per day). The shipped CLI does not configure one today (`promotion apply` reports `export: none`), so explicit `graph export` / `graph backup` snapshots remain the operating procedure. Engine-native online backup (`onlineBackup: true`) is additive where available; `graph backup` writes both, and `graph restore` validates the imported graph and replays the chain before declaring success.

### Audit model

Every promotion writes its ChangeSet and a **hash-chained Revision** in the same transaction (a change and its record can never diverge, even across a crash). Each Revision carries the previous hash, typed proposer/approver identity, and a self-contained provenance snapshot. `graph validate` replays the chain against the materialized graph — state unexplained by the retained Revision history is reported as an out-of-band write (**replay detection**).

Portable exports use a SHA-256 digest and a hash-chained retained Revision history. Validation detects changes inconsistent with that retained history; it does not authenticate the author or producer. An attacker who rewrites the full history and recomputes every checksum can evade those integrity checks. Keep independently trusted checkpoints when provenance matters.

## `scripts/` — the engine

Pure Node, no dependencies beyond the graph adapter above. The skills shell out to these; `scripts/formula/` holds the graph engine described in the previous section.

| Script | Responsibility |
|---|---|
| `reviewer-response.mjs` | Gates Gear-3 reviewer responses (status/artifact/signals only) with Git snapshots and replay-validated receipts, and binds task approval to its latest execution digest. The conductor requires task/final proof bound to the full plan contract and handoff, and verifies every execution ancestor against its exact phase manifest before accepting implementation. Retained approval keeps its original identity; active references advance atomically without rewriting history. The skill owns dispatch. |
| `source-observation.mjs` | Observes branch, HEAD, index, tracked and nonignored untracked source using exact Git filenames; validates source paths separately from work artifacts and detects source continuation/drift. Unsupported submodules fail closed. |
| `task-results.mjs` | Begins and captures immutable v2 task executions, freezes reports, resumes durable captured results without writer redispatch, projects JSON task indexes, and verifies lineage, all task reports, and current source. Same-task previous execution and latest global parent are separate links. Explicit retry executions can continue valid NEEDS_CONTEXT/BLOCKED results after a remedy while preserving partial work; malformed or ambiguous evidence cannot authorize retry. |
| `autopilot-context.mjs` | Builds and validates versioned role-local context manifests, materializes the criteria-only review artifact, and exposes strict plan/handoff verification commands. Hub context is the one resolved graph context: it resolves through `steepy-formula context resolve` (`resolveGraphHubContext`) into a confined run artifact, never the archived Markdown hub. |
| `autopilot-observability.mjs` | Implements the dependency-free observability bridge: incremental framing, safe/exact raw persistence, event curation, redaction, and bounded multi-destination backpressure. |
| `autopilot.mjs` | The **gear-3 autopilot conductor**. Parses the extended verdict-artifact contract at a spec head (frozen strict parser), writes deterministic versioned role manifests (including the resolved-context reference and scalar contract metadata), derives review evidence it can derive (criteria-only artifact, aggregate `git` diff from the run's baseline commit), then spawns `plan → implement → review` as fresh headless harness sessions — one child per finite phase/task lifecycle. Hub context for a concrete missing fact resolves through the canonical graph (`steepy-formula context resolve`), never the archived Markdown hub. It halts on `BLOCKED`, a mid-run `CONFLICT`, explicit safety/failure conditions, or I/O integrity failure; it always stops before bump/PR. |
| `bump-version.mjs` | Stages and validates all three manifests, retains one durable recovery target, publishes by per-file atomic rename under the repository lease, and rejects incomplete transactions in `--check`. |
| `capture-review-evidence.mjs` | The **bounded review-evidence collector**. Runs the surface test, optional Gear-4 verifier, and the coherence gate in order — a built-in `steepy-formula graph validate`, replaced verbatim by `--gate-command` when passed (there is no `--no-gate`); streams complete combined output to a confined current-run evidence artifact; emits only a compact hash/count/status/excerpt receipt to the reviewer context. Capture failure enters one awaited path that converges the detached child group and streams before closing its descriptor, and no later command starts. |
| `correction-guard.mjs` | The **Gear-3 correction guard**: the durable persistence and lifecycle CLI over `correction-state.mjs`. A run derived from its plan keeps hash-chained record envelopes (`record-<n>.json`, each binding the SHA-256 of the previous record's bytes and its actor) under the run's `correction/` work directory, written create-only through `work-paths.mjs` after the candidate record is applied to the replayed state, so a refused transition writes nothing. Replay reads records by exact name until the first absent one, never listing a directory, and treats any chain, envelope or fold failure as an integrity error. Every mutating action refuses a halted run and compares the observed source with the last recorded observation; a drift outside an authorized, not yet recorded writer appends `RUN_HALTED`. An autopilot drive binds each mutating action to the implement phase manifest of its run id and attempt; reopening is a human grant that refuses both. The evidence actions record an iteration's outcomes only at the run's next step: `record-writer` binds the writer (an autopilot execution receipt verified by `task-results.mjs`, or a manual four-field response read from stdin with its task report) and writes the candidate snapshot of every source path changed since the cycle baseline (64 MiB of raw bytes at most); `verify-check` captures each surface test with the built-in coherence gate through `capture-review-evidence.mjs` (the gate alone when a cycle has no surface test), validating the checks before any command runs and halting the run when a capture leaves the source off the candidate; `record-review` binds the reviewer (a `reviewer-response.mjs` receipt or a manual response) with the defects artifact named for its step, judging the defects and rubric with the reducer's exported validators and recording an invalid review `INVALID`; `record-diagnosis` binds the diagnostic's artifact and decides its validity from current bytes; `prove-isolation` proves a stopped task cycle isolated or halts the run with recovery evidence. A review or diagnosis that changed the source, a record the reducer refuses as an integrity fault, and any integrity failure once an evidence action has prepared (an unverifiable receipt, unreadable evidence, a corrupt baseline) append `RUN_HALTED`; the guard never restores files and never runs a mutating Git command. `project` writes the terminal summary block into the task result index keeping every other byte. The CLI (`--action open|next|open-cycle|reserve|authorize|record-interruption|admit-retry|stop|reopen|project|verify|record-writer|verify-check|record-review|record-diagnosis|prove-isolation`) prints one JSON line and exits 0 success, 1 refused or invalid input, 2 usage, 3 integrity (the run halted or its evidence is corrupt), 25 migrate; `main` resolves to the exit code. |
| `correction-state.mjs` | The **pure Gear-3 correction-state reducer**. It folds closed `{ kind, ...payload }` correction records into a deep-frozen state and refuses with `{ ok: false, code, message, identity }` from the deep-frozen `CORRECTION_CODES` vocabulary. **Cycles and allowances:** each per-scope cycle opens with its derived, non-negotiable verification bindings and allows three iterations, one diagnosis slot charged to that allowance, role-checked dispatch authorization, and retry admission bound to recorded evidence. **Outcomes and defect identity:** writer, check and review outcomes conclude iterations with defects under stable ids. **Stagnation and candidate ranking:** a correction is compared with the previous comparable outcome on metric deltas alone, so stagnation, an unavailable comparison or exhaustion stops the cycle; candidates are ranked by attributed evidence. **Run-level scheduling (`nextCorrectionStep`):** one cycle is open at a time, a task opens only once its dependencies are approved, so dependency-blocked tasks never run, and the final review runs on whatever was delivered and changes only approved tasks. **Isolation:** a stopped task cycle must prove isolation (`decideIsolation`: baseline-equal or retained-best) before the run continues, and an unprovable isolation halts the run. **Reopening:** a stopped scope reopens only through a human `REOPEN_AUTHORIZED` naming the scope and a new remedy, which opens a linked cycle with a fresh allowance. **Terminal summary:** `summarizeCorrectionRun` reports a run as `PENDING`, `COMPLETE`, `PARTIAL` (always unapproved) or `HALTED`, and is projected as a parseable handoff block that a halted run never produces. It imports nothing, so it has no filesystem, subprocess, or sibling-module access. |
| `cost-report.mjs` | Aggregates repository-scoped interactive-session usage and confined headless ledger/raw evidence into a harness-neutral observational cost and token report. |
| `detect-stack.mjs` | Reads `package.json` / `pnpm-workspace.yaml` to detect the package manager and discover **surfaces** (workspace packages) with their test commands. Recognizes npm/pnpm/yarn/cargo/go/python; only the JS ecosystem is auto-discovered. |
| `extract-changelog.mjs` | Extracts the exact `## vX.Y.Z` section body used as release notes, rejecting missing, malformed, or prefix-only version matches. |
| `inception-protocol.mjs` | Validates and canonically renders v2 inception formats and provides token-bound publication primitives for confined staging, fsync, rename and exact-target verification. It never chooses phases, mutates descriptor state independently, or executes application commands. |
| `inception-snapshot.mjs` | Observes complete application inventories and compares content/mode identity while excluding physically bound local workflow and Git areas, recognized scaffold lease directories and approved exclusions (before approval, the start exclusions) before traversal; Git status uses the same excluded set. |
| `capture-inception-evidence.mjs` | Executes one approved inception check, seals separate output streams, and binds its receipt through the state helper; interrupted capture recovery never reruns the command. |
| `inception-governance.mjs` | Prepares and finishes exact init provenance, preserving completed inception evidence and rejecting application drift outside certified governance operations. Governance certifies no Markdown document and has no `documents` step: it binds the exact scaffold operations, and the stable knowledge lands through the graph's initialization promotion. |
| `inception-state.mjs` | Records and verifies inception run state under `.formula/inception/`: the run descriptor, classification of the starting state, phase transitions, approval and checkpoint records, persisted units and the sole writer, full snapshots, immutable effect records, verification cycles/sessions, derived summary/completion, recoverable byte-reserved publication, resume notes, and descriptor-independent abandon. It never asks questions, chooses a phase, approves, or runs project commands. |
| `live-scaffold-canary.mjs` | Builds an isolated scaffold fixture and binds every row to source revision, exact payload hash, product version, and installation composition. Claude/Codex/OpenCode can PASS only `descriptor-nonce-response`, an evidence slice rather than plugin-load or specialist proof; Pi and DSH remain descriptor-free for Steepy's deterministic runner and unsupported/unauthenticated outcomes stay `NOT RUN`. |
| `loop-engineer.mjs` | The **terminal Gear-4 controller**. It validates the ratified goal and commit authorization, drives verifier-bounded attempts through an injected headless runner, enforces blast radius and controller-owned keep/discard commits, performs whole-branch review, resumes from durable events, and emits only validated terminal projections. It takes `--graph-target apex:<projectId>:surface:<surface>` and resolves the surface context into the loop's `hub-context/`, recorded in `RUN_STARTED` so a resume under another binding or target halts with `HUB_MODE_DRIFT`. |
| `project-scaffold.mjs` | Public v1 planner and applicator for portable project instructions. It validates a confirmed project model (including its `hubMode`), previews an explicit operation/conflict plan, applies it under an exclusive repository lock, and makes a second repair a zero-write no-op. The scaffold is graph-only: a model must declare `hubMode: graph`, and the rendered navigation and specialist orientation point at `steepy-formula hub-mode` and `steepy-formula context resolve`. |
| `publish-directory-branch.mjs` | Builds the Claude directory payload commit from a source commit's tracked tree minus the root-anchored denylist (`tests/`, `.github/`, `.codex-plugin/`, `CLAUDE.md`) through a temporary index, leaving the working tree and real index untouched. It reobserves an existing version and accepts it only when its exact source identity and payload match, refuses a lower one, parents each new commit on the previous payload commit with a `Source-Commit` trailer, and pushes to `claude-directory` without ever forcing. |
| `release-publication.mjs` | Coordinates candidate-bound publication through injectable Git/GitHub commands. Revalidates schema-2 evidence, payload identity, and remote main eligibility before remote stages; creates only missing matching tags and nondraft releases, then invokes the directory publisher with independent evidence and main guards. Refuses identity mismatches and uncertain outcomes so retries reobserve remote state. |
| `push-version-guard.mjs` | Implements the development-only Claude PreToolUse guard that blocks invalid, equal or numerically downgraded versions on `git push` from `main`, while failing open for unrelated commands or unavailable Git state. |
| `render-claude-md.mjs` | Root-instruction CLI. Graph-only: it renders the root `CLAUDE.md` as the full project document carrying the graph navigation block between `<!-- steepy:start -->` / `<!-- steepy:end -->` markers (graph-migrate's `--upsert` cutover; init never runs it — there the planner's `claude-import` operation is the only `CLAUDE.md` writer), preserving user content outside the markers; `--mode` accepts only `graph`, and the CLI refuses (exit 25) while a steepy-apex Markdown hub is present. |
| `sanitize.mjs` | Provides shared dependency-free validation for safe relative paths, single-line values, YAML double-quoted scalars, non-root hub targets, and physical binding of supported project symlink mounts. |
| `structural-promotion.mjs` | The graph-flow structural scaffolder: maps a structural input file (Project/Surface/Component skeleton plus approved Rules and Terms) into a DRAFT Promotion Scenario through the core `createScenario` — the seam the `init` and `new-surface` graph flows drive, because `promotion create` carries only typed knowledge candidates. From an approved `testCommand` it derives the surface's verification Rule and its Check with the command persisted as `ext_v1_command`; ADDs already present in the stable graph are skipped and reported, and nothing is ever applied — preview/apply stay behind the ordinary `steepy-formula promotion` commands. |
| `template.mjs` | Performs strict pure-string `{{placeholder}}` substitution and rejects unknown template variables instead of leaking unresolved markers. |
| `validate-release-evidence.mjs` | Computes the exact npm-product-input identity, excluding exactly `docs/native-test-evidence.json`, `docs/native-test-evidence.md`, and `docs/release-audit-remediation.md`; no documentation directory or path family is excluded. Requires one reachable source commit across all records, materializes its package projection from committed tree paths, modes, and blob bytes (not archive output), and requires exact current/source package-input path, mode, and byte equivalence. It rejects unredacted values in its bounded assignment/flag/Bearer-or-Basic/header/cookie forms from commands and UTF-8 artifacts, requiring an exact whole-value redaction marker; this is not a general secret scanner, so human redaction review remains required. The mandatory `--product-only` workflow check validates lockstep manifests/changelog/version-transaction state. Default publication validation requires schema-2 candidate preflight and all four launch host/OS records with fresh redacted PASS observations; `--legacy-audit` is optional schema-1 historical validation and cannot authorize publication. It reads evidence and package inputs but never invokes a provider. |
| `verify-model-mappings.mjs` | Revalidates configured provider/model-tier mappings against live or injected evidence and reports `OK`, `STALE`, or explicitly non-blocking `UNKNOWN` results. |
| `version-policy.mjs` | Validates canonical safe-integer X.Y.Z versions, compares numeric precedence, and rejects invalid, equal-required, or downgraded release transitions. |
| `work-paths.mjs` | Defines the canonical ordered types `spec | goal | criteria | work-output` and repository-confined read, write, append, mkdir, and persistent-descriptor primitives for `.formula/work/**`: alias forms are rejected, never normalized; every ancestor and target is lstat-checked, symlinks, non-ordinary files and multiply linked targets are refused, and targets are bound by device/inode identity. |
| `workflow-state.mjs` | The **provider-neutral deterministic state kernel**. It validates the versioned workflow-event schema and JSONL bytes, correlates run/attempt identities, reduces events, shares baseline/reservation primitives with finite controllers, classifies commit reconciliation, and validates clean terminal state. |
| `write-all.mjs` | Supplies the shared synchronous complete-write primitive: it advances only on valid positive byte counts, retries short writes, and rejects zero, invalid, or thrown writes. |

Version updates provide recoverable per-file atomicity, not multi-file atomicity: an immutable
before/after journal keeps the same target across interrupted retries, exact bytes/modes are
preserved, and unexpected edits block. The existing project-scaffold lease serializes cooperating
writers; it is not an adversarial filesystem guarantee. Complete explicit targets are no-ops,
while required-increment release comparisons remain strict. File/directory fsync and rename
support are required; an incomplete journal always makes the release check fail.

The reusable GitHub validation workflow installs the pinned dependency from the lockfile, then runs
Node 24 tests, package composition, and product metadata checks with read-only permissions; the
docker-gated engine suites skip when no Docker daemon is available, and the graph coherence gate
(`steepy-formula graph validate`) needs a local engine, so it stays a release-time preflight.
Release makes the sole write-capable publishing job depend on that validation workflow. Schema-2 launch evidence is mandatory before publication remote mutations; schema-1 historical audit validation is optional with `--legacy-audit`. Payload identity
frames sorted canonical npm-package paths, modes, and bytes; excluding exactly
`docs/native-test-evidence.json`, `docs/native-test-evidence.md`, and
`docs/release-audit-remediation.md` permits an evidence-only commit without accepting untested
shipped changes. No documentation directory or path family is excluded. The evidence schema binds
source revision, product version and payload, host/profile, observation date, installation
composition, capability commands, PASS results, and the digest of the redacted artifact. It
documents evidence and does not establish that a provider actually ran; live review owns that
provenance.

Review-evidence process-group ownership is supported only on tested `linux` and `darwin`. It uses a
detached session boundary, waits for leader and stream settlement independently, and performs bounded
`SIGTERM` then `SIGKILL` convergence on failures and ordinary/nonzero exits. Descendants that
deliberately escape the spawned session are outside containment; bounded local stream settlement
prevents an escaped inherited-pipe holder from blocking descriptor closure indefinitely.

## Deterministic Gear-4 controller boundary

The machine-readable `events.jsonl` is authoritative. The controller reduces its strict, correlated
event sequence—including the exact baseline exit and monotonic observability-degradation fact—to
in-memory state; every `ledger.md` field and the `branch-diff.txt` projection are produced from that
state and the selected Git baseline. A stale or missing ledger can therefore be regenerated, but its
bytes never reconstruct or override controller state.

```text
ratified goal + mandatory commit authorization + Git baseline
                            |
                            v
                  loop-engineer.mjs
                            |
            ATTEMPT_RESERVED (durable first)
                            |
                supported headless runner
                            |
        owned diff -> blast radius -> verifier
                    /                    \
          commit intent + commit    discard intent + restore
                    \                    /
                     whole-branch review
                            |
             TERMINAL_RECORDED event authority
                    /                    \
        ledger.md + branch-diff.txt    consumed goal
              (projections)
```

`ATTEMPT_RESERVED` lands before runner dispatch, create-only attempt evidence, or mutation, so a
crash cannot reuse an attempt identity. Resume replays the event log and completes a commit or
discard only when event, snapshot, changed-path, and Git identities prove controller ownership.
Ambiguity appends `RECONCILIATION_REQUIRED` then `RUN_HALTED`; it never resets uncertain work.
Claude, Codex, and OpenCode have deterministic CLI descriptors. Pi and DeepSeek remain explicit
`runner-unavailable` refusals rather than falling back to a weaker inline loop.

## `adapters/` — the harness adapters

The `adapters` surface: thin, dependency-free wiring that serves the canonical `skills/` tree to each harness — never workflow behavior, which lives once in the core. Skills reference engine scripts skill-relatively (`node <engine-root>/scripts/<x>.mjs`, resolved from the skill's own base directory), so no adapter has to rewrite prose and no `CLAUDE_*` variable appears in the core (test-locked).

| Harness | Wiring |
|---|---|
| Claude Code | `.claude-plugin/` manifest + marketplace — the pre-existing plugin, unchanged behavior. |
| Codex | `.codex-plugin/plugin.json` (points at `skills/`) + `.agents/plugins/marketplace.json`, which makes the repo itself a marketplace root. |
| OpenCode | `adapters/opencode/steepy-formula.js` — a config hook pushes `skills/` into `config.skills.paths`, registers eleven `steepy-formula-<skill>` commands where supported, and injects a marker-guarded bootstrap block into the first message. Project hub agents are read only from `.opencode/agents/*.md` and only when the project carries the `.formula/config.json` graph binding; missing or invalid native directories register no project specialists, and Claude descriptors are never read. It also registers D2 dispatch agents: the tier trio (`steepy-cheap`/`steepy-standard`/`steepy-most-capable`) when `config.model` is a mapped provider pin — that trio is the per-dispatch tier choice — and without a mapped pin dispatch degrades to the declared session model. |
| Pi | the `"pi"` manifest in `package.json` (`skills`, `extensions`) + `adapters/pi/steepy-formula.js` — `session_start` bootstrap injection and eleven optional `/steepy-<skill>` command wrappers. |
| DeepSeek Harness | `adapters/dsh/steepy-formula.js`, wired via the root `cordis.patch.yml` bundle-patch file and `package.json`'s `dsh.bundle.patch` key. Registers three capabilities, each on its own dependency-gated child fiber: a `ctx.systemPrompt` section for bootstrap, eleven `steepy-formula-<skill>` commands, and the model-invocable `steepy_skill` tool. A command's output is rendered to the human and never enters model history, so a command can only name the tool call to make — that is why `steepy_skill` exists as the model-facing channel that actually loads a skill's exact prose (F3). |
| MCP | `adapters/mcp/formula-mcp.mjs` — the MCP server over the domain core (see above). |

Adapters are fail-open: every optional host API sits behind a capability check, so a host without a feature degrades to a no-op instead of an error. Where a harness lacks a capability the skills degrade along a declared path (inline specialist, session model) — stated in the output, never silent. Concrete D2 tier models come from `adapters/model-mappings.mjs` (the provider-keyed tier tables with per-row provenance) — the same tables `scripts/verify-model-mappings.mjs` checks for drift.

DeepSeek Harness's fail-open shape is dependency-gated activation rather than a synchronous presence check: each of its three capabilities runs on its own child fiber, gated on exactly the one host service it needs. A host that never composes one of those services leaves only that one capability's fiber pending forever — silently, with no error and no timeout — while the adapter's own fiber and the other two capabilities stay unaffected. This wiring degradation is declared in the adapter's own bootstrap block as well as here, per the "degradations are explicit, never silent" rule.

`adapters/headless.mjs` is the odd one out: not a session-injection adapter but a harness → headless one-shot command map (`claude -p`, `codex exec`, `opencode run`; `null` for a harness with no headless mode, e.g. Pi). It is what `scripts/autopilot.mjs` — the gear-3 autopilot conductor — uses to spawn each phase, and what tells `brainstorm` Step 7 whether autopilot can be offered on the current harness.

## Autopilot live-observability boundary

The headless path has a deliberately one-way dependency direction:

```
adapters/headless.mjs ── command descriptor ──► scripts/autopilot.mjs
adapters/headless-events.mjs ── decoded event ─► scripts/autopilot.mjs
scripts/autopilot-observability.mjs ── bridge primitives ─► scripts/autopilot.mjs
```

`adapters/headless.mjs` owns only the harness command descriptor and declared native capabilities. `adapters/headless-events.mjs` owns only protocol decoders for one structured output line; it does not choose persistence, timeout, or halt policy. `scripts/autopilot-observability.mjs` owns the common event envelope, line framing, raw serialization/redaction, curated rendering, and the bounded writer. `scripts/autopilot.mjs` owns orchestration: attempts, versioned manifests, artifact timing, status correlation, child lifetime, and the user-facing halt decision. The implement skill/controller validates artifact-first completion and the selected envelope before the next task decision: manual drive uses four fields, while autopilot uses status/artifact/signals and receipt-derived source paths. That controller routes an effective abstract controller tier; adapters apply or degrade the concrete model and return direct provider evidence. The adapters never import conductor policy, and the bridge never selects a harness command.

For each child stdout/stderr line, the conductor uses a raw-first flow: frame → serialize immutable raw JSONL → decode into the common event envelope where possible → curate the readable per-attempt and aggregate logs → write the same compact curated event to the bounded stdout/stderr live destination. Ordinary plain decoder failures use a source-labelled, redacted, length-limited passthrough; unknown or malformed structured data uses a generic fallback so arbitrary metadata and reasoning cannot enter the readable or live view. Reasoning and token deltas are never promoted.

The bridge enforces bounded backpressure across raw, readable, aggregate, and live destinations: it pauses a source while a required writer drains and bounds partial lines and pending writes. Its policy is intentionally hybrid. Failure to open, redact, fully write, or drain the immutable raw destination is blocking: the conductor terminates the whole child process group and halts. A readable, aggregate, or live destination write/drain failure is non-blocking: it records `OBSERVABILITY_DEGRADED`, disables that destination, and continues through the durable raw capture plus any healthy curated destinations.

The resource-usage ledger is append-only JSONL scoped to run, phase, and attempt. It records each direct provider measurement once with a source-event fingerprint: exact retransmissions deduplicate, while distinct provider phase aggregates from one session remain separate. Those distinct phase aggregates must not be summed unless provider evidence establishes disjoint scopes. Derived displays read the records rather than re-recording them, but persistence deduplication alone does not establish additivity. The ledger is observational evidence for context efficiency, never a budget or a healthy-work stop condition.

Process lifetime converges in `scripts/autopilot.mjs`: terminal interruption, optional native stop, explicit safety/failure condition, and a blocking bridge failure all enter one stop path, send `SIGTERM` to the detached child group, escalate to `SIGKILL` after a short grace, close destinations once, and settle the attempt once. A bounded I/O integrity timeout may protect a stalled read, write, or drain operation; it is not a phase duration or work timer. A live child that emits no output therefore remains active until it exits or receives an explicit stop; the conductor does not infer a hang from silence. This keeps descendants from outliving a halted phase. The entire path uses Node >= 24 built-ins only and has zero runtime dependencies.

The Gear-3 authority sequence is checkout lease and locked preflight → versioned status-protocol
declaration/validation → correlated child evidence plus process-group convergence → conductor-authored
`PHASE_ACCEPTED` → verified lease release. A failure before acceptance records a correlated halt when
durable status exists and never promotes the child's completion claim; an unverifiable release fails
the run and preserves the ambiguous generation for recovery. The lease is per physical checkout, so
parallel conductors require distinct Git worktrees. Deterministic process-group ownership is offered
only on tested `linux` and `darwin`, owns only the group it spawned, and is neither OS sandboxing nor
containment of descendants that deliberately escape that group.

## Portable project instructions

The public scaffold derives its output only from templates plus a confirmed project model:

```text
templates + confirmed model
          |
          v
project-scaffold v1 planner/applicator
          |
          +--> AGENTS.md managed common root
          +--> CLAUDE.md managed @AGENTS.md import
          +--> .agents/skills/<project>-bootstrap/SKILL.md
          +--> .claude/skills/<project>-bootstrap/SKILL.md (thin stub)
          +--> .claude/agents/<agent>.md
          +--> .codex/agents/<agent>.toml
          +--> .opencode/agents/<agent>.md
```

`AGENTS.md` is the only common root spine. The canonical bootstrap is harness-neutral in
`.agents`; Claude reaches it through its thin stub. The triads are native routing and
metadata only. The semantic authority is the
canonical graph, reached through `steepy-formula hub-mode` and `steepy-formula context resolve`
(there is no routing table, and the root `CLAUDE.md` is rendered separately with the graph
navigation block). The scaffold emits ordinary files and supports existing symlink mounts at the
repository entries `.apex`, `.agents`, `.claude`, `.codex`, `.opencode`, `AGENTS.md`, and
`CLAUDE.md`. Repair updates their physical destinations while preserving the links. Descendant
links remain refused. It never resolves a user-owned semantic conflict automatically.

Pi and DeepSeek Harness receive generic root/bootstrap/index guidance and inline
degradation; that guidance does not hardcode a host project's bootstrap name.

## `templates/` — what gets scaffolded

Markdown templates with `{{placeholder}}` variables — project instruction artifacts are rendered by the public planner; the graph-mode pair (`surface-agent-graph.md`, `bootstrap-skill-graph.md`) is completed by the `graph-migrate` and `new-surface` graph flows' prose; A script-substituted unknown placeholder throws, so a template typo on that path is a build error, not leaked output.

| Template | Becomes |
|---|---|
| `AGENTS.md` | The managed root instruction spine. |
| `claude-import.md` | The managed thin `CLAUDE.md` import of `AGENTS.md`. |
| `project-bootstrap-skill.md` | The canonical, harness-neutral project bootstrap under `.agents/skills/`. |
| `claude-bootstrap-stub.md` | Claude's thin stub pointing to the canonical bootstrap. |
| `surface-agent-claude.md` / `surface-agent-codex.toml` / `surface-agent-opencode.md` | One thin native adapter triad for each surface; `{{standardOrientation}}` resolves the surface context. |
| `bootstrap-skill-graph.md` | The graph-mode project bootstrap that `graph-migrate` writes at cutover — hub-mode declaration, `context resolve` navigation, coverage verdict, gear selection. |
| `surface-agent-graph.md` | The graph-mode specialist agent that the `graph-migrate` and `new-surface` graph flows render; it points at `steepy-formula context resolve --target apex:<projectId>:surface:<slug>` and reads the surface's test command from the resolved Check's `ext_v1_command`. |

## `tests/` — the safety net

Run with `npm test` (`node --test tests/*.test.mjs`) — no test framework, just the Node built-in runner. Coverage by concern:

- **Engine:** `detect-stack`, `structural-promotion`, `render-claude-md`, `markdown-hub` (the steepy-apex area recognizer), work-path confinement (`work-paths`), and bounded review-evidence capture — one suite each.
- **Stable Knowledge Graph:** `formula-ontology`, `formula-ids`, `formula-engine-contract` (parameterized: in-memory + ArcadeDB), `formula-validate-graph`, `formula-revision`, `formula-export`, `formula-arcadedb` (docker-gated), `formula-topology`, `formula-resolve`, `formula-context-output`, `formula-promotion`, `formula-promotion-apply`, `formula-hub-mode`, `formula-scenario-assembly`, `formula-bakeoff-veto` (docker-gated), `formula-boundary` (docker-gated), `formula-envelope` (docker-gated), `formula-cli-graph`, `formula-cli-context`, `formula-schema-migrate`, `formula-migrate-md`, `formula-mcp`, `formula-e2e` (docker-gated).
- **Scaffolding flow:** `init` (repair mode, non-destructive), `project-scaffold` (public planning/apply/conflict/lock behavior), `git-policy`, and `migrate-state` (the `migrate` hub-mode state: graph primitives keep working while every workflow script refuses).
- **Plugin wiring:** `workflow-skills` (the brainstorm→plan→implement→review skills are valid, hub-aware, and correctly chained), `new-surface` (the new-surface skill's graph procedure), `release-metadata` (identity, README/RELEASE/COMMUNITY copy stay consistent).
- **Multi-harness:** `portability-contract` (zero `CLAUDE_*`/absolute paths in `skills/`, open-subset frontmatter, engine-root resolution), `adapters` (Codex manifests, OpenCode plugin, Pi extension, DeepSeek Harness plugin — behavior-tested with stub hosts), `canary-structural` (isolated-HOME, env-scrubbed engine runs through literal skill-relative paths), `npm-pack` (the tarball carries every manifest, adapter, skill, and script).
- **Dogfood:** `dogfood-hub` imports the local-only recovery-checkpoint export of this repo's migrated graph (gitignored, so a fresh clone or CI skips these cases with an explicit reason), validates it, replays the chain, and resolves representative context.
- **Autopilot and Gear 4:** `autopilot` (headless command builder, contract parser + refusal guards, and the conductor drive loop — hermetic fake-harness children, real signals, process-group kill verification), `task-results`, `reviewer-response`, `source-observation`, `workflow-state`, and `loop-engineer` (crash/replay of the terminal controller).
- **Inception:** `inception-state`, `inception-protocol`, `inception-snapshot`, `inception-governance`, `inception-recovery`, `capture-inception-evidence`, `inception-application-scope`, `inception-skill`, and `inception-docs`.
- **Release tooling:** `bump-version`, `version-policy`, `write-all`, `push-version-guard`, `publish-directory-branch`, `validate-release-evidence`, `release-workflow`, and `extract-changelog`.
- **Fixtures:** `good-hub` / `modular-hub` / `conflict-hub` (Markdown-hub migration cases) and `pnpm-*` / `single-pkg` (stack-detection cases).

## Superseded rules (post-cutover promotions)

The following former Hub rules are superseded in their post-cutover form:

- **Hub redefinition** — the Hub is the Stable Knowledge Graph, not a Markdown DAG.
- **Anti-orphan rule superseded** — the Markdown "every doc reachable from `_INDEX.md`" rule is replaced by **semantic reachability from Project**: every curated stable node must be reachable from its Project root in the graph (a blocking validator invariant).
- **Zero-dependency rule superseded** — replaced by the **bounded dependency policy**: a small, pinned, encapsulated dependency set (exactly one package today, `neo4j-driver`) is allowed behind the engine adapter; the stable domain model never exposes driver records.
- **Stable/Work separation** — stable governance lives in the canonical graph; the Work Graph stays file-based, gitignored, and disposable under `.formula/work/`; deleting work files can never touch the graph.
- **Markdown as a one-time migration source** — a steepy-apex hub's Markdown rules are migration input only (`graph-migrate`); after cutover there is no permanent Markdown ↔ graph synchronization.

## Resolver performance

Context resolution currently reads the whole graph over Bolt. On the large regression fixture, warm resolution exceeds the one-second performance target. The regression suite uses a five-second ceiling; that ceiling is not a latency guarantee. See `tests/formula-envelope.test.mjs` for the fixture and measurements. Allow for graph size when integrating context resolution into interactive workflows.

## Local usage reports

`node scripts/cost-report.mjs --repo-root <root> [--harness <id>]` reports raw token
usage from the repository's autopilot ledgers and the harness session store.
Usage report schema version 7 separates exact observation identity from provider measurement
scope, sums only provably disjoint measurements, and publishes accounting coverage. Unsupported or
missing scope remains unknown, not zero; descriptive eligibility labels are not accounting evidence.
Only ledger schema version 2 is supported; other versions are counted as invalid or
unclassifiable and produce no dispatch rows.
Unknown-scope observations are retained, and missing-usage completions are durable observations,
never zero. Conflicting retransmission evidence is reported as one invalid, non-additive
observation and remains in provider-collision analysis.
Runtime provider-version evidence gates promotion: only OpenCode v1.18.27 has supported usage
semantics, while missing or different versions remain unknown.
Interactive session-store observations are excluded from additive rollups unless official provider
evidence establishes a disjoint measurement scope.
The default Claude store is the user's `.claude/projects` directory. Repository
attribution happens **after session files are read**: `--repo-root` filters the
report, but does not prevent reading other repositories' session files in that store.

Use `--session-store-root <root>` to select one exact store directory, or
`--no-session-store` to skip store collection entirely. These options are mutually
exclusive and control interactive session collection. Headless usage is read only
from the current conductor ledger; session-store entries such as `sdk-cli` remain
listed under `unclassifiedSessions` and never fill a missing or corrupt ledger.
Disabling the store leaves repository ledger reporting available and labels the
interactive channel `CHANNEL_UNAVAILABLE` with reason `store-disabled`.
Tests and automation that must avoid user data should supply a temporary store or
disable collection explicitly.

## Trust & safety

steepy-formula's scripts and adapters use Node built-ins plus exactly one pinned runtime
dependency (`neo4j-driver`, Apache-2.0) behind the graph engine adapter. It is not globally
offline or repository-only: effects depend on the command.

### Command-family effects matrix

Filesystem reads–writes–subprocesses–temporary state–providers/network vary by command family:

| Command family | Effects |
|---|---|
| Local validation and scaffolding | Reads the selected repository; scaffold/version commands write governed project files and durable transaction state.  |
| Graph families (`graph`, `context`, `promotion`, `hub-mode`) | `graph init` runs Docker: it pulls the pinned ArcadeDB image on first use, creates or reuses one container per project with every port bound to `127.0.0.1`, and writes the committed `.formula/config.json` project binding plus a create-only `.formula/.gitignore` that keeps every other `.formula/` file local. Engine commands read the database password from the secret-provider chain (the macOS keychain through `security`, then the owner-only `.formula/secrets.json`, then `STEEPY_FORMULA_*` environment variables) and talk Bolt to the local container. `context resolve` writes `context.json`/`context.md` to its output directory and `graph export`/`graph backup` write snapshot files. Curated knowledge changes only through `promotion apply`, after explicit confirmation; `graph refresh` rewrites the observed repository topology under the automated-writer identity, `graph migrate-schema` rebuilds the graph through a shadow build and cutover, and `graph restore` overwrites a non-empty database only with `--force`, after a verified pre-restore backup. `hub-mode` only reads. |
| Observability and usage reports | Reads repository ledgers and, unless disabled, the selected harness session store; it does not infer missing usage as zero. |
| Review/controller workflows | Run declared tests, Git, and supported harness subprocesses; Gear-3/4 create confined work state and require their stated authorization. |
| Release evidence validation | Reads package inputs, invokes `npm pack --dry-run` and Git, and uses an OS temporary cache; it never invokes a provider. |
| Model mapping verification | Its injected inputs support an offline test path; live mode invokes the OpenCode catalog and fetches provider provenance. |
| Inception | Writes `.formula/inception/` and the application's files; runs the approved tools (installs, generators, builds, tests); may reach official sources and package registries; remote operations only after explicit authorization. |
| Installation and native canaries | Host installation, authenticated sessions, and a genuine canary may use host caches, credentials, subprocesses, and network according to the host. |

Inception effect ownership stays with the coordinator: children can research or edit assigned bootstrap source, but request installs/generators/migrations/remote operations rather than executing them. The state helper owns descriptor mutation and short scaffold-lease publications; schema and snapshot modules never execute application commands. The collector is the single approved-check execution boundary, with registered identity, sealed separate streams, and no command replay during recovery. Governance receipts certify exact init outputs only, preserving the completed run and unmanaged application bytes. These are cooperative writer guarantees, not an adversarial local-filesystem security claim.

Graph-first `init` provisions the engine, applies the initialization promotion at your
confirmation, and writes the gitignored `.formula/work/` area, the managed root/bootstrap plus native
Claude/Codex/OpenCode agent triads, the root `CLAUDE.md`, and `.formula/config.json` in the target
project; after a complete inception run it also writes the `.formula/init-provenance.json`
certificate. It never writes a Markdown hub. This does not promise that every command writes only
there; review the command family before granting trust.

The plugin ships no hooks, so there is no hook wiring to review before trusting it.

### Autopilot task execution receipts

Fresh runs record TASK_RESULT_PROTOCOL 2 once and pin it in all phase and task-role manifests;
a resumed run lacking protocol 2 halts before dispatch (finish manually or start fresh). Manual drive
and Gear 4 are unchanged. The controller
records an exact task execution prefix in the authorized ledger before dispatch, captures the raw
semantic response and source observation, freezes the report, and publishes the result. Each file
uses staged fsynced atomic publication under the cooperating-writer lease; this is neither a
multi-file transaction nor protection from hostile concurrent writers. A durable capture can finish
publication on restart without repeating implementation. Baseline-only state cannot establish DONE.

JSON receipts are machine authority; the Markdown index is their generated projection, with exact
changedPaths arrays and retained lifecycle/reviewer references. Git filenames containing spaces,
commas, semicolons, Unicode, or newlines remain literal JSON strings. No brace expansion or model path
claim determines the changed set. A response carrying changed-paths is malformed; semantic
status/artifact/signals never come from report prose. Receipts retain cumulative task paths and each
execution's own paths, frozen reports, and the distinct same-task previous/global parent links.

Exact recorded state and schema-authorized links confined to the same task directory authorize only
machine replay, never work-directory scanning or extra child inputs. Source discovery remains normal.
Captured execution is review-pending, not approved. Task approval binds the latest execution; a fix
invalidates an older approval. Final review and conductor acceptance replay the receipt chain and
all required task/final approvals. No historical baseline is fabricated and no run is upgraded. Real-Git and isolated regression replay evidence does not certify native model behavior or
product correctness.


### Export publication failure and recovery

Durable export files are atomic per file: write a uniquely named exclusive temporary file, fsync it, rename over the target, then fsync its parent directory. Failure before rename preserves the prior target. Failure after rename can leave the new file visible with uncertain durability if directory sync fails; inspect and verify the target before retry. This is not multi-file atomicity or an adversarial filesystem guarantee.

Promotion commits the database transaction before a configured export. A failed post-commit export does not undo that promotion: inspect the committed head and retry export only (`graph export` or `graph backup`), never reapply the promotion to recover a file. A failed export cannot promise RPO zero. The shipped CLI does not configure `exportDir` today (`export: none`).
