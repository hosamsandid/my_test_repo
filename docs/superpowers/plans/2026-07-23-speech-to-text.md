# Speech-to-Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a microphone button to the agent chat input that records audio, transcribes it via a self-hosted Whisper ASR container, and inserts the text into the textarea for review before sending.

**Architecture:** Browser captures audio via `MediaRecorder`, POSTs the blob to `POST /api/transcribe` on the admin-console, which proxies it to an internal `whisper-asr` container running `onerahmet/openai-whisper-asr-webservice`. The transcribed text is inserted into the textarea. A `useVoiceRecorder` hook manages the recording state machine.

**Tech Stack:** React (existing), lucide-react icons (`Mic`, `Square`, `Loader2`), MediaRecorder Web API, multer (existing), Node built-in `FormData`/`Blob` (Node 22), Podman Compose, `onerahmet/openai-whisper-asr-webservice`, Playwright (e2e), `node:test` (unit tests).

## Global Constraints

- Node 22 (admin-console Dockerfile: `FROM node:22-slim`)
- Test framework: `node:test` + `node:assert/strict`, colocated `*.test.js` files
- E2E framework: Playwright, specs in `e2e/tests/`
- Auth: all `/api/*` routes are behind `auth.gate` (line 227 of `api.js`)
- Styling: inline styles using `--eb-*` CSS custom properties (no CSS modules)
- Icons: `lucide-react` ^0.441.0

---

### Task 1: Add Whisper ASR container to docker-compose

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces: `whisper-asr` service reachable at `http://whisper-asr:9000` on the compose network, exposing `POST /asr?output=json&vad_filter=true` (accepts `multipart/form-data` with `audio_file` field, returns `{ text: "..." }`)

- [ ] **Step 1: Add the whisper-asr service and volume**

Add the `whisper-asr` service block before the `volumes:` section in `docker-compose.yml`, and add the `whisper-cache` volume:

```yaml
  whisper-asr:
    image: onerahmet/openai-whisper-asr-webservice:latest
    container_name: ${COMPOSE_PROJECT_NAME}-whisper-asr
    restart: unless-stopped
    expose:
      - "9000"
    environment:
      ASR_MODEL: small
      ASR_ENGINE: faster_whisper
      ASR_COMPUTE_TYPE: int8
    volumes:
      - whisper-cache:/root/.cache/whisper
```

In the `volumes:` section at the bottom, add:

```yaml
  whisper-cache:
    name: ${COMPOSE_PROJECT_NAME}_whisper-cache
```

- [ ] **Step 2: Add WHISPER_URL env var to the admin-console service**

In the `admin-console` service's `environment:` block, add:

```yaml
      WHISPER_URL: "${WHISPER_URL:-http://whisper-asr:9000}"
```

- [ ] **Step 3: Verify the container starts**

Run:
```bash
podman compose up -d whisper-asr
podman compose ps
```

Expected: `whisper-asr` service is running. First startup is slow (~30s) as the model downloads.

- [ ] **Step 4: Verify the ASR endpoint responds**

Run (from inside the compose network):
```bash
podman compose exec admin-console sh -c 'curl -s http://whisper-asr:9000/docs | head -5'
```

Expected: HTML response from the Swagger docs page (confirms the service is reachable).

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(stt): add whisper-asr container to compose stack"
```

---

### Task 2: Add POST /api/transcribe endpoint

**Files:**
- Modify: `admin-console/api/api.js`
- Test: `admin-console/api/transcribe.test.js`

**Interfaces:**
- Consumes: `whisper-asr` service at `${WHISPER_URL}/asr?output=json&vad_filter=true`
- Produces: `POST /api/transcribe` — accepts `multipart/form-data` with `audio_file` field (max 10 MB), returns `{ text: "transcribed text" }` on success, `{ error: "Transcription failed" }` with status 500 on failure

- [ ] **Step 1: Write the failing test**

Create `admin-console/api/transcribe.test.js`:

```js
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

