'use strict';

// Unit tests for the pure tier-transfer engine (skill-transfer.js, #626).
// Covers the transition matrix, collision modes, permission rules, plan
// derivation (activate default, move retire-source), and the small helpers.
// Dependency-free: run with `node --test admin-console/api/skill-transfer.test.js`.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const T = require('./skill-transfer.js');

// A caller-capabilities helper for permitTransfer.
function caps({ systemAdmin = false, teams = [] } = {}) {
  return { systemAdmin, isTeamAdmin: (id) => teams.includes(id) };
}

/* ─── transferAction / the transition matrix ─────────────────────────────── */

test('transferAction: the four valid copy cells carry their semantic verb', () => {
  assert.equal(T.transferAction('agent', 'team', 'copy'), 'lifted');
  assert.equal(T.transferAction('team', 'team', 'copy'), 'shared');
  assert.equal(T.transferAction('team', 'global', 'copy'), 'promoted');
  assert.equal(T.transferAction('global', 'team', 'copy'), 'adopted');
});

test('transferAction: a move is always stamped "moved" regardless of cell', () => {
  assert.equal(T.transferAction('agent', 'team', 'move'), 'moved');
  assert.equal(T.transferAction('team', 'global', 'move'), 'moved');
  assert.equal(T.transferAction('global', 'team', 'move'), 'moved');
});

test('transferAction: retired / non-transfer cells are null', () => {
  assert.equal(T.transferAction('agent', 'global', 'copy'), null); // retired, go via team
  assert.equal(T.transferAction('global', 'global', 'copy'), null); // edit, not transfer
  assert.equal(T.transferAction('agent', 'agent', 'copy'), null); // author, not transfer
  assert.equal(T.transferAction('team', 'agent', 'copy'), null); // activation, separate path
  assert.equal(T.transferAction('global', 'agent', 'copy'), null); // seed, separate path
});

/* ─── planTransfer: name + ref validation ────────────────────────────────── */

test('planTransfer: rejects an invalid / missing skill name', () => {
  assert.equal(T.planTransfer({ name: '', from: { tier: 'team', teamId: 'a' }, to: { tier: 'global' } }).ok, false);
  assert.equal(T.planTransfer({ name: 'bad name!', from: { tier: 'team', teamId: 'a' }, to: { tier: 'global' } }).ok, false);
  assert.equal(T.planTransfer({ from: { tier: 'team', teamId: 'a' }, to: { tier: 'global' } }).ok, false);
});

test('planTransfer: accepts dotted/colon skill names', () => {
  const p = T.planTransfer({ name: 'cobol.analyze:v2', from: { tier: 'global' }, to: { tier: 'team', teamId: 'alpha' } });
  assert.equal(p.ok, true);
  assert.equal(p.name, 'cobol.analyze:v2');
});

test('planTransfer: from-team requires a valid teamId', () => {
  const p = T.planTransfer({ name: 'x', from: { tier: 'team' }, to: { tier: 'global' } });
  assert.equal(p.ok, false);
  assert.match(p.error, /^from:/);
});

test('planTransfer: from-agent requires a valid agentId', () => {
  const p = T.planTransfer({ name: 'x', from: { tier: 'agent' }, to: { tier: 'team', teamId: 'alpha' } });
  assert.equal(p.ok, false);
  assert.match(p.error, /^from:/);
});

test('planTransfer: to.tier must be team or global (agent target rejected)', () => {
  const p = T.planTransfer({ name: 'x', from: { tier: 'global' }, to: { tier: 'agent', agentId: 'a' } });
  assert.equal(p.ok, false);
  assert.match(p.error, /to\.tier must be team or global/);
});

/* ─── planTransfer: mode / collision / cell validation ───────────────────── */

test('planTransfer: mode defaults to copy and validates the enum', () => {
  const def = T.planTransfer({ name: 'x', from: { tier: 'global' }, to: { tier: 'team', teamId: 'a' } });
  assert.equal(def.mode, 'copy');
  const bad = T.planTransfer({ name: 'x', mode: 'teleport', from: { tier: 'global' }, to: { tier: 'team', teamId: 'a' } });
  assert.equal(bad.ok, false);
});

