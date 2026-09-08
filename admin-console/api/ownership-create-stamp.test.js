'use strict';

// Drift guard for the #2077 owner stamp on the console's create paths.
//
// `POST /internal/agents` is UNAUTHENTICATED (it is the orchestrator's internal
// API), so an `ownerId` taken from a request body would be self-asserted and
// worth nothing. The console is the only place that knows who is calling, which
// makes two properties load-bearing and neither of them visible to a unit test
// of a pure module:
//
//   1. every path that creates an ownable agent stamps the owner, and
//   2. the stamp is derived from the SESSION, never from `req.body`.
//
// `api.js` cannot be required in a unit test (it binds a port and starts a
// background poller), so these assertions read its source — the technique used
// by `team-stream-materialize.test.js` and `orphan-routes.test.js`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

// Line comments only — a `/* … */` pass over a file this size swallows real
// code (it occurs inside string literals and regexes), which would make the
// negative assertions below vacuous.
function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CODE = stripComments(SRC);

// Brace-match the object literal starting at `open` (the index of its `{`).
// A naive "slice to the next `}),`" truncates the two team bodies at their
// first `: {}),` conditional spread, which would hide the stamp that follows.
function objectLiteral(open) {
  let depth = 0;
  for (let i = open; i < CODE.length; i++) {
    if (CODE[i] === '{') depth++;
    else if (CODE[i] === '}') {
      depth--;
      if (depth === 0) return CODE.slice(open, i + 1);
    }
  }
  assert.fail(`unbalanced object literal at ${open}`);
}

// Every `POST` to the orchestrator's agent-create endpoint, as the source of
// the request body literal it sends.
function createCalls() {
  const calls = [];
  const needle = '/internal/agents`, {';
  let i = CODE.indexOf(needle);
  while (i !== -1) {
    const body = CODE.indexOf('body: JSON.stringify(', i);
    if (body !== -1 && body - i < 400) {
      calls.push(objectLiteral(CODE.indexOf('{', body)));
    }
    i = CODE.indexOf(needle, i + needle.length);
  }
  return calls;
}

test('every agent/team create call stamps the owner from the session', () => {
  const calls = createCalls();
  // POST /api/agents, both /api/quickstart paths, POST /api/teams and
  // POST /api/teams/stream. If this count changes, a new create path landed and
  // must be stamped too — that is the whole point of asserting it.
  assert.equal(calls.length, 5, `expected 5 agent-create calls, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /\.\.\.ownerFor\(req\)/, `a create call does not stamp the owner:\n${call.slice(0, 300)}`);
  }
});

test('the owner comes from getScope, never from the request body', () => {
  const start = CODE.indexOf('function ownerFor(req) {');
  assert.ok(start > 0, 'ownerFor() not found — this guard needs re-pointing');
  const fn = CODE.slice(start, CODE.indexOf('\n}', start));
  assert.match(fn, /getScope\(req\)\.userId/, 'the owner must be resolved from the session scope');
  assert.doesNotMatch(fn, /req\.body|req\.query|req\.params/, 'the owner must never be read from the request');
});

test('an operator with no user record gets no owner rather than a null one', () => {
  const start = CODE.indexOf('function ownerFor(req) {');
  const fn = CODE.slice(start, CODE.indexOf('\n}', start));
  // The env single-admin has `userId: null` (computeScope). Returning `{}` is
  // what leaves the key ABSENT — `ownerId: null` would be a third state nothing
  // reads, and on the orchestrator side `extra.ownerId` is truthy-checked.
  assert.match(fn, /return userId \? \{ ownerId: String\(userId\), ownerSource: 'creator' \} : \{\}/);
});

test('ownerFor is defined next to the other session-derived stamps', () => {
  // It belongs with `getScope`/`chatAuthorFor`, not near a route: a copy placed
  // beside one handler is how the next create path ends up with its own rule.
  const scope = CODE.indexOf('function getScope(req) {');
  const owner = CODE.indexOf('function ownerFor(req) {');
  assert.ok(scope > 0 && owner > scope && owner - scope < 3000, 'ownerFor drifted away from getScope');
  assert.equal(CODE.split('function ownerFor(').length - 1, 1, 'ownerFor must be defined exactly once');
});
