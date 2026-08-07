import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IDLE_HISTORY_LIMIT, latestFinishedId, resolveHistoricalId, historyFetchLimit,
} from './session-default.js';

const hist = (...ids) => ids.map(id => ({ id }));

test('latestFinishedId: head of the newest-first history', () => {
  assert.equal(latestFinishedId(hist('s3', 's2', 's1')), 's3');
});

test('latestFinishedId: empty / malformed history has no latest', () => {
  assert.equal(latestFinishedId([]), null);
  assert.equal(latestFinishedId(null), null);
  assert.equal(latestFinishedId(undefined), null);
  assert.equal(latestFinishedId([{}]), null);
});

test('resolveHistoricalId: idle panel defaults to the most recent finished session (AC1)', () => {
  assert.equal(
    resolveHistoricalId({ hasActive: false, history: hist('newest', 'older'), current: null }),
    'newest',
  );
});

test('resolveHistoricalId: nothing to default to keeps the idle empty state (AC2)', () => {
  assert.equal(resolveHistoricalId({ hasActive: false, history: [], current: null }), null);
});

test('resolveHistoricalId: an active session takes over from the auto-default (AC3)', () => {
  assert.equal(
    resolveHistoricalId({ hasActive: true, history: hist('newest'), current: 'newest' }),
    null,
  );
});

test('resolveHistoricalId: a finished run becomes the default when nothing is active (AC4)', () => {
  // The active session dropped out of the poll and now heads the history.
  assert.equal(
    resolveHistoricalId({ hasActive: false, history: hist('just-ended', 'older'), current: null }),
    'just-ended',
  );
});

test('resolveHistoricalId: the auto-default tracks the newest finished session (AC5)', () => {
  assert.equal(
    resolveHistoricalId({ hasActive: false, history: hist('newer', 'was-default'), current: 'was-default' }),
    'newer',
  );
});

test('resolveHistoricalId: an explicit selection is never overridden (AC6, Open Question 1)', () => {
  // Newer finished sessions arrive…
  assert.equal(
    resolveHistoricalId({ pinned: true, hasActive: false, history: hist('newer', 'picked'), current: 'picked' }),
    'picked',
  );
  // …and a live session starts — the reader is not yanked away.
  assert.equal(
    resolveHistoricalId({ pinned: true, hasActive: true, history: hist('newer', 'picked'), current: 'picked' }),
    'picked',
  );
});

test('resolveHistoricalId: a deep-linked (pinned) session survives an empty history slice', () => {
  assert.equal(
    resolveHistoricalId({ pinned: true, hasActive: false, history: [], current: 'deep-linked' }),
    'deep-linked',
  );
});

test('resolveHistoricalId: defaults are safe with no arguments', () => {
  assert.equal(resolveHistoricalId(), null);
});

test('historyFetchLimit: collapsed and auto-defaulting loads only the newest slice', () => {
  assert.equal(historyFetchLimit({ historyOpen: false, pinned: false, fullLimit: 100 }), IDLE_HISTORY_LIMIT);
});

test('historyFetchLimit: expanded dropdown loads the full page', () => {
  assert.equal(historyFetchLimit({ historyOpen: true, pinned: false, fullLimit: 100 }), 100);
});

test('historyFetchLimit: an explicit selection keeps the full page loaded', () => {
  // Collapsing the control while reading a picked session must not drop it out
  // of the loaded slice.
  assert.equal(historyFetchLimit({ historyOpen: false, pinned: true, fullLimit: 100 }), 100);
});

test('historyFetchLimit: never asks for more than the full page', () => {
  assert.equal(historyFetchLimit({ historyOpen: false, pinned: false, fullLimit: 2 }), 2);
  assert.equal(historyFetchLimit(), IDLE_HISTORY_LIMIT);
});
