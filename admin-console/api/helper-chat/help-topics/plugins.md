---
id: plugins
routes: ["/plugins"]
title: Plugins
summary: Governed capability extensions — how an agent reaches the outside world through a privileged broker instead of holding the credential itself.
seeAlso:
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Administration", to: "/users" }
  - { label: "MCP Servers", to: "/mcp" }
  - { label: "Skills", to: "/skills" }
askPrompts:
  - "What is the difference between installing a plugin and granting it?"
  - "Does activating a plugin restart my agent?"
  - "What does per-team versus per-agent scope granularity change?"
  - "How do I assign a plugin to a team from this page?"
  - "Why does installing a plugin add a new entry to the sidebar?"
  - "How do I build my own plugin?"
  - "Is a platform plugin the same as a Claude Code agent plugin?"
---

## What a plugin is

Agents run inside locked-down containers with no direct path to the outside
world — that isolation is what keeps one agent from touching another's files,
credentials or network. Most work happens entirely inside that sandbox. But some
tasks need a governed connection *out* of it: running a throw-away container to
test something, filing tickets in a test-management system, updating a shared
planning board.

A **plugin** is exactly that connection, made safe. It extends what agents can
reach beyond their container through a privileged **broker** that runs beside the
stack, so the agent itself never holds the credential or the socket. Think of it
as a controlled doorway: the agent asks for something through the doorway, but
the thing that holds the real privilege stays on the other side, where you can
see and audit every request.

Because a plugin is a deliberate, reviewed addition, capabilities never appear by
accident. Nothing an agent can reach was not first granted to it.

The page lists plugins in two sections. **Installed** are the ones whose broker
this stack runs; **Available** are the ones sitting in the pool, ready to be
installed but doing nothing yet. Each card states the plugin's id and version,
its broker status, the name of the CLI command its agents would get (if it has
one), the scope granularities it offers, its per-scope quota, and the privileges
its broker would receive.

Right after you install a plugin its broker needs a few seconds to come up. The
card shows **Broker starting…** meanwhile and checks again on its own; once the
broker runs it switches to **Broker running**. If the broker is still not running
two minutes after the install, the card says **Broker did not start** and
suggests where to look — usually a missing broker image (`make plugin-images`) or
the orchestrator log. A plugin that does not support this stack's runtime says so
on its card.

A directory in the plugin registry that is not a valid plugin — for example a
backup copy such as `jira.bak-…`, whose name is not a valid plugin id (lowercase
letters, digits and hyphens only) — is shown as **Invalid entry** with the
problem listed. It has no broker, scopes or team settings. A System Admin can
delete it with **Remove**.

### Typical use cases

Plugins are the right tool whenever an agent needs a capability that shouldn't be
baked into its container or handed to it as a raw credential:

- **A sandboxed container runtime** — an agent spins up a throw-away container or
  a small multi-service stack to build, run or test something, then tears it
  down, without ever touching the host's container socket.
- **A test-management system** — creating test cases and triggering regression
  runs in a vendor tool (Xray, Zephyr, qTest), where the single vendor token
  lives only in the broker.
- **A planning board** — an agent shows the team's network plan, ticks off a
  milestone, or edits the board, gated by an autonomy ladder so read-only stays
  always-allowed while edits require a higher level.
- **GitHub issues and pull requests** — a governed connection to the code-hosting
  backend for the parts of a flow that must act as a real, audited identity.
- **A reference catalog** — a privilege-less, UI-only plugin that ships a
  browsable library of patterns or documentation as its own embedded page.

The common thread: the capability carries real privilege or a secret, so it is
delivered through a reviewed, audited broker rather than dropped into the agent's
sandbox.

### Platform plugin vs Claude Code agent plugin

Throughout the Admin Console, "plugin" means a **platform plugin** — this
broker-plus-CLI extension of Agent Studio itself. It is *not* a Claude Code
**agent plugin** (the CLI's own marketplace format that bundles skills, commands
and hooks for one agent). Unqualified, it is always the platform one.

