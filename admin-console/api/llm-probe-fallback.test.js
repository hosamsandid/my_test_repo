'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isRouteMissingStatus,
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
  assert.deepEqual(out, { ok: true, error: null });
});

test('classifyMessagesFallback: 2xx is also reachable + authenticated', () => {
  const out = classifyMessagesFallback({ status: 200, body: {} }, describeFailure);
  assert.deepEqual(out, { ok: true, error: null });
});

test('classifyMessagesFallback: 401/403 is an auth failure', () => {
  assert.deepEqual(
    classifyMessagesFallback({ status: 401, body: null }, describeFailure),
    { ok: false, error: 'HTTP 401' },
  );
  assert.deepEqual(
    classifyMessagesFallback({ status: 403, body: null }, describeFailure),
    { ok: false, error: 'HTTP 403' },
  );
});

test('classifyMessagesFallback: 404 on messages too means the Base URL is wrong', () => {
  const out = classifyMessagesFallback({ status: 404, body: null }, describeFailure);
  assert.deepEqual(out, { ok: false, error: 'HTTP 404' });
});

test('classifyMessagesFallback: a transport error is surfaced verbatim, describeFailure not consulted', () => {
  const out = classifyMessagesFallback({ status: 0, body: null, error: 'timeout' }, describeFailure);
  assert.deepEqual(out, { ok: false, error: 'timeout' });
});

test('classifyMessagesFallback: 5xx is a genuine failure', () => {
  const out = classifyMessagesFallback({ status: 500, body: 'boom' }, describeFailure);
  assert.deepEqual(out, { ok: false, error: 'HTTP 500 — boom' });
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

test('oauthDiscoverResult: a failed probe surfaces the auth/reachability error verbatim', () => {
  const out = oauthDiscoverResult({ ok: false, url: 'https://api.anthropic.com/v1/messages/count_tokens', status: 401, error: 'HTTP 401 — invalid bearer token' });
  assert.deepEqual(out, {
    error: 'HTTP 401 — invalid bearer token',
    url: 'https://api.anthropic.com/v1/messages/count_tokens',
    status: 401,
  });
});
