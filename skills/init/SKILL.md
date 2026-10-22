---
name: init
description: Graph-first init — gate on a provisioned Stable Knowledge Graph before writing anything, interview the governed structure, scaffold the disk-minimal harness assets, and land the initial graph through a promotion scenario. Never invents Rules from stack detection.
user-invocable: true
---

# init

Initialize a project the graph-first way: the Stable Knowledge Graph IS the hub, so the
engine is provisioned and verified before any repo file is written, the governed structure
(Surfaces, Components, Rules, Checks, Terms) is interviewed and committed as one promotion
transaction, and the disk receives only the minimal harness scaffolding (work area, agents,
bootstrap skill, `CLAUDE.md`). No markdown hub is ever created.

> **Engine root:** this skill's base directory is `<engine-root>/skills/init/`; engine
> scripts live two levels up, at `<engine-root>/scripts/`. Resolve them relative to the base
> directory your harness reports for this skill.

The skill drives the shipped `steepy-formula` CLI (resolve it as
`node <engine-root>/scripts/formula/cli.mjs` or the published `steepy-formula` bin) and
namespaces every invocation `steepy-formula`. The CLI and the shipped structural-promotion
helper (`node <engine-root>/scripts/structural-promotion.mjs`) are the only machines the skill
touches for the graph; the portable scaffold planner (`scripts/project-scaffold.mjs`) writes the
disk assets, and after a complete inception run the inception helpers
(`scripts/inception-state.mjs`, `scripts/inception-governance.mjs`) certify that first init —
this procedure is prose + gates, it never re-implements core logic. All paths resolve relative to
the repo root the human selected (default: the current working directory).

> **Hard gate — never invent Rules from stack detection.** Stack and topology detection
> contributes Packages, Surfaces, and Components ONLY. Rules enter the graph only through the
> human-approved interview and scenario: a Rule is written only when the human explicitly
> approves it in Step 3 and the scenario carries it. Detecting a stack, framework, manifest, or
> dependency is never grounds to invent a Rule — never synthesize one from detector output, a
> lockfile, or a package name. If the human approves no Rules, the graph carries none.

## Procedure

### Step 1 — Pre-flight hard gate: provision, verify, and route

Nothing is scaffolded until the engine answers. This gate runs **before writing any repo
scaffolding artifact** — the `.formula/work/` area, agent files, the bootstrap skill, and
`CLAUDE.md` are all created only after it passes.

Drive `graph init` (idempotent provisioning — re-running with the same project id prints the
same summary):

```bash
steepy-formula graph init [--project <project-id>]
```

- Credentials resolve ONLY through the F1 secret-provider chain (`db-password` in the engine).
  The CLI exposes no password flag and this skill never invents one — never pass a credential
  on the command line. No fallback is offered.
- Init persists the project binding: the project id lives in `.formula/config.json`, a
  **committed** repository artifact. When `.formula/` is gitignored, ignore it as `.formula/*`
  (replacing a bare `.formula/` directory pattern) and add the `!.formula/config.json` exception
  so the binding is shared: Git cannot re-include a file inside an ignored directory. Confirm with
  `git check-ignore .formula/config.json`, which must print nothing. `graph init` also writes
  `.formula/.gitignore` (create-only: `*`, `!.gitignore`, `!config.json`), so the local areas
  under `.formula/` — work, an inception run, the provenance receipts, secrets — stay ignored even
  when the root `.gitignore` names nothing.
- A mismatched explicit `--project` (or `STEEPY_PROJECT`) against a committed config refuses
  up front (**exit 3**, before any engine work) unless `--force` rewrites the binding, echoing
  old → new. Re-pointing the shared binding is always the human's explicit `--force` decision.

Then read the project state:

```bash
steepy-formula graph status
```

Also declare the hub mode — `graph`, `migrate`, or `none`, each printed with one `evidence:` line:

```bash
steepy-formula hub-mode
```

Decide IMMEDIATELY from the first matching row of this table, top to bottom:

| Observation | Meaning | Action |
|---|---|---|
| **exit 3**, engine unreachable, or any credential/engine failure | The pre-flight failed | Report the diagnostic and **STOP** — no repo file is written before this gate passes (no work area, no agents, no bootstrap skill, no `CLAUDE.md`). Do not fall back to scaffolding anything else; a failed gate is a failed init. |
| `hub-mode` reports `migrate` | The repo carries an unmigrated steepy-apex hub | Stop and tell the user to run the `graph-migrate` skill (invoke it the way your harness invokes skills) before any other workflow. **STOP** — no scaffolding, no graph mutation. |
| `initialized: yes` | This is an init re-run on an already-initialized project | Jump to Step 8 repair semantics (validate + report) and **STOP** — no scaffolding, no graph mutation. |
| Engine reachable + `initialized: no` (exit 4) | **EXPECTED virgin state** — the Step 1 success outcome for a fresh init | Continue to Step 2 (detection → interview → scaffolding → scenario). |

The virgin row is correct by construction, never a failure: the system record is only written
by the first promotion apply (Step 6), so a freshly provisioned graph correctly reports
`initialized: no` until this skill's own scenario lands.

**Inception provenance (exact paths only).** On the virgin row, before any repo file is written,
check only the exact `.formula/inception/run.json` descriptor when it exists. A descriptor with schema
`steepy-inception-run/v2` and phase/status `complete` makes this the first post-complete init,
certified in Step 4 (**Post-complete certification**); an unsupported run format is never certified
or migrated. Never list `.formula/inception/` or read its document bodies for init: the completed run
is project context for the Step 3 interview, not a machine input. `.formula/` is a reserved area of
inception snapshots, so the binding this step's `graph init` writes is never application drift.

Check the exact canonical `.formula/init-provenance.pending.json` and `.formula/init-provenance.json`
paths before a fresh `verify-complete` gate: a pending receipt intentionally makes that gate red.
For an interrupted pending init, jump directly to **Pending certification recovery** in Step 4
before any other write. Skip Steps 2 and 3, fresh detection/interview, model projection, and
fresh preview/conflict resolution. Recover the same retained governance input at
`.formula/work/init/<runId>/governance-input.json`, its original operation plan at
`.formula/work/init/<runId>/scaffold-plan.json`, and the retained Step 5 structural input at
`.formula/work/init-structural.json`. Missing any exact artifact stops recovery; never reconstruct a
plan or choose a historical work file. If the final receipt exists, retain it unchanged; ordinary
subsequent init/repair remains available, but new changes are not certified by the old receipt.
Pending recovery failure stops its writes.

When `.formula/` is gitignored, the `.formula/*` + `!.formula/config.json` rewrite above is an application
change outside the certified operations: on the post-complete path defer it until after the
`discovery` skill's inception source has run (any application change closes that one-time window).

### Step 2 — Stack + topology detection, as proposals only

Run the stack detector from the engine, passing the repo root:

```bash
node <engine-root>/scripts/detect-stack.mjs <repo-root>
```

Read its JSON output (package manager, monorepo flag, per-surface name/path/test/lint
proposals). Then read the topology line from the Step 1 `graph init` output —
`<n> workspaces, <m> packages (<detector>)`: Repository at the root, Workspaces as the
workspace boundaries, Packages as the manifests inside them. A
`topology: not detected (<code>)` line is a real fact, not a failure.

Both feeds go into the interview as **PROPOSALS ONLY**: surface names/paths/test commands and
component mappings. Mark every mapping **PROPOSED** — never final; the human decides in Step 3
which proposals stand, which change, and which are dropped. The hard gate above is in force
verbatim here: detection contributes Packages, Surfaces, and Components only — never Rules.

### Step 3 — Interview the human (one question at a time)

Interview the human one question at a time — numbered options and a recommendation, never a
yes/no sweep, never a batch. Cover, in this order:

1. **Project id** — confirm the id used in Step 1 (or name the project id now).
2. **Surfaces** — confirm each proposed surface name, path, and test command, or accept
   corrections/additions/removals.
3. **Component mappings** — for each proposed Component from the topology, confirm or edit the
   mapping (and which proposed mappings are dropped).
4. **Git policy** — offered as a Rule candidate that `APPLIES_TO` every confirmed Surface
   (e.g. "no git command without explicit user confirmation"). Recorded as a governed Rule in
   the graph, it travels with the repo and every graph-aware skill resolves it; declining
   records no git Rule.
5. **Per-surface verification Rules** — default proposal: "changes on <surface> pass
   `<testCmd>`" — a Rule that `APPLIES_TO` the Surface and carries the Check. Reachability
   judgment: a Check lands in the graph only when its surface's verification Rule is approved.
6. **Additional Rules** — any further human-approved Rules, each named with its concern
   stated. This and item 4/5 are the ONLY channels through which Rules enter the graph.
