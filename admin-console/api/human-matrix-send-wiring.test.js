'use strict';

// Human send-path wiring guard (#2173 — humans post under their own Matrix
// identity into the shared per-agent room).
//
// The behavioural halves are covered elsewhere: `human-matrix-store.test.js`
// (the credential store) and `chat-author.test.js` (the display-name stamp,
// unchanged by this ticket). The routing decision itself — send as the human's
// own account when one resolves, else the shared admin — is express glue in
// api.js (uncovered per #651), so it is asserted against the source the same
// way chat-author.test.js does for the author stamp.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function at(src, needle, from = 0) {
  const i = src.indexOf(needle, from);
  assert.ok(i > 0, `expected api.js to contain: ${needle}`);
  return i;
}

test('the human identity is resolved from the authenticated session, not the body', () => {
  const helper = at(API_SRC, 'function humanMatrixIdentityFor(req)');
  const region = API_SRC.slice(helper, helper + 400);
  assert.match(region, /getScope\(req\)\.userId/, 'the user-store id comes from the request scope');
  assert.match(region, /humanMatrixStore\.readIdentity\(userId\)/);
  assert.doesNotMatch(region, /req\.body/, 'nothing here may come from the request body');
});

test('the send route sends with the human token when one resolves, else the shared admin', () => {
  const sendRouteAt = at(API_SRC, "app.post('/api/matrix/rooms/:roomId/messages'");
  const region = API_SRC.slice(sendRouteAt, sendRouteAt + 3000);
  assert.match(region, /const humanIdentity = humanMatrixIdentityFor\(req\);/);
  assert.match(region, /const sendToken = humanIdentity \? humanIdentity\.accessToken : matrix\.ADMIN_TOKEN;/);
  assert.match(region, /matrix\.matrixFetch\(sendToken,/, 'the send call must use the resolved token, not a hard-coded one');
});

test('a resolved human identity is joined to the room before the send', () => {
  const sendRouteAt = at(API_SRC, "app.post('/api/matrix/rooms/:roomId/messages'");
  const identityAt = at(API_SRC, 'const humanIdentity = humanMatrixIdentityFor(req);', sendRouteAt);
  const joinAt = at(API_SRC, 'await ensureHumanJoinedToRoom(humanIdentity, roomId);', sendRouteAt);
  const sendAt = at(API_SRC, 'matrix.matrixFetch(sendToken,', sendRouteAt);
  assert.ok(identityAt < joinAt && joinAt < sendAt, 'identity resolve -> join -> send, in that order');
});

test('the display-name author stamp still rides alongside the real sender', () => {
  // #2065's stamp answers "who wrote this" for the transcript UI; #2173 makes
  // the Matrix `sender` itself the true author too, but the stamp stays so an
  // unprovisioned identity / the env single-admin fallback still attributes.
  const sendRouteAt = at(API_SRC, "app.post('/api/matrix/rooms/:roomId/messages'");
  const region = API_SRC.slice(sendRouteAt, sendRouteAt + 3000);
  assert.match(region, /content\[CHAT_AUTHOR_FIELD\] = authorStamp/);
});
