# Shared Agent Learning & Knowledge Flow — Implementation Plan

Status: **concept / plan of record**. This document describes how independently-learning
agents pool what they learn into shared, curated, distributable knowledge, and how that
flow is made **visible and traceable** in the Admin Console.

## Problem

Today every agent keeps a private, file-based memory (`memory/{context,log,facts,entities,users}.md`,
see `persistent-memory.md`), isolated per agent by the SubPath workspace mount. Agents that work
the same repo therefore **re-learn the same things independently**. Observed live: three `team-member`
developers in one team each recorded the *same* environment facts (the `npm install` permission wall,
the GitHub Events API ordering guarantee, "the live runtime is the Python entrypoint", "this repo tests
pure helper cores only", the branch-from-`origin/main` pattern). That duplicated effort is invisible to
the operator, so nobody can see that the agents are learning at all.

## Goal

1. **Share** durable knowledge across a team, in **real time** (queryable mid-run) and by **harvesting
   after every session** — both are must-haves.
2. Grow local memory → shared knowledge → **curated, versioned, packageable Skills** that are reusable
   across systems (skills are the preferred end-state artifact).
3. Make the whole flow **transparent and traceable** through **dedicated UI** at every level — this is a
   product/marketing promise ("yes, the agents learn — here is that happening across the levels"),
   not a file browser.
4. Run **mostly automatically**, event-driven (not on a weekly cron), with well-prepared one-click
   suggestions at the few points that need a human. Automation must be toggleable.

## The maturity ladder (backbone)

Knowledge flows up three rungs; **each rung is an existing system primitive**, so we extend rather
than invent.

| Tier | What | Existing primitive | Visibility |
|---|---|---|---|
| **T0 Memory** | private, episodic, per agent | `memory/*.md` (`persistent-memory.md`) | that agent |
| **T1 Team Knowledge Base (KB)** | shared facts/entities, git-backed markdown, real-time queryable | git ("the only durable bridge is git") | the team |
| **T2 Skill** | curated, versioned, packaged, reusable | two-tier skill pool + promotion (`skills-system.md`, #173/#306) | team → global → other systems |

```
T0 memory/*.md   ──harvest──▶  T1 Team-KB (git)  ──promote──▶  T2 Skill
 (agent, private)  (after every     (team-default,     (curated, versioned)
                    session)         real-time query)         │
                                            promote(from→to) ──┴── Agent → Team → Global
```

### Three-tier skill pool (Agent / Team / Global)

The existing pool is two tiers resolved **team-first, then global**. We add the private **Agent** tier
below, mirroring T0 memory (which is already agent-private), and generalise the documented
`promote-to-global` into `promote(from-tier → to-tier)`:

| Tier | Path (parallels today) | Scope | For |
|---|---|---|---|
| **Agent** | `/workspace/agents/<id>/skills/` | that agent only | personal specialisation not (yet) team-ready |
| **Team** *(exists)* | `/workspace/teams/<teamId>/skills/` | the team | **the normal home** — knowledge is team-specific |
| **Global** *(exists)* | `/template-workspace/skills/` | all teams | broadly reusable, proven knowledge |

Resolution at seed time: **agent → team → global**, most specific wins (a pure extension of
`orchestrator/skill-source.js`'s `makeSkillSourceResolver`). Knowledge is team-specific by default, so
the **KB (T1) is team-scoped** and promoted skills default to the **Team** tier. The Agent tier is the
exception downward (keep private); `promote-to-team` lifts it up, `promote-to-global` (exists) lifts
Team → Global.

## Design decisions (locked)

- **Git-backed markdown is the default transport**, not MCP. Rationale: human-readable, diffable,
  reviewable, survives container/volume churn, and matches the system's own hand-off doctrine.
- **KB location is flexible**: `in-repo` (default, `docs/agent-knowledge/` in the team repo) or
  `own-repo`; when a team has multiple repos the operator selects one (config on the team/env).
- **Real-time query = a local git working copy + a `knowledge` CLI** (ripgrep over markdown), offline.
  No service on the default path.
- **MCP is a first-class but opt-in *provider*** behind the same `knowledge` facade — never the default.
- **Provenance is mandatory from day one**: every KB entry records where it came from, so any T2 skill
  can be traced back to the exact agent/session/PR that learned it.
- **Curation is a toggle**, generalised to a 0–3 autonomy dial (below). Level 0 == today's behaviour
  (fully backward compatible). Level 1 is the default.
- **Cadence is event-driven** (per session / per write / per convergence), not a weekly cron.
- Repo convention respected: **pure helper cores are unit-tested** (`node --test`; Python helpers via the
  stdlib-`unittest` + `importlib` pattern already used in `agent-image/scripts/test_agent_entrypoint.py`).
- Product name in any user-facing copy is **Agent Studio**; internal codenames stay out of the UI.

## Autonomy dial (one control, four states)

Per team. Generalises the "curation on/off" toggle.

| Level | Behaviour | Operator effort |
|---|---|---|
| **0 — Off** | today: private memory, nothing shared | — |
| **1 — Share** *(default)* | harvest → Team-KB + real-time query, automatic; no promotion without asking | none |
| **2 — Suggest** | system drafts promotions/merges; operator confirms per prepared card | occasional one click |
| **3 — Auto-curate** | curator merges + promotes autonomously within a tier; operator audits git history | only on demand |

## Event-driven cadence (replaces weekly cron)

| Step | Trigger | Cost |
|---|---|---|
| **Harvest** | after every session (extends the existing per-invocation learn-hint) | cheap, already runs |
| **Dedup / merge** | on every KB write — new entry checked against existing (lexical/embedding) | cheap, no LLM |
| **Convergence counter** | on every write — "how many agents independently recorded this?" | trivial |
| **Promotion suggestion** | threshold crossed (e.g. ≥2 agents independently, or N× recurrence) → draft skill + card | LLM, only on trigger |
| **Full curation** | cron only as a **backstop** (≤ daily), never the primary driver | rare |

Cheap detection **gates** expensive LLM distillation, so learning is visible within minutes without
running the model continuously. Suggestions are **debounced/batched** (same thinking as the burst-cap
digest, #449, and the throttle windows) so the operator is never spammed. The convergence trigger *is*
the live finding: "three developers wrote the same fact independently" becomes the automatic
"ready to become a team skill" signal.

---

# Phases

Sequenced so the **visible demo surface lands early** (Phase 2), right after the minimal harvest that
gives it data.

## Phase 0 — Foundations (data model + storage)

**Goal:** plumbing only, no behaviour change.

Deliverables:
- **KB entry schema** with mandatory provenance. One entry (a line/block in a markdown file with a small
  front-matter or a sidecar JSONL index):
  `{ id, kind: fact|entity|convention, text, originAgent, teamId, createdAt, sessionId|correlationId, sourceRefs[] (PR/issue/commit), convergence: [agentId...] }`.
- **`knowledgeStore` config** on team/env: `{ mode: "in-repo"|"own-repo", repoRef?, path (default "docs/agent-knowledge/"), sources: [] }`.
- **Default KB structure + manifest** shipped as a good default (`facts/`, `entities/`, `conventions/`
  + a `knowledge.manifest.json` the team may override).
- **Three-tier skill resolver**: extend `makeSkillSourceResolver` to agent → team → global; add the
  agent-tier path `/workspace/agents/<id>/skills/`.

Key files: `orchestrator/skill-source.js`, new `orchestrator/knowledge-store.js` (pure, unit-tested),
env/team config plumbing in `orchestrator/orchestrator.js`.

Verification: unit tests for the resolver (3 tiers) and the KB entry/manifest builder.

## Phase 1 — `knowledge` CLI + harvest (agents start sharing)

**Goal:** agents pool knowledge; reaches **autonomy level 1**. Not yet visible in the UI.

Deliverables:
- **`knowledge` CLI** on the agent PATH (`agent-image/scripts/knowledge`, guidance in
  `agent-image/CLAUDE.md`) — mirrors the existing `aee-artifact` CLI. Commands:
  - `knowledge search "<query>"` — ripgrep over the synced KB working copy (real-time, offline), results
    labelled by tier/source.
  - `knowledge add <kind> "<text>"` — append with provenance; git commit + push (via `gh-as-agent` so
    attribution holds).
  - `knowledge list` / `knowledge path "<id>"` — inspection.
  - `knowledge promote <id|cluster>` — stub, wired in Phase 3.
- **KB working copy** synced into the workspace at seed time + `git pull` on demand.
- **Harvest hook**: extend the per-invocation learn-hint in `agent-image/scripts/agent-entrypoint.py`
  so that, in addition to writing `memory/log.md`, it distils
  durable facts/entities and calls `knowledge add`. Event-driven, once per session.
- Autonomy dial levels **0/1**; default 1. Level 0 = skip harvest (today's behaviour).

Key files: `agent-image/scripts/knowledge`, `agent-image/scripts/agent-entrypoint.py`,
`agent-image/CLAUDE.md`.

Verification: pure-core tests for the distiller/provenance stamping; manual — run the three developers,
confirm the KB fills and duplicates collapse (inspect via git).

## Phase 2 — Knowledge Flow view + live feed (the demo surface)

**Goal:** the marketing promise becomes demoable; visible & traceable at every level.

Deliverables:
- **Backend aggregation**: `GET /api/knowledge/graph?scope=agent:<id>|team:<id>|global` — assembles KB
  items + skills + provenance into a lane/node/edge model (analogous to `/api/process/graph`). Pure
  builder in `admin-console/api/knowledge-graph.js` (unit-tested).
- **Live feed**: SSE `GET /api/knowledge/stream` emitting harvest/promotion events; reuse the SSE
  infrastructure behind the session-log/chat streams and the `useSSE` hook.
- **Knowledge Flow page** (`admin-console/src/pages/KnowledgeFlow.jsx`): a three-lane laddered
  visualisation (Agent → Team → Global), items flowing left→right, **convergence highlighted**
  ("3× independent"), reusing the layered-DAG layout muscle from Flows (`process/flow-layout.js`) where
  it fits.
- **Provenance drill-down**: click an item → lineage panel → origin agent → session (`correlationId`) →
  PR/issue, using the existing session-log + `gh-as-agent` attribution.
- **Durchgängig / consistent widgets** at every scope (same vocabulary):
  - Agent (chat/card): "what this agent has learned" + live feed + badge (`+12 today`).
  - Team: the KB + per-agent contributions + (later) open suggestion cards.
  - Global: cross-team skills + originating team.
- **Ambient learning badges** on Agent/Team cards.

Key files: `admin-console/api/knowledge-graph.js`, `admin-console/api/api.js` (routes),
`admin-console/src/pages/KnowledgeFlow.jsx`, a shared `KnowledgeFeed`/`LearningBadge` component,
`admin-console/src/hooks/useSSE.js` (reuse).

Verification: graph-builder unit tests; manual — open the view during the three developers' runs and
watch items appear and flow.

## Phase 3 — Convergence detection + promotion suggestions

**Goal:** event-driven automation with prepared one-click promotions; **autonomy level 2**.

Deliverables:
- **Write-time dedup** (cheap lexical / optional embedding similarity) in the `knowledge add` path or a
  small collector; near-duplicates merge or link instead of appending.
- **Convergence counters** maintained per canonical fact (which agents independently recorded it).
- **Threshold trigger** → LLM drafts a `SKILL.md` from the mature cluster → raises a suggestion. Reuse
  the established suggestion pattern (`emit-suggestions`, `agent-prompt/generate`, `port-suggestion`):
  - `GET /api/knowledge/promotion-suggestions?team=<id>` — prepared drafts.
  - `POST /api/knowledge/promote` — `promote(from-tier → to-tier)` (generalises `promote-to-global`),
    carrying provenance through.
- **Debounce/batch** suggestions (burst-cap/throttle thinking, #449) so cards arrive grouped, not
  spamming.
- **Suggestion cards** surface in the Phase 2 Knowledge Flow view.

Key files: new `admin-console/api/knowledge-suggestions.js` (pure heuristic + draft builder,
unit-tested), `orchestrator/knowledge-store.js` (convergence), skill-pool write path for promotion.

Verification: unit tests for convergence thresholds + suggestion drafting; manual — confirm a suggestion
appears shortly after the 2nd/3rd agent records the same fact.

## Phase 4 — Curation & full autonomy

**Goal:** hands-off operation with audit trail; **autonomy level 3**.

Deliverables:
- **Curator** driven by events (KB-growth / convergence), **not** a weekly cron; cron only as a daily
  backstop. Merges/dedupes the KB and, at level 3, auto-promotes within a tier.
- **Full 3-tier promotion** wired end-to-end (Agent → Team → Global), gate-able, provenance preserved.
- **Review gates on promotion edges** in the Knowledge Flow view (the promotion arrows flip from
  "automatic" to "needs review" — same surface, one switch).

Key files: curator worker (event-subscribed, in the orchestrator process alongside the poller),
promotion endpoints, Knowledge Flow edge-gating UI.

Verification: curation is idempotent and best-effort (never blocks a run); provenance survives promotion.

## Phase 5 — MCP as a first-class knowledge provider (opt-in)

**Goal:** external knowledge systems as first-class query sources, without touching the default path.

Deliverables:
- **`knowledgeStore.sources[]`** binds an existing MCP registry server + credential
  (`/workspace/mcp-servers`, `/workspace/mcp-credentials`) as a knowledge source — no new credential
  store.
- **`knowledge search` fan-out** (Style A, the facade): local KB (always) + each MCP source, merged and
  **source-labelled** (`[team-kb]` vs `[wiki/confluence]`). A dependency-light MCP client in the CLI,
  symmetric to the single-file MCP servers already shipped.
- Interim **Style B** (available earlier, zero new code): reuse native MCP tool injection + `SKILL.md`
  guidance pointing the agent at the MCP tool for external lookups.
- Empty `sources[]` ⇒ the default path is **100% MCP-free**.
- (Optional, later) write-back: publish a promoted skill/KB entry to an external system via an MCP
  `write` tool.

Key files: `knowledge` CLI (provider fan-out), `knowledgeStore.sources` config, env editor UI to bind a
knowledge source.

Verification: with no sources configured, no MCP call is made; with a source, results merge and are
labelled.

---

## Cross-cutting concerns

- **Security / isolation.** The default sharing bridge is **git**, which is the system's sanctioned
  cross-agent channel — agents only ever touch their *own* synced working copy and push. The curator is
  the single component that reads across agents; it runs in the orchestrator (control plane), so the
  per-agent network/filesystem isolation (Seams #2/#3) is preserved for the agents themselves.
- **Backward compatibility.** Autonomy level 0 reproduces today's behaviour exactly. Teams with no KB and
  no team-tier skills behave as a global-only setup (as they do today). Legacy/unstamped data falls back
  cleanly.
- **Cost control.** Cheap write-time detection gates expensive LLM distillation; suggestions are
  debounced/batched.
- **Testing.** Pure cores unit-tested (`knowledge-store.js`, `skill-source.js` 3-tier, `knowledge-graph.js`,
  `knowledge-suggestions.js`); the CLI distiller mirrored/tested on both runtimes.

## Open questions

1. ~~KB physical layout — one file per kind with a JSONL provenance sidecar, vs. front-matter per entry.~~
   **Resolved (Phase 0):** one canonical JSONL file per kind (`facts/facts.jsonl`, …); each line is a
   full entry incl. provenance/convergence. Markdown is a derived read view, not a second source of
   truth. Rationale: line-atomic concurrent appends + mechanical `convergence[]` updates. See
   `docs/knowledge-store.md`.
2. Similarity backend for dedup/convergence — lexical-only (dependency-free) vs. optional embeddings via
   a model provider.
3. Convergence threshold defaults (independent-agent count, recurrence count, time window).
4. ~~Whether the Agent-tier skill pool is materialised on disk from day one or introduced with Phase 3
   promotion.~~ **Resolved (Phase 0):** the resolver tier (agent → team → global) is defined now; the
   on-disk agent pool is **deferred to Phase 3** promotion — no agent has the directory yet, so
   resolution falls through to team/global exactly as today. See `docs/knowledge-store.md`.
