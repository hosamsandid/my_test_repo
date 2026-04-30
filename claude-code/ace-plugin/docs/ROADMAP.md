# i-SASE Roadmap

## Ideas at a Glance

The framework has a solid foundation -- governance, Git-based agent coordination, roles, and artifacts are all in place. What follows is a collection of ideas for where to take it next.

**Auto-Dispatch.** Right now, when an agent finishes a task, a human has to manually dispatch the next dependent task. For a tree with ten children, that is ten manual steps. The idea is to cascade dispatches automatically once a review is approved.

**Metrics.** All the data already lives in artifacts and Git history, but there is no aggregation. A metrics command could surface cycle time, CRP resolution latency, agent success rates, and stale lock frequency as a simple report.

**Alerting.** CRP routing tells someone they are responsible, but they only find out by polling. Push notifications via Slack, Teams, or n8n would close that gap.

**Getting Started Guide.** The learning curve is steep -- six artifact types, five roles, eight triggers, three tiers, seven commands. A tiered onboarding guide (5 minutes, 1 hour, 1 day) plus a reference card would help new users get productive quickly.

**Example Mission.** The old Hello World example was removed during the enterprise migration. A new end-to-end example using the current v3 format would give people something concrete to follow.

**Schema Migration.** The schema jumped from v2 to v3 with breaking changes. Teams adopting iteratively need a migration script that converts flat files to directory structures, generates hash IDs, and updates cross-references.

**Improved Claim Protocol.** The current "earliest timestamp wins" tiebreaker depends on agent-local clocks and is vulnerable to NTP drift. A push-first-wins approach on main would eliminate the race condition entirely.

**Completion Durability.** If an agent's final push fails and the process dies, completed work is stranded on a local branch with no recovery path. A local recovery file with branch name and commit hash would allow manual or automatic retry.

**Branch Cleanup.** Merged and abandoned branches accumulate over time. An automated cleanup policy -- remove worktrees on merge, tag and expire abandoned branches -- would keep the repository tidy.

**Concurrent Draft Editing.** Two contributors editing the same Agent definition on main get YAML merge conflicts. A branch-per-BP approach for drafting would mirror the agent worktree pattern and avoid these collisions.

**Project Management Bridge.** Creating BPs from scratch is tedious when the requirements already exist in Jira, Linear, or GitHub Issues. An import command that pulls in title, description, and acceptance criteria would save time.

**CI/CD Integration.** Gate commands currently run locally on the agent's machine. Wiring them into CI pipelines (GitHub Actions, GitLab CI) would add a layer of validation that is independent of the agent environment.

**Plugin Distribution.** Packaging i-SASE as an installable Claude Code plugin would make adoption as simple as a single install command instead of manual setup.

**RBAC Enforcement.** The current PreToolUse hooks are advisory -- they warn but do not block. Server-side Git hooks or branch protection rules could actually enforce the authorization matrix.

**Multi-Repo Support.** Enterprise codebases are often spread across multiple repositories. Extending BPs to reference files across repos would let agents work across boundaries.

**Budget Tracking.** An agent stuck in a retry loop can burn through tokens without any guardrail. Declaring a token budget per mission, tracking consumption in heartbeats, and auto-pausing at thresholds would close this gap.

**Health Check.** Over time, project state drifts -- stale indexes, orphaned branches, broken dependencies, misconfigured hooks. A diagnostic command that checks everything systematically and offers auto-repair for common issues would catch problems before they cause failures.

**Agent Pause and Resume.** There is no way to proactively pause a running agent. Use cases include budget thresholds, external blockers, or wanting to review intermediate state. A pause/resume lifecycle extension would give humans that control.

**Scheduled Routines.** All work is currently human-initiated. Recurring maintenance -- dependency checks, documentation freshness audits, entropy scans -- could run on a schedule, creating BPs automatically and following the normal governance lifecycle.

**Goal Alignment.** Agent definitions describe what and why at the task level, but there is no link to higher-level objectives. An optional goal reference in BPs would let teams answer questions like "how much effort goes toward Goal X?" without leaving the framework.

**Export and Import.** Setting up i-SASE in a new repository means repeating all configuration from scratch. An export/import mechanism for MentorScripts, LoopScripts, hooks, and settings would make configurations portable across projects.

**Progressive Disclosure.** A monolithic instruction file fails at scale -- context is scarce, everything competes for attention, and the file rots quickly. Restructuring CLAUDE.md as a compact map with details in linked documents would let agents navigate deliberately instead of pattern-matching locally.

**Mechanical Enforcement.** Documentation alone cannot keep an agent-generated codebase coherent. Agents replicate existing patterns, including bad ones. Custom linters and structural tests that enforce invariants -- with fix instructions baked into error messages -- turn every constraint into a self-correcting feedback loop.

**Agent-Readable App Environment.** Tests verify functions return correct values, but they cannot verify that a UI renders correctly or that a page loads in under 800ms. Patterns for per-worktree app boot, browser integration via Chrome DevTools, and local observability would let agents close the validation loop on their own work.

**Explicitly not planned** for now: autonomy modes, agent-to-agent communication, a web dashboard, a persistent database, and multi-provider abstraction. Each has a rationale in the detail section below.

---
---

> **Note:** The sections below contain detailed agent-level information intended for planning and implementation. They do not need to be read by humans but are preserved as reference material for anyone who wants to dive into the specifics of each concept.

---

## Current State: 7/10 (Enterprise-Ready Architecture)

