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

The stack runs on Podman, communicates over the Matrix protocol, and reaches its LLM via an Anthropic-compatible proxy (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`). Point it at any compatible gateway — LiteLLM, an enterprise-internal endpoint, or the public Anthropic API.

---

## Core Capabilities

| Capability | What it means |
|---|---|
| **Persistent Memory** | `memory/context.md` stores facts indefinitely. `memory/log.md` summarises every conversation. The agent reads both at session start. |
| **Learnable Skills** | Drop a `SKILL.md` into the central skill pool and any agent that has a Working Environment selecting it gains a new domain capability — COBOL analysis, JCL conversion, DB2 schema mapping, anything. |
| **Git Access** | A Working Environment can clone an enterprise repository into the agent's workspace using a registered SSH key. The agent can read, analyse, commit, and open pull requests. |
| **Autonomous Operation** | Autonomous agents have a self-managed `triggers.json` (cron + one-shot) for proactive tasks — daily standup summaries, code quality checks, sprint reports. |
| **Multi-Agent Pool** | An orchestrator routes questions to specialist agents in parallel. A synthesiser merges their answers. Agents are managed via the Admin Console. |
| **Compliance** | LLM endpoint is configurable — point it at a tenant-internal proxy (LiteLLM, Azure AI Foundry gateway, etc.) so no data leaves your environment. |

---

## Architecture

```
Matrix Client (Cinny, Element, etc.)
  → Conduwuit (Matrix homeserver)
    → orchestrator (@orchestrator:local)
        ├── Routes to dynamic agent processes (each agent-runner.js)
        ├── Each agent: own workspace, own CLAUDE.md, own skills + repo (via Working Environment)
        └── Synthesises expert answers when broadcast routing is used

Admin Console
  └── CRUD for agents, working environments, SSH keys, skills, MCP
```

See [`CLAUDE.md`](./CLAUDE.md) for the full technical reference including all environment variables, Podman commands, and admin operations.

---

## Getting Started

**Prerequisites:** Podman with `podman compose`, an Anthropic-compatible LLM endpoint (LiteLLM proxy, enterprise gateway, or Anthropic API directly).

```bash
# 1. Copy environment config and fill in the LLM endpoint + auth token
cp .env.example .env

# 2. First-time only: boot Conduwuit, register the admin + orchestrator users,
#    create the shared room. The script prints the values to add to .env.
podman compose up -d conduwuit
./orchestrator/setup.sh

# 3. Start the full stack
make up

# 4. Tail logs
make logs
```

Default ports (configurable via `CONDUWUIT_PORT`, `CINNY_PORT`, `ADMIN_PORT` in `.env`):

| Service | Default |
|---|---|
| Admin Console | <http://localhost:4000> |
| Cinny | <http://localhost:8090> |
| Conduwuit | `localhost:8448` |

---

## Extending the Agent

**Add a skill:**
Drop a `SKILL.md` into the skill-pool volume (`skills-pool:/skills/<name>/SKILL.md`). It immediately appears in the Admin Console's Working Environment skill picker.

**Add an agent:**
Use the Admin Console — choose a Working Environment, write a system prompt, save.

**Schedule autonomous work:**
For autonomous agents, edit `triggers.json` in the agent's workspace (or ask the agent to do it). Triggers sync within 60 seconds.

### Agent Chat

The Admin Console embeds a Matrix client for direct 1:1 conversations with each agent. Click **Agent Chat** in the left navigation to open it.

The page has three panels:

- **Agent list** (left): pick an enabled agent.
- **Chat** (middle): markdown and code-block rendering, sticky scroll, scroll-up backfill of older messages.
- **Session log** (right, toggle with `Cmd/Ctrl+Shift+L`): structured timeline of the agent's internal activity (Claude tool calls, intermediate text, errors, timings).

Messages flow through the same Matrix room you would see in Cinny — the chat UI is just a viewer. The last-opened agent is remembered, so reopening the page lands you back in the same conversation.
