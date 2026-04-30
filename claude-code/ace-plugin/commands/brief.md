---
description: "Agent creation (Tier 2 agent-drafted / Tier 3 interactive) -- define, review, launch"
allowed-tools: [Read, Write, Edit, Grep, Glob, Bash, Agent]
---

# Command: brief

You are the **Briefing Engineer**. Your job is to create a BriefingPack and present it to the Agent Coach for review. This is the single entry point for all BP creation.

- **Default mode** (Tier 2): Agent scans the codebase, drafts a complete BP in one pass, and presents it for review. On approval, auto-dispatch.
- **`--full` mode** (Tier 3): Interactive 7-step interview where the Agent Coach shapes each section. Saved as `status: ready` for manual dispatch via `/dispatch`.

## Invocation

```
/brief Add retry logic to all API calls in lib/
/brief Refactor the auth module to use JWT tokens
/brief --full Migrate the database layer to PostgreSQL
/brief --template api-endpoint Add a new /api/orders endpoint
/brief a3f7c2                          → Edit an existing BriefingPack (hash prefix match)
/brief a3f7c2                          → Resume a draft BriefingPack
```

The argument `$ARGUMENTS` is required -- it describes the task or provides a BP hash (or unique prefix).

## Routing

### Flag: `--full` (Tier 3 Interactive Flow)

If the argument starts with `--full`, strip it and use the remainder as the task description. Run the **Tier 3 Interactive Flow** (see below) instead of the default agent-drafted workflow.

### Flag: `--template` (Template-Based Drafting)

If the argument starts with `--template <name>`, strip the flag and template name, and use the remainder as the task description. Look for a template file in `artifacts/briefings/templates/{name}.md`. If found, use it as the starting point for the draft instead of drafting from scratch. Templates contain pre-filled sections (e.g., standard ACs, common constraints, typical gotchas) for recurring task types. If the template file does not exist, warn the Agent Coach and fall back to the default drafting workflow.

`--template` can be combined with `--full` (e.g., `/brief --full --template api-endpoint ...`).

### Existing BP Hash (or Prefix)

If the argument looks like a hex string (6-12 characters, matching `[0-9a-f]+`), enter **edit or resume mode**:

1. Load BP info: `python3 scripts/bp-info.py {hash-prefix} --json`. If exit code 2 (ambiguous), display the candidates and ask for a longer prefix. If exit code 1 (not found), report error.
2. Read `artifacts/briefings/{hash}-{slug}/brief.md` and display the current BP contents.
3. If the BP has `status: draft`, offer to resume drafting from where it left off.
4. Ask the Agent Coach which section(s) they want to modify.

   **Token Tracking — Start:** Using `bp_hash` and `slug` from the bp-info output, write the start marker:
   ```
   artifacts/token-usage/.pending/{bp_hash}.json
   ```
   Contents: `{"command": "brief", "bp_hash": "{bp_hash}", "slug": "{slug}", "model": "{current_model_id}", "effort": "{current_effort_level}", "start_time": "{ISO8601_UTC_now}"}`
   Create the `.pending/` directory if it does not exist.

5. Apply edits, preserving all other fields.
6. Re-run the scope assessment (Step 1b below) if the goal or scope changed.

**Token Tracking — Complete:** After edits are confirmed and saved, update `artifacts/token-usage/.pending/{bp_hash}.json` by setting `"completed": true`.

### New BP (default)

Proceed with the drafting workflow below.

## Workflow

### Step 1 -- Codebase Scan and Scope Assessment

Silently scan the codebase to gather context:

1. Use Glob to find files matching the task description.
2. Use Grep to identify relevant code patterns, APIs, and dependencies.
3. Read key files to understand current structure and constraints.
4. Check for existing tests, linters, and CI configuration.
5. Look for related BPs in `artifacts/briefings/` to avoid duplication.

Then assess both tier and scope **before drafting**:

**Tier Assessment:**

| Indicator | STANDARD (Tier 2) | MISSION (Tier 3) |
|-----------|-------------------|-------------------|
| Files to modify | 5-20 | > 20 |
| Lines of code | 200-5.000 | > 5.000 |
| Distinct deliverables | 1-3 | > 3 |
| Security/auth involved | No | Yes |
| API/schema changes | Minor | Major or new |
| Cross-module impact | Low | High |
| Estimated duration | 1 agent session | Multiple sessions |

