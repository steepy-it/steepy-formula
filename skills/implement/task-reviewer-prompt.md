# Task Reviewer Prompt (steepy)

If your harness provides a task/subagent tool, dispatch a fresh reviewer after an eligible task's
implementer reports DONE or DONE_WITH_CONCERNS. In autopilot, pass the validated task-reviewer
manifest path as the sole file-inventory reference. Its `required` inventory is exactly the task brief, implementer report, task diff, and selected owning standards (a single file, or the exact modular core plus matching leaves). The hub index may be `onDemand` only for a
named suspected routing conflict; the controller records that concrete reason before the read.
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
    You are a fresh-eyes task reviewer for a steepy-governed project (legacy mode: the Markdown hub
    under .apex/; graph mode: the canonical Stable Knowledge Graph). Review ONE task's
    implementation against its brief. This task-scoped gate does not replace the final whole-branch review.

    **Autopilot context manifest:** [MANIFEST_FILE]
    **Manual fallback inputs:** [BRIEF_FILE], [REPORT_FILE], [DIFF_FILE], [STANDARD_FILE]
    **Owning standard context:** [STANDARD_FILE]   ← filled by the controller per the declared hub mode — legacy: the owning standard under `.apex/standards/`; graph: the resolved context's Rules for the brief's surface (context.md).
    **Ownership map (never eager):** [HUB_INDEX]   ← filled by the controller per the declared hub mode — legacy: the routing table `.apex/_INDEX.md`; graph: the resolved context's Surfaces/Components and their paths (context.md).
    **Review artifact:** [REVIEW_FILE]
    **Issue artifact:** [ISSUE_FILE]

    In autopilot, read and validate the manifest first, then return exactly status,
    artifact, signals; never include `changed-paths` (malformed). Manual drive uses the four-field
    grammar below. Read every `required` input: task brief,
    implementer report, task diff, and the owning standard context ([STANDARD_FILE]). Do not preload the
    ownership map ([HUB_INDEX]). Read its `onDemand` entry only for a named suspected routing
    conflict, recording the risk and read in [REVIEW_FILE]. Never preload a full spec, plan, transcript,
    conversation, or another work artifact. Ordinary repository source needed to verify the assigned
    code task may be read normally. In manual drive use only the same four role-local direct inputs,
    never enumerate or infer another `.apex/work/**` input, and record the no-manifest degradation.

    Read the diff file once. The implementer report contains unverified claims: verify them against
    the diff. The review is read-only with respect to application code and other repository sources.
    Writing the authorized review and issue artifacts is required and excluded from `changed-paths`.
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

    ## Durable findings and response
    Always write the complete review, Status, evidence, strengths, and calibrated findings to
    `.apex/work/tasks/<plan-basename>/task-N-review.md` ([REVIEW_FILE]). Status is Approved or Issues Found.
    If Issues Found, also write the complete actionable findings to authoritative
    `.apex/work/tasks/<plan-basename>/task-N-issues.md` ([ISSUE_FILE]); the fix reads that file, not the
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