7. **Terms** — any domain terms worth defining, if the human has them.

Wait for a confirmed answer before asking the next question. Do not proceed to Step 4 until
the interview is complete.

### Step 4 — Disk scaffolding (after the gate, disk-minimal)

Only now — gate green, interview confirmed — write the disk-minimal harness assets:

- `.formula/work/specs/` and `.formula/work/plans/` — the local, gitignored work-artifact area, and
  `.formula/work/.gitignore` with exactly:

```gitignore
*
!.gitignore
```

- The portable project scaffold — generated through the common planner, never hand-copied from a
  template (the new-surface scaffolder is not invoked here either; the planner owns the scaffold).
  Serialize the confirmed Project model — `projectName`, `description`, `devCommands`, the
  complete `surfaces` list (`name`/`path`/`agent`/`testCmd`), `resolutions: {}`, and
  `hubMode: 'graph'` (a scaffold commits to a hub channel) — to a planner-model JSON file,
  preview it, and apply only a zero-conflict plan:

  ```bash
  node <engine-root>/scripts/project-scaffold.mjs --hub <repo-root> --model <planner-model-json>
  node <engine-root>/scripts/project-scaffold.mjs --hub <repo-root> --model <planner-model-json> --apply
  ```

  When the preview emits conflicts, make the user choose only from the emitted id/choice pairs,
  write them into the model's `resolutions`, and repeat the preview. Continue until `conflicts`
  is empty (zero unresolved conflicts); a non-zero preview exit caused by conflicts is a repair
  question, not permission to write. On the first post-complete init, the zero-conflict preview
  is followed by **Post-complete certification** below instead of the `--apply` command. The planner creates the
  portable root instructions, the canonical project bootstrap at
  `.agents/skills/<projectName>-bootstrap/SKILL.md` with its Claude compatibility adapter, and
  the per-surface specialist adapter triads (`.claude`/`.codex`/`.opencode`). The planner owns
  their generated provenance — never paste a provenance marker by hand. Binding stays
  deterministic: surface `<name>` → specialist `<agent>` across the three adapter roots; there
  is no routing table in graph mode. In graph mode the bootstrapped navigation names
  `steepy-formula hub-mode` (declare the hub mode) and `steepy-formula context resolve` (load
  the resolved task context) — orientation walks the graph, never a markdown index.
- `CLAUDE.md` at the repo root, via the renderer (graph navigation variant), carrying the
  interview results — never a hollow shell:

```bash
node <engine-root>/scripts/render-claude-md.mjs \
  --hub <repo-root> \
  --project <projectName> \
  --description="<one-line description>" \
  --dev="- test (<surface>): \`<testCmd>\`" \
  --surface="- <name> (<path>)" \
  --mode graph
```

  Pass one `--dev` flag per confirmed dev command — at minimum one per per-surface test
  command the Step 3 interview confirmed — and one `--surface` flag per confirmed surface.
  Keep the equals form shown (`--dev="- ..."`, `--surface="- ..."`, `--description="..."`):
  these values can lead with a dash — the `--dev`/`--surface` list bullets always do — and the
  equals form is the one shape the renderer reads the same way for every flag (a space-separated
  dash-leading `--description` value is rejected as ambiguous: exit 1, nothing rendered).
  Omit `--description` entirely if the user gave none — do not invent a description. The
  template emits the `## Dev commands` and `## Surfaces` sections unconditionally, so
  dropping these flags renders them empty — the interview data must flow through.

  If `CLAUDE.md` already exists, ask the user to choose: **insert/refresh the managed steepy
  block only** (`--upsert --mode graph` — idempotent, leaves the rest of the file untouched),
  **overwrite** (the fresh-create command above), or **skip**. Record which action you took.
  On the first post-complete init this renderer step is skipped: the planner's certified
  `CLAUDE.md` import operation is the whole certified change, and a renderer write would be
  application drift outside the certified operations.

#### Post-complete certification (conditional)

For the first fresh init following a complete v2 run (no canonical receipt yet), run this
read-only gate after the zero-conflict preview and before any Step 4 write:

```bash
node <engine-root>/scripts/inception-state.mjs verify-complete --repo-root <repo-root>
```

Require exit 0 and `ok: true`, retaining the returned `runId` and exact `completion` Ref. A failure
(unsupported run format, tamper, application-drift, or any other refusal) stops certification and
writes; do not silently turn a failed certified init into ordinary init. Ordinary init without
this first-post-complete case keeps the interview, preview and conflict procedure above.

