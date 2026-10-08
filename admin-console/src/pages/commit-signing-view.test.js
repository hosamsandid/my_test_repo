// #2938: commit-signing view helpers. Run: node --test src/pages/commit-signing-view.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signingFormValue, signingFormError, signingPayload, signingCell, signingRecommendation,
  signingScopesPresent, describeEffectiveSigning, SIGNING_SETUP_HREF, SIGNING_UPLOAD_HINT,
} from './commit-signing-view.js';

const signer = { id: 'k', scope: 'team', signing: { name: 'Bot', email: 'bot@corp.com' } };

test('form value, validation and payload (create omits, edit clears)', () => {
  assert.deepEqual(signingFormValue(signer), { enabled: true, name: 'Bot', email: 'bot@corp.com' });
  assert.deepEqual(signingFormValue(null, { enabled: true }), { enabled: true, name: '', email: '' });
  assert.equal(signingFormError({ enabled: false }), null);
  assert.match(signingFormError({ enabled: true, name: '', email: 'a@b.co' }), /name/);
  assert.match(signingFormError({ enabled: true, name: 'A<', email: 'a@b.co' }), /</);
  assert.match(signingFormError({ enabled: true, name: 'A', email: 'x' }), /valid email/);
  assert.equal(signingFormError({ enabled: true, name: 'A', email: 'a@b.co' }), null);
  assert.deepEqual(signingPayload({ enabled: true, name: ' A ', email: ' a@b.co ' }), { name: 'A', email: 'a@b.co' });
  assert.equal(signingPayload({ enabled: false }), undefined);
  assert.equal(signingPayload({ enabled: false }, { previous: signer.signing }), null);
});

test('table cell names the commit identity', () => {
  assert.equal(signingCell(signer).label, 'Signs as Bot <bot@corp.com>');
  assert.equal(signingCell({ id: 'x' }), null);
});

test('recommendation shows only while no visible key signs, names enforcement and links to setup', () => {
  const r = signingRecommendation([{ id: 'deploy', scope: 'team' }]);
  assert.match(r.text, /recommended/);
  assert.match(r.text, /mandatory/);
  assert.match(r.text, /2026-10-23/);
  assert.equal(r.href, SIGNING_SETUP_HREF);
  assert.equal(signingRecommendation([signer]), null);
  assert.match(signingRecommendation([], { context: 'github' }).text, /tokens/);
  assert.match(signingRecommendation(null, { context: 'team' }).text, /team/);
});

test('scopes present map system to global', () => {
  assert.deepEqual(signingScopesPresent([signer, { scope: 'system', signing: { email: 'a@b.co' } }, { scope: 'personal' }]), ['team', 'global']);
});

test('upload hint says Signing Key and verified email', () => {
  assert.match(SIGNING_UPLOAD_HINT, /Signing Key/);
  assert.match(SIGNING_UPLOAD_HINT, /verified email/);
});

test('effective signing row per source', () => {
  assert.equal(describeEffectiveSigning({ source: 'none' }).tone, 'warning');
  assert.match(describeEffectiveSigning({ source: 'team', credential: { id: 'k', name: 'Bot key' }, identity: { name: 'Bot', email: 'b@c.co' } }).detail, /Bot <b@c.co>/);
  assert.match(describeEffectiveSigning({ source: 'personal', owner: { label: 'Alice', isYou: false } }).headline, /Alice/);
  assert.match(describeEffectiveSigning({ source: 'personal', owner: { isYou: true }, credential: { id: 'mine' } }).headline, /Your personal/);
  assert.match(describeEffectiveSigning({ source: 'global' }).headline, /Global/);
});
