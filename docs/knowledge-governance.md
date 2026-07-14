# Human-in-control knowledge governance

Reference for the operator-control layer added on top of the Shared Agent
Learning & Knowledge Flow (`docs/knowledge-sharing-concept.md`, Phases 0–4). The
learning pipeline (harvest → team KB → convergence → promotion → skill) was fully
automated and richly **observable**, but the human had almost no **controls**: the
autonomy dial could only be changed by hand-editing `environment.json`, there was
no checkpoint before a harvested fact entered the shared KB, per-item veto was
buried in the drill-down, and knowledge could only flow *up* (agent→team→global),
never sideways. This layer closes those gaps. Everything here is **additive and
default-off/identity** — a team that touches none of it behaves exactly as before.

Product framing (the four goals it serves):

1. *The system says when it has learned* — already delivered (live feed, badges).
2. **The human can control the learning in parts, or at least monitor it** — the
   autonomy dial is now a real control; a per-item veto sits on the card.
3. **Knowledge can be routed between agents across stages, in other directions** —
   directed cross-team sharing (lateral), not only the up-ladder promotion.
4. **Not a pure automatism — the human may consciously intervene, with full
   transparency** — the autonomy dial + supervised-review mode.

---

## 1. Autonomy dial as a first-class control

The `knowledgeAutonomy` 0..3 dial (Off / Share / Suggest / Auto-curate,
`orchestrator/knowledge-store.js` `knowledgeAutonomyLevel`) was read everywhere
but **settable nowhere in the UI**. Added:

| Method + path | Where | Purpose |
|---|---|---|
| `PUT /api/knowledge/autonomy` `{ teamId, level }` | admin-console | Set the dial (0..3), membership-scoped, proxied. |
| `POST /internal/knowledge/autonomy` | orchestrator | `writeTeamAutonomy` — writes the team's autonomy level to the per-team config file (`/workspace/teams/<teamId>/knowledge-config.json`), leaving the shared env untouched. |

`GET /api/knowledge/gates` already returned the level; the Knowledge Flow
**Configure knowledge** slide-out panel (`ConfigurePanel` in `KnowledgeFlow.jsx`,
opened via the *Configure knowledge* button on the page) renders a 0..3 selector
with a plain-language description per level, together with the review toggle,
promotion-gate switches, and storage settings in one unified surface (PR #569). Orchestrator-side effects (convergence / suggestions /
curation) read the env fresh each collector pass, so a change takes effect
immediately; the agent-side harvest hint + KB provisioning are read at spawn/seed,
so a running agent picks the change up on its next rebuild (the panel says so).

## 2. Supervised-review mode (approve before it enters the shared KB)

`knowledgeReview: boolean` stored in the per-team config file
(`/workspace/teams/<teamId>/knowledge-config.json`, overlaid onto the shared env
at every read via `mergeTeamKnowledgeConfig` — so two teams sharing one env can
each have independent review settings). Default **false** = today's behaviour
byte-for-byte; `knowledgeReviewEnabled(env)`, tolerant of the strings
`"true"`/`"1"`). Orthogonal to the autonomy dial: the dial gates *how much
automation* acts on knowledge, review gates *what enters the curated KB at all*.

**Mechanism — the same durable status-overlay pattern as archived (§6 of the
curation design), so it inherits its proofs:**

- Per-team decision store `/workspace/knowledge-review/<team>.json` —
  `{ <canonicalId>: "approved" | "rejected" }`. An id absent from the map is
  **pending** while review is on.
- In `runConvergenceCollector`, when review is on, each canonical entry that is
  not `approved` is overlaid `status:"pending"` (rejected → `status:"rejected"`)
  in the canonical `<kind>.jsonl` — a **status-only** overlay (no synthetic
  timestamp), exactly like the archived overlay. Two new reserved statuses in
  `knowledge-store.js` `STATUSES`. Shards (the source of truth) are **never**
  touched — held knowledge is a property of the derived canonical view only. The
  overlay is a pure function of shards + the decision map, so re-runs are
  byte-identical (no git churn).
- The graph builder folds them out of the **active** graph with a new pure
  `foldReview` (`admin-console/api/knowledge-graph.js`; `foldArchived` and
  `foldReview` now share one `foldByStatus` core — identity when no matching
  status is present, so non-review teams are byte-identical). It decides per id by
  the latest copy; where a held canonical copy ties with its own active shard copy
  on time, the canonical copy wins because the reader (`kbReadStore`) appends it
  after the shards and the tie-break keeps the last seen. Held entries surface only
  in the **review queue** (`selectReviewQueue`).
- The held set also **gates the downstream pipeline**: the collector filters
  held clusters out of the suggestion / auto-promotion planning, so un-reviewed
  knowledge can never become a skill.
- The **agent runtime honours the same fold**: `knowledge search` / `list` run
  their entries through a pure `visible_entries` (`agent-image/scripts/knowledge`,
  the mirror of the graph folds — dedup by id + drop `merged`/`archived`/`pending`/
  `rejected`), so a held fact never reaches a teammate's query either, not only the
  operator's view. (This also fixes a pre-existing gap where archived/merged/
  duplicate lines leaked into `knowledge search`.)

