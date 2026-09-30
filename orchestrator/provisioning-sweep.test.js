'use strict';

// Unit tests for the stuck-`_provisioning` reaper's pure core (#2493). The
// orchestrator wiring — the flat scan, the reap through the delete route, the
// event-log write — is guarded separately by provisioning-sweep-wiring.test.js
// (orchestrator.js can't be required in a unit test).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVISIONING_STUCK_MS,
  PROVISIONING_SWEEP_KEY,
  provisioningAgeMs,
  isStuckProvisioning,
  provisioningOrigin,
  buildProvisioningSweepLogEvent,
  buildProvisioningSweepLogFields,
} = require('./provisioning-sweep');

const NOW = Date.parse('2026-09-25T12:00:00.000Z');

test('provisioningAgeMs prefers the explicit stamp over file mtime', () => {
  const provisioningAt = new Date(NOW - 5 * 60_000).toISOString();
  // mtime is much older, but the stamp is authoritative when present.
  const age = provisioningAgeMs({ provisioningAt, fileMtimeMs: NOW - 60 * 60_000 }, NOW);
  assert.equal(age, 5 * 60_000);
});

test('provisioningAgeMs falls back to file mtime when no stamp (pre-#2493 leftover)', () => {
  const age = provisioningAgeMs({ provisioningAt: undefined, fileMtimeMs: NOW - 8 * 60_000 }, NOW);
  assert.equal(age, 8 * 60_000);
});

test('provisioningAgeMs returns null when neither source is a usable timestamp', () => {
  assert.equal(provisioningAgeMs({ provisioningAt: 'not-a-date', fileMtimeMs: null }, NOW), null);
  assert.equal(provisioningAgeMs({}, NOW), null);
  assert.equal(provisioningAgeMs(undefined, NOW), null);
});

test('provisioningAgeMs returns null for a future timestamp (clock skew / bad stamp)', () => {
  const future = new Date(NOW + 10 * 60_000).toISOString();
  assert.equal(provisioningAgeMs({ provisioningAt: future }, NOW), null);
});

test('provisioningAgeMs ignores a bad stamp and uses mtime as fallback', () => {
  const age = provisioningAgeMs({ provisioningAt: 'garbage', fileMtimeMs: NOW - 3 * 60_000 }, NOW);
  assert.equal(age, 3 * 60_000);
});

test('isStuckProvisioning: past-threshold _provisioning config is stuck', () => {
  const cfg = { id: 'a', _provisioning: true };
  assert.equal(isStuckProvisioning(cfg, PROVISIONING_STUCK_MS + 1), true);
  assert.equal(isStuckProvisioning(cfg, PROVISIONING_STUCK_MS), true); // exactly at threshold counts
});

test('isStuckProvisioning: a young in-flight attempt is never stuck (AC5)', () => {
  const cfg = { id: 'a', _provisioning: true };
  assert.equal(isStuckProvisioning(cfg, PROVISIONING_STUCK_MS - 1), false);
  assert.equal(isStuckProvisioning(cfg, 0), false);
});

test('isStuckProvisioning: a config without _provisioning:true is never stuck', () => {
  assert.equal(isStuckProvisioning({ id: 'a' }, PROVISIONING_STUCK_MS + 1), false);
  assert.equal(isStuckProvisioning({ id: 'a', _provisioning: false }, PROVISIONING_STUCK_MS + 1), false);
  assert.equal(isStuckProvisioning({ id: 'a', enabled: true }, PROVISIONING_STUCK_MS + 1), false);
  assert.equal(isStuckProvisioning(null, PROVISIONING_STUCK_MS + 1), false);
});

test('isStuckProvisioning: an untrustworthy (null) age is never stuck', () => {
  const cfg = { id: 'a', _provisioning: true };
  assert.equal(isStuckProvisioning(cfg, null), false);
  assert.equal(isStuckProvisioning(cfg, NaN), false);
});

test('isStuckProvisioning honours a custom threshold', () => {
  const cfg = { id: 'a', _provisioning: true };
  assert.equal(isStuckProvisioning(cfg, 30_000, 20_000), true);
  assert.equal(isStuckProvisioning(cfg, 10_000, 20_000), false);
});

test('provisioningOrigin classifies the three creation paths (AC4)', () => {
  assert.equal(provisioningOrigin({ role: 'agent', _provisioning: true }), 'standalone');
  assert.equal(provisioningOrigin({ role: 'team-member', parentTeamId: 't', _provisioning: true }), 'team-member');
  assert.equal(provisioningOrigin({ parentTeamId: 't', _provisioning: true }), 'team-member');
  assert.equal(
    provisioningOrigin({ role: 'team-member', parentTeamId: 't', poolInstance: true, _provisioning: true }),
    'pool-instance',
  );
  assert.equal(provisioningOrigin(null), 'unknown');
});

test('buildProvisioningSweepLogEvent is GitHub-shaped with an honest null repo', () => {
  const ev = buildProvisioningSweepLogEvent({ agentId: 'team-x-i5', eventId: 'provsweep:abc', now: '2026-09-25T12:00:00.000Z' });
  assert.equal(ev.id, 'provsweep:abc');
  assert.equal(ev.actor.login, 'provisioning-sweep');
  assert.equal(ev.repo.name, null);
  assert.equal(ev.created_at, '2026-09-25T12:00:00.000Z');
  assert.equal(ev.payload.action, 'reap');
  assert.equal(ev.payload.agentId, 'team-x-i5');
  // No label / work item, so the GitHub-shaped log columns honestly render `—`.
  assert.equal(ev.payload.label, undefined);
});

test('buildProvisioningSweepLogFields carries the reap record for the log row', () => {
  const fields = buildProvisioningSweepLogFields({ agentId: 'a', origin: 'pool-instance', ageMs: 999, action: 'reaped' });
  assert.deepEqual(fields, { provisioningSweep: { agentId: 'a', origin: 'pool-instance', ageMs: 999, action: 'reaped' } });
});

test('buildProvisioningSweepLogFields records an error only when present, ageMs null-safe', () => {
  const ok = buildProvisioningSweepLogFields({ agentId: 'a', origin: 'standalone', ageMs: 1, action: 'reaped', error: null });
  assert.equal('error' in ok.provisioningSweep, false);

  const failed = buildProvisioningSweepLogFields({ agentId: 'a', origin: 'standalone', ageMs: NaN, action: 'reap-failed', error: 'delete route returned 500' });
  assert.equal(failed.provisioningSweep.ageMs, null);
  assert.equal(failed.provisioningSweep.error, 'delete route returned 500');
});

test('the event-log key is the dedicated provisioning.reaped key', () => {
  assert.equal(PROVISIONING_SWEEP_KEY, 'provisioning.reaped');
});
