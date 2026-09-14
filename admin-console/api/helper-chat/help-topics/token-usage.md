---
id: token-usage
routes: ["/token-usage"]
title: Token Usage
summary: How many tokens your agents used against the model provider — the raw usage behind every agent run, so you can tell where the spend goes.
seeAlso:
  - { label: "Model Providers", to: "/models" }
  - { label: "GitHub Event Log", to: "/github-events" }
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Administration", to: "/users" }
askPrompts:
  - "What is the difference between the Statistics and Work items tabs?"
  - "Why does this page show token counts instead of money?"
  - "What do the attribution signals flow, created, event and branch mean?"
  - "Why are some tokens unattributed?"
  - "How can I see what a globally-shared model provider is costing, and who is using it?"
  - "What is the difference between cache write and cache read tokens?"
  - "Why does grouping by model show less than the total tile?"
  - "Which day does a run's usage land in?"
---

## What the page shows

Every agent invocation reports one **usage record** — the tokens that turn
consumed, the model(s) it ran on, and the agent, team and provider it belongs
to. This page is the read side of that store: it aggregates the records in the
selected time range and answers two different questions, one per tab. The
**Statistics** tab gives you the overall picture; the **Work items** tab ties
consumption to the piece of work it went into.

Two things bound what you see:

- **System Admin only.** Consumption figures are an operator surface; a Team
  Admin or Team Member gets a 403 on the underlying endpoints, not a filtered
  view. There is no reduced version of this page for other roles.
- **The page-level Team filter** narrows every figure, both tabs and both
  exports to one access scope. It is shared across the tabs, so switching tabs
  keeps the filter.

Only **agent runs** are recorded. The console's own AI helpers — the Flow
Copilot, *Generate agent prompt*, the improvement analyst, the Help panel's Ask
face — are one-shot server-side calls that never produce a usage record, so
their tokens are billed by your provider but do not appear here.

### Token counts, not costs

Every figure on this page is a **raw token count**. Nothing is priced, and no
currency is ever shown or stored — a usage record may carry a cost field from
the CLI, but this page deliberately never reads it. Prices differ per contract,
per provider and per model, and a stale price baked into a dashboard is worse
than no price at all.

Apply your own per-model pricing downstream instead: the **CSV** and **JSON**
export buttons emit one flat row per invocation × model (Statistics) or per work
item × model (Work items), carrying the same time window and team filter as the
view on screen.

### The four token classes

| Class | What it is |
|---|---|
| **Input** | Prompt tokens sent to the model — the conversation, instructions and context the agent reads in. |
| **Output** | Tokens the model generated in its replies. |
| **Cache write** | Input tokens written into the provider prompt cache on first use. Charged once, then cheap to re-read. |
| **Cache read** | Input tokens served from the prompt cache instead of being re-sent in full, so a repeated context costs less than the first time. |

Because a long-lived agent re-reads a large system prompt on every invocation,
cache read is usually the largest class by far. That is the cache working, not a
problem.

### Choosing a time range

Both tabs carry the same range selector. **All time** means as far back as the
usage log goes: there is no automatic retention on this store — token telemetry
is billing-adjacent, so nothing is pruned silently — but a stack that was
rebuilt from scratch starts empty. Which day a given record falls into is a
question of its own, answered under *How runs are attributed* below.

## The Statistics tab

Statistics answers the overall question: the total for the selected period, how
it trends over time, and a breakdown you can slice several ways. The tiles
across the top carry the period totals — the four token classes plus
**Invocations**, which counts model calls rather than conversations: one chat
turn or one trigger run is one invocation, so a single task can report many
invocations.

*Group by* re-keys the breakdown table — by agent, team, user, model, provider,
provider tier or day — against the same range and team filter. The summary tiles
and the totals never change with it; only the rows underneath do. A few
behaviours are worth knowing before you read a grouped table as a complete
accounting:

- **Group by model fans a run out** across its per-model split, because one run
  may call more than one model. A run that recorded no per-model detail still
  counts in the totals but contributes to no model row, so the model rows can
  legitimately add up to less than the total tile.
