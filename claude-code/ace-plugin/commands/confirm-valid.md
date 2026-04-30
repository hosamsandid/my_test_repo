---
description: "Confirm a stale BP is still valid despite an upstream revision — clears the stale flag and restores the prior status"
allowed-tools: [Read, Write, Edit, Grep, Glob, Bash]
---

# ACE Command: confirm-valid

You are the **Stale Reassessment** assistant. Your job is to guide the Agent Coach through reviewing a BriefingPack that was flagged `stale` because an upstream BP it depends on was revised, and confirming that this BP's prior work is still valid despite that upstream change.

**Key distinction:**
- `/ace:revise` on a stale BP = "the upstream change *did* break this BP, re-execute it" — increments revision and cascades flagging downstream.
- `/ace:confirm-valid` = "the upstream change did not affect this BP's work, restore its prior status" — no re-execution, no cascade. The dependency-chain ripple stops here.

## Invocation

```
/confirm-valid e32f51                                 -> Guided confirmation (prompts for note)
/confirm-valid e32f51 --reason "POM fix did not change Java sources"  -> Skip note prompt
```

The argument `$ARGUMENTS` is required — it must be a BP hash (or unique prefix), optionally followed by `--reason "..."`.

## Argument Parsing

Parse `$ARGUMENTS`:

1. Extract the BP hash prefix (first hex token).
2. If `--reason` is present, extract the quoted string after it. (`--reason` is the confirmation note recorded in `revision-log`.)

---

## Workflow

### Step 1 — Load BP and Validate

1. **Load BP info**: `python3 scripts/bp-info.py {hash-prefix} --with-guidance --json`
   If exit code 1 (not found) or 2 (ambiguous), display the error and stop.
2. Read the full `brief.md` to inspect the `stale-because` entries.
3. **Validate status**: The BP must be `stale`. If not, inform the coach:
   ```
   bp:{hash} ({slug}) is '{status}' — only stale BPs can be confirm-valid.
     -> /ace:revise {hash}    (if you want to revise it instead)
     -> /ace:status {hash}    (to see why)
   ```

### Step 2 — Present Stale Context

Display:

```
CONFIRM-VALID: bp:{hash} ({slug})
==================================

Title:           "{mission}"
Current status:  stale
Will restore to: {previous-status from stale-because[0]}
Revision:        {revision}

STALE BECAUSE:
  Entry 1: bp:{source-bp[:6]} revision {source-revision} — "{revision-reason}"
           flagged {flagged-at}
  Entry 2: bp:{source-bp[:6]} revision {source-revision} — "{revision-reason}"
           flagged {flagged-at}
  ...
```

If multiple entries exist, list them all so the coach can assess each upstream change independently.

### Step 3 — Sanity Check

Ask the Agent Coach to verify, before confirming:

> "You are about to assert that this BP's prior work is still valid despite the upstream changes listed above. This will:
>  - Clear all stale-because entries
>  - Restore status to '{previous-status}'
>  - Add a revision-log entry with outcome 'confirmed-valid'
>  - **Stop the cascade ripple here** (no downstream BPs will be flagged or unflagged)
>
> Have you actually inspected each upstream change and confirmed it does not affect this BP's outputs?"

If the coach is unsure, recommend `/ace:revise {hash}` instead.

### Step 4 — Get Confirmation Note

If `--reason` was provided, use it as the confirmation note. Otherwise ask:

> "Briefly note why this BP's work is still valid despite the upstream change. Recorded in revision-log for audit."

A good note explains *which aspect* of the upstream change was assessed (e.g. "Build config fix did not touch Java sources, runtime behavior unchanged"). A bare "still valid" is uninformative.

### Step 5 — Execute confirm-valid Transition

Run the transition script (do NOT manually edit frontmatter):

```
python3 scripts/bp-transition.py confirm-valid {bp-hash} --reason "{note}"
```

This deterministically:
- Reads `stale-because[0].previous-status` and restores `status` to that value (`completed` or `reviewed`)
- Removes the `stale-because` field entirely
- Appends an entry to `revision-log` with the current revision number, today's date, the BP's last `agent-id`, outcome `confirmed-valid`, and the note in `revision-reason`
- Regenerates the index and commits

Display the script output to confirm.

### Step 6 — Report

```
CONFIRMED VALID
================

BP:        bp:{hash} ({slug})
Status:    stale -> {restored-status}
Note:      "{note}"
Cleared:   {N} stale-because entries

Cascade stops here — no downstream BPs were flagged or unflagged.
```

---

## Design Notes

- `confirm-valid` is the human's explicit assertion that an upstream change did not affect this BP's outputs. It is *not* a default — it must be a deliberate decision after assessment.
- The transition is deliberately one-shot: it clears all accumulated stale-because entries at once. If a new upstream revision occurs after confirm-valid, a fresh stale-because cycle begins.
- This command never manually edits BP status fields — all transitions go through `bp-transition.py`.
- For audit symmetry: every `revise` produces a `revision-log` entry on the upstream and `stale-because` entries on direct dependents. Every `confirm-valid` produces a `revision-log` entry on the dependent. The trail of who decided what, when, is always complete.
