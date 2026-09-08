'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { visibleScopes, assertCanWriteScope, fieldType, shapePutBody } = require('./plugin-credential-view');

test('visibleScopes: keeps only scopes whose team the caller can see', () => {
  const scopes = [{ scopeId: 'team-a' }, { scopeId: 'team-b' }, { scopeId: 'team-c' }];
  const seen = new Set(['team-a', 'team-c']);
  assert.deepEqual(visibleScopes(scopes, (t) => seen.has(t)).map((s) => s.scopeId), ['team-a', 'team-c']);
});

test('assertCanWriteScope: Team Admin of that team only', () => {
  assert.deepEqual(assertCanWriteScope('team-a', (t) => t === 'team-a'), { ok: true });
  const denied = assertCanWriteScope('team-b', (t) => t === 'team-a');
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(assertCanWriteScope(null, () => true).status, 400);
});

test('fieldType: secret-shaped keys → password, others → text', () => {
  assert.equal(fieldType('api-token'), 'password');
  assert.equal(fieldType('client-secret'), 'password');
  assert.equal(fieldType('site-url'), 'text');
  assert.equal(fieldType('email'), 'text');
});

test('shapePutBody: only declared string keys survive', () => {
  const r = shapePutBody({ values: { 'site-url': 'acme', junk: 'x', email: 5, 'api-token': 'tok' } }, ['site-url', 'email', 'api-token']);
  assert.deepEqual(r.values, { 'site-url': 'acme', 'api-token': 'tok' });
});
