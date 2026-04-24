# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**e-vgh-claw** is a local Matrix-to-Claude-Code bridge stack for an enterprise context. It provides chat-based AI agents that can be extended with domain-specific skills for **Mainframe Migration** (COBOL, JCL, DB2, IMS, etc.).

The stack runs locally with Podman and consists of two layers:
1. **Base stack** — Conduwuit homeserver + single Claude bot (`@claude:local`)
2. **Multi-agent overlay** — dynamic agent pool with domain experts, managed via chat commands

The LLM backend is **Azure AI Foundry** (resource `claude-code-ai-eastus2`, model `claude-sonnet-4-6`). Credentials are in `.env` (gitignored).

## Architecture

### Base Stack (Single Bot)

```
Matrix Client (Element etc.)
  → Conduwuit (localhost:8448)
    → bridge.js (matrix-bot-sdk)
      → claude CLI (spawned per message, --permission-mode acceptEdits)
        → /workspace (persistent volume with CLAUDE.md, skills/, memory/, jobs.json)
```

- **Bot identity:** `@claude:local`
- **Human user:** `@thorsten:local`
- **Room:** `!frJcikjCDVbOQFVnyH:local` ("Enterprise Agent")
- The bridge spawns one Claude CLI process per message, with a 10-minute timeout
- Concurrent messages per room are serialized (one at a time)
- A scheduler runs cron and one-shot jobs from `jobs.json`, checked every 60 seconds

### Multi-Agent Stack (Dynamic Agent Pool)

```
Matrix Client (Element etc.)
  → Conduwuit (localhost:8448)
    → agent-pool.js (@orchestrator:local)
        ├── Manages dynamic agents (create/update/delete via chat)
        ├── Routes human messages to expert agents in parallel
        ├── Each expert: Claude CLI call with agent-specific CLAUDE.md
        ├── @-mention filtering: mentioned agents only, or broadcast to all
        ├── [PASS] filtering: agents stay silent when topic is outside expertise
        ├── Watcher: collects expert responses
        └── Synthesis: calls Claude, posts result as synthesizer agent
```

- **Pool identity:** `@orchestrator:local` (invisible watcher/router)
- **Agents:** dynamically created Matrix users (e.g. `@cobol-expert:local`)
- **Room:** `!53HsXQ24Pfdnj9WVXF:local` ("Multi-Agent Collaboration")
- Agent configs persisted in `/workspace/agents/<id>/` (config.json + CLAUDE.md + AGENT-PROMPT.md)
- New agents are **seeded from the base bridge workspace** (`claude-workspace` volume mounted read-only at `/template-workspace`). This copies skills, memory, repo clones, and `.claude/` settings into the agent's directory. The agent's CLAUDE.md is a merge of the base instructions + agent-specific role prompt.
- Matrix users auto-created via Conduwuit admin room
- Only 1 container (`agent-pool`) manages all agents — no container-per-agent

#### Agent Roles

| Role | Behavior |
|---|---|
| `expert` | Responds reactively to human messages. Returns `[PASS]` if topic is outside expertise. When @-mentioned directly, always responds. |
| `synthesizer` | Called after experts finish. Merges results into one answer. Returns `[PASS]` if synthesis adds no value. |
| `autonomous` | Runs proactively on a cron schedule. Posts results to the room. Responds to @-mentions and direct messages. Does NOT participate in expert broadcast routing. |

#### Autonomous Agent Triggers

Autonomous agents are driven by **triggers** stored in a per-agent `triggers.json` file (`/workspace/agents/<id>/triggers.json`). The trigger scheduler syncs every 60 seconds (using `node-cron`, same library as the base bridge scheduler).

**Key design properties:**
- **Self-managed** — the agent can read/write its own `triggers.json` to adjust its schedule
- **File-based sync** — same pattern as `jobs.json` in the base bridge (`bridge.js`)
- **Open for extension** — currently supports `cron` and `once`, future types (matrix-event, http-webhook, etc.) can be added
- **Overlap protection** — if a trigger's previous execution is still running, the next tick is skipped

**Trigger types:**
| Type | Fields | Behavior |
|---|---|---|
| `cron` | `cron` (5-field expression) | Recurring execution via node-cron |
| `once` | `at` (ISO timestamp) | One-shot, auto-removed after execution |

Results are posted to the multi-agent room (or custom `roomId`); `[PASS]` suppresses output.

#### @-Mention Logic

| Message | Who responds |
|---|---|
| `Vergleiche COBOL und Java` | All experts (no name mentioned) |
| `Java Experte: was ist ein Record?` | Only Java Experte (direct mention) |
| `quality-gate: pruefe den letzten Commit` | Only the autonomous agent (direct mention, outside expert pipeline) |
| Direct mention + off-topic | Agent responds anyway (override [PASS]) |

