'use strict';

// Tests for the pure Model Provider budget lookup (#2732).
// Run: node --test admin-console/api/llm-budget.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('./llm-budget');

const TOKEN = 'sk-secret-LvBQ';
const BASE = 'https://litellm.example.com';

// A fake httpGetJson: routes by URL, records every call.
function fakeGet(routes) {
  const calls = [];
  const get = async (url, headers, timeoutMs) => {
    calls.push({ url, headers, timeoutMs });
    for (const [prefix, res] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return typeof res === 'function' ? res(url) : res;
    }
    return { status: 404, body: { detail: 'Not Found' }, error: null };
  };
  return { get, calls };
}

const keyInfo = (info) => ({ status: 200, body: { key: 'hashed', info }, error: null });
const teamInfo = (team_info) => ({ status: 200, body: { team_id: 't1', team_info }, error: null });

test('budget URLs live at the proxy root, whatever API suffix the Base URL carries', () => {
  for (const base of [BASE, `${BASE}/`, `${BASE}/v1`, `${BASE}/v1/`, `${BASE}/v1/models`]) {
    assert.equal(B.buildKeyInfoUrl(base), `${BASE}/key/info`, base);
  }
  assert.equal(B.buildKeyInfoUrl('https://gw.example.com/litellm/v1'), 'https://gw.example.com/litellm/key/info');
  assert.equal(B.buildTeamInfoUrl(BASE, 'a b/c'), `${BASE}/team/info?team_id=a%20b%2Fc`);
});

test('readBudget: only a non-null, positive max_budget counts (AC2)', () => {
  assert.equal(B.readBudget({ max_budget: null, spend: 5 }, 'key'), null);
  assert.equal(B.readBudget({ max_budget: 0, spend: 5 }, 'key'), null);
  assert.equal(B.readBudget({ max_budget: -1 }, 'key'), null);
  assert.equal(B.readBudget({ spend: 5 }, 'key'), null);
  assert.equal(B.readBudget(null, 'key'), null);
  assert.deepEqual(
    B.readBudget({ max_budget: 2000.0, spend: 291.94, budget_duration: '30d', budget_reset_at: '2026-11-01T00:00:00Z' }, 'key'),
    { source: 'key', spend: 291.94, maxBudget: 2000, budgetDuration: '30d', resetAt: '2026-11-01T00:00:00Z' },
  );
  // A missing spend reads as nothing spent yet.
  assert.equal(B.readBudget({ max_budget: 10 }, 'team').spend, 0);
});

test('effectiveBudget: the higher usage % wins, ties go to the key (AC2 + edge cases)', () => {
  const key = { source: 'key', spend: 100, maxBudget: 1000 };   // 10 %
  const team = { source: 'team', spend: 900, maxBudget: 1000 }; // 90 %
  assert.equal(B.effectiveBudget(key, team), team);
  assert.equal(B.effectiveBudget({ ...key, spend: 950 }, team).source, 'key');
  assert.equal(B.effectiveBudget({ source: 'key', spend: 90, maxBudget: 100 }, team).source, 'key'); // tie
  assert.equal(B.effectiveBudget(key, null), key);
  assert.equal(B.effectiveBudget(null, team), team);
  assert.equal(B.effectiveBudget(null, null), null);
});

