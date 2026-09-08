'use strict';

// Run: node --test orchestrator/resource-tier.test.js
//
// The shared three-tier shape (#2083, epic #2076 P5). Its twin lives in
// admin-console/api/resource-tier.js; the guard below is the two-sided
// byte-identity check the `agent-team.js` precedent established, and the
// admin-console copy carries the mirror of it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  TIER_PERSONAL, TIER_TEAM, TIER_SYSTEM, TIERS,
  normalizeTier, ownsPersonalTier, isSharedTier,
  tierTeamIds, tierUsableByTeam, tierOwnershipFields, isRetier,
} = require('./resource-tier');

const TWIN = path.join(__dirname, '..', 'admin-console', 'api', 'resource-tier.js');

test('two-sided guard: orchestrator copy is byte-identical to admin-console copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'resource-tier.js'));
  const there = fs.readFileSync(TWIN);
  assert.ok(here.equals(there), 'resource-tier.js copies differ — change both in one commit');
});

// ── normalizeTier: the three shapes, and the legacy one ─────────────────────

test('a record with no scope reads as team-tier — every pre-#2083 record keeps working', () => {
  assert.deepEqual(normalizeTier({ id: 'env-sdlc', teamId: 'default' }), {
    id: 'env-sdlc', scope: TIER_TEAM, teamId: 'default', assignedTeamIds: [],
  });
});

test('an unstamped record fails closed: team tier with NO team, not the default team', () => {
  const r = normalizeTier({ id: 'env-orphan' });
  assert.equal(r.scope, TIER_TEAM);
  assert.equal(r.teamId, null);
  // §8.4 — the historical `|| 'default'` collapse is not reintroduced here.
  assert.notEqual(r.teamId, 'default');
});

test('the shared tier nulls the owning team and dedupes+stringifies its assignments', () => {
  const r = normalizeTier({
    id: 'env-shared', scope: TIER_SYSTEM, teamId: 'leftover',
    assignedTeamIds: ['sdlc', 'sdlc', 'billing', 7],
  });
  assert.equal(r.teamId, null);
  assert.deepEqual(r.assignedTeamIds, ['sdlc', 'billing', '7']);
});

test('a shared record assigned to zero teams keeps an empty list, not a null', () => {
  assert.deepEqual(normalizeTier({ scope: TIER_SYSTEM }).assignedTeamIds, []);
  assert.deepEqual(normalizeTier({ scope: TIER_SYSTEM, assignedTeamIds: 'nope' }).assignedTeamIds, []);
});

test('the personal tier round-trips its owner and clears both team fields', () => {
  const r = normalizeTier({ id: 'k', scope: TIER_PERSONAL, userId: 'u-ada', teamId: 'default', assignedTeamIds: ['x'] });
  assert.equal(r.userId, 'u-ada');
  assert.equal(r.teamId, null);
  assert.deepEqual(r.assignedTeamIds, []);
});

test('normalizeTier is a copy, never a mutation of the stored record', () => {
  const stored = { id: 'env', teamId: 'default' };
  const r = normalizeTier(stored);
  assert.notEqual(r, stored);
  assert.deepEqual(stored, { id: 'env', teamId: 'default' }, 'the on-disk record must be untouched');
});

test('normalizeTier passes non-objects straight through rather than inventing a tier', () => {
  assert.equal(normalizeTier(null), null);
  assert.equal(normalizeTier(undefined), undefined);
  assert.equal(normalizeTier('env-sdlc'), 'env-sdlc');
});

// ── the personal tier's privacy guarantee ───────────────────────────────────

test('only the owner owns a personal record — and an admin scope is NOT special here', () => {
  const rec = { scope: TIER_PERSONAL, userId: 'u-ada' };
  assert.equal(ownsPersonalTier({ all: false, userId: 'u-ada' }, rec), true);
  assert.equal(ownsPersonalTier({ all: false, userId: 'u-bob' }, rec), false);
  // The whole point of the tier: `all: true` buys nothing.
  assert.equal(ownsPersonalTier({ all: true, userId: 'u-bob' }, rec), false);
  assert.equal(ownsPersonalTier({ all: true, userId: null }, rec), false, 'the env single-admin has no user record');
});

test('an ownerless personal record and a caller-less scope both match nobody', () => {
  assert.equal(ownsPersonalTier({ userId: 'u-ada' }, { scope: TIER_PERSONAL }), false);
  assert.equal(ownsPersonalTier(null, { scope: TIER_PERSONAL, userId: 'u-ada' }), false);
  assert.equal(ownsPersonalTier({}, { scope: TIER_PERSONAL, userId: 'u-ada' }), false);
});

// ── isSharedTier: what the boot adoption pass keys on ───────────────────────

test('isSharedTier reads the RAW record, so the adoption pass can skip it before normalizing', () => {
  assert.equal(isSharedTier({ scope: TIER_SYSTEM, assignedTeamIds: [] }), true);
  assert.equal(isSharedTier({ scope: TIER_TEAM, teamId: 'default' }), false);
  assert.equal(isSharedTier({ teamId: 'default' }), false);
  // A shared record's `teamId: null` is DELIBERATE, and `needsAdoption` keys on
  // `teamId === undefined` — so the two rules already agree. Pin both halves.
  assert.equal(isSharedTier({ scope: TIER_SYSTEM, teamId: null }), true);
  assert.equal(isSharedTier(null), false);
});

// ── reach, without a caller ─────────────────────────────────────────────────

