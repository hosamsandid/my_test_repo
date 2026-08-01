import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeStages,
  stagesAfterAdd,
  stagesAfterRename,
  stagesAfterRemove,
  stagesAfterReorder,
  membersToCascade,
} from './stage-list-ops.js';

// ── normalizeStages ──────────────────────────────────────────────────────────
test('normalizeStages trims, drops blanks/non-strings, de-dupes, keeps order', () => {
  assert.deepEqual(
    normalizeStages(['  Build ', 'Test', 'Build', '', null, 3, 'Deploy']),
    ['Build', 'Test', 'Deploy'],
  );
});

test('normalizeStages coerces non-array to empty list', () => {
  assert.deepEqual(normalizeStages(undefined), []);
  assert.deepEqual(normalizeStages(null), []);
  assert.deepEqual(normalizeStages('Build'), []);
});

// ── add ──────────────────────────────────────────────────────────────────────
test('stagesAfterAdd appends a trimmed new stage', () => {
  assert.deepEqual(stagesAfterAdd(['Build'], '  Test '), ['Build', 'Test']);
});

test('stagesAfterAdd is a no-op for a duplicate or blank', () => {
  assert.deepEqual(stagesAfterAdd(['Build'], 'Build'), ['Build']);
  assert.deepEqual(stagesAfterAdd(['Build'], '   '), ['Build']);
});

// ── rename ───────────────────────────────────────────────────────────────────
test('stagesAfterRename replaces in place, preserving order', () => {
  assert.deepEqual(
    stagesAfterRename(['Build', 'Test', 'Deploy'], 'Test', 'QA'),
    ['Build', 'QA', 'Deploy'],
  );
});

test('stagesAfterRename de-dupes when the new name collides with an existing stage', () => {
  // [A, B] with A→B must collapse to [B] (first occurrence wins), not [B, B].
  assert.deepEqual(stagesAfterRename(['A', 'B'], 'A', 'B'), ['B']);
});

test('stagesAfterRename is a no-op for blank or unchanged names', () => {
  assert.deepEqual(stagesAfterRename(['A', 'B'], 'A', '  '), ['A', 'B']);
  assert.deepEqual(stagesAfterRename(['A', 'B'], 'A', 'A'), ['A', 'B']);
});

// ── remove ───────────────────────────────────────────────────────────────────
test('stagesAfterRemove drops the named stage; last-removed yields empty list', () => {
  assert.deepEqual(stagesAfterRemove(['Build', 'Test'], 'Build'), ['Test']);
  assert.deepEqual(stagesAfterRemove(['Only'], 'Only'), []);
});

// ── reorder ──────────────────────────────────────────────────────────────────
test('stagesAfterReorder trusts caller order but keeps only existing stages', () => {
  assert.deepEqual(
    stagesAfterReorder(['Build', 'Test', 'Deploy'], ['Deploy', 'Build', 'Test']),
    ['Deploy', 'Build', 'Test'],
  );
  // A phantom name in the requested order is dropped.
  assert.deepEqual(
    stagesAfterReorder(['Build', 'Test'], ['Test', 'Ghost', 'Build']),
    ['Test', 'Build'],
  );
});

// ── cascade targeting ────────────────────────────────────────────────────────
test('membersToCascade selects only same-team members on the affected stage', () => {
  const agents = [
    { id: 'team-a', role: 'team' },
    { id: 'team-a-dev', parentTeamId: 'team-a', stage: 'Build' },
    { id: 'team-a-qa', parentTeamId: 'team-a', stage: 'Test' },
    { id: 'team-a-ops', parentTeamId: 'team-a', stage: 'Build' },
    { id: 'team-b-dev', parentTeamId: 'team-b', stage: 'Build' }, // different team
  ];
  assert.deepEqual(
    membersToCascade(agents, 'team-a', 'Build').map(a => a.id),
    ['team-a-dev', 'team-a-ops'],
  );
});

test('membersToCascade returns nothing for a blank stage or non-array input', () => {
  assert.deepEqual(membersToCascade([{ parentTeamId: 't', stage: '' }], 't', ''), []);
  assert.deepEqual(membersToCascade(null, 't', 'Build'), []);
});
