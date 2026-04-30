# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**e-vgh-claw** is a local Matrix-to-Claude-Code stack for an enterprise context. It provides chat-based AI agents that can be extended with domain-specific skills for **Mainframe Migration** (COBOL, JCL, DB2, IMS, etc.).

The stack runs locally with Podman as a single compose file with four services:

1. **Conduwuit** — Matrix homeserver
2. **Cinny** — Matrix web client on `:8090`
3. **Orchestrator** — dynamic agent pool with domain experts (`@orchestrator:local`)
4. **Admin Console** — web UI on `:4000` for managing agents, working environments, SSH keys, skills, etc.

The LLM backend is **Azure AI Foundry** (resource `claude-code-ai-eastus2`, model `claude-sonnet-4-6`). Credentials are in `.env` (gitignored).

## Architecture

```
Matrix Client (Cinny / Element / etc.)
  → Conduwuit (localhost:8448)
    → orchestrator.js (@orchestrator:local)
        ├── Manages dynamic agents (create/update/delete via Admin Console)
        ├── Routes human messages to expert agents in parallel
        ├── Each expert: agent-runner.js child process with agent-specific CLAUDE.md
        ├── @-mention filtering: mentioned agents only, or broadcast to all
        ├── [PASS] filtering: agents stay silent when topic is outside expertise
        ├── Watcher: collects expert responses
        └── Synthesis: calls Claude, posts result as synthesizer agent
```

- **Pool identity:** `@orchestrator:local` (invisible watcher/router)
- **Agents:** dynamically created Matrix users (e.g. `@cobol-expert:local`)
- **Room:** `!53HsXQ24Pfdnj9WVXF:local` ("Multi-Agent Collaboration")
- Agent configs persisted in `/workspace/agents/<id>/` (config.json + CLAUDE.md + AGENT-PROMPT.md)
- Each agent is bound to a **Working Environment** (see below) which defines what gets seeded into its workspace.
- Matrix users auto-created via Conduwuit admin room
- Only 1 container (`orchestrator`) manages all agents — no container-per-agent

### Working Environments

A **Working Environment** is a reusable workspace recipe. It lives at `/workspace/environments/<envId>/environment.json` (in the orchestrator/admin volume) and contains:

| Field | Purpose |
|---|---|
| `id`, `name`, `description` | Identity |
| `skills` | Names of skills (from the central pool at `/template-workspace/skills/`) to copy into the agent workspace |
| `repository` | Optional `{ url, branch, sshKeyId }` — orchestrator clones it into the agent's workspace at creation time |
| `additionalContext` | Optional text appended to the agent's CLAUDE.md |

When an agent is created via the Admin Console, the orchestrator:
1. Always seeds `.claude/` and `memory/` from the skill-pool volume (or bundled defaults if empty)
2. Copies only the skills the env lists (from `/template-workspace/skills/`)
3. If the env has a repository, runs `git clone` with `GIT_SSH_COMMAND` pointing at the env's SSH key (`/workspace/environments/_keys/<sshKeyId>`)
4. Builds a merged CLAUDE.md: base template + env section + agent prompt

SSH keys are stored at `/workspace/environments/_keys/<keyId>` (mode 0600) with metadata in `_keys/index.json`. The private key value is **never** returned by the API after creation; only its fingerprint.

### Agent Roles

| Role | Behavior |
|---|---|
| `expert` | Responds reactively to human messages. Returns `[PASS]` if topic is outside expertise. When @-mentioned directly, always responds. |
| `synthesizer` | Called after experts finish. Merges results into one answer. Returns `[PASS]` if synthesis adds no value. |
| `autonomous` | Runs proactively on a cron schedule. Posts results to the room. Responds to @-mentions and direct messages. Does NOT participate in expert broadcast routing. |

### Autonomous Agent Triggers

Autonomous agents are driven by **triggers** stored in a per-agent `triggers.json` file (`/workspace/agents/<id>/triggers.json`). The trigger scheduler syncs every 60 seconds (using `node-cron`).

