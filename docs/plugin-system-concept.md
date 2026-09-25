# Plugin system — governed capability extensions beyond the agent container

> Status: concept — decided 2026-08-05. Epic #1368; phases #1369 (core
> machinery), #1370 (agent surface), #1371 (plugin #1 — #1287 rework),
> #1372 (Broker SDK), #1373 (plugin #2 — test management), #1374
> (built-in CLI contract alignment).
> Decision: agents gain access to the outside world (test-management systems,
> container runtimes, mainframe bridges, …) **only** through registered
> plugins. A plugin pairs a **privilege-holding sidecar container** (the
> broker) with a **dependency-free CLI facade** seeded into the agent
> workspace. MCP is deliberately **not** the agent-facing surface.
> Sequencing: this infrastructure is built first; PR #1287 (built-in
> `podman-mcp`) is then reworked on top of it as plugin #1 (§6).
> Revised 2026-08-07 after review: per-grant **scope granularity** with
> agent-level isolation (§4.4/§4.6), **scope discovery + role-aware routes**
> for plugin UIs (§4.8), and an explicit **MCP screening rule** for the
> catalog (§8).

## 1. Problem

Two real requests forced the question:

1. **Test management** — agents should create test cases, trigger test runs
   and manage test data in an external test-management system, ideally
   surfaced inside the Admin Console.
2. **Container spawning** — agents should be able to start further Podman
   containers. The first attempt simply punched a hole into the agent
   container (socket access), destroying the isolation story; PR #1287 then
   built a proper broker — but as a hardcoded platform special case.

Both are instances of one general demand: *agents need governed connections
out of their container*. Building each connection as a bespoke platform
feature does not scale — every new backend would touch `docker-compose.yml`,
`orchestrator.js` seeding, `prompt-assembly.js`, Platform Settings and the
agent image. The platform needs one extension seam instead: **plugins are
registered, granted, and audited; the platform stays generic.**

Non-goals: plugins never become load-bearing for the platform itself. Flow
primitives (`aee-emit`, `aee-artifact`, `gh-as-agent`) and the knowledge
system stay built-in (§7).

## 2. Prior art this design reuses

