---
id: access-users
routes: ["/teams"]
title: Access & Users
summary: Human access scopes — internally called Teams — are the tenants that own your agents, environments and credentials, plus the people who may see and manage them.
seeAlso:
  - { label: "Users", to: "/users" }
  - { label: "Agents", to: "/agents" }
  - { label: "Working Environments", to: "/environments" }
  - { label: "My Credentials", to: "/my-credentials" }
askPrompts:
  - "What's the difference between a Team and an Agent Team?"
  - "What can a Team Admin do that a Team Member cannot?"
  - "Why can't I delete this team?"
  - "I added a user but they still see nothing — what is missing?"
  - "How do I move an agent or a Working Environment to another team?"
---

## What this page manages

This page manages **access scopes** and the **human users** in them.

An access scope — internally a **Team** — is a *human* collaboration and
visibility tenant. Every agent, Agent Team, orchestrator, Working Environment
and team-scoped credential is owned by **exactly one** of them. The scope is
what decides who sees a resource and who may change it.

A fresh stack starts with a single scope whose id is `default`, and anything
created before scopes existed was adopted into it. That is why a single-operator
installation never has to think about this page at all.

## This is *not* an Agent Team

The two constructs share a word and nothing else:

| | **Team** (this page) | **Agent Team** |
|---|---|---|
| What it is | A tenant for *humans* — an access and visibility boundary | A squad of *agents* working a repository, created by the **Agent Team Wizard** |
| Members | Human users, with a role each | Agent processes, sharing a system-prompt template and a Working Environment |
| Created on | This page (**New Team**) | The **Create** launcher / Agent Team Wizard, listed on **Agents** |
| Relationship | Owns Agent Teams, among everything else | Is owned by exactly one Team |

So an Agent Team always sits *inside* a Team. When you reassign an Agent Team to
another scope it moves as one unit — its member agents follow their parent
rather than carrying an assignment of their own.

## The three roles

| Role | Where it lives | What it may do |
|---|---|---|
| **System Admin** | A global flag on the user record, not a team membership | Everything, in every scope — including creating scopes and reassigning resources between them |
| **Team Admin** | A membership in one scope | Manage that scope's details and its members; see and work with the resources it owns |
| **Team Member** | A membership in one scope | See the scope's resources and chat with its agents; no management |

One human can be **Team Admin** of one scope and **Team Member** of another at
the same time; **System Admin** is global and supersedes both. Membership is a
single record per user and scope, so adding a user who is already a member
simply **updates their role in place**.

Membership is fail-closed: a user with no membership anywhere and no System-Admin
flag can log in but sees nothing until a scope is granted.

## What a scope actually gates

Scoping is enforced by the API, not just hidden in the UI:

- **Lists are filtered** by the owning scope — agents, Working Environments and
  team-scoped credentials outside your scopes are not returned at all.
- **Private agents** are visible only to the human who owns them, even inside a
  shared scope.
- **Management calls are rejected** with a 403 when you are neither a System
  Admin nor the **Team Admin** of the scope in question — editing a scope's
  details or its members, for example. The console only trims the controls; the
  refusal happens server-side.
- An agent spawned from an Agent Team inherits its tenant from that parent, so
  moving the parent moves the whole squad's visibility with it.

## Working with this page

- **New Team** creates a scope. Its id is a lowercase slug you cannot change
  later, so pick it the way you would pick a Working Environment id.
- **Manage** (or **View**, when you may only look) opens a panel with the
  scope's name and description plus its member list, where roles are set and
  members removed.
- **Manage Users** jumps to the **Users** page. Human user *records* — display
  name, e-mail, System-Admin flag, login password — are created and edited
  there; this page only decides which scope they belong to and with what role.
- **Resource ownership** at the bottom reassigns an individual agent or Working
  Environment to a different scope. Moving resources across tenants is a global
  operation, so it is reserved for System Admins.
- **Delete** removes a scope. The `default` scope is protected and cannot be
  deleted, and any other scope is refused while it still owns agents or
  environments — reassign them first. Deleting a scope drops its members'
  memberships, not the user records themselves.
