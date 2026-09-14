'use strict';

// Source-reading guard for the pool-control proxy routes (#2250 Phase 5,
// epic #2251). api.js is a 15k-line Express app that cannot be imported in a
// unit test, so these are read off the source — the same technique
// `orphan-routes.test.js` uses.
//
// The property that needs a guard: the two MUTATING routes (pause/resume/
// drain a role, force-dispatch a held ticket) must gate on `canManageTeam`,
// not merely `visibleTeam` — unlike their read-only sibling `pool-control`
// GET and the pre-existing `tickets`/`flow-anomalies` GETs, which are
// visibility-only by design (observing the board is the same "can you see
// this team" question every other panel already answers). Getting this wrong
// would let anyone who can merely SEE a team pause its roles or jump its WIP
// queue.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAW_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
// Comments name the very properties under test (e.g. the POST route's own
// header explains it needs `canManageTeam`); strip them first so a slice
// bounded by "the next route" cannot accidentally swallow the FOLLOWING
// route's leading comment and pass on prose rather than code.
const SRC = RAW_SRC
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
  .replace(/^[ \t]*\/\/[^\n]*$/gm, '');

function routeBody(marker, nextMarker) {
  const start = SRC.indexOf(marker);
  assert.ok(start >= 0, `api.js should contain ${marker}`);
  const end = nextMarker ? SRC.indexOf(nextMarker, start) : start + 2000;
  assert.ok(end > start, `could not bound the route body for ${marker}`);
  return SRC.slice(start, end);
}

test('GET /api/teams/:teamId/pool-control is visibility-only, like tickets/flow-anomalies', () => {
  const body = routeBody(
    "app.get('/api/teams/:teamId/pool-control'",
    "app.post('/api/teams/:teamId/pool-control/:roleId'",
  );
  assert.match(body, /AGENT_ID_RE\.test\(teamId\)/);
  assert.match(body, /visibleTeam\(scope, teamId\)/);
  assert.doesNotMatch(body, /canManageTeam/, 'the read must not require management rights');
  assert.match(body, /\/internal\/teams\/\$\{encodeURIComponent\(teamId\)\}\/pool-control`/);
});

test('POST /api/teams/:teamId/pool-control/:roleId is gated on canManageTeam, and validates both ids', () => {
  const body = routeBody(
    "app.post('/api/teams/:teamId/pool-control/:roleId'",
    "app.post('/api/teams/:teamId/force-dispatch'",
  );
  assert.match(body, /AGENT_ID_RE\.test\(teamId\)/);
  assert.match(body, /AGENT_ID_RE\.test\(roleId\)/);
  assert.match(body, /canManageTeam\(scope, teamId\)/);
  assert.match(body, /denyAdmin\(res, 'You may not manage this team'\)/);
});

test('POST /api/teams/:teamId/force-dispatch is gated on canManageTeam and requires an id', () => {
  const body = routeBody(
    "app.post('/api/teams/:teamId/force-dispatch'",
    "app.get('/api/teams/:teamId/hill-climb/metrics'",
  );
  assert.match(body, /AGENT_ID_RE\.test\(teamId\)/);
  assert.match(body, /canManageTeam\(scope, teamId\)/);
  assert.match(body, /if \(!id\) return res\.status\(400\)/);
});

test('mutation-proved: a canManageTeam check downgraded to visibleTeam would fail the gate check above', () => {
  const body = routeBody(
    "app.post('/api/teams/:teamId/pool-control/:roleId'",
    "app.post('/api/teams/:teamId/force-dispatch'",
  );
  const buggy = body.replace('canManageTeam(scope, teamId)', 'visibleTeam(scope, teamId)');
  assert.doesNotMatch(buggy, /canManageTeam\(scope, teamId\)/);
});
