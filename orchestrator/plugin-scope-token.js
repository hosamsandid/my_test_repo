'use strict';

// ─── plugin scope tokens (plugin system Phase 1, #1517) ──────────────────────
//
// Stateless per-scope identity tokens minted for a granted agent and verified
// by a plugin's broker sidecar on every call (docs/plugin-system-concept.md
// §4.6). Generalises the built-in podman-mcp `podman-token.js` — the payload
// now names both the plugin and the scope, so one signing secret can serve
// every plugin without cross-plugin token reuse.
//
// A token is `<pluginId>.<scopeId>.<base64url(HMAC-SHA256(secret, pluginId "\n" scopeId))>`.
// The broker verifies with the shared signing secret and derives {pluginId,
// scopeId} — no stored state. pluginId and scopeId must not contain '.' (ids
// here are alnum + -/_), so the three-field split is unambiguous.
//
// The token identity is the ONLY thing scope granularity changes: at `team`
// granularity a squad's members all mint the same scopeId (their team), at
// `agent` granularity each mints its own. Both go through this same code — see
// plugin-scope.js resolveScopeId.
//
// NOTE: a broker's own copy of this module (its Docker build context can't
// require across directories — the podman-token.js convention) must stay
// byte-identical to this file's mint/verify contract.

const crypto = require('crypto');

function sign(pluginId, scopeId, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${pluginId}\n${scopeId}`)
    .digest('base64url');
}

function mint(pluginId, scopeId, secret) {
  if (!pluginId || !scopeId || !secret) {
    throw new Error('mint requires pluginId, scopeId and secret');
  }
  if (String(pluginId).includes('.')) throw new Error('pluginId must not contain "."');
  if (String(scopeId).includes('.')) throw new Error('scopeId must not contain "."');
  return `${pluginId}.${scopeId}.${sign(pluginId, scopeId, secret)}`;
}

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

module.exports = { mint, verify };
