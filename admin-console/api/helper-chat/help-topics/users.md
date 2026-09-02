---
id: users
routes: ["/users"]
title: Users
summary: The human user *records* — who can sign in, under which name, with a login password or not, and who is a global System Admin. Which access scope they may see is set on the Access page.
seeAlso:
  - { label: "Access", to: "/teams" }
  - { label: "My Credentials", to: "/my-credentials" }
  - { label: "Agents", to: "/agents" }
  - { label: "SSH Keys", to: "/ssh-keys" }
askPrompts:
  - "What is the Subject and can I change it later?"
  - "I created a user but after logging in they see nothing — what is missing?"
  - "What happens to a user's agents and credentials when I delete them?"
  - "How does a person actually sign in — password or SSO?"
  - "What is the difference between System Admin and Team Admin?"
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
| **E-mail** | Optional, free-text. |
| **System Admin** | A **global flag on the record**, not a membership — see below. |
| **Login password** | Optional. Stored only as a hash; the list shows just **Set** or **None** and the value is never readable back. |

The stored record carries two more fields this form does not expose: a GitHub
handle (API-only) and the per-user chat font size, which the person sets for
themselves in the console's **Settings**.

## System Admin vs Team Admin

They are different mechanisms, not two levels of one setting:

- **System Admin** is the flag on the record here. It is **global**: every access
  scope, every resource, plus the operations reserved for it (creating scopes,
  reassigning resources between them, managing users, installing plugins).
- **Team Admin** is a **membership** in one scope, granted on the **Access**
  page. It manages that scope and its members, and nothing outside it.

One person can be Team Admin of one scope, Team Member of another, and System
Admin on top of both — the flag supersedes the memberships rather than replacing
them.

## How signing in actually works

A sign-in tries the **user records on this page first**, matching the *Subject*
against the password you set here. Only if that finds nothing does it fall back
to the environment's built-in single admin (`ADMIN_USERNAME` /
`ADMIN_PASSWORD`).

Two consequences:

- **The env single admin is not a user record.** It never appears in this list,
  has no memberships, and cannot be edited or deleted here — it is configured in
  the deployment. That is also why a fresh stack can be administered before any
  user exists.
- **A record with no password cannot sign in with one.** That is the normal state
  for an SSO-mapped identity, where the password column stays *None* on purpose.
  If someone should log in with a password, set one for them here.

## Deleting a user is an offboarding

**Delete** does noticeably more than remove a row, and it happens *before* the
record disappears:

1. **The departing human's own agents are paused** — disabled in place, drained,
   not wiped and not deleted. Even a team-locked agent is paused, because this
   runs as a system action.
2. **Their personal SSH keys and GitHub tokens are deleted** from disk. Only
   *personal* credentials — team-scoped and system credentials are untouched, so
   other people's agents keep working.
3. **The record and its scope memberships are removed** together.

Steps 1 and 2 are best-effort: if the offboarding itself fails the deletion
**still proceeds**, so on an error check the person's agents and personal
credentials by hand rather than assuming they were cleaned up.

Two safety notes: acting on your **own** account (removing your own System-Admin
flag, or deleting yourself) shows a warning but is *not* blocked — you can lock
yourself out deliberately. And deleting a user does not delete anything the
*scope* owns; team resources belong to the scope, not to the person.

## Working with this page

- **New User** creates the record. The only required field is the Subject; pick
  the identity the person will actually sign in with, because it cannot be
  changed later.
- **Clicking a row** (or the pencil) opens the edit panel — display name, e-mail,
  the System-Admin flag and the **Login password** section that sets or clears the
  password. The Subject is shown read-only there.
- **Manage their access** on the **Access** page: without a membership there, a
  new non-admin user sees an empty console.
