# Curation & full autonomy — Phase 4 design

Reference design for **Phase 4** of the Shared Agent Learning & Knowledge Flow
(`docs/knowledge-sharing-concept.md` → "Phase 4 — Curation & full autonomy").
Builds directly on the Phase 3 machinery (`docs/knowledge-convergence.md`): the
push-choke-point convergence collector, the canonical projection (append-only
shards + `status:"merged"` tombstones), the per-team candidate store, and
`promote(from→to)` with mandatory provenance.

**Goal:** hands-off operation — **autonomy level 3 ("Auto-curate")**. The curator
runs event-driven (on KB growth / convergence, plus a daily backstop), merges the
KB as it already does at level ≥ 1, and — new here — **auto-promotes** mature,
converged clusters into team skills **within a per-team gate policy**. The full
three-tier skill ladder (**Agent → Team → Global**) is wired end-to-end: the
on-disk **agent** skill pool is materialised and `agent→team` promotion joins the
Phase-3 `team→team` / `team→global`. Promotion edges become **gate-able**: a
promotion arrow flips between "automatic" and "needs review" on one switch, and a
gated edge routes through an operator approval card instead of firing. Levels
0/1/2 behave **exactly** as today; level 2 (draft + operator confirm) is untouched.

Status: **design of record for #463** — approved (§0 decisions confirmed) and
implemented on `integration/knowledge-flow` (stacked on Phase 3, commit 88d78ee).
Follow-up (post-approval, on request): the two optional sub-decisions were then
built too — the `knowledge promote --to agent` CLI verb (§4) and a **manual**
archive action (§6).

