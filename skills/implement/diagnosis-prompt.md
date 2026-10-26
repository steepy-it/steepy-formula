# Diagnosis Prompt (steepy)

If your harness provides a task/subagent tool, dispatch a fresh read-only diagnostic subagent when a
correction run asks for a diagnosis. In autopilot, pass the validated diagnosis manifest path as the sole
file-inventory reference. Its `required` inventory is exactly:

- task scope: the task brief, the failing evidence, the task diff, and the selected owning standards;
- final scope: the success-criteria source, the task-result index, the aggregate branch diff, the
  failing evidence, and the relevant standards.

If your harness has no task/subagent tool, perform the same diagnosis inline as a dedicated read-only
pass over the same inputs and record that inline degradation in the ledger or report; never skip the
dispatch silently.

In manual drive use the following four-field response contract:

```text
status: <enum>
artifact: <sanitized repo-relative path>
changed-paths: none
signals: <short machine-readable IDs or none>
```

In autopilot return exactly status, artifact, signals; a `changed-paths` field makes the response malformed.

There are exactly the fields above and no response headings. No headings, commits, tests, prose detail,
diff, report, or test transcript may appear in the response.

```
Subagent (diagnostic):
  model: standard  # diagnostic floor tier; rise to most-capable for a design task
  description: "Diagnose steepy correction scope"
  prompt: |
    You are a read-only diagnostic for a steepy-governed project (the canonical Stable Knowledge Graph).
    Find why the same failure keeps recurring and name one remedy and the check that would confirm it.

    **Autopilot context manifest:** [MANIFEST_FILE]
    **Manual fallback inputs:** [BRIEF_OR_CRITERIA_FILE], [EVIDENCE_FILES], [DIFF_FILE], [STANDARD_FILES]
    **Diagnosis artifact:** [DIAGNOSIS_FILE]

    In autopilot, read and validate the manifest first, then return exactly status,
    artifact, signals; never include `changed-paths` (malformed). Manual drive uses the four-field
    grammar below. Read every `required` input. Never preload a full spec, plan, transcript,
    conversation, or another work artifact. Ordinary repository source needed to verify the diagnosis
    may be read normally. In manual drive use only the role-local direct inputs above, never enumerate
    or infer another `.formula/work/**` input, and record the no-manifest degradation.

    The diagnosis is read-only. The diagnostic never edits source, stages or commits; writing the authorized
    diagnosis artifact is required and excluded from `changed-paths`. In manual drive, `changed-paths`
    must always be the literal `none`. The gate never infers or repairs status, artifact, or signals.

    ## Diagnosis artifact
    Write [DIAGNOSIS_FILE] as strict JSON with exactly these keys:
    - `version`: the number 1
    - `scope`, `cycle`, `iteration`: copied from the dispatch
    - `hypothesis`: the stated cause of the recurring failure
    - `remedy`: the one change that addresses that cause
    - `confirmingCheck`: the ID of a check bound to the cycle, or `review` or `rubric`
    - `recommendation`: the concrete next correction to apply
    - `evidence`: an array of `{ "path", "digest" }` references (lowercase 64-hex SHA-256) to the
      bytes you relied on; each must match the current bytes

    Every text field is a non-empty string. State what you observed, not what you assume.

    ## Response
    Allowed status values are DIAGNOSED | INCONCLUSIVE | BLOCKED | NEEDS_CONTEXT. Only DIAGNOSED with a
    complete artifact is accepted. `artifact` is [DIAGNOSIS_FILE]. `signals` contains only short IDs
    or `none`. Put all question, blocker or inconclusive detail in the artifact or report.

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
