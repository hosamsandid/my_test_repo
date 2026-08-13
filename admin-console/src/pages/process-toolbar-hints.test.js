import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toolbarTitle,
  TOOLBAR_TITLES,
  STRUCTURAL_ACTIONS,
  PROPOSAL_PENDING_REASON,
  NO_ROLES_REASON,
} from './process-toolbar-hints.js';

test('enabled actions show their normal descriptive title', () => {
  const state = { hasProposal: false, roleCount: 3 };
  assert.equal(toolbarTitle('addAgent', state), TOOLBAR_TITLES.addAgent);
  assert.equal(toolbarTitle('addHuman', state), TOOLBAR_TITLES.addHuman);
  assert.equal(toolbarTitle('stages', state), TOOLBAR_TITLES.stages);
  assert.equal(toolbarTitle('labels', state), TOOLBAR_TITLES.labels);
  assert.equal(toolbarTitle('materialize', state), TOOLBAR_TITLES.materialize);
});

test('a pending Copilot proposal explains why every structural action is paused', () => {
  const state = { hasProposal: true, roleCount: 3 };
  for (const action of STRUCTURAL_ACTIONS) {
    assert.equal(toolbarTitle(action, state), PROPOSAL_PENDING_REASON);
  }
});

test('Materialize on an empty design explains the missing-agent precondition', () => {
  assert.equal(toolbarTitle('materialize', { hasProposal: false, roleCount: 0 }), NO_ROLES_REASON);
  assert.equal(toolbarTitle('materialize', { hasProposal: false }), NO_ROLES_REASON);
});

test('the no-agent hint applies only to Materialize, not the other actions', () => {
  const state = { hasProposal: false, roleCount: 0 };
  assert.equal(toolbarTitle('addAgent', state), TOOLBAR_TITLES.addAgent);
  assert.equal(toolbarTitle('stages', state), TOOLBAR_TITLES.stages);
  assert.equal(toolbarTitle('labels', state), TOOLBAR_TITLES.labels);
});

test('a proposal takes precedence over the empty-design hint on Materialize', () => {
  assert.equal(toolbarTitle('materialize', { hasProposal: true, roleCount: 0 }), PROPOSAL_PENDING_REASON);
});

test('roleCount is read defensively (missing / non-number → treated as empty)', () => {
  assert.equal(toolbarTitle('materialize', {}), NO_ROLES_REASON);
  assert.equal(toolbarTitle('materialize', { roleCount: NaN }), NO_ROLES_REASON);
  assert.equal(toolbarTitle('materialize', { roleCount: 1 }), TOOLBAR_TITLES.materialize);
});

test('unknown actions return an empty string rather than throwing', () => {
  assert.equal(toolbarTitle('nope', { hasProposal: true }), '');
  assert.equal(toolbarTitle(undefined), '');
});
