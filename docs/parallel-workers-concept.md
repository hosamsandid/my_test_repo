# Agent instance pools — ephemeral, self-cleaning workers over a stream of work items

> Status: **concept / design of record**. No code yet. This document scopes the
> discussion in issue #2251 (the Agent Pools epic). Its SDLC binding builds
> directly on the shipped Flow Control machinery (`docs/flow-control-concept.md`):
> admission control (#2114), the ticket ledger (#2115) and the board (#2116). Its
> autonomous half is, in effect, the concrete design for that document's
> **unbuilt §4.3 Flow Supervisor**, generalised beyond a single repository.

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
  (D9), per-role caps (D5), LLM path-prediction (D6) — all later/additive.
- **Open:** exact retention window for archived instance logs; whether §6
  precedes or follows §7; board controls for a pool (pause / drain / force
  dispatch) land in polish.

## 12. Phases

- **Phase 1 — Pool core + SDLC binding (label-triggered).** Neutral core + the
  four GitHub/git adapters; conflict protection = WIP count + post-hoc detection
  only; pull-on-demand base; graceful teardown with log archive; item-keyed
  idempotency. *Result: one label → N auto-scaling, self-cleaning workers — no
  hand-cloning.* Readiness still applied by a human/upstream agent.
- **Phase 2 — Autonomous supervisor.** Drain the backlog up to the limit,
  oldest-first, epic-serialization, plus the designed remediation ladder.
  *Result: apply `ready` and walk away.*
- **Phase 3 — Second binding: recurring analysis.** Prove generality with no
  GitHub (list/cron source, input-copy workspace, artifact completion, no
  contention). Independent of Phase 2.
- **Phase 4 — LLM conflict prediction** (SDLC only, only if epic-serialization is
  not enough).
- **Phase 5 — Polish.** Board controls, per-role caps, reviewer pools, optional
  headless runtime, provider-aware admission.
