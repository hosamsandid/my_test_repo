# Convergence detection + promotion suggestions — Phase 3 design

Reference design for **Phase 3** of the Shared Agent Learning & Knowledge Flow
(`docs/knowledge-sharing-concept.md` → "Phase 3 — Convergence detection +
promotion suggestions"). Builds on the Phase 0 data model/config
(`docs/knowledge-store.md`), the Phase 1 CLI + harvest + KB storage
(`docs/knowledge-cli.md`), and the Phase 2 aggregation + live feed
(`docs/knowledge-flow.md`).

**Goal:** turn the raw, per-agent harvest stream into **converged canonical
facts** and **prepared, one-click promotion suggestions** — reaching **autonomy
level 2 ("Suggest")**. The system *detects* that N agents independently recorded
the same lesson, *grows* `convergence[]` so Phase 2's "N× independent" highlight
finally lights up, *drafts* a `SKILL.md` from a mature cluster, and *raises* a
suggestion card the operator confirms. It **never promotes autonomously** — that,
plus destructive KB curation and review-gated promotion edges, is Phase 4 (#463).
No MCP sources (Phase 5). Level 0 and level 1 behaviour are preserved exactly.

Status: **design of record for #462** — pending approval. Implementation does not
begin until the decisions in §0 are confirmed.

---

## 0. Decisions to lock (please confirm)

| # | Question | Proposed choice |
|---|---|---|
| **a** | **Where dedup/convergence runs** — the concept offers "CLI write path *or* a small collector", and flags that per-agent shards make write-time cross-agent merge non-trivial. | **Orchestrator-side collector at the push choke-point.** Cross-agent convergence is inherently a cross-shard read, and the orchestrator is already the *only* sanctioned cross-agent reader (the canonical clone, per the concept's cross-cutting note). The CLI keeps its Phase-1 `search`-before-`add` nudge (cheap *self*-dedup); the collector does the cross-agent work. It runs inside `emitKnowledgeHarvest` (already fires after every successful push) — event-driven, no new cron. See §2. |
| **b** | **Similarity method + threshold** | **Lexical only, dependency-free** (concept: "cheap similarity, optional embedding later"). Normalized **token-set Jaccard** with an exact-normalized fast path; default merge threshold `simThreshold = 0.6`, default promotion threshold `convergenceThreshold = 2` **distinct** agents. Both configurable per team via a new `knowledgeConvergence` env block. A `similarity(a,b)→score` seam lets embeddings slot in later without touching callers. See §3. |
| **c** | **Merge representation in JSONL** (must not break append-only shards, line-atomic writes, or Phase 2 `dedupById`) | **Shards stay append-only and are never rewritten** (attribution + conflict-freedom preserved). The merge lives entirely in the **canonical `<kind>.jsonl`** — the single-writer, orchestrator-owned "curated read view" Phase 0 already reserved. The collector regenerates it as: one **canonical entry per cluster** (earliest member wins the id) with grown `convergence[]` + `updatedAt`, plus a **`status:"merged"` tombstone** `{ id:<absorbed>, mergedInto:<canonicalId> }` for every non-winner id. A new *additive* pure `foldMerges()` in the graph builder resolves tombstones before the untouched `dedupById`. No merges ⇒ `foldMerges` is identity ⇒ Phase 2 output is byte-identical. See §4. |
| **d** | **`promote(from→to)` contract + provenance + CLI verb semantics** | `POST /api/knowledge/promote` generalises `promote-to-global` to `agent→team` and `team→global`; **`entryIds` is mandatory** and a `provenance.json` is written beside `SKILL.md` (the graph's T1→T2 edge already keys off `provenance.entryIds`). The `knowledge promote` CLI verb (exit-3 stub today) becomes **nominate**, not execute: it raises a suggestion card; the operator confirms in the UI, which alone calls `POST /api/knowledge/promote`. This keeps "no auto-promotion at level 2." See §5–§6. |
| **e** | **Autonomy gating** | **Convergence-grow runs at level ≥ 1**, so the default dial makes Phase 2's "N× independent" real (non-destructive: shards untouched, only the derived canonical view changes). **Promotion suggestions (candidates + cards + drafts) run at level ≥ 2.** Auto-merge/auto-promote stay level 3 (Phase 4). See §7. |

---

## 1. Contract summary

| Method + path | Where | Purpose |
|---|---|---|
| `GET /api/knowledge/promotion-suggestions?team=<id>` | admin-console | List open promotion candidates for a team, each with cluster + a **heuristic** `SKILL.md` draft (cheap, always present). Membership-scoped. |
| `POST /api/knowledge/promotion-suggestions/:id/draft` | admin-console | Optionally **polish the draft with the LLM** (reuses `resolveGenerationTarget`); heuristic fallback; caches the result on the candidate. Operator-initiated. |
| `POST /api/knowledge/promote` | admin-console | Execute `promote(from→to)`: write the skill to the target tier + a mandatory `provenance.json`, mark the candidate `promoted`, ask the orchestrator to emit the `promotion` feed event. |
| `POST /internal/agents/:id/knowledge/nominate` | orchestrator | Agent-initiated nomination (the `knowledge promote` CLI verb). Creates/refreshes an `open` candidate for the given entry/cluster. Never promotes. |
| `POST /internal/knowledge/promoted` | orchestrator | Post-promotion side effects: append the `promotion` feed event, best-effort stamp the source canonical entries `status:"promoted"` and push. |
| `POST /internal/agents/:id/knowledge/push` | orchestrator | **(extend)** after the existing clone-refresh, run the convergence collector for the team (§2). |

No change to the Phase-2 `graph` / `summary` / `stream` / `item` routes beyond
wiring `foldMerges` into the entry-gather path (§4).

---

## 2. The convergence collector (orchestrator, event-driven)

`emitKnowledgeHarvest(id, cfg, env, rawBody)` already fires after every
successful `knowledge/push`: it force-refreshes the team's canonical clone
(`/workspace/knowledge/<teamId>/`) and appends the harvest feed events. Phase 3
adds one call at the end of that function:

```
runConvergenceCollector(teamId, env)   // best-effort, never throws to the push
```

**Steps (all inside a per-team mutex so refresh + collector + push are
serialized; reuses the existing per-team throttle map):**

1. **Read** every shard `<store>/<kind>/shards/*.jsonl` from the just-refreshed
   canonical clone (the freshest cross-agent view), tolerant-parsed with
   `parseEntry`. This is the *only* cross-agent read, in the *only* component
   allowed to do it.
2. **Cluster** per kind with the pure `buildCanonicalProjection` (§3): near-dups
   collapse; the **earliest-created** member is the canonical winner (stable id);
   `convergence[]` = the distinct union of every member's `originAgent` +
   existing `convergence`.
3. **Project** into the canonical files: overwrite each `<kind>/<kind>.jsonl`
   with the canonical entries (grown `convergence`, refreshed `updatedAt`) plus
   the `status:"merged"` tombstones. Serialized with `serializeEntry` (identical
   `KEY_ORDER`, so the cross-runtime golden guard still holds). **Shards are not
   touched.**
4. **Commit + push** the canonical files to `agent-knowledge` as the orchestrator
   ("Agent Studio <knowledge@agents.local>"), reusing the fetch-rebase-retry from
   `agentKnowledgePush` (canonical files never collide with shard pushes —
   different files — so the rebase is clean). Pushing means agents' own
   `knowledge search` also shows `conv=N`, not just the operator UI.
5. **Suggestion raise (level ≥ 2 only):** for each cluster that *newly* crosses
   `convergenceThreshold` and has no existing `open`/`promoted` candidate, append
   a candidate to the per-team store and emit a batched `suggestion` feed event
   (§6). LLM-free here — drafting happens lazily in the admin-console.

**Idempotency & cost.** The projection is a pure function of the shards, so
re-running the collector yields byte-identical canonical files (no churn, no
spurious commits — skip the commit when the tree is clean). Candidate ids are
stable (§6), so a cluster is never re-raised. The collector does **zero** LLM
calls; it is cheap enough to run on every push, exactly as the concept's cadence
table specifies ("Dedup/merge + convergence counter: on every write, no LLM").

**Why not the CLI (decision a).** An agent's CLI only sees its own shard plus
whatever it pulled; it cannot atomically fold another agent's independent write
into a shared canonical fact without becoming a cross-agent writer — which would
break the per-agent-shard conflict-freedom that Phase 1 is built on. The Phase-1
`search`-before-`add` nudge already handles the cheap *same-agent* case at write
time; genuine cross-agent convergence belongs in the control plane.

---

## 3. Similarity + clustering (pure core, decision b)

New pure module **`orchestrator/knowledge-convergence.js`** (no fs/network,
injected `now`; unit-tested). The clustering lives **only** here — the
admin-console never re-clusters (it reads pre-clustered canonical entries +
candidates), so similarity code is not duplicated across services.

```js
normalizeText(text)        // lowercase, strip punctuation, collapse whitespace
tokenSet(text)             // Set<token> over the normalized text
jaccard(aSet, bSet)        // |∩| / |∪|  (0 when both empty)
similarity(a, b)           // exact-normalized ⇒ 1.0, else jaccard(tokenSet…)
similar(a, b, threshold)   // similarity >= threshold

clusterEntries(entries, { simThreshold })
//   → [{ canonicalId, kind, memberIds[], convergence[], text }]
//   single-link agglomeration within a kind; deterministic order
//   (sort by createdAt then id); convergence = distinct union of member
//   originAgents ∪ member.convergence[].

buildCanonicalProjection(entriesByKind, { simThreshold, now })
//   → { canonical: { <kind>: [entry…] }, tombstones: { <kind>: [entry…] },
//       clusters: [cluster…] }
//   canonical entry = the winner entry with convergence grown + updatedAt=now;
//   tombstone = { v, id, kind, …minimal…, status:"merged", mergedInto, updatedAt }.

crossesConvergence(cluster, threshold)   // cluster.convergence.length >= threshold
stableSuggestionId(cluster)              // hex hash of kind + sorted memberIds
planNewSuggestions(clusters, existing, { threshold })
//   → { raise: [cluster…], batch: { teamId, count, samples[] } }
//   drops clusters already represented by an open/promoted candidate
//   (idempotency + the debounce, mirroring planBurstHandoffs, #449).
```

**Thresholds** come from a new, normalized env block, read by a pure accessor in
`orchestrator/knowledge-store.js` (co-located with `knowledgeAutonomyLevel`):

```jsonc
"knowledgeConvergence": {
  "simThreshold": 0.6,          // clamp [0,1], default 0.6
  "convergenceThreshold": 2     // clamp >=2, default 2 (distinct agents)
}
```

`knowledgeConvergenceConfig(env)` returns the clamped defaults for any legacy env
(unchanged behaviour). "Independent" = **distinct `originAgent`**; the same agent
recording twice does not grow convergence.

**Embeddings later.** Only `similarity(a,b)` would change — an embedding backend
(behind a model provider, opt-in) drops in there without touching clustering,
projection, thresholds or callers.

---

## 4. Merge in JSONL, without breaking anything (decision c)

The invariants Phase 1/2 rely on, and how Phase 3 keeps them:

| Invariant | Kept how |
|---|---|
| Shards are append-only, line-atomic, one writer each | The collector **never writes a shard**. It only regenerates the canonical `<kind>.jsonl`, which has exactly one writer (the orchestrator). |
| Provenance is preserved for every contributor | Each contributor's full entry stays in its shard; the canonical entry lists all contributors in `convergence[]`; the drill-down still resolves each by id. |
| `dedupById` (Phase 2) is untouched | A new *additive* pass runs **before** it. |

**Tombstone shape** (a full, valid-enough line so `parseEntry` keeps it):

```jsonc
{ "v":1, "id":"<absorbedId>", "kind":"fact", "text":"…",
  "originAgent":"…", "teamId":"…", "createdAt":"…",
  "convergence":["…"], "status":"merged", "mergedInto":"<canonicalId>",
  "updatedAt":"2026-07-08T09:20:00Z" }
```

**`foldMerges(entries)`** — new pure helper in
`admin-console/api/knowledge-graph.js`, applied in the gather path (route) or at
the top of `buildKnowledgeGraph` / `summarizeKnowledge`, **before** `dedupById`:

1. Build `redirect = { absorbedId → mergedInto }` from every `status:"merged"`
   entry (resolve transitively; guard cycles).
2. Drop entries whose id is a redirect source **and** whose canonical target is
   present (so a dangling tombstone never hides a still-live entry).
3. Return the survivors; `dedupById` then collapses the canonical id seen in both
   the canonical file and (still) the winner's shard — last-writer-wins on
   `updatedAt` keeps the grown-convergence canonical copy. Net: **one node per
   cluster, `convergenceCount` = union size.**

No `status:"merged"` records ⇒ step 2 drops nothing ⇒ identical to Phase 2. This
is the whole compatibility story: the model was designed for it (`convergence[]`,
`status` incl. `merged`/`promoted`, `updatedAt` all already in the Phase-0
schema), Phase 3 just populates it.

---

## 5. `promote(from → to)` (decision d)

`POST /api/knowledge/promote` (admin-console — skill pools are its RW volumes,
exactly like `promote-to-global`):

```jsonc
{
  "from": "team",             // "agent" | "team" (source tier)
  "to":   "global",           // "team" | "global" (target tier)
  "teamId": "acme",
  "name": "poller-conventions",
  "skillMd": "# …operator-approved SKILL.md…",
  "entryIds": ["9f3a12bc7de0", "…"],   // MANDATORY provenance (>=1)
  "suggestionId": "…",         // optional — the candidate this fulfils
  "overwrite": false
}
```

**Allowed transitions** (`validatePromotion`, pure): `agent→team`, `team→global`.
Everything else (`team→team`, `global→*`, unknown tiers) → 400. Missing/empty
`entryIds` → 400 (**provenance is mandatory, enforced at the API boundary**).

**Writes:**
- `to:"team"` → `/workspace/teams/<teamId>/skills/<name>/` (`safeTeamSkillDir`).
- `to:"global"` → `<POOL_DIR>/skills/<name>/` (same dest + containment guard as
  `promote-to-global`).
- `SKILL.md` = the operator-approved body.
- `provenance.json` beside it (`buildSkillProvenance`, pure):

  ```jsonc
  { "teamId":"acme", "fromTier":"team", "toTier":"global",
    "entryIds":["9f3a12bc7de0","…"], "canonicalId":"9f3a12bc7de0",
    "originAgents":["acme-dev-1","acme-dev-2","acme-dev-3"],
    "convergence":["acme-dev-1","acme-dev-2","acme-dev-3"],
    "sourceRefs":[{ "kind":"pr","ref":"459" }],
    "sessions":[{ "agentId":"acme-dev-1","correlationId":"$evt…" }],
    "originTeamId":"acme", "promotedAt":"…Z", "promotedBy":"<req.user #305>" }
  ```

**Provenance propagation is the point.** The graph builder's existing
`skillEntryIds(skill)` reads `provenance.entryId`/`entryIds`; so the moment the
skill is written, the **T1→T2 `promoted` edge** appears with zero UI change. For
`to:"global"`, `originTeamId` drives the global-lane "originating team". This is
the end-to-end trace the concept demands: skill → entryIds → canonical KB entry →
originAgent → session (`correlationId`) → PR (`sourceRefs` + `gh-as-agent`
stamp), all already resolvable by the Phase-2 `/api/knowledge/item/:id` drill-down.

**Skills registry surfacing.** `gatherKnowledgeSkills` (api.js) is extended to
read `provenance.json` from each skill dir and attach `provenance` +
`originTeamId` + `teamId` to the `{name, tier, …}` records it already emits — the
only change needed for the promoted edge + origin-team to render.

**Post-promotion side effects** → `POST /internal/knowledge/promoted` (orchestrator):
append a `promotion` feed event (`{ type:"promotion", teamId, skill:{name,tier},
entryIds, ts }` — the type Phase 2 reserved), best-effort stamp the source
canonical entries `status:"promoted"` + push. Best-effort; the skill write is the
durable action.

---

## 6. Suggestion cards + debounce (decisions d/e)

**Candidate store:** `/workspace/knowledge-suggestions/<teamId>.json` — a small
array the orchestrator owns (append/update; the admin-console reads it and
updates lifecycle status). Each candidate:

```jsonc
{ "id":"<stableSuggestionId>", "teamId":"acme", "kind":"fact",
  "canonicalId":"9f3a12bc7de0", "entryIds":["…","…"],
  "convergence":["acme-dev-1","acme-dev-2","acme-dev-3"], "convergenceCount":3,
  "text":"This repo unit-tests pure helper cores only",
  "members":[ { "id":"…","originAgent":"…","createdAt":"…","correlationId":"…" } ],
  "source":"convergence" | "agent-nominated", "note":"…?",
  "status":"open" | "promoted" | "dismissed",
  "raisedAt":"…Z", "draft": { "name":"…", "skillMd":"…", "llmDrafted":false }? }
```

**Raised two ways:** the collector (§2 step 5, `source:"convergence"`) and the
CLI `knowledge promote <id>` (§9, `source:"agent-nominated"`, works below
threshold too — an agent flagging something skill-worthy). Both go through the
same stable-id dedup, so nothing is raised twice.

**Debounce/batch (#449 thinking).** The store's stable ids *are* the debounce —
re-detection never duplicates. For the live pulse, the collector emits at most
**one** batched `suggestion` feed event per pass:
`{ type:"suggestion", teamId, count, samples:[{canonicalId,text}], ts }`
(carries `teamId`, so `matchesScope` forwards it to team + global streams). The
operator sees grouped cards, never a per-fact flood — the lossless, card-store
sibling of the Layer-3 throttle, exactly as the burst-cap digest is the lossless
sibling for GitHub events.

**Draft generation.** `GET /promotion-suggestions` returns each open candidate
with a **heuristic** draft always attached (`buildHeuristicSkillDraft`, pure: a
templated `SKILL.md` — title from the cluster, a "What/Why" section from the
member texts, and a provenance footer; no secrets). `POST
/promotion-suggestions/:id/draft` optionally polishes it with the LLM
(`resolveGenerationTarget` + `buildMessagesUrl` + `httpPostJson`, heuristic
fallback on any failure — the exact `agent-ports/suggest` doctrine) and caches
`draft` on the candidate. LLM calls are thus **operator-initiated and cached**,
never fired from the hot push path — the cost control the concept asks for.

---

## 7. UI — suggestion cards in the Knowledge Flow view

Additive to the existing `admin-console/src/pages/KnowledgeFlow.jsx` (Phase 2):

- A **right-rail "Suggestions" section** (a sibling of the live `KnowledgeFeed`,
  team/global scope only) lists open candidates via
  `GET /api/knowledge/promotion-suggestions?team=<id>` — each a card: the
  converged fact, a `N× independent` chip (same styling as the item badge), and
  **Review & promote**.
- **Review dialog** (`PromotionDialog.jsx`): shows the cluster + contributors,
  the editable `SKILL.md` (heuristic draft pre-filled), a **Draft with AI**
  button (→ `/draft`, mirrors the Add-role "Generate agent prompt" button), a
  target-tier selector (default `team`; `global` for a team skill), and the
  provenance that will be recorded. **Promote** → `POST /api/knowledge/promote`;
  **Dismiss** marks the candidate `dismissed`.
- On promote, the incoming `promotion` feed event pulses the new skill node and
  draws the `promoted` edge — the ladder visibly completes T1→T2.

Convergence itself needs **no UI change**: Phase 2 already renders
`convergenceCount`/`converged`; growing `convergence[]` (§2) is what finally
lights it up.

---

## 8. Autonomy gating (decision e)

| Level | Convergence-grow (canonical merge) | Promotion suggestions | Promote executes |
|---|---|---|---|
| 0 — Off | — (no KB at all) | — | — |
| 1 — Share *(default)* | **yes** (non-destructive; shards untouched) | — | — |
| 2 — Suggest | yes | **yes** (cards + drafts) | operator-confirmed only |
| 3 — Auto-curate (Phase 4) | yes | yes | (auto — Phase 4) |

Growing `convergence[]` at level 1 is what makes the Phase-2 demo real under the
default dial, and it is safe: it only rewrites the derived canonical view, never
a shard, and is a pure function of the shards (reversible by deleting the
canonical file). Suggestions gate at level 2, matching the dial's definition.

---

## 9. `knowledge promote` CLI verb (agent nomination)

`agent-image/scripts/knowledge` `cmd_promote` (exit-3 stub today) becomes:

```
knowledge promote <id> [--note "why this is skill-worthy"]
```

- Resolves the entry by id from the synced checkout; POSTs a nomination to
  `POST /internal/agents/<agentId>/knowledge/nominate`
  `{ entryId, note }` (the orchestrator resolves the cluster + team and writes an
  `agent-nominated` candidate). Prints the candidate id; exit 0.
- **It does not promote.** Promotion is the operator's confirm in the UI — the
  level-2 contract. The help text + `agent-image/CLAUDE.md` are updated to say so
  ("nominate a fact for promotion; a human confirms").
- The pure, testable part is `build_nomination(entry_id, note, agent_id)` → dict
  (mirrors `lean_summary`); the POST is thin IO.

---

## 10. Test plan (pure cores only, per repo convention)

**`orchestrator/knowledge-convergence.test.js`** (`node --test`) — the bulk:
- `normalizeText` / `tokenSet` / `jaccard`: casing, punctuation, whitespace; empty
  sets → 0; identical → 1.
- `similarity` / `similar`: exact-normalized ⇒ 1.0; near-dup ("polls every 30s" vs
  "polls the Events API every 30 s") ≥ threshold; unrelated facts < threshold.
- `clusterEntries`: near-dups cluster; distinct facts don't; **same agent twice
  ⇒ convergence stays 1 distinct agent**; convergence = distinct union; kinds
  never cross-cluster; deterministic order.
- `buildCanonicalProjection`: earliest member wins the canonical id; convergence
  grown; a tombstone per absorbed id with `mergedInto`; **idempotent** (re-run ⇒
  byte-identical via `serializeEntry`); no-dup input ⇒ no tombstones.
- `crossesConvergence`, `stableSuggestionId` (order-independent),
  `planNewSuggestions` (skips existing open/promoted; batches; #449 parity).
- `knowledgeConvergenceConfig` clamping + legacy defaults.

**`admin-console/api/knowledge-graph.test.js`** (additions):
- `foldMerges`: tombstone drops the absorbed id; canonical carries union
  convergence; transitive redirects; cycle guard; dangling tombstone (target
  absent) keeps the entry; **no tombstones ⇒ identity** (Phase-2 goldens
  unchanged).
- End-to-end over merged input: one converged node, `convergenceCount` = union;
  N `harvested` edges; `promoted` edge appears iff a skill's
  `provenance.entryIds` names a folded canonical id.

**`admin-console/api/knowledge-suggestions.test.js`** (`node --test`):
- `buildHeuristicSkillDraft`: name slug; body contains member texts + provenance
  footer; no secret fields.
- `validatePromotion`: `agent→team` / `team→global` ok; `team→team`, `global→*`,
  unknown tiers, **missing `entryIds`** → error.
- `buildSkillProvenance`: carries `teamId`, `entryIds`, `originAgents`,
  `convergence`, `originTeamId` (global), `promotedAt`/`promotedBy`; shape matches
  `skillEntryIds`.
- `promotionSuggestionView` shape (candidate + draft merge).

**Python — `agent-image/scripts/test_knowledge.py`** (additions):
- `build_nomination`: shape + defaults; `promote` dispatch no longer exits 3
  (tested at the pure-payload level; the POST is not unit-tested).

**Not unit-tested** (convention): the collector's git IO / commit / push, the
candidate-store IO, the LLM draft call, SSE, and React — all verified manually.

**Manual (documented in the PR):** run a 3-developer team at autonomy ≥ 2; watch
the same fact recorded by dev-1/2/3 converge (canonical `conv=3` via `knowledge
search` and the item badge), a batched `suggestion` event pulse, a card appear;
open it, *Draft with AI*, edit, **Promote to global**; confirm the global skill
lands with `provenance.json`, the `promoted` edge draws, and the drill-down
traces skill → entry → agent → session → PR.

---

## 11. Files touched

**New:**
- `docs/knowledge-convergence.md` (this doc).
- `orchestrator/knowledge-convergence.js` (similarity + clustering + projection +
  suggestion planning, pure) + `knowledge-convergence.test.js`.
- `admin-console/api/knowledge-suggestions.js` (heuristic draft + promotion
  validation/provenance builders, pure) + `knowledge-suggestions.test.js`.
- `admin-console/src/pages/knowledge/PromotionDialog.jsx` (+ a suggestions
  section, likely a small `PromotionSuggestions.jsx`).

**Edit:**
- `orchestrator/orchestrator.js`: `runConvergenceCollector` inside
  `emitKnowledgeHarvest`; canonical-file write + commit/push (reuse the KB push
  retry); candidate store + batched `suggestion` event (level ≥ 2); new internal
  endpoints `.../knowledge/nominate` and `/internal/knowledge/promoted`.
- `orchestrator/knowledge-store.js`: `knowledgeConvergenceConfig(env)` +
  `normalizeKnowledgeStore` awareness of `knowledgeConvergence`.
- `admin-console/api/knowledge-graph.js`: `foldMerges` + wire into
  `buildKnowledgeGraph` / `summarizeKnowledge`.
- `admin-console/api/api.js`: the three `/api/knowledge/promotion-suggestions` +
  `/promote` routes; `gatherKnowledgeSkills` reads `provenance.json`.
- `agent-image/scripts/knowledge`: `cmd_promote` → nominate; `build_nomination`;
  help text. `agent-image/scripts/test_knowledge.py`: the new test.
- `agent-image/CLAUDE.md`: `knowledge promote` now active (nominate, human
  confirms).
- `admin-console/src/pages/KnowledgeFlow.jsx`: mount the suggestions section +
  dialog; handle `suggestion`/`promotion` feed events.

---

## 12. Out of scope (later phases — do not build here)

- **Auto-merge / auto-promotion** (level 3), the event-driven **curator**, and the
  daily cron backstop → Phase 4 (#463).
- **Review gates on promotion edges** in the Knowledge Flow view → Phase 4.
- **Destructive KB curation** (rewriting/pruning shards, archiving) → Phase 4.
  Phase 3 only ever *adds* to the derived canonical view; shards stay append-only.
- **Embeddings** for similarity — the `similarity()` seam is ready, the backend is
  not built here.
- **MCP knowledge sources** → Phase 5.
