---
description: "Review a Merge-Readiness Pack and create VCR"
allowed-tools: [Read, Write, Edit, Grep, Glob, Agent]
---

# ACE Command: review-mrp

You are the **MRP Review** assistant. Your job is to present a Mission Review Protocol to the Agent Coach, facilitate evaluation against the 5 quality criteria, and record the decision as a VCR.

## Invocation

```
/review-mrp                  → List all pending MRPs
/review-mrp e4b1d8c2f7a3     → Review a specific MRP (by hash)
/review-mrp e4b1d8           → Review a specific MRP (by hash prefix)
```

The argument `$ARGUMENTS` is optional. If omitted, list pending MRPs.

## Workflow

### If no argument: List Pending MRPs

**Use the guidance-ops script** — do NOT scan directories manually:

```
python3 scripts/guidance-ops.py list-mrps --pending
```

This deterministically scans `artifacts/guidance/mrp/`, cross-references VCRs to find unreviewed MRPs, and displays a formatted table.

Display the script output, then ask the coach which MRP to review.

### If argument provided: Load and Review

#### Step 1 — Load MRP

1. Find the MRP file: `python3 scripts/guidance-ops.py find-mrp {hash-prefix}`. If the script exits with error (ambiguous prefix), display its output and ask for a longer prefix.
2. Read the MRP file at the path from step 1.
3. Load the associated BriefingPack: `python3 scripts/bp-info.py {bp-hash} --with-guidance --json`. This provides all BP fields (rigor, status, CRP counts, etc.) without manual frontmatter parsing.
4. Check the `reviewers` field in the MRP. If present, verify you are in the reviewers list. Track `reviewed-by` to record who performed this review.

#### Step 1b — Tier-Aware Review

After loading the MRP, read the `tier` field from the associated BriefingPack:

- **Tier 1 (`task`):** Inform the Agent Coach: "Tier 1 tasks don't produce formal MRPs. If this MRP exists, it is informational only." Offer to dismiss or review briefly.
- **Tier 2 (`story`) with auto-approval eligible:** If the MRP's overall score >= 90, no security-related CRPs were raised, and all tests pass — show a compact summary view and ask: "This MRP qualifies for auto-approval (score >= 90, no security issues, tests pass). **Approve automatically** or **review in detail**?" If auto-approved, skip to Step 5 (Create VCR) with decision `approved`.
- **Tier 2 (`story`) without auto-approval:** Show a compact review — present each criterion with its score and a one-line summary. Proceed to Step 4 for decision.
- **Tier 3 (`mission`):** Full review with no changes — proceed to Step 2 as defined below.

#### Step 1c — Deferred CRP Review

Before evaluating the MRP criteria, check for deferred CRPs associated with this BP:

```
python3 scripts/guidance-ops.py list-crps --bp {bp-hash} --mode deferred --json
```

This returns only deferred CRPs for this BP. The script handles all filtering deterministically.

If deferred CRPs exist:
1. List each deferred CRP with its provisional decision:

   **Deferred CRPs requiring your review:**

   | CRP Hash      | Question (short) | Provisional Decision | Phase |
   |---------------|-----------------|---------------------|-------|
   | c9e1f2a3b4d5  | ...             | ...                 | ...   |

2. For each deferred CRP, ask the Agent Coach to:
   - **Ratify** — Accept the provisional decision.
   - **Override** — Provide a corrected decision (creates a VCR).
   - **Flag** — Mark as a concern affecting MRP approval.

3. Any "Flag" items should be noted as issues in the MRP review criteria (especially under "Clear Rationale" and "Full Auditability").

If no deferred CRPs: proceed without comment.

#### Step 2 — Present the 5 Criteria

Display the MRP organized by the **5 Merge-Readiness Criteria**:

**1. Functional Completeness**
- Are all Acceptance Criteria from the BP checked off?
- Show the AC checklist with agent's reported status for each.

**2. Sound Verification**
- What tests were run? Do they pass?
- Is test coverage adequate for the changes?
- Were edge cases from the BP's Gotchas section addressed?

**3. Software Engineering Hygiene**
- Code style, naming conventions, documentation.
- No leftover debug code, TODOs, or commented-out blocks.
- MentorScript rules were followed (list any flagged violations).

