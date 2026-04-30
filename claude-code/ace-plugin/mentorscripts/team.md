---
schema: sase/mentor-script/v1
id: "team-v1"
applies-to: global
---

# Team MentorScript

This MentorScript defines team roles, review policies, routing rules, authorization
boundaries, and Git integration conventions for multi-agent collaboration.

---

## 1. Team Roles

| Role           | Responsibilities                                                                                       |
|----------------|--------------------------------------------------------------------------------------------------------|
| **Author**     | Creates initial BP drafts. Multiple authors may contribute to the same BP. Responsible for goal, ACs, and context sections. |
| **Contributor**| Adds context, gotchas, constraints, or approach sections to an existing draft. Does not own the BP.     |
| **Approver**   | Reviews BPs and transitions status from `draft` to `ready`. Only the Approver can make this transition. Validates quality criteria are met. |
| **Reviewer**   | Evaluates MRPs against the 5 criteria. Submits VCRs with approval/rejection. May be assigned to CRP resolution based on domain expertise. |
| **Dispatcher** | Transitions BPs from `ready` to `dispatched`. Assigns agent(s) and ensures prerequisites are met.       |

An individual may hold multiple roles. The Agent Coach typically holds Approver and Dispatcher roles.
AI Teammates hold the Author role (when drafting BPs via `/brief`) and produce MRPs as executors.

---

## 2. Review Policies

Review policies determine how many reviewers must approve an MRP before it is accepted.
The policy is derived from the BP's `rigor` level:

| Rigor Level  | Review Policy | Meaning                                         |
|--------------|---------------|-------------------------------------------------|
| `standard`   | `any-1`       | Any one designated reviewer can approve.         |
| `high`       | `any-2`       | Two designated reviewers must independently approve. |
| `critical`   | `all`         | All designated reviewers must approve.           |

**Rules:**
- Each reviewer submits an independent VCR (type: `mrp-approval` or `mrp-rejection`).
- The MRP is approved only when the review policy threshold is met.
- A single rejection does not block approval under `any-1` or `any-2` if enough approvals exist, but the rejection VCR is preserved for audit.
- Under `all` policy, any single rejection blocks approval.

---

## 3. CRP Routing

CRPs are routed to the appropriate resolver based on domain expertise:

| CRP Trigger                    | Default `routed-to`          |
|--------------------------------|------------------------------|
| API/Schema/Interface change    | architecture-reviewer        |
| Security                       | security-reviewer            |
| Scope deviation                | agent-coach                  |
| Cross-scope reversal           | agent-coach                  |
| Multi-approach ambiguity       | agent-coach                  |
| Data-destructive operation     | agent-coach                  |
| Dependency change              | architecture-reviewer        |
| Observable behavior change     | agent-coach                  |
| Conflict (rule contradiction)  | agent-coach                  |

**Routing rules:**
- The `routed-to` field in the CRP frontmatter identifies who should resolve it.
- If the designated resolver is unavailable, the CRP falls back to `agent-coach`.
- Agents set `routed-to` based on this table when creating CRPs.
- The Agent Coach may re-route a CRP by updating the `routed-to` field.

---

## 4. Authorization Matrix

This matrix defines who can transition BP status:

| Transition                  | Authorized Role(s)       | Notes                                          |
|-----------------------------|--------------------------|------------------------------------------------|
| `(new)` -> `draft`         | Author, Contributor      | Any team member can create a draft.            |
| `draft` -> `draft`         | Author, Contributor      | Edits within draft status.                     |
| `draft` -> `ready`         | **Approver only**        | Requires all quality criteria to be met.        |
| `ready` -> `dispatched`    | **Dispatcher only**      | Assigns agent(s), creates worktree + branch. Leaf BPs only. |
| `ready` -> `draft`         | Approver                 | Revert to draft for rework.                    |
| `dispatched` -> `completed`| Executor (agent)         | On MRP submission.                             |
| `{completed,reviewed,stale}` -> `ready` (`revise`) | Author, Approver | Re-execute. Increments revision. **Side effect:** direct dependents in `completed/reviewed/stale` are cascade-flagged as `stale`. |
| `{completed,reviewed,stale}` -> `stale` (cascade)  | Automatic                | Side-effect of an upstream `revise`. No manual transition; the revise script writes both files. If the dependent is already `stale`, status remains `stale` and another `stale-because` trigger entry is appended. |
| `stale` -> `{completed,reviewed}` (`confirm-valid`) | **Reviewer**           | Asserts that the upstream change does not affect this BP's outputs. Cascade ripple stops here. |
| `reviewed` -> `[archived]`| Author, Approver         | Physical move to `.archive/` via `/archive`. Not a frontmatter status. |

