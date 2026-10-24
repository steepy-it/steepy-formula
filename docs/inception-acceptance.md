# Inception native acceptance protocol

This protocol is a release gate after review. It is not a review criterion: review judges the repository, and this gate judges the skill running in a real harness. Nothing here is run by the test suite.

## Setup rule

Every run loads the packaged plugin under test (a branch or a release tag), with the installed steepy-formula release disabled. An older installed plugin can interfere with an inception turn and spoil the evidence. Record the loaded plugin commit in the matrix.

## Scenarios

### Scenario A: empty repository

1. Start in an empty repository (Git initialized, no files).
2. Run the `inception` skill. Answer as a human; approve the project at the approval pause.
3. Let the run reach `complete`.
4. Run the `init` skill, then the `discovery` skill with the inception source.
5. Confirm `steepy-formula graph validate` is clean and the inception source is offered and consumed once (a second run refuses it once the graph head has moved past the initialization revision).

On Claude Code, scenario A includes one unplanned interruption: stop the session between an effect's intent and its outcome, then resume in a new session. The resumed run first reports the missing outcome as uncertain, then reconciles automatically only when durable evidence and exact correlation prove the original intent. An ambiguous outcome remains uncertain, requires a human decision, and must never be replayed. Reconciliation cannot replace a required manual check or authorize a new remote operation.

### Scenario B: starter plus design system or prototype

1. Start in a repository holding a starter and a design system or prototype.
2. Run the `inception` skill; the existing material is reconnaissance input, not a decision.
3. Reach `complete`, then run the `init` skill and the `discovery` skill with the inception source.

### Scenario C: asynchronous boundary or strong compatibility constraint

A project with an asynchronous boundary or a strong compatibility constraint, possibly outside the JavaScript ecosystem. Scenario C is deferred out of v1. It has no row in the matrix.

## Recovery and verification scenarios

Run these through the packaged skill, in new sessions where indicated. They supplement both scenarios above; record each case separately with exact refs, observed application differences, check IDs and human responses. Interruptions in every phase are required:

| Case | Required observation |
|---|---|
| reconnaissance and architecture decision interruption | Persisted unit/input/output scope survives; a stopped writer is observed before incomplete closure. Missing/truncated output is not completion; retry uses a new ID and exact predecessor. |
| research child interruption | One persisted child unit at a time, or explicit inline degradation; complete identity-delimited report and observed diff are checked, not file presence. |
| approval interruption | Pending publication resumes only its reservation; frozen documents/contract and verbatim human approval bind the same bytes. No model self-approval. |
| bootstrap interruption between intent/outcome | Proven correlation permits automatic observation; ambiguous evidence blocks without replay or invented success. Live/unverifiable capture PID cannot be overridden by a human stopped-writer statement. |
| verification capture interruption | Resume exact capture/publication without command rerun; incomplete evidence remains incomplete. Complete output binding verifies both streams and exit/signal. |
| complete publication or closing-note interruption | Resume exact publication; after valid completion, a missing note permits presentation only, without reopening verification. |
| required check fails | Complete refuses; the agent cannot make it optional. Scope reduction requires human decision and re-approval. |
| manual confirmation missing | An automatic green cannot satisfy a manual or both-type required check. One explicit human response may cover multiple named checks/procedures. |
| application fix during verification | New cycle reruns all required automatic and manual checks; no impact-based selection of old successes. Earlier failed evidence remains historical. |
| unchanged verification resume | Snapshot-policy success remains applicable; mutable-resource reobserve gets new session-bound evidence. Missing reobservation stays necessary without rerunning unrelated valid checks. |
| complete → init → discovery | init-provenance pending/final receipts certify exact governance operations; resume pending init with the retained original plan and idempotent public apply after a resolved replacement. Governance certifies no Markdown document: the `.formula/` binding written by `graph init` is a reserved area, never drift, and the initialization promotion lands the stable knowledge. Completed source/evidence stays byte-identical. |
| application drift after complete/init | Inception source rejects only this import; ordinary discovery remains available. No old-decision fallback, reopening or bootstrap replay. Foreign provider files and unmanaged root edits remain visible. |
| final abandon interrupted after descriptor move | `abandon --resume` uses canonical intention/child identities, preserves the intact archive, ends with a receipt, and never restarts automatically. Repeating it is a verified no-op. |

