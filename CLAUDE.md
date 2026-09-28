# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

> **High-level map.** This file is a lean orientation map, kept small on purpose:
> it is auto-loaded into every agent's context on every run, so bloat here is a
> direct, recurring token cost. **Deep specs live under `docs/`; ticket-level
> decision history lives in git** (`git log`, PR descriptions) — do not append
> per-ticket narratives here. When you add a subsystem, add a short paragraph and
> a `docs/` pointer, not its full rationale.

## Project Overview

**agent-studio** is a local Matrix-to-Claude-Code stack for an enterprise context.
It provides chat-based AI agents extensible with domain-specific skills for
**Mainframe Migration** (COBOL, JCL, DB2, IMS/VSAM).

The stack runs locally with Podman as a single compose file, four services:
- **Conduwuit** — Matrix homeserver (`localhost:8448`).
- **Orchestrator** — control plane; spawns/manages one container per agent; no
  Matrix identity. Internal HTTP API on `:4002` (auth-gated, never published to host).
- **Admin Console** — web UI on `:4000` (agents, environments, credentials,
  skills, plugins…); embeds a chat UI at `/chats/:agentId`.
- **Webhook server** — `http` triggers on `HOOK_PORT` (default `:4003`).

**LLM backend** is reached via an Anthropic-compatible proxy: `ANTHROPIC_BASE_URL`
+ `ANTHROPIC_AUTH_TOKEN` in `.env` (gitignored); default Sonnet/Haiku models set
there too.

**Model Provider auth types.** A registered Model Provider
(`/workspace/llm-endpoints/index.json`, tokens in `_keys/` at 0600) carries an
`authType`: default **`api-key`** (Bearer against `baseUrl`) or **`oauth-token`**
(Claude *subscription* auth via `claude setup-token`). For `oauth-token` the
orchestrator injects `CLAUDE_CODE_OAUTH_TOKEN` and strips the `ANTHROPIC_*` vars
so the CLI talks directly to `api.anthropic.com`. Login runs server-side under a
PTY; the token is claimed server-side, never reaching the browser. **Compliance:**
consumer-subscription OAuth tokens are single-user only — creating/re-keying one
requires a single-user confirmation (`complianceAck`), and server-side one-shot
assist calls skip `oauth-token` providers. Health of every provider is polled in
the background (`startLlmHealthPoller`), status persisted separately in
`/workspace/llm-endpoints/health.json`. A provider may be `global: true`
(System-scoped, non-oauth only) to be visible/usable by every user and teamless
agent (`admin-console/api/llm-endpoint-global.js`). Detail: model-provider docs.

## Architecture

All human↔agent communication is **direct messages**: each agent has its own
Matrix user; the human chats with it in a dedicated 1:1 room. No shared
multi-agent room, no central routing identity.

```
Admin Console chat UI (or any Matrix client) → Conduwuit (localhost:8448)
       └── per-agent shared DM room (@cobol-agent:local ← as-agent:latest)

orchestrator.js (control-plane container, no Matrix presence)
  ├── Agent lifecycle (create/update/delete via Admin Console)
  ├── One Podman container per enabled agent over the libpod socket
  │     (/var/run/podman.sock) via spawn-container.js
  ├── Per-agent network + volume isolation; reconciles live containers
  │     (by the `aee.agent.id` label) against its map
  ├── Provisions agent + per-human Matrix users via the admin client
  └── Internal HTTP API on :4002 (auth-gated)
```

- **Agents** are dynamically created Matrix users, each in its **own** Podman
  container (`as-agent:latest`). Config at `/workspace/agents/<id>/`
  (`config.json` + `CLAUDE.md` + `AGENT-PROMPT.md`); DM room id in `dm-room.json`.
