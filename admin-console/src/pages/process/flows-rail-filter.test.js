import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SHOW_ALL, FLOWS_QUICK_FILTERS, GROUP_TEAMS, GROUP_DRAFTS,
  NO_FLOWS_SELECTED_HINT, ALL_TEAMS_HIDDEN_HINT, ALL_DRAFTS_HIDDEN_HINT,
  normalizeSelection, isEntryShown, searchEntries, shownEntries,
  procEntryKey, flowsFilterEntries, flowsSelectionSummary,
  draftMatchesQuickFilter, applyFlowsQuickFilter, pruneFlowsSelection,
  applyFlowsFilterAction, revealKeyForProc, flowsRailView,
} from './flows-rail-filter.js';
import { applyQuickFilter, selectionEntries } from '../agent-chat/list-selection.js';
import { draftSubtitle } from './draft-share-view.js';

// ── Fixtures ─────────────────────────────────────────────────────────────
// Same membership shape as Agent Chat's list-selection tests: me is Team Admin
// of alpha (shared), regular member of beta, sole member of mine (private);
// gamma is someone else's team (a System Admin sees it).
const ME = 'u-me';
const DIRECTORY = [
  { id: 'u-me', displayName: 'Me Myself', email: 'me@x' },
  { id: 'u-ann', displayName: 'Ann', email: 'ann@x' },
  { id: 'u-bob', displayName: 'Bob', email: 'bob@x' },
];
const MEMBERSHIPS = [
  { teamId: 'alpha', userId: 'u-me', role: 'team-admin' },
  { teamId: 'alpha', userId: 'u-ann', role: 'team-member' },
  { teamId: 'beta', userId: 'u-bob', role: 'team-admin' },
  { teamId: 'beta', userId: 'u-me', role: 'team-member' },
  { teamId: 'mine', userId: 'u-me', role: 'team-admin' },
  { teamId: 'gamma', userId: 'u-bob', role: 'team-admin' },
];
const CTX = { memberships: MEMBERSHIPS, directory: DIRECTORY, viewerId: ME };

const TEAMS = [
  { id: 'alpha', role: 'team', displayName: 'Alpha', environmentId: 'env-a' },
  { id: 'beta', role: 'team', displayName: 'Beta', environmentId: 'env-b' },
  { id: 'mine', role: 'team', displayName: 'Mine', environmentId: 'env-a' },
  { id: 'gamma', role: 'team', displayName: 'Gamma', environmentId: 'env-gone' },
];
// my-private: mine, unshared · my-shared: mine, shared · from-ann: Ann's,
// shared with me · admin-only: someone else's draft only a System Admin sees.
const DRAFTS = [
  { id: 'my-private', name: 'Pipeline', roleCount: 2, shared: false, accessCount: 1, createdByYou: true, createdByName: 'Me Myself', viewerHasAccess: true },
  { id: 'my-shared', name: 'Release', roleCount: 1, shared: true, accessCount: 2, createdByYou: true, createdByName: 'Me Myself', viewerHasAccess: true },
  { id: 'from-ann', name: 'Pipeline', roleCount: 3, shared: true, accessCount: 2, createdByYou: false, createdByName: 'Ann', viewerHasAccess: true },
  { id: 'admin-only', name: 'Ops', roleCount: 0, shared: false, accessCount: 1, createdByYou: false, createdByName: 'Bob', viewerHasAccess: false },
];
const ENV = new Map([['env-a', 'Env A'], ['env-b', 'Env B']]);
const entries = flowsFilterEntries({ teams: TEAMS, drafts: DRAFTS, envNameById: ENV, draftSubtitle });
const keys = list => list.map(e => e.key);
const shownBy = id => keys(shownEntries(entries, applyFlowsQuickFilter(id, entries, CTX)));

// ── Entries (AC2) ────────────────────────────────────────────────────────

test('AC2 — one entry per team and per draft, teams first, grouped like the rail', () => {
  assert.deepEqual(keys(entries), [
    'team:alpha', 'team:beta', 'team:mine', 'team:gamma',
    'draft:my-private', 'draft:my-shared', 'draft:from-ann', 'draft:admin-only',
  ]);
  assert.deepEqual([...new Set(entries.map(e => e.group))], [GROUP_TEAMS, GROUP_DRAFTS]);
});

