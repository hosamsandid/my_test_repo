'use strict';

// Authentication for the webhook server (`POST /hooks/:agentId/:hookId`, #2680).
//
// A caller proves it knows the trigger's secret in one of two ways:
//
//   1. `X-Hook-Secret: <secret>` — the plain shared-secret header (curl, CI,
//      monitoring tools that can set custom headers).
//   2. `X-Hub-Signature-256: sha256=<hex>` — what a GitHub webhook sends when
//      the trigger's secret is stored as the webhook's "Secret": an HMAC-SHA256
//      of the raw request body keyed with the secret. GitHub cannot send custom
//      headers, so without this a GitHub webhook always got 401.
//
// Both comparisons are constant-time. A request that sends a header which does
// not match is rejected even if the other header would match — no fallthrough
// beyond "the first header present decides".

const crypto = require('crypto');

function constantTimeEqual(a, b) {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function githubSignature(secret, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody || Buffer.alloc(0)).digest('hex');
}

// `headers` are Node's lower-cased request headers; `rawBody` is the exact
// request body as a Buffer (the HMAC is over the bytes, not re-serialised JSON).
// Returns { ok: true, method: 'secret' | 'github-signature' } or
// { ok: false, reason }.
function verifyHookRequest({ headers, rawBody, secret }) {
  if (!secret) return { ok: false, reason: 'no-secret' };
  const h = headers || {};
  const plain = h['x-hook-secret'];
  if (typeof plain === 'string' && plain !== '') {
    return constantTimeEqual(plain, secret)
      ? { ok: true, method: 'secret' }
      : { ok: false, reason: 'bad-secret' };
  }
  const sig = h['x-hub-signature-256'];
  if (typeof sig === 'string' && sig !== '') {
    return constantTimeEqual(sig.trim().toLowerCase(), githubSignature(secret, rawBody))
      ? { ok: true, method: 'github-signature' }
      : { ok: false, reason: 'bad-signature' };
  }
  return { ok: false, reason: 'missing' };
}

// GitHub sends a `ping` delivery when a webhook is created or its settings are
// saved. It proves the wiring, but must not fire the trigger's prompt.
function isGithubPing(headers) {
  return String((headers || {})['x-github-event'] || '').toLowerCase() === 'ping';
}

module.exports = { verifyHookRequest, githubSignature, isGithubPing, constantTimeEqual };
