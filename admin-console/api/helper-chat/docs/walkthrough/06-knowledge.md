# Knowledge

> Status: speaker text final; screenshots described but not yet taken (deck slides 39–43 are TODO frames).

## Chapter intro — the two directions (slide 39)

Screenshot: the only beat without a UI screenshot — a simple concept diagram with three tiles side by side: Skills (provisioned ↓) │ Memory → Shared Knowledge (learned ↑) │ Autonomy (the dial). (Alternative: the Knowledge page header as an establishing shot.)

In every demo so far the agents reacted — to a message, to a label, to an event. What we haven't looked at yet is why they get better over time instead of starting every task from a blank slate. That's Knowledge.

Knowledge in the Agent Studio flows in two directions. Top-down, there's the knowledge you provision — curated capability packs we call Skills. And bottom-up, there's the knowledge the agents build themselves — the lessons they accumulate in memory and pool into shared team knowledge. Sitting above that bottom-up loop is a single dial — Autonomy — that decides how much of it happens on its own versus with a human in the loop. Those are the three things I'll show in this chapter: Skills, Memory-into-shared-knowledge, and the Autonomy dial that governs it.

## Skills: knowledge you provision (top-down) (slide 40)

Screenshot: left navigation → Skills Registry (`/skills`). The list with its columns and the Global/Team tier badges; ideally a few domain skills visible. Optionally the Promote-to-global / New-skill element in frame.

Let's start with the top-down half — the knowledge you give the agents. This is the Skills Registry. A skill is a curated capability pack: a self-contained set of instructions and references for a specific domain task — think COBOL analysis, JCL conversion, DB2 schema mapping, the kind of expertise this platform is built for.

Skills live on two tiers, and you can see both here: a Global pool shared by every team, and Team skills that belong to one team only. When an agent is seeded, the platform resolves them team-first, then global — so a team can specialise without affecting anyone else. You grant skills to a team or an agent, activate them, and from that point the agents read them on every run. The important framing: this is deliberate, authored knowledge — you decide what expertise the team starts with. The other half of the chapter is what the agents add to that on their own.

## Memory: knowledge agents build (bottom-up) (slide 41)

Screenshot: Agent Chat → open an agent (e.g. the Business Analyst from the demo) → right rail Workspace tab → expand the `memory/` folder and show a file like `log.md` or `context.md` open in the viewer.

Now the bottom-up half — and this is the heart of the "agents get better" promise. Every agent keeps its own memory, right here in its workspace. You can browse it: an episodic record of what's happening, a running log of past conversations, per-user notes on who it's working with. When an agent finishes a task, it distills durable lessons — a build quirk, a project convention, a decision it shouldn't have to relearn — and writes them here. Next time it runs, it reads them first.

One principle worth calling out, because it's a hard rule in this platform: memory is transparent. It's not a hidden vector store or an opaque background channel — it's a real, current, browsable file in the agent's workspace. What the agent knows, you can read. So far this is private to each agent. The magic happens when we let agents pool it.

## From me to the team: shared knowledge + guaranteed context (slide 42)

Screenshot: left navigation → Knowledge (`/knowledge`), select a team (e.g. Agentic Demos). Frame the graph/list so one converged item is visible (badge "N× independent") and a green "digest" badge. An item showing "2× independent" from two agents is the ideal frame.

Here's where individual learning becomes team capital. This is the team's shared knowledge base. When one agent records a lesson, it's pooled here for the whole team — but the platform is careful about what it trusts. Notice this marker: learned independently by two agents. That's convergence — when several agents arrive at the same lesson on their own, it's a strong signal that it's actually true and important, not a one-off. Converged knowledge is what the platform treats as promotable.

And the second thing on this screen — the green digest badge. Reading knowledge on demand is fine, but the best lessons shouldn't depend on the agent remembering to look them up. So the platform builds a knowledge digest: the team's key conventions and converged lessons, injected into every agent's context at session start, guaranteed, with no tool call required. The badge tells you which items are guaranteed-in-context versus the searchable long tail. So an agent doesn't just have access to team knowledge — the most important parts are already in front of it before it reads a single message.

## The Autonomy dial: closing the learning loop (slide 43)

Screenshot: still the Knowledge page (`/knowledge`), but the area with the Autonomy dial (the four levels Off · Share · Suggest · Auto-curate), the skill cards with Activate/Deactivate state and the live feed. Ideally the dial on a meaningful level (e.g. 2 Suggest or 3 Auto-curate) so proposals/activations are visible.

The last piece is governance — how much of this loop closes without you. That's this Autonomy dial, and it has four settings. At Off, agents keep lessons to themselves. At Share, they pool everything into the shared knowledge you just saw. At Suggest, the platform goes further — whenever knowledge converges, it proposes turning it into a reusable skill, and you confirm each one. And at Auto-curate, the team promotes converged knowledge into team skills on its own, within guardrails you set.

The full lifecycle runs learn → converge → promote → activate: an agent learns something, several agents converge on it, it's bundled into a skill, promoted, and activated so every member picks it up. The dial decides where a human sits in that chain. And there's one line that never moves: promoting a skill to the global pool — making it available to every team — always waits for your review; it can't be automated. Everything is logged in this live feed as it happens, so even at full autonomy it's transparent. That's the whole idea of Knowledge here: you provision the starting expertise, the agents grow it through use, and you hold the dial that decides how independently they do it.
