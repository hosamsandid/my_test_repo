---
id: plugin-jira
routes: ["/chats", "/plugins/jira/view", "/plugins"]
title: Jira plugin
summary: How a Jira status change wakes an agent, what the two trigger filters mean for Jira, and what the agent can do with `aee-jira`.
seeAlso:
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Plugins", to: "/plugins" }
askPrompts:
  - "How does a Jira status change wake my agent?"
  - "Which fields can I filter a Jira wake on?"
  - "Why did my agent not wake when the ticket moved to Ready for Dev?"
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
| **Which event** | `status_changed` — the only event the Jira plugin sends today, so *Any event* is equivalent. A status name is **not** an event. |
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

When more than three transitions land in a single poll — on one issue, or
across one project (a bulk move such as sprint planning) — they arrive as one
**digest**, one wake rather than one per ticket. Each agent receives the digest
**narrowed to its own conditions**: a *Ready for Dev* agent sees only the
*Ready for Dev* transitions of that bulk move, never a teammate's. A digest
inlines at most 20 transitions; when there were more it carries
`truncated: true` and `aee-jira inbox` (peek) shows the rest.

## What the woken agent can do — `aee-jira`

The plugin seeds a small command-line tool into a granted agent's workspace.
All Jira access stays server-side in the broker; the agent never sees the token.

| Command | |
|---|---|
| `aee-jira inbox` / `aee-jira inbox --consume <id>…` | the queued status changes of the whole team (peek); `--consume` drains exactly the ids named — use the ids from your own wake (`id`, or `events[].id` in a digest), never a teammate's |
| `aee-jira list --project KAN [--status "Ready for Dev"]`, `aee-jira show KAN-6` | read issues |
| `aee-jira comment KAN-6 --body "…"` | add a comment |
| `aee-jira update KAN-6 --description "…"` | replace the description (keep what the human wrote and add a section — the old text stays in Jira's history) |
| `aee-jira transition KAN-6 --to "In Progress"` | move the issue on — this is itself a status change and wakes whichever teammate's trigger names that target status |

A good wake instruction says exactly that sequence: *"Take the issue key(s) and
event id(s) from the event payload, run `aee-jira inbox --consume <id>…` for
those ids, read each issue with `aee-jira show`, do the work, write it back with
`aee-jira update`, then `aee-jira transition` it to the next status."* The inbox
is shared by every agent on the team. Consume only the ids from your own wake:
the broker cannot tell agents apart (one scope token per team), so a
teammate's queued events stay queued only as long as each agent drains just
what it was woken for.

## When a transition does not wake the agent

Check in this order:

1. **The trigger's filters.** *Which event* must be blank or `status_changed`;
   a status name there never matches. *Only when…* must name the exact status
   the issue moved **into** (`toStatus`), spelled as Jira spells it.
2. **The watch.** On the plugin's Activity tab a `not a watched status` row
   means the status is missing from the watch's status set (Watch config page,
   Team Admin).
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