test('lookupBudget: key budget only, never sends the token anywhere but the header (AC1/AC12)', async () => {
  const { get, calls } = fakeGet({
    [`${BASE}/key/info`]: keyInfo({ max_budget: 2000, spend: 291.94, budget_duration: '30d', budget_reset_at: '2026-11-01T00:00:00Z', team_id: null }),
  });
  const r = await B.lookupBudget({ baseUrl: `${BASE}/v1`, token: TOKEN, authType: 'api-key' }, get);
  assert.deepEqual(r, { status: 'ok', budget: { source: 'key', spend: 291.94, maxBudget: 2000, budgetDuration: '30d', resetAt: '2026-11-01T00:00:00Z' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].timeoutMs, B.BUDGET_TIMEOUT_MS);
  assert.ok(!calls[0].url.includes(TOKEN));
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test('lookupBudget: reads the team budget and picks the tighter one (AC1/AC2)', async () => {
  const { get, calls } = fakeGet({
    [`${BASE}/key/info`]: keyInfo({ max_budget: 2000, spend: 291.94, team_id: 't1' }),
    [`${BASE}/team/info`]: teamInfo({ max_budget: 2000, spend: 1840, budget_reset_at: '2026-10-15T00:00:00Z' }),
  });
  const r = await B.lookupBudget({ baseUrl: BASE, token: TOKEN, authType: 'api-key' }, get);
  assert.equal(r.status, 'ok');
  assert.equal(r.budget.source, 'team');
  assert.equal(r.budget.spend, 1840);
  assert.equal(r.budget.resetAt, '2026-10-15T00:00:00Z');
  assert.equal(calls[1].url, `${BASE}/team/info?team_id=t1`);
});

test('lookupBudget: key has no budget but its team does → team (edge case)', async () => {
  const { get } = fakeGet({
    [`${BASE}/key/info`]: keyInfo({ max_budget: null, spend: 12, team_id: 't1' }),
    [`${BASE}/team/info`]: teamInfo({ max_budget: 500, spend: 100 }),
  });
  const r = await B.lookupBudget({ baseUrl: BASE, token: TOKEN }, get);
  assert.equal(r.budget.source, 'team');
});

test('lookupBudget: no budget anywhere / no budget API → none (AC4)', async () => {
  const nullBoth = fakeGet({
    [`${BASE}/key/info`]: keyInfo({ max_budget: null, spend: 12, team_id: 't1' }),
    [`${BASE}/team/info`]: teamInfo({ max_budget: null, spend: 3 }),
  });
  assert.deepEqual(await B.lookupBudget({ baseUrl: BASE, token: TOKEN }, nullBoth.get), { status: 'none' });
  // 404 / 405: the proxy has no such route.
  assert.deepEqual(await B.lookupBudget({ baseUrl: BASE, token: TOKEN }, fakeGet({}).get), { status: 'none' });
  const m405 = fakeGet({ [`${BASE}/key/info`]: { status: 405, body: null, error: null } });
  assert.deepEqual(await B.lookupBudget({ baseUrl: BASE, token: TOKEN }, m405.get), { status: 'none' });
  // 200 from something that isn't LiteLLM.
  const other = fakeGet({ [`${BASE}/key/info`]: { status: 200, body: '<html>', error: null } });
  assert.deepEqual(await B.lookupBudget({ baseUrl: BASE, token: TOKEN }, other.get), { status: 'none' });
});

test('lookupBudget: OAuth subscription and token-less providers are never queried (AC4)', async () => {
  const { get, calls } = fakeGet({});
  assert.deepEqual(await B.lookupBudget({ baseUrl: '', token: TOKEN, authType: 'oauth-token' }, get), { status: 'none' });
  assert.deepEqual(await B.lookupBudget({ baseUrl: BASE, token: '', authType: 'api-key' }, get), { status: 'none' });
  assert.equal(calls.length, 0);
});

test('lookupBudget: a failing read is unavailable, with a reason (AC5)', async () => {
  const timeout = fakeGet({ [`${BASE}/key/info`]: { status: 0, body: null, error: 'Request timed out' } });
  assert.deepEqual(await B.lookupBudget({ baseUrl: BASE, token: TOKEN }, timeout.get), { status: 'unavailable', reason: 'Request timed out' });
  const http500 = fakeGet({ [`${BASE}/key/info`]: { status: 500, body: {}, error: null } });
  assert.deepEqual(await B.lookupBudget({ baseUrl: BASE, token: TOKEN }, http500.get), { status: 'unavailable', reason: 'HTTP 500' });
  const http401 = fakeGet({ [`${BASE}/key/info`]: { status: 401, body: {}, error: null } });
  assert.equal((await B.lookupBudget({ baseUrl: BASE, token: TOKEN }, http401.get)).status, 'unavailable');
});

test('lookupBudget: a failed team read keeps a known key budget, else is unavailable', async () => {
  const withKey = fakeGet({
    [`${BASE}/key/info`]: keyInfo({ max_budget: 100, spend: 10, team_id: 't1' }),
    [`${BASE}/team/info`]: { status: 503, body: null, error: null },
  });
  const r1 = await B.lookupBudget({ baseUrl: BASE, token: TOKEN }, withKey.get);
  assert.equal(r1.status, 'ok');
  assert.equal(r1.budget.source, 'key');
  const noKey = fakeGet({
    [`${BASE}/key/info`]: keyInfo({ max_budget: null, team_id: 't1' }),
    [`${BASE}/team/info`]: { status: 503, body: null, error: null },
  });
  assert.deepEqual(await B.lookupBudget({ baseUrl: BASE, token: TOKEN }, noKey.get), { status: 'unavailable', reason: 'HTTP 503' });
});

test('formatting: amounts, floored %, and the health reason line (AC3/AC6)', () => {
  assert.equal(B.formatAmount(291.94), '$291.94');
  assert.equal(B.formatAmount(2000), '$2,000');
  assert.equal(B.formatAmount(1840.5), '$1,840.50');
  assert.equal(B.formatPct(89.99), '89 %');
  assert.equal(B.budgetReason({ source: 'team', spend: 1840, maxBudget: 2000 }), 'Budget 92 % used ($1,840 / $2,000, team)');
  assert.equal(B.budgetReason({ source: 'key', spend: 2080, maxBudget: 2000 }), 'Budget 104 % used ($2,080 / $2,000, key)');
});

test('budgetView: ok / none / unavailable / never looked up', () => {
  assert.equal(B.budgetView(null), null);
  assert.equal(B.budgetView(undefined), null);
  assert.deepEqual(B.budgetView({ status: 'none' }), { status: 'none' });
  assert.deepEqual(B.budgetView({ status: 'unavailable', reason: 'HTTP 500' }), { status: 'unavailable', reason: 'HTTP 500' });
  assert.deepEqual(
    B.budgetView({ status: 'ok', budget: { source: 'key', spend: 50, maxBudget: 200, budgetDuration: '30d', resetAt: null } }),
    { status: 'ok', source: 'key', spend: 50, maxBudget: 200, pct: 25, budgetDuration: '30d', resetAt: null },
  );
});

test('coercePct: positive numbers pass, everything else falls back to 90', () => {
  assert.equal(B.coercePct('80'), 80);
  assert.equal(B.coercePct(0), 90);
  assert.equal(B.coercePct(undefined), 90);
  assert.equal(B.coercePct('abc'), 90);
});
