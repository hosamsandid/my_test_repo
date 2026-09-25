'use strict';

// Source-shape guard for the resource-migration routes (#2359). The classifier
// is unit-tested (resource-migration.test.js); this pins that the routes (a) are
// gated behind AEE_RESOURCE_ACCESS_V2 AND System-Admin, (b) the report is
// read-only over the three stores, and (c) the apply persists each store and
// never auto-runs. api.js boots on require and cannot be imported, so this reads
// its source (the tiered-resource-routes.test.js technique).
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

test('GET /api/resource-migration is flag-gated, System-Admin-only, and read-only over the three stores', () => {
  const body = routeBody("app.get('/api/resource-migration'");
  assert.match(body, /if \(!RESOURCE_ACCESS_V2\)/, 'must 404 when the unified model is off (dark)');
  assert.match(body, /if \(!scope\.all\)/, 'must be System-Admin-only');
  assert.match(body, /resourceMigration\.planResourceMigration\(\{/);
  assert.match(body, /providers: listLlmEndpoints\(\)/);
  assert.match(body, /sshKeys: listSshKeys\(\)/);
  assert.match(body, /githubTokens: listGithubTokens\(\)/);
  // Read-only: the report route must not write any store.
  assert.doesNotMatch(body, /save(LlmEndpointsIndex|SshKeysIndex|GithubTokensIndex)\(/, 'the report must not mutate any store');
});

test('POST /api/resource-migration/apply is flag-gated, System-Admin-only, decision-driven, and persists each store', () => {
  const body = routeBody("app.post('/api/resource-migration/apply'");
  assert.match(body, /if \(!RESOURCE_ACCESS_V2\)/);
  assert.match(body, /if \(!scope\.all\)/);
  assert.match(body, /req\.body && req\.body\.decisions/, 'nothing applies without an explicit decisions[] body');
  assert.match(body, /resourceMigration\.applyMigrationDecision\(d\.kind, /);
  // Saves each store exactly once, only when dirty.
  assert.match(body, /if \(store\.dirty\) store\.save\(store\.list\)/);
  assert.match(body, /saveLlmEndpointsIndex/);
  assert.match(body, /saveSshKeysIndex/);
  assert.match(body, /saveGithubTokensIndex/);
});
