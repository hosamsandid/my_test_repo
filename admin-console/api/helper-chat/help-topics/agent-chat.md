---
id: agent-chat
routes: ["/chats"]
title: Agent Chat
summary: The page where you talk to an agent — the agent list, the chat header, the composer and the right rail — plus the panels that decide when it wakes on its own, what it signals when a run ends and what it has learned.
seeAlso:
  - { label: "Flows", to: "/flows" }
  - { label: "Knowledge", to: "/knowledge" }
  - { label: "Create something new", to: "/create" }
  - { label: "Working Environments", to: "/environments" }
  - { label: "Access", to: "/teams" }
  - { label: "GitHub Event Log", to: "/github-events" }
askPrompts:
  - "What is the difference between a loop trigger and a cron trigger?"
  - "Why is my trigger not firing while a loop is running?"
  - "What is the difference between Reset Session and Clear History?"
  - "Where do I author outcomes — I can't edit them here?"
  - "What exactly happens when I retire a learning?"
  - "Why does switching the model provider restart the agent?"
  - "How do I point the agent at a file in its workspace?"
  - "What is the difference between an Agent Team and a Team on the Access page?"
  - "What is the difference between Disable, Reset to stub and Delete?"
  - "Why does one of my agents show as not initialised?"
  - "Where did the Agents page go?"
  - "Where did the orphaned-agents list go?"
  - "Where do an agent's skills, prompt and plugins come from?"
---

This page has four areas, and each of them has a **?** that opens this help at
the matching chapter: the **agent list** down the left, the **chat header** at
the top, the **message composer** at the bottom, and the **right rail** with its
tabs. Read on for what each one does.

## What the Agent Chat page is

Each agent has **one room** and, behind it, **one long-running Claude session**:
your next message resumes the same conversation rather than starting a new one.
*Reset Session* is what deliberately ends it — the next message then starts fresh
with no memory of what came before (the transcript in the room stays; only the
model's session is discarded).

An agent also has **one workspace** — a single clone of its repositories — so it
does **one thing at a time** in it. A chat message, any trigger run and a loop
iteration all pass through the same agent-wide gate and never overlap. When the
agent is busy you can still type; your message waits its turn.

Everything on this page is scoped to the agent you have selected. Switching
agents switches the room, the workspace, the triggers, the outcomes — the page
keeps its shape, the contents all change.

## The agent roles

An **Agent** is a **long-running Claude Code instance** with its own workspace
and session history. There are three roles, and the one an agent has decides
where its prompt and skills come from:

| Role | What it is | When to use it |
|---|---|---|
| **Agent** (standalone) | A single chat agent with its own system prompt. The prompt shapes its persona — a COBOL specialist, a code-review buddy, a release manager. Add cron / GitHub triggers later to make it run autonomously as well as answer messages. | One-of-a-kind agents that act on their own. |
| **Agent Team** | A squad of agents working a repository. It stores a system-prompt template and hosts no agent itself — **Add member…** on the team's group header spawns agents that share the prompt and Working Environment but each get their own workspace and their own conversation. | Several copies of the same kind of agent — e.g. three reviewer agents in parallel. Start one from the **Create** launcher rather than by hand. |
| **Team Member** | One agent spawned from an Agent Team. Its system prompt, skills and MCP servers **inherit** from the parent team unless you flip a field from *Inherit* to *Custom*. Role, Working Environment and parent team are fixed at creation; of those, only the parent team is shown in the Settings form. | You do not pick this role — it is assigned when you add a member to a team. |

> An **Agent Team** is *not* the same thing as a **Team** on the **Access**
> page. That Team is the human tenant / **access scope** every agent,
> environment and credential belongs to; an Agent Team is a squad of agents.

**The three states a row can be in.** *Active* — running and ready to chat.
*Paused* — the workspace is kept, the process is stopped (this is what **Disable**
produces). *Not initialised* — a **stub**: it has its configuration and triggers,
but no workspace, no cloned repository and no running process. You get a stub
from a team created with **Provision agents now** left off, or from a
member added later with **Materialize now** unticked. **Materialize** in the
team's *Not materialized yet* section brings it to life.

## The agent list

The left rail lists every agent you can see, and clicking one opens its room.

**Grouping and order.** Agents that belong to an Agent Team are grouped under
that team; standalone agents are collected under *Single agents*. When every row
in a group shares one Working Environment, the environment name is hoisted onto
the group header and the rows stay single-line; a member that deviates keeps its
own environment line. Groups collapse and expand, and both the collapse state
and your own ordering are remembered per user. Drag a row by its grip to
reorder, or move the focused row with **Alt+↑** / **Alt+↓** if you would rather
not drag.

**Finding an agent.** The filter box above the list narrows it as you type. Next
to it, the **eye** toggle is the *show disabled agents* opt-in: disabled agents
are hidden by default, because most of the time they are noise. Turning it on is
the only thing that widens what the list asks the server for.

**What a row tells you.** A row shows the agent's name, its environment (unless
hoisted to the group header), and two live signals: a **busy** indicator while a
run is in progress, and an **unread** marker when messages arrived while you were
looking elsewhere.

