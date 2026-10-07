'use strict';

// The behaviour of request-timing.js is covered by the admin-console copy's
// suite (admin-console/api/request-timing.test.js). This side guards the two
// copies staying byte-identical, the orchestrator-specific route keys of the
// raw internal API, and the wiring in orchestrator.js (#555).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { routeKey } = require('./request-timing');

const TWIN = path.join(__dirname, '..', 'admin-console', 'api', 'request-timing.js');

test('two-sided guard: orchestrator copy is byte-identical to admin-console copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'request-timing.js'));
  const there = fs.readFileSync(TWIN);
  assert.ok(here.equals(there), 'request-timing.js copies differ — change both in one commit');
});

test('internal-API route keys collapse agent/team ids and keep static routes', () => {
  assert.equal(routeKey({ method: 'GET', url: '/internal/agents/payments-dev-i2846/running-sessions' }),
    'GET /internal/agents/:id/running-sessions');
  assert.equal(routeKey({ method: 'POST', url: '/internal/teams/payments/skills/activate' }),
    'POST /internal/teams/:id/skills/activate');
  assert.equal(routeKey({ method: 'GET', url: '/internal/agents/processes' }), 'GET /internal/agents/processes');
  assert.equal(routeKey({ method: 'GET', url: '/internal/maintenance-mode' }), 'GET /internal/maintenance-mode');
});

test('orchestrator.js times the internal API and reports event-loop delay', () => {
  const src = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');
  const handlerAt = src.indexOf('const internalApi = http.createServer((req, res) => {');
  assert.notEqual(handlerAt, -1, 'internalApi handler moved — re-anchor this guard');
  const handler = src.slice(handlerAt, handlerAt + 4000);
  const trackAt = handler.indexOf('perfTiming.track(req, res);');
  const gateAt = handler.indexOf('internalAuth.decideInternalAuth({');
  assert.notEqual(trackAt, -1, 'the internal API is not timed');
  assert.ok(trackAt < gateAt, 'timing attaches before the auth gate so denied requests are timed too');

  const before = src.slice(0, handlerAt);
  assert.match(before, /const perfTiming = requestTiming\.createPerfTiming\(\{\s*env: process\.env, log: \(line\) => console\.log\(line\),\s*\}\)/,
    'summary and slow lines share one stream (stdout), so one grep reads both');
  assert.match(before, /try \{ perfTiming\.start\(\); \}/);
});
