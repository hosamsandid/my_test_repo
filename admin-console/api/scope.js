'use strict';

// Resource scoping by Team (#302; re-pointed onto the Agent Team by #2078).
//
// Computes what the logged-in caller may see, then filters list endpoints by
// resource `teamId` (and, for agents, `ownerId`).
//
// WHAT #2078 CHANGED, AND WHAT IT DID NOT. Not the shape of anything here: the
// scope object, all twelve `scope.all` short-circuits (D5) and the role rule in
// `canManageTeam` are untouched. What changed is the KEY SPACE — `teamIds` /
// `roles` are keyed by **Agent Team** id, because `memberships.teamId` now
// references one (P1/#2077 fanned the grants out; concept §3.3). Three
// consequences are real code changes and are commented at their site:
// `visibleAgent` / `canManageAgent` read the agent's own boundary instead of a
// resolved tenant, ownership decides for an agent that has no team (D8), and the
// `|| 'default'` fallback is gone from six predicates (§8.4).
//
// Credentials, environments, MCP servers and model providers are still stamped
// with access-scope ids; P5 re-points them (concept §5.1). Their grants keep
// resolving because P1's fan-out was additive — the legacy scope memberships are
// retired together with the stamps they gate, not before.
//
// SAFETY — the operator never loses visibility:
//   - The env single-admin (#276) and any System-Admin user see EVERYTHING
//     (`all: true`). In the current single-operator setup the caller is always
//     the env admin, so filtering is a no-op and nothing can disappear.
//   - Filtering only narrows the view for non-admin users who are members of
//     specific teams — exactly the multi-user isolation the ticket asks for.
//   - `authEnabled: false` (#1457) makes that a named mode rather than an
//     accident of there being one login: every principal is the operator and
//     no filter narrows anything. See auth-mode.js for the flag and why it
//     defaults to off in the env while defaulting to ON as a parameter here.
//
// WHAT #2083 (P5) ADDED. Working environments and MCP servers gained the SHARED
// tier they lacked (concept §5.2): both now carry the same
// `{scope, teamId, assignedTeamIds, userId}` shape credentials have had since
// #798, defined once in `resource-tier.js` (byte-mirrored into the orchestrator,
// which writes it in the boot migration). Credentials and model providers keep
// their access-scope stamps — see the DEFERRED note on `credentialVisibleToTeam`.
//
// Pure (no IO) so it is unit-testable; the api wires it with the on-disk
// users/memberships indexes.

const {
  TIER_PERSONAL,
  TIER_SYSTEM,
  normalizeTier,
  ownsPersonalTier,
} = require('./resource-tier');
// The GLOBAL model-provider rule (#2136) lives in its own provider-specific
// module, NOT in the generic credential predicates below — those also gate SSH
// keys and GitHub tokens, and a `global: true` on one of those must stay inert
// (a secret is the blast radius, #2136 finding 2). Only the assist-selector
// predicate (provider-only) reads it directly; the list/agent-picker call sites
// compose it in api.js (`providerVisible` / `providerUsableByTeam`).
const { isGlobalProvider } = require('./llm-endpoint-global');

// Default Agent-Chat transcript font size in px (#1437). Kept in sync with
// CHAT_FONT_SIZE_DEFAULT in orchestrator/teams-store.js (the authoritative
// validator) — the two live in separate images, so the constant is duplicated.
const CHAT_FONT_SIZE_DEFAULT = 12;

// Match a session subject against the user store, case-insensitively (a login
// subject is an e-mail address in practice). Extracted so the three callers
// below — `computeScope`'s two branches and `describeAuthz` — cannot drift in
// what counts as "the caller's own record".
function findUserBySubject(users = [], username) {
  if (!Array.isArray(users) || !username) return undefined;
  const wanted = String(username).toLowerCase();
  return users.find(u => u && (u.subject || '').toLowerCase() === wanted);
}