**The row menu.** Every row has a context menu — reach it from the kebab (**⋮**)
on hover, a right-click, or the **Menu** / **Shift+F10** keys. It carries:

- **Mark as unread** — a local view action. It only flags the row for you; the
  agent is not touched and no request is sent.
- **Enable / Disable** — *Disable* stops the agent's container and stops it
  waking. Its configuration, workspace and history all survive; *Enable* brings
  it back. This is the reversible pause.
- **Reset to stub** — stops the agent and **wipes** its workspace: session
  history, cloned repositories, anything it had written. The configuration stays,
  so it can be started again from scratch.
- **Delete** — removes the agent's configuration entirely. Deleting an **Agent
  Team** additionally removes that team's locally cached and curated knowledge
  (knowledge shared through its repository is untouched).
- **Clone**, **Export (ZIP)** and **Save as template** — copy this agent, take a
  copy away, or turn it into a reusable template.
- A group header carries the team-wide equivalents: **Enable/Disable** for the
  whole team, **Add member…**, **Team settings…** (which opens the team's own
  Settings tab here rather than jumping to another page), **Export team
  (ZIP)**, **Open in Flow Editor** and **Delete team**.
- **Add member…** asks one question before it acts: **Materialize now**, which is
  ticked by default. Leave it ticked and the member is created as it always was —
  chat account, workspace, repository clone, running container. Untick it and
  you get a **stub** instead: its configuration and triggers are written, but
  nothing is cloned and nothing runs. The stub appears in this team's *Not
  materialized yet* section, and **Materialize** there finishes it into an agent
  that is indistinguishable from one you had built right away. Use the unticked
  mode when you are assembling a team over several sittings; the prompt, the
  label suffix and every substituted variable are identical either way, so
  deferring costs you nothing later. Do **not** reach for *Disable* to achieve
  this — a disabled member is one whose repository was already cloned and whose
  container already ran, which is a different state that merely looks similar in
  the list.
- **What these actions do…** — the last entry opens this chapter. A menu cannot
  carry a "?" button, so the help is an entry like any other.

Entries you are not allowed to use are greyed out rather than hidden, so the
menu reads the same for everyone; the server enforces the same boundary
independently. A **disabled** agent has no chat to open, so clicking its row
opens this menu instead — which is where *Enable* is.

**Members that have not been started yet.** A team can be created with its
members left as **stubs** — configuration and triggers only, with no chat
account, no workspace and no cloned repositories — so a process with dozens of
roles does not provision all of them on day one, and **Add member…** above adds
one to a live team the same way. Such members appear at the
bottom of their team group under a collapsed **Not materialized yet (N)**
section; the count is on the header, so you can see how many are waiting without
opening it. A stub row is marked **Not initialised** and cannot be opened as a
chat, because there is no chat account to open yet. Its menu offers
**Materialize**, which is the operation the removed Agents page called *Activate*:
it creates the chat account, seeds the workspace with the agent's skills, prompt
and MCP configuration, clones the environment's repositories and starts the
agent. Expect it to take a moment when repositories are involved — the row shows
it working — and when it finishes the member moves up into the list above.

