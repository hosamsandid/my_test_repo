'use strict';

// Unit tests for the auth module (#276, reworked by #2059).
// Run: node --test admin-console/api/auth.test.js
//
// `ADMIN_USERNAME`/`ADMIN_PASSWORD` ARE set here: the #2059↔#1457 reconciliation
// ("Option C", PR #2094) restored the env credential as a ONE-TIME SEED WINDOW —
// it authenticates only while the store holds no user record yet, gated in the
// login route behind `usersSeeded()`. Distinct values (not reused by the store-
// path tests) so the pre-seed gate tests can't accidentally collide with a
// store-credential fixture. `AUTH_SESSION_SECRET` is set so the session signing
// key is fixed and no key file is touched — session-secret.test.js covers the
// derivation itself.
process.env.ADMIN_USERNAME = 'env-admin';
process.env.ADMIN_PASSWORD = 'env-seed-pw';
process.env.AUTH_SESSION_SECRET = 'fixed-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('./auth');

// Option C (PR #2094): the env-credential check EXISTS again, but only as a
// one-time seed window — verifyCredentials is restored and exported, and the
// login route gates it behind `usersSeeded()`. This pins the unit surface; the
// login-route test below pins the gate itself (accepted pre-seed, rejected once
// seeded).
test('the env credential is restored, matching the configured pair (Option C)', () => {
  assert.equal(typeof auth.verifyCredentials, 'function', 'verifyCredentials is exported again');
  assert.deepEqual(auth.verifyCredentials('env-admin', 'env-seed-pw'), { sub: 'env-admin' });
  assert.equal(auth.verifyCredentials('env-admin', 'wrong'), null, 'wrong password → null');
  assert.equal(auth.verifyCredentials('someone-else', 'env-seed-pw'), null, 'wrong username → null');
  const src = require('node:fs').readFileSync(require.resolve('./auth'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter(l => !l.trim().startsWith('//')).join('\n');
  // The login route MUST guard the env compare behind the pre-seed gate — a
  // refactor that dropped it would reintroduce a durable config login.
  assert.ok(code.includes('preSeed()'), 'the login route must gate the env credential behind preSeed()');
  assert.ok(code.includes('verifyViaUserStore'), 'the user-store check is still the primary login path');
  assert.ok(code.includes('/internal/admin/users/verify'));
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
  auth._setAuthzResolverForTests(() => ({ userId: 'u1' }));
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

// Reworked for Option C (PR #2094). describeAuthz produces `envAdmin: true` ONLY
// pre-seed (see scope.js + scope.test.js), so that descriptor represents the
// pre-seed bootstrap identity — which requireAuth admits behind IAP. Once
// seeded, an IAP e-mail that merely equals `ADMIN_USERNAME` gets `envAdmin:
// false`, so with no resolved userId it is refused: the #1415 hole (a silent
// empty-scope session for anyone named `admin`) stays closed. Both halves are
// asserted here against `isKnownPrincipal` (main's `envAdmin || userId != null`).
test('requireAuth: admits a PRE-SEED env-admin behind IAP, refuses a post-seed no-record claim (#1415 / Option C)', async (t) => {
  auth._setIapVerifierForTests(iapVerifierFor('admin'));
  t.after(() => { auth._setIapVerifierForTests(null); auth._setAuthzResolverForTests(null); });

  // Pre-seed env-admin (envAdmin: true) → admitted (the bootstrap, behind IAP).
  auth._setAuthzResolverForTests(() => ({ envAdmin: true, admin: true, userId: null }));
  let nextCalled = false;
  await auth.requireAuth(
    { headers: { 'x-goog-iap-jwt-assertion': 'valid-iap-jwt' } },
    { append() {}, status() { throw new Error('pre-seed env-admin must be admitted'); } },
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true, 'pre-seed: the env-admin bootstrap session is admitted');

  // Post-seed: describeAuthz no longer flags envAdmin, so a bare no-record claim
  // is refused — #1415 closed.
  auth._setAuthzResolverForTests(() => ({ envAdmin: false, admin: false, userId: null }));
  const cookies = [];
  let statusCode;
  await auth.requireAuth(
    { headers: { 'x-goog-iap-jwt-assertion': 'valid-iap-jwt' } },
    { append: (k, v) => cookies.push(v), status(c) { statusCode = c; return this; }, json() { return this; } },
    () => { throw new Error('must not pass'); },
  );
  assert.equal(statusCode, 401);
  assert.equal(cookies.length, 0, 'post-seed: no session is issued for a bare env-admin claim');
});

test('requireAuth issues a session for the SEEDED administrator behind IAP', async (t) => {
  // The replacement for the case above: the seeded admin is a real record, so
  // it arrives with a userId and is admitted like any other registered user.
  auth._setIapVerifierForTests(iapVerifierFor('admin'));
  auth._setAuthzResolverForTests(() => ({ admin: true, systemAdmin: true, userId: 'u-seed' }));
  t.after(() => { auth._setIapVerifierForTests(null); auth._setAuthzResolverForTests(null); });

  const res = { append() {}, status() { throw new Error('should not be called'); } };
  let nextCalled = false;
  await auth.requireAuth({ headers: { 'x-goog-iap-jwt-assertion': 'valid-iap-jwt' } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requireAuth rejects an unregistered IAP subject without issuing a cookie', async (t) => {
  auth._setIapVerifierForTests(iapVerifierFor('stranger@accenture.com'));
  auth._setAuthzResolverForTests(() => ({ userId: null }));
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
  auth._setAuthzResolverForTests(() => ({ userId: null })); // reject-all gate
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
    describeAuthz: () => (registered ? { userId: 'u1' } : { userId: null }),
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

// ── The login route (#2059) ─────────────────────────────────────────────────
// Before this ticket the login handler had NO test at all: `registerAuthRoutes`
// was only ever called with a `post: () => {}` stub, so the fallback chain it
// used to contain was uncovered. It is now the console's single login path and
// has to tell three outcomes apart, so it is driven directly here.

// Capture the routes off a minimal app stub, with a stubbed global fetch
// standing in for the orchestrator's user store.
function loginHarness({ storeResponse, usersSeeded = () => true }) {
  const routes = { get: {}, post: {} };
  const app = {
    get: (path, ...rest) => { routes.get[path] = rest[rest.length - 1]; },
    post: (path, ...rest) => { routes.post[path] = rest[rest.length - 1]; },
  };
  auth.registerAuthRoutes(app, {
    describeAuthz: (subject) => ({ userId: `id-of-${subject}`, admin: true }),
    usersSeeded,
  });

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return storeResponse();
  };
  return { routes, calls, restore: () => { globalThis.fetch = original; } };
}

function fakeRes() {
  const out = { cookies: [], status: 200, body: undefined };
  return {
    out,
    append: (k, v) => out.cookies.push(v),
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
  };
}

const storeOk = (subject) => () => ({
  ok: true, status: 200, json: async () => ({ id: 'u-1', subject }),
});
const storeRejects = () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid credentials' }) });

test('login: a store-verified password issues a session for that subject', async (t) => {
  const h = loginHarness({ storeResponse: storeOk('admin') });
  t.after(h.restore);

  const res = fakeRes();
  await h.routes.post['/api/auth/login']({ body: { username: 'admin', password: 'seed-pass' } }, res);

  assert.equal(res.out.status, 200, 'the default status is left untouched on success');
  assert.equal(res.out.body.authenticated, true);
  assert.equal(res.out.body.user.username, 'admin');
  assert.equal(res.out.body.user.userId, 'id-of-admin', 'the authz descriptor is merged on');
  assert.match(res.out.cookies[0], new RegExp(`^${auth.COOKIE_NAME}=`));

  // It asked the user store, and only the user store.
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].url, /\/internal\/admin\/users\/verify$/);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { username: 'admin', password: 'seed-pass' });
  assert.ok(h.calls[0].init.signal, 'the request is bounded by a timeout signal (AC4)');
});

test('login: the store rejecting the credentials is a 401, with no session', async (t) => {
  const h = loginHarness({ storeResponse: storeRejects });
  t.after(h.restore);

  const res = fakeRes();
  await h.routes.post['/api/auth/login']({ body: { username: 'admin', password: 'wrong' } }, res);
  assert.equal(res.out.status, 401);
  assert.equal(res.out.body.error, 'Invalid username or password');
  assert.equal(res.out.cookies.length, 0);
});

test('login: the env credential authenticates PRE-SEED and is rejected once seeded (Option C, PR #2094)', async (t) => {
  // Pre-seed (no user record yet): the store has nothing to match, so it
  // rejects; the env credential is then consulted and authenticates the
  // bootstrap admin so an operator can sign in and trigger the seed.
  const pre = loginHarness({ storeResponse: storeRejects, usersSeeded: () => false });
  const r1 = fakeRes();
  await pre.routes.post['/api/auth/login']({ body: { username: 'env-admin', password: 'env-seed-pw' } }, r1);
  pre.restore();
  assert.equal(r1.out.status, 200, 'pre-seed: the env credential authenticates');
  assert.equal(r1.out.body.user.username, 'env-admin');
  assert.equal(r1.out.cookies.length, 1, 'pre-seed: a session is issued');

  // Wrong env password pre-seed is still a 401 — the compare is real.
  const preBad = loginHarness({ storeResponse: storeRejects, usersSeeded: () => false });
  const r2 = fakeRes();
  await preBad.routes.post['/api/auth/login']({ body: { username: 'env-admin', password: 'nope' } }, r2);
  preBad.restore();
  assert.equal(r2.out.status, 401, 'pre-seed: a wrong env password is rejected');

  // Seeded (a System-Admin record exists): the SAME correct env pair is refused.
  // The one-time window is closed permanently — Option C's core guarantee, and
  // #2059 AC4's intent (no durable config-file login).
  const post = loginHarness({ storeResponse: storeRejects, usersSeeded: () => true });
  const r3 = fakeRes();
  await post.routes.post['/api/auth/login']({ body: { username: 'env-admin', password: 'env-seed-pw' } }, r3);
  post.restore();
  assert.equal(r3.out.status, 401, 'seeded: the env credential no longer authenticates');
  assert.equal(r3.out.cookies.length, 0, 'seeded: no session issued from the env credential');
});

test('login: an unreachable or broken store is a 503, NOT a rejected password', async (t) => {
  // This distinction only exists because #2059 removed the env-credential
  // fallback. Collapsing the two — which is what the old code did by returning
  // null for both — would tell an operator their correct password is wrong
  // while the orchestrator is restarting.
  for (const [label, response] of [
    ['network failure', () => { throw new Error('ECONNREFUSED'); }],
    ['timeout', () => { throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }); }],
    ['500 from the store', () => ({ ok: false, status: 500, json: async () => ({}) })],
    ['unparseable 200', () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })],
    ['200 with no subject', () => ({ ok: true, status: 200, json: async () => ({ id: 'u-1' }) })],
  ]) {
    const h = loginHarness({ storeResponse: response });
    const res = fakeRes();
    await h.routes.post['/api/auth/login']({ body: { username: 'admin', password: 'seed-pass' } }, res);
    h.restore();

    assert.equal(res.out.status, 503, `${label} → 503`);
    assert.equal(res.out.body.code, 'user_store_unavailable', `${label} → machine-readable code`);
    assert.equal(res.out.cookies.length, 0, `${label} → no session`);
    assert.ok(!/password/i.test(res.out.body.error), `${label} must not blame the password`);
  }
});

