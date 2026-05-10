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
              ├── @cobol-agent:local       ← agent-runner.js
              ├── @java-agent:local        ← agent-runner.js
              └── @quality-gate:local      ← agent-runner.js (autonomous)

orchestrator.js  (backend service, no Matrix presence)
  ├── Manages agent lifecycle (create/update/delete via Admin Console)
  ├── Spawns one agent-runner.js child process per enabled agent
  ├── Uses the admin Matrix client to provision new agent users
  └── Internal HTTP API on :4002 for the admin console
```

- **Agents:** dynamically created Matrix users (e.g. `@cobol-agent:local`); each runs its own agent-runner.js process
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
| `mcpServers` | Optional list of `{ serverId, credentialId }` refs into the central MCP registry — see *MCP Servers* below |
| `additionalContext` | Optional text appended to the agent's CLAUDE.md |

When an agent is created via the Admin Console, the orchestrator:
1. Always seeds `.claude/` and `memory/` from the skill-pool volume (or bundled defaults if empty)
2. Copies only the skills the env lists (from `/template-workspace/skills/`)
3. Patches absolute `/workspace/` paths in seeded memory
4. Materializes the env's MCP server refs into the agent's own `.claude/settings.json` (substituting credentials per-agent — see *MCP Servers*)
5. If the env has a repository, runs `git clone` with `GIT_SSH_COMMAND` pointing at the env's SSH key (`/workspace/environments/_keys/<sshKeyId>`)
6. Builds a merged CLAUDE.md: base template + env section + agent prompt

SSH keys are stored at `/workspace/environments/_keys/<keyId>` (mode 0600) with metadata in `_keys/index.json`. The private key value is **never** returned by the API after creation; only its fingerprint.

#### Why both an SSH key and a GitHub PAT?

The two credentials are kept deliberately separate as **defense-in-depth** — they are not redundant.

| | SSH key | GitHub PAT |
|---|---|---|
| `git clone` / `fetch` at workspace seed | ✅ via `GIT_SSH_COMMAND` | — |
| `git ls-remote` probe (env editor) | ✅ | — |
| GitHub Events API polling (`github-poller.js`) | — | ✅ Bearer auth |
| `gh pr create` / commit / review (`gh-as-agent`) | — | ✅ via `GH_TOKEN` / `GITHUB_TOKEN` |

**Blast-radius separation.** The SSH key can be a per-repo, read-only deploy key — its scope is "clone this one repo". The PAT carries higher privileges (push, PR creation, API actions across everything the account can reach). Splitting them means a leaked SSH key can't merge PRs and a leaked PAT didn't already grant the initial repo clone path. Collapsing the two into a token-only flow is technically possible (HTTPS clone with `GITHUB_TOKEN` injection), but would put repo I/O and API write actions on the same credential — undesirable in this enterprise context.

The setup wizard and the SSH-keys / GitHub-tokens admin pages explain this rationale inline so that operators understand why both are required.

### MCP Servers

Static skills live in the agent's workspace; **MCP servers** are how agents reach things they need to query at *runtime* — wikis, vector stores, graph DBs. The pattern intentionally mirrors the SSH-key / GitHub-PAT split: a *catalog* of servers, a *separate* credential store, and an environment that pairs the two.

| Path | Role |
|---|---|
| `mcp-servers/<id>/server.js` (repo) | Reference implementations baked into the orchestrator image. The shipped `wiki/` server is a single-file stdio MCP that hits a configurable REST backend. |
| `/template-workspace/mcp-servers/<id>/` | Where `make seed-mcp-servers` lays down those reference implementations inside the orchestrator. The server registry's default `command` / `args` reference these paths. |
| `/workspace/mcp-servers/<id>/server.json` | Server **registry** — operator-managed catalog. Fields: `id, name, description, transport (stdio\|http\|sse)`, plus transport-specific: stdio carries `command, args, env`; http/sse carry `url, headers`. Both the `env` and `headers` maps support `${credential}` as a placeholder for the bound credential's secret — substituted per-agent at seed time. |
| `/workspace/mcp-credentials/_keys/<credId>` | Raw secret (mode 0600). Never returned by the API after creation. |
| `/workspace/mcp-credentials/_keys/index.json` | Credential metadata (`id, name, serverId, fingerprint, createdAt`). |

**Per-agent isolation.** At seed time the orchestrator reads `env.mcpServers` (or the team-member's `mcpServersOverride`), loads each `server.json`, substitutes `${credential}` from the bound credential, and writes the merged stanza into **the agent's own** `.claude/settings.json` under `mcpServers[<serverId>]`. The output shape matches Claude Code's MCP config schema: stdio servers get `{command, args, env}` (no `type` field — stdio is the default); http servers get `{type: "http", url, headers}`; sse servers get `{type: "sse", url, headers}`. There is no longer a pool-wide MCP config — every agent sees only the servers and credentials its environment grants. The legacy `/api/mcp` endpoint that wrote `/pool/.claude/settings.json` has been replaced by `/api/mcp-servers` + `/api/mcp-credentials`.

**Why a separate credential store?** Same logic as SSH-key vs. PAT: the registry says "this team can talk to the wiki"; the credentials say "with these tokens". Splitting them lets you rotate a Confluence token without touching the registry, and keeps the secret out of every environment editor's payload. Credentials are global (one Confluence token can back two environments) — the analogue of how SSH keys are global, not per-env.

**Per-member override.** A team-member may carry an `mcpServersOverride` array (same `[{serverId, credentialId}, ...]` shape as `env.mcpServers`); when present it replaces the env's MCP set verbatim for that one member, parallel to `skillsOverride`. Absent = inherit. Edit it via the **MCP Servers** field on the agent edit form.

**Team-Setup wizard.** The "Knowledge sources" step (between Credentials and Team) selects the team-wide MCP set. Servers that declare a `${credential}` placeholder require a credential to be bound at this step; servers without one accept "(none)".

### Agent Roles

| Role | Behavior |
|---|---|
| `agent` | A standalone agent. Responds to direct messages from a human in its 1:1 DM room. With cron / GitHub triggers it can also run autonomously. |
| `team` | A reusable system-prompt template + shared Working Environment that doesn't host an agent itself. Use **Add Member** on the team card (or the Team-Setup wizard) to spawn one or more `team-member` agents. |
| `team-member` | A single member spawned from a team. Inherits the team's `systemPromptTemplate`, the env's skills, and the env's `mcpServers` by default. Records its parent in `parentTeamId`. May override any or all of: `systemPrompt` (string) overrides the team prompt; `skillsOverride` (array of skill names) replaces the env's skill set; `mcpServersOverride` (array of `{serverId, credentialId}` refs) replaces the env's MCP set. Absence of a field = inherit. Editing the team's `systemPromptTemplate` eagerly rewrites every inheriting member's `AGENT-PROMPT.md` / `CLAUDE.md`; skill and MCP changes on the team's env are picked up at the next member rebuild. |
| `orchestrator` | Bound to a BriefingPack directory (`briefingsPath`). On creation and on every tick of its claim loop (~30s), it pulls main (60s-throttled), scans the directory, and writes one stub `bp-instance` agent per BP. When a BP transitions to `status: dispatched`, the orchestrator posts a DM suggestion to the user; on user confirmation the orchestrator agent runs a `curl` against `/internal/agents/:id/claim` which patches the BP's `brief.md` (status, agent-id, claimed timestamp), commits + pushes to make the claim visible to teammates, and then materialises the bp-instance. Manual Activate / Deactivate via the Admin Console bypasses the suggest flow. |
| `bp-instance` | One per Briefing Pack under an orchestrator. Lives as a stub (no Matrix user, no workspace) until claimed or activated. The activated agent is bound to one specific BP and uses the ACE engineering skill to execute its LoopScript. |

> **Legacy roles.** Earlier versions used `expert` / `expert-group` / `expert-instance`. The orchestrator rewrites these to `agent` / `team` / `team-member` (and renames `parentGroupId` → `parentTeamId`) on startup; reads also normalize on the fly, so any unmigrated config is loaded with the new shape.

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
| `github-event` | `repo` (`owner/name`), `events` (string list, e.g. `pull_request.opened`), optional `from` (origin filter — see *Layered loop protection* below) | Fired by the GitHub poller when the GitHub Events API reports a matching event for the repo. The agent receives the trigger's `prompt` plus the full event payload as JSON. |

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

**GitHub poller (`github-event` triggers)**

`orchestrator/github-poller.js` runs inside the orchestrator process and polls the [GitHub Events API](https://docs.github.com/en/rest/activity/events) every 30 s for every repo that appears in some Working Environment with a `githubTokenId` attached. Designed for environments where GitHub cannot reach the local stack (no public ingress) — polling replaces webhooks.

- **Repo discovery**: walks all environments, deduplicating repos. Picks one token per repo (first environment wins). Repos without an associated token are skipped.
- **Bandwidth**: each request uses `If-None-Match` with the previously stored ETag, so unchanged repos cost no rate-limit budget (304 responses don't count). Effective rate is ~120 conditional GETs/h per repo.
- **Cursor**: `lastEventId` per repo persisted to `/workspace/github-poller/state.json`. First poll only records a baseline (no event flood on startup).
- **Fan-out**: matched events are enqueued in the same `/workspace/agents/:agentId/pending-triggers.json` that HTTP triggers write to — the agent-runner picks them up via its existing 5 s drain. Pending entries carry `github.{event, eventId, repo, actor, createdAt, payload}` and are appended to the agent's prompt as a fenced JSON block.
- **Event keys**: `<lowercase_type_without_event>.<action>` (e.g. `pull_request.opened`, `pull_request_review.submitted`). Bare `push` (no action). The Events API does not emit every webhook action — for instance there's no `pull_request.synchronize`.
- **Identity**: agents share one GitHub PAT, so the actor field in events is the same for everyone. Per-agent attribution comes from metadata tags applied by the `gh-as-agent` wrapper (`/usr/local/bin/gh-as-agent` in the orchestrator image): `commit` sets the author email to `<agentId>@agents.local`; `stamp <file>` appends `<!-- agent: <id> -->` to a body file before posting via `gh pr create / review / comment`. The poller's `extractOriginAgent` reads either signal from incoming events. Agents that bypass the wrapper lose attribution and the loop-protection layers below.

**Layered loop protection.** Three layers stack — every event must pass them in order before reaching an agent's queue:

| Layer | Where | What it blocks |
|---|---|---|
| 0 — Self-loop | `_fanOut` | Origin matches destination. Unconditional, no spec value disables it. |
| 2 — `from` filter | `applyFromFilter` | Per-trigger origin filter. Values: `any-except-self` (default), `humans`, `agents`, `team` (origin in same `team` as subscriber, read from `config.json`), `["agent-id", ...]` allowlist (with `"humans"` as a special token), `{ exclude: [...] }` blocklist. Unknown specs fail-closed. |
| 3 — Conversation throttle | `_checkAndIncThrottle` | Per `(agent, conversationKey)` sliding window — default 5 events/h. `conversationKey` groups by PR/issue/branch (`pr:42`, `issue:99`, `push:refs/heads/x`, …). On the first over-threshold drop the poller writes a `kind: "throttle-warning"` entry to `pending-triggers.json`; the agent-runner posts a plain DM warning (no Claude call) and then drops further events silently until the window resets. Buckets persist in `/workspace/github-poller/throttle-state.json` and self-prune at 2× the window. |

Layer 1 (template discipline — narrowly scoped events per role) lives in the role templates themselves, not in code, so it isn't a runtime layer.

Results are posted to `trigger.roomId` if set, otherwise to the agent's DM room with the admin (read from `/workspace/agents/<id>/dm-room.json`). If neither is available — i.e. the user has not yet opened a chat with this agent — the trigger run is skipped. `[PASS]` suppresses output.

**Session policy on triggered runs.** Agents may declare `sessionPolicy: per-invocation` in `config.json`. When set, *triggered* runs (`github-event`, `cron`, `http`) start with a fresh Claude session (no `--resume`) and don't write the session pointer at run end — the DM session continuity is preserved untouched. The trigger prompt also gets a learn-hint instructing Claude to extract reusable lessons into `memory/log.md` before responding, so persona persists even though the conversational context doesn't. DM messages are unaffected: chat continuity is always honoured. Agents without the field default to `persistent` (legacy behaviour).

### BP-event router

The orchestrator hosts a central ingestion endpoint that any signaling source (today: ACE `bp-transition.py`; future: GitHub-poller diff path) can call to announce a Briefing Pack change. The signaler announces what changed; the orchestrator owns the routing.

**Endpoint:** `POST /internal/bp-events` (port 4002, no auth — internal-only)

**Payload shape:**

```json
{
  "source": "<agent-id-or-script-identifier>",
  "events": [
    { "type": "bp:revised|bp:completed|bp:input-changed", "bp": "<12-char hex>", "details": { ... } }
  ]
}
```

**Routing algorithm (`orchestrator.routeBpEvents` + `bp-event-router.js`):**

1. Build a one-shot reverse index `bpId → { stubId, parentOrchestratorId }` from the bp-instance configs.
2. Group events by hosting orchestrator. Events whose BP is unknown to any stub are skipped with `unknown-bp`.
3. For each orchestrator: force-pull its briefings clone (so stale local index doesn't cost the routing decision), load `<briefingsPath>/artifacts/briefings/.index.json`.
4. For each event, compute affected BPs:
   - **`depends-on` dependents** — any leaf BP whose `depends-on` array contains the event's BP hash.
   - **input-artifact dependents** — any leaf BP with an `artifacts[]` entry where `direction: input` and `path` matches a `direction: output` path of the event's BP.
5. For each affected BP, locate its bp-instance stub. Apply the agent's `bp-trigger-policy` (see below), then `enableAgent` (idempotent — materializes stubs, respawns disabled agents) and append a `bp-event-batch` entry to its `pending-triggers.json`.
6. Add an awareness entry to the hosting orchestrator's `pending-triggers.json` listing all downstream effects.

**`bp-event-batch` is not a triggers.json type.** It's a `kind`-tagged entry that the agent-runner's drain loop handles inline (`executeBpEvent`) — no triggers.json registration required.

**Situation classification.** Before enqueuing, the orchestrator inspects the affected BP's current status in the loaded `.index.json` and tags each `bp-event-batch` entry with one of:

- `kickoff` — affected BP is `ready` and all its `depends-on` are now `completed`/`reviewed`. The receiving agent reads its brief, posts a 2–3-sentence mission summary plus its planned approach, and asks the user to greenlight starting. No claim, no LoopScript run, no commits before user OK.
- `cascade-stale` — affected BP was already `completed`/`reviewed`/`stale` and may now be invalidated. The receiving agent posts a lay-of-the-land summary and asks whether to run `/confirm-valid` or `/revise`.
- `other` — defensive fallback (e.g. BP already `dispatched`/`claimed`); falls through to the cascade-stale prompt.

In every situation the agent's prompt requires an explicit closing question to the user, so the chat clearly shows the agent waiting for input rather than emitting a bare status statement.

**Agent `bp-trigger-policy`** (optional field in `config.json`, defaults applied when absent):

| Field | Values | Default | Effect |
|---|---|---|---|
| `mode` | `off` / `notify-only` / `notify-on-activate` | `notify-on-activate` | `off` ignores events; `notify-only` enqueues only when the process is already running; `notify-on-activate` materializes stubs and respawns disabled agents before enqueuing |
| `respect-manual-disable` | `true` / `false` | `false` | When `true` and an agent was manually disabled, skip activation despite the event |

**Idempotency.** Multiple events for the same `(type, bp)` within one request are deduplicated. `enableAgent` is itself idempotent. Re-firing the same signal is safe — the receiving agent simply gets one more notification entry.

**Best-effort posture.** The signaler treats endpoint failures as silent (connection refused → no AEE running, fine). The endpoint never throws on routing errors per-target; failures are surfaced in the response's `routed[].error` / `skipped[]` arrays.

### BP-instance hand-off (manual)

Every bp-instance chat in the Admin Console has a hand-off action that lets the user activate downstream agents at end-of-session. Because each agent has its own workspace and its own clone of the relevant repos, **the only durable bridge between them is git** — the dialog enforces this contract.

**Flow:**

1. Opening the dialog calls two endpoints in parallel: `GET /api/agents/:id/handover/candidates` (proxy to the orchestrator's `.index.json` graph) and `GET /api/agents/:id/handover/git-status` (per-repo `branch`, `head`, `headSubject`, `upstream`, `ahead`/`behind`, `dirty`, `pushed`, `ready`).
2. The dialog renders a per-repo pre-flight card. The submit button is disabled while any repo is dirty or has unpushed commits, unless the user opts into an explicit override (checkbox + free-text reason that gets quoted into every target's hand-off note).
3. Two pre-flight buttons — **Ask agent to commit & push** and **Ask agent to push pending commits** — POST `/api/agents/:id/handover/nudge` which posts a canned prompt into the source agent's own DM. The agent does the git work itself, the chat history captures the audit trail, and a **Re-check** button refreshes the git status without closing the dialog.
4. On submit, `POST /api/agents/:id/handover` re-fetches git-status server-side and returns `409 git-not-ready` unless the workspace is ready or the override carries a reason — a stale browser snapshot cannot bypass the gate.
5. For each target, the server materializes/enables the stub, ensures a DM room, and posts a structured Markdown body containing: the source-of-work block (per repo: name, branch, `headShort`, last-commit subject, remote URL, upstream, dirty markers), input-artifact paths from `.index.json` when present, the user's free-text note, the override reason (if any), per-target consistency warnings, and an explicit "Before you start" checklist (`cd <repo> && git fetch && git checkout <branch> && git pull --ff-only`, `git log --oneline -5`, confirm with user). The receiving agent picks the message up via the standard DM heuristic.
6. **Repo consistency check.** Each target's environment is compared against the source repos: missing repo URLs and branch mismatches surface as warnings both inline in the DM body (so the receiving agent reads them) and in the dialog's per-target results list (so the user sees them).

### Agent Management

All agent lifecycle operations (create / enable / disable / edit prompt / delete) happen via the **Admin Console** at `http://localhost:4000`.

