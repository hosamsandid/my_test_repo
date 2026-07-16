import test from 'node:test';
import assert from 'node:assert/strict';

import { formatRemaining, maintenanceBannerText } from './maintenance-banner.js';

test('formatRemaining: sub-minute durations show seconds only', () => {
  assert.equal(formatRemaining(0), '0s');
  assert.equal(formatRemaining(45), '45s');
});

test('formatRemaining: minute-plus durations show m + zero-padded s', () => {
  assert.equal(formatRemaining(65), '1m 05s');
  assert.equal(formatRemaining(3661), '61m 01s');
});

test('formatRemaining: negative/fractional input is clamped and rounded', () => {
  assert.equal(formatRemaining(-5), '0s');
  assert.equal(formatRemaining(59.6), '1m 00s');
});

test('maintenanceBannerText: inactive mode renders nothing', () => {
  assert.equal(maintenanceBannerText({ active: false, remainingSec: 120 }), null);
  assert.equal(maintenanceBannerText(undefined), null);
});

test('maintenanceBannerText: active mode with remaining time includes it', () => {
  const text = maintenanceBannerText({ active: true, remainingSec: 125 });
  assert.match(text, /Maintenance mode is active/);
  assert.match(text, /2m 05s/);
});

test('maintenanceBannerText: active mode with no remaining time omits the countdown', () => {
  const text = maintenanceBannerText({ active: true, remainingSec: 0 });
  assert.match(text, /Maintenance mode is active/);
  assert.doesNotMatch(text, /Remaining time/);
});
