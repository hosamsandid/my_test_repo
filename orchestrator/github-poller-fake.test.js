// Integration proof (#710, podman-free): the real GitHubPoller._fetchEvents,
// pointed at the fake-github server via GITHUB_API_BASE, reads the fake feed and
// observes ETag/304 semantics — the seam and the fake server compose. No stack.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../e2e/fake-github/server');
const { GitHubPoller } = require('./github-poller');

let server;
let base;
let poller;

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.GITHUB_API_BASE = base;
  poller = new GitHubPoller();
});

after(() => {
  delete process.env.GITHUB_API_BASE;
  if (server) server.close();
});

async function fakeFetch(path, opts) {
  const res = await fetch(`${base}${path}`, opts);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

test('_fetchEvents reads a fake-emitted labeled event through the seam', async () => {
  await fakeFetch('/_reset', { method: 'POST' });
  const issue = await fakeFetch('/repos/acme/widgets/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'ship it' }),
  });
  await fakeFetch(`/repos/acme/widgets/issues/${issue.number}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels: ['ready-2'] }),
  });

  const res = await poller._fetchEvents('acme/widgets', 'fake-token', null, 1);
  assert.equal(res.status, 200);
  assert.ok(res.etag, 'poller captured the fake ETag');
  const labeled = res.events.find((e) => e.payload && e.payload.action === 'labeled');
  assert.ok(labeled, 'poller saw the labeled event');
  assert.equal(labeled.type, 'IssuesEvent');
  assert.equal(labeled.payload.label.name, 'ready-2');

  // Re-fetch with the captured ETag ⇒ 304, no events (the poller's cursor path).
  const again = await poller._fetchEvents('acme/widgets', 'fake-token', res.etag, 1);
  assert.equal(again.status, 304);
  assert.deepEqual(again.events, []);
});
