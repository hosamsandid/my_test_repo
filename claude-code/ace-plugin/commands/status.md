---
description: "Actionable status -- open escalations, pending reviews, active Agents, inline resolution"
allowed-tools: [Read, Write, Edit, Grep, Glob]
---

# Command: status

You are the **Status Reporter**. Your job is to scan all i-SASE artifacts and present an actionable overview -- prioritized by what needs the Agent Coach's attention right now.

This is the primary status view. It focuses on **actionable items with inline command suggestions**, not just raw data. It also supports inline CRP resolution, inline MRP approval, BP detail views, BP cancellation, and filtered views.

## Invocation

```
/status                        → Full actionable status
/status --crps                 → Only open/blocked CRPs
/status --mrps                 → Only pending MRPs
/status --active               → Only active (in-progress) BPs
/status b8d4e2                 → Detail view for a specific BP (hash prefix)
/status cancel b8d4e2          → Cancel a dispatched BP
/status release b8d4e2         → Release a stale agent lock
/status audit a3f7c2           → Provenance view for a BP
```

The argument `$ARGUMENTS` determines the mode.

## Argument Parsing

Parse `$ARGUMENTS` to determine the mode:

1. **No arguments** (empty or blank) → Full status report (all sections)
2. **`--crps`** → Show only Priority 1a (Open CRPs section), plus Quick Stats
3. **`--mrps`** → Show only Priority 1b (Pending MRPs section), plus Quick Stats
4. **`--active`** → Show only Priority 2 (In-Progress Work section), plus Quick Stats
5. **Hex hash prefix** (e.g. `b8d4e2`) → BP Detail View (search `artifacts/briefings/` for matching directory)
6. **Starts with `cancel`** + hex hash (e.g. `cancel b8d4e2`) → BP Cancel
7. **Starts with a CRP hash followed by an answer** (e.g. `c9e1f2a3b4d5 A`) → Inline CRP Resolution
8. **Starts with `approve`** + MRP hash (e.g. `approve d7a2c1e8f3b6`) → Inline MRP Approval
9. **Starts with `release`** + hash (e.g. `release b8d4e2`) → Release stale agent lock
10. **Starts with `audit`** + hash (e.g. `audit a3f7c2`) → Provenance view for a BP
11. **Starts with `archive`** + hash (e.g. `archive a3f7c2`) → Archive a completed BP tree

If arguments do not match any pattern, show a brief usage hint and fall back to the full status report.

---

## Workflow: Full Status Report

When no arguments or no recognized filter is given, compile the status report in strict priority order.

### Step 0 -- Collect All Data via Script

**Use the status report script** — do NOT scan directories manually:

```
python3 scripts/status-report.py
```

This deterministically collects ALL data needed for the status report in one pass:
- Open CRPs (sorted by urgency: blocking first, then by age; stale > 24h flagged)
- Pending MRPs (no corresponding VCR, with auto-approval eligibility check)
- Active BPs (from index, with stale heartbeat detection > 3h)
- Ready BPs (from index)
- Quick stats (counts by category)

The script regenerates the index, scans CRP/MRP/VCR directories, and outputs structured JSON.

For filtered views, pass the matching flag:
- `python3 scripts/status-report.py --crps` (CRPs only + stats)
- `python3 scripts/status-report.py --mrps` (MRPs only + stats)
- `python3 scripts/status-report.py --active` (active BPs only + stats)
- `python3 scripts/status-report.py --text` (pre-formatted human-readable output)

Read the JSON output and use it to render the sections below. Only read individual `brief.md` files when a detail view is requested (`/status {hash}`).

---

### Priority 1 -- Items Needing Your Attention

These are blocking items. Present them first, always.

#### 1a. Open CRPs

Read `crps.open` from the status report JSON (already sorted by: blocking first, then urgency, then oldest first).

