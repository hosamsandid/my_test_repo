# Knowledge Flow view + live feed — Phase 2 design

Reference design for **Phase 2** of the Shared Agent Learning & Knowledge Flow
(`docs/knowledge-sharing-concept.md` → "Phase 2 — Knowledge Flow view + live
feed (the demo surface)"). Builds on the Phase 0 data model/config
(`docs/knowledge-store.md`) and the Phase 1 CLI + harvest + KB storage
(`docs/knowledge-cli.md`).

**Goal:** make the marketing promise demoable — the agents' learning becomes
**visible and traceable at every level** (Agent → Team → Global). This phase is
**read + display only**: it aggregates the KB that Phase 1 fills, streams a live
feed of harvests, renders the three-lane ladder, and drills into provenance. It
adds **no** dedup, convergence *detection*, promotion automation, or MCP sources
(Phases 3–5). The `knowledge promote` CLI verb stays a stub.

Status: **design of record for #461** — approved (decisions §0 #1/#3 confirmed) and
implemented on `integration/knowledge-flow`.

---

## 0. Decisions to lock (please confirm)

| # | Question | Proposed choice |
|---|---|---|
| 1 | **Aggregator source of truth** (the open question Phase 1 left) | **Orchestrator-maintained canonical KB clone per team** at `/workspace/knowledge/<teamId>/`, refreshed at the push choke-point; the admin-console reads its JSONL shards straight off the shared volume. Per-agent checkouts are a dedup-by-id *fallback* so early bring-up isn't blank. See §2. |
| 2 | **SSE transport between services** | The orchestrator (where pushes happen) appends events to a shared append-only feed file `/workspace/knowledge-events/events.jsonl`; the admin-console `/api/knowledge/stream` **tails that file** with the exact byte-offset + `fs.watch` pattern already used by the session-log stream. No new socket between services. See §4. |
| 3 | **Emit hook point** | The existing `POST /internal/agents/:id/knowledge/push` — every KB write already funnels through it. The `knowledge` CLI adds a lean entry summary to the push body; the orchestrator echoes it into the feed after a successful push. See §4.1. |
| 4 | **Graph renderer** | Reuse the **pure** `computeFlowLayout` (lanes as exclusive column-bands) for node placement; render with a **purpose-built lightweight SVG** in `KnowledgeFlow.jsx` rather than routing KB nodes through `flow-graph-render.js` (which is coupled to process/agent node shapes). See §5. |
| 5 | **Convergence in Phase 2** | Surfaced faithfully from `convergence[]` (seeded `[originAgent]` in Phase 1, *grown* in Phase 3). The model + "N× independent" highlight ship now; counts are mostly 1 until Phase 3 populates them. No detection logic here. |

---

## 1. Contract — `GET /api/knowledge/graph?scope=…`

Analogue of `GET /api/process/graph`. A **pure** builder
(`admin-console/api/knowledge-graph.js`, unit-tested) turns gathered KB entries +
skills + agent metadata into a lane/node/edge model; the route is the thin IO
shell that gathers those inputs (mirrors how `api.js` gathers agents/triggers and
hands them to `buildProcessGraph`).

### Query

```
GET /api/knowledge/graph?scope=agent:<id> | team:<id> | global
```

- `scope` (default `global`). `agent:<id>` and `team:<id>` validated against
  `AGENT_ID_RE`. Team-membership scoping (`computeScope`, #302) is applied to the
  agent/skill/team lists exactly as the other list endpoints do.

### Response

```jsonc
{
  "scope": "team:acme",
  "lanes": ["agent", "team", "global"],   // fixed left→right ladder (T0→T1→T2)
  "nodes": [
    // agent lane (T0 — the learners/contributors)
    { "id": "agent:acme-dev-1", "lane": "agent", "kind": "agent",
      "label": "acme-dev-1", "teamId": "acme", "counts": { "items": 7, "today": 2 } },

    // team lane (T1 — the KB entries; one node per entry)
    { "id": "item:9f3a12bc7de0", "lane": "team", "kind": "item",
      "entryKind": "fact", "text": "This repo unit-tests pure helper cores only",
      "teamId": "acme", "createdAt": "2026-07-08T09:12:00Z",
      "convergence": ["acme-dev-1", "acme-dev-2", "acme-dev-3"],
      "convergenceCount": 3, "converged": true,
      "provenance": { "originAgent": "acme-dev-1", "correlationId": "$evt…",
                      "sessionId": "…", "sourceRefs": [{ "kind": "pr", "ref": "459" }] } },

    // global lane (T2 — promoted skills; also team-tier skills for team scope)
    { "id": "skill:cobol-analysis", "lane": "global", "kind": "skill",
      "label": "cobol-analysis", "tier": "global", "originTeamId": "acme" }
  ],
  "edges": [
    // T0→T1: one HARVESTED edge per convergence contributor → the fan-in that
    // literally draws "3× independent" on a converged item.
    { "from": "agent:acme-dev-1", "to": "item:9f3a12bc7de0", "kind": "harvested", "origin": true },
    { "from": "agent:acme-dev-2", "to": "item:9f3a12bc7de0", "kind": "harvested" },
    { "from": "agent:acme-dev-3", "to": "item:9f3a12bc7de0", "kind": "harvested" },
    // T1→T2: PROMOTED edge, drawn only when a skill's provenance links a KB entry
    // (populated by Phase 3/4; model ready, usually empty in Phase 2).
    { "from": "item:9f3a12bc7de0", "to": "skill:cobol-analysis", "kind": "promoted" }
  ],
  "counts": { "agents": 3, "items": 7, "skills": 4,
              "byKind": { "fact": 4, "entity": 2, "convention": 1 },
              "converged": 1, "today": 2 },
  "warnings": []   // e.g. "no canonical KB clone for team; read from agent checkouts"
}
```

### Scope semantics

| scope | agent lane | team lane (items) | global lane |
|---|---|---|---|
| `agent:<id>` | just `<id>` (+ co-contributors of shared items, faded) | items where `originAgent==id` **or** `id ∈ convergence` | skills whose provenance traces to those items (usually none yet) |
| `team:<id>` | every agent that contributed to the team KB | all entries in that team's KB | team-tier skills + globals promoted from this team |
| `global` | collapsed to one node per contributing **team** | (empty / summarised) | every global-tier skill + its `originTeamId` |

### Pure-builder API

```js
buildKnowledgeGraph({ scope, entries, skills, agents, now }) -> { scope, lanes, nodes, edges, counts, warnings }
```

- `entries`: **already-parsed, already-deduped-by-id** KB entries. Dedup itself
  lives in the builder (`dedupById`, last-writer-wins on `updatedAt`/`createdAt`)
  so it's testable and independent of which shard roots the IO layer read.
- `skills`: `[{ name, tier, teamId?, provenance? }]` from the existing skills
  registry (`GET /api/skills`).
- `agents`: `[{ id, parentTeamId, environmentId, displayName }]` gathered by the
  route (mirrors process-graph's gather), used for lane membership + team
  collapsing. No fs/network in the builder.
- Lane assignment feeds `computeFlowLayout` client-side via a `stage` per node
  (`stage = lane`), so the three lanes become exclusive column-bands (§5).

---

## 2. Aggregator source of truth (open question — resolved)

Phase 1 left **one KB checkout per agent** at `/workspace/agents/<id>/knowledge`
(a clone on the shared `agent-knowledge` branch) and **no canonical clone** in
the control plane. Both `admin-console` and `orchestrator` mount the `/workspace`
volume, so the admin-console can read any of those checkouts off disk — but each
one only reflects what *that* agent last pulled (stale, partial).

**Resolution — orchestrator-maintained canonical clone per team**, mirroring the
existing **briefings clone** the BP-event router force-pulls (`orchestrator`
already owns credentials, network egress, and is the sanctioned
"reads-across-agents" control-plane component per the concept's cross-cutting
note):

- **Location:** `/workspace/knowledge/<teamId>/` — a clone of the team's resolved
  KB repo (`knowledgeStore.repoRef`) on the `agent-knowledge` branch, KB rooted
  at `knowledgeStore.path`. One per team (a team shares one env → one KB repo).
- **Refresh (best-effort, throttled):** `fetch origin agent-knowledge` +
  `reset --hard origin/agent-knowledge`. Triggered at the **push choke-point**
  (after a successful `knowledge/push`, §4.1) and on a short throttle (≥30 s,
  like the BP router's 60 s pull throttle) when the graph endpoint asks for a
  team it hasn't refreshed recently. Never blocks a request: if the clone is
  missing/failing, the endpoint proceeds on whatever is on disk and adds a
  `warnings[]` note.
- **Read path (admin-console):** the graph route reads
  `<clone>/<storePath>/<kind>/shards/*.jsonl` + any curated
  `<kind>/<kind>.jsonl`, parses with `parseEntry` (tolerant), and hands the
  entries to the pure builder. **No git in the admin-console** — it only reads
  files the orchestrator maintains on the shared volume.
- **Fallback (bring-up robustness):** if the canonical clone doesn't exist yet
  (level 0, or nobody has pushed), the route unions the shards from every
  `/workspace/agents/<id>/knowledge/<storePath>` checkout of the team's agents.
  Because every shard is on the same branch and entries carry a unique `id`,
  `dedupById` in the builder converges regardless of how many stale copies are
  seen. The canonical clone simply guarantees freshness/completeness once it
  exists.

**Why not read agent checkouts directly as the primary?** They're per-agent and
lag by "last pull"; a fresh operator view during a demo needs the newest tip.
The canonical clone gives one authoritative, always-fetchable source without the
admin-console holding git credentials.

**convergence[] surfacing.** The builder reads `convergence[]` straight off each
entry (Phase 1 seeds `[originAgent]`; Phase 3 grows it). It sets
`convergenceCount = convergence.length`, `converged = count >= 2`, and emits one
`harvested` edge per contributor — so the day Phase 3 merges duplicates, the same
view lights up "3× independent" with zero UI change.

---

## 3. Lightweight refresh + orchestrator endpoint

New internal endpoint (orchestrator), proxied by the admin-console:

```
POST /internal/knowledge/refresh   { teamId }      → { ok, refreshedAt, warnings[] }
```

- Ensures/updates the canonical clone for `teamId` (clone if absent, else
  fetch+reset), throttled per team. Best-effort, never throws to the caller.
- Reuses `_buildKbGitEnv` + the `knowledgeStore.repoRef` resolution already in
  `orchestrator.js`; a small pure helper `shouldRefresh(lastAt, now, minMs)` +
  the clone-path builder are the unit-tested cores (the git IO is not).
- The admin-console graph route calls this opportunistically (fire-and-forget
  with a short timeout) before reading, so the on-disk shards are current;
  the read never waits on the network beyond the timeout.

---

## 4. Live feed — `GET /api/knowledge/stream`

Reuses the **session-log SSE muscle** verbatim: `text/event-stream`, a
`since=<byteOffset>` cursor, `_cursor`/`_truncated` control frames, `: ping`
heartbeat, `fs.watch` + debounced drain (`api.js` §"Log streaming (SSE)" and the
`/session/:roomId/stream` tailer). The client consumes it through the existing
`useSSE` hook — unchanged.

### Transport

The orchestrator appends one line per event to an append-only feed file
**outside any git clone**:

```
/workspace/knowledge-events/events.jsonl      # append-only; truncation-safe cursor
```

The admin-console `GET /api/knowledge/stream?scope=…` tails this file (same
tailer as sessions), parses each line, applies the **scope filter**
(`matchesScope(event, scope)`, a pure predicate), and forwards matches as
`data: <json>`. Non-matching lines advance the cursor silently.

### Event schema

```jsonc
{ "type": "harvest",                    // harvest | promotion | _cursor | _truncated
  "ts": "2026-07-08T09:12:00Z",
  "teamId": "acme",
  "agentId": "acme-dev-1",
  "entry": { "id": "9f3a12bc7de0", "kind": "fact",
             "text": "This repo unit-tests pure helper cores only",
             "originAgent": "acme-dev-1", "convergenceCount": 1 } }
```

- `harvest` — a KB entry was pushed (Phase 2's live signal).
- `promotion` — reserved; emitted once Phase 3/4 promote a skill (schema carries
  `skill` instead of `entry`). Wiring the emit is Phase 3; the stream + client
  already handle the type.
- The payload is **provenance-lean** (id/kind/text/originAgent/convergenceCount)
  — no secrets, matching what the shard already exposes.

### 4.1 Emit hook point

`POST /internal/agents/:id/knowledge/push` (exists) is the single choke-point:

1. The `knowledge` CLI (which built the entry and knows its fields) adds a lean
   summary to the push body: `{ entries: [{ id, kind, text, originAgent, convergenceCount }] }`.
   Today the body is ignored; we read it. The values are already in the shard, so
   nothing secret is added.
2. After a **successful** push, the orchestrator (a) refreshes the team's
   canonical clone (§2) and (b) appends one `harvest` line per entry to
   `events.jsonl`, stamped with `teamId` (resolved from the agent's env) and `ts`.
3. Failure to append is best-effort/logged — it never fails the push.

If a body is absent (older CLI / offline `--no-push` then manual push), the
orchestrator emits a single count-only `harvest` event `{ teamId, agentId }` so
badges still tick — the graph endpoint remains the authoritative full view.

---

## 5. Knowledge Flow page

`admin-console/src/pages/KnowledgeFlow.jsx`, new nav entry **Knowledge** (route
`/knowledge`, and `/knowledge?scope=team:<id>` etc.).

**Layout.** Three fixed lanes left→right — **Agent · Team · Global** (the T0→T1→T2
ladder). Node placement reuses the pure `computeFlowLayout` from
`admin-console/src/pages/process/flow-layout.js` by assigning each node a
`stage = lane`; flow-layout's stage-partitioning gives three exclusive column
bands, and its median sweep orders rows to reduce edge crossings. Rendering is a
**purpose-built lightweight SVG** in this page (lane headers + item cards + the
harvested/promoted edges), *not* `flow-graph-render.js` — that renderer assumes
process/agent node shapes and channel ports we don't have here.

**Convergence highlight.** Item cards with `converged` get a badge
("`3× independent`") and thicker fan-in edges; the multiple `harvested` edges
converging on one item *are* the visual. Filter chips: kind (fact/entity/
convention), "converged only", "today".

**Scope switch.** A segmented control Agent / Team / Global drives the `scope`
query param (deep-linkable), refetching `/api/knowledge/graph`.

**Live feed panel.** A right-rail `KnowledgeFeed` (§6) subscribes to
`/api/knowledge/stream?scope=…`; new harvests animate in and pulse the matching
item node, so during the 3-developer demo you literally watch entries land and
converge.

**Provenance drill-down (§7).** Clicking an item opens a lineage panel.

---

## 6. Consistent widgets (durchgängig) + ambient badges

Two shared components, one vocabulary at every scope:

- **`LearningBadge`** (`admin-console/src/components/LearningBadge.jsx`) — a small
  pill: "`+N today`" / "`N learned`". Fed by a lean
  `GET /api/knowledge/summary?scope=…` → `{ items, today, converged }` (cheap;
  doesn't build the whole graph). Mounts on:
  - **Agent cards** (`Agents.jsx`) — `scope=agent:<id>`.
  - **Team cards** — `scope=team:<id>`.
  - **Agent chat header** (`ChatPanel.jsx`) next to the "Session aktiv" badge.
- **`KnowledgeFeed`** (`admin-console/src/components/KnowledgeFeed.jsx`) — a live
  list of recent harvest/promotion events via `useSSE`. Mounts in:
  - the Knowledge Flow right rail (page-level),
  - a new **Knowledge** tab in the agent-chat `RightRail` (`scope=agent:<id>`) —
    "what this agent has learned" + its live feed,
  - the team view.

Both are pure presentational components fed by the two endpoints; no new state
plumbing.

---

## 7. Provenance drill-down

Every item node already carries `provenance` (originAgent, teamId, createdAt,
correlationId, sessionId, sourceRefs). A helper endpoint resolves the deep links
so the panel is one click:

```
GET /api/knowledge/item/:id?teamId=<id>  → { entry, links }
```

`links` is built by **pure** helpers (unit-tested), no new data model:

- **origin agent** → the Agent card / chat (`/chats/<originAgent>`).
- **session** → `buildSessionDeepLink(originAgent, correlationId)`: locates which
  of the agent's `sessions/<roomId>.jsonl` logs contains a row with that
  `correlationId` (the session log already stamps every row with it — the DM/
  chat pairing mechanism), returns `{ agentId, roomId, correlationId }` so the UI
  deep-links into the existing session-log panel and highlights the run.
- **PR/issue/commit** → `buildSourceRefUrl(ref, repoUrl)`: `sourceRefs[]` +
  the env's repo URL → a GitHub URL (`…/pull/459`, `…/issues/99`,
  `…/commit/<sha>`). This is where **`gh-as-agent` attribution** closes the loop:
  the commit/PR the agent opened carries the `<!-- agent: id -->` / `@agents.local`
  stamps, so the lineage lands on the exact artifact that agent produced.

The lineage panel renders: *item → origin agent → session (correlationId) →
PR/issue*, each a link. IO (reading the session logs to find the room) lives in
the route; the URL/link construction is the pure, tested part.

---

## 8. Endpoints summary

| Method + path | Where | Purpose |
|---|---|---|
| `GET /api/knowledge/graph?scope=` | admin-console | Lane/node/edge model (pure builder) |
| `GET /api/knowledge/summary?scope=` | admin-console | Lean counts for `LearningBadge` |
| `GET /api/knowledge/stream?scope=` | admin-console | SSE live feed (tails the feed file) |
| `GET /api/knowledge/item/:id` | admin-console | Single entry + resolved provenance links |
| `POST /internal/knowledge/refresh` | orchestrator | Ensure/refresh canonical clone (proxied, best-effort) |
| `POST /internal/agents/:id/knowledge/push` | orchestrator | **(extend)** read entry summary from body → append feed + refresh clone |

---

## 9. Test plan (pure cores only, per repo convention)

**`admin-console/api/knowledge-graph.test.js`** (`node --test`) — the bulk:

- `dedupById`: same `id` across multiple shard roots collapses to one; newer
  `updatedAt`/`createdAt` wins; malformed entries already filtered by `parseEntry`.
- Lane assignment: agents→agent lane, entries→team lane, skills→global lane;
  `global` scope collapses agents into one node per team.
- `harvested` edges: exactly one per `convergence[]` contributor; the origin
  contributor tagged `origin: true`.
- Convergence: `convergenceCount = convergence.length`; `converged` iff `>= 2`;
  the fan-in produces N edges into one item.
- Scope filtering: `agent:<id>` keeps only items where `originAgent==id ||
  id ∈ convergence`; `team:<id>` keeps the team's entries; membership scope
  respected.
- Counts: `byKind`, `today` (createdAt within 24 h of injected `now`),
  `converged`, totals.
- `promoted` edges appear iff a skill's provenance links an entry; empty
  otherwise (the Phase 2 norm).
- Edge cases: empty entries → empty lanes, no throw; unknown scope → `global`.

**`admin-console/api/knowledge-links.test.js`** (`node --test`) — provenance
links: `buildSourceRefUrl` for pr/issue/commit/branch/url from a GitHub repo URL
(and SSH-form URLs); returns null for unknown ref kinds; `matchesScope(event,
scope)` predicate for the SSE filter (agent/team/global); `shouldRefresh` throttle
predicate.

**Not unit-tested** (convention): the SSE file-tailing, `fs.watch`, git
fetch/reset IO, the canonical-clone provisioning, and React rendering. Verified
manually.

**Manual (documented in the PR):** run a multi-developer team at autonomy ≥ 1;
open `/knowledge?scope=team:<id>`; watch harvests stream in via the live feed and
items appear in the Team lane; click an item and follow origin agent → session →
PR; confirm the `LearningBadge` on the Agent/Team cards ticks.

---

## 10. Files touched

- **New:** `admin-console/api/knowledge-graph.js` (pure builder + `dedupById`),
  `admin-console/api/knowledge-graph.test.js`,
  `admin-console/api/knowledge-links.js` (pure link/scope/throttle helpers) +
  `knowledge-links.test.js`, `admin-console/src/pages/KnowledgeFlow.jsx`,
  `admin-console/src/components/{LearningBadge,KnowledgeFeed}.jsx`, this doc.
- **Edit:** `admin-console/api/api.js` (the four `/api/knowledge/*` routes,
  reusing the session-log SSE tailer + `computeScope`),
  `orchestrator/orchestrator.js` (canonical-clone maintenance + feed append in
  the push endpoint + `/internal/knowledge/refresh`),
  `agent-image/scripts/knowledge` + `orchestrator/agent-runner.js` (push body
  carries the lean entry summary),
  `admin-console/src/pages/{Agents.jsx,agent-chat/RightRail.jsx,agent-chat/ChatPanel.jsx}`
  + team view + nav (mount the widgets/page).

---

## 11. Out of scope (later phases, do not build here)

- Write-time **dedup**, convergence **detection**, promotion **suggestions** and
  the suggestion cards → Phase 3 (#462). Phase 2 only *displays* `convergence[]`.
- **Curator** / auto-promotion, review gates on promotion edges → Phase 4.
- **MCP** knowledge sources → Phase 5.
- The `knowledge promote` CLI verb stays a **stub**.

---

## 12. Read-side retrieval telemetry (#915)

The write path has emitted `harvest` events since Phase 2; this section adds the
missing READ signal so "does the KB make agents better?" is answerable with data
and the decay sweep (#919) has something to consume.

**Transport.** `knowledge search`/`list` are fully local in the agent container
(a checkout scan — they never touch the orchestrator), and the container cannot
write the shared volume. The signal therefore travels over a new internal
endpoint, the same agent→orchestrator pattern as the knowledge push:

```
POST /internal/agents/:id/knowledge/retrieval        (:4002, internal-only)
{ "source": "search" | "digest", "entryIds": ["<12-hex>", …],
  "hitCount": <n>, "ts": "<ISO — advisory; server clock is the fallback>" }
```

`teamId` is resolved server-side from the agent config (like the push endpoint).
Two emitters, both best-effort fire-and-forget (3 s timeout, every failure
silent — a telemetry outage must never break search or an invocation):

- **`knowledge search` / `list`** → `source:"search"` (the strong signal — the
  agent explicitly looked) with the returned ids after fold + limit. The query
  text is **never** sent, not even hashed (privacy decision).
- **the pre-invocation digest rebuild** (`_rebuild_knowledge_digest`,
  agent-entrypoint.py) → `source:"digest"` (the weak signal — inlined
  unconditionally) with the build's `includedIds`, once per rebuild after the
  atomic write.

`source:"scoped"` is reserved for #917's trigger-based loading layer.

**Storage — aggregate, not a log.** One compact JSON per team at
`/workspace/knowledge-retrieval/<teamId>.json` (atomic tmp+rename write, one row
per entry — no retention machinery needed):

```jsonc
{ "since": "<ISO first-write — the #919 cold-start baseline>",
  "entries": { "<entryId>": {
      "lastSearchAt": "…", "searchHits": 3,
      "lastDigestAt": "…", "digestCount": 41 } } }
```

`events.jsonl` and the SSE feed are **untouched** — retrieval never appends to
the live feed (it would drown harvest/promotion events, and the feed has no
retention). Pure core: `orchestrator/knowledge-retrieval.js`
(`validateRetrieval` / `applyRetrieval` / `lastUsedAt`), unit-tested.

**Read API.** `GET /internal/teams/:teamId/knowledge/retrieval-stats`
(orchestrator; an empty aggregate is a valid 200 — "no data" IS the cold-start
signal) → proxied as `GET /api/knowledge/retrieval-stats?team=<id>`. The graph
route also overlays the truth onto item nodes (`augmentRetrievalStats` →
`lastUsedAt` / `usageCount` / `searchHits`, plus a graph-level `retrievalStats`
flag so the UI can distinguish "never used" from "telemetry unreachable").

**UI.** Item cards show "used 5× · 2d ago" (amber "never used" when telemetry
answered and the entry has no row — the operator-visible precursor of a #919
retire suggestion); the overview table gains a sortable **Last used** column
(ascending = least-recently-used first, the retire-candidate view). Retrieval
events do **not** animate through the live feed.

**Lifecycle.** Deleting a squad purges its retrieval-stats file
(`planTeamKnowledgePurge` `retrievalDir` root).