## Install and grant are two different steps

This is the distinction the page is built around, and the usual source of "the
plugin is installed, why can't my agent use it?":

| Step | Who | What it does |
|---|---|---|
| **Install** | System Admin | Copies the plugin into the operator registry and starts its **broker**. Grants nothing to anybody. |
| **Grant / activate** | Team Admin | Entitles a team or a single agent to actually use it. |

Two roles divide the work. A **System Admin installs**; a **Team Admin grants**
an installed plugin within their own team. If you can see the registry but its
Install and Uninstall buttons are greyed out, that is the first half of this
split — the page says so directly, and it is not an error. (A button that is
absent entirely means something else: the plugin's manifest is invalid, so there
is nothing to install.)

A grant on a team agent is **inherited by that team's member agents**, unless a
member overrides it. You can grant from this page (per team, on each installed
card — see *Assigning a plugin to a team on this page* below) or per agent on the
**Agents** page — both use the same activation path, so there is no second grant
model to keep in step.

Because the two steps are independent, so are their undos:
**uninstalling revokes nothing**, and revoking a grant does not stop the broker.
What each one actually does to a running agent is in *What activating does*
below.

## Capabilities and the platform gate

Installing is deliberate because a broker can hold real power — one of the
shipped plugins mounts the host container runtime. That is why the install dialog
reviews the declared **capabilities** in plain language before you confirm, and
colours the confirm by risk: a plugin that would receive the host container
runtime gets the danger treatment rather than the routine one.

A plugin cannot request an arbitrary privilege. The capability set is a **closed
enum** the platform knows how to provide — `podman-socket` (the host container
runtime), `host-mount:<path>` (a host folder, attached read-only) and `egress`
(network reach out of the stack) — and a plugin may declare none at all. One that
declares none says so on its card: *Requests no host privileges*. For a UI-only
or advisory plugin that is the honest reading, not a missing detail.

If a plugin declares a runtime it needs (Podman, Kubernetes, or both) and this
stack doesn't provide it, you get an honest "not available on this stack" rather
than a toggle that breaks. The same gate applies later, when you assign the
plugin to a team: the assignment checklist is disabled with that reason rather
than handing out a grant the stack cannot honour.

A card can also refuse for a duller reason. A manifest that fails validation is
listed with its errors and can be neither installed nor assigned.

## Scope granularity and quota

Every grant carries a **scope granularity** — **per team** or **per agent** —
which decides how the granted agents appear to the broker:

- **Per team** — the whole squad shares one broker-side identity and one pool of
  resources. The right default for a shared or expensive backend.
- **Per agent** — every member gets its own identity, so two agents on the same
  team are as isolated from each other as two different teams.

Which granularities are offered is bounded by what the plugin's broker can
actually honour; the platform default is per team unless the plugin declares
otherwise. Each card lists the scopes its plugin offers, so a plugin showing only
`team` is one whose broker cannot tell two members apart — not a setting you are
missing.

The per-scope resource **quota** is stated before you toggle a grant. Read it as
*per scope*, not per plugin: at per-agent granularity a five-member team costs
five times the stated ceiling, because each member is its own scope.

Changing the granularity of an existing grant is not a second grant. The platform
re-mints that agent's token for the new scope and rewrites only its config file;
resources created under the old scope keep their old owner label and are reaped
by their own lifetime rules rather than being adopted into the new one.

## What activating does — and what uninstalling undoes

A grant takes effect **live, without respawning the agent**. The moment you
activate it, the plugin's CLI script and a small config file are synced into the
agent's workspace, the broker is connected to that agent's network, and a
one-line capability note is added to the agent's instructions telling it the
command exists. No restart, no re-seed of the whole workspace — the same additive
sync used for skills.

