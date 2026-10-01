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
// + the caller's role IN EACH of those teams as HMAC-signed headers the sidecar
// can trust; the plugin verifies the signature so a request reaching the
// sidecar directly (bypassing the console) cannot forge an identity.
// Canonicalisation is stable + order-independent for teamIds / teamRoles so
// sign/verify always agree.
//
// Why a per-team map as well as the flat `role`: `role` is the caller's MAX
// across the granted teams they belong to, which cannot express "Team Admin of
// A, Team Member of B". A broker that lets the request pick the team (`?team=`)
// and gates an elevated route on the flat role would hand U admin rights over
// B. `role` stays for team-agnostic routes and page loads (the proxy's own
// `enforceUiRoute` pre-check); a broker that selects a team MUST gate elevated
// routes on `roleForTeam(viewer, team)`.
//
// This scheme is copied byte-for-byte into every broker's `viewer-headers.js`
// (a broker's Docker build context cannot reach this file); changing what is
// signed here means changing every copy — and rebuilding the plugin images —
// in the same change.

const HDR = Object.freeze({
  user: 'x-aee-plugin-user',
  role: 'x-aee-plugin-role',
  teams: 'x-aee-plugin-teams',
  teamRoles: 'x-aee-plugin-team-roles',
  sig: 'x-aee-plugin-sig',        // v1: signs sub + role + teams only (pre-map)
  sigV2: 'x-aee-plugin-sig-v2',   // v2: also signs the per-team role map
});

const VIEWER_ROLES = Object.freeze(['team-member', 'team-admin', 'system-admin']);

// `teamRoles` is serialised as `teamId=role` pairs sorted by teamId; only
// in-scope teams with a known role are kept, so the map can never name a team
// the `teams` list does not.
//
// Two canonical strings are derived so the signature can be VERSIONED without a
// flag-day rebuild of every broker (the F4 grace period):
//   * `v1String` is byte-identical to the pre-map form — the string a broker
//     built before the role map existed still computes. The proxy keeps signing
//     it into `sig`, so an un-rebuilt broker verifies exactly as before and
//     never 401s against a newer proxy.
//   * `v2String` extends it with the role map and is signed into `sigV2`; a
//     rebuilt broker prefers it, so the map is signed wherever it is consulted.
function canonical(viewer) {
  const sub = String(viewer && viewer.sub != null ? viewer.sub : '');
  const role = String(viewer && viewer.role != null ? viewer.role : '');
  const teams = Array.isArray(viewer && viewer.teamIds)
    ? [...new Set(viewer.teamIds.map(String))].sort()
    : [];
  const rawRoles = viewer && viewer.teamRoles && typeof viewer.teamRoles === 'object' ? viewer.teamRoles : {};
  const teamRoles = teams
    .filter((t) => VIEWER_ROLES.includes(rawRoles[t]))
    .map((t) => `${t}=${rawRoles[t]}`);
  const v1String = `${sub}\n${role}\n${teams.join(',')}`;
  return {
    sub, role, teams, teamRoles,
    v1String,
    v2String: `${v1String}\n${teamRoles.join(',')}`,
  };
}

function hmac(str, secret) {
  return crypto.createHmac('sha256', secret).update(str).digest('base64url');
}

function signViewerHeaders(viewer, secret) {
  if (!secret) throw new Error('signViewerHeaders requires a secret');
  const c = canonical(viewer);
  return {
    [HDR.user]: c.sub,
    [HDR.role]: c.role,
    [HDR.teams]: c.teams.join(','),
    [HDR.teamRoles]: c.teamRoles.join(','),
    [HDR.sig]: hmac(c.v1String, secret),    // un-rebuilt brokers verify THIS
    [HDR.sigV2]: hmac(c.v2String, secret),  // rebuilt brokers prefer THIS
  };
}

