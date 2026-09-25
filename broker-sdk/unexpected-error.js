'use strict';

// ─── Broker SDK: unexpected-error containment (§4.9) ─────────────────────────
//
// Every broker terminates its `http.createServer` in the same obligation: an
// UNEXPECTED throw (an `fs` failure in a store, a `JSON` parse deep in a
// handler, a programming slip) must not answer the caller with the exception's
// own message. Those messages carry filesystem paths and, on a parse failure, a
// window of the offending body — a browser-reachable information leak (CodeQL
// js/stack-trace-exposure, alert 22 on netzplan's `store.load()`).
//
// The split is: the OPERATOR keeps the detail (one `console.error`, collected
// by plugin-broker-logs.yml), the CLIENT gets a generic sentence.
//
// This lived as a six-way copy-pasted clone across the reference brokers, of
// which exactly one had been fixed — so it lives here once instead, next to the
// health + teardown routes it sits beside in every broker's tail
// (docs/plugin-system-concept.md §4.9).
//
// NOT a licence to generify every error: a message that IS the operational
// answer — an agent-facing tool error, a Team-Admin-facing import failure —
// stays as it is. This handler is only for the throw nobody wrote a catch for.
//
// Framework-agnostic, matching endpoints.js: a raw `(req, res)` listener,
// unit-testable with plain fake req/res objects.

// withUnexpectedErrors(logTag, handler) → a (req, res) listener for
// http.createServer. `handler` is the broker's own `handleRequest` (sync or
// async); `logTag` is the broker's log prefix, passed explicitly rather than
// derived because the tags are NOT uniform — five brokers log
// `[<pluginId>-broker]` but podman-sandbox logs `[podman-mcp]`, and deriving it
// would silently rename a log stream that plugin-broker-logs.yml collects.
function withUnexpectedErrors(logTag, handler) {
  if (typeof handler !== 'function') throw new Error('withUnexpectedErrors requires a handler(req, res)');
  return function listener(req, res) {
    // Both arms of the same containment: a rejected promise AND a synchronous
    // throw before the handler ever returns one. The inline form this replaced
    // only caught the rejection.
    const fail = (err) => {
      console.error(`[${logTag}] unhandled:`, err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      try { res.end(JSON.stringify({ error: 'internal error' })); } catch { /* ignore */ }
    };
    let out;
    try {
      out = handler(req, res);
    } catch (err) {
      fail(err);
      return;
    }
    if (out && typeof out.catch === 'function') out.catch(fail);
  };
}

module.exports = { withUnexpectedErrors };