test('AC2 — a team carries its environment line, a draft the rail\'s draftSubtitle', () => {
  const byKey = Object.fromEntries(entries.map(e => [e.key, e]));
  assert.equal(byKey['team:alpha'].subtitle, 'Env A');
  // An environment the viewer cannot resolve falls back to its id, as the rail does.
  assert.equal(byKey['team:gamma'].subtitle, 'env-gone');
  assert.equal(byKey['draft:from-ann'].subtitle, draftSubtitle(DRAFTS[2]));
});

test('AC2 — two drafts with the same name stay distinguishable by their secondary line', () => {
  const pipelines = entries.filter(e => e.label === 'Pipeline');
  assert.equal(pipelines.length, 2);
  assert.notEqual(pipelines[0].key, pipelines[1].key);
  assert.notEqual(pipelines[0].subtitle, pipelines[1].subtitle);
});

test('no teams and/or no drafts → that group simply has no entries', () => {
  const onlyDrafts = flowsFilterEntries({ teams: [], drafts: DRAFTS, draftSubtitle });
  assert.ok(onlyDrafts.every(e => e.group === GROUP_DRAFTS));
  assert.deepEqual(flowsFilterEntries({}), []);
});

// ── Search, select / deselect (AC3/AC4) ─────────────────────────────────

test('AC3 — search is a case-insensitive name substring and never changes the selection', () => {
  assert.deepEqual(keys(searchEntries(entries, 'PIPE')), ['draft:my-private', 'draft:from-ann']);
  assert.deepEqual(keys(searchEntries(entries, '  ')), keys(entries));
});

test('AC4 — Select all / Deselect all act on the listed (searched) entries only', () => {
  const listed = keys(searchEntries(entries, 'pipe'));
  const off = applyFlowsFilterAction(SHOW_ALL, { type: 'set', keys: listed, shown: false }, entries);
  assert.deepEqual(off.hidden, ['draft:from-ann', 'draft:my-private']);
  assert.ok(isEntryShown(off, 'team:alpha'));
  const back = applyFlowsFilterAction(off, { type: 'set', keys: listed, shown: true }, entries);
  assert.equal(back, SHOW_ALL);
  const none = applyFlowsFilterAction(SHOW_ALL, { type: 'set', keys: keys(entries), shown: false }, entries);
  assert.equal(shownEntries(entries, none).length, 0);
});

test('toggle checks and unchecks one entry', () => {
  const s = applyFlowsFilterAction(SHOW_ALL, { type: 'toggle', key: 'draft:my-shared' }, entries);
  assert.deepEqual(s.hidden, ['draft:my-shared']);
  assert.equal(applyFlowsFilterAction(s, { type: 'toggle', key: 'draft:my-shared' }, entries), SHOW_ALL);
});

test('AC1 — the summary reads All flows, a single flow name, or N of M flows', () => {
  assert.equal(flowsSelectionSummary(entries, SHOW_ALL), 'All flows');
  const one = { hidden: keys(entries).filter(k => k !== 'team:beta') };
  assert.equal(flowsSelectionSummary(entries, one), 'Beta');
  assert.equal(flowsSelectionSummary(entries, { hidden: ['team:beta'] }), '7 of 8 flows');
  assert.equal(flowsSelectionSummary([], SHOW_ALL), 'All flows');
});

// ── Quick filters (AC6/AC8) ─────────────────────────────────────────────

test('AC6 — Only my private flows: my sole-member team and my unshared drafts', () => {
  assert.deepEqual(shownBy('private'), ['team:mine', 'draft:my-private']);
});

test('AC6 — Flows I am a member of: my teams (any role) and every draft I have access to', () => {
  assert.deepEqual(shownBy('member'), [
    'team:alpha', 'team:beta', 'team:mine',
    'draft:my-private', 'draft:my-shared', 'draft:from-ann',
  ]);
});

test('AC6 — the role filters match teams only, never drafts', () => {
  assert.deepEqual(shownBy('admin'), ['team:alpha', 'team:mine']);
  assert.deepEqual(shownBy('regular'), ['team:beta']);
});

