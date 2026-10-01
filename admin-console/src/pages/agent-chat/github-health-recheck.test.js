import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECHECK_MIN_BUSY_MS,
  initialRecheckState,
  recheckReducer,
  remainingBusyMs,
  formatCheckedTime,
  describeRecheck,
} from './github-health-recheck.js';

const OK = { rollUp: { ok: true }, repos: [{ ok: true, fullName: 'o/r' }] };
const fmt = (ms) => `T${ms}`;
const run = (actions, from = initialRecheckState) => actions.reduce(recheckReducer, from);

test('the initial load counts as a check and shows a "Last checked" indicator', () => {
  const s = run([{ type: 'loaded', at: 1000 }]);
  assert.equal(s.checkedAt, 1000);
  assert.deepEqual(describeRecheck(s, fmt), {
    buttonLabel: 'Recheck', disabled: false, note: { tone: 'muted', text: 'Last checked T1000' },
  });
});

test('before any completed check there is no indicator', () => {
  assert.equal(describeRecheck(initialRecheckState, fmt).note, null);
});

test('a recheck in flight shows a disabled busy button and keeps the previous result (AC1, AC2)', () => {
  const s = run([{ type: 'success', data: OK, at: 1000 }, { type: 'start' }]);
  assert.equal(s.busy, true);
  assert.equal(s.data, OK, 'the previous result stays visible while checking');
  assert.equal(s.checkedAt, 1000);
  const v = describeRecheck(s, fmt);
  assert.equal(v.buttonLabel, 'Checking…');
  assert.equal(v.disabled, true);
  assert.deepEqual(v.note, { tone: 'muted', text: 'Last checked T1000' });
});

test('a second start while busy is ignored — no overlapping rechecks (AC1)', () => {
  const busy = run([{ type: 'loaded', at: 1 }, { type: 'start' }]);
  assert.equal(recheckReducer(busy, { type: 'start' }), busy);
});

test('a recheck with an unchanged result still updates the completion indicator (AC3, AC4)', () => {
  const first = run([{ type: 'success', data: OK, at: 1000 }]);
  const second = run([{ type: 'start' }, { type: 'success', data: { ...OK }, at: 5000 }], first);
  assert.deepEqual(second.data, first.data, 'same result');
  assert.equal(second.busy, false);
  assert.notEqual(describeRecheck(second, fmt).note.text, describeRecheck(first, fmt).note.text);
  assert.equal(describeRecheck(second, fmt).note.text, 'Last checked T5000');
});

test('a failed recheck keeps the box, re-enables the button and does not claim freshness (AC5)', () => {
  const s = run([{ type: 'success', data: OK, at: 1000 }, { type: 'start' }, { type: 'failure', at: 9000 }]);
  assert.equal(s.data, OK, 'last known result kept');
  assert.equal(s.checkedAt, 1000, 'a failure is not a completed check');
  const v = describeRecheck(s, fmt);
  assert.equal(v.disabled, false);
  assert.equal(v.buttonLabel, 'Recheck');
  assert.equal(v.note.tone, 'error');
  assert.match(v.note.text, /^Recheck failed — try again\./);
  assert.match(v.note.text, /from T1000/);
  assert.doesNotMatch(v.note.text, /Last checked/);
});

test('a failure without any earlier successful check still says so', () => {
  const s = run([{ type: 'start' }, { type: 'failure' }]);
  assert.deepEqual(describeRecheck(s, fmt).note, { tone: 'error', text: 'Recheck failed — try again.' });
});

test('starting a new recheck clears a previous failure, and success clears it too', () => {
  const failed = run([{ type: 'loaded', at: 1 }, { type: 'start' }, { type: 'failure' }]);
  assert.equal(run([{ type: 'start' }], failed).failed, false);
  assert.equal(run([{ type: 'start' }, { type: 'success', data: OK, at: 2 }], failed).failed, false);
});

test('reset (environment switched) drops every bit of recheck state', () => {
  const s = run([{ type: 'success', data: OK, at: 1 }, { type: 'start' }, { type: 'reset' }]);
  assert.deepEqual(s, initialRecheckState);
});

test('a fresh initial load replaces an earlier recheck result', () => {
  const s = run([{ type: 'success', data: OK, at: 1 }, { type: 'loaded', at: 2 }]);
  assert.equal(s.data, null);
  assert.equal(s.checkedAt, 2);
});

test('unknown actions leave the state untouched', () => {
  assert.equal(recheckReducer(initialRecheckState, { type: 'nope' }), initialRecheckState);
});

test('the busy state is held for a perceivable minimum even on instant responses (AC6)', () => {
  assert.ok(RECHECK_MIN_BUSY_MS >= 300);
  assert.equal(remainingBusyMs(1000, 1000), RECHECK_MIN_BUSY_MS);
  assert.equal(remainingBusyMs(1000, 1000 + RECHECK_MIN_BUSY_MS - 100), 100);
  assert.equal(remainingBusyMs(1000, 1000 + RECHECK_MIN_BUSY_MS), 0);
  assert.equal(remainingBusyMs(1000, 1000 + RECHECK_MIN_BUSY_MS + 5000), 0);
  assert.equal(remainingBusyMs(0, 50, 200), 150);
});

test('the checked time includes seconds so rechecks seconds apart differ', () => {
  const a = formatCheckedTime(new Date(2026, 9, 1, 9, 41, 7).getTime());
  const b = formatCheckedTime(new Date(2026, 9, 1, 9, 41, 12).getTime());
  assert.notEqual(a, b);
  assert.match(a, /07/);
});
