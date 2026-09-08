# Team Setup

## Chapter intro (slide 1)

Let's walk through how you go from an idea to a running set of agents in the Agent Studio. This is where the product really shows what it's about: it doesn't just run a single assistant, it lets you stand up a whole team of agents that work together on the same repository — and, just as importantly, it lets you start small and grow into that team when you're ready.

So what exactly is a team here? A team is a coordinated group of AI agents — think of a Business Analyst, a Developer, a Code Reviewer — each with its own role, its own system prompt. They all share one working environment, which means they all work against the same GitHub repository with the same credentials and the same knowledge sources. What makes it a team rather than just a collection of agents is that they're wired together: one agent's output becomes the next agent's trigger. The Business Analyst writes an issue, a human approves it, the Developer picks it up, opens a pull request, the Code Reviewer reacts to that pull request, and so on. The hand-offs happen automatically over GitHub labels and events.

The important thing to understand before we start is that you no longer have to decide up front *what kind of thing* you're creating. In the past there were separate front doors — one for a single agent, another for a whole team, others for describing a flow or drawing it on a canvas — and you had to know which door matched your goal before you could even begin. That's gone. Now there is **one** front door, the **"+ Create"** launcher, and it asks a much simpler question: *what do you want to create?* Whether the result is one assistant or a four-agent team is an outcome the system right-sizes from what you describe or pick — not a mode you have to classify yourself. And the launcher doesn't leave you weighing five equal options either: the ways in are ranked, simplest first, so there's always an obvious place to begin.

Let's start at that launcher, look at each of the ways in, and then follow the most complete path — starting from a ready-made team — all the way to a live, wired team.

## The "+ Create" launcher — one front door (slide 2)

Screenshot: the Create launcher page (`/create`) — the full-width "Chat with one assistant" hero at the top, the bordered three-card flow group beneath it, and the collapsed "Advanced options" disclosure at the foot; the persistent "+ Create" control highlighted in the sidebar.

Everything starts at the launcher. It's reachable two ways, and both open exactly the same screen: there's a persistent **"+ Create"** control pinned in the sidebar — always visible, on every page — and a dedicated `/create` route for when you want to link straight to it. The heading asks one plain question — *"What do you want to create?"* — and reassures you underneath it: *"Pick a starting point — you can always grow or change it later."*

Below that are the five ways in, and they are deliberately **ranked**, simplest to most advanced, across three tiers. That ranking is the point: presenting five options of equal weight told you *what you could do* but never *where to begin*. You still don't have to arrive knowing our vocabulary — you pick by what you're trying to do, and where a title does use a word like *team* or *flow*, the page explains it right there rather than assuming you know it (the flow group's heading is exactly that explanation). Every entry also carries a small **"→"** line saying what kind of screen it opens, and the three flow cards add a **"what you get"** sketch of that screen you can reveal by hovering one, tabbing to it, or tapping the little eye control on a touch device. They're hand-drawn schematics rather than screenshots, so they show you the shape of the destination without pretending to be a specific team. The hero and the advanced entry carry no sketch — a chat window is self-evident, and the manual form is for people who already know what they want — so on those two the "→" line is the whole promise.

First, on its own and across the full width, the **hero**:

- **"Chat with one assistant"** — badged *Fastest start*, with a **Start chatting** button. This is the fast lane: a single assistant you can start talking to right away, no wiring, no roles, no setup. Crucially, it's framed as *a team of one*, not as a different kind of product — you can grow it into a full team whenever you need more. → *Opens a chat with your assistant.*

Then one bordered group, headed **"Or build a team of agents that work together (a flow)"**. That heading earns its keep: it's where the studio finally says the word *flow* and explains it — several agents that hand work off to each other — and it tells you up front that all three cards inside end in the *same* flow and differ only in how you start it. In order:

- **"Start from a ready-made team"** — badged *Recommended*. The fastest way to a working team when a proven pattern already fits: you pick a curated template (or one of your own saved drafts) and adjust it to fit. This opens the structured five-step wizard on its template gallery, and it's the path we'll follow in detail below. → *Review the team, then launch it.*
- **"Describe what you need"** — the conversational way in. You tell the studio in plain language what you want to get done, and it drafts the team for you, showing a live preview before anything is created. This hands off to the Flow Copilot on a fresh draft in the canvas. → *Opens an editable draft on the canvas.*
- **"Design it on the canvas"** — badged *Advanced*. Full control from a blank slate: you lay the agents out visually and connect them yourself. This opens a fresh, empty draft in the Flows editor. → *Opens the canvas.*

And finally, folded away behind a collapsed **"Advanced options"** disclosure, one last entry — out of the way by design rather than competing with the four above it:

- **"Configure an agent manually"** — badged *Advanced*. This is the direct form: you set the id, the role (a plain agent, an Agent Team template or an orchestrator), the Working Environment and the system prompt yourself, on an environment that already exists, and nothing is created alongside it. It's the "I already know exactly what I want" path, which is why it's the one entry that *does* name the artifact: saying anything vaguer would make it indistinguishable from the hero at the top — which is exactly the confusion the ranking was introduced to end. It opens right here on the launcher, in a side panel, so the ranked entries stay in view behind it. → *Opens the agent editor.*

Two of these (describe / design-on-the-canvas) produce a **flow draft** that you refine on the canvas and then launch; one (ready-made team) runs the **guided wizard**; the hero is the **fast lane** to a lone chat agent; and the manual form decides nothing for you at all. They all end at the same place — running agents — they just differ in how much you decide up front versus how much the studio decides for you. Nothing changed about where any of them takes you, by the way: the launcher was re-sorted and re-labelled, not rewired. Let's take the ready-made-team path first, because it's the most complete and shows every step of standing up a team; then we'll come back to the other three and show what's different about each.

## Path A — Start from a ready-made team (the guided wizard)

### Step 1: Process (slide 3)

Screenshot: wizard Process step with the Core SDLC template selected; flow preview + wiring check visible below.

Choosing **"Start from a ready-made team"** on the launcher drops us into the wizard, and it lands directly on the **Process step** — the template gallery. This step comes first on purpose, because the process is the central decision. Everything after it — the environment, the name, the knowledge — just qualifies this choice.

The gallery lists the curated templates alongside any drafts you've saved. In this demo we take the simplest, most powerful path: we pick a ready-made template — the **Core SDLC** flow. (The two more free-form ways of authoring a process — describing it in plain language, or starting from a blank canvas — aren't crammed into this step anymore; they're their own cards in the launcher's flow group, right next to the one we just took. The wizard keeps only a small "need a custom flow? use + Create" pointer, and an empty-state link to the launcher if you have no templates or drafts yet.)