### Team-Setup wizard

`POST /api/teams` (driven by the **Team Setup** wizard at `/team-setup`) materialises a team-shaped agent group in one atomic-with-rollback transaction. The wizard sits on top of the existing `team` / `team-member` machinery — the result is identical in shape to a manually-created team plus members. Inputs: a `teamId` slug, team name, repository (URL, branch, `sshKeyId`), `githubTokenId`, and a list of role templates.

Role templates live as JSON files under `/template-workspace/agent-templates/` (seeded from `orchestrator/skill-pool/agent-templates/` via `make seed-templates`). The initial catalog ships with seven roles:

| Role | Session | Trigger | `from` |
|---|---|---|---|
| `business-analyst` | persistent | — (DM only) | — |
| `developer` | per-invocation | `issues.labeled` (`ready` gate) | any-except-self |
| `code-reviewer` | per-invocation | `pull_request.opened/reopened` | any-except-self |
| `security-reviewer` | per-invocation | `pull_request.opened/reopened` | any-except-self |
| `test-reviewer` | per-invocation | `pull_request.opened/reopened` | any-except-self |
| `documentation-sync` | per-invocation | `pull_request.closed` (merged) | any-except-self |
| `issue-triage` | per-invocation | `issues.opened` | humans |

Each `per-invocation` role also ships a weekly self-curation cron (staggered 5min apart) that reviews and prunes the agent's `memory/`.

