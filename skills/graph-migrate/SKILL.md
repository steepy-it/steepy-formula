---
name: graph-migrate
description: Migrate a legacy Markdown Hub into the Stable Knowledge Graph — drive the G1 extraction, review the proposed graph in the native Explorer and the typed promotion diff, obtain explicit full or curated approval, apply the migration as ONE transaction, validate the graph and resolver behavior, then archive the legacy Hub at cutover and remove the archive only after a validated signed export exists. Never re-implements core logic.
user-invocable: true
---

# graph-migrate

Migrate a legacy Markdown Hub into the Stable Knowledge Graph for this project: drive the G1
extraction, review the proposed graph in the native Explorer and the typed promotion diff, obtain
the human's explicit approval (full or curated), land the approved nodes and edges in ONE
transactional promotion, validate the resulting graph and resolver behavior, then close out the
legacy Hub with the archive-then-remove closure. The procedure below maps 1:1 to spec §13 steps
6–10.

> **Engine root:** this skill's base directory is `<engine-root>/skills/graph-migrate/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

The skill drives the shipped `steepy-formula` CLI plus the G1 migration engine the package ships.
Resolve the CLI as `node <engine-root>/scripts/formula/cli.mjs` (or the published `steepy-formula`
bin) and namespace every invocation `steepy-formula`. The G1 engine
(`scripts/formula/core/migrate-markdown.mjs`) has no CLI wrapper — the agent side drives its
`migrateMarkdown` port directly (the seam is recorded in Step 6). This procedure is prose + gates,
it never re-implements core logic. All paths resolve relative to the repo root the human selected
(default: the current working directory). Read the routing table in `.apex/_INDEX.md` when the
procedure says so.

## Procedure

### Step 6 — Run the G1 extraction and inspect the proposed graph

Drive the G1 engine agent-side through its `migrateMarkdown` port — the agent-side seam:

```js
migrateMarkdown(port, { hubDir, projectId, rootDir, scenarioId })
```

`hubDir` is the legacy hub directory (default: the repo root, whose `.apex/` IS the legacy hub),
`projectId` is the database project the graph lives in, and `scenarioId` defaults to
`migration-<projectId>`. The call writes the D4 Promotion Scenario and returns the scenario id,
the full typed operation list, and the extraction candidates with `file:line` provenance. Record
the scenario id — it filters the Explorer below. The CLI ships no migrate command; this is the
only seam, and it is agent-side by design.

Then inspect the proposed graph two ways, both required:

1. **The native Explorer** — open the harness's Explorer for the project and filter it by the
   recorded scenario id, so the human sees exactly the proposed state.
2. **The typed textual diff** — drive the shipped CLI:

```bash
steepy-formula promotion preview --project <project-id> <scenario-id>
```

The typed diff report IS the preview. Show it to the human. Exit 20 = PROMOTION_STALE (the base
revision has moved) — recreate the scenario via Step 6 before reviewing; never review a stale
preview as current. Exit 4 = scenario not found — re-run the extraction. Only a green preview
proceeds to Step 7.

### Step 7 — Obtain explicit approval: full or selected

Approval is explicit, never assumed — silence never proceeds. Present the typed diff (and the
Explorer view) and ask directly, one question, with a clear yes/subset/no choice:

- **Yes (full)** → proceed to Step 8.
- **Curated subset** → the human names the operations to keep by their typed-diff identifiers.
  Express the subset exactly: `steepy-formula promotion discard --project <project-id>
  <scenario-id>`, then recreate the scenario agent-side via the same D4 `createScenario` path the
  G1 engine drives (`scripts/formula/core/promotion.mjs`) with exactly the selected operations,
  and return to Step 6 to preview the curated scenario. The scenario is never edited in place and
  never approved on a guess.
- **No** → `steepy-formula promotion discard --project <project-id> <scenario-id>` and stop;
  report that the migration was declined.

### Step 8 — Write the approved nodes and edges transactionally

Drive `promotion apply` WITHOUT `--yes`, so the CLI itself prompts on stdin and refuses (exit 21)
unless the human confirms:

```bash
steepy-formula promotion apply --project <project-id> <scenario-id>
```

The apply boundary IS the commit of the migration transaction — Step 7's approval plus the CLI's
own interactive confirmation double-gate it. The write is ONE transaction: the applied mutation
and its Revision are committed together, so an interruption leaves the graph untouched. Read the
report: the applied operations, the head revision, whether the scenario was consumed, and the
export outcome. Exit 22/23/20 mean the scenario is invalid/empty/stale — fix and re-run; the
graph is untouched.

