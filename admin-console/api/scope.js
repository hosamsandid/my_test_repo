'use strict';

// Resource scoping by human Team (#302).
//
// Computes what the logged-in caller may see, then filters list endpoints by
// resource `teamId` (and, for agents, `visibility`/`ownerId`).
//
// SAFETY — an administrator never loses visibility:
//   - Any System-Admin user sees EVERYTHING (`all: true`). On a fresh stack the
//     only principal is the seeded System Admin (#2059), so filtering is a
//     no-op there and nothing can disappear.
//   - Filtering only narrows the view for non-admin users who are members of
//     specific teams — exactly the multi-user isolation the ticket asks for.
//
// #2059 removed the second `all: true` branch, the env single-admin (#276): the
// configured credential no longer authenticates, so no session can arrive
// without a user record behind it and `userId: null` is no longer a state an
// authenticated caller can be in. Every consequence of that null — preferences
// that would not persist, personal credentials that could not be owned, an
// audit actor with no id — is closed by the same change.
//
// Pure (no IO) so it is unit-testable; the api wires it with the on-disk
// users/memberships indexes.

// Default Agent-Chat transcript font size in px (#1437). Kept in sync with
// CHAT_FONT_SIZE_DEFAULT in orchestrator/teams-store.js (the authoritative
// validator) — the two live in separate images, so the constant is duplicated.
const CHAT_FONT_SIZE_DEFAULT = 12;

function computeScope({ username, users = [], memberships = [] } = {}) {
  // No identity → see nothing. The auth gate normally guarantees a username, so
  // this is a defensive fail-closed default. (Kept: it is NOT the env-admin
  // branch #2059 removed — that one granted `all: true`. This one grants
  // nothing, and neither does the unknown-subject branch below.)
  if (!username) return { all: false, teamIds: new Set(), roles: new Map(), userId: null };

  const user = users.find(u => (u.subject || '').toLowerCase() === String(username).toLowerCase());
  // A session subject that isn't a known user → fail closed (sees only what is
  // explicitly shared with no team, i.e. nothing). Per-user sessions only ever
  // issue for real users, so this is an edge case.
  if (!user) return { all: false, teamIds: new Set(), roles: new Map(), userId: null };

  // System Admins have global visibility regardless of team membership.
  if (user.systemAdmin) return { all: true, teamIds: new Set(), roles: new Map(), userId: user.id };

  // Otherwise: visible teams are the caller's memberships, and `roles` records
  // the per-team role (team-admin / team-member) — the basis for the admin
  // surface's per-team management gate (#584).
  const teamIds = new Set();
  const roles = new Map();
  for (const m of memberships) {
    if (m.userId !== user.id) continue;
    teamIds.add(m.teamId);
    roles.set(m.teamId, m.role);
  }
  return { all: false, teamIds, roles, userId: user.id };
}

// Is a resource owned by `teamId` visible to this scope? Resources without an
// explicit owner are treated as belonging to the default team.
function visibleTeam(scope, teamId) {
  if (!scope) return false;
  if (scope.all) return true;
  return scope.teamIds.has(teamId || 'default');
}

// Agent visibility: must be in-team, and a `private` agent is visible only to
// its owner (admins always see all). Inert until visibility/ownerId are set
// (#304) — a missing visibility defaults to team-wide.
function visibleAgent(scope, agent) {
  if (!scope) return false;
  if (scope.all) return true;
  if (!visibleTeam(scope, agent && agent.teamId)) return false;
  if (agent && agent.visibility === 'private' && agent.ownerId) {
    return agent.ownerId === scope.userId;
  }
  return true;
}

// ── Agent → human tenant resolution ─────────────────────────────────────────
//
// An agent's `teamId` names its human **Team** — the tenant every ownership,
// visibility and credential-scoping decision is keyed on. A `team-member` also
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
// A System Admin keeps `all: true` — full access.

