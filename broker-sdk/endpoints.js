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
// …plus the wrapper for a broker's ORCHESTRATOR-ONLY pushes (`internalPush
// Endpoint`, below): routes like `PUT /internal/scope-credentials` carry every
// scope's backend credential — and, for an event-source plugin, the host the
// poller will talk to — so they must accept the orchestrator's `_internal`
// token ONLY. Every granted agent holds a token minted with the same secret;
// "any valid token" on such a route lets one team wipe or repoint every other
// team's credential.
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

const { verifyScopeToken, INTERNAL_SCOPE_ID } = require('./scope-token');
const { buildInfoFromEnv } = require('./build-info');

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// GET health probe. `extra` (optional) is a sync/async function returning extra
// fields to merge into the `{ ok: true }` body (e.g. a backend reachability
// flag). A thrown/failed `extra` degrades to `{ ok: true, build }` — health must
// never hard-fail the probe over an optional detail.
//
// `build` (#2646) is the image's baked-in git identity (build-info.js), always
// present so the orchestrator can show which build the live sidecar really
// runs. `env` is injectable for tests only.
function healthEndpoint(extra = null, { env = process.env } = {}) {
  const build = buildInfoFromEnv(env);
  return async function handleHealth(_req, res) {
    let body = { ok: true, build };
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

// Wrap a handler for a route only the ORCHESTRATOR may call (a credential or
// registry push). The request must carry a token for THIS plugin whose scopeId
// is the reserved `_internal` sentinel — the orchestrator mints exactly that
// (`plugin-runtime.mintInternalToken`) and `resolveScopeId` refuses to derive it
// for any agent or team, so no granted workspace ever holds one.
//
// Contract:
//   • 401 if the token is missing/forged, names another plugin, or carries any
//     scopeId but `_internal` (handler never runs).
//   • otherwise `handler(req, res, { pluginId, scopeId })` — the handler writes
//     its own response; if it throws, a 500 is sent so the sidecar never crashes
//     on a push.
function internalPushEndpoint(handler, { secret, pluginId } = {}) {
  if (typeof handler !== 'function') throw new Error('internalPushEndpoint requires a handler(req, res, identity)');
  if (!secret) throw new Error('internalPushEndpoint requires the signing secret');
  if (!pluginId) throw new Error('internalPushEndpoint requires the broker\'s own pluginId');
  return async function handleInternalPush(req, res) {
    const v = verifyScopeToken(req, secret);
    if (!v || v.pluginId !== pluginId || v.scopeId !== INTERNAL_SCOPE_ID) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    try {
      await handler(req, res, v);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: (err && err.message) || String(err) });
    }
  };
}

module.exports = { healthEndpoint, teardownScopeEndpoint, internalPushEndpoint, INTERNAL_SCOPE_ID };