describe('POST /api/transcribe', () => {
  let transcribeHandler;

  beforeEach(() => {
    mock.restoreAll();
  });

  it('forwards audio to Whisper and returns transcribed text', async () => {
    const mockFetch = mock.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ text: ' Hello world. ' }),
      })
    );

    const { createTranscribeRoute } = require('./transcribe.js');
    const handler = createTranscribeRoute({ fetchFn: mockFetch, whisperUrl: 'http://whisper:9000' });

    const req = {
      file: {
        buffer: Buffer.from('fake audio data'),
        originalname: 'recording.webm',
        mimetype: 'audio/webm',
      },
    };
    const res = {
      _status: 200,
      _body: null,
      status(code) { this._status = code; return this; },
      json(body) { this._body = body; },
    };

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { text: 'Hello world.' });

    assert.equal(mockFetch.mock.calls.length, 1);
    const [url, opts] = mockFetch.mock.calls[0].arguments;
    assert.equal(url, 'http://whisper:9000/asr?output=json&vad_filter=true');
    assert.equal(opts.method, 'POST');
  });

  it('returns 500 when Whisper responds with an error', async () => {
    const mockFetch = mock.fn(() =>
      Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('Service Unavailable') })
    );

    const { createTranscribeRoute } = require('./transcribe.js');
    const handler = createTranscribeRoute({ fetchFn: mockFetch, whisperUrl: 'http://whisper:9000' });

    const req = {
      file: {
        buffer: Buffer.from('fake audio'),
        originalname: 'recording.webm',
        mimetype: 'audio/webm',
      },
    };
    const res = {
      _status: 200,
      _body: null,
      status(code) { this._status = code; return this; },
      json(body) { this._body = body; },
    };

    await handler(req, res);

    assert.equal(res._status, 500);
    assert.deepEqual(res._body, { error: 'Transcription failed' });
  });

  it('returns 500 when fetch throws (Whisper unreachable)', async () => {
    const mockFetch = mock.fn(() => Promise.reject(new Error('ECONNREFUSED')));

    const { createTranscribeRoute } = require('./transcribe.js');
    const handler = createTranscribeRoute({ fetchFn: mockFetch, whisperUrl: 'http://whisper:9000' });

    const req = {
      file: {
        buffer: Buffer.from('fake audio'),
        originalname: 'recording.webm',
        mimetype: 'audio/webm',
      },
    };
    const res = {
      _status: 200,
      _body: null,
      status(code) { this._status = code; return this; },
      json(body) { this._body = body; },
    };

    await handler(req, res);

    assert.equal(res._status, 500);
    assert.deepEqual(res._body, { error: 'Transcription failed' });
  });

  it('returns 400 when no audio file is provided', async () => {
    const mockFetch = mock.fn();

    const { createTranscribeRoute } = require('./transcribe.js');
    const handler = createTranscribeRoute({ fetchFn: mockFetch, whisperUrl: 'http://whisper:9000' });

    const req = { file: undefined };
    const res = {
      _status: 200,
      _body: null,
      status(code) { this._status = code; return this; },
      json(body) { this._body = body; },
    };

    await handler(req, res);

    assert.equal(res._status, 400);
    assert.deepEqual(res._body, { error: 'No audio file provided' });
    assert.equal(mockFetch.mock.calls.length, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test admin-console/api/transcribe.test.js`

Expected: FAIL — `Cannot find module './transcribe.js'`

- [ ] **Step 3: Write the transcribe module**

Create `admin-console/api/transcribe.js`:

```js
'use strict';

function createTranscribeRoute({ fetchFn = globalThis.fetch, whisperUrl } = {}) {
  const url = whisperUrl || process.env.WHISPER_URL || 'http://whisper-asr:9000';

  return async function handleTranscribe(req, res) {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    try {
      const form = new FormData();
      form.append('audio_file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);

      const response = await fetchFn(`${url}/asr?output=json&vad_filter=true`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return res.status(500).json({ error: 'Transcription failed' });
      }

      const data = await response.json();
      return res.json({ text: (data.text || '').trim() });
    } catch {
      return res.status(500).json({ error: 'Transcription failed' });
    }
  };
}

module.exports = { createTranscribeRoute };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test admin-console/api/transcribe.test.js`

Expected: All 4 tests PASS.

- [ ] **Step 5: Wire the route into api.js**

In `admin-console/api/api.js`:

Add the require near the top (after the existing multer setup):

```js
const { createTranscribeRoute } = require('./transcribe.js');
```

Add a multer instance and the route after the auth gate (`app.use('/api', auth.gate)` at line 227), near the other POST routes:

```js
const _transcribeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/transcribe', _transcribeUpload.single('audio_file'), createTranscribeRoute());
```

- [ ] **Step 6: Commit**

```bash
git add admin-console/api/transcribe.js admin-console/api/transcribe.test.js admin-console/api/api.js
git commit -m "feat(stt): add POST /api/transcribe endpoint proxying to Whisper ASR"
```

---

### Task 3: Add useVoiceRecorder hook

**Files:**
- Create: `admin-console/src/hooks/useVoiceRecorder.js`
- Test: `admin-console/src/hooks/useVoiceRecorder.test.js`

**Interfaces:**
- Consumes: `POST /api/transcribe` (Task 2)
- Produces: `useVoiceRecorder()` hook returning `{ state, elapsedSeconds, error, toggleRecording, clearError }` where `state` is `'idle' | 'recording' | 'transcribing'`

- [ ] **Step 1: Write the failing test**

Create `admin-console/src/hooks/useVoiceRecorder.test.js`:

```js
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudio } from './useVoiceRecorder.js';

describe('transcribeAudio (unit)', () => {
  it('posts FormData to /api/transcribe and returns text', async () => {
    const blob = new Blob(['fake audio'], { type: 'audio/webm' });
    const mockFetch = mock.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ text: 'hello world' }) })
    );

    const result = await transcribeAudio(blob, mockFetch);

    assert.equal(result, 'hello world');
    assert.equal(mockFetch.mock.calls.length, 1);
    const [url, opts] = mockFetch.mock.calls[0].arguments;
    assert.equal(url, '/api/transcribe');
    assert.equal(opts.method, 'POST');
    assert.ok(opts.body instanceof FormData);
  });

  it('throws on non-ok response', async () => {
    const blob = new Blob(['fake audio'], { type: 'audio/webm' });
    const mockFetch = mock.fn(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'fail' }) })
    );

    await assert.rejects(
      () => transcribeAudio(blob, mockFetch),
      { message: 'Transcription failed' }
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test admin-console/src/hooks/useVoiceRecorder.test.js`

Expected: FAIL — module `./useVoiceRecorder.js` not found

- [ ] **Step 3: Write the hook module**

Create `admin-console/src/hooks/useVoiceRecorder.js`:

```jsx
import { useState, useRef, useCallback, useEffect } from 'react';

/** POST a recorded blob to /api/transcribe, return the text. */
export async function transcribeAudio(blob, fetchFn = globalThis.fetch) {
  const form = new FormData();
  form.append('audio_file', blob, 'recording.webm');
  const res = await fetchFn('/api/transcribe', { method: 'POST', body: form });
  if (!res.ok) throw new Error('Transcription failed');
  const data = await res.json();
  return data.text || '';
}

/**
 * Hook managing the mic → record → transcribe lifecycle.
 * Returns { state, elapsedSeconds, error, toggleRecording, clearError }.
 */
export default function useVoiceRecorder({ onTranscription }) {
  const [state, setState] = useState('idle');        // 'idle' | 'recording' | 'transcribing'
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState(null);

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      clearInterval(timerRef.current);
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const stopRecording = useCallback(() => {
    clearInterval(timerRef.current);
    timerRef.current = null;
    recorderRef.current?.stop();
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone blocked — click the lock icon in your address bar to allow it, then try again.');
      return;
    }

    streamRef.current = stream;
    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;

    recorder.ondataavailable = async (e) => {
      // Stop all tracks to release the mic.
      stream.getTracks().forEach(t => t.stop());
      streamRef.current = null;

      if (!e.data || e.data.size === 0) {
        setState('idle');
        return;
      }

      setState('transcribing');
      try {
        const text = await transcribeAudio(e.data);
        if (text) onTranscription?.(text);
      } catch {
        setError('Transcription failed — please try again.');
      }
      setState('idle');
    };

    recorder.start();
    setState('recording');
    setElapsedSeconds(0);
    timerRef.current = setInterval(() => {
      setElapsedSeconds(s => s + 1);
    }, 1000);
  }, [onTranscription]);

  const toggleRecording = useCallback(() => {
    if (state === 'recording') {
      stopRecording();
    } else if (state === 'idle') {
      startRecording();
    }
    // ignore clicks during 'transcribing'
  }, [state, startRecording, stopRecording]);

  return { state, elapsedSeconds, error, toggleRecording, clearError };
}
```

Note: This file uses ESM `import`/`export` because it's a React module consumed by the bundler. The test file uses `require()` to test just the `transcribeAudio` helper (pure async function). The React hook itself is tested via the MessageInput integration (Task 4).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test admin-console/src/hooks/useVoiceRecorder.test.js`

Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-console/src/hooks/useVoiceRecorder.js admin-console/src/hooks/useVoiceRecorder.test.js
git commit -m "feat(stt): add useVoiceRecorder hook with transcribeAudio helper"
```

---

### Task 4: Add microphone button to MessageInput

**Files:**
- Modify: `admin-console/src/pages/agent-chat/MessageInput.jsx`

**Interfaces:**
- Consumes: `useVoiceRecorder` hook from Task 3

- [ ] **Step 1: Add the import**

At the top of `MessageInput.jsx`, add the icon import and hook import:

```jsx
import { Send, Paperclip, Loader2, Mic, Square } from 'lucide-react';
import useVoiceRecorder from '../../hooks/useVoiceRecorder.js';
```

(Remove the existing import line that only imports `Send, Paperclip, Loader2`.)

- [ ] **Step 2: Wire the hook into the component**

Inside the `MessageInput` function, after the existing state declarations (after line 39 — `const composingRef = useRef(false);`), add:

```jsx
  const handleTranscription = React.useCallback((text) => {
    setValue(prev => {
      if (!prev.trim()) return text;
      return prev + ' ' + text;
    });
  }, []);

  const { state: voiceState, elapsedSeconds, error: voiceError, toggleRecording, clearError } = useVoiceRecorder({
    onTranscription: handleTranscription,
  });

  // Auto-clear voice error after 3 seconds.
  React.useEffect(() => {
    if (!voiceError) return;
    const t = setTimeout(clearError, 3000);
    return () => clearTimeout(t);
  }, [voiceError, clearError]);