Include publication interruptions before/after staging, ordered target prefixes and final descriptor replacement; foreign/divergent targets must stop without overwrite. A v1 descriptor fixture is refused by every command, `abandon` and `verify-complete` included, and leaves the whole root unchanged. Collector exit 0 with a red approved command is capture success, never a passing check.

## Copy validation

A copy of only the versioned files (for example a `git clone` of the branch) must validate without `.formula/inception/` and `.formula/work/`: `steepy-formula graph validate` is clean against the initialized graph. Check this after each completed scenario.

## Evidence rules

- A hand-written command sequence imitating the skill is not a proof. Only a run driven by the skill counts.
- A model's approval is never recorded as a human approver. Leave the cell empty or `none` if no human approved.
- Record observed facts only. An unrun row stays `NOT RUN`. Preserve any future recorded observation and its version/commit when adding newer evidence.

## Evidence matrix

| Run | Harness version | Plugin commit | Capabilities | Observed outcome | Observed human approver |
|---|---|---|---|---|---|
| Claude Code A (with interruption) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Claude Code B | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Codex A | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Codex B | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

Automated regression tests do not establish native acceptance. The launch matrix below explicitly reserves every case on every required host/OS. Replace NOT RUN only after actual execution; retain prior observed rows with dates, versions and commits as history rather than relabeling them as current evidence.


## Four-combination launch matrix

Supported launch combinations are Claude Code/macOS, Claude Code/Linux, Codex/macOS and Codex/Linux. Node 24 and a running Docker daemon are prerequisites. Windows is unsupported; experimental OpenCode, Pi and DeepSeek Harness results cannot fill a launch cell. Record observed host version, OS, architecture and profile without inferring support for unobserved versions or architectures.

Each cell starts NOT RUN. For each real skill-driven case record source commit, exact payload SHA-256, product version, clean installation composition with older releases disabled, observed date, exact commands/refs, case-specific outcome and application differences, check IDs, attributed verbatim human responses and actual subagent/degradation behavior. Bind the redacted UTF-8 artifact digest and source revision as [schema 2](release-evidence.md) requires. Synthetic tests and nonce canaries do not establish acceptance. Separate the complete brainstorm → plan → implement → review observation from inception completion and recovery observations. Keep recorded historical rows unchanged when appending a new run.

| Case | Claude Code macOS | Claude Code Linux | Codex macOS | Codex Linux |
|---|---|---|---|---|
| `clean-install-load` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `eleven-skill-discovery` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `skill-invocation` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `init-bootstrap` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `specialist-behavior-dispatch` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `discovery-context-coherence` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `brainstorm-plan-implement-review` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `inception-a` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `inception-b` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `reconnaissance-architecture-interruption` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `research-child-interruption` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `approval-interruption` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `bootstrap-intent-outcome-interruption` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `verification-capture-interruption` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `complete-closing-note-interruption` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `required-check-fails` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `manual-confirmation-missing` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `application-fix-verification` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `unchanged-verification-resume` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `complete-init-discovery` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `application-drift-after-complete-init` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `final-abandon-interrupted` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `publication-before-staging` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `publication-after-staging` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `publication-ordered-target-prefixes` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `publication-final-descriptor-replacement` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `publication-foreign-divergent-targets` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `v1-descriptor-refusal-all-commands` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `collector-zero-red-command` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| `versioned-copy-validation` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

Scenario A (including intent/outcome interruption) and Scenario B each run on all four combinations. All recovery/verification and publication interruption cases above run on all four too. Preserve the original approvals and frozen source bytes. After complete → init → discovery, validate a clean versioned copy without `.formula/inception/` or `.formula/work/`, then establish graph coherence against its initialized graph. None of these launch runs has been observed by this documentation change.
