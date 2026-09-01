'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { isGracefulDeleteRole, TeardownRegistry } = require('./agent-delete-plan');

test('isGracefulDeleteRole: only bp-instance keeps the graceful commit window', () => {
  assert.strictEqual(isGracefulDeleteRole('bp-instance'), true);
});

test('isGracefulDeleteRole: every non-BP role is force-removed', () => {
  for (const role of ['agent', 'team-member', 'team', 'orchestrator', 'ephemeral', undefined, null, '']) {
    assert.strictEqual(isGracefulDeleteRole(role), false, `role ${JSON.stringify(role)} should not be graceful`);
  }
});

test('TeardownRegistry: begin arms the guard, has() reports it, finish clears it', () => {
  const reg = new TeardownRegistry();
  assert.strictEqual(reg.has('a1'), false);
  reg.begin('a1');
  assert.strictEqual(reg.has('a1'), true);
  assert.strictEqual(reg.size, 1);
  reg.finish('a1');
  assert.strictEqual(reg.has('a1'), false);
  assert.strictEqual(reg.size, 0);
});

test('TeardownRegistry: tracks several ids independently (team cascade)', () => {
  const reg = new TeardownRegistry();
  reg.begin('team').begin('team-1').begin('team-2');
  assert.strictEqual(reg.size, 3);
  assert.ok(reg.has('team') && reg.has('team-1') && reg.has('team-2'));
  reg.finish('team-1');
  assert.strictEqual(reg.has('team-1'), false);
  assert.ok(reg.has('team') && reg.has('team-2'));
  assert.strictEqual(reg.size, 2);
});

test('TeardownRegistry: begin is idempotent (no duplicate ids)', () => {
  const reg = new TeardownRegistry();
  reg.begin('a1').begin('a1');
  assert.strictEqual(reg.size, 1);
});

test('TeardownRegistry: finish on an unknown or already-finished id is a no-op', () => {
  const reg = new TeardownRegistry();
  reg.finish('never-seen');
  assert.strictEqual(reg.size, 0);
  reg.begin('a1').finish('a1').finish('a1');
  assert.strictEqual(reg.has('a1'), false);
  assert.strictEqual(reg.size, 0);
});

test('TeardownRegistry: begin/finish return this for chaining', () => {
  const reg = new TeardownRegistry();
  assert.strictEqual(reg.begin('a1'), reg);
  assert.strictEqual(reg.finish('a1'), reg);
});
