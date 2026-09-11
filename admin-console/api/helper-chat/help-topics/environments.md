---
id: environments
routes: ["/environments"]
title: Working Environments
summary: A reusable workspace recipe — the repositories, credentials, model provider and extra context every agent created from it inherits.
seeAlso:
  - { label: "SSH Keys", to: "/ssh-keys" }
  - { label: "GitHub Tokens", to: "/github-tokens" }
  - { label: "MCP Servers", to: "/mcp" }
  - { label: "Model Providers", to: "/models" }
  - { label: "Agent Chat", to: "/chats" }
askPrompts:
  - "What does an agent inherit from its Working Environment?"
  - "When are the repositories cloned into an agent's workspace?"
  - "I added a repository to an existing environment — does the agent get it?"
  - "What happens when I remove a repository from an environment?"
  - "Why was one of my agents left alone instead of brought up to date?"
  - "What does the 'agents not up to date' badge on the list mean?"
  - "Do I need an SSH key or a GitHub token for a private repository?"
  - "What does the Read-only checkbox on a repository do?"
  - "Where do I set the MCP servers an environment pairs?"
  - "My agent cannot run Maven — how do I give it a JDK?"
  - "Why can I only pick a toolchain from a list instead of typing an image name?"
---

## What a Working Environment is

A **Working Environment** is a reusable workspace recipe: it defines the
infrastructure every agent created from it receives. You pick one environment
when you create an agent, and all agents sharing it get the same repositories and
credentials — but **each agent has its own isolated workspace**, which evolves
separately from that point on.

| Part | What it does |
|---|---|
| **Git repositories** | Zero or more repos, cloned into the agent's workspace when the agent is created. Add several — e.g. the main codebase plus a separate documentation repo. Each row can bind its own SSH key. |
| **GitHub token** | Optional personal access token, injected as `GH_TOKEN` / `GITHUB_TOKEN`. Needed for the `gh` CLI, HTTPS pushes and the GitHub poller behind event-driven triggers. |
| **MCP servers** | Optional server + credential references from the MCP registry, materialised into the agent's `.claude/settings.json` at creation. Paired on this form — see *MCP server references* below for the seed-time caveat. |
| **Model provider** | Optional override — agents start on this provider and its default model instead of the global `ANTHROPIC_BASE_URL` from `.env`. |
| **Agent toolchain** | Optional — which container image the agents are spawned from, picked from the operator registry. Absent means the default image. |
| **Additional instructions** | Markdown appended to the agent's `CLAUDE.md`: project context, coding conventions, domain terminology, constraints every agent here should follow. |

**Ownership is not chosen here.** Who an environment belongs to — a single
**team**, **shared** across several teams so each one sees it in its own
pickers and reuses it as if it were its own, or **global** — is derived from
the owning team, never picked on this create/edit form. A System Admin can
still re-tier an existing environment, moving it between team-owned and
shared or publishing/retracting the global flag, but only through
**Administration → Resources**, not here.

Skills are *not* part of an environment. They are granted to a team or an agent
(Agents page, Team-Setup wizard, Knowledge page); an environment carries only
infrastructure.

**Global** widens *reach*, not *authority*: once a System Admin publishes an
environment as global, any user — including one in a team created afterwards —
can select and use it without asking anyone, but only a System Admin can still
edit, re-tier, retract or delete it. A global environment carries no team
assignment at all — that is exactly what "every team, including teams created
later" means. The same flag exists for MCP servers (below), set only at
creation there; publishing an environment as global refuses to save if its
bound model provider is itself team-scoped, since a reachable environment
whose agents cannot get a model is worse than no environment.

The environment **id is fixed once it is created** — everything else can be
edited. The **name** and the **description** are not purely cosmetic: both are
written into the agent's `CLAUDE.md` alongside its repository list, so the
description is read by the agent, not only by you.

An environment **cannot be deleted while an agent still uses it**. The refusal
names one such agent even when several use it — and it counts agents you may not
be able to see, so a delete can be blocked by an agent that is not in your list.
Remove or move those agents first.

### What an edit reaches, and what it does not

This is the single most surprising thing about the page: an environment is a
recipe applied at agent-creation time, so an edit does **not** uniformly reach
agents that already exist.

