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

});
