# Target walkthrough deck — reference snapshot

> Machine-readable snapshot of the hand-authored target deck **2026-07-14-Agent-Studio-IBAN-Demo.pptx** (54 slides).
> Committed so container agents (no local/OneDrive access) can diff the generated docgen deck against the target for **T7 / #747**.
> Source of truth for the deck's narrative style + chapter structure. Do not hand-edit to drift from the real deck — regenerate from the pptx.


## Slide 1 — Team Setup

**Speaker notes:**

Let's walk through the Team Setup wizard. This is where the Agent Studio really shows what it's about: it doesn't just run a single agent, it lets you stand up a whole team of agents that work together on the same repository.
So what exactly is a team here? A team is a coordinated group of AI agents — think of a Business Analyst, a Developer, a Code Reviewer — each with its own role, its own system prompt. They all share one working environment, which means they all work against the same GitHub repository with the same credentials and the same knowledge sources. What makes it a team rather than just a collection of agents is that they're wired together: one agent's output becomes the next agent's trigger. The Business Analyst writes an issue, a human approves it, the Developer picks it up, opens a pull request, the Code Reviewer reacts to that pull request, and so on. The hand-offs happen automatically over GitHub labels and events.
The wizard guides us through this in five steps: first we pick the process — the actual workflow and the roles in it; then the working environment the team operates in; then we name the team; then, optionally, we configure knowledge — the skills and learning behaviour; and finally we review everything before it's created. The nice thing is that the whole team is created in one atomic transaction — if anything fails, it rolls back cleanly, so you never end up with a half-built team.
Let's go through the steps one by one.

## Slide 2 — (no title text)

**Speaker notes:**

The first step is the Process step — and it comes first on purpose, because the process is the central decision. Everything after it — the environment, the name, the knowledge — just qualifies this choice.
The step lands directly on the template gallery: you pick a curated template or one of your saved drafts. In this demo we take the simplest, most powerful path: we pick a ready-made template — the Core SDLC flow. (Describing a flow in plain language or starting blank in the canvas now lives in the "+ Create" launcher; the wizard keeps a small pointer to it.)
Core SDLC gives us four agents that cover a complete build-and-review loop:
- The Business Analyst is the team's front door. You talk to it in chat, bring it ideas or bug reports, and it turns them into well-defined GitHub issues — precise enough that they can be implemented without guesswork. It doesn't write code; it defines what needs to be built and why.
- The Developer implements the work. As soon as a human marks an issue as "ready", the Developer wakes up, creates a feature branch, writes the code and the tests, and opens a pull request.
- The Code Reviewer is the quality gate. Whenever a pull request is ready for review, it checks the change against every acceptance criterion, runs the tests, and either recommends the merge or sends the work back with concrete, actionable feedback.
- And the Reworker closes the loop: when the reviewer asks for changes, the Reworker addresses that feedback and hands the pull request back for another round of review — looping until the change is clean.
Notice the division of labour: the agents do the heavy lifting, but the human stays in control of the two decisions that matter — what gets built, by approving the issue, and the final merge. Below the selection you also see a small live preview of the flow and a wiring check, so you can confirm the hand-offs actually connect before moving on.

## Slide 3 — (no title text)

**Speaker notes:**

The second step is the Working Environment. If the process defines what the team does, the environment defines where it does it.
A Working Environment is a reusable infrastructure template. It bundles the GitHub repository the team works on, the branch, the SSH deploy key and the GitHub token used for git operations and API access, plus any knowledge sources. The key point is that we don't reassemble all of that here from raw credentials — the environment already packages it. So on this step we simply pick one from a card grid. Each card shows the environment's name, its repository, and warns us if something essential is missing — for example, if there's no repository configured, the card can't be selected, because a team needs a repository to work on; or if there's no GitHub token, it flags that the reactive roles won't be able to trigger on issues and pull requests.
This separation is deliberate: the same environment can be reused across many teams, and credentials live in their own store, so you can rotate a token without touching every team. If we don't have a suitable environment yet, there's a direct link to create one — but for the demo we just select the one that points at our target repository and move on.

## Slide 4 — (no title text)

**Speaker notes:**

Step three is where we give the team its identity — really just two fields: a team name and a team ID.
The wizard is helpful here: both fields are pre-filled and suggested from the working environment we just picked, and the ID is a slug — lowercase, dashes only — that gets derived automatically from the name as we type. You can override either one, but you usually don't have to.
Why does the ID matter? Because it becomes the prefix for every resource the team creates. So a team with the ID "acme" will produce agents like acme-developer, acme-code-reviewer, and so on. The wizard also checks the ID against everything that already exists — if it collides with an existing agent or team, it tells you right away and asks for a different one. That naming scheme is what keeps a multi-team setup clean and predictable.

