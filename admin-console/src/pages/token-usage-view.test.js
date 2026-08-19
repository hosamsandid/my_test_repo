import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOKEN_CLASSES,
  GROUP_OPTIONS,
  formatInt,
  formatCompact,
  formatTileCount,
  niceScale,
  buildDaySeries,
  stackSegments,
  sanitizeHiddenClasses,
  isClassVisible,
  toggleHiddenClass,
  visibleClassList,
  visibleTotalTokens,
  visibleMaxTotal,
  hiddenStorageKey,
  loadHiddenClasses,
  saveHiddenClasses,
  buildExportUrl,
  workItemAverages,
  WORK_ITEM_TILE_HELP,
  STAT_TILE_HELP,
  TIER_SIGNAL_HELP,
  COST_NOTE,
  PAGE_INTRO,
} from './token-usage-view.js';

test('TOKEN_CLASSES matches the four-class API contract, in display order', () => {
  assert.deepEqual(TOKEN_CLASSES.map((c) => c.key), [
    'input', 'output', 'cacheCreationInput', 'cacheReadInput',
  ]);
});

test('GROUP_OPTIONS covers every groupBy the summary endpoint supports', () => {
  assert.deepEqual(GROUP_OPTIONS.map((g) => g.key).sort(), [
    'agent', 'day', 'model', 'provider', 'team',
  ]);
});

test('formatInt separates thousands and coerces junk to 0', () => {
  assert.equal(formatInt(29736), '29,736');
  assert.equal(formatInt(0), '0');
  assert.equal(formatInt(undefined), '0');
  assert.equal(formatInt(NaN), '0');
});

test('formatCompact abbreviates with k/M/B, one decimal only when it adds info', () => {
  assert.equal(formatCompact(156_000_000), '156M');
  assert.equal(formatCompact(9_300_000), '9.3M');
  assert.equal(formatCompact(500_000), '500k');
  assert.equal(formatCompact(1_500), '1.5k');
  assert.equal(formatCompact(1_000), '1k');
  assert.equal(formatCompact(2_500_000_000), '2.5B');
  // Under 1,000 → plain integer; junk → 0.
  assert.equal(formatCompact(999), '999');
  assert.equal(formatCompact(0), '0');
  assert.equal(formatCompact(undefined), '0');
  assert.equal(formatCompact(NaN), '0');
});

test('formatTileCount abbreviates the KPI tiles with k/M/B/T at up to two trimmed decimals (#1656 AC1/AC2)', () => {
  // The screenshot figures the ticket cites, rounded to two decimals.
  assert.equal(formatTileCount(1_206_966_533), '1.21B');
  assert.equal(formatTileCount(958_717_975), '958.72M');
  assert.equal(formatTileCount(301_716), '301.72k');
  // Trailing zeros trimmed — "two decimals" is an upper bound, not a fixed width.
  assert.equal(formatTileCount(1_200_000_000), '1.2B');
  assert.equal(formatTileCount(9_300_000), '9.3M');
  // A trillions-range total still fits with the T unit (AC4 edge case).
  assert.equal(formatTileCount(2_500_000_000_000), '2.5T');
});

test('formatTileCount renders exact unit boundaries with the higher unit, trimmed (#1656 edge cases)', () => {
  assert.equal(formatTileCount(1000), '1k');
  assert.equal(formatTileCount(1e6), '1M');
  assert.equal(formatTileCount(1e9), '1B');
  assert.equal(formatTileCount(1e12), '1T');
});

test('formatTileCount keeps values below 1,000 as plain integers, junk as 0 (#1656 AC3)', () => {
  assert.equal(formatTileCount(385), '385');
  assert.equal(formatTileCount(999), '999');
  assert.equal(formatTileCount(0), '0');
  assert.equal(formatTileCount(undefined), '0');
  assert.equal(formatTileCount(null), '0');
  assert.equal(formatTileCount(NaN), '0');
  assert.equal(formatTileCount(Infinity), '0');
});

