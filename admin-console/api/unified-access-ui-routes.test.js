'use strict';

// Source-shape guard for PR7's backend enforcement + governance route (#2360).
// api.js boots on require and cannot be imported; this reads its source (the
// tiered-resource-routes.test.js technique).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function routeBody(opening) {
  const start = SRC.indexOf(opening);
  assert.ok(start > 0, `'${opening}' not found — re-point this guard`);
  const end = SRC.indexOf('\napp.', start + opening.length);
  assert.ok(end > start, `end of '${opening}' not found`);
  return SRC.slice(start, end);
}

// ── oauth-not-team enforcement (deferred from PR2, gated) ───────────────────

test('POST /api/llm-endpoints refuses a team-shared subscription behind the flag', () => {
  const body = routeBody("app.post('/api/llm-endpoints'");
  assert.match(
    body,
    /if \(RESOURCE_ACCESS_V2 && isOauth && !globalGate\.global && ownership\.scope !== 'personal'\)/,
    'a subscription must be personal or global, never team-shared — only behind the flag',
  );
  assert.match(body, /code: 'oauth-not-team'/);
});

test('PUT /api/llm-endpoints applies the same oauth rule to the effective auth type', () => {
  const body = routeBody("app.put('/api/llm-endpoints/:id'");
  assert.match(body, /if \(RESOURCE_ACCESS_V2 && isOauth && !globalGate\.global && ownership\.scope !== 'personal'\)/);
  assert.match(body, /code: 'oauth-not-team'/);
});

// ── governance: the masked personal-resources view ─────────────────────────

test('GET /api/admin/personal-resources is flag-gated, System-Admin-only, and masked', () => {
  const body = routeBody("app.get('/api/admin/personal-resources'");
  assert.match(body, /if \(!RESOURCE_ACCESS_V2\)/, 'dark when the unified model is off');
  assert.match(body, /if \(!scope\.all\)/, 'System-Admin-only');
  assert.match(body, /listPersonalResources\(\{/);
  // The masking is delegated to the pure module — the route must not hand-build
  // a record that could leak a token/baseUrl.
  assert.doesNotMatch(body, /authTokenId|baseUrl|privateKey/, 'the route must not touch secret-bearing fields');
});
