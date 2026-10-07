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

   Each image is stamped with the checkout's **build identity** (#2646) — the
   short commit hash (`-dirty` for uncommitted changes) and the commit
   timestamp, the same `GIT_COMMIT` / `GIT_DIRTY` / `GIT_COMMIT_TIME` the console
   shows. They are baked in as `AEE_BUILD_COMMIT` / `AEE_BUILD_DIRTY` /
   `AEE_BUILD_COMMIT_TIME` (every broker Dockerfile ends with that `ARG`/`ENV`
   block, defaulting to `unknown`) and as OCI labels, readable without starting
   anything:

   ```bash
   podman image inspect localhost/aee-plugin-jira:latest \
     --format '{{index .Labels "org.opencontainers.image.revision"}} {{index .Labels "aee.build.commit-time"}} {{index .Labels "aee.build.tag"}}+{{index .Labels "aee.build.tag-distance"}}'
   ```

   Since #2893 the identity also carries the nearest **release tag** and the
   number of commits since it (`GIT_TAG` / `GIT_TAG_DISTANCE` →
   `AEE_BUILD_TAG` / `AEE_BUILD_TAG_DISTANCE`, labels `aee.build.tag` /
   `aee.build.tag-distance`), computed by `scripts/git-release-tag.sh`: only
   `v<major>.<minor>.<patch>` tags count, the nearest one wins, and several on
   one commit resolve to the highest version. Both are empty when no release tag
   is reachable (no tags, a shallow clone without fetched tags) — never a build
   failure. The `make plugin-images` summary prints them next to the commit.
   The Plugins page reads the version as:

   | Build | Shown as |
   |---|---|
   | exactly on a tag | `v0.4.0` |
   | 12 commits after it | `v0.4.0+12 (5500e15)` |
   | dirty working tree | `v0.4.0+12 (5500e15-dirty)` (on the tag: `v0.4.0 (5500e15-dirty)`) |
   | no tag info | `5500e15` — the hash, as before |

   The mismatch hints keep comparing commits, never tags.

   A running broker reports the same values on `GET /healthz` as
   `build: { commit, dirty, commitTime[, tag, tagDistance] }` (Broker SDK
   `healthEndpoint`); the orchestrator asks every live sidecar, so the Plugins
   page shows what the container really runs, not what `:latest` points at now.
   Another build path must pass the same `--build-arg`s (`PLUGIN_BUILD_ARGS`),
   or the image reports `unknown` (without the tag args: the hash only).

2. **Seed the registry** so operators can see the plugin:

   ```bash
   make seed-plugins        # or `make seed-pool`, which chains it
   ```

   Copies `plugins/<id>/` into the pool volume → the operator registry at
   `/workspace/plugins/<id>/`.
   Every seeded plugin gets a `build-info.json`
   (`{ commit, dirty, commitTime, tag, tagDistance }`)
   with the same identity; installing copies it into the registry, so the
   **Installed files** line on the Plugins page names the commit the manifest
   and CLI came from.

3. **Install** (System Admin) from the **Plugins** page (`/plugins`) or
   `POST /api/plugins/:id/install`. Install copies the plugin into the operator
   registry and makes the orchestrator start its broker sidecar. The declared
   capabilities are shown in plain language for review first, because a sidecar
   can hold real privilege (e.g. `podman-sandbox` mounts the host Podman
   socket). **Install still grants nothing to any agent.**

   Each card shows the **Installed files**, **Running broker** and **Broker
   image** build identities (the last read from the image labels in the local
   store; *unknown* on Kubernetes). **"Running broker differs from its image"**
   means the image was rebuilt under a running sidecar — a rebuilt `:latest`
   image does not replace a running sidecar; it keeps the old image until the
   sidecar container is recreated. **"Running broker differs from installed
   plugin"** means the live sidecar runs another commit than the installed
   manifest and CLI; reinstalling brings them back in step.

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
normal paginated listing. The broker owns all qualifiers (`repo:`, `type:issue` /
`type:pr`, `in:title`, `state:`) and strips colons from user input so a typed
`qualifier:` can never broaden scope.

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

**Pull requests (#2746):** a **Show** selector — *Issues* (default), *Pull
requests* or *Issues and pull requests* — drives both the listing and the title
search (broker `type=issues|prs|all`); pull requests are marked **PR**, and the
choice is remembered with the repository and state. A label added to a pull
request goes to the #1858 label fast path as `pull_request.labeled` (the broker
reports the kind in its `X-AEE-Label-Target-Kind` response header), so a PR-level
gate wakes its agent immediately, just like an issue label.

Agents can also browse issues read-only with the dependency-free `aee-issues` CLI
(`aee-issues repos`, `aee-issues list --repo owner/name`, `aee-issues show --repo
owner/name --number N`); the CLI still lists issues only. See
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

## `jira`

**Wakes a granted agent when a Jira Cloud issue changes status, and lets it read
and update the issue.** A poll loop inside the broker runs a narrow JQL search
per watched project (`updated >= -Nm`, `expand=changelog`), flattens each issue's
changelog into `<issueKey>:<historyId>` status events, gates by an exact
`statusFilter`, dedups against a per-`<siteUrl>::<projectKey>` seen-id cursor,
collapses bursts into one digest, and calls `POST /internal/plugin-event` — the
generic broker→orchestrator wake channel this plugin introduced (§4B of the
plan). The orchestrator fans out to every granted agent carrying a matching
`plugin-event` trigger; the agent runs its own wake instruction with the Jira
payload as untrusted context.

The broker (`jira/broker/`, on the Broker SDK) holds the per-team Jira
credential (`{site-url, email, api-token}`, set by a Team Admin on the Plugins
page, pushed per-scope by the orchestrator — never in the browser or an agent).
`capabilities: ["egress"]`, `credentials: [site-url, email, api-token]`,
`scopes: ["team"]`, `platforms: ["podman"]` (the agent→broker path is
Podman-only, so a k8s stack would wake agents that cannot then read the ticket).

- **CLI** `aee-jira`: `inbox` / `projects` / `list` / `show` (reads, any granted
  agent) + `comment` / `transition` (attributed writes — role-gated server-side
  via the manifest `policy`, **not** confirmation-gated: moving a ticket is
  routine and reversible; D3).
- **UI**: `/` (team-member) — issues, the inbox, the poller's cursor state; and
  `/admin` (team-admin) — the watch config (`{ projectKey, statusFilter? }`
  rows), which replaced #1539's `env.jiraProjects[]` and the `jira-event`
  trigger fields.

This **replaces the reverted built-in Jira integration** (PR #1539): its design
work — JQL/changelog polling, the composite event id, the truncated-changelog
backfill, per-site project scoping — is reused, rehomed from ~6 000 lines across
51 platform files into a plugin plus two generic platform additions every future
event-source plugin reuses: the per-scope plugin **credential store** (§5) and
the **`plugin-event`** wake (§4B). Full design + rollout: `docs/jira-plugin-plan
.md`; operator guide: `docs/jira-plugin.md`.
