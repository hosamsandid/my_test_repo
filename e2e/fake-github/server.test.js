// In-process unit test for the fake GitHub server (#710, §6.1).
// Runs the real HTTP server on an ephemeral port — no podman, no stack.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('./server');

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

beforeEach(async () => {
  await fetch(`${base}/_reset`, { method: 'POST' });
});

async function j(path, opts) {
  const res = await fetch(`${base}${path}`, opts);
  const text = await res.text();
  return { status: res.status, etag: res.headers.get('etag'), body: text ? JSON.parse(text) : null };
}

test('events feed starts empty with an ETag', async () => {
  const r = await j('/repos/acme/widgets/events');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
  assert.ok(r.etag, 'ETag present');
});

test('ETag/304: unchanged feed returns 304 for a matching If-None-Match', async () => {
  const first = await j('/repos/acme/widgets/events');
  const second = await j('/repos/acme/widgets/events', { headers: { 'If-None-Match': first.etag } });
  assert.equal(second.status, 304);
  assert.equal(second.body, null);
  assert.equal(second.etag, first.etag, 'ETag unchanged while feed unchanged');
});

test('creating an issue emits IssuesEvent(opened) and bumps the ETag', async () => {
  const before = await j('/repos/acme/widgets/events');
  const created = await j('/repos/acme/widgets/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Do the thing' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.number > 0, true);

  const after = await j('/repos/acme/widgets/events', { headers: { 'If-None-Match': before.etag } });
  assert.equal(after.status, 200, 'stale ETag ⇒ 200 with fresh events');
  assert.notEqual(after.etag, before.etag, 'ETag advanced');
  assert.equal(after.body[0].type, 'IssuesEvent');
  assert.equal(after.body[0].payload.action, 'opened');
  assert.equal(after.body[0].repo.name, 'acme/widgets');
});

test('labeling an issue emits IssuesEvent(labeled) with the label name', async () => {
  const issue = await j('/repos/acme/widgets/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Needs approval' }),
  });
  const n = issue.body.number;
  const labeled = await j(`/repos/acme/widgets/issues/${n}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels: ['ready-2'] }),
  });
  assert.equal(labeled.status, 200);
  assert.deepEqual(labeled.body.map((l) => l.name), ['ready-2']);

  const events = (await j('/repos/acme/widgets/events')).body;
  const ev = events.find((e) => e.payload.action === 'labeled');
  assert.ok(ev, 'labeled event emitted');
  assert.equal(ev.type, 'IssuesEvent');
  assert.equal(ev.payload.label.name, 'ready-2');
  assert.equal(ev.payload.issue.number, n);
});

test('adding an already-present label is idempotent (no duplicate event)', async () => {
  const issue = await j('/repos/acme/widgets/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x' }),
  });
  const n = issue.body.number;
  const add = (labels) => j(`/repos/acme/widgets/issues/${n}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels }),
  });
  await add(['ready-2']);
  await add(['ready-2']); // duplicate
  const labeledEvents = (await j('/repos/acme/widgets/events')).body.filter(
    (e) => e.payload.action === 'labeled',
  );
  assert.equal(labeledEvents.length, 1, 'only one labeled event for one distinct label');
});

test('labeling a PR emits PullRequestEvent(labeled)', async () => {
  const pr = await j('/repos/acme/widgets/pulls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Fix', head: 'feat/x', base: 'main' }),
  });
  const n = pr.body.number;
  await j(`/repos/acme/widgets/pulls/${n}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels: ['ready-for-review'] }),
  });
  const events = (await j('/repos/acme/widgets/events')).body;
  const opened = events.find((e) => e.type === 'PullRequestEvent' && e.payload.action === 'opened');
  const labeled = events.find((e) => e.type === 'PullRequestEvent' && e.payload.action === 'labeled');
  assert.ok(opened, 'PR opened event');
  assert.ok(labeled, 'PR labeled event');
  assert.equal(labeled.payload.label.name, 'ready-for-review');
  assert.equal(labeled.payload.number, n);
});

test('removing a label emits an unlabeled event', async () => {
  const issue = await j('/repos/acme/widgets/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', labels: ['wip'] }),
  });
  const n = issue.body.number;
  await j(`/repos/acme/widgets/issues/${n}/labels/wip`, { method: 'DELETE' });
  const events = (await j('/repos/acme/widgets/events')).body;
  assert.ok(events.some((e) => e.payload.action === 'unlabeled' && e.payload.label.name === 'wip'));
});

test('inspection endpoint reports issues, pulls and labels', async () => {
  await j('/repos/acme/widgets/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'i1', labels: ['ready-2'] }),
  });
  const state = (await j('/_state')).body;
  const repo = state.repos['acme/widgets'];
  assert.equal(repo.issues.length, 1);
  assert.equal(repo.issues[0].title, 'i1');
  assert.ok(repo.labels.includes('ready-2'));
  assert.ok(repo.eventCount >= 1);
});

test('reset clears all state', async () => {
  await j('/repos/acme/widgets/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x' }),
  });
  await j('/_reset', { method: 'POST' });
  const state = (await j('/_state')).body;
  assert.deepEqual(state.repos, {});
  assert.deepEqual((await j('/repos/acme/widgets/events')).body, []);
});

test('mock /v1/messages returns a canned Anthropic-shaped response', async () => {
  const r = await j('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-fake-e2e', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.type, 'message');
  assert.equal(r.body.role, 'assistant');
  assert.equal(r.body.content[0].type, 'text');
  assert.ok(r.body.content[0].text.length > 0);
});

test('repo metadata + branches back the wizard repo-probe', async () => {
  const meta = await j('/repos/acme/widgets');
  assert.equal(meta.status, 200);
  assert.equal(meta.body.default_branch, 'main');
  const branches = await j('/repos/acme/widgets/branches');
  assert.deepEqual(branches.body.map((b) => b.name), ['main']);
});
