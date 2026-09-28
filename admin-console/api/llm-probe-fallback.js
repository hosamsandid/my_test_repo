// llm-probe-fallback.js — pure decision logic for the /v1/messages probe
// fallback (#2306): when /v1/models is unsupported (e.g. Azure AI Foundry),
// a minimal count_tokens POST classifies whether the endpoint is actually
// reachable and authenticated, instead of the probe declaring it broken.
// Kept free of network I/O so it is unit-testable without a mock server
// (api.js has no isolated harness — see the Helper Chat handler precedent).

'use strict';

// The intentionally-invalid model the count_tokens probe sends: no real
// inference ever runs, so a probe is free regardless of outcome. It is an
// internal implementation detail and must NEVER reach an operator (#2460 AC3) —
// api.js sends it, and redactProbePlaceholder scrubs it from any failure text.
const PROBE_PLACEHOLDER_MODEL = '__aee-probe-placeholder__';

// Stable machine codes for a probe verdict. The operator-facing, plain-language
// text lives in the frontend (llm-probe-state.js → probeResultMessage) so both
// "Test connection" and "Discover models" phrase the same code identically and
// the raw HTTP detail stays secondary (#2460 AC2). Kept here so the backend
// classifiers and the frontend renderer agree on one vocabulary.
const PROBE_REASON = Object.freeze({
  OK: 'ok',                    // reachable + authenticated
  AUTH: 'auth',                // 401/403 — credential rejected (AC5)
  UNREACHABLE: 'unreachable',  // network error / timeout / no HTTP status
  BASE_URL: 'base-url',        // route absent on a user-supplied Base URL
  HTTP_ERROR: 'http-error',    // any other unexpected non-2xx (5xx, …)
});

// Scrub the internal placeholder model id out of any operator-facing string
// (#2460 AC3). Anthropic echoes the requested model verbatim in a 404
// not_found_error body ("model: __aee-probe-placeholder__"), so without this the
// leak would surface in a failure detail. Replaced with a neutral phrase.
function redactProbePlaceholder(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.split(PROBE_PLACEHOLDER_MODEL).join('the connection-test model');
}

// A "route not supported" signal from the /v1/models probe — as opposed to an
// auth failure or a genuinely wrong Base URL, both of which surface on
// /v1/models too and need no fallback. 404 = no such route; 405 = route
// exists under a different method (both observed from real gateways).
function isRouteMissingStatus(status) {
  return status === 404 || status === 405;
}

// Does a count_tokens response body say "the model does not exist" (as opposed
// to "no such route")? Anthropic answers an unknown model on
// POST /v1/messages/count_tokens with 404 { error: { type: 'not_found_error',
// message: 'model: <id>' } } — the SAME status a wrong Base URL gives, so the
// body's error type is the only reliable discriminator on a user-supplied base.
function isUnknownModelBody(body) {
  const e = body && typeof body === 'object' ? body.error : null;
  const type = e && typeof e === 'object' ? e.type : null;
  return type === 'not_found_error';
}

// Reason code for a plain failure on the direct /v1/models GET probe (the path
// that does NOT fall back to count_tokens). A transport error carries no HTTP
// status; 401/403 is a rejected credential; 404/405 is a missing route / wrong
// Base URL; anything else is an unexpected HTTP error whose body is surfaced as
// the secondary detail (so an api-key proxy's "Budget exceeded" 400 still shows
// — #2460 AC7).
function httpFailureCode(result) {
  const status = result?.status;
  if (result?.error && !(Number.isFinite(status) && status >= 100)) return PROBE_REASON.UNREACHABLE;
  if (status === 401 || status === 403) return PROBE_REASON.AUTH;
  if (status === 404 || status === 405) return PROBE_REASON.BASE_URL;
  return PROBE_REASON.HTTP_ERROR;
}

// Classify the count_tokens fallback response. `result` is the raw
// { status, body, error } from httpPostJson against the intentionally-invalid
// placeholder model. `describeFailure(status, body)` renders a human-readable
// reason — injected so this module stays independent of api.js's copy.
// `opts.oauth` marks the subscription probe, whose Base URL is the FIXED
// api.anthropic.com (never operator-supplied), so its route always exists.
//   - transport error (no HTTP status)          → unreachable.
//   - 2xx / 400 (validation, e.g. unknown model) → reachable + authenticated.
//   - 401 / 403                                  → auth failure (AC5).
//   - 404 unknown-model (oauth base, or a
//     not_found_error body on any base)          → reachable + authenticated
//                                                   (auth got PAST the credential
//                                                   check; only the placeholder
//                                                   model is missing — #2460 AC4).
//   - 404 otherwise (route missing too)          → the Base URL is wrong.
//   - anything else (5xx, …)                     → surfaced as the failure.
function classifyMessagesFallback(result, describeFailure, opts = {}) {
  const oauth = Boolean(opts.oauth);
  const status = result?.status;
  const fail = (code) => ({ ok: false, code, error: result?.error || describeFailure(status, result?.body) });

  if (result?.error && !(Number.isFinite(status) && status >= 100)) {
    return { ok: false, code: PROBE_REASON.UNREACHABLE, error: result.error };
  }
  if (status === 400 || (status >= 200 && status < 300)) {
    return { ok: true, code: PROBE_REASON.OK, error: null };
  }
  if (status === 401 || status === 403) return fail(PROBE_REASON.AUTH);
  if (status === 404) {
    // Auth is validated before the model, so a 404 for our unknown placeholder
    // means the credential already passed — treat as reachable, not "Base URL
    // wrong" (#2460 AC4). Certain on the fixed OAuth base; on a user base only
    // when the body explicitly says not_found_error.
    if (oauth || isUnknownModelBody(result?.body)) return { ok: true, code: PROBE_REASON.OK, error: null };
    return fail(PROBE_REASON.BASE_URL);
  }
  return fail(PROBE_REASON.HTTP_ERROR);
}

// The system identity Claude Code itself sends. Included on the oauth-token
// /v1/messages probe so the request authenticates identically to real CLI
// traffic — subscription (OAuth) tokens are only honoured on the Claude Code
// messages flow, and enforcement can reject a request that doesn't present
// this identity before it ever validates the body. (The probe deliberately
// hits /v1/messages, not count_tokens: Anthropic accepts JWT/OAuth bearer
// tokens on messages but rejects them on count_tokens with "401 jwt auth is
// not yet supported on count_tokens".)
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
// `fallback` is the { ok, url, status, error } from the /v1/messages probe.
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
  return { error: fallback.error, url: fallback.url, status: fallback.status, reason: fallback.code };
}

module.exports = {
  PROBE_PLACEHOLDER_MODEL,
  PROBE_REASON,
  redactProbePlaceholder,
  isRouteMissingStatus,
  isUnknownModelBody,
  httpFailureCode,
  classifyMessagesFallback,
  OAUTH_PROBE_SYSTEM,
  isOauthAuthType,
  oauthDiscoverResult,
};