Graph mode certifies no Markdown hub document and no `documents` step exists: the stable
knowledge lands in Step 6 through the initialization promotion, whose Revision is its own provenance. The governance input therefore
carries an empty `documents` array, and the planner model is the exact retained zero-conflict
model with `hubMode: 'graph'`, including its selected `resolutions`.

#### Governance input shape

The following is a shape example; replace its illustrative values with the retained model and
the returned completion Ref, never placeholder digests:

```json
{
  "schema": "steepy-inception-governance-input/v1",
  "runId": "<returned runId>",
  "completion": { "path": "<returned completion path>", "bytes": 1, "sha256": "<returned digest>" },
  "projectModel": {
    "projectName": "project-slug",
    "description": "confirmed description or empty string",
    "devCommands": ["npm test"],
    "surfaces": [{ "name": "web", "path": "apps/web", "agent": "web-agent", "testCmd": "npm test" }],
    "resolutions": {},
    "hubMode": "graph"
  },
  "documents": []
}
```

Serialize `<governance-input-json>` as the exact repo-relative
`.formula/work/init/<runId>/governance-input.json` in this init run's authorized output scope. Never
write this input inside the completed run. Do not enumerate work artifacts to recover it. Also
write the Step 5 structural input (`.formula/work/init-structural.json`) now, before prepare, and keep
it unchanged: pending recovery resumes Step 5 from it without a fresh interview.

Before the first prepare, retain the original zero-conflict plan, including complete operation
contents and prior digests, as `<scaffold-plan-json>` =
`.formula/work/init/<runId>/scaffold-plan.json`. Obtain it with the public
`planProjectScaffold({ hubRoot: repoRoot, model: retainedProjectModel })` using the exact confirmed
zero-conflict model, and validate it with `validateProjectScaffoldPlan`; require
`conflicts.length === 0`. Serialize that full plan create-only before prepare and keep it unchanged
across every interruption. If this fresh planning detects a changed conflict set, return to the
conflict preview before preparing anything; after preparation, never plan again. The input, the
producer model (including resolved choices), the retained plan, and the completed run stay
immutable.

```bash
node <engine-root>/scripts/inception-governance.mjs prepare --repo-root <repo-root> --input <governance-input-json>
```

Require exit 0 and `ok: true` before any planner write. The producer uses the public planner to
bind exact root/bootstrap/specialist operations; do not reproduce it in skill prose or import
receipt contents as permission for other changes. Keep the input until finish and the closing
gates succeed, and retain it across interruptions. Never exclude an entire provider directory to
make this gate pass. After prepare, apply through the retained-plan recipe below — never through
`project-scaffold.mjs --model ... --apply`.

#### Pending certification recovery

This is the direct Step 1 branch for a pending receipt, and also the apply path immediately after
a fresh certified prepare. First call the prepare command above with the same retained governance
input bytes; require exit 0 and `ok: true`. Do not run `project-scaffold.mjs --model ... --apply`
for recovery: that CLI plans again and can reject a selected conflict resolution after its
operation has already finished. Do not remove resolutions, re-interview, or issue a new
reservation.

Run the following JavaScript as an ESM module with Node, substituting only the exact engine root,
repository root, governance input path and retained plan path. It uses exported validators, checks
that the original plan's exact operations match the prepared producer reservation, then calls the
public idempotent `applyProjectScaffold` API. Already-applied operations are preserved; only
still-pending operations are published under the API's normal lease and preflight checks. Missing,
invalid or mismatched retained state fails before apply, without a fresh plan fallback.