function computeScope({ username, adminUsername, users = [], memberships = [], authEnabled = true } = {}) {
  // No identity → see nothing (the auth gate normally guarantees a username;
  // this is a defensive fail-closed default, never reached for the env admin).
  // Checked BEFORE the single-user branch: that mode relaxes authorization, not
  // authentication, so an unauthenticated request still sees nothing.
  if (!username) return { all: false, teamIds: new Set(), roles: new Map(), userId: null };

  // Option C (#2059↔#1457 human ruling, PR #2094): both env-admin power grants
  // below are a ONE-TIME SEED WINDOW. They apply only while the store holds no
  // System-Admin record yet (a fresh / not-yet-activated install). Once
  // `seedInitialSystemAdmin` has created that record, the env admin is retired
  // permanently — no durable config-file login (#2059 AC4's intent) — and both
  // branches fall through to normal per-record resolution, so a session issued
  // to the env admin pre-seed also loses its power the moment the stack is
  // seeded. AC7 keeps at least one System-Admin record thereafter, so this stays
  // closed.
  const systemAdminSeeded = users.some(u => u && u.systemAdmin === true);

  // Single-user compatibility mode (#1457): whoever is signed in is the
  // operator — the implicit System Admin. `userId` still resolves when the
  // subject matches a user record, so ownership-keyed behaviour (audit
  // attribution, personal credentials, per-user preferences) keeps working;
  // the env admin has no record and keeps its historical `userId: null`.
  // NOT pre-seed-gated (Option C): `!authEnabled` is a deployment choice — auth
  // is disabled and everyone signed in is the operator — not the env-credential
  // comparison the pre-seed window governs. The env credential's one-time login
  // is gated in the login route (`auth.js` `preSeed()`) and in the env-admin
  // branch below; this mode is orthogonal and unchanged.
  if (!authEnabled) {
    const self = findUserBySubject(users, username);
    return { all: true, teamIds: new Set(), roles: new Map(), userId: self ? self.id : null };
  }

  // The env single-admin credential is the operator: full visibility — pre-seed
  // only (Option C), so it cannot authenticate once a real System-Admin exists.
  if (adminUsername && username === adminUsername && !systemAdminSeeded) {
    return { all: true, teamIds: new Set(), roles: new Map(), userId: null };
  }

  const user = findUserBySubject(users, username);
  // A session subject that isn't a known user → fail closed (sees only what is
  // explicitly shared with no team, i.e. nothing). Per-user sessions only ever
  // issue for real users, so this is an edge case.
  if (!user) return { all: false, teamIds: new Set(), roles: new Map(), userId: null };

  // System Admins have global visibility regardless of team membership.
  if (user.systemAdmin) return { all: true, teamIds: new Set(), roles: new Map(), userId: user.id };

  // Otherwise: visible teams are the caller's memberships, and `roles` records
  // the per-team role (team-admin / team-member) — the basis for the admin
  // surface's per-team management gate (#584). Since #2078 each `m.teamId` is an
  // Agent Team id; the loop is unchanged because the re-keying is a property of
  // the data, not of this code.
  const teamIds = new Set();
  const roles = new Map();
  for (const m of memberships) {
    if (m.userId !== user.id) continue;
    teamIds.add(m.teamId);
    roles.set(m.teamId, m.role);
  }
  return { all: false, teamIds, roles, userId: user.id };
}

// Is a resource owned by `teamId` visible to this scope?
//
// #2078/§8.4: the historical `|| 'default'` fallback is GONE. It existed because
// `teams/index.json` always held a protected `default` team; with that layer
// collapsing there is no such referent, and `visibleTeam(scope, undefined)`
// returning true for anyone holding a membership named `default` would be a real
// leak (nothing stops a team being created with that slug). An unowned resource
// is now invisible to a non-admin rather than defaulting into view.
function visibleTeam(scope, teamId) {
  if (!scope) return false;
  if (scope.all) return true;
  if (!teamId) return false;
  return scope.teamIds.has(teamId);
}

// Does the caller own this resource? The rule for anything outside every team
// boundary (D8). Requires an identified owner AND an identified caller, so an
// ownerless resource and the env single-admin (`userId: null`) both match
// nobody. Module-private: every caller short-circuits on `scope.all` first, so
// this deliberately carries no admin bypass of its own.
function ownedByCaller(scope, resource) {
  return !!(resource && resource.ownerId && scope && scope.userId
            && resource.ownerId === scope.userId);
}

