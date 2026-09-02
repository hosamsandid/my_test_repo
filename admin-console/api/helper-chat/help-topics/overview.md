---
id: overview
routes: []
title: Welcome to Agent Studio
summary: A quick tour of the core concepts — the home base of the Help panel.
seeAlso:
  - { label: "Agents", to: "/agents" }
  - { label: "Flows", to: "/flows" }
  - { label: "Working Environments", to: "/environments" }
  - { label: "Knowledge", to: "/knowledge" }
  - { label: "Model Providers", to: "/models" }
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
- **Access & Users** — the human tenant (a *Team*) that every agent, environment
  and credential belongs to, plus the people in it. This is *not* the Agent Team
  squad — that lives on the Agents page.
- **Flows** — the wiring diagram of a team: which agent starts the work, how
  outcomes and labels hand off between agents, and where a human approves or
  receives the result. Design it visually, then materialise it into a live team.
- **Working Environments** — where an agent runs and which repository it clones,
  together with the credentials (SSH key or GitHub token) it uses.
- **Knowledge** — the team-shared memory: durable facts, entities and
  conventions any agent can learn from. The best lessons distil into **Skills**.
- **Model Providers** — connect the platform to the LLMs your agents run on (for
  example Anthropic Claude). Setting up at least one provider is the one
  prerequisite before an agent can do any work.

## Where to go next

- **Create a single agent** — the fastest way to get one assistant running.
- **Set up a team** — wire several agents into a process with the Agent Team
  Wizard.
- **Connect a model provider** — the required first step if you have not yet.

Already have agents? Head to **Agent Chat** to talk to them, or take the guided
**Tour** from the tab above.
