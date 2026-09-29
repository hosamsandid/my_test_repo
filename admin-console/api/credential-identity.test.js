'use strict';

// Unit tests for the SSH/GitHub identity stamp resolver (#2360).
// Run: node --test admin-console/api/credential-identity.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveStampedIdentity } = require('./credential-identity');

test('no override: the derived default (personal→human, else service)', () => {
  assert.equal(resolveStampedIdentity({ scope: 'personal' }), 'human');
  assert.equal(resolveStampedIdentity({ scope: 'team' }), 'service');
});

test('a personal credential may be marked service (the #2360 case)', () => {
  assert.equal(resolveStampedIdentity({ scope: 'personal', requestedIdentity: 'service' }), 'service');
  // …and may stay human explicitly.
  assert.equal(resolveStampedIdentity({ scope: 'personal', requestedIdentity: 'human' }), 'human');
});

test('a human override on a shared tier is illegal → falls back to service', () => {
  // A human secret can never be team/system (§4) — the override is not honoured.
  assert.equal(resolveStampedIdentity({ scope: 'team', requestedIdentity: 'human' }), 'service');
  assert.equal(resolveStampedIdentity({ scope: 'system', requestedIdentity: 'human' }), 'service');
});

test('an absent/garbage override falls back to the derived default', () => {
  assert.equal(resolveStampedIdentity({ scope: 'personal' }), 'human');
  assert.equal(resolveStampedIdentity({ scope: 'personal', requestedIdentity: 'bogus' }), 'human');
  assert.equal(resolveStampedIdentity({ scope: 'team' }), 'service');
});
