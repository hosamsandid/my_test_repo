'use strict';

// #2959: which SSH key SIGNS commits, as the SSH Keys page shows it.
// Run: node --test admin-console/api/ssh-signing-usage.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { markSigningUsage, sharedSigningFor } = require('./ssh-signing-usage');
// The runtime decision this module mirrors (two-sided parity, see below).
const commitSigning = require(path.join(__dirname, '..', '..', 'orchestrator', 'commit-signing.js'));

const sig = (email, name = 'Signer') => ({ name, email });

const INDEX = [
  { id: 'ui-tester', name: 'ui-tester', scope: 'personal', userId: 'u1' },
  { id: 'sign-a', name: 'uitest-sign-a', scope: 'personal', userId: 'u1', signing: sig('a@example.com', 'uitest bot') },
  { id: 'sign-b', name: 'second', scope: 'personal', userId: 'u1', signing: sig('b@example.com') },
  { id: 'bob-sign', scope: 'personal', userId: 'u2', signing: sig('bob@example.com') },
  { id: 'deploy', name: 'Deploy', scope: 'team', teamId: 't1' },
  { id: 'team-sign', name: 'Team bot', scope: 'team', teamId: 't1', identity: 'service', signing: sig('bot@example.com') },
  { id: 'team-sign-2', name: 'Team bot 2', scope: 'team', teamId: 't1', identity: 'service', signing: sig('bot2@example.com') },
  { id: 'global-sign', scope: 'system', global: true, identity: 'service', signing: sig('svc@example.com') },
];
const ENVS = [
  { id: 'env-1', name: 'Env one', teamId: 't1', repositories: [{ sshKeyId: 'deploy' }] },
  { id: 'env-2', name: 'Env two', teamId: 't2', repositories: [] },
];
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

test('transport key ≠ signing key: the first personal key WITH a signing identity signs', () => {
  const rows = byId(markSigningUsage(INDEX, INDEX, ENVS));
  assert.equal(rows['ui-tester'].signingUsage, undefined); // no signing identity → untouched
  assert.deepEqual(rows['sign-a'].signingUsage, { tier: 'personal', active: true, signsFirstId: 'sign-a', nextId: 'sign-b' });
  assert.deepEqual(rows['sign-b'].signingUsage, { tier: 'personal', active: false, signsFirstId: 'sign-a', nextId: null });
  assert.equal(rows['bob-sign'].signingUsage.active, true); // per owner
});

test('transport key = signing key; no signing key at all', () => {
  const same = [{ id: 'k', scope: 'personal', userId: 'u1', signing: sig('k@example.com') }];
  assert.deepEqual(markSigningUsage(same, same, [])[0].signingUsage, { tier: 'personal', active: true, signsFirstId: 'k', nextId: null });
  const none = [{ id: 'k', scope: 'personal', userId: 'u1' }];
  assert.deepEqual(markSigningUsage(none, none, []), none);
  // A malformed identity never signs (same rule as the runtime).
  const bad = [{ id: 'k', scope: 'personal', userId: 'u1', signing: { name: 'A', email: 'nope' } }];
  assert.equal(markSigningUsage(bad, bad, [])[0].signingUsage, undefined);
});

test('team/system keys: the environments they sign for and what each falls back to (AC3/AC4)', () => {
  const rows = byId(markSigningUsage(INDEX, INDEX, ENVS));
  assert.deepEqual(rows['team-sign'].signingUsage, {
    tier: 'shared',
    environments: [{ id: 'env-1', name: 'Env one', source: 'team', fallback: { source: 'team', keyId: 'team-sign-2', name: 'Team bot 2' } }],
  });
  assert.deepEqual(rows['team-sign-2'].signingUsage, { tier: 'shared', environments: [] });
  assert.deepEqual(rows['global-sign'].signingUsage, {
    tier: 'shared',
    environments: [{ id: 'env-2', name: 'Env two', source: 'global', fallback: { source: 'none', keyId: null, name: null } }],
  });
  // Only the environments passed in (the caller's visible ones) are named.
  assert.deepEqual(byId(markSigningUsage(INDEX, INDEX, []))['team-sign'].signingUsage.environments, []);
});

test('a filtered row list is still marked against the full index', () => {
  const rows = markSigningUsage([INDEX[2]], INDEX, ENVS);
  assert.equal(rows[0].signingUsage.active, false);
  assert.equal(rows[0].signingUsage.signsFirstId, 'sign-a');
});

test('parity: the console marks exactly the key orchestrator/commit-signing.js resolves', () => {
  const extra = [
    { id: 'repo-bound', scope: 'system', assignedTeamIds: ['t3'], signing: sig('r@example.com') },
    { id: 'assigned', scope: 'system', assignedTeamIds: ['t4'], signing: sig('s@example.com') },
    { id: 'not-service-global', scope: 'system', global: true, signing: sig('g@example.com') },
  ];
  const index = [...INDEX, ...extra];
  const envs = [...ENVS,
    { id: 'env-3', teamId: 't3', repositories: [{ sshKeyId: 'repo-bound' }] },
    { id: 'env-4', teamId: 't4' },
    { id: 'env-5', teamId: 't1', repositories: [{ sshKeyId: 'sign-a' }] },
  ];
  const marked = markSigningUsage(index, index, envs);
  for (const owner of ['u1', 'u2', 'nobody']) {
    for (const env of envs) {
      const runtime = commitSigning.resolveSigningKey({ index, ownerId: owner, env });
      if (runtime.source === 'personal') {
        const row = marked.find((r) => r.id === runtime.keyId);
        assert.equal(row.signingUsage.active, true, `${owner}/${env.id}`);
        assert.equal(marked.filter((r) => r.signingUsage?.tier === 'personal' && r.signingUsage.active && r.userId === owner).length, 1);
      } else {
        const mirror = sharedSigningFor(index, env);
        assert.deepEqual({ source: mirror.source, keyId: mirror.keyId }, { source: runtime.source, keyId: runtime.keyId }, `${owner}/${env.id}`);
        if (runtime.keyId) {
          const row = marked.find((r) => r.id === runtime.keyId);
          assert.ok(row.signingUsage.environments.some((e) => e.id === env.id), `${runtime.keyId} signs ${env.id}`);
        }
      }
    }
  }
});
