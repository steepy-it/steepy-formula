# steepy-formula release checklist

Operational checklist for Claude Code community/public distribution, GitHub releases,
and distribution to OpenAI, OpenCode, Pi, and DeepSeek Harness.
Owner: `steepy-it`; repository: `steepy-it/steepy-formula`; plugin: `steepy-formula`.
Community marketplace install path after approval: `steepy-formula@claude-community`.

## Release requirements

1. Validate the final version and package with the commands below.
2. Run the smoke test in a throwaway repository, with Docker running: graph-first init gates on
   the local engine.
3. Refresh the [multi-harness live-canary evidence matrix](#multi-harness-live-canary-evidence-matrix-mandatory)
   for every harness the change can affect.
4. Follow the ordered G1–G4 gates below. A push or merge to `main` is not authorized by this checklist; keep automatic publication gated during preparation.

Detailed references:

- [Publication checklist](docs/publication-readiness.md).

- [Required launch evidence schema, capabilities and provenance](docs/release-evidence.md).

- The inception skill's native acceptance runs are a separate release gate, defined in
  [docs/inception-acceptance.md](docs/inception-acceptance.md).

## Installation

See the [installation guide](docs/installation.md) for all five harnesses, local and
GitHub installation, first-run commands, requirements, and troubleshooting.
The [README quick start](README.md#quick-start) shows the shortest path for each harness.

## Preflight

Run from the repository root after the version bump:

```sh
npm ci
npm test
node scripts/bump-version.mjs --check
npm pack --dry-run --json
node scripts/validate-release-evidence.mjs --product-only
claude plugin validate .
```

With the local engine available, `node scripts/formula/cli.mjs graph validate` must also exit 0
on this repository's own graph; CI cannot run that gate, so it stays a release-time check.

Inside Claude Code, `/plugin validate .` provides plugin validation.
Required publication verification: `node scripts/validate-release-evidence.mjs` reads `docs/native-test-evidence.json` and referenced artifacts
in `docs/native-test-evidence.md`. It checks recorded evidence; it does not run providers
or generate missing evidence. Schema 2 is mandatory before publication remote mutation; only `--legacy-audit` is optional historical verification.

## Smoke test

Use a fresh checkout and install the local marketplace:

```text
/plugin marketplace add /path/to/steepy-formula
/plugin install steepy-formula@steepy-formula
/reload-plugins
```

For direct development loading, use `claude --plugin-dir .` and `/reload-plugins`.
Confirm all eleven commands:

```text
/steepy-formula:inception
/steepy-formula:init
/steepy-formula:graph-migrate
/steepy-formula:new-surface
/steepy-formula:check
/steepy-formula:brainstorm
/steepy-formula:plan
/steepy-formula:implement
/steepy-formula:review
/steepy-formula:discovery
/steepy-formula:loop-engineer
```

### Throwaway repo validation

In an empty temporary repository with a working test command:

```bash
git init
printf '{"scripts":{"test":"node --test"}}\n' > package.json
```

**Precondition — engine before init.** Docker is running and the `steepy-formula` bin
resolves. Init is graph-first: its pre-flight gate provisions and verifies the local
engine before anything is written, and a failed engine gate must scaffold nothing.

Inside Claude Code:

```text
/steepy-formula:init
/steepy-formula:check
```

Expected evidence (graph-first — no markdown hub is ever written):

- `.formula/work/.gitignore` exists.
- `.formula/work/specs/` exists locally and is gitignored.
- `.formula/work/plans/` exists locally and is gitignored.
- No `.apex/` entry exists — init never writes under `.apex/`, and its absence is the
  expected shape: an `.apex/_INDEX.md`, `conventions.md`, `glossary.md`,
  `testing-and-checklist.md`, `standards/`, or any other `.apex/` entry is a failed init.
- No stable specs/plans indexes are generated.
- The managed `AGENTS.md`, the canonical bootstrap at `.agents/skills/<project>-bootstrap/SKILL.md`
  with its thin Claude stub, and the per-surface specialist adapters in `.claude/agents/`,
  `.codex/agents/`, and `.opencode/agents/` exist.
- `CLAUDE.md` exists and carries the graph navigation block — the rendered block
  names the `<project>-bootstrap` skill, `steepy-formula hub-mode`, and
  `steepy-formula context resolve --path <p>... | --target <id>...`, and points at
  the specialist agents in `.claude/agents/`.
- `steepy-formula graph validate` exits green.
- For each confirmed surface whose verification Rule was approved,
  `steepy-formula context resolve --target apex:<project-id>:surface:<name>` exits 0
  and the emitted `context.json` carries that surface's Check with its
  `ext_v1_command` test command. The target id needs no lookup — it is the
  deterministic init convention: the confirmed surface name, lowercased, with
  non-alphanumeric runs collapsed to `-` (the local form `--target surface:<name>`
  resolves too, qualified with the bound project). Do not use `--path` as the
  evidence command here: init's scenario is curated-only and never creates the
  topology→curated `IMPLEMENTS` bridge that path-based resolution rides.
- `/steepy-formula:check` reports green — it runs
  `steepy-formula graph validate`.

### GitHub marketplace smoke test

After publication, repeat using the GitHub marketplace:

```text
/plugin marketplace add steepy-it/steepy-formula
/plugin install steepy-formula@steepy-formula
/reload-plugins
```

Repeat the throwaway repo validation before announcing the release, and repeat the smoke test in
each supported harness.

## Multi-harness live-canary evidence matrix (mandatory)

No release ships until this matrix is filled with real evidence for **all four
harnesses** — Claude Code, Codex, OpenCode, and Pi. The structural halves are CI-locked
(`tests/canary-structural.test.mjs`, `tests/adapters.test.mjs`, `tests/npm-pack.test.mjs`);
the live halves below need an authenticated harness CLI and a human at the wheel.

Canary conditions per harness: isolated `HOME` (`HOME=$(mktemp -d)`), an empty fixture
repo, no pre-existing harness cache or config.

A fifth harness, DeepSeek Harness (dsh), also ships natively but is not a column in the
9-step table below: its live canary is the session-plugin four-check form (load /
commands / tool / bootstrap), so it is recorded in the distinct subsection below instead
of as a fifth column that would sit permanently mostly-empty and turn this mandatory gate
into a standing blocker. No headless/autopilot descriptor is recorded for dsh, and no
headless/autopilot claim is made for it anywhere in this repo.

**AgentIdentity evidence — inherited claim not yet reproduced on formula (apex 2026-08-17 m5a run, harness Claude, apex autopilot implement).** Apex's raw captures showed explicit subagent task events: 3 `system/task_started`, 102 total `system/task_progress`, 1 `system/task_notification`, and 1 `system/task_updated` across that run's phases. The keys that establish agent/subagent identity are `subagent_type` (actor identity), `task_id`, and the notification's completion `status`/`summary`. Formula ports the task-event decoder vocabulary but has not run its own Claude canary, so the Claude agent/subagent identity cell in `docs/workflow.md`'s capability matrix stays `unproven` until a formula-produced run re-observes the events — inherited event evidence, not a flag, and not yet formula's own.

**OpenCode observability evidence — 2026-08-19, port-apex-v08x autopilot run (harness OpenCode, `opencode run --auto --format json`).** This repo's own port-apex-v08x run raw captures (`.apex/work/tasks/2026-08-19-port-apex-v08x/phase-*-attempt-*.raw.jsonl`) recorded the real structured-event vocabulary OpenCode 1.18 emits: `step_start` (455), `tool_use` (530, with `part.tool`, `part.callID`, `part.state.status` completed/error), `step_finish` (453, with `reason` tool-calls/stop and a cumulative `tokens` ledger), and `text` (302). Every event carries a top-level `sessionID`, so the native-session-identity `yes` cell in `docs/workflow.md`'s capability matrix rests on formula-produced event evidence, not a flag; the same `sessionID` is what `opencode session list --format json` lists and what `opencode run --session <session-id>` resumes. The autopilot's OpenCode decoder (`adapters/headless-events.mjs`) now consumes this real vocabulary instead of the invented `session.created`/`message.updated`/`tool.execute.*`/`session.idle` schema the fixtures previously asserted.

**Canary run 2026-07-15 — all four columns green on the flow as it stood then.**
Harness versions: Claude Code 2.1.207, Codex CLI 0.144.0-alpha.4, OpenCode 1.18.1
(local LM Studio `qwen/qwen3.6-35b-a3b`), Pi 0.80.7. Conditions: isolated `HOME` per
harness seeded with that harness's auth file only, toy Node fixture repo,
non-interactive CLI sessions (`claude --print`, `codex exec`, `opencode run`,
`pi --print`).

**Graph-first cells in rows 4–6 — expected shape, not yet evidence.** The 2026-07-15
run predates graph-first init: what it observed in those rows was the then-current
legacy scaffold (markdown hub + validate-hub gate). The graph-first cells below state
the shape a fresh run must observe after the init redesign — by this matrix's own
rule, "it should work" is not evidence, so rows 4–6 stay **unproven** until a fresh
canary run on all four harnesses re-observes them. Every other row's evidence stands
as captured, with one exception: skill-count cells (rows 2–3, and the R3 resolution
below) are swept to the current eleven-skill shape rather than kept as captured, so they
too await re-observation by the next canary run.

| # | Step | Claude Code | Codex | OpenCode | Pi |
|---|------|-------------|-------|----------|----|
| 1 | Install via the native mechanism (local-dev path) | `claude plugin marketplace add <checkout>` + `claude plugin install steepy-formula@steepy-formula` → "Successfully installed … (scope: user)" | `codex plugin marketplace add <checkout>` + `codex plugin add steepy-formula@steepy-formula` → `installed, enabled 0.5.0` (README syntax fixed: `plugin add`, `plugin install` does not exist) | checkout path in `opencode.json` `plugin` array → resolved as `file:///…/steepy-formula`, adapter loaded | `pi install <checkout>` → "Installed"; `pi list` shows the package |
| 2 | Fresh session starts clean | fresh `--print` session answers, no startup errors | fresh `exec` session header + answer, no errors | fresh `run` answers "12 skills" (11 + 1 built-in), 0 error log lines | fresh `--print` session answers, no errors |
| 3 | All eleven skills discoverable | model lists all 11 as `steepy-formula:<skill>` | model lists all 11 as `steepy-formula:<skill>`, sourced from the plugin cache | `opencode debug skill` lists all 11 from `<checkout>/skills/`; `debug config` shows all 11 `steepy-formula-<skill>` commands | session lists all 11 skills + all 11 `/steepy-<skill>` wrappers (bootstrap injection block present) |
| 4 | `init` → interview → scaffold | graph-first scaffold (work area + agents + bootstrap skill + `CLAUDE.md`, no markdown hub) + in-session `graph validate` and `context resolve` green | graph-first scaffold + in-session `graph validate`/`context resolve` green and `npm test` 1 pass | graph-first scaffold + in-session `graph validate`/`context resolve` green — needs `permission.external_directory` allow for the engine root in non-interactive `run` mode (auto-reject observed first, green after grant) | graph-first scaffold + in-session `graph validate`/`context resolve` green |
| 5 | Coherence gate exits 0 in the fixture (`steepy-formula graph validate`) | `graph validate` clean, exit 0 (engine root = plugin cache) | `graph validate` clean, exit 0 (engine root = plugin cache) | `graph validate` clean, exit 0 (engine root = checkout) | `graph validate` clean, exit 0 (engine root = checkout) |
| 6 | `check` runs successfully | mode declared `graph` + `steepy-formula graph validate` green, exit 0 | mode declared `graph` + `graph validate` green, exit 0 | via `steepy-formula-check` command: mode declared `graph` + `graph validate` green, exit 0 | via `/skill:check`: mode declared `graph` + `graph validate` green (`/steepy-<skill>` wrappers are TUI-only ergonomics — no-op in `--print` mode) |
| 7 | One `brainstorm → plan → implement → review` chain on a toy change | PASS — spec/plan/ledger written, tests 2/2, review approved, local commit on a work branch | PASS — spec/plan/ledger written, tests 2/2, review PASS, gate OK | PASS — run as the four `steepy-formula-*` commands over one continued session (local 35B model): spec/plan/ledger written, tests 2/2, review PASS | PASS — full chain in one session: spec/plan/ledger written, tests 2/2, review APPROVED |
| 8 | Orchestration native, or degradation declared in output (inline specialist, session model) | native: dispatched `src-agent` subagent on haiku (tier from the plan's Complexity) | degradation declared in output: generic subagent prompted with the agent contract, session model (no per-dispatch tier) | degradation declared in output: inline specialist, session model | degradation declared in output: inline specialist, session model |
| 9 | Zero Claude dependency: no `CLAUDE_*` env needed, no reads from `~/.claude` | n/a | `env -i` (no `CLAUDE_*`, isolated HOME) check run green | `env -i` check run green | `env -i` `/skill:check` run green |

Fill each cell with evidence (command + output excerpt, or a transcript link). "It
should work" is not evidence.

### DeepSeek Harness (dsh) canary

dsh is a fifth native harness whose live canary is not the 9-step form above; its canary
is this distinct four-check form instead, covering native in-session wiring only. No
headless/autopilot descriptor is recorded for dsh, and no headless/autopilot claim is
made for it anywhere in this repo.

Canary conditions: isolated `HOME` (`HOME=$(mktemp -d)`), an empty fixture repo, no
pre-existing `dsh` profile or cache — same discipline as the conditions above.

**Canary status — PENDING: dsh install canary pending a real dsh host — hermetic
packaging checks only.** Neither `dsh` nor `cordis` is installed on this host, so the
documented install command was attempted once from this checkout and captured verbatim
(2026-08-31):

```text
$ dsh plugin --profile headless add /path/to/steepy-formula
zsh: command not found: dsh
(exit 127)
```

The four checks below have therefore never been run against a real dsh host on formula.
The inherited apex provenance (a passing 2026-08-22 run of this adapter's original at
steepy-apex v0.9.3, dsh CLI `0.1.1-rc.1`) is design provenance only, not formula's own
evidence. What IS verified hermetically: the plugin module loads and registers every
capability against a stub host (`tests/adapters.test.mjs`), and the tarball carries the
adapter plus `cordis.patch.yml` (`tests/npm-pack.test.mjs`). A green `npm test` is not
evidence about dsh itself.

| # | Check | Verdict |
|---|-------|---------|
| 1 | Load — `dsh plugin --profile <name> add <checkout>` installs the adapter and the profile boots with no error (the adapter declares no top-level `inject`, so its own fiber always loads). | PENDING — no dsh host. |
| 2 | Commands — all eleven `steepy-formula-<skill>` commands are discoverable in the session. | PENDING — no dsh host. |
| 3 | Tool — the `steepy_skill` tool is registered and returns a named skill's exact `SKILL.md` prose when called. | PENDING — no dsh host. |
| 4 | Bootstrap — the marker-guarded `steepy-formula` `systemPrompt` section is present in the assembled prompt. | PENDING — no dsh host. |

Fill each cell with evidence (command + output excerpt, or a transcript link) — same
rule as above: "it should work" is not evidence.

#### dsh canary — drift triggers and how to re-verify

The four checks above are a live canary against one pinned dsh install. Nothing re-runs
them automatically. `tests/adapters.test.mjs` drives the adapter with a fake context that
implements the host contract *as this repo understands it*, so the hermetic suite stays
green by construction when the real host changes underneath it — a green `npm test` is not
evidence about dsh. Re-running this canary by hand is the only drift check that exists.

Re-run it when any of these changes:

- a new `dsh` CLI release, or any `@deepseek-ai/dsh-*` package version change;
- a `@deepseek-ai/cordis`, `cordis-plugin-loader`, or `cordis-plugin-include` version change;
- a change here to `adapters/dsh/steepy-formula.js`'s gating or registration shapes, the root
  `cordis.patch.yml`, or `package.json`'s `dsh` key / `exports` map / `files` allowlist.

**What can break, and which check catches it.** Every row below is an assumption pinned
live by a real run (fill the date when the first formula run happens; until then the
inherited apex 2026-08-22 run is the design's only provenance). The adapter is fail-open
by design, so host drift *silently un-registers* a capability instead of raising: "no
error" is never evidence here.

| # | Assumption | Drift symptom | Caught by |
|---|---|---|---|
| A1 | `cordis.patch.yml`'s `name: steepy-formula/adapters/dsh` is a package specifier resolved through this package's `exports` subpath | the row composes but the module never loads (`ERR_MODULE_NOT_FOUND`); `--dump-config` still prints it | check 1 — via `assertEntriesActivated()` only, never via `--dump-config` |
| A2 | `dsh plugin add` reads `package.json`'s `dsh.bundle.patch` and appends the bundle to the profile's `dsh.profile.bundles` | install writes no bundle row; the adapter is simply absent | check 1 |
| A3 | `ctx.inject([service], cb)` parks an unmet dependency on a child fiber and hands the service to `cb` as a direct property | the callback never runs, or `scoped.<service>` is undefined → that one capability registers nothing, silently and forever | checks 2 / 3 / 4 (one per capability) |
| A4 | the service names are `tools`, `commands`, `systemPrompt` | a renamed or namespaced service leaves its gate pending forever — at runtime indistinguishable from "not loaded yet" | checks 2 / 3 / 4 |
| A5 | `ctx.tools.register` accepts a plain object literal (no `defineTool` brand check) | `register()` throws, the adapter swallows it, the tool is absent | check 3 |
| A6 | `ctx.commands.register({name, description, input, handler})` with a `{kind, text}` handler result | registration throws per name; the eleven commands vanish | check 2 |
| A7 | `ctx.systemPrompt.section({name, order, text})`, tool-guidance band 100-199 | section rejected → no bootstrap block; or dsh moves its own sections and order `120` ties/lands wrong → block present, wrong position | check 4 |
| A8 | the plugin module shape is named `name` + `apply(ctx)` exports, normalized by the loader as `exports.default ?? exports` | the module loads as nothing | check 1 |
| A9 | F3 — a command's output is rendered to the human and never enters model history | the bootstrap block's F3 prose and the commands' invocation notice become false (truth-in-docs drift, not a functional break) | no check — re-read `dsh-commands`' compiled `execute()` body and its doc comment |
| A10 | `boot()` calls `assertEntriesActivated()` before returning | a `PENDING` row no longer aborts boot, so "boot succeeded" stops proving ACTIVE and check 1's method loses its teeth | verify the instrument itself **first**, before trusting check 1 |

**How to re-run.** Same conditions as the original run: isolated `HOME`, no pre-existing
`dsh` profile or cache. Set `HOME` inline on every command — never rely on an exported
`HOME` surviving between commands, or a stray invocation will initialize a profile under
the real home directory.

1. **Verify the instrument (A10).** Confirm `assertEntriesActivated()` still runs
   unconditionally at the end of `boot()` in `@deepseek-ai/dsh-app-boot`, and still throws
   a per-entry diagnostic for any enabled loader entry that is not `FIBER_ACTIVE`. If that
   audit is gone, check 1 has to be re-designed before the rest of the run means anything.
2. **Install (A1, A2, A8).** `HOME=<tmp-home> <dsh-bin> plugin --profile <name> add <checkout>`.
   Use `headless` as `<name>`: dsh's own shipped template composes a one-shot runner, whereas
   an unrecognized profile name composes no frontend at all and every invocation against it
   hangs forever with no return value.
3. **Check 1 — load.** With no `DEEPSEEK_API_KEY` in the environment, run one one-shot task:
   `HOME=<tmp-home> <dsh-bin> --profile <name> "reply with the word: ping" < /dev/null`.
   Reaching `MISSING_CREDENTIAL` cleanly is the pass — it means the whole tree, this adapter
   included, was already ACTIVE before the LLM call was attempted. `ERR_MODULE_NOT_FOUND`,
   or an activation diagnostic naming `steepy-formula`, is the A1/A2/A8 failure. Do **not**
   accept `--dump-config` showing the row as evidence: it prints composition, not activation,
   and it prints identically when the module never loaded.
4. **Checks 2 and 4, and the direct half of 3 — registries.** dsh's packaged CLI still has no
   subcommand that lists registered commands or tools, or dumps the assembled prompt. Drive
   `@deepseek-ai/dsh-app-boot`'s **public** `boot()` against the profile installed in step 2,
   then read `ctx.commands.list(undefined)` (expect exactly the eleven `steepy-formula-<skill>`
   descriptors), `ctx.tools.get('steepy_skill', undefined)` plus a direct
   `execute({skill:'check'})` (expect the framing line, a blank line, then the exact bytes of
   `skills/check/SKILL.md`), and `ctx.systemPrompt.assemble({})` rendered through
   `renderPrompt()` (expect the marker exactly once). Dispose the fiber afterwards. Import
   only public exports — a private or hashed internal file is not a contract and its drift
   tells you nothing.
5. **Check 3, model-mediated leg.** One authenticated one-shot session instructed to call
   `steepy_skill` and quote the result back. This is the only leg that proves the tool is
   *model-visible*, not merely registered. Read the key once, never echo it, and grep every
   captured output for a key-shaped substring before quoting it anywhere.

Record the result the same way as the table above — new dated run block, versions pinned,
method and its strength named per check. A re-run that only re-confirms the old versions is
not a re-run.

**Model-mapping freshness canary — how to run.** Run
`node <engine-root>/scripts/verify-model-mappings.mjs` from the installed copy's engine
root (it shells out to `opencode models` and fetches the cited provenance pages — live
network use, a canary act, never a unit test). It re-checks every provider/tier row in
`adapters/model-mappings.mjs` against the live evidence its provenance cites and prints
a per-row verdict with the observed evidence line. `OK` — the live source confirms the
configured id. `STALE` — drift: a human-ratified patch must land before release; the
script prints the prepared patch, never applies it, and exits 1. `UNKNOWN` — source
unreachable (offline degradation): informational, never a release blocker.

**D2 tier-dispatch canary — placeholder dated 2026-08-20, filled 2026-08-20 by Task 7 of the
2026-08-20 OpenCode D2 tier-dispatch work (inherited apex evidence, not yet reproduced on
formula — OpenCode 1.18.19, vendored engine refreshed from apex's committed state
`6228f65`).** Live `opencode models` catalog observed the zai rows
`zai-coding-plan/glm-5.2`, `zai-coding-plan/glm-5.2-highspeed`, `zai-coding-plan/glm-5.3`
(alongside `glm-4.7` and `glm-5-turbo`); `verify-model-mappings --harness opencode` returned
6 OK / 0 STALE (exit 0; the account-absent anthropic/openai rows degrade to informational
UNKNOWN). With the session `model` pinned to `zai-coding-plan/glm-5.3` (project `opencode.json`
in a temp fixture), `opencode debug config` listed the registered tier trio + hub agents with
concrete models: `steepy-cheap` → `zai-coding-plan/glm-5.2-highspeed`, `steepy-standard` →
`zai-coding-plan/glm-5.2`, `steepy-most-capable` → `zai-coding-plan/glm-5.3`, and the fixture
hub agent (frontmatter `model: sonnet`) → `zai-coding-plan/glm-5.2`. The dispatch: a task tool
call with `subagent_type: "steepy-standard"` and prompt "Reply with exactly: steepy-standard
canary ok"; the child session (`opencode export`, title "Canary test steepy-standard
(@steepy-standard subagent)") records the assistant message as `agent=steepy-standard
model=zai-coding-plan/glm-5.2` replying exactly `steepy-standard canary ok` — the
standard-tier concrete model, direct session evidence, not a flag. Quirk observed: `opencode
run --agent steepy-standard` warns "agent … is a subagent, not a primary agent. Falling back
to default agent" and serves on the session model — the headless dispatch path is the task
tool from a session, and per-message `agent`/`modelID` in session JSON is the model
observability.

**Current tier-trio state — 2026-09-01 note (doc-and-reality).** The dated 2026-08-20
canary above records the trio as it was observed then; the tables have since moved.
The human-ratified 2026-08-27 ladder (`adapters/model-mappings.mjs`, the live source of
truth) is the full 5.3 generation — `steepy-cheap` → `zai-coding-plan/glm-5.3-flash`,
`steepy-standard` → `zai-coding-plan/glm-5.3-highspeed`, `steepy-most-capable` →
`zai-coding-plan/glm-5.3` — with the whole 5.2 generation off the ladder. The 2026-08-20
dispatch evidence stands as history; a fresh D2 canary must re-observe the registered
trio on the 5.3 ladder before any cell above is refreshed.

**Verification rows (unknowns ratified with fallbacks — resolve them here):**

- **R2 — Codex namespacing & agents.** Verify plugin-skill namespacing (`$<skill>`
  collision behavior across plugins) and whether plugin-defined agents work. Fallback
  if not: `.agents/skills` repo/user-scope discovery + the declared inline-specialist
  degradation.
  **Resolved 2026-07-15:** skills surface plugin-prefixed as `steepy-formula:<skill>` —
  collision-safe by construction. Plugin-defined agents are not part of the Codex
  plugin surface; the declared inline-specialist degradation engaged and was stated
  verbatim in the chain output (generic subagent prompted with the agent contract,
  session model). Fallback not needed for discovery.
- **R3 — OpenCode frontmatter tolerance.** Verify OpenCode tolerates the Claude-only
  frontmatter extras (`user-invocable`, `argument-hint`) in the shared SKILL.md files.
  Fallback if rejected: restrict core frontmatter to the open subset (`name`,
  `description`) and move Claude extras to packaging.
  **Resolved 2026-07-15:** tolerated — every SKILL.md file parsed and listed by
  `opencode debug skill` with zero warnings on stderr. Fallback not needed.
- **D4 — end-of-turn gate approximation.** No harness ships an end-of-turn hook: the
  plugin ships no hooks, and on every harness the coherence gate
  (`steepy-formula graph validate`) runs at `check`/`review` time. The OpenCode, Pi, and
  DeepSeek Harness bootstrap blocks state the same, and matrix rows 5–6 are where the live canary
  verifies the gate.
  **Resolved 2026-07-15 (dated evidence, on the flow as it stood then):** on Claude Code
  the then-shipped native Stop hook worked end-to-end — on a deliberately broken hub a
  trivial turn was blocked and the model fixed the dangling link before being allowed to
  end; single fire, no double-load. On Codex the plugin hooks feature had been **removed
  from the harness** (`codex features list` → `plugin_hooks removed`), so the Codex gate
  already ran at `check`/`review` time only — the same declared fallback as OpenCode/Pi,
  verified green on all three. The hook wiring has since been removed from the package.

**Harness quirks observed during the 2026-07-15 run** (headless automation, not
package defects): `codex exec` blocks forever on an open stdin pipe (`< /dev/null`
required in scripts); `pi --print` dies silently on an open stdin pipe (same fix);
`opencode run` intermittently hangs at startup before the model call (retry works;
per-skill `--command` runs proved reliable); Pi's `/steepy-<skill>` wrappers are
interactive-TUI ergonomics and no-op in `--print` mode (use `/skill:<name>` there).

**OpenCode install scope:** in this phase the tested path is the local
tarball/worktree install; the public npm install is documented as future and stays
untested until a published release exists.

**Known limitation, not a canary failure:** graph-first `init` writes the harness-neutral
canonical bootstrap (`.agents/skills/<project>-bootstrap/SKILL.md`, with a thin Claude stub), but
`graph-migrate` still writes the Claude-only `.claude/skills/<project>-bootstrap/SKILL.md` from
`templates/bootstrap-skill-graph.md`, which emits Claude-namespaced `/steepy-formula:<skill>`
invocations and is not discoverable on Codex or Pi. Matrix step 4 judges the scaffold itself, not
bootstrap discovery outside Claude Code.

## Versioning & release

Version bumps and tags are automated — there is no manual tag-and-publish step. New release tags
and releases are created by the workflow after validation; existing tags and draft releases
require explicit reconciliation before publication.

**Semver policy.** PATCH = bugfix, MINOR = new feature, MAJOR = breaking change.
The shared `scripts/version-policy.mjs` implements the narrower canonical X.Y.Z policy:
three non-negative safe-integer components, no leading zeroes, prerelease or build suffixes.
Precedence is numeric, so `1.2.10` exceeds `1.2.9`; required bumps reject equality and
downgrades. A caller's `no-release` exemption waives the increment, never version validity
or downgrade protection.

**Bump at PR time.** The `review` skill proposes the bump type from the change (fix →
patch, feature → minor, breaking → major), the user confirms, then `node
scripts/bump-version.mjs <type>` updates `package.json`, `.claude-plugin/plugin.json`,
and `.codex-plugin/plugin.json` in three-way lockstep at completion, using one shared target.
A `## vX.Y.Z (YYYY-MM-DD)` section is added to `CHANGELOG.md`. Bump and
changelog land as one commit on the branch before the PR opens.

**Interrupted bumps.** The writer provides recoverable per-file atomicity, not a
multi-file atomic transaction. It holds the existing repository scaffold lease for cooperating
writers, validates all initial versions, and durably records exact before/after bytes and modes
in `.steepy-version-transaction.json` before staging the complete target set. Each manifest
is then published through an ordinary atomic rename and its directory is synced. Unrelated
formatting bytes and modes are preserved; unexpected bytes or mode edits block without overwrite.
Symlinked inner parents and non-ordinary or multi-link files are refused. This is not an
adversarial filesystem guarantee and requires working file/directory fsync and rename support.

While the journal exists, rerun the original command or its explicit recorded version to
finish the same target. Do not delete/edit the journal, reset the checkout, or select a different
bump kind to recover. Owned partial stages are accepted only as exact target-byte prefixes;
unexpected stage edits are retained and block. An explicit already-completed target is a
manifest-write-free no-op; a new patch/minor/major command after completion requests a new bump.
Run `node scripts/bump-version.mjs --check` before release validation: any remaining transaction
is incomplete even when all three version fields already match. A process crash before the
journal's atomic publication can leave an unreferenced temporary journal, but cannot publish
any manifest; it is not mistaken for a pending target or automatically removed as user data.

**PR gate.** The `Version gate` workflow (`.github/workflows/version-gate.yml`) uses the
shared numeric `scripts/version-policy.mjs` comparison. It fails invalid, equal, or
downgraded PR versions. A PR with no user-facing change (docs-only, CI-only) can carry the
`no-release` label, which skips only the increment requirement; canonical parsing and
downgrade rejection still apply.

**Candidate-bound publication at merge.** The `Release` workflow (`.github/workflows/release.yml`) runs on every
push to main, but can publish only after tests, version and package validation succeed
(the graph coherence gate needs a local engine, so it stays a release-time preflight).
If tag `vX.Y.Z` for the current version doesn't exist yet, it creates and pushes it. It then
creates the matching nondraft GitHub Release only after schema-2 evidence and candidate checks, with the body pulled from the matching
`CHANGELOG.md` section via `scripts/extract-changelog.mjs` (falls back to a stock
body if extraction fails). Last, it appends one Claude directory payload commit for a new
version to the `claude-directory` branch (see
[Claude directory submission](#claude-directory-submission)). The coordinator serializes runs, checks exact source/tag/release identity and remote main before each stage, and reobserves uncertain outcomes on retry. Existing directory versions are accepted only for an identical payload/source identity; mismatches fail closed.

**Direct pushes to main.** A repo-local PreToolUse hook (`.claude/settings.json` →
`scripts/push-version-guard.mjs`) blocks a `git push` on main for a known invalid version,
an unchanged version, or a numeric downgrade relative to `origin/main`, and asks whether to
bump patch/minor/major (default patch). Unrelated commands, other checked-out branches and
unavailable read/parse/Git context remain fail-open; known malformed version values do not.

**Tag naming.** `vX.Y.Z` (e.g. `v0.2.0`), matching the current plugin version.

**Two PRs in flight.** If two PRs both bump to the same version, the `Version gate`
passes on both until the first one merges; the second then fails the gate against the
new main version and must re-bump before it can merge.

## Claude directory submission

The Claude plugin directory scans the whole plugin folder of the submitted branch, so submit
the payload branch `claude-directory`, never `main`. The Release workflow appends one commit
per new version, built by `scripts/publish-directory-branch.mjs` from the release commit minus
`tests/`, `.github/`, `.codex-plugin/` and `CLAUDE.md`. The branch is append-only and never
force-pushed. The script copies the release commit's subject through `git log`, so on any host
that runs it, leave `i18n.logOutputEncoding` and `i18n.commitEncoding` unset or set to UTF-8.

Before submitting, run:

```bash
npm ci
npm test
claude plugin validate .
```

Submit through the developer portal:

1. Open `claude.ai/directory/manage` → **Submit new** → **Plugin bundle**.
2. Choose repository `steepy-it/steepy-formula` and branch `claude-directory`.
3. Press **Validate**, then **Submit for review**.

The listing icon is fixed at the first save or submit. Later versions reach the directory
through **Check for new commits** or the push webhook.

The Listing tab is read once, from the version the submission was created at. Later versions
update only the display name and short description. Links (`homepage`, `documentationUrl`,
`supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`) and `keywords` must already be in
`.claude-plugin/plugin.json` when you create the submission.

## Public distribution checklist

Channel guidance checked on 2026-09-16 (inherited from steepy-apex v1.2.0). Recheck the linked
provider instructions before submission. The GitHub workflow creates tags and GitHub Releases and appends the Claude
directory payload commit to `claude-directory`; it still does not publish to npm or submit to
any plugin directory. Store approval is separate from technical validation.

### Shared release preparation

- [ ] Finish the documentation before testing the final payload.
- [ ] Review Git history and tracked release contents before publishing to a new channel.
- [ ] Configure main-branch protection/rulesets with the actual CI and version-gate check names.
- [ ] Run preflight above on the exact candidate. The supported CI runtime is Node 24 on Linux;
  native installation on macOS and Linux requires its four launch rows; Windows is unsupported.
- [ ] Refresh the live-canary matrix above for the harnesses the change affects. Schema-2 native evidence is required for publication; optional schema-1 historical audit is separate.
- [ ] Prepare listing copy, logo, support contact, starter prompts, and a short demo. Use
  [installation and support copy](docs/installation.md)
  as the starting point. Keep advanced runner limitations and the Docker requirement visible.
- [ ] Merge the reviewed candidate, wait for Release validation/publication, and confirm the tag
  resolves to the intended commit. Existing tags are not moved by the workflow.
- [ ] Repeat the documented public installation and replace future/placeholder installation copy
  only after that channel is actually available.

### Claude Code

1. Validate with `claude plugin validate .` and run the local marketplace smoke test above.
2. After the repository is public, test its own marketplace install from GitHub. This distribution
   path is independent of review by Anthropic.
3. Submit through the developer portal as described in
   [Claude directory submission](#claude-directory-submission), on branch `claude-directory`;
   record submission status.
4. After approval and catalog sync, test `steepy-formula@claude-community` before advertising it.
   The official curated marketplace is a separate channel; submission does not guarantee inclusion.

Source: [Claude marketplace discovery and submission](https://code.claude.com/docs/en/discover-plugins).

### OpenAI / Codex

The current OpenAI documentation describes a shared public plugin directory for ChatGPT and
Codex. A local/GitHub marketplace install is a development or workspace distribution path,
not public-directory approval. Steepy requires repository files, shell execution, Git,
Node 24, and Docker for the graph engine; do not advertise ordinary Chat compatibility without
verifying those capabilities.

1. Verify the publisher identity and the submitter's **Apps Management: Write** permission.
2. Prepare public website, support, privacy-policy and terms URLs, logo, descriptions, release
   notes, country availability, starter prompts, five positive and three negative test cases.
3. Choose **Skills only** in the submission portal. Package all required skills, scripts,
   templates, adapters, and assets; do not assume the portal executes npm installation.
4. The documented Claude archive import can convert `.claude-plugin/plugin.json`; alternatively
   use the supported OpenAI package layout. Inspect the imported manifest and test every referenced
   helper path in a clean environment. Recheck trust and host compatibility.
5. Resolve scan findings, test the imported candidate, submit for review, then complete the portal's
   publication step after approval. Re-test the installed directory version.

Sources: [OpenAI submission](https://developers.openai.com/plugins/deploy/submission),
[Claude plugin import](https://developers.openai.com/plugins/guides/submit-claude-plugin),
[local and public plugin distribution](https://learn.chatgpt.com/docs/build-plugins).

### npm, OpenCode, and Pi

1. Verify npm package-name availability and publisher ownership; configure the account's publishing
   authentication. Choose the final version before publication, which cannot be overwritten.
2. Review `npm pack --dry-run --json`, then test an actual tarball installed outside this checkout.
   Check that every relative skill/helper reference is present and that the pinned
   `neo4j-driver` dependency installs with the package. Add `pi-package` to the package
   keywords before publishing if Pi gallery discovery is desired; optionally add a demo image/video.
3. Publish the reviewed package with `npm publish --access public` using the authorized publisher.
   The existing GitHub workflow does not perform this step.
4. For OpenCode, test the published package in `opencode.json`'s `plugin` array, including skill
   discovery and scaffold/check. For Pi, test `pi install npm:steepy-formula` and the documented
   new/fork/resume/reload bootstrap transitions.
5. Verify the npm listing and Pi gallery entry, then update README instructions with the real
   published version. A Git-based Pi install remains an alternative to npm.

Sources: [OpenCode npm plugins](https://opencode.ai/docs/plugins/),
[Pi packages and gallery metadata](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md).

### DeepSeek Harness

Use the native Git or package installation route in the [installation guide](docs/installation.md#deepseek-harness) and verify skill discovery, graph-first initialization,
and the coherence check in the native host. A separate public
store submission route has not been established by this release audit. Do not promise a
store listing or deterministic Gear-3/4 support for this adapter.

## Rollback

If a release has an install or runtime problem:

1. Stop announcing the affected tag.
2. Open a GitHub issue with the failing command and observed output.
3. Revert the faulty commit or prepare a patch fix.
4. Ship the fix as a new PATCH release through the normal flow (see "Versioning &
   release" above): bump `patch` at PR time, merge — the `Release` workflow tags and
   publishes it automatically.
5. Re-run the local and GitHub marketplace smoke tests before updating release notes.


## Current launch acceptance status

Supported launch scope is Claude Code and Codex on macOS and Linux with Node 24. Windows is unsupported. OpenCode, Pi and DeepSeek Harness remain packed experimental integrations. Dated tables above are historical evidence of their named versions and original flow, never schema-2 launch proof. The [four-combination matrix](docs/inception-acceptance.md#four-combination-launch-matrix) and [schema-2 inventory](docs/release-evidence.md) require every case on every host/OS. Candidate preflight and all four host rows remain NOT RUN until observed; no native acceptance or public channel availability is claimed here.

Default `node scripts/validate-release-evidence.mjs` requires current candidate-bound schema 2 before tag, GitHub Release or directory push. Product-only CI checks do not replace it. The coordinator rechecks source/payload, evidence, remote main and existing identities before remote stages. Recovery after an uncertain remote result must reobserve its identity before retrying; never move an existing tag or overwrite conflicting release/directory state. Optional `--legacy-audit` validates schema-1 history only. Preserve prerelease evidence files until actual native acceptance produces reviewed observations; never generate PASS from hermetic fixtures, nonce canaries or these instructions.

## Ordered maintainer launch gates

The [bounded publication audit](docs/release-audit-remediation.md) records observed state and unresolved launch gates. These gates govern the initial public launch and take precedence over general channel instructions above. The baseline v1.0.0 retarget is closed; no general retarget authorization exists.

These are ordered maintainer execution gates, not automatically authorized remote tasks. Implementation completion and public-release completion are distinct. Each named gate remains open until its required observations pass. Do not mark the whole release objective complete while any mandatory observation is missing.

**G1 — Freeze candidate and record real acceptance.** After code review, select/approve the exact candidate commit and version; obtain explicit authorization for any needed commit. Run the full `npm test` suite and the mandatory integration and native acceptance below on Node 24 macOS and Linux. Follow the durable [inception acceptance procedure](docs/inception-acceptance.md) and [release evidence contract](docs/release-evidence.md). Use `node --test tests/formula-arcadedb.test.mjs tests/formula-bakeoff-veto.test.mjs` with functioning Docker, plus `node scripts/formula/cli.mjs graph validate`; require no skipped mandatory integration tests and violations 0/clean replay. Run `node scripts/bump-version.mjs --check`, `node scripts/validate-release-evidence.mjs --product-only`, actual npm pack/clean install and `claude plugin validate .`. Run real packaged Claude Code/Codex on both OSes: clean install/load, eleven-skill discovery/invocation, init/generated bootstrap/specialists, discovery/context/coherence and the full brainstorm→plan→implement→review chain. Execute inception A/B and every distinct recovery/verification scenario in [docs/inception-acceptance.md](docs/inception-acceptance.md) through the real skill, retaining actual human responses and declared host degradation. Record architecture, harness versions, exact candidate, observations and redacted provenance in `docs/native-test-evidence.md` and schema-2 `docs/native-test-evidence.json`, with digests; human review of provenance is mandatory. Missing credentials/Docker/host access is NOT RUN, never PASS. Exact evidence/audit-only follow-up commits limited to `docs/native-test-evidence.md`, `docs/native-test-evidence.json`, and `docs/release-audit-remediation.md` may retain source payload identity; every other shipped byte/mode/path change repeats affected acceptance against a newly frozen candidate, and all mandatory evidence must match it. Run `node scripts/validate-release-evidence.mjs` to validate the complete candidate-bound schema-2 release contract. Never ship synthetic fixtures as acceptance.

**G2 — Close publication/history prerequisites.** Complete the bounded candidate/reachable-history, historical tracked work, remote PR/ref/content, release asset and accessible Actions log/artifact audit defined in [docs/release-audit-remediation.md](docs/release-audit-remediation.md). Close every unresolved scope and finding through human provenance/license/security review and any necessary secret rotation/remediation. Verify the main protection/private reporting/contact configuration or the explicitly approved, capability-justified [visibility-transition procedure](docs/publication-readiness.md#protection-transition-procedure-requiring-later-authorization). Inaccessible surfaces remain explicit blockers. Settings edits and any remediation that changes Git state require separate authorization. Preserve history; any later destructive work requires its separately reviewed plan and verified private backup.

**G3 — Reconcile and publish exact identity.** After G1/G2 and explicit maintainer approval of concrete candidate/actions, reconcile the pre-public v1.0.0 tag/release/directory payload to the candidate. The baseline retarget is already closed. Present exact old/new peeled tag commits and directory identities; no general force/retarget policy, silent bump or force-pushed directory. Use explicit corrective append for divergent same-version pre-public directory history; if already public, changed product bytes require a new approved version. Observe current main eligibility and evidence at each action. Verify remote peeled tag equals approved candidate, nondraft release tag binding, and filtered Claude directory path/mode/byte payload identity after reconciliation. Same-candidate exact retries are no-ops; matching tag without release is recoverable. Recheck after interrupted actions before retry. Automatic main publication must remain gated throughout preparation; a successful workflow alone does not certify remote identity.

**G4 — Verify public availability.** Only after explicitly authorized visibility/publication, verify anonymous repository/docs/release access and clean installation from the actual public source for each supported harness/OS combination, preserving redacted observations. Apply and verify any visibility-transition protection before announcement. Local tarballs do not prove anonymous availability. Do not submit to npm/marketplaces or advertise their availability without separate authorization and observed successful publication. Update only `docs/native-test-evidence.md`, `docs/native-test-evidence.json`, and `docs/release-audit-remediation.md`; other shipped edits invalidate prior product identity and return to G1.