```

- [ ] **Step 3: Add the mic button between the textarea and Send button**

Insert this JSX block after the closing `/>` of the `<textarea>` element (line 241) and before the Send `<button>` (line 242):

```jsx
        <div style={{ position: 'relative', flexShrink: 0 }}>
          {voiceState === 'recording' && (
            <span style={{
              position: 'absolute',
              bottom: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              fontSize: 'var(--eb-text-xs)',
              color: 'var(--eb-status-error-text, #dc2626)',
              whiteSpace: 'nowrap',
              marginBottom: 2,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, '0')}
            </span>
          )}
          <button
            onClick={toggleRecording}
            disabled={disabled || voiceState === 'transcribing'}
            aria-label={voiceState === 'recording' ? 'Stop recording' : voiceState === 'transcribing' ? 'Transcribing…' : 'Record voice message'}
            title={voiceState === 'recording' ? 'Stop recording' : voiceState === 'transcribing' ? 'Transcribing…' : 'Voice input'}
            style={{
              width: 32, height: 32,
              background: voiceState === 'recording' ? 'var(--eb-status-error-bg, #fef2f2)' : 'transparent',
              color: voiceState === 'recording'
                ? 'var(--eb-status-error-text, #dc2626)'
                : voiceState === 'transcribing'
                  ? 'var(--eb-text-muted)'
                  : 'var(--eb-text-secondary)',
              border: 'none',
              borderRadius: 'var(--eb-radius-md)',
              cursor: (disabled || voiceState === 'transcribing') ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
              animation: voiceState === 'recording' ? 'stt-pulse 1.5s ease-in-out infinite' : 'none',
            }}
          >
            {voiceState === 'recording'
              ? <Square size={14} />
              : voiceState === 'transcribing'
                ? <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} />
                : <Mic size={14} />}
          </button>
        </div>
