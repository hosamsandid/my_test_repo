import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fieldType,
  fieldDescriptors,
  scopeStatusLabel,
  scopeStatusTone,
  buildCredentialSubmit,
  isCredentialDraftDirty,
  selectScopes,
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

test('fieldDescriptors: a secret:false field pre-fills its real value; a secret field stays masked (#2449)', () => {
  const creds = [
    { key: 'site-url', required: true, secret: false },
    { key: 'writable-custom-fields', required: false, secret: false },
    { key: 'api-token', required: true }, // no flag → secret by default
  ];
  const d = fieldDescriptors(creds, {
    'site-url': { set: true, secret: false, value: 'acme', preview: 'ac…me' },
    'writable-custom-fields': { set: false, secret: false, value: '' },
    'api-token': { set: true, secret: true, preview: 'AT…9xQ' },
  });
  // non-secret: text input, no "Stored" mask, real value carried for pre-fill
  assert.equal(d[0].secret, false);
  assert.equal(d[0].type, 'text');
  assert.equal(d[0].storedValue, 'acme');
  assert.match(d[0].placeholder, /Required/);
  assert.equal(d[1].storedValue, '');
  // secret keeps the masked, preview-only, write-only behavior
  assert.equal(d[2].secret, true);
  assert.equal(d[2].type, 'password');
  assert.equal(d[2].storedValue, '');
  assert.match(d[2].placeholder, /Stored \(AT…9xQ\)/);
});

test('buildCredentialSubmit: a re-submitted unchanged secret:false value is sent as-is (#2449)', () => {
  const creds = [{ key: 'site-url', required: true, secret: false }];
  const desc = fieldDescriptors(creds, { 'site-url': { set: true, secret: false, value: 'acme' } });
  // the composer pre-fills the input with the stored value; re-saving submits it
  assert.deepEqual(buildCredentialSubmit({ 'site-url': 'acme' }, desc).values, { 'site-url': 'acme' });
  // cleared back to blank → explicit "" (unrestricted, per the ticket's edge case)
  assert.deepEqual(buildCredentialSubmit({ 'site-url': '' }, desc).values, { 'site-url': '' });
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

test('selectScopes: null keeps all, an id pins to that one scope', () => {
  const scopes = [
    { scopeId: 'team-a', teamName: 'A' },
    { scopeId: 'team-b', teamName: 'B' },
  ];
  assert.equal(selectScopes(scopes, null).length, 2);
  assert.equal(selectScopes(scopes, undefined).length, 2);
  assert.deepEqual(selectScopes(scopes, 'team-b'), [{ scopeId: 'team-b', teamName: 'B' }]);
  assert.deepEqual(selectScopes(scopes, 'team-z'), []);
  assert.deepEqual(selectScopes(null, 'team-a'), []);
});
