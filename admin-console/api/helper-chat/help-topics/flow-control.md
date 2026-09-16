---
id: flow-control
routes: ["/flow-control"]
title: Flow Control
summary: A board showing where every ticket of one Agent Team actually is — its lifecycle stage, the agent that owns it, how long it has been stuck and what is blocking it — derived from GitHub evidence rather than from the labels the flow set.
seeAlso:
  - { label: "Flows", to: "/flows" }
  - { label: "GitHub Event Log", to: "/github-events" }
askPrompts:
  - "Why does this ticket say In review when the labels say it is done?"
  - "What does the conflict blocker mean and who fixes it?"
  - "Why is a ticket sitting in Ready and nothing is happening?"
  - "What is the difference between a stage and a blocker?"
  - "Why is a lane empty when I know there is work in it?"
  - "How often is this board refreshed?"
  - "Can I fix something from this page?"
  - "What does Force dispatch do?"
  - "What is the difference between Pause and Drain?"
---

## What the Flow Control board shows

One **Agent Team**, one board. Each card is a work item — a GitHub issue, or a
pull request with no issue behind it — and each column is a **lifecycle stage**.
Pick the team from the selector; **Refresh** re-runs the sweep.

The board reads the **ticket ledger** (`GET /api/teams/<id>/tickets`), which
derives each item's state from what GitHub actually shows: is the PR open, does
it merge, did the checks pass, was a review submitted, is the issue closed.

**That is the whole point, and it is worth being blunt about it.** The stall this
subsystem exists to prevent was invisible precisely *because* the labels said
"done" while GitHub said "open and conflicting". So wherever a label and a
GitHub fact disagree, the fact wins — and the disagreement is itself reported as
the `Claimed done` blocker. A card on this board can never show `Done` because
somebody set a `:completed` label; it shows `Done` when the PR merged or the
issue closed.

Two consequences follow:

- A ticket whose flow **lied** appears in its real stage with a blocker, not in
  the last stage its labels claimed.
- Nothing here is authored. Stage names, lane membership and ownership are
  derived from the team's own flow graph, so a team with a completely different
  label vocabulary gets the same nine stages.

**The ticket ledger itself is read-only.** There is no repair button on the
board: a card's stage and blocker are derived from GitHub evidence, never set
by a click. Acting on a ticket's own state is a person's job today — follow
the deep links to the issue or the PR.

There is one thing on this page that *does* act: the **Pool controls** panel
below the board (pause/drain a pooled role, force-dispatch a held ticket). It
changes who is admitted to run, never a ticket's own derived stage.

### When the board is empty, or missing something

- **Maintenance mode** pauses the sweep; the board says so rather than showing a
  stale picture.
- A team whose environment binds **no GitHub repository** has nothing to
  reconcile, and the board says that too.
- A **partial sweep** (one repository unreadable, an API error) is reported as a
  banner and the remaining tickets are still shown — a degraded board, never a
  blank one.
- An empty **column** is not a fault. The board keeps every stage visible,
  because where work is *not* is as informative as where it is.

## The lifecycle stages

Nine stages, in flow order. They are positions in the team's own graph, not
label names:

| Stage | What it means |
|---|---|
| **Backlog** | No flow label yet — nothing has picked this up. |
| **Refining** | Parked on a human gate before dispatch. |
| **Ready** | Dispatched on an entry label, not claimed yet. |
| **In dev** | Claimed by the producing agent; no review under way. |
| **In review** | A PR exists and a reviewing stage is active. |
| **Rework** | Changes were requested — back with the author. |
| **Doc** | One hop before the terminal stage. |
| **Mergeable** | The deepest active stage reaches a terminal consumer, or the PR is approved and green. |
| **Done** | The PR merged, or the issue is closed. |

"Entry lane", "terminal" and "one hop before" are read off the graph: an entry
label is a wake label no consumer emits, a terminal consumer is one that emits
nothing and opens no PR. Nothing in the board matches on a literal label token.

The small age on each card is **time in the current stage**, not the ticket's
total age — a week-old ticket that moved an hour ago reads as an hour.

## Blockers and what to do about them

A blocker is **orthogonal to the stage**: a ticket can be `In review` *and*
conflicting, or `Mergeable` *and* waiting for somebody to press merge. Only the
most actionable one is shown as a badge; hover it for the specific detail.