```

- [ ] **Step 4: Add the pulse animation and show voice errors in the helper text**

Add the CSS keyframes. Find the existing `spin` keyframes — if they're defined in a global CSS file, add `stt-pulse` there. If they're inline (as a `<style>` tag), add alongside. If no global keyframes exist, add a `<style>` block inside the component's return, before the outer `<div>`:

Simplest approach — add to the module scope (after the `kbdStyle` const at the bottom of the file):

```jsx
if (typeof document !== 'undefined' && !document.getElementById('stt-keyframes')) {
  const style = document.createElement('style');
  style.id = 'stt-keyframes';
  style.textContent = `@keyframes stt-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`;
  document.head.appendChild(style);
}
```

For the voice error, modify the helper text `<div>` (lines 263-274). Replace the content with:

```jsx
      <div style={{
        fontSize: 'var(--eb-text-xs)',
        color: voiceError ? 'var(--eb-status-error-text, #dc2626)' : 'var(--eb-text-muted)',
        marginTop: 'var(--eb-space-1)',
        paddingLeft: 'var(--eb-space-1)',
        transition: 'color var(--eb-transition-fast)',
      }}>
        {voiceError
          ? voiceError
          : voiceState === 'transcribing'
            ? 'Transcribing…'
            : uploading
              ? 'Uploading attachment…'
              : onUpload
                ? <>Markdown supported · attach with <Paperclip size={11} style={{ verticalAlign: '-1px' }} />, drag &amp; drop, or paste (<kbd style={kbdStyle}>⌘</kbd>/<kbd style={kbdStyle}>Ctrl</kbd>+<kbd style={kbdStyle}>V</kbd>) · <kbd style={kbdStyle}>⌘</kbd>+<kbd style={kbdStyle}>↩</kbd> to send</>
                : <>Markdown supported · <kbd style={kbdStyle}>⌘</kbd>+<kbd style={kbdStyle}>↩</kbd> to send · <kbd style={kbdStyle}>↩</kbd> for newline</>}
      </div>
