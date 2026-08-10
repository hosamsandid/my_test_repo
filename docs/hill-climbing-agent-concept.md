# Hill-Climbing Loop — Concept

> Status: **concept / plan of record** — epic #1219; implementation split into #1221–#1226
> (Phase 1 measure: #1221/#1222/#1223 · Phase 2 propose: #1224/#1225 · Phase 3 validate: #1226;
> Phase 4 deliberately unticketed).
> Relates to: flow reconciliation (`docs/flow-reconciliation-concept.md` — Layer 3 detector shipped,
> Phase-4 responder is design), knowledge curation (`docs/knowledge-curation.md` — autonomy dial,
> review cards), prompt version history (`docs/prompt-version-history-concept.md`, #990 — the undo
> substrate), token telemetry (`docs/cost-per-pr-concept.md`, #643), agent outcomes
> (`docs/agent-outcomes-concept.md`, #784), loop triggers (`docs/loop-triggers-concept.md`).
>
> Terminology: "hill-climbing loop" is the fourth level of the loop-engineering stack — *agent loop*
> (get it done) → *verification loop* (get it right) → *event-driven loop* (get it running
> continuously) → *hill-climbing loop* (get it **better over time**): an analysis pass over
> production traces whose findings rewrite the harness — prompts, triggers, wiring, thresholds —
> so the next runs produce better traces.

## 1. Problem

The stack already implements the first three loops:

| Loop | Our implementation |
|---|---|
| Agent loop | per-agent runner (`agent-entrypoint.py`): DM turns + triggered runs |
| Verification loop | loop-trigger `verify` gates (never self-graded on a team), reviewer roles, human gates |
| Event-driven loop | `github-event`/`cron`/`once`/`http`/`loop` triggers, poller, claim labels, anomaly detector |

The fourth loop does not exist. Today "getting better over time" happens in exactly two forms,
both with a blind spot:

1. **Knowledge-side self-improvement** (learn-hints → `memory/log.md`, convergence collector,
   curator, skill promotion) improves *what agents know*. It never touches *how the harness is
   configured*: a wake instruction that agents systematically misread, a flow with a missing
   escalation edge, an anomaly threshold that cries wolf daily — none of these are knowledge
   problems, and the curator will never fix them.
2. **Human trace-reading.** The evidence exists — session logs, the event-transparency log, the
   anomaly sweep, claim-label lifecycles — but connecting "the Reworker's PRs need 3.2 review
   cycles on average" to "its prompt is missing the lint step" is manual archaeology across four
   log surfaces that nobody performs routinely.

The sharpest version of the gap: the flow-anomaly Phase-4 responder (reaction ladder, still
design) will repair *individual* stalls — re-toggle a label, nudge a human. But when the **same**
anomaly recurs weekly because its cause is structural (the #949 dead-end was a *flow-design* bug —
no escalation edge from "merge conflict" to the Reworker), instance repair treats symptoms
forever. Nothing aggregates recurring anomalies, failure rates, rework cycles, or token burn into
**one reviewed change to the configuration** that makes the class of incident stop happening.

## 2. Positioning — three improvement mechanisms, disjoint by design

| | Knowledge curator (#463) | Anomaly responder (Phase 4, design) | **Hill-climber (this concept)** |
|---|---|---|---|
| Input | converged KB entries | one flagged anomaly, now | **aggregated run metrics over a window** |
| Output | team skill / review card | label toggle, nudge DM | **improvement card → harness config change** |
| Changes | knowledge tier | GitHub object state | **prompts, triggers, ports, thresholds** |
| Cadence | on KB push + daily backstop | per sweep | **daily (configurable) per team + manual run** |
| Never does | edit prompts/triggers | edit config | **repair a single stalled object** |

The three compose: the responder keeps today's flow running, the hill-climber makes next month's
flow need fewer repairs, the curator grows what the agents know. Where the hill-climber's analysis
surfaces *knowledge* (a recurring lesson, not a config defect), it hands off to the curator's
candidate machinery instead of duplicating promotion (§5, class 5).

## 3. Architecture — deterministic collector, LLM analyst, gated applier

Same split discipline as Layer 3 ("deterministic detector, intelligent responder") and the curator
("no LLM on the hot path"): almost everything here is countable, and the LLM only ever sees
pre-digested aggregates plus the exceptions worth reasoning about.

### 3.1 Metrics collector (pure code, orchestrator-side)

A new pure module `orchestrator/hill-climb-metrics.js` + an I/O adapter (sibling pattern:
`flow-anomaly-detector.js` / `flow-anomaly-sweep.js`). It folds **existing** log surfaces into a
per-team run ledger keyed by `(agentId, triggerId)` — no new instrumentation in the agent image:

| Signal | Source (already produced today) |
|---|---|
| Run outcome (success / failed / retried / user-aborted / `[PASS]`) | session JSONL wrapper events (`claude.invoke`, `error`, `trigger.retry`, `message.posted`), correlated by `correlationId` |
| Run duration, tokens per run (4 token classes, per model) | session JSONL `result` events (pre-#643; switches to the telemetry store when it ships) |
| Wake→claim latency, claim→completed duration, rollback count | event-transparency log — the `:wip`/`:completed`/rollback `labeled` events are recorded for free (flow-reconciliation §3.5) |
| Anomaly recurrence per class per object | **scheduled** anomaly sweeps (new: §3.4 — today the sweep is on-demand-only and unpersisted) |
| Dropped/throttled/digested events, `noMatchingTrigger` | event-transparency log outcomes |
| Rework cycles per PR (`revisions-required` round-trips), time-to-merge | event-transparency log label/PR events |
| Config-version boundaries (which prompt/trigger version produced which runs) | audit trail + `.agent-studio/prompt-history.json` (#990) timestamps |

The orchestrator mounts the workspace, so it reads every agent's session log directly — this is
also *why* the analyst cannot be an ordinary team-member agent: workspace isolation (correctly)
prevents any agent container from reading sibling session logs. The collector runs on a per-team
schedule (**default daily**, staggered like the role-template curation crons) and can be
**triggered manually at any time** via `POST .../hill-climb/run` (§7) — a manual run executes the
identical collector+analyst pass, so there is exactly one code path. Each pass persists a snapshot
to `/workspace/teams/<teamId>/hill-climb/metrics/<date>.json` (day-keyed; a same-day manual re-run
overwrites that day's snapshot, so window comparison is unaffected). Snapshots are the **baseline
mechanism**: every later "did the change help?" question is answered by comparing snapshots across
a config-version boundary (§6). Skipped during maintenance mode, like the sweep.

### 3.2 Analyst (LLM, server-side one-shot — not a resident agent)

The analyst receives the digest (aggregates + top-K evidence excerpts per finding, capped ~10k
tokens) and returns **improvement cards** (§5) as validated JSON. It runs as a server-side
stateless call via `resolveGenerationTarget` (the `agent-prompt/generate` / `port-suggestion` /
copilot pattern — prefers a Sonnet-class Model Provider, skips `oauth-token` providers), not as a
spawned agent container:

- **Structurally necessary**: the evidence lives across all member workspaces; only the
  orchestrator sees it all (see §3.1). Pre-digesting keeps the LLM input small and secret-free.
- **Zero blast radius**: no Matrix user, no workspace, no triggers — the analyst cannot act, only
  emit cards. All *acting* goes through the gated applier.
- **Honest fallback**: with no reachable provider the pass still ships its deterministic findings
  (never-fired triggers, threshold misfits, recurrence counts) as heuristic cards — degraded, not
  dead, mirroring `port-suggestion.js`'s keyword fallback.

Each card must cite its evidence (metric values + session-log/event references) and name the
**metric it expects to move**. A card without a measurable target is invalid — the schema enforces
the closed loop.

### 3.3 Applier — gated, through existing choke-points only

Cards never write config directly. Each card class declares an **apply path** that is an existing
audited console endpoint, so every application is captured by the machinery we already trust:

| Card class (§5) | Apply path | Undo |
|---|---|---|
| prompt-improvement | the three #990 prompt choke-points | prompt-history rollback |
| flow-wiring | `PUT /api/agents/:id` ports (`emits`/`channels`/outcomes) → reconcilers re-derive triggers | port edit (reconcilers are idempotent) |
| threshold-tuning | `PUT /api/agents/:teamId` (`anomalyThresholds`, `hillClimb.*`) | previous value stored on the card |
| trigger-hygiene | `DELETE /api/agents/:id/triggers/:tid` (never touches `intrinsic: true`, `dataFlow`, `channel`, or human-gate listeners) | card retains the deleted trigger JSON |
| knowledge-handoff | curator candidate store | curator's own review flow |

Application is governed by a per-team **autonomy dial** `hillClimb.autonomy`, deliberately shaped
like the curator's (§0a of `knowledge-curation.md`), with a harder ceiling:

- **0 — off**: collector may run (metrics page), no analyst, no cards.
- **1 — report**: analyst runs, cards are raised for reading; applying is a manual config edit.
- **2 — propose + one-click** *(default)*: each card carries an Apply button that executes its
  apply path as the acting human (`req.user` → audit + prompt-history attribution).
- **3 — auto-apply (restricted)**: **not in v1.** When it ships (§8 phase 4) it covers only
  `threshold-tuning` — the one class that is numeric, reversible, and cannot change agent
  behavior mid-run. Prompt and wiring changes remain human-gated at every level, permanently:
  a self-rewriting prompt is exactly the runaway the platform's gate philosophy exists to prevent.

Budget rules (curator discipline): at most `maxCardsPerPass` (default 5) new cards per pass; at
most one **open** card per `(object, card-class)` — a re-detected finding bumps the existing
card's evidence instead of duplicating; a cooldown (default one full window) after an applied
change on the same object, so consecutive changes never contaminate each other's measurement.

### 3.4 Prerequisite: persist the anomaly sweep

Today `GET /api/teams/:teamId/flow-anomalies` computes and discards. The hill-climber needs
recurrence, so the collector schedules the existing sweep (same cadence class as the poller,
e.g. hourly) and appends results to
`/workspace/teams/<teamId>/hill-climb/anomaly-history.jsonl` (7-to-90-day retention, like the
event log). This also benefits the Phase-4 responder — "third sighting" in its reaction ladder
needs the same history — so it ships as a shared substrate, not a hill-climb private.

## 4. What "better" means — the metric catalog

The analyst optimizes against a small, fixed catalog (per team, per `(agent, trigger)` where
applicable). v1 metrics, all derivable from §3.1 sources:

1. **Run success rate** — completed / fired (excl. `[PASS]`); retries and rollbacks counted.
2. **Rework ratio** — `revisions-required` cycles per merged PR.
3. **Time-to-done** — wake label → `:completed` (or merge) per chain, p50/p90.
4. **Anomaly recurrence** — sightings per class per object per window.
5. **Waste** — tokens spent on failed/aborted/`[PASS]` runs; throttle drops; digest folds.
6. **Dead config** — triggers with zero fires over the horizon; emitted labels nobody consumes
   (the advisory lints, now backed by observed counts instead of pure topology).

Explicitly **not** a metric: any LLM-judged "quality score" of agent output. Verification quality
belongs to the verification loop (reviewer roles, `verify` gates); the hill-climber only reads its
*outcomes* (rework ratio). Keeping the catalog observational keeps the loop honest — a metric the
system can game (e.g. "fewer anomaly cards") is never a target, only evidence.

## 5. Improvement-card classes

1. **prompt-improvement** — evidence: recurring `output-missing` on one agent, high rework ratio,
   wake instructions that runs demonstrably misread (session-log excerpts). Proposal: a concrete
   prompt diff (rendered against the current #990 version). The card shows the diff, never
   auto-merges it.
2. **flow-wiring** — evidence: a recurring anomaly whose cause is topological (the #949 class: an
   outcome with no consuming edge; duplicate listeners triple-waking one agent; a label listener
   with stall history but no `claim`). Proposal: a port/outcome change. This is the
   data-driven upgrade of the advisory lints: same vocabulary, but "this dead-end stalled 4 real
   PRs this month" instead of "this looks odd".
3. **threshold-tuning** — evidence: observed latency distributions vs. configured
   `anomalyThresholds` (T₁ flags 40% of healthy wakes → raise; p90 claim duration far below T₂ →
   lower), throttle/burst constants vs. drop counts.
4. **trigger-hygiene** — evidence: never-fired triggers past the horizon, crash-looping triggers
   (rollback → re-fire → rollback), always-`[PASS]` triggers burning tokens. Proposal: delete,
   re-scope events, or tighten the `labelFilter`.
5. **knowledge-handoff** — evidence: the same lesson recurring in multiple members' `log.md` /
   failure DMs. Proposal: a candidate for the **curator** — the card links into the existing
   promotion machinery and closes there.

## 6. Measurement and rollback — closing the loop

A hill-climb without measurement is just opinion drift. Every applied card records: apply
timestamp, config-version reference (prompt-history entry id / previous value), baseline window
snapshot, and its declared target metric. The first daily pass after a full window has elapsed compares
target-metric before/after **across the config boundary** (audit + prompt-history give exact
boundaries, so runs are attributed to the version that produced them):

- **Improved / neutral** → card closes as `validated` / `neutral` (neutral after two windows
  auto-closes; the change stays).
- **Regressed** → the card flips to a **rollback card** citing both windows; applying it executes
  the undo path (§3.3). Rollback is always a human click, symmetric with the curator's retire
  doctrine — even a future autonomy-3 never auto-reverts a prompt, because a revert *is* a prompt
  change.

Low-volume honesty: a team with 6 runs per window cannot support before/after claims. Below
`minRunsPerWindow` (default 20) the comparison reports `insufficient-data` instead of a verdict,
and the analyst is told the sample size — cards on thin evidence must say so.

## 7. Data model & surfaces

- `/workspace/teams/<teamId>/hill-climb/` — `metrics/<date>.json` (snapshots),
  `anomaly-history.jsonl` (§3.4), `cards.json` (statuses: `open` / `applied` / `validated` /
  `neutral` / `regressed` / `rolled-back` / `dismissed` / `superseded`). An applied card carries a
  `verdict` once measured (§6) and a `rollback` offer once it regresses.
- Team-agent config: `hillClimb: { autonomy: 0|1|2, cron?, maxCardsPerPass?, minRunsPerWindow?,
  windowDays?, excludeAgents?: [] }` — carried on the team agent like `stages`/`labels`/
  `anomalyThresholds`, round-tripped through export/materialise/Edit-as-draft **except** any
  applied-card state (config travels, history doesn't). `cron` overrides the daily default; the
  **measurement window** (`windowDays`, default 7) is deliberately independent of the pass cadence
  — passes run daily over a rolling window, so a verdict always rests on a week of runs even
  though findings surface within a day.
- API: `GET /internal/teams/:teamId/hill-climb/{metrics,cards}`, `POST .../cards/:id/{apply,dismiss,rollback}`
  (proxied under `/api/teams/...`; `rollback` re-runs a regressed card's undo through the same
  audited choke-point as its apply, then stamps a fresh cooldown — §6); `POST .../hill-climb/run` fires a **manual pass** — same code
  path as the daily schedule, guarded by a per-team single-flight lock (a second POST while a pass
  runs returns `409 pass-running`, mirroring the sweep's best-effort discipline) and audited like
  every mutating `/api` call.
- UI: an **Improvements** panel in the Flows view — toolbar sibling of **Anomalies** (live team
  scope only): metric tiles with trend, card list with evidence links (session log deep-links via
  `correlationId`, event-log rows, anomaly history), Apply/Dismiss, a **Run now** button (manual
  pass + refresh, the Anomalies-panel Refresh pattern) with last-pass timestamp, and a closed-card
  ledger that doubles as the change log of "what the loop learned".

## 8. Rollout

1. **Phase 1 — measure** *(shipped — #1221/#1222/#1223)*: collector + scheduled anomaly-sweep
   persistence + metrics tiles. No LLM, no cards.
2. **Phase 2 — propose**: analyst + cards at autonomy 1/2, apply via existing choke-points.
   **Apply endpoint live (#1225):** `trigger-hygiene` is the first wired class (deterministic
   heuristic, existing `DELETE /api/agents/:id/triggers/:tid` choke-point); `prompt-improvement`,
   `flow-wiring`, `threshold-tuning`, and `knowledge-handoff` apply paths land as follow-ups on
   the same engine. `prompt-improvement` also depends on #990 (prompt history) for its undo path.
3. **Phase 3 — validate** *(shipped, #1226 — backend)*: the daily pass runs a verdict step
   (`hill-climb-verdict.js`) that compares each applied card's target metric before/after, but only
   over a window lying entirely past the config boundary (never one spanning two versions);
   improved → `validated`, regressed → a rollback card, neutral → `neutral` (finalised after two
   windows), thin sample → `insufficient-data` (deferred, never guessed). A regressed card's
   rollback re-runs its undo through the apply choke-points and re-arms a fresh detection window
   (`rolled-back` + cooldown). The Improvements-panel verdict badges + rollback surfacing follow as
   a frontend change once this backend and the #1223 panel are both on `main`.
4. **Phase 4 — restricted autonomy 3**: auto-apply for `threshold-tuning` only, hard-gated until
   the Phase-3 verdict machinery has a full quarter of telemetry (the curator's decay-gate
   precedent).

## 9. Open questions

- **Cross-team learning**: a validated card ("reviewer prompts need an explicit lint step") is
  team-scoped; should validated prompt-improvements feed a global pattern library (System-Admin
  reviewed, like `team→global` skill promotion)?
- **Flow-instance evolution**: #643 §3.3's per-issue flow instances would make A/B comparison
  natural (route N instances through the changed config, N through the old). Out of scope until
  instances exist; the window-comparison design must not preclude it.
- **Analyst cost accounting**: hill-climb passes consume tokens — they should appear in the #643
  telemetry under a reserved pseudo-agent id (`_hill-climb`) so the loop's own cost is visible in
  the metrics it reports.
- **BP world**: everything here targets team flows. Whether orchestrator/bp-instance runs join the
  ledger (ACE has its own `ace:cost` and quality-gate machinery) is deliberately unresolved.
