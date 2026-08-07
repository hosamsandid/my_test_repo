'use strict';

// Stateless per-scope tokens for the built-in Podman MCP server. A token is
// `<scopeId>.<base64url(HMAC-SHA256(secret, scopeId))>`. The podman-mcp
// service verifies it with the shared signing secret and derives the scope —
// no stored state. scopeId must not contain '.' (ids here are alnum + -/_).
//
// NOTE: orchestrator/podman-token.js and admin-console/api/podman-token.js
// are byte-identical copies of this file (each service has its own Docker
// build context, so a cross-directory require doesn't resolve at runtime).
// Change all three in one commit.
const crypto = require('crypto');

function sign(scopeId, secret) {
  return crypto.createHmac('sha256', secret).update(String(scopeId)).digest('base64url');
}

function mint(scopeId, secret) {
  if (!scopeId || !secret) throw new Error('mint requires scopeId and secret');
  if (String(scopeId).includes('.')) throw new Error('scopeId must not contain "."');
  return `${scopeId}.${sign(scopeId, secret)}`;
}

function verify(token, secret) {
  if (typeof token !== 'string' || !secret) return null;
  const idx = token.indexOf('.');
  if (idx <= 0 || idx === token.length - 1) return null;
  const scopeId = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(scopeId, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { scopeId };
}

module.exports = { mint, verify };
