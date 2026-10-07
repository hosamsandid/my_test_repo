'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { POLICY, REQUIRES_APPROVAL, authorizeWrite } = require('./broker-policy');

test('POLICY mirrors the manifest: comment + transition + update + attach + set-field + create + sprint + link + set-epic writes, team scope', () => {
  const manifest = require('../plugin.json');
  assert.deepEqual(POLICY, manifest.policy);
  assert.deepEqual(Object.keys(POLICY).sort(),
    ['attach', 'comment', 'create', 'link', 'set-epic', 'set-field', 'sprint-advance', 'sprint-bulk-create', 'sprint-close', 'sprint-create', 'sprint-start', 'transition', 'unlink', 'update']);
});

test('requiresApproval is wired but empty (D3 — no confirmation pen in v1)', () => {
  assert.deepEqual(REQUIRES_APPROVAL, []);
});

test('authorizeWrite: a team-scoped caller may run all three writes (D3 — routine + reversible)', () => {
  assert.deepEqual(authorizeWrite('comment'), { allow: true });
  assert.deepEqual(authorizeWrite('transition'), { allow: true });
  assert.deepEqual(authorizeWrite('update'), { allow: true });
  assert.deepEqual(authorizeWrite('attach'), { allow: true });
  assert.deepEqual(authorizeWrite('set-field'), { allow: true });
  assert.deepEqual(authorizeWrite('create'), { allow: true });
  assert.deepEqual(authorizeWrite('sprint-create'), { allow: true });
  assert.deepEqual(authorizeWrite('sprint-bulk-create'), { allow: true });
  assert.deepEqual(authorizeWrite('sprint-close'), { allow: true });
  assert.deepEqual(authorizeWrite('sprint-start'), { allow: true });
  assert.deepEqual(authorizeWrite('sprint-advance'), { allow: true });
  assert.deepEqual(authorizeWrite('link'), { allow: true });
  assert.deepEqual(authorizeWrite('unlink'), { allow: true });
  assert.deepEqual(authorizeWrite('set-epic'), { allow: true });
});

test('authorizeWrite: an unlisted subcommand is unrestricted (every rule is opt-in)', () => {
  assert.deepEqual(authorizeWrite('delete-everything'), { allow: true });
});
