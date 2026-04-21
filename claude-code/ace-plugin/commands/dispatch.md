---
description: "Launch an Agent for execution"
allowed-tools: [Read, Write, Edit, Grep, Glob, Bash, Agent]
---

# ACE Command: dispatch

You are the **BP Dispatcher**. Your job is to validate a BriefingPack and launch one or more AI Teammate agents to execute it.

## Invocation

```
/dispatch a3f7c2e1b9d4       → Dispatch by BP hash
/dispatch a3f7c2             → Dispatch by BP hash prefix
```

The first argument `$ARGUMENTS` is required -- it must be a BP hash (or unique prefix).

## Workflow

### Steps 1+2 — Locate and Validate the BriefingPack

**Use the validation script** — do NOT check these manually:

```
python3 scripts/validate-bp.py {bp-hash-prefix}
```

This deterministically checks all dispatch prerequisites:
- BP is a leaf (no child subdirectories)
- `status` is `ready`
- `id` is a valid 12-character hex string
- `mission`/`title` field is non-empty
- `loop-script`/`loopscript` references an existing file (or auto-selects based on rigor)
- `mentor-scripts`/`mentorscripts` list is non-empty and each file exists
- At least 2 Acceptance Criteria in the body
- Goal & Why section has content
- Context section has file/module references
- All `depends-on` dependencies are completed, reviewed, or archived

If the script exits with code 1, display its output (which lists each failed check) and suggest running `/ace:brief {bp-hash}` to fix them. If exit code 0, proceed to Step 3.

For JSON output (useful for programmatic checks): `python3 scripts/validate-bp.py {bp-hash-prefix} --json`

### Step 3 — Dispatch BP and Create Agent Worktree

**Use the transition script** — do NOT manually edit the BP frontmatter:

1. `git pull` to ensure latest main.
2. Run the transition script:
   ```
   python3 scripts/bp-transition.py dispatch {bp-hash} --push
   ```
   This deterministically: generates an agent-id, sets `status: dispatched`, adds `agent-id` and `claimed` timestamp, regenerates the index, commits with the correct message format, and pushes.
3. Read the script output to get the generated `agent-id`.
4. **Verify no competing claims**: `git pull` again and check the BP's `agent-id` field still matches. If another agent claimed first, abort and report the conflict.
5. **Create agent worktree** using the worktree-ops script (do NOT run git commands manually):
   ```
   python3 scripts/worktree-ops.py create --agent-id {agent-id} --bp-hash {bp-hash} --push
   ```
   This creates the worktree at `.worktrees/{agent-id}-{bp-hash}`, the branch `agent/{agent-id}/{bp-hash}`, and pushes to origin. The main workspace stays on `main`.

### Step 4 — Determine Execution Mode

**Use the bp-info script** to read all BP fields deterministically:

```
python3 scripts/bp-info.py {bp-hash} --json
```

This returns JSON with pre-resolved fields:
- `resolved_loopscript`: Auto-selected based on rigor (standard→standard.yaml, high→high-rigor.yaml)
- `execution_mode`: `"standard"` (one executor) or `"high"` (executor + independent reviewer)
- `rigor`, `mentorscripts`, and all other frontmatter fields

Use these values directly for agent assembly in Step 5. Do NOT manually resolve loopscript paths or read rigor fields.

### Step 5 — Start Agent(s)

For each agent to start:

1. Prepare the agent context by assembling:
   - The BriefingPack content
   - The LoopScript (resolved from BP's `loop-script` field)
   - All MentorScripts (resolved from BP's `mentor-scripts` list)
   - The agent-id (`{agent-id}`)
2. Use the Agent tool with `isolation: "worktree"` to start the executor with clear instructions:
   - Work in the agent worktree `.worktrees/{agent-id}-{bp-hash}/`
   - Follow the LoopScript phases sequentially
   - Respect all MentorScript rules
   - Create CRPs when escalation triggers fire
   - Produce an MRP upon completion
   - Commit and push progress from the worktree
   - **Phase heartbeats**: At the START of each LoopScript phase, the agent MUST run the heartbeat transition from the main repo root (NOT from the worktree):
     ```
     python3 scripts/bp-transition.py claim {bp-hash} --agent-id {agent-id}   # before first phase only
     python3 scripts/bp-transition.py heartbeat {bp-hash} --phase {phase-id}  # at start of each phase
     ```
     Phase IDs match the LoopScript (e.g. `understand`, `plan`, `implement`, `self-review`, `package`).
     This updates `status: in-progress`, `phase`, and `last-heartbeat` in the BP frontmatter so the BP-Explorer can track progress in real time.

If N-Version mode: start the reviewer agent with its own `isolation: "worktree"`, a separate agent-id and worktree (`.worktrees/{reviewer-agent-id}-{bp-hash}/`), instructing it to produce an independent implementation. Both agents run in parallel in their own worktrees.

### Step 6 — Update Status

1. BP frontmatter was already updated to `status: dispatched` in Step 3.

## Output

Display:
- BP hash and slug
- Agent-id
- Agent worktree path and branch name
- Execution mode (standard / N-Version)
- Agent(s) started
- Next steps: "Monitor with `/ace:status`. Agent will produce an MRP when done."
