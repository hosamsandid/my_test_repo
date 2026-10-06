# Flow Control — loss-free ticket routing, a live board, and a supervising orchestrator

> Status: **concept / design of record**. No code yet. This document is the
> proposal the discussion in issue *(TBD — the Flow Control epic)* is scoped
> against. It builds on the already-shipped stall-detection machinery
> (`docs/flow-reconciliation-concept.md`) and is, in effect, the concrete
> design for that document's unbuilt **Phase 4 (the responder)** plus the two
> surfaces it never had: a ticket board and a central human inbox.

## 1. The problem, from a real stall

The team **Agent Studio 2.0** dispatches an epic across a pool of developer
lanes. The observed flow:

```
business-analyst → (human gate: ready / ready-2 / ready-3 …) → developer → PR
    → code-reviewer → [revisions-required → reworker] → documentation-sync: ready-to-merge
    → merger: merge PR → issue closes → orchestrator: dispatch next ticket (set next ready-N)
```

Dispatch is **multi-lane**: the orchestrator advances a lane by setting the
next `ready-N` label when an issue on that lane closes. Lanes run in parallel,
which is the whole of the parallelism.

On 2026-09-08 the pipeline flowed cleanly for hours (a merge roughly every
20–30 min) and then stalled. Four PRs sat open and `CONFLICTING` against
`main` (#2094, #2098, #2105, #2109); their issues never closed; the lanes they
belonged to went silent; no downstream P3/P4/P6 ticket was ever dispatched.
The operator's only recourse was to trace each PR by hand, resolve conflicts,
merge manually, and re-kick the chain.

Three compounding failure modes, each independently sufficient to freeze a lane:

1. **Advancement is coupled to a single fragile signal — `issues.closed`.**
   The orchestrator's *only* trigger is `github-event` on `issues.closed`. An
   issue closes only when its PR merges. So the forward motion of an entire
   lane is coupled to a merge succeeding — with no timeout, no alternative
   path, and no "this ticket has been stuck at merge for N hours" signal.

2. **Unbounded parallel dispatch manufactures the conflicts.** The orchestrator
   fed *several* tickets in at once — the multi-lane `ready` / `ready-2` /
   `ready-3` … design — so multiple PRs were open against one shared `main`
   simultaneously. Every merge advances `main` and makes the other open PRs
   conflict, and no role owns "keep the open PRs mergeable". The conflicts were
   not bad luck; they were the **inevitable product of admitting more
   work-in-progress than a single shared branch can absorb**. (One of the four
   also had a red CodeQL check.)

3. **The claim-label state machine masks the stall (`false-completed`).** The
   claim mechanism swaps `<label>` → `<label>:wip` → `<label>:completed` on
   *normal run completion* — it tracks the *run*, not the *outcome*. A merger
   whose prompt was an unfilled template (`<Describe what Merger should do.>` …
   "Reply `[PASS]`") completes normally without merging, and the label swaps to
   `ready-to-merge:completed`. On GitHub the PR then *reads* "done" while it is
   open and conflicting. (Two roles in the observed team carried unfilled
   template prompts, and two more had no triggers at all — the flow was partly
   disconnected by construction.)

### 1.1 Why the existing detector does not catch it

`orchestrator/flow-anomaly-detector.js` already classifies four stall classes —
`wake-not-claimed` (T₁ 15 min), `claim-stalled` (T₂ 2 h), `output-missing`,
`gate-idle` (T₃ 24 h) — with per-team `anomalyThresholds` overrides, persisted
hourly to `/workspace/teams/<id>/hill-climb/anomaly-history.jsonl`
(`orchestrator/anomaly-history.js`). But it reasons **only over label state,
label age, and run/session state**. It is blind to exactly this stall:

- The sweep (`orchestrator/flow-anomaly-sweep.js`) projects each PR down to
  `{kind, number, state, merged, labels[], linkedPrNumbers}` and **the `merged`
  boolean is never consumed by any class**. Nothing anywhere fetches a PR's
  `mergeable` / `mergeStateStatus` / CI check rollup / actual-merge status.
- `buildFlowModel` **filters every `:completed` label out of the state machine**
  as terminal, so a `ready-to-merge:completed` label registers as neither a wake
  nor a claim edge, and `output-missing`'s `stillWaiting` guard is `false`.

So a conflicting, unmerged PR carrying a `:completed` claim is invisible to all
four classes. And the detector is **observe-only** — the reaction ladder
(`docs/flow-reconciliation-concept.md` §4.2) is designed but unbuilt.

### 1.2 The structural root causes

Two, and they compound:

> **(a) No admission control.** The pipeline admits unbounded work-in-progress —
> as many tickets in flight as the dispatcher chooses to dispatch — onto a single
> shared branch. Parallel PRs against one `main` conflict by construction, so the
> conflict pile-up is manufactured upstream, at dispatch, not at merge.
>
> **(b) State is inferred, not observed.** The platform infers pipeline state
> from **labels and run-completion**, never from the **GitHub truth** (is the PR
> mergeable? merged? is the issue closed?), and the claim-forward swap is gated on
> the agent's `[PASS]`, not on an observable post-condition — so a stuck PR reads
> as done and the stall is invisible.

The two fixes are complementary and ordered by leverage. **(a) is cheaper and
prevents the failure**: bound work-in-progress and the conflicts never arise
(§4.0). **(b) catches the residue**: reconcile from GitHub truth so the stalls a
WIP limit does not prevent are seen and re-driven — **the work item, reconciled
from GitHub truth, is the unit of truth, not the label** (§4.1 onward).

## 2. Goals

1. **Loss-free routing** — a ticket cannot silently fall out of the pipeline;
   every ticket is always in a known state, and a stall is detected and either
   auto-remediated or escalated, never dropped.
2. **A live board** — one glance answers *which ticket is where, in what state,
   owned by which agent, and how long it has been stuck*.
3. **A supervising orchestrator** — re-drives mechanically-recoverable stalls on
   its own, and escalates only genuine human decisions.
4. **One central human inbox** — everything waiting for a human, ranked, with the
   specific decision and a deep link, pushed to the human rather than discovered.

Non-goals (explicitly): auto-resolving semantic merge conflicts, force-merging,
overriding a human gate, or closing work without a human's say. The supervisor's
autonomy is bounded to mechanically-safe, reversible acts.

## 3. Design principles

- **Prevent before you detect — bound work-in-progress.** The cheapest stall is
  the one that never happens. Admission control (a WIP limit / serial dispatch)
  removes the *class* of conflict-pile-up failure at the source; the detection,
  re-drive and surfacing machinery is for the *residual* stalls it cannot
  prevent, not the first line of defence.
- **Reconcile from evidence, don't infer from labels.** State is *derived* from
  the join of issue + PR(s) + flow-graph + run state; where the label appearance
  and the GitHub truth disagree, the disagreement is itself a first-class
  anomaly.
- **Build on the shipped machinery.** The detector's four classes, the
  `anomaly-history` substrate, the hand-off primitives, the netzplan board, the
  claim mechanism, `scope.js` authz — all reused. The new spine is the
  reconciler; almost everything else is wiring.
- **Deterministic spine, optional LLM judgment on top** — the platform's own
  hill-climb pattern (a deterministic detector with an optional LLM analyst).
  The reliable, cheap, non-hallucinating layer decides state and safe actions;
  an LLM agent handles the judgment calls it escalates.
- **Pure core + I/O adapter + endpoint + view**, mirroring
  `flow-anomaly-detector.js` / `flow-anomaly-sweep.js` and the `admin-console`
  pure-view convention. Every judgement worth asserting lives in a pure module.
- **Bounded, reversible, audited autonomy** — a closed allow-list of remediations,
  a budget of ≤1 automated repair per `(ticket, blocker-class)` per window, and
  every act rides an existing *audited* route.

## 4. The building blocks

### 4.0 Admission control — one ticket in flight (the cheapest, highest-leverage fix)

The stall did not begin at the merge; it began at *dispatch*. So the single most
effective fix is not to detect and clean up conflicts but to **not create them**:
bound the pipeline's work-in-progress.

- **A WIP limit on the dispatcher.** The dispatcher admits the next ticket only
  when the previous one is *truly done* (PR merged ∧ issue closed). At **WIP = 1**
  the epic flows strictly one ticket at a time and two PRs never race the same
  branch. A higher bound is possible where the work is genuinely independent, but
  for a single shared branch the safe default is one.
- **Seriality lives in an in-flight guard, not in the trigger.** Which event
  wakes the dispatcher is a *robustness* choice; whether it dispatches is a
  *logic* choice ("is anything already in flight? then hold"). Encoding seriality
  in the wake event — one dispatch per `issues.closed` — is exactly what froze the
  epic when a merge never landed.
- **Wake on a self-healing reconcile tick, not on the completion event.** A
  periodic `cron` reconcile (≈10 min) re-evaluates and advances; it does not
  depend on a completion event that, when a merge is stuck, never arrives. The
  completion event MAY be added as a latency accelerator, never as the only
  signal.
- **A stuck ticket parks the lane — it never opens a second front.** If the one
  in-flight ticket is blocked (conflict / red check / `needs-human`), the
  dispatcher flags it and holds rather than dispatching around it — which is what
  keeps one stall from becoming a pile-up.

This is a property of the *dispatcher's* own prompt and logic, so it needs **no
platform change** — it was applied to the observed team as Phase 0 (§6, §8). The
reconciler, supervisor, board and inbox below then handle the *residual* stalls a
WIP limit cannot prevent: a genuine conflict when two independent tickets do
touch the same file, a red check, a `stale-base` PR, a human decision. Admission
control removes the *manufactured* stalls; the rest of Flow Control catches the
*real* ones.

### 4.1 Reconciliation core — the ticket ledger

New pure module `orchestrator/ticket-reconciler.js` (sibling of
`flow-anomaly-detector.js`) + I/O adapter `orchestrator/ticket-reconcile-sweep.js`
that fetches the PR truth the current sweep deliberately drops: `mergeable`,
`mergeStateStatus`, CI check rollup, review decision, and issue↔PR linkage in
both directions.

Per work item it computes a **canonical lifecycle state**:

```
Backlog → Refining → Ready(dispatched) → In-Dev → In-Review → Rework → Doc → Mergeable → Merged/Done
```

plus an orthogonal **blocker with a stable reason code**:

| Blocker | Meaning |
|---|---|
| `conflict` | linked PR is `CONFLICTING` |
| `ci-red` | required checks failing |
| `approved-not-merged` | green + approved but still open past a threshold |
| `claimed-done-not-merged` | label says `:completed`, GitHub says open/unmerged — the `false-completed` |
| `unclaimed` | dispatched > T₁, no `:wip`, no run (subsumes `wake-not-claimed`) |
| `stalled` | no motion past threshold (subsumes `claim-stalled`) |
| `needs-human` | sits on a `humanGate` label (subsumes `gate-idle`) |
| `orphaned` | dispatched but no listener/owner resolvable |
| `superseded` | this PR's new files already landed in `main` — a duplicate of an already-merged twin (compute from file-set overlap) |
| `stale-base` | the PR text-merges cleanly but fails against *current* `main` because the model it was written against has since changed (e.g. its own tests reference a retired field) |

The output is a per-team **ticket ledger**: an array of
`{ticketId, title, epicId, lane, state, ownerAgentId, blocker?, reasonDetail,
ageInStateMs, prNumber, prState, evidence[], needsHuman}`. The four existing
anomaly classes fold in as one input signal; the `anomaly-history` substrate is
reused for recurrence / "third-sighting" detection.

Served observe-only first: `GET /api/teams/:id/tickets` → proxy
`GET /internal/teams/:id/tickets` (maintenance-gated, like the anomaly endpoint).

The `claimed-done-not-merged` class is the specific fix for the §1.1 blind spot:
it is the one class that compares the label's claim against the PR's real state.

### 4.2 Verify-before-claim — make labels stop lying

The claim-forward `:wip → :completed` is re-gated on an **observable
post-condition declared per label**, in `admin-console/api/process-template.js`
(the claim schema) and the runner (`agent-image/scripts/agent-entrypoint.py`):

| Label kind | Post-condition for `:completed` |
|---|---|
| merge label | linked PR **merged** and issue **closed** |
| review label | a review was **submitted** |
| PR-producing label | a PR **exists** for the work item |

If the run completes but the post-condition is false, the claim stays `:wip`
(so `claim-stalled`/the reconciler catches it) or is stamped a distinct
`:blocked` state carrying the reason. This converts the silent false-success
into a visible blocked state and is what makes the board and inbox trustworthy.
It is a platform-wide fix, independent of any one team's flow.

### 4.3 The Flow Supervisor — deterministic spine + optional LLM agent

**4.3a — Deterministic supervisor (platform mechanism).** A maintenance-gated
orchestrator timer (sibling of `runAnomalyHistorySweep`, overlap-guarded,
best-effort) that every N minutes:

1. runs reconciliation → ledger + blockers;
2. persists a ledger snapshot (extend `anomaly-history` or a new
   `ticket-ledger.jsonl`) for recurrence / third-sighting;
3. applies **bounded, allow-listed auto-remediations** through the *existing
   hands*, on the concept's observe → re-trigger → escalate ladder with the
   ≤1-repair-per-`(ticket, blocker)`-per-window budget:

   | Blocker | Safe automatic action | Primitive |
   |---|---|---|
   | `unclaimed` after T₁ | re-emit the wake label / wake the owning role | `github-label-applied` / `aee-wake` |
   | `claimed-done-not-merged` | roll the claim back to the raw wake label so the real step re-fires (never fabricate progress) | claim rollback |
   | `conflict` (behind only, cleanly updatable) | ask the owning developer/reworker to update the branch, with a specific note | `aee-wake` |
   | `ci-red` (transient) | re-run checks once; still red → escalate | GH re-run |
   | `issue-closed-but-successor-not-dispatched` | re-fire the orchestrator's dispatch | `github-label-applied` / `aee-wake` |

   The last row is the direct fix for §1 failure (1): advancement is driven off
   the *reconciled* "done" signal (PR merged ∧ issue closed ∧ post-condition
   verified), not the raw `issues.closed` webhook, and independent lanes proceed
   in parallel while only truly-blocked tickets are parked.

4. Anything outside the allow-list, a third sighting, or a judgment call
   (semantic conflict, CodeQL, review disagreement) → **one line in the human
   inbox** (§4.5) with the exact decision and a deep link. Never force-merge,
   never close, never satisfy a `humanGate` (the `hill-climb-apply-guard`
   precedent already forbids an agent satisfying a human gate).

The supervisor's hands already exist and are same-team-scoped and audited:
`aee-wake`/`POST /internal/wake-agent` (`orchestrator/wake-agent.js`),
`POST /internal/github-label-applied` (`orchestrator/github-label-fastpath.js`), and `performReassign`
(`orchestrator/pending-reassign.js`).

**4.3b — Optional LLM Supervisor agent (judgment layer).** A team role whose
triggers fire on the deterministic layer's escalations. It does the *judgment*
work the spine will not: attempt a real conflict-resolution commit *for human
review* (never a silent force-merge), summarise in one paragraph *why* a ticket
is stuck, propose lane prioritisation, and frame the human decision. It sits on
the reliable deterministic spine, so it can never hallucinate the pipeline
forward. This is the "orchestrator agent that takes care of the tickets" the
operator wants — but rooted, not free-floating.

### 4.4 The board — "Flow Control"

**Target:** a purpose-built admin-console page fed by the ledger endpoint.
Swimlane by lifecycle stage; each card is a ticket showing `#`, title, state,
owning agent, age-in-state, a blocker badge (`conflict` / `ci-red` /
`needs-human` / `stalled`), and deep links to issue + PR. A cross-lane epic
roll-up ("Epic #2041: 3 done / 4 blocked / 2 waiting"). Pure view decisions in
`admin-console/src/pages/process/flow-control-view.js`.

**Zero-frontend stopgap (available from Phase 1):** the supervisor mirrors the
ledger into the existing **netzplan** board via `aee-plan edit` — `status` and
`ownerId` are already modelled on graph nodes / swimlane lanes. netzplan already
gives per-team, id-keyed, non-interactive, audited, autonomy-gated writes; the
missing piece is exactly the event feed the supervisor supplies. (Requires the
board's autonomy raised to ≥ 2, a Team-Admin act, and it is bounded by the
`maxObjects` quota.)

### 4.5 The central human inbox

A single ranked "N need you" surface that aggregates every escalation path that
is scattered today — per-agent Matrix DMs (`trigger.lost` #506 markers,
`github-digest`, `throttle-warning`), `humanGate` / `needs-human` /
`human-decision-required` labels, `req:refine` gates, `AskUserQuestion` pauses,
and the reconciler's own `claimed-done-not-merged` / `conflict` / `ci-red`
blockers. Each row: ticket, blocker, the *specific* decision, a deep link, and —
where safe — a one-click action (approve merge, reassign, "resolved, re-fire",
answer). Delivery is the console page **plus a push into the human's own Matrix
room** (the per-human identity `@u-…:local` from #1458 now exists) and/or a
push notification, with a cross-team roll-up for an operator. This is the one
surface the operator asked for: *"tell me at one central place what needs me,
without my having to trace everything again."*

### 4.6 Authorization & hardening

The pending-queue read/cancel routes were ungated (flagged in-code for the #2041
P2 sweep); as operator surfaces they are now gated (#2119): the aggregated list
is cut to the agents the caller may manage (`canManageAgent`) and the WIP lanes
of teams they may manage (`canManageTeam`, the Force-dispatch gate), and
detail/cancel refuse an unmanageable agent — the pattern `performReassign`
already follows on both source and target (`admin-console/api/scope.js`). Every supervisor
action rides an already-audited hand-off route; the whole subsystem is
maintenance-gated.

### 4.7 Cross-lane merge coordination — the merge-queue (§4.0 across lanes)

§4.0 bounds work-in-progress *within* a lane. Running several lanes against one
shared `main` re-introduces the conflict at the **merge** point: N lanes each
holding one open PR means N PRs racing one branch, and every merge re-conflicts
the others — a reviewed, **passed** PR goes `CONFLICTING` again before it can
merge and the reworker chases a moving base (observed live with three lanes).
Serial-per-lane is **not** conflict-free.

So the supervisor (§4.3) must own the merge point as a **merge-queue / "merge
train"**:

- **Global merge-serialisation** — at most one PR is driven to `ready-to-merge`
  at a time across *all* lanes, so two PRs never race the same branch.
- **Auto-rebase after each merge** — once a PR merges, every other in-flight epic
  PR is rebased onto the new `main`, but **only** when the rebase is conflict-free
  or mechanically resolvable (docs/changelog); a semantic conflict is routed to
  the reworker, never force-resolved. Rides the audited reworker / `aee-wake`
  path; never a force-push over unpushed work.

This is the cross-lane analogue of admission control: §4.0 stops a lane racing
*itself*; §4.7 stops the lanes racing *each other*. Without it, more lanes add
conflict **thrash, not throughput** — the single shared `main` is the real
serialisation point.

## 5. What is reused vs. what is new

| Already shipped (the foundation) | New (the gap this concept fills) |
|---|---|
| anomaly detector (4 classes, thresholds), `anomaly-history.jsonl` | PR-truth sweep + `claimed-done-not-merged` reconciler class |
| hands: `aee-wake`, `github-label-applied`, `performReassign` (audited, same-team) | deterministic supervisor that drives them on a ladder + budget |
| netzplan board (status/owner fields, CLI writes) | the reconciliation event-feed behind it |
| claim mechanism (`:wip`/`:completed`/rollback) | verify-before-claim post-condition |
| human-gate semantics, DMs, Process-Canvas anomaly panel | one aggregated human inbox + push |
| the hill-climb "deterministic core + optional LLM analyst" pattern | applied to flow supervision |
| Phase-4 reaction ladder *design* in `flow-reconciliation-concept.md` | its implementation |

The supervisor's *eyes* and *hands* already exist. What is missing is the
ticket-centric spine that reconciles from GitHub truth, the two surfaces (board,
inbox), and the mechanism that actually moves the hands.

## 6. Phasing (highest-leverage / cheapest first)

- **Phase 0 — DONE, no platform code (and it validated the direction).** Applied
  to the observed team: **(a) admission control** — the orchestrator was rewritten
  from a multi-lane parallel dispatcher into a **serial dispatcher** (WIP = 1, a
  single `ready` lane, an in-flight guard, false-completed-aware) woken by a
  self-healing `cron` reconcile tick instead of `issues.closed`; **(b)
  verify-before-claim** in the merger's prompt (verify mergeable, merge only when
  green, route a conflict/red check back to rework rather than silently
  completing); **(c)** the reworker prompt filled and the business-analyst trigger
  wired. The four stranded PRs were triaged by hand — one merged, one `superseded`
  duplicate closed, two `stale-base` PRs handed back to the now-fixed reworker with
  precise reconciliation notes. This is acute care; Phases 1–6 turn it into a
  platform capability.
- **Phase 1 — reconciliation core (pure, observe-only).** `ticket-reconciler.js`
  + PR-truth sweep + ledger endpoint + `claimed-done-not-merged`. Ships like the
  detector did: pure core + endpoint, read-only. The netzplan mirror is available
  from here.
- **Phase 2 — verify-before-claim.** Post-condition-gated claim-forward. Makes
  labels honest platform-wide.
- **Phase 3 — the board.** The Flow Control page over the ledger.
- **Phase 4 — deterministic supervisor.** The act-ladder + budgets + decoupled
  advancement. This is where "loss-free routing" becomes true, and it is the
  concrete build of `flow-reconciliation-concept.md`'s Phase 4.
- **Phase 5 — central human inbox** (+ push into the operator's own Matrix room).
- **Phase 6 — optional LLM supervisor agent** (judgment layer) + authz hardening
  of the pending-queue routes.

Ordering is negotiable: the inbox can start as a thin read over Phase-1
blockers before the supervisor acts on them.

## 7. Open questions

1. **Board substrate** — purpose-built page vs. netzplan mirror vs. extending the
   GitHub Event Log Pending-queue page. Recommendation: purpose-built page as the
   target, netzplan mirror as the zero-frontend stopgap the supervisor can write
   immediately.
2. **Supervisor cadence** — *decided (§4.0):* a periodic `cron` reconcile tick is
   the robust default, because it is self-healing where the completion event is
   not. A completion event may be added as a latency accelerator, never as the
   sole signal. (Confirmed by Phase 0.)
3. **Conflict remediation depth** — should the LLM supervisor attempt real
   conflict-resolution commits (for review), or only escalate? Start with
   escalate-only; add review-only resolution behind an autonomy flag.
4. **Cross-team scope** — the board and inbox are per-team by default; an operator
   roll-up across teams is a System-Admin surface.
5. **Duplicate / staleness detection** — *decided (§4.1):* the observed stall
   included duplicate epic tickets (two P-number tracks producing twin PRs, one
   merged, its twin stranded), so `superseded` (files already in `main`, from
   file-set overlap) and `stale-base` (text-merges but fails against current
   `main`, from a test run) are now first-class reconciler blockers. Open sub-part:
   how aggressively the supervisor acts on them — auto-close a `superseded` PR, or
   only surface it? Recommendation: surface + one-click close, never auto-close.
6. **Where admission control lives long-term** — Phase 0 put the WIP limit in the
   dispatcher *agent's* prompt. Should the platform also offer a declarative
   per-flow WIP limit (a bundle field the graph enforces), so a team gets serial
   dispatch without hand-authoring a dispatcher? Likely yes, as a later phase.

## 8. What Phase 0 already proved

The manual Phase 0 on the Agent Studio 2.0 team is the concept's own first
evidence, and it reorders the priorities the earlier draft implied:

- **Admission control is the highest-leverage lever, and it is one prompt.**
  Turning the dispatcher serial (§4.0) removed the *class* of failure — parallel
  PRs racing one branch — rather than cleaning up its instances. Everything the
  reconciler/board/inbox does is now for the *residual* stalls, not the common
  case.
- **Verify-before-claim (§4.2) is real and small.** The merger's false-completed
  came from a single instruction — "you don't need to do any verification". The
  fix was one prompt; generalising it to the claim mechanism is Phase 2.
- **`superseded` and `stale-base` are the blockers that actually stranded work.**
  Of the four stuck PRs, **none** was a plain "behind main" merge: one was a pure
  duplicate already in `main` (`superseded`), and two were written against a model
  `main` had since changed (`stale-base`) — one referencing a retired
  `visibility:'private'` field, one removing an `authEnabled` mode `main` now
  depends on. A reconciler computing these two (file-set overlap; a test run
  against current `main`) would have surfaced all three the moment they stranded,
  instead of a human tracing each by hand.

The residue Phase 0 could **not** fix by prompt — a live board, a central inbox,
and a supervisor that re-drives automatically — is exactly what Phases 1–6 add.
Its deeper cause, the epic running as **two parallel P-number tracks** whose
merged half moved the model out from under the other's open PRs, is a process
smell the reconciler surfaces (`superseded`/`stale-base`) but does not by itself
cure; the durable cure is one epic, one track, dispatched one ticket at a time.

---

## Amendment 1 — what §4.1 actually shipped (#2115)

The reconciler landed as `orchestrator/ticket-reconciler.js` (pure) +
`orchestrator/ticket-reconcile-sweep.js` (shaping) + `computeTeamTicketLedger`
in `orchestrator.js` (I/O) behind `GET /internal/teams/:id/tickets`, proxied by
`GET /api/teams/:id/tickets`. Observe-only, as specified. Six things deviate
from or sharpen §4.1, and each is a decision rather than an omission.

**A1.1 — the lifecycle is derived from the flow graph, never from label names.**
§4.1 writes the chain as `Backlog → Refining → Ready → In-Dev → In-Review →
Rework → Doc → Mergeable → Merged/Done`, which reads like a fixed vocabulary.
Hardcoding it would have made the ledger correct for exactly one team. Instead
the positional states fall out of the declared graph: an **entry** label is a
wake label no consumer emits (in the observed flow: `ready` / `ready-2` /
`ready-3` — a consequence of the topology, not of their spelling), a **terminal**
consumer is one that emits nothing and produces no PR (the Merger), `mergeable`
is "the deepest active label reaches a terminal consumer", and `doc` is "one hop
before that". A team whose entry label is `triage` gets `lane: 'triage'` with no
code change; `ticket-reconciler.test.js` proves it on a flow sharing none of the
observed vocabulary.

**A1.2 — `buildFlowModel` had to be widened, from the outside.** The shipped
model builder *drops* a human-gate label ("a human gate is not an agent wake"),
which is right for anomaly detection and wrong here: in the observed flow the
dispatch lanes **are** human gates that a Developer trigger listens on, so the
ledger's `lane` and `ownerAgentId` columns are exactly the edges that builder
discards — and any member whose only listener is a gate is absent from
`model.consumers` entirely, taking its `emits` with it. Rather than change a
builder three other features read, `buildTicketLedger` optionally takes the raw
`members` and recovers the gate→consumer edges itself (`gateWakeEdges`,
`mergedConsumers`). A caller that omits them still gets a ledger, with blank
lanes on gate-dispatched tickets.

**A1.3 — `claimed-done-not-merged` is not "a `:completed` label with an open
PR".** Read literally, that flags every healthy ticket in a multi-stage flow: a
Developer's `ready-2:completed` is *supposed* to coexist with an open PR the
reviewer is working on. What makes a completion a lie is that **the flow did not
move** — the completing stage set none of its declared outgoing labels and the
PR is still open and unmerged past a grace window. For a terminal consumer (the
Merger, which has no outgoing label at all) that condition is vacuously true the
moment the PR fails to merge, which is precisely the §1.1 case that hid for
hours. Both readings are pinned by fixtures.

**A1.4 — `superseded` and `stale-base` decline rather than guess.** Only files a
PR **adds** count toward `superseded` (a modified file trivially "already exists
in `main`"), **all** of them must already be present, and the base file index
must be **complete** — GitHub truncates a large recursive tree, and a truncated
index reports "absent" for paths it merely never listed, which would accuse a
healthy PR of being a duplicate. `stale-base` needs *both* halves — the PR
text-merges **and** `main` has moved since it branched — because red checks on an
unmoved base is the author's own bug (`ci-red`, a code fix) while red checks
after `main` advanced under it is a rebase. Two different actions, hence two
different codes. Likewise `mergeable` is three-valued: GitHub answers `null`
while it is still computing, and mapping that either way invents or clears a
conflict.

**A1.5 — a ticket's labels live on both of its objects.** The dispatch gate sits
on the issue; every downstream hand-off (`ready-for-review`, `ready-to-merge`
and their `:wip`/`:completed` markers) sits on the pull request. The ledger reads
the **union**, newest application winning a name collision. Reading either object
alone loses the lane on half the tickets and the merge stage on the other half.

**A1.6 — the ledger covers OPEN work, and `output-missing` folds into
`stalled`.** The sweep fetches `state=open`, so `done` appears only where an
open issue's PR merged. §4.1's table names successors for three of the four
shipped anomaly classes; `output-missing` has none, so it folds into `stalled`
and keeps its original class in `reasonDetail`. The GitHub-derived codes
deliberately outrank the folded anomalies: an anomaly is a statement about the
flow's plumbing, a conflict or a duplicate is a fact about the work.

**Not built, and not owed by this ticket:** there is no board, no inbox and no
UI — §4.3/§4.4/§4.5 own those, and #2115's own Scope is the ledger endpoint. The
per-sweep PR-enrichment cap (`TICKET_LEDGER_PR_LIMIT`, default 60) bounds the
cost of a team with a runaway number of open PRs; the PRs beyond it are reported
in `errors[]` rather than silently dropped.

## Amendment 2 — what §4.4 actually shipped (#2116)

The board landed as `admin-console/src/pages/process/flow-control-view.js`
(pure, the path §4.4 names) + `admin-console/src/pages/FlowControl.jsx` (the
page) on a new `/flow-control` route, reading the Amendment-1 ledger. Read-only,
like the ledger behind it. Four things deviate from or sharpen §4.4.

**A2.1 — the netzplan stopgap is NOT built, and the reason is structural rather
than a matter of effort.** §4.4 words it as *"the **supervisor** mirrors the
ledger into the existing netzplan board via `aee-plan edit`"*, and §7's open
question 1 as *"the zero-frontend stopgap **the supervisor can write**
immediately"*. The supervisor is §4.3, which §6 phases at **Phase 4** — one
phase *after* this board. It does not exist: `grep -ri supervisor` over the
repository matches this document and nothing else. So the actor the stopgap is
specified in terms of has no code, and there is no orchestrator→netzplan write
path to substitute for it: `aee-plan` is an *agent-workspace* CLI seeded by a
plugin grant and authenticated with a per-scope token, while a §4.3a supervisor
is an orchestrator timer with neither a workspace nor a CLI. Building a mirror
now would mean inventing that writer here, in a ticket whose acceptance criteria
are all four about the board — and the stopgap's entire purpose is to be the
*substitute* for the board, which this ticket delivers. It is therefore left to
Phase 4, where its writer is born.

Two factual corrections to §4.4 fall out of having read the plugin while
deciding this, and they matter for whoever does build it. (a) *"`status` and
`ownerId` are already modelled on graph nodes / swimlane lanes"* is half right:
a **graph node** carries both (`plan-doc.js` `ownerId`, `status`), but a
**swimlane lane** carries `ownerId` only — its progress model is a per-milestone
`done` boolean, with no `status` field at all. A lifecycle mirror therefore has
to use the **graph** primitive, not the swimlane one, despite "swimlane by
lifecycle stage" being the board's own shape. (b) `ownerId` is *referentially
validated* against `doc.owners[]` — an unknown owner is rejected on mutate and
nulled on normalize — so a mirror must `add-owner` for each owning agent before
it can assign one.

**A2.2 — a purpose-built page, on its own route, not a side panel.** §4.4 says
"a purpose-built admin-console page" and #2116 says "Console page", so the
alternative was never really open; but it is worth recording why the cheaper
option was refused. The obvious precedent is `FlowAnomaliesPanel`, a `SidePanel`
on the Flows canvas — 560 px wide, which cannot host nine swimlanes, and reached
only from a live team's canvas, which is not where an operator asking "where is
everything?" starts. The cost of a real route is the registration surface
(`App.jsx`, the sidebar, `breadcrumbs.js`, `route-title.js`, `PAGE_ROUTES`) plus
an authored help topic, since `help-coverage.test.js` fails CI on a page route
with no topic and no named owner. All of it is paid here; `help-topics/`
gains `flow-control.md`.

**A2.3 — "it never derives state from raw labels" is proven behaviourally, not
by source inspection.** The obvious guard — grep the view for label vocabulary —
is a false-positive generator for ordinary words and, worse, proves nothing
about a label read through a variable. The check that actually holds is that
`ticket.labels` is **not an input**: the test deletes the array from a ledger row
entirely and asserts the rendered card is `deepEqual` to the card built with it.
Paired with a fixture whose labels all say `:completed` while the reconciler says
`in-review`, that turns AC2 from a claim into a fact — and a mutation that makes
the view read `labels` fails eight tests. The page's own JSX is guarded
separately (no `.labels` access, no flow token, no mutating `apiCall`), since a
pure-module test cannot see the renderer.

**A2.4 — the epic roll-up's buckets are exhaustive by construction.** §4.4's
example (`3 done / 4 blocked / 2 waiting`) leaves "in progress" implicit and does
not say what a *blocked* ticket that is also *done* counts as. `bucketFor`
returns exactly one of `done | blocked | inProgress | waiting`, with `done`
outranking `blocked` — a blocker recorded against merged work is history, not a
call to action — and the test walks the whole state × blocker cross-product
asserting the four counts sum to the total. Empty lanes are kept on the board
for the converse reason: where work is *not* is information, and a board that
hides its empty columns is a filtered list.

**Still not built:** §4.5's central human inbox. The board surfaces
`needsHuman` per card, which is the input that phase consumes, and nothing more.

## Amendment 3 — the board rebuilt as "who is working on what" (#2573)

The Amendment-2 board answered "where is every open ticket, in nine fixed
stages" and was used for something else: *which agent is working on what right
now, and where do I have to step in*. It also loaded slowly (a full ledger
sweep per view) and listed work no agent had touched. #2573 replaces it; the
ticket ledger itself (`ticket-reconciler.js`, `GET …/tickets`) is untouched,
because the Flow Supervisor (#2117) still reads it.

**A3.1 — one pure derivation, one endpoint.** `orchestrator/flow-board.js`
(pure, node:test-covered) builds the whole board; the orchestrator's
`GET /internal/teams/:teamId/flow-board` feeds it one parallel GitHub sweep
per repo (open issues, open PRs, items closed within the retention window,
plus one GraphQL query for mergeability/review/checks) and serves it from a
per-team single-flight cache (15 s TTL, `?refresh=1` forces a sweep). Every
viewer shares one sweep; a GitHub outage returns the last good snapshot
flagged `stale` with a warning. The console proxies it as
`GET /api/teams/:teamId/flow-board`.

**A3.2 — stages come from the flow graph, not a fixed list.** The role graph
is read from the members' ports: labels a role emits (`emits`, trigger
`emits`, outcome `setLabel` actions) and consumes (github-event
`labelFilter`, minus `:wip`/`:completed` claim variants), plus `channels[]`.
Roots are roles woken by a label no role emits; roles are placed by
breadth-first depth, a loop-back role (e.g. a Reworker) before its forward
sibling, then the longest forward path. Board columns = **Ready**, one per
role in that order, **Done**. *(Superseded by #2637: the first column is
**Draft** — see Amendment 4.)* A role on several paths appears once; pool
instances (`<team>-<role>-i<item>`, live or already reaped) count as their
role. An optional per-team `flow-board.json` (`{doneRetentionHours, stages:
{<memberId>: {label, hidden, mergeInto}}}`) renames, merges or hides stages.

**A3.3 — only touched work appears.** An item is on the board once a team
agent was delivered an event for it (GitHub Event Log), opened or pushed to
it (`pr-events` log, or an agent marker in the body), ran a session on it,
or — for an issue — carries a label a team role consumes (released). An
issue and the PRs its woken agent opened form one row, linked through the
pr-created record's correlation id to the waking event — no `Closes #n`
needed. Dependabot PRs never appear. Finished rows stay for
`doneRetentionHours` (default 24); the console lists them in a separate
**Recently completed** section below **In progress**, never mixed in (#2607).

**A3.4 — sessions know their work item.** The agent runtime now records a
`workItem` (`{repo, kind, number}`) on each triggered session, so the
"Working now" area can name the issue or PR per run; a pool instance falls
back to its own `poolItem`.

**A3.5 — human blocks are plain reasons.** Instead of the ledger's ten
blocker codes, a row carries at most one of: flagged for a human, conflict
with base, waiting for approval (a label the flow hands to no agent),
approved — waiting for merge, checks failing, or no agent is scheduled to
continue (nothing woke or queued for 30 min after the last run). A conflict
already queued for an agent is not a human block.
*(Extended by #2734/#2754: two more reasons — **stuck — no progress, needs
help** and **nobody picks it up** — see Amendment 5.)*

**A3.6 — Drain now ends in Off.** `pool-control.json` gains a third state,
`off`: it refuses every dispatch, including reuse of a live instance.
`settleDrain` turns `draining` into `off` once the role's last instance is
gone — checked on the pool reap sweep and on every read of the board or the
pool controls. **Switch on** is the existing `state: running` write, which
also redelivers work held while the role was paused/draining/off.

**Removed from the board:** the stat chips, the epic roll-up, the Backlog
column and the list of all open PRs. The pool-lane panel is folded into
"Working now".

## Amendment 4 — Draft stage and Remove from board (#2637)

**A4.1 — Ready becomes Draft.** Stage 0 only ever held rows with no running
session, claim label, wake label or delivered wake — items nobody had
released, not released ones (a released item already sits at the role it
wakes, as *queued*). The column is now **Draft** and its rows carry status
`draft` (UI: *awaiting release*).

**A4.2 — Remove from board.** A Team Admin can take a row off the board while
no agent is working on it or queued for it (`removable` on each row; the
orchestrator re-checks it). Removals are stored per team in
`flow-board-removed.json` beside `flow-board.json` —
`{ "<row id>": { removedAt, keys: ["<repo>#<n>", …] } }` — and written through
`POST /api/teams/:teamId/flow-board-removed` (`{ action: remove|restore,
rowId }`). The GitHub item is never touched. The board returns the hidden rows
as `removed[]` (the **Removed (n)** list with **Restore**).

**A4.3 — a removal ends on new flow activity.** `removalRevived` brings a row
back when, after `removedAt`, an agent is working on or queued for it, a wake
was delivered on any of its items, or a team agent opened a PR for it. Edits,
comments and cross-references (`updatedAt` only) do not count. Revived entries,
and entries whose row left the snapshot, are pruned from the store — only for
repos the sweep actually reached, so a GitHub outage never forgets a removal.

## Amendment 5 — Release claim and wakes nobody can pick up (#2754)

**A5.1 — the stuck reason gets a way out.** #2734 added the reason *stuck — no
progress, needs help*: a row has read *working* for more than an hour only
because of a `<wake>:wip` claim, and no session or pool instance is alive for
it. The board only reported it. Since #2754 such a row carries a `release`
list (`{repo, number, kind, claim, wake}`), one entry per `:wip` claim whose
wake label still has a live consumer. A Team Admin (`canManageTeam`) gets a
**Release claim** button with a confirmation dialog listing `claim → wake`.

**A5.2 — the release swaps the label on GitHub, nothing else.** The console
route `POST /api/teams/:teamId/flow-board-release` (`{ rowId }`; the actor is
the session user, never the body) proxies to the orchestrator's
`POST /internal/teams/:teamId/flow-board-release`. It re-reads a **fresh**
board and refuses a stale board (503), an unknown row (404), or a row that is
no longer stuck or has no claim (409) — `planClaimRelease` in the pure
`orchestrator/flow-claim-release.js`. `swapClaimLabel` then removes the claim
**first** and adds the wake label back (on a failed add it creates the label
and retries once), with the token `resolveRepoGithubTokenId` picks for the
repo. When the wake label still hangs next to the claim (the #2713 shape: the
wake was re-applied on top, so the board marks the entry `wakePresent`),
adding it again would create no `labeled` event, so the swap also removes the
wake before re-adding it (claim → wake → re-add). After a successful swap the
route clears the poller's armed wake-edge key for that label on the item
(`disarmWake`), because on a pull request the Events API reports no standalone
`unlabeled` and the re-add would otherwise be dropped as `wake-already-armed`.
There is no in-process wake: the poller sees the re-applied wake label
and re-dispatches the item on its next poll, as if a person had re-applied it.
A partial failure comes back as a warning that says what to do by hand. Every
swap writes one GitHub Event Log line, `flow-control.claim-released` (UI:
*claim released (Flow Control)*), with the actor and the outcome. The board
never releases a claim on its own.

**A5.3 — wakes whose every consumer is switched off.** A new reason, *nobody
picks it up — its agent is switched off*, replaces queued/stuck for an item
with no live session when every wake label it carries (or its claim) is
consumed only by switched-off agents — the agent is disabled, or its trigger
on that label is. One live consumer clears it. Such rows get no release,
because releasing would wake nobody. The flow lint
`wake-label-no-live-consumer` (warning, *Nobody picks this label up*) reports
the same on the Flows page; the graph endpoints now carry `enabled: false` on
switched-off nodes. A label with no consumer at all stays with
`dead-end-emitter` / `outcome-without-consumer`.

## Amendment 6 — wakes that were never delivered (#2872, epic #2880)

**A6.1 — the problem.** Label wakes are edge-triggered on the GitHub Events
API: the poller wakes a consumer on the one `labeled` event. If that event is
dropped or never arrives, the wake label stays on the item, the row reads
*<stage> / up next* for good, and nothing re-checks it. On 2026-10-06 five PRs
of `agent-studio-3-0` sat like this for ~18 h, for three different causes.

**A6.2 — detection (report-only).** `buildFlowBoard` flags a row with the new
reason *wake never delivered* (`REASONS.wakeLost`) when its position is
`queued` and:
- no session or live pool instance is behind any of its items;
- no dispatch for any of its items waits in a member's pending queue or the
  team's admission lane (`queued` input, from `entryTicketRef` over both);
- no readiness gate holds its PR hand-off (#2795);
- one of its open items carries a wake label (`consumersOf`) without that
  label's `:wip` claim, with at least one live consumer (otherwise A5.3's
  *nobody picks it up* applies), whose Event Log trail shows it never reached a
  consumer role — for longer than `PARKED_WAKE_MS` (30 min).

The trail is every log entry on the item about that label: its own add/remove,
its `:wip`/`:completed` swaps, or an outcome stamped with it as `wakeLabel`.
The latest entry decides (`parkedWakes`):

| Latest entry | Cause | Clock starts |
|---|---|---|
| the label's add; a consumer outcome got through (delivered, held, digest) | — not parked | — |
| the label's add; the consumer was dropped as `history-horizon` | `history-horizon` | the event's `createdAt` |
| the label's add; dropped as `wake-already-armed` | `wake-already-armed` | the event's `createdAt` |
| the label's add; dropped for another reason / no consumer outcome | `dropped` + `dropReason` (`no-subscriber`) | the event's `createdAt` |
| none, or a later swap / removal | `not-seen` — the add that put the label back never surfaced | the item's `updatedAt` (or the trail's last entry, the later) |

The clock uses GitHub's own `createdAt`, so a `history-horizon` drop logged
hours late flags at once. A delivered outcome with no label stamp at all
(entries from before #1846) on a label event counts as delivered, so an old
log never raises the flag. Each flagged wake is listed on the row's
`needsHuman.wakes` (`{repo, number, kind, label, cause, dropReason?, eventId,
since}`), and the board's **Needs you** area shows `label — cause`, linked to
the GitHub Event Log row (`/github-events?event=<id>`, which shows that one
event over the 7-day retention). The action that restarts such a row is #2873.
