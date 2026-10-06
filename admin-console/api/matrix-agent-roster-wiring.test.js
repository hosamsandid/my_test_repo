'use strict';

// #566 wiring guard: GET /api/matrix/agents goes through the shared,
// single-flight roster cache (pure halves in matrix-agent-roster.js), and a
// successful roster-affecting console mutation clears it. Source-reading, like
// the other api.js guards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function routeBody(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found`);
  return API_SRC.slice(start, API_SRC.indexOf('\n});', start));
}

test('the roster route reads the fleet through the cache, never directly', () => {
  const r = routeBody("app.get('/api/matrix/agents',");
  assert.match(r, /await rosterCache\.getOrCompute\('roster', buildRoster\)/);
  assert.match(r, /projectRoster\(entries, scope, \{ includeDisabled, includeStubs \}, ROSTER_ACCESS\)/);
  assert.doesNotMatch(r, /listAgentDirs|readJsonFile|loadEnvironment|getAgentDmRoom/, 'no per-request sweep');
});

test('the cache TTL comes from AGENT_ROSTER_TTL_MS via the pure parser', () => {
  assert.match(API_SRC, /const ROSTER_CACHE_TTL_MS = rosterTtlMsFromEnv\(process\.env\);/);
  assert.match(API_SRC, /const rosterCache = createTtlCache\(\{ ttlMs: ROSTER_CACHE_TTL_MS, maxEntries: 1 \}\);/);
});

test('one build sweeps the fleet with every read injected', () => {
  const at = API_SRC.indexOf('function buildRoster() {');
  assert.ok(at > 0);
  const body = API_SRC.slice(at, API_SRC.indexOf('\n}\n', at));
  assert.match(body, /buildRosterEntries\(listAgentDirs\(\), \{/);
  for (const k of ['readConfig', 'readDmRoomId', 'readEnvironmentName', 'readPoolWaiting', 'onEntryError']) {
    assert.match(body, new RegExp(`${k}: `), k);
  }
  assert.match(body, /\n    agentMetaForScope,\n/, 'the scope meta is computed once, at build time');
  assert.match(body, /console\.error\(`\[Admin\] Chat roster skipped agent/, 'a skipped agent is logged');
});

test('a fleet-wide build failure answers a generic 500, the detail only in the server log', () => {
  const r = routeBody("app.get('/api/matrix/agents',");
  assert.match(r, /res\.status\(500\)\.json\(\{ error: 'Failed to read the agent roster' \}\)/);
  assert.doesNotMatch(r, /err\.message\}`? ?\}\)/, 'no raw error text to the client');
});

test('the console\'s own DM-room write clears the cache at the write site', () => {
  const at = API_SRC.indexOf('async function ensureAgentDmRoom(');
  assert.ok(at > 0);
  const body = API_SRC.slice(at, API_SRC.indexOf('\n}\n', at));
  assert.ok(body.indexOf('invalidateRosterCache();') > body.indexOf('matrix.setAgentDmRoom(agentId, {'));
});

test('a successful mutation clears the cache, mounted behind the auth gate and status-checked', () => {
  const at = API_SRC.indexOf("if (!mutationInvalidatesRoster(req.method, req.originalUrl)) return next();");
  assert.ok(at > 0, 'invalidation middleware missing');
  assert.ok(at > API_SRC.indexOf("app.use('/api', auth.gate);"), 'an unauthenticated request must not reach it');
  assert.ok(at < API_SRC.indexOf("app.get('/api/matrix/agents',"));
  const mw = API_SRC.slice(at, API_SRC.indexOf('\n});', at));
  assert.match(mw, /if \(res\.statusCode < 400\) invalidateRosterCache\(\);/,
    'decided on the final status, so a 4xx/5xx leaves the cache alone');
  // Hooked on the handler's own response, not on socket events: `close` on a
  // client abort fires before the write lands, and `finish` never fires after.
  assert.match(mw, /res\.end = function endAndInvalidateRoster\(\.\.\.args\) \{\n    res\.end = end;/, 'one decision per request');
  assert.match(mw, /return end\.apply\(this, args\);/);
  assert.doesNotMatch(mw, /res\.(once|on)\('(close|finish)'/);
  assert.match(API_SRC, /function invalidateRosterCache\(\) \{\n  rosterCache\.clear\(\);\n  agentStatusCache\.invalidate\(\);[^\n]*\n\}/);
});

test('the statuses cache TTL honours an explicit 0 like the roster one', () => {
  // #570: 2 s TTL → 5 s fresh + stale-while-revalidate (swr-cache.js).
  assert.match(API_SRC, /const STATUS_CACHE_TTL_MS = ttlMsFromEnv\(process\.env\.AGENT_STATUSES_TTL_MS, 5000\);/);
  assert.match(API_SRC, /const STATUS_CACHE_MAX_STALE_MS = ttlMsFromEnv\(process\.env\.AGENT_STATUSES_MAX_STALE_MS, 30_000\);/);
});
