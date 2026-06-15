'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcileSessionAppend } = require('./session-cursor');

// The session-log byte-cursor push (#185) — "the one sharp edge". The admin SSE
// viewer resumes by byte offset, so the control-plane copy must stay
// byte-identical to the agent's local file. These tests pin the reconciliation
// math the /internal/agents/:id/session-events handler relies on.

test('base == cur → fresh append of the whole buffer', () => {
  const r = reconcileSessionAppend(100, 100, 50);
  assert.equal(r.gap, false);
  assert.equal(r.sliceFrom, 0);     // nothing overlaps
  assert.equal(r.appendLen, 50);    // append all 50 bytes
  assert.equal(r.offset, 150);      // new acked end
});

test('base < cur (lost-ACK retry) → append only the part beyond cur', () => {
  // Agent re-sent from 100; control already advanced to 120. 20 bytes overlap.
  const r = reconcileSessionAppend(100, 120, 50);
  assert.equal(r.gap, false);
  assert.equal(r.sliceFrom, 20);    // skip the 20 bytes we already have
  assert.equal(r.appendLen, 30);    // append the remaining 30
  assert.equal(r.offset, 150);
});

test('base < cur, fully-stale retry (overlap >= dataLen) → append nothing', () => {
  // Control is far ahead of what the agent re-sent; every sent byte is a dup.
  const r = reconcileSessionAppend(100, 200, 50);
  assert.equal(r.gap, false);
  assert.equal(r.sliceFrom, 50);    // clamped to buffer length, not 100
  assert.equal(r.appendLen, 0);     // nothing to write
  assert.equal(r.offset, 150);      // offset still base + dataLen (contract)
});

test('base > cur (gap) → no write, ask agent to resend from cur', () => {
  const r = reconcileSessionAppend(200, 100, 50);
  assert.equal(r.gap, true);
  assert.equal(r.ok, false);
  assert.equal(r.expected, 100);    // = cur; agent rewinds to here
});

test('empty buffer at a fresh offset → no-op append, offset unchanged', () => {
  const r = reconcileSessionAppend(0, 0, 0);
  assert.equal(r.gap, false);
  assert.equal(r.appendLen, 0);
  assert.equal(r.offset, 0);
});

test('non-finite baseOffset is sanitized to 0 (matches the legacy inline check)', () => {
  // Only NON-finite values are coerced to 0 — exactly what the endpoint did
  // before extraction. A finite negative is NOT clamped (see next test).
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'x']) {
    const r = reconcileSessionAppend(bad, 0, 10);
    assert.equal(r.gap, false, `base=${String(bad)} should not gap against cur=0`);
    assert.equal(r.sliceFrom, 0);
    assert.equal(r.appendLen, 10);
    assert.equal(r.offset, 10);     // base treated as 0 → 0 + 10
  }
});

test('finite negative baseOffset passes through unclamped (preserves legacy behaviour)', () => {
  // Pathological input that never occurs in practice; pinned only to prove the
  // extraction did not change the inline code's handling of it.
  const r = reconcileSessionAppend(-5, 0, 10);
  assert.equal(r.gap, false);       // -5 > 0 is false → no gap
  assert.equal(r.sliceFrom, 5);     // overlap = 0 - (-5) = 5
  assert.equal(r.appendLen, 5);     // 10 - 5
  assert.equal(r.offset, 5);        // base + len = -5 + 10
});

test('absent control file (cur = 0) with non-zero base → gap, expected 0', () => {
  const r = reconcileSessionAppend(500, 0, 40);
  assert.equal(r.gap, true);
  assert.equal(r.expected, 0);
});

test('idempotent first push then exact retry yields the same end offset', () => {
  const first = reconcileSessionAppend(0, 0, 64);     // initial push
  assert.equal(first.offset, 64);
  // Agent never saw the ACK and retries the same bytes; control now at 64.
  const retry = reconcileSessionAppend(0, 64, 64);
  assert.equal(retry.gap, false);
  assert.equal(retry.appendLen, 0);                   // all 64 bytes are dups
  assert.equal(retry.offset, 64);                     // converges, no duplication
});
