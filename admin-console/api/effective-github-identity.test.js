const test = require('node:test');
const assert = require('node:assert/strict');

const { presentBaselineCredential, presentSigning, presentEffectiveIdentity } = require('./effective-github-identity');

const users = { alice: 'Alice Admin', bob: 'Bob Member' };
const names = { 'alice-pat': 'Alice PAT', 'team-pat': 'Team PAT', 'sys-pat': 'System PAT' };
const opts = (callerUserId) => ({
  kind: 'github',
  callerUserId,
  userLabel: (id) => users[id] || null,
  credentialName: (id) => names[id] || null,
});

const personal = {
  source: 'personal', credentialId: 'alice-pat', ownerId: 'alice',
  personalPresent: true, personalOrphaned: false, sharedCredentialId: 'team-pat', globalServiceCredentialId: null,
};

test('#2560 AC1/AC2: personal source names the Team Admin and marks the team credential overridden', () => {
  const out = presentBaselineCredential(personal, opts('bob'));
  assert.equal(out.source, 'personal');
  assert.deepEqual(out.owner, { label: 'Alice Admin', isYou: false });
  assert.deepEqual(out.teamCredential, { id: 'team-pat', name: 'Team PAT', inUse: false, overridden: true });
  assert.equal(out.problem, null);
});

test('#2560 AC3: another person\'s personal credential exposes neither id nor name', () => {
  const out = presentBaselineCredential(personal, opts('bob'));
  assert.equal(out.credential, null);
  assert.doesNotMatch(JSON.stringify(out), /alice-pat|Alice PAT/);
});

test('#2560 AC3: the owner sees their own personal credential', () => {
  const out = presentBaselineCredential(personal, opts('alice'));
  assert.deepEqual(out.credential, { id: 'alice-pat', name: 'Alice PAT' });
  assert.equal(out.owner.isYou, true);
});

test('#2560 team source: team credential in use, no owner named', () => {
  const out = presentBaselineCredential(
    { ...personal, source: 'team', credentialId: 'team-pat', personalPresent: false },
    opts('bob'),
  );
  assert.equal(out.owner, null);
  assert.deepEqual(out.credential, { id: 'team-pat', name: 'Team PAT' });
  assert.deepEqual(out.teamCredential, { id: 'team-pat', name: 'Team PAT', inUse: true, overridden: false });
});

test('#2560 global source is reported as a tier only', () => {
  const out = presentBaselineCredential(
    { source: 'global', credentialId: 'sys-pat', ownerId: 'alice', sharedCredentialId: null, globalServiceCredentialId: 'sys-pat' },
    opts('bob'),
  );
  assert.equal(out.source, 'global');
  assert.equal(out.credential, null);
  assert.equal(out.teamCredential, null);
  assert.doesNotMatch(JSON.stringify(out), /sys-pat/);
});

test('#2560 nothing at any tier → none', () => {
  const out = presentBaselineCredential({ source: 'none', credentialId: null, ownerId: 'alice' }, opts('bob'));
  assert.equal(out.source, 'none');
  assert.equal(out.owner, null);
  assert.equal(out.teamCredential, null);
});

test('#2560 orphaned personal credential is a problem state naming a deleted owner', () => {
  const out = presentBaselineCredential(
    { source: 'team', credentialId: 'team-pat', ownerId: 'gone', personalPresent: true, personalOrphaned: true, sharedCredentialId: 'team-pat' },
    opts('bob'),
  );
  assert.equal(out.problem, 'orphaned');
  assert.equal(out.source, 'team');
  assert.deepEqual(out.owner, { label: 'a deleted user', isYou: false });
});

test('#2560 malformed input degrades to none', () => {
  const out = presentBaselineCredential(null, opts('bob'));
  assert.equal(out.source, 'none');
  assert.equal(out.owner, null);
});

test('#2560 presentEffectiveIdentity presents both kinds with their own name lookups', () => {
  const out = presentEffectiveIdentity(
    {
      github: personal,
      ssh: { source: 'team', credentialId: 'deploy-key', ownerId: 'alice', sharedCredentialId: 'deploy-key' },
    },
    { callerUserId: 'bob', userLabel: (id) => users[id], githubName: (id) => names[id], sshName: (id) => (id === 'deploy-key' ? 'Deploy key' : null) },
  );
  assert.equal(out.github.kindLabel, 'GitHub token');
  assert.equal(out.ssh.kindLabel, 'SSH key');
  assert.equal(out.ssh.credential.name, 'Deploy key');
  assert.equal(out.github.source, 'personal');
});

test('#2938 signing: another person\'s personal signing key shows only its owner', () => {
  const d = { source: 'personal', keyId: 'alice-sign', ownerId: 'alice', name: 'Alice sign', identity: { name: 'Alice', email: 'alice@corp.com' } };
  const other = presentSigning(d, { callerUserId: 'bob', userLabel: (id) => users[id] });
  assert.deepEqual(other.owner, { label: 'Alice Admin', isYou: false });
  assert.equal(other.credential, null);
  assert.equal(other.identity, null);
  const own = presentSigning(d, { callerUserId: 'alice', userLabel: (id) => users[id] });
  assert.equal(own.credential.id, 'alice-sign');
  assert.equal(own.identity.email, 'alice@corp.com');
});

test('#2938 signing: team key keeps id and identity; global is a tier; none / malformed degrade to none', () => {
  const team = presentSigning({ source: 'team', keyId: 'bot-sign', identity: { name: 'Bot', email: 'bot@corp.com' } },
    { credentialName: (id) => (id === 'bot-sign' ? 'Bot signing' : null) });
  assert.deepEqual(team.credential, { id: 'bot-sign', name: 'Bot signing' });
  assert.equal(team.identity.email, 'bot@corp.com');
  const global = presentSigning({ source: 'global', keyId: 'sys', identity: { name: 'S', email: 's@corp.com' } });
  assert.equal(global.credential, null);
  assert.equal(global.identity.email, 's@corp.com');
  assert.equal(presentSigning({ source: 'none' }).source, 'none');
  assert.equal(presentSigning({ source: 'team' }).source, 'none');
  assert.equal(presentSigning(null).source, 'none');
  assert.equal(presentEffectiveIdentity({}).signing.source, 'none');
});

test('#2959 signing: a personal resolution carries what signs without it (team key named, global a tier)', () => {
  const base = { source: 'personal', keyId: 'alice-sign', ownerId: 'alice', identity: { name: 'Alice', email: 'alice@corp.com' } };
  const nameOf = (id) => (id === 'bot-sign' ? 'Bot signing' : null);
  const team = presentSigning({ ...base, fallback: { source: 'team', keyId: 'bot-sign' } }, { callerUserId: 'alice', credentialName: nameOf });
  assert.deepEqual(team.fallback, { source: 'team', credential: { id: 'bot-sign', name: 'Bot signing' } });
  const global = presentSigning({ ...base, fallback: { source: 'global', keyId: 'sys' } }, { callerUserId: 'alice' });
  assert.deepEqual(global.fallback, { source: 'global', credential: null });
  const none = presentSigning({ ...base, fallback: { source: 'none', keyId: null } }, { callerUserId: 'alice' });
  assert.deepEqual(none.fallback, { source: 'none', credential: null });
  // Older orchestrator (no fallback) and non-personal sources carry none.
  assert.equal('fallback' in presentSigning(base, { callerUserId: 'alice' }), false);
  assert.equal('fallback' in presentSigning({ source: 'team', keyId: 'bot-sign', fallback: { source: 'global', keyId: 'x' } }), false);
});
