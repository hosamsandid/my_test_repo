import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeContextNudge,
  nudgeDismissStorageKey,
  isNudgeDismissed,
} from './context-nudge.js';

test('computeContextNudge: normal fill → no nudge (AC1/AC2)', () => {
  assert.deepEqual(computeContextNudge({ level: 'normal', usedTokens: 40_000 }), { kind: 'none' });
});

test('computeContextNudge: warning fill (>=50%, <75%) → dismissible hint (AC3)', () => {
  assert.deepEqual(
    computeContextNudge({ level: 'warning', usedTokens: 120_000, dismissed: false }),
    { kind: 'hint' },
  );
});

test('computeContextNudge: dismissing the 50% hint removes it (AC3)', () => {
  assert.deepEqual(
    computeContextNudge({ level: 'warning', usedTokens: 120_000, dismissed: true }),
    { kind: 'none' },
  );
});

test('computeContextNudge: critical fill (>=75%) → permanent warning (AC4)', () => {
  assert.deepEqual(
    computeContextNudge({ level: 'critical', usedTokens: 800_000 }),
    { kind: 'warning' },
  );
});

test('computeContextNudge: the 75% warning is not suppressed by an earlier dismissal (AC7)', () => {
  // A user who dismissed the 50% hint still gets the permanent warning when the
  // session later crosses 75%.
  assert.deepEqual(
    computeContextNudge({ level: 'critical', usedTokens: 800_000, dismissed: true }),
    { kind: 'warning' },
  );
});

test('computeContextNudge: unknown window (null level) → no nudge (AC9)', () => {
  assert.deepEqual(computeContextNudge({ level: null, usedTokens: 900_000 }), { kind: 'none' });
  assert.deepEqual(computeContextNudge({ usedTokens: 900_000 }), { kind: 'none' });
});

test('computeContextNudge: autonomous/triggered view → no nudge, whatever the fill (AC10)', () => {
  assert.deepEqual(
    computeContextNudge({ level: 'critical', usedTokens: 900_000, interactive: false }),
    { kind: 'none' },
  );
  assert.deepEqual(
    computeContextNudge({ level: 'warning', usedTokens: 120_000, interactive: false }),
    { kind: 'none' },
  );
});

test('computeContextNudge: a very small session (<1000 tokens) never nudges (edge case)', () => {
  assert.deepEqual(computeContextNudge({ level: 'warning', usedTokens: 500 }), { kind: 'none' });
  assert.deepEqual(computeContextNudge({ level: 'critical', usedTokens: 999 }), { kind: 'none' });
});

test('computeContextNudge: missing usedTokens does not gate the nudge', () => {
  // The token floor only applies when a numeric count is supplied.
  assert.deepEqual(computeContextNudge({ level: 'warning' }), { kind: 'hint' });
  assert.deepEqual(computeContextNudge({ level: 'critical' }), { kind: 'warning' });
});

test('computeContextNudge: defensive default (no args) → none', () => {
  assert.deepEqual(computeContextNudge(), { kind: 'none' });
});

test('nudgeDismissStorageKey: per-room key, null when no room', () => {
  assert.equal(nudgeDismissStorageKey('!abc:local'), 'aee-ctx-nudge-dismissed:!abc:local');
  assert.equal(nudgeDismissStorageKey(null), null);
  assert.equal(nudgeDismissStorageKey(''), null);
});

test('isNudgeDismissed: matches only when the live session id equals the dismissed one', () => {
  assert.equal(isNudgeDismissed('sess-1', 'sess-1'), true);
  // a reset mints a new id → the old dismissal no longer applies (AC6)
  assert.equal(isNudgeDismissed('sess-1', 'sess-2'), false);
  // nothing dismissed yet
  assert.equal(isNudgeDismissed(null, 'sess-1'), false);
  // no live session (just reset) is never treated as dismissed
  assert.equal(isNudgeDismissed('sess-1', null), false);
  assert.equal(isNudgeDismissed(null, null), false);
});
