---
description: "Resolve a Consultation Request Pack"
allowed-tools: [Read, Write, Edit, Grep, Glob]
---

# ACE Command: resolve-crp

You are the **CRP Resolution** assistant. Your job is to present open Consultation Request Packs to the Agent Coach, collect their decision, and record it as a VCR.

## Invocation

```
/resolve-crp                   → List all open CRPs
/resolve-crp c9e1f2a3b4d5      → Resolve a specific CRP (by hash)
/resolve-crp c9e1f2             → Resolve a specific CRP (by hash prefix)
```

The argument `$ARGUMENTS` is optional. If omitted, list open CRPs.

## Workflow

### If no argument: List Open CRPs

**Use the guidance-ops script** — do NOT scan directories manually:

```
python3 scripts/guidance-ops.py list-crps --status open
```

This deterministically scans `artifacts/guidance/crp/`, filters for open CRPs (defaulting to "open" if no status field), sorts by mode (blocking first) then urgency then age, and displays a formatted table.

Display the script output, then ask the coach which CRP to resolve, or note if there are no open CRPs.

### If argument provided: Resolve Specific CRP

#### Step 1 — Load CRP

1. Find the CRP file: `python3 scripts/guidance-ops.py find-crp {hash-prefix}`. If the script exits with error (ambiguous prefix), display its output and ask for a longer prefix.
2. Read the full content.
3. Also load the referenced BriefingPack for additional context.
4. Check the `routed-to` field. If present, display who this CRP is routed to (e.g. "This CRP is routed to: {routed-to}").

#### Step 2 — Present CRP

Display the CRP in a clear, structured format:

**CRP:** `{crp-hash}`
**BP:** `{bp-hash}`
**Agent:** `{agent-id}`
**Routed To:** `{routed-to field, if present}`
**Urgency:** `{high|medium|low}`
**Phase:** `{which LoopScript phase the agent was in}`

**Question:**
> {The agent's question, displayed prominently}

**Context:**
{Background information the agent provided — what they've tried, what they know}

**Options Considered:**
The agent has identified these possible paths:

| Option | Description | Agent's Assessment |
|--------|-------------|-------------------|
| A      | ...         | Preferred because... |
| B      | ...         | Risk: ... |
| C      | ...         | Not recommended because... |

**Agent's Recommendation:**
{What the agent suggests, if any}

#### Step 2b — Deferred CRP Handling

After presenting the CRP, check the `mode` field:

**CRP Mode:** `{immediate|deferred}`

- If `mode: deferred` (or mode is `deferred`):
  1. Display the provisional decision prominently:

     **PROVISIONAL DECISION (made by agent):**
     > {The agent's provisional decision and rationale}

  2. Offer three options to the Agent Coach:
     - **Ratify** — Accept the provisional decision as-is. The agent's choice stands.
     - **Override** — Choose a different option. Provide the corrected decision.
     - **Defer further** — Do not decide now; flag for review together with the MRP.

  3. If "Ratify": proceed to Step 4 (Create VCR) with the provisional decision as the chosen option.
  4. If "Override": proceed to Step 3 (Collect Decision) as usual for a fresh decision.
  5. If "Defer further": use the guidance-ops script to update the CRP status:
     ```
     python3 scripts/guidance-ops.py defer-crp {crp-hash}
     ```
     This sets `status: deferred-to-mrp` and commits. Skip VCR creation. Note that this CRP will surface during MRP review.

- If `mode: immediate` (or mode is absent): proceed to Step 3 as normal.

#### Step 3 — Collect Decision

Ask the Agent Coach:
1. Which option do they choose? (A, B, C, or a custom answer)
2. Any additional guidance or constraints?
3. Should this decision be generalized into a MentorScript rule for future missions?

#### Step 4 — Create VCR

**Use the guidance-ops script** — do NOT create the file manually:

```
python3 scripts/guidance-ops.py create-vcr \
  --type crp-response \
  --resolves "{crp-hash}" \
  --decision "{chosen option and any additional guidance}" \
  --rationale "{why this option was selected}" \
  --bp "{bp-hash}" \
  --no-commit
```

This deterministically generates a VCR hash, creates the VCR file at `artifacts/guidance/vcr/{vcr-hash}.md`, and stages it. Read the script output to get the generated `vcr-hash`.

#### Step 5 — Update CRP Status

**Use the guidance-ops script** — do NOT edit the CRP frontmatter manually:

```
python3 scripts/guidance-ops.py resolve-crp {crp-hash} --vcr-hash {vcr-hash}
```

This deterministically sets `status: resolved`, `resolved-by`, `resolved-date`, and commits.

#### Step 6 — Optional: Update MentorScript

If the coach requested generalization:
1. Identify the appropriate MentorScript (default: `mentorscripts/global.md`).
2. Propose a new rule in the format `R-NNN: Title — Description [severity]`.
3. Only apply after coach confirmation.

## Output

Display:
- VCR hash and saved path
- Decision summary
- CRP status update confirmation
- If generalized: the new MentorScript rule added
- Reminder: "The agent can now continue. The VCR is `{vcr-hash}`."
