'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { POLICY, REQUIRES_APPROVAL, authorizeWrite } = require('./broker-policy');

test('POLICY mirrors the manifest: comment + transition, team scope', () => {
  const manifest = require('../plugin.json');
  assert.deepEqual(POLICY, manifest.policy);
});

test('requiresApproval is wired but empty (D3 — no confirmation pen in v1)', () => {
  assert.deepEqual(REQUIRES_APPROVAL, []);
});

test('authorizeWrite: a team-scoped caller may run both writes (D3 — routine + reversible)', () => {
  assert.deepEqual(authorizeWrite('comment'), { allow: true });
  assert.deepEqual(authorizeWrite('transition'), { allow: true });
});

test('authorizeWrite: an unlisted subcommand is unrestricted (every rule is opt-in)', () => {
  assert.deepEqual(authorizeWrite('delete-everything'), { allow: true });
});
