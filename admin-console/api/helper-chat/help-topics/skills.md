---
id: skills
routes: ["/skills"]
title: Skills
summary: The reusable instruction packages your agents load — kept in a global and a per-team pool, granted to whoever needs them.
seeAlso:
  - { label: "Knowledge", to: "/knowledge" }
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Agent Team Wizard", to: "/team-setup" }
  - { label: "Role Templates", to: "/role-templates" }
askPrompts:
  - "What is the difference between granting a skill and installing it into an agent?"
  - "When are granted skills actually copied into an agent's workspace?"
  - "Does a skill I installed into an agent survive a workspace reset?"
  - "Should this skill live in the global pool or in a team pool?"
  - "How do I share a skill that only exists inside one agent?"
  - "What happens to grants when I merge two skills?"
  - "What is the difference between Skills, Knowledge and Memory?"
---

## What a skill is

A skill is a **reusable instruction package**: one `SKILL.md` plus any helper
scripts, reference tables or data files that belong with it, all living in one
directory named after the skill. An agent reads the skills it was given at the
start of every invocation, so a skill is how you teach every agent the same
procedure once instead of repeating it in each system prompt.

A useful skill usually carries four things: the domain context, a table of the
files or documents the agent may read, worked examples showing how to apply the
knowledge, and the instructions specific to the role that will use it. Because
the whole directory travels together, anything the instructions refer to can sit
next to them.

This page lists every skill in the shared **pools** as well as the copies living
inside individual **agents**. A skill name may use letters, digits, `-` and `_`,
optionally in dotted or colon-separated segments (`review.security`) — that name
is also the directory name, so it cannot be changed by renaming a heading.

Clicking a row opens the skill in a side panel with three tabs:

| Tab | What it shows |
|---|---|
| **Content** | A read-only preview of the skill's files. Markdown is rendered (a `SKILL.md` header is shown as a separate metadata block), other text files are shown as code, binaries are named but not displayed, and anything over 512 KB is truncated. **Edit skill** (or **Open**, when you may not edit it) opens the full-screen skill editor described below. |
| **Versions** | The revision history: a content version and hash prefix (`v4 · a1b2c3`), what produced the revision, who did it and when. Exactly one entry — the one whose content is on disk right now — is marked **current**. Each version can be opened, compared and restored — see *Versions: open, compare and restore* below. |
| **Copies & origin** | Where this copy came from, followed by every place the skill lives today, grouped by team — each copy with its version, a **drift** badge and the update actions. Described in detail below. |

Create a skill with **+ New Skill** (you pick the target pool), or bring one in
with **Import skill** — see the actions chapter below.

### The skill editor

**Edit skill** opens the whole skill in a full-screen editor. The left side is the
skill's folder tree (folders first, then files, alphabetical; drag the divider to
widen it); the right side shows the selected file — markdown rendered, with
`SKILL.md`'s header as its own metadata block. Switch a file between
**Preview**, **Edit** (a monospaced editor with line numbers) and, for markdown,
**Split view** with a live preview next to the editor.

The toolbar and each row's menu (right-click, the **⋮** button, or Shift+F10)
offer **New file**, **New folder**, **Rename / move** (type a new path to move a
file or a whole folder), **Delete** and **Upload** — uploads also work by
dropping files onto the tree, are limited to 2 MB per file, and ask before
replacing a file of the same name. `SKILL.md` at the skill root is the skill
itself and cannot be renamed, moved or deleted; the platform's own bookkeeping
(`skill.json`, `provenance.json`, the `_archive` of deleted skills, the
`_versions` snapshots) is not shown.

Nothing is written until you press **Save** (or Ctrl/⌘+S). Until then every
change is pending: changed files and folders carry a dot in the tree and the
header counts the pending changes. **Save** writes all of them at once — either
everything lands or nothing does — as exactly **one** new version, and the usual
resync of agent copies runs once. **Discard** throws all pending changes away
after a confirmation, and closing the editor (✕, Escape or the browser's back
button) asks first when something is still unsaved. If someone else changed the
skill since you opened it, Save is refused and offers to **Reload** instead of
overwriting their work. **Empty folders are kept**: a folder you create stays
even with nothing in it, and a folder only disappears when you delete it.

