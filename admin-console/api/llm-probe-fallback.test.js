'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('./llm-probe-fallback');

test('isRouteMissingStatus: 404 and 405 are route-missing', () => {
  assert.equal(isRouteMissingStatus(404), true);
  assert.equal(isRouteMissingStatus(405), true);
});

test('isRouteMissingStatus: other statuses are not', () => {
  assert.equal(isRouteMissingStatus(200), false);
  assert.equal(isRouteMissingStatus(401), false);
  assert.equal(isRouteMissingStatus(403), false);
  assert.equal(isRouteMissingStatus(500), false);
  assert.equal(isRouteMissingStatus(0), false);
  assert.equal(isRouteMissingStatus(undefined), false);
});

const describeFailure = (status, body) => `HTTP ${status}${body ? ` — ${body}` : ''}`;

test('classifyMessagesFallback: 400 (invalid placeholder model) is reachable + authenticated', () => {
  const out = classifyMessagesFallback({ status: 400, body: { error: { message: 'model: invalid' } } }, describeFailure);
  assert.deepEqual(out, { ok: true, code: PROBE_REASON.OK, error: null });
});

test('classifyMessagesFallback: 2xx is also reachable + authenticated', () => {
  const out = classifyMessagesFallback({ status: 200, body: {} }, describeFailure);
  assert.deepEqual(out, { ok: true, code: PROBE_REASON.OK, error: null });
});

test('classifyMessagesFallback: 401/403 is an auth failure', () => {
  assert.deepEqual(
    classifyMessagesFallback({ status: 401, body: null }, describeFailure),
    { ok: false, code: PROBE_REASON.AUTH, error: 'HTTP 401' },
  );
  assert.deepEqual(
    classifyMessagesFallback({ status: 403, body: null }, describeFailure),
    { ok: false, code: PROBE_REASON.AUTH, error: 'HTTP 403' },
  );
});

test('classifyMessagesFallback: 404 with no not_found body on a user base means the Base URL is wrong', () => {
  const out = classifyMessagesFallback({ status: 404, body: null }, describeFailure);
  assert.deepEqual(out, { ok: false, code: PROBE_REASON.BASE_URL, error: 'HTTP 404' });
});

test('classifyMessagesFallback: OAuth 404 (unknown placeholder model) is auth-OK, not a wrong Base URL (#2460 AC4)', () => {
  // Anthropic answers an unknown model on count_tokens with 404 not_found_error;
  // on the fixed api.anthropic.com base that means the token authenticated and
  // only the placeholder model is missing — a success, not a failure.
  const body = { type: 'error', error: { type: 'not_found_error', message: `model: ${PROBE_PLACEHOLDER_MODEL}` } };
  const out = classifyMessagesFallback({ status: 404, body }, describeFailure, { oauth: true });
  assert.deepEqual(out, { ok: true, code: PROBE_REASON.OK, error: null });
});

test('classifyMessagesFallback: a not_found_error 404 on a user base is also auth-OK (route exists, model missing)', () => {
  const body = { error: { type: 'not_found_error', message: 'model: foo' } };
  const out = classifyMessagesFallback({ status: 404, body }, describeFailure);
  assert.deepEqual(out, { ok: true, code: PROBE_REASON.OK, error: null });
});

test('classifyMessagesFallback: an expired OAuth token still fails with an auth code (#2460 AC5)', () => {
  const out = classifyMessagesFallback({ status: 401, body: null }, describeFailure, { oauth: true });
  assert.deepEqual(out, { ok: false, code: PROBE_REASON.AUTH, error: 'HTTP 401' });
});

test('classifyMessagesFallback: a transport error is surfaced verbatim as unreachable, describeFailure not consulted', () => {
  const out = classifyMessagesFallback({ status: 0, body: null, error: 'timeout' }, describeFailure);
  assert.deepEqual(out, { ok: false, code: PROBE_REASON.UNREACHABLE, error: 'timeout' });
});