## Slide 5 — (no title text)

**Speaker notes:**

The fourth step is Knowledge — and it's explicitly optional. This is where we decide what the team knows and how it learns.
There are three parts to it. First, the initial team skills: skills are curated capability packs from the pool — think COBOL analysis, JCL conversion, and so on for the mainframe-migration domain. Whatever we pick here is placed on the team as a whole, and every member inherits it automatically. Second, the knowledge sources: these are MCP servers the team can query at runtime — a wiki, a vector store, a graph database. These are inherited from the working environment, so they're shown here read-only; to change them you'd edit the environment.
The third part is the most interesting: how the team learns and shares knowledge. Agents in the Agent Studio don't just execute — they accumulate lessons over time and can share them across the team. Here you set the autonomy level: at the lower levels, learnings are proposed and a human reviews them before they become shared team knowledge; at the highest level, the team curates and promotes its own knowledge automatically, closing the loop without a human in it. These are just sensible defaults every team starts on, and you can change all of them later on the Knowledge page — so for the demo we can simply accept the defaults and continue.

## Slide 6 — (no title text)

**Speaker notes:**

The final step is Review — the confirmation before anything is created. Nothing has been built yet; this is our last chance to check the whole picture in one place.
Here we see it all laid out: the team name and ID, the working environment and repository, the exact list of agents that will be created — each with its concrete ID, so you can see for instance that you'll get an acme-business-analyst, an acme-developer, and so on — plus the skills and the learning configuration. If the process uses labels for hand-offs, those are shown too, and where relevant the wizard even checks whether the repository has the supporting GitHub workflow installed and offers to set it up.
When we hit create, the wizard materialises everything in one atomic-with-rollback transaction: it sets up the shared environment, creates the team, spawns each member agent with its role-specific prompt and triggers, provisions a Matrix user and a chat room for each — and if any step fails, it unwinds everything in reverse, so we never end up with a partial team. A few seconds later, we have a fully wired, running team of agents ready to react to the first issue.

## Slide 7 — Workingwith agents

**Speaker notes:**

So far we've built a team. Now let's actually work with it. In this second part I'll show you what it feels like to collaborate with a team of agents on a real change — end to end, from a vague idea in chat all the way to a pull request that's ready to merge.
The example we'll follow is deliberately small but realistic: a SEPA bank-transfer form today accepts any text in its IBAN field and always reports success — even for an invalid or non-existent account. We want the form to actually validate the recipient's IBAN against a public service before the transfer can go through. Watch how the four agents of our Core SDLC team — Business Analyst, Developer, Code Reviewer and Reworker — pick this up and carry it through the process, with me, the human, staying in control at exactly two points.

## Slide 8 — (no title text)

**Speaker notes:**

This is the Agent Chat — the workspace where a human talks directly to any agent, without leaving the Agent Studio. On the left you see our team, "Agentic Demos", with its four members: Business Analyst, Code Reviewer, Developer and Reworker. Each one is a full agent with its own chat identity, and I can open a one-to-one conversation with any of them.
In the middle is the conversation itself — right now it's empty, we haven't said anything yet. Notice the toolbar on top: I can start a new session, reset the session, and I can even pick the model the agent runs on — here it's Claude Opus. On the right is a live view into the agent's own workspace: its file tree, the cloned repository, its memory, its knowledge digest. So at any moment I can see not just what the agent says, but what it actually has in front of it. We start, naturally, with the Business Analyst — the team's front door.

## Slide 9 — 9

**Speaker notes:**

I've described my request to the Business Analyst in plain language — "the transfer form should validate the IBAN". And here's the first thing worth appreciating: the agent doesn't just start writing a specification. It pushes back with clarifying questions first.
It has already looked at the current form in the repository, understood that today it only tidies up the IBAN but never checks whether it's real, and now it asks the six questions that genuinely need a human decision: When should validation happen — on blur, on submit? What happens to an invalid IBAN — block or just warn? What if the external service is down — block or let it through? How much bank detail do we show? Is it only the recipient IBAN in scope? And what about an empty field? These are exactly the product decisions an agent should not invent on its own. This is the "understand before you write" discipline built into the role.

## Slide 10 — 10

**Speaker notes:**

