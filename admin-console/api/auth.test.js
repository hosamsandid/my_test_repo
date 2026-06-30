'use strict';

// Unit tests for the auth module (#276). Run: node --test admin-console/api/auth.test.js
// Credentials are read at module load, so set them before requiring auth.js.
process.env.ADMIN_USERNAME = 'tester';
process.env.ADMIN_PASSWORD = 's3cret-pass';
process.env.AUTH_SESSION_SECRET = 'fixed-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('./auth');

test('verifyCredentials accepts the configured pair', () => {
  assert.deepEqual(auth.verifyCredentials('tester', 's3cret-pass'), { sub: 'tester' });
});

test('verifyCredentials rejects wrong password, wrong user, and bad types', () => {
  assert.equal(auth.verifyCredentials('tester', 'nope'), null);
  assert.equal(auth.verifyCredentials('someone', 's3cret-pass'), null);
  assert.equal(auth.verifyCredentials('tester', undefined), null);
  assert.equal(auth.verifyCredentials(null, null), null);
});

test('issueToken → verifyToken round-trips and carries the subject', () => {
  const token = auth.issueToken('tester');
  const payload = auth.verifyToken(token);
  assert.equal(payload.sub, 'tester');
  assert.ok(payload.exp > Date.now());
});

test('verifyToken rejects tampered, malformed and expired tokens', () => {
  const token = auth.issueToken('tester');
  // Tamper with the payload but keep the original signature.
  const [, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: Date.now() + 1e6 })).toString('base64url');
  assert.equal(auth.verifyToken(`${forged}.${sig}`), null);

  assert.equal(auth.verifyToken('not-a-token'), null);
  assert.equal(auth.verifyToken(''), null);
  assert.equal(auth.verifyToken(null), null);

  // Expired: issue with a timestamp far in the past.
  const expired = auth.issueToken('tester', Date.now() - 30 * 24 * 60 * 60 * 1000);
  assert.equal(auth.verifyToken(expired), null);
});

test('getSession reads the session cookie from the request', () => {
  const token = auth.issueToken('tester');
  const req = { headers: { cookie: `theme=dark; ${auth.COOKIE_NAME}=${token}; other=1` } };
  const session = auth.getSession(req);
  assert.equal(session.sub, 'tester');

  assert.equal(auth.getSession({ headers: {} }), null);
  assert.equal(auth.getSession({ headers: { cookie: `${auth.COOKIE_NAME}=garbage` } }), null);
});

test('requireAuth blocks without a session and passes with one', () => {
  let statusCode, jsonBody;
  const res = {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
  };
  let nextCalled = false;
  auth.requireAuth({ headers: {} }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 401);
  assert.equal(jsonBody.code, 'unauthenticated');

  const token = auth.issueToken('tester');
  const req = { headers: { cookie: `${auth.COOKIE_NAME}=${token}` } };
  let okNext = false;
  auth.requireAuth(req, { status() { throw new Error('should not be called'); } }, () => { okNext = true; });
  assert.equal(okNext, true);
  assert.equal(req.user.username, 'tester');
});

test('setSessionCookie / clearSessionCookie emit the expected Set-Cookie', () => {
  const headers = [];
  const res = { append: (k, v) => headers.push([k, v]) };
  auth.setSessionCookie(res, 'TOKENVALUE');
  assert.equal(headers[0][0], 'Set-Cookie');
  assert.match(headers[0][1], new RegExp(`^${auth.COOKIE_NAME}=TOKENVALUE`));
  assert.match(headers[0][1], /HttpOnly/);
  assert.match(headers[0][1], /SameSite=Lax/);

  headers.length = 0;
  auth.clearSessionCookie(res);
  assert.match(headers[0][1], /Max-Age=0/);
});
