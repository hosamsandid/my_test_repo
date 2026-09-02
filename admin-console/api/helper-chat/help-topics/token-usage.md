---
id: token-usage
routes: ["/token-usage"]
title: Token Usage
summary: How many tokens your agents used against the model provider — the raw usage behind every agent run, so you can tell where the spend goes.
seeAlso:
  - { label: "Model Providers", to: "/models" }
  - { label: "GitHub Event Log", to: "/github-events" }
  - { label: "Agents", to: "/agents" }
  - { label: "Access & Users", to: "/teams" }
askPrompts:
  - "What is the difference between the Statistics and Work items tabs?"
  - "Why does this page show token counts instead of money?"
  - "What do the attribution signals flow, created, event and branch mean?"
  - "Why are some tokens unattributed?"
  - "What is the difference between cache write and cache read tokens?"
---

## What this page shows

Every agent invocation reports one **usage record** — the tokens that turn
consumed, the model(s) it ran on, and the agent, team and provider it belongs
to. This page is the read side of that store: it aggregates the records in the
selected time range and answers two different questions, one per tab.

Two things bound what you see:

- **System Admin only.** Consumption figures are an operator surface; a Team
  Admin or Team Member gets a 403 on the underlying endpoints, not a filtered
  view.
- **The page-level Team filter** narrows every figure, both tabs and both
  exports to one access scope. It is shared across the tabs, so switching tabs
  keeps the filter.

Only **agent runs** are recorded. The console's own AI helpers — the Flow
Copilot, *Generate agent prompt*, the improvement analyst, the Help panel's Ask
face — are one-shot server-side calls that never produce a usage record, so
their tokens are billed by your provider but do not appear here.

## Statistics vs Work items

| Tab | Question it answers |
|---|---|
| **Statistics** | The overall picture: the total for the selected period, how it trends over time, and a breakdown you can group by agent, team, model, provider or day. |
| **Work items** | Usage tied to a specific GitHub issue and the pull request(s) that resolve it, so you can see how much one piece of work consumed. |

On **Statistics**, *Group by* re-keys the breakdown table against the same range
and team filter; the summary tiles and the totals never change with it. Grouping
by **model** is the one special case: a run is fanned out across its per-model
split, so a run that recorded no per-model detail still counts in the totals but
contributes to no model row. A record that carries no team, provider or model at
all lands in an explicit `unknown` bucket rather than being dropped.

The **Tokens per day** chart legend toggles which token classes are drawn, and
the y-axis rescales to what is left — useful because cache reads routinely dwarf
everything else. The toggles affect only the chart: the tiles, the table and the
exports always cover all four classes. Your selection is remembered per user
across reloads.

## Token counts, not costs

Every figure on this page is a **raw token count**. Nothing is priced, and no
currency is ever shown or stored — a usage record may carry a cost field from
the CLI, but this page deliberately never reads it. Prices differ per contract,
per provider and per model, and a stale price baked into a dashboard is worse
than no price at all.

Apply your own per-model pricing downstream instead: the **CSV** and **JSON**
export buttons emit one flat row per invocation × model (Statistics) or per work
item × model (Work items), carrying the same time window and team filter as the
view on screen.

## The four token classes

| Class | What it is |
|---|---|
| **Input** | Prompt tokens sent to the model — the conversation, instructions and context the agent reads in. |
| **Output** | Tokens the model generated in its replies. |
| **Cache write** | Input tokens written into the provider prompt cache on first use. Charged once, then cheap to re-read. |
| **Cache read** | Input tokens served from the prompt cache instead of being re-sent in full, so a repeated context costs less than the first time. |

Because a long-lived agent re-reads a large system prompt on every invocation,
cache read is usually the largest class by far. That is the cache working, not a
problem.

## Work items and attribution

A **work item** is one issue ↔ PR chain: GitHub issues and pull requests are
nodes, and a PR's `closes #N` references are the edges that join them. Follow-up
PRs that close the same issue fall into the same chain automatically, so a
BA → Developer → Reviewer → Reworker sequence shows up as one item with no
per-flow configuration.

Each run is counted **exactly once**, attached to the artifact it has the
strongest signal for:

| Signal | How the run was tied to the work item | Certainty |
|---|---|---|
| **flow** | The run was wired into the flow instance that owns the work item. | strongest |
| **created** | The run itself created the linked issue or pull request. | exact |
| **event** | The run reacted to a GitHub issue/PR event, which stamped the number on the record. | exact |
| **branch** | Matched only by branch name — the run committed on some PR's head branch. | heuristic |

Only the first matching signal is used, so the *Signals* column is a tally of
how the item's runs were attributed, not a list of overlapping guesses. Two
flags may appear next to a work item:

- **shared** — a run in it touched artifacts belonging to more than one chain.
  Its tokens are still counted once, in one chain only.
- **flow-mismatch** — runs in the chain reported more than one flow instance,
  which usually means two flows are acting on the same issue or PR.

## Why some tokens are unattributed

Attribution is never total, so the remainder is **always** reported rather than
hidden or spread around. Direct chats, scheduled self-maintenance and triggers
that are not linked to an issue or PR have no work item to belong to, so their
tokens land under *Unattributed tokens* / *Unattributed runs* and the coverage
tile shows what share could be attributed.

The **Ø … / work item** averages divide by the number of *attributed* work items
only. Unattributed tokens are deliberately excluded — they have no work item to
divide by, and mixing them in would distort the per-work-item figure. With zero
work items in range the averages show `—` rather than a fabricated zero.

## Reading the time range honestly

- Records are filed under the day the run actually happened, using the
  timestamp the agent stamped — not the time the record arrived. A run that was
  spooled while the control plane was down and pushed later still lands in its
  own day.
- **All time** means as far back as the usage log goes. There is no automatic
  retention on this store — token telemetry is billing-adjacent, so nothing is
  pruned silently — but a stack that was rebuilt from scratch starts empty.
- *Invocations* counts model calls, not conversations: one chat turn or one
  trigger run is one invocation.
- **Open session** on a run in the work-item detail jumps straight to that run
  in Agent Chat, which is the fastest way to see what an expensive run was
  actually doing.
