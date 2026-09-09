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
  - { label: "Administration", to: "/users" }
  - { label: "GitHub Event Log", to: "/github-events" }
askPrompts:
  - "Why do I need both an SSH key and a GitHub token?"
  - "Which credential does an agent use when it opens a pull request?"
  - "Can a System Admin see my personal credentials?"
  - "How do I rotate a leaked GitHub token?"
  - "Why can't I delete this SSH key?"
  - "What scopes does a GitHub token need?"
  - "Should this key belong to a team or to me personally?"
  - "Why does My Credentials say I can't have personal credentials?"
---

Three pages share this one explanation — **SSH Keys**, **GitHub Tokens** and
**My Credentials** — because they are three views of the same subject. The "?" on
each page opens the chapter written for that page; the chapters either side of it
are the shared story, one scroll away.

## Why both an SSH key and a GitHub token

Agent Studio stores two kinds of Git/GitHub credential, and an agent normally has
both.

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

A token-only setup would technically work: a PAT can clone over HTTPS as well as
open pull requests. The split is a deliberate **defense-in-depth** choice, and it
is the reason both fields exist:

- The **SSH key** covers repository read (clone / fetch) and can be scoped down to
  one repository, read-only. A stolen deploy key **cannot merge a pull request,
  comment as you, or read your other repositories.**
- The **GitHub token** covers API actions and writes — push, PR creation, event
  polling. It is inherently broader, so it is the higher-value secret.

Keeping them separate means the two failure modes do not compound: a leaked PAT
did not already hand over the initial clone path, and a leaked deploy key cannot
act on GitHub. Collapse both onto one PAT and you get a single secret whose loss
costs you everything at once — the blast-radius argument in one sentence.

## SSH keys

The **SSH Keys** page holds the shared **team** and **system** keys: the private
keys that authenticate git transport for the repositories your Working
Environments clone. Personal keys are deliberately not listed here — they live on
**My Credentials** — so the two tiers never blur together in one table. The page
itself is reachable by a System Admin or a Team Admin of at least one access
scope; which rows you may then edit or delete follows the tier table below.

The table shows **ID** (what a Working Environment refers to, and the filename the
secret is stored under), **Name**, **Scope / Teams**, **Fingerprint**, **Added**
and **Used by**, plus a rename/reassign pencil and a delete bin per row.

**Adding a key — two ways.** *New Key* opens a panel with two tabs:

- **Generate new keypair** — the server creates a fresh ed25519 pair, keeps the
  private half, and shows you the **public** key exactly once, with a *Copy public
  key* button and a link straight to GitHub's *Add new SSH key* form. There is no
  second chance to read it here; if you lose it, generate a new pair.
- **Paste existing key** — you supply a private key you already have. The panel
  keeps a step-by-step guide for producing one
  (`ssh-keygen -t ed25519 -C "agent-studio-deploy-key"`) and for registering the
  public half under GitHub → *Settings* → *SSH and GPG keys* → *New SSH key*.

Either way the key gets a **Name** (a human label) and an **ID** (auto-derived
from the name, editable), and you pick its ownership tier — see *Ownership tiers
and privacy* below.

**Prefer a deploy key where you can.** A key registered on a single repository as
a read-only deploy key is the narrowest useful credential in the system, and it is
worth choosing wherever an agent only needs to read one repository.

**SAML SSO.** If your organisation enforces SAML SSO, adding the public key to
GitHub is not enough: open the key in GitHub's SSH key list, click **Configure
SSO**, and authorise it for every org whose repositories the agents touch —
otherwise SSO-protected repositories reject the connection. The panel says so at
the moment you add the key, which is where the instruction is actually useful.

**What comes back afterwards.** Only the SHA256 fingerprint. The private key is
stored at mode 0600 in the workspace volume and is never returned by the API
again — not to a System Admin either.

**Deleting.** A key can only be deleted once nothing references it. The **Used by**
column shows how many Working Environments hold on to each key (hover for their
names), and the delete dialog lists the blocking environments so you know exactly
where to detach it first. That list is advice, not a lock — the button stays
active and the **server** is what refuses, so a stale view can never let a
still-referenced key through. Until environment data has loaded the column shows
`—` rather than a misleading "None".

**Using a key.** Assign it to a repository entry in a Working Environment. When an
agent is created, the orchestrator clones with that key and configures the
workspace's SSH agent accordingly.

## GitHub tokens