- **Group by user** charges each run to a person — the human who sent the chat
  message that started it, or, for an autonomous or triggered run, the owner of
  the agent. Runs that can be charged to neither fall under **Unattributed**, a
  reported gap rather than a person (it also covers records written before this
  attribution existed). This is a different question from the Work items tab's
  coverage below, which asks which *ticket* a run went into, not which person
  paid for it.
- **Group by provider tier** splits the spend by how the paying provider is
  reachable — **Global** (a provider published to the whole installation, with no
  team as its accounting anchor), **System** or **Team** — so a globally shared
  provider's usage is visible and told apart from team-scoped usage at a glance.
  A run whose provider is no longer registered reads as **Unknown**.
- **A record with no team, provider or model at all** lands in an explicit
  `unknown` bucket rather than being dropped. An `unknown` row is real
  consumption whose label is missing — never a rounding artefact.

The **Tokens per day** chart legend toggles which token classes are drawn, and
the y-axis rescales to what is left — useful because cache reads routinely dwarf
everything else. The toggles affect only the chart: the tiles, the table and the
exports always cover all four classes. Your selection is remembered per user
across reloads.

## The Work items tab

Work items answers the narrower question: how much did *this* piece of work
cost? A **work item** is one issue ↔ PR chain. GitHub issues and pull requests
are the nodes, and a PR's `closes #N` references are the edges that join them.
Follow-up PRs that close the same issue fall into the same chain automatically,
so a BA → Developer → Reviewer → Reworker sequence shows up as one item with no
per-flow configuration.

The table lists one row per chain with its repo, when it started (the earliest
run in the chain), the roles that worked on it, its run count and its token
totals. Selecting a row opens the detail below it,
listing the individual runs; **Open session** on a run jumps straight to that
run in Agent Chat, which is the fastest way to see what an expensive run was
actually doing.

### Coverage, and the unattributed remainder

Attribution is never total, so the remainder is **always** reported rather than
hidden or spread around. Direct chats, scheduled self-maintenance and triggers
that are not linked to an issue or PR have no work item to belong to, so their
tokens land under *Unattributed tokens* / *Unattributed runs*, and the coverage
tile shows what share could be attributed. A low coverage figure is not a fault
in itself — it usually means much of the period went into conversation rather
than into tracked tickets.

The **Ø … / work item** averages divide by the number of *attributed* work items
only. Unattributed tokens are deliberately excluded — they have no work item to
divide by, and mixing them in would distort the per-work-item figure. With zero
work items in range the averages show `—` rather than a fabricated zero.

## How runs are attributed

Each run is counted **exactly once**, attached to the artifact it has the
strongest signal for. Four signals can tie a run to a work item, and they are
ranked:

| Signal | How the run was tied to the work item | Certainty |
|---|---|---|
| **flow** | The run was wired into the flow instance that owns the work item. | strongest |
| **created** | The run itself created the linked issue or pull request. | exact |
| **event** | The run reacted to a GitHub issue/PR event, which stamped the number on the record. | exact |
| **branch** | Matched only by branch name — the run committed on some PR's head branch. | heuristic |

Only the first matching signal is used — the strongest wins, and the weaker
matches for the same run are discarded rather than added. That is why the
*Signals* column is a tally of how the item's runs were attributed, not a list
of overlapping guesses, and why a chain made up of `branch` matches deserves
more scepticism than one made up of `flow` matches.

### The two flags

Two flags may appear next to a work item:

- **shared** — a run in it touched artifacts belonging to more than one chain.
  Its tokens are still counted once, in one chain only, so a shared item never
  double-counts; it only means the boundary between chains is fuzzy there.
- **flow-mismatch** — runs in the chain reported more than one flow instance,
  which usually means two flows are acting on the same issue or PR.

### Which day a run lands in

Records are filed under the day the run actually happened, using the timestamp
the agent stamped — not the time the record arrived. A run that was spooled
while the control plane was down and pushed later still lands in its own day, so
the *Tokens per day* chart and the range filter stay honest about when the work
was really done rather than showing a spike on the day the backlog drained.
