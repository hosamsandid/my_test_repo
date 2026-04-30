---
description: "Revise a completed/reviewed BP — guided post-approval correction with full audit trail"
allowed-tools: [Read, Write, Edit, Grep, Glob, Bash]
---

# ACE Command: revise

You are the **BP Revision** assistant. Your job is to guide the Agent Coach through revising a BriefingPack that was previously completed or reviewed but needs corrections — for example, when a produced artifact has defects discovered after approval.

**Key distinction:**
- `/ace:review-mrp` rejection (`cancel`) = "the execution failed quality review" — discards agent work, no audit trail
- `/ace:revise` = "the execution was approved but a defect was found later" — preserves full audit history via `revision-log`

## Invocation

```
/revise e32f51                             -> Guided revision (prompts for reason)
/revise e32f51 --reason "POM has invalid XML"  -> Skip reason prompt
```

The argument `$ARGUMENTS` is required — it must be a BP hash (or unique prefix), optionally followed by `--reason "..."`.

## Argument Parsing

Parse `$ARGUMENTS`:

1. Extract the BP hash prefix (first hex token).
2. If `--reason` is present, extract the quoted string after it.

---

## Workflow

### Step 1 — Load BP and Validate

1. **Load BP info**: `python3 scripts/bp-info.py {hash-prefix} --with-guidance --json`
   If exit code 1 (not found) or 2 (ambiguous), display the error and stop.
2. Read the full `brief.md` to understand the BP's mission, ACs, and artifacts.
3. **Validate status**: The BP must be `completed`, `reviewed`, or `stale`. If not, inform the coach:
   ```
   bp:{hash} ({slug}) is '{status}' — only completed, reviewed, or stale BPs can be revised.
     -> /ace:status cancel {hash}  (if dispatched/in-progress, use cancel instead)
     -> /ace:review-mrp {mrp-hash}  (if completed, review the MRP first)
   ```
   If the BP is `stale`, the revise transition will (a) clear all current `stale-because` entries, and (b) cascade-flag *its* direct dependents. Note this for the coach.

### Step 2 — Present Current State

Display:

```
REVISE: bp:{hash} ({slug})
===========================

Title:      "{mission}"
Status:     {status}
Revision:   {revision or 1} (current)
Agent:      agt:{agent-id}
Rigor:      {rigor}
Tier:       {tier}

OUTPUT ARTIFACTS:
  {path}  (AC: {ac})  {verify-command or "no verify-command"}
  ...

PREVIOUS EXECUTION:
  Completed:  {completed timestamp}
  MRP:        {mrp-hash or "none found"}
```

If this is already revision 2+, show the revision-log entries as well:

```
REVISION HISTORY:
  Rev 1:  {date}  agent:{agent-id}  outcome: {outcome}  "{revision-reason}"
  ...
```

### Step 3 — Get Reason

If `--reason` was provided, use it. Otherwise ask:

> "What defect was discovered? This will be recorded in the revision-log."

The reason should describe the specific problem, not just "needs fixing."

### Step 4 — Downstream Impact Preview

Before executing the revise, surface the **full ripple** of dependent BPs so the coach decides knowingly. Read `artifacts/briefings/.index.json` and compute:

1. **Direct dependents** (about to be flagged `stale`): BPs whose `dependents` field on this BP's index entry contains them, and whose own status is `completed`, `reviewed`, or `stale` (other statuses are out of scope per design).
2. **Transitive dependents** (potentially affected, *not* flagged): walk the `dependents` graph recursively from each direct dependent. These are not pre-blocked — they only get flagged later if the coach chooses to revise an intermediate BP.

Display:

```
DOWNSTREAM IMPACT
=================

Direct (will be flagged stale on revise):
  bp:{dh} ({dslug})  status: {dstatus} -> stale
  bp:{dh} ({dslug})  status: {dstatus} -> stale
  ...

Transitive (potentially affected; not flagged unless you later revise the intermediate BP):
  bp:{th} ({tslug})  status: {tstatus}    via bp:{dh} -> bp:{th}
  bp:{th} ({tslug})  status: {tstatus}    via bp:{dh} -> bp:{ih} -> bp:{th}
  ...

Skipped (in-flight or pre-execution; out of scope for cascade):
  bp:{sh} ({sslug})  status: {sstatus}    [draft|ready|dispatched|claimed|in-progress]
```

If the lists are empty:

```
DOWNSTREAM IMPACT
=================

No active BPs depend on this one. The revise has no cascade effect.
```

Then ask:

> "Proceed with revise? Direct dependents above will be flagged stale; transitive ones are shown for awareness only."

Wait for confirmation. If the coach declines, stop here.

### Step 5 — Execute Revise Transition

Run the transition script (do NOT manually edit frontmatter):

```
python3 scripts/bp-transition.py revise {bp-hash} --reason "{reason}"
```

This deterministically:
- Sets `status: ready`
- Removes `agent-id`, `claimed`, `completed`, `last-heartbeat`, `phase`, and any pre-existing `stale-because` (if revising a stale BP)
- Appends an entry to `revision-log` with the current agent-id, date, outcome "revised", and the reason
- Increments `revision` (1 -> 2, 2 -> 3, etc.)
- **Cascade-flags direct dependents** in `completed`/`reviewed`/`stale` as `stale`, appending a `stale-because` entry to each
- Regenerates the index and commits (in one commit covering this BP's brief.md plus all flagged dependents' brief.md files)

Display the script output to confirm — note the cascade summary lines listing which dependents were flagged.

### Step 6 — Scope the Re-Execution

Ask the Agent Coach:

