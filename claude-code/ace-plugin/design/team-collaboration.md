# Team Collaboration Design for i-SASE

> Design document for scaling i-SASE from single-user to enterprise teams (10+ members).
> Status: PROPOSAL -- requires VCR entry before adoption.
> Date: 2026-03-16

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Collaborative BP Authoring](#2-collaborative-bp-authoring)
3. [BP Lifecycle in a Team](#3-bp-lifecycle-in-a-team)
4. [Visibility and Coordination](#4-visibility-and-coordination)
5. [Review and Quality in Teams](#5-review-and-quality-in-teams)
6. [BP Assignment and Load Balancing](#6-bp-assignment-and-load-balancing)
7. [Audit Trail for Teams](#7-audit-trail-for-teams)
8. [Schema Changes Summary](#8-schema-changes-summary)
9. [Migration Path](#9-migration-path)

---

## 1. Design Principles

The team collaboration layer is governed by five principles that keep it
compatible with the existing single-user workflow:

**P1: Git is the collaboration substrate.** All coordination happens through
Git commits, branches, and pull requests. No external database, no separate
task tracker. The repository is the single source of truth.

**P2: Artifacts are the communication medium.** Team members coordinate by
reading and writing SASE artifacts (BPs, CRPs, MRPs, VCRs). Conventions
are enforced by schema validation, not by runtime locks.

**P3: Additive, not breaking.** Every new field is optional. A single-user
workflow that ignores team fields continues to work unchanged. No existing
schema `required` arrays are modified.

**P4: Roles are advisory, not gatekeeping.** Role fields (author, reviewers,
assignee) provide clarity and enable filtering. They do not introduce hard
access-control barriers. Git branch protection rules handle enforcement
when needed.

**P5: Parallel by default, sequential only when necessary.** The design
favors structures where multiple people can work simultaneously without
blocking each other. Serialization points (approvals, reviews) are explicit
and minimal.

---

## 2. Collaborative BP Authoring

### 2.1 The Core Mechanism: Branch-Per-BP

Each BriefingPack gets its own Git branch. This is the fundamental unit of
collaboration.

```
Branch naming:    bp/{BP-ID}
Example:          bp/BP-2026-0316-002
Decomposed parent: bp/BP-2026-0316-001  (short-lived, merges after decomposition)
```

**Why branches, not direct edits to main?** Branches provide:
- Parallel editing without merge conflicts on the same file
- Pull request reviews before a BP enters the `ready` state
- Clear history of who changed what and when
- The ability to abandon a draft without polluting main

**Workflow:**

```
1. Alice:   /brief "Migrate auth to OAuth2"
            -> creates BP-2026-0316-002.md on branch bp/BP-2026-0316-002
            -> commits with message: "draft(BP-2026-0316-002): initial draft"
            -> pushes branch

2. Bob:     git checkout bp/BP-2026-0316-002
            -> edits BP-2026-0316-002.md (adds acceptance criteria)
            -> commits: "refine(BP-2026-0316-002): add AC for token rotation"
            -> pushes

3. Carol:   same branch
            -> edits the Constraints section
            -> commits: "refine(BP-2026-0316-002): add TLS 1.3 constraint"
            -> pushes

4. Dave:    opens PR from bp/BP-2026-0316-002 -> main
            -> reviews the full BP diff
            -> approves PR
            -> merge sets status to `ready`
```

### 2.2 Editing a BP: `/brief BP-ID` in Team Context

The existing `/brief BP-ID` command (edit/resume mode) works unchanged.
In a team context, the convention is:

1. The editor runs `/brief BP-2026-0316-002` in their local checkout of the
   `bp/BP-2026-0316-002` branch.
2. The briefing-engineer agent reads the current file, presents it, and
   applies the edits the human requests.
3. The human commits and pushes.

No locking mechanism is needed because:
- Each person works on their own local copy
- Git merge resolves most conflicts automatically (different sections)
- True conflicts (two people editing the same AC) are caught by Git and
  resolved manually -- which is the correct behavior, since it forces a
  conversation about the disagreement

### 2.3 Roles in Collaborative Authoring

Three roles are formalized via new optional frontmatter fields on the BP:

| Role | Frontmatter Field | Responsibility |
|------|-------------------|----------------|
| **Author** | `author` (existing) | Creates the initial draft. Owns the BP until it reaches `ready`. |
| **Contributors** | `contributors` (new, list) | Anyone who refines the BP. Automatically populated from Git commit authors on the BP file, or listed explicitly. |
| **Approver** | `approver` (new, string) | The person who transitions the BP to `ready`. Typically a tech lead. |

These roles are informational. They enable filtering ("show me BPs I need
to approve") but do not enforce permissions. Git branch protection rules
can optionally require the approver's review before merging to main.

### 2.4 Parallel Decomposition by Different Experts

**Scenario:** Alice creates a parent BP for "Platform Migration." Bob
decomposes the backend. Carol decomposes the frontend. Both work in parallel.

**Mechanism:**

```
1. Alice creates parent BP-2026-0316-010 on branch bp/BP-2026-0316-010
   with status: decomposed and an initial children list (empty or
   with placeholders).

2. Alice merges the parent to main (or it stays on a shared branch).

3. Bob creates child BPs on his own branches:
   bp/BP-2026-0316-011  (Backend: Auth service)
   bp/BP-2026-0316-012  (Backend: Data layer)
   bp/BP-2026-0316-013  (Backend: API gateway)
   bp/BP-2026-0316-014  (Backend: Queue workers)
   bp/BP-2026-0316-015  (Backend: Monitoring)

4. Carol creates child BPs on her own branches:
   bp/BP-2026-0316-016  (Frontend: Auth UI)
   bp/BP-2026-0316-017  (Frontend: Dashboard)
   bp/BP-2026-0316-018  (Frontend: Settings)

5. Each child BP has parent: BP-2026-0316-010 in its frontmatter.
   Bob's children may have depends-on references to each other.
   Carol's BP-2026-0316-016 may have depends-on: [BP-2026-0316-011]
   (needs the auth service before the auth UI can be built).

6. As each child BP branch is merged to main, the parent's children
   list is updated in the same merge commit.
```

**Why this works without conflicts:**
- Each child BP is a separate file (`BP-2026-0316-011.md`, etc.)
- Bob and Carol never edit the same file at the same time
- The parent BP is updated atomically per merge, not edited in parallel
- Cross-domain dependencies (Carol's frontend depending on Bob's backend)
  are expressed via `depends-on`, not by editing each other's BPs

**Dependency management between Bob's and Carol's children:**

Dependencies are declared in the child BP's frontmatter `depends-on` field.
The dependency graph is validated at dispatch time:

- `/ace-dispatch BP-2026-0316-016` checks that all BPs in `depends-on`
  have `status: completed`. If not, it reports which dependencies are
  unmet and refuses to dispatch.
- `/status` shows dependency chains in the "Ready for Dispatch" section,
  flagging BPs that are blocked on unmet dependencies.

### 2.5 Merge Conflict Resolution

The most likely conflict scenario: two people edit the same section of the
same BP simultaneously on the same branch.

**Prevention (preferred):**
- Convention: announce in the team channel which section you are editing.
- Branches scope collaboration: for large BPs, use short-lived sub-branches
  off the BP branch and merge via PR.

**Resolution (when prevention fails):**
- Standard Git merge conflict resolution. The BP is a Markdown file with
  clear section boundaries, so conflicts are usually localized.
- After resolution, the resolver commits with message:
  `resolve(BP-ID): merge conflict in {section}`

**What should never be conflicted:**
- The `id` field (immutable after creation)
- The `schema` field (constant)
- The `parent` field (set once)

These are set at creation time and never change, so they cannot conflict.

---

## 3. BP Lifecycle in a Team

### 3.1 State Machine

```
                    +-----------+
                    |   draft   |<-----------------+
                    +-----+-----+                  |
                          |                        |
                   [anyone edits]                   |
                          |                        |
                          v                        |
                  +---------------+                |
                  | collaborative |                |
                  +-------+-------+                |
                          |                        |
                  [approver signs off]             |
                          |                        |
                          v                        |
                    +-----------+     [issues found |
                    |   ready   |------------------+
                    +-----+-----+
                          |
               +----------+----------+
               |                     |
        [auto-dispatch]        [manual dispatch]
        (Tier 2)               (Tier 3)
               |                     |
               v                     v
          +----------+         +----------+
          | claimed  |         | claimed  |
          +----+-----+         +----+-----+
               |                     |
               v                     v
        +-------------+       +-------------+
        | in-progress |       | in-progress |
        +------+------+       +------+------+
               |                     |
               v                     v
         +-----------+         +-----------+
         | completed |         | completed |
         +-----+-----+         +-----+-----+
               |                     |
               v                     v
          +----------+         +----------+
          | reviewed |         | reviewed |
          +----+-----+         +----+-----+
               |                     |
               v                     v
          +----------+         +----------+
          | approved |         | approved |
          +----------+         +----------+
```

### 3.2 State Definitions and Transition Rules

| State | Who Can Enter | Entry Condition | Exit Actions |
|-------|---------------|-----------------|--------------|
| `draft` | Anyone | `/brief "task"` or manual file creation | BP file created on a `bp/` branch |
| `collaborative` | Anyone (implicit) | A second contributor commits to the BP | No explicit transition; this is a convention, not a stored status value |
| `ready` | Approver | PR approved and merged to main; OR approver sets status via `/brief BP-ID` | `status: ready` written to frontmatter |
| `claimed` | Agent (via dispatch) | `/ace-dispatch` or auto-dispatch | Mission workspace created; `status: claimed` written |
| `in-progress` | Agent | Agent starts Phase 1 (understand) | `status: in-progress` written |
| `completed` | Agent | MRP produced | `status: completed` written |
| `reviewed` | Reviewer(s) | `/ace-review-mrp` or inline approval | VCR created with review decision |
| `approved` | Lead/Approver | Review passes all criteria | VCR records approval; mission status set to `completed` |

**Key design decisions:**

1. **`collaborative` is not a stored status.** It is an observed state (more
   than one person has committed to the BP branch). Storing it would require
   a transition trigger, which adds friction. Instead, the Git log is the
   record.

2. **`ready` requires an approver.** This is the single serialization point
   in the authoring flow. Without it, anyone could dispatch an unreviewed BP.
   The approver is either explicitly set in the `approver` field, or is
   implicitly the person who merges the BP branch to main (if branch
   protection requires a review).

3. **Backward transitions are allowed.** A BP can move from `ready` back
   to `draft` if the approver or author discovers an issue. This is done
   by editing the frontmatter on main and committing with message:
   `revert(BP-ID): returned to draft -- {reason}`. A VCR is created to
   document the reason.

4. **Child BPs inherit the parent's approval.** When a parent BP is
   approved (status: `decomposed`, all child BPs defined), each child BP
   still needs its own `ready` status before dispatch. However, the parent's
   approval means the decomposition strategy is accepted. Individual child
   BPs can go through a lighter review (the decomposition was already
   approved).

### 3.3 Schema Extension for Team States

The `status` enum in `briefing-pack.schema.json` gains two new values:

```
Current:  ["draft", "ready", "decomposed", "dispatched", "in-progress", "completed"]
Proposed: ["draft", "ready", "decomposed", "dispatched", "claimed", "in-progress", "completed", "approved"]
```

- `claimed` -- Agent has accepted the mission but has not started work.
  Distinguishes "dispatched but no agent picked it up" from "agent is
  working on it." Useful in a multi-agent pool.
- `approved` -- Human review is complete and the work is accepted. Final
  state. Distinguishes "agent says done" from "human confirms done."

---

## 4. Visibility and Coordination

### 4.1 Team-Aware `/status`

The existing `/status` command is extended with team-relevant sections.
All extensions are additive -- a single user sees the same output as before,
plus team context when team fields are populated.

**Extended output structure:**

```
TEAM OVERVIEW  (new section, shown when team fields exist)
--------------

Active team members:        8 humans, 3 agent sessions
BPs in collaborative edit:  4 (on bp/* branches)
Blocked on my review:       2 BPs awaiting my approval

MY ITEMS  (new section, filtered to current user)
--------

BP-2026-0316-002  "OAuth2 Migration"  [I am approver]  status: collaborative
  -> 3 contributors, last edit 2h ago by Carol
  -> /ace:brief BP-2026-0316-002 to review

CRP-2026-0316-001  [routed to me]  "TLS version for OAuth2"
  -> /ace-resolve-crp CRP-2026-0316-001

MRP-2026-0316-001  [I am reviewer]  "Auth middleware"
  -> /ace-review-mrp MRP-2026-0316-001

BLOCKED -- Agents waiting on the team  (existing, reworded)
--------------------------------------

{existing CRP listing, unchanged}

REVIEW NEEDED  (existing, unchanged)
--------------

{existing MRP listing, unchanged}

IN PROGRESS  (existing, extended with assignee info)
-----------

M-2026-0316-001  "OAuth2 Migration"  [standard]  Tier 2
  Phase 3/5: implement  |  Author: Alice  |  Approver: Dave
  BP: BP-2026-0316-002  |  dispatched 2026-03-16

READY TO DISPATCH  (existing, extended with dependency info)
------------------

BP-2026-0316-011  "Backend: Auth"  ready  |  Author: Bob  |  Approver: Dave
  -> /ace-dispatch BP-2026-0316-011
  -> depends-on: none (can dispatch immediately)

BP-2026-0316-016  "Frontend: Auth UI"  ready  |  Author: Carol
  -> BLOCKED: depends-on BP-2026-0316-011 (status: in-progress)

PROJECT PROGRESS  (new section, for hierarchical BPs)
-----------------

BP-2026-0316-010  "Platform Migration"  [decomposed -> 8 children]
  Completed:    2/8  (25%)
  In progress:  3/8
  Ready:        1/8
  Blocked:      1/8  (dependency)
  Draft:        1/8

  +-BP-2026-0316-011  Backend: Auth       [completed]
  +-BP-2026-0316-012  Backend: Data       [completed]
  +-BP-2026-0316-013  Backend: API GW     [in-progress]
  +-BP-2026-0316-014  Backend: Queues     [in-progress]  depends-on: 013
  +-BP-2026-0316-015  Backend: Monitoring [ready]
  +-BP-2026-0316-016  Frontend: Auth UI   [in-progress]  depends-on: 011
  +-BP-2026-0316-017  Frontend: Dashboard [ready]        depends-on: 012
  +-BP-2026-0316-018  Frontend: Settings  [draft]

STATS  (existing, extended)
-----

Missions:  5 active  |  12 completed  |  17 total
CRPs:      3 open (1 blocking, 2 routed to specific people)  |  14 resolved
MRPs:      2 pending review (1 auto-approve eligible)  |  10 reviewed
BPs:       4 ready  |  3 draft  |  5 dispatched  |  2 decomposed  |  12 approved
Team:      8 members  |  3 active agent sessions
```

### 4.2 Filtered Views

New filters for team context:

| Filter | Meaning |
|--------|---------|
| `/status --mine` | Show only items where I am author, approver, contributor, or routed reviewer |
| `/status --team {name}` | Show items for a specific sub-team (requires team field on BPs) |
| `/status --tree BP-ID` | Show the full decomposition tree for a parent BP with progress |
| `/status --blocked` | Show only items that are blocked (dependency, CRP, review) |

### 4.3 User Identity

The team system needs to know who "I" am. This is derived from Git config:

```bash
git config user.name   -> "Alice Smith"
git config user.email  -> "alice@example.com"
```

The `author` field in BPs, the `resolved-by` field in VCRs, and the new
`approver`/`assignee`/`reviewers` fields all use the Git user identity.
No separate user management system is needed.

### 4.4 Notification Patterns

i-SASE does not introduce a notification system. Notifications are handled
by the Git hosting platform (GitHub/GitLab):

| Event | Notification Mechanism |
|-------|----------------------|
| BP ready for my approval | PR assigned to me on the `bp/` branch |
| CRP needs my attention | `routed-to` field in CRP frontmatter; `/status --mine` shows it |
| MRP ready for review | PR from mission branch; or `/status --mine` |
| Dependency I care about completed | `/status --tree` shows progress; GitHub Actions can notify |
| Child BP dispatched under my parent | Git commit notification on the mission branch |

**CRP Routing:**

CRPs gain a new optional field `routed-to` that names the team member
who should resolve it. Routing rules:

| CRP Trigger | Default Route |
|-------------|---------------|
| Security | `routed-to: {security-lead}` (configured in `mentorscripts/team.md`) |
| API/Schema change | `routed-to: {bp-author}` |
| Scope deviation | `routed-to: {bp-approver}` |
| Multi-approach ambiguity | `routed-to: {bp-author}` |
| Domain-specific | `routed-to: {assignee}` or `{bp-author}` |

If no `routed-to` is set, the CRP appears for everyone in `/status`.

---

## 5. Review and Quality in Teams

### 5.1 Review Model

The current single-reviewer model is extended to support multi-reviewer
workflows. The BP gains a `reviewers` field:

```yaml
# In BP frontmatter (new optional fields)
reviewers:
  - "bob@example.com"
  - "carol@example.com"
review-policy: "any-1"   # or "all", or "any-2"
```

**Review policies:**

| Policy | Meaning | Use Case |
|--------|---------|----------|
| `any-1` | Any one reviewer can approve | Standard BPs, Tier 2 |
| `any-2` | At least 2 of N reviewers must approve | Important BPs, Tier 3 |
| `all` | All listed reviewers must approve | Critical/security BPs |

**Default behavior (no `reviewers` field):** Falls back to single-reviewer
mode. Anyone can review. This preserves backward compatibility.

### 5.2 Specialized Review Routing

Certain BP characteristics trigger automatic reviewer assignment. This is
configured in a team MentorScript (`mentorscripts/team.md`):

```yaml
# mentorscripts/team.md -- review routing rules
review-routing:
  - match:
      constraints-contain: "security"
    add-reviewer: "security-team-lead"
    policy-minimum: "any-2"

  - match:
      constraints-contain: "database"
    add-reviewer: "dba-lead"

  - match:
      tier: "mission"
    policy-minimum: "any-2"

  - match:
      rigor: "critical"
    policy-minimum: "all"
```

The briefing-engineer agent reads these rules during BP creation and
auto-populates the `reviewers` field. Humans can override.

### 5.3 Quality-Gate Agent in Team Context

The quality-gate agent currently performs automated checks during the
LoopScript's gate phases. In a team context:

**Automated pre-review:** Before a human reviewer sees the MRP, the
quality-gate agent runs automated checks and produces a score. This score
is written to the MRP's `auto-score` field (already exists in the schema).

**Auto-approval threshold:** The existing auto-approval logic (score >= 90,
no security CRPs, all tests pass) is extended with a team override:

```yaml
# mentorscripts/team.md
auto-approval:
  enabled: true
  minimum-score: 90
  blocked-by:
    - security-crp
    - rigor-critical
    - tier-mission
  override-approvers:
    - "tech-lead@example.com"    # can override auto-approval decisions
```

**Override mechanism:** A tech lead can:
- Force-approve an MRP that fails auto-approval (with VCR justification)
- Block an auto-approval for manual review (sets `auto-approval: blocked`
  in the MRP frontmatter)

### 5.4 Review Workflow

```
Agent completes mission
        |
        v
  MRP produced with auto-score
        |
        +-- auto-score >= 90 AND no blockers --> auto-approve eligible
        |       |
        |       +-- review-policy is "any-1" --> auto-approve (VCR created)
        |       |
        |       +-- review-policy is "any-2" or "all" --> still needs human review
        |
        +-- auto-score < 90 OR blockers present --> mandatory human review
                |
                v
        Routed to reviewers from BP
                |
                v
        Each reviewer runs /ace-review-mrp
                |
                +-- approve --> VCR with reviewer identity
                +-- request revision --> agent reworks, new MRP
                +-- reject --> BP returns to ready for re-dispatch
                |
                v
        Policy check: enough approvals?
                |
                +-- yes --> MRP approved, mission completed
                +-- no --> waiting for more reviewers
```

### 5.5 Review VCR Extension

When multiple reviewers are involved, each reviewer produces their own VCR.
The mission is approved when the review policy is satisfied. The VCR schema
does not change -- each VCR records one reviewer's decision. The dispatch
system counts VCRs against the review policy.

```
VCR-2026-0316-010  resolves: MRP-2026-0316-001  resolved-by: bob@example.com   decision: approved
VCR-2026-0316-011  resolves: MRP-2026-0316-001  resolved-by: carol@example.com decision: approved
-> Policy "any-2" satisfied. Mission approved.
```

---

## 6. BP Assignment and Load Balancing

### 6.1 The Assignment Problem

When 20 BPs are `ready` and multiple agent sessions are available, the
system needs to decide which BP each agent works on.

### 6.2 Assignment Mechanism: Claim-Based with Priority Queue

The assignment model is **pull-based**: agents claim work from a priority
queue rather than having work pushed to them. This avoids the need for a
central coordinator.

**Priority queue ordering:**

```
Priority 1 (highest): rigor: critical
Priority 2:           rigor: high
Priority 3:           tier: mission
Priority 4:           tier: standard
Priority 5 (lowest):  tier: quick

Within each priority level:
  - BPs with all depends-on satisfied, sorted by created date (oldest first)
  - BPs with unmet depends-on are excluded from the queue
```

**Claim protocol (Git-based locking):**

```
1. Agent reads artifacts/briefings/ for all BPs with status: ready
2. Agent filters to BPs where all depends-on are completed
3. Agent sorts by priority (see above)
4. Agent picks the highest-priority BP
5. Agent sets status: claimed and writes claimed-by and claimed-at
   to the BP frontmatter
6. Agent commits and pushes to main (or mission branch)
7. If push fails (another agent claimed first), agent retries from step 1
   with the next BP in the queue
```

This is optimistic concurrency control via Git. The `git push` fails if
another agent has already modified the file, which serves as a distributed
lock.

**Frontmatter fields for claiming:**

```yaml
# Added to BP when claimed
claimed-by: "agent-session-abc123"
claimed-at: "2026-03-16T14:30:00Z"
```

### 6.3 Load Balancing

With multiple agent sessions, load balancing happens naturally through
the claim protocol -- each idle agent claims the next available BP. However,
the team may want to reserve capacity:

**Agent capacity configuration** (in `mentorscripts/team.md`):

```yaml
agent-pool:
  max-concurrent-missions: 5       # total active missions
  max-per-parent: 2                # max children of same parent running simultaneously
  reserve-for-critical: 1          # always keep 1 agent slot for critical BPs
```

The dispatch system checks these limits before allowing a claim.

### 6.4 Manual Override

A human can always bypass the priority queue:

```
/ace-dispatch BP-2026-0316-015 --force
```

This dispatches the specific BP regardless of priority ordering or
capacity limits. The `--force` flag is logged in the VCR.

---

## 7. Audit Trail for Teams

### 7.1 What Must Be Tracked

In an enterprise team, the audit trail answers six questions:

| Question | Answer Source |
|----------|-------------|
| Who created this BP? | `author` field + Git commit log |
| Who refined it? | `contributors` field + Git commit log on `bp/` branch |
| Who approved it for execution? | `approver` field + VCR for `ready` transition |
| Which agent executed it? | `claimed-by` field + mission manifest |
| Who reviewed the result? | VCR(s) for MRP review, `resolved-by` field |
| Why was a decision made? | VCR `rationale` field + CRP resolution chain |

### 7.2 New BP Frontmatter Fields

```yaml
# Team collaboration fields (all optional, additive to existing schema)
author: "alice@example.com"           # existing field, now uses email
contributors:                          # new: list of people who edited
  - "bob@example.com"
  - "carol@example.com"
approver: "dave@example.com"           # new: person who approves for ready
assignee: "agent-session-abc123"       # new: agent or human currently responsible
reviewers:                             # new: list of MRP reviewers
  - "bob@example.com"
  - "carol@example.com"
review-policy: "any-1"                 # new: how many reviewers must approve
team: "backend"                        # new: sub-team tag for filtering
claimed-by: "agent-session-abc123"     # new: agent that claimed this BP
claimed-at: "2026-03-16T14:30:00Z"    # new: when the claim happened
```

### 7.3 Git History as Complementary Audit

Git history provides the fine-grained audit trail that frontmatter fields
summarize. The relationship is:

| Frontmatter | Git History |
|-------------|-------------|
| `author: alice` | First commit on BP file |
| `contributors: [bob, carol]` | All distinct commit authors on the BP file |
| `approver: dave` | Merge commit author on the `bp/` branch PR |
| `status` transitions | Commits that modify the `status` field |
| CRP/VCR chain | Commit history in `artifacts/guidance/` |

**Convention:** Every status transition commit uses a prefix that makes it
searchable:

```
draft(BP-ID): {message}        -- initial creation
refine(BP-ID): {message}       -- collaborative editing
approve(BP-ID): {message}      -- approver marks ready
dispatch(BP-ID): {message}     -- dispatch to agent
claim(BP-ID): {message}        -- agent claims
complete(BP-ID): {message}     -- agent finishes
review(BP-ID): {message}       -- human reviews MRP
revert(BP-ID): {message}       -- backward transition
```

### 7.4 VCR Extensions for Team Audit

The VCR system is sufficient for team use but benefits from one addition:
recording status transitions that involve team decisions.

**New VCR decision types:**

```
Current:  ["crp-response", "mrp-approval", "mrp-rejection", "mrp-revision"]
Proposed: ["crp-response", "mrp-approval", "mrp-rejection", "mrp-revision",
           "bp-approval", "bp-revert", "dispatch-override"]
```

- `bp-approval` -- VCR created when an approver moves a BP to `ready`
- `bp-revert` -- VCR created when a BP is moved backward (e.g., `ready` to `draft`)
- `dispatch-override` -- VCR created when `--force` dispatch is used

### 7.5 Mission Outcome Log Extension

The existing `artifacts/log/missions.log` (append-only, one line per
mission outcome) is extended with team fields:

```
[2026-03-16T14:30:00Z] MISSION: M-2026-0316-001 | BP: BP-2026-0316-002 | TIER: standard | DECISION: approved | SCORE: 95 | AUTHOR: alice@example.com | APPROVER: dave@example.com | REVIEWERS: bob@example.com,carol@example.com
```

### 7.6 Compliance Report

For enterprise compliance, a new command generates a full provenance report
for any BP:

```
/status audit BP-2026-0316-002
```

Output:

```
AUDIT TRAIL: BP-2026-0316-002 "OAuth2 Migration"
=================================================

AUTHORING
---------
Created:      2026-03-14  by alice@example.com
Contributors: bob@example.com (3 commits), carol@example.com (1 commit)
Approved:     2026-03-15  by dave@example.com  (VCR-2026-0315-003)

EXECUTION
---------
Dispatched:   2026-03-15  auto-dispatch (Tier 2)
Claimed:      2026-03-15T10:05:00Z  by agent-session-abc123
Completed:    2026-03-16T09:30:00Z

CRPs:
  CRP-2026-0315-001  [blocking]  "Token storage"   resolved by carol (VCR-2026-0315-004)
  CRP-2026-0316-001  [deferred]  "Error format"    ratified in MRP review

REVIEW
------
MRP:          MRP-2026-0316-001  auto-score: 95
Reviewed by:  bob@example.com    approved (VCR-2026-0316-010)
              carol@example.com  approved (VCR-2026-0316-011)
Policy:       any-2 satisfied

ARTIFACTS
---------
Files changed: 14 (see git log M-2026-0316-001)
VCRs:          4 total
```

---

## 8. Schema Changes Summary

All changes are additive. No existing required fields are modified. No
existing enum values are removed.

### 8.1 briefing-pack.schema.json

New optional properties:

```json
{
  "contributors": {
    "type": "array",
    "items": { "type": "string" },
    "description": "List of people who contributed to this BP."
  },
  "approver": {
    "type": "string",
    "description": "Person who approves this BP for execution."
  },
  "assignee": {
    "type": "string",
    "description": "Person or agent currently responsible for this BP."
  },
  "reviewers": {
    "type": "array",
    "items": { "type": "string" },
    "description": "List of people who must review the resulting MRP."
  },
  "review-policy": {
    "type": "string",
    "enum": ["any-1", "any-2", "all"],
    "description": "How many reviewers must approve. Default: any-1."
  },
  "team": {
    "type": "string",
    "description": "Sub-team tag for filtering and routing."
  },
  "claimed-by": {
    "type": "string",
    "description": "Identifier of the agent session that claimed this BP."
  },
  "claimed-at": {
    "type": "string",
    "format": "date-time",
    "description": "ISO-8601 timestamp when the BP was claimed."
  }
}
```

Status enum extension:

```json
{
  "status": {
    "enum": ["draft", "ready", "decomposed", "dispatched", "claimed",
             "in-progress", "completed", "approved"]
  }
}
```

### 8.2 crp.schema.json

New optional property:

```json
{
  "routed-to": {
    "type": "string",
    "description": "Team member who should resolve this CRP."
  }
}
```

### 8.3 vcr.schema.json

Extended decision-type enum:

```json
{
  "decision-type": {
    "enum": ["crp-response", "mrp-approval", "mrp-rejection", "mrp-revision",
             "bp-approval", "bp-revert", "dispatch-override"]
  }
}
```

### 8.4 New File: mentorscripts/team.md

Team-specific configuration (review routing, agent pool limits, auto-approval
rules, CRP routing defaults). This file is optional. When absent, the system
operates in single-user mode.

---

## 9. Migration Path

### 9.1 Phase 1: Schema Extension (non-breaking)

1. Add optional fields to `briefing-pack.schema.json`
2. Add `routed-to` to `crp.schema.json`
3. Extend `decision-type` enum in `vcr.schema.json`
4. All existing artifacts remain valid

### 9.2 Phase 2: Command Updates

1. Extend `/brief` to support `approver` field in interactive mode
2. Extend `/status` with `--mine`, `--tree`, `--blocked` filters
3. Extend `/status` with "MY ITEMS", "TEAM OVERVIEW", "PROJECT PROGRESS"
4. Extend `/ace-dispatch` with dependency checking and claim protocol
5. Add `/status audit BP-ID` for compliance reports

### 9.3 Phase 3: Team MentorScript

1. Create `mentorscripts/team.md` template with:
   - Review routing rules
   - Agent pool configuration
   - Auto-approval overrides
   - CRP routing defaults
   - Team member registry
2. Update executor agent to read team MentorScript
3. Update briefing-engineer to auto-populate team fields

### 9.4 Phase 4: Branch Convention Adoption

1. Document the `bp/{BP-ID}` branch naming convention
2. Configure branch protection rules (optional, per-org)
3. Create Git hooks or CI checks for branch naming
4. Train team members on the collaborative authoring workflow

---

## Appendix A: Worked Example -- Full Team Workflow

**Context:** A team of 6 is migrating a payment system. Alice is tech lead.
Bob and Carol are backend engineers. Dave is frontend. Eve is security. Frank
is QA.

```
Day 1 -- Planning

  Alice:  /brief --full "Migrate payment processing to Stripe"
          -> BP-2026-0316-020 created with status: draft
          -> Scope assessment: RED (>30 files, >10k LOC)
          -> Decomposed into:
             BP-2026-0316-021  "Stripe SDK integration"       (Bob)
             BP-2026-0316-022  "Payment flow refactor"        (Bob)  depends-on: 021
             BP-2026-0316-023  "Webhook handler"              (Carol)
             BP-2026-0316-024  "Frontend payment form"        (Dave) depends-on: 021
             BP-2026-0316-025  "Security audit + PCI scope"   (Eve)
          -> Parent BP merged to main

Day 1-2 -- Collaborative Authoring (parallel)

  Bob:    Checks out bp/BP-2026-0316-021
          Adds detailed ACs for SDK version, error handling
          Commits and pushes

  Eve:    Checks out bp/BP-2026-0316-025
          Adds PCI-DSS constraints, security-specific ACs
          Adds herself as reviewer for all payment-related BPs
          Commits and pushes

  Carol:  Checks out bp/BP-2026-0316-023
          Adds webhook signature verification ACs
          Adds depends-on: BP-2026-0316-021 (needs SDK first)
          Commits and pushes

Day 2 -- Approval

  Alice:  Reviews PRs for all 5 child BPs
          Approves BP-021, BP-023, BP-025 (no changes needed)
          Requests changes on BP-022 (missing rollback AC)
          Approves BP-024 after Dave adds loading state AC
          -> All approved BPs have status: ready

Day 2-3 -- Execution (parallel)

  /ace-dispatch BP-2026-0316-021   -> agent claims, starts working
  /ace-dispatch BP-2026-0316-025   -> agent claims (no dependencies)
  BP-2026-0316-023: blocked (depends on 021)
  BP-2026-0316-024: blocked (depends on 021)

  Agent working on BP-021 raises CRP (blocking):
    "Stripe SDK v4 requires Node 20. Current project uses Node 18."
    routed-to: alice@example.com

  Alice: /status --mine
         -> sees CRP, resolves: "Upgrade to Node 20, add to constraints"

  Agent working on BP-025 raises CRP (deferred):
    "PCI SAQ-A vs SAQ-A-EP scope unclear"
    routed-to: eve@example.com

  Agent on BP-025 continues with provisional decision (SAQ-A)

Day 3 -- First completions

  BP-021: completed. MRP auto-score: 92.
  Eve reviews (security BP, mandatory). Approves.
  -> BP-023 and BP-024 unblocked, dispatched.

  BP-025: completed. MRP auto-score: 88.
  Eve reviews her own deferred CRP during MRP review.
  Ratifies the SAQ-A decision. Approves MRP.

Day 4-5 -- Remaining BPs complete

  All child BPs reach status: approved.
  Alice: /status --tree BP-2026-0316-020
         -> shows 5/5 children approved, 100% complete
         -> parent BP-2026-0316-020 status: approved (automatic)

  Frank: runs integration tests across all completed work
         (separate QA process, outside SASE scope)
```

---

## Appendix B: Decision Log

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| Git branches for BP collaboration | Leverages existing Git skills; no new tooling; provides natural conflict resolution | Locking (too restrictive), last-write-wins (too lossy), CRDT (too complex) |
| `collaborative` is not a stored status | Reduces state transitions; Git log provides the record | Explicit status (adds friction for every second contributor) |
| Pull-based agent claiming | Simpler than push-based; naturally load-balances; Git push as distributed lock | Central dispatcher (single point of failure), round-robin (ignores priority) |
| Review policies on BP, not global | Different BPs have different risk profiles | Global policy (too rigid), per-team policy (not granular enough) |
| VCR per reviewer, not per review | Each reviewer's decision is independently auditable | Single VCR with multiple signers (harder to query) |
| Optional team fields | Backward compatible; single-user workflow unchanged | Required fields (breaks existing BPs), separate team config (splits metadata) |
| Notifications via Git platform | No custom notification system to build/maintain | Email hooks (fragile), Slack integration (dependency), in-repo notification files (clutter) |
| Email as identity | Already in Git config; universally unique; no user management | Usernames (collision risk), UUIDs (unreadable), SSO integration (scope creep) |