**Forgetting doctrine (evolved by #919):** fully-automatic staleness archiving
stays out — but the system may automatically **propose** it. The nightly curator
backstop sweeps each team's #915 retrieval aggregate and raises `source:"decay"`
retire-suggestion cards (per-team `decayHorizonDays`, default 60, 0 = off;
hard-gated until the telemetry baseline is a full horizon old) for active
entries with zero retrievals of any source within the horizon. Digest-included,
promoted and review-held entries are exempt (digest inclusion = "the team lives
off this"). Confirming a card runs the **exact same** non-destructive archive
overlay as the manual Retire button — even at autonomy level 3 the archive
itself is always a human click (retirement destroys context; level-3 promotion
only adds). The same pass persists the per-team **curation-health** record
(30-day raised/promoted/dismissed/pushes counters; `status:"silent"` when
pushes happen but nothing converges — the Gap-3 failure signature) with one
`curation-health` feed event per state transition.

---

## 0. Decisions to lock (please confirm)

| # | Question | Proposed choice |
|---|---|---|
| **a** | **Where the curator lives + how it is triggered.** Extend the collector, a separate worker loop, or both + a daily backstop? | **Extend the existing push-choke-point collector** (`runConvergenceCollector`) with a level-3 `autoPromoteStep`, **plus a daily backstop timer** in the orchestrator process. No separate event-subscribed worker: the collector already *is* the event subscription (it fires after every KB push — the concept's cadence). The backstop (`setInterval`, ≤ daily, mirrors the poller) re-runs the collector for every knowledge-enabled team so a config change (dial flipped to 3 after facts already converged) or a push whose collector failed still converges/promotes within a day. **Runaway control:** the candidate store's stable ids already make a cluster promote at most once; on top of that a **per-pass cap** `maxAutoPromotionsPerPass` (default 3, the #449 burst-cap number) promotes up to N clusters and **defers the rest to review cards** (lossless) — so flipping the dial to 3 over a large backlog can't emit a flood of skills in one pass. See §2. |
| **b** | **Destructive vs. non-destructive KB curation.** Rewrite/prune shards, or archive via `status`? | **Non-destructive.** Shards stay **append-only and are never rewritten** (attribution + per-agent conflict-freedom preserved, exactly as Phase 3). Curation remains a property of the single-writer **canonical `<kind>.jsonl`**: Phase 3's merge stays, and Phase 4 adds `status:"archived"` on a canonical entry to retire superseded/stale knowledge. A new additive `foldArchived()` (sibling of `foldMerges`) drops archived entries from the active graph; they survive in git for audit/rollback. **No single-writer shard compaction** — it would break the append-only model, the line-atomic writes, and the drill-down's per-contributor resolution for zero benefit the canonical view can't already give. See §6. |
| **c** | **Auto-promotion policy at level 3** — what, to which tier, on what gate, `promotedBy`, and how `agent→team` fits. | **What:** a cluster that crosses `convergenceThreshold` (the *same* trigger that raises a level-2 card) with a **heuristic** SKILL.md draft (no LLM on the hot path). **To which tier:** **team** only — the writable, team-scoped natural home. **Global is never auto** (the orchestrator mounts the global pool **read-only**, and global blast-radius warrants review), so `team→global` always routes to review. **Gate:** convergence ≥ threshold (default 2 distinct agents); no extra age gate in v1 (convergence *is* the maturity signal). **`promotedBy`:** `"curator"` in the mandatory provenance. **agent→team:** the rung is *wired* (pool + operator/agent promotion, §4) but **not auto-promoted by the curator in v1** — the curator auto-promotes team-KB→team-skill only. See §3. |
| **d** | **Review-gate model + persistence + how it flips the `promoted` edge.** | **Per-team, per-transition policy** `knowledgePromotionGates` on the shared env (beside `knowledgeAutonomy` / `knowledgeConvergence`): `{ "team>team": "auto", "team>global": "review", "agent>team": "review" }` (defaults). At level 3 the curator resolves the target transition's gate: **`auto`** → write the skill; **`review`** → raise an `open` candidate card carrying the pre-built draft (i.e. a gated level-3 promotion **degrades to exactly the level-2 surface**). No new queue — the Phase-3 candidate store *is* the pending-promotion queue. The switch is a per-transition toggle in the Knowledge Flow view → `PUT /api/knowledge/gates`. **Rendering:** `auto` promotions still draw the solid `promoted` edge (unchanged); a `review` transition with an open auto-drafted candidate draws a **dashed amber "needs review" edge** to a ghost skill node. See §5. |
| **e** | **Level-3 safety** — idempotency, audit/rollback, candidate-lifecycle interaction. | **Idempotent:** deterministic skill slug; skip if the skill already exists or the cluster's candidate is already `promoted`; candidate ids are the Phase-3 stable ids. **Never blocks a run:** the whole curator is wrapped best-effort inside the collector, which already never throws to the push. **Audit:** each auto-promotion stamps the source canonical entries `status:"promoted"` and commits the canonical files on the `agent-knowledge` branch (git history = the audit log the concept promises), plus an append-only `promotion` feed event with `promotedBy:"curator"` and the `provenance.json`. **Rollback:** revert the git commit / delete the skill dir. **Lifecycle:** a **`dismissed`** candidate is never auto-promoted (the curator respects the operator's "no"); an auto-promoted cluster's candidate is flipped to `promoted` so it never re-raises. See §7–§8. |

---

## 1. Contract summary

| Method + path | Where | Purpose |
|---|---|---|
| `GET /api/knowledge/gates?team=<id>` | admin-console | Return the team's resolved `knowledgePromotionGates` (defaults folded in) + the current autonomy level, so the UI can render the per-edge switches. Membership-scoped. |
| `PUT /api/knowledge/gates` | admin-console | Persist a per-transition gate change (`{ teamId, transition, mode }`, `mode ∈ auto|review`). Proxies to the orchestrator, which is the env-config writer. |
| `POST /api/knowledge/promote` | admin-console | **(extend)** allow `from:"agent"` (agent-skill → team-skill lift) in addition to the Phase-3 `team→team` / `team→global`. Provenance still mandatory (carried forward from the source skill for a lift). |
| `POST /internal/knowledge/gates` | orchestrator | Write `knowledgePromotionGates` onto the team's shared env (validated, clamped). |
| `POST /internal/agents/:id/knowledge/promote-private` | orchestrator | **(new, optional per decision c)** the agent-side `knowledge promote --to agent` verb: create a private **agent-tier** skill from a converged cluster in the agent's own pool. Off the hot path; agent-initiated. *(Only if we adopt the CLI author path — see §4; otherwise agents author private skills as plain files.)* |

The curator itself exposes **no new route** — it runs inside the collector and the
backstop timer. No change to the Phase-2 `graph` / `summary` / `stream` / `item`
routes beyond wiring `foldArchived` into the entry-gather path (§6) and rendering
the gate state (§5).

---

## 2. The curator (orchestrator, event-driven + daily backstop) — decision a

The curator is **one new pure planner** (`orchestrator/knowledge-curator.js`) plus
**one new step** appended to the existing `runConvergenceCollector` and a **daily
backstop timer**. It never introduces a second cross-agent reader — it reuses the
collector's freshly-refreshed canonical clone (the only sanctioned cross-agent
read, per the concept's cross-cutting note).

### 2.1 The auto-promote step (inside `runConvergenceCollector`)

`runConvergenceCollector` today: refresh clone → project canonical (merge, level
≥ 1) → commit/push → raise suggestions (level ≥ 2). Phase 4 appends, **after the
suggestion step, gated on level 3**:

```
if (knowledgeAutonomyLevel(env) >= 3) {
  autoPromoteStep(teamId, env, proj.clusters, candidates)   // best-effort
}
```

`autoPromoteStep`:

1. **Plan** with the pure `planAutoPromotions(clusters, candidates, gates, opts)`
   (§3): pick clusters that cross the threshold, are **not** already
   `promoted`/`dismissed`, and whose target transition (`team>team`) gate is
   `auto`; **cap at `maxAutoPromotionsPerPass`**; the overflow + any `review`-gated
   clusters become `defer` (→ cards).
2. **Write each `promote`** as a **team-tier skill**
   (`/workspace/teams/<teamId>/skills/<slug>/`): `SKILL.md` (heuristic draft) +
   `provenance.json` (`promotedBy:"curator"`, §3). The orchestrator can write here
   — `/workspace` is RW; it can **never** write global (`/template-workspace` is
   `:ro`), which is why global is never auto.
3. **Stamp + commit:** flip the source canonical entries to `status:"promoted"`
   in the canonical `<kind>.jsonl`, `git add/commit` (`Agent Studio
   <knowledge@agents.local>`) and `_pushKnowledgeClone` — the git audit trail.
4. **Lifecycle + feed:** flip each promoted cluster's candidate to
   `status:"promoted"` (create it first if the collector hadn't raised one — the
   stable id keeps it dedup-safe), and `appendKnowledgeEvents` a single batched
   `promotion` feed event listing the auto-created skills.
5. **Defer:** for `review`-gated / over-cap clusters, raise/refresh `open`
   candidates (the level-2 path) with `autoDrafted:true` so they surface as
   "needs review" cards — nothing is lost.

Everything is wrapped so a failure logs and returns; the push already succeeded.

### 2.2 Daily backstop timer

A `setInterval` (default `KNOWLEDGE_CURATOR_INTERVAL_MS`, ≤ 24 h) started in the
orchestrator's boot alongside the github-poller. Each tick enumerates
knowledge-enabled teams (`resolveTeamKbRepo` over `listAgentIds`, deduped) and
calls `refreshKnowledgeClone(force) → runConvergenceCollector` for each. This is
the concept's "cron only as a backstop, never the primary driver": the push path
covers the common case; the timer catches dial changes and missed pushes. It is
idempotent (the projection + stable candidate ids guarantee no churn), so a team
with nothing new produces no commit and no promotion.

### 2.3 Why not a separate worker loop

A separate event-subscribed worker would duplicate the clone-refresh + shard-read
+ projection the collector already performs after every push, and would need its
own trigger plumbing. The collector is already the event-driven cross-agent brain;
auto-promotion is one more pure step on the data it already holds. The backstop is
the only added timer, and it delegates straight back into the collector.

---

## 3. Auto-promotion policy (pure planner) — decision c

New pure module **`orchestrator/knowledge-curator.js`** (no fs/network, injected
`now`; unit-tested), the level-3 sibling of `knowledge-convergence.js`'s
`planNewSuggestions`:

```js
resolvePromotionGates(env)            // defaults + clamp → { "team>team", "team>global", "agent>team" }
targetTransitionFor(cluster)          // Phase 4: always "team>team" (KB cluster → team skill)

planAutoPromotions(clusters, candidates, gates, { threshold, cap, teamId, now })
//   → { promote: [{ cluster, name, transition }...],   // gate=auto, within cap
//       defer:   [{ cluster, reason: "gated"|"over-cap" }...] }  // → review cards
//   • skips clusters below threshold
//   • skips clusters whose stable candidate is `promoted` or `dismissed`
//   • gate=auto → promote (until cap); gate=review → defer("gated")
//   • overflow past cap → defer("over-cap")   (#449 lossless burst handling)

curatorSkillProvenance({ teamId, cluster, entryIds, now })
//   → { fromTier:"team", toTier:"team", teamId, entryIds, canonicalId,
//       originAgents, convergence, sourceRefs, sessions,
//       originTeamId:teamId, promotedAt:now, promotedBy:"curator" }
```

The heuristic `SKILL.md` draft is the **same shape** the admin-console produces
for a level-2 card (`buildHeuristicSkillDraft`). To keep the two services
decoupled (the admin-console never `require`s orchestrator code and vice-versa —
mirroring the two-runtime harvest-hint discipline), the curator carries its own
small, pure `curatorSkillDraft(cluster)` and `curatorSkillProvenance(...)`; a
golden test on **both** sides asserts the provenance shape stays compatible with
the graph builder's `skillEntryIds` (i.e. `entryIds` present) so the `promoted`
edge always renders. **No LLM in the curator** — auto-promotion is deterministic
and cheap; LLM polish stays operator-initiated (level-2 "Draft with AI").

**Config** (new env block, read by a clamped accessor in `knowledge-store.js`,
co-located with `knowledgeConvergenceConfig`):

```jsonc
"knowledgeCuration": {
  "maxAutoPromotionsPerPass": 3,       // clamp >=1, default 3 (#449 burst-cap parity)
  "autoThemeMinLessons": 4,            // #604 theme auto-promotion floor, clamp >=1

  // #779 skill-aggregation Phase 1 — both per-team, both optional:
  "digestRouting": true,               // default ON; `false` (or {enabled:false}) opts out.
                                        // {graduateAtAgents:N} raises the graduation bar
                                        // (default 4, must be > convergenceThreshold).
  "autoExtend": null,                  // null = follow the autonomy dial (on at level >=3);
                                        // `false`/`true` (or {enabled:bool}) overrides.
                                        // {confidenceFloor:N} sets the matchExistingSkill
                                        // score floor for an AUTO extension (default 100 =
                                        // "a direct entry-id lineage hit"; below → review card).
}
```

**Digest-only routing (#779).** A single converged `convention`/`fact` cluster is
already delivered to every agent by the knowledge digest, so it raises **no** skill
candidate/card — the decision is recorded on the candidate store (`status:"digest-only"`,
never an open card) and surfaced as a low-key `digest-routing` feed event. It is
thresholded, not absolute: once a cluster recurs across `>= graduateAtAgents` distinct
agents it **graduates** to a real candidate on a later collector pass. `entity` clusters
are never routed digest-only, and the escape hatches (agent `knowledge promote`, manual
combine) bypass routing entirely. Digest-only clusters stay in the **theme** aggregation
path, so a growing set can still surface as a theme card.

**Curator auto-extend (#779).** At autonomy level 3, when a converged cluster clearly
matches an existing team skill (`matchExistingSkill` score `>= confidenceFloor`, a direct
entry-id lineage hit by default) the curator **extends** that skill in place — re-synthesised
SKILL.md (the heuristic `## Added knowledge` append is the un-synthesised failure fallback
for the LLM extension draft), unioned provenance, a version-bumping `extended` manifest
stamp, and an `extension` feed event — instead of spawning a new sibling skill. A
below-confidence / gated / over-cap match falls back to a review card that pre-selects
extend mode with the matched target. Gates apply exactly as for auto-promotion
(`team>team` only — `team>global` / `agent>team` are never auto-extended) and the extension
counts against the **same** `maxAutoPromotionsPerPass` cap as the create-new promotions.

> **Superseded for teams with domains (#2592).** Once a team has domains (and
> `knowledgeCuration.domainRouting` is not `false`), the collector runs the domain → skill
> pipeline instead: none of the auto-extend / create-new / theme steps above run, and every
> converged lesson grows its domain's one skill (see `docs/skill-aggregation-concept.md` §3.6).
> A team with no domains keeps the flow described here.

`convergenceThreshold` is reused from `knowledgeConvergence` (the same maturity
bar that raises a card is the bar that auto-promotes) — no second threshold to
keep in sync.

---

## 4. The Agent tier, wired end-to-end (Agent → Team → Global) — concept open question #4

Phase 0 defined the three-tier resolver (`skill-source.js`, agent → team →
global) but left the on-disk **agent** pool unmaterialised (open question #4,
deferred here). Phase 4 lights it up:

1. **Materialise the pool.** At agent seed (`seedAgentWorkspace`) ensure
   `/workspace/agents/<id>/skills/` exists. Resolution is already agent-first and
   already skips the self-copy when a resolved source *is* the destination
   (`orchestrator.js:845`), so this is a no-op for existing agents beyond making
   the directory a real, writable tier.
2. **`agent→team` promotion** (`validatePromotion` gains `agent>team`). Semantics:
   a **skill-tier lift** — copy `/workspace/agents/<id>/skills/<name>` →
   `/workspace/teams/<teamId>/skills/<name>`, **carrying forward** the source
   skill's `provenance.json` (so `entryIds ≥ 1` still holds — provenance survives
   the lift; `promotedBy` becomes the lifting operator, `fromTier:"agent"`). The
   `/api/knowledge/promote` route learns a `from:"agent"` branch requiring an
   `agentId` for the source dir (same containment guards as `/api/skills/promote`).
   This is operator-initiated (gate `agent>team` defaults to `review`).
   **UI (follow-up):** in **agent scope** the Knowledge Flow right rail shows a
   **Private skills** panel (`GET /api/agents/:id/private-skills`) with a **Lift to
   team** button per skill → the `from:"agent"` promote; agent-tier skills live in
   the agent's own pool and don't appear in the shared graph, so this panel is
   where they surface.
3. **Where agent-tier skills come from.** An agent authors a private skill by
   writing `SKILL.md` (+ `provenance.json`) into its own pool — it owns that
   directory, exactly as it owns `memory/`. **Implemented (follow-up):**
   `knowledge promote <id> --to agent [--name X]` (`agent-image/scripts/knowledge`)
   builds a private agent-tier skill from a KB entry and writes it into the agent's
   own pool locally (no human, no network — the agent owns its private tier;
   provenance carries `entryIds` so the later `agent→team` lift + the graph's
   `promoted` edge resolve). Pure `build_agent_skill` + `slugify_skill_name`, unit-
   tested in `test_knowledge.py`. The `team>agent` KB→private *server* promotion
   stays out (the CLI covers the agent-authoring path).

The resolver's agent-first precedence means a private agent skill **shadows** the
team's copy of the same name until it is lifted — the intended "personal
specialisation not yet team-ready" behaviour.

---

## 5. Review gates on promotion edges — decision d

### 5.1 Policy + persistence

Per-team, per-transition, on the shared env:

```jsonc
"knowledgePromotionGates": {
  "team>team":   "auto",     // curator may auto-promote KB → team skill
  "team>global": "review",   // ALWAYS review (orchestrator can't write global; blast radius)
  "agent>team":  "review"    // lifting a private skill to the team is operator-gated
}
```

`resolvePromotionGates(env)` fills defaults + clamps unknown values to `review`
(fail-safe: an unrecognised policy never silently auto-promotes). `team>global` is
**forced `review`** regardless of the stored value — there is no code path that
auto-writes the read-only global pool, and this keeps the highest-blast-radius
transition human-gated by construction.

`PUT /api/knowledge/gates {teamId, transition, mode}` → orchestrator
`/internal/knowledge/gates` writes the field onto the env (validated). Toggling
`team>team` to `review` turns level-3 into "auto-merge, but every promotion asks
first" — the operator's one switch, exactly as the concept frames it.

### 5.2 Gate resolution at level 3

The curator's `planAutoPromotions` reads the resolved gates: a cluster whose
target transition is `auto` promotes (within the cap); `review` defers to a card.
This is the single junction where the switch changes behaviour — the write step is
unchanged, only whether it runs.

### 5.3 Rendering (KnowledgeFlow.jsx)

- **`auto` + skill written** → the existing solid amber `promoted` edge (keys off
  `provenance.entryIds`, unchanged from Phase 3).
- **`review` + an open auto-drafted candidate** → a **dashed amber "needs review"
  edge** from the source `item:` node to a **ghost skill node** (`kind:"pending"`),
  clickable to open the review dialog. The ghost node + pending edge are derived in
  the route (not the pure builder's core promoted-edge path) from the candidate
  store, so the graph builder stays a pure function of entries+skills.
- The **switch** is a small per-transition toggle rendered on the promotion lane /
  in the legend (auto ⇄ needs-review), driven by `GET/PUT /api/knowledge/gates`.
  Convergence rendering is unchanged (Phase 2 already draws `N× independent`).

---

## 6. Non-destructive archiving — decision b

Curation stays a property of the derived canonical view; **shards are never
rewritten**. Phase 4 adds one status transition on **canonical** entries:

- **`status:"archived"`** — a canonical entry retired as superseded/stale. It is
  written by the single canonical writer (the orchestrator collector), never by an
  agent, and it leaves the shard lines untouched (the raw contributions and their
  attribution remain, and remain resolvable by id for any older skill's
  provenance).

`foldArchived(entries)` — new pure helper in `knowledge-graph.js`, applied in the
gather path **after** `foldMerges` and **before** `dedupById` (or folded into the
same pass): drop entries whose latest-by-`updatedAt` copy is `status:"archived"`.
Additive: no archived records ⇒ identity ⇒ Phase 2/3 output byte-identical.

**When does the curator archive?** Conservatively. The default level-3 behaviour
is **merge + promote, not prune** — archiving is *not* fired aggressively, because
archiving a *promoted* cluster's canonical entry would drop the `item:` node and
erase the `promoted` edge (breaking the "ladder visibly completes" story). So:

- **Auto-archive is OFF.** Promoted canonical entries stay live (the skill's
  provenance keeps pointing at them; the edge keeps rendering).
- Archiving is a **manual operator action** (implemented, follow-up):
  `POST /api/knowledge/item/:id/archive {teamId, archived}` →
  `/internal/knowledge/archive`. The orchestrator keeps a per-team archived-id set
  (`/workspace/knowledge-archived/<team>.json`), overlaid as `status:"archived"`
  onto the canonical files on every collector pass (durable across re-projections,
  same pattern as the promoted overlay), then re-projects + commits (git audit).
  It **refuses to archive a promoted entry** (it backs a skill — hiding it would
  erase the `promoted` edge). The Knowledge Flow view has a "Show archived" filter
  + an Archive/Unarchive button in the drill-down. Fully-automatic
  staleness/supersession detection stays out (fuzzy, little gain over the merge).

Git history of the `agent-knowledge` branch (canonical files) is the audit +
rollback for every archive, merge, and promotion stamp.

---

## 7. Autonomy gating — the full dial (levels 0–3)

| Level | Merge (canonical) | Suggestions (cards) | Auto-promote | Gates honoured |
|---|---|---|---|---|
| 0 — Off | — (no KB) | — | — | — |
| 1 — Share *(default)* | **yes** | — | — | — |
| 2 — Suggest | yes | **yes** | — (operator confirms) | — |
| 3 — Auto-curate *(Phase 4)* | yes | yes (for `review`-gated / over-cap) | **yes** (`auto` transitions, capped) | **yes** |

Levels 0/1/2 are byte-for-byte the Phase-3 behaviour — the `autoPromoteStep` and
the backstop timer are the only additions, both gated on level 3. Flipping to
level 3 with `team>team:review` gives "auto-merge + suggest-everything"; with
`team>team:auto` (default) it gives hands-off team-skill curation. Global is
review at every level.

---

## 8. Level-3 safety — decision e

| Property | How |
|---|---|
| **Idempotent** | Deterministic skill slug (`slugifySkillName`); skip write if `SKILL.md` exists; skip cluster if its stable candidate is `promoted`; canonical projection + stable candidate ids give no-churn re-runs (skip the commit when the tree is clean). |
| **Never blocks a run** | `autoPromoteStep` is wrapped best-effort inside `runConvergenceCollector`, which is itself wrapped in `emitKnowledgeHarvest` and never throws to the push. The backstop timer swallows per-team errors. |
| **Respects operator intent** | A `dismissed` candidate is never auto-promoted. `team>global` is never auto. Gates default conservative (global + agent→team = review). |
| **Audit** | Canonical entries stamped `status:"promoted"` and committed on `agent-knowledge` (git history); append-only `promotion` feed events (`promotedBy:"curator"`); `provenance.json` beside each skill. |
| **Rollback** | Revert the canonical commit and/or delete the skill dir; the shards (source of truth) are untouched, so re-running the collector rebuilds the canonical view. |
| **Candidate lifecycle** | open → promoted (auto or operator) / dismissed (operator). Auto-promotion creates-then-promotes via the stable id, so the level-2 store and the level-3 curator share one lifecycle with no double-raise. |

---

## 9. UI (KnowledgeFlow.jsx, additive)

- **Autonomy + gate controls** (team scope): a compact panel showing the team's
  autonomy level and the per-transition gate switches (`team>team`,
  `agent>team`; `team>global` shown as locked "review"). Toggling calls
  `PUT /api/knowledge/gates`.
- **"Needs review" edges + ghost skill nodes** for `review`-gated open candidates
  (§5.3), clickable → the existing `PromotionDialog`.
- **`promotedBy:"curator"`** surfaced in the provenance drill-down and on the
  promoted-skill node (a small "auto" chip) so an operator auditing after the fact
  sees which promotions the curator made vs. an operator.
- The existing `SuggestionsPanel` / `PromotionDialog` are reused unchanged for
  the review cards (auto-drafted candidates render there like any other).
- **Private skills panel (agent scope, follow-up):** lists the agent's
  agent-tier skills with a **Lift to team** action (agent→team), plus the
  "Show archived" filter + Archive/Unarchive in the drill-down (§6).

---

## 10. Test plan (pure cores only, per repo convention)

**`orchestrator/knowledge-curator.test.js`** (`node --test`) — the bulk:
- `resolvePromotionGates`: defaults; clamp unknown → `review`; `team>global`
  forced `review` even if stored `auto`; legacy env (no block) → defaults.
- `targetTransitionFor`: always `team>team` in v1.
- `planAutoPromotions`: below-threshold skipped; `promoted`/`dismissed` candidate
  skipped; `auto` gate → promote; `review` gate → `defer("gated")`; over-cap →
  `defer("over-cap")` (cap respected, remainder deferred, nothing lost);
  deterministic order; empty inputs → empty plan.
- `curatorSkillProvenance`: `promotedBy:"curator"`, `entryIds` present,
  `originAgents`/`convergence`/`sourceRefs`/`sessions` carried; shape matches
  `skillEntryIds` expectations.
- `curatorSkillDraft`: name slug; body has member texts + provenance footer; no
  secret fields (golden-compatible with `buildHeuristicSkillDraft`).
- `knowledgeCurationConfig` clamping + legacy defaults.

**`orchestrator/knowledge-store.test.js`** (additions):
- `knowledgeCurationConfig` (if co-located here) + `knowledgePromotionGates`
  normalization/clamp; `status:"archived"` accepted by `validateKnowledgeEntry`
  (already in the enum — assert).

**`admin-console/api/knowledge-graph.test.js`** (additions):
- `foldArchived`: an archived canonical entry drops from the active set; no
  archived records ⇒ identity (Phase-2/3 goldens unchanged); archived + a live
  same-id shard copy → last-writer-wins keeps it dropped; interaction with
  `foldMerges` (archived tombstone target).

**`admin-console/api/knowledge-suggestions.test.js`** (additions):
- `validatePromotion`: `agent→team` now ok; `team→agent`/`global→*`/unknown still
  error; `from:"agent"` still requires `entryIds ≥ 1` (provenance survives a lift).
- Gate helpers if any pure gate-resolution lands on this side.

**Not unit-tested** (convention): the curator's git IO / commit / push / skill
write, the backstop timer, the candidate-store IO, SSE, and React — verified
manually.

**Manual (documented in the PR):** run a 3-developer team at **autonomy 3** with
`team>team:auto`; watch the same fact converge (`conv=3`), then a **team skill
auto-appear** with `provenance.json` (`promotedBy:"curator"`), the `promoted` edge
draw, and a batched `promotion` feed pulse — with **no operator click**. Flip
`team>team` to `review`; confirm the next converged cluster raises a "needs
review" card + dashed edge instead of firing. Confirm a **dismissed** card is not
auto-promoted after the flip. Lift an agent-tier skill `agent→team` and confirm
provenance carries forward. Confirm `team>global` never auto-fires. Verify
level 2 behaviour is unchanged (no auto-promotion).

---

## 11. Files touched

**New:**
- `docs/knowledge-curation.md` (this doc).
- `orchestrator/knowledge-curator.js` (gate resolution + `planAutoPromotions` +
  curator draft/provenance, pure) + `knowledge-curator.test.js`.

**Edit:**
- `orchestrator/orchestrator.js`: `autoPromoteStep` inside
  `runConvergenceCollector` (level ≥ 3); team-skill write (`/workspace/teams/...`,
  guarded path); the daily backstop timer at boot; `/internal/knowledge/gates`.
- `orchestrator/knowledge-store.js`: `knowledgeCurationConfig(env)` +
  `resolvePromotionGates`/`knowledgePromotionGates` normalization (or in the
  curator module); confirm `archived` handling.
- `orchestrator/skill-source.js` / seed path: materialise
  `/workspace/agents/<id>/skills/` at seed.
- `admin-console/api/knowledge-graph.js`: `foldArchived` + wire into the gather
  path; ghost-node/pending-edge derivation lives in the route, not the pure core.
- `admin-console/api/knowledge-suggestions.js`: `validatePromotion` gains
  `agent>team` (skill-lift, provenance carried).
- `admin-console/api/api.js`: `GET/PUT /api/knowledge/gates`; `/api/knowledge/promote`
  `from:"agent"` lift branch; `POST /api/knowledge/item/:id/archive`;
  `GET /api/agents/:id/private-skills`; `?includeArchived=1` on the graph route;
  pending-edge/ghost-node in the graph route.
- `admin-console/src/pages/KnowledgeFlow.jsx`: autonomy/gate control panel,
  needs-review edges + ghost nodes, `promotedBy:"curator"` surfacing, "Show
  archived" filter + Archive/Unarchive in the drill-down, Private-skills panel
  (agent→team lift).
- `orchestrator/orchestrator.js` (archive, follow-up): archived-id store +
  `status:"archived"` overlay in the collector + `archiveKnowledgeEntry` +
  `/internal/knowledge/archive`.
- `agent-image/scripts/knowledge` + `test_knowledge.py` + `agent-image/CLAUDE.md`
  (follow-up): the `knowledge promote --to agent` verb (`build_agent_skill` /
  `slugify_skill_name`).

---

## 12. Out of scope (later / not built here)

- **Embeddings** for similarity — the `similarity()` seam is ready (Phase 3); the
  backend is still not built.
- **MCP knowledge sources** → Phase 5 (#464). The default path stays MCP-free.
- **Aggressive auto-archive / staleness detection** — Phase 4 ships the
  non-destructive `status:"archived"` mechanism + fold + a **manual** archive
  action (§6), but the curator never fires archiving on its own; rule-based
  supersession is a later refinement.
- **Curator LLM distillation on the hot path** — auto-promotion uses the heuristic
  draft; LLM polish stays operator-initiated (level 2).
- **Single-writer shard compaction** — deliberately rejected (decision b).
