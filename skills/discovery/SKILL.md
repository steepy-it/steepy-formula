---
name: discovery
description: Populate and refresh the hub's knowledge from the real codebase via a seeded, per-item confirmed interview — accepted items land through a typed promotion scenario. Re-runnable — a second run surfaces only new or drifted items.
user-invocable: true
---

# discovery

Populate and refresh the hub's knowledge from the actual codebase, via a seeded interview the
user confirms item by item — the canonical graph's terms and rules, landed through a typed
promotion scenario (Step 2.5).

`discovery` is a **standalone** hub-aware skill, like `init` / `new-surface` / `check` — it is not
part of the brainstorm → plan → implement → review chain. It has its own precondition step below and
does not follow the chain skills' shared gear-selection or Model-Selection-lock format.

> **Engine root:** this skill's base directory is `<engine-root>/skills/discovery/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Procedure

### Step 0 — Preconditions

**Hub-mode declaration (once per run).** Run `steepy-formula hub-mode` and carry its declared
mode — `graph`, `migrate`, or `none`, each printed with one `evidence:` line — through the rest
of the run. The command always exits 0: it is a declaration, not a gate, and this prose never
re-implements its detection — the command is the single authority. The declared mode branches
the whole run:

- **`none`** → the hub is absent: tell the user to run the `init` skill (invoke it the way
  your harness invokes skills) — the graph-first entry point — and **stop**. `discovery`
  populates an existing hub, it does not create one.
- **`migrate`** → Stop and tell the user to run the `graph-migrate` skill (invoke it the way
  your harness invokes skills) before any other workflow.
- **`graph`** → every stage rides graph-backed inputs and destinations. Step 1 scoping offers
  the recorded terms and rules from the Step 0 `context resolve`; Step 2.2 hands the explorer
  that resolved context; Step 2.4 routes accepted items to typed candidate kinds, not doc
  sections; the write-back (Step 2.5) and the coherence gate (Step 3) land and verify them
  through the graph. The interview mechanics — item cards, previews, accept / correct / skip,
  the emergent-area check — are the same at every stage.

Then read the hub's current state from the canonical graph. First derive the surface targets —
every part is deterministic, nothing is guessed: surface names come from the repo's specialist
agent files (`.claude/agents/<name>-agent.md` → surface `<name>`; CLAUDE.md's Surfaces section is
the fallback listing when no agent files exist), the project id is the one the hub-mode
declaration already echoed (its `hub-mode '<projectId>'` line), and each surface's node id
follows the structural convention of `scripts/structural-promotion.mjs`:
`apex:<projectId>:surface:<slug(name)>`, under the shared slug discipline (lowercase,
non-alphanumeric runs collapse to `-`, edges trimmed). Then resolve the current state — the
recorded terms and rules — with `steepy-formula context resolve --target <surface node id>...`,
naming every derived surface id: the resolver walks each surface up to the project root, so
project-anchored terms ride along, while a bare project-root target returns an empty context —
never target it on its own. The derived surface node ids are the `appliesTo` targets the
Step 2.5 write-back scopes its rules to. That resolved context (`context.json` +
`context.md`) is the run's only hub input: Step 1 scopes against it, and Step 2.2 hands it to
the explorer.

### Step 1 — Run scoping

Ask the user to scope the run: which surface(s) to enrich (default: all surfaces the Step 0
state read enumerated), whether to also include the cross-cutting knowledge this run, and
whether to add project-doc discovery (README / `docs/` / ADRs). The cross-cutting offer is the
graph-backed scopes: the recorded terms and the cross-surface rules the Step 0 `context resolve`
returned — no Markdown doc is offered, because none exists.

This keeps a run bounded and re-runnable one surface at a time.

If `.apex/inception/run.json` exists, its `schema` is
`steepy-inception-run/v2`, and its `status` is `complete` (with phase `complete`), also offer the
**inception source**: import decisions only if Step 2a verifies that completed delivery. Read only
that one file to check this, and never list `.apex/inception/`. This is a candidate offer, not a
verified source; do not load approval or document bodies here. Otherwise do not mention the
inception source; absent, active or blocked runs and an unsupported run format leave ordinary
discovery available with the user's selected scope. Never migrate or restart a run.

When the user chooses the inception source, run Step 2a right after this step, before Step 2. Its
window is the certified initialization revision: the gate accepts the graph only while its head is
still the revision `init`'s promotion created, so any promotion before the gate ends the source.

### Step 2 — Per-surface iterative loop

For each surface selected in Step 1, run this loop:

1. **Scope (interview → areas).** Propose candidate exploration areas drawn from the knowledge-area
   taxonomy — **Scope**, **Conventions**, **Anti-patterns**, **Testing** (area tags Step 2.4 maps
   to typed candidate kinds) — plus a couple of
   surface-type heuristics (e.g. a UI surface might add "component patterns"). The user picks which
   areas matter for this run, or adds their own.
