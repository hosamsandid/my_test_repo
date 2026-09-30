import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRIGGER_TIME_ZONE,
  schedulerTimeZone,
  zoneOffsetMinutes,
  sameOffset,
  cronWallTime,
  localEquivalent,
  cronZoneNote,
  formatRunTime,
  resultLabel,
  triggerTiming,
  onceScheduleLabel,
} from './trigger-timing.js';

const SUMMER = new Date('2026-07-15T10:00:00Z');
const WINTER = new Date('2026-01-15T10:00:00Z');

test('the scheduler zone defaults to Europe/Berlin and follows the reported one', () => {
  assert.equal(TRIGGER_TIME_ZONE, 'Europe/Berlin');
  assert.equal(schedulerTimeZone(null), 'Europe/Berlin');
  assert.equal(schedulerTimeZone({}), 'Europe/Berlin');
  assert.equal(schedulerTimeZone({ timeZone: '  ' }), 'Europe/Berlin');
  assert.equal(schedulerTimeZone({ timeZone: 'UTC' }), 'UTC');
});

test('zoneOffsetMinutes follows DST', () => {
  assert.equal(zoneOffsetMinutes('Europe/Berlin', SUMMER), 120);
  assert.equal(zoneOffsetMinutes('Europe/Berlin', WINTER), 60);
  assert.equal(zoneOffsetMinutes('America/New_York', SUMMER), -240);
  assert.equal(zoneOffsetMinutes('UTC', SUMMER), 0);
  assert.equal(sameOffset('Europe/Berlin', 'Europe/Paris', SUMMER), true);
  assert.equal(sameOffset('Europe/Berlin', 'Europe/London', SUMMER), false);
});

test('cronWallTime only reads a single fixed daily time', () => {
  assert.equal(cronWallTime('0 9 * * *'), '09:00');
  assert.equal(cronWallTime('26 18 * * 1'), '18:26');
  assert.equal(cronWallTime('*/15 * * * *'), null);
  assert.equal(cronWallTime('5 * * * *'), null);
  assert.equal(cronWallTime('0 9,17 * * *'), null);
  assert.equal(cronWallTime('0 25 * * *'), null);
  assert.equal(cronWallTime('0 9 * *'), null);
  assert.equal(cronWallTime(undefined), null);
});

test('localEquivalent converts a Berlin wall time into the viewer zone', () => {
  assert.equal(localEquivalent('09:00', 'Europe/Berlin', 'America/New_York', SUMMER), '03:00');
  assert.equal(localEquivalent('09:00', 'Europe/Berlin', 'America/New_York', WINTER), '03:00');
  assert.equal(localEquivalent('09:00', 'Europe/Berlin', 'UTC', SUMMER), '07:00');
  assert.equal(localEquivalent('09:00', 'Europe/Berlin', 'UTC', WINTER), '08:00');
  assert.equal(localEquivalent('02:00', 'Europe/Berlin', 'America/New_York', SUMMER), '20:00 (−1 day)');
  assert.equal(localEquivalent('18:00', 'Europe/Berlin', 'Asia/Tokyo', SUMMER), '01:00 (+1 day)');
});

test('localEquivalent is null when there is nothing to convert', () => {
  assert.equal(localEquivalent('09:00', 'Europe/Berlin', 'Europe/Paris', SUMMER), null);
  assert.equal(localEquivalent('9am', 'Europe/Berlin', 'UTC', SUMMER), null);
  assert.equal(localEquivalent('09:00', '', 'UTC', SUMMER), null);
});

test('cronZoneNote always names the scheduler zone', () => {
  const same = { schedulerZone: 'Europe/Berlin', viewerZone: 'Europe/Berlin', now: SUMMER };
  assert.equal(cronZoneNote('0 9 * * *', same), 'Europe/Berlin');
  const ny = { schedulerZone: 'Europe/Berlin', viewerZone: 'America/New_York', now: SUMMER };
  assert.equal(cronZoneNote('0 9 * * *', ny), 'Europe/Berlin · 03:00 your time');
  assert.equal(cronZoneNote('*/15 * * * *', ny), 'Europe/Berlin · your zone: America/New_York');
});