Now I answer — and notice how little effort this takes. I don't have to write prose; I just respond point by point: "one, when they leave the field; two, block; three, block; four, show all details; five, only the IBAN field; six, good." Six short answers to six precise questions.
This is the essence of working with agents this way: the agent did the hard part of figuring out what needs to be decided, and framed it so that my input is fast and unambiguous. I'm steering the outcome without having to author a requirements document myself.

## Slide 11 — 11

**Speaker notes:**

With my six decisions in hand, the Business Analyst finalizes the work item. It has created Issue #65 in GitHub and summarizes back to me exactly what it captured: validate on blur, invalid means blocked, if the service can't be reached the submission is blocked, a valid IBAN shows the bank details, only the recipient IBAN is in scope, an empty field is just a normal required-field prompt.
The issue itself is written in two layers — a plain-language Human Section any stakeholder can read, and a full Agent Section with problem statement, scope, nine testable acceptance criteria and edge cases for the delivery team. And it's honest about trade-offs: it explicitly flags that because we block when the service is unreachable, an outage would stop all transfers — that's the intended behaviour, but it wants me to be aware of it. Finally, it tells me the hand-off rule: add the ready label when you want the Developer to pick it up. Until I do, nothing happens. That's the first of my two control points.

## Slide 12 — 12

**Speaker notes:**

Here's that control point in action, over on GitHub. This is Issue #65 as the Business Analyst wrote it — you can see the Human Section and the Agent Section with the technical brief.
And this is the human go-signal: I open the Labels menu and apply ready. This label is deliberately a human gate — no agent can set it. By adding it, I'm approving what gets built. The moment I do, it becomes a GitHub event that the platform is listening for — and that event is what wakes the next agent in the chain. Notice the other labels waiting in the wings — ready-for-review, ready-to-merge — each one is a hand-off signal between agents further down the loop.

## Slide 13 — 13

**Speaker notes:**

The ready label fired a GitHub trigger, and the Developer agent woke up automatically — you can see the trigger event right in its chat: "Issue #65, labelled ready, human-approved — starting work." No one opened this chat to prompt it; the label alone set it in motion.
The Developer then did the whole implementation on its own: it derived the tech stack from the repository, created a feature branch, built a pure, testable openiban client and wired the validation states into the form — validating, valid, invalid, could-not-verify — added nine passing unit tests, and got the build green. Then it opened Pull Request #69 and labelled it ready-for-review. Notice the hand-off is again just a label — and that label is what will wake the Code Reviewer. The Developer never reviews or merges its own work.

## Slide 14 — 14

**Speaker notes:**

Same pattern again: the ready-for-review label on the pull request fired a trigger, and now the Code Reviewer wakes up on its own. It checks out the branch, reviews the full diff in context — not just the PR page — and goes through the issue's acceptance criteria one by one.
Its verdict here: all nine acceptance criteria met. It verified locally that the tests pass and the build is green, confirmed the change is secure — the IBAN is properly encoded, no injection — and it flagged two minor, explicitly non-blocking notes rather than treating them as blockers. It posts a structured review comment and applies ready-to-merge. And here's the important line: it says "a human performs the merge." The Code Reviewer recommends; it never merges.
One thing worth pointing out: in this run the review passed cleanly, so the fourth agent — the Reworker — never had to act. If the reviewer had instead applied revisions-required, that would have woken the Reworker to address the feedback and loop back for another review, over and over, until the change was clean. The happy path here simply skips that loop.

## Slide 15 — 15

**Speaker notes:**

And this is where we land: Pull Request #69, marked "Ready to merge", carrying the ready-to-merge label the Code Reviewer applied, and cleanly closing Issue #65.
Step back and look at what happened. From a one-line idea in a chat, a team of agents produced a well-specified issue, a complete implementation with tests, and a reviewed, merge-ready pull request — hand-off to hand-off, each step triggered automatically by a GitHub label, no one manually shuttling work between agents. And the human stayed in control at exactly the two points that matter: approving what gets built with the ready label, and performing the final merge. That's the whole promise of working with agents in the Agent Studio — the agents do the heavy lifting; you keep the decisions.

## Slide 16 — Triggers

**Speaker notes:**

In the demo you just saw, something quietly did a lot of the heavy lifting. Remember how the Developer woke up the moment a human applied the ready label, and the Code Reviewer sprang to life the instant a pull request was opened? No one opened a chat and typed "please start now" — the agents reacted to events on their own. What made that possible are triggers.
A trigger is the rule that says "when this happens, wake this agent and give it this prompt." It's the mechanism that turns a group of chat agents into an autonomous, event-driven team — the difference between an assistant you have to talk to and a workforce that responds to what's happening in your project by itself.
So far we've only seen one kind of trigger in action: reacting to GitHub events like a labelled issue or a new pull request. But that's just one of several. In this chapter I want to go one level deeper and show you the different types of triggers the platform offers — reacting to GitHub events, running on a schedule, firing once at a set time, or being called from the outside via a webhook — and how each one is configured. Let's look at them one by one.

