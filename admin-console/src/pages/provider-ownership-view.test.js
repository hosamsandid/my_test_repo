import test from 'node:test';
import assert from 'node:assert/strict';
import {
  providerOwnershipOptions,
  defaultProviderOwnership,
  providerOwnershipFromRecord,
  providerOwnershipPayload,
  providerOwnershipReady,
  providerScopeLabel,
  providerScopeShowsDetail,
} from './provider-ownership-view.js';

const byValue = (opts) => Object.fromEntries(opts.map(o => [o.value, o]));

test('options: api-key provider — personal always, team needs a team, global needs sysadmin', () => {
  const admin = byValue(providerOwnershipOptions({ isOauth: false, isSysAdmin: true, adminTeamIds: [] }));
  assert.equal(admin.personal.enabled, true);
  assert.equal(admin.team.enabled, true);
  assert.equal(admin.global.enabled, true);
  assert.equal(admin.team.label, 'Team(s)');

  const teamAdmin = byValue(providerOwnershipOptions({ isOauth: false, isSysAdmin: false, adminTeamIds: ['t'] }));
  assert.equal(teamAdmin.team.enabled, true);
  assert.equal(teamAdmin.global.enabled, false);

  const plain = byValue(providerOwnershipOptions({ isOauth: false, isSysAdmin: false, adminTeamIds: [] }));
  assert.equal(plain.team.enabled, false);
  assert.match(plain.team.disabledReason, /administer no team/);
});

test('options: a subscription (oauth) can never be team; global only via the hatch', () => {
  const noHatch = byValue(providerOwnershipOptions({ isOauth: true, isSysAdmin: true, canGlobalOauth: false }));
  assert.equal(noHatch.team.enabled, false);
  assert.match(noHatch.team.disabledReason, /single seat/);
  assert.equal(noHatch.global.enabled, false);
  const hatch = byValue(providerOwnershipOptions({ isOauth: true, isSysAdmin: true, canGlobalOauth: true }));
  assert.equal(hatch.global.enabled, true);
  assert.equal(hatch.team.enabled, false);
});

test('defaultProviderOwnership: oauth→personal; one admin team→that team set; else empty set', () => {
  assert.deepEqual(defaultProviderOwnership({ isOauth: true, isSysAdmin: true }), { scope: 'personal', teamIds: [] });
  assert.deepEqual(defaultProviderOwnership({ isSysAdmin: false, adminTeamIds: ['payments'] }), { scope: 'team', teamIds: ['payments'] });
  assert.deepEqual(defaultProviderOwnership({ isSysAdmin: true, adminTeamIds: [] }), { scope: 'team', teamIds: [] });
  // #2360: a plain member (open Models page) can only create Personal → default there.
  assert.deepEqual(defaultProviderOwnership({ isSysAdmin: false, adminTeamIds: [] }), { scope: 'personal', teamIds: [] });
});

test('providerOwnershipFromRecord maps every stored shape into a team SET', () => {
  assert.deepEqual(providerOwnershipFromRecord({ scope: 'system', global: true }), { scope: 'global', teamIds: [] });
  assert.deepEqual(providerOwnershipFromRecord({ scope: 'personal', userId: 'u' }), { scope: 'personal', teamIds: [] });
  // a multi-team provider round-trips its full set
  assert.deepEqual(providerOwnershipFromRecord({ scope: 'team', teamId: 'a', teamIds: ['a', 'b'] }), { scope: 'team', teamIds: ['a', 'b'] });
  // a single-team provider (only teamId) → one-element set
  assert.deepEqual(providerOwnershipFromRecord({ scope: 'team', teamId: 'payments' }), { scope: 'team', teamIds: ['payments'] });
  // legacy system + assignedTeamIds → collapses to a team set (multi-assign is first-class again)
  assert.deepEqual(providerOwnershipFromRecord({ scope: 'system', assignedTeamIds: ['a', 'b'] }), { scope: 'team', teamIds: ['a', 'b'] });
  // system, no teams, not global → global candidate
  assert.deepEqual(providerOwnershipFromRecord({ scope: 'system', assignedTeamIds: [] }), { scope: 'global', teamIds: [] });
});

