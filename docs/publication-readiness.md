# Publication checklist

Use this checklist alongside [RELEASE.md](../RELEASE.md). It describes the procedure for
publishing a release to a public channel; the CI run and GitHub settings on the final commit
establish current status. The Release workflow produces the GitHub release line (tag, GitHub
Release, and the `claude-directory` payload commit); npm publication, marketplace submissions,
and optional schema-1 historical audit are separate steps. Required schema-2 launch evidence gates publication remote mutation.

## Before publishing

1. Review the final source tree, packaged files, asset provenance, and public documentation.
   Exclude local workflow artifacts (`.formula/work/`, `.formula/inception/`), credentials
   (`.formula/secrets.json`), graph exports or backups, personal paths, and internal material.
2. Review the GitHub repository as well as Git history: pull requests, their Git refs,
   comments, old commits, releases, Actions logs, and artifacts may retain earlier content.
   Squashing `main` and deleting branches or tags does not remove that material.
   Any proposed replacement or history cleanup requires a separately reviewed plan and authorization;
   preserve history and verify a private backup before any destructive proposal is executed.
3. Keep a verified private backup before destructive cleanup or repository replacement.
4. Commit the final payload and pass the release preflight on that exact commit.
   Inspect an actual tarball and install it in a fresh directory, including the pinned
   `neo4j-driver` dependency.
5. Confirm native smoke tests for the supported installation paths and refresh the
   [live-canary matrix](../RELEASE.md#multi-harness-live-canary-evidence-matrix-mandatory) for the
   harnesses the change affects; graph-first `init` needs Docker on the test host. Pi and DeepSeek
   do not have Steepy deterministic runners.
6. Verify that `main` and the release tag `vX.Y.Z` resolve to the approved commit. For an
   existing draft, explicitly verify both its `tag_name` and its target; update the notes from
   the changelog.

## Repository settings and publication

Prepare these settings before publishing and apply them as soon as the repository plan permits
them. Some GitHub plans provide branch protection only on public repositories.

- Protect `main` against deletion and force pushes, and require pull requests.
- Require the actual check names emitted by the workflows: `validation / test (24)`,
  `validation / package`, and `version-gate`. The version check runs on pull requests; the
  release workflow's `publish` job is not a pull-request check. Earlier releases ran the suite as
  a plain `test (24)` job, so a ruleset that still names it must be updated.
- Enable private vulnerability reporting and verify the route advertised in
  [SECURITY.md](../SECURITY.md), including the maintainer's email fallback.
- Keep the `claude-directory` branch append-only: never force-push it or delete it.

The release workflow can create a missing release after a successful push to `main`. Keep automatic publication gated throughout preparation. An existing draft/tag is not a publication lock: reconciliation remains explicit. Any workflow/settings change requires separate authorization.

## Verify without repository credentials

Use a fresh environment without stored GitHub credentials to check:

- Repository, README, license, privacy policy, documentation, image, and release URLs.
- HTTPS clone and download of the published tag; compare the resulting commit identity.
- Package installation from GitHub and presence of skills, templates, scripts, and manifests.
- The documented native installation and first-run paths for the harnesses being announced,
  including a graph-first `init` against a freshly provisioned local engine.

A local tarball install validates packaging, not anonymous GitHub access or native host
behavior. Record those checks separately. See [installation](installation.md) for commands
and [the release checklist](../RELEASE.md#public-distribution-checklist) for later channels.


## Launch evidence gate

Claude Code and Codex on macOS and Linux are the supported launch combinations with Node 24. Windows is unsupported. Packed OpenCode, Pi and DeepSeek Harness integrations remain experimental. Run the exact candidate through all four clean host/OS installations and the complete [schema-2 capability inventory](release-evidence.md), including real skill-driven full-chain and inception A/B/recovery flows, human approvals, degradation records and clean versioned-copy validation. Every unobserved case remains NOT RUN in the [acceptance matrix](inception-acceptance.md#four-combination-launch-matrix). Preserve prior dated observations as history. Existing prerelease evidence files remain unchanged until actual acceptance supplies observations.

Before any remote tag, release or directory mutation, `node scripts/validate-release-evidence.mjs` must accept source/payload/version-bound schema 2 with fresh redacted artifacts and independently reviewed provenance. `--product-only`, synthetic fixtures, descriptor-nonce responses and optional `--legacy-audit` cannot authorize publication. The coordinator checks current remote main and exact existing identities at each stage, serializes publication and reobserves uncertain outcomes on retry. A same-version directory payload must match exact source identity and bytes; never treat a version match alone as success. No npm or store availability is established until that channel is observed.

## Initial public launch execution order

Follow the self-contained [G1–G4 procedures](../RELEASE.md#ordered-maintainer-launch-gates) in order. The [audit](release-audit-remediation.md) is bounded evidence, not certification.

1. **G1:** Obtain approval of the concrete candidate commit/version after review; commit only with explicit authorization. Run the full `npm test` suite on Node 24 macOS/Linux and complete Docker-backed integration, graph replay, package/install/plugin validation and real Claude Code/Codex full-chain and inception cases. Only then update `docs/native-test-evidence.md` and schema-2 `docs/native-test-evidence.json` with actual observations, digests and reviewed redacted provenance. Missing access is NOT RUN. Evidence/audit-only follow-ups limited to `docs/native-test-evidence.md`, `docs/native-test-evidence.json`, and `docs/release-audit-remediation.md` may preserve source identity; every other shipped path/byte/mode change requires newly frozen affected acceptance.
2. **G2:** Close every unresolved audit surface and review each heuristic finding in private context. Confirm rights for assets and inherited material, rotate/revoke any real exposed credentials with separate authorization, and verify protection/reporting/contact. Preserve history; destructive proposals require separate review and a verified private backup with restore verification, access controls and retained ref/object inventory.
3. **G3:** Present exact old/new peeled `v1.0.0` commits and filtered directory path/mode/byte identities for explicit approval. Deliberately reconcile pre-public same-version divergence through a reviewed corrective append to `claude-directory`, never a force push. Already-public changed product bytes require a new approved version. Reobserve main eligibility, evidence and identities at every action and after interruptions. Verify remote peeled tag equals approved candidate, nondraft release tag binding, and exact directory identity; identical retries are no-ops and a matching tag without a release is recoverable. A green workflow alone is insufficient.
4. **G4:** After separate authorization for visibility/publication, verify anonymous repository/docs/license/release access and clean installation from the actual public source on all four supported host/OS combinations. Record redacted observed identities and install results. Complete transition protection immediately after visibility change and before announcement. No npm/store submission or availability claim follows from GitHub publication.

### Protection transition procedure requiring later authorization

Verify repository permissions and plan capabilities directly. Require PRs and the observed `validation / test (24)`, `validation / package`, and `version-gate` checks; block force pushes and branch deletion, review bypass actors, and verify settings via fresh GETs plus check emission on the candidate PR. Preserve append-only directory history. The [readiness status](release-audit-remediation.md) records the latest observations.

If the actual repository capability demonstrably prevents these settings while private, record the provider response and obtain approval of the exact visibility transition: hold publication/announcement, change visibility only when authorized, immediately configure and verify force/deletion restrictions and required PR/check rules on main, verify private vulnerability reporting and the advertised contact route, then perform anonymous G4 checks before announcement. Failure or inaccessible settings leaves launch blocked. Record each applied setting and its verification result.
