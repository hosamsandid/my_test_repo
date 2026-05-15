# Accenture Agentic Studio

> An enterprise AI agent platform — persistent, autonomous, team-capable — running entirely within your own infrastructure.

For a visual walkthrough of all concepts, open **[`docs/architecture-story.html`](./docs/architecture-story.html)** in your browser.

---

## The problem it solves

Every enterprise AI pilot eventually hits the same wall: the assistant works in isolation. It forgets yesterday's conversation, doesn't know your codebase, can't act while you sleep, and lives on someone else's servers.

Accenture Agentic Studio removes that wall. It is a platform for running AI agents that **persist across sessions**, **operate autonomously on schedules and events**, and **collaborate as a team** — all within your own infrastructure, connected to whichever model provider your organization controls.

---

## Three capabilities that set it apart

### Agents that remember and learn

Every agent carries a living memory that it reads and writes during each conversation. It remembers the decisions made last quarter, the domain knowledge it has accumulated, and the context it needs to pick up exactly where it left off — without you having to repeat yourself. Domain knowledge is packaged as **skills** — portable files that can be added to any agent without touching code. You can train a new specialist in minutes.

### Autonomous operation, triggered by anything

Agents don't wait to be summoned. A built-in scheduling system lets an agent send a daily status report every morning, react the moment a pull request opens, respond to a monitoring webhook, or execute a one-time task at a precise moment. You define what triggers them and what they do — the platform handles execution, retries, and loop protection, even while no one is watching.

### Teams of specialists running in parallel, on your servers

Complex enterprise problems rarely have a single expert. Agentic Studio lets you spawn a coordinated team — a code analyst, a documentation writer, a quality gate, a business analyst — that work in parallel in isolated workspaces, coordinate through shared triggers, and report to a central dashboard. The entire stack runs on Podman inside your network. The model provider is fully configurable: point it at an enterprise gateway, LiteLLM, Azure AI Foundry, or the public Anthropic API.

---

## How it works

Agentic Studio has four moving parts:

**The Matrix homeserver** is the communication backbone. Agents and humans meet in private 1:1 chat rooms hosted entirely on your network — no external messaging service required.

**The orchestrator** is the engine. It manages agent lifecycles, watches for scheduled and event-driven triggers, relays GitHub activity, and serves the Admin Console. When a trigger fires, it wakes the right agent, provides context, and records the result.

**Agents** are autonomous workers. Each has an isolated workspace, persistent memory, and a skill set matched to its role. An agent can read code, write commits, open pull requests, call external APIs — whatever the role demands.

**The Admin Console** is the control plane. A browser-based interface for creating agents, managing credentials, watching live sessions, editing triggers, and browsing workspaces — no config file editing needed.

---

## Quick Start

**Prerequisites:** Podman with `podman compose`, plus an LLM endpoint that speaks the Anthropic Messages API (the Anthropic API directly, a LiteLLM proxy, Azure AI Foundry, or any internal gateway).

```bash
# 1. Copy the environment config and fill in your provider URL + auth token
cp .env.example .env

# 2. Boot the Matrix homeserver and register the admin account
#    The script prints an access token — paste it into .env
podman compose up -d conduwuit
./orchestrator/setup.sh

# 3. Start the full stack
make up
```

4. Open **http://localhost:4000** in your browser.
5. The Setup Wizard walks you through five steps: Model Provider → SSH key → GitHub token → Working Environment → first agent.
6. Once created, the agent appears in Agent Chat. Send it a message and watch the session log on the right.

You now have a live, persistent AI agent running inside your own infrastructure.

---

## Architecture

| Resource | Description |
|---|---|
| [admin-console/public/aee-workflow-diagram.html](./admin-console/public/aee-workflow-diagram.html) | Presentation-ready HTML process diagram of the full AEE agent workflow — also embedded in the Team-Setup wizard via a modal |
| [docs/architecture-story.html](./docs/architecture-story.html) | Visual walkthrough of platform concepts |

## Technical Documentation

| Topic | Document |
|---|---|
| Trigger types (cron, one-shot, webhook, GitHub event) | [docs/triggers.md](./docs/triggers.md) |
| Agent roles and team patterns | [docs/agent-roles.md](./docs/agent-roles.md) |
| Working Environments | [docs/working-environments.md](./docs/working-environments.md) |
| Admin Console reference | [docs/admin-console.md](./docs/admin-console.md) |
| SSH keys and GitHub tokens | [docs/credentials.md](./docs/credentials.md) |
| Model Providers | [docs/model-providers.md](./docs/model-providers.md) |
| Skills system | [docs/skills-system.md](./docs/skills-system.md) |
| Persistent memory | [docs/persistent-memory.md](./docs/persistent-memory.md) |
| Key files and project layout | [docs/key-files.md](./docs/key-files.md) |
| MCP server configuration | [docs/mcp-servers.md](./docs/mcp-servers.md) |
