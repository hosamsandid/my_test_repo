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
const path = require('path');

const ADMIN_PORT = process.env.ADMIN_PORT || '4010';
const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${ADMIN_PORT}`;
const isCI = !!process.env.CI;

// The `journey-video` project (#712, docs/journey-spec-concept.md §3.3) reruns the
// journeys with video recording + slowMo to produce one .webm per journey for the
// walkthrough video. It is opt-in via E2E_VIDEO=1 so it never runs in the default
// suite (`make e2e`), the PR gate, or the before/after screenshot lane
// (ui-screenshots.yml `--project=journeys`) — those would otherwise pay the video
// + slowMo cost or run the journeys twice. `make video-journeys` / the CI video
// step set the flag and target the project explicitly.
const withVideo = process.env.E2E_VIDEO === '1';

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
    // Fake media device for the STT UI tests: Chromium serves the fixture WAV
    // through MediaRecorder instead of requiring a real microphone.
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${path.resolve(__dirname, 'fixtures/audio/stt-test.wav')}`,
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      testDir: './tests',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Journey runner (#705, docs/journey-spec-concept.md §3.1). A normal
      // Playwright project beside the specs — journeys are just tests, so
      // trace/retries/reporters work unchanged. Screenshot determinism (§7) is
      // pinned here: fixed viewport, light scheme, reduced motion; the recorder
      // adds an animation-killing stylesheet + volatile masks at capture time.
      name: 'journeys',
      testDir: './journey-runner',
      testMatch: /.*\.spec\.js$/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        colorScheme: 'light',
        reducedMotion: 'reduce',
      },
    },
    // Video variant of the journeys project (#712, §3.3 item 1). Same spec, same
    // deterministic viewport/scheme — plus video recording and slowMo so the
    // walkthrough clip is watchable. journeys.spec.js saves the recording to
    // artifacts/<journeyId>/journey.webm on success (only), alongside the
    // screenshots from the same run. Opt-in (E2E_VIDEO=1) so it is skipped unless
    // explicitly requested — see `withVideo` above.
    ...(withVideo
      ? [
          {
            name: 'journey-video',
            testDir: './journey-runner',
            testMatch: /.*\.spec\.js$/,
            // slowMo (350 ms/interaction) inflates every step, and the afterEach
            // hook closes the page + finalises the .webm before the test ends —
            // both eat into the per-test budget. The default 60 s is too tight for
            // a multi-step wizard journey recorded this way, so give the recording
            // run a 5-min ceiling (matches the longer journeys' own timeoutMs).
            timeout: 300_000,
            use: {
              ...devices['Desktop Chrome'],
              viewport: { width: 1440, height: 900 },
              deviceScaleFactor: 1,
              colorScheme: 'light',
              reducedMotion: 'reduce',
              video: { mode: 'on', size: { width: 1440, height: 900 } },
              launchOptions: { slowMo: Number(process.env.E2E_SLOWMO || 350) },
            },
          },
        ]
      : []),
  ],
});
