import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRateLimitEvent,
  formatEpochSeconds,
  rateLimitEventSummary,
  rateLimitEventDetailRows,
} from './rate-limit-event.js';

// Mirrors the sample payload from #2202.
const sample = {
  type: 'rate_limit_event',
  correlationId: 'corr-1',
  info: {
    status: 'allowed',
    resetsAt: 1790812800,
    rateLimitType: 'overage',
    overageStatus: 'allowed',
    overageResetsAt: 1790812800,
    isUsingOverage: false,
    overageInUse: true,
  },
  raw: { type: 'rate_limit_event' },
};

test('isRateLimitEvent: true only for a rate_limit_event row', () => {
  assert.equal(isRateLimitEvent(sample), true);
  assert.equal(isRateLimitEvent({ type: 'system_event' }), false);
  assert.equal(isRateLimitEvent(undefined), false);
  assert.equal(isRateLimitEvent(null), false);
});

test('formatEpochSeconds: converts a Unix-epoch-seconds value to a local date/time string', () => {
  const out = formatEpochSeconds(1790812800);
  assert.notEqual(out, '');
  // Not asserting an exact locale string (environment-dependent) — just that
  // it parses into a real, non-epoch-looking date.
  assert.doesNotMatch(out, /^1790812800$/);
});

test('formatEpochSeconds: "" for missing/zero/negative/non-numeric', () => {
  assert.equal(formatEpochSeconds(undefined), '');
  assert.equal(formatEpochSeconds(null), '');
  assert.equal(formatEpochSeconds(0), '');
  assert.equal(formatEpochSeconds(-5), '');
  assert.equal(formatEpochSeconds('not-a-number'), '');
});

test('rateLimitEventSummary: plain-language line with status, overage and reset time', () => {
  const summary = rateLimitEventSummary(sample);
  assert.match(summary, /^Rate limit: allowed/);
  assert.match(summary, /Overage: allowed \(in use\)/);
  assert.match(summary, /resets /);
});

test('rateLimitEventSummary: omits the overage clause when there is no overage status', () => {
  const ev = { info: { status: 'allowed', resetsAt: 1790812800 } };
  const summary = rateLimitEventSummary(ev);
  assert.doesNotMatch(summary, /Overage/);
  assert.match(summary, /^Rate limit: allowed · resets /);
});

test('rateLimitEventSummary: "(in use)" omitted when overageInUse is falsy', () => {
  const ev = { info: { status: 'allowed', overageStatus: 'allowed', overageInUse: false } };
  assert.equal(rateLimitEventSummary(ev), 'Rate limit: allowed · Overage: allowed');
});

test('rateLimitEventSummary: "" for a missing/empty info object', () => {
  assert.equal(rateLimitEventSummary({}), '');
  assert.equal(rateLimitEventSummary(undefined), '');
});

test('rateLimitEventDetailRows: surfaces every field verbatim, including a disagreeing pair', () => {
  const rows = rateLimitEventDetailRows(sample);
  const asObj = Object.fromEntries(rows);
  assert.equal(asObj.status, 'allowed');
  assert.equal(asObj.rateLimitType, 'overage');
  assert.equal(asObj.overageStatus, 'allowed');
  // Both booleans are surfaced as their own rows, even though they disagree —
  // no inferred/collapsed relationship is baked in here.
  assert.equal(asObj.isUsingOverage, 'false');
  assert.equal(asObj.overageInUse, 'true');
  assert.ok(asObj.resetsAt);
  assert.ok(asObj.overageResetsAt);
});

test('rateLimitEventDetailRows: [] for a missing/empty info object', () => {
  assert.deepEqual(rateLimitEventDetailRows({}), []);
  assert.deepEqual(rateLimitEventDetailRows(undefined), []);
});
