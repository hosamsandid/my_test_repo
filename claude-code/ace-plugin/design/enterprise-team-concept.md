# i-SASE Enterprise Team Design

## Conceptual Redesign for Multi-User, Multi-Agent Parallel Execution

> Synthesized from 4 parallel architecture analyses: BP storage architecture,
> Git-based locking, team collaboration workflows, and compatibility impact.

---

## 1. The Problem

The current i-SASE framework assumes a single Agent Coach working with agents.
In an enterprise team of 10+ people:

- **BP IDs collide** -- Sequential `BP-2026-0311-001` creates race conditions when
  two people create BPs simultaneously
- **Flat file storage** breaks at scale -- 100+ BPs in one directory is unnavigable
- **No claiming mechanism** -- Two agents can start working on the same BP
- **No collaboration** -- One person writes a BP, period. No refinement by others.
- **No traceability** -- "Who decided this?" is unanswerable in a team

---

## 2. The Five Pillars of the Redesign

### Pillar 1: Hash-Based BP Identity

**Old:** `BP-2026-0311-001` (sequential, date-based, collision-prone)

**New:** 12-character random hex hash, displayed as 6-character abbreviation with slug.

```
Full ID:   a3f7c2e1b9d4
Slug:      auth-refactor
Display:   bp:a3f7c2 (auth-refactor)
Reference: /brief a3f7c2    (prefix matching, like git)
```

**Generation:** `openssl rand -hex 6` -- no coordination needed, collision-free.

**Abbreviation collision:** If two IDs share first 6 chars, extend to 7, 8, ...
until unique. Only affects display, never stored references.

**Schema:** `"id": { "pattern": "^[0-9a-f]{12}$" }` -- replaces `^BP-\d{4}-\d{4}-\d{3}$`

**Why not content-hash (like git)?** BPs are mutable (draft -> ready -> dispatched).
A content hash changes on every edit, breaking all cross-references.

---

### Pillar 2: Directory-Based Hierarchy

**Old:** Flat files in `artifacts/briefings/` with `parent:` and `children:` fields.

**New:** Each BP is a **directory** containing `brief.md`. Child BPs are subdirectories.

```
artifacts/briefings/
  a3f7c2e1b9d4-cobol-extraction/       # "COBOL Codebase Extraction"
    brief.md                            # The parent BP content
    7b2d4e9f1a8c-inventory-analysis/    # "Inventory & Gap Analysis"
      brief.md
    c8a1f3d5e7b9-lnw-extraction/       # "LNW Module Extraction"
      brief.md
      112233445566-lnw-copybooks/       # Grandchild (further decomposition)
        brief.md
    d9e2f4a6b8c1-lnm-extraction/       # "LNM Module Extraction"
      brief.md
  b4e8d1f3a5c7-plugin-conversion/      # "Plugin Conversion" (standalone)
    brief.md
```

**Rules:**
- Top level of `artifacts/briefings/` contains ONLY directories, never loose files
- Every BP, even a standalone leaf, is a directory containing `brief.md`
- `parent` and `children` frontmatter fields are **removed** (implicit from nesting)
- `depends-on` stays (for sibling ordering) but references hash IDs

**Why `brief.md`?** Not `README.md` (that's for project documentation, would confuse
GitHub rendering). Not `index.md` (implies a table of contents). `brief.md` is
descriptive and unambiguous.

**Context inheritance:** Agents walk up the directory tree, reading each ancestor's
`brief.md` to assemble the Shared Context chain. No explicit `parent:` field needed.

---

### Pillar 3: Execution Order & Dependencies

**Two complementary mechanisms:**

**`depends-on` in each child** (machine-readable, authoritative):
```yaml
# In child c8a1f3.../brief.md
depends-on:
  - "7b2d4e9f1a8c"   # Must complete before this BP starts
```

**`execution-order` in parent** (human-readable, orchestration view):
```yaml
# In parent a3f7c2.../brief.md
execution-order:
  - "7b2d4e9f1a8c"                             # Step 1: sequential
  - ["c8a1f3d5e7b9", "d9e2f4a6b8c1", "e0f3a5b7c9d1"]  # Step 2: parallel group
  - "f1a4b6c8d0e3"                             # Step 3: sequential
```

