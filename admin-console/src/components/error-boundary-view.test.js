import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_FALLBACK_COPY,
  EVENT_FALLBACK_TEXT,
  redact,
  truncate,
  errorMessage,
  errorName,
  normalizeComponentStack,
  fingerprintError,
  buildErrorReport,
  createReportGate,
  shouldResetOnKeyChange,
} from './error-boundary-view.js';

/* ─── copy ─────────────────────────────────────────────────────────── */

test('the fallback copy offers a recovery path, not just an apology (#1974 AC1)', () => {
  assert.ok(APP_FALLBACK_COPY.title);
  assert.ok(APP_FALLBACK_COPY.retry);
  assert.ok(APP_FALLBACK_COPY.back);
  assert.ok(APP_FALLBACK_COPY.reload);
  assert.ok(EVENT_FALLBACK_TEXT.length > 0);
});

/* ─── redaction / truncation ───────────────────────────────────────── */

test('redact removes an e-mail address and a secret-shaped blob', () => {
  const out = redact('failed for someone@example.com with ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  assert.ok(!out.includes('someone@example.com'));
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok(out.includes('<redacted-email>'));
  assert.ok(out.includes('<redacted-token>'));
});

test('redact leaves an ordinary message untouched', () => {
  const msg = 'Cannot read properties of undefined (reading \'map\')';
  assert.equal(redact(msg), msg);
});

test('redact is total on non-strings', () => {
  assert.equal(redact(null), '');
  assert.equal(redact(undefined), '');
  assert.equal(redact(42), '');
});

test('truncate marks the cut so a reader never mistakes it for the whole message', () => {
  assert.equal(truncate('abcdef', 3), 'abc…[truncated]');
  assert.equal(truncate('abc', 3), 'abc'); // exactly at the cap is not truncated
});

/* ─── error normalization ──────────────────────────────────────────── */

test('errorMessage handles a real Error', () => {
  assert.equal(errorMessage(new TypeError('boom')), 'boom');
});

test('errorMessage survives a thrown non-Error (a throw need not be an Error)', () => {
  assert.equal(errorMessage('plain string throw'), 'plain string throw');
  assert.equal(errorMessage({ nope: 1 }), '[object Object]');
  assert.equal(errorMessage(undefined), 'Unknown error');
  assert.equal(errorMessage(null), 'Unknown error');
  // An object whose String() itself throws must not take the reporter down.
  const hostile = { toString() { throw new Error('nested'); } };
  assert.equal(errorMessage(hostile), 'Unknown error');
});

test('errorMessage caps a very long message', () => {
  // A realistic long message: many short words, so redaction leaves it alone
  // and the length cap is what applies.
  const out = errorMessage(new Error('failed to render row '.repeat(300)));
  assert.ok(out.length < 400);
  assert.ok(out.endsWith('[truncated]'));
});

test('errorMessage collapses one enormous unbroken token rather than truncating it', () => {
  // Documents the redact-then-truncate order: a 5000-char run of word
  // characters with no boundary IS secret-shaped, so it is redacted whole and
  // there is nothing left to truncate. Asserted so the ordering is a decision,
  // not an accident.
  assert.equal(errorMessage(new Error('x'.repeat(5000))), '<redacted-token>');
});

test('errorName reports the constructor name and tolerates its absence', () => {
  assert.equal(errorName(new RangeError('r')), 'RangeError');
  assert.equal(errorName('string throw'), '');
  assert.equal(errorName(null), '');
});

test('normalizeComponentStack keeps the innermost frames and caps the rest', () => {
  const stack = Array.from({ length: 40 }, (_, i) => `    at Component${i}`).join('\n');
  const out = normalizeComponentStack(stack);
  const lines = out.split('\n');
  assert.ok(lines.length <= 12);
  assert.equal(lines[0], 'at Component0'); // innermost frame survives, trimmed
  assert.equal(normalizeComponentStack(''), '');
  assert.equal(normalizeComponentStack(null), '');
});

/* ─── fingerprinting (the dedupe key) ──────────────────────────────── */

test('fingerprintError is stable for the same crash from the same component', () => {
  const a = fingerprintError(new TypeError('boom'), '\n    at ToolBlock\n    at Message');
  const b = fingerprintError(new TypeError('boom'), '\n    at ToolBlock\n    at Message');
  assert.equal(a, b);
});

test('fingerprintError ignores frames ABOVE the culprit, so a re-render loop still dedupes', () => {
  // Same error, same innermost frame, different ancestor chain (which shifts as
  // the tree re-renders). These must collapse onto one fingerprint.
  const a = fingerprintError(new TypeError('boom'), '    at ToolBlock\n    at Message\n    at VirtualList');
  const b = fingerprintError(new TypeError('boom'), '    at ToolBlock\n    at SomethingElse');
  assert.equal(a, b);
});

test('fingerprintError separates different errors and different culprits', () => {
  const base = fingerprintError(new TypeError('boom'), '    at ToolBlock');
  assert.notEqual(base, fingerprintError(new TypeError('other'), '    at ToolBlock'));
  assert.notEqual(base, fingerprintError(new RangeError('boom'), '    at ToolBlock'));
  assert.notEqual(base, fingerprintError(new TypeError('boom'), '    at DiffView'));
});

/* ─── report shape (PII-safety) ────────────────────────────────────── */

test('buildErrorReport carries exactly the triage fields and the identifiers (AC5)', () => {
  const report = buildErrorReport({
    error: new TypeError('boom'),
    componentStack: '    at ToolBlock',
    scope: 'event',
    route: '/chats/dev-1',
    agentId: 'dev-1',
    sessionId: '!room:local',
    eventId: '$evt',
    now: () => Date.parse('2026-09-03T12:00:00Z'),
  });
  assert.equal(report.ts, '2026-09-03T12:00:00.000Z');
  assert.equal(report.scope, 'event');
  assert.equal(report.name, 'TypeError');
  assert.equal(report.message, 'boom');
  assert.equal(report.componentStack, 'at ToolBlock');
  assert.equal(report.route, '/chats/dev-1');
  assert.equal(report.agentId, 'dev-1');
  assert.equal(report.sessionId, '!room:local');
  assert.equal(report.eventId, '$evt');
  assert.ok(report.fingerprint);
});

test('buildErrorReport strips a query string and hash from the route', () => {
  // PII boundary: the caller is expected to pass a pathname, but a search
  // param can carry a filter the user typed — never report it.
  const report = buildErrorReport({ error: new Error('x'), route: '/flows?proc=team-a&q=secret#frag' });
  assert.equal(report.route, '/flows');
});

test('buildErrorReport omits absent identifiers instead of padding empty keys', () => {
  const report = buildErrorReport({ error: new Error('x') });
  assert.ok(!('agentId' in report));
  assert.ok(!('sessionId' in report));
  assert.ok(!('eventId' in report));
  assert.ok(!('route' in report));
});

test('buildErrorReport never carries a message body or arbitrary extra field', () => {
  // The report is a whitelist, not a stripper: an unknown key handed in must
  // not appear in the posted body.
  const report = buildErrorReport({
    error: new Error('x'),
    // eslint-disable-next-line camelcase
    messageBody: 'the user typed this',
    body: 'agent output',
  });
  assert.ok(!('messageBody' in report));
  assert.ok(!('body' in report));
  assert.deepEqual(
    Object.keys(report).sort(),
    ['componentStack', 'fingerprint', 'message', 'name', 'scope', 'ts'],
  );
});

test('buildErrorReport redacts an address that leaked into the error message', () => {
  const report = buildErrorReport({ error: new Error('no mailbox for a@b.com') });
  assert.ok(!report.message.includes('a@b.com'));
});

test('buildErrorReport defaults an unknown scope to app', () => {
  assert.equal(buildErrorReport({ error: new Error('x'), scope: 'nonsense' }).scope, 'app');
  assert.equal(buildErrorReport({ error: new Error('x') }).scope, 'app');
});

test('buildErrorReport tolerates being called with nothing', () => {
  const report = buildErrorReport();
  assert.equal(report.message, 'Unknown error');
});

/* ─── the rate-limit / dedupe gate ─────────────────────────────────── */

test('the gate lets the first report of a fingerprint through and drops the repeats', () => {
  let now = 1000;
  const gate = createReportGate({ windowMs: 60_000, maxPerWindow: 5, now: () => now });
  assert.equal(gate.allow('same'), true);
  assert.equal(gate.allow('same'), false);
  assert.equal(gate.allow('same'), false);
});

test('a re-render loop cannot flood the endpoint (AC5)', () => {
  // The #1857 failure mode: the same error thrown on every frame.
  let now = 0;
  const gate = createReportGate({ now: () => now });
  let sent = 0;
  for (let i = 0; i < 1000; i++) {
    now += 1; // 1ms per frame — all inside one window
    if (gate.allow('react-185|loop|at Message')) sent += 1;
  }
  assert.equal(sent, 1);
});

test('many DISTINCT errors are capped by maxPerWindow', () => {
  let now = 0;
  const gate = createReportGate({ windowMs: 60_000, maxPerWindow: 3, now: () => now });
  const results = [1, 2, 3, 4, 5].map(n => gate.allow(`fp-${n}`));
  assert.deepEqual(results, [true, true, true, false, false]);
});

test('the window rolls, so a persistent problem is re-reported later (not silenced forever)', () => {
  let now = 0;
  const gate = createReportGate({ windowMs: 60_000, maxPerWindow: 1, now: () => now });
  assert.equal(gate.allow('fp'), true);
  assert.equal(gate.allow('fp'), false);
  now += 60_000; // next window
  assert.equal(gate.allow('fp'), true);
});

test('the gate bounds its fingerprint map so a long-lived tab cannot grow it', () => {
  let now = 0;
  const gate = createReportGate({
    windowMs: 10_000_000, maxPerWindow: 10_000, maxTrackedFingerprints: 5, now: () => now,
  });
  for (let i = 0; i < 500; i++) assert.equal(gate.allow(`fp-${i}`), true);
  // Nothing to assert on internals from outside; the invariant we CAN assert is
  // that eviction does not start rejecting fresh fingerprints.
  assert.equal(gate.allow('fp-fresh'), true);
});

test('the gate treats a null fingerprint as one bucket rather than throwing', () => {
  const gate = createReportGate({ maxPerWindow: 5, now: () => 0 });
  assert.equal(gate.allow(null), true);
  assert.equal(gate.allow(null), false);
  assert.equal(gate.allow(undefined), false); // same '' bucket
});

/* ─── reset on route change (AC3) ──────────────────────────────────── */

test('shouldResetOnKeyChange clears only when there IS an error and the key changed', () => {
  assert.equal(shouldResetOnKeyChange('/a', '/b', true), true);
  assert.equal(shouldResetOnKeyChange('/a', '/a', true), false); // same route, keep the fallback
  assert.equal(shouldResetOnKeyChange('/a', '/b', false), false); // healthy tree, nothing to clear
  assert.equal(shouldResetOnKeyChange('/a', '/b', null), false);
});