After that the agent simply calls the plugin like any ordinary command in its
shell. There is no hidden channel and no special rendering: the call shows up as
a normal Bash step in the session log, so you can always see exactly what the
agent ran. Revoking removes the CLI and config and disconnects the broker — just
as live.

**Uninstalling** stops the broker and its containers stop being managed. Existing
grants on agents are left in place — they simply seed nothing while the plugin is
uninstalled, so reinstalling restores them. That is why the uninstall confirm
does not ask you to revoke anything first: nothing is taken away from a team, and
a reinstall does not need the grants re-made. What *does* stop is everything the
broker was doing, immediately — an agent that calls the CLI in the meantime gets
the "broker unreachable" exit code rather than a hang.

Uninstalling also removes the plugin's card from the Installed section, and with
it the team-assignment control on that card, so the page stops offering a grant
it could not act on.

## Plugins with their own UI

Some plugins also serve a small web UI of their own (a dashboard, a planning
board, a reference catalog). When one does, the console
**embeds it inside the same window** and adds a nav entry for it — proxied behind
the *same* session login and role model as every other page, so there is no
second login. That is why installing certain plugins makes a new item appear in
the sidebar.

The plugin UI inherits none of the console's internal state; the iframe boundary
is the contract, and the console forwards only the signed viewer identity and
effective role. A plugin may expose several pages behind its one mount, each
declaring the minimum role it needs — so an admin-only page stays refused to an
ordinary member on both the console side and the plugin side.

A UI-bearing plugin can also opt into **global** visibility, marked with a
*Global UI* badge on its card. Its pages are then visible to every logged-in user
as soon as it is installed, with no team grant at all. This is a decision about
the *human* UI only: the agent-side CLI still comes solely from a team grant, so
a globally-visible plugin with no team assignment gives no agent any new
capability.

## Assigning a plugin to a team on this page

Installed cards carry a **Team assignment** control — the grant, made where you
just installed the plugin, instead of one agent at a time on the Agents page. It
reuses the same activation path the Agents page uses, so there is no second grant
model and no second place to check.

- It appears on **installed** cards only, and disappears with the card when the
  plugin is uninstalled.
- It is **team scope only**. Granting a single agent, or overriding what a member
  inherits, stays on that agent's own surface.
- It applies **immediately** — there is no Save button; each checkbox *is* the
  grant.
- It reuses the plugin's own default scope granularity, so the same plugin
  behaves identically whether you grant it here or per agent.
- The summary line names the teams that currently carry the grant, reading the
  **team-level** grant only. A member that has overridden what it inherits is
  neither shown here nor changed by a toggle here.
- The teams offered are the ones you may grant to. If you have none, the control
  says so in plain language — a statement about your role, not an error — and the
  server enforces the same boundary regardless of what the checklist offers.
- If the plugin cannot run on this stack, or its manifest is invalid, the
  checklist is disabled with that reason.

## Deep dive: how a plugin works, and how to build one

Everything below is reference detail: how a plugin works under the hood, and what
it takes to build one. You never need it to install or grant a plugin.

### How a plugin works, technically

A plugin pairs two pieces. The first is a privilege-holding **broker sidecar**: a
small service that runs beside the stack (not inside any agent) and holds the
real capability — a host socket, a vendor API token, a database handle. The
second is a **dependency-free CLI** seeded into the granted agent's workspace.
The agent only ever runs the CLI; the CLI is a thin client that calls the broker
over the network. The socket or credential lives *only* inside the sidecar, never
in an agent container, so the isolation story stays intact even as the agent
gains a new power.

**Security is enforced server-side, on every call.** Each granted scope is issued
a signed, per-scope token; the broker verifies that token before it does
anything, so a forged or missing token is rejected before any work runs. One
scope never sees another scope's resources — the broker stamps every object it
creates with an ownership label and filters by it — and **every call is written
to an audit log** the broker owns. A non-granted agent cannot even reach the
sidecar: its container is only connected to the sidecar's network when the grant
says so, so reachability matches the grant exactly.