test('edge — a draft shared with me by someone else is "member", not "private"', () => {
  const fromAnn = entries.find(e => e.key === 'draft:from-ann');
  assert.equal(draftMatchesQuickFilter('member', fromAnn, ME), true);
  assert.equal(draftMatchesQuickFilter('private', fromAnn, ME), false);
});

test('edge — a System Admin\'s view of a team or draft they do not belong to matches no quick filter', () => {
  for (const q of FLOWS_QUICK_FILTERS) {
    const s = applyFlowsQuickFilter(q.id, entries, CTX);
    assert.ok(!isEntryShown(s, 'team:gamma'), q.id);
    assert.ok(!isEntryShown(s, 'draft:admin-only'), q.id);
  }
});

test('AC6 — a quick filter that matches nothing yields an empty selection, not an error', () => {
  const stranger = { memberships: MEMBERSHIPS, directory: DIRECTORY, viewerId: 'u-nobody' };
  const theirs = flowsFilterEntries({ teams: TEAMS, drafts: DRAFTS.filter(d => !d.createdByYou && !d.viewerHasAccess) });
  const s = applyFlowsQuickFilter('member', theirs, stranger);
  assert.equal(shownEntries(theirs, s).length, 0);
  const view = flowsRailView({ teams: TEAMS, drafts: [DRAFTS[3]], selection: s });
  assert.equal(view.nothingSelected, true);
  // No signed-in user at all → nothing matches either.
  assert.equal(shownEntries(entries, applyFlowsQuickFilter('member', entries, {})).length, 0);
});

test('AC8 — team matches are exactly Agent Chat\'s for the same memberships', () => {
  const chatEntries = selectionEntries(TEAMS.map(t => ({ id: t.id, displayName: t.displayName })), [], CTX);
  const teamEntries = entries.filter(e => e.kind === 'team');
  for (const q of FLOWS_QUICK_FILTERS) {
    const chat = shownEntries(chatEntries, applyQuickFilter(q.id, chatEntries, CTX)).map(e => e.key);
    const flows = shownEntries(teamEntries, applyFlowsQuickFilter(q.id, entries, CTX)).map(e => e.key);
    assert.deepEqual(flows, chat, q.id);
  }
});

test('a quick-filter result is an ordinary selection the user can adjust', () => {
  const s = applyFlowsFilterAction(SHOW_ALL, { type: 'quick', filterId: 'admin' }, entries, CTX);
  const adjusted = applyFlowsFilterAction(s, { type: 'toggle', key: 'draft:from-ann' }, entries, CTX);
  assert.deepEqual(keys(shownEntries(entries, adjusted)), ['team:alpha', 'team:mine', 'draft:from-ann']);
});

test('edge — a private flow that became shared stops matching "private" on the next application only', () => {
  const applied = applyFlowsQuickFilter('private', entries, CTX);
  const nowShared = DRAFTS.map(d => (d.id === 'my-private' ? { ...d, shared: true, accessCount: 2 } : d));
  const later = flowsFilterEntries({ teams: TEAMS, drafts: nowShared });
  // The saved selection is unchanged…
  assert.ok(isEntryShown(applied, 'draft:my-private'));
  // …until the filter is applied again.
  assert.ok(!isEntryShown(applyFlowsQuickFilter('private', later, CTX), 'draft:my-private'));
});

// ── Persistence on the hidden side (AC9/AC10) ───────────────────────────

test('AC9 — a missing or malformed stored value means "show everything"', () => {
  for (const raw of [undefined, null, 'x', [], { hidden: 'draft:a' }, {}]) {
    assert.equal(normalizeSelection(raw), SHOW_ALL);
  }
});

test('AC10 — a flow that appears later is shown by default', () => {
  const s = { hidden: ['draft:my-shared'] };
  const more = flowsFilterEntries({ teams: [...TEAMS, { id: 'new-team' }], drafts: [...DRAFTS, { id: 'new-draft' }] });
  assert.ok(isEntryShown(s, 'team:new-team'));
  assert.ok(isEntryShown(s, 'draft:new-draft'));
  assert.equal(shownEntries(more, s).length, more.length - 1);
});

