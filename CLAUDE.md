# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

> High-level map. Deep specs live under `docs/`; ticket-level history lives in git.

## Project Overview

**agent-studio** is a local Matrix-to-Claude-Code stack for an enterprise context. It provides chat-based AI agents extensible with domain-specific skills for **Mainframe Migration** (COBOL, JCL, DB2, IMS, etc.).

The stack runs locally with Podman as a single compose file: **Conduwuit** (Matrix homeserver); **Orchestrator** (control-plane, spawns/manages one container per agent, no Matrix identity); **Admin Console** (web UI on `:4000` for agents, environments, SSH keys, skills, etc.; embeds a chat UI at `/chats/:agentId`); **bp-explorer** (read-only viewer for ACE BriefingPack metadata).

The LLM backend is reached via an Anthropic-compatible proxy: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` in `.env` (gitignored). Default Sonnet/Haiku models set there too.

**Model Provider auth types.** A registered Model Provider (`/workspace/llm-endpoints/index.json`, tokens in `_keys/` at 0600) carries an `authType`: default **`api-key`** (Bearer against `baseUrl`) or **`oauth-token`** (Claude *subscription* auth via `claude setup-token`). For `oauth-token` the orchestrator injects `CLAUDE_CODE_OAUTH_TOKEN` and strips `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` so the CLI talks directly to `api.anthropic.com`. The login flow runs server-side under a PTY (`orchestrator/llm-auth-flow.js`, `/api/llm-auth/flows/*`); the token is claimed server-side, never reaching the browser. **Compliance:** consumer-subscription OAuth tokens are single-user only (Anthropic Consumer Terms) — creating/re-keying one requires a single-user confirmation recorded as `complianceAck`. One-shot server-side generation (`resolveAssistTarget`) skips `oauth-token` providers.

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
- **Conditional gating.** Git/`gh-as-agent` only when the env has a repo; Trigger-management + unattended framing only for **autonomous** agents (`agentIsAutonomous()`: `sessionPolicy: per-invocation`, `orchestrator`/`bp-instance`, or already has triggers); Skills only when the grant is non-empty. Adding/removing a trigger via the Flow Editor (`PUT/POST/DELETE /api/agents/:id/triggers`) that flips `agentIsAutonomous()` rebuilds + reseeds CLAUDE.md immediately (#962, `reconcileAgentAutonomyPrompt`); a no-op edit that doesn't change the autonomy state never rebuilds.
- **Runtime hint.** `buildMemoryHint(blueprintId)` is **byte-identical** to `_build_memory_hint()` in `agent-entrypoint.py` (test-asserted; change both in one commit).
- **Preview.** `GET /api/agents/:id/prompt-preview` renders `claudeMd` + `appendSystemPrompt` + gating `meta`, shown read-only as the **Prompt** tab (`PromptPreviewPanel.jsx`). Badge labels and tooltips live in the pure, unit-tested `prompt-badges.js` module (per #651 convention); the tab also shows a read-only **SettingList** for `sessionPolicy` and autonomy — the two behaviour-shaping settings not surfaced elsewhere on the Agents page. The `blueprintInstance` pill renders as **"from template"** (the bare internal token is never shown).

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
- `orchestrator` — bound to a BriefingPack dir (`briefingsPath`). On creation and each ~30s claim tick it pulls main (60s-throttled), scans the dir, writes one stub `bp-instance` per BP. On a BP → `status: dispatched` it DMs a suggestion; on user confirmation it `curl`s `/internal/agents/:id/claim` (patches `brief.md`, commits+pushes, materialises the bp-instance). Manual Activate / Reset to stub bypasses the suggest flow.
- `bp-instance` — one per Briefing Pack under an orchestrator. A stub (no Matrix user, no workspace) until claimed/activated; bound to one BP, uses the ACE engineering skill to execute its LoopScript.

> **Legacy roles.** `expert`/`expert-group`/`expert-instance` → `agent`/`team`/`team-member` (and `parentGroupId` → `parentTeamId`) on startup and on read.

### Autonomous Agent Triggers

Triggers live in a per-agent `/workspace/agents/<id>/triggers.json`; the scheduler syncs every 60s (`node-cron`). **Self-managed** (the agent can edit its own), **file-based sync**, **per-trigger overlap protection** (a still-running trigger skips the next tick), and **agent-wide serialization** (#1157): an agent has one workspace, so at most one workspace-touching run — a loop iteration, any trigger, or a chat/DM turn — executes at a time. All three paths pass through one `WorkspaceGate` (`agent-entrypoint.py`); while a loop runs it holds the workspace across **all** its iterations and every other trigger and chat message queues (FIFO) until the whole loop ends (completion or user Stop). The pending-drain pauses while a loop is active so `http`/`github-event` work stays durably queued; chat backlog is bounded (`AEE_MAX_QUEUED_CHAT`, default 8); Stop stays out-of-band.

- `cron` (`cron`, 5-field) — recurring. `once` (`at`, ISO) — one-shot, auto-removed after execution.
- `http` (`secret`, auto-gen) — fired by external HTTP POST (see Webhook Server).
- `github-event` (`repo` `owner/name`, `events` e.g. `pull_request.opened`, optional exact-match `labelFilter`, optional `claim: {remove, add}`) — fired by the GitHub poller. **No source/origin filtering** — fires on any matching event regardless of cause. Agent gets the `prompt` + full event payload as JSON. **`claim` field (#957/#958):** when set, the runner mechanically swaps the wake label for a claim label (`remove` → `add`, e.g. `"ready"` → `"ready:wip"`) after the preCheck gate and before the Claude invoke — making work-in-progress visible on GitHub. On a **successful** completion the claim is swapped forward `<wake>:wip` → `<wake>:completed` (#1163), so a finished run stops looking in-progress — the three states (`ready` / `ready:wip` / `ready:completed`) stay visibly distinct. On final double-failure the swap is instead rolled back (`add` → `remove`), which re-emits a fresh `issues.labeled` event and restarts the chain automatically; a user-aborted run keeps its `:wip` (no completed swap, no rollback). A claim label missing in the repo (`gh` doesn't auto-create labels) is created on the fly and the swap retried once (the `:completed` label auto-creates green, distinct from the `:wip` amber). Best-effort — a failed swap is logged and never gates the run. **Convention enforced:** `add` must equal `<labelFilter>:wip` (the bundle validator rejects anything else so Layer-3 reconciliation can always derive the claim label). Channel-derived label listeners get their claim auto-stamped by `expandGithubChannels`; set `autoClaim: false` on the channel port to opt out. **`transport: 'internal'` (#1173):** the listener is excluded from the poller plan (`pollerSubscribes`) and woken directly by `POST /internal/flow-emit` (producer CLI `aee-emit`) — enqueue first, then the label is mirrored onto GitHub as decoration-only status; the plan exclusion is the single dedup mechanism. Payload is synthesized in poller shape, so prompts/claim-swap/anomaly detector work unchanged; throttle/burst layers don't apply. Human gates and PR-anchored triggers stay poller-delivered. Authored via the **Delivery** selector on label-edge dialogs (Flow Editor) and — on an existing listener — the shared `TriggerForm` (Flow-Editor Inputs-row edit + Agent-Chat trigger editor, #1189, gated to label listeners, hidden for human gates); `transport` round-trips through the bundle (export/materialise/Edit-as-draft), rides on graph edges (dotted stroke), and flips the producer's Outcomes-block instruction to `aee-emit`. **Labelled PR/issue channels (#1194):** a labelled, non-human channel port may also carry `transport: 'internal'` (Delivery control on `EditChannelDialog` + the Routing → Inputs channel row) — its derived `<artifact>.labeled` listener is stamped internal by `expandGithubChannels` when **every** channel consolidating onto that `(artifact,label)` listener opted in (all-or-nothing, so a lone poller producer isn't dropped by the plan exclusion). Unlabelled channels (`*.opened` — artifact creation) and human gates stay poller-delivered. **Defaults (#1175):** the Flow-Weaver weaves every generated intra-stage label listener internal (stage-gate channels stay poller-delivered); the curated SDLC templates ship their agent→agent listeners internal; the advisory `internal-channel-candidate` info lint suggests the toggle on remaining poller-delivered agent→agent hand-offs; the anomaly detector's `wake-not-claimed` message is transport-aware (internal = durable queue, so it points at the consumer, not a lost event). Concept: `docs/internal-channels-concept.md`.
- `loop` — **re-arms on completion** (chains, not wall-clock): fires an iteration, then arms the next when it returns (`_loop_runner`, sibling of `_cron_runner`). Fresh context per iteration (defaults to `sessionPolicy: per-invocation`). **Stop contract**: `maxIterations` (**required**, positive int) → `exhausted`; `until.command` exit `0` → `done`; optional `maxTokens` → `exhausted`; the #611 runaway backstop → `paused`. Optional `verify` is a *separate* gate — one of `{command}` / `{agentId}` / `{flow:true}` / `{selfGraded:true}` — that must pass for an iteration to count; `{flow:true}` skips the inline gate and delegates to the flow's wired downstream QS chain (use when the loop starts a review pipeline — same reviewer won't check twice); empty/self-graded `verify` on a team agent is re-filled with a sibling reviewer role (`_resolve_loop_verify`), so an agent never silently grades its own work. Validated by `_validate_loop_trigger`; concept: `docs/loop-triggers-concept.md` §4. Agent-facing docs are injected via the Trigger-management block (`orchestrator/prompt-assembly.js`). A user **Stop** ends the loop as `stopped`; on any terminal outcome the terminal-outcome message carries a structured `io.aee.loop-record` payload (config + outcome), rendered in Agent Chat as a persistent, re-runnable finished-loop card with a "Start again" button (#1231).

Results post to `trigger.roomId` if set, else the agent's DM room. If no room exists yet the run is **skipped**. `[PASS]` suppresses output.

**Session policy.** With `sessionPolicy: per-invocation`, *triggered* runs start fresh (no `--resume`) and don't write the session pointer — DM continuity is untouched; the trigger prompt gets a learn-hint to extract lessons into `memory/log.md` first. Absent = `persistent` (legacy).

### Process Canvas / Flows (orchestration graph)

Agents + their triggers form an **orchestration graph**, authored in the **Flows** view (`/flows`, `Briefings.jsx`). **One wiring vocabulary everywhere** (#1009, concept §4.6): Input · Outcome · Action · Artifact · Consumer · Reviewer · Gate · Brake; the trigger prompt has exactly one user-facing name — **"Wake instruction — what the consumer is told"** — across edge dialogs, the chat-rail TriggersPanel and lint texts (retired: "Listener prompt", "Wake prompt override", bare "Prompt", "Connection", emit/listen phrasing). The graph/editor is the `ProcessGraphPanel` export in `ProcessCanvas.jsx`, driven by a `scope` prop (`'<teamId>' | 'draft:<id>' | 'import'`). The Flows left list selects scope: **Teams** (live graphs), **Drafts**, legacy **BriefingPack flows**. `/process` routes redirect to `/flows`.

**Process Canvas lives inside Flows.** The Process Canvas is not a standalone page anymore — it is embedded in the **Flows** view (`/flows`, `admin-console/src/pages/Briefings.jsx`). The old scope dropdown is gone; scope selection moved to the Flows left list, which lists **Teams** (live process graphs), **Drafts**, the read-only **Role-templates** blueprint, and the legacy **BriefingPack flows** (Orchestrator agents → `BPGraph`). A **New process** button there creates a draft. The graph/editor itself is the named export `ProcessGraphPanel` in `admin-console/src/pages/ProcessCanvas.jsx` — a controlled component driven by a `scope` prop (`'all' | '<teamId>' | 'templates' | 'draft:<id>'`) with `onNavigate` / `onDraftsChanged` callbacks. Flows tracks the selected process scope in the `?proc=` query param and BriefingPack flows in `?flow=`. The last-selected flow is persisted per user in `localStorage` under `flows.lastSelected.<username>` and restored automatically on return — stale or deleted flows fall back silently to empty selection; the transient `import` scope is never persisted. Mirrors the `agentChat.lastAgentId` pattern in Agent Chat. The `/process` and `/process/:teamId` routes now redirect to `/flows` (the latter with `?proc=<teamId>`); there is no longer a "Process Canvas" nav entry.

**Declarative ports are the single source of truth** for edges (siblings on a role/agent config, edited via `ConnectionsSection.jsx`, persisted via `PUT /api/agents/:id`): `emits: string[]` (label tokens the work sets — declarative only, the agent still sets the label at runtime; draws "agent → label → listening trigger"); `dataFlow.{dependsOn,inputs,outputs}` (live) ≡ role `dependsOn/inputs/outputs` (draft) — dependency/data-flow edges; `github: {producesPr?, producesIssue?}` (what a role opens — drives badges/ports + an "open a PR/issue" prompt block); `channels: [{artifact: 'pr'|'issue', from, label?, gate?, autoClaim?}]` on the *consumer* (which producer's PR/issue it reacts to; `gate: 'human'` = inline approval gate; labelled channels auto-derive a `claim` for their listener — set `autoClaim: false` on a port to opt out); `parentMemberId` ≡ role `parent` (cycle-guarded); `stage`.

**Functional triggers are derived from ports, not authored.** A draft derives them at materialise (`expandDataFlowSteps`, `expandGithubChannels`); a live team re-derives on every port write (`reconcileTeamDataFlow`, `reconcileTeamGithubChannels`) — regenerating `<consumer>-on-push-<upstream>` / `<consumer>-on-<artifact>-<producer>` triggers (marked `dataFlow`/`channel: true`), leaving hand-authored ones untouched. **A human-approval gate** is a label listener on a downstream step whose label is flagged `humanGate` in the bundle's `labels[]` registry (or gated by a channel's `gate: 'human'`) — the red gate node; never trips `gate-violation` since no agent emits it. Gate-ness is **configuration, not a naming convention** (#928): the old `human:*` prefix and the hardcoded `hold`/`needs:human` brakes carry no meaning of their own.

**Graph endpoint.** `GET /api/process/graph` (or `POST {processTemplate}`) → `{ level, team, nodes, edges, gates, labels, humanTouchpoints, lints }`. Edge `S→T` labelled `L` exists when `S` emits `L` and a `T` trigger listens via `labelFilter`. Raw GitHub-event triggers (no `labelFilter`) are `external: true`; gate/brake labels and `cron`/`once` self-loop `timer` edges originate from `null`. **Gate/brake classification reads config flags, never the label name** (#928): `labels[].humanGate` / `labels[].brake` from the bundle registry (a live team keeps it on the team agent, like `stages`) plus `channels[].gate: 'human'` — threaded into the builders as `{ labels }`. A `humanGate` label may not be agent-set (`gate-violation`); a `brake` label pauses the loop and *may* be agent-set. **Named human roles (#987, supersedes the #981 `@human` hub):** the generic `@human` actor is GONE — a person is never an anonymous hub, only a **named** `kind: 'human'` flow node. An optional `humans: [{ id, name, description?, stage?, emits?, consumes? }]` registry (persisted on the team agent like `stages`/`labels`, threaded into the builders as `{ humans }`, round-tripped through export/materialise/Edit-as-draft) declares them — purely declarative (no agent, no trigger; `triggers.json` stays byte-identical). A human's `emits` label is *implicitly a gate* (an agent emitting it → `gate-violation`); its `consumes` (`{label}` brake **or** plain delivery (notification when the label is set, no blocking — flag-based: `brake: true` in registry = brake, else delivery) · `{artifact:'pr'|'issue',from}` PR/issue review · `{artifact:'file',name}` output read) bind the gate/brake/delivery edges to that named node (first match in `humans[]` order wins; two emitters draw both edges), suppressing `producer-unconsumed`/`unconsumed-output`. A gate/brake/delivery with **no** human role wired stays UNBOUND — its edge endpoint is `null` (the renderer drops it, no hub box) and it raises an advisory `info` lint (`unbound-gate`/`unbound-brake`/`unbound-delivery`); it still lists as an unassigned `humanTouchpoint`. Bound touchpoints carry `role: <humanId>`. Wired by drag&drop (agent → human box = delivery to `consumes`; human box → agent = gate to `emits` + a listener trigger; the human-aware `CreateEdgeDialog` branches on node `kind` so a person is never mis-wired as a GitHub channel on a role) or via the Routing tab's **human-role delivery picker** (replaced the #981 "a person consumes this" audience checkbox); roles are created in the Flow-Editor **Add human** panel + the human NodeInspector (`PUT /api/agents/:teamId {humans}`, team-agent only). `lints` (advisory, never blocks): `orphan-listener`, `dead-end-emitter`, `competing-stage`, `producer-unconsumed`, `channel-from-non-producer`, `unbound-gate`/`unbound-brake`/`unbound-delivery` (info — a human touchpoint with no named role wired), `unclaimed-listener` (info — label listener has no `claim`; stall indistinguishable from a missed wake), `gate-violation` (error). Levels: **live** (`?team=<id>`) reads persisted `emits`; **template** (`?templates=...`) reads role-template `emits` (raw `{{var}}`). Pure builders: `process-graph.js` + `unified-graph.js`.

**Flow-anomaly endpoint.** `GET /api/teams/:teamId/flow-anomalies` (proxy to `GET /internal/teams/:teamId/flow-anomalies`) sweeps open GitHub label/timeline state + control-plane session state and feeds them to the pure detector (`orchestrator/flow-anomaly-detector.js`). Returns `{ teamId, generatedAt, thresholds, repos, model, anomalies, errors? }` — `anomalies` is a deduplicated, ranked list of `{ class, severity, objectId, agentId, ageMs, message, evidence }`. **Observe-only; skipped during maintenance mode.** Four anomaly classes (concept `docs/flow-reconciliation-concept.md` §4.1): `wake-not-claimed` (warn), `claim-stalled` (warn), `output-missing` (warn), `gate-idle` (info). A fetch/read failure degrades to a partial result with `errors[]`, never a 500. **Per-team threshold overrides:** `anomalyThresholds: { wakeNotClaimedMs?, claimStalledMs?, gateIdleMs? }` on the team-agent config; defaults T₁ = 15 min, T₂ = 2 h, T₃ = 24 h. **UI:** the **Anomalies** toolbar button (live team scope only) opens `FlowAnomaliesPanel.jsx` (side panel; Refresh re-sweeps); affected canvas nodes carry a count badge. No repair — that is Phase 4. **Scheduled persistence (#1221, hill-climbing loop Phase 1):** the on-demand endpoint computes and discards; a separate hourly orchestrator timer (`orchestrator/anomaly-history.js`, maintenance-gated, best-effort) re-runs the same sweep per Agent Team and appends one JSONL line (`ts`, `count`, `anomalies`, `errors`) to `/workspace/teams/<teamId>/hill-climb/anomaly-history.jsonl` — a shared substrate for recurrence detection and the flow-reconciliation Phase-4 responder's "third sighting" ladder. Line-based retention (default 90 days, `HILL_CLIMB_ANOMALY_RETENTION_DAYS`); a team with no repos/tokens writes no file.

**Hill-climb metrics collector (#1222, hill-climbing loop Phase 1).** A per-team run-metrics pass that folds the team's log surfaces (member session JSONLs, usage spool, #1221's `anomaly-history.jsonl`, the event-transparency log, audit / `.aee/prompt-history.json` version boundaries) into the §4 observational catalog — run success rate (excl. `[PASS]`), rework ratio, time-to-done p50/p90, anomaly recurrence, waste (failed/aborted/`[PASS]` tokens, throttle drops, digest folds), dead config (zero-fire triggers, unconsumed emits) — keyed by `(agentId, triggerId)` and rolled up per config version so a later phase can measure a change across the boundary. The deterministic core is pure + golden-fixture tested (`orchestrator/hill-climb-metrics.js` + the I/O-shaping adapter `orchestrator/hill-climb-sweep.js`, siblings of `flow-anomaly-detector.js`/`flow-anomaly-sweep.js`); `computeTeamHillClimbMetrics` in `orchestrator.js` is the thin fs adapter. **Observational only** (no LLM, no quality scores); below `minRunsPerWindow` the snapshot is honestly flagged `insufficientData` and the ratio metrics are nulled. A **daily** orchestrator timer (`HILL_CLIMB_METRICS_INTERVAL_MS`, maintenance-gated, overlap-guarded, best-effort) persists a day-keyed snapshot `/workspace/teams/<teamId>/hill-climb/metrics/<date>.json` (same-day re-run overwrites). **Endpoints:** `GET /api/teams/:teamId/hill-climb/metrics` (latest snapshot, read-only) + `POST .../hill-climb/run` (manual pass — same code path as the timer, behind a per-team single-flight lock → `409 pass-running`), both proxying `/internal/teams/:teamId/hill-climb/*` behind team scoping + audit. **Config:** `hillClimb: { cron?, windowDays? (default 7), minRunsPerWindow? (default 20), excludeAgents? }` on the team agent, round-tripped through export/materialise/Edit-as-draft like `stages`/`labels` (`normalizeHillClimb` strips everything but the config keys, so applied-card/snapshot state never travels). Concept: `docs/hill-climbing-agent-concept.md` §3.1/§4/§7.

**Improvement cards — analyst + store (#1224, hill-climbing loop Phase 2).** The pass now also raises **improvement cards** (proposals only — nothing in this phase mutates config). The pure card core is `orchestrator/hill-climb-cards.js` (in the `process-template.js` discipline): `validateCard` (schema-enforces a mandatory `targetMetric` + non-empty `evidence` — the closed-loop invariant), `heuristicFindings` (deterministic cards from the snapshot: zero-fire triggers, unconsumed emits, recurring anomalies), `mergeCards` (budget `maxCardsPerPass` default 5 + one-open-card-per-`(object,class)` dedup-bump + one-window cooldown after an applied change + dismissed-suppression), and `buildAnalystDigest`/`redactSecrets` (the secret-free digest handed to the analyst). `runHillClimbPass` folds the heuristic cards into `/workspace/teams/<teamId>/hill-climb/cards.json` on **every** pass (concept's honest fallback) and returns the digest. The **analyst** is a server-side one-shot LLM call in the console (`admin-console/api/hill-climb-analyst.js` + `resolveAssistTarget`, skips oauth-token providers, mirrors `port-suggestion.js`): the `POST /api/teams/:id/hill-climb/run` route runs it over the digest when `hillClimb.autonomy >= 1` and a provider resolves, then POSTs the parsed cards to `POST /internal/teams/:id/hill-climb/cards/merge`, which **re-validates** every one through `validateCard` (the store is the authority — the analyst is untrusted) and merges under the budget rules; no provider / LLM failure leaves the heuristic cards standing. **Endpoints:** `GET /api/teams/:id/hill-climb/cards` + `POST .../cards/:cardId/dismiss` (proxy `/internal/...`). **Config adds** `hillClimb: { autonomy? (0–2; default 2, 0 = collector-only no cards), maxCardsPerPass? (default 5) }`, round-tripped like the Phase-1 keys. No apply path runs yet (that is #1225). Concept: `docs/hill-climbing-agent-concept.md` §3.2/§5/§7.
**Improvements panel (#1223, hill-climbing loop Phase 1).** The **Improvements** toolbar button (`TrendingUp` icon, live team scope only, inside the `isTeamScope && !imported` block alongside **Anomalies**) opens `ImprovementsPanel.jsx` (side panel; mirrors `FlowAnomaliesPanel.jsx` structurally). Renders the §4 metric-catalog tiles from the latest snapshot (`GET /api/teams/:teamId/hill-climb/metrics`) as a 2-column grid: three ratio tiles (run success rate, rework ratio, time-to-done p50/p90) render an explicit **Insufficient data** label below `minRunsPerWindow`; three counting tiles (anomaly recurrence, waste, dead config) always render. **Run now** (`POST .../hill-climb/run`) updates the panel from the response without a reload; a 409 pass-running or `{ maintenance: true }` response is surfaced as a distinct inline notice rather than an error. Clean empty state when no snapshot exists yet. Pure view helpers in `admin-console/src/pages/process/hill-climb-view.js` (dependency-free, `node --test` covered; mirrors `flow-anomalies-view.js`). Phase 1 measure-only: no improvement cards here — those land with #1224. Concept: `docs/hill-climbing-agent-concept.md` §4/§7.

**Artifacts** are matched by **logical name** (`{name, hint?, description?}`, `artifactKey` in `process-template.js`), not physical path, since a re-instantiable agent writes to a varying path. Real location is resolved at runtime from a git-committed manifest `.aee/artifacts.jsonl`: the producer records with `aee-artifact add "<name>" <path>` (CLI `agent-image/scripts/aee-artifact`) + commits/pushes; the derived trigger tells the consumer to `git pull` and `aee-artifact path "<name>"`. A **wake, not a start-gate** — nothing blocks a downstream agent (agents have no "completed" state; that gating is BP-only).

**Drafts** are editable bundles that exist before materialisation. CRUD `/api/process/drafts[/:id]`, persisted at `/workspace/process-drafts/<id>.json` (empty `roles` allowed). Draft mode edits in place via a write-target adapter (`edit-adapters.js`) routing shared dialogs to `liveOps` (HTTP to running agents) or `makeDraftOps` (mutate bundle + PUT); `liveOps` writes only ports, so it's shape-compatible — the editor never branches on mode.

**Templates & round-trip.** `GET /api/process/template?team=<id>` exports a portable `processTemplateVersion: 1` bundle (roles, `emits`, triggers, gates, labels, `stages` — no repos/secrets); materialising feeds it to `POST /api/teams`. **Edit as draft** seeds a draft with the team's bundle + `sourceTeamId` (defaults `mode: extend`). Format: `docs/process-template-format.md`.

**Stages** partition the flow axis: each node has an optional `stage` (inherits from parent via `effectiveStage`); an ordered `stages: string[]` on the bundle/team-agent defines column blocks. Authored via `StageManager.jsx`; carried through materialisation and round-tripped by Edit-as-draft. **Layout** is a layered DAG (`flow-layout.js`: `computeFlowLayout` + `assignCrossCoords`) — breaks rework cycles, layers by longest-path, reduces crossings, aligns via isotonic regression; parent-child hierarchy forms contiguous **sibling groups** drawn as a bezier fan. Canvas edges are clickable (`flow-graph-render.js`) with type-aware dialogs.

**LLM-assisted authoring.** The **Add role** dialog's **Generate agent prompt** button → `POST /api/agent-prompt/generate` (`resolveAssistTarget` enforces the caller's header selection against team visibility — 403/400 when the provider is not permitted / unselected — else the `.env` fallback in bootstrap installs; one stateless `/v1/messages` call). Wiring suggestions via `POST /api/agent-ports/suggest` (`port-suggestion.js`, LLM + keyword fallback, user-confirmed). Nothing persisted server-side. **Autonomous synthesis** (curator auto-promotion `autoPromoteStep`, skill distillation `autoExtendStep`) runs with no user session, so the per-user header selection cannot apply; the optional team-agent field `assistLlmEndpointId` names the provider these calls bill against (`orchestrator/assist-binding.js` — `pickAssistEndpoint`, non-oauth, team-scoped; `resolveAssistBindingForTeam` resolves `{baseUrl,token,model}`; unset → `.env` as before). Configured in the **Knowledge page's ConfigurePanel** (`KnowledgeFlow.jsx`), Team-Admin-gated. **Knowledge-domain bootstrap** (`POST /api/knowledge/domains {op:'bootstrap'}`) is user-triggered, so it uses the caller's header selection instead: ids forwarded through the console proxy (`resolveAssistTarget` — same 403/400 enforcement as the nine Family-A routes), token resolved locally in the orchestrator (`resolveAssistBindingFromSelection`); unset/unusable falls back to `.env`. Concept: `docs/assist-model-selection-concept.md` §4.6.

**Assist Model Selector (#1212).** A **`<Provider> · <model>`** button in the Shell header right-cluster (left of the theme toggle) lets the logged-in user pick which Model Provider every assist call bills against. `ModelSelectionProvider` (`src/context/ModelSelectionContext.jsx`, inside `AuthProvider`) loads `GET /api/assist/model-options` after auth, validates any stored selection against it, auto-selects when exactly one provider is available, and persists the choice per user at `localStorage assistModel.<username>`. States: attention styling when ≥ 2 providers but none picked; auto-selected (no attention) with exactly one; read-only "Built-in (.env)" chip when zero providers + env fallback active; "No assist model available" chip otherwise. `apiCall()` (`src/hooks/useApi.js`) injects `X-Assist-Model: <endpointId>:<modelId>` on every request via `assistHeaders()` from `src/context/assist-transport.js`; the two copilot NDJSON streams (`FlowCopilotPanel.jsx`, `StepProcess.jsx`) add the header explicitly; `KnowledgeFlow.jsx` / `SkillsRegistry.jsx` raw-fetch call sites go through an `assistFetch()` wrapper — covering all nine Family-A assist routes. Error nudge: 400 `assist-model-not-selected` / 403 `assist-endpoint-not-permitted` from any assist call opens the picker (403 also drops the stored selection and refetches options). Server-side enforcement (replacing `resolveGenerationTarget` with `resolveAssistTarget` on the nine routes) ships in #1211. Concept: `docs/assist-model-selection-concept.md` §4.3–§4.5.

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

The console is gated by a login screen; every `/api/*` data endpoint requires a valid session cookie (`admin-console/api/auth.js` mounts `auth.gate` over `/api`). A single env credential pair (`ADMIN_USERNAME`/`ADMIN_PASSWORD`, default `admin`/`admin`) is checked by `verifyCredentials()` — the **only** seam an SSO/OIDC integration replaces. HMAC-signed HttpOnly cookie (`aee_session`); static assets + SPA fallback stay open. **IAP SSO bridge (hosted GKE stack):** when `IAP_AUDIENCE` is set, a session-less request may instead authenticate via its Google-IAP-signed JWT (`x-goog-iap-jwt-assertion` — ES256-verified against Google's JWKS and audience-pinned in `admin-console/api/iap-auth.js`; the spoofable plain e-mail header is never trusted); a normal session is issued for the JWT's `email`, so the login form never appears behind IAP. Unset (compose/kind) → bridge inert, password login only.

**Per-user local passwords (interim).** Teams-page users can get a local scrypt password (never returned). Login checks the user store first (`POST /internal/admin/users/verify`), then falls back to the env admin (best-effort — no lock-out if the orchestrator is down). A per-user session's `sub` is the user's `subject`, so audit names the person.

### Admin Console audit trail

Every mutating `/api` request is one append-only JSONL line at `/workspace/audit/audit-<date>.jsonl` (override `AUDIT_DIR`). `admin-console/api/audit.js` `auditMutations` is mounted **before** the auth gate (so it sees denied attempts), logging from `res.on('finish')` (actor from `req.user`): `ts, actor, action, method, resource, teamId, status, outcome, ip`. Best-effort. Read via `GET /api/audit?limit=<n>`. Matrix chat history is intentionally **not** the config-mutation audit log.

### GitHub poller event-transparency log

Separate from the audit trail: answers "what did the poller see and what happened to it". Every **fresh** event (survived seen-id dedup) is recorded — delivered, dropped by a protection layer, folded into a digest, or matched no subscriber. Purely observational. **Writer** `orchestrator/github-event-log.js` (from `_fanOutBatch`): `ts, eventId, repo, event, actor, createdAt, label` + one `outcomes[]` entry per subscriber whose event-type filter matched (`{agentId, triggerId, status: delivered|dropped|digest, reason?}`); `outcomes.length === 0` → `noMatchingTrigger: true`. JSONL at `/workspace/github-event-log/`, best-effort, 7-day retention. **Reader** → `GET /api/github-events` (merges day files newest-first, cap 5000). **UI**: the **GitHub Event Log** page (`/github-events`).

### Agent Team Wizard

`POST /api/teams` (wizard at `/team-setup`) materialises a team-shaped agent group in one atomic-with-rollback transaction on top of the `team`/`team-member` machinery. **Create-only** — growing an existing team happens in the Flow Editor. Steps: **Process → Working Environment → Team → Knowledge (optional) → Review**. It picks an existing env and sends `environmentId` (backend resolves repo/branch/SSH/PAT/MCP); also accepts legacy direct inputs (`repository` + `githubTokenId` + `mcpServers`, auto-creating env id `<teamId>`). Always ships a `processTemplateVersion: 1` bundle; `mode: "extend"` only on an id collision. Accepts optional `labelSuffix` (`[a-z0-9]{1,8}`) — stamps every label token (trigger `labelFilter`, channel `label`, `setLabel` actions, bundle label registry, prompt text) before agents are created, so parallel teams sharing one GitHub repo don't cross-trigger each other. `GET /api/teams/suggest-suffix` returns a random 4-char suggestion. Extend-mode enforces that the suffix matches the stored one.

**Process step** (`StepProcess.jsx`) produces the bundle three ways: (1) **Use a template** — curated registry (`orchestrator/skill-pool/process-templates/` → `make seed-process-templates` → `GET /api/process-templates`; ships `core-sdlc` + `extended-sdlc`) plus saved drafts; (2) **Describe the flow** — a plain-language description of roles/hand-offs/gates fed to the Flow Copilot (`POST /api/process/copilot`, #1070 — the same endpoint the Flows editor panel uses), which generates a validated bundle reviewed inline; (3) **Start blank** — empty draft → `/flows?proc=draft:<id>`. Inline preview + authoritative lints (`POST /api/flows/graph`); error lints block submission. Exits: **Create team** (`POST /api/teams/stream`, full parity) or **Save as draft**.

**Role templates** live under `/template-workspace/agent-templates/` (from `orchestrator/skill-pool/agent-templates/` via `make seed-templates`). **Deliberately rudimentary**: parameter-free prompts (only weave-time `{{stageName}}`/`{{stagePrefix}}` remain), one role-specific *wake* (split into one trigger **per event** — #1008 wiring conventions: single-event triggers, claims on label listeners, `terminal`/`external` markers on flow-ending outcomes, CI-guarded in `process-template-registry.test.js`) + a daily self-curation cron (staggered in the 03:00 hour, `intrinsic: true`) pruning `memory/`. 24 roles; sample:

- `business-analyst` (persistent) — `issues.labeled` `req:refine` (intake pair with `issue-triage`)
- `developer` (per-invocation) — wiring from the flow; `code-reviewer`/`security-`/`test-`/`performance-reviewer` — `pull_request.opened/reopened`
- `reworker` — `pull_request.labeled` `revisions-required`; `documentation-sync` — `pull_request.closed` (merged-guard)
- `issue-triage` — `issues.opened`, emits `req:refine`; `dispatcher` — `issues.labeled` `ready`, releases via `dispatch`
- `generic` (persistent) — blank slate, no curation cron

**Materialisation:** one shared env (reused or auto-created id `<teamId>`); one `team` agent id `<teamId>` (`skipFirstMember: true`); one `team-member` per role id `<teamId>-<roleId>` carrying `systemPrompt` (role override), `sessionPolicy: per-invocation`, and a full `triggers.json` (`{{repoFullName}}`/`{{agentId}}` substituted); one DM room per member (best-effort). `skillsOverride` omitted — members inherit the team `skills[]`. On any failure, roll back members → team → env; a failure card (`progressError && !result && !collisionInfo`) surfaces this with a **Retry** button that re-calls `submit('create')` (which resets all error/progress state at its top). Members are later editable with Inherit ↔ Custom toggles.

### Direct Messages & Session Log

Each agent runs:

```
claude [--resume <sessionId>] -p <prompt> \
  --output-format stream-json --verbose --permission-mode acceptEdits
```

NDJSON stdout is parsed and written with wrapper events (`message.received`, `claude.invoke`, `message.posted`, `error`, `trigger.fired`) to `/workspace/agents/<agentId>/sessions/<roomId>.jsonl` (schema: `docs/agent-chat-plan.md` §4.1). Every entry carries a `correlationId` (Matrix `event_id`, or `trigger:<id>:<ts>`) tying log rows to chat bubbles.

**Per-room session pinning.** After each successful run the runner writes `session_id` to `<roomId>.current.json`; the next message in that room uses `--resume` (on failure it clears the pointer and retries once). `GET`/`DELETE /api/agents/:agentId/session/:roomId/current` read/drop it; the chat header shows *Reset Session* / *Save & Learn*. Snapshots live under `~/.claude/projects/<encoded-cwd>/` (persisted via the `claude-home` volume so `--resume` survives restarts).

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
| `orchestrator/flow-anomaly-detector.js` | Pure deterministic stall classifier: derives flow's expected label state machine from ports; classifies four anomaly classes with age |
| `orchestrator/flow-anomaly-sweep.js` | GitHub/session-log → detector objects adapter; I/O helpers + per-team threshold merge |
| `orchestrator/setup.sh` | Register the admin Matrix user, print the access token |
| `agent-image/` | Per-agent image `as-agent:latest`; entrypoint `scripts/agent-entrypoint.py` (+ `sase_lib.py`) is the live runtime |
| `admin-console/api/api.js` | Express API: agents, environments, ssh-keys, skills, models, mcp, `POST /api/teams`, agent-templates |
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

Skills live in the skill-pool volume (`agent-studio_claude-workspace`) under `skills/<name>/SKILL.md`, granted per **agent construct** (team `skills[]` / standalone `skills[]` / member `skillsOverride`) via the Agents page, the wizard's Knowledge step, or the Knowledge page. Environments have **no** skill picker. **Agents page create form**: the SkillPicker for `agent`/`orchestrator` roles pools `source==='pool'` only (global pool — no team context at create); team-tier skills appear in the edit form once the agent belongs to a team. `role==='team'` create form correctly shows the team-inheritance framing. Intended domain: **Mainframe Migration** (COBOL, JCL, DB2, IMS/VSAM).

### Two-tier skill pool

Resolved **team-first then global** at seeding. **Global**: `/template-workspace/skills/` (orchestrator RO) = `/pool/skills/` (admin-console RW), System-Admin-managed, all teams. **Team**: `/workspace/teams/<teamId>/skills/` (RW), Team-Admin-managed, that team only. `orchestrator/skill-source.js` (`makeSkillSourceResolver`) copies each grant name from the team's pool when present, else global. `/api/skills` tags `source` = `pool`/`team`/`agent`; `POST /api/skills/promote-to-global` lifts a team skill into the global pool.

### Knowledge digest (guaranteed context injection)

Part of the memory/knowledge unification (`docs/memory-knowledge-unification-concept.md`). Every KB-provisioned agent carries a generated **`knowledge-digest.md`** at its workspace root, `@`-imported by the seeded CLAUDE.md — so team conventions, converged (learned ≥2×) and recent lessons are **guaranteed in context at session start**; `knowledge search` is the long-tail complement. Deterministic (no LLM), ~3k-token budget, built by one pure module kept byte-identical on two sides: `orchestrator/knowledge-digest.js` ↔ `build_knowledge_digest()` in `agent-entrypoint.py` (golden fixture `knowledge-digest.fixture.json`; change both in one commit). Runtime rebuilds pre-invocation; `refreshKnowledgeClone` fans out post-KB-change. The `@`-import is gated (`knowledgeDigestRef`) on a provisioned checkout, so autonomy-0/KB-less agents see nothing.

**Semantic rerouting.** `agentKnowledgeDigestRef(id, env)` (autonomy ≥ 1 + provisioned checkout ≡ `_memory_model_unified()`) flips the digest import, swaps the Memory System section to the unified variant (episodic `context.md`/`log.md`/`users.md`; `facts.md`/`entities.md` read-only legacy — new semantic knowledge goes to `knowledge add`), and selects the unified memory hint. The legacy five-file model is the autonomy-0/KB-less/blueprint fallback. `users.md` is personal data — never shared, never migrated.

**Migration.** One-shot per unified agent (`migrateAgentMemoryToKb`, `orchestrator/memory-migration.js`): legacy `facts.md`/`entities.md` → KB entries in a dedicated shard `<kind>/shards/<agentId>.migrated.jsonl` (never the agent's own — avoids a two-writer race), committed+pushed; only after the push are files archived to `memory/_archive/`. **"in digest" indicator**: `buildKnowledgeDigest` returns `includedIds`; `GET /internal/teams/:teamId/knowledge/digest-status`; the Knowledge tab renders a green `digest` badge.

## MCP Servers (operator notes)

Reference servers ship under `mcp-servers/<id>/`; `make seed-mcp-servers` (chained from `make seed-pool`) syncs them to `/template-workspace/mcp-servers/`. Add a backend by: (1) drop a single-file MCP (stdio or http) under `mcp-servers/<id>/`, (2) `make seed-mcp-servers`, (3) register via the **MCP Servers** admin page + bind a credential + attach to environments. The `wiki/` reference server is tiny and dependency-free — clone it as a starting point.