> "Do you want to narrow the scope for the next agent, or should it re-execute everything?"
>
> 1. **Narrow scope** — only affected ACs and artifacts (recommended for targeted fixes)
> 2. **Full re-execution** — agent starts from scratch on all ACs

#### If Narrow Scope (Option 1):

Walk through these questions:

1. **Affected ACs:** "Which Acceptance Criteria need re-verification?"
   - List all ACs from the BP body. Let the coach pick which ones are affected.
   - Record as `affected-acs: ["AC-1", "AC-3"]`

2. **Preserve artifacts:** "Which output artifacts from the previous revision are still valid?"
   - List all output artifacts from the BP's `artifacts` field.
   - For each, ask: keep as-is or re-generate?
   - Record as `preserve-artifacts` with path and note.

3. **Re-verify artifacts:** "Which artifacts need to be fixed?"
   - For each artifact that needs re-generation, ask if a `verify-command` should be added (if not already present).
   - Record as `re-verify-artifacts` with path and verify-command.

4. **Reason summary:** Use the reason from Step 3.

Build the `re-execution-scope` block and add it to the BP frontmatter:

```yaml
re-execution-scope:
  reason: "{reason}"
  affected-acs: ["AC-1", "AC-3"]
  preserve-artifacts:
    - path: "src/main/java/com/example/Service.java"
      note: "Code is correct, only build config needs fixing"
  re-verify-artifacts:
    - path: "module/pom.xml"
      verify-command: "mvn validate -N -f module/pom.xml"
```

#### If Full Re-Execution (Option 2):

Do not add `re-execution-scope`. The next agent will execute all ACs and all artifacts from scratch.

### Step 7 — Add verify-commands (Optional)

If the defect could have been caught by a machine-verifiable check, offer to add `verify-command` to the affected output artifacts:

> "The POM defect could have been caught with `mvn validate -N`. Add this as a verify-command to prevent recurrence?"

If the coach agrees, update the `artifacts` field in `brief.md` to include `verify-command` on the relevant output artifacts. Use Edit to modify the frontmatter.

Common verify-commands for reference:
- Build files: `pom.xml` -> `mvn validate -N`, `build.gradle` -> `gradle dependencies`
- Source code: `mvn compile -pl <module>`, `go build ./...`, `tsc --noEmit`
- Structured data: `python3 -c "import json; json.load(open('path'))"`
- Config files: `docker build --check -f path .`, `terraform validate`

### Step 8 — Commit BP Changes

If any changes were made to `brief.md` in Steps 6-7 (re-execution-scope, verify-command):

```
git add {brief.md path}
git commit -m "refine(bp:{hash}): add re-execution-scope and verify-command for revision {new-revision}"
```

### Step 9 — Approve and Offer Dispatch

The BP is now in `ready` status. Ask the coach:

> "BP is revised and ready. What next?"
>
> 1. **Approve and dispatch now** — I'll approve and launch an agent immediately
> 2. **Approve only** — save for later dispatch via `/ace:dispatch`
> 3. **Keep as draft** — I want to make more edits first via `/ace:brief {hash}`

#### If Approve and Dispatch (Option 1):

1. Approve: `python3 scripts/bp-transition.py approve {bp-hash}`
2. Dispatch: `python3 scripts/bp-transition.py dispatch {bp-hash} --push`
3. Read output to get agent-id.
4. Create worktree: `python3 scripts/worktree-ops.py create --agent-id {agent-id} --bp-hash {bp-hash} --push`
5. Start executor agent using the Agent tool with `isolation: "worktree"`.

Report:

```
REVISED AND DISPATCHED
======================

BP:        bp:{hash} ({slug})  revision {new-revision}
Reason:    "{reason}"
Agent:     agt:{agent-id}
Worktree:  .worktrees/{agent-id}-{bp-hash}
Scope:     {narrowed to AC-1, AC-3 | full re-execution}

Monitor with /ace:status. Agent will produce an MRP when done.
```

#### If Approve Only (Option 2):

1. Approve: `python3 scripts/bp-transition.py approve {bp-hash}`

Report:

```
REVISED
=======

BP:        bp:{hash} ({slug})  revision {new-revision}
Status:    ready
Reason:    "{reason}"
Scope:     {narrowed to AC-1, AC-3 | full re-execution}

  -> /ace:dispatch {hash}  (dispatch when ready)
  -> /ace:brief {hash}  (edit BP further)
```

#### If Keep as Draft (Option 3):

Do nothing further. The BP stays in `ready` status from the revise transition.

Report:

```
REVISED (not yet approved)
===========================

BP:        bp:{hash} ({slug})  revision {new-revision}
Status:    ready
Reason:    "{reason}"

  -> /ace:brief {hash}  (edit BP)
  -> /ace:dispatch {hash}  (approve + dispatch when ready)
```

---

## Design Notes

- The `revise` transition preserves full audit history. Each revision cycle is recorded in `revision-log` with the agent-id, date, and reason. This enables complete provenance tracking via `/ace:status audit {hash}`.
- `re-execution-scope` is the key efficiency mechanism — without it, the next agent re-executes everything. With it, the agent can skip plan steps that only produce preserved artifacts.
- `verify-command` additions during revision are preventive — they ensure the same class of defect cannot recur in future revisions or similar BPs.
- **Cascade flagging is lazy:** revise marks only *direct* dependents (BPs that explicitly list this BP in `depends-on`) as `stale`. Indirect dependents are surfaced for visibility but never auto-flagged — they only get flagged when the human chooses to revise an intermediate BP rather than confirming it valid via `/ace:confirm-valid`. This keeps each link in the dependency chain a separate, explicit human decision.
- This command never manually edits BP status fields — all transitions go through `bp-transition.py`.
