import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ROUTING_SAVE_HINT, unsavedParts, leaveGuard, discardMessage,
  roleDeleteImpact, deleteRoleSummary,
} from './node-inspector-view.js';

// ── Routing hint (#2660 AC1) ─────────────────────────────────────────────────
test('the Routing hint names Save outcomes instead of claiming there is no Save', () => {
  assert.match(ROUTING_SAVE_HINT, /Save outcomes/);
  assert.doesNotMatch(ROUTING_SAVE_HINT, /no Save/i);
});

// ── unsaved-edit guard ───────────────────────────────────────────────────────
test('unsavedParts lists the dirty parts in display order', () => {
  assert.deepEqual(unsavedParts({}), []);
  assert.deepEqual(unsavedParts({ detailsDirty: true }), ['Details']);
  assert.deepEqual(unsavedParts({ outcomesDirty: true }), ['Outcomes']);
  assert.deepEqual(unsavedParts({ detailsDirty: true, outcomesDirty: true }), ['Details', 'Outcomes']);
  assert.deepEqual(unsavedParts(), []);
});

test('closing guards any unsaved part, including outcome edits', () => {
  assert.deepEqual(leaveGuard({ action: 'close', outcomesDirty: true }), ['Outcomes']);
  assert.deepEqual(leaveGuard({ action: 'close', detailsDirty: true }), ['Details']);
  assert.deepEqual(leaveGuard({ action: 'close' }), []);
});

test('leaving the Routing tab guards unsaved outcomes (the draft unmounts)', () => {
  assert.deepEqual(leaveGuard({ action: 'tab', fromTab: 'routing', toTab: 'details', outcomesDirty: true }), ['Outcomes']);
  assert.deepEqual(leaveGuard({ action: 'tab', fromTab: 'routing', toTab: 'details' }), []);
  // Re-clicking the active tab is not a leave.
  assert.deepEqual(leaveGuard({ action: 'tab', fromTab: 'routing', toTab: 'routing', outcomesDirty: true }), []);
});

test('leaving the Details tab never asks: its state survives the switch', () => {
  assert.deepEqual(leaveGuard({ action: 'tab', fromTab: 'details', toTab: 'routing', detailsDirty: true, outcomesDirty: true }), []);
  assert.deepEqual(leaveGuard({ action: 'bogus', detailsDirty: true }), []);
});

test('discardMessage names the parts and the action', () => {
  assert.equal(discardMessage(['Details'], 'close'),
    "This agent's Details tab has unsaved edits. Closing now discards them.");
  assert.equal(discardMessage(['Outcomes'], 'tab'),
    "This agent's Outcomes (Routing tab) has unsaved edits. Switching tabs discards them.");
  assert.equal(discardMessage(['Details', 'Outcomes'], 'close'),
    "This agent's Details tab and Outcomes (Routing tab) have unsaved edits. Closing now discards them.");
  assert.match(discardMessage(null, 'close'), /inspector has unsaved edits/);
});

// ── delete impact (#2660 AC2) ────────────────────────────────────────────────
const DEV = {
  id: 'developer', displayName: 'Developer',
  channels: [{ artifact: 'issue', from: 'analyst' }],
  triggers: [{ type: 'github-event', labelFilter: 'revisions-required' }],
  outcomes: { mode: 'anyOf', options: [
    { id: 'opens-pr', title: 'Opens PR', actions: [{ type: 'openPr' }, { type: 'wakeAgent', to: 'reviewer' }] },
  ] },
};
const REV = {
  id: 'reviewer', displayName: 'Code Reviewer',
  channels: [{ artifact: 'pr', from: 'developer' }],
  dependsOn: ['developer'],
  outcomes: { mode: 'exactlyOne', options: [
    { id: 'revise', title: 'Revisions required', actions: [{ type: 'setLabel', label: 'revisions-required' }] },
    { id: 'ok', title: 'Accepted', actions: [{ type: 'none' }] },
  ] },
};
const ANALYST = { id: 'analyst', displayName: 'Analyst', emits: ['needs-review'] };
const CHILD = { id: 'helper', parent: 'reviewer' };

test('deleting the reviewer lists hand-offs in both directions and its children', () => {
  const impact = roleDeleteImpact('reviewer', [DEV, REV, ANALYST, CHILD]);
  assert.deepEqual(impact.incoming, [
    'Developer → Code Reviewer: outcome “Opens PR” (direct hand-off)',
    'Code Reviewer reacts to Developer\'s pull requests',
    'Code Reviewer depends on Developer',
  ]);
  assert.deepEqual(impact.outgoing, [
    'Code Reviewer → Developer: label “revisions-required” (outcome “Revisions required”)',
  ]);
  assert.deepEqual(impact.children, ['helper (becomes top-level)']);
  assert.equal(impact.total, 5);
});

