'use strict';

// Team-share room sync (#2174, epic #2166 B2 — "Sharing a team invites the
// human into the team's agent rooms").
//
// `POST`/`DELETE /api/admin/memberships` already write the membership itself
// (guarded by `team-share-routes.test.js`); this file covers the NEW behaviour
// layered on top — inviting/removing the shared human's Matrix identity from
// every team member's room — which is expressed as `res.on('finish')` glue in
// api.js (uncovered per #651), so it is asserted against the source the same
// way `human-matrix-send-wiring.test.js` does for the send-path routing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { membersOfTeam } = require('./agent-team-cascade');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function at(src, needle, from = 0) {
  const i = src.indexOf(needle, from);
  assert.ok(i > 0, `expected api.js to contain: ${needle}`);
  return i;
}

test('the sync middleware is mounted after auth.gate and before the memberships routes', () => {
  const authGateAt = at(API_SRC, "app.use('/api', auth.gate);");
  const mountAt = at(API_SRC, "app.use('/api/admin/memberships', (req, res, next) => {", authGateAt);
  const postRouteAt = at(API_SRC, "app.post('/api/admin/memberships',", mountAt);
  const deleteRouteAt = at(API_SRC, "app.delete('/api/admin/memberships',", mountAt);
  assert.ok(authGateAt < mountAt, 'must run after authentication, like every other /api route');
  assert.ok(mountAt < postRouteAt && mountAt < deleteRouteAt, 'must be registered before the routes it watches');
});

test('the middleware never acts on a denied or failed membership write', () => {
  const mountAt = at(API_SRC, "app.use('/api/admin/memberships', (req, res, next) => {");
  const region = API_SRC.slice(mountAt, mountAt + 800);
  assert.match(region, /res\.on\('finish', \(\) => \{/, 'reacts to the real final response, not the route body');
  assert.match(region, /if \(res\.statusCode >= 400\) return;/);
});

test('a POST invites using the body teamId/userId; a DELETE removes using the query teamId/userId', () => {
  const mountAt = at(API_SRC, "app.use('/api/admin/memberships', (req, res, next) => {");
  const region = API_SRC.slice(mountAt, mountAt + 800);
  assert.match(region, /req\.method === 'POST'/);
  assert.match(region, /shared\.teamId && shared\.userId\) syncSharedMemberRooms\(shared\.teamId, shared\.userId, 'invite'\)/);
  assert.match(region, /req\.method === 'DELETE'/);
  assert.match(region, /unshared\.teamId && unshared\.userId\) syncSharedMemberRooms\(unshared\.teamId, unshared\.userId, 'remove'\)/);
  // POST reads its pair from the body, DELETE from the query — same split the
  // routes themselves use, and for the same reason (`team-share-routes.test.js`).
  const sharedAt = at(region, 'const shared = req.body || {};');
  const unsharedAt = at(region, 'const unshared = req.query || {};');
  assert.ok(sharedAt < unsharedAt);
});

test('syncSharedMemberRooms only ever targets the team\'s materialized team-members', () => {
  const fnAt = at(API_SRC, 'function syncSharedMemberRooms(teamId, userId, action) {');
  const region = API_SRC.slice(fnAt, fnAt + 1800);
  assert.match(region, /membersOfTeam\(configs, teamId\)\.map\(m => m\.id\)/, 'reuses the shared team/tenant helper — no second definition of "who is on this team"');
  assert.match(region, /matrix\.getAgentDmRoom\(memberId\)/, 'skips a member with no DM room yet, rather than failing');
  assert.doesNotMatch(region, /cfg\.role === 'team'/, 'a role:"team" agent hosts no chat/room of its own and must never be targeted');
});

test('the invite branch reuses the #2173 join primitive; the remove branch kicks the human out', () => {
  const fnAt = at(API_SRC, 'function syncSharedMemberRooms(teamId, userId, action) {');
  const region = API_SRC.slice(fnAt, fnAt + 1800);
  assert.match(region, /await ensureHumanJoinedToRoom\(identity, dm\.roomId\);/, 'no second invite+join implementation');
  assert.match(region, /rooms\/\$\{encodeURIComponent\(dm\.roomId\)\}\/kick`,\s*\n\s*\{ method: 'POST', body: \{ user_id: identity\.matrixUserId/);
});

test('a human with no provisioned Matrix identity is silently skipped (#1458 discipline)', () => {
  const fnAt = at(API_SRC, 'function syncSharedMemberRooms(teamId, userId, action) {');
  const region = API_SRC.slice(fnAt, fnAt + 600);
  assert.match(region, /const identity = humanMatrixStore\.readIdentity\(userId\);/);
  assert.match(region, /if \(!identity \|\| !identity\.matrixUserId\) return;/);
});

test('a per-member failure is caught and logged, never thrown back at the caller', () => {
  const fnAt = at(API_SRC, 'function syncSharedMemberRooms(teamId, userId, action) {');
  const region = API_SRC.slice(fnAt, fnAt + 1800);
  assert.match(region, /\} catch \(err\) \{\s*\n\s*console\.error\(`\[API\] Failed to \$\{action\}/);
  assert.match(region, /\}\)\.catch\(\(err\) => \{\s*\n\s*console\.error\(`\[API\] syncSharedMemberRooms/, 'the whole background task is caught too, so it can never become an unhandled rejection');
});

/* ── The pure "who is on this team" helper the sync reuses ──────────────── */

test('membersOfTeam is the single source of truth the sync depends on', () => {
  const configs = [
    { id: 'squad-a', role: 'team' },
    { id: 'squad-a-dev', role: 'team-member', parentTeamId: 'squad-a' },
    { id: 'squad-a-reviewer', role: 'team-member', parentTeamId: 'squad-a' },
    { id: 'squad-a-dev-stub', role: 'team-member', parentTeamId: 'squad-a' },
    { id: 'other-standalone', role: 'agent' },
  ];
  const ids = membersOfTeam(configs, 'squad-a').map(c => c.id);
  assert.deepEqual(ids, ['squad-a-dev', 'squad-a-reviewer', 'squad-a-dev-stub']);
  assert.equal(ids.includes('squad-a'), false, 'the team agent itself is never a target — it has no room');
  assert.equal(ids.includes('other-standalone'), false);
});
