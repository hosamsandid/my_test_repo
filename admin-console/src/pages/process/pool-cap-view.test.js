import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolCapView, poolControlUrl, livePoolCount } from './pool-cap-view.js';

// #2760 AC5 — a pooled role's live instance count against its cap.

test('poolCapView: under/at the cap reads "n / cap", not over', () => {
  assert.deepEqual(poolCapView(2, 3), { text: '2 / 3', over: false, title: '2 of at most 3 parallel instances' });
  assert.equal(poolCapView(3, 3).over, false, 'at the cap is not over it');
});

test('poolCapView: over the cap is marked and the tooltip says no new instance starts until below it', () => {
  const v = poolCapView(5, 3);
  assert.equal(v.text, '5 / 3');
  assert.equal(v.over, true);
  assert.match(v.title, /over the limit of 3/);
  assert.match(v.title, /Running instances are not stopped/);
  assert.match(v.title, /no new instance starts until the count is below 3/);
});

test('poolCapView: no cap (blank/invalid) shows the bare count and is never over', () => {
  for (const cap of [null, undefined, 0, -1, 2.5, '3']) {
    const v = poolCapView(4, cap);
    assert.equal(v.text, '4');
    assert.equal(v.over, false);
    assert.match(v.title, /no per-role cap/);
  }
  assert.match(poolCapView(1, null).title, /^1 live instance —/);
});

test('poolCapView: a nonsense count reads as 0', () => {
  assert.equal(poolCapView(undefined, 3).text, '0 / 3');
  assert.equal(poolCapView(-2, 3).text, '0 / 3');
});

test('poolControlUrl: only a saved, enabled pooled team member fetches its team\'s pool-control', () => {
  const m = { id: 't-dev', role: 'team-member', parentTeamId: 't 1', pool: { enabled: true } };
  assert.equal(poolControlUrl(m), '/api/teams/t%201/pool-control');
  assert.equal(poolControlUrl({ ...m, pool: null }), null);
  assert.equal(poolControlUrl({ ...m, pool: { enabled: false } }), null);
  assert.equal(poolControlUrl({ ...m, role: 'team' }), null);
  assert.equal(poolControlUrl({ ...m, parentTeamId: null }), null);
  assert.equal(poolControlUrl(null), null);
});

test('livePoolCount: picks the role row by agentId; null when absent or malformed', () => {
  const data = { roles: [
    { agentId: 't-qa', maxInstances: null, liveInstanceCount: 1 },
    { agentId: 't-dev', maxInstances: 3, liveInstanceCount: 5 },
  ] };
  assert.deepEqual(livePoolCount(data, 't-dev'), { count: 5, cap: 3, waiting: 0 });
  assert.deepEqual(livePoolCount(data, 't-qa'), { count: 1, cap: null, waiting: 0 });
  assert.equal(livePoolCount(data, 't-other'), null);
  assert.equal(livePoolCount(null, 't-dev'), null);
  assert.equal(livePoolCount({ roles: [{ agentId: 't-dev' }] }, 't-dev'), null);
});

// #2789 AC9 — instances waiting on an open PR are named apart from the active count.

test('poolCapView: waiting instances show apart — "2 / 3 active · 4 waiting", not over the cap', () => {
  const v = poolCapView(2, 3, 4);
  assert.equal(v.text, '2 / 3 active · 4 waiting');
  assert.equal(v.over, false, 'waiting instances are outside the cap');
  assert.match(v.title, /4 waiting on a PR/);
  assert.match(v.title, /not counted against the limit/);
  assert.equal(poolCapView(1, null, 2).text, '1 active · 2 waiting');
  assert.equal(poolCapView(2, 3, 0).text, '2 / 3', 'no waiting suffix without waiting instances');
  assert.equal(poolCapView(2, 3, -1).text, '2 / 3');
});

test('livePoolCount: carries the waiting count from the pool-control read', () => {
  const data = { roles: [{ agentId: 't-dev', maxInstances: 3, liveInstanceCount: 2, waitingInstanceCount: 4 }] };
  assert.deepEqual(livePoolCount(data, 't-dev'), { count: 2, cap: 3, waiting: 4 });
});