```

- [ ] **Step 5: Rebuild and verify visually**

Run:
```bash
podman compose build admin-console
podman compose up -d admin-console
```

Open `http://localhost:4000/chats/<any-agent-id>` in a browser. Verify:
- The mic button appears between the textarea and Send button
- Clicking it shows a permission prompt (or starts recording if already granted)
- During recording, the button pulses red and shows a duration counter
- Clicking again stops and shows "Transcribing..." (if Whisper is running)
- Transcribed text appears in the textarea

- [ ] **Step 6: Commit**

```bash
git add admin-console/src/pages/agent-chat/MessageInput.jsx
git commit -m "feat(stt): add microphone button to chat input with voice recording UI"
```

---

### Task 5: E2E tests

**Files:**
- Create: `e2e/fixtures/audio/stt-test.wav`
- Create: `e2e/tests/stt-transcribe.spec.js`

**Interfaces:**
- Consumes: `POST /api/transcribe` (Task 2), MessageInput mic button (Task 4), running `whisper-asr` container (Task 1)

- [ ] **Step 1: Generate the audio fixture**

We need a clear, short WAV file with a known phrase. Use a text-to-speech tool to generate it deterministically. From the host machine (or any machine with Python + `pyttsx3` or `gtts`):

Option A — using `gtts` (Google TTS, requires internet):
```bash
pip install gtts
python3 -c "
from gtts import gTTS
tts = gTTS('Hello, this is a test recording', lang='en')
tts.save('e2e/fixtures/audio/stt-test.mp3')
"
# Convert to WAV if needed (ffmpeg):
ffmpeg -i e2e/fixtures/audio/stt-test.mp3 -ar 16000 -ac 1 e2e/fixtures/audio/stt-test.wav
rm e2e/fixtures/audio/stt-test.mp3
```

Option B — using `espeak` (offline, available on most Linux):
```bash
mkdir -p e2e/fixtures/audio
espeak -w e2e/fixtures/audio/stt-test.wav "Hello, this is a test recording"
```

Option C — record it manually in a quiet room, 3-5 seconds, save as `e2e/fixtures/audio/stt-test.wav`.

