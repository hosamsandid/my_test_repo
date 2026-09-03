'use strict';

// Unit tests for the member-create materialization preference (#1958), plus a
// source-reading guard that the route actually threads the parsed value into
// BOTH surviving body shapes. api.js cannot be `require`d in a unit test (it
// boots Express and reaches for the orchestrator), so the wiring half reads the
// route's source — the same drift-guard technique #1959's removal guard and the
// src-side `*-wiring.test.js` files use (#651).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseMemberMaterialize } = require('./member-materialize');

// --------------------------------------------------------------- the parse

test('an absent preference means materialize now — pre-#1958 callers unaffected (AC5)', () => {
  // A body-less POST is what both the chat rail and the Agents page sent before
  // this ticket, so this case IS the backwards-compatibility contract.
  assert.deepEqual(parseMemberMaterialize(undefined), { materialize: true });
  assert.deepEqual(parseMemberMaterialize(null), { materialize: true });
  assert.deepEqual(parseMemberMaterialize({}), { materialize: true });
  assert.deepEqual(parseMemberMaterialize({ templateId: 'reviewer' }), { materialize: true });
});

test('an explicit true is accepted and is the same thing as absent (AC1)', () => {
  assert.deepEqual(parseMemberMaterialize({ materialize: true }), { materialize: true });
});

test('an explicit false defers — this is the only stub trigger (AC2)', () => {
  assert.deepEqual(parseMemberMaterialize({ materialize: false }), { materialize: false });
});

test('a non-boolean preference is a 400, never a silent fallback (AC5)', () => {
  // The dangerous direction is a caller that BELIEVES it deferred: coercing any
  // of these to a truthy/falsy boolean would clone a repository behind its back.
  for (const raw of ['false', 'true', '', 0, 1, null, [], {}, NaN]) {
    const out = parseMemberMaterialize({ materialize: raw });
    assert.ok(out.error, `${JSON.stringify(raw)} must be rejected, got ${JSON.stringify(out)}`);
    assert.equal(out.materialize, undefined, 'a rejected body must not also yield a preference');
    assert.match(out.error, /materialize/);
  }
});

test('the error names the way out so a stale client need not read the source', () => {
  const { error } = parseMemberMaterialize({ materialize: 'false' });
  assert.match(error, /boolean/);
  assert.match(error, /omit it/);
});

// ------------------------------------------------------- the route's wiring

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/** The body of the members route, so a match elsewhere in api.js can't fool us. */
function membersRoute() {
  const start = API_SRC.indexOf("app.post('/api/agents/:teamId/members'");
  assert.ok(start > 0, 'members route not found — this guard needs re-pointing');
  const end = API_SRC.indexOf('\napp.', start + 1);
  assert.ok(end > start, 'could not find the end of the members route');
  return API_SRC.slice(start, end);
}

/** Source with comments stripped — the prose below explains the very feature
 *  these assertions look for, so an un-stripped match would be vacuous. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the route parses the preference and refuses a bad one before doing any work', () => {
  const route = code(membersRoute());
  assert.ok(route.includes('parseMemberMaterialize(inBody)'), 'the route must use the shared parse');
  assert.ok(
    /parseMemberMaterialize\(inBody\)[\s\S]{0,200}?\.error[\s\S]{0,120}?res\.status\(400\)/.test(route),
    'a rejected preference must short-circuit with a 400',
  );
  // Before the orchestrator is ever called — creating the member and only then
  // discovering the mode was unparseable would be the worst of both worlds.
  const parseAt = route.indexOf('parseMemberMaterialize');
  const fetchAt = route.indexOf('/internal/teams/');
  assert.ok(parseAt > 0 && fetchAt > parseAt, 'the parse must precede the orchestrator call');
});

test('BOTH surviving body shapes forward the resolved preference (AC2)', () => {
  const route = code(membersRoute());
  // Free-form: the body is spread, not aliased, so the resolved value rides along.
  assert.ok(/let outBody = \{ \.\.\.inBody, materialize \};/.test(route));
  // templateId: buildMemberFromTemplate only emits the key when it is defined
  // (process-template.js), so it has to be handed in explicitly.
  assert.ok(
    /buildMemberFromTemplate\(template, \{[\s\S]{0,400}?materialize,[\s\S]{0,80}?\}\)/.test(route),
    'the templateId branch must pass materialize into buildMemberFromTemplate',
  );
});

test('role gating and authorization are untouched by this ticket (AC6)', () => {
  const route = code(membersRoute());
  assert.ok(route.includes('canManageAgent(getScope(req)'), 'the config-write check must survive');
  assert.ok(route.includes('AGENT_ID_RE.test(teamId)'), 'the id validation must survive');
  // The parse must not have been slipped in AHEAD of the authorization check —
  // an unauthorized caller should get a 403, not a body-validation 400.
  assert.ok(
    route.indexOf('canManageAgent') < route.indexOf('parseMemberMaterialize'),
    'authorization must still come first',
  );
});

// Non-vacuity: the assertions above are only worth anything if they FAIL against
// the pre-#1958 route. Rather than shelling out to git here, this pins the one
// literal that provably did not exist before — the route used `outBody = inBody`.
test('the guard would catch a revert to the pre-#1958 pass-through', () => {
  const route = code(membersRoute());
  assert.ok(
    !/let outBody = inBody;/.test(route),
    'the old alias is back — the preference would be dropped on the free-form path',
  );
});
