'use strict';

// Unit tests for the SSH-key / GitHub-token input validation (#2654), plus a
// source guard that the create/rotate routes in api.js actually call it.
// Run: node --test admin-console/api/credential-input.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  credentialName, isValidNewCredentialId, sshPrivateKeyError,
} = require('./credential-input');

// ── fixtures ────────────────────────────────────────────────────────────
// Keys are generated per run (no secret-looking literals in the repo). The
// OpenSSH builder frames an ed25519 key per PROTOCOL.key and lets a test
// corrupt one field at a time.
function sshString(buf) {
  const len = Buffer.alloc(4); len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}
function uint32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }

function opensshEd25519({ check2Delta = 0, privType = 'ssh-ed25519', cipher = 'none', trailing = Buffer.alloc(0), pad = true } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const pubBlob = Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(pub)]);
  const check = 0x12345678;
  let priv = Buffer.concat([
    uint32(check), uint32(check + check2Delta),
    sshString(Buffer.from(privType)), sshString(pub),
    sshString(Buffer.concat([seed, pub])), sshString(Buffer.from('test')),
  ]);
  if (pad) {
    const padding = [];
    for (let i = 1; (priv.length + padding.length) % 8 !== 0; i++) padding.push(i);
    priv = Buffer.concat([priv, Buffer.from(padding)]);
  }
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString(Buffer.from(cipher)), sshString(Buffer.from(cipher === 'none' ? 'none' : 'bcrypt')),
    sshString(Buffer.alloc(0)), uint32(1), sshString(pubBlob), sshString(priv), trailing,
  ]);
  const b64 = body.toString('base64').match(/.{1,70}/g).join('\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function pem(type, opts) {
  return crypto.generateKeyPairSync(type, { ...opts, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
}

// ── credentialName ──────────────────────────────────────────────────────
test('credentialName trims a real name and rejects blank / non-string ones', () => {
  assert.equal(credentialName('  My key  '), 'My key');
  assert.equal(credentialName('   '), null);
  assert.equal(credentialName(''), null);
  assert.equal(credentialName(123), null);
  assert.equal(credentialName(undefined), null);
  assert.equal(credentialName(['a']), null);
});

// ── isValidNewCredentialId ──────────────────────────────────────────────
test('isValidNewCredentialId accepts hyphen-separated slugs', () => {
  for (const id of ['a', 'key1', 'uitest-q02-gen', 'a-b-c']) assert.equal(isValidNewCredentialId(id), true, id);
});

test('isValidNewCredentialId rejects edge / doubled hyphens and other chars', () => {
  for (const id of ['-', 'uitest-q02-gen-', '-lead', 'a--b', '', 'A', 'a_b', 'a b', '../x']) {
    assert.equal(isValidNewCredentialId(id), false, id);
  }
  assert.equal(isValidNewCredentialId(7), false);
});

// ── sshPrivateKeyError ──────────────────────────────────────────────────
test('a well-formed OpenSSH ed25519 key is accepted', () => {
  assert.equal(sshPrivateKeyError(opensshEd25519()), null);
});

test('legacy PEM keys (PKCS#1 RSA, SEC1 EC, PKCS#8) are accepted', () => {
  assert.equal(sshPrivateKeyError(pem('rsa', { modulusLength: 1024, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } })), null);
  assert.equal(sshPrivateKeyError(pem('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'sec1', format: 'pem' } })), null);
  assert.equal(sshPrivateKeyError(pem('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })), null);
});

test('a passphrase-protected key is accepted (the passphrase is not ours to check)', () => {
  const enc = pem('rsa', {
    modulusLength: 1024,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' },
  });
  assert.match(enc, /ENCRYPTED PRIVATE KEY/);
  assert.equal(sshPrivateKeyError(enc), null);
  const legacyEnc = pem('rsa', {
    modulusLength: 1024,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' },
  });
  assert.match(legacyEnc, /Proc-Type: 4,ENCRYPTED/);
  assert.equal(sshPrivateKeyError(legacyEnc), null);
  // An encrypted OpenSSH key: the private section is opaque, only the framing is checked.
  assert.equal(sshPrivateKeyError(opensshEd25519({ cipher: 'aes256-ctr', check2Delta: 1 })), null);
});

test('garbage between the OpenSSH armour lines is rejected (the #2654 repro)', () => {
  const err = sshPrivateKeyError('-----BEGIN OPENSSH PRIVATE KEY-----\n<any text>\n-----END OPENSSH PRIVATE KEY-----');
  assert.match(err, /not a valid SSH private key/);
  assert.match(sshPrivateKeyError('-----BEGIN OPENSSH PRIVATE KEY-----\nQUJDRA==\n-----END OPENSSH PRIVATE KEY-----'), /not an OpenSSH key/);
  assert.match(sshPrivateKeyError('-----BEGIN OPENSSH PRIVATE KEY-----\n-----END OPENSSH PRIVATE KEY-----'), /not base64/);
});

test('garbage in a legacy PEM is rejected', () => {
  assert.match(sshPrivateKeyError('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'), /could not be parsed/);
});

test('a missing END line / text without any key marker is rejected', () => {
  const key = opensshEd25519();
  assert.match(sshPrivateKeyError(key.replace('-----END OPENSSH PRIVATE KEY-----', '')), /BEGIN\/END/);
  assert.match(sshPrivateKeyError('hello'), /not an SSH private key/);
  assert.match(sshPrivateKeyError(42), /not an SSH private key/);
});

test('a truncated OpenSSH key is rejected', () => {
  const lines = opensshEd25519().split('\n');
  lines.splice(2, 1); // drop one base64 line from the middle
  assert.match(sshPrivateKeyError(lines.join('\n')), /not a valid SSH private key/);
});

test('corrupt OpenSSH private sections are rejected', () => {
  assert.match(sshPrivateKeyError(opensshEd25519({ check2Delta: 1 })), /corrupt/);
  assert.match(sshPrivateKeyError(opensshEd25519({ privType: 'ssh-rsa' })), /does not match its public key/);
  assert.match(sshPrivateKeyError(opensshEd25519({ trailing: Buffer.from([1, 2, 3]) })), /unexpected data/);
});

test('an unpadded OpenSSH private section is rejected', () => {
  // Unpadded, the section is 4+4+15+36+68+8 = 135 bytes — not a multiple of 8.
  assert.match(sshPrivateKeyError(opensshEd25519({ pad: false })), /malformed/);
});

// ── source guard: the routes use the helpers ────────────────────────────
// api.js has no route-level harness; guard that each create/rotate site calls
// the validator (mutation-check: drop any call below and a test fails).
const API = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function routeBody(signature) {
  const start = API.indexOf(signature);
  assert.notEqual(start, -1, `route not found: ${signature}`);
  const next = API.indexOf('\napp.', start + signature.length);
  return API.slice(start, next === -1 ? undefined : next);
}

test('POST /api/ssh-keys validates name, id and key content', () => {
  const body = routeBody("app.post('/api/ssh-keys', ");
  assert.match(body, /const name = credentialName\(req\.body\?\.name\);\s*if \(!name\) return res\.status\(400\)/);
  assert.match(body, /const keyError = sshPrivateKeyError\(trimmed\);\s*if \(keyError\) return res\.status\(400\)/);
  assert.match(body, /!isValidNewCredentialId\(id\)\) return res\.status\(400\)/);
});

test('POST /api/ssh-keys/generate validates name and id', () => {
  const body = routeBody("app.post('/api/ssh-keys/generate', ");
  assert.match(body, /const name = credentialName\(req\.body\?\.name\);\s*if \(!name\) return res\.status\(400\)/);
  assert.match(body, /!isValidNewCredentialId\(id\)\) return res\.status\(400\)/);
});

test('POST /api/ssh-keys/:id/rotate validates a pasted key', () => {
  const body = routeBody("app.post('/api/ssh-keys/:id/rotate', ");
  assert.match(body, /const keyError = sshPrivateKeyError\(trimmed\);\s*if \(keyError\) return res\.status\(400\)/);
});

test('POST /api/github-tokens validates name and id', () => {
  const body = routeBody("app.post('/api/github-tokens', ");
  assert.match(body, /const name = credentialName\(req\.body\?\.name\);\s*if \(!name\) return res\.status\(400\)/);
  assert.match(body, /!isValidNewCredentialId\(id\)\) return res\.status\(400\)/);
});

test('no route keeps the marker-only private-key check', () => {
  assert.doesNotMatch(API, /does not look like an SSH private key/);
});