test('planTransfer: onCollision defaults to reject and validates the enum', () => {
  const def = T.planTransfer({ name: 'x', from: { tier: 'global' }, to: { tier: 'team', teamId: 'a' } });
  assert.equal(def.onCollision, 'reject');
  for (const c of ['reject', 'overwrite', 'rename']) {
    assert.equal(T.planTransfer({ name: 'x', onCollision: c, from: { tier: 'global' }, to: { tier: 'team', teamId: 'a' } }).onCollision, c);
  }
  assert.equal(T.planTransfer({ name: 'x', onCollision: 'nope', from: { tier: 'global' }, to: { tier: 'team', teamId: 'a' } }).ok, false);
});

test('planTransfer: an invalid tier transition is rejected as such', () => {
  const p = T.planTransfer({ name: 'x', from: { tier: 'agent', agentId: 'a' }, to: { tier: 'global' } });
  assert.equal(p.ok, false);
  assert.match(p.error, /not a valid tier transition/);
});

test('planTransfer: team→team to the SAME team is a no-op error', () => {
  const p = T.planTransfer({ name: 'x', from: { tier: 'team', teamId: 'alpha' }, to: { tier: 'team', teamId: 'alpha' } });
  assert.equal(p.ok, false);
  assert.match(p.error, /same/);
});

test('planTransfer: team→team to a DIFFERENT team is a valid share', () => {
  const p = T.planTransfer({ name: 'x', from: { tier: 'team', teamId: 'alpha' }, to: { tier: 'team', teamId: 'beta' } });
  assert.equal(p.ok, true);
  assert.equal(p.action, 'shared');
  assert.equal(p.semanticAction, 'shared');
});

/* ─── planTransfer: activate default ─────────────────────────────────────── */

test('planTransfer: activate defaults true for a team target', () => {
  const p = T.planTransfer({ name: 'x', from: { tier: 'global' }, to: { tier: 'team', teamId: 'alpha' } });
  assert.equal(p.activate, true);
});

test('planTransfer: activate is forced false for a global target', () => {
  const p = T.planTransfer({ name: 'x', from: { tier: 'team', teamId: 'alpha' }, to: { tier: 'global' } });
  assert.equal(p.activate, false);
  const forced = T.planTransfer({ name: 'x', activate: true, from: { tier: 'team', teamId: 'alpha' }, to: { tier: 'global' } });
  assert.equal(forced.activate, false);
});

test('planTransfer: activate can be opted out for a team target', () => {
  const p = T.planTransfer({ name: 'x', activate: false, from: { tier: 'global' }, to: { tier: 'team', teamId: 'alpha' } });
  assert.equal(p.activate, false);
});

/* ─── planTransfer: full plan shape + move retire ────────────────────────── */

test('planTransfer: a copy does not retire the source', () => {
  const p = T.planTransfer({ name: 'x', from: { tier: 'global' }, to: { tier: 'team', teamId: 'alpha' } });
  assert.equal(p.retireSource, false);
  assert.equal(p.action, 'adopted');
});

test('planTransfer: a move retires the source and stamps "moved" while keeping the semantic verb', () => {
  const p = T.planTransfer({ name: 'x', mode: 'move', from: { tier: 'team', teamId: 'alpha' }, to: { tier: 'global' } });
  assert.equal(p.retireSource, true);
  assert.equal(p.action, 'moved');
  assert.equal(p.semanticAction, 'promoted');
});

/* ─── requiredPermission ─────────────────────────────────────────────────── */

test('requiredPermission: team target needs Team Admin of the target team', () => {
  const perm = T.requiredPermission({ tier: 'global' }, { tier: 'team', teamId: 'alpha' }, 'copy');
  assert.equal(perm.needsSystemAdmin, false);
  assert.deepEqual(perm.teamAdminOf, ['alpha']);
});

test('requiredPermission: a global target needs System Admin OR Team Admin of the source team (#2178)', () => {
  const perm = T.requiredPermission({ tier: 'team', teamId: 'alpha' }, { tier: 'global' }, 'copy');
  assert.equal(perm.needsSystemAdmin, false);
  assert.deepEqual(perm.teamAdminOf, []);
  assert.deepEqual(perm.orTeamAdminOf, ['alpha']);
});

