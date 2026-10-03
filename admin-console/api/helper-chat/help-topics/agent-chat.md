---
id: agent-chat
routes: ["/chats"]
title: Agent Chat
summary: The page where you talk to an agent — the agent list, the chat header, the composer and the right rail — plus the panels that decide when it wakes on its own, what it signals when a run ends and what it has learned.
seeAlso:
  - { label: "Flows", to: "/flows" }
  - { label: "Knowledge", to: "/knowledge" }
  - { label: "Create something new", to: "/create" }
  - { label: "Environment Templates", to: "/environment-templates" }
  - { label: "GitHub Event Log", to: "/github-events" }
askPrompts:
  - "Where did the old environments page go?"
  - "What is the difference between a loop trigger and a cron trigger?"
  - "Why is my trigger not firing while a loop is running?"
  - "What is the difference between Reset Session and Clear History?"
  - "How do I share a link to one specific chat message?"
  - "Where do I author outcomes — I can't edit them here?"
  - "What exactly happens when I retire a learning?"
  - "Why does switching the model provider restart the agent?"
  - "How do I point the agent at a file in its workspace?"
  - "What is the difference between an Agent Team and an access scope?"
  - "What is the difference between Disable, Reset to stub and Delete?"
  - "Why does one of my agents show as not initialised?"
  - "Where did the Agents page go?"
  - "Where did the orphaned-agents list go?"
  - "Where do an agent's skills, prompt and plugins come from?"
  - "How do I give a colleague access to one of my teams?"
  - "What is the difference between a Team Admin and a Team Member?"
  - "Why can't I remove the last Team Admin from a team?"
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

## Who wrote a message — the badge and the sides

An agent's room is shared: several people can talk to the same agent, and the
transcript names each of them. The small round badge in front of a human message
shows the **author's initials** — the first letters of the first two words of
their name, or a single letter for a one-word name — and hovering it (or tabbing
to it) reveals the full name. The agent keeps its bot icon and no name badge; the
icon already says *machine, not human*, which is the load-bearing distinction.

The **badge and the side answer two different questions**, and they are
deliberately not the same answer:

| | Question | Depends on |
|---|---|---|
| The **badge** | Who wrote this? | the author — never on who is reading |
| The **side** | Is this mine? | you, the viewer |

So **your own messages are on the right and every other person's on the left**,
next to the agent — and the same message shows the *same* initials to everybody
while sitting on opposite sides for its author and for a colleague. A human
message on the left keeps the human bubble colour, so it is still distinct from
an agent's bubble.

The name shown is the person's **display name** from their user record, falling
back to their login subject when that is empty. It is resolved when the
transcript is read, not frozen when the message was sent, so renaming somebody on
the Users page updates their initials on messages they sent months ago. There is
deliberately **no per-person colour** — the side and the initials carry it, and a
second weaker channel for the same information would only add noise. Two people
whose initials collide (*Anna Schmidt* and *Andreas Schulz* both give `AS`) are
told apart by the hover name.

### Messages with a neutral person icon

A message showing a plain **person icon** instead of letters has **no recorded
author**. That is not an error — it is every message sent before this feature
existed. The platform did not record which console user sent a chat message, and
that cannot be reconstructed afterwards, so those messages keep the right-hand
side they have always had rather than being relocated on a guess. For that older
content the right-hand side is therefore *not* a guarantee that you wrote it.
The same icon appears for a message posted into the room by some other Matrix
client, and for an author whose user record has since been deleted and whose
login name is no longer recoverable.

Trigger notices, finished-loop cards and any other automated entry are unchanged:
they carry no human badge and are not realigned.

## Linking to one message

Hovering a plain text message reveals a small **link** icon next to its
timestamp — click it to copy a URL that opens straight to that message,
scrolled into view and briefly highlighted, so you can point a colleague (or
your own future self) at exactly the line that matters instead of "scroll up
a bit." The icon only appears on ordinary messages; a quick-reply question, a
finished-loop card and a trigger notice don't offer one.

