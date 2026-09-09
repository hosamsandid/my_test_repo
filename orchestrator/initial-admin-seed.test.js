'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveInitialAdminSeed, buildSeedAuditEvent, recordSeedAudit,
  DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD,
} = require('./initial-admin-seed');

// ---- which configured input describes the first administrator --------------

test('resolveInitialAdminSeed: ADMIN_USERNAME/ADMIN_PASSWORD is the default input', () => {
  const seed = resolveInitialAdminSeed({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'sekrit' });
  assert.deepEqual(seed, {
    source: 'admin-username', subject: 'ops', password: 'sekrit', email: '', displayName: '',
  });
});

test('resolveInitialAdminSeed: an unset pair falls back to the shipped default', () => {
  // A stack upgrading from before #2059 may not pass the pair to the
  // orchestrator at all; it must still seed the documented admin/admin account
  // rather than leaving the console with nobody to authenticate.
  const seed = resolveInitialAdminSeed({});
  assert.equal(seed.subject, DEFAULT_ADMIN_USERNAME);
  assert.equal(seed.password, DEFAULT_ADMIN_PASSWORD);
  assert.equal(seed.source, 'admin-username');
  assert.equal(DEFAULT_ADMIN_USERNAME, 'admin', 'the shipped default is documented as admin/admin');
  assert.equal(DEFAULT_ADMIN_PASSWORD, 'admin');
});

test('resolveInitialAdminSeed: an explicitly blank value is an opt-out, not a default', () => {
  // Present-but-empty is a deliberate act: an operator who blanks the password
  // does not want a password-login account seeded for them.
  assert.equal(resolveInitialAdminSeed({ ADMIN_PASSWORD: '' }), null);
  assert.equal(resolveInitialAdminSeed({ ADMIN_PASSWORD: '   ' }), null, 'whitespace is blank');
  assert.equal(resolveInitialAdminSeed({ ADMIN_USERNAME: '' }), null);
  // But blanking one while naming a bootstrap subject still seeds that subject.
  assert.equal(
    resolveInitialAdminSeed({ ADMIN_PASSWORD: '', BOOTSTRAP_SYSTEM_ADMIN_SUBJECT: 'a@corp.com' }).subject,
    'a@corp.com',
  );
});

test('resolveInitialAdminSeed: BOOTSTRAP_SYSTEM_ADMIN_SUBJECT wins and carries no password', () => {
  const seed = resolveInitialAdminSeed({
    ADMIN_USERNAME: 'ops',
    ADMIN_PASSWORD: 'sekrit',
    BOOTSTRAP_SYSTEM_ADMIN_SUBJECT: ' admin@corp.com ',
    BOOTSTRAP_SYSTEM_ADMIN_EMAIL: 'admin@corp.com',
    BOOTSTRAP_SYSTEM_ADMIN_NAME: 'Corp Admin',
  });
  assert.deepEqual(seed, {
    source: 'bootstrap-subject',
    subject: 'admin@corp.com',
    password: '',
    email: 'admin@corp.com',
    displayName: 'Corp Admin',
  });
  assert.equal(seed.password, '', 'an SSO stack authenticates through the proxy, not a password');
});

test('resolveInitialAdminSeed: a blank bootstrap subject does not shadow the password pair', () => {
  const seed = resolveInitialAdminSeed({
    BOOTSTRAP_SYSTEM_ADMIN_SUBJECT: '  ', ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'pw',
  });
  assert.equal(seed.source, 'admin-username');
  assert.equal(seed.subject, 'ops');
});

test('resolveInitialAdminSeed: values are trimmed, and defaults to process.env', () => {
  assert.equal(resolveInitialAdminSeed({ ADMIN_USERNAME: '  ops  ', ADMIN_PASSWORD: ' pw ' }).subject, 'ops');
  // Called with no argument it reads the real environment rather than throwing.
  assert.doesNotThrow(() => resolveInitialAdminSeed());
});

// ---- the audit entry (#2059 AC1) -------------------------------------------

