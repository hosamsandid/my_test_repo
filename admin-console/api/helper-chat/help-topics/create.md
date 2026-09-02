---
id: create
routes: ["/create", "/quickstart"]
title: Creating something new
summary: The four ways to start — describe it, use a ready-made setup, build it yourself, or spin up one assistant — and what each of them actually creates.
seeAlso:
  - { label: "Agent Team Wizard", to: "/team-setup" }
  - { label: "Flows", to: "/flows" }
  - { label: "Agents", to: "/agents" }
  - { label: "Working Environments", to: "/environments" }
  - { label: "Model Providers", to: "/models" }
  - { label: "SSH Keys", to: "/ssh-keys" }
  - { label: "GitHub Tokens", to: "/github-tokens" }
askPrompts:
  - "Which of the four ways to start should I pick?"
  - "What exactly gets created when I create one assistant?"
  - "Do I have to decide between a single agent and a team up front?"
  - "What do I need before I can create anything?"
  - "I entered a repository URL — why is my assistant not called what I typed?"
---

## One front door

**+ Create** is the single entry point for starting something new. It is reachable
from the persistent control in the sidebar and from the `/create` route — both
open the same launcher.

The launcher asks *how* you would like to start, not *what kind of thing* you are
making. You never have to know the words agent / team / flow / template to choose,
and none of the four tiles is a highlighted default: they are equally ranked
because none of them is the "right" one. You can always change direction later.

## The four ways in

| Entry | What it does | Where it lands |
|---|---|---|
| **Describe what you need** | Tell it in plain language what you want done. The Flow Copilot drafts a flow and shows a live preview — nothing is created until you confirm. | A new draft in the Flows canvas |
| **Start from a ready-made setup** | Pick a proven template (or one of your saved drafts) and adjust it. The fastest route to a working team when a pattern already fits. | The Agent Team Wizard, on its template gallery |
| **Build it yourself** | Lay the pieces out on the canvas and connect them yourself. Full control from a blank slate. | A fresh, empty draft in the Flows canvas |
| **Just give me one assistant to chat with** | Spin up a single assistant you can talk to right away — no wiring, no roles. | The one-assistant form |

Two of these produce a **draft** — an editable flow that is *not* live. Agents
exist only once you materialise the draft into a team. One runs the guided
**wizard**, and one is the **fast lane** to a lone chat agent. They all end in the
same place (running agents); they differ only in how much you decide up front.

## A single agent is a team of one

The one-assistant path is not a different product and not a mode you should have
picked instead. It creates the smallest possible team.
**Grow into a full team** takes you to the Agent Team Wizard when you want
reviewers, a developer or a whole development workflow.

One thing worth knowing before you click it: the wizard **creates a new team** —
it does not convert your existing assistant into one. Your single agent keeps
running independently, and you can retire it afterwards on the Agents page if the
team replaces it.

## What "one assistant" actually creates

The form has one optional field that changes everything: the repository URL.

**Without a repository** — a new repo-less Working Environment bound to the model
provider you selected, plus one standalone chat agent on top of it. Nothing is
cloned. Name and provider are both required here.

**With a repository** the platform does more work for you, in this order:

1. It probes the repository over SSH with the selected key. This validates that
   the key really has access *and* resolves the repository's **default branch**
   from the remote's own HEAD, so nothing assumes `main`.
2. It **reuses** a Working Environment that already points at that repository URL;
   only if none exists does it create one named after the repository. An existing
   environment with no GitHub token attached gets the selected one.
3. It **reuses an existing standalone agent** on that environment if there is one —
   so a second visit with the same repository lands you back in the same chat
   instead of creating a duplicate. The success card says *Agent reused* rather
   than *Agent created* when that happens.

Because step 2 and 3 derive everything from the repository, the **Name** and
**Model Provider** fields are *not used* on the repository path: the assistant is
named after the repository and bound to the environment's provider (the platform
default when the environment has none). Both fields only take effect on the
repo-less path.

Either way you can fine-tune the result afterwards under **Working Environments**
and **Agents** — nothing here is a one-way door.

## What you need first

- A **Model Provider** is always required — it is the only thing an agent runs on.
  Without one, an assistant is created but fails on its first message.
- Add a repository and two more prerequisites apply: an **SSH key** (the clone
  always runs over SSH, even when you paste an HTTPS URL — it is normalised) and a
  **GitHub token** (for pull requests, comments and event polling). The two are
  deliberately separate credentials.

Anything missing is shown on the page as a warning card with a direct link to fix
it, and the submit button spells out exactly what is still outstanding rather than
greying out silently.