A stub is *not* the same thing as a **paused** agent: paused means provisioned
and switched off, stub means never provisioned at all. That is why the *show
disabled agents* opt-in has no effect on this section, and why the two carry
different marks. If the team itself is disabled, **Materialize** is offered but
inert with *enable the team first* — a member cannot be started while its team
is off.

**Adding an agent** is done from the page header, not the list. **New Agent**
(top right) hands over to the create launcher, where *Configure an agent
manually* — under **Advanced options** — opens the direct form; **Import Agent**
next to it takes an exported agent ZIP and asks for an id and a team before it
lands. The imported agent joins the list
without a reload — but if the list filter is narrowed at the time, the
confirmation says so rather than letting it arrive out of sight. Both buttons
are greyed out with the reason when you may not create agents.

## The chat header

The top of the conversation carries who you are talking to and the controls for
the session behind it.

**Identity.** The agent's name, and next to it a **learning badge** counting what
this agent has contributed to its team's knowledge base — clicking it opens the
Knowledge tab.

**The model selector** shows the model the agent actually runs on, as
*model · provider*. An agent inherits the model provider its Working Environment
names; picking a different one here is a **per-agent override**, and *Reset to
environment default* takes it back off. Two things are worth knowing before you
switch: each row shows that model's **context window**, and changing the
**provider** restarts the agent's container — so it asks for confirmation first,
and anything in flight ends. Changing only the *model* within the same provider
does not restart anything. When you may not change it, the reason is shown
rather than the control silently doing nothing.

**The context-usage indicator** next to it is the running total for this session:
how much of the model's context window the conversation has consumed. It is the
number to watch when replies start losing earlier detail — that is the point to
*Reset Session*.

**About this chat** (the **i**) opens the detail behind that one-line indicator:

- **About** — the agent's Working Environment and each repository it has cloned,
  with the branch and a dot when the clone has uncommitted changes.
- **Session** — the current session id, copyable, which is what you quote when
  something needs looking up in the logs.
- **Usage** — the session's total price and the token breakdown behind it
  (input, output, cache-write, cache-read).
- **Model** — the selected model's context window and maximum output.

Values that are genuinely unknown are left out rather than shown as zero.

**Session tools.** *Reset Session* ends the model's session, as described above —
the transcript stays. *Clear History*, under the **…** overflow, does the
opposite: it empties the visible transcript. Reset for "forget what we
discussed", Clear for "tidy the screen".

## The message composer

The box at the bottom is where you talk to the agent, and it does rather more
than send text.

**Sending.** Which key sends is your own preference, set in
**Settings → Behavior**: either *Cmd/Ctrl+Enter sends, Enter makes a newline*
(the default) or *Enter sends, Shift+Enter makes a newline*. The placeholder
always names the current one, and a change takes effect in the open chat
immediately.

**Drafts.** Whatever you have typed is kept per agent, so switching to another
agent and back does not lose it.

**Slash commands.** Typing **/** as the first character of a message opens a
filterable list of the slash commands this agent has been provisioned with,
navigable with **↑ ↓ Enter Esc Tab**. Picking one inserts it with the cursor
placed for its arguments. A **/** typed mid-message is just a slash, and an agent
with no commands never shows an empty list.

**Stop.** While the agent is working — on your message *or* on a loop it is
running — the send button becomes a single **Stop**. There is only ever one stop
control, and it always works: it is out-of-band, not a queued message, so a busy
agent can never lock you out.

**Loops.** The **loop** icon launches a run that repeats until the goal is
reached, rather than sending one message. The launcher states its own stop
contract next to the fields, because that is the decision you are making; the
concept — and why a loop never appears in the Triggers list — is under
**Triggers** below.

**Voice.** The **mic** records a quick dictation: it transcribes when you stop and
drops the text into the draft for you to edit and send. Its **chevron** offers
something different — *Record meeting for this agent*, the **meeting
note-taker**. That one is an app-level recording session: it keeps running while
you navigate the console, shows a floating card with pause/stop/cancel, records
in fixed segments, and on **Stop** assembles the whole transcript into a single
message sent to that agent. Dictation is a few words into the box you are looking
at; the note-taker is a meeting you did not want to retype.

