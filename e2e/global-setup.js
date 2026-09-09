// Playwright global setup for the AEE E2E suite (#666, docs/e2e-testing-concept.md §5).
//
// Two responsibilities, in order:
//   1. Bring the disposable `aee-e2e` stack up from a clean state (delegated to
//      scripts/stack-up.sh — the single source of truth also used by
//      `make e2e-up`). Skipped when E2E_SKIP_STACK=1, i.e. the stack is already
//      running (authoring loop: `make e2e-up` then Playwright UI mode).
//   2. Log in once through the REAL #276 session gate and persist Playwright
//      storageState, so every spec starts authenticated (§5 — no auth backdoor;
//      the login itself is part of what F0 covers via the unauthenticated spec).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { request } = require('@playwright/test');

const ADMIN_PORT = process.env.ADMIN_PORT || '4010';
const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${ADMIN_PORT}`;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'e2e-admin-pass';
const AUTH_DIR = path.join(__dirname, '.auth');
const STATE_PATH = path.join(AUTH_DIR, 'state.json');

module.exports = async () => {
  if (process.env.E2E_SKIP_STACK === '1') {
    console.log('[global-setup] E2E_SKIP_STACK=1 — assuming stack is already up');
  } else {
    console.log('[global-setup] bringing up the aee-e2e stack …');
    execFileSync(path.join(__dirname, 'scripts', 'stack-up.sh'), {
      stdio: 'inherit',
    });
  }

  // Authenticate via the real login route and snapshot the signed session
  // cookie into storageState. HttpOnly cookies are captured by the request
  // context's cookie jar, so the browser contexts inherit an authenticated
  // session with no UI login per spec.
  //
  // Deliberately UNCHANGED by #2059 (AC2): same endpoint, same credentials. It
  // now resolves to a real user record — the one the orchestrator seeded from
  // those same credentials at first boot — instead of the recordless env
  // principal. The readiness wait that makes this safe lives in
  // `scripts/post-up-config.sh`, which stack-up.sh runs before we get here.
  console.log('[global-setup] logging in to persist storageState …');
  const ctx = await request.newContext({ baseURL: BASE_URL });
  const res = await ctx.post('/api/auth/login', {
    data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  if (!res.ok()) {
    // 503 `user_store_unavailable` is its own diagnosis since #2059: the login
    // was not rejected, the user store did not answer — so the seed has not
    // landed (or the orchestrator is down), and nothing here is retried.
    const hint = res.status() === 503
      ? ' — the user store did not answer; check GET /api/auth/ready and the orchestrator log'
      : '';
    throw new Error(
      `[global-setup] login failed: HTTP ${res.status()} ${await res.text()}${hint}`,
    );
  }
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await ctx.storageState({ path: STATE_PATH });
  await ctx.dispose();
  console.log(`[global-setup] storageState written to ${STATE_PATH}`);
};
