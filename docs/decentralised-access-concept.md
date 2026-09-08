# Decentralised, creator-owned access — Concept

Status: **design of record**. No implementation code is delivered here. This document turns the decisions **D1–D12** settled on issue [#2041](https://github.com/AccentureCodeFoundry/314092_agent-execution-environment/issues/2041) into an implementable design, complete enough that phases P1–P6 can be built and reviewed against it.

Tracking issue: [#2046](https://github.com/AccentureCodeFoundry/314092_agent-execution-environment/issues/2046) (delivers #2041 AC1). Parent: [#2041](https://github.com/AccentureCodeFoundry/314092_agent-execution-environment/issues/2041).

**All code citations in this document were verified against `origin/main` at commit `f324aeea0` (2026-09-07).** Line numbers are the state of that commit; §4.6 lists where they differ from the citations in #2041.

---

## Table of Contents

1. [Terminology and the collapse (D1)](#1--terminology-and-the-collapse-d1)
2. [Authorization model (D4, D5)](#2--authorization-model-d4-d5)
3. [Data model — before and after](#3--data-model--before-and-after)
4. [Enforcement inventory](#4--enforcement-inventory)
5. [Resource ownership tiers (D7, D12)](#5--resource-ownership-tiers-d7-d12)
6. [Team Member permission matrix (D9)](#6--team-member-permission-matrix-d9)
7. [Sharing (D2, D3, D8, D11)](#7--sharing-d2-d3-d8-d11)
8. [Migration (D6)](#8--migration-d6)
9. [Information architecture (D10)](#9--information-architecture-d10)
10. [Phase plan and test strategy](#10--phase-plan-and-test-strategy)
11. [Known holes this redesign makes load-bearing](#11--known-holes-this-redesign-makes-load-bearing)
12. [Non-goals, dependencies, contradictions raised](#12--non-goals-dependencies-contradictions-raised)

### Decision map (#2041 D1–D12 → section)

| # | Decision (one line) | Section |
|---|---|---|
| **D1** | The Agent Team becomes the access boundary; the separate access-scope layer is retired. | [§1](#1--terminology-and-the-collapse-d1), [§3](#3--data-model--before-and-after), [§4](#4--enforcement-inventory) |
| **D2** | Open user directory — every user may search and browse all users (name + email only). | [§7.2](#72--the-open-directory-d2-d11), [§4.1](#41--admin-consoleapiscopejs--the-predicate-set) |
| **D3** | No invitations of people without an account. | [§7.3](#73--existing-accounts-only-d3) |
| **D4** | The last Team Admin cannot be removed without naming a successor. | [§2.3](#23--the-last-admin-rule-d4) |
| **D5** | The System Admin retains full visibility (`scope.all` stays); the operator login is unchanged. | [§2.2](#22--what-full-visibility-means-d5-and-the-privacy-guarantee) |
| **D6** | Migration preserves existing access; private-by-default applies to new teams only. | [§8](#8--migration-d6) |
| **D7** | Layered resource ownership — personal / team-owned / system-wide shared. | [§5](#5--resource-ownership-tiers-d7-d12) |
| **D8** | Only teams are shareable; a standalone agent stays private to its creator. | [§7.4](#74--only-teams-are-shareable-d8), [§3.5](#35--after--standalone-role-agent-config) |
| **D9** | A Team Member may read and chat — nothing else. | [§6](#6--team-member-permission-matrix-d9) |
| **D10** | The *Access* nav entry is dissolved, not renamed; one System-Admin **Administration** entry with tabs. | [§9](#9--information-architecture-d10) |
| **D11** | The GitHub handle is not shown in the open directory. | [§7.2](#72--the-open-directory-d2-d11) |
| **D12** | Configuration/content → self-service and tiered; infrastructure → administrator. | [§5](#5--resource-ownership-tiers-d7-d12) |

### Acceptance-criteria map (issue #2046)

AC1 → §1–§11 (eleven chapters) · AC2 → the decision map above · AC3 → §4 · AC4 → §3 · AC5 → §2.2 · AC6 → §12 (non-goals) · AC7 → pointers added to `docs/teams-data-model.md` and `docs/multi-user-concept.md` §3 · AC8/AC9 → sign-off and parent-AC tick, recorded on the issues, not in this file.

---

## 1 — Terminology and the collapse (D1)

### 1.1 — The collision this supersedes

Today the word *team* names two different things. Three places in the tree document the collision and instruct the reader to keep them apart:

| Where | What it says today |
|---|---|
| `orchestrator/teams-store.js:3-31` | "A **Team** here is the *human* collaboration & visibility scope — the tenant. It is deliberately distinct from the existing `role: "team"` agent construct (the "Agent Team" / squad that works a repo); the two only share a word." |
| `docs/teams-data-model.md:8-12` | "**Terminology — resolve the collision.** … The pre-existing `role: "team"` agent construct … is the **Agent Team** — always qualify it as such." |
| `admin-console/api/scope.js:76-93` | "Those are two different namespaces, and reading `parentTeamId` as a tenant only appears to work while an Agent Team happens to share its id with a human Team; otherwise it names a team that does not exist and every team-scoped lookup fails closed on an empty result." |

**After D1 there is one concept and one word.** *Team* means the **Agent Team** — the `role: 'team'` agent and its `role: 'team-member'` children. It is simultaneously the squad that works a repo *and* the access boundary. The three notes above are superseded: their instruction ("always qualify it as *Agent Team*") stops being necessary because there is nothing left to distinguish it from.

This document supersedes those three notes. Their bodies are rewritten in **P6**, not here (#2046 changes no code and no prose beyond adding a successor pointer — see §12).

### 1.2 — What is retired and what survives

| Artefact | Fate |
|---|---|
| `/workspace/teams/index.json` (the access-scope records) | **Retired.** No successor file: an Agent Team's identity is its own `config.json`. |
| `/workspace/teams/<teamId>/` **directory tree** | **Survives, re-keyed.** It is not the index — it holds the per-team skill pool (`api.js:8887`, `/workspace/teams/<teamId>/skills/<name>`). `<teamId>` becomes an Agent Team id. |
| `/workspace/users/index.json` | **Survives unchanged.** Human identity is orthogonal to the collapse. |
| `/workspace/memberships/index.json` | **Survives, re-pointed.** `memberships.teamId` now references an **Agent Team id**. This is the single member list (see §3.4). |
| `MEMBERSHIP_ROLES = ['team-admin','team-member']` (`teams-store.js:40`) | **Unchanged.** The requested role semantics already exist. |
| `teamId` stamp on every resource (agent, environment, credential, MCP server) | **Survives, re-pointed** at Agent Team ids. |

### 1.3 — `resolveAgentTenant` and its twin

`resolveAgentTenant` exists in two places and is the function the collapse deletes the *reason* for:

| Copy | Lines | Body |
|---|---|---|
| `admin-console/api/scope.js` | **94-101** | `if (parentId && …) { const parent = loadAgentConfig(parentId); if (parent && parent.teamId) return parent.teamId; } return (cfg && cfg.teamId) \|\| 'default';` |
| `orchestrator/agent-tenant.js` | **28-35** | Same logic; differs textually in 2 lines (double quotes, and `DEFAULT_TEAM_ID` instead of the literal `'default'`). |

Its whole job is the one hop from a `team-member` to its parent Agent Team, *because* `parentTeamId` is "never a tenant". After D1 **`parentTeamId` is the membership link**: a member's access boundary is its parent Agent Team id, directly.

- **`resolveAgentTenant` collapses to a one-line accessor** — `role === 'team' ? cfg.id : (cfg.parentTeamId || cfg.id)` — with no `loadAgentConfig` injection and no parent read.
- The `loadAgentConfig` parameter disappears from **both** copies and from all call sites (`api.js:4222-4226` via `agentTeamId`, `orchestrator/orchestrator.js:11`).
- `planTenantBackfill` (`orchestrator/agent-tenant.js:41-53`), whose job is realigning a member's stamped `teamId` to its parent's, becomes **obsolete for members** — the parent id *is* the value. Its startup caller is `orchestrator/orchestrator.js:1050-1056`; see §8.3.
- **Correction to #2041**: the two copies are described there as "byte-mirrored". They are **semantically identical but not byte-identical**, and **no guard test asserts the mirror** (unlike `toolchain-registry.js` / `plugin-manifest.js`, which have reverse two-sided guards). P2 must change both copies in one commit and should add the missing mirror guard while it is in there.

### 1.4 — Owner resolution is a separate axis

`resolveAgentOwnerId` (`orchestrator/credential-resolution.js:59-66`) already walks the same parent hop, but for the **owner**, not the tenant: a `team-member` inherits its parent Agent Team's `ownerId`. That axis is **unchanged by D1** and is what P1 populates (§3.6). Keeping the two apart matters: the tenant hop disappears, the owner hop stays.

---

## 2 — Authorization model (D4, D5)

### 2.1 — Roles

Unchanged from `orchestrator/teams-store.js:20-26` and `docs/multi-user-concept.md` §3; only the thing a membership points at changes.

| Role | Where it lives | After D1 |
|---|---|---|
| **System Admin** | `user.systemAdmin === true` — a flag, **not** a membership (`teams-store.js:21`, `:234`) | Unchanged. Grants `scope.all` (`scope.js:40`). |
| **Team Admin** | membership with `role: 'team-admin'` (`teams-store.js:40`) | Per **Agent Team**. May change the authorised users of that team; may change every agent and team setting in it. |
| **Team Member** | membership with `role: 'team-member'` | Per **Agent Team**. May read and chat — nothing else (§6). |

`canManageTeam` (`scope.js:115-119`) already reads *"System-Admin bypass OR `team-admin` of exactly this team"*. **No new predicate is needed** for the role rule; only the key space changes.

### 2.2 — What "full visibility" means (D5), and the privacy guarantee

D5 keeps `scope.all` exactly as it is. `computeScope` (`scope.js:23-53`) grants it in two branches:

| Branch | Lines | Returned scope |
|---|---|---|
| **Operator / env-admin login** (`ADMIN_USERNAME`/`ADMIN_PASSWORD`, `auth.js:41-42`) | `scope.js:29-31` | `{ all: true, teamIds: ∅, roles: ∅, userId: null }` |
| **System Admin user record** (`user.systemAdmin === true`) | `scope.js:40` | `{ all: true, teamIds: ∅, roles: ∅, userId: user.id }` |

Both are **unchanged** (D4/D5). Twelve predicates consult `scope.all` as a grant (§4.1) and none of them is touched — that is the decision that keeps this redesign a re-pointing rather than a rebuild.

**The privacy guarantee, stated plainly:**

> A team created after this redesign is **private from every other named user who is not one of its members**. Two exceptions are part of the design and are not defects: a **System Admin** retains full visibility (D5), and the **operator / env-admin login** retains full visibility (D4). Personal credentials remain outside even that — `ownsPersonalCredential` (`scope.js:177-179`) deliberately carries **no `scope.all` bypass**, and the operator's `userId` is `null`, so a personal credential is visible to its owner alone.

This is the honest wording, not the stronger claim. **Nothing in this document says a System Admin cannot see a team** (#2046 AC5). The stronger claim would require surgically removing the `all`-bypass from the twelve predicates in §4.1 — explicitly *not* required by D5, and it would break the governance model (`docs/governance-concept.md` GOV-ACCESS-7 break-glass, quarterly access review, GOV-ACCESS-8 JML all assume an operator who can see the estate).

*A note on #2041's wording of this guarantee is raised, not resolved, in §12.2.*

### 2.3 — The last-admin rule (D4)

Removing or demoting the last `team-admin` of a team is refused unless a successor is named in the same operation. The rule has two enforcement points, both server-side:

| Route | file:line today | Change |
|---|---|---|
| `DELETE /api/admin/memberships` | `api.js:11931-11934` | Refuse when the target is the last `team-admin` of `teamId` and no successor is supplied. |
| `POST /api/admin/memberships` (role change is an upsert — `teams-store.js:314-319`) | `api.js:11925-11928` | Refuse a `team-admin → team-member` demotion of the last admin. |
| `DELETE /api/admin/users/:id` | `api.js:11867-11869` | Refuse while the user is the last `team-admin` of any team. The existing membership cascade (`teams-store.js:285-289`) would otherwise silently orphan a team. |

D5 covers the unplanned case (someone leaves the company): a System Admin can always re-admin an orphaned team, so **no orphan-recovery machinery is needed**.

---

## 3 — Data model — before and after

Shapes below are the literals actually written by the code, not idealised schemas. Writers: `orchestrator/teams-store.js` for the three stores, `orchestrator/orchestrator.js` for agent configs.

### 3.1 — `/workspace/teams/index.json`

**Before** — written at `teams-store.js:150-156` / `:420-426`:

```json
[
  {
    "id": "default",
    "name": "Default Team",
    "description": "Auto-created default team. All resources without an explicit owner belong here.",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z"
  }
]
```

**After — the file does not exist.** A team's identity, name and description live in the `role: 'team'` agent config (§3.4). `listTeams`/`getTeam`/`createTeam`/`updateTeam`/`deleteTeam` (`teams-store.js:131-200`) are retired with it; `ensureDefaultTeam` (`:416-430`) is retired, and `TEAM_ID_RE` (`:43`) moves to validating Agent Team ids (it is already the same slug shape as `TEAM_ID_RE` in `api.js`, used by `POST /api/teams` at `api.js:13136`).

### 3.2 — `/workspace/users/index.json`

**Before and after — unchanged** (written at `teams-store.js:229-242`; `passwordHash` added only by `setUserPassword`, `:375`):

```json
[
  {
    "id": "7f3c1c4e-0000-4000-8000-000000000000",
    "subject": "ada@example.com",
    "email": "ada@example.com",
    "displayName": "Ada Lovelace",
    "systemAdmin": true,
    "githubHandle": "adalovelace",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z",
    "chatFontSize": 12,
    "passwordHash": "scrypt$<saltHex>$<hashHex>"
  }
]
```

What changes is not the record but its **projection**: the open directory (D2) exposes `displayName` + `email` only — never `systemAdmin` (`teams-store.js:17`, `:234`) and never `githubHandle` (D11). See §7.2.

### 3.3 — `/workspace/memberships/index.json`

**Before** — written at `teams-store.js:320-326`; `teamId` must resolve in `/workspace/teams/index.json` (`:311`):

```json
[
  {
    "id": "b21a9c88-0000-4000-8000-000000000000",
    "userId": "7f3c1c4e-0000-4000-8000-000000000000",
    "teamId": "default",
    "role": "team-admin",
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
]
```

**After — same shape, different referent.** `teamId` is an **Agent Team id** (an agent id, i.e. the slug of a `role: 'team'` config):

```json
[
  {
    "id": "b21a9c88-0000-4000-8000-000000000000",
    "userId": "7f3c1c4e-0000-4000-8000-000000000000",
    "teamId": "agent-studio-2-0",
    "role": "team-admin",
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
]
```

Consequences for `teams-store.js`:

- **Referential integrity moves.** `setMembership` validates `teamId` against `getTeam` (`:311`). After D1 it must validate against the **agent config set** — an existing `role: 'team'` config. `teams-store.js` has no agent access, so either the check moves up to the API layer (`api.js:11925-11934`) or the store takes an injected `teamExists(teamId)` predicate. The injected-predicate variant keeps the store's "pure factory, unit-testable against a temp dir" property (`teams-store.js:28-31`) and is recommended.
- **The cascade inverts.** `deleteTeam` cascade-deletes memberships (`:194-198`). After D1 there is no `deleteTeam`; **deleting an Agent Team must delete its memberships** — `DELETE /api/agents/:id` (`api.js:3389`) gains that cascade. Missing it leaves memberships pointing at a dead team, which `canManageTeam` would still honour if the id were ever reused.
- Uniqueness (one record per `(userId, teamId)`, `:314-319`) and `MEMBERSHIP_ROLES` (`:40`) are unchanged.

### 3.4 — After — `role: 'team'` config (the new owner field)

**Before** — the only writer is `orchestrator.js:7385-7431`. Always-present keys: `id` (`:7386`), `displayName` (`:7387`), `role` (`:7388`), `environmentId` (`:7389`), `teamId` (`:7390`), `systemPromptTemplate` (`:7391`), `skills` (`:7394`), `enabled` (`:7429`); `stages`/`labels`/`humans`/`hillClimb`/`labelSuffix` are spread only when non-empty. A team agent carries **no `userId`, no `token`, no `parentTeamId`** (`orchestrator.js:7369-7372`), and **no `ownerId`, no `createdBy`, no `visibility`**.

```json
{
  "id": "agent-studio-2-0",
  "displayName": "Agent Studio 2.0",
  "role": "team",
  "environmentId": "agent-studio",
  "teamId": "default",
  "systemPromptTemplate": "",
  "skills": [],
  "stages": ["Requirements", "Build", "Release"],
  "labels": [{ "name": "ready", "humanGate": true, "brake": false }],
  "humans": [{ "id": "product-owner" }],
  "enabled": true
}
```

**After** — one added field, one removed field:

```json
{
  "id": "agent-studio-2-0",
  "displayName": "Agent Studio 2.0",
  "role": "team",
  "environmentId": "agent-studio",
  "ownerId": "7f3c1c4e-0000-4000-8000-000000000000",
  "systemPromptTemplate": "",
  "skills": [],
  "stages": ["Requirements", "Build", "Release"],
  "labels": [{ "name": "ready", "humanGate": true, "brake": false }],
  "humans": [{ "id": "product-owner" }],
  "enabled": true
}
```

- **`ownerId`** — the `users/index.json` id of the creating human. Written by `POST /api/teams` and `POST /api/teams/stream` in the same operation that creates the team (§4.2, D-P3), and by the migration for pre-existing teams (§8).
- **`teamId` is removed** from a `role: 'team'` config: the team's own `id` *is* the access boundary, so a second stamp would be a second source of truth. (P1 may keep it written-but-ignored for one phase to stay reversible; P2 removes the reads, P6 removes the field.)
- **The member list is `memberships/index.json`, not a field on this config** — see §12.2 for the contradiction this resolves and where it is raised.

**`role: 'team-member'` config** — before (writers `orchestrator.js:7573-7601` stub, `:7646-7683` materialised) and after are the **same shape**; only the meaning of the fields shifts. `parentTeamId` becomes the membership link (§1.3) and `teamId` is removed for the same reason as above. A member gets **no `ownerId` of its own** — `resolveAgentOwnerId` (`credential-resolution.js:59-66`) resolves it from the parent, which is exactly the D8 rule "a team member always follows its team".

```json
{
  "id": "agent-studio-2-0-2",
  "displayName": "Developer 2",
  "userId": "@agent-studio-2-0-2:local",
  "token": "<matrix access token>",
  "role": "team-member",
  "parentTeamId": "agent-studio-2-0",
  "environmentId": "agent-studio",
  "sessionPolicy": "per-invocation",
  "stage": "Build",
  "enabled": true
}
```

### 3.5 — After — standalone `role: 'agent'` config

**Before** — written by `orchestrator.js:7456+`, stamped `teamId: ownerTeamId` at `:7463`; no `ownerId`, no `createdBy`, no `visibility`.

**After** — gains `ownerId` and keeps no team stamp (D8: a standalone agent is private to its creator and is never shared):

```json
{
  "id": "scratch-helper",
  "displayName": "Scratch Helper",
  "userId": "@scratch-helper:local",
  "token": "<matrix access token>",
  "role": "agent",
  "environmentId": "scratch",
  "ownerId": "7f3c1c4e-0000-4000-8000-000000000000",
  "enabled": true
}
```

`visibleAgent` (`scope.js:66-74`) already has the branch this needs — `return agent.ownerId === scope.userId` (`:71`) — today reachable only when `agent.visibility === 'private'`, a field nothing writes. After D8 **owner-only is the rule for `role: 'agent'`, not an opt-in flag**, and the `visibility` field is retired unread.

### 3.6 — The `ownerId` hole this closes

`ownerId` is **read in five places and written nowhere.** Verified exhaustively across `orchestrator/`, `admin-console/` and `plugins/`:

| Reader | file:line |
|---|---|
| `resolveAgentOwnerId` (own + parent hop) | `orchestrator/credential-resolution.js:63`, `:65` |
| `selectAgentIdsForOwner` (owner-scoped respawn) | `orchestrator/credential-resolution.js:160` |
| `resolveAttributedGithubToken` | `orchestrator/orchestrator.js:3460`, `:3464` |
| `visibleAgent` (private-agent branch) | `admin-console/api/scope.js:70-71` |
| `agentMetaForScope` (response projection) | `admin-console/api/api.js:4230` |

There is **no `cfg.ownerId =` anywhere**, and no `ownerId` key in any config literal. The code says so itself:

> `orchestrator.js:3455-3456` — "Gated on `config.ownerId`: an agent with no owner (every agent until ownerId population lands — AC8) takes the shared id unchanged and …"

`createdBy` does not exist on any agent config either — its only three hits are the Matrix DM-room record (`api.js:15315`, `matrix.js:124`, `docs/agent-chat-plan.md:155`). This is the mechanical reason **original creators are unrecoverable** in the migration (§8.2).

Populating `ownerId` is shared with **#1459**; the personal-credential tier (`docs/personal-credentials-concept.md`) is dormant by construction until it lands (`credential-resolution.js:29-34`).

---

## 4 — Enforcement inventory

**This is the chapter that makes P2 reviewable instead of archaeological.** Every site that gates on `teamId` (or on a scope helper that does) is listed with its `file:line` on `origin/main` @ `f324aeea0` and its post-change form. The recurring verdicts are:

- **re-keyed** — the code is unchanged; the ids it compares are Agent Team ids instead of access-scope ids. *(Most of the inventory. This is what makes D1 tractable.)*
- **collapses** — the code loses a hop or a parameter because the two namespaces became one.
- **retired** — the site goes away with the access-scope layer.
- **new gate** — no check exists today; one must be added (see also §11).
- **projection narrows** — the gate stays, the payload shrinks (D2/D11).

### 4.1 — `admin-console/api/scope.js` — the predicate set

375 lines, 18 exported names (`:356-375`). Full inventory:

| # | Predicate | Lines | Decides | Decisive expression | After |
|---|---|---|---|---|---|
| 1 | `computeScope` | **23-53** | `(username, adminUsername, users, memberships)` → the caller's scope | `teamIds.add(m.teamId)` (`:49`), `roles.set(m.teamId, m.role)` (`:50`) | **Re-keyed.** Shape identical; both maps now keyed by Agent Team id because `memberships.teamId` is (§3.3). |
| 2 | `visibleTeam` | **57-61** | Is a resource owned by `teamId` visible? | `if (scope.all) return true;` (`:59`); `scope.teamIds.has(teamId \|\| 'default')` (`:60`) | **Re-keyed.** The `\|\| 'default'` fallback is retired with the default team (§8.4). |
| 3 | `visibleAgent` | **66-74** | Agent visibility (team + private-owner) | `visibleTeam(scope, agent && agent.teamId)` (`:69`); `agent.ownerId === scope.userId` (`:71`) | **Collapses + rule change.** Team branch reads the agent's own team (own id for `role:'team'`, `parentTeamId` for a member). Owner branch becomes the *primary* rule for `role:'agent'` (D8), no longer gated on the unwritten `visibility` field. |
| 4 | `resolveAgentTenant` | **94-101** | Agent → human tenant, one hop via `parentTeamId` | `if (parent && parent.teamId) return parent.teamId;` (`:98`) | **Collapses** to a one-line accessor; `loadAgentConfig` injection removed. Twin: `orchestrator/agent-tenant.js:28-35` (§1.3). |
| 5 | `canManageTeam` | **115-119** | May the caller CRUD this team and its memberships? | `scope.roles instanceof Map && scope.roles.get(teamId \|\| 'default') === 'team-admin'` (`:118`) | **Re-keyed, unchanged logic.** This predicate alone carries D4 and the whole of D9's admin side. |
| 6 | `visibleUser` | **124-128** | Is this user record visible to the caller? | `memberships.some(m => m.userId === userId && scope.teamIds.has(m.teamId))` (`:127`) | **Relaxed + projection narrows** (D2/D11). See §7.2 — the open directory is a *new, separately projected* route; `visibleUser` itself stays as the gate on the System-Admin user-management surface. |
| 7 | `normalizeCredential` | **156-169** | Explicit `scope`/`teamId`/`assignedTeamIds` shape | personal `:158-160`, system `:161-167`, team/legacy `:168` | **Re-keyed** (team tier only). Tier model unchanged (D7). |
| 8 | `ownsPersonalCredential` | **177-179** | Is this personal credential the caller's own? | `c.userId === scope.userId` — **no `scope.all` bypass** | **Unchanged.** The one guarantee stronger than D5 (§2.2). Module-private. |
| 9 | `visibleCredential` | **185-192** | Credential list filter | personal *before* `all` (`:188` → `:189`); `assignedTeamIds.some(t => canManageTeam(scope, t))` (`:190`); `canManageTeam(scope, c.teamId)` (`:191`) | **Re-keyed.** |
| 10 | `assistSelectableEndpoint` | **212-219** | May the caller bill against this model provider? | `scope.teamIds.has(c.teamId)` (`:217`); `assignedTeamIds.some(t => scope.teamIds.has(t))` (`:218`) | **Re-keyed.** Membership-based, any role — unchanged (D7: providers stay system-wide). |
| 11 | `canManageCredential` | **224-234** | May the caller edit/delete this credential? | personal `:230`; `if (scope.all) return true;` `:231`; `if (c.scope === 'system') return false;` `:232`; `canManageTeam(scope, c.teamId)` `:233` | **Re-keyed.** |
| 12 | `canCreateCredential` | **239-253** | May the caller create with the requested ownership? | personal `:248`; `all` `:249`; system → false `:251`; `canManageTeam(scope, desired.teamId \|\| 'default')` `:252` | **Re-keyed.** |
| 13 | `canReassignCredential` | **257-259** | Change a credential's scope/team assignment | `return !!(scope && scope.all);` | **Unchanged** (System-Admin-only). |
| 14 | `credentialVisibleToTeam` | **264-269** | Orphan guard — would `teamId` still see it? | `c.assignedTeamIds.includes(t)`; `c.teamId === t` | **Re-keyed.** No caller scope. |
| 15 | `canManageAgent` | **288-292** | Create/edit/delete/re-parent this agent | `canManageTeam(scope, (agent && agent.teamId) \|\| 'default')` (`:291`) | **Re-keyed.** With #3's collapse, the `agentTeamId` it is fed becomes the Agent Team id directly. |
| 16 | `canManageEnvironment` | **297-301** | CRUD this Working Environment (or its MCP creds) | `canManageTeam(scope, (env && env.teamId) \|\| 'default')` (`:300`) | **Re-keyed + tiered** — gains the shared tier (D7, §5.2), so it grows the `assignedTeamIds` branch `visibleCredential` already has. |
| 17 | `canViewUsageStatistics` | **313-315** | Token-usage statistics | `return !!(scope && scope.all);` | **Unchanged.** |
| 18 | `describeAuthz` | **321-345** | The session authz descriptor the client mirrors | `teams = [...scope.roles.entries()].map(([teamId, role]) => ({teamId, role}))` (`:324`); `admin: scope.all` (`:337`); `systemAdmin: scope.all && !envAdmin` (`:339`) | **Re-keyed.** `user.teams[].teamId` becomes an Agent Team id — this is the single value every client mirror in §4.4 reads. |
| 19 | `isKnownPrincipal` | **352-354** | IAP auto-login gate | `!!(authz && (authz.envAdmin \|\| authz.userId != null))` | **Unchanged** (D3 — an unregistered principal gets no session at all; gate at `auth.js:124-133`). |

**The `all`-bypass census (D5 keeps every one of them).** Ten short-circuits — `visibleTeam:59`, `visibleAgent:68`, `canManageTeam:117`, `visibleUser:126`, `visibleCredential:189`, `assistSelectableEndpoint:215`, `canManageCredential:231`, `canCreateCredential:249`, `canManageAgent:290`, `canManageEnvironment:299` — plus two whole-predicate forms, `canReassignCredential:258` and `canViewUsageStatistics:314`. **Twelve sites, none removed.** Three predicates deliberately have no bypass: `ownsPersonalCredential` (`:177-179`), `credentialVisibleToTeam` and `resolveAgentTenant` (no caller scope).

### 4.2 — `admin-console/api/api.js` — inline route gates

`getScope(req)` is the single factory (`api.js:807-815`, the file's only `computeScope` call); the scope vocabulary is imported at `:28-32`. Tenant constants at `:194-197` (`TEAMS_INDEX`, `USERS_INDEX`, `MEMBERSHIPS_INDEX`, `DEFAULT_TEAM_ID`).

**Two spellings of the System-Admin gate coexist** — `scope.all` after a bound `const scope = getScope(req)`, and inline `getScope(req).all`. A grep for the first misses eight sites (`:1703`, `:1721`, `:8202`, `:8207`, `:8251`, `:12084`, `:12089`, `:12122`). P2 must sweep both spellings.

#### Owner resolution and the agent-management guard

| Site | file:line | Gates | After |
|---|---|---|---|
| `resolveOwnerTeamId` (definition) | **682-694** | Validator, not a gate: falsy → `DEFAULT_TEAM_ID` (`:686`); an explicit id must exist in `TEAMS_INDEX` (`:687-692`), else `status: 400` | **Re-pointed.** Source of truth becomes the Agent Team config set, not `TEAMS_INDEX`. The mirror in `orchestrator.js:1145-1151` (via `teamsStore.getTeam`) changes identically. |
| — call site | **737** | `resolveCredentialOwnership` team branch | Re-pointed |
| — call site | **2472** | `PUT /api/agents/:id` team reassignment (#308; cascades to members when `role === 'team'`) | **Retired.** After D1 an Agent Team has no team stamp to reassign; the cascade goes with it. |
| — call site | **11481** | `POST /api/mcp-servers` owner team | Re-pointed |
| — call site | **11512** | `PUT /api/mcp-servers/:id` owner team | Re-pointed |
| — call site | **11550** | `POST /api/mcp-credentials` | Re-pointed |
| — call site | **12209** | `POST /api/environments` | Re-pointed |
| — call site | **12296** | `PUT /api/environments/:id` re-parenting | Re-pointed |
| `agentTeamId` | **4222-4226** | `resolveAgentTenant(cfg, …)` wrapper | **Collapses** with §1.3 |
| `agentMetaForScope` | **4229-4231** | `{ teamId, visibility, ownerId }` — the minimal shape `visibleAgent` needs | **Re-keyed**; `visibility` drops out (§3.5) |
| `denyUnlessCanManageAgent` | **4238-4247** | `if (!canManageAgent(getScope(req), agentMetaForScope(cfg \|\| {})))` → 403 (`:4242-4244`) | **Re-keyed, unchanged shape.** The reusable 403 helper D9 needs — §6 extends its *coverage*, not its logic. |
| — call sites (5) | **4866**, **4916**, **5009** (trigger create/update/delete), **7598**, **7704** (hill-climb apply/rollback) | | Re-keyed |

#### `canManageAgent` — 16 sites

| Feature | file:line | Decisive expression | After |
|---|---|---|---|
| Agent edit | **2163** | `if (!canManageAgent(scope, agentMetaForScope(cfg)))` | Re-keyed |
| Agent re-parent | **2166-2167** | destination check: `teamId !== (cfg.teamId \|\| 'default') && !canManageAgent(scope, { teamId })` | Retired with the team stamp |
| Add role to a live team | **3273** | `canManageAgent(getScope(req), agentMetaForScope(teamCfg \|\| {}))` — `POST /api/agents/:teamId/members` (route `:3255`) | Re-keyed |
| Agent create | **3360** | `canManageAgent(getScope(req), { teamId })` — `POST /api/agents` (route `:3353`) | **Re-keyed + relaxed** (D1/P3): with no pre-existing scope required, creating a *standalone* agent needs only an authenticated user, and the creator is written as `ownerId`. |
| Agent delete | **3405** | `canManageAgent(…, agentMetaForScope(delCfg \|\| {}))` | Re-keyed **+ membership cascade** (§3.3) |
| Clone — source | **3490** | `canManageAgent(cloneScope, agentMetaForScope(srcCfg \|\| {}))` | Re-keyed |
| Clone — destination | **3495** | `agentMetaForScope(destCfg \|\| { teamId: parentTeamId })` | Re-keyed |
| Extract template | **3555** | `canManageAgent(getScope(req), agentMetaForScope(srcCfg))` | Re-keyed |
| Agent import | **3915** | `canManageAgent(importScope, destMeta)`; bare import falls back to `{ teamId: 'default' }` (`:3912-3914`) | Re-keyed; the `'default'` fallback becomes "the importing user's own new team" (§8.4) |
| Prompt write | **4066** | `canManageAgent(getScope(req), agentMetaForScope(promptCfg \|\| {}))` | Re-keyed |
| Model options (`canSwitch` flag) | **4333** | `canSwitch: canManageAgent(scope, agentMetaForScope(cfg))` | Re-keyed (advisory UI state) |
| Model change | **4348** | `canManageAgent(scope, agentMetaForScope(cfg))` | Re-keyed |
| Provider change | **4403** | same | Re-keyed |
| Context mount | **4550** | same | Re-keyed |
| Chat payload `canManage` | **15241** | `canManage: canManageAgent(scope, agentMetaForScope(cfg))` — `GET /api/matrix/agents` (route `:15213`) | **Re-keyed + extended.** This is the field the Share dialog needs and does *not* get today: it is `canManageAgent`, not `canManageTeam` (§7.1). |
| (guard helper) | **4242** | inside `denyUnlessCanManageAgent` | Re-keyed |

#### `visibleAgent` — 17 sites (list filters and 403/404 gates)

`:1002` (agents using an environment), `:1598` (agent list), `:1682` (event-log agents), `:4295` (`GET /api/agents/:id/model-options`), `:5491`, `:5980`, `:6630`, `:6686`, `:6728`, `:6784` (private skills / plugin activate / deactivate), `:9053`, `:9105`, `:9181` (skill lineage, list, detail), `:9643`, `:15223` (`GET /api/matrix/agents` row filter). Definition-side import at `:28`, projection at `:4228-4231`.
**All re-keyed** by #3 in §4.1; no call-site logic changes. `:15223` is the **last scope-aware line in the file** — see §11.2.

#### `canManageTeam` — 11 sites

Skills capability objects: `:9476` (import), `:9859` (delete), `:9935` (archive list — `if (!scope.all && tier === 'team' && !canManageTeam(scope, teamId)) continue;`), `:9972` (archive restore), `:10179` (transfer), `:10397` (merge-draft), `:10439` (merge). Human-admin block: `:11830` (`PUT /api/admin/teams/:id`), `:11835` (`DELETE …`), `:11928` (`POST /api/admin/memberships`), `:11934` (`DELETE /api/admin/memberships`).
**Skills sites: re-keyed** (D12 — skills stay tiered and self-service; only the pool key changes, §5.3). **Team sites: retired or re-pointed** (§4.3). **Membership sites: survive as the Share dialog's backend** and gain the D4 last-admin rule (§2.3).

#### `scope.all` — feature gates outside the admin block

| Feature | file:line | Expression | After |
|---|---|---|---|
| Usage-record narrowing | **499**, **502** | `if (scope.all && !team) return records;` / `if (!scope.all && !visibleTeam(scope, t)) return false;` | Re-keyed |
| Orphan scan / cleanup | **1703**, **1721** | `if (!getScope(req).all)` → 403 | Unchanged (System-Admin) |
| Knowledge-team visibility | **5257** | `if (scope.all) return true;` in `knowledgeTeamVisible` (`:5255-5265`) | Re-keyed |
| Plugin UI proxy header | **8408** | `teamIds: scope.all ? grantedTeamIds : grantedTeamIds.filter(t => scope.teamIds.has(t))` | Re-keyed |
| Plugins list flag / install / uninstall | **8202**, **8207**, **8251** | `!!getScope(req).all` / 403 `'System Admin required'` | **Unchanged** (D12 — a plugin is a broker sidecar holding the team's credentials) |
| Skills archive prune | **9997** | `if (!scope.all)` → 403 retention prune | Unchanged |
| Skills System-Admin capability flags | **9475**, **9858**, **9971**, **10178**, **10397**, **10439** | `systemAdmin: !!scope.all` | Unchanged |
| Toolchains list / register / remove | **12084**, **12089**, **12122** | `!!getScope(req).all` / 403 | **Unchanged** (infrastructure — D12) |

#### Working Environments, MCP servers, skills pools, drafts

| Site | file:line | Today | After |
|---|---|---|---|
| `GET /api/environments` list filter | **12159** | `.filter(e => visibleTeam(scope, e.teamId)) // (#302)` | **Re-keyed + tiered** (D7): a shared-tier env is visible to every assigned team |
| `GET /api/environments/:id` | **12167-12172** | **no team gate on read** — only the nested agent list is scoped (`:12171`) | **New gate** (§11.4) |
| `POST /api/environments` | **12209**, **12214-12216**, **12252** | `resolveOwnerTeamId` → `canManageEnvironment(getScope(req), { teamId: ownerTeamId })` → stamps `teamId` | Re-keyed + accepts a `scope: 'system'` tier (§5.2) |
| `PUT /api/environments/:id` | **12275-12277**, **12294-12304** | `canManageEnvironment(envScope, env)`; re-parenting also needs rights on the target | Re-keyed + tier changes gated like `canReassignCredential` |
| `GET /api/mcp-servers` list filter | **11395** | `.filter(s => visibleTeam(scope, s.teamId)) // (#302)` | Re-keyed + tiered (D12) |
| `GET /api/mcp-servers/:id` | **11416-11421** | **no scope check at all** | **New gate** (§11.3) |
| `POST` / `PUT` / `DELETE /api/mcp-servers` | routes **11468-11497**, **11499-11519**, **11521-11535** | **no `canManage*` gate at all** — only `resolveOwnerTeamId` validation (`:11481`, `:11511-11516`) and an in-use 409 (`:11525-11526`) | **New gate** (§11.3) — `canManageEnvironment`, the predicate its own credentials route already uses |
| `GET /api/mcp-credentials` | **11542** | `.filter(c => visibleTeam(scope, c.teamId))` | Re-keyed |
| `POST /api/mcp-credentials` | **11550**, **11554-11556** | `resolveOwnerTeamId` + `canManageEnvironment` — the gate the server routes lack | Re-keyed |
| Team skill-pool path builder | **8885-8892** | `path.resolve(WORKSPACE, 'teams', teamId, 'skills')` (`:8887`), `POOL_TEAM_ID_RE` + `SKILL_NAME_RE` containment | **Re-keyed** — `<teamId>` becomes an Agent Team id; the directory tree survives (§1.2, migration §8.3) |
| Global skill-pool path builder | **8899-8906** | `path.resolve(POOL_DIR, 'skills')` (`:8901`) | Unchanged (global tier) |
| Team pool enumerator | **8928-8945** | walks `/workspace/teams/*/skills`; no scope check here | Re-keyed; scoping stays at the readers |
| Skills list — global pool | **9076-9086** | *"Pool (shared / global) skills — always visible to everyone."* (`:9076`) | Unchanged by design |
| Skills list — team pool filter | **9092-9093** | `listTeamSkills(filterTeam).filter(s => visibleTeam(scope, s.teamId))` | Re-keyed |
| Skills lineage — team / agent copies | **9042**, **9053** | `!visibleTeam(scope, ts.teamId)` / `!visibleAgent(scope, cfg)` | Re-keyed |
| `GET /api/process/drafts` | **8515-8526** | **no gate of any kind** — returns every draft on disk to any authenticated caller | **New gate + schema change** (§11.1) |
| `POST` / `GET` / `PUT` / `DELETE /api/process/drafts[/:id]` | **8528-8544**, **8546-8552**, **8554-8594**, **8596-8603** | **no gate of any kind**; the persisted record (`:8540`) carries no `teamId` and no `ownerId` | **New gate + schema change** (§11.1) |
| `POST /api/teams` (Agent Team wizard) | route **13051**; id check **13136-13137**; repo requirement **13174-13184** | **No `getScope`, no `canManage*`, no `resolveOwnerTeamId` anywhere in the handler** (verified over `:13051-13667`) | **New behaviour (P3):** any authenticated user may create; the creator is written as `ownerId` **and** as a `team-admin` membership in the same operation |
| `POST /api/teams/stream` (streaming twin) | route **13674**; id check **13779-13780**; repo requirement **13813-13817** | Same — no scope resolution in `:13674-14150` | Same change, mirrored. *(The repository requirement lives in three mirrored sites — these two plus `resolveTeamMemberVars`; a change to one must be mirrored to all three.)* |
| `resolveTeamMemberVars` | **3218-3253**, sole call site **3307** | Resolves repo/env vars off the team agent's config; performs **no** authorization (the gate is `canManageAgent` at `:3273`, applied first) | Unchanged |

### 4.3 — The human-admin block (`api.js:11755-11936`)

This is the surface D1 dissolves. Plumbing: `callAdmin` `:11764-11774`, `proxyAdmin` `:11777-11781`, `adminQuery` `:11783-11790`, `denyAdmin` `:11794-11797` (403 `{error, code:'forbidden'}`).

| Route | file:line | Gate today | After |
|---|---|---|---|
| `GET /api/admin/teams` | **11807** | `scope.all ? data : data.filter(t => visibleTeam(scope, t.id))` (`:11812`) | **Retired.** Its replacement is the Agent-Team list (`GET /api/agents`, already filtered by `visibleAgent`) and the System-Admin cleanup tab (§9). |
| `POST /api/admin/teams` | **11818** | `if (!scope.all) return denyAdmin(res, 'Only a System Admin may create teams');` (`:11820`) | **Retired** (D1/P3). Its rationale comment (`:11816-11817`) is precisely the obstacle this redesign removes: *"Team creation is a System-Admin action (a fresh team has no members, so a non-admin creator could not even see it afterwards)."* Under D1 the creator becomes owner **and** `team-admin` in the same operation, so the premise no longer holds. |
| `GET /api/admin/teams/:id` | **11823** | `if (!visibleTeam(…)) return 404` (`:11825`) | Retired |
| `PUT /api/admin/teams/:id` | **11828** | `canManageTeam(scope, req.params.id)` (`:11830`) | **Re-pointed** onto `PUT /api/agents/:id` (name/description live in the team's config after §3.4) |
| `DELETE /api/admin/teams/:id` | **11833** | `canManageTeam(scope, req.params.id)` (`:11835`) | **Re-pointed** onto `DELETE /api/agents/:id` (`:3389`) + the membership cascade (§3.3) |
| `GET /api/admin/users` | **11841** | `scope.all ? data : data.filter(u => visibleUser(scope, u.id, memberships))` (`:11847`) | **Kept as the System-Admin surface** (full records). The open directory is a *separate*, narrowly projected route — §7.2. |
| `POST /api/admin/users` | **11851** | `if (!scope.all)` → 403 (`:11853`) | **Unchanged** (D3 — creating user records stays a System-Admin action) |
| `GET /api/admin/users/:id` | **11856** | `visibleUser(…)` → 404 (`:11859`) | Kept |
| `PUT /api/admin/users/:id` | **11862** | `if (!scope.all)` (`:11864`) | Unchanged |
| `DELETE /api/admin/users/:id` | **11867** | `if (!scope.all)` (`:11869`) | Unchanged **+ D4 last-admin refusal** (§2.3) |
| `POST /api/admin/users/:id/password` | **11874** | `if (!scope.all)` (`:11876`) | Unchanged |
| `DELETE /api/admin/users/:id/password` | **11879** | `if (!scope.all)` (`:11881`) | Unchanged |
| `PUT /api/me/preferences` | **11894** | No role gate — pinned to the caller's own id (`:11906`); env admin (`scope.userId == null`) gets `{persisted:false}` (`:11903-11905`) | Unchanged |
| `GET /api/admin/memberships` | **11916** | `scope.all ? data : data.filter(m => visibleTeam(scope, m.teamId))` (`:11921`) | **Re-keyed. Becomes the Share dialog's read** (§7.1) |
| `POST /api/admin/memberships` | **11925** | `canManageTeam(scope, req.body.teamId)` (`:11927-11928`) | **Re-keyed. Becomes the Share dialog's write** + D4 rule. Already the right predicate — the dialog is a new *front end*, not a new authorization mechanism. |
| `DELETE /api/admin/memberships` | **11931** | `canManageTeam(scope, req.query.teamId)` (`:11933-11934`) | Same |

Two notes for P2/P6: the block's own header comment (`:11759`) still claims *"Auth & list-filtering are deliberately out of scope here"* — stale since #584, and it should be corrected while the block is being reworked. And `callAdmin` (`:11765`) hard-codes the orchestrator fallback `http://orchestrator:4002`, so every route above is a proxy — the retirements are cheap, the re-pointings are not (they move from `teams-store.js` to the agent-config plane).

### 4.4 — Client-side mirrors

Every mirror below reads **one** value: `user.teams[].teamId`/`role` and `user.admin`, produced by `describeAuthz` (`scope.js:321-345`). Re-keying that value re-keys all of them; none needs new logic. They are **UX only** — each file says so, and the API stays the security boundary.

| Surface | file:line | What it mirrors | After |
|---|---|---|---|
| `src/auth/AuthContext.jsx` | **:9-13** (documented shape), **:26/:28** (`GET /api/auth/session`), **:83-87** (`useAuth`) | Holds the descriptor verbatim; computes nothing | Re-keyed automatically |
| `src/App.jsx` — `AdminRoute` | **:46-50**, decisive `:48` `if (!user?.admin) return <Navigate to="/chats" replace />;` | System-Admin-only pages | Unchanged |
| `src/App.jsx` — `CredentialRoute` | **:58-62**, decisive `:60` `canAccessCredentialPages(user)` | Any Team Admin of ≥1 team | Re-keyed |
| `src/App.jsx` — guarded routes | `:181` `/role-templates`, `:183` `/token-usage`, `:185` `/mcp`, `:186` `/plugins`, `:191` `/maintenance-mode`, `:193` `/users` (all `AdminRoute`); `:175` `/ssh-keys`, `:176` `/github-tokens`, `:184` `/models` (`CredentialRoute`) | | Unchanged |
| `src/App.jsx` — **`/teams` route** | **:192** — `<Route path="/teams" element={<Teams />} />`, **no guard at all** | The only Access surface with no route guard; the page trims itself instead | **Retired** (D10, §9) |
| `src/components/nav-model.js` | `itemVisible` **:12-16** (`item.adminOnly → !!admin`, `item.credAdmin → !!canSeeCreds`), `filterItems` **:19-21**, `filterSections` **:26-30** (drops empty groups) | The pure nav gate | Unchanged logic |
| `src/components/Shell.jsx` | **:216** `canAccessCredentialPages(user)`, **:217** `const gate = { admin: !!user?.admin, canSeeCreds }`, **:218-219** filtering | Feeds the nav gate | Re-keyed |
| `src/components/Shell.jsx` — nav entries | **:158** `/users` "Users" (`adminOnly: true`), **:159** `/teams` label `'Access'` (**no gate**), `:160` `/token-usage`, `:161` `/plugins`, `:162` `/maintenance-mode`; group `administration` **:157-163** | | **`:159` removed; `:158` relabelled "Administration"** (D10, §9) |
| `src/pages/credential-scope-view.js` | `normalizeCredential` **:22-35**, `credentialScopeLabel` **:56-72**, `creatableScopes` **:76-78**, `defaultOwnership` **:82-85**, `canManageCredentialClient` **:99-108** (personal check at `:104` *before* the sysadmin shortcut at `:105`), `canReassignCredentialClient` **:112-114**, `adminTeamIdsOf` **:117-121**, `canAccessCredentialPages` **:125-129** | The client twin of the credential tier logic | Re-keyed; grows the shared-tier label for environments/MCP if those reuse it (§5.2) |
| `src/pages/Teams.jsx` | `isAdmin` **:377**, `canManage(teamId)` **:378-379** (`isAdmin \|\| (user?.teams \|\| []).some(t => t.teamId === teamId && t.role === 'team-admin')`), table action **:412**, panel `readOnly` **:542**, `{isAdmin && …}` header actions **:472-483**, `ResourceOwnership` **:519-528** | The whole page-level mirror | **Retired** with the page (D10) |
| `src/pages/Teams.jsx` — `ManageTeamPanel` | **:127-281**; mutations `:151-158` (`PUT /api/admin/teams/:id`), `:160-167` (`POST /api/admin/memberships`), `:169-176` (`DELETE …`), `:178-183`; read-only fork **:239-248** | Superseded by the Share dialog (§7.1) | Retired |
| `src/pages/Teams.jsx` — `ResourceOwnership` | **:283-368**; `reassign` `:291-299`; `groupAgentsForOwnership` `:301-304` | Moves to the Administration → Resources tab, reworked for the D7/D12 tiers | Re-pointed (§9) |
| `src/pages/teams-ownership.js` | `groupAgentsForOwnership` **:38-64**, `agentTeamTenant` **:69-71** (`(team && team.teamId) \|\| defaultTeamId`) | The grouping helper the tab reuses | `agentTeamTenant` **collapses** (a team's tenant is its own id) |
| `src/pages/agent-lifecycle/agent-create-access.js` | `describeAgentCreateAccess` **:31-38**; `:36` `const isTeamAdmin = (user.teams \|\| []).some(t => t && t.role === 'team-admin');` | Enables/disables New Agent + Import in the chat header, disabled-with-hint | **Relaxed** (P3): every authenticated user may create, so the refusal branch (`:38`) becomes unreachable and the helper is retired or reduced |
| `src/pages/AgentChat.jsx` | `:189` `describeAgentCreateAccess(user)`, `:543-545` / `:551-553` disabled buttons; `:786` `agentCanManage={selectedAgent ? selectedAgent.canManage !== false : true}` | Consumes the server `canManage` per row | Re-keyed; §7.1 extends the payload |
| `src/pages/SshKeys.jsx` / `GithubTokens.jsx` / `ModelRegistry.jsx` | `:444-446`/`:498`; `:307-309`/`:362`; `:1030-1034`/`:1242`/`:1430` | `canManageCredentialClient(row, caller)` per row | Re-keyed |
| `src/pages/my-credentials-view.js` | `canOwnPersonalCredentials` **:19-21**, `personalOwnerId` **:24-26** | Mirrors `ownsPersonalCredential`; fail-closed for the operator login | Unchanged |
| `src/context/ModelSelectionContext.jsx` | **:93** `userTeamIds`, **:94** `isSysAdmin` → `classifyExclusions(…)` `:95` | Explains why no provider is selectable | Re-keyed |
| `src/pages/agent-lifecycle/agent-lifecycle-menu.js` | `buildAgentMenu` **:81**, gate closure **:89-93**; `buildTeamMenu` **:184-222**, gate closure **:186-189**; `export` entry **:134-140** (`disabled: false`, rationale `:131-133`); `edit-team` **:212-216**; `export-team` **:217** | Per-entry `disabled`/`title` from the server's `canManage` | Re-keyed; **gains the `share` entry** (§7.1) |
| `src/pages/agent-chat/rail-lifecycle.js` | `railMenuItems` **:278-326**; agent branch **:283-305** (`canManage` at `:290`); team branch **:307-323** (`canManage` at `:317`) | Threads `canManage` into both menus | Re-keyed |
| `src/pages/agent-chat/RailLifecycleHost.jsx` | `choose()` **:442-498**; team branch **:479-497**, switch **:482-496** | Dispatch | **Gains `case 'share':`** (§7.1) |
| `src/pages/agent-chat/agent-settings-view.js` | `settingsSubject` **:39-47**; `:44` hides the Settings tab when `chatCanManage === false` | The D9 read/chat-vs-manage split, already implemented for the rail | Re-keyed — this is the pattern §6 generalises |
| `src/pages/Plugins.jsx` / `plugin-registry-view.js` | `:260`/`:263`/`:267`/`:354`; `installAction` `:84-95` | Server `canManage` (System-Admin) | Unchanged |
| `src/pages/WorkingEnvironments.jsx` / `toolchain-select-view.js` | `:281`, `:1136`; `:47-53` | Toolchain registration is System-Admin | Unchanged |

**Not a mirror, but worth recording:** `src/pages/KnowledgeFlow.jsx:285`, `src/pages/knowledge-scope.js:36` and `src/pages/ProcessCanvas.jsx:179` do `teams.some(t => t.id === …)` on the *team list*, not on a role — scope selection, not authorization. `KnowledgeFlow.jsx` has no client-side permission gate at all.

### 4.5 — Orchestrator side

| Site | file:line | Today | After |
|---|---|---|---|
| `createTeamsStore` instantiation | `orchestrator/orchestrator.js:271` (`root: WORKSPACE`, `:220`) | The three stores | Teams collection retired (§3.1) |
| `resolveOwnerTeamId` | `orchestrator/orchestrator.js:1145-1151` | `teamsStore.getTeam(teamId)` must exist, else throws | Re-pointed at the Agent Team config set |
| Agent-Team tenant resolution | `orchestrator.js:7373-7376`, stamped `:7390` | `const ownerTeamId = resolveOwnerTeamId(extra.teamId);` | **Retired** — replaced by writing `ownerId` (§3.4) |
| Standalone-agent stamp | `orchestrator.js:7463` | `teamId: ownerTeamId` | Replaced by `ownerId` (§3.5, D8) |
| Member inherit | `orchestrator.js:7564-7565`, consumed `:7579`, `:7619`, `:7632`, `:7654` | `const ownerTeamId = teamCfg.teamId \|\| DEFAULT_TEAM_ID;` | **Collapses** — a member's boundary is `parentTeamId` |
| `backfillResourceOwnership` | `orchestrator.js:1031-1104`; blank-fill `:1039-1043`; realignment pass `:1050-1056`; environments `:1059-1073`; four credential indexes `:1075-1099` | Startup, idempotent, in-place, rewrites only on change | **The migration precedent** — §8.3 |
| `planTenantBackfill` | `orchestrator/agent-tenant.js:41-53` | Plans member-tenant realignment | Obsolete for members (§1.3) |
| `resolveAgentOwnerId` | `orchestrator/credential-resolution.js:59-66` | Owner hop (unchanged axis) | Unchanged — becomes live once `ownerId` is written |
| `respawnAgentsForOwner` / `offboardOwner` | `orchestrator.js:8867`, `:8911` (via `selectAgentIdsForOwner`, `credential-resolution.js:154-164`) | Owner-scoped respawn/offboard | Unchanged; become reachable once `ownerId` exists |

### 4.6 — Citation corrections against #2041

#2041's inventory was written against an earlier tree. The differences below are **not** design changes — they are the same sites at their verified `f324aeea0` positions. P2 should work from this table.

| #2041 cited | Verified | Note |
|---|---|---|
| `denyUnlessCanManageAgent` `api.js:4183-4194` | **`api.js:4238-4247`** | +55 |
| admin proxy block `api.js:11702-11884` | **`api.js:11755-11936`** | Block is 182 lines, not 183 at that offset |
| `POST /api/admin/teams` `api.js:11765-11770` | **`api.js:11818-11820`** | `:11765` is inside the `callAdmin` doc comment |
| `POST /api/admin/users` `api.js:11798-11802` | **`api.js:11851-11853`** | |
| `POST`/`DELETE /api/admin/memberships` `api.js:11873-11884` | **`api.js:11925-11934`** | |
| "fresh team has no members" comment `api.js:11763-11764` | **`api.js:11816-11817`** | Single occurrence in the file |
| `POST /api/teams` `api.js:12998` | **`api.js:13051`** | |
| `POST /api/teams/stream` `api.js:13615` | **`api.js:13674`** | |
| `GET /api/process/drafts` `api.js:8462-8474` | **`api.js:8515-8526`** | The finding itself is confirmed in full (§11.1) |
| chat `canManage` `api.js:15176` | **`api.js:15241`** | |
| agent-create gates `api.js:3306-3308`, `:3219-3222` | **`api.js:3273`** and **`api.js:3360`** | `:3218-3253`/`:3307` are `resolveTeamMemberVars`, which performs **no** authorization |
| working environments `api.js:12156`, `:12243`, list filter `:12103-12108` | list route **`:12156`**, filter **`:12159`**, create gate **`:12214-12216`**, stamp **`:12252`** | |
| MCP servers `api.js:11337-11361`, `:11428`, `:11459` | list **`:11390-11395`**, create **`:11468-11497`**, update **`:11499-11519`**, delete **`:11521-11535`**, credentials **`:11542-11556`** | And the servers' write routes have **no** gate at all (§11.3) |
| plugins `api.js:8153`, `:8197` | **`:8206-8207`**, **`:8250-8251`** | |
| skills team pool `api.js:9018+` | path builders **`:8885-8906`**, enumerator **`:8928-8945`**, readers **`:9029-9134`** | `:9018` is `skillProvenanceSummary` |
| `resolveOwnerTeamId` `api.js:685-694` | **`api.js:682-694`** (body `:685-694`) | |
| `visibleTeamIds` (named in #2046 chapter 4) | **does not exist** | Not in `api.js` and not exported by `scope.js`. The real spellings are `visibleTeam(scope, id)` and the raw `scope.teamIds` Set (used once, `api.js:8408`). |
| `resolveAgentTenant` twin described as "byte-mirrored" | **semantically identical, not byte-identical; no guard test** | §1.3 |
| `Teams.jsx` `ManageTeamPanel` `:127-272`, ownership `:284-340` | **`:127-281`** and **`:283-368`** | |
| `Shell.jsx` `/teams` nav entry `:155` | **`:159`** | `:155` is `/github-events`; `:158` is `/users` |
| `agent-lifecycle-menu.js` export entry `:134-148` | **`:134-140`** | `:142-148` is the separate `extract-template` entry |
| `AuthContext.jsx` under `src/context/` | **`src/auth/AuthContext.jsx`** | `src/context/` has no auth file |
| `scope.js` credential tiers `:156-192` | `normalizeCredential` **`:156-169`**, `visibleCredential` **`:185-192`** | Both correct as a span |

Confirmed exactly as cited: `scope.js:29-31`, `:40`, `:76-101`, `:94-101`, `:115-119`, `:124-128`, `:288-292`, `:352-354`; `teams-store.js:3-31`, `:17`, `:40`; `auth.js:41-42`, `:124-133`; `orchestrator.js:3455-3456`, `:7565`, `:1031-1102` (function actually ends at `:1104`); `agent-lifecycle-menu.js:184-222`, `:217`; `rail-lifecycle.js:307-323` (as the team *branch*); `RailLifecycleHost.jsx:482-496` (as the *switch* body); `docs/teams-data-model.md:8-12`.

---

## 5 — Resource ownership tiers (D7, D12)

### 5.1 — The principle (D12)

> **What is only configuration or content becomes self-service and tiered; what runs as infrastructure stays with the administrator.**

The principle exists so the next resource kind does not need another round of questions. Applied:

| Resource | Tiers today | After | Why |
|---|---|---|---|
| **Credentials** (SSH keys, GitHub tokens, MCP credentials) | **personal / team / system** — already three-tier (`scope.js:156-169`, `:185-192`, `:224-234`, `:239-253`) | **Re-pointed only.** The team tier keys on an Agent Team id. | Content. Already tiered; the personal tier's no-`all`-bypass guarantee is untouched. |
| **Model providers** | **team / system** with `assignedTeamIds[]` (#800; `assistSelectableEndpoint` `scope.js:212-219`) | **Stay system-wide**, re-pointed. | Cost and quota belong in one place. |
| **Skills** | **global pool + per-team pool + per-agent** (`api.js:8885-8906`, `:9076-9093`) | **Tiered + self-service**, re-pointed. | Content. Already exactly the shape D12 wants. |
| **Working environments** | **single `teamId`, no shared tier** (`api.js:12159`, `:12252`) | **Gains the shared tier** (§5.2). | Configuration. The one genuinely new piece D7 names. |
| **MCP servers** | **single `teamId`, no shared tier** (`api.js:11395`, `:11487`) | **Gains the shared tier** — same gap, same fix. | Configuration (a stanza of text). |
| **Plugins** | install/uninstall System-Admin-only (`api.js:8206-8207`, `:8250-8251`); per-team assignment already exists (`PluginTeamAssign`, `plugins[]`/`pluginsOverride`) | **Installation stays System-Admin.** Assignment and use continue as today. | Infrastructure: a plugin is a **broker sidecar container holding the team's credentials**. |
| **Toolchains** | System-Admin-only (`api.js:12089`, `:12122`) | **Unchanged.** | Infrastructure: a toolchain names a container **image** that runs with the environment's secrets — the only place a client-supplied image reference is accepted. |

### 5.2 — The shared tier for environments and MCP servers

Both carry one `teamId` today. The tier model to copy is the credential one, because it already exists, is already tested, and its client mirror (`credential-scope-view.js`) is already written:

**Before** (`/workspace/environments/<id>/environment.json`, stamped at `api.js:12252`):

```json
{ "id": "agent-studio", "name": "Agent Studio", "teamId": "default", "repositories": [ … ] }
```

**After** — an explicit `scope`, mirroring `normalizeCredential` (`scope.js:156-169`):

```json
{ "id": "agent-studio", "name": "Agent Studio", "scope": "team",
  "teamId": "agent-studio-2-0", "assignedTeamIds": [], "repositories": [ … ] }
```

```json
{ "id": "shared-infra", "name": "Shared infrastructure", "scope": "system",
  "teamId": null, "assignedTeamIds": ["agent-studio-2-0", "platform-x"], "repositories": [ … ] }
```

A legacy record with no `scope` normalises to `{scope: 'team', teamId: teamId || <migrated id>}` — the same backward-compatible default `scope.js:168` already uses for pre-#798 credentials. `canManageEnvironment` (`scope.js:297-301`) grows the `assignedTeamIds` branch `visibleCredential` has at `:190`, and creating/changing a `system`-tier record is gated like `canReassignCredential` (`:257-259`, System-Admin-only). MCP servers take the identical treatment.

**Consequence D7 names explicitly:** creating a team must not require configuring a repo, an SSH key, a token and a model provider first. With the shared tier, a fresh team can select an existing shared environment; combined with the repo-less path (`api.js:13160-13172`), a team can be created with **no** infrastructure of its own.

### 5.3 — The one migration detail in the skills tier

The team pool is a **filesystem path**, not a record: `path.resolve(WORKSPACE, 'teams', teamId, 'skills')` (`api.js:8887`), validated by `POOL_TEAM_ID_RE`. Re-pointing the key therefore means **moving directories** — `/workspace/teams/<oldScopeId>/skills/` → `/workspace/teams/<agentTeamId>/skills/` — for every migrated scope. §8.3 covers it. The `/workspace/teams/<id>/hill-climb/` tree (anomaly history, metrics, cards) sits under the same parent and is already keyed by **Agent Team** id, so it needs no move — which is itself a hint that the Agent Team id was always the more natural key.

---

## 6 — Team Member permission matrix (D9)

**A Team Member may read and chat — nothing else.** Reading (agent list, chats, session history, workspace files) and chatting with the team's agents is allowed; **no changes to any agent setting** — prompt, model, plugins, skills, triggers, the flow, agent lifecycle (create/clone/disable/delete), team settings and the member list are all **Team Admin** only.

The matrix below is #2041 §7 carried over verbatim, with the enforcement site for each row.

| Surface | Team Member | Rationale | Enforcement after P2 |
|---|---|---|---|
| Chat + session history | **allowed** | The core of D9. | `visibleAgent` (`scope.js:66-74`) |
| Workspace **reads** — tree, file, image, download | **allowed** | Reading. | New gate on `api.js:16133`, `:16304`, `:16366`, `:16413` (§11.2) |
| Workspace **writes** — delete/move/upload file, `git-action` (commit/push) | **Team Admin only** | Destructive and outward-facing. A member can still *ask the agent* to do it, which leaves an attributable trace in the chat. | New gate on `api.js:16448`, `:16506`, `:16943`, `:17103` (§11.2) |
| Triggers / cron / loop — **viewing** | **allowed** | Reading. | `GET /api/agents/:id/triggers` (`api.js:4804`) — currently ungated for read, correct under D9 once `visibleAgent` is applied |
| Triggers — create/edit/delete **and manual firing** | **Team Admin only** | Editing one is a setting change. Firing one produces an autonomous run that reads as system-initiated, whereas the same work requested in chat stays attributable to the person who asked. | `denyUnlessCanManageAgent` already covers create/edit/delete (`api.js:4866`, `:4916`, `:5009`). **There is no manual-fire route in `api.js` today** — verified: nothing under `/api/agents/:id/triggers/*` fires a trigger, and the only `…/run` route is the hill-climb pass (`api.js:7453`). The rule is therefore **pre-emptive**: whatever surface delivers manual firing must ship with the `canManageTeam` gate rather than acquire it later. |
| **Export (ZIP)** of the team | **allowed** | Ungated today (`agent-lifecycle-menu.js:134-140`, route `api.js:3716`) and consistent with "may read" — but it does mean a member can take a complete copy of the team definition. **Accepted consequence, recorded so it is not a surprise.** | Unchanged (deliberately) |

**Two implementation notes.** (1) `canManageAgent` (`scope.js:288-292`) already means *team-admin of the owning team*, so every mutation route listed as Team-Admin-only in the matrix is **already gated correctly today** and mainly needs re-pointing in P2 — the exception is the work-plane family, which has no gate at all (§11.2). (2) The client already implements this split for one surface and it is the pattern to copy: `settingsSubject` (`agent-chat/agent-settings-view.js:39-47`) **hides** the Settings tab when the list payload's `canManage` is false, i.e. parity with what the server would refuse rather than a button that 403s.

---

## 7 — Sharing (D2, D3, D8, D11)

### 7.1 — The Share dialog is a front end, not a new mechanism

The writes already exist and are already gated on the right predicate:

| Piece | Where | Change |
|---|---|---|
| Menu entry | `agent-lifecycle-menu.js` `buildTeamMenu` **:184-222** — add `share` in the management group between `edit-team` (**:212-216**) and `export-team` (**:217**), before the `danger` tail | New entry; reaches the chat rail automatically via `railMenuItems` (`rail-lifecycle.js:307-323`) |
| Dispatch | `RailLifecycleHost.jsx` `choose()` team branch **:479-497**, switch **:482-496** | New `case 'share':` |
| Read | `GET /api/admin/memberships` (**api.js:11916**, filter **:11921**) | Re-keyed |
| Write | `POST` / `DELETE /api/admin/memberships` (**api.js:11925-11934**) — already gated on `canManageTeam` | Re-keyed + the D4 last-admin rule (§2.3) |
| Drift guards to update | `rail-lifecycle-wiring.test.js`, `rail-lifecycle.test.js`, `agent-lifecycle/agent-lifecycle-menu.test.js`, `agent-chat/agent-chat-help-extraction.test.js:253` | |

**The one real gap: the chat payload ships the wrong predicate.** `GET /api/matrix/agents` sets `canManage: canManageAgent(scope, agentMetaForScope(cfg))` (**api.js:15241**). D9 gates member management on `canManageTeam`. After D1 those two coincide for a `role: 'team'` row — `canManageAgent` delegates to `canManageTeam` on the agent's own team, which for a team agent is itself — so the existing field is *sufficient*, but relying on that coincidence is fragile. **Recommendation:** ship an explicit `canManageTeam` field on `role: 'team'` rows rather than inferring it, so a later change to `canManageAgent` cannot silently open the member list.

**AC8's disabled-with-hint requirement** is already the house pattern: the gate closure at `agent-lifecycle-menu.js:186-189` sets `disabled: !canManage` plus `title: NO_RIGHTS_HINT`, so a Team Member sees **Share…** greyed out with the reason rather than not at all — the deliberate opposite of `Teams.jsx:472-483`, which hides its admin actions.

### 7.2 — The open directory (D2, D11)

`visibleUser` (`scope.js:124-128`) shows only users who share a team. Under private-by-default that leaves a **fresh team owner unable to invite anybody** — which is why D2 reverses it.

**The relaxation must not widen the admin payload.** `GET /api/admin/users` (`api.js:11841-11847`) returns full user records — including `systemAdmin` (`teams-store.js:17`, `:234`) and `githubHandle`. D2 excludes the first (it would tell every user who the administrators are) and D11 the second (it publishes a link between corporate identity and a possibly-private external account). So the design is **two surfaces, not one relaxed surface**:

| Surface | Route | Visibility | Projection |
|---|---|---|---|
| Administration → Users (System Admin) | `GET /api/admin/users` (**api.js:11841**) | `scope.all` or `visibleUser` — **unchanged** | Full record (as today) |
| **The open directory** (the Share picker) | `GET /api/users/directory` — **built by #2068** | Any authenticated user | **`{ id, displayName, email }` only** — never `systemAdmin`, never `githubHandle`, never `hasPassword`, never `chatFontSize` |

Projecting at a **separate route** rather than conditionally inside the admin one is what makes "the flag is never exposed" checkable by a test that asserts the response keys, instead of a review of every branch. `visibleUser` itself stays as the gate on the admin surface.

**Worth one data-protection sign-off** (names + corporate email become visible to every user) — recorded in #2041 D2 and inherited here.

### 7.3 — Existing accounts only (D3)

Sharing offers only existing users; creating user records stays a System-Admin action (`POST /api/admin/users`, **api.js:11851-11853**). The login side is the same constraint from the other direction: an unregistered principal **cannot get a session at all** — `isKnownPrincipal` (`scope.js:352-354`) gates the IAP bridge at `auth.js:124-133`, and `computeScope` fails closed for an unknown subject (`scope.js:37`).

**The accepted cost:** a colleague who has never logged in needs a one-time admin step — once per person, not once per team. **This is the redesign's remaining admin bottleneck** and it is a deliberate choice, not an oversight: auto-provisioning on first IAP login is the alternative and was not adopted.

### 7.4 — Only self-contained units are shareable (D8)

One entry point, one rule: **sharing always applies to a self-contained unit.**

> **Amended by #2068.** This section originally read *"only teams are shareable"*
> and did not mention drafts. The rule D8 actually states is the sentence above —
> *self-contained unit* — and a **flow draft** is one: a single bundle document
> with no runtime, no credentials and no members. So drafts are shareable too,
> and the heading now says what D8 means rather than what the team surface
> happened to be at the time. The exclusion D8 exists for is unchanged: a **team
> member** is not self-contained and is never shared on its own.

- A **team** is shareable (§7.1). A **team member** always follows its team's access — after D1 that is mechanical, since its boundary *is* `parentTeamId` (§1.3).
- A **flow draft** is shareable (**#2068**, §11.1) — with one deliberate difference from a team: it has **no roles**. Every holder is a full equal, because the read/chat-vs-configure split D9 draws needs a runtime to divide, and a draft has none. Sharing one is therefore irreversible from the sharer's side: a holder can remove you.
- A **standalone agent** stays private to its creator (`ownerId`, §3.5). Not a dead end: it can still be handed over via the existing **Export (ZIP)** / clone path (`agent-lifecycle-menu.js:134-140`).
- **Consequence for #1459:** its per-agent `private`|`team` visibility toggle has no role left — D8 makes owner-only the rule for standalone agents and team-following the rule for members, so a third state is unreachable. What survives and is **still needed** is #1459's `ownerId` population/backfill (§3.6) and its §2 finding about the ungated work-plane routes (§11.2).

---

## 8 — Migration (D6)

**Everyone who can see a team today stays a member; today's scope `team-admin`s become Team Admins. "Private by default" applies to newly created teams only.** No lockout, no re-sharing marathon, no launch event.

### 8.1 — The mapping

The migration's whole job is to turn *(user ↔ access-scope)* memberships into *(user ↔ Agent Team)* memberships. For each access scope `S` and each Agent Team `T` currently stamped `teamId: S`:

| Input | Output |
|---|---|
| `membership {userId: U, teamId: S, role: R}` | `membership {userId: U, teamId: T, role: R}` — **for every** Agent Team `T` in `S` |
| `role: 'team'` config of `T`, no owner | `ownerId` = the first `team-admin` of `S` (deterministic order: earliest `createdAt`), else the first member, else unset |
| standalone `role: 'agent'` config in `S` | `ownerId` = same resolution |
| `S` has no Agent Team | nothing to create — the scope simply disappears with its memberships |

**A scope with N members and M Agent Teams produces N×M memberships.** That is the honest consequence of collapsing a grouping layer: what was one grant over a container becomes one grant per team. It is also why D6 is a *preserve-access* migration rather than a *tidy-up*.

### 8.2 — Original creators are unrecoverable — the hard constraint

**No `createdBy` and no `ownerId` exists anywhere today** (§3.6, verified exhaustively). Nothing in the repository, the git history of a config, or the audit trail reconstructs who created a given team: `audit.js` records the actor per mutating request, but the audit files are best-effort, day-bucketed JSONL with no retention guarantee, and an agent created before the audit trail existed has no line at all.

So the owner assigned by the migration is a **defensible placeholder, not a recovered fact**, and the document says so rather than implying provenance. The consequence to state in the release note: **an owner may be wrong and must be correctable** — a System Admin can reassign it (D5), and any `team-admin` of the migrated team can act regardless, so a wrong `ownerId` is a cosmetic error rather than a lockout.

### 8.3 — How the no-lockout property is proven

The precedent to copy is `backfillResourceOwnership` (`orchestrator/orchestrator.js:1031-1104`): a startup-time, **idempotent**, in-place backfill that rewrites JSON **only when the value actually changes**, and which already contains both a blank-fill pass (`:1039-1043`) and a **realign-to-the-derived-value** pass (`:1050-1056`) — exactly the two shapes this migration needs.

**The proof is a before/after fixture test** (#2041 AC2), and its assertion is a set equality, not a spot check:

> For every resource `R` (agent, Agent Team, environment, credential, MCP server, skill-pool entry) and every user `U`: `visible_after(U, R) ⊇ visible_before(U, R)`, and `canManage_after(U, R) ⊇ canManage_before(U, R)`.

Run the **real predicates** (`visibleTeam`/`visibleAgent`/`canManageTeam`/`canManageAgent`/`visibleCredential`/`canManageEnvironment`) over a before-fixture with the old store shapes and an after-fixture produced by the migration function, for the full cross-product of users and resources. `⊇` rather than `=` is deliberate: the N×M expansion means some users legitimately gain reach (a `team-admin` of a scope becomes `team-admin` of each of its teams, which is what D6 asks for), while **losing** any is the failure the test must catch.

Three things the fixture must include, because each is a distinct failure mode: a user with **no membership** (fail-closed today, must stay fail-closed), a `team-member` agent whose stamped `teamId` **disagrees** with its parent's (the state `planTenantBackfill` exists to fix — after D1 the parent id simply wins), and a **system-tier credential assigned to several scopes** (`assignedTeamIds[]` must fan out to every Agent Team of every assigned scope, or a shared credential silently disappears).

**Filesystem moves are part of the migration, not a follow-up:** every `/workspace/teams/<scopeId>/skills/` directory (§5.3) must move to `/workspace/teams/<agentTeamId>/skills/`, and when a scope holds several Agent Teams the pool has to be **copied to each** — the alternative (pick one) silently removes skills from the others. This is the one irreversible step; it should run after the JSON migration has been verified, and the source directory should be left in place for one release rather than deleted.

### 8.4 — The `'default'` fallback

`|| 'default'` appears in six predicates (`scope.js:60`, `:118`, `:168`, `:266`, `:291`, `:300`) plus `resolveOwnerTeamId` (`api.js:686`) and `resolveAgentTenant` (`scope.js:100`). It exists because `teams/index.json` always contains a protected `default` team (`teams-store.js:185-187`, `:416-430`).

**After D1 there is no default team**, so the fallback has no referent and must not be silently retained: `scope.roles.get(undefined || 'default')` on an empty map is harmless, but `visibleTeam(scope, undefined)` returning true for anyone holding a membership named `default` would be a real leak if a team were ever created with that slug (nothing prevents it — `TEAM_ID_RE` allows it). **P2 must remove the fallback and fail closed on a missing team id**, and a test should assert that an unstamped resource is invisible to a non-admin rather than defaulting into view.

### 8.5 — Scale of this installation

#2041 records that **all three current scopes have exactly one member each**, making the migration small and the N×M expansion a non-issue here.

**This document cannot verify that number** and does not assert it: `/workspace/{teams,users,memberships}/index.json` live on the orchestrator's shared volume, and an agent container mounts only its own `/workspace/agents/<id>/` subtree (verified: no such file is reachable from a build or agent container, and nothing in the repository seeds three scopes). It is an **operator-supplied datum to re-confirm on the host before P1 runs** — `cat /workspace/memberships/index.json` on the orchestrator. The migration design deliberately does not depend on it.

---

## 9 — Information architecture (D10)

**The *Access* nav entry is dissolved, not renamed.** `/teams` and its page are retired; the System-Admin all-teams cleanup view (D5) and the reworked resource ownership (D7/D12) move onto the Users page as **tabs**, and that single surviving entry becomes **Administration** — tabs *Users / All Teams / Resources*, System-Admin-only.

### 9.1 — Target shape

| Nav entry today | file:line | After |
|---|---|---|
| **Users** — `/users`, `adminOnly: true`, subtitle *"Human user accounts"* | `Shell.jsx:158` | **Relabelled "Administration"**, stays `adminOnly: true`, hosts three tabs |
| **Access** — `/teams`, label `'Access'`, subtitle *"Teams, roles & assignments"*, **no role gate** | `Shell.jsx:159` | **Removed** |

| Tab | Source today | Notes |
|---|---|---|
| **Users** | `Users.jsx` (unchanged) | Human-user CRUD, `POST /api/admin/users` (D3) |
| **All Teams** | new — the System-Admin cleanup view (D5) | Reads the Agent Team list; delete cascades memberships (§3.3) |
| **Resources** | `Teams.jsx` `ResourceOwnership` **:283-368** + `teams-ownership.js` `groupAgentsForOwnership` **:38-64** | Reworked for the D7/D12 tiers (§5) |

Retired with the page: the team table (`COLUMNS` **:404-434**), `ManageTeamPanel` (**:127-281**, superseded by the Share dialog), the page-level role mirror (`isAdmin` **:377**, `canManage` **:378-379**) and `agentTeamTenant` (`teams-ownership.js:69-71`, which collapses).

### 9.2 — Why dissolving is cheaper than renaming

A nav change in this console is **not a local edit**. It is a sweep through the nav data (`Shell.jsx`), `breadcrumbs.js` (**:29** `'/teams': 'Access'`), `route-title.js` and its test, the nav-smoke e2e, the affected help topics plus `help-registry.test.js`, the tour manifest, and the `docs/*.md` files in `CORPUS_FILES` **together with their byte-identical vendored copies** under `admin-console/api/helper-chat/docs/` (see §12.1).

Dissolving pays that sweep **once**, in P6. Renaming first and dissolving later pays it twice and leaves an intermediate name that is already obsolete when the redesign lands. **This is what makes #1910 (*Rename Access & Users → Access*) obsolete** — its whole deliverable is discarded by D10.

### 9.3 — The surfaces P6 must touch

Verified present on `f324aeea0`:

| Surface | Where |
|---|---|
| Nav entries | `src/components/Shell.jsx:158`, `:159`; group `administration` `:157-163` |
| Route registration | `src/App.jsx:192` (`/teams`, **no guard** — the only ungated Access surface), `:193` (`/users`, `AdminRoute`); lazy imports `:81`, `:82` |
| Breadcrumb label | `src/components/breadcrumbs.js:29` |
| Route title | `src/pages/route-title.js` — **carries no `/teams` entry today**; the `/users` entry is what gets relabelled |
| Help topics | `help-topics/access-users.md` (claims `routes: ["/teams"]` — retired or re-pointed) and `help-topics/users.md` (claims `/users` — becomes the Administration topic). Seven further topics *link* to one of the two routes in `seeAlso` (`agent-chat`, `credentials`, `overview`, `plugins`, `settings`, `team-setup`, `token-usage`) and each link must be re-pointed or removed, or `help-topics-content.test.js` fails on an unknown `seeAlso` target |
| Route topology | `help-routes.js` `PAGE_ROUTES` → move `/teams` to `REDIRECTS`/`ALLOWLIST` (the #1930 precedent), plus the client mirror in `src/context/page-help-view.js` — the parity block in `page-help-view.test.js` is what catches a one-sided edit |
| Overlay keys | `modal:team-manage` (registered by #1996 for `ManageTeamPanel`) retires with the panel; `modal:user-edit`/`modal:user-delete` survive |
| Docs | `docs/admin-console.md` (**in `CORPUS_FILES`** — vendored twin must be re-copied), `docs/teams-data-model.md`, `docs/multi-user-concept.md`, `docs/governance-concept.md`, `admin-console/CLAUDE.md`, root `CLAUDE.md` |
| e2e | `e2e/journey-runner/fixtures.js`, `e2e/steps/{team,usage,wizard}.js`, and the committed `e2e/steps-catalog.json` (has a freshness test — regenerate with `npm run journeys:catalog`) |

---

## 10 — Phase plan and test strategy

D1 is a large change to a load-bearing key, so it is sliced so **each phase ships green**. P1–P3 are invisible plumbing; **P4 is the feature the requester asked for.**

| Phase | Content | Depends on | What proves it green |
|---|---|---|---|
| **P1** | Ownership data model: `ownerId` on Agent Teams and standalone agents (§3.4, §3.5); `memberships.teamId` re-pointed (§3.3); migration per D6. **No behaviour change.** | **#2046** (this doc) | **The before/after fixture test (#2041 AC2, §8.3)** — set-equality over the real predicates for the full user×resource cross-product, including the three failure-mode fixtures. Plus: the existing `scope.test.js` tenant block (`:555-608`) and `orchestrator/agent-tenant.test.js` (`:23-38`) must be re-pointed together, and a **new mirror guard** for the two `resolveAgentTenant` copies (§1.3 — there is none today). |
| **P2** | Enforcement re-pointed (§4); `resolveAgentTenant` collapse; `scope.all` kept; the `'default'` fallback removed (§8.4); **process drafts/flows scoped** (§11.1 — **done, #2068**, cut out as its own ticket because it does not depend on P1's membership re-keying); the work-plane family gated (§11.2); MCP server writes gated (§11.3). | P1 | Predicate unit tests in `scope.test.js` re-keyed; **a route-coverage test** asserting every route in the §11 inventory now resolves a scope (the `orphan-routes.test.js` shape — assert on route *registration*, not behaviour); a two-user integration check that user B does not see user A's drafts (#2041 AC4). |
| **P3** | Self-service creation (`POST /api/teams` **api.js:13051** + stream **:13674**); creator becomes owner **and** `team-admin` in the same operation; last-admin successor rule (D4, §2.3). | P2 | A creation test from a **membership-less** user (today impossible — `api.js:11816-11817` explains why); an idempotence test that the creator's membership is written exactly once by both the streaming and non-streaming handler (they duplicate their var shape inline at `:13436` and `:14036`, so both must be asserted); D4 refusal tests on all three routes in §2.3. |
| **P4** | **Share dialog** in the Agent-Chat team context menu (§7.1) + the open directory (§7.2). | P3 | The four drift guards named in §7.1; a response-key assertion on `GET /api/users/directory` (never `systemAdmin`, never `githubHandle` — D2/D11); a server-side test that a Team Member's `POST /api/admin/memberships` is refused (**not** only that the button is disabled — #2041 AC9). |
| **P5** | Layered resource ownership (D7, §5.2) — shared tier for working environments and MCP servers; credentials and model providers re-pointed. | P2 | Tier tests mirroring the credential ones; **a create-a-team-with-no-infrastructure test** (D7's stated consequence, §5.2). |
| **P6** | Access page rework + System-Admin cleanup view (D5) + docs/help/corpus (§9). | P3, P5 | `help-coverage.test.js` (a page route may not silently lose its topic), the `page-help-view.test.js` parity block, `corpus.test.js` (vendored-copy byte-identity + the worst-case grounding budget), `help-registry.test.js`, the nav-smoke e2e and the `steps-catalog.json` freshness test. |
| **AC13** | The end-to-end journey, after P4 | P4 | **One e2e journey** proving the loop: user A creates a team → user B does not see it → A shares it with B as Team Member → B sees it but cannot change members → A promotes B to Team Admin → B can → A is removed as last admin only after naming a successor. This is the only test that exercises D1+D4+D9 together. |

**Two strategy notes.** (1) **Every "cannot" in the ACs must be asserted server-side.** The console's own comments say the client gating is UX, not the boundary (`App.jsx:41-45`, `credential-scope-view.js:9-11`, `Shell.jsx:209-215`); a test that only checks a disabled button proves nothing about the API. (2) **P2 is where the two `scope.all` spellings bite** (§4.2): a sweep that greps only `scope.all` misses eight `getScope(req).all` sites.

---

## 11 — Known holes this redesign makes load-bearing

These are **verified live gaps**, harmless only while everyone shares one access scope. The moment teams are private, each becomes a cross-tenant read or write. They are recorded here because P2 must ship them, not because this document discovers them for the first time — `docs/governance-concept.md` §4 already names the class (GOV-ACCESS-3, GOV-PLATFORM-4).

### 11.1 — Process drafts / flows have no gate at all — **CLOSED by #2068**

> **Status: closed.** #2068 implemented and refined this row's AC4 for drafts.
> The finding below is kept as the record of what was there; what was built
> differs from what this section predicted in one deliberate way, described
> after the table.

**Confirmed in full.** All six `/api/process/drafts*` routes were cross-tenant **readable, writable and deletable**, and the persisted record had no tenant field for a gate to key on:

| Route | file:line | State |
|---|---|---|
| `GET /api/process/drafts` | **8515-8526** | Enumerates the whole directory (`fs.readdirSync(PROCESS_DRAFTS_DIR)`, `:8518`) and returns **every** draft to **any** authenticated caller. No `getScope`, no `visibleTeam`, no `teamId`. |
| `POST /api/process/drafts` | **8528-8544** | Persists `{...bundle, id, createdAt, updatedAt}` (`:8540`) — **no `teamId`, no `ownerId`** |
| `GET /api/process/drafts/:id` | **8546-8552** | Id-shape + existence only |
| `PUT /api/process/drafts/:id` | **8554-8594** | Id-shape + existence + `validateProcessTemplate`; the rename path (`:8570-8592`) can **move another caller's draft's id** |
| `DELETE /api/process/drafts/:id` | **8596-8603** | Any caller may delete any draft |
| `POST /api/process/drafts/import-briefings` | **8636+** | Agent-path containment only (`safeAgentPath`), no team scope |

The only protections present are the traversal guard (`draftPath` **:8499-8505** + `DRAFT_ID_RE` **:8495**) and `apiLimiter` on the mutating routes.

**The fix was a schema change before a gate was even possible.** This section predicted "an owning team (and/or `ownerId` for a personal draft)". **#2068 took the parenthetical, and dropped the owner as an authorization concept entirely** — for a structural reason this section did not have room for: a draft is by definition *"an editable process-template bundle that exists before any team is materialised"*, so at create time there is no Agent Team to scope it to, and the D1 boundary is not expressible on it. What shipped:

| Predicted | Built (#2068) |
|---|---|
| `teamId` (and/or `ownerId`) on the record | **`createdBy`** — immutable provenance, shown in the list, **never** read by a gate — plus a flat **`accessUserIds`** set |
| Filter on every read, gate every write | One predicate, `canAccessDraft(scope, draft)` — *is the caller in the access set?* — with the `scope.all` shortcut (the `visibleAgent` pattern, **not** the personal-credential tier, which has no admin bypass). Called from all six routes plus the three new access routes; refusal is the same 404 as a non-existent draft, so the endpoint is not an existence oracle |
| — | A **Share…** action on the draft's Flows-rail row, over the open directory §7.2 specifies (**#2068 is the ticket that built `GET /api/users/directory`**) |
| — | Everyone in the access set is **fully equal** (DD2): edit, rename, export, create a team, share on, remove anyone — including you — and delete. There are no roles, deliberately: a draft has no runtime, no credentials and no outward effects, so the read/chat-vs-configure split D9 draws has nothing to bite on. The cost is stated in the UI: **sharing a draft is a one-way act of trust, not a lend** |
| — | Two invariants that fall out of the equality: the access set can **never be emptied** (the last holder is refused and pointed at *Delete draft*), and a **user deletion** strips the departing human from every set without deleting anything — a set left empty keeps the draft, System-Admin-reachable |
| D6 migration | Literal: every draft existing at upgrade time gets `createdBy` = the first System Admin and an access set of **all current users**, so nobody loses anything on upgrade day. Stamped once at startup (`backfillDraftAccess`), re-runs are no-ops |

Two things it deliberately did **not** do. The draft id namespace stays global and name-derived, so naming a draft after an invisible one still yields a `-2` suffix — the *existence* of a name leaks, never any content, and decoupling the id from the name is a separate follow-up. And **creating a team does not propagate the draft's access set**: the team belongs to whoever clicked *Create team…* (P3 owns that), so a colleague who materialises a draft you shared gets a team you cannot see.

Decision core: `admin-console/api/draft-access.js` (pure, `draft-access.test.js` carries the two-user loop this row's P2 line named); wiring guarded by `draft-routes-access.test.js`. Client decisions in `admin-console/src/pages/process/draft-share-view.js`.

### 11.2 — The work plane is ungated

**The last scope-aware line in `api.js` is 15214/15223** (`GET /api/matrix/agents`). Every route declared after it — **32 API routes** from `api.js:15344` to `:17498` — contains **no `getScope(req)` call at all** (verified: `getScope` appears 134 times in the file, none past `:15214`). That family covers:

- Matrix DM creation and room messages (`:15344`, `:15377`, `:15398`) — *"post into any Matrix room as the admin token"*
- session current/ticket/stop/history (`:15683`–`:16046`) and the SSE stream (`:17498`)
- workspace **reads** — tree `:16133`, file `:16304`, image `:16366`, download `:16413`, git-info `:16263`, git-status `:16845`, git-diff `:16981`
- workspace **writes** — delete `:16448`, move `:16506`, **`git-action` (commit/push) `:16943`**, upload `:17103`
- context-mount writes — delete `:17224`, move `:17242`, upload `:17266`

`docs/governance-concept.md:197-201` describes the same family (*"any user can read/write any agent's workspace, run git commit/push in it, and post into any Matrix room as the admin token"*) and owns it as **GOV-ACCESS-3** (`:223`) / **GOV-PLATFORM-4** (`:725`); #1459 §2 records the same finding. **Under private-by-default this is the widest hole**, because it is reachable with nothing but an agent id — which the chat list of any team a user *does* belong to hands out.

P2 must gate the whole family, and the D9 matrix (§6) is the split: reads → `visibleAgent`, writes → `canManageAgent`/`denyUnlessCanManageAgent`.

### 11.3 — MCP server writes are ungated — **CLOSED by #2083**

> **Status: closed.** All four routes are gated as of #2083 (P5), which needed
> them gated anyway: a shared tier whose assignment any authenticated caller can
> rewrite is decorative. The line numbers in the table below are historical.
> `GET /api/mcp-servers/:id` refuses with **404** rather than 403 so the route is
> not an existence oracle, matching `GET /api/llm-endpoints/:id`; the three
> writes take `canManageEnvironment`, which is the predicate this section
> predicted, and `PUT` additionally gained the re-parenting gate the environment
> `PUT` has had since #989 and this section did not notice was missing. Wiring
> guard: `admin-console/api/tiered-resource-routes.test.js`.
>
> **This is a behaviour change for a plain Team Member**, who could previously
> register, edit and delete registry entries. Recorded here rather than in a
> release note alone, because it is the one place where closing a §11 leak
> narrows an existing, working permission rather than an accidental one.

Unlike the MCP **credentials** route beside them, the MCP **server** routes carried no authorization:

| Route | file:line | Gate today |
|---|---|---|
| `GET /api/mcp-servers/:id` | **11416-11421** | **none** — returns the raw stanza |
| `POST /api/mcp-servers` | **11468-11497** | `resolveOwnerTeamId` validation only (`:11481`) — **no `canManage*`** |
| `PUT /api/mcp-servers/:id` | **11499-11519** | **none** |
| `DELETE /api/mcp-servers/:id` | **11521-11535** | in-use 409 only (`:11525-11526`) |
| *(contrast)* `POST /api/mcp-credentials` | **11545-11556** | `resolveOwnerTeamId` **+ `canManageEnvironment`** (`:11554-11556`) |

A `stdio` MCP server's `command` **executes inside the agent containers** of any environment that references it — `docs/governance-concept.md:193-195` names this as a live risk. The fix is one line per route: the `canManageEnvironment` predicate its own credentials sibling already uses.

### 11.4 — Two smaller ungated reads — **partially closed by #2083**

> **Status: half closed.** `GET /api/environments/:id` is gated as of #2083
> (`visibleEnvironment`, 404 on refusal), for the same reason as §11.3: a tier
> the read-one path ignores is decorative. `GET /api/agents/:id/triggers`
> is **untouched** — it is a work-plane route and belongs with §11.2, which no
> phase has yet claimed.

`GET /api/environments/:id` (**api.js:12167-12172**) has **no team gate on read** — only the nested agent list is scoped (`:12171`) — so an environment's full record (including its `githubTokenId` and repository URLs) is readable by any authenticated caller who knows the id. And `GET /api/agents/:id/triggers` (**:4804**) is ungated for read, which is *correct* under D9 for a member of the owning team but not for an outsider.

---

## 12 — Non-goals, dependencies, contradictions raised

### 12.1 — Explicit non-goals of this ticket

- **This file is NOT added to `CORPUS_FILES`** (`admin-console/api/helper-chat/corpus.js:38-55`). No `*-concept.md` is in that list, and none should be: a listed doc acquires a **byte-identical vendored twin** under `admin-console/api/helper-chat/docs/` that `corpus.test.js` asserts, and its content is folded into **every** helper-chat context, so adding one moves the worst-case grounding figure — which has three synchronised homes (the `corpus.js` comment, the `CLAUDE.md` #1872 paragraph, and `docs/context-help-system-concept.md` §9). This is an internal design doc; `corpus.test.js` and `help-registry.test.js` stay green with no vendored copy added.
- **D1–D12 are not re-opened.** Where the writing surfaced a genuine contradiction it is raised on the ticket rather than resolved here (§12.2).
- **No code changes.** The only edits outside this file are the successor pointers #2046 AC7 asks for, in `docs/teams-data-model.md` and `docs/multi-user-concept.md` §3. Their **bodies** are rewritten in P6, not here.
- Not in scope: SSO/OIDC provisioning (#178), per-human Matrix identity (#1458), token-usage accounting (#288).

### 12.2 — Contradictions raised, not resolved

Two points where #2041 / #2046 disagree with themselves or with the code. Both are recorded here and raised on the issues; **neither is resolved by fiat in this document.**

1. **Where the member list lives.** #2041 §1 says the `role: 'team'` config gains *"its own member list with roles"*, while **D1**, §1's next bullet and §5 (the Share dialog writes `POST`/`DELETE /api/admin/memberships`) all say `memberships/index.json` survives as the member list. Two stores for the same fact would drift, and only one of them is what `canManageTeam` reads. **This document specifies `memberships/index.json` as the single member list** (§3.3, §3.4) because that is what two of the three statements require and it keeps `canManageTeam` unchanged — but the wording in #2041 §1 should be corrected rather than left ambiguous for P1. *Raised on #2041.*

2. **The wording of the privacy guarantee.** #2046 chapter 2 instructs the document to state the guarantee as *"private from all named users, System Admins included, while the operator login retains full visibility"*. Read literally that **excludes System Admins**, which contradicts **D5** (*"The System Admin retains full visibility (`scope.all` stays as-is)"*) and **#2046 AC5** (*"no document text claims that System Admins cannot see teams"*). Two of the three signals agree, so **this document follows D5 and AC5** and states the guarantee as §2.2 words it. The quoted sentence looks like it was carried over from the *personal-credential* guarantee (`docs/personal-credentials-concept.md` D2), which genuinely does exclude System Admins because `ownsPersonalCredential` (`scope.js:177-179`) has no `all` bypass — and even there the operator login cannot see them either, its `userId` being `null` (`scope.js:29-31`). *Raised on #2046.*

### 12.3 — Corrections to stated premises

Recorded so P1/P2 do not re-derive them (each verified against `f324aeea0`):

- **The `resolveAgentTenant` twin is not byte-identical** and **no guard test asserts the mirror** (§1.3). #2041 calls it "byte-mirrored".
- **`visibleTeamIds` does not exist** — not in `api.js`, not exported by `scope.js` (§4.6). #2046 chapter 4 names it.
- **`resolveTeamMemberVars` performs no authorization** (`api.js:3218-3253`); the gate on that route is `canManageAgent` at `:3273` (§4.6).
- **`POST /api/teams` resolves no scope at all today** — no `getScope`, no `canManage*`, no `resolveOwnerTeamId` in either handler (§4.2). The premise that creation "requires being `team-admin` of an existing scope" is true of `POST /api/agents` (`:3360`) and `POST /api/agents/:teamId/members` (`:3273`), and of `POST /api/admin/teams` (`:11818-11820`), but not of the Agent-Team wizard route.
- **There is no manual trigger-fire route** (§6). D9's rule for it is pre-emptive.
- **The installation's scope count is unverified from a repository or agent container** (§8.5).
- ~24 cited line numbers have drifted; the reconciliation table is §4.6.

### 12.4 — Dependencies

- **#1459** — `ownerId` population/backfill (§3.6) and the work-plane finding (§11.2). Its per-agent `private`|`team` toggle is superseded by D8 (§7.4).
- **#1458** — per-human Matrix identity. **Prerequisite for the chat half of #2041 AC6:** there is one shared Matrix admin identity and one DM room per agent (`dm-room.json`), so private-per-owner *chats* cannot be enforced until the room model is per-human.
- **#1457** — Default Team adoption / compatibility mode; owns the migration mechanics P1 inherits.
- **#1456** — API auth middleware; the enforcement chokepoint P2 hangs off.
- **#1910** — obsolete under D10 (§9.2).
- **`docs/governance-concept.md`** GOV-ACCESS-3 / GOV-PLATFORM-4 own the work-plane gating hole that #2041 AC4/AC6 make load-bearing.

### 12.5 — Successor relationships

This document is the successor design for:

- `docs/teams-data-model.md` — the human-Team data model (#299) that D1 collapses.
- `docs/multi-user-concept.md` §3 — the two-level authorization model, whose per-team tier is re-pointed.

Both keep a pointer to this file; their bodies are updated in **P6**.

---

## Amendment 1 — what P1 (#2077) found, and what it changed here

This section is appended rather than woven in: the document above is the
design-of-record the epic is being implemented against, so it stays readable as
the design that was agreed. This records where implementation contradicted it.

### A1.1 — What changed, and why it is this phase

**The credential switch had to move in P1, not P2.** §3.6 and
`docs/credentials.md` both record that #1569 gates the personal-credential tier
on the agent carrying an `ownerId`. That gate was safe *only* because nothing
populated the field — the code says so itself (`credential-resolution.js`:
"every agent today, since nothing populates it yet"). P1's whole job is to
populate it.

Under the unmodified gate, the D6 backfill would have moved every agent in the
installation into the owned branch in one boot. Every owner starts with **no**
personal credential (they are self-service and opt-in, #1568), so every
`commit` / `pr` / `review` / `push-https` would have been refused with the 424
`personal-credential-required` — i.e. no agent could open a pull request again.
That is precisely the regression **AC7** ("no visible behaviour change")
forbids, so it could not be deferred to P2.

The switch is now *participation* rather than *presence*: an owner with no
personal credential of a kind takes the shared credential exactly as today; an
owner whose personal credential is present-but-unusable is still refused.
Refuse-on-missing keeps its purpose (a human who has a personal credential is
never silently re-attributed) and loses only the case where it protected nobody.
`findPersonalCredentialState` is the new lookup that keeps the two apart.

### A1.2 — Statements above that P1 falsified

| Statement | Where | Correction |
|---|---|---|
| The personal tier is gated on `ownerId` presence, and that reconciles AC5 with AC8 | §3.6 (quoting `orchestrator.js`), `docs/credentials.md` | True only while nothing populates `ownerId`. P1 replaces the gate with owner *participation* — see A1.1. |
| "P1 … `memberships.teamId` re-pointed (§3.3)" reads as a replacement | §10 phase table | It must be **additive** in P1. Enforcement still keys on each resource's `teamId` stamp (an access-scope id until P2), so dropping the scope grants in P1 empties every list for every non-admin. The scope memberships are retired by P2 *together with* the stamps they gate. §8.3's `⊇` is what makes this admissible; the proof is `admin-console/api/ownership-no-lockout.test.js`, which fails when the migration is made replacing. |
| AC5 "no `null` owners for migrated resources" | issue #2077 | Not reachable in general: D6's own rule (§8.1) ends in "else **unset**", so an access scope with no members has no owner to inherit. Such a resource is **reported** at boot (a warning naming the agent and the scope) rather than given a fabricated owner. On this installation (§8.5) every scope has a member, so the case does not arise in practice. |
| AC3 "`teams/index.json` is no longer written or read by any code path" | issue #2077 | Not deliverable in the same phase as AC7. Retiring the file means re-pointing `listTeams`/`getTeam` at the Agent Team config set, which changes what `GET /api/admin/teams` returns and therefore what the Access page and five team dropdowns display — a visible change. It is the same edit as the P2 enforcement re-point and belongs with it. P1 delivers the *memberships* half of AC3 (entries now reference Agent Team ids) and leaves the file read as it is. |

### A1.3 — What is explicitly NOT affected

- **`scope.all`** and both of its branches (§2.2) are untouched.
- **The personal-credential privacy guarantee** (§2.2, `ownsPersonalCredential`
  has no `scope.all` bypass) is untouched, and the no-lockout proof asserts an
  admin still cannot see a personal credential after the migration.
- **`resolveAgentTenant`** and its twin (§1.3) are untouched — the tenant hop
  collapses in P2. P1 changes the owner axis only (§1.4).
- **No resource stamp is re-pointed.** Agents, environments and credentials keep
  their access-scope `teamId`.

### A1.4 — The rule successor phases must carry

**An owner records how it was decided.** §8.2 establishes that a migrated owner
is "a defensible placeholder, not a recovered fact" and must be correctable.
Every write therefore carries `ownerSource` — `creator` (the authenticated human
who made the request), `migration` (the D6 placeholder) or `conversion` (carried
from a converted agent) — and each fanned-out membership carries `fromScopeId`.
Nothing reads either field. They exist so that P6's cleanup view, and any human
auditing an owner, can tell a guess from a fact. **A later phase must not drop
them when it retires the access-scope layer**: the moment the scope memberships
are deleted, `fromScopeId` is the only remaining evidence of where a grant came
from.

---

## Amendment 2 — what P2 (#2078) found, and what it changed here

Appended for the same reason as Amendment 1: the design above stays readable as
the design that was agreed, and this records where implementation contradicted
it.

### A2.1 — The collapse is on the ACCESS axis only; the tenant hop survives

**§1.3 says `resolveAgentTenant` "collapses to a one-line accessor". It cannot,
yet — and doing it in P2 would have been a hard regression.**

That function has exactly two live callers, and neither of them asks an
authorization question:

| Caller | What it resolves |
|---|---|
| `usableEndpointsForTeam` (`api.js`) | which **model providers** an agent may bill against |
| the assist-endpoint pick (`orchestrator.js:375`) | the same, for an autonomous synthesis run |

Both compare the resolved value against a **credential record's** `teamId` /
`assignedTeamIds`, and those records are still stamped with access-scope ids —
§5.1 and the §10 phase table both assign "credentials and model providers
re-pointed" to **P5**, not P2. Collapsing in place would have answered
`agent-studio-2-0` where the credential index says `default`, making every
team-scoped provider unusable: precisely the bug the tenant hop was introduced
to fix, and precisely what AC5 ("no regression for the single-team/default
installation") forbids.

So P2 ships **two** functions with two clearly separated jobs:

- **`resolveAgentTeam`** (new, `orchestrator/agent-team.js` ⇄ byte-identical
  `admin-console/api/agent-team.js`) — the **access boundary**. Collapsed
  exactly as §1.3 describes: no `loadAgentConfig` injection, no parent read.
- **`resolveAgentTenant`** (unchanged, both copies) — the **credential tenant**,
  with its `|| 'default'` fallback intact because the default scope it names
  still exists. It retires with P5, and both copies now say so at the top.

The §8.4 fallback removal therefore lands on the six **scope.js predicates** it
enumerates and deliberately **not** on `resolveAgentTenant`: removing it there
would break the very lookups the hop exists for.

### A2.2 — A standalone agent resolves to `null`, not to its own id

§1.3 sketches the accessor as `role === 'team' ? cfg.id : (cfg.parentTeamId ||
cfg.id)`. For a standalone `role: 'agent'` that yields its own id — a value no
membership can ever name, so it grants nothing and merely *looks* like a
boundary. `resolveAgentTeam` returns `null` instead, which makes the D8
fall-through to ownership explicit and testable at the call site. Same outcome,
one less thing that reads like a team.

### A2.3 — `canManageAgent` needed the owner branch too

§4.1 row 15 records `canManageAgent` as "re-keyed" and mentions no owner rule,
while row 3 makes ownership the primary rule for `visibleAgent`. Shipping only
the visibility half would have left a standalone agent **visible to its creator
and editable by nobody but a System Admin**, since no membership can name it.
`canManageAgent` therefore mirrors `visibleAgent`: boundary present → the
team-admin rule, boundary absent → the owner. The boundary is checked **first**,
so owning an agent that *does* belong to a team never bypasses the role rule.

### A2.4 — AC4's "existing drift guard" did not exist

Issue #2078 AC4 asks that the two copies "stay byte-identical … (existing drift
guard passes)". §1.3 already corrected this: the copies were neither
byte-identical (quote style, `DEFAULT_TEAM_ID` vs the literal) nor guarded. P2
delivers the guard for the module it introduces — `agent-team.js` is a whole
shared file with a **two-sided** byte-identity guard on both sides, the
`toolchain-registry.js` / `plugin-manifest.js` arrangement. `resolveAgentTenant`
is left as it is rather than being reformatted for a mirror guard it loses in P5
anyway.

### A2.5 — What P2 did NOT re-point, and why

- **Environment / credential / MCP-server / skill-pool stamps.** Still
  access-scope ids (P5, §5.2 — an environment shared by two Agent Teams in one
  scope cannot be re-pointed to one of them without a shared tier).
- **The scope memberships.** Still present and still honoured, because the
  stamps above are what they gate. `team-membership-enforcement.test.js` asserts
  that dropping them changes **no** agent's visibility or manageability, which
  is what makes P5's clean-up safe.
- **Agent *creation* gates** (`api.js`, the standalone-import branch). Who may
  create is P3's contract; re-keying it here would either widen it to every
  authenticated user or narrow it to System Admins.
- **`POST /api/agents/:id/convert-to-team`'s second gate.** It asks "may you
  mint a team here", and team creation stays System-Admin-only until P3 — so it
  deliberately keeps reading the legacy scope. Under D8 a standalone agent's
  owner now passes the *first* gate, and without this the owner could convert
  their way into owning a team.
- **§11's leaks** (process drafts/flows, the work plane, MCP writes) and the D9
  Team-Member mutation boundary. Cut out as separate P2 tickets by #2078's own
  Scope-out.

---

## Amendment 3 — what P5 (#2083) found, and what it changed here

Appended for the same reason as Amendments 1 and 2: the design above stays
readable as the design that was agreed, and this records where implementation
contradicted it.

### A3.1 — The shared tier had to diverge from the credential one on the MANAGE axis

**§5.2 says "the tier model to copy is the credential one" and that a
`system`-tier record is "gated like `canReassignCredential` (System-Admin-only)".
Copied literally, that makes the re-point a lockout.**

`canManageCredential` refuses the system tier outright. A2.5 already records
that an environment shared by two Agent Teams in one access scope "cannot be
re-pointed to one of them without a shared tier" — so the migration's only
lossless move for such a record is to **promote** it. Under the credential rule
the Team Admin who can edit that environment today could not edit it afterwards,
and `canManage_after ⊇ canManage_before` (§8.3) is exactly the half of the
no-lockout property that forbids it.

So `canManageEnvironment` grants **every assigned team's admin**, and §5.2's
sentence is honoured on the half that carries the risk:

| Question | Who |
|---|---|
| May I edit this shared record's content (repositories, token, MCP refs)? | any **Team Admin** of an assigned team — self-service, which is what D12 asks of configuration |
| May I decide **which teams** reach it, or move it between tiers? | **System Admin** only (`canRetierEnvironment`, the `canReassignCredential` mirror) |

`isRetier` (`resource-tier.js`) is what tells the two apart, so a client
restating the record's own unchanged ownership — which the console's form does on
every save — is not treated as an operator act. The counterfactual is measured
rather than argued in `ownership-no-lockout.test.js`: the same promoted record
under the credential rule *does* lose the admin her reach.

A second, smaller divergence: **environment visibility stays membership-based**
(`visibleTeam`), not `canManageTeam` as `visibleCredential` uses. That gate is
#798's deferral of Team-Member credential access; D9 says a Team Member may
read, and importing the credential rule would have smuggled an unrelated
regression in under a tiering ticket.

### A3.2 — AC1's `personal` tier for environments is refused, and §5.1 is why

Issue #2083's Scope-in and AC1 ask for "shared/system + team + personal". §5.1's
tier table asks only for the shared tier, and §5.2's before/after example shows
only `team` and `system`. The table is right, and the reason is the tier's
defining property: the personal tier has **no `scope.all` bypass** (§2.2),
because a personal *secret* must be private even from the operator. An
environment is not a secret — it is infrastructure agents run on. A personal one
would be an environment a System Admin can neither read, repair nor delete, and
it would make the `Used by <env>` refusal on a credential delete unresolvable by
anybody.

`resolveTieredOwnership` therefore refuses a `personal` request with a 400. The
predicates still handle the tier, so the shape stays uniform and a hand-edited
record fails closed to its owner rather than defaulting open — a later ticket
that wants personal environments only has to open the route.

### A3.3 — AC3 is blocked on an edit no phase owns

**Re-pointing the credential / model-provider / skill team tiers at Agent Team
ids was not deliverable, and the blocker is not in this phase's code.**

Two independent reasons, both found against the tree rather than the ticket:

1. **The referent itself has not moved.** `resolveOwnerTeamId` (`api.js`)
   validates every resource's owning team against `teams/index.json` at **six**
   call sites, and that file is still the live source for `GET
   /api/admin/teams` — the Access page and five team dropdowns. Making a
   resource stamp an Agent Team id means re-pointing that validation and every
   one of those surfaces, which is the **retirement of `teams/index.json`**.
   A1.2 found that not deliverable alongside another change and assigned it to
   "the P2 enforcement re-point"; P2 (#2078) did not take it, and A2.5 does not
   mention it. **It is currently unowned.** Until it lands, a re-pointed stamp
   would name a team the create/update routes reject as non-existent.
2. **There is no lossless promotion for a credential.** A3.1's escape hatch is
   available only because the environment/MCP shared tier is being *defined*
   here. The credential shared tier is already shipped and already means
   System-Admin-managed (#798 AC5, pinned in `scope.test.js`), so promoting a
   team credential in a multi-team scope is the manage-axis lockout A3.1
   avoids — with no room to redefine it.

   And the read path cannot collapse either: "reference the new Agent Team ids"
   requires `usableEndpointsForTeam` to be fed `resolveAgentTeam`, which answers
   **`null`** for a standalone `role: 'agent'` (A2.2, by design). Every
   standalone agent would be left with no usable model provider at all, and D8
   does not say which providers an owner-scoped agent may bill against. That is
   a new decision, not an implementation detail.

`credentialVisibleToTeam`, `resolveAgentTenant` and its `|| 'default'` fallback,
and the access-scope memberships therefore all survive P5 together, exactly as
they survived P2. **What the successor phase needs, in order:** retire
`teams/index.json` (re-point `resolveOwnerTeamId` and the five dropdowns) →
decide the provider rule for an owner-scoped agent → then re-point the
credential/provider stamps and drop the scope memberships. The skills pool is
the one part of AC3 with no blocker (§5.3 — it is a directory name, so §8.3's
copy-to-each move is available), and it is left with the rest so the re-point
lands as one coherent change rather than one third of one.

### A3.4 — What P5 DID deliver

- The shared tier for **working environments** and **MCP servers**, end to end:
  the shape (`resource-tier.js`, byte-mirrored into the orchestrator and
  two-sided-guarded), the four predicates, all eleven routes, and the first
  ownership control either page has ever had.
- **§11.3 closed** and **§11.4 half closed** (above) — both needed by the tier
  rather than done alongside it.
- The last literal `|| 'default'` on the environment path (§8.4).
- AC4/#2041 AC11 proven: `admin-console/api/team-needs-no-infrastructure.test.js`
  measures that a team with no credential, environment or provider of its own can
  see and reuse a shared environment, and that it could not before.

### A3.5 — Unchanged, deliberately

- **`scope.all`** and all twelve bypasses (D5); the census guard now also pins
  that every tiered predicate checks the personal tier **before** its bypass,
  which is the silent way #1567 D2 could have been lost.
- **The personal-credential privacy guarantee**, now shared code
  (`ownsPersonalTier`) rather than a credential-only rule.
- **Plugin install** stays System-Admin (D12 — a broker sidecar holds the team's
  credentials), and per-team plugin assignment is unchanged (AC5 of #2083).
- **Toolchains** stay System-Admin-only (§5.1).
- **`normalizeMcpServersInput`** still resolves an environment's MCP references
  **unscoped**, so an environment can reference a server its team cannot see.
  That predates this ticket and tightening it would change what existing
  environments can save; recorded here as the remaining tier hole rather than
  fixed under a different heading.
