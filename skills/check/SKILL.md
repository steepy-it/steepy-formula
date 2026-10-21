---
name: check
description: Run the coherence gate for the hub mode declared by `steepy-formula hub-mode` — `steepy-formula graph validate` on the canonical Stable Knowledge Graph in graph mode, the validate-hub linter on the Markdown hub in legacy mode — and report any violations.
user-invocable: true
---

# check

Declare the repo's hub mode, run that mode's coherence gate from the repo root, and report any
violations.

> **Engine root:** this skill's base directory is `<engine-root>/skills/check/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Procedure

1. **Declare the hub mode first.** Run `steepy-formula hub-mode` and quote its `mode:` line —
   `graph`, `legacy`, or `none`, each printed with one `evidence:` line. The command always
   exits 0: it is a declaration, not a gate, and this prose never re-implements its detection —
   the command is the single authority. The declared mode picks the gate:

   | Declared mode | Coherence gate |
   |---------------|----------------|
   | `graph` | `steepy-formula graph validate` (step 2) |
   | `legacy` | `node <engine-root>/scripts/validate-hub.mjs .` (step 3) |
   | `none` | No hub on either channel — nothing to validate. Tell the user to run the `init` skill (invoke it the way your harness invokes skills) to create one, instead of reporting a coherent hub. |

2. **Graph mode** — validate the canonical graph:

   First run the model-mapping freshness verifier (before the coherence gate):

   ```bash
   node <engine-root>/scripts/verify-model-mappings.mjs
   ```

   - Include the per-row verdicts (`OK | STALE | UNKNOWN`) in the check report.
   - `STALE` means the live source shows drift: a human-ratified table patch is needed — the
     script prints the prepared patch, so surface it in the report as a finding for a human
     to ratify and apply.
   - `UNKNOWN` is informational (source unreachable — offline degradation): report it as
     declared, never as a failure.

   Then validate the canonical graph:

   ```bash
   steepy-formula graph validate
   ```

   - Exit 0 (`violations: 0`, chain `clean`): report that the canonical graph is coherent —
     the portable graph invariants and the revision-chain replay both came back clean.
   - Exit non-zero: list each printed `[CODE] message` violation clearly and suggest how to
     fix it (broken structural invariants, nodes unreachable from the Project root, replay
     findings such as out-of-band writes).
   - **Never fall back to `validate-hub.mjs` in graph mode.** After graph-first init, `.apex/`
     holds only the `work/` area and no Markdown hub, so the legacy linter's silence would be
     a false green — the graph gate above is the only evidence that counts.
   - If the user asked about a specific area, optionally spot-check the resolver too —
     target-based: `steepy-formula context resolve --target apex:<projectId>:surface:<slug(name)>`
     should still answer for the area's owning surface (surface names from
     `.claude/agents/<name>-agent.md`, with CLAUDE.md's Surfaces section as the fallback
     listing; the project id from the hub-mode declaration's `hub-mode '<projectId>'` echo;
     `slug(name)` lowercase with non-alphanumeric runs collapsed to `-`).
     `steepy-formula context resolve --path <p>` answers only where a topology bridge exists
     (e.g. a hub migrated through `graph-migrate`); on a freshly graph-first-initialized repo
     it exits 10 UNRESOLVED — expected, not a violation.

3. **Legacy mode** — run the hub linter, exactly as today:

   First run the model-mapping freshness verifier (before the coherence gate):

   ```bash
   node <engine-root>/scripts/verify-model-mappings.mjs
   ```

   - Include the per-row verdicts (`OK | STALE | UNKNOWN`) in the check report.
   - `STALE` means the live source shows drift: a human-ratified table patch is needed — the
     script prints the prepared patch, so surface it in the report as a finding for a human
     to ratify and apply.
   - `UNKNOWN` is informational (source unreachable — offline degradation): report it as
     declared, never as a failure.

   Then run the hub linter:

   ```bash
   node <engine-root>/scripts/validate-hub.mjs .
   ```

   - If the output is `steepy validate-hub: OK`, report that the doc graph is coherent.
   - If there are violations, list each one clearly and suggest how to fix it (broken links, orphan docs not linked from `_INDEX.md`, agents not referenced in the routing table).

4. **Report** — name the declared hub mode, which gate ran, and whether it is green.
