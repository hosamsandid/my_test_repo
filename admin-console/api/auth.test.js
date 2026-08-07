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

// ── IAP registration gate (#1415) ───────────────────────────────────────────
// Auto-login is issued only for IAP identities the console knows: a registered
// user-store subject (userId set) or the env admin. Everyone else falls
// through to 401 / the login form.

const iapVerifierFor = (email) => async (token) => (token === 'valid-iap-jwt' ? { sub: email } : null);

test('requireAuth issues a session for a registered IAP subject', async (t) => {
  auth._setIapVerifierForTests(iapVerifierFor('known@accenture.com'));
  auth._setAuthzResolverForTests(() => ({ envAdmin: false, userId: 'u1' }));
  t.after(() => { auth._setIapVerifierForTests(null); auth._setAuthzResolverForTests(null); });

  const cookies = [];
  const res = { append: (k, v) => cookies.push(v), status() { throw new Error('should not be called'); } };
  const req = { headers: { 'x-goog-iap-jwt-assertion': 'valid-iap-jwt' } };
  let nextCalled = false;
  await auth.requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.user.username, 'known@accenture.com');
  assert.match(cookies[0], new RegExp(`^${auth.COOKIE_NAME}=`));
});

test('requireAuth issues a session for the env-admin IAP subject', async (t) => {
  auth._setIapVerifierForTests(iapVerifierFor('tester'));
  auth._setAuthzResolverForTests(() => ({ envAdmin: true, userId: null }));
  t.after(() => { auth._setIapVerifierForTests(null); auth._setAuthzResolverForTests(null); });

  const res = { append() {}, status() { throw new Error('should not be called'); } };
  let nextCalled = false;
  await auth.requireAuth({ headers: { 'x-goog-iap-jwt-assertion': 'valid-iap-jwt' } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requireAuth rejects an unregistered IAP subject without issuing a cookie', async (t) => {
  auth._setIapVerifierForTests(iapVerifierFor('stranger@accenture.com'));
  auth._setAuthzResolverForTests(() => ({ envAdmin: false, userId: null }));
  t.after(() => { auth._setIapVerifierForTests(null); auth._setAuthzResolverForTests(null); });

  const cookies = [];
  let statusCode, jsonBody;
  const res = {
    append: (k, v) => cookies.push(v),
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
  };
  await auth.requireAuth({ headers: { 'x-goog-iap-jwt-assertion': 'valid-iap-jwt' } }, res, () => {
    throw new Error('must not pass');
  });
  assert.equal(statusCode, 401);
  assert.equal(jsonBody.code, 'unauthenticated');
  assert.equal(cookies.length, 0);
});

test('requireAuth fails closed when the registration lookup throws', async (t) => {
  auth._setIapVerifierForTests(iapVerifierFor('known@accenture.com'));
  auth._setAuthzResolverForTests(() => { throw new Error('users index unreadable'); });
  t.after(() => { auth._setIapVerifierForTests(null); auth._setAuthzResolverForTests(null); });

  const cookies = [];
  let statusCode;
  const res = {
    append: (k, v) => cookies.push(v),
    status(c) { statusCode = c; return this; },
    json() { return this; },
  };
  await auth.requireAuth({ headers: { 'x-goog-iap-jwt-assertion': 'valid-iap-jwt' } }, res, () => {
    throw new Error('must not pass');
  });
  assert.equal(statusCode, 401);
  assert.equal(cookies.length, 0);
});

test('requireAuth honors an existing session cookie regardless of registration', async (t) => {
  auth._setAuthzResolverForTests(() => ({ envAdmin: false, userId: null })); // reject-all gate
  t.after(() => auth._setAuthzResolverForTests(null));

  const token = auth.issueToken('anyone');
  const req = { headers: { cookie: `${auth.COOKIE_NAME}=${token}` } };
  let nextCalled = false;
  await auth.requireAuth(req, { status() { throw new Error('should not be called'); } }, () => { nextCalled = true; });
  assert.equal(nextCalled, true); // the gate covers auto-ISSUE only
});

test('session endpoint gates IAP auto-login on registration', async (t) => {
  auth._setIapVerifierForTests(iapVerifierFor('someone@accenture.com'));
  t.after(() => { auth._setIapVerifierForTests(null); auth._setAuthzResolverForTests(null); });

  const routes = {};
  const app = { get: (path, handler) => { routes[path] = handler; }, post: () => {} };
  // Production wiring path: registerAuthRoutes installs the resolver.
  let registered = false;
  auth.registerAuthRoutes(app, {
    describeAuthz: () => (registered ? { envAdmin: false, userId: 'u1' } : { envAdmin: false, userId: null }),
  });

  const cookies = [];
  let body;
  const res = { append: (k, v) => cookies.push(v), json(b) { body = b; } };
  const req = { headers: { 'x-goog-iap-jwt-assertion': 'valid-iap-jwt' } };

  // Unregistered → unauthenticated, no cookie: the SPA shows the login form.
  await routes['/api/auth/session'](req, res);
  assert.equal(body.authenticated, false);
  assert.equal(cookies.length, 0);

  // Registered → authenticated with the authz descriptor merged onto user.
  registered = true;
  await routes['/api/auth/session'](req, res);
  assert.equal(body.authenticated, true);
  assert.equal(body.user.username, 'someone@accenture.com');
  assert.equal(body.user.userId, 'u1');
  assert.ok(cookies.length > 0);
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