Opening the link jumps to the right agent's chat, fetches older history if the
message isn't in the currently loaded window, and scrolls to it — all bounded,
so a stale or made-up link can't make the chat fetch history forever. If the
message can't be found (deleted, or the link is wrong), the chat opens
normally and a brief "Linked message not found" notice appears instead of
failing silently or showing an error.

## The agent roles

An **Agent** is a **long-running Claude Code instance** with its own workspace
and session history. There are three roles, and the one an agent has decides
where its prompt and skills come from:

| Role | What it is | When to use it |
|---|---|---|
| **Agent** (standalone) | A single chat agent with its own system prompt. The prompt shapes its persona — a COBOL specialist, a code-review buddy, a release manager. Add cron / GitHub triggers later to make it run autonomously as well as answer messages. | One-of-a-kind agents that act on their own. |
| **Agent Team** | A squad of agents working a repository. It stores a system-prompt template and hosts no agent itself — **Add member…** on the team's group header spawns agents that share the prompt and environment but each get their own workspace and their own conversation. | Several copies of the same kind of agent — e.g. three reviewer agents in parallel. Start one from the **Create** launcher rather than by hand. |
| **Team Member** | One agent spawned from an Agent Team. Its system prompt, skills and MCP servers **inherit** from the parent team unless you flip a field from *Inherit* to *Custom*. Role, environment and parent team are fixed at creation. | You do not pick this role — it is assigned when you add a member to a team. |

> An **Agent Team** is *not* the same thing as an **access scope**. The scope is
> the older, coarser tenant every agent, environment and credential is stamped
> with, managed by a System Admin on the **Administration** page; an Agent Team
> is a squad of agents, and it is what sharing, membership and your own rights
> are keyed on.

**The three states a row can be in.** *Active* — running and ready to chat.
*Paused* — the workspace is kept, the process is stopped (this is what **Disable**
produces). *Not initialised* — a **stub**: it has its configuration and triggers,
but no workspace, no cloned repository and no running process. You get a stub
from a team created with **Provision agents now** left off, or from a
member added later with **Materialize now** unticked. **Materialize** in the
team's *Not materialized yet* section brings it to life.

## The agent list

The left rail lists every agent you can see, and clicking one opens its room —
except a team's own header row, which has no room to open (see below).