test('AC10 — hidden keys of deleted flows are pruned on the next write', () => {
  const s = { hidden: ['draft:deleted', 'team:gone', 'team:gamma'] };
  const next = applyFlowsFilterAction(s, { type: 'toggle', key: 'draft:my-shared' }, entries);
  assert.deepEqual(next.hidden, ['draft:my-shared', 'team:gamma']);
});

test('AC10 — a section that has not loaded keeps its hidden keys through a write', () => {
  const teamEntries = entries.filter(e => e.kind === 'team');
  const s = { hidden: ['draft:my-shared', 'team:gone'] };
  const pruned = pruneFlowsSelection(s, teamEntries, { teamsLoaded: true, draftsLoaded: false });
  assert.deepEqual(pruned.hidden, ['draft:my-shared']);
  assert.equal(pruneFlowsSelection({ hidden: ['other:x'] }, entries), SHOW_ALL);
});

test('edge — a renamed (re-keyed) draft is shown, never left hidden without an entry', () => {
  const s = { hidden: ['draft:my-private'] };
  const renamed = DRAFTS.map(d => (d.id === 'my-private' ? { ...d, id: 'pipeline-v2' } : d));
  const after = flowsFilterEntries({ teams: TEAMS, drafts: renamed });
  assert.ok(isEntryShown(s, 'draft:pipeline-v2'));
  const next = applyFlowsFilterAction(s, { type: 'toggle', key: 'team:beta' }, after);
  assert.deepEqual(next.hidden, ['team:beta']);
});

// ── Reveal on open (AC11) ───────────────────────────────────────────────

test('AC11 — opening a hidden flow names exactly the entry to tick back in', () => {
  const s = { hidden: ['team:alpha', 'draft:my-shared', 'draft:from-ann'] };
  assert.equal(revealKeyForProc('alpha', s), 'team:alpha');
  assert.equal(revealKeyForProc('draft:my-shared', s), 'draft:my-shared');
  assert.equal(revealKeyForProc('beta', s), null);
  assert.equal(revealKeyForProc('import', s), null);
  assert.equal(revealKeyForProc(null, s), null);
  const next = applyFlowsFilterAction(s, { type: 'reveal', key: revealKeyForProc('draft:my-shared', s) }, entries);
  assert.deepEqual(next.hidden, ['draft:from-ann', 'team:alpha']);
});

test('procEntryKey maps a ?proc= scope to its entry key', () => {
  assert.equal(procEntryKey('alpha'), 'team:alpha');
  assert.equal(procEntryKey('draft:x'), 'draft:x');
  assert.equal(procEntryKey('import'), null);
  assert.equal(procEntryKey(''), null);
});

// ── What the rail renders (AC5) ─────────────────────────────────────────

test('AC5 — the rail shows only the selected flows', () => {
  const v = flowsRailView({ teams: TEAMS, drafts: DRAFTS, selection: { hidden: ['team:beta', 'draft:admin-only'] } });
  assert.deepEqual(v.teams.map(t => t.id), ['alpha', 'mine', 'gamma']);
  assert.deepEqual(v.drafts.map(d => d.id), ['my-private', 'my-shared', 'from-ann']);
  assert.equal(v.teamsHint, null);
  assert.equal(v.draftsHint, null);
  assert.equal(v.nothingSelected, false);
});

test('AC5 — a fully hidden section says so; nothing selected gets the page hint', () => {
  const noTeams = flowsRailView({ teams: TEAMS, drafts: DRAFTS, selection: { hidden: TEAMS.map(t => `team:${t.id}`) } });
  assert.equal(noTeams.teamsHint, ALL_TEAMS_HIDDEN_HINT);
  assert.equal(noTeams.draftsHint, null);
  const none = flowsRailView({ teams: TEAMS, drafts: DRAFTS, selection: { hidden: keys(entries) } });
  assert.equal(none.draftsHint, ALL_DRAFTS_HIDDEN_HINT);
  assert.equal(none.nothingSelected, true);
  assert.match(NO_FLOWS_SELECTED_HINT, /filter/);
});

test('edge — an empty section keeps its own empty state, no filter hint', () => {
  const v = flowsRailView({ teams: [], drafts: DRAFTS, selection: SHOW_ALL });
  assert.equal(v.teamsHint, null);
  assert.equal(flowsRailView({ teams: [], drafts: [], selection: SHOW_ALL }).nothingSelected, false);
});
