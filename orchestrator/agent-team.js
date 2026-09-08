'use strict';

// agent-team.js — an agent's ACCESS BOUNDARY (#2078, epic #2076; design of
// record `docs/decentralised-access-concept.md` D1/D5, §1.3, §4.1).
//
// WHAT THIS DECIDES. Which **Agent Team** a caller must be a member of in order
// to see or manage one agent. After D1 there is one team concept: the
// `role: 'team'` agent and its `role: 'team-member'` children are simultaneously
// the squad that works a repo AND the access boundary. So the boundary is read
// straight off the config — a team IS its own boundary, and a member's boundary
// is its `parentTeamId`.
//
// WHY THE PARENT READ DISAPPEARED. `resolveAgentTenant` (scope.js /
// agent-tenant.js) exists to hop from a member to its parent Agent Team and read
// the *parent's* `teamId`, precisely because `parentTeamId` was "never a tenant"
// — two namespaces that only shared a word. D1 collapses them, so the parent id
// IS the answer: no `loadAgentConfig` injection, no fs read, no hop, and no way
// for a member to drift away from its team's boundary.
//
// WHY THIS IS A SEPARATE FUNCTION FROM `resolveAgentTenant`. The concept
// (§1.3) describes the collapse as `resolveAgentTenant` shrinking in place. It
// cannot, yet: that function's two live callers — `usableEndpointsForTeam`
// (api.js) and the assist-endpoint pick (orchestrator.js) — resolve a *model
// provider / credential*, and credential records are still stamped with
// access-scope ids until P5 re-points them (§5.1, §10). Collapsing in place
// would answer "agent-studio-2-0" where the credential index says "default" and
// silently make every team-scoped provider unusable — the exact bug the tenant
// hop was introduced to fix. So the ACCESS axis collapses here and now, and the
// CREDENTIAL axis keeps the hop until P5 deletes it. See Amendment 2 in the
// concept doc.
//
// WHY A STANDALONE AGENT RESOLVES TO `null`. A `role: 'agent'` config belongs to
// no squad, and under D8 it is private to its owner. `null` means "no team
// boundary — decide by ownership", which is what `visibleAgent` /
// `canManageAgent` do with it. Returning its own id (as §1.3 sketches) would
// name a team no membership can reference: the same outcome, but a value that
// looks like a boundary and grants nothing.
//
// Pure and dependency-free. Duplicated byte-identically into the admin-console
// image (which copies only `api/*.js`), two-sided-guarded by agent-team.test.js
// — the same arrangement as toolchain-registry.js / plugin-manifest.js.

// The agent's Agent Team id, or `null` when it has no team boundary.
//
// Fail-closed on every unexpected shape: a `null` boundary grants nothing on its
// own (§8.4 — an unstamped resource must be invisible to a non-admin rather than
// defaulting into view), so a broken config cannot widen access.
function resolveAgentTeam(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  if (cfg.role === 'team') return cfg.id || null;
  // A member with no parent is broken data, not a standalone agent — but both
  // answer "no team", which is the safe direction.
  if (cfg.role === 'team-member') return cfg.parentTeamId || null;
  return null;
}

// Is this agent decided by ownership alone rather than by team membership?
// True for a standalone `role: 'agent'` (D8) and for any config too broken to
// name a team.
function isOwnerScopedAgent(cfg) {
  return resolveAgentTeam(cfg) === null;
}

module.exports = { resolveAgentTeam, isOwnerScopedAgent };
