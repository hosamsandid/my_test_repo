'use strict';

// ─── Broker SDK: platform routes (plugin system Phase 4, #1520) ──────────────
//
// The two plain-REST routes the orchestrator calls on EVERY broker, distinct
// from the plugin's own MCP tool surface (§4.9):
//
//   • health   — the registry card's health probe (GET). No auth: it reveals
//                nothing and must answer even before any scope is granted.
//   • teardown — scope teardown on team/agent deletion (POST, per scopeId).
//                Bearer-authed so a forged scopeId can't reap another scope's
//                resources; because teardown is keyed on the opaque scopeId, ONE
//                implementation serves both team deletion and single-member
//                deletion at agent granularity (§4.9, granularity-agnostic).
//
// TEARDOWN ORDERING (§5 "plugin uninstalled with live owned resources"):
// resources are reaped BEFORE the token is invalidated. The orchestrator's
// delete cascade is: call this endpoint → on success, stop the sidecar and
// delete the scope's token/config. The broker therefore still holds a VALID
// token while reaping (it must — the reap runs podman against owned
// resources), and the caller only invalidates once this endpoint has returned
// the reaped set. If the order were reversed, an invalidated token would make
// the reap unauthenticated and leak the resources.
//
// Framework-agnostic: handlers take Node's raw `(req, res)`, matching the
// podman-mcp broker's `http.createServer` style, and are unit-testable with
// plain fake req/res objects.

const { verifyScopeToken } = require('./scope-token');

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// GET health probe. `extra` (optional) is a sync/async function returning extra
// fields to merge into the `{ ok: true }` body (e.g. a backend reachability
// flag). A thrown/failed `extra` degrades to `{ ok: true }` — health must never
// hard-fail the probe over an optional detail.
function healthEndpoint(extra = null) {
  return async function handleHealth(_req, res) {
    let body = { ok: true };
    if (typeof extra === 'function') {
      try {
        const more = await extra();
        if (more && typeof more === 'object') body = { ...body, ...more };
      } catch { /* keep the bare ok */ }
    }
    sendJson(res, 200, body);
  };
}

// POST teardown-scope. `reap(scopeId)` is the broker's best-effort resource
// cleanup — it must remove every resource owned by scopeId and return a summary
// (e.g. `{ removed, errors }`); it may be sync or async. `secret` is the shared
// signing secret used to verify the bearer token.
//
// Contract:
//   • 401 if the token is missing/forged (reap never runs).
//   • 200 `{ ok: true, ...summary }` once reap has completed — the signal the
//     orchestrator waits for before invalidating the token.
//   • 200 `{ ok: false, removed: [], errors: [...] }` if reap throws — teardown
//     is best-effort and must never surface as a hard failure to the delete
//     cascade (the caller logs it and proceeds).
function teardownScopeEndpoint(reap, { secret } = {}) {
  if (typeof reap !== 'function') throw new Error('teardownScopeEndpoint requires a reap(scopeId) handler');
  return async function handleTeardown(req, res) {
    const v = verifyScopeToken(req, secret);
    if (!v) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    let summary;
    try {
      summary = await reap(v.scopeId);
    } catch (err) {
      sendJson(res, 200, { ok: false, removed: [], errors: [{ error: (err && err.message) || String(err) }] });
      return;
    }
    sendJson(res, 200, { ok: true, ...(summary && typeof summary === 'object' ? summary : {}) });
  };
}

module.exports = { healthEndpoint, teardownScopeEndpoint };
