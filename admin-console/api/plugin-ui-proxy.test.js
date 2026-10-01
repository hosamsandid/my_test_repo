'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  deriveScopeList,
  enforceUiRoute,
  matchRoute,
  signViewerHeaders,
  verifyViewerHeaders,
  HEADER_NAMES,
  labelTargetKindFromHeaders,
} = require('./plugin-ui-proxy');

// ── scope discovery (derived from the resolved grant) ───────────────────────

test('team-granularity members collapse to one team scope', () => {
  const scopes = deriveScopeList([
    { agentId: 'alpha-dev', parentTeamId: 'alpha', scopeGranularity: 'team' },
    { agentId: 'alpha-rev', parentTeamId: 'alpha', scopeGranularity: 'team' },
  ], { teams: { alpha: 'Team Alpha' } });
  assert.equal(scopes.length, 1);
  assert.deepEqual(scopes[0], { scopeId: 'alpha', kind: 'team', displayName: 'Team Alpha', teamId: 'alpha' });
});

test('agent-granularity yields one scope per granted agent', () => {
  const scopes = deriveScopeList([
    { agentId: 'alpha-dev', parentTeamId: 'alpha', scopeGranularity: 'agent', agentName: 'Dev' },
    { agentId: 'alpha-qa', parentTeamId: 'alpha', scopeGranularity: 'agent' },
  ], { agents: { 'alpha-qa': 'QA' } });
  assert.equal(scopes.length, 2);
  assert.deepEqual(scopes.map((s) => s.scopeId).sort(), ['alpha-dev', 'alpha-qa']);
  assert.equal(scopes.find((s) => s.scopeId === 'alpha-dev').displayName, 'Dev');
  assert.equal(scopes.find((s) => s.scopeId === 'alpha-qa').displayName, 'QA');
  assert.ok(scopes.every((s) => s.kind === 'agent' && s.teamId === 'alpha'));
});

test('standalone agent (no team) resolves team-granularity to its own id', () => {
  const scopes = deriveScopeList([{ agentId: 'solo', scopeGranularity: 'team' }]);
  assert.deepEqual(scopes, [{ scopeId: 'solo', kind: 'team', displayName: 'solo', teamId: 'solo' }]);
});

test('the acceptance invariant: only granted scopes are enumerated', () => {
  // Only team alpha is granted; team beta's members are absent from the input
  // and therefore can never appear in the list.
  const scopes = deriveScopeList([
    { agentId: 'alpha-dev', parentTeamId: 'alpha', scopeGranularity: 'team' },
  ], { teams: { alpha: 'Alpha', beta: 'Beta' } });
  assert.deepEqual(scopes.map((s) => s.scopeId), ['alpha']);
  assert.equal(scopes.some((s) => s.teamId === 'beta'), false);
});

test('deriveScopeList ignores malformed entries', () => {
  const scopes = deriveScopeList([null, 3, {}, { scopeGranularity: 'agent' }, { agentId: 'x', scopeGranularity: 'agent' }]);
  assert.deepEqual(scopes.map((s) => s.scopeId), ['x']);
});

// ── ui.routes minRole enforcement ───────────────────────────────────────────

const MANIFEST = {
  ui: {
    routes: [
      { path: '/', minRole: 'team-member' },
      { path: '/runs', minRole: 'team-member' },
      { path: '/admin', minRole: 'team-admin' },
    ],
  },
};

test('matchRoute picks the most specific declared route', () => {
  assert.equal(matchRoute(MANIFEST.ui.routes, '/admin/users').path, '/admin');
  assert.equal(matchRoute(MANIFEST.ui.routes, '/runs').path, '/runs');
  assert.equal(matchRoute(MANIFEST.ui.routes, '/whatever').path, '/'); // root governs the rest
});

test('a team-member is refused the admin route by the console', () => {
  const r = enforceUiRoute(MANIFEST, '/admin', 'team-member');
  assert.equal(r.allowed, false);
  assert.equal(r.minRole, 'team-admin');
  assert.match(r.reason, /requires team-admin/);
});

