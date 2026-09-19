'use strict';

// The board UI's role gate must be judged on the SELECTED scope's role, not on
// the viewer's flat (max-across-teams) role — F4 of the Jira review, which the
// netzplan broker shares: `scopeForViewer` picks the first in-scope team, and
// `/admin`, `/api/settings`, `/api/import` used to be gated on the flat role.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'netzplan-ui-'));
process.env.NETZPLAN_BROKER_SIGNING_SECRET = 'test-secret';
process.env.NETZPLAN_STATE_DIR = STATE;
process.env.NETZPLAN_AUDIT_DIR = path.join(STATE, 'audit');
process.env.AEE_PLUGIN_AUDIT_DIR = path.join(STATE, 'audit');

const broker = require('./server');
const { signViewerHeaders } = require('./viewer-headers');

function listen() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      broker.handleRequest(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
async function call(srv, method, urlPath, headers, body) {
  const { port } = srv.address();
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('ui: an elevated route is gated on the selected scope\'s role, not the flat max', async () => {
  const srv = await listen();
  // `a-team` sorts first, so it is the scope the board serves. U is only a
  // member there — and admin of `b-team`, which is what the flat role says.
  const u = signViewerHeaders({
    sub: 'u', role: 'team-admin', teamIds: ['a-team', 'b-team'],
    teamRoles: { 'a-team': 'team-member', 'b-team': 'team-admin' },
  }, 'test-secret');
  try {
    assert.equal((await call(srv, 'GET', '/ui/api/board', u)).status, 200); // team-member read
    assert.equal((await call(srv, 'POST', '/ui/api/settings', u, { agentAutonomy: 2 })).status, 403);
    assert.equal((await call(srv, 'POST', '/ui/api/import', u, { panels: [] })).status, 403);
    // a real admin of the served scope
    const admin = signViewerHeaders({ sub: 'x', role: 'team-admin', teamIds: ['a-team'], teamRoles: { 'a-team': 'team-admin' } }, 'test-secret');
    assert.equal((await call(srv, 'POST', '/ui/api/settings', admin, { agentAutonomy: 2 })).status, 200);
    // an older proxy's header (no per-team map) never elevates
    const legacy = signViewerHeaders({ sub: 'x', role: 'team-admin', teamIds: ['a-team'] }, 'test-secret');
    assert.equal((await call(srv, 'POST', '/ui/api/settings', legacy, { agentAutonomy: 1 })).status, 403);
  } finally { srv.close(); }
});
