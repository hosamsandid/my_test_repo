# Flow Reconciliation & Claim Labels — Concept

> Status: **Layers 1 and 2 implemented** (PR #953, PR #974); **Layer 3 Phase 3 (detector + observe panel) implemented** (PR #993); Phase 4 (responder/reaction ladder) is design.
> Layer 1: runner retry + loud failure (`agent-image/scripts/agent-entrypoint.py`).
> Layer 2: declarative `claim` field on `github-event` triggers — runtime label swap + rollback
> on final failure (`agent-image/scripts/agent-entrypoint.py`, PR #974).
> Layer 3 Phase 3: pure deterministic detector (`orchestrator/flow-anomaly-detector.js`) + sweep adapter (`orchestrator/flow-anomaly-sweep.js`) + endpoint `GET /api/teams/:teamId/flow-anomalies` + observe-only **Anomalies** panel in the Flows view (PR #993).
> Grounded in a real production stall analyzed on 2026-07-29 (issue #902 / PR #949 in the Agent Studio team's repo).

## 1. The incident that motivates this

Two links of the same delivery chain stalled on the same morning, for two
*different* reasons — and the GitHub event-transparency log proves that **no
event was lost in either case**:

- **Issue #902** (`ready` label): the poller delivered the `issues.labeled`
  event 9 seconds after labeling; the Developer agent started, worked ~10
  minutes, then the Claude CLI died on a transient LLM-proxy failure
  (API 504 retries → *"Connection closed mid-response"*, exit 1). The runner
  logged the error to stderr and the session log — **no retry, no DM, no
  visible trace**. The event was already consumed, so nothing ever re-fired.
- **PR #949** (`ready-to-merge` label): the Merger woke correctly, but the PR
  had merge conflicts with `main`. It reported that in its DM room — and
  stopped. Its trigger prompt has no escalation edge: no label that wakes the
  Reworker, so the chain dead-ended *by flow design*, not by malfunction.

The shared pattern: our event pipeline is **at-least-once up to delivery**
(seen-id cursor, durable `pending-triggers.json`, #506 in-flight markers), but
from the moment the Claude run starts it is **fire-and-forget**:

1. **Consumed ≠ done.** The event is spent when the run *starts*, not when it
   *succeeds*. A crashed run silently swallows the wake forever.
2. **No memory of expected next states.** A purely event-driven flow cannot
   notice an *absence* — an agent that crashes, stalls, or forgets to emit its
   outgoing label leaves no signal anywhere.

Both are instances of one missing property: **nothing compares the flow's
intended state ("`ready` implies a PR will appear") against GitHub's actual
state.** This concept closes that gap in three complementary layers.

## 2. Layer 1 — runner retry + loud failure (implemented)

Smallest possible end-to-end guarantee: *a triggered run either happens, or a
human hears about it.* In `_execute_inner`
(`agent-image/scripts/agent-entrypoint.py`):

- A claude invocation that dies with a transient error gets **exactly one
  retry** after `TRIGGER_RETRY_DELAY_SEC` (default 60 s). A user-requested stop
  (`err.user_aborted`) is never retried.
- If the second attempt also fails, the runner posts a plain **failure notice
  DM** (`io.aee.triggerFailure`, mirroring the backstop/orphaned-marker
  patterns): the event is consumed and will not re-fire — re-issue it or hand
  the task over directly.
- Session log gains `trigger.retry` rows and per-attempt `error` rows.

Deliberately **not** done: unbounded retries or re-enqueueing the event. The
first attempt may already have committed partial work; a blind replay risks
duplicate work and self-triggering loops. One retry heals the transient-infra
case (#902's would have); everything beyond that belongs to Layers 2/3.

## 3. Layer 2 — claim labels: make work-in-progress a visible state

### 3.1 Idea

Today "an agent is working on this" exists only inside container session logs.
The claim-label mechanism turns GitHub itself into the state machine: when a
triggered run starts, the runtime **removes the wake label and adds a claim
label** (`ready` → `ready:wip`). The three previously indistinguishable stall
modes now separate cleanly:

| Observation on GitHub | Meaning | Safe reaction |
|---|---|---|
| wake label set (`ready`), no claim label | wake never arrived / run never started | re-trigger (toggle label) |
| claim label set (`ready:wip`), no branch/PR/commit activity | run died after claiming (#902) | retry or escalate |
| completed label set (`ready:completed`) | claimed run finished successfully (#1163) | none — done |
| no wake/claim/completed label, no PR | agent finished without emitting its outgoing label (#949) | Layer-3 diagnosis |

Side benefits: the label transition is the missing **delivery ack**, and a
duplicate wake sees the claim label instead of the wake label and can trivially
`[PASS]` — idempotency for free.

### 3.2 The critical design decision: runtime-executed, never prompt-prose

Today the only label removals in the platform live in generated workflow shell
scripts and in **prompt prose** (e.g. the Reworker template's "Remove the
`revisions-required` label"). A claim transition implemented as prompt prose
just moves "agent forgets the label" one step earlier. Therefore the claim is a
**declarative trigger field, executed mechanically by the runner before the
Claude call**:

```json
{
  "type": "github-event",
  "events": ["issues.labeled"],
  "labelFilter": "ready",
  "claim": { "remove": "ready", "add": "ready:wip" }
}
```

Execution: `_execute_inner` performs the swap via `gh` (the spawn-time PAT is
already in the container) after the preCheck gate and before the invoke. If the
swap itself fails (network), the run proceeds — claiming is best-effort
observability, never a start gate.

### 3.3 Rollback on final failure — event-native self-healing

This is where Layer 1 and Layer 2 interlock: when a run fails **both** attempts,
the runner **rolls the claim back** (remove `ready:wip`, re-add `ready`).
Re-adding the wake label re-emits a fresh `issues.labeled` event through the
poller — **the chain restarts itself with no reconciler involved**. The #902
incident would have healed fully automatically: crash → rollback → new event →
fresh run. The failure-notice DM is still sent, so a repeatedly-crashing run
stays visible; the conversation throttle (5 events/h per issue) is the natural
runaway brake for a crash loop, and the backstop (#611) caps concurrency.

### 3.3.1 Completion on success — the symmetric forward swap (#1163)

Rollback is only half the lifecycle. Without a success counterpart the claim
label is never cleared on a *successful* run either, so a finished ticket keeps
`:wip` forever and is indistinguishable from a run that died mid-work — the
three-state indicator collapses back to two. So on a run that reaches **normal
completion** (result posted, `[PASS]`, or empty-after-harvest — the claim
lifecycle tracks the run, not whether a message was posted) the runner swaps the
claim **forward**: `<wake>:wip` → `<wake>:completed`, the mirror of the failure
rollback. `<wake>:completed` is a fourth derived label, auto-created green when
missing (distinct from the `:wip` amber) and best-effort like every claim edit —
a failed completion swap is logged and never gates the result. A run that failed
both attempts (rolled back) or was **user-aborted** (stays `:wip`) is never
marked completed. Nobody subscribes to `<wake>:completed`, so the re-emitted
`labeled` event starts no chain; the anomaly detector treats it as terminal, not
an active claim, so a finished-but-quiet ticket is never flagged `claim-stalled`.

### 3.4 Naming and derivation

Derive claim names, don't author them: `<wakeLabel>:wip` (`ready:wip`,
`ready-2:wip`) and its success mirror `<wakeLabel>:completed` (#1163). This keeps parallel chains distinct automatically and stays
orthogonal to the team-label-suffix concept (#902's subject). Derived triggers
(`reconcileTeamGithubChannels` / `expandGithubChannels` /
`expandDataFlowSteps`) can generate the `claim` field **by convention** for
every label listener — zero authoring cost for wizard/weaver teams.

### 3.5 Flow-editor integration

The port model already has `emits` (what an agent sets) and `labelFilter` (what
it listens to). The claim is the natural third edge attribute: *what an agent
takes over when it wakes*.

- **Schema**: `claim` on `github-event` triggers; `process-template.js`
  validates shape and that `claim.remove === labelFilter`.
- **Graph/editor**: the listener edge renders a claim badge; `ConnectionsSection`
  gets an "auto-claim" toggle (default on for derived triggers).
- **Lint**: new advisory `unclaimed-listener` — a label listener without a claim
  is a blind spot for reconciliation.
- **Poller effects**: the `labeled` event for `ready:wip` flows through the
  poller; nobody subscribes to it, but the event-transparency log records the
  claim trail for free.

### 3.6 Honest limitation

A claim label makes stalls *visible* and (with rollback) heals the crash case.
It does **not** catch the #949 class — an agent that ran to completion but never
emitted its outgoing label, or a flow with a missing edge. That is Layer 3's
job. The two mechanisms are complementary, not alternatives.

## 4. Layer 3 — the reconciliation loop

### 4.1 Split: deterministic detector, intelligent responder

The expensive mistake would be "an LLM agent reads all open issues every N
minutes and thinks hard". Almost everything is decidable deterministically,
because the flow's intent is **already machine-readable**: `emits`,
`labelFilter`, `channels`, `stage` (and, with Layer 2, `claim`) — the same data
`process-graph.js` renders. So:

- **Detector (pure code, orchestrator-side)**: a module in the spirit of
  `process-graph.js` that derives, per team, the expected state machine
  ("`ready` is consumed by Developer, whose success is observable as a PR
  containing the issue number; `ready-to-merge` is consumed by Merger, whose
  success is observable as `merged`"), then sweeps GitHub state (the poller's
  existing PAT + conditional requests) and flags **anomalies with age**:
  - `wake-not-claimed` — wake label older than *T₁* (e.g. 15 min), no claim.
  - `claim-stalled` — claim older than *T₂* (e.g. 2 h) with no branch/PR/commit
    activity and no running session for that agent (`status.json` / running
    sessions registry).
  - `output-missing` — consumer ran (session log) but its declared outgoing
    label/PR never appeared (the #949 dead-end, and "agent forgot the label").
  - `gate-idle` — a `human:*` gate label pending longer than *T₃* (nudge, never
    auto-approve).
- **Responder (LLM, only on flagged anomalies)**: a per-team reconciler agent —
  or initially the existing Dispatcher, which already self-authored a crude
  30-min reconcile cron on 2026-07-29 — receives the anomaly list and decides
  along a strict reaction ladder.

### 4.2 Reaction ladder (strictly escalating, idempotent)

1. **Observe** — first sighting of an anomaly: record it (memory/log), no action.
2. **Re-trigger** — second sighting: toggle the wake label (remove + re-add)
   *only* for `wake-not-claimed`; for `output-missing` set the flow's own next
   label if the work verifiably exists (e.g. PR is open and green → add
   `ready-for-review`), never fabricate progress.
3. **Escalate** — third sighting or anything ambiguous: DM the team's human
   with the anomaly, evidence links, and a proposed action. Humans resolve
   conflicts of intent; the reconciler never force-merges, never closes, never
   overrides a `human:*` gate.

Budget rules: at most one automated repair per `(object, anomaly-class)` per
day; every repair is a normal GitHub action and thus lands in the
event-transparency log with the reconciler's attribution.

### 4.3 Why this stays cheap and safe

- The sweep is code, not tokens; the LLM sees only exceptions (usually zero).
- Repairs re-use the flow's own wake mechanism (labels), so all existing
  protections apply unchanged: conversation throttle, burst digest, backstop,
  maintenance-mode gating.
- Reconciliation is a **wake, not a start-gate** — consistent with the
  platform's artifact-handoff philosophy (nothing blocks; things get nudged).

## 5. Division of labor

| Failure mode | Caught by | Healed by |
|---|---|---|
| Transient claude/API crash mid-run | Layer 1 retry | automatic (retry) |
| Crash on both attempts | Layer 1 notice + Layer 2 rollback | event-native re-fire; human sees notice |
| Run never started (event lost pre-delivery, container down) | Layer 3 `wake-not-claimed` | label toggle |
| Run claimed, then silently died over hours | Layer 2 visibility + Layer 3 `claim-stalled` | retry/escalate |
| Agent finished but forgot/never had an outgoing edge (#949) | Layer 3 `output-missing` | set next label or escalate |
| Human gate sitting idle | Layer 3 `gate-idle` | nudge DM only |

## 6. Rollout

1. **Phase 1 (now)**: Layer 1 ships with the agent image (`make agent-image` +
   respawn). Unit-tested (`test_agent_entrypoint.py::TriggerClaudeFailureRetry`).
2. **Phase 2**: `claim` field — runner execution + rollback, schema validation,
   auto-derivation in the weaver/reconcile paths, editor badge + lint. Pilot on
   the Agent Studio team's `ready`/`ready-2` chains.
3. **Phase 3 (done — PR #993)**: `flow-anomaly-detector.js` (pure, golden-fixture tested) + `flow-anomaly-sweep.js` (GitHub/session-log → detector objects, I/O-free core) + `GET /internal/teams/:teamId/flow-anomalies` (best-effort gather, skipped in maintenance mode); observe-only **Anomalies** toolbar panel in the Flows view (`FlowAnomaliesPanel.jsx`) with count badge on affected canvas nodes + Refresh. No auto-repair. Per-team threshold overrides via `anomalyThresholds` on the team-agent config (defaults: T₁ = 15 min, T₂ = 2 h, T₃ = 24 h).
4. **Phase 4**: responder agent with the reaction ladder; replace the
   Dispatcher's hand-rolled reconcile cron.

Open questions: thresholds *T₁–T₃* per stage vs. global; whether `claim`
rollback should also fire for `once`/`cron` triggers (probably not — no wake
label to restore); whether `output-missing` detection needs the artifact
manifest (`.agent-studio/artifacts.jsonl`) for data-flow edges, not just labels.
