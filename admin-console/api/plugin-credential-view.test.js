'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { visibleScopes, assertCanWriteScope, redactScopeForViewer, fieldType, shapePutBody } = require('./plugin-credential-view');

test('visibleScopes: keeps only scopes whose team the caller can see', () => {
  const scopes = [{ scopeId: 'team-a' }, { scopeId: 'team-b' }, { scopeId: 'team-c' }];
  const seen = new Set(['team-a', 'team-c']);
  assert.deepEqual(visibleScopes(scopes, (t) => seen.has(t)).map((s) => s.scopeId), ['team-a', 'team-c']);
});

test('assertCanWriteScope: Team Admin of that team only', () => {
  assert.deepEqual(assertCanWriteScope('team-a', (t) => t === 'team-a'), { ok: true });
  const denied = assertCanWriteScope('team-b', (t) => t === 'team-a');
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(assertCanWriteScope(null, () => true).status, 400);
});

test('redactScopeForViewer: strips value previews unless the caller can manage the scope', () => {
  const scope = {
    scopeId: 'team-a',
    setBy: 'alice', complete: true,
    keys: { 'api-token': { set: true, required: true, preview: 'AT…9xQ' }, 'site-url': { set: false, preview: null } },
  };
  // Team Admin — untouched.
  assert.equal(redactScopeForViewer(scope, true), scope);
  // Plain member — preview gone, everything else intact.
  const r = redactScopeForViewer(scope, false);
  assert.equal(r.keys['api-token'].preview, null);
  assert.equal(r.keys['api-token'].set, true);
  assert.equal(r.setBy, 'alice');
  assert.equal(scope.keys['api-token'].preview, 'AT…9xQ'); // original not mutated
});

test('redactScopeForViewer: a non-secret value is also stripped from a non-manager (#2449)', () => {
  const scope = {
    scopeId: 'team-a',
    keys: {
      'site-url': { set: true, secret: false, value: 'acme', preview: 'ac…me' },
      'api-token': { set: true, secret: true, preview: 'AT…9xQ' },
    },
  };
  // Team Admin sees everything.
  assert.equal(redactScopeForViewer(scope, true), scope);
  // Plain member: neither the preview nor the real non-secret value survives.
  const r = redactScopeForViewer(scope, false);
  assert.equal(r.keys['site-url'].value, null);
  assert.equal(r.keys['site-url'].preview, null);
  assert.equal(r.keys['site-url'].set, true); // structural metadata stays
  assert.equal(scope.keys['site-url'].value, 'acme'); // original not mutated
});

test('fieldType: secret-shaped keys → password, others → text', () => {
  assert.equal(fieldType('api-token'), 'password');
  assert.equal(fieldType('client-secret'), 'password');
  assert.equal(fieldType('site-url'), 'text');
  assert.equal(fieldType('email'), 'text');
});

test('shapePutBody: only declared string keys survive', () => {
  const r = shapePutBody({ values: { 'site-url': 'acme', junk: 'x', email: 5, 'api-token': 'tok' } }, ['site-url', 'email', 'api-token']);
  assert.deepEqual(r.values, { 'site-url': 'acme', 'api-token': 'tok' });
});

// #2640: the "Test connection" route spends the team's credential on one vendor
// read, so it carries the same Team-Admin gate as a write — asserted on the
// api.js source (the route is wiring; the gate itself is tested above).
test('POST /api/plugins/:id/credentials/:scopeId/test is Team-Admin gated before it reaches the orchestrator', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const start = src.indexOf("app.post('/api/plugins/:id/credentials/:scopeId/test'");
  assert.ok(start >= 0, 'the test route is registered');
  const body = src.slice(start, src.indexOf('\n});', start));
  const gateAt = body.indexOf('pluginCredView.assertCanWriteScope(scopeId, (t) => canManageTeam(getScope(req), t))');
  const fetchAt = body.indexOf('fetch(');
  assert.ok(gateAt >= 0, 'uses the write gate');
  assert.ok(body.includes('if (!gate.ok) return res.status(gate.status)'), 'a failed gate returns');
  assert.ok(fetchAt > gateAt, 'the gate runs before the orchestrator call');
  assert.match(body, /\/credentials\/\$\{encodeURIComponent\(scopeId\)\}\/test`/);
});
