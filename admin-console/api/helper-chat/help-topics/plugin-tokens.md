---
id: plugin-tokens
routes: ["/plugin-tokens"]
title: Plugin Tokens
summary: Your own credential for a plugin such as Jira — used whenever YOU chat with an agent, so what the agent does in that plugin is done as you, under your permissions.
seeAlso:
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Plugins", to: "/plugins" }
  - { label: "GitHub Tokens", to: "/github-tokens" }
askPrompts:
  - "Why does the agent say I have no personal Jira credential?"
  - "Which Jira account does the agent use in a chat?"
  - "Which account do scheduled runs use?"
  - "Can an admin see my Jira token?"
  - "How do I rotate my Jira API token?"
---

## What a plugin token is

Some plugins act in an outside system on someone's behalf — Jira is the
reference example. When **you** chat with an agent and it reads or changes a
Jira issue, it does so with **your own** Jira account: the issue history shows
you as the author, and Jira's own permissions decide what you may see.

This page holds that personal credential — for Jira, your Atlassian **e-mail**
and an **API token** (create one at id.atlassian.com → Security → API tokens).
The Jira **site** and the team's service account stay team settings — a Team
Admin configures them in **Agent Chat → Settings → Plugins** (a System Admin can
also reach them on the Plugins registry page).

Your token alone is not enough: the team's Jira **site** must also be set. If it
is not, this page shows a warning on the plugin's card — add your token here and
ask your Team Admin to set the site. The first time you ask an agent to use Jira,
its reply lists **everything** still missing at once (your token, the team site,
or both) and who fixes each, so you are not sent from one error to the next.

## Chat turns vs automated runs

| Run | Jira account used |
|---|---|
| A chat message you send | **Your** plugin token — never the team's. Without one, every Jira command is refused with a pointer to this page, and nothing is sent to Jira. |
| Schedules, loops, GitHub events, hand-offs between agents | The team's **service account** (a Team Admin sets it in Agent Chat → Settings → Plugins, or a System Admin on the Plugins page). Without one, the command fails with "no service account". |

A chat message from someone who is not a member of the agent's team is refused
outright. The platform works out who sent a message from the chat server itself,
so an agent cannot claim to be acting for someone else.

## Privacy, rotation and removal

Your token is stored on the platform host in a file only the platform process
can read, and no page or API reads it back — to anyone, System Admins included. This page only ever shows whether a value is
set, a short preview and when it was saved. The token never enters an agent
container; the plugin fetches it for a single call and forgets it.

To rotate, save a new token over the old one. If Jira rejects your token (for
example it expired) the agent tells you to renew it here. Delete removes it; so
does removing your user account.
