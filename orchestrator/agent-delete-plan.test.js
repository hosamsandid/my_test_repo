'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { isGracefulDeleteRole, TeardownRegistry, cascadeChildIds } = require('./agent-delete-plan');

// #1962 removed the BriefingPack model. `bp-instance` was the only role that
// ever took the graceful commit window, so the predicate is now constantly
// false — including for the two retired role names, which a leftover config on
// an upgraded stack can still carry.
test('isGracefulDeleteRole: no role keeps the graceful commit window any more', () => {
  for (const role of ['agent', 'team-member', 'team', 'ephemeral', undefined, null, '']) {
    assert.strictEqual(isGracefulDeleteRole(role), false, `role ${JSON.stringify(role)} should not be graceful`);
  }
});

test('isGracefulDeleteRole: a leftover bp-instance/orchestrator config is force-removed too', () => {
  assert.strictEqual(isGracefulDeleteRole('bp-instance'), false);
  assert.strictEqual(isGracefulDeleteRole('orchestrator'), false);
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

/* ── cascadeChildIds (#1960) ─────────────────────────────────────────────── */

const team = (id, extra = {}) => ({ id, cfg: { role: 'team', ...extra } });
const member = (id, parentTeamId, extra = {}) => ({
  id,
  cfg: { role: 'team-member', ...(parentTeamId === undefined ? {} : { parentTeamId }), ...extra },
});

test('cascadeChildIds: deleting a team takes every member with it', () => {
  const configs = [
    team('alpha'),
    member('alpha-ba', 'alpha', { token: 't' }),
    member('alpha-dev', 'alpha', { token: 't' }),
    member('beta-dev', 'beta', { token: 't' }),
    { id: 'solo', cfg: { role: 'agent' } },
  ];
  assert.deepStrictEqual(
    cascadeChildIds('alpha', configs[0].cfg, configs),
    ['alpha-ba', 'alpha-dev'],
  );
});

test('cascadeChildIds: a STUB member cascades exactly like a materialized one', () => {
  // A #1955 stub is config + triggers.json only (no token, no Matrix user, no
  // container). Left behind it is an orphan that GET /api/matrix/agents filters
  // out by default — the invisible case this cascade exists for.
  const configs = [team('alpha'), member('alpha-mat', 'alpha', { token: 't' }), member('alpha-stub', 'alpha')];
  assert.deepStrictEqual(
    cascadeChildIds('alpha', configs[0].cfg, configs),
    ['alpha-mat', 'alpha-stub'],
  );
});

test('cascadeChildIds: a team with no members cascades nothing (AC6)', () => {
  const configs = [team('alpha'), { id: 'solo', cfg: { role: 'agent' } }];
  assert.deepStrictEqual(cascadeChildIds('alpha', configs[0].cfg, configs), []);
});

test('cascadeChildIds: a team whose members are ALL stubs still cascades them (AC6)', () => {
  const configs = [team('alpha'), member('alpha-a', 'alpha'), member('alpha-b', 'alpha')];
  assert.deepStrictEqual(cascadeChildIds('alpha', configs[0].cfg, configs), ['alpha-a', 'alpha-b']);
});

test('cascadeChildIds: an unreadable parent config cascades the same set (interrupted delete)', () => {
  // deleteAgentFiles can leave a config-less residue dir (#1525 B2). Re-issuing
  // the delete must finish the job rather than walk away from the members.
  const configs = [{ id: 'alpha', cfg: null }, member('alpha-dev', 'alpha'), member('beta-dev', 'beta')];
  assert.deepStrictEqual(cascadeChildIds('alpha', null, configs), ['alpha-dev']);
});

test('cascadeChildIds: a non-team parent never cascades siblings', () => {
  const configs = [
    { id: 'solo', cfg: { role: 'agent' } },
    member('typo-member', 'solo'), // hand-edited config — reported by the orphan scan, not deleted here
  ];
  for (const role of ['agent', 'team-member', 'orchestrator', 'bp-instance', 'ephemeral']) {
    assert.deepStrictEqual(cascadeChildIds('solo', { role }, configs), [], `role ${role}`);
  }
});

test('cascadeChildIds: never includes the parent itself, and tolerates junk entries', () => {
  const configs = [
    team('alpha'),
    member('alpha', 'alpha'), // pathological self-reference
    null,
    { id: null, cfg: { role: 'team-member', parentTeamId: 'alpha' } },
    { id: 'ghost', cfg: null },
    member('alpha-dev', 'alpha'),
  ];
  assert.deepStrictEqual(cascadeChildIds('alpha', { role: 'team' }, configs), ['alpha-dev']);
});

test('cascadeChildIds: deterministic order and a missing id/config list are safe', () => {
  const configs = [member('z', 'alpha'), member('a', 'alpha'), member('m', 'alpha')];
  assert.deepStrictEqual(cascadeChildIds('alpha', { role: 'team' }, configs), ['a', 'm', 'z']);
  assert.deepStrictEqual(cascadeChildIds('alpha', { role: 'team' }, null), []);
  assert.deepStrictEqual(cascadeChildIds('', { role: 'team' }, configs), []);
});
