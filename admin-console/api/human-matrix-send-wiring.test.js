'use strict';

// Human send-path wiring guard (#2173 — humans post under their own Matrix
// identity into the shared per-agent room).
//
// The behavioural halves are covered elsewhere: `human-matrix-store.test.js`
// (the credential store) and `chat-author.test.js` (the display-name stamp,
// unchanged by this ticket). The routing decision itself — send as the human's
// own account, provisioned on demand, and refused (#2721) when none can be
// established — never the shared admin — is express glue in
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
  const helper = at(API_SRC, 'async function chatSendIdentityFor(req)');
  const region = API_SRC.slice(helper, helper + 800);
  assert.match(region, /const scope = getScope\(req\);/, 'the user-store id comes from the request scope');
  assert.match(region, /userId: scope\.userId,/);
  assert.match(region, /username: req && req\.user && req\.user\.username,/, 'the operator subject is the session login');
  assert.match(region, /operator: scope\.all === true,/);
  assert.match(region, /store: humanMatrixStore,/);
  assert.doesNotMatch(region, /req\.body/, 'nothing here may come from the request body');
  assert.doesNotMatch(region, /ADMIN_TOKEN/, 'the resolver never names the shared admin account');
});

test('a missing identity is provisioned on demand through the orchestrator (#2721 AC3/AC9)', () => {
  const helper = at(API_SRC, 'async function chatSendIdentityFor(req)');
  const region = API_SRC.slice(helper, helper + 800);
  assert.match(region, /callAdmin\('POST', `users\/\$\{encodeURIComponent\(userId\)\}\/matrix-identity`, \{\}\)/);
  assert.match(region, /callAdmin\('POST', 'operator\/matrix-identity', \{ subject \}\)/);
});

test('the send route always sends with the human token and refuses without one (#2721 AC4/AC5)', () => {
  const sendRouteAt = at(API_SRC, "app.post('/api/matrix/rooms/:roomId/messages'");
  const region = API_SRC.slice(sendRouteAt, sendRouteAt + 3500);
  assert.match(region, /const humanIdentity = await chatSendIdentityFor\(req\);\n\s*if \(!humanIdentity\) return refuseChatSendWithoutIdentity\(res\);/);
  assert.match(region, /const sendToken = humanIdentity\.accessToken;/);
  assert.match(region, /matrix\.matrixFetch\(sendToken,/, 'the send call must use the resolved token, not a hard-coded one');
  assert.doesNotMatch(region, /sendToken = [^;]*ADMIN_TOKEN/, 'no shared-admin fallback for the send token');
});

test('the refusal is a 503 with the stable chat-identity-not-ready code', () => {
  const fnAt = at(API_SRC, 'function refuseChatSendWithoutIdentity(res)');
  const region = API_SRC.slice(fnAt, fnAt + 300);
  assert.match(region, /res\.status\(503\)\.json\(\{ error: CHAT_IDENTITY_NOT_READY_MESSAGE, code: CHAT_IDENTITY_NOT_READY \}\)/);
});

test('a resolved human identity is joined to the room before the send', () => {
  const sendRouteAt = at(API_SRC, "app.post('/api/matrix/rooms/:roomId/messages'");
  const identityAt = at(API_SRC, 'const humanIdentity = await chatSendIdentityFor(req);', sendRouteAt);
  const joinAt = at(API_SRC, 'await ensureHumanJoinedToRoom(humanIdentity, roomId);', sendRouteAt);
  const sendAt = at(API_SRC, 'matrix.matrixFetch(sendToken,', sendRouteAt);
  assert.ok(identityAt < joinAt && joinAt < sendAt, 'identity resolve -> join -> send, in that order');
});

test('the hand-over nudge posts as the acting human, never the shared admin (#2721 AC6)', () => {
  const nudgeAt = at(API_SRC, "app.post('/api/agents/:id/handover/nudge'");
  const end = at(API_SRC, "app.post('/api/agents/:id/handover',", nudgeAt);
  const region = API_SRC.slice(nudgeAt, end);
  const identityAt = region.indexOf('const humanIdentity = await chatSendIdentityFor(req);');
  const refuseAt = region.indexOf('if (!humanIdentity) return refuseChatSendWithoutIdentity(res);');
  const joinAt = region.indexOf('await ensureHumanJoinedToRoom(humanIdentity, roomId);');
  const sendAt = region.indexOf('matrix.matrixFetch(humanIdentity.accessToken,');
  assert.ok(identityAt > 0 && refuseAt > identityAt && joinAt > refuseAt && sendAt > joinAt,
    'resolve -> refuse-if-missing -> join -> send as the human');
  assert.doesNotMatch(region, /matrixFetch\(matrix\.ADMIN_TOKEN,\s*`\/_matrix\/client\/v3\/rooms\/\$\{encodeURIComponent\(roomId\)\}\/send/,
    'the nudge must not be sent with the shared admin token');
});

test('the display-name author stamp still rides alongside the real sender', () => {
  // #2065's stamp answers "who wrote this" for the transcript UI; #2173 makes
  // the Matrix `sender` itself the true author too, and the stamp stays.
  const sendRouteAt = at(API_SRC, "app.post('/api/matrix/rooms/:roomId/messages'");
  const region = API_SRC.slice(sendRouteAt, sendRouteAt + 3500);
  assert.match(region, /content\[CHAT_AUTHOR_FIELD\] = authorStamp/);
});