| You change | What happens to existing agents |
|---|---|
| Repositories | Saving **offers** to bring the existing agents up to date, and does it when you accept (below). Decline and nothing changes — the environment is still saved, and the list shows a *not up to date* badge until you catch up. |
| GitHub token, model provider, default model, toolchain | The environment's **running** agents are recreated so the new binding takes effect. Disabled agents pick it up when they are next enabled. |
| An SSH key selection on a repository row | Nothing immediately — it is used at the next clone or the next respawn. |
| Additional instructions, name, description | Only agents whose `CLAUDE.md` is written afterwards. A recreated agent keeps the file it already has. |
| MCP server references | Only newly created agents — the references are substituted and merged once, at seeding time. |

## Repositories

Repositories listed on an environment are cloned into the agent's workspace
**when the agent is created**, each into a directory named after the repository.
An environment may have **no repository at all**: nothing is cloned and the
agents work in their own workspace instead of a checkout — fine for research,
drafting or analysis teams. The one trade-off: GitHub hand-off channels (PR /
issue triggers and outcomes) have no repository to act on, so they are
unavailable to a repo-less team.

Per row you set the URL, optionally a **branch** and, for an SSH URL, an SSH
key. The branch is the branch checked out at clone time; leave it blank to get
the repository's own default branch. Changing it later **is** offered to the
existing agents — see below — but only where their checkout is clean and fully
pushed, so an agent in the middle of something is never moved out from under it.

Repository URLs are probed for reachability while you type, so a wrong URL or a
missing credential shows up before you save. The probe is **advice, not a gate** —
the form saves an environment whose repositories are all unreachable. A
repository that is reachable but has no commits yet is flagged too, because
agents cannot clone an empty repository.

Cloning is skipped when the target directory already exists, which is what makes
it safe to re-run — but it keys on the directory, not on it being a git
checkout, so two repositories whose URLs end in the same name collide and only
the first one arrives.

### Read-only repositories

Tick **Read-only** on a repository to clone it for reference only. The repository
is still cloned into the workspace and is fully readable and writable on disk;
what changes is that the agent is *told* it is reference-only and must not commit
or push to it, right where the repository is listed in its generated context. It
is an instruction, not a file permission — use it for an upstream codebase, a
shared library, or a docs repo the agent should only read.

### Bringing existing agents up to date

Because repositories are cloned once, a repository change made later does not
reach the agents that already exist on its own. **Saving asks.** When you save an
environment that has at least one agent and the repository list actually changed,
a dialog opens listing what changed — grouped into **added**, **changed** and
**removed** — and offers to bring those agents up to date. Accepting is the
primary action; pressing Enter confirms it. It never runs on its own: a save
always propagates only when you say so.

The save itself is already done by then. Accepting, declining, a failure, even
closing the browser mid-run — the environment stays saved exactly as you
submitted it. Nothing about the propagation can roll a save back.

The three kinds of change are treated differently, and the difference is the
whole point:

| The change | What happens in each agent's workspace |
|---|---|
| A repository **added** | Cloned in, exactly as it would have been at creation time. |
| A repository whose **branch, address or SSH key changed** | Adjusted in place — the remote is repointed, the repository fetched, the declared branch checked out and brought up to its remote — **but only if that clone is clean and fully pushed**. |
| A repository **removed** | Nothing, ever. The agents keep their copies. |

**A clone that is not clean and pushed is left completely alone**, and the report
says what blocked it: uncommitted or untracked files, commits that were never
pushed, a branch with no remote to compare against, a detached HEAD, or a remote
somebody repointed by hand. Nothing is stashed, reset or force-checked-out at any
point — a checkout may hold the only copy of someone's work, and that outranks
the reconciliation. Push or commit, then catch up, and the same repository is
adjusted on the next run. Such a *left alone* line is deliberately not styled
like a failure: nothing went wrong, something is simply waiting on a person.

**Removal never deletes anything.** There is no pruning, under any circumstance —
the removed repository stays in every workspace it was ever cloned into, and the
dialog says so. Removing it from an agent is a manual step. One consequence worth
knowing: the agent's generated `CLAUDE.md` lists the repositories the environment
*declares*, so a removed repository leaves the agent's instructions while its
files stay on disk — and a newly added one enters those instructions before it is
cloned, which is exactly why declining the offer is worth catching up on later.

