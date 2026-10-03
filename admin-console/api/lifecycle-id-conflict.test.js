'use strict';

// Run: node --test admin-console/api/lifecycle-id-conflict.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { lifecycleIdConflict, lifecycleIdTaken } = require('./lifecycle-id-conflict');

const existsIn = (ids) => (id) => ids.includes(id);

test('a free id is no conflict, with or without a target team', () => {
  assert.equal(lifecycleIdConflict('solo', { standalone: true, exists: existsIn([]) }), null);
  assert.equal(lifecycleIdConflict('solo', { standalone: false, exists: existsIn([]) }), null);
});

test('a taken id answers id-conflict with a suggestion that is actually free (#2684 AC3)', () => {
  const body = lifecycleIdConflict('solo', { standalone: true, exists: existsIn(['solo', 'solo-2']) });
  assert.equal(body.code, 'id-conflict');
  assert.equal(body.agentId, 'solo');
  // The bare `<id>-2` the dialog used to seed is taken here — the suggestion skips it.
  assert.equal(body.suggestedId, 'solo-3');
});

test('a team-of-one target also needs `<id>-team` free — for the id and the suggestion', () => {
  const exists = existsIn(['solo-team', 'solo-2-team']);
  assert.equal(lifecycleIdTaken('solo', true, exists), true);
  const body = lifecycleIdConflict('solo', { standalone: true, exists });
  assert.match(body.error, /team 'solo-team'/);
  assert.equal(body.suggestedId, 'solo-3');
});

test('grafting into an existing team does not care about `<id>-team`', () => {
  assert.equal(lifecycleIdConflict('solo', { standalone: false, exists: existsIn(['solo-team']) }), null);
  const body = lifecycleIdConflict('solo', { standalone: false, exists: existsIn(['solo']) });
  assert.equal(body.suggestedId, 'solo-2');
});

test('a typed numbered id continues its own sequence', () => {
  const body = lifecycleIdConflict('solo-2', { standalone: true, exists: existsIn(['solo-2']) });
  assert.equal(body.suggestedId, 'solo-3');
});

test('`what` finishes the refusal sentence', () => {
  const body = lifecycleIdConflict('solo', { standalone: true, exists: existsIn(['solo']), what: ' to import it under' });
  assert.equal(body.error, "Agent 'solo' already exists — choose a different id to import it under.");
});
