# Release evidence reference

[Release checklist](../RELEASE.md)

Publication requires schema 2 evidence for candidate preflight and four launch host/OS combinations: Claude Code on macOS and Linux, and Codex on macOS and Linux. Node 24 is required; Windows is unsupported. OpenCode, Pi, and DeepSeek Harness remain experimental and cannot substitute for launch rows. No public npm or store availability is established by this document.

## Publication verification

The release workflow installs the pinned dependency from the lockfile, runs Node 24 tests, version/manifest checks and package validation. The `--product-only` metadata preflight does not consume native evidence. The graph coherence gate (`steepy-formula graph validate`) needs a local engine, so it stays a release-time preflight. Before any publication remote mutation, the coordinator requires the default schema-2 gate:

```bash
node scripts/validate-release-evidence.mjs
```

It reads `docs/native-test-evidence.json` and checks referenced redacted artifacts in `docs/native-test-evidence.md`; it never launches a native harness or provider. Existing prerelease evidence remains historical until real candidate observations replace it. Missing, failed, skipped, NOT RUN, pending, stale or mismatched observations keep publication closed. Synthetic fixtures and descriptor-nonce canaries cannot replace skill-driven native acceptance. The schema validates documented records; it does not prove a provider ran. Reviewers must independently establish provenance.

The closed document contains exactly `schemaVersion: 2` and `records`. Exactly five record IDs are required:

| Record | Current launch acceptance |
|---|---|
| `candidate-preflight` | NOT RUN |
| `claude-code/macos` | NOT RUN |
| `claude-code/linux` | NOT RUN |
| `codex/macos` | NOT RUN |
| `codex/linux` | NOT RUN |

Each record contains `id`, `sourceRevision` (full reachable commit SHA), `payloadSha256`, `productVersion`, `host`, `observedAt` (YYYY-MM-DD), `installation`, `checks`, `artifact`, and `result: PASS`. Host records additionally require `skills` containing exactly all eleven names: `inception`, `init`, `check`, `new-surface`, `discovery`, `brainstorm`, `plan`, `implement`, `review`, `loop-engineer`, `graph-migrate`. `host` has exactly `name`, `version` (observed semver), `platform` (`macos` or `linux`), `architecture` (observed identifier), and `profile`. These observations make no minimum harness version or architecture support promise. `installation` has `method`, complete `composition`, `clean: true`, and `installedReleaseDisabled: true`. Disable older installed releases and load the exact candidate in an isolated profile.

Every check contains exactly `capability`, `command`, `result: PASS`, a distinct nonblank case-specific `observation`, `humanApprovals`, and nonblank `degradation` describing actual capability degradation (or its observed absence). Never infer success from file presence or a test-suite result. Human approvals are attributed objects with `kind: human`, `approver`, and the actual verbatim `response`; model approval or absence placeholders do not count. The human-gated capabilities are `init-bootstrap`, `discovery-context-coherence`, `brainstorm-plan-implement-review`, `inception-a`, `inception-b`, `approval-interruption`, and `complete-init-discovery`. Other checks may use an empty approval array when no human gate applies. Keep separate observations for full-chain workflow behavior and every inception/recovery case.

Candidate-preflight requires exactly `manifest-version-lockstep`, `version-transaction-complete`, `npm-package-composition`, and `hub-coherence`.

Every one of the four host records requires exactly this capability inventory:

- `clean-install-load`
- `eleven-skill-discovery`
- `skill-invocation`
- `init-bootstrap`
- `specialist-behavior-dispatch`
- `discovery-context-coherence`
- `brainstorm-plan-implement-review`
- `inception-a`
- `inception-b`
- `reconnaissance-architecture-interruption`
- `research-child-interruption`
- `approval-interruption`
- `bootstrap-intent-outcome-interruption`
- `verification-capture-interruption`
- `complete-closing-note-interruption`
- `required-check-fails`
- `manual-confirmation-missing`
- `application-fix-verification`
- `unchanged-verification-resume`
- `complete-init-discovery`
- `application-drift-after-complete-init`
- `final-abandon-interrupted`
- `publication-before-staging`
- `publication-after-staging`
- `publication-ordered-target-prefixes`
- `publication-final-descriptor-replacement`
- `publication-foreign-divergent-targets`
- `v1-descriptor-refusal-all-commands`
- `collector-zero-red-command`
- `versioned-copy-validation`

