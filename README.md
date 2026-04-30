# The Autonomous Enterprise Agent

> An AI agent built for complex enterprise problems — with persistent memory, learnable skills, and full access to your codebase. Runs entirely within your infrastructure.

For a visual walkthrough of all concepts, open **[`docs/architecture-story.html`](./docs/architecture-story.html)** in your browser.

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
| **Learnable Skills** | Drop a `SKILL.md` into the central skill pool and any agent that has a Working Environment selecting it gains a new domain capability — COBOL analysis, JCL conversion, DB2 schema mapping, anything. |
| **Git Access** | A Working Environment can clone an enterprise repository into the agent's workspace using a registered SSH key. The agent can read, analyse, commit, and open pull requests. |
| **Autonomous Operation** | Autonomous agents have a self-managed `triggers.json` (cron + one-shot) for proactive tasks — daily standup summaries, code quality checks, sprint reports. |
| **Multi-Agent Pool** | An orchestrator routes questions to specialist agents in parallel. A synthesiser merges their answers. Agents are managed via the Admin Console. |
| **Compliance** | Runs on Azure AI Foundry inside your own tenant. Sonnet and Opus are both available. No third-party data handling. |

---

## Architecture

```
Matrix Client (Cinny @ :8090, Element, etc.)
  → Conduwuit (Matrix homeserver, localhost:8448)
    → orchestrator (@orchestrator:local)
        ├── Routes to dynamic agent processes (each agent-runner.js)
        ├── Each agent: own workspace, own CLAUDE.md, own skills + repo (via Working Environment)
        └── Synthesises expert answers when broadcast routing is used

Admin Console (localhost:4000)
  └── CRUD for agents, working environments, SSH keys, skills, MCP
```

See [`CLAUDE.md`](./CLAUDE.md) for the full technical reference including all environment variables, Podman commands, and admin operations.

---

## Getting Started

**Prerequisites:** Podman with `podman compose`, Azure AI Foundry access (or Anthropic API key for Claude Code CLI auth).

```bash
# 1. Copy and fill environment config
cp .env.example .env

# 2. Start the full stack (single compose file)
make up
# or
podman compose up -d --build

# 3. Tail logs
podman logs -f orchestrator
podman logs -f admin-console
```

First-time Matrix user setup (homeserver admin room):
```
!admin users create-user <yourname> <password>
```

Open the Admin Console at <http://localhost:4000> to create agents, environments and SSH keys. Open Cinny at <http://localhost:8090> to chat with them.

---

## Extending the Agent

**Add a skill:**
Drop a `SKILL.md` into the skill-pool volume (`vgh-claw_claude-workspace:/skills/<name>/SKILL.md`). It immediately appears in the Admin Console's Working Environment skill picker.

**Add an agent:**
Use the Admin Console at <http://localhost:4000> — choose a Working Environment, write a system prompt, save.

**Schedule autonomous work:**
For autonomous agents, edit `triggers.json` in the agent's workspace (or ask the agent to do it). Triggers sync within 60 seconds.
