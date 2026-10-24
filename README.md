<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-stacked-dark.svg">
    <img alt="steepy-formula" src="assets/logo-stacked-light.svg" width="365">
  </picture>
</p>

<p align="center"><em>Write the formula your AI races under.</em></p>

<p align="center">
  <img alt="harnesses: Claude Code · Codex · OpenCode · Pi · DeepSeek Harness" src="https://img.shields.io/badge/harnesses-Claude_Code_%C2%B7_Codex_%C2%B7_OpenCode_%C2%B7_Pi_%C2%B7_DeepSeek-C8873A?style=flat-square&labelColor=1B3149">
  <img alt="node ≥ 24" src="https://img.shields.io/badge/node-%E2%89%A5%2024-4A515B?style=flat-square&labelColor=1B3149">
  <img alt="deps: 1 pinned" src="https://img.shields.io/badge/deps-1_pinned-4A515B?style=flat-square&labelColor=1B3149">
  <img alt="license Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-4A515B?style=flat-square&labelColor=1B3149">
</p>

<p align="center"><sub>The Stable Knowledge Graph is the canonical authority; the graph format and skills evolve under semver, with schema changes migrated explicitly (<code>graph migrate-schema</code>).</sub></p>

Land governed project knowledge in a canonical Stable Knowledge Graph, route work by surface, and keep it coherent with graph validation.

Supported hosts are Claude Code and Codex on macOS and Linux with Node.js >= 24. Windows is unsupported. OpenCode, Pi, and DeepSeek Harness integrations are experimental. See the installation guide for setup and host-specific limitations.

Requires **Node.js >= 24**, **Docker** for the local graph engine, and Claude Code or Codex on macOS or Linux. Release notes are in the [changelog](CHANGELOG.md).

## Why steepy-formula?

In motorsport, the **formula** is the rulebook: the technical regulations every car in a series is built to and raced under. Respect it and a lap time means something; break it and the result doesn't stand. **steepy-formula** writes that rulebook for your AI: it governs a repository's stable knowledge in a **Stable Knowledge Graph** — a typed, persistent, queryable graph database that is the canonical source of truth for the rules your coding agents race under. The graph is not a cache of Markdown: it is where stable knowledge is created, validated, versioned, audited, queried, and superseded.

- **Start from an idea** — `/steepy-formula:inception` turns an idea, a design, or a prototype into a verified, runnable first version before any hub exists, then hands off to `init` and `discovery`.
- **Canonical graph as authority** — the Stable Knowledge Graph is the single source of stable knowledge; a steepy-apex `.apex/` Markdown hub is only a **one-time migration source** for `/steepy-formula:graph-migrate`, never a second authority.
- **Deterministic context resolution** — `context resolve` returns the rules, owners, checks, skills, and rationale applicable to a task path or target, each with the graph path that made it applicable.
- **Human-approved promotion** — every change to stable knowledge is a reviewed, isolated scenario applied by a human-approved promotion transaction and recorded in a hash-chained revision. The core can auto-export on every promotion (configurable export directory + retention); `graph export` / `graph backup` capture a SHA-256 integrity-checked state at any time.
- **A real graph engine, pinned** — ArcadeDB (pinned release) behind a portable engine adapter, with **Studio** as the professional Explorer; an in-memory reference port runs without Docker for development and tests.
- **Local-first** — the engine runs in a local docker lifecycle bound to localhost; graph storage stays local; resolved context can reach your harness provider (see [privacy](PRIVACY.md)).
- **Audit by construction** — a hash-chained in-graph Revision trail with replay detection: out-of-band writes inconsistent with retained history are reported by `graph validate`.
- **Graph-aware workflow chain** — a self-contained `brainstorm → plan → implement → review` flow where stable knowledge stays coherent, local specs/plans live under `.formula/work/`, and review's insight sweep assembles the durable decisions it discovers into a Promotion Scenario, applied only at an explicit human gate before work is declared done. Small fixes stay fast; a closed design with a machine-verifiable goal can run as a bounded autonomous loop.
- **Complexity-matched models** — plans rate every task's complexity; implementation dispatches the cheapest model tier that can carry it and records each choice in a run ledger. [Provider-aware model selection](docs/workflow.md#model-selection) adapts to the harness; hosts without per-task selection use the session model.

Stable knowledge stays versioned in the canonical graph. Specs and plans stay gitignored under `.formula/work/` as a local work artifact.

