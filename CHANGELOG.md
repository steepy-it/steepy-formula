# Changelog

## v1.0.0 (2026-10-22)

First public release.

- Store repository rules, terminology and decisions in a local Stable Knowledge Graph, with human-approved changes and integrity-checked exports.
- Resolve the rules, owners and checks relevant to each coding task, and validate knowledge coherence throughout the workflow.
- Use eleven skills to start projects, initialize governance, discover existing code, plan and implement changes, review results, and run bounded autonomous loops.
- Keep project instructions and specialist agents alongside the code, with local work and recovery state under `.formula/`.
- Import an existing steepy-apex Markdown hub through the `graph-migrate` skill.
- Use Claude Code or Codex on macOS and Linux. OpenCode, Pi and DeepSeek Harness integrations are experimental. Windows is unsupported.

Requires Node.js 24 or later and Docker for the local graph engine. See the [installation guide](docs/installation.md) for setup and the [workflow guide](docs/workflow.md) for capabilities and limitations.
