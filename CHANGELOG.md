# Changelog

## Unreleased

**Breaking:** steepy-formula is graph-only. The canonical Stable Knowledge Graph is the single
stable-knowledge channel; the `legacy` Markdown hub mode is gone, and `.apex/` is steepy-apex
migration input only.

- formula's local areas move from `.apex/` to `.formula/`: the work area is `.formula/work/`
  (specs, plans, task and loop state), an inception run lives under `.formula/inception/`, and the
  init provenance receipts are `.formula/init-provenance.json` and
  `.formula/init-provenance.pending.json`, kept local. Work artifacts, inception runs and loop
  ledgers left under `.apex/work/` and `.apex/inception/` are not read: `--validate-terminal`,
  resume and the discovery inception source take the `.formula/` paths only.
- Any `.apex/` entry — a steepy-apex Markdown hub (`.apex/_INDEX.md`), an old work area, an
  inception run or receipts, even a dangling link — is now the `migrate` state, and it wins even
  over a reachable, initialized engine (v1.0.0 reported `graph` there):
  `steepy-formula hub-mode` reports `migrate`, its evidence line reads `.apex/: absent`, `present (Markdown hub)` or
  `present (no Markdown hub)`, and it names `graph-migrate` as the next step. Every workflow
  entry point refuses with exit 25 and one message naming `graph-migrate` before any stdout line,
  write, spawn or engine connection — the CLIs `autopilot.mjs`, `autopilot-context.mjs`,
  `loop-engineer.mjs`, `project-scaffold.mjs`, `render-claude-md.mjs`, `inception-state.mjs`,
  `inception-governance.mjs`, `capture-review-evidence.mjs`, `capture-inception-evidence.mjs`,
  `task-results.mjs`, `reviewer-response.mjs` and `structural-promotion.mjs`, plus the library
  writers `collectReviewEvidence`, `collectInceptionEvidence`, `applyProjectScaffold`,
  `runConductor` and `runLoopController` — while the workflow skills stop. The graph primitives
  (`graph`, `context`, `promotion`, `hub-mode`) never refuse. `hub-mode` declares `graph`,
  `migrate`, or `none`.
- `graph-migrate` is the one way out of `.apex/`. A new Step 0 declares the hub mode and picks
  the path from its evidence: a Markdown hub provisions and binds the engine (`graph init`; an
  existing `.formula/config.json` wins) before the extraction, and leftover local state takes a
  cleanup path that names what is discarded and removes `.apex/` only after an explicit answer.
  The closure archives the whole area and never restores its work area, inception run or
  receipts; `.formula/work/` is created fresh. The extractor skips leftover `work/` and
  `inception/` files before name-based recognition, so a `glossary.md` or `conventions.md` in
  there can no longer replace the hub's own.
- `graph init` writes a create-only `.formula/.gitignore` (`*`, `!.gitignore`, `!config.json`)
  beside the committed binding, so every other `.formula/` file stays local whatever the root
  `.gitignore` says, and echoes it on an `ignore:` line.
- The generated bootstrap and `AGENTS.md` navigation changed: right after the hub-mode
  declaration they stop on `migrate` (run `graph-migrate`) and on `none` (run `init`). A
  bootstrap or `AGENTS.md` rendered by v1.0.0 is an earlier rendering, so scaffold repair
  classifies it `customized`; an explicit `replace` resolves it.
- The live scaffold canary's skill-allowlist check is scoped to the allowlist sentence, since
  the orientation step now names `graph-migrate` and `init` on its own.
- OpenCode registers project hub agents only when the project carries the `.formula/config.json`
  graph binding.
- Removed: the Markdown hub linter `scripts/validate-hub.mjs`; the Stop hook
  (`scripts/stop-hook.mjs`) and the `hooks/` directory, so the plugin ships no hooks and the
  coherence gate (`steepy-formula graph validate`) runs at `check`/`review` time on every
  harness; `scripts/new-surface.mjs`; the legacy-only templates `templates/_INDEX.md`,
  `templates/routing-row.md`, `templates/surface-standard.md`, and
  `templates/surface-standard-core.md`; the legacy channel of `render-claude-md.mjs` (`--mode`
  accepts only `graph` and defaults to it, and the `projectModelFromArgs` export is gone); the
  `--routing-index` and `--standard` arguments of `loop-engineer.mjs` (`--graph-target` is the one
  routing input); the live scaffold canary's `--hub-mode` flag; the `--no-gate` option of review
  evidence capture; the `documents` subcommand and the `writeGovernanceDocuments` export of
  `inception-governance.mjs` (its input's `documents` must be empty: init certifies no Markdown
  document); and, in `project-scaffold.mjs`, the `hubMode: legacy` model value, the
  `renderLegacyClaudeMd`, `renderLegacyClaudeBootstrap` and `renderLegacyClaudeSpecialist`
  exports, and the silent upgrade of untouched pre-portable renderings, which now classify as
  conflicts.

## v1.0.0 (2026-10-21)

First public release.

- Govern a repository's stable knowledge in a Stable Knowledge Graph: a typed, versioned graph
  on a pinned local ArcadeDB engine (Docker, bound to localhost), with an in-memory reference
  port for development and tests.
- Change stable knowledge only through human-approved promotion scenarios recorded as
  hash-chained Revisions; `graph validate` catches out-of-band writes, and `graph export`,
  `backup`, `restore`, and `migrate-schema` cover recovery and schema evolution.
- Resolve deterministic task context with `context resolve`: the rules, owners, checks, skills,
  and rationale that apply to a path or surface target.
- Provide eleven shared skills for inception, graph-first initialization, migration from a
  legacy `.apex/` Markdown hub, surface registration, checks, discovery, brainstorming,
  planning, implementation, review, and bounded autonomous loops.
- Package native integrations for Claude Code, Codex, OpenCode, Pi, and DeepSeek Harness.
  Deterministic Gear-3 autopilot and Gear-4 loops run on Claude, Codex, and OpenCode;
  Pi and DeepSeek explicitly report `runner-unavailable` for those controllers.
- Keep work artifacts local and gitignored under `.apex/work/`, with explicit handoffs, durable
  execution evidence, crash recovery, and observable resource usage.
- Ship Node.js 24 tooling with a single pinned runtime dependency (`neo4j-driver`), release
  validation, and installation, workflow, architecture, privacy, and security documentation.

This changelog starts with the public release line.
