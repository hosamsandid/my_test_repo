'use strict';

// Admin Console authentication (#276, reworked by #2059).
//
// Minimal, SSO-ready auth foundation: a signed stateless session cookie and an
// Express gate. The whole console is served behind this — the SPA loads, asks
// GET /api/auth/session, and shows a login screen until a valid session cookie
// exists.
//
// ── Login path (#2059 + Option C, PR #2094; concept #2041 D13) ───────────────
// A password login is checked against the USER STORE first. `ADMIN_USERNAME`/
// `ADMIN_PASSWORD` are primarily the SEED the orchestrator consumes at first boot
// to create a real System-Admin record (`orchestrator/initial-admin-seed.js`),
// but — per the human ruling on the #2059↔#1457 reconciliation — they ALSO serve
// as a ONE-TIME PRE-SEED FALLBACK: the login route consults `verifyCredentials`
// against them only while the store holds no user record yet (gated by
// `preSeed()`), so an operator can sign in to a fresh install and trigger the
// seed. The moment the seed has run that fallback is retired permanently — no
// durable config-file login. Once seeded, every session resolves to a real user
// id, and while the user store is unreachable nobody can sign in — so recovering
// a lost identity is a host-level action on `/workspace/users/index.json`, not a
// console login (docs/governance-concept.md GOV-ACCESS-7).
//
// ── SSO swap-point ─────────────────────────────────────────────────────────
// An enterprise OIDC/SAML integration replaces `verifyViaUserStore()` (and adds
// its own callback route calling `issueToken()` + `setSessionCookie()`). The
// session format, cookie handling, middleware and the entire login UI/routing
// stay unchanged — they only ever deal with an opaque "session" carrying a
// subject. See docs/multi-user-concept.md.
//
// ── IAP bridge (SSO, hosted stacks) ─────────────────────────────────────────
// When IAP_AUDIENCE is set, a request without a session cookie may instead
// authenticate via the Google-IAP-signed JWT it carries (see iap-auth.js): a
// normal session is issued for the JWT's email — but only when that email is a
// registered user-store subject (#1415). Any other identity that merely passed
// Google IAP falls through to the login form instead of getting a silent
// empty-scope session. The registration lookup fails CLOSED: an unreadable
// users index (or a throw in the injected resolver) is treated as unregistered.
// Since #2059 the seeded administrator IS such a record, so the bridge needs no
// separate env-admin arm — and an identity that merely happens to be *named*
// `admin` is no longer admitted. Behind IAP, "logout" is cosmetic — the next
// request re-authenticates via the proxy (true sign-out is the Google
// account's, or /?gcp-iap-mode=CLEAR_LOGIN_COOKIE).

const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { makeIapVerifier, IAP_JWT_HEADER } = require('./iap-auth');
const { isKnownPrincipal } = require('./scope');
const { resolveSessionSecret } = require('./session-secret');

const COOKIE_NAME = 'aee_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Secret that signs session tokens: `AUTH_SESSION_SECRET`, else a random key
// persisted once on the workspace volume. See session-secret.js for why this is
// no longer derived from the configured credential pair (#2059 AC4).
const { secret: SESSION_SECRET, source: SESSION_SECRET_SOURCE } = resolveSessionSecret();
if (SESSION_SECRET_SOURCE === 'ephemeral') {
  console.warn(
    '[auth] Session signing key could not be persisted — sessions will not survive a restart. '
    + 'Set AUTH_SESSION_SECRET, or make the workspace volume writable.',
  );
}

// Set the cookie's Secure attribute only when served over TLS. Defaults off so
// the cookie works on plain http://localhost; set AUTH_COOKIE_SECURE=true when
// the console sits behind HTTPS.
const COOKIE_SECURE = String(process.env.AUTH_COOKIE_SECURE || '').toLowerCase() === 'true';

// Orchestrator base URL — the user store lives there, and since #2059 it is the
// ONLY thing a password login is checked against.
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';

