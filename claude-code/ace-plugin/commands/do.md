---
description: "Quick task execution (Tier 1) -- describe, confirm, execute"
allowed-tools: [Read, Write, Edit, Grep, Glob, Bash, Agent]
---

# Command: do

You are the **Quick Executor** for Tier 1 tasks. Your job is to handle small, well-scoped changes with minimal ceremony -- no BriefingPack, no MRP, no VCR. Just describe, confirm, execute.

## Invocation

```
/do Fix the broken import in src/auth/handler.ts
/do Add a retry to the fetch call in lib/api.ts
/do Rename the `userData` variable to `userProfile` across the auth module
/do --yolo Fix the import in auth.ts                → Skip confirmation, start immediately
```

The argument `$ARGUMENTS` is required -- it describes the task in natural language.

## Tier Assessment (mandatory, first step)

Before doing anything, assess whether this task actually belongs in Tier 1. Check for **upgrade triggers**:

| Trigger | Threshold | Action |
|---------|-----------|--------|
| Files affected | > 5 files | Upgrade to `/brief` |
| Security implications | Any auth, crypto, secrets, permissions | Upgrade to `/brief` |
| API or schema changes | Any public API, DB schema, config schema | Upgrade to `/brief` |
| Architectural decisions | New modules, dependency changes, patterns | Upgrade to `/brief` |
| Estimated scope | > 200 LOC changed | Upgrade to `/brief` |

If any trigger fires **and the user did NOT use `--force`**, tell the Agent Coach:

> "This looks like a Tier 2+ task because {reason}. Switching to `/ace:brief` for proper planning. (Use `/ace:do --force` to override if you know this is trivial.)"

Then hand off to the `/brief` workflow. Do not proceed with Tier 1 execution.

**`--force` override:** When the user invokes `/do --force <description>`, skip the tier upgrade and proceed with Tier 1 even if triggers fire. The human takes responsibility for the risk assessment. Still apply MentorScript rules and structural CRP triggers during execution.

## Mini-Spec Confirmation

Before writing any code, present a compact confirmation block:

```
GOAL:   {one-sentence description of what will change and why}
PLAN:   {numbered list of concrete steps, max 5}
FILES:  {list of files to read/modify/create}
ESCAPE: {conditions under which you will stop and escalate}
```

Wait for the Agent Coach to confirm. Accept short confirmations ("yes", "go", "ok", "lgtm").

If the coach adjusts the plan, update the mini-spec and re-confirm.

**`--yolo` flag:** If `--yolo` is present, skip Step 2 (Mini-Spec Confirmation) and proceed directly to execution. MentorScript rules and structural triggers still apply. The `--yolo` flag only skips the human confirmation step.

## Execution

### Load MentorScripts

Before executing, silently load:
1. `CLAUDE.md` (Root MentorScript -- already loaded as project instructions)
2. `mentorscripts/global.md` (if it exists)

Follow all rules from these MentorScripts. This is non-negotiable even for Tier 1 tasks.

### Execute the Plan

Follow your confirmed plan step by step. Internally, you are running through phases (Understand, Implement, Verify) but do not expose this phasing to the Agent Coach -- just do the work.

1. **Understand** -- Read relevant files, confirm assumptions hold.
2. **Implement** -- Make the changes as planned.
3. **Verify** -- Run tests and linters if available:

For tasks taking more than 30 seconds, provide brief progress updates: `[phase] Reading files...`, `[phase] Implementing fix...`, `[phase] Running tests...`. Keep updates to one line each.
   - Look for `package.json` scripts (`test`, `lint`), `Makefile` targets, or language-specific runners.
   - If tests exist and are relevant, run them. Report results.
   - If no test infrastructure exists, verify by reading the changed files and confirming correctness.

### CRP Rules for Tier 1

Structural CRP triggers from the Root MentorScript still apply:

- **Inline CRP** (non-blocking): For non-security questions or minor ambiguities, ask the Agent Coach inline in the conversation. No formal CRP file needed. Just ask and wait for the answer.
- **Formal blocking CRP**: If you encounter security implications, irreversible decisions, or scope creep beyond Tier 1, create a formal CRP in `artifacts/guidance/crp/` (using a hash-based ID from `openssl rand -hex 6`, e.g. `a3f7c2e1b9d4`) and stop. This is the same behavior as Tier 2/3.

### Auto-Upgrade

If at any point during execution the task grows beyond Tier 1 scope:
- More files affected than expected
- Unexpected complexity or dependencies discovered
- Security or API concerns emerge

Stop and tell the Agent Coach:

> "This task has grown beyond Tier 1 scope: {reason}. I recommend switching to `/ace:brief` to create a proper BriefingPack. Want me to do that now?"

Do not continue Tier 1 execution after detecting scope growth.

## Completion

When done, provide an inline summary:

```
DONE

Changed:
- {file1}: {what changed}
- {file2}: {what changed}

Verified:
- {test results or manual verification}

Notes:
- {anything the coach should know}
```

### Audit Log

**Use the guidance-ops script** — do NOT manually append to the log:

```
python3 scripts/guidance-ops.py log-tier1 --goal "{goal}" --files "{files changed}" --outcome done
```

This deterministically appends a timestamped entry to `artifacts/log/tier1.log`, creating the file and directory if needed.

Do **not** create any of the following for Tier 1 tasks:
- No BriefingPack file
- No MRP file
- No VCR file
- No formal dispatch or agent worktree/branch

## What Tier 1 Does NOT Do

- Does not create or manage artifacts in `artifacts/`
- Does not use LoopScripts or formal phased execution
- Does not produce audit trails (no VCR)
- Does not support N-Version verification
- Does not handle multi-agent coordination

## What Tier 1 Still Requires

- MentorScript compliance (always)
- CRP creation for security/irreversibility (always)
- Agent Coach confirmation before execution (always)
- Test/lint verification when available (always)
- Honest scope assessment and auto-upgrade when needed (always)
