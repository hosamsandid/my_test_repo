---
id: team-setup
routes: ["/team-setup"]
title: Agent Team Wizard
summary: The five guided steps that turn a process template into a live squad of wired agents — and exactly what the final click provisions.
seeAlso:
  - { label: "Create", to: "/create" }
  - { label: "Flows", to: "/flows" }
  - { label: "Agents", to: "/agents" }
  - { label: "Working Environments", to: "/environments" }
  - { label: "Agent Templates", to: "/role-templates" }
  - { label: "Skills", to: "/skills" }
  - { label: "Access", to: "/teams" }
askPrompts:
  - "What do the five wizard steps do?"
  - "What exactly is created when I click Create team?"
  - "When do the new agents start acting on their own?"
  - "When do I need a label suffix?"
  - "How do I add a role to a team that already exists?"
  - "What happens if creating the team fails halfway through?"
---

## What this wizard builds

It builds an **Agent Team**: a squad of agents with one role each — Business
Analyst, Developer, Code Reviewer, Reworker — sharing one Working Environment and
wired to each other, so one agent's outcome wakes the next over GitHub labels and
events.

An Agent Team is **not** the same thing as a *Team* on the Access page. That one is
the human tenant (members and visibility scope) your agents belong to. This one is
a group of agents that work together. They only share a word.

## The five steps

| Step | What you decide |
|---|---|
| **Process** | The central choice: which flow the team runs. Pick a curated template or one of your saved drafts. The step shows a live preview and a wiring check — **blocking wiring errors stop you from advancing**, advisory ones do not. |
| **Working Environment** | *Where* the team works. An environment already bundles the repository, branch, credentials and knowledge sources, so you pick one instead of re-entering them. A repo-less environment is a legitimate pick — the team then runs chat + skills only, with no GitHub hand-offs. |
| **Team** | The team name and the **Team ID** slug. The slug is the naming prefix for everything created: agent ids come out as `<teamId>-<roleId>`. Names may repeat; the ID is the identifier and must be free. |
| **Knowledge** *(optional)* | Initial skills for the whole team, and a read-only view of the MCP knowledge sources inherited from the environment. Nothing here blocks continuing. |
| **Review** | The summary of what will be created, and the go-live warning. |

Only **global-pool** skills can be granted in the Knowledge step, and they land on
the *team* agent so every member inherits them. The reason is timing: the team's
own skill pool does not exist until the team does. Once it is created you can grant
from the team tier on the team's card on the Agents page. MCP knowledge sources are
read-only here on purpose — they come from the environment, so the server would
ignore a selection made here; change them by editing the environment.

## What "Create team" provisions

One transaction, in this order:

- **One Working Environment** — the one you picked, reused as-is.
- **One `team` agent** carrying the shared system-prompt template, the team skill
  grant and the flow's label/stage registries. It hosts no agent of its own.
- **One `team-member` agent per role** in the template, each with its own system
  prompt, its own `triggers.json` derived from the flow, and a `per-invocation`
  session policy (each triggered run starts with a fresh context).
- **One direct-message room per member**, so you can talk to each of them.

Members omit a skills override, so they inherit the team's skills. You can later
switch any member to *Additional input* or *Exclusive overriding input* for its
prompt, and to its own skills or MCP set, on the Agents page.

## The agents go live immediately

This is the part worth pausing on before the final click. Creating the team starts
real containers, and the reactive members begin watching the bound repository for
issues and pull requests **at once** — acting on their own from that moment, with
no further confirmation.

If you want to stage the rollout, disable individual agents on the **Agents** page
right after creation; a disabled agent keeps its configuration and picks up work
again when you enable it.

## Label suffix — only for a shared repository

Hand-offs travel on GitHub labels, so two teams on the *same* repository would wake
each other's agents with the same label. The optional **Label suffix** (up to eight
lowercase letters, digits and single inner dashes — so `team-1` or `pre-prod` reads
as well as `k3f9`; a leading, trailing or doubled dash is refused, because it would
produce `ready-x-` or `ready--x`) is stamped onto every label the team uses: trigger
filters, channel labels, the label registry and the wake instructions the agents
read. The suggest button still proposes a random four-character one — an
auto-generated token has no words to separate.

Leave it blank unless another Agent Team already uses that repository. When you
re-run the wizard to *extend* an existing team, the suffix must match the one
stored on it.

## Collisions, failure and growing later

- Re-running the wizard with an existing Team ID switches to **extend** mode and
  adds the missing roles instead of starting over.
- If a member id is already held by an *unrelated* agent, the wizard refuses with a
  conflict rather than quietly adopting it.
- If anything fails partway, everything is **rolled back** in reverse order —
  members, then the team agent, then the environment — and the failure card offers
  a **Retry** that starts from a clean slate. Left-over directories from an earlier
  aborted attempt are cleaned up first, so retrying with the same team id works.
  Anything that could not be removed is named explicitly instead of being silently
  swallowed.
- The wizard is **create-only**. To grow a team that already exists, wire the new
  role in the Flow editor, or use **Add role** on the team's card on the Agents
  page — that adds the member through the same pipeline and leaves it disabled
  until you enable it.

Need a flow that no template covers? Author it from **+ Create** — describe it in
plain language, or start blank in the canvas — then come back here (or launch it
straight from the canvas).