// Agent visibility (#2078 — D1 + D8).
//
// Callers pass the agent's resolved ACCESS BOUNDARY on `teamId` (agent-team.js
// `resolveAgentTeam`, single-sourced in the api layer via `agentMetaForScope`):
// its own id for a `role: 'team'`, its `parentTeamId` for a `role: 'team-member'`,
// and `null` for a standalone `role: 'agent'`.
//
//   • boundary present → plain team membership decides (any role — D9 lets a
//     Team Member read and chat; the management gate is canManageAgent).
//   • no boundary      → ownership decides. D8 makes owner-only the *rule* for a
//     standalone agent, not an opt-in: the pre-#2078 `visibility === 'private'`
//     condition is retired unread (nothing ever wrote the field, verified in
//     concept §3.5), so a standalone agent is private to its creator full stop.
//
// Post-#2229 (epic; #2234 decision), "a standalone agent" reaching this branch
// means an **ephemeral** agent or a malformed config, not an ordinary
// user-created one — Phase C's team-of-one migration converts every ordinary
// standalone agent into a team of one, and the ephemeral-agent route is a
// permanent exception the migration does not touch. The rule itself is
// unchanged: docs/decentralised-access-concept.md Amendment 10.
function visibleAgent(scope, agent) {
  if (!scope) return false;
  if (scope.all) return true;
  if (agent && agent.teamId) return visibleTeam(scope, agent.teamId);
  return ownedByCaller(scope, agent);
}

// ── Agent → credential tenant resolution ────────────────────────────────────
//
// NOT the access boundary. Since #2078 that is `resolveAgentTeam`
// (agent-team.js) — see the WHY THIS IS A SEPARATE FUNCTION note there. What
// survives here is the CREDENTIAL axis: model providers, SSH keys and GitHub
// tokens are still stamped with access-scope ids until P5 re-points them
// (concept §5.1/§10), so resolving a provider for an agent still needs the hop.
// Its two live callers are `usableEndpointsForTeam` (api.js) and the assist
// endpoint pick (orchestrator.js), both provider lookups. **This function and
// its `|| 'default'` fallback retire with P5** — do not reach for it to answer
// an authorization question.
//
// An agent's `teamId` names its human **Team** — the tenant every credential-
// scoping decision is keyed on. A `team-member` also
// carries `parentTeamId`, which is the id of its **Agent Team** construct (a
// `role: "team"` agent). Those are two different namespaces, and reading
// `parentTeamId` as a tenant only appears to work while an Agent Team happens
// to share its id with a human Team; otherwise it names a team that does not
// exist and every team-scoped lookup fails closed on an empty result.
//
// Per docs/teams-data-model.md a team-member inherits its parent Agent Team's
// `teamId`, so resolve the parent and read *its* tenant — one hop, since a team
// agent never carries a `parentTeamId` of its own. Falls back to the member's
// own stamp when the parent is missing or unstamped.
//
// `loadAgentConfig(id) -> config | null` is injected so this stays pure.
// Mirrored by resolveAgentTenant in orchestrator/agent-tenant.js (separate
// images, so the logic is duplicated rather than shared).
function resolveAgentTenant(cfg, loadAgentConfig) {
  const parentId = cfg && cfg.parentTeamId;
  if (parentId && typeof loadAgentConfig === 'function') {
    const parent = loadAgentConfig(parentId);
    if (parent && parent.teamId) return parent.teamId;
  }
  return (cfg && cfg.teamId) || 'default';
}

// ── Admin surface (Teams / Users / Memberships) scoping & gating (#584) ──────
//
// The #302 list-endpoints above are read-only filters. The Teams admin surface
// additionally needs a *management* gate: per the role model
// (docs/multi-user-concept.md §3), a Team Admin may manage their own team and
// its memberships, a Team Member gets read-only visibility of their own team,
// and creating teams / managing global user records is a System-Admin action.
// All admins (env admin + System Admin) keep `all: true` — full access.

// May the caller create/edit/delete this team and manage its memberships?
// Admins always may; a non-admin must be the `team-admin` of that exact team.
// Since #2078 `teamId` is an Agent Team id and a missing one fails closed rather
// than collapsing to the default team (§8.4, mirroring visibleTeam).
//
// This predicate alone carries D4 and the whole admin side of D9: it already
// means "System Admin OR team-admin of exactly this team", so re-pointing the
// key space re-points every gate built on it — no new predicate is needed.
function canManageTeam(scope, teamId) {
  if (!scope) return false;
  if (scope.all) return true;
  if (!teamId) return false;
  return scope.roles instanceof Map && scope.roles.get(teamId) === 'team-admin';
}