The framework has a complete governance layer (CRP/VCR/MRP, team roles,
Git-based agent coordination, hash-based IDs with slugs). The architecture
is sound. The gap is operational tooling and real-world validation.

---

## Priority 1: Operational Maturity (7/10 -> 8/10)

### 1.1 Auto-Dispatch for Dependency Chains
**Problem:** When BP-A completes, a human must manually dispatch BP-B
(which depends on BP-A). For a tree with 10 children, this is 10 manual
dispatches.

**Solution:** After an MRP is approved and merged, automatically check
the parent BP's `execution-order`. If the next step's `depends-on` is
now satisfied, auto-dispatch those BPs. The human approves the MRP
once -- the cascade is automatic.

**Touches:** `commands/review-mrp.md`, `commands/status.md`, `agents/executor.md`

### 1.2 Observability & Metrics
**Problem:** All data exists in artifacts and Git history, but there
is no aggregation. Teams need cycle-time metrics, CRP resolution
latency, agent throughput, and trend analysis.

**Solution:** A `/metrics` command or periodic script that extracts:
- Average time per tier (draft -> completed)
- CRP resolution latency (created -> resolved)
- Agent success rate (MRPs approved on first review vs. revision)
- Stale lock frequency
- Heartbeat reliability (push failures per agent)

Output as Markdown report to `artifacts/log/metrics.md`.

**Touches:** New command or script. Reads `artifacts/log/missions.log`,
`artifacts/log/tier1.log`, CRP/MRP/VCR files, Git history.

### 1.3 Alerting via Webhooks
**Problem:** CRP routing sets `routed-to: carol`, but Carol only
discovers this by polling `/status`. No push notifications.

**Solution:** Add an optional webhook URL to `settings.json`. When
a blocking CRP is created or an MRP is ready for review, fire a
webhook (Slack, Teams, n8n, etc.). Use the existing n8n MCP integration
if available, or a simple `curl` in a PostToolUse hook.

**Touches:** `hooks/hooks.json`, `agents/executor.md` (CRP creation),
`commands/dispatch.md` (MRP notification)

---

## Priority 2: Adoption & Onboarding (7/10 -> 8/10)

### 2.1 Getting Started Guide
**Problem:** Steep learning curve. 6 artifact types, 5 roles, 8 triggers,
3 tiers, 7 commands.

**Solution:** A `docs/GETTING-STARTED.md` with:
- "Your first 5 minutes": install, `/do` a simple task
- "Your first hour": `/brief` a feature, review the MRP
- "Your first day": set up team roles, dispatch a Tier 3 mission
- "Reference card": one-page cheat sheet of commands and artifacts

### 2.2 Example Mission (New Format)
**Problem:** The old Hello World example was deleted during the
enterprise migration. No working example exists.

**Solution:** Create a new example under `examples/` using the v3
format: directory-based hierarchy, hash IDs, slugs, brief.md files,
CRP with routing, MRP with agent-id. Walk through the complete
lifecycle from draft to reviewed.

---

## Priority 3: Robustness Hardening (8/10 -> 9/10)

### 3.1 Schema Migration Tooling
**Problem:** Schema jumped from v2 to v3 with breaking changes. Teams
adopting iteratively need a migration path.

**Solution:** A `scripts/migrate-v2-to-v3.sh` that converts flat BP
files to directory structure, generates hash IDs, creates slug from
mission title, updates cross-references.

### 3.2 Claim Protocol Improvement
**Problem:** The "earliest timestamp wins" tiebreaker depends on
agent-local clocks, which may have NTP drift.

**Solution:** Replace with "dispatch command on main is the single
source of truth." The `dispatch` command writes the agent-id on
main. If two dispatches race, push-first-wins on main is the lock.
The agent worktree + branch is created only after the dispatch push succeeds.
This eliminates the timestamp comparison entirely.

### 3.3 Completion Durability
**Problem:** If an agent's completion push fails and the process dies,
the completed work is stranded on a local branch with no recovery.

**Solution:** Before the final push, write a local recovery file:
`artifacts/missions/{hash}/recovery.json` with the branch name and
commit hash. If the agent restarts, it checks for recovery files and
retries the push. If the agent is gone, a human can use the recovery
file to manually push the branch.

### 3.4 Worktree & Branch Lifecycle & Cleanup
**Problem:** Merged and abandoned branches accumulate. After weeks,
`git branch -r` is noisy. Local worktrees consume disk space.

**Solution:** Define a worktree/branch archival policy:
- On merge: worktree is removed (`git worktree remove`), branch is deleted. Commits preserved in main history via `--no-ff`.
- Abandoned worktrees: removed after stale lock release. Branch tagged (`archive/{agent-id}/{bp-hash}`), then deleted after 30 days.
- A `/status cleanup` command that lists removable worktrees and archivable branches.

### 3.5 Concurrent Draft Editing
**Problem:** Two contributors editing the same BP on main get YAML
frontmatter merge conflicts.

**Solution:** Use a branch-per-BP for drafting: `bp/{hash}-{slug}`.
Multiple contributors commit to this branch. The Approver merges
the BP branch to main when marking it `ready`. This mirrors the
agent worktree/branch pattern but for humans.

---

## Priority 4: Ecosystem Integration (9/10 -> 10/10)

### 4.1 Project Management Bridge
Connect BPs to external backlogs: Jira, Linear, GitHub Issues.
A `/brief --from-issue PROJ-123` that imports title, description,
and acceptance criteria from an issue tracker.

