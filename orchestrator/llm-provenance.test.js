'use strict';

// Unit tests for the pure Model-Provider provenance env-block assembler (#980).
// Run: node --test orchestrator/llm-provenance.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLlmProvenanceEnv, sanitizeBaseUrl } = require('./llm-provenance');

// A resolved binding as returned by resolveLlmBindingForAgent.
const apiKeyBinding = {
  endpointId: 'db-endpoint',
  name: 'DB',
  authType: 'api-key',
  baseUrl: 'https://llm.example.com/v1',
  token: 'sk-super-secret-should-never-leak',
  defaultModelId: 'claude-opus-4-8',
};

const oauthBinding = {
  endpointId: 'sub-endpoint',
  name: 'My Subscription',
  authType: 'oauth-token',
  baseUrl: '', // stripped for oauth — direct to api.anthropic.com
  token: 'oauth-secret-token',
  defaultModelId: 'claude-sonnet-5',
};

test('api-key binding: full provenance, requested = binding default', () => {
  const out = buildLlmProvenanceEnv(apiKeyBinding, {}, { endpointConfigured: true });
  assert.equal(out.AEE_LLM_BINDING, 'bound');
  assert.equal(out.AEE_LLM_PROVIDER_ID, 'db-endpoint');
  assert.equal(out.AEE_LLM_PROVIDER_NAME, 'DB');
  assert.equal(out.AEE_LLM_AUTH_TYPE, 'api-key');
  assert.equal(out.AEE_LLM_BASE_URL, 'https://llm.example.com/v1');
  assert.equal(out.AEE_LLM_REQUESTED_MODEL, 'claude-opus-4-8');
});

test('oauth-token binding: no base URL recorded, auth type carried', () => {
  const out = buildLlmProvenanceEnv(oauthBinding, {}, { endpointConfigured: true });
  assert.equal(out.AEE_LLM_BINDING, 'bound');
  assert.equal(out.AEE_LLM_AUTH_TYPE, 'oauth-token');
  assert.equal(out.AEE_LLM_PROVIDER_NAME, 'My Subscription');
  // oauth talks to api.anthropic.com directly — no proxy base URL to show.
  assert.equal(out.AEE_LLM_BASE_URL, undefined);
  assert.equal(out.AEE_LLM_REQUESTED_MODEL, 'claude-sonnet-5');
});

test('agent modelOverride wins over the binding default for the requested model', () => {
  const out = buildLlmProvenanceEnv(apiKeyBinding, { modelOverride: 'opus-latest' },
    { endpointConfigured: true });
  assert.equal(out.AEE_LLM_REQUESTED_MODEL, 'opus-latest');
});

test('no binding, no endpoint configured → env-fallback', () => {
  const out = buildLlmProvenanceEnv(null, {}, { endpointConfigured: false });
  assert.equal(out.AEE_LLM_BINDING, 'env-fallback');
  assert.equal(out.AEE_LLM_PROVIDER_NAME, undefined);
  assert.equal(out.AEE_LLM_BASE_URL, undefined);
  assert.equal(out.AEE_LLM_REQUESTED_MODEL, undefined);
});

test('no binding but an endpoint WAS configured → missing (distinct from env-fallback)', () => {
  const out = buildLlmProvenanceEnv(null, {}, { endpointConfigured: true });
  assert.equal(out.AEE_LLM_BINDING, 'missing');
  assert.equal(out.AEE_LLM_PROVIDER_NAME, undefined);
});

test('modelOverride is recorded even on a .env fallback (no provider)', () => {
  const out = buildLlmProvenanceEnv(null, { modelOverride: 'haiku-4-5' },
    { endpointConfigured: false });
  assert.equal(out.AEE_LLM_BINDING, 'env-fallback');
  assert.equal(out.AEE_LLM_REQUESTED_MODEL, 'haiku-4-5');
});

test('AC8: no credential material is emitted for api-key or oauth bindings', () => {
  for (const b of [apiKeyBinding, oauthBinding]) {
    const out = buildLlmProvenanceEnv(b, {}, { endpointConfigured: true });
    const blob = JSON.stringify(out);
    assert.ok(!blob.includes(b.token), 'token must not appear');
    assert.ok(!/token/i.test(Object.keys(out).join(',')), 'no *token* key');
  }
});

test('provider display name falls back to the endpoint id when unnamed', () => {
  const out = buildLlmProvenanceEnv(
    { ...apiKeyBinding, name: undefined }, {}, { endpointConfigured: true });
  assert.equal(out.AEE_LLM_PROVIDER_NAME, 'db-endpoint');
});

// --- sanitizeBaseUrl (AC8) ------------------------------------------------

test('sanitizeBaseUrl strips userinfo and query string', () => {
  assert.equal(
    sanitizeBaseUrl('https://user:pass@llm.example.com/v1?key=secret'),
    'https://llm.example.com/v1');
});

test('sanitizeBaseUrl strips a fragment', () => {
  assert.equal(sanitizeBaseUrl('https://llm.example.com/v1#frag'),
    'https://llm.example.com/v1');
});

test('sanitizeBaseUrl on a non-URL best-effort strips userinfo/query by hand', () => {
  assert.equal(sanitizeBaseUrl('llm.example.com/v1?token=x'), 'llm.example.com/v1');
  assert.equal(sanitizeBaseUrl(''), '');
  assert.equal(sanitizeBaseUrl(null), '');
});

test('AC8: a base URL carrying an embedded credential is scrubbed in the env block', () => {
  const out = buildLlmProvenanceEnv(
    { ...apiKeyBinding, baseUrl: 'https://user:pw@llm.example.com/v1?k=sk-leak' },
    {}, { endpointConfigured: true });
  assert.equal(out.AEE_LLM_BASE_URL, 'https://llm.example.com/v1');
  assert.ok(!JSON.stringify(out).includes('sk-leak'));
});
