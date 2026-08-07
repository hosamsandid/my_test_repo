'use strict';

// Unit tests for the IAP identity bridge. Run: node --test admin-console/api/iap-auth.test.js
//
// Tokens are forged locally with a generated P-256 keypair and verified
// against a fake key endpoint (kid → PEM, like Google's public_key endpoint)
// — no network, no Google.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { makeIapVerifier, IAP_ISSUER } = require('./iap-auth');

const AUDIENCE = '/projects/594390336049/global/backendServices/1234567890';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const otherPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

function pem(key) {
  return key.export({ type: 'spki', format: 'pem' });
}

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function signToken({ header, payload, key = privateKey }) {
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

const NOW = 1700000000000;

function validToken(overrides = {}, headerOverrides = {}) {
  return signToken({
    header: { alg: 'ES256', typ: 'JWT', kid: 'key-1', ...headerOverrides },
    payload: {
      iss: IAP_ISSUER,
      aud: AUDIENCE,
      iat: Math.floor(NOW / 1000) - 60,
      exp: Math.floor(NOW / 1000) + 600,
      sub: 'accounts.google.com:1234567890',
      email: 'k.zyskowski@accenture.com',
      ...overrides,
    },
  });
}

function verifier(extraOpts = {}) {
  return makeIapVerifier({
    audience: AUDIENCE,
    fetchKeys: async () => ({ 'key-1': pem(publicKey) }),
    ...extraOpts,
  });
}

test('accepts a valid IAP assertion and returns the email as subject', async () => {
  const principal = await verifier()(validToken(), NOW);
  assert.deepEqual(principal, { sub: 'k.zyskowski@accenture.com' });
});

test('rejects a token signed by a different key', async () => {
  const forged = signToken({
    header: { alg: 'ES256', typ: 'JWT', kid: 'key-1' },
    payload: {
      iss: IAP_ISSUER,
      aud: AUDIENCE,
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 600,
      email: 'attacker@evil.example',
    },
    key: otherPair.privateKey,
  });
  assert.equal(await verifier()(forged, NOW), null);
});

test('rejects a tampered payload with the original signature', async () => {
  const token = validToken();
  const [h, , sig] = token.split('.');
  const swapped = `${h}.${b64({
    iss: IAP_ISSUER,
    aud: AUDIENCE,
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 600,
    email: 'attacker@evil.example',
  })}.${sig}`;
  assert.equal(await verifier()(swapped, NOW), null);
});

test('rejects wrong audience, wrong issuer, and missing email', async () => {
  const v = verifier();
  assert.equal(await v(validToken({ aud: '/projects/1/global/backendServices/2' }), NOW), null);
  assert.equal(await v(validToken({ iss: 'https://evil.example' }), NOW), null);
  assert.equal(await v(validToken({ email: undefined }), NOW), null);
  assert.equal(await v(validToken({ email: 'not-an-email' }), NOW), null);
});

test('rejects expired and not-yet-issued tokens', async () => {
  const v = verifier();
  assert.equal(await v(validToken({ exp: Math.floor(NOW / 1000) - 3600 }), NOW), null);
  assert.equal(await v(validToken({ iat: Math.floor(NOW / 1000) + 3600 }), NOW), null);
  // Within clock skew still passes.
  assert.ok(await v(validToken({ iat: Math.floor(NOW / 1000) + 10 }), NOW));
});

test('pins the algorithm to ES256', async () => {
  const v = verifier();
  // alg=none with an empty signature must never authenticate.
  const noneToken = `${b64({ alg: 'none', typ: 'JWT', kid: 'key-1' })}.${b64({
    iss: IAP_ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(NOW / 1000) + 600,
    email: 'attacker@evil.example',
  })}.`;
  assert.equal(await v(noneToken, NOW), null);
  // HS256 signed with a "secret" the server might leak elsewhere.
  assert.equal(await v(validToken({}, { alg: 'HS256' }), NOW), null);
});

test('rejects unknown kid and garbage input', async () => {
  const v = verifier();
  assert.equal(await v(validToken({}, { kid: 'unknown-key' }), NOW), null);
  assert.equal(await v('not.a.jwt', NOW), null);
  assert.equal(await v('', NOW), null);
  assert.equal(await v(null, NOW), null);
});

test('is inert without an audience', async () => {
  const v = makeIapVerifier({ fetchKeys: async () => ({ 'key-1': pem(publicKey) }) });
  assert.equal(await v(validToken(), NOW), null);
});

test('caches keys and survives a failing refresh', async () => {
  let calls = 0;
  const v = makeIapVerifier({
    audience: AUDIENCE,
    fetchKeys: async () => {
      calls += 1;
      if (calls > 1) throw new Error('key endpoint down');
      return { 'key-1': pem(publicKey) };
    },
  });
  assert.ok(await v(validToken(), NOW));
  assert.ok(await v(validToken(), NOW), 'second verify served from cache');
  assert.equal(calls, 1);
  // Past the TTL the refresh fails — the stale keys must keep working.
  const later = NOW + 13 * 60 * 60 * 1000;
  assert.ok(await v(validToken({ exp: Math.floor(later / 1000) + 600 }), later));
  assert.equal(calls, 2);
});