// Is this user visible to the caller? A non-admin sees only users who share at
// least one of their teams (which includes the caller themselves). A caller who
// is a member of no team therefore sees no user at all — fail-closed (AC5).
function visibleUser(scope, userId, memberships = []) {
  if (!scope) return false;
  if (scope.all) return true;
  return memberships.some(m => m.userId === userId && scope.teamIds.has(m.teamId));
}

// ── Credentials (SSH keys + GitHub tokens) scope & management gate (#798) ────
//
// Credentials extend the #302/#584 model with a two-value scope, so a Team
// Admin can self-serve their team's credentials and a System Admin can provision
// shared, system-wide credentials assigned to specific teams:
//
//   • team   — owned by exactly one team (`teamId`). Visible to that team's
//              Team Admins and to System Admins.
//   • system — created by a System Admin, assigned to 0..n teams
//              (`assignedTeamIds`). Visible to System Admins always and to the
//              Team Admins of every assigned team. Assigned to zero teams → only
//              System Admins see it (never orphaned or globally visible).
//
// Visibility and management are gated on the *team-admin* role (canManageTeam),
// NOT mere membership: Team Member credential access is deferred. All admins
// keep `all: true` (no regression to the single-operator setup).

// Backward-compatible view of a stored credential entry. Pre-#798 entries have
// no `scope` field and carry only `teamId` (all currently 'default'); treat each
// as team-scoped owned by its team so existing credentials keep working. Returns
// a normalized copy with an explicit `scope`, `teamId` and `assignedTeamIds`.
//
// Personal tier (#1567/epic #1558): a `personal` credential is owned by exactly
// one human (`userId`) and carries neither a team nor system assignments. It
// round-trips its owner reference without loss; every other (team/system/legacy)
// entry normalizes exactly as before — personal is strictly additive.
// #2083: the shape is no longer credential-specific — environments and MCP
// servers carry the identical triple — so the normalizer moved to
// `resource-tier.js` and this is a named alias over it. Behaviour is unchanged
// (the whole credential block of scope.test.js is the proof); what the move buys
// is that a third resource kind cannot acquire a fourth reading of `scope`.
const normalizeCredential = normalizeTier;

// A personal credential belongs to exactly one human and is strictly private to
// them (D2): visible/manageable ONLY by its owner, with NO `scope.all` override —
// not even a System Admin or the env single-admin may see or manage it. This
// requires an identified owner (`c.userId`) and an identified caller
// (`scope.userId`); a personal credential with no owner, or a caller with no user
// identity (the env single-admin has `userId: null`), matches nobody (fail-closed).
// #2083: same move as normalizeCredential — the personal-tier rule is shared by
// all three resource kinds now, so it lives in `resource-tier.js`. It still
// deliberately carries no `scope.all` bypass, and the census guard below still
// names it as one of the three predicates that must not gain one.
const ownsPersonalCredential = ownsPersonalTier;

// Is this credential visible to the caller? (list-endpoint filter — AC1/AC2/AC3)
// A personal credential is checked FIRST, before the `scope.all` admin shortcut,
// so a System/env admin listing all credentials never sees anyone's personal
// entries (#1567 AC5 / D2 — no `scope.all` bypass on the personal tier).
function visibleCredential(scope, cred) {
  if (!scope) return false;
  const c = normalizeCredential(cred);
  if (c.scope === 'personal') return ownsPersonalCredential(scope, c);
  // NOTE: this generic predicate deliberately carries NO global-provider bypass —
  // it also gates SSH keys and GitHub tokens (api.js GET /api/ssh-keys,
  // GET /api/github-tokens), where a `global: true` must never widen reach to a
  // secret (#2136 finding 2). Global model-provider reachability is added at the
  // provider call sites only, via api.js `providerVisible`.
  if (scope.all) return true;
  if (c.scope === 'system') return c.assignedTeamIds.some(t => canManageTeam(scope, t));
  return canManageTeam(scope, c.teamId);
}

