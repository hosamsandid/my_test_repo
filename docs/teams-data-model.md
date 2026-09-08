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

> **Successor design — [`decentralised-access-concept.md`](decentralised-access-concept.md) (#2041 / #2046).**
> The separate human-Team layer described on this page is **retired** by decision D1:
> the **Agent Team** becomes the access boundary, `teams/index.json` disappears, and
> `users` + `memberships` survive with `memberships.teamId` re-pointed at Agent Team ids.
> The terminology note above therefore goes with it — after the change there is one
> concept and one word. This page still describes what is live on `main`; the successor
> doc is the design of record for what replaces it (rewritten here in phase P6).

> **P1 (#2077) and P2 (#2078) have landed — what this page no longer tells you in full.**
> Ownership now lives on the Agent Team: every `role: "team"` and standalone
> `role: "agent"` config carries an `ownerId` (+ an `ownerSource` recording
> whether that owner is a real creator or a migration placeholder), and
> `memberships/index.json` now *also* holds one `(user → Agent Team)` record per
> Agent Team of each access scope — added **alongside** the access-scope records
> below, not in place of them. As of **P2 (#2078)** the **agent** visibility and
> management gates key on that Agent Team membership (see *Resolving an agent's
> access boundary* below); every **other** resource on this page — environments,
> credentials, MCP servers — still keys on its access-scope `teamId` stamp, until
> epic #2076's P5 re-points them. So the
> `memberships` table below is accurate but no longer complete: a `teamId` there
> may be an access-scope id (the records this page describes) **or** an Agent
> Team id (the ones the D6 migration added). `teams/index.json` is still written
> and read exactly as documented here — P2 re-pointed the agent gates but left it
> in place; its retirement is deferred past the enforcement re-point, for the
> reason in the successor doc's Amendment 1. The migration itself is
> `orchestrator/ownership-migration.js` + `migrateOwnershipModel()`.

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
| `/workspace/users/index.json` | `{ id, subject, email, displayName, systemAdmin, githubHandle, matrixUserId?, chatFontSize?, createdAt, updatedAt }` |
| `/workspace/memberships/index.json` | `{ id, userId, teamId, role, createdAt, fromScopeId? }` |

- **Team `id`** is an operator-facing slug (`^[a-z0-9][a-z0-9-]{0,63}$`), like a
  Working Environment id. The default team's id is `default`.
- **User `subject`** is the stable identifier from the (future) IdP — e.g. the
  OIDC subject claim or corporate email. It is unique (case-insensitive) so SSO
  login can map a corporate identity onto exactly one account. `id` is a
  generated UUID.
- **User `matrixUserId`** *(optional, #1458)* is the human's own Matrix account
  — `@u-<16 hex of sha256(subject)>:local` — provisioned when the record is
  created (best-effort and backgrounded, so it may be absent briefly or on a
  single-operator stack that has no user records). It is a non-secret pointer
  only; the matching access token is stored server-side in a separate per-user
  file (`users/matrix/<userId>.json`), never on this record. See
  [`docs/multi-user-concept.md`](multi-user-concept.md) Amendment 1.
- **Membership `fromScopeId`** is present only on records the D6 migration
  (#2077) created when it fanned an access-scope membership out to the Agent
  Teams in that scope — it records which access scope the grant was derived
  from. Nothing reads it; it exists so a migrated membership is auditable and
  distinguishable from one a human made. A hand-made membership never has it.

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

### Resolving an agent's access boundary (#2078)

**Since #2078 an agent's access is decided by its Agent Team, not by its tenant
stamp.** Epic #2076's D1 collapses the two namespaces for the *authorization*
question: a `role: 'team'` agent **is** its own boundary, a `role: 'team-member'`
is bounded by its `parentTeamId`, and a standalone `role: 'agent'` has **no**
boundary and is decided by its `ownerId` alone (D8). The rule is the pure
`resolveAgentTeam` in `orchestrator/agent-team.js`, duplicated byte-identically
into `admin-console/api/agent-team.js` (the console image copies only
`api/*.js`) and two-sided-guarded by `agent-team.test.js`. The console feeds it
to `visibleAgent` / `canManageAgent` through `agentMetaForScope`; membership
records (`memberships/index.json`) now reference Agent Team ids, which is what
makes those predicates resolve.

Two consequences to know. **There is no `|| 'default'` fallback left** in
`visibleTeam`, `canManageTeam`, `canManageAgent`, `canManageEnvironment`,
`canCreateCredential` or `normalizeCredential`: a resource with no team id is
invisible and unmanageable to a non-admin rather than collapsing into the
default team. And **`scope.all` is untouched** — all twelve System-Admin
short-circuits survive (D5), pinned by a census guard in `scope.test.js`.

### Resolving an agent's credential tenant

This is the *other* axis, and it did **not** collapse. Credentials, model
providers, environments and MCP servers are still stamped with access-scope ids
until epic #2076's P5 re-points them, so resolving *which providers an agent may
use* still needs the parent hop below. `resolveAgentTenant` and
`orchestrator/agent-tenant.js` therefore survive #2078 unchanged, with exactly
two live callers — `usableEndpointsForTeam` (api.js) and
`resolveAssistBindingForTeam` (orchestrator.js), both provider lookups. **Do not
reach for it to answer an authorization question**; it retires with P5.

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
`admin-console/api/scope.js` (used by `agentTeamId` → `usableEndpointsForTeam`)
and `orchestrator/agent-tenant.js` (used by
`resolveAssistBindingForTeam`). `backfillResourceOwnership()` additionally
realigns any member whose stored `teamId` disagrees with its parent, so the
on-disk value matches what the resolver reports.

Deliberately *not* covered: the usage records and PR-event log, which group by
Agent Team on purpose — those metrics are per squad, not per tenant.

## Bootstrap & migration

On orchestrator startup (`main()`), after the legacy role migration:

1. `bootstrapTeams()` — `ensureDefaultTeam()` (idempotent), then optionally
   `ensureSystemAdmin()` from environment config (below), and finally the
   bootstrap admin's **`team-admin` membership of the Default Team** (#1457).
   System Admin is a global flag rather than a membership, so without this step
   the team that owns every adopted resource had no Team Admin at all. The
   membership is planned, not asserted: `setMembership` is an upsert, so it is
   created only when no membership for that (user, team) pair exists in *any*
   role — an admin a human deliberately demoted is not re-promoted on each boot.
2. `backfillResourceOwnership()` — stamps `teamId: "default"` onto any agent,
   environment, credential index entry or **MCP server** (#1457) that lacks one.
   Idempotent: a stamped resource is skipped on subsequent boots, and the JSON is
   only rewritten when it actually changes.

This means an operator already running a single-user stack keeps every existing
agent, environment, and credential — they're simply adopted into the default
team on the next restart.

Two properties of the adoption pass are load-bearing:

- **The predicate is `teamId === undefined`, not a falsy check.** A *personal*
  credential (#1567) carries an explicit `teamId: null` plus a `userId` and is
  deliberately not team-owned; adopting it would hand every System Admin a view
  of credentials the personal tier exists to keep private.
- **MCP servers were adopted but never stamped.** The scope filter has always
  read `server.teamId`, while nothing ever wrote it — so every registered server
  relied on the `|| "default"` collapse inside the predicate. They are now
  stamped explicitly. Writing a `teamId` at *create* time is the ownership
  phase's job (#2077/#2083); this pass only adopts what predates it, which is
  why the team-delete guard needs no new check — no non-default team can own an
  MCP server yet.

The decisions above live in the pure `orchestrator/default-team-adoption.js`
(`needsAdoption` / `planAdoption` / `planBootstrapMembership`), because
`bootstrapTeams` and `backfillResourceOwnership` are not exported from
`orchestrator.js` and cannot otherwise be reached by a test.

### Single-user compatibility mode (`AUTH_ENABLED`, #1457)

The model above ships live but *inert* on a single-operator stack: the only
principal is the env admin, who gets `all: true`, so no list is ever filtered.
`AUTH_ENABLED` makes that an explicit mode rather than an accident of there
being one login.

| Value | Mode | Behaviour |
|---|---|---|
| unset / `false` / `0` / `no` / `off` (**default**) | single-user compatibility | Whoever is signed in is the operator. `computeScope` short-circuits to the implicit System-Admin scope; every list filter and management gate is a no-op. An upgraded stack behaves exactly as before. |
| `true` / `1` / `yes` / `on` | multi-user | Scope is computed from the caller's user record and memberships, as `scope.js` already does. |

Four things worth knowing:

- **Off is the default because this is a migration flag.** An operator who pulls
  a new image must not find their console suddenly filtered; activation is a
  deliberate act. Adoption (above) runs unconditionally, so flipping the flag on
  later needs no migration step.
- **It relaxes authorization, not authentication.** An unauthenticated request
  still resolves to the empty scope, and the IAP auto-login gate (#1415) is
  untouched: `isKnownPrincipal` reads `envAdmin`/`userId`, never `scope.all`, so
  an unregistered IAP identity still falls through to the login form.
- **The personal credential tier is not breached.** `ownsPersonalCredential` has
  no `scope.all` bypass and keys on `userId`, which single-user mode still
  resolves from the matching user record — so one human never sees another's
  personal credential, in either mode.
- **The one footgun is reported, not hidden.** Turning the flag *off* on a stack
  that already has named users grants each of them full visibility. The console
  logs a warning at boot naming how many non-admin records are affected.

An unrecognised value is treated as off *and* logged as unrecognised — a typo
must not silently start filtering the console.

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
`POST /api/teams`, the Agent-Team setup wizard. **Exception (#2081):** the
`POST /api/admin/teams` create verb is retired and answers *410 Gone* — a new
access scope can no longer be minted, because creating a team is now self-service
and mints an Agent Team via `POST /api/teams`. The other scope verbs (`GET` /
`PUT` / `DELETE`) still proxy verbatim.

## Referential integrity

- A membership requires both its user and team to exist; `role` must be
  `team-admin` or `team-member`.
- **A team can never be left without an admin (#2081, D4).** Removing or demoting the *last* `team-admin` of a team is refused (409) unless a `successorUserId` — already a member of that team — is named, and the promotion and the removal/demotion land in a single write. Deleting a **user** is likewise refused while they are the last `team-admin` of any team, naming every one that blocks it. The rule is enforced in the store, so the orchestrator's own `/internal/admin/*` writers are covered too — not only the console routes.
- Deleting a **user** runs offboarding first (#1571, Phase 5): pauses the person's agents (drain — not wiped) and auto-deletes their **personal** SSH keys + GitHub tokens (index entries + 0600 files; team/system credentials are never touched); then cascades memberships. Offboarding runs before the user record is removed so a partial failure leaves the user recoverable — and the last-admin refusal above is checked *ahead* of offboarding, so a refused delete pauses no agents and revokes no credentials.
- Deleting a **team** cascades its memberships, refuses the default team, and is
  refused (409) while any agent, environment, or credential still names it as
  owner — reassign those first so nothing is orphaned.
