# i-SASE Framework -- Root MentorScript

> **i-SASE** = *instrumented Software Agent Software Engineering*
> Based on: Hassan et al. (2025), "Software Agent Software Engineering"

CLI-driven enterprise workflow for human teams and AI agents collaborating on software engineering.

## MentorScript Import

```
@import mentorscripts/global.md
@import mentorscripts/team.md
```
Agents MUST load these on startup if they exist. `global.md` = project-wide rules. `team.md` = review policies, routing, load balancing.

---

## Actors

**Human Roles** (identity from `git config user.name`):

| Role | Responsibility |
|------|---------------|
| **Author** | Create and edit draft BPs |
| **Contributor** | Refine/extend existing BPs (domain context, constraints) |
| **Approver** | Transition BP from draft to ready |
| **Reviewer** | Review MRPs, approve/reject agent work |
| **Dispatcher** | Send ready BPs to agents for execution |

**AI Teammates** (definitions in `agents/`):

| Role | Task |
|------|------|
| `executor` | Primary mission execution |
| `briefing-engineer` | BriefingPack creation and refinement |
| `quality-gate` | Gate checking and quality assurance |
| `reviewer` | Code and artifact review |

**Agent-ID:** 8-char hex, generated at startup via `openssl rand -hex 4`. Stored in BP frontmatter, CRP/MRP `raised-by`/`produced-by`, and every commit as `[agent:XXXXXXXX]`.

**Workbenches:** ACE (human command interface) and AEE (agent execution environment).

---

## Artifact IDs

All artifacts use **12-char random hex** IDs. Display as **6-char abbreviation**.
Generation: `openssl rand -hex 6`. Pattern: `^[0-9a-f]{12}$`. Never sequential.
Collision: extend abbreviation to 7, 8, ... chars until unique (display only).
Commands use prefix matching: `/brief a3f7c2` (like git).

---

## Tier System

| Tier | Command | BP File | Dispatch |
|------|---------|---------|----------|
| **1 (QUICK)** | `/do` | None. Inline summary. `/do --force` skips tier auto-upgrade. | Immediate |
| **2 (STANDARD)** | `/brief` | Agent-drafted `brief.md` | Auto on approval |
| **3 (MISSION)** | `/brief --full` | Full interactive `brief.md` | Separate via `/dispatch` |

---

## Artifact Reference

| Artifact | Format | Path |
|----------|--------|------|
| **BriefingPack (BP)** | YAML frontmatter + MD | `artifacts/briefings/{hash}-{slug}/brief.md` |
| **LoopScript (LS)** | Pure YAML | `skills/ale/loops/` |
| **MentorScript (MS)** | YAML frontmatter + MD | `mentorscripts/` (this file = Root MS) |
| **CRP** | YAML frontmatter + MD | `artifacts/guidance/crp/` |
| **MRP** | YAML frontmatter + MD | `artifacts/guidance/mrp/` |
| **VCR** | YAML frontmatter + MD | `artifacts/guidance/vcr/` |
| **Blueprint** | YAML frontmatter + MD | `artifacts/blueprints/{hash}-{slug}/blueprint.md` |

See `skills/` for detailed artifact specs (briefing-eng, ale, atme, age, blueprint-eng).

### BP Storage: Directory-Based Hierarchy

Each BP = directory containing `brief.md`. Directory name: `{hash}-{slug}`. The `slug` is a required field -- a human-readable short name (2-4 words, lowercase, hyphens) derived from the mission title. It is used in the directory name and all display output. Hierarchy = subdirectories. No `parent`/`children` frontmatter.
```
artifacts/briefings/
  a3f7c2e1b9d4-cobol-extraction/brief.md                                  # Parent BP
  a3f7c2e1b9d4-cobol-extraction/7b2d4e9f1a8c-inventory-analysis/brief.md  # Child BP (step 1)
  a3f7c2e1b9d4-cobol-extraction/c8a1f3d5e7b9-lnw-extraction/brief.md     # Child BP (step 2)
```
- Display format: `bp:a3f7c2 (cobol-extraction)` -- 6-char abbreviation plus slug in parentheses.
- Context inheritance: agents walk up the directory tree reading each ancestor's `brief.md`.
- `execution-order` in parent: array of strings (sequential) or arrays (parallel groups).
- `depends-on` in child: array of hash IDs. Blocks until dependency completed.
- Only leaf BPs (no subdirectories) are dispatched.
- The BP index at `artifacts/briefings/.index.json` is the fast-path for status queries. Regenerate with `python3 scripts/build-index.py`. Commands should use the index instead of scanning individual files.
- Completed BP trees are archived to `artifacts/briefings/.archive/` via the `/archive` command (or `python3 scripts/bp-transition.py archive {hash}`). Archiving is a physical directory move, not a status field. The archive preserves the full directory structure. `/status` does not scan `.archive/`. `/status audit {hash}` searches both active and archive. Use `/archive --restore {hash}` to undo.
- `depends-on` references any BP hash, not just siblings. Cross-tree dependencies are supported. The dispatcher validates all dependencies before dispatch.
- `artifacts` (optional): declares inputs and outputs of a leaf BP for traceability. Each entry has `path` (required), `direction` (`input`/`output`, required), `ac` (AC reference, optional), and `description` (optional). Parent BPs do not declare artifacts — their children do. Use `/migrate` to enrich existing BPs.

