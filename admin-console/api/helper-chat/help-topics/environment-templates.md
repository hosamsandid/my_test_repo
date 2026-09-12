---
id: environment-templates
routes: ["/environment-templates"]
title: Environment Templates
summary: Ready-made repo / provider / MCP / toolchain / context sets a new team can copy from at creation — curated by a System Admin, never a live-shared binding.
seeAlso:
  - { label: "SSH Keys", to: "/ssh-keys" }
  - { label: "GitHub Tokens", to: "/github-tokens" }
  - { label: "MCP Servers", to: "/mcp" }
  - { label: "Model Providers", to: "/models" }
  - { label: "Agent Team Wizard", to: "/team-setup" }
askPrompts:
  - "What is an Environment Template?"
  - "Why can't I bind an agent or team directly to a template?"
  - "What does 'start from a template' copy, and what does it leave out?"
  - "Do I need to supply my own SSH key and GitHub token after starting from a template?"
  - "Who can create or edit a template?"
  - "Where did the old environments page go?"
---

## What an Environment Template is

A **template** is a curated environment — repositories, MCP server pairings, model
provider, toolchain and additional context — that a System Admin maintains as a
**copy source** for team creation. It is never a live-shared binding: no agent
and no team can ever be pointed at a template directly, and attempting to
(`environmentId` on `POST /api/agents`, `POST /api/teams`, or `POST
/api/teams/stream`) is refused with `template-not-bindable`.

This replaces the older **global environment** mechanism, which made an
environment *directly usable* by every team with no admin involvement — a live
binding, not a copy. A template is deliberately the opposite: every team that
starts from one gets its own, independent environment, seeded once from the
template's structure.

### Where did the old environments page go?

The general-purpose environments list every user could see is gone. What
replaced it, depending on who is looking:

- **An ordinary team member** edits their own team's environment from the
  Agent Chat rail — open the team, go to its **Settings** tab, and use the
  **Environment** section there. This is the same underlying record; only the
  standalone list page is gone.
- **A System Admin** curates the shared catalog of templates here.

## Repositories

A template's repository rows carry a **URL, branch and read-only flag** —
exactly like an ordinary environment. When a team starts from this template,
those three fields are copied into the team's own, freshly created
environment. The **SSH key is never copied** — the new team's admin selects
their own, or leaves the repository without one until they do.

## Credentials

Nothing you bind to a template travels with it. An **SSH key**, a **GitHub
token** or an **MCP credential** set here exists only so you, as the curator,
can verify the template's repository/MCP pairing actually resolves — no team
that later starts from this template ever receives them. This is deliberate:
a template is a copy source, not a way to hand your own credentials to every
future team.

## MCP server references

A template's MCP rows carry a **server reference** (which registry entry) —
copied into a new team's environment exactly like a repository URL. The
**credential is never copied**, for the same reason as above: the new team's
admin pairs their own credential with the copied server reference.

## Toolchains

The System-Admin **Toolchains** registry (which container image an
environment's agents run from) is cross-cutting — it applies to every
environment, template or not, and is reached from this page for convenience.
Registering a toolchain here does not itself create or change any template.
