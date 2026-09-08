'use strict';

// Guards the #1501 fix on the two Model-Provider bound-agent routes.
//
// The leak: `GET /api/llm-endpoints/:id/bound-agents` and
// `POST .../respawn-agents` gated on `visibleCredential` alone — "can this caller
// see the PROVIDER?" — and never asked whether it may see each AGENT, which has
// its own rules (team membership since #2078, plus ownership for a standalone
// agent). A system-scoped credential shared across teams therefore disclosed the
// id, display name and role of every consumer to any Team Admin who could merely
// view it.
//
// The pure half is unit-tested in respawn-agents.test.js, and `isVisible` being a
// REQUIRED dep already makes it impossible to discover bound agents without
// answering the question. What only the wiring can state — and what a later edit
// could quietly reverse — is the asymmetry the ticket settled on:
//
//   • the LIST responds with the visible subset,
//   • the RESPAWN acts on the UNION (hiding an agent from the restart would leave
//     it on the rotated-away credential — worse than the metadata leak),
//   • and the RESPONSE is projected, so the action's reach never becomes a way to
//     enumerate another team's agent ids.
//
// api.js cannot be `require`d in a unit test (it boots two listeners), so this
// reads the routes' source — the drift-guard technique #651 uses for JSX.

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

// Comments here name the very thing under test, so strip them before asserting.
// Both forms are anchored to the start of a line: an unanchored block-comment
// pattern runs away across a regex literal elsewhere in the file and deletes far
// more than it should, after which every assertion "passes" by finding nothing.
function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
}

const listRoute = () => stripComments(route("app.get('/api/llm-endpoints/:id/bound-agents'"));
const respawnRoute = () => stripComments(route("app.post('/api/llm-endpoints/:id/respawn-agents'"));

test('the guard is not vacuous: both routes survive the comment strip with their bodies intact', () => {
  for (const [name, src] of [['list', listRoute()], ['respawn', respawnRoute()]]) {
    assert.ok(src.length > 200, `${name} route came back empty — the comment strip ran away`);
    assert.match(src, /discoverBoundAgents\(/, `${name} route must still discover bound agents`);
    assert.match(src, /res\.json\(/, `${name} route must still answer`);
  }
});

test('both routes resolve visibility per agent, through the one shared deps builder', () => {
  // A second, hand-rolled deps literal in either route is how the two views of
  // "who may this caller see" would drift apart.
  for (const [name, src] of [['list', listRoute()], ['respawn', respawnRoute()]]) {
    assert.match(src, /discoverBoundAgents\([^;]*boundAgentDeps\(scope\)\)/,
      `${name} route must pass the shared deps builder`);
    assert.doesNotMatch(src, /loadTeamConfig:/,
      `${name} route must not re-declare the deps inline`);
  }
});

test('boundAgentDeps answers isVisible with visibleAgent, not with the credential gate', () => {
  const start = API_SRC.indexOf('function boundAgentDeps(');
  assert.ok(start > 0, 'boundAgentDeps not found — this guard needs re-pointing');
  const src = stripComments(API_SRC.slice(start, API_SRC.indexOf('\nfunction loadAllAgentConfigs', start)));
  assert.match(src, /isVisible:\s*cfg\s*=>\s*visibleAgent\(scope,\s*agentMetaForScope\(cfg\)\)/);
  // The bug was answering an agent question with a credential predicate.
  assert.doesNotMatch(src, /isVisible:[^\n]*visibleCredential/);
});

test('the LIST discloses only the visible subset, plus the hidden count', () => {
  const src = listRoute();
  assert.match(src, /const \{ visible, hidden \} = discoverBoundAgents\(/);
  assert.match(src, /res\.json\(\{ agents: visible, hidden: hiddenBlastRadius\(hidden\) \}\)/);
  // `agents: hidden` / a re-merged list is the regression this exists to catch.
  assert.doesNotMatch(src, /agents:\s*\[\.\.\.visible/);
});

test('the RESPAWN acts on the union of visible and hidden', () => {
  const src = respawnRoute();
  assert.match(src, /const agents = \[\.\.\.visible, \.\.\.hidden\]/,
    'every consumer of the rotated credential must be restarted, visible or not');
  assert.match(src, /respawnWithConcurrency\(\s*agents\.map\(a => a\.id\)/);
  // Restricting the respawn to `visible` is the tempting-but-wrong fix.
  assert.doesNotMatch(src, /respawnWithConcurrency\(\s*visible\.map/);
});

test('the RESPAWN response is projected — hidden ids never leave the process', () => {
  const src = respawnRoute();
  assert.match(src, /projectRespawnOutcome\(outcome, visibleIds\)/);
  assert.match(src, /respawned: projected\.respawned/);
  assert.match(src, /skipped: projected\.skipped/);
  // Returning the raw outcome is exactly the leak, in the other direction.
  assert.doesNotMatch(src, /res\.json\(\{\s*respawned,\s*skipped\s*\}\)/);
});

test('the RESPAWN keeps the aggregate signal, including hidden FAILURES', () => {
  const src = respawnRoute();
  const body = src.slice(src.indexOf('res.json({'));
  assert.match(body, /hidden: \{/);
  assert.match(body, /respawned: projected\.hiddenRespawned/);
  assert.match(body, /skipped: projected\.hiddenSkipped/,
    'an agent left on a stale credential must reach the operator even when unnamed');
});

test('the server log carries the hidden COUNTS and no hidden identity', () => {
  const src = respawnRoute();
  const log = src.slice(src.indexOf('console.log('), src.indexOf('res.json({'));
  assert.ok(log.length > 0, 'the respawn outcome must still be logged');
  assert.match(log, /hidden=\$\{blastRadius\.count\}/);
  assert.match(log, /hiddenSkipped=\$\{projected\.hiddenSkipped\}/);
  // Reading the container log must not be a way around the response projection.
  assert.doesNotMatch(log, /hidden\.map|hidden\.join|a\.id/);
});
