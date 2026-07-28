import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCronState, buildCron, describeCron } from './cron-format.js';

test('parseCronState recognises the common shapes', () => {
  assert.equal(parseCronState('*/5 * * * *').mode, 'minutely');
  assert.equal(parseCronState('*/5 * * * *').interval, '5');
  assert.equal(parseCronState('30 * * * *').mode, 'hourly');
  assert.equal(parseCronState('0 9 * * *').mode, 'daily');
  assert.equal(parseCronState('0 9 * * 1').mode, 'weekly');
  assert.equal(parseCronState('0 9 1 * *').mode, 'monthly');
});

test('parseCronState falls back to custom for anything unrecognised', () => {
  const s = parseCronState('1,2,3 9 * * *');
  assert.equal(s.mode, 'custom');
  assert.equal(s.raw, '1,2,3 9 * * *');
  // Wrong field count also falls back to custom, preserving the raw value.
  assert.equal(parseCronState('0 9 *').mode, 'custom');
});

test('parseCronState → buildCron round-trips the recognised shapes', () => {
  for (const cron of ['*/5 * * * *', '30 * * * *', '0 9 * * *', '0 9 * * 1', '0 9 1 * *']) {
    assert.equal(buildCron(parseCronState(cron)), cron);
  }
});

test('describeCron renders plain-language summaries', () => {
  assert.equal(describeCron(parseCronState('0 9 * * *')), 'Every day at 09:00');
  assert.equal(describeCron(parseCronState('30 * * * *')), 'Every hour at :30');
  assert.equal(describeCron(parseCronState('*/1 * * * *')), 'Every 1 minute');
  assert.equal(describeCron(parseCronState('*/10 * * * *')), 'Every 10 minutes');
  assert.equal(describeCron(parseCronState('0 9 * * 1')), 'Every Monday at 09:00');
  assert.equal(describeCron(parseCronState('0 3 12 * *')), 'Day 12 of every month at 03:00');
  // A custom expression has no friendly description.
  assert.equal(describeCron(parseCronState('1,2 9 * * *')), '');
});
