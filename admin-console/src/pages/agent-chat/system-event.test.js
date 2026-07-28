import test from 'node:test';
import assert from 'node:assert/strict';
import {
  systemEventExtras,
  systemEventSummary,
  systemEventHasDetail,
  isThinkingTokensEvent,
  mergeThinkingTokens,
} from './system-event.js';

// A realistic thinking_tokens payload: the runtime persists the full parsed CLI
// object as `raw`. The exact field name the CLI uses for the count is treated
// as unknown — the helpers surface whatever scalar extras are present, so this
// keeps working regardless of the field name.
const thinkingTokensRaw = {
  type: 'system',
  subtype: 'thinking_tokens',
  session_id: 'abc-123',
  thinking_tokens: 1234,
};

test('systemEventExtras: drops structural/bookkeeping keys, keeps content', () => {
  assert.deepEqual(systemEventExtras(thinkingTokensRaw), [['thinking_tokens', 1234]]);
});

test('systemEventExtras: drops null/undefined/empty-string values', () => {
  const raw = { type: 'system', subtype: 's', a: 0, b: null, c: undefined, d: '', e: false, f: 'x' };
  // 0 and false are informative and kept; null/undefined/'' are dropped.
  assert.deepEqual(systemEventExtras(raw), [['a', 0], ['e', false], ['f', 'x']]);
});

test('systemEventExtras: [] for missing / non-object / array / label-only', () => {
  assert.deepEqual(systemEventExtras(undefined), []);
  assert.deepEqual(systemEventExtras(null), []);
  assert.deepEqual(systemEventExtras('nope'), []);
  assert.deepEqual(systemEventExtras(42), []);
  assert.deepEqual(systemEventExtras([1, 2, 3]), []);
  assert.deepEqual(systemEventExtras({ type: 'system', subtype: 'thinking_tokens' }), []);
});

test('systemEventSummary: surfaces the token count inline', () => {
  assert.equal(systemEventSummary(thinkingTokensRaw), 'thinking_tokens: 1234');
});

test('systemEventSummary: joins multiple scalars, omits nested objects/arrays', () => {
  const raw = { type: 'system', subtype: 's', count: 5, note: 'hi', nested: { a: 1 }, list: [1] };
  assert.equal(systemEventSummary(raw), 'count: 5 · note: hi');
});

test('systemEventSummary: never renders [object Object]', () => {
  const raw = { type: 'system', subtype: 's', only: { deep: true } };
  assert.equal(systemEventSummary(raw), '');
  assert.ok(!systemEventSummary(raw).includes('[object Object]'));
});

test('systemEventSummary: truncates an over-long scalar value', () => {
  const raw = { type: 'system', subtype: 's', blob: 'x'.repeat(500) };
  const out = systemEventSummary(raw);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length < 500);
});

test('systemEventSummary: empty string when nothing scalar to surface', () => {
  assert.equal(systemEventSummary({ type: 'system', subtype: 'thinking_tokens' }), '');
  assert.equal(systemEventSummary(undefined), '');
});

test('systemEventHasDetail: true only when raw carries content beyond the label', () => {
  assert.equal(systemEventHasDetail({ type: 'system_event', subtype: 'thinking_tokens', raw: thinkingTokensRaw }), true);
  // A nested-only payload has no inline summary but is still expandable.
  assert.equal(systemEventHasDetail({ raw: { type: 'system', subtype: 's', nested: { a: 1 } } }), true);
  // Label-only / missing raw → not expandable.
  assert.equal(systemEventHasDetail({ type: 'system_event', subtype: 'thinking_tokens', raw: { type: 'system', subtype: 'thinking_tokens' } }), false);
  assert.equal(systemEventHasDetail({ type: 'system_event', subtype: 'unknown' }), false);
  assert.equal(systemEventHasDetail(undefined), false);
});

