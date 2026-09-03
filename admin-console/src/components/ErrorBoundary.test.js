import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {
  ErrorBoundary,
  renderAppFallback,
  renderEventFallback,
} from './ErrorBoundary.js';
import { EVENT_FALLBACK_TEXT, APP_FALLBACK_COPY, createReportGate } from './error-boundary-view.js';

/**
 * These tests drive the REAL `ErrorBoundary` class through React's documented
 * error-boundary contract, without a DOM.
 *
 * Why not render a tree: this repo has no jsdom / react-test-renderer, and
 * React 19's `renderToStaticMarkup` deliberately does NOT honour error
 * boundaries (a throw propagates to the caller — verified before writing
 * this), so an SSR-based "render a stream with one throwing row" test is not
 * available. What IS available is the contract React guarantees, which is
 * exactly three things, and each is exercised here against the real class:
 *
 *   1. on a child throw React calls `getDerivedStateFromError(error)` and
 *      re-renders the boundary with the returned state;
 *   2. it then calls `componentDidCatch(error, info)`;
 *   3. a boundary's fallback replaces ONLY its own subtree — which is why
 *      per-row boundaries isolate a row.
 *
 * So the tests below feed the class the same inputs React would, and assert
 * what it renders and reports. Point (3) is React's own semantics, not
 * something this file can prove; what it proves is that each row boundary
 * holds its own independent state and renders its own children untouched
 * while a sibling is in its fallback. The JSX wiring that puts these
 * boundaries in the tree is covered by `error-boundary-wiring.test.js`.
 */

/* ─── tiny element helpers (no renderer available) ─────────────────── */

/** Flatten the text content of a React element tree. */
function textOf(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.props) return textOf(node.props.children);
  return '';
}

/** Find the first element in the tree carrying `data-testid`. */
function findTestId(node, id) {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const c of node) {
      const hit = findTestId(c, id);
      if (hit) return hit;
    }
    return null;
  }
  if (node.props && node.props['data-testid'] === id) return node;
  return node.props ? findTestId(node.props.children, id) : null;
}

/** Build a boundary instance the way React would, with a stub setState. */
function makeBoundary(props = {}) {
  const b = new ErrorBoundary(props);
  b.setState = (patch) => {
    b.state = { ...b.state, ...(typeof patch === 'function' ? patch(b.state) : patch) };
  };
  return b;
}

/** Drive one full React catch cycle against a boundary instance. */
function simulateThrow(boundary, error, componentStack = '    at Thrower') {
  boundary.state = { ...boundary.state, ...ErrorBoundary.getDerivedStateFromError(error) };
  boundary.componentDidCatch(error, { componentStack });
}

// componentDidCatch console.warns by design; keep the test output readable.
const origWarn = console.warn;
console.warn = () => {};
process.on('exit', () => { console.warn = origWarn; });

/* ─── AC6(a): fallback render + telemetry on a throwing child ──────── */

test('a healthy boundary renders its children UNTOUCHED (no wrapper element)', () => {
  const children = React.createElement('p', null, 'the real row');
  const b = makeBoundary({ children, renderFallback: renderEventFallback });
  const out = b.render();
  // Identity, not equality: the happy path must not clone or wrap, or adding a
  // boundary would disturb parent layout and row measurement.
  assert.equal(out, children);
});

test('getDerivedStateFromError stores the error so render switches to the fallback', () => {
  assert.deepEqual(ErrorBoundary.getDerivedStateFromError(new Error('boom')).error.message, 'boom');
});

test('a boundary that caught renders the fallback instead of its children (AC6a)', () => {
  const children = React.createElement('p', null, 'the real row');
  const b = makeBoundary({ children, renderFallback: renderEventFallback, reportError: () => {} });
  simulateThrow(b, new Error('boom'));
  const out = b.render();
  assert.notEqual(out, children);
  assert.ok(!textOf(out).includes('the real row'));
  assert.equal(textOf(out), EVENT_FALLBACK_TEXT);
});

test('componentDidCatch reports a PII-safe telemetry record (AC6a, AC5)', () => {
  const sent = [];
  const b = makeBoundary({
    renderFallback: renderEventFallback,
    reportError: r => sent.push(r),
    gate: createReportGate({ now: () => 0 }),
    context: { scope: 'event', route: '/chats/dev-1', agentId: 'dev-1', eventId: '$e1' },
  });
  simulateThrow(b, new TypeError('bad shape'), '    at ToolBlock\n    at LogEvent');

  assert.equal(sent.length, 1);
  const r = sent[0];
  assert.equal(r.scope, 'event');
  assert.equal(r.name, 'TypeError');
  assert.equal(r.message, 'bad shape');
  assert.equal(r.route, '/chats/dev-1');
  assert.equal(r.agentId, 'dev-1');
  assert.equal(r.eventId, '$e1');
  assert.equal(r.componentStack, 'at ToolBlock\nat LogEvent');
  assert.ok(r.fingerprint);
});

test('the boundary honours the gate — a repeated crash is reported once', () => {
  const sent = [];
  const gate = createReportGate({ now: () => 0 });
  const props = { renderFallback: renderEventFallback, reportError: r => sent.push(r), gate, context: {} };
  // Same error re-thrown from the same component, as a re-render loop does.
  for (let i = 0; i < 50; i++) simulateThrow(makeBoundary(props), new Error('loop'), '    at Message');
  assert.equal(sent.length, 1);
});