**Grouping and order.** Agents that belong to an Agent Team are grouped under
that team; standalone agents are collected under *Individual agents*. When every row
in a group shares one environment, its member rows stay single-line and drop
that environment from their own line; a member that deviates keeps its own
environment line. The team header's second line no longer repeats that shared
environment (it lives on the team's **Settings** tab) — it now names **who is
behind the team**: a **Private** badge when the team's only member is you, otherwise
everyone with access by display name — Team Admins first, then Team Members —
comma-separated (a long list folds to a trailing `+N`, with the full list on
hover). A team with no visible members shows no such line. The **chevron** on a group header is the only control that
collapses/expands it; clicking anywhere else on that row selects the team and
opens its **Settings** tab in the right rail instead — a team hosts no chat of
its own, so the middle pane shows a short explanation rather than an empty room.
Both the collapse state and your own ordering are remembered per user. Drag a
row by its grip to reorder, or move the focused row with **Alt+↑** / **Alt+↓**
if you would rather not drag. A **collapsed** team header carries an aggregate
**needs-attention** marker just left of the member count, so a folded team still
tells you *which* team wants you without expanding it: a solid-green dot when any
member has a reply awaiting you, and an amber pulsing dot when any member is
working — the same two states, and the same dots, the per-agent status dots use.
The quieter states stay hidden — idle, disabled, offline, and unread output from
a run you did not start (the hollow-green FYI) never roll up, so collapsing a team
keeps reducing noise. Expand it and the marker gives way to the per-agent dots
again.

**Finding an agent.** The team filter above the list (it reads *All agents*, a
team's name, or *N of M teams*) opens a panel with one checkbox per team plus
*Individual agents*: tick the ones to show. A search box narrows the entries,
**Select all** / **Deselect all** act on the listed ones, and the quick filters
(*Only my private teams*, *Teams I am a member of*, *… Team Admin*, *… regular
member*) replace the selection in one click. Your selection is saved to your
account; teams added later are shown by default. Reordering groups needs every
team shown. Next to it, the **eye** toggle is the *show disabled agents* opt-in: disabled agents
are hidden by default, because most of the time they are noise. Turning it on is
the only thing that widens what the list asks the server for.

**What a row tells you.** A row shows the agent's name, its environment (unless
it matches the team's shared environment, which the row then drops), and a
**status dot** that tells you what, if anything, the agent needs from you.

**The status dot — four colours, plus fill on green.** The dot is deliberately
about *what you need to do*, not which internal state the agent is in:

- **Green, solid — a reply awaiting you.** An unread response from an agent **you
  messaged yourself**. This is the only state the green counter next to *Agent
  Chat* in the sidebar counts.
- **Green, hollow (an outline ring) — activity, nothing needed.** Unread output
  from a run **you did not start** — a label, a schedule or an inbound event woke
  the agent. Glance at it if you like; it is never counted in the sidebar. The
  hollow-vs-solid difference is a shape, not just a shade, so it stays legible
  without relying on colour.
- **Amber, pulsing — working.** A run is in progress. The amber sidebar counter
  counts these.
- **Grey — idle or disabled.** Nothing for you to do: the agent is available (a
  past chat or a live session no longer shows a colour of its own), or it has
  been intentionally disabled.
- **Red — offline.** The agent's container is not running — a real problem.

A run started by *you* only shows solid green once it comes back; whether it was
you who last messaged the agent survives a page reload.

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
  whole team, **Add member…**, **Team settings…** (the same Settings tab a
  plain click on the header row already opens — this menu entry is the
  keyboard/no-mouse path to it), **Share…** (who may
  open this team — see *Sharing a team* below), **Export team
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

**A pooled role's live instances.** A role that spawns ephemeral
`<team>-<role>-i<item>` workers (an Agent Pool, configured on the Flows editor)
shows them nested directly under that role, in a collapsible **Instances (N)**
sub-list — instead of scattering them through the team as flat, indistinguishable
rows. It expands/collapses and remembers your choice the same way a team group
does, and stays empty (no sub-list at all) while the role has nothing live. When
the role has a **Max parallel instances** cap, the count reads against it, e.g.
**Instances (5 / 3)**; a warning icon marks a count over the cap (running
instances are not stopped, no new one starts until the count is below it). Each
instance row is an ordinary agent: its status dot follows the same activity poll,
and clicking it opens its own chat/session log exactly like any other member —
a row disappears once its instance is torn down. Its triggered runs and your chat
share one session.

**Adding an agent** is done from the page header, not the list. **New Agent**
(top right) hands over to the create launcher, where *Configure an agent
manually* — under **Advanced options** — opens the direct form; **Import Agent**
next to it takes an exported agent ZIP and asks for an id and a team before it
lands — leave the team on *Its own team* and the agent becomes a team of one,
like any newly created agent. If the exported id is taken, the dialog suggests
a free one and a display name ("<name> (Copy)") so the copy can be told apart
from its source. The imported agent starts right away and joins the list
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
*model · provider*. An agent inherits the model provider its environment
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

As the session fills, the chat also nudges you rather than leaving you to read
the number. Past **half** the window a dismissible hint suggests resetting the
session to save tokens — the whole conversation is re-sent every turn, so a long
one costs more each time; dismissing it keeps it gone for the current session and
it returns after a reset. Past roughly **three-quarters** a permanent warning
takes over, carrying its own **Reset Session** button (the same action as the
toolbar), and it stays until you reset. Both nudges are interactive-chat only —
they don't appear while you are watching an autonomous or triggered run.

**About this chat** (the **i**) opens the detail behind that one-line indicator:

- **About** — the agent's environment and each repository it has cloned,
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

**Read-only as a System Admin.** A System Admin sees every team's chats but
writes only in teams they belong to. In any other team the composer is
read-only (Stop still works); **Open team sharing** in the hint leads to the
team's Sharing tab, where you can add yourself.

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
resolves that path itself with no upload. When your own message references an
image this way, it shows as a small inline thumbnail instead of the raw
`@<path>` text — click it to open the same fullscreen preview the Workspace tab
uses. This only happens for messages **you** send; an agent's own reply never
gets a thumbnail.

**Answering a question.** When a run pauses to ask you something, the question
arrives as a card with the options as buttons — click one instead of typing it.
A card with several questions walks you through them one at a time and sends a
single consolidated answer at the end, so the agent resumes once. Only the newest
unanswered card is clickable; once a later message arrives it goes inert, and
your earlier choice stays marked.

## The right rail

The rail on the right holds everything about the agent that is not the
conversation. Toggle it with **Cmd/Ctrl+Shift+L** or the chevron in its tab
strip; it can also collapse to a strip of icons. Three of its tabs are
conditional: **Events** (agents with a GitHub-event trigger), **Outcomes**
(team members) and **Settings** (if you may manage the agent).

This rail is an **ordinary-agent** surface. Selecting a **team** in the left
list — its own row, not one of its members — does not open a narrower version
of it: it replaces the whole area right of the agent list, chat column and
rail together, with the team's configuration as **one full-width surface**.
There is no separate chat pane (a team hosts no conversation of its own, so
none of Sessions, Workspace, Triggers, Outcomes or Knowledge apply) and this
surface offers no collapse or width control of its own — the left list's own
divider is the only way to resize it. It has no shortcut of its own either:
Cmd/Ctrl+Shift+L does nothing while a team is open, and switching back to a
member restores the rail exactly as you left it (width and open/collapsed).
Every entry point lands here alike — clicking the team's row, **Team
settings…** on its row menu, and a bookmarked `/chats/<teamId>` URL. A team you
may see but not manage gets the same surface with a plain notice instead of an
editable form; nothing about it becomes editable that was not editable before.

### Sessions — watching a run

The **Sessions** tab lists this agent's runs, past and current; its badge counts
active ones. Pick a run to see its **session log** — every step the agent took —
with its cost and context use. A live run streams in and can be stopped here. A
message's **Show in session log** icon jumps to its run.

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
file, download it, and see images inline — and download a whole **directory** as
a single ZIP from its own row (paths kept relative to that directory; not offered
on the workspace root or on a `/context` folder). Each file row also offers
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

**HTML files** (`.html`, `.htm`) open as source code. The **Rendered** toggle
shows the page itself, but it asks first, **every time**: the page was written
by an agent and may contain harmful content, so nothing runs until you click
**Show preview**. The dialog also has an **Also load external resources**
checkbox. It starts unticked and only applies to this one opening. Unticked,
inline styles, scripts and embedded (`data:`) images work, but external
scripts, stylesheets, fonts and images do not load, and scripts cannot fetch or
send anything. Ticked, it may load from any
host. Either way the page runs isolated from Agent Studio: it cannot read your
session, the console or other agents' data. A banner above the preview says
so, and also says whether external resources are on. Because of that
isolation the page has no real browser storage; it gets a temporary in-memory
stand-in instead (local and session storage, cookies), so pages that remember a
setting such as a light/dark theme still render and work. That storage is
empty every time you open the preview and is gone when you close it — nothing
is kept between openings or shared between files. Do not enter passwords
or credentials into a preview. Relative links to other workspace files (images,
stylesheets) do not load. A page that navigates away (a link or a redirect)
closes the preview back to source, but the address it navigated to has
already been requested, even with external resources off. A page stuck in an endless loop can freeze
the tab until you reload. Files above **5 MB** offer **Download** instead of a
preview. The same preview is available in the expanded viewer and when you
open a file referenced in chat.

### Repositories: inherited, and this agent's own

The Workspace toolbar's **repositories** button (and the same panel in
**Settings**, next to *Sync repositories*) lists every repository this agent
has, and is where you attach one more.

Repositories normally come from the agent's **environment**, which means
*every* agent in that environment gets them. Those rows are marked
**From Environment** and carry no remove action: change them on the
environment, where the decision belongs. Often, though, only one agent needs one
more repository — a reference codebase to read, a second service it has to
touch, a documentation repo. **Add repository** attaches one to **that agent
alone**: it is marked **This agent only**, the environment record is not
touched, and no sibling agent gains it, has its prompt changed, or is restarted.

What you fill in is the same form the environment uses — URL, branch, SSH key,
read-only — including the live reachability check, which is **advice, not a
gate**: an unreachable URL still submits.

Four things are worth knowing before you use it:

- **There is no credential of its own.** The clone uses the existing SSH-key
  registry or the environment's GitHub token, and nothing else. A private HTTPS
  repository in an environment with no token is refused up front, with the
  reason, rather than failing obscurely later. Attach it by its SSH URL and pick
  a key instead.
- **One directory per repository.** The clone path is derived from the URL, so
  `org-a/tools` and `org-b/tools` both want `./tools/`. If that name is already
  taken — by an environment repository, by another attachment, or by an ordinary
  folder the agent created — the attach is refused and nothing is cloned. There
  is no automatic renaming.
- **The attachment is persistent.** It survives a container respawn and a
  workspace reset, and is re-cloned like an environment repository would be — so
  the agent never loses a repository its prompt still names.
- **Removing it deletes the working copy**, and the confirmation says what that
  costs: how many uncommitted changes and unpushed commits are in it, by count,
  or that it is clean. Removal is refused while the agent is running a session,
  because those are files the run may be using. Attaching while it runs is fine
  — it only adds a directory — but the agent is told about the repository from
  its **next** run on, not mid-run.

Cloned repositories show up in **Git** mode like any other, with the same
switch / update / discard actions.

### The other tabs

**Triggers**, **Events**, **Outcomes**, **Knowledge** and **Settings** are the
remaining tabs; each has its own chapter below.

## Triggers — when the agent wakes on its own

The **Triggers** panel is the per-agent subscription list. Every type answers the
same question, "what wakes this agent", and every one of them delivers a
**wake instruction** — the prompt the agent is handed when it fires.

| Type | Wakes the agent when… |
|---|---|
| **Cron (recurring)** | a 5-field schedule (`Minute Hour Day Month Weekday`) comes due. If the previous run of *this* trigger is still going, the tick is skipped rather than queued. |
| **Once (one-shot)** | a specific date and time is reached. It then deletes itself — a reminder, not a schedule. |
| **HTTP webhook** | something outside the platform sends `POST /hooks/<agentId>/<triggerId>` with the trigger's own `X-Hook-Secret` — a GitHub webhook instead takes the secret as its **Secret** (verified via `X-Hub-Signature-256`). Each trigger carries its own generated secret; there is no open mode. Used by CI pipelines, monitoring, GitHub webhooks. |
| **GitHub event** | the built-in poller sees a matching event on a repository of the agent's environment (about every 30 seconds). The full event payload is appended to the prompt as JSON. Needs a GitHub token on that environment. |
| **Data flow (agent dependency)** | a teammate pushes to the team repository — the committed work *is* the hand-off. Under the hood this is a GitHub `push` subscription with a marker. |
| **Plugin event** | a granted plugin's broker reports something (a Jira status change, say). Two filters narrow it — see *Which event vs. Only when* below. |
| **Loop (re-run until done)** | you start it. It is not a subscription (see below). |

### Cron and once: time zone and status

Cron runs in **Europe/Berlin** (your time is shown if it differs); a once time
is your local time; a past one is flagged and runs at the next sync (about a
minute), then is removed. Rows show next/last run, or a red warning if the agent
cannot schedule the trigger. The container clock can drift on a Podman VM; a
forward correction fires whatever it skips.

### A GitHub event fires regardless of who caused it

A GitHub-event or data-flow wake does **not** know whether the change is relevant
to this agent, and it fires for **the agent's own pushes** too, unless a push
trigger's **Pushed by** filter names the producers (a Flow-editor data-flow
hand-off names its upstream). So the wake instruction should tell the agent to
`git pull`, decide whether the change concerns it, and answer `[PASS]` when there
is nothing to do. Beyond that filter there is **no source filtering** — loop
protection is frequency-based (throttle and burst digest), so relevance is the
agent's job.