test('tierTeamIds reads the reach off whichever field the tier uses', () => {
  assert.deepEqual(tierTeamIds({ teamId: 'default' }), ['default']);
  assert.deepEqual(tierTeamIds({ scope: TIER_SYSTEM, assignedTeamIds: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(tierTeamIds({ scope: TIER_SYSTEM, assignedTeamIds: [] }), []);
  assert.deepEqual(tierTeamIds({ scope: TIER_PERSONAL, userId: 'u-ada' }), []);
  assert.deepEqual(tierTeamIds({}), [], 'an unstamped record is reached by no team');
});

test('tierUsableByTeam: a shared record is usable by each assigned team and nobody else', () => {
  const shared = { scope: TIER_SYSTEM, assignedTeamIds: ['sdlc', 'billing'] };
  assert.equal(tierUsableByTeam(shared, 'sdlc'), true);
  assert.equal(tierUsableByTeam(shared, 'billing'), true);
  assert.equal(tierUsableByTeam(shared, 'risk'), false);
  // Assigned to nobody → usable by nobody, INCLUDING the historical default.
  const orphan = { scope: TIER_SYSTEM, assignedTeamIds: [] };
  assert.equal(tierUsableByTeam(orphan, 'default'), false);
  assert.equal(tierUsableByTeam(orphan, 'sdlc'), false);
});

test('tierUsableByTeam has no `|| default` fallback for a missing team argument', () => {
  assert.equal(tierUsableByTeam({ teamId: 'default' }, null), false);
  assert.equal(tierUsableByTeam({ teamId: 'default' }, ''), false);
  assert.equal(tierUsableByTeam({ teamId: 'default' }, undefined), false);
  assert.equal(tierUsableByTeam({ teamId: 'default' }, 'default'), true);
});

// ── the persisted triple ────────────────────────────────────────────────────

test('tierOwnershipFields writes exactly the tier triple and drops everything else', () => {
  assert.deepEqual(
    tierOwnershipFields({ scope: TIER_TEAM, teamId: 'sdlc', name: 'smuggled', ownerId: 'u-x' }),
    { scope: TIER_TEAM, teamId: 'sdlc', assignedTeamIds: [] },
  );
  assert.deepEqual(
    tierOwnershipFields({ scope: TIER_SYSTEM, assignedTeamIds: ['a', 'a'] }),
    { scope: TIER_SYSTEM, teamId: null, assignedTeamIds: ['a'] },
  );
  assert.deepEqual(
    tierOwnershipFields({ scope: TIER_PERSONAL, userId: 'u-ada' }),
    { scope: TIER_PERSONAL, teamId: null, assignedTeamIds: [], userId: 'u-ada' },
  );
});

test('tierOwnershipFields defaults an unrecognised tier to team, never to shared', () => {
  assert.equal(tierOwnershipFields({ scope: 'global', teamId: 'sdlc' }).scope, TIER_TEAM);
  assert.equal(tierOwnershipFields({}).scope, TIER_TEAM);
  assert.equal(tierOwnershipFields(undefined).scope, TIER_TEAM);
});

// ── isRetier: the boundary §5.2 puts behind a System Admin ──────────────────

test('a tier change is a re-tier, in every direction', () => {
  const team = { scope: TIER_TEAM, teamId: 'sdlc' };
  const shared = { scope: TIER_SYSTEM, assignedTeamIds: ['sdlc'] };
  const personal = { scope: TIER_PERSONAL, userId: 'u-ada' };
  assert.equal(isRetier(team, shared), true);
  assert.equal(isRetier(shared, team), true);
  assert.equal(isRetier(team, personal), true);
  assert.equal(isRetier(personal, team), true);
});

test('a cross-team move and a change of shared assignments are re-tiers', () => {
  assert.equal(isRetier({ teamId: 'sdlc' }, { scope: TIER_TEAM, teamId: 'billing' }), true);
  assert.equal(
    isRetier({ scope: TIER_SYSTEM, assignedTeamIds: ['a'] }, { scope: TIER_SYSTEM, assignedTeamIds: ['a', 'b'] }),
    true,
  );
  assert.equal(
    isRetier({ scope: TIER_SYSTEM, assignedTeamIds: ['a', 'b'] }, { scope: TIER_SYSTEM, assignedTeamIds: ['a'] }),
    true,
    'un-assigning a team is a re-tier too — it removes reach',
  );
});

test('editing the CONTENT of a record is not a re-tier — that is the whole point of the split', () => {
  // The same ownership, restated by a client that also changed the repo list.
  assert.equal(isRetier({ scope: TIER_TEAM, teamId: 'sdlc' }, { scope: TIER_TEAM, teamId: 'sdlc' }), false);
  // A legacy record whose tier is merely made explicit is unchanged.
  assert.equal(isRetier({ teamId: 'sdlc' }, { scope: TIER_TEAM, teamId: 'sdlc' }), false);
  // Assignment ORDER is not a change (the list is a set).
  assert.equal(
    isRetier({ scope: TIER_SYSTEM, assignedTeamIds: ['b', 'a'] }, { scope: TIER_SYSTEM, assignedTeamIds: ['a', 'b'] }),
    false,
  );
  // Nor is a duplicate a client happened to send twice.
  assert.equal(
    isRetier({ scope: TIER_SYSTEM, assignedTeamIds: ['a'] }, { scope: TIER_SYSTEM, assignedTeamIds: ['a', 'a'] }),
    false,
  );
});

test('TIERS names all three and nothing else', () => {
  assert.deepEqual(TIERS, [TIER_PERSONAL, TIER_TEAM, TIER_SYSTEM]);
  assert.deepEqual([...new Set(TIERS)], TIERS, 'no duplicates');
});
