'use strict';

// Drift guard for #2231 (Phase B of #2229): the three agent-creation fast
// lanes must each mint a team of one (a `role: 'team'` record + one
// `team-member`) rather than a standalone `role: 'agent'`, and must grant the
// creator team-admin membership on the new team in the same request
// (`planCreatorMembership`, the #2081/#2052 guarantee).
//
// `api.js` cannot be required in a unit test (it binds a port and starts a
// background poller), so these assertions read its source — the technique
// used by `ownership-create-stamp.test.js` and `team-stream-materialize.test.js`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CODE = stripComments(SRC);

/** Slice out one route handler's body, from its `app.<verb>('<path>'` to the next `app.` registration. */
function route(needle) {
  const start = CODE.indexOf(needle);
  assert.ok(start > 0, `route ${JSON.stringify(needle)} not found — this guard needs re-pointing`);
  const end = CODE.indexOf('\napp.', start + needle.length);
  assert.ok(end > start, `could not find the end of ${needle}`);
  return CODE.slice(start, end);
}

const agentsRoute = () => route("app.post('/api/agents', heavyLimiter");
const quickstartRoute = () => route("app.post('/api/quickstart', heavyLimiter");
const quickstartLlmRoute = () => route("app.post('/api/quickstart/llm', heavyLimiter");

test('POST /api/quickstart always mints a team of one', () => {
  const src = quickstartRoute();
  assert.match(src, /role:\s*'agent',/);
  assert.match(src, /mintTeamOfOne:\s*true,/);
});

test('POST /api/quickstart/llm always mints a team of one', () => {
  const src = quickstartLlmRoute();
  assert.match(src, /role:\s*'agent',/);
  assert.match(src, /mintTeamOfOne:\s*true,/);
});

test("POST /api/agents mints a team of one exactly when role:'agent' and no teamId", () => {
  const src = agentsRoute();
  assert.match(src, /const mintTeamOfOne = role === 'agent' && !teamId;/);
  assert.match(src, /\.\.\.\(mintTeamOfOne \? \{ mintTeamOfOne: true \} : \{\}\)/);
});

test('all three routes reuse planCreatorMembership + callAdmin — the same idiom convert-to-team uses', () => {
  for (const src of [quickstartRoute(), quickstartLlmRoute(), agentsRoute()]) {
    assert.match(src, /planCreatorMembership\(\{/);
    assert.match(src, /userId: getScope\(req\)\.userId,/);
    assert.match(src, /teamCreated: true,/);
    assert.match(src, /callAdmin\('POST', 'memberships', creatorMembership\)/);
  }
});

test('the creator-membership write is best-effort, not fatal — a failed grant does not fail the create', () => {
  for (const src of [quickstartRoute(), quickstartLlmRoute(), agentsRoute()]) {
    // A try/catch wraps the callAdmin write itself (unlike POST /api/teams,
    // which is fatal and throws to roll back — a fast-lane create has already
    // succeeded and has no rollback path), and the catch logs rather than
    // rethrowing past the response.
    const membershipIdx = src.indexOf('planCreatorMembership({');
    assert.ok(membershipIdx > 0);
    const tryIdx = src.indexOf('try {', membershipIdx);
    const callIdx = src.indexOf("callAdmin('POST', 'memberships', creatorMembership)", membershipIdx);
    const catchIdx = src.indexOf('} catch (err) {', callIdx);
    const catchEnd = src.indexOf('\n      }', catchIdx);
    assert.ok(tryIdx > membershipIdx && tryIdx < callIdx, 'the callAdmin write must be inside its own try block');
    assert.ok(catchIdx > callIdx, 'the try must be followed by a catch');
    const catchBody = src.slice(catchIdx, catchEnd > catchIdx ? catchEnd : catchIdx + 300);
    assert.doesNotMatch(catchBody, /\bthrow\b/, 'a failed membership write must not throw past the already-succeeded create');
  }
});

test('planCreatorMembership is imported, not reimplemented inline', () => {
  assert.match(SRC, /require\('\.\/creator-membership'\)/);
  assert.equal(CODE.split('function planCreatorMembership(').length, 1, 'planCreatorMembership must not be redefined in api.js');
});
