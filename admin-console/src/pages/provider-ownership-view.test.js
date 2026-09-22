import test from 'node:test';
import assert from 'node:assert/strict';
import {
  providerOwnershipOptions,
  defaultProviderOwnership,
  providerOwnershipFromRecord,
  providerOwnershipPayload,
  providerOwnershipReady,
} from './provider-ownership-view.js';

const byValue = (opts) => Object.fromEntries(opts.map(o => [o.value, o]));

test('options: api-key provider — personal always, team needs a team, global needs sysadmin', () => {
  const admin = byValue(providerOwnershipOptions({ isOauth: false, isSysAdmin: true, adminTeamIds: [] }));
  assert.equal(admin.personal.enabled, true);
  assert.equal(admin.team.enabled, true);
  assert.equal(admin.global.enabled, true);

  const teamAdmin = byValue(providerOwnershipOptions({ isOauth: false, isSysAdmin: false, adminTeamIds: ['t'] }));
  assert.equal(teamAdmin.team.enabled, true);
  assert.equal(teamAdmin.global.enabled, false);
  assert.match(teamAdmin.global.disabledReason, /System Admins only/);

  const plain = byValue(providerOwnershipOptions({ isOauth: false, isSysAdmin: false, adminTeamIds: [] }));
  assert.equal(plain.team.enabled, false);
  assert.match(plain.team.disabledReason, /administer no team/);
  assert.equal(plain.personal.enabled, true);
});

test('options: a subscription (oauth) can never be team; global only via the hatch', () => {
  const noHatch = byValue(providerOwnershipOptions({ isOauth: true, isSysAdmin: true, canGlobalOauth: false }));
  assert.equal(noHatch.team.enabled, false);
  assert.match(noHatch.team.disabledReason, /single seat/);
  assert.equal(noHatch.global.enabled, false);
  assert.match(noHatch.global.disabledReason, /single-user/);
  assert.equal(noHatch.personal.enabled, true);

  const hatch = byValue(providerOwnershipOptions({ isOauth: true, isSysAdmin: true, canGlobalOauth: true }));
  assert.equal(hatch.global.enabled, true, 'a confirmed single-user subscription may be global');
  assert.equal(hatch.team.enabled, false, 'still never team');
});

test('defaultProviderOwnership: oauth→personal; one admin team→that team; else team/blank', () => {
  assert.deepEqual(defaultProviderOwnership({ isOauth: true, isSysAdmin: true }), { scope: 'personal', teamId: '' });
  assert.deepEqual(defaultProviderOwnership({ isSysAdmin: false, adminTeamIds: ['payments'] }), { scope: 'team', teamId: 'payments' });
  assert.deepEqual(defaultProviderOwnership({ isSysAdmin: true, adminTeamIds: [] }), { scope: 'team', teamId: '' });
});

test('providerOwnershipFromRecord maps every stored shape', () => {
  assert.deepEqual(providerOwnershipFromRecord({ scope: 'system', global: true }), { scope: 'global', teamId: '' });
  assert.deepEqual(providerOwnershipFromRecord({ scope: 'personal', userId: 'u' }), { scope: 'personal', teamId: '' });
  assert.deepEqual(providerOwnershipFromRecord({ scope: 'team', teamId: 'payments' }), { scope: 'team', teamId: 'payments' });
  // legacy system + assignedTeamIds → first assigned team (migration off the removed axis)
  assert.deepEqual(providerOwnershipFromRecord({ scope: 'system', assignedTeamIds: ['a', 'b'] }), { scope: 'team', teamId: 'a' });
  // system, no teams, not global → global candidate
  assert.deepEqual(providerOwnershipFromRecord({ scope: 'system', assignedTeamIds: [] }), { scope: 'global', teamId: '' });
});

test('providerOwnershipPayload: global carries the flag + system; others clear it', () => {
  assert.deepEqual(providerOwnershipPayload({ scope: 'global' }), { scope: 'system', assignedTeamIds: [], global: true });
  assert.deepEqual(providerOwnershipPayload({ scope: 'team', teamId: 'payments' }), { scope: 'team', teamId: 'payments', global: false });
  assert.deepEqual(providerOwnershipPayload({ scope: 'personal' }), { scope: 'personal', global: false });
});

test('providerOwnershipReady: team needs a team; personal/global always ready', () => {
  assert.equal(providerOwnershipReady({ scope: 'personal' }), true);
  assert.equal(providerOwnershipReady({ scope: 'global' }), true);
  assert.equal(providerOwnershipReady({ scope: 'team', teamId: '' }), false);
  assert.equal(providerOwnershipReady({ scope: 'team', teamId: 'payments' }), true);
});
