# Agent instance pools — ephemeral, self-cleaning workers over a stream of work items

> Status: **design of record; Phases 1–4 shipped** (see Amendments 1, 3 and 4);
> **Phase 5 partially shipped** — team-axis config UI (#2272, Amendment 5),
> board controls (#2250, Amendment 6) and per-role config UI (#2271, Amendment
> 7); a headless runtime (D7), provider-aware admission (D9), and Amendment
> 2's remaining "Live surface" lane visualization are still undesigned/unbuilt.
> This document scopes the discussion in issue #2251 (the Agent Pools epic). Its
> SDLC binding builds directly on the shipped Flow Control machinery
> (`docs/flow-control-concept.md`): admission control (#2114), the ticket
> ledger (#2115) and the board (#2116). Its autonomous half is, in effect, the
> concrete design for that document's **§4.3 Flow Supervisor**, generalised
> beyond a single repository and now shipped as `orchestrator/flow-supervisor.js`.

## 1. The problem

Today an agent team is a fixed set of long-running agents. A role — say
`developer` — is **one** persistent agent bound to **one** git checkout, woken by
a label (`ready`). Because an agent has exactly one workspace and the
WorkspaceGate (#1157) serialises every workspace-touching run, that agent works
exactly **one** ticket at a time.

To implement several tickets in parallel the operator today **clones the
developer by hand**, re-points each clone's trigger at a different label
(`ready`, `ready-2`, `ready-3`, …) and orchestrates the fan-out manually. It is
toil, it is error-prone, and it is precisely the multi-lane dispatch whose
unbounded form manufactured the stall in `docs/flow-control-concept.md` §1.

Two wishes follow:

1. **Auto-scaling instances.** A role should be a *template*. One label starts
   one instance; a second ticket arriving while the first runs simply starts a
   second instance — up to a limit — and each instance is torn down when its
   ticket is done. No hand-cloning, no per-lane labels.
2. **Generality.** "Fan a role out over N units of work" is not specific to
   software development. Analysing N datasets, migrating N COBOL programs,
   processing a queue of requests — all the same shape. Nothing in the *pool*
   should assume git, GitHub or a repository.

## 2. What already exists (build on it, do not duplicate)

The mechanics are ~80% present. The lean path is to slot into them.

| Primitive | Where | What it already gives us |
|---|---|---|
| WIP gate at dispatch | `orchestrator/admission-control.js`; `enqueuePending` (single writer); 60 s `admissionSweepTeam` tick; `wipLimit` bundle field | A per-team **lane** that admits/holds dispatches by count and tracks **tickets** (a ticket's issue + PR(s) are one slot). Fail-closed on GitHub outage. Nothing is ever dropped. |
| Ticket ledger | `orchestrator/ticket-reconciler.js` + `ticket-reconcile-sweep.js`; `GET /internal/teams/:id/tickets` | **Post-hoc, observe-only** diagnosis of `conflict` / `stale-base` / `superseded` / `ci-red`, PR↔issue linkage, and `epicId`. |
| Flow Control board | `admin-console/src/pages/FlowControl.jsx` | Read-only view of the ledger, per-lane. |
| Flow Supervisor | `docs/flow-control-concept.md` §4.3 | **Designed, never built** — the autonomous actor that would re-drive/advance tickets. `grep -ri supervisor` matches only the doc + one comment. |
| Per-env repo cache | `cloneRepository` cache fast-path; `envRepoCachePath` / `isUsableRepoCache` (`_repo-cache`) | Fast local `cp` seed from a warm base (incl. `.git`) — but a **stale one-time snapshot**, no refresh, and the first clone in an env is a full network `git clone` (~120 s). |
| Stub → provision | `addTeamMember({materialize:false})`; `enableAgent`; `isStubMember` | "Reserve now, provision on first use" precedent. |
| Ephemeral agent route | `POST /internal/agents/ephemeral` | Already spawns a throwaway agent per work-unit — but writes `ephemeral:true` and **never reads it to reap** (no auto-cleanup). |
| Teardown | `DELETE /internal/agents/:id`; `orchestrator/agent-delete-plan.js` (`cascadeChildIds`, `TeardownRegistry`, `isGracefulDeleteRole` — **currently always false**, the graceful seam kept for "a future flushing role") | Fast phase (stop + plugin reap + delete config/files) + background phase (volume, network, Matrix); id reserved during reap. |
| bp-instance (removed, #1962) | history; `agent-delete-plan.js` graceful comment | Exact precedent: one disposable agent per work-unit, worktree per unit, and the **only role that committed partial work before exit**. |
| Collision-free ids | `orchestrator/agent-id-resolution.js` (`nextAvailableAgentId`) | Deterministic id resolution; reservation via an immediately-written placeholder config (closes the TOCTOU window). |
| Autonomous attribution | #2176 / #2177 baseline owner | Autonomous instance commits/PRs attribute to the team's baseline identity; personal-credential refuse-on-missing does **not** apply to autonomous runs (they fall to shared), so no surprise refusals. |

**The single leanest decision:** reuse the admission lane as the instance
registry and the reconcile tick as the reaper. Admit a work item for a pooled
role → spawn an instance; release the item → reap the instance. The lane *is*
the pool.

## 3. The core abstraction: a neutral pool + four bindings

The pool machinery is **domain-agnostic**:

- A **worker template** (a role with pooling opted in) spawns an **ephemeral
  instance** per **work item**, up to a **concurrency limit**, each fully
  isolated, auto-reaped on completion (+ a hard timeout), work-log preserved
  before teardown, and **idempotent on the work-item id** (the same item never
  spawns two instances).

Everything SDLC/GitHub-specific lives in **four clearly-separated bindings**. A
second use case swaps the bindings, never the core:

| Binding | SDLC / GitHub (built first) | Recurring analysis (second binding) |
|---|---|---|
| **Work source** — where items come from | GitHub `ready` label via the poller | a list / cron enumerating N datasets |
| **Workspace seeding** — how an instance's workspace is filled | clean git base, **pull-on-demand** | a copy of the input / scratch dir |
| **Completion** — when an item is done | PR merged | output artifact produced |
| **Contention** — what "conflict" means | git merge on shared `main` | **none** → full parallelism up to rate limits |

Two insights fall out and simplify the design:

- **Insight A — conflict avoidance is not intrinsic to the pool.** It engages
  only when work items share a *mutable* resource. Independent items (50 COBOL
  programs analysed one by one) have no merge and no clash → full parallelism up
  to the resource/rate limit, and the whole conflict machinery is simply *off*.
  "Epic-serialization" is only the SDLC special case of "don't start two items
  sharing key K".
- **Insight B — the clean git base belongs to the workspace binding, not the
  core.** A stateless task has a trivially clean start (an empty scratch dir);
  no cache, no pull.

## 4. Decisions

- **D1 — An instance is an ephemeral agent**, not a git-worktree-in-one-container.
  Worktrees would fight the WorkspaceGate (one workspace), the CLI (one cwd), the
  per-container isolation model and the per-spawn credential bake. Ephemeral
  agents reuse spawn/seed/teardown wholesale; cost is governed by the limit.
- **D2 — Clean base is pull-on-demand, not polled.** Keep a persistent base
  clone per repo; immediately before a spawn do an **incremental** `fetch` +
  `reset --hard origin/<baseBranch>` on it (fast — a delta, not the full clone),
  then a local copy for the instance. A per-repo lock (+ a short freshness TTL to
  coalesce bursts) serialises the refresh. Fresher than a timer, less code, no
  background job. `reset --hard` is safe because the base is never a working
  agent. This is *the workspace binding's* concern (Insight B), not the core's.
- **D3 — Rework starts on the PR branch, not clean main.** A review-changes /
  `stale-base` item resolves its base to the existing PR head (fetch + checkout),
  not to `main`. The ledger already knows the PR↔issue link. Getting this wrong
  would break every review cycle.
- **D4 — A slot is held until completion** (SDLC: until the PR is merged/closed),
  not until the PR is opened. Fewer concurrent open branches → fewer merge
  conflicts. This is already the admission lane's behaviour. The *container* is
  reaped when its run ends regardless (an idle container never lingers); the
  *slot* is the conflict-governing knob.
- **D5 — One team-wide concurrency limit** (the existing `wipLimit`). Per-role
  caps (`maxInstances`) are a later, additive refinement (e.g. when reviewers
  become the bottleneck).
- **D6 — Conflict avoidance is layered and optional.** Baseline always present:
  the WIP count + the post-hoc ledger detection (safety net). Added preventively
  for SDLC: **epic-serialization** (never two in-flight items sharing `epicId`),
  then **LLM path-prediction** (a read-only pre-flight guessing touched files) —
  the latter only if epic-serialization proves insufficient. **Sequential
  conflicts are accepted, not eliminated:** while A works, B merges and A's base
  goes stale; that is inherent to parallel branches on one `main`, and the
  ledger's `stale-base` + a rebase-on-open discipline is the steady-state cost.
- **D7 — Each instance gets a throwaway Matrix account**, reusing the existing
  ephemeral route — least new code, at the price of chat-server account churn. A
  truly headless (Matrix-less) runtime is a later optimisation, not a blocker.
- **D8 — Teardown is graceful: preserve the work log first.** Before hard-delete,
  commit/push partial work and copy the session transcript to a team-level
  archive (retention configurable). We become the "future flushing role" the
  `isGracefulDeleteRole` seam was kept for; the bp-instance commit-before-exit is
  the precedent. Otherwise the PR + ledger + event log survive but the actual
  work log dies with the container.
- **D9 — Provider rate limits: warn, don't gate (first cut).** Pooled roles
  should run on an api-key provider with headroom; document that oauth
  subscription seats are single-user and share the human's own limit. The WIP
  limit is the real governor. Provider-health-aware admission is a later phase.
- **D10 — The supervisor is deterministic with LLM only for exceptions**, and
  **the human owns readiness.** The human applies `ready` (the business "is this
  ready to build?" call); the supervisor decides only the *timing* (which next,
  in what order, up to the limit, honouring the contention policy). An LLM steps
  in only for stuck/knotty cases (propose a conflict resolution *for review*,
  explain why a lane is stuck) — exactly the §4.3a/§4.3b split.
- **D11 — Idempotency is keyed on the work-item id.** A redelivered event maps to
  the existing instance/slot, never a duplicate — the admission lane already keys
  on the ticket (`entryTicketRef`); this generalises to the work-item id.

## 5. The SDLC / GitHub binding (built first)

- **Work source:** the GitHub poller. A `ready`-family label for a pooled role is
  a spawn request for the item = its issue. The poller and the internal label
  fast-path (`POST /internal/github-label-applied`) are the delivery paths.
- **Workspace seeding (D2/D3):** new work → local copy of the pull-on-demand
  clean base, then `checkout -b <item-branch>`; rework → fetch + checkout the PR
  head branch. `baseBranch` is configurable (default = the repo's default
  branch); the base clone tracks it.
- **Completion (D4):** the ledger's own release signal — issue closed / PR merged
  / no active flow label. Already computed by `reconcileInFlight`.
- **Contention (D6):** WIP + post-hoc ledger + epic-serialization (+ later LLM).

Instance id: deterministic and item-keyed, e.g. `<teamId>-<roleId>-i<issue>`,
resolved/reserved via `nextAvailableAgentId` + a placeholder config — so a
redelivered `ready` finds the same instance (D11).

## 6. The recurring-analysis binding (second, additive)

The proof of generality — no GitHub, no git-merge contention:

- **Work source:** a cron/list enumerating the current N items (datasets,
  documents, reports).
- **Workspace seeding:** a copy of the input (or read-only input + a scratch
  dir); no clean-main cache needed.
- **Completion:** the run succeeded / the output artifact exists.
- **Contention:** none → full parallelism up to the resource/rate limit; each
  instance writes a distinct output path.

The one thing recurring runs need that the core already provides is a
**"already done this cycle?" check** keyed on the work-item id (D11) — otherwise
a cron re-processes everything each run. Same idempotency logic, different
adapter. Built additively; independent of §7 (could even precede it, to validate
neutrality early).

## 7. The autonomous supervisor (the unbuilt §4.3, generalised)

A maintenance-gated timer that reads the ledger/work-source and, for pooled
roles, **auto-dispatches ready-but-undispatched items up to the limit**,
oldest-first, subject to the contention policy — using existing hands
(`POST /internal/github-label-applied` both applies the label and wakes the
listener). It also folds in the designed remediation ladder (re-fire a dropped
dispatch, hand a `stale-base` back to rework, etc.), bounded and allow-listed
(≤1 action per (item, blocker) per window). Deterministic core (§4.3a); an LLM
role is invoked only for escalations (§4.3b). Auto-applied `ready` is recorded in
the audit/event log so "who dispatched" stays clear (the label's meaning shifts
from "a human decided" to "the supervisor decided").

## 8. Lifecycle in detail

1. **Trigger:** work source yields item *I* for pooled role *R*.
2. **Admission (D5/D11):** `enqueuePending` → admit if under the limit and *I*'s
   contention keys don't clash; else hold (durably) and let the tick promote it.
3. **Spawn (D1/D2/D3):** resolve/reserve `<team>-<R>-i<I>`; seed the workspace
   from the resolved base (clean main / PR head / input copy); throwaway Matrix
   account (D7); config `pool-instance: true`, `enabled:true`, per-invocation.
4. **Run:** the instance executes *R*'s prompt/LoopScript, opens its PR / writes
   its artifact.
5. **Reap the container** when the run ends (nothing to keep running).
6. **Release the slot (D4)** when the reconcile tick sees *I* done.
7. **Graceful teardown (D8):** commit/push partial work + archive the log, then
   the existing fast + background delete. A **hard timeout** reaps a
   stuck/crashed instance and marks *I* blocked (`needs-human`) so it never holds
   a slot forever — the reaper the ephemeral route lacks today.

## 9. Configuration surface

Round-tripped through the process-template bundle like `stages` / `labels` /
`wipLimit`. Start minimal:

```jsonc
// on a role (opt-in; a non-pooled role is byte-identical to today)
"pool": {
  "enabled": true,
  "maxInstances": null,          // null = only the team-wide wipLimit governs (D5)
  "workspace": "git-clean-base", // | "input-copy" | "none"  (the binding, D2/B)
  "baseBranch": null,            // null = repo default branch
  "teardown": { "idleTimeoutMs": …, "maxRuntimeMs": …, "retainLogsMs": … }
}
// on the team / flow
"wipLimit": 3,                   // exists (#2114)
"autoDispatch": {                // §7, later phase
  "enabled": true,
  "selection": "oldest-first",
  "contentionPolicy": "epic-serial"   // | "none" | "predicted-paths"
}
```

Both blocks are round-tripped through the bundle today, and the *team* half
(`wipLimit`/`autoDispatch`) is already live-editable via `PUT /api/agents/:teamId`.
The *role* half (`pool`) is **not** live-editable yet — only settable at bundle
materialise. **Amendment 2** is the design of record for the first-class UI that
authors both without hand-editing a bundle, and for the one live-write endpoint
(`pool` on a member) it needs.

## 10. Relationship to existing code

- **Reuse unchanged:** admission lane + tick, ticket ledger, board, poller +
  label fast-path, `nextAvailableAgentId`, the fast/background teardown split,
  `seedAgentWorkspace`.
- **Extend:** `cloneRepository`'s cache path → pull-on-demand base refresh (D2);
  `isGracefulDeleteRole` → true for pool instances, wired to commit + log-archive
  (D8); the ephemeral route → item-keyed id + a real reaper.
- **Add:** the pooled-role spawn/reap wiring off admission admit/release; the
  workspace-binding seam (git-clean-base / input-copy / none); the deterministic
  supervisor timer (§7); the recurring-analysis binding (§6).
- **Do not:** try to generalise the existing GitHub-coupled poller/ledger/
  admission internals — build the neutral pool core + adapters *beside* them.

## 11. Non-goals & open questions

- **Non-goal:** eliminating sequential merge conflicts (D6) — accepted and
  handled by the existing `stale-base` path.
- **Non-goal (first cuts):** a headless runtime (D7), provider-aware admission
  (D9) — still later/additive, no design beyond D7/D9 themselves exists yet;
  per-role caps (D5) shipped in Phase 1 despite being filed under Phase 5
  (Amendment 2 §A2.1); LLM path-prediction (D6) shipped as Phase 4 (#2249).
- **Open:** exact retention window for archived instance logs; whether §6
  precedes or follows §7. Board controls for a pool (pause / drain / force
  dispatch) shipped in Phase 5 (Amendment 6, #2250) — the pause/draining
  distinction the concept left open is resolved there as a judgement call.

## 12. Phases

- **Phase 1 — Pool core + SDLC binding (label-triggered). Shipped (#2246).**
  Neutral core + the four GitHub/git adapters; conflict protection = WIP count +
  post-hoc detection only; pull-on-demand base; graceful teardown with log
  archive; item-keyed idempotency. *Result: one label → N auto-scaling,
  self-cleaning workers — no hand-cloning.* Readiness still applied by a
  human/upstream agent.
- **Phase 2 — Autonomous supervisor. Shipped (#2247, Amendment 1).** Drain the
  backlog up to the limit, oldest-first, epic-serialization, plus the narrowed
  remediation ladder (§A1.2). *Result: apply `ready` and walk away.*
- **Phase 3 — Second binding: recurring analysis. Shipped (#2248, Amendment 3).**
  Proved generality with no GitHub (list source, input-copy workspace, artifact
  completion, no contention). Independent of Phase 2.
- **Phase 4 — LLM conflict prediction. Shipped (#2249, Amendment 4).** SDLC
  only; opt-in via `autoDispatch.contentionPolicy: "predicted-paths"`, off by
  default — epic-serialization (Phase 2) remains the always-on baseline this
  layers on top of.
- **Phase 5 — Polish. Partially shipped (#2250, Amendment 6; #2272, Amendment
  5; #2271, Amendment 7).** Board controls (pause / drain / force-dispatch),
  the team-axis config UI (the Parallelism panel) and the per-role config UI
  (the Scaling section) shipped; per-role caps and reviewer pools were
  already true before this phase started (Amendment 6's own audit). The live
  lane visualization (Amendment 2's remaining surface), plus optional
  headless runtime (D7) and provider-aware admission (D9), remain
  undesigned/unbuilt.

---

## Amendment 1 — what §7 (Phase 2) actually shipped (#2247)

Landed as `orchestrator/flow-supervisor.js` (pure — mirrors `admission-control.js`'s
no-fs/no-network/injected-`now` shape) + a maintenance-gated `orchestrator.js`
timer (`flowSupervisorSweepTeam`, `runFlowSupervisorTick`), reusing the ticket
ledger (#2115) and two existing audited hands: the label fast-path's wake half
(#1858, extracted into `wakeGithubLabelListeners` so the HTTP endpoint and the
supervisor share one implementation) and `wake-agent` (#2030). Config surface:
team-level `autoDispatch: {enabled, selection?, contentionPolicy?, actionWindowMs?}`,
sibling of `wipLimit`, round-tripped through export/materialise/Edit-as-draft the
same way. Four things sharpen or deviate from §7 as written.

**A1.1 — "auto-dispatch" and "re-fire a dropped dispatch" are ONE code path, not
two.** §7 and the issue's own AC list them as separate behaviours; reading the
shipped ticket ledger (#2115) shows they are the same fact under two names. The
ledger's `unclaimed` blocker (§4.1: "dispatched > T1, no `:wip`, no run") IS
"a ready-but-undispatched item" — a wake label already on the issue that the
platform never actually delivered a run for, whatever the cause (a dropped
poller event, a label applied while nothing was listening, GitHub's own event
loss). The supervisor's `selectAutoDispatch` therefore selects on `blocker ===
'unclaimed'` alone; there is no separate "is this newly ready" classification to
get wrong, and the T1 age gate already built into `unclaimed` is what supplies
"oldest-first" for free (sorted by `ageInStateMs` descending) without a second
timer.

**A1.2 — the remediation ladder is deliberately narrowed to two rows.** The
issue's AC says "fold in the designed remediation ladder (re-fire a dropped
dispatch; hand a stale-base PR back to rework)" — a named SUBSET of
`flow-control-concept.md` §4.3a's five-row table, not the whole thing. Only
`unclaimed` (via A1.1) and `stale-base` are wired; `claimed-done-not-merged`
(claim rollback), `conflict` (ask-to-rebase) and `ci-red` (GH re-run) are left
for the still-unbuilt general §4.3a supervisor. The `stale-base` action is a
`wake-agent` hand-off to the ticket's `ownerAgentId` with a note — not a label
re-application, since "hand back to rework" has no single well-known label
across an arbitrary flow's vocabulary, while every team already has a working,
audited way to reach an agent directly.

**A1.3 — epic-serialization is a genuinely NEW contention rule, not a restatement
of admission control.** The admission lane (#2114) counts TICKETS, not epics —
two different tickets from the same epic can each legally hold their own lane
slot when `wipLimit >= 2`, which is exactly the "two parallel P-number tracks"
failure mode §8 of `flow-control-concept.md` names as the deeper, unfixed cause
of the original stall. `selectAutoDispatch` reserves an epic BOTH against every
ticket already active elsewhere in the ledger (`ready` through `mergeable`,
excluding `backlog`/`done`) and within its own pass (a same-epic sibling later
in the oldest-first order is skipped), so the reservation cannot be defeated by
the very pass that is supposed to enforce it.

**A1.4 — `selection`/`contentionPolicy` are validated closed sets, not free
strings.** §9's config surface names them as extension points
(`contentionPolicy: "epic-serial" | "none" | "predicted-paths"`), but only
`oldest-first`/`epic-serial` exist in this phase — `epic-serial` is not actually
optional (the AC's "never two in-flight items sharing epicId" has no stated
exception), and `predicted-paths` is explicitly Phase 4. `validateProcessTemplate`
refuses an unimplemented value rather than silently accepting and ignoring it,
which would misrepresent what the author asked for; the same discipline
`pool.workspace`'s closed enum already follows.

**Not built, and not owed by this ticket:** §7's remaining named rows
(`claimed-done-not-merged`, `conflict`, `ci-red`), §4.3b's LLM escalation layer,
and any board control (pause/drain/force-dispatch) — all later phases per §12.

---

## Amendment 2 — the configuration & visualization UX (design; team/flow surface shipped, see Amendment 5; board controls shipped, see Amendment 6; per-role surface shipped, see Amendment 7; live surface shipped, see Amendment 8)

Phases 1–2 shipped the *mechanism* but left it **headless**: until #2272 the only
way to turn on pooling, a WIP limit or the supervisor was a hand-authored
process-template bundle or a raw `PUT` (`admin-console/api/api.js` said so in a
comment, "No Flow-Editor control yet" — since replaced, #2272 added one for the
team axis). This amendment is the design of record for the first-class UI that
makes the mechanism configurable *and* observable. It introduces **no new
contention semantics** — it is UI plus one live-write endpoint over what
already exists. Five decisions.

**A2.1 — The config is TWO independent axes, and the UI must mirror them, not
flatten them into one "how parallel" number.** This is D5 re-stated for the UI,
because "how parallel" reads as a single knob and is not:

- **Team axis — how many *tickets* flow at once.** `wipLimit` counts *work items*
  (issue + its PR(s) = one slot the whole way through developer → reviewer →
  merger), **not agents**, because the governing scarce resource is the shared
  `main`, not the agent count. Plus how tickets are *serialized*
  (`autoDispatch.contentionPolicy`) and whether dispatch is automatic
  (`autoDispatch.enabled`).
- **Role axis — how far a *single role* fans out.** `pool.enabled` +
  `maxInstances`, **independently per role**. Several pooled roles (many
  developers, many reviewers, many mergers) coexist by construction; each is its
  own template with its own cap. `maxInstances` is already enforced in
  `planPoolDispatch` (`refuse: max-instances`) — Phase 1 shipped the per-role cap
  even though §12 files it under Phase 5.

There is deliberately **no per-role `wipLimit`**: `maxInstances` is the per-role
knob; the team `wipLimit` stays the ticket budget (D5). The UI surfaces each axis
where its object lives.

**A2.2 — Three surfaces, one model.**

- **Per-role (agent) surface — shipped (#2271, Amendment 7).** The Flow editor's
  `NodeInspector` for a role node, and the agent's own **Settings** tab (Agent
  Chat → Settings). Controls: "This role auto-scales" (`pool.enabled`), max
  parallel instances (`maxInstances`), teardown timeouts. A read-only "pooled
  role · up to N" badge on the single-agent view so an operator looking at one
  agent sees its scaling at a glance. (The workspace-binding control shown here
  in the original design was removed — see Amendment 7 A7.4, #2294.)
- **Team / flow surface — shipped (#2272, Amendment 5).** A **Parallelism**
  panel in the Flow editor (team scope) + a compact read-only summary on the
  team view. Controls: `wipLimit`, `autoDispatch.enabled` (the Flow
  Supervisor), and the contention-strategy selector (A2.3).
- **Live surface — shipped (#2273, Amendment 8).** The combined lane
  visualization: per pooled role, its active instances as lanes, each tagged
  running / held-same-epic / timed-out. Amendment 6 (#2250) shipped the pause
  / drain / force-dispatch CONTROLS this bullet named as a simpler pair of
  panels on the Flow Control board; Amendment 8 adds the per-instance lane
  view itself, read-only, as a third panel on the same board.

**A2.3 — The contention strategy is the extensible "wow" seam, designed for the
LLM future NOW.** One selector renders `autoDispatch.contentionPolicy` in plain
language, so the mental model — *"how many can safely run in parallel, decided by
rules and (later) an LLM"* — is present from day one and Phase 4 slots in with no
UI redesign:

- **Full parallelism** (`none`) — items are independent; run up to the count
  limit. **Rendered disabled in the shipped picker (#2272)** — Amendment 1 A1.4
  / Amendment 4 A4.4 already established this value was never implemented
  (epic-serialization runs unconditionally in `selectAutoDispatch`, regardless
  of `contentionPolicy`), so the picker shows it with an inline explanation
  rather than wiring a radio to a value the backend silently ignores.
- **Serialize same epic** (`epic-serial`, the default and the *only* rule
  enforced today) — never two in-flight tickets sharing `epicId`. The one
  selectable option in the shipped picker.
- **Smart: LLM predicts file conflicts** (`predicted-paths`, Phase 4 #2249,
  Amendment 4) — the predictor itself shipped in Amendment 4
  (`predicted-paths.js` + its `orchestrator.js` wiring); the picker (#2272,
  Amendment 5) renders the option too, but still **disabled/"coming"** by this
  issue's own design — deferred alongside the live lane visualization
  (Phase 5) rather than exposed the moment the panel ships. The bundle
  validator accepts the value (Amendment 1 A1.4 is updated by Amendment 4);
  only the UI keeps it off for now.

**A2.4 — Backend prerequisite: a live `pool` write, at parity with
`wipLimit`/`autoDispatch`. Shipped (#2280).** `PUT /api/agents/:teamId` already
accepted live `wipLimit`/`autoDispatch` (team-agent only); `PUT
/api/agents/:memberId` now accepts `pool` too (member/role config only, gated
to `fresh.role === 'team-member'`). Rather than reaching into
`orchestrator/agent-pool.js`'s `normalizePoolConfig` directly, the route follows
the same hand-synced-twin precedent `wipLimit`/`autoDispatch` already set:
it reuses `process-template.js`'s own `normalizePool`, and the bundle
validator's inline shape check was extracted into a shared, exported
`poolConfigError(pool, { wipLimitSet })` so the bundle path and the live route
run the identical check rather than a second hand-synced copy. Same discipline
as before: closed `workspace` enum, `maxInstances` a positive int or `null`,
and `pool.enabled` requiring the parent team's `wipLimit` to be set (else the
pool would spawn unbounded and never be reaped) — looked up via
`fresh.parentTeamId`, since the member itself carries no `wipLimit`. It is an
**additive** effect — no respawn of the template (instances spawn on the next
dispatch); clearing it (`null`) reverts the role to a persistent singleton.
Draft round-trip already carried `pool`, so this closed the *live-team*
editing gap; the per-role config-UI panel itself (the mockup below) remains
unbuilt.

**A2.5 — Out of scope for this UI (kept for the named later phases).** Board
runtime controls (pause / drain / force-dispatch, shipped as Amendment 6
#2250 — see its own scope note there for what still isn't built); building the
`predicted-paths` predictor itself (shipped as Phase 4 #2249, Amendment 4); a
per-role `wipLimit` (intentionally absent, A2.1). No new contention semantics.

### Mockups

```
Team / flow surface — "Parallelism" panel (Flow editor, team scope)
┌ Parallelism ─────────────────────────────────────┐
│  Work in parallel                                 │
│  Up to  [ 3 ▾ ]  tickets at the same time         │
│                                                   │
│  Contention                                       │
│   ( ) Full parallelism                            │
│   (•) Serialize same epic          ← today        │
│   ( ) Smart: LLM predicts conflicts   (coming)    │
│                                                   │
│  Auto-start ready tickets            ( ●  on )    │
│      Oldest first, up to the limit above          │
└───────────────────────────────────────────────────┘

Per-role surface — NodeInspector / agent Settings tab
┌ Scaling ─────────────────────────────────────────┐
│  [x] This role auto-scales (pool)                 │
│      Max parallel instances   [ 4 ]               │
│      Idle timeout [ 30m ]   Hard timeout [ 2h ]   │
└───────────────────────────────────────────────────┘

Live surface — lanes per pooled role (read-only)
  developer   ⚙ up to 4 · 🔒 same-epic serialized
    ├─ i412  ● running
    ├─ i418  ● running
    └─ i421  ⏸ held (same epic as i412)
  reviewer    ⚙ up to 2
    └─ i407  ● running
```

---

## Amendment 3 — what §6 (Phase 3) actually shipped (#2248)

Landed as `orchestrator/recurring-pool-source.js` (pure — mirrors
`agent-pool.js`'s / `flow-supervisor.js`'s no-fs/no-network shape) + a
maintenance-gated `orchestrator.js` timer (`runRecurringPoolTick` →
`recurringPoolSweepTeam`), reusing the SAME item-keyed identity
(`agentPool.poolInstanceId`) and spawn hand (`spawnPoolInstance`) the SDLC
binding uses — no new spawn primitive. Three things sharpen §6 as written.

**A3.1 — the config surface is `pool.workSource`, a sibling of `baseBranch` on
the same normalized `pool` object.** §9 named `workspace`/`baseBranch` as the
git binding's own fields on the shared surface; `workSource: {items[],
outputDir, inputDir?}` is this binding's equivalent, following the identical
precedent — meaningless (and refused by `validateProcessTemplate`) on
`workspace: "git-clean-base"`. `items` is the "list" work source (§6): a
static, operator-authored array of work-item ids, deduplicated on normalize.
`outputDir` is **required** — it is simultaneously the completion signal ("the
output artifact exists") and the D11 "already done this cycle?" check: an
item is done when `<outputDir>/<item>.json` exists, checked fresh every tick,
no separate state file needed. `inputDir` is optional and consulted only for
the `input-copy` workspace binding (a `none` binding never reads it — concept
Insight B).

**A3.2 — release (D4) and dispatch are the same tick, release first.** Unlike
the SDLC binding (whose release is the admission-control reconcile tick,
separate from the Flow Supervisor's dispatch tick), there is no ticket ledger
here to reconcile — `recurringPoolSweepTeam` itself reaps every live instance
whose item's output artifact has appeared (`_internalSelfDelete`, the same
teardown hand-off every pooled role uses), THEN computes the still-live set
and dispatches the rest. Reaping first means a slot an item just vacated is
immediately available to a still-pending item in the same pass, rather than
waiting a full tick.

**A3.3 — contention = none still means "up to a limit," not "unbounded."** §6
reads "full parallelism up to the resource/rate limit" — this phase resolves
that limit as `pool.maxInstances` if set, else the team's `wipLimit` (D5's
precedence, matching the SDLC binding). Unlike the SDLC path, there is no
admission lane underneath to fall back on as a second gate, so a role with
NEITHER configured is a refusal (logged, not a spawn) rather than silently
falling through to `Infinity` — `pool.enabled` already requires `wipLimit` be
set (`validateProcessTemplate`), so this is a defensive floor for a
hand-edited or pre-validation config, not the expected path.

**Not built, and not owed by this ticket:** a `dir`-enumeration work source
(only a static `items` list ships — §6 says "a list / cron enumerating," and
the list half is what proves neutrality); per-item retry/backoff on a crashed
instance beyond the existing D8 hard-timeout reaper (which already applies
unchanged — it has no notion of GitHub either); any UI for authoring
`workSource` (Amendment 2 scoped the config UI to `pool.enabled`/
`maxInstances`/`workspace`/teardown — a `workSource` editor is later, additive
work, same as everything Amendment 2 §A2.5 already deferred).

---

## Amendment 4 — what Phase 4 (LLM conflict prediction) actually shipped (#2249)

Landed as `orchestrator/predicted-paths.js` (pure — mirrors `flow-supervisor.js`'s
no-fs/no-network shape: sanitizing a path list, the overlap check, the LLM
prompt/response builders, and the heuristic fallback) + an `orchestrator.js`
extension of the EXISTING Flow Supervisor sweep (no new timer) that predicts
paths for about-to-dispatch candidates and folds the result into
`flow-supervisor.js`'s `selectAutoDispatch`. Four things sharpen D6/§7 as
written.

**A4.1 — layered, not exclusive: epic-serialization is untouched.** D6 calls
conflict avoidance "layered," and Amendment 1 A1.4 already established that
epic-serialization is not itself optional. `predicted-paths` therefore ADDS a
second, independent skip condition to `selectAutoDispatch` (a candidate whose
predicted paths overlap an already-busy path set) rather than replacing or
branching around the epic check — a candidate can be held back by either axis,
and both are checked on every candidate. `autoDispatch.contentionPolicy:
'epic-serial'` (or unset) is byte-identical to pre-#2249 behaviour; only
`'predicted-paths'` activates the new branch, and it does so entirely inside
`selectAutoDispatch` — the pure core takes `busyPathSets` and each candidate's
own `predictedPaths` as plain data, never touching fs/network/an LLM itself.

**A4.2 — prediction is computed ONCE per ticket, only for candidates actually
about to be considered, and never blocks on failure.** `orchestrator.js`'s
`_ensurePredictedPaths` fills in the predicted-paths cache
(`predicted-paths-cache.json`, a sibling of `flow-supervisor-budget.json`) only
for tickets with the `unclaimed` blocker (the same set `selectAutoDispatch`
would dispatch this tick) that have no cache entry yet — an active ticket's
prediction, once made, is read from the cache as a "busy" set forever after,
never recomputed. A prediction is advisory: an empty/missing/failed result
(`[]`, or no `predictedPaths` field at all) imposes **no extra restriction** —
`selectAutoDispatch` only ever narrows the field for a candidate that reported a
non-empty guess, so a mispredicting or unconfigured team degrades to exactly
Phase 2's behaviour, never to an unexplained stall. Nothing here removes or
weakens the ledger's `conflict`/`stale-base`/`superseded` blockers (D6's
non-goal — sequential conflicts are still accepted, not eliminated).

**A4.3 — "LLM over the issue + repo structure, or a heuristic" reuses existing
hands on both halves, adding no new billing or fetch primitive.** The LLM half
resolves the SAME team-billed provider #1213 already established
(`resolveAssistBindingForTeam`) and calls the SAME generic single-turn
synthesis function knowledge curation already uses (`_synthesizeSkillMd`) — no
new `/v1/messages` call site. The issue body and a capped repo-tree sample
(`_fetchRepoTreeSample`) are both fetched via `_flowGithubGetJson`, the exact
GET-JSON hand the ticket ledger and flow-anomaly sweeps already use — no new
GitHub client. When no assist provider is configured for the team, or the LLM
call/response-parse fails outright, `predicted-paths.js#extractHeuristicPaths`
(a regex scan for path-shaped tokens in the ticket's own title/body — the
`` `docs/x.md` `` convention this repo's own issues already follow) is the
fallback — always available, no network, no cost.

**A4.4 — the `predicted-paths` contentionPolicy value is now accepted, not
refused.** Amendment 1 A1.4 had `validateProcessTemplate` refuse it as
not-yet-implemented; `AUTO_DISPATCH_CONTENTION_POLICIES` now lists it alongside
`epic-serial`. `'none'` (full parallelism) remains unimplemented — the closed-set
refusal discipline is unchanged for any value this phase did not add.

**Not built, and not owed by this ticket:** the Amendment 2 "Smart: LLM
predicts file conflicts" picker in the Parallelism panel — the config UI
(A2.2/A2.3) was never built for ANY `contentionPolicy` value, so
`predicted-paths` is reachable today the same way `epic-serial` always has
been (a hand-authored bundle or a raw `PUT`), not a new gap this phase opened;
board-visible predicted-path lanes (Amendment 2's "Live surface," Phase 5); any
cache-invalidation on issue-body edits (a prediction is computed once and kept
forever — re-predicting on every edit was judged not worth the added
complexity/cost for an advisory, safety-netted signal).

---

## Amendment 5 — what the team/flow config UI (#2272) actually shipped

Landed as a pure `admin-console/src/pages/process/parallelism-view.js` (#651)
+ `ParallelismPanel.jsx` (the Flow editor's new toolbar button, live-team scope
only) + a compact read-only summary reusing the same module on the team view
(`AgentEditForm.jsx`'s General tab). No backend change — both fields already
round-tripped through `PUT /api/agents/:teamId` (#2114/#2247); this ticket is
UI only, exactly as A2.2's "Team / flow surface" scoped it. Three things
sharpen A2.2/A2.3 as written.

**A5.1 — "Full parallelism" ships disabled, contrary to the A2.3 mockup.** The
mockup (and the issue's own AC list) shows only "Smart: LLM predicts
conflicts" marked `(coming)`, with "Full parallelism" as a plain selectable
radio. But Amendment 1 A1.4 and Amendment 4 A4.4 had already established that
`contentionPolicy: "none"` was never implemented — epic-serialization in
`orchestrator/flow-supervisor.js#selectAutoDispatch` runs unconditionally,
regardless of `contentionPolicy` — and the live `PUT` route's
`normalizeAutoDispatch` silently drops an unrecognised `contentionPolicy`
rather than erroring. Shipping "Full parallelism" as a live, enabled radio
would therefore have looked like a working choice while silently doing
nothing — exactly the "half-applies with no error" failure this codebase's
validators are written to avoid (`poolConfigError`, the bundle's closed enums).
The panel instead renders it disabled with an inline explanation, the same
treatment as "Smart," so **only `epic-serial` is selectable** in this first
cut — a deliberate deviation from the issue's literal AC text, grounded in
two Amendments already on record, not a fresh judgement call made in
isolation.

**A5.2 — the auto-dispatch prerequisite is mirrored client-side, not
re-derived.** `parallelism-view.js#autoDispatchPrerequisite` restates the exact
two checks `PUT /api/agents/:teamId` runs (`api.js`: `wipLimit` set, at least
one team member with `pool.enabled`) so the panel can grey the "Auto-start
ready tickets" toggle with the actual reason instead of letting the save 400.
The pooled-role check reads the SAME `/api/agents` list the page's team picker
already fetches (`hasPooledMember`, keyed on `parentTeamId` + `pool.enabled`)
— no second fetch, and the two prerequisite checks can never drift out of sync
with different data than the panel's own team/role list.

**A5.3 — the compact team-view summary reuses the panel's own formatter,
verbatim.** `parallelismSummary()` is the one function behind both surfaces
(A2.2's "one model" for the team axis): the Flow editor's toolbar tooltip and
the read-only General-tab block never restate the wipLimit/contention/
auto-dispatch logic a second time. An unconfigured team (the common case
pre-#2272) reads as a single "No ticket limit set" line rather than three
mostly-blank rows.

**Not built, and not owed by this ticket:** the per-role surface (`pool.enabled`
picker in `NodeInspector`/agent Settings, A2.2's other bullet — A2.4 shipped
only the live-write endpoint it would call, #2280; the picker itself shipped
next, see Amendment 7, #2271); the live lane visualization (A2.2's "Live
surface," Phase 5 #2250); enabling the `predicted-paths` radio (A5.1 —
deferred by the issue's own design, tracked alongside Phase 5's board
controls, not a gap this ticket left open).

---

## Amendment 6 — what Phase 5 (board controls) actually shipped (#2250)

An audit against §12's five-item Phase 5 list, then the one item this ticket
actually built.

**A6.0 — three of the five items were already true before this ticket
started; only board controls needed building.** Per-role concurrency caps
(`maxInstances`) shipped in Phase 1 (#2246) and are enforced in
`planPoolDispatch` — filed under Phase 5 in §12's original list, corrected by
Amendment 2 §A2.1. Reviewer pools need no new code: nothing in
`agent-pool.js`/`flow-supervisor.js`/`recurring-pool-source.js` names a role
id or role KIND — `pool.enabled` is a plain per-role opt-in, so a `reviewer`
role pools exactly like a `developer` role today. The remaining two —
**headless (Matrix-less) runtime (D7)** and **provider-health-aware admission
(D9)** — have no design beyond the one sentence each got in §11 ("later,
additive"); this ticket does not guess at one. They need their own design
pass (open questions: what a headless instance's chat-equivalent surface is
for `AskUserQuestion`/approval gates; what "provider health" means as an
admission signal beyond the existing WIP limit) and are flagged as a
follow-up ticket rather than implemented speculatively.

**A6.1 — pause/drain is a RUNTIME toggle, deliberately kept out of `pool`
config.** `pool` (§9) is the static, bundle-round-tripped template shape;
pausing a role is an operator action from the board, not a template edit, so
it is persisted separately (`pool-control.json`, a sibling of the admission
lane and the Flow Supervisor's budget file — same `controlOrPoolPath`
convention) and never touches the bundle, live-write endpoint, or respawn
path. Clearing it (`state: "running"` or omitted) deletes the record rather
than writing the default explicitly, so an unconfigured team's file never
grows, and reading it back is `poolControlState(control, roleId)` →
`'running'` for anything not recorded.

**A6.2 — `paused` and `draining` are, deliberately, the same dispatch-refusing
effect — the distinction §11 left open is resolved as a naming/intent
convention, not a behavioural fork.** Both refuse a NEW spawn
(`planPoolDispatch`'s new `controlState` parameter) while leaving an
already-admitted ticket's REUSE untouched (D11/D4: pausing intake is not the
same as abandoning work already in flight) — `routePooledDispatch` (SDLC),
`flowSupervisorSweepTeam` (autonomous dispatch) and `recurringPoolSweepTeam`
(the recurring binding, dispatch half only — its reap/completion half runs
unconditionally either way, so a drained role's finishing instances are still
torn down) all read the same control state through the same gate. `paused`
reads as "temporary, expect to resume"; `draining` reads as "shutting this
role down — flip `pool.enabled` off once it goes idle." A future UI could
still fork the two (e.g. auto-suggest disabling the role once a draining
role's instance count hits zero); nothing here forecloses that, it simply
isn't built.

**A6.2b — a refusal must be held, never allowed to fall through to the
TEMPLATE's own queue (code-review finding, rework of #2281).** The first cut
of A6.2 above had `routePooledDispatch` return the same bare `null` for a
pause/drain refusal as it does for "not pooled at all" — the caller
(`enqueuePending`) cannot tell those apart, so it fell through to its
unconditional final branch and dispatched straight to the pooled ROLE's own
`pending-triggers.json`, i.e. ran the ticket under the shared, unpooled
identity *while the board showed the role as paused*. `flowSupervisorSweepTeam`
and `recurringPoolSweepTeam` never had this gap — both filter the role out of
their candidate set before ever attempting a dispatch, so there is no
downstream branch that can fall through. It is specific to the
`routePooledDispatch`/`enqueuePending` pair on the SDLC label-triggered path
(and, by the same code path, force-dispatch — see A6.3). Fixed by giving the
refusal a durable home instead of vanishing into `null`: a paused/draining
refusal is appended to a new per-team, per-role hold file
(`pool-paused-hold.json`, sibling of `pool-control.json`, validated by
`agentPool.normalizePausedHold`) and `routePooledDispatch` returns a
distinguishable `{ held: true }`, which `enqueuePending` short-circuits on
(`return true` — recorded, will fire later, the same "durably queued" contract
the admission lane's own `held` array makes) rather than falling through. The
hold is replayed the moment the role resumes (`POST .../pool-control/:roleId`
with `state: "running"` or omitted): every entry queued for that role is
redelivered through `enqueuePending(..., { admissionChecked: true })` —
`admissionChecked` because these already passed the wipLimit gate on their
first attempt, and a second pass would double-count them in the lane. This is
deliberately its OWN file, not a reuse of the admission lane's `held` array:
that one is keyed by wipLimit capacity math (`inFlight`/`held` bookkeeping a
paused-but-not-capacity-limited ticket has nothing to do with), and
conflating the two would let a paused role's holds count toward — or worse,
silently mutate — a team-wide capacity number they were never part of.

**A6.3 — force-dispatch promotes ONE named held entry past the WIP limit,
recording it in `inFlight` exactly like a normal admit.** `heldIdentity`
(already used internally by `admit`/`promoteHeld`) is now also the
client-facing id `GET .../pool-control` returns for each held entry, and the
only thing `POST .../force-dispatch` accepts — never a ticket number or agent
id alone, both of which can be ambiguous (the same agent can hold more than
one entry; force-dispatch must promote the exact one the operator looked at).
`admission-control.js`'s new `forcePromoteHeld` deliberately does NOT reuse
`admit({wipLimit: null, ...})` — that path hits the `no-limit` back-compat
branch and returns the lane UNCHANGED (§4.0's "an ungated flow never grows a
lane record"), which would have made the forced ticket invisible to D4
release tracking and to the very next `wipLimit` check. It instead mirrors
`admit`'s own capacity-admit bookkeeping directly: append to `inFlight` (or
merge into an existing same-ticket entry), still counted, still released
normally — only the REFUSAL is skipped, never the accounting the refusal
exists to protect. Force-dispatch bypasses `wipLimit` only, never pause/drain:
if the target role is currently paused/draining, the same A6.2b fix applies —
`enqueuePending` holds the forced entry in the paused-hold queue rather than
falling through to the template, and it redelivers on resume like any other
held dispatch. This resolved, as a side effect of A6.2b rather than its own
branch, the smaller related gap the #2281 code review flagged.

**A6.4 — the board controls landed on the EXISTING Flow Control board
(#2116), not the Amendment 2 "Live surface" lane visualization.** Two new
panels (`PoolControlPanel`, `HeldPanel` in `FlowControl.jsx`) read a new
`GET /api/teams/<id>/pool-control` proxy alongside the existing ticket-ledger
fetch: one row per pooled role (state + live instance count vs.
`maxInstances`, with Pause/Drain/Resume buttons) and one row per held
admission-lane entry (with a Force-dispatch button). The ticket LEDGER itself
stays exactly as observe-only as §4.1 requires — these two panels act on the
admission lane / pool-control file, never on a ticket's own derived state, so
the board's core honesty guarantee (a card's stage is never set by a label or
a click) is untouched; `flow-control-help-extraction.test.js` now asserts
that every mutating call the page makes targets one of these two endpoints,
never `/tickets`. The full per-instance lane view A2.2 designed (running /
held-same-epic / timed-out per instance, derived from `inFlight`) is still
not built — these panels answer "which role is paused and what is held",
not "show me every live instance."

**Not built, and not owed by this ticket:** the A2.2 per-instance lane
visualization (above); a headless runtime (D7) and provider-health-aware
admission (D9) — flagged for a follow-up design ticket, per A6.0; any
audit-log entry beyond the existing mutation-audit middleware + a
`console.log` (pause/resume/drain and force-dispatch are visible on the board
itself and in the server log; a dedicated GitHub Event Log row was judged not
worth a new event-log call site for an internal-only toggle).

---

## Amendment 7 — what the per-role config UI (#2271) actually shipped

Landed as a pure `admin-console/src/pages/process/scaling-view.js` (#651) +
`ScalingSection.jsx`, ONE component embedded in both per-role hosts A2.2 names
— the Flow editor's `NodeInspector` (a live team-member node's Details tab)
and the agent's own Settings tab (`AgentEditForm.jsx`) — following the exact
"one model, several surfaces" precedent Amendment 5 set for the team axis.
No backend change: `pool` already round-tripped through `PUT
/api/agents/:memberId` (#2270); this ticket is UI only. Three things sharpen
A2.2/A2.4 as written.

**A7.1 — the prerequisite is the PARENT TEAM's `wipLimit`, not the member's
own.** Unlike the team-axis panel (Amendment 5, whose two prerequisites both
read fields on the team object being edited), a team-member carries no
`wipLimit` of its own (A2.4) — `scaling-view.js#scalingPrerequisite` takes
`parentWipLimit` as a plain parameter the caller resolves from its own
already-fetched data (the flat `/api/agents` list in `ProcessCanvas.jsx`, the
already-fetched `parentTeam` config in `AgentEditForm.jsx`), mirroring the
live route's own `fresh.parentTeamId` lookup (`api.js`, #2270) rather than a
second fetch inside the shared component.

**A7.2 — teardown timeouts are authored in minutes, persisted in
milliseconds.** The mockup's own shorthand ("30m," "2h") reads as a duration
unit, not a raw millisecond count — `scaling-view.js#parseMinutesInput`/
`msToMinutesText` is the one place either direction of that conversion
happens, so the three teardown fields (idle / hard / retain) round-trip
through the same pair of pure functions rather than three hand-rolled
conversions.

**A7.3 — the read-only "at a glance" badge lives in `NodeInspector`'s
existing top badge row, not a duplicate of the editable section.** A2.2 asks
for a read-only "pooled role · up to N" badge "on the single-agent view, so
an operator looking at one agent sees its scaling at a glance" — as a
judgement call, this reads that badge as living somewhere OTHER than the
editable Scaling section itself (echoing a value already visible there would
be redundant), matching Amendment 5's own read-only-summary-in-a-different-
place pattern for the team axis. `NodeInspector` already carries a top badge
row (role / `per-invocation` / "DM entry point") visible regardless of which
tab is active — the pooled badge (`scaling-view.js#poolBadgeText`) joins it
there, so the "at a glance" framing holds even before Details is opened or
scrolled to the Scaling section. The Settings-tab host does not repeat the
badge, since its own Scaling section (with the same checkbox/maxInstances
state) is right there.

**Not built, and not owed by this ticket:** the live lane visualization
(A2.2's "Live surface," shipped separately as Amendment 8 #2273);
`pool.workSource` authoring (Amendment 3's own "not owed" list, unchanged); a
draft-mode (pre-materialise) editor for
`pool` — the live `PUT /api/agents/:memberId` route (#2270) this ticket writes
through only accepts a materialised team-member, so the Scaling section is
live-only, gated the same way the route itself is (`node.role ===
'team-member'`); a bundle round-trip already carries the field with no UI
needed on that path.

**A7.4 — the Workspace dropdown itself was removed again (#2294).** Every
pooled role now behaves as `workspace: "git-clean-base"` implicitly:
`ScalingSection.jsx` no longer renders the field or threads a `workspace`
value into `buildPoolPayload` (which already defaults an omitted `workspace`
to `git-clean-base`), so this is a no-op for every configuration that could
actually be reached through the form — `input-copy`/`none` were never
selectable in the shipped picker without a `workSource` editor to back them
(A2.5/A3's "not owed" list, still true). `POOL_WORKSPACE_OPTIONS`/
`workspaceValue` stay in `scaling-view.js`, pure and still unit-tested, as the
reusable building block for the future ticket that adds a `workSource`
configuration screen. The live route's own closed `workspace` enum (A2.4) and
`pool.workspace`/`normalizePool` are untouched — a hand-authored template or
API call can still set `input-copy`/`none`, there is simply no UI control for
it.

---

## Amendment 8 — what the live lane visualization (#2273) actually shipped

Landed as a pure `orchestrator/pool-instance-lanes.js` (mirroring
`admission-control.js`/`agent-pool.js`'s own shape — no fs, no network, no
clock of its own) + `GET /internal/teams/:id/pool-lanes` /
`GET /api/teams/:id/pool-lanes` (read-only, gated like `tickets`/
`pool-control`) + a third, read-only panel on the Flow Control board
(`PoolLanesPanel`, beside the Amendment 6 `PoolControlPanel`/`HeldPanel`).
No new persistence, as A2.2 demanded. Two decisions sharpen A2.2 as written.

**A8.1 — only two of the mockup's three tags are drawn from the same source.**
`running`/`timed-out` come from each role's actual LIVE instances
(`_liveInstancesForRole`, the same identity fields — `poolRepo`/`poolItem`/
`poolSpawnedAt` — the D8 hard-timeout reaper already trusts, so the lane view
can never disagree with what will actually get reaped). `held-same-epic` is
NOT read off the admission lane's `held` list — that list's own hold reason
is always `at-limit` (a WIP-limit refusal, already fully surfaced by the
Amendment 6 `HeldPanel`); epic-serialization (Amendment 1 A1.4, always on)
never touches the admission lane at all, it simply never gets SELECTED by the
Flow Supervisor. So `held-same-epic` is derived entirely from the ticket
ledger instead: any of the role's own active-state tickets
(`ownerAgentId === role.agentId`, mirroring `orchestrator.js`'s own
`FLOW_SUPERVISOR_ACTIVE_STATES`) that has not itself spawned an instance yet,
but shares an `epicId` with one that has. A ticket held on the WIP limit for
a reason OTHER than same-epic gets no lane here — duplicating the WIP-limit
panel per-role would be a second, driftable rendering of the same fact.

**A8.2 — the panel is additive to the existing board, not a new route.** A2.2
asked for the surface "in the Flow editor (and/or the team view)"; this ships
it on the Flow Control board instead, alongside the Amendment 6 controls it
narrates — the board is already the one place an operator watches a pooled
role's live state, and a fourth route/registration for the same team-scoped
data would be a second home for one fact. Polls on the same refresh cadence
as the rest of the board (manual Refresh + after every pause/resume/drain/
force-dispatch action), no dedicated auto-refresh timer of its own.

## Amendment 9 — Agent Chat left-rail sub-grouping (#2297; live-refreshed, see Amendment 11)

Amendment 8 gave a pooled role's live instances a home on the Flow Control
board; #2297 gives them one in **Agent Chat** too, where the rail previously
listed every instance as a flat, indented sibling of every other team member —
scattered as instances came and went, indistinguishable from a hand-created
member.

- `GET /api/matrix/agents` now ships `poolInstance: true` / `poolOf` /
  `poolItem` / `poolSpawnedAt` on an instance row (present only on such a row,
  same convention as `canManageTeam`) — the same identity fields Amendment 8
  reads server-side, now surfaced client-side.
- `agent-list-model.js` `buildGroups` nests each role's live instances onto
  it (`role.instances`, sorted by `poolItem`) rather than leaving them in the
  flat member list; an instance whose `poolOf` names no role in the team
  (template hidden/filtered) stays flat instead of vanishing.
- `AgentList.jsx` renders it as a collapsible **Instances (N)** sub-list one
  indent level deeper than the role, persisted like a team group's own
  collapse state (`{kind:'pool', id:<roleId>}` in the same `collapsedMap`) —
  deliberately unlike the `StubSection`'s local, always-collapsed-by-default
  state, since a live pool's instance list is activity to keep an eye on, not
  a to-do list that empties itself. Each row is an ordinary, chat-openable
  `AgentRow` — same status dot off the same `statuses` poll, same click-to-open
  path — reusing existing machinery rather than adding a second one.
- Read-only, no new persistence beyond the existing collapse-state map: an
  instance still disappears from the sub-list the moment the pool reaper (or a
  manual teardown) removes it, exactly as it already did.

## Amendment 10 — the `AEE_POOLS_ENABLED` feature flag (#2302)

Everything above (Amendments 1–9) shipped visible and reachable by default.
#2302 adds a boot-time kill switch — `AEE_POOLS_ENABLED`, **off by default** —
because the mechanism still needs teardown/reaping polish before it is
production-ready: `admin-console/api/pools-mode.js` mirrors `auth-mode.js`'s
own `AUTH_ENABLED` resolver exactly (same `ON_TOKENS`/`OFF_TOKENS`, same
read-once-at-boot pattern), and `GET /api/pools-mode` feeds a one-shot
`PoolsFeatureProvider` context (no polling — the flag can't change without a
restart, unlike Maintenance Mode).

Flag off (the default) hides vs. disables, deliberately per-surface:

- **Flow Editor toolbar** (`ProcessCanvas.jsx`): the **Parallelism**
  button/panel (Amendment 2/6/8's board) disappear entirely — this surface
  configures `wipLimit`/`autoDispatch`, which stay meaningless until pooling
  itself is on.
- **Per-role Scaling section** (Amendment 7's shared `ScalingSection.jsx`, in
  both Agent Chat Settings and the Flow Editor's `NodeInspector`): stays
  **visible but inert** — every input and the Save button disabled
  (`ScalingSection`'s new `disabled` prop folds into its existing `blocked`
  check) — plus a "Coming Soon" badge (`ComingSoonBadge.jsx`) next to the
  "Scaling" label — rather than vanishing, so the feature isn't forgotten and
  a role's already-persisted `pool` config stays visible.

**Not wired: docker-compose passthrough.** Every other boot flag documented
in `.env.example` (`AUTH_ENABLED`, `AUTH_SESSION_SECRET`,
`AUTH_COOKIE_SECURE`, …) has a matching `"${VAR:-}"` line in the
`admin-console` service's `environment:` block in `docker-compose.yml` — the
container has no `env_file`, so a var only reaches `process.env` there if it
is listed explicitly. `AEE_POOLS_ENABLED` was added to `.env.example`
(documentation fix, #2302 follow-up) but **not** to `docker-compose.yml`, so
on a standard compose deployment setting it in `.env` currently has no
effect — the flag reads as unset (off) regardless. Flagging here rather than
patching `docker-compose.yml` silently, since that is a deployment-manifest
change outside a docs fix.

## Amendment 11 — Agent Chat left-rail live refresh (#2311)

Amendment 9 shipped the **Instances (N)** sub-list, but its own closing line
overstated what it actually did: *"an instance still disappears from the
sub-list the moment the pool reaper (or a manual teardown) removes it, exactly
as it already did."* That was aspirational, not true — the rail's whole roster
(`GET /api/matrix/agents`) was fetched exactly **once**, on mount/navigation/
filter-toggle (`useApi`), so a spawn, reap, rename, or enable/disable
happening anywhere else (another tab, another user, autoscaling) never showed
up until the user manually reloaded. #2311 makes that sentence true.

- **`AgentRosterContext.jsx`** (new) polls the same `GET /api/matrix/agents`
  endpoint on its own ~5s interval, mounted once inside `AgentChat.jsx` (not
  globally) — a singleton-context poll mirroring `AgentStatusesContext.jsx`'s
  #1677 pattern, so however many rail pieces read the roster, the endpoint is
  still hit at most once per interval per open tab. Deliberately a *second*,
  independent timer rather than merged into the existing `/api/agents/statuses`
  beat: same ~5s cadence by convention (D1), but the two payloads (roster
  shape vs. per-agent activity state) stay decoupled, and the existing status
  beat's own frequency is untouched.
- **`roster-diff.js`** (new, pure) `mergeRoster(prev, next)` reuses each
  agent's previous object reference when its fields are unchanged, and reports
  `changed: false` (returning the *exact previous array*) when the fetched
  roster is a no-op. This is what makes the refresh actually safe to run every
  5s over an open chat: `agent-list-model.js`'s `useMemo` grouping chain
  (#1682) only re-runs when something real changed, no row unmounts/remounts
  for unchanged data, and — the sharpest edge case — `ChatPanel`'s lazy
  DM-room-creation effect (keyed on `[agent, roomId, onRoomCreated]`) does not
  refire `POST /api/matrix/agents/:id/dm` forever on a stuck room, because a
  poll tick that didn't touch that agent hands the effect the identical
  object it already had. `AgentChat.jsx` also memoizes its `onRoomCreated`
  callback itself (`handleChatRoomCreated`) for the same reason — an inline
  arrow rebuilt every render would have defeated the object-reference fix.
- **`agent-roster-poll.js`** (new, pure) `shouldTickPoll`/
  `shouldRefreshOnVisible` implement D5: the interval is suppressed while
  `document.hidden`, and the hidden→visible edge fires one immediate
  out-of-band refresh on top of resuming the normal interval.
- **Failure handling**: a failed background tick is silent — the last good
  roster and any prior error state stay exactly as they were, and polling
  continues at the same fixed interval (no backoff, so no request-storm risk
  either way). Only the initial load (or an explicit caller-triggered
  `refetch()`, e.g. after a lifecycle mutation) surfaces a failure via the
  existing error/Retry banner, unchanged from the pre-#2311 `useApi` behavior.
  A 401 on any tick — foreground or background — routes through the existing
  `UNAUTHORIZED_EVENT` (the same mechanism `useApi` itself uses) and stops
  the poller for that provider instance.
- **The currently open chat's agent disappearing** (open question D2) does
  NOT auto-navigate away and does NOT fall back to the unrelated "pick an
  agent" empty state: `AgentChat.jsx` remembers the last confirmed-present
  snapshot for the routed `:agentId` (`seenAgentIdRef`/`lastSeenAgentRef`) and
  keeps rendering `ChatPanel` against it — same room, same transcript, same
  scroll position — with an inline notice banner
  (`agent-removed-notice.js` / `ChatPanel`'s `removedFromRoster` prop) instead
  of the disabled-agent banner. A route that never named a real agent at all
  (a bad deep link) still bounces to `/chats` exactly as before.
- **Scope**: Agent Chat rail only (D4) — the pure `roster-diff.js` module has
  no Agent Chat import and could back another live list later, but nothing
  else was wired to it. Independent of `AEE_POOLS_ENABLED` (Amendment 10):
  the refresh mechanism is roster-generic and always on; with pooling off
  there simply are no pool instances for it to reveal.
- **Not done**: no highlight/flash animation on a newly-appeared row (D3) —
  judged not worth the added state/timer risk for a cosmetic nice-to-have.
