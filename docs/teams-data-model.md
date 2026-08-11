# Teams data model (#299)

The **Team** is the *human* collaboration & visibility boundary — the tenant /
scope that resources and human users are assigned to. It is the foundation of
the multi-user concept (#178): everything else (auth, list-filtering, audit,
SSO) hangs off this entity.

> **Terminology — resolve the collision.** "Team" here always means the *human*
> grouping described on this page. The pre-existing `role: "team"` agent
> construct (an agent squad working a repo) is the **Agent Team** — always
> qualify it as such. The two only share a word. The agent role id stays `team`
> short-term; renaming it (e.g. `agent-team` / `squad`) is a follow-up.

## Scope of this issue

In scope:
- A persistent store for **Teams**, **human users**, and **memberships**
  (user ↔ team ↔ role).
- A `teamId` ownership field on every agent construct, Working Environment, and
  credential — each is owned by exactly one Team. *(The `personal` credential tier, epic #1558, is the exception: it carries `userId` and `teamId: null`, owned by one human rather than a team.)*
- Startup bootstrap of a default team + optional System Admin, and a one-time
  backfill that stamps pre-existing resources with the default team.

Explicitly **out of scope** (separate issues): auth middleware, list-endpoint
filtering, and UI.

## Roles

| Role | Scope | Where it lives |
|---|---|---|
| **System Admin** | Global | `user.systemAdmin === true` (a flag, not a membership) |
| **Team Admin** | Per team | membership with `role: "team-admin"` |
| **Team Member** | Per team | membership with `role: "team-member"` |

A human may hold different per-team roles in different teams; System Admin is
global. Membership is at most one record per `(userId, teamId)` — re-asserting
it updates the role in place.

## Storage layout

Three JSON collections under the shared `/workspace` volume, each an array of
records written atomically (write-temp + rename):

| Path | Record shape |
|---|---|
| `/workspace/teams/index.json` | `{ id, name, description, createdAt, updatedAt }` |
| `/workspace/users/index.json` | `{ id, subject, email, displayName, systemAdmin, githubHandle, chatFontSize?, createdAt, updatedAt }` |
| `/workspace/memberships/index.json` | `{ id, userId, teamId, role, createdAt }` |

- **Team `id`** is an operator-facing slug (`^[a-z0-9][a-z0-9-]{0,63}$`), like a
  Working Environment id. The default team's id is `default`.
- **User `subject`** is the stable identifier from the (future) IdP — e.g. the
  OIDC subject claim or corporate email. It is unique (case-insensitive) so SSO
  login can map a corporate identity onto exactly one account. `id` is a
  generated UUID.

The single source of truth for this model is
[`orchestrator/teams-store.js`](../orchestrator/teams-store.js) — a pure factory
(`createTeamsStore({ root })`) with no global state, unit-tested in
`orchestrator/teams-store.test.js`. The orchestrator is the only writer.

## Ownership

Every agent construct, Working Environment, and credential carries a `teamId` *(personal-tier credentials are the exception — they carry `userId` and `teamId: null`; see epic #1558)*:

| Resource | Stamped at | Default |
|---|---|---|
| Agent / Agent Team / team-member / orchestrator / bp-instance | orchestrator `createAgent` / `addTeamMember` | `default` (team-members inherit their parent Agent Team's `teamId`) |
| Working Environment (`environment.json`) | admin-console `POST/PUT /api/environments` | `default` |
| SSH key, GitHub token, MCP credential, LLM endpoint — `team`/`system` scope | admin-console credential `POST` handlers | `default` |
| SSH key, GitHub token — `personal` scope (#1567) | same handlers, but forced `scope: 'personal'` | `userId` = the authenticated caller; `teamId: null` |

Creation paths for `team`/`system` scopes accept an optional `teamId`; when supplied it must reference an existing team, otherwise the request is rejected (400). Absent = default team. Personal credentials always carry the caller's `userId` as owner; a body naming a different owner is rejected 403.

### Resolving an agent's tenant

**`parentTeamId` is never a tenant.** It names the **Agent Team** construct — a
different namespace from the human Team ids in `teams/index.json`. Using it as a
tenant only appears to work while an Agent Team happens to share its id with a
human Team; otherwise it names a team that does not exist and every team-scoped
lookup (credential entitlement, agent visibility, management gates) fails closed
on an empty result — e.g. an empty Model Provider list in the chat's provider
switcher.

A team-member's tenant is therefore resolved by dereferencing its parent Agent
Team and reading *that* agent's `teamId`, falling back to the member's own stamp
when the parent is missing or unstamped. The rule lives in two pure, mirrored
modules (the containers do not share code): `resolveAgentTenant` in
`admin-console/api/scope.js` (used by `agentTeamId` → `agentMetaForScope`,
`usableEndpointsForTeam`) and `orchestrator/agent-tenant.js` (used by
`resolveAssistBindingForTeam`). `backfillResourceOwnership()` additionally
realigns any member whose stored `teamId` disagrees with its parent, so the
on-disk value matches what the resolver reports.

Deliberately *not* covered: the usage records and PR-event log, which group by
Agent Team on purpose — those metrics are per squad, not per tenant.

## Bootstrap & migration

On orchestrator startup (`main()`), after the legacy role migration:

1. `bootstrapTeams()` — `ensureDefaultTeam()` (idempotent), then optionally
   `ensureSystemAdmin()` from environment config (below).
2. `backfillResourceOwnership()` — stamps `teamId: "default"` onto any agent,
   environment, or credential index entry that lacks one. Idempotent: a stamped
   resource is skipped on subsequent boots, and the JSON is only rewritten when
   it actually changes.

This means an operator already running a single-user stack keeps every existing
agent, environment, and credential — they're simply adopted into the default
team on the next restart.

### Seeding an initial System Admin

A fresh stack has no users. To seed one global System Admin from config, set in
`.env`:

| Variable | Purpose |
|---|---|
| `BOOTSTRAP_SYSTEM_ADMIN_SUBJECT` | IdP subject / email of the admin (required to seed) |
| `BOOTSTRAP_SYSTEM_ADMIN_EMAIL` | Optional email |
| `BOOTSTRAP_SYSTEM_ADMIN_NAME` | Optional display name |

If a user with that subject already exists it is promoted to System Admin; the
operation is idempotent and a no-op when the variable is unset.

## HTTP API

Auth is a later issue — these endpoints are currently open, like the rest of the
admin API.

**Orchestrator internal API (`:4002`)** — the data-model surface:

```
GET    /internal/admin/teams
POST   /internal/admin/teams                       { id, name, description }
GET    /internal/admin/teams/:id
PUT    /internal/admin/teams/:id                    { name?, description? }
DELETE /internal/admin/teams/:id                    (409 if it still owns resources; default team protected)

GET    /internal/admin/users        [?subject=]
POST   /internal/admin/users                        { subject, email?, displayName?, systemAdmin?, githubHandle?, chatFontSize? }
GET    /internal/admin/users/:id
PUT    /internal/admin/users/:id                    { email?, displayName?, systemAdmin?, githubHandle?, chatFontSize? }
DELETE /internal/admin/users/:id                    (offboards owner first — pause agents + delete personal credentials — then cascades memberships; partial failure leaves user recoverable, #1571)

GET    /internal/admin/memberships  [?userId=&teamId=]
POST   /internal/admin/memberships                  { userId, teamId, role }   (upsert)
DELETE /internal/admin/memberships  ?userId=&teamId=
```

These are mounted separately from `/internal/teams/*`, which operate on the
**Agent Team** construct.

**Admin console (`:4000`)** proxies them verbatim under `/api/admin/teams`,
`/api/admin/users`, `/api/admin/memberships` — deliberately distinct from
`POST /api/teams`, the Agent-Team setup wizard.

## Referential integrity

- A membership requires both its user and team to exist; `role` must be
  `team-admin` or `team-member`.
- Deleting a **user** runs offboarding first (#1571, Phase 5): pauses the person's agents (drain — not wiped) and auto-deletes their **personal** SSH keys + GitHub tokens (index entries + 0600 files; team/system credentials are never touched); then cascades memberships. Offboarding runs before the user record is removed so a partial failure leaves the user recoverable.
- Deleting a **team** cascades its memberships, refuses the default team, and is
  refused (409) while any agent, environment, or credential still names it as
  owner — reassign those first so nothing is orphaned.
