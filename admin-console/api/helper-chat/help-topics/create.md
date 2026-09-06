---
id: create
routes: ["/create", "/quickstart"]
title: Creating something new
summary: The five ways to start — describe it, use a ready-made setup, build it yourself, spin up one assistant, or fill in a single agent yourself — what each of them actually creates, and what has to be in place first.
seeAlso:
  - { label: "Agent Team Wizard", to: "/team-setup" }
  - { label: "Flows", to: "/flows" }
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Working Environments", to: "/environments" }
  - { label: "Model Providers", to: "/models" }
  - { label: "SSH Keys", to: "/ssh-keys" }
  - { label: "GitHub Tokens", to: "/github-tokens" }
askPrompts:
  - "Which of the five ways to start should I pick?"
  - "What is the difference between one assistant and creating a single agent?"
  - "What exactly gets created when I create one assistant?"
  - "Do I have to decide between a single agent and a team up front?"
  - "What do I need before I can create anything?"
  - "I entered a repository URL — why is my assistant not called what I typed?"
  - "Does growing into a full team convert my existing assistant?"
  - "Why is the create button still disabled?"
---

## The entry paths

**+ Create** is the single front door for starting something new. It is reachable
from the persistent control in the sidebar and from the `/create` route — both
open the same launcher.

The launcher asks *how* you would like to start, not *what kind of thing* you are
making. You never have to know the words agent / team / flow / template to choose
among the first four, and none of them is a highlighted default: they are
**equally ranked** because none of them is the "right" one. You can always change
direction later.

The fifth entry is deliberately different. **Create a single agent** is the "I
already know exactly what I want" path and is the one place the launcher names
the artifact, because that is the point of it.

### What each tile produces

| Entry | What it does | Where it lands |
|---|---|---|
| **Describe what you need** | Tell it in plain language what you want done. The Flow Copilot drafts a flow and shows a live preview — nothing is created until you confirm. | A new draft in the Flows canvas |
| **Start from a ready-made setup** | Pick a proven template (or one of your saved drafts) and adjust it. The fastest route to a working team when a pattern already fits. | The Agent Team Wizard, on its template gallery |
| **Build it yourself** | Lay the pieces out on the canvas and connect them yourself. Full control from a blank slate. | A fresh, empty draft in the Flows canvas |
| **Just give me one assistant to chat with** | Spin up a single assistant you can talk to right away — no wiring, no roles. | The one-assistant form |
| **Create a single agent** | Fill in the fields yourself: id, role, Working Environment, skills, system prompt. Nothing is inferred and nothing else is created alongside it. | A panel on this page |

### A draft, a wizard, a fast lane, or a form

The five tiles produce four different *kinds* of result, and the difference is
worth knowing before you click.

**A draft that is not live yet.** *Describe what you need* and *Build it
yourself* both leave you with an editable flow on the Flows canvas. A **draft**
is a plan, not a running system: no agent exists, nothing is polling GitHub,
nothing is costing you anything. Agents come into existence only when you
**materialise** the draft into a team, and until then you can rename roles, add
and delete nodes, or throw the whole thing away.

**The guided wizard.** *Start from a ready-made setup* hands you to the Agent
Team Wizard on its template gallery. It walks you through template → Working
Environment → team → knowledge → review, and it does create real agents — at the
end, at the point where it says it will.

**The fast lane.** *Just give me one assistant to chat with* is the one path that
skips every decision it can. It is described in full below.

**The direct form.** *Create a single agent* opens a panel on the launcher
itself, so the four guided tiles stay visible behind it. It is the same form the
Agents page uses, so what it produces is identical.

### One assistant, or one agent?

The two single-agent paths are not the same thing, and the difference is who
decides.

**Just give me one assistant to chat with** is the fast lane: you give it a name
(or a repository) and it works out the rest — it creates or reuses a Working
Environment, picks the branch off the remote, and names the assistant after the
repository. Choose it when you want to be talking to something in a minute.

**Create a single agent** decides nothing for you. You pick the id, the role
(a plain agent, an Agent Team template or an orchestrator), the Working
Environment it binds to, its skills and its system prompt — and it creates
exactly that, on an environment that must already exist. Choose it when the
answer to each of those is already settled.

