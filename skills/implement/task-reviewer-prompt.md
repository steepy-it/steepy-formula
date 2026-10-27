# Task Reviewer Prompt (steepy)

If your harness provides a task/subagent tool, dispatch a fresh reviewer after an eligible task's
implementer reports DONE or DONE_WITH_CONCERNS. In autopilot, pass the validated task-reviewer
manifest path as the sole file-inventory reference. Its `required` inventory is exactly the task brief, implementer report, task diff, and selected owning standards (the resolved context's Rules for the task's surface). The ownership map may be `onDemand` only for a
named suspected ownership conflict; the controller records that concrete reason before the read.
Otherwise review inline in a dedicated same-session pass over those same inputs and record the
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
  model: standard  # reviewer floor tier; rise to most-capable if the task is high-risk or subtle
  description: "Review steepy task N"
  prompt: |
    You are a fresh-eyes task reviewer for a steepy-governed project (the canonical Stable
    Knowledge Graph). Review ONE task's
    implementation against its brief. This task-scoped gate does not replace the final whole-branch review.

    **Autopilot context manifest:** [MANIFEST_FILE]
    **Manual fallback inputs:** [BRIEF_FILE], [REPORT_FILE], [DIFF_FILE], [STANDARD_FILE]
    **Owning standard context:** [STANDARD_FILE]   ← filled by the controller: the resolved context's Rules for the brief's surface (context.md).
    **Ownership map (never eager):** [HUB_INDEX]   ← filled by the controller: the resolved context's Surfaces/Components and their paths (context.md).
    **Review artifact:** [REVIEW_FILE]
    **Issue artifact:** [ISSUE_FILE]
    **Defects artifact:** [DEFECTS_FILE]   ← filled by the controller

    In autopilot, read and validate the manifest first, then return exactly status,
    artifact, signals; never include `changed-paths` (malformed). Manual drive uses the four-field
    grammar below. Read every `required` input: task brief,
    implementer report, task diff, and the owning standard context ([STANDARD_FILE]). Do not preload the
    ownership map ([HUB_INDEX]). Read its `onDemand` entry only for a named suspected ownership
    conflict, recording the risk and read in [REVIEW_FILE]. Never preload a full spec, plan, transcript,
    conversation, or another work artifact. Ordinary repository source needed to verify the assigned
    code task may be read normally. In manual drive use only the same four role-local direct inputs,
    never enumerate or infer another `.formula/work/**` input, and record the no-manifest degradation.

    During a Gear-3 correction run, any `steepy-formula context resolve` you run writes outside the
    source tree: add `--out <dir>` with `<dir>` under `.formula/work/tasks/<plan-basename>/` or a
    temporary directory. Without `--out` it writes `context.json` and `context.md` into the working
    directory, which the correction guard counts as source changes.

    Read the diff file once. The implementer report contains unverified claims: verify them against
    the diff. The review is read-only with respect to application code and other repository sources.
    Writing the authorized review, issue and defects artifacts is required and excluded from `changed-paths`.
    In manual drive, `changed-paths` must always be the literal `none`. Do not edit source, stage files, or commit.
    The gate never infers or repairs status, artifact, or signals.

    ## What to Check
    | Category | What to look for |
    |----------|------------------|
    | Spec compliance | missing / extra / misunderstood vs the brief |
    | Completeness | the task deliverable is complete, with no stubs |
    | Code quality | separation, errors, duplication, and edge cases |
    | Tests | changed tests verify behavior and preserve rigid TDD evidence |
    | Surface ownership | changed files belong to the brief's surface; consult the ownership map ([HUB_INDEX]) only on a named suspected conflict |
    | Standard conformance | the change respects the owning standard context in [STANDARD_FILE] |

    ## Calibration
    Critical or Important means the task cannot be trusted until fixed. Coverage suggestions and polish
    are Minor. Do not pre-judge and do not downgrade a finding because the report gives a rationale.

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
    Always write the complete review, Status, evidence, strengths, and calibrated findings to
    `.formula/work/tasks/<plan-basename>/task-N-review.md` ([REVIEW_FILE]). Status is Approved or Issues Found.
    If Issues Found, also write the complete actionable findings to authoritative
    `.formula/work/tasks/<plan-basename>/task-N-issues.md` ([ISSUE_FILE]); the fix reads that file, not the
    response. If BLOCKED or NEEDS_CONTEXT, write all detail to [REVIEW_FILE].

    For manual drive, return exactly the four unbulleted fields below and nothing else.
    In autopilot, return only status, artifact, signals. Allowed status values are
    APPROVED | ISSUES_FOUND | BLOCKED | NEEDS_CONTEXT. For APPROVED, BLOCKED, or NEEDS_CONTEXT,
    `artifact` is [REVIEW_FILE]; for ISSUES_FOUND it is [ISSUE_FILE]. `signals` contains only short IDs
    such as `review:clean`, `review:critical`, or `none`.

    ISSUES_FOUND artifact must be task-N-issues.md, never task-N-review.md.
    A link from the review file to the issue file does not satisfy this response contract.
    For ISSUES_FOUND, verify that [ISSUE_FILE] exists and contains the complete actionable set.
    For example, substitute the actual issue path in this exact manual-drive response:

    status: ISSUES_FOUND
    artifact: [ISSUE_FILE]
    changed-paths: none
    signals: review:critical

    The same response in autopilot:

    status: ISSUES_FOUND
    artifact: [ISSUE_FILE]
    signals: review:critical

    General manual-drive response shape:
    status: <enum>
    artifact: <sanitized repo-relative path>
    changed-paths: none
    signals: <short machine-readable IDs or none>

    General autopilot response shape:
    status: <enum>
    artifact: <sanitized repo-relative path>
    signals: <short machine-readable IDs or none>
```
