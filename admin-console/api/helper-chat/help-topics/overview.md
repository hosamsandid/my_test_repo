---
id: overview
routes: []
title: Welcome to Agent Studio
summary: A quick tour of the core concepts — the home base of the Help panel.
seeAlso:
  - { label: "Administration", to: "/users" }
  - { label: "Flows", to: "/flows" }
  - { label: "Environment Templates", to: "/environment-templates" }
  - { label: "Knowledge", to: "/knowledge" }
  - { label: "Model Providers", to: "/models" }
  - { label: "Agent Chat", to: "/chats" }
actions:
  - { label: "Chat with one assistant", to: "/quickstart", primary: true }
  - { label: "Set up a team", to: "/team-setup" }
  - { label: "Connect a model provider", to: "/models" }
  - { label: "Take the Tour", action: "tour" }
askPrompts:
  - "How do I create my first agent?"
  - "What is the difference between an Agent, an Agent Team and a Flow?"
  - "What do I need to set up before an agent can do any work?"
---

## What is Agent Studio?

Agent Studio lets you build and run AI agents — single workers or coordinated
teams — that chat with you or run unattended on schedules and GitHub events.
This overview is the home base of the Help panel: open **Help** on any page to
see help for that page, and use the **← Overview** link to come back here for the
big picture.

## The core concepts

- **Agents** — a single AI worker with its own workspace, prompt and memory. It
  can chat with you or run unattended on schedules and GitHub events, and it
  keeps a private notebook of what it has learned.
- **Administration** — the System-Admin surface: the human user records that can
  sign in, every team on the platform, and which tenant owns each agent and
  environment. Adding somebody to a team is *not* here — that is **Share…** on
  the team itself, in the Agent Chat.
- **Flows** — the wiring diagram of a team: which agent starts the work, how
  outcomes and labels hand off between agents, and where a human approves or
  receives the result. Design it visually, then materialise it into a live team.
- **Working Environment** — where a team's agents run and which repository they
  clone, together with the credentials (SSH key or GitHub token) they use. A
  team edits its own from its **Settings** tab in Agent Chat; a System Admin
  curates reusable **Environment Templates** a new team can start from.
- **Knowledge** — the team-shared memory: durable facts, entities and
  conventions any agent can learn from. The best lessons distil into **Skills**.
- **Model Providers** — connect the platform to the LLMs your agents run on (for
  example Anthropic Claude). Setting up at least one provider is the one
  prerequisite before an agent can do any work.

## Where to go next

The buttons below take you straight there:

- **Chat with one assistant** — the fastest way to get one assistant running.
- **Set up a team** — wire several agents into a process with the Agent Team
  Wizard.
- **Connect a model provider** — the required first step if you have not yet.
- **Take the Tour** — a guided walk-through of the console.

Already have agents? Head to **Agent Chat** to talk to them.