test('formatTileCount never produces a broken string for an unexpected negative (#1656 edge case)', () => {
  assert.equal(formatTileCount(-500), '-500');
  assert.equal(formatTileCount(-1_206_966_533), '-1.21B');
});

test('niceScale picks a round top ≥ max with ~3–5 evenly spaced ticks from 0', () => {
  for (const max of [800, 28936, 156_000_000, 7, 250000, 9_300_000]) {
    const { top, ticks } = niceScale(max);
    assert.ok(top >= max, `top ${top} must be ≥ max ${max} (a bar can never overflow)`);
    assert.equal(ticks[0], 0, 'axis starts at 0');
    assert.equal(ticks[ticks.length - 1], top, 'axis ends at the top tick');
    assert.ok(ticks.length >= 3 && ticks.length <= 6, `tick count ${ticks.length} in range`);
    // Evenly spaced.
    const step = ticks[1] - ticks[0];
    for (let i = 1; i < ticks.length; i++) {
      assert.equal(ticks[i] - ticks[i - 1], step, 'ticks evenly spaced');
    }
  }
});

test('niceScale produces recognisable round scales for known ranges', () => {
  assert.deepEqual(niceScale(28936), { top: 30000, ticks: [0, 10000, 20000, 30000] });
  assert.deepEqual(niceScale(800), { top: 800, ticks: [0, 200, 400, 600, 800] });
  assert.deepEqual(niceScale(156_000_000), {
    top: 200_000_000, ticks: [0, 50_000_000, 100_000_000, 150_000_000, 200_000_000],
  });
});

test('niceScale renders a flat 0-baseline axis for zero/near-zero/junk (no divide-by-zero)', () => {
  assert.deepEqual(niceScale(0), { top: 0, ticks: [0] });
  assert.deepEqual(niceScale(-5), { top: 0, ticks: [0] });
  assert.deepEqual(niceScale(NaN), { top: 0, ticks: [0] });
  assert.deepEqual(niceScale(undefined), { top: 0, ticks: [0] });
});

test('buildDaySeries orders points by day ascending and finds the max total', () => {
  const summary = {
    groups: [
      { key: '2026-07-16', tokens: { total: 28936 }, invocations: 2 },
      { key: '2026-07-15', tokens: { total: 800 }, invocations: 1 },
    ],
  };
  const { points, maxTotal } = buildDaySeries(summary);
  assert.deepEqual(points.map((p) => p.day), ['2026-07-15', '2026-07-16']);
  assert.equal(maxTotal, 28936);
});

test('buildDaySeries tolerates missing/empty groups', () => {
  assert.deepEqual(buildDaySeries(null), { points: [], maxTotal: 0 });
  assert.deepEqual(buildDaySeries({ groups: [] }), { points: [], maxTotal: 0 });
});

test('stackSegments scales each nonzero class to a percent of maxTotal', () => {
  const tokens = { input: 10, output: 0, cacheCreationInput: 40, cacheReadInput: 50, total: 100 };
  const segs = stackSegments(tokens, 100);
  // output (0) is dropped; the rest are kept in display order.
  assert.deepEqual(segs.map((s) => s.key), ['input', 'cacheCreationInput', 'cacheReadInput']);
  assert.deepEqual(segs.map((s) => s.heightPct), [10, 40, 50]);
});

test('stackSegments returns nothing when maxTotal is 0 (no divide-by-zero)', () => {
  assert.deepEqual(stackSegments({ input: 5 }, 0), []);
});

/* ── Per-series visibility toggles (#1707) ─────────────────────────── */

test('sanitizeHiddenClasses keeps only valid keys, de-duped, in display order', () => {
  assert.deepEqual(sanitizeHiddenClasses(['output', 'input', 'bogus', 'input']), ['input', 'output']);
  assert.deepEqual(sanitizeHiddenClasses(new Set(['cacheReadInput'])), ['cacheReadInput']);
  // Junk / non-iterables collapse to "nothing hidden".
  assert.deepEqual(sanitizeHiddenClasses(null), []);
  assert.deepEqual(sanitizeHiddenClasses('input'), []);
});

