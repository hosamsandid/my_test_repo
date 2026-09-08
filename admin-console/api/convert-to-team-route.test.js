'use strict';

// Guards `POST /api/agents/:id/convert-to-team` (#2052).
//
// The route is a thin proxy: every decision about the conversion lives in the
// orchestrator's pure `team-conversion.js` (unit-tested there), because the
// orchestrator is the only process that can rewrite the prompt file, re-mint a
// plugin scope and respawn the container. What a unit test cannot see from over
// there is whether this side still *reaches* it, and with the two authorization
// gates the conversion needs — so this reads the route's source, the same
// drift-guard technique the sibling api guards and the src-side
// `*-wiring.test.js` files use (api.js boots Express and cannot be required).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/** Slice out one route's body, so a match elsewhere in the 17k-line file can't fool us. */
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

const convertRoute = () => stripComments(route("app.post('/api/agents/:id/convert-to-team'"));

test('the route exists and is rate-limited like the other create paths', () => {
  const src = convertRoute();
  // It provisions a team record and respawns a container — heavy, not cheap.
  assert.match(src, /app\.post\('\/api\/agents\/:id\/convert-to-team',\s*heavyLimiter/);
});

test('the agent id is validated before it is used as a path segment', () => {
  const src = convertRoute();
  assert.match(src, /AGENT_ID_RE\.test\(id\)/);
  assert.match(src, /encodeURIComponent\(id\)/);
});

test('a missing agent is a 404, decided here rather than proxied blind', () => {
  const src = convertRoute();
  assert.match(src, /if \(!cfg\) return res\.status\(404\)/);
});

test('both authorization gates are present — manage the agent AND its tenant', () => {
  const src = convertRoute();
  // The conversion edits this agent and creates a team in its tenant. A caller
  // who owns the agent but is not a Team Admin for the tenant may do the first
  // and not the second, so the tenant check must NOT go through
  // `agentMetaForScope` (which carries the ownership escape hatch).
  assert.match(src, /denyUnlessCanManageAgent\(req, res,/);
  assert.match(src, /canManageAgent\(getScope\(req\),\s*\{ teamId: agentTeamId\(/);
  assert.match(src, /res\.status\(403\)\.json\(\{ error: 'forbidden', code: 'forbidden' \}\)/);
});

test('it proxies to the orchestrator route that owns the conversion', () => {
  const src = convertRoute();
  assert.match(src, /\/internal\/agents\/\$\{encodeURIComponent\(id\)\}\/convert-to-team/);
  assert.match(src, /method: 'POST'/);
});

test('the mid-run refusal is forwarded verbatim, not flattened into an error', () => {
  const src = convertRoute();
  // The orchestrator answers 409 + `{ warning, busy, activeTriggers }` when the
  // agent is mid-turn. Swallowing the status or the body would turn the UI's
  // "convert anyway?" question into a dead-end error toast.
  assert.match(src, /if \(!resp\.ok\) return res\.status\(resp\.status\)\.json\(data\)/);
});

test('`force` is threaded from the body, and only as an explicit boolean', () => {
  const src = convertRoute();
  // A truthy-coerced flag would let any stray body value cut a running turn off.
  assert.match(src, /force: req\.body\?\.force === true/);
});

test('an unreachable orchestrator is a 502, not a 500 or a hang', () => {
  const src = convertRoute();
  assert.match(src, /res\.status\(502\)\.json\(\{ error: `Orchestrator unreachable/);
});

test('the route does NOT re-implement the eligibility rule', () => {
  const src = convertRoute();
  // One source of truth (orchestrator/team-conversion.js). A second copy here
  // is the thing that drifts, and it would refuse or allow conversions the
  // orchestrator disagrees with.
  assert.doesNotMatch(src, /role !== 'agent'|role === 'team-member'|parentTeamId/);
  // Nor the derived team id — the confirmation the user saw was built from the
  // orchestrator's suffix, and a third copy of it here would be a third thing
  // to keep in step.
  assert.doesNotMatch(src, /\$\{[^}]*\}-team/);
});
