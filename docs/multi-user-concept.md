# Multi-User Architecture with Enterprise SSO — Concept

Status: **concept / decision document**. No implementation code is delivered here. This document answers the multi-user question completely enough that implementation issues can be derived from it (see §8).

Tracking issue: [#178](https://github.com/AccentureCodeFoundry/314092_agent-execution-environment/issues/178).

---

## Table of Contents

1. [Starting Point and Goal](#1--starting-point-and-goal)
2. [Identity and SSO](#2--identity-and-sso)
3. [Authorization Model](#3--authorization-model)
4. [Matrix Identity per Human User](#4--matrix-identity-per-human-user)
5. [API Authentication](#5--api-authentication)
6. [Data Isolation](#6--data-isolation)
7. [Audit Trail](#7--audit-trail)
8. [Migration Path](#8--migration-path)
9. [Decisions with Significant Cost Implications](#9--decisions-with-significant-cost-implications)
10. [Follow-up Implementation Issues](#10--follow-up-implementation-issues)

---

## 1 — Starting Point and Goal

### Where we are today

The stack is a single-operator, local-stack design. Concretely:

- `admin-console/api/api.js` has **no authentication middleware**. Every route on port 4000 is open to anyone who can reach it.
- There is exactly **one Matrix human identity**: the admin user whose token lives in `MATRIX_ACCESS_TOKEN`. Every message sent "as the human" — DM creation, chat sends, handover nudges — uses `matrix.ADMIN_TOKEN` (see `api.js` lines 1057, 5073, 5086, 5205). Agent DM rooms are 1:1 between an agent and *this one* admin user.
- The orchestrator's internal API on port **4002** is service-to-service, no auth, and reachable only on the internal Podman network.
- Credentials (SSH keys at `/workspace/environments/_keys/`, GitHub PATs, MCP credentials at `/workspace/mcp-credentials/_keys/`) are global. Any console user can attach any credential to any environment.
- The Workspace Browser (`/api/agents/:id/workspace/*`) exposes every agent's `/workspace/agents/<id>/` tree, including session logs, to anyone with console access.
- There is no audit trail beyond Matrix chat history and orchestrator logs. Mutations are not attributable to a named human.

This is correct for one operator on a laptop. It is a hard blocker the moment a second person needs access, or the stack is hosted on a shared server.

### Goal of multi-user mode

1. Humans authenticate with their **corporate identity** (Entra ID is the dominant Accenture case).
2. **Role-based access**: managing teams/credentials vs. only chatting with agents.
3. **Scoped visibility**: a member of team A cannot read team B's credentials or chat history.
4. **Attributable audit trail**: every mutating action names the human who performed it.

### Design principle: keep the single-operator stack working

The current behaviour is the *default*, not a legacy mode to be removed. Multi-user is an **additive layer** that an operator opts into. Everything below is designed so that an operator who never enables SSO sees no behavioural change (see §8).

---

## 2 — Identity and SSO

### Recommendation

**Primary target: Entra ID (Azure AD) via OIDC (OpenID Connect / OAuth2 Authorization Code flow with PKCE).** Support SAML 2.0 only as a secondary adapter if a specific deployment's IdP cannot speak OIDC.

### Why OIDC and why Entra ID

- **Entra ID is the authoritative IdP in an Accenture enterprise context.** It is the realistic deployment target, so it sets the primary requirement.
- **OIDC over SAML** because:
  - The token format is a JWT, which the Admin Console API can validate locally with the IdP's published JWKS (no per-request round-trip to the IdP). This fits the stateless API-auth model in §5.
  - The Authorization Code + PKCE flow is the modern browser-app standard and is first-class in Entra ID's app-registration model.
  - SAML's XML/assertion handling is heavier and more error-prone to implement correctly, and brings no advantage here.
- We **abstract the IdP behind a thin adapter** (an OIDC discovery URL + client id + client secret in `.env`). This keeps Okta, Auth0, Keycloak, or a generic OIDC provider as drop-in alternatives, and isolates a future SAML adapter to one module.

### Corporate identity → system account mapping

- The **stable subject** is the OIDC `oid` claim (Entra ID's immutable per-tenant object id), **not** `email` or `preferred_username` (those can change). The system keeps a `users` record keyed by `(issuer, oid)`.
- On **first successful login**, the system **provisions a local user record** automatically (just-in-time provisioning): `{ id, issuer, oid, email, displayName, roles, createdAt, lastLoginAt }`. No pre-registration step.
- Default role on JIT provisioning is the **lowest privilege** (Team Member with no team assignments → effectively can log in but see nothing until granted access). A System Admin then assigns teams/roles. This is fail-closed by design.
- **Group/role claims from the IdP** (Entra ID app-roles or group ids) *may* be mapped to system roles via a configurable claim-mapping table, so an enterprise can drive role assignment from Entra ID groups instead of in-app. This is recommended but optional; the in-app assignment is the fallback and the source of truth when no mapping is configured.

### Corporate identity → Matrix user mapping

See §4 for the full discussion. Summary: **each human gets their own Matrix account, provisioned on first SSO login** via the Conduwuit admin API (the same mechanism that provisions agent users today). The Matrix localpart is derived deterministically from the stable subject (e.g. `@u-<short-hash-of-oid>:local`), with the display name set to the corporate display name.

### Distinguishing service accounts from human identities

- **Service accounts** (the orchestrator's admin Matrix bot, the per-agent Matrix users) are **never** issued via the SSO path. They are provisioned by the orchestrator/setup flow and carry a `kind: "service"` marker in the `users` record (or simply are absent from the `users` table and recognised by a reserved localpart prefix such as `@svc-` / the existing agent ids).
- The Admin Console API's auth middleware (see §5) only ever accepts **human session tokens** issued by the SSO callback. Service-to-service calls (orchestrator ↔ admin API) use a **separate shared service secret**, not a human token, and travel only on the internal network.
- This separation is what lets the audit trail (§7) cleanly answer "human or machine?" for every action.

---

## 3 — Authorization Model

> **Successor design — [`decentralised-access-concept.md`](decentralised-access-concept.md) (#2041 / #2046).**
> The two-level model below stays, but its per-team tier is **re-pointed**: after decision D1
> the **Agent Team** is the access boundary, so a membership names an Agent Team rather than a
> separate access scope. Rights administration also moves from central to decentralised — the
> person who creates a team owns it and shares it themselves (D1–D3), while the System Admin
> keeps full visibility (D5). The role names and semantics (**System Admin** / **Team Admin** /
> **Team Member**) are unchanged. This section still describes what is live on `main`; the
> successor doc is the design of record (this section is rewritten in phase P6).

### Recommendation

A **two-level model**: a small set of **system-wide roles** plus **per-team membership with a per-team role**. This is neither fully flat nor a deep hierarchy — it is the minimum that expresses "system operator" vs. "scoped team work".

### Roles

| Role | Scope | Can do |
|---|---|---|
| **System Admin** | System-wide | Everything: manage users and role assignments, create/manage all environments and credentials, see and manage all teams, manage the skill pool, see all audit events. |
| **Team Admin** | Per team | Create and manage their own team(s) and members; attach credentials *that they own or that are shared to their team* to their team's environments; promote skills (#173) for their team; cannot see other teams' credentials or chat histories. |
| **Team Member** | Per team | Chat with agents in their assigned team(s); read-only view of that team's config; cannot manage credentials; cannot manage members. |

A single human may be Team Admin of team A and Team Member of team B simultaneously. System Admin is a global flag that supersedes per-team roles.

### Answers to the specific questions

**Flat or hierarchical?** Hierarchical, but shallow: one global tier (System Admin) over a per-team tier (Team Admin / Team Member). A flat system-wide-only model cannot express "team A's credentials are invisible to team B", which is a hard requirement. A deeper hierarchy (sub-teams, org units) is **out of scope** for v1 — flag if a deployment needs it.

**Who can see credentials?** Credentials get a **`credential owner` concept** and a **visibility scope**:
- Every credential (SSH key, GitHub PAT, MCP credential) records `ownerUserId` and a `scope`: `private` (owner only), `team:<teamId>` (visible to that team's admins), or `system` (visible to System Admins; usable by any environment a System Admin configures).
- A Team Admin sees only credentials scoped to their team or owned by them. The raw secret is **never** returned by the API after creation regardless of role — only fingerprint/masked prefix (this is already true today and must be preserved).
- This mirrors the existing SSH-key vs. PAT *defense-in-depth* split: scoping is the access-control analogue of blast-radius separation.

**Can a Team Member see other members' chat histories?** **No — chat histories are private to the chatting human by default.** Each human has their own DM room per agent (§4), and session logs live per-room. A Team Member sees only their own rooms. **Team Admins and System Admins may be granted read access to their team's session logs** for support/debugging, but this is an explicit, audited capability — not the default — because chat content can contain sensitive prompts.

**Who can trigger skill propagation (#173)?** **Team Admins and System Admins**, not arbitrary Team Members. Promotion to the pool changes what every team member's future agents inherit, so it is a management action. (For the *system* skill pool, only System Admins; for a future team-scoped skill set, the owning Team Admin.)

---

## 4 — Matrix Identity per Human User

### Recommendation

**Each human gets their own Matrix account, provisioned automatically on first SSO login.** Do **not** keep one shared admin account that tags messages with human identity.

### Why a real per-human Matrix account

- The whole model rests on **DM rooms being 1:1 between one agent and one identified human**. The agent-runner's DM heuristic (`getJoinedRoomMembers(roomId) == 2 && sender != self`) and the session-log model assume a single human counterpart per room. If all humans shared one Matrix account, every human would see every other human's DM with an agent — directly violating the "chat histories are private" requirement (§3).
- Tagging messages with human identity inside a shared account would require re-implementing access control *inside* room membership, fighting Matrix's own model. Per-human accounts get isolation for free: a human is simply not a member of another human's DM rooms.
- Conduwuit already provisions Matrix users via the admin API (this is exactly how agent users are created today). Provisioning a human user on first login is the same operation — low marginal cost.

### Provisioning flow

On first successful SSO login:
1. Derive a deterministic Matrix localpart from the stable subject (e.g. `@u-<hash(oid)>:local`).
2. Provision the Matrix user via the Conduwuit admin API; set display name = corporate display name.
3. Store the Matrix `access_token` for that user **server-side only** (in the user record / a server-side session store) — the browser never sees a Matrix token. The Admin Console API continues to be the only thing that talks to Matrix on the human's behalf, but now it uses *that human's* token instead of the shared `MATRIX_ACCESS_TOKEN`. The browser-never-sees-Matrix-tokens property (api.js line 5019) is preserved.

### How the DM-room model changes

- Today: **one room per agent** (per stack), `dm-room.json` holds a single `{ roomId }`.
- Multi-user: **one room per agent per human**. The persistence shape changes from `/workspace/agents/<id>/dm-room.json` (single room) to a map keyed by human user id, e.g. `/workspace/agents/<id>/dm-rooms/<userId>.json` (or a single `dm-rooms.json` map). The agent invites *that human* (not the shared admin) into the room.
- The agent-runner's DM heuristic still works unchanged: each room still has exactly two members (the agent + one specific human). The agent simply now has N rooms (one per human who has chatted with it) instead of one.
- **Trigger output routing** (`trigger.roomId` / DM-room fallback) needs to choose a *target human* per agent. Recommendation: triggers post to the room of the agent's **owning/assigned human** (Team Admin or the configured owner), recorded on the agent config; if none, the run is skipped exactly as today when no DM room exists.

### What happens to existing rooms and session logs on activation

This is a migration concern (see §8). Summary: the existing single shared admin DM room and its `sessions/<roomId>.jsonl` are **adopted by the migrated admin's per-human identity** — the migrating operator's SSO account is mapped to the existing admin Matrix user (or the existing room is re-keyed under that user's id) so no history is lost. New humans start with fresh rooms.

---

## 5 — API Authentication

### Recommendation

**Stateless JWT session tokens in an HttpOnly, Secure, SameSite cookie**, issued by the console's own backend after the OIDC callback. Validate locally on every request via the console's signing key. Use a short-lived access token (e.g. 1h) with a refresh mechanism, or a sliding-session cookie.

### Token type: cookie vs. JWT — use both, in one design

- The **transport** is an **HttpOnly + Secure + SameSite=Lax cookie** (not `localStorage`), so the SPA's JavaScript cannot read the token — this defends against XSS token theft.
- The **content** is a **JWT signed by the console backend** (not the IdP's own token — see below), carrying `{ sub (system user id), roles, teamRoles, exp, iat, jti }`.
- This gives the simplicity of stateless validation (no session-store round-trip on the hot path) with the safety of an HttpOnly cookie.

### Token issuance (the SSO callback)

1. Browser hits a protected route → API returns 401 → SPA redirects to `/auth/login` → backend redirects to Entra ID (Authorization Code + PKCE).
2. Entra ID authenticates the user, redirects back to `/auth/callback?code=...`.
3. Backend exchanges the code for the IdP's id_token/access_token, **validates the id_token** against Entra ID's JWKS (signature, `iss`, `aud`, `exp`, nonce).
4. Backend resolves/JIT-provisions the system user (§2) and the Matrix user (§4).
5. Backend **mints its own session JWT** (signed with a console-local key) and sets it as the HttpOnly cookie. The IdP's tokens are stored server-side if needed for refresh, never handed to the browser.

> **Why mint a console-local JWT instead of forwarding the IdP token?** The IdP token's claims/lifetime/audience are the IdP's concern; the console needs *its own* roles and team-role claims and its own lifetime control. Decoupling also means token validation never depends on the IdP being reachable on the request hot path.

### Token validation

- **Local signature check** of the console-minted JWT on every API request (middleware in front of all `/api/*` routes). No introspection round-trip.
- A **`jti` deny-list** (small server-side set, TTL = token lifetime) supports immediate logout/revocation without giving up stateless validation in the common case.
- Middleware attaches `req.user = { id, roles, teamRoles }` for downstream authorization (§3) and audit (§7).

### Protecting the internal orchestrator API (port 4002)

This boundary is **critical** and must be enforced at multiple layers:
1. **Network**: port 4002 stays bound to the internal Podman network only — never published to the host in a multi-user deployment. (Today it is already internal-only; the requirement is to *keep it that way* and document it as a hard rule.)
2. **Shared service secret**: orchestrator ↔ admin-console calls carry a `X-Internal-Secret` header validated against a value in `.env`. Human session JWTs are **not** accepted on 4002, and the service secret is **not** accepted on the public 4000 API.
3. **No proxying of raw 4002 routes to authenticated-but-unauthorized users**: the admin console's public API is the only gateway, and it applies §3 authorization before proxying to 4002.

The `POST /internal/bp-events` endpoint (no auth, internal-only) stays exactly as designed — internal network + best-effort posture — and must remain unpublished.

---

## 6 — Data Isolation

The unifying rule: **every resource carries an owning scope (`system` / `team:<id>` / `private:<userId>`), and the API authorization layer (§3) filters by the caller's roles and team memberships.**

### Environments and their credentials

**Scoped to a team**, with a `system` option for shared infrastructure.
- A Working Environment gains an `ownerTeamId` (or `scope: system`). Team Admins see and edit only their team's environments; System Admins see all.
- Credentials gain `ownerUserId` + `scope` as in §3. An environment may reference only credentials visible to the team that owns it. The raw-secret-never-returned guarantee is unchanged.

### Agent workspaces (`/workspace/agents/<id>/`)

**Readable only by the owning team's admins/members, per the agent's team binding.**
- The Workspace Browser endpoints (`/api/agents/:id/workspace/tree|file|download`) must gain an authorization check: caller must be System Admin, or a member/admin of the agent's team. Today these are unrestricted — this is the single largest data-exposure gap to close.
- The existing path-traversal protection (reject paths resolving outside the agent root) stays; team-scoping is layered on top.

### Session logs (`sessions/<roomId>.jsonl`)

**Private to the chatting human by default** (consistent with §3/§4):
- A session log belongs to the human whose DM room it records. Only that human reads it through the chat UI.
- **Team Admins / System Admins may be granted an explicit, audited "view team session logs" capability** for support — off by default. When used, the access itself is an audit event (§7).

### Skill pool (`/template-workspace/skills/`)

**Global read, Team-Admin-or-System-Admin write, System-Admin manage.**
- All authenticated users may *read* the pool (skills are not secrets).
- **Write/promote** (#173) is restricted to Team Admins (for team-scoped skills, when introduced) and System Admins (for the shared system pool).
- Deleting/renaming pool skills is System-Admin only.

---

## 7 — Audit Trail

### Recommendation

**A dedicated, append-only audit log is required** — the Matrix chat history is *not* sufficient as the system audit trail. Store audit events as **append-only JSONL** at a stack-level path (e.g. `/workspace/audit/audit-YYYY-MM-DD.jsonl`), with an **optional forwarder to an external SIEM** (syslog/HTTP) for enterprise deployments.

### Why a separate audit log (Matrix history is not enough)

- Matrix chat history captures *conversations*, not *mutations*. "User X deleted credential Y", "User X promoted skill Z to the pool", "User X performed a handover" leave little or no Matrix trace — they are API actions.
- Matrix rooms are per-human and per-agent; there is no single queryable place that records *who changed system state*.
- An audit trail must be **append-only and tamper-evident**, which arbitrary chat rooms are not.
- Therefore: keep Matrix history as the record of *agent interactions* (it is a good, rich record of that), and add a **separate audit log for mutating API actions**.

### What is audited

Every **mutating** action through the public API: create/update/delete agent, create/delete environment, create/delete credential, attach credential to environment, promote skill to pool, run handover, assign roles/teams, grant "view team session logs", login/logout, and any access to another human's session logs.

### Minimum fields per event

```json
{
  "ts": "2026-06-30T12:34:56.789Z",
  "actor": { "userId": "...", "matrixId": "@u-...:local", "displayName": "...", "kind": "human|service" },
  "action": "credential.delete",
  "resource": { "type": "credential", "id": "gh-as-agent", "scope": "team:cobol" },
  "outcome": "success|denied|error",
  "context": { "ip": "...", "requestId": "...", "reason": "optional free text (e.g. override reason)" }
}
```

`outcome: denied` events (authorization failures) are recorded too — attempted access is itself audit-relevant.

### Implementation note

Audit logging is a single middleware/helper invoked after the authorization check and around the mutation, reading `req.user` (§5). This keeps it one cross-cutting concern rather than scattered call sites.

---

## 8 — Migration Path

### Recommendation: single-user compatibility mode, opt-in multi-user

Introduce an `AUTH_MODE` switch in `.env`:

- **`AUTH_MODE=single` (default, current behaviour):** No SSO, no auth middleware enforcement. The existing single admin Matrix identity and `MATRIX_ACCESS_TOKEN` continue to work exactly as today. **An operator who never touches this setting sees zero behavioural change** — this is the explicit compatibility guarantee.
- **`AUTH_MODE=multi`:** SSO required, auth middleware enforced, per-human Matrix identities, scoping and audit active.

This makes the auth layer **additive**: it ships dormant and is switched on deliberately.

### Activating multi-user mode without data loss

1. **Operator configures the OIDC adapter** (Entra ID discovery URL, client id/secret, optional claim→role mapping) and sets `AUTH_MODE=multi`.
2. **First login adopts the existing admin.** The first human to log in via SSO (or a configured bootstrap subject/email) is mapped to the **existing admin Matrix user** and granted **System Admin**. Their per-human identity *is* the legacy admin account, so:
   - All existing DM rooms and `sessions/<roomId>.jsonl` are already "theirs" — nothing is migrated or lost.
   - `MATRIX_ACCESS_TOKEN` becomes the stored token for that one human user record (service-account use of it is replaced by per-human tokens for everyone else).
3. **Existing resources get a default scope.** A one-time migration assigns existing environments/credentials/agents to a `system` scope (visible to System Admins). The bootstrap System Admin then re-scopes them to teams as needed. Nothing is deleted; unscoped == system-scoped until reassigned.
4. **Existing teams** (the `team` / `team-member` agent groups) gain an `ownerTeamId`/owner assignment, defaulting to the bootstrap admin's ownership until reassigned.
5. **New humans** log in → JIT-provisioned → no team access until a System Admin grants it (fail-closed).

### Rollback

Because mode is a single switch and migration is additive (scopes default to `system`, no data is moved or deleted), an operator can set `AUTH_MODE=single` again and the original single-operator behaviour returns. The added scope/owner fields are simply ignored in single mode.

---

## 9 — Decisions with Significant Cost Implications

These are the points where implementation cost is non-trivial and should be weighed before committing:

1. **Per-human Matrix accounts + per-human-per-agent DM rooms (§4).** This touches DM-room persistence shape, the chat UI's room resolution, trigger output routing, and the migration of existing rooms. It is the single largest structural change. *High cost, but unavoidable given the privacy requirement.*
2. **Authorization filtering across every resource (§3, §6).** Every list/read/mutate endpoint must become scope-aware. This is broad (touches most of `api.js`) even though each change is individually small. *Medium-high cost, broad surface.*
3. **Workspace Browser and session-log access control (§6).** Closing the current unrestricted exposure. *Medium cost, high security value — should be prioritised early.*
4. **OIDC integration + console-minted JWT + middleware (§2, §5).** Well-trodden ground with mature libraries; the cost is in correctness (token validation, JWKS rotation, cookie flags) not novelty. *Medium cost.*
5. **Audit log + optional SIEM forwarder (§7).** The append-only log is cheap; the SIEM forwarder and tamper-evidence are where cost grows. Ship the JSONL log first, forwarder later. *Low→medium cost, stageable.*
6. **Claim-mapping from IdP groups to system roles (§2).** Optional; defer if in-app role assignment is acceptable for v1. *Low cost if deferred.*

---

## 10 — Follow-up Implementation Issues

Prioritised. Earlier items unblock or de-risk later ones.

1. **Auth foundation: `AUTH_MODE` switch + OIDC login/callback + console-minted JWT in HttpOnly cookie + auth middleware.** Ships dormant (`single` default). (§2, §5, §8)
2. **System user model + JIT provisioning + role/team-role assignment API and admin UI.** The `users` table, `(issuer, oid)` keying, fail-closed defaults. (§2, §3)
3. **Per-human Matrix identity provisioning on first login + per-human Matrix token storage (server-side).** (§4)
4. **Authorization layer: scope-aware filtering across all `/api/*` routes** (`system` / `team:<id>` / `private:<userId>`); enforce §3 role boundaries. (§3, §6)
5. **Close the Workspace Browser and session-log exposure** — team-scoped access checks on `/api/agents/:id/workspace/*` and session-log endpoints. *Security-priority; can land alongside #4.* (§6)
6. **Per-human-per-agent DM rooms** — migrate `dm-room.json` → per-user room map; update chat UI room resolution and trigger output routing. (§4)
7. **Credential scoping + `credential owner` concept** across SSH keys, GitHub tokens, MCP credentials. (§3, §6) — the per-human personal tier is fully specified in [personal-credentials-concept.md](personal-credentials-concept.md). *(Phase 1 — data model & RBAC shipped — #1576)*
8. **Environment + team ownership scoping.** (§6)
9. **Audit log (append-only JSONL) + audit middleware on all mutating actions.** (§7)
10. **Migration tooling**: bootstrap-admin adoption of the legacy Matrix identity + one-time default-scope assignment; documented activation runbook. (§8)
11. **Internal-API boundary hardening**: `X-Internal-Secret` on 4002, documented network rule that 4002 is never published in multi-user mode. (§5)
12. *(Optional / deferrable)* **IdP group → system-role claim mapping.** (§2)
13. *(Optional / deferrable)* **SIEM forwarder** for the audit log; tamper-evidence. (§7)
14. *(Optional / deferrable)* **SAML 2.0 adapter** behind the IdP abstraction, for deployments without OIDC. (§2)

---

*This document is a concept. It commits to a recommendation in each area and flags the cost-heavy decisions, but no auth middleware, SSO integration, or permission enforcement is implemented here — that work is captured by the issues in §10.*
