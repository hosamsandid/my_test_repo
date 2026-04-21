# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**e-vgh-claw** is a local Matrix-to-Claude-Code bridge stack for an enterprise context. It provides a chat-based AI agent that will be extended with domain-specific skills for **Mainframe Migration** (COBOL, JCL, DB2, IMS, etc.).

The stack runs locally with Podman and consists of:
- **Conduwuit** — a lightweight Matrix homeserver (server name `local`, port 8448)
- **Claude Bridge** — a Node.js service (`claude-code/bridge.js`) that listens for Matrix messages and dispatches them to the Claude Code CLI

The LLM backend is **Azure AI Foundry** (resource `claude-code-ai-eastus2`, model `claude-sonnet-4-6`). Credentials are in `.env` (gitignored).

## Architecture

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
- Volumes have stable names (`vgh-claw_conduwuit-db`, `vgh-claw_claude-auth`, `vgh-claw_claude-workspace`)
- The bridge spawns one Claude CLI process per message, with a 10-minute timeout
- Concurrent messages per room are serialized (one at a time)
- A scheduler runs cron and one-shot jobs from `jobs.json`, checked every 60 seconds

## Key Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Both services, volumes, Azure Foundry env vars |
| `.env` | Secrets: Matrix token, Foundry API key (gitignored) |
| `claude-code/bridge.js` | Core bridge: Matrix listener, Claude CLI spawner, scheduler |
| `claude-code/CLAUDE.md` | System prompt for the Claude instance *inside* the container (skills, memory, formatting) |
| `claude-code/Dockerfile` | Node 22 + Claude Code CLI, entrypoint seeds workspace |
| `claude-code/jobs.json` | Scheduled tasks template (empty by default) |
| `claude-code/cleanup.sh` | Memory housekeeping script |

Note: `claude-code/CLAUDE.md` is the **inner** system prompt (what the containerized Claude sees). This root `CLAUDE.md` is for **you** when working on the repo itself.

## Commands

```bash
# Start / restart the full stack
cd ~/Projects/e-vgh-claw
podman compose up -d --build

# Stop everything
podman compose down

# Rebuild only the bridge after code changes
podman compose build claude-bridge && podman compose up -d claude-bridge

# Logs
podman compose logs -f claude-bridge
podman compose logs -f conduwuit

# Manual memory cleanup
./claude-code/cleanup.sh
```

## Skills

Skills are added to the workspace volume (`vgh-claw_claude-workspace`) under `skills/<name>/SKILL.md`. After adding a skill, update the skills table in the **inner** `claude-code/CLAUDE.md` so the containerized Claude knows about it.

The intended domain is **Mainframe Migration** — skills will cover COBOL analysis, JCL conversion, DB2 schema mapping, IMS/VSAM migration patterns, and related topics.
