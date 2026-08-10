'use strict';

// ─── plugin UI-proxy viewer decisions (plugin system Phase 2 of #1554) ───────
//
// The console proxy at `ALL /plugins/:id/ui/*` (docs/network-plan-plugin-concept.md
// §7) is a thin adapter over the pure primitives in `plugin-ui-proxy.js`
// (`enforceUiRoute` / `signViewerHeaders`). This module holds the two remaining
// pure decisions the route needs so they can be unit-tested without a live
// sidecar or an HTTP harness (the `process-template.js` / #651 discipline):
//
//   1. resolveViewerRole — the caller's EFFECTIVE role for a plugin, from the
//      console scope + the set of teams the plugin is granted to. A System Admin
//      is always `system-admin`; otherwise the caller's highest role across the
//      granted teams they belong to (team-admin beats team-member), or null when
//      they belong to none of them (no access — discovery is not a read
//      privilege, and neither is the UI).
//   2. uiSubPath — the UI-relative path the proxy enforces `minRole` on and
//      forwards to the sidecar, stripped of the `/plugins/:id/ui` mount prefix.

const ROLE_RANK = Object.freeze({ 'team-member': 1, 'team-admin': 2, 'system-admin': 3 });

// scope: the computeScope() result — { all, teamIds:Set, roles:Map<teamId,role> }.
// grantedTeamIds: the teams the plugin is currently granted to (from the
// resolved grant enumeration). Returns 'system-admin' | 'team-admin' |
// 'team-member' | null.
function resolveViewerRole(scope, grantedTeamIds) {
  if (scope && scope.all) return 'system-admin';
  const granted = new Set(Array.isArray(grantedTeamIds) ? grantedTeamIds : [...(grantedTeamIds || [])]);
  const roles = scope && scope.roles instanceof Map ? scope.roles : new Map();
  let best = null;
  for (const [teamId, role] of roles.entries()) {
    if (!granted.has(teamId)) continue;
    if (role === 'team-admin') return 'team-admin';
    if (role === 'team-member' && !best) best = 'team-member';
  }
  return best;
}

// The UI-relative sub-path of a proxied request. `/plugins/<id>/ui` → '/',
// `/plugins/<id>/ui/runs?x=1` → '/runs'. Query/hash stripped; anything that is
// not under the mount collapses to '/' (the caller has already matched the
// route by prefix, so this only normalises).
function uiSubPath(pathname, pluginId) {
  const base = `/plugins/${pluginId}/ui`;
  let p = String(pathname || '').split('?')[0].split('#')[0];
  if (p === base || p === base + '/') return '/';
  if (p.startsWith(base + '/')) {
    const rest = p.slice(base.length);
    return rest || '/';
  }
  return '/';
}

// Filter a deriveScopeList() result to only the scopes the caller may see: a
// full-visibility admin sees all; anyone else sees only scopes whose team they
// belong to. Discovery must not become a cross-team read privilege.
function visibleScopes(scope, scopeList) {
  if (scope && scope.all) return Array.isArray(scopeList) ? scopeList : [];
  const teamIds = scope && scope.teamIds instanceof Set ? scope.teamIds : new Set();
  return (Array.isArray(scopeList) ? scopeList : []).filter((s) => s && s.teamId && teamIds.has(s.teamId));
}

module.exports = { ROLE_RANK, resolveViewerRole, uiSubPath, visibleScopes };
