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

## Who is working right now

Each line is a run in progress: the **role**, the **instance** number for a
pooled role, the **issue or pull request** it works on, and **how long it has
been running**. Agents that are idle are not listed. A run whose item has just
closed keeps its line until it ends, but never adds a row to the board.

A **pooled** role (one that starts a separate instance per work item) shows
how busy it is — for example **2 of 3 busy** — and its controls.

## Pause, Drain and Switch on

The buttons on a pooled role change whether it takes **new** work. They never
stop a run that is already going.

- **Pause** — Pause: running instances finish their current work. New work waits in a queue and starts when you click Resume.
- **Drain** — Drain: running instances finish their current work, new work waits, and the role switches itself Off once the last one is done. Click Switch on to start it again.
- **Resume** — Resume: start taking new work again. Anything that waited while paused starts now.
- **Switch on** — Switch on: start taking new work again. Anything that waited while the role was off starts now.

Use **Pause** for a short stop you will undo yourself. Use **Drain** to wind a
role down: while it drains the line reads **Draining, n still running**; when
the last run finishes it reads **Off**. Nothing is lost either way — work that
arrives meanwhile waits and is counted as *waiting*.

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

## The stages

The columns come from the team's own flow on the **Flows** page: **Ready**,
then one stage per role in hand-off order, then **Done**. A team with a
different flow gets different stages; nothing depends on label names. A role
that appears on several paths is shown once, at its first position, and pooled
instances count as their role.

An issue and the pull requests its agents opened form **one row** — no
"Closes #…" needed. With several PRs for one issue, the row follows the most
advanced open one. A pull request an agent opened without an issue gets its
own row.

Each row shows its **current stage**, whether an agent is **working** on it or
it is **up next**, and the **time in that stage** — not the item's total age.

Rows read like the pipeline, **top to bottom**: **Ready** first, then each
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
