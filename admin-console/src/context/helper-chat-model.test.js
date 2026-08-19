import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TURNS,
  SUGGESTED_PROMPTS,
  STREAM_ERROR_TEXT,
  newMessageId,
  appendUserMessage,
  appendAssistantPlaceholder,
  applyDelta,
  finishStreaming,
  failStreaming,
  toRequestMessages,
  buildRequestBody,
  splitNdjson,
} from './helper-chat-model.js';

test('newMessageId returns unique ids', () => {
  const a = newMessageId();
  const b = newMessageId();
  assert.notEqual(a, b);
  assert.equal(typeof a, 'string');
});

test('appendUserMessage adds an immutable user row', () => {
  const before = [];
  const after = appendUserMessage(before, 'hello');
  assert.equal(before.length, 0); // input untouched
  assert.equal(after.length, 1);
  assert.equal(after[0].role, 'user');
  assert.equal(after[0].content, 'hello');
});

test('appendAssistantPlaceholder returns the streaming row id', () => {
  const { id, messages } = appendAssistantPlaceholder([{ id: 'u1', role: 'user', content: 'hi' }]);
  const row = messages.find(m => m.id === id);
  assert.equal(row.role, 'assistant');
  assert.equal(row.content, '');
  assert.equal(row.streaming, true);
});

test('applyDelta accumulates onto the target row only', () => {
  const { id, messages } = appendAssistantPlaceholder([]);
  let next = applyDelta(messages, id, 'Hel');
  next = applyDelta(next, id, 'lo');
  assert.equal(next.find(m => m.id === id).content, 'Hello');
  // Empty delta is a no-op returning the same array reference.
  assert.equal(applyDelta(next, id, ''), next);
});

test('finishStreaming clears the streaming flag', () => {
  const { id, messages } = appendAssistantPlaceholder([]);
  const streamed = applyDelta(messages, id, 'done text');
  const settled = finishStreaming(streamed, id);
  const row = settled.find(m => m.id === id);
  assert.equal(row.streaming, false);
  assert.equal(row.content, 'done text');
});

test('failStreaming replaces the placeholder with the canned error', () => {
  const { id, messages } = appendAssistantPlaceholder([]);
  const failed = failStreaming(messages, id);
  const row = failed.find(m => m.id === id);
  assert.equal(row.content, STREAM_ERROR_TEXT);
  assert.equal(row.streaming, false);
  assert.equal(row.error, true);
});

test('toRequestMessages drops streaming rows and trims to MAX_TURNS', () => {
  const msgs = [];
  const history = [];
  for (let i = 0; i < MAX_TURNS + 5; i++) {
    history.push({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `t${i}` });
  }
  // plus an in-flight streaming placeholder that must be excluded
  history.push({ id: 'stream', role: 'assistant', content: 'partial', streaming: true });
  const out = toRequestMessages(history);
  assert.equal(out.length, MAX_TURNS);
  assert.ok(out.every(m => !('streaming' in m)));
  // trimmed to the newest turns
  assert.equal(out[out.length - 1].content, `t${MAX_TURNS + 4}`);
  assert.equal(msgs.length, 0);
});

test('buildRequestBody includes route fields only when non-empty', () => {
  const messages = appendUserMessage([], 'q');
  const withRoute = buildRequestBody({ messages, currentRoute: '/agents', currentRouteLabel: 'Agents' });
  assert.equal(withRoute.currentRoute, '/agents');
  assert.equal(withRoute.currentRouteLabel, 'Agents');
  assert.equal(withRoute.messages.length, 1);

  const noRoute = buildRequestBody({ messages, currentRoute: '', currentRouteLabel: undefined });
  assert.ok(!('currentRoute' in noRoute));
  assert.ok(!('currentRouteLabel' in noRoute));
});

test('splitNdjson parses whole lines and returns the trailing partial', () => {
  const first = splitNdjson('{"type":"assist"}\n{"type":"delta","text":"He');
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].type, 'assist');
  assert.equal(first.rest, '{"type":"delta","text":"He');

  const second = splitNdjson(first.rest + 'llo"}\n{"type":"done"}\n');
  assert.equal(second.events.length, 2);
  assert.equal(second.events[0].text, 'Hello');
  assert.equal(second.events[1].type, 'done');
  assert.equal(second.rest, '');
});

test('splitNdjson skips corrupt lines without throwing', () => {
  const { events, rest } = splitNdjson('not-json\n{"type":"done"}\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'done');
  assert.equal(rest, '');
});

test('SUGGESTED_PROMPTS are the three static chips', () => {
  assert.equal(SUGGESTED_PROMPTS.length, 3);
  assert.ok(SUGGESTED_PROMPTS.every(p => typeof p === 'string' && p.length > 0));
});