- Each agent is bound to a **Working Environment** (below).
- **Container-per-agent isolation**: per-agent network; per-agent filesystem via a
  SubPath mount of the pool volume (`AEE_WORKSPACE_ISOLATION`, default on);
  optional dedicated volume (`AEE_PER_AGENT_VOLUME`); optional host-folder
  bind-mounts (podman/local only, read-only by default) at `/context/<slug>`
  (`contextMounts` in `config.json`; browsed *through* the agent's container).
  See `docs/context-mount.md`.
- **Agent runtime**: `agent-image/scripts/agent-entrypoint.py` — Matrix client +
  Claude CLI invocations + trigger scheduler.

### Teams (human) vs Agent Teams — do not confuse them

A **Team** (a.k.a. *access scope*) is the human tenant/scope that resources and
users belong to. It is **not** the `role: "team"` agent construct — always called
an **Agent Team** (a squad of agents working a repo). They only share a word.

- **Human data model**: three JSON collections under `/workspace` (`teams/`,
  `users/`, `memberships/index.json`). Roles: **System Admin** (global,
  `user.systemAdmin`), **Team Admin**, **Team Member** (per-team). Source of
  truth: `orchestrator/teams-store.js`. Every resource carries a `teamId`
  (default `default`). Full spec: `docs/teams-data-model.md`.
- **Per-human Matrix identity**: creating a user provisions their own Matrix
  account `@u-<16 hex of sha256(subject)>:local` (`human-matrix-identity.js`,
  token stored out-of-record in `human-matrix-store.js`). Interactive chat sends
  as the acting human's own account, invited into the agent's shared room on
  first use. Detail: `docs/multi-user-concept.md`.
- **Ownership**: `role: 'team'` and standalone `role: 'agent'` configs carry an
  **`ownerId`** + `ownerSource`. Access is answered per **Agent Team**
  (`resolveAgentTeam` — a `team` is its own boundary; a `team-member` is bounded
  by `parentTeamId`; a standalone/ephemeral agent is decided by `ownerId`).
  As of epic #2229 every ordinary agent is a **team of one** from creation
  (`team-of-one-migration.js` migrated the rest); the standalone case is now only
  ephemeral agents or malformed configs.
- **Resource scoping**: list endpoints are filtered by the caller's team
  membership via `admin-console/api/scope.js`. Whether scoping applies is the
  `AUTH_ENABLED` mode (`admin-console/api/auth-mode.js`): **off (default)** =
  single-user, everyone is implicit System Admin; **on** = per-membership
  enforcement. Governs authorization only; the login is identical either way.
- **Tiered ownership**: credentials, environments and MCP servers carry a
  `{scope, teamId, assignedTeamIds, userId}` triple (`orchestrator/resource-tier.js`).
  A **personal** tier (`userId`, `teamId: null`) is owner-only — no `scope.all`
  bypass, no admin break-glass.
- **Work-plane tenant isolation**: one express gate
  (`admin-console/api/work-plane-access.js`) over the `:agentId` route family
  (workspace browser, git actions, session log, context folders, chat, Matrix
  rooms) — a caller who can't see an agent gets a uniform **404**. On the
  single-operator default it short-circuits before any disk read.
- **Administration** page (`/users`, System-Admin-only): tabs **Users / All
  Teams / Resources**. The former **Access** page is dissolved; `/teams` →
  `/users`. Self-service Agent Team creation is ungated (`POST /api/teams`); the
  creator is recorded Team Admin. The last System Admin / last Team Admin cannot
  be deleted or demoted (succession rule in `team-admin-succession.js`).
- Design of record: `docs/decentralised-access-concept.md`, `docs/governance-concept.md`.

### Working Environments

A reusable **infrastructure template** at
`/workspace/environments/<envId>/environment.json`:
- `repositories` (array of `{url, branch, sshKeyId, readOnly}`, zero or more
  cloned at creation — `[]` valid for LLM-only agents; `readOnly` annotates
  *reference-only* in the prompt; legacy single `repository` migrated on read).
- `mcpServers` (`{serverId, credentialId}` refs), `additionalContext` (appended
  to CLAUDE.md — **and shown to the agent**), `toolchainId`, `isTemplate`.
- **SSH key vs GitHub PAT (defense-in-depth):** SSH key → git I/O on SSH URLs
  (`GIT_SSH_COMMAND`); PAT → HTTPS git, Events-API polling, `gh` (`GH_TOKEN`).
  HTTPS URL with no PAT refuses the clone (no SSH fallback). Keys at
  `environments/_keys/<keyId>` (0600); private key never returned, only its
  fingerprint.
- **Toolchains** (`toolchainId`, #1940/#1941): the default agent image carries
  Python + Node only; an environment may name a registered toolchain image
  (e.g. JVM). Registry `/workspace/toolchains/index.json`, System-Admin-managed;
  sources under `toolchains/<id>/`. Core: `orchestrator/toolchain-registry.js`;
  guide `docs/agent-toolchains.md`.
- **Repository propagation**: repos are cloned at creation only; a save-time
  offer (`RepoPropagationDialog`) reconciles the declared list against what is on
  disk, per agent, via `orchestrator/repo-sync.js` — never prunes a clone (may
  hold unpushed work), only adjusts clean/pushed ones. An "agents not up to date"
  badge derives divergence from the workspaces.
- **Agent-scoped repositories** (`agentRepositories` on the agent's config): a
  repo attached to one agent outside its environment (`orchestrator/agent-repositories.js`).
- The general **Working Environments** page is removed (`/environments` →
  `/chats`); a team edits its own env from Agent Chat → **Settings**. A System
  Admin curates reusable `isTemplate: true` envs on **Environment Templates**
  (`/environment-templates`); templates are copy sources, never bindable.
- Environments do **not** carry skills — the skill grant is team-owned.

### System-prompt assembly

The seeded `CLAUDE.md` and the runtime `--append-system-prompt` memory hint are
composed by one pure module — **`orchestrator/prompt-assembly.js`**.
- **Ordering**: identity preamble → authored **Agent Role** (hoisted to top) →
  Working Environment → Workspace → Response Formatting → Memory System → Skills →
  Plugins → GitHub Actions → Trigger management → Important Notes. Base template
  from `/template-workspace/CLAUDE.md` (else `/defaults/CLAUDE.md`), split by H2,
  re-ordered in code.
- **Conditional gating**: Git/`gh-as-agent` only when the env has a repo;
  Trigger-management + unattended framing only for autonomous agents; Skills only
  when the grant is non-empty; Context Folder(s) only when the agent has a mount;
  Plugin Capabilities from the resolved grant. Changing mounts/triggers rebuilds +
  reseeds CLAUDE.md (`prompt-rebuild`) before respawn.
- **Memory hint**: `buildMemoryHint(blueprintId)` is byte-identical to
  `_build_memory_hint()` in `agent-entrypoint.py` (test-asserted; change both together).

### Credentials

SSH keys and GitHub tokens, tiered like all resources (personal / team / system).
- **Rotation**: repointing an env's `githubTokenId` respawns its running agents;
  **in-place rotation** (`POST /api/{ssh-keys,github-tokens}/:id/rotate`, gated by
  `canManageCredential`) replaces the secret and respawns holders — personal
  rotation fans out per-owner (`respawnAgentsForOwner`), team/system per-environment.
- **Runtime resolution** (`orchestrator/credential-resolution.js`): per operation
  class — **attributed writes** (commit/PR/review/push, `ATTRIBUTED_OPERATIONS`)
  prefer the acting/owner's personal token (personal → team → system) and
  **refuse** (HTTP 424) if an interactive owner has none; reads/clones/polling are
  shared-eligible. The acting sender for an interactive run is bounded/trusted
  (`isActingSenderTrusted`); an autonomous run uses the team's current Team Admin
  as **baseline** (`resolveBaselineOwnerId`). The container's spawn-time bake also
  resolves through the baseline (`resolveBaselineGithubTokenId`/`SshKeyId`).
- **Offboarding** (`offboardOwner`): deleting a human pauses their agents and
  deletes their personal credentials before removing the record.
- Self-service: **My Credentials** (`/my-credentials`). Full spec: `docs/credentials.md`.

### MCP Servers

How agents reach runtime data (wikis, vector stores, graph DBs). Mirrors the
SSH/PAT split: a *catalog* of servers, a *separate* credential store, an
environment that pairs them.
- Reference impls under `mcp-servers/<id>/` (baked into the image;
  `make seed-mcp-servers`). Registry `/workspace/mcp-servers/<id>/server.json`
  (`transport: stdio|http|sse` + command/args/env or url/headers).
  Credentials at `/workspace/mcp-credentials/`; `env`/`headers` support
  `${credential}`, substituted per-agent at seed time.
- **Per-agent isolation**: at seed time the merged stanza is written into the
  agent's own `.claude/settings.json` under `mcpServers[<serverId>]`; a member's
  `mcpServersOverride` replaces the env set. No pool-wide MCP config.

### Plugins (governed capability extensions)

Agents reach the outside world (container runtimes, test systems…) **only**
through registered **platform plugins** (not Claude Code "agent plugins"). A
plugin pairs a privilege-holding **broker sidecar** with a dependency-free **CLI
facade** seeded into the agent workspace — CLI-first, all security server-side.
Concept: `docs/plugin-system-concept.md`, `docs/cli-contract.md`.
- **Install** (`POST /api/plugins/:id/install`, System-Admin-only, **Plugins**
  page): copies a reference plugin from `plugins/<id>/` into the operator registry
  `/workspace/plugins/<id>/` and starts its broker. Install **grants nothing**.
- **Grant**: team-owned like skills (`plugins[]` on team agents, `pluginsOverride`
  on members; `orchestrator/plugin-grants.js`). Grant → additive workspace sync
  (CLI + 0600 scope-token config + network attach), no respawn.
- **Materialisation & reconcile** (#2308): a member's resolved grant is
  seeded into its workspace at creation (`addTeamMember`) and at stub-enable
  time (`enableAgent`), mirroring `effectiveSkills` — never only on the next
  grant toggle. Written files are tracked in a per-member
  `.agent-studio/seeded-plugins.json` (the plugin sibling of
  `seeded-skills.json`); a background loop (`reconcilePendingPlugins`,
  `orchestrator/plugin-reconcile.js`) auto-repairs a member whose grant and
  manifest disagree, bounded by the same backoff as the skill reconciler. A
  sync failure never blocks the add — it degrades the member and surfaces as a
  warning (add-member response + GitHub Event Log), never silently.
- **Manifest** (`pluginVersion: 1`, `plugin-manifest.js`): closed `capabilities`
  enum (`podman-socket`, `egress`, `host-mount:<path>`), `scopes`
  (`team`/`agent`), optional `quota`, `ui.routes[].minRole` (the console proxy
  pre-checks it on the viewer's flat max role and signs a per-team role map;
  a team-selecting broker gates elevated routes on `roleForTeam` — the
  verifier block is byte-identical across brokers, parity-tested), optional
  command-only (`commands`) / install-time `fetch`, optional `events[]` (an
  event-source plugin's declared vocabulary — event names + payload keys —
  rendered by the plugin-event trigger form, never interpreted), and an
  optional `help/*.md` dir of console help topics folded into the Helper Chat
  only on the routes they name (`help-registry.js` `loadPluginTopics`).
- **Scope tokens**: HMAC `{pluginId, scopeId}` (`plugin-scope-token.js`); broker
  verifies every call; ownership label `aee.plugin.owner`.
- **Broker SDK** (`broker-sdk/`): the per-call obligations (verify, scope-filter,
  audit, mask-secrets, health/teardown, approval pen, `internalPushEndpoint` for
  orchestrator-only pushes — `_internal` scope token only) a broker imports.
- **Reference plugins**: `dummy-echo` (smoke test), `podman-sandbox` (#1, podman
  socket), `test-mgmt` (#2, credential broker), `netzplan` (#3, UI planning
  board), `github-issues` (UI + credential), `patterns-catalog` (UI-only),
  `spec-kit` (command-only), `jira` (the first **event-source** plugin — see
  below). `make seed-plugins`.
- **Event-source plugins — the Jira plugin** (`plugins/jira/`, docs
  `docs/jira-plugin.md` / `docs/jira-plugin-plan.md`; further event kinds planned in `docs/jira-plugin-events-plan.md`): wakes granted agents on
  Jira Cloud status changes. Two generic additions it needed are reusable: the
  **per-scope plugin credential store** (`orchestrator/plugin-credential-store.js`
  — makes the manifest's `credentials[]` real, 0600 under
  `/workspace/plugins/_credentials/<id>/<scopeId>.json`, set by a Team Admin on
  the Plugins page, pushed to the broker server-side) and the **`plugin-event`
  wake** (`orchestrator/plugin-event.js` + `POST /internal/plugin-event`,
  scope-token authed — the first broker→orchestrator channel). The consumer's
  `plugin-event` trigger `{ pluginId, eventFilter?, payloadFilter?, prompt }` is
  queue-fired like `wake-agent`; `payloadFilter` (`{ key: value }`, exact,
  case-sensitive, top-level string fields, a digest matches on any event) routes
  one plugin's events to different agents (Jira: `toStatus=Ready for Dev`) and is
  mirrored in the agent drain. The broker polls JQL/changelog per
  `<siteUrl>::<projectKey>`; `aee-jira` does `inbox`/`projects`/`list`/`show`
  (reads) + `comment`/`transition`/`update` (attributed, role-gated writes — D3,
  no confirmation pen); `/` + `/admin` UI routes, `ui.global: true`. Granted plugin
  CLI copies are refreshed on every plugin reconcile (`planCliRefresh` in
  `plugin-sync.js`), since the grant sync copies them only on a grant change.
- **Runtime**: `plugin-registry.js` (re-validates on read, owns the signing
  secret `/workspace/plugins/_secret`), `plugin-runtime.js` (libpod sidecar
  lifecycle). On Kubernetes (`AEE_CONTAINER_RUNTIME=kubernetes`) UI-bearing
  plugins run as Deployment + Service + state PVC (`spawn-kubernetes-plugin.js`);
  broker-plugin per-agent reachability is Podman-only.

### Agent Roles

- `agent` — standalone (now minted as a team of one). Responds to DMs; with
  triggers, runs autonomously.
- `team` — a reusable system-prompt template + shared Working Environment; hosts
  no agent itself. **Add Member** / the wizard spawns `team-member` agents.
- `team-member` — inherits the team's `systemPromptTemplate`, `skills[]`, and the
  env's `mcpServers`; records `parentTeamId`. May override via `skillsOverride` /
  `mcpServersOverride`; prompt mode is Inherit / Additional / Exclusive
  (`orchestrator/prompt-modes.js`). Deleting the `team` cascades to all members
  (`agent-delete-plan.js`).
- `orchestrator` — bound to a BriefingPack dir; scans it, writes one stub
  `bp-instance` per BP, dispatches on confirmation.
- `bp-instance` — one per Briefing Pack; stub until claimed/activated.
- **Legacy**: `expert`/`expert-group`/`expert-instance` →
  `agent`/`team`/`team-member` (and `parentGroupId` → `parentTeamId`) on read.

Detail: `docs/agent-roles.md`.

### Autonomous Agent Triggers

Per-agent `/workspace/agents/<id>/triggers.json`; scheduler syncs every 60s
(`node-cron`). **Self-managed**, file-based, per-trigger overlap protection, and
**agent-wide serialization**: one `WorkspaceGate` (`agent-entrypoint.py`) — at
most one workspace-touching run (a loop iteration, any trigger, or a chat turn)
at a time; a running loop holds the workspace across all iterations, everything
else queues FIFO.
- `cron` (5-field), `once` (ISO, auto-removed), `http` (`X-Hook-Secret`),
  `github-event` (repo + events + optional `labelFilter` + optional `claim`
  label-swap with optional `postcondition`), `wake-agent` (direct agent-to-agent
  hand-off, queue-fired), `loop` (re-arms on completion; `maxIterations` required;
  optional `verify` gate; fresh context per iteration).
- **`transport: 'internal'`**: a label listener excluded from the poller and woken
  directly by `POST /internal/flow-emit` (`aee-emit`); label mirrored to GitHub as
  decoration only.
- Results post to `trigger.roomId` or the DM room; no room yet → skipped;
  `[PASS]` suppresses output.
- **Session policy**: `per-invocation` → triggered runs start fresh (no
  `--resume`), don't move the session pointer; absent = `persistent` (legacy).
- Concepts: `docs/triggers.md`, `docs/loop-triggers-concept.md`,
  `docs/internal-channels-concept.md`, `docs/direct-agent-handoff-concept.md`,
  `docs/process-template-format.md`.

### Process Canvas / Flows

Agents + triggers form an **orchestration graph**, authored in **Flows**
(`/flows`, `Briefings.jsx`; graph/editor = `ProcessGraphPanel` in
`ProcessCanvas.jsx`, driven by a `scope` prop). Left list selects scope: **Teams**
(live graphs) or **Drafts**.
- **Declarative ports are the single source of truth** for edges (siblings on a
  config, `PUT /api/agents/:id`): `emits: string[]`, `dataFlow.{dependsOn,inputs,
  outputs}`, `github: {producesPr?, producesIssue?}`, `channels[]` on the
  consumer (`{artifact, from, label?, gate?}`), `parentMemberId`, `stage`.
- **Functional triggers are derived from ports, not authored** (at materialise
  for drafts; on every port write for a live team). Human-approval **gates** and
  **brakes** are config flags on the label registry, never a naming convention.
  Named **human roles** are `kind: 'human'` flow nodes (`humans[]`).
- Graph endpoint `GET /api/process/graph` → `{nodes, edges, gates, labels,
  humanTouchpoints, lints}`. Pure builders: `process-graph.js`, `unified-graph.js`;
  layout `flow-layout.js`.
- **Drafts** (`/api/process/drafts`, `/workspace/process-drafts/<id>.json`):
  private to creator, shared with equal rights (`admin-console/api/draft-access.js`).
- **Templates & round-trip**: `GET /api/process/template?team=<id>` exports a
  portable `processTemplateVersion: 1` bundle (no repos/secrets); materialise via
  `POST /api/teams`. **Edit as draft** seeds a draft from a live team.
- **LLM-assisted authoring**: **Flow Copilot** (`POST /api/process/copilot`,
  app-level in-flight turn in `FlowCopilotContext.jsx`), port suggestions,
  prompt generation. `resolveAssistTarget` enforces the caller's provider
  selection; autonomous synthesis uses the team's `assistLlmEndpointId`.
- **Artifacts** matched by logical name via a git-committed
  `.agent-studio/artifacts.jsonl` (`aee-artifact` CLI).
- **Anomalies & hill-climbing** (observe → propose → apply → verdict): the flow
  anomaly detector (`flow-anomaly-detector.js`), the hill-climb metrics/cards/
  verdict loop (`hill-climb-*.js`, gated applier), surfaced by the **Anomalies**
  and **Improvements** panels. Concepts: `docs/flow-reconciliation-concept.md`,
  `docs/hill-climbing-agent-concept.md`.
- **Flow Control** (`docs/flow-control-concept.md`): a declarative per-flow
  `wipLimit` enforced at dispatch (`admission-control.js`); a read-only **ticket
  ledger** deriving true state from GitHub evidence (`ticket-reconciler.js`);
  the `/flow-control` board (no nav entry).
- **Agent Pools** (epic #2251, `docs/parallel-workers-concept.md`): a role opts
  into `pool: {enabled: true, …}` (bundle field, sibling of `wipLimit`) to become
  a template — one wake spawns an item-keyed ephemeral instance
  (`<team>-<role>-i<item>`), reusing the admission lane as the instance registry;
  ticket-release reap piggybacks on the lane's own reconcile tick, while the
  hard-timeout/idle/archive-prune axes run on their own `wipLimit`-independent
  tick so a pooled role with no `wipLimit` still gets reaped (`agent-pool.js`,
  Phase 1 #2246, gaps closed by #2301). The
  **Flow Supervisor** (`autoDispatch: {enabled: true}`, sibling field, requires
  `wipLimit` + a pooled role — `flow-supervisor.js`, Phase 2 #2247) is a
  maintenance-gated timer that auto-dispatches ready-but-undispatched pooled
  tickets up to the limit, oldest-first, never two in flight sharing an
  epic — and folds in a bounded remediation ladder (re-fire a dropped dispatch;
  nudge a `stale-base` PR's owner), each action capped at ≤1 per
  `(ticket, blocker)` per window and recorded in the GitHub Event Log
  (`source: 'supervisor'`). Deterministic, no LLM; the human still decides
  readiness, the supervisor only times the dispatch. **The recurring-analysis
  binding** (`pool.workSource: {items, outputDir, inputDir}`, Phase 3 #2248)
  proves the pool core is domain-neutral: no GitHub, no ticket, no git
  contention — a maintenance-gated tick (`recurringPoolSweepTeam`) enumerates a
  static item list, reaps an instance once its item's output artifact appears,
  and (re-)spawns the rest via the SAME item-keyed `spawnPoolInstance`, up to
  `maxInstances`/`wipLimit`. **LLM conflict prediction** (`autoDispatch.
  contentionPolicy: "predicted-paths"`, sibling value of `"epic-serial"`, opt-in
  and off by default — Phase 4 #2249) layers a read-only pre-flight ON TOP of
  epic-serialization: `predicted-paths.js` predicts the files a ready ticket will
  likely touch (an LLM call over the issue + a repo-tree sample, reusing the
  #1213 team-billed assist provider — or a deterministic heuristic when no
  provider is configured or the call fails) and `selectAutoDispatch` skips a
  candidate whose predicted paths overlap another ticket's already-active
  prediction. Advisory only — an empty/failed prediction never adds a
  restriction, and the ledger's `conflict`/`stale-base` detection stays the real
  safety net. **Board controls** (Phase 5 #2250): the Flow Control board
  (`/flow-control`) gets a per-role Pause/Drain/Resume (a runtime toggle,
  `pool-control.json`, kept out of the `pool` bundle field — blocks only NEW
  spawns, an existing instance runs to completion) and a per-held-entry Force
  dispatch (`admissionControl.forcePromoteHeld`, promotes past `wipLimit` for
  that one entry). **Pool instance lanes** (#2273): a read-only third board
  panel, per pooled role's live instances tagged running / held-same-epic /
  timed-out (`pool-instance-lanes.js`, pure, no new persistence — derived
  from live instance configs + the ticket ledger). **Agent Chat rail
  sub-grouping** (#2297): the same live instances, nested under their role as a
  collapsible **Instances (N)** sub-list in the left rail instead of scattered
  flat among the team's members — `poolInstance`/`poolOf`/`poolItem` surfaced on
  `GET /api/matrix/agents`, nested by `agent-list-model.js` `buildGroups`. **The
  rail live-refreshes** (#2311): `AgentRosterContext` polls the same endpoint on
  its own ~5s beat (a shared singleton poll, mirroring `AgentStatusesContext`'s
  #1677 pattern; paused while the tab is hidden), diffed by `roster-diff.js` so
  only actually-changed rows re-render — a spawned/reaped/renamed instance (or
  any other roster change) now appears/disappears/updates within ~5s with no
  manual reload, instead of only at the next navigation or filter toggle.
  **`AEE_POOLS_ENABLED`** (#2302, default off — `pools-mode.js`, mirrors
  `AUTH_ENABLED`): hides the Parallelism button/panel entirely and renders the
  per-role Scaling section disabled with a "Coming Soon" badge until an
  operator opts in; not yet wired into `docker-compose.yml`'s env passthrough
  (see Amendment 10). A headless runtime (D7) and provider-health-aware
  admission (D9) remain undesigned. Detail: `docs/parallel-workers-concept.md`
  Amendment 10.

### GitHub poller

`orchestrator/github-poller.js` polls the Events API every 30s for every repo in
an env with a `githubTokenId` (replaces webhooks for local stacks).
- Repo discovery walks all envs; one token per repo. Bandwidth: page-1
  `If-None-Match` (304s are free); pagination on bursts. Cursor = per-repo
  sliding **seen-id set** (`state.json`), not a timestamp; first poll baselines.
- Matched events → `pending-triggers.json` (drained every 5s). Event keys
  `<type>.<action>` (e.g. `pull_request.opened`); bare `push`. Some actions are
  omitted by the API (no `pull_request.synchronize`).
- **Loop protection is frequency-only, no source filtering**: a per-`(agent,
  conversation)` throttle (default 5/h) + a per-poll burst-cap digest. A trigger
  fires on any matching event, including self-caused.
- Resilience: hard request deadline + stall watchdog (self-heals a stuck poll).
- **Event-transparency log** (`github-event-log.js`): every fresh event recorded
  (delivered / dropped / digest / no-subscriber) → `GET /api/github-events`, the
  **GitHub Event Log** page (Processed events + Pending queue tabs). Also written
  by the internal label fast-path and direct hand-offs.

### Admin Console: auth, audit, containment

- **Auth** (`admin-console/api/auth.js`): login screen; every `/api/*` needs a
  session cookie (HMAC HttpOnly `aee_session`). **IAP SSO bridge** (`IAP_AUDIENCE`
  set, GKE): a session-less request authenticates via its Google-IAP-signed JWT,
  matched to a registered user-store subject (`iap-auth.js`).
- **Initial admin is a seed, not a login**: `ADMIN_USERNAME`/`ADMIN_PASSWORD`
  (or `BOOTSTRAP_SYSTEM_ADMIN_*`) are consumed once, at first boot on a zero-users
  store, to create a real System-Admin user record (`initial-admin-seed.js`,
  `seedInitialSystemAdmin`). Session-signing key: `AUTH_SESSION_SECRET` else a
  persisted random key (`session-secret.js`). Per-user local passwords are scrypt.
- **Audit**: every mutating `/api` request → one JSONL line at
  `/workspace/audit/audit-<date>.jsonl` (`auditMutations`, mounted before the auth
  gate so denials are logged). `GET /api/audit`.
- **Error containment** (`ErrorBoundary.js`, `error-boundary-view.js`): three
  layers — route, per-event row, markdown (full → GFM → infallible plain text) —
  so a render throw never blanks the page. Client-crash telemetry →
  `POST /api/client-errors` (`client-error-log.js`).
- **Internal-API auth** (`:4002`, `orchestrator/internal-auth.js`): one gate at
  the top of the `internalApi` handler. `INTERNAL_API_TOKEN` = control-plane
  (admin console); each agent gets a derived per-agent `AEE_INTERNAL_TOKEN` (HMAC
  over the agent id) allowlisted to its own routes (`AGENT_ROUTES`); a plugin
  broker's scope token is the `plugin-scope` class, allowlisted to exactly
  `POST /internal/plugin-event` (`PLUGIN_SCOPE_ROUTES`). Rollout ladder
  `INTERNAL_AUTH_MODE=observe|warn|enforce` (default `observe`). Concept:
  `docs/governance-concept.md` §3.5.

### Maintenance Mode, Webhook Server, BP-event router

- **Maintenance Mode** (soft, cooperative): `cron`/`once` don't fire in the
  window (exactly one catch-up after); `http`/`github-event` keep queuing but stay
  undrained; the console locks every chat composer. Read via
  `GET /internal/maintenance-mode`.
- **Webhook server** (`HOOK_PORT`): `POST /hooks/:agentId/:hookId` with matching
  `X-Hook-Secret`; enqueues the trigger's `prompt` (body ignored). Only the
  Maintenance flag protects the queue — prefer `github-event` for must-not-drop.
- **BP-event router** (`POST /internal/bp-events`): announces Briefing Pack
  changes; the orchestrator routes to affected bp-instances (`bp-event-router.js`).

### Direct Messages & Session Log

Each agent runs `claude [--resume <sessionId>] --print --output-format
stream-json --verbose --permission-mode acceptEdits`. The prompt is written on
**stdin** (so an option-like leading character isn't mis-parsed). NDJSON stdout is
parsed and written with wrapper events to
`/workspace/agents/<id>/sessions/<roomId>.jsonl`; every entry carries a
`correlationId` tying log rows to chat bubbles. Schema: `docs/agent-chat-plan.md`.
- **Per-room session pinning**: after a successful run, `session_id` →
  `<roomId>.current.json`; the next message in that room uses `--resume`.
  Snapshots under `~/.claude/projects/<encoded-cwd>/` (persisted via `claude-home`).
- **Chat-turn gate** (`is_human_sender`): act iff the sender is a joined room
  member and not this agent — the shared room may hold many humans.
- **Parent-ticket binding** (`ticket.json`, room-scoped): backend endpoints exist;
  the UI surfaces were removed.

### Agent Chat UI

The console embeds a Matrix client at `/chats` (+ `/chats/:agentId`), under
`admin-console/src/pages/AgentChat.jsx` + `agent-chat/`. Deterministic logic lives
in pure, unit-tested `*-view.js`/model modules per the #651 convention (JSX
uncovered). Key pieces:
- `AgentList` — left rail (drag-reorder, grouping, disabled/stub opt-ins,
  pool-instance sub-grouping (#2297), lifecycle context menu via
  `RailLifecycleHost`).
- `ChatPanel` — backfill/pagination/optimistic-send/SSE tail; transcript
  **windowed** (`VirtualList`/`virtual-window.js`), stick-to-bottom. A
  `?msg=<event_id>` deep-link (#2310) bounded-backfills, scrolls to (via
  `VirtualList`'s `scrollToKey`/`onScrolledToKey`) and briefly highlights one
  message, falling back to the normal default position with a notice if the
  id can't be found.
- `Message` — sanitised markdown (`react-markdown` + gfm + pretty-code +
  `rehype-sanitize`); quick-reply cards for `AskUserQuestion`-shaped
  questions (raised headlessly via the `aee-ask` CLI → per-turn sentinel file,
  #2523; the `ask-user-mcp.py` path is policy-blocked); inline image
  thumbnails; hover-revealed "Copy link" builds the `?msg=` deep-link above
  (#2310, plain text bubbles only).
- `MessageInput` — composer, send-keybinding preset, per-agent drafts,
  slash-command palette, unified Send/Stop.
- `RightRail` — tabs (Sessions, session log, Workspace, Triggers, Outcomes,
  Knowledge, Settings). `SessionLogPanel` — structured timeline (windowed), live
  TODO surfaces, per-tool renders (Edit/Write diffs, task events, rate-limit
  events). One shared `SessionsActiveContext` poll.
- **Lifecycle & config** live in the rail: agent management (`agent-lifecycle/`,
  shared with `/create`), the **Settings** tab (agent edit form), **New/Import
  Agent** in the page-action header. The standalone **Agents page is removed**
  (`/agents` → `/chats`).
- **Workspace browser** (read-only over `/workspace/agents/<id>/`,
  path-guarded, 512 KB cap, inline images). **Context-folder** browse/write runs
  inside the agent's container via libpod exec/archive (`context-browse.js`,
  `context-write.js`, `container-exec.js`; RW mounts only).
- **Overlays** (app-level, survive navigation): meeting Note-Taker
  (`TranscriptionSessionContext`), **Helper Chat** + guided tour
  (`HelperChatContext`), Flow Copilot indicator.

### Context-help system

Per-page help is authored as small markdown **topics** under
`admin-console/api/helper-chat/help-topics/<id>.md` (front-matter `id, routes[],
title, summary, seeAlso[], askPrompts[], actions[]`). One source read by two
consumers: `GET /api/helper/page-help` (the panel's "This page" face +
`PageHelpButton`, deep-linkable to a chapter) and the chat grounding
(route-scoped fold into the system prompt). Route→topic resolution mirrors
`breadcrumbs.js`; the `docs/**` corpus is vendored under `helper-chat/docs/`
(parity-tested). Coverage is a CI ratchet (`help-coverage.test.js`,
`help-baseline.test.js`): a page route with no topic and no named owner fails.
Non-route contexts (`modal:*`, `wizard:*#step`) are addressable via
`useHelpSubject`. Concept: `docs/context-help-system-concept.md`.

### Agent Team Wizard

`POST /api/teams` (wizard `/team-setup`) materialises a team-shaped agent group in
one atomic-with-rollback transaction. Steps: **Process → Working Environment →
Team → Knowledge → Review**. Picks an existing env (`environmentId`) or accepts
legacy direct inputs; always ships a `processTemplateVersion: 1` bundle
(`mode: "extend"` only on id collision). Optional `labelSuffix` stamps every label
token so parallel teams on one repo don't cross-trigger. `materializeMembers:
false` writes stubs (config + `triggers.json`, no Matrix user/clone/container).
Process step lands on the template/draft gallery; role templates under
`/template-workspace/agent-templates/`. **Create-only** — grow via Flow editor or
**Add member**. Blocked when zero model providers exist
(`team-provider-check.js`). Detail: `docs/process-template-format.md`.

## Key Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | All four services + volumes |
| `.env` | Secrets: Matrix tokens, LLM proxy URL + auth token (gitignored) |
| `Makefile` | Build/start targets (`up`, `down`, `logs`, `build`, `ps`, `seed-*`) |
| `orchestrator/orchestrator.js` | Backend: agent lifecycle, container spawning, env-aware seeding, internal HTTP API |
| `orchestrator/spawn-container.js` | Spawns/kills per-agent Podman container over libpod; network + FS + volume + host-folder isolation |
| `orchestrator/spawn-kubernetes-*.js` | Kubernetes pod / plugin runtimes behind the `container-runtime.js` seam |
| `orchestrator/prompt-assembly.js` | Pure single source for system-prompt composition (ordering, gating, memory hint) |
| `orchestrator/agent-id-resolution.js` | Pure collision-free agent id resolution (`nextAvailableAgentId`, `suggestFreeAgentId`) |
| `orchestrator/team-conversion.js` / `team-of-one-migration.js` | Convert/migrate a standalone agent into a team of one |
| `orchestrator/agent-delete-plan.js` / `agent-orphans.js` | Fast/background delete + cascade; orphan detection |
| `orchestrator/teams-store.js` | Source of truth for the human Team data model (pure factory) |
| `orchestrator/resource-tier.js` | The one definition of the personal/team/system ownership triple (byte-identical in admin-console) |
| `orchestrator/agent-team.js` | Pure access-boundary accessor `resolveAgentTeam` (byte-identical in admin-console) |
| `orchestrator/skill-grants.js` / `skill-source.js` / `skill-commands.js` | Team-owned skill grant; two-tier resolution; custom slash-command projection |
| `orchestrator/credential-resolution.js` | Pure personal-credential runtime resolution (attributed-write preference + refusal) |
| `orchestrator/knowledge-digest.js` | Pure knowledge-digest builder (byte-identical to the entrypoint's `build_knowledge_digest`) |
| `orchestrator/context-browse.js` / `context-write.js` / `container-exec.js` / `tar-single.js` | Browse/write the `/context` mount inside the agent container |
| `orchestrator/github-poller.js` / `github-event-log.js` | Events-API polling (match/throttle/digest/fan-out); event-transparency log |
| `orchestrator/repo-sync.js` / `agent-repositories.js` | Repository propagation core; agent-scoped repositories |
| `orchestrator/plugin-*.js` / `broker-sdk/` | Plugin machinery (manifest, scope tokens, grants, sync, runtime, registry) + broker obligations SDK |
| `orchestrator/flow-anomaly-detector.js` / `hill-climb-*.js` | Flow stall classifier; hill-climbing metrics/cards/verdict loop |
| `orchestrator/admission-control.js` / `ticket-reconciler.js` | Per-flow WIP limit at dispatch; read-only GitHub-evidence ticket ledger |
| `orchestrator/internal-auth.js` | `:4002` gate: token classes + agent route allowlist |
| `orchestrator/setup.sh` | Register the admin Matrix user, print the access token |
| `agent-image/` | Per-agent image `as-agent:latest`; live runtime `scripts/agent-entrypoint.py` |
| `admin-console/api/api.js` | Express API: agents, environments, credentials, skills, models, mcp, teams, templates |
| `admin-console/api/scope.js` / `auth-mode.js` / `work-plane-access.js` | Resource scoping; single-user↔multi-user switch; work-plane tenant gate |
| `admin-console/api/auth.js` / `iap-auth.js` / `initial-admin-seed.js` | Login/session; IAP SSO bridge; first-boot System-Admin seed |
| `admin-console/api/audit.js` / `client-error-log.js` | Mutation audit trail; client-crash telemetry sink |
| `admin-console/api/process-template.js` / `draft-access.js` / `flow-copilot.js` | Bundle builders/validators; draft access model; Flow Copilot |
| `admin-console/src/pages/{ProcessCanvas,TeamSetup,EnvironmentTemplates,Plugins}.jsx` | Flows graph/editor; the wizard; env templates; plugin registry |
| `admin-console/src/components/{ErrorBoundary.js,VirtualList.jsx,nav-model.js}` | Error containment; list virtualization; sidebar nav model |

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

Matrix users are managed via the Conduwuit admin room
(`!cUxr0SyfINf9yEvBOD:local`); the orchestrator automates creation. Commands:
`!admin users list` / `create-user <name> <password>` / `deactivate @user:local`.
Continuwuity exposes no admin REST API — such commands are fire-and-forget and
the `/login` is the only success signal.

## Skills

Skills live in the skill-pool volume under `skills/<name>/SKILL.md`, granted per
**agent construct** (team `skills[]` / standalone `skills[]` / member
`skillsOverride`) via the create/edit forms, the wizard's Knowledge step, or the
Knowledge page. Environments have **no** skill picker. Intended domain: Mainframe
Migration (COBOL, JCL, DB2, IMS/VSAM).

### Two-tier skill pool

Resolved **team-first then global** at seeding (`orchestrator/skill-source.js`).
**Global**: `/template-workspace/skills/` (RO) = `/pool/skills/` (RW), writable by
System Admin or Team Admin of any team — promote, publish, import, merge,
create and edit all apply that one rule (#2178/#2180/#2307;
`skill-transfer.js`'s `requiredPoolWritePermission`). **Team**:
`/workspace/teams/<teamId>/skills/` (RW), Team-Admin-of-that-team-managed.
`/api/skills` tags `source` = `pool`/`team`/`agent`; `POST
/api/skills/promote-to-global` lifts a team skill into the global pool.

### Skill seeding & activation

Every seed writes a per-agent manifest
`/workspace/agents/<id>/.agent-studio/seeded-skills.json`. One-click
(de)activation is an **additive file sync, no respawn**
(`POST /internal/teams/:teamId/skills/{activate,deactivate}` → `planSkillSync`),
rebuilding each CLAUDE.md and mirroring into isolated volumes.

### Custom slash commands

A granted skill may carry a `commands/*.md` subdir; `orchestrator/skill-commands.js`
projects those into `.claude/commands/<skill>/<name>.md` (invoked `/<skill>:<name>`)
as an additive file sync. `GET /api/agents/:id/commands` lists them for the
composer palette. Reference: `docs/slash-commands.md`.

### Knowledge digest

Every KB-provisioned agent carries a generated **`knowledge-digest.md`** at its
workspace root, `@`-imported by the seeded CLAUDE.md so conventions + converged +
recent lessons are guaranteed in context at session start (`knowledge search` is
the long-tail complement). Deterministic, ~3k-token budget, one pure module kept
byte-identical on two sides (`orchestrator/knowledge-digest.js` ↔
`build_knowledge_digest()` in `agent-entrypoint.py`; golden fixture — change both
together). The `@`-import + unified semantic memory model are gated on a
provisioned KB checkout (autonomy ≥ 1); the legacy five-file memory model is the
autonomy-0/KB-less fallback. `users.md` is personal — never shared or migrated.
Concept: `docs/memory-knowledge-unification-concept.md`.

## MCP Servers (operator notes)

Reference servers ship under `mcp-servers/<id>/`; `make seed-mcp-servers` (chained
from `make seed-pool`) syncs them to `/template-workspace/mcp-servers/`. Add a
backend by: (1) drop a single-file MCP (stdio or http) under `mcp-servers/<id>/`,
(2) `make seed-mcp-servers`, (3) register via the **MCP Servers** admin page + bind
a credential + attach to environments. The `wiki/` reference server is tiny and
dependency-free — clone it as a starting point.