The **GitHub Tokens** page holds the shared **team** and **system** GitHub
Personal Access Tokens. A token is injected as `GH_TOKEN` and `GITHUB_TOKEN` into
every agent process of the Working Environment it is linked to, so the agents in
one environment share one token instead of each carrying their own. Personal
tokens are filtered out here and managed on **My Credentials**.

The table shows **ID**, **Name**, **Scope / Teams**, **Token** (a masked preview:
prefix plus the last four characters), **Fingerprint**, **Added** and **Used by**,
plus the edit and delete actions.

**What the token is for** — three things the SSH key cannot do:

- **The Events poller** — watching a repository for the issues, pull requests and
  comments that fire your triggers.
- **`gh` and `gh-as-agent`** — opening pull requests, posting reviews and
  comments, reading issues.
- **HTTPS git** — cloning and pushing over an `https://` remote, and the
  real-time repository-check probe.

**Adding a token.** *New Token* opens a panel whose step guide walks the whole
GitHub side: where the token screens live, which of the two token types to pick,
and exactly which permissions to tick.

- **Tokens (classic)** — the recommended and tested path: `repo` (full control —
  clone, commit, push, PRs, metadata), `workflow` (needed when agents touch
  GitHub Actions workflow files) and `read:org` (read-only — expand `admin:org`
  and tick only that one child, leaving the parent and its siblings unchecked).
  Ticking the parent `repo` box auto-selects its five sub-scopes; leave them on.
- **Fine-grained tokens** — the alternative when org policy demands
  per-repository scoping: **Contents** read & write, **Metadata** read-only,
  **Pull requests** read & write, **Workflows** read & write, plus organisation
  **Members** read-only (the equivalent of `read:org`).

Then give the token a **Name** and an **ID**, choose its ownership tier, and paste
the value — fine-grained tokens start with `github_pat_`, classic ones with
`ghp_`.

**Two things happen exactly once.** GitHub shows a token value only at creation,
so copy it before you leave that page; and Agent Studio likewise never shows it
again — only the preview and the fingerprint remain. Both warnings live in the
create dialog rather than here, because that is the moment they matter.

**SAML SSO** applies to tokens too: open the token in GitHub's token list, click
**Configure SSO**, and authorise it for every relevant org. Without that step the
token works against personal repositories but is rejected by SSO-protected org
repositories.

**Editing.** The Edit panel renames a token and — for a System Admin — changes
which scope or team owns it. It cannot change the secret: a token value is set
once, at creation. Rotation therefore works differently here than on the personal
tier; see the last chapter.

**Deleting** behaves exactly as for SSH keys: blocked while a Working Environment
still references the token, with **Used by** and the delete dialog naming the
environments to detach it from.

**Loop protection is not the token's job.** Every agent in an environment shares
its one token, so an event caused by an agent looks exactly like one caused by a
human and a trigger fires on either. `gh-as-agent` stamps commits and PR bodies
with an agent-identity marker, but that stamp is attribution for humans reading
GitHub — the poller does not read it. Feedback loops are bounded by frequency
instead: a per-conversation rate throttle and a burst digest.

## My Credentials

**My Credentials** is the self-service page where any authenticated human manages
their **own** personal SSH key and GitHub token. It has no admin gate — a plain
Team Member reaches it just like a Team Admin — because everything it shows is
already private to the person looking at it.

The page has two sections, one per credential kind, each with its own table and a
*New key* / *New token* button:

| Section | Columns |
|---|---|
| Personal SSH key | **Name**, **Fingerprint**, **Added** |
| Personal GitHub token | **Name**, **Token** (masked preview), **Fingerprint**, **Added** |

There is no *Scope / Teams* column and no *Used by* column: a personal credential
has exactly one owner and is not linked to a Working Environment at all — the
runtime picks it up from the agent's owner instead (see the last chapter).

Each row offers three actions:

- **Rename** — a name-only change; the secret is untouched.
- **Rotate** — replace the secret while keeping the same id, name and owner. For
  an SSH key you can either paste a replacement private key or have the server
  generate a fresh keypair and show you the new public key once, exactly as at
  creation. Remember to update the public half on GitHub, and to re-run
  **Configure SSO** for a SAML SSO org.
- **Delete** — permanent, and it affects only you. Agents relying on that
  credential fail to authenticate until you add a replacement.

Creating a personal credential works like the admin pages minus the ownership
picker: the owner is always the signed-in caller, forced server-side, and cannot
be set to somebody else. Personal SSH keys are **account-wide** — one key covers
all of your repositories; per-repository personal deploy keys are not offered.