test('deleting the developer lists consumers of its channels and dependents', () => {
  const impact = roleDeleteImpact('developer', [DEV, REV, ANALYST]);
  assert.deepEqual(impact.incoming, [
    'Code Reviewer → Developer: label “revisions-required” (outcome “Revisions required”)',
    'Developer reacts to Analyst\'s issues',
  ]);
  assert.deepEqual(impact.outgoing, [
    'Developer → Code Reviewer: outcome “Opens PR” (direct hand-off)',
    'Code Reviewer reacts to Developer\'s pull requests',
    'Code Reviewer depends on Developer',
  ]);
  assert.deepEqual(impact.children, []);
});

test('a legacy flat emit counts as a label hand-off (no outcome named)', () => {
  const listener = { id: 'l', displayName: 'Listener', triggers: [{ labelFilter: 'needs-review' }] };
  const impact = roleDeleteImpact('analyst', [ANALYST, listener]);
  assert.deepEqual(impact.outgoing, ['Analyst → Listener: label “needs-review”']);
});

test('an unconnected role, an unknown id and junk input report nothing', () => {
  const lone = roleDeleteImpact('solo', [{ id: 'solo' }, ANALYST]);
  assert.deepEqual(lone, { incoming: [], outgoing: [], children: [], total: 0 });
  assert.equal(roleDeleteImpact('nope', [DEV, REV]).total, 0);
  assert.equal(roleDeleteImpact('x', null).total, 0);
  assert.equal(roleDeleteImpact('x', [null, 'junk', { id: 'x', outcomes: { options: [null] } }]).total, 0);
});

test('self-references and duplicate actions are not reported twice', () => {
  const self = { id: 's', displayName: 'S', dependsOn: ['s'], channels: [{ artifact: 'pr', from: 's' }],
    triggers: [{ labelFilter: 'loop' }],
    outcomes: { options: [{ title: 'Again', actions: [{ type: 'wakeAgent', to: 's' }, { type: 'setLabel', label: 'loop' }] }] } };
  const dup = { id: 'd', displayName: 'D', outcomes: { options: [
    { title: 'Go', actions: [{ type: 'wakeAgent', to: 's' }, { type: 'wakeAgent', to: 's' }] },
  ] } };
  const impact = roleDeleteImpact('s', [self, dup]);
  assert.deepEqual(impact.incoming, ['D → S: outcome “Go” (direct hand-off)']);
  assert.deepEqual(impact.outgoing, []);
});

test('deleteRoleSummary says it cannot be undone and counts the connections', () => {
  assert.match(deleteRoleSummary('Code Reviewer', { total: 0 }), /“Code Reviewer”.*cannot be undone.*no connections/);
  assert.match(deleteRoleSummary('X', { total: 1 }), /This connection is lost:$/);
  assert.match(deleteRoleSummary('X', { total: 3 }), /These 3 connections are lost:$/);
  assert.match(deleteRoleSummary('X', null), /no connections/);
});

// ── JSX wiring source guards (#651: the JSX itself is uncovered) ─────────────
const inspector = readFileSync(new URL('./NodeInspector.jsx', import.meta.url), 'utf8');
const routing = readFileSync(new URL('./RoutingSection.jsx', import.meta.url), 'utf8');

test('NodeInspector renders the scoped hint, not the old "no Save" claim', () => {
  assert.match(inspector, /\{ROUTING_SAVE_HINT\}/);
  assert.doesNotMatch(inspector, /there is no Save on this tab/);
});

test('NodeInspector guards close and tab switches through leaveGuard', () => {
  assert.match(inspector, /leaveGuard\(\{ action: 'close', detailsDirty: dirty, outcomesDirty \}\)/);
  assert.match(inspector, /leaveGuard\(\{ action: 'tab', fromTab: tab, toTab: next, detailsDirty: dirty, outcomesDirty \}\)/);
  assert.match(inspector, /<SidePanel open onClose=\{requestClose\}/);
  assert.match(inspector, /onClick=\{\(\) => requestTab\('details'\)\}/);
  assert.match(inspector, /onClick=\{\(\) => requestTab\('routing'\)\}/);
  assert.match(inspector, /onOutcomesDirtyChange=\{setOutcomesDirty\}/);
});

test('RoutingSection reports its outcomes dirty state to the host', () => {
  assert.match(routing, /useEffect\(\(\) => \{ onOutcomesDirtyChange\?\.\(dirty\); \}, \[dirty\]\);/);
});

test('Delete agent opens a confirmation and surfaces a failed delete', () => {
  assert.doesNotMatch(inspector, /onClick=\{async \(\) => \{ await ops\.deleteRole/);
  assert.match(inspector, /onClick=\{\(\) => \{ setDeleteError\(null\); setConfirmDelete\(true\); \}\}/);
  assert.match(inspector, /await ops\.deleteRole\(node\.id\);\s*setConfirmDelete\(false\);\s*onDeleted\?\.\(\);/);
  assert.match(inspector, /catch \(e\) \{\s*setDeleteError\(e\?\.message \|\| String\(e\)\);/);
  assert.match(inspector, /roleDeleteImpact\(node\.id, roles\)/);
});