<!-- example:retained-scaffold-apply -->
```javascript
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const { validateProjectScaffoldPlan, applyProjectScaffold } =
  await import('<engine-root>/scripts/project-scaffold.mjs');
const { validateGovernanceInput, validateGovernanceReceipt } =
  await import('<engine-root>/scripts/inception-governance.mjs');
const repoRoot = '<repo-root>';
const inputPath = '<governance-input-json>';
const planPath = '<scaffold-plan-json>';
const read = path => JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
const sha = content => createHash('sha256').update(content).digest('hex');
const input = validateGovernanceInput(read(inputPath));
const pending = validateGovernanceReceipt(read('.formula/init-provenance.pending.json'));
const plan = validateProjectScaffoldPlan(read(planPath));
assert.equal(pending.status, 'prepared');
assert.equal(pending.runId, input.runId);
assert.deepEqual(pending.completion, input.completion);
assert.deepEqual(pending.producer.projectModel, input.projectModel);
assert.deepEqual(pending.producer.documents,
  input.documents.map(({ path, content }) => ({ path, sha256: sha(content) })));
assert.equal(plan.conflicts.length, 0);
const documentPaths = new Set(input.documents.map(doc => doc.path));
const certified = pending.operations.filter(op => !documentPaths.has(op.path));
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
assert.deepEqual(plan.operations.map(op => ({ path: op.path, kind: op.kind,
  before: op.priorDigest, bytes: Buffer.byteLength(op.content), sha256: sha(op.content) })).sort(byPath),
  certified.map(op => ({ path: op.path, kind: op.kind, before: op.before?.sha256 ?? null,
    bytes: op.after.bytes, sha256: op.after.sha256 })).sort(byPath));
console.log(JSON.stringify(applyProjectScaffold({ hubRoot: repoRoot, plan })));
```

After the retained apply succeeds, create the `.formula/work/` area as above (a reserved area of
inception snapshots, never drift), skip the `CLAUDE.md` renderer, and close the certificate:

```bash
node <engine-root>/scripts/inception-governance.mjs finish --repo-root <repo-root>
```

Require exit 0 and `ok: true`; finish checks the exact prepared outputs and the whole application
difference, then publishes `.formula/init-provenance.json`. An explicit replay of an already-final
certificate uses this same idempotent command without new writes. Graph mode has no certified
document, so no `documents` step exists.
Never edit the completed descriptor or any inception evidence. Run the full
`node <engine-root>/scripts/inception-state.mjs verify-complete --repo-root <repo-root>` gate again
after finish; require exit 0 and `ok: true` before Step 5. A failed prepare/finish/gate is not
completion, and never authorizes broad exclusions or an overwrite. Only exact certified operations
are projected out; new app files, lockfiles, configs and unrelated provider files remain
observable. Never revisit detection or the interview while a receipt is pending; continue with
Step 5 from the retained structural input.

**No hub documents:** init never creates hub documents and never writes under `.apex/`;
`.formula/` holds the committed binding plus the local `work/`, `inception/` and the init
provenance receipts — the graph is the hub. Do not create specs/plans sub-index files.

### Step 5 — Build the initialization promotion scenario (nothing applied)

The initialization transaction is a promotion scenario. The shipped CLI does expose a
`promotion create` command, but it carries only typed knowledge candidates
(`term`/`rule`/`decision`/`readme`) and cannot express the structural skeleton
(Project/Surface/Component/Check) — that is why the engine ships the structural-promotion
helper, which maps a structural input file into a draft scenario through the core library's
`createScenario` (`scripts/formula/core/promotion.mjs`). Drive the helper; never rebuild its
mapping agent-side.

1. Write the interview results into `.formula/work/init-structural.json` — a local, gitignored
   work artifact (the Step 4 work-area `.gitignore` already covers it). On the first
   post-complete init it was already written before prepare: reuse it unchanged.

```json
{
  "project": { "id": "<projectId>" },
  "surfaces": [
    { "name": "<name>", "path": "<path>",
      "components": ["<component>", "..."],
      "testCommand": "<testCmd>" }
  ],
  "rules": [
    { "title": "<title>", "statement": "<statement>", "concern": "<concern>",
      "strength": "must", "appliesTo": ["<surface-name>", "..."] }
  ],
  "terms": [ { "term": "<term>", "definition": "<definition>" } ]
}
```

   - Write `testCommand` ONLY for a surface whose verification Rule the human approved in
     Step 3 item 5 — the helper derives that verification Rule and its Check from it; omitting
     it records neither (the reachability judgment verbatim, and the never-invent-Rules gate).
   - `rules` carries the other approved Rules — the git policy Rule (item 4) with `appliesTo`
     listing every confirmed surface, and each additional Rule (item 6) with its own scope.
   - `terms` carries the confirmed Terms (item 7). Omit any array the interview left empty.

2. Run the helper to create the draft scenario:

```bash
node <engine-root>/scripts/structural-promotion.mjs \
  --project <projectId> --port docker \
  --input .formula/work/init-structural.json <scenarioId>
```

The helper maps the input into plain ADD operations:

