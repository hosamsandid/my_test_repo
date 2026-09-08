# Reference plugins

Governed capability extensions beyond the agent container
(`docs/plugin-system-concept.md`). A plugin pairs a privilege-holding **broker
sidecar** with a **dependency-free CLI facade** seeded into the agent workspace.
All security lives server-side in the broker; the CLI is a privilege-less
client.

Each `plugins/<id>/` is a **self-contained** reference plugin shipped in the
repo — both halves (the CLI facade the agent runs and the broker sidecar that
holds the privilege) live in the one directory:

```
plugins/<id>/
  plugin.json     # the manifest (pluginVersion: 1) — see admin-console/api/plugin-manifest.js
  bin/            # the CLI script(s), seeded into a granted agent's .agent-studio/bin/
  broker/         # the broker sidecar (server.js + Dockerfile), if the plugin has one
  README.md       # per-plugin notes (some plugins)
```

> **Layout note.** The broker sidecars used to live as top-level directories at
> the repo root (`podman-mcp/`, `netzplan-broker/`, `test-mgmt-broker/`,
> `patterns-catalog-broker/`). They now live inside their plugin as
> `plugins/<id>/broker/`. The shared **`broker-sdk/`** stays at the repo root
> (it is a library imported by every broker, not a plugin); each broker's
> Dockerfile has a build context of the repo root and vendors `broker-sdk/`
> into its image, so `require('../../../broker-sdk')` resolves the same way in
> the source tree and inside the container.

`make seed-plugins` (chained from `make seed-pool`) copies these into the pool
volume at `/pool/plugins/<id>/`, which surfaces to operators as the plugin
registry at `/workspace/plugins/<id>/`. Registering/installing a plugin from
the registry **grants nothing** to any agent — grants are a separate, Team-Admin
action (Phase 2).

## Installing a plugin

Getting a plugin from this repo to a granted agent is three deliberate steps —
building the broker image, seeding the registry, installing, then granting:

1. **Build the broker image(s)** (only for plugins that have a `broker/`):

   ```bash
   make plugin-images
   ```

   Builds `localhost/aee-plugin-<id>:latest` for each broker from its
   `plugins/<id>/broker/Dockerfile` (build context = repo root). Image tags
   must match the `sidecar.image` in the plugin's `plugin.json`. This is **not**
   chained from `make up` — a broker sidecar holds real privilege, so building
   it is an explicit action.

2. **Seed the registry** so operators can see the plugin:

   ```bash
   make seed-plugins        # or `make seed-pool`, which chains it
   ```

   Copies `plugins/<id>/` into the pool volume → the operator registry at
   `/workspace/plugins/<id>/`.

3. **Install** (System Admin) from the **Plugins** page (`/plugins`) or
   `POST /api/plugins/:id/install`. Install copies the plugin into the operator
   registry and makes the orchestrator start its broker sidecar. The declared
   capabilities are shown in plain language for review first, because a sidecar
   can hold real privilege (e.g. `podman-sandbox` mounts the host Podman
   socket). **Install still grants nothing to any agent.**

4. **Grant** the plugin to a team or agent (Team Admin) — from the Agents edit
   form's plugin picker, or `POST /api/agents/:id/plugins/activate`. Only then
   does the agent get the CLI in its `.agent-studio/bin/` and a scoped token;
   this is an additive file sync, no respawn.

## Manifest

Validated by the pure `admin-console/api/plugin-manifest.js` (the
`process-template.js` discipline). Key fields:

- `sidecar.capabilities` — a **closed enum** (`podman-socket`, `egress`,
  `host-mount:<path>`); a plugin cannot request an arbitrary mount.
- `scopes` — the scope granularities the broker honours (`["team"]` or
  `["team","agent"]`); bounds what a grant may choose (Phase 2).
- `ui.routes[].minRole` — role-gated UI routes; **validated and reserved** in
  Phase 1, the proxy/enforcement lands in Phase 5.

- `scopes` — the scope granularities the broker honours (`["team"]` or
  `["team","agent"]`); bounds what a grant may choose (Phase 2). A manifest may
  also declare `defaultScopeGranularity` (within `scopes`) — the grant default
  when the admin does not choose one; absent, the platform default is `team`.
- `quota` — `{ maxObjects, ttlSeconds? }`, the **per-scope** resource cap for a
  resource-creating plugin (§4.6), so agent granularity on an n-member squad
  costs n× the footprint (stated as a ceiling in the grant UI).

## `dummy-echo`

A no-op reference plugin for exercising and demonstrating the plugin system end
to end. Install and grant it as a safe smoke test — a way to confirm that plugin
install, sidecar lifecycle and grant-driven network wiring all work before
installing a plugin that holds real credentials or reaches an external system.
Agents drive it with the dependency-free `aee-echo` command-line tool
(e.g. `aee-echo hello`).

