# Privacy policy

steepy-formula is a plugin that runs inside your AI coding agent, on your machine. steepy-it
runs no server for it, so no data reaches steepy-it.

## What steepy-formula does not collect

- No telemetry, analytics, or crash reports.
- No account, sign-in, or license key.
- No personal data.

## What stays on your machine

**The Stable Knowledge Graph.** Your project's stable knowledge lives in a local graph engine:
an ArcadeDB server that steepy-formula runs in a Docker container on your machine, one per
project, with every port bound to `127.0.0.1`. The plugin talks to it over the Bolt protocol
through its one pinned runtime dependency, `neo4j-driver`. Nothing in the graph is sent
anywhere unless you export it yourself (`graph export` / `graph backup` write local files you
choose to share).

**The database password.** It is resolved locally, first hit wins: your OS keychain (on macOS,
the `security` CLI, service `steepy-formula`), then the owner-only, gitignored
`.formula/secrets.json` file in the project, then `STEEPY_FORMULA_*` environment variables for
CI. It reaches the engine through the container's environment settings at `docker create`, so on
your machine it is visible to `docker inspect` and to local process listings; it is never committed
and never a `steepy-formula` command-line flag. If no password is stored, `graph init` generates a
fresh one per run. Signed exports never carry credentials.

**Your repository.** Specs, plans, and workflow logs stay in your repository under the
gitignored `.formula/work/`. Autopilot logs are redacted by default (`log-mode: safe`). The
committed `.formula/config.json` holds only the project id. A steepy-apex hub under `.apex/` (a
one-time migration source for `graph-migrate`) is ordinary files in your repository; you decide
whether to commit it.

## External services

These skills reach services outside your agent session:

| Skill | Service | What is sent |
|---|---|---|
| `/steepy-formula:init` | Docker Hub, through your local Docker daemon | A pull of the pinned `arcadedata/arcadedb` engine image the first time `graph init` provisions the engine. No project data is sent; the engine then runs locally. |
| `/steepy-formula:brainstorm` in autopilot drive | The harness named in the run contract: Claude Code, Codex, or OpenCode | Phase prompts and repository content go to that harness's model provider, for example OpenAI through Codex. |
| `/steepy-formula:check` | Public model pages from OpenAI and Anthropic, plus `opencode models` when OpenCode is installed | Requests for the current model list, used to verify the model table. No project data is sent. |
| `/steepy-formula:review` | GitHub, through Git and the `gh` CLI | Your branch and a pull request to `main`, only after you confirm. |
| `/steepy-formula:inception` | Official project documentation and package registries, reached through your harness and the approved tools; Git hosting only after your authorization | Research queries and installs. Pushes or repository creation only after you authorize each one. |

`/steepy-formula:loop-engineer` runs its attempts on the harness you are already using. Each of
these services handles what it receives under its own privacy policy. Per-command effects
are in the [Command-family effects matrix](docs/architecture.md#command-family-effects-matrix).

## Contact

Questions about this policy: open an issue at
[github.com/steepy-it/steepy-formula/issues](https://github.com/steepy-it/steepy-formula/issues)
or write to **info@steepy.it**. Report vulnerabilities as described in
[SECURITY.md](SECURITY.md).

## Changes

Changes to this policy land in this file and are noted in the [CHANGELOG](CHANGELOG.md).
