'use strict';

// Unit tests for the one-time resource migration classifier (#2359, concept
// §11 / §12.5 / §12.8 / §12.9). Pure — the routes (api.js) supply store IO + the
// System-Admin/flag gate, guarded separately.
// Run: node --test admin-console/api/resource-migration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inferIdentity,
  needsMigration,
  suggestMigration,
  planResourceMigration,
  applyMigrationDecision,
} = require('./resource-migration');

// ── inferIdentity (matches the PR2/PR3 create-time stamps) ──────────────────

test('inferIdentity: provider oauth→human, api-key→service; credential personal→human, else service', () => {
  assert.equal(inferIdentity('provider', { authType: 'oauth-token' }), 'human');
  assert.equal(inferIdentity('provider', { authType: 'api-key' }), 'service');
  assert.equal(inferIdentity('ssh-key', { scope: 'personal' }), 'human');
  assert.equal(inferIdentity('ssh-key', { scope: 'team' }), 'service');
  assert.equal(inferIdentity('github-token', { scope: 'system' }), 'service');
});

// ── needsMigration ──────────────────────────────────────────────────────────

test('needsMigration: a stamped personal/team/global record is done; a system-assigned or unstamped one is not', () => {
  assert.equal(needsMigration({ scope: 'personal', userId: 'u', identity: 'human' }), false);
  assert.equal(needsMigration({ scope: 'team', teamId: 't', identity: 'service' }), false);
  assert.equal(needsMigration({ scope: 'system', global: true, identity: 'service' }), false);
  // Removed axis: system + assignedTeamIds (not global) — even if stamped.
  assert.equal(needsMigration({ scope: 'system', assignedTeamIds: ['t'], identity: 'service' }), true);
  // Unstamped legacy records of any tier.
  assert.equal(needsMigration({ scope: 'team', teamId: 't' }), true);
  assert.equal(needsMigration({ scope: 'personal', userId: 'u' }), true);
  assert.equal(needsMigration({}), true); // pre-#798 no-scope record
});

// ── suggestMigration: tier logic (§11) ──────────────────────────────────────

test('suggest: a global provider stays global (service)', () => {
  const s = suggestMigration('provider', { id: 'p', global: true, scope: 'system', authType: 'api-key' });
  assert.deepEqual(s.suggested, { identity: 'service', scope: 'global' });
});

test('suggest: system assigned to exactly one team → Team-service of that team', () => {
  const s = suggestMigration('github-token', { id: 'g', scope: 'system', assignedTeamIds: ['payments'] });
  assert.deepEqual(s.suggested, { identity: 'service', scope: 'team', teamId: 'payments' });
  assert.deepEqual(s.flags, []);
});

test('suggest: system assigned to many teams → Global candidate, flagged (never auto-split)', () => {
  const s = suggestMigration('ssh-key', { id: 'k', scope: 'system', assignedTeamIds: ['a', 'b', 'c'] });
  assert.deepEqual(s.suggested, { identity: 'service', scope: 'global' });
  assert.ok(s.flags.includes('global-candidate'));
  assert.ok(!s.flags.includes('orphan'));
});

test('suggest: system assigned to ZERO teams → Global candidate, flagged orphan', () => {
  const s = suggestMigration('ssh-key', { id: 'k', scope: 'system', assignedTeamIds: [] });
  assert.equal(s.suggested.scope, 'global');
  assert.ok(s.flags.includes('global-candidate'));
  assert.ok(s.flags.includes('orphan'));
});

test('suggest: a team record just gets its identity stamped (kept team-service)', () => {
  const s = suggestMigration('github-token', { id: 'g', scope: 'team', teamId: 'payments' });
  assert.deepEqual(s.suggested, { identity: 'service', scope: 'team', teamId: 'payments' });
});

test('suggest: a personal api-key provider stays personal but is SERVICE identity (§5)', () => {
  const s = suggestMigration('provider', { id: 'p', scope: 'personal', userId: 'u-a', authType: 'api-key' });
  assert.deepEqual(s.suggested, { identity: 'service', scope: 'personal', userId: 'u-a' });
});

test('suggest: a human secret on a shared axis is a conflict → flagged + downgraded to personal', () => {
  // A personal SSH key mistakenly system-assigned: human identity can never be team/global.
  const s = suggestMigration('ssh-key', { id: 'k', scope: 'system', assignedTeamIds: ['a', 'b'], identity: 'human', userId: 'u-a' });
  assert.ok(s.flags.includes('identity-tier-conflict'));
  assert.equal(s.suggested.scope, 'personal');
  assert.equal(s.suggested.identity, 'human');
});