## Slide 17 — (no title text)

**Speaker notes:**

Let's create our first trigger, and start with the most intuitive kind: a scheduled trigger. I open an agent — here the Business Analyst — and add a trigger to it directly. This panel is where every trigger is configured, and the fields are the same regardless of type.
At the top I can give it an ID — optional, it's auto-generated if I leave it blank. Then the key choice: the Type. I've picked Cron (recurring) — a trigger that fires on a repeating schedule. The Studio keeps the scheduling human-friendly: I choose Daily, set the time to 07:00, and it confirms in plain language "Every day at 07:00" while quietly showing the underlying cron expression, 0 7 * * *, for anyone who wants it. So there's no need to remember cron syntax — you pick a cadence and a time, and the platform translates it.
Below that is the heart of any trigger: the Prompt. This is the instruction the agent receives when the trigger fires — here, "Generate a summary of the pull requests completed yesterday." Every morning at seven, this agent will wake up on its own, with no one in the chat, and carry out that instruction. An optional Description documents its purpose, the Enabled toggle lets me arm or pause it without deleting it, and Add Trigger saves it.
This is the essence of a cron trigger: recurring, unattended work — a daily digest, a nightly cleanup, a weekly report — running like clockwork whether or not anyone is watching.

## Slide 18 — (no title text)

**Speaker notes:**

The second type is the simplest: a Once trigger — a one-shot that fires a single time, at a moment you pick, and then removes itself. Where Cron is for anything recurring, Once is for a single future action.
The configuration is even shorter. I switch the Type to Once (one-shot), and the schedule collapses to a single field: Date & Time. Here I've set it to the 20th of July at 08:00. Then, as with every trigger, the Prompt carries the instruction — in this case a small personal reminder: "Remind me once that I am responsible for the time reporting this week." On that date, at that time, the agent wakes up, delivers the reminder into the chat, and the trigger is done — it won't fire again.
It's a modest feature, but a telling one: it shows triggers aren't only about heavy automation. A one-shot can be a personal nudge, a deferred follow-up, a "check back on this next Monday." Same mechanism as the scheduled digest, just scoped to a single occurrence.

## Slide 19 — (no title text)

**Speaker notes:**

The third type opens the team up to the outside world. Where Cron and Once fire on time, an HTTP webhook trigger fires when an external system calls it — a CI/CD pipeline, a monitoring tool, a deployment script, anything that can send an HTTP request.
When I choose HTTP webhook as the type, the panel generates the two things a caller needs. First, a dedicated endpoint: POST /hooks/agentic-demos-business-analyst/<id> on the webhook port — a unique URL that belongs to this one trigger on this one agent. Second, and importantly, an X-Hook-Secret. This is a required shared secret: any external system that wants to fire the trigger must send this secret in the request header. That's the security model — there's no open, unauthenticated mode; you copy the secret once, store it wherever the calling system keeps its credentials (a GitHub webhook secret, for example), and you can rotate it here at any time with the refresh button.
The Prompt again defines what the agent does when the call arrives — here: "The CI/CD pipeline has just deployed a new version to production… we have successfully merged the recently worked-on tickets." So the moment a deployment finishes, the pipeline hits this endpoint, and the agent wakes up to react — post an announcement, kick off follow-up work, whatever the prompt directs. This is how you wire agents into the tools you already run, so your existing automation can hand off to the team.

## Slide 20 — (no title text)

**Speaker notes:**

And now the one we've already seen doing the real work in the demo: the GitHub event trigger. This is the type that made the Developer wake on a ready label and the Code Reviewer wake on a new pull request. Here we get to see the full menu of what an agent can react to.
After choosing GitHub event as the type, I first pick the Repository the agent should watch — here our demo collection. Then comes the Event dropdown, and this is the heart of it: the complete catalog of things that can happen on a repo. A push; the whole pull-request lifecycle — opened, closed, merged, reopened, labeled, unlabeled, review submitted, review comment; issue comments; the issue lifecycle — opened, closed, labeled, unlabeled; and even release published. Each one is a precise hook into the team's GitHub workflow.
You can see the two that drove our earlier demo highlighted here — Issue opened and Issue labeled. That's exactly how the hand-offs worked: the Business Analyst's issue getting the ready label was an issues.labeled event, and that's what set the Developer in motion. Typically you'd narrow it further with a label filter — react only to the ready label, not every label — so an agent responds to precisely the signal it cares about. This is the trigger type that turns GitHub itself into the team's nervous system: work moves, labels get applied, and the right agent wakes up for the right event, entirely on its own.