| Blocker | What it means | Who clears it |
|---|---|---|
| **Superseded** | Every file this PR adds is already in the base branch — it looks like a duplicate. | A person: closing work is never automatic. |
| **Claimed done** | The completing stage set none of its declared outgoing labels while its PR is still open. | Re-dispatch the stage that lied. |
| **Conflict** | The PR conflicts with its base branch. | A person: a merge resolution is a judgement call. |
| **Stale base** | It text-merges, but fails against the current base. | A rebase and re-run — mechanical. |
| **CI red** | Required checks are failing. | Re-dispatch the author. |
| **Approved, not merged** | Approved and green, still sitting open. | Nudge whoever merges. |
| **Orphaned** | The active label has no listener at all — the flow graph itself is wrong. | A person: fix the wiring on the Flows page. |
| **Unclaimed** | The wake was never claimed; it may have been lost. | Re-deliver the wake. |
| **Stalled** | No activity past the threshold — the run likely died. | Re-dispatch. |
| **Needs a human** | Parked on a human gate. | You. |

A person icon marks the rows whose resolution is a judgement call rather than a
re-run. Ordering inside a column is most-actionable first: blocked before
healthy, then by how serious the blocker is, then by how long it has been stuck.

Two deliberate refusals are worth knowing, because they look like missing
findings: `Superseded` **declines** when GitHub returned an incomplete file
index for the base branch, and a PR whose mergeability GitHub is still computing
is reported as unknown rather than guessed. A false accusation of duplicated
work costs more than a missed one.

## The epic roll-up

Above the board, one line per epic — `Epic #2112: 3 done · 1 blocked · 2 in
progress · 4 waiting`. The epic is parsed from each ticket's own body, so a
ticket that names no epic is counted in no roll-up.

The four buckets are mutually exclusive and cover every ticket in the epic, so
they always add up to its total:

- **done** — the stage is `Done`.
- **blocked** — anything with a blocker that is not already done. A blocker
  recorded against merged work is history, not a call to action, so `Done` wins.
- **in progress** — `In dev`, `In review`, `Rework`, `Doc` or `Mergeable`.
- **waiting** — `Backlog`, `Refining` or `Ready`: nothing is working on it.

Epics are listed most-blocked first, so the one needing attention is leftmost.

## Pool controls

Below the board, two panels appear for a team with at least one **pooled**
role (`pool.enabled` — a role that auto-scales one ephemeral instance per
ticket instead of working one at a time).

**Pooled roles.** One row per pooled role: how many instances are running now
(and, if the role has a `maxInstances` cap, how many it's allowed), and its
current state.

- **Pause** — stop starting new instances for this role. Anything already
  running keeps running to completion; nothing new starts until you Resume.
- **Drain** — the same effect as Pause (nothing new starts), used when the
  intent is to wind the role down rather than pick it back up shortly — for
  example before disabling pooling on it entirely. There is no functional
  difference between the two today; pick whichever name matches your intent.
- **Resume** — clears Pause/Drain; the role goes back to starting new
  instances normally.

Pausing or draining a role affects **new** dispatch only: a ticket already
being worked keeps its instance, and a redelivered event for that same ticket
still finds it. Both the label-triggered path and the autonomous Flow
Supervisor honor the pause — neither starts a new instance for a paused role.
A brand-new ticket that would have triggered a paused role isn't dropped
either: it's held and automatically dispatched the moment you Resume the
role.

**Held on the WIP limit.** One row per dispatch currently on hold because the
team's `wipLimit` (the cap on how many tickets flow at once) is already full.
Each row shows which ticket and which agent is waiting. **Force dispatch**
starts it right now anyway, past the limit — a deliberate, one-off override
for when you know it's safe to run one more than usual. It does not change
the limit itself: the next ticket to finish still frees a slot exactly as it
would have.

## Pool instance lanes

Below Pool controls, one lane per pooled role's live and held work — the
read-only counterpart to the buttons above. Nothing here can be clicked;
it exists so you can *see* what the pool is doing, not just change it.

Each lane is tagged one of three ways:

- **Running** — a real instance is working this ticket right now.
- **Held** — no instance has started yet, because another instance of the
  same role is already working a ticket from the **same epic**. Every pooled
  role always serializes same-epic work (it is never disabled), so this is
  the one contention reason worth naming on its own; the lane names which
  running ticket it is waiting behind.
- **Timed out** — an instance ran past the role's configured hard-timeout
  budget and is being torn down.

A ticket held on the team's `wipLimit` instead of on same-epic contention is
not repeated here — the **Held on the WIP limit** panel above already shows
it, and a ticket can only be in one of these two waiting states at a time.
This panel has no Refresh of its own; it reloads with the rest of the board.
