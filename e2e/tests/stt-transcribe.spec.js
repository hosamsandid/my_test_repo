// @ts-check
// STT e2e tests — API-level and UI-level smoke for the speech-to-text pipeline
// (whisper-asr container + POST /api/transcribe + mic button in MessageInput).
//
// The beforeAll health-check skips the entire suite when the Whisper container
// is not reachable, so this file is safe to run in any environment.
//
// Audio fixture: e2e/fixtures/audio/stt-test.wav — JFK inaugural address clip
// (public domain, from whisper.cpp samples/jfk.wav).
//
// The UI test mocks getUserMedia to play the fixture WAV through AudioContext
// (headless Chromium on macOS does not support --use-fake-device-for-media-stream)
// so MediaRecorder captures real speech audio without a physical microphone.

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/audio/stt-test.wav');
const EXPECTED_WORDS = ['ask', 'country'];

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ')    // collapse whitespace
    .trim();
}

test.describe('Speech-to-Text', () => {
  test.beforeAll(async ({ request }) => {
    // Skip suite if Whisper is unreachable or unhealthy.
    // Send the real fixture so a working Whisper returns 200; a network error
    // or a proxy 500 (Whisper down) both skip.
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
        test.skip(true, `Whisper returned ${res.status()} — skipping STT tests`);
      }
    } catch {
      test.skip(true, 'Whisper ASR container is not reachable — skipping STT tests');
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
    // Whisper must return a text field (may be empty string for a tone fixture).
    expect(body).toHaveProperty('text');
    expect(typeof body.text).toBe('string');

    const normalized = normalize(body.text);
    for (const word of EXPECTED_WORDS) {
      expect(normalized).toContain(word);
    }
  });

  test('UI: records via fake mic and populates textarea', async ({ page, context }) => {
    test.setTimeout(45_000);

    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await context.grantPermissions(['microphone']);

    await page.goto('/chats');

    const agentOption = page.locator('[role="option"]').first();
    await agentOption.click({ timeout: 10_000 });

    const textarea = page.locator('textarea');
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });

    const micButton = page.locator('button[aria-label="Record voice message"]');
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
          const ctx = new AudioContext();
          const audioBuffer = await ctx.decodeAudioData(wavBuffer.slice(0));
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.loop = true;
          const dest = ctx.createMediaStreamDestination();
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
