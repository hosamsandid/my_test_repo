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

// The system identity Claude Code itself sends. Included on the oauth-token
// count_tokens probe so the request authenticates identically to real CLI
// traffic — subscription (OAuth) tokens are only honoured on the Claude Code
// messages flow, and enforcement can reject a request that doesn't present
// this identity before it ever validates the body.
const OAUTH_PROBE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

// Subscription-OAuth tokens (Claude Max/Enterprise via `claude setup-token`)
// authenticate the Claude Code tooling flow — /v1/messages with the
// `anthropic-beta: oauth-2025-04-20` header — but are NOT accepted on the
// /v1/models list route, which always demands a raw `x-api-key` and answers a
// bare Bearer OAuth token with 401 "invalid x-api-key" (#2448). So an
// oauth-token provider can never enumerate models over HTTP; its Test
// connection / Discover models must probe the messages endpoint instead.
function isOauthAuthType(authType) {
  return authType === 'oauth-token';
}

// Shape a Discover-models response for an oauth-token provider from the
// messages-probe outcome. OAuth can't list /v1/models, so a successful auth
// yields an empty, manual-entry model list (mirroring the #2306 noModelList
// contract); a failed probe surfaces the auth/reachability error verbatim.
// `fallback` is the { ok, url, status, error } from the count_tokens probe.
function oauthDiscoverResult(fallback) {
  if (fallback.ok) {
    return {
      url: fallback.url,
      count: 0,
      models: [],
      noModelList: true,
      message: 'A subscription (OAuth) provider does not expose a model list — enter the model name(s) manually.',
    };
  }
  return { error: fallback.error, url: fallback.url, status: fallback.status };
}

module.exports = {
  isRouteMissingStatus,
  classifyMessagesFallback,
  OAUTH_PROBE_SYSTEM,
  isOauthAuthType,
  oauthDiscoverResult,
};
