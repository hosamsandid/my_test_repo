---
id: users
routes: ["/users"]
title: Administration
summary: The one System-Admin surface — the human user records that can sign in, every team on the platform, and which team owns each agent and Working Environment.
seeAlso:
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Environment Templates", to: "/environment-templates" }
  - { label: "My Credentials", to: "/my-credentials" }
  - { label: "SSH Keys", to: "/ssh-keys" }
askPrompts:
  - "What is the Subject and can I change it later?"
  - "I created a user but after logging in they see nothing — what is missing?"
  - "What happens to a user's agents and credentials when I delete them?"
  - "How does a person actually sign in — password or SSO?"
  - "What is the difference between System Admin and Team Admin?"
  - "Where did the Access page go, and how do I add someone to a team now?"
  - "What is the difference between a team and an access scope?"
  - "How do I share one Working Environment with several teams?"
---

## What this page manages

**Administration** is the one place that exists only for System Admins. It has
three tabs:

| Tab | What it manages |
|---|---|
| **Users** | The human user **records** — who can sign in, under which name, with a login password or not, and who is a global System Admin. |
| **All Teams** | Every team on the platform, including the ones you are not a member of. A clean-up view: see them, and delete one. |
| **Resources** | Which tenant owns each agent and Working Environment — the ownership *tiers*. |

Nothing here is where you **add somebody to a team**. That moved to the team
itself: **Share…** in an Agent Team's context menu in the Agent Chat, where the
team's own admins already are. This page is what is left over once sharing is
decentralised — the platform-wide view, not the per-team one.

A record on the Users tab says *who this person is*; it says nothing about **what
they may see**. That is a membership in a team, and a brand-new user with no
membership and no System-Admin flag can sign in and will see **nothing at all**
(the API is fail-closed, not just the UI). Creating the record and forgetting to
share a team with them is the single most common reason for "I logged in and the
console is empty".

The page is open to **System Admins** only, and it needs the orchestrator to be
reachable — user records and teams live in the orchestrator's store, not in the
console.

> **Where the Access page went.** It is gone, and deliberately not renamed. Its
> member management is the **Share…** dialog; its all-teams table and its
> resource-ownership section are the two tabs here; and `/teams` now redirects to
> this page, so an old bookmark still lands somewhere useful.

## The record

| Field | Notes |
|---|---|
| **Subject** | The stable login identity — the OIDC subject claim or the corporate e-mail. It is what a sign-in is matched on, it is unique (case-insensitively), and it is **immutable**: you cannot change it after creation, only delete and re-create. |
| **Display name** | What the console shows. Left empty on create it **defaults to the subject**; on edit it may not be blanked. |
| **E-mail** | Optional, free-text. Purely descriptive — it is *not* what anyone signs in with. |
| **System Admin** | A **global flag on the record**, not a membership — see below. |
| **Login password** | Optional. Stored only as a salted hash; the list shows just **Set** or **None** and the value is never readable back, not even by the account that set it. |

The stored record carries two more fields this form does not expose: a GitHub
handle (API-only) and the per-user chat font size, which the person sets for
themselves in the console's **Settings**.

**Why the Subject cannot change.** It is not a display field with a lock on it —
it is the identity every sign-in is matched against, and nothing else in the
system points back at a user by name. Changing it would
silently sever an existing person from their own account, so the edit form shows it read-only and
the API simply has no way to write it. If a person's identity really changes,
delete and re-create — and note that this is an *offboarding* (see below), so
re-sharing their teams with the new record is part of the job.

## System Admin vs Team Admin

They are different mechanisms, not two levels of one setting:

- **System Admin** is the flag on the record here. It is **global**: every team,
  every resource, plus the operations reserved for it (moving resources between
  tenants, managing users, installing plugins, deleting somebody else's team).
  Note that *creating a team* is **not** one of them — that is self-service for
  everybody.
- **Team Admin** is a **membership** in one team, granted by that team's own
  admins in the **Share…** dialog. It manages that team and its members, and
  nothing outside it.

One person can be Team Admin of one team, Team Member of another, and System
Admin on top of both — the flag supersedes the memberships rather than replacing
them.

**A team can never be left without an admin.** Removing or demoting the *last*
Team Admin is refused unless a successor who is already a member is named in the
same step. Deleting a *user* is refused for the same reason while they are the
last Team Admin of anything.

There is one thing a System Admin still cannot do: see or manage another
person's **personal** credentials. That tier is owned by name, with no
administrative break-glass — which is also why deleting a user *deletes* those
credentials rather than transferring them.

There is **no fourth principal**. The administrator a fresh stack starts with is
an ordinary System-Admin *user record*, seeded once at first boot and managed on
this page like anybody else — no built-in login lives outside the store. See
*How signing in actually works* below for where that first record comes from.

## How signing in actually works

There is exactly **one login path**: the records on this page. A sign-in matches
the *Subject* against the password stored on that record, and nothing else is
consulted — no deployment credential, no second identity hiding behind the
store.

**Where the first administrator came from.** A brand-new stack has no records at
all, so the deployment's configured initial user is used **once, as a seed**: at
first boot — and only while zero records exist — the platform creates one real
System-Admin *user record* from it. That input is either the credential pair
`ADMIN_USERNAME` / `ADMIN_PASSWORD` (shipped as `admin` / `admin`) or, on an SSO
stack, `BOOTSTRAP_SYSTEM_ADMIN_SUBJECT`, which wins when set and seeds a record
with **no** password. Once any record exists the configured value is inert and
is never read again, so re-pointing it at a different subject can neither mint a
second administrator nor re-grant one you deliberately demoted.

So the first administrator **is a user record like anybody else**: it appears in
this list, and it is managed here — display name, e-mail, the System-Admin flag
and the login password all change on this page. It also has a real user id,
which is why its preferences persist, it can own personal credentials, and the
audit trail names it rather than an anonymous actor.

**A record with no password cannot sign in with one.** That is the normal state
for an SSO-mapped identity, where the password column stays *None* on purpose
and the person authenticates through the identity-aware proxy — and it is
exactly what `BOOTSTRAP_SYSTEM_ADMIN_SUBJECT` seeds. If someone should log in
with a password, set one for them here.

Two consequences the platform accepts on purpose:

- **While the user store is unreachable, nobody can sign in.** Nothing sits
  behind it as a break-glass credential any more, so an attempt during that
  window answers *"the user store is unavailable … try again in a moment"*
  instead of *"invalid password"* — an honest, retryable answer rather than a
  misleading rejection. Recovering a lost identity is therefore a **host-level**
  action on `/workspace/users/index.json`, not a console login.
- **Editing `.env` no longer revokes anything.** The seeded password lives in
  the record from the moment it is created, so changing the deployment's
  variables and restarting leaves the account exactly as it was. Only this page
  can change or clear it — and choosing a strong one is the System Admin's
  responsibility: nothing forces a change and there is no password policy.

**Records are the guest list for SSO too.** Where single sign-on is in front of
the console, an identity it has authenticated still only gets a session when its
e-mail matches a **Subject on this page**. Anyone else is sent to the ordinary
login form rather than being handed a silent, scope-less session — so this page
is the guest list, not a formality after it. Repeated password attempts are
rate-limited, and a signed-in session lasts about a week.

## Creating and editing a user

**New User** creates the record. The only required field is the **Subject**;
pick the identity the person will actually sign in with, because it cannot be
changed later. Everything else can be filled in now or edited afterwards.

Clicking a row (or the pencil) opens the edit panel, which has two independent
halves:

- **The details** — display name, e-mail and the System-Admin flag, applied with
  **Save changes**.
- **Login password** — its own section with its own buttons. **Set** stores a new
  password immediately; **Clear** removes it (and only appears when one is set).
  Neither waits for *Save changes*, and neither can read back what is already
  stored, so "set a new one" is the only way to change a forgotten password.

**Every record is fully manageable here — the seeded first administrator
included.** Rename it, give it an e-mail, hand the System-Admin flag to someone
else, set it a new password: there is no privileged record this panel refuses to
edit, because there is no longer a principal that lives outside the store.

Editing your **own** account is allowed and warned about rather than blocked: if
you remove your own System-Admin flag the panel says so before you save, because
nothing will hand it back to you afterwards. The warning is advisory on purpose —
stepping down deliberately is a legitimate thing to do. The one exception is the
estate-level rule below: if yours is the *only* System-Admin record, the
checkbox is locked rather than merely warned about, and the reason is printed
next to it.

## Deleting a user is an offboarding

**One thing is refused before any of it runs:** you cannot delete somebody while
they are the **last Team Admin** of a team. The refusal names every team that
blocks it, and there are two ways past it — promote another member of that team
to Team Admin, or delete the team. This is checked *first*, so a refused delete
pauses nothing and revokes nothing. Note the asymmetry with System Admin below:
that role is global and a replacement can always be minted, whereas an
admin-less team has nobody left who may repair it.

Otherwise **Delete** does noticeably more than remove a row, and it happens
*before* the record disappears:

1. **The departing human's own agents are paused** — disabled in place, drained,
   not wiped and not deleted. Even a team-locked agent is paused, because this
   runs as a system action.
2. **Their personal SSH keys and GitHub tokens are deleted** from disk. Only
   *personal* credentials — team-scoped and system credentials are untouched, so
   other people's agents keep working.
3. **Their own Matrix chat account is deactivated** and its stored access token
   deleted, so a removed person keeps no live account and no live session on the
   platform's chat. (A single-operator stack that never created user records has
   no such account and nothing happens here.)
