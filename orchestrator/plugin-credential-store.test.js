'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PluginCredentialStore,
  shapeCredentialValues,
  credentialMeta,
  previewValue,
} = require('./plugin-credential-store');

const JIRA_CREDS = [
  { key: 'site-url', required: true, description: 'Jira site' },
  { key: 'email', required: true },
  { key: 'api-token', required: true },
];

function tmpStore() {
  return new PluginCredentialStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cred-')) });
}

// ── shapeCredentialValues ───────────────────────────────────────────────────

test('shape: drops unknown keys, trims non-blank into `set`, blanks into `clear`', () => {
  const r = shapeCredentialValues(JIRA_CREDS, { 'site-url': ' acme ', junk: 'x', email: '' });
  assert.deepEqual(r.set, { 'site-url': 'acme' });
  assert.deepEqual(r.clear, ['email']);
  assert.equal(r.ok, true);
});

test('shape: a non-string value is the only error; a missing required key is NOT', () => {
  assert.equal(shapeCredentialValues(JIRA_CREDS, { 'site-url': 'acme' }).ok, true); // incomplete is fine
  const bad = shapeCredentialValues(JIRA_CREDS, { 'api-token': 123 });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /must be a string/);
});

// ── previewValue / credentialMeta ───────────────────────────────────────────

test('previewValue never discloses; short values fully masked', () => {
  assert.equal(previewValue('short'), '••••');
  assert.equal(previewValue('ATATT3xFfGF0abcdef123456'), 'AT…3456');
});

test('credentialMeta: per-key set/preview, completeness, no raw values', () => {
  const meta = credentialMeta({ values: { 'site-url': 'acme', 'api-token': 'ATATT-longtokenvalue' }, setBy: 'alice', setAt: 'T' }, JIRA_CREDS);
  assert.equal(meta.keys['site-url'].set, true);
  assert.equal(meta.keys['api-token'].preview, 'AT…alue');
  assert.equal(meta.keys.email.set, false);
  assert.deepEqual(meta.missingRequired, ['email']);
  assert.equal(meta.complete, false);
  assert.equal(meta.setBy, 'alice');
  assert.equal(JSON.stringify(meta).includes('ATATT-longtokenvalue'), false); // never leaks
});

// ── store round-trip ────────────────────────────────────────────────────────

test('write → meta: partial writes merge and are stored even when incomplete; file is 0600', () => {
  const s = tmpStore();
  let r = s.write('jira', 'team-1', { 'site-url': 'acme', email: 'a@b.c' }, JIRA_CREDS, { setBy: 'alice' });
  assert.equal(r.ok, true);            // stored
  assert.equal(r.meta.complete, false); // but incomplete (no api-token)
  assert.deepEqual(r.meta.missingRequired, ['api-token']);

  r = s.write('jira', 'team-1', { 'api-token': 'ATATT-secret-value' }, JIRA_CREDS, { setBy: 'alice' });
  assert.equal(r.meta.complete, true);

  const mode = fs.statSync(s._path('jira', 'team-1')).mode & 0o777;
  assert.equal(mode, 0o600);

  // a later write updating one field keeps the rest, restamps setBy
  s.write('jira', 'team-1', { email: 'new@b.c' }, JIRA_CREDS, { setBy: 'bob' });
  const meta = s.meta('jira', 'team-1', JIRA_CREDS);
  assert.equal(meta.keys['site-url'].set, true);
  assert.equal(meta.keys['api-token'].set, true);
  assert.equal(meta.setBy, 'bob');

  // blanking a field clears it
  s.write('jira', 'team-1', { 'api-token': '' }, JIRA_CREDS, { setBy: 'bob' });
  assert.equal(s.meta('jira', 'team-1', JIRA_CREDS).keys['api-token'].set, false);
});

test('resolveScopeCredentialMap: raw values for granted scopes; empty object for unconfigured; unknown scope skipped shape', () => {
  const s = tmpStore();
  s.write('jira', 'team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' }, JIRA_CREDS, { setBy: 'x' });
  const map = s.resolveScopeCredentialMap('jira', ['team-1', 'team-2']);
  assert.deepEqual(map['team-1'], { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' });
  assert.deepEqual(map['team-2'], {}); // granted but not configured
});

test('delete + teardownPlugin', () => {
  const s = tmpStore();
  s.write('jira', 'team-1', { 'site-url': 'a', email: 'b', 'api-token': 'c' }, JIRA_CREDS, { setBy: 'x' });
  s.write('jira', 'team-2', { 'site-url': 'a', email: 'b', 'api-token': 'c' }, JIRA_CREDS, { setBy: 'x' });
  assert.equal(s.delete('jira', 'team-1'), true);
  assert.equal(s.delete('jira', 'team-1'), false);
  assert.equal(s.teardownPlugin('jira'), 1); // team-2 left
  assert.equal(s.teardownPlugin('jira'), 0);
});

test('invalid ids are refused (path traversal)', () => {
  const s = tmpStore();
  assert.throws(() => s.read('../evil', 'team-1'));
  assert.throws(() => s.read('jira', '../../etc/passwd'));
});
