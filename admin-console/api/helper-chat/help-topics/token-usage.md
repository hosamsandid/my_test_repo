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
  - "Do the model rows add up to the total tile?"
  - "Which day does a run's usage land in?"
  - "Which model used the most tokens on which day?"
---

## What the page shows

Every agent invocation reports one **usage record** — the tokens that turn
consumed, the model(s) it ran on, and the agent, team and provider it belongs
to. This page is the read side of that store: it aggregates the records in the
selected time range and answers three different questions, one per tab. The
**Statistics** tab gives you the overall picture; the **Work items** tab ties
consumption to the piece of work it went into; the **Agent → model** tab shows
which model each agent actually runs.

Two things bound what you see:

- **System Admin only.** Consumption figures are an operator surface; a Team
  Admin or Team Member gets a 403 on the underlying endpoints, not a filtered
  view. There is no reduced version of this page for other roles.
- **The page-level Team filter** narrows every figure, all three tabs and both
  exports to one Agent Team (listed by name and id). It is shared across the
  tabs, so switching tabs keeps the filter.

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
export buttons carry the same time window and team filter as the view on screen.
The **Work items** export is one flat row per work item × model; the
**Statistics** export mirrors the on-screen grouping — an aggregated pivot with
one row per group, or one row per group × subgroup cell when a second dimension
is set — so grouping by model there still gives a per-model breakdown to price
against.

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

All three tabs carry the same range selector: **Last 24 hours**, **Today**,
**Yesterday**, **Last 7 days**, **This week**, **Last 30 days**, **This month**,
**Last month**, **Last 90 days**, **All time**, or **Custom range…** — a *From*
and a *To* date, both included, applied with **Apply** (an end date before the
start date cannot be applied, and the picker says why). Every boundary is in
**UTC**: *Today* starts at 00:00 UTC, *This week* on Monday 00:00 UTC, *Last
month* is the whole previous calendar month. The tiles, the table, the chart and
the CSV/JSON export all cover exactly the selected range. **All time** means as far back as the
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
provider tier or day — against the same range and team filter, and the chart
above it follows. The summary tiles and the totals never change with it; only
the chart and the rows underneath do.

An optional *then by* dropdown adds a **second** dimension, cross-tabulating the
breakdown into a nested table: for example *Group by agent, then by model*
answers which models each agent ran and how many tokens each burned. The second
list excludes whatever the primary is, so a self-cross can't be chosen, and
**None** restores the single-level table. Each primary group carries its own
total row with the secondary values indented beneath; a **model** axis splits
each run's tokens over the models it used on whichever side it sits, so those
cells add up to the group total — exactly as *Group by model* does on its own.

A few behaviours are worth knowing before you read a grouped table as a complete
accounting:

- **Group by model splits a run** across the models it used, because one run
  may call more than one model (a sub-agent, for example). The run's own tokens
  are shared out in proportion to each model's usage, so the model rows add up
  to the total tile. A run that recorded no per-model detail is listed under
  **unknown**.
- **Group by agent folds auto-scaled instances** into the agent that has the
  pool configured: a Developer's per-ticket instances add up on its one row, on
  screen, as the other dimension and in the export. The per-ticket split is on
  the Work items tab; the raw export keeps each run's own instance id.
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

The chart's **Bucket** control sets the bar size: **Hour**, **Day**, **Week**
(Monday to Sunday) or **Month**, all in UTC. **Auto** (the default) picks Hour
for ranges of up to 2 days, Day up to 60 days, Week up to a year and Month
beyond, and shows its choice, e.g. *Auto (Week)*; for *All time* it measures
from the earliest record. Hour is offered only for ranges of 7 days or less.
Every bucket in the range gets a bar — one without usage stays empty rather than
being left out — and a bucket the range only partly covers (e.g. *This week* on a
Wednesday) is one bar whose tooltip names the dates it covers. Together the bars
add up to the *Total tokens* tile, apart from series hidden in the legend.

