# Bounded publication audit and remediation gates

Status: **unresolved launch gates; not public-launch certification**. Read-only observations on 2026-10-23 UTC. Source baseline `884176aa7b64ffa8cd0998f94c8aba640bb43a67`; this baseline is not approval of the final candidate. Audit completion and release completion are distinct.

## Scope and bounds

Local snapshot finished 2026-10-23T14:42:13.275076+00:00. `git for-each-ref`, `git rev-list --objects --all`, and `git cat-file -t/-s/blob` inspected every locally reachable blob from all local refs, including old branches, tags, origin refs, retained apex refs and the local checkpoint ref. This is a deliberately conservative superset of prospective public history, not authorization to publish all refs. 4,885 reachable objects, 2,484 scanned blobs, maximum 5 MiB per blob, zero oversized blobs skipped. One historical tracked work blob was scanned from Git objects solely as publication-history evidence. No current ignored work directories or credential stores were enumerated/read. Unreachable/dangling objects, reflogs, remote deleted refs and inaccessible provider retention are outside this bound and remain unreviewed.

The scan internally searched provider-token shapes, private-key headers, credential-like assignments and personal home paths. Findings below contain locations/classifications/counts only; matched values were never printed or retained in this report. Regex matches are triage, not proof of credentials or absence of secrets. Human context review, broader detector review and owner confirmation remain required.

Remote snapshot finished 2026-10-23T14:42:24.624800+00:00. Authenticated `gh api` GETs read repository/organization metadata, main protection, rulesets, private reporting, heads/tags, PRs, releases, Actions runs/jobs/log ZIPs and artifact inventory; `git ls-remote origin` read advertised refs including PR refs. Lists bounded to 100 entries/page (runs 30), PR files to three pages: 100 + 65 + 0. One PR, zero review/issue comments or reviews; its body, metadata and 165 file records were scanned. PR head `d2f4784281937d10e7bd1c55c2af50d0fa6b4b72` is locally reachable and covered by the blob scan. Provider-omitted/truncated patches and undisclosed/deleted PR content remain unreviewed; full reachable source blobs supplement patches. Eight total visible runs, all eight jobs/log archives retrieved; each decompressed entry capped at 5 MiB. No oversize or unread archive diagnostic occurred. Zero total artifacts; artifact download bound would be 20 MiB compressed and 5 MiB per entry. One visible nondraft v1.0.0 release, zero uploaded release assets; generated source archives were not separately downloaded/installed. No list overflow observed in these inventories. Historical expired/deleted logs/artifacts and hidden surfaces are unresolved, not certified absent.

## Remote identity and configuration

- Private repository; default branch `main`. Organization metadata exposes plan `team`; no inference of private-plan protection unavailability is justified.
- Remote main and lightweight v1.0.0: `18ca0def47e9e9db9b2cdf5b31e038cfa66c4f47`; directory: `e5013663861255c1ba29ab618c37b4d0c33590c5`; graph-only branch and PR head: `d2f4784281937d10e7bd1c55c2af50d0fa6b4b72`. Final candidate/tag/directory reconciliation remains G3.
- Main protection GET returned HTTP 404; rulesets GET returned an empty list. Protection cannot be certified; resolve missing configuration versus access limitations with an authorized administrator.
- Actual jobs emitted: `validation / test (24)`, `validation / package`, `version-gate`, and release-only `publish`. Require the first three on PRs; do not require `publish` as a PR check.
- Private vulnerability reporting GET returned HTTP 404. Enabled status is unresolved. SECURITY.md advertises the repository's private reporting route and `info@steepy.it`; mailbox delivery/ownership and anonymous route behavior were not tested, and no message was sent.
- Repository metadata reports code security, secret scanning, push protection, non-provider patterns, validity checks and Dependabot security updates disabled. No setting changed. Verify the chosen protections and reporting route before launch.

## Findings and human review

231 local object/classification records: 75 token-shape, 114 credential-assignment, 38 personal-path and 4 private-key-header records. These are per object/class records, not distinct secret counts. Private-key headers occur in historical observability tests; many token patterns are fixture/redaction code. This context is insufficient to dismiss all matches. Remote Actions yielded 19 personal-path records (418 matches across log entries); PR file page 2 yielded 14 token-shape matches. No token values are included. Review privately, classify fixture versus sensitive data, and record redacted disposition. If any credential is real, the owner must revoke/rotate it and assess exposure with separate authorization; removing a string does not revoke access.

Local location inventory (all matched values redacted):