test('requiredPermission: move out of global needs System Admin for the source too', () => {
  const perm = T.requiredPermission({ tier: 'global' }, { tier: 'team', teamId: 'alpha' }, 'move');
  assert.equal(perm.needsSystemAdmin, true); // retiring a global source is governance-level
  assert.deepEqual(perm.teamAdminOf, ['alpha']);
});

test('requiredPermission: move from a team needs Team Admin of both teams', () => {
  const perm = T.requiredPermission({ tier: 'team', teamId: 'alpha' }, { tier: 'team', teamId: 'beta' }, 'move');
  assert.equal(perm.needsSystemAdmin, false);
  assert.deepEqual([...perm.teamAdminOf].sort(), ['alpha', 'beta']);
});

test('requiredPermission: move from an agent needs System Admin', () => {
  const perm = T.requiredPermission({ tier: 'agent', agentId: 'a' }, { tier: 'team', teamId: 'alpha' }, 'move');
  assert.equal(perm.needsSystemAdmin, true);
  assert.deepEqual(perm.teamAdminOf, ['alpha']);
});

/* ─── permitTransfer ─────────────────────────────────────────────────────── */

test('permitTransfer: System Admin satisfies every requirement', () => {
  const perm = T.requiredPermission({ tier: 'global' }, { tier: 'team', teamId: 'alpha' }, 'move');
  assert.equal(T.permitTransfer(perm, caps({ systemAdmin: true })).ok, true);
});

test('permitTransfer: Team Admin of the target team passes a plain team adopt', () => {
  const perm = T.requiredPermission({ tier: 'global' }, { tier: 'team', teamId: 'alpha' }, 'copy');
  assert.equal(T.permitTransfer(perm, caps({ teams: ['alpha'] })).ok, true);
});

test('permitTransfer: Team Admin of the SOURCE team may promote it to global (#2178)', () => {
  const perm = T.requiredPermission({ tier: 'team', teamId: 'alpha' }, { tier: 'global' }, 'copy');
  assert.equal(T.permitTransfer(perm, caps({ teams: ['alpha'] })).ok, true);
});

test('permitTransfer: Team Admin of an UNRELATED team cannot promote another team\'s skill to global', () => {
  const perm = T.requiredPermission({ tier: 'team', teamId: 'alpha' }, { tier: 'global' }, 'copy');
  const r = T.permitTransfer(perm, caps({ teams: ['beta'] }));
  assert.equal(r.ok, false);
  assert.match(r.error, /System Admin or Team Admin of 'alpha'/);
});

test('permitTransfer: a non-admin with no team rights is forbidden from a global target', () => {
  const perm = T.requiredPermission({ tier: 'team', teamId: 'alpha' }, { tier: 'global' }, 'copy');
  const r = T.permitTransfer(perm, caps({}));
  assert.equal(r.ok, false);
  assert.match(r.error, /System Admin/);
});

test('permitTransfer: System Admin still satisfies a global-target promotion with no team rights', () => {
  const perm = T.requiredPermission({ tier: 'team', teamId: 'alpha' }, { tier: 'global' }, 'copy');
  assert.equal(T.permitTransfer(perm, caps({ systemAdmin: true })).ok, true);
});

test('permitTransfer: moving a team skill to global (retiring the source) is System Admin OR Team Admin of that team', () => {
  const perm = T.requiredPermission({ tier: 'team', teamId: 'alpha' }, { tier: 'global' }, 'move');
  assert.equal(T.permitTransfer(perm, caps({ teams: ['alpha'] })).ok, true);
  const r = T.permitTransfer(perm, caps({ teams: ['beta'] }));
  assert.equal(r.ok, false);
});

test('permitTransfer: Team Admin of only one side cannot move team→team', () => {
  const perm = T.requiredPermission({ tier: 'team', teamId: 'alpha' }, { tier: 'team', teamId: 'beta' }, 'move');
  const r = T.permitTransfer(perm, caps({ teams: ['alpha'] }));
  assert.equal(r.ok, false);
  assert.match(r.error, /Team Admin of 'beta'/);
});