---

## Git Integration

### Status Lifecycle

**Leaf BPs** (no children — the units of agent work):
```
draft -> ready -> dispatched -> claimed -> in-progress -> completed -> reviewed
  ^        |                                                  |
  |        \-> draft (unapprove)                              \-> ready (reset: discard agent work)
  |                                    \-> abandoned (stale lock released)

Reviewed BP trees can be archived via /archive: physically moved to .archive/ directory.
```

**Archive:** Archiving is a **physical directory move** to `artifacts/briefings/.archive/`, NOT a frontmatter status. Agents must **NEVER** set `status: archived` in frontmatter. Use `python3 scripts/bp-transition.py archive {hash}` or the `/archive` command. Only humans (Author/Approver) may archive.

**Parent BPs** (have children): Status is **derived** from children, never stored in frontmatter. No explicit status transitions — the parent status updates automatically as children progress:
- All children `reviewed` → parent is `reviewed`
- All children `completed` or `reviewed` → parent is `completed`
- Any child `dispatched`/`claimed`/`in-progress` → parent is `in-progress`
- All children at least `ready` → parent is `ready`
- Otherwise → parent is `draft`

Parents with children **cannot be dispatched**. Only leaf BPs are dispatched.

| Transition | Where | Who |
|-----------|-------|-----|
| draft -> ready | main | Approver |
| ready -> dispatched | main | Dispatcher (leaf BPs only) |
| dispatched -> claimed | agent worktree | Agent |
| in-progress (heartbeat) | agent worktree | Agent |
| completed | agent worktree | Agent |
| reviewed (approved) | merge to main | Reviewer |
| reviewed -> [archived] | main | Human (Author/Approver) |
| ready -> draft (unapprove) | main | Approver |
| completed -> ready (reset) | main | Human (discards agent work) |
| abandoned | main (reset to ready) | Human |

**Status transition monitoring:** BP status transitions are monitored by a PreToolUse hook in `hooks/hooks.json` (plugin) or `.claude/settings.json` (standalone). This is a lightweight advisory check (not a blocking enforcement). All status transitions should follow the authorization matrix defined in `mentorscripts/team.md`.

### Worktree-per-Agent

Each agent works in an isolated **git worktree**, enabling parallel agent execution in the same repository. The main workspace stays on `main` at all times.

Branch naming: `agent/{agent-id}/{bp-hash}`
Worktree path: `.worktrees/{agent-id}-{bp-hash}/` (relative to repo root, gitignored)

**Claim Protocol:**
1. `git pull --rebase` (main workspace stays on `main`)
2. Verify BP status == `dispatched`
3. Generate agent-id: `openssl rand -hex 4`
4. Create worktree + branch: `git worktree add .worktrees/{agent-id}-{bp-hash} -b agent/{agent-id}/{bp-hash}`
5. Inside the worktree: set status = `claimed`, write agent-id + timestamp, commit + push
6. Verify: list branches for this BP. Earliest timestamp wins; loser removes worktree and aborts.

**Heartbeat:** Commit every 60 min + at phase transitions (inside the worktree). Fields: `last-heartbeat`, `phase`.

**Stale Detection:** `last-heartbeat` > 3h AND no open blocking CRPs = stale. Human releases lock via `/status`, BP returns to `ready`.

**Merge-back:** On MRP approval, from main: `git merge --no-ff agent/{agent-id}/{bp-hash}`.

**Cleanup:** After merge (or abandonment): `git worktree remove .worktrees/{agent-id}-{bp-hash}` then `git branch -d agent/{agent-id}/{bp-hash}`.

**Parallelism:** Multiple agents can run simultaneously -- each in its own worktree. No checkout conflicts. Claude Code dispatch uses `Agent(isolation: "worktree")` for automatic worktree lifecycle management.

