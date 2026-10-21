---
name: new-surface
description: 'Add a surface: render the graph sub-agent and promote Surface + verification Rule + Check into the graph.'
user-invocable: true
argument-hint: 'surface name and its path'
---

# new-surface

Add a surface: render the graph-mode sub-agent and promote the Surface into the canonical Stable
Knowledge Graph — no standards doc and no routing table exist.

> **Engine root:** this skill's base directory is `<engine-root>/skills/new-surface/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Procedure

1. **Gather inputs** — if the user has not provided all four pieces of information, ask for them before proceeding:
   - **Surface name** — short, lowercase, hyphen-separated identifier (e.g. `api`, `admin-dashboard`).
   - **Surface path** — workspace-relative path to the surface codebase (e.g. `apps/api`).
   - **Specialist agent** — semantic agent identifier, defaulting to `<name>-agent` only when the user accepts it.
   - **Test command** — the command used to run tests for this surface (e.g. `vitest run`, `pytest`).

2. **Declare the hub mode.** Run `steepy-formula hub-mode` and quote its `mode:` line —
   `graph`, `migrate`, or `none`, each printed with one `evidence:` line. The command always
   exits 0: it is a declaration, not a gate, and this prose never re-implements its detection —
   the command is the single authority. The declared mode routes the rest of the run:

   | Declared mode | Route |
   |---------------|-------|
   | `graph` | Continue with Steps 3–6 — the graph promotion; never create a standards doc. |
   | `migrate` | Stop and tell the user to run the `graph-migrate` skill (invoke it the way your harness invokes skills) before any other workflow. |
   | `none` | No hub to add a surface to — tell the user to run the `init` skill (invoke it the way your harness invokes skills) first, and stop. |

3. **Render the specialist agent** — create `.claude/agents/<surface-name>-agent.md` from the
   graph-mode agent template `<engine-root>/templates/surface-agent-graph.md` by substituting
   `{{name}}` and `{{path}}` agent-side (refuse to overwrite an existing agent file — surface
   the conflict to the user instead). That template's per-task guidance points the agent at
   the deterministic surface target — `steepy-formula context resolve
   --target apex:<projectId>:surface:<slug(name)>`, with `--path {{path}}` as the alternative
   where a topology bridge exists — never at a standards doc, because there
   is none. Binding is deterministic: surface `<name>` → agent file
   `.claude/agents/<name>-agent.md`.

4. **Build the structural promotion scenario (nothing applied).** The shipped
   `promotion create` command carries only typed knowledge candidates
   (`term`/`rule`/`decision`/`readme`) and cannot express a Surface — drive the shipped
   structural-promotion helper instead; it works on an initialized graph (ADD operations whose
   target already exists in the stable graph are skipped and reported, so only the genuinely
   new nodes and edges ride the scenario). Write the surface into
   `.apex/work/new-surface-<surface-name>.json` — a local, gitignored work artifact:

   ```json
   {
     "project": { "id": "<projectId>" },
     "surfaces": [
       { "name": "<surface-name>", "path": "<surface-path>",
         "testCommand": "<test-command>" }
     ]
   }
   ```

   - `<projectId>` is the project id the Step 2 declaration echoed on its `project:` line
     (the CLI's fixed resolution chain — in an initialized repo it comes from
     `.formula/config.json`); the helper requires the file's `project.id` and its `--project`
     flag to agree.
   - `testCommand` is the test command the user confirmed in Step 1 — from it the helper
     derives the surface's verification Rule (`APPLIES_TO` → the Surface) and its Check with
     the command persisted as the `ext_v1_command` extension property (`VERIFIED_BY` from the
     Rule). That property is where graph-aware skills read the surface's test command from the
     resolved context.

   Then create the draft scenario:

   ```bash
   node <engine-root>/scripts/structural-promotion.mjs \
     --project <projectId> --port docker \
     --input .apex/work/new-surface-<surface-name>.json new-surface-<surface-name>
   ```

   The helper maps the input into plain ADD operations — the Surface (with `PART_OF` → the
   Project root, whose own ADD is skipped as already present), the verification Rule with
   `APPLIES_TO` → the Surface, and the Check with `ext_v1_command` and `VERIFIED_BY` — and
   creates the DRAFT scenario through the core promotion lifecycle. Nothing is applied here;
   record the scenario id it reports.

5. **Preview and human gate.**

   ```bash
   steepy-formula promotion preview new-surface-<surface-name>
   ```

   The typed diff report IS the preview: show it to the user. Approval is explicit, never
   assumed — one question with a clear yes/change/no choice; never proceed on silence. On
   **yes**, commit the transaction:

   ```bash
   steepy-formula promotion apply new-surface-<surface-name>
   ```

   Run apply WITHOUT `--yes`, so the CLI itself prompts on stdin and refuses (exit 21) unless
   the human confirms.

6. **Verify** — run the graph coherence gate, then a resolver spot-check:

   ```bash
   steepy-formula graph validate
   steepy-formula context resolve --target apex:<projectId>:surface:<slug(name)>
   ```

   `graph validate` must come back clean, and the resolved context must return the new
   Surface, its verification Rule, and its Check carrying the approved test command as
   `ext_v1_command`. (`--path <surface-path>` answers only where a topology bridge exists;
   on a curated-only graph it exits 10 UNRESOLVED — expected, not a failure.) If either
   gate fails, fix the graph before considering the task complete.
