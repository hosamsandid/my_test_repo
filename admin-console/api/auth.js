'use strict';

// Admin Console authentication (#276).
//
// Minimal, SSO-ready auth foundation: a single env-configured credential pair,
// a signed stateless session cookie, and an Express gate. The whole console is
// served behind this — the SPA loads, asks GET /api/auth/session, and shows a
// login screen until a valid session cookie exists.
//
// ── SSO swap-point ─────────────────────────────────────────────────────────
// The ONLY thing an enterprise OIDC/SAML integration needs to replace is
// `verifyCredentials()` (and add its own callback route that calls
// `issueToken()` + `setSessionCookie()`). The session format, cookie handling,
// middleware and the entire login UI/routing stay unchanged — they only ever
// deal with an opaque "session" carrying a subject. See docs/multi-user-concept.md.

const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const COOKIE_NAME = 'aee_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Credentials come from the environment so they can change without a redeploy.
// Defaults are intentionally weak for first-boot local use and MUST be changed
// for any shared/enterprise deployment (documented in .env.example).
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// Secret that signs session tokens. When no explicit secret is set we derive a
// stable one from the credentials with scrypt — a deliberately expensive KDF
// (not a single-pass hash) — using a fixed salt so the value is deterministic.
// This makes sessions survive a server restart AND auto-invalidates every
// existing session the moment the password changes.
const SESSION_SECRET =
  process.env.AUTH_SESSION_SECRET ||
  crypto.scryptSync(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`, 'aee-session-secret-v1', 32).toString('hex');

// Set the cookie's Secure attribute only when served over TLS. Defaults off so
// the cookie works on plain http://localhost; set AUTH_COOKIE_SECURE=true when
// the console sits behind HTTPS.
const COOKIE_SECURE = String(process.env.AUTH_COOKIE_SECURE || '').toLowerCase() === 'true';

// Orchestrator base URL — used to verify per-user local passwords (#374). The
// user store lives in the orchestrator; verification is best-effort so the env
// admin below always works even when the orchestrator is unreachable.
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';

// Best-effort per-user login (#374). Returns an authenticated principal
// { sub: <subject> } when the user store accepts the credentials, else null
// (unknown user, no password, wrong password, or orchestrator unreachable).
async function verifyViaUserStore(username, password) {
  try {
    const resp = await fetch(`${ORCHESTRATOR_URL}/internal/admin/users/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!resp.ok) return null;
    const user = await resp.json();
    return user && typeof user.subject === 'string' ? { sub: user.subject } : null;
  } catch {
    return null; // orchestrator down → fall through to the env admin credential
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

// ── Constant-time credential digest ─────────────────────────────────────────
// scrypt (a strong, deliberately expensive KDF) derives a fixed-length digest
// from each value before a timing-safe comparison. Using a KDF rather than a
// fast hash means the password never flows into weak hashing, and the
// fixed-length output makes the comparison constant-time. Login is rate-limited,
// so the per-attempt KDF cost is irrelevant.
const COMPARE_SALT = 'aee-credential-compare-v1';
function scryptDigest(value) {
  return crypto.scryptSync(String(value), COMPARE_SALT, 32);
}
function safeEqual(a, b) {
  return crypto.timingSafeEqual(scryptDigest(a), scryptDigest(b));
}

// ── Credential check (SSO swap-point) ────────────────────────────────────────
// Returns an authenticated principal `{ sub }` on success, or null on failure.
// Replace the body with an IdP token exchange to add SSO; keep the signature.
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
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Authentication required', code: 'unauthenticated' });
  }
  req.user = { username: session.sub };
  next();
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
function registerAuthRoutes(app, { describeAuthz } = {}) {
  const buildUser = (subject) => {
    const base = { username: subject };
    if (typeof describeAuthz !== 'function') return base;
    try {
      return { ...base, ...(describeAuthz(subject) || {}) };
    } catch {
      return base;
    }
  };

  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    // 1) Per-user local password (#374), best-effort. 2) the env single-admin
    // credential (#276), which always works even if the user store is down.
    const principal = (await verifyViaUserStore(username, password)) || verifyCredentials(username, password);
    if (!principal) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    setSessionCookie(res, issueToken(principal.sub));
    res.json({ authenticated: true, user: buildUser(principal.sub) });
  });

  app.get('/api/auth/session', (req, res) => {
    const session = getSession(req);
    if (!session) return res.json({ authenticated: false });
    res.json({ authenticated: true, user: buildUser(session.sub) });
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
  if (req.path === '/auth/login' || req.path === '/auth/logout' || req.path === '/auth/session') {
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
};