function parseTeamRoles(raw) {
  const out = {};
  if (typeof raw !== 'string' || !raw) return out;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function timingEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Verify signed viewer headers → { sub, role, teamIds, teamRoles } or null.
// Accepts a raw headers map or a request-like object with `.headers`.
// Constant-time compare + strict length check, matching scope-token.js.
//
// v2 is preferred: it signs the per-team role map, so a team-selecting elevated
// route may trust it. When v2 is absent (a proxy older than the map) the v1
// signature is verified and the map is treated as empty — `roleForTeam` then
// degrades every team to team-member, so a missing or stripped v2 can only LOSE
// privilege, never gain it.
function verifyViewerHeaders(headersOrReq, secret) {
  if (!secret) return null;
  const h = headersOrReq && headersOrReq.headers ? headersOrReq.headers : headersOrReq;
  if (!h || typeof h !== 'object') return null;
  const get = (k) => h[k] != null ? h[k] : h[k.toLowerCase()];
  const sub = get(HDR.user);
  const role = get(HDR.role);
  const teamsRaw = get(HDR.teams);
  const teamRolesRaw = get(HDR.teamRoles);
  const sig = get(HDR.sig);
  const sigV2 = get(HDR.sigV2);
  const teamIds = typeof teamsRaw === 'string' && teamsRaw.length ? teamsRaw.split(',') : [];
  const teamRoles = parseTeamRoles(teamRolesRaw);
  const c = canonical({ sub, role, teamIds, teamRoles });
  if (typeof sigV2 === 'string' && sigV2) {
    // The presented map must be exactly what canonicalisation would emit —
    // otherwise a pair the canonical form drops could ride along unsigned.
    if (String(teamRolesRaw || '') !== c.teamRoles.join(',')) return null;
    if (!timingEqual(sigV2, hmac(c.v2String, secret))) return null;
    return { sub: String(sub || ''), role: String(role || ''), teamIds, teamRoles };
  }
  if (typeof sig === 'string' && sig && timingEqual(sig, hmac(c.v1String, secret))) {
    return { sub: String(sub || ''), role: String(role || ''), teamIds, teamRoles: {} };
  }
  return null;
}

// The viewer's role in ONE team — what an elevated, team-selecting route must
// gate on. Never elevates: a team outside the viewer's scope is null, and an
// in-scope team with no map entry (an older proxy) is a plain team-member.
function roleForTeam(viewer, teamId) {
  if (!viewer || !Array.isArray(viewer.teamIds) || !viewer.teamIds.includes(teamId)) return null;
  const r = viewer.teamRoles && viewer.teamRoles[teamId];
  return VIEWER_ROLES.includes(r) ? r : 'team-member';
}

// Whether a body parser upstream already consumed this request's body, so the
// proxy must re-serialise `req.body` instead of streaming `req` (which would
// forward an empty body). Express 4 (body-parser 1) flags it with `req._body`;
// Express 5 (body-parser 2) dropped the flag and only leaves the stream read
// to its end. `req.body` alone is not enough: body-parser 1 sets it to `{}`
// even for a body it did not parse (and left unread).
function bodyWasParsed(req) {
  if (!req) return false;
  if (req._body === true) return true;
  return req.body !== undefined && req.readableEnded === true;
}

// The #1858 label fast-path kind for a label-add through the GitHub Issues
// plugin (#2746). The broker reports whether it labelled an issue or a pull
// request (from GitHub's own refetched item) in this response header; the
// proxy reads it from the upstream response, never from the browser's request.
// Anything else — a missing header from an older broker image included —
// degrades to 'issue', the pre-#2746 behaviour.
const LABEL_TARGET_KIND_HEADER = 'x-aee-label-target-kind';
function labelTargetKindFromHeaders(headers) {
  const raw = headers && headers[LABEL_TARGET_KIND_HEADER];
  const v = String(Array.isArray(raw) ? raw[0] : (raw || '')).trim().toLowerCase();
  return v === 'pr' ? 'pr' : 'issue';
}

module.exports = {
  ROLE_RANK,
  roleRank,
  deriveScopeList,
  matchRoute,
  enforceUiRoute,
  signViewerHeaders,
  roleForTeam,
  bodyWasParsed,
  LABEL_TARGET_KIND_HEADER,
  labelTargetKindFromHeaders,
  verifyViewerHeaders,
  HEADER_NAMES: HDR,
};
