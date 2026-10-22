# Changelog

## Unreleased

**Breaking:** steepy-formula is graph-only. The canonical Stable Knowledge Graph is the single
stable-knowledge channel; the `legacy` Markdown hub mode is gone.

- A repository carrying `.apex/_INDEX.md` (a steepy-apex Markdown hub) is now the `migrate`
  state: `steepy-formula hub-mode` reports `migrate` and names the next step, and the workflow
  scripts (`autopilot.mjs`, `autopilot-context.mjs`, `loop-engineer.mjs`, `project-scaffold.mjs`,
  `render-claude-md.mjs`, `inception-state.mjs`, `inception-governance.mjs`,
  `capture-review-evidence.mjs`) refuse with exit 25 while the workflow skills stop, until
  `graph-migrate` moves the hub into the graph. The graph
  primitives (`graph`, `context`, `promotion`, `hub-mode`) never refuse. `hub-mode` declares
  `graph`, `migrate`, or `none`.
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
  accepts only `graph`); the `--routing-index` and `--standard` arguments of
  `loop-engineer.mjs` (`--graph-target` is the one routing input); the live scaffold canary's
  `--hub-mode` flag; and the `--no-gate` option of review evidence capture.

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