**Violations:**
- An agent attempting an unauthorized transition must create a blocking CRP.
- Unauthorized transitions are logged in the audit trail.

---

## 5. Stale Lock Policy

Agent worktrees use a lock mechanism to prevent concurrent work on the same BP.

| Parameter                     | Value          |
|-------------------------------|----------------|
| Stale threshold               | 3 hours (180 minutes) |
| Heartbeat interval            | 60 minutes     |
| CRP-blocking exemption        | Yes -- agents blocked on a `mode: blocking` CRP are exempt from stale detection |
| Release mechanism             | `/status release` command |

**Rules:**
- A lock is established when an agent creates the worktree/branch and commits `claim()`.
- The lock is refreshed by `heartbeat()` commits.
- If no commit occurs within the stale threshold, the lock is considered stale.
- Stale locks can be released by the Agent Coach via `/status release`.
- On release: the worktree is removed (`git worktree remove`), but the branch is preserved for audit purposes.
- An agent whose lock was released must not resume work without re-claiming (which creates a new worktree).

---

## 6. Worktree & Branch Convention

All agent work is isolated in dedicated **git worktrees**, each on its own branch. This enables parallel agent execution -- the main workspace stays on `main` at all times.

**Branch naming:** `agent/{agent-id}/{bp-hash}`
**Worktree path:** `.worktrees/{agent-id}-{bp-hash}/` (relative to repo root, gitignored)

**Examples:**
```
# Worktree paths:
.worktrees/executor-01-a1b2c3d4e5f6/
.worktrees/executor-02-f6e5d4c3b2a1/
.worktrees/reviewer-01-112233445566/

# Corresponding branches:
agent/executor-01/a1b2c3d4e5f6
agent/executor-02/f6e5d4c3b2a1
agent/reviewer-01/112233445566
```

**Lifecycle:**
1. Worktree + branch is created from main at dispatch time: `git worktree add .worktrees/{agent-id}-{bp-hash} -b agent/{agent-id}/{bp-hash}`.
2. Agent works exclusively inside its worktree directory.
3. On MRP approval, the branch is merged to main, then worktree is removed and branch deleted.
4. On abandonment, the worktree is removed but the branch is preserved for audit.

**Rules:**
- One worktree per agent per BP. No shared worktrees.
- Agents must not commit to branches they do not own.
- Branch names use the agent's ID and the BP hash -- no other format is accepted.
- The `.worktrees/` directory is gitignored and must not be committed.
- Multiple agents can run in parallel, each in its own worktree.

---

## 7. Commit Convention

All commits on agent branches (from within their worktrees) use a prefix that encodes the action:

| Prefix         | When Used                                      | Example                                           |
|----------------|-------------------------------------------------|---------------------------------------------------|
| `draft()`      | Creating or updating a BP draft                 | `draft(bp:a1b2c3): initial briefing-pack`         |
| `refine()`     | Refining a BP during review                     | `refine(bp:a1b2c3): sharpen AC-3`                 |
| `approve()`    | Approver transitions BP to ready                | `approve(bp:a1b2c3): quality criteria met`        |
| `claim()`      | Agent claims the branch/lock                    | `claim(bp:a1b2c3): executor-01 starting [agent:executor-01]` |
| `heartbeat()`  | Periodic liveness signal                        | `heartbeat(bp:a1b2c3): phase=implementation [agent:executor-01]` |
| `complete()`   | Agent finishes work, submits MRP                | `complete(bp:a1b2c3): all ACs met [agent:executor-01]` |
| `merge()`      | Branch merged after approval                    | `merge(bp:a1b2c3): approved by reviewer-01`       |
| `release()`    | Stale lock released by Agent Coach              | `release(bp:a1b2c3): stale lock released`         |
| `archive()`    | Archiving a completed BP tree                   | `archive(bp:a1b2c3): archived completed tree`     |
| `restore()`    | Restoring a BP tree from archive                | `restore(bp:a1b2c3): restored from archive`       |

**Format:** `prefix(bp:{hash}): description [agent:{agent-id}]`

- The `bp:{hash}` scope identifies the BriefingPack (6-char abbreviation of the 12-char hash is acceptable).
- The `[agent:{agent-id}]` tag identifies the acting agent. Required for `claim()`, `heartbeat()`, and `complete()`.
- These prefixes replace the standard Conventional Commits format on agent branches. Conventional Commits remain the convention for non-agent work on the main branch.