// ── mergeThinkingTokens (#870) ────────────────────────────────────────────
const tt = (cid, n, extra = {}) => ({
  type: 'system_event',
  subtype: 'thinking_tokens',
  correlationId: cid,
  raw: { type: 'system', subtype: 'thinking_tokens', estimated_tokens: n, estimated_tokens_delta: 1, ...extra },
});

test('isThinkingTokensEvent: matches only system_event/thinking_tokens', () => {
  assert.equal(isThinkingTokensEvent(tt('c1', 5)), true);
  assert.equal(isThinkingTokensEvent({ type: 'system_event', subtype: 'other' }), false);
  assert.equal(isThinkingTokensEvent({ type: 'thinking', text: 'x' }), false);
  assert.equal(isThinkingTokensEvent(null), false);
});

test('mergeThinkingTokens: collapses a run of ticks into one row (AC3)', () => {
  const out = mergeThinkingTokens([tt('c1', 100), tt('c1', 150), tt('c1', 317)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].raw.estimated_tokens, 317);
  assert.equal(out[0]._key, 'tt-c1');
});

test('mergeThinkingTokens: stable _key across recomputes so it updates in place (AC4)', () => {
  const a = mergeThinkingTokens([tt('c1', 100), tt('c1', 150)]);
  const b = mergeThinkingTokens([tt('c1', 100), tt('c1', 150), tt('c1', 200)]);
  assert.equal(a[0]._key, b[0]._key);
  assert.equal(b.length, 1);
  assert.equal(b[0].raw.estimated_tokens, 200);
});

test('mergeThinkingTokens: one row per correlationId / run (D2)', () => {
  const out = mergeThinkingTokens([tt('c1', 10), tt('c2', 20), tt('c1', 30), tt('c2', 40)]);
  assert.equal(out.length, 2);
  assert.equal(out.find(e => e.correlationId === 'c1').raw.estimated_tokens, 30);
  assert.equal(out.find(e => e.correlationId === 'c2').raw.estimated_tokens, 40);
});

test('mergeThinkingTokens: interleaved events keep order and pass through (edge)', () => {
  const other = { type: 'assistant_text', text: 'hi', correlationId: 'c1' };
  const tool = { type: 'tool_use', tool: 'X', toolId: 't1', correlationId: 'c1' };
  const out = mergeThinkingTokens([tt('c1', 10), other, tool, tt('c1', 99)]);
  // one consolidated thinking row (anchored at first tick), plus the two others.
  assert.equal(out.length, 3);
  assert.equal(out[0].raw.estimated_tokens, 99);       // updated in place
  assert.equal(out[1], other);                          // untouched, same order
  assert.equal(out[2], tool);
});

test('mergeThinkingTokens: counter reset shows non-decreasing max (edge)', () => {
  // A phase reset: 300 then a fresh phase restarting at 40. The row must not
  // appear to jump backwards.
  const out = mergeThinkingTokens([tt('c1', 300), tt('c1', 40)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].raw.estimated_tokens, 300);
});

test('mergeThinkingTokens: a single tick renders as one correct row (edge)', () => {
  const out = mergeThinkingTokens([tt('c1', 42)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].raw.estimated_tokens, 42);
});

test('mergeThinkingTokens: legacy log full of per-tick lines collapses on reload (AC5)', () => {
  const legacy = Array.from({ length: 200 }, (_, i) => tt('run-x', i + 1));
  const out = mergeThinkingTokens(legacy);
  assert.equal(out.length, 1);
  assert.equal(out[0].raw.estimated_tokens, 200);
});

test('mergeThinkingTokens: non-thinking events pass through unchanged (AC7)', () => {
  const events = [
    { type: 'system_init', model: 'm' },
    { type: 'system_event', subtype: 'other', raw: { x: 1 } },
    { type: 'result', result: 'done' },
  ];
  assert.deepEqual(mergeThinkingTokens(events), events);
});

test('mergeThinkingTokens: missing/null correlationId groups under one row', () => {
  const out = mergeThinkingTokens([tt(undefined, 10), tt(undefined, 20)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].raw.estimated_tokens, 20);
});