// May the caller create/edit/delete this team and manage its memberships?
// Admins always may; a non-admin must be the `team-admin` of that exact team.
// (A missing teamId collapses to the default team, mirroring visibleTeam.)
function canManageTeam(scope, teamId) {
  if (!scope) return false;
  if (scope.all) return true;
  return scope.roles instanceof Map && scope.roles.get(teamId || 'default') === 'team-admin';
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
function normalizeCredential(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (entry.scope === 'personal') {
    return { ...entry, scope: 'personal', userId: entry.userId || null, teamId: null, assignedTeamIds: [] };
  }
  const scope = entry.scope === 'system' ? 'system' : 'team';
  if (scope === 'system') {
    const assignedTeamIds = Array.isArray(entry.assignedTeamIds)
      ? [...new Set(entry.assignedTeamIds.map(String))]
      : [];
    return { ...entry, scope, teamId: null, assignedTeamIds };
  }
  return { ...entry, scope: 'team', teamId: entry.teamId || 'default', assignedTeamIds: [] };
}

// A personal credential belongs to exactly one human and is strictly private to
// them (D2): visible/manageable ONLY by its owner, with NO `scope.all` override —
// not even a System Admin may see or manage it. This requires an identified
// owner (`c.userId`) and an identified caller (`scope.userId`); a personal
// credential with no owner matches nobody (fail-closed). Since #2059 every
// authenticated caller HAS a `scope.userId`, so it is the owner comparison —
// not a null caller — that decides, which is the rule D2 actually wanted.
function ownsPersonalCredential(scope, c) {
  return !!(c && c.userId && scope && scope.userId && c.userId === scope.userId);
}

// Is this credential visible to the caller? (list-endpoint filter — AC1/AC2/AC3)
// A personal credential is checked FIRST, before the `scope.all` admin shortcut,
// so a System Admin listing all credentials never sees anyone's personal
// entries (#1567 AC5 / D2 — no `scope.all` bypass on the personal tier).
function visibleCredential(scope, cred) {
  if (!scope) return false;
  const c = normalizeCredential(cred);
  if (c.scope === 'personal') return ownsPersonalCredential(scope, c);
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
  // resolveCredentialOwnership; here we require that identity match.
  // Checked before `scope.all` so a personal create is never waved through as an
  // admin action — it is always owner-scoped.
  if (desired && desired.scope === 'personal') return ownsPersonalCredential(scope, desired);
  if (scope.all) return true;
  const reqScope = desired && desired.scope === 'system' ? 'system' : 'team';
  if (reqScope === 'system') return false;
  return canManageTeam(scope, (desired && desired.teamId) || 'default');
}

// Only a System Admin may change a credential's scope or team assignment,
// including a cross-team move of a team-scoped credential (AC6/AC7).
function canReassignCredential(scope) {
  return !!(scope && scope.all);
}

// Would `teamId` still see this credential under the given (normalized) state?
// Used to reject a reassignment that would orphan an environment still
// referencing the credential (edge case: no silent break).
function credentialVisibleToTeam(cred, teamId) {
  const c = normalizeCredential(cred);
  const t = teamId || 'default';
  if (c.scope === 'system') return c.assignedTeamIds.includes(t);
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
// the agent's owning team, or a full-visibility admin. Callers pass the resolved
// owning team on `agent.teamId` (agentTeamId = parentTeamId||teamId, single-
// sourced in the api layer via agentMetaForScope), mirroring canManageCredential.
function canManageAgent(scope, agent) {
  if (!scope) return false;
  if (scope.all) return true;
  return canManageTeam(scope, (agent && agent.teamId) || 'default');
}

// May the caller create / edit / delete this environment (or its MCP
// credentials)? Team Admin of the resource's owning team, or a full-visibility
// admin. A missing teamId collapses to the default team, mirroring visibleTeam.
function canManageEnvironment(scope, env) {
  if (!scope) return false;
  if (scope.all) return true;
  return canManageTeam(scope, (env && env.teamId) || 'default');
}

// ── Token-usage statistics visibility (#801) ────────────────────────────────
//
// The Token Usage statistics view (token/cost figures) is, for now, a
// System-Admin-only surface: the operator keeps consumption numbers until it is
// decided how much of them teams should see. The boundary is simply full
// visibility (`scope.all` — a System-Admin user); a Team Admin
// or Team Member gets none. This is the real security boundary enforced on every
// usage endpoint; the SPA route/nav gate is UX only. The System Admin narrows to
// a single team via the `?team=` query parameter (see the usage routes), which is
// orthogonal to this gate.
function canViewUsageStatistics(scope) {
  return !!(scope && scope.all);
}

// A serializable authorization descriptor for the session (AC6/AC7). Carries an
// admin/System-Admin indicator and the caller's per-team memberships+roles, so
// the frontend can make rendering decisions without re-deriving them. A
// System-Admin user record is reported as `admin: true` (full visibility).
//
// #2059 removed the `envAdmin` flag. It was computed independently of
// `computeScope`, so deleting the env-admin branch alone would have left it
// true — and `isKnownPrincipal` admitted an IAP identity on that flag ALONE,
// which would have handed a silent, empty-scope session to anyone whose e-mail
// happened to equal `ADMIN_USERNAME`: precisely the #1415 failure mode. With
// the flag gone, `admin` and `systemAdmin` state the same fact, kept as two
// keys because the client reads both.
function describeAuthz({ username, users = [], memberships = [] } = {}) {
  const scope = computeScope({ username, users, memberships });
  const teams = [...scope.roles.entries()].map(([teamId, role]) => ({ teamId, role }));
  // Surface the caller's own GitHub handle (#1385) so the session knows who to
  // assign a parent tracker ticket to. Present only for a known user record.
  const self = users.find(u => (u.subject || '').toLowerCase() === String(username).toLowerCase());
  const githubHandle = (self && typeof self.githubHandle === 'string') ? self.githubHandle : '';
  // Per-user Agent-Chat transcript font size (#1437). Read the caller's own
  // stored preference; anyone without a set value gets the 12px default.
  const chatFontSize = (self && Number.isFinite(self.chatFontSize))
    ? self.chatFontSize
    : CHAT_FONT_SIZE_DEFAULT;
  return {
    admin: scope.all,       // full visibility — a System-Admin user record
    systemAdmin: scope.all, // the same fact; both keys are read by the client
    userId: scope.userId,
    githubHandle,
    chatFontSize,
    teams,
  };
}

// Is this authz descriptor a subject the console actually knows — i.e. a
// registered user-store record? Basis for the IAP auto-login gate (#1415): only
// known principals get a silent session; anyone else who merely passed Google
// IAP falls through to the login form. Fail-closed on missing/partial input.
//
// Since #2059 a resolved `userId` is the whole test. The env-admin arm is gone
// with the credential it described, which also closes the hole where an IAP
// identity merely NAMED `ADMIN_USERNAME` was admitted with an empty scope.
function isKnownPrincipal(authz) {
  return !!(authz && authz.userId != null);
}

module.exports = {
  computeScope,
  visibleTeam,
  visibleAgent,
  resolveAgentTenant,
  canManageTeam,
  canManageAgent,
  canManageEnvironment,
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
