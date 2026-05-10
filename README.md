# Accenture Agentic Studio

> An AI agent platform built for complex enterprise problems — with persistent memory, learnable skills, full codebase access, and a fully-featured admin console. Runs entirely within your infrastructure.

For a visual walkthrough of all concepts, open **[`docs/architecture-story.html`](./docs/architecture-story.html)** in your browser.

---

## What this is

Most AI assistants are stateless. They forget what you told them yesterday. They don't know your codebase. They live in someone else's cloud.

Accenture Agentic Studio is different. It is a locally operated AI agent platform that:

- **Remembers** — across every conversation, indefinitely
- **Learns** — new domain skills can be added without changing code
- **Works autonomously** — scheduled tasks, proactive reporting, no prompting required
- **Reads and writes your code** — full Git access, SSH-authenticated, commit and PR capable
- **Reacts to external events** — GitHub pull requests, webhooks, cron schedules
- **Scales to a team** — spawn any number of specialist agents that collaborate in parallel
- **Stays in your environment** — LLM endpoint is configurable; point at any Anthropic-compatible gateway

The stack runs on Podman, communicates over the Matrix protocol, and reaches its LLM via an Anthropic-compatible proxy (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`). Point it at LiteLLM, an enterprise-internal endpoint, or the public Anthropic API.

---

## Architecture

```
Admin Console  (http://localhost:4000)
  └── Chat UI  →  Conduwuit (Matrix homeserver, localhost:8448)
                       │
                       └── 1:1 DM rooms — one per agent
                              ├── @cobol-agent:local       ← agent-runner.js
                              ├── @java-agent:local        ← agent-runner.js
                              └── @quality-gate:local      ← agent-runner.js (autonomous)

orchestrator  (backend service, no Matrix presence)
  ├── Spawns one agent-runner.js child process per enabled agent
  ├── Each agent: own workspace, CLAUDE.md, skills + cloned repo
  ├── GitHub poller: reacts to repository events without public ingress
  ├── Webhook server: receives external HTTP triggers (port 4003)
  └── Internal HTTP API for the Admin Console (port 4002)

bp-explorer  (BriefingPack metadata viewer, read-only)
```

See [`CLAUDE.md`](./CLAUDE.md) for the full technical reference.

---

## Getting Started

**Prerequisites:** Podman with `podman compose`, an Anthropic-compatible LLM endpoint.

```bash
# 1. Copy environment config and fill in LLM endpoint + auth token
cp .env.example .env

# 2. First-time only: boot Conduwuit, register the admin user.
#    The script prints the access token — add it to .env.
podman compose up -d conduwuit
./orchestrator/setup.sh

# 3. Start the full stack
make up

# 4. Tail logs
make logs
```

Default ports (configurable via `.env`):

| Service | Default URL |
|---|---|
| Admin Console | <http://localhost:4000> |
| Conduwuit (Matrix) | `localhost:8448` |
| Webhook Server | `localhost:4003` |

The first time you open the Admin Console, the **Setup Wizard** guides you through five steps: LLM endpoint → SSH key → GitHub token → Working Environment → first agent.

---

## Admin Console

The Admin Console at `http://localhost:4000` is the central management interface. It covers the full lifecycle of agents, environments, credentials, and integrations.

### Navigation

| Page | Route | Purpose |
|---|---|---|
| **Dashboard** | `/` | Live agent status (Unread / Busy / Idle / Offline), aggregate stats, setup progress nudge |
| **Agent Chat** | `/chats` | 1:1 chat with any agent; session log; workspace browser; trigger editor |
| **Agents** | `/agents` | Create, edit, enable/disable, and delete agents |
| **Working Environments** | `/environments` | Reusable workspace recipes (skills, repos, GitHub token, LLM endpoint) |
| **SSH Keys** | `/ssh-keys` | Register SSH key pairs for private repository access |
| **GitHub Tokens** | `/github-tokens` | Register GitHub PATs for the GitHub event poller |
| **Skills Registry** | `/skills` | Browse available skills; click to view SKILL.md content |
| **Scheduled Jobs** | `/jobs` | Cross-agent view of all triggers; add/edit/delete cron, one-shot, webhook, and GitHub event triggers |
| **Model Registry** | `/models` | Register and test LLM endpoints; discover available models; set per-agent model overrides |
| **MCP Servers** | `/mcp` | View Model Context Protocol servers configured in `.claude/settings.json` |
| **Flows** | `/flows` | BriefingPack graph: visualize BP dependencies, claim/activate/deactivate orchestrator-managed BPs |

---

## Agent Types

Each agent has a **role** that defines how it behaves:

| Role | Behavior |
|---|---|
| **agent** | A standalone agent that responds to direct messages from a human in its dedicated 1:1 Matrix room. With cron / GitHub triggers it can also run autonomously. |
| **team** | A reusable system-prompt template — does not host an agent itself. Use *Add Member* on the team card to spawn one or more `team-member` agents that share the same prompt and Working Environment but each get their own workspace and chat. |
| **team-member** | A single member spawned from a team. Behaves like a standalone agent but inherits the team's prompt; the parent team is recorded in `parentTeamId`. |
| **orchestrator** | Bound to a BriefingPack directory. Polls the directory every ~30 s, writes one `bp-instance` stub per BP, and suggests dispatching them to users via chat. |
| **bp-instance** | One per BriefingPack under an orchestrator. Lives as a stub until claimed or activated; when active, executes the BP's LoopScript via the ACE engineering skill. |

> Earlier versions used `expert` / `expert-group` / `expert-instance`. The orchestrator rewrites these to `agent` / `team` / `team-member` (and renames `parentGroupId` → `parentTeamId`) on startup, so existing deployments upgrade silently.

---

## Working Environments

A **Working Environment** is a reusable workspace recipe applied when an agent is created. It defines:

| Field | Purpose |
|---|---|
| **Skills** | Names of skills (from the central pool) to copy into the agent workspace |
| **Repositories** | One or more Git repos to clone at creation, each with an optional SSH key binding |
| **GitHub Token** | PAT used by the GitHub poller for event-driven triggers on repos in this environment |
| **LLM Endpoint** | Optional override — agent inherits `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` from this endpoint |
| **Additional Context** | Markdown appended to the agent's `CLAUDE.md` after the environment section |

At agent creation the orchestrator: seeds `.claude/` and `memory/` from the pool, copies the selected skills, clones the configured repositories with the appropriate SSH key, and assembles a merged `CLAUDE.md` (base template + environment section + agent prompt).

---

## Autonomous Triggers

Autonomous agents are driven by a per-agent `triggers.json` file. The scheduler syncs every 60 seconds. All trigger types can be created and managed via the Admin Console — either on the **Scheduled Jobs** page or inline in the **Agent Chat** right rail.

| Type | How it fires |
|---|---|
| **cron** | Recurring execution on a 5-field cron expression. Skips if the previous run is still in progress. |
| **once** | Fires once at a specific ISO timestamp, then auto-removes itself. |
| **http** | Fired by an external `POST /hooks/:agentId/:triggerId` with `X-Hook-Secret` header. Every trigger carries its own auto-generated secret — no global open mode. |
| **github-event** | Fired by the built-in GitHub poller when the GitHub Events API reports a matching event (e.g. `pull_request.opened`, `push`). Requires a GitHub token in the environment. The full event payload is appended to the agent prompt as JSON. |

### Webhook Server

The orchestrator exposes a second HTTP server on `HOOK_PORT` (default `4003`). External systems (CI, GitHub Actions, monitoring) can trigger agent prompts without a public ingress — just an outbound POST from your CI to your LAN.

### GitHub Poller

`orchestrator/github-poller.js` polls the GitHub Events API every 30 s for all repos referenced in Working Environments. It uses `If-None-Match` ETags so unchanged repos cost no rate-limit budget (304 responses are free). Per-repo state (ETag, last event ID) is persisted to `/workspace/github-poller/state.json`. The first poll records a baseline — no event flood on startup.

**Loop protection:** Agents that take GitHub actions via the `gh-as-agent` wrapper stamp commits with `<agentId>@agents.local` and PR/review bodies with `<!-- agent: <id> -->`. The poller reads these markers and drops events originating from the same agent.

---

## Agent Chat

The Admin Console embeds a full Matrix chat client at `/chats/:agentId`.

### Three-panel layout

**Left: Agent list** — pick any enabled agent; status indicator shows current state.

**Middle: Chat** — Markdown rendering with syntax-highlighted code blocks (dual light/dark Shiki themes), sticky scroll, scroll-up backfill of older messages, optimistic send. The session toolbar shows whether a Claude session is active and offers **Reset** (drop the session pointer) and **Reset & Learn** (send a learn prompt then auto-drop).

**Right rail** (toggle `Cmd/Ctrl+Shift+L`) — three tabs:

| Tab | What it shows |
|---|---|
| **Session Log** | Structured timeline of the agent's internal activity: tool calls, assistant text, errors, timings. Tool-use/tool-result pairs are folded into collapsible blocks. Filter by All / Tool Calls / Errors / Posted. |
| **Workspace Browser** | Lazy-loading file tree of `/workspace/agents/<id>/`. Click any text file to view content (up to 512 KB). Supports file upload to the workspace (up to 500 files). Binary files are flagged rather than shown as garbage. |
| **Triggers** | Inline editor for the current agent's `triggers.json`. Add, edit, or delete any trigger type; shows next execution time, last run status, and the webhook secret for HTTP triggers. |

### Session pinning

After every successful Claude run, the session ID is saved to a per-room pointer file. The next message in the same room resumes with `--resume <sessionId>` so Claude keeps the conversation in context. If the session is stale (e.g. after a CLI upgrade), the runner clears the pointer and retries once without it. Session pointers survive orchestrator restarts via the `claude-home` volume.

### Hover correlation

Every session log event carries the `correlationId` of the originating Matrix message (or a synthetic `trigger:<id>:<ts>` for scheduled runs). Hovering a chat bubble dims non-matching log rows, and vice versa — making it easy to trace exactly which tool calls produced which reply.

---

## Skills System

Skills are domain knowledge packages. Each skill is a `SKILL.md` file in the central skill pool. Any agent whose Working Environment lists a skill gets it copied into its workspace at creation time — no code change required.

```
# Adding a new skill
skills-pool volume → skills/<name>/SKILL.md
```

The skill immediately appears in the Admin Console's Working Environment skill picker. Agents read their skills at the start of each Claude invocation via their `CLAUDE.md`.

**Current domain focus:** Mainframe migration — COBOL analysis, JCL conversion, DB2 schema mapping, IMS/VSAM patterns, and related topics. Skills can cover any domain.

---

## SSH Keys & GitHub Tokens

**SSH Keys** (`/ssh-keys`): Paste a private key; the console stores it at mode 0600 and returns only the SHA256 fingerprint. The private key is never returned by the API after creation. Keys can be deleted only if no Working Environment references them.

**GitHub Tokens** (`/github-tokens`): Paste a GitHub PAT; stored securely, shown only as a masked prefix + last 4 chars. Used by the GitHub poller for all repos in environments that reference the token.

---

## Model Registry

The Model Registry (`/models`) manages LLM endpoints independently of agents:

- Register multiple endpoints (e.g. LiteLLM proxy, Azure AI Foundry gateway, direct Anthropic API)
- **Test connection** before saving
- **Discover models** — the console probes the endpoint's `/models` route and populates the model list automatically
- Assign a default model per endpoint; agents can override this per-agent via the console
- Working Environments bind to an endpoint, so a whole group of agents can be re-pointed by editing one environment

---

## Persistent Memory

Every agent workspace contains:

- `memory/context.md` — facts, decisions, important information (keyed by date)
- `memory/log.md` — short summary of each conversation

Both files are seeded from the skill-pool volume at agent creation and read by Claude at the start of every invocation. Agents update these files themselves during conversations; the Workspace Browser lets you inspect them without leaving the Admin Console.

---

## Extending the Stack

**Add a skill:** Drop a `SKILL.md` into the skill-pool volume under `skills/<name>/SKILL.md`. It immediately appears in the Working Environment skill picker.

**Add an agent:** Use the Admin Console → Agents → New Agent. Choose a role, pick a Working Environment, write a system prompt, save.

**Schedule autonomous work:** Open Agent Chat → right rail → Triggers tab. Or manage globally via Scheduled Jobs.

**React to GitHub events:** Add a GitHub token, attach it to a Working Environment, add a `github-event` trigger to an autonomous agent.

**Add an external webhook trigger:** Add an `http` trigger in the console; it generates a secret automatically. POST to `http://<host>:4003/hooks/<agentId>/<triggerId>` with `X-Hook-Secret: <secret>`.

**Add an LLM endpoint:** Model Registry → New Endpoint → Test Connection → Discover Models.

---

## Key Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Four services + volumes: conduwuit, orchestrator, admin-console, bp-explorer |
| `.env` / `.env.example` | Secrets: Matrix tokens, LLM proxy URL + auth token |
| `Makefile` | `make up` / `make down` / `make logs` / `make build` / `make ps` |
| `orchestrator/orchestrator.js` | Agent lifecycle, child-process spawning, environment seeding, internal HTTP API |
| `orchestrator/agent-runner.js` | Per-agent process: Matrix client, Claude CLI invocations, trigger scheduler |
| `orchestrator/github-poller.js` | GitHub Events API poller; fan-out to agents via pending-triggers.json |
| `orchestrator/session-log.js` | Append-only JSONL event logger; maps Claude `stream-json` to normalized events |
| `orchestrator/setup.sh` | First-time setup: register admin Matrix user, print access token |
| `orchestrator/CLAUDE-template.md` | Base `CLAUDE.md` template baked into the image as a fallback |
| `admin-console/api/api.js` | Express API: ~60 endpoints covering all admin operations |
| `admin-console/src/pages/` | 16 React pages; see Admin Console section above |