test('isClassVisible defaults to visible and hides only listed classes', () => {
  // Nothing hidden → all four visible (AC9).
  for (const c of TOKEN_CLASSES) assert.equal(isClassVisible([], c.key), true);
  assert.equal(isClassVisible(['cacheReadInput'], 'cacheReadInput'), false);
  assert.equal(isClassVisible(['cacheReadInput'], 'input'), true);
});

test('toggleHiddenClass flips one class immutably and ignores unknown keys', () => {
  const start = [];
  const hidCache = toggleHiddenClass(start, 'cacheReadInput');
  assert.deepEqual(hidCache, ['cacheReadInput']);
  assert.deepEqual(start, []); // original untouched
  // Toggling again restores it (AC2).
  assert.deepEqual(toggleHiddenClass(hidCache, 'cacheReadInput'), []);
  // Unknown key is a no-op (returns the sanitized current set).
  assert.deepEqual(toggleHiddenClass(['output'], 'nope'), ['output']);
});

test('visibleClassList drops hidden classes; empty when all hidden', () => {
  assert.deepEqual(visibleClassList([]).map((c) => c.key), TOKEN_CLASSES.map((c) => c.key));
  assert.deepEqual(visibleClassList(['input', 'output']).map((c) => c.key), ['cacheCreationInput', 'cacheReadInput']);
  assert.deepEqual(visibleClassList(TOKEN_CLASSES.map((c) => c.key)), []);
});

test('visibleTotalTokens sums only visible classes (AC4)', () => {
  const tokens = { input: 10, output: 20, cacheCreationInput: 300, cacheReadInput: 4000, total: 4330 };
  assert.equal(visibleTotalTokens(tokens, []), 4330);
  // Hiding the dominant cache-read series drops it from the total.
  assert.equal(visibleTotalTokens(tokens, ['cacheReadInput']), 330);
  assert.equal(visibleTotalTokens(tokens, ['cacheReadInput', 'cacheCreationInput']), 30);
  assert.equal(visibleTotalTokens(tokens, TOKEN_CLASSES.map((c) => c.key)), 0);
});

test('visibleMaxTotal rescales the axis to the visible classes (AC5)', () => {
  const points = [
    { tokens: { input: 9_000_000, cacheReadInput: 2_230_000_000 } },
    { tokens: { input: 5_000_000, cacheReadInput: 1_000_000_000 } },
  ];
  // All visible → dominated by cache read.
  assert.equal(visibleMaxTotal(points, []), 2_239_000_000);
  // Hide cache read → the axis zooms into the Input scale.
  assert.equal(visibleMaxTotal(points, ['cacheReadInput']), 9_000_000);
  // Everything hidden → flat 0 (niceScale then yields a 0-baseline axis).
  assert.equal(visibleMaxTotal(points, TOKEN_CLASSES.map((c) => c.key)), 0);
  assert.equal(visibleMaxTotal([], []), 0);
});

test('stackSegments omits hidden classes from a day column (AC4)', () => {
  const tokens = { input: 10, output: 0, cacheCreationInput: 40, cacheReadInput: 50, total: 100 };
  const segs = stackSegments(tokens, 100, ['cacheReadInput']);
  // cacheReadInput hidden; output (0) still dropped; rest kept in display order.
  assert.deepEqual(segs.map((s) => s.key), ['input', 'cacheCreationInput']);
  // Omitting the hidden arg keeps the legacy "all visible" behaviour.
  assert.deepEqual(
    stackSegments(tokens, 100).map((s) => s.key),
    ['input', 'cacheCreationInput', 'cacheReadInput'],
  );
});