| Path | Classification | Object records | Match count |
|---|---|---:|---:|
| `RELEASE.md` | personal-path | 3 | 3 |
| `adapters/headless-events.mjs` | token-shape | 2 | 2 |
| `context.json` | token-shape | 1 | 6 |
| `context.md` | token-shape | 1 | 1 |
| `scripts/formula/cli.mjs` | credential-assignment | 13 | 13 |
| `scripts/formula/engine/lifecycle.mjs` | credential-assignment | 3 | 3 |
| `scripts/formula/engine/lifecycle.mjs` | personal-path | 3 | 3 |
| `scripts/project-scaffold.mjs` | credential-assignment | 10 | 10 |
| `tests/adapters.test.mjs` | personal-path | 24 | 48 |
| `tests/autopilot-context.test.mjs` | token-shape | 6 | 6 |
| `tests/autopilot-observability.test.mjs` | private-key | 4 | 4 |
| `tests/autopilot.test.mjs` | credential-assignment | 30 | 30 |
| `tests/autopilot.test.mjs` | token-shape | 12 | 58 |
| `tests/dogfood-hub.test.mjs` | token-shape | 27 | 54 |
| `tests/fixtures/dogfood-export.jsonl` | token-shape | 14 | 248 |
| `tests/fixtures/fake-harness.mjs` | credential-assignment | 16 | 16 |
| `tests/formula-arcadedb.test.mjs` | credential-assignment | 3 | 3 |
| `tests/live-scaffold-canary.test.mjs` | credential-assignment | 6 | 36 |
| `tests/loop-engineer.test.mjs` | credential-assignment | 9 | 45 |
| `tests/portability-contract.test.mjs` | personal-path | 8 | 16 |
| `tests/portable-workflow-composition.test.mjs` | credential-assignment | 12 | 12 |
| `tests/reviewer-response.test.mjs` | token-shape | 4 | 4 |
| `tests/task-results.test.mjs` | token-shape | 3 | 3 |
| `tests/validate-hub.test.mjs` | credential-assignment | 9 | 36 |
| `tests/validate-release-evidence.test.mjs` | credential-assignment | 3 | 8 |
| `tests/work-paths.test.mjs` | token-shape | 5 | 25 |

Remote redacted locations: PR #1 file list page 2 (token-shape, 14 matches); Actions log runs `39571599373`, `39575682804`, `39580507956`, `39762944704`, `39762944811`, `39764912849`, `39843498756`, `39927552607`. Each matched log entry had 22 personal-path matches. Runner home paths may be benign; human disposition remains open.

## Asset and license provenance

LICENSE declares Apache-2.0; NOTICE declares copyright 2026 steepy-it. The Git inventory contains 23 historical asset blob versions (SVG logos/icons/workflow art and PNG icons/workflow art). Candidate paths include `.claude-plugin/icon.png`, `assets/plugin-icon.png`, `assets/plugin-icon.svg`, both stacked-logo SVGs and `assets/workflow-chain.svg`. A repository license is not independent proof of authorship or rights for inherited/generated art. Owner confirmation of authorship/source, generation or external tool terms, font/trademark rights, third-party attribution and historical asset rights is outstanding. The four current SVGs have zero external href/src HTTP references; workflow-chain.svg has one font-family attribute, so rendering/font provenance still needs review. Lockfile license declarations are Apache-2.0 (neo4j-driver, its Bolt/core packages and rxjs), MIT (base64-js, buffer, safe-buffer, string_decoder), BSD-3-Clause (ieee754) and 0BSD (tslib). These declarations and dependency license/NOTICE obligations require human review against the actual packed lockfile. No asset rights certification is made.

## Required closure

