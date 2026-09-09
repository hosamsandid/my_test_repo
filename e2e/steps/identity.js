// Two-human identity plumbing for the journey runner (#2086, epic #2076 AC13).
//
// WHY THIS EXISTS
// ---------------
// Every journey before this one ran as ONE identity: global-setup.js logs in as
// the env admin (ADMIN_USERNAME/ADMIN_PASSWORD) once, snapshots the session into
// .auth/state.json, and playwright.config.js hands that storageState to every
// project. That identity is the implicit System Admin (`computeScope` →
// `all: true`), so no visibility or authorization predicate can fail for it —
// which is exactly why AC13's "user B does not see A's team" journey was
// recorded as blocked rather than merely unwritten.
//
// This module is the missing half: it mints real user-store records with local
// passwords (#374/#1844), signs each one in through the REAL login route into
// its OWN browser context, and lets a step point the journey's `ctx` at one of
// them. No auth backdoor — the same discipline global-setup.js follows.
//
// WHY IT IS NOT A STEP MODULE
// ---------------------------
// `step-registry.js` registers EVERY exported function of a module listed in
// STEP_MODULES as a journey step. These are helpers a fixture composes, not
// vocabulary a journey should name, so this module is deliberately absent from
// that list — the `team.js` / `member-ids.js` arrangement. The journey-callable
// verbs live in `access.js`, which imports from here.
//
// THE SEAM
// --------
// `journeys.spec.js` builds `ctx = { page, request }` ONCE and passes that same
// object to every fixture and every step. So `ctx` is the natural place to hang
// the extra identities, and swapping `ctx.page` / `ctx.request` re-points the
// WHOLE existing step library at another human for free — including the
// recorder, which reads `ctx.page` fresh at each capture. That is the §9
// anti-DSL rule honoured: the new capability lands in the step library, and the
// journey schema learns nothing about identities.
const { expect } = require('@playwright/test');

const ADMIN_PORT = process.env.ADMIN_PORT || '4010';
const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${ADMIN_PORT}`;

// Match the `journeys` project's rendering options (playwright.config.js) so a
// screenshot taken in a second identity's context is byte-comparable with one
// taken in the primary `page` fixture. Drift here would show up as a spurious
// visual diff rather than as an error, so it is spelled out rather than assumed.
const CONTEXT_OPTIONS = {
  baseURL: BASE_URL,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  reducedMotion: 'reduce',
};

// Identity registry, hung off the journey's own ctx (never module state) so two
// journeys in one worker cannot see each other's sessions.
function registry(ctx) {
  if (!ctx.__identities) {
    ctx.__identities = {
      // The primary Playwright fixtures — the env admin. Registered under a
      // name so `access.actAs: admin` can always get back to full visibility.
      admin: { name: 'admin', page: ctx.page, request: ctx.request, context: null },
      active: 'admin',
      origin: { page: ctx.page, request: ctx.request },
    };
  }
  return ctx.__identities;
}

function getIdentity(ctx, name) {
  const reg = registry(ctx);
  const found = reg[name];
  if (!found || typeof found !== 'object' || !found.page) {
    const known = Object.keys(reg).filter(k => reg[k] && reg[k].page).join(', ');
    throw new Error(
      `identity "${name}" is not signed in — known identities: ${known}. `
      + 'Declare it in the twoHumanTeam fixture before a step acts as it.',
    );
  }
  return found;
}

// Point the journey's ctx at one identity. Every subsequent step — and every
// screenshot — runs as that human until the next call.
function activate(ctx, name) {
  const id = getIdentity(ctx, name);
  ctx.page = id.page;
  ctx.request = id.request;
  registry(ctx).active = name;
  return id;
}

function activeName(ctx) {
  return registry(ctx).active;
}

// ── User-store records ──────────────────────────────────────────────────────

/**
 * Look up a user record by login subject. Returns the record or null.
 * Runs as the ADMIN identity's request context regardless of who is active —
 * `/api/admin/users` is System-Admin-only and this is fixture plumbing.
 */
async function findUserBySubject(ctx, subject) {
  const admin = getIdentity(ctx, 'admin');
  const res = await admin.request.get('/api/admin/users');
  if (!res.ok()) return null;
  const users = await res.json();
  if (!Array.isArray(users)) return null;
  const wanted = String(subject).toLowerCase();
  return users.find(u => u && String(u.subject || '').toLowerCase() === wanted) || null;
}

/**
 * Create a user record with a local password, idempotently: an existing record
 * with the same subject is reused (and its password re-set), so a crashed prior
 * run cannot wedge the next one.
 *
 * The password is set through the real admin route, and the sign-in below goes
 * through the real `/api/auth/login` — so the journey exercises the actual
 * per-user credential path (#374), not a test-only shortcut.
 */
async function ensureUser(ctx, { subject, displayName, email, password }) {
  const admin = getIdentity(ctx, 'admin');
  let user = await findUserBySubject(ctx, subject);
  if (!user) {
    const res = await admin.request.post('/api/admin/users', {
      data: { subject, displayName: displayName || subject, email: email || subject },
    });
    expect(
      res.ok(),
      `ensureUser(${subject}) create expected 2xx, got HTTP ${res.status()}: ${await res.text()}`,
    ).toBeTruthy();
    user = await res.json();
  }
  const pw = await admin.request.post(
    `/api/admin/users/${encodeURIComponent(user.id)}/password`,
    { data: { password } },
  );
  expect(
    pw.ok(),
    `ensureUser(${subject}) set-password expected 2xx, got HTTP ${pw.status()}: ${await pw.text()}`,
  ).toBeTruthy();
  return user;
}

/**
 * Delete a user record by subject. Best-effort and idempotent (absent = done).
 *
 * ORDER MATTERS AT THE CALL SITE: #2081's D4 rule refuses to delete a human who
 * is still the last Team Admin of any team, so the fixture tears the TEAM down
 * first. Deleting the team cascades its memberships, which is what makes the
 * user deletable at all.
 */
async function deleteUserBySubject(ctx, subject) {
  const admin = getIdentity(ctx, 'admin');
  const user = await findUserBySubject(ctx, subject);
  if (!user) return;
  const res = await admin.request.delete(`/api/admin/users/${encodeURIComponent(user.id)}`);
  expect(
    [200, 204, 404].includes(res.status()),
    `deleteUserBySubject(${subject}) expected 200/204/404, got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