test('hidden-set persistence round-trips through an injectable store, per username', () => {
  const store = (() => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  })();
  assert.equal(hiddenStorageKey('alice'), 'tokenUsage.hiddenSeries.alice');
  // Unset → all visible.
  assert.deepEqual(loadHiddenClasses('alice', store), []);
  saveHiddenClasses('alice', ['cacheReadInput', 'bogus'], store);
  // Saved value is sanitized; a different user is unaffected.
  assert.deepEqual(loadHiddenClasses('alice', store), ['cacheReadInput']);
  assert.deepEqual(loadHiddenClasses('bob', store), []);
});

test('loadHiddenClasses tolerates corrupt stored JSON', () => {
  const store = { getItem: () => '{not json', setItem: () => {} };
  assert.deepEqual(loadHiddenClasses('x', store), []);
});

test('buildExportUrl builds a scoped, windowed download URL per view and format', () => {
  assert.equal(
    buildExportUrl('summary', { since: '2026-07-16T00:00:00Z', format: 'csv' }),
    '/api/usage/summary/export?since=2026-07-16T00%3A00%3A00Z&format=csv',
  );
  assert.equal(
    buildExportUrl('work-items', { format: 'json' }),
    '/api/usage/work-items/export?format=json',
  );
  // Unknown/absent format defaults to csv; absent since is simply omitted.
  assert.equal(buildExportUrl('summary', {}), '/api/usage/summary/export?format=csv');
  assert.equal(buildExportUrl('summary', { format: 'xml' }), '/api/usage/summary/export?format=csv');
});
test('buildExportUrl carries the team filter and omits it for "all teams" (#801)', () => {
  assert.equal(
    buildExportUrl('summary', { since: '2026-07-16T00:00:00Z', format: 'json', team: 'payments' }),
    '/api/usage/summary/export?since=2026-07-16T00%3A00%3A00Z&team=payments&format=json',
  );
  assert.equal(
    buildExportUrl('work-items', { team: 'risk' }),
    '/api/usage/work-items/export?team=risk&format=csv',
  );
  // Blank / absent team → omitted (all teams, unfiltered).
  assert.equal(buildExportUrl('summary', { team: '' }), '/api/usage/summary/export?format=csv');
  assert.equal(buildExportUrl('summary', {}), '/api/usage/summary/export?format=csv');
});

test('workItemAverages returns rounded total/input/output means over the attributed work-item count', () => {
  const data = {
    workItems: [
      { tokens: { total: 100, input: 60, output: 40 } },
      { tokens: { total: 300, input: 180, output: 120 } },
      { tokens: { total: 200, input: 90, output: 110 } },
    ],
  };
  const avg = workItemAverages(data);
  assert.equal(avg.count, 3);
  assert.equal(avg.total, 200);  // (100+300+200)/3
  assert.equal(avg.input, 110);  // (60+180+90)/3
  assert.equal(avg.output, 90);  // (40+120+110)/3
});

test('workItemAverages returns rounded cache-write/cache-read means over the attributed work-item count (#1626)', () => {
  const data = {
    workItems: [
      { tokens: { total: 500, input: 60, output: 40, cacheCreationInput: 200, cacheReadInput: 200 } },
      { tokens: { total: 900, input: 180, output: 120, cacheCreationInput: 300, cacheReadInput: 300 } },
      { tokens: { total: 700, input: 90, output: 110, cacheCreationInput: 250, cacheReadInput: 250 } },
    ],
  };
  const avg = workItemAverages(data);
  assert.equal(avg.cacheCreationInput, 250);  // (200+300+250)/3
  assert.equal(avg.cacheReadInput, 250);      // (200+300+250)/3
  // AC4: the four class averages reconcile with Ø total (per-tile integer rounding).
  assert.equal(avg.input + avg.output + avg.cacheCreationInput + avg.cacheReadInput, avg.total);
});

test('workItemAverages rounds the cache averages to the nearest integer (#1626)', () => {
  const avg = workItemAverages({
    workItems: [
      { tokens: { cacheCreationInput: 10, cacheReadInput: 10 } },
      { tokens: { cacheCreationInput: 11, cacheReadInput: 0 } },
    ],
  });
  assert.equal(avg.cacheCreationInput, 11);  // 21/2 = 10.5 → 11
  assert.equal(avg.cacheReadInput, 5);       // 10/2 = 5
});

test('workItemAverages rounds to the nearest integer (never a fraction)', () => {
  const avg = workItemAverages({
    workItems: [
      { tokens: { total: 10, input: 10, output: 0 } },
      { tokens: { total: 11, input: 0, output: 11 } },
    ],
  });
  // 21/2 = 10.5 → 11 (round half up), 10/2 = 5, 11/2 = 5.5 → 6
  assert.equal(avg.total, 11);
  assert.equal(avg.input, 5);
  assert.equal(avg.output, 6);
});

test('workItemAverages Ø-total shares the numerator with coverage.tokens.attributed (AC3)', () => {
  const data = {
    coverage: { tokens: { attributed: 450 } },
    workItems: [
      { tokens: { total: 150, input: 100, output: 50 } },
      { tokens: { total: 300, input: 200, output: 100 } },
    ],
  };
  const avg = workItemAverages(data);
  assert.equal(avg.total, Math.round(data.coverage.tokens.attributed / avg.count));
});

test('workItemAverages yields null averages (no NaN/Infinity) for zero work items', () => {
  for (const data of [undefined, {}, { workItems: [] }, { workItems: null }]) {
    const avg = workItemAverages(data);
    assert.equal(avg.count, 0);
    assert.equal(avg.total, null);
    assert.equal(avg.input, null);
    assert.equal(avg.output, null);
    assert.equal(avg.cacheCreationInput, null);
    assert.equal(avg.cacheReadInput, null);
  }
});

test('workItemAverages tolerates missing/partial token fields', () => {
  const avg = workItemAverages({
    workItems: [
      { tokens: { total: 100, input: 100 } },  // no output
      {},                                        // no tokens at all
    ],
  });
  assert.equal(avg.count, 2);
  assert.equal(avg.total, 50);
  assert.equal(avg.input, 50);
  assert.equal(avg.output, 0);
});

/* ── Work-items tile help copy (#832) ──────────────────────────────── */
// The ten ids the Work-items summary row wires into StatCard.help, in the
// on-screen order. Keeping this list in the test guards against a tile losing
// its help affordance (AC1/AC2) when the row is edited.
const WORK_ITEM_TILE_IDS = [
  'attributed', 'attributedTokens', 'unattributedTokens', 'unattributedRuns',
  'totalRuns', 'avgTotal', 'avgInput', 'avgOutput',
  'avgCacheCreationInput', 'avgCacheReadInput',
];

test('WORK_ITEM_TILE_HELP carries help for all ten Work-items tiles (AC1/AC2)', () => {
  assert.deepEqual(Object.keys(WORK_ITEM_TILE_HELP).sort(), [...WORK_ITEM_TILE_IDS].sort());
  for (const id of WORK_ITEM_TILE_IDS) {
    const text = WORK_ITEM_TILE_HELP[id];
    assert.equal(typeof text, 'string', `${id} help must be a string`);
    assert.ok(text.trim().length > 0, `${id} help must not be empty`);
  }
});

test('attributed/unattributed help defines a work item as an issue↔PR chain (AC4)', () => {
  // A work item = a GitHub issue and the PR(s) resolving it. The attributed
  // tiles must say so in plain language.
  assert.match(WORK_ITEM_TILE_HELP.attributed, /issue/i);
  assert.match(WORK_ITEM_TILE_HELP.attributed, /pull request|PR/i);
  assert.match(WORK_ITEM_TILE_HELP.attributedTokens, /issue ↔ PR|issue.*PR/i);
  // Unattributed = could NOT be tied to a single work item; names real causes.
  assert.match(WORK_ITEM_TILE_HELP.unattributedTokens, /could not be tied|not linked/i);
  assert.match(WORK_ITEM_TILE_HELP.unattributedRuns, /could not be attributed/i);
});

