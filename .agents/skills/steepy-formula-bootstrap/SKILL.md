---
name: steepy-formula-bootstrap
description: Project entry point for steepy-formula. Loads the root instructions and routes work through the Stable Knowledge Graph.
user-invocable: true
---
<!-- steepy:generated:steepy-formula-bootstrap:v1 -->

# steepy-formula bootstrap

Use this skill before working on the project.

## Procedure

1. Read `AGENTS.md` in full for the project overview, development commands, and confirmed surfaces.
2. Declare the hub mode: run `steepy-formula hub-mode` and quote the `mode:` line. If it reports `migrate`, stop and tell the user to run the `graph-migrate` skill; if it reports `none`, stop and tell the user to run the `init` skill.
3. Resolve the task context: run `steepy-formula context resolve --path <task-path>` for the paths the task will touch (fallback `--target apex:<projectId>:surface:<slug>`) and load exactly the layers the resolve returns (context.json + context.md).
4. State the owning surface and specialist agent before changing files.
5. When a steepy-formula workflow is needed, invoke it by its semantic skill name — one of the eleven canonical skills: `inception`, `init`, `check`, `new-surface`, `discovery`, `brainstorm`, `plan`, `implement`, `review`, `loop-engineer`, `graph-migrate`.
6. Run the owning surface's test command and `steepy-formula graph validate` before reporting completion.

## Work-artifact boundary

Do not ordinarily enumerate, search, or read under `.apex/work/**`.

A workflow phase may consume only the exact work inputs named by an accepted handoff. A pathless workflow invocation may perform only bounded workflow-header recovery discovery. Exact paths or a broader work-area scope are permitted only when the user explicitly delimits them. This applies transitively to child agents: only the phase orchestrator interprets a handoff.
