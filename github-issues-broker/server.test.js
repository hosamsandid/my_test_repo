'use strict';

// Integration test for the broker's request surface (issue #1633): drives the
// real http server against a fake GitHub, exercising viewer-header auth, scope
// resolution, the authorization guards, the label write + refetch, last-used
// persistence, and audit attribution together — the wiring the pure unit tests
// (github-client / scope-store) can't cover on their own.
//
// Env is set BEFORE requiring server.js because the broker reads its config
// (signing secret, state/audit dirs) at module load.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SECRET = 'itest-secret';
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-it-state-'));
const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-it-audit-'));
process.env.AEE_PLUGIN_ID = 'github-issues';
process.env.AEE_PLUGIN_SIGNING_SECRET = SECRET;
process.env.AEE_PLUGIN_STATE_DIR = stateDir;
process.env.AEE_PLUGIN_AUDIT_DIR = auditDir;

const { mint } = require('../broker-sdk');
const { signViewerHeaders } = require('./viewer-headers');

// ── fake GitHub ──────────────────────────────────────────────────────────────
const issues = [
  { number: 5, title: 'Real issue', state: 'open', body: 'hi', labels: [{ name: 'bug', color: 'f00' }], user: { login: 'zoe' } },
  { number: 6, title: 'A PR', state: 'open', pull_request: { url: 'x' }, labels: [] },
];
let addedLabel = false;
const fake = http.createServer((req, res) => {
  const [p] = req.url.split('?');
  const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p === '/repos/acme/widgets/issues') return send(200, issues);
  if (p === '/repos/acme/widgets/issues/5') return send(200, issues[0]);
  if (p === '/repos/acme/widgets/labels') return send(200, [{ name: 'ready', color: '84f5d0' }]);
  if (p === '/repos/acme/widgets/issues/5/labels' && req.method === 'POST') {
    if (!addedLabel) { issues[0].labels.push({ name: 'ready', color: '84f5d0' }); addedLabel = true; }
    return send(200, issues[0].labels);
  }
  return send(404, { message: 'not found' });
});

let broker; let base;
const server = require('./server');

test.before(async () => {
  await new Promise((r) => fake.listen(0, r));
  process.env.GITHUB_API_BASE = `http://127.0.0.1:${fake.address().port}`; // read per-call by github-client
  await new Promise((r) => server.httpServer.listen(0, r));
  broker = server.httpServer;
  base = `http://127.0.0.1:${broker.address().port}`;
});

test.after(async () => {
  await new Promise((r) => broker.close(r));
  await new Promise((r) => fake.close(r));
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(auditDir, { recursive: true, force: true });
});

const viewer = (teamIds) => signViewerHeaders({ sub: 'alice', role: 'team-member', teamIds }, SECRET);

test('the orchestrator pushes per-scope credentials (bearer-authed)', async () => {
  const tok = mint('github-issues', '_internal', SECRET);
  const r = await fetch(`${base}/internal/scope-credentials`, {
    method: 'PUT', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scopes: { 'team-a': { token: 'GH', repos: [{ fullName: 'acme/widgets', defaultBranch: 'main' }], teamName: 'Team A' } } }),
  });
  assert.equal(r.status, 200);
  // an unauthenticated push is refused
  const r2 = await fetch(`${base}/internal/scope-credentials`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r2.status, 401);
});

test('GET /ui/api/context lists the viewer\'s authorized teams + repos (no token leak)', async () => {
  const r = await fetch(`${base}/ui/api/context`, { headers: viewer(['team-a']) });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.teams[0].teamId, 'team-a');
  assert.equal(body.teams[0].teamName, 'Team A');
  assert.equal(body.teams[0].hasToken, true);
  assert.equal(body.teams[0].repos[0].fullName, 'acme/widgets');
  assert.equal(JSON.stringify(body).includes('GH'), false); // token never surfaced
});

test('an unsigned viewer is refused', async () => {
  const r = await fetch(`${base}/ui/api/context`);
  assert.equal(r.status, 401);
});