```
BLOCKED -- Agents waiting on you
---------------------------------

c9e1f2a3b4d5  [BLOCKING]  bp:b8d4e2f1a7c3  agt:1a2b3c4d  "Which auth provider to use?"  (2h ago)
  -> /ace:resolve-crp c9e1f2a3b4d5
  -> or type: c9e1f2a3b4d5 A  (to resolve inline — see options below)

d7a2c1e8f3b6  [MED]   bp:b8d4e2f1a7c3  agt:1a2b3c4d  "Cache TTL for session data?"  (5h ago)
  -> /ace:resolve-crp d7a2c1e8f3b6
  -> or type: d7a2c1e8f3b6 B  (to resolve inline)
```

For each CRP with options, show a compact option summary beneath:

```
  Options: A) Simple format  B) With timestamp  C) Custom  |  Agent recommends: A
```

Flag any CRP older than 24 hours with `[STALE]`. These are actively blocking agent progress.

**Inline Resolution Prompt:**
After listing all open CRPs, display:

```
Quick resolve: type a CRP hash + option letter (e.g. "c9e1f2a3b4d5 A") to resolve inline.
```

If no open CRPs: "No blocked agents. All CRPs resolved."

#### 1b. Pending MRPs

Read `mrps.pending` from the status report JSON. The script has already:
- Cross-referenced MRPs with VCRs to find those without a review
- Extracted AC completion rates and auto-score
- Checked for security-related CRPs per BP
- Computed auto-approval eligibility (`auto-score >= 90`, no security CRPs, all ACs passed)

```
REVIEW NEEDED -- BPs awaiting your decision
--------------------------------------------------

e4b1d8c2f7a3  bp:b8d4e2f1a7c3  agt:1a2b3c4d  "Add auth middleware"  AC: 5/5  Score: 95
  [auto-approve eligible] → type: approve e4b1d8c2f7a3  |  or: /ace:review-mrp e4b1d8c2f7a3

f5a9c3d2e8b1  bp:c7e3a1d4f2b8  agt:5e6f7a8b  "Refactor DB layer"    AC: 3/4  Score: 72
  -> /ace:review-mrp f5a9c3d2e8b1
  -> or type: approve f5a9c3d2e8b1  (to approve without full review)
```

For auto-approve eligible MRPs, show the eligibility tag prominently. For non-eligible MRPs, show a compact score summary:

```
  Scores: completeness=pass  verification=pass  hygiene=partial  rationale=pass  audit=pass
```

**Inline Approval Prompt:**
After listing all pending MRPs, display:

```
Quick approve: type "approve {mrp-hash}" to approve inline.  Or use /ace:review-mrp for full review.
```

If no pending MRPs: "No MRPs awaiting review."

---

### Priority 2 -- In-Progress Work

Active BPs that are running and do not need immediate attention.

Read `active_bps.items` from the status report JSON. The script has already:
- Collected all BPs with status `dispatched`, `claimed`, or `in-progress` from the index
- Computed heartbeat age and stale detection (> 3 hours without heartbeat)
- Included agent-id, phase, rigor, and branch info

For each active BP, you may optionally enrich the display by:
1. Reading the BP's LoopScript to determine **total phase count**.
2. Checking `git show` on the agent branch for the latest phase if the index data seems stale.
3. Running `git worktree list` to verify local worktree presence.

```
IN PROGRESS
-----------

b8d4e2f1a7c3  "Add auth middleware"    [high rigor]  Tier 3  agt:1a2b3c4d
  Phase 3/5: implement  (started 2h 14m ago)  |  CRPs: 1 open, 2 resolved
  BP: bp:a3f7c2 (auth-middleware)  |  worktree: .worktrees/1a2b3c4d-a3f7c2e1b9d4  |  dispatched 2026-03-10

c7e3a1d4f2b8  "Refactor DB layer"     [standard]    Tier 2  agt:5e6f7a8b
  Phase 4/5: verify  (started 35m ago)  |  CRPs: 0/0
  BP: bp:d2c8b4 (db-refactor)  |  worktree: .worktrees/5e6f7a8b-d2c8b4a1e7f3  |  dispatched 2026-03-11
  -> /ace:status c7e3a1d4f2b8  (detail view)
```

