---
id: credentials
routes: ["/ssh-keys", "/github-tokens", "/my-credentials"]
title: Credentials & GitHub access
summary: Agents reach Git and GitHub with two different credentials — an SSH key for repository transport and a GitHub token for API actions and writes — kept apart on purpose so a leak of either has a narrow blast radius.
seeAlso:
  - { label: "SSH Keys", to: "/ssh-keys" }
  - { label: "GitHub Tokens", to: "/github-tokens" }
  - { label: "My Credentials", to: "/my-credentials" }
  - { label: "Working Environments", to: "/environments" }
  - { label: "Access & Users", to: "/teams" }
  - { label: "GitHub Event Log", to: "/github-events" }
askPrompts:
  - "Why do I need both an SSH key and a GitHub token?"
  - "Which credential does an agent use when it opens a pull request?"
  - "Can a System Admin see my personal credentials?"
  - "How do I rotate a leaked GitHub token?"
  - "Why can't I delete this SSH key?"
---

## Two credentials, two jobs

Agent Studio stores two kinds of Git/GitHub credential, and an agent normally
has both.

| | **SSH key** | **GitHub token** (PAT) |
|---|---|---|
| Authenticates | Git **transport** over an `ssh://` / `git@…` remote — clone, fetch, push | GitHub's **API**: the Events poller, `gh` / `gh-as-agent` (pull requests, reviews, comments) and HTTPS git |
| Can be narrowed to | A single repository, as a read-only **deploy key** | Repository and organisation permissions, but never below "this whole account/org surface" |
| Registered as | The **private** key here; the matching **public** key goes on the Git host (GitHub → Settings → SSH and GPG keys) | The token value here |
| Reaches the agent as | An SSH agent configured in the workspace at creation time | `GH_TOKEN` and `GITHUB_TOKEN` environment variables in every agent process of the Working Environment |
| Read back afterwards | Never — only a SHA256 **fingerprint** | Never — only a **preview** (prefix + last 4 characters) and a fingerprint |

Which one a repository needs follows from its URL: an **SSH URL needs a key**, an
**HTTPS URL needs the token**. A Working Environment can link one SSH key per
repository entry and one GitHub token for the whole environment.

## Why both — the blast-radius split

A token-only setup would technically work: a PAT can clone over HTTPS as well as
open pull requests. The split is a deliberate **defense-in-depth** choice, and it
is the reason both fields exist:

- The **SSH key** covers repository read (clone / fetch) and can be scoped down
  to one repository, read-only. A stolen deploy key **cannot merge a pull
  request, comment as you, or read your other repositories.**
- The **GitHub token** covers API actions and writes — push, PR creation, event
  polling. It is inherently broader, so it is the higher-value secret.

Keeping them separate means the two failure modes do not compound: a leaked PAT
did not already hand over the initial clone path, and a leaked deploy key cannot
act on GitHub. If you collapse both onto one PAT you get one secret whose loss
costs you everything at once.

## Personal, team and system credentials

Every key and token carries an **ownership tier**, and the tier decides both who
may manage it and which page it appears on:

| Tier | Who may create it | Who can see and manage it | Shown on |
|---|---|---|---|
| **Personal** | Any authenticated human, for themselves | **Only the owner** — no other human, *including a System Admin* | **My Credentials** |
| **Team** | Team Admin of that access scope (or a System Admin) | Team Admins of that scope; System Admins | **SSH Keys** / **GitHub Tokens** |
| **System** | System Admin only | System Admins, plus Team Admins of the scopes it is assigned to | **SSH Keys** / **GitHub Tokens** |

Personal privacy is strict and has **no administrator break-glass**: there is no
override that lets anyone list, read or manage another person's personal
credential, ownership is fixed at creation, and when a human is offboarded their
personal secrets are deleted rather than transferred. The admin pages filter
personal entries out of their tables, so the two tiers never blur together.

The environment single-admin login operates the platform rather than being a
person, so it has no user record and cannot own personal credentials — sign in
with your own account for that.

## Which credential an agent actually uses

The choice is made **per operation class**, because attribution and transport
differ:

- **Attributed writes** — commits, pull requests, reviews, HTTPS pushes — prefer
  the agent owner's **personal** credential, then team, then system. These carry a
  human's name, so they should run under that human's identity.
- **Reads** — clones, the repository probe, SSH-only transport — are happy with a
  shared team/system credential; nobody is misattributed.
- **Event polling** of a repository always uses a shared team/system token: the
  poller is per-repository infrastructure, not per-human.

`personal → team → system` is a **preference among tiers, not a fallback for a
missing personal credential.** When an attributed write prefers the personal tier
and the owner has none (or a PAT without the `repo` / `workflow` scope), the run
is **refused** with an actionable message instead of silently acting under a
shared identity. An agent that carries no owner at all keeps using the shared
credential exactly as before and is never refused.

## Rotation and deletion

- **Personal** keys and tokens **rotate in place** — the secret is replaced while
  the id, name and owner stay — and the owner's affected running agents are
  restarted so they pick up the new value. That interrupts in-flight work, so
  rotate at a quiet moment.
- **Team / system** credentials are rotated the **create-new-and-repoint** way:
  add the new credential, then change the Working Environment's field to it. The
  Edit panel can only rename a credential and change which scope owns it — the
  secret itself is create-only.
- A credential can only be **deleted once nothing references it**. The **Used by**
  column names the Working Environments holding on to it, and the delete dialog
  lists the ones you have to detach first.

## What a GitHub token needs to be able to do

For a **classic** token: `repo`, `workflow`, and `read:org` (tick only that child
under `admin:org`). For a **fine-grained** token: **Contents** read & write,
**Metadata** read, **Pull requests** read & write, **Workflows** read & write, and
organisation **Members** read.

If your organisation enforces **SAML SSO**, authorising the credential for each
org is a required extra step — the create dialogs on **SSH Keys**, **GitHub
Tokens** and **My Credentials** walk you through it at the moment you add the
secret, together with the reminder that GitHub shows a token value only once.

Commits and PR bodies written by agents are stamped with an agent-identity
marker, which is what stops the Events poller from waking an agent on its own
output.
