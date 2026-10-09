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

The broker polls the team's Jira Cloud site about once a minute for the projects
a Team Admin set on the plugin's **Watch config** page. When an issue in a
watched project moves to a **watched status**, it sends one `status_changed`
event, and the platform wakes every team agent that (a) has the plugin granted
and (b) has a **Plugin event** trigger whose filters match. The agent's wake
instruction is the prompt; the Jira change rides along as context.

Three things must line up for a wake: the **watch** (broker side — project +
status set), the **grant** (plugin activated for the team), and the agent's
**trigger** (this page, Triggers tab).

## The trigger's two filters, for Jira

| Field | What to put there for Jira |
|---|---|
| **Which event** | `status_changed`, `issue_created` (a new ticket), `comment_added` or `field_changed` (any other field) — whichever the watch forwards (**Watch config** ticks the kinds per project; status changes only by default). Set it on every trigger once a watch forwards more than one kind — *Any event* wakes on all. A status name is **not** an event. |
| **Only when…** | a condition on the **fields of that event** (the form reads *fields of `status_changed`*) picking *which* changes wake this agent — almost always `toStatus = <status moved into>`, e.g. `toStatus = Ready for Dev`. |

The **Only when…** condition routes a flow through several agents: give the
Business Analyst `toStatus = Ready for Refinement`, the Developer
`toStatus = Ready for Dev`, the Reviewer `toStatus = In Review`. A value must
equal the field **exactly** — copy the status name verbatim from Jira,
capitalisation included. Without a condition *every* granted agent with a
plugin-event trigger wakes on *every* watched transition, including one it made
itself.

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

Jira cannot tell an agent's `aee-jira` write from a human's (both use a human's
token), so a `comment_added` trigger with no condition wakes the agent on its
**own** reply. Put **`origin = human`** on every `comment_added`, `issue_created`
and `field_changed` trigger — the broker stamps its own writes `origin = agent`.
A status change has no `origin`: a transition wakes the next stage by design.

More than three transitions in one poll — on one issue, or across a project (a
bulk move such as sprint planning) — arrive as one **digest**, one wake instead
of one per ticket. Each agent's digest is **narrowed to its own conditions**: a
*Ready for Dev* agent sees only the *Ready for Dev* transitions, never a
teammate's, however large the move. A digest inlines at most 20 of its own
transitions; beyond that it carries `truncated: true` and `aee-jira inbox` shows
the rest.

## What the woken agent can do — `aee-jira`

The plugin seeds a small command-line tool into a granted agent's workspace. All
Jira access stays server-side in the broker; the agent never sees the token.
Chats run as the **sender** (own **Plugin Tokens** entry, else refused); watching
and automated runs use the team's service account.

