# Jira as an installable plugin — implementation plan

> Status: **implemented** (Phases 0–5, this branch). This is the design record;
> the how-to is `docs/jira-plugin.md`. Supersedes `docs/jira-integration-concept
> .md` (shipped as PR #1539, reverted by PR #1789). Companion reading:
> `docs/plugin-system-concept.md` (§4 the contract, §8 item 22 "Ticketing/ALM"),
> `plugins/CONTRACT.md`, `docs/cli-contract.md`.

## 1. What happened, and what the mistake was

PR #1539 ("Integration of Jira Events") landed a Jira status-change integration
by teaching **the platform itself** about Jira. It was reverted wholesale in
`2ff0dcb3a` — 51 files, **6 044 lines removed**. The revert was not about code
quality; the design was careful and the concept doc was validated against real
source. The mistake was **the shape**: a vendor integration was built as core
machinery instead of as a plugin.

Concretely, the reverted PR added Jira knowledge to five separate platform layers:

| Layer | What #1539 added |
|---|---|
| **Credential store** | `JIRA_TOKENS_DIR`, `/api/jira-tokens` CRUD, `jiraTokenInUse()`, `normalizeJiraSiteUrl()`, `JiraTokens.jsx` (462 lines) + route + nav entry |
| **Environment schema** | `env.jiraProjects: [{projectKey, credentialId}]`, `normalizeJiraProjectsInput()`, validation on env create/update, a repeatable row list in `WorkingEnvironments.jsx` |
| **Trigger vocabulary** | a new `jira-event` trigger type, plus one-line `'jira-event'` cases in `TriggersPanel.jsx`, `RoutingSection.jsx`, `trigger-summary.js`, `process/input-rows.js`, `process/EdgeDialogs.jsx`, `edit-adapters.js`, `SessionsPanel.jsx` |
| **Orchestrator** | `jira-poller.js` (689 lines) + tests, startup wiring in `orchestrator.js`, and a **refactor of `github-poller.js`** extracting `event-poller-shared.js` (223 lines) |
| **Agent runtime** | `jira-digest` queue kind, `_execute_jira_digest()`, a `jira:` correlation-id branch, an `<external-event source="jira">` envelope, a `jira-event` trigger-notice branch in `agent-entrypoint.py` |

Two consequences make this the wrong shape regardless of how well it is written:

1. **It is not removable.** Deleting Jira means another 51-file revert. A plugin
   is uninstalled from a page, and the platform is byte-identical afterwards.
2. **It sets a precedent that does not scale.** ServiceNow, Azure DevOps and
   Confluence each want the same five layers. The plugin system exists precisely
   so vendor #2 costs a directory, not a refactor of `github-poller.js`.

Everything below reuses the *design work* of #1539 — the JQL/changelog polling
mechanism, the composite `<issueKey>:<historyId>` event id, the changelog
truncation guard, the per-site project scoping — and rehomes it.

## 2. Does Jira pass the plugin screening rule?

`docs/plugin-system-concept.md` §8 requires a candidate to carry at least one
governance property MCP does not, or the honest answer is "point the MCP registry
at Atlassian's MCP server". Jira passes on all three:

- **A credential that must not enter the agent container.** A Jira API token is
  site-wide and carries the *human's* permissions — an agent holding it can read
  and transition every issue that person can, across every project.
- **Per-scope authorisation.** One broker, many teams, each bound to its own
  site/project set: team A must not see team B's issues. This is exactly what
  `scopeFilter` + the scope token already enforce for github-issues.
- **An audited approval gate.** Transitioning an issue or posting a comment is an
  outward-facing write into a system humans read, so it must be restricted to
  named roles and written to an audit trail — see D3 for why v1 restricts by role
  rather than stopping for a confirmation. The reverted PR had no equivalent of
  either: it could not write to Jira at all.

It is also an **event source**, which no existing plugin is — that is the one
genuinely new platform capability this plan needs (§4).

## 3. The reframe: what moves where

| #1539 put it in the platform | The plugin puts it in |
|---|---|
| `/api/jira-tokens` + `JiraTokens.jsx` | a **generic** per-scope plugin credential store (§5) — no Jira-specific page |
| `env.jiraProjects[]` on the Working Environment | per-scope **watch config** in the plugin's own state volume, edited in its `/admin` UI route |
| `jira-event` trigger type + 8 UI surfaces | **one generic** `plugin-event` trigger type (§4), or zero new types in the Phase-1 fallback |
| `jira-poller.js` in the orchestrator | a poll timer inside the **broker sidecar** (`podman-sandbox`'s reaper interval is the precedent) |
| `event-poller-shared.js` extracted from `github-poller.js` | `broker-sdk/event-cursor.js` — **`github-poller.js` is not touched at all** |
| `jira-digest` kind + `_execute_jira_digest` in `agent-entrypoint.py` | burst collapsing inside the broker; the agent is woken once and drains the burst through the CLI |
| (deferred) a `JiraEventLog.jsx` page | the plugin's own UI route (the `/` route's **Activity** tab — a 14-day retained log of what the poller saw and did), plus one platform event-log row per wake |
| — | `aee-jira` CLI facade — the agent-facing surface #1539 never had |

The net platform diff drops from ~6 000 lines across 51 files to **two generic
additions** (§4, §5) that every future event-source plugin reuses.

## 4. Platform gap 1 — a broker may wake an agent

This is the crux, and the only part with no existing precedent.

**Today there is no broker → orchestrator channel at all.** Every broker is a
pure server: the orchestrator pushes to it (`PUT /internal/scope-registry`,
`PUT /internal/scope-credentials`, `POST /internal/teardown-scope`) and nothing
calls back. Reachability is not the problem — a sidecar is created on
`${COMPOSE_PROJECT}_default` (`plugin-runtime.js:254`), the same compose network
the orchestrator is on, so `http://orchestrator:4002` already resolves from a
broker. What is missing is a *contract*.

Three ways to close it; **recommend B, with A as a de-risking spike.**

### Option A — the content-free doorbell (zero platform change)

The broker fires the agent's existing **`http` trigger** at the webhook server
(`POST /hooks/:agentId/:hookId`, `X-Hook-Secret`). That path already ignores the
POST body and runs the trigger's own configured prompt — so the wake carries no
Jira payload. The agent instead **pulls** it: `aee-jira inbox --json` drains the
per-scope queue of unconsumed events the broker is already holding.

*Pro:* ships against today's platform, unmodified. The doorbell/pull split is
honest — the broker is the source of truth for what happened, and the agent reads
it from there rather than from a prompt that may be stale by the time it runs.
*Con:* the operator must wire an `http` trigger by hand and give the broker its
agent id + hook id + secret, which is a per-scope push the orchestrator would
need Jira-specific code to build (`plugin-github-creds.js` is exactly that shape
— and exactly the plugin-specific orchestrator code this plan is trying to avoid).

### Option B — a generic `plugin-event` trigger (recommended)

One new trigger type, **generic to plugins, not to Jira**:

```jsonc
{ "id": "on-jira-ready", "type": "plugin-event",
  "pluginId": "jira",             // which granted plugin may fire this
  "eventFilter": "status_changed", // opaque to the platform; the broker's vocabulary
  "payloadFilter": { "toStatus": "Ready for Dev" }, // optional: exact match on top-level
                                   // string fields of the delivered payload — how one
                                   // plugin's events are routed to different agents
  "prompt": "…the wake instruction…" }
```

and one new internal endpoint:

```
POST /internal/plugin-event
Authorization: Bearer <plugin scope token>
{ "pluginId": "jira", "scopeId": "<team>", "event": "status_changed",
  "summary": "PROJ-42: Login flow — In Progress → Ready for Dev",
  "payload": { … }, "eventId": "PROJ-42:10431" }
```

The orchestrator verifies the scope token (`plugin-scope-token.js`, the same
verification the broker does in the other direction), resolves the scope to its
team, and enqueues into every **granted** agent in that scope whose
`plugin-event` trigger names this `pluginId` and matches `eventFilter`. The
grant is the authorisation: a plugin can only wake agents it was granted to.

Delivery reuses the `#2030` machinery wholesale — a `kind: 'plugin-event'`
pending entry drained through the same `_execute` chokepoint (so it inherits the
`#1157` WorkspaceGate and the `#611` backstop), the payload arriving in an
`<external-event source="plugin:jira">` envelope parallel to the existing
`source="github"` one, and one `source: 'internal-plugin'` event-log row per
wake — the tag `github-label-applied` already writes.

*Why not reuse `kind: 'wake-agent'`:* its `note` is capped at 1024 code points
and framed as `<external-agent-handoff>` **from a peer agent**. An external
system's event is not a peer hand-off, and mislabelling it in the prompt is the
kind of small dishonesty that costs a debugging session later. Same reasoning
`wake-agent.js` itself gives for not widening `flow-emit`.

*Cost:* one trigger type, one endpoint, one queue kind, one prompt envelope,
one `TriggerForm` branch. Compare with #1539's five layers — and every one of
these is spent **once**, for every event-source plugin that follows.

**The four touch points, named — because missing the first one fails silently.**
Verified against source, not inferred:

1. **`agent-image/scripts/agent-entrypoint.py` ~L5203** — the pending-queue drain
   matches an entry to a trigger with
   `t.get("type") in ("http", "github-event")`. A `plugin-event` trigger is not
   in that tuple, so the entry would be enqueued, fail to match, and be dropped
   with a "Pending trigger not found" log line. **This is the one failure mode
   that looks like nothing happening at all** — no error surfaces to the user,
   the wake simply evaporates. Widen the tuple in the same commit that adds the
   type.
2. **`admin-console/src/pages/agent-chat/TriggersPanel.jsx:572`** — `knownTypes`
   is a hard-coded `Set(['cron','once','http','github-event','loop'])`; an
   unlisted type silently falls back to `'cron'` when the form opens, so editing
   an existing `plugin-event` trigger would rewrite it as a cron.
3. **`pollerSubscribes` (`orchestrator/github-poller.js`)** — must exclude
   `plugin-event` from the GitHub poll plan, the same exclusion `transport:
   'internal'` already gets.
4. **`isAutonomousState` (`orchestrator/agent-autonomy.js`) — no change needed.**
   It is `sessionPolicy === 'per-invocation' || triggers.length > 0`, so a
   `plugin-event` trigger flips the agent to autonomous (and rebuilds its
   CLAUDE.md) for free. Recorded so nobody "fixes" it into a type list.

### Option C — extend `flow-emit`

Rejected for the reason `wake-agent.js` already documents: `validateEmitRequest`'s
required `label` + `target` are load-bearing for all its callers, and a Jira event
anchors to no GitHub artifact.

## 5. Platform gap 2 — per-scope plugin credentials

The manifest's `credentials: [{key, description, required}]` field is **validated
and then ignored**: nothing provisions it. `plugins/test-mgmt/broker/vendor-client.js`
reads `process.env.TESTMGMT_API_TOKEN`, i.e. a static value from the manifest's
own `sidecar.env` — one credential for the whole installation, not per scope, and
not settable from the console. The only working per-scope path is
`plugin-github-creds.js`, which is **plugin-specific orchestrator code**.

Jira needs `{siteUrl, email, apiToken}` **per granted team**.

**Decided (D1): make `credentials[]` real.** A generic per-scope plugin
credential store. A **Credentials** section on the plugin's card in `/plugins`
(or its `/admin` UI route) renders one field per manifest-declared key, per scope
the plugin is granted to; values are written `0600` under
`/workspace/plugins/_credentials/<pluginId>/<scopeId>.json`, following the
`_keys/` convention `plugin-registry.js:34` already names; the orchestrator
pushes them through the **existing** `pushScopeCredentials` wire on every
reconcile and grant change.

**Scope correction, verified against source: the wire is generic, its caller is
not.** `plugin-runtime.pushScopeCredentials(manifest, scopesMap)` is already
plugin-neutral, but the only thing that calls it is
`orchestrator.js:pushGithubIssueScopeCredentials()`, which opens with a
hard-coded `const PLUGIN = "github-issues"` and then enriches every scope with
GitHub-specific data (`teamName`, `flowLabels`, `labelAgents`, `labelUsage`).
So D1 is not "add a store and reuse the push" — it is **add a store and
generalise the call site**: a `pushDeclaredScopeCredentials()` that walks every
installed plugin declaring `credentials[]`, resolves each granted scope's entry
from the store, and pushes. `github-issues` keeps its bespoke enrichment as a
per-plugin hook rather than as the shape of the only code path. The scope-id
resolution it already does (`effectivePlugins` → `pluginGrantFor` →
`resolveScopeId`) is directly reusable and is also exactly what §4B's wake
authorisation needs — write it once, in one place, for both. Raw values are never read back — fingerprint and
preview only, like every other credential in the platform.

**Decided (D2): a Team Admin sets their own scope's credential.** This mirrors
who may bind a GitHub token to a Working Environment today, so teams provision
themselves without a platform admin in the loop, and it keeps one team's entry
out of another's reach. Two consequences to build deliberately rather than
discover: the write path is authorised per `scopeId` (a Team Admin of team A
cannot write team B's entry even by crafting the request), and because a Jira
token is site-wide and carries the *person's* permissions, the entry records who
set it and when, and shows that in the UI — an operator asking "whose access is
this agent acting with?" must not have to guess.

The alternative considered and rejected was copying `plugin-github-creds.js`
into a `plugin-jira-creds.js` plus a Jira credential page: faster to a working
Jira, but it re-imports two of the five layers #1539 was reverted for and has to
be unpicked as soon as a second plugin needs the same thing.

This decision does three things beyond Jira: it retires
`plugin-github-creds.js`'s specialness (it becomes one resolver among several
behind a generic push), it unblocks `test-mgmt`'s declared-but-unusable
credential, and it means `docs/confluence-plugin-plan.md` §4's credential
question needs no separate answer.

## 6. The plugin itself — `plugins/jira/`

### 6.1 Manifest (`plugins/jira/plugin.json`)

```jsonc
{
  "pluginVersion": 1,
  "id": "jira",
  "name": "Jira",
  "description": "…plain language, install-review copy…",
  "sidecar": { "image": "localhost/aee-plugin-jira:latest",
               "capabilities": ["egress"], "internalPort": 4009 },
  "cli": { "name": "aee-jira", "entrypoint": "bin/aee-jira.py", "runtime": "python3" },
  "credentials": [
    { "key": "site-url",  "description": "Jira Cloud site (subdomain or full origin)", "required": true },
    { "key": "email",     "description": "Atlassian account e-mail (Basic-Auth user)",  "required": true },
    { "key": "api-token", "description": "Jira API token (held only by the broker)",    "required": true }
  ],
  "platforms": ["podman"],                     // see the Kubernetes note below
  "scopes": ["team"],
  "defaultScopeGranularity": "team",
  "quota": { "maxObjects": 500 },
  "policy": {                                  // D3: restrict by role, no confirm
    "transition": { "scopes": ["team"] },
    "comment":    { "scopes": ["team"] }
  },
  "ui": { "title": "Jira",
          "routes": [ { "path": "/", "minRole": "team-member" },
                      { "path": "/admin", "minRole": "team-admin" } ] },
  "promptLine": "…what the agent may do with `aee-jira`…"
}
```

`scopes: ["team"]` only — a Jira site binding is a team-level fact, and offering
`agent` granularity would multiply watch configs with no benefit.

**`platforms: ["podman"]` for v1 — corrected after reading
`spawn-kubernetes-plugin.js`.** An earlier draft of this plan said
`["podman","kubernetes"]` on the reasoning that this is a UI-bearing plugin with
no host socket. That is true of the *UI* half and false of the half that
matters. On Kubernetes `reconcilePluginAttachments()` returns
`{ skipped: 'kubernetes-ui-reachability-needs-no-networkpolicy' }` (L507) — the
agent→broker network path is never established, so **`aee-jira` exits 3 on a
hosted stack**. The wake half (broker→orchestrator) would still work, because it
runs the other direction. The result is the worst of both: on GKE the plugin
would wake agents that then cannot read the ticket they were woken about —
reproducing the exact doorbell-with-no-door failure this plan exists to fix,
except now it *looks* installed and healthy. `platforms` is the honest gate for
this (the same gate `podman-sandbox` uses permanently), so v1 declares
`["podman"]`. Kubernetes support is unblocked by per-grant NetworkPolicy, which
is a separate platform epic and not a line item here.

### 6.2 Broker (`plugins/jira/broker/`)

Built on `broker-sdk` — `verifyScopeToken`, `scopeFilter`, `auditWriter`,
`maskSecrets`, `healthEndpoint`, `teardownScopeEndpoint`, `parkForApproval`,
`authorizeAction` all come from the SDK unchanged. New modules, all pure +
`node --test`:

- **`jira-client.js`** — the REST surface, lifted almost verbatim from
  `jira-poller.js`: `POST /rest/api/3/search/jql` with `expand=changelog`,
  the paginated `/rest/api/3/issue/{key}/changelog` truncation fallback
  (`changelog.total > histories.length`), Basic auth, and `resolveJiraApiBase()`
  (bare subdomain → `https://<x>.atlassian.net`, full origin used as-is). Keep
  the manual trailing-slash strip — the regex form is a CodeQL ReDoS finding.
  A `JIRA_API_BASE` seam for tests, mirroring `github-client.js`'s.
- **`event-extract.js`** — `extractStatusChangeEvents()`, `matchesStatusFilter()`,
  `computeQueryWindowMinutes()` (the catch-up widening capped at 24 h, which is
  the piece that makes a restart not silently drop transitions). Copy these from
  `jira-poller.js` essentially unchanged; they are the good part of #1539.
- **`watch-store.js`** — per-scope watch config + poll cursor on
  `AEE_PLUGIN_STATE_DIR`, atomic temp-file+rename writes, in the shape of
  `netzplan/plan-store.js`. A watch is
  `{ projectKey, statusFilters?: string[], jql? }`
  — the watch fires on a transition into any status in the set (empty = any); a
  legacy singular `statusFilter` migrates on read. A watch names no agents:
  which agent a transition wakes is decided per agent by its `plugin-event`
  trigger (`payloadFilter`, Option B) — the pre-Phase-2 `wake.agentIds` field
  is ignored on read and no longer shown anywhere. The cursor also carries a
  short `recentErrors` ring (`watch-health.js`) surfaced on the `/watches` route.
- **`inbox-store.js`** — the per-scope queue of events delivered but not yet
  consumed, TTL-reaped against the manifest quota. Backs `aee-jira inbox` and
  makes Option A viable as a fallback. **This is what `quota.maxObjects` counts**
  — say so explicitly, because the SDK deliberately does not know what an
  "object" is for a given plugin and an undefined answer means `quotaExceeded`
  never fires and the field is decorative. A watch config is *not* an object (it
  is operator configuration, not agent-created state).
- **`poller.js`** — the `setInterval` loop, one bucket per
  `${siteUrl}::${projectKey}` (the per-site scoping decision from #1539 §"Project-key
  scoping" — a project key is not globally unique, so it must never be a global
  map), seen-id dedup, burst collapsing, then the wake call from §4.
- **`viewer-headers.js`** — the §4.8 verifier, copied as `github-issues` and
  `netzplan` each do (the broker build context cannot reach `admin-console/`).

**`broker-sdk/event-cursor.js` (new, shared).** The poller primitives #1539
extracted out of `github-poller.js` — `selectFreshEvents` (seen-id set capped at
`SEEN_MAX`), `planBurstHandoffs` (burst cap → one digest), the sliding-window
throttle, `computeBackoffDelayMs` — belong in the SDK, whose source is already
vendored into every broker image. Put them there **as a copy, not a refactor**:
`github-poller.js` keeps its own and is not touched by this work at all. The
duplication is the same trade the platform already accepts for
`plugin-manifest.js` and `plugin-scope-token.js`; a mirror test can pin the two
if we decide it is worth it, but the poller that runs the whole GitHub flow
should not be destabilised for a new plugin.

### 6.3 CLI facade (`plugins/jira/bin/aee-jira.py`)

Dependency-free single file, `--json` on every subcommand, exit codes 0/1/2/3,
`--help`, submit→poll for anything slow — driven by
`orchestrator/plugin-cli-contract.test.js` retargeted at it, exactly as
`aee-echo`/`aee-podman`/`aee-test` are.

| Subcommand | Class |
|---|---|
| `aee-jira inbox [--consume]` | read — what woke me |
| `aee-jira projects` | read — projects in scope |
| `aee-jira list --project KEY [--status …]` | read |
| `aee-jira show ISSUE-1` | read |
| `aee-jira comment ISSUE-1 --body …` | attributed write → `policy` |
| `aee-jira transition ISSUE-1 --to "Ready for Dev"` | attributed write → `policy` |

Reads are open to any granted agent; **both writes are role-gated and neither
stops for a human confirmation (D3)** — moving a ticket is routine and
reversible, and an approval pen on it would stall every unattended run at the
first transition. The broker enforces the gate server-side (`authorizeAction`),
so a prompt cannot talk an unauthorised agent past it, and every write lands in
the plugin's audit trail with the calling scope.

`requiresApproval` stays deliberately **unused** in v1 rather than removed from
the design: it is the right mechanism the day a genuinely destructive Jira
operation is added (bulk transition, delete), and leaving it wired-but-empty
means that day costs a manifest line.

This is the whole agent-facing surface #1539 never had — its Jira integration
could only *wake* an agent, which then had no way to read or update the issue
that woke it.

### 6.4 UI

- `/` (team-member), two tabs:
  - **Board** — issues in scope; the **Watching** panel (one expandable card per
    watched project with a Watching / Degraded / Failing health pill + roll-up,
    and a failure-detail panel — count, next retry, the actual error log, a
    Retry-now button for admins); the per-scope inbox.
  - **Activity** — the retained event log ("what did the poller see, and what did
    it do with it"): a 14-day per-scope log with one row per fresh status change
    tagged `delivered` / `digested` / `throttled` / `filtered` / `stale` / `baseline`,
    filterable by issue type and by watched-vs-all. This is the `JiraEventLog.jsx`
    #1539 deferred, at zero platform cost (`activity-store.js`).
- `/admin` (team-admin) — the watch config: project + a **set** of target
  statuses (chips). Which agents a transition wakes is not configured here but
  on each agent's `plugin-event` trigger (its `payloadFilter`). This replaces
  `env.jiraProjects[]` *and* the `jira-event` trigger fields *and* the eight
  `'jira-event'` UI branches.

Follow `github-issues/ui/`: `--eb-*` design tokens re-declared for the three
themes (the iframe is a separate document), the pre-paint `eb-theme` read plus
the `storage`-event follow, and `markdown.js` for issue descriptions.

## 7. What this plan deliberately does NOT do

Carried forward verbatim from #1539's v1 boundary, and still right:

- **No claim-label analogue.** Nothing in Jira marks an issue "picked up" the way
  `ready` → `ready:wip` does on GitHub.
- **No Process-Canvas participation.** A Jira wake is not a flow edge; it does not
  appear as a producer/consumer node, and `channels`/`dataFlow`/`humans[]` are
  untouched.
- **No flow-anomaly integration.** The four classes read GitHub label/timeline
  state and have no Jira signal to read.
- **No Jira Server / Data Center.** Different auth model, different API surface.
- **No two-way sync.** The plugin reacts to Jira and writes to Jira on request; it
  does not mirror state.

## 8. Rollout phases

Each phase is independently mergeable and leaves `main` shippable.

- **Phase 0 — spike (1 PR, no platform change). ✅ landed.** Broker +
  `jira-client.js` + `event-extract.js` + poller, waking via Option A's `http`
  doorbell against a hand-wired trigger (`PUT /internal/spike-config`). Proves
  the JQL/changelog/dedup core against a real Jira Cloud sandbox before any
  platform surface is spent. Ships `plugins/jira/` (manifest + minimal
  `aee-jira whoami|inbox` CLI + broker), `broker-sdk/event-cursor.js`, the
  `plugin-images` Makefile line and the `jira-broker` CI job. `computeQueryWindow
  Minutes` (24h-capped catch-up widening) is the one design improvement over
  #1539's fixed poll window.
- **Phase 1 — per-scope plugin credentials (§5, D1+D2). ✅ landed (Jira-wired).**
  The generic store (`orchestrator/plugin-credential-store.js`, 0600 at
  `/workspace/plugins/_credentials/<pluginId>/<scopeId>.json`, metadata-only
  readback) + a generic push (`pushDeclaredScopeCredentials()` — walks every
  installed plugin declaring `credentials[]`, resolves each granted team scope,
  pushes via the existing `pushScopeCredentials` wire) + `GET/PUT/DELETE
  /api/plugins/:id/credentials[/:scopeId]` (PUT/DELETE gated to Team Admin of
  that scope, `setBy` forced to the caller) + a **Credentials** section on the
  Plugins-page card. The jira broker's `resolveCredential` now reads the pushed
  per-scope map (`PUT /internal/scope-credentials`) instead of env. **The
  `github-issues` retrofit + `test-mgmt` unblock are deferred to a follow-up**
  (they touch two working plugins for no Jira benefit — requester decision);
  `github-issues` keeps its bespoke `pushGithubIssueScopeCredentials` and a
  plugin is in exactly one path (it declares `credentials: []`, so the generic
  walker skips it).
- **Phase 2 — the `plugin-event` trigger (§4B). ✅ landed.** `POST
  /internal/plugin-event` (scope-token authed — `{pluginId, scopeId}` come from
  the token, never the body), a generic `plugin-event` trigger type
  (`{pluginId, eventFilter?, prompt}`), the `kind: 'plugin-event'` queue entry,
  `_execute_plugin_event` through the same `_execute` chokepoint, the
  `<external-event source="plugin:<id>">` untrusted envelope, a `TriggersPanel`
  authoring branch + `TypeBadge`, the `plugin.event` event-log key, and the #506
  in-flight marker. The jira broker's `deliver()` now POSTs `/internal/
  plugin-event` (minted scope token) instead of the doorbell. Two of the four
  §4B touch points needed NO change after all: `pollerSubscribes` already gates
  on `type === 'github-event'`, and `isAutonomousState` already flips on
  `triggers.length > 0`.
- **Phase 3 — CLI + read UI. ✅ landed.** `aee-jira projects` / `list --project
  KEY [--status …]` / `show ISSUE` added to the Phase-0 `whoami` / `inbox`, all
  server-side through the broker's per-scope credential; retargeted
  `plugin-cli-contract.test.js` covers it. Broker `/cli/{projects,list,show}`
  endpoints + `jira-client.listProjectIssues`. The `/` UI route (team-member):
  a served page (`ui/`, dependency-free, `--eb-*` tokens, signed viewer
  headers) showing the team's projects → issues, the per-scope inbox, and what
  the poller is watching (project + cursor). Manifest gains `ui.routes` `[{ / ,
  team-member }]`; the console's generic plugin-UI proxy + nav discovery pick it
  up with no console change. The plugin's own poll-event log (§6.4) is deferred
  — the platform GitHub Event Log already carries a `plugin.event` row per wake
  (Phase 2).
- **Phase 4 — writes. ✅ landed.** `aee-jira comment ISSUE --body …` and
  `aee-jira transition ISSUE --to "Status"` — POST through the broker, which
  calls `broker-policy.authorizeWrite` (→ SDK `authorizeAction` against the
  manifest's `policy: { comment|transition: { scopes: ["team"] } }`) BEFORE
  touching the credential, and audits every write. D3: role-gated, **no
  confirmation pen** (moving a ticket is routine + reversible), `requiresApproval`
  wired-but-empty for a future destructive op. `jira-client`:
  `addComment` (ADF body, agent-attributed paragraph), `listTransitions` +
  `transitionIssue` (resolves the transition id from the target status name,
  409 naming the options when none leads there). The `/admin` route (team-admin)
  edits the watch config (`{ projectKey, statusFilters? }` rows) — replacing
  #1539's `env.jiraProjects[]`, the `jira-event` trigger fields *and* the
  Phase-0 `spike-config` seam; which agents a change wakes stays a per-agent
  `plugin-event` trigger (Phase 2).
- **Phase 5 — docs. ✅ landed.** `docs/jira-plugin.md` (operator + agent guide,
  replacing the reverted `docs/jira-integration-concept.md`),
  `plugins/jira/broker/README.md`, the `plugins/README.md` entry,
  `docs/plugin-system-concept.md` §8 item 22, and the CLAUDE.md plugin-registry
  paragraph. **No new context-help topic** — `help-coverage.test.js` already
  passes for `/plugins/jira/ui` via the generic `/plugins/:id/view` ALLOWLIST
  entry, and there is no per-plugin help-topic convention (github-issues /
  netzplan / gke shipped the same way; the plugin system's `help-topics/
  plugins.md` covers the whole system).

## 8b. Build and CI wiring — hardcoded lists, not globs

Two places assume a closed set of plugins. Both are one-line additions, and both
are silent if forgotten (nothing fails; the thing simply never runs).

- **`Makefile: plugin-images`** is six literal `podman build` lines, not a glob
  over `plugins/*/broker/Dockerfile`. Add the Jira line, or `make build`
  produces no `aee-plugin-jira:latest` and the sidecar fails to start with an
  image-not-found that reads like an install bug.
- **CI has exactly one broker job** (`netzplan-broker`). `plugins/github-issues`,
  `plugins/test-mgmt` and `plugins/podman-sandbox` all ship `broker/*.test.js`
  that **never run in CI today**. A `jira-broker` job must be added explicitly or
  §9's whole suite is decorative — it passes on a developer's laptop and is never
  seen again. Worth fixing the three existing gaps in the same PR: it is the same
  15-line job copied four times, and "the broker tests run" is a precondition for
  trusting any of this.

## 9. Testing

1. **Pure cores, `node --test`** — changelog→event flattening (including the
   truncated-changelog fallback), `statusFilters` gating, `computeQueryWindowMinutes`
   catch-up widening, seen-id dedup, burst collapsing, watch-store round-trip.
   Port #1539's `jira-poller.test.js` (276 lines) — it is good and mostly reusable.
2. **Cross-scope isolation** — the property no unit test of #1539 could express:
   two scopes on two sites with the same `projectKey` never see each other's
   issues, and a scope token for team A cannot read team B's inbox. Model on
   `broker-sdk/scope-token.test.js`'s forgery/cross-scope cases.
3. **CLI contract** — `plugin-cli-contract.test.js` retargeted at `aee-jira`.
4. **Wake authorisation** — a `plugin-event` call for a plugin/scope combination
   with no grant wakes nobody and is refused, not silently dropped.
5. **Fake-Jira fixture** for e2e, implementing `/rest/api/3/search/jql` and
   `/rest/api/3/issue/:key/changelog`, in the shape of the existing fake-GitHub.
6. **Manual smoke** — install, grant to a team, set credentials, configure a
   watch, transition a real issue, confirm one wake and one event-log row;
   transition twice in a window and confirm one wake per distinct history id;
   bulk-transition above the burst cap and confirm one digest.

## 10. Decisions

Settled before Phase 1; recorded here so a later reader sees the reasoning, not
just the outcome.

- **D1 — the generic plugin credential store, not a Jira-specific one (§5).**
  One extra PR up front, and it is the only option that does not re-import a
  layer the revert removed. Also unblocks `test-mgmt` and pre-answers the
  Confluence plan's credential question.
- **D2 — a Team Admin provisions their own scope's credential (§5).** Mirrors
  Working-Environment GitHub-token binding. Authorised per `scopeId`; the entry
  records who set it and when, because a Jira token carries a named human's
  site-wide permissions.
- **D3 — Jira writes are role-gated, not confirmation-gated (§6.1, §6.3).**
  `policy` restricts `transition`/`comment` to named roles and the broker
  enforces it server-side; no approval pen, so unattended flows complete.
  `requiresApproval` stays wired but unused, for a future destructive action.
- **D4 — no separate throttle on `plugin-event`.** *(settled by precedent, not
  asked.)* The broker already collapses bursts before it ever calls the
  platform, and `#611`'s consumer-side runaway backstop still applies to
  whatever it does deliver — so a third limiter would only add a second place to
  look when a flow misbehaves. This is the same answer, for the same reason,
  that `#2030` reached for `wake-agent`, and it carries the same re-open
  condition: if diagnosing a runaway ever requires knowing *which pair* looped,
  revisit it.
- **D5 — the wake is generic, the plugin is not.** *(restated from §4B, because
  it is the decision the whole plan turns on.)* The platform learns "a plugin may
  wake an agent it is granted to, with a payload". It learns nothing about Jira.
  Every future event-source plugin — ServiceNow, Azure DevOps, Confluence
  webhooks — reuses that one mechanism.

## 11. Deferred

- **One Atlassian credential shared between Jira and Confluence?**
  `docs/confluence-plugin-plan.md` §4 recommends reusing a single token, since
  one Atlassian API token commonly covers both products on a site. Under D1 the
  honest shape is two plugins, each holding its own credential entry, which may
  happen to contain the same secret value — so revoking one never silently
  breaks the other. Nothing in this plan depends on the answer; settle it when
  Confluence starts, not now.
- **More event kinds than `status_changed`** (`issue_created`, `comment_added`
  with an `origin` stamp against the self-comment loop, a generic
  `field_changed`, …) — assessed and planned in
  `docs/jira-plugin-events-plan.md`. All broker-side plus manifest `events[]`
  entries; the trigger form and help follow from the manifest.
