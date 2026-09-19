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

// Whether a plugin's UI entry is globally visible to every authenticated user,
// independent of any team grant (#1599). Opt-in manifest flag `ui.global`;
// absent/false ⇒ the entry stays grant-gated exactly as before.
function isGloballyVisibleUi(manifest) {
  return !!(manifest && manifest.ui && manifest.ui.global === true);
}

// The EFFECTIVE role the UI proxy enforces `ui.routes[].minRole` against. It
// starts from the grant-derived role (resolveViewerRole); when the caller has
// no such role but the plugin is globally visible, they are admitted as an
// ordinary `team-member` viewer of the plugin's GENERAL routes (#1599, the
// open-question-2 default) — never team-admin/system-admin. Because the global
// fallback tops out at team-member, an elevated route (minRole above
// team-member, e.g. an `/admin` route) is still refused by enforceUiRoute for a
// purely-global viewer, while a caller who genuinely holds a team-admin/system
// role keeps it (resolveViewerRole wins first). Returns the role or null.
function effectiveViewerRole(scope, grantedTeamIds, { globalVisible = false } = {}) {
  const granted = resolveViewerRole(scope, grantedTeamIds);
  if (granted) return granted;
  return globalVisible ? 'team-member' : null;
}

// The caller's role in EACH in-scope granted team — the map the proxy signs
// alongside the flat `role` so a broker can gate a team-selecting elevated
// route on the chosen team, not on the caller's best team (F4 of the Jira
// review). A System Admin is system-admin everywhere; otherwise each granted
// team the caller belongs to maps to their role in THAT team, and a team they
// do not belong to is simply absent. `teamIds` is the viewer's in-scope list
// as the proxy computes it.
function viewerTeamRoles(scope, teamIds) {
  const out = {};
  const ids = Array.isArray(teamIds) ? teamIds : [];
  if (scope && scope.all) {
    for (const t of ids) out[t] = 'system-admin';
    return out;
  }
  const roles = scope && scope.roles instanceof Map ? scope.roles : new Map();
  for (const t of ids) {
    const r = roles.get(t);
    if (r === 'team-admin' || r === 'team-member') out[t] = r;
  }
  return out;
}

module.exports = {
  ROLE_RANK,
  resolveViewerRole,
  viewerTeamRoles,
  uiSubPath,
  visibleScopes,
  isGloballyVisibleUi,
  effectiveViewerRole,
};
