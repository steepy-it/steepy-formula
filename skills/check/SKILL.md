---
name: check
description: Run `steepy-formula graph validate` on the canonical Stable Knowledge Graph and report any violations.
user-invocable: true
---

# check

Declare the repo's hub mode, validate the canonical Stable Knowledge Graph from the repo root,
and report any violations.

> **Engine root:** this skill's base directory is `<engine-root>/skills/check/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

## Procedure

1. **Declare the hub mode first.** Run `steepy-formula hub-mode` and quote its `mode:` line —
   `graph`, `migrate`, or `none`, each printed with one `evidence:` line. The command always
   exits 0: it is a declaration, not a gate, and this prose never re-implements its detection —
   the command is the single authority. The declared mode picks the gate:

   | Declared mode | Coherence gate |
   |---------------|----------------|
   | `graph` | `steepy-formula graph validate` (step 2) |
   | `migrate` | Stop and tell the user to run the `graph-migrate` skill (invoke it the way your harness invokes skills) before any other workflow. |
   | `none` | No hub — nothing to validate. Tell the user to run the `init` skill (invoke it the way your harness invokes skills) to create one, instead of reporting a coherent hub. |

2. **Validate the graph**

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
   - If the user asked about a specific area, optionally spot-check the resolver too —
     target-based: `steepy-formula context resolve --target apex:<projectId>:surface:<slug(name)>`
     should still answer for the area's owning surface (surface names from
     `.claude/agents/<name>-agent.md`, with CLAUDE.md's Surfaces section as the fallback
     listing; the project id from the hub-mode declaration's `hub-mode '<projectId>'` echo;
     `slug(name)` lowercase with non-alphanumeric runs collapsed to `-`).
     `steepy-formula context resolve --path <p>` answers only where a topology bridge exists
     (e.g. a hub migrated through `graph-migrate`); on a freshly graph-first-initialized repo
     it exits 10 UNRESOLVED — expected, not a violation.

3. **Report** — name the declared hub mode, confirm `steepy-formula graph validate` ran, and whether it is green.