**Semantics:**
- Bare string = single BP, runs alone in that step
- Array = parallel group, all can run simultaneously
- Steps execute sequentially (step N+1 waits for all of step N)

**Patterns:**
- All sequential: `["a", "b", "c"]`
- All parallel: `[["a", "b", "c"]]`
- Fan-out: `["a", ["b", "c", "d"]]`
- Diamond: `["a", ["b", "c"], "d"]`

---

### Pillar 4: Git-Based Agent Coordination

**The core protocol: Branch-per-agent with optimistic locking.**

#### Agent Identity

Every executor agent gets a unique 8-char hex ID at startup:
```
Agent-ID: a3f7c20b  (from: openssl rand -hex 4)
```

Stored in: BP frontmatter, mission manifest, CRP/MRP `raised-by`/`produced-by`,
and every Git commit message as `[agent:a3f7c20b]`.

#### The Claim Protocol

```
1. git checkout main && git pull --rebase
2. Read BP: verify status == "dispatched"
3. Generate agent-id
4. Create branch: agent/{agent-id}/{bp-hash}
5. Set BP status = "claimed", write agent-id + timestamp
6. Commit + push branch
7. Verify: list all branches for this BP
   - If only mine -> claim confirmed, start work
   - If multiple -> earliest timestamp wins, loser aborts
```

**Why branches?** Each agent has an isolated workspace. No merge conflicts during
work. Results merged to main only after human approval (= the MRP review).

#### Heartbeat

Agent commits progress every 30 minutes + at each phase transition:
```
last-heartbeat: "2026-03-16T15:02:07Z"
phase: implement
```

#### Stale Lock Detection

If `last-heartbeat` is > 3 hours old AND no open blocking CRPs:
```
/status shows: [STALE] agent:a3f7c20b  Last heartbeat: 3h ago
/status release {bp-hash}   -> releases lock, returns BP to "ready"
```

Agent's branch is preserved (partial work may be useful).

#### Status Lifecycle

```
draft -> ready -> dispatched -> claimed -> in-progress -> completed -> reviewed
                                  |
                                  +-> abandoned (stale lock released)
```

| Transition | Git Action | Who |
|-----------|-----------|-----|
| draft -> ready | Commit + push on main | Approver (human) |
| ready -> dispatched | Commit + push on main | Dispatcher (human/command) |
| dispatched -> claimed | Commit + push from agent worktree | Agent |
| in-progress (heartbeat) | Commit + push from agent worktree | Agent |
| completed | Commit + push from agent worktree | Agent |
| reviewed (approved) | Merge branch to main, remove worktree | Reviewer (human) |
| abandoned | Commit on main (reset to ready) | Human |

---

### Pillar 5: Team Collaboration

#### Roles

| Role | Can Do | Example |
|------|--------|---------|
| **Author** | Create and edit draft BPs | Any team member |
| **Contributor** | Refine/extend existing BPs | Domain experts adding context |
| **Approver** | Transition BP from draft to ready | Tech lead, product owner |
| **Reviewer** | Review MRPs, approve/reject agent work | Senior engineers |
| **Dispatcher** | Send BPs to agents for execution | Anyone with approver authority |

Identity comes from `git config user.name` -- no separate user management.

#### Collaborative Authoring

Multiple people work on the same BP through standard Git:
1. Alice creates draft BP, commits + pushes
2. Bob adds acceptance criteria, commits + pushes
3. Carol adds constraints from her domain, commits + pushes
4. Dave (approver) reviews and marks as "ready"

Each person's contributions are tracked via Git history. The BP's `author` field
becomes an array: `["alice", "bob", "carol"]`.

#### CRP Routing

CRPs gain a `routed-to` field:
```yaml
routed-to: "carol"   # Domain expert for this area
```
`/status --mine` shows only items routed to the current user.

#### Multi-Reviewer MRP Approval

Configurable review policies in `mentorscripts/team.md`:
- `any-1`: Any one reviewer can approve (default for standard rigor)
- `any-2`: Two reviewers must approve (for high rigor)
- `all`: All designated reviewers must approve (for critical rigor)

