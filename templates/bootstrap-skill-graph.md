---
name: {{projectName}}-bootstrap
description: Per-task entry point for {{projectName}}. Declares the hub mode, resolves task context from the Stable Knowledge Graph, and names the owning surface and specialist agent.
user-invocable: true
---

# {{projectName}}-bootstrap

Entry point for every AI task on this project. Run this first to orient before touching code.
Orientation comes from `steepy-formula hub-mode` and `steepy-formula context resolve`.

## Procedure

### Step 1 — Read the project map

1. Read `CLAUDE.md` (repo root) in full — project overview, dev commands, constraints.
2. Declare the hub mode: run `steepy-formula hub-mode` and quote the `mode:` line.
   If it reports `migrate`, stop and tell the user to run the `graph-migrate` skill;
   if it reports `none`, stop and tell the user to run the `init` skill. If the `steepy-formula`
   command is not found, stop and tell the user to put the CLI on PATH (steepy-formula's
   installation guide, "Requirements"); never guess another path to it.
3. Resolve the navigation map: run `steepy-formula context resolve --path <task-path>` for the
   path(s) the task will touch. Exit 0 emits `context.json` + `context.md` — that resolved
   context (surfaces, agents, rules, checks, terms) is the project map this procedure walks.
   On exit 10 UNRESOLVED — normal in a freshly graph-first-initialized repo, where no topology
   bridge links the detected Packages to the curated Components yet — fall back to the
   deterministic surface targets:
   `steepy-formula context resolve --target apex:<projectId>:surface:<slug(name)>` for each
   owning surface, every part derived, never guessed — surface names from
   `.claude/agents/<name>-agent.md` (CLAUDE.md's Surfaces section is the fallback listing),
   the project id from the hub-mode declaration's `hub-mode '<projectId>'` echo, `slug(name)`
   lowercase with non-alphanumeric runs collapsed to `-` — and never target the bare project
   root on its own: it resolves empty.

### Step 1.5 — Detect workflow state and recommend the next step

For feature-shaped work, check where the task already sits in the steepy workflow chain and recommend the next command (advisory — each command is independently usable):

- No spec for this task in `.formula/work/specs/` → recommend `/steepy-formula:brainstorm`.
- A spec exists but no matching plan in `.formula/work/plans/` → recommend `/steepy-formula:plan`.
- A plan exists but its tasks are not yet implemented → recommend `/steepy-formula:implement`.
- Implementation is complete and unreviewed → recommend `/steepy-formula:review`.

For small non-feature tasks (config, one-line fixes), skip the chain and proceed to Step 2.

### Step 1.6 — Confirm the working branch

Check the current branch (`git branch --show-current`). If it is `main` or `master`, ask the user before changing files or dispatching agents: **"You're on `main` — work here, or switch to a new branch first?"** Proceed on whichever they choose; if they want a new branch, suggest a name from the task description. This applies regardless of the gear the task turns out to be — even a gear-1 change goes straight to the specialist agent with no further checkpoint, so this is the only place that guards it.

### Step 2 — Classify the task

Using the resolved context from Step 1, identify which surface owns the task:
- Match the task's paths against the Surfaces and Components the resolve returned; the owning surface is the one whose paths the task touches.
- If the task spans multiple surfaces, pick the primary one (the surface whose files will change most).
- If the task is purely cross-cutting (CI, config, tooling), note that explicitly.

### Step 2.5 — Coverage verdict

Judge whether the graph already **decides** this task's key decision. Emit exactly one verdict.
A COVERED or CONFLICT verdict is invalid without a `file:line` citation as evidence.

- **COVERED** — a Rule *decides the fork* (you can paste the citation next to the decision
  and close the matter). Cite `file:line`. A Rule merely *on the topic* does not count → that is a GAP.
- **CONFLICT** — a Rule and the intended change contradict each other. Cite `file:line`, stop,
  and surface the contradiction to the user (the workflow skills own the resolution).
- **GAP** — no Rule decides it. Before proposing any user brainstorm, **explore the codebase
  first** for an existing consistent convention (≥2–3 concordant occurrences); an isolated
  precedent is surfaced to the user, not treated as a rule.

### Step 2.6 — Gear selection

Cross the coverage verdict with the task's **value** (irreversibility / blast radius) to pick the
ceremony gear:

| Gear | When | Ceremony |
|------|------|----------|
| 1 | COVERED + low-value | Straight to the specialist agent. No spec/plan/brainstorm/subagent reviewer. `graph validate` at the end. |
| 2 | COVERED + high-value, or GAP + low-value | Light spec + `graph validate`. No subagent reviewer. |
| 3 | GAP + high-value / irreversible | Full chain: brainstorm gate → plan → implement → review. Subagent review on the code diff only (conditional per-task + whole-branch); spec/plan get a human gate. After the spec gate, run can go `manual` (default) or `autopilot` (unattended plan → implement → review in fresh headless sessions; stops before bump/PR); drive mode chosen at the spec gate. |
| 4 | Closed design (COVERED or resolved GAP) + machine-verifiable goal (deterministic verifier) + human confirmation | Autonomous loop via /steepy-formula:loop-engineer: the human authors the goal contract, reviews results morning-after. |

An open design GAP is never eligible for gear 4 — the chain (gear 1–3) resolves the design first.

**Ratification — every gear:** declare the computed gear with its evidence and ask the user for
one confirmation before starting the ceremony (this may be merged with the Step 1.6 branch
question into a single message). The user may force a different gear — the override is recorded
in the verdict artifact. Never auto-assignment, never autonomy started silently.

**Gear-4 branch:** on loop-shaped tasks (closed design + success expressible as a deterministic
command) propose gear 4. On confirmation, interview the user on the goal contract fields — goal,
surface, verifier (with explicit confirmation that it is deterministic), mode, metric-direction
(if metric), budget, blast-radius (default: the surface's paths), notes — and write
`.formula/work/loops/<YYYY-MM-DD>-<slug>/goal.md` with the verdict artifact (verdict + gear 4 +
evidence) at its head. Fields already present (a partial `goal.md` and/or slash-command
arguments passed through by the caller) are **confirmed, not re-asked**; only missing fields
are interviewed. On refusal, fall back to the coverage × value gear (1–3). This branch may be
invoked inline by `/steepy-formula:loop-engineer` when the loop is launched without a (complete)
goal contract — the bootstrap remains the sole author of the contract.

**Boundary rule:** closed design + machine-verifiable goal → gear 4; open design + trusted
execution after the spec gate → gear 3 autopilot; otherwise → gear 3 manual. On a harness
with no headless mode, autopilot is not offered (explicit degradation).

**Verdict artifact:** record `verdict + gear + evidence` at the head of the task's spec under
`.formula/work/`, or as a light one-line entry under `.formula/work/` when a gear-1 task produces no spec.
Downstream steepy commands read this artifact (see the workflow skills).

### Step 3 — Load the resolve layers

The Step 1 resolve output (`context.json` / `context.md`) is the minimum context — load exactly
what it returned, no more:

1. **Layer 1 (mandatory)** — every `must` Rule, required Check, Agent, and Skill the resolve
   named for the task. Always loaded; this layer is never truncated.
2. **Layer 2 (guidance)** — `should` Rules, Terms, and optional Checks: read only the entries
   the task actually touches, not the whole layer.
3. **Layer 3 (explanation)** — Decisions and provenance: only on an explicit rationale request.

Do not load graph nodes the resolve did not return, and do not re-resolve speculatively. When
the resolved context scopes a Surface that carries several Components, treat the Surface as the
core and load only the Components whose paths match the task — zero matches means the Surface
core only. Never walk the whole Surface as a fallback: the resolve already did the sub-area
scoping — beyond the layers there is nothing to read.

### Step 4 — Name the owning surface and specialist agent

State clearly:
- **Owning surface:** `<surface-name>` (from the resolved context)
- **Specialist agent:** `<surface-name>-agent` — delegate surface-specific implementation to this agent (Layer 1 `Agents` names it).
- **Applicable skill:** (if a steepy skill applies to this task, name it)

### Step 5 — Recommend the next step

Based on the classified surface and task, recommend one of:
- Implement directly using the specialist agent.
- Run the surface's Checks (named in the resolve output) to establish a baseline first.
- Propose the graph change (a promotion scenario) before implementing if the task changes a governed Rule, Term, or Decision.

Summarize the task classification in one sentence, then hand off.

## Work-artifact boundary

Do not ordinarily enumerate, search, or read under `.formula/work/**`.

A workflow phase may consume only the exact work inputs named by an accepted handoff. A pathless workflow invocation may perform only bounded workflow-header recovery discovery. Exact paths or a broader work-area scope are permitted only when the user explicitly delimits them. This applies transitively to child agents: only the phase orchestrator interprets a handoff.
