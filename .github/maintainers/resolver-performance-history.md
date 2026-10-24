# Historical resolver performance rationale

Archived development target and measurement scope; current limitations are described in [architecture](../../docs/architecture.md#resolver-performance).

## Follow-ups (tracked debt)

- **Scoped/cached resolver read path (spec §16 acceptance target, `<1 s` warm resolveContext).**
  Adjudicated 2026-08-18: the current D2 resolver reads the whole graph per call over Bolt, and the
  full E1 fixture (150,000 edges) measures a warm median of 1671–1968 ms — the `< 1 s` spec target is
  NOT met. The E4 envelope suite asserts a generous 5 s regression ceiling
  (`tests/formula-envelope.test.mjs`, `TARGET_WARM_RESOLVE_MS`) while the measured number stays
  recorded there and in the ledger; this follow-up owns a scoped/cached read path so the acceptance
  target can be genuinely met. The spec §16 targets remain acceptance targets, never a met claim.
