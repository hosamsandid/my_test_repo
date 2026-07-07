# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**e-vgh-claw** is a local Matrix-to-Claude-Code stack for an enterprise context. It provides chat-based AI agents that can be extended with domain-specific skills for **Mainframe Migration** (COBOL, JCL, DB2, IMS, etc.).

The stack runs locally with Podman as a single compose file with these services:

1. **Conduwuit** — Matrix homeserver
2. **Orchestrator** — control-plane service that spawns and manages one Podman container per agent; no Matrix chat identity of its own
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
              ├── @cobol-agent:local      ← container: as-agent:latest
              ├── @java-agent:local       ← container: as-agent:latest
              └── @quality-gate:local     ← container: as-agent:latest (autonomous)

orchestrator.js  (control-plane container, no Matrix presence)
  ├── Manages agent lifecycle (create/update/delete via Admin Console)
  ├── Spawns ONE Podman container per enabled agent — over the Podman
  │     libpod socket (/var/run/podman.sock) via spawn-container.js,
  │     NOT in-process child processes
  ├── Provisions per-agent network + volume isolation, and reconciles
  │     live containers (by the `aee.agent.id` label) against its map
  ├── Uses the admin Matrix client to provision new agent users
  └── Internal HTTP API on :4002 for the admin console
```

- **Agents:** dynamically created Matrix users (e.g. `@cobol-agent:local`); each runs in its **own Podman container** (image `as-agent:latest`), spawned and lifecycle-managed by the orchestrator over the Podman socket
- DM room IDs persisted at `/workspace/agents/<id>/dm-room.json` (created lazily by the admin console)
- Agent configs persisted in `/workspace/agents/<id>/` (config.json + CLAUDE.md + AGENT-PROMPT.md)
- Each agent is bound to a **Working Environment** (see below) which defines what gets seeded into its workspace.
- Matrix users auto-created via Conduwuit admin room
- **Container-per-agent.** The `orchestrator` is a control-plane container that manages **one container per agent** — it does not host agents in-process. Each agent container is isolated three ways: per-agent **network** (Seam #2), per-agent **filesystem** via a SubPath mount of the pool volume (Seam #3, `AEE_WORKSPACE_ISOLATION`, default on), and an optional **dedicated volume** (`AEE_PER_AGENT_VOLUME`, opt-in). Containers carry an `aee.agent.id` label so the orchestrator reconciles live container state against its in-memory process map.
- **Agent runtime.** The agent container's entrypoint (`agent-image/scripts/agent-entrypoint.py`, with `sase_lib.py`) is a Python port of the legacy Node `orchestrator/agent-runner.js`. References to "agent-runner.js" elsewhere in this doc describe that behaviour (Matrix client + Claude CLI invocations + trigger scheduler), not the process actually running inside agent containers today.

### Teams (human collaboration & visibility scope)

A **Team** (the *human* grouping) is the tenant/scope that resources and human users are assigned to — the foundation of the multi-user concept. **Do not confuse it with the `role: "team"` agent construct**, which is always called an **Agent Team** (an agent squad working a repo); the two only share a word. The data model is three JSON collections under `/workspace` (`teams/`, `users/`, `memberships/index.json`), with these roles: **System Admin** (global, `user.systemAdmin` flag), **Team Admin** and **Team Member** (per-team membership roles). Every agent construct, Working Environment, and credential carries a `teamId` and is owned by exactly one Team (default: `default`).

**Resource scoping (#302).** List endpoints are filtered by the caller's team membership. `admin-console/api/scope.js` (`computeScope` / `visibleTeam` / `visibleAgent`, unit-tested) resolves the logged-in subject (from the #276/#374 session) to a scope: the **env admin** and any **System Admin** get `all: true` (full visibility — so the single-operator setup is unaffected); other users see only resources whose `teamId` is one of their memberships. `getScope(req)` reads the users/memberships indexes and is applied to `GET /api/{agents,environments,ssh-keys,github-tokens,mcp-servers,mcp-credentials,matrix/agents,skills}` (global/pool skills always visible). Agents also honour `visibility` (`private`→owner-only) + `ownerId`, inert until populated by #304. Enforcement on by-id reads and mutations, and SSO-driven identity, are follow-ups (#304/#307).

The single source of truth is `orchestrator/teams-store.js` (a pure, unit-tested factory). The orchestrator bootstraps the default team + an optional System Admin (`BOOTSTRAP_SYSTEM_ADMIN_SUBJECT` env) and backfills `teamId` onto pre-existing resources at startup. CRUD lives at `/internal/admin/{teams,users,memberships}` (orchestrator), proxied as `/api/admin/...` by the admin console — distinct from `/internal/teams/*` and `POST /api/teams`, which manage **Agent Teams**. The **Teams** admin page (`/teams`, `admin-console/src/pages/Teams.jsx`, #308) drives all of this: team CRUD, user CRUD, per-team role assignment, and reassigning agents/environments to a team (agent reassign added `teamId` to `PUT /api/agents/:id`). Per-role *enforcement* and list-filtering remain follow-ups (#302/#304). Full spec: `docs/teams-data-model.md`.

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
5. If the env has a repository, runs `git clone` — SSH URLs use `GIT_SSH_COMMAND` pointing at the env's SSH key; HTTPS GitHub URLs inject the GitHub token via `GIT_CONFIG_*` env vars
6. Builds a merged CLAUDE.md: base template + env section + agent prompt

SSH keys are stored at `/workspace/environments/_keys/<keyId>` (mode 0600) with metadata in `_keys/index.json`. The private key value is **never** returned by the API after creation; only its fingerprint.

#### Why both an SSH key and a GitHub PAT?

The two credentials are kept deliberately separate as **defense-in-depth** — they are not redundant.

| | SSH key | GitHub PAT |
|---|---|---|
| `git clone` / `fetch` at workspace seed (SSH URL) | ✅ via `GIT_SSH_COMMAND` | — |
| `git clone` / `fetch` at workspace seed (HTTPS GitHub URL) | — | ✅ via `GIT_CONFIG_*` env vars |
| `git ls-remote` probe (SSH URL, env editor) | ✅ | — |
| `git ls-remote` probe (HTTPS GitHub URL, env editor) | — | ✅ via `-c http.extraheader` |
| GitHub Events API polling (`github-poller.js`) | — | ✅ Bearer auth |
| `gh pr create` / commit / review (`gh-as-agent`) | — | ✅ via `GH_TOKEN` / `GITHUB_TOKEN` |

**Blast-radius separation.** The SSH key can be a per-repo, read-only deploy key — its scope is "clone this one repo". The PAT carries higher privileges (push, PR creation, API actions across everything the account can reach). Splitting them means a leaked SSH key can't merge PRs and a leaked PAT didn't already grant the initial repo clone path. For HTTPS-only repos the PAT covers both git I/O and API actions on the same credential — operators who want tighter blast-radius should prefer SSH URL repos with a deploy key.

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

**Team-Setup wizard.** The "Knowledge sources" step shows the team-wide MCP set read-only — it is inherited from the selected Working Environment (which binds servers to credentials); the step links to the environment editor for changes.

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

**Optional `emits` field (Process Canvas, #328).** Any trigger may carry an optional `emits: string[]` — the label tokens the trigger's run is expected to *set* (e.g. `["dispatch", "started:{{agentId}}"]`). It is purely declarative: the agent still sets the label itself at runtime; `emits` only records the outbound edge so the Process Canvas can draw "this trigger → label → the trigger that listens on it". The field is backwards-compatible (absent = unknown) and round-trips verbatim through `saveTriggers`. Role templates may author it (resolved per-member like `labelFilter`). It is never written silently: `GET /api/agents/:id/triggers/:triggerId/emit-suggestions` returns a heuristic draft derived from the prompt prose (`admin-console/api/emits-derivation.js`), and `PUT /api/agents/:id/triggers/:triggerId/emits` persists the operator-confirmed set.

**Process graph endpoint (Process Canvas, #329/#333).** `GET /api/process/graph` aggregates agents (or role templates) + their triggers into the orchestration graph in one call: `{ level, team, nodes, edges, gates, labels, lints }`. An edge `S→T` labelled `L` exists when a trigger of `S` *emits* `L` and a trigger of `T` *listens* on `L` via its **`labelFilter`**. Triggers that react to raw GitHub **events** (no `labelFilter`) are external (from an actor, not an agent emit) — recorded as `external: true` edges from `null` (the renderer drops them; lints ignore them). `human:*` gate labels and the brakes (`hold`, `needs:human`) have no agent emitter — their edges originate from `null` and are tagged (`kind: gate|brake`); `cron`/`once` become self-loop `timer` edges; orphan listeners (`orphan: true`) and dead-end emitters (`deadEnd: true`) are still represented. The `lints` array (advisory, never blocks) carries `orphan-listener`, `dead-end-emitter`, `unguarded-self-trigger` (a `github-event` trigger with no `from`), `competing-stage` (an agent emitting two `stage:*` labels), and `gate-violation` (an agent declaring emit of a `human:*` label — `error` severity). Levels: **live** (default, or `?team=<id>`) uses persisted `emits` only — deterministic, no silent derivation; **template** (`?templates=1` or `?templates=a,b`) reads the role-template catalog, keeps `{{var}}` tokens raw, and (unless `?derive=0`) falls back to the #328 heuristic so the blueprint shows wiring before emits are set. Pure builder + `computeLints` in `admin-console/api/process-graph.js`.

**Process templates (export/import/materialise, #334).** `GET /api/process/template?team=<id>|?templates=1` exports a portable, git-committable **bundle** (`processTemplateVersion: 1` — roles with persona prompt + triggers incl `emits`, gates, label registry; no repos/secrets). `POST /api/process/graph` `{processTemplate}` builds a graph from a bundle so the canvas renders an imported blueprint (read-only). Materialising feeds the bundle to `POST /api/teams` under `processTemplate` (or `customRoles`): inline roles run through the **same** env→team→members pipeline (with rollback) the Team-Setup wizard uses — each role's `{{vars}}` and the target repo applied per member. Pure builders/validators in `admin-console/api/process-template.js` (`buildProcessTemplate`, `validateProcessTemplate`, `templateToCustomRoles`); format documented in `docs/process-template-format.md`. The Process Canvas supersedes the old static workflow-diagram modal, which has been removed.

**Process Canvas lives inside Flows.** The Process Canvas is not a standalone page anymore — it is embedded in the **Flows** view (`/flows`, `admin-console/src/pages/Briefings.jsx`). The old scope dropdown is gone; scope selection moved to the Flows left list, which lists **Teams** (live process graphs), **Drafts**, the read-only **Role-templates** blueprint, and the legacy **BriefingPack flows** (Orchestrator agents → `BPGraph`). A **New process** button there creates a draft. The graph/editor itself is the named export `ProcessGraphPanel` in `admin-console/src/pages/ProcessCanvas.jsx` — a controlled component driven by a `scope` prop (`'all' | '<teamId>' | 'templates' | 'draft:<id>'`) with `onNavigate` / `onDraftsChanged` callbacks. Flows tracks the selected process scope in the `?proc=` query param and BriefingPack flows in `?flow=`. The `/process` and `/process/:teamId` routes now redirect to `/flows` (the latter with `?proc=<teamId>`); there is no longer a "Process Canvas" nav entry.

**Process drafts (Process Canvas v2, #344).** A *draft* is an editable process-template bundle that exists **before** any team is materialised — the basis for authoring a process from scratch. CRUD at `/api/process/drafts[/:id]` (GET list / POST create / GET / PUT / DELETE), persisted at `/workspace/process-drafts/<id>.json` (pure document storage, no agent/Matrix side effects; traversal-guarded slug ids). Drafts allow an **empty** `roles` set (work-in-progress) — `validateProcessTemplate(bundle, { allowEmptyRoles: true })` — whereas materialisation via `/api/teams` stays strict (non-empty). The graph for a draft is derived through the existing `POST /api/process/graph { processTemplate }` (also relaxed to allow empty roles). `emptyDraftBundle()` + the relaxed validator live in `admin-console/api/process-template.js`. The Process Canvas's **draft mode** (#345) edits drafts in place: a write-target adapter (`admin-console/src/pages/process/edit-adapters.js`) routes the shared dialogs/inspector to either `liveOps` (HTTP to running agents) or `makeDraftOps` (mutate the bundle + PUT it); the scope selector gains a Drafts group + "＋ New process…", and an **Add role** toolbar action adds free-form roles (no catalog dependency). There are no dedicated PR-review / human-approval toolbar buttons any more: a PR reviewer is a plain per-invocation role consuming a GitHub PR channel (#380), and a **human-approval gate** (#346) is authored on the edge itself — an inline `gate: 'human'` on a channel, or a `human:*` label listener via the label / GitHub-trigger dialogs.

**LLM-assisted agent-prompt authoring (Add role dialog).** Writing each role's system/agent prompt by hand is tedious, so the **Add role** dialog carries a *Notes* field plus a **Generate agent prompt** button (`AddRoleDialog` in `admin-console/src/pages/ProcessCanvas.jsx`). It POSTs `{ roleName, notes }` to `POST /api/agent-prompt/generate` (`admin-console/api/api.js`), which resolves an LLM target (`resolveGenerationTarget`: a registered Model Provider endpoint, preferring a Sonnet-class model, else the `ANTHROPIC_*` `.env` fallback), issues one stateless `/v1/messages` call (`buildMessagesUrl` + `httpPostJson`), and returns `{ prompt, model }`. The role name alone is often enough context (e.g. "Business Analyst"); notes are optional keywords. The draft lands in the editable *Agent prompt* textarea — nothing is persisted server-side.

**Unified role-connecting (live == draft).** Wiring roles together works identically on a live team and a draft: one `CreateEdgeDialog` offers the same edge types in both modes — **GitHub PR/Issue channel** (`on: 'github'`, #380), **label hand-off**, **data flow / hand-off** (the plain **dependency** is folded into this dialog — leave the artifact name empty; the BP viewer keeps dependency + artifact as separate path-based types, since BPs have a defined state and fixed artifact paths), **parent/child** — and the shared `ConnectionsSection` (`admin-console/src/pages/process/ConnectionsSection.jsx`, in both the draft and the live node inspector) lists + removes them and sets parent/stage. Every edge is also **clickable on the canvas** (`flow-graph-render.js` `addEdgeHit`): the type-aware `EditHandoffDialog` edits a label hand-off, edits/removes a GitHub PR/Issue channel (`on: 'github'`, #380), removes a dependency / data-flow port / parent link, and shows other derived edges read-only. Clicking is gated on the graph being editable, and the BP viewer (`FlowGraph.jsx`) wires no `onSelectEdge`, so its edges stay non-clickable (removal there is via the node inspector). The **declarative ports are the single source of truth** for these edges: `emits` (label), `dataFlow.{dependsOn,inputs,outputs}` (dependency/data flow, live) ≡ role `dependsOn/inputs/outputs` (draft), `parentMemberId` ≡ role `parent`, and `stage`. `liveOps` writes only these ports via `PUT /api/agents/:id` (which now accepts `dataFlow`, `parentMemberId` — cycle-guarded — and `stage`), so it is shape-compatible with `makeDraftOps`. The **functional** data-flow push triggers are *derived* from the ports, not authored: a draft derives them at materialise time (`expandDataFlowSteps`), and a live team derives them eagerly on every `dataFlow` write via `reconcileTeamDataFlow` (same pure builder, best-effort, idempotent — regenerates the `<consumer>-on-push-<upstream>` triggers, leaving manually-authored data-flow triggers untouched). Net: the editor never branches on mode, and there is no separate trigger bookkeeping when connecting roles. A human approval is authored as a `human:<slug>` listener (`from: humans`) on the chosen downstream step — it renders as the red gate node and can never trip `gate-violation` because no agent emits it.

**Artifacts matched by logical name + runtime manifest (#382).** Agent artifact ports are `{name, hint?, description?}`: producer↔consumer are matched on the **logical name**, not the physical path (`artifactKey(a) = a.name || a.path` in `process-template.js`, reused by `unified-graph.js`/`api.js`/UI). This is because a re-instantiable agent writes to a path that varies per run (or a whole directory, or something unknowable up front), so `hint` is only informative. A port carrying only `path` (BriefingPack artifacts + legacy team ports) still matches by path exactly. The real location is resolved at **runtime** from a git-committed manifest `.aee/artifacts.jsonl`: the producer records what it actually made with `aee-artifact add "<name>" <path>` (CLI at `agent-image/scripts/aee-artifact`, on the agent PATH; guidance in `agent-image/CLAUDE.md`) and commits+pushes it; the derived `<consumer>-on-push-<upstream>` trigger's prompt (`dataFlowPrompt`) tells the woken consumer to `git pull` and `aee-artifact path "<name>"` to find it, and to flag a missing artifact to the user rather than guess. Still a wake, **not** a start-gate — nothing blocks a downstream agent from running (agents have no "completed" state; that gating lives only in the BP world).

**Draft ⇄ team round-trip (Process Canvas v2, #348).** From a draft, **Materialize…** opens the v1 `MaterializeDialog` with the draft bundle and feeds it to `POST /api/teams` (`processTemplate`) — the same env→team→members pipeline (with rollback) the Team-Setup wizard uses. From a live team scope, **Edit as draft** calls `GET /api/process/template?team=<id>`, creates a draft seeded with that bundle plus a `sourceTeamId` marker, and switches to draft mode. When a draft carries `sourceTeamId` the dialog defaults `teamId` to it and ticks **extend** (`mode: 'extend'` — adds only the missing roles), so iterating on an existing team's process adds new members without colliding; a fresh draft defaults to `create` and surfaces a 409 on id collision. (Legacy PR-review `kind`/`review` meta is normalised onto GitHub PR channels per #380, so a re-imported team shows reviewers as plain agents consuming a PR channel.)

**Stage/lane view (Process Canvas v2, #349) — REMOVED.** The ordered-**stages** authoring view (a `Graph ⇄ Stages` toggle that generated wiring from a `stages[]` list via `buildStageBundle`) has been removed — it was superseded and caused confusion. `StageView.jsx` / `stage-model.js` are gone. Stages are now assigned **manually per node** in the graph view: each node carries an optional `stage` that inherits from its parent (`effectiveStage`, see the draft inspector), rendered as optional bands. The graph view and all its editing (add role, PR review, human approval, wire label/data-flow/dependency/hierarchy edges, materialize, import/export) are unchanged.

**Layered layout + ordered stages (Flows readability).** Every flow — process, draft, member trees, BP packs — is laid out as an ordered **layered DAG** (the old BP tree layout is gone): `admin-console/src/pages/process/flow-layout.js` (pure, unit-tested — `computeFlowLayout` + `assignCrossCoords`) breaks rework cycles, assigns columns via longest-path layering (sources → sinks, so there's a visible start/end), reduces crossings with a median sweep, and aligns the cross axis via isotonic regression. Parent-child hierarchy participates in the layering: all children of one parent form a **sibling group** (`groupOf` option) that shares one column and stays contiguous within it (cluster contraction for the layering, block-wise median sort for the ordering), so a hierarchy reads as a clearly grouped row/column next to its parent; the gray hierarchy edge is drawn as a label-free, arrowless **bezier fan** beneath the process wiring (it takes no channel lanes/ports — the grouped layout guarantees the curves cross nothing), visually separating structure from work hand-offs. Children stay expandable per parent card (`Children (n)` toggle) — process/team views expand them by default (`expandChildrenByDefault` on `initFlowGraph`; user collapses survive data refreshes), BP-workspace views keep collapsed-by-default. A draft may carry an ordered **`stages: string[]`** on the bundle (schema in `process-template.js` — `buildProcessTemplate`/`validateProcessTemplate`/`emptyDraftBundle`; surfaced to the client via `stages` on the `POST /api/flows/graph` response). Stages **partition** the flow axis: every stage owns a contiguous, exclusive block of columns (as many as its internal flow needs), blocks ordered by the defined stage order — stages seen on nodes but missing from that order are appended in graph-flow order, so stage bands can never overlap even without an authored order. Unstaged nodes gravitate to their neighbours. Authored in the Flow editor via **StageManager.jsx** (a drag-reorderable ordered list, opened by the *Stages* toolbar button; draft ops `addStage`/`renameStage`/`removeStage`/`reorderStages` in `edit-adapters.js`); each node's stage is picked from a dropdown of defined stages in `DraftNodeInspector.jsx`. **Carried through `/api/teams` materialisation** so a materialised team reproduces the draft's stage layout: each role's `stage` rides on the member config (via `templateToCustomRoles` → the member-create body → `addTeamMember`), and the ordered `stages` list is stored on the **team agent** config (`createAgent` role `team`, from the `stages` field on `POST /internal/agents`). The live graph reads both back — per-node `stage` from each agent config and the top-level ordered `stages` from the team agent config — and returns `stages` on the `GET /api/flows/graph?team=<id>` response (same shape the draft's `POST /api/flows/graph` returns), so the renderer's layered layout matches. `GET /api/process/template?team=<id>` also exports the team's `stages` + per-role `stage`, so **Edit as draft** round-trips the layout. (Fresh materialisation, `mode: create`, is the covered path; `mode: extend` keeps the existing team's stored stage order.)

**GitHub PR/Issue channels (Flow Designer, #380).** The way agents hand work off over GitHub — opening an **Issue** or a **Pull Request**, and the labels/human-approvals that route them — is modelled as first-class, editable graph elements. Two declarative ports on a role/agent (siblings of `emits`, `dataFlow`, `parentMemberId`, `stage`): `github: { producesPr?, producesIssue? }` (what a role *opens* — drives the node's PR/Issue badge + draggable output ports, and appends an idempotent marker-delimited "open a PR/issue" block to its prompt at materialise) and `channels: [{ artifact: 'pr'|'issue', from, label?, gate? }]` on the *consumer* (which producer's PR/issue it reacts to; optional routing `label`; `gate: 'human'` = a human applies that label — the inline approval gate rendered on the edge). The ports are the single source of truth: `expandGithubChannels` (in `process-template.js`) derives the consumer's github-event trigger `<consumer>-on-<artifact>-<producer>` (marked `channel: true`) at materialise, and a live team re-derives eagerly on every `channels` write via `reconcileTeamGithubChannels` (mirrors `reconcileTeamDataFlow`). The graph builder emits an `on: 'github'` edge (producer→consumer, artifact/label/gate) from the port in `unified-graph.js`; `buildProcessGraph` skips `channel: true` triggers so they aren't double-drawn. Lints: `producer-unconsumed` (opens PR/issue nobody consumes), `channel-from-non-producer`. On the canvas (`flow-graph-render.js`) a producer node shows PR/Issue output ports you drag onto another node (`onConnectChannel` → `CreateChannelDialog`); channel edges are clickable (`EditChannelDialog`). Both draft and live are wired identically through `edit-adapters.js` (`setGithubProduces`, `addChannel`/`removeChannel`/`updateChannel`). **Supersedes the old `kind: 'pr-review'` construct** (#347, removed): a reviewer is now a plain per-invocation role consuming a PR channel; legacy `pr-review` bundles/drafts are mapped onto channels on read/import/materialise via `normalizeLegacyReview`. *Caveat:* the GitHub Events API reliably delivers `issues.labeled` but PR-label delivery (`pull_request.labeled`) is not guaranteed — issue-based human gates are the safe default.

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
3. For each orchestrator: force-pull its briefings clone (so bp-explorer reads up-to-date `brief.md` files), then build the dependency graph via `loadBriefingsGraphFromExplorer()` — this calls bp-explorer's `GET /api/briefings` and translates the response with `bpsToBriefingsMap` (`orchestrator/briefings-graph.js`). The `artifacts/briefings/.index.json` file is no longer used.
4. For each event, compute affected BPs:
   - **`depends-on` dependents** — any leaf BP whose `depends-on` array contains the event's BP hash.
   - **input-artifact dependents** — any leaf BP with an `artifacts[]` entry where `direction: input` and `path` matches a `direction: output` path of the event's BP.
5. For each affected BP, locate its bp-instance stub. Apply the agent's `bp-trigger-policy` (see below), then `enableAgent` (idempotent — materializes stubs, respawns disabled agents) and append a `bp-event-batch` entry to its `pending-triggers.json`.
6. Add an awareness entry to the hosting orchestrator's `pending-triggers.json` listing all downstream effects.

**`bp-event-batch` is not a triggers.json type.** It's a `kind`-tagged entry that the agent-runner's drain loop handles inline (`executeBpEvent`) — no triggers.json registration required.

**Situation classification.** Before enqueuing, the orchestrator inspects the affected BP's current status in the briefings graph (loaded from bp-explorer) and tags each `bp-event-batch` entry with one of:

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

1. Opening the dialog calls two endpoints in parallel: `GET /api/agents/:id/handover/candidates` (proxy to the orchestrator's briefings graph, sourced from bp-explorer's `/api/briefings`) and `GET /api/agents/:id/handover/git-status` (per-repo `branch`, `head`, `headSubject`, `upstream`, `ahead`/`behind`, `dirty`, `pushed`, `ready`).
2. The dialog renders a per-repo pre-flight card. The submit button is disabled while any repo is dirty or has unpushed commits, unless the user opts into an explicit override (checkbox + free-text reason that gets quoted into every target's hand-off note).
3. Two pre-flight buttons — **Ask agent to commit & push** and **Ask agent to push pending commits** — POST `/api/agents/:id/handover/nudge` which posts a canned prompt into the source agent's own DM. The agent does the git work itself, the chat history captures the audit trail, and a **Re-check** button refreshes the git status without closing the dialog.
4. On submit, `POST /api/agents/:id/handover` re-fetches git-status server-side and returns `409 git-not-ready` unless the workspace is ready or the override carries a reason — a stale browser snapshot cannot bypass the gate.
5. For each target, the server materializes/enables the stub, ensures a DM room, and posts a structured Markdown body containing: the source-of-work block (per repo: name, branch, `headShort`, last-commit subject, remote URL, upstream, dirty markers), input-artifact paths from the briefings graph when present, the user's free-text note, the override reason (if any), per-target consistency warnings, and an explicit "Before you start" checklist (`cd <repo> && git fetch && git checkout <branch> && git pull --ff-only`, `git log --oneline -5`, confirm with user). The receiving agent picks the message up via the standard DM heuristic.
6. **Repo consistency check.** Each target's environment is compared against the source repos: missing repo URLs and branch mismatches surface as warnings both inline in the DM body (so the receiving agent reads them) and in the dialog's per-target results list (so the user sees them).

### Admin Console authentication (#276)

The whole console is gated by a login screen — every `/api/*` data endpoint requires a valid session cookie (`admin-console/api/auth.js` registers public `POST/GET /api/auth/{login,session,logout}` then mounts `auth.gate` over `/api`). A single env-configured credential pair (`ADMIN_USERNAME` / `ADMIN_PASSWORD`, default `admin`/`admin`) is checked by `verifyCredentials()`, which is the **only** seam an SSO/OIDC integration replaces; the HMAC-signed HttpOnly cookie (`aee_session`), the gate, and the React `AuthProvider` + `Login` screen are provider-agnostic. Static assets and the SPA fallback stay open so the login screen can load. See `docs/admin-console.md` → *Authentication* and `docs/multi-user-concept.md`.

**Per-user local passwords (#374, interim).** Users created on the Teams page can be given a local scrypt password (stored on the user record in the orchestrator's teams-store, never returned by the API). The login route checks the user store first (match by `subject`, via the orchestrator's internal `POST /internal/admin/users/verify`), then falls back to the env admin — best-effort, so the env admin always works even if the orchestrator is down (no lock-out). A per-user session's `sub` is the user's `subject`, so audit (#305) names the person. Set via Teams → Manage Users (🔑). Superseded by SSO (#307).

### Admin Console audit trail (#305)

Every mutating `/api` request (`POST`/`PUT`/`PATCH`/`DELETE`) is recorded as one append-only JSONL line at `/workspace/audit/audit-<date>.jsonl` (override via `AUDIT_DIR`). `admin-console/api/audit.js` exposes `auditMutations` — a global middleware mounted **before** the auth gate (so it sees denied/unauthenticated attempts too) that logs from a `res.on('finish')` handler reading the acting human from `req.user` (#276). Each entry carries `ts, actor, action, method, resource, teamId (best-effort from body, pending #302), status, outcome, ip`. Logging is strictly best-effort — wrapped so it can never block or break a request. Read via `GET /api/audit?limit=<n>` (protected, newest-first). Matrix chat history is intentionally **not** the config-mutation audit log. See `docs/admin-console.md` → *Audit trail*.

### Agent Management

All agent lifecycle operations (create / enable / disable / edit prompt / delete) happen via the **Admin Console** at `http://localhost:4000`.

### Team-Setup wizard

`POST /api/teams` (driven by the **Team Setup** wizard at `/team-setup`) materialises a team-shaped agent group in one atomic-with-rollback transaction. The wizard sits on top of the existing `team` / `team-member` machinery — the result is identical in shape to a manually-created team plus members. The wizard's first step picks an existing **Working Environment** (card grid: name + repo/skills summary; empty state links to `/environments`) and sends its id as `environmentId` — the backend resolves repository, branch, SSH key, PAT and the MCP set from the env and skips env auto-creation. The team name + id are then pre-filled from the env's name (uniqueness-resolved against existing agent ids / team names; both editable). The API also still accepts the legacy direct inputs (`repository` (URL, branch, `sshKeyId`) + `githubTokenId` + `mcpServers`), which auto-create an env id `<teamId>`; the wizard only uses that path as an extend-mode fallback for pre-env-reuse teams. Common to both: a `teamId` slug and team name; in create mode the wizard additionally ships a **process-template bundle** from the Process step below (extend mode still sends a list of role templates with instance counts).

**Process-first creation (#419–#424, `docs/wizard-flow-integration.md`).** In create mode the wizard's 4th step is the **Process** step (`admin-console/src/pages/team-setup/StepProcess.jsx`) — the flat role-checkbox list is retired there (extend mode keeps it, since role *instance counts* are a roles-array concept). It produces one `processTemplateVersion: 1` bundle via three entries:

1. **Use a template** — gallery of curated process templates (registry `orchestrator/skill-pool/process-templates/` → `make seed-process-templates` → `GET /api/process-templates[/:id]`; ships `core-sdlc` + `extended-sdlc`, CI-guarded to render lint-clean) plus saved process drafts.
2. **Compose a process** — stage columns with Scout/Author/Companion slots (the reduced per-stage pattern *Scout (gap+evidence) → Author → Companion (review, feedback routing, escalation)*) plus intake/standalone extras and **custom roles** (LLM-drafted prompt via `POST /api/agent-prompt/generate`, suggested wiring via `POST /api/agent-ports/suggest` with a keyword-heuristic fallback in `admin-console/api/port-suggestion.js` — always user-confirmed). The selection is wired live by the **Flow-Weaver** (`admin-console/api/flow-weaver.js`, `POST /api/process/weave`): a deterministic, pure engine that chains stages via human-gated (opt-out per boundary) `<prefix>:approved` issue channels, generates the intra-stage `<prefix>:author-go` / `<prefix>:escalate` loops + rework/human-feedback triggers, auto-staggers self-curation crons, and compensates gaps (missing Companion/Scout duties merge into the Author via a marker-delimited *Wiring notes* prompt block; passive stages are skipped by the chain; every rule is surfaced in `notes[]`). Its tested contract: the woven bundle is **lint-clean** (zero error/warning lints). Catalog roles carry the composition surface for this (**catalog v2**, `admin-console/api/catalog-ports.js`): `patternRole` / `stageAffinity` / `ports` (abstract slots `stage-entry` / `stage-author`), and `intrinsic: true` on essence triggers — non-intrinsic dispatcher wiring is dropped when composing; generic pattern templates `scout` / `stage-author` / `stage-companion` ship in the catalog (`category: "pattern"`).
3. **Start blank in the canvas** — creates an empty draft and jumps to `/flows?proc=draft:<id>`.

The step shows an inline SVG flow preview + authoritative lints (`POST /api/flows/graph`); error lints block submission. Exits: **Create team** (`POST /api/teams/stream`, which now has full `processTemplate`/`customRoles`/ports parity with `POST /api/teams`) or **Save as draft** (canvas round-trip). Bundle-path collisions stay on the bundle: the collision card re-submits with `mode: "extend"`, adding only missing members.

Role templates live as JSON files under `/template-workspace/agent-templates/` (seeded from `orchestrator/skill-pool/agent-templates/` via `make seed-templates`). The catalog ships with these dispatcher-pattern roles (plus the generic pattern trio above):

| Role | Session | Trigger | `from` |
|---|---|---|---|
| `business-analyst` | persistent | — (DM only) | — |
| `developer` | per-invocation | `issues.labeled` (`assigned:<agentId>`) | any-except-self |
| `code-reviewer` | per-invocation | `pull_request.opened/reopened` | any-except-self |
| `security-reviewer` | per-invocation | `pull_request.opened/reopened` | any-except-self |
| `test-reviewer` | per-invocation | `pull_request.opened/reopened` | any-except-self |
| `documentation-sync` | per-invocation | `pull_request.closed` (merged) | any-except-self |
| `issue-triage` | per-invocation | `issues.opened` | humans |
| `generic` | persistent | — (DM only) | — |

Each `per-invocation` role also ships a weekly self-curation cron (staggered 5min apart) that reviews and prunes the agent's `memory/`.

**Materialisation flow:**
1. One shared Working Environment: the reused env when `environmentId` is supplied (kept untouched, keeps its own id), else auto-created under id `<teamId>` carrying the repo, SSH key, PAT, and an empty skill set.
2. One `team` agent id `<teamId>` with a generic shared `systemPromptTemplate` and `skipFirstMember: true` (so the wizard adds members itself with role overrides instead of getting an auto-numbered `<teamId>-1`).
3. One `team-member` agent per selected role, id `<teamId>-<roleId>`. Each member carries:
   - `systemPrompt` = role-specific prompt from the template (override against the team default).
   - `skillsOverride` deliberately omitted in v1 — members inherit the team-env's empty skill list. Once role-specific skill packs ship they slot in here.
   - `sessionPolicy: per-invocation` (for reactive roles).
   - Full `triggers.json` rendered from the template (`{{repoFullName}}` and `{{agentId}}` substituted per-member), with `from` filter and `repo` set to the team's repo.
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

**Workspace browser.** The right rail's second tab is a read-only file explorer over `/workspace/agents/<agentId>/`. It calls `GET /api/agents/:agentId/workspace/tree?path=<rel>` for lazy directory listings, `GET /api/agents/:agentId/workspace/file?path=<rel>` for inline content, and `GET /api/agents/:agentId/workspace/download?path=<rel>` to trigger a browser file download (`Content-Disposition: attachment`, `application/octet-stream`; no size cap). All three endpoints reject any path that resolves outside the agent root (path traversal, escaping symlinks). File reads are capped at 512 KB and binary files (NUL byte in the first 8 KB) are flagged so the UI can show a placeholder instead of garbled text. A per-file download button fades in on hover for every file row (text and binary alike). The tab is intended as an at-a-glance peek at memory files, skills and the cloned repo — agent-side edits should still go through the agent itself.

**Markdown safety.** Agent output is sanitized with `rehype-sanitize` using the GitHub-flavoured `defaultSchema`, extended only to allow `style` and the `data-*` attributes that `rehype-pretty-code` emits on `span` / `code` / `pre` / `figure` / `div`. Sanitize runs *after* pretty-code in the rehype pipeline so the syntax-highlighting markup survives. Code blocks ship both Shiki themes (`github-light`, `github-dark`); the active theme is selected by CSS rules in `admin-console/src/theme/tokens.css` keyed off `<html data-theme>`.

## Key Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | All four services + volumes |
| `.env` | Secrets: Matrix tokens, LLM proxy URL + auth token (gitignored) |
| `Makefile` | Build + start convenience targets (`make up`, `make down`, `make logs`, ...) |
| `orchestrator/orchestrator.js` | Backend service: agent lifecycle, child-process spawning, environment-aware workspace seeding, internal HTTP API for the admin console |
| `orchestrator/spawn-container.js` | Spawns/kills the per-agent Podman container over the libpod socket; provisions per-agent network (Seam #2), filesystem SubPath (Seam #3), and dedicated-volume (`AEE_PER_AGENT_VOLUME`) isolation. |
| `orchestrator/teams-store.js` | Single source of truth for the human **Team** data model (#299): pure factory for Teams / users / memberships CRUD, referential integrity, default-team + System-Admin bootstrap. Unit-tested in `teams-store.test.js`. See `docs/teams-data-model.md`. |
| `agent-image/` | The per-agent container image `as-agent:latest` (`python:3.12-slim`). Entrypoint `scripts/agent-entrypoint.py` (+ `sase_lib.py`) is the live agent runtime — a Python port of `agent-runner.js`. |
| `orchestrator/agent-runner.js` | **Legacy** Node per-agent runner: Matrix client + Claude CLI invocations + trigger scheduler. Behaviour ported to `agent-image/`'s Python entrypoint (the process actually run in agent containers); kept as the reference for that behaviour. Honors `sessionPolicy: per-invocation` and posts plain-text throttle warnings on `kind: throttle-warning` queue entries. |
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
| `admin-console/src/pages/TeamSetup.jsx` | UI: 5-step wizard (Working Environment → Team → Knowledge → Process → Review) that drives `POST /api/teams(/stream)` with `environmentId`. |
| `admin-console/src/pages/team-setup/StepProcess.jsx` | UI: the wizard's Process step (#422) — template gallery, stage composer with custom-role dialog, flow preview + lints. |
| `admin-console/api/flow-weaver.js` | Deterministic wiring engine (#421): stages + catalog-v2 roles → lint-clean process-template bundle (`POST /api/process/weave`). |
| `admin-console/api/catalog-ports.js` | Catalog v2 (#420): normalises `patternRole` / `stageAffinity` / `ports` + `intrinsic` trigger filtering on agent templates. |
| `admin-console/api/process-template-registry.js` | Curated process-template registry (#419): `orchestrator/skill-pool/process-templates/` → `GET /api/process-templates`. |
| `admin-console/api/port-suggestion.js` | Wiring suggestion for custom roles (#423): LLM parse + keyword heuristic behind `POST /api/agent-ports/suggest`. |

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

### Two-tier skill pool (#306)

Skills live on two tiers, resolved **team-first then global** at agent seeding:

| Tier | Path | Managed by | Visibility |
|---|---|---|---|
| **Global** | `/template-workspace/skills/` (orchestrator, RO) = `/pool/skills/` (admin-console, RW) | System Admin | All teams |
| **Team** | `/workspace/teams/<teamId>/skills/` (both mount `agent-pool-workspace` at `/workspace`, RW) | Team Admin | That team's agents only |

`orchestrator/skill-source.js` (`makeSkillSourceResolver`, unit-tested) does the resolution: `seedAgentWorkspace(id, env, { teamId })` copies each `env.skills` name from the owning team's pool when present, else the global pool — so a team with no own pool behaves exactly as before. The admin-console `/api/skills` endpoints carry a `source` of `pool` (global) / `team` (+`teamId`) / `agent`: `GET /api/skills[?teamId=]` lists global + team skills tagged with tier; POST/PUT/DELETE accept `source:'team'`+`teamId`; `POST /api/skills/promote-to-global` lifts a team skill into the global pool (two-stage promotion, relates to #173). The Skills Registry UI exposes the tier (Global/Team), a target selector on create, team-skill edit/delete, and *Promote to global*. Membership-based filtering of which team skills a caller sees is a follow-up (#302).

## MCP Servers (operator notes)

Reference servers ship in-repo under `mcp-servers/<id>/`. `make seed-mcp-servers` (chained from `make seed-pool`) syncs them into the pool volume at `/template-workspace/mcp-servers/`. Operators add new servers through the **MCP Servers** admin page (catalog + credentials), and Working Environments / team-members reference them by id. Adding a new backend (vector store, graph DB) is a matter of:

1. Drop a new server under `mcp-servers/<id>/` (any single-file MCP, stdio or http).
2. `make seed-mcp-servers` to copy it into the pool.
3. Register it via the admin UI; bind a credential; attach to environments.

The wiki reference server is intentionally tiny and dependency-free so that "what's the contract" is readable at a glance — clone it as a starting point for the next backend.