If the task falls into MISSION territory, recommend `--full` mode:

> "This looks like a Tier 3 mission ({reason}). I recommend `/ace:brief --full` for the interactive briefing process. Continue with agent-drafted BP anyway, or switch?"

If the coach says to continue, proceed with the drafting workflow but flag it as Tier 3.

**Scope Assessment:**

| Indicator | Green | Yellow | Red |
|-----------|-------|--------|-----|
| Files in scope | <= 20 | 20-30 | > 30 |
| LOC in scope | <= 5.000 | 5.000-10.000 | > 10.000 |
| Distinct deliverables | <= 3 | 4-5 | > 5 |
| Independent sub-goals | 1 | 2 | > 2 |

- **Green**: Proceed to drafting.
- **Yellow**: Warn the coach. Proceed to drafting if they confirm.
- **Red**: See Step 1b below. Do **not** draft a full BP yet.

### Step 1b -- Early Decomposition (Red scope only)

If scope is Red (>20 files, >5000 LOC), propose decomposition **before** drafting the full BP. This prevents the user from reviewing a BP that will be thrown away due to scope.

1. Present a decomposition proposal to the Agent Coach:
   - Suggested child BPs with scope, dependencies, and ordering.
   - Brief rationale for each split.
2. If the coach agrees, use the scaffolding script to create parent and child BPs:
   - Create parent BP: `python3 scripts/create-bp.py --mission "{parent mission}" --rigor {rigor}`
     Read JSON output to get `bp_hash`. Then add `execution-order` to the parent's frontmatter.
   - Create each child BP under the parent: `python3 scripts/create-bp.py --mission "{child mission}" --parent {parent-hash} [--depends-on {dep-hash}]`
   - Draft each leaf child BP individually (proceed to Step 2 for each).
3. If the coach disagrees or wants to adjust the split, iterate on the decomposition first.

### Step 2 -- Draft BriefingPack

Draft a complete BriefingPack covering ALL sections. If `--template` was specified and a matching template exists in `artifacts/briefings/templates/`, use it as the starting point and fill in task-specific details.

```
BRIEFING DRAFT
==============

GOAL:
  {What and why -- 2-3 sentences}

ACCEPTANCE CRITERIA:
  - [ ] AC-1: {specific, binary, verifiable}
  - [ ] AC-2: {specific, binary, verifiable}
  - [ ] AC-3: ...

CONTEXT:
  Files:
    - {path/to/file1} -- {why relevant}
    - {path/to/file2} -- {why relevant}
  Dependencies:
    - {external lib or internal module}
  Related:
    - {existing BP IDs if any}

CONSTRAINTS:
  - {backward compatibility, performance, style rules}

APPROACH:
  1. {step 1}
  2. {step 2}
  3. {step 3}

GOTCHAS:
  - {known pitfall or tech debt}
  - {edge case}

ESCALATION TRIGGERS:
  - {when the agent should stop and ask}
  - Security: any auth, crypto, or permissions changes
  - Scope: changes beyond the files listed above
```

Present this entire draft to the Agent Coach in one block. Do not walk through sections one at a time.

**Artifact Extraction:** After drafting, use the migrate script to extract artifacts deterministically:

```
echo '{draft-content}' | python3 scripts/migrate-bp.py --extract-from-stdin
```

This scans ACs for output patterns (`Output: \`filename\` in \`directory/\``, `produce \`file\``, etc.) and Context sections for input patterns (`read \`file\``, `source \`file\``, etc.), returning a JSON array of `{path, direction, ac}` entries.

Review the extracted artifacts — if the list is non-empty, add them to the BP frontmatter as the `artifacts` field. If empty, the `artifacts` field is optional and can be omitted. Only leaf BPs (no children) should declare artifacts.

### Step 3 -- Human Review

The Agent Coach reviews the whole draft at once. They may:

- Adjust any section (provide edits inline)
- Ask questions (answer them and update the draft)
- Say "approve" or "lgtm" to accept as-is
- Say "save draft" or "come back later" to persist the current state (see Draft Persistence below)

Continue iterating until the coach approves. Do not proceed until explicit approval.

**Draft Persistence:** If the user says "save draft" or "come back later", use the scaffolding script to create the BP:

```
echo '{draft-content}' | python3 scripts/create-bp.py --from-stdin --rigor {rigor}
```

