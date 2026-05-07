# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**e-vgh-claw** is a local Matrix-to-Claude-Code stack for an enterprise context. It provides chat-based AI agents that can be extended with domain-specific skills for **Mainframe Migration** (COBOL, JCL, DB2, IMS, etc.).

The stack runs locally with Podman as a single compose file with these services:

1. **Conduwuit** — Matrix homeserver
2. **Orchestrator** — backend service that manages per-agent processes; no Matrix chat identity of its own
3. **Admin Console** — web UI on `:4000` for managing agents, working environments, SSH keys, skills, etc. Includes an embedded chat UI at `/chats/:agentId` for direct 1:1 conversations with each agent.
4. **bp-explorer** — read-only viewer for ACE BriefingPack metadata

The LLM backend is reached via an Anthropic-compatible proxy configured by `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` in `.env` (gitignored). Default Sonnet/Haiku models are set there too.

## Architecture

All human↔agent communication happens through **direct messages**: each agent has its own Matrix user, and the human chats with that agent in a dedicated 1:1 room. There is no shared multi-agent room and no central routing identity.

```
Admin Console chat UI (or any Matrix client, e.g. Element)
  → Conduwuit (localhost:8448)
       │
       └── 1:1 DM rooms (one per agent)
              ├── @cobol-expert:local      ← agent-runner.js
              ├── @java-expert:local       ← agent-runner.js
              └── @quality-gate:local      ← agent-runner.js (autonomous)

orchestrator.js  (backend service, no Matrix presence)
  ├── Manages agent lifecycle (create/update/delete via Admin Console)
  ├── Spawns one agent-runner.js child process per enabled agent
  ├── Uses the admin Matrix client to provision new agent users
  └── Internal HTTP API on :4002 for the admin console
```

- **Agents:** dynamically created Matrix users (e.g. `@cobol-expert:local`); each runs its own agent-runner.js process
- DM room IDs persisted at `/workspace/agents/<id>/dm-room.json` (created lazily by the admin console)
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
| `expert` | Responds to direct messages from a human in its 1:1 DM room. |
| `autonomous` | Runs proactively on a cron schedule. Posts results to its DM room with the admin (or a custom `roomId`). Also responds to direct messages. |
| `orchestrator` | Bound to a BriefingPack directory (`briefingsPath`). On creation and on every tick of its claim loop (~30s), it pulls main (60s-throttled), scans the directory, and writes one stub `bp-instance` agent per BP. When a BP transitions to `status: dispatched`, the orchestrator posts a DM suggestion to the user; on user confirmation the orchestrator agent runs a `curl` against `/internal/agents/:id/claim` which patches the BP's `brief.md` (status, agent-id, claimed timestamp), commits + pushes to make the claim visible to teammates, and then materialises the bp-instance. Manual Activate / Deactivate via the Admin Console bypasses the suggest flow. |
| `bp-instance` | One per Briefing Pack under an orchestrator. Lives as a stub (no Matrix user, no workspace) until claimed or activated. The activated agent is bound to one specific BP and uses the ACE engineering skill to execute its LoopScript. |

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
| `http` | `secret` (auto-generated) | Fired by an external HTTP POST; see Webhook Server below |

**Webhook Server (`http` triggers)**

The orchestrator exposes a second HTTP server on `HOOK_PORT` (default `4003`). External systems (GitHub, CI) can trigger an agent prompt with:

```
POST /hooks/:agentId/:hookId
X-Hook-Secret: <trigger.secret>
```

- The path components must match an existing agent id and a trigger with `type: "http"` and a matching `id` in its `triggers.json`.
- The server enqueues the event in `/workspace/agents/:agentId/pending-triggers.json`; the agent-runner drains this queue every 5 seconds.
- **Security:** every HTTP trigger carries its own `secret` in `triggers.json` (auto-generated when created via the Admin Console). The webhook server validates `X-Hook-Secret` against that field; triggers without a secret are rejected with 401. There is intentionally no global "open" mode.
- No payload processing — the POST body is ignored. The prompt defined in the trigger is what Claude receives.

