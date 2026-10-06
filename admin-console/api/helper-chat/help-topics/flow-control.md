---
id: flow-control
routes: ["/flow-control"]
title: Flow Control
summary: A live view of one Agent Team — which agent is working on what right now, where a person has to step in, and how far each work item has come through the team's own flow.
seeAlso:
  - { label: "Flows", to: "/flows" }
  - { label: "GitHub Event Log", to: "/github-events" }
askPrompts:
  - "Why is an issue I know about not on the board?"
  - "Where do the columns come from?"
  - "What is the difference between Pause and Drain?"
  - "Why does a row say no agent is scheduled to continue?"
  - "How long do finished items stay on the board?"
  - "Can I rename or merge the stages?"
  - "What does Force dispatch do?"
  - "What does Draft mean, and how do I remove an item from the board?"
  - "Why is a pool instance still running after it opened its pull request?"
  - "Why does a row say wake never delivered?"
---

## What the Flow Control board shows

One **Agent Team**, one board, these areas from top to bottom:

1. **Working now** — every agent run in progress, and how busy each pooled
   role is.
2. **Needs you** — work items that are stuck until a person acts. This area is
   hidden when nothing needs you.
3. **In progress** — one row per work item, with the stage it is in and how
   long it has been there.
4. **Recently completed** — closed issues and merged pull requests, in the
   same table layout. This area is hidden when nothing finished recently.

**Only work the team took part in appears.** An issue or pull request is on
the board once a team agent was woken on it, created it or pushed to it — or,
for an issue, once a person released it to the team (whichever comes first).
The untouched backlog, Dependabot pull requests and other people's PRs are not
shown. When no work item is active, the **In progress** area says
**Nothing in progress**.

**Which team opens.** The board opens on the team you last worked with: the
team of the agent (or the team entry) you last selected in **Agent Chat**, or
the team you last picked here — whichever you did most recently. Picking a
standalone agent in Agent Chat does not change it. A link with
`?team=<team id>` opens that team instead. If the remembered team is gone or
not visible to you, the board opens on the first team in the list. The choice
is remembered for you on this browser.

**Refreshing.** The board refreshes itself every 30 seconds while
**Auto-refresh** is on (your choice is remembered for you on this browser).
The header shows when it was last updated; **Refresh** fetches a new snapshot
right away. GitHub is asked at most once per load and viewers share the
result, so the board stays fast.

### When the board is empty, stale or missing something

- **Maintenance mode** pauses the board; it says so rather than showing a
  stale picture.
- A team whose environment binds **no GitHub repository** has nothing to show,
  and the board says that too.
- **GitHub unreachable**: the board keeps the last state it knew, shows when
  that was, and warns you that it is not current.
- A **finished** item moves to **Recently completed** and stays there for 24
  hours (a team can change that — see *Changing the columns*), then drops off.
  The note under the heading shows the team's current setting.

### Waiting for CI

A pull request whose hand-off has a **readiness gate** (see the Flows help,
*Holding a PR hand-off until CI is green*) shows **⏳ waiting for CI**,
**waiting for conflict-free** or **waiting for CI / conflict-free** under its
stage while the gate holds the wake. Hover it to see how long it has been held. The next agent has not
been woken yet; nothing is stuck unless the hold runs into its timeout, which
removes the hand-off label and sets `needs-human`. The GitHub Event Log shows
how each hold ended.

## Who is working right now

Each line is a run in progress: the **role**, the **instance** number for a
pooled role, the **issue or pull request** it works on, and **how long it has
been running**. Agents that are idle are not listed. A run whose item has just
closed keeps its line until it ends, but never adds a row to the board.
Click a line to open that agent's chat — for a pooled role, the chat of that
exact instance.

A **pooled** role (one that starts a separate instance per work item) shows
how busy it is — for example **2 of 3 busy** — and its controls. Instances that
have finished their run but are kept alive because their pull request is still
open are added as **· n waiting on a PR** (see *Instances waiting on a pull
request* below); they do not count toward the limit. Each running instance of a
pooled role is listed **indented directly beneath** that role's line, so you can
see at a glance which pool is doing what. Runs of roles that are not pooled
keep their own line above the pooled roles.