## Slide 21 — (no title text)

**Speaker notes:**

The fifth type is subtle but important: Data flow — agent dependency. At first glance it looks like a plain push trigger, but conceptually it's something different, and it's worth being precise about why.
A raw push trigger is a purely technical signal: "a commit landed." A data-flow trigger reframes that same event as a hand-off between teammates: "an upstream agent finished a piece of work and committed it — that committed artifact is your input, so now it's your turn." Because every agent has its own workspace and its own clone of the repo, git is the durable bridge between them — so one agent pushing its result is the mechanism by which the next agent receives it. The type name says it out loud: this is a dependency between agents, expressed through the repository.
Now, the variant shown here is the general one. Read the note: this agent is woken on any push to the team repo, regardless of who pushed — even its own commits. That's why the discipline in the prompt matters: the woken agent should git pull, check whether the change is actually relevant to it, and simply reply [PASS] if there's nothing for it to do. It's a broad, catch-all dependency — "something changed, come and look."
But the real power is that you don't have to stay this broad. In the Flow editor, you can draw a data-flow connection from one specific producer to one specific consumer, matched on a named artifact. That derives a targeted dependency trigger — the consumer wakes only when that particular upstream agent publishes that particular output, not on every push in the repo. So the same mechanism scales from "react to any change" down to "listen precisely for the result of one named agent." That's the distinction to take away: a push trigger listens to the repository; a data-flow trigger lets an agent listen to another agent's results — either broadly, as here, or surgically, when you wire it in the flow.

## Slide 22 — Flows

**Speaker notes:**

We've now seen two ways to get a team of agents: the guided Team-Setup wizard, and working with a team that already exists. But sometimes you don't want a wizard to make the decisions for you — you want to draw the process yourself, agent by agent, connection by connection. That's what Flows is for.
Flows is the visual design surface of the Agent Studio — a canvas where you lay out the agents, decide who hands work to whom, and wire the whole orchestration by hand. In the next few slides I'll show you just how simple it is to build a flow from scratch: create a draft, add an agent, and let the platform help you write it.

## Slide 23 — (no title text)

**Speaker notes:**

This is the Flows editor. On the left is the list of everything the canvas can show: your live Teams — here our "Agentic Demos" team from earlier — a Drafts section, and the BriefingPack flows. A draft is the important concept here: it's an editable process that exists before any team is created. Nothing is live yet, nothing is spawned — it's a design you can shape freely and turn into a real team only when you're happy with it.
I've created a fresh draft called "Simple SDLC", and right now it's completely empty — zero agents, a blank canvas. The hint at the top says it all: design from scratch — add an agent, drag a port to wire connections, click to edit; nothing is created until you press Create team. Along the top are the actions I'll use: Add agent, Stages, Create team…, Export. And down at the bottom is the legend — this is the vocabulary of a flow: label hand-offs, issue and pull-request channels, reviews, human approvals, GitHub events. Every connection I draw will be one of these. Let's add our first agent.

## Slide 24 — 24

**Speaker notes:**

I click Add agent, and this panel slides in. I have two choices: start from a template — one of the catalog roles like Developer or Code Reviewer — or, as here, from scratch.
Building from scratch is remarkably low-effort. I give the agent a name — "Business Analyst" — and then, instead of writing a full system prompt by hand, I just jot down a short note describing what it should do: "Take requirements and create a GitHub issue." That one line of intent is enough for the platform to do the heavy lifting. The large field below is where the actual agent prompt will go — but I don't have to type it myself.

## Slide 25 — 25

**Speaker notes:**

I press Generate agent prompt, and the Studio turns my one-line note into a complete, well-structured system prompt for the role. You can see the result here: it lays out the Business Analyst's core responsibilities — engage the human to clarify requirements before writing anything, ask focused questions about acceptance criteria and edge cases, convert confirmed requirements into a structured GitHub issue, and only post it once the human approves. It even adds a quality bar: every issue must have at least one testable acceptance criterion, avoid vague language, and stay self-contained.
That's a genuinely usable persona, drafted in seconds. And nothing is applied silently — it lands in an editable field, so I can review and adjust it before committing. I click Add agent, and the Business Analyst becomes the first node on my canvas.

