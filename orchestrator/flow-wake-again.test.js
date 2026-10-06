'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const wa = require('./flow-wake-again');
const fb = require('./flow-board');

const wake = (extra = {}) => ({
  repo: 'o/r', number: 2844, kind: 'pr', label: 'ready-for-review',
  roles: [{ id: 't-reviewer', label: 'Code Reviewer' }], cause: 'history-horizon', eventId: '1', since: 'x', ...extra,
});
const boardWith = (needsHuman, extra = {}) => ({ rows: [{ id: 'o/r#2813', needsHuman }], ...extra });

test('planWakeAgain: refuses a stale board, an unknown row and a row no longer parked (#2873)', () => {
  assert.equal(wa.planWakeAgain(null, 'o/r#2813').status, 503);
  assert.equal(wa.planWakeAgain(boardWith(null, { stale: true }), 'o/r#2813').status, 503);
  assert.equal(wa.planWakeAgain(boardWith(null), 'o/r#9').status, 404);
  assert.equal(wa.planWakeAgain(boardWith(null), 'o/r#2813').status, 409);
  assert.equal(wa.planWakeAgain(boardWith({ reason: fb.REASONS.needsHelp }), 'o/r#2813').status, 409);
});

test('planWakeAgain: a parked row yields its wakes; one with no switched-on consumer is dropped (#2873)', () => {
  const plan = wa.planWakeAgain(boardWith({ reason: fb.REASONS.wakeLost, wakes: [wake(), wake({ number: 2845, roles: [] })] }), 'o/r#2813');
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.wakes.map((w) => w.number), [2844]);
  const none = wa.planWakeAgain(boardWith({ reason: fb.REASONS.wakeLost, wakes: [wake({ roles: [] })] }), 'o/r#2813');
  assert.deepEqual([none.ok, none.status], [false, 409]);
});

test('checkWakeStillPresent: the item must be open and still carry the wake label (#2873)', () => {
  const label = 'ready-for-review';
  assert.deepEqual(wa.checkWakeStillPresent({ state: 'open', labels: [{ name: label }] }, { label }), { ok: true });
  assert.deepEqual(wa.checkWakeStillPresent({ state: 'open', labels: [label] }, { label }), { ok: true });
  assert.equal(wa.checkWakeStillPresent({ state: 'open', labels: [{ name: `${label}:wip` }] }, { label }).warning, `${label} is no longer on the item`);
  assert.equal(wa.checkWakeStillPresent({ state: 'closed', labels: [{ name: label }] }, { label }).warning, 'the item is closed');
  assert.equal(wa.checkWakeStillPresent({ state: 'closed', merged: true, labels: [] }, { label }).ok, false);
  assert.equal(wa.checkWakeStillPresent(null, { label }).warning, 'could not read the item on GitHub');
});

test('templateListeners: only the consumer role templates — never a pool instance of any item (#2873, #2875)', () => {
  const listeners = [
    { agentId: 't-reviewer', triggerId: 'a' },
    { agentId: 't-reviewer-i2859', triggerId: 'a' }, // another ticket's live instance
    { agentId: 't-reviewer-i2813', triggerId: 'a' }, // even this item's own: the template routes there
    { agentId: 't-security', triggerId: 'b' },       // a listener outside the parked wake's roles
    { agentId: 'other-team-reviewer', triggerId: 'c' },
  ];
  assert.deepEqual(wa.templateListeners(listeners, ['t-reviewer']), [{ agentId: 't-reviewer', triggerId: 'a' }]);
  assert.deepEqual(wa.templateListeners(listeners, []), []);
  assert.deepEqual(wa.templateListeners(null, ['t-reviewer']), []);
});

test('wakeAgainKey / source: one in-flight key per row, logged as flow-control (#2873)', () => {
  assert.equal(wa.wakeAgainKey('t', 'o/r#1'), 't::o/r#1');
  assert.equal(wa.WAKE_AGAIN_SOURCE, 'flow-control');
});

test('planWakeAgain: a carried-over row is planned like a parked one (#2877)', () => {
  const plan = wa.planWakeAgain(boardWith({ reason: fb.REASONS.carriedOver, wakes: [wake({ carriedOver: true })] }), 'o/r#2813');
  assert.equal(plan.ok, true);
});

test('planAdopt: every carried-over row by default, named rows on request; non-adoptable ones are skipped with their reason (#2877)', () => {
  const carriedRow = (id, extra = {}) => ({ id, needsHuman: { reason: fb.REASONS.carriedOver, wakes: [wake(extra)] } });
  const board = {
    rows: [carriedRow('o/r#1'), carriedRow('o/r#2', { number: 2 }), { id: 'o/r#3', needsHuman: { reason: fb.REASONS.conflict } }],
    carriedOver: ['o/r#1', 'o/r#2'],
  };
  const all = wa.planAdopt(board);
  assert.deepEqual([all.ok, all.rows.map((r) => r.rowId), all.skipped], [true, ['o/r#1', 'o/r#2'], []]);
  const named = wa.planAdopt(board, ['o/r#2', 'o/r#3', 'o/r#2', 'o/r#9', 5]);
  assert.deepEqual(named.rows.map((r) => r.rowId), ['o/r#2']);
  assert.deepEqual(named.skipped.map((s) => [s.rowId, s.status]), [['o/r#3', 409], ['o/r#9', 404]]);
  assert.equal(wa.planAdopt({ ...board, stale: true }).status, 503);
  assert.deepEqual([wa.planAdopt({ rows: [], carriedOver: [] }).ok, wa.planAdopt({ rows: [], carriedOver: [] }).status], [false, 409]);
  assert.equal(wa.planAdopt(board, ['o/r#3']).status, 409);
});