test('a team-admin is allowed the admin route; a team-member is allowed the working route', () => {
  assert.equal(enforceUiRoute(MANIFEST, '/admin', 'team-admin').allowed, true);
  assert.equal(enforceUiRoute(MANIFEST, '/runs', 'team-member').allowed, true);
  assert.equal(enforceUiRoute(MANIFEST, '/admin/config', 'system-admin').allowed, true);
});

test('an unknown viewer role is refused', () => {
  assert.equal(enforceUiRoute(MANIFEST, '/', 'stranger').allowed, false);
});

test('routes declared but none governing the path → refused (no implicit open)', () => {
  const m = { ui: { routes: [{ path: '/admin', minRole: 'team-admin' }] } };
  const r = enforceUiRoute(m, '/', 'system-admin');
  assert.equal(r.allowed, false);
  assert.match(r.reason, /no ui.route declared/);
});

test('a UI with no declared routes falls back to a team-member minimum', () => {
  assert.equal(enforceUiRoute({}, '/anything', 'team-member').allowed, true);
  assert.equal(enforceUiRoute({}, '/anything', 'nobody').allowed, false);
});

// ── signed viewer headers ───────────────────────────────────────────────────

test('signed viewer headers round-trip', () => {
  const secret = 's3cr3t';
  const headers = signViewerHeaders({ sub: 'alice', role: 'team-admin', teamIds: ['beta', 'alpha'] }, secret);
  assert.equal(headers[HEADER_NAMES.user], 'alice');
  assert.equal(headers[HEADER_NAMES.role], 'team-admin');
  const v = verifyViewerHeaders(headers, secret);
  assert.equal(v.sub, 'alice');
  assert.equal(v.role, 'team-admin');
  assert.deepEqual(v.teamIds.sort(), ['alpha', 'beta']);
});

test('a tampered role fails verification', () => {
  const secret = 's3cr3t';
  const headers = signViewerHeaders({ sub: 'alice', role: 'team-member', teamIds: ['alpha'] }, secret);
  headers[HEADER_NAMES.role] = 'system-admin';   // privilege escalation attempt
  assert.equal(verifyViewerHeaders(headers, secret), null);
});

test('a wrong secret fails verification', () => {
  const headers = signViewerHeaders({ sub: 'alice', role: 'team-member', teamIds: [] }, 'right');
  assert.equal(verifyViewerHeaders(headers, 'wrong'), null);
});

test('verifyViewerHeaders accepts a request-like object and is teamId-order-independent', () => {
  const secret = 'k';
  const headers = signViewerHeaders({ sub: 'bob', role: 'team-member', teamIds: ['b', 'a', 'a'] }, secret);
  const v = verifyViewerHeaders({ headers }, secret);
  assert.deepEqual(v.teamIds, ['a', 'b']);   // sorted + deduped
});

// ── per-team roles (F4 of the Jira review) ──────────────────────────────────
//
// A flattened `role` (the caller's MAX across granted teams) plus a team list
// cannot express "Team Admin of A, Team Member of B". A broker that lets the
// request choose the team (`?team=B`) and gates `/admin` on the flat role hands
// U admin rights over B. The proxy therefore also signs a per-team role map;
// `role` stays the max for team-agnostic routes and page loads.

const { roleForTeam } = require('./plugin-ui-proxy');

test('per-team roles round-trip and are part of the signature', () => {
  const secret = 's3cr3t';
  const headers = signViewerHeaders({
    sub: 'u', role: 'team-admin', teamIds: ['B', 'A'],
    teamRoles: { A: 'team-admin', B: 'team-member' },
  }, secret);
  assert.equal(headers[HEADER_NAMES.teamRoles], 'A=team-admin,B=team-member'); // sorted by team
  const v = verifyViewerHeaders(headers, secret);
  assert.deepEqual(v.teamRoles, { A: 'team-admin', B: 'team-member' });
  assert.equal(roleForTeam(v, 'A'), 'team-admin');
  assert.equal(roleForTeam(v, 'B'), 'team-member');
  assert.equal(roleForTeam(v, 'C'), null); // not in scope at all
});

