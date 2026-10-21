# Contributing to steepy-formula

## Command-family effects matrix

Before running a command, consult the [effects matrix](docs/architecture.md#command-family-effects-matrix) and choose the relevant effects boundary: filesystem
reads–writes–subprocesses–temporary state–providers/network. Local validation and
scaffolding differ from session-store reporting, version transactions, workflow
controllers, release-evidence validation, live model-mapping verification, and native
installation/canaries, and from the graph families (`graph`, `context`, `promotion`), which
drive a local Docker engine. The runtime dependency set is a single pinned package
(`neo4j-driver`, Apache-2.0) behind the engine adapter, and some families intentionally invoke
Git, npm, Docker, a provider catalog, or a host harness.

Thanks for your interest. Contributions follow one rule: **discuss features first, fix bugs directly.**

## What's welcome

- **Bug reports** — open an issue with the bug report template.
- **Bug-fix PRs** — welcome directly. Include a regression test that your fix turns green.
- **Feature PRs** — open an issue first and wait for a go-ahead. The governance model (canonical graph, surface routing, work artifacts, coherence gate) is deliberate; a PR that fights it will be declined even when the code is good.
- **Docs fixes** — typos and clarity fixes are always welcome.

## Dev setup

You need Node.js >= 24. The one runtime dependency (`neo4j-driver`) installs from the committed lockfile; the engine-backed suites also need Docker, and skip without it.

```bash
git clone https://github.com/steepy-it/steepy-formula.git
cd steepy-formula
npm ci
npm test
```

`npm test` runs the whole suite with the Node built-in test runner. It must be green before and after your change.

## What a PR is checked against

1. **Tests pass** — `npm test` is green. Bug fixes add a regression test; features come with tests (this repo is built test-first).
2. **Knowledge stays coherent** — the canonical graph passes `steepy-formula graph validate`.
3. **Version gate** — every PR either bumps the plugin version (`node scripts/bump-version.mjs <patch|minor|major>`) and adds a matching `## vX.Y.Z` section to `CHANGELOG.md`, or carries the `no-release` label (docs-only and CI-only changes). CI enforces this.

## Navigating the code

This repo governs itself with the canonical Stable Knowledge Graph (the Markdown hub was archived at the dogfood cutover). Start from `CLAUDE.md`, then resolve the task context with `steepy-formula context resolve --path <p>... | --target <id>...` — the resolved context names the surface (scripts, skills, templates, tests, adapters) that owns each kind of change and the rules it follows. Validate coherence with `steepy-formula graph validate`.