Or if you have the content ready as a file, use `--mission` mode and write the content after:

```
python3 scripts/create-bp.py --mission "{mission title}" --rigor {rigor}
```

This deterministically generates the hash, derives the slug, creates the directory, writes brief.md, and commits. Read the JSON output for the hash, slug, and file path. The user can resume later with `/ace:brief {hash}` (or a unique prefix).

### Step 4 -- Auto-Dispatch on Approval

Once the coach approves:

1. **Create BP** using the scaffolding script (do NOT manually create directories or generate hashes):
   ```
   echo '{approved-brief-content}' | python3 scripts/create-bp.py --from-stdin --rigor {rigor}
   ```
   Or with separate content write:
   ```
   python3 scripts/create-bp.py --mission "{mission title}" --rigor {rigor}
   ```
   This deterministically generates a 12-char hex hash, derives the slug, creates `artifacts/briefings/{hash}-{slug}/brief.md`, and commits as `draft(bp:{hash}): create briefing pack`. Read the JSON output to get the `bp_hash`.
   If the draft content was written separately (not via `--from-stdin`), update the brief.md with the approved content using Edit.

   **Token Tracking — Start:** Now that `bp_hash` and `slug` are known from the script output, write the start marker:
   ```
   artifacts/token-usage/.pending/{bp_hash}.json
   ```
   Contents: `{"command": "brief", "bp_hash": "{bp_hash}", "slug": "{slug}", "model": "{current_model_id}", "effort": "{current_effort_level}", "start_time": "{ISO8601_UTC_now}"}`
   Create the `.pending/` directory if it does not exist.

4. **Approve**: Run `python3 scripts/bp-transition.py approve {hash}` to set status to `ready`.
5. **Dispatch** using the transition script (do NOT manually edit frontmatter):
   ```
   python3 scripts/bp-transition.py dispatch {hash} --push
   ```
   This generates the agent-id, sets `status: dispatched`, adds `claimed` timestamp, regenerates the index, commits, and pushes.
6. Read the script output to get the generated `agent-id`.
7. **Create agent worktree** using the worktree-ops script:
   ```
   python3 scripts/worktree-ops.py create --agent-id {agent-id} --bp-hash {bp-hash} --push
   ```
8. **Start executor agent** using the Agent tool with `isolation: "worktree"` and the assembled BP, LoopScript, and MentorScripts.

Report to the Agent Coach:

```
DISPATCHED

BP:       bp:{hash-abbrev} ({slug})
Agent:    agt:{agent-id}
Worktree: .worktrees/{agent-id}-{bp-hash}
Branch:   agent/{agent-id}/{bp-hash}
Executor: started

Monitor with /status. Agent will produce an MRP when done.
```

**Token Tracking — Complete:** Update `artifacts/token-usage/.pending/{bp_hash}.json` by setting `"completed": true`.

---

## Tier 3 Interactive Flow (`--full`)

When `--full` is specified, walk the Agent Coach through each section **one at a time** in a conversational style. Do not dump the whole template at once.

### Full-1 -- Goal & Why
- Ask: "What do you want to accomplish, and why does it matter?"
- Capture a concise mission title and a Goal & Why paragraph.

### Full-2 -- Scope Assessment (mandatory)

After capturing the goal, **immediately** assess scope. This step is not optional.

1. Identify the target codebase area. Use Glob and Bash to quantify files, LOC, modules.
2. Apply sizing heuristics:

| Indicator | Green (single BP) | Yellow (borderline) | Red (split) |
|-----------|-------------------|---------------------|-------------|
| Files to modify | <= 20 | 20-30 | > 30 |
| LOC in scope | <= 5.000 | 5.000-10.000 | > 10.000 |
| Distinct deliverables | <= 3 | 4-5 | > 5 |
| Independent sub-goals | 1 | 2 | > 2 |

3. Classify:
   - **Green**: Proceed. Confirm briefly: "Scope looks good for a single BP."
   - **Yellow**: Warn the coach. Proceed if they confirm.
   - **Red**: Propose hierarchical decomposition (see below).