### 4.2 CI/CD Integration
Gate-commands currently run locally on the agent's machine. Wire
them into CI: when the agent completes the implement phase, trigger
a GitHub Actions / GitLab CI pipeline. The gate passes only when
CI reports success.

### 4.3 Plugin Distribution
Package i-SASE as a Claude Code plugin (`.claude-plugin/plugin.json`)
so teams can install it with `/plugin install`. See the draft BP
that was created earlier in this session for the scope.

### 4.4 RBAC Enforcement
Replace advisory PreToolUse hooks with server-side Git hooks or
GitHub branch protection rules that actually enforce the authorization
matrix. Only users in the "Approver" group can push `status: ready`.

### 4.5 Multi-Repository Support
Enterprise codebases are often polyrepo. Extend BPs to reference
files across repositories. Agents would clone multiple repos into
their workspace.

---

## Priority 5: Orchestration & Control

These items are informed by studying the [Paperclip](https://github.com/paperclipai/paperclip)
orchestration control plane — an open-source project that models entire
AI-driven companies with agent registries, budget enforcement, and
operational tooling. While i-SASE deliberately stays Git-native and
file-based (no database, no server), several Paperclip concepts address
real operational gaps in our framework.

### 5.1 Budget & Cost Tracking

**Problem:** An agent that enters an infinite retry loop, generates
excessive CRPs, or simply tackles a task that turns out to be larger
than expected can burn through tokens without any guardrail. Today
there is no visibility into cost until the cloud provider invoice
arrives. For enterprise adoption, cost governance is non-negotiable.

Paperclip solves this with per-agent, per-task, and per-project budget
tracking, including hard-stop at 100% budget and alerts at 80%.

**Solution — Three layers:**

**Layer 1: BP-level budget declaration (low effort)**
Add an optional `budget` field to the BriefingPack frontmatter:

```yaml
budget:
  max-tokens: 500000          # Hard ceiling for this mission
  alert-threshold: 0.8        # Warn at 80%
  currency-cap: 5.00          # Optional dollar cap (informational)
```

The schema in `briefing-pack.schema.json` gains a `budget` object.
Agents that do not support token counting simply ignore the field.

**Layer 2: Heartbeat cost reporting (medium effort)**
Each heartbeat commit includes cumulative token usage in the BP
frontmatter:

```yaml
cost:
  input-tokens: 142000
  output-tokens: 38000
  total-tokens: 180000
  estimated-cost-usd: 2.34
```

The executor agent (`agents/executor.md`) is extended to read the
Claude API usage from the session and write these fields. The
heartbeat hook (`hooks/hooks.json`) can check `total-tokens` against
`budget.max-tokens` and emit a warning or create a blocking CRP when
the threshold is crossed.

**Layer 3: MRP cost summary (low effort)**
The MRP template (`skills/engineering/templates/mrp.md`) gains a
**Resource Consumption** section:

```markdown
## Resource Consumption
- Total tokens: 180,000 (of 500,000 budget)
- Estimated cost: $2.34
- Phases: understand (12k), plan (8k), implement (140k), review (20k)
- CRP overhead: 2 CRPs, ~15k tokens
```

This gives reviewers and the `/metrics` command a data source for
cost trend analysis.

**Touches:** `skills/engineering/schemas/briefing-pack.schema.json`,
`skills/engineering/templates/briefing-pack.md`,
`skills/engineering/templates/mrp.md`, `agents/executor.md`,
`hooks/hooks.json`, `commands/status.md` (display budget utilization)

**Design constraint:** All cost data lives in Git artifacts (BP
frontmatter, MRP files). No external database or API required.
Agents that cannot report tokens (e.g., non-Claude adapters) leave
the `cost` fields empty — the budget is advisory, not a process
gate, unless a hook enforces it.

---

### 5.2 Health Check — `/ace:doctor`

**Problem:** Over time, project state drifts. Branches accumulate,
index files go stale, hooks get misconfigured, BPs reference
deleted dependencies, and MentorScripts may contain contradictions.
Currently, the only way to detect these issues is to stumble into
them during a mission.

Paperclip addresses this with a `paperclipai doctor` command that
runs diagnostics with automatic repair suggestions.

**Solution:** A new `/ace:doctor` command that performs a systematic
health check across all framework components.

**Diagnostic categories:**

| # | Check | Severity | Auto-fixable |
|---|-------|----------|--------------|
| D1 | `.index.json` out of sync with `artifacts/briefings/` | warning | yes (rebuild) |
| D2 | `INDEX.md` out of sync with `.index.json` | warning | yes (rebuild) |
| D3 | Orphaned agent branches (no matching BP or BP archived) | info | no (list for manual cleanup) |
| D4 | BPs with `status: dispatched` but no agent branch | error | no (suggest release) |
| D5 | BPs with `status: claimed` but stale heartbeat (>3h) | warning | no (suggest `/status release`) |
| D6 | `depends-on` references to non-existent BP hashes | error | no (report broken links) |
| D7 | Schema validation of all active BP frontmatter | error | no (report violations) |
| D8 | Hook integrity (all scripts in `hooks/` exist and are executable) | error | yes (chmod +x) |
| D9 | MentorScript consistency (global.md rules not contradicted by team.md) | warning | no (report conflicts) |
| D10 | Unresolved blocking CRPs older than 48 hours | warning | no (highlight for attention) |
| D11 | MRPs in `pending-review` status older than 72 hours | warning | no (highlight for attention) |
| D12 | Git remote reachability (can push/pull) | error | no (report connectivity) |
| D13 | Documentation freshness (docs/ content matches code behavior) | warning | no (create correction PR) |
| D14 | MentorScript/CLAUDE.md size (exceeds progressive-disclosure threshold) | info | no (suggest decomposition) |

**Agent-instructive diagnostics:** All diagnostic messages must tell
the agent *how to fix* the issue, not just *what is wrong*. This is
a key lesson from OpenAI's Harness Engineering practice: custom lint
error messages that include remediation instructions become
multipliers — they fire everywhere simultaneously and guide agents
to self-correct without human intervention. For example, D7 (schema
validation) should not just report "invalid field X" but output
"field X is not in schema — valid fields are [...], see
skills/engineering/schemas/briefing-pack.schema.json".

**Output format:**

```
ACE Doctor — Project Health Check
══════════════════════════════════

✓ Index files          in sync
✓ Hook integrity       all hooks executable
✗ Stale agents         2 agents with heartbeat > 3h
  → bp:a3f7c2 (cobol-extraction) — last heartbeat 5h ago
  → bp:7b2d4e (api-migration) — last heartbeat 4h ago
  Run: /status release a3f7c2

⚠ Broken dependencies  1 BP references non-existent hash
  → bp:c8a1f3 depends-on [9f1a8c...] — hash not found

Summary: 10 passed, 1 warning, 1 error
```

**Implementation:** The command is a skill at `commands/doctor.md`.
The heavy lifting is a Python script at `scripts/doctor.py` that
reads the file system, parses YAML frontmatter, queries Git branches,
and outputs structured JSON. The skill invokes the script and formats
the output.

**Repair mode:** `/ace:doctor --fix` auto-repairs fixable issues
(D1, D2, D8) and reports what was changed. Non-fixable issues are
listed with suggested remediation commands.

**Touches:** New `commands/doctor.md`, new `scripts/doctor.py`,
update `CLAUDE.md` command table.

---

### 5.3 Agent Pause & Resume

**Problem:** i-SASE can detect stale agents (heartbeat > 3h) and
release their locks, but there is no way to **proactively** pause
an agent that is still running. Use cases for pause:

- Budget threshold crossed — pause before more tokens are consumed
- External blocker discovered — no point in the agent continuing
- Human wants to review intermediate state before the agent proceeds
- Infrastructure issue — network flaky, CI down, Git remote unreachable

Paperclip models this explicitly: agents have an `idle → running →
paused → terminated` state machine with pause/resume transitions.

**Solution:** Extend the BP status lifecycle with a `paused` state:

```
draft → ready → dispatched → claimed → in-progress → paused → in-progress → completed → reviewed
                                                        ↑                        \→ abandoned
                                                   (human action)
```

**New transitions:**

| Transition | Who | How |
|-----------|-----|-----|
| in-progress → paused | Human (any role) | `/status pause {hash}` with reason |
| paused → in-progress | Human (Dispatcher or Approver) | `/status resume {hash}` |
| paused → abandoned | Human (Approver) | `/status release {hash}` |

**Agent-side behavior:**
The executor agent checks for `status: paused` at two points:
1. Before starting a new LoopScript phase
2. During each heartbeat commit

If the agent detects `status: paused`, it:
1. Commits current work-in-progress (no data loss)
2. Writes a `pause-acknowledged` timestamp to the BP frontmatter
3. Pushes the commit
4. Exits cleanly (exit code 0, not error)

On resume, the dispatcher or a new agent session picks up from the
last completed phase. The LoopScript phase field in the BP frontmatter
tells the agent where to continue.

**Pause metadata in BP frontmatter:**

```yaml
status: paused
paused-by: thorsten
paused-at: 2026-03-30T14:22:00Z
pause-reason: "Budget 80% threshold reached — reviewing scope before continuing"
```

**Integration with budget tracking (5.1):**
When the heartbeat hook detects that `cost.total-tokens` exceeds
`budget.max-tokens * budget.alert-threshold`, it can automatically
set `status: paused` and create a deferred CRP with category
`budget-threshold`. This creates a closed loop: budget declaration →
cost tracking → automatic pause → human review → resume or abandon.

**Touches:** BP schema (new `paused` status value, new fields),
`agents/executor.md` (pause detection logic), `commands/status.md`
(pause/resume subcommands), `mentorscripts/team.md` (authorization
for pause/resume), `hooks/hooks.json` (optional auto-pause hook).

---

### 5.4 Scheduled Routines & Recurring Tasks

**Problem:** All work in i-SASE is initiated by a human typing a
command. There is no mechanism for recurring maintenance tasks:
dependency update checks, security scans, documentation freshness
audits, metric report generation, or periodic health checks. Teams
end up building ad-hoc cron jobs outside the framework, losing
traceability and governance.

Paperclip solves this with a `routines` entity — scheduled tasks
with configurable intervals that automatically create work items.

**Solution:** A `routines/` directory containing routine definitions
as YAML files, and a `/ace:routine` command to manage them.

**Routine definition format:**

```yaml
# routines/weekly-dependency-check.yaml
schema: routine/v1
id: a1b2c3d4e5f6
name: Weekly Dependency Check
schedule: "0 9 * * 1"           # Cron syntax: Monday 9:00 AM
tier: quick                      # Tier 1 (no BP), or standard/mission
enabled: true
command: "/do Check all dependencies for known CVEs and outdated versions. Report findings."
# For tier standard/mission:
# template: routines/templates/dep-check-bp.yaml
last-run: 2026-03-24T09:00:00Z
last-result: completed           # completed, failed, skipped
created-by: thorsten
```

**Execution model:**

For **Tier 1 routines**, the scheduler directly invokes `/do` with
the configured prompt. No BP is created — the work is logged in
`artifacts/log/tier1.log` as usual.

For **Tier 2/3 routines**, the scheduler creates a BP from a template,
sets its status to `ready`, and auto-dispatches it. The routine
template is a pre-filled BP with parameterized fields (e.g., date
ranges, version numbers). The created BP follows the normal lifecycle:
dispatch → claim → execute → MRP → review.

**Built-in routine templates (informed by OpenAI's Harness Engineering):**

OpenAI's experience with a fully agent-generated codebase showed that
agents replicate existing patterns — including suboptimal ones — causing
inevitable drift. Their solution: recurring "garbage collection" agents
that scan for deviations and open targeted fix PRs. i-SASE should ship
with a set of built-in routine templates:

| Routine | Tier | Cadence | Purpose |
|---------|------|---------|---------|
| `doc-gardening` | quick | weekly | Scan docs/ for content that contradicts actual code behavior. Open correction PRs. |
| `quality-score-update` | quick | weekly | Re-evaluate each product area and architecture layer. Update `QUALITY_SCORE.md`. |
| `entropy-scan` | quick | daily | Detect pattern drift: duplicated utilities, inconsistent naming, boundary violations. Open targeted refactoring PRs. |
| `dependency-check` | quick | weekly | Check dependencies for known CVEs and outdated versions. |
| `stale-artifact-sweep` | quick | weekly | Find orphaned CRPs, abandoned branches, expired routines. Report or auto-archive. |

These routines embody the principle that technical debt is a
high-interest loan — continuous small repayments are cheaper than
periodic painful cleanups. The key insight: human taste is captured
once (in linters, golden principles, quality docs) and then enforced
continuously by agents across every line of code.

**Scheduling backend:**
i-SASE stays file-based — no daemon. Two options:

1. **Hook-based (lightweight):** A PostToolUse hook on conversation
   start checks `routines/*.yaml` against current time. If a routine
   is overdue, it triggers. This "lazy evaluation" model means routines
   only fire when a human starts a conversation, which is acceptable
   for most maintenance cadences.

2. **Cron-based (reliable):** A system cron job runs
   `scripts/check-routines.py` at a fixed interval (e.g., hourly).
   The script scans `routines/`, compares `schedule` against
   `last-run`, and invokes the appropriate `/do` or `/brief` command
   via Claude Code CLI. This requires Claude Code to be installed
   on the scheduling host.

**Commands:**

| Command | Purpose |
|---------|---------|
| `/ace:routine list` | Show all routines with next-run time |
| `/ace:routine create` | Interactive routine creation |
| `/ace:routine enable/disable {id}` | Toggle without deleting |
| `/ace:routine history {id}` | Show past runs and results |
| `/ace:routine run {id}` | Trigger immediately (bypass schedule) |

**Touches:** New `routines/` directory, new `commands/routine.md`,
new `scripts/check-routines.py`, new schema
`skills/engineering/schemas/routine.schema.json`,
update `CLAUDE.md` artifact reference table.

---

### 5.5 Strategic Goal Alignment

**Problem:** BriefingPacks describe *what* to do and *why* at the
task level, but there is no explicit link to higher-level strategic
goals. A team running 20 parallel BPs cannot easily answer: "How
much of our effort is going toward Goal X vs. Goal Y?" or "Is this
BP aligned with any declared objective?"

Paperclip enforces that every task traces to a company goal through
a parent chain. This creates a goal tree: company goals → team
goals → project goals → individual tasks.

**Solution:** A lightweight `goals/` directory with goal definitions,
and an optional `goal` field in BP frontmatter that references a
goal ID.

**Goal definition format:**

```yaml
# goals/q2-platform-stability.yaml
schema: goal/v1
id: d4e5f6a7b8c9
name: Platform Stability
description: >
  Reduce P1 incidents by 50% and achieve 99.9% uptime
  for all customer-facing services by end of Q2 2026.
owner: thorsten
timeframe:
  start: 2026-04-01
  end: 2026-06-30
key-results:
  - id: kr-01
    description: "P1 incidents < 3 per month (currently 6)"
    metric: p1-incident-count
    target: 3
    current: 6
  - id: kr-02
    description: "Uptime > 99.9% (currently 99.7%)"
    metric: uptime-percentage
    target: 99.9
    current: 99.7
status: active                    # active, achieved, abandoned
parent: null                      # For sub-goals, reference parent ID
```

**BP integration:**

```yaml
# In a BriefingPack's frontmatter:
goal: d4e5f6a7b8c9              # References the goal ID
goal-kr: kr-01                   # Optional: specific key result
```

**Alignment reporting:**
The `/status` command gains a `--goals` view that groups active BPs
by goal:

```
Strategic Goal Alignment
════════════════════════

Platform Stability (d4e5f6)  [Q2 2026, owner: thorsten]
  KR-01: P1 incidents < 3/month (current: 6)
    → bp:a3f7c2 (fix-retry-storms)      in-progress
    → bp:7b2d4e (circuit-breaker-lib)    completed
  KR-02: Uptime > 99.9%
    → bp:c8a1f3 (db-failover)           ready
  Unlinked: 0 BPs

Feature Velocity (e5f6a7)  [Q2 2026, owner: anna]
  → bp:1a2b3c (api-v3-endpoints)        dispatched
  Unlinked: 0 BPs

⚠ Unaligned BPs (no goal reference):
  → bp:f9e8d7 (readme-update)           draft
  → bp:b6c5d4 (legacy-cleanup)          in-progress
```

**Design principles:**
- Goals are **optional**. Not every BP needs a goal (especially
  Tier 1 quick tasks). Unaligned BPs are flagged but not blocked.
- Goals are **informational, not gatekeeping**. They help teams
  understand allocation, not restrict what can be worked on.
- Key results are **manually updated**. i-SASE does not auto-measure
  metrics — that requires external observability tooling. The goal
  file is a living document updated by humans.
- Goals can be **hierarchical** (via `parent` field) for larger
  organizations, but a flat list is perfectly valid.

**Touches:** New `goals/` directory, new schema
`skills/engineering/schemas/goal.schema.json`,
BP schema (new optional `goal` and `goal-kr` fields),
`commands/status.md` (goals view), update `CLAUDE.md` artifact
reference table.

---

### 5.6 Project Portability — Export & Import

**Problem:** When a team sets up i-SASE in a new repository, they
start from scratch: run `/ace:init`, configure MentorScripts, define
team roles, customize LoopScripts, set up hooks. If the team has
5 repositories with similar governance needs, they repeat this setup
5 times. Customizations (additional CRP triggers, modified review
policies, custom LoopScript phases) are not transferable.

Paperclip solves this with a Markdown-first export/import format
that captures the entire company configuration as a portable package,
including collision handling strategies for imports.

**Solution:** `/ace:export` and `/ace:import` commands that package
and restore project configuration.

**Export format — a `.ace-config/` directory:**

```
.ace-config/
  manifest.yaml              # Package metadata and version
  mentorscripts/
    global.md                # Customized global rules
    team.md                  # Team roles and policies
  loopscripts/
    standard.yaml            # Customized standard loop
    high-rigor.yaml          # Customized high-rigor loop
    custom-security.yaml     # Team-specific loops
  hooks/
    hooks.json               # Hook configuration
    *.sh                     # Custom hook scripts
  settings.yaml              # Environment settings (sanitized)
  goals/                     # Goal definitions (if any)
  routines/                  # Routine definitions (if any)
  README.md                  # Auto-generated description of this config
```

**Manifest format:**

```yaml
# .ace-config/manifest.yaml
schema: ace-config/v1
name: "Platform Team Standard Config"
description: >
  Standard i-SASE configuration for platform team repositories.
  Includes strict security CRP triggers, 2-reviewer policy for
  API changes, and weekly dependency check routine.
version: 1.0.0
created: 2026-03-30T10:00:00Z
created-by: thorsten
ace-version: ">=1.2.0"          # Minimum compatible ACE version
includes:
  - mentorscripts
  - loopscripts
  - hooks
  - settings
  - goals
  - routines
excludes:
  - artifacts                   # Never export work-in-progress
  - agents                      # Agent definitions are plugin-provided
```

**What is explicitly NOT exported:**
- Artifacts (BPs, CRPs, MRPs, VCRs) — these are project-specific work
- Agent definitions — these ship with the plugin
- Secrets or API keys — `settings.yaml` is sanitized (environment
  variable names preserved, values replaced with placeholders)
- Git history — the config package is a snapshot, not a clone

**Import behavior:**

```
/ace:import path/to/.ace-config/
```

The import command walks the manifest, and for each file:

| Scenario | Strategy | User choice |
|----------|----------|-------------|
| File does not exist in target | Copy | Automatic |
| File exists, content identical | Skip | Automatic |
| File exists, content differs | Prompt | `keep` / `replace` / `merge` (show diff) |
| File exists, not in manifest | Ignore | Automatic (never delete) |

For `merge`, the command shows a side-by-side diff and lets the user
choose per-section (e.g., keep local team roles but adopt imported
review policies).

**Sharing mechanisms:**
The `.ace-config/` directory can be:
- Committed to a shared "team-standards" repository
- Distributed as a tarball or zip
- Published as a Git submodule
- Stored in a package registry (future)

**Commands:**

| Command | Purpose |
|---------|---------|
| `/ace:export` | Package current config to `.ace-config/` |
| `/ace:export --out path/` | Export to custom location |
| `/ace:import path/` | Import config with conflict resolution |
| `/ace:import --dry-run path/` | Preview changes without applying |

**Touches:** New `commands/export.md`, new `commands/import.md`,
new schema `skills/engineering/schemas/ace-config.schema.json`,
update `CLAUDE.md` command table.

---

## Priority 6: Harness Engineering (Agent-Centric Development)

These items are informed by OpenAI's [Harness Engineering](https://openai.com/index/harness-engineering/)
post (February 2026), which documents building a production product
with zero manually written code using Codex agents. The core thesis:
**the discipline shifts from writing code to designing environments,
specifying intent, and building feedback loops that enable agents to
work reliably.** While i-SASE already embodies many of these principles
(Git-native artifacts, BriefingPacks as intent specification, LoopScripts
as execution structure), the post reveals specific operational patterns
that emerged only at scale — 1M LOC, 1500 PRs, 3-7 engineers.

### 6.1 Progressive Disclosure for Agent Context

**Problem:** A monolithic instruction file (AGENTS.md, CLAUDE.md)
fails at scale in predictable ways:

1. **Context is scarce.** A huge instruction file crowds out the actual
   task, code, and relevant docs — the agent either misses important
   constraints or optimizes for the wrong ones.
2. **When everything is "important", nothing is.** Agents pattern-match
   locally instead of navigating deliberately.
3. **It rots immediately.** A monolithic handbook becomes a graveyard
   of outdated rules. Agents cannot distinguish what is still true.
4. **It resists mechanical review.** A single blob does not lend itself
   to coverage checks, freshness audits, or cross-references — drift
   is inevitable.

OpenAI's solution: AGENTS.md is ~100 lines — a *table of contents*,
not an encyclopedia. The real knowledge lives in a structured `docs/`
directory treated as the system of record. This enables *progressive
disclosure*: agents start with a small, stable entry point and learn
where to look next, rather than being overwhelmed upfront.

**Solution for i-SASE:**

Audit and restructure the CLAUDE.md / MentorScript hierarchy to follow
the "map, not manual" principle:

1. **CLAUDE.md as entry point (~100-150 lines):** Project identity,
   actor overview, artifact reference table, and `@import` directives
   to MentorScripts. Remove inline detail that belongs in referenced
   files.

2. **Structured knowledge store:**
   ```
   mentorscripts/
     global.md              # Project-wide invariants (compact)
     team.md                # Roles, review policies, routing
   docs/
     architecture.md        # Domain overview, package layering
     design-docs/
       index.md             # Cataloged, indexed, with verification status
       core-beliefs.md      # Agentic operating principles
     quality-score.md       # Per-area quality ratings, tracked over time
   skills/                  # Deep specs per artifact type (already exists)
   ```

3. **Mechanical freshness enforcement:** CI or hook that validates
   docs are current, cross-linked, and correctly structured (see 5.2
   D13-D14). A recurring doc-gardening routine (see 5.4) scans for
   docs that no longer reflect code behavior and opens correction PRs.

4. **Core beliefs document:** A small set of agentic operating
   principles that define *how agents should reason* in this project.
   Not implementation rules — philosophical invariants. Example:
   "Validate data at boundaries, never trust inferred structure" or
   "Prefer boring, well-documented technologies over novel ones."

**Design principle:** From the agent's perspective, everything it
cannot access in context during execution effectively does not exist.
Knowledge in Slack threads, Google Docs, or human heads is invisible
to the system. Repository-local, versioned artifacts are all it can
see. Every design decision made in conversation must land as an
artifact in the repo — MentorScript update, BP constraint, or VCR
entry.

**Touches:** `CLAUDE.md` (restructure), `mentorscripts/global.md`
(extract detail from CLAUDE.md), new `docs/core-beliefs.md`,
new `docs/architecture.md`, `hooks/hooks.json` (freshness checks).

---

### 6.2 Mechanical Invariant Enforcement

**Problem:** Documentation alone cannot keep an agent-generated
codebase coherent. Agents replicate patterns they find in existing
code — including inconsistent or suboptimal ones. Prose instructions
are ambiguous, easily overlooked, and impossible to verify
mechanically. Over time, style drift and architectural erosion are
inevitable.

OpenAI's key insight: **enforce invariants, don't micromanage
implementations.** Define strict boundaries (architecture layers,
dependency directions, naming conventions) and enforce them with
custom linters and structural tests. Within those boundaries, grant
agents full autonomy over how solutions are formulated. This mirrors
managing a large platform engineering organization: boundaries
centrally enforced, autonomy locally granted.

**Solution for i-SASE:**

**Layer 1: Framework-level linters (i-SASE's own artifacts)**

| Linter | What it checks | Enforcement |
|--------|---------------|-------------|
| BP schema validator | All active BP frontmatter conforms to schema | CI + pre-dispatch hook |
| LoopScript conformity | LoopScript phases match declared schema, gates are present | CI |
| MentorScript consistency | global.md rules not contradicted by team.md | `/ace:doctor` D9 |
| Artifact ID format | All IDs are 12-char hex, no sequential patterns | CI |
| Commit convention | Commits match `action(bp:XXXXXX): description [agent:XXXXXXXX]` | pre-commit hook |

**Layer 2: Project-level linters (target codebase)**

i-SASE should provide a pattern for projects to define their own
architectural invariants that agents must respect. These are declared
in a `lints/` directory as executable checks:

```yaml
# lints/layer-boundaries.yaml
schema: lint/v1
name: Layer Boundary Enforcement
description: >
  Code in the service layer must not import from the UI layer.
  Dependency direction: types → config → repo → service → runtime → UI.
check: "scripts/check-layer-boundaries.sh"
fix-instructions: >
  Move the import to the correct layer. If the dependency is
  genuinely needed, introduce a provider interface at the boundary.
  See docs/architecture.md for the layer diagram.
severity: error
```

The `fix-instructions` field is critical — it is injected into the
agent's context when the lint fails, turning every constraint
violation into a self-correcting feedback loop. Rules that feel
pedantic to human developers become force multipliers for agents:
once codified, they apply everywhere simultaneously.

**Layer 3: Taste invariants**

Some rules encode human aesthetic judgment rather than correctness:
structured logging format, file size limits, naming conventions for
schemas and types. These are "taste invariants" — they keep the
codebase readable and consistent for future agent runs. They are
enforced via lints but documented in `docs/core-beliefs.md` (see 6.1)
so agents understand *why* the rule exists, not just *what* it is.

**Key principle:** When documentation is not sufficient to enforce a
rule, encode it as a lint. When a lint is not sufficient (too complex
for static analysis), encode it as a structural test. The progression
is: prose → lint → test → architecture constraint.

**Touches:** New `lints/` directory convention, new schema
`skills/engineering/schemas/lint.schema.json`,
`hooks/hooks.json` (lint integration), `docs/core-beliefs.md`,
`agents/executor.md` (lint execution in verify phase).

---

### 6.3 Agent-Readable Application Environment

**Problem:** i-SASE agents currently validate their work through
code-level feedback: tests pass, linters are green, schema validates.
But for agents building user-facing applications, this is
insufficient. A test can verify that a function returns the right
value, but it cannot verify that the UI renders correctly, that the
page loads in under 800ms, or that a critical user journey completes
without errors. Without application-level feedback, agents cannot
close the loop on their own work, and human QA becomes the
bottleneck — exactly the scaling constraint OpenAI identified.

OpenAI's solution: make the entire application stack agent-readable.
The app boots per Git worktree (isolated instance per change). Chrome
DevTools Protocol gives agents DOM snapshots, screenshots, and
navigation. A local observability stack (logs, metrics, traces)
is ephemeral per worktree. Agents query logs with LogQL, metrics
with PromQL. This makes prompts like "ensure service startup
completes in under 800ms" or "no section in these four critical
user journeys exceeds two seconds" directly actionable.

**Solution for i-SASE:**

This is not a framework feature but a **guidance pattern** for
projects using i-SASE. The framework should document and support
it through:

**1. Worktree-isolated application boot (LoopScript integration):**

LoopScripts gain an optional `environment` block that declares how
to boot the application for agent validation:

```yaml
# In a LoopScript phase:
verify:
  environment:
    boot: "scripts/boot-app.sh --worktree"
    teardown: "scripts/teardown-app.sh"
    healthcheck: "curl -sf http://localhost:$PORT/health"
    timeout: 120s
  gates:
    - tests-pass
    - lints-clean
    - app-healthcheck
```

The executor agent boots the app before running validation and tears
it down after. Each worktree gets its own port and isolated state.

**2. Browser integration (MCP-based):**

Document the pattern for integrating Chrome DevTools Protocol as an
MCP tool. Agents can then take DOM snapshots, capture screenshots,
and navigate the UI to validate visual changes. This enables
"before/after" validation: snapshot the bug, implement the fix,
snapshot the result.

**3. Observability integration:**

Document the pattern for a per-worktree observability stack (e.g.,
Vector → VictoriaMetrics/VictoriaLogs). Agents query logs and
metrics to validate non-functional requirements. Performance budgets
become enforceable acceptance criteria in BPs:

```yaml
# In a BriefingPack:
acceptance-criteria:
  - description: "Service startup completes in under 800ms"
    validation: "promql: app_startup_duration_seconds < 0.8"
  - description: "No critical user journey exceeds 2s"
    validation: "scripts/check-journey-latency.sh --max 2000"
```

**4. Agent runtime duration:**

OpenAI reports single Codex runs working 6+ hours on a single task,
often while humans sleep. i-SASE's heartbeat mechanism (commit every
60 min) already supports long-running agents. The combination of
application-level feedback and long runtimes enables agents to
iterate through complex bug-fix-validate cycles autonomously.

**Design constraint:** i-SASE does not ship an observability stack or
browser integration — that would violate the "no infrastructure
dependencies" principle. It provides the *patterns*, *LoopScript
hooks*, and *BP schema extensions* for projects to wire in their own
tooling.

**Touches:** LoopScript schema (new `environment` block),
BP schema (validation expressions in acceptance criteria),
`agents/executor.md` (environment lifecycle), new
`docs/patterns/agent-readable-app.md` (guidance document).

---

## Not Planned (Explicitly Deferred)

- **Progressive trust / autonomy modes**: The 3-tier system covers
  the behavioral space. Autonomy modes (AUTOPILOT/SUPERVISED/GUARDED)
  add complexity without proven need. OpenAI's Harness Engineering
  experience shows that the path to increased agent autonomy runs
  through *mechanical enforcement* (6.2), not trust levels — when
  linters, structural tests, and agent-to-agent review are strong
  enough, human review load naturally decreases. The right investment
  is in tooling (Priority 6), not in a trust configuration layer.
  Revisit after 6 months of usage.
- **Agent-to-agent communication (A2A)**: Coordination through human
  layer is sufficient for current scale. Revisit when dependency
  chains exceed 10 steps.
- **Web dashboard**: CLI-first is the right choice for developer
  teams. A web dashboard is a nice-to-have, not a must-have.
  INDEX.md and `/status` cover browsing needs.
- **Persistent database**: i-SASE deliberately uses Git + filesystem
  as its only persistence layer. This avoids infrastructure
  dependencies and keeps the framework portable. While a database
  would enable richer queries (e.g., cost trend analysis, cross-project
  metrics), the trade-off in operational complexity is not justified
  at current scale. The `/ace:doctor` and `/metrics` commands can
  extract sufficient insights from file-based artifacts.
- **Multi-provider agent adapters**: While Paperclip's adapter
  abstraction is elegant, i-SASE's MentorScripts and LoopScripts
  are conceptually provider-agnostic. The execution layer (dispatch,
  claim, heartbeat) is Claude Code-specific today. Abstracting this
  requires a clear second provider to design against — speculative
  abstraction is explicitly against project principles. Revisit when
  a concrete non-Claude executor is needed.

---

*Last updated: 2026-03-30. Priority 1-4 based on 4 rounds of expert
evaluation. Priority 5 informed by analysis of the
[Paperclip](https://github.com/paperclipai/paperclip) orchestration
control plane. Priority 6 informed by OpenAI's
[Harness Engineering](https://openai.com/index/harness-engineering/)
post (February 2026) documenting production experience with fully
agent-generated codebases.*
