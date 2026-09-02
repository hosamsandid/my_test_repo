// @ts-check
// STT e2e tests — API-level smoke for the speech-to-text pipeline
// (parakeet-asr container + POST /api/transcribe + mic button in MessageInput).
//
// The beforeAll health-check skips the entire suite when the ASR container
// is not reachable, so this file is safe to run in any environment.
//
// Audio fixture: e2e/fixtures/audio/stt-test.wav — JFK inaugural address clip
// (public domain, sourced from whisper.cpp samples/jfk.wav).
//
// The UI test mocks getUserMedia to play the fixture WAV through AudioContext
// (headless Chromium on macOS does not support --use-fake-device-for-media-stream)
// so MediaRecorder captures real speech audio without a physical microphone.

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const env = require('../steps/env');
const team = require('../steps/team');
const teardown = require('../steps/teardown');

const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/audio/stt-test.wav');
const FIXTURE_REPO_URL = process.env.E2E_FIXTURE_REPO_URL || 'http://git-remote/e2e/fixture.git';
const EXPECTED_WORDS = ['ask', 'country'];

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ')    // collapse whitespace
    .trim();
}

test.describe('Speech-to-Text', () => {
  // Set by the UI test when it materialises its fixture team; the API test
  // leaves them undefined so the afterEach teardown is a no-op after it.
  let teamId;
  let envId;

  test.afterEach(async ({ page, request }) => {
    if (teamId && envId) {
      await teardown.teardownTeam({ page, request }, { teamId, envId });
      teamId = undefined;
      envId = undefined;
    }
  });

  test.beforeAll(async ({ request }) => {
    // Skip suite if ASR is unreachable or unhealthy.
    // Send the real fixture so a working ASR returns 200; a network error
    // or a proxy 500 (ASR down) both skip.
    try {
      const audioBuffer = fs.readFileSync(FIXTURE_PATH);
      const res = await request.post('/api/transcribe', {
        multipart: {
          audio_file: {
            name: 'stt-test.wav',
            mimeType: 'audio/wav',
            buffer: audioBuffer,
          },
        },
        timeout: 15000,
      });
      if (!res.ok()) {
        test.skip(true, `ASR returned ${res.status()} — skipping STT tests`);
      }
    } catch {
      test.skip(true, 'ASR container is not reachable — skipping STT tests');
    }
  });

  test('API: transcribes a known audio fixture', async ({ request }) => {
    test.setTimeout(30_000);

    const audioBuffer = fs.readFileSync(FIXTURE_PATH);

    const response = await request.post('/api/transcribe', {
      multipart: {
        audio_file: {
          name: 'stt-test.wav',
          mimeType: 'audio/wav',
          buffer: audioBuffer,
        },
      },
    });

    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    // ASR must return a text field (may be empty string for a tone fixture).
    expect(body).toHaveProperty('text');
    expect(typeof body.text).toBe('string');

    const normalized = normalize(body.text);
    for (const word of EXPECTED_WORDS) {
      expect(normalized).toContain(word);
    }
  });

  test('UI: records via fake mic and populates textarea', async ({ page, context, request }) => {
    test.setTimeout(60_000);

    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await context.grantPermissions(['microphone']);

    // The mic lives on an agent's chat composer, so this test needs an agent to
    // open. Every other phase-1 spec tears its team down in afterEach, so the
    // chat list is NOT guaranteed to hold one (a prior race here made the test
    // flaky). Materialise a dedicated single-member fixture team and open ITS
    // chat directly by id — no dependency on whichever agents happen to linger.
    const ctx = { page, request };
    teamId = `e2e-stt-${Date.now().toString(36)}`.slice(0, 24);
    envId = `${teamId}-fixture`;
    const agentId = `${teamId}-business-analyst`;

    await env.createFixtureEnv(ctx, {
      id: envId,
      name: `${teamId} fixture env`,
      repoUrl: FIXTURE_REPO_URL,
      branch: 'main',
    });
    await team.materializeTeam(ctx, { teamId, envId, roles: ['business-analyst'] });

    await page.goto(`/chats/${agentId}`);

    // Scope to the chat composer: the app-level Helper Chat panel (#1735) is
    // always mounted (off-screen when closed), so a bare `textarea` / a
    // "Record voice message" mic now also match its composer. The chat
    // composer's textarea is the only one whose placeholder ends in "to send",
    // and its dictation mic is labelled "Dictate message".
    const textarea = page.getByPlaceholder(/Message .*to send/);
    await textarea.waitFor({ state: 'visible', timeout: 15_000 });

    const micButton = page.locator('button[aria-label="Dictate message"]');
    await micButton.waitFor({ state: 'visible', timeout: 5_000 });

    // Headless Chromium on macOS does not support getUserMedia even with
    // --use-fake-device-for-media-stream. Mock it to play the JFK WAV fixture
    // through AudioContext so MediaRecorder captures real speech audio.
    const wavBase64 = fs.readFileSync(FIXTURE_PATH).toString('base64');
    await page.evaluate(async (b64) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const wavBuffer = bytes.buffer;

      const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (constraints?.audio) {
          const audioCtx = new AudioContext();
          const audioBuffer = await audioCtx.decodeAudioData(wavBuffer.slice(0));
          const source = audioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.loop = true;
          const dest = audioCtx.createMediaStreamDestination();
          source.connect(dest);
          source.start();
          return dest.stream;
        }
        return origGUM(constraints);
      };
    }, wavBase64);

    await micButton.click();

    const stopButton = page.locator('button[aria-label="Stop recording"]');
    await stopButton.waitFor({ state: 'visible', timeout: 10_000 });

    // Record long enough to capture "ask not what your country can do for you".
    await page.waitForTimeout(8000);

    await stopButton.click();

    await micButton.waitFor({ state: 'visible', timeout: 20_000 });

    const value = await textarea.inputValue();
    const normalized = normalize(value);
    for (const word of EXPECTED_WORDS) {
      expect(normalized).toContain(word);
    }

    expect(errors).toHaveLength(0);
  });

});
