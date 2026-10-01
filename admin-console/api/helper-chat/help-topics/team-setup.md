---
id: team-setup
routes: ["/team-setup"]
title: Agent Team Wizard
summary: The five guided steps that turn a process template into a live squad of wired agents — and exactly what the final click provisions.
seeAlso:
  - { label: "Create", to: "/create" }
  - { label: "Flows", to: "/flows" }
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Environment Templates", to: "/environment-templates" }
  - { label: "Agent Templates", to: "/role-templates" }
  - { label: "Skills", to: "/skills" }
askPrompts:
  - "What do the five wizard steps do?"
  - "What exactly is created when I click Create team?"
  - "When do the new agents start acting on their own?"
  - "When do I need a label suffix?"
  - "What happens if I don't pick an Environment?"
  - "How do I add a role to a team that already exists?"
  - "What happens if creating the team fails halfway through?"
---

## What this wizard builds

It builds an **Agent Team**: a squad of agents with one role each — Business
Analyst, Developer, Code Reviewer, Reworker — sharing one Environment and
wired to each other, so one agent's outcome wakes the next over GitHub labels and
events.

An Agent Team is **not** the same thing as an *access scope*. That one is the
older, coarser tenant your agents are stamped with, administered by a System
Admin. This one is a group of agents that work together — and it is what people
are actually given access to. They only share a word.

## The five steps

| Step | What you decide |
|---|---|
| **Process** | The central choice: which flow the team runs. Pick a curated template or one of your saved drafts. The step shows a live preview and a wiring check — **blocking wiring errors stop you from advancing**, advisory ones do not. |
| **Environment** | *Where* the team works — and **optional**. An environment already bundles the repository, branch, credentials and knowledge sources, so pick one to reuse them instead of re-entering them. Leave it unset and the team gets a fresh, repo-less environment of its own — there is no environment to name or find first (#2168). Whether picked or auto-created, a repo-less environment is a legitimate outcome — the team then runs chat + skills only, with no GitHub hand-offs. |
| **Team** | The team name and the **Team ID** slug. The slug is the naming prefix for everything created: agent ids come out as `<teamId>-<roleId>`. Names may repeat; the ID is the identifier and must be free. |
| **Knowledge** *(optional)* | Initial skills for the whole team, and a read-only view of the MCP knowledge sources inherited from the environment. Nothing here blocks continuing. |
| **Review** | The summary of what will be created, and the go-live warning. Credentials show what the environment really uses — one you cannot see reads as e.g. *personal token of Alex (hidden)*, never as empty — and, when your own personal GitHub token will carry the team's commits and PRs instead of the environment's token, an **Acts on GitHub as** row says so. |

Only **global-pool** skills can be granted in the Knowledge step, and they land on
the *team* agent so every member inherits them. The reason is timing: the team's
own skill pool does not exist until the team does. Once it is created you can grant
from the team tier on the team's card on the Agents page. MCP knowledge sources are
read-only here on purpose — they come from the environment, so the server would
ignore a selection made here; change them by editing the environment.

## What "Create team" provisions

One transaction, in this order:

- **One Environment** — the one you picked, reused as-is; or, if you picked none, a fresh repo-less one created for this team.
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

The Review step's notice follows your choices: with **Provision agents now**
unticked the members are written as stubs and nothing goes live until you enable
them; a repo-less team watches no repository at all, and if its process hands work
over on GitHub the notice warns that those hand-offs cannot work without one.

If you want to stage the rollout, disable individual agents on the **Agents** page
right after creation; a disabled agent keeps its configuration and picks up work
again when you enable it.

## Label suffix — only for a shared repository

Hand-offs travel on GitHub labels, so two teams on the *same* repository would wake
each other's agents with the same label. The optional **Label suffix** (up to eight
lowercase letters, digits and single inner dashes — so `team-1` or `pre-prod` reads
as well as `k3f9`; a leading, trailing or doubled dash is refused, because it would
produce `ready-x-` or `ready--x`) is stamped onto every label the team uses: trigger
filters and claims, channel labels, the label registry, the human roles' labels and
the wake instructions the agents read. Labels you add to the live team later get
the same suffix. The suggest button still proposes a random four-character one — an
auto-generated token has no words to separate.

Leave it blank unless another Agent Team already uses that repository.

## Collisions, failure and growing later

- **Create team** is disabled, with the reason stated next to the button, on a
  platform with no model provider registered at all — a fresh team's
  environment cannot bind to a working one, and creating it anyway used to
  succeed here and fail later at the team's first run. Ask a Team or System
  Administrator to add one under **Model Providers**; the button re-enables the
  moment one exists (#2179).
- An existing Team ID is refused on the Team step — pick a free one. If a
  create still runs into left-over members of the same id, the failure card
  offers **Add missing agents** instead of starting over — that re-runs the
  create in *extend* mode, adding only the members that are missing. The wizard
  has no extend toggle of its own.
- If a member id is already held by an *unrelated* agent, the wizard refuses with a
  conflict rather than quietly adopting it.
- Leaving the page (reload, closing the tab) mid-wizard asks for confirmation
  first — the wizard keeps no draft, so the input would be lost.
- If anything fails partway, everything is **rolled back** in reverse order —
  members, then the team agent, then the environment — and the failure card offers
  a **Retry** that starts from a clean slate. Left-over directories from an earlier
  aborted attempt are cleaned up first, so retrying with the same team id works.
  Anything that could not be removed is named explicitly instead of being silently
  swallowed.
- The wizard is **create-only**. To grow a team that already exists, wire the new
  role in the Flow editor, or use **Add member** on the team's card on the Agents
  page (or in the Agent Chat rail) — that adds a blank member inheriting the
  team's prompt, which you then configure yourself; only the Flow editor
  materialises a role *from a template*. The old **Add role** button, which
  guessed which role the team was
  missing and added it in one click, was **removed**: it depended on inferring the
  team's source template, which a team never records, so its suggestions could be
  neither trusted nor checked. Growing a team is now always an explicit choice.

Need a flow that no template covers? Author it from **+ Create** — describe it in
plain language, or start blank in the canvas — then come back here (or launch it
straight from the canvas).