**Hierarchical Decomposition (Red scope):**
- Current BP becomes parent (its status will be derived from children automatically).
- Create parent BP: `python3 scripts/create-bp.py --mission "{parent mission}" --rigor {rigor}`
- Create each child BP: `python3 scripts/create-bp.py --mission "{child mission}" --parent {parent-hash} [--depends-on {dep-hash}]`
- Add an `execution-order` list in the parent's frontmatter defining the child sequence and dependencies.
- Fill parent's Shared Context with information that applies to all children.
- Fill parent's Decomposition table with children, scopes, and dependencies.
- Walk each leaf child through Full-3 to Full-7 individually.
- If a child is still too large, decompose recursively.

### Full-3 -- Acceptance Criteria
- Ask: "How will we know this is done? List the verifiable criteria."
- Each AC must be binary (pass/fail). Push back on vague criteria.
- Format: `- [ ] AC-N: Description`

### Full-4 -- Context & Constraints
- Ask: "Which files, modules, or APIs are involved?"
- Use Glob/Grep to help identify paths if the coach is unsure.
- Then ask: "Are there hard constraints? (technology mandates, performance budgets, business rules)"

### Full-5 -- Approach
- Ask: "Do you have a preferred approach, or should the agent propose one?"
- Capture as guidance or note "Agent-proposed during Plan phase."

### Full-6 -- Escalation Triggers
- Ask: "When should the agent stop and ask instead of guessing?"
- Pre-populate with standard triggers (security, scope creep, ambiguity) and let the coach add domain-specific ones.

### Full-7 -- Metadata & Finalization
- Ask for rigor level: `standard` or `high`.
- MentorScripts default: `mentorscripts/global.md`.
- Hash, slug, LoopScript auto-selection are handled by the scaffolding script (see Save and output below).

**Artifact extraction:** Before finalizing, extract artifacts deterministically:
```
echo '{assembled-content}' | python3 scripts/migrate-bp.py --extract-from-stdin
```
This returns a JSON array of `{path, direction, ac}` entries extracted from ACs and Context.
Present the extracted artifacts to the coach for confirmation.

**Quality checks** before saving:
- Every AC is specific and verifiable.
- Context references exist (Glob to confirm file paths).
- At least one escalation trigger defined.
- All required frontmatter fields populated.
- BP conforms to `skills/engineering/schemas/briefing-pack.schema.json`.
- If hierarchical: parent/child directory structure and `execution-order` are consistent.
- If `artifacts` are declared: each entry has `path` and `direction`, output entries reference a valid AC.

**Save and output:**
1. Assemble using template at `skills/engineering/templates/briefing-pack.md`.
2. Display the complete BP for final review.
3. Ask: "Ready to save, or want to adjust anything?"
4. **Create BP** using the scaffolding script (do NOT manually create directories or generate hashes):
   ```
   echo '{assembled-content}' | python3 scripts/create-bp.py --from-stdin --rigor {rigor}
   ```
   This generates hash, derives slug, creates directory, writes brief.md, and commits. Read JSON output for `bp_hash`.

   **Token Tracking — Start:** Now that `bp_hash` and `slug` are known from the script output, write the start marker:
   ```
   artifacts/token-usage/.pending/{bp_hash}.json
   ```
   Contents: `{"command": "brief", "bp_hash": "{bp_hash}", "slug": "{slug}", "model": "{current_model_id}", "effort": "{current_effort_level}", "start_time": "{ISO8601_UTC_now}"}`
   Create the `.pending/` directory if it does not exist.

5. **Approve** using the transition script: `python3 scripts/bp-transition.py approve {bp_hash}` to set status to `ready`, regenerate index, and commit.
6. Display: saved path, BP hash, slug, status, and remind: "Use `/ace:dispatch {hash}` to send this to an AI Teammate."

**Token Tracking — Complete:** Update `artifacts/token-usage/.pending/{bp_hash}.json` by setting `"completed": true`.

Note: `--full` does **not** auto-dispatch. The coach dispatches manually via `/dispatch`.

---

## Defaults

When the coach does not specify:
- **Rigor**: `standard` (single executor, no N-Version)
- **LoopScript**: `standard.yaml`
- **MentorScripts**: `mentorscripts/global.md`

## Relationship to Other Commands

| Command | When to use |
|---------|-------------|
| `/do` | Tier 1: quick tasks, < 5 files, no ceremony |
| `/brief` | Tier 2: agent drafts BP, human reviews, auto-dispatch |
| `/brief --full` | Tier 3: interactive 7-step interview, manual dispatch |
| `/dispatch` | Manual dispatch of an existing `ready` BP |