test('classifyMessagesFallback: 5xx is a genuine http error', () => {
  const out = classifyMessagesFallback({ status: 500, body: 'boom' }, describeFailure);
  assert.deepEqual(out, { ok: false, code: PROBE_REASON.HTTP_ERROR, error: 'HTTP 500 — boom' });
});

test('redactProbePlaceholder: scrubs the internal placeholder model from any text (#2460 AC3)', () => {
  const raw = `HTTP 404 — model: ${PROBE_PLACEHOLDER_MODEL}`;
  const out = redactProbePlaceholder(raw);
  assert.equal(out.includes(PROBE_PLACEHOLDER_MODEL), false);
  assert.match(out, /connection-test model/);
  // Non-string / empty inputs pass through untouched.
  assert.equal(redactProbePlaceholder(null), null);
  assert.equal(redactProbePlaceholder(''), '');
});

test('isUnknownModelBody: only a not_found_error body counts', () => {
  assert.equal(isUnknownModelBody({ error: { type: 'not_found_error' } }), true);
  assert.equal(isUnknownModelBody({ error: { type: 'authentication_error' } }), false);
  assert.equal(isUnknownModelBody({ error: 'plain string' }), false);
  assert.equal(isUnknownModelBody(null), false);
  assert.equal(isUnknownModelBody('not json'), false);
});

test('httpFailureCode: maps a direct /v1/models failure to a reason code', () => {
  assert.equal(httpFailureCode({ status: 0, error: 'timeout' }), PROBE_REASON.UNREACHABLE);
  assert.equal(httpFailureCode({ status: 401 }), PROBE_REASON.AUTH);
  assert.equal(httpFailureCode({ status: 403 }), PROBE_REASON.AUTH);
  assert.equal(httpFailureCode({ status: 404 }), PROBE_REASON.BASE_URL);
  assert.equal(httpFailureCode({ status: 405 }), PROBE_REASON.BASE_URL);
  // A LiteLLM budget 400 is an unexpected HTTP error whose body is surfaced as
  // detail (#2460 AC7).
  assert.equal(httpFailureCode({ status: 400 }), PROBE_REASON.HTTP_ERROR);
  assert.equal(httpFailureCode({ status: 500 }), PROBE_REASON.HTTP_ERROR);
});

test('isOauthAuthType: only oauth-token is oauth, everything else (incl. legacy/empty) is api-key', () => {
  assert.equal(isOauthAuthType('oauth-token'), true);
  assert.equal(isOauthAuthType('api-key'), false);
  assert.equal(isOauthAuthType(''), false);
  assert.equal(isOauthAuthType(undefined), false);
  assert.equal(isOauthAuthType('bearer'), false);
});

test('OAUTH_PROBE_SYSTEM is the Claude Code identity the subscription API expects', () => {
  assert.equal(OAUTH_PROBE_SYSTEM, "You are Claude Code, Anthropic's official CLI for Claude.");
});

test('oauthDiscoverResult: a successful auth yields an empty, manual-entry model list', () => {
  const out = oauthDiscoverResult({ ok: true, url: 'https://api.anthropic.com/v1/messages/count_tokens', status: 400, error: null });
  assert.equal(out.count, 0);
  assert.deepEqual(out.models, []);
  assert.equal(out.noModelList, true);
  assert.equal(out.url, 'https://api.anthropic.com/v1/messages/count_tokens');
  assert.match(out.message, /enter the model name/i);
  assert.equal(out.error, undefined);
});

test('oauthDiscoverResult: a failed probe surfaces the auth/reachability error verbatim plus its reason code', () => {
  const out = oauthDiscoverResult({ ok: false, url: 'https://api.anthropic.com/v1/messages/count_tokens', status: 401, error: 'HTTP 401 — invalid bearer token', code: 'auth' });
  assert.deepEqual(out, {
    error: 'HTTP 401 — invalid bearer token',
    url: 'https://api.anthropic.com/v1/messages/count_tokens',
    status: 401,
    reason: 'auth',
  });
});
