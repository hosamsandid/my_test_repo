'use strict';

// Unit tests for the stale-while-revalidate cache behind /api/agents/statuses (#570).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSwrCache } = require('./swr-cache');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(opts = {}) {
  let t = 1000;
  const builds = [];
  const errors = [];
  const recoveries = [];
  const cache = createSwrCache({
    freshMs: 5000, maxStaleMs: 30_000, now: () => t,
    onError: (e) => errors.push(e.message), onRecover: (r) => recoveries.push(r.failures), ...opts,
  });
  const compute = () => { const d = deferred(); builds.push(d); return d.promise; };
  return { cache, compute, builds, errors, recoveries, tick: (ms) => { t += ms; } };
}

const flush = () => new Promise((r) => setImmediate(r));

test('a cold cache waits for one shared build', async () => {
  const h = harness();
  const a = h.cache.get(h.compute);
  const b = h.cache.get(h.compute);
  await flush();
  assert.equal(h.builds.length, 1, 'single-flight');
  h.builds[0].resolve('v1');
  assert.deepEqual(await Promise.all([a, b]), ['v1', 'v1']);
});

test('inside freshMs the value is served without a build', async () => {
  const h = harness();
  const p = h.cache.get(h.compute); await flush(); h.builds[0].resolve('v1'); await p;
  h.tick(4999);
  assert.equal(await h.cache.get(h.compute), 'v1');
  await flush();
  assert.equal(h.builds.length, 1);
});

test('stale inside maxStaleMs: the old value at once, one background rebuild, then the new value', async () => {
  const h = harness();
  const p = h.cache.get(h.compute); await flush(); h.builds[0].resolve('v1'); await p;
  h.tick(6000);
  assert.equal(await h.cache.get(h.compute), 'v1', 'answered from the stale value');
  assert.equal(await h.cache.get(h.compute), 'v1');
  await flush();
  assert.equal(h.builds.length, 2, 'exactly one background rebuild');
  h.builds[1].resolve('v2');
  await flush();
  assert.equal(await h.cache.get(h.compute), 'v2');
});

test('builtAt is stamped when the build settles, not when it starts', async () => {
  const h = harness();
  const p = h.cache.get(h.compute); await flush();
  h.tick(4000); // a slow build
  h.builds[0].resolve('v1'); await p;
  h.tick(4000); // 8 s after start, 4 s after settle
  await h.cache.get(h.compute); await flush();
  assert.equal(h.builds.length, 1, 'still fresh — counted from the settle');
});

test('a failed background rebuild keeps the good value and is reported', async () => {
  const h = harness();
  const p = h.cache.get(h.compute); await flush(); h.builds[0].resolve('v1'); await p;
  h.tick(6000);
  assert.equal(await h.cache.get(h.compute), 'v1'); await flush();
  h.builds[1].reject(new Error('orchestrator down'));
  await flush();
  assert.deepEqual(h.errors, ['orchestrator down']);
  assert.equal(await h.cache.get(h.compute), 'v1', 'the good value survives');
  await flush();
  assert.equal(h.builds.length, 3, 'and the next stale read retries');
});

test('stale reads joining one failing rebuild report it once', async () => {
  const h = harness();
  const p = h.cache.get(h.compute); await flush(); h.builds[0].resolve('v1'); await p;
  h.tick(6000);
  for (let i = 0; i < 10; i++) assert.equal(await h.cache.get(h.compute), 'v1');
  await flush();
  assert.equal(h.builds.length, 2, 'one shared background rebuild');
  h.builds[1].reject(new Error('orchestrator down'));
  await flush();
  assert.deepEqual(h.errors, ['orchestrator down']);
});

test('past maxStaleMs the caller waits; a failed build rejects and caches nothing', async () => {
  const h = harness();
  const p = h.cache.get(h.compute); await flush(); h.builds[0].resolve('v1'); await p;
  h.tick(30_000);
  const late = h.cache.get(h.compute); await flush();
  assert.equal(h.builds.length, 2);
  h.builds[1].reject(new Error('boom'));
  await assert.rejects(late, /boom/);
  const again = h.cache.get(h.compute); await flush();
  assert.equal(h.builds.length, 3, 'the next call builds again');
  h.builds[2].resolve('v3');
  assert.equal(await again, 'v3');
});

test('a cold failed build rejects every waiter and the next call retries', async () => {
  const h = harness();
  const a = h.cache.get(h.compute); await flush();
  h.builds[0].reject(new Error('x'));
  await assert.rejects(a, /x/);
  assert.equal(h.cache.peek(), null);
});

test('freshMs 0 turns caching off', async () => {
  const h = harness({ freshMs: 0 });
  const a = h.cache.get(h.compute); const b = h.cache.get(h.compute); await flush();
  assert.equal(h.builds.length, 2);
  h.builds[0].resolve(1); h.builds[1].resolve(2);
  assert.deepEqual(await Promise.all([a, b]), [1, 2]);
});

test('a clock that steps backwards rebuilds instead of trusting the value', async () => {
  const h = harness();
  const p = h.cache.get(h.compute); await flush(); h.builds[0].resolve('v1'); await p;
  h.tick(-10_000);
  const q = h.cache.get(h.compute); await flush();
  assert.equal(h.builds.length, 2);
  h.builds[1].resolve('v2');
  assert.equal(await q, 'v2');
});

