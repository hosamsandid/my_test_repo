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
  - { label: "Agents", to: "/agents" }
askPrompts:
  - "What does an agent inherit from its Working Environment?"
  - "When are the repositories cloned into an agent's workspace?"
  - "I added a repository to an existing environment — why does the agent not see it?"
  - "Do I need an SSH key or a GitHub token for a private repository?"
  - "What does the Read-only checkbox on a repository do?"
---

## What is a Working Environment?

A **Working Environment** is a reusable workspace recipe: it defines the
infrastructure every agent created from it receives. You pick one environment
when you create an agent, and all agents sharing it get the same repositories and
credentials — but **each agent has its own isolated workspace**, which evolves
separately from that point on.

Skills are *not* part of an environment. They are granted to a team or an agent
(Agents page, Team-Setup wizard, Knowledge page); an environment carries only
infrastructure.

## What an agent inherits

| Part | What it does |
|---|---|
| **Git repositories** | Zero or more repos, cloned into the agent's workspace when the agent is created. Add several — e.g. the main codebase plus a separate documentation repo. Each row can bind its own SSH key. |
| **GitHub token** | Optional personal access token, injected as `GH_TOKEN` / `GITHUB_TOKEN`. Needed for the `gh` CLI, HTTPS pushes and the GitHub poller behind event-driven triggers. |
| **MCP servers** | Optional server + credential references from the MCP registry, materialised into the agent's `.claude/settings.json` at creation. The MCP Servers page refuses to delete a server an environment still references. |
| **Model provider** | Optional override — agents start on this provider and its default model instead of the global `ANTHROPIC_BASE_URL` from `.env`. |
| **Additional instructions** | Markdown appended to the agent's `CLAUDE.md`: project context, coding conventions, domain terminology, constraints every agent here should follow. |

An environment may have **no repository at all**. Nothing is cloned and the
agents work in their own workspace instead of a `/repo` checkout — fine for
research, drafting or analysis teams. The one trade-off: GitHub hand-off channels
(PR / issue triggers and outcomes) have no repository to act on, so they are
unavailable to a repo-less team.

## Private repositories: SSH key or token?

It depends on the URL, not on the repository:

- **SSH URL** (`git@github.com:org/repo.git`) → select an **SSH key** on the
  repository card. Keys are managed on the SSH Keys page.
- **HTTPS URL** → authenticate with the environment's **GitHub Token**. SSH keys
  do not apply to HTTPS URLs.

Repository URLs are probed for reachability while you type, so a wrong URL or a
missing credential shows up before you save. A repository that is reachable but
has no commits yet is flagged too — agents cannot clone an empty repository.

## Read-only repositories

Tick **Read-only** on a repository to clone it for reference only. The repository
is still cloned into the workspace, but the agent is told it is reference-only
and must not commit or push to it. Use it for an upstream codebase, a shared
library, or a docs repo the agent should only read.

## Editing an environment: repositories are cloned once

Changes to a Working Environment apply to **newly created agents**. Existing
agents keep the workspace they were created with — editing the environment does
not reach into their workspaces.

To close that gap for repositories, open the environment for editing and use
**Sync all agents**: it clones the listed repositories into every agent already
using this environment and leaves already-cloned repositories untouched. For a
single agent, the Workspace Browser in the Agent Chat right rail does the same
job by hand.

An environment cannot be deleted while agents still use it — remove or move
those agents first.
