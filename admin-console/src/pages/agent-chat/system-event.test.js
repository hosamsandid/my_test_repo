import test from 'node:test';
import assert from 'node:assert/strict';
import {
  systemEventExtras,
  systemEventSummary,
  systemEventHasDetail,
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
