---
id: plugin-jira
routes: ["/chats", "/plugins/jira/view", "/plugins"]
title: Jira plugin
summary: How a Jira event (status change, new issue, comment, field change) wakes an agent, what the two trigger filters mean for Jira, how to avoid the comment loop, and what the agent can do with `aee-jira`.
seeAlso:
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Plugins", to: "/plugins" }
askPrompts:
  - "How does a Jira status change wake my agent?"
  - "Which fields can I filter a Jira wake on?"
  - "Why did my agent not wake when the ticket moved to Ready for Dev?"
  - "How do I wake an agent when someone comments on a ticket?"
  - "What can the agent do with aee-jira?"
---

## How a Jira status change reaches an agent

The Jira plugin's broker polls the team's Jira Cloud site about once a minute
for the projects a Team Admin configured on the plugin's **Watch config** page.
When an issue in a watched project moves to a **watched status**, the broker
sends one `status_changed` event to the platform, and the platform wakes every
agent of that team that (a) has the plugin granted and (b) has a **Plugin
event** trigger whose filters match. The agent's own wake instruction is the
prompt; the Jira change rides along as context.

Three things must therefore line up for a wake: the **watch** (broker side —
project + status set), the **grant** (the plugin is activated for the team),
and the agent's **trigger** (this page, Triggers tab).

## The trigger's two filters, for Jira