### Commit Convention
Format: `action(bp:XXXXXX): description [agent:XXXXXXXX]`
Actions: `draft`, `refine`, `approve`, `dispatch`, `claim`, `heartbeat`, `complete`, `merge`, `release`, `archive`, `restore`
Search: `git log --all --grep='bp:a3f7c2'`

---

## CRP Rules

**Structural triggers** (deterministic, not confidence-based):

| # | Trigger | Default Mode |
|---|---------|-------------|
| 1 | API/Schema/Interface change | blocking |
| 2 | Security (auth, authz, crypto) | blocking |
| 3 | Scope deviation beyond BP | blocking |
| 4 | Cross-scope reversal (>current scope) | blocking |
| 5 | Multi-approach ambiguity (no BP guidance) | deferred |
| 6 | Data-destructive operation | blocking |
| 7 | Dependency change (add/remove/major upgrade) | deferred |
| 8 | Observable behavior change (not in BP) | deferred |

**Modes:**

| Mode | Behavior | File |
|------|----------|------|
| **Blocking** | Agent pauses. Human responds via `/resolve-crp`. | Yes |
| **Deferred** | Provisional decision, marked, continues. Reviewed in MRP. | Yes |
| **Inline** | Agent asks in conversation. Max 3/mission; 4th becomes deferred. | No |

**Blast-radius rule:** Deferred decision affecting >200 LOC or >3 files auto-escalates to blocking.
**CRP routing:** `routed-to` field targets team member. `/status --mine` shows routed items.
An agent must **never** make autonomous decisions on blocking triggers.

---

## ACE Commands

| Command | Purpose |
|---------|---------|
| `/do` | Tier 1 (QUICK): describe, confirm, execute |
| `/brief` | Tier 2/3: draft BP, review, dispatch |
| `/status` | Actionable overview: open CRPs, pending MRPs, stale agents |
| `/dispatch` | Manual dispatch (child BPs in Tier 3) |
| `/review-mrp` | Full MRP review with 5 criteria |
| `/resolve-crp` | CRP resolution with VCR creation |
| `/archive` | Archive reviewed BP trees, list/restore archived BPs |
| `/compare` | N-Version comparison |
| `/migrate` | Enrich existing BPs with new optional fields (e.g. `artifacts`) |
| `/blueprint` | Blueprint management: extract from BPs, instantiate new BPs, list/inspect/validate |

---

## Workflow

1. **Read BriefingPack** -- Walk ancestor chain, load all `brief.md` root-to-leaf. All fields binding.
2. **Follow LoopScript** -- Phases strictly sequential. Gate before proceeding. On failure: CRP or repeat.
3. **Produce artifacts** -- Per BP, schema-compliant. Commit + push from agent worktree.
4. **Generate MRP** -- Write Mission Review Protocol on completion.

---

## Blueprint System

Blueprints are reusable, parameterized templates extracted from concrete BP trees. They live at `artifacts/blueprints/{hash}-{slug}/blueprint.md` with schema `sase/blueprint/v1`.

**Three-level abstraction:** `methodology` (any modernization) > `technology` (e.g. COBOL-to-Java) > `project` (concrete template).

**Parameter syntax:** `{{PARAM_NAME}}` placeholders in body (UPPER_SNAKE_CASE). Typed: string, path, number, boolean, enum, list. Conditionals: `{% if PARAM %}...{% endif %}`.

**Lifecycle:** Extract from BP tree (`/blueprint extract`) -> Refine parameters -> Validate (`/blueprint validate`) -> Instantiate into new BPs (`/blueprint instantiate`).

See `skills/blueprint-eng/SKILL.md` for full specification.

---

## Conventions

- All artifacts: UTF-8, YAML frontmatter delimited by `---`
- Schema ref: `schema: <type>/<version>` (e.g. `schema: briefingpack/v3`)
- IDs: 12-char hex (artifacts), 8-char hex (agents). Never sequential.
- Date format: ISO 8601. Language: English (unless explicitly stated).
- Commits: `action(bp:XXXXXX): description [agent:XXXXXXXX]`
- An agent never modifies this file or `mentorscripts/` without explicit instruction
- **BP Explorer (`scripts/bp-explorer/index.html`):** Before adding any function, grep for existing functions with the same name (`grep -n "function <name>" scripts/bp-explorer/index.html`). The file contains code from multiple features (graph, dashboard, overview) that may define identically-named functions with different signatures. JS function hoisting means the last definition silently wins. If a duplicate exists, rename one to be more specific.

---

*This MentorScript is the Single Source of Truth for the i-SASE framework. Changes require a VCR entry.*
