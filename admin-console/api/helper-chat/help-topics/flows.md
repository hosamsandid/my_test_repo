---
id: flows
routes: ["/flows"]
title: Flows
summary: Design and run flow graphs — teams of agents wired together so work hands off automatically through outcomes, labels and human gates.
seeAlso:
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Create something new", to: "/create" }
  - { label: "Agent Team Wizard", to: "/team-setup" }
  - { label: "Environment Templates", to: "/environment-templates" }
  - { label: "GitHub Event Log", to: "/github-events" }
askPrompts:
  - "How do agents hand work over to each other in a flow?"
  - "What is the difference between a Draft and a live Team?"
  - "What is the difference between a human gate and a brake?"
  - "Which hand-off kind should I pick — label, PR channel, issue channel or artifact?"
  - "How do I make the flow wait for a person to approve?"
  - "Why is the Create team button greyed out?"
  - "Why are my agents 'Not initialised' after I created the team?"
  - "What do the Anomalies and Improvements panels tell me?"
---

## What Flows is

Flows is where you design and run **flow graphs**: teams of agents wired
together so work hands off from one to the next automatically. Nothing here
calls an agent directly — you describe *who reacts to what*, and the platform
derives the wiring.

There are two kinds of thing in the left list, and the difference matters:

- A **Draft** is a design. It is a document, not a team: no agent exists, no
  repository is cloned, nothing runs. You can rewrite it freely.
- A **Team** is live. Its agents exist, and an edit to its wiring re-derives
  triggers on the running agents as soon as you save — which is why a live
  canvas wears an amber **Live team** badge and a warning strip, and why
  **Edit as draft** exists: it copies the team into a draft you can experiment
  in safely.

On a live team, a role that auto-scales (an Agent Pool) is still one box: the
temporary copies it starts per item are not drawn as boxes of their own, and
Export, Edit as draft, lints and Copilot see only the roles. While copies are
live, the role's box carries a small **n running** badge (hover lists them) and
its details panel lists each one, e.g. *#71 · running*, *#72 · waiting for PR*,
*#73 · timed out*.

**Create team…** is the one-way step between them, and it is the accent-coloured
button set apart at the end of the draft toolbar — the design → team step, so it
is the one thing on that row that is not an editing action. It was
**previously called Materialize** — its tooltip says the same, so anyone who
learned the old word can still find it. It reads the draft and creates the real
thing: one Working
Environment, one team agent, and one member per role with its own prompt and
triggers. The dialog's **Provision agents now** checkbox is **off** by default,
so members are created as **stubs** — they appear in the team with their prompts
and triggers, but no repository is cloned and nothing is running until you start
one. A stub is badged *Not initialised* in Agent Chat, under its team's
collapsed *Not materialized yet* section, where **Materialize** finishes it into
a running agent — that is the member-level act, and it keeps its own name. Tick
the
box and every member is provisioned right away — slower, because each
provisioning clones the repository, and a flow can have dozens of members.

Two things gate the **Create team…** button: a draft needs at least one agent,
and while a Copilot proposal is on screen the structural buttons pause, because
the canvas is previewing the proposal rather than the draft underneath. The
draft's own status line, under the toolbar, says which of those applies rather
than making you hover the greyed-out button to find out.

Creating a team does not consume the draft. The design stays in **Drafts** and is
reusable; editing it afterwards does not change the team you created, which is
what the confirmation says when the creation finishes.

An environment with no repository still works — the team's agents can chat and
use their skills — but GitHub hand-offs (pull-request and issue channels) are
not available to them.

## The flows left list

The left list is how you choose what the canvas shows. It has two sections:

- **Teams** — the live flow graphs, one row per Agent Team, with its Working
  Environment underneath. Selecting one opens it in live mode.
- **Drafts** — the designs you are still working on, with the number of agents
  in each, and whether each one is **private** or **shared** (see *Sharing a
  draft* below). You see your own drafts and the ones colleagues have shared
  with you — not everyone's. A draft can be deleted from its row; a team cannot
  (it removes running agents): use **Delete team…** on its group header menu in
  Agent Chat, or **Administration → All Teams**.

