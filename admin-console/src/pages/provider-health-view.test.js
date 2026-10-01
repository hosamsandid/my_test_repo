import test from 'node:test';
import assert from 'node:assert/strict';
import {
  healthCellModel, healthCellDetail, providerWarningText, personalProviderNoticeText,
  providerBudgetWarningText, budgetCellModel, formatBudgetAmount, formatBudgetPct,
} from './provider-health-view.js';

test('healthCellModel: ok/error/unknown map to tones', () => {
  assert.deepEqual(healthCellModel({ status: 'ok' }), { label: 'OK', tone: 'ok' });
  assert.deepEqual(healthCellModel({ status: 'error' }), { label: 'Error', tone: 'error' });
  assert.deepEqual(healthCellModel({ status: 'unknown' }), { label: 'Unknown', tone: 'muted' });
  // AC6: no health object at all is honest 'unknown', never a guessed green.
  assert.deepEqual(healthCellModel(null), { label: 'Unknown', tone: 'muted' });
  assert.deepEqual(healthCellModel(undefined), { label: 'Unknown', tone: 'muted' });
});

test('healthCellDetail: reason on error, http on ok, hint on unknown', () => {
  assert.equal(healthCellDetail({ status: 'error', reason: 'HTTP 401 — bad token' }), 'HTTP 401 — bad token');
  assert.equal(healthCellDetail({ status: 'error', reason: null }), 'Unreachable');
  assert.equal(healthCellDetail({ status: 'ok', httpStatus: 200 }), 'HTTP 200');
  assert.equal(healthCellDetail({ status: 'ok', httpStatus: null }), 'Reachable');
  assert.equal(healthCellDetail({ status: 'unknown' }), 'Not yet checked');
  assert.equal(healthCellDetail(null), 'Not yet checked');
});

test('providerWarningText: only errors warn; unknown/ok are silent', () => {
  assert.equal(providerWarningText({ status: 'ok' }, 'GW'), null);
  assert.equal(providerWarningText({ status: 'unknown' }, 'GW'), null);
  assert.equal(providerWarningText(null, 'GW'), null);
  const w = providerWarningText({ status: 'error', reason: 'timeout' }, 'LiteLLM');
  assert.match(w, /LiteLLM/);
  assert.match(w, /timeout/);
  assert.match(w, /starting this agent may fail/);
});

test('providerWarningText: falls back gracefully with no name / no reason', () => {
  const w = providerWarningText({ status: 'error', reason: null }, '');
  assert.match(w, /the bound Model Provider/);
  assert.doesNotMatch(w, /\(\)/); // no empty parens when reason is absent
});

test('personalProviderNoticeText: null when there is nothing to say', () => {
  assert.equal(personalProviderNoticeText(null), null);
  assert.equal(personalProviderNoticeText(undefined), null);
  assert.equal(personalProviderNoticeText({ level: 'none' }), null);
  assert.equal(personalProviderNoticeText({}), null);
});

test('personalProviderNoticeText: warn is the fragile api-key lend', () => {
  const n = personalProviderNoticeText({ level: 'warn', identity: 'api-key', providerName: 'My Gateway' });
  assert.equal(n.tone, 'warn');
  assert.match(n.text, /My Gateway/);
  assert.match(n.text, /lend/);
  assert.match(n.text, /register a Team provider/i);
});

test('personalProviderNoticeText: block is the subscription-seat error', () => {
  const n = personalProviderNoticeText({ level: 'block', identity: 'oauth', providerName: 'My Sub' });
  assert.equal(n.tone, 'error');
  assert.match(n.text, /My Sub/);
  assert.match(n.text, /single-user seat/);
});

test('personalProviderNoticeText: graceful with no provider name', () => {
  const n = personalProviderNoticeText({ level: 'warn' });
  assert.match(n.text, /a member’s personal provider/);
});

// ─── #2732: provider budget ──────────────────────────────────────────────────

const teamBudget = { status: 'ok', source: 'team', spend: 1840, maxBudget: 2000, pct: 92, budgetDuration: '30d', resetAt: '2026-11-01T00:00:00Z' };

