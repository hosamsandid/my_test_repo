# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

> High-level map. Deep specs live under `docs/`; ticket-level history lives in git.

## Project Overview

**e-vgh-claw** is a local Matrix-to-Claude-Code stack for an enterprise context. It provides chat-based AI agents extensible with domain-specific skills for **Mainframe Migration** (COBOL, JCL, DB2, IMS, etc.).

The stack runs locally with Podman as a single compose file: **Conduwuit** (Matrix homeserver); **Orchestrator** (control-plane, spawns/manages one container per agent, no Matrix identity); **Admin Console** (web UI on `:4000` for agents, environments, SSH keys, skills, etc.; embeds a chat UI at `/chats/:agentId`); **bp-explorer** (read-only viewer for ACE BriefingPack metadata).

The LLM backend is reached via an Anthropic-compatible proxy: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` in `.env` (gitignored). Default Sonnet/Haiku models set there too.

**Model Provider auth types.** A registered Model Provider (`/workspace/llm-endpoints/index.json`, tokens in `_keys/` at 0600) carries an `authType`: default **`api-key`** (Bearer against `baseUrl`) or **`oauth-token`** (Claude *subscription* auth via `claude setup-token`). For `oauth-token` the orchestrator injects `CLAUDE_CODE_OAUTH_TOKEN` and strips `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` so the CLI talks directly to `api.anthropic.com`. The login flow runs server-side under a PTY (`orchestrator/llm-auth-flow.js`, `/api/llm-auth/flows/*`); the token is claimed server-side, never reaching the browser. **Compliance:** consumer-subscription OAuth tokens are single-user only (Anthropic Consumer Terms) — creating/re-keying one requires a single-user confirmation recorded as `complianceAck`. One-shot server-side generation (`resolveGenerationTarget`) skips `oauth-token` providers.

## Architecture

All human↔agent communication happens through **direct messages**: each agent has its own Matrix user; the human chats with it in a dedicated 1:1 room. There is no shared multi-agent room and no central routing identity.

```
Admin Console chat UI (or any Matrix client) → Conduwuit (localhost:8448)
       └── 1:1 DM rooms (one per agent, e.g. @cobol-agent:local ← as-agent:latest)

orchestrator.js (control-plane container, no Matrix presence)
  ├── Manages agent lifecycle (create/update/delete via Admin Console)
  ├── Spawns ONE Podman container per enabled agent over the libpod
  │     socket (/var/run/podman.sock) via spawn-container.js
  ├── Provisions per-agent network + volume isolation; reconciles live
  │     containers (by the `aee.agent.id` label) against its map
  ├── Provisions new agent Matrix users via the admin client
  └── Internal HTTP API on :4002 for the admin console
```

- **Agents** are dynamically created Matrix users, each in its **own** Podman container (`as-agent:latest`), lifecycle-managed by the orchestrator. Configs persist in `/workspace/agents/<id>/` (`config.json` + `CLAUDE.md` + `AGENT-PROMPT.md`); DM room id in `dm-room.json` (created lazily by the console).
- Each agent is bound to a **Working Environment** (below) defining what gets seeded into its workspace.
- **Container-per-agent isolation** is three-way: per-agent **network**, per-agent **filesystem** via a SubPath mount of the pool volume (`AEE_WORKSPACE_ISOLATION`, default on), optional **dedicated volume** (`AEE_PER_AGENT_VOLUME`, opt-in).
- **Agent runtime**: the container entrypoint `agent-image/scripts/agent-entrypoint.py` (+ `sase_lib.py`) — Matrix client + Claude CLI invocations + trigger scheduler.

### Teams (human collaboration & visibility scope)

A **Team** (the *human* grouping) is the tenant/scope resources and human users are assigned to. **Do not confuse it with the `role: "team"` agent construct**, always called an **Agent Team** (an agent squad working a repo); they only share a word. Data model: three JSON collections under `/workspace` (`teams/`, `users/`, `memberships/index.json`); roles: **System Admin** (global, `user.systemAdmin`), **Team Admin**, **Team Member** (per-team). Every agent construct, env, and credential carries a `teamId` (default `default`).

Source of truth: `orchestrator/teams-store.js` (pure factory). The orchestrator bootstraps the default team + an optional System Admin (`BOOTSTRAP_SYSTEM_ADMIN_SUBJECT`) and backfills `teamId` at startup. CRUD at `/internal/admin/{teams,users,memberships}` (proxied `/api/admin/...`) — **distinct** from `/internal/teams/*` and `POST /api/teams`, which manage Agent Teams. Driven by the **Teams** page (`/teams`, `Teams.jsx`).

**Resource scoping.** List endpoints are filtered by the caller's team membership via `admin-console/api/scope.js`. The env admin + any System Admin get full visibility (`all: true`); others see only resources whose `teamId` is one of their memberships (global/pool skills always visible). Full spec: `docs/teams-data-model.md`.

### Working Environments

A **Working Environment** is a reusable **infrastructure template** at `/workspace/environments/<envId>/environment.json`: `id`/`name`/`description`; `repository` (optional `{url, branch, sshKeyId}`, cloned at creation); `mcpServers` (optional `{serverId, credentialId}` refs into the MCP registry); `additionalContext` (optional text appended to CLAUDE.md).

**Environments do NOT carry skills — never re-add them.** The skill *grant* is **team-owned** (`orchestrator/skill-grants.js`): team agents (`role: team`) carry `skills[]` (inherited by every member without a `skillsOverride`); standalone agents/orchestrators carry their own; bp-instances inherit from their parent orchestrator. `effectiveSkills(cfg, loadCfg)` resolves the grant everywhere (seeding, CLAUDE.md gating, preview).

**Skill seeding & activation.** Every seed writes a per-agent manifest `/workspace/agents/<id>/.aee/seeded-skills.json` (`{name: {tier, seededAt}}`) — the truth for whether a running member actually has a skill. One-click (de)activation is an **additive file sync, not a respawn** (skills are static files read per invocation): `POST /internal/teams/:teamId/skills/{activate,deactivate}` (or `/internal/agents/:id/skills/...`) edits the list + copies/removes per-member files via `planSkillSync`, rebuilds each CLAUDE.md, mirrors into isolated volumes (proxied `POST /api/knowledge/{activate,deactivate}`). At **autonomy level 3** the curator's auto-promotions are auto-activated (learn → bundle → promote → activate, no human).

**Agent creation seeding** (orchestrator): seed `.claude/` + `memory/` from the skill-pool volume (or bundled defaults); copy the resolved skill grant (team-first, then global); patch absolute `/workspace/` paths in memory; materialize the env's MCP refs into the agent's `.claude/settings.json` (per-agent credential substitution); `git clone` if the env has a repo (SSH URLs → `GIT_SSH_COMMAND`; HTTPS GitHub → PAT via `GIT_CONFIG_*`); build CLAUDE.md via the prompt-assembly pipeline.

#### System-prompt assembly & preview

The seeded `CLAUDE.md` and a runtime `--append-system-prompt` memory hint are composed by one pure, unit-tested module — **`orchestrator/prompt-assembly.js`** — used by both the seed path (`buildAgentClaudeMd`) and the preview endpoint, so preview is byte-identical to what's seeded.

- **Ordering.** The authored **Agent Role is hoisted to the top** (after a short identity preamble), ahead of generic blocks (Working Environment → Workspace → Response Formatting → Memory System → Skills → GitHub Actions → Trigger management → Important Notes). Base template read from `/template-workspace/CLAUDE.md` (else `/defaults/CLAUDE.md`), split by H2, re-ordered in code.
- **Conditional gating.** Git/`gh-as-agent` only when the env has a repo; Trigger-management + unattended framing only for **autonomous** agents (`agentIsAutonomous()`: `sessionPolicy: per-invocation`, `orchestrator`/`bp-instance`, or already has triggers); Skills only when the grant is non-empty. *Known limitation:* adding a trigger to a persistent agent injects the trigger docs only at the next prompt rebuild.
- **Runtime hint.** `buildMemoryHint(blueprintId)` is **byte-identical** to `_build_memory_hint()` in `agent-entrypoint.py` (test-asserted; change both in one commit).
- **Preview.** `GET /api/agents/:id/prompt-preview` renders `claudeMd` + `appendSystemPrompt` + gating `meta`, shown read-only as the **Prompt** tab (`PromptPreviewPanel.jsx`).

SSH keys are stored at `/workspace/environments/_keys/<keyId>` (mode 0600), metadata in `_keys/index.json`. The private key is **never** returned by the API — only its fingerprint.

#### Why both an SSH key and a GitHub PAT? (defense-in-depth)

Not redundant. SSH key → git I/O on SSH URLs (via `GIT_SSH_COMMAND`); can be a per-repo read-only deploy key. GitHub PAT → git I/O on HTTPS GitHub URLs, Events API polling, and `gh pr create`/commit/review (`gh-as-agent`, via `GH_TOKEN`/`GITHUB_TOKEN`). **Blast-radius separation:** a leaked SSH key can't merge PRs; a leaked PAT didn't grant the initial clone. For HTTPS-only repos the PAT covers both — prefer SSH URLs + deploy keys.

**Credential rotation propagates to running agents.** Spawn-time credentials (PAT from `env.githubTokenId`, per-agent SSH identity) are baked into each container at `startAgentProcess`, immutable for its lifetime. Repointing an env at a different token → `PUT /api/environments/:id` detects the `githubTokenId` change and best-effort calls `POST /internal/environments/:id/respawn-agents`, recreating every running agent bound to that env. Disabled agents pick up the fresh credential on next enable.

### MCP Servers

Static skills live in the workspace; **MCP servers** are how agents reach runtime data (wikis, vector stores, graph DBs). The pattern mirrors the SSH/PAT split: a *catalog* of servers, a *separate* credential store, an environment that pairs them.

- `mcp-servers/<id>/server.js` (repo) — reference implementations baked into the image; `make seed-mcp-servers` lays them into `/template-workspace/mcp-servers/<id>/`. The shipped `wiki/` server is a single-file stdio MCP over a REST backend.
- `/workspace/mcp-servers/<id>/server.json` — operator-managed **registry**: `id, name, description, transport (stdio|http|sse)`, plus stdio `command, args, env` or http/sse `url, headers`. `env`/`headers` support `${credential}`, substituted per-agent at seed time.
- `/workspace/mcp-credentials/_keys/<credId>` — raw secret (0600, never returned); `index.json` holds metadata. Credentials are global (one token can back two environments).

**Per-agent isolation.** At seed time the orchestrator reads `env.mcpServers` (or a member's `mcpServersOverride`), substitutes `${credential}`, and writes the merged stanza into **the agent's own** `.claude/settings.json` under `mcpServers[<serverId>]` (Claude Code schema: stdio `{command, args, env}`; http/sse `{type, url, headers}`). No pool-wide MCP config. `mcpServersOverride` on a member replaces the env's MCP set for that member; absent = inherit.

### Agent Roles

- `agent` — standalone. Responds to DMs in its 1:1 room; with cron/GitHub triggers it can run autonomously.
- `team` — a reusable system-prompt template + shared Working Environment; hosts no agent itself. **Add Member** (or the wizard) spawns `team-member` agents.
- `team-member` — spawned from a team. Inherits the team's `systemPromptTemplate`, the team agent's `skills[]`, and the env's `mcpServers`; records `parentTeamId`. May override `systemPrompt` / `skillsOverride` / `mcpServersOverride` — absence = inherit. Editing the team's `systemPromptTemplate` eagerly rewrites every inheriting member; skill/MCP changes apply at the next member rebuild.
- `orchestrator` — bound to a BriefingPack dir (`briefingsPath`). On creation and each ~30s claim tick it pulls main (60s-throttled), scans the dir, writes one stub `bp-instance` per BP. On a BP → `status: dispatched` it DMs a suggestion; on user confirmation it `curl`s `/internal/agents/:id/claim` (patches `brief.md`, commits+pushes, materialises the bp-instance). Manual Activate/Deactivate bypasses the suggest flow.
- `bp-instance` — one per Briefing Pack under an orchestrator. A stub (no Matrix user, no workspace) until claimed/activated; bound to one BP, uses the ACE engineering skill to execute its LoopScript.

> **Legacy roles.** `expert`/`expert-group`/`expert-instance` → `agent`/`team`/`team-member` (and `parentGroupId` → `parentTeamId`) on startup and on read.

### Autonomous Agent Triggers

Triggers live in a per-agent `/workspace/agents/<id>/triggers.json`; the scheduler syncs every 60s (`node-cron`). **Self-managed** (the agent can edit its own), **file-based sync**, **overlap protection** (a still-running trigger skips the next tick).

- `cron` (`cron`, 5-field) — recurring. `once` (`at`, ISO) — one-shot, auto-removed after execution.
- `http` (`secret`, auto-gen) — fired by external HTTP POST (see Webhook Server).
- `github-event` (`repo` `owner/name`, `events` e.g. `pull_request.opened`, optional exact-match `labelFilter`) — fired by the GitHub poller. **No source/origin filtering** — fires on any matching event regardless of cause. Agent gets the `prompt` + full event payload as JSON.

Results post to `trigger.roomId` if set, else the agent's DM room. If no room exists yet the run is **skipped**. `[PASS]` suppresses output.

**Session policy.** With `sessionPolicy: per-invocation`, *triggered* runs start fresh (no `--resume`) and don't write the session pointer — DM continuity is untouched; the trigger prompt gets a learn-hint to extract lessons into `memory/log.md` first. Absent = `persistent` (legacy).

### Process Canvas / Flows (orchestration graph)

Agents + their triggers form an **orchestration graph**, authored in the **Flows** view (`/flows`, `Briefings.jsx`). The graph/editor is the `ProcessGraphPanel` export in `ProcessCanvas.jsx`, driven by a `scope` prop (`'<teamId>' | 'draft:<id>' | 'import'`). The Flows left list selects scope: **Teams** (live graphs), **Drafts**, legacy **BriefingPack flows**. `/process` routes redirect to `/flows`.

**Declarative ports are the single source of truth** for edges (siblings on a role/agent config, edited via `ConnectionsSection.jsx`, persisted via `PUT /api/agents/:id`): `emits: string[]` (label tokens the work sets — declarative only, the agent still sets the label at runtime; draws "agent → label → listening trigger"); `dataFlow.{dependsOn,inputs,outputs}` (live) ≡ role `dependsOn/inputs/outputs` (draft) — dependency/data-flow edges; `github: {producesPr?, producesIssue?}` (what a role opens — drives badges/ports + an "open a PR/issue" prompt block); `channels: [{artifact: 'pr'|'issue', from, label?, gate?}]` on the *consumer* (which producer's PR/issue it reacts to; `gate: 'human'` = inline approval gate); `parentMemberId` ≡ role `parent` (cycle-guarded); `stage`.

**Functional triggers are derived from ports, not authored.** A draft derives them at materialise (`expandDataFlowSteps`, `expandGithubChannels`); a live team re-derives on every port write (`reconcileTeamDataFlow`, `reconcileTeamGithubChannels`) — regenerating `<consumer>-on-push-<upstream>` / `<consumer>-on-<artifact>-<producer>` triggers (marked `dataFlow`/`channel: true`), leaving hand-authored ones untouched. **A human-approval gate** is a label listener on a downstream step whose label is flagged `humanGate` in the bundle's `labels[]` registry (or gated by a channel's `gate: 'human'`) — the red gate node; never trips `gate-violation` since no agent emits it. Gate-ness is **configuration, not a naming convention** (#928): the old `human:*` prefix and the hardcoded `hold`/`needs:human` brakes carry no meaning of their own.

**Graph endpoint.** `GET /api/process/graph` (or `POST {processTemplate}`) → `{ level, team, nodes, edges, gates, labels, lints }`. Edge `S→T` labelled `L` exists when `S` emits `L` and a `T` trigger listens via `labelFilter`. Raw GitHub-event triggers (no `labelFilter`) are `external: true`; gate/brake labels and `cron`/`once` self-loop `timer` edges originate from `null`. **Gate/brake classification reads config flags, never the label name** (#928): `labels[].humanGate` / `labels[].brake` from the bundle registry (a live team keeps it on the team agent, like `stages`) plus `channels[].gate: 'human'` — threaded into the builders as `{ labels }`. A `humanGate` label may not be agent-set (`gate-violation`); a `brake` label pauses the loop and *may* be agent-set. `lints` (advisory, never blocks): `orphan-listener`, `dead-end-emitter`, `competing-stage`, `producer-unconsumed`, `channel-from-non-producer`, `gate-violation` (error). Levels: **live** (`?team=<id>`) reads persisted `emits`; **template** (`?templates=...`) reads role-template `emits` (raw `{{var}}`). Pure builders: `process-graph.js` + `unified-graph.js`.

**Artifacts** are matched by **logical name** (`{name, hint?, description?}`, `artifactKey` in `process-template.js`), not physical path, since a re-instantiable agent writes to a varying path. Real location is resolved at runtime from a git-committed manifest `.aee/artifacts.jsonl`: the producer records with `aee-artifact add "<name>" <path>` (CLI `agent-image/scripts/aee-artifact`) + commits/pushes; the derived trigger tells the consumer to `git pull` and `aee-artifact path "<name>"`. A **wake, not a start-gate** — nothing blocks a downstream agent (agents have no "completed" state; that gating is BP-only).

**Drafts** are editable bundles that exist before materialisation. CRUD `/api/process/drafts[/:id]`, persisted at `/workspace/process-drafts/<id>.json` (empty `roles` allowed). Draft mode edits in place via a write-target adapter (`edit-adapters.js`) routing shared dialogs to `liveOps` (HTTP to running agents) or `makeDraftOps` (mutate bundle + PUT); `liveOps` writes only ports, so it's shape-compatible — the editor never branches on mode.

**Templates & round-trip.** `GET /api/process/template?team=<id>` exports a portable `processTemplateVersion: 1` bundle (roles, `emits`, triggers, gates, labels, `stages` — no repos/secrets); materialising feeds it to `POST /api/teams`. **Edit as draft** seeds a draft with the team's bundle + `sourceTeamId` (defaults `mode: extend`). Format: `docs/process-template-format.md`.

**Stages** partition the flow axis: each node has an optional `stage` (inherits from parent via `effectiveStage`); an ordered `stages: string[]` on the bundle/team-agent defines column blocks. Authored via `StageManager.jsx`; carried through materialisation and round-tripped by Edit-as-draft. **Layout** is a layered DAG (`flow-layout.js`: `computeFlowLayout` + `assignCrossCoords`) — breaks rework cycles, layers by longest-path, reduces crossings, aligns via isotonic regression; parent-child hierarchy forms contiguous **sibling groups** drawn as a bezier fan. Canvas edges are clickable (`flow-graph-render.js`) with type-aware dialogs.

**LLM-assisted authoring.** The **Add role** dialog's **Generate agent prompt** button → `POST /api/agent-prompt/generate` (`resolveGenerationTarget` picks a Model Provider, prefers Sonnet-class, else `.env` fallback; one stateless `/v1/messages` call). Wiring suggestions via `POST /api/agent-ports/suggest` (`port-suggestion.js`, LLM + keyword fallback, user-confirmed). Nothing persisted server-side.

### Webhook Server (`http` triggers)

Second HTTP server on `HOOK_PORT` (default `4003`). External systems trigger with:

```
POST /hooks/:agentId/:hookId
X-Hook-Secret: <trigger.secret>
```

Path must match an existing agent + an `http` trigger with matching `id`. The event is enqueued in `pending-triggers.json` (drained every 5s). **Security:** the secret is validated against `X-Hook-Secret`; secretless triggers are rejected 401 (no global "open" mode). The POST body is ignored — the trigger's `prompt` is what Claude receives.

*Known limitation:* the queue only protects against the **Maintenance Mode flag**. An event delivered while the container/webhook server is genuinely down (crash, redeploy) is **not auto-retried** — but the scheduler writes durable `in-flight-triggers.json` markers before each execution; orphaned markers at next startup trigger a "⚠️ Trigger possibly lost" DM (the human decides). Prefer `github-event` over `http` for anything that must not drop during downtime.

### Maintenance Mode and triggers

While platform-wide Maintenance Mode is active, each scheduler checks `GET /internal/maintenance-mode` before firing: `cron`/`once` inside the window don't fire; `http`/`github-event` keep queuing but stay undrained until maintenance ends; for `cron`, exactly **one** catch-up run executes after the window (never a backlog flood); `once` self-heals on the next 60s tick, `github-event` on poller restart.

### GitHub poller (`github-event` triggers)

`orchestrator/github-poller.js` polls the GitHub Events API every 30s for every repo in some env with a `githubTokenId` — for local stacks with no public ingress (polling replaces webhooks).

- **Repo discovery**: walks all envs, dedupes, picks one token per repo (first env wins); tokenless repos skipped.
- **Bandwidth**: page-1 uses `If-None-Match`; 304s cost no rate budget (~120 conditional GETs/h/repo). **Pagination**: reads further pages on a >100-event burst until an already-seen id / partial page / `MAX_PAGES`, so bursts don't drop events.
- **Cursor**: a per-repo sliding **seen-id set** (`state.seen[]`, `state.json`), not a `created_at` high-water-mark — an event is fresh iff its id is unseen. First poll only baselines. Fan-out oldest-first.
- **History horizon**: each subscriber gated by `effectiveHorizon = activatedAt ?? createdAt ?? triggers.json mtime` + 5-min grace, so a `triggers.json` rewrite doesn't shove it to "now". Derived triggers preserve prior same-id `activatedAt` (`stampDerivedActivation`).
- **Fan-out**: matched events → `pending-triggers.json` (drained every 5s), appended as a fenced JSON block. Event keys `<lowercase_type_without_event>.<action>` (e.g. `pull_request.opened`); bare `push`. The Events API omits some actions (no `pull_request.synchronize`).
- **Identity**: agents share one PAT (same actor for everyone). `gh-as-agent` stamps human-readable attribution (`commit` → author email `<agentId>@agents.local`; `stamp <file>` → `<!-- agent: <id> -->`) but this is **vestigial for delivery** — the poller doesn't read origin.

**Loop protection — frequency only, no source filtering.** A trigger fires on **any** matching event, including self-caused. One frequency backstop: the **conversation throttle** (`_checkAndIncThrottle`) — per `(agent, conversationKey)` sliding window, default 5 events/h (`conversationKey` groups by `pr:42`/`issue:99`/`push:refs/heads/x`). First over-threshold drop enqueues a `kind: "throttle-warning"` (plain DM), then drops silently until reset. Event-type matching, `labelFilter`, horizon are content/recency routing, not source filters. **Burst-cap digest** (`_fanOutBatch`, `planBurstHandoffs`): a group exceeding `BURST_CAP` (default 3) in one poll collapses into a single **lossless** `kind: "github-digest"` entry (plain DM) — the poll-scoped sibling of the hour-scoped throttle.

### BP-event router

Central ingestion endpoint any signaler (today ACE `bp-transition.py`) calls to announce a Briefing Pack change; the orchestrator owns routing. **Endpoint:** `POST /internal/bp-events` (port 4002, internal-only, no auth).

```json
{ "source": "<id>", "events": [ { "type": "bp:revised|bp:completed|bp:input-changed", "bp": "<12-char hex>", "details": {} } ] }
```

**Routing** (`routeBpEvents` + `bp-event-router.js`): build a reverse index `bpId → {stubId, parentOrchestratorId}`; group by hosting orchestrator (unknown BP → `unknown-bp`); force-pull the briefings clone, build the dependency graph via `loadBriefingsGraphFromExplorer()` (bp-explorer's `/api/briefings`); compute affected BPs (**`depends-on` dependents** + **input-artifact dependents** matched output→input path); apply each agent's `bp-trigger-policy`, `enableAgent` (idempotent), append a `bp-event-batch` entry to `pending-triggers.json` (a `kind`-tagged queue entry handled inline by `executeBpEvent`, not a `triggers.json` type). Dedup on `(type, bp)`; best-effort (per-target failures surface in `routed[].error`/`skipped[]`).

**Situation classification** tags each entry from the affected BP's status — each requires an explicit closing question so the chat shows the agent waiting for input:
- `kickoff` — BP `ready`, all `depends-on` `completed`/`reviewed`. Agent posts a 2–3-sentence mission summary + approach, asks for greenlight. No claim/LoopScript/commit before user OK.
- `cascade-stale` — BP already `completed`/`reviewed`/`stale`, possibly invalidated. Agent posts a summary, asks whether to `/confirm-valid` or `/revise`.
- `other` — defensive fallback → cascade-stale prompt.

**`bp-trigger-policy`** (optional, `config.json`): `mode` = `off` / `notify-only` / `notify-on-activate` (default) — `off` ignores; `notify-only` enqueues only when already running; `notify-on-activate` materializes stubs + respawns disabled agents first. `respect-manual-disable` (default `false`) — when `true`, skip activation for a manually-disabled agent.

### BP-instance hand-off (manual)

Every bp-instance chat has a hand-off action to activate downstream agents at end-of-session. Because each agent has its own workspace + repo clones, **git is the only durable bridge** — the dialog enforces this. Opening it fetches candidates (briefings graph) + per-repo git-status; submit is disabled while any repo is dirty/unpushed unless the user opts into an override (checkbox + reason quoted into every target's note). Pre-flight nudge buttons (`POST .../handover/nudge`) post a canned commit/push prompt into the source agent's own DM; **Re-check** refreshes. On submit, `POST .../handover` re-fetches git-status server-side and returns `409 git-not-ready` unless ready or the override carries a reason. For each target it materialize/enables the stub, ensures a DM room, and posts a structured body (source-of-work per repo, input-artifact paths, user note, override reason, consistency warnings, and a "Before you start" checklist).

### Admin Console authentication

The console is gated by a login screen; every `/api/*` data endpoint requires a valid session cookie (`admin-console/api/auth.js` mounts `auth.gate` over `/api`). A single env credential pair (`ADMIN_USERNAME`/`ADMIN_PASSWORD`, default `admin`/`admin`) is checked by `verifyCredentials()` — the **only** seam an SSO/OIDC integration replaces. HMAC-signed HttpOnly cookie (`aee_session`); static assets + SPA fallback stay open.

**Per-user local passwords (interim).** Teams-page users can get a local scrypt password (never returned). Login checks the user store first (`POST /internal/admin/users/verify`), then falls back to the env admin (best-effort — no lock-out if the orchestrator is down). A per-user session's `sub` is the user's `subject`, so audit names the person.

### Admin Console audit trail

Every mutating `/api` request is one append-only JSONL line at `/workspace/audit/audit-<date>.jsonl` (override `AUDIT_DIR`). `admin-console/api/audit.js` `auditMutations` is mounted **before** the auth gate (so it sees denied attempts), logging from `res.on('finish')` (actor from `req.user`): `ts, actor, action, method, resource, teamId, status, outcome, ip`. Best-effort. Read via `GET /api/audit?limit=<n>`. Matrix chat history is intentionally **not** the config-mutation audit log.

### GitHub poller event-transparency log

Separate from the audit trail: answers "what did the poller see and what happened to it". Every **fresh** event (survived seen-id dedup) is recorded — delivered, dropped by a protection layer, folded into a digest, or matched no subscriber. Purely observational. **Writer** `orchestrator/github-event-log.js` (from `_fanOutBatch`): `ts, eventId, repo, event, actor, createdAt, label` + one `outcomes[]` entry per subscriber whose event-type filter matched (`{agentId, triggerId, status: delivered|dropped|digest, reason?}`); `outcomes.length === 0` → `noMatchingTrigger: true`. JSONL at `/workspace/github-event-log/`, best-effort, 7-day retention. **Reader** → `GET /api/github-events` (merges day files newest-first, cap 5000). **UI**: the **GitHub Event Log** page (`/github-events`).

### Team-Setup wizard

`POST /api/teams` (wizard at `/team-setup`) materialises a team-shaped agent group in one atomic-with-rollback transaction on top of the `team`/`team-member` machinery. **Create-only** — growing an existing team happens in the Flow Editor. Steps: **Process → Working Environment → Team → Knowledge (optional) → Review**. It picks an existing env and sends `environmentId` (backend resolves repo/branch/SSH/PAT/MCP); also accepts legacy direct inputs (`repository` + `githubTokenId` + `mcpServers`, auto-creating env id `<teamId>`). Always ships a `processTemplateVersion: 1` bundle; `mode: "extend"` only on an id collision.

**Process step** (`StepProcess.jsx`) produces the bundle three ways: (1) **Use a template** — curated registry (`orchestrator/skill-pool/process-templates/` → `make seed-process-templates` → `GET /api/process-templates`; ships `core-sdlc` + `extended-sdlc`) plus saved drafts; (2) **Compose a process** — stage columns with Scout/Author/Companion slots + custom roles, wired live by the **Flow-Weaver** (`admin-console/api/flow-weaver.js`, `POST /api/process/weave`): a deterministic pure engine that chains stages via human-gated `<prefix>:approved` issue channels, generates intra-stage loops + rework/human-feedback triggers, staggers curation crons, compensates gaps (missing duties merge into the Author) — the woven bundle is **lint-clean**; uses **catalog v2** (`catalog-ports.js`: `patternRole`/`stageAffinity`/`ports` + `intrinsic` filtering); (3) **Start blank** — empty draft → `/flows?proc=draft:<id>`. Inline preview + authoritative lints (`POST /api/flows/graph`); error lints block submission. Exits: **Create team** (`POST /api/teams/stream`, full parity) or **Save as draft**.

**Role templates** live under `/template-workspace/agent-templates/` (from `orchestrator/skill-pool/agent-templates/` via `make seed-templates`). **Deliberately rudimentary**: parameter-free prompts (only weave-time `{{stageName}}`/`{{stagePrefix}}` remain), at most **one** role-specific trigger + a daily self-curation cron (staggered in the 03:00 hour, `intrinsic: true`) pruning `memory/`. 24 roles; sample:

- `business-analyst` (persistent) — `issues.labeled` `req:refine` (intake pair with `issue-triage`)
- `developer` (per-invocation) — wiring from the flow; `code-reviewer`/`security-`/`test-`/`performance-reviewer` — `pull_request.opened/reopened`
- `reworker` — `pull_request.labeled` `revisions-required`; `documentation-sync` — `pull_request.closed` (merged-guard)
- `issue-triage` — `issues.opened`, emits `req:refine`; `dispatcher` — `issues.labeled` `ready`, releases via `dispatch`
- `generic` (persistent) — blank slate, no curation cron

**Materialisation:** one shared env (reused or auto-created id `<teamId>`); one `team` agent id `<teamId>` (`skipFirstMember: true`); one `team-member` per role id `<teamId>-<roleId>` carrying `systemPrompt` (role override), `sessionPolicy: per-invocation`, and a full `triggers.json` (`{{repoFullName}}`/`{{agentId}}` substituted); one DM room per member (best-effort). `skillsOverride` omitted — members inherit the team `skills[]`. On any failure, roll back members → team → env. Members are later editable with Inherit ↔ Custom toggles.

### Direct Messages & Session Log

Each agent runs:

```
claude [--resume <sessionId>] -p <prompt> \
  --output-format stream-json --verbose --permission-mode acceptEdits
```

NDJSON stdout is parsed and written with wrapper events (`message.received`, `claude.invoke`, `message.posted`, `error`, `trigger.fired`) to `/workspace/agents/<agentId>/sessions/<roomId>.jsonl` (schema: `docs/agent-chat-plan.md` §4.1). Every entry carries a `correlationId` (Matrix `event_id`, or `trigger:<id>:<ts>`) tying log rows to chat bubbles.

**Per-room session pinning.** After each successful run the runner writes `session_id` to `<roomId>.current.json`; the next message in that room uses `--resume` (on failure it clears the pointer and retries once). `GET`/`DELETE /api/agents/:agentId/session/:roomId/current` read/drop it; the chat header shows *Reset* / *Reset & lernen*. Snapshots live under `~/.claude/projects/<encoded-cwd>/` (persisted via the `claude-home` volume so `--resume` survives restarts).

**DM heuristic** (`agent-entrypoint.py`): act iff `getJoinedRoomMembers(roomId)` is exactly two (this agent + one other) AND the sender isn't this agent (cached 30s).

### Agent Chat UI

The Admin Console embeds a Matrix client at `/chats` (+ `/chats/:agentId`). Under `admin-console/src/pages/`: `AgentChat.jsx` (top-level) + `agent-chat/` (`AgentList`, `ChatPanel` — backfill/pagination/optimistic-send/SSE tail/session toolbar; `Message` — markdown via `react-markdown` + `remark-gfm` + `rehype-pretty-code` + `rehype-sanitize`; `MessageInput`; `RightRail` — tabbed, toggle `Cmd/Ctrl+Shift+L`; `SessionLogPanel`; `WorkspaceBrowser`) + `hooks/{useSSE,useColorScheme}.js`.

**DM rooms.** First open lazily POSTs `/api/matrix/agents/:id/dm`; server creates/reuses a 1:1 room, invites the admin, persists `dm-room.json`; subsequent loads short-circuit on that file. **Session log rendering**: SSE `/api/agents/:id/session/:roomId/stream` (`since=<byte-offset>` cursor); `correlationId` pairs log rows with bubbles (hover dims non-matching); adjacent `tool_use`/`tool_result` with the same `toolId` fold into one block.

**Workspace browser** (read-only over `/workspace/agents/<agentId>/`): `GET .../workspace/{tree,file,download,image}?path=<rel>` — all reject paths outside the agent root. Reads capped at 512 KB; binary files (NUL in first 8 KB) flagged; raster images (PNG/JPEG/GIF/WebP by magic bytes, SVG excluded) rendered inline via `/image` (no cap).

**Markdown safety.** Sanitized with `rehype-sanitize` (GFM `defaultSchema` + `style`/`data-*` for `rehype-pretty-code`), run *after* pretty-code so highlighting survives. Both Shiki themes shipped; active theme via CSS keyed off `<html data-theme>`.

## Key Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | All four services + volumes |
| `.env` | Secrets: Matrix tokens, LLM proxy URL + auth token (gitignored) |
| `Makefile` | Build/start targets (`up`, `down`, `logs`, `build`, `ps`, `seed-*`) |
| `orchestrator/orchestrator.js` | Backend: agent lifecycle, container spawning, env-aware seeding, internal HTTP API |
| `orchestrator/spawn-container.js` | Spawns/kills the per-agent Podman container over libpod; network + FS SubPath + dedicated-volume isolation |
| `orchestrator/teams-store.js` | Source of truth for the human **Team** data model (pure factory) |
| `orchestrator/skill-grants.js` | Source of truth for the team-owned skill grant (`effectiveSkills`) |
| `orchestrator/prompt-assembly.js` | Pure single source for system-prompt composition (ordering, gating, memory hint) |
| `orchestrator/github-poller.js` | GitHub Events API polling: match, throttle, burst digest, fan-out |
| `orchestrator/setup.sh` | Register the admin Matrix user, print the access token |
| `agent-image/` | Per-agent image `as-agent:latest`; entrypoint `scripts/agent-entrypoint.py` (+ `sase_lib.py`) is the live runtime |
| `admin-console/api/api.js` | Express API: agents, environments, ssh-keys, skills, models, mcp, `POST /api/teams`, agent-templates |
| `admin-console/api/flow-weaver.js` | Deterministic wiring engine: stages + catalog-v2 roles → lint-clean bundle |
| `admin-console/api/process-template.js` | Pure builders/validators for process-template bundles |
| `admin-console/src/pages/{Agents,WorkingEnvironments,TeamSetup,ProcessCanvas}.jsx` | Agent CRUD; env CRUD; the 5-step wizard; the Flows graph/editor (`ProcessGraphPanel`) |

## Commands

```bash
# First-time bootstrap (after `podman compose up -d conduwuit`):
# registers the admin user and prints the access token to add to .env.
./orchestrator/setup.sh

make up           # start / stop / restart the full stack
make down
make restart
make build        # rebuild orchestrator image (= podman compose build orchestrator)
make ps           # container status
make logs         # stream orchestrator + admin-console + conduwuit logs

podman logs -f orchestrator      # per-service logs
podman logs -f admin-console
podman logs -f conduwuit
```

## Conduwuit Admin

Matrix users are managed via the Conduwuit admin room (`!cUxr0SyfINf9yEvBOD:local`); the orchestrator automates creation when adding agents. `!admin users list` / `create-user <name> <password>` / `deactivate @user:local`.

## Skills

Skills live in the skill-pool volume (`vgh-claw_claude-workspace`) under `skills/<name>/SKILL.md`, granted per **agent construct** (team `skills[]` / standalone `skills[]` / member `skillsOverride`) via the Agents page, the wizard's Knowledge step, or the Knowledge page. Environments have **no** skill picker. Intended domain: **Mainframe Migration** (COBOL, JCL, DB2, IMS/VSAM).

### Two-tier skill pool

Resolved **team-first then global** at seeding. **Global**: `/template-workspace/skills/` (orchestrator RO) = `/pool/skills/` (admin-console RW), System-Admin-managed, all teams. **Team**: `/workspace/teams/<teamId>/skills/` (RW), Team-Admin-managed, that team only. `orchestrator/skill-source.js` (`makeSkillSourceResolver`) copies each grant name from the team's pool when present, else global. `/api/skills` tags `source` = `pool`/`team`/`agent`; `POST /api/skills/promote-to-global` lifts a team skill into the global pool.

### Knowledge digest (guaranteed context injection)

Part of the memory/knowledge unification (`docs/memory-knowledge-unification-concept.md`). Every KB-provisioned agent carries a generated **`knowledge-digest.md`** at its workspace root, `@`-imported by the seeded CLAUDE.md — so team conventions, converged (learned ≥2×) and recent lessons are **guaranteed in context at session start**; `knowledge search` is the long-tail complement. Deterministic (no LLM), ~3k-token budget, built by one pure module kept byte-identical on two sides: `orchestrator/knowledge-digest.js` ↔ `build_knowledge_digest()` in `agent-entrypoint.py` (golden fixture `knowledge-digest.fixture.json`; change both in one commit). Runtime rebuilds pre-invocation; `refreshKnowledgeClone` fans out post-KB-change. The `@`-import is gated (`knowledgeDigestRef`) on a provisioned checkout, so autonomy-0/KB-less agents see nothing.

**Semantic rerouting.** `agentKnowledgeDigestRef(id, env)` (autonomy ≥ 1 + provisioned checkout ≡ `_memory_model_unified()`) flips the digest import, swaps the Memory System section to the unified variant (episodic `context.md`/`log.md`/`users.md`; `facts.md`/`entities.md` read-only legacy — new semantic knowledge goes to `knowledge add`), and selects the unified memory hint. The legacy five-file model is the autonomy-0/KB-less/blueprint fallback. `users.md` is personal data — never shared, never migrated.

**Migration.** One-shot per unified agent (`migrateAgentMemoryToKb`, `orchestrator/memory-migration.js`): legacy `facts.md`/`entities.md` → KB entries in a dedicated shard `<kind>/shards/<agentId>.migrated.jsonl` (never the agent's own — avoids a two-writer race), committed+pushed; only after the push are files archived to `memory/_archive/`. **"in digest" indicator**: `buildKnowledgeDigest` returns `includedIds`; `GET /internal/teams/:teamId/knowledge/digest-status`; the Knowledge tab renders a green `digest` badge.

## MCP Servers (operator notes)

Reference servers ship under `mcp-servers/<id>/`; `make seed-mcp-servers` (chained from `make seed-pool`) syncs them to `/template-workspace/mcp-servers/`. Add a backend by: (1) drop a single-file MCP (stdio or http) under `mcp-servers/<id>/`, (2) `make seed-mcp-servers`, (3) register via the **MCP Servers** admin page + bind a credential + attach to environments. The `wiki/` reference server is tiny and dependency-free — clone it as a starting point.
