# The Autonomous Enterprise Agent

> An AI agent built for complex enterprise problems — with persistent memory, learnable skills, and full access to your codebase. Runs entirely within your infrastructure.

For a visual walkthrough of all concepts, open **[`architecture-story.html`](./architecture-story.html)** in your browser.

---

## What this is

Most AI assistants are stateless. They forget what you told them yesterday. They don't know your codebase. They live in someone else's cloud.

This project is different. It is a locally operated AI agent that:

- **Remembers** — across every conversation, indefinitely
- **Learns** — new domain skills can be added without changing code
- **Works autonomously** — scheduled tasks, proactive reporting, no prompting required
- **Reads and writes your code** — full Git access, SSH-authenticated, commit and PR capable
- **Scales to a team** — spawn any number of specialist agents that collaborate in parallel

The stack runs on Podman, communicates over the Matrix protocol, and uses Azure AI Foundry (Sonnet or Opus) as its LLM backend — entirely within your enterprise's Azure tenant. No data leaves your environment.

---

## Core Capabilities

| Capability | What it means |
|---|---|
| **Persistent Memory** | `memory/context.md` stores facts indefinitely. `memory/log.md` summarises every conversation. The agent reads both at session start. |
| **Learnable Skills** | Drop a `SKILL.md` into `/workspace/skills/<name>/` and the agent gains a new domain capability — COBOL analysis, JCL conversion, DB2 schema mapping, anything. |
| **Git Access** | The workspace contains a live clone of your enterprise repository. The agent can read, analyse, commit, and open pull requests. |
| **Autonomous Operation** | A cron-based scheduler (`jobs.json`) lets the agent run tasks without being asked — daily standup summaries, code quality checks, sprint reports. |
| **Multi-Agent Pool** | An orchestrator routes questions to specialist agents in parallel. A synthesiser merges their answers. Agents are created and managed via chat commands (`!agent add`). |
| **Compliance** | Runs on Azure AI Foundry inside your own tenant. Sonnet and Opus are both available. No third-party data handling. |

---

## Architecture

```
Matrix Client (Element)
  → Conduwuit (Matrix homeserver, localhost:8448)
    → bridge.js (Node.js, matrix-bot-sdk)
      → Claude Code CLI (spawned per message, acceptEdits mode)
        → /workspace (persistent volume)
             ├── CLAUDE.md          agent identity & system prompt
             ├── skills/            domain-specific capabilities
             ├── memory/            persistent context & conversation log
             ├── git-repo/          full enterprise source code clone
             └── jobs.json          scheduled autonomous tasks
```

For the multi-agent overlay, `agent-pool.js` manages a dynamic pool of specialist agents — each with its own workspace, seeded from the base template above.

See [`CLAUDE.md`](./CLAUDE.md) for the full technical reference including all environment variables, Docker Compose commands, and admin commands.

---

## Getting Started

**Prerequisites:** Podman with `podman compose`, Azure AI Foundry access (or Anthropic API key for Claude Code CLI auth).

```bash
# 1. Copy and fill environment config
cp .env.example .env

# 2. Start the full stack
podman compose -f docker-compose.yml -f docker-compose.multi-agent.yml up -d --build

# 3. Tail logs
podman logs -f claude-bridge
podman logs -f agent-pool
```

First-time Matrix user setup (homeserver admin room):
```
!admin users create-user claude <password>
!admin users create-user <yourname> <password>
```

Full setup details, volume descriptions, and all `!agent` commands are documented in [`CLAUDE.md`](./CLAUDE.md).

---

## Extending the Agent

**Add a skill:**
1. Create `/workspace/skills/<name>/SKILL.md` on the workspace volume
2. Add a row to the skills table in `claude-code/CLAUDE.md`
3. The agent reads it on the next conversation — no restart needed

**Add an agent:**
In the Multi-Agent room, type `!agent add` and follow the guided wizard.

**Add a scheduled task:**
Ask the agent directly: *"Create a daily task at 08:30 that reviews overnight CI results."*
It will write the job into `jobs.json` itself.