test('healthCellModel/Detail: warning is orange and names the budget reason (AC6)', () => {
  assert.deepEqual(healthCellModel({ status: 'warning' }), { label: 'Warning', tone: 'warning' });
  assert.equal(
    healthCellDetail({ status: 'warning', reason: 'Budget 92 % used ($1,840 / $2,000, team)' }),
    'Budget 92 % used ($1,840 / $2,000, team)',
  );
  assert.equal(healthCellDetail({ status: 'warning', reason: null }), 'Budget nearly used up');
});

test('budgetCellModel: spend / max, %, source and reset date (AC3)', () => {
  const m = budgetCellModel(teamBudget, 'warning');
  assert.equal(m.text, '$1,840 / $2,000');
  assert.equal(m.pct, '92 %');
  assert.equal(m.source, 'team');
  assert.equal(m.reset, '2026-11-01');
  assert.match(m.title, /Team budget/);
  assert.match(m.title, /resets 2026-11-01/);
  assert.equal(m.tone, 'warning');
  const key = budgetCellModel({ status: 'ok', source: 'key', spend: 291.94, maxBudget: 2000, pct: 14.597, budgetDuration: null, resetAt: null }, 'ok');
  assert.equal(key.text, '$291.94 / $2,000');
  assert.equal(key.pct, '14 %');
  assert.equal(key.source, 'key');
  assert.equal(key.reset, null);
  assert.equal(key.tone, 'ok');
  assert.doesNotMatch(key.title, /resets/);
});

test('budgetCellModel: the tone follows Health, ≥ 100 % is always red (AC8)', () => {
  assert.equal(budgetCellModel(teamBudget, 'ok').tone, 'ok');
  assert.equal(budgetCellModel(teamBudget, null).tone, 'ok'); // .env row: no health evaluated
  const over = budgetCellModel({ ...teamBudget, spend: 2080, pct: 104 }, 'error');
  assert.equal(over.pct, '104 %');
  assert.equal(over.tone, 'error');
});

test('budgetCellModel: no budget is a plain dash, a failed read adds a hint (AC4/AC5)', () => {
  for (const b of [null, undefined, { status: 'none' }]) {
    const m = budgetCellModel(b);
    assert.equal(m.text, '—');
    assert.equal(m.hint, null);
  }
  const failed = budgetCellModel({ status: 'unavailable', reason: 'HTTP 503' });
  assert.equal(failed.text, '—');
  assert.equal(failed.hint, 'Budget unavailable');
  assert.match(failed.title, /could not be read/);
  assert.match(failed.title, /HTTP 503/);
});

test('formatBudgetAmount / formatBudgetPct', () => {
  assert.equal(formatBudgetAmount(2000), '$2,000');
  assert.equal(formatBudgetAmount(291.94), '$291.94');
  assert.equal(formatBudgetAmount(0.5), '$0.50');
  assert.equal(formatBudgetPct(89.99), '89 %');
});

test('providerBudgetWarningText: only the Warning state, naming provider + % (AC9)', () => {
  const t = providerBudgetWarningText({ status: 'warning', budget: teamBudget }, 'DB API Key');
  assert.match(t, /DB API Key/);
  assert.match(t, /92 %/);
  assert.match(t, /team budget/);
  for (const h of [null, { status: 'ok', budget: teamBudget }, { status: 'unknown' }, { status: 'error', budget: teamBudget }, { status: 'ok', budget: { status: 'none' } }]) {
    assert.equal(providerBudgetWarningText(h, 'GW'), null);
  }
  // No name → still a sentence.
  assert.match(providerBudgetWarningText({ status: 'warning', budget: teamBudget }, ''), /^The bound Model Provider has used 92 %/);
});

test('providerWarningText: a used-up budget says so instead of "unreachable" (AC8)', () => {
  const w = providerWarningText({
    status: 'error', reason: 'Budget 104 % used ($2,080 / $2,000, key)',
    budget: { ...teamBudget, source: 'key', spend: 2080, pct: 104 },
  }, 'GW');
  assert.match(w, /used up its budget/);
  assert.match(w, /104 %/);
  assert.doesNotMatch(w, /unreachable/);
});
