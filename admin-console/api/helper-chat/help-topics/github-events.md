---
id: github-events
routes: ["/github-events"]
title: GitHub Event Log
summary: A read-only timeline of every GitHub event the platform saw and what happened to it — Processed events is the history, Pending queue is the backlog still waiting to be delivered.
seeAlso:
  - { label: "Flows", to: "/flows" }
  - { label: "Agent Chat", to: "/chats" }
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

## What the GitHub Event Log is

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
Processed events. A *long* Pending queue is the interesting case — see the last
chapter.

### How long it is kept, and how complete it is

The history is written to daily files and kept for **7 days**, then deleted —
this is an operational log, not an audit trail. (Config mutations are audited
separately.) The time-range selector filters within that window, and a single
read is capped, so a very busy repository can hit the cap before it hits the
7-day edge.

Writing the log is **best-effort**: it must never break delivery, so an event
can in principle be delivered without a row appearing here. If a wake clearly
happened but no row explains it, that is the explanation of last resort — check
the agent's own session first.

### Who can see it

The page is **not team-scoped** — every signed-in user sees the events of every
polled repository and every agent, and any signed-in user can cancel any
agent's queued entry (the cancellation itself is recorded in the audit trail).
Treat repository and agent names here as visible to all console users.

## Processed events

The **Processed events** tab is the history: one row per event that survived
duplicate-detection, newest first, within the time range you select. Refresh
re-reads it; nothing on this tab is editable.

Each row reads left to right as *when · where · what · who · what happened*:

| Column | What it holds |
|---|---|
| **Time** | When the platform saw the event, as a relative phrase — the exact local time is on hover. |
| **Repository** | The short repository name; the full `owner/name` is on hover. |
| **Type** | Whether the work item is a **PR** or an **Issue**, taken from the stored work item rather than guessed from the event name. A `—` means the event has no work item (a push, a branch create or delete) or predates this column. |
| **Work item** | The `#number` of the PR or issue, linking to GitHub. A pull request that resolves issues also shows a linked `→ closes #<issue>`, so you can walk issue → PR → merge without leaving the page. |
| **Title** | The title of that PR or issue. |
| **Event** | The event in plain language rather than the raw API key. A push / create / delete row appends the branch or tag it touched; a row nobody was listening to appends the event's own label. |
| **Actor** | The GitHub account that caused the event. |
| **Outcomes** | One chip per subscriber whose event-type filter matched — the next chapter is entirely about these. |

Older rows are never backfilled. A column that was added after a row was
written simply shows `—` for it, rather than a value invented after the fact.

### Where the events come from

There is no webhook into this stack, so the orchestrator **polls** the GitHub
Events API every ~30 s for every repository that appears in a Working
Environment carrying a **GitHub token**.

Two consequences that surprise people:

- **The Events API is lossy by design.** It does not emit every action — most
  notably there is no `pull_request.synchronize`, so "a new commit was pushed to
  the PR" is not an event you can subscribe to.
- **An event is fresh if its id has not been seen before**, not if it is recent.
  The poller keeps a per-repository set of **seen ids**, so a re-polled page
  costs nothing and nothing is delivered twice. The very first poll after a
  restart only establishes that baseline — it delivers nothing.

### The poller is not the only writer

Three other things write rows here, which is why this stays one honest timeline of
every wake rather than a log of one delivery mechanism:

- **Internal-channel hand-offs.** A hand-off on an internal channel
  (`transport: 'internal'`) is woken directly by the producer's `aee-emit`
  instead of travelling through the Events API, and is recorded here too.
- **Labels applied in the console.** A label a human applies through the GitHub
  Issues plugin is delivered immediately on that fast path, and the poller's
  later sighting of the same `*.labeled` event is dropped as a duplicate.
- **Direct agent-to-agent hand-offs.** A `wakeAgent` hand-off wakes a teammate
  straight through the platform — no issue, PR or label — so this log is its
  *only* record. Such a row has no repository or work item and honestly shows
  `—` there; it reads **direct hand-off** in the Event column, with the sender's
  note in the Title column.

Each row carries a `source` marking which writer produced it, but **the table
never renders it** — so a poller row and an internal-fast-path row that arrived by
different routes look identical here. A direct hand-off is the one you can pick
out, because its Event cell reads *direct hand-off*. The
`dropped (internal-dedup)` chip described in the next chapter is the only visible
trace of the fast path.

## Outcomes

One row per event; one chip per subscriber whose event-type filter matched. The
same explanations are on the page as chip tooltips and in the collapsible
legend — this is the longer version.

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

### Reading a "my agent never woke up" case

Work down the row, in this order:

1. **Is the event in the list at all?** No → most likely the repository is never
   polled (see the next section), or the Events API simply never emitted that
   action.
2. **Does the row say *nobody's listening*?** → no trigger subscribes to that
   event type. A wiring problem, not a delivery problem.
3. **Is there a chip for the agent you expected?** No chip means the agent's
   trigger did not even match the event *type*.
4. **Is the chip a drop?** The reason names the layer that stopped it —
   horizon, label filter, or throttle.
5. **Delivered but nothing happened?** Delivery is not execution. Open the
   session from the chip and read it there.