test('formatRunTime labels relative days in the viewer zone', () => {
  const opts = { now: SUMMER, timeZone: 'Europe/Berlin' };
  assert.equal(formatRunTime('2026-07-15T16:26:00Z', opts), 'today 18:26');
  assert.equal(formatRunTime('2026-07-16T07:00:00Z', opts), 'tomorrow 09:00');
  assert.equal(formatRunTime('2026-07-14T21:10:00Z', opts), 'yesterday 23:10');
  assert.equal(formatRunTime('2026-10-03T07:00:00Z', opts), '3 Oct 09:00');
  assert.equal(formatRunTime('2027-01-03T08:00:00Z', opts), '3 Jan 2027 09:00');
  // The same instant reads as "tomorrow" for a viewer already past midnight.
  assert.equal(formatRunTime('2026-07-15T16:26:00Z', { now: SUMMER, timeZone: 'Asia/Tokyo' }), 'tomorrow 01:26');
  assert.equal(formatRunTime(null, opts), null);
  assert.equal(formatRunTime('not a date', opts), null);
});

test('resultLabel maps scheduler results and passes unknown ones through', () => {
  assert.equal(resultLabel('ok').text, '✓ ok');
  assert.equal(resultLabel('ok').tone, 'success');
  assert.equal(resultLabel('error').tone, 'error');
  assert.equal(resultLabel('skipped-maintenance').text, 'skipped (maintenance)');
  assert.equal(resultLabel('running').text, 'running…');
  assert.deepEqual(resultLabel('weird'), { text: 'weird', tone: 'muted' });
  assert.equal(resultLabel(undefined), null);
});

test('triggerTiming reports next/last run for a scheduled cron trigger', () => {
  const status = {
    timeZone: 'Europe/Berlin',
    triggers: { t1: { nextFireAt: '2026-07-16T07:00:00Z', lastFiredAt: '2026-07-15T07:00:00Z', lastResult: 'ok' } },
  };
  const got = triggerTiming({ id: 't1', type: 'cron', cron: '0 9 * * *' }, status, { now: SUMMER, viewerZone: 'Europe/Berlin' });
  assert.deepEqual(got, {
    invalid: null,
    next: 'tomorrow 09:00',
    last: 'today 09:00',
    lastResult: { text: '✓ ok', tone: 'success' },
  });
});

test('triggerTiming surfaces a trigger the agent cannot schedule', () => {
  const status = { triggers: { bad: { invalid: 'Invalid cron expression `61 * * * *`', lastFiredAt: '2026-07-14T07:00:00Z', lastResult: 'error' } } };
  const got = triggerTiming({ id: 'bad', type: 'cron', cron: '61 * * * *' }, status, { now: SUMMER, viewerZone: 'Europe/Berlin' });
  assert.equal(got.invalid, 'Invalid cron expression `61 * * * *`');
  assert.equal(got.next, null);
  assert.equal(got.last, 'yesterday 09:00');
  assert.equal(got.lastResult.tone, 'error');
});

test('triggerTiming: a disabled trigger shows no next run and no warning', () => {
  const status = { triggers: { t: { nextFireAt: '2026-07-16T07:00:00Z', invalid: 'x' } } };
  const got = triggerTiming({ id: 't', type: 'once', enabled: false }, status, { now: SUMMER, viewerZone: 'UTC' });
  assert.deepEqual(got, { invalid: null, next: null, last: null, lastResult: null });
});

test('triggerTiming: never fired, no status yet, and non-time trigger types', () => {
  assert.deepEqual(
    triggerTiming({ id: 'x', type: 'cron', cron: '0 9 * * *' }, {}, { now: SUMMER, viewerZone: 'UTC' }),
    { invalid: null, next: null, last: null, lastResult: null },
  );
  assert.equal(triggerTiming({ id: 'h', type: 'http' }, {}, { now: SUMMER }), null);
  assert.equal(triggerTiming({ id: 'g', type: 'github-event' }, {}, { now: SUMMER }), null);
  assert.equal(triggerTiming(null, {}, { now: SUMMER }), null);
});

test('onceScheduleLabel shows an absolute instant in the viewer zone and a naive one in the scheduler zone', () => {
  const opts = { schedulerZone: 'Europe/Berlin', viewerZone: 'America/New_York', now: SUMMER };
  assert.equal(onceScheduleLabel('2026-10-03T07:00:00.000Z', opts), '3 Oct 03:00 (your time, America/New_York)');
  assert.equal(onceScheduleLabel('2026-10-03T09:00:00+02:00', opts), '3 Oct 03:00 (your time, America/New_York)');
  assert.equal(onceScheduleLabel('2026-10-03T09:00:00', opts), '2026-10-03 09:00:00 (Europe/Berlin)');
  assert.equal(onceScheduleLabel('garbageZ', opts), 'garbageZ');
  assert.equal(onceScheduleLabel('', opts), '—');
  assert.equal(onceScheduleLabel(undefined, opts), '—');
});
