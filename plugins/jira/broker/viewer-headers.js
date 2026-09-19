'use strict';

// ─── viewer-identity header verification (jira plugin, Jira plan §6.4) ──────
//
// A byte-identical copy of the sign/verify scheme in
// admin-console/api/plugin-ui-proxy.js (§4.8), the same copy netzplan-broker and
// test-mgmt-broker carry. The console proxy stamps the authenticated user +
// effective role + in-scope team ids as HMAC-signed headers on every request it
// forwards to this sidecar; the broker verifies the signature here so a request
// reaching the sidecar directly (bypassing the console session gate) cannot
// forge an identity or elevate its role.
//
// It is copied rather than imported because a broker's Docker build context is
// the repo root and cannot reach `admin-console/api/`, and the shared broker-sdk
// does not (yet) export it. The canonicalisation MUST stay identical to the
// proxy's — the two are one contract. A natural home is broker-sdk in a later
// pass; noted in the PR.

const crypto = require('crypto');

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

// The role gate. Phase 3 declares a single ui.route ("/", team-member): any
// team member of a granted team may read issues + the inbox. Phase 4 adds a
// team-admin `/admin` watch-config route — a one-line change here then.
const ROLE_RANK = Object.freeze({ 'team-member': 1, 'team-admin': 2, 'system-admin': 3 });

function requiredRoleForPath(uiPath) {
  // Phase 4: the `/admin` route (watch config) is team-admin; everything else
  // (issues, inbox, watch view) is team-member. The UI proxy re-enforces the
  // manifest's `ui.routes[].minRole`; this is the second defence line.
  const p = String(uiPath || '');
  if (p === '/admin' || p.startsWith('/admin/') || p === '/api/admin' || p.startsWith('/api/admin/')) {
    return 'team-admin';
  }
  return 'team-member';
}

function roleAllows(viewerRole, minRole) {
  return (ROLE_RANK[viewerRole] || 0) >= (ROLE_RANK[minRole] || 0);
}

module.exports = {
  HEADER_NAMES: HDR,
  signViewerHeaders,
  verifyViewerHeaders,
  roleForTeam,
  requiredRoleForPath,
  roleAllows,
  ROLE_RANK,
};