### What it takes to build one

A plugin is a directory in the registry with four parts: a **manifest**, a
**broker sidecar**, a dependency-free **CLI**, and, optionally, a **web UI**
served from the sidecar.

### The manifest (`plugin.json`)

One JSON file declares everything the platform needs to install, secure and
grant the plugin. Key fields:

- `id` / `name` / `description` — identity and the operator-facing blurb shown on
  this page.
- `sidecar` — the broker's container `image`, its `internalPort`, and
  `capabilities`: a **closed enum** of privileged attachments the platform knows
  how to provide (`podman-socket`, `host-mount:<path>`, `egress`). A plugin
  cannot request an arbitrary mount, and a System Admin reviews these in plain
  language before installing.
- `cli` — the CLI facade's `name`, `entrypoint` and `runtime` (`python3` or
  `node`).
- `scopes` — the granularities the broker actually implements (`["team"]` or
  `["team","agent"]`, always including `team`); an optional
  `defaultScopeGranularity` sets the grant default.
- `credentials` — secrets bound at install time from the platform's credential
  store and injected into the *sidecar's* environment, never into agents.
- `platforms` — runtime requirements (`podman`, `kubernetes`, or both).
- `requiresApproval` — subcommands the broker must park for human confirmation
  before running (e.g. a destructive delete).
- `policy` — optional per-subcommand authorisation keyed on the calling scope
  (e.g. only the flow-final agent may create test cases) — the one rule only
  *agent* granularity can express.
- `ui` — optional embedded UI: a `title` and `routes[]`, each with the minimum
  role (`minRole`) it needs, plus the optional `global` visibility opt-in
  described above.
- `promptLine` — the single gated line added to a granted agent's instructions so
  it knows the command exists.

### The broker sidecar's responsibilities

The broker is where all security lives. On **every** call it must: verify the
signed per-scope token (reject forged/missing with 401); stamp every resource it
creates with the caller's ownership label and filter by it so scopes never see
each other; enforce any per-scope quota the manifest declares; write one audit
line per call; mask secret values in its output; and answer the two plain-REST
routes the orchestrator calls on every broker — a **health** probe and a
**scope-teardown** route that reaps a scope's resources (on team or agent
deletion) *before* the platform invalidates the token. If the manifest names
`requiresApproval` subcommands, the broker holds them in an approval pen for a
human confirm.

### CLI contract essentials

- A single **dependency-free file** against the runtimes already in the agent
  image (`python3`, `node`, `curl`) — no installs, no compiled binaries.
- `--json` on every subcommand, and **standard exit codes**: `0` ok, `1` domain
  error, `2` usage, `3` broker unreachable.
- `--help` carries the complete, agent-readable documentation — the agent's
  instructions stay lean and discovery is lazy.
- The CLI reads its endpoint URL and per-scope token from a `0600` config file
  written into the workspace at grant time — so rotation is also a live sync.
- Long-running work uses submit → poll (e.g. `run --async` then `status <id>`),
  never an unbounded blocking call.

### The optional UI extension

If your plugin serves a UI, the sidecar hosts it and the console proxies it
behind the existing session login — you don't build a second auth system. The
console forwards a signed viewer identity and effective role with each request;
your pages read those headers and enforce the `minRole` you declared per route. A
UI-only plugin can declare no capabilities and no credentials at all.

### The recommended Broker SDK

Because every broker owes the same obligations, the platform ships a **Broker
SDK**: a small, dependency-free module a sidecar imports so each author does not
re-implement (and re-break) them. It provides token verification, the
ownership-label scope filter, the audit writer, secret masking, the health and
teardown endpoints, and the approval holding pen — so a credential-backed broker
becomes thin: import the SDK, add only your vendor client and any policy. Using
it is strongly recommended; the platform verifies the wire contract, not the
implementation, so an SDK-free broker that speaks the same protocol is equally
valid.
