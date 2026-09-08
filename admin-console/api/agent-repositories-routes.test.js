'use strict';

// Guards the authorization boundary of the agent-scoped repository routes (#2067).
//
// AC12 is the whole reason these routes exist in the console at all: the
// orchestrator's `:4002` API is unauthenticated, so `canManageAgent` here is the
// ONLY thing standing between a chat-only user and cloning arbitrary code into
// someone else's agent container. The neighbouring `/api/agents/:id/workspace/*`
// routes carry no per-agent check (the ticket says so, and it is still true), so
// there is no ambient gate to fall back on and nothing in the surrounding file
// would fail if this one were dropped in a refactor.
//
// api.js cannot be `require`d in a unit test (it boots Express and reaches for
// the orchestrator), so this reads the routes' source — the same drift-guard
// technique `team-stream-materialize.test.js` uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/** Slice out one route's body, so a match elsewhere in the file can't fool us. */
function route(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return API_SRC.slice(start, end);
}

/** Comments name the very feature under test, so strip them before asserting. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function helper(name) {
  const start = API_SRC.indexOf(`function ${name}(`);
  assert.ok(start > 0, `helper ${name} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\n}\n', start);
  assert.ok(end > start, `could not find the end of ${name}`);
  return stripComments(API_SRC.slice(start, end));
}

const getRoute = () => stripComments(route("app.get('/api/agents/:id/repositories'"));
const postRoute = () => stripComments(route("app.post('/api/agents/:id/repositories'"));
const deleteRoute = () => stripComments(route("app.delete('/api/agents/:id/repositories'"));

test('all three routes exist and go through the one shared access resolver', () => {
  for (const [label, src] of [['GET', getRoute()], ['POST', postRoute()], ['DELETE', deleteRoute()]]) {
    assert.match(src, /resolveAgentRepoAccess\(req, req\.params\.id, \{ manage: (true|false) \}\)/, label);
    assert.match(src, /if \(access\.status\) return res\.status\(access\.status\)/, label);
  }
});

test('AC12: both mutations demand manage rights; only the read settles for visibility', () => {
  assert.match(postRoute(), /\{ manage: true \}/);
  assert.match(deleteRoute(), /\{ manage: true \}/);
  // The Workspace view lists repositories to a chat-only user — what that user
  // does not get is the action, not the information.
  assert.match(getRoute(), /\{ manage: false \}/);
});

test('the resolver enforces canManageAgent for manage and visibleAgent otherwise', () => {
  const src = helper('resolveAgentRepoAccess');
  assert.match(src, /AGENT_ID_RE\.test\(id\)/, 'id shape first');
  assert.match(src, /safeAgentPath\(id, 'config\.json'\)/, 'containment, not string concat');
  assert.match(src, /canManageAgent\(scope, meta\)/);
  assert.match(src, /status: 403/);
  assert.match(src, /visibleAgent\(scope, cfg\)/);
  // An invisible agent is a 404, not a 403: telling a stranger the agent exists
  // is itself a leak, and it is what every other scoped list route does.
  assert.match(src, /visibleAgent\(scope, cfg\)\)\s*\{\s*return \{ status: 404/);
});

test('D5: the attach body is whitelisted to the four card fields, never forwarded wholesale', () => {
  const src = postRoute();
  assert.match(src, /url:/);
  assert.match(src, /branch:/);
  assert.match(src, /sshKeyId:/);
  assert.match(src, /readOnly: b\.readOnly === true/);
  // A spread would carry a client-supplied credential straight into the config.
  assert.doesNotMatch(src, /\.\.\.b\b/, 'no wholesale body spread');
  assert.doesNotMatch(src, /\.\.\.req\.body/, 'no wholesale body spread');
});

test('the console re-words no refusal — the orchestrator status and message are relayed', () => {
  const src = helper('proxyAgentRepositories');
  // On a refusal the orchestrator's body is passed through untouched; only a
  // successful body is augmented (with `canManage`, which the orchestrator
  // cannot know).
  assert.match(src, /res\.status\(resp\.status\)\.json\(resp\.ok \? \{ \.\.\.payload, \.\.\.extra \} : payload\)/);
  assert.match(src, /res\.status\(502\)/, 'an unreachable orchestrator is honestly a 502');
});

test('a clone-running mutation uses heavyLimiter, like the sync routes next door', () => {
  assert.match(postRoute(), /app\.post\('\/api\/agents\/:id\/repositories', heavyLimiter/);
  assert.match(deleteRoute(), /app\.delete\('\/api\/agents\/:id\/repositories', heavyLimiter/);
  assert.match(getRoute(), /app\.get\('\/api\/agents\/:id\/repositories', apiLimiter/);
});
