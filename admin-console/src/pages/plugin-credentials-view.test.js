import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fieldType,
  fieldDescriptors,
  groupDescriptors,
  groupHeading,
  groupNecessity,
  scopeStatusLabel,
  scopeStatusTone,
  buildCredentialSubmit,
  isCredentialDraftDirty,
  selectScopes,
  hasStoredCredential,
  clearConfirmation,
  credentialTestTone,
  credentialTestLine,
} from './plugin-credentials-view.js';

// The Jira-shaped manifest after #jira-setup-ux: grouped + requiredFor-tagged.
const JIRA_CREDS = [
  { key: 'site-url', label: 'Jira site', group: 'connection', requiredFor: ['interactive', 'automated'], required: true, secret: false },
  { key: 'email', label: 'Service-account e-mail', group: 'service-account', requiredFor: ['automated'], secret: false },
  { key: 'api-token', label: 'Service-account API token', group: 'service-account', requiredFor: ['automated'] },
];

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

test('fieldDescriptors: carries label / group / requiredFor and falls back to the key', () => {
  const [site, , plain] = fieldDescriptors([
    { key: 'site-url', label: 'Jira site', group: 'connection', requiredFor: ['interactive'] },
    { key: 'x', label: 'X', group: 'g' },
    { key: 'bare' },
  ], {});
  assert.equal(site.label, 'Jira site');
  assert.equal(site.group, 'connection');
  assert.deepEqual(site.requiredFor, ['interactive']);
  assert.equal(plain.label, 'bare'); // no manifest label → the key
  assert.equal(plain.group, '');
  assert.deepEqual(plain.requiredFor, []);
});

test('groupDescriptors: buckets fields by group in first-seen order with a necessity line', () => {
  const groups = groupDescriptors(JIRA_CREDS, {});
  assert.deepEqual(groups.map((g) => g.group), ['connection', 'service-account']);
  assert.equal(groups[0].heading, 'Connection');
  assert.equal(groups[0].necessity.tone, 'req');
  assert.match(groups[0].necessity.text, /Required for all use/);
  assert.equal(groups[1].heading, 'Service account');
  assert.equal(groups[1].necessity.tone, 'opt');
  assert.match(groups[1].necessity.text, /Only for automated runs/);
  assert.equal(groups[1].fields.length, 2);
});

test('groupHeading / groupNecessity: sensible fallbacks', () => {
  assert.equal(groupHeading('service-account'), 'Service account');
  assert.equal(groupHeading('some-other'), 'Some other'); // title-cased slug
  assert.equal(groupHeading(''), 'Settings');
  assert.equal(groupNecessity([{ requiredFor: ['interactive'] }]).tone, 'req');
  assert.equal(groupNecessity([{ requiredFor: [] }]).tone, 'opt');
  assert.equal(groupNecessity([{ required: true, requiredFor: [] }]).tone, 'req');
});

test('scopeStatusLabel: requiredFor-aware — honest connection vs service-account state', () => {
  // nothing set → not connected
  const none = { keys: {} };
  assert.match(scopeStatusLabel(none, JIRA_CREDS), /Not connected/);
  assert.equal(scopeStatusTone(none, JIRA_CREDS), 'muted');

  // site set, no service account → chat works, automation unavailable (non-blocking)
  const siteOnly = { keys: { 'site-url': { set: true } } };
  assert.match(scopeStatusLabel(siteOnly, JIRA_CREDS), /interactive chat works/i);
  assert.match(scopeStatusLabel(siteOnly, JIRA_CREDS), /Service account not set/);
  assert.equal(scopeStatusTone(siteOnly, JIRA_CREDS), 'ok');

  // everything set → automated ready
  const full = { setBy: 'alice', keys: { 'site-url': { set: true }, email: { set: true }, 'api-token': { set: true } } };
  assert.match(scopeStatusLabel(full, JIRA_CREDS), /automated runs ready/);
  assert.equal(scopeStatusTone(full, JIRA_CREDS), 'ok');
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

test('hasStoredCredential: any set key', () => {
  assert.equal(hasStoredCredential(null), false);
  assert.equal(hasStoredCredential({ keys: {} }), false);
  assert.equal(hasStoredCredential({ keys: { a: { set: false } } }), false);
  assert.equal(hasStoredCredential({ keys: { a: { set: false }, b: { set: true } } }), true);
});

test('clearConfirmation: names the team, the stored fields by label, and who set them (#2640)', () => {
  const creds = [
    { key: 'site-url', label: 'Jira site', secret: false },
    { key: 'email', label: 'Service-account e-mail', secret: false },
    { key: 'api-token', label: 'Service-account API token' },
  ];
  const scope = { scopeId: 'team-1', teamName: 'Team One', setBy: 'alice', keys: { 'site-url': { set: true }, 'api-token': { set: true, preview: '…abcd' } } };
  const c = clearConfirmation(scope, fieldDescriptors(creds, scope.keys), 'Jira');
  assert.equal(c.title, 'Clear the Jira credential for Team One?');
  assert.deepEqual(c.keys, ['Jira site', 'Service-account API token']); // the unset e-mail is not named
  assert.match(c.message, /removes Jira site, Service-account API token for Team One\./);
  assert.match(c.message, /last set by alice/);
  assert.match(c.message, /cannot restore/);

  // falls back to the scope id / generic wording
  const bare = clearConfirmation({ scopeId: 'team-9', keys: {} }, [], null);
  assert.equal(bare.title, 'Clear the plugin credential for team-9?');
  assert.match(bare.message, /every stored value/);
  assert.doesNotMatch(bare.message, /last set by/);
});

test('credentialTestTone / credentialTestLine: ok, neutral and failed checks (#2640)', () => {
  assert.equal(credentialTestTone(null), 'muted');
  assert.equal(credentialTestTone({ ok: true, state: 'connected' }), 'ok');
  assert.equal(credentialTestTone({ ok: true, state: 'site-reachable' }), 'ok');
  for (const state of ['not-configured', 'not-testable', 'unsupported']) assert.equal(credentialTestTone({ ok: false, state }), 'muted');
  for (const state of ['rejected', 'forbidden', 'not-found', 'unreachable', 'broker-unreachable', 'broker-error', 'inactive']) {
    assert.equal(credentialTestTone({ ok: false, state }), 'danger', state);
  }

  assert.equal(credentialTestLine(null), null);
  assert.equal(credentialTestLine({ ok: true, message: 'Connected as Bot.' }), 'Connected as Bot.');
  assert.equal(credentialTestLine({ ok: false, state: 'rejected', message: 'Token rejected (401).' }, { auto: true }), 'Token rejected (401).');
  // an automatic post-save check stays quiet when the plugin cannot test at all…
  assert.equal(credentialTestLine({ ok: false, state: 'not-testable', message: 'This plugin cannot test its credential.' }, { auto: true }), null);
  assert.equal(credentialTestLine({ ok: false, state: 'unsupported', message: 'x' }, { auto: true }), null);
  // …but an explicit click on Test connection says so
  assert.equal(credentialTestLine({ ok: false, state: 'not-testable', message: 'This plugin cannot test its credential.' }), 'This plugin cannot test its credential.');
});
