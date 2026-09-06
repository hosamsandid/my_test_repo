# Flows

## Chapter intro (slide 22)

We've now seen two ways to get a team of agents: the guided Team-Setup wizard, and working with a team that already exists. But sometimes you don't want a wizard to make the decisions for you — you want to draw the process yourself, agent by agent, connection by connection. That's what Flows is for.

Flows is the visual design surface of the Agent Studio — a canvas where you lay out the agents, decide who hands work to whom, and wire the whole orchestration by hand. In the next few slides I'll show you just how simple it is to build a flow from scratch: create a draft, add an agent, and let the platform help you write it.

## The empty draft (slide 23)

Screenshot: Flows editor — left list showing Teams ("Agentic Demos") and Drafts; a fresh empty draft "Simple SDLC" on the canvas; toolbar (Add agent, Stages, Materialize, Export) and the edge-type legend at the bottom.

This is the Flows editor. On the left is the list of everything the canvas can show: your live Teams — here our "Agentic Demos" team from earlier — and a Drafts section. (Older builds listed a third, BriefingPack section here; it is gone.) A draft is the important concept here: it's an editable process that exists before any team is created. Nothing is live yet, nothing is spawned — it's a design you can shape freely and materialise into a real team only when you're happy with it.

I've created a fresh draft called "Simple SDLC", and right now it's completely empty — zero agents, a blank canvas. The hint at the top says it all: design from scratch — add an agent, drag a port to wire connections, click to edit; nothing is created until you materialise. Along the top are the actions I'll use: Add agent, Stages, Materialize, Export. And down at the bottom is the legend — this is the vocabulary of a flow: label hand-offs, issue and pull-request channels, reviews, human approvals, GitHub events. Every connection I draw will be one of these. Let's add our first agent.

## Add agent from scratch (slide 24)

Screenshot: Add agent panel — "From scratch" tab, name "Business Analyst", one-line note in the Notes field, empty Agent prompt area with the Generate button.

I click Add agent, and this panel slides in. I have two choices: start from a template — one of the catalog roles like Developer or Code Reviewer — or, as here, from scratch.

Building from scratch is remarkably low-effort. I give the agent a name — "Business Analyst" — and then, instead of writing a full system prompt by hand, I just jot down a short note describing what it should do: "Take requirements and create a GitHub issue." That one line of intent is enough for the platform to do the heavy lifting. The large field below is where the actual agent prompt will go — but I don't have to type it myself.

## Generate the agent prompt (slide 25)

Screenshot: Add agent panel — the generated Business Analyst prompt filling the editable Agent prompt field.

I press Generate agent prompt, and the Studio turns my one-line note into a complete, well-structured system prompt for the role. You can see the result here: it lays out the Business Analyst's core responsibilities — engage the human to clarify requirements before writing anything, ask focused questions about acceptance criteria and edge cases, convert confirmed requirements into a structured GitHub issue, and only post it once the human approves. It even adds a quality bar: every issue must have at least one testable acceptance criterion, avoid vague language, and stay self-contained.

That's a genuinely usable persona, drafted in seconds. And nothing is applied silently — it lands in an editable field, so I can review and adjust it before committing. I click Add agent, and the Business Analyst becomes the first node on my canvas.

## Second agent (slides 26–27)

Screenshot: canvas with the Business Analyst node plus the GitHub / External-system source nodes; Add agent panel open for "Developer" with its one-line note, then the generated Developer prompt.

With the Business Analyst placed, I repeat the process for the second role. Notice the canvas already has the first node, and two source nodes have appeared at the top — GitHub and External system — these represent the outside world that can feed events into the flow.

I add a new agent, name it "Developer", and again describe it in one line: "Take an issue and implement it. Create a PR at the end." Same pattern as before — a short note is enough to seed a full prompt.

And again, Generate agent prompt produces a complete role definition — this time for the Developer: turn GitHub issues into working, reviewed-ready code; read the issue thoroughly and clarify ambiguity before writing a line; follow the project's existing conventions; keep commits small and focused; write tests; and open a pull request that references the originating issue and explains how to verify it. It even spells out the collaboration discipline — flag blockers to the human, wait for review feedback, and a quality bar of passing tests and no hardcoded secrets.

I review it, and add the agent. That's two fully-specified agents authored with essentially two short sentences of my own input.

## Two unconnected agents (slide 28)

Screenshot: canvas — Business Analyst and Developer side by side, sources on top, draft badge "2 agents", no connections yet.

Here's where we are: two agents on the canvas — Business Analyst and Developer — each with its generated prompt, plus the GitHub and External-system sources up top. The draft now says "2 agents".

But they're still standing side by side, unconnected. Two agents that don't hand work to each other aren't a process yet — they're just two agents. The next step is the one that actually makes this a flow: wiring them together.

## Wiring: choose the connection type (slide 29)

Screenshot: the connection dialog after dragging from the BA's port onto the Developer — the five edge-type options visible.

To connect them, I drag from the Business Analyst's port onto the Developer, and the Studio asks the crucial question: how should these two be connected? This is where the flow's semantics are decided, and the options map exactly to the ways agents really hand work off:

- a Pull-request channel — one agent opens a PR that wakes the other;
- an Issue channel — one opens an issue that wakes the other;
- a Label hand-off — one emits a label the other listens for;
- a Data flow / hand-off — one produces an artifact the other consumes;
- or Parent / child — a grouping relationship.

For our Business Analyst handing work to the Developer, the natural choice is the Issue channel — the BA opens an issue, and that issue wakes the Developer.

## Issue channel + human gate (slide 30)

Screenshot: issue-channel configuration — routing label `ready` entered, "Human approval gate: a person applies the label" ticked.

Choosing the issue channel opens its configuration. It reads plainly: Business Analyst opens an issue that wakes Developer. Now I make two decisions that shape how the hand-off behaves.

First, a routing label — I enter ready. Without a label, the Developer would wake on every issue the BA opens; with the ready label, it only wakes when that label is present. Second — and this is the important one — I tick Human approval gate: a person applies the label. That single checkbox turns this hand-off into a human control point. The Developer won't start until a human has looked at the issue and applied ready. I click Create channel, and the connection is made.

## A working flow (slide 31)

Screenshot: canvas — BA with Issue output badge, connection to Developer labelled "Issue · ready" with the gate marker.

And there it is — a working flow. The Business Analyst now carries an Issue output badge, and a connection runs down to the Developer, labelled "Issue · ready" with the little gate marker showing it's human-approved.

Read it top to bottom, this is a complete micro-process: the Business Analyst turns a request into a GitHub issue, a human reviews it and applies ready, and only then does the Developer wake up to implement it. Everything we walked through by hand in the earlier Core SDLC demo — but here I designed it myself, in a couple of minutes, on a blank canvas.

## Stages, materialise, export (slide 32)

Screenshot: canvas with Stages enabled — bands "Requirements" (BA) and "Build" (Developer); Materialize and Export in the toolbar.

As a final touch, I turn on Stages, and the flow organises itself into labelled bands: Requirements, containing the Business Analyst, and Build, containing the Developer. Stages are purely an organising layer — they group the agents into the phases of your process and make a larger flow readable at a glance, while the hand-off between them, our human-gated ready issue, stays exactly as we drew it.

This is the finished draft. From here, one click on Materialize would turn this drawing into a live, running team — real agents, real Matrix identities, reacting to real GitHub events — or I can Export it as a portable template to share and reuse. That's the whole story of Flows: design the orchestration visually, let the platform draft the hard parts, and go live only when you're ready.