The list can be collapsed to give the canvas the full width, and the divider
between it and the canvas can be dragged; both are remembered.

The **filter** at the top of the list narrows it to the flows you care about —
the same control as the agent list filter in Agent Chat. Collapsed, it reads
**All flows**, the one flow's name, or **N of M flows**; click it to open the
panel (Escape closes it). The panel lists every team and draft under **Teams**
and **Drafts**, each with the same second line as its row (environment, or the
draft's agent count and sharing), so two flows with the same name stay apart.
Tick or untick flows, search by name (searching never changes what is ticked),
and use **Select all** / **Deselect all** on the listed flows. The quick filters
replace the selection with a preset you can then adjust:

- **Only my private flows** — teams where you are the only member, and your own
  unshared drafts.
- **Flows I am a member of** — teams you belong to in any role, and every draft
  you have access to (your own and the ones shared with you).
- **Flows where I am Team Admin** / **…a regular member** — teams by your role;
  drafts have no roles, so they never match these.

Membership means exactly what it means in Agent Chat. A System Admin sees flows
they are not a member of; those match no quick filter. The quick filters are
greyed out until your memberships have loaded.

The list then shows only the ticked flows. A section whose flows are all hidden
says so, and with nothing ticked at all the list points you to the filter. The
choice is saved for your user (separately from the Agent Chat filter), so it
follows you to other browsers. It remembers what you *hid*: a flow created or
shared with you later appears automatically, as does a renamed draft. Opening a
hidden flow — from a link, **New flow**, **Create team…** or when the page
restores your last flow — ticks it back in, so the open flow is always in the
list.

There is no third section. Earlier versions listed a read-only **Role
templates** blueprint and a **BriefingPack flows** source; both are gone, and a
bookmark pointing at either falls back silently to no selection rather than to
an empty pane. The shipped role templates are still browsable — on the
**Agent Templates** page, not here.

A link to a team or draft that does not exist — an old `/process/<team>`
bookmark, a deleted flow, or a draft that was never shared with you — opens
the Flows page with **Flow "…" not found** (or **Draft "…" not found**) in
place of the canvas, naming the id from the link. **Back to Flows** returns to
the empty selection; the list on the left works as usual.

The actions that *create* something live in the page header at the top right,
not in the list, so they stay reachable while the list is collapsed:

- **New flow** — an empty draft, opened straight in the canvas.
- **Describe flow…** — hand the Flow Copilot a plain-language description and
  let it propose the whole graph (see the last chapter).
- **Import** — read a flow back from a portable JSON bundle. An imported bundle
  opens as a **read-only preview** first; *Continue as draft* turns it into
  something editable, *Create team…* creates the team directly — the same
  button, label and tooltip as the one on the draft toolbar.
- **Import packs** — a migration aid, not a create action. It reads a legacy
  BriefingPack directory out of an agent's workspace and lays it out as an
  editable draft. If you have never used BriefingPacks, skip past it.

**Export** (on the canvas toolbar) is the other half of Import: it writes the
current flow to a portable bundle with no repositories and no secrets in it, so
a design can be shared or version-controlled.

**What a role takes with it.** An export, *Edit as draft*, a shared draft and
*Create team…* all keep each role's own settings: its **prompt mode**
(inherit, additional or exclusive) and its own prompt text, together with the
flow's **team prompt**. Also kept: the **model** pin, the **memory limit**, the
PR/issue flags and the **Scaling** setup (workspace and work items included).
What stays behind is everything that belongs to a team's infrastructure:
repositories, context folders, environment variables, the model provider, MCP
servers, skills and plugins.

When you create a team from the bundle, a pinned model is used only if the new
team's model provider offers it. Otherwise you get the warning *"model X not
available in provider Y — using default"*. A memory limit above the platform
ceiling is lowered to the ceiling, also with a warning. The import preview
warns when a role set to *inherit* meets a flow that has no team prompt.

In a draft's node inspector you can set a role's **prompt mode**, **model** and
**memory limit**. Leave the model or memory empty to use the default. On a live
team the inspector shows the memory limit, the effective limit and where that
limit comes from. A change applies the next time the agent's container starts.

**Every row in the list has a context menu** — right-click it, press the `Menu`
key (or `Shift+F10`), or use the `⋮` that appears when you hover. A **draft**
offers **Create team…** first and set apart, then Rename…, **Share…**, Export…
and Delete draft; a **team** offers Edit as draft, Export… and Open in Agent
Chat. This is where renaming and sharing a draft live besides the flow header,
and it is the one place *Create team…* is reachable without opening the draft
first.

Your last selection is remembered per user and restored when you come back. A
flow that has since been deleted falls back silently to no selection rather
than to an error.

## Sharing a draft

**A draft belongs to the person who created it and is visible only to them
until they share it.** The Drafts list marks each row *private* or *shared with
N people*, and names the creator of a draft you did not create yourself. A
System Admin sees every draft.

**Share…** in the draft's row menu opens a panel listing everyone who currently
has access, and a picker of the colleagues you can add. It offers existing
accounts only — there are no invitations — and shows each person by display
name and email, nothing else.

The picker is a checklist, so you can share with many colleagues in one step:
type in the filter box to narrow the list by name or email, tick the people
you want (or use **Select all**, which picks only the people the filter
currently shows; **Clear selection** starts over), then press **Share with N**.
The whole selection is shared at once or not at all: if someone you ticked has
had their account deleted in the meantime, nothing is shared, the panel says
so and refreshes the list.

**Visible to everyone.** The switch at the top of the panel makes the draft
readable by every platform user — today's and anyone added later. Turning it
on asks for confirmation first; turning it off takes effect immediately and
leaves the access list exactly as it was. Readers who reach a draft only this
way see it in their Drafts list marked *Visible to everyone · read-only*, and
can open, export and create a team from it, or use **Duplicate to my drafts**
to get their own editable copy. They cannot edit, rename, share or delete it,
and they do not count towards the access list. The setting belongs to the
stored draft: it is not part of an exported file and an import never sets it.

**Everyone you share with becomes a full equal.** There are no roles, no
read-only mode for them and no privileges kept back for whoever created the draft.
Anyone with access can:

- open, edit, rename and export it,
- create a team from it,
- share it on with someone else,
- remove anyone from the access list — **including you**,
- and delete it outright.

So **sharing a draft is a one-way act of trust, not a lend.** If that is more
than you want to hand over, export the draft and send the file instead: an
imported bundle is a separate draft that belongs to whoever imported it, and
carries no access list with it.

Two rules follow from the equality:

- **The access list can never be emptied.** The last remaining person cannot
  remove themselves; the panel says so and points at *Delete draft*, which is
  what they actually mean. Anyone who is not the last **can** remove
  themselves — that is how you leave a shared draft, and it needs no separate
  button.
- **Deleting a draft is confirmed, and the confirmation names the other people
  who will lose it.** Under equal rights that dialog is the only thing between
  a mis-click and someone else's work.

Two things sharing does **not** do. It does not carry over when someone
**creates a team** from the draft: the team belongs to whoever clicked *Create
team…*, so if a colleague materialises a draft you shared with them, the
resulting team is theirs and you will not see it. And it does not add any
locking — several people editing one draft at once is now likely, and the last
save still wins.

When someone deletes a draft you have open, or removes your access to it, your
next save says so plainly rather than failing silently. If a person's user
record is deleted, they are dropped from every access list and the drafts stay
where they are; one whose list would be left empty is kept and stays reachable
by a System Admin, rather than being destroyed as a side effect.

## The canvas

The canvas is the flow itself. It draws these kinds of node:

- **Agents** — the members of the team. Click one to open its inspector.
- **Human roles** — named people who act in the flow (see the gates chapter).
- **Labels** — the tokens work hands off on, drawn between the agent that sets
  one and the agent waiting for it.
- **Gates and brakes** — the two places a person is in the loop. A gate is
  drawn on the edge in red: the flow stops there until someone acts.
- **GitHub** and **External system** — two source nodes standing for the world
  outside the flow. Nothing runs in them; they are where a repository event or
  an inbound webhook enters the graph, and dragging from one is how you wire
  those (see the next chapter).

**Every edge is clickable**, and what opens depends on what the edge is — a
label hand-off opens its own editor, a channel opens the channel form, a
parent/child edge opens the hierarchy form. Dragging from one node onto another
is how you create an edge; the chooser that opens is the next chapter.

The layout is computed, not hand-placed: a layered DAG that breaks rework
cycles, puts each node as late as its dependencies allow, reduces crossings and
aligns nodes into columns. Parent/child groups are drawn as a fan of siblings.
You cannot drag a node to a new position — you change the *layout* by changing
the flow (or by assigning stages, below).

The small control row over the canvas is view-only and changes nothing about
the flow: **Fit** the whole graph to the view (above the legend, so the legend
never covers a node), **Expand all** / **Collapse all**
agent nodes, flip the flow direction between top-down and left-right, show or
hide **archived** agents, and turn **stage** banding on or off.

The rest of the toolbar is the editing surface: **Add agent**, **Add human**,
**Stages**, **Labels**, **Copilot**, **Export**, plus **Anomalies** /
**Improvements** / **Edit as draft** on a live team. On a draft, one button is
deliberately not an editing action: **Create team…** sits last in the draft
group behind a separator and carries the accent colour, because it is the exit
from the design rather than another way to change it. Buttons that do not apply
to the current scope are not shown at all, and a button that is disabled says
why on hover.

On a live team, **Add agent** has a **Materialize now** checkbox, **off** by
default: the new agent is created as a **stub** — prompt and triggers only, no
repository cloned, nothing running — so sketching in another role stays fast.
It appears under *Not materialized yet* in Agent Chat, where **Materialize**
provisions it later. Tick the box to provision it right away; the button reads
*Add agent (stub)* while it is off, and a note after adding says which happened.

## Wiring hand-offs: the edge chooser

Agents do not call each other. An agent finishes with an **Outcome**, the
outcome sets a **Label**, and a **Consumer** agent that was waiting on that
label wakes up. That *Outcome → Label → Consumer* chain is what most arrows on
the canvas are.

One kind of arrow skips the label: a **direct hand-off**, where an outcome wakes
a named teammate inside the platform with no label, no issue and no pull
request. It is still an outcome on the producer — it just names its consumer
instead of setting something the consumer listens for.

When you draw an edge between two agents the chooser asks the question in those
terms — *how does the downstream agent learn about the upstream agent's work?*
If the upstream agent already has an outcome that fits, that one is offered
first and marked **recommended**, and picking it pre-fills the form instead of
asking a second question.

Dragging from one agent to another offers these:

| Kind | What it does |
|---|---|
| **Label hand-off** | An outcome of A sets a label that wakes B. The default, and what most arrows are. |
| **Hand off directly** | A wakes B inside the platform — no label, no issue, no pull request. For pure coordination that has no natural home on a work item. |
| **Issue channel** | A opens an issue that wakes B (optionally routed via a label / human approval). |
| **Pull-request channel** | A opens a pull request that wakes B (optionally routed via a label / human approval). |
| **File artifact** | A produces an artifact that B consumes, matched by logical name rather than file path. Leave the name empty for a plain **dependency** — B is then simply woken when A pushes. |

One more sits under a collapsed **Structure** group, because it is placement
rather than hand-off: **Parent / child**, where A groups B as a child and B
inherits its parent's stage.

### Label hand-off or direct hand-off?

The three hand-off mechanisms are not redundant, and the question that separates
them is not speed or reliability — all of them are delivered through the same
queue. It is **what a human can see afterwards**.

- Pick a **label hand-off** when a person should be able to read the state off
  the issue or pull request. The label *is* the human-readable process state.
- Pick a **direct hand-off** when there is no label worth inventing and no
  artifact to hang the step on. Nothing appears on GitHub at all; the event log
  is the audit trail.
- Pick an **issue** or **pull-request channel** when the artifact itself is the
  hand-off, and the consumer reacts to the thing A opened.

A direct hand-off has some deliberate limits. Its target must be another agent
**on the same team** — never a person, because a hand-off is delivered to the
target's queue and a human role has none, and never the producer itself. Unlike a
label, which always travels through GitHub, a direct hand-off is delivered by
the platform itself.

The dialog offers a **note** — a sentence about what you are handing over. Two
things are worth knowing about it. It reaches the consumer as *context to
check*, not as instructions: what the consumer actually does on a hand-off is
set by its own wake instruction, which the platform derives for you and lists in
its Triggers tab as **Direct hand-off from …**. And that instruction is one per
agent, not one per incoming arrow — so several teammates handing off to the same
agent all wake it the same way.

**Which tiles you see depends on where you dragged from.** The list above is
what an *agent* source offers. Two more kinds hang off the pseudo-nodes on the
canvas rather than off an agent:

- **GitHub trigger** (from the **GitHub** source) — B wakes on a repo event
  (issue opened, PR opened, push, …) or on a label, including labels a human
  sets. This is the one dialog that covers both raw events and approval gates.
- **Webhook** (from the **External** source) — an outside system such as CI
  wakes B with an HTTP call.

The chooser is direction-aware. Drawing an edge **to** a human role opens *"P
reviews A's work"*; drawing one **from** a human role opens *"P approves → B
wakes"*, and offers to wire the rejection path back in the same step. You never
have to translate a person into a GitHub channel by hand.

You do not have to drag at all: the Routing tab's **+ Add input** offers the
same vocabulary from the consumer's side, plus two kinds that only make sense
there — **Label applied** (B wakes when a given label is set, by an agent or a
person) and **Schedule** (a recurring cron or a one-shot time).

**An artifact is matched by name, not by path.** The producer records it, the
consumer looks it up — so a re-instantiable agent writing to a different
directory still hands over correctly. And an artifact hand-off is a *wake*, not
a start-gate: nothing blocks a downstream agent from running, it is simply told
there is something to read.

### How a label hand-off is delivered

Every label hand-off travels through GitHub. The producing agent applies the
label on the issue or pull request, and the GitHub poller wakes the consumer —
within one poll interval, roughly 30 seconds. The label on GitHub is the single
source of truth: a person re-applying the same label wakes the consumer exactly
like an agent does, and every wake shows up in the **GitHub Event Log**. (The
former *Direct (internal)* delivery option was removed in #2578.)

The label must **exist on the repository**. GitHub refuses to add a label that
does not exist, so such a hand-off can never fire. For a live team the issues
panel then shows **Wake label does not exist on GitHub**, naming the label, the
repository and the listening agent. Team Admins can fix it there with **Create
label** — the same warning, with the same button, appears in Agent Chat →
**Settings** under **Wake labels on GitHub**. Team creation checks this too and
lists a missing label among its warnings.

### Team labels: the base and the suffix chip

On a live team created with a **label suffix**, every label field — the
hand-off, channel, gate and rejection labels, event filters, an outcome's
*set label* action, a human role's labels and the label registry — shows the
editable **base** (`ready-for-review`) with the suffix as a muted, read-only
chip (`-k3f9`). You type only the base; the field saves `ready-for-review-k3f9`.
Typing or pasting the full name (`ready-for-review-k3f9`) is fine — it is
trimmed back to the base. A claimed wake label reads as base, chip and `:wip`.

A label that does not carry the team's suffix (one you wired by hand, or one
that already ended in it when the template was created) is shown as-is, with
no chip, and is never stamped behind your back. A team without a suffix looks
exactly as before. Drafts and templates have no suffix, so their fields are
plain. To change the suffix itself, use **Team Settings → General → Label
suffix** in Agent Chat.

### Holding a PR hand-off until CI is green

A hand-off on a **pull request** — a PR channel, or a label hand-off on pull
requests — can wait until the PR is actually ready before the next agent is
woken. The hand-off dialogs (create and edit) offer two switches:

- **Wait for CI** — hold the wake until the PR's checks pass.
- **Block on merge conflict** — hold the wake until the PR merges cleanly.

With either switch on, two more fields appear: **On failure, set label**
(default `revisions-required`) and **Timeout (minutes)** (default 60). While a
hand-off is held, the GitHub Event Log shows *held — waiting for CI /
conflict-free* and the PR's row on **Flow Control** shows *waiting for CI*.

- **Green**: the next agent is woken as usual.
- **Failure** (a check failed or the PR conflicts): nobody is woken. The
  hand-off label is removed, the failure label set and a comment explains why.
  Wire an agent on the failure label — usually the developer, who fixes the PR
  and sets the hand-off label again. The Flows editor warns when nobody listens
  on a failure label.
- **Timeout**: the hand-off label is removed, `needs-human` set and a comment
  names what was still pending.
- A push while the hand-off is held is checked afresh; the timeout keeps
  counting from the start of the hold.

New PR hand-offs, and the SDLC templates, start with both switches on. Teams
created before this feature are left as they are: open a hand-off and switch
the gate on yourself. Issue hand-offs have no gate. Details: the *Hand-off
readiness gate* section of the triggers documentation.

## Human gates, brakes and named human roles

The **Label registry** lists, per label, **who sets it and who reacts**. Each
label is exactly one of three kinds — it is a single choice, not two
checkboxes, because a label cannot be both:

- **Agent label** — set and consumed by agents. The default; most labels are
  this and need no registry entry at all.
- **Human gate** (👤 → flow) — only a *person* applies it, to admit or approve
  work. An agent setting one is a hard error, and the canvas draws it as a red
  gate: the flow pauses there until someone acts.
- **Brake** (flow → 👤) — an *agent* applies it to pause the flow and hand the
  decision to a person. Agent-set by design, so it is never an error.

Gate-ness is **configuration, not a naming convention**. A label called
`approved-for-dispatch` is a gate because the registry says so, not because of
how it is spelled — which is what lets human-applied labels have ordinary names.

A label that only the registry still knows — nothing in the flow sets, listens
on or gates with it — is marked *not used in this flow* and has a delete button;
**Delete all unused (n)** removes them all. Labels in use cannot be deleted, and
the label on GitHub is never touched.

There is a third, quieter human touchpoint: **delivery**. A person can be wired
to *consume* a label without the flow stopping — they are notified when it is
set, and the flow carries on. Gate blocks, brake pauses, delivery only informs.

**Human roles** are the named people themselves — an *Issue Reviewer*, a *Tech
Lead*. Add them in the **Human roles** panel. A human role never runs anything:
it has no agent, no container and no triggers, and people keep acting through
GitHub labels and pull-request reviews exactly as before. What the role buys you
is that the canvas can say *who* is expected to act.

Wiring a gate to a named role beats leaving it anonymous. A gate, brake or
delivery with nobody wired to it stays **unbound** — it still works, but the
canvas draws no endpoint for it and the flow raises an advisory note that a
human touchpoint has no owner.

## Outcomes and inputs, per agent

Selecting an agent and opening its **Routing** tab shows both sides of its
wiring.

**Inputs — what wakes this agent.** One list of everything that can start a run:
label listeners, pull-request and issue channels, artifact and dependency
inputs, GitHub events, webhooks and schedules. Nothing wakes an agent until
something is in this list, so a new agent with an empty Inputs list will never
run, however well it is described. Each row can be edited or removed here, and
**+ Add input** offers the same vocabulary the canvas drag does — so you can
wire from the inspector without dragging. Rows the platform derived for you
(from channels and data-flow ports) are shown but not editable raw; you change
them by changing the port they came from.

**Outcomes — how a run of this agent ends**, so downstream agents can react.
The **mode** decides how many apply:

- **exactly one** — the agent picks exactly one outcome per run. A switch.
- **any of** — zero or more outcomes may apply on the same run.

Each outcome carries the actions it performs (setting a label, opening a pull
request, opening an issue), and the panel shows which agents currently consume
it — an outcome nobody listens to is a dead end worth noticing. If an agent has
no outcomes yet, **Suggest outcomes…** proposes a set from the agent's own
prompt; the suggestion is a *draft* highlighted for review and nothing is stored
until you press **Save outcomes**.

## Stages

Stages partition the flow into ordered phases — build → review → release — and
are purely about readability and placement. An agent belongs to at most one
stage, assigned in its inspector, and snaps to that stage's column; a child
agent inherits its parent's stage.

The **Stages** panel is the ordered list itself: add, rename inline, drag to
reorder, remove. The order *is* the axis, so reordering the list relays the
canvas.

Stages are optional. With none defined, the flow is laid out automatically from
its hand-off edges, which is fine for a small graph — they earn their keep once
a flow is big enough that the automatic layout stops telling a story.

Stages travel with the flow: they are carried through team creation, exported in
the bundle and restored by *Edit as draft*.

## Anomalies

**Anomalies** is a stall detector for a **live team** — it does not appear on a
draft, because there is no run history to look at. It compares what the flow
*intends* (which label should follow which, and who should have picked it up)
against what actually happened in GitHub and in the agents' run state, and
lists what looks stuck, newest and most severe first, with links to the evidence.

It looks for four things: a wake that was never claimed, a claim that has been
sitting in progress too long, an expected output that never appeared, and a gate
nobody has acted on. Each is reported with its age, because age is what
separates *working* from *stuck* — the thresholds default to about 15 minutes,
2 hours and 24 hours respectively and can be tuned per team.

**It is observe-only. Nothing here repairs anything**, and nothing is changed by
opening it. **Refresh** re-runs the sweep on demand; affected agents also carry
a count badge on the canvas (an anomaly of an auto-scaled copy counts on its
role's box).

Two honest limits: the sweep is paused while platform Maintenance Mode is
active, and a team whose environment has no GitHub repository has nothing to
sweep, so the panel says so rather than reporting a clean bill of health. If one
repository cannot be read the panel reports a partial result with the error
rather than failing entirely.

## Improvements

**Improvements** is the other live-team-only panel, and it looks at how the team
*runs* rather than at how it is wired. It folds the team's own logs — session
transcripts, the anomaly sweeps, the event log — into a set of run metrics: how
often runs succeed, how much work is redone, how long work takes to finish, which
anomalies keep recurring, where tokens are wasted, and which triggers and
outcomes never fire at all.

Below the metrics it lists **improvement cards**: concrete proposals, each with
the evidence it was derived from and the single metric it claims to move.
**Cards are proposals — nothing changes until you apply one**, and an apply runs
through exactly the same audited endpoint you would have used by hand, as you.
An applied card is then *measured*: if the metric got worse, the card comes back
as regressed with a **Roll back** button that undoes it through the same path.

Two things to expect. Below a minimum number of runs in the window the ratio
metrics honestly report **Insufficient data** instead of a number computed from
three runs. And the panel is governed by the team's autonomy level: at level 0 it
collects metrics and raises no cards, at level 1 the cards are read-only, and
only at level 2 are Apply and Roll back available — the buttons say which it is
rather than silently doing nothing.

**Run now** runs a pass immediately instead of waiting for the daily one. A pass
already in progress, or Maintenance Mode, is reported as a notice rather than an
error.

## Describe the flow: the Copilot

The **Flow Copilot** is the plain-language way in. Describe the process you want
— the roles, who hands work to whom, where a person has to approve — and it
proposes a complete flow.

It is a chat, docked beside the canvas rather than over it, because the canvas
*is* the preview: each turn produces a **proposal** you can see drawn before you
accept it. A proposal is read-only until you **Apply** it, and applying is an
ordinary draft write — from then on it simply *is* the draft. **Discard** leaves
the draft exactly as it was. The same Apply and Discard also appear in a banner
over the canvas, so whichever one you reach for does the same thing.

You keep steering it: follow-up messages refine the proposal rather than
starting over. Each proposal is checked before you can accept it, and one with
error-level findings cannot be applied — steer with another message instead.

On a **live team** the Copilot edits the team itself. **Apply to team…** first
opens a confirmation listing each change (added, changed, removed) and anything
*not applied*; confirmed changes reach running agents at once. Each
removal is its own opt-in checkbox. New roles become stubs unless you
tick *Materialize now*. If the team changed meanwhile, Apply is
blocked — **Regenerate**. Only editors can chat and apply; they share the
history. **Edit as draft** stays available, but *Extend team* only adds roles
that don't exist yet.

A large flow can take a while. If a generation would run too long, the
Copilot builds it in two steps — roles first, then the wiring — showing
*Generating in parts…*; the result is the same checked proposal. If a turn
still times out, the error card suggests smaller requests or a faster assist
model under **Settings → Model**, with the raw detail behind *Technical detail*.
