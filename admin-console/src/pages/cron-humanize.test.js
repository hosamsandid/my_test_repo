import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeCron, humanizeOnce } from './cron-humanize.js';

test('fixed time of day, every day', () => {
  assert.equal(humanizeCron('0 9 * * *'), 'At 09:00, every day');
  assert.equal(humanizeCron('30 8 * * *'), 'At 08:30, every day');
  assert.equal(humanizeCron('14 3 * * *'), 'At 03:14, every day');
  assert.equal(humanizeCron('0 0 * * *'), 'At 00:00, every day');
});

test('weekday range — the placeholder example describeCron could not handle', () => {
  assert.equal(humanizeCron('0 9 * * 1-5'), 'At 09:00, on Monday to Friday');
});

test('single weekday', () => {
  assert.equal(humanizeCron('0 12 * * 0'), 'At 12:00, on Sunday');
  assert.equal(humanizeCron('0 12 * * 1'), 'At 12:00, on Monday');
  // Sunday-as-7 normalizes to Sunday
  assert.equal(humanizeCron('0 12 * * 7'), 'At 12:00, on Sunday');
});

test('weekday list', () => {
  assert.equal(humanizeCron('0 9 * * 1,3,5'), 'At 09:00, on Monday, Wednesday and Friday');
  assert.equal(humanizeCron('0 9 * * 6,0'), 'At 09:00, on Saturday and Sunday');
});

test('minute stepping', () => {
  assert.equal(humanizeCron('*/5 * * * *'), 'Every 5 minutes');
  assert.equal(humanizeCron('*/30 * * * *'), 'Every 30 minutes');
  assert.equal(humanizeCron('*/1 * * * *'), 'Every minute');
});

test('hourly shapes', () => {
  assert.equal(humanizeCron('0 * * * *'), 'Every hour, on the hour');
  assert.equal(humanizeCron('15 * * * *'), 'Every hour at :15');
  assert.equal(humanizeCron('0 */2 * * *'), 'Every 2 hours');
});

test('day of month and month', () => {
  assert.equal(humanizeCron('0 0 1 * *'), 'At 00:00, on day 1 of the month');
  assert.equal(humanizeCron('0 0 1 1 *'), 'At 00:00, on day 1 of the month, in January');
  assert.equal(humanizeCron('30 6 15 * *'), 'At 06:30, on day 15 of the month');
});

test('empty / malformed / unsupported → empty string (caller shows raw)', () => {
  assert.equal(humanizeCron(''), '');
  assert.equal(humanizeCron(null), '');
  assert.equal(humanizeCron('0 9 * *'), '');       // only 4 fields
  assert.equal(humanizeCron('0 9 * * * *'), '');    // 6 fields
  assert.equal(humanizeCron('99 9 * * *'), '');     // minute out of range
  assert.equal(humanizeCron('0 25 * * *'), '');     // hour out of range
  assert.equal(humanizeCron('0 9 * * 9'), '');      // weekday out of range
  assert.equal(humanizeCron('0,30 9 * * *'), '');   // minute list — not described
});

test('whitespace is tolerated', () => {
  assert.equal(humanizeCron('  0   9   *   *   1-5  '), 'At 09:00, on Monday to Friday');
});

// ── humanizeOnce (one-shot `once` triggers) ──

test('once: UTC timestamp reads as a plain moment with the zone', () => {
  assert.equal(humanizeOnce('2026-05-01T09:00:00Z'), '1 May 2026 at 09:00 UTC');
  assert.equal(humanizeOnce('2026-12-25T18:30:00Z'), '25 December 2026 at 18:30 UTC');
});

test('once: local (no Z) timestamp omits the zone', () => {
  assert.equal(humanizeOnce('2026-04-25T09:00:00'), '25 April 2026 at 09:00');
  assert.equal(humanizeOnce('2026-01-02T00:05'), '2 January 2026 at 00:05'); // seconds optional
});

test('once: fractional seconds and a space separator are tolerated', () => {
  assert.equal(humanizeOnce('2026-05-01T09:00:00.250Z'), '1 May 2026 at 09:00 UTC');
  assert.equal(humanizeOnce('2026-05-01 09:00:00'), '1 May 2026 at 09:00');
});

test('once: date-only value describes just the day', () => {
  assert.equal(humanizeOnce('2026-05-01'), '1 May 2026');
});

test('once: leading/trailing whitespace is tolerated', () => {
  assert.equal(humanizeOnce('  2026-05-01T09:00:00Z  '), '1 May 2026 at 09:00 UTC');
});

test('once: empty / malformed / out-of-range → empty string (caller shows raw)', () => {
  assert.equal(humanizeOnce(''), '');
  assert.equal(humanizeOnce(null), '');
  assert.equal(humanizeOnce('not a date'), '');
  assert.equal(humanizeOnce('2026-13-01T09:00:00Z'), ''); // month out of range
  assert.equal(humanizeOnce('2026-02-30T09:00:00Z'), ''); // day out of range for Feb
  assert.equal(humanizeOnce('2026-05-01T24:00:00Z'), ''); // hour out of range
  assert.equal(humanizeOnce('2026-05-01T09:60:00Z'), ''); // minute out of range
  assert.equal(humanizeOnce('2026-05-01T09:00:00+02:00'), ''); // numeric offset — not mislabelled
  assert.equal(humanizeOnce('05/01/2026'), '');           // non-ISO shape
});
