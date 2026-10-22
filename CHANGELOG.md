# Changelog

## v1.0.0 (2026-10-22)

First public release.

- Govern a repository's stable knowledge in a Stable Knowledge Graph: a typed, versioned graph
  on a pinned local ArcadeDB engine (Docker, bound to localhost), with an in-memory reference
  port for development and tests. The graph is the single stable-knowledge channel; there is
  no Markdown hub mode.
- Change stable knowledge only through human-approved promotion scenarios recorded as
  hash-chained Revisions; `graph validate` catches out-of-band writes, and `graph export`,
  `backup`, `restore`, and `migrate-schema` cover recovery and schema evolution.
- Resolve deterministic task context with `context resolve`: the rules, owners, checks, skills,
  and rationale that apply to a path or surface target.
- Declare the hub mode with `steepy-formula hub-mode`: `graph`, `migrate`, or `none`. Any
  `.apex/` entry — a steepy-apex Markdown hub (`.apex/_INDEX.md`), a work area, an inception run
  or receipts, even a dangling link — is the `migrate` state, even over a reachable, initialized
  engine. Every workflow entry point then refuses with exit 25 and one message naming
  `graph-migrate`, before any stdout line, write, spawn or engine connection; the graph
  primitives (`graph`, `context`, `promotion`, `hub-mode`) never refuse.
- Provide eleven shared skills for inception, graph-first initialization, migration from a
  steepy-apex `.apex/` Markdown hub, surface registration, checks, discovery, brainstorming,
  planning, implementation, review, and bounded autonomous loops. `graph-migrate` is the one way
  out of `.apex/`: it extracts a Markdown hub into the graph, or names the leftover local state
  it discards and removes `.apex/` only after an explicit answer. The coherence gate
  (`steepy-formula graph validate`) runs at `check` and `review` time on every harness; the
  plugin ships no hooks.
- Package native integrations for Claude Code, Codex, OpenCode, Pi, and DeepSeek Harness.
  Deterministic Gear-3 autopilot and Gear-4 loops run on Claude, Codex, and OpenCode;
  Pi and DeepSeek explicitly report `runner-unavailable` for those controllers. OpenCode
  registers project hub agents only when the project carries the `.formula/config.json` graph
  binding.
- Keep formula's local areas under `.formula/` and out of git: the work area `.formula/work/`
  (specs, plans, task and loop state) with explicit handoffs, durable execution evidence, crash
  recovery, and observable resource usage; inception runs under `.formula/inception/`; and the
  init provenance receipts `.formula/init-provenance.json`. `graph init` writes a create-only
  `.formula/.gitignore` beside the committed `.formula/config.json` binding.
- Ship Node.js 24 tooling with a single pinned runtime dependency (`neo4j-driver`), release
  validation, and installation, workflow, architecture, privacy, and security documentation.

This changelog starts with the public release line.