The **Tokens per day** chart draws one bar per day and stacks it by the
selected *Group by* dimension — for example *Tokens per day by Model* gives one
segment per model, so you can see which model or agent used the most tokens on
which day. Legend entries use the same labels as the table (user names,
provider-tier labels, the **unknown** bucket). The eight largest values in the
range get their own colour; any further values are combined into one grey
**Other** series, so each day's bar still adds up to that day's share of the
table. With *Group by day* the chart keeps its breakdown by token class.

The **Chart** control switches how the chart is drawn: **Stacked bars over
time**, **Lines over time** (one line per value, same figures as the bars),
**Donut (share)** — each value's share of the range total, with percentages —
or **Ranking**, the range totals as horizontal bars, largest first and *Other*
last. Model, provider and provider tier start as a donut, agent, team and user
as a ranking, and day as stacked bars; a type you pick is kept for the rest of
the visit, through Refresh, range and *Group by* changes. With *Group by day*
the donut splits the range by token class (matching the four class tiles) and
Ranking is not offered. Every type uses the same colours, top-8 + *Other* and
legend: hiding a series removes it everywhere, and the donut's percentages are
recalculated over what is left. Hover over or tab to a slice or bar to read its
label, exact number and share. The **Bucket** control applies only to the
over-time types.

The **Measure** control sets what the chart counts: **Total tokens** (the
default), one token class (**Input**, **Output**, **Cache write**, **Cache
read**) or **Invocations**. Every chart type, the axis, the tooltips and the
donut's percentages follow it, and each value matches the table column of the
same name. With *Group by day* and a single class or Invocations, the donut is
not offered — there is no token-class split to show.

With a *then by* set, the chart uses it too. In a **Ranking** each bar is split
into its secondary values — the nested table rows beneath that group — with the
eight largest secondary values in their own colour and the rest as *Other*. In
**Stacked bars**, **Lines** and **Donut** you can **drill down**: click a
segment, point or slice (or tab to it and press Enter or Space) to see only that
value, split by the *then by* dimension. A breadcrumb such as *All agents ›
agent-a* shows where you are; its first entry leads back with the same chart
type, measure, range and legend choices. While drilled down the table shows only
that value; the export still covers the full view. *Other* is not drillable,
and changing *Group by*, *then by*, team or range returns to the top level.

Each tile compares its figure with the **previous period** — the window of the
same length directly before the current one — e.g. *▲ +12% vs previous 7 days*.
If the previous period had none, it reads *new*. The arrow and the sign show the
direction, so it never depends on colour; hover for the previous figure. *All
time* has no previous period, so no comparison is shown.

Clicking a legend entry hides or shows that series, and the y-axis rescales to
what is left — useful because cache reads, or one busy agent, routinely dwarf
everything else. The toggles affect only the chart: the tiles, the table and the
exports always cover everything. The token-class selection is remembered per
user across reloads; the selection for the other dimensions is kept per
dimension for the rest of your visit, through Refresh and range or team
changes.

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

## Agent → model

This tab answers a question the other two cannot: **which model does each agent
actually run?** The Statistics tab shows models and it shows agents, but never
the mapping between them, and the agent/team configuration does not show a model
at all — there is no per-agent model pin today, the model is chosen per
agent/role at runtime.

So the value here is the **Ist** (what was observed), not a **Soll** (a
configured setting). It is derived from the same usage records the other tabs
read: every invocation carries the model(s) it used, so for each agent this tab
lists **every model it ran** in the selected time range and marks the
most-recently-used one(s) as **current**. An agent that used more than one model
shows all of them, not just one — a spread that is otherwise invisible.

Use the **Model** filter to answer the reverse question — *which agents are on
model X* — for example to find everyone still running an expensive model. The
range and team filters narrow the picture the same way they do on the other
tabs.

When per-agent model pinning lands (#1485) this tab can show the configured
model beside the observed one, so a misconfiguration (Soll ≠ Ist) becomes
visible at a glance. Until then, observed usage is the only reliable source.
