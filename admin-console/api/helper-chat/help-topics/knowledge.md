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
  - "Who is allowed to change a team's learning settings?"
---

## Memory vs Knowledge vs Skills

Three different things, easy to mix up:

- **Memory** — what *one agent* privately remembers: its own episodic notebook,
  not shared with anyone.
- **Knowledge** — lessons *shared across the team*, so every agent benefits from
  what any one of them learned. That is what this page shows.
- **Skills** — polished, reusable instruction files agents load automatically,
  often distilled from the best knowledge.

The page reads left to right along exactly that path: **Agents** record lessons,
**Team knowledge** pools them, **Skills** are what the best of them turn into.
The *Flow* view shows those three columns; the *Table* view shows the same
knowledge as one row per lesson with bulk actions, for when you want to read or
tidy a large base rather than follow the flow.

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

Every lesson keeps its provenance: which agent recorded it, in which session,
off which pull request. Selecting a card opens that lineage, which is how you
judge a lesson you did not watch being learned.

## The per-agent digest, and what stays searchable

A team's knowledge base quickly grows past what fits in any agent's context, so
the platform splits it in two.

The **digest** is the guaranteed half. Every agent workspace carries a generated
`knowledge-digest.md` that the agent's instruction file imports, so those entries
are in context from the first word of every session — that is what the green
`digest` badge on a lesson means. The selection is deterministic, with no model
in the loop: all **conventions** first, then **converged** entries (learned
independently more than once), then the most recent ones, until a fixed token
budget is full.

Everything past that budget is the searchable half: still there, still usable,
reached on demand when an agent searches the knowledge base for a topic. Nothing
is lost by falling outside the digest — it is a priority order, not a filter.

Three kinds of entry never reach either half: retired ones, entries superseded by
a merge, and entries still waiting in the review queue. A lesson given a validity
date also drops out of the digest by itself once that date has passed, without
anyone retiring it.

## Autonomy, Review and the promotion gates

Each team carries its own learning settings, in the **Configure knowledge** panel
on this page and in the Knowledge step of the Agent Team wizard. The strip above
the columns always shows the values that are live right now, so you can read a
team's posture without opening anything. Changes save immediately; running agents
pick them up at their next rebuild.

These settings are **not restricted to team admins**: anyone who can see a team
on this page can also change how it learns. The server checks that you have
access to the team and nothing more. Treat the autonomy level as a shared team
setting rather than an administrative one.

### Autonomy — how much may happen without you

| Level | Label | What it means |
|---|---|---|
| **0** | Off | Each agent keeps what it learns in its own private memory. Nothing enters the shared team knowledge base. |
| **1** | Share | Every lesson an agent records is shared with the whole team, so all agents benefit from it. Nothing is turned into a skill automatically. |
| **2** | Suggest | Like *Share* — and when several agents learn the same thing independently, you get a suggestion to turn it into a reusable skill. Nothing happens without your confirmation. |
| **3** | Auto-curate | The team curates itself: knowledge several agents converged on becomes a team skill automatically — but only where the promotion gates allow it. Promotion to the global pool always waits for your review. |

You can change the level at any time, and a higher level never bypasses the
gates. A brand-new team starts at **1 · Share**. Lowering the level later stops
further sharing or curation; it does not withdraw what the team already knows.

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

## Power tools: domains, consolidate and distill

Once a team has a lot of knowledge you can shape it. These are optional, they
live in the Skills column, and nothing any of them produces is applied without
your review.

- **Domains** — the themes this team's lessons cluster into, e.g. *JCL
  conversion* or *DB2 migration*. Domains are the buckets that consolidation
  folds the team's many small skills into, so routing stays tidy as knowledge
  grows. Changing them is always a human decision: seed the defaults, or let the
  model *propose* a set over the team's lessons that you confirm first. The panel
  also tracks the team's soft skill budget, so you can see when a base is
  drifting towards too many overlapping skills — which is the signal to
  consolidate.
- **Consolidate** — fold the many small skills of one domain into a single
  **playbook**: one well-structured skill replacing a scattered set. It needs the
  team's domains confirmed first, because the domains *are* the folding buckets,
  and it walks the domains one at a time so you accept or skip each playbook
  individually. Whatever is not folded is routed, not discarded.
- **Distill** — rewrite one skill to remove duplication and tighten it. It shows
  the current and re-synthesised versions side by side and only replaces the
  skill once you apply that diff.

The three are a sequence more often than a choice: domains first, then
consolidation to collapse the long tail into playbooks, then distillation to keep
an individual playbook readable as it accumulates.

## Configuration: forgetting, assist model and storage

The **Configure knowledge** panel holds three more per-team settings underneath
the learning ladder.

### Forgetting

Optionally, lessons nobody has used for a while are **proposed** for retirement
in the skills inbox. A lesson counts as used whenever an agent's search returns
it or a digest inlines it, so the conventions the team lives off are never
proposed. The horizon is off, 30, 60 (the default) or 90 days. Nothing is
archived automatically, and nothing is deleted silently — retired knowledge stays
in git for audit and can be un-retired at any time. Confirming a proposal runs
exactly the same reversible archive as the manual Retire button, at every
autonomy level, because retiring a lesson destroys context while promotion only
ever adds.

### Assist model

Which registered **Model Provider** this team's *autonomous* synthesis is billed
against — the curator promoting converged lessons into a skill, and skill
distillation. Those runs have no person driving them, so they cannot use the
per-user model picker in the header; the choice is derived from the team instead.
Left unset, they use the platform default from the environment. Seats that
authenticate with an OAuth token are never offered here, because that path is not
billable; if the team has no selectable provider at all, synthesis quietly uses
the platform default.

### Storage

Where the team's shared knowledge base is kept: on a dedicated branch of the
repository the team already uses, or in a separate knowledge repository of its
own. The agents, the digest and every push follow this setting. A separate
repository is probed for reachability and access *before* the change is saved, so
an unreachable or unauthorised target is rejected rather than persisted. Pointing
a team at a protected branch is flagged as a warning, because pushes to it may be
rejected. Changing the location never moves knowledge already stored at the old
one — the team starts building fresh at the new location, and the old contents
stay where they are.