test('Ø …/work item help states per attributed work item, excluding unattributed (AC5)', () => {
  for (const id of ['avgTotal', 'avgInput', 'avgOutput', 'avgCacheCreationInput', 'avgCacheReadInput']) {
    assert.match(WORK_ITEM_TILE_HELP[id], /attributed work item/i, `${id} must say "attributed work item"`);
    assert.match(WORK_ITEM_TILE_HELP[id], /excluded/i, `${id} must state unattributed tokens are excluded`);
  }
});

test('avgTotal help no longer claims the total is "(input + output)" only (#1626 AC6)', () => {
  assert.doesNotMatch(WORK_ITEM_TILE_HELP.avgTotal, /\(input \+ output\)/);
  // It reflects that the total includes input, output and both cache classes.
  assert.match(WORK_ITEM_TILE_HELP.avgTotal, /cache/i);
});


// The six Statistics-tab tiles that must carry a help affordance (#1151):
// the two totals plus every TOKEN_CLASS. Guards against a tile losing its
// InfoTip when the summary row is edited.
const STAT_TILE_IDS = ['total', 'invocations', ...TOKEN_CLASSES.map((c) => c.key)];

test('STAT_TILE_HELP carries non-empty help for every Statistics tile (#1151 AC2)', () => {
  assert.deepEqual(Object.keys(STAT_TILE_HELP).sort(), [...STAT_TILE_IDS].sort());
  for (const id of STAT_TILE_IDS) {
    const text = STAT_TILE_HELP[id];
    assert.equal(typeof text, 'string', `${id} help must be a string`);
    assert.ok(text.trim().length > 0, `${id} help must not be empty`);
  }
});

test('STAT_TILE_HELP explains the Cache write/read jargon in plain language (#1151 AC2)', () => {
  assert.match(STAT_TILE_HELP.cacheCreationInput, /cache/i);
  assert.match(STAT_TILE_HELP.cacheReadInput, /cache/i);
  // The whole point is that a read is cheaper than re-sending the context.
  assert.match(STAT_TILE_HELP.cacheReadInput, /re-sent|costs less|cheap/i);
});

test('TIER_SIGNAL_HELP names all four TIER_LABEL signals, strongest first (#1151 AC3)', () => {
  for (const label of ['flow', 'created', 'event', 'branch']) {
    assert.match(TIER_SIGNAL_HELP, new RegExp(label, 'i'), `must mention "${label}"`);
  }
  // "flow" is the strongest signal, "branch" the weakest — order matters.
  assert.ok(
    TIER_SIGNAL_HELP.indexOf('flow') < TIER_SIGNAL_HELP.indexOf('branch'),
    'signals must be listed strongest-first',
  );
  assert.match(TIER_SIGNAL_HELP, /attribution/i);
});

test('COST_NOTE states figures are token counts, not costs (#1151 AC1)', () => {
  assert.equal(typeof COST_NOTE, 'string');
  assert.match(COST_NOTE, /not cost/i);
  assert.match(COST_NOTE, /pric/i);
});

test('PAGE_INTRO is a plain-language banner that frames the page and both tabs', () => {
  for (const key of ['lead', 'statistics', 'workItems']) {
    assert.equal(typeof PAGE_INTRO[key], 'string', `${key} must be a string`);
    assert.ok(PAGE_INTRO[key].trim().length > 0, `${key} must be non-empty`);
  }
  // The lead explains what the page is about (tokens/usage), in plain words.
  assert.match(PAGE_INTRO.lead, /token/i);
  // Each tab description leads with the exact tab label the TABS array renders,
  // so the banner and the tab strip can never drift apart.
  assert.match(PAGE_INTRO.statistics, /^Statistics\b/);
  assert.match(PAGE_INTRO.workItems, /^Work items\b/);
});

test('PAGE_INTRO does not claim the figures are money (stays consistent with COST_NOTE)', () => {
  const all = `${PAGE_INTRO.lead} ${PAGE_INTRO.statistics} ${PAGE_INTRO.workItems}`;
  assert.doesNotMatch(all, /\$|\bcost\b|\bprice\b|\bdollar/i);
});
