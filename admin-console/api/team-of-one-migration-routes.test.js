'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Source-reading guard for the team-of-one migration sweep routes (#2232,
// Phase C of epic #2229) — the operator-invoked replacement for the retired
// manual `POST /api/agents/:id/convert-to-team` action (#2052).
//
// api.js is a 15k-line Express app that cannot be imported in a unit test, so
// these are read off the source — the same technique `orphan-routes.test.js`
// uses for its own sibling sweep.
//
// The property that actually needs a guard is ORDER. Express matches routes
// in registration order, so `/api/agents/team-of-one-migration` placed after
// `/api/agents/:id` would be swallowed by the parameterised route and answer
// "Agent not found" instead of running the sweep.

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

const at = (needle) => {
  const i = SRC.indexOf(needle);
  assert.ok(i >= 0, `api.js should contain ${needle}`);
  return i;
};

test('the migration routes are registered ABOVE the parameterised /api/agents/:id', () => {
  const scan = at("app.get('/api/agents/team-of-one-migration'");
  const apply = at("app.post('/api/agents/team-of-one-migration/apply'");
  const byId = at("app.get('/api/agents/:id'");
  assert.ok(scan < byId, 'GET /api/agents/team-of-one-migration must precede GET /api/agents/:id');
  assert.ok(apply < byId, 'POST /api/agents/team-of-one-migration/apply must precede GET /api/agents/:id');
});

test('both migration routes are System-Admin gated', () => {
  // The sweep is installation-wide (every remaining standalone agent, across
  // every team), so it is not expressible as a team-scoped permission.
  const scan = at("app.get('/api/agents/team-of-one-migration'");
  const byId = at("app.get('/api/agents/:id'");
  const block = SRC.slice(scan, byId);
  assert.strictEqual(
    (block.match(/if \(!getScope\(req\)\.all\)/g) || []).length, 2,
    'each migration route must refuse a caller without full visibility',
  );
});

test('the apply route proxies the orchestrator rather than converting agents itself', () => {
  const apply = at("app.post('/api/agents/team-of-one-migration/apply'");
  const block = SRC.slice(apply, at("app.get('/api/agents/:id'"));
  assert.ok(block.includes('/internal/agents/team-of-one-migration/apply'),
    'the console must delegate to the orchestrator, which owns the conversion mechanics');
  assert.ok(!/planTeamConversion|assessConversionEligibility/.test(block),
    'the console must not re-implement the conversion decisions');
});

test('the apply route grants the caller team-admin on each newly-minted team', () => {
  // A `role: 'team'` agent is its own access boundary (#2078), so without this
  // membership the operator running the sweep could not see or manage the
  // teams it just made — the same guarantee the retired manual conversion and
  // the self-service team-create routes give their caller.
  const apply = at("app.post('/api/agents/team-of-one-migration/apply'");
  const block = SRC.slice(apply, at("app.get('/api/agents/:id'"));
  assert.ok(block.includes('planCreatorMembership('), 'must reuse planCreatorMembership');
  assert.ok(block.includes("callAdmin('POST', 'memberships'"), 'must write the membership');
});

test('the manual convert-to-team route is gone', () => {
  assert.ok(!SRC.includes("'/api/agents/:id/convert-to-team'"),
    'the manual per-agent conversion action is retired — the sweep replaces it');
});
