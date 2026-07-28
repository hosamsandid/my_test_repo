'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

describe('POST /api/transcribe', () => {
  let transcribeHandler;

  beforeEach(() => {
    mock.restoreAll();
  });

  it('forwards audio to STT service and returns transcribed text', async () => {
    const mockFetch = mock.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ text: ' Hello world. ' }),
      })
    );

    const { createTranscribeRoute } = require('./transcribe.js');
    const handler = createTranscribeRoute({ fetchFn: mockFetch, sttUrl: 'http://stt:9000' });

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
    assert.equal(url, 'http://stt:9000/asr?output=json&vad_filter=true');
    assert.equal(opts.method, 'POST');
  });

  it('returns 500 when STT service responds with an error', async () => {
    const mockFetch = mock.fn(() =>
      Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('Service Unavailable') })
    );

    const { createTranscribeRoute } = require('./transcribe.js');
    const handler = createTranscribeRoute({ fetchFn: mockFetch, sttUrl: 'http://stt:9000' });

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

  it('returns 500 when fetch throws (STT service unreachable)', async () => {
    const mockFetch = mock.fn(() => Promise.reject(new Error('ECONNREFUSED')));

    const { createTranscribeRoute } = require('./transcribe.js');
    const handler = createTranscribeRoute({ fetchFn: mockFetch, sttUrl: 'http://stt:9000' });

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
    const handler = createTranscribeRoute({ fetchFn: mockFetch, sttUrl: 'http://stt:9000' });

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