## Quick start

Install your harness first; steepy-formula requires **Node.js >= 24**, **Git**, and **Docker**.
npm and public plugin-directory availability are separate release steps. Choose your harness below;
local alternatives and troubleshooting are in [the installation guide](docs/installation.md).

### Claude Code

Before init, in the complete local plugin checkout, prepare Node.js >= 24 and a running Docker daemon, then install dependencies and put `steepy-formula` on PATH:

```sh
cd /absolute/path/to/steepy-formula
npm ci --omit=dev
export PATH="$PWD/bin:$PATH"
command -v steepy-formula
```

Keep that absolute bin directory on the harness shell PATH too; verify `command -v steepy-formula` there before continuing. Dependency installation and PATH setup are explicit local steps.

Run inside Claude Code:

```text
/plugin marketplace add steepy-it/steepy-formula
/plugin install steepy-formula@steepy-formula
```

Reload plugins and open the target repository. Set `export STEEPY_PROJECT=your-project-id` in the harness shell; configure a local database credential as [getting started](docs/getting-started.md#3-credentials-before-the-first-graph-init) describes, never in Git. For a new project run `/steepy-formula:inception`; for an existing repository run `/steepy-formula:init`, then `/steepy-formula:discovery`. Inception hands off to init/discovery. Approve the exact graph promotion preview before apply, invoke the generated project bootstrap, then `/steepy-formula:check`.
[Details](docs/installation.md#claude-code).

### Codex

Before init, in the complete local plugin checkout, prepare Node.js >= 24 and a running Docker daemon, then install dependencies and put `steepy-formula` on PATH:

```sh
cd /absolute/path/to/steepy-formula
npm ci --omit=dev
export PATH="$PWD/bin:$PATH"
command -v steepy-formula
```

Keep that absolute bin directory on the harness shell PATH too; verify `command -v steepy-formula` there before continuing. Dependency installation and PATH setup are explicit local steps.

Run in your terminal:

```sh
codex plugin marketplace add steepy-it/steepy-formula
codex plugin add steepy-formula@steepy-formula
```

Start a new Codex session in the target repository. Set `export STEEPY_PROJECT=your-project-id` in its shell and configure the local database credential as [getting started](docs/getting-started.md#3-credentials-before-the-first-graph-init) describes, never in Git. For a new project use `$inception`; for an existing repository use steepy-formula's `$init`, then `$discovery`. Inception hands off to init/discovery. Approve the exact graph promotion preview before apply, invoke the generated project bootstrap, then `$check`.
[Details](docs/installation.md#codex).

### OpenCode (experimental)

Clone the complete package to a permanent location:

```sh
git clone https://github.com/steepy-it/steepy-formula.git
```

Add its absolute file URL to the `plugin` array in your project's `opencode.json`:

```json
{ "plugin": ["file:///ABSOLUTE/PATH/TO/steepy-formula/adapters/opencode/steepy-formula.js"] }
```

Restart OpenCode in your project, run `/steepy-formula-init`, and approve access to the
checkout when prompted. [Details](docs/installation.md#opencode).

### Pi (experimental)

```sh
pi install git:github.com/steepy-it/steepy-formula
```

Start Pi in your project and run `/skill:init`.
[Details](docs/installation.md#pi).

### DeepSeek Harness (experimental)

Clone the package, then install it into your configured profile (replace `<name>`):

```sh
git clone https://github.com/steepy-it/steepy-formula.git
dsh plugin --profile <name> add /absolute/path/to/steepy-formula
```

Open that profile in your project and ask the model to call `steepy_skill` with
`skill: "init"`, then follow the returned instructions.
[Details](docs/installation.md#deepseek-harness).

## Get started

Use your harness's [command syntax](docs/installation.md#first-run-and-troubleshooting); Claude Code is shown here.

1. `/steepy-formula:init` - Initialize steepy-formula in your repo. Graph-first: a pre-flight engine gate, a short interview, then the local `.formula/work/` area for gitignored specs/plans, project instructions, per-surface agents, the project bootstrap skill, a root `CLAUDE.md`, and the committed `.formula/config.json` project binding. No markdown hub is ever created: the engine is provisioned and verified before anything is written, the interview confirms Surfaces, Components, and Rules (Rules are never invented from stack detection), and the initial graph lands as one promotion scenario applied only at your explicit confirmation. It closes with `graph validate` + `context resolve` green.
2. On an existing codebase, run `/steepy-formula:discovery` next: a seeded interview fills the canonical graph from the code you already have through a typed promotion scenario — each proposal backed by `file:line` evidence, nothing written without your confirmation.
3. Arriving from steepy-apex — your repo still carries an `.apex/` area? `/steepy-formula:graph-migrate` walks a Markdown hub into the graph (extraction → preview → approval → cutover → archive), or discards leftover local state after your confirmation, and removes `.apex/` — instead of init.
4. Run `/steepy-formula:check` to verify coherence, then give your agent any task. The generated bootstrap skill declares the hub mode, resolves the task's context from the graph, and classifies it — coverage verdict + gear — before touching code.
5. Resolve context anytime with the CLI: `steepy-formula context resolve --project <id> --path <task-path>` emits `context.json` + `context.md` — the navigation map the AI reads. That's where the rules stay honest from now on.

Starting from an idea or a prototype? Run `/steepy-formula:inception` first. It ends by pointing to `/steepy-formula:init` and `/steepy-formula:discovery`. That first init is certified against the completed run (the exact scaffold operations, with the stable knowledge landing through the graph's initialization promotion), and discovery imports the run's accepted decisions once, as typed graph candidates. See the [inception guide](docs/inception.md).

Migrating from steepy-apex? Read [Migrate an existing project](docs/installation.md#migrate-an-existing-project) first.

The full walkthrough — prerequisites, credentials, first run, lifecycle, sharing — is [docs/getting-started.md](docs/getting-started.md).

## Skills

Claude Code syntax is shown below; see the [installation guide](docs/installation.md#first-run-and-troubleshooting) for other agents.

| Skill | Purpose |
|---|---|
| [`/steepy-formula:inception`](docs/inception.md) | Turn an idea and its materials into a verified first version before the hub exists. |
| `/steepy-formula:init` | Graph-first init — pre-flight engine + credentials gate, stack/topology detection as proposals, Surface/Component/Rule interview, the initial promotion scenario applied at your confirmation, then disk-minimal scaffolding (work area, project instructions, per-surface agents, bootstrap skill, `CLAUDE.md`); no markdown hub. |
| `/steepy-formula:graph-migrate` | Migrate a steepy-apex `.apex/` hub into the graph — extraction, preview, approval, transactional write, cutover, archive closure — or clean up a leftover `.apex/` that holds no hub; either way `.apex/` is removed. |
| `/steepy-formula:discovery` | Populate/refresh stable knowledge from your codebase via a seeded interview — typed candidates promoted into the canonical graph; each proposal is an item card with `file:line` evidence and a write-back preview; re-runnable, additive + diff-gated. After inception, import its decisions once. |
| `/steepy-formula:check` | Run the coherence gate on demand — `steepy-formula graph validate` on the canonical graph — and report any drift. |
| `/steepy-formula:new-surface` | Add one surface through a human-approved promotion (Surface + Check with its `ext_v1_command` test command) plus its specialist agent. |
| `/steepy-formula:brainstorm` | Turn an idea into a local `.formula/work/` spec with graph-resolved routing context; it never mutates the graph — every delta is recorded as a typed deferred proposal for review's sweep. |
| `/steepy-formula:plan` | Break a local spec into a step-by-step local implementation plan. |
| `/steepy-formula:implement` | Implement a spec or plan under rigid TDD. |
| `/steepy-formula:review` | Verify the work against its spec with real evidence: declares the hub mode, runs the coherence gate (`steepy-formula graph validate`), assembles the promotion scenario from swept insights, and gates the apply on a human. |
| `/steepy-formula:loop-engineer` | Run an authorized, bounded autonomous loop over a machine-verifiable goal inside a budget and blast radius, then hand terminal evidence to review. |

Deterministic runners support Claude, Codex, and OpenCode; Pi and DeepSeek report `runner-unavailable`. Gear-3 autopilot supports Linux and macOS. Model selection depends on the host; `check` and `review` are the verification gates on every harness.

## The graph CLI

steepy-formula ships a `steepy-formula` bin with three command families over the canonical graph, plus one top-level declaration command:

| Family | Commands | What it does |
|---|---|---|
| `steepy-formula graph` | `init`, `validate`, `status`, `refresh`, `export`, `backup`, `restore`, `migrate-schema` | Provision the local engine, validate graph invariants + the Revision chain, report project state, refresh repository topology, and manage backup/restore/schema. |
| `steepy-formula context` | `resolve --path <p>... \| --target <id>...` | Resolve deterministic, explainable context (layers, budget, inclusion traces) for task paths or explicit graph targets. |
| `steepy-formula promotion` | `create`, `preview`, `apply`, `discard` | Map a typed candidates file (terms/rules/decisions) into a draft promotion scenario (`create` — nothing is applied), inspect the typed diff, apply it after an explicit human confirmation, or discard it. |
| `steepy-formula hub-mode` | — (top level) | Declare this repo's documentation-hub mode — `graph` (engine reachable + initialized, no `.apex/`), `migrate` (a steepy-apex `.apex/` area is present, with or without a Markdown hub — it wins over `graph`; next: `graph-migrate`), or `none` (next: `init`) — with one evidence line; always exit 0: a declaration for reports and skill prose, which never re-implements the detection. |

Every read command refuses an unsupported schema version (exit 1); `graph migrate-schema` is the explicit recovery path. The full exit-code table prints with the CLI usage — run `steepy-formula` with no arguments to see it.

### The graph engine at a glance

- **One local container per project** — `apex-graph-<project-id>`, pinned ArcadeDB image, every port bound to `127.0.0.1`; host ports are chosen by docker, and the `graph init` output prints the exact engine/Studio URL. The project id resolves through a fixed chain — `--project` flag > `STEEPY_PROJECT` env > the committed `.formula/config.json` binding written by init > the `demo` fallback — so a bound repo needs no flag; re-pointing a bound repo requires an explicit `graph init --force`.
- **Lifecycle** — `graph init` is idempotent (creates, starts, or reuses the server); stop it with `docker stop apex-graph-<project-id>` (there is no CLI stop command).
- **Explore** — ArcadeDB Studio at the `engine:` URL (user `root` + the password from the secret chain), the typed `promotion preview` diff, `context resolve`, or `--port memory --seed <export>` without docker.
- **Save a state** — `graph export --out <file>` writes the SHA-256 integrity-checked export (full graph + revision chain + head + digest); `graph backup` adds the engine-native copy; `graph restore --from <file>` validates and replays the chain (`--force` overwrites a non-empty database after a verified pre-restore backup).
- **Share with a colleague** — the graph lives in your local container, not the repo: hand over the SHA-256 integrity-checked export and have them `graph init` + `graph restore` with the same project id on their machine. Credentials never travel inside the export.

Portable exports use a SHA-256 digest and a hash-chained retained Revision history. Validation detects changes inconsistent with that retained history; it does not authenticate the author or producer. An attacker who rewrites the full history and recomputes every checksum can evade those integrity checks. Keep independently trusted checkpoints when provenance matters.

### MCP server

The package ships an MCP server (`adapters/mcp/formula-mcp.mjs`) over the same domain core. The read tools — `resolve_context`, `get_node`, `trace_rule`, `graph_status`, and `preview_promotion` — are always available; `apply_promotion` registers **only** when the host declares a human-approval capability, otherwise applying a promotion stays CLI-only.

## How it decides ceremony

Before touching code, the generated bootstrap skill classifies every task against the graph's rules: **COVERED** (a rule already decides it), **CONFLICT** (a rule contradicts it — the rule wins unless you explicitly override, and the override updates the graph), or **GAP** (nothing decides it). Every verdict carries `file:line` evidence.

That verdict, crossed with how consequential or irreversible the change is, picks a ceremony **gear** — from gear 1 (straight to the specialist agent, the graph coherence gate at the end) and gear 2 (a light spec implemented directly) up to gear 3 (the full `brainstorm → plan → implement → review` chain — driven manually or on **autopilot**, which runs the post-spec phases unattended and stops before the PR) and gear 4 (a bounded autonomous loop over a machine-verifiable goal, run by a deterministic controller after you ratify the goal contract and grant commit authorization). Low-stakes work stays fast; high-stakes work gets the full chain. You don't pick the ceremony — the classification does.

Along the way, specs and plans are written under `.formula/work/` as a gitignored **local work artifact** — the disposable Work Graph stays separate from stable governance, and durable decisions are promoted into the canonical graph before work is declared done.

Gear-3 autopilot combines context efficiency (fresh role-local manifests, durable artifact-first handoffs) with compact live observability. Safe capture is the default; exact raw capture requires an explicit sensitive-data opt-in. The detailed phase flow, resource ledger, resume behavior, and stop-before-PR boundary are in [docs/workflow.md](docs/workflow.md); the bridge boundary and failure policy are in [docs/architecture.md](docs/architecture.md).

The full model — verdicts, the gear table, the gear-3 chain, and the gear-4 Loop Engineer — lives in [docs/workflow.md](docs/workflow.md).

## Git discipline

steepy-formula never commits or pushes without your say-so:

- **Graph-level policy** — the `/steepy-formula:init` interview can approve a **Git policy** Rule into the graph — a candidate that `APPLIES_TO` every confirmed Surface (for example, "no `git` command without explicit confirmation"); every graph-aware skill resolves the policy with the graph, so it travels with the repo. Declining records no git Rule.
- **`implement` asks once per run** — if you are on `main` it first offers a working branch, then asks whether to commit after each reviewed-clean task. On *yes*, the progress ledger records each task's commit range and reviews read the committed diff; on *no*, no git command runs and you commit the branch yourself at the end.
- **`review` closes the loop** — tests and the graph coherence gate (`steepy-formula graph validate`) are captured once, deterministically: verbatim output stays in the local evidence report while only a compact hashed receipt enters the reviewer context. With reviewed-clean commits on a branch, it offers to open a PR to `main` (and, when the target repo carries its own version-bump machinery, resolves the semver bump first). The push and the PR happen only after you confirm.
- **Gear 4 commits only under authorization** — `/steepy-formula:loop-engineer` refuses to start without a separately granted commit authorization, and its controller never bumps, pushes, or opens a PR.

## Keeping the docs honest

The coherence gate runs at `check`/`review` time on every harness — the plugin wires no end-of-turn gate — and the migration hint reaches you through `steepy-formula hub-mode` and the generated bootstrap at the start of a task: a repository still carrying a steepy-apex `.apex/` area reports `migrate` and is pointed at `/steepy-formula:graph-migrate`.

The canonical gate is the graph: `steepy-formula graph validate` checks the portable invariants and replays the Revision chain to detect writes inconsistent with retained history. Run `/steepy-formula:check` any time you want the gate on demand.

For deeper drift, run `/steepy-formula:discovery` periodically: a seeded interview walks the codebase and proposes updates as item cards with `file:line` evidence and a write-back preview. It's re-runnable — additive and diff-gated, so a second run only surfaces what's new or changed.

## Data and external services

steepy-formula has no server and sends no telemetry: no data reaches steepy-it. Your graph runs in
a local container bound to `127.0.0.1`; specs, plans, and workflow logs stay in your repository
under the gitignored `.formula/work/`; autopilot logs are redacted by default (`log-mode: safe`).
Ordinary agent use can send resolved graph context, prompts, repository content and tool output to your selected harness/model provider. These additional skill operations reach services outside your agent session:

| Skill | Service | What is sent |
|---|---|---|
| `/steepy-formula:init` | Docker Hub, through your local Docker daemon | A pull of the pinned `arcadedata/arcadedb` engine image the first time `graph init` provisions the engine. No project data is sent; the engine then runs locally. |
| `/steepy-formula:brainstorm` in autopilot drive | The harness named in the run contract: Claude Code, Codex, or OpenCode | Phase prompts and repository content go to that harness's model provider, for example OpenAI through Codex. |
| `/steepy-formula:check` | Public model pages from OpenAI and Anthropic, plus `opencode models` when OpenCode is installed | Requests for the current model list, used to verify the model table. No project data is sent. |
| `/steepy-formula:review` | GitHub, through Git and the `gh` CLI | Your branch and a pull request to `main`, only after you confirm. |
| `/steepy-formula:inception` | Official project documentation and package registries, reached through your harness and the approved tools; Git hosting only after your authorization | Research queries and installs. Pushes or repository creation only after you authorize each one. |

`/steepy-formula:loop-engineer` runs its attempts on the harness you are already using. Per-command
effects are in the [Command-family effects matrix](docs/architecture.md#command-family-effects-matrix).
The full [privacy policy](PRIVACY.md) repeats this table and explains how the database password
is resolved locally.

## Trust & safety

Everything runs on your machine. steepy-formula runs Node.js scripts from the plugin package, and the graph engine runs as a local docker container bound to localhost. Core workflows do not require network access to third-party services; the runtime dependency set is a single pinned package (`neo4j-driver`, Apache-2.0) kept behind the engine adapter. The one-time exception is the first `graph init`, which pulls the pinned engine image through your Docker daemon (see [Data and external services](#data-and-external-services)). The database root password is injected through the container environment from the secret-provider chain (OS keychain first, then a local non-committed config file, then environment variables) — never a committed constant and never a `steepy-formula` command-line flag; like any container setting, it stays readable to `docker inspect` on your machine.

What it touches:

- It writes the gitignored `.formula/work/` local work area and a root `CLAUDE.md` into the target repo — graph-first init writes nothing under `.apex/`; its only other local file is the `.formula/init-provenance.json` certificate when it follows a complete inception run (whose own state lives under `.formula/inception/`).
- It writes the **committed** `.formula/config.json` project binding at the repo root — the project id every command resolves when `--project`/`STEEPY_PROJECT` is absent. `graph init` also writes a create-only `.formula/.gitignore` (`*`, `!.gitignore`, `!config.json`) that keeps every other `.formula/` file local; a root `.gitignore` that ignores `.formula/` must do so as `.formula/*` with the `!.formula/config.json` exception (a bare `.formula/` pattern would hide the binding too: Git cannot re-include a file inside an ignored directory).
- It writes Claude Code agent and skill artifacts into the target repo during initialization (`/steepy-formula:init`), along with the managed `AGENTS.md` project instructions and the Codex and OpenCode specialist adapters.
- It provisions a local ArcadeDB container and creates one database per project for the Stable Knowledge Graph.
- Other command families have their own effects: workflow controllers run your tests, Git, and supported harness subprocesses; see the [Command-family effects matrix](docs/architecture.md#command-family-effects-matrix) — filesystem reads–writes–subprocesses–temporary state–providers/network — before granting trust.

The plugin ships no hooks, so there is no hook wiring to review before trusting it.

## Documentation

- [Getting started](docs/getting-started.md) — the end-to-end first-run guide: prerequisites, credentials, the first `/steepy-formula:init`, the engine lifecycle (start/stop/Studio), saving a state, and passing the graph to a colleague.
- [Installation](docs/installation.md) — host setup, requirements, migration, and troubleshooting.
- [Inception](docs/inception.md) — start a project from an idea, before the hub exists.
- [docs/workflow.md](docs/workflow.md) — the ceremony model in full: coverage verdicts, the gear table, model selection, the gear-3 workflow chain with its context efficiency and live observability, the gear-4 Loop Engineer, and why specs/plans stay local.
- [docs/architecture.md](docs/architecture.md) — how the plugin and the Stable Knowledge Graph are built: the domain core, the engine port and adapters, the CLI, the MCP server, the mutation boundary, the backup contract, the audit model, usage reports, and the Command-family effects matrix: filesystem reads–writes–subprocesses–temporary state–providers/network. Start here to contribute.
- [Release checklist](RELEASE.md) — preflight, distribution channels, the live-canary matrix, and rollback.
- [Privacy policy](PRIVACY.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Apache-2.0 license](LICENSE)

<details>
<summary><b>Stack detection scope</b></summary>

The graph, context resolution, and coherence gate are language-agnostic and work in any repo. **Automatic surface detection, however, is specific to the JavaScript ecosystem** (npm / pnpm / yarn workspaces, read from `package.json` and `pnpm-workspace.yaml`). For Python, Go, Rust, or other stacks the package manager is still recognized, but surfaces are not auto-discovered — you declare them during the `/steepy-formula:init` interview and they are scaffolded normally.

</details>

<details>
<summary><b>Coming from steepy-apex</b></summary>

A repository that still carries a steepy-apex `.apex/` area is a one-time migration source: run `/steepy-formula:graph-migrate`, which moves a Markdown hub into the graph (extraction → preview → approval → cutover → archive) or, when the area holds only leftover local state, discards it after your confirmation — either way `.apex/` is removed, since formula keeps its own local areas under `.formula/`. Until then `steepy-formula hub-mode` reports `migrate` and every workflow script refuses to run (exit 25). After cutover the canonical graph is the single authority — there is no second resolver and no Markdown ↔ graph synchronization.

</details>

Made by [Steepy](https://www.steepy.it).
