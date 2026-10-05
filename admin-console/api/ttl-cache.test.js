'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createTtlCache, ttlMsFromEnv } = require('./ttl-cache');

// Deterministic injectable clock.
function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('get/set: returns a fresh value, then undefined after the TTL elapses', () => {
  const clock = fakeClock();
  const cache = createTtlCache({ ttlMs: 100, now: clock.now });
  cache.set('a', { dirty: true });
  assert.deepEqual(cache.get('a'), { dirty: true });
  clock.advance(99);
  assert.deepEqual(cache.get('a'), { dirty: true }); // still fresh
  clock.advance(1);
  assert.equal(cache.get('a'), undefined); // expiresAt <= now → miss
});

test('get: missing key is undefined', () => {
  const cache = createTtlCache({ ttlMs: 100, now: fakeClock().now });
  assert.equal(cache.get('nope'), undefined);
});

test('expired entry is evicted from the store on read', () => {
  const clock = fakeClock();
  const cache = createTtlCache({ ttlMs: 10, now: clock.now });
  cache.set('a', 1);
  assert.equal(cache.size, 1);
  clock.advance(11);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0);
});

test('maxEntries: evicts the oldest insertion when full, keeps overwrites in place', () => {
  const cache = createTtlCache({ ttlMs: 1000, now: fakeClock().now, maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3); // evicts 'a' (oldest)
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
  // Overwriting an existing key must not evict.
  cache.set('b', 20);
  assert.equal(cache.get('b'), 20);
  assert.equal(cache.get('c'), 3);
});

test('getOrCompute: caches a fresh result, then serves it without recomputing', async () => {
  const clock = fakeClock();
  const cache = createTtlCache({ ttlMs: 100, now: clock.now });
  let calls = 0;
  const compute = async () => { calls++; return 'v'; };

  assert.equal(await cache.getOrCompute('k', compute), 'v');
  assert.equal(await cache.getOrCompute('k', compute), 'v');
  assert.equal(calls, 1); // second call is a cache hit

  clock.advance(101);
  assert.equal(await cache.getOrCompute('k', compute), 'v');
  assert.equal(calls, 2); // recomputed after expiry
});

test('getOrCompute: concurrent callers share one in-flight compute', async () => {
  const cache = createTtlCache({ ttlMs: 100, now: fakeClock().now });
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const compute = async () => { calls++; await gate; return 42; };

  const p1 = cache.getOrCompute('k', compute);
  const p2 = cache.getOrCompute('k', compute);
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a, 42);
  assert.equal(b, 42);
  assert.equal(calls, 1); // de-duplicated
});

test('getOrCompute: a rejected compute is not cached and rejects callers', async () => {
  const cache = createTtlCache({ ttlMs: 100, now: fakeClock().now });
  let calls = 0;
  const boom = async () => { calls++; throw new Error('nope'); };

  await assert.rejects(() => cache.getOrCompute('k', boom), /nope/);
  // Next call recomputes (nothing was cached) — succeeds this time.
  assert.equal(await cache.getOrCompute('k', async () => 'ok'), 'ok');
  assert.equal(calls, 1);
});

test('clear: drops cached values', () => {
  const cache = createTtlCache({ ttlMs: 1000, now: fakeClock().now });
  cache.set('a', 1);
  cache.clear();
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0);
});

// #566 — a clear() during an async compute (a mutation landing mid-build) must
// not let the superseded compute cache its pre-mutation value, nor evict the
// newer compute's in-flight entry when it settles.
test('clear: a compute in flight across a clear() neither caches nor evicts the newer compute', async () => {
  const cache = createTtlCache({ ttlMs: 1000, now: fakeClock().now });
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  const first = deferred();
  const second = deferred();
  let calls = 0;

  const p1 = cache.getOrCompute('k', () => { calls++; return first.promise; });
  await Promise.resolve(); // let the first compute start
  cache.clear();
  const p2 = cache.getOrCompute('k', () => { calls++; return second.promise; });
  await Promise.resolve();

  first.resolve('stale');
  assert.equal(await p1, 'stale', 'a caller already waiting still gets its result');
  assert.equal(cache.get('k'), undefined, 'the superseded value is not cached');
  // The newer compute is still the shared one — a third caller joins it.
  const p3 = cache.getOrCompute('k', () => { calls++; return 'third'; });

  second.resolve('fresh');
  assert.equal(await p2, 'fresh');
  assert.equal(await p3, 'fresh');
  assert.equal(cache.get('k'), 'fresh');
  assert.equal(calls, 2);
});

test('clear: a rejection from a superseded compute does not evict the newer one', async () => {
  const cache = createTtlCache({ ttlMs: 1000, now: fakeClock().now });
  let rejectFirst;
  const p1 = cache.getOrCompute('k', () => new Promise((_, rej) => { rejectFirst = rej; }));
  await Promise.resolve();
  cache.clear();
  let resolveSecond;
  const p2 = cache.getOrCompute('k', () => new Promise((r) => { resolveSecond = r; }));
  await Promise.resolve();
  rejectFirst(new Error('old'));
  await assert.rejects(p1, /old/);
  let joined = false;
  const p3 = cache.getOrCompute('k', () => { joined = true; return 'x'; });
  resolveSecond('new');
  assert.equal(await p3, 'new');
  assert.equal(joined, false, 'the third caller joined the newer in-flight compute');
  await p2;
});

test('ttlMsFromEnv honours an explicit 0 and falls back on unset or junk', () => {
  assert.equal(ttlMsFromEnv(undefined, 2000), 2000);
  assert.equal(ttlMsFromEnv('', 2000), 2000);
  assert.equal(ttlMsFromEnv(' ', 2000), 2000);
  assert.equal(ttlMsFromEnv('0', 2000), 0, 'not collapsed to the fallback');
  assert.equal(ttlMsFromEnv('1500', 2000), 1500);
  assert.equal(ttlMsFromEnv('-1', 2000), 2000);
  assert.equal(ttlMsFromEnv('soon', 2000), 2000);
});