## Pause, Drain and Switch on

The buttons on a pooled role change whether it takes **new** work. They never
stop a run that is already going.

- **Pause** — Pause: running instances finish their current work. New work waits in a queue and starts when you click Resume.
- **Drain** — Drain: running instances finish their current work, new work waits, and the role switches itself Off once the last one is done — including any instance still waiting on an open pull request. Click Switch on to start it again.
- **Resume** — Resume: start taking new work again. Anything that waited while paused starts now.
- **Switch on** — Switch on: start taking new work again. Anything that waited while the role was off starts now.

Use **Pause** for a short stop you will undo yourself. Use **Drain** to wind a
role down: while it drains the line reads **Draining, n still running**; when
the last run finishes it reads **Off**. Nothing is lost either way — work that
arrives meanwhile waits and is counted as *waiting*.

A drain is only finished once no instance is left waiting on an open pull
request either: review feedback on such a PR is still handed to its instance
while the role drains, and the role switches Off when the last PR is merged or
closed. To finish sooner, delete the waiting instances by hand. A role that is
**Off** gives no new work to a waiting instance.

### Instances waiting on a pull request

When a pooled instance finishes its run and its work item has an open pull
request — a PR that closes the issue, or the PR itself — the instance is not
torn down. It **waits for the PR**, so review feedback goes back to the same
instance, which continues its session with its workspace intact instead of a
fresh instance starting from nothing.

- A waiting instance is shown as **Waiting for PR #N** in the Agent Chat list
  and counted apart: the role's count reads e.g. **2 / 3 active · 4 waiting**.
- Waiting instances do **not** count toward **Max parallel instances** — new
  work still gets new instances. When feedback arrives the instance works again
  and counts as active; only such returning work can push a role above its cap.
- Neither the **idle timeout** nor the **hard timeout** removes a waiting
  instance, and time spent waiting does not count toward the hard timeout.
- Once no linked PR is open any more (merged or closed), the instance stops
  waiting and is removed on the next check, about a minute later.
- If GitHub cannot be reached, the instance keeps waiting until the next
  successful check.
- **Cost:** a waiting instance keeps its container running for as long as the
  PR stays open. Merge or close pull requests you are done with, or delete the
  instance by hand.

**Force dispatch** appears for work held because the team's limit on work in
progress is full. It starts that one item now, past the limit, without
changing the limit.

## Where you are needed

A row lands here when no agent will move it forward on its own. The reason is
spelled out, together with how long it has been waiting:

| Reason | What to do |
|---|---|
| **flagged for a human** | An agent asked for help — read its last comment. |
| **conflict with base** | Resolve the merge conflict, or wake the team's conflict role. |
| **waiting for approval** | The flow hands this to a person — review and approve. |
| **approved — waiting for merge** | Merge it. |
| **checks failing** | Look at the failing checks. |
| **no agent is scheduled to continue** | The last agent finished and nothing picks it up — check the flow on the Flows page. |
| **stuck — no progress, needs help** | The row has read *working* for more than an hour, but only because of a claim label (e.g. `ready:wip`) — no agent run or pool instance is alive for it, so the run that claimed it died or was stopped. Team Admins see a **Release claim** button: after you confirm, it swaps the stale `…:wip` label back to the wake label (e.g. `ready`) on GitHub — if the wake label is still there too, it is removed and added again so the step is noticed — the step runs again on the next poll, and the release is recorded in the GitHub Event Log. The board never does this on its own. You can also swap the label by hand. |
| **nobody picks it up — its agent is switched off** | The item carries a wake label (or its claim), but every agent listening for it is switched off — the agent, or its trigger on that label. Releasing would wake nobody. Switch the agent back on, or route the label elsewhere; the Flows page shows the same as a lint. |
| **wake never delivered** | The item carries a wake label (e.g. `ready-for-review`) and reads *up next*, but for more than 30 minutes no agent has been running, queued or held for it — the wake never reached its agent. The line names each label and why, from the GitHub Event Log: **older than its agent's trigger** (`history-horizon` — the label was added before the agent's trigger existed, typically after the flow was re-applied or the team moved to another instance), **re-add dropped as already armed** (`wake-already-armed`), **never reported by the GitHub Events API** (no event for it reached the log), or **dropped (…)** with the poller's reason. Click the reason to open that event in the GitHub Event Log. The board only reports it. For **re-add dropped as already armed** (and the throttle drops), **Fire again** in the agent's trigger activity in Agent Chat delivers it again. For the other causes, remove the wake label and add it again. |