- ADD the Project root — `apex:<projectId>:project:root`.
- ADD each confirmed Surface, with `PART_OF` → the Project root.
- ADD each confirmed Component, with `PART_OF` → its Surface.
- ADD each approved Rule, with `APPLIES_TO` → its Surface(s) — the git policy Rule included.
- ADD each per-surface Check with the approved test command persisted as the `ext_v1_command`
  extension property, and `VERIFIED_BY` from that surface's verification Rule.
- ADD each confirmed Term, with `USED_BY` → the Project root.

Record the scenario id the helper reports. Creating the scenario pins the head revision and
writes nothing to the stable graph — nothing applied until the human gate in Step 6 approves;
preview and apply flow through the ordinary `steepy-formula promotion` commands below.

### Step 6 — Preview and human gate

```bash
steepy-formula promotion preview <scenario-id>
```

The typed diff report IS the preview: show it to the human and open the native Explorer so
they can inspect the proposed state. Approval is explicit, never assumed — one question with a
clear yes/change/no choice; never proceed on silence. On **yes**, commit the transaction:

```bash
steepy-formula promotion apply <scenario-id>
```

Run apply WITHOUT `--yes`, so the CLI itself prompts on stdin and refuses (exit 21) unless the
human confirms — the interview approval plus the CLI's own interactive confirmation
double-gate the apply boundary.

### Step 7 — Gates: validate the graph and resolve the surface targets

```bash
steepy-formula graph validate
```

`verdict: clean` and `chain: clean` (exit 0) are required. Then resolve every confirmed
surface by its deterministic target id:

```bash
steepy-formula context resolve --target apex:<projectId>:surface:<slug(name)>
```

— one resolve per confirmed surface: `<projectId>` is the id confirmed in Step 3, and
`slug(name)` is the surface name lowercase with non-alphanumeric runs collapsed to `-` — the
structural convention of `scripts/structural-promotion.mjs`, the same helper that minted the
ids in Step 5, so the targets are deterministic, never guessed. Exit 0 emits `context.json` +
`context.md`. Confirm each resolved context carries the surface's Check with its
`ext_v1_command` — that property is where graph-aware skills read the surface's test command
from (falling back to the verification Rule's statement prose). `--path` resolution is NOT
part of this gate: the init scenario is curated-only, so until a topology bridge links the
detected Packages to the curated Components, `context resolve --path` exits 10 UNRESOLVED —
expected on a freshly initialized graph, not an error. Any target resolve that fails, or a
red validate, means the initialization is incomplete — fix and re-run. Only when both gates
are green, report the head revision and the confirmed Surface/Component mappings.

### Step 8 — Repair semantics

Step 1's decision table routes here; nothing in this step scaffolds or mutates the graph.

- **Already-initialized graph** (`initialized: yes` on the Step 1 status — an init re-run on a
  provisioned project): `graph status` and `graph validate` report only — no re-scaffold, no
  new scenario, no interview re-run. Report the head revision and the confirmed mappings, then
  stop.
- **`hub-mode` reports `migrate`**: do not repair or migrate it here. Stop and tell the user to
  run the `graph-migrate` skill (invoke it the way your harness invokes skills) before any other
  workflow.
- **Init provenance receipts:** an existing final `.formula/init-provenance.json` is retained
  unchanged; ordinary repair is not certified by it and never prepares a replacement receipt or
  re-runs source verification as a prerequisite. A pending receipt routes to **Pending
  certification recovery** (Step 1).

### Step 9 — Report and close

List every artifact created — the `.formula/work/` area (the structural input
`.formula/work/init-structural.json` included, local and gitignored), the per-surface agent
files, the bootstrap skill, and `CLAUDE.md` (created, block-inserted, or skipped — state
which), and on the first post-complete init the receipts `.formula/init-provenance.pending.json` and
`.formula/init-provenance.json` — plus the head revision and the approved Rules (or none). The scaffolded graph starts
with only the interviewed skeleton: run the `discovery` skill (invoke it the way your harness
invokes skills; in graph mode its graph channel populates the graph, not markdown docs) to
populate it from the codebase, and re-run it anytime to keep it from rotting. After a certified
post-complete init, recommend `discovery` with its inception source first: it lands the run's
approved decisions as typed graph candidates while the graph still holds only the
initialization revision.

Remind the user: `.formula/config.json` is a committed artifact — review the generated files
first, then `git add` and commit when satisfied.
