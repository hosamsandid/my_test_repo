import test from 'node:test';
import assert from 'node:assert/strict';

import { createFeedReloadThrottle, feedReloadDelayMs } from './knowledge-reload-throttle.js';

// A fake clock + timer queue so the throttle runs deterministically.
function harness({ hidden = false } = {}) {
  let t = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { at, fn }
  const reloads = [];
  const state = { hidden };
  const throttle = createFeedReloadThrottle({
    reload: (teamId) => reloads.push([teamId, t]),
    now: () => t,
    isHidden: () => state.hidden,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = due[1].at;
      due[1].fn();
    }
    t = end;
  };
  return { throttle, reloads, advance, state, timers };
}

test('a first event reloads after the short debounce', () => {
  const h = harness();
  h.throttle.request('sq');
  h.advance(399);
  assert.deepEqual(h.reloads, []);
  h.advance(1);
  assert.deepEqual(h.reloads, [['sq', 400]]);
});

test('a stream of events reloads at most once per 8 s, always with a trailing reload', () => {
  const h = harness();
  for (let i = 0; i < 100; i++) { h.throttle.request('sq'); h.advance(200); } // 20 s of events every 200 ms
  h.advance(10_000);
  const times = h.reloads.map(([, at]) => at);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 8000, `gap ${times[i] - times[i - 1]}`);
  assert.ok(times.length >= 3 && times.length <= 4, `reloads: ${times}`);
  assert.ok(times[times.length - 1] >= 19_800, 'the last event is covered by a trailing reload');
});

test('teams are throttled independently', () => {
  const h = harness();
  h.throttle.request('a');
  h.throttle.request('b');
  h.advance(400);
  assert.deepEqual(h.reloads.map(([id]) => id).sort(), ['a', 'b']);
});

test('a hidden tab reloads nothing and catches up once on visible', () => {
  const h = harness({ hidden: true });
  h.throttle.request('sq');
  h.throttle.request('sq');
  h.advance(30_000);
  assert.deepEqual(h.reloads, []);
  assert.equal(h.timers.size, 0, 'no timer runs while hidden');
  h.state.hidden = false;
  h.throttle.visibilityChanged(true, false);
  h.advance(400);
  assert.equal(h.reloads.length, 1);
  h.throttle.visibilityChanged(false, false); // no edge — nothing more
  h.advance(20_000);
  assert.equal(h.reloads.length, 1);
});

test('a reload due while the tab went hidden is deferred to the catch-up, not lost', () => {
  const h = harness();
  h.throttle.request('sq');
  h.state.hidden = true;
  h.advance(1000);
  assert.deepEqual(h.reloads, []);
  h.state.hidden = false;
  h.throttle.visibilityChanged(true, false);
  h.advance(400);
  assert.equal(h.reloads.length, 1);
});

test('visible → hidden and repeated flags trigger nothing', () => {
  const h = harness();
  h.throttle.visibilityChanged(false, true);
  h.throttle.visibilityChanged(true, true);
  h.advance(10_000);
  assert.deepEqual(h.reloads, []);
});

test('dispose cancels a pending reload', () => {
  const h = harness();
  h.throttle.request('sq');
  h.throttle.dispose();
  h.advance(10_000);
  assert.deepEqual(h.reloads, []);
});

test('feedReloadDelayMs: debounce floor, remaining interval otherwise', () => {
  assert.equal(feedReloadDelayMs({ lastAt: null, now: 5 }), 400);
  assert.equal(feedReloadDelayMs({ lastAt: 1000, now: 3000 }), 6000);
  assert.equal(feedReloadDelayMs({ lastAt: 1000, now: 20_000 }), 400);
});
