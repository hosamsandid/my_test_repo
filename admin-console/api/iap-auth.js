'use strict';

// Google Cloud IAP identity bridge (SSO follow-up to #276).
//
// When the console runs behind an Identity-Aware Proxy, every request carries
// a signed JWT in the `x-goog-iap-jwt-assertion` header identifying the
// Google-authenticated user. This module verifies that JWT so auth.js can
// treat its `email` claim as an authenticated principal — the login form then
// never appears behind IAP.
//
// The signature check is mandatory: the plain X-Goog-Authenticated-User-Email
// header is spoofable by anything that can reach the pod directly (in-cluster
// traffic bypasses the load balancer), so only the ES256-signed assertion,
// verified against Google's published keys and pinned to THIS backend
// service's audience, may authenticate a request.
//
// Enabled only when auth.js is given an audience (env IAP_AUDIENCE, format
// `/projects/<project-number>/global/backendServices/<service-id>`). Without
// it the bridge is inert and the password login is the only path — the
// compose and kind stacks never set it.

const crypto = require('crypto');

const IAP_JWT_HEADER = 'x-goog-iap-jwt-assertion';
const IAP_ISSUER = 'https://cloud.google.com/iap';
// PEM-format endpoint; the JWK endpoint (public_key-jwks) has been retired.
const KEYS_URL = 'https://www.gstatic.com/iap/verify/public_key';
const KEYS_TTL_MS = 12 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;

// Returns { kid: "-----BEGIN PUBLIC KEY-----\n..." } — EC public keys in PEM.
async function defaultFetchKeys() {
  const resp = await fetch(KEYS_URL);
  if (!resp.ok) throw new Error(`IAP key fetch failed: HTTP ${resp.status}`);
  return resp.json();
}

function decodeSegment(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Returns an async `verify(token, now) -> { sub } | null` closure holding a
// JWKS cache. Keys are refreshed when stale or when an unknown kid appears
// (Google rotates them); a failed refresh keeps serving the stale set rather
// than locking everyone out.
function makeIapVerifier({ audience, fetchKeys = defaultFetchKeys } = {}) {
  let cache = { keys: null, at: 0 };

  async function keyFor(kid, now) {
    const stale = !cache.keys || now - cache.at >= KEYS_TTL_MS;
    if (stale || !cache.keys.has(kid)) {
      try {
        const pems = await fetchKeys();
        const keys = new Map();
        for (const [kid, pem] of Object.entries(pems || {})) {
          if (!kid || typeof pem !== 'string') continue;
          try {
            keys.set(kid, crypto.createPublicKey({ key: pem, format: 'pem' }));
          } catch {
            // skip unparsable keys
          }
        }
        cache = { keys, at: now };
      } catch {
        // refresh failed — fall through to whatever we still have
      }
    }
    return cache.keys ? cache.keys.get(kid) : undefined;
  }

  return async function verifyIapJwt(token, now = Date.now()) {
    if (!audience || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const header = decodeSegment(parts[0]);
    const payload = decodeSegment(parts[1]);
    // alg is pinned to ES256 — the only algorithm IAP uses; anything else
    // (none, HS256, ...) is an attack, not a configuration.
    if (!header || header.alg !== 'ES256' || typeof header.kid !== 'string') return null;
    if (!payload) return null;

    const key = await keyFor(header.kid, now);
    if (!key) return null;

    let signatureOk = false;
    try {
      signatureOk = crypto.verify(
        'sha256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        { key, dsaEncoding: 'ieee-p1363' }, // JOSE ES256 signatures are raw r||s
        Buffer.from(parts[2], 'base64url')
      );
    } catch {
      return null;
    }
    if (!signatureOk) return null;

    if (payload.iss !== IAP_ISSUER) return null;
    if (payload.aud !== audience) return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < now - CLOCK_SKEW_MS) return null;
    if (typeof payload.iat === 'number' && payload.iat * 1000 > now + CLOCK_SKEW_MS) return null;

    const email = typeof payload.email === 'string' && payload.email.includes('@') ? payload.email : null;
    if (!email) return null;
    return { sub: email };
  };
}

module.exports = { makeIapVerifier, IAP_JWT_HEADER, IAP_ISSUER };