// ── Assist model selection — selection (usage) visibility (#1210) ────────────
//
// The global assist model selector (Flow Copilot, Generate agent prompt, port
// suggestions, Knowledge drafting, skill merge, orchestrator syntheses) must
// bill against a provider the acting user's teams are entitled to *use*. This is
// deliberately DISTINCT from visibleCredential (the management rule, Team-Admin-
// oriented): a plain Team Member may run the Flow Copilot billed against their
// team's provider — exactly as their agents already do via
// usableEndpointsForTeam (api.js). So selection is membership-based (any role),
// not gated on canManageTeam.
//
//   A user may select provider P iff `scope.all`, OR P is usable by at least one
//   team the user is a member of: P is team-scoped with P.teamId ∈ teamIds, or
//   system-scoped with assignedTeamIds ∩ teamIds ≠ ∅.
//
// Additional filter: `oauth-token` providers are never selectable — subscription
// CLI-seat tokens must not be spent on server-side /v1/messages calls (mirrors
// resolveAssistTarget's env fallback), and they carry no baseUrl.
function assistSelectableEndpoint(scope, ep) {
  if (!scope || !ep) return false;
  if (ep.authType === 'oauth-token') return false;
  // A GLOBAL provider (#2136) is selectable by every user, in or out of a team.
  // This predicate is provider-specific (it already excludes oauth-token just
  // above), so it reads the provider rule directly. `isGlobalProvider` re-reads
  // scope==='system' && authType!=='oauth-token', so a mutated record can never
  // be selectable past what it currently qualifies for. This is what lets a
  // plain user with no team bill AI helpers.
  if (isGlobalProvider(ep)) return true;
  if (scope.all) return true;
  const c = normalizeCredential(ep);
  if (c.scope === 'team') return scope.teamIds.has(c.teamId);
  return c.assignedTeamIds.some(t => scope.teamIds.has(t));
}

// May the caller edit/delete THIS existing credential? A Team Admin may manage
// team-scoped credentials of a team they administer, never system-scoped ones
// (AC5); System Admins may manage all.
function canManageCredential(scope, cred) {
  if (!scope) return false;
  const c = normalizeCredential(cred);
  // Personal tier first, ahead of the `scope.all` shortcut: only the owner may
  // rename/rotate/delete their own personal credential; `scope.all` grants no
  // access to it (#1567 AC4 / D2).
  if (c.scope === 'personal') return ownsPersonalCredential(scope, c);
  if (scope.all) return true;
  if (c.scope === 'system') return false;
  return canManageTeam(scope, c.teamId);
}

// May the caller create a credential with the requested ownership? System-scoped
// creation is System-Admin-only; a Team Admin may create team-scoped credentials
// only for a team they administer (AC3/AC4/AC6).
function canCreateCredential(scope, desired) {
  if (!scope) return false;
  // Any authenticated human may create a personal credential owned by THEMSELVES
  // (Team Member, Team Admin or System Admin — #1567 AC3). The owner reference on
  // the desired shape has already been forced to the caller by
  // resolveCredentialOwnership; here we require that identity match, which also
  // fails closed for the env single-admin (no user record → `scope.userId` null).
  // Checked before `scope.all` so a personal create is never waved through as an
  // admin action — it is always owner-scoped.
  if (desired && desired.scope === 'personal') return ownsPersonalCredential(scope, desired);
  if (scope.all) return true;
  const reqScope = desired && desired.scope === 'system' ? 'system' : 'team';
  if (reqScope === 'system') return false;
  // No `|| 'default'` (§8.4): a create request that names no team is refused
  // rather than silently attributed to a team that no longer exists.
  return canManageTeam(scope, desired && desired.teamId);
}

// Only a System Admin may change a credential's scope or team assignment,
// including a cross-team move of a team-scoped credential (AC6/AC7).
function canReassignCredential(scope) {
  return !!(scope && scope.all);
}

