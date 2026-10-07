'use strict';

// Unit tests for the statuses runtime view (#570): which processes view a build
// uses, and the one-outstanding-request source behind it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickRuntimeView, createProcessesSource } = require('./agent-processes-view');

const P = [{ id: 'a', running: true }];
const OLD = [{ id: 'a', running: false }];
const base = { viewMaxMs: 15_000, timeoutMs: 60_000 };

test('a fresh array answer wins over any last view', () => {
  assert.deepEqual(
    pickRuntimeView({ ...base, outcome: 'fresh', processes: P, lastView: { processes: OLD, at: 0 }, now: 1 }),
    { processes: P, source: 'fresh' });
  assert.deepEqual(pickRuntimeView({ ...base, outcome: 'fresh', processes: [], now: 1 }),
    { processes: [], source: 'fresh' }, 'an empty fleet is a real answer, not "no view"');
});

test('a non-array "fresh" body is no answer', () => {
  for (const processes of [null, undefined, { error: 'x' }, 'nope']) {
    assert.deepEqual(pickRuntimeView({ ...base, outcome: 'fresh', processes, now: 1 }),
      { processes: null, source: 'none' });
  }
});

test('a failed answer falls back to the last view only inside viewMaxMs', () => {
  const lastView = { processes: OLD, at: 1000 };
  assert.equal(pickRuntimeView({ ...base, outcome: 'failed', lastView, now: 1000 }).source, 'last-view');
  assert.equal(pickRuntimeView({ ...base, outcome: 'failed', lastView, now: 15_999 }).source, 'last-view');
  assert.deepEqual(pickRuntimeView({ ...base, outcome: 'failed', lastView, now: 16_000 }),
    { processes: null, source: 'none' }, 'the window is exclusive at viewMaxMs');
  assert.equal(pickRuntimeView({ ...base, outcome: 'failed', lastView, now: 999 }).source, 'none',
    'a clock that stepped back trusts nothing');
});

test('an outstanding request keeps the view usable while the orchestrator is merely slow', () => {
  const lastView = { processes: OLD, at: 1000 };
  // Request started 5 s after the last answer, still running 50 s later.
  const pending = { ...base, outcome: 'pending', lastView, pendingSince: 6000 };
  assert.deepEqual(pickRuntimeView({ ...pending, now: 56_000 }), { processes: OLD, source: 'last-view' });
  assert.equal(pickRuntimeView({ ...pending, now: 65_999 }).source, 'last-view', 'up to the deadline');
  assert.equal(pickRuntimeView({ ...pending, now: 66_000 }).source, 'none', 'not past the request deadline');
  // The same age without an outstanding request: aged out.
  assert.equal(pickRuntimeView({ ...base, outcome: 'failed', lastView, now: 56_000 }).source, 'none');
});

test('a request started after the view had aged out vouches for nothing', () => {
  const lastView = { processes: OLD, at: 1000 };
  const pending = { ...base, outcome: 'pending', lastView, now: 20_000 };
  assert.equal(pickRuntimeView({ ...pending, pendingSince: 15_999 }).source, 'last-view');
  assert.equal(pickRuntimeView({ ...pending, pendingSince: 16_000 }).source, 'none');
  assert.equal(pickRuntimeView({ ...pending, pendingSince: undefined }).source, 'none');
});

test('no or malformed last view → none', () => {
  for (const lastView of [null, undefined, {}, { processes: 'x', at: 1 }, { processes: [], at: '1' }]) {
    assert.equal(pickRuntimeView({ ...base, outcome: 'pending', lastView, pendingSince: 1, now: 2 }).source, 'none');
  }
});

// ── createProcessesSource ────────────────────────────────────────────────

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function source(opts = {}) {
  let t = 1000;
  const calls = [];
  const src = createProcessesSource({
    fetchProcesses: () => { const d = deferred(); calls.push(d); return d.promise; },
    waitMs: 20, timeoutMs: 60_000, viewMaxMs: 15_000, now: () => t, ...opts,
  });
  return { src, calls, tick: (ms) => { t += ms; } };
}

const flush = () => new Promise((r) => setImmediate(r));

test('a prompt answer is used and becomes the last view', async () => {
  const s = source();
  const r = s.src.read(); await flush();
  s.calls[0].resolve(P);
  assert.deepEqual(await r, { processes: P, source: 'fresh' });
  assert.deepEqual(s.src.peek(), { lastView: { processes: P, at: 1000 }, outstanding: false });
});

test('never more than one request outstanding, however many builds wait', async () => {
  const s = source();
  const first = s.src.read(); await flush();
  s.calls[0].resolve(P); await first; // a last view exists
  s.tick(5000);
  const reads = [s.src.read(), s.src.read()]; await flush();
  assert.equal(s.calls.length, 2, 'one new request for both');
  for (const r of await Promise.all(reads)) assert.equal(r.source, 'last-view', 'the wait expired, the view stood in');
  // Every later beat during the stall joins the same request.
  for (let i = 0; i < 10; i++) { s.tick(5000); assert.equal((await s.src.read()).source, 'last-view'); }
  assert.equal(s.calls.length, 2, 'a 50 s stall queues one request, not one per beat');
  // The stall clears: the late answer refreshes the view, and the next read asks again.
  s.calls[1].resolve([{ id: 'a', running: true, late: true }]); await flush();
  assert.deepEqual(s.src.peek().lastView.processes, [{ id: 'a', running: true, late: true }]);
  const next = s.src.read(); await flush();
  assert.equal(s.calls.length, 3);
  s.calls[2].resolve(P);
  assert.equal((await next).source, 'fresh');
});

test('a slow request past the view window but inside its deadline keeps the view', async () => {
  const s = source();
  const first = s.src.read(); await flush();
  s.calls[0].resolve(OLD); await first;
  s.tick(5000);
  await s.src.read(); // starts request #2 at +5 s
  s.tick(40_000); // view 45 s old, request 40 s old
  assert.deepEqual(await s.src.read(), { processes: OLD, source: 'last-view' });
  s.tick(20_000); // request past its 60 s deadline (the adapter would have aborted it)
  assert.equal((await s.src.read()).source, 'none');
});

test('a failed answer (rejection, non-2xx, non-array body) falls back for viewMaxMs only', async () => {
  for (const fail of [(d) => d.reject(new Error('ECONNREFUSED')), (d) => d.resolve(null), (d) => d.resolve({ error: 'x' })]) {
    const s = source();
    const first = s.src.read(); await flush();
    s.calls[0].resolve(OLD); await first;
    s.tick(5000);
    const r = s.src.read(); await flush();
    fail(s.calls[1]);
    assert.deepEqual(await r, { processes: OLD, source: 'last-view' });
    assert.equal(s.src.peek().outstanding, false, 'a failure frees the slot');
    s.tick(10_000); // view 15 s old
    const late = s.src.read(); await flush();
    fail(s.calls[2]);
    assert.deepEqual(await late, { processes: null, source: 'none' });
    assert.deepEqual(s.src.peek().lastView.processes, OLD, 'a failure never overwrites the last view');
  }
});

test('a cold read with no view and a slow orchestrator gets none, and the request carries on', async () => {
  const s = source();
  assert.deepEqual(await s.src.read(), { processes: null, source: 'none' });
  assert.equal(s.src.peek().outstanding, true);
  s.calls[0].resolve(P); await flush();
  s.tick(1000);
  const r = s.src.read(); await flush();
  assert.equal(s.calls.length, 2, 'the landed request freed the slot');
  s.calls[1].reject(new Error('blip'));
  assert.deepEqual(await r, { processes: P, source: 'last-view' }, 'the late answer was kept');
});
