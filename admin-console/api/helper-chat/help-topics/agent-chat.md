---
id: agent-chat
routes: ["/chats"]
title: Agent Chat
summary: One room per agent with one long-running Claude session, plus the side panels that decide when it wakes on its own (Triggers), what it signals when a run ends (Outcomes) and what it has learned (Knowledge).
seeAlso:
  - { label: "Flows", to: "/flows" }
  - { label: "Knowledge", to: "/knowledge" }
  - { label: "Agents", to: "/agents" }
  - { label: "Working Environments", to: "/environments" }
  - { label: "GitHub Event Log", to: "/github-events" }
askPrompts:
  - "What is the difference between a loop trigger and a cron trigger?"
  - "Why is my trigger not firing while a loop is running?"
  - "Where do I author outcomes — I can't edit them here?"
  - "What exactly happens when I retire a learning?"
  - "Which trigger type should I use to react to a pull request?"
  - "Why doesn't my loop show up in the Triggers list?"
---

## What this page is

Each agent has **one room** and, behind it, **one long-running Claude session**:
your next message resumes the same conversation rather than starting a new one.
*Reset Session* is what deliberately ends it — the next message then starts fresh
with no memory of what came before (the transcript in the room stays; only the
model's session is discarded).

An agent also has **one workspace** — a single clone of its repositories — so it
does **one thing at a time** in it. A chat message, any trigger run and a loop
iteration all pass through the same agent-wide gate and never overlap.

## Triggers — when the agent wakes on its own

The **Triggers** panel is the per-agent subscription list. Every type answers the
same question, "what wakes this agent", and every one of them delivers a
**wake instruction** — the prompt the agent is handed when it fires.

| Type | Wakes the agent when… |
|---|---|
| **Cron (recurring)** | a 5-field schedule (`Minute Hour Day Month Weekday`) comes due. If the previous run of *this* trigger is still going, the tick is skipped rather than queued. |
| **Once (one-shot)** | a specific date and time is reached. It then deletes itself — a reminder, not a schedule. |
| **HTTP webhook** | something outside the platform sends `POST /hooks/<agentId>/<triggerId>` with the trigger's own `X-Hook-Secret`. Each trigger carries its own generated secret; there is no open mode. Used by CI pipelines, monitoring, GitHub webhooks. |
| **GitHub event** | the built-in poller sees a matching event on a repository of the agent's Working Environment (about every 30 seconds). The full event payload is appended to the prompt as JSON. Needs a GitHub token on that environment. |
| **Data flow (agent dependency)** | a teammate pushes to the team repository — the committed work *is* the hand-off. Under the hood this is a GitHub `push` subscription with a marker. |
| **Loop (re-run until done)** | you start it. It is not a subscription (see below). |

### Cron and once fire on the container clock

Both are evaluated against the clock inside the container, not your laptop's. On
a Podman VM that clock can drift; a forward correction fires every `once` whose
time it passes and every `cron` whose time it crosses.

### A GitHub event fires regardless of who caused it

A GitHub-event or data-flow wake does **not** know whether the change is relevant
to this agent, and it fires for **the agent's own pushes** too. So the wake
instruction should tell the agent to `git pull` first, decide whether the change
concerns it, and answer `[PASS]` when there is nothing to do. (Actions taken
through `gh-as-agent` are stamped with the agent id, and the poller drops events
it can attribute to the same agent — that is loop *protection*, not a relevance
filter.)

A label listener can additionally **claim** its wake label on fire (`ready` →
`ready:wip`), which makes work-in-progress visible on GitHub and is rolled back
automatically if the run fails.

Hand-offs between several agents are much easier to wire and read as a graph in
the **Flow Editor** than as individual triggers here.

### A loop is a run, not a subscription

Every other type is a standing subscription and appears in this list. A **loop**
is a launched run: you start it from the **loop icon** in the chat composer, or
declare it as a self-edge in the Flow Editor. That is why the Triggers list never
shows one — an existing loop keeps running, it is just not a subscription.

A loop re-runs the same prompt until the goal is reached:

- **Each try starts with a fresh context window.** Nothing carries over in
  memory, so anything the next try needs must be written to disk (`memory/`
  files, a worklist) and re-read at the top of every run.
- **A maximum number of tries is required.** No unbounded loop can be authored.
- It ends as soon as any terminal state is reached: **done** (the stop condition
  succeeded), **exhausted** (the try cap or the token budget), **paused** (the
  platform's runaway safeguard) or **stopped** (you pressed Stop).
- **Who checks the work** is a *separate* gate from the work itself: a command
  that must pass, another agent that reviews each try, or the flow's downstream
  reviewers. A failed check is fed back into the next try's prompt. Team agents
  must not grade their own work — leave it blank and a sibling reviewer is
  re-applied server-side. Pick *the flow checks the hand-off* when each try ends
  in a PR or a label that a wired QS chain already reviews, so the same reviewer
  does not check the work twice.

### While a loop runs, everything else waits

A loop holds the workspace for its whole duration, not between iterations:

- Other triggers **and** chat messages are held until the entire loop has
  finished. Deferred webhook/GitHub work stays durably queued — not dropped, not
  delivered twice — and drains in arrival order.
- **Stop always works.** It is an out-of-band control, not a queued message, so
  you are never locked out.
- A long loop with many queued chat messages sheds the newest ones with a visible
  notice rather than flooding the room when it ends.
- Maintenance Mode pauses both firing and draining.

## Outcomes — what the agent signals when a run ends

An **outcome** is the signal a run ends with: a *condition* in plain language
("the review found blocking problems") plus the *label* it emits. The label is
what wakes the next agent, so outcomes are one half of the
**Outcome → Label → Consumer** hand-off; the other half is which teammate
subscribes to that label.

Two modes:

| Mode | Meaning |
|---|---|
| **exactly one** | The agent picks exactly one of the listed outcomes per run — mutually exclusive verdicts, e.g. approved *or* changes-requested. |
| **any of** | The agent emits all that apply, and zero is allowed. |

The panel is **read-only on purpose**: outcomes are part of a flow's wiring, so
they are authored in the **Flow Editor** and reviewed here next to the agent that
declares them. An agent with **no** outcomes signals nothing when its run ends,
so no teammate is woken by its work — that is a wiring gap, not a setting. An
older agent may still carry plain flat labels with no condition or title; those
keep working and can be upgraded to structured outcomes in the Flow Editor.

## Knowledge — what this agent has learned

The **Knowledge** tab lists the concrete entries this agent has contributed to
its team's shared knowledge base (the badge in the chat header counts them). It
is a list of facts, not an event feed: harvests happen a few times a day, so it
is refreshed when you open the tab rather than streamed.

Two actions per entry:

- **Propose as skill** nominates the entry as a promotion candidate. It does not
  create anything; a human decides on the Knowledge page.
- **Retire** takes the entry out of circulation.

### What retiring actually does

Retiring is a **soft, reversible archive**, not a delete:

- The entry's id is added to the team's archived set and the knowledge base is
  re-projected, so the entry stops appearing in the digest every agent of that
  team gets in its context.
- The change is **committed to git**, so what was retired and when stays
  auditable.
- It can be **un-retired** on the Knowledge page — the entry is still there.
- One case is refused: an entry that **backs a promoted skill** cannot be
  retired. Remove the skill first.

Retiring a single wrong lesson is the right tool for a fact that turned out to be
untrue. If an entry was correct but has simply expired, setting its
validity window on the Knowledge page records *why* it stopped applying instead.