### Step 9 — Validate the graph and resolver behavior

Before Step 10, run the success gates. First the graph invariants:

```bash
steepy-formula graph validate --project <project-id>
```

`verdict: clean` and `chain: clean` (exit 0) are required. Then resolve representative migrated
paths — one per migrated Surface — to prove the graph answers normal reads:

```bash
steepy-formula context resolve --project <project-id> --path <representative-path>...
```

Exit 0 emits `context.json` + `context.md` (schema-versioned). Exit 10 (unresolved), 11 (rule
conflict), 12 (overflow), or 1 (graph invalid) means the migration is incomplete — fix and
re-run. Only when `graph validate` and `context resolve` are both green may Step 10 begin.

### Step 10 — Archive the legacy Hub, then remove the archive (the closure)

The **no-dual-authority rule** closes step 10: there is no permanent compatibility layer in
which Markdown and the database can both mutate the same stable knowledge, and no permanent
read-only Markdown export remains. The closure ordering is fixed and the archive is removed only
after the recovery checkpoint exists and the repo's graph-mode disk artifacts are regenerated:

**archive → verify → export → validate the export → regenerate the graph-mode disk artifacts →
THEN remove the archive.**

1. **Archive** — at cutover the legacy Hub leaves normal reads: move the legacy hub (the repo's
   `.apex/`) to `.apex-legacy-archive/` at the repo root (the archive-location convention). Normal
   reads now resolve to the database only.
2. **Verify** — re-run Step 9's gates (`graph validate` + `context resolve` on representative
   paths) with the hub archived, proving the database is the single source of normal reads.
3. **Export** — write the recovery checkpoint, the signed export:

```bash
steepy-formula graph export --project <project-id> --out <file>
```

4. **Validate the export** — prove the artifact restores clean from a fresh import:

```bash
steepy-formula graph restore --project <project-id> --port memory --from <file>
```

The artifact is imported into a fresh in-memory port and re-validated (`graph validate` + chain
replay); exit 0 only when clean. A validated signed export now exists: the recovery checkpoint.
5. **Regenerate the graph-mode disk artifacts** — replace the steepy-apex disk artifacts with the
   graph-mode ones, rendered from the same graph-mode templates init's Step 4 uses (never the
   legacy templates — the regenerated set must be genuinely graph-mode, with no
   `.apex/standards/` pointers left behind):

   - **Stage the work area** — `.apex/work/` is in-flight local work, not hub content: stage it
     aside (e.g. `.apex-work-staging/`) before the archive move above — if it already moved into
     the archive with the hub, move `.apex-legacy-archive/work/` back out to the staging path —
     and restore it in the last bullet below.
   - **Bootstrap skill** — write `.claude/skills/<projectName>-bootstrap/SKILL.md` from
     `<engine-root>/templates/bootstrap-skill-graph.md` with every `{{projectName}}` replaced by
     the actual project name, replacing the existing file (the steepy-apex `<project>-bootstrap`
     name collision is handled by overwrite-in-place).
   - **Surface agents** — write `.claude/agents/<surface>-agent.md` from
     `<engine-root>/templates/surface-agent-graph.md` per migrated Surface (substituting
     `{{name}}` and `{{path}}`), replacing steepy-apex agent files that are now superseded. The
     graph-mode template points each agent at `steepy-formula context resolve --path <path>`, not
     at `.apex/standards/`.
   - **CLAUDE.md** — upsert the managed steepy block in graph mode:

     ```bash
     node <engine-root>/scripts/render-claude-md.mjs --hub <repo-root> --project <projectName> --upsert --mode graph
     ```

   - **Remove the superseded bootstrap skill** — delete the old
     `.claude/skills/steepy-apex-bootstrap/` directory if present.
   - **Restore the work area** — re-create `.apex/work/specs/` and `.apex/work/plans/` plus
     `.apex/work/.gitignore` (exactly `*` then `!.gitignore`) from the staged copy, or fresh per
     init's Step 4 shape when nothing was staged.

   Any failure in this sub-step keeps the archive in place (the same fallback rule as the rest of
   the closure) and the human is told why.
6. **Then remove the archive** — delete `.apex-legacy-archive/` ONLY now. If any gate in this
   closure fails, the archive stays in place (it is the fallback) and the human is told why.

When the closure completes, report the head revision, the applied operations count, the validated
export path, the regenerated disk artifacts, and that the archive was removed.
