// llm-probe-fallback.js — pure decision logic for the /v1/messages probe
// fallback (#2306): when /v1/models is unsupported (e.g. Azure AI Foundry),
// a minimal count_tokens POST classifies whether the endpoint is actually
// reachable and authenticated, instead of the probe declaring it broken.
// Kept free of network I/O so it is unit-testable without a mock server
// (api.js has no isolated harness — see the Helper Chat handler precedent).

'use strict';

// A "route not supported" signal from the /v1/models probe — as opposed to an
// auth failure or a genuinely wrong Base URL, both of which surface on
// /v1/models too and need no fallback. 404 = no such route; 405 = route
// exists under a different method (both observed from real gateways).
function isRouteMissingStatus(status) {
  return status === 404 || status === 405;
}

// Classify the count_tokens fallback response. `result` is the raw
// { status, body, error } from httpPostJson against an intentionally-invalid
// placeholder model (no real inference ever runs, so this is free regardless
// of outcome). `describeFailure(status, body)` renders a human-readable
// reason — injected so this module stays independent of api.js's copy.
//   - 2xx / 400 (validation, e.g. unknown model) → reachable + authenticated.
//   - 401 / 403                                  → auth failure.
//   - 404 (messages route missing too)           → the Base URL is wrong.
//   - anything else (network error, 5xx, ...)     → surfaced as the failure.
function classifyMessagesFallback(result, describeFailure) {
  const status = result?.status;
  const ok = status === 400 || (status >= 200 && status < 300);
  return {
    ok,
    error: ok ? null : (result?.error || describeFailure(status, result?.body)),
  };
}

module.exports = { isRouteMissingStatus, classifyMessagesFallback };