// How long to wait for that check. Node's global fetch has no request timeout —
// only a ~300 s headers timeout — so a hung (as opposed to refused) orchestrator
// socket used to cost the user nothing, because the env-credential fallback
// fired underneath it. With that fallback gone the same stall would hang the
// login for minutes with no answer, so the request is bounded here and a slow
// store reports itself as unavailable instead (#2059 AC4: "fails fast rather
// than hanging"). The bring-up's readiness poll is what absorbs a still-booting
// orchestrator; this only has to fail quickly and truthfully.
const USER_STORE_TIMEOUT_MS = 5000;

// Verify a password login against the user store. Returns a discriminated
// result rather than a bare principal-or-null, because the two failure modes
// now have to be told apart: with no fallback left, "wrong password" is a 401 the
// user should re-read, while "the store did not answer" is a 503 that is not
// their fault and that a retry may fix. Collapsing them — which is what the old
// `return null` did — would tell an operator their correct password is wrong
// while the orchestrator restarts.
async function verifyViaUserStore(username, password) {
  let resp;
  try {
    resp = await fetch(`${ORCHESTRATOR_URL}/internal/admin/users/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(USER_STORE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unavailable' }; // unreachable, or timed out
  }

  // 401 is the store's own "unknown subject / no password / wrong password" —
  // deliberately indistinguishable to us, as it should be to the caller.
  if (resp.status === 401) return { ok: false, reason: 'invalid' };
  if (!resp.ok) return { ok: false, reason: 'unavailable' };

  try {
    const user = await resp.json();
    if (user && typeof user.subject === 'string') return { ok: true, principal: { sub: user.subject } };
  } catch { /* a 200 we cannot parse is a broken store, not a bad password */ }
  return { ok: false, reason: 'unavailable' };
}

// IAP identity bridge — inert unless IAP_AUDIENCE is set (only the GKE stack
// sets it; format `/projects/<project-number>/global/backendServices/<id>`).
const IAP_AUDIENCE = process.env.IAP_AUDIENCE || '';
let iapVerify = IAP_AUDIENCE ? makeIapVerifier({ audience: IAP_AUDIENCE }) : null;

// Test seam: swap the verifier without touching the network/env.
function _setIapVerifierForTests(fn) {
  iapVerify = fn;
}

// Resolves the request's IAP identity, or null (bridge disabled, no header,
// or an invalid/forged assertion). Never throws.
async function getIapPrincipal(req) {
  if (!iapVerify) return null;
  const raw = req && req.headers && req.headers[IAP_JWT_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) return null;
  try {
    return await iapVerify(token);
  } catch {
    return null;
  }
}

// The describeAuthz resolver injected via registerAuthRoutes, held at module
// level because requireAuth is mounted separately (via `gate`) — api.js calls
// registerAuthRoutes before mounting the gate, so it is set before any request.
let authzResolver = null;

// Test seam: swap the resolver without going through registerAuthRoutes.
function _setAuthzResolverForTests(fn) {
  authzResolver = fn;
}

// IAP principal that is also allowed to auto-login (#1415): the JWT must
// verify AND its email must be a known console principal — a registered
// user-store subject or the env admin. Unknown → null, so the caller falls
// through to 401 / the login form. Fail-closed: a throw or falsy descriptor
// from the resolver counts as unregistered (an unreadable users index already
// degrades to [] in api.js's readJsonFile and lands here as "unknown").
// With NO resolver injected (registerAuthRoutes called without describeAuthz)
// legacy behavior is kept — every verified IAP principal is allowed; api.js
// always injects it in production.
async function resolveIapPrincipal(req) {
  const iap = await getIapPrincipal(req);
  if (!iap) return null;
  if (typeof authzResolver !== 'function') return iap;
  try {
    return isKnownPrincipal(authzResolver(iap.sub)) ? iap : null;
  } catch {
    return null;
  }
}

// Brute-force protection for the login endpoint.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait and try again.' },
});

// ── Env-configured admin credential — the ONE-TIME SEED WINDOW ───────────────
// #2059 originally deleted this (its AC4: "the configured credential never
// authenticates"). The human ruling on the #2059↔#1457 reconciliation
// ("Option C", PR #2094) restored it under a strict gate: the env credential
// authenticates ONLY in the pre-seed state — while no System-Admin record exists
// yet (a fresh / not-yet-activated install). The login route's `preSeed()` gate
// stops consulting it the moment `seedInitialSystemAdmin` has run, permanently,
// so it is a bootstrap seed, never a durable config-file login (#2059 AC4's
// intent preserved). The scrypt password check for real user records lives in
// the store (`orchestrator/teams-store.js` `verifyPassword`).
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const COMPARE_SALT = 'aee-credential-compare-v1';
function scryptDigest(value) {
  return crypto.scryptSync(String(value), COMPARE_SALT, 32);
}
function safeEqual(a, b) {
  return crypto.timingSafeEqual(scryptDigest(a), scryptDigest(b));
}
// Returns an authenticated principal `{ sub }` on success, or null on failure.
// Callers MUST gate this behind the pre-seed check (see the login route).
function verifyCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  // Evaluate both comparisons unconditionally to avoid leaking which one failed.
  const userOk = safeEqual(username, ADMIN_USERNAME);
  const passOk = safeEqual(password, ADMIN_PASSWORD);
  return userOk && passOk ? { sub: ADMIN_USERNAME } : null;
}

// ── Session token (signed, stateless) ────────────────────────────────────────
function sign(payloadB64) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
}

function issueToken(subject, now = Date.now()) {
  const payload = { sub: subject, iat: now, exp: now + SESSION_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function verifyToken(token, now = Date.now()) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < now) return null;
  return payload;
}

// ── Cookies ───────────────────────────────────────────────────────────────
function parseCookies(req) {
  const header = (req && req.headers && req.headers.cookie) || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function getSession(req) {
  return verifyToken(parseCookies(req)[COOKIE_NAME]);
}

function setSessionCookie(res, token) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (COOKIE_SECURE) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = [`${COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (COOKIE_SECURE) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

// ── Express integration ─────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const session = getSession(req);
  if (session) {
    req.user = { username: session.sub };
    return next();
  }
  // No cookie session — behind IAP the request may still carry a verified
  // identity of a registered user. Issue a regular session for it so
  // subsequent requests take the cheap cookie path.
  const iap = await resolveIapPrincipal(req);
  if (iap) {
    setSessionCookie(res, issueToken(iap.sub));
    req.user = { username: iap.sub };
    return next();
  }
  return res.status(401).json({ error: 'Authentication required', code: 'unauthenticated' });
}

// Registers the public auth endpoints. Must be called BEFORE the gate so these
// routes stay reachable without a session.
//
// `describeAuthz(subject)` is an optional injected resolver that returns the
// caller's authorization descriptor (admin/System-Admin indicator + per-team
// roles, #584) to merge onto the session `user`. It is injected rather than
// imported so this module stays free of the users/memberships file IO (which
// lives in api.js) and provider-agnostic. Best-effort: a throw degrades to the
// bare `{ username }` shape rather than failing the request.
//
// The same resolver also gates IAP auto-login (#1415) via resolveIapPrincipal,
// where the semantics differ: there a throw or unknown subject fails CLOSED
// (no silent session — the login form appears). Called without a resolver, the
// IAP gate reverts to the legacy allow-all behavior.
//
// `usersSeeded()` answers "does the user store hold at least one record", for
// the readiness probe below (#2059 AC3). Injected for the same reason as
// `describeAuthz`: the users-index file IO lives in api.js.
function registerAuthRoutes(app, { describeAuthz, usersSeeded } = {}) {
  authzResolver = describeAuthz;
  const buildUser = (subject) => {
    const base = { username: subject };
    if (typeof describeAuthz !== 'function') return base;
    try {
      return { ...base, ...(describeAuthz(subject) || {}) };
    } catch {
      return base;
    }
  };

  // Option C (PR #2094): the env-configured admin credential is consultable ONLY
  // in the pre-seed state — `usersSeeded() === true` (a user record, hence the
  // seeded System-Admin, exists) closes it permanently. Fail closed (treat as
  // seeded, env NOT consulted) if the check cannot answer: a fresh install
  // answers `false` reliably because the seed writes the users index at boot, so
  // an unanswerable check is an error state rather than a genuinely fresh one.
  const preSeed = () => {
    try { return typeof usersSeeded === 'function' && usersSeeded() === false; }
    catch { return false; }
  };

  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    // The user store is the primary login path (#2059). A store that cannot
    // answer is reported as such rather than as a rejected password.
    const result = await verifyViaUserStore(username, password);
    if (result.ok) {
      setSessionCookie(res, issueToken(result.principal.sub));
      return res.json({ authenticated: true, user: buildUser(result.principal.sub) });
    }
    if (result.reason === 'unavailable') {
      return res.status(503).json({
        error: 'The user store is unavailable, so sign-in cannot be verified right now. '
          + 'If the stack has just started, try again in a moment.',
        code: 'user_store_unavailable',
      });
    }
    // Pre-seed only: the env credential lets an operator sign in to a fresh
    // install and trigger the seed. Once seeded, this branch is dead (Option C).
    if (preSeed()) {
      const envPrincipal = verifyCredentials(username, password);
      if (envPrincipal) {
        setSessionCookie(res, issueToken(envPrincipal.sub));
        return res.json({ authenticated: true, user: buildUser(envPrincipal.sub) });
      }
    }
    return res.status(401).json({ error: 'Invalid username or password' });
  });

  // Readiness for the bring-up (#2059 AC3). The console starts without waiting
  // for the orchestrator (`depends_on` names only conduwuit), so a login can
  // arrive before the first-boot seed has landed — which now FAILS where it used
  // to succeed via the env credential. This is the probe a bring-up script polls
  // before it tries to sign in.
  //
  // It reads the users index off the shared volume rather than calling the
  // orchestrator: the seed is written there (atomically, via rename) before the
  // internal API accepts a single request, so the file's own state IS the answer
  // — no network hop, and nothing an unauthenticated caller can amplify. The
  // payload is one boolean on purpose: "is this stack ready to be signed in to",
  // never how many users exist or who they are.
  app.get('/api/auth/ready', (req, res) => {
    let ready = false;
    try {
      ready = typeof usersSeeded === 'function' ? usersSeeded() === true : false;
    } catch {
      ready = false;
    }
    res.status(ready ? 200 : 503).json({ ready });
  });

  app.get('/api/auth/session', async (req, res) => {
    const session = getSession(req);
    if (session) return res.json({ authenticated: true, user: buildUser(session.sub) });
    // Behind IAP the very first session probe already authenticates a
    // registered user — the SPA never shows them the login form. Unregistered
    // IAP identities stay unauthenticated and get the form (#1415).
    const iap = await resolveIapPrincipal(req);
    if (iap) {
      setSessionCookie(res, issueToken(iap.sub));
      return res.json({ authenticated: true, user: buildUser(iap.sub) });
    }
    res.json({ authenticated: false });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ authenticated: false });
  });
}

// Gate every /api/* route except the public auth endpoints. Mount this right
// after registerAuthRoutes and before the protected route definitions.
function gate(req, res, next) {
  // req.path here is relative to the '/api' mount, e.g. '/auth/login'.
  // `/auth/ready` is public for the same reason as `/auth/session`: a bring-up
  // has no session yet and must be able to ask whether signing in can work.
  if (
    req.path === '/auth/login' || req.path === '/auth/logout'
    || req.path === '/auth/session' || req.path === '/auth/ready'
  ) {
    return next();
  }
  return requireAuth(req, res, next);
}

module.exports = {
  COOKIE_NAME,
  verifyCredentials,
  issueToken,
  verifyToken,
  getSession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  registerAuthRoutes,
  gate,
  _setIapVerifierForTests,
  _setAuthzResolverForTests,
};