For each BP, check if any CRPs are open (if so, mark it as `[PARTIALLY BLOCKED]`). If `last-heartbeat` is stale, show `[STALE LOCK] -> /ace:status release {bp-hash}` to allow the coach to release the lock.

If no active BPs: "No BPs in progress."

---

### Priority 3 -- Ready for Dispatch

BriefingPacks waiting to be sent to an agent.

Read `ready_bps.items` from the status report JSON (already filtered for `status: ready`, `.archive/` excluded).

```
READY TO DISPATCH
-----------------

bp:e1f2a3 (caching-layer)  "Implement caching layer"   created 2026-03-10
  -> /ace:dispatch e1f2a3b4c5d6
  -> or /ace:brief e1f2a3 to edit first

bp:f7a8b9 (rate-limiting)  "Add rate limiting"          created 2026-03-12
  -> /ace:dispatch f7a8b9c1d2e3
```

Also check the status report's `stats.parent_derived` count. Parent status is derived automatically from children — show the tree with child statuses from the index:

```
PARENT BPs
-----------

bp:a1b2c3 (api-overhaul)  "Full API overhaul"  [3 children, status: draft (derived)]
  execution-order:
    1. bp:d7e8f9 (auth-endpoints)  "Auth endpoints"     status: ready
       -> /ace:dispatch d7e8f9a1b2c3
    2. bp:e4f5a6 (data-endpoints)  "Data endpoints"     status: ready  depends-on: d7e8f9a1b2c3
    3. bp:f1a2b3 (admin-endpoints) "Admin endpoints"    status: draft
       -> /ace:brief f1a2b3 to finish drafting
```

If nothing ready: "No BPs ready for dispatch. Use `/ace:brief` to create one."

---

### Quick Stats

Always show this summary at the end (also shown for filtered views):

```
STATS
-----
Active:    {N} in-progress  |  {N} completed  |  {N} total dispatched
CRPs:      {N} open ({N} blocking)  |  {N} resolved
MRPs:      {N} pending review ({N} auto-approve eligible)  |  {N} reviewed
BPs:       {N} ready  |  {N} draft  |  {N} dispatched  |  {N} parent (derived)
```

---

## Workflow: Inline CRP Resolution

Triggered when `$ARGUMENTS` matches pattern: `{crp-hash} {answer}` (e.g. `c9e1f2a3b4d5 A`). The hash can be a unique prefix.

### Steps

#### Step 1 -- Load CRP

1. Extract the CRP hash (or prefix) and the answer from the arguments.
2. Find the CRP: `python3 scripts/guidance-ops.py find-crp {hash-prefix}`. If ambiguous, display the error and ask for a longer prefix.
3. Verify `status: open`. If already resolved, inform the user and stop.

#### Step 2 -- Present Compact CRP Summary

Display a brief summary of the CRP for confirmation:

```
RESOLVING c9e1f2a3b4d5
------------------------
BP:       bp:b8d4e2 (auth-middleware)
Agent:    1a2b3c4d
Question: "Which auth provider to use?"
Options:  A) OAuth2  B) API Key  C) Custom JWT
Agent recommends: A

Your answer: A (OAuth2)
```

#### Step 3 -- Confirm and Create VCR

Ask: "Confirm resolution with Option A? Any additional guidance? [y/n/guidance text]"

If confirmed (user responds with "y", "yes", or just presses enter):

1. **Create VCR** using the guidance-ops script:
   ```
   python3 scripts/guidance-ops.py create-vcr \
     --type crp-response \
     --resolves "{crp-hash}" \
     --decision "Resolved inline via /status. Selected Option {X}: {description}. {additional guidance}" \
     --rationale "Inline resolution by {git config user.name}." \
     --bp "{bp-hash}" \
     --no-commit
   ```
   Read the output to get the generated `vcr-hash`.

2. **Update CRP status** using the guidance-ops script:
   ```
   python3 scripts/guidance-ops.py resolve-crp {crp-hash} --vcr-hash {vcr-hash}
   ```
   This sets `status: resolved`, `resolved-by`, `resolved-date`, commits, and stages both files.

4. **Confirm to user**:

```
Done. c9e1f2a3b4d5 resolved.
  VCR: {vcr-hash} (saved to artifacts/guidance/vcr/)
  CRP status: resolved
  The agent can now continue.
```

---

## Workflow: Inline MRP Approval

Triggered when `$ARGUMENTS` matches pattern: `approve {mrp-hash}` (e.g. `approve e4b1d8c2f7a3`). The hash can be a unique prefix.

### Steps

#### Step 1 -- Load MRP

1. Extract the MRP hash (or prefix) from the arguments.
2. Find the MRP: `python3 scripts/guidance-ops.py find-mrp {hash-prefix}`. If ambiguous, display the error and ask for a longer prefix.
3. Verify it has no corresponding VCR yet. If already reviewed, inform the user and stop.
4. Load the associated BriefingPack for context.

#### Step 2 -- Present Compact MRP Summary

Display a brief summary:

```
APPROVING e4b1d8c2f7a3
------------------------
BP:       bp:b8d4e2 (auth-middleware)  "Add auth middleware"
Agent:    1a2b3c4d
AC:       5/5 satisfied
Score:    95
Tier:     standard
```

If auto-approve eligible (score >= 90, no security CRPs, tests pass):
```
[auto-approve eligible] All quality gates passed.
```

If NOT auto-approve eligible, show a warning:
```
[manual review recommended] Score: 72  |  Issues: hygiene=partial, AC: 3/4
Approving without full review. Proceed? [y/n]
```

#### Step 3 -- Confirm and Create VCR

Ask: "Approve this MRP? [y/n]"

If confirmed:

1. **Create VCR** using the guidance-ops script:
   ```
   python3 scripts/guidance-ops.py create-vcr \
     --type mrp-approval \
     --resolves "{mrp-hash}" \
     --decision "Approved." \
     --rationale "Approved inline via /status command by {git config user.name}." \
     --bp "{bp-hash}" \
     --no-commit
   ```
   Read the output to get the generated `vcr-hash`.

2. **Update MRP status** using the guidance-ops script:
   ```
   python3 scripts/guidance-ops.py update-mrp {mrp-hash} --status approved --no-commit
   ```

