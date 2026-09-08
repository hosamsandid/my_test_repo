import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fieldType,
  fieldDescriptors,
  scopeStatusLabel,
  scopeStatusTone,
  buildCredentialSubmit,
  isCredentialDraftDirty,
} from './plugin-credentials-view.js';

const CREDS = [
  { key: 'site-url', required: true, description: 'Jira site' },
  { key: 'email', required: true },
  { key: 'api-token', required: true, description: 'held by the broker' },
];

test('fieldType: secret-shaped keys → password', () => {
  assert.equal(fieldType('api-token'), 'password');
  assert.equal(fieldType('site-url'), 'text');
});

test('fieldDescriptors: merges manifest + scope metadata; placeholder reflects stored state', () => {
  const d = fieldDescriptors(CREDS, {
    'site-url': { set: true, preview: 'ac…me' },
    'api-token': { set: false },
  });
  assert.equal(d[0].type, 'text');
  assert.equal(d[0].set, true);
  assert.match(d[0].placeholder, /Stored \(ac…me\)/);
  assert.equal(d[2].type, 'password');
  assert.match(d[2].placeholder, /Required/);
});

test('scopeStatusLabel / tone: not-configured → incomplete → configured', () => {
  assert.equal(scopeStatusTone({ complete: false, keys: {} }), 'muted');
  assert.equal(scopeStatusLabel({ complete: false, keys: {} }), 'Not configured');

  const partial = { complete: false, keys: { 'site-url': { set: true } }, missingRequired: ['email', 'api-token'] };
  assert.equal(scopeStatusTone(partial), 'warn');
  assert.match(scopeStatusLabel(partial), /still needs: email, api-token/);

  const done = { complete: true, setBy: 'alice', setAt: '2026-09-08T00:00:00Z', keys: {} };
  assert.equal(scopeStatusTone(done), 'ok');
  assert.match(scopeStatusLabel(done), /set by alice/);
});

test('buildCredentialSubmit: blank keeps (omit), blank-on-stored clears (""), new value sent', () => {
  const desc = fieldDescriptors(CREDS, { 'api-token': { set: true } });
  const body = buildCredentialSubmit({ 'site-url': 'acme', email: '  ', 'api-token': '' }, desc);
  assert.deepEqual(body.values, { 'site-url': 'acme', 'api-token': '' });
});

test('isCredentialDraftDirty', () => {
  const desc = fieldDescriptors(CREDS, {});
  assert.equal(isCredentialDraftDirty({}, desc), false);
  assert.equal(isCredentialDraftDirty({ email: '  ' }, desc), false);
  assert.equal(isCredentialDraftDirty({ email: 'a@b.c' }, desc), true);
});