**Key design properties:**
- **Self-managed** — the agent can read/write its own `triggers.json` to adjust its schedule
- **File-based sync** — agent processes pick up changes via filesystem polling
- **Open for extension** — currently supports `cron` and `once`, future types (matrix-event, http-webhook, etc.) can be added
- **Overlap protection** — if a trigger's previous execution is still running, the next tick is skipped

**Trigger types:**
| Type | Fields | Behavior |
|---|---|---|
| `cron` | `cron` (5-field expression) | Recurring execution via node-cron |
| `once` | `at` (ISO timestamp) | One-shot, auto-removed after execution |

Results are posted to the multi-agent room (or custom `roomId`); `[PASS]` suppresses output.

### @-Mention Logic

| Message | Who responds |
|---|---|
| `Vergleiche COBOL und Java` | All experts (no name mentioned) |
| `Java Experte: was ist ein Record?` | Only Java Experte (direct mention) |
| `quality-gate: pruefe den letzten Commit` | Only the autonomous agent (direct mention, outside expert pipeline) |
| Direct mention + off-topic | Agent responds anyway (override [PASS]) |

### Agent Management

All agent lifecycle operations (create / enable / disable / edit prompt / delete) happen via the **Admin Console** at `http://localhost:4000`.

## Key Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | All four services + volumes |
| `.env` | Secrets: Matrix tokens, Foundry API key (gitignored) |
| `Makefile` | Build + start convenience targets (`make up`, `make down`, `make logs`, ...) |
| `orchestrator/orchestrator.js` | Dynamic agent management, routing, synthesis, environment-aware workspace seeding, internal API for the admin console |
| `orchestrator/agent-runner.js` | Per-agent child process: Matrix client + Claude CLI invocations + trigger scheduler |
| `orchestrator/Dockerfile` | Node 22 + Claude Code CLI + git + openssh-client |
| `orchestrator/CLAUDE-template.md` | Base template baked into the image as `/defaults/CLAUDE.md`, used as fallback when the skill-pool volume has no CLAUDE.md |
| `orchestrator/setup.sh` | Initial setup: register Matrix users, create room |
| `admin-console/api/api.js` | Express API: agents, environments, ssh-keys, skills, models, mcp |
| `admin-console/src/pages/WorkingEnvironments.jsx` | UI: CRUD for environments (skills picker, optional repo + ssh key) |
| `admin-console/src/pages/SshKeys.jsx` | UI: CRUD for SSH keys (paste private key, see fingerprint only) |
| `admin-console/src/pages/AgentManager.jsx` | UI: CRUD for agents (with required environment dropdown) |

## Commands

```bash
# First-time bootstrap (after `podman compose up -d conduwuit`):
# registers the admin user + @orchestrator:local, creates the shared room,
# prints the tokens to add to .env.
./orchestrator/setup.sh

# Start / stop / restart the full stack
make up
make down
make restart

# Rebuild orchestrator image only
make build
# (equivalent to `podman compose build orchestrator`)

# Container status + log streaming for orchestrator + admin-console + conduwuit
make ps
make logs

# Per-service logs
podman logs -f orchestrator
podman logs -f admin-console
podman logs -f conduwuit
```

## Conduwuit Admin

Matrix users are managed via the Conduwuit admin room (`!cUxr0SyfINf9yEvBOD:local`). The orchestrator automates user creation when adding agents through the Admin Console.

```
!admin users list                           — list all users
!admin users create-user <name> <password>  — create user
!admin users deactivate @user:local         — deactivate user
```

## Skills

Skills are added to the skill-pool volume (`vgh-claw_claude-workspace`) under `skills/<name>/SKILL.md`. They appear in the Admin Console's Working Environment skill picker.

The intended domain is **Mainframe Migration** — skills will cover COBOL analysis, JCL conversion, DB2 schema mapping, IMS/VSAM migration patterns, and related topics.
