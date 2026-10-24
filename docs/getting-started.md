# Getting started

Supported launch hosts are Claude Code and Codex on macOS and Linux with Node.js >= 24. Windows is unsupported. OpenCode, Pi, and DeepSeek Harness are experimental integrations; their adapters remain packed, but they do not substitute for launch acceptance. Observed host versions and architectures are evidence metadata, not minimum-version or architecture-support promises.

The end-to-end first-run guide: from zero to a running Stable Knowledge Graph, plus the
day-2 operations — starting and stopping the engine, exploring the graph, saving a specific
state, and handing the graph to a colleague. Day-to-day agent usage is covered by the
[README](../README.md); the internals by [architecture.md](architecture.md).

Everything here is local-first: the engine is a docker container bound to `127.0.0.1`, and
graph storage remains local; your agent can send resolved graph context and repository content to its model provider (see [privacy](../PRIVACY.md)).

## 1. Prerequisites

- **A supported harness** — Claude Code or Codex on macOS or Linux; experimental adapters are available for OpenCode, Pi, and DeepSeek Harness (see the [installation guide](installation.md)).
- **Node.js >= 24** — the CLI and scaffolders run on Node.
- **Docker** — the graph engine runs as a local container. The first `graph init` pulls the
  pinned image `arcadedata/arcadedb:26.8.1`, so the first run takes longer.
- **No docker?** The in-memory engine seam (`--port memory` on read commands, optionally
  seeded with `--seed <export-file>`) runs without docker for evaluation and tests — but it
  holds no durable state. Real governance needs the docker engine.

## 2. Pick a project id (and use it everywhere)

Every graph command takes `--project <id>`, but you only pass it once: the id resolves through
a fixed chain — `--project` flag > `STEEPY_PROJECT` env > the **committed** `.formula/config.json`
binding > the `demo` fallback — and `/steepy-formula:init` (its `graph init` pre-flight) persists
your choice into `.formula/config.json`, a committed repository artifact. From then on every
command reads the binding and echoes `project: <id> (config)`; an explicit `--project` (or
`STEEPY_PROJECT`) that contradicts the committed binding refuses up front — exit 3, nothing
provisioned — and `graph init --force` is the deliberate re-point. The id is lowercase kebab-case
(`[a-z][a-z0-9-]*`) and names three things:

- the docker container — `apex-graph-<project-id>`
- the database inside it — `apex_graph_<project-id>`
- every graph-qualified node id — `apex:<project-id>:<localId>`

Changing it later means a new, empty graph (plus a `--force` re-point of the binding), so choose once.

## 3. Credentials (before the first `graph init`)

The database root password is resolved from a secret-provider chain — never a CLI flag, never
committed. First hit wins:

1. **macOS keychain** — the slot `db-password` under service `steepy-formula`:
   ```bash
   security add-generic-password -U -a db-password -s steepy-formula -w
   ```
2. **Local config file** — `.formula/secrets.json` in the repo root (gitignore `.formula/*`
   **with the `!.formula/config.json` exception** — the project binding written by init is a
   committed artifact, while `secrets.json` must never be committed; a bare `.formula/` pattern
   would also hide the binding, because Git cannot re-include a file inside an ignored directory;
   the file must be readable only by its owner):
   ```json
   { "db-password": "your-local-dev-password" }
   ```
3. **Environment variable** (CI convention) — `STEEPY_FORMULA_DB_PASSWORD`.

If none is found, `graph init` generates a fresh random password **per run** — fine for a
throwaway evaluation, but a stored password is what makes the engine reuse stable across
commands and machines. On a localhost dev server the password is readable back via
`docker inspect` (that is what makes idempotent restarts work) — acceptable locally, and one
more reason every port stays bound to `127.0.0.1`.

## 4. First-time setup

Before invoking init, install the local checkout dependencies with `npm ci --omit=dev`, put its absolute `bin/` on the harness PATH, and run `command -v steepy-formula`. Use Node 24 and a running Docker daemon. A new project uses `inception` first; an existing repository uses `init` then `discovery`. After setup invoke the generated project bootstrap and `check`. Every graph promotion needs your approval of the exact preview before apply.