## `podman-sandbox` (plugin #1)

The first real broker (Phase 3, #1519): a governed container sandbox — PR
#1287's `podman-mcp` broker reworked onto the plugin machinery. Agents drive
containers with the `aee-podman` CLI: `aee-podman run <image>` for a single
container (no compose file; pure CLI sugar over `compose up`, inheriting all
broker guarantees; #1550), or `aee-podman compose up -f compose.yml` for
multi-service stacks. The broker holds the libpod socket and scopes every
container to the caller. Declares `defaultScopeGranularity: "agent"` (the §10
decision) and a per-scope `quota`. See `podman-sandbox/README.md`.

## `test-mgmt` (plugin #2)

Test management (Phase 5, #1521): a granted agent creates test cases, triggers
test runs (submit→poll) and manages test data in an external test-management
system (Xray/Zephyr/qTest) with the `aee-test` CLI. Its broker
(`test-mgmt/broker/`) is built on the Broker SDK (`../../../broker-sdk/`) — the
proof a credential-backed broker is thin: the vendor token lives only in the
sidecar. It is the first plugin to use scope granularity for **authorisation**,
not just isolation (manifest `policy`: create-case is restricted to the
flow-final agent whose cross-checks passed) and the first real
`requiresApproval` flow (destructive `data-delete` waits for human confirm). See
`test-mgmt/README.md`.

## `patterns-catalog`

A read-only reference catalog of engineering patterns, browsable in the console.
It covers an SDLC delivery-workflow view and a Mainframe Modernization pattern
catalog (COBOL, JCL, DB2, IMS, re-engineering, strangler-fig, microservice
extraction, and more). It is off until an operator turns it on: install it, then
grant it to a team to make its catalog pages available in that team's sidebar.
Once installed its nav entry is also visible to every authenticated user without
a per-team grant (opt-in `ui.global: true` in the manifest — a human-UI
convenience; agent CLI access still requires a team grant). It holds no
credentials and reaches nothing outside itself (`capabilities: []`,
`credentials: []`, `scopes: ["team"]`). Its broker (`broker/`)
is a minimal static-file server: `server.js` serves the catalog pages behind
`verifyViewerHeaders` and exposes no MCP tools and keeps no state; teardown is a
no-op. Agents list the available catalogs with the dependency-free `aee-patterns`
CLI (e.g. `aee-patterns list`).

## `netzplan` (plugin #3)

Network Plan (epic #1554, Phase 3, #1563): an editable team **planning board** —
zones, lanes, milestones, owners and requirement lines — served from its own
sidecar and iframed into the console through the §4.8 UI-extension stack (#1562).
The first **UI-bearing** plugin and the first that holds no privilege at all
(`capabilities: []`, `credentials: []`, `scopes: ["team"]`). Its broker
(`netzplan/broker/`) is built on the Broker SDK and keeps one board **document
per team** on the generic state volume (`AEE_PLUGIN_STATE_DIR`), so state is
server-side (two browser profiles see the same board; it survives a sidecar
restart) rather than in a viewer's `localStorage`. The load-bearing model
decision (concept §4): statuses and requirement targets key on **milestone ids,
never array indices**, so inserting or reordering a milestone shifts nothing
else. Agent write access is an explicit ladder off by default
(`settings.agentAutonomy` 0/1/2, §8): agents read with `aee-plan show` at level 0,
tick milestones at 1, edit structure at 2 — enforced broker-side and audited
under the calling agent's id. See `netzplan/broker/README.md`.

## `patterns-catalog`

A UI-only, privilege-less **reference-catalog** plugin (`capabilities: []`,
`credentials: []`, `scopes: ["team"]`, one `ui.route` `/` @ `team-member`): the
former built-in **Patterns Catalog** console page (SDLC + Mainframe
Modernization catalogs) re-shipped as a plugin, so it is off by default and
re-activated per install by install + team grant. Its broker
(`patterns-catalog/broker/`) is a minimal static-file server on the Broker SDK —
it serves the catalog pages behind the §4.8 signed viewer headers, with no MCP
tool surface and no state store. The dependency-free `aee-patterns` CLI lists
the catalogs.

## `github-issues`

The first plugin that both **holds a credential** and **bears a UI** (issue
#1633). It brings the everyday, read-mostly GitHub issue actions into the console
so releasing work (e.g. a BA applying a `ready` gate) no longer means switching
to GitHub: pick a team you are on → one of its Working Environment's repositories
→ **list** that repo's issues, **read** one (body rendered as Markdown), and
**add / remove a label**. It reuses the single GitHub token already bound to the
team's Working Environment — the broker (`broker/`) holds it and
makes every call server-side, so the token never reaches the browser or an agent.
Standard **team-grant gating** (no `ui.global`): it appears only for the teams it
is granted to, and any member of such a team may use it.

**Label suggestions (#1642):** the orchestrator derives the gate, outcome, and
wake labels from the team's actual flow definition (label registry ∪ `labelFilter`
triggers ∪ `emits`) and pushes them alongside the credential. These **flow labels**
are suggested ahead of the repo's raw label list; each one shows an inline caption
of which agent(s) it wakes (the `labelAgents` trigger preview). If the flow defines
no labels, the repo's own labels are shown instead. Free-text entry always works.

**Pagination + title filter (#1658):** the issue list is now a **Previous / Next pager**
(replaces the old "Load more" append — each page replaces the list) with a debounced
**title filter** at the top. The filter drives a server-side search over the whole
repository via GitHub's Search API (`GET /search` on the broker's `/ui` surface) so
results are not limited to the currently loaded page; clearing the box restores the
normal paginated listing. The broker owns all qualifiers (`repo:`, `type:issue`,
`in:title`, `state:`) and strips colons from user input so a typed `qualifier:` can
never broaden scope.

**Workflow-trigger buttons (#1730):** the issue detail now leads with an **action
bar** — between the issue's meta line and its description — of prominent
**`Trigger <Agent>`** buttons, one per flow label that wakes at least one agent.
Each reads as an active "start this workflow" intervention (under the hood it is
the same add-label call) and is colour-coded by how the label is normally set —
a **human-set gate** vs an **agent-set label** — using a glyph and a text tag as
well as colour, so the distinction survives dark / light / high-contrast. A
button shows the underlying label name and, when a label wakes more than one
agent, says so; an already-applied label's button is shown visible-but-disabled.
The "Labels" list and free-text "add a label" area at the bottom are unchanged.

Agents can also browse issues read-only with the dependency-free `aee-issues` CLI
(`aee-issues repos`, `aee-issues list --repo owner/name`, `aee-issues show --repo
owner/name --number N`). Pull requests are deferred to a later iteration. See
`github-issues/broker/README.md`.

## `gke`

**Read-only Kubernetes cluster access.** It gives a team's granted agents
read-only `kubectl` against the team's GKE cluster, reached through the GCP
Connect Gateway, brokered so the Google cloud credential never enters an agent
container. Agents drive it with the dependency-free `aee-gke` CLI — for example
`aee-gke get ns`, `aee-gke get pods -n platform`, `aee-gke describe deploy <name>
-n <ns>`, `aee-gke logs <pod> -n <ns>`, `aee-gke api-resources`.

**Strictly read-only.** Only read verbs are exposed (get / describe / logs /
api-resources); there is deliberately no apply / create / edit / delete, so an
agent cannot change or remove anything in the cluster — it is the **read-only
pilot** for the pattern.

**Authentication happens in the plugin's own UI** (team-admin only): a team admin
signs the broker in to GCP **once** (gcloud OAuth device flow); the credential is
stored on the broker's state volume, the ~1 h access token is refreshed by the
broker itself, and from then on the team's agents read the cluster without ever
handling a credential. This is a plugin and not a skill precisely because a cloud
credential must not sit in every agent container. Its broker (`broker/`) holds the
Google OAuth credential and runs kubectl (`capabilities: ["egress"]`,
`scopes: ["team","agent"]`, `platforms: ["podman","kubernetes"]`). The page also
carries an always-visible **"What this plugin does"** block above the sign-in
options so a team admin sees the capability before signing in (#1716).

## `jira` (Phase 0 — spike)

**Wakes an agent when a Jira Cloud issue changes status.** A poll loop inside
the broker sidecar runs a narrow JQL search per watched project, flattens each
issue's changelog into `<issueKey>:<historyId>` status-change events, dedups
against a per-`<siteUrl>::<projectKey>` seen-id cursor, collapses bursts, and
wakes the granted agents — which read what happened with the dependency-free
`aee-jira inbox` CLI. The broker (`jira/broker/`) is built on the Broker SDK and
holds the per-scope Jira credential (`{site-url, email, api-token}`);
`capabilities: ["egress"]`, `scopes: ["team"]`, `platforms: ["podman"]` (the
agent→broker network path is Podman-only, so a k8s stack would wake agents that
cannot then read the ticket).

This **replaces the reverted built-in Jira integration** (PR #1539): the design
work — JQL/changelog polling, the composite event id, the truncated-changelog
backfill, per-site project scoping — is reused, rehomed from ~6 000 lines across
51 platform files into a plugin plus two generic platform additions every future
event-source plugin reuses. Full plan + rollout phases: `docs/jira-plugin-plan.md`.

**Phase 0** is a de-risking spike: broker + poller waking via the agent's
existing `http` webhook trigger (the "content-free doorbell"), credential from
the sidecar env, zero platform change. Later phases add the generic per-scope
credential store, a generic `plugin-event` wake, the `aee-jira` reads + writes,
and the `/` and `/admin` UI routes.
