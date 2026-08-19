'use strict';

// ─── plugin UI-extension surface (plugin system Phase 5, #1521) ──────────────
//
// The three pure primitives behind the optional UI extension a plugin may serve
// from its sidecar, proxied by the console at `/plugins/:id/ui`
// (docs/plugin-system-concept.md §4.8). The live Express proxy + iframe + nav
// entry are wired when the product decision (Florian's #1367 verdict) calls for
// an embedded QE UI; these decisions ship now because a broker needs the scope
// list server-side regardless, and reserving the role contract avoids a
// breaking retrofit into a shipped proxy.
//
// Pure + I/O-free, in the process-template.js / plugin-manifest.js discipline —
// unit-tested in isolation. The console route is a thin adapter over these.
//
//   1. deriveScopeList  — GET /plugins/:id/scopes, derived ONLY from the
//      resolved grant so a plugin can never enumerate a scope it was not
//      granted to (discovery is not a new read privilege). Brokers get the same
//      list server-side to validate what an admin picked.
//   2. enforceUiRoute   — the console refuses to proxy a path below its
//      declared `ui.routes[].minRole`; the plugin enforces it again (two
//      defense lines: network truth + role truth).
//   3. signViewerHeaders / verifyViewerHeaders — the authenticated console user
//      and effective role forwarded to the proxied UI as SIGNED headers, so a
//      plugin UI reflects the platform user model instead of a second login and
//      cannot be spoofed by a request that reaches the sidecar directly.

const crypto = require('crypto');
const { UI_ROLES } = require('./plugin-manifest');

// Role ordering (least → most privileged). Mirrors plugin-manifest.js UI_ROLES.
const ROLE_RANK = Object.freeze({ 'team-member': 1, 'team-admin': 2, 'system-admin': 3 });

function roleRank(role) {
  return ROLE_RANK[role] || 0;
}

// The scope-id rule, mirroring orchestrator/plugin-scope.js resolveScopeId
// (that module lives in the orchestrator image; the admin-console image copies
// only api/*.js, so the 3-line rule is re-stated here rather than imported —
// the same "byte-identical contract, separate copy" discipline the broker
// scope-token uses). team = the team for members / self for standalone;
// agent = the agent's own id.
function scopeIdFor(entry, granularity) {
  if (granularity === 'agent') return entry.agentId || null;
  return (entry.parentTeamId || entry.teamId) ? (entry.parentTeamId || entry.teamId) : (entry.agentId || null);
}

// Derive the scope list a plugin UI (and the broker) may see, from the resolved
// grant. `grantedAgents` is the set of agent configs the plugin is ACTIVE on —
// each `{ agentId, parentTeamId?, teamId?, scopeGranularity, agentName?,
// teamName? }`. A `directory` optionally supplies display names
// (`{ teams: {id:name}, agents: {id:name} }`). Output is deduplicated by
// scopeId (team-granularity members of one team collapse to a single team
// scope) and shaped exactly as the §4.8 endpoint:
//   [{ scopeId, kind: 'team'|'agent', displayName, teamId }]
// Only scopeIds derivable from a granted agent appear — nothing else — which is
// the "discovery is not a new read privilege" invariant.
function deriveScopeList(grantedAgents, directory = {}) {
  const teams = (directory && directory.teams) || {};
  const agents = (directory && directory.agents) || {};
  const byScope = new Map();
  for (const entry of Array.isArray(grantedAgents) ? grantedAgents : []) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = entry.scopeGranularity === 'agent' ? 'agent' : 'team';
    const scopeId = scopeIdFor(entry, kind);
    if (!scopeId) continue;
    const teamId = entry.parentTeamId || entry.teamId || (kind === 'team' ? scopeId : null);
    let displayName;
    if (kind === 'agent') {
      displayName = entry.agentName || agents[entry.agentId] || entry.agentId;
    } else {
      displayName = entry.teamName || teams[scopeId] || scopeId;
    }
    // First writer wins; a team scope seen via several members stays one entry.
    if (!byScope.has(scopeId)) {
      byScope.set(scopeId, { scopeId, kind, displayName, teamId: teamId || null });
    }
  }
  return [...byScope.values()];
}

// Find the most specific declared route governing a requested UI path: the
// longest `ui.routes[].path` that equals it or is a path-segment prefix of it.
// Returns the route or null when the plugin declares no matching route.
function matchRoute(routes, requestedPath) {
  if (!Array.isArray(routes) || !routes.length) return null;
  const reqPath = normalizePath(requestedPath);
  let best = null;
  for (const r of routes) {
    const base = normalizePath(r.path);
    const isMatch = reqPath === base
      || base === '/'
      || reqPath === base
      || reqPath.startsWith(base.endsWith('/') ? base : base + '/');
    if (isMatch && (!best || base.length > normalizePath(best.path).length)) {
      best = r;
    }
  }
  return best;
}

