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
  return { [HDR.user]: c.sub, [HDR.role]: c.role, [HDR.teams]: c.teams.join(','), [HDR.sig]: sig };
}

// Verify signed viewer headers → { sub, role, teamIds } or null. Accepts a raw
// headers map or a request-like object with `.headers`. Constant-time compare +
// strict length check, matching scope-token.js.
function verifyViewerHeaders(headersOrReq, secret) {
  if (!secret) return null;
  const h = headersOrReq && headersOrReq.headers ? headersOrReq.headers : headersOrReq;
  if (!h || typeof h !== 'object') return null;
  const get = (k) => (h[k] != null ? h[k] : h[k.toLowerCase()]);
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
  requiredRoleForPath,
  roleAllows,
  ROLE_RANK,
};