/**
 * Sign a user-store identity in through the real login route, into its own
 * browser context, and register it under `name`.
 *
 * The context's own `request` shares its cookie jar, so API assertions made as
 * this identity carry exactly the session the browser carries — which is what
 * makes "the UI hides it AND the server refuses it" two honest, separate
 * assertions rather than one restated twice.
 */
async function signIn(ctx, { name, subject, password }) {
  const reg = registry(ctx);
  const browser = reg.origin.page.context().browser();
  if (!browser) throw new Error('signIn: no browser available from the primary page context');

  const browserContext = await browser.newContext(CONTEXT_OPTIONS);
  const res = await browserContext.request.post('/api/auth/login', {
    data: { username: subject, password },
  });
  if (!res.ok()) {
    await browserContext.close();
    throw new Error(
      `signIn(${name}/${subject}) failed: HTTP ${res.status()} ${await res.text()}`,
    );
  }
  const page = await browserContext.newPage();
  reg[name] = { name, page, request: browserContext.request, context: browserContext };
  return reg[name];
}

/**
 * Restore the primary fixtures and close every extra browser context.
 *
 * Restoring FIRST matters: `journeys.spec.js` runs fixture teardown in a
 * `finally`, and its afterEach video hook plus the recorder still reference the
 * original `page` fixture — leaving `ctx.page` pointing at a closed context
 * would turn a clean failure into a confusing one.
 */
async function disposeIdentities(ctx) {
  const reg = ctx.__identities;
  if (!reg) return;
  ctx.page = reg.origin.page;
  ctx.request = reg.origin.request;
  reg.active = 'admin';
  for (const key of Object.keys(reg)) {
    const id = reg[key];
    if (!id || typeof id !== 'object' || !id.context) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await id.context.close();
    } catch (err) {
      console.error(`[identity] closing context for ${key} failed (ignored): ${err.message}`);
    }
  }
  delete ctx.__identities;
}

module.exports = {
  BASE_URL,
  CONTEXT_OPTIONS,
  registry,
  getIdentity,
  activate,
  activeName,
  findUserBySubject,
  ensureUser,
  deleteUserBySubject,
  signIn,
  disposeIdentities,
};