## Slide 26 — 26

**Speaker notes:**

 With the Business Analyst placed, I repeat the process for the second role. Notice the canvas already has the first node, and two source nodes have appeared at the top — GitHub and External system — these represent the outside world that can feed events into the flow.
I add a new agent, name it "Developer", and again describe it in one line: "Take an issue and implement it. Create a PR at the end." Same pattern as before — a short note is enough to seed a full prompt.

## Slide 27 — 27

**Speaker notes:**

And again, Generate agent prompt produces a complete role definition — this time for the Developer: turn GitHub issues into working, reviewed-ready code; read the issue thoroughly and clarify ambiguity before writing a line; follow the project's existing conventions; keep commits small and focused; write tests; and open a pull request that references the originating issue and explains how to verify it. It even spells out the collaboration discipline — flag blockers to the human, wait for review feedback, and a quality bar of passing tests and no hardcoded secrets.
I review it, and add the agent. That's two fully-specified agents authored with essentially two short sentences of my own input.

## Slide 28 — 28

**Speaker notes:**

Here's where we are: two agents on the canvas — Business Analyst and Developer — each with its generated prompt, plus the GitHub and External-system sources up top. The draft now says "2 agents".
But they're still standing side by side, unconnected. Two agents that don't hand work to each other aren't a process yet — they're just two agents. The next step is the one that actually makes this a flow: wiring them together.

## Slide 29 — 29

**Speaker notes:**

To connect them, I drag from the Business Analyst's port onto the Developer, and the Studio asks the crucial question: how should these two be connected? This is where the flow's semantics are decided, and the options map exactly to the ways agents really hand work off:
- a Pull-request channel — one agent opens a PR that wakes the other;
- an Issue channel — one opens an issue that wakes the other;
- a Label hand-off — one emits a label the other listens for;
- a Data flow / hand-off — one produces an artifact the other consumes;
- or Parent / child — a grouping relationship.
For our Business Analyst handing work to the Developer, the natural choice is the Issue channel — the BA opens an issue, and that issue wakes the Developer.

## Slide 30 — 30

**Speaker notes:**

Choosing the issue channel opens its configuration. It reads plainly: Business Analyst opens an issue that wakes Developer. Now I make two decisions that shape how the hand-off behaves.
First, a routing label — I enter ready. Without a label, the Developer would wake on every issue the BA opens; with the ready label, it only wakes when that label is present. Second — and this is the important one — I tick Human approval gate: a person applies the label. That single checkbox turns this hand-off into a human control point. The Developer won't start until a human has looked at the issue and applied ready. I click Create channel, and the connection is made.

## Slide 31 — 31

**Speaker notes:**

And there it is — a working flow. The Business Analyst now carries an Issue output badge, and a connection runs down to the Developer, labelled "Issue · ready" with the little gate marker showing it's human-approved.
Read it top to bottom, this is a complete micro-process: the Business Analyst turns a request into a GitHub issue, a human reviews it and applies ready, and only then does the Developer wake up to implement it. Everything we walked through by hand in the earlier Core SDLC demo — but here I designed it myself, in a couple of minutes, on a blank canvas.

## Slide 32 — 32

**Speaker notes:**

 As a final touch, I turn on Stages, and the flow organises itself into labelled bands: Requirements, containing the Business Analyst, and Build, containing the Developer. Stages are purely an organising layer — they group the agents into the phases of your process and make a larger flow readable at a glance, while the hand-off between them, our human-gated ready issue, stays exactly as we drew it.
This is the finished draft. From here, one click on Create team… would turn this drawing into a live, running team — real agents, real Matrix identities, reacting to real GitHub events — or I can Export it as a portable template to share and reuse. That's the whole story of Flows: design the orchestration visually, let the platform draft the hard parts, and go live only when you're ready.

## Slide 33 — Agent Templates

**Speaker notes:**

 Building agents from scratch, one generated prompt at a time, is powerful — but you don't want to reinvent the same Business Analyst or Code Reviewer every time you design a new flow. That's where Agent Templates come in.
An Agent Template is a ready-made, reusable agent definition — its persona prompt, its session behaviour, its triggers — packaged so you can drop it straight into a flow. Think of them as the building blocks the platform ships with, plus any you create yourself. In this short chapter I'll show two things: how templates let you assemble a flow in seconds instead of writing each agent by hand, and where you manage the template library itself.

## Slide 34 — (no title text)

**Speaker notes:**