## The stages

The columns come from the team's own flow on the **Flows** page: **Draft**,
then one stage per role in hand-off order, then **Done**. A team with a
different flow gets different stages; nothing depends on label names. A role
that appears on several paths is shown once, at its first position, and pooled
instances count as their role.

An issue and the pull requests its agents opened form **one row** — no
"Closes #…" needed. With several PRs for one issue, the row follows the most
advanced open one. A pull request an agent opened without an issue gets its
own row.

### Issue and Pull request columns

The **In progress** and **Recently completed** tables start with two columns,
**Issue** and **Pull request**, so you can see at a glance how far an item has
got. The Issue column shows the item's issue number; the Pull request column
lists every pull request of the row, one per line, in the order the board
knows them — *(merged)* marks a merged one, a closed one is struck through. On
a board that spans several repositories both show the full `owner/repo#N`.
Each number links to GitHub; the **Work item** column shows only the title.

An empty cell says something too:

- A muted **—** under **Pull request** (*No pull request yet*): the work is
  still at issue level.
- A highlighted **—** under **Issue** (*No linked issue*): an agent opened the
  pull request without an issue.

Each row shows its **current stage**, whether an agent is **working** on it or
it is **up next**, and the **time in that stage** — not the item's total age.
For a finished item it shows the **time since completion** (hover it for the
exact date and time).

On a row an agent is **working** on, the stage cell links to the chat of the
agent running it — for a pooled role, the item's own instance (e.g.
*Developer #2716*). A row that is working only by a claim label, with no run
going, has no link.

**Draft** holds items a team agent created or took part in that no person has
released yet and no agent is working on or queued for — for example a concept
ticket. They read **awaiting release**: a person has to review the item and
release it (add the label the first role wakes on, e.g. `ready`). A released
item never sits in Draft — it shows at the role it wakes, as **up next**.

Rows read like the pipeline, **top to bottom**: **Draft** first, then each
stage in hand-off order. Within a stage the item that entered it most recently
is on top, so an item that moves on appears at the top of the next stage's
block. An item that needs you keeps its place in this order. Finished items
are listed separately under **Recently completed**, the most recently finished
first.

## Changing the columns

Team Admins can open **Columns** to adjust the automatic stages for their
team: **rename** a stage, **merge** it into another one (its items are then
shown there), or **hide** it (its items appear in the stage before it). The
same dialog sets how long finished items stay in **Recently completed**.
Without a saved configuration the stages are derived automatically.

## Removing items from the board

Team Admins see **Remove from board** on every row no agent is working on or
queued for — typically a long-lived concept ticket in **Draft**. Before
anything happens the board asks you to confirm: only the board entry is
removed — the GitHub ticket stays unchanged (no closing, no labels, no edits).
The row disappears right away, for every viewer of the team's board, and stays
removed across reloads and restarts.

A removed item **comes back on its own** as soon as the flow picks it up
again: a wake or claim label is added, a team agent is woken on it, starts a
run on it or opens a pull request for it. Edits, comments and cross-references
do not bring it back.

**Removed (n)** next to **Columns** lists the removed items; **Restore** puts
one back at its current stage. Entries for items that are closed, deleted or no
longer part of the board's GitHub snapshot are cleaned up automatically.
