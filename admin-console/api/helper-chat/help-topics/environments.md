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
  - "I added a repository to an existing environment — why does the agent not see it?"
  - "What exactly does Sync all agents do?"
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
| **MCP servers** | Optional server + credential references from the MCP registry, materialised into the agent's `.claude/settings.json` at creation. Set elsewhere — this page's form has no MCP picker. |
| **Model provider** | Optional override — agents start on this provider and its default model instead of the global `ANTHROPIC_BASE_URL` from `.env`. |
| **Agent toolchain** | Optional — which container image the agents are spawned from, picked from the operator registry. Absent means the default image. |
| **Additional instructions** | Markdown appended to the agent's `CLAUDE.md`: project context, coding conventions, domain terminology, constraints every agent here should follow. |

Skills are *not* part of an environment. They are granted to a team or an agent
(Agents page, Team-Setup wizard, Knowledge page); an environment carries only
infrastructure.

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
| Repositories | Nothing, until you run **Sync all agents** (below). Changes otherwise apply to **newly created agents** only. |
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
key. The branch is the branch checked out **at clone time**; leave it blank to
get the repository's own default branch. Changing it later does not switch an
existing checkout.

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

### Sync all agents

Because repositories are cloned once, a repository added to an environment later
never reaches the agents that already exist. **Sync all agents** — on the edit
form, below the repository list — closes that gap: it clones the **missing**
repositories into every agent already using this environment and reports one
line per repository per agent as it goes.

What it deliberately does not do: it never re-clones, fetches, pulls or switches
the branch of a repository that is already there (those are left untouched), and
it does not restart anything — the files land in the workspace the running
container already shares. A member that has not been materialized yet has no
workspace and is reported as skipped; a **disabled** agent, on the other hand,
is synced normally, since its workspace exists. The action appears only while
editing an environment that has at least one repository and at least one agent.

For a single agent the same job is available on the agent itself — **Sync
repositories** on its settings form, or the Workspace Browser in the Agent Chat
right rail.

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

**This form has no MCP picker**, so an environment's pairs cannot be chosen or
changed here. They are written by the Agent Team Wizard (its Knowledge step
shows them read-only) or through the API, and are visible per agent as an MCP
override on the Agents page. Saving this form does not disturb an existing set —
it simply never sends that field — so an environment paired by the wizard keeps
its pairs when you edit its repositories.

Two consequences worth knowing: the substitution happens once, at seeding, so
changing a server or its credential reaches only agents created afterwards; and
the MCP Servers page refuses to delete a server or credential an environment
still references, which is why detaching it here (through the wizard or the API)
comes first.

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