test('tampering the per-team role map fails verification (the escalation this closes)', () => {
  const secret = 's3cr3t';
  const headers = signViewerHeaders({
    sub: 'u', role: 'team-admin', teamIds: ['A', 'B'],
    teamRoles: { A: 'team-admin', B: 'team-member' },
  }, secret);
  headers[HEADER_NAMES.teamRoles] = 'A=team-admin,B=team-admin';
  assert.equal(verifyViewerHeaders(headers, secret), null);
  // …and dropping the header entirely is not a way back to the flat role.
  const stripped = { ...headers };
  delete stripped[HEADER_NAMES.teamRoles];
  assert.equal(verifyViewerHeaders(stripped, secret), null);
});

test('roleForTeam never elevates: an in-scope team with no map entry is a plain team-member', () => {
  const v = { sub: 'u', role: 'system-admin', teamIds: ['A'], teamRoles: {} };
  assert.equal(roleForTeam(v, 'A'), 'team-member');
  assert.equal(roleForTeam({ sub: 'u', role: 'team-admin', teamIds: ['A'] }, 'A'), 'team-member');
  assert.equal(roleForTeam(null, 'A'), null);
});

test('the map is canonical: order-independent, unknown roles and out-of-scope teams dropped', () => {
  const secret = 'k';
  const a = signViewerHeaders({ sub: 'u', role: 'team-member', teamIds: ['A', 'B'], teamRoles: { B: 'team-member', A: 'team-member', Z: 'team-admin', A2: 'bogus' } }, secret);
  const b = signViewerHeaders({ sub: 'u', role: 'team-member', teamIds: ['B', 'A'], teamRoles: { A: 'team-member', B: 'team-member' } }, secret);
  assert.equal(a[HEADER_NAMES.sig], b[HEADER_NAMES.sig]);
  assert.equal(a[HEADER_NAMES.teamRoles], 'A=team-member,B=team-member');
});

// ── versioned signature / grace period (regression guard) ───────────────────
//
// Adding the per-team map changed what is signed. A broker whose image predates
// the change verifies the OLD three-field HMAC. If the proxy stopped emitting a
// signature that broker accepts, every proxied request to an un-rebuilt UI
// plugin (github-issues, netzplan, patterns-catalog, gke) would 401 until its
// sidecar is recreated. These pin the two-signature grace period that avoids it.

const crypto = require('node:crypto');

test('the v1 sig is byte-identical to the pre-map three-field HMAC (un-rebuilt brokers keep verifying it)', () => {
  const secret = 's3cr3t';
  const headers = signViewerHeaders(
    { sub: 'u', role: 'team-admin', teamIds: ['b', 'a'], teamRoles: { a: 'team-admin' } },
    secret,
  );
  // Exactly what a broker built before the role map existed computes.
  const legacySig = crypto.createHmac('sha256', secret).update('u\nteam-admin\na,b').digest('base64url');
  assert.equal(headers[HEADER_NAMES.sig], legacySig);
  // v2 is present, distinct, and covers the map — new brokers prefer it.
  assert.ok(headers[HEADER_NAMES.sigV2]);
  assert.notEqual(headers[HEADER_NAMES.sig], headers[HEADER_NAMES.sigV2]);
});

test('a legacy v1-only request (no v2, no role-map header) still verifies, with an empty map', () => {
  const secret = 'k';
  const sub = 'u';
  const role = 'team-admin';
  const teams = ['a', 'b'];
  const sig = crypto.createHmac('sha256', secret).update(`${sub}\n${role}\n${teams.join(',')}`).digest('base64url');
  const legacy = {
    [HEADER_NAMES.user]: sub,
    [HEADER_NAMES.role]: role,
    [HEADER_NAMES.teams]: teams.join(','),
    [HEADER_NAMES.sig]: sig, // no x-aee-plugin-sig-v2, no x-aee-plugin-team-roles
  };
  const v = verifyViewerHeaders(legacy, secret);
  assert.deepEqual(v, { sub, role, teamIds: ['a', 'b'], teamRoles: {} });
});

