# Installation

steepy-formula installs natively in five harnesses — [Claude Code](https://docs.claude.com/en/docs/claude-code), [Codex](https://developers.openai.com/codex), [OpenCode](https://opencode.ai), [Pi Coding Agent](https://github.com/badlogic/pi-mono), and DeepSeek Harness (dsh) — from one shared package: a single canonical `skills/` tree plus thin per-harness adapters and manifests. Pick your harness.

GitHub installation requires access to this repository. Install the harness itself first,
keep Node.js >= 24 and Git available on your PATH, and have Docker running for the local graph
engine. Public availability, marketplace approval, and npm publication are separate release
steps; a GitHub tag does not establish a store listing. See the [distribution checklist](../RELEASE.md#public-distribution-checklist).

### Claude Code

**From GitHub:**

```
/plugin marketplace add steepy-it/steepy-formula
/plugin install steepy-formula@steepy-formula
```

**From the Claude community marketplace** (after community review and catalog sync):

```
/plugin marketplace add anthropics/claude-plugins-community
/plugin install steepy-formula@claude-community
```

**From a local checkout** (for development):

```
/plugin marketplace add /path/to/steepy-formula
/plugin install steepy-formula@steepy-formula
```

Then restart Claude Code (or reload plugins) and run `/steepy-formula:init`.

When Claude Code caches the plugin it installs the one npm dependency (`neo4j-driver`) from the
committed lockfile and puts the plugin's `bin/` on the Bash tool's PATH, so the `steepy-formula`
graph CLI works by name. A plugin loaded in place from a local checkout gets no automatic install:
run `npm ci --omit=dev` in that checkout first.

### Codex

**From a local checkout** (for development):

```
codex plugin marketplace add /path/to/steepy-formula
codex plugin add steepy-formula@steepy-formula
```

**From GitHub:**

```
codex plugin marketplace add steepy-it/steepy-formula
codex plugin add steepy-formula@steepy-formula
```

The checkout is itself a marketplace root (`.agents/plugins/marketplace.json` + `.codex-plugin/plugin.json` ship in the repo). Skills are invoked with `$<skill>` or picked automatically; run the `init` skill first.

### OpenCode

**From a local checkout** (for development): keep the complete checkout intact and add its exported plugin module to the `plugin` array of your `opencode.json` using OpenCode's documented file-URL form:

```json
{ "plugin": ["file:///ABSOLUTE/PATH/TO/steepy-formula/adapters/opencode/steepy-formula.js"] }
```

The entry module resolves `skills/` and its shared adapter modules relative to that checkout. Do not copy the entry file by itself into `.opencode/plugins/`; that separates it from the required package payload.

**From a git tag** (replace `vX.Y.Z` with the desired published tag), in `opencode.json`:

```json
{ "plugin": ["steepy-formula@git+https://github.com/steepy-it/steepy-formula.git#vX.Y.Z"] }
```

**From npm** — future release; the package is not published yet.

The adapter registers the canonical `skills/` tree and eleven `steepy-formula-<skill>` commands; skills are also invoked by the agent through the native skill tool. Skills read templates from the checkout, which OpenCode treats as an external directory: interactive sessions get a one-time permission prompt, while non-interactive `opencode run` needs it pre-granted in `opencode.json` (`"permission": { "external_directory": { "/path/to/steepy-formula/**": "allow" } }`).

### Pi

**From a local checkout** (for development):

```
pi install /path/to/steepy-formula
```

**From a git tag** (replace `vX.Y.Z` with the desired published tag):

```
pi install git:github.com/steepy-it/steepy-formula@vX.Y.Z
```

**From npm** — future release; the package is not published yet.

Skills are invoked with `/skill:<name>` (or model-invoked), plus optional `/steepy-<skill>` wrappers registered by the extension.

### DeepSeek Harness

**From a local checkout** (for development):

```
dsh plugin --profile <name> add /path/to/steepy-formula
```

**From a git tag** (replace `vX.Y.Z` with the desired published tag):

```
dsh plugin --profile <name> add git+https://github.com/steepy-it/steepy-formula.git#vX.Y.Z
```

**From npm** — future release; the package is not published yet.

The adapter registers eleven `steepy-formula-<skill>` commands, a model-invocable `steepy_skill` tool, and a marker-guarded bootstrap section in the system prompt. A command's output is rendered to the human and never enters model history, so it can only name the tool call to make — ask the model to call `steepy_skill` directly, or run a `steepy-formula-<skill>` command to see the exact call.

### Requirements

- **A supported harness** — Claude Code, Codex, OpenCode, Pi Coding Agent, or DeepSeek Harness. One canonical skill set serves all five; where a harness lacks a capability (subagent dispatch, per-dispatch model choice), the skills degrade along a declared path — stated in the output, never silent.
- **Node.js >= 24** — the graph CLI (`steepy-formula`) and the scaffolders run on Node. The harness machinery uses Node built-ins only; the graph engine adapter adds exactly one pinned dependency, `neo4j-driver` (Apache-2.0), declared in `package.json`: an npm install resolves it, and a checkout installs it from the committed lockfile with `npm ci`. Node 24 is the supported runtime floor; CI validates Node 24.
- **The `steepy-formula` CLI on PATH** — skills and the generated project instructions call it by
  name. Claude Code provides it through the plugin's `bin/`. On Codex, OpenCode, Pi, and DeepSeek
  Harness, install it once: `npm ci --omit=dev && npm link` inside a checkout, or
  `npm install -g git+https://github.com/steepy-it/steepy-formula.git#vX.Y.Z` for a published tag.
  Both also install `neo4j-driver`; without it the CLI cannot start.
- **Docker** — the Stable Knowledge Graph engine runs locally in a container; `graph init` provisions it (the first run pulls the pinned `arcadedata/arcadedb:26.8.1` image) and binds every port to `127.0.0.1`. The in-memory engine seam (`--port memory`) runs without Docker for development and tests.
- **A database credential** — resolved from the secret-provider chain: the OS keychain first (on macOS, through the `security` CLI; the link is skipped where that CLI is absent), then the owner-only `.formula/secrets.json`, then `STEEPY_FORMULA_*` environment variables. [Getting started](getting-started.md) walks through setting it.

## First run and troubleshooting

Open the repository you want to govern, then run `init`, `discovery` (for an existing
codebase), and `check` using your harness's syntax. Starting from an idea or a prototype,
run `inception` first; see the [inception guide](inception.md).

| Harness | Start from an idea | Initialize | Discover | Check |
|---|---|---|---|---|
| Claude Code | `/steepy-formula:inception` | `/steepy-formula:init` | `/steepy-formula:discovery` | `/steepy-formula:check` |
| Codex | `$inception` | `$init` | `$discovery` | `$check` |
| OpenCode | `/steepy-formula-inception` | `/steepy-formula-init` | `/steepy-formula-discovery` | `/steepy-formula-check` |
| Pi | `/skill:inception` | `/skill:init` | `/skill:discovery` | `/skill:check` |
| DeepSeek Harness | Ask the model to call `steepy_skill` with `skill: "inception"` | Use `skill: "init"` | Use `skill: "discovery"` | Use `skill: "check"` |

In Codex, select the skill belonging to **steepy-formula** if another plugin uses the
same name. Restart the harness after installation if skills are not visible.

For OpenCode, merge the plugin entry into your existing configuration, preserve the
complete package, and approve access to that checkout when prompted. A missing helper
usually means the entry module was copied without its sibling directories.

For DeepSeek Harness, use an existing configured profile. For one-shot verification,
use the shipped `headless` profile: an arbitrary new profile name may have no frontend.

A successful graph-first `init` provisions the local engine, lands the initial graph through one
promotion you confirm, and writes the local `.formula/work/` area, project instructions, the
specialist adapters, the root `CLAUDE.md`, and the committed `.formula/config.json` binding — it
never writes under `.apex/`. `check` should then report a coherent graph
(`steepy-formula graph validate`). A repository carrying a steepy-apex `.apex/` area is routed
to `graph-migrate` instead. See [getting started](getting-started.md) for the engine lifecycle,
[workflow](workflow.md) for subsequent tasks, and [architecture](architecture.md) for command
effects and adapter boundaries. Pi and DeepSeek have no Steepy deterministic runner for
Gear-3 autopilot or Gear-4 loops.

## Upgrading an existing hub

After you update the plugin, run `check` in each repository it governs.

### Local areas move from `.apex/` to `.formula/`

formula keeps its local areas under `.formula/`: the work area `.formula/work/` (specs, plans,
task and loop state), an inception run under `.formula/inception/`, and the init provenance
receipts `.formula/init-provenance.json`. `.apex/` is steepy-apex migration input only, so any
`.apex/` entry — even one that holds only a v1.0.0 work area — puts the repository in the
`migrate` state: `steepy-formula hub-mode` reports `migrate` (it now wins even over an initialized
graph, which v1.0.0 reported as `graph`), and every workflow script refuses with exit 25.

Run `/steepy-formula:graph-migrate`. With a Markdown hub it extracts and cuts over; with only
leftover local state it names what is discarded and removes `.apex/` after your explicit answer.
Before that, copy out anything you want to keep: a spec or plan moved into `.formula/work/specs/`
or `.formula/work/plans/` stays usable, while in-flight run state, an unfinished inception run, and
loop ledgers under `.apex/work/` do not carry over. Re-run `steepy-formula graph init` once to get
the create-only `.formula/.gitignore` that keeps every other `.formula/` file local.

### Project instructions and bootstrap

The generated bootstrap and the `AGENTS.md` navigation now stop on `migrate` and on `none` right
after the hub-mode declaration. A bootstrap or `AGENTS.md` rendered by v1.0.0 is an earlier
rendering, so the planner reports `v1:project-bootstrap:customized` and
`v1:project-instructions:customized` — each is customized until an explicit `replace` resolves it.
Copy out any hand edits first: `replace` rewrites the file to the current rendering.

`check` (`steepy-formula graph validate`) does not inspect generated files, and an `init` re-run
only reports. Preview the portable scaffold planner with your confirmed project model
(`node <engine-root>/scripts/project-scaffold.mjs --hub . --model <model.json>`), set `replace` for
each listed conflict in the model's `resolutions`, then apply the zero-conflict plan with
`--apply`.

### In-flight runs and stored formats

- **An in-flight autopilot run from an earlier version** records no task-result protocol 2, so
  it halts on resume. Finish it manually or start a fresh run.
- **A graph stored under an unsupported schema version** makes every read command refuse with
  exit 1; `steepy-formula graph migrate-schema` is the explicit recovery path.
- **A steepy-apex `.apex/` area** is handled once with `/steepy-formula:graph-migrate`, which
  removes it; `init` never repairs or rewrites it.

The [changelog](../CHANGELOG.md) lists every change by version.

## Upstream references

Installation syntax was cross-checked on 2026-09-16 against
[Claude Code marketplaces](https://code.claude.com/docs/en/discover-plugins),
[Codex plugin packaging](https://developers.openai.com/plugins/build/plugins),
[OpenCode plugins](https://opencode.ai/docs/plugins/), and
[Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).
These references describe host mechanisms; candidate-specific native verification is
tracked separately in [release checks](../RELEASE.md#public-distribution-checklist).