This is the same Add agent panel we used in the Flow editor a moment ago — but this time I stay on the From a template tab instead of building from scratch. Now, rather than typing a note and generating a prompt, I simply pick a pre-built role from the catalog.
The panel lists the available templates with a short description of each — here you can see an Architect that talks through system design before issues are written, a Backlog Hygiene agent that keeps the issue backlog clean, a Business Analyst that refines requirements into GitHub issues, and many more. When I select one — the Architect — the panel immediately shows its full, professionally-written agent prompt as a preview, and even notes what comes bundled with it, in this case one trigger. I can rename it if I like, then click Add agent, and a complete, battle-tested agent lands on the canvas — no prompt-writing required. That's the shortcut: instead of authoring every role, you compose your flow from proven templates and only fall back to "from scratch" for the roles that are genuinely unique to you.

## Slide 35 — 35

**Speaker notes:**

And this is where those templates live: the Agent Templates management page. It's the single catalog of every predefined agent the platform offers — the same ones the Team-Setup wizard and the Flow editor draw from.
Each row is one template, with its ID, its category — chat or reactive — its session policy, and its source. You get the whole library out of the box: Architect, Backlog Hygiene, Business Analyst, Code Reviewer, Developer, Dispatcher, Documentation Sync, Issue Triage, and more — each a mature, ready-to-use role. The built-in ones ship as read-only defaults, but the important part is up here: New template. You can author your own reusable agents — capture a role you've refined, or a persona specific to your organisation — and from then on it appears in this catalog and in every flow's template picker. One note worth making: editing a template only affects future agents created from it; agents you've already spawned keep running independently. So Agent Templates are really about reuse at scale — define a good agent once, and reuse it across every team and every flow you build.

## Slide 36 — Skills Registry

_(no speaker notes)_

## Slide 37 — (no title text)

_(no speaker notes)_

## Slide 38 — Knowledge

_(no speaker notes)_

## Slide 39 — TODO

**On-slide text:** See notes

**Speaker notes:**

Slide 1 — Knowledge: die zwei Richtungen (Kapitel-Landkarte)
Screenshot: Als einzige Folie ohne UI-Screenshot — ein schlichtes Konzept-Schaubild mit drei Kacheln nebeneinander: Skills (provisioned ↓) │ Memory → Shared Knowledge (learned ↑) │ Autonomy (der Regler). (Wenn du doch einen Screenshot willst: die Kopfzeile der Knowledge-Seite als Establishing-Shot.)
Speaker text:
▎ In every demo so far the agents reacted — to a message, to a label, to an event. What we haven't looked at yet is why they get better over time instead of starting every task from a blank slate. That's Knowledge.
▎
▎ Knowledge in the Agent Studio flows in two directions. Top-down, there's the knowledge you provision — curated capability packs we call Skills. And bottom-up, there's the knowledge the agents build themselves — the lessons they accumulate in memory and pool into shared team knowledge. Sitting above that bottom-up loop is a single dial — Autonomy — that decides how much of it happens on its own versus with a human in the loop. Those are the three things I'll show in this chapter: Skills, Memory-into-shared-knowledge, and the Autonomy dial that governs it.

## Slide 40 — TODO

**On-slide text:** See notes

**Speaker notes:**

Slide 2 — Skills: Wissen, das du bereitstellst (top-down)
Screenshot: Linke Navigation → Skills Registry (/skills). Die Liste mit Spalten und den Global/Team-Tier-Badges im Bild; idealerweise mit ein paar Domänen-Skills sichtbar. Optional das Promote to global / New skill-Element mit drauf.
Speaker text:
▎ Let's start with the top-down half — the knowledge you give the agents. This is the Skills Registry. A skill is a curated capability pack: a self-contained set of instructions and references for a specific domain task — think COBOL analysis, JCL conversion, DB2 schema mapping, the kind of expertise this platform is built for.
▎
▎ Skills live on two tiers, and you can see both here: a Global pool shared by every team, and Team skills that belong to one team only. When an agent is seeded, the platform resolves them team-first, then global — so a team can specialise without affecting anyone else. You grant skills to a team or an agent, activate them, and from that point the agents read them on every run. The important framing: this is deliberate, authored knowledge — you decide what expertise the team starts with. The other half of the chapter is what the agents add to that on their own.

## Slide 41 — TODO

**On-slide text:** See notes

**Speaker notes:**