test('permitTransfer: Team Admin of both sides can move team→team', () => {
  const perm = T.requiredPermission({ tier: 'team', teamId: 'alpha' }, { tier: 'team', teamId: 'beta' }, 'move');
  assert.equal(T.permitTransfer(perm, caps({ teams: ['alpha', 'beta'] })).ok, true);
});

/* ─── the end-to-end plan carries a correct permission block ─────────────── */

test('planTransfer: the plan embeds the required permission', () => {
  const p = T.planTransfer({ name: 'x', mode: 'move', from: { tier: 'team', teamId: 'alpha' }, to: { tier: 'global' } });
  assert.equal(p.ok, true);
  assert.equal(p.permission.needsSystemAdmin, false);
  assert.deepEqual(p.permission.teamAdminOf, ['alpha']);
  assert.deepEqual(p.permission.orTeamAdminOf, ['alpha']);
});

/* ─── buildTransferOrigin ────────────────────────────────────────────────── */

test('buildTransferOrigin: records the source tier + id, dropping absent fields', () => {
  assert.deepEqual(T.buildTransferOrigin({ tier: 'global' }), { tier: 'global' });
  assert.deepEqual(T.buildTransferOrigin({ tier: 'team', teamId: 'alpha' }), { tier: 'team', teamId: 'alpha' });
  assert.deepEqual(T.buildTransferOrigin({ tier: 'agent', agentId: 'a.b' }), { tier: 'agent', agentId: 'a.b' });
});

test('buildTransferOrigin: carries sourceVersion / sourceHash when supplied', () => {
  const o = T.buildTransferOrigin({ tier: 'team', teamId: 'alpha' }, { sourceVersion: 3, sourceHash: 'abc123' });
  assert.deepEqual(o, { tier: 'team', teamId: 'alpha', sourceVersion: 3, sourceHash: 'abc123' });
});

test('buildTransferOrigin: omits null/undefined version + hash', () => {
  const o = T.buildTransferOrigin({ tier: 'global' }, { sourceVersion: null, sourceHash: undefined });
  assert.deepEqual(o, { tier: 'global' });
});

/* ─── resolveCollisionName ───────────────────────────────────────────────── */

test('resolveCollisionName: returns the base name when free', () => {
  assert.equal(T.resolveCollisionName('foo', () => false), 'foo');
});

test('resolveCollisionName: appends -2, -3, … until free', () => {
  const taken = new Set(['foo', 'foo-2', 'foo-3']);
  assert.equal(T.resolveCollisionName('foo', (n) => taken.has(n)), 'foo-4');
});

test('resolveCollisionName: with no existsFn returns the base name', () => {
  assert.equal(T.resolveCollisionName('foo'), 'foo');
});

test('resolveCollisionName: falls back to a timestamped name after exhausting the range', () => {
  const name = T.resolveCollisionName('foo', () => true); // everything taken
  assert.match(name, /^foo-\d{10,}$/);
});

/* ─── planSkillWrite (#639 shared file-write core) ───────────────────────── */

test('planSkillWrite: a free destination proceeds without overwrite', () => {
  assert.deepEqual(T.planSkillWrite({ onCollision: 'reject', exists: false }), { ok: true, overwrite: false });
  assert.deepEqual(T.planSkillWrite({ onCollision: 'overwrite', exists: false }), { ok: true, overwrite: false });
});

test('planSkillWrite: an occupied destination in reject mode conflicts (caller 409s)', () => {
  assert.deepEqual(T.planSkillWrite({ onCollision: 'reject', exists: true }), { ok: false, conflict: true });
});

test('planSkillWrite: an occupied destination in overwrite mode proceeds with overwrite', () => {
  assert.deepEqual(T.planSkillWrite({ onCollision: 'overwrite', exists: true }), { ok: true, overwrite: true });
});

test('planSkillWrite: allowExisting (extend) always writes in place, never a conflict', () => {
  assert.deepEqual(T.planSkillWrite({ allowExisting: true, exists: true }), { ok: true, overwrite: false });
  assert.deepEqual(T.planSkillWrite({ allowExisting: true, exists: true, onCollision: 'reject' }), { ok: true, overwrite: false });
});

test('planSkillWrite: defaults (no args) treat the destination as free + reject-mode', () => {
  assert.deepEqual(T.planSkillWrite(), { ok: true, overwrite: false });
});