// Would `teamId` still see this credential under the given (normalized) state?
// Used to reject a reassignment that would orphan an environment still
// referencing the credential (edge case: no silent break), and by
// `usableEndpointsForTeam` to answer which model providers an agent may bill
// against.
//
// #2083 — RE-POINTING THE CREDENTIAL AXIS IS DEFERRED, and the `|| 'default'`
// fallback therefore STAYS. AC3 asks for credentials, model providers and skills
// to reference Agent Team ids; the skills pool is re-pointed (it is a directory
// name, so the migration copies the pool to each Agent Team — §5.3/§8.3), but
// the credential/provider records are not, for two reasons that only became
// visible against the code:
//
//   1. There is no lossless re-point for a scope holding several Agent Teams.
//      A2.5 already says such a record "cannot be re-pointed to one of them
//      without a shared tier" — but `canManageCredential` returns false for the
//      shared tier outright (#798 AC5, pinned in scope.test.js), so promoting a
//      team credential is a manage-axis lockout for the Team Admin who owns it
//      today. Environments and MCP servers escape this because their shared tier
//      is being defined here and is defined self-service (see
//      `canManageEnvironment`); a credential's is already shipped and means
//      something stronger.
//   2. Collapsing `resolveAgentTenant` onto `resolveAgentTeam` — which is what
//      "reference the new Agent Team ids" requires of the read path — answers
//      `null` for a standalone `role: 'agent'` (A2.2, by design). Such an agent
//      would be left with no usable provider at all, and D8 does not say which
//      providers an owner-scoped agent may bill against. That is a new decision,
//      not an implementation detail.
//
// So this predicate, `resolveAgentTenant` and the scope memberships all survive
// this phase together, exactly as they survived P2. See concept Amendment 3.
function credentialVisibleToTeam(cred, teamId) {
  const c = normalizeCredential(cred);
  // NOTE: no global-provider bypass here — this generic predicate also gates the
  // SSH-key and GitHub-token surfaces (api.js), so a `global: true` on one of
  // those must stay inert (#2136 finding 2). Global model-provider reachability
  // is added at the provider call sites only, via api.js `providerUsableByTeam`.
  const t = teamId || 'default';
  if (c.scope === TIER_SYSTEM) return c.assignedTeamIds.includes(t);
  return c.teamId === t;
}

// ── Config-write authorization for agents / environments (#989) ─────────────
//
// The #302/#584 model gives list/read endpoints a *visibility* filter
// (visibleAgent / visibleTeam) and the Teams admin surface a *management* gate
// (canManageTeam). The core config-write endpoints — agent config, triggers,
// prompt/model/provider, environment CRUD — were previously either unguarded or
// gated only on visibility, so a Team Member (or a member of an unrelated team)
// could mutate them. These predicates apply the same management gate as
// canManageCredential, keyed on the *resource's* owning team: write authorization
// requires the team-admin role of the owning team (or full-visibility admin),
// never mere visibility. All admins keep `all: true` (no single-operator
// regression).

// May the caller create / edit / delete / re-parent this agent? Team Admin of
// the agent's Agent Team, or a full-visibility admin. Callers pass the resolved
// boundary on `agent.teamId` (agent-team.js `resolveAgentTeam`, single-sourced
// in the api layer via agentMetaForScope), mirroring canManageCredential.
//
// The owner branch mirrors visibleAgent's (D8): a standalone `role: 'agent'` has
// no team, so its creator is the only non-admin who may change it. Without this
// the owner could see their own private agent and not edit it — and nobody but a
// System Admin could, since no membership can name a standalone agent's id.
// Post-#2229, that standalone agent is an ephemeral one or a malformed config
// (see the note above `visibleAgent`) — the rule is unchanged.
function canManageAgent(scope, agent) {
  if (!scope) return false;
  if (scope.all) return true;
  if (agent && agent.teamId) return canManageTeam(scope, agent.teamId);
  return ownedByCaller(scope, agent);
}