A label listener can additionally **claim** its wake label on fire (`ready` →
`ready:wip`), which makes work-in-progress visible on GitHub and is rolled back
automatically if the run fails.

Hand-offs between several agents are much easier to wire and read as a graph in
the **Flow Editor** than as individual triggers here.

### Plugin event — Which event vs. Only when

A plugin-event trigger has two filters that are easy to confuse, because both
look like "when does this fire":

| Field | Answers | Comes from |
|---|---|---|
| **Which event** | *what kind of change* happened — the plugin's own event **name**, e.g. `status_changed`. Blank = every event this plugin sends. | the list the plugin declares; the form offers it as a drop-down |
| **Only when…** | *which of those changes* should wake this agent — conditions on the **fields of the event chosen above**, e.g. `toStatus = Ready for Dev`. Every condition must equal the field exactly (case-sensitive). No conditions = every event above wakes the agent. | the fields of the chosen event (the sub-heading names it: *fields of `status_changed`*); the form offers them with an example |

The two are nested, not separate: an event is the category ("an issue moved to
another status"), a condition picks *within* it ("…and the status it moved into
is `Ready for Dev`"). With *Any event* chosen the picker offers the fields of
every event the plugin declares; a condition on a field a given event does not
carry simply never matches that event — so *Any event* + `toStatus = …` behaves
exactly like `status_changed` + `toStatus = …` until the plugin sends a second
kind of event.

The mistake to avoid: a **value** (a Jira status, a project key, an author) is
never an event name. Typing `Ready for Dev` into *Which event* creates a listener
that silently never fires, because no plugin sends an event called that — the
form flags such a value as *not an event this plugin declares*. The status
belongs in *Only when…* as `toStatus = Ready for Dev`.

Which events and fields exist is the plugin's business, not the platform's:
each plugin declares them, and its own help topic (ask the "?" on this page
about the plugin by name) explains what each one means and when it fires. A
plugin that declares nothing falls back to free-text fields — its help topic
then names the events and fields.

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
  re-applied server-side (with no teammate in the team, the agent checks itself). Pick *the flow checks the hand-off* when each try ends
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

## Events — what reached the agent from GitHub

GitHub events that reached this agent's triggers (up to 7 days) and the outcome — delivered (**Session** opens the run), digested or
dropped with the reason. On a *wake-already-armed*, *throttle* or
*internal-dedup* drop an agent manager can **Fire again**: the agent is woken
now with the same prompt. Refused if the item is merged/closed, the wake label
is gone, or it was already re-fired.

## Outcomes — what the agent signals when a run ends

An **outcome** is the signal a run ends with: a *condition* in plain language
("the review found blocking problems") plus what the agent does about it.

There are **two ways** an outcome reaches a teammate:

| | How the next agent learns about the work |
|---|---|
| **Label** | The outcome sets a label, and whichever teammate subscribes to that label wakes up — the **Outcome → Label → Consumer** hand-off. The outcome is one half of it; the other half is who subscribes. |
| **Direct hand-off** | The outcome names the teammate itself, and the platform wakes them — no label, no issue, no pull request, nothing on GitHub. The row reads *wakes &lt;agent&gt; (direct hand-off)*, and its action reads *hand off directly to &lt;agent&gt;*. |

So a label is **not** the only thing that wakes the next agent, and an outcome
carrying only a direct hand-off is fully wired — the [Flows](/flows) topic
describes both arrows on the canvas. An outcome may also carry both at once, and
then both consumers are listed. A hand-off whose target is not an agent of this
flow, or whose target has its hand-off input switched off, is called out as such
instead: nothing is woken, and the Flow Editor's lint list explains why.

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

Its **role** is fixed at creation and is not shown here — the agent's role is
what its list icon shows. The **environment** binding itself is fixed too. On
any other role the environment's name just sits under the agent's name in the
list (on a team, once per group header), with no edit surface here — a
**team** agent's own configuration is a different surface entirely (see *The
team's configuration tabs, in detail* below).

Three things behave differently from an ordinary form:

- **Unsaved edits are kept, not confirmed away.** Switch to another agent and
  back and your draft is still there behind an *unsaved changes* banner, with a
  Discard if you did not want it. A click in the agent list is never blocked by
  a modal.
- **Some changes apply immediately**, without Save — plugin grants and context
  folders have their own endpoints. A context-folder change re-provisions the
  container, which ends the run you are watching, so it asks first.
- **The tab follows the open chat**, but a rail menu can point it at a
  *disabled* agent instead — the one way to reach a chatless agent's settings.
  A **team**'s settings work differently: they are not reached through this
  tab at all, but through the team's own full-width surface (see *The right
  rail* above), presented as **one row of tabs** — General, Repositories,
  Model provider, Toolchain, MCP servers, Additional context, Skills, Plugins,
  all at the same level and always in that order, addressable by
  `?tab=<name>` in the URL (an unrecognised or missing value opens General).
  Selecting its row is what opens them. Either way, the form is hidden
  entirely when you may not manage the agent, so it is never a control the
  server would refuse.

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

