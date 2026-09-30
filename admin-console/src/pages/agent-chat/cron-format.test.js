import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCronState, buildCron, describeCron, cronExpressionError, validateCronState, switchCronMode,
} from './cron-format.js';

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

// ── #2625: validation, no silent defaults, Custom mode ──────────────────────

test('cronExpressionError accepts what croniter schedules', () => {
  for (const cron of [
    '0 9 * * *', '0 9 * * 1-5', '*/15 8-18 * * *', '0 9 1,15 * *', '0 9 * * 1-5/2',
    '0 0 * * 7', '0 9 * * MON-FRI', '0 9 1 jan *', '@daily', '@hourly', '  0 9 * * *  ',
  ]) {
    assert.equal(cronExpressionError(cron), null, cron);
  }
});

test('cronExpressionError rejects malformed and out-of-range expressions', () => {
  for (const cron of [
    '', '   ', 'abc', '* * * *', '* * * * * *', '61 * * * *', '-1 * * * *', '0 25 * * *',
    '*/0 * * * *', '*/-5 * * * *', '*/2.5 * * * *', '0 0 0 * *', '0 0 32 * *', '0 0 -3 * *',
    '0 0 * 13 *', '0 0 * * 8', '5-1 * * * *', '1,,2 * * * *', '0 9 * * FOO', '@sometimes',
  ]) {
    assert.ok(cronExpressionError(cron), `expected an error for ${JSON.stringify(cron)}`);
  }
  assert.match(cronExpressionError(''), /required/);
  assert.match(cronExpressionError('* * * *'), /5 fields.*found 4/);
  assert.match(cronExpressionError('61 * * * *'), /Minute must be between 0 and 59/);
  assert.match(cronExpressionError('0 25 * * *'), /Hour must be between 0 and 23/);
  assert.match(cronExpressionError('*/0 * * * *'), /step/);
});

// Review S1: croniter also schedules `L` (last day of month) and `n#k`
// (k-th weekday) — an existing trigger using them must stay saveable.
test('cronExpressionError matches croniter on L and n#k', () => {
  for (const cron of [
    '0 9 L * *', '0 9 1,L * *', '0 9 l * *', '0 9 * * 1#2', '0 9 * * MON#2', '0 9 * * 7#1',
    '0 9 * * 1#5', '0 9 * * 1#2,3#1', '0 9 1-L * *', '0 9 15-l * *', '0 9 1-L/2 * *', '0 9 1-L,3 * *',
  ]) {
    assert.equal(cronExpressionError(cron), null, cron);
  }
  for (const cron of [
    '0 L * * *', '0 9 L-1 * *', '0 9 LW * *', '0 9 L/2 * *', '0 9 * * L', '0 9 * * 5L',
    '0 9 * * 1#0', '0 9 * * 1#6', '0 9 * * 8#1', '0 9 * * 3,1#2', '0 9 * * 1-2#1',
    '0 9 * * 1#2/2', '0 9 * * 1#2#3', '0 1#2 * * *', '0 9 1#2 * *', '0 9 L-L * *', '0 9 L-5 * *',
    '0 9 32-L * *', '0 9 0-L * *', '0 9 1-L/0 * *', '0 * * * 1-L',
  ]) {
    assert.ok(cronExpressionError(cron), `expected an error for ${JSON.stringify(cron)}`);
  }
});

test('validateCronState flags empty / out-of-range preset fields per input', () => {
  const base = parseCronState('0 9 * * *');
  const bad = (patch) => validateCronState({ ...base, ...patch });
  for (const interval of ['', '0', '60', '100', '-5', '2.5']) {
    const v = bad({ mode: 'minutely', interval });
    assert.equal(v.ok, false, `interval ${interval}`);
    assert.ok(v.errors.interval);
  }
  for (const minute of ['', '60', '75', '-1']) {
    assert.ok(bad({ mode: 'hourly', minute }).errors.minute, `minute ${minute}`);
  }
  for (const dom of ['', '0', '32', '40', '-3']) {
    assert.ok(bad({ mode: 'monthly', dom }).errors.dom, `dom ${dom}`);
  }
  for (const mode of ['daily', 'weekly', 'monthly']) {
    assert.ok(bad({ mode, hour: '', minute: '' }).errors.time, `cleared time in ${mode}`);
  }
  assert.ok(bad({ mode: 'custom', raw: '61 * * * *' }).errors.raw);
  assert.equal(bad({ mode: 'custom', raw: '0 9 * * 1-5' }).ok, true);
  assert.equal(bad({ mode: 'minutely', interval: '1' }).ok, true);
  assert.equal(bad({ mode: 'minutely', interval: '59' }).ok, true);
});

