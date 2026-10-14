import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  previousWindow, previousSummaryUrl, previousPeriodLabel, periodChange, tileComparison, CHANGE_COLOR,
  isPreviousSummaryFor,
} from './token-usage-compare.js';
import { rangeBounds } from './token-usage-range.js';
import { themeTokens, resolveToken, contrastRatio, THEMES } from '../theme/theme-tokens.js';

// #2976: each Statistics tile compares with the previous period of the same
// length (AC8) and marks the direction without relying on colour (AC9).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(HERE, 'TokenUsage.jsx'), 'utf8');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 14, 10, 30);

test('AC8: the previous window has the same length and ends where the current one starts', () => {
  for (const key of ['24h', 'today', 'yesterday', '7d', 'thisWeek', '30d', 'thisMonth', 'lastMonth', '90d']) {
    const cur = rangeBounds({ key }, NOW);
    const prev = previousWindow(cur);
    assert.equal(prev.end, cur.start, key);
    assert.equal(prev.end - prev.start, cur.end - cur.start, key);
    assert.equal(prev.until, new Date(cur.start).toISOString());
    assert.equal(prev.since, new Date(prev.start).toISOString());
  }
  const custom = rangeBounds({ key: 'custom', from: '2026-10-01', to: '2026-10-03' }, NOW);
  assert.deepEqual(
    [previousWindow(custom).since, previousWindow(custom).until],
    ['2026-09-28T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
  );
});

test('AC8: no comparison for All time', () => {
  assert.equal(previousWindow(rangeBounds({ key: 'all' }, NOW)), null);
  assert.equal(previousSummaryUrl(null, 't'), null);
});

test('the previous-period request is closed, team-scoped and only needs totals', () => {
  const prev = previousWindow({ start: NOW - 7 * DAY, end: NOW });
  const url = new URL(previousSummaryUrl(prev, 'team-a'), 'http://x');
  assert.equal(url.pathname, '/api/usage/summary');
  assert.equal(url.searchParams.get('since'), prev.since);
  assert.equal(url.searchParams.get('until'), prev.until);
  assert.equal(url.searchParams.get('team'), 'team-a');
  assert.equal(new URL(previousSummaryUrl(prev, ''), 'http://x').searchParams.has('team'), false);
  // a stale response (the hook keeps it while a new window loads) is ignored
  assert.equal(isPreviousSummaryFor({ since: prev.since, until: prev.until, totals: {} }, prev), true);
  assert.equal(isPreviousSummaryFor({ since: 'older', until: prev.until, totals: {} }, prev), false);
  assert.equal(isPreviousSummaryFor(null, prev), false);
});

test('AC8: change = (current − previous) / previous; previous 0 reads "new"', () => {
  assert.deepEqual(periodChange(112, 100), { kind: 'up', pct: 12, text: '▲ +12%' });
  assert.deepEqual(periodChange(75, 100), { kind: 'down', pct: -25, text: '▼ −25%' });
  assert.deepEqual(periodChange(100, 100), { kind: 'same', pct: 0, text: '±0%' });
  assert.equal(periodChange(5, 0).text, '▲ new');
  assert.equal(periodChange(5, 0).kind, 'new');
  assert.equal(periodChange(0, 0).kind, 'same');
  assert.equal(periodChange(0, 40).text, '▼ −100%');
  // a change that rounds to 0% still says which way it went
  assert.equal(periodChange(1001, 1000).text, '▲ +<1%');
});

test('the period names the window length', () => {
  assert.equal(previousPeriodLabel(7 * DAY), 'previous 7 days');
  assert.equal(previousPeriodLabel(DAY), 'previous 24 hours');
  assert.equal(previousPeriodLabel(10.5 * 60 * 60 * 1000), 'previous 10.5 hours');
  assert.equal(previousPeriodLabel(2.5 * DAY), 'previous 2.5 days');
  assert.equal(previousPeriodLabel(30 * DAY), 'previous 30 days');
  const tile = tileComparison(112, 100, 7 * DAY, (n) => `#${n}`);
  assert.equal(tile.text, '▲ +12% vs previous 7 days');
  assert.equal(tile.title, 'Previous 7 days: #100');
  assert.equal(tile.color, CHANGE_COLOR.up);
  assert.equal(tileComparison(112, null, 7 * DAY), null, 'not loaded yet');
});

test('AC9: direction is told by arrow and sign, not colour alone', () => {
  for (const [cur, prev] of [[2, 1], [1, 2], [1, 0]]) {
    const { text } = periodChange(cur, prev);
    assert.match(text, /^[▲▼] /);
  }
  assert.match(periodChange(2, 1).text, /\+/);
  assert.match(periodChange(1, 2).text, /−/);
});

test('AC9: every comparison colour meets WCAG AA (4.5:1) on the tile in all three themes', () => {
  const tokens = themeTokens(fs.readFileSync(path.join(HERE, '..', 'theme', 'tokens.css'), 'utf8'));
  for (const theme of THEMES) {
    const surface = resolveToken(tokens[theme], '--eb-bg-elevated');
    for (const [kind, value] of Object.entries(CHANGE_COLOR)) {
      const name = /^var\((--[\w-]+)\)$/.exec(value)[1];
      const ratio = contrastRatio(resolveToken(tokens[theme], name), surface);
      assert.ok(ratio >= 4.5, `${theme} ${kind} ${name}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test('every stat tile gets its comparison; All time gets none', () => {
  for (const key of ['total', 'invocations']) assert.match(PAGE, new RegExp(`delta=\\{deltaFor\\('${key}'\\)\\}`));
  assert.match(PAGE, /delta=\{deltaFor\(c\.key\)\}/);
  assert.match(PAGE, /const prevWindow = useMemo\(\(\) => previousWindow\(\{ start, end \}\), \[start, end\]\);/);
  assert.match(PAGE, /useApi\(previousSummaryUrl\(prevWindow, team\)\)/);
  assert.match(PAGE, /isPreviousSummaryFor\(prevSummary, prevWindow\)/);
});