1. **Install the plugin** in your harness — see the [installation guide](installation.md).
2. **`/steepy-formula:init`** — the graph-first entry point: the Stable Knowledge Graph IS the
   hub, so no markdown hub is scaffolded. Under the hood:
   - a pre-flight hard gate resolves `db-password` (chain above), starts the container
     `apex-graph-<project-id>` (idempotent — creates, starts, or reuses it), and adopts the
     committed `.formula/config.json` binding (§2) — no repo file beyond the binding is written
     until the engine is provisioned and answering. A fresh graph correctly reports
     `initialized: no` (exit 4) until init's own promotion scenario lands below;
     `initialized: yes` on entry means an already-initialized re-run, which stops after
     validating and reporting;
   - creates the database `apex_graph_<project-id>` and verifies it answers;
   - detects Repository/Workspace/Package topology, interviews you for Surfaces, Components,
     and any initial Rules (Rules enter **only** through your explicit approval — never
     invented from stack detection);
   - after the gate, scaffolds only the disk-minimal harness assets: the gitignored
     `.formula/work/` area, per-surface specialist agents, the project bootstrap skill, and the
     root `CLAUDE.md`;
   - lands everything as one promotion scenario: `promotion preview` → your explicit yes →
     the agent runs `promotion apply --yes` → `graph validate` + `context resolve` green.
3. *(optional, existing codebase)* **`/steepy-formula:discovery`** — a seeded interview fills
   the graph from your code through a typed promotion scenario — every proposal confirmed by you.
4. Arriving from steepy-apex — your repo still has an `.apex/` area?
   **`/steepy-formula:graph-migrate`** walks a Markdown hub into the graph instead (extraction →
   preview → approval → transactional apply → validate → cutover → archive), or discards leftover
   local state after your confirmation, and removes `.apex/`; init itself does not migrate a
   steepy-apex hub.

From here on, give your agent any task: the generated bootstrap skill declares the hub mode
(and stops in `migrate` or `none`, pointing at `graph-migrate` or `init`), resolves the task's
context from the graph, and classifies it before touching code.

## 5. The engine lifecycle

| Operation | Command |
|---|---|
| Start / restart (idempotent — reuses a running server) | `steepy-formula graph init --project <id>` |
| Health, head revision, node/edge counts, topology staleness | `steepy-formula graph status --project <id> [--root .]` |
| Stop | `docker stop apex-graph-<id>` (no CLI stop command exists) |
| Remove the engine and its data | `docker rm -f apex-graph-<id>` — **export first** (§7); the data lives in the container |

`graph status` exits 3 when the server is down (re-run `graph init`) and 4 when the database
exists but holds no graph yet (the initialization scenario was never applied). To find the
Studio/engine URL again, read the `engine:` line of `graph init` output, or
`docker inspect apex-graph-<id>` → `NetworkSettings.Ports` (container port `2480` = HTTP/Studio,
`7687` = Bolt; host ports are chosen by docker).

## 6. Exploring the graph

- **ArcadeDB Studio** — open the `engine:` URL printed by `graph init`, sign in with user
  `root` and your `db-password` from the secret chain. Studio is the professional Explorer:
  browse nodes and edges visually, run queries. It reads the graph; the only normal write path
  is a promotion.
- **Typed promotion diffs** — `steepy-formula promotion preview --project <id> <scenario-id>`
  prints the exact ChangeSet a scenario would apply.
- **Deterministic navigation** — `steepy-formula context resolve --project <id> --path src/foo`
  (or `--target apex:<id>:<localId>`) emits `context.json` + `context.md` into the current
  directory (`--out <dir>` to choose, `--out -` to stdout).
- **Whole-graph snapshot to stdout** — `steepy-formula graph export --project <id> --out -`.
- **Without docker** — add `--port memory --seed <export-file>` to any read command to explore
  a SHA-256 integrity-checked export in an in-memory engine.

## 7. Saving a specific state

A "state" of the graph is its **head revision** (`r<n>`) — there are no branches or tags. You
capture a state as a **SHA-256 integrity-checked export**: a JSONL artifact carrying the full graph, the complete
hash-chained Revision trail, the head revision, and a digest.

```bash
# capture now (default file: ./<project-id>-export.jsonl)
steepy-formula graph export --project <id> --out checkpoint-r7.jsonl

# portable export (timestamped) + engine-native online backup
steepy-formula graph backup --project <id> [--to <dir>]

# replay a captured state: import, validate invariants, replay the chain
steepy-formula graph restore --project <id> --from checkpoint-r7.jsonl
```