| Command | |
|---|---|
| `aee-jira inbox` / `aee-jira inbox --consume <id>…` | the team's queued events (peek); `--consume` drains exactly the ids named — use the ids from your own wake (`id`, or `events[].id` in a digest), never a teammate's |
| `aee-jira list --project KAN [--status "Ready for Dev"]`, `aee-jira show KAN-6 [--fields "Team"]` | read issues. `show` also gives priority, labels, reporter, components, fixVersions, dueDate, attachments, the `parent`/epic key (traverse Story→Epic), and `availableTransitions` (the moves reachable now, so you can `transition --to` one without guessing). `--fields` also reads **custom fields** by Jira name (e.g. `Team`). Unset → `null` / `[]` |
| `aee-jira comments KAN-10 [--limit N] [--offset N]` | an issue's comments, newest first, 20 per call (`--limit` max 100): `id`, `author`, `created`, `updated`, plain-text `body`, `origin` (`agent` = your team's, else `human`). `bodyTruncated: true` → full text via `show KAN-10 --comment <id>`; `hasMore: true` → older via `--offset <nextOffset>` |
| `aee-jira statuses --project KAN` | every workflow status the project supports, grouped by issue type — the full set the workflow allows, independent of any issue's current state |
| `aee-jira search --jql "<JQL>" [--fields …] [--limit N]` | any read-only JQL, scoped to the team's bound site & projects — for filters `list` can't express |
| `aee-jira attachment get KAN-6 <id> [--out PATH]` | fetch one attachment's content by id (from `show`) — text prints inline, binary saved to a workspace path |
| `aee-jira attachment add KAN-6 <path> [<path>…]` | upload local files as new attachments; per-file result with each created id |
| `aee-jira comment KAN-6 --body "…"` | add a comment |
| `aee-jira update KAN-6 --description "…"` | replace the description (keep the human's text and add a section — the old text stays in Jira's history) |
| `aee-jira set-field KAN-6 --field "Team" --value "<v>"` | set a custom field by its Jira name (any, unless a Team Admin set a `writable-custom-fields` list); for Team pass the id from `show --fields "Team"` |
| `aee-jira users "Anna" [--project KAN \| --issue KAN-10]` | **find people to assign** — Jira identifies a person by an accountId, never a name or e-mail, and every assignee (`edit --assignee`, `create-issue --assignee`, `"assignee"` in a `create-epic` / `add-stories` payload) takes that accountId. Search a name or e-mail fragment; each match has `accountId`, `displayName`, `email` (`null` unless Jira shows it, never guessed), `active` and `accountType` (`app` = a bot). With `--project` / `--issue` only active, assignable people there come back. Same-name matches are all listed (see `note`) — tell them apart by e-mail or ask, never pick one. No match → empty list + *No user found*; at most 50 (`truncated: true` = more existed). To assign: `users` → `edit KAN-10 --assignee <accountId>` |
| `aee-jira link KAN-1 blocks KAN-2` / `aee-jira link-types` | link two existing issues — read it as a sentence: the first key is the subject ("is blocked by" flips it); a type name such as `Blocks` means its outward phrase. `link-types` lists the site's types (name, outward / inward phrase). An identical link is reported, not duplicated. `show` lists an issue's `links` (`id`, `type`, `relationship`, `otherIssue`, `statement`) |
| `aee-jira unlink 10001` / `aee-jira unlink KAN-1 blocks KAN-2` | remove a link by its id (from `show`) or by the same sentence; a link that does not exist is refused and nothing changes |
| `aee-jira transition KAN-6 --to "In Progress"` | move the issue on — itself a status change, waking whichever teammate's trigger names that target status |
| `aee-jira create-epic --project KAN --file plan.json` | create one Epic and its child Stories in one call (summary, assignee, status, custom fields per Story); reports each key or a per-Story error |
| `aee-jira add-stories --epic KAN-12 --file stories.json` | add Stories to an **existing** Epic (never creates one). Payload `{"stories": [...]}`, same per-Story fields as `create-epic`; Stories land in the Epic's project. `--type Bug` (or per-issue `"type"`, which wins; `"issues"` may replace `"stories"`) creates Bugs, Tasks or any normal type the project offers, case-insensitive, with optional `priority`/`labels` per issue. Refused up front if the key is missing, outside scope, not an Epic (error names its type), or the payload is empty; an unknown type (error lists the types), an Epic/sub-task type, or a missing required field fails only that issue. Reports each key or per-Story error (exit 1 if any failed). One call per Epic |
| `aee-jira add-subtasks --parent KAN-10 --file subtasks.json` | **Sub-tasks under an existing Story/Task/Bug** — `{"subtasks": [...]}`, `create-issue`'s fields; `--type` if the project has several sub-task types. Refused under an Epic or Sub-task |
| `aee-jira create-issue --project KAN --type Bug --summary "Login fails"` | create **one standalone issue** (no Epic) of any normal type the project offers (Story, Task, Bug, or the project's own name such as *Fehler*). Optional `--description`, `--assignee <accountId>`, `--priority`, `--label` (repeatable), `--field "Team=42"` (repeatable), `--status` (moved there right after). Returns the new key and link. Refused up front if the project is outside scope, the type is unknown (error lists the types), an Epic (use `create-epic`) or a sub-task, or a required field is missing (error names it). If the status move fails the issue still exists and the result says why (exit 1) |
| `aee-jira set-epic KAN-30 KAN-31 --epic KAN-12` / `aee-jira set-epic KAN-30 --none` | put **existing** issues under an Epic, move them between Epics, or remove them (`--none`). Refused up front if the target is missing, outside scope or not an Epic. Each issue gets its own outcome — added, moved, removed, *already under KAN-12* (a success), or failed with the reason (not found / outside scope, an Epic or sub-task, or Jira's refusal); one bad key does not stop the others (exit 1 if any failed). Marked as the team's own write |
| `aee-jira edit KAN-10 --summary "…" --priority High --add-label backend` | change the **standard fields** of an existing issue — summary, assignee (`--assignee <accountId>` / `--unassign`), priority (by name), labels, components, fix versions (`--add-…` / `--remove-…` one value without touching the rest, or `--set-…` to replace the whole list) and due date (`--due YYYY-MM-DD` / `--clear-due`). Several fields apply together or not at all. An unknown priority, component or version is refused with the list of what exists (nothing created); a spaced label or bad date is refused up front; a field not on the edit screen is named. The result shows each field's old/new value (*unchanged* if equal). Marked as the team's own write |
| `aee-jira sprint list --board "<board name>"` | list a Scrum board's sprints (id, name, state, start/end), the board resolved by its human-readable name. Read-only |
| `aee-jira sprint create --board "<board name>" --name "<name>" --start <date> --end <date>` | create one future sprint on the board (a Scrum board has only one active sprint) |
| `aee-jira sprint bulk-create --board "<board name>" --name-template "<tmpl>" --until <date>` | pre-create weekly (`--cadence-days`) future sprints up to a date, named from a template such as `Acc2.0 {MMM}_{weekOfMonth}` |
| `aee-jira sprint close --board "<board name>" [--sprint-id <id>]` | complete (close) the board's active sprint (`--sprint-id` closes a specific one). Reports the count of issues left incomplete — they stay on the closed sprint |
| `aee-jira sprint start --board "<board name>" [--sprint-id <id>]` | start (activate) the board's next future sprint (`--sprint-id` for a specific one). Refused if the board already has an active sprint or the sprint has no dates |
| `aee-jira sprint advance --board "<board name>" [--close-id <id>] [--start-id <id>]` | roll the board over in one call: close the active sprint, then start the next future one — each half reported separately, so a partial result is visible (exit 1 on a partial) |
| `aee-jira version list/create/release --project KAN` | project versions: `list`, `create --name 1.5`, `release --name 1.4 [--date] [--move-to 1.5]`. See `--help` |

A good wake instruction says exactly that sequence: *"Take the issue key(s) and
event id(s) from the payload, run `aee-jira inbox --consume <id>…` for those
ids, read each issue with `aee-jira show`, do the work, write it back with
`aee-jira update`, then `aee-jira transition` it to the next status."* The inbox
is shared by the whole team. Consume only the ids from your own wake: the broker
cannot tell agents apart (one scope token per team), so a teammate's events stay
queued only while each agent drains just what it was woken for.

## When a Jira event does not wake the agent

Check in this order:

1. **The trigger's filters.** *Which event* must be blank or the kind
   (`status_changed`, `comment_added`, …); a status name never matches. For a
   status change, *Only when…* must name the exact status the issue moved
   **into** (`toStatus`), spelled as Jira spells it. `origin = human` never
   matches an agent's own write.
2. **The watch.** A `not watched` row on the Activity tab means the watch does
   not forward that kind (its checkbox on Watch config) or, for a status change,
   the status is missing from the watch's status set.
3. **The grant.** The plugin must be activated for this team (Plugins page); the
   trigger form flags a plugin that is not granted.
4. **Already seen.** The broker baselines on its first poll and never re-sends a
   transition it delivered; move the issue again to test.
5. **A watch card shows Failing** — usually an expired token; a Team Admin
   re-sets it on the Plugins page and hits *Retry now*.
6. **`aee-jira inbox --consume` usage error.** `--consume` needs the event ids
   from the payload (`id`, or `events[].id`); a bare `--consume` no longer drains
   the inbox. Fix the wake instruction as above.