4. **The record and its memberships are removed** together.

The order is the point: pausing and revoking happen *first*, so if something goes
wrong the person still exists and can be dealt with, rather than leaving a
deleted user's secrets lying around. Steps 1 to 3 are best-effort — if the
offboarding itself fails the deletion **still proceeds**, so on an error check the
person's agents, personal credentials and Matrix account by hand rather than
assuming they were cleaned up.

A failed offboarding is **no longer silent**, though. A degraded run — including
one that only *partly* succeeded, such as an agent it could not pause — is
recorded on the **GitHub Event Log** as a `user.offboarding-degraded` entry, so a
teardown that did not finish shows on the operator's timeline instead of only in
a server log nobody reads. Until you have confirmed the cleanup by hand, treat
the departed person's personal tokens as still live and revoke them at GitHub.
(Even so, an attributed write under a deleted owner's leftover token is refused
rather than allowed through — see *Rotation and runtime resolution* on the
credentials pages.)

Two things this does **not** do. It does not delete anything a *team* owns —
team resources belong to the team, not to the person, and their agents are
paused rather than removed, so someone else can take them over. And it does not
touch that person's contributions or history.

**The last System Admin cannot be deleted.** Since the console authenticates
against user records alone, removing the only global administrator would lock
every human out of user management with no way back in, so the store refuses it:
*"The last System Admin cannot be deleted — promote another user to System Admin
first"*. The row's **Delete** is disabled with that sentence as its tooltip, so
the confirmation dialog is never even reached for such a record — and if a
request is made anyway the server answers 409 with the same wording. The same
rule guards the flag itself: that record **cannot be demoted** either, which is
why its System-Admin checkbox is locked with the reason shown beside it.
Promote a second System Admin first, and both controls unlock.

Deleting your **own** account is a different case and is still only *warned*
about, not blocked — stepping away deliberately is legitimate. If you ever do
lose every System-Admin identity, recovery is a host-level edit of
`/workspace/users/index.json`, not a console login.

## The All Teams tab

Every team is **private to its members**, so the ordinary way to find a team is
to be in it. This tab is the exception a System Admin gets: the full list,
including teams nobody has shared with you.

The rows are **Agent Teams** — a squad of agents working a repository, created
from **+ Create**. That is what a membership points at, so "every team on the
platform" and "every Agent Team" are the same list.

| Column | What it means |
|---|---|
| **ID** | The team's agent id. It is fixed at creation; there is no rename. |
| **Team** | Its display name. |
| **Owner** | The human who created it. `—` means the owner is unset, which is normal for a team that predates ownership being recorded. |
| **Member agents** | How many `team-member` agents belong to it. |
| **People** | How many humans hold a membership. A **no admin** marker appears when none of them is a Team Admin. |
| **Team Admins** | How many of those people may change the team. |
| **State** | Whether the team agent is enabled. |

**A team with no admin is the state worth looking for.** Nobody left in it can
change it, add anybody or delete it — only a System Admin can, which is why the
marker is here rather than anywhere else. The fix is to share the team with
someone as Team Admin, which you can do from the Agent Chat like anyone else.

**This tab does not manage members.** There is no role dropdown and no add-person
row, because that is the **Share…** dialog's job now and duplicating it here
would be a second, differently-warned copy of an operation that can lock a team's
own admins out. What is left here is the one thing only a System Admin can do.

## Deleting a team

Deleting a team runs **two cascades**, and the confirmation names both before you
commit:

- **Its member agents are deleted** — not paused, not orphaned. Their workspaces
  go with them, which is the part that cannot be undone by re-creating the team.
