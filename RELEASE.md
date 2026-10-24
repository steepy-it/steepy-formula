# steepy-formula release checklist

Operational checklist for Claude Code community/public distribution, GitHub releases,
and distribution to OpenAI, OpenCode, Pi, and DeepSeek Harness.
Owner: `steepy-it`; repository: `steepy-it/steepy-formula`; plugin: `steepy-formula`.
Community marketplace install path after approval: `steepy-formula@claude-community`.

## Release requirements

1. Validate the final version and package with the commands below.
2. Run the smoke test in a throwaway repository, with Docker running: graph-first init gates on
   the local engine.
3. Complete the [native acceptance matrix](#multi-harness-live-canary-evidence-matrix-mandatory)
   for every supported host and operating system.
4. Follow the ordered G1–G4 gates below. A push or merge to `main` is not authorized by this checklist; keep automatic publication gated during preparation.

Detailed references:

- [Publication checklist](docs/publication-readiness.md).

- [Required launch evidence schema, capabilities and provenance](docs/release-evidence.md).

- The inception skill's native acceptance runs are a separate release gate, defined in
  [docs/inception-acceptance.md](docs/inception-acceptance.md).

## Installation

See the [installation guide](docs/installation.md) for all five harnesses, local and
GitHub installation, first-run commands, requirements, and troubleshooting.
The [README quick start](README.md#quick-start) shows the shortest path for each harness.

## Preflight

Run from the repository root after the version bump:

```sh
npm ci
npm test
node scripts/bump-version.mjs --check
npm pack --dry-run --json
node scripts/validate-release-evidence.mjs --product-only
claude plugin validate .
```

With the local engine available, `node scripts/formula/cli.mjs graph validate` must also exit 0
on this repository's own graph; CI cannot run that gate, so it stays a release-time check.

Inside Claude Code, `/plugin validate .` provides plugin validation.
Required publication verification: `node scripts/validate-release-evidence.mjs` reads `docs/native-test-evidence.json` and referenced artifacts
in `docs/native-test-evidence.md`. It checks recorded evidence; it does not run providers
or generate missing evidence. Schema 2 is mandatory before publication remote mutation; only `--legacy-audit` is optional historical verification.

## Smoke test

Use a fresh checkout and install the local marketplace:

```text
/plugin marketplace add /path/to/steepy-formula
/plugin install steepy-formula@steepy-formula
/reload-plugins
```

For direct development loading, use `claude --plugin-dir .` and `/reload-plugins`.
Confirm all eleven commands:

```text
/steepy-formula:inception
/steepy-formula:init
/steepy-formula:graph-migrate
/steepy-formula:new-surface
/steepy-formula:check
/steepy-formula:brainstorm
/steepy-formula:plan
/steepy-formula:implement
/steepy-formula:review
/steepy-formula:discovery
/steepy-formula:loop-engineer
```

### Throwaway repo validation

In an empty temporary repository with a working test command:

```bash
git init
printf '{"scripts":{"test":"node --test"}}\n' > package.json
```

**Precondition — engine before init.** Docker is running and the `steepy-formula` bin
resolves. Init is graph-first: its pre-flight gate provisions and verifies the local
engine before anything is written, and a failed engine gate must scaffold nothing.

Inside Claude Code:

```text
/steepy-formula:init
/steepy-formula:check
```

Expected evidence (graph-first — no markdown hub is ever written):

- `.formula/work/.gitignore` exists.
- `.formula/work/specs/` exists locally and is gitignored.
- `.formula/work/plans/` exists locally and is gitignored.
- No `.apex/` entry exists — init never writes under `.apex/`, and its absence is the
  expected shape: an `.apex/_INDEX.md`, `conventions.md`, `glossary.md`,
  `testing-and-checklist.md`, `standards/`, or any other `.apex/` entry is a failed init.
- No stable specs/plans indexes are generated.
- The managed `AGENTS.md`, the canonical bootstrap at `.agents/skills/<project>-bootstrap/SKILL.md`
  with its thin Claude stub, and the per-surface specialist adapters in `.claude/agents/`,
  `.codex/agents/`, and `.opencode/agents/` exist.
- `CLAUDE.md` exists and carries the graph navigation block — the rendered block
  names the `<project>-bootstrap` skill, `steepy-formula hub-mode`, and
  `steepy-formula context resolve --path <p>... | --target <id>...`, and points at
  the specialist agents in `.claude/agents/`.
- `steepy-formula graph validate` exits green.
- For each confirmed surface whose verification Rule was approved,
  `steepy-formula context resolve --target apex:<project-id>:surface:<name>` exits 0
  and the emitted `context.json` carries that surface's Check with its
  `ext_v1_command` test command. The target id needs no lookup — it is the
  deterministic init convention: the confirmed surface name, lowercased, with
  non-alphanumeric runs collapsed to `-` (the local form `--target surface:<name>`
  resolves too, qualified with the bound project). Do not use `--path` as the
  evidence command here: init's scenario is curated-only and never creates the
  topology→curated `IMPLEMENTS` bridge that path-based resolution rides.
- `/steepy-formula:check` reports green — it runs
  `steepy-formula graph validate`.

### GitHub marketplace smoke test

After publication, repeat using the GitHub marketplace:

```text
/plugin marketplace add steepy-it/steepy-formula
/plugin install steepy-formula@steepy-formula
/reload-plugins
```

Repeat the throwaway repo validation before announcing the release, and repeat the smoke test in
each supported harness.

## Multi-harness live-canary evidence matrix (mandatory)

Validate the supported launch combinations: Claude Code and Codex on macOS and Linux, using Node 24 and Docker. The [acceptance matrix](docs/inception-acceptance.md#four-combination-launch-matrix) lists every required case. An unobserved case remains `NOT RUN`.

For each combination, use an isolated profile and an empty fixture repository, then verify:

1. Install the packaged candidate through the host's native mechanism.
2. Start a fresh session and discover all eleven skills.
3. Run `init`, confirm the graph-first scaffold, and inspect generated bootstrap and specialist behavior.
4. Run discovery, context resolution, `steepy-formula graph validate`, and `check`.
5. Complete `brainstorm → plan → implement → review` on a toy change.
6. Observe native orchestration or its declared degradation.
7. Execute the inception and recovery cases in the acceptance protocol.
8. Record candidate identity, commands, outcomes, host/OS details and human approvals under the [evidence contract](docs/release-evidence.md).

OpenCode, Pi and DeepSeek Harness are experimental integrations. Their results do not replace a supported launch row. Local tarball installation does not prove npm publication or public marketplace availability.

The plugin ships no end-of-turn hooks. The coherence gate runs at `check` and `review` time.

Before testing model-tier dispatch, run `node <engine-root>/scripts/verify-model-mappings.mjs` against `adapters/model-mappings.mjs`. `OK` confirms the configured mapping, `STALE` requires a human-ratified update, and `UNKNOWN` is informational rather than proof of support.

## Versioning & release

Prepare version changes on the reviewed branch. The workflow creates new tags and releases only after validation and acceptance evidence pass. Existing tags and draft releases require explicit reconciliation.

**Semver policy.** PATCH = bugfix, MINOR = new feature, MAJOR = breaking change.
The shared `scripts/version-policy.mjs` implements the narrower canonical X.Y.Z policy:
three non-negative safe-integer components, no leading zeroes, prerelease or build suffixes.
Precedence is numeric, so `1.2.10` exceeds `1.2.9`; required bumps reject equality and
downgrades. A caller's `no-release` exemption waives the increment, never version validity
or downgrade protection.

**Bump at PR time.** The `review` skill proposes the bump type from the change (fix →
patch, feature → minor, breaking → major), the user confirms, then `node
scripts/bump-version.mjs <type>` updates `package.json`, `.claude-plugin/plugin.json`,
and `.codex-plugin/plugin.json` in three-way lockstep at completion, using one shared target.
A `## vX.Y.Z (YYYY-MM-DD)` section is added to `CHANGELOG.md`. Bump and
changelog land as one commit on the branch before the PR opens.

**Interrupted bumps.** The writer provides recoverable per-file atomicity, not a
multi-file atomic transaction. It holds the existing repository scaffold lease for cooperating
writers, validates all initial versions, and durably records exact before/after bytes and modes
in `.steepy-version-transaction.json` before staging the complete target set. Each manifest
is then published through an ordinary atomic rename and its directory is synced. Unrelated
formatting bytes and modes are preserved; unexpected bytes or mode edits block without overwrite.
Symlinked inner parents and non-ordinary or multi-link files are refused. This is not an
adversarial filesystem guarantee and requires working file/directory fsync and rename support.

While the journal exists, rerun the original command or its explicit recorded version to
finish the same target. Do not delete/edit the journal, reset the checkout, or select a different
bump kind to recover. Owned partial stages are accepted only as exact target-byte prefixes;
unexpected stage edits are retained and block. An explicit already-completed target is a
manifest-write-free no-op; a new patch/minor/major command after completion requests a new bump.
Run `node scripts/bump-version.mjs --check` before release validation: any remaining transaction
is incomplete even when all three version fields already match. A process crash before the
journal's atomic publication can leave an unreferenced temporary journal, but cannot publish
any manifest; it is not mistaken for a pending target or automatically removed as user data.

**PR gate.** The `Version gate` workflow (`.github/workflows/version-gate.yml`) uses the
shared numeric `scripts/version-policy.mjs` comparison. It fails invalid, equal, or
downgraded PR versions. A PR with no user-facing change (docs-only, CI-only) can carry the
`no-release` label, which skips only the increment requirement; canonical parsing and
downgrade rejection still apply.

**Candidate-bound publication at merge.** The `Release` workflow (`.github/workflows/release.yml`) runs on every
push to main, but can publish only after tests, version and package validation succeed
(the graph coherence gate needs a local engine, so it stays a release-time preflight).
If tag `vX.Y.Z` for the current version doesn't exist yet, it creates and pushes it. It then
creates the matching nondraft GitHub Release only after schema-2 evidence and candidate checks, with the body pulled from the matching
`CHANGELOG.md` section via `scripts/extract-changelog.mjs` (falls back to a stock
body if extraction fails). Last, it appends one Claude directory payload commit for a new
version to the `claude-directory` branch (see
[Claude directory submission](#claude-directory-submission)). The coordinator serializes runs, checks exact source/tag/release identity and remote main before each stage, and reobserves uncertain outcomes on retry. Existing directory versions are accepted only for an identical payload/source identity; mismatches fail closed.

**Direct pushes to main.** A repo-local PreToolUse hook (`.claude/settings.json` →
`scripts/push-version-guard.mjs`) blocks a `git push` on main for a known invalid version,
an unchanged version, or a numeric downgrade relative to `origin/main`, and asks whether to
bump patch/minor/major (default patch). Unrelated commands, other checked-out branches and
unavailable read/parse/Git context remain fail-open; known malformed version values do not.

**Tag naming.** `vX.Y.Z` (e.g. `v1.0.0`), matching the current plugin version.

**Two PRs in flight.** If two PRs both bump to the same version, the `Version gate`
passes on both until the first one merges; the second then fails the gate against the
new main version and must re-bump before it can merge.

## Claude directory submission

The Claude plugin directory scans the whole plugin folder of the submitted branch, so submit
the payload branch `claude-directory`, never `main`. The Release workflow appends one commit
per new version, built by `scripts/publish-directory-branch.mjs` from the release commit minus
`tests/`, `.github/`, `.codex-plugin/` and `CLAUDE.md`. The branch is append-only and never
force-pushed. The script copies the release commit's subject through `git log`, so on any host
that runs it, leave `i18n.logOutputEncoding` and `i18n.commitEncoding` unset or set to UTF-8.

Before submitting, run:

```bash
npm ci
npm test
claude plugin validate .
```

Submit through the developer portal:

1. Open `claude.ai/directory/manage` → **Submit new** → **Plugin bundle**.
2. Choose repository `steepy-it/steepy-formula` and branch `claude-directory`.
3. Press **Validate**, then **Submit for review**.

The listing icon is fixed at the first save or submit. Later versions reach the directory
through **Check for new commits** or the push webhook.

The Listing tab is read once, from the version the submission was created at. Later versions
update only the display name and short description. Links (`homepage`, `documentationUrl`,
`supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`) and `keywords` must already be in
`.claude-plugin/plugin.json` when you create the submission.

## Public distribution checklist

Recheck the linked provider instructions before submission. The GitHub workflow creates tags and GitHub Releases and appends the Claude
directory payload commit to `claude-directory`; it still does not publish to npm or submit to
any plugin directory. Store approval is separate from technical validation.

### Shared release preparation

- [ ] Finish the documentation before testing the final payload.
- [ ] Review Git history and tracked release contents before publishing to a new channel.
- [ ] Configure main-branch protection/rulesets with the actual CI and version-gate check names.
- [ ] Run preflight above on the exact candidate. The supported CI runtime is Node 24 on Linux;
  native installation on macOS and Linux requires its four launch rows; Windows is unsupported.
- [ ] Refresh the live-canary matrix above for the harnesses the change affects. Schema-2 native evidence is required for publication; optional schema-1 historical audit is separate.
- [ ] Prepare listing copy, logo, support contact, starter prompts, and a short demo. Use
  [installation and support copy](docs/installation.md)
  as the starting point. Keep advanced runner limitations and the Docker requirement visible.
- [ ] Merge the reviewed candidate, wait for Release validation/publication, and confirm the tag
  resolves to the intended commit. Existing tags are not moved by the workflow.
- [ ] Repeat the documented public installation and replace future/placeholder installation copy
  only after that channel is actually available.

### Claude Code

1. Validate with `claude plugin validate .` and run the local marketplace smoke test above.
2. After the repository is public, test its own marketplace install from GitHub. This distribution
   path is independent of review by Anthropic.
3. Submit through the developer portal as described in
   [Claude directory submission](#claude-directory-submission), on branch `claude-directory`;
   record submission status.
4. After approval and catalog sync, test `steepy-formula@claude-community` before advertising it.
   The official curated marketplace is a separate channel; submission does not guarantee inclusion.

Source: [Claude marketplace discovery and submission](https://code.claude.com/docs/en/discover-plugins).

### OpenAI / Codex

The current OpenAI documentation describes a shared public plugin directory for ChatGPT and
Codex. A local/GitHub marketplace install is a development or workspace distribution path,
not public-directory approval. Steepy requires repository files, shell execution, Git,
Node 24, and Docker for the graph engine; do not advertise ordinary Chat compatibility without
verifying those capabilities.

1. Verify the publisher identity and the submitter's **Apps Management: Write** permission.
2. Prepare public website, support, privacy-policy and terms URLs, logo, descriptions, release
   notes, country availability, starter prompts, five positive and three negative test cases.
3. Choose **Skills only** in the submission portal. Package all required skills, scripts,
   templates, adapters, and assets; do not assume the portal executes npm installation.
4. The documented Claude archive import can convert `.claude-plugin/plugin.json`; alternatively
   use the supported OpenAI package layout. Inspect the imported manifest and test every referenced
   helper path in a clean environment. Recheck trust and host compatibility.
5. Resolve scan findings, test the imported candidate, submit for review, then complete the portal's
   publication step after approval. Re-test the installed directory version.

Sources: [OpenAI submission](https://developers.openai.com/plugins/deploy/submission),
[Claude plugin import](https://developers.openai.com/plugins/guides/submit-claude-plugin),
[local and public plugin distribution](https://learn.chatgpt.com/docs/build-plugins).

### npm, OpenCode, and Pi

1. Verify npm package-name availability and publisher ownership; configure the account's publishing
   authentication. Choose the final version before publication, which cannot be overwritten.
2. Review `npm pack --dry-run --json`, then test an actual tarball installed outside this checkout.
   Check that every relative skill/helper reference is present and that the pinned
   `neo4j-driver` dependency installs with the package. Add `pi-package` to the package
   keywords before publishing if Pi gallery discovery is desired; optionally add a demo image/video.
3. Publish the reviewed package with `npm publish --access public` using the authorized publisher.
   The existing GitHub workflow does not perform this step.
4. For OpenCode, test the published package in `opencode.json`'s `plugin` array, including skill
   discovery and scaffold/check. For Pi, test `pi install npm:steepy-formula` and the documented
   new/fork/resume/reload bootstrap transitions.
5. Verify the npm listing and Pi gallery entry, then update README instructions with the real
   published version. A Git-based Pi install remains an alternative to npm.

Sources: [OpenCode npm plugins](https://opencode.ai/docs/plugins/),
[Pi packages and gallery metadata](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md).

### DeepSeek Harness

Use the native Git or package installation route in the [installation guide](docs/installation.md#deepseek-harness) and verify skill discovery, graph-first initialization,
and the coherence check in the native host. A separate public
store submission route has not been established by this release audit. Do not promise a
store listing or deterministic Gear-3/4 support for this adapter.

## Rollback

If a release has an install or runtime problem:

1. Stop announcing the affected tag.
2. Open a GitHub issue with the failing command and observed output.
3. Revert the faulty commit or prepare a patch fix.
4. Ship the fix as a new PATCH release through the normal flow (see "Versioning &
   release" above): bump `patch` at PR time, merge, and satisfy the release evidence gate before the workflow publishes it.
5. Re-run the local and GitHub marketplace smoke tests before updating release notes.


## Current launch acceptance status

Supported launch scope is Claude Code and Codex on macOS and Linux with Node 24. Windows is unsupported. OpenCode, Pi and DeepSeek Harness remain packed experimental integrations. The [four-combination matrix](docs/inception-acceptance.md#four-combination-launch-matrix) and [schema-2 inventory](docs/release-evidence.md) require every case on every host/OS. Candidate preflight and all four host rows remain NOT RUN until observed; no native acceptance or public channel availability is claimed here.

Default `node scripts/validate-release-evidence.mjs` requires current candidate-bound schema 2 before tag, GitHub Release or directory push. Product-only CI checks do not replace it. The coordinator rechecks source/payload, evidence, remote main and existing identities before remote stages. Recovery after an uncertain remote result must reobserve its identity before retrying; never move an existing tag or overwrite conflicting release/directory state. Optional `--legacy-audit` validates schema-1 history only. Preserve prerelease evidence files until actual native acceptance produces reviewed observations; never generate PASS from hermetic fixtures, nonce canaries or these instructions.

## Ordered maintainer launch gates

The [bounded publication audit](docs/release-audit-remediation.md) records observed state and unresolved launch gates. These gates govern the initial public launch and take precedence over general channel instructions above. Existing tag changes require approval of the exact old and new identities.

These are ordered maintainer execution gates, not automatically authorized remote tasks. Implementation completion and public-release completion are distinct. Each named gate remains open until its required observations pass. Do not mark the whole release objective complete while any mandatory observation is missing.

**G1 — Freeze candidate and record real acceptance.** After code review, select/approve the exact candidate commit and version; obtain explicit authorization for any needed commit. Run the full `npm test` suite and the mandatory integration and native acceptance below on Node 24 macOS and Linux. Follow the durable [inception acceptance procedure](docs/inception-acceptance.md) and [release evidence contract](docs/release-evidence.md). Use `node --test tests/formula-arcadedb.test.mjs tests/formula-bakeoff-veto.test.mjs` with functioning Docker, plus `node scripts/formula/cli.mjs graph validate`; require no skipped mandatory integration tests and violations 0/clean replay. Run `node scripts/bump-version.mjs --check`, `node scripts/validate-release-evidence.mjs --product-only`, actual npm pack/clean install and `claude plugin validate .`. Run real packaged Claude Code/Codex on both OSes: clean install/load, eleven-skill discovery/invocation, init/generated bootstrap/specialists, discovery/context/coherence and the full brainstorm→plan→implement→review chain. Execute inception A/B and every distinct recovery/verification scenario in [docs/inception-acceptance.md](docs/inception-acceptance.md) through the real skill, retaining actual human responses and declared host degradation. Record architecture, harness versions, exact candidate, observations and redacted provenance in `docs/native-test-evidence.md` and schema-2 `docs/native-test-evidence.json`, with digests; human review of provenance is mandatory. Missing credentials/Docker/host access is NOT RUN, never PASS. Exact evidence/audit-only follow-up commits limited to `docs/native-test-evidence.md`, `docs/native-test-evidence.json`, and `docs/release-audit-remediation.md` may retain source payload identity; every other shipped byte/mode/path change repeats affected acceptance against a newly frozen candidate, and all mandatory evidence must match it. Run `node scripts/validate-release-evidence.mjs` to validate the complete candidate-bound schema-2 release contract. Never ship synthetic fixtures as acceptance.

**G2 — Close publication/history prerequisites.** Complete the bounded candidate/reachable-history, historical tracked work, remote PR/ref/content, release asset and accessible Actions log/artifact audit defined in [docs/release-audit-remediation.md](docs/release-audit-remediation.md). Close every unresolved scope and finding through human provenance/license/security review and any necessary secret rotation/remediation. Verify the main protection/private reporting/contact configuration or the explicitly approved, capability-justified [visibility-transition procedure](docs/publication-readiness.md#protection-transition-procedure-requiring-later-authorization). Inaccessible surfaces remain explicit blockers. Settings edits and any remediation that changes Git state require separate authorization. Preserve history; any later destructive work requires its separately reviewed plan and verified private backup.

**G3 — Reconcile and publish exact identity.** After G1/G2 and explicit maintainer approval of concrete candidate/actions, reconcile the pre-public v1.0.0 tag/release/directory payload to the candidate. Present exact old/new peeled tag commits and directory identities; no general force/retarget policy, silent bump or force-pushed directory. Use explicit corrective append for divergent same-version pre-public directory history; if already public, changed product bytes require a new approved version. Observe current main eligibility and evidence at each action. Verify remote peeled tag equals approved candidate, nondraft release tag binding, and filtered Claude directory path/mode/byte payload identity after reconciliation. Same-candidate exact retries are no-ops; matching tag without release is recoverable. Recheck after interrupted actions before retry. Automatic main publication must remain gated throughout preparation; a successful workflow alone does not certify remote identity.

**G4 — Verify public availability.** Only after explicitly authorized visibility/publication, verify anonymous repository/docs/release access and clean installation from the actual public source for each supported harness/OS combination, preserving redacted observations. Apply and verify any visibility-transition protection before announcement. Local tarballs do not prove anonymous availability. Do not submit to npm/marketplaces or advertise their availability without separate authorization and observed successful publication. Update only `docs/native-test-evidence.md`, `docs/native-test-evidence.json`, and `docs/release-audit-remediation.md`; other shipped edits invalidate prior product identity and return to G1.
