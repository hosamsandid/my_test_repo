'use strict';

// Where the session-cookie HMAC key comes from (#2059).
//
// Before #2059, an unset `AUTH_SESSION_SECRET` derived the key from
// `${ADMIN_USERNAME}:${ADMIN_PASSWORD}`. That was defensible while the same pair
// WAS the login: a deployment still running the shipped `admin`/`admin` default
// was already wide open, so a guessable signing key added no exposure. It stops
// being defensible the moment the login password lives in a user record — an
// operator who sets a strong password on the Users page but leaves
// `ADMIN_PASSWORD=admin` in `.env` would then have an unguessable password and a
// *guessable* signing key, and a forged `aee_session` cookie is a login by
// another route. AC4 admits no exception, so the derivation had to go.
//
// Precedence:
//   1. `AUTH_SESSION_SECRET` — an operator-set key. Unchanged, and still the way
//      to rotate every session deliberately.
//   2. A 32-byte random key persisted once on the shared workspace volume at
//      0600. Stable across restarts like the old derivation was, unguessable
//      unlike it, and requires no configuration.
//   3. A process-random key, when that volume is unwritable. Sessions then stop
//      surviving a restart — which fails SAFE (everyone re-authenticates) rather
//      than open (a predictable key).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SECRET_FILE = '/workspace/auth/session-secret';

// Returns `{ secret, source }`. `source` is 'env' | 'file' | 'file-created' |
// 'ephemeral', which the caller logs once at boot so an operator can tell a
// restart-surviving stack from one that will sign everybody out on restart.
function resolveSessionSecret({ env = process.env, file = DEFAULT_SECRET_FILE } = {}) {
  const configured = typeof env.AUTH_SESSION_SECRET === 'string' ? env.AUTH_SESSION_SECRET.trim() : '';
  if (configured) return { secret: configured, source: 'env' };

  const stored = readSecret(file);
  if (stored) return { secret: stored, source: 'file' };

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // `wx` fails rather than truncating: if another process wrote a key between
    // our read and this write, clobbering it would silently invalidate every
    // session that key had already signed.
    fs.writeFileSync(file, `${generated}\n`, { mode: 0o600, flag: 'wx' });
    // `mode` is masked by umask, so restate it — this file is a signing key.
    fs.chmodSync(file, 0o600);
    return { secret: generated, source: 'file-created' };
  } catch {
    // Lost the create race? Prefer the winner's key over our own, so two
    // console processes on one volume agree about which cookies are valid.
    const raced = readSecret(file);
    if (raced) return { secret: raced, source: 'file' };
    return { secret: generated, source: 'ephemeral' };
  }
}

function readSecret(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw || null;
  } catch {
    return null; // not created yet, or unreadable
  }
}

module.exports = { resolveSessionSecret, DEFAULT_SECRET_FILE };