Slide 3 — Memory: Wissen, das Agenten selbst aufbauen (bottom-up)
Screenshot: Agent Chat → einen Agenten öffnen (z. B. den Business Analyst aus der Demo) → rechte Leiste Workspace-Tab → Ordner memory/ aufklappen und eine Datei wie log.md oder context.md im Viewer offen zeigen. (Alternative: der Knowledge-Tab im Agent-Chat mit einem grünen digest-Badge — den heben wir uns aber besser für Slide 4 auf.)
Speaker text:
▎ Now the bottom-up half — and this is the heart of the "agents get better" promise. Every agent keeps its own memory, right here in its workspace. You can browse it: an episodic record of what's happening, a running log of past conversations, per-user notes on who it's working with. When an agent finishes a task, it distills durable lessons — a build quirk, a project convention, a decision it shouldn't have to relearn — and writes them here. Next time it runs, it reads them first.
▎
▎ One principle worth calling out, because it's a hard rule in this platform: memory is transparent. It's not a hidden vector store or an opaque background channel — it's a real, current, browsable file in the agent's workspace. What the agent knows, you can read. So far this is private to each agent. The magic happens when we let agents pool it.

## Slide 42 — TODO

**On-slide text:** See notes

**Speaker notes:**

Slide 4 — Vom Ich zum Team: geteiltes Wissen + garantierter Kontext
Screenshot: Linke Navigation → Knowledge (/knowledge), ein Team auswählen (z. B. Agentic Demos). Den Graph/Liste so einfangen, dass man ein konvergiertes Item sieht (Badge „N× independent") und ein grünes „digest"-Badge. Wenn ein Item „2× independent" von zwei Agenten zeigt, ist das der ideale Frame.
Speaker text:
▎ Here's where individual learning becomes team capital. This is the team's shared knowledge base. When one agent records a lesson, it's pooled here for the whole team — but the platform is careful about what it trusts. Notice this marker: learned independently by two agents. That's convergence — when several agents arrive at the same lesson on their own, it's a strong signal that it's actually true and important, not a one-off. Converged knowledge is what the platform treats as promotable.
▎
▎ And the second thing on this screen — the green digest badge. Reading knowledge on demand is fine, but the best lessons shouldn't depend on the agent remembering to look them up. So the platform builds a knowledge digest: the team's key conventions and converged lessons, injected into every agent's context at session start, guaranteed, with no tool call required. The badge tells you which items are guaranteed-in-context versus the searchable long tail. So an agent doesn't just have access to team knowledge — the most important parts are already in front of it before it reads a single message.

## Slide 43 — TODO

**On-slide text:** See notes

**Speaker notes:**

Slide 5 — Der Autonomy-Regler: wie der Lernkreis schließt
Screenshot: Weiterhin die Knowledge-Seite (/knowledge), aber der Bereich mit dem Autonomy-Regler (die vier Stufen Off · Share · Suggest · Auto-curate), den Skill-Karten mit Activate/Deactivate-Status und dem Live-Feed. Idealerweise Regler auf einer aussagekräftigen Stufe (z. B. 2 Suggest oder 3 Auto-curate), damit man Vorschläge/Aktivierungen sieht.
Speaker text:
▎ The last piece is governance — how much of this loop closes without you. That's this Autonomy dial, and it has four settings. At Off, agents keep lessons to themselves. At Share, they pool everything into the shared knowledge you just saw. At Suggest, the platform goes further — whenever knowledge converges, it proposes turning it into a reusable skill, and you confirm each one. And at Auto-curate, the team promotes converged knowledge into team skills on its own, within guardrails you set.
▎
▎ The full lifecycle runs learn → converge → promote → activate: an agent learns something, several agents converge on it, it's bundled into a skill, promoted, and activated so every member picks it up. The dial decides where a human sits in that chain. And there's one line that never moves: promoting a skill to the global pool — making it available to every team — always waits for your review; it can't be automated. Everything is logged in this live feed as it happens, so even at full autonomy it's transparent. That's the whole idea of Knowledge here: you provision the starting expertise, the agents grow it through use, and you hold the dial that decides how independently they do it.

## Slide 44 — App Modernization

_(no speaker notes)_

## Slide 45 — (no title text)

_(no speaker notes)_

## Slide 46 — Model Provider

_(no speaker notes)_

## Slide 47 — (no title text)

_(no speaker notes)_

## Slide 48 — Git and GitHub

_(no speaker notes)_

## Slide 49 — (no title text)

_(no speaker notes)_

## Slide 50 — Token Usage

_(no speaker notes)_

## Slide 51 — (no title text)

_(no speaker notes)_

## Slide 52 — Maintenance Mode

_(no speaker notes)_

## Slide 53 — (no title text)

_(no speaker notes)_

## Slide 54 — Technical Deep Dive

_(no speaker notes)_
