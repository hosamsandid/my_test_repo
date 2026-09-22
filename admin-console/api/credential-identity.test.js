'use strict';

// Unit tests for the SSH/GitHub identity stamp resolver (#2360).
// Run: node --test admin-console/api/credential-identity.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveStampedIdentity } = require('./credential-identity');

test('flag OFF: always the derived default (personal→human, else service)', () => {
  assert.equal(resolveStampedIdentity({ scope: 'personal', requestedIdentity: 'service', v2: false }), 'human',
    'an override is ignored when the flag is off');
  assert.equal(resolveStampedIdentity({ scope: 'team', requestedIdentity: 'human', v2: false }), 'service');
  assert.equal(resolveStampedIdentity({ scope: 'personal' }), 'human');
});

test('flag ON: a personal credential may be marked service (the #2360 case)', () => {
  assert.equal(resolveStampedIdentity({ scope: 'personal', requestedIdentity: 'service', v2: true }), 'service');
  // …and may stay human explicitly.
  assert.equal(resolveStampedIdentity({ scope: 'personal', requestedIdentity: 'human', v2: true }), 'human');
});

test('flag ON: a human override on a shared tier is illegal → falls back to service', () => {
  // A human secret can never be team/system (§4) — the override is not honoured.
  assert.equal(resolveStampedIdentity({ scope: 'team', requestedIdentity: 'human', v2: true }), 'service');
  assert.equal(resolveStampedIdentity({ scope: 'system', requestedIdentity: 'human', v2: true }), 'service');
});

test('flag ON: an absent/garbage override falls back to the derived default', () => {
  assert.equal(resolveStampedIdentity({ scope: 'personal', v2: true }), 'human');
  assert.equal(resolveStampedIdentity({ scope: 'personal', requestedIdentity: 'bogus', v2: true }), 'human');
  assert.equal(resolveStampedIdentity({ scope: 'team', v2: true }), 'service');
});