- **Its memberships are revoked.** The people themselves are untouched and keep
  every other team they belong to.

There is no "delete only if empty" refusal here, unlike the old access-scope
delete: a team *is* its agents, so an empty one would be nothing to protect. If
you only want the team out of your way, disabling it is the reversible option.

Deleting a team is also the second way past a refused *user* deletion: a person
who is the last admin of a team you no longer need stops being blocked once that
team is gone.

## The Resources tab

This tab answers a different question from **All Teams**: not *which teams exist*
but *who owns each thing*. Moving a resource between tenants is handing it to
another group of people, so it is reserved for System Admins.

### An access scope is not an Agent Team

The teams in the ownership dropdowns here are **access scopes** — the older,
coarser tenant that a resource's `teamId` still names. They share a word with
Agent Teams and nothing else:

| | **Access scope** (the dropdowns here) | **Agent Team** (the All Teams tab) |
|---|---|---|
| What it is | A tenant a resource is stamped with | A squad of agents working a repository |
| Created on | Nowhere any more — the ones that exist are the ones that exist | **+ Create**, self-service, by anyone |
| Relationship | Owns Agent Teams, among everything else | Sits inside exactly one access scope |

**No new access scope can be minted**, and none can be deleted from the console:
the surface for that retired with the Access page, and the two tenancies are
being collapsed into one in a later step. Until then a resource is still stamped
with a scope, and this tab is where that stamp is changed.

### Agents

An agent belongs to exactly **one** tenant — there is no shared tier for an
agent — so each row carries a plain dropdown.

**An Agent Team moves as one unit.** It gets a single dropdown for the whole
squad and its members are listed beneath it read-only, because they inherit the
tenant from their parent rather than carrying one of their own. If the parent
moves but a member cannot, the error says so and names how many were left behind:
the squad is briefly split across two tenants, and retrying is what resolves it.

Reassigning changes **who may see and manage** the resource. It does not restart
an agent, move a repository, or alter what the resource does.

### Working Environments, and the shared tier

An environment is **tiered**, not simply owned, so its row states the tier first
and **Change ownership** edits it as one:

- **Team** — owned by a single access scope, exactly like an agent.
- **Shared** — reachable by every scope you assign it to. This is what lets one
  repository, key and provider serve several teams instead of each team wiring up
  its own infrastructure before it can start. A shared environment assigned to
  **no** scope is reachable by no team at all, only by System Admins; the row
  says so rather than looking owned.

The tier is why this is not a one-click dropdown any more. Picking a team for a
**shared** environment does not just move it — it *un-shares* it, taking it away
from every other team that was using it. Stating the tier and showing what the
record will be after saving is what makes that visible before you commit.

A **personal** tier does not exist for environments: an operator has to be able
to repair and delete them, and a personal record has no administrative
break-glass by design. If a row ever reports one, that is a record in a state the
platform does not create.

### What ownership still gates

Ownership is enforced by the API, not just hidden in the UI:

- **Lists are filtered** by the owning tenant — agents, Working Environments and
  team-scoped credentials outside your teams are not returned at all.
- **An agent's work plane follows its agent** — the chat transcript, the session
  log, the workspace browser and the git actions in it. Reaching one for an agent
  outside your teams answers *not found*, exactly as a non-existent agent would,
  so an agent id alone tells you nothing about whether that agent exists.
- **Management calls are rejected** with a 403 when you are neither a System
  Admin nor a **Team Admin** of the team in question. The console only trims the
  controls; the refusal happens server-side.

Two things ownership deliberately does **not** gate. **Personal credentials** are
outside the model entirely: they belong to one human by name, and neither a
System Admin nor the built-in admin can see or manage them. And **choosing a
Model Provider for the console's own AI helpers** needs only membership, not the
Team-Admin role, so an ordinary Team Member can run the Flow Copilot billed
against a provider their team is entitled to.

## Working with this page

- The Users table's **Password** column shows only *Set* or *None*, and **System
  Admin** marks the global flag — neither says anything about which teams the
  person can see.
- **To give somebody access**, open the team in the **Agent Chat** and use
  **Share…**. Without a membership there, a new non-admin user sees an empty
  console.
- The user rows are alphabetical by display name and the team rows by team name,
  so a freshly created one appears in place rather than at the end.
- Each tab keeps its place in the address bar (`?tab=teams`, `?tab=resources`),
  so a link to one opens on it.