A changed **address** has two outcomes, decided by the folder name the URL
derives: if the folder name is unchanged the clone's remote is simply repointed;
if it would change, the new repository is cloned into its own folder and the old
folder is **kept** and reported as retained. A changed address is ambiguous —
"the same repository moved" versus "a different repository" — and the folder name
is the only thing the platform actually keys on, so it is the honest tie-breaker.

A member that has not been materialized yet has no workspace and is reported as
skipped — start the agent, then catch up. A **disabled** agent is propagated to
normally, since its workspace exists. Nothing is restarted either way: the files
land in the workspace the running container already shares.

### The "agents not up to date" badge

Declining is not a dead end. The environment list shows a persistent badge on the
**Agents** cell naming how many of an environment's agents are behind, and
clicking it runs the same propagation. The badge is derived from the agents'
**actual workspaces** — not from what the last save happened to change — so it is
still right after a decline, a half-finished run or a failure, and it clears
itself once nothing diverges. Hover it to see which repository is behind in which
agent.

Being behind means, per agent: a declared repository with no clone, or a clone
whose checked-out branch or remote address differs from what the environment
declares. A clone with **no** matching declared entry — a repository you removed —
is never counted, because nothing is ever pruned and it could therefore never be
brought up to date.

For a single agent the same job is available on the agent itself — **Sync
repositories** on its settings form. It is the recovery path for one agent after
a declined offer or a left-alone clone, and it drives exactly the same
propagation, so the two surfaces cannot disagree about what a given change would
do.

## Credentials

Which credential a clone needs depends on the **URL**, not on the repository:

- **SSH URL** (`git@github.com:org/repo.git`) → select an **SSH key** on the
  repository card. Keys are managed on the SSH Keys page, and the key is chosen
  **per repository row**, so two repositories in one environment can use two
  different keys.
- **HTTPS URL** → authenticate with the environment's **GitHub Token**, of which
  there is exactly one per environment. SSH keys do not apply to HTTPS URLs at
  all: an HTTPS GitHub URL with no usable token refuses the clone and says so,
  rather than quietly trying the SSH key you selected.

The two are not redundant. The SSH key moves git data over SSH and can be a
read-only deploy key; the GitHub token is what lets an agent use the `gh` CLI,
push over HTTPS, open pull requests and be woken by the GitHub poller. A leaked
deploy key cannot merge a pull request; a leaked token did not grant the initial
clone.

Neither secret is readable back from the console — an SSH key shows its
fingerprint, a token a short preview. Rotation therefore means pointing the
environment at a new credential rather than editing the old one in place, and
**repointing the environment at a different token recreates its running agents**
so the new one takes effect. Do it at a quiet moment: an agent recreated
mid-run loses the work in flight.

## MCP server references

Static skills live in the workspace; **MCP servers** are how an agent reaches
runtime data (a wiki, a vector store, a graph database). An environment pairs a
server from the MCP registry with a credential from the separate MCP credential
store, and at agent-creation time that pair is substituted per agent and merged
into the agent's own `.claude/settings.json`.

**Pair them on this form.** *Add MCP server* appends a row; each row picks a
server from the registry and, optionally, a credential to substitute into its
template. Removing a row unpairs it. An environment that has never been paired
starts with no rows, and a form you do not touch **never sends the field at
all** — so an environment paired by the Agent Team Wizard or through the API
keeps its pairs when you edit only its repositories.

Two rows the picker will warn you about, because both are knowable when you
choose the pair rather than at seed time: a server whose template needs a
`${credential}` but has none bound (the keys referencing it are **dropped** and
the server is seeded unauthenticated), and a credential bound to a server whose
template has no placeholder (it is substituted nowhere and **ignored**). A row
naming a server that is no longer registered stays visible so you can remove it,
and is skipped when an agent is created.

**A change here reaches only agents created afterwards.** MCP configuration is
written into an agent's own `.claude/settings.json` when that agent is first
created, and no edit or respawn path re-applies it — so agents already using the
environment keep the set they were created with, and the form says so, naming
how many they are, as soon as your selection differs from what is stored. To
give an existing agent a new pairing, recreate it. (A single `team-member` can
also override the inherited list on its own agent form.)

