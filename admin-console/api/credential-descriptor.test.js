const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCredentialDescriptor } = require('./credential-descriptor');

const userLabel = (id) => ({ 'u-1': 'Thorsten' }[id] || null);
const teamLabel = (id) => ({ 'default': 'Default Team' }[id] || null);

test('personal credential resolves the owner name', () => {
  const d = buildCredentialDescriptor({
    cred: { id: 'pat-thorsten', scope: 'personal', userId: 'u-1' },
    kind: 'github-token', visibleToCaller: false, userLabel, teamLabel,
  });
  assert.deepEqual(d, { id: 'pat-thorsten', kind: 'github-token', tier: 'personal', ownerLabel: 'Thorsten', visibleToCaller: false });
});

test('personal credential with an unresolvable owner degrades to a generic label', () => {
  const d = buildCredentialDescriptor({ cred: { id: 'k', scope: 'personal', userId: 'u-x' }, userLabel, teamLabel });
  assert.equal(d.ownerLabel, 'another user');
});

test('team credential resolves the team name', () => {
  const d = buildCredentialDescriptor({ cred: { id: 't', scope: 'team', teamId: 'default' }, kind: 'ssh-key', visibleToCaller: true, userLabel, teamLabel });
  assert.equal(d.tier, 'team');
  assert.equal(d.ownerLabel, 'Default Team');
  assert.equal(d.visibleToCaller, true);
});

test('a legacy credential with no scope is treated as team tier', () => {
  const d = buildCredentialDescriptor({ cred: { id: 't2', teamId: 'default' }, teamLabel });
  assert.equal(d.tier, 'team');
  assert.equal(d.ownerLabel, 'Default Team');
});

test('system credential → System owner, no lookup needed', () => {
  const d = buildCredentialDescriptor({ cred: { id: 's', scope: 'system' } });
  assert.equal(d.tier, 'system');
  assert.equal(d.ownerLabel, 'System');
});

test('a null/idless credential yields null (nothing to describe)', () => {
  assert.equal(buildCredentialDescriptor({ cred: null }), null);
  assert.equal(buildCredentialDescriptor({ cred: {} }), null);
});

test('resolvers are optional — a personal cred still degrades cleanly', () => {
  assert.equal(buildCredentialDescriptor({ cred: { id: 'k', scope: 'personal', userId: 'u-1' } }).ownerLabel, 'another user');
});
