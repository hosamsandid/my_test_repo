import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTCOME_LEGEND,
  outcomeLegendKey,
  outcomeTooltip,
  noMatchTooltip,
  refireNote,
} from './event-outcome-view.js';

test('OUTCOME_LEGEND covers every rendered outcome with meaning + whatToDo', () => {
  const keys = OUTCOME_LEGEND.map(e => e.key);
  for (const expected of ['delivered', 'digest', 'held', 'throttle', 'history-horizon', 'label-filter', 'no-match']) {
    assert.ok(keys.includes(expected), `legend missing ${expected}`);
  }
  for (const entry of OUTCOME_LEGEND) {
    assert.ok(entry.term && entry.meaning && entry.whatToDo, `legend entry ${entry.key} incomplete`);
  }
});

test('outcomeLegendKey maps statuses and drop reasons', () => {
  assert.equal(outcomeLegendKey({ status: 'delivered' }), 'delivered');
  assert.equal(outcomeLegendKey({ status: 'digest' }), 'digest');
  assert.equal(outcomeLegendKey({ status: 'held', reason: 'wip', wipLimit: 3 }), 'held');
  assert.equal(outcomeLegendKey({ status: 'dropped', reason: 'throttle' }), 'throttle');
  assert.equal(outcomeLegendKey({ status: 'dropped', reason: 'history-horizon' }), 'history-horizon');
  assert.equal(outcomeLegendKey({ status: 'dropped', reason: 'label-filter' }), 'label-filter');
});

test('a held-by-WIP outcome reads as held (not delivered, not dropped) with an actionable tooltip', () => {
  const t = outcomeTooltip({ status: 'held', reason: 'wip', wipLimit: 3 });
  assert.match(t, /Work-in-Progress limit/);
  assert.match(t, /fires automatically|force it|Pending queue|Flow Control/);
});

test('outcomeLegendKey falls back to a generic drop for unknown reasons', () => {
  assert.equal(outcomeLegendKey({ status: 'dropped', reason: 'meteor-strike' }), 'drop-unknown');
  assert.equal(outcomeLegendKey({ status: 'dropped' }), 'drop-unknown');
});

test('outcomeLegendKey is null on junk input', () => {
  assert.equal(outcomeLegendKey(null), null);
  assert.equal(outcomeLegendKey('nope'), null);
});

test('outcomeTooltip returns meaning + whatToDo for a known outcome', () => {
  const t = outcomeTooltip({ status: 'dropped', reason: 'throttle' });
  assert.match(t, /rate cap/);
  assert.match(t, /loop-protection/);
});

test('outcomeTooltip names the raw reason for an unknown drop', () => {
  const t = outcomeTooltip({ status: 'dropped', reason: 'meteor-strike' });
  assert.match(t, /meteor-strike/);
});

test('outcomeTooltip is empty on junk input', () => {
  assert.equal(outcomeTooltip(null), '');
  assert.equal(outcomeTooltip('nope'), '');
});

test('noMatchTooltip explains the no-subscriber case with an action', () => {
  const t = noMatchTooltip();
  assert.match(t, /No trigger subscribed/);
  assert.match(t, /add or fix a github-event trigger/);
});

test('#2525: the legend explains every drop reason the poller stamps', () => {
  const keys = OUTCOME_LEGEND.map(e => e.key);
  for (const r of ['wake-already-armed', 'internal-dedup', 'self-claim-label', 'push-duplicate', 'throttle', 'label-filter', 'branch-filter', 'history-horizon']) {
    assert.ok(keys.includes(r), `legend missing ${r}`);
    assert.equal(outcomeLegendKey({ status: 'dropped', reason: r }), r);
  }
});

test('#2525: refireNote names who fired a manual re-fire row again', () => {
  assert.equal(refireNote({ source: 'manual-refire', refiredBy: 'ana', refireOf: { reason: 'throttle' } }),
    'Fired again by ana after a throttle drop.');
  assert.equal(refireNote({ source: 'manual-refire' }), 'Fired again.');
  assert.equal(refireNote({ source: 'internal' }), null);
  assert.equal(refireNote(null), null);
});

test('#2571: the legend explains the producer-filter drop', () => {
  assert.equal(outcomeLegendKey({ status: 'dropped', reason: 'producer-filter' }), 'producer-filter');
  assert.match(outcomeTooltip({ status: 'dropped', reason: 'producer-filter' }), /pushed by/);
});

test('#2602 AC4: the legend explains the knowledge-branch drop as built in', () => {
  assert.equal(outcomeLegendKey({ status: 'dropped', reason: 'knowledge-branch' }), 'knowledge-branch');
  const t = outcomeTooltip({ status: 'dropped', reason: 'knowledge-branch' });
  assert.match(t, /knowledge-base branch/);
  assert.match(t, /can't be changed/);
});

// #2596: a pool pause/drain hold explains the role control, not the WIP lane.
test('outcomeTooltip: a pool hold points at the role, a WIP hold is unchanged', () => {
  assert.match(outcomeTooltip({ status: 'held', reason: 'pool-paused' }), /auto-scaled role.*paused, draining or off/);
  assert.match(outcomeTooltip({ status: 'held', reason: 'wip' }), /Work-in-Progress limit/);
});

// #2693: the poller stores a burst digest as `delivered` + `digest: true`, and
// the provisioning sweep writes `reaped` / `reap-failed` with `reason: null`.
test('#2693: outcomeLegendKey maps a delivered+digest outcome to the digest legend entry', () => {
  assert.equal(outcomeLegendKey({ status: 'delivered', digest: true }), 'digest');
  assert.equal(outcomeLegendKey({ status: 'delivered', digest: false }), 'delivered');
  assert.match(outcomeTooltip({ status: 'delivered', digest: true }), /folded into one summary wake/);
});

test('#2693: outcomeLegendKey maps sweep reaped / reap-failed to their own legend entries, never a drop', () => {
  assert.equal(outcomeLegendKey({ status: 'reaped', reason: null }), 'reaped');
  assert.equal(outcomeLegendKey({ status: 'reap-failed', reason: null }), 'reap-failed');
  const keys = OUTCOME_LEGEND.map(e => e.key);
  assert.ok(keys.includes('reaped') && keys.includes('reap-failed'));
  for (const status of ['reaped', 'reap-failed']) {
    const tip = outcomeTooltip({ status, reason: null });
    assert.doesNotMatch(tip, /Dropped by a protection layer/);
    assert.match(tip, /provisioning sweep/);
  }
});