One more consequence: the MCP Servers page refuses to delete a server or
credential while an environment still references it, which is why unpairing it
here comes first.

## Model provider binding

A Working Environment may name a **model provider** and a default model. Its
agents then start on that provider and that model instead of the global
`ANTHROPIC_BASE_URL` from `.env`. Leave the model blank to inherit the provider's
own default; leave the provider blank and the environment inherits from `.env`.

The binding is resolved in one order, most specific first:

1. an **agent's own override** (the model/provider selector in Agent Chat),
2. this **environment's** provider and default model,
3. the platform fallback from `.env`.

So an agent that has been pointed at a provider of its own is not moved by an
environment edit — everything else in the environment is. Changing the provider
or the default model **recreates the environment's running agents**, because the
credential is injected when the container starts.

Providers themselves — their URL, auth type, model catalog and health — are
managed on the Model Providers page.

## Additional context

**Additional instructions for agents (CLAUDE.md)** is free Markdown appended to
the `CLAUDE.md` every agent in this environment reads at startup, in the same
section that lists the environment's name, description and repositories. It is
the right place for project context, coding conventions, domain terminology or
constraints that should apply to every agent here — and the wrong place for
anything secret, since it is plain text in the agent's workspace.

Treat it as material for the agents you create from here on. A plain
environment edit does not rewrite an existing agent's `CLAUDE.md`, and
recreating an agent re-uses the file as it is; the new text reaches an existing
agent the next time that agent's prompt, skills or plugins are saved. To apply
it deliberately, edit the agent's system prompt (saving rebuilds its context) or
create the agent again.

## Toolchains

The default agent image carries Python, Node, git/ssh/`gh`, the Claude Code CLI
and the platform CLIs — and **no other language runtime**. There is no JDK, no
Maven, no .NET, no Go. An agent on a Java repository can read and edit the code
but cannot compile or test it.

A Working Environment can therefore name a **toolchain**: an image derived from
the default one that adds a stack. Its agents are spawned from that image; every
other environment keeps the default, byte-identically. A toolchain ships a
*version manager* rather than a fixed version, so the project repository's own
committed pin file decides which Java or Maven it gets — upgrading is a commit
there, not a platform release.

**Why it is a list and not a text field.** An agent container receives its
environment's SSH identity, its GitHub token and the model credential. Whoever
chooses the image chooses what executes with those secrets — so a free-text image
field would be a privilege-escalation path, not a convenience. The split is the
same as for plugins: a **System Admin** registers a toolchain (the **Toolchains**
button in this page's header) and a **Team Admin** only selects one that is
already registered. Both halves are enforced by the server, not by hiding a
button — the button is shown only to a System Admin as a courtesy, and the
routes behind it refuse anyone else regardless.

### The Toolchains panel

The panel has two doors onto one registry. **Available to install** lists the
variants this platform ships: read the plain-language description and install
one with a single click — the image reference is read from the shipped manifest
server-side, so nobody retypes it. **Register a toolchain** is the manual door
for an image built elsewhere; it takes an id, a name, the image tag and the
platforms the image is actually pullable on.

Registering grants nothing on its own — it only makes the toolchain selectable
on an environment. A registered toolchain **cannot be removed while an
environment still selects it**; clear it there first.

**Changing it interrupts running agents.** A container's image is fixed for its
whole lifetime, so a new toolchain reaches a running agent only by recreating it
— exactly like repointing the environment at a different GitHub token. The form
tells you how many agents will restart; do it at a quiet moment.

**A broken selection refuses rather than degrades.** If the toolchain is not
registered, is not built for the runtime this stack runs on, or its image cannot
be found, the agent does not start and the log names the environment and the
toolchain. Falling back to the default image would instead bring the agent up
*without* its toolchain and fail much later, at the first build command, looking
like a broken repository rather than a misconfigured environment.

One list, two runtimes: a toolchain declares where its image is actually
pullable. An image built locally on a developer machine is podman-only and is
shown greyed out on a Kubernetes stack, where it would have to live in the
registry the cluster's nodes pull from.
