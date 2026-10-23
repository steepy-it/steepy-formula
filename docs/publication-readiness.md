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
   When publishing from a new repository, transfer only the reviewed public history;
   keep private backups outside the checkout and never mirror old refs into the new repository.
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

The release workflow can create a missing release automatically after a successful push
to `main`. If publication must wait, establish the matching draft and tag before triggering
that push, or keep Actions disabled until the release state is ready.

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