Verify the audio plays back correctly:
```bash
ffprobe e2e/fixtures/audio/stt-test.wav
```

Expected: WAV file, a few seconds long.

- [ ] **Step 2: Write the API-level e2e test**

Create `e2e/tests/stt-transcribe.spec.js`:

```js
// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/audio/stt-test.wav');
const EXPECTED_WORDS = ['hello', 'test', 'recording'];

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')   // strip punctuation
    .replace(/\s+/g, ' ')      // collapse whitespace
    .trim();
}

test.describe('Speech-to-Text', () => {
  test.beforeAll(async ({ request }) => {
    // Skip suite if Whisper is unreachable (admin-console proxies to it).
    try {
      const res = await request.post('/api/transcribe', {
        multipart: {
          audio_file: {
            name: 'silence.wav',
            mimeType: 'audio/wav',
            buffer: Buffer.alloc(1000),
          },
        },
        timeout: 5000,
      });
      // Any response (even 500) means the route exists and Whisper was attempted.
      // A connection error means the stack isn't running.
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
    expect(body.text).toBeTruthy();

    const normalized = normalize(body.text);
    for (const word of EXPECTED_WORDS) {
      expect(normalized).toContain(word);
    }
  });

  test('UI: records via fake mic and transcribes into textarea', async ({ browser }) => {
    test.setTimeout(45_000);

    const context = await browser.newContext();
    const page = await context.newPage();

    // Grant microphone permission so the fake device is used without prompting.
    await context.grantPermissions(['microphone']);

    // Navigate to any agent chat. The e2e environment should have at least one
    // enabled agent. Adjust the URL/selector to match the e2e setup.
    await page.goto('/chats');

    // Click the first agent in the list to open a chat.
    await page.locator('[data-testid="agent-list-item"]').first().click({ timeout: 10_000 }).catch(() => {
      // If no data-testid, fall back to clicking the first agent link.
      return page.locator('a[href*="/chats/"]').first().click({ timeout: 10_000 });
    });

    // Wait for the chat input to appear.
    const textarea = page.locator('textarea');
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });

    // Click the mic button to start recording.
    const micButton = page.locator('button[aria-label="Record voice message"]');
    await micButton.click();

    // Wait for recording state (the button label changes).
    const stopButton = page.locator('button[aria-label="Stop recording"]');
    await stopButton.waitFor({ state: 'visible', timeout: 5_000 });

    // Let it "record" from the fake audio device for 3 seconds.
    await page.waitForTimeout(3000);

    // Click to stop recording.
    await stopButton.click();

    // Wait for transcription to complete — the button returns to idle state.
    await micButton.waitFor({ state: 'visible', timeout: 20_000 });

    // Check the textarea has transcribed text.
    const value = await textarea.inputValue();
    const normalized = normalize(value);
    for (const word of EXPECTED_WORDS) {
      expect(normalized).toContain(word);
    }

    await context.close();
  });
});
```

- [ ] **Step 3: Configure Playwright for fake audio in the UI test**

In `e2e/playwright.config.js`, the Chromium launch args need the fake-device flags. Check if there's already a `use.launchOptions.args` array. If so, append to it. If not, add:

```js
use: {
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.resolve(__dirname, 'fixtures/audio/stt-test.wav')}`,
    ],
  },
},
```

If the config already has `args`, merge them rather than overwrite.

- [ ] **Step 4: Run the API-level test**

Run:
```bash
npx playwright test e2e/tests/stt-transcribe.spec.js -g "API"
```

Expected: PASS (or SKIP if Whisper isn't running).

- [ ] **Step 5: Run the UI-level test**

Run:
```bash
npx playwright test e2e/tests/stt-transcribe.spec.js -g "UI"
```

Expected: PASS (or SKIP if Whisper isn't running). The browser opens with fake audio, records from the fixture, transcribes, and the textarea contains the expected words.

- [ ] **Step 6: Commit**

```bash
git add e2e/fixtures/audio/stt-test.wav e2e/tests/stt-transcribe.spec.js e2e/playwright.config.js
git commit -m "test(stt): add API and UI e2e tests for speech-to-text transcription"
```
