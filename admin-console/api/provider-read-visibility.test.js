'use strict';

// Source-shape guard for the READ visibility of the Model Providers page (#2360).
//
// The page is opened to every authenticated user (nav + route), so the LIST and
// single READ GET must widen from `providerVisible` (global + own personal +
// team/system the caller ADMINISTERS) to `providerReadVisible` — which also admits
// the team/system providers of teams the caller is a MEMBER of, READ-ONLY. The
// secret stays masked (maskLlmEndpointForCaller keys the token mask on
// visibleCredential, not on this), and the MUTATING/action routes must NOT widen —
// a member must never test / mutate / respawn a provider they only use.
//
// api.js boots on require and cannot be imported, so this reads its source (the
// provider-owner-persistence.test.js technique).
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

test('providerReadVisible exists and unions the caller\'s MEMBER teams on top of providerVisible', () => {
  const start = SRC.indexOf('function providerReadVisible(');
  assert.ok(start > 0, 'providerReadVisible must be declared in api.js');
  const body = SRC.slice(start, SRC.indexOf('\nfunction ', start + 1));
  assert.match(body, /if \(providerVisible\(scope, ep\)\) return true;/, 'must build ON TOP of providerVisible');
  assert.match(body, /scope\.teamIds/, 'must key on the caller\'s member team set');
  assert.match(body, /ep\.teamIds|ep\.teamId/, 'must match a team provider\'s team set');
  assert.match(body, /ep\.assignedTeamIds/, 'must match a legacy system provider\'s assigned teams');
});

test('the LIST and single READ GET use providerReadVisible (open page)', () => {
  assert.match(routeBody("app.get('/api/llm-endpoints'"), /\.filter\(ep => providerReadVisible\(scope, ep\)\)/,
    'the management list must use the READ predicate');
  assert.match(routeBody("app.get('/api/llm-endpoints/:id'"), /providerReadVisible\(scope, ep\)/,
    'the single read GET must use the READ predicate');
});

test('the MUTATING / action routes stay on providerVisible (manage) — never widened', () => {
  // A member may READ a team provider but must not act on one they do not manage.
  for (const opening of [
    "app.post('/api/llm-endpoints/:id/respawn-agents'",
    "app.post('/api/llm-endpoints/:id/test'",
    "app.post('/api/llm-endpoints/:id/discover-models'",
  ]) {
    const body = routeBody(opening);
    assert.doesNotMatch(body, /providerReadVisible/, `${opening} must NOT use the READ predicate`);
  }
});
