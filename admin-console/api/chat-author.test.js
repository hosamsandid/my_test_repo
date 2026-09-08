const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CHAT_AUTHOR_FIELD, chatAuthorStamp } = require('./chat-author');

/* ── the pure stamp builder ──────────────────────────────────────────────── */

test('the stamp travels under the documented io.aee key', () => {
  assert.equal(CHAT_AUTHOR_FIELD, 'io.aee.author');
});

test('a registered user is stamped with both the record id and the subject', () => {
  assert.deepEqual(chatAuthorStamp({ userId: 'u-1', username: 'anna' }), { userId: 'u-1', subject: 'anna' });
});

test('the env single-admin has no user record — the subject alone attributes it (AC13)', () => {
  assert.deepEqual(chatAuthorStamp({ userId: null, username: 'admin' }), { subject: 'admin' });
});

test('values are trimmed and blank halves are dropped, never stamped empty', () => {
  assert.deepEqual(chatAuthorStamp({ userId: '  u-1  ', username: '   ' }), { userId: 'u-1' });
  assert.deepEqual(chatAuthorStamp({ userId: '', username: ' anna ' }), { subject: 'anna' });
});

test('a caller with no usable identity leaves the message un-attributed', () => {
  // Better an un-attributed message (neutral icon) than one stamped with an
  // empty author, which would claim attribution it cannot back up.
  for (const identity of [undefined, {}, { userId: null, username: null }, { userId: '  ', username: '' },
    { userId: 42, username: {} }]) {
    assert.equal(chatAuthorStamp(identity), null, `expected null for ${JSON.stringify(identity)}`);
  }
});

test('the stamp carries no name — the name is resolved at render (D3)', () => {
  const stamp = chatAuthorStamp({ userId: 'u-1', username: 'anna' });
  assert.deepEqual(Object.keys(stamp).sort(), ['subject', 'userId']);
});

/* ── wiring guard: the stamp is server-side and unspoofable (AC2) ─────────
 *
 * The route bodies are express glue in api.js (uncovered per #651), so the two
 * properties that carry the security argument are asserted against the source:
 * the send route must build the stamp from the request, and it must exclude the
 * author key from the client-controlled `io.aee.*` pass-through.
 */

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function at(src, needle) {
  const i = src.indexOf(needle);
  assert.ok(i > 0, `expected api.js to contain: ${needle}`);
  return i;
}

test('the author stamp is derived from the authenticated session, not the body', () => {
  const helper = at(API_SRC, 'function chatAuthorFor(req)');
  const region = API_SRC.slice(helper, helper + 400);
  assert.match(region, /getScope\(req\)\.userId/, 'the user-store id comes from the request scope');
  assert.match(region, /req\.user\s*&&\s*req\.user\.username/, 'the subject comes from the session');
  assert.doesNotMatch(region, /req\.body/, 'nothing in the stamp may come from the request body');
});

test('the io.aee.* pass-through cannot inject or override an author', () => {
  const passThrough = at(API_SRC, "if (k.startsWith('io.aee.')");
  const line = API_SRC.slice(passThrough, API_SRC.indexOf('\n', passThrough));
  assert.match(line, /k !== CHAT_AUTHOR_FIELD/, 'the author key is excluded from the pass-through');
});

test('the send route stamps the author onto the outgoing content', () => {
  const stampCall = at(API_SRC, 'const authorStamp = chatAuthorFor(req);');
  const region = API_SRC.slice(stampCall, stampCall + 200);
  assert.match(region, /content\[CHAT_AUTHOR_FIELD\] = authorStamp/);
  // …and it happens after the pass-through loop, so ordering cannot undo it.
  assert.ok(stampCall > at(API_SRC, "if (k.startsWith('io.aee.')"),
    'the stamp is applied after the client pass-through, never before');
});

test('the pre-handoff check, posted on a human\'s behalf, is attributed too (AC1)', () => {
  const region = API_SRC.slice(at(API_SRC, 'const preHandoffContent'), at(API_SRC, 'const preHandoffContent') + 400);
  assert.match(region, /chatAuthorFor\(req\)/);
  assert.match(region, /preHandoffContent\[CHAT_AUTHOR_FIELD\]/);
});