#### Load Balancing

Agents claim work from a priority queue (pull-based):
1. Critical rigor first
2. High rigor second
3. Dependencies satisfied (skip BPs with unmet `depends-on`)
4. Oldest "dispatched" first (FIFO within priority)

---

## 3. Navigation at Scale

### Tree View (default `/status`)

```
BRIEFING PACKS (3 trees, 47 total)
------------------------------------

bp:a3f7c2 (cobol-extraction)  "COBOL Codebase Extraction"  [decomposed]  5 children (1 done, 3 in-progress, 1 draft)
bp:b4e8d1 (plugin-conversion) "Plugin Conversion"          [dispatched]   leaf
bp:f9c2a1 (auth-overhaul)     "Auth System Overhaul"       [decomposed]  12 children (4 done, 2 blocked, 6 draft)

Expand: /status a3f7c2    Filter: /status --filter status=draft    Search: /status --search "COBOL"
```

### Expanded Tree View (`/status a3f7c2`)

```
bp:a3f7c2 (cobol-extraction)  "COBOL Codebase Extraction"
  Step 1 (sequential):
    bp:7b2d4e (inventory-analysis)  "Inventory & Gap Analysis"  [completed]  agt:a3f7c20b
  Step 2 (parallel):
    bp:c8a1f3 (lnw-extraction)     "LNW Module Extraction"     [in-progress] agt:e91d4f56  Phase 3/5
    bp:d9e2f4 (lnm-extraction)     "LNM Module Extraction"     [in-progress] agt:b2c4d6e8  Phase 2/5
    bp:e0f3a5 (lnn-extraction)     "LNN Module Extraction"     [dispatched]  unclaimed
    bp:f1a4b6 (lnd-lnu-extraction) "LND+LNU Extraction"        [draft]
```

### Filters

```
/status --filter status=in-progress
/status --filter author=carol
/status --filter tree=a3f7c2
/status --mine                          # Items routed to me
/status --search "copybook"             # Full-text search across brief.md files
```

### Audit View

```
/status audit a3f7c2

PROVENANCE: a3f7c2 "COBOL Codebase Extraction"
  Created:    2026-03-11 by thorsten.a.maier
  Refined:    2026-03-12 by carol (added AC-4, AC-5)
  Refined:    2026-03-13 by bob (added constraints)
  Approved:   2026-03-14 by dave
  Dispatched: 2026-03-14 by dave
  Claimed:    2026-03-14 by agent:a3f7c20b
  Completed:  2026-03-15 by agent:a3f7c20b (MRP score: 92)
  Reviewed:   2026-03-15 by carol (approved, VCR-...)
  Merged:     2026-03-15 (branch agent/a3f7c20b/a3f7c2e1b9d4)
```

---

## 4. Schema Changes (v2 -> v3)

### briefing-pack.schema.json

| Change | Old | New |
|--------|-----|-----|
| Schema version | `sase/briefing-pack/v2` | `sase/briefing-pack/v3` |
| `id` pattern | `^BP-\d{4}-\d{4}-\d{3}$` | `^[0-9a-f]{12}$` |
| `parent` | string (BP ID) | **REMOVED** (implicit from directory) |
| `children` | array of BP IDs | **REMOVED** (implicit from subdirectories) |
| `depends-on` items | old BP ID pattern | `^[0-9a-f]{12}$` |
| New: `execution-order` | -- | array of (string or array-of-strings) |
| New: `agent-id` | -- | `^[0-9a-f]{8}$` |
| New: `claimed` | -- | ISO-8601 datetime |
| New: `last-heartbeat` | -- | ISO-8601 datetime |
| New: `phase` | -- | enum of LoopScript phases |
| New: `author` | single string | array of strings |
| New: `reviewers` | -- | array of strings |
| New: `approver` | -- | string |
| `status` enum | +`claimed`, +`abandoned`, +`reviewed` | |

### crp.schema.json / mrp.schema.json

