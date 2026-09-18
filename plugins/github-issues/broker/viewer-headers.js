'use strict';

// ─── viewer-identity header verification (github-issues plugin, #1633) ───────
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
  sig: 'x-aee-plugin-sig',
});

const VIEWER_ROLES = Object.freeze(['team-member', 'team-admin', 'system-admin']);

// `teamRoles` is serialised as `teamId=role` pairs sorted by teamId; only
// in-scope teams with a known role are kept, so the map can never name a team
// the `teams` list does not.
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
  return {
    sub, role, teams, teamRoles,
    canonicalString: `${sub}\n${role}\n${teams.join(',')}\n${teamRoles.join(',')}`,
  };
}

function signViewerHeaders(viewer, secret) {
  if (!secret) throw new Error('signViewerHeaders requires a secret');
  const c = canonical(viewer);
  const sig = crypto.createHmac('sha256', secret).update(c.canonicalString).digest('base64url');
  return {
    [HDR.user]: c.sub,
    [HDR.role]: c.role,
    [HDR.teams]: c.teams.join(','),
    [HDR.teamRoles]: c.teamRoles.join(','),
    [HDR.sig]: sig,
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

// Verify signed viewer headers → { sub, role, teamIds, teamRoles } or null.
// Accepts a raw headers map or a request-like object with `.headers`.
// Constant-time compare + strict length check, matching scope-token.js.
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
  if (typeof sig !== 'string' || !sig) return null;
  const teamIds = typeof teamsRaw === 'string' && teamsRaw.length ? teamsRaw.split(',') : [];
  const teamRoles = parseTeamRoles(teamRolesRaw);
  const signed = signViewerHeaders({ sub, role, teamIds, teamRoles }, secret);
  // The presented map must be exactly what canonicalisation would emit —
  // otherwise a pair the canonical form drops could ride along unsigned.
  if (String(teamRolesRaw || '') !== signed[HDR.teamRoles]) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(signed[HDR.sig]);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { sub: String(sub || ''), role: String(role || ''), teamIds, teamRoles };
}

// The viewer's role in ONE team — what an elevated, team-selecting route must
// gate on. Never elevates: a team outside the viewer's scope is null, and an
// in-scope team with no map entry (an older proxy) is a plain team-member.
function roleForTeam(viewer, teamId) {
  if (!viewer || !Array.isArray(viewer.teamIds) || !viewer.teamIds.includes(teamId)) return null;
  const r = viewer.teamRoles && viewer.teamRoles[teamId];
  return VIEWER_ROLES.includes(r) ? r : 'team-member';
}

// The role gate. This plugin declares a single ui.route ("/", team-member): any
// team member of a granted team may list/read issues and add/remove labels
// (issue #1633 — no team-admin gate on the label actions). So every path needs
// only team-member; the function exists to mirror the netzplan broker's
// second-enforcement shape and to make an added elevated route a one-line change.
const ROLE_RANK = Object.freeze({ 'team-member': 1, 'team-admin': 2, 'system-admin': 3 });

function requiredRoleForPath(_uiPath) {
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
