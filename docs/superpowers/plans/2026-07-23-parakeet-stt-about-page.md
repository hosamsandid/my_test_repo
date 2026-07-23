# Parakeet STT Migration & About Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Whisper ASR container with NVIDIA Parakeet TDT 0.6B v3 (sherpa-onnx, CPU-only), add an About page with copyright and CC-BY-4.0 attribution, and add the attribution to the README.

**Architecture:** The Parakeet ASR container is a drop-in replacement for the current Whisper container — same service name, same port (9000), same API shape (`POST /asr` with `audio_file` field). The admin-console proxy (`transcribe.js`) and frontend hook (`useVoiceRecorder.js`) require zero changes. A new About page at `/about` displays Accenture copyright, Parakeet attribution, and app version. The sidebar footer becomes a clickable link to that page.

**Tech Stack:** Python 3.11 + FastAPI + sherpa-onnx + ffmpeg (Parakeet container), React (About page)

## Global Constraints

- The Parakeet container must expose port 9000 and accept `POST /asr` with field `audio_file` — the admin-console proxy sends exactly this shape and must not change.
- The ONNX model (`sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`) is downloaded at Docker build time — no runtime download, no external volume.
- Audio format conversion (WebM/Opus → 16kHz mono WAV) happens inside the Parakeet container using ffmpeg.
- CC-BY-4.0 attribution for the Parakeet model is required in both the About page and the README.

---

### Task 1: Replace Whisper with Parakeet ASR container

**Files:**
- Rewrite: `whisper-asr/Dockerfile`
- Create: `whisper-asr/server.py`

**Interfaces:**
- Produces: HTTP `POST /asr` on port 9000, accepts multipart `audio_file`, returns `{"text": "..."}` — consumed by `admin-console/api/transcribe.js` (no changes needed there).

- [ ] **Step 1: Write the FastAPI server**

Create `whisper-asr/server.py`:

```python
import io
import subprocess
import tempfile

import numpy as np
import sherpa_onnx
import soundfile as sf
from fastapi import FastAPI, File, UploadFile

MODEL_DIR = "/app/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"

recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
    encoder=f"{MODEL_DIR}/encoder.int8.onnx",
    decoder=f"{MODEL_DIR}/decoder.int8.onnx",
    joiner=f"{MODEL_DIR}/joiner.int8.onnx",
    tokens=f"{MODEL_DIR}/tokens.txt",
    num_threads=4,
    sample_rate=16000,
    feature_dim=80,
    decoding_method="greedy_search",
)

app = FastAPI()


def _decode_audio(raw: bytes) -> tuple[np.ndarray, int]:
    """Decode audio bytes to float32 numpy array + sample rate.

    Tries soundfile first (WAV, FLAC, OGG).  Falls back to ffmpeg for
    formats soundfile can't handle (WebM/Opus from the browser's
    MediaRecorder).
    """
    try:
        audio, sr = sf.read(io.BytesIO(raw), dtype="float32")
        return audio, sr
    except Exception:
        pass

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=True) as tmp:
        tmp.write(raw)
        tmp.flush()
        result = subprocess.run(
            [
                "ffmpeg", "-i", tmp.name,
                "-ar", "16000", "-ac", "1", "-f", "wav", "-",
            ],
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {result.stderr.decode()}")
        audio, sr = sf.read(io.BytesIO(result.stdout), dtype="float32")
        return audio, sr


def _resample(audio: np.ndarray, orig_sr: int, target_sr: int = 16000) -> np.ndarray:
    """Resample by linear interpolation (good enough for speech)."""
    if orig_sr == target_sr:
        return audio
    ratio = target_sr / orig_sr
    n_samples = int(len(audio) * ratio)
    indices = np.linspace(0, len(audio) - 1, n_samples)
    return np.interp(indices, np.arange(len(audio)), audio).astype(np.float32)


@app.post("/asr")
async def transcribe(audio_file: UploadFile = File(...)):
    raw = await audio_file.read()
    audio, sr = _decode_audio(raw)

    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    audio = _resample(audio, sr, 16000)

    stream = recognizer.create_stream()
    stream.accept_waveform(16000, audio.tolist())
    recognizer.decode_stream(stream)

    return {"text": stream.result.text.strip()}
```