Core SDLC gives us four agents that cover a complete build-and-review loop:

- The **Business Analyst** is the team's front door. You talk to it in chat, bring it ideas or bug reports, and it turns them into well-defined GitHub issues — precise enough that they can be implemented without guesswork. It doesn't write code; it defines what needs to be built and why.
- The **Developer** implements the work. As soon as a human marks an issue as "ready", the Developer wakes up, creates a feature branch, writes the code and the tests, and opens a pull request.
- The **Code Reviewer** is the quality gate. Whenever a pull request is ready for review, it checks the change against every acceptance criterion, runs the tests, and either recommends the merge or sends the work back with concrete, actionable feedback.
- And the **Reworker** closes the loop: when the reviewer asks for changes, the Reworker addresses that feedback and hands the pull request back for another round of review — looping until the change is clean.

Notice the division of labour: the agents do the heavy lifting, but the human stays in control of the two decisions that matter — what gets built, by approving the issue, and the final merge. Below the selection you also see a small live preview of the flow and a wiring check, so you can confirm the hand-offs actually connect before moving on. Any blocking wiring errors are surfaced here and stop you from advancing until they're resolved.

### Step 2: Working Environment (slide 4)

Screenshot: wizard Working Environment step — card grid of environments; one card selected, a repo-less card visibly non-selectable for a repo-based process.

The second step is the Working Environment. If the process defines what the team does, the environment defines where it does it.

A Working Environment is a reusable infrastructure template. It bundles the GitHub repository the team works on, the branch, the SSH deploy key and the GitHub token used for git operations and API access, plus any knowledge sources. The key point is that we don't reassemble all of that here from raw credentials — the environment already packages it. So on this step we simply pick one from a card grid. Each card shows the environment's name, its repository, and warns us if something essential is missing — for example, if there's no GitHub token, it flags that the reactive roles won't be able to trigger on issues and pull requests.