test('GET /ui/api/issues lists issues and drops pull requests', async () => {
  const r = await fetch(`${base}/ui/api/issues?team=team-a&repo=acme/widgets`, { headers: viewer(['team-a']) });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.issues.length, 1);
  assert.equal(body.issues[0].number, 5);
});

test('authorization guards: repo out of scope → 403, team not signed → 400', async () => {
  const out = await fetch(`${base}/ui/api/issues?team=team-a&repo=acme/secret`, { headers: viewer(['team-a']) });
  assert.equal(out.status, 403);
  const nope = await fetch(`${base}/ui/api/issues?team=team-b&repo=acme/widgets`, { headers: viewer(['team-a']) });
  assert.equal(nope.status, 400);
});

test('POST /ui/api/label adds a label and returns the refreshed issue', async () => {
  const r = await fetch(`${base}/ui/api/label`, {
    method: 'POST', headers: { ...viewer(['team-a']), 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: 'team-a', repo: 'acme/widgets', number: 5, label: 'ready', action: 'add' }),
  });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.issue.labels.some((l) => l.name === 'ready'), true);
});

test('the label write is recorded in the audit log, attributed to the acting user', () => {
  const files = fs.readdirSync(auditDir);
  const text = files.length ? fs.readFileSync(path.join(auditDir, files[0]), 'utf8') : '';
  assert.match(text, /label-add/);
  assert.match(text, /alice/);
});

test('last-used team+repo is persisted per user for pre-selection', () => {
  const prefs = fs.readdirSync(path.join(stateDir, 'prefs'));
  assert.equal(prefs.some((f) => f.startsWith('team-a__alice')), true);
});

test('the agent CLI path (scope-token authed) returns the scope\'s repositories', async () => {
  const tok = mint('github-issues', 'team-a', SECRET);
  const r = await fetch(`${base}/cli/repos`, { headers: { Authorization: `Bearer ${tok}` } });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.repos[0].fullName, 'acme/widgets');
  // a forged/absent token is refused
  const bad = await fetch(`${base}/cli/repos`);
  assert.equal(bad.status, 401);
});

// ── multi-team viewer label writes (#1651) ───────────────────────────────────
// A viewer in ≥2 teams sends the selected team in the JSON body (like the read
// paths send it in the query string). Before the fix the body was never read
// for team resolution, so pickTeam(viewer, null) returned null → HTTP 400
// "select a team you are a member of". These lock in the fixed behaviour.
const multiViewer = signViewerHeaders({ sub: 'alice', role: 'team-member', teamIds: ['team-a', 'team-b'] }, SECRET);

test('#1651 POST /ui/api/label: a multi-team viewer can add a label (team from body)', async () => {
  const r = await fetch(`${base}/ui/api/label`, {
    method: 'POST', headers: { ...multiViewer, 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: 'team-a', repo: 'acme/widgets', number: 5, label: 'ready', action: 'add' }),
  });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.notEqual(body.error, 'select a team you are a member of');
  assert.equal(body.issue.labels.some((l) => l.name === 'ready'), true);
});

test('#1651 POST /ui/api/label: a multi-team viewer can remove a label (team from body)', async () => {
  const r = await fetch(`${base}/ui/api/label`, {
    method: 'POST', headers: { ...multiViewer, 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: 'team-a', repo: 'acme/widgets', number: 5, label: 'bug', action: 'remove' }),
  });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.notEqual(body.error, 'select a team you are a member of');
});

test('#1651 the membership check is not weakened: a body team the viewer does not belong to → 400', async () => {
  const r = await fetch(`${base}/ui/api/label`, {
    method: 'POST', headers: { ...multiViewer, 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: 'team-c', repo: 'acme/widgets', number: 5, label: 'ready', action: 'add' }),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'select a team you are a member of');
});

test('#1651 POST /ui/api/pref: last-used persists for a multi-team viewer (team from body)', async () => {
  const r = await fetch(`${base}/ui/api/pref`, {
    method: 'POST', headers: { ...multiViewer, 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: 'team-a', repo: 'acme/widgets', state: 'open' }),
  });
  assert.equal(r.status, 200);
  const prefs = fs.readdirSync(path.join(stateDir, 'prefs'));
  assert.equal(prefs.some((f) => f.startsWith('team-a__alice')), true);
});
