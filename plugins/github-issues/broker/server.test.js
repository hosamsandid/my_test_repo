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

const { mint } = require('../../../broker-sdk');
const { signViewerHeaders } = require('./viewer-headers');

// ── fake GitHub ──────────────────────────────────────────────────────────────
const issues = [
  { number: 5, title: 'Real issue', state: 'open', body: 'hi', labels: [{ name: 'bug', color: 'f00' }], user: { login: 'zoe' } },
  { number: 6, title: 'A PR', state: 'open', pull_request: { url: 'x' }, labels: [] },
];
let addedLabel = false;
let lastSearchQ = '';
const fake = http.createServer((req, res) => {
  const [p] = req.url.split('?');
  const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p === '/repos/acme/widgets/issues') return send(200, issues);
  if (p === '/search/issues') {
    // echo the decoded q back so the test can assert the broker built the
    // repo/title/type qualifiers; return the (non-PR) issue as a match.
    const q = new URLSearchParams(req.url.split('?')[1] || '').get('q') || '';
    lastSearchQ = q;
    return send(200, { total_count: 1, incomplete_results: false, items: [issues[0]] });
  }
  if (p === '/repos/acme/widgets/issues/5') return send(200, issues[0]);
  if (p === '/repos/acme/widgets/issues/6') return send(200, issues[1]);
  if (p === '/repos/acme/widgets/issues/6/labels' && req.method === 'POST') {
    if (!issues[1].labels.some((l) => l.name === 'spec-approved')) issues[1].labels.push({ name: 'spec-approved' });
    return send(200, issues[1].labels);
  }
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

test('GET /ui/api/issues?type=prs lists pull requests, type=all lists both (#2746)', async () => {
  const prs = await (await fetch(`${base}/ui/api/issues?team=team-a&repo=acme/widgets&type=prs`, { headers: viewer(['team-a']) })).json();
  assert.deepEqual(prs.issues.map((i) => i.number), [6]);
  assert.equal(prs.issues[0].isPullRequest, true);
  const all = await (await fetch(`${base}/ui/api/issues?team=team-a&repo=acme/widgets&type=all`, { headers: viewer(['team-a']) })).json();
  assert.deepEqual(all.issues.map((i) => i.number), [5, 6]);
});

test('GET /ui/api/search?type=prs searches pull requests (#2746)', async () => {
  const r = await fetch(`${base}/ui/api/search?team=team-a&repo=acme/widgets&state=open&type=prs&q=x`, { headers: viewer(['team-a']) });
  assert.equal(r.status, 200);
  assert.match(lastSearchQ, /^x repo:acme\/widgets type:pr in:title state:open$/);
});

test('POST /ui/api/label reports the target kind for the #1858 fast path: pr for a PR, issue for an issue (#2746)', async () => {
  const pr = await fetch(`${base}/ui/api/label`, {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, viewer(['team-a'])),
    body: JSON.stringify({ team: 'team-a', repo: 'acme/widgets', number: 6, label: 'spec-approved', action: 'add' }),
  });
  assert.equal(pr.status, 200);
  assert.equal(pr.headers.get('x-aee-label-target-kind'), 'pr');
  assert.equal((await pr.json()).issue.labels.some((l) => l.name === 'spec-approved'), true);
  const issue = await fetch(`${base}/ui/api/label`, {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, viewer(['team-a'])),
    body: JSON.stringify({ team: 'team-a', repo: 'acme/widgets', number: 5, label: 'ready', action: 'add' }),
  });
  assert.equal(issue.status, 200);
  assert.equal(issue.headers.get('x-aee-label-target-kind'), 'issue');
});

test('GET /ui/api/search runs a repo/title-scoped server-side search (#1658)', async () => {
  const r = await fetch(`${base}/ui/api/search?team=team-a&repo=acme/widgets&state=open&q=${encodeURIComponent('real')}`, { headers: viewer(['team-a']) });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.issues.length, 1);
  assert.equal(body.issues[0].number, 5);
  assert.equal(body.page, 1);
  assert.equal(body.totalCount, 1);
  // the broker owns the qualifiers — user text leads, repo/title/type are added
  assert.match(lastSearchQ, /^real repo:acme\/widgets type:issue in:title state:open$/);
});