// Warm the cache with 'v1' (built at the harness clock).
async function warm(h) {
  const p = h.cache.get(h.compute); await flush(); h.builds[h.builds.length - 1].resolve('v1'); await p;
}

test('invalidate() keeps serving the value and starts one revalidation', async () => {
  const h = harness();
  await warm(h);
  h.cache.invalidate();
  assert.equal(await h.cache.get(h.compute), 'v1', 'still answered at once — no cold wait');
  assert.equal(await h.cache.get(h.compute), 'v1');
  await flush();
  assert.equal(h.builds.length, 2, 'one revalidation, although still inside freshMs');
  h.builds[1].resolve('v2');
  await flush();
  assert.deepEqual(h.cache.peek(), { value: 'v2', builtAt: 1000, stale: false });
  assert.equal(await h.cache.get(h.compute), 'v2'); await flush();
  assert.equal(h.builds.length, 2, 'the post-invalidation build is fresh');
});

test('invalidate() mid-build: no second build; the result is stored stale-on-arrival', async () => {
  const h = harness();
  await warm(h);
  h.tick(6000);
  await h.cache.get(h.compute); await flush(); // background rebuild in flight
  h.cache.invalidate();
  for (let i = 0; i < 5; i++) assert.equal(await h.cache.get(h.compute), 'v1');
  await flush();
  assert.equal(h.builds.length, 2, 'never two builds at once');
  h.builds[1].resolve('pre-invalidate');
  await flush();
  assert.equal(h.cache.peek().value, 'pre-invalidate', 'newer than v1, so kept');
  assert.equal(h.cache.peek().stale, true, 'but not fresh');
  assert.equal(await h.cache.get(h.compute), 'pre-invalidate'); await flush();
  assert.equal(h.builds.length, 3, 'the next read revalidates');
  h.builds[2].resolve('post-invalidate'); await flush();
  assert.equal(h.cache.peek().stale, false);
});

test('a waiting caller after invalidate() is never handed a pre-invalidation build', async () => {
  const h = harness();
  const before = h.cache.get(h.compute); await flush(); // cold build in flight
  h.cache.invalidate();
  const after = h.cache.get(h.compute); await flush();
  assert.equal(h.builds.length, 1, 'no second build beside the first');
  h.builds[0].resolve('pre');
  assert.equal(await before, 'pre', 'its own callers still get it');
  await flush();
  assert.equal(h.builds.length, 2, 'then one post-invalidation build');
  h.builds[1].resolve('post');
  assert.equal(await after, 'post');
});

test('failure backoff: a waiting caller gets the same rejection without a new build', async () => {
  const h = harness({ failureBackoffMs: 5000 });
  const a = h.cache.get(h.compute); await flush();
  const err = Object.assign(new Error('no runtime view'), { entries: ['all-offline'] });
  h.builds[0].reject(err);
  await assert.rejects(a, /no runtime view/);
  h.tick(4999);
  await assert.rejects(h.cache.get(h.compute), (e) => e === err, 'the cached failure, entries and all');
  assert.equal(h.builds.length, 1, 'no build inside the backoff');
  h.tick(1);
  const b = h.cache.get(h.compute); await flush();
  assert.equal(h.builds.length, 2, 'the backoff has passed');
  h.builds[1].resolve('v2');
  assert.equal(await b, 'v2');
});

test('failure backoff: stale reads keep the good value and do not rebuild until it passes', async () => {
  const h = harness({ failureBackoffMs: 5000 });
  await warm(h);
  h.tick(6000);
  await h.cache.get(h.compute); await flush();
  h.builds[1].reject(new Error('down')); await flush();
  for (let i = 0; i < 5; i++) { h.tick(900); assert.equal(await h.cache.get(h.compute), 'v1'); }
  await flush();
  assert.equal(h.builds.length, 2, 'all-offline never replaces the good set, and no rebuild per poll');
  h.tick(600);
  assert.equal(await h.cache.get(h.compute), 'v1'); await flush();
  assert.equal(h.builds.length, 3, 'one retry once the backoff passes');
});

test('invalidate() lifts a failure backoff', async () => {
  const h = harness({ failureBackoffMs: 5000 });
  const a = h.cache.get(h.compute); await flush();
  h.builds[0].reject(new Error('down'));
  await assert.rejects(a);
  h.cache.invalidate();
  const b = h.cache.get(h.compute); await flush();
  assert.equal(h.builds.length, 2, 'a mutation is a reason to try again');
  h.builds[1].resolve('v2');
  assert.equal(await b, 'v2');
});

test('a failure streak is reported once, and its recovery once', async () => {
  const h = harness({ maxStaleMs: 120_000 }); // every read below is a stale one
  await warm(h);
  for (let i = 1; i <= 4; i++) {
    h.tick(6000);
    await h.cache.get(h.compute); await flush();
    h.builds[i].reject(new Error(`down ${i}`)); await flush();
  }
  assert.deepEqual(h.errors, ['down 1'], 'the first failure only');
  h.tick(6000);
  await h.cache.get(h.compute); await flush();
  h.builds[5].resolve('v2'); await flush();
  assert.deepEqual(h.recoveries, [4], 'one recovery line, with the streak length');
  h.tick(6000);
  await h.cache.get(h.compute); await flush();
  h.builds[6].reject(new Error('down again')); await flush();
  assert.deepEqual(h.errors, ['down 1', 'down again'], 'a new streak is reported again');
});