**Files.** The paperclip attaches a file — as does dragging one onto the composer
or pasting it. To point the agent at a file it *already has*, use the **@** button
on a row in the Workspace tab: it splices `@<path>` into the draft, and the agent
resolves that path itself with no upload.

**Answering a question.** When a run pauses to ask you something, the question
arrives as a card with the options as buttons — click one instead of typing it.
A card with several questions walks you through them one at a time and sends a
single consolidated answer at the end, so the agent resumes once. Only the newest
unanswered card is clickable; once a later message arrives it goes inert, and
your earlier choice stays marked.

## The right rail

The rail on the right holds everything about the agent that is not the
conversation. Toggle it with **Cmd/Ctrl+Shift+L** or the chevron in its tab
strip; it can also collapse to a strip of icons. Two of its tabs are
conditional: **Outcomes** appears only for an agent that belongs to a team, and
**Settings** only when you are allowed to manage that agent.

### Sessions — watching a run

The **Sessions** tab is the monitoring surface: the runs this agent has done and
the one it is doing now. Its badge counts the currently active sessions. Pick a
run to see its structured **session log** — every step the agent took — together
with what that run cost and how much context it used. A live run streams in as it
happens and can be stopped from here; a finished one can be reopened any time.

### The session log and the TODO panel

The session log is a timeline of the run, not a wall of text: each tool call and
its result are folded into one block, and hovering a row dims everything that
does not belong to the same turn, so you can follow one exchange through a busy
log. Long logs are windowed, so a run with thousands of steps stays responsive.

While the agent is working through a task list, that list is shown live — inline
in the timeline and in a **TODO panel** docked to the bottom, with a
*done/total · current step* summary. It is built from the agent's own task
tracking, so it updates as the agent revises its plan rather than only at the
end. Dismiss it and it comes back on the next change.

### Workspace — browsing the files

The **Workspace** tab is a read-only view of the agent's own workspace: its
repository clones, its `memory/` files, everything it has written. You can open a
file, download it, and see images inline. Each file row also offers
**reference in chat** (**@**), which is the fastest way to say "look at this one".
The **Git** mode next to *Tree* switches the same tab to the repository view —
which files the agent has changed, and the diff for each.

An agent may additionally have one or more **context folders** — host folders an
administrator mounted into its container. They appear in the same tree under
their own root. Those folders live only inside the agent's container, so the
console browses them *through* it, and the agent has to be running for that to
work. A context folder is **read-only** unless it was mounted read-write; a
read-write one also offers upload, delete and drag-to-move, and a read-only one
simply offers no write action at all.

### The other tabs

**Triggers**, **Outcomes**, **Knowledge** and **Settings** are the remaining
tabs; each has its own chapter below.

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
concerns it, and answer `[PASS]` when there is nothing to do. There is
deliberately **no source filtering** anywhere in the delivery path — loop
protection is frequency-based (a per-conversation throttle and a burst digest),
so relevance is the agent's job, not the trigger's.

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

The tab is only there for an agent that belongs to a team — a standalone agent
has no teammate to hand work to, so it has nothing to signal.

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

## Settings — configuring the agent

The **Settings** tab is the agent's own edit form — name, system prompt, skills,
plugin grants, host context folders. It is the only place an existing agent is
configured: the Agents page that used to host a second copy of this form was
removed once the tab covered it (see *Where the Agents page went* below).

Its **role** and its **Working Environment** are fixed at creation and are not
shown here — neither could be changed in this form anyway. The agent's role is
what its list icon shows, and the environment's name sits under the agent's name
in the list (on a team, once per group header).

Three things behave differently from an ordinary form:

- **Unsaved edits are kept, not confirmed away.** Switch to another agent and
  back and your draft is still there behind an *unsaved changes* banner, with a
  Discard if you did not want it. A click in the agent list is never blocked by
  a modal.
- **Some changes apply immediately**, without Save — plugin grants and context
  folders have their own endpoints. A context-folder change re-provisions the
  container, which ends the run you are watching, so it asks first.