6. **Delivered, but the agent has not started yet?** Look in the Pending queue —
   the entry may still be waiting for the agent.

### When a repository is polled, and when it is not

A repository is polled only if **both** are true:

- some Working Environment carries a **GitHub token** for it, and
- at least one **enabled** agent has an **enabled** `github-event` trigger on it.

A repository nobody subscribes to, or one whose only subscriber is a disabled
agent, produces **no rows at all** — not even *nobody's listening*, which is
reported only for a repository that *is* polled. Silence on this page is
therefore ambiguous on its own: it can mean "nothing happened" or "we were never
looking". Check the environment's token and the trigger's enabled state before
concluding the event was lost.

## Pending queue

Between "accepted for an agent" and "the agent actually runs" the entry sits in
that agent's dispatch queue, which drains **every few seconds**. The **Pending
queue** tab is that backlog, grouped per agent. So an empty queue is the normal
state, and a backlog means something is holding delivery:

- **Maintenance Mode** — queued events keep arriving but are deliberately not
  drained until the window ends. Nothing is lost.
- **The agent is busy** — an agent has one workspace and runs one thing at a
  time, so work queues behind a long session.
- **A loop is running** — a loop trigger holds the agent's workspace across all
  its iterations, and the drain pauses until the whole loop ends, not between
  iterations.
- **The agent is disabled or not running** — nothing is draining its queue.
  Entries have **no expiry**: they wait indefinitely and drain in order whenever
  the agent comes back. (Nothing new accrues while it is disabled, because the
  poller skips disabled agents.)

The queue holds more than GitHub events: a folded **GitHub digest**, a
**throttle warning** (the heads-up DM sent the first time a cap is hit), a
**Briefing-pack event**, and queued session operations all appear with their own
kind badge, explained on hover.

Each row's **kebab menu** (⋮) holds the two things you can do to a waiting
entry. They are the only actions on this page that change anything.

**Cancel** removes a single entry before it is delivered. Use it to stop a wake
you know is wrong (a mis-labelled issue, a burst queued during maintenance)
instead of letting the agent burn a session on it. An entry that drained between
your reading the page and clicking Cancel is reported as already gone, not as an
error.

### Reassign to… — handing a waiting entry to another agent

**Reassign to…** gives the entry to a *different* agent instead of throwing it
away. The case it exists for: a team has two code reviewers, a review is queued
for the first one, and that one is busy, wedged or simply the wrong choice. Say
*let the other reviewer take this*, from here, without going back to GitHub.

Two constraints make it work rather than merely appear to.

**Same team only.** The target must be an agent on the same Agent Team as the
current holder. The runtime-less team agent itself and disabled agents are not
offered. This is the same integrity rule a direct agent-to-agent hand-off obeys.

**Only agents that would actually accept the event.** The picker is not a free
dropdown — it lists only agents that have an **enabled trigger which would
accept this exact event**, judged by the same repository, event type, label
filter and subscription-window rules the poller itself applies. This matters
because a queued entry carries the id of a trigger on the *original* agent, and
trigger ids never collide across agents: an entry copied to an agent that cannot
re-resolve it would move in the UI, update the counts, and then be silently
dropped at the far end. So the entry is re-stamped with the **target's own**
trigger, and a target that has none is refused.

**When no eligible target exists** the picker says so and offers nothing, with
an expandable list of each sibling and why it cannot take it — the wrong label,
a different repository, a different event type, or a subscription window that
starts after the event. That is an answer about how the flow is wired, not an
error: reassigning anywhere else would look successful and do nothing. Fix the
target's trigger, or cancel the entry and re-apply the label on GitHub.

**What can go wrong, and what you will be told.** The entry is removed from the
source agent **first**, and that removal is the claim:

- If the source agent fired the entry while you were choosing, nothing is moved
  and you are told the original agent has it. This ordering is deliberate — the
  alternative risks *both* agents running the same work item, which is worse and
  harder to notice.
- In the rare case where the removal succeeds but the target's queue cannot be
  written, the event is in no queue at all. This is reported as a hard error
  naming the repository, the issue or PR and the label, so you can re-apply that
  label on GitHub to run it again; a copy is also saved server-side for
  recovery. It is never reported as a success.

**Which entries can be reassigned.** Queued **GitHub events** only. Every other
kind still shows the menu entry, greyed out with the reason — a digest is a
collapsed batch, a direct hand-off was aimed at its target deliberately, session
operations are tied to a room, and a queued plain trigger carries no event to
match a target's trigger against.

Reassigning is recorded in **Processed events**: alongside the original
`delivered → <first agent>` row you will see a `reassigned → <second agent>` row
for the same event, with who moved it. So the trail never claims the first agent
was served when another one did the work.

Reassigning requires **Team Admin** rights over *both* agents — the one losing
the entry and the one gaining it. Injecting work into an agent's queue starts an
autonomous run, so it is held to the same bar as firing a trigger by hand.

*Known gap:* the queue protects against Maintenance Mode, not against downtime.
An event that arrives while the stack is genuinely down is not re-delivered.
That is why `github-event` triggers are preferred over `http` triggers for
anything that must not be missed.
