'use strict';

// Unit tests for the masked governance projection (#2360, §6/§12.7).
// Run: node --test admin-console/api/personal-resource-view.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { maskPersonalResource, listPersonalResources } = require('./personal-resource-view');

test('maskPersonalResource NEVER leaks a secret (no token / privateKey / baseUrl)', () => {
  const m = maskPersonalResource('provider', {
    id: 'p', name: 'My gateway', scope: 'personal', userId: 'u-a', identity: 'service',
    authType: 'api-key', authTokenId: 'p-xyz', baseUrl: 'https://secret/v1', token: 'sk-leak',
    createdAt: '2026-01-01',
  });
  assert.deepEqual(m, {
    id: 'p', kind: 'provider', name: 'My gateway', ownerId: 'u-a',
    createdAt: '2026-01-01', identity: 'service', authType: 'api-key',
  });
  assert.ok(!('token' in m) && !('authTokenId' in m) && !('baseUrl' in m), 'no secret-bearing field');
});

test('maskPersonalResource carries the SSH fingerprint (public) but not the key', () => {
  const m = maskPersonalResource('ssh-key', {
    id: 'k', name: 'laptop', scope: 'personal', userId: 'u-a', identity: 'human',
    fingerprint: 'SHA256:abc', privateKey: '-----BEGIN', createdAt: '2026-02-02',
  });
  assert.equal(m.fingerprint, 'SHA256:abc');
  assert.ok(!('privateKey' in m));
  assert.equal(m.identity, 'human');
});

test('listPersonalResources returns ONLY personal records, across all three stores', () => {
  const out = listPersonalResources({
    providers: [
      { id: 'p1', scope: 'personal', userId: 'u-a', authType: 'oauth-token' },
      { id: 'p2', scope: 'team', teamId: 't' },       // not personal → omitted
    ],
    sshKeys: [{ id: 'k1', scope: 'personal', userId: 'u-b', fingerprint: 'f' }],
    githubTokens: [
      { id: 'g1', scope: 'personal', userId: 'u-a' },
      { id: 'g2', scope: 'system', global: true },     // not personal → omitted
    ],
  });
  assert.deepEqual(out.map(r => r.id).sort(), ['g1', 'k1', 'p1']);
  assert.deepEqual(out.map(r => r.kind).sort(), ['github-token', 'provider', 'ssh-key']);
  assert.equal(out.find(r => r.id === 'p1').authType, 'oauth-token');
});

test('listPersonalResources is empty when there are no personal records', () => {
  assert.deepEqual(listPersonalResources({ providers: [{ id: 'p', scope: 'team', teamId: 't' }] }), []);
  assert.deepEqual(listPersonalResources({}), []);
});
