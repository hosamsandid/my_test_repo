# ACE -- Operations & Configuration Guide

Setup, directory structure, team configuration, Git integration, and troubleshooting. For the concept overview, see the [main README](../README.md). For the academic deep dive, see the [SASE Framework Guide](SASE-FRAMEWORK-GUIDE.md).

---

## Table of Contents

1. [Directory Structure](#directory-structure)
2. [Team Setup Guide](#team-setup-guide)
3. [Artifact Reference](#artifact-reference)
4. [Git Integration](#git-integration)
5. [Agent Dashboard](#agent-dashboard)
6. [Troubleshooting](#troubleshooting)

---

## Directory Structure

After `/ace:init`, your project contains:

```
your-project/
  CLAUDE.md                             # Project MentorScript (root config for agents)
  mentorscripts/
    global.md                           # Project-wide rules (R-001..R-031)
    team.md                             # Team roles, review policies, CRP routing
  artifacts/
    briefings/                          # Agent definitions ({hash}-{slug}/brief.md)
      .archive/                         # Archived completed BP trees
      .index.json                       # Fast-path index for status queries
      INDEX.md                          # Human-readable index
    guidance/
      crp/                              # Agent questions (Consultation Request Protocols)
      mrp/                              # Agent evidence packages (Merge-Readiness Packs)
      vcr/                              # Human decision records (Version Control Records)
    log/                                # Audit logs (tier1.log, etc.)
  scripts/
    build-index.py                      # Rebuild BP index
    bp-transition.py                    # BP status transitions
    bp-explorer/                        # Visual dashboard (server + UI + Docker)
      server.py                         # FastAPI server
      index.html                        # Web UI
      Dockerfile                        # Container image
      docker-compose.yml                # Ready-to-use compose file
      start.sh                          # One-command Docker start
```

The plugin itself (installed separately) adds:

```
.claude-plugin/plugin.json              # Plugin manifest
agents/                                 # AI agent definitions (executor, briefing-engineer, quality-gate, reviewer)
commands/                               # ACE commands (init, do, brief, status, dispatch, ...)
skills/                                 # Engineering skill (single bundled discipline pack)
  engineering/                          #   SKILL.md, schemas/, templates/, loops/
hooks/hooks.json                        # Plugin hooks (BP protection, audit logging)
```

---

## Team Setup Guide

### Step 1: Initialize

```
/ace:init
```

### Step 2: Configure Team Members

Edit `mentorscripts/team.md`. Identity is matched via `git config user.name`:

```yaml
team:
  - name: "Alice"
    roles: [author, approver]
    domains: [backend, api]
  - name: "Bob"
    roles: [author, reviewer]
    domains: [frontend, testing]
  - name: "Carol"
    roles: [reviewer, dispatcher]
    domains: [security, infrastructure]
```

### Step 3: Set Review Policies and CRP Routing

```yaml
review-policies:
  standard: { policy: "any-1" }      # One reviewer can approve
  high: { policy: "any-2" }          # Two independent reviewers required
  critical: { policy: "all" }        # All designated reviewers must approve

crp-routing:
  security: "Carol"                   # Security CRPs go to Carol
  api: "Alice"                        # API design CRPs go to Alice
  default: "Alice"                    # Everything else to Alice
```

### Step 4: Add Project-Specific Rules

Edit `mentorscripts/global.md`:

```markdown
### R-100: API Versioning (mandatory)
All public API changes must maintain backward compatibility for at least two major versions.
```

---

## Artifact Reference

| Artifact | Format | Location | Created By |
|----------|--------|----------|------------|
| **Agent Definition (BP)** | YAML frontmatter + Markdown | `artifacts/briefings/{hash}-{slug}/brief.md` | Human via `/ace:brief` |
| **CRP** | YAML frontmatter + Markdown | `artifacts/guidance/crp/` | Agent during execution |
| **MRP** | YAML frontmatter + Markdown | `artifacts/guidance/mrp/` | Agent on completion |
| **VCR** | YAML frontmatter + Markdown | `artifacts/guidance/vcr/` | Human via `/ace:resolve-crp` |
| **LoopScript** | Pure YAML | `skills/engineering/loops/` | Framework (auto-selected) |
| **MentorScript** | YAML frontmatter + Markdown | `mentorscripts/` | Human |

### Agent Definition Directory Structure

```
artifacts/briefings/
  a3f7c2e1b9d4-cobol-extraction/
    brief.md                                          # Parent BP
    7b2d4e9f1a8c-inventory-analysis/brief.md          # Child: Step 1
    c8a1f3d5e7b9-lnw-extraction/brief.md              # Child: Step 2
```

Agents inherit context by walking up the directory tree, reading each ancestor's `brief.md` from root to leaf.

---

## Git Integration

### Worktree-per-Agent

Each agent works in its own **git worktree** at `.worktrees/{agent-id}-{bp-hash}/`, on branch `agent/{agent-id}/{bp-hash}`. Multiple agents can run in parallel -- the main workspace stays on `main`.

### Claim Protocol

1. Agent pulls latest on main
2. Verifies BP status is `dispatched`
3. Generates an 8-character agent ID
4. Creates worktree + branch: `git worktree add .worktrees/{agent-id}-{bp-hash} -b agent/{agent-id}/{bp-hash}`
5. Sets status to `claimed`, writes agent-id and timestamp, commits and pushes
6. Verifies no competing claims -- earliest timestamp wins, loser aborts

### Heartbeat

Every 60 minutes and at phase transitions, the agent commits a heartbeat. If an agent's last heartbeat exceeds 3 hours with no open blocking CRPs, `/ace:status` flags it as stale.

### Commit Convention

```
action(bp:XXXXXX): description [agent:XXXXXXXX]
```

Actions: `draft`, `refine`, `approve`, `dispatch`, `claim`, `heartbeat`, `complete`, `merge`, `release`, `archive`, `restore`

Find all work for a BP: `git log --all --grep='bp:a3f7c2'`

### Status Lifecycle

```
draft -> ready -> dispatched -> claimed -> in-progress -> completed -> reviewed
                                   \-> abandoned (stale lock released)
```

Reviewed BP trees are archived via `/ace:archive` (physical move to `.archive/`).

---

## Agent Dashboard

The Agent Dashboard is a FastAPI-based visual dashboard for browsing Agents, tracking agent status, and managing escalations/reviews.

### Start with Docker

```bash
bash scripts/bp-explorer/start.sh
# Open http://localhost:8765
```

Or explicitly:

```bash
docker compose -f scripts/bp-explorer/docker-compose.yml up
```

### Start without Docker

```bash
pip install -r scripts/bp-explorer/requirements.txt
python3 scripts/bp-explorer/server.py
# Open http://localhost:8765
```

### Agent SDK Integration

The Agent Dashboard optionally integrates with the Claude Agent SDK for in-browser agent invocation. Install `claude-agent-sdk` and set `ANTHROPIC_API_KEY` to enable agent features. Without it, the dashboard works for browsing and status tracking.

---

## Troubleshooting

### "The agent keeps upgrading my Tier 1 task"

The scope assessment detected signals (security implications, API changes, many files). Use `--force` to override:

```
/ace:do --force Fix the security comment in README
```

### "The agent filed too many CRPs"

The Agent definition is underspecified. Add constraints, clarify the approach, or specify escalation triggers. Re-run `/ace:brief {hash}` to edit.

### "An agent appears stale"

Check `/ace:status`. If the agent's last heartbeat is >3 hours old with no blocking CRPs, release the lock via the status prompts. The BP returns to `ready`. The stale agent's branch is preserved.

### "Two agents claimed the same BP"

The push-based claim protocol handles this automatically. First to push wins. The loser detects the conflict and aborts.

### "Where are completed Agents?"

Archived to `artifacts/briefings/.archive/`. Use `/ace:archive --list` to browse or `/ace:status audit {hash}` to search both active and archived BPs.

### "How do I trace a decision?"

1. Find the commit: `git log --grep='bp:a3f7c2'`
2. Read the MRP in `artifacts/guidance/mrp/`
3. Check CRPs in `artifacts/guidance/crp/`
4. Read VCRs in `artifacts/guidance/vcr/`
5. Read the original BP in `artifacts/briefings/`

### "The BP index is out of date"

```bash
python3 scripts/build-index.py
```

---

*For the concept overview, see the [README](../README.md). For the academic framework, see the [SASE Framework Guide](SASE-FRAMEWORK-GUIDE.md).*
