---
id: users
routes: ["/users"]
title: Users
summary: The human user *records* — who can sign in, under which name, with a login password or not, and who is a global System Admin. Which access scope they may see is set on the Access page.
seeAlso:
  - { label: "Access", to: "/teams" }
  - { label: "My Credentials", to: "/my-credentials" }
  - { label: "Agent Chat", to: "/chats" }
  - { label: "SSH Keys", to: "/ssh-keys" }
askPrompts:
  - "What is the Subject and can I change it later?"
  - "I created a user but after logging in they see nothing — what is missing?"
  - "What happens to a user's agents and credentials when I delete them?"
  - "How does a person actually sign in — password or SSO?"
  - "What is the difference between System Admin and Team Admin?"
  - "Can I delete the last System Admin by accident?"
---

## What this page manages

This page owns the **human user record** end to end: create it, edit its
details, set or clear a login password, mark it a **System Admin**, delete it.

It is deliberately only half of access management. A record here says *who this
person is*; it says nothing about **what they may see** — that is a membership in
an access scope, granted on the **Access** page. A brand-new user with no
membership and no System-Admin flag can sign in and will see **nothing at all**
(the API is fail-closed, not just the UI). Creating the record and forgetting the
scope is the single most common reason for "I logged in and the console is
empty".

The page is open to System Admins and the environment's built-in admin only, and
it needs the orchestrator to be reachable — user records live in the
orchestrator's store, not in the console.

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
re-granting their scopes on the **Access** page is part of the job.

## System Admin vs Team Admin

They are different mechanisms, not two levels of one setting:

- **System Admin** is the flag on the record here. It is **global**: every access
  scope, every resource, plus the operations reserved for it (reassigning
  resources between them, managing users, installing plugins). Note that
  *creating a team* is **not** one of them — that is self-service for everybody.
- **Team Admin** is a **membership** in one scope, granted on the **Access**
  page. It manages that scope and its members, and nothing outside it.

One person can be Team Admin of one scope, Team Member of another, and System
Admin on top of both — the flag supersedes the memberships rather than replacing
them.

There is one thing a System Admin still cannot do: see or manage another
person's **personal** credentials. That tier is owned by name, with no
administrative break-glass — which is also why deleting a user *deletes* those
credentials rather than transferring them.

## How signing in actually works

A sign-in tries the **user records on this page first**, matching the *Subject*
against the password you set here. Only if that finds nothing does it fall back
to the environment's built-in single admin (`ADMIN_USERNAME` /
`ADMIN_PASSWORD`).

Two consequences:

- **The env single admin is not a user record.** It never appears in this list,
  has no memberships, and cannot be edited or deleted here — it is configured in
  the deployment. That is also why a fresh stack can be administered before any
  user exists, and why it keeps working when the orchestrator is unreachable: it
  is the deliberate break-glass.
- **A record with no password cannot sign in with one.** That is the normal state
  for an SSO-mapped identity, where the password column stays *None* on purpose.
  If someone should log in with a password, set one for them here.

**Records come first for SSO too.** Where single sign-on is in front of the
console, an identity it has authenticated still only gets a session when its
e-mail matches a **Subject on this page** (or the env admin's name). Anyone else
is sent to the ordinary login form rather than being handed a silent,
scope-less session — so this page is the guest list, not a formality after it.
Repeated password attempts are rate-limited, and a signed-in session lasts about
a week.

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

Editing your **own** account is allowed and warned about rather than blocked: if
you remove your own System-Admin flag the panel says so before you save, because
nothing will hand it back to you afterwards. The warning is advisory on purpose —
stepping down deliberately is a legitimate thing to do.

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
3. **The record and its scope memberships are removed** together.

The order is the point: pausing and revoking happen *first*, so if something goes
wrong the person still exists and can be dealt with, rather than leaving a
deleted user's secrets lying around. Steps 1 and 2 are best-effort — if the
offboarding itself fails the deletion **still proceeds**, so on an error check the
person's agents and personal credentials by hand rather than assuming they were
cleaned up.

Three things this does **not** do. It does not delete anything the *scope* owns —
team resources belong to the scope, not to the person, and their agents are
paused rather than removed, so someone else can take them over. It does not touch
that person's contributions or history. And it does **not check whether you are
removing the last System Admin**: nothing stops you deleting the only account
that can create another one, and deleting your **own** account shows a warning but
is not blocked. Before removing an administrator, make sure another one exists —
or that you still have the environment's built-in admin credentials.

## Working with this page

- The table's **Password** column shows only *Set* or *None*, and **System
  Admin** marks the global flag — neither says anything about which scopes the
  person can see.
- **Manage their access** on the **Access** page: without a membership there, a
  new non-admin user sees an empty console.
- The row order is alphabetical by display name, so a freshly created user
  appears in place rather than at the end.