// ── Tiered configuration resources: environments + MCP servers (#2083, P5) ──
//
// Both carried a single `teamId` and no shared tier, which is what made
// "creating a team requires wiring up a repo, a key, a token and a provider
// first" (AC11) structural rather than incidental. They now carry the
// `resource-tier.js` triple, and these three predicates are the whole gate set.
// One family serves both kinds: an environment and an MCP server are the same
// kind of thing under D12 — a stanza of configuration — and giving them two
// predicate sets would be two places for the shared tier to drift.
//
// TWO DELIBERATE DIFFERENCES FROM THE CREDENTIAL PREDICATES, both stated because
// §5.2 says "the tier model to copy is the credential one":
//
//  1. VISIBILITY IS MEMBERSHIP, NOT THE ADMIN ROLE. `visibleCredential` gates on
//     `canManageTeam` because Team-Member credential access was deferred by
//     #798. An environment list has always been membership-visible
//     (`visibleTeam`), and D9 says a Team Member may read — so narrowing it here
//     would be an unrelated regression smuggled in under a tiering ticket.
//
//  2. A SHARED RECORD IS MANAGEABLE BY EVERY ASSIGNED TEAM'S ADMIN.
//     `canManageCredential` returns false for the system tier outright. Copying
//     that verbatim would make the migration a LOCKOUT: an access scope holding
//     two Agent Teams cannot re-point its environment to one of them (A2.5), so
//     the migration must promote it to the shared tier — and under the credential
//     rule the Team Admin who could edit it yesterday could not today. That is
//     exactly the `canManage_after ⊇ canManage_before` half of §8.3, and
//     `ownership-no-lockout.test.js` catches it. D12's own principle ("only
//     configuration … becomes SELF-SERVICE and tiered") points the same way, and
//     an environment is text a reader can inspect rather than an opaque secret.
//     §5.2's "creating/changing a `system`-tier record is gated like
//     canReassignCredential" is honoured on the half that carries the risk:
//     WHICH teams share a record, and moving it between tiers, stays a System
//     Admin act (`canRetierEnvironment`). Editing a shared record's content does
//     not.
//
// The tier order is the same everywhere: personal before `scope.all` (§2.2),
// then the admin bypass, then shared, then team.

// An environment created for a standalone agent by a user with no team carries
// an `ownerId` (the creator) instead of a team tier — the D8 owner branch, the
// same rule that makes a standalone `role: 'agent'` visible to its creator. The
// QuickStart repository fast lane (#2071) writes it: a teamless user's own
// environment has no team to be scoped to, and the shared/system tiers would
// either hide it from its creator or require an admin to manage it. Checked
// BEFORE `scope.all` in both predicates below so it is a genuine ownership
// grant, not merely an admin bypass — mirroring how `ownsPersonalTier` sits
// ahead of the admin shortcut for the personal credential tier.
function ownsEnvironment(scope, env) {
  return !!(scope && scope.userId && env && env.ownerId && env.ownerId === scope.userId);
}

// Is this environment / MCP server visible to the caller? (list + read-one)
function visibleEnvironment(scope, env) {
  if (!scope) return false;
  const r = normalizeTier(env);
  if (r && r.scope === TIER_PERSONAL) return ownsPersonalTier(scope, r);
  if (ownsEnvironment(scope, env)) return true;
  if (scope.all) return true;
  if (!r) return false;
  if (r.scope === TIER_SYSTEM) return r.assignedTeamIds.some(t => visibleTeam(scope, t));
  return visibleTeam(scope, r.teamId);
}

// May the caller create / edit / delete this environment (or its MCP
// credentials)? Team Admin of the resource's owning team — or of ANY team a
// shared record is assigned to (difference 2 above) — or a full-visibility
// admin. A missing teamId fails closed (§8.4), mirroring visibleTeam.
function canManageEnvironment(scope, env) {
  if (!scope) return false;
  const r = normalizeTier(env);
  if (r && r.scope === TIER_PERSONAL) return ownsPersonalTier(scope, r);
  if (ownsEnvironment(scope, env)) return true;
  if (scope.all) return true;
  if (!r) return false;
  if (r.scope === TIER_SYSTEM) return r.assignedTeamIds.some(t => canManageTeam(scope, t));
  return canManageTeam(scope, r.teamId);
}

// May the caller create an environment / MCP server with the requested
// ownership? Creating a SHARED one is System-Admin-only (§5.2) — it is the act
// of declaring a resource cross-tenant. A personal one is owner-scoped and is
// checked before `scope.all`, so it is never waved through as an admin action.
function canCreateEnvironment(scope, desired) {
  if (!scope) return false;
  if (desired && desired.scope === TIER_PERSONAL) return ownsPersonalTier(scope, desired);
  if (scope.all) return true;
  if (desired && desired.scope === TIER_SYSTEM) return false;
  // No `|| 'default'`: a create naming no team is refused rather than silently
  // attributed to a team that no longer exists.
  return canManageTeam(scope, desired && desired.teamId);
}

