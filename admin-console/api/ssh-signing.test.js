'use strict';

// #2938: signing identity on stored SSH keys. Run: node --test ssh-signing.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseSigningInput, applySigning, publicKeyFromBlob, EMAIL_RE } = require('./ssh-signing');

test('parseSigningInput: keep / clear / set / reject', () => {
  assert.deepEqual(parseSigningInput(undefined), { action: 'keep' });
  assert.deepEqual(parseSigningInput(null), { action: 'clear' });
  assert.deepEqual(parseSigningInput(false), { action: 'clear' });
  assert.deepEqual(parseSigningInput({ name: ' Bot ', email: ' bot@example.com ' }),
    { action: 'set', signing: { name: 'Bot', email: 'bot@example.com' } });
  assert.match(parseSigningInput('x').error, /object/);
  assert.match(parseSigningInput({ email: 'a@b.co' }).error, /name/);
  assert.match(parseSigningInput({ name: 'A\nB', email: 'a@b.co' }).error, /line breaks/);
  assert.match(parseSigningInput({ name: 'A' }).error, /email/);
  assert.match(parseSigningInput({ name: 'A', email: 'nope' }).error, /valid email/);
  assert.match(parseSigningInput({ name: 'A', email: 'a@b.co\n-c x' }).error, /valid email/);
});

test('applySigning sets, clears and keeps without mutating', () => {
  const e = { id: 'k', name: 'K' };
  const set = applySigning(e, parseSigningInput({ name: 'A', email: 'a@b.co' }));
  assert.deepEqual(set.signing, { name: 'A', email: 'a@b.co' });
  assert.equal(e.signing, undefined);
  assert.equal(applySigning(set, { action: 'keep' }), set);
  assert.equal('signing' in applySigning(set, { action: 'clear' }), false);
});

test('publicKeyFromBlob renders the authorized_keys form', () => {
  const type = Buffer.from('ssh-ed25519');
  const len = Buffer.alloc(4); len.writeUInt32BE(type.length);
  const key = crypto.randomBytes(32);
  const klen = Buffer.alloc(4); klen.writeUInt32BE(32);
  const blob = Buffer.concat([len, type, klen, key]);
  assert.equal(publicKeyFromBlob(blob), `ssh-ed25519 ${blob.toString('base64')}`);
  assert.equal(publicKeyFromBlob(Buffer.from([0, 0, 0, 99])), null);
  assert.equal(publicKeyFromBlob(null), null);
});

test('the email rule is the orchestrator runtime rule (they must not drift)', () => {
  const runtime = require('../../orchestrator/commit-signing');
  assert.equal(EMAIL_RE.source, runtime.EMAIL_RE.source);
  // and the name rule: the runtime rejects exactly what this module rejects.
  for (const name of ['A\nB', 'a<b', 'x'.repeat(101)]) {
    assert.ok(parseSigningInput({ name, email: 'a@b.co' }).error);
    assert.equal(runtime.signingIdentityOf({ signing: { name, email: 'a@b.co' } }), null);
  }
});

test('api.js wires signing into create, generate and PATCH and lists the public key', () => {
  const src = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const routes = ["app.post('/api/ssh-keys',", "app.post('/api/ssh-keys/generate',", "app.patch('/api/ssh-keys/:id',"];
  for (const r of routes) {
    const start = src.indexOf(r);
    assert.ok(start > 0, `${r} not found`);
    const body = src.slice(start, src.indexOf('\n});', start));
    assert.match(body, /parseSigningInput\(req\.body\?\.signing\)/, `${r} must accept signing`);
  }
  const list = src.slice(src.indexOf("app.get('/api/ssh-keys',"), src.indexOf("app.post('/api/ssh-keys',"));
  assert.match(list, /withSigningPublicKey/);
});
