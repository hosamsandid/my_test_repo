'use strict';

// ─── Broker SDK: scope-token verification (plugin system Phase 4, #1520) ─────
//
// A broker verifies the per-scope bearer token on every call and derives the
// caller's {pluginId, scopeId} — no stored state (docs/plugin-system-concept
// .md §4.6/§4.9). This is the generalised podman-mcp `podman-token.js`: the
// payload now names BOTH the plugin and the scope, so one signing secret can
// serve every plugin without cross-plugin token reuse.
//
// A token is `<pluginId>.<scopeId>.<base64url(HMAC-SHA256(secret, pluginId "\n"
// scopeId))>`. pluginId and scopeId must not contain '.' (ids here are alnum +
// -/_), so the three-field split is unambiguous.
//
// GRANULARITY-AGNOSTIC: verify returns only {pluginId, scopeId} — the broker
// never learns whether a scopeId denotes a team or a single agent, and MUST
// NOT branch on it. That opacity is exactly what stops agent granularity from
// doubling every broker's code path (§4.9).
//
// NOTE: the mint/verify contract here is byte-identical to the platform minter
// `orchestrator/plugin-scope-token.js` — a broker's Docker build context can't
// require across directories (the podman-token.js convention), so this SDK
// copy and the platform module must move together.

const crypto = require('crypto');

function sign(pluginId, scopeId, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${pluginId}\n${scopeId}`)
    .digest('base64url');
}

// Mint a token. Kept in the SDK (alongside verify) so a broker's own tests can
// forge/round-trip tokens without importing platform code, and so a broker
// that mints its own dev tokens has the one true implementation.
function mint(pluginId, scopeId, secret) {
  if (!pluginId || !scopeId || !secret) {
    throw new Error('mint requires pluginId, scopeId and secret');
  }
  if (String(pluginId).includes('.')) throw new Error('pluginId must not contain "."');
  if (String(scopeId).includes('.')) throw new Error('scopeId must not contain "."');
  return `${pluginId}.${scopeId}.${sign(pluginId, scopeId, secret)}`;
}

// Verify a raw token string → {pluginId, scopeId} or null. Uses a
// constant-time comparison and a strict length check so a forged/truncated
// signature can never authenticate.
function verify(token, secret) {
  if (typeof token !== 'string' || !secret) return null;
  const firstDot = token.indexOf('.');
  const lastDot = token.lastIndexOf('.');
  // Need two distinct separators, none of the three fields empty.
  if (firstDot <= 0 || lastDot <= firstDot + 1 || lastDot === token.length - 1) return null;
  const pluginId = token.slice(0, firstDot);
  const scopeId = token.slice(firstDot + 1, lastDot);
  const sig = token.slice(lastDot + 1);
  const expected = sign(pluginId, scopeId, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { pluginId, scopeId };
}

// Verify an `Authorization: Bearer <token>` header value → {pluginId, scopeId}
// or null. Every caller in this codebase builds the header as the literal
// template `Bearer ${token}` (single space, no variance), so a plain prefix
// check is sufficient and avoids a ReDoS-prone `/^Bearer\s+(.+)$/` regex on
// attacker-controlled header input (the podman-mcp scopeFromAuth lesson).
//
// Accepts either the raw header string or a Node request-like object with a
// `.headers` map, so a broker can pass `req` directly.
function verifyScopeToken(headerOrReq, secret) {
  let header = '';
  if (typeof headerOrReq === 'string') {
    header = headerOrReq;
  } else if (headerOrReq && headerOrReq.headers) {
    header = headerOrReq.headers['authorization'] || headerOrReq.headers['Authorization'] || '';
  }
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  if (!token) return null;
  return verify(token, secret);
}

module.exports = { mint, verify, verifyScopeToken };
