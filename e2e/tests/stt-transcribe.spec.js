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
// Chromium is launched with --use-fake-device-for-media-stream and
// --use-file-for-fake-audio-capture pointing at the fixture (playwright.config.js)
// so the UI test exercises the MediaRecorder path without a real microphone.

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

  test('UI: records via fake mic and populates textarea', async ({ browser }) => {
    test.setTimeout(45_000);

    const context = await browser.newContext();
    const page = await context.newPage();

    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Grant microphone permission so the fake device is used without a prompt.
    await context.grantPermissions(['microphone']);

    // Navigate to the chats page and open the first available agent.
    await page.goto('/chats');

    // Try data-testid first; fall back to href pattern.
    const agentItem = page.locator('[data-testid="agent-list-item"]').first();
    const agentLink = page.locator('a[href*="/chats/"]').first();
    const hasAgent = (await agentItem.count()) > 0 || (await agentLink.count()) > 0;
    if (!hasAgent) {
      test.skip(true, 'No agents available in the e2e stack — skipping UI test');
      return;
    }
    const target = (await agentItem.count()) > 0 ? agentItem : agentLink;
    await target.click({ timeout: 10_000 });

    // Wait for the message textarea.
    const textarea = page.locator('textarea');
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });

    // Click the mic button to start recording.
    const micButton = page.locator('button[aria-label="Record voice message"]');
    await micButton.waitFor({ state: 'visible', timeout: 5_000 });
    await micButton.click();

    // The button transitions to a "Stop recording" state while recording.
    const stopButton = page.locator('button[aria-label="Stop recording"]');
    await stopButton.waitFor({ state: 'visible', timeout: 5_000 });

    // Let the fake audio stream run for 3 seconds.
    await page.waitForTimeout(3000);

    // Click stop.
    await stopButton.click();

    // Wait for transcription to finish — the mic button returns to idle.
    await micButton.waitFor({ state: 'visible', timeout: 20_000 });

    const value = await textarea.inputValue();
    const normalized = normalize(value);
    for (const word of EXPECTED_WORDS) {
      expect(normalized).toContain(word);
    }

    expect(errors).toHaveLength(0);

    await context.close();
  });
});
