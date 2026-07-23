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