test('a boundary with no fallback renders nothing rather than throwing', () => {
  const b = makeBoundary({ children: React.createElement('p', null, 'x'), reportError: () => {} });
  simulateThrow(b, new Error('boom'));
  assert.equal(b.render(), null);
});

/* ─── AC6(b): one throwing event does not take out its siblings ────── */

test('one failing row degrades to a placeholder while the other rows still render (AC4, AC6b)', () => {
  // A stream of three rows, each with its own boundary — the wiring both
  // ChatPanel and SessionLogPanel now use. Row 2's child throws.
  const rows = ['row-1', 'row-2', 'row-3'].map(label =>
    makeBoundary({
      children: React.createElement('p', null, label),
      renderFallback: renderEventFallback,
      reportError: () => {},
      gate: createReportGate({ now: () => 0 }),
      context: { scope: 'event', eventId: label },
    }),
  );

  simulateThrow(rows[1], new Error('malformed event'), '    at ToolBlock');

  const rendered = rows.map(r => textOf(r.render()));
  assert.equal(rendered[0], 'row-1');           // unaffected
  assert.equal(rendered[1], EVENT_FALLBACK_TEXT); // degraded, in place
  assert.equal(rendered[2], 'row-3');           // unaffected

  // And the healthy rows are still the ORIGINAL children (identity), i.e. the
  // failure did not reset or re-create them.
  assert.equal(rows[0].render(), rows[0].props.children);
  assert.equal(rows[2].render(), rows[2].props.children);
});

test('each row boundary keeps its own independent error state', () => {
  const a = makeBoundary({ children: 'a', renderFallback: renderEventFallback, reportError: () => {} });
  const b = makeBoundary({ children: 'b', renderFallback: renderEventFallback, reportError: () => {} });
  simulateThrow(a, new Error('x'));
  assert.ok(a.state.error);
  assert.equal(b.state.error, null);
});

/* ─── AC6(c): reset on route change ────────────────────────────────── */

test('the boundary clears its error when the route resetKey changes (AC3, AC6c)', () => {
  const pageArea = React.createElement('main', null, 'the routed page');
  const b = makeBoundary({
    resetKey: '/agents', children: pageArea, renderFallback: renderAppFallback, reportError: () => {},
  });
  simulateThrow(b, new Error('page crashed'));
  assert.ok(b.state.error);

  // React calls componentDidUpdate with the PREVIOUS props after a re-render
  // with the new ones — navigation to /flows.
  b.props = { ...b.props, resetKey: '/flows' };
  b.componentDidUpdate({ resetKey: '/agents' });

  assert.equal(b.state.error, null);
  assert.equal(b.render(), pageArea); // back to rendering the page area
});

test('render() returns null rather than undefined when there are no children', () => {
  // A class render() may not return undefined; a row renderer is allowed to
  // produce nothing for an event it chooses to hide.
  assert.equal(makeBoundary({ renderFallback: renderEventFallback }).render(), null);
});

test('a re-render on the SAME route does not clear the fallback', () => {
  const b = makeBoundary({ resetKey: '/agents', renderFallback: renderAppFallback, reportError: () => {} });
  simulateThrow(b, new Error('page crashed'));
  b.componentDidUpdate({ resetKey: '/agents' });
  assert.ok(b.state.error, 'the error must survive an unrelated re-render');
});

test('componentDidUpdate on a healthy boundary is a no-op', () => {
  const b = makeBoundary({ resetKey: '/a', renderFallback: renderAppFallback });
  b.props = { ...b.props, resetKey: '/b' };
  b.componentDidUpdate({ resetKey: '/a' });
  assert.equal(b.state.error, null);
});

test('the explicit reset() action clears the error (the Try again button)', () => {
  const b = makeBoundary({ renderFallback: renderAppFallback, reportError: () => {} });
  simulateThrow(b, new Error('boom'));
  b.reset();
  assert.equal(b.state.error, null);
});

/* ─── the fallback UIs themselves ──────────────────────────────────── */

test('the app fallback offers all three recovery actions and names the error (AC1)', () => {
  const el = renderAppFallback(new Error('the specific failure'), () => {});
  const text = textOf(el);
  assert.ok(text.includes(APP_FALLBACK_COPY.title));
  assert.ok(text.includes(APP_FALLBACK_COPY.retry));
  assert.ok(text.includes(APP_FALLBACK_COPY.back));
  assert.ok(text.includes(APP_FALLBACK_COPY.reload));
  assert.ok(text.includes('the specific failure'), 'the message is shown so a report is actionable');
  assert.ok(findTestId(el, 'app-error-fallback'));
  assert.equal(el.props.role, 'alert');
});

test('the app fallback Try again button is wired to the reset callback', () => {
  let reset = 0;
  const el = renderAppFallback(new Error('x'), () => { reset += 1; });
  // Walk to the button whose label is the retry copy and invoke its handler.
  const buttons = [];
  (function walk(n) {
    if (n == null || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'button') buttons.push(n);
    if (n.props) walk(n.props.children);
  })(el);
  const retry = buttons.find(b => textOf(b) === APP_FALLBACK_COPY.retry);
  assert.ok(retry, 'a retry button exists');
  retry.props.onClick();
  assert.equal(reset, 1);
});

test('the event fallback is an inline, non-alarming placeholder row (AC4)', () => {
  const el = renderEventFallback();
  assert.equal(textOf(el), EVENT_FALLBACK_TEXT);
  assert.ok(findTestId(el, 'event-error-fallback'));
  // 'note', not 'alert': one bad row must not shout over the whole transcript.
  assert.equal(el.props.role, 'note');
});