// May the caller change WHICH teams reach this record — its tier, its owning
// team, or a shared one's assignments? System-Admin-only, mirroring
// `canReassignCredential`. `isRetier` (resource-tier.js) is what decides whether
// a given update even asks the question, so an ordinary content edit that
// restates the same ownership is not gated on this.
function canRetierEnvironment(scope) {
  return !!(scope && scope.all);
}

// ── Token-usage statistics visibility (#801) ────────────────────────────────
//
// The Token Usage statistics view (token/cost figures) is, for now, a
// System-Admin-only surface: the operator keeps consumption numbers until it is
// decided how much of them teams should see. The boundary is simply full
// visibility (`scope.all` — the env admin or a System-Admin user); a Team Admin
// or Team Member gets none. This is the real security boundary enforced on every
// usage endpoint; the SPA route/nav gate is UX only. The System Admin narrows to
// a single team via the `?team=` query parameter (see the usage routes), which is
// orthogonal to this gate.
function canViewUsageStatistics(scope) {
  return !!(scope && scope.all);
}

// A serializable authorization descriptor for the session (AC6/AC7). Carries an
// admin/System-Admin indicator and the caller's per-team memberships+roles, so
// the frontend can make rendering decisions without re-deriving them. The env
// admin and System Admins are reported as `admin: true` (full visibility).
function describeAuthz({ username, adminUsername, users = [], memberships = [], authEnabled = true } = {}) {
  const scope = computeScope({ username, adminUsername, users, memberships, authEnabled });
  // Option C (PR #2094): the env admin is a pre-seed identity only. Once a
  // System-Admin record exists, `envAdmin` is false — so `isKnownPrincipal`
  // (which admits `envAdmin || userId != null`) stops admitting a bare env-admin
  // session, keeping #2059's #1415 fix closed while still honouring the
  // pre-seed bootstrap session.
  const envAdmin = !!(username && adminUsername && String(username) === String(adminUsername))
    && !users.some(u => u && u.systemAdmin === true);
  const teams = [...scope.roles.entries()].map(([teamId, role]) => ({ teamId, role }));
  // Surface the caller's own GitHub handle (#1385) so the session knows who to
  // assign a parent tracker ticket to. Present only for a known user record;
  // the env single-admin credential has no user record and so carries none.
  const self = findUserBySubject(users, username);
  const githubHandle = (self && typeof self.githubHandle === 'string') ? self.githubHandle : '';
  // Per-user Agent-Chat transcript font size (#1437). Read the caller's own
  // stored preference; anyone without a set value — including the env
  // single-admin, which has no user record — gets the 12px default.
  const chatFontSize = (self && Number.isFinite(self.chatFontSize))
    ? self.chatFontSize
    : CHAT_FONT_SIZE_DEFAULT;
  return {
    admin: scope.all,                    // full visibility: env admin OR System Admin
    envAdmin,                            // env single-admin credential
    systemAdmin: scope.all && !envAdmin, // a non-env-admin with full visibility is a System-Admin user
    // The mode the full visibility above was decided under (#1457), so a client
    // can tell "this operator is a System Admin" from "this stack is not
    // enforcing team scoping yet" instead of inferring one from the other.
    authEnabled: !!authEnabled,
    userId: scope.userId,
    githubHandle,
    chatFontSize,
    teams,
  };
}

// Is this authz descriptor a subject the console actually knows — the env
// single-admin or a registered user-store record? Basis for the IAP auto-login
// gate (#1415): only known principals get a silent session; anyone else who
// merely passed Google IAP falls through to the login form. Fail-closed on
// missing/partial input.
function isKnownPrincipal(authz) {
  return !!(authz && (authz.envAdmin || authz.userId != null));
}

module.exports = {
  computeScope,
  visibleTeam,
  visibleAgent,
  resolveAgentTenant,
  canManageTeam,
  canManageAgent,
  ownsEnvironment,
  visibleEnvironment,
  canManageEnvironment,
  canCreateEnvironment,
  canRetierEnvironment,
  visibleUser,
  describeAuthz,
  isKnownPrincipal,
  normalizeCredential,
  visibleCredential,
  assistSelectableEndpoint,
  canManageCredential,
  canCreateCredential,
  canReassignCredential,
  credentialVisibleToTeam,
  canViewUsageStatistics,
};