Binary files are shown by name only; text files over 512 KB show their first
512 KB with a notice. Neither can be edited in the editor — replace them by
uploading. Agent-tier copies, and
skills you have no write permission for, open in the same editor **read-only**:
you can browse and preview, but every editing control is gone and the header
says why. Editing needs the same rights as before — System Admin or a Team Admin
for global skills, a Team Admin of the team for team skills.

### Versions: open, compare and restore

Every action that records a version — create, save in the editor, import,
promote, adopt, resync, restore and the rest — also keeps a full copy of the
skill's content for that version, for every tier including agent copies. Up to
the last 20 versions are kept, the same as the history itself; a version whose
content is identical to one already stored costs nothing extra. Versions recorded
before this feature existed show **Content not available** — their history entry
stays, but there is nothing to open or compare. The stored copies never travel:
they are not part of the content hash, not in a ZIP export, and not carried when
a skill is promoted, adopted, moved, installed or otherwise copied to another
tier — the copy starts its own version history.

On the **Versions** tab:

- **Open** shows that version in the full-screen editor, read-only, under the
  banner *You are viewing an old version* with its version, hash, action, author
  and date.
- **Compare with current** shows what changed between that version and the
  current content.
- Tick any **two** versions and press **Compare** to compare them; the older one
  is always shown on the left, whichever you ticked first.
- When an agent's copy was changed by hand after its last recorded version, a
  **Working copy (unversioned changes)** row at the top stands for the content on
  disk, and you can compare it like any version.

The comparison opens full-screen. It lists added, removed, modified and renamed
files with their `+added −removed` line counts; unchanged files are hidden until
you tick **Show unchanged files**. Switch between **Side-by-side** and
**Inline** — your choice is remembered for the rest of the browser session.
Every changed line carries a `+` or `−` marker, so the diff reads without
colour. Binary files and files over 512 KB are not diffed line by line; they just
say *binary — changed* or *too large — unchanged*. Comparing a version with
itself says **No differences**. A renamed file that was also heavily edited may
show up as one file removed and another added.

From an opened old version you can:

- **Compare with current** — the same comparison, on top of the editor.
- **Restore this version** — after a confirmation, the version's content
  replaces the current content and is recorded as a **new** version with the
  action *restored* (so the content you replaced stays in the history). Agent
  copies of a global or team skill are resynced once, as after any edit.
  Restoring an agent's own copy writes into that agent's skill folder and, as
  with an install, the agent uses the restored content from its next message.
- **Edit from this version** — loads the old content into the normal editor as
  pending changes on top of the current skill, so you can adjust it before
  **Save** records it as one new version.