### The team's configuration tabs, in detail

A team's whole configuration is **one flat row of tabs** — there is no
grouping label and no tab nested inside another. **General** carries the
read-only ID, the Display Name and the Team Default Prompt. Five tabs edit
the bound environment's own record in place — the same record
`PUT /api/environments/:id` always has, just reached from here instead of a
standalone page, with no ownership/team picker (the environment already
belongs to this team):

| Tab | What it does |
|---|---|
| **Repositories** | Zero or more repos, cloned into a member's workspace when that member is created. Each row can bind its own SSH key for a private SSH URL; a private HTTPS URL needs the *GitHub Token* select instead. Selecting an SSH key on a row whose URL is a `github.com` HTTPS (or bare) URL rewrites it to its canonical `git@github.com:org/repo.git` SSH form so the reachability check and clone use the key — non-github and already-SSH URLs are left as typed. Mark a repository *Read-only* to clone it for reference only — it is still cloned, but members are told not to commit or push to it. |
| **Model provider** | Optional override — members start on this provider and its default model instead of the global `.env` fallback. |
| **Toolchain** | Optional — which container image members are spawned from, picked from the System-Admin-registered list. Absent means the default image. |
| **MCP servers** | Optional server + credential pairs from the MCP registry, applied to members on save, from their next turn. |
| **Additional context** | Optional text appended to every member's `CLAUDE.md`; a change is written into existing members' `CLAUDE.md` on save, from their next run. |

**Skills** and **Plugins** carry the team's own grant — the same fields the
*What the form fields control* chapter describes for an ordinary agent —
sitting at the same level as everything else rather than as separate sections
below a box; a team with nothing installed or configured still shows all
eight tabs, each explaining its own empty state rather than disappearing.

Saving General or Skills uses this form's own Save button; the five
environment tabs and Plugins keep their own, unrelated save/apply behaviour
exactly as before — switching tabs never loses an edit in progress, and the
selected tab survives a save.

**A repository change reaches only members created afterwards** — cloning
happens once, at creation. To bring already-running members up to date, saving
a repository change offers to propagate it (see the next chapter); nothing here
re-clones or re-fetches on its own.

### Bringing existing agents up to date

Saving a repository change on an environment that already has agents offers to
bring them up to date — add a new repository, drop one, or repoint an existing
one's URL/branch, and the offer summarises exactly what changed before doing
anything. It only **acts on a clean, fully-pushed clone**: uncommitted changes,
unpushed commits, a detached head or an unrecognised remote are reported as a
skip with the reason, never overwritten. **Nothing already cloned is ever
pruned** — removing a repository from the environment leaves that member's
existing clone alone; you can always recover it from the workspace browser.
Declining the offer is safe — the environment save already happened, and the
same propagation is one click away later.

## Sharing a team — who can open it and who can change it

A team is **private to the people it has been shared with**. **Share…** on the
group header is where that list lives: it is the whole surface, and it needs no
System Admin and no other page.

Two roles, and the difference is not subtle:

| | **Team Admin** | **Team Member** |
|---|---|---|
| Open the team, chat with its agents, read its session history and workspace | yes | yes |
| See who else has access | yes | yes |
| Change agents, prompts, triggers, plugins, team settings | yes | **no** |
| Add, re-role or remove people | yes | **no** |

**A Team Member sees the list read-only.** The entry is not greyed out for
them — reading who is on your own team is a member's right — but the role
picker, the Add row and the Remove buttons are not there, and the panel says
so. This is parity with the server, not the protection itself: the write
endpoints check the same rule independently, so a hand-made request is refused
with a 403 whatever the buttons look like.

**The picker searches everyone in the organisation.** People are findable by
name and email; the private thing is the team, not the person. It shows a
display name and an email address and nothing else — never whether somebody is
a System Admin, never their GitHub handle — so a System Admin turns up in the
results as an ordinary colleague. Only people who **already have an account**
are offered: there is no invitation-by-email here, and a colleague who has never
signed in has to be created on the **Users** page by a System Admin first. That
is once per person, not once per team.

**The last Team Admin cannot simply leave.** Removing them — or demoting them to
Team Member — would leave a team nobody can administer, so the panel asks who
takes over and does both in one step: the successor is promoted in the same
write that removes or demotes the outgoing admin, so there is no moment in
between. The successor has to be somebody **already on the team**, because
naming an outsider would be a second, unaudited way in. If the last admin is
also the team's only member there is nobody to hand over to, and the panel says
that instead of offering an empty picker — add somebody first, or delete the
team.

**Removing somebody removes their access, not their account** and not anything
they did: their user record, their personal credentials and the team's history
are all untouched. They simply stop seeing the team.

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

## Where the old environments page went

There used to be a general-purpose page listing every environment on the
platform, open to any user. It was removed (#2170) once its
two audiences each had their own home: an ordinary team edits its own
environment right here, in the **Settings** tab's **Environment**
section above; a System Admin curates reusable **Environment Templates** — a
catalog a new team can start from, never a live-shared binding — on its own
System-Admin-only page. Old `/environments` links land here.

| What it offered | Where it is now |
|---|---|
| Editing a team's own environment | this page's **Settings** tab, **Environment** section |
| The **Global** checkbox (any team could select the record with no admin action) | retired — see below |
| A System Admin's shared catalog of reusable environments | the **Environment Templates** page (System-Admin-only) |
| The Toolchains registry panel | moved to the Environment Templates page |

**The Global checkbox is gone, not merely hidden.** It made an environment
*directly usable* by every team with no admin involvement — a live, shared
binding. Its replacement is the opposite in kind: a **template** is a curated
copy source. A team that starts from one gets its own, independent
environment, seeded once from the template's repositories, MCP pairings,
model provider, toolchain and additional context — never its credentials, and
never a live pointer back to the template itself.
