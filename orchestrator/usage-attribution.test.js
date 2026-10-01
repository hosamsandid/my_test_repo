'use strict';

// Unit tests for the pure cost-attribution decisions (#2137).
// Run: node --test orchestrator/usage-attribution.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ATTRIBUTION_KINDS,
  PROVIDER_TIERS,
  userIdForMatrixId,
  resolveUsageAttribution,
  providerTierOf,
} = require('./usage-attribution');

// Personal identities have the reserved `@u-<16 hex>` shape (#1458); only
// those can name a person (#2721 AC7).
const THORSTEN = '@u-1111111111111111:aee.local';
const ADA = '@u-aaaaaaaaaaaaaaaa:aee.local';
const STRANGER = '@u-5555555555555555:aee.local';
const SHARED_ADMIN = '@k-zyskowski_accent:local';

const users = [
  { id: 'u-thorsten', subject: 'thorsten@example.com', matrixUserId: THORSTEN },
  { id: 'u-ada', subject: 'ada@example.com', matrixUserId: ADA },
  { id: 'u-nomatrix', subject: 'nomatrix@example.com' }, // never chat-provisioned
];

// ── userIdForMatrixId ───────────────────────────────────────────────────────

test('userIdForMatrixId maps a Matrix sender onto the platform account', () => {
  assert.equal(userIdForMatrixId(users, ADA), 'u-ada');
});

test('userIdForMatrixId is case-insensitive and trims', () => {
  assert.equal(userIdForMatrixId(users, '  @U-AAAAAAAAAAAAAAAA:AEE.LOCAL '), 'u-ada');
});

test('userIdForMatrixId never invents an id', () => {
  assert.equal(userIdForMatrixId(users, STRANGER), null);
  assert.equal(userIdForMatrixId(users, ''), null);
  assert.equal(userIdForMatrixId(users, null), null);
  assert.equal(userIdForMatrixId(null, ADA), null);
  // A user record with no matrixUserId must not match a blank/absent sender.
  assert.equal(userIdForMatrixId(users, undefined), null);
});

test('the shared admin account never resolves to a person, even if a record carries it (#2721 AC7)', () => {
  const poisoned = [...users, { id: 'u-colleague', subject: 'k@example.com', matrixUserId: SHARED_ADMIN }];
  assert.equal(userIdForMatrixId(poisoned, SHARED_ADMIN), null);
  // Agent accounts are service identities too.
  const agentRecord = [{ id: 'u-x', matrixUserId: '@my-assistant:local' }];
  assert.equal(userIdForMatrixId(agentRecord, '@my-assistant:local'), null);
  // …and the turn falls back to the baseline, like an unknown sender.
  assert.deepEqual(
    resolveUsageAttribution({ requestedBy: { matrixUserId: SHARED_ADMIN }, users: poisoned, ownerId: 'u-ada' }),
    { userId: 'u-ada', kind: 'agent-owner' },
  );
});

// ── resolveUsageAttribution ─────────────────────────────────────────────────

test('interactive chat turn → the requesting user (AC1)', () => {
  const got = resolveUsageAttribution({
    requestedBy: { matrixUserId: THORSTEN },
    users,
    ownerId: 'u-ada',
  });
  // The requester wins over the agent's owner — they are the one who asked.
  assert.deepEqual(got, { userId: 'u-thorsten', kind: 'requesting-user' });
});

test('autonomous / triggered run → the agent owner (AC3)', () => {
  const got = resolveUsageAttribution({ requestedBy: null, users, ownerId: 'u-ada' });
  assert.deepEqual(got, { userId: 'u-ada', kind: 'agent-owner' });
});

test('unknown sender falls back to the agent owner rather than dropping the spend', () => {
  const got = resolveUsageAttribution({
    requestedBy: { matrixUserId: STRANGER },
    users,
    ownerId: 'u-ada',
  });
  assert.deepEqual(got, { userId: 'u-ada', kind: 'agent-owner' });
});

test('agent with no team AND no owner → explicitly unattributed, never a guess (AC3)', () => {
  const got = resolveUsageAttribution({ requestedBy: null, users, ownerId: null });
  assert.deepEqual(got, { userId: null, kind: 'unattributed' });
  assert.deepEqual(resolveUsageAttribution(), { userId: null, kind: 'unattributed' });
  // Blank / whitespace owner ids are not accounts.
  assert.deepEqual(
    resolveUsageAttribution({ ownerId: '   ' }),
    { userId: null, kind: 'unattributed' },
  );
});

