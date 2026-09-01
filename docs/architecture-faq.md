# Architecture & technical FAQ

Deep technical questions about how Agent Studio works under the hood — context and
knowledge management, state durability, cost/model governance, and integration.

These answers came out of a real architecture Q&A with a team evaluating the platform
for a target architecture. They go deliberately deep; each answer is meant to give
enough context to understand *why* the platform is built the way it is, not just *what*
it does. For a broader overview start with the [root README](../README.md) and the
[Glossary](glossary.md); for the team-operations angle see the
[Collaboration-mode FAQ](collaboration-mode-faq.md).

---

## Context & Knowledge Management

### How is context managed / passed to agents? Whole repo or chunking?

Each agent runs the Claude Code CLI in its own container, with the relevant repositories
git-cloned into its workspace. Repository content is **not** chunked, embedded, or
pre-loaded. Instead the agent reads the codebase **just-in-time** via native agentic
tools (Grep / Glob / Read / Bash). It navigates the working tree the way a developer
would and pulls only the files it needs into context.

This is the deliberate, Anthropic-recommended approach, not a shortcut. Anthropic's own
guidance is to start with agentic search and only add semantic search (embeddings) if you
specifically need it, because *"semantic search is usually faster than agentic search,
but less accurate, more difficult to maintain, and less transparent"*
([Building agents with the Claude Agent SDK][sdk]). The companion guidance describes
exactly our model: agents *"maintain lightweight identifiers (file paths, stored queries,
web links, etc.) and use these references to dynamically load data into context at runtime
using tools"* — bypassing the staleness and maintenance cost of pre-built indexes
([Effective context engineering for AI agents][ctx]).

The only things injected up-front at session start are small and fixed: the agent's system
prompt (`CLAUDE.md` + role prompt), its granted skills, and a compact team-knowledge
digest (see below). Within a chat, context continuity is preserved via the CLI's session
resume; autonomous/triggered runs deliberately start with a fresh context each time.

### How is knowledge managed and read? How are SDLC-phase documents read?

Two distinct layers. **(a) Skills** are versioned Markdown documents (`SKILL.md`) encoding
domain/SDLC-phase know-how (e.g. COBOL, JCL, DB2 conventions, review checklists). They are
granted per agent, seeded as files into the workspace, and read agentically when relevant —
the SDLC-phase guidance an agent follows is a granted skill. **(b) A shared, git-backed
team Knowledge Base** captures durable lessons (facts, entities, conventions) that agents
harvest during work.

The KB is surfaced two ways: a deterministically generated `knowledge-digest.md` is
guaranteed into every session's context via a native `@`-import (highest-value conventions
+ validated/recent lessons, ~3k-token budget), so key knowledge is present at session start
with no tool call needed; the long tail is reachable through an offline `knowledge search`
CLI over the synced team KB. Knowledge is team-scoped and shared via git — the same
just-in-time philosophy as code: guaranteed-inject the essentials, retrieve the rest on
demand.

### Technologies/approaches for code knowledge graphs? Individual and cross-repo coverage?

The platform builds **no** code knowledge graph — no AST/symbol index, no call/dependency
graph, no code embeddings. Code comprehension is Claude Code's native agentic search over
the cloned working tree (see above). This is a deliberate design choice; Anthropic's own
guidance recommends agentic search over embeddings/indexes.

**Cross-repo *is* supported — via multi-repo workspaces, not via a graph.** A Working
Environment declares a list of repositories (0..n), each with its own branch, SSH key/PAT,
and an optional per-repo read-only flag. At agent creation the orchestrator clones every
repo side-by-side into the agent's workspace (one sub-directory per repo; a per-environment
clone cache avoids repeated network round-trips). Repos can also be added to already-running
agents on the fly via *Sync repositories* (no respawn). A read-only repo is still cloned
but annotated *"reference-only — do not commit or push"* in the agent's context, so it
serves as a reference/dependency source without being a write target.

The effect: an agent given several repos can grep/read across all of them in one working
tree, so cross-repository relationships, dependencies, and mappings are discovered
just-in-time across the multiple clones rather than precomputed in a graph. Coverage is
whatever repos you attach to the environment.

If a dedicated knowledge graph is genuinely wanted, it plugs in through the open plugin
system (any KG implementation → a governed broker + a CLI facade the granted agents can
call; an MCP server is a lighter read-only route). Our take: we've repeatedly evaluated
code-KG systems and haven't yet found one whose benefit justifies going beyond agentic
multi-repo search — but nothing prevents a permanent plugin-based integration if you have
one that works well, while the base platform stays deliberately simple.

---

## State Management & Durability

### Are the SDLC flows durable? What engine persists state and manages transitions?

There is **no** separate workflow/state-machine engine and no database. The design is
deliberately lightweight: the flow state lives in GitHub itself (issue/PR labels), and the
platform reacts to label/event changes. Each agent holds a durable set of subscriptions
(e.g. "wake me when a PR gets label X") on a persistent volume, and a GitHub-Events poller
drives the transitions. A label lifecycle (`ready` → `in-progress` → `completed`) makes
each hand-off explicit and visible directly on GitHub.

