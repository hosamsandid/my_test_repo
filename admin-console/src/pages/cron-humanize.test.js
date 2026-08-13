import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeCron } from './cron-humanize.js';

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