**4. Clear Rationale**
- Did the agent explain its design decisions?
- Were any deviations from the BP's Strategy justified?
- Are CRP references included where applicable?

**5. Full Auditability**
- Is there a complete trail from BP to deliverables?
- Are all CRPs referenced and resolved?
- Is the MRP itself complete and well-structured?

#### Step 3 — Automated Scoring (Optional)

Offer to run a quality-gate analysis using the Agent tool:
- Parse test results if available
- Check AC completion rate
- Verify MentorScript compliance
- Produce a preliminary score per criterion (pass / partial / fail)

#### Step 4 — Agent Coach Decision

Present three options:

1. **Approve** — All criteria met. Mission is complete.
2. **Reject** — Fundamental issues. Mission needs rework from scratch or major revision.
3. **Request Revision** — Specific issues identified. Agent should address them and resubmit MRP.

For options 2 and 3, ask the coach to specify:
- Which criteria failed
- What specific feedback to give the agent
- Priority of revisions

#### Step 5 — Create VCR

**Use the guidance-ops script** — do NOT create the VCR file manually:

```
python3 scripts/guidance-ops.py create-vcr \
  --type {mrp-approval|mrp-rejection|mrp-revision} \
  --resolves "{mrp-hash}" \
  --decision "{approved|rejected|revision-requested}: {coach's explanation}" \
  --rationale "{coach's rationale with criteria assessment}" \
  --bp "{bp-hash}" \
  --no-commit
```

Read the output to get the generated `vcr-hash`. Then update MRP status:

```
python3 scripts/guidance-ops.py update-mrp {mrp-hash} --status {approved|rejected|revision-requested} --no-commit
```

Both files are staged but not committed — they will be committed together with the BP status update / merge in Step 6.

#### Step 5b — Outcome Log

**Use the guidance-ops script** — do NOT manually append to the log:

```
python3 scripts/guidance-ops.py log-outcome --bp "{bp-hash}" --agent "{agent-id}" --decision {approved|rejected|revision-requested} --score "{auto-score or N/A}"
```

This deterministically appends a timestamped entry to `artifacts/log/outcomes.log`, creating the file and directory if needed.

#### Step 6 — Update BP Status and Merge

- If approved:
  1. **Update BP status** using the transition script (do NOT manually edit frontmatter):
     ```
     python3 scripts/bp-transition.py review {bp-hash} --no-commit
     ```
     (Use `--no-commit` because we'll commit together with the merge.)
  2. **Merge agent work** using the merge script (do NOT run git merge commands manually):
     - **Direct merge** (default):
       ```
       python3 scripts/merge-agent-work.py --agent-id {agent-id} --bp-hash {bp-hash}
       ```
     - **PR-based merge** (when branch protection requires PRs):
       ```
       python3 scripts/merge-agent-work.py --agent-id {agent-id} --bp-hash {bp-hash} --slug {slug} --title "{bp-title}" --pr-mode
       ```
     The script outputs JSON with `merged` (boolean) and `pr_url` (if PR mode) fields. **Read the JSON output** to determine what actually happened — do NOT assume the merge succeeded.
  3. **Cleanup worktree** using the worktree-ops script:
     ```
     python3 scripts/worktree-ops.py cleanup --agent-id {agent-id} --bp-hash {bp-hash} --delete-remote
     ```
- If rejected: Run `python3 scripts/bp-transition.py cancel {bp-hash}` to reset status to `ready`. Then cleanup: `python3 scripts/worktree-ops.py cleanup --agent-id {agent-id} --bp-hash {bp-hash} --delete-remote`.
- If revision requested: BP status remains unchanged (`dispatched` or `in-progress` — agent continues in same worktree).

## Output

Display:
- VCR hash and saved path
- Decision summary
- If approved, report the **actual** merge outcome from the script's JSON output:
  - If `merged: true`: "Agent branch merged to main. Worktree cleaned up. Remote branch deleted."
  - If `merged: false` and `pr_created: true`: "PR created at {pr_url} — **merge pending** (requires manual merge or CI approval). Worktree cleaned up."
  - If `merged: false` and `pr_created: false`: "Merge and PR creation failed. Agent branch pushed to `{pr_branch}` — create and merge PR manually."
  - **Never say "merged to main" unless the script confirmed `merged: true`.**
- If revision requested: list the specific items the agent must address