- **The tab follows the open chat**, but a rail menu can point it at another
  agent — which is how a *team*'s settings, or a *disabled* agent's, are
  reachable at all. It is hidden entirely when you may not manage the agent, so
  the tab is never a control the server would refuse.

### What the form fields control

The **System Prompt** comes first, directly under the display name: it is the
most consequential thing in this form, so it is not below the plugin grants.

- **System Prompt** — the persona Claude reads at startup: role, expertise,
  communication style, constraints. Markdown is fine. On an **Agent Team** it is
  a *template* stored once and reused by every member that inherits it; leave it
  blank to give members an empty default and set a prompt per member instead.
- **Skills** — copied into the agent's workspace at seed time. A team's skill
  set is copied into every member's workspace and members inherit it unless they
  set their own override. On the create form only global-pool skills are offered;
  team-tier skills become available once the agent belongs to a team.
- **Plugins** — governed capabilities beyond the container, reached through a
  broker that holds the privilege so the agent never does. Changes apply
  immediately, with no save and no restart. On a team agent the grant covers the
  whole squad; setting it on a member creates a per-member override.
- **Host context folders** — expose folders from the host machine to the agent as
  live context, mounted **read-only** by default; tick read-write to let the
  agent change files on the host. Saving re-provisions the agent's container.
  Offered only on the local / self-hosted stack.

## Where the Agents page went

There used to be a separate **Agents** page for managing the agents you already
had. Everything it did is on this page now, so it was removed rather than kept
as a second way to do the same things — two surfaces for one job is how they
drift apart. Old `/agents` links land here.

| What it offered | Where it is now |
|---|---|
| Team, standalone and member cards | the **agent list**, grouped the same way |
| A card's **Clone** / **Export (ZIP)** / **Save as template** icons | the row's context menu, same three entries |
| The edit side panel | the **Settings** tab |
| **New Agent** / **Import Agent** | this page's header, top right |
| Stub visibility and **Activate** | *Not materialized yet*, where it is **Materialize** |
| **Add Member** | **Add member…** on the team's group header, now with the *Materialize now* choice |
| **Orphaned agents** | nothing — see below |
| **Add `<role>` role** | nothing — see below |
| Orchestrator cards, missions and Sync | nothing — the BriefingPack model itself was removed |

Two things were **not** re-homed, deliberately:

**The "Orphaned agents" list.** An **orphan** was a member whose parent team no
longer existed. The page listed them in a warning block because otherwise they
were invisible and the only way to remove one was over SSH. That block was a
safety net for a bug, not a feature: orphans existed because deleting a team did
not reliably take its members with it. The cause is fixed — a team delete now
**takes its members with it**, materialized members and *not-initialised* stubs
alike, and a member that could **not** be removed (a busy container, a Matrix
user that would not deactivate) is named in the result instead of being silently
dropped. So there is nothing left for the list to show, and there is
**no replacement surface** anywhere. An orphan is not a working agent, which is why
the cleanup deletes rather than adopts: a member's prompt, skills and plugins are
all inherited from the team, so once the team is gone what remains cannot run as
intended. If an installation still carries orphans from before the fix, a
**System Admin** clears them with a one-off cleanup: `GET /api/agents/orphans`
lists exactly what would be removed and changes nothing,
`POST /api/agents/orphans/cleanup` removes them. It is **idempotent**, so running
it twice is harmless, and it is operator-invoked rather than automatic — this
platform does not delete agents without an explicit decision.

**The "Add `<role>` role" suggestion.** The platform used to guess which
loop-closing role a team was missing, by comparing the team against the process
templates, and offer a one-click add. The guess rested on an inference — a team
never records which template it came from — so it stayed silent on many teams
that really did have a gap, and where it did fire it called a role "missing"
that the team may have dropped on purpose. A suggestion you cannot check is
worse than none, so it is gone rather than re-homed. Grow a team with **Add
member…** above, and read the real gaps off the **Flow editor**, where an
unconsumed label or an idle gate is visible instead of inferred. Roles added
through the old button are unaffected and keep working.
