import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toolbarTitle,
  TOOLBAR_TITLES,
  STRUCTURAL_ACTIONS,
  PROPOSAL_PENDING_REASON,
  NO_ROLES_REASON,
  IMPORTED_PREVIEW_REASON,
  STATUS_TITLES,
  PAGE_ACTION_TITLES,
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

// ─── #1999: the copy for the whole Flow-Editor toolbar lives here ──────────

test('every header-row action button has a tooltip', () => {
  // The AC is "no button is left unexplained"; this is that as an assertion.
  const headerRowActions = [
    'addAgent', 'addHuman', 'stages', 'labels', 'materialize',
    'copilot', 'export', 'editAsDraft', 'anomalies', 'improvements',
  ];
  for (const action of headerRowActions) {
    const title = toolbarTitle(action);
    assert.equal(typeof title, 'string');
    assert.ok(title.length > 0, `${action} needs tooltip copy`);
  }
});

test('the status controls and the page-action bar have copy too', () => {
  for (const key of ['modeLive', 'modeDraft', 'renameDraft']) {
    assert.ok(STATUS_TITLES[key]?.length > 0, `${key} needs copy`);
  }
  for (const key of ['import', 'importBusy', 'describe', 'newFlow']) {
    assert.ok(PAGE_ACTION_TITLES[key]?.length > 0, `${key} needs copy`);
  }
});

test('Export explains both of the states that grey it out', () => {
  assert.equal(toolbarTitle('export', {}), TOOLBAR_TITLES.export);
  assert.equal(toolbarTitle('export', { imported: true }), IMPORTED_PREVIEW_REASON);
  assert.equal(toolbarTitle('export', { hasProposal: true }), PROPOSAL_PENDING_REASON);
  // A proposal is the more recent thing the user did, so it wins.
  assert.equal(
    toolbarTitle('export', { hasProposal: true, imported: true }),
    PROPOSAL_PENDING_REASON,
  );
});

test('the empty-design hint never leaks onto Export', () => {
  // Export is preview-blocked, not structural: roleCount is none of its business.
  assert.equal(toolbarTitle('export', { roleCount: 0 }), TOOLBAR_TITLES.export);
});

test('the non-blockable actions ignore the blocking state entirely', () => {
  const blocked = { hasProposal: true, imported: true, roleCount: 0 };
  assert.equal(toolbarTitle('copilot', blocked), TOOLBAR_TITLES.copilot);
  assert.equal(toolbarTitle('anomalies', blocked), TOOLBAR_TITLES.anomalies);
  assert.equal(toolbarTitle('improvements', blocked), TOOLBAR_TITLES.improvements);
  assert.equal(toolbarTitle('editAsDraft', blocked), TOOLBAR_TITLES.editAsDraft);
});