Both are disabled on the version that already is the current content. Restoring
needs the same right as editing that copy — a Team Admin of the team for team
skills, System Admin or a Team Admin for global skills, and for an agent's copy
the right to install skills on that agent (System Admin or a Team Admin of the
agent's team). Agent copies cannot be edited here, so they offer **Restore** but
not **Edit from this version**. If someone changed the skill after you opened the
old version, the restore is refused and asks you to reload.

### Copies & origin

This tab answers two questions in one place: *where did this copy come from?*
and *where does this skill live today?* (It replaces the former **Lineage** and
**Usage** tabs; old links to either open this tab.)

- **Origin** says in plain words what this copy was taken from — e.g. *Taken
  from agent Onboarding Skill Creator (team Onboarding), version v1 · e663de* —
  and adds *this source no longer exists* when it is gone. A skill written by
  hand says *No recorded origin (hand-authored)*. Below it you see the
  knowledge **provenance** when the skill was distilled from learnings.
- A **summary line** counts the places the skill lives in, per tier, and names
  the worst drift among them.
- The **copies list** shows every copy exactly once. The copy you are viewing is
  marked *viewing* and listed first; then the **Global pool**, then one group
  per team (alphabetical), with the team pool's copy before the team's agents.
  Agents are shown by display name and team name, with the agent id in muted
  text; two agents of the same name in the same team get their id added. Agents
  whose team cannot be resolved are listed under **No team**. With more than
  ten copies a filter over team and agent names and ids appears. Click a copy to
  open it.
- **Update** (per copy, or **Update all outdated**) resyncs untouched copies to
  the current source; **Overwrite…** (per copy, or **Overwrite all edited**)
  replaces locally edited copies after a confirmation.

Each drift badge has a tooltip; **What do the statuses mean?** shows them all:

| Badge | Meaning | What to do |
|---|---|---|
| *in sync* | The copy matches the skill it was taken from. | Nothing. |
| *outdated* | The source has changed since; the copy is untouched. | **Update** — nothing is lost. |
| *diverged* | The copy was edited locally; the source has not changed. | Keep the edits, or **Overwrite** to discard them. |
| *conflict* | Both the copy and the source have changed. | Compare and decide; **Overwrite** discards the local edits. |
| *orphaned* | The skill the copy was taken from no longer exists (*source gone*). | Nothing — the copy keeps working; remove it only if unwanted. |
| *unknown* | The copy predates version tracking and cannot be compared. | Nothing; it cannot be updated automatically. |

A copy with nothing to compare against — a hand-authored skill — shows no badge.

## The three tiers, and which one an agent gets

The filter strip above the table switches between the tiers, because the same
skill name can exist on more than one of them at once:

| Tier | Who can use it | Editable here |
|---|---|---|
| **Global** | Every team. The house-wide pool. | Yes |
| **Team** | One team only — that team's own pool. | Yes |
| **Agent** | The single agent it lives in. | No — read-only |

When an agent's workspace is seeded, each skill it was granted is resolved from
**its own team's pool first, then from the global pool**. That single rule is
what makes team pools useful: a team can keep a skill of the same name in its own
pool and thereby override the global one for its own agents, while every team
that has no such skill keeps getting the global version. A team with no skills of
its own behaves exactly like a global-only setup, so nothing has to be migrated
to start using the team tier.

The same rule is also how a team curates **private** domain skills. A team-tier
skill is only ever seeded into that team's agents; it is never visible to another
team, and promoting it to global is a separate, deliberate step.

**Agent** skills are read-only here because they are a copy inside a workspace,
not a pool entry — editing one would be overwritten by the next seeding. To share
one, lift it into a team pool first (from the **Knowledge** page), then promote
that team skill to global. Both steps write provenance and `skill.json` lineage,
so the **Copies & origin** tab can always show where a skill came from.

## Grant, activation and Install into agent

The verbs on this page hide three genuinely different mechanics, and mixing them
up is the usual source of *"why doesn't my agent have that skill?"*:

- **Grant** — the *list of names* an agent, or its whole team, is entitled to.
  You grant in Agent Chat **Settings**, in the **Agent Team Wizard**, or on the
  **Knowledge** page. A grant is a declaration, not a file copy. (Working
  Environments carry repositories, credentials, MCP servers and context folders —
  never skills.)
- **Seeding / activation** — the moment those files are actually **copied into
  the agent's workspace**. The agent reads them on its next invocation, so a
  fresh grant becomes effective as soon as the workspace is next seeded.
- **Install into agent** — activation for **one already-running agent**, without
  a full re-seed. Pick the agent, install, and the files are copied into its live
  workspace additively: no restart, and the agent picks the skill up on its next
  invocation.

**Installing is not a throwaway copy.** It writes the grant as well as the files
— an agent's own `skills[]`, or a team member's per-member override — so the
skill is still there after a later **workspace reset** or a full re-seed, and the
seeded files can no longer drift away from what the agent is entitled to. The
difference between granting and installing is therefore *when*, not *how long*:
you grant while configuring an agent or a team, and you install when the agent is
already running and you do not want to wait for the next seeding.

Two limits are worth knowing before you look for the agent in the list. Only a
**materialized, enabled** agent can be installed into — a stub has no workspace
yet and would be re-seeded from its environment the moment it is enabled — and an
install refuses to clobber a skill the agent already has, unless you confirm the
overwrite.

The agent list is grouped by **team**, so agents that share a name (several *My
Assistant*s, say) can be told apart. Teams and the agents in each are sorted by
name; two teams with the same name show their team id as well, and agents that
belong to no team come last under *No team*.

## The actions: promote, move, adopt, distill, merge, import and export

Everything else on this page moves a skill between the tiers or reshapes it:

| Action | What it does | Where |
|---|---|---|
| **Promote to global** | Copies a team skill into the global pool; the team-tier copy stays put. | Team skill, side panel |
| **Move to global** | Relocates a team skill into the global pool and retires the team copy (a recoverable snapshot is archived). | Team skill, side panel |
| **Adopt** | Copies a global skill into one team's pool and activates it there, so that team owns a curatable copy. The page then says whether the activation worked; if not, activate it in the team's **Skills** tab. | Global skill, side panel |
| **Move to team** | Relocates a global skill into a team pool and retires the global copy (recoverable snapshot; System Admin only). | Global skill, side panel |
| **Install into agent** | Activates a global skill for one running agent — see the chapter above. | Global skill, side panel |
| **Publish** | Pushes an agent's edited skill up to the team pool and/or straight to global — see the chapter below. | Agent skill, side panel or the Knowledge page |
| **Distill** | Re-synthesises a single skill from everything that accumulated in it: dedupe, restructure, re-abstract. | Team skill, side panel |
| **Merge** | Folds several selected skills into one. | Table selection → **Merge selected** |
| **Export ZIP** | Downloads the whole skill directory as an archive. | Any skill, side panel |
| **Import skill** | Reads a `.zip` / `.skill` archive back into the pool you choose. | Page header |

A skill entering the **global** pool for the first time is a Team-Admin act too,
not System-Admin-only — and that is now one rule for every path in, not just
promote and publish: a Team Admin may promote their own team's skill to global,
push an agent's edited skill straight to global (**Publish**), **import** an
archive straight into the global pool, **merge** several skills into a global
target, create a brand-new global skill (**+ New Skill**), or edit an existing
global skill's content — all without a System Admin. For import, merge, create
and edit there is no single "content's own team" the way there is for a
promote or publish, so the floor is simply Team Admin of *any* team you
administer, not the one that happens to own the content. What stays
System-Admin-only is *moving OUT* of the global pool or an agent's own
workspace (retiring that copy), because deleting someone else's content is a
governance-level act regardless of who is adding to global. The
Team-Admin-only actions simply do not appear when the skill you opened is not
on their tier, and the **Import to:** / **+ New Skill** target pickers only
ever offer a pool you may actually write to.

### The transfer preview and injection scan

Moving a skill across the tiers from this page — **Promote to global**, **Move
to global**, **Adopt** or **Move to team** — first opens a **preview** of the
exact content that would cross the boundary, before anything is written (for an
overwrite it shows the destination's current content too, so you can compare).
A transfer is the one point where a skill leaves the team that authored it, so
the preview also runs an **advisory prompt-injection scan** over that content:
a two-stage check — a fast pattern pass, and, when your team has an assist model
selected, an AI review — looking for hidden or manipulative instructions rather
than legitimate domain guidance.

The scan only **warns**; it never blocks. A clean result (*"No prompt-injection
indicators found"*) proceeds with a single click. When the scan flags something
(*"N potential prompt-injection indicators found"*), you must tick one explicit
acknowledgement before the **Transfer** button enables, so a flagged skill is
never promoted by reflex — but once you confirm, the transfer still completes
either way. No such step is added anywhere else: in-team create, edit, distill
and the knowledge pipeline are untouched.

### Publishing an agent's edited skill (Publish)

An agent-tier skill row on this page — or the matching entry in the Knowledge
page's private-skills panel — offers **Publish** whenever there is something
worth publishing: a skill the agent authored itself, or its **edited** copy of a
skill it was granted (the common case: an agent improves a shared skill like
Flow Designer inside its own workspace, and the edit should become the new
global version). An **unchanged** copy of a granted skill is never offered —
there is nothing local to give back, and a copy whose *source* moved on while
the agent's own copy did not (`outdated`) should be resynced instead, not
published.

Publish offers **either** path, your choice each time: **Publish to global**
copies the edit directly into the global pool in one step; **Publish via team
pool** lifts it into the team pool first, then promotes that copy to global —
two steps, same engine. Both reuse the ordinary tier-transfer machinery, so a
name already taken at the destination asks for the familiar overwrite
confirmation (replaces the entire destination skill directory) before
proceeding, and the publish is recorded in the destination's own version
history and lineage like any other transfer.

**Distill** is available for team skills, and it only rewrites wording: it
re-synthesises the skill from its own accumulated content so it stays tight as
agents keep adding to it, then shows you the old and new text side by side. You
apply it yourself, and a run that finds nothing to improve says so instead of
producing a cosmetic diff.

**Import and export** are how a skill travels between installations, or in and out
of version control. An export is the whole directory, not just `SKILL.md`, so a
skill with helper files survives the round trip; on import you choose the target
pool — the global one as System Admin, or a team's as Team Admin.

**Delete** archives a recoverable snapshot rather than dropping the files. A skill
that is still granted somewhere is refused with the list of agents that would
lose it, and the confirmation then offers to deactivate those grants and delete
in one step.

## Overwrite and merge: what each one replaces

Every transfer, install and merge asks before it replaces an existing skill of the
same name at the destination, because an overwrite **replaces the entire skill
directory** there — not just `SKILL.md`. Extra files the old version carried are
gone. The previous content stays in the skill's revision history, so you can see
what it was, but the safe move when in doubt is to pick a different target name.

**Merging is more than concatenating text.** Select two or more skills in the
table and *Merge selected* opens a dialog that decides three things: the **target**
(a team pool when every source is a team skill of the same team, the global pool
otherwise), the target **name**, and the combined `SKILL.md`. The draft is
prefilled instantly by a deterministic concatenation so the editor is never
empty; you can ask the model to synthesise a coherent version instead, and you
can edit either by hand before the merge runs.

What the merge then does to everything around the text is the part worth reading
twice:

- The target's **provenance unions every source's**, so a merged skill still
  knows which learnings it descends from.
- **Extra files are carried over** from the sources, not dropped in favour of the
  new `SKILL.md`.
- **Grants pointing at a retired source are migrated to the target** — the target
  is activated *first* and the sources deactivated afterwards, so no agent is left
  without the skill in between. Nobody loses a skill because it was folded into
  another one.

Leaving *Retire source skills* ticked archives the sources — restorable — after
the grants have moved. Unticking it keeps them in place, which is what you want
when the sources are still meaningful on their own.

## Skills vs Knowledge vs Memory

Three things that are easy to confuse:

- **Memory** — what *one agent* privately remembers. Not shared.
- **Knowledge** — the lessons a team **shares**, so every agent benefits from
  what any one of them learned.
- **Skills** — this page: the polished, reusable instruction files agents load
  automatically, often **distilled from the best knowledge**.

The pipeline runs left to right: an agent learns something → it becomes team
knowledge → the strongest, converged knowledge is promoted into a skill. How much
of that happens without you, and what the promotion gates are, is the
**Knowledge** page's own subject — its help topic covers the autonomy levels and
the review flow in full.