test('login: a missing body is a rejection, not a crash', async (t) => {
  const h = loginHarness({ storeResponse: storeRejects });
  t.after(h.restore);
  const res = fakeRes();
  await h.routes.post['/api/auth/login']({}, res);
  assert.equal(res.out.status, 401);
});

// ── The readiness probe (#2059 AC3) ────────────────────────────────────────

test('ready: reports whether the stack has a user to sign in as', async (t) => {
  const routes = {};
  const app = { get: (p, ...r) => { routes[p] = r[r.length - 1]; }, post: () => {} };

  let seeded = false;
  auth.registerAuthRoutes(app, { usersSeeded: () => seeded });
  t.after(() => auth._setAuthzResolverForTests(null));

  let res = fakeRes();
  routes['/api/auth/ready']({}, res);
  assert.equal(res.out.status, 503, 'not seeded yet → 503, so a poll keeps waiting');
  assert.deepEqual(res.out.body, { ready: false });

  seeded = true;
  res = fakeRes();
  routes['/api/auth/ready']({}, res);
  assert.equal(res.out.status, 200);
  assert.deepEqual(res.out.body, { ready: true }, 'one boolean — never a count or a name');
});

test('ready: fails closed when the probe throws or is absent', async () => {
  const routes = {};
  const app = { get: (p, ...r) => { routes[p] = r[r.length - 1]; }, post: () => {} };

  auth.registerAuthRoutes(app, { usersSeeded: () => { throw new Error('users index unreadable'); } });
  let res = fakeRes();
  routes['/api/auth/ready']({}, res);
  assert.equal(res.out.status, 503);
  assert.equal(res.out.body.ready, false);

  // No probe injected at all (a caller that predates #2059) → not ready.
  auth.registerAuthRoutes(app, {});
  res = fakeRes();
  routes['/api/auth/ready']({}, res);
  assert.equal(res.out.body.ready, false);
});

test('gate: the readiness probe is public, everything else still needs a session', async () => {
  const publicPaths = ['/auth/login', '/auth/logout', '/auth/session', '/auth/ready'];
  for (const p of publicPaths) {
    let passed = false;
    auth.gate({ path: p, headers: {} }, fakeRes(), () => { passed = true; });
    assert.equal(passed, true, `${p} must be reachable without a session`);
  }
  // A protected path still goes through requireAuth and is refused.
  const res = fakeRes();
  await auth.gate({ path: '/agents', headers: {} }, res, () => { throw new Error('must not pass'); });
  assert.equal(res.out.status, 401);
});
