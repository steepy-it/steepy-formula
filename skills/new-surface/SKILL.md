---
name: new-surface
description: Add a new surface for the hub mode declared by `steepy-formula hub-mode` — legacy composes the create-only standard plus specialist adapter triad through the planner and lands the routing row (the scaffolder inserts it on bound hubs); graph renders the graph-mode sub-agent and promotes the Surface (verification Rule + Check) into the canonical graph.
user-invocable: true
argument-hint: 'surface name and its path'
---

# new-surface

Add a new surface for the declared hub mode: in **legacy** mode compose the standard doc and the
specialist adapter triad through the common planner, then land the routing row (the scaffolder
inserts it itself on a bound hub; paste it only on an unbound one); in **graph** mode render the
graph-mode sub-agent and promote the Surface into the canonical Stable Knowledge Graph — no
standards doc and no routing table exist there.

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
   `graph`, `legacy`, or `none`, each printed with one `evidence:` line. The command always
   exits 0: it is a declaration, not a gate, and this prose never re-implements its detection —
   the command is the single authority. The declared mode routes the rest of the run:

   | Declared mode | Route |
   |---------------|-------|
   | `legacy` | Steps 3–5 — the Markdown-hub scaffold, composed through the common planner. |
   | `graph` | Steps 6–9 — the graph promotion. **Never scaffold `.apex/standards/` and never touch `.apex/_INDEX.md`:** neither exists in graph mode, and creating a standards doc would make `.apex/` non-work-only with no `_INDEX.md`, flipping the legacy linter (and any Stop hook running it) permanently red. |
   | `none` | No hub to add a surface to — tell the user to run the `init` skill (invoke it the way your harness invokes skills) first, and stop. |

### Legacy mode

3. **Run the scaffolder** — execute the following command, substituting the values collected above and resolving `<repo-root>` to the repository root:

   ```bash
   node <engine-root>/scripts/new-surface.mjs \
     --name <name> \
     --path <path> \
     --agent <agent> \
     --test "<testCmd>" \
     --hub <repo-root>
   ```

   `new-surface.mjs` first reports which explicit mode it used:

   - **active-v1** — the hub's `AGENTS.md` carries the managed project-instructions block, so the
     scaffolder derives the real Project identity from it, adds or confirms the surface in that
     full Project model, and routes the change through the public planner in
     `project-scaffold.mjs`. It updates the managed root and routing row together with the
     create-only standard and generated specialist triad: the script inserts the routing row
     itself (staged, create-only) and prints `active-v1 root instructions and routing are
     coherent with the surface result`. If the planner reports a conflict — e.g. a customized
     spine such as the first surface on a root-only project — make the user choose only from
     its emitted ID and choices, then repeat the command with one `--resolution <id=choice>`
     per choice. Do not infer a replacement or add an unoffered choice.
   - **preparatory-unbound** — no managed Project identity exists yet, so the scaffolder
     explicitly limits itself to the common specialist planner. It plans all four surface
     artifacts before the first write and creates the standard plus specialist triad
     without pretending to update a Project identity that does not exist.

   In both modes the surface result is four artifacts:

   - `.apex/standards/<name>.md`;
   - `.claude/agents/<agent>.md`;
   - `.codex/agents/<agent>.toml`;
   - `.opencode/agents/<agent>.md`.

   Do not reproduce planner provenance markers or hand-render an adapter in this skill. The standard
   remains create-only. If the surface is a repair of an incomplete scaffold, add `--repair`; repair
   keeps current artifacts and creates only absent members of the standard-plus-triad result.
   Any adapter that is not the current canonical rendering, an untouched earlier one included, is a
   `customized` conflict: repair stops, and only an explicit `replace` (through
   `--resolution <id>=replace` in an active hub) writes the current rendering.

4. **Register the surface** — in **active-v1** mode, do not edit generated or managed artifacts
   after the command: the public workflow has already made the root, routing row, standard, and
   triad agree. In **preparatory-unbound** mode only, the paste-row flow survives: open
   `.apex/_INDEX.md` in the repo root and paste the printed routing row into the routing table
   if that surface has no row. Never rewrite the routing table or change another row.

5. **Verify** — run the hub linter and confirm it exits green:

   ```bash
   node <engine-root>/scripts/validate-hub.mjs .
   ```

   Then rerun the scaffolder with `--repair`; a complete result must report every
   standard/triad member preserved and leave bytes, modes, and mtimes unchanged. Report each
   member of the standard-plus-triad result as created, updated, or preserved, and report every
   other file the command lists as created or updated. If the linter reports errors, fix them
   before considering the task complete.

### Graph mode

6. **Render the specialist agent** — create `.claude/agents/<surface-name>-agent.md` from the
   graph-mode agent template `<engine-root>/templates/surface-agent-graph.md` by substituting
   `{{name}}` and `{{path}}` agent-side (refuse to overwrite an existing agent file — surface
   the conflict to the user instead). That template's per-task guidance points the agent at
   the deterministic surface target — `steepy-formula context resolve
   --target apex:<projectId>:surface:<slug(name)>`, with `--path {{path}}` as the alternative
   where a topology bridge exists — never at a standards doc, because there
   is none. The legacy scaffolder (`new-surface.mjs`) is NOT invoked here: it creates a
   standard doc, which must never exist in graph mode. Binding is deterministic: surface
   `<name>` → agent file `.claude/agents/<name>-agent.md`; there is no routing table in graph
   mode.

7. **Build the structural promotion scenario (nothing applied).** The shipped
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

   - `<projectId>` is the project id the step 2 declaration echoed on its `project:` line
     (the CLI's fixed resolution chain — in an initialized repo it comes from
     `.formula/config.json`); the helper requires the file's `project.id` and its `--project`
     flag to agree.
   - `testCommand` is the test command the user confirmed in step 1 — from it the helper
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

8. **Preview and human gate.**

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

9. **Verify** — run the graph coherence gate, then a resolver spot-check:

   ```bash
   steepy-formula graph validate
   steepy-formula context resolve --target apex:<projectId>:surface:<slug(name)>
   ```

   `graph validate` must come back clean, and the resolved context must return the new
   Surface, its verification Rule, and its Check carrying the approved test command as
   `ext_v1_command`. (`--path <surface-path>` answers only where a topology bridge exists;
   on a curated-only graph it exits 10 UNRESOLVED — expected, not a failure.) If either
   gate fails, fix the graph before considering the task complete.