Follow [G1–G4](../RELEASE.md#ordered-maintainer-launch-gates) and the [settings transition procedure](publication-readiness.md#protection-transition-procedure-requiring-later-authorization). Preserve existing history. Any proposed destructive rewrite, deletion or repository replacement needs a separately reviewed plan, explicit authorization and a verified private backup covering refs/objects with access controls and a successful restore check before execution. No backup was created or verified here.

Launch blockers: final reviewed candidate acceptance; human disposition of every finding; provenance/license approval; inaccessible/retained/deleted provider surfaces and omitted patches; protection/reporting/contact verification; pre-public same-version identity reconciliation; anonymous public availability and real supported installation. Missing evidence stays NOT RUN/unresolved. Keep automatic main publication gated; any change to settings, Git state, visibility, release/tag or directory publication requires later explicit authorization. Native evidence files remain untouched until G1 produces genuine observations.

## Ref inventory at audit time

Local refs (including conservative upstream/checkpoint scope):

```text
refs/codex/turn-diffs/checkpoints/b484d4f4090373766ccc9a9069eafe83/a3e8bd7d3e2898722751486ea04048f9/1792573044026/2ea75a61-c1f9-4f49-b518-ad05b541b4e0 6df3670b6d02ed967ebfa185db5f57c10f00a5cf
refs/heads/backup/pre-1.0.0-squash b5f5179371bf35ad1bc674112bd1a1ae07341482
refs/heads/graph-only-formula d2f4784281937d10e7bd1c55c2af50d0fa6b4b72
refs/heads/main 18ca0def47e9e9db9b2cdf5b31e038cfa66c4f47
refs/heads/port-apex-v08x 88ddba0be82efb755e27b214016a002830d760a8
refs/heads/port/apex-c1 ae9cb16d3930328bee363f7ef0455580584cee8d
refs/heads/port/apex-c2 652752e30eec09dcedd68c22099b48bb90161412
refs/heads/port/apex-c3 de66ca39c0928eb842df66c691b9925077d9b79a
refs/heads/port/apex-c4 0a8bde077715441156172d13e03075515317022b
refs/heads/port/apex-c5 2913ed39e973fb8f76d2788f00ed47c8c3dd857a
refs/heads/port/apex-c6 335b5a3df8fe85668d452d480b845d834d636473
refs/heads/port/apex-v0110 c29e3b0ce17265c00a7a5c9aaacbb06a05642484
refs/heads/port/apex-v120 b5f5179371bf35ad1bc674112bd1a1ae07341482
refs/heads/promotion-in-chain 514f4613fbf443060d85033ec25272107a371d3d
refs/heads/public-release-readiness 884176aa7b64ffa8cd0998f94c8aba640bb43a67
refs/heads/redesign/init-graph-first 903c501e988555cee4635aed9beb9b3680f2e332
refs/heads/release/v1.0.0-prep b5f5179371bf35ad1bc674112bd1a1ae07341482
refs/heads/stable-knowledge-graph 05236260a6201f64f9056d966bba8e60971d3574
refs/remotes/apex/HEAD b9b9b771965a5a8a9fbfb04b04a1158e228ee56a
refs/remotes/apex/backup/inception-v1-pre-rebase-2026-10-09 778a20b9a597de6c85e38b0ee809e768fa16ef28
refs/remotes/apex/backup/inception-v1-pre-rebase-2026-10-13 cc9e3ae4d2e3d566ab67f61efed767270e0fb559
refs/remotes/apex/backup/inception-v1-pre-rebase-v117-2026-10-13 116b01d527e3858e39b70a2d5b9d4e252eaa80c8
refs/remotes/apex/backup/v0.9.4-before-community-amend 08d1be1db6217f068fc09fa34d2d7fe26e8e2edf
refs/remotes/apex/chore/directory-listing-links 23d558bd7988f24f89333f3fdceaa78f5261fc9f
refs/remotes/apex/chore/plugin-keywords 38085bc6fcd50ae6c5935d8249df22959a6d0117
refs/remotes/apex/context-flow-turn-discipline f4a4513178580f3ec1f37d5c4f732a21068eb4ad
refs/remotes/apex/cost-report-robustness 29aa102b4f995ddf78e5500792bb9408903baaa2
refs/remotes/apex/deepseek-harness-adapter a7cbb99db8a7cbfed069f17ee956ac8e882d3e00
refs/remotes/apex/docs/readme-website 5285cf51df85e778f39a94d8c9247e2f38b54fca
refs/remotes/apex/docs/v1.2.0-doc-gaps 60a97fa2bc2379a76e58542034f600592d738432
refs/remotes/apex/feat/inception-v1 31d238c0126279031ed5a780db038ef3550d73b7
refs/remotes/apex/feat/portable-project-bootstrap-v0.9.4 3e9bca4082c0a08c7e6a09e7efb09dd98c2ff2e4
refs/remotes/apex/feat/validate-hub-code-anchors b5a176db296ba87ac8619cae996350b2f9cd0575
refs/remotes/apex/fix/community-submission-portability ea9212a965887cf29766ca2874ba00188346ce31
refs/remotes/apex/fix/cost-report-medie d94f71a203f9034ffee0d44a1004544b05861a0e
refs/remotes/apex/fix/gear2-spec-machine-contract 4d0d341175590846ad7a54b968450c9d6425ff4d
refs/remotes/apex/fix/opencode-autopilot-observability 1226a6b82216e921b8fbf4ebf4aec967e06e3995
refs/remotes/apex/fix/redact-redos d3b5e61da29c713defcbb350e78f29207023209d
refs/remotes/apex/main b9b9b771965a5a8a9fbfb04b04a1158e228ee56a
refs/remotes/origin/HEAD 18ca0def47e9e9db9b2cdf5b31e038cfa66c4f47
refs/remotes/origin/claude-directory e5013663861255c1ba29ab618c37b4d0c33590c5
refs/remotes/origin/graph-only-formula d2f4784281937d10e7bd1c55c2af50d0fa6b4b72
refs/remotes/origin/main 18ca0def47e9e9db9b2cdf5b31e038cfa66c4f47
refs/tags/v0.2.10 19436b9910fe1d57d83240db263a76f007e2b3e6
refs/tags/v0.2.7 5433217d5511a4252c6fdab49cfac68ff0749a6b
refs/tags/v0.2.8 47f86c845aa950b50028c40280ec95ccec8f0472
refs/tags/v0.2.9 494b4ece945341b7262b20eff4d1ff227c83f851
refs/tags/v0.3.0 43710cfaa7f5151e51400a025e12723f68f92cb9
refs/tags/v0.4.0 ede644a5f51f234964c98bca7ed4b447f747e641
refs/tags/v0.4.1 4867995ec7b293b001f12ba570d1339ded44b7d5
refs/tags/v0.5.0 3f2082344bd8f2bc700c0b2c8145f24325073097
refs/tags/v0.6.0 5a39259b89105f2dd43d1a960bc8bb46470b11c8
refs/tags/v0.7.0 30ce6371b6ddc9ee2e244ab5a8cb38f5f21ce0f8
refs/tags/v0.7.1 73126bd346692213300d7523197e540ba2ffb66b
refs/tags/v0.7.2 3619ef986dd5adcb1af8f6b6cba70a69de8767dd
refs/tags/v0.8.0 e040fb760b8a77e9c43c3d0aae28ffcda0eb38df
refs/tags/v0.8.1 3fa65145695cf2456e1f7feaba9e48c61847fdd9
refs/tags/v0.8.2 acb827554c0ec34ae35b6e690abbb7ce8f604b09
refs/tags/v0.8.3 7e22d87520d6890181af91c02d93436aa7cc7027
refs/tags/v0.8.4 067878c61c54aef89a34c43f29c1553671715ef1
refs/tags/v0.8.5 ef6f71bb0734e4c71c7912809ab0040ba752612a
refs/tags/v0.8.6 094040ffbc70ccc9782d12840d859443b258d216
refs/tags/v0.8.7 6c3b06158efdc68d9b431809357866ac01fcd054
refs/tags/v0.9.0 00321d8fbbd35d267fbca52f6103fc65e4c2eed1
refs/tags/v0.9.1 020d2d3e39b9104badc0f6e8f27a18fe7c21ac55
refs/tags/v0.9.2 9edc2d4c15c1cfa770515a98b7985e133ae60167
refs/tags/v0.9.3 ea9212a965887cf29766ca2874ba00188346ce31
refs/tags/v0.9.4 251d77f6bcc652360eba1380de493330e19fb616
refs/tags/v1.0.0 18ca0def47e9e9db9b2cdf5b31e038cfa66c4f47
refs/tags/v1.0.1 b38f873409e4b74299c3d4a4e39c2fdd3e5bb25c
refs/tags/v1.0.2 8741327632eacf7deba5d67b3f355e73f379b49f
refs/tags/v1.0.3 6c671a57e6f28aff1d9f34acde19240b79bb244c
refs/tags/v1.0.4 b7532faf410c463dbb5f002a7d780918e3d79a37
refs/tags/v1.0.5 81571768ff83da20f640b497b402b28efc82c68a
refs/tags/v1.0.6 d47b5fd9a7d9328d326fe3db4c3b5d1a0b29e1cf
refs/tags/v1.1.0 8e3f68b59c097bf43d42864ada8d0d8dcb21b94b
refs/tags/v1.1.1 fd096279634804ef23e28ff5d4047cdd1bebfd78
refs/tags/v1.1.2 8f8330fdf7cc162ff4072c2d1c03f95b100a8c78
refs/tags/v1.1.3 628a73f516d84ebe0c6d35f666c4f59dd4944af0
refs/tags/v1.1.4 1fcc3080935b5c229bbb9d3ab2178e35e46d1174
refs/tags/v1.1.5 79a0cf9acef59317aad5a895e5e8b3cba4c4370d
refs/tags/v1.1.6 73369d8ca0fd3ce45f115b143a3ead18974d76a2
refs/tags/v1.1.7 657fe846001e98aa69e844d94512c28edb1a9d31
refs/tags/v1.2.0 cc19a009ea39d251f4f05bb0e55a3e2185e44382
```

Remote advertised refs:

```text
18ca0def47e9e9db9b2cdf5b31e038cfa66c4f47	HEAD
e5013663861255c1ba29ab618c37b4d0c33590c5	refs/heads/claude-directory
d2f4784281937d10e7bd1c55c2af50d0fa6b4b72	refs/heads/graph-only-formula
18ca0def47e9e9db9b2cdf5b31e038cfa66c4f47	refs/heads/main
d2f4784281937d10e7bd1c55c2af50d0fa6b4b72	refs/pull/1/head
18ca0def47e9e9db9b2cdf5b31e038cfa66c4f47	refs/tags/v1.0.0
```
