# Team Setup

## Chapter intro (slide 1)

Let's walk through the Agent Team Wizard. This is where the Agent Studio really shows what it's about: it doesn't just run a single agent, it lets you stand up a whole team of agents that work together on the same repository.

So what exactly is a team here? A team is a coordinated group of AI agents — think of a Business Analyst, a Developer, a Code Reviewer — each with its own role, its own system prompt. They all share one working environment, which means they all work against the same GitHub repository with the same credentials and the same knowledge sources. What makes it a team rather than just a collection of agents is that they're wired together: one agent's output becomes the next agent's trigger. The Business Analyst writes an issue, a human approves it, the Developer picks it up, opens a pull request, the Code Reviewer reacts to that pull request, and so on. The hand-offs happen automatically over GitHub labels and events.

The wizard guides us through this in five steps: first we pick the process — the actual workflow and the roles in it; then the working environment the team operates in; then we name the team; then, optionally, we configure knowledge — the skills and learning behaviour; and finally we review everything before it's created. The nice thing is that the whole team is created in one atomic transaction — if anything fails, it rolls back cleanly, so you never end up with a half-built team.

Let's go through the steps one by one.

## Step 1: Process (slide 2)

Screenshot: wizard Process step with the Core SDLC template selected; flow preview + wiring check visible below.

The first step is the Process step — and it comes first on purpose, because the process is the central decision. Everything after it — the environment, the name, the knowledge — just qualifies this choice.

