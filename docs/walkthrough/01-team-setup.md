# Team Setup

## Chapter intro (slide 1)

Let's walk through how you go from an idea to a running set of agents in the Agent Studio. This is where the product really shows what it's about: it doesn't just run a single assistant, it lets you stand up a whole team of agents that work together on the same repository — and, just as importantly, it lets you start small and grow into that team when you're ready.

So what exactly is a team here? A team is a coordinated group of AI agents — think of a Business Analyst, a Developer, a Code Reviewer — each with its own role, its own system prompt. They all share one working environment, which means they all work against the same GitHub repository with the same credentials and the same knowledge sources. What makes it a team rather than just a collection of agents is that they're wired together: one agent's output becomes the next agent's trigger. The Business Analyst writes an issue, a human approves it, the Developer picks it up, opens a pull request, the Code Reviewer reacts to that pull request, and so on. The hand-offs happen automatically over GitHub labels and events.

The important thing to understand before we start is that you no longer have to decide up front *what kind of thing* you're creating. In the past there were separate front doors — one for a single agent, another for a whole team, others for describing a flow or drawing it on a canvas — and you had to know which door matched your goal before you could even begin. That's gone. Now there is **one** front door, the **"+ Create"** launcher, and it asks a much simpler question: *how would you like to start?* Whether the result is one assistant or a four-agent team is an outcome the system right-sizes from what you describe or pick — not a mode you have to classify yourself.

Let's start at that launcher, look at each of the ways in, and then follow the most complete path — starting from a ready-made setup — all the way to a live, wired team.

## The "+ Create" launcher — one front door (slide 2)

Screenshot: the Create launcher page (`/create`) — four equally-ranked tiles in a grid, with the direct "Create a single agent" entry set apart below them; the persistent "+ Create" control highlighted in the sidebar.

Everything starts at the launcher. It's reachable two ways, and both open exactly the same screen: there's a persistent **"+ Create"** control pinned in the sidebar — always visible, on every page — and a dedicated `/create` route for when you want to link straight to it. The heading asks one plain question: *"How would you like to start? Pick whichever fits — you can always change direction later."*

Below it are **four equally-ranked tiles**. None of them is a highlighted default, and — this is deliberate — none of *these four* titles uses the words *agent*, *team*, *flow*, *template* or *orchestrator*. You choose by what you're trying to do, not by learning our internal vocabulary first:

- **"Describe what you need"** — the conversational way in. You tell the studio in plain language what you want to get done, and it drafts a flow for you, showing a live preview before anything is created. This hands off to the Flow Copilot on a fresh draft in the canvas.
- **"Start from a ready-made setup"** — the fastest way to a working team when a proven pattern already fits. You pick a curated template (or one of your own saved drafts) and adjust it. This opens the structured five-step wizard on its template gallery. This is the path we'll follow in detail below.
- **"Build it yourself"** — full control from a blank slate. You lay the team out visually on the canvas and connect the pieces yourself. This opens a fresh, empty draft in the Flows editor.
- **"Just give me one assistant to chat with"** — the fast lane. It spins up a single assistant you can start talking to right away: no wiring, no roles, no setup. Crucially, this is framed as *a team of one*, not as a different kind of product — you can grow it into a full team whenever you need more.

Below those four sits one more entry, and it is deliberately different: **"Create a single agent"** is the direct form — you set the id, the role (a plain agent, an Agent Team template or an orchestrator), the Working Environment, the skills and the system prompt yourself, on an environment that already exists, and nothing is created alongside it. It's the "I already know exactly what I want" path, which is why it's the one entry that *does* name the artifact: saying anything vaguer would make it indistinguishable from the fast lane above it. It opens right here on the launcher, in a side panel, so the four guided tiles stay in view behind it.

Two of these tiles (describe / build-yourself) produce a **flow draft** that you refine on the canvas and then launch; one (ready-made setup) runs the **guided wizard**; one (single assistant) is the **fast lane** to a lone chat agent; and the direct form decides nothing for you at all. They all end at the same place — running agents — they just differ in how much you decide up front versus how much the studio decides for you. Let's take the ready-made-setup path first, because it's the most complete and shows every step of standing up a team; then we'll come back to the other three and show what's different about each.

## Path A — Start from a ready-made setup (the guided wizard)

### Step 1: Process (slide 3)

Screenshot: wizard Process step with the Core SDLC template selected; flow preview + wiring check visible below.

Choosing **"Start from a ready-made setup"** on the launcher drops us into the wizard, and it lands directly on the **Process step** — the template gallery. This step comes first on purpose, because the process is the central decision. Everything after it — the environment, the name, the knowledge — just qualifies this choice.