// ── bodyWasParsed: re-serialise a consumed JSON body (Express 4 and 5) ───────

test('bodyWasParsed: Express 4 flags a parsed body with req._body', () => {
  const { bodyWasParsed } = require('./plugin-ui-proxy');
  assert.equal(bodyWasParsed({ _body: true, body: { a: 1 }, readableEnded: true }), true);
});

test('bodyWasParsed: Express 5 has no _body flag — a read-to-end stream with a body counts', async () => {
  const { bodyWasParsed } = require('./plugin-ui-proxy');
  const { Readable } = require('node:stream');
  const req = Readable.from([Buffer.from('{"watches":[{"projectKey":"KAN"}]}')]);
  for await (const _chunk of req) { /* what express.json() does */ }
  req.body = { watches: [{ projectKey: 'KAN' }] };
  assert.equal(req._body, undefined);
  assert.equal(bodyWasParsed(req), true);
});

test('bodyWasParsed: an unread stream is streamed through, even with body-parser 1\'s default {}', () => {
  const { bodyWasParsed } = require('./plugin-ui-proxy');
  const { Readable } = require('node:stream');
  const req = Readable.from([Buffer.from('raw bytes')]);
  req.body = {}; // body-parser 1 sets this for a content type it skipped
  assert.equal(bodyWasParsed(req), false);
  assert.equal(bodyWasParsed({ body: undefined, readableEnded: true }), false); // Express 5, no parser ran
  assert.equal(bodyWasParsed(null), false);
});

// Source guard: pluginUiProxy (api.js) must decide re-serialisation with
// bodyWasParsed — a bare `req._body === true` is false under Express 5, the
// proxy then streams an already-read request and the sidecar gets an empty body
// (saving the Jira Watch config page wiped the team's watches).
test('pluginUiProxy re-serialises the body via bodyWasParsed(req), not req._body', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const start = src.indexOf('function pluginUiProxy(req, res)');
  assert.ok(start > 0, 'pluginUiProxy not found in api.js');
  const end = src.indexOf('\nfunction ', start + 1);
  const body = src.slice(start, end > start ? end : undefined);
  assert.match(body, /const parsedBody = bodyWasParsed\(req\);/);
  assert.doesNotMatch(body, /req\._body\s*===/);
});

// ── label fast-path kind (#2746) ────────────────────────────────────────────

test('labelTargetKindFromHeaders: the broker\'s pr report wakes pull_request.labeled listeners', () => {
  assert.equal(labelTargetKindFromHeaders({ 'x-aee-label-target-kind': 'pr' }), 'pr');
  assert.equal(labelTargetKindFromHeaders({ 'x-aee-label-target-kind': ' PR ' }), 'pr');
  assert.equal(labelTargetKindFromHeaders({ 'x-aee-label-target-kind': ['pr'] }), 'pr');
});

test('labelTargetKindFromHeaders: issue, a missing header (older broker) or junk degrade to issue', () => {
  assert.equal(labelTargetKindFromHeaders({ 'x-aee-label-target-kind': 'issue' }), 'issue');
  assert.equal(labelTargetKindFromHeaders({}), 'issue');
  assert.equal(labelTargetKindFromHeaders(undefined), 'issue');
  assert.equal(labelTargetKindFromHeaders({ 'x-aee-label-target-kind': 'pull_request' }), 'issue');
});

test('api.js passes the broker-reported kind to the fast path, never a hard-coded issue (#2746)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'api.js'), 'utf8');
  const call = src.slice(src.indexOf('notifyGithubLabelApplied({\n'), src.indexOf('res.status(up.statusCode || 502)'));
  assert.match(call, /kind: labelTargetKindFromHeaders\(up\.headers\)/);
  assert.doesNotMatch(call, /kind: 'issue'/);
});
