import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftStatusText,
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
    'copilot', 'export', 'editAsDraft', 'anomalies', 'improvements', 'parallelism',
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

// ─── #2053: the draft status line, and the one vocabulary ────────────────────

test('AC6 — the draft status line surfaces the disabled-reason inline', () => {
  // On an empty draft the reason the create action is greyed out used to be
  // reachable ONLY on hover; the same string now also reads in the strip.
  const empty = draftStatusText(0);
  assert.ok(empty.includes(NO_ROLES_REASON), empty);
  // With agents there is nothing blocking, so the line states the next step
  // rather than a reason.
  const ready = draftStatusText(3);
  assert.ok(!ready.includes(NO_ROLES_REASON), ready);
  assert.match(ready, /Create team…/);
});

test('the status line never comes back empty, whatever the bundle is doing', () => {
  // `roleCount` is read off an optional-chained bundle, so undefined is the
  // ordinary loading state — an empty strip would be a hole in the layout.
  for (const bad of [undefined, null, NaN, 'two']) {
    assert.ok(draftStatusText(bad).length > 0, String(bad));
  }
});

test('AC5/AC13 — the toolbar copy carries the new verb, with the bridge', () => {
  // The create action's tooltip is the ONE place in the UI the old word
  // survives, so it must be here and nowhere near a label.
  assert.match(TOOLBAR_TITLES.materialize, /Create a real team/);
  assert.match(TOOLBAR_TITLES.materialize, /previously called Materialize/);
  // Every other piece of toolbar/status copy has moved off the old verb — the
  // draft mode pill and Edit-as-draft both used to promise "materialize it".
  for (const [key, text] of Object.entries({ ...TOOLBAR_TITLES, ...STATUS_TITLES })) {
    if (key === 'materialize') continue;
    assert.doesNotMatch(text, /materializ/i, `${key} still says it`);
  }
});