The gallery lists the curated templates alongside any drafts you've saved. In this demo we take the simplest, most powerful path: we pick a ready-made template — the **Core SDLC** flow. (The two more free-form ways of authoring a process — describing it in plain language, or starting from a blank canvas — aren't crammed into this step anymore; they're their own tiles on the "+ Create" launcher. The wizard keeps only a small "need a custom flow? use + Create" pointer, and an empty-state link to the launcher if you have no templates or drafts yet.)

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

Not everyone wants to start from a template. If you know *what you want* but not *which pattern matches it*, the **"Describe what you need"** tile is the way in. It opens a fresh draft in the canvas with the **Flow Copilot** attached.

You type what you're trying to achieve in plain language — "I want a team that triages incoming bug reports, has a developer fix them, and a reviewer check the fix before merge" — and the Copilot drafts a flow for you: the roles, their prompts, and the label hand-offs that wire them together. Crucially, it does this as a **live preview** with a confirm-to-create step, so you see the graph take shape and can react to it before anything is actually built. Nothing is committed until you say so.

From that draft you can keep refining — ask the Copilot to add a security reviewer, split a role, change a hand-off — and when you're happy you launch it through the same shared Launch step as the wizard. So "describe it" and "start from a template" converge: the difference is only in how the first draft comes to exist.

## Path C — Build it yourself (the blank canvas) (slide 9)

Screenshot: the Flows editor with a fresh, empty draft — an empty canvas, the role palette and the "Add role" affordance.

When you want complete control and don't want anything drafted for you, **"Build it yourself"** opens a brand-new, empty draft directly in the Flows editor. This is the power-user path.

Here you place roles by hand, write or generate their prompts, and draw the hand-offs yourself — the label edges that wake one agent when another emits, the GitHub PR/issue channels, the human-approval gates, the data-flow artifact hand-offs, and the stages that partition the flow. It's the same editor you'll use later to *grow* or *edit* an existing team, so nothing you learn here is throwaway. When the design is complete and its wiring check is clean, you launch it through — again — the same shared Launch action.

The three flow-producing paths therefore form a spectrum of "how much do I decide up front": a **template** hands you a proven wiring you tweak; the **Copilot** drafts a wiring from your description; the **blank canvas** gives you nothing but the tools. All three end at one Launch step and produce a real, running team.

## Path D — Just one assistant to chat with (the fast lane, a team of one) (slide 10)

Screenshot: the single-assistant form — a name field, a model-provider picker, and an optional repository URL field; a "Grow into a full team →" link below.

Sometimes you don't want a workflow at all — you just want *one* assistant to talk to, right now. The fourth tile, **"Just give me one assistant to chat with"**, is exactly that, and it's the quickest path in the whole studio.

It's a single, short form: give the assistant a name, pick a model provider for it to run on, and start chatting. There's one optional field — a **repository URL**. Leave it empty and you get a repo-less conversational assistant in a couple of seconds. Fill it in and the assistant clones that repository and can answer questions about the code (that's the one case where it needs an SSH key and a GitHub token). Notice there's no "repo mode vs. LLM mode" switch to pick anymore — whether you typed a repository URL is the *only* thing that changes, and the form figures out the rest.

The framing here matters. This lone assistant is presented as **a team of one**, not as a separate kind of product you chose instead of a team. So the form doesn't nudge you toward "use the team wizard instead" — it simply offers a **"Grow into a full team →"** link for when you outgrow a single assistant and want reviewers, a developer, or a full development workflow around it. There's nothing to decide up front and nothing to undo: you start with one, and you scale up when the work calls for it.

## Where creating ends and managing begins (slide 11)

Screenshot: the Agents page with its "manage" subtitle; the "+ New Agent" action shown as a demoted, secondary button.

One last orientation point, so the mental model stays clean. Now that the **"+ Create"** launcher is the single front door for *starting* something, the **Agents page** has stepped back into its real job: **managing** what already exists. Its subtitle says so, and its "+ New Agent" button is deliberately demoted to a secondary affordance rather than a headline call to action. The empty-state prompt on that page routes you back through the `/create` launcher.

The advanced and manual affordances are all still there — "+ New Agent" (including the orchestrator role; that form is no longer Agents-page-only, since it is the very same component the launcher's "Create a single agent" entry opens, which is how the direct path survives this page's eventual retirement), "Add Member" to grow a team, "Save as template" to snapshot a proven agent, and Import for agent ZIPs, process-template JSON or BriefingPacks. None of that was removed; it was just re-layered so that the everyday "I want to start something new" path is one obvious door, and the power-user management operations sit where you'd expect to *manage*, not where a newcomer would go to *begin*. The five-step wizard and the manual/import paths remain fully available as the advanced/edit layer — power users keep every path they had.

That's the shape of team setup today: one launcher, four honest ways in plus the direct form for when you already know, and a single Launch step that turns any of the workflow paths into a live, wired team.