**Materialisation flow:**
1. One Working Environment id `<teamId>` carrying the shared repo, SSH key, PAT, and the team-default skill set (empty in v1).
2. One `team` agent id `<teamId>` with a generic shared `systemPromptTemplate` and `skipFirstMember: true` (so the wizard adds members itself with role overrides instead of getting an auto-numbered `<teamId>-1`).
3. One `team-member` agent per selected role, id `<teamId>-<roleId>`. Each member carries:
   - `systemPrompt` = role-specific prompt from the template (override against the team default).
   - `skillsOverride` deliberately omitted in v1 — members inherit the team-env's empty skill list. Once role-specific skill packs ship they slot in here.
   - `sessionPolicy: per-invocation` (for reactive roles).
   - Full `triggers.json` rendered from the template (`{{repoFullName}}` substituted), with `from` filter and `repo` set to the team's repo.
4. One DM room pre-created per member (best-effort — failure here doesn't roll back the team).

On any failure the wizard rolls back members (`DELETE /internal/agents/:id`), then the team agent, then the env, in reverse creation order. `mode: "extend"` keeps a pre-existing team and adds only the missing role-members; `mode: "create"` (default) returns 409 if the env or team or any member already exists.

Members can be edited later via the standard agent edit form: System Prompt and Skills each toggle between **Inherit from team** (override field cleared) and **Custom** (override stored on the member). Editing the team's prompt-template eagerly pushes the new value to every inheriting member; skill changes on the team's env are picked up at the next member rebuild (lazy push, by design).

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
| `orchestrator/agent-runner.js` | Per-agent child process: Matrix client + Claude CLI invocations + trigger scheduler. Honors `sessionPolicy: per-invocation` and posts plain-text throttle warnings on `kind: throttle-warning` queue entries. |
| `orchestrator/github-poller.js` | Polls the GitHub Events API; applies Layer-0 self-loop, Layer-2 `from` filter, Layer-3 conversation throttle before fanning events out to per-agent `pending-triggers.json`. |
| `orchestrator/session-log.js` | JSONL session logger: maps Claude `stream-json` NDJSON to normalized events, append-only writer |
| `orchestrator/Dockerfile` | Node 22 + Claude Code CLI + git + openssh-client |
| `orchestrator/CLAUDE-template.md` | Base template baked into the image as `/defaults/CLAUDE.md`, used as fallback when the skill-pool volume has no CLAUDE.md |
| `orchestrator/skill-pool/agent-templates/` | Role-template JSON files for the Team-Setup wizard (seeded into `/template-workspace/agent-templates/` via `make seed-templates`). |
| `orchestrator/setup.sh` | Initial setup: register the admin Matrix user, print the access token |
| `admin-console/api/api.js` | Express API: agents, environments, ssh-keys, skills, models, mcp, **`POST /api/teams`** (Team-Setup wizard backend), `GET /api/agent-templates`. |
| `admin-console/src/pages/WorkingEnvironments.jsx` | UI: CRUD for environments (skills picker, optional repo + ssh key) |
| `admin-console/src/pages/SshKeys.jsx` | UI: CRUD for SSH keys (paste private key, see fingerprint only) |
| `admin-console/src/pages/Agents.jsx` | UI: CRUD for agents (env dropdown, role-aware cards, team-member edit form with inherit/override toggles for `systemPrompt` and `skillsOverride`). |
| `admin-console/src/pages/TeamSetup.jsx` | UI: 4-step wizard (Project → Credentials → Team → Review) that drives `POST /api/teams`. |

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

## MCP Servers (operator notes)

Reference servers ship in-repo under `mcp-servers/<id>/`. `make seed-mcp-servers` (chained from `make seed-pool`) syncs them into the pool volume at `/template-workspace/mcp-servers/`. Operators add new servers through the **MCP Servers** admin page (catalog + credentials), and Working Environments / team-members reference them by id. Adding a new backend (vector store, graph DB) is a matter of:

1. Drop a new server under `mcp-servers/<id>/` (any single-file MCP, stdio or http).
2. `make seed-mcp-servers` to copy it into the pool.
3. Register it via the admin UI; bind a credential; attach to environments.

The wiki reference server is intentionally tiny and dependency-free so that "what's the contract" is readable at a glance — clone it as a starting point for the next backend.
