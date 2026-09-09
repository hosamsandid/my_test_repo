'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { httpPostStreamText } = require('./anthropic-transport');

// Spin up a throwaway HTTP server for one request; `handler(req, res)` writes the
// (streamed) response. Returns { url, close, received } where received resolves
// with the parsed request body once the request lands.
function withServer(handler) {
  return new Promise((resolve) => {
    let resolveBody;
    const received = new Promise((r) => { resolveBody = r; });
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        try { resolveBody(JSON.parse(body)); } catch { resolveBody(body); }
        handler(req, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1/messages`,
        received,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function sseFrame(obj) {
  return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
}
const textDelta = (t) => sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });

test('forces stream:true and accumulates the streamed text', async () => {
  const srv = await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sseFrame({ type: 'message_start', message: {} }));
    res.write(textDelta('{"summary":"ok",'));
    res.write(textDelta('"bundle":{}}'));
    res.end(sseFrame({ type: 'message_stop' }));
  });
  const result = await httpPostStreamText(srv.url, {}, { model: 'm', max_tokens: 16000 });
  const body = await srv.received;
  await srv.close();
  assert.equal(body.stream, true);           // the helper injects stream:true
  assert.equal(body.model, 'm');
  assert.equal(body.max_tokens, 16000);
  assert.equal(result.status, 200);
  assert.equal(result.error, null);
  assert.equal(result.text, '{"summary":"ok","bundle":{}}');
});

test('fires onProgress with a growing char count as frames arrive', async () => {
  const srv = await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(textDelta('aaa'));
    res.write(textDelta('bb'));
    res.end();
  });
  const counts = [];
  const result = await httpPostStreamText(srv.url, {}, {}, { onProgress: (n) => counts.push(n) });
  await srv.close();
  assert.equal(result.text, 'aaabb');
  // Monotonic non-decreasing, ending at the final length.
  assert.ok(counts.length >= 1);
  assert.deepEqual(counts, [...counts].sort((a, b) => a - b));
  assert.equal(counts[counts.length - 1], 5);
});

test('a progress hook that throws never breaks the stream', async () => {
  const srv = await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(textDelta('safe'));
    res.end();
  });
  const result = await httpPostStreamText(srv.url, {}, {}, { onProgress: () => { throw new Error('boom'); } });
  await srv.close();
  assert.equal(result.text, 'safe');
  assert.equal(result.error, null);
});

test('surfaces a mid-stream error frame with any partial text kept', async () => {
  const srv = await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(textDelta('partial'));
    res.end(sseFrame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
  });
  const result = await httpPostStreamText(srv.url, {}, {});
  await srv.close();
  assert.equal(result.status, 200);
  assert.equal(result.error, 'Overloaded');
  assert.equal(result.text, 'partial');
});

test('buffers a non-2xx body as JSON for the error message', async () => {
  const srv = await withServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Slow down' } }));
  });
  const result = await httpPostStreamText(srv.url, {}, {});
  await srv.close();
  assert.equal(result.status, 429);
  assert.equal(result.text, '');
  assert.equal(result.body.error.message, 'Slow down');
});

test('deadline tears down a stalled-but-open stream and returns error:deadline', async () => {
  // Server sends one frame then holds the connection open without ending.
  let heldRes = null;
  const srv = await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(textDelta('kept'));
    heldRes = res; // never ended → only the deadline can settle the client
  });
  const result = await httpPostStreamText(srv.url, {}, {}, { deadlineMs: 120, inactivityMs: 10000 });
  assert.equal(result.error, 'deadline');
  assert.equal(result.text, 'kept'); // partial text preserved on the deadline path
  if (heldRes) heldRes.end();
  await srv.close();
});

test('invalid URL resolves with an error, never throws', async () => {
  const result = await httpPostStreamText('not a url', {}, {});
  assert.equal(result.status, 0);
  assert.match(result.error, /Invalid URL/);
});

test('an already-aborted signal resolves immediately with error:aborted, no connection', async () => {
  const ac = new AbortController();
  ac.abort();
  // The upfront check fires before the URL is even parsed, so nothing dials out.
  const result = await httpPostStreamText('http://127.0.0.1:9/v1/messages', {}, {}, { signal: ac.signal });
  assert.equal(result.status, 0);
  assert.equal(result.error, 'aborted');
});

test('aborting mid-stream (#2087) destroys the request, returns error:aborted with partial text', async () => {
  let held = null;
  const srv = await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(textDelta('partial'));
    held = res; // never ended — only the abort can settle the client
  });
  const ac = new AbortController();
  const result = await httpPostStreamText(srv.url, {}, {}, {
    signal: ac.signal,
    inactivityMs: 10000,
    deadlineMs: 10000,
    onProgress: () => ac.abort(), // stop as soon as the first frame lands
  });
  assert.equal(result.error, 'aborted');
  assert.equal(result.text, 'partial'); // whatever streamed before the stop is kept
  if (held) held.end();
  await srv.close();
});

// #2131 AC2. The failure mode the ticket describes is an upstream that BUFFERS
// the SSE and therefore delivers zero bytes for minutes before answering 504 —
// so the heartbeat and the partial-text machinery cannot help, and the deadline
// is the only thing that can close the turn cleanly first. The existing deadline
// test streams one frame before stalling, which is a different socket state
// (headers received, parser primed). This one pins the byteless case: nothing is
// ever written, not even the response head.
// Both cases carry an explicit test timeout: with no bytes and (below) no idle
// guard, the deadline is the ONLY thing that can settle the promise, so a
// regression would otherwise hang CI instead of failing it.
test('AC2: the deadline settles a request that never receives a single byte', { timeout: 15000 }, async () => {
  const held = [];
  const srv = await withServer((req, res) => { held.push(res); /* no writeHead, no write, no end */ });
  const startedAt = Date.now();
  const result = await httpPostStreamText(srv.url, {}, {}, { deadlineMs: 200, inactivityMs: 10000 });
  const elapsed = Date.now() - startedAt;
  for (const r of held) { try { r.destroy(); } catch { /* already gone */ } }
  await srv.close();
  // A clean `deadline` — never the socket-idle `timeout`, whose message would
  // send the user looking for a network fault, and never a hang past the bound.
  assert.equal(result.error, 'deadline');
  assert.equal(result.status, 0);
  assert.equal(result.text, '');
  assert.ok(elapsed < 2000, `settled in ${elapsed}ms, expected close to the 200ms deadline`);
});

test('AC2: the deadline wins even when the idle guard is disabled outright', { timeout: 15000 }, async () => {
  // The copilot route sets inactivityMs to the remaining deadline (or 0 when an
  // operator disables it), precisely because a buffered-but-alive generation
  // looks idle. With no idle guard at all the deadline must still be a bound.
  const held = [];
  const srv = await withServer((req, res) => { held.push(res); });
  const result = await httpPostStreamText(srv.url, {}, {}, { deadlineMs: 200, inactivityMs: 0 });
  for (const r of held) { try { r.destroy(); } catch { /* already gone */ } }
  await srv.close();
  assert.equal(result.error, 'deadline');
});
