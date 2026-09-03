import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { MarkdownSafeBoundary, plainTextFallback } from './markdown-safe.js';

/**
 * Drives the REAL `MarkdownSafeBoundary` class through React's error-boundary
 * contract without a DOM (same approach + limitation as `ErrorBoundary.test.js`:
 * no jsdom/renderer, and `renderToStaticMarkup` does not honour boundaries).
 *
 * The load-bearing guarantee is that a boundary never re-renders a child it has
 * already seen throw — so the tests assert (1) one throw flips it permanently to
 * the fallback, and (2) `plainTextFallback` is genuinely infallible for every
 * body shape, which is what makes the innermost tier a valid floor.
 */

/** Build a boundary the way React would, with a stub setState. */
function makeBoundary(props = {}) {
  const b = new MarkdownSafeBoundary(props);
  b.setState = (patch) => {
    b.state = { ...b.state, ...(typeof patch === 'function' ? patch(b.state) : patch) };
  };
  return b;
}

/** Drive one React catch cycle against a boundary instance. */
function simulateThrow(boundary, error) {
  boundary.state = { ...boundary.state, ...MarkdownSafeBoundary.getDerivedStateFromError(error) };
  boundary.componentDidCatch(error);
}

/* ─── the boundary switches primary → fallback on a throw ──────────── */

test('a healthy boundary renders primary() and never calls fallback()', () => {
  const primary = () => 'PRIMARY';
  let fallbackCalls = 0;
  const b = makeBoundary({ primary, fallback: () => { fallbackCalls++; return 'FALLBACK'; } });
  assert.equal(b.render(), 'PRIMARY');
  assert.equal(fallbackCalls, 0);
});

test('getDerivedStateFromError flips failed:true', () => {
  assert.deepEqual(MarkdownSafeBoundary.getDerivedStateFromError(new Error('x')), { failed: true });
});

test('after a catch the boundary renders fallback() instead of primary()', () => {
  let primaryCalls = 0;
  const b = makeBoundary({
    primary: () => { primaryCalls++; return 'PRIMARY'; },
    fallback: () => 'FALLBACK',
  });
  simulateThrow(b, new Error('boom'));
  const before = primaryCalls;
  assert.equal(b.render(), 'FALLBACK');
  // primary() must not run again once we know it throws — that re-run is the
  // exact loop (#185) this class exists to prevent.
  assert.equal(primaryCalls, before);
});

test('the switch is monotonic — a re-render stays on the fallback', () => {
  const b = makeBoundary({ primary: () => 'PRIMARY', fallback: () => 'FALLBACK' });
  simulateThrow(b, new Error('boom'));
  assert.equal(b.render(), 'FALLBACK');
  assert.equal(b.render(), 'FALLBACK');
  assert.equal(b.state.failed, true);
});

test('componentDidCatch forwards the error to onError, and is safe without one', () => {
  const seen = [];
  const b = makeBoundary({ primary: () => null, fallback: () => null, onError: (e) => seen.push(e) });
  const err = new TypeError('bad shape');
  simulateThrow(b, err);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], err);

  const b2 = makeBoundary({ primary: () => null, fallback: () => null }); // no onError
  assert.doesNotThrow(() => simulateThrow(b2, new Error('boom')));
});

/* ─── plainTextFallback is the infallible floor ────────────────────── */

test('plainTextFallback renders a div and never invokes markdown', () => {
  const el = plainTextFallback('hello');
  assert.equal(el.type, 'div');
  assert.equal(el.props.children, 'hello');
  assert.equal(el.props.style.whiteSpace, 'pre-wrap');
});

test('plainTextFallback preserves newlines verbatim (no parsing)', () => {
  const el = plainTextFallback('a\n\n- not a list\n```not code```');
  assert.equal(el.props.children, 'a\n\n- not a list\n```not code```');
});

test('plainTextFallback coerces any non-string body without throwing', () => {
  for (const [input, expected] of [
    [null, ''],
    [undefined, ''],
    [42, '42'],
    [{ a: 1 }, '[object Object]'],
    [['x', 'y'], 'x,y'],
    [true, 'true'],
  ]) {
    let el;
    assert.doesNotThrow(() => { el = plainTextFallback(input); });
    assert.equal(el.props.children, expected);
  }
});
