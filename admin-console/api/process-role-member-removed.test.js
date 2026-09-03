'use strict';

// Guards the removal of the missing-roles suggestion's server side (#1959).
//
// `POST /api/agents/:teamId/members` used to accept a `processTemplateId` +
// `roleId` body that loaded a process-template bundle, picked one role and
// materialised it (#1375). That shape existed ONLY to serve the missing-role
// affordance, which was retired by requester decision. It must now be REFUSED,
// not ignored: falling through to the free-form branch would create a member
// named after the role id but without the template's prompt, session policy or
// triggers — a silent wrong success.
//
// api.js cannot be `require`d in a unit test (it boots Express and reaches for
// the orchestrator), so this reads the route's source — the same drift-guard
// technique the src-side `*-wiring.test.js` files use for JSX (#651). The two
// SURVIVING branches are asserted alongside the removal, so a future edit that
// takes the refusal out by deleting too much fails here rather than in review.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/** The body of the members route, so a match elsewhere in api.js can't fool us. */
function membersRoute() {
  const start = API_SRC.indexOf("app.post('/api/agents/:teamId/members'");
  assert.ok(start > 0, 'members route not found — this guard needs re-pointing');
  const end = API_SRC.indexOf("\napp.", start + 1);
  assert.ok(end > start, 'could not find the end of the members route');
  return API_SRC.slice(start, end);
}

test('the processTemplateId+roleId body is refused with a clear, coded error', () => {
  const route = membersRoute();
  assert.ok(route.includes('processTemplateId'), 'the shape must still be recognised to be refused');
  assert.ok(
    /processTemplateId[\s\S]{0,1200}?res\.status\(400\)[\s\S]{0,600}?process-template-role-removed/.test(route),
    'the processTemplateId branch must return a 400 carrying the process-template-role-removed code',
  );
  // The message has to name what is gone and what to use instead — an operator
  // hitting this from a stale client should not have to read the source.
  assert.ok(/missing-roles suggestion was removed/.test(route));
  assert.ok(/templateId/.test(route));
});

test('nothing in the route still materialises a role out of a process bundle', () => {
  const route = membersRoute();
  for (const gone of ['loadProcessTemplate', 'templateToCustomRoles', 'applyLabelSuffix', 'PROCESS_TEMPLATES_DIR']) {
    assert.ok(!route.includes(gone), `${gone} should no longer be reached from the members route`);
  }
});

test('the two unrelated branches of the same route are untouched', () => {
  const route = membersRoute();
  // Generic "Add member" from a role template (#586) …
  assert.ok(/inBody\.templateId/.test(route));
  assert.ok(route.includes('loadAgentTemplate'));
  assert.ok(route.includes('buildMemberFromTemplate'));
  // … and the free-form pass-through, which is the `outBody` default. #1958
  // spreads the incoming body instead of aliasing it so the resolved
  // materialization preference rides along; the pass-through of every other
  // caller-supplied key is what this assertion pins.
  assert.ok(/let outBody = \{ \.\.\.inBody, materialize \};/.test(route));
  // Still proxied to the orchestrator's own member-create, unchanged.
  assert.ok(route.includes('/internal/teams/'));
});