- `restore` into a **non-empty** database is refused unless you pass `--force` — and `--force`
  first writes and verifies a pre-restore backup of what is there now, so an unexportable
  database is never destroyed. Restoring an older checkpoint over a newer graph is exactly
  this path.
- Exit 0 from `restore` means `validated: clean` and `chain: clean`.
- The core also supports **export-on-promotion** — every applied promotion writes a SHA-256 integrity-checked
  export with retention (last 10 plus one per day) when the caller configures an export
  directory. The shipped CLI does not configure one today (`promotion apply` reports
  `export: none`), so treat explicit `graph export` / `graph backup` after promotions you
  care about as the operating procedure.

Portable exports use a SHA-256 digest and a hash-chained retained Revision history. Validation detects changes inconsistent with that retained history; it does not authenticate the author or producer. An attacker who rewrites the full history and recomputes every checksum can evade those integrity checks. Keep independently trusted checkpoints when provenance matters.

## 8. Passing the graph to a colleague

The graph does **not** live in the repo — it lives in your local docker container. The
portable artifact is the SHA-256 integrity-checked export, and the whole hand-off is:

**On your machine:**

```bash
steepy-formula graph export --project <id> --out governance.jsonl
```

Send the file, or commit it to the repo as the shared **recovery checkpoint**. If you commit
it, re-export after every promotion so the checkpoint stays honest.

**On your colleague's machine** (plugin installed, docker running):

```bash
steepy-formula graph init  --project <id>                                # their own local container
steepy-formula graph restore --project <id> --from governance.jsonl     # same id — see below
steepy-formula graph validate --project <id>                            # final gate
```

- **Use the same `--project <id>`**: node ids inside the export are qualified with it, so
  restoring under a different id does not reproduce your graph. A checkout that carries the
  committed `.formula/config.json` binding makes this automatic — both sides can omit the flag.
- **Credentials never travel in the export.** Each machine resolves its own `db-password`
  through the secret chain — nothing to share, nothing to leak.
- **Integrity is verifiable relative to retained history.** The artifact carries a SHA-256 digest and the Revision trail is hash-chained; validation reports inconsistencies, subject to the limits below.
- **What does not travel:** `.formula/work/` (gitignored local specs and plans — disposable by
  design), your local password, and engine-native backup files (ArcadeDB-specific; prefer the
  portable export across machines).

After the restore, your colleague has the exact same governance state: same rules, same
routing, same revision head — and their own promotions continue the chain from there.

## 9. Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `graph init` exit 3, `docker is unavailable` | no docker CLI/daemon | start docker, or use `--port memory` for evaluation |
| `graph init` exit 3, binding mismatch | explicit `--project`/`STEEPY_PROJECT` contradicts the committed `.formula/config.json` | drop the flag to use the binding, or `graph init --force` to re-point it deliberately |
| `graph status` exit 3, server `stopped`/`absent` | container not running | re-run `graph init --project <id>` (idempotent) |
| `graph status` exit 4, `initialized: no` | database has no graph yet | run `/steepy-formula:init` (its initialization promotion scenario was never applied) |
| any read exit 1, `schema version ... refused` | graph written by a newer schema | `steepy-formula graph migrate-schema` |
| `restore` exit 3, refuses non-empty target | overwrite safety refusal | add `--force` (a verified pre-restore backup is written first) |
| `promotion apply` exit 20 | scenario stale (head moved) | recreate the scenario against the new head |
| `promotion apply` exit 21 | no confirmation given | answer the interactive prompt (`y`/`yes`) or pass `--yes` deliberately |
| `graph status` shows `staleness: stale` | repo topology changed since the last refresh | `steepy-formula graph refresh --project <id> --root .` |
| a workflow script exits 25; `hub-mode` reports `migrate` | the repo still carries a steepy-apex `.apex/` area (a Markdown hub or leftover local state) | run `/steepy-formula:graph-migrate`, which migrates or discards it and removes `.apex/` |

If a configured post-commit export fails, inspect the committed graph head and retry export only, never reapply the promotion. Durable export publication is atomic per file: failure before rename preserves the previous target; failure after rename can leave a visible new target with uncertain durability until parent-directory fsync succeeds. Verify the file and retry `graph export` or `graph backup`; no RPO-zero guarantee follows from a failed export.