This step is also where the "repo-less first-class" idea shows up. Every environment card is selectable — including one with no repository at all (#1623/#1668). A repo-less environment is a legitimate pick: the team then runs on chat and skills only, with no GitHub hand-offs, so the reactive roles of a repository-driven process would have nothing to react to. The card says what it lacks and leaves the judgement to you rather than blocking the pick.

This separation is deliberate: the same environment can be reused across many teams, and credentials live in their own store, so you can rotate a token without touching every team. If we don't have a suitable environment yet, there's a direct link to create one — but for the demo we just select the one that points at our target repository and move on.

### Step 3: Team identity (slide 5)

Screenshot: wizard Team step — name, ID, and optional label suffix fields; name and ID pre-filled from the environment.

Step three is where we give the team its identity. There are two required fields and one optional one.

The two required fields — team name and team ID — are pre-filled and suggested from the working environment we just picked. The ID is a slug — lowercase, dashes only — that gets derived automatically from the name as we type. You can override either one, but you usually don't have to.

Why does the ID matter? Because it becomes the prefix for every resource the team creates. So a team with the ID "acme" will produce agents like acme-developer, acme-code-reviewer, and so on. The wizard also checks the ID against everything that already exists — if it collides with an existing agent or team, it tells you right away and asks for a different one. A duplicate team *name*, by contrast, only shows a non-blocking warning — the name is a cosmetic display label, and you can still advance; it is the ID that must be unique. That naming scheme is what keeps a multi-team setup clean and predictable.

The optional **label suffix** field is for when you are running two or more teams against the same GitHub repository at the same time. Every label-based hand-off in the process — the ones that wake agents and gate human approvals — has to be unique per team, otherwise one team's events trigger the wrong team's agents. A suffix (1–8 lowercase letters and digits, with single inner hyphens allowed so `team-1` or `pre-prod` reads as well as `abc1`) is stamped onto every label token before the team is created, so "ready" becomes "ready-abc1" and "revisions-required" becomes "revisions-required-abc1". The wizard offers a **Suggest** button that generates a random four-character suffix, and it shows you a live list of any label mentions in prompts it could not stamp automatically (so you can fix them yourself). If you are the only team on the repository, leave this blank — there is no cost to omitting it, and the label names stay readable.

### Step 4: Knowledge (slide 6)

Screenshot: wizard Knowledge step — skills picker, read-only MCP list, "Advanced: knowledge learning" disclosure (collapsed by default).

The fourth step is Knowledge — and it's explicitly optional. This is where we decide what the team knows and how it learns.

There are two immediately visible parts and one advanced section. First, the initial team skills: skills are curated capability packs from the pool — think COBOL analysis, JCL conversion, and so on for the mainframe-migration domain. Whatever we pick here is placed on the team as a whole, and every member inherits it automatically. Second, the knowledge sources: these are MCP servers the team can query at runtime — a wiki, a vector store, a graph database. These are inherited from the working environment, so they're shown here read-only; to change them you'd edit the environment.

The learning configuration is collapsed behind an **"Advanced: knowledge learning"** disclosure (closed by default, with the one-liner "Controls how much the team auto-learns from its work — defaults are fine to start"). Expanding it reveals the autonomy level and promotion gates: at the lower levels, learnings are proposed and a human reviews them before they become shared team knowledge; at the highest level, the team curates and promotes its own knowledge automatically, closing the loop without a human in it. These are just sensible defaults every team starts on, and you can change all of them later on the Knowledge page — so for the demo we can simply accept the defaults and continue.

### Step 5: Review & Launch (slide 7)

Screenshot: wizard Review step — full summary; then the per-step creation progress after submit.

The final step is Review — the confirmation before anything is created. Nothing has been built yet; this is our last chance to check the whole picture in one place.

Here we see it all laid out: the team name and ID, the working environment and repository, the exact list of agents that will be created — each with its concrete ID, so you can see for instance that you'll get an acme-business-analyst, an acme-developer, and so on — plus the skills and the learning configuration. If the process uses labels for hand-offs, those are shown too, and where relevant the wizard even checks whether the repository has the supporting GitHub workflow installed and offers to set it up.

When we hit the **Launch** action, the studio materialises everything in one atomic-with-rollback transaction: it sets up the shared environment, creates the team, spawns each member agent with its role-specific prompt and triggers, provisions a Matrix user and a chat room for each — and if any step fails, it unwinds everything in reverse, so we never end up with a partial team. A few seconds later, we have a fully wired, running team of agents ready to react to the first issue.

One detail worth calling out for anyone who also uses the canvas: this "turn a design into running agents" step is now **one single action** shared between the wizard and the Flows canvas. Whether you finish here in the wizard or press *Launch* on a design you built on the canvas, you go through the exact same materialisation — same validation, same progress stream, same rollback. There's no longer a separate "wizard submit" and "materialize dialog" that could drift apart.

## Path B — Describe what you need (the conversational way in) (slide 8)

Screenshot: the Flow Copilot on a fresh draft — a chat-style prompt on the left, a live flow-graph preview building up on the right.

Not everyone wants to start from a template. If you know *what you want* but not *which pattern matches it*, the **"Describe what you need"** card — the middle one in the launcher's flow group — is the way in. It opens a fresh draft in the canvas with the **Flow Copilot** attached.

You type what you're trying to achieve in plain language — "I want a team that triages incoming bug reports, has a developer fix them, and a reviewer check the fix before merge" — and the Copilot drafts a flow for you: the roles, their prompts, and the label hand-offs that wire them together. Crucially, it does this as a **live preview** with a confirm-to-create step, so you see the graph take shape and can react to it before anything is actually built. Nothing is committed until you say so.

From that draft you can keep refining — ask the Copilot to add a security reviewer, split a role, change a hand-off — and when you're happy you launch it through the same shared Launch step as the wizard. So "describe it" and "start from a template" converge: the difference is only in how the first draft comes to exist.

## Path C — Design it on the canvas (the blank slate) (slide 9)

Screenshot: the Flows editor with a fresh, empty draft — the centred "This flow is empty" prompt with its "Add agent" button, the role palette and the "Add role" affordance.

When you want complete control and don't want anything drafted for you, **"Design it on the canvas"** opens a brand-new, empty draft directly in the Flows editor. This is the power-user path. It isn't a bare grid: an empty flow greets you with a centred *"This flow is empty"* prompt — *"Add your first agent to start wiring the flow"* — and the button that does it, so you always have a first move.

Here you place roles by hand, write or generate their prompts, and draw the hand-offs yourself — the label edges that wake one agent when another emits, the GitHub PR/issue channels, the human-approval gates, the data-flow artifact hand-offs, and the stages that partition the flow. It's the same editor you'll use later to *grow* or *edit* an existing team, so nothing you learn here is throwaway. When the design is complete and its wiring check is clean, you launch it through — again — the same shared Launch action.

The three flow-producing paths therefore form a spectrum of "how much do I decide up front": a **template** hands you a proven wiring you tweak; the **Copilot** drafts a wiring from your description; the **blank canvas** gives you nothing but the tools. That's exactly the order they appear in inside the launcher's flow group — and all three end at one Launch step and produce a real, running team.

## Path D — Chat with one assistant (the fast lane, a team of one) (slide 10)

Screenshot: the single-assistant form — a name field, a model-provider picker, and an optional repository URL field, and nothing under it but the **Create agent & start chatting** button.

Sometimes you don't want a workflow at all — you just want *one* assistant to talk to, right now. The hero at the top of the launcher, **"Chat with one assistant"**, is exactly that, and it's the quickest path in the whole studio — which is precisely why it sits first and full width, with the **Start chatting** button on it.

It's a single, short form: give the assistant a name, pick a model provider for it to run on, and start chatting. There's one optional field — a **repository URL**. Leave it empty and you get a repo-less conversational assistant in a couple of seconds. Fill it in and the assistant clones that repository and can answer questions about the code (that's the one case where it needs an SSH key and a GitHub token). Notice there's no "repo mode vs. LLM mode" switch to pick anymore — whether you typed a repository URL is the *only* thing that changes, and the form figures out the rest.

The framing here matters. This lone assistant is presented as **a team of one**, not as a separate kind of product you chose instead of a team. So the form doesn't nudge you toward "use the team wizard instead" — and since #2045 it doesn't nudge you toward growing either: the *"Grow into a full team →"* link that used to sit under it was removed, because a second call to action under a four-field form competes with the one thing the page is for. The promise still gets made where the choice is made — the launcher hero says you can grow it into a team whenever you're ready — and the "?" on this page explains the two ways to grow: converting this assistant in place (it becomes the first member of a new team, keeping its id, chat room and history), or building a separate new team through the wizard. There's nothing to decide up front and nothing to undo: you start with one, and you scale up when the work calls for it.

## Where creating ends and managing begins (slide 11)

Screenshot: the Agent Chat left rail with a row's context menu open — Settings, Clone, Export, Save as template, Delete — and "+ New Agent" as a page-action button in the header above it.

One last orientation point, so the mental model stays clean. The **"+ Create"** launcher is the single front door for *starting* something; **managing** what already exists happens somewhere else. That somewhere else is now **Agent Chat** (`/chats`): its left rail carries the per-agent and per-team management actions in a row context menu, and its **Settings** tab holds each agent's configuration. (The separate Agents page that used to be the "manage" home was removed in #1930 — `/agents` redirects to `/chats` — because managing an agent next to its conversation is where you already are when you notice something needs changing.) Creating stays a header affordance there rather than a competing call to action: **New Agent** in Agent Chat's page-action header hands over to the same `/create` launcher.

The advanced and manual affordances are all still there — "+ New Agent" (including the orchestrator role; that form was never Agents-page-only, since it is the very same component the launcher's "Configure an agent manually" entry opens under **Advanced options**, which is how the direct path survived that page's retirement), "Add member…" to grow a team, "Save as template" to snapshot a proven agent, and Import for agent ZIPs, process-template JSON or BriefingPacks. None of that was removed; it was just re-layered so that the everyday "I want to start something new" path is one obvious door, and the power-user management operations sit where you'd expect to *manage*, not where a newcomer would go to *begin*. The launcher's ranking follows the same instinct: the specialist form is one click away behind a disclosure rather than gone, so nobody loses a path — the newcomer just stops meeting it as a peer of the fast lane. The five-step wizard and the manual/import paths remain fully available as the advanced/edit layer — power users keep every path they had.

That's the shape of team setup today: one launcher that ranks the ways in from the fastest to the most manual, and a single Launch step that turns any of the flow paths into a live, wired team.