The step lands directly on the template gallery: you pick a curated template or one of your saved drafts. In this demo we take the simplest, most powerful path: we pick a ready-made template — the Core SDLC flow. (If you'd rather describe the flow in plain language and let the Flow Copilot generate it, or start with a blank canvas and design it free-form, those live in the "+ Create" launcher now — the wizard keeps a small "need a custom flow? use + Create" pointer for that.)

Core SDLC gives us four agents that cover a complete build-and-review loop:

- The Business Analyst is the team's front door. You talk to it in chat, bring it ideas or bug reports, and it turns them into well-defined GitHub issues — precise enough that they can be implemented without guesswork. It doesn't write code; it defines what needs to be built and why.
- The Developer implements the work. As soon as a human marks an issue as "ready", the Developer wakes up, creates a feature branch, writes the code and the tests, and opens a pull request.
- The Code Reviewer is the quality gate. Whenever a pull request is ready for review, it checks the change against every acceptance criterion, runs the tests, and either recommends the merge or sends the work back with concrete, actionable feedback.
- And the Reworker closes the loop: when the reviewer asks for changes, the Reworker addresses that feedback and hands the pull request back for another round of review — looping until the change is clean.

Notice the division of labour: the agents do the heavy lifting, but the human stays in control of the two decisions that matter — what gets built, by approving the issue, and the final merge. Below the selection you also see a small live preview of the flow and a wiring check, so you can confirm the hand-offs actually connect before moving on.

## Step 2: Working Environment (slide 3)

Screenshot: wizard Working Environment step — card grid of environments; one card selected, a repo-less card visibly non-selectable.

The second step is the Working Environment. If the process defines what the team does, the environment defines where it does it.

A Working Environment is a reusable infrastructure template. It bundles the GitHub repository the team works on, the branch, the SSH deploy key and the GitHub token used for git operations and API access, plus any knowledge sources. The key point is that we don't reassemble all of that here from raw credentials — the environment already packages it. So on this step we simply pick one from a card grid. Each card shows the environment's name, its repository, and warns us if something essential is missing — for example, if there's no repository configured, the card can't be selected, because a team needs a repository to work on; or if there's no GitHub token, it flags that the reactive roles won't be able to trigger on issues and pull requests.

This separation is deliberate: the same environment can be reused across many teams, and credentials live in their own store, so you can rotate a token without touching every team. If we don't have a suitable environment yet, there's a direct link to create one — but for the demo we just select the one that points at our target repository and move on.

## Step 3: Team identity (slide 4)

Screenshot: wizard Team step — name, ID, and optional label suffix fields; name and ID pre-filled from the environment.

Step three is where we give the team its identity. There are two required fields and one optional one.

The two required fields — team name and team ID — are pre-filled and suggested from the working environment we just picked. The ID is a slug — lowercase, dashes only — that gets derived automatically from the name as we type. You can override either one, but you usually don't have to.

Why does the ID matter? Because it becomes the prefix for every resource the team creates. So a team with the ID "acme" will produce agents like acme-developer, acme-code-reviewer, and so on. The wizard also checks the ID against everything that already exists — if it collides with an existing agent or team, it tells you right away and asks for a different one. A duplicate team *name*, by contrast, only shows a non-blocking warning — the name is a cosmetic display label, and you can still advance; it is the ID that must be unique. That naming scheme is what keeps a multi-team setup clean and predictable.

The optional **label suffix** field is for when you are running two or more teams against the same GitHub repository at the same time. Every label-based hand-off in the process — the ones that wake agents and gate human approvals — has to be unique per team, otherwise one team's events trigger the wrong team's agents. A suffix (1–8 lowercase letters and digits) is stamped onto every label token before the team is created, so "ready" becomes "ready-abc1" and "revisions-required" becomes "revisions-required-abc1". The wizard offers a **Suggest** button that generates a random four-character suffix, and it shows you a live list of any label mentions in prompts it could not stamp automatically (so you can fix them yourself). If you are the only team on the repository, leave this blank — there is no cost to omitting it, and the label names stay readable.

## Step 4: Knowledge (slide 5)

Screenshot: wizard Knowledge step — skills picker, read-only MCP list, "Advanced: knowledge learning" disclosure (collapsed by default).

The fourth step is Knowledge — and it's explicitly optional. This is where we decide what the team knows and how it learns.

There are two immediately visible parts and one advanced section. First, the initial team skills: skills are curated capability packs from the pool — think COBOL analysis, JCL conversion, and so on for the mainframe-migration domain. Whatever we pick here is placed on the team as a whole, and every member inherits it automatically. Second, the knowledge sources: these are MCP servers the team can query at runtime — a wiki, a vector store, a graph database. These are inherited from the working environment, so they're shown here read-only; to change them you'd edit the environment.

The learning configuration is collapsed behind an **"Advanced: knowledge learning"** disclosure (closed by default, with the one-liner "Controls how much the team auto-learns from its work — defaults are fine to start"). Expanding it reveals the autonomy level and promotion gates: at the lower levels, learnings are proposed and a human reviews them before they become shared team knowledge; at the highest level, the team curates and promotes its own knowledge automatically, closing the loop without a human in it. These are just sensible defaults every team starts on, and you can change all of them later on the Knowledge page — so for the demo we can simply accept the defaults and continue.

## Step 5: Review & create (slide 6)

Screenshot: wizard Review step — full summary; then the per-step creation progress after submit.

The final step is Review — the confirmation before anything is created. Nothing has been built yet; this is our last chance to check the whole picture in one place.

Here we see it all laid out: the team name and ID, the working environment and repository, the exact list of agents that will be created — each with its concrete ID, so you can see for instance that you'll get an acme-business-analyst, an acme-developer, and so on — plus the skills and the learning configuration. If the process uses labels for hand-offs, those are shown too, and where relevant the wizard even checks whether the repository has the supporting GitHub workflow installed and offers to set it up.

When we hit create, the wizard materialises everything in one atomic-with-rollback transaction: it sets up the shared environment, creates the team, spawns each member agent with its role-specific prompt and triggers, provisions a Matrix user and a chat room for each — and if any step fails, it unwinds everything in reverse, so we never end up with a partial team. A few seconds later, we have a fully wired, running team of agents ready to react to the first issue.
