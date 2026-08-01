import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeTeamAction } from './team-action-summary.js';

const members = [
  { id: 'a', displayName: 'Alice' },
  { id: 'b', displayName: 'Bob' },
  { id: 'c', displayName: 'Carol' },
];

test('summarizeTeamAction: disable result with no failures', () => {
  const result = { teamId: 't', disabled: ['a', 'b'], skipped: ['c'], failed: [] };
  const summary = summarizeTeamAction(result, members);
  assert.deepEqual(summary.successIds, ['a', 'b']);
  assert.deepEqual(summary.failedMembers, []);
});

test('summarizeTeamAction: enable result with no failures uses the enabled key', () => {
  const result = { teamId: 't', enabled: ['a'], skipped: ['b', 'c'], failed: [] };
  const summary = summarizeTeamAction(result, members);
  assert.deepEqual(summary.successIds, ['a']);
  assert.deepEqual(summary.failedMembers, []);
});

test('summarizeTeamAction: failed ids are resolved to displayName via members list', () => {
  const result = { teamId: 't', disabled: ['a'], skipped: [], failed: [{ id: 'b', error: 'boom' }] };
  const summary = summarizeTeamAction(result, members);
  assert.deepEqual(summary.successIds, ['a']);
  assert.deepEqual(summary.failedMembers, [{ id: 'b', displayName: 'Bob', error: 'boom' }]);
});

test('summarizeTeamAction: a failed id absent from members falls back to the raw id as displayName', () => {
  const result = { teamId: 't', disabled: [], skipped: [], failed: [{ id: 'ghost', error: 'gone' }] };
  const summary = summarizeTeamAction(result, members);
  assert.deepEqual(summary.failedMembers, [{ id: 'ghost', displayName: 'ghost', error: 'gone' }]);
});
