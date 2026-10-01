'use strict';

// Source-reading guard for the Flow Control board proxy routes (#2573) — the
// `pool-control-routes.test.js` technique (api.js cannot be imported in a unit
// test). The board READ is visibility-only like `tickets`; the column
// configuration WRITE changes what every viewer sees, so it needs
// `canManageTeam`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
  .replace(/^[ \t]*\/\/[^\n]*$/gm, '');

function routeBody(marker, nextMarker) {
  const start = SRC.indexOf(marker);
  assert.ok(start >= 0, `api.js should contain ${marker}`);
  const end = SRC.indexOf(nextMarker, start + 1);
  assert.ok(end > start, `could not bound the route body for ${marker}`);
  return SRC.slice(start, end);
}

test('GET /api/teams/:teamId/flow-board is visibility-only and forwards refresh', () => {
  const body = routeBody("app.get('/api/teams/:teamId/flow-board'", "app.post('/api/teams/:teamId/flow-board-config'");
  assert.match(body, /AGENT_ID_RE\.test\(teamId\)/);
  assert.match(body, /if \(!visibleTeam\(scope, teamId\)\) return res\.status\(404\)/);
  assert.match(body, /refresh=1/);
  assert.match(body, /\/internal\/teams\/\$\{encodeURIComponent\(teamId\)\}\/flow-board\$\{qs\}`/);
  // `canManage` is reported, never required.
  assert.match(body, /data\.canManage = !!canManageTeam\(scope, teamId\)/);
  assert.doesNotMatch(body, /denyAdmin/);
});

test('POST /api/teams/:teamId/flow-board-config is gated on canManageTeam', () => {
  const body = routeBody("app.post('/api/teams/:teamId/flow-board-config'", 'app.');
  assert.match(body, /AGENT_ID_RE\.test\(teamId\)/);
  assert.match(body, /if \(!canManageTeam\(scope, teamId\)\) return denyAdmin\(res, 'You may not manage this team'\)/);
  assert.match(body, /\/flow-board-config`/);
});

test('POST /api/teams/:teamId/flow-board-removed is gated on canManageTeam and validates its body (#2637)', () => {
  const body = routeBody("app.post('/api/teams/:teamId/flow-board-removed'", 'app.');
  assert.match(body, /AGENT_ID_RE\.test\(teamId\)/);
  assert.match(body, /if \(!canManageTeam\(scope, teamId\)\) return denyAdmin\(res, 'You may not manage this team'\)/);
  assert.match(body, /action !== 'remove' && action !== 'restore'/);
  assert.match(body, /\/flow-board-removed`/);
});

test('POST /api/teams/:teamId/flow-board-release is gated on canManageTeam and stamps the session user (#2754)', () => {
  const body = routeBody("app.post('/api/teams/:teamId/flow-board-release'", 'app.');
  assert.match(body, /AGENT_ID_RE\.test\(teamId\)/);
  assert.match(body, /if \(!canManageTeam\(scope, teamId\)\) return denyAdmin\(res, 'You may not manage this team'\)/);
  assert.match(body, /rowId\.length > 300/);
  assert.match(body, /const actor = \(req\.user && \(req\.user\.username \|\| req\.user\.email \|\| req\.user\.sub\)\) \|\| null;/);
  // The actor never comes from the request body.
  assert.doesNotMatch(body, /req\.body\.actor|req\.body && req\.body\.actor/);
  assert.match(body, /body: JSON\.stringify\(\{ rowId, actor \}\)/);
  assert.match(body, /\/flow-board-release`/);
});

test('both live graph endpoints pass a switched-off agent through as enabled: false (#2754)', () => {
  // Without it the `wake-label-no-live-consumer` lint never fires on a live team.
  for (const marker of ["app.get('/api/process/graph'", "app.get('/api/flows/graph'"]) {
    const route = routeBody(marker, '\napp.');
    assert.match(route, /\.\.\.\(cfg\.enabled === false \? \{ enabled: false \} : \{\}\),/, marker);
  }
});
