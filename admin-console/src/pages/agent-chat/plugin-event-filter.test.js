import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePayloadFilter, formatPayloadFilter, payloadFilterSummary } from './plugin-event-filter.js';

test('parsePayloadFilter: one key=value per line; blank text → null (no filter)', () => {
  assert.deepEqual(parsePayloadFilter(''), { ok: true, value: null });
  assert.deepEqual(parsePayloadFilter('  \n\n'), { ok: true, value: null });
  assert.deepEqual(parsePayloadFilter(undefined), { ok: true, value: null });
  assert.deepEqual(parsePayloadFilter('toStatus=Ready for Dev'), { ok: true, value: { toStatus: 'Ready for Dev' } });
  assert.deepEqual(
    parsePayloadFilter(' toStatus = Ready for Dev \r\nprojectKey=KAN\n'),
    { ok: true, value: { toStatus: 'Ready for Dev', projectKey: 'KAN' } },
  );
});

test('parsePayloadFilter: the value keeps an inner "=" (only the first splits)', () => {
  assert.deepEqual(parsePayloadFilter('summary=a=b'), { ok: true, value: { summary: 'a=b' } });
});

test('parsePayloadFilter: a line without "=", an empty key or an empty value is an error naming the line', () => {
  assert.deepEqual(parsePayloadFilter('Ready for Dev'), { ok: false, error: 'Line 1 must be key=value: "Ready for Dev"' });
  assert.deepEqual(parsePayloadFilter('toStatus=Ready for Dev\n=x'), { ok: false, error: 'Line 2 must be key=value: "=x"' });
  assert.deepEqual(parsePayloadFilter('toStatus='), { ok: false, error: 'Line 1 must be key=value: "toStatus="' });
});

test('parsePayloadFilter: a repeated key keeps the last value', () => {
  assert.deepEqual(parsePayloadFilter('a=1\na=2'), { ok: true, value: { a: '2' } });
});

test('formatPayloadFilter round-trips an object into the editor text; nothing → ""', () => {
  assert.equal(formatPayloadFilter({ toStatus: 'Ready for Dev', projectKey: 'KAN' }), 'toStatus=Ready for Dev\nprojectKey=KAN');
  assert.equal(formatPayloadFilter(null), '');
  assert.equal(formatPayloadFilter(undefined), '');
  assert.equal(formatPayloadFilter('junk'), '');
  assert.equal(formatPayloadFilter({ a: 5, b: '' }), '');          // non-string / blank values are not a filter
  const text = formatPayloadFilter(parsePayloadFilter('x=1\ny=2').value);
  assert.deepEqual(parsePayloadFilter(text).value, { x: '1', y: '2' });
});

test('payloadFilterSummary: the trigger row copy — "key=value" pairs joined by " · ", or ""', () => {
  assert.equal(payloadFilterSummary({ toStatus: 'Ready for Dev' }), 'toStatus=Ready for Dev');
  assert.equal(payloadFilterSummary({ toStatus: 'Ready for Dev', projectKey: 'KAN' }), 'toStatus=Ready for Dev · projectKey=KAN');
  assert.equal(payloadFilterSummary(null), '');
  assert.equal(payloadFilterSummary({}), '');
});
