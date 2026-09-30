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
