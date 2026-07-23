# Parakeet STT Migration & About Page

**Date:** 2026-07-23

## Overview

Three changes in one feature branch:

1. Replace the Whisper ASR container with NVIDIA Parakeet TDT 0.6B v3 (via sherpa-onnx, CPU-only)
2. Add an About page with Accenture copyright and Parakeet CC-BY-4.0 attribution
3. Add Parakeet attribution to the README

## 1. Parakeet ASR Container

### What changes

Replace `whisper-asr/Dockerfile` and add a `whisper-asr/server.py` FastAPI app. The container name and compose service stay as `whisper-asr` (the service identity is "the STT backend", not "Whisper" specifically).

### Dockerfile

- Base: `python:3.11-slim`
- Install: `sherpa-onnx`, `fastapi`, `uvicorn`, `soundfile`, `ffmpeg` (apt)
- Download at build time: `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` from the sherpa-onnx GitHub releases
- Expose: 9000
- CMD: `uvicorn server:app --host 0.0.0.0 --port 9000`

### server.py (FastAPI)

- `POST /asr` — accepts `audio_file` as multipart upload (same field name as the current Whisper API)
- Accepts `output` and `vad_filter` query params for compatibility; ignores them
- Reads uploaded bytes, decodes with `soundfile` (ffmpeg subprocess fallback for WebM/Opus), resamples to 16kHz mono if needed
- Runs sherpa-onnx `OfflineRecognizer.from_transducer` inference (int8, 4 threads, greedy search)
- Returns `{"text": "transcribed text"}`

### docker-compose.yml

- Service definition stays the same (build context `./whisper-asr`, expose 9000, no host port)
- Remove the `whisper-cache` named volume (model is baked into the image)

### No changes to

- `admin-console/api/transcribe.js` (proxy endpoint)
- `admin-console/src/hooks/useVoiceRecorder.js` (frontend hook)
- `admin-console/src/pages/agent-chat/MessageInput.jsx` (mic button UI)

## 2. About Page & Sidebar Footer

### Sidebar footer (Shell.jsx)

- Font size stays at 11px (no change)
- Add a bold "About" heading above the existing copyright line
- Wrap the entire footer block in a clickable element that navigates to `/about`
- Add a subtle hover effect (e.g. background highlight) so it reads as interactive

### About page (admin-console/src/pages/About.jsx)

- New page at route `/about`, accessible to all logged-in users (no admin guard)
- Centered layout, content top-aligned:
  1. Accenture copyright: "© 2026 Accenture. All rights reserved." with the Accenture logo
  2. Parakeet attribution: "Speech-to-text powered by NVIDIA Parakeet TDT 0.6B v3" with links to the HuggingFace model page and the CC-BY-4.0 license
  3. App version at the bottom

### Routing (App.jsx)

- Add `<Route path="/about" element={<About />} />` with no guard wrapper

## 3. README Attribution

Add a "Third-party Models" section near the bottom of the README:

> Speech-to-text powered by NVIDIA Parakeet TDT 0.6B v3.
> Model: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
> License: CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/)
> Copyright NVIDIA Corporation.
> Model converted to ONNX (int8) format for CPU inference via sherpa-onnx; no retraining or fine-tuning performed.

## Testing

- Existing e2e test (`stt-transcribe.spec.js`) validates the API-level transcription pipeline end-to-end; it should pass with the new Parakeet backend since the API shape is unchanged
- Manual verification: `make up`, open chat, tap mic, speak, confirm transcription appears in textarea