test('a non-string owner id is still usable (coerced), a numeric 0 is not an account', () => {
  assert.deepEqual(resolveUsageAttribution({ ownerId: 42 }), { userId: '42', kind: 'agent-owner' });
  assert.deepEqual(resolveUsageAttribution({ ownerId: '' }), { userId: null, kind: 'unattributed' });
});

test('a malformed requestedBy block cannot crash or leak a raw value', () => {
  for (const bad of [ADA, 42, [], { matrixUserId: 7 }]) {
    const got = resolveUsageAttribution({ requestedBy: bad, users, ownerId: 'u-ada' });
    assert.deepEqual(got, { userId: 'u-ada', kind: 'agent-owner' });
  }
});

test('every kind resolveUsageAttribution can return is declared', () => {
  const produced = [
    resolveUsageAttribution({ requestedBy: { matrixUserId: ADA }, users }).kind,
    resolveUsageAttribution({ ownerId: 'u-ada' }).kind,
    resolveUsageAttribution().kind,
  ];
  for (const k of produced) assert.ok(ATTRIBUTION_KINDS.includes(k), `undeclared kind ${k}`);
  assert.deepEqual([...new Set(produced)].sort(), [...ATTRIBUTION_KINDS].sort());
});

// ── providerTierOf ──────────────────────────────────────────────────────────

const globalEp = { id: 'ep-global', scope: 'system', global: true, authType: 'api-key' };
const systemEp = { id: 'ep-sys', scope: 'system', assignedTeamIds: ['alpha'], authType: 'api-key' };
const teamEp = { id: 'ep-team', scope: 'team', teamId: 'alpha', authType: 'api-key' };
const legacyEp = { id: 'ep-legacy', teamId: 'alpha' }; // pre-#798: no scope field
const index = [globalEp, systemEp, teamEp, legacyEp];

test('providerTierOf distinguishes global from system and team (AC2)', () => {
  assert.equal(providerTierOf(index, 'ep-global'), 'global');
  assert.equal(providerTierOf(index, 'ep-sys'), 'system');
  assert.equal(providerTierOf(index, 'ep-team'), 'team');
  assert.equal(providerTierOf(index, 'ep-legacy'), 'team');
});

test('providerTierOf re-reads all three global conditions, not the stored flag alone', () => {
  // scope flipped to team by a hand edit / stale write → NOT global (#2136 f1).
  assert.equal(
    providerTierOf([{ id: 'x', scope: 'team', teamId: 'alpha', global: true, authType: 'api-key' }], 'x'),
    'team',
  );
  // switched to a subscription seat after publication → NOT global.
  assert.equal(
    providerTierOf([{ id: 'x', scope: 'system', global: true, authType: 'oauth-token' }], 'x'),
    'system',
  );
  // only a literal boolean true is global.
  for (const flag of ['true', 1, {}, 'yes']) {
    assert.equal(
      providerTierOf([{ id: 'x', scope: 'system', global: flag, authType: 'api-key' }], 'x'),
      'system',
      `global: ${JSON.stringify(flag)} must not publish a global tier`,
    );
  }
});

test('a team-assigned provider can never read as global — no double-counting rule needed', () => {
  // The ticket's "both global and team-assigned" edge case: such a record is not
  // scope:'system', so it lands in exactly one tier (team) and its tokens are
  // counted once.
  const ep = { id: 'x', scope: 'team', teamId: 'alpha', assignedTeamIds: ['alpha'], global: true };
  assert.equal(providerTierOf([ep], 'x'), 'team');
});

test('providerTierOf is honestly null when the tier cannot be resolved', () => {
  assert.equal(providerTierOf(index, 'ep-deleted'), null); // provider since deleted
  assert.equal(providerTierOf(index, null), null);         // record carries no provider
  assert.equal(providerTierOf(index, ''), null);
  assert.equal(providerTierOf(null, 'ep-global'), null);
});

test('every tier providerTierOf can return is declared', () => {
  const produced = ['ep-global', 'ep-sys', 'ep-team'].map((id) => providerTierOf(index, id));
  for (const t of produced) assert.ok(PROVIDER_TIERS.includes(t), `undeclared tier ${t}`);
  assert.deepEqual([...new Set(produced)].sort(), [...PROVIDER_TIERS].sort());
});
