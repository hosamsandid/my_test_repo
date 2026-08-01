import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemInitView, authTypeLabel } from './system-init.js';

// (a) Full provenance for an api-key binding: compact row shows model, provider
// and auth; expand detail carries the endpoint + both models + session.
test('full provenance: compact + detail (AC3)', () => {
  const v = buildSystemInitView({
    type: 'system_init',
    model: 'claude-opus-4-8',
    sessionId: 'c6686462-5e2f',
    provenance: {
      binding: 'bound',
      providerId: 'db-endpoint',
      providerName: 'DB',
      authType: 'api-key',
      baseUrl: 'https://llm.example.com/v1',
      requestedModel: 'claude-opus-4-8',
    },
  });
  assert.equal(v.legacy, false);
  assert.equal(v.model, 'claude-opus-4-8');
  assert.equal(v.providerText, 'DB · API key');   // reuses toolbar vocabulary
  assert.equal(v.requestedModel, null);            // equal → not shown (AC4)
  assert.equal(v.sessionId, 'c6686462-5e2f');
  const detail = Object.fromEntries(v.detail);
  assert.equal(detail.Provider, 'DB');
  assert.equal(detail.Auth, 'API key');
  assert.equal(detail.Endpoint, 'https://llm.example.com/v1');
  assert.equal(detail['Effective model'], 'claude-opus-4-8');
});

// (b) Legacy row (no provenance): renders exactly as pre-#980 (AC6) — no
// provider text, no detail, never a retrofitted current binding.
test('legacy row without provenance renders bare (AC6)', () => {
  const v = buildSystemInitView({
    type: 'system_init',
    model: 'claude-opus-4-8',
    sessionId: 'old-session',
  });
  assert.equal(v.legacy, true);
  assert.equal(v.providerText, null);
  assert.equal(v.requestedModel, null);
  assert.equal(v.detail, null);
  assert.equal(v.model, 'claude-opus-4-8');
  assert.equal(v.sessionId, 'old-session');
});

// (c) Requested ≠ effective model: the difference is made explicit (AC4).
test('requested != effective model is surfaced', () => {
  const v = buildSystemInitView({
    type: 'system_init',
    model: 'claude-opus-4-8',
    sessionId: 's',
    provenance: {
      binding: 'bound',
      providerName: 'DB',
      authType: 'api-key',
      baseUrl: 'https://x/v1',
      requestedModel: 'opus-latest',
    },
  });
  assert.equal(v.requestedModel, 'opus-latest');
  const detail = Object.fromEntries(v.detail);
  assert.equal(detail['Requested model'], 'opus-latest');
  assert.equal(detail['Effective model'], 'claude-opus-4-8');
});

// (d) .env fallback: named, not blank (AC5).
test('.env fallback is named Default (.env)', () => {
  const v = buildSystemInitView({
    type: 'system_init',
    model: 'claude-opus-4-8',
    sessionId: 's',
    provenance: {
      binding: 'env-fallback',
      providerName: null,
      authType: null,
      baseUrl: null,
      requestedModel: null,
    },
  });
  assert.equal(v.legacy, false);          // still a new-runtime row
  assert.equal(v.providerText, 'Default (.env)');
  const detail = Object.fromEntries(v.detail);
  assert.equal(detail.Provider, 'Default (.env)');
});

// AC5: a configured-but-unresolvable endpoint is distinct from a .env fallback.
test('missing binding is distinct from env fallback', () => {
  const v = buildSystemInitView({
    type: 'system_init',
    model: 'claude-opus-4-8',
    sessionId: 's',
    provenance: { binding: 'missing', providerName: null, authType: null },
  });
  assert.equal(v.providerText, 'Provider unresolved (.env)');
  const detail = Object.fromEntries(v.detail);
  assert.equal(detail.Provider, 'Unresolved endpoint');
});

// oauth-token binding uses the "Subscription" vocabulary and has no endpoint.
test('oauth-token binding reads as Subscription', () => {
  const v = buildSystemInitView({
    type: 'system_init',
    model: 'claude-sonnet-5',
    sessionId: 's',
    provenance: {
      binding: 'bound',
      providerName: 'My Sub',
      authType: 'oauth-token',
      baseUrl: null,
      requestedModel: 'claude-sonnet-5',
    },
  });
  assert.equal(v.providerText, 'My Sub · Subscription');
  const detail = Object.fromEntries(v.detail);
  assert.equal(detail.Endpoint, '—');
});

test('authTypeLabel matches the chat-toolbar vocabulary', () => {
  assert.equal(authTypeLabel(null), 'Default (.env)');
  assert.equal(authTypeLabel('oauth-token'), 'Subscription');
  assert.equal(authTypeLabel('api-key'), 'API key');
});