test('buildSeedAuditEvent records the seeding without the password', () => {
  const at = new Date('2026-09-08T10:11:12.000Z');
  const event = buildSeedAuditEvent({
    seed: { source: 'admin-username', subject: 'admin', password: 'sekrit' },
    user: { id: 'u-1', subject: 'admin', hasPassword: true },
    at,
  });

  assert.equal(event.ts, '2026-09-08T10:11:12.000Z');
  assert.equal(event.actor, 'admin');
  assert.equal(event.method, 'BOOTSTRAP', 'no request happened — the platform did this');
  assert.equal(event.action, 'BOOTSTRAP /internal/admin/users');
  assert.equal(event.outcome, 'success');
  assert.equal(event.status, 201);
  assert.deepEqual(event.seed, {
    reason: 'initial-system-admin',
    source: 'admin-username',
    subject: 'admin',
    userId: 'u-1',
    hasPassword: true,
  });

  // The secret must not appear anywhere in the serialized line.
  assert.ok(!JSON.stringify(event).includes('sekrit'), 'the seeded password is never audited');
});

test('buildSeedAuditEvent reports a password-less (SSO) seeding honestly', () => {
  const event = buildSeedAuditEvent({
    seed: { source: 'bootstrap-subject', subject: 'a@corp.com' },
    user: { id: 'u-2', subject: 'a@corp.com', hasPassword: false },
  });
  assert.equal(event.seed.hasPassword, false);
  assert.equal(event.seed.source, 'bootstrap-subject');
  // A caller with nothing to say still produces a parseable line.
  const bare = buildSeedAuditEvent();
  assert.equal(bare.actor, null);
  assert.equal(bare.seed.userId, null);
  assert.ok(Date.parse(bare.ts) > 0);
});

// The audit trail is a JSONL directory contract shared by two containers, not a
// module both can import — so this is the two-sided guard that the orchestrator's
// one entry is shaped like every entry the admin-console writes. A new key on
// either side has to be a deliberate act, not a silent divergence.
test('the seed audit entry carries the same keys as the console audit writer', () => {
  const { buildEvent } = require('../admin-console/api/audit');
  const consoleEvent = buildEvent(
    { method: 'POST', originalUrl: '/api/admin/users?x=1', user: { username: 'someone' }, body: {} },
    { statusCode: 201 },
  );
  const seedEvent = buildSeedAuditEvent({
    seed: { source: 'admin-username', subject: 'admin' },
    user: { id: 'u-1', subject: 'admin', hasPassword: true },
  });

  const consoleKeys = Object.keys(consoleEvent).sort();
  const seedKeys = Object.keys(seedEvent).sort();
  assert.deepEqual(
    seedKeys.filter(k => k !== 'seed'), consoleKeys,
    'the seed entry must carry exactly the console\'s keys, plus its own `seed` block',
  );
  assert.ok(seedKeys.includes('seed'), 'the extra block is the only difference');
  // The shared keys the audit page renders must be the same TYPE on both sides.
  for (const key of ['ts', 'actor', 'action', 'method', 'resource', 'outcome']) {
    assert.equal(typeof seedEvent[key], typeof consoleEvent[key], `${key} type matches`);
  }
});

// ---- writing it -----------------------------------------------------------

test('recordSeedAudit appends one JSONL line to the day file', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seed-audit-')), 'nested', 'audit');
  const event = buildSeedAuditEvent({
    seed: { source: 'admin-username', subject: 'admin' },
    user: { id: 'u-1', subject: 'admin', hasPassword: true },
    at: new Date('2026-09-08T10:11:12.000Z'),
  });

  assert.equal(recordSeedAudit(dir, event), true, 'creates the directory tree it needs');
  const file = path.join(dir, 'audit-2026-09-08.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), event, 'round-trips as JSON');

  // Appends rather than truncating, like the console's writer.
  recordSeedAudit(dir, event);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
});

test('recordSeedAudit never throws when the audit volume is unusable', () => {
  // Force ENOTDIR with a FILE where a parent directory is expected — `chmod`
  // would be vacuous here because the suite runs as root, which ignores
  // permission bits entirely.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-audit-bad-'));
  const blocker = path.join(base, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const dir = path.join(blocker, 'audit');
  assert.throws(() => fs.mkdirSync(dir, { recursive: true }), /ENOTDIR/, 'the path really is unusable');

  const event = buildSeedAuditEvent({ user: { id: 'u-1', subject: 'admin' } });
  assert.equal(recordSeedAudit(dir, event), false, 'reports the failure instead of throwing');
});
