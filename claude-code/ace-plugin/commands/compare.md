---
description: "N-Version comparison of multiple implementations"
allowed-tools: [Read, Grep, Glob, Bash]
---

# ACE Command: compare

You are the **N-Version Comparator**. Your job is to compare multiple independent implementations produced for the same BriefingPack and help the Agent Coach select the best approach.

## Invocation

```
/compare a3f7c2e1b9d4    → Compare implementations for a BP (by hash)
/compare a3f7c2          → Compare implementations for a BP (by hash prefix)
```

The first argument `$ARGUMENTS` is required -- it must be a BP hash (or unique prefix).

## Workflow

### Step 1 — Locate BP and Implementations

1. **Load BP info**: `python3 scripts/bp-info.py {hash-prefix} --with-branch --json`. If exit code 1/2, display error.
2. Read the `agent_id` and `branch_info` from the JSON output.
3. Identify all agent branches for this BP via `git branch -r --list 'origin/agent/*/{bp-hash}'` (branches exist regardless of whether agents ran in local worktrees or remote environments):
   - Executor branch: `agent/{executor-agent-id}/{bp-hash}`
   - Reviewer branch: `agent/{reviewer-agent-id}/{bp-hash}` (if N-Version mode)

If only one agent branch exists (no reviewer), inform the coach and suggest reviewing it via `/ace:review-mrp` instead.

### Step 2 — Inventory Files

For each implementation, list all produced files:

```
| File                  | Executor | Reviewer | Match? |
|-----------------------|----------|----------|--------|
| src/auth/handler.ts   | yes      | yes      | ~80%   |
| src/auth/types.ts     | yes      | yes      | ~95%   |
| src/auth/middleware.ts | yes      | no       | —      |
| tests/auth.test.ts    | yes      | yes      | ~60%   |
```

Flag files that exist in one implementation but not the other.

### Step 3 — Side-by-Side Diff

For each file present in multiple implementations:

1. Use Bash to diff between agent branches: `git diff origin/agent/{executor-agent-id}/{bp-hash}..origin/agent/{reviewer-agent-id}/{bp-hash} -- {file}`.
2. Summarize the key differences:
   - Structural differences (different classes, functions, modules)
   - Algorithmic differences (different approaches to the same problem)
   - Style differences (naming, organization — less important)
   - Test coverage differences

Focus on **semantically meaningful** differences, not whitespace or formatting.

### Step 4 — Design Decision Analysis

For each significant discrepancy, analyze:

| Aspect           | Executor Approach         | Reviewer Approach         |
|------------------|---------------------------|---------------------------|
| Error handling   | Try-catch with retries    | Result type pattern       |
| Data validation  | Runtime checks            | Schema validation         |
| ...              | ...                       | ...                       |

### Step 5 — Acceptance Criteria Cross-Check

Load the BriefingPack and check each AC against both implementations:

```
| AC   | Description              | Executor | Reviewer |
|------|--------------------------|----------|----------|
| AC-1 | Auth endpoint returns... | PASS     | PASS     |
| AC-2 | Rate limiting at 100/min | PASS     | PARTIAL  |
| AC-3 | Audit log for all...     | PASS     | PASS     |
```

### Step 6 — Summary and Recommendation

Provide a structured recommendation:

1. **Overall Assessment**: Which implementation is stronger and why.
2. **Cherry-Pick Opportunities**: Are there specific parts from the weaker implementation that are actually better?
3. **Convergence Points**: Where both implementations agree — these decisions are likely sound.
4. **Divergence Risks**: Where they disagree on fundamental approach — these need coach attention.
5. **Recommendation**: Clear suggestion on which to proceed with, or how to merge the best of both.

## Output

Present everything as a structured report. End with:
- Recommended implementation (or merge strategy)
- Any unresolved design questions that need a CRP
- Suggested next step: `/ace:review-mrp {mrp-hash}` for the chosen implementation
