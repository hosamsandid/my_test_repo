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
