import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatContextWindow,
  selectorWindowLabel,
  headerContextIndicator,
  sessionPriceLabel,
  tokenBreakdownRows,
  repoBranchRows,
} from './session-info.js';

test('formatContextWindow — K/M compact, null when unknown (AC1/AC8)', () => {
  assert.equal(formatContextWindow(1_000_000), '1M');
  assert.equal(formatContextWindow(1_500_000), '1.5M');
  assert.equal(formatContextWindow(200_000), '200K');
  assert.equal(formatContextWindow(128_000), '128K');
  // no misleading guesses / zero placeholders
  assert.equal(formatContextWindow(0), null);
  assert.equal(formatContextWindow(-5), null);
  assert.equal(formatContextWindow(null), null);
  assert.equal(formatContextWindow(undefined), null);
  assert.equal(formatContextWindow('200000'), null);
  assert.equal(formatContextWindow(NaN), null);
});

test('selectorWindowLabel — "1M context" or null', () => {
  assert.equal(selectorWindowLabel(1_000_000), '1M context');
  assert.equal(selectorWindowLabel(200_000), '200K context');
  assert.equal(selectorWindowLabel(null), null);
  assert.equal(selectorWindowLabel(0), null);
});

test('headerContextIndicator — used / window + % when window known (AC2/AC3)', () => {
  const r = headerContextIndicator(34_300, 200_000, { pct: 17, level: 'normal' });
  assert.deepEqual(r, { text: '34K / 200K · 17%', level: 'normal', windowKnown: true });

  const crit = headerContextIndicator(190_000, 200_000, { pct: 95, level: 'critical' });
  assert.equal(crit.text, '190K / 200K · 95%');
  assert.equal(crit.level, 'critical');
  assert.equal(crit.windowKnown, true);
});

test('headerContextIndicator — used count only when window unknown (AC2)', () => {
  const r = headerContextIndicator(34_300, null, null);
  assert.deepEqual(r, { text: '34K', level: 'normal', windowKnown: false });
  // window 0 is treated as unknown
  assert.equal(headerContextIndicator(34_300, 0, null).windowKnown, false);
});

test('headerContextIndicator — null when no usage data at all', () => {
  assert.equal(headerContextIndicator(null, 200_000, null), null);
  assert.equal(headerContextIndicator(-1, 200_000, null), null);
});

test('headerContextIndicator — window known but no fill level omits the %', () => {
  const r = headerContextIndicator(34_300, 200_000, null);
  assert.equal(r.text, '34K / 200K');
  assert.equal(r.windowKnown, true);
});

test('sessionPriceLabel — single total, null when no data (AC4/AC6)', () => {
  assert.equal(sessionPriceLabel(0.4), '$0.4000');
  assert.equal(sessionPriceLabel(1.23456), '$1.2346');
  assert.equal(sessionPriceLabel(0), null);
  assert.equal(sessionPriceLabel(null), null);
  assert.equal(sessionPriceLabel(undefined), null);
});

test('tokenBreakdownRows — four classes in order (AC4)', () => {
  const rows = tokenBreakdownRows({ input: 8, output: 40, cacheWrite: 8141, cacheRead: 17718 });
  assert.deepEqual(rows.map(r => r.key), ['input', 'output', 'cacheWrite', 'cacheRead']);
  assert.deepEqual(rows.map(r => r.label), ['Input', 'Output', 'Cache-write', 'Cache-read']);
  assert.deepEqual(rows.map(r => r.value), ['8', '40', '8,141', '17,718']);
});

test('tokenBreakdownRows — genuine 0 for a present class is shown, missing → 0', () => {
  const rows = tokenBreakdownRows({ input: 100, output: 0 });
  // cacheWrite/cacheRead absent but at least one class present → all four shown
  assert.equal(rows.length, 4);
  assert.equal(rows.find(r => r.key === 'output').value, '0');
  assert.equal(rows.find(r => r.key === 'cacheRead').value, '0');
});

test('tokenBreakdownRows — empty when no data at all / fresh session all-zero (AC8)', () => {
  assert.deepEqual(tokenBreakdownRows(null), []);
  assert.deepEqual(tokenBreakdownRows(undefined), []);
  assert.deepEqual(tokenBreakdownRows({}), []);
  // a fresh session reports all-zero classes → no zero placeholder section
  assert.deepEqual(tokenBreakdownRows({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }), []);
});

test('repoBranchRows — formats git repos for About-this-chat popover (AC6)', () => {
  const rows = repoBranchRows([
    { repoPath: 'my-repo', branch: 'main', isDirty: false, changesCount: 0 },
    { repoPath: 'other', branch: 'feat/foo', isDirty: true, changesCount: 3 },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { repoPath: 'my-repo', branch: 'main', isDirty: false, changesCount: 0 });
  assert.deepEqual(rows[1], { repoPath: 'other', branch: 'feat/foo', isDirty: true, changesCount: 3 });
});

test('repoBranchRows — null/undefined/empty returns []', () => {
  assert.deepEqual(repoBranchRows(null), []);
  assert.deepEqual(repoBranchRows(undefined), []);
  assert.deepEqual(repoBranchRows([]), []);
});

test('repoBranchRows — null branch → detached; missing changesCount → 0', () => {
  const rows = repoBranchRows([{ repoPath: 'r', branch: null }]);
  assert.equal(rows[0].branch, 'detached');
  assert.equal(rows[0].changesCount, 0);
  assert.equal(rows[0].isDirty, false);
});