| Field | What to put there for Jira |
|---|---|
| **Which event** | `status_changed`, `issue_created` (a new ticket), `comment_added` or `field_changed` (any other field) — whichever the watch forwards (**Watch config** ticks the kinds per project; status changes only by default). Set it on every trigger once a watch forwards more than one kind — *Any event* then wakes on all of them. A status name is **not** an event. |
| **Only when…** | a condition on the **fields of that event** (the form's sub-heading reads *fields of `status_changed`*) that picks *which* status changes wake this agent — almost always `toStatus = <the status the issue moved into>`, e.g. `toStatus = Ready for Dev`. |

The **Only when…** condition is what routes a flow through several agents: give
the Business Analyst `toStatus = Ready for Refinement`, the Developer
`toStatus = Ready for Dev`, the Reviewer `toStatus = In Review`. A value must
equal the field **exactly** — copy the status name verbatim from Jira,
including capitalisation. Without any condition *every* granted agent with a
plugin-event trigger wakes on *every* watched transition, including the one an
agent just made itself.

### The fields a `status_changed` event carries

All plain strings, usable in **Only when…**:

| Field | Meaning | Example |
|---|---|---|
| `toStatus` | the status the issue moved into — the usual routing key | `Ready for Dev` |
| `fromStatus` | the status it came from | `In Progress` |
| `projectKey` | the Jira project | `KAN` |
| `issueType` | Story, Bug, Task, … | `Bug` |
| `author` | who moved it (display name) | `Jane Doe` |
| `issueKey` | one specific issue | `KAN-10` |

Several conditions combine with AND: `toStatus = Ready for Dev` plus
`issueType = Bug` wakes the agent only for bugs entering that status.

### The other kinds

| Event | Route on | Example |
|---|---|---|
| `issue_created` | `origin`, `issueType`, `status`, `priority` | `origin = human` |
| `comment_added` | `origin`, `author`, `issueType` | `origin = human` (always) |
| `field_changed` | `field` / `fieldId`, `to`, `origin` | `field = assignee` |

`field_changed` is one event per field, never status, description or Rank. A
comment's text rides along as `body` (cut at 2000 chars). One kind per wake.

## Avoid the comment loop

Jira cannot tell an agent's `aee-jira` write from a human's (both use a
human's token), so a `comment_added` trigger with no condition wakes the agent
on its **own** reply. Put **`origin = human`** on every `comment_added`,
`issue_created` and `field_changed` trigger — the broker stamps its own writes'
echoes `origin = agent`. A status change has no `origin`: a transition wakes
the next stage by design.

When more than three transitions land in a single poll — on one issue, or
across one project (a bulk move such as sprint planning) — they arrive as one
**digest**, one wake rather than one per ticket. Each agent receives the digest
**narrowed to its own conditions**: a *Ready for Dev* agent sees only the
*Ready for Dev* transitions of that bulk move, never a teammate's — however
large the move and wherever its transitions sit in it. An agent's digest
inlines at most 20 of *its own* transitions; when it had more it carries
`truncated: true` and `aee-jira inbox` (peek) shows the rest.

## What the woken agent can do — `aee-jira`

The plugin seeds a small command-line tool into a granted agent's workspace.
All Jira access stays server-side in the broker; the agent never sees the token.
Chats run as the **sender** (own **Plugin Tokens** entry, else refused);
watching and automated runs use the team's service account.

| Command | |
|---|---|
| `aee-jira inbox` / `aee-jira inbox --consume <id>…` | the queued events of the whole team (peek); `--consume` drains exactly the ids named — use the ids from your own wake (`id`, or `events[].id` in a digest), never a teammate's |
| `aee-jira list --project KAN [--status "Ready for Dev"]`, `aee-jira show KAN-6 [--fields "Team"]` | read issues (`show` also gives priority, labels, reporter, components, fixVersions, dueDate, any attachments, the `parent`/epic key to traverse Story→Epic, and `availableTransitions` — the moves reachable from the current status, so you can `transition --to` one without guessing). `--fields` also reads **custom fields** by Jira name (e.g. `Team`). Unset → `null` / `[]` |
| `aee-jira comments KAN-10 [--limit N] [--offset N]` | an issue's comments, newest first, 20 per call (`--limit` capped at 100): `id`, `author`, `created`, `updated`, plain-text `body`, `origin` (`agent` = your team's, else `human`). `bodyTruncated: true` → full text via `show KAN-10 --comment <id>`; `hasMore: true` → older ones via `--offset <nextOffset>`. Details: docs/jira-plugin.md |
| `aee-jira statuses --project KAN` | every workflow status the project supports, grouped by issue type — the full set the workflow allows, independent of any one issue's current state |
| `aee-jira search --jql "<JQL>" [--fields …] [--limit N]` | any read-only JQL, scoped to the team's bound site & projects — for filters `list` can't express |
| `aee-jira attachment get KAN-6 <id> [--out PATH]` | fetch one attachment's content by id (from `show`) — text prints inline, binary is saved to a workspace path |
| `aee-jira attachment add KAN-6 <path> [<path>…]` | upload local files as new attachments; per-file result with each created id |
| `aee-jira comment KAN-6 --body "…"` | add a comment |
| `aee-jira update KAN-6 --description "…"` | replace the description (keep what the human wrote and add a section — the old text stays in Jira's history) |
| `aee-jira set-field KAN-6 --field "Team" --value "<v>"` | set a custom field by its Jira name (any, unless a Team Admin set a `writable-custom-fields` list); for Team pass the id from `show --fields "Team"` |
| `aee-jira users "Anna" [--project KAN \| --issue KAN-10]` | **find people to assign** — Jira identifies a person by an accountId, never by name or e-mail, and every assignee (`edit --assignee`, `create-issue --assignee`, `"assignee"` in a `create-epic` / `add-stories` payload) takes that accountId. Search by a name or e-mail fragment; each match has `accountId`, `displayName`, `email` (only when Jira shows it to the account — otherwise `null`, never guessed), `active` and `accountType` (`app` = a bot). With `--project` / `--issue` only active people who can be assigned there come back. Several people with the same name are all listed and the `note` says so — tell them apart by e-mail or ask, never pick one. No match is an empty list with a *No user found* note; at most 50 come back (`truncated: true` = there were more). To assign: `aee-jira users "Anna Schmidt" --project KAN`, then `aee-jira edit KAN-10 --assignee <accountId>` |
| `aee-jira link KAN-1 blocks KAN-2` / `aee-jira link-types` | link two existing issues — read it as a sentence: the first key is the subject of the phrase ("is blocked by" flips it); a type name such as `Blocks` means its outward phrase. `link-types` lists the site's types (name, outward / inward phrase). An existing identical link is reported, not duplicated. `show` lists an issue's `links` (`id`, `type`, `relationship`, `otherIssue`, `statement`) |
| `aee-jira unlink 10001` / `aee-jira unlink KAN-1 blocks KAN-2` | remove a link by its id (from `show`) or by the same sentence; a link that does not exist is refused and nothing changes |
| `aee-jira transition KAN-6 --to "In Progress"` | move the issue on — this is itself a status change and wakes whichever teammate's trigger names that target status |
| `aee-jira create-epic --project KAN --file plan.json` | create one Epic and its child Stories in one call (summary, assignee, status, custom fields per Story); reports each key or a per-Story error |
| `aee-jira add-stories --epic KAN-12 --file stories.json` | add new Stories to an Epic that **already exists** — never creates an Epic. Payload `{"stories": [...]}` with the same per-Story fields as `create-epic`; the Stories land in the Epic's project. **Other types under the Epic:** `--type Bug` (or `"type"` per issue, which wins; `"issues"` may replace `"stories"`) creates Bugs, Tasks or any normal type the project offers, matched case-insensitively, with optional `priority` and `labels` per issue — an unknown type (the error lists the project's types), an Epic or sub-task type, or a required field the issue does not set fails only that issue. Refused before anything is created if the key is missing or outside the team's scope, is not an Epic (the error names its type), or the payload is empty; reports each key or a per-Story error (exit 1 if any failed). One call per Epic |
| `aee-jira add-subtasks --parent KAN-10 --file subtasks.json` | **Sub-tasks under an existing Story/Task/Bug** — `{"subtasks": [...]}`, `create-issue`'s fields; `--type` if the project has several sub-task types. Refused under an Epic or Sub-task |
| `aee-jira create-issue --project KAN --type Bug --summary "Login fails"` | create **one standalone issue** — no Epic needed — of any normal type the project offers (Story, Task, Bug, or the project's own name such as *Fehler*). Optional `--description`, `--assignee <accountId>`, `--priority`, `--label` (repeatable), `--field "Team=42"` (repeatable) and `--status` (moved there right after creating). Returns the new key and link. Refused before anything is created if the project is outside the team's scope, the type is unknown (the error lists the project's types), the type is an Epic (use `create-epic`) or a sub-task, or a required field is missing (the error names it). If the status move is not possible, the issue still exists and the result says why (exit 1) |
| `aee-jira set-epic KAN-30 KAN-31 --epic KAN-12` / `aee-jira set-epic KAN-30 --none` | put issues that **already exist** under an Epic, move them from another Epic, or take them out of their Epic (`--none`). Refused before anything changes if the target is missing, outside the team's scope or not an Epic. Each issue gets its own outcome — added, moved, removed, *already under KAN-12* (a success) or failed with the reason (not found / outside the scope, an Epic or a sub-task, or Jira's refusal); one bad key does not stop the others (exit 1 if any failed). The change is marked as the team's own write |
| `aee-jira edit KAN-10 --summary "…" --priority High --add-label backend` | change the **standard fields** of one existing issue — summary, assignee (`--assignee <accountId>` / `--unassign`), priority (by name), labels, components and fix versions (`--add-…` / `--remove-…` single values without touching the others, or `--set-…` to replace the whole list) and due date (`--due YYYY-MM-DD` / `--clear-due`). Several fields in one call are applied together, or not at all. An unknown priority, component or version is refused with the list of what exists (nothing is created); a label with a space or an invalid date is refused before Jira is called; a field that is not on the issue's edit screen is named. The result shows each field's old and new value, *unchanged* when it already had it. The change is marked as the team's own write |
| `aee-jira sprint list --board "<board name>"` | list a Scrum board's sprints (id, name, state, start/end), the board resolved by its human-readable name. Read-only |
| `aee-jira sprint create --board "<board name>" --name "<name>" --start <date> --end <date>` | create one future sprint on the board (a Scrum board has only one active sprint) |
| `aee-jira sprint bulk-create --board "<board name>" --name-template "<tmpl>" --until <date>` | pre-create weekly (`--cadence-days`) future sprints up to a date, named from a template such as `Acc2.0 {MMM}_{weekOfMonth}` |
| `aee-jira sprint close --board "<board name>" [--sprint-id <id>]` | complete (close) the board's active sprint (`--sprint-id` closes a specific one). Reports the count of issues left incomplete — they stay on the closed sprint |
| `aee-jira sprint start --board "<board name>" [--sprint-id <id>]` | start (activate) the board's next future sprint (`--sprint-id` for a specific one). Refused if the board already has an active sprint or the sprint has no dates |
| `aee-jira sprint advance --board "<board name>" [--close-id <id>] [--start-id <id>]` | roll the board over in one call: close the active sprint, then start the next future one — each half reported separately, so a partial result is visible (exit 1 on a partial) |

A good wake instruction says exactly that sequence: *"Take the issue key(s) and
event id(s) from the event payload, run `aee-jira inbox --consume <id>…` for
those ids, read each issue with `aee-jira show`, do the work, write it back with
`aee-jira update`, then `aee-jira transition` it to the next status."* The inbox
is shared by every agent on the team. Consume only the ids from your own wake:
the broker cannot tell agents apart (one scope token per team), so a
teammate's queued events stay queued only as long as each agent drains just
what it was woken for.

## When a Jira event does not wake the agent

Check in this order:

1. **The trigger's filters.** *Which event* must be blank or the event's kind
   (`status_changed`, `comment_added`, …); a status name there never matches.
   For a status change, *Only when…* must name the exact status the issue moved
   **into** (`toStatus`), spelled as Jira spells it. An `origin = human`
   condition never matches an agent's own write.
2. **The watch.** On the plugin's Activity tab a `not watched` row means the
   watch does not forward that kind (its checkbox on the Watch config page) or,
   for a status change, the status is missing from the watch's status set.
3. **The grant.** The plugin must be activated for this agent's team (Plugins
   page); the trigger form flags a plugin that is not granted.
4. **Already seen.** The broker baselines on its first poll and never re-sends a
   transition it delivered; move the issue again to test.
5. **A watch card shows Failing** — usually an expired API token; a Team Admin
   re-sets it on the Plugins page and hits *Retry now*.
6. **`aee-jira inbox --consume` exits with a usage error.** Since this version
   `--consume` needs the event ids from the wake payload (`id`, or
   `events[].id`); a bare `--consume` no longer drains the team's inbox. Update
   the wake instruction as in the example above.