Both leave you with something you can grow later; neither is a one-way door.

## A single agent is a team of one

The one-assistant path is not a different product and not a mode you should have
picked instead. It creates the smallest possible team: one agent, on one Working
Environment, with a chat room of its own. Everything a larger team has — skills,
knowledge, triggers, a system prompt — this one agent has too. It simply has no
colleagues yet.

That framing is what saves you from having to classify your problem up front.
Start with one assistant, find out what the work actually needs, and add the rest
once you know.

### Growing creates a new team, it does not convert this one

**Grow into a full team** takes you to the Agent Team Wizard when you want
reviewers, a developer or a whole development workflow.

One thing worth knowing before you click it: the wizard **creates a new team** —
it does not convert your existing assistant into one. Your single agent keeps
running independently, with its own chat history, and you can retire it
afterwards on the Agents page if the team replaces it. Nothing moves across on
its own, so if the assistant has accumulated knowledge or skills you want the
team to have, carry them over deliberately from the Knowledge and Skills pages.

## The repository fast lane

The one-assistant form has one optional field that changes everything: the
repository URL.

### Without a repository

You get a new repo-less Working Environment bound to the model provider you
selected, plus one standalone chat agent on top of it. Nothing is cloned. The
**Name** and **Model Provider** fields are both required here, and both are used
exactly as you set them.

### With a repository

The platform does more work for you, in this order.

1. **The SSH probe.** It contacts the repository over SSH with the selected key
   before anything is created. That single step does two jobs: it validates that
   the key really has access — so a wrong or unauthorised key fails here, with an
   error, instead of half-way through a clone — *and* it resolves the
   repository's **default branch** from the remote's own HEAD, so nothing assumes
   `main`. A repository living on `master`, `develop` or anything else is picked
   up correctly without being asked.
2. **Environment reuse.** It **reuses** a Working Environment that already points
   at that repository URL; only if none exists does it create one named after the
   repository. An existing environment with no GitHub token attached gets the
   selected one. This is what stops a team accumulating five near-identical
   environments for one repository.
3. **Agent reuse.** It **reuses an existing standalone agent** on that
   environment if there is one — so a second visit with the same repository lands
   you back in the same chat instead of creating a duplicate. The result card
   tells you which happened: it reads *Agent reused* rather than *Agent created*,
   and marks the environment *(reused)* or *(new)* on the line below.

### Why Name and Model Provider are not used here

Because steps 2 and 3 derive everything from the repository, the **Name** and
**Model Provider** fields above the URL are **not used** on the repository path.
The assistant is named after the repository, and it runs on the provider the
resolved Working Environment already carries (the platform default when that
environment has none). The two fields stay on screen because clearing the URL
puts you straight back on the repo-less path, where they *are* used — but if you
type a name, paste a repository URL and submit, the name you typed is not the
name you get.

Either way you can fine-tune the result afterwards under **Working Environments**
and **Agents** — nothing here is a one-way door.

## What you need before you start

- A **Model Provider** is always required — it is the only thing an agent runs on.
  Without one, an assistant is created but fails on its first message.
- Add a repository and two more prerequisites apply: an **SSH key** (the clone
  always runs over SSH, even when you paste an HTTPS URL — it is normalised) and a
  **GitHub token** (for pull requests, comments and event polling). The two are
  deliberately separate credentials: the key moves code, the token moves
  conversation.

Nothing is hidden from you while a piece is missing. Each one shows up on the page
as a warning card with a direct link to the page that fixes it, and the create
button spells out what is still outstanding in a short checklist rather than
greying out silently.

The card and the checklist answer slightly different questions, which is why you
sometimes see one without the other. A **warning card** says *this platform has
no model provider / no SSH key / no GitHub token at all*, and appears as soon as
that is true. The **checklist** under the form says *this submission cannot go
through yet*, and lists only what blocks the form as you have filled it in. On
the repository path the platform binds the environment's provider for you, so a
missing provider shows as a card but does not block the button; on the repo-less
path an empty name blocks the button with no card at all.