test('buildCron no longer substitutes defaults for invalid input', () => {
  const base = parseCronState('0 9 * * *');
  const built = (patch) => buildCron({ ...base, ...patch });
  // Each of these used to be saved as a different, valid schedule.
  assert.notEqual(built({ mode: 'minutely', interval: '0' }), '*/5 * * * *');
  assert.notEqual(built({ mode: 'minutely', interval: '' }), '*/5 * * * *');
  assert.notEqual(built({ mode: 'minutely', interval: '2.5' }), '*/2 * * * *');
  assert.notEqual(built({ mode: 'monthly', dom: '0' }), '0 9 1 * *');
  assert.notEqual(built({ mode: 'daily', hour: '', minute: '' }), '0 0 * * *');
  // …and what it emits instead is refused by the expression validator.
  for (const patch of [
    { mode: 'minutely', interval: '0' }, { mode: 'minutely', interval: '' },
    { mode: 'minutely', interval: '2.5' }, { mode: 'monthly', dom: '0' },
    { mode: 'daily', hour: '', minute: '' }, { mode: 'hourly', minute: '75' },
  ]) {
    assert.ok(cronExpressionError(built(patch)), JSON.stringify(patch));
  }
  // Whole numbers are normalised (the time input yields zero-padded values).
  assert.equal(built({ mode: 'daily', hour: '09', minute: '05' }), '5 9 * * *');
});

test('parseCronState treats a preset shape with out-of-range values as custom', () => {
  for (const cron of ['75 * * * *', '*/60 * * * *', '0 0 40 * *', '0 25 * * *']) {
    const s = parseCronState(cron);
    assert.equal(s.mode, 'custom', cron);
    assert.equal(s.raw, cron);
  }
  // …so the trigger list shows the raw expression, not "Every hour at :75".
  assert.equal(describeCron(parseCronState('75 * * * *')), '');
});

test('choosing Custom pre-fills the current expression and never yields ""', () => {
  for (const cron of ['0 9 * * *', '*/5 * * * *', '30 * * * *', '0 9 * * 1', '0 9 1 * *', '']) {
    const s = parseCronState(cron);
    const next = switchCronMode(s, 'custom');
    assert.equal(next.mode, 'custom');
    assert.equal(buildCron(next), buildCron(s));
    assert.notEqual(buildCron(next), '');
    assert.equal(validateCronState(next).ok, true);
  }
  // Switching to the mode already shown is a no-op.
  const custom = parseCronState('0 9 * * 1-5');
  assert.equal(switchCronMode(custom, 'custom'), custom);
  // Leaving Custom keeps the preset fields the state already held.
  assert.equal(switchCronMode(parseCronState('0 9 * * *'), 'hourly').minute, '0');
});

test('typing a custom expression keystroke by keystroke keeps Custom mode', () => {
  // The builder holds its own mode; each keystroke only patches `raw`. The
  // expression that is emitted must match what is typed at every step.
  let s = switchCronMode(parseCronState('0 9 * * *'), 'custom');
  const target = '0 9 * * 1-5';
  for (let i = 0; i <= target.length; i++) {
    s = { ...s, raw: target.slice(0, i) };
    assert.equal(s.mode, 'custom');
    assert.equal(buildCron(s), target.slice(0, i));
  }
  assert.equal(validateCronState(s).ok, true);
});

test('describeCron only describes a valid preset state', () => {
  const base = parseCronState('0 9 * * *');
  assert.equal(describeCron({ ...base, mode: 'minutely', interval: '0' }), '');
  assert.equal(describeCron({ ...base, hour: '' }), '');
  assert.equal(describeCron(switchCronMode(base, 'custom')), '');
});