#### Admin Commands (Chat Wizard)

All commands work in the Multi-Agent room from `@thorsten:local`:

| Command | Description |
|---|---|
| `!agent` | Show help |
| `!agent add` | Guided wizard: ID → name → role → [cron → taskPrompt (autonomous only)] → system prompt |
| `!agent update` | Change an agent's system prompt |
| `!agent delete` | Remove agent (with confirmation) |
| `!agent list` | Show all agents as table (includes schedule column) |
| `!agent enable <id>` | Reactivate a stopped agent |
| `!agent disable <id>` | Pause an agent (stops cron for autonomous) |
| `!cancel` | Cancel a running wizard |

## Key Files

### Base Stack

| File | Purpose |
|---|---|
| `docker-compose.yml` | Conduwuit + claude-bridge, volumes, Azure env vars |
| `.env` | Secrets: Matrix tokens, Foundry API key (gitignored) |
| `claude-code/bridge.js` | Core bridge: Matrix listener, Claude CLI spawner, scheduler, multi-agent env vars |
| `claude-code/CLAUDE.md` | System prompt for the Claude instance *inside* the container |
| `claude-code/Dockerfile` | Node 22 + Claude Code CLI, entrypoint seeds workspace |
| `claude-code/entrypoint.sh` | Workspace init, ACE plugin installation |
| `claude-code/jobs.json` | Scheduled tasks template (empty by default) |

### Multi-Agent Stack

| File | Purpose |
|---|---|
| `docker-compose.multi-agent.yml` | Compose overlay — single `agent-pool` service |
| `multi-agent/agent-pool.js` | Dynamic agent management, routing, synthesis, trigger scheduler, admin wizard, workspace seeding |
| `multi-agent/Dockerfile` | Node 22 + Claude Code CLI + marked |
| `multi-agent/package.json` | Dependencies: matrix-bot-sdk, marked, node-cron |
| `multi-agent/setup.sh` | Initial setup: register Matrix users, create room |
| `multi-agent/CLAUDE-COBOL.md` | Example: COBOL expert system prompt |
| `multi-agent/CLAUDE-JAVA.md` | Example: Java expert system prompt |
| `multi-agent/CLAUDE-GENERAL.md` | Example: Synthesizer system prompt |

Note: `claude-code/CLAUDE.md` is the **inner** system prompt (what the single bot sees). This root `CLAUDE.md` is for **you** when working on the repo itself.

## Commands

```bash
# --- Base stack only (single bot) ---
podman compose up -d --build
podman compose down
podman compose logs -f claude-bridge

# --- Full stack (base + multi-agent) ---
podman compose -f docker-compose.yml -f docker-compose.multi-agent.yml up -d --build
podman compose -f docker-compose.yml -f docker-compose.multi-agent.yml down

# --- Rebuild only agent-pool after code changes ---
podman compose -f docker-compose.yml -f docker-compose.multi-agent.yml build agent-pool
podman stop agent-pool && podman rm agent-pool
podman compose -f docker-compose.yml -f docker-compose.multi-agent.yml up -d agent-pool

# --- Logs ---
podman logs -f agent-pool
podman logs -f claude-bridge
podman logs -f conduwuit
```

## bridge.js Multi-Agent Env Vars (backward-compatible)

These env vars are optional. When unset, bridge.js behaves identically to the original single-bot mode.

| Env Var | Default | Purpose |
|---|---|---|
| `BOT_PEERS` | (empty) | Comma-separated user IDs of peer bots to ignore |
| `RESPOND_TO_HUMANS` | (empty) | When `1`, respond to all human messages in group rooms without requiring @-mention |

The `[PASS]` filter is also built into bridge.js: if Claude returns a response starting with `[PASS]`, nothing is sent to the room.

## Conduwuit Admin

Matrix users are managed via the Conduwuit admin room (`!cUxr0SyfINf9yEvBOD:local`). Send commands as `@claude:local`:

```
!admin users list                           — list all users
!admin users create-user <name> <password>  — create user
!admin users deactivate @user:local         — deactivate user
```

The agent-pool automates user creation when adding agents via `!agent add`.

## Skills

Skills are added to the workspace volume (`vgh-claw_claude-workspace`) under `skills/<name>/SKILL.md`. After adding a skill, update the skills table in the **inner** `claude-code/CLAUDE.md` so the containerized Claude knows about it.

The intended domain is **Mainframe Migration** — skills will cover COBOL analysis, JCL conversion, DB2 schema mapping, IMS/VSAM migration patterns, and related topics.