Results are posted to `trigger.roomId` if set, otherwise to the agent's DM room with the admin (read from `/workspace/agents/<id>/dm-room.json`). If neither is available — i.e. the user has not yet opened a chat with this agent — the trigger run is skipped. `[PASS]` suppresses output.

### Agent Management

All agent lifecycle operations (create / enable / disable / edit prompt / delete) happen via the **Admin Console** at `http://localhost:4000`.

### Direct Messages & Session Log

Each agent runs the Claude CLI as:

```
claude [--resume <sessionId>] -p <prompt> \
  --output-format stream-json --verbose \
  --permission-mode acceptEdits
```

NDJSON lines from stdout are parsed event-by-event and written, together with wrapper events (`message.received`, `claude.invoke`, `message.posted`, `error`, `trigger.fired`), to an append-only file at:

```
/workspace/agents/<agentId>/sessions/<roomId>.jsonl
```

**Per-room session pinning.** After every successful Claude run, the runner captures `session_id` from the stream-json `system_init` / `result` events and writes it to `/workspace/agents/<agentId>/sessions/<roomId>.current.json`. The next message in the same chat room is invoked with `--resume <sessionId>` so Claude keeps the conversation in-context. If `--resume` fails (stale session, e.g. after a CLI upgrade) the runner clears the pointer and retries once without it. The Admin Console exposes `GET` / `DELETE /api/agents/:agentId/session/:roomId/current` to read or drop the pointer; the chat header shows a "Session aktiv" badge plus *Reset* (drop pointer) and *Reset & lernen* (send a learn-prompt as a normal user message, then auto-drop after the agent's reply) buttons. Claude's per-session conversation snapshots live under `~/.claude/projects/<encoded-cwd>/`, persisted via the `claude-home` volume so `--resume` survives orchestrator restarts.

The schema is defined in `docs/agent-chat-plan.md` §4.1 and includes `assistant_text`, `tool_use`, `tool_result`, `thinking`, and `result` events. Every entry carries a `correlationId` (the originating Matrix `event_id`, or a synthetic `trigger:<id>:<ts>` for cron triggers) so the Admin Console can tie log rows to chat bubbles.

**DM heuristic.** Every message the agent receives is checked against a single rule (in `agent-runner.js`): `getJoinedRoomMembers(roomId)` returns exactly two members (this agent + one other) AND the sender is not this agent. Anything else is ignored. Membership counts are cached for 30 s.

### Agent Chat UI

The Admin Console embeds a Matrix client at `/chats` (and `/chats/:agentId`) so users can talk to any enabled agent without leaving the console.

**Where it lives**

| File | Role |
|---|---|
| `admin-console/src/pages/AgentChat.jsx` | Top-level page: owns selected agent, log-panel toggle, last-agent persistence |
| `admin-console/src/pages/agent-chat/AgentList.jsx` | Left rail of enabled agents |
| `admin-console/src/pages/agent-chat/ChatPanel.jsx` | Chat view: backfill, scroll-up history pagination, optimistic send, SSE live tail, session-control toolbar (Reset / Reset & lernen) |
| `admin-console/src/pages/agent-chat/Message.jsx` | Single bubble; markdown via `react-markdown` + `remark-gfm` + `rehype-pretty-code` (dual themes) + `rehype-sanitize` |
| `admin-console/src/pages/agent-chat/MessageInput.jsx` | Auto-resizing textarea with IME-safe Cmd/Ctrl+Enter submit |
| `admin-console/src/pages/agent-chat/RightRail.jsx` | Tabbed right rail (toggle `Cmd/Ctrl+Shift+L`) — hosts `SessionLogPanel` and `WorkspaceBrowser`; persists active tab in localStorage |
| `admin-console/src/pages/agent-chat/SessionLogPanel.jsx` | SSE tail of the JSONL session log; renders headerless when `embedded` |
| `admin-console/src/pages/agent-chat/WorkspaceBrowser.jsx` | Lazy-loading file tree of `/workspace/agents/<id>/` plus inline read-only file viewer (text + binary detection, 512 KB cap) |
| `admin-console/src/hooks/useSSE.js` | Generic SSE consumer with exponential-backoff reconnect |
| `admin-console/src/hooks/useColorScheme.js` | Tracks `<html data-theme>` so Shiki blocks switch with the page theme |

**DM rooms.** When the user opens an agent for the first time, the UI lazily POSTs `/api/matrix/agents/:id/dm`; the server creates (or reuses) a 1:1 Matrix room, invites the admin user, and persists `{ roomId, createdAt, createdBy }` to `/workspace/agents/<id>/dm-room.json`. Subsequent loads short-circuit on that file, so the room id round-trips through `GET /api/matrix/agents`.

**Session log rendering.** The right panel subscribes to `/api/agents/:id/session/:roomId/stream` (SSE, with a `since=<byte-offset>` cursor for replay). Each JSONL line carries a `correlationId` (the originating Matrix `event_id`) which lets the UI pair log rows with chat bubbles: hovering a message dims log entries with non-matching ids, and vice versa. Adjacent `tool_use` / `tool_result` entries with the same `toolId` are folded into a single collapsible block.

**Workspace browser.** The right rail's second tab is a read-only file explorer over `/workspace/agents/<agentId>/`. It calls `GET /api/agents/:agentId/workspace/tree?path=<rel>` for lazy directory listings and `GET /api/agents/:agentId/workspace/file?path=<rel>` for content; both endpoints reject any path that resolves outside the agent root (path traversal, escaping symlinks). File reads are capped at 512 KB and binary files (NUL byte in the first 8 KB) are flagged so the UI can show a placeholder instead of garbled text. The tab is intended as an at-a-glance peek at memory files, skills and the cloned repo — agent-side edits should still go through the agent itself.

**Markdown safety.** Agent output is sanitized with `rehype-sanitize` using the GitHub-flavoured `defaultSchema`, extended only to allow `style` and the `data-*` attributes that `rehype-pretty-code` emits on `span` / `code` / `pre` / `figure` / `div`. Sanitize runs *after* pretty-code in the rehype pipeline so the syntax-highlighting markup survives. Code blocks ship both Shiki themes (`github-light`, `github-dark`); the active theme is selected by CSS rules in `admin-console/src/theme/tokens.css` keyed off `<html data-theme>`.

## Key Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | All four services + volumes |
| `.env` | Secrets: Matrix tokens, LLM proxy URL + auth token (gitignored) |
| `Makefile` | Build + start convenience targets (`make up`, `make down`, `make logs`, ...) |
| `orchestrator/orchestrator.js` | Backend service: agent lifecycle, child-process spawning, environment-aware workspace seeding, internal HTTP API for the admin console |
| `orchestrator/agent-runner.js` | Per-agent child process: Matrix client + Claude CLI invocations + trigger scheduler |
| `orchestrator/session-log.js` | JSONL session logger: maps Claude `stream-json` NDJSON to normalized events, append-only writer |
| `orchestrator/Dockerfile` | Node 22 + Claude Code CLI + git + openssh-client |
| `orchestrator/CLAUDE-template.md` | Base template baked into the image as `/defaults/CLAUDE.md`, used as fallback when the skill-pool volume has no CLAUDE.md |
| `orchestrator/setup.sh` | Initial setup: register the admin Matrix user, print the access token |
| `admin-console/api/api.js` | Express API: agents, environments, ssh-keys, skills, models, mcp |
| `admin-console/src/pages/WorkingEnvironments.jsx` | UI: CRUD for environments (skills picker, optional repo + ssh key) |
| `admin-console/src/pages/SshKeys.jsx` | UI: CRUD for SSH keys (paste private key, see fingerprint only) |
| `admin-console/src/pages/AgentManager.jsx` | UI: CRUD for agents (with required environment dropdown) |

## Commands

```bash
# First-time bootstrap (after `podman compose up -d conduwuit`):
# registers the admin user and prints the access token to add to .env.
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