test('suggest: an oauth provider proposed global is allowed to stay global (the escape hatch) but flagged', () => {
  const s = suggestMigration('provider', { id: 'p', scope: 'system', assignedTeamIds: ['a', 'b'], authType: 'oauth-token' });
  assert.ok(s.flags.includes('identity-tier-conflict'));
  assert.equal(s.suggested.identity, 'human');
  assert.equal(s.suggested.scope, 'global', 'a subscription MAY be global via the single-user hatch — left for the admin');
});

test('suggest: an already-stamped identity is preserved, never re-inferred', () => {
  const s = suggestMigration('provider', { id: 'p', scope: 'system', assignedTeamIds: ['a'], authType: 'api-key', identity: 'service' });
  assert.equal(s.suggested.identity, 'service');
});

// ── planResourceMigration (the dry-run report) ──────────────────────────────

test('plan: reports only records that need migration, with a per-kind summary', () => {
  const report = planResourceMigration({
    providers: [
      { id: 'p-done', scope: 'personal', userId: 'u', identity: 'service' }, // migrated → skipped
      { id: 'p-sys', scope: 'system', assignedTeamIds: ['a', 'b'], authType: 'api-key' }, // global candidate
    ],
    sshKeys: [{ id: 'k-team', scope: 'team', teamId: 't' }], // unstamped → reported
    githubTokens: [],
  });
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.byKind.provider, 1);
  assert.equal(report.summary.byKind['ssh-key'], 1);
  assert.equal(report.summary.globalCandidates, 1);
  assert.ok(!report.records.some(r => r.id === 'p-done'), 'a migrated record never appears');
});

// ── applyMigrationDecision ──────────────────────────────────────────────────

test('apply: stamps identity + re-homes a system-assigned record to a team', () => {
  const rec = { id: 'g', name: 'CI bot', scope: 'system', assignedTeamIds: ['payments'], authType: undefined };
  const { record } = applyMigrationDecision('github-token', rec, { id: 'g', kind: 'github-token', identity: 'service', scope: 'team', teamId: 'payments' });
  assert.equal(record.identity, 'service');
  assert.equal(record.scope, 'team');
  assert.equal(record.teamId, 'payments');
  assert.deepEqual(record.assignedTeamIds, []);
});

test('apply: global sets the flag + system scope, clears team fields', () => {
  const { record } = applyMigrationDecision('ssh-key', { id: 'k', scope: 'system', assignedTeamIds: ['a', 'b'] }, { identity: 'service', scope: 'global' });
  assert.equal(record.global, true);
  assert.equal(record.scope, 'system');
  assert.deepEqual(record.assignedTeamIds, []);
});

test('apply: identity is IMMUTABLE once set (§12.5)', () => {
  assert.throws(
    () => applyMigrationDecision('provider', { id: 'p', identity: 'service', scope: 'system', assignedTeamIds: ['a'] }, { identity: 'human', scope: 'personal', userId: 'u' }),
    /immutable/,
  );
});

test('apply: refuses an illegal identity×tier combo (a human secret cannot be team/global)', () => {
  assert.throws(
    () => applyMigrationDecision('ssh-key', { id: 'k', scope: 'system', assignedTeamIds: ['a'] }, { identity: 'human', scope: 'team', teamId: 't' }),
    /human-identity secret cannot be a team credential/,
  );
  assert.throws(
    () => applyMigrationDecision('ssh-key', { id: 'k', scope: 'system' }, { identity: 'human', scope: 'global' }),
    /cannot be global/,
  );
});

test('apply: a single-user subscription MAY go global via the escape hatch', () => {
  const { record } = applyMigrationDecision('provider', { id: 'p', authType: 'oauth-token', scope: 'system', assignedTeamIds: ['a'] }, { identity: 'human', scope: 'global' });
  assert.equal(record.global, true);
  assert.equal(record.identity, 'human');
});

test('apply: delete removes the record', () => {
  const { record, deleted } = applyMigrationDecision('provider', { id: 'p', scope: 'system', assignedTeamIds: ['a'] }, { delete: true });
  assert.equal(deleted, true);
  assert.equal(record, null);
});

test('apply: a personal decision requires an owner', () => {
  assert.throws(
    () => applyMigrationDecision('ssh-key', { id: 'k', scope: 'system', assignedTeamIds: ['a'] }, { identity: 'service', scope: 'personal' }),
    /needs an owner/,
  );
});
