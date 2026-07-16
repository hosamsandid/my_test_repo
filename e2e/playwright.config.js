// Playwright config for the AEE E2E suite (#666, docs/e2e-testing-concept.md §3, §7).
//
// Discipline encoded here:
//   - workers: 1 — phase-1 flows mutate shared stack state; correctness before
//     parallelism (§5).
//   - retries: 1 in CI with trace on-first-retry — the only realistic way to
//     debug a flaky async failure that happened in CI at 3am (§3, §7). No
//     retries locally so flakiness is visible while authoring.
//   - No global timeout knobs beyond Playwright's auto-waiting defaults; specs
//     assert on user-visible state, never sleep (§7).
const { defineConfig, devices } = require('@playwright/test');

const ADMIN_PORT = process.env.ADMIN_PORT || '4010';
const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${ADMIN_PORT}`;
const isCI = !!process.env.CI;

module.exports = defineConfig({
  testDir: './tests',
  // Global setup brings up the stack + logs in (storageState); teardown wipes it.
  globalSetup: require.resolve('./global-setup.js'),
  globalTeardown: require.resolve('./global-teardown.js'),
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI
    ? [['list'], ['html', { open: 'never' }], ['github']]
    : [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    // Authenticated state captured once in global-setup and reused by every
    // spec. The unauthenticated-redirect spec opts out via test.use.
    storageState: './.auth/state.json',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
