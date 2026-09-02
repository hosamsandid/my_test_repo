'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createKeyedMutex } = require('./keyed-mutex');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('same key runs tasks one-at-a-time in submission order', async () => {
  const mutex = createKeyedMutex();
  const events = [];
  const mk = (label, ms) => async () => {
    events.push(`start:${label}`);
    await delay(ms);
    events.push(`end:${label}`);
    return label;
  };
  // b is submitted second but slower to start; must still run strictly after a.
  const pa = mutex('team', mk('a', 30));
  const pb = mutex('team', mk('b', 1));
  const [ra, rb] = await Promise.all([pa, pb]);
  assert.strictEqual(ra, 'a');
  assert.strictEqual(rb, 'b');
  assert.deepStrictEqual(events, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('different keys run concurrently', async () => {
  const mutex = createKeyedMutex();
  const events = [];
  const mk = (label, ms) => async () => {
    events.push(`start:${label}`);
    await delay(ms);
    events.push(`end:${label}`);
  };
  await Promise.all([mutex('t1', mk('a', 20)), mutex('t2', mk('b', 20))]);
  // Both started before either ended → they overlapped.
  assert.deepStrictEqual(events.slice(0, 2).sort(), ['start:a', 'start:b']);
});

test('a rejecting task does not wedge the queue for the same key', async () => {
  const mutex = createKeyedMutex();
  const order = [];
  const bad = mutex('team', async () => { order.push('bad'); throw new Error('boom'); });
  const good = mutex('team', async () => { order.push('good'); return 'ok'; });
  await assert.rejects(bad, /boom/);
  assert.strictEqual(await good, 'ok');
  assert.deepStrictEqual(order, ['bad', 'good']);
});

test('caller observes the real resolution and rejection', async () => {
  const mutex = createKeyedMutex();
  assert.strictEqual(await mutex('k', async () => 42), 42);
  await assert.rejects(mutex('k', async () => { throw new Error('nope'); }), /nope/);
});

test('map entries are released once a key drains', async () => {
  const mutex = createKeyedMutex();
  assert.strictEqual(mutex.activeKeys(), 0);
  const p = mutex('team', async () => { await delay(5); });
  assert.strictEqual(mutex.activeKeys(), 1); // live while running
  await p;
  await delay(0); // let the finally-cleanup microtask run
  assert.strictEqual(mutex.activeKeys(), 0); // released after drain
});