| Change | Details |
|--------|---------|
| ID pattern | Hash-based (12 hex chars) |
| New: `raised-by` / `produced-by` | Agent-ID (8 hex chars) |
| New: `routed-to` (CRP only) | Team member name |
| New: `reviewed-by` (MRP only) | Array of reviewer names |

---

## 5. Impact Summary

**30+ files affected** across the entire framework:

| Category | Files | Severity |
|----------|-------|----------|
| Schemas (3) | briefing-pack, crp, mrp | Breaking change |
| Templates (4) | briefing-pack, crp, mrp, vcr | Breaking change |
| CLAUDE.md | Root MentorScript | Major rewrite |
| Commands (7) | All commands | Major rewrite |
| Agents (4) | All agents | Major rewrite |
| Skills (4) | All SKILL.md files | Moderate update |
| LoopScripts (2) | standard, high-rigor | Minor update |
| MentorScripts (1+) | global.md + new team.md | Moderate |
| Existing BPs (7) | All existing artifacts | Migration script |

**New files needed:**
- `mentorscripts/team.md` -- Team-specific rules (review policies, routing)
- Migration script for existing BPs (old format -> directory + hash)

---

## 6. Migration Strategy

### Phase 1: Schema + Storage (foundation)
1. Update schemas to v3 (accept both old and new IDs during transition)
2. Update templates for new frontmatter
3. Create migration script for existing BPs

### Phase 2: CLAUDE.md + Commands
4. Rewrite CLAUDE.md for hash IDs, directory hierarchy, agent-ids, team roles
5. Update all commands for directory-based BP access and hash references

### Phase 3: Agents + Git Integration
6. Add Git operations to executor and reviewer (pull, branch, claim, push)
7. Add agent-id generation and tracking
8. Add heartbeat mechanism

### Phase 4: Team Features
9. Create `mentorscripts/team.md` with review policies
10. Add team role fields to all artifacts
11. Implement CRP routing and multi-reviewer MRP approval
12. Migrate existing artifacts

---

## 7. Commit Message Convention

All commits in the enterprise system follow this pattern:

| Action | Format |
|--------|--------|
| BP creation | `draft(bp:a3f7c2): initial draft "COBOL Extraction"` |
| BP refinement | `refine(bp:a3f7c2): add AC-4 and AC-5` |
| BP approval | `approve(bp:a3f7c2): marked ready by dave` |
| Dispatch | `dispatch(bp:a3f7c2): dispatched for execution` |
| Agent claim | `claim(bp:a3f7c2): claimed by agent a3f7c20b` |
| Agent heartbeat | `heartbeat(bp:a3f7c2): phase implement [agent:a3f7c20b]` |
| Agent completion | `complete(bp:a3f7c2): MRP created [agent:a3f7c20b]` |
| MRP approval | `merge(bp:a3f7c2): approved [agent:a3f7c20b]` |
| Lock release | `release(bp:a3f7c2): stale lock released, was agent a3f7c20b` |

The `bp:XXXXXX` prefix makes all BP-related commits searchable:
`git log --all --grep='bp:a3f7c2'`

---

## 8. Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| BP filename | `brief.md` | Descriptive, avoids README/index confusion |
| ID generation | Random hex (not content hash) | Stable across edits, no coordination needed |
| ID length | 12 chars full, 6 display | Balance of collision resistance and readability |
| Hierarchy | Directory nesting | Eliminates orphaned references, visual structure |
| Agent locking | Branch-per-agent + optimistic push | Isolated workspaces, no merge conflicts during work |
| Agent identity | 8-char random hex | Short, unique, greppable in git log |
| Heartbeat | 30 min + phase transitions | Stale detection without excessive noise |
| Stale threshold | 3 hours (CRP-exempt) | Generous for long tasks, ignores legitimate CRP waits |
| Team identity | git config user.name | No separate user management |
| Review policy | Configurable (any-1, any-2, all) | Matches rigor level to review intensity |
| Branch strategy | agent/{id}/{bp-hash} | Unique names, isolates work, clean main |
| Ordering | execution-order (parent) + depends-on (child) | Human view + machine constraint |

---

*This design document is the result of 4 parallel architecture analyses.
It replaces the single-user model with a fully team-aware, Git-integrated,
enterprise-ready framework.*
