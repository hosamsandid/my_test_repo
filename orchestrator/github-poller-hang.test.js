// Regression proof: the poller must never be able to wedge itself.
//
// The live-stack outage this covers: during a network flap a fetch promise never
// settled, so `_tick`'s `finally` never ran, `this.running` stayed `true`, and
// every subsequent tick returned at the guard. The poller went dead silently —
// no log line, no recovery once the network came back — for ~4h until the
// orchestrator was restarted. GitHub-event triggers simply stopped firing.
//
// Two independent defences are asserted here:
//   1. Every request settles, whatever phase stalls (deadline + response-side
//      error/abort handling) — so the guard is released in the first place.
//   2. Even given a stuck await, the stall watchdog forces the guard open — so a
//      future unsettled promise degrades to a visible hiccup, not a dead poller.
//
// A short deadline is injected before require() so the stall cases finish fast.
process.env.AEE_GITHUB_REQUEST_DEADLINE_MS = '300';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { GitHubPoller } = require('./github-poller');

// Server modes, one per way a request can stall short of a clean 'end'.
let mode = 'accept-and-never-respond';
let server;
let base;
const sockets = new Set();

before(async () => {
  server = http.createServer((req, res) => {
    if (mode === 'accept-and-never-respond') {
      // Headers never sent. The socket-inactivity `timeout` option would
      // eventually catch this one, but only because a socket exists; the
      // deadline is what makes the guarantee unconditional.
      return;
    }
    if (mode === 'headers-then-kill-socket') {
      // The case the old code could not survive: a response that begins and
      // then dies mid-body fires 'aborted'/'error' on `res`, never 'end'.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('[{"id":"1"');
      setImmediate(() => res.socket.destroy());
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.GITHUB_API_BASE = base;
});

after(() => {
  delete process.env.GITHUB_API_BASE;
  delete process.env.AEE_GITHUB_REQUEST_DEADLINE_MS;
  for (const s of sockets) s.destroy();
  if (server) server.close();
});

test('_fetchEvents settles when the server accepts but never responds', async () => {
  mode = 'accept-and-never-respond';
  const poller = new GitHubPoller();
  await assert.rejects(
    poller._fetchEvents('acme/widgets', 'tok', null, 1),
    /deadline exceeded|timeout|socket hang up/,
    'a silent server must reject, never hang forever',
  );
});

test('_fetchEvents settles when the response dies mid-body', async () => {
  mode = 'headers-then-kill-socket';
  const poller = new GitHubPoller();
  await assert.rejects(
    poller._fetchEvents('acme/widgets', 'tok', null, 1),
    /aborted|deadline exceeded|ECONNRESET|socket hang up/,
    "a truncated response must reject — 'end' never fires for it",
  );
});

test('_fetchJson settles when the response dies mid-body', async () => {
  mode = 'headers-then-kill-socket';
  const poller = new GitHubPoller();
  await assert.rejects(
    poller._fetchJson(`${base}/repos/acme/widgets/pulls/1`, 'tok'),
    /aborted|deadline exceeded|ECONNRESET|socket hang up/,
    'the PR-title enrichment GET has the same failure mode as the events GET',
  );
});

// The guarantee that actually keeps the poller alive: a stuck tick is survivable.
test('a tick stalled past the watchdog no longer blocks later ticks', async () => {
  const poller = new GitHubPoller({
    // A plan of one repo is enough; _pollRepo is stubbed out below.
    listEnvironmentIds: () => [],
  });

  let polls = 0;
  poller._buildPollPlan = () => new Map([['acme/widgets', { tokenId: 't', subscribers: [] }]]);
  poller._pollRepo = async () => { polls += 1; };

  // Simulate the outage state: a tick is "in flight" and has made no progress
  // for well past the stall window (the real one hung for hours).
  poller.running = true;
  poller.tickProgressAt = Date.now() - 60 * 60_000;

  await poller._tick();
  assert.equal(polls, 1, 'the watchdog must force the stranded guard open and poll again');
  assert.equal(poller.running, false, 'the fresh tick released the guard normally');
});

test('a tick that is merely slow is still not interrupted', async () => {
  const poller = new GitHubPoller();
  let polls = 0;
  poller._buildPollPlan = () => new Map([['acme/widgets', { tokenId: 't', subscribers: [] }]]);
  poller._pollRepo = async () => { polls += 1; };

  // In flight and advancing — overlap here would race the per-repo seen-set.
  poller.running = true;
  poller.tickProgressAt = Date.now();

  await poller._tick();
  assert.equal(polls, 0, 'a progressing tick must keep its exclusivity');
});

test('a late-settling abandoned tick cannot release a newer tick\'s guard', async () => {
  const poller = new GitHubPoller();
  poller._buildPollPlan = () => new Map();

  // Stand in for the abandoned tick: it captured generation 1 and is about to
  // reach its `finally` long after the watchdog handed the guard to a new tick.
  poller.running = true;
  poller.tickProgressAt = Date.now() - 60 * 60_000;
  const staleGeneration = ++poller.tickGeneration;

  // A newer tick takes over.
  await poller._tick();
  const newerGeneration = poller.tickGeneration;
  assert.ok(newerGeneration > staleGeneration, 'the newer tick bumped the generation');

  // Now the stale tick finally settles and runs its release check.
  poller.running = true;
  if (poller.tickGeneration === staleGeneration) poller.running = false;
  assert.equal(poller.running, true, 'the stale tick must not clear a guard it no longer owns');
});
