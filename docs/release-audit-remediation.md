# Release readiness status

Maintainer status for the 1.0.0 candidate, observed on 2026-10-24. This record separates repository preparation from native acceptance and public availability. Follow the [release gates](../RELEASE.md#ordered-maintainer-launch-gates) before announcing a release.

## Repository preparation

- Main requires pull requests and the `validation / test (24)`, `validation / package` and `version-gate` checks. Force pushes and deletion are disabled, including for administrators. Independent approving reviews are not required.
- The Claude directory branch is append-only, with force pushes and deletion disabled.
- The current committed main, 1.0.0 tag and GitHub Release were reconciled. The directory payload was verified against that source, including all 151 paths, bytes and modes. Any subsequent shipped edit requires a fresh candidate and directory verification.
- A private Git backup passed bundle verification and a restore check.
- The dependency audit reported no known runtime vulnerabilities. Installed dependency packages include license files; asset rights and final attribution review still require maintainer confirmation.

## Remaining acceptance

| Gate | Status | Required action |
|---|---|---|
| Native acceptance | Not complete | Run all Claude Code/Codex cases on macOS and Linux and validate candidate-bound schema-2 evidence. |
| Audit review | Not complete | Confirm asset provenance, license obligations, security contact ownership and the disposition of redacted findings. Resolve inaccessible historical provider surfaces and review the final release logs. |
| Candidate identity | Recheck after edits | Verify main, tag, release and the exact filtered directory payload before publication. |
| Public availability | Not verified | After authorized visibility change, enable private vulnerability reporting and verify anonymous access and clean installation. |

The repository remains private. The vulnerability-reporting API returned 404 while private; enablement and the advertised reporting route must be verified after public visibility. No email delivery test or owner attestation is recorded here. Optional code-security and secret-scanning features were not enabled.

## Audit scope

The bounded audit examined reachable Git blobs, pull-request content, accessible Actions logs, release metadata and dependency metadata. Heuristic token matches included identifiers and test fixtures; no absence-of-secrets guarantee follows from those results. Historical inaccessible logs and other provider-retained content remain unresolved. Preserve redacted observations and obtain human review before closing this gate.

Maintainers retain the detailed dated observations separately from the npm and Claude directory packages. Those historical records do not certify current release acceptance.
