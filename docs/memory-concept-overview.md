# Agentic Memory in Agent Studio — Concept Overview

Agent Studio implements a layered memory architecture that spans a single agent's private recollection, a team's
shared knowledge base, and an organization-wide library of distilled skills. Each
layer has a distinct job and a distinct lifetime, and knowledge is deliberately
promoted **upward** from the specific and private to the general and shared.

## 1. Local (episodic) memory — private to one agent

Every agent workspace carries a small set of markdown memory files it reads and
writes each turn:

- `context.md` — active session state (kept slim),
- `log.md` — one-line summaries of past conversations,
- `users.md` — per-person interaction profiles (language, role, preferences).

This layer is **episodic and agent-private**. `users.md` in particular is personal
data and is *never* shared or migrated. It answers "what is happening right now and
what happened before" for this one agent.

## 2. Team knowledge base — shared semantic memory

Durable, *semantic* knowledge — atomic **facts**, **entities** (systems,
frameworks, repos) and **conventions** ("this is how we do things here") — does not
live in an agent's private files. It is written into a **team-shared knowledge base
(KB)**, a git-backed store on a dedicated `agent-knowledge` branch, one canonical
clone per team. When any agent learns something durable, it runs `knowledge add`,
which pushes the entry with full **provenance**: origin agent, session correlation
id, and the PR/issue/commit it came from. The whole team draws from one store
instead of each agent hoarding its own copy.

Crucially, knowledge is **guaranteed to be in context, not merely searchable**. A
deterministic, token-budgeted **`knowledge-digest.md`** is generated into every
agent's workspace and `@`-imported by its `CLAUDE.md`, so Claude Code inlines it
unconditionally at session start — conventions first, then validated and recent
entries. It is rebuilt before every invocation (so even per-invocation agents see
the current team state) and whenever the team's KB changes (so a human browsing the
workspace always sees the truth). Search (`knowledge search`) is the long-tail
complement for everything beyond the digest budget. Nothing lives in a hidden
server-side prompt — *what the agent knows equals what the workspace shows*.

## 3. Sharing within a team — convergence

Because every member writes to the same store with provenance, the system can
detect **convergence**: when two or more distinct agents independently learn a
similar lesson, that entry is marked as validated ("3× independent"). Convergence is
the confidence signal — evidence weight — that separates a one-off observation from a
genuine team practice. The whole flow is observable on a **Knowledge Flow** view
(Agent → Team → Global lanes) with a live feed of harvests and drill-down into the
lineage of any entry.

## 4. Autonomous aggregation into skills — and redistribution

The top layer is **skills**: not promoted single lessons, but **domain playbooks** —
few, stable, structured documents that teach a *practice* (its flow, rules, gotchas
and examples), spanning roles where a single digest bullet cannot. A team keeps a
small list of persistent **domains**; as converged lessons accumulate, the system
**routes** them — most stay digest-only, related ones become **amendments** to an
existing skill, and only genuine new mass proposes a new domain. At higher autonomy
levels the curator can **auto-extend** existing skills (gated by review), and a
periodic **distillation** pass re-synthesizes a skill from its accumulated evidence
to keep it coherent. Every write runs real LLM synthesis, never a bullet dump, and
never drops the provenance links back to the contributing lessons.

Finally, a matured team skill can be **promoted to the global pool**, making a practice learned by one squad available — and
grantable — to every team in the organization. That closes the loop: a lesson learned
by a single agent on a single ticket can, through convergence and distillation,
become organization-wide knowledge, while personal and session state stays private
where it belongs.