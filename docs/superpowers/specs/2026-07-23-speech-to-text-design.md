# Speech-to-Text for Agent Chat

## Overview

Add a microphone button to the agent chat input that records audio, sends it to a self-hosted Whisper ASR container for transcription, and inserts the result into the textarea for review before sending.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Interaction model | Tap-to-toggle | Tap to start recording, tap to stop. Most intuitive for chat. |
| After transcription | Insert into textarea | User reviews/edits before sending. Safer than auto-send. |
| Whisper hosting | 5th service in docker-compose.yml | Starts/stops with the stack, internal network only. |
| Audio routing | Browser → admin-console → Whisper | Consistent proxy pattern. Whisper stays unexposed. |
| Implementation approach | MediaRecorder + WAV POST | Simple, no streaming needed for dictate-then-review UX. |

## 1. Infrastructure — Whisper Container

New `whisper-asr` service in `docker-compose.yml`:

- **Image:** `onerahmet/openai-whisper-asr-webservice:latest`
- **Internal only:** `expose: ["9000"]`, no host port. Reachable as `http://whisper-asr:9000`.
- **Environment:**
  - `ASR_MODEL=small`
  - `ASR_ENGINE=faster_whisper`
  - `ASR_COMPUTE_TYPE=int8`
- **Volume:** `whisper-cache:/root/.cache/whisper` for model persistence across restarts.
- **Restart policy:** `unless-stopped`

The admin-console service gains a `WHISPER_URL` env var defaulting to `http://whisper-asr:9000`.

## 2. Backend — Transcription Endpoint

One new route in `admin-console/api/api.js`:

### `POST /api/transcribe`

- Protected by the existing auth gate.
- Accepts `multipart/form-data` with one field: `audio_file`.
- Uses multer for in-memory file handling. Size limit: 10 MB (~5 min of audio).
- Forwards the audio as `multipart/form-data` to `${WHISPER_URL}/asr?output=json&vad_filter=true`.
- Returns `{ text: "transcribed text" }`.
- On Whisper error or timeout (15s): returns `500` with `{ error: "Transcription failed" }`.
- Outbound `FormData` construction uses Node's built-in `FormData` + `Blob` (Node 18+).

No new file — follows the existing per-route `fetch()` proxy pattern in `api.js`.

## 3. Frontend — MessageInput Changes

### Button placement

The flex row becomes `[Paperclip] [Textarea] [Mic] [Send]` — microphone to the left of Send.

### Button states

| State | Icon | Appearance |
|---|---|---|
| Idle | `<Mic>` (lucide) | 32x32, same style as Send button, greyed out |
| Recording | `<Square>` (lucide stop) | Background pulses red (CSS animation). Duration counter (e.g. "0:03") displayed as a small label above the button |
| Transcribing | `<Loader2>` (lucide, spinning) | Button disabled. Textarea placeholder shows "Transcribing..." |

### Recording flow

1. User taps Mic → `navigator.mediaDevices.getUserMedia({ audio: true })` → `MediaRecorder` starts.
2. User taps again → `MediaRecorder.stop()` → `ondataavailable` fires with audio blob.
3. Blob POSTed to `/api/transcribe` as `multipart/form-data`.
4. Response text appended to textarea content (space-separated if non-empty).
5. User reviews and sends as normal.

### Audio format

`MediaRecorder` defaults to `audio/webm` (Chrome/Firefox) or `audio/mp4` (Safari). Both supported by the Whisper ASR image — no conversion needed.

### Permission handling

- Each tap calls `getUserMedia` fresh — never caches a denial.
- On denial: show a helpful message — "Microphone blocked — click the lock icon in your address bar to allow it, then try again."
- No retry spam. Subsequent taps re-attempt naturally.

### Error handling

- Transcription failure: brief inline error below the textarea (same location as helper text), auto-fades after 3 seconds.
- No modal dialogs or toasts.

### Custom hook

Recording logic extracted into `useVoiceRecorder` hook in a new file `admin-console/src/hooks/useVoiceRecorder.js`. Manages the MediaRecorder lifecycle, state machine (idle → recording → transcribing → idle), and cleanup. MessageInput consumes it.

## 4. Testing

### Backend unit test

One test for `POST /api/transcribe` — mock the Whisper fetch to verify:
- Correct forwarding of audio as multipart to Whisper.
- Correct response shape on success.
- 500 response on Whisper error/timeout.

### Frontend tests

- `useVoiceRecorder` hook: test state transitions (idle → recording → transcribing → idle), cleanup on unmount.
- MessageInput component: verify mic button renders, correct icons per state, transcribed text appended to textarea.

### E2E tests (Playwright)

Both tests require the Whisper container running. A `beforeAll` health check skips the suite if unreachable — fast fail, not a 15s timeout.

**Fixture:** A short (3-5s), clear audio file committed to `e2e/fixtures/audio/stt-test.wav`. Native English speaker, quiet environment, unambiguous phrase (e.g. "Hello, this is a test recording").

**Assertion (shared):** Normalize response text (lowercase, collapse/strip whitespace, strip punctuation). Assert the result contains key words ("hello", "test", "recording") rather than exact match — absorbs minor Whisper variations.

#### API-level test (fast check)

Playwright's `request.post` sends the fixture to `/api/transcribe` as `multipart/form-data`. No browser, no UI — validates the backend proxy and Whisper integration in isolation.

#### UI-level test (full flow)

Launches Chromium with fake-audio flags so `getUserMedia` returns the fixture as a mic stream — no real microphone, no permission prompt:

```js
chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-file-for-fake-audio-capture=/path/to/stt-test.wav',
  ],
});
```

Test flow:
1. Navigate to an agent chat page.
2. Click the mic button — starts "recording" from the fixture file.
3. Wait a few seconds, click mic again — stops recording.
4. Wait for the transcribing state to resolve.
5. Assert the textarea contains the expected key words.

## Files Changed

| File | Change |
|---|---|
| `docker-compose.yml` | Add `whisper-asr` service + `whisper-cache` volume |
| `admin-console/api/api.js` | Add `POST /api/transcribe` route |
| `admin-console/src/pages/agent-chat/MessageInput.jsx` | Add mic button, consume `useVoiceRecorder` |
| `admin-console/src/hooks/useVoiceRecorder.js` | New — MediaRecorder lifecycle hook |
| `e2e/fixtures/audio/stt-test.wav` | New — test fixture audio file |
| E2E test file (path TBD by test conventions) | New — Playwright transcription test |
