# Changelog

## v1.1.0 (2026-10-27)

- Run every Gear-3 task and the whole-branch review as a guarded correction cycle: three iterations per cycle, at most one read-only diagnosis, and retries admitted only with evidence from the previous attempt.
- Stop a cycle on stagnation, an unavailable comparison or exhaustion, keep its best-ranked candidate, and continue with independent tasks while dependent tasks stay blocked.
- Report a run that cannot finish every task as an explicitly unapproved `PARTIAL` outcome listing completed, stopped and blocked tasks, unresolved defects and next remedies; autopilot ends it at `PARTIAL_REVIEWED` with exit code 3, never `READY_FOR_PR`.
- Reopen a stopped task or final review only through an explicit human authorization in manual drive, before the partial result is published.
- Require exactly one `**Dependencies:**` line per plan task (`none` or earlier task numbers in increasing order); plans without it are rejected.
- Halt the whole run on corrupted correction records or on source changes outside an authorized writer.

## v1.0.0 (2026-10-22)

First public release.

- Store repository rules, terminology and decisions in a local Stable Knowledge Graph, with human-approved changes and integrity-checked exports.
- Resolve the rules, owners and checks relevant to each coding task, and validate knowledge coherence throughout the workflow.
- Use eleven skills to start projects, initialize governance, discover existing code, plan and implement changes, review results, and run bounded autonomous loops.
- Keep project instructions and specialist agents alongside the code, with local work and recovery state under `.formula/`.
- Import an existing steepy-apex Markdown hub through the `graph-migrate` skill.
- Use Claude Code or Codex on macOS and Linux. OpenCode, Pi and DeepSeek Harness integrations are experimental. Windows is unsupported.

Requires Node.js 24 or later and Docker for the local graph engine. See the [installation guide](docs/installation.md) for setup and the [workflow guide](docs/workflow.md) for capabilities and limitations.
