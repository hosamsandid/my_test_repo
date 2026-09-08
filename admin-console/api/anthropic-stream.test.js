'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAnthropicStreamParser } = require('./anthropic-stream');

// A realistic Anthropic Messages streaming body: event: lines are redundant, the
// parser reads only data: lines and switches on the decoded object's `type`.
function sseFrame(obj) {
  return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

const START = sseFrame({ type: 'message_start', message: { id: 'msg_1' } });
const BLOCK_START = sseFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
const PING = 'event: ping\ndata: {"type": "ping"}\n\n';
const BLOCK_STOP = sseFrame({ type: 'content_block_stop', index: 0 });
const MSG_STOP = sseFrame({ type: 'message_stop' });
const delta = (t) => sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });

test('accumulates text across content_block_delta frames', () => {
  const p = createAnthropicStreamParser();
  p.push(START + BLOCK_START);
  p.push(delta('Hello'));
  p.push(PING);
  p.push(delta(', world'));
  p.push(BLOCK_STOP + MSG_STOP);
  p.end();
  assert.equal(p.getText(), 'Hello, world');
  assert.equal(p.getError(), null);
});

test('push returns the running text length, unchanged by a delta-less frame', () => {
  const p = createAnthropicStreamParser();
  assert.equal(p.push(delta('abc')), 3);
  assert.equal(p.push(PING), 3);          // ping adds no characters
  assert.equal(p.push(delta('de')), 5);
});

test('reassembles a frame split across two chunks', () => {
  const p = createAnthropicStreamParser();
  const frame = delta('spread across reads');
  const cut = Math.floor(frame.length / 2);
  p.push(frame.slice(0, cut));
  assert.equal(p.getText(), '');           // nothing usable yet — the data: line is incomplete
  p.push(frame.slice(cut));
  assert.equal(p.getText(), 'spread across reads');
});

test('a data: line arriving without its trailing newline is flushed by end()', () => {
  const p = createAnthropicStreamParser();
  // No terminating "\n\n" — a connection cut right after the JSON.
  p.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'tail' } })}`);
  assert.equal(p.getText(), '');
  p.end();
  assert.equal(p.getText(), 'tail');
});

test('end() is idempotent', () => {
  const p = createAnthropicStreamParser();
  p.push(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } })}`);
  assert.equal(p.end(), 1);
  assert.equal(p.end(), 1);                // second flush is a no-op, not a double-append
  assert.equal(p.getText(), 'x');
});

test('captures the first mid-stream error message and keeps any prior text', () => {
  const p = createAnthropicStreamParser();
  p.push(delta('partial'));
  p.push(sseFrame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
  p.push(sseFrame({ type: 'error', error: { message: 'second error ignored' } }));
  assert.equal(p.getError(), 'Overloaded');
  assert.equal(p.getText(), 'partial');
});

test('falls back to the error type when no message is present', () => {
  const p = createAnthropicStreamParser();
  p.push(sseFrame({ type: 'error', error: { type: 'api_error' } }));
  assert.equal(p.getError(), 'api_error');
});

test('skips a corrupt data: frame without derailing the stream', () => {
  const p = createAnthropicStreamParser();
  p.push('data: {not valid json}\n\n');
  p.push(delta('ok'));
  assert.equal(p.getText(), 'ok');
  assert.equal(p.getError(), null);
});

test('ignores an OpenAI-style [DONE] sentinel and blank/comment lines', () => {
  const p = createAnthropicStreamParser();
  p.push(': this is a comment\n\n');
  p.push(delta('kept'));
  p.push('data: [DONE]\n\n');
  assert.equal(p.getText(), 'kept');
  assert.equal(p.getError(), null);
});