4. **Update BP status** using the transition script (do NOT manually edit frontmatter):
   ```
   python3 scripts/bp-transition.py review {bp-hash} --no-commit
   ```
   (Use `--no-commit` because we'll commit together with the merge.)

5. **Merge agent branch** using the merge script:
   ```
   python3 scripts/merge-agent-work.py --agent-id {agent-id} --bp-hash {bp-hash}
   ```

6. **Cleanup worktree** using the worktree-ops script:
   ```
   python3 scripts/worktree-ops.py cleanup --agent-id {agent-id} --bp-hash {bp-hash} --delete-remote
   ```

7. **Confirm to user**:

```
Done. e4b1d8c2f7a3 approved.
  VCR: {vcr-hash} (saved to artifacts/guidance/vcr/)
  MRP status: approved
  BP bp:{bp-hash}: reviewed
  Branch agent/{agent-id}/{bp-hash} merged to main. Worktree cleaned up.
```

If user declines, suggest: "Use `/ace:review-mrp e4b1d8c2f7a3` for a full review."

---

## Workflow: BP Detail View

Triggered when `$ARGUMENTS` is a hex hash prefix (e.g. `b8d4e2`).

### Steps

**Use the bp-info and guidance-ops scripts** — do NOT manually search directories or parse frontmatter:

1. **Load BP info**: `python3 scripts/bp-info.py {hash-prefix} --with-guidance --with-branch`
   If exit code 1 (not found) or 2 (ambiguous), display the error output.
   The JSON includes: hash, slug, status, rigor, agent-id, phase, heartbeat, resolved loopscript, CRP/MRP counts, branch info with modified files.
2. **Load CRP details** (if needed): `python3 scripts/guidance-ops.py list-crps --bp {bp-hash} --json`

Display:

```
BP DETAIL: bp:a3f7c2 (auth-middleware)
=======================================

Title:        "Add auth middleware"
BP:           bp:a3f7c2 (auth-middleware)
Agent:        agt:1a2b3c4d
Worktree:     .worktrees/1a2b3c4d-a3f7c2e1b9d4
Branch:       agent/1a2b3c4d/a3f7c2e1b9d4
Tier:         3 (mission)
Rigor:        high
Status:       in-progress
Dispatched:   2026-03-10  (6 days ago)

PROGRESS
--------
Phase 3/5: implement
  1. understand   [done]
  2. plan          [done]
  3. implement     [IN PROGRESS]  (started 2h 14m ago)
  4. verify        [pending]
  5. review        [pending]

CRPs
-----
c9e1f2a3b4d5  [BLOCKING]  "Which auth provider?"     status: open
d7a2c1e8f3b6  [MED]       "Cache TTL?"               status: resolved  (vcr:a1b2c3d4e5f6)

FILES MODIFIED (from agent branch diff)
----------------------------------------
{List files from `git diff main...origin/agent/{agent-id}/{bp-hash}`}

ACTIONS
-------
  -> /ace:resolve-crp c9e1f2a3b4d5  (resolve blocking CRP)
  -> /ace:status cancel a3f7c2  (cancel this BP)
  -> /ace:status release a3f7c2  (release stale lock, if applicable)
  -> /ace:status audit a3f7c2  (view BP provenance)
```

If the BP hash is not found, display: "BP {hash} not found. Use `/ace:status --active` to list in-progress BPs."

---

## Workflow: BP Cancel

Triggered when `$ARGUMENTS` matches pattern: `cancel {bp-hash}` (e.g. `cancel a3f7c2`). The hash can be a unique prefix.

### Steps

1. **Load BP info**: `python3 scripts/bp-info.py {hash-prefix} --with-guidance --json`
   If exit code 1/2, display error. Check the `is_cancellable` field — if `false`, inform user and stop.
2. **Confirm**: Display (using fields from the JSON output):

```
CANCEL: bp:a3f7c2 (auth-middleware)
-------------------------------------
Title:   "Add auth middleware"
Agent:   agt:1a2b3c4d
Worktree: .worktrees/1a2b3c4d-a3f7c2e1b9d4
Branch:  agent/1a2b3c4d/a3f7c2e1b9d4
Phase:   3/5 implement
CRPs:    1 open, 2 resolved

Are you sure you want to cancel this BP? [y/n]
```

4. If confirmed:
   - **Remove worktree**: `python3 scripts/worktree-ops.py cleanup --agent-id {agent-id} --bp-hash {bp-hash}`
   - **Run transition script** (do NOT manually edit frontmatter):
     ```
     python3 scripts/bp-transition.py cancel {bp-hash}
     ```
     This deterministically resets status to `ready`, removes `agent-id`/`claimed` fields, commits, and regenerates the index.
   - **Report**:

```
Done. bp:a3f7c2 (auth-middleware) cancelled.
  BP status: ready (available for re-dispatch)
  Open CRPs remain on file but are no longer blocking.
  Worktree .worktrees/1a2b3c4d-a3f7c2e1b9d4 removed.
  Agent branch agent/1a2b3c4d/a3f7c2e1b9d4 left intact (delete manually if desired).
```

If user declines, do nothing.

---

## Workflow: Stale Lock Release

Triggered when `$ARGUMENTS` matches pattern: `release {bp-hash}` (e.g. `release a3f7c2`).

### Steps

1. **Load BP info**: `python3 scripts/bp-info.py {hash-prefix} --json`
   If exit code 1/2, display error. Check the `is_stale` field and `heartbeat_age_minutes`.
   If `is_stale` is `false` or `null`, warn: "This agent appears active. Are you sure you want to release the lock?"
2. **Confirm**: Display (using fields from the JSON output):

```
RELEASE LOCK: b8d4e2f1a7c3
-----------------------------
Agent:          agt:1a2b3c4d
Worktree:       .worktrees/1a2b3c4d-a3f7c2e1b9d4
Branch:         agent/1a2b3c4d/a3f7c2e1b9d4
Last heartbeat: 2026-03-16T10:30:00Z (45 min ago) [STALE]

Release this lock so the BP can be re-dispatched? [y/n]
```

4. If confirmed:
   - **Remove worktree**: `python3 scripts/worktree-ops.py cleanup --agent-id {agent-id} --bp-hash {bp-hash}`
   - **Run transition script** (do NOT manually edit frontmatter):
     ```
     python3 scripts/bp-transition.py release {bp-hash} --reason "stale lock released by {git config user.name}"
     ```
     This deterministically resets status to `ready`, removes `agent-id`/`claimed` fields, adds `abandoned-date`/`abandoned-reason`, commits, and regenerates the index.
   - **Report**:

```
Done. Lock released for bp:a3f7c2 (auth-middleware).
  BP status: ready (available for re-dispatch)
  Worktree removed. Agent branch left intact for forensic review.
```

---

## Workflow: Provenance View

Triggered when `$ARGUMENTS` matches pattern: `audit {bp-hash}` (e.g. `audit a3f7c2`).

### Steps

**Use the audit script** — do NOT manually scan directories or build timelines:

```
python3 scripts/audit-bp.py {hash-prefix}
```

This deterministically: finds the BP (in both active and archive), scans all CRPs/MRPs/VCRs for this BP, builds a chronological timeline, and outputs a formatted provenance report. Also searches archive for historical BPs.

For JSON output: `python3 scripts/audit-bp.py {hash-prefix} --json`

Display the script output. The formatted text output already matches the required format:

```
PROVENANCE: bp:a3f7c2 (auth-middleware)
========================================

BP: bp:a3f7c2 (auth-middleware)  "Add auth middleware"
Created: 2026-03-10  |  Status: dispatched

TIMELINE
--------
2026-03-10  BP created by {git config user.name}
2026-03-10  Dispatched to agent: 1a2b3c4d (worktree: .worktrees/1a2b3c4d-a3f7c2e1b9d4)
2026-03-10  CRP c9e1f2a3b4d5 opened: "Which auth provider?"
2026-03-11  CRP c9e1f2a3b4d5 resolved via VCR a1b2c3d4e5f6
2026-03-12  MRP e4b1d8c2f7a3 submitted
2026-03-12  MRP approved via VCR b7c8d9e1f2a3

RELATED ARTIFACTS
-----------------
CRPs:      c9e1f2a3b4d5 (resolved)
MRPs:      e4b1d8c2f7a3 (approved)
VCRs:      a1b2c3d4e5f6, b7c8d9e1f2a3
```

---

## Workflow: Archive Completed BP

Triggered when arguments match: `archive {bp-hash}`

**Delegate to the dedicated archive command:** Invoke `/archive {bp-hash}` which handles all validation, filesystem operations, and git commits via `scripts/bp-transition.py archive`. See `commands/archive.md` for full details.

---

## Output Format

- Use the compact format shown above, not markdown tables.
- Every actionable item gets an inline `->` command suggestion.
- For a browsable listing of all BPs, see `artifacts/briefings/INDEX.md` (auto-generated on every BP change).
- For filtered views (`--crps`, `--mrps`, `--active`), show only the requested section plus Quick Stats.
- If there are zero items in Priority 1, skip the header but still mention it: "Nothing needs your attention right now."
- If the entire system is empty (no artifacts at all), display:

```
No BPs or artifacts found.

Get started:
  /do {task}     → Quick fix (Tier 1, no ceremony)
  /brief {task}  → Plan and execute (Tier 2/3, agent-drafted BP)
```

## Design Notes

This command prioritizes actionable items over comprehensive data:
- Items needing attention appear first (open CRPs, pending MRPs).
- Every actionable item gets an inline command suggestion.
- Inline resolution/approval reduces context switches -- the coach can handle simple items without leaving /status.
- Auto-approve eligibility is surfaced prominently to reduce review fatigue.
- Progress feedback (phase N/M with timing) gives an at-a-glance sense of where BPs stand.
- BP detail and cancel provide deeper control without switching commands.
- Empty states show getting-started guidance rather than empty tables.
- Filtered views let experienced users cut straight to what they care about.
