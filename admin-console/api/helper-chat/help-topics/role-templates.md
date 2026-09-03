---
id: role-templates
routes: ["/role-templates"]
title: Agent Templates
summary: The reusable role definitions the Team Setup wizard and the Flow editor build agents from — what the fields mean, and why an edit never touches a running agent.
seeAlso:
  - { label: "Agents", to: "/agents" }
  - { label: "Flows", to: "/flows" }
  - { label: "Agent Team Wizard", to: "/team-setup" }
  - { label: "Skills", to: "/skills" }
askPrompts:
  - "What is an Agent Template and who uses it?"
  - "What is the difference between a chat, a reactive and a pattern role?"
  - "What does per-invocation actually change about an agent?"
  - "I edited a template — why did nothing change on my existing agents?"
  - "What is the difference between Built-in, Edited and Custom?"
---

## What an Agent Template is

An **Agent Template** is a ready-made role definition: a system prompt, a session
behaviour and — optionally — the triggers, ports and skills that belong to that
role. It is a blueprint, not an agent. Nothing on this page runs.

Three surfaces build agents from these templates: the **Agent Team Wizard** (every
role in a process template resolves to one), the **Flow editor**'s *Add agent →
From a template* tab, and **Add member** on a team's card on the Agents page. (A
fourth used to exist — an **Add `<role>` role** button that guessed the role a
team was missing — and was removed, because the guess relied on inferring a source
template a team never records.)

The catalog ships around two dozen mature roles — Business Analyst, Developer, Code
Reviewer, Reworker, Dispatcher, Issue Triage, Documentation Sync and more. They are
deliberately **rudimentary**: parameter-free prompts (only the weave-time
`{{stageName}}` / `{{stagePrefix}}` tokens remain), one role-specific wake split
into a single trigger per event, and a daily self-curation cron that prunes the
agent's own `memory/`.

## Built-in, Edited, Custom

| Badge | What it is |
|---|---|
| **Built-in** | A default shipped with the platform. Read-only — it has no Delete action. |
| **Edited** | Your override of a built-in. Saving a built-in creates it: the override *shadows* the default and survives a redeploy or a re-seed. **Reset** discards your edits and restores the built-in. |
| **Custom** | A template you authored yourself, either with **New template** here or with **Save as template** on a live agent (Agents page), which snapshots that agent's effective prompt, skills and session policy into a new entry. |

Deleting a Custom template or resetting an Edited one only removes it from *future*
selection. Already-created agents are unaffected.

## An edit only reaches future agents

This is the rule that surprises people most: an agent created from a template is an
**independent copy**. Changing the template later does not reach back into agents
that already exist — they keep the prompt and configuration they were created with.

To change a running agent, edit that agent (Agents page, or its member row inside a
team). To change what the *next* one looks like, edit the template here.

## Role type

The role type (`category`) is metadata that tells the rest of the platform how the
role is meant to be used:

- **chat** — an always-on companion. You talk to it; it responds to direct
  messages.
- **reactive** — event-driven. It sleeps until a GitHub event or a label trigger
  wakes it.
- **pattern** — a scaffold role for the Flow Weaver rather than a concrete team
  member (the generic `scout` / `stage-author` / `stage-companion` trio). These
  carry `{{stageName}}` tokens the weaver binds when it composes a flow, ship
  disabled by default, and are kept out of the wizard's ordinary role offering.

Leaving it unset is allowed; the role simply carries no hint.

## Invocation mode

The invocation mode (`sessionPolicy`) decides what a *triggered* run starts from —
it does not affect chatting with the agent:

- **persistent** (the default when unset) — a triggered run resumes the agent's last
  conversation, so it still has that context in front of it.
- **per-invocation** — every triggered run starts fresh, with no `--resume`.

Per-invocation has a second, larger consequence: it marks the agent **autonomous**.
An autonomous agent gets the trigger-management documentation in its system prompt
(so it can read and edit its own schedule) and is framed for unattended runs, where
no human may be reading in real time. Because it keeps nothing between runs, it is
told to write anything durable into its memory files first. Every member the Team
Setup wizard creates is per-invocation for exactly this reason.

## Prompt and Advanced

The prompt is stored in one of two fields, and the **Contains `{{variables}}`**
checkbox picks which: a literal prompt, or a `promptTemplate` whose placeholders
are resolved per member when the agent is created (`{{repoFullName}}`,
`{{agentId}}`, the stage tokens).

The **Advanced** box is the raw JSON for everything the form has no field for —
triggers, ports (`emits`, `dataFlow`, `channels`, `github`), skills. Triggers here
are ordinary trigger definitions; one marked `intrinsic: true` is part of the
role's essence (Issue Triage's `issues.opened`, the self-curation cron) and the
Flow Weaver keeps it while dropping the wiring it generates itself.

Only a System Admin can reach this page — a template change affects every team
created from it afterwards.
