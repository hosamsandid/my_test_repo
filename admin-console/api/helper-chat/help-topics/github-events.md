---
id: github-events
routes: ["/github-events"]
title: GitHub Event Log
summary: A read-only timeline of every GitHub event the platform saw and what happened to it — Processed events is the history, Pending queue is the backlog still waiting to be delivered.
seeAlso:
  - { label: "Flows", to: "/flows" }
  - { label: "Agents", to: "/agents" }
  - { label: "Working Environments", to: "/environments" }
  - { label: "Maintenance Mode", to: "/maintenance-mode" }
askPrompts:
  - "What is the difference between Processed events and the Pending queue?"
  - "What do delivered, digested and dropped mean?"
  - "My agent did not wake up on a label — how do I find out why?"
  - "Why does an event say nobody's listening?"
  - "Why is the Pending queue not draining?"
  - "How far back does this log go?"
---

## What this page shows

This page is **purely observational**: it records what the platform saw on
GitHub and what it decided to do with each event. Nothing here changes
behaviour — you cannot re-deliver, retry or re-route an event from this page.
The one exception is cancelling an entry that has not been delivered yet
(see *Pending queue* below).

It answers one question that is otherwise invisible: **why did (or didn't) an
agent wake up?**

| Tab | What it is | Direction in time |
|---|---|---|
| **Processed events** | The **history**. Every event already handled, with one outcome per subscriber. Read-only. | Past |
| **Pending queue** | The **actionable backlog**. Entries accepted for an agent but not yet delivered. Cancellable. | Future |

An event normally appears in the Pending queue for a few seconds and then in
Processed events. A *long* Pending queue is the interesting case — see below.

## Where the events come from

There is no webhook into this stack, so the orchestrator **polls** the GitHub
Events API every ~30 s for every repository that appears in a Working
Environment carrying a **GitHub token**. A repository with no token anywhere is
never polled — its events simply never arrive, and nothing on this page will
say so.

Two consequences that surprise people:

- **The Events API is lossy by design.** It does not emit every action — most
  notably there is no `pull_request.synchronize`, so "a new commit was pushed to
  the PR" is not an event you can subscribe to.
- **An event is fresh if its id has not been seen before**, not if it is recent.
  The poller keeps a per-repository set of seen ids, so a re-polled page costs
  nothing and nothing is delivered twice. The very first poll after a restart
  only establishes that baseline — it delivers nothing.

The poller is not the only writer. Hand-offs on **internal channels**
(`transport: 'internal'`, woken directly by a producer's `aee-emit` instead of
via GitHub) and labels applied by a human through the **GitHub Issues plugin**
are recorded here too, so this stays one honest timeline of every wake — even
the ones that never travelled through the Events API. A label applied in the
console is delivered immediately and the poller's later sighting of the same
`*.labeled` event is dropped as a duplicate.

## The outcomes

One row per event; one chip per subscriber whose event-type filter matched. The
same explanations are on the page as chip tooltips and a collapsible legend —
this is the longer version.

| Outcome | What happened | Should you worry? |
|---|---|---|
| **delivered → agent** | The event matched a trigger and a session ran. Click the chip to open that session. | No. |
| **digested → agent** | Part of a burst (more than 3 events on the same PR / issue / branch in one poll) folded into **one** summary wake. **Lossless** — the agent still receives every event inside the digest. | No. One session instead of many is the point. |
| **dropped (throttle)** | The per-conversation rate cap was hit — by default 5 events per hour per agent per PR / issue / branch. | Usually healthy loop-protection: an agent's own commits and comments re-trigger it. Worry only if a genuinely new event failed to wake someone. |
| **dropped (horizon)** | The event is older than that subscriber's subscription window (its activation time plus a short grace). | Expected right after wiring or reactivating a trigger. A new agent deliberately does not react to history that predates it. |
| **dropped (label-filter)** | The event carried a label this trigger does not subscribe to. | No — that is label routing working. |
| **dropped (internal-dedup)** | The wake was already delivered on the internal fast path; this is GitHub telling us about the same label a second time. | No. |
| **nobody's listening** | No trigger subscribed to this event **type** at all. | Maybe. If something should have reacted, the wiring is missing — add or fix the `github-event` trigger on the target agent. |

A `delivered` or `digested` chip may carry the **wake label** in brackets: the
label that actually satisfied the subscriber's filter. No bracket means the
listener takes any label.

*One caveat about digests as currently recorded:* the fold itself is real and
lossless, but a folded event is written to the log as **`delivered`** with a
separate digest marker rather than as a `digest` status — so today a digested
burst reads as a run of ordinary `delivered` chips, and following one of those
chips to "the session it started" can land on nothing, because a digest posts a
single plain message instead of starting one session per event. If a burst looks
like several deliveries but you only find one summary message, that is what you
are looking at.

**There is no source filtering.** Every agent shares one GitHub token, so an
event caused by an agent looks exactly like an event caused by a human, and a
trigger fires on either. The identity stamps `gh-as-agent` writes are for
humans reading GitHub, not for delivery decisions — the only thing standing
between two agents and an infinite ping-pong is the throttle above.

## Reading a "my agent never woke up" case

Work down the row, in this order:

1. **Is the event in the list at all?** No → most likely the repository is never
   polled. A repository is polled only if some Working Environment carries a
   **GitHub token** for it *and* at least one enabled agent has an enabled
   `github-event` trigger on it. A repository nobody subscribes to, or one whose
   only subscriber is a **disabled** agent, produces no rows at all — not even
   *nobody's listening*. The other possibility is that the Events API simply
   never emitted that action.
2. **Does the row say *nobody's listening*?** → no trigger subscribes to that
   event type. A wiring problem, not a delivery problem.
3. **Is there a chip for the agent you expected?** No chip means the agent's
   trigger did not even match the event *type*.
4. **Is the chip a drop?** The reason names the layer that stopped it —
   horizon, label filter, or throttle.
5. **Delivered but nothing happened?** Delivery is not execution. Open the
   session from the chip and read it there.

## Pending queue

Between "accepted for an agent" and "the agent actually runs" the entry sits in
that agent's dispatch queue, which drains **every few seconds**. So an empty
Pending queue is the normal state, and a backlog means something is holding
delivery:

- **Maintenance Mode** — queued events keep arriving but are deliberately not
  drained until the window ends. Nothing is lost.
- **The agent is busy** — an agent has one workspace and runs one thing at a
  time, so work queues behind a long session or a running loop.
- **A loop is running** — a loop trigger holds the agent's workspace across all
  its iterations, and the drain pauses until the loop ends.
- **The agent is disabled or not running** — nothing is draining its queue.
  Entries have **no expiry**: they wait indefinitely and drain in order whenever
  the agent comes back. (Nothing new accrues while it is disabled, because the
  poller skips disabled agents.)

The queue holds more than GitHub events: a folded **GitHub digest**, a
**throttle warning** (the heads-up DM sent the first time a cap is hit), a
**Briefing-pack event**, and queued session operations all appear with their own
kind badge.

**Cancel** removes a single entry before it is delivered — the one action on
this page that changes anything. Use it to stop a wake you know is wrong (a
mis-labelled issue, a burst queued during maintenance) instead of letting the
agent burn a session on it. An entry that drained between your reading the page
and clicking Cancel is reported as already gone, not as an error.

*Known gap:* the queue protects against Maintenance Mode, not against downtime.
An event that arrives while the stack is genuinely down is not re-delivered.
That is why `github-event` triggers are preferred over `http` triggers for
anything that must not be missed.

## Retention and scope

The history is written to daily files and kept for **7 days**, then deleted —
this is an operational log, not an audit trail. (Config mutations are audited
separately.) The time-range selector filters within that window, and a single
read is capped, so a very busy repository can hit the cap before it hits the
7-day edge.

Writing the log is **best-effort**: it must never break delivery, so an event
can in principle be delivered without a row appearing here.

The page is **not team-scoped** — every signed-in user sees the events of every
polled repository and every agent, and any signed-in user can cancel any agent's
queued entry (the cancellation itself is recorded in the audit trail). Treat
repository and agent names here as visible to all console users.
