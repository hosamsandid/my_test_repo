---
id: flows
routes: ["/flows"]
title: Flows
summary: Design and run flow graphs — teams of agents wired together so work hands off automatically through outcomes, labels and human gates.
seeAlso:
  - { label: "Agents", to: "/agents" }
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Create something new", to: "/create" }
  - { label: "Agent Team Wizard", to: "/team-setup" }
  - { label: "Working Environments", to: "/environments" }
  - { label: "GitHub Event Log", to: "/github-events" }
askPrompts:
  - "How do agents hand work over to each other in a flow?"
  - "What is the difference between a Draft and a live Team?"
  - "What is the difference between a human gate and a brake?"
  - "Which hand-off kind should I pick — label, PR channel, issue channel or artifact?"
  - "How do I make the flow wait for a person to approve?"
  - "Why is the Materialize button greyed out?"
  - "Why are my agents 'Not initialised' after I materialized the draft?"
---

## What can I do here?

Flows is where you design and run **flow graphs**: teams of agents wired
together so work hands off from one to the next automatically. Pick an item in
the left list:

- **Teams** — a live flow graph you can inspect and edit in place.
- **Drafts** — editable flows you're still designing; click **New flow** to
  start one from scratch.

## How agents are wired

Agents don't call each other directly. Instead:

- An agent finishes with an **Outcome**, which sets a **Label**.
- A **Consumer** agent is waiting on that label and wakes up when it appears.

Every arrow you see on the canvas is one of these *Outcome → Label → Consumer*
hand-offs. Wiring the flow means deciding who sets which label and who reacts
to it.

## Building a flow

You always edit a **Draft** first — a live **Team** keeps running while you
design. Add agents, draw the hand-offs between them, then **Materialize** the
draft to turn it into a real team. The Materialize dialog decides how far each
agent is taken: **Materialize agents now** is off here by default, so the members
are created as **stubs** — they appear in the team with their prompts and
triggers, but no repository is cloned and nothing is running until you enable
one (a process can have dozens of members, and each materialisation clones the
repository). Tick it and every member is provisioned right away. Materialize
needs at least one agent before it can turn a design into a team, and while a
Copilot proposal is on screen the structural buttons pause, because the canvas
is previewing the proposal rather than the draft underneath.

- **Flow Copilot** — describe the process in plain language (roles, hand-offs,
  human approval gates) and it proposes a complete flow on the canvas; you
  review and apply it, then keep iterating with follow-up instructions.
- **Import / Export** — save a flow to a portable JSON bundle, or bring one in
  to reuse or share.
- The draft toolbar covers the rest: **Add agent**, **Add human role**, group
  the agents into ordered **Stages**, manage the hand-off **Labels**, then
  **Materialize**.

An environment with no repository still works — the team's agents can chat and
use their skills, but GitHub hand-offs (PR / issue channels) are not available
to them.

## The hand-off kinds

When you draw an edge, the chooser asks *how does the downstream agent learn
about the upstream agent's work?* If the upstream agent already has a matching
outcome, that one is recommended.

| Kind | What it does |
|---|---|
| **Label hand-off** | An outcome of A sets a label that wakes B. The default, and what most arrows are. |
| **Issue channel** | A opens an issue that wakes B (optionally routed via a label / human approval). |
| **Pull-request channel** | A opens a pull request that wakes B (optionally routed via a label / human approval). |
| **File artifact** | A produces an artifact that B consumes, matched by logical name rather than file path. Leave the name empty for a plain dependency. |
| **GitHub trigger** | B wakes on a repo event (issue opened, PR opened, push, …) or on a label — including labels a human sets. |
| **Webhook** | An external system (CI, tooling) wakes B via an HTTP call. |
| **Dependency** | B is woken when A pushes to the repo. |
| **Parent / child** | A groups B as a child — it inherits its parent's stage. |

## Labels: gates and brakes

The **Label registry** lists, per label, **who sets it and who reacts**. Two
label kinds involve a person, and they are the two directions of a hand-off:

- **Human gate** (👤 → flow) — only a person applies it, to admit or approve
  work. An agent setting it is a hard error, and a gate is drawn as a red gate
  on the edge: the flow pauses there until someone approves.
- **Brake** (flow → 👤) — an *agent* applies it to pause the flow and hand the
  decision to a person.

## Named human roles

**Human roles** are named people who act in the flow — an *Issue Reviewer*, a
*Tech Lead*. A human role never runs anything; people keep acting through GitHub
labels. Labels a person *applies* become gates; artifacts and brakes wired to a
role show under it. Wiring a gate to a named role beats wiring it to an
anonymous "human", because the canvas then says who is expected to act.

## Outcomes and inputs, per agent

Selecting an agent on the canvas shows both sides of its wiring:

- **Outcomes** — how a run of this agent ends, so downstream agents can react.
  The mode decides how many apply: *exactly one* means the agent picks exactly
  one outcome per run (a switch); *any of* means zero or more may apply. If you
  have no outcomes yet, the assistant can suggest them from the agent's prompt.
- **Inputs** — what wakes this agent. Nothing wakes an agent until you add an
  input or drag a hand-off onto it on the canvas.

## Other concepts you'll meet in the editor

- **Stages** — optional columns that group the flow into phases (e.g. build →
  review → release) so a big graph stays readable.
- **Anomalies** — on a live team, a check that surfaces stalls (a wake that was
  never picked up, a gate sitting idle) so you can spot a stuck flow.

## Special solution: BriefingPack flows

An advanced, niche mode also lives here: a **BriefingPack flow** is an
**Orchestrator** agent that monitors a directory of BriefingPacks (discrete
units of work) and renders their dependency graph. Most teams don't need it. To
set one up, create an Orchestrator agent on the **Agents** page and point its
**Briefings Path** at the directory — the flow then appears under **BriefingPack
flows** in the left list.
