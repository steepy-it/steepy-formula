# Changelog

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