2. **Explore.** Ensure `.apex/work/discovery/` exists (create it if absent), then set
   `[REPORT_FILE] = .apex/work/discovery/YYYY-MM-DD-<surface>.md`. If your harness provides a
   task/subagent tool, dispatch a fresh subagent per surface using
   `skills/discovery/explore-surface-prompt.md`; otherwise perform the exploration inline in a
   dedicated pass over the same inputs, and state the inline degradation in the run's report (Step 4).
   When you dispatch, always set `model: standard`
   explicitly (the explorer's floor tier), rising to `model: most-capable` for a large or subtle
   surface. Pass it the surface name/path, the areas picked in Step 2.1, `[REPORT_FILE]`, and the
   Step 0 resolved context (`context.json` + `context.md`) as `[HUB_CONTEXT]` — the recorded
   terms and rules relevant to this surface, with their node ids — and nothing else: no
   Markdown hub doc exists, and the explorer's only hub input is that resolved context.

   It reads the surface's code and nearby docs
   (README/`docs`/ADR), writes its full findings report — observed conventions, candidate
   anti-patterns, candidate glossary terms, and discovered doc files, each with `file:line`
   evidence and no invention — to `[REPORT_FILE]`, and returns only a terse status. This subagent is
   an **explorer, not a reviewer**: it only gathers raw material; it does not judge, decide, or write
   hub or code changes. Validate the four-field completion defined in
   `skills/discovery/explore-surface-prompt.md` → "Output Format", including the exact `[REPORT_FILE]`.
   For BLOCKED, read that report's blocker and stop before the interview. For DONE, before Step 2.3,
   read the report back from `[REPORT_FILE]` — the terse return status is not the report.
3. **Emergent-area check.** If the report flags important findings outside the areas scoped in Step
   2.1, present them to the user and ask whether to fold them into this run before drafting
   (optionally re-dispatch the explorer narrowly on just the new area).
4. **Seeded interview.** Walk the report area by area. The report lives in a file the user never
   saw — so before any acceptance prompt, print each item in a plain text message, immediately
   followed by its **write-back preview**: the exact text that would be written, and its
   destination. For the three item-card areas — Observed conventions, Candidate anti-patterns,
   Candidate glossary terms — print the item's full card (all 4 fields: Proposed doc text,
   Evidence, Occurrences, Why it matters). For **Discovered doc files** — which the explorer
   reports as `path → one-line purpose` (+ file:line), not a 4-field card — print that line
   instead, followed by its own preview: the `readme` note it would become. The interviewer routes
   each item to a destination; the explorer only tagged the item by area, never by destination,
   because only the interviewer sees every surface:
   - One of the typed candidate kinds Step 2.5 promotes — never a doc section:
     a glossary term → `term`; a convention or anti-pattern → `rule`, scoped `appliesTo` one
     surface node id derived in Step 0 — the candidates schema admits exactly one target per
     rule, so a pattern spanning several surfaces fans out into one rule candidate per surface
     it applies to (same statement, each with its own `appliesTo`), and a genuinely global
     pattern routes to `decision` or `readme` instead of a rule; a rationale worth recording →
     `decision`; a discovered doc or other out-of-graph note → `readme`. The preview shows the
     typed candidate exactly as it will land in the Step 2.5 candidates file.

   Decide **accept / correct / skip** on the preview, never on the card or line alone: the
   card/line explains the finding, but the preview is the actual text-plus-destination the user is
   approving. A **correction re-renders the corrected preview** before anything is written. Ask one
   question at a time, with numbered options and a recommendation; use your harness's question UI if
   it has one. Never present items as bare IDs (T1, T2, …) as option labels — the short option labels
   cannot hold a draft, and the user must read the content, not a label. On a re-run, surface only
   **new** or **drifted** items — compare against what is already recorded: the recorded terms
   and rules from the Step 0 `context resolve` — each rendered as a
   preview **diff** against the current state, so the same rule applies uniformly: the user always
   decides on the exact final text that lands in the hub, whether it's a fresh addition or a drift
   correction.
