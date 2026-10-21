# steepy-formula community marketplace submission notes

## Identity

- Plugin name: `steepy-formula`
- Owner: `steepy-it`
- License: Apache-2.0
- Distribution target: Claude Code community marketplace
- Submission: developer portal `claude.ai/directory/manage` → **Submit new** → **Plugin bundle**
- Repository and branch: `steepy-it/steepy-formula`, branch `claude-directory` (the Release workflow appends one payload commit per version; `main` is never submitted)

## Short description

Land governed project knowledge in a canonical Stable Knowledge Graph, route work by surface, and keep it coherent with graph validation.

## Positioning

Your AI documentation stops rotting.

steepy-formula governs a repository's stable knowledge in the canonical Stable Knowledge Graph, routes work by surface, and validates that the graph remains coherent as the project evolves.

## What the plugin includes

- Eleven canonical skills: `/steepy-formula:inception`, `/steepy-formula:init`, `/steepy-formula:graph-migrate`, `/steepy-formula:new-surface`, `/steepy-formula:check`, `/steepy-formula:brainstorm`, `/steepy-formula:plan`, `/steepy-formula:implement`, `/steepy-formula:review`, `/steepy-formula:discovery`, and `/steepy-formula:loop-engineer`.
- Node.js 24+ scripts for stack detection, project scaffolding, and workflow controllers, plus the `steepy-formula` graph engine CLI (`graph` init/validate/export, `context resolve`, typed `promotion` create/preview/apply) that graph-first init gates on.
- Templates for specialist agents, a managed `AGENTS.md` root, a thin `CLAUDE.md` import, and a canonical project bootstrap skill.

## Runtime behavior and safety

- steepy-formula has five native harnesses: Claude Code, Codex, OpenCode, Pi, and DeepSeek Harness.
- steepy-formula writes the gitignored `.apex/work/` local work area and a root `CLAUDE.md` into the target repo — graph-first init creates no other `.apex/` files.
- steepy-formula writes Claude Code agent and skill artifacts into the target repo during initialization.
- steepy-formula runs Node.js scripts from the plugin package, and runs the graph engine as a local Docker container bound to localhost.
- Core workflows do not require network access to third-party services; the runtime dependency set is a single pinned package (`neo4j-driver`, Apache-2.0) kept behind the engine adapter.
- **Command-family effects matrix:** filesystem reads–writes–subprocesses–temporary state–providers/network are command-specific. Local validation/scaffolding, the graph families (`graph`, `context`, `promotion`), session-store reporting, version writes, review/controllers, inception runs, release evidence, live model mapping, and native installation/canaries have distinct effects.

## Validation before submission

Run from the repository root:

```bash
npm ci
npm test
claude plugin validate .
```

Then run the local marketplace and throwaway repo smoke tests documented in `RELEASE.md`.

Finally, press **Validate** in the developer portal on branch `claude-directory`, and submit for review only when it reports 0 Blocking results. The portal scanner is heuristic, so Policy holds and Warnings can remain on a clean payload: record each one with the reason you accept it.

## Review notes

- This is a community/open-source plugin submission.
- The plugin does not claim Anthropic endorsement.
- Claude Code, Codex, OpenCode, Pi, and DeepSeek Harness each have shipped native installation wiring; host capabilities and deterministic runner support differ by harness.

## OpenAI submission preparation

Use the Skills-only route in [OpenAI's submission guide](https://developers.openai.com/plugins/deploy/submission).
The following are proposed reviewer scenarios, not completed test results. Run them on the
final imported package in a repository-capable environment with Node 24, Git, and Docker.

| Type | Scenario | Expected behavior |
|---|---|---|
| Positive | Initialize a small disposable Node repository with a working test command and Docker available. | Interview completes; the initial graph promotion is applied at confirmation; managed root, bootstrap, and per-surface agents are generated; check passes. |
| Positive | Run check on a coherent initialized project. | Reports coherence (`steepy-formula graph validate` green) without changing project files. |
| Positive | In a repository carrying `.apex/_INDEX.md`, run `hub-mode`. | Reports `migrate` and names `graph-migrate`. |
| Positive | Brainstorm a small covered change and approve the resulting spec. | Publishes a READY local spec and the appropriate next-phase handoff. |
| Positive | Add a new surface to an initialized project. | Registers the surface through a human-approved graph promotion and writes its native specialist adapters. |
| Negative | Request an autonomous loop without a complete goal or commit authorization. | Refuses autonomous execution and identifies the missing inputs. |
| Negative | Request a handoff pointing outside the authorized local work area. | Rejects that handoff without searching for another recent artifact. |
| Negative | Request deterministic Gear-4 execution through Pi or DeepSeek. | Reports runner-unavailable without claiming an autonomous run. |

Starter prompts: “Initialize governed project knowledge for this repository”; “Check this project's
knowledge graph”; “Help me specify a small change and choose the appropriate workflow.”

Publisher-owned items still needed: verified developer/business identity, public website/support,
privacy policy and terms URLs, country availability, and observed results for these scenarios.
