'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Source-reading guard for the orphan scan/cleanup routes (#1960).
//
// api.js is a 15k-line Express app that cannot be imported in a unit test, so
// these are read off the source — the same technique
// `team-stream-materialize.test.js` uses.
//
// The property that actually needs a guard is ORDER. Express matches routes in
// registration order, so `/api/agents/orphans` placed after `/api/agents/:id`
// would be swallowed by the parameterised route and answer "Agent not found"
// instead of running the scan. Nothing else in the codebase would notice: the
// endpoint would simply, silently, stop working. (`/api/agents/statuses` has the
// same constraint and the same fix.)

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

const at = (needle) => {
  const i = SRC.indexOf(needle);
  assert.ok(i >= 0, `api.js should contain ${needle}`);
  return i;
};

test('the orphan routes are registered ABOVE the parameterised /api/agents/:id', () => {
  const scan = at("app.get('/api/agents/orphans'");
  const cleanup = at("app.post('/api/agents/orphans/cleanup'");
  const byId = at("app.get('/api/agents/:id'");
  assert.ok(scan < byId, 'GET /api/agents/orphans must precede GET /api/agents/:id');
  assert.ok(cleanup < byId, 'POST /api/agents/orphans/cleanup must precede GET /api/agents/:id');
});

// The team-of-one migration sweep (#2232) sits between the orphan cleanup and
// `/api/agents/:id` too — same reasoning, same shape — so these guards slice
// only up to that sibling block rather than all the way to `:id`.
const migrationScan = () => at("app.get('/api/agents/team-of-one-migration'");

test('both orphan routes are System-Admin gated', () => {
  // The scan is installation-wide and the cleanup deletes agents across every
  // team; neither is expressible as a team-scoped permission, so a missing gate
  // here is a real privilege hole rather than a cosmetic one.
  const scan = at("app.get('/api/agents/orphans'");
  const cleanup = at("app.post('/api/agents/orphans/cleanup'");
  const block = SRC.slice(scan, migrationScan());
  assert.strictEqual(
    (block.match(/if \(!getScope\(req\)\.all\)/g) || []).length, 2,
    'each orphan route must refuse a caller without full visibility',
  );
  assert.ok(SRC.slice(cleanup, migrationScan()).includes("if (!getScope(req).all)"),
    'the cleanup route in particular must be gated');
});

test('the cleanup proxies the orchestrator rather than deleting agents itself', () => {
  const cleanup = at("app.post('/api/agents/orphans/cleanup'");
  const block = SRC.slice(cleanup, migrationScan());
  assert.ok(block.includes('/internal/agents/orphans/cleanup'),
    'the console must delegate to the orchestrator, which owns agent teardown');
  assert.ok(!/fs\.rm|rmSync/.test(block), 'the console must not remove agent files itself');
});

test('DELETE /api/agents/:id relays the cascade warnings instead of always answering 204', () => {
  const del = at("app.delete('/api/agents/:id'");
  const block = SRC.slice(del, at("app.post('/api/agents/:id/clone'"));
  assert.ok(block.includes('cascadeWarnings'),
    'a member the cascade could not remove must reach the caller (AC2)');
  assert.ok(block.includes('res.status(204).end()'),
    'a clean delete must still answer a bare 204, so existing callers are unaffected');
});