5. **Write-back.** The accepted item cards never edit anything directly: they become a typed
   candidates document — the closed schema of `scripts/formula/core/scenario-assembly.mjs`,
   whose wrapper is that schema's only interpreter (kinds `term`/`rule`/`decision`/`readme`;
   this prose maps nothing itself) — written to `.apex/work/discovery/YYYY-MM-DD-<surface>-candidates.json`
   as its `candidates` array:
   - glossary terms → `{kind:'term', term, definition}`
   - conventions / anti-patterns → `{kind:'rule', title, statement, concern, strength,
     appliesTo:<surface node id>}` — `strength` is `must`|`should`, picked with the user at
     acceptance; `appliesTo` carries exactly one surface node id derived in Step 0 — a
     cross-surface acceptance lands as one rule candidate per surface, as routed in Step 2.4
   - recorded rationales → `{kind:'decision', title, statement, context}` — all three text
     fields are required; a decision candidate alone has no upward edge, so the promotion
     preview reports it unreachable and apply blocks until the human anchors it (e.g. a
     `MOTIVATED_BY` edge from an existing rule)
   - `readme` notes (e.g. discovered-doc mentions) → `{kind:'readme', note}` — no graph
     operation: the note is reported out-of-graph and edited directly outside the graph,
     exactly as its preview said.

   Writes are **additive and diff-gated**: the scenario only adds typed candidates, the preview's
   typed diff shows exactly what lands, and every write is gated per item by the user in
   Step 2.4, not batched at the end. Never clobber recorded knowledge unseen.

   Then drive the CLI — never an inline graph mutation:

   ```bash
   steepy-formula promotion create --project <id> --candidates <file.json> [--proposer <name>] <scenario-id>
   steepy-formula promotion preview <scenario-id>
   ```

   Show the preview's typed diff to the user; then apply ONLY at the existing human gate —

   ```bash
   steepy-formula promotion apply <scenario-id>
   ```

   — run it without `--yes`: the CLI itself prompts, and a refusal is a valid outcome, not an
   error.

### Step 2a — Inception source (complete run only)

Run this step only when the user chose the inception source in Step 1. It runs right after Step 1
and before Step 2; the run then continues with Step 2 for the selected surfaces. It turns the
decisions of a completed inception run into typed graph candidates landed through one promotion
scenario. Read by exact path only: never list `.apex/inception/` or a directory under it. A stop
in this step ends only the inception source; Step 2, Step 3 and Step 4 still run.

1. **Verify before reading.** Before reading any source approval, document, summary, or report
   body, run:

   ```bash
   node <engine-root>/scripts/inception-state.mjs verify-complete --repo-root .
   ```

   Require exit 0 and JSON `ok: true` with `runId`, `completion`, `inputPaths`, `checks`, and
   `coverage`. The helper verifies transitive evidence and current application identity, including
   only exact certified init additions, before returning document paths. It also rejects a
   completion whose latest approval does not cover every registered decision document, naming that
   path. Then check the one-time window: `steepy-formula graph status` must report `head:` equal to
   `apex:<projectId>:revision:r1` — the certified initialization revision is still the only one.
   Only after both succeed may the coordinator or explorer read source bodies, and only the exact
   returned `inputPaths`. Do not traverse descriptor or approval refs, append raw evidence, infer
   summary/report paths, or choose an approval by recency. Stop this source if
   `.apex/inception/project/decision-register.md` is not among the returned `inputPaths`.

   On nonzero exit, `ok: false`, malformed output, missing fields, or a head past the
   initialization revision, stop only the inception source and report the returned reason
   (unsupported run format, tamper, application-drift, uncovered decision, graph changed since the
   certified init, or another verification failure). No source bodies are loaded and no source
   decisions are promoted. Never downgrade rejected source decisions into old design choices.
   Ordinary discovery remains available for the current code and surfaces already selected in
   Step 1; the per-surface interview and Steps 3–4 continue. Keep the complete run and all its
   evidence immutable: no reopen, repeat bootstrap, migration or restart. A refused source is not a
   request to widen the discovery scope.
2. **Explore.** Ensure `.apex/work/discovery/` exists (create it if absent), then set
   `[REPORT_FILE] = .apex/work/discovery/YYYY-MM-DD-inception.md`. If your harness provides a
   task/subagent tool, dispatch a fresh subagent using `skills/discovery/explore-inception-prompt.md`,
   and always set `model: standard` explicitly. Pass `[INPUT_PATHS]` = exactly the successful gate's
   `inputPaths` array, unchanged — no other run path. Also pass `[REPORT_FILE]` and, as
   `[HUB_CONTEXT]`, the Step 0 resolved context (`context.json` + `context.md`). Otherwise run the
   same prompt inline over the same inputs, and state the inline degradation in the run's report
   (Step 4). Validate the four-field completion defined in
   `skills/discovery/explore-inception-prompt.md` → "Output Format", including the exact
   `[REPORT_FILE]`. For BLOCKED, read that report's blocker and stop the inception source. For DONE,
   read the report back from `[REPORT_FILE]` before the interview.
