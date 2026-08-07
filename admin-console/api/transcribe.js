'use strict';

// STT request timeout. A meeting segment (up to 120 s of audio, #1296) can
// take longer to transcribe on CPU than the old hard-coded 15 s, so the
// timeout is env-configurable and defaults to 60 s. For short quick-dictation
// clips the timeout is only an upper bound, so raising the default is harmless.
const DEFAULT_STT_TIMEOUT_MS = 60_000;

function resolveTimeoutMs(explicit) {
  const raw = explicit ?? process.env.STT_TIMEOUT_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STT_TIMEOUT_MS;
}

function createTranscribeRoute({ fetchFn = globalThis.fetch, sttUrl, timeoutMs } = {}) {
  const url = sttUrl || process.env.STT_URL || 'http://stt:9000';
  const timeout = resolveTimeoutMs(timeoutMs);

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
        signal: AbortSignal.timeout(timeout),
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

module.exports = { createTranscribeRoute, resolveTimeoutMs, DEFAULT_STT_TIMEOUT_MS };