| Building block | Where | Reused for |
|---|---|---|
| CLI facade over an internal API | `knowledge`, `aee-artifact`, `aee-emit`, `gh-as-agent` (`agent-image/scripts/`) | the agent-facing plugin surface |
| Registry + separate credential store | `/workspace/mcp-servers/`, `/workspace/mcp-credentials/_keys/` | plugin registry + plugin credentials |
| Per-agent network isolation with attachable services | `AEE_PER_AGENT_NETWORK_SERVICES` seam in `spawn-container.js` | wiring a sidecar into granted agents' networks only |
| Team-owned grants, no env coupling | `skill-grants.js` (`effectiveSkills`) | plugin grant resolution |
| Additive file sync, no respawn | `planSkillSync` + skill activate/deactivate | CLI + config seeding on grant change |
| Gated CLAUDE.md section, rebuilt on config change | context-mount block (#1286), `prompt-rebuild` | plugin capability one-liners |
| HMAC scope tokens, team-scoped | `podman-token.js` (PR #1287, nearly generic already) | per-agent plugin identity |
| Least-privilege broker sidecar | `podman-mcp/` (PR #1287) | the reference broker implementation |
| Standalone viewer beside the console | bp-explorer | optional plugin UI (iframe, proxied) |
| Broker-side JSONL observability | `github-event-log.js` pattern | plugin audit obligation |

## 3. Core decisions

**Why a plugin layer at all, and not just more MCP servers.** The MCP
registry already wires backends per environment — but it stops exactly where
governance begins. Two things are missing, and neither is an MCP concern:
a **management surface for differentiated permissions** per team and per
agent, and **credential fan-in** — one credential registered once in the
target system rather than a fresh one minted per agent, which is what
per-agent authorisation would otherwise force on the operator. The broker
supplies both: it holds the single backend credential and mints per-scope
tokens in front of it. Authorisation granularity thereby becomes a platform
concern, while the target system keeps seeing one well-known identity.

**Naming.** "Plugin" in this document always means a **platform plugin**: a
registered sidecar + CLI extension of the Agent Studio platform itself. It is
*not* a Claude Code plugin (the CLI's own marketplace format bundling skills,
commands, hooks and MCP servers), which the platform may separately adopt as
a distribution channel for agent-side content. If both ever coexist, the
terms are **platform plugin** vs. **agent plugin**; unqualified "plugin"
means the platform one (§10).

**CLI-first, not MCP.** Agents demonstrably work better with CLIs than with
MCP tools (composable in Bash, no per-invocation schema cost, lazy `--help`
discovery); the platform already validated the facade pattern four times, and
PR #1287 was forced to add a CLI wrapper anyway because native MCP does not
load under OAuth subscription tokens (`user:mcp_servers` scope absent). The
plugin contract therefore mandates a CLI. A plugin *may* additionally expose
an MCP endpoint, but nothing in v1 depends on it.

**The sidecar is the privilege boundary, the CLI is privilege-less.** The CLI
is just a client — everything a rogue agent could do with it, it could do
with `curl`. All security therefore lives server-side in the broker:
per-agent identity tokens, policy, quotas, tenant isolation. The privileged
resource (podman socket, vendor API credential, host mount) exists **only**
inside the sidecar container, never in an agent container.

**One contract, two provenances.** Every agent-facing CLI — built-in or
plugin-provided — follows the same contract (§4.5). But only outside-world
capabilities use the plugin *mechanism* (registry, sidecar, grants). Platform
primitives stay baked into the agent image and are never toggleable (§7).

**Full visibility.** Plugin calls appear as ordinary Bash calls in the
session log — no hidden channel, no special console rendering. The broker
keeps its own JSONL audit for compliance questions.

## 4. Design

### 4.1 Plugin anatomy and manifest

A plugin is a directory in the registry: `/workspace/plugins/<id>/` with
`plugin.json`, the CLI script(s) under `bin/`, optional console help topics
under `help/` (below), and (referenced, not stored) the sidecar image.

```json
{
  "pluginVersion": 1,
  "id": "podman-sandbox",
  "name": "Podman Container Sandbox",
  "description": "Agents spawn and manage their own compose stacks.",
  "sidecar": {
    "image": "aee-plugin-podman:latest",
    "env": { "MAX_MEM_LIMIT": "2g" },
    "capabilities": ["podman-socket"],
    "internalPort": 4004
  },
  "cli": { "name": "aee-podman", "entrypoint": "bin/aee-podman.py", "runtime": "python3" },
  "credentials": [ { "key": "api-token", "description": "Backend API token", "required": true } ],
  "platforms": ["podman"],
  "scopes": ["team", "agent"],
  "requiresApproval": ["compose up", "rm"],
  "policy": { "create-case": { "scopes": ["agent"], "requiresFlowFinal": true } },
  "ui": {
    "title": "Sandbox Dashboard",
    "routes": [
      { "path": "/", "minRole": "team-member" },
      { "path": "/admin", "minRole": "team-admin" }
    ]
  },
  "events": [
    { "name": "status_changed", "description": "A watched issue moved to another status",
      "payload": [ { "key": "toStatus", "description": "the status the issue moved into", "example": "Ready for Dev" } ] }
  ],
  "companionSkill": "batch-parity-testing",
  "promptLine": "You can spawn containers with `aee-podman` — run `aee-podman --help`."
}
```

- `sidecar.capabilities` is a **closed enum** of privileged attachments the
  orchestrator knows how to provide (`podman-socket`, `host-mount:<path>`,
  `egress`). Install-time review means a System Admin sees exactly what the
  plugin gets; a plugin cannot request arbitrary mounts.
- `platforms` declares runtime requirements (`podman` = local/compose only,
  like context mounts; `kubernetes` = k8s plugin sidecar, the positive mirror
  of `podman` — a manifest may combine them e.g. `["podman","kubernetes"]`);
  `any` imposes no special stack requirement. The console shows an honest "not
  available on this stack" instead of a broken toggle.
- `scopes` declares which **scope granularities** the broker actually
  implements (§4.6). A broker that cannot separate its resources per agent
  lists `["team"]` and the console offers no agent-level toggle — the
  granularity a grant may choose is bounded by what the plugin can honour.
- `requiresApproval` names subcommands the broker must hold for human
  confirmation (§4.6).
- `policy` (optional, shipped #1521) narrows **which** subcommands a caller may
  run, keyed on the granularity of its scope — the first governance rule only
  agent granularity can carry (§4.6). Each key is a subcommand; `scopes`
  restricts the calling granularity (⊆ the plugin's `scopes`) and
  `requiresFlowFinal` gates on flow position (agent-only — a team-scoped token
  cannot express it, so a rule with it may not admit team granularity). The
  broker enforces it via `broker-sdk/authz.js`; the console validates the field.
- `credentials` are bound at install/bind time from the existing credential
  store; secrets go into the **sidecar's** environment, never into agents.
- `events` (optional) is an **event-source** plugin's own vocabulary: the
  events its broker may send to `POST /internal/plugin-event` and the
  top-level string fields each payload carries (`{name, description?,
  payload: [{key, description?, example?}]}`). Purely descriptive — the
  platform never interprets a name or a key (the wake stays generic,
  `docs/jira-plugin-plan.md` D5); the trigger form renders it so a
  `plugin-event` listener's **Which event** is a select and its **Only when…**
  conditions a key picker with the example as placeholder, instead of two
  free-text fields whose vocabulary lived only in the plugin's docs. A plugin
  that declares none degrades to free text with the same wire shape.
- `help/*.md` (optional directory, not a manifest field) — console help topics
  in the built-in format (`admin-console/api/helper-chat/help-topics/`,
  front-matter `id, routes[], title, summary, seeAlso[], askPrompts[]`). The
  Helper Chat folds an installed plugin's topics into its grounding **only on
  the contexts the topic's `routes` name**, as neighbours after the page's own
  topic — never as a route's primary topic, so the "This page" face, the
  coverage ratchet and every other page's prompt budget are untouched
  (`help-registry.js` `loadPluginTopics`; read per request from
  `/workspace/plugins/<id>/help/`, so install/uninstall shows up without a
  restart). This is how the "?" on Agent Chat can answer "how does the Jira
  plugin wake my agent" without the platform corpus learning anything about
  Jira. The budget guard in `corpus.test.js` sweeps the reference plugins'
  help dirs, so a shipped topic that would blow a page's neighbourhood fails
  CI.
- `companionSkill` (optional) names a skill shipped alongside the plugin:
  the CLI delivers the *capability*, the skill delivers the *domain
  knowledge* about using it well (e.g. how to design batch-parity tests
  with `aee-parity`). Granting the plugin auto-grants the skill. The skill
  deliberately lives in the normal skill lifecycle — Team-Admin-editable,
  curator-improvable, lazily loaded — while the CLI does not (§7).

### 4.2 Registry and install

System-Admin-managed, mirroring the MCP-server registry: reference plugins
ship in the repo under `plugins/<id>/` and are seeded via `make seed-plugins`;
operators register third-party plugins by dropping the directory + image.
Install = registry entry + image present + credential binding. Installation
does not grant anything to any agent.

### 4.3 Sidecar lifecycle

The orchestrator owns the sidecar like it owns agent containers today:

- **Start/stop** on install/enable, labelled `aee.plugin.id=<id>`, reconciled
  by the existing container-reconciliation tick (unknown live sidecars of
  uninstalled plugins are stopped).
- **Network attachment is grant-driven**: the sidecar is connected into the
  per-agent networks of exactly the agents whose resolved grant includes the
  plugin (same retry machinery as conduwuit/orchestrator attachment). A
  non-granted agent cannot reach the sidecar at all — network truth matches
  grant truth. Startup reconciliation covers pre-existing agents (the #1287
  lesson).
- **No `/workspace` mount, no host-published port** by default; deviations
  must be declared as `capabilities` and are part of install review.
- **Health** is probed and surfaced on the plugin's registry card; a down
  sidecar shows up in the console instead of being debuggable only through
  agent chat errors.

### 4.4 Grant model

Grants follow the **skill-grant doctrine, not the env doctrine** (decision
2026-07-13: envs are pure infrastructure templates): a team agent carries
`plugins[]`, inherited by every member without a `pluginsOverride`;
standalone agents carry their own. Resolution via a sibling of
`effectiveSkills`. Team Admins grant within their team; System Admins
install. Working Environments are untouched.

A grant carries one setting beyond on/off: its **scope granularity**
(`scopeGranularity: "team" | "agent"`, offerable only within the manifest's
`scopes`). The default is **per-manifest** (decided with plugin #1, §10): a
manifest may declare `defaultScopeGranularity` within its `scopes`, and absent
that the platform default is `team`. The podman sandbox declares `agent`
because per-agent stacks are its natural reading; a shared expensive backend
omits the field and keeps `team`. It decides whether the granted squad shares one
broker-side identity or every member gets its own — see §4.6, where the
consequences live. It is a property of the grant, not of the plugin, because
the same plugin is shared infrastructure for one team and per-agent
infrastructure for the next.

Grant changes are **live, no respawn**: CLI script + config file sync into
the agent workspace (skill-sync pattern), CLAUDE.md rebuild through the
existing `prompt-rebuild` path, network connect/disconnect of the sidecar.
Flipping the granularity is a token re-mint plus a config re-sync; existing
resources keep their original owner label until torn down, so the flip is
additive rather than a migration.

### 4.5 CLI contract

Applies to plugin CLIs **and** (incrementally) to the built-in ones (the
built-in alignment is [`cli-contract.md`](cli-contract.md), Phase 6):

1. **Dependency-free single file** against the runtimes present in the agent
   image (`python3`, `node`, `curl`) — no compiled binaries (arch
   portability), no pip/npm installs.
2. **Seeded, not baked**: plugin CLIs land in `/workspace/agents/<id>/.agent-studio/bin/`
   (on `PATH` via the entrypoint), synced additively on grant change.
3. **Discovery**: `--help` carries complete agent-readable documentation;
   CLAUDE.md carries only the gated `promptLine` (lazy context, no tool
   bloat).
4. **Output**: `--json` on every subcommand; meaningful exit codes (0 ok,
   1 domain error, 2 usage, 3 broker unreachable).
5. **Long-running operations** use submit → poll (`run --async` → `status
   <id>`), never a blocking call beyond a bounded timeout.
6. **Config/identity**: endpoint URL + per-agent token in a 0600 file at
   `.agent-studio/plugins/<id>.json`, written at seed time — file-based, so rotation
   is also a live sync, and the workspace stays the transparent source of
   truth (workspace-transparency principle).

### 4.6 Identity, tenancy, policy

- **Scope tokens**: `podman-token.js` generalises to a plugin-scope-token
  module — HMAC-signed `{pluginId, scopeId}`. The broker verifies on every
  call; forged/missing token → 401. Tenant isolation is thereby the broker's
  *first* check, not an afterthought — two scopes sharing one plugin never
  see each other's resources.
- **Two scope granularities, chosen per grant** (§4.4). At **`team`**
  (default) the `scopeId` is `parentTeamId` for members and the agent id for
  standalone agents (the `podmanScopeId` rule): a squad shares one pool of
  broker-side resources — the right default for a shared, expensive backend.
  At **`agent`** every member mints its own token and carries its own
  `scopeId`, so two agents of one team are as isolated from each other as two
  teams are: separate ownership labels, separate quotas, separate audit rows,
  separate environments behind the broker.

  Agent granularity buys two things team granularity structurally cannot:

  1. **Agent-level parallelism.** An adversarial tester can run live tests
     against its own stack while a developer of the same squad exercises a
     different feature against its own — no shared environment to collide in,
     no shared teardown. This is the plugin-side counterpart of the per-agent
     network/volume isolation the platform already gives agent containers.
  2. **Per-agent policy.** Because the broker sees *which* agent is calling,
     it can restrict subcommands by role — e.g. only the last agent in a flow,
     after its cross-checks passed, may create test cases in the
     test-management system. A team-scoped token cannot express that
     distinction at all.

  What granularity does **not** multiply is backend credentials: it multiplies
  *tokens in front of* the broker, while the broker keeps holding exactly one
  credential for the target system. That asymmetry is the whole point of the
  broker sitting there (§3) — per-agent authorisation without per-agent
  accounts to provision in the backend.
- **Resource ownership**: whatever a broker creates on behalf of a scope is
  labelled (`aee.plugin.owner=<scopeId>`), listed/operated only within the
  scope, quota-capped, and torn down on team/agent deletion **before** the
  token is destroyed (the #1287 teardown ordering). At `agent` granularity
  deleting one member tears down only that member's resources; the squad's
  other scopes are untouched.
- **Quotas are mandatory manifest/config fields** for resource-creating
  plugins — the manifest `quota` field (`{ maxObjects, ttlSeconds? }`; the
  podman sandbox ships `maxObjects: 8`). Rationale: a loop-triggered agent
  creating one resource per iteration is a runaway the #611 backstop cannot
  see, so the cap lives in the manifest, not a single platform-wide Settings
  toggle (the #1287 global container cap, now retired). Quotas
  are **per scope**, so agent granularity on an eight-member squad multiplies
  the worst-case footprint eightfold — the grant UI states that resulting
  ceiling before the toggle is flipped, rather than letting an admin discover
  it as a full disk.
- **`requiresApproval`**: the broker parks the operation and posts an
  approval request; v1 delivers it as a DM to the agent's room (human
  confirms in chat), a later phase can bind it to the flow human-gate
  machinery. Client-side gating is explicitly *not* relied on — agents run
  `--permission-mode acceptEdits` and Bash is one opaque permission surface.
- **Audit**: the broker writes one JSONL line per call (`ts, scopeId,
  agentId, subcommand, outcome`) under its own volume; 7-day default
  retention. The `/api` audit trail is unaffected (plugin calls are not
  `/api` mutations); the session log already shows every call verbatim.

### 4.7 Prompt gating

One generic block, built by `prompt-assembly.js` from the **resolved grant**
(never from env contents — this fixes the #1287 bug where the podman section
keyed off `env.mcpServers`): a "## Plugin Capabilities" section listing each
granted plugin's `promptLine`. Grant flips rebuild + reseed CLAUDE.md through
the existing pipeline, so the prompt never advertises a CLI the workspace
lacks, and never omits one it has.

### 4.8 Optional UI extension

A plugin may serve a web UI from its sidecar; the console proxies it at
`/plugins/:id/ui` behind the normal session gate and lists it in the nav
when present (bp-explorer pattern). **No React injection into the console**
— the iframe boundary is the contract. Plugin UIs inherit no console state;
if they need identity they use the same scope-token mechanism.

Two things the boundary must nevertheless carry, or every UI-bearing plugin
re-invents them badly:

- **Scope discovery.** A plugin that assigns resources or permissions per
  team/agent has to know which teams and agents exist. Copying ids across by
  hand does not survive the first twenty-agent installation. The console
  therefore exposes a read-only endpoint to the proxied UI:
  `GET /plugins/:id/scopes` → `[{ scopeId, kind, displayName, teamId }]`.
  It is **derived from the resolved grant**, so a plugin can only ever
  enumerate the scopes it was granted to — discovery is not a new read
  privilege — and the UI can render an honest dropdown instead of a free-text
  id field. Brokers get the same list server-side for validating what an
  admin picked.
- **Viewer identity and role.** The proxy forwards the authenticated console
  user and their effective role (System Admin / Team Admin / Team Member,
  plus the team ids in scope) as signed headers, so a plugin UI reflects the
  platform's user model instead of inventing a second login. A plugin may
  serve **several paths behind its one mount** and declare the minimum role
  each requires (`ui.routes`, §4.1) — a configuration/admin page, a
  day-to-day working page, a read-only view. The console refuses to proxy
  below the declared minimum and the plugin enforces it again: the same
  two-defense-lines discipline as network truth + token truth.

Sequencing: scope discovery ships with the first UI-bearing plugin (any of
them needs it). Multi-route roles are a manifest field reserved now and
implemented when a plugin declares more than one route — reserving it costs
nothing, retrofitting it into a shipped proxy contract would be breaking.

The decidable core of all three landed with plugin #2 (#1521,
`admin-console/api/plugin-ui-proxy.js`, unit-tested): `deriveScopeList` (the
grant-derived scope list — a plugin can only enumerate scopes it was granted
to), `enforceUiRoute` (the console's `minRole` refusal, `ui.routes` longest-
prefix match), and `signViewerHeaders`/`verifyViewerHeaders` (the signed viewer
identity + effective role). The live Express proxy, iframe mount and nav entry
were wired by the Network Plan epic (#1554, Phase 2 / #1562), which needed an
embedded plugin UI: the console serves `ALL /plugins/:id/ui/*` behind the
session gate (`enforceUiRoute` on the sub-path, `signViewerHeaders` forwarding
the authenticated user + effective role), `GET /api/plugins/:id/scopes` returns
the derived scope list, and dynamic nav entries appear for installed + granted
UI plugins. The sidecar address comes from the orchestrator
(`GET /internal/plugins/:id/ui-endpoint`), and each sidecar gets a generic
`AEE_PLUGIN_STATE_DIR` volume beside its audit volume. test-mgmt's manifest
declares three routes at two roles to exercise the contract end-to-end.

**Per-team roles in the signed identity** (Jira review, F4). The flat
`x-aee-plugin-role` is the viewer's *maximum* role across the granted teams they
belong to — right for the proxy's own `minRole` pre-check and for team-agnostic
UIs, but it cannot express "Team Admin of A, Team Member of B". A broker that
lets the request choose the team (Jira's `?team=`, netzplan's first-in-scope
board) and gated `/admin` on the flat role handed U admin rights over B. The
proxy therefore also signs `x-aee-plugin-team-roles` (`A=team-admin,B=team-member`,
part of the HMAC canonical string; `plugin-ui-viewer.js` `viewerTeamRoles`), and
the verifier exposes `roleForTeam(viewer, teamId)` — which never elevates: a team
outside the viewer's scope is `null`, an in-scope team missing from the map (an
older proxy) is a plain `team-member`. **Rule for brokers:** a team-selecting
elevated route is gated on `roleForTeam(viewer, selectedTeam)` *after* the team
is chosen; the flat role stays a coarse pre-filter. The sign/verify block is
copied into every UI-bearing broker's `viewer-headers.js` and pinned
byte-identical by `admin-console/api/viewer-headers-parity.test.js` — changing it
means changing every copy and rebuilding the plugin images together.

**Global UI visibility (opt-in, #1599).** By default a UI-bearing plugin's nav
entry and UI are gated on the plugin being *granted* to a team the caller can
see — the same team activation that gives that team's agents the plugin's CLI.
That couples the human-facing UI surface to agent-capability activation, which
is wrong for a plugin whose UI is a reference surface valuable to *any* user
independently of any team using its capability (e.g. the **Patterns Catalog**
reference catalog). A plugin may therefore set the opt-in manifest flag
`ui.global: true` (validated in `plugin-manifest.js`; **off by default** — an
absent or `false` value normalizes byte-identically to today, so no existing
plugin changes behaviour). When it is on **and the plugin is installed**, its
nav entry shows for **every authenticated user** and its **ordinary-user
routes** are reachable without any team grant: the console proxy admits a caller
with no grant-derived role as an ordinary `team-member` viewer
(`effectiveViewerRole` in `plugin-ui-viewer.js`), so `enforceUiRoute` still
refuses any **elevated** route (`minRole` above `team-member`, e.g. an `/admin`
route) to a purely-global viewer — the flag never widens beyond the general UI.
It is strictly a human-UI concern: **agent capability is untouched** — a
globally-visible but ungranted plugin grants no CLI to any agent, since the
grant path (`plugin-grants.js`) never reads `ui.global`. Install remains a
prerequisite (global visibility never auto-installs), authentication remains
required (the proxy stays behind the session gate), and a plugin that is *both*
team-granted and globally visible renders exactly one nav entry (a
team-admin/system-admin caller keeps their elevated role via `resolveViewerRole`,
which wins before the global fallback). Patterns Catalog ships with
`ui.global: true` so, once an operator installs it, all users can open it
without a team having to activate it first.

### 4.9 Broker SDK

Every broker owes the same obligations (§4.6): token verification, scope
filtering, quotas/ownership labels, audit, secret masking, health. Left to
each plugin author, these would be re-implemented — and re-broken — per
plugin. The platform therefore ships a **Broker SDK**: a small,
dependency-free Node module (mirroring the pure-module discipline of
`process-template.js` / `prompt-assembly.js`) that a sidecar imports:

- `verifyScopeToken(reqOrHeader, secret)` → `{ pluginId, scopeId }` or 401 —
  **granularity-agnostic** (the broker must not branch on `scopeId` shape);
  byte-identical contract to `orchestrator/plugin-scope-token.js`.
- `scopeFilter(scopeId)` — ownership-label helpers (stamp on create, filter
  on list, exact-match on operate) using the platform label `aee.plugin.owner`.
- `auditWriter(dir, {retentionMs, now})` — one JSONL line per call,
  retention-rotated on write.
- `maskSecrets(output, secrets)` — response redaction: explicit secret values
  plus the `-e/--env KEY=VALUE` values backends echo verbatim.
- `healthEndpoint()` / `teardownScopeEndpoint(reap, {secret})` — the two
  plain-REST routes the orchestrator calls on every broker (health probe, scope
  teardown on team/agent deletion). Teardown is per `scopeId` — one handler
  serves both team and single-member deletion; resources are **reaped before
  the orchestrator invalidates the token**.
- `parkForApproval(op)` / `approvalHoldingPen({requiresApproval})` — the
  `requiresApproval` holding pen (v1: DM confirm).
- `authorizeAction(policy, subcommand, caller)` / `isActionPermitted(...)` —
  per-scope action authorisation (#1521): `policy` is the manifest's normalized
  policy map; `caller` is `{ kind: 'team'|'agent', flowFinal?, crossChecksPassed? }`;
  returns `{ allowed }` or `{ allowed: false, code, reason }`. Fails closed on
  a malformed caller. First rule only agent granularity can carry.

The SDK is extracted from plugin #1's broker (`podman-mcp/`), not designed on
paper — `podman-token.js`, `owner-scope.js`, `mask-env.js`, and the teardown
endpoint were its seeds. Phase 4 (#1520) deleted those copies from `podman-mcp/`
and moved them into `broker-sdk/`, retrofitting plugin #1 onto the SDK so it
has a live consumer from day one. Using the SDK is strongly recommended, not
enforced (the platform verifies the wire contract, not the implementation).

### 4.10 Versioning

`plugin.json` carries `version`; sidecar image + CLI ship together, so a
plugin upgrade = image update + CLI re-sync (live). Breaking CLI changes are
the plugin author's problem to version (`aee-<x> --version`); the platform
only guarantees contract-level stability (`pluginVersion`).

## 5. Failure modes and edge cases

| Scenario | Behaviour |
|---|---|
| Sidecar down mid-run | CLI exits 3 with a clear message; agent sees an honest tool failure; registry card shows unhealthy |
| Grant revoked while an agent's loop is mid-iteration | Network disconnect + CLI removal take effect between iterations; an in-flight call fails like "sidecar down" |
| Plugin uninstalled with live owned resources | Teardown-scope call per scope first, then sidecar stop, then token invalidation — same ordering as team deletion |
| Token rotation | New token file synced live; broker accepts old token for a short overlap window |
| Two stack instances on one host | All labels/networks namespaced by `COMPOSE_PROJECT` (existing convention) |
| Hosted/GKE stack | `platforms` mismatch → plugin listed as unavailable, no toggle offered |
| Secret leakage via verbose backend output | Broker must mask credential values in returned output (the #1287 deferred item becomes a contract requirement) |
| Many plugins granted | Context cost is one line each; grants are deliberately per-team narrow — no "grant all" affordance |
| Agent granularity on a large squad | Quotas are per scope, so n members = n× the worst-case footprint; the grant UI states the resulting ceiling before the toggle, and manifest quota defaults are authored per scope, not per team |
| Granularity flipped on a live grant | Token re-mint + config re-sync; resources created under the old `scopeId` keep their owner label and are reaped by TTL/teardown — no ownership migration, no orphans |
| Plugin UI asks for a scope it was not granted | `GET /plugins/:id/scopes` is derived from the resolved grant, so the scope is simply absent; a broker call with a forged `scopeId` fails token verification anyway |

## 6. Extraction path from PR #1287 (podman-mcp → plugin #1)

The PR is the proof of the broker architecture; the rework replaces its
integration layer, not its core.

**Kept nearly unchanged** (becomes the plugin's sidecar): the `podman-mcp/`
directory — `server.js`, `compose-harden.js`, `compose-validate.js`,
teardown endpoint, Dockerfile, tests. (`owner-scope.js` and `mask-env.js`
stayed here through Phase 3 and were extracted to `broker-sdk/` in Phase 4
#1520, along with `podman-token.js`.)

**Generalised into platform machinery**: `podman-token.js` → plugin scope
tokens (§4.6); the team/agent tri-state activation + no-respawn file sync →
the generic grant model (§4.4); the startup network reconciliation for new
services → grant-driven sidecar attachment (§4.3); the global container cap →
manifest quota config.

**Replaced**: the hardcoded compose service → sidecar lifecycle from the
manifest; the Platform Settings toggles → registry install/enable (the
Platform Settings *page* survives for genuinely platform-wide settings like
respawn concurrency); the `podman` special branch in `seedAgentMcpServers` →
CLI config seeding; `podmanMcpSection` in `prompt-assembly.js` → the generic
gated block (§4.7, fixing its env-keyed gating); `podman-mcp-cli.py`'s raw
`<tool> '<json>'` RPC → a proper `aee-podman` domain CLI (`aee-podman compose
up -f compose.yml`); `mcp-stdio-proxy.py` → not needed on the CLI path.

**Parked until after v1**: the relay-sidecar spec for nested stacks
(`docs/superpowers/specs/2026-08-04-podman-mcp-relay-design.md`) — consistent
with the broker model, but layered on plugin #1, not on the special case.

## 7. What stays out of the plugin mechanism

Two distinct exclusions live here. First, **skills are not the vehicle** for
building plugins (the boundary rule below). Second, a set of platform
capabilities are deliberately never *packaged* as plugins even though they
look like they could be.

**The skill/plugin boundary.** Skills were considered as the delivery
vehicle (a skill can carry a script, and the grant/sync/gating machinery is
identical — plugin CLI seeding deliberately reuses it). Rejected as the
*mechanism*, because a skill has no server side and the server side is the
point: no sidecar, no per-agent token minting (skills are identical static
content for every grantee), no network wiring, no quotas, no audit, no
teardown. A "podman skill" would be the original hole with nicer packaging.
Two further mismatches: the skill lifecycle (Team-Admin-editable,
curator-improvable, auto-distilled at autonomy 3) is right for knowledge and
wrong for code that must stay version-locked to its sidecar; and a skill
grant is a low-stakes *knowledge* grant while a plugin grant is a high-stakes
*capability* grant — hiding both behind one concept blinds the reviewing
admin to the difference. The boundary rule:

> **No secret, no privilege, no backend → skill** (a pure workspace tool as
> a skill-embedded script is fine today and needs no plugin). **Anything
> that needs a broker → plugin.** A plugin may reference a `companionSkill`
> (§4.1) so capability and domain knowledge ship together, each in its
> proper lifecycle.

- **Flow primitives** `aee-emit`, `aee-artifact`, `gh-as-agent`: flow
  semantics depend on them (trigger prompts instruct their use); making them
  optional inverts the layering. They stay in `agent-image/scripts/`, and are
  only aligned to the CLI *contract* conventions over time.
- **The knowledge system**: the `knowledge` CLI facade *is* already the
  stable contract; on/off already exists via the autonomy-0/KB-less gates
  (digest import, memory-model switch). Swappability, if ever wanted, applies
  to the **backend behind the facade**, not to the facade itself — no plugin
  mechanism involved.
- **MCP servers**: the existing registry stays for pure data-access backends
  wired per environment. A plugin that wants to expose MCP *may*, but the
  platform contract is the CLI.

## 8. Example plugin catalog

Illustrative, not committed roadmap. Each fits the same shape: CLI facade →
scope-verified broker → guarded external resource.

**Screening rule — apply before any entry is built.** Most of these backends
already have a public MCP server. The first question for every candidate is
therefore not "how do we build it" but *what does a plugin add over pointing
the existing MCP registry at that server*. The answer must be at least one of
the three governance properties MCP does not carry: a **credential that must
not enter the agent container**, **per-scope authorisation/quotas**, or an
**audited approval gate**. If none applies, the honest answer is an MCP
server, not a plugin. Where one does apply, the plugin is frequently the
*thin* option rather than a fresh integration: a broker that wraps the
existing MCP server and contributes only the missing governance and the
fine-grained permissions on top. Each entry below carries this justification
before it moves from catalog to roadmap.

**Mainframe migration (the product's home turf)**

1. **Mainframe bridge** — submit JCL, fetch job output/SYSOUT, browse
   datasets via Zowe/FTP against a real LPAR or emulator (Hercules, zD&T);
   broker guards credentials + rate.
2. **3270 terminal automation** — scripted green-screen flows for regression
   evidence on legacy transactions.
3. **Batch-parity harness** — run legacy and migrated batch jobs on the same
   input, diff outputs field-by-field; the single most convincing migration
   artifact.
4. **DB2/test-database provisioning** — ephemeral schema instances per
   scope, TTL-reaped; agents get connection strings, never admin creds.
5. **Copybook/dataset transfer** — pull copybooks, DCLGENs, sample VSAM
   extracts from the host into the workspace, with an allowlist of dataset
   prefixes.
6. **Job-scheduler bridge** (Control-M / IWS) — query schedules and
   dependencies, request test executions in a sandbox plan.
7. **MQ test injection** — put/get test messages on IBM MQ / Kafka topics to
   drive migrated interfaces.
8. **Code-conversion service bridge** — drive a proprietary COBOL→Java
   transpiler running as a service; broker meters licensed usage.

**Quality engineering**

9. **Test management** (Xray/Zephyr/qTest — the original request) — create
   test cases, trigger runs, manage test data; optional sidecar UI. Passes
   the screening rule on two counts, and they are worth naming because they
   generalise: the API is trivial to script *as a skill*, but doing so
   exposes the vendor credential to the agent one way or another; and the
   broker can narrow the surface to specific actions per scope — with agent
   granularity (§4.6), "test cases may only be created by the last agent in
   the flow, once its cross-checks passed" becomes enforceable server-side
   rather than a prompt request.
10. **Test-data generation/anonymisation** — produce GDPR-safe
    production-like data sets; broker enforces the anonymisation profile.
11. **Load/performance testing** — launch k6/JMeter runs, fetch result
    summaries; broker caps concurrency and duration.
12. **Browser automation** — a Playwright sidecar so agents can verify UIs
    they built; broker limits target hosts.
13. **DAST/security scanning** — request OWASP-ZAP/Trivy scans of an agent's
    deployed artifact; broker pins allowed targets (never arbitrary URLs).
14. **License-compliance scan** — ORT/FOSSA over a repo snapshot, verdict
    back as JSON.

**SDLC & infrastructure**

15. **Container sandbox** (the second original request) — plugin #1, §6.
16. **CI/CD control** — trigger Jenkins/Azure-DevOps pipelines, poll status,
    fetch logs; broker restricts to per-team job allowlists.
17. **Quality-gate bridge** — request a SonarQube analysis, block-or-pass
    verdict as structured output.
18. **Artifact repository** — publish/fetch from Nexus/Artifactory with
    scope-separated repos.
19. **Ephemeral preview environments** — "deploy this branch, give me a
    URL", TTL-reaped; the higher-abstraction alternative to raw container
    access.
20. **Secret vault** — short-lived credentials from HashiCorp Vault instead
    of static tokens in the credential store.
21. **IaC execution** — `terraform plan` freely, `apply` behind
    `requiresApproval`; broker holds cloud credentials and a resource-type
    allowlist.

**Enterprise integration & ops**

22. **Ticketing/ALM** (Jira/ServiceNow) — create/update work items from agent
    findings; broker enforces project scoping. **Shipped: `plugins/jira/`** —
    wakes agents on status changes (via the broker→orchestrator `plugin-event`
    wake this plugin introduced), `aee-jira` read/write CLI, `/` + `/admin` UI.
    See `docs/jira-plugin.md`.
23. **Documentation publishing** — push generated docs to
    Confluence/SharePoint spaces per team. Confluence is planned as the
    second Atlassian plugin (read/search, ownership-tiered writes, page and
    comment events): `docs/confluence-plugin-plan.md`.
24. **Notification bridge** — outbound Teams/Slack/e-mail summaries beyond
    Matrix; broker rate-limits and templates.
25. **Observability query** — read-only Grafana/Prometheus/Loki queries so an
    agent can investigate its own failed deployment.
26. **FinOps reporting** — token/cost usage queries against the billing
    export, read-only.

## 9. Rollout

- **Phase 1 — core machinery** *(shipped — #1532)*: manifest schema + registry + sidecar
  lifecycle + scope-token module (**both granularities from the start** — the
  token payload and ownership labels are the same code either way; retrofitting
  agent scoping later would be a data migration) + grant-driven network
  attachment. No UI extension, no approval flow.
- **Phase 2 — agent surface** *(shipped — #1534)*: CLI contract, workspace seeding/sync, config
  files, prompt-gating block, grant UI (team/agent, tri-state, granularity
  selector bounded by the manifest's `scopes`), audit JSONL.
- **Phase 3 — plugin #1** *(shipped — #1537)*: rework PR #1287 onto the machinery per §6; delete
  the special cases; `aee-podman` domain CLI.
- **Phase 4 — Broker SDK** *(shipped — #1520)*: extract the §4.9 module set
  from plugin #1's broker (token verify, scope filtering, audit writer, secret
  masking, health/teardown routes, approval pen) into `broker-sdk/`; retrofit
  plugin #1 (`podman-mcp/`) onto it so the SDK has a live consumer from day one.
- **Phase 5 — plugin #2 (test management)** *(shipped — #1521)*: built **on the
  SDK** — the proof that a credential-backed broker is thin (`plugins/test-mgmt/broker/`
  imports `broker-sdk/` and adds only the credential-holding `vendor-client.js`
  + the policy glue). Introduces per-scope **authorisation** (`policy` +
  `broker-sdk/authz.js` — the first rule only agent granularity can carry:
  create-case = flow-final agent, cross-checks passed), the first real
  `requiresApproval` flow (destructive test-data ops parked for DM confirm), and
  the UI-extension surface's decidable core (`admin-console/api/plugin-ui-proxy
  .js`: scope discovery derived from the grant, `ui.routes` `minRole`
  enforcement, signed viewer headers) — reserved now; the live iframe proxy +
  nav were wired by the Network Plan epic (#1554 Phase 2, #1562). The
  orchestrator live-stack (token mint, scope-registry push, sidecar lifecycle,
  DM approval round-trip) is the completion step, same "pure core now, live
  stack next" split as Phases 1–3.
- **Phase 6 — contract alignment** *(shipped — #1536)*: align built-in CLIs to the
  contract conventions (no mechanism change). Documented in
  [`cli-contract.md`](cli-contract.md); conformance-tested in
  `agent-image/scripts/test_cli_contract.py`.
- **Phase 7 — live-stack completion** *(shipped — #1547)*: the half every phase
  above deferred, collected into one vertical slice and proven on plugin #1.
  Registry reader + System-Admin install (`/plugins` page, capability review
  before the confirm), the shared signing secret, sidecar lifecycle over libpod
  (`orchestrator/plugin-runtime.js`), grant → workspace sync with no respawn,
  `.agent-studio/bin` on the agent PATH, the Plugin Capabilities prompt block actually
  wired, scope teardown before token invalidation, and the grant UI on the
  Agents page. Fixed three wiring gaps found while tracing the path end to end:
  the CLI posted to the sidecar's base URL while the broker only served `/mcp`;
  `AEE_WORKSPACE` (which every CLI reads to find its config) was set nowhere
  outside tests; and the per-scope `quota` was unimplemented, with #1287's
  global cap fetching a `/internal/platform-settings` endpoint that was never
  merged and failing open. Plugin #1's broker also gained the audit obligation
  it never had. **Podman-only** — see the Deliberate differences block in
  `orchestrator/spawn-kubernetes-pod.js`.

- **Kubernetes epic (#1554), Phase 1 — manifest `platforms` widening** *(shipped — #1573)*:
  `kubernetes` added to the `PLATFORMS` enum as the positive mirror of `podman` —
  a manifest can now declare `["podman","kubernetes"]` or `["kubernetes"]`;
  `any` is unchanged. Both `plugin-manifest.js` copies (admin-console/api + orchestrator)
  updated and two-sided-guard tested.
- **Kubernetes epic (#1554), Phase 3 — plugin #3 (netzplan)** *(shipped — #1563)*:
  the first UI-bearing plugin and the first privilege-less plugin (`capabilities: []`,
  `credentials: []`, `scopes: ["team"]`, `platforms: ["podman","kubernetes"]`).
  `plugins/netzplan/` (manifest + `aee-plan` CLI facade: `show`/`tick`/`edit` on
  a 3-rung autonomy ladder) + `plugins/netzplan/broker/` (Broker SDK: pure `plan-doc.js`
  id-keyed document model, `plan-store.js` state-volume adapter, `viewer-headers.js`
  §4.8 verifier copy, minimal served board). Completed by Phase 4 (#1564) — see
  below. See `docs/network-plan-plugin-concept.md`.
- **Kubernetes epic (#1554), Phase 4 — netzplan full editability** *(shipped — #1564)*:
  all three remaining §5 primitives — **`graph`** (typed nodes in horizontal bands +
  typed dependency edges; `graphNeighbors` pure hover-highlight helper), **`bipartite`**
  (left/right entries + typed, muteable edges), **`blocks`** (cover / KPI-tiles /
  callout / cards as flexible typed blocks) — added to `plan-doc.js` alongside the
  existing `swimlane`, each with id-keyed normalize/mutate/referential repair. Panel
  composition ops (`add-panel` / `delete-panel` / `reorder-panels` / `set-panel-title`)
  complete the §5 document shape. Every new mutation is structural → `requiredAutonomy`
  2, gated by the one existing `plan-store.js` path (no primitive gets its own
  authorisation path). The served board renders all four primitives and, in **Edit**
  mode, adds/edits/reorders/removes panels and their contents through a new human-write
  `/api/mutate` route (role-gated by viewer headers, **not** autonomy-gated — autonomy
  governs the agent path; `set-autonomy` stays the `/admin`-only `/api/settings`
  route). The direct-manipulation polish (drag reorder, colour pickers,
  requirement-target-by-click, undo/redo) is a UI refinement over these same mutations.
- **Kubernetes epic (#1554), Phase 5 — plugin sidecars on Kubernetes** *(shipped — #1565)*:
  flips `PLUGIN_SIDECARS_SUPPORTED` for **UI-bearing** plugins.
  `orchestrator/spawn-kubernetes-plugin.js` — a sibling behind the
  `container-runtime.js` seam, same raw-HTTPS `k8sRequest` style as
  `spawn-kubernetes-pod.js` — creates a **Deployment + Service + state PVC** per
  installed plugin; `plugin-runtime.js` delegates `reconcilePluginSidecars` /
  `reconcilePluginAttachments` / `listLiveSidecars` to it on k8s (the rest of the
  surface is runtime-agnostic — the Service is named identically to the Podman
  container, so `brokerBaseUrl` resolves on both). State is a **PVC not
  `emptyDir`** (audit stays an `emptyDir` — a per-plugin audit PVC is a separable
  follow-up); RBAC (`deploy/k8s/base/core/10-rbac.yaml`) gains namespaced
  `apps/deployments` + `services` + `persistentvolumeclaims` + `networkpolicies`.
  The grant-driven per-agent-network reachability a **broker** plugin needs
  becomes per-grant `NetworkPolicy` objects — a larger, separable mechanism split
  out of this phase: a UI-only plugin needs none, so `reconcilePluginAttachments`
  is a no-op on k8s and a broker plugin's CLI stays at exit 3 there.
  `capabilities: ["podman-socket"]` has no k8s equivalent, so
  `plugins/podman-sandbox/` is permanently `platforms: ["podman"]`. See
  `docs/network-plan-plugin-concept.md` §9.
- **Opt-in global UI visibility** *(shipped — #1599)*: `ui.global: true` in a
  plugin manifest (off by default) makes the plugin's nav entry and general UI
  routes visible to every authenticated user once the plugin is installed,
  without requiring a team grant — decoupling the human-facing reference UI from
  agent-capability activation. Elevated routes (`minRole > team-member`) still
  refuse a purely-global viewer. Agent CLI access is unaffected (the grant path
  never reads `ui.global`). Patterns Catalog is the first plugin to opt in.
- **GitHub Issues plugin** *(shipped — #1637)*: the first plugin that is both
  UI-bearing **and** credential-holding. `plugins/github-issues/` (broker at
  `plugins/github-issues/broker/`) — list a repo's issues, read one, and add/remove a
  label in the console so releasing work (e.g. applying a `ready` gate) no
  longer means switching to GitHub. Manifest: `capabilities: ["egress"]`,
  `credentials: []`, `scopes: ["team"]`, one `ui.route` `/` @ `team-member`,
  **not** `ui.global`. Credential delivery is **pushed, not baked in**: the
  orchestrator resolves each granted team's `environment → { token, repos }`
  (`orchestrator/plugin-github-creds.js`, pure + unit-tested) and pushes a
  per-scope map to the broker's `PUT /internal/scope-credentials` via
  `plugin-runtime.pushScopeCredentials`; the raw token stays in the broker's
  memory and never reaches the browser or an agent (AC10). Read-only `aee-issues`
  CLI (`repos`/`list`/`show`); label writes are the human console action.

- **New-member plugin materialisation fix** *(shipped — #2308)*: a new team
  member's resolved grant was correctly *computed* (`effectivePlugins`) but
  never *applied* — `addTeamMember`, `enableAgent`'s stub-activation path, and
  `seedAgentWorkspace` had no plugin equivalent of the skill/MCP seeding they
  already did, so a member could show a plugin as granted, and advertise its
  CLI in CLAUDE.md, with nothing actually written to `.agent-studio/`. Fixed by
  threading the same `_syncPluginIntoWorkspace` seam both creation paths now
  call, plus a new per-member `.agent-studio/seeded-plugins.json` manifest (the
  plugin sibling of `seeded-skills.json`) recording which grants actually
  landed on disk, and a bounded auto-reconcile loop
  (`orchestrator/plugin-reconcile.js`, `reconcilePendingPlugins`) that repairs
  members that were created while this bug was live. A sync failure degrades
  the member rather than blocking the add, and is surfaced as a warning
  (add-member response + GitHub Event Log) instead of only a log line.

## 10. Open questions

- **Plugin authorship**: internal curated registry only, or customer-authored
  plugins (→ signing + review workflow from day 1)? Determines how much
  install-time review tooling Phase 1 needs.
- **Does QE need the embedded UI** at all, or is the agent-side CLI enough
  with humans working in the test system directly? The iframe surface is the
  most maintenance-prone building block; defer until a real user insists.
- **Approval UX**: DM-based confirm (v1) vs. wiring into the flow human-gate
  registry — revisit when the first `requiresApproval` plugin ships.
- ~~**Default scope granularity per plugin**: `team` is the safe default for
  shared, expensive backends, but for a sandbox-style plugin agent granularity
  may be the *expected* behaviour and a team default the surprising one. Let
  each manifest declare its own default within `scopes`, or keep one
  platform-wide default? Decide with plugin #1, which is exactly the case
  where agent granularity is the natural reading.~~ **Decided (Phase 3, #1519,
  plugin #1): per-manifest.** A manifest may declare `defaultScopeGranularity`
  (validated to be within its own `scopes`); absent, the platform default
  stays `team`. The podman sandbox declares `agent`, so a grant defaults to
  per-agent stacks — the natural reading for a container sandbox — while a
  shared, expensive backend simply omits the field and keeps the `team`
  default. See §4.4.
- **In-place plugin upgrade**: `POST /api/plugins/:id/install` 409s on an
  installed plugin, and uninstall reaps every scope's plugin credential
  (`plugin-credential-store.js`) — so upgrading a credential-bearing plugin
  (Jira's event kinds, `docs/jira-plugin-events-implementation.md` §6) is a
  documented manual file refresh, not an action. Wanted: an install
  `?force=1` (or an *Upgrade* action) that overwrites the registry copy and
  restarts the broker while keeping credentials and state. Deferred until a
  second plugin needs it.
- **Claude Code plugins as "agent plugins"**: worth adopting the CLI's own
  marketplace format as a distribution channel for agent-side content
  (skills, commands, hooks)? It solves a different problem than this
  document — no sidecar, no privilege — but it shares the word, so the
  terminology fixed in §3 has to hold before both exist.