3. **Walk the decision register.** The report holds one item card per `DR-n`, in register order.
   For each decision, print in a plain text message its card — Proposed doc text, Evidence (the
   local file and line; it is for the interview only), Verification status (from the verified summary's
   `coverage` entries), Promotion class — immediately followed by its write-back preview: the typed
   candidate exactly as it will land in the candidates file. Then run the same accept / correct /
   skip interview as Step 2.4: decide on the preview, a correction re-renders the preview, one
   question at a time. Never use bare IDs (DR-1, DR-2, …) as option labels: the user decides on the
   printed card and preview. A skip is a rejection: ask the user for its reason.
4. **Promotion rules.** Every decision in the register is approved: Step 2a.1 verified complete
   delivery, including its approval. Use only the verified summary for coverage and check outcomes; a red source gate
   permits none of these promotions.
   - Approved and verified (`verified`) → may land as a `rule` candidate scoped `appliesTo` one
     surface node id (one candidate per surface it applies to, as in Step 2.4), or as a `term`.
   - Approved but unverified (`unverified`) → lands as a `decision` candidate recording a design
     choice, never as a rule asserting an existing component.
   - A future flow (`future`) → lands as a `decision` candidate whose context marks the future
     flow, never as a rule, a spec, or a started task.
5. **Write-back, in one pass after the interview.** Unlike Step 2.5's per-surface scenarios, this
   source batches its write: promote nothing until every register decision is decided. Each preview
   is still accepted, corrected or skipped on its own, so every write stays gated by the user. An
   interview interrupted before the apply leaves the graph at its initialization revision, so the
   next run's gate still passes and the import starts again (discard a leftover
   `inception-<runId>` draft first with `steepy-formula promotion discard`). Then record the decision
   outcomes (item 6) and write every accepted candidate, verbatim as previewed, into one candidates
   file `.apex/work/discovery/YYYY-MM-DD-inception-candidates.json` (the Step 2.5 schema). Candidate
   text never names, cites, or links `.apex/inception/`; the Evidence stays in the interview. Drive
   the CLI once, with the deterministic scenario id `inception-<runId>`:

   ```bash
   steepy-formula promotion create --project <id> --candidates <file.json> [--proposer <name>] inception-<runId>
   steepy-formula promotion preview inception-<runId>
   steepy-formula promotion apply inception-<runId>
   ```

   Show the preview's typed diff and apply only at the human gate, without `--yes`, exactly as in
   Step 2.5 — a decision candidate needs its anchor before apply, and a refusal is a valid outcome.
6. **Decision outcomes.** Every register decision ends accepted (promoted) or rejected with a
   reason. Record the outcomes in `[REPORT_FILE]` under `## Decision outcomes`, one line per
   decision: `DR-n — accepted` or `DR-n — rejected: <reason>`. The import is one-time. Once the
   scenario applies, the graph head moves past the initialization revision, so a later run's gate
   refuses the source: report it and continue with ordinary discovery. If the apply was refused,
   nothing landed and the window stays open; the run's `[REPORT_FILE]` still lists every accepted
   decision under `## Decision outcomes`.

### Step 3 — Coherence gate

Run `steepy-formula graph validate` — the run is not done until the portable graph invariants and
the revision-chain replay come back clean — plus, when a promotion scenario was applied in
Step 2.5, one sanity `steepy-formula context resolve` of a representative path or target from the
work just promoted, confirming the resolver still answers. Any invariant violation or a failed
resolve is an incomplete run — fix and re-run until green.

### Step 4 — Report

Summarize, per surface: items added, items updated (drift), docs discovered, and any areas
skipped — so the user sees exactly what changed and that nothing was clobbered. If a re-run found
nothing new, report it as a no-op: no file changed.

When the run used the inception source, also report its decision outcomes from
`## Decision outcomes`: each decision accepted, with the candidate it landed as, or rejected with
its reason. If the inception source stopped, report why.

## Model Selection

Always set `model:` explicitly when dispatching the Explore subagent in Step 2.2 and the inception
explorer in Step 2a.2 — an omitted model inherits the expensive session model and defeats the tier
policy. Floor at `standard`; rise to `most-capable` for a large or subtle surface. The inception
explorer runs at `standard`. Translate the tier to a concrete model by judgment at
dispatch time using your harness's available models; `most-capable` is the ladder's top rung, not an
open-ended "best available", and a pricier model sitting above it is never reached from a tier.
Never hardcode a concrete model id in `explore-surface-prompt.md` or `explore-inception-prompt.md`.

This flow dispatches **no reviewer subagent**: every write is gated per item by
the human in the Step 2.4 seeded interview (Step 2a.3 for the inception source); the Step 3
coherence gate is the deterministic net. The Explore subagent dispatched
in Step 2.2 and the inception explorer dispatched in Step 2a.2 are explorers, not reviewers.
