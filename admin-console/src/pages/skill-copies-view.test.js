import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCopiesView, filterCopyGroups, shouldOfferCopyFilter, describeOrigin,
  driftTooltip, copiesSummaryText, resolveViewerTab, DRIFT_EXPLANATIONS, DRIFT_LEGEND_ORDER,
  NO_TEAM_LABEL, GLOBAL_POOL_LABEL, COPIES_TAB_ID,
} from './skill-copies-view.js';

const agents = [
  { id: 'qc', role: 'team', displayName: 'Quality Control' },
  { id: 'qc-alex', displayName: "Alex's Assistant", parentTeamId: 'qc' },
  { id: 'qc-bob', displayName: 'Bob', parentTeamId: 'qc' },
  { id: 'onb-creator', displayName: 'Onboarding Skill Creator', parentTeamId: 'onb' },
  { id: 'onb-my-1', displayName: 'My Assistant', parentTeamId: 'onb' },
  { id: 'onb-my-2', displayName: 'My Assistant', parentTeamId: 'onb' },
  { id: 'qc-my', displayName: 'My Assistant', parentTeamId: 'qc' },
];
const teamNames = { qc: 'Quality Control', onb: 'Onboarding', default: 'Default' };

const labelsOf = g => g.entries.map(e => e.label);

test('buildCopiesView: global first, then team groups by name, team pool before agents, alphabetical (AC5)', () => {
  const view = buildCopiesView([
    { tier: 'agent', agentId: 'qc-bob', teamId: 'default' },
    { tier: 'agent', agentId: 'qc-alex', teamId: 'default' },
    { tier: 'team', teamId: 'qc' },
    { tier: 'agent', agentId: 'onb-creator', teamId: 'default' },
    { tier: 'global' },
  ], { agents, teamNames });
  assert.equal(view.viewed, null);
  assert.equal(view.total, 5);
  assert.deepEqual(view.groups.map(g => g.label), [GLOBAL_POOL_LABEL, 'Onboarding', 'Quality Control']);
  assert.deepEqual(labelsOf(view.groups[0]), ['Global pool']);
  assert.deepEqual(labelsOf(view.groups[2]), ['Team pool · Quality Control', "Alex's Assistant · Quality Control", 'Bob · Quality Control']);
});

test('buildCopiesView: every copy exactly once, viewed copy pulled out first (AC4)', () => {
  const copies = [
    { tier: 'global' },
    { tier: 'agent', agentId: 'qc-alex', viewed: true },
    { tier: 'agent', agentId: 'qc-bob' },
  ];
  const view = buildCopiesView(copies, { agents, teamNames });
  assert.equal(view.viewed.copy.agentId, 'qc-alex');
  const all = [view.viewed, ...view.groups.flatMap(g => g.entries)];
  assert.equal(all.length, copies.length);
  assert.equal(new Set(all.map(e => e.copy)).size, copies.length);
  assert.ok(!view.groups.flatMap(g => g.entries).some(e => e.viewed));
});

test('buildCopiesView: agent shows display name + team name, id secondary; team id falls back (AC6/AC15)', () => {
  const view = buildCopiesView([
    { tier: 'agent', agentId: 'qc-alex' },
    { tier: 'team', teamId: 'ghost-team' },
  ], { agents, teamNames });
  const alex = view.groups.find(g => g.teamId === 'qc').entries[0];
  assert.equal(alex.label, "Alex's Assistant · Quality Control");
  assert.equal(alex.secondary, 'qc-alex');
  const ghost = view.groups.find(g => g.teamId === 'ghost-team');
  assert.equal(ghost.label, 'ghost-team');
  assert.equal(ghost.entries[0].label, 'Team pool · ghost-team');
});

test('buildCopiesView: groups by the agent team, never the legacy access-scope teamId', () => {
  const view = buildCopiesView([{ tier: 'agent', agentId: 'qc-bob', teamId: 'default' }], { agents, teamNames });
  assert.deepEqual(view.groups.map(g => g.label), ['Quality Control']);
});

test('buildCopiesView: unresolvable agents go into a final "No team" group, id as name', () => {
  const view = buildCopiesView([
    { tier: 'agent', agentId: 'gone-agent' },
    { tier: 'agent', agentId: 'qc-bob' },
  ], { agents, teamNames });
  assert.deepEqual(view.groups.map(g => g.label), ['Quality Control', NO_TEAM_LABEL]);
  const e = view.groups[1].entries[0];
  assert.equal(e.label, `gone-agent · ${NO_TEAM_LABEL}`);
  assert.equal(e.secondary, null);
});

test('buildCopiesView: same display name in the same team gets the id suffix; different team does not (AC16)', () => {
  const view = buildCopiesView([
    { tier: 'agent', agentId: 'onb-my-2' },
    { tier: 'agent', agentId: 'onb-my-1' },
    { tier: 'agent', agentId: 'qc-my' },
  ], { agents, teamNames });
  assert.deepEqual(labelsOf(view.groups.find(g => g.teamId === 'onb')), [
    'My Assistant (onb-my-1) · Onboarding',
    'My Assistant (onb-my-2) · Onboarding',
  ]);
  assert.deepEqual(labelsOf(view.groups.find(g => g.teamId === 'qc')), ['My Assistant · Quality Control']);
});

test('filterCopyGroups: matches team name, agent name and id; blank query is a no-op (AC11)', () => {
  const { groups } = buildCopiesView([
    { tier: 'global' },
    { tier: 'team', teamId: 'qc' },
    { tier: 'agent', agentId: 'qc-alex' },
    { tier: 'agent', agentId: 'onb-creator' },
  ], { agents, teamNames });
  assert.equal(filterCopyGroups(groups, '  '), groups);
  assert.deepEqual(filterCopyGroups(groups, 'quality').map(g => g.entries.length), [2]);
  assert.deepEqual(filterCopyGroups(groups, 'alex').flatMap(g => g.entries.map(e => e.copy.agentId)), ['qc-alex']);
  assert.deepEqual(filterCopyGroups(groups, 'onb-cre').flatMap(g => g.entries.map(e => e.copy.agentId)), ['onb-creator']);
  assert.deepEqual(filterCopyGroups(groups, 'zzz'), []);
});

test('shouldOfferCopyFilter: only for more than 10 entries', () => {
  assert.equal(shouldOfferCopyFilter(10), false);
  assert.equal(shouldOfferCopyFilter(11), true);
});

test('describeOrigin: plain-language sentence with names, version and source-gone note (AC2/AC17)', () => {
  const text = parts => parts.map(p => p.text).join('');
  assert.equal(text(describeOrigin(null)), 'No recorded origin (hand-authored).');
  assert.equal(
    text(describeOrigin({ tier: 'agent', agentId: 'onb-creator', sourceVersion: 1, sourceHash: 'e663de99' }, { agents, teamNames })),
    'Taken from agent Onboarding Skill Creator (team Onboarding), version v1 · e663de.',
  );
  assert.equal(
    text(describeOrigin({ tier: 'agent', agentId: 'onb-creator', sourceHash: 'e663de99' }, { agents, teamNames, sourceGone: true })),
    'Taken from agent Onboarding Skill Creator (team Onboarding), version e663de — this source no longer exists.',
  );
  assert.equal(text(describeOrigin({ tier: 'team', teamId: 'qc' }, { teamNames })), 'Taken from the team pool of Quality Control.');
  assert.equal(text(describeOrigin({ tier: 'global', sourceHash: 'abcdef12' })), 'Taken from the global pool, version abcdef.');
});

test('driftTooltip: every drift state has a sentence + hint; no state → no tooltip (AC9/AC10)', () => {
  for (const s of DRIFT_LEGEND_ORDER) {
    assert.ok(DRIFT_EXPLANATIONS[s], s);
    assert.match(driftTooltip(s), /\.\s.+\.$/);
  }
  assert.match(driftTooltip('orphaned'), /no longer exists.*nothing to do/i);
  assert.equal(driftTooltip(undefined), null);
});

test('copiesSummaryText: places by tier (AC3)', () => {
  assert.equal(copiesSummaryText({ total: 22, byTier: { global: 1, team: 0, agent: 21 } }), 'Lives in 22 places — 1 global, 0 team, 21 agent.');
  assert.equal(copiesSummaryText({ total: 1, byTier: { global: 1 } }), 'Lives in 1 place — 1 global, 0 team, 0 agent.');
  assert.equal(copiesSummaryText(null), null);
});

test('resolveViewerTab: old lineage/usage links open the merged tab (AC1)', () => {
  const ids = ['content', 'versions', COPIES_TAB_ID];
  assert.equal(resolveViewerTab('lineage', ids), COPIES_TAB_ID);
  assert.equal(resolveViewerTab('usage', ids), COPIES_TAB_ID);
  assert.equal(resolveViewerTab('versions', ids), 'versions');
  assert.equal(resolveViewerTab('bogus', ids), null);
  assert.equal(resolveViewerTab(undefined, ids), null);
});
