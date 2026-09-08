import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFlowsRailMenu,
  intentForMenuKey,
  parseFlowIntent,
  FLOW_INTENTS,
  NO_ROLES_MENU_HINT,
} from './flows-rail-menu.js';
import { CREATE_TEAM_LABEL } from './create-team-copy.js';
import { bundleFilename } from './bundle-download.js';

const keys = (items) => items.map(i => i.key);
const byKey = (items, key) => items.find(i => i.key === key);

// ─── The item sets (#2053 B3/AC8) ────────────────────────────────────────────

test('AC8 — a draft row offers create-team first, then the rest', () => {
  const { items } = buildFlowsRailMenu({ kind: 'draft', name: 'Simple SDLC', id: 'simple-sdlc', roleCount: 2 });
  assert.deepEqual(keys(items), ['create-team', 'rename', 'share', 'export', 'delete']);
  assert.equal(byKey(items, 'create-team').label, CREATE_TEAM_LABEL);
  assert.ok(items.every(i => !i.disabled));
});

test('AC8 — create-team is visually set apart, via a fence on the entry below it', () => {
  const { items } = buildFlowsRailMenu({ kind: 'draft', name: 'D', roleCount: 1 });
  // `separated` draws a borderTop on the item that carries it, so fencing the
  // FIRST entry off means marking the SECOND. A pseudo-separator item would be
  // an unfocusable hole in the list RowContextMenu walks by index.
  assert.equal(byKey(items, 'create-team').separated, undefined);
  assert.equal(byKey(items, 'rename').separated, true);
  assert.equal(items.filter(i => i.separated).length, 1);
});

test('AC8 — a team row gets the three actions it never had', () => {
  const { items } = buildFlowsRailMenu({ kind: 'team', name: 'Agentic Demos', id: 'agentic-demos' });
  assert.deepEqual(keys(items), ['edit-as-draft', 'export', 'open-chat']);
  assert.ok(items.every(i => !i.disabled));
});

test('AC9 — Delete draft is the only destructive entry, and only drafts have it', () => {
  const draft = buildFlowsRailMenu({ kind: 'draft', name: 'D', roleCount: 1 }).items;
  assert.deepEqual(draft.filter(i => i.danger).map(i => i.key), ['delete']);
  const team = buildFlowsRailMenu({ kind: 'team', name: 'T' }).items;
  assert.equal(byKey(team, 'delete'), undefined);
  assert.deepEqual(team.filter(i => i.danger), []);
});

test('create-team is offered-but-inert on an empty draft, with the reason on it', () => {
  const { items } = buildFlowsRailMenu({ kind: 'draft', name: 'Empty', roleCount: 0 });
  // Same shape as a non-empty draft — one stable menu, the `gate()` doctrine of
  // buildAgentMenu — so the entry is never mysteriously absent.
  assert.deepEqual(keys(items), ['create-team', 'rename', 'share', 'export', 'delete']);
  assert.equal(byKey(items, 'create-team').disabled, true);
  assert.equal(byKey(items, 'create-team').title, NO_ROLES_MENU_HINT);
  // Everything else stays usable on an empty draft — you can still rename or
  // delete a design you have not filled in yet.
  for (const k of ['rename', 'share', 'export', 'delete']) {
    assert.equal(byKey(items, k).disabled, undefined, `${k} must stay live`);
  }
});

test('a missing roleCount reads as empty rather than throwing or guessing', () => {
  for (const bad of [undefined, null, NaN, 'two']) {
    const { items } = buildFlowsRailMenu({ kind: 'draft', name: 'D', roleCount: bad });
    assert.equal(byKey(items, 'create-team').disabled, true, String(bad));
  }
});

test('the menu label names the row, falling back rather than reading "Actions for "', () => {
  assert.equal(buildFlowsRailMenu({ kind: 'draft', name: 'Simple SDLC' }).label, 'Actions for Simple SDLC');
  // A draft always has a name, but a team row falls back to its id when the
  // display name is missing — same rule as the row's own visible label.
  assert.equal(buildFlowsRailMenu({ kind: 'team', id: 'acme' }).label, 'Actions for acme');
  assert.equal(buildFlowsRailMenu({ kind: 'draft', name: '   ' }).label, 'Actions for this draft');
  assert.equal(buildFlowsRailMenu({ kind: 'team' }).label, 'Actions for this team');
});

test('an unrecognised target degrades to an empty menu instead of guessing', () => {
  // The host renders nothing for an empty item set, so a target shape this
  // module does not know can never produce a box with the wrong actions in it.
  for (const bad of [null, undefined, {}, { kind: 'import' }, { kind: 'flow' }]) {
    assert.deepEqual(buildFlowsRailMenu(bad), { items: [], label: '' }, JSON.stringify(bad));
  }
});

// ─── The canvas hand-over (#2053 B3) ────────────────────────────────────────

test('only the two canvas actions carry an intent; the rest the page handles itself', () => {
  assert.equal(intentForMenuKey('create-team'), FLOW_INTENTS.createTeam);
  assert.equal(intentForMenuKey('edit-as-draft'), FLOW_INTENTS.editAsDraft);
  for (const k of ['rename', 'share', 'export', 'delete', 'open-chat', 'nope', undefined]) {
    assert.equal(intentForMenuKey(k), null, `${String(k)} must not become an intent`);
  }
});

test('every intent-bearing key is really an item some row offers', () => {
  const offered = new Set([
    ...keys(buildFlowsRailMenu({ kind: 'draft', name: 'D', roleCount: 1 }).items),
    ...keys(buildFlowsRailMenu({ kind: 'team', name: 'T' }).items),
  ]);
  for (const key of ['create-team', 'edit-as-draft']) {
    assert.ok(offered.has(key), `${key} maps to an intent but no row offers it`);
  }
});

test('an unknown ?intent= is ignored rather than acted on', () => {
  assert.equal(parseFlowIntent('create-team'), FLOW_INTENTS.createTeam);
  assert.equal(parseFlowIntent('edit-draft'), FLOW_INTENTS.editAsDraft);
  for (const bad of ['', 'delete', 'CREATE-TEAM', null, undefined, '1']) {
    assert.equal(parseFlowIntent(bad), null, `${String(bad)} must not resolve`);
  }
});

// ─── The shared export filename ─────────────────────────────────────────────

test('both export buttons on the page derive the same filename', () => {
  assert.equal(bundleFilename('Simple SDLC'), 'Simple-SDLC.process.json');
  // Byte-identical to the pre-#2053 inline rule in ProcessCanvas, so an
  // existing export does not suddenly change its filename.
  assert.equal(bundleFilename('a/b:c'), 'a-b-c.process.json');
  assert.equal(bundleFilename('keep.this-one_ok'), 'keep.this-one_ok.process.json');
  for (const bad of [undefined, null, '', 0]) {
    assert.equal(bundleFilename(bad), 'process.process.json', String(bad));
  }
});