**Everyone who can sign in can own one.** The personal tier needs a real user
record to hang ownership on, and every principal that can sign in now has one —
including the first administrator, which is itself an ordinary System-Admin
record seeded at first boot. There used to be an exception: a login that came
straight from the deployment's configuration and had no record behind it, which
is why the page still carries a "Personal credentials need a per-user account"
explanation pointing at the shared **SSH Keys** and **GitHub Tokens** pages. It
is a fail-closed guard now rather than a state you can be in.

## Ownership tiers and privacy

Every key and token carries an **ownership tier**, and the tier decides both who
may manage it and which page it appears on:

| Tier | Who may create it | Who can see and manage it | Shown on |
|---|---|---|---|
| **Personal** | Any authenticated human, for themselves | **Only the owner** — no other human, *including a System Admin* | **My Credentials** |
| **Team** | Team Admin of that access scope (or a System Admin) | Team Admins of that scope; System Admins | **SSH Keys** / **GitHub Tokens** |
| **System** | System Admin only | System Admins, plus Team Admins of the scopes it is assigned to | **SSH Keys** / **GitHub Tokens** |

A team credential names one access scope. A system credential instead carries a
list of **assigned teams**, which is how a house-wide token is shared with the
teams that should have it without becoming visible to everyone (assign it to no
team and it stays visible to System Admins only). Both are chosen in the create
panel and shown afterwards in the **Scope / Teams** column. Only a System Admin
may move a credential between scopes later, so a Team Admin editing one sees a
note where the ownership editor would be — and a Team Admin only ever sees
edit/delete actions on **team** credentials of a scope they administer, never on a
system one.

Personal privacy is strict and has **no administrator break-glass**: there is no
override that lets anyone list, read or manage another person's personal
credential, ownership is fixed at creation, and a personal credential can never be
converted into a team or system one (or back) — create a fresh credential instead.
The admin pages filter personal entries out of their tables, so the two tiers stay
visually and navigationally distinct.

**Offboarding follows the same rule.** When a human is deactivated or removed,
their agents are first **paused** — disabled in place, not wiped, so in-flight
work stops rather than continuing under a departed identity — and then all of
their **personal** keys and tokens are deleted outright: index entries and secret
files both. Their team and system credentials are shared infrastructure and are
never touched. Nobody reads or inherits a departed person's secrets on the way
out; to continue the work, re-own the affected agents to a present human who
supplies their own.

## Rotation and runtime resolution

**Rotation depends on the tier, because the two tiers hold the secret
differently.**

- **Personal** keys and tokens **rotate in place** — the secret is replaced while
  the id, name and owner stay — using the *Rotate* action on My Credentials.
  Afterwards the owner's affected running agents are **automatically restarted**
  so they pick up the new value immediately; only yours, never anyone else's. That
  restart interrupts any in-flight work in those agents, so rotate at a quiet
  moment.
- **Team and system** credentials are rotated the **create-new-and-repoint** way:
  add the new credential, then change the Working Environment's *SSH Key* or
  *GitHub Token* field to it. The Edit panel can only rename a credential and
  change which scope owns it — the secret itself is create-only. Repointing the
  environment restarts its running agents for the same reason, and disabled agents
  pick the fresh credential up the next time they are enabled.

**Which credential an agent actually uses** is decided **per operation class**,
because attribution and transport differ:

- **Attributed writes** — commits, pull requests, reviews, HTTPS pushes — prefer
  the agent owner's **personal** credential, then team, then system. These carry a
  human's name, so they should run under that human's identity.
- **Reads** — clones, the repository probe, SSH-only transport — are happy with a
  shared team/system credential; nobody is misattributed.
- **Event polling** of a repository always uses a shared team/system token: the
  poller is per-repository infrastructure, not per-human.

"The agent's owner" is a single, deterministic human: for a team member it is the
parent Agent Team's owner, so a team operated by several people still writes under
exactly one identity no matter which event woke the run. A cron or GitHub-event
run reads that owner from the stored configuration, never from whoever caused the
event.

`personal → team → system` is a **preference among tiers, not a fallback for a
missing personal credential.** When an attributed write prefers the personal tier
and the owner has none — or has a PAT without the `repo` / `workflow` scope — the
run is **refused** with an actionable message instead of silently acting under a
shared identity. An agent that carries no owner at all keeps using the shared
credential exactly as before and is never refused, so an environment that has
never used the personal tier behaves as it always did.