| Method + path | Where | Purpose |
|---|---|---|
| `PUT /api/knowledge/review-mode` `{ teamId, enabled }` | admin-console | Toggle the mode. |
| `GET /api/knowledge/review-queue?team=<id>[&include=rejected]` | admin-console | The pending (and optionally rejected) entries, with provenance. |
| `POST /api/knowledge/item/:id/review` `{ teamId, decision }` | admin-console | `decision ∈ approved \| rejected \| reset`. |
| `POST /internal/knowledge/review-mode`, `/internal/knowledge/review` | orchestrator | `writeTeamReview`, `reviewKnowledgeEntry` (re-project + commit, best-effort). |

**Grandfathering.** Turning review **on** first baselines every existing canonical
id as `approved` (`baselineReviewApprovals`), so the switch holds only knowledge
learned *after* it — it never retroactively yanks facts the team already relies on
into the queue. This mirrors the github-poller's "first poll re-baselines, no
flood" discipline.

**Scope boundary.** Review gates the **curated shared knowledge** — the canonical
team KB the UI shows, what promotions draw from, and what `knowledge search` /
`list` surface (the reader folds held/archived/merged out, see above). A held
fact's raw shard line still lives in git as the append-only audit log, and
`knowledge path "<id>"` can still locate it by id (inspection is deliberately not
folded), but it is invisible to the "what does the team know" queries and to the
promotion pipeline until approved. This is the intended guarantee — the human
approves before the knowledge is shared.

## 3. One-click per-item veto (retire on the card)

Archiving a learned fact was only reachable three clicks deep in the provenance
drill-down. The item card in the Knowledge Flow now carries a hover-revealed
**Retire** button (`Archive` icon) that runs the existing
`POST /api/knowledge/item/:id/archive` behind a confirm — non-destructive
(kept in git, un-retirable), disabled for a promoted entry (it backs a skill).
Reuses the archived overlay; no new backend.

## 4. Directed cross-team sharing (lateral knowledge flow)

Promotion moves knowledge **up** the ladder (agent→team→global). Sharing moves it
**sideways**: an operator copies an existing skill from the global pool, or one
team's pool, into **another specific team's** pool — so a lesson learned in one
team/stage reaches another directly, without the broad blast radius of a
promote-to-global. Always operator-initiated (never automated).

| Method + path | Where | Purpose |
|---|---|---|
| `POST /api/knowledge/share-to-team` `{ from: "team"\|"global", sourceTeamId?, name, targetTeamId }` | admin-console | Copy the skill into the target team's pool, provenance preserved + stamped `sharedFrom`/`sharedBy`/`sharedAt`. |

Pure `validateShareToTeam` + `buildShareProvenance` in
`admin-console/api/knowledge-suggestions.js` (unit-tested): the target must differ
from the source; containment-guarded source/dest dirs (reuses `safeTeamSkillDir` +
the pool-skills guard from `promote`); the source skill's `entryIds`/`originTeamId`
carry forward so the graph's T1→T2 edge + the drill-down still resolve. In the UI a
skill node is clickable → **Share to team** dialog (`ShareDialog`) with a target
picker.

---

## Autonomy × review matrix

| | review off (default) | review on |
|---|---|---|
| **0 Off** | nothing shared | nothing shared (review inert) |
| **1 Share** | harvest → shared KB immediately | harvest → **review queue** → approve → shared KB |
| **2 Suggest** | + convergence cards | held facts don't reach cards until approved |
| **3 Auto-curate** | + auto-promotion within gates | held facts aren't auto-promoted until approved |

## Files touched

- **New:** `docs/knowledge-governance.md` (this doc).
- **Edit — pure cores (unit-tested):** `orchestrator/knowledge-store.js`
  (`STATUSES` += `pending`/`rejected`, `knowledgeReviewEnabled`);
  `admin-console/api/knowledge-graph.js` (`foldReview`, `selectReviewQueue`,
  `pending`/`rejected` on `toItem`, folded into `buildKnowledgeGraph` +
  `summarizeKnowledge`); `admin-console/api/knowledge-suggestions.js`
  (`validateShareToTeam`, `buildShareProvenance`).
- **Edit — IO:** `orchestrator/orchestrator.js` (`writeTeamAutonomy`,
  `writeTeamReview`, review-decision store + `reviewKnowledgeEntry`, review overlay
  in `runConvergenceCollector` / `_serializeCanonicalKind`, three internal
  endpoints); `admin-console/api/api.js` (the five routes above + `review` on the
  gates GET + `knowledgeReviewOn`).
- **Edit — UI:** `admin-console/src/pages/KnowledgeFlow.jsx` (autonomy selector +
  review toggle in `ConfigurePanel`, `ReviewQueuePanel`, item-card `Retire`,
  `ShareDialog`); `admin-console/src/theme/tokens.css` (hover-reveal for the retire
  button).

## Testing

Pure cores unit-tested per repo convention (`node --test`): the review folds +
queue selector (`knowledge-graph.test.js`), the share validator + provenance
(`knowledge-suggestions.test.js`), the review-mode accessor
(`knowledge-store.test.js`). The IO (env writes, review-decision store, the
overlay in the collector, git commit/push) and React are verified manually, as
elsewhere in this subsystem.

**Manual:** on a team, set autonomy in the panel and confirm it persists; turn on
supervised review, harvest a fact, see it land in *Awaiting your review* (not the
Team lane), approve it and watch it flow into the KB; retire an item from its card
and confirm it leaves the active graph but survives in git; share a global skill
into another team and confirm it appears in that team's global lane with
`sharedFrom` provenance.