function normalizePath(p) {
  if (typeof p !== 'string' || !p) return '/';
  let s = p.split('?')[0].split('#')[0];
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

// Decide whether a viewer with `viewerRole` may be proxied to `requestedPath`
// of `manifest`'s UI. A plugin with no declared routes is treated as a single
// implicit `/` route open to team-member (the minimum) — a UI that ships no
// `ui.routes` still requires an authenticated console session, nothing finer.
// Returns { allowed, minRole, matched, reason }.
function enforceUiRoute(manifest, requestedPath, viewerRole) {
  const routes = manifest && manifest.ui && Array.isArray(manifest.ui.routes) ? manifest.ui.routes : [];
  const route = matchRoute(routes, requestedPath);
  const minRole = route ? route.minRole : 'team-member';
  if (routes.length && !route) {
    // Routes are declared but none governs this path → refuse (no implicit open).
    return { allowed: false, minRole: null, matched: null, reason: `no ui.route declared for ${normalizePath(requestedPath)}` };
  }
  if (!UI_ROLES.includes(viewerRole)) {
    return { allowed: false, minRole, matched: route ? route.path : '/', reason: `unknown viewer role "${String(viewerRole)}"` };
  }
  if (roleRank(viewerRole) < roleRank(minRole)) {
    return {
      allowed: false, minRole, matched: route ? route.path : '/',
      reason: `route ${route ? route.path : '/'} requires ${minRole}; viewer is ${viewerRole}`,
    };
  }
  return { allowed: true, minRole, matched: route ? route.path : '/', reason: null };
}

// ── signed viewer identity headers (§4.8) ───────────────────────────────────
// The proxy stamps the authenticated user + effective role + in-scope team ids
// as HMAC-signed headers the sidecar can trust; the plugin verifies the
// signature so a request reaching the sidecar directly (bypassing the console)
// cannot forge an identity. Canonicalisation is stable + order-independent for
// teamIds so sign/verify always agree.

const HDR = Object.freeze({
  user: 'x-aee-plugin-user',
  role: 'x-aee-plugin-role',
  teams: 'x-aee-plugin-teams',
  sig: 'x-aee-plugin-sig',
});

function canonical(viewer) {
  const sub = String(viewer && viewer.sub != null ? viewer.sub : '');
  const role = String(viewer && viewer.role != null ? viewer.role : '');
  const teams = Array.isArray(viewer && viewer.teamIds)
    ? [...new Set(viewer.teamIds.map(String))].sort()
    : [];
  return { sub, role, teams, canonicalString: `${sub}\n${role}\n${teams.join(',')}` };
}

function signViewerHeaders(viewer, secret) {
  if (!secret) throw new Error('signViewerHeaders requires a secret');
  const c = canonical(viewer);
  const sig = crypto.createHmac('sha256', secret).update(c.canonicalString).digest('base64url');
  return {
    [HDR.user]: c.sub,
    [HDR.role]: c.role,
    [HDR.teams]: c.teams.join(','),
    [HDR.sig]: sig,
  };
}

// Verify signed viewer headers → { sub, role, teamIds } or null. Accepts a raw
// headers map or a request-like object with `.headers`. Constant-time compare +
// strict length check, matching scope-token.js.
function verifyViewerHeaders(headersOrReq, secret) {
  if (!secret) return null;
  const h = headersOrReq && headersOrReq.headers ? headersOrReq.headers : headersOrReq;
  if (!h || typeof h !== 'object') return null;
  const get = (k) => h[k] != null ? h[k] : h[k.toLowerCase()];
  const sub = get(HDR.user);
  const role = get(HDR.role);
  const teamsRaw = get(HDR.teams);
  const sig = get(HDR.sig);
  if (typeof sig !== 'string' || !sig) return null;
  const teamIds = typeof teamsRaw === 'string' && teamsRaw.length ? teamsRaw.split(',') : [];
  const expected = signViewerHeaders({ sub, role, teamIds }, secret)[HDR.sig];
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { sub: String(sub || ''), role: String(role || ''), teamIds };
}

module.exports = {
  ROLE_RANK,
  roleRank,
  deriveScopeList,
  matchRoute,
  enforceUiRoute,
  signViewerHeaders,
  verifyViewerHeaders,
  HEADER_NAMES: HDR,
};
