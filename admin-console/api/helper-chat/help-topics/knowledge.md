---
id: knowledge
routes: ["/knowledge"]
title: Knowledge
summary: Watch what your agents learn become shared team knowledge — and decide how much of it turns into reusable skills on its own.
seeAlso:
  - { label: "Agents", to: "/agents" }
  - { label: "Skills", to: "/skills" }
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Agent Team Wizard", to: "/team-setup" }
  - { label: "Flows", to: "/flows" }
askPrompts:
  - "How does something an agent learned become a skill?"
  - "What is the difference between Memory, Knowledge and Skills?"
  - "Which autonomy level should I pick for my team?"
  - "What does converged knowledge mean?"
  - "When do the promotion gates actually apply?"
  - "What are domains, consolidate and distill for?"
  - "Why does an agent show a green digest badge?"
---

## Memory vs Knowledge vs Skills

Three different things, easy to mix up:

- **Memory** — what *one agent* privately remembers: its own episodic notebook,
  not shared with anyone.
- **Knowledge** — lessons *shared across the team*, so every agent benefits from
  what any one of them learned. That is what this page shows.
- **Skills** — polished, reusable instruction files agents load automatically,
  often distilled from the best knowledge.

## How learning works, in three steps

**1 · Agents learn while they work.** At the end of a work session each agent
writes down the durable lessons it learned. Every lesson is one of three kinds:

| Kind | What it is |
|---|---|
| **Fact** | Something an agent found to be true about the project or its tools (e.g. *the build needs Node 22*). |
| **Entity** | A named thing — a system, repo, service, person — and what the team knows about it. |
| **Convention** | How the team does things: processes, labels, rituals (e.g. *PRs need the ready-for-review label*). |

**2 · Lessons become team knowledge.** They flow into the team's shared
knowledge base, where every agent can use them. When several agents learn the
same thing *independently*, it is marked **converged** — a strong signal that it
is both true and important.

**3 · The best knowledge becomes skills.** Knowledge can be **promoted to a
skill**: a reusable instruction file agents load automatically. A skill is often
a *combination* of related lessons — the system suggests such bundles, and you
can also tick several lessons yourself and combine them. You review every
promotion, unless you let the team curate itself (autonomy 3, below).

## The most important lessons are always in context

Each agent gets a per-agent **digest** — the top knowledge, guaranteed to be
loaded every session (that is the green `digest` badge on an agent) — while
everything else stays reachable on demand via search.

## Shaping a large knowledge base

Once a team has a lot of knowledge you can shape it. These are optional power
tools, and nothing is applied without your review:

- **Domains** — the themes this team's lessons cluster into, e.g. *JCL
  conversion* or *DB2 migration*. Domains are the buckets that consolidation
  folds the team's many small skills into, so routing stays tidy as knowledge
  grows. Changing them is always a human decision: seed the defaults, or let AI
  propose a set you review first.
- **Consolidate** — fold the many small skills of one domain into a single
  **playbook**.
- **Distill** — rewrite one skill to remove duplication and tighten it.

## You stay in control

Each team carries three learning settings (the **Configure** panel here, and the
Knowledge step of the Agent Team wizard).

### Autonomy — how much may happen without you

| Level | Label | What it means |
|---|---|---|
| **0** | Off | Each agent keeps what it learns in its own private memory. Nothing enters the shared team knowledge base. |
| **1** | Share | Every lesson an agent records is shared with the whole team, so all agents benefit from it. Nothing is turned into a skill automatically. |
| **2** | Suggest | Like *Share* — and when several agents learn the same thing independently, you get a suggestion to turn it into a reusable skill. Nothing happens without your confirmation. |
| **3** | Auto-curate | The team curates itself: knowledge several agents converged on becomes a team skill automatically — but only where the promotion gates allow it. Promotion to the global pool always waits for your review. |

You can change the level at any time, and a higher level never bypasses the
gates. A brand-new team starts at **1 · Share**.

### Review — approve each lesson before it is shared

When Review is **on**, every new lesson is held in a review queue until you
approve it. When **off** (the default), lessons are shared as soon as an agent
records them — you can still retire any of them later. Review needs autonomy 1
or higher: at level 0 nothing is shared in the first place, so it is unavailable.

### Promotion gates — which promotion steps may run on their own

Each gate decides whether that step runs automatically or waits for you:

| Gate | What it covers |
|---|---|
| **Knowledge → team skill** | Converged team knowledge becoming a team skill. |
| **Agent skill → team skill** | A skill one agent authored for itself becoming a team skill. |
| **Team skill → all teams** | A team skill becoming available to every team. This step **always** waits for your review and cannot be set to automatic. |

Gates only take effect at autonomy 3 (Auto-curate) — at lower levels every
promotion waits for you anyway.

### Forgetting

Optionally, lessons nobody has used for a while are **proposed** for retirement
in the skills inbox. A lesson counts as used whenever an agent's search returns
it or a digest inlines it, so the conventions the team lives off are never
proposed. Nothing is archived automatically, and nothing is deleted silently —
retired knowledge stays in git for audit and can be un-retired at any time.
