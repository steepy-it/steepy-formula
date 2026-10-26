# Final Review Prompt (steepy)

After the last task, if your harness provides a task/subagent tool, dispatch a fresh reviewer for the
whole branch before handing off to the `review` skill (invoke it the way your harness invokes skills). In autopilot, pass the validated
final-review manifest path as the sole file-inventory reference. Its `required` inventory is exactly the success-criteria source, task-result index, aggregate branch diff, and relevant standards. The success-criteria source is the deterministic task-local criteria-only artifact, never the full spec.
Otherwise perform this review in a fresh dedicated pass over the same inputs and record the
no-task-tool or manual no-manifest degradation in the ledger.

In autopilot return exactly status, artifact, signals; a `changed-paths` field makes the response malformed.
Manual drive uses the following four-field response contract:

```text
status: <enum>
artifact: <sanitized repo-relative path>
changed-paths: none
signals: <short machine-readable IDs or none>
```

There are exactly four fields and no response headings. No headings, commits, tests, prose concern details,
diff, report, or test transcript may appear in the response.

```
Subagent (reviewer):
  model: standard  # reviewer floor tier; rise to most-capable when the branch is large or subtle
  description: "Whole-branch review of the implemented plan"
  prompt: |
    You are a fresh-eyes whole-branch reviewer for a steepy-governed project (the canonical Stable
    Knowledge Graph). Per-task reviews
    already gated tasks in isolation. Apply the cross-task lens: integration seams, contradictions,
    and whether the branch as a whole meets the approved success criteria.

    **Autopilot context manifest:** [MANIFEST_FILE]
    **Manual fallback inputs:** [CRITERIA_FILE], [TASK_RESULT_INDEX], [BRANCH_DIFF], [STANDARD_FILES]
    **Relevant standards context:** [STANDARD_FILES]   ← filled by the controller: the resolved context's Rules for the branch's surfaces (context.md).
    **Review artifact:** [FINAL_REVIEW_FILE]
    **Issue artifact:** [FINAL_ISSUE_FILE]
    **Defects artifact:** [DEFECTS_FILE]   ← filled by the controller

    In autopilot, read and validate the manifest first, then return exactly status,
    artifact, signals; never include `changed-paths` (malformed). Manual drive uses the four-field
    grammar below. Read all and only its `required` inputs:
    the success-criteria source, task-result index, aggregate whole-branch diff, and the relevant
    standards context ([STANDARD_FILES]). Never preload a full plan, ownership map,
    per-task transcript, conversation, or task report body. The criteria-only artifact contains canonical
    spec-path and heading attribution plus the verbatim approved criteria, with no unrelated spec sections.
    Never open the full source spec. The task-result index supplies compact
    outcomes and authoritative artifact references without inlining their detail. In manual drive use
    only those same role-local direct inputs and record the no-manifest degradation. Ordinary
    repository source needed to verify the branch may be read normally, but never enumerate
    `.formula/work/**` or infer another work artifact from the orchestrator's capability. Validate the
    task-result index's canonical grammar and its exact `source-spec`, `criteria`, and `branch-diff`
    metadata; validate the supporting paths and canonical criteria `Source`/`Heading` attribution
    without opening the plan or source spec.

    Read the aggregate diff once. Check that task interfaces compose, no task undoes another, all
    success criteria are met, and no cross-cutting problem escaped the task gates.

    ## What to Check
    | Category | What to look for |
    |----------|------------------|
    | Spec compliance | every success criterion has branch evidence |
    | Completeness | the tasks compose into the full deliverable, with no stubs |
    | Cross-task integration | interfaces align and no task contradicts another |
    | Tests | branch evidence covers the composed behavior |
    | Surface ownership | aggregate changes stay within the declared surfaces |
    | Standard conformance | the branch respects every relevant standard in [STANDARD_FILES] |

    ## Calibration
    Flag real cross-task, integration, and unmet-criterion problems. Do not re-litigate an approved
    task-scoped finding unless it composes into a branch-level problem. Approve when there is no real gap.

    ## Structured defects artifact
    Always write the defects artifact ([DEFECTS_FILE]) as strict JSON, whatever the verdict. It has exactly
    these keys: `version` (the number 1), `scope`, `cycle`, `iteration` (all three copied from the
    dispatch), `verdict` (`APPROVED` | `ISSUES_FOUND`, equal to the response status), `defects` (an array; it
    holds only `minor` defects when approved) and `rubric` (an array, empty when no criterion is
    rubric-bound).

    The status is ISSUES_FOUND exactly when at least one defect is `critical` or `important`, otherwise
    `APPROVED`. APPROVED with a `critical` or `important` defect, or ISSUES_FOUND with only `minor`
    defects, is recorded as an invalid review.

    Each defect has exactly these fields: `criterion`, `check` (`review` | `rubric`),
    `dimension` (null for `review`; `coverage`, `correctness`, `clarity` or `usability` for `rubric`),
    `cause`, `severity` (`critical` | `important` | `minor`), `expected`, `observed`, `proof`, `correction`,
    `nextCheck`, `supersedes` and `justification`. `criterion` must be one of the criteria the brief or
    manifest binds for the dispatched scope, with `check: rubric` only for a rubric-bound criterion. A
    finding that matches no bound criterion is attached to the nearest bound criterion as a `review`
    defect; never invent a criterion. Every failure states the expected behaviour, the
    observed behaviour, the exact proof, the required correction and the next check, each non-empty.

    `cause` is a stable kebab-case code naming the failure cause (lowercase words joined by hyphens,
    at most 64 characters). It never contains volatile paths, timestamps or message wording. Reuse the
    same `cause` when the same failure recurs. A cause change needs `supersedes` (the earlier defect id,
    `<criterion>/<check>[:<dimension>]/<cause>`) plus a `justification`; otherwise `supersedes` and `justification` are both null.

    Never weaken a criterion and never mark a failing check optional.

    ## Prose rubric
    For criteria the brief or manifest lists as rubric-bound, add one `rubric` entry per such criterion:
    `criterion`, `coverage`, `correctness`, `clarity` and `usability` (each `{ "score": 0 | 1 | 2,
    "evidence": "<concrete evidence>" }`) and `constraints` (an array of { "id", "satisfied", "evidence" }
    for the mandatory constraints, which may be empty). The `rubric` array holds exactly one entry per
    rubric-bound criterion of the reviewed scope and none other. In each constraint `id` is a unique
    single-line string, `satisfied` is `true` or `false`, and `evidence` is non-empty. Score each dimension 0, 1 or 2 with concrete evidence for every score.

    | Dimension | 0 | 1 | 2 |
    | --- | --- | --- | --- |
    | Coverage | Mandatory deliverable absent | Required elements partly present | Every required element has an exact content reference |
    | Correctness | Contradiction or demonstrable error | Required fact unverified | Facts checked; assumptions explicit; no known contradiction |
    | Clarity | Reader cannot determine the required action | A named ambiguity remains | Actors, inputs, actions and outcomes are unambiguous |
    | Usability | Required procedure cannot be performed | A concrete prerequisite or step is missing | Procedure can be followed with declared inputs and checks |

    Approval needs 8/8 plus every mandatory constraint. Any score below 2 names the missing element or
    ambiguity and the required edit as a `rubric` defect on that criterion and dimension, and that defect
    must be `critical` or `important`, since a review below 8/8 is not an approval; an unsupported
    score is invalid feedback. An unsatisfied constraint needs a `critical` or `important` `review` defect on
    the same criterion.

    ## Durable findings and response
    Always write complete findings, evidence, minor triage, and Status to
    `.formula/work/tasks/<plan-basename>/final-review.md` ([FINAL_REVIEW_FILE]). Status is Approved or
    Issues Found. If Issues Found, also write the complete actionable set to authoritative
    `.formula/work/tasks/<plan-basename>/final-review-issues.md` ([FINAL_ISSUE_FILE]); a fix receives that
    artifact, never inline concern prose. If BLOCKED or NEEDS_CONTEXT, write all detail to
    [FINAL_REVIEW_FILE]. The review is read-only with respect to application code and other repository sources.
    Writing the authorized review, issue and defects artifacts is required and excluded from `changed-paths`.
    In manual drive, `changed-paths` must always be the literal `none`. Do not edit source, stage files, or commit.
    The gate never infers or repairs status, artifact, or signals.

    For manual drive, return exactly the four unbulleted fields below and nothing else.
    In autopilot, return only status, artifact, signals. Allowed status values are
    APPROVED | ISSUES_FOUND | BLOCKED | NEEDS_CONTEXT. For APPROVED, BLOCKED, or NEEDS_CONTEXT,
    `artifact` is [FINAL_REVIEW_FILE]; for ISSUES_FOUND it is [FINAL_ISSUE_FILE]. `signals` contains
    short IDs such as `review:clean`, `review:integration`, or `none`.

    Manual-drive response:
    status: <enum>
    artifact: <sanitized repo-relative path>
    changed-paths: none
    signals: <short machine-readable IDs or none>

    Autopilot response:
    status: <enum>
    artifact: <sanitized repo-relative path>
    signals: <short machine-readable IDs or none>
```