This is durable across container restarts and redeploys: because the authoritative flow
state is on GitHub and the subscriptions/work-queue are persisted, work resumes after an
interruption. The honest guarantee is **at-least-once with visible recovery** — an
interrupted run is detected and flagged to a human rather than silently replayed. It is
intentionally *not* an exactly-once durable-execution engine; correctness rests on the
label conventions plus persisted queues, which keeps the system simple and transparent
(you can read the entire flow state on GitHub).

### How is agent memory handled, at what level, and what persistence/retrieval mechanisms?

Two levels. **Private, per-agent memory** holds episodic/session context (running notes,
conversation log, per-person interaction profiles) on the agent's own persistent storage;
personal-profile data is never shared. **Shared, team-level knowledge** (facts, entities,
conventions) lives in a git-backed team Knowledge Base, versioned and synced across the
team's agents.

Retrieval is dual (same philosophy as code): the highest-value knowledge is guaranteed
into context at session start via an auto-generated, always-injected digest, and the long
tail is retrieved on demand through a knowledge-search command. So memory persists at both
the individual and team level, with the team KB as the durable, shared system of record.

### Can a workflow idle until a human finishes / discusses a decision, for how long, and resume?

**Yes — indefinitely.** A human-approval gate is simply a durable subscription waiting for
the human's decision (expressed as a label on the relevant issue/PR). While waiting, no
process is running and no context/tokens are consumed — the agent isn't blocked, it just
has a standing subscription. There is no approval-expiry timer: the human can deliberate
for minutes, days, or weeks.

When the human applies the decision, that event is picked up and the flow resumes
automatically, with the label transition making the resumed work visible and idempotent.
Queued work also survives platform restarts and planned maintenance (with a single
catch-up afterwards). In short: long human-in-the-loop pauses are a first-class, durable
state, and resumption needs no manual re-priming.

---

## Cost Control & Model Governance

### Dynamic model routing based on prompt intent?

Not as a built-in intent-based router. Model choice is explicit and operator-controlled via
a clear hierarchy: per-provider default → per-Working-Environment binding → optional
per-agent override. Because the platform talks to any Anthropic-Messages-API-compatible
endpoint (LiteLLM proxy, enterprise gateway, …), intent-based routing can be added at the
proxy layer today.

More fundamentally: Agent Studio is an **accelerator, not a closed product**. You get the
source code and can extend it — if stronger, intent-driven model routing is a requirement
in your environment, it is a natural extension rather than something you have to wait for
us to ship. We don't aim to bake every feature into the core for passive consumption; we
aim to give you a base you understand and can build on.

### Token spend limits for agents/workflows (control spend / rogue agents)?

Out of the box there is no hard spend cap; the product reports token counts, not dollars.
What exists today: **loop budgets** (optional max-tokens, required max-iterations — a clean
stop), a **runaway backstop** (a concurrency/spawn-rate brake against self-triggering
agents), and **full token observability** (four token classes per
agent/team/model/provider/day, plus issue↔PR work-item attribution). So the story is strong
visibility + loop guardrails + a safety net, not an enforced ceiling.

Two points on direction:

- **It's extensible by design** — a hard budget ceiling sits naturally on top of the
  existing telemetry (or at the gateway that meters the API keys); with source access you
  can enforce exactly the policy you need.
- **This is already happening.** In a current customer project we're building governance
  extensions including budgets — likely person-based. Other teams share these same
  questions, and parts of those solutions are being fed back into the core project, so
  budget enforcement is on the trajectory rather than hypothetical.

---

## Integration & Extensibility

### Have you used the platform's capabilities (agents, skills) outside the frontend portal — e.g. IDE-level coding assistants via MCP, APIs, or other integration?

The building blocks are standards-based and portable by design, precisely because Agent
Studio is an accelerator rather than a closed portal. Under the hood the agents are the
Claude Code CLI / Claude Agent SDK, skills are plain Markdown files, and external data is
reached through MCP servers and the plugin system — all open standards. Concretely:

- **Skills are not portal-locked.** A `SKILL.md` (e.g. a COBOL/JCL/DB2 convention set) can
  be dropped straight into a developer's local Claude Code / IDE setup and used there, with
  no dependency on the portal.
- **MCP servers and plugin CLIs are reusable.** The MCP integrations we build are
  standalone and work in any MCP-capable client (VS Code, JetBrains, etc.), not only inside
  our agents.
- **What the portal adds on top** is the orchestration and governance layer — multi-agent
  SDLC flows, teams, credential isolation, audit, token telemetry. That's the value beyond
  a single IDE assistant, and it's where an individual IDE tool stops.

So the direction of integration is inbound-first (agents consume MCP/plugins). There is
currently no packaged outbound API that exposes Agent-Studio agents to an external IDE as a
service — the control-plane APIs are internal — but because you get the source code, wiring
such an integration (or an MCP facade over the orchestrator) is a supported extension, not
a blocker. In short: the components already live comfortably outside the portal; the portal
is the governed assembly of them.

---

[sdk]: https://claude.com/blog/building-agents-with-the-claude-agent-sdk
[ctx]: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