test('providerOwnershipPayload: team(s) carries primary teamId + the full set; global carries the flag', () => {
  assert.deepEqual(providerOwnershipPayload({ scope: 'global' }), { scope: 'system', assignedTeamIds: [], global: true });
  assert.deepEqual(providerOwnershipPayload({ scope: 'team', teamIds: ['a', 'b', 'a'] }),
    { scope: 'team', teamId: 'a', teamIds: ['a', 'b'], global: false });
  assert.deepEqual(providerOwnershipPayload({ scope: 'personal' }), { scope: 'personal', global: false });
});

test('providerOwnershipReady: team needs ≥1 team; personal/global always ready', () => {
  assert.equal(providerOwnershipReady({ scope: 'personal' }), true);
  assert.equal(providerOwnershipReady({ scope: 'global' }), true);
  assert.equal(providerOwnershipReady({ scope: 'team', teamIds: [] }), false);
  assert.equal(providerOwnershipReady({ scope: 'team', teamIds: ['payments'] }), true);
});

test('providerScopeLabel: the table label mirrors the dialog taxonomy for every stored shape', () => {
  const names = { a: 'Alpha', b: 'Bravo' };
  // global → single Global pill, no team detail
  assert.deepEqual(providerScopeLabel({ scope: 'system', global: true }, names),
    { scope: 'global', label: 'Global', detail: 'Every user and agent team' });
  // personal → Personal, owner-only detail
  assert.deepEqual(providerScopeLabel({ scope: 'personal', userId: 'u' }, names),
    { scope: 'personal', label: 'Personal', detail: 'Only you and the agents you own' });
  // one team → singular "Team" pill + its name
  assert.deepEqual(providerScopeLabel({ scope: 'team', teamId: 'a' }, names),
    { scope: 'team', label: 'Team', detail: 'Alpha' });
  // several teams → plural "Teams" pill + the set, resolved to display names
  assert.deepEqual(providerScopeLabel({ scope: 'team', teamId: 'a', teamIds: ['a', 'b'] }, names),
    { scope: 'team', label: 'Teams', detail: 'Alpha, Bravo' });
});

test('providerScopeLabel: legacy system records collapse EXACTLY as the dialog does (the #2360 bug)', () => {
  const names = { a: 'Alpha', b: 'Bravo' };
  // legacy system + assignedTeamIds → "Teams" (was the stale "System" in the table)
  assert.deepEqual(providerScopeLabel({ scope: 'system', assignedTeamIds: ['a', 'b'] }, names),
    { scope: 'team', label: 'Teams', detail: 'Alpha, Bravo' });
  // system, no teams, not global → "Global" (matches providerOwnershipFromRecord)
  assert.deepEqual(providerScopeLabel({ scope: 'system', assignedTeamIds: [] }, names),
    { scope: 'global', label: 'Global', detail: 'Every user and agent team' });
  // an unknown team id falls back to the raw id (no name in the map)
  assert.deepEqual(providerScopeLabel({ scope: 'team', teamId: 'ghost' }, names),
    { scope: 'team', label: 'Team', detail: 'ghost' });
});

test('providerScopeShowsDetail: Ownership cell renders detail only for Team scope (#2405)', () => {
  // Team detail is the assigned team name(s) — real information, kept.
  assert.equal(providerScopeShowsDetail('team'), true);
  // Personal detail ("Only you and the agents you own") repeats the pill — dropped.
  assert.equal(providerScopeShowsDetail('personal'), false);
  // Global renders its own single pill upstream, no detail.
  assert.equal(providerScopeShowsDetail('global'), false);
});
