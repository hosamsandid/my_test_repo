---
id: role-templates
routes: ["/role-templates"]
title: Agent Templates
summary: The reusable role definitions the Team Setup wizard and the Flow editor build agents from — what the fields mean, and why an edit never touches a running agent.
seeAlso:
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Flows", to: "/flows" }
  - { label: "Agent Team Wizard", to: "/team-setup" }
  - { label: "Skills", to: "/skills" }
askPrompts:
  - "What is an Agent Template and who uses it?"
  - "What is the difference between a chat, a reactive and a pattern role?"
  - "What does per-invocation actually change about an agent?"
  - "I edited a template — why did nothing change on my existing agents?"
  - "What is the difference between Built-in, Edited and Custom?"
  - "If I edit a built-in template, do I still get platform updates to it?"
---

## What an Agent Template is

An **Agent Template** is a ready-made role definition: a system prompt, a session
behaviour and — optionally — the triggers, ports and skills that belong to that
role. It is a blueprint, not an agent. Nothing on this page runs.

Two surfaces build agents from these templates: the **Agent Team Wizard** (every
role in a process template resolves to one) and the **Flow editor**'s *Add agent →
From a template* tab. **Add member** on a team's card is *not* one of them — it
adds a blank member that inherits the team's prompt, not a template's. (A third
used to exist — an **Add `<role>` role** button that guessed the role a team was
missing — and was removed, because the guess relied on inferring a source template
a team never records.)

The catalog ships around two dozen mature roles — Business Analyst, Developer, Code
Reviewer, Reworker, Dispatcher, Issue Triage, Documentation Sync and more. They are
deliberately **rudimentary**: parameter-free prompts (only the weave-time
`{{stageName}}` / `{{stagePrefix}}` tokens remain), one role-specific wake split
into a single trigger per event, and a daily self-curation cron that prunes the
agent's own `memory/`.

Only a System Admin can reach this page — a template change affects every team
created from it afterwards.

## Built-in, Edited, Custom

| Badge | What it is |
|---|---|
| **Built-in** | A default shipped with the platform. Read-only — it has no Delete action. |
| **Edited** | Your override of a built-in. Saving a built-in creates it: the override *shadows* the default and survives a redeploy or a re-seed. **Reset** discards your edits and restores the built-in. |
| **Custom** | A template you authored yourself, either with **New template** here or with **Save as template** on a live agent (Agents page), which snapshots that agent's effective prompt, skills and session policy into a new entry. |

The badge is not a setting — it is derived from *where the file lives*. Built-ins
sit in a seeded directory the platform rewrites on every release; anything you
save goes to a separate user store the platform never touches. An id present in
both reads as **Edited**, and the user copy wins.

**An override is a full snapshot, not a patch.** Saving an edited built-in stores
your whole template, so from then on it is entirely yours: a later platform
release that improves the built-in is **permanently shadowed** for that id, with
nothing to merge and no notification. That is the trade — the override survives
every redeploy precisely because nothing upstream can reach it. **Reset** is the
way back: it deletes your copy and the built-in becomes live again, updates
included.

Deleting a Custom template or resetting an Edited one only removes it from *future*
selection. Already-created agents are unaffected. A **Built-in** cannot be deleted
at all — you are told to edit it into an override first, which you can then reset.

## An edit only reaches future agents

This is the rule that surprises people most: an agent created from a template is an
**independent copy**. Changing the template later does not reach back into agents
that already exist — they keep the prompt and configuration they were created with.

To change a running agent, edit that agent (Agents page, or its member row inside a
team). To change what the *next* one looks like, edit the template here. There is
no "apply to existing agents" action, and no way to ask which template an agent
came from — that link is not recorded once the agent exists.

## Role type

The role type (`category`) is descriptive metadata. It records how a role is
*meant* to be used, so the picker in the Flow editor can show it and the
**Save as template** dialog can pre-fill it:

- **chat** — an always-on companion. You talk to it; it responds to direct
  messages.
- **reactive** — event-driven. It sleeps until a GitHub event or a label trigger
  wakes it.
- **pattern** — a scaffold role for the Flow Weaver rather than a concrete team
  member (the generic `scout` / `stage-author` / `stage-companion` trio). These
  carry `{{stageName}}` tokens the weaver binds when it composes a flow and ship
  disabled by default.

Leaving it unset is allowed; the role simply carries no hint.

**Nothing filters on it.** No wizard, editor or API narrows a list by role type
today — it is shown, never enforced. So it is worth setting for the next reader,
but it changes no behaviour, and a role typed `pattern` still appears wherever any
other template does. What actually makes a pattern role behave like one is its
`{{stageName}}` tokens and its disabled-by-default triggers, not this label.

## Invocation mode

The invocation mode (`sessionPolicy`) decides what a *triggered* run starts from —
it does not affect chatting with the agent:

- **persistent** (the default when unset) — a triggered run resumes the agent's last
  conversation, so it still has that context in front of it.
- **per-invocation** — every triggered run starts fresh, with no `--resume`.

It is effectively a two-state switch. Anything that is not exactly
`per-invocation` — including `persistent` and leaving it unset — is stored as the
default, so those two options describe one behaviour, spelled out and implied.

Per-invocation has a second, larger consequence: it marks the agent **autonomous**.
An autonomous agent gets the trigger-management documentation in its system prompt
(so it can read and edit its own schedule) and is framed for unattended runs, where
no human may be reading in real time. Because it keeps nothing between runs, it is
told to write anything durable into its memory files first, and each of its
triggered runs is asked to extract its lessons before finishing. Every member the
Team Setup wizard creates is per-invocation for exactly this reason.

The implication runs **one way only**. Per-invocation always makes an agent
autonomous — even with no triggers at all. But it is not the only route: **any**
agent carrying at least one trigger is autonomous too, whatever its invocation
mode. So a persistent agent with a cron trigger is autonomous, and leaving this
field alone does not keep an agent out of that framing.

## Prompt and Advanced

The prompt is stored in one of two fields, and the **Contains `{{variables}}`**
checkbox picks which: a literal prompt, or a `promptTemplate` whose placeholders
are resolved per member when the agent is created (`{{repoFullName}}`,
`{{agentId}}`, the stage tokens). Tick it only when the text really contains
placeholders — a literal prompt stored as a template is not rewritten, but the
distinction is what tells the reader which one they are looking at.

The **Advanced** box is the raw JSON for everything the form has no field for —
triggers, ports (`emits`, `dataFlow`, `channels`, `github`), skills, and the
`patternRole` a scaffold role uses. It is the whole template minus the fields
above, and the form's values are layered on top when you save, so a key the form
owns is not worth setting here.

Triggers here are ordinary trigger definitions; one marked `intrinsic: true` is
part of the role's essence (Issue Triage's `issues.opened`, the self-curation
cron) and the Flow Weaver keeps it while dropping the wiring it generates itself.

Two things about the editor itself. The **id is fixed** once a template exists —
it is what every reference points at, so the field is disabled on edit. And saves
are **last-write-wins** with no draft or version history: two admins editing the
same template will overwrite each other silently.
