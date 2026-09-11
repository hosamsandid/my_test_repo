# Working Environments

A **Working Environment** is a reusable workspace recipe applied when an agent is created. It bundles the infrastructure an agent needs to operate: credentials, repositories, MCP servers, and a model provider. Skills are **not** part of a Working Environment — they are granted to a team or an agent (see [Skills System](skills-system.md)).

## Fields

| Field | Purpose |
|---|---|
| **Repositories** | Zero or more Git repos to clone, each with an optional SSH key binding — see [Repository-less environments](#repository-less-environments) |
| **GitHub Token** | PAT used by the GitHub poller for event-driven triggers; also authenticates HTTPS GitHub repository cloning and the real-time repo-check probe |
| **MCP Servers** | Optional server/credential references (from the MCP registry) materialised into the agent's `.claude/settings.json` at creation |
| **Model Provider** | Optional override — the agent inherits `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` from this provider rather than the global default, but only for the values the provider carries: an `api-key` provider saved without a token repoints the Base URL and leaves the global `ANTHROPIC_AUTH_TOKEN` in place, while an `oauth-token` provider clears both (see [Model Providers](model-providers.md)) |
| **Agent Toolchain** | Optional — which container image the environment's agents are spawned from, chosen from the operator toolchain registry; absent means the default image (see [Agent toolchain](#agent-toolchain)) |
| **Additional Context** | Markdown appended to the agent's `CLAUDE.md` after the environment section |

**Ownership is not a field on this form.** Who an environment belongs to — a
single **team**, **shared** across several teams so each one sees it in its
pickers and reuses it as its own, or **global** — reachable by every user and
every agent with no team assignment at all, including teams created later —
is derived from the owning team, not chosen when the environment is created or
edited. Any Team Admin of an assigned team may still edit a shared
environment's content; deciding *which* teams it reaches, moving it between
team-owned and shared, and publishing or retracting the global flag are all
System-Admin-only and happen on the **Administration → Resources** tab, not
here.

## What happens at agent creation

When a new agent is created with a Working Environment, the orchestrator:

1. Seeds `.claude/` and `memory/` from the skill-pool volume
2. Copies the agent's granted skills into the workspace (resolved team-pool-first, then global — the grant lives on the team or agent, not on the environment)
3. Clones the configured repositories — SSH repos use the bound SSH key; HTTPS GitHub repos use the environment's GitHub token
4. Materialises the environment's MCP server references into the agent's `.claude/settings.json`
5. Assembles a merged `CLAUDE.md` from the base template, the environment section, and the agent's own prompt

This means all agents in the same Working Environment share the same repository and credential access — but each gets an independent workspace and memory that evolves separately from that point on.

## Repository-less environments

A Working Environment may have **no repository** at all. Materializing a team onto
a repo-less environment creates the team and its agents normally — nothing is
cloned, and the agents run with their own workspace as the working directory
rather than a `/repo` checkout. This suits teams whose work is not tied to a
codebase (research, drafting, analysis).

The one trade-off: GitHub hand-off channels (PR / issue triggers and outcomes)
have no repository to act on, so they are unavailable for a repo-less team. Add a
repository to the environment if the team needs them. The Create team dialog
shows an inline note when the selected environment has no repository.

## Agent-scoped repositories

A repository on the environment reaches **every** agent in it. When only one
agent needs one more — a reference codebase, a second service, a documentation
repo — attach it to that agent instead of widening the environment: the
**repositories** button in the Agent Chat **Workspace** view, or the same panel
in the agent's **Settings** tab next to *Sync repositories*.

The configuration is this page's repository card, field for field. What differs
is the scope and what follows from it:

- The environment record is **not** modified, and no sibling agent gains the
  repository, has its prompt changed, or is restarted. A later *Sync all agents*
  neither propagates it to siblings nor removes it from the agent that has it.
- It is **cloned into the same `./<repo-name>/`** path an environment repository
  would use, is listed in that agent's `CLAUDE.md` the same way (read-only
  annotation included), and survives a container respawn and a workspace
  re-seed — it is re-cloned like an environment repository.
- It carries **no credential of its own**: the clone uses the existing SSH-key
  registry or this environment's GitHub token. A repository neither can reach is
  refused before any clone is attempted, naming which credential was tried.
- Only a user who may **manage** the agent can attach or remove one; a chat-only
  user sees the list but no action.
- Removing it **deletes the working copy**, and the confirmation names the
  uncommitted changes and unpushed commits it would take with it.

Attaching is what an environment repository is not: a per-agent decision. If
several agents need the repository, put it on the environment.

## Agent toolchain

Every agent container runs one image. The default — `as-agent:latest` — carries
Python, Node, git/ssh/`gh`, the Claude Code CLI and the platform CLIs, but **no
other language runtime**: no JDK, no Maven, no .NET, no Go. An agent bound to a
Java repository can read and edit the code but cannot compile or test it.

A Working Environment may therefore name a **toolchain**: a container image
derived from the default one, adding a language stack. Agents bound to that
environment are spawned from the toolchain's image; every other environment
keeps the default, unchanged.

Two properties are worth knowing before you use it:

- **You pick from a registry, not by typing an image name.** An agent container
  receives its environment's SSH identity, its GitHub token and the model
  credential, so whoever chooses the image chooses what executes with those
  secrets. Only a **System Admin** can register a toolchain (the **Toolchains**
  button on the Working Environments page); a **Team Admin** selects an
  already-registered one. Both halves are enforced server-side, so the split
  holds regardless of what any UI shows.
- **Changing it restarts the environment's running agents.** A container's image
  is fixed for its whole lifetime, so a new toolchain reaches a running agent
  only by recreating it — exactly like repointing the environment at a different
  GitHub token. Work in flight is interrupted, so change it at a quiet moment.
  The form warns you, naming how many agents are affected.

If a selected toolchain is not registered, is not built for the runtime this
stack uses, or its image is not present/pullable, the agent **refuses to start**
with a message naming the environment and the toolchain. That is deliberate: the
alternative — quietly falling back to the default image — would bring the agent
up without its toolchain and fail confusingly later, at the first `mvn`.

### The installation-wide default: `AGENT_IMAGE`

`AGENT_IMAGE` on the orchestrator sets the image used by every agent whose
environment names no toolchain. It defaults to `as-agent:latest`; the Kubernetes
manifests set it explicitly (`deploy/k8s/base/app/40-orchestrator.yaml`, with
the test/preprod overlays pointing it at the Artifact Registry), and
`docker-compose.yml` leaves it unset so the compose stack uses the default tag.

Use it to move the *whole installation* onto a different base image. It is the
wrong tool for giving one team a language stack: repointing it moves every agent
of the installation, and a toolchain on that team's Working Environment does
exactly that job without touching anyone else.

On Kubernetes a toolchain image must exist in the registry the cluster's nodes
pull from — `AEE_AGENT_IMAGE_PULL_POLICY` and `AEE_IMAGE_PULL_SECRET` apply to
it just as to the default image. A `localhost/…` tag built on a developer
machine does not exist there, which is what a toolchain's platform list is for:
mark such an image podman-only and it is not offerable on a hosted stack.

Concept and roadmap (why the *version* of a stack belongs in the project
repository rather than in the image): [Agent
toolchains](agent-toolchains-concept.md).

## Editing a Working Environment

Most changes to a Working Environment affect newly created agents only — an
existing agent keeps the workspace state it was created with.

**Repositories are the exception (#2066).** Saving an environment that already
has agents notices what changed about its repository list and *offers* to bring
those agents up to date: an added repository is cloned in, and one whose branch,
address or SSH key changed is adjusted in place — but only where that agent's
existing clone is clean and fully pushed. Anywhere it is not, the clone is left
completely untouched and reported with the reason, because a checkout may hold
the only copy of someone's work. Nothing is ever stashed, reset or
force-checked-out.

A **removed** repository is never deleted from any agent, under any
circumstance: the agents keep their copies and you are told so. Removing one
from a workspace is a manual step.

Accepting is your choice, and declining is not a dead end — the environment list
carries a persistent *"N agents not up to date"* badge derived from the agents'
actual workspaces, and clicking it runs the same propagation. For one agent the
same job is **Sync repositories** on its Settings tab; both surfaces drive the
same propagation, so they cannot disagree about what a change would do.

## Editing from a team's Settings tab

The general-purpose Working Environments page described above is **retired**
(#2170, epic #2166 A4) — there is no longer a standalone page listing every
environment. A `role: 'team'` agent's Working Environment is now edited
without leaving Agent Chat: open the team's **Settings** tab and its **Working
Environment** section renders grouped tabs — **Repositories · Model provider ·
Toolchain · MCP servers · Additional context** — over the same environment
record, saved through the same `PUT /api/environments/:id` the retired page's
form used. A repository change still gets the save-time propagation offer
described above; a provider or toolchain change still respawns the team's
running agents. The **GitHub Token** select joined the Repositories tab in
#2170, since that page was the only surface that could set it.

Not carried onto that surface: the environment's **Name**/**ID** (fixed at
creation, rarely revisited) and ownership/team (the environment already
belongs to this team; editing its content is not a re-tier). A System Admin
can still re-tier an existing environment from **Administration → Resources**.

## The System-Admin Environment Templates catalog

The other half of the retired page — curating a shared, reusable environment —
is now **Environment Templates** (`/environment-templates`, System-Admin-only).
A template carries the same infrastructure fields (repositories, MCP pairings,
model provider, toolchain, additional context) but is never a live-shared
binding: no agent or team can be pointed at one directly (`environmentId` on
`POST /api/agents`, `POST /api/teams` or `POST /api/teams/stream` refuses a
template with `template-not-bindable`). Instead, `POST /api/environments`
accepts an optional `copyFromTemplateId` that seeds a **new**, independent
environment's structure from the named template — repositories and MCP server
references are copied, but every credential reference (`sshKeyId` on a
repository, `credentialId` on an MCP pairing) is deliberately stripped, so the
team that copies a template always supplies its own. This replaces the earlier
**global environment** flag (`global: true` + `scope: 'system'`, #2158), which
made a record directly usable by every team with no admin action — a live
binding, not a copy; a pre-existing global record is read as a template on the
Environment Templates list (`isTemplateEnvironment`'s migration rule) and
becomes a real, on-disk `isTemplate: true` record the first time it is saved
from that page. The `isTemplate` flag is set only by a System Admin
(`resolveTemplateFlag`, mirroring `resolveGlobalFlag`'s publish-gate shape).
