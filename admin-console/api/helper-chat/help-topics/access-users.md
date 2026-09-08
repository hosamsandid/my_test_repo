---
id: access-users
routes: ["/teams"]
title: Access
summary: Human access scopes — internally called Teams — are the tenants that own your agents, environments and credentials, plus the people who may see and manage them.
seeAlso:
  - { label: "Users", to: "/users" }
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Working Environments", to: "/environments" }
  - { label: "My Credentials", to: "/my-credentials" }
askPrompts:
  - "What's the difference between a Team and an Agent Team?"
  - "What can a Team Admin do that a Team Member cannot?"
  - "Why can't I delete this team?"
  - "I added a user but they still see nothing — what is missing?"
  - "How do I move an agent or a Working Environment to another team?"
  - "Why can't I see a colleague's personal credential as a System Admin?"
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

The page has three surfaces, and each carries its own "?": the scope table you
are looking at, the **Manage** panel a row opens, and the **Resource ownership**
section at the bottom (System Admins only).

## This is *not* an Agent Team

The two constructs share a word and nothing else:

| | **Team** (this page) | **Agent Team** |
|---|---|---|
| What it is | A tenant for *humans* — an access and visibility boundary | A squad of *agents* working a repository, created by the **Agent Team Wizard** |
| Members | Human users, with a role each | Agent processes, sharing a system-prompt template and a Working Environment |
| Created on | Nowhere any more — the scopes that exist are the ones that exist | The **Create** launcher / Agent Team Wizard — self-service, by anyone |
| Relationship | Owns Agent Teams, among everything else | Is owned by exactly one Team |

So an Agent Team always sits *inside* a Team. When you reassign an Agent Team to
another scope it moves as one unit — its member agents follow their parent
rather than carrying an assignment of their own.

## The three roles

| Role | Where it lives | What it may do |
|---|---|---|
| **System Admin** | A global flag on the user record, not a team membership | Everything, in every scope — including reassigning resources between them |
| **Team Admin** | A membership in one scope | Manage that scope's details and its members; see and work with the resources it owns |
| **Team Member** | A membership in one scope | See the scope's resources and chat with its agents; no management |

One human can be **Team Admin** of one scope and **Team Member** of another at
the same time; **System Admin** is global and supersedes both. Membership is a
single record per user and scope, so adding a user who is already a member
simply **updates their role in place**.

Membership is fail-closed with one deliberate exception: a user with no
membership anywhere and no System-Admin flag can log in and sees nothing — but
they can still **create their own Agent Team**, and they become its Team Admin
in the same operation. That is the one thing that does not need to be granted to
you first.

**A team can never be left without an admin.** Removing or demoting the *last*
Team Admin of a team is refused unless you name a successor who is already a
member of it, and the refusal says so. Deleting a *user* is refused for the same
reason while they are the last Team Admin of anything — promote somebody else
first, or delete the team.

There is **no fourth principal**. The administrator a fresh stack starts with is
an ordinary System-Admin *user record*, **seeded once at first boot** from the
deployment's configured initial user and never re-read afterwards. It therefore
appears in the list on the **Users** page and is managed there like anybody
else — and it *can* be given a membership in a scope here, though the global
flag already covers every scope, so a role rarely adds anything.

## What a scope actually gates

Scoping is enforced by the API, not just hidden in the UI:

- **Lists are filtered** by the owning scope — agents, Working Environments and
  team-scoped credentials outside your scopes are not returned at all.
- **Private agents** are visible only to the human who owns them, even inside a
  shared scope.
- **An agent's work plane follows its agent** — the chat transcript, the session
  log, the workspace browser and the git actions in it. Reaching one for an agent
  outside your scopes answers *not found*, exactly as a non-existent agent would,
  so an agent id alone tells you nothing about whether that agent exists.
- **Management calls are rejected** with a 403 when you are neither a System
  Admin nor the **Team Admin** of the scope in question — editing a scope's
  details or its members, for example. The console only trims the controls; the
  refusal happens server-side.
- An agent spawned from an Agent Team inherits its tenant from that parent, so
  moving the parent moves the whole squad's visibility with it.
- A resource carrying **no** scope at all is treated as belonging to `default` —
  which is what makes the pre-scope adoption above work without a migration.

Two things a scope deliberately does **not** gate. **Personal credentials** are
outside the model entirely: they belong to one human by name, and not even a
System Admin can see or manage them — there is no
administrative break-glass. And **choosing a Model Provider for the console's**
**own AI helpers**
needs only membership, not the Team-Admin role, so an ordinary Team Member can
run the Flow Copilot billed against a provider their scope is entitled to.

## Managing a scope and its members

Clicking a row opens the **Manage** panel — or **View**, when you may only look.
The two are the same panel: with read-only access the fields and the member
controls are simply inert, and the panel says so rather than hiding itself. That
is deliberate, so a Team Member can *see* who is in a scope and go ask one of its
admins.

The panel has two halves:

- **Team details** — the display name and description. The scope's **id** is not
  among them: it is fixed at creation and there is no rename, because everything
  that belongs to the scope refers to it by that id.
- **Members** — one row per human, each with a role dropdown and a remove
  button, plus a row to add someone. The dropdown writes the membership
  immediately; there is no separate save for it.

Two things the panel cannot do, by design. It cannot **create a human** — the
add-member list only offers people who already have a user record, which is what
the **Manage Users** button in the page header jumps to. And removing someone
here removes only their **membership**: the person, their password and their own
credentials are untouched, and they keep any other scope they belong to. Removing
a user entirely is an offboarding, and it happens on the **Users** page.

Removing the **last** admin of the scope is the one member action that can be
refused outright: add the successor as a member, then remove yourself naming
them.

## Resource ownership

The section at the bottom of the page reassigns an individual agent or Working
Environment to a different scope. Moving resources across tenants is a global
operation — you are, in effect, handing something to another group of people — so
it is reserved for **System Admins** and does not render at all for anyone else.

Two details make it behave differently from the rest of the page:

- **An Agent Team moves as one unit.** It gets a single dropdown for the whole
  squad and its members are listed beneath it read-only, because they inherit the
  tenant from their parent rather than carrying one of their own.
- **A partial move is reported, not hidden.** If the parent is reassigned but a
  member cannot be, the error says so explicitly and names how many were left
  behind — the squad is briefly split across two tenants, and retrying is what
  resolves it.

Reassigning changes **who may see and manage** the resource. It does not restart
an agent, move a repository, or alter what the resource does.

## Creating and deleting a scope

**Scopes are no longer created here.** Creating a team is self-service and it
creates an **Agent Team** — use **+ Create**, or the Agent Team Wizard. The
creator becomes its Team Admin, and the team is **private**: nobody else sees it
until it is shared. The old **New Team** button on this page is gone, and the
API behind it answers *410 Gone* naming its successor. The scopes listed here
still exist and stay fully manageable; there is simply no way to mint a new one,
because the Agent Team *is* the team now.

**Delete** removes a scope, and it is refused in two cases rather than
cascading:

- The `default` scope **can never be deleted** — the button is disabled and says
  so. It is where unowned resources land, so it has to exist.
- Any other scope is refused while it **still owns** agents, Working Environments
  or team-scoped credentials. Reassign them first, in the Resource ownership
  section above. The refusal is what stops a delete from quietly orphaning a
  running squad.

Once it is empty, deleting a scope drops its **memberships** and nothing else —
the user records themselves stay, and so does everything those people own
elsewhere.