test('GET /ui/api/search neutralises a user-typed qualifier (no scope escape, #1658)', async () => {
  const r = await fetch(`${base}/ui/api/search?team=team-a&repo=acme/widgets&state=all&q=${encodeURIComponent('repo:other/z')}`, { headers: viewer(['team-a']) });
  assert.equal(r.status, 200);
  // the injected repo: is defused (colon stripped) and the broker's own
  // repo:acme/widgets is the only repo qualifier; state:all drops the state term
  assert.match(lastSearchQ, /repo other\/z repo:acme\/widgets type:issue in:title$/);
  assert.equal(/state:/.test(lastSearchQ), false);
});

test('GET /ui/api/search enforces the repo authorization guard', async () => {
  const out = await fetch(`${base}/ui/api/search?team=team-a&repo=acme/secret&q=x`, { headers: viewer(['team-a']) });
  assert.equal(out.status, 403);
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

test('GET /ui/api/labels returns the team flow labels + per-repo trigger preview (#1642)', async () => {
  // Re-push a full scope map that also carries flowLabels + labelAgents (setCredentials
  // replaces the whole map, so it must still include the token + repo).
  const tok = mint('github-issues', '_internal', SECRET);
  await fetch(`${base}/internal/scope-credentials`, {
    method: 'PUT', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scopes: { 'team-a': {
      token: 'GH', repos: [{ fullName: 'acme/widgets', defaultBranch: 'main' }], teamName: 'Team A',
      flowLabels: ['ready', 'ready-for-review'],
      labelAgents: { 'acme/widgets': { 'ready-for-review': ['Code Reviewer', 'Security Reviewer'] } },
      labelUsage: { ready: 'humanGate', 'ready-for-review': 'agentEmitted' },
    } } }),
  });
  const r = await fetch(`${base}/ui/api/labels?team=team-a&repo=acme/widgets`, { headers: viewer(['team-a']) });
  const body = await r.json();
  assert.equal(r.status, 200);
  // flow labels come through, ahead of the fetched repo labels
  assert.deepEqual(body.flowLabels, ['ready', 'ready-for-review']);
  assert.equal(body.repoLabels.some((l) => l.name === 'ready'), true);
  // the per-repo trigger preview names both waking agents (AC6–8)
  assert.deepEqual(body.labelAgents['ready-for-review'], ['Code Reviewer', 'Security Reviewer']);
  // the per-label usage classification drives the trigger-button colour-coding (#1730)
  assert.deepEqual(body.labelUsage, { ready: 'humanGate', 'ready-for-review': 'agentEmitted' });
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

test('GET /ui/api/context restores the most-recently-used team + each team\'s own last view (#1650)', async () => {
  // two authorized teams with credentials pushed (replaces the map; team-a kept)
  const tok = mint('github-issues', '_internal', SECRET);
  await fetch(`${base}/internal/scope-credentials`, {
    method: 'PUT', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scopes: {
      'team-a': { token: 'GH', repos: [{ fullName: 'acme/widgets' }], teamName: 'Team A' },
      'team-b': { token: 'GH', repos: [{ fullName: 'acme/gadgets' }], teamName: 'Team B' },
    } }),
  });
  // carol used team-a first, then team-b (later) with state 'all'
  server.store.savePref('team-a', 'carol', { repo: 'acme/widgets', state: 'closed', updatedAt: '2026-01-01T00:00:00Z' });
  server.store.savePref('team-b', 'carol', { repo: 'acme/gadgets', state: 'all', type: 'prs', updatedAt: '2026-07-01T00:00:00Z' });

  const headers = signViewerHeaders({ sub: 'carol', role: 'team-member', teamIds: ['team-a', 'team-b'] }, SECRET);
  const r = await fetch(`${base}/ui/api/context`, { headers });
  const body = await r.json();
  assert.equal(r.status, 200);
  // AC2: most-recently-used team wins (team-b), not first-in-list (team-a)
  assert.deepEqual(body.lastUsed, { team: 'team-b', repo: 'acme/gadgets', state: 'all', type: 'prs' });
  // per-team last view is exposed so switching back restores that project's own selection
  const a = body.teams.find((t) => t.teamId === 'team-a');
  const b = body.teams.find((t) => t.teamId === 'team-b');
  assert.deepEqual([a.lastRepo, a.lastState], ['acme/widgets', 'closed']);
  assert.deepEqual([b.lastRepo, b.lastState], ['acme/gadgets', 'all']);
  // #2746: the item type is restored per team too (legacy prefs carry none)
  assert.deepEqual([a.lastType, b.lastType], [null, 'prs']);
});
