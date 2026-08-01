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

test('requireAuth blocks without a session and passes with one', async () => {
  let statusCode, jsonBody;
  const res = {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
  };
  let nextCalled = false;
  await auth.requireAuth({ headers: {} }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 401);
  assert.equal(jsonBody.code, 'unauthenticated');

  const token = auth.issueToken('tester');
  const req = { headers: { cookie: `${auth.COOKIE_NAME}=${token}` } };
  let okNext = false;
  await auth.requireAuth(req, { status() { throw new Error('should not be called'); } }, () => { okNext = true; });
  assert.equal(okNext, true);
  assert.equal(req.user.username, 'tester');
});

test('requireAuth accepts a verified IAP assertion and issues a session', async (t) => {
  auth._setIapVerifierForTests(async (token) => (token === 'valid-iap-jwt' ? { sub: 'k.z@accenture.com' } : null));
  t.after(() => auth._setIapVerifierForTests(null));

  const cookies = [];
  const res = {
    append: (k, v) => cookies.push(v),
    status() { throw new Error('should not be called'); },
  };
  const req = { headers: { 'x-goog-iap-jwt-assertion': 'valid-iap-jwt' } };
  let nextCalled = false;
  await auth.requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.user.username, 'k.z@accenture.com');
  // A regular session cookie is issued so follow-up requests skip the JWT path.
  assert.match(cookies[0], new RegExp(`^${auth.COOKIE_NAME}=`));
  const session = auth.verifyToken(cookies[0].split(';')[0].split('=')[1]);
  assert.equal(session.sub, 'k.z@accenture.com');
});

test('requireAuth still 401s on a bad IAP assertion', async (t) => {
  auth._setIapVerifierForTests(async () => null);
  t.after(() => auth._setIapVerifierForTests(null));

  let statusCode;
  const res = {
    append() {},
    status(c) { statusCode = c; return this; },
    json() { return this; },
  };
  await auth.requireAuth({ headers: { 'x-goog-iap-jwt-assertion': 'forged' } }, res, () => {
    throw new Error('must not pass');
  });
  assert.equal(statusCode, 401);
});

test('session endpoint authenticates via IAP on first contact', async (t) => {
  auth._setIapVerifierForTests(async (token) => (token === 'valid-iap-jwt' ? { sub: 'k.z@accenture.com' } : null));
  t.after(() => auth._setIapVerifierForTests(null));

  // Capture the /api/auth/session handler off a minimal app stub.
  const routes = {};
  const app = {
    get: (path, handler) => { routes[path] = handler; },
    post: () => {},
  };
  auth.registerAuthRoutes(app);

  let body;
  const res = { append() {}, json(b) { body = b; } };
  await routes['/api/auth/session']({ headers: { 'x-goog-iap-jwt-assertion': 'valid-iap-jwt' } }, res);
  assert.equal(body.authenticated, true);
  assert.equal(body.user.username, 'k.z@accenture.com');

  // Without the header (and no cookie) it stays unauthenticated.
  await routes['/api/auth/session']({ headers: {} }, res);
  assert.equal(body.authenticated, false);
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
