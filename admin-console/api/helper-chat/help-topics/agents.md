---
id: agents
routes: ["/agents"]
title: Agents
summary: Manage the agents and teams you already have — what each role means, how the lifecycle works, and what Disable, Reset to stub and Delete really do.
seeAlso:
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Create something new", to: "/create" }
  - { label: "Working Environments", to: "/environments" }
  - { label: "Access", to: "/teams" }
  - { label: "Knowledge", to: "/knowledge" }
  - { label: "Flows", to: "/flows" }
askPrompts:
  - "Which agent role should I pick — Agent, Agent Team or Orchestrator?"
  - "What is the difference between an Agent Team and a Team on the Access page?"
  - "What is the difference between Disable, Reset to stub and Delete?"
  - "Why does one of my agents show as not initialised?"
  - "Where did the orphaned-agents list go?"
  - "Where do an agent's skills, prompt and plugins come from?"
---

## What is an agent?

An **Agent** is a long-running Claude Code instance with its own workspace and
session history. Once created, you talk to it in the **Agent Chat**; with cron or
GitHub triggers it can also work unattended.

This page is where you **manage** the agents and teams you already have. You can
create or import one here for advanced or custom setups, but the guided
**Create** launcher is the fastest way to start something new.

## The roles

| Role | What it is | When to use it |
|---|---|---|
| **Agent** (standalone) | A single chat agent with its own system prompt. The prompt shapes its persona — a COBOL specialist, a code-review buddy, a release manager. Add cron / GitHub triggers later to make it run autonomously as well as answer messages. | One-of-a-kind agents that act on their own. |
| **Agent Team** | A squad of agents working a repository. It stores a system-prompt template and hosts no agent itself — click **Add Member** on the team card to spawn agents that share the prompt and Working Environment but each get their own workspace and their own conversation. | Several copies of the same kind of agent — e.g. three reviewer agents in parallel. Start one from the **Create** launcher rather than by hand. |
| **Team Member** | One agent spawned from an Agent Team. Its system prompt, skills and MCP servers **inherit** from the parent team unless you flip a field from *Inherit* to *Custom*. Role, Working Environment and parent team are fixed at creation and shown read-only. | You do not pick this role — it is assigned when you add a member to a team. |
| **Orchestrator** | Points at a folder of **missions** — task files (*BriefingPacks*) from an **ACE (Agent Control Environment)** briefings repository. It lists one stub agent per mission and, when a mission is marked `dispatched`, offers to turn that stub into a live agent that works the mission end to end. | Only when you have an ACE briefings repository. See **Flows** for active orchestrators. |
| **Mission Agent** (bp-instance) | One agent per mission, created and managed by an Orchestrator. Parent orchestrator, mission id and mission directory are inherited and read-only — edit the mission in its BriefingPack, not here. | You do not pick this role — the orchestrator assigns it per mission. |

> An **Agent Team** is *not* the same thing as a **Team** on the **Access**
> page. That Team is the human tenant / access scope every agent,
> environment and credential belongs to; an Agent Team is a squad of agents.

## Lifecycle: what the card states mean

After creation an agent appears below as a card:

- **Active** — running and ready to chat.
- **Paused** — the workspace is kept, the process is stopped.
- **Not initialised** — a stub: it has its configuration and triggers, but no
  workspace, no cloned repository and no running process. An orchestrator's
  mission agents, the members of a team materialized with **Materialize agents
  now** left off, or a single member added later with **Materialize now**
  unticked (Agent Chat's **Add member…**). One click on **Activate** brings it to
  life — a team member can also be started from its team's *Not materialized
  yet* section in Agent Chat, where the same action is called **Materialize**.

## Disable vs Reset to stub vs Delete

Three card actions do different things, from reversible to destructive:

- **Disable** (the toggle) pauses the process and **keeps** the workspace — flip
  it back on to resume. Reach for this when you only want to pause.
- **Reset to stub** (the red power button) stops the agent and **wipes** its
  workspace: session history, cloned repositories and any in-workspace state are
  lost. The stub config remains, so it can be reactivated from scratch.
- **Delete** removes the agent config entirely. Deleting an **Agent Team** also
  permanently removes that team's locally cached and curated knowledge — its
  local Knowledge Base copy, promotion suggestions, archive, review decisions
  and team skill pool. Knowledge shared through the team's repository is *not*
  affected.

Deleting an Agent Team **takes its members with it**. Every member is removed
first, then the team — materialized members and **not-initialised stubs** alike,
and also when the team's own config is damaged, so a deletion that was
interrupted finishes the job when you repeat it. If a member could not be removed
(a busy container, a Matrix user that would not deactivate) the console says so
and names it, rather than reporting a clean delete.

### Where did the "Orphaned agents" list go?

An **orphan** was a member whose parent team no longer existed. The page used to
list them in an "Orphaned agents" warning block, because otherwise they were
invisible and the only way to remove one was over SSH. Team members are **no
longer listed there** — the block itself survives only for an Orchestrator's
mission agents, whose orphans have a different cause and are handled with the
rest of the BriefingPack model.

That block was a safety net for a bug, not a feature: orphans existed because
deleting a team did not reliably take its members with it. The cause is fixed —
the delete cascades, and a member left behind is reported instead of silently
dropped — so there is nothing left for the list to show, and there is
**no replacement surface** anywhere else. Re-homing an orphan manager would mean
keeping a permanent UI for a state the platform no longer produces.

An orphan is not a working agent, which is why the cleanup deletes rather than
adopts: a member's prompt, skills and plugins are all inherited from the team, so
once the team is gone what remains cannot run as intended.

If an installation still carries orphans from before the fix — or from a
hand-edited parent id naming a team that never existed — a **System Admin**
clears them with a one-off cleanup: `GET /api/agents/orphans` lists exactly what
would be removed and changes nothing, `POST /api/agents/orphans/cleanup` removes
them. It is idempotent, so running it twice is harmless, and it is
operator-invoked rather than automatic — this platform does not delete agents
without an explicit decision. See **Agent Roles** in the docs for the details.

## Creating and growing from here

- The **Create** launcher is the front door for anything new.
- For a whole team, prefer the **Agent Team Wizard** — it sets up the full team
  structure automatically instead of you assembling roles by hand.
- **Add member** on an Agent Team grows it by one: a blank member that inherits
  the team's prompt and skills, which you then configure in its **Settings**. To
  add a role *from a role template*, or to wire it into the flow — which label
  wakes it, what it emits — use the **Flow editor**.
- **Where did the "Add `<role>` role" suggestion go?** It was **removed**. The
  platform used to guess which loop-closing role a team was missing (by comparing
  the team against the process templates) and offer a one-click add. The guess
  rested on an inference — a team never records which template it came from — so
  it stayed silent on many teams that really did have a gap, and where it did fire
  it called a role "missing" that the team may have dropped on purpose. A
  suggestion you cannot check is worse than none, so it is gone rather than
  re-homed. Grow a team with **Add member**, and read the real gaps off the Flow
  editor, where an unconsumed label or an idle gate is visible instead of inferred.
  Roles added through the old button are unaffected and keep working.
- **Import Agent** and **+ New Agent** stay available as the advanced, manual
  path.
- **Save as template** on an agent or member snapshots a proven agent into a
  reusable Agent Template.

## What the form fields control

- **System Prompt** — the persona Claude reads at startup: role, expertise,
  communication style, constraints. Markdown is fine. On an **Agent Team** it is
  a *template* stored once and reused by every member that inherits it; leave it
  blank to give members an empty default and set a prompt per member instead.
- **Skills** — copied into the agent's workspace at seed time. A team's skill
  set is copied into every member's workspace and members inherit it unless they
  set their own override. On the create form only global-pool skills are offered;
  team-tier skills become available once the agent belongs to a team.
- **Working Environment** — where the agent runs, which repositories it clones
  and which credentials it uses.
- **Plugins** — governed capabilities beyond the container, reached through a
  broker that holds the privilege so the agent never does. Changes apply
  immediately, with no save and no restart. On a team agent the grant covers the
  whole squad; setting it on a member creates a per-member override.
- **Host context folders** — expose folders from the host machine to the agent as
  live context, mounted **read-only** by default; tick read-write to let the
  agent change files on the host. Saving re-provisions the agent's container.
  Offered only on the local / self-hosted stack.
