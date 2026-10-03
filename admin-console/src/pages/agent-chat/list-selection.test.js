import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGroups } from './agent-list-model.js';
import {
  INDIVIDUAL_KEY, INDIVIDUAL_LABEL, SHOW_ALL, NO_SELECTION_HINT, QUICK_FILTERS,
  normalizeSelection, agentEntryKey, isEntryShown, matchesSelection,
  selectionEntries, searchEntries, toggleEntry, setEntriesShown, pruneSelection,
  shownEntries, isEverythingShown, selectionSummary, applyQuickFilter,
  applySelectionAction, quickFiltersDisabledReason, migrateLegacyFilter,
  parseLegacyFilter, revealEntryKey, reorderAllowed,
} from './list-selection.js';

// ── Fixtures ─────────────────────────────────────────────────────────────
// me: Team Admin of alpha (shared), regular member of beta, sole member of
// mine (private). gamma is someone else's team (a System Admin sees it).
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

const AGENTS = [
  { id: 'alpha', role: 'team', displayName: 'Alpha' },
  { id: 'alpha-dev', role: 'team-member', parentTeamId: 'alpha', displayName: 'Dev' },
  { id: 'beta', role: 'team', displayName: 'Beta' },
  { id: 'beta-qa', role: 'team-member', parentTeamId: 'beta', displayName: 'QA' },
  { id: 'mine', role: 'team', displayName: 'Mine' },
  { id: 'gamma', role: 'team', displayName: 'Gamma' },
  { id: 'lonely', role: 'team-member', displayName: 'Lonely orphan' }, // no parent → ungrouped
];

function entriesFor(agents = AGENTS, ctx = CTX) {
  const { groups, singles } = buildGroups(agents);
  return { entries: selectionEntries(groups, singles, ctx), singles };
}
const keys = list => list.map(e => e.key);

// ── AC1: entries ─────────────────────────────────────────────────────────

test('AC1 — one entry per visible team (rail order) plus Individual agents last', () => {
  const { entries } = entriesFor();
  assert.deepEqual(keys(entries), ['team:alpha', 'team:beta', 'team:gamma', 'team:mine', INDIVIDUAL_KEY]);
  assert.equal(entries.at(-1).label, INDIVIDUAL_LABEL);
  assert.equal(entries.at(-1).kind, 'individual');
});

test('AC1 — no Individual agents entry when there are no ungrouped rows', () => {
  const { entries } = entriesFor(AGENTS.filter(a => a.id !== 'lonely'));
  assert.ok(!keys(entries).includes(INDIVIDUAL_KEY));
});

test('edge case — duplicate team names are told apart by the membership subtitle', () => {
  const agents = [
    { id: 'mine', role: 'team', displayName: 'Same' },
    { id: 'alpha', role: 'team', displayName: 'Same' },
  ];
  const { entries } = entriesFor(agents);
  const byTeam = Object.fromEntries(entries.map(e => [e.teamId, e.subtitle]));
  // Team Admins first, then members — the team header's own wording.
  assert.deepEqual(byTeam, { alpha: 'Me Myself, Ann', mine: 'Private' });
});

test('entries carry no subtitle when memberships are unknown', () => {
  const { entries } = entriesFor(AGENTS, {});
  assert.ok(entries.every(e => e.subtitle === ''));
});

// ── AC2: toggle / matching ───────────────────────────────────────────────

test('AC2 — toggling hides and re-shows an entry, several can be shown at once', () => {
  let sel = SHOW_ALL;
  sel = toggleEntry(sel, 'team:beta');
  assert.equal(isEntryShown(sel, 'team:beta'), false);
  assert.equal(isEntryShown(sel, 'team:alpha'), true);
  assert.equal(isEntryShown(sel, 'team:mine'), true);
  sel = toggleEntry(sel, 'team:beta');
  assert.deepEqual(sel, SHOW_ALL);
});

test('agentEntryKey / matchesSelection — team header, members and ungrouped rows', () => {
  assert.equal(agentEntryKey({ id: 'alpha', role: 'team' }), 'team:alpha');
  assert.equal(agentEntryKey({ id: 'x', role: 'team-member', parentTeamId: 'alpha' }), 'team:alpha');
  assert.equal(agentEntryKey({ id: 'x', role: 'team-member' }), INDIVIDUAL_KEY);
  assert.equal(agentEntryKey({ id: 'x', role: 'agent' }), INDIVIDUAL_KEY);
  const sel = { hidden: ['team:alpha'] };
  assert.equal(matchesSelection({ id: 'alpha-dev', role: 'team-member', parentTeamId: 'alpha' }, sel), false);
  assert.equal(matchesSelection({ id: 'beta', role: 'team' }, sel), true);
});

test('normalizeSelection — malformed input reads as everything shown', () => {
  for (const bad of [undefined, null, 'x', [], { kind: 'all' }, { hidden: 'x' }]) {
    assert.deepEqual(normalizeSelection(bad), SHOW_ALL);
  }
  assert.deepEqual(normalizeSelection({ hidden: ['a', 'a', '', 3, 'b'] }), { hidden: ['a', 'b'] });
});

// ── AC3 / AC4: select all, deselect all, search ──────────────────────────

test('AC3 — Deselect all hides every entry; Select all shows them again', () => {
  const { entries } = entriesFor();
  const none = setEntriesShown(SHOW_ALL, keys(entries), false);
  assert.equal(shownEntries(entries, none).length, 0);
  assert.equal(typeof NO_SELECTION_HINT, 'string');
  assert.match(NO_SELECTION_HINT, /No teams selected/);
  const all = setEntriesShown(none, keys(entries), true);
  assert.ok(isEverythingShown(entries, all));
});

test('AC4 — search is a case-insensitive substring over the labels', () => {
  const { entries } = entriesFor();
  assert.deepEqual(keys(searchEntries(entries, 'ALP')), ['team:alpha']);
  assert.deepEqual(keys(searchEntries(entries, 'a')), ['team:alpha', 'team:beta', 'team:gamma', INDIVIDUAL_KEY]);
  assert.equal(searchEntries(entries, '   ').length, entries.length);
  assert.equal(searchEntries(entries, 'zzz').length, 0);
});

test('AC4 — Select all / Deselect all touch only the listed (searched) entries', () => {
  const { entries } = entriesFor();
  const listed = keys(searchEntries(entries, 'm')); // Gamma, Mine
  const sel = applySelectionAction(SHOW_ALL, { type: 'set', keys: listed, shown: false }, entries);
  assert.deepEqual(sel.hidden, ['team:gamma', 'team:mine']);
  assert.ok(isEntryShown(sel, 'team:alpha'));
});

// ── AC5: quick filters ───────────────────────────────────────────────────

test('AC5 — the four quick filters exist with the issue\'s labels', () => {
  assert.deepEqual(QUICK_FILTERS.map(q => q.label), [
    'Only my private teams',
    'Teams I am a member of',
    'Teams where I am Team Admin',
    'Teams where I am a regular member',
  ]);
});

test('AC5 — each quick filter selects exactly the matching teams, Individual agents off', () => {
  const { entries } = entriesFor();
  const shownBy = id => keys(shownEntries(entries, applyQuickFilter(id, entries, CTX)));
  assert.deepEqual(shownBy('private'), ['team:mine']);
  assert.deepEqual(shownBy('member'), ['team:alpha', 'team:beta', 'team:mine']);
  assert.deepEqual(shownBy('admin'), ['team:alpha', 'team:mine']);
  assert.deepEqual(shownBy('regular'), ['team:beta']);
});

test('AC5 — a quick filter replaces the selection (one-shot preset) and can then be adjusted', () => {
  const { entries } = entriesFor();
  const start = { hidden: ['team:mine'] };
  let sel = applySelectionAction(start, { type: 'quick', filterId: 'private' }, entries, CTX);
  assert.deepEqual(keys(shownEntries(entries, sel)), ['team:mine']);
  sel = applySelectionAction(sel, { type: 'toggle', key: 'team:gamma' }, entries, CTX);
  assert.deepEqual(keys(shownEntries(entries, sel)), ['team:gamma', 'team:mine']);
});

test('AC5 — a team seen without membership (System Admin) matches no quick filter; no match → empty selection', () => {
  const { entries } = entriesFor();
  for (const q of QUICK_FILTERS) {
    assert.ok(!isEntryShown(applyQuickFilter(q.id, entries, CTX), 'team:gamma'), q.id);
  }
  const stranger = { ...CTX, viewerId: 'u-nobody' };
  assert.equal(shownEntries(entries, applyQuickFilter('member', entries, stranger)).length, 0);
});

test('edge case — quick filters are disabled with a reason until memberships have loaded', () => {
  assert.match(quickFiltersDisabledReason({ membershipsLoaded: false, viewerId: ME }), /not loaded/);
  assert.ok(quickFiltersDisabledReason({ membershipsLoaded: true, viewerId: null }));
  assert.equal(quickFiltersDisabledReason({ membershipsLoaded: true, viewerId: ME }), null);
});

// ── AC6: summary ─────────────────────────────────────────────────────────

test('AC6 — summary reads "All agents", the single name, or "N of M teams"', () => {
  const { entries } = entriesFor();
  assert.equal(selectionSummary(entries, SHOW_ALL), 'All agents');
  assert.equal(selectionSummary(entries, { hidden: keys(entries).filter(k => k !== 'team:beta') }), 'Beta');
  assert.equal(selectionSummary(entries, { hidden: keys(entries).filter(k => k !== INDIVIDUAL_KEY) }), INDIVIDUAL_LABEL);
  assert.equal(selectionSummary(entries, { hidden: ['team:beta', 'team:gamma'] }), '3 of 5 teams');
  assert.equal(selectionSummary(entries, { hidden: keys(entries) }), '0 of 5 teams');
});

// ── AC7 / AC8: new teams shown, gone teams pruned ────────────────────────

test('AC7 — a team that appears after the selection was saved is shown by default', () => {
  const saved = { hidden: ['team:beta'] };
  const { entries } = entriesFor([...AGENTS, { id: 'delta', role: 'team', displayName: 'Delta' }]);
  assert.ok(isEntryShown(saved, 'team:delta'));
  assert.ok(keys(shownEntries(entries, saved)).includes('team:delta'));
});

test('AC8 — a team that is gone is dropped from the saved selection on the next write', () => {
  const { entries } = entriesFor();
  assert.deepEqual(pruneSelection({ hidden: ['team:gone', 'team:beta'] }, entries), { hidden: ['team:beta'] });
  const next = applySelectionAction({ hidden: ['team:gone'] }, { type: 'toggle', key: 'team:beta' }, entries);
  assert.deepEqual(next, { hidden: ['team:beta'] });
  assert.deepEqual(pruneSelection({ hidden: ['team:gone'] }, entries), SHOW_ALL);
});

test('an unknown action leaves the selection untouched', () => {
  const sel = { hidden: ['team:beta'] };
  assert.equal(applySelectionAction(sel, { type: 'nope' }, []), sel);
});

// ── AC9: legacy migration ────────────────────────────────────────────────

test('AC9 — parseLegacyFilter reads the old localStorage value defensively', () => {
  assert.deepEqual(parseLegacyFilter('{"kind":"team","id":"beta"}'), { kind: 'team', id: 'beta' });
  assert.equal(parseLegacyFilter(null), null);
  assert.equal(parseLegacyFilter('not json'), null);
  assert.equal(parseLegacyFilter('{"id":"x"}'), null);
});

test('AC9 — all → everything; team:<id> → only that team; gone team → everything', () => {
  const { entries, singles } = entriesFor();
  assert.deepEqual(migrateLegacyFilter({ kind: 'all' }, entries, singles), SHOW_ALL);
  const onlyBeta = migrateLegacyFilter({ kind: 'team', id: 'beta' }, entries, singles);
  assert.deepEqual(keys(shownEntries(entries, onlyBeta)), ['team:beta']);
  assert.deepEqual(migrateLegacyFilter({ kind: 'team', id: 'gone' }, entries, singles), SHOW_ALL);
  assert.deepEqual(migrateLegacyFilter(null, entries, singles), SHOW_ALL);
});

test('AC9 — agent:<id> → the Individual agents block when standalone, otherwise everything', () => {
  const { entries, singles } = entriesFor();
  const solo = migrateLegacyFilter({ kind: 'agent', id: 'lonely' }, entries, singles);
  assert.deepEqual(keys(shownEntries(entries, solo)), [INDIVIDUAL_KEY]);
  assert.deepEqual(migrateLegacyFilter({ kind: 'agent', id: 'alpha-dev' }, entries, singles), SHOW_ALL);
});

// ── AC10: reveal ─────────────────────────────────────────────────────────

test('AC10 — reveal ticks in only the hidden target\'s entry and keeps the rest', () => {
  const { entries } = entriesFor();
  const sel = { hidden: ['team:alpha', 'team:gamma'] };
  const dev = AGENTS.find(a => a.id === 'alpha-dev');
  assert.equal(revealEntryKey(dev, sel), 'team:alpha');
  assert.equal(revealEntryKey(AGENTS.find(a => a.id === 'beta'), sel), null);
  assert.equal(revealEntryKey(null, sel), null);
  const next = applySelectionAction(sel, { type: 'reveal', key: 'team:alpha' }, entries);
  assert.deepEqual(next, { hidden: ['team:gamma'] });
});

// ── AC11: reorder gates ──────────────────────────────────────────────────

test('AC11 — group/single reorder only with everything shown; member reorder also with exactly one team', () => {
  const { entries } = entriesFor();
  assert.deepEqual(reorderAllowed(entries, SHOW_ALL), { groups: true, members: true });
  const onlyBeta = { hidden: keys(entries).filter(k => k !== 'team:beta') };
  assert.deepEqual(reorderAllowed(entries, onlyBeta), { groups: false, members: true });
  const onlySingles = { hidden: keys(entries).filter(k => k !== INDIVIDUAL_KEY) };
  assert.deepEqual(reorderAllowed(entries, onlySingles), { groups: false, members: false });
  assert.deepEqual(reorderAllowed(entries, { hidden: ['team:beta'] }), { groups: false, members: false });
});