- [ ] **Step 2: Rewrite the Dockerfile**

Replace `whisper-asr/Dockerfile` with:

```dockerfile
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg wget bzip2 && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir sherpa-onnx fastapi uvicorn soundfile numpy

RUN mkdir -p /app/models && \
    wget -q -O /tmp/model.tar.bz2 \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2 && \
    tar xf /tmp/model.tar.bz2 -C /app/models && \
    rm /tmp/model.tar.bz2

COPY server.py .

EXPOSE 9000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9000"]
```

- [ ] **Step 3: Verify the docker-compose.yml service definition is unchanged**

The existing service block should already be correct — confirm it reads:

```yaml
  whisper-asr:
    build:
      context: ./whisper-asr
    container_name: ${COMPOSE_PROJECT_NAME}-whisper-asr
    restart: unless-stopped
    expose:
      - "9000"
```

No changes needed. The `WHISPER_URL` env var on the admin-console service already points at `http://whisper-asr:9000`.

- [ ] **Step 4: Update the e2e test comments**

In `e2e/tests/stt-transcribe.spec.js`, update the file header comments to reference Parakeet instead of Whisper (the test logic itself is unchanged since the API shape is identical). Also update the `beforeAll` skip message.

Replace the header block (lines 1–13) with:

```javascript
// @ts-check
// STT e2e tests — API-level smoke for the speech-to-text pipeline
// (parakeet-asr container + POST /api/transcribe + mic button in MessageInput).
//
// The beforeAll health-check skips the entire suite when the ASR container
// is not reachable, so this file is safe to run in any environment.
//
// Audio fixture: e2e/fixtures/audio/stt-test.wav — JFK inaugural address clip
// (public domain, from whisper.cpp samples/jfk.wav).
```

Replace the two `test.skip` messages referencing "Whisper":
- `'Whisper returned ${res.status()} — skipping STT tests'` → `'ASR returned ${res.status()} — skipping STT tests'`
- `'Whisper ASR container is not reachable — skipping STT tests'` → `'ASR container is not reachable — skipping STT tests'`

Replace the comment on line 72:
- `// Whisper must return a text field` → `// ASR must return a text field`

- [ ] **Step 5: Commit**

```bash
git add whisper-asr/Dockerfile whisper-asr/server.py e2e/tests/stt-transcribe.spec.js
git commit -m "feat(stt): replace Whisper with Parakeet TDT 0.6B v3 via sherpa-onnx"
```

---

### Task 2: Add About page and update sidebar footer

**Files:**
- Create: `admin-console/src/pages/About.jsx`
- Modify: `admin-console/src/App.jsx` (add lazy import + route, around lines 51–72 and 126–155)
- Modify: `admin-console/src/components/Shell.jsx:333-347` (sidebar footer)

**Interfaces:**
- Consumes: `AccentureLogo` component from `admin-console/src/components/AccentureLogo.jsx`, `formatVersionLabel` from `admin-console/src/components/version-info.js`, React Router `useNavigate` / `Link`.
- Produces: `/about` route accessible to all logged-in users.

- [ ] **Step 1: Create the About page**

Create `admin-console/src/pages/About.jsx`:

```jsx
import React from 'react';
import AccentureLogo from '../components/AccentureLogo';
import { formatVersionLabel } from '../components/version-info';

const VERSION_LABEL = formatVersionLabel(
  import.meta.env.VITE_GIT_COMMIT,
  import.meta.env.VITE_GIT_DIRTY,
);

export default function About() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: 'var(--eb-space-8) var(--eb-space-6)',
      maxWidth: 600,
      margin: '0 auto',
      gap: 'var(--eb-space-6)',
    }}>
      {/* Accenture copyright */}
      <div style={{ textAlign: 'center' }}>
        <AccentureLogo size={40} style={{ color: 'var(--eb-text-primary)', marginBottom: 'var(--eb-space-3)' }} />
        <div style={{
          fontSize: 'var(--eb-text-md)',
          color: 'var(--eb-text-primary)',
          fontWeight: 'var(--eb-font-medium)',
        }}>
          © 2026 Accenture. All rights reserved.
        </div>
      </div>

      <hr style={{ width: '100%', border: 'none', borderTop: '1px solid var(--eb-border-default)' }} />

      {/* Parakeet attribution (CC-BY-4.0 required) */}
      <div style={{ textAlign: 'center', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)', lineHeight: 1.7 }}>
        <div style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)', marginBottom: 'var(--eb-space-2)' }}>
          Speech-to-text powered by NVIDIA Parakeet TDT 0.6B v3
        </div>
        <div>
          Model:{' '}
          <a href="https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--eb-accent-primary)' }}>
            nvidia/parakeet-tdt-0.6b-v3
          </a>
        </div>
        <div>
          License:{' '}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--eb-accent-primary)' }}>
            CC-BY-4.0
          </a>
        </div>
        <div>Copyright NVIDIA Corporation.</div>
        <div style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Model converted to ONNX (int8) format for CPU inference via sherpa-onnx; no retraining or fine-tuning performed.
        </div>
      </div>

      <hr style={{ width: '100%', border: 'none', borderTop: '1px solid var(--eb-border-default)' }} />

      {/* Version */}
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        v{VERSION_LABEL}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the route to App.jsx**

In `admin-console/src/App.jsx`, add a lazy import after line 72 (after the `MainframeCatalogPage` import):

```javascript
const About = lazy(() => import('./pages/About'));
```

Add the route inside `<Routes>`, after the maintenance-mode route (after line 144):

```jsx
<Route path="/about" element={<About />} />
```

- [ ] **Step 3: Update the sidebar footer in Shell.jsx**

In `admin-console/src/components/Shell.jsx`, replace lines 333–347 (the `{/* Copyright footer */}` block) with:

```jsx
        {/* Copyright footer — links to /about */}
        {!collapsed && (
          <div
            onClick={() => navigate('/about')}
            style={{
              flexShrink: 0,
              padding: 'var(--eb-space-3) var(--eb-space-4)',
              paddingTop: 'var(--eb-space-4)',
              fontSize: 11,
              color: 'var(--eb-text-muted)',
              borderTop: '1px solid var(--eb-border-default)',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              borderRadius: 'var(--eb-radius-sm)',
              transition: 'background var(--eb-transition-fast)',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--eb-bg-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <div style={{ fontWeight: 'bold' }}>About</div>
            <div>© 2026 Accenture. All rights reserved.</div>
            <div data-testid="app-version" style={{ color: 'var(--eb-text-muted)' }}>v{VERSION_LABEL}</div>
          </div>
        )}
```

The `navigate` function is already available in Shell.jsx (imported from `react-router-dom` on line 2).

- [ ] **Step 4: Commit**

```bash
git add admin-console/src/pages/About.jsx admin-console/src/App.jsx admin-console/src/components/Shell.jsx
git commit -m "feat: add About page with Parakeet CC-BY-4.0 attribution"
```

---

### Task 3: Add Parakeet attribution to README

**Files:**
- Modify: `README.md` (append section before the Contributing header, around line 186)

**Interfaces:**
- None — standalone documentation change.

- [ ] **Step 1: Add the Third-party Models section**

In `README.md`, insert the following section immediately before the `## Contributing` line (line 186):

```markdown
## Third-party Models

Speech-to-text powered by [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3).

- **License:** [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)
- **Copyright:** NVIDIA Corporation
- Model converted to ONNX (int8) format for CPU inference via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx); no retraining or fine-tuning performed.

```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add Parakeet TDT 0.6B v3 CC-BY-4.0 attribution to README"
```