For required observations and execution procedures see [native inception acceptance](inception-acceptance.md). Run real skills, record exact refs, application differences, check IDs, human responses and degradations. Validate a clean copy of only versioned files after each completed scenario, without local inception/work state. A descriptor nonce response proves only that slice, never the full chain, plugin installation or native specialist behavior.

The artifact object contains exactly `path: docs/native-test-evidence.md`, `sha256` (SHA-256 of the actual UTF-8 artifact bytes), and `redacted: true`. Record full source/payload/version, observed host environment and exact installation composition in the artifact as well as JSON; redact before computing its digest. All five records bind one source revision and one payload. Evidence must not be future-dated and expires after 30 days.

## Optional historical audit

Only `node scripts/validate-release-evidence.mjs --legacy-audit` allows schema 1 historical audit validation; it does not block publication, replace schema 2, or authorize any remote publication. Schema 1 requires the historical six IDs `plugin-preflight`, `claude-code`, `codex`, `opencode`, `pi`, and `deepseek-harness`. Its older capability inventory includes `native-specialist-dispatch` for Codex. Retain dated OpenCode, Pi and DeepSeek Harness observations as history rather than current launch proof.

Commands and the referenced UTF-8 artifact must not carry an unredacted credential in the
validator's bounded supported forms: credential assignments, `--api-key`/`--token`/
`--secret`/`--password` flags, Authorization Bearer/Basic values, credential-named headers,
or Cookie/Set-Cookie values. A captured value in those forms must be exactly `<redacted>`,
`[redacted]`, or `REDACTED`; the `artifact.redacted` flag and digest do not substitute for that
check. This deliberately is not a general secret scanner or proof that arbitrary text is
secret-free. Evidence authors and reviewers remain responsible for complete human redaction before
committing the bounded evidence files.

All five schema-2 records must name one canonical source revision. The validator requires that commit to
be available and reachable from the current checkout, materializes its package projection from
committed tree paths, modes, and blob bytes (not archive output), and compares the current and
source product inputs by exact canonical path, mode, and bytes. Only
the three evidence-only paths below may differ, so this check establishes a source/product binding
without treating arbitrary documentation changes as evidence-only. It validates the recorded
provenance but still does not prove a provider actually ran.

The optional schema-1 historical capability IDs are:

- `plugin-preflight`: `manifest-version-lockstep`, `version-transaction-complete`,
  `npm-package-composition`, `hub-coherence`.
- Claude Code and OpenCode: `plugin-install-load`, `skill-discovery`, `skill-invocation`,
  `generated-project-bootstrap`, `scaffold-check-workflow`,
  `native-specialist-behavior`.
- Codex: the same first five checks plus `native-specialist-dispatch`.
- Pi: `package-extension-load`, `skill-invocation`, `session-transitions`.
- DeepSeek Harness: `plugin-load`, `commands`, `model-callable-skill-tool`,
  `bootstrap-lifecycle`.

`payloadSha256` hashes a domain marker plus every `npm pack` product input's canonical
path, file mode, and exact bytes in sorted order. Only `docs/native-test-evidence.json`,
`docs/native-test-evidence.md`, and `docs/release-audit-remediation.md` are excluded; no
documentation directory or path family is excluded. Consequently an evidence-only commit can
bind the already-tested product without claiming new product bytes were exercised, while any
other shipped change invalidates the evidence. All three manifests must carry the same
canonical safe-integer X.Y.Z version, the matching changelog heading must exist, and an
incomplete version transaction refuses the gate.

All external Actions are immutable pins verified against the official upstream on
2026-09-15: checkout v7.0.1 is documented at
https://github.com/actions/checkout/releases/tag/v7.0.1 and setup-node's pinned commit is
https://github.com/actions/setup-node/commit/820762786026740c76f36085b0efc47a31fe5020 .
