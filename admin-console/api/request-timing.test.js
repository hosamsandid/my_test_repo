'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  collapsePath, routeKey, percentile, createRequestTimer, eventLoopDelayMs,
  formatSummaryLine, formatSlowLine, perfConfigFromEnv, trackRequest,
  createPerfReporter, createPerfTiming, OVERFLOW_ROUTE, LOOP_RESOLUTION_MS,
} = require('./request-timing');

// ── route normalisation ─────────────────────────────────────────────────────

test('collapsePath collapses the segment after an id collection (slug agent ids)', () => {
  assert.equal(collapsePath('/api/agents/cobol-agent/statuses'), '/api/agents/:id/statuses');
  assert.equal(collapsePath('/internal/agents/team-x-dev-i2846/running-sessions'),
    '/internal/agents/:id/running-sessions');
  assert.equal(collapsePath('/api/teams/payments/skills/cobol-review'),
    '/api/teams/:id/skills/:id');
});

test('collapsePath collapses the id after session / memory / credentials / prompt-history / access', () => {
  assert.equal(collapsePath('/api/agents/a/session/%21room%3Alocal/locate'), '/api/agents/:id/session/:id/locate');
  assert.equal(collapsePath('/internal/blueprints/bp-1/memory/users.md'), '/internal/blueprints/:id/memory/:id');
  assert.equal(collapsePath('/api/plugins/jira/credentials/payments/test'), '/api/plugins/:id/credentials/:id/test');
  assert.equal(collapsePath('/api/agents/a/prompt-history/v3/revert'), '/api/agents/:id/prompt-history/:id/revert');
  assert.equal(collapsePath('/api/process/drafts/d1/access/alice'), '/api/process/drafts/:id/access/:id');
  // The bare collection (a list endpoint) stays as it is.
  assert.equal(collapsePath('/api/agents/a/prompt-history'), '/api/agents/:id/prompt-history');
  assert.equal(collapsePath('/api/auth/session'), '/api/auth/session');
});

test('collapsePath keeps static children of an id collection literal', () => {
  assert.equal(collapsePath('/internal/agents/processes'), '/internal/agents/processes');
  assert.equal(collapsePath('/api/agents/statuses'), '/api/agents/statuses');
});

test('collapsePath collapses id-shaped segments anywhere and drops the query', () => {
  assert.equal(collapsePath('/internal/llm-auth/flows/0123abcd9f?x=1'), '/internal/llm-auth/flows/:id');
  assert.equal(collapsePath('/api/usage/42'), '/api/usage/:id');
  assert.equal(collapsePath('/api/x/3f2504e0-4f89-41d3-9a0c-0305e82c3301'), '/api/x/:id');
  // Matrix room id, URL-encoded and raw.
  assert.equal(collapsePath('/internal/agents/a/sessions/%21abc%3Alocal'), '/internal/agents/:id/sessions/:id');
  assert.equal(collapsePath('/api/matrix/x/!abc:local'), '/api/matrix/x/:id');
});

test('collapsePath bounds the segment count and tolerates junk', () => {
  const long = '/a/b/c/d/e/f/g/h/i/j/k/l';
  assert.ok(collapsePath(long).endsWith('/…'));
  assert.equal(collapsePath(''), '/');
  assert.equal(collapsePath(undefined), '/');
  assert.equal(collapsePath('/api/%E0%A4%A'), '/api/%E0%A4%A'); // undecodable stays raw
});

test('routeKey prefers the matched express route, joined with baseUrl', () => {
  assert.equal(routeKey({ method: 'GET', route: { path: '/api/agents/:id' }, baseUrl: '', originalUrl: '/api/agents/a' }),
    'GET /api/agents/:id');
  assert.equal(routeKey({ method: 'POST', route: { path: '/x/:id' }, baseUrl: '/api/plugins', originalUrl: '/api/plugins/x/1' }),
    'POST /api/plugins/x/:id');
});

test('routeKey falls back to the collapsed originalUrl, then url', () => {
  assert.equal(routeKey({ method: 'GET', originalUrl: '/api/agents/a/b', url: '/b' }), 'GET /api/agents/:id/b');
  assert.equal(routeKey({ method: 'DELETE', url: '/internal/teams/t1/members' }), 'DELETE /internal/teams/:id/members');
  assert.equal(routeKey({ method: 'GET', route: { path: /regex/ }, url: '/api/agents/a' }), 'GET /api/agents/:id');
});

// ── samples + summary ───────────────────────────────────────────────────────

test('percentile is nearest-rank', () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(s, 50), 5);
  assert.equal(percentile(s, 90), 9);
  assert.equal(percentile(s, 100), 10);
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([7], 1), 7);
});

test('summarize reports p50/p90/max/count, ranked by total time', () => {
  const t = createRequestTimer();
  for (let i = 1; i <= 10; i++) t.record('GET /cheap', i);          // total 55
  t.record('GET /hot', 400); t.record('GET /hot', 600);             // total 1000
  const s = t.summarize();
  assert.equal(s.count, 12);
  assert.deepEqual(s.routes.map(r => r.route), ['GET /hot', 'GET /cheap']);
  assert.deepEqual(s.routes[1], { route: 'GET /cheap', count: 10, totalMs: 55, p50: 5, p90: 9, max: 10, aborted: 0, slow: 0 });
  assert.equal(s.routes[0].max, 600);
});

test('summarize honours topN; reset clears the window', () => {
  const t = createRequestTimer();
  for (let i = 0; i < 5; i++) t.record(`GET /r${i}`, i + 1);
  assert.equal(t.summarize({ topN: 2 }).routes.length, 2);
  assert.equal(t.summarize({ topN: 2 }).count, 5, 'count is over every route, not just the top N');
  t.reset();
  assert.deepEqual(t.summarize(), { count: 0, aborted: 0, slow: 0, slowSuppressed: 0, routes: [] });
});

test('the per-route ring is bounded but count/total/max stay exact', () => {
  const t = createRequestTimer({ samplesPerRoute: 4 });
  for (const ms of [1000, 1, 1, 1, 1, 1]) t.record('GET /r', ms);
  const [row] = t.summarize().routes;
  assert.equal(row.count, 6);
  assert.equal(row.totalMs, 1005);
  assert.equal(row.max, 1000, 'max survives the sample that rolled out of the ring');
  assert.equal(row.p90, 1, 'percentiles are over the most recent samples');
});

test('routes past maxRoutes pool into one overflow bucket', () => {
  const t = createRequestTimer({ maxRoutes: 2 });
  t.record('GET /a', 1); t.record('GET /b', 1); t.record('GET /c', 1); t.record('GET /d', 1);
  assert.equal(t.size(), 3);
  const overflow = t.summarize().routes.find(r => r.route === OVERFLOW_ROUTE);
  assert.equal(overflow.count, 2);
  t.record('GET /a', 1);
  assert.equal(t.summarize().routes.find(r => r.route === 'GET /a').count, 2, 'a known route still records');
});

test('aborted requests are samples, counted per route and in total', () => {
  const t = createRequestTimer();
  t.record('GET /r', 10); t.record('GET /r', 900, { aborted: true }); t.record('GET /s', 5, { aborted: true });
  const s = t.summarize();
  assert.equal(s.count, 3);
  assert.equal(s.aborted, 2);
  assert.equal(s.routes.find(r => r.route === 'GET /r').aborted, 1);
  assert.equal(s.routes.find(r => r.route === 'GET /r').max, 900);
});

test('admitSlowLine allows the first N slow lines per route per window, counts the rest', () => {
  const t = createRequestTimer({ slowLinesPerRoute: 2 });
  assert.deepEqual([1, 2, 3, 4].map(() => t.admitSlowLine('GET /a')), [true, true, false, false]);
  assert.equal(t.admitSlowLine('GET /b'), true, 'the budget is per route');
  let s = t.summarize();
  assert.equal(s.slow, 5);
  assert.equal(s.slowSuppressed, 2);
  assert.equal(s.routes.find(r => r.route === 'GET /a').slow, 4);
  t.reset();
  assert.equal(t.admitSlowLine('GET /a'), true, 'a new window restores the budget');
  s = t.summarize();
  assert.equal(s.slowSuppressed, 0);
});

test('record ignores non-finite and negative durations', () => {
  const t = createRequestTimer();
  t.record('GET /r', NaN); t.record('GET /r', -1); t.record('GET /r', Infinity);
  assert.equal(t.summarize().count, 0);
});

// ── event loop + formatting ─────────────────────────────────────────────────

function fakeHistogram({ p50 = 10e6, p99 = 50e6, max = 200e6 } = {}) {
  return { percentile: (p) => (p === 50 ? p50 : p99), max, resets: 0, reset() { this.resets++; } };
}

test('eventLoopDelayMs converts ns to ms; empty or missing histogram → null', () => {
  assert.deepEqual(eventLoopDelayMs(fakeHistogram()), { p50: 10, p99: 50, max: 200 });
  assert.equal(eventLoopDelayMs(fakeHistogram({ max: 0 }), { resolutionMs: 20 }), null);
  assert.equal(eventLoopDelayMs(fakeHistogram({ max: 0 })), null);
  assert.equal(eventLoopDelayMs(null), null);
  assert.equal(eventLoopDelayMs({}), null);
});

test('eventLoopDelayMs subtracts the sampling resolution, floored at 0', () => {
  // An idle loop at resolution 20 samples ≈ 21ms per tick — that is ~1ms of delay.
  assert.deepEqual(
    eventLoopDelayMs(fakeHistogram({ p50: 21e6, p99: 22.5e6, max: 120e6 }), { resolutionMs: 20 }),
    { p50: 1, p99: 2.5, max: 100 });
  assert.deepEqual(
    eventLoopDelayMs(fakeHistogram({ p50: 19e6, p99: 19e6, max: 19e6 }), { resolutionMs: 20 }),
    { p50: 0, p99: 0, max: 0 });
});

test('formatSummaryLine renders the [perf] line', () => {
  const t = createRequestTimer();
  t.record('GET /api/matrix/agents', 120); t.record('GET /api/matrix/agents', 1240, { aborted: true });
  t.record('GET /api/x', 3);
  t.admitSlowLine('GET /api/matrix/agents');
  const line = formatSummaryLine({
    windowMs: 60_000,
    summary: { ...t.summarize(), slow: 7, slowSuppressed: 2 },
    loop: { p50: 0.64, p99: 28.2, max: 192 },
  });
  assert.equal(line,
    '[perf] window=60s requests=3 aborted=1 slow=7 slow-suppressed=2 loop p50=0.6ms p99=28.2ms max=192.0ms'
    + ' | GET /api/matrix/agents n=2 p50=120ms p90=1.2s max=1.2s total=1.4s slow=1 aborted=1'
    + '; GET /api/x n=1 p50=3ms p90=3ms max=3ms total=3ms');
});

test('formatSummaryLine with no requests and no loop data', () => {
  assert.equal(formatSummaryLine({ windowMs: 60_000, summary: { count: 0, routes: [] }, loop: null }),
    '[perf] window=60s requests=0 aborted=0 slow=0 slow-suppressed=0 loop -');
});

test('formatSlowLine', () => {
  assert.equal(formatSlowLine({ route: 'GET /api/x', ms: 734.2, status: 200 }), '[perf] slow GET /api/x 734ms status=200');
  assert.equal(formatSlowLine({ route: 'GET /api/x', ms: 2500, status: null, aborted: true }),
    '[perf] slow GET /api/x 2.5s status=- aborted');
});

test('perfConfigFromEnv: default on at 500ms; AEE_PERF_LOG=0 disables', () => {
  assert.deepEqual(perfConfigFromEnv({}), { enabled: true, slowMs: 500 });
  assert.deepEqual(perfConfigFromEnv({ AEE_PERF_LOG: '0' }), { enabled: false, slowMs: 500 });
  assert.deepEqual(perfConfigFromEnv({ AEE_PERF_LOG: '1', AEE_SLOW_REQUEST_MS: '250' }), { enabled: true, slowMs: 250 });
  assert.equal(perfConfigFromEnv({ AEE_SLOW_REQUEST_MS: 'abc' }).slowMs, 500);
  assert.equal(perfConfigFromEnv({ AEE_SLOW_REQUEST_MS: '-5' }).slowMs, 500);
});

// ── trackRequest ────────────────────────────────────────────────────────────

function fakeRes({ type = 'application/json', status = 200 } = {}) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.getHeader = (h) => (h === 'content-type' ? type : undefined);
  return res;
}

test('trackRequest records at finish with the route resolved then, and logs slow requests', () => {
  let clock = 1000;
  const timer = createRequestTimer();
  const logs = [];
  const req = { method: 'GET', originalUrl: '/api/agents/a' };
  const res = fakeRes();
  trackRequest(req, res, { timer, now: () => clock, slowMs: 500, log: (l) => logs.push(l) });
  req.route = { path: '/api/agents/:id' }; // routing happens after the middleware
  req.baseUrl = '';
  clock += 600;
  res.emit('finish');
  assert.deepEqual(t2rows(timer), [['GET /api/agents/:id', 1, 600]]);
  assert.deepEqual(logs, ['[perf] slow GET /api/agents/:id 600ms status=200']);
});

test('trackRequest does not log a fast request', () => {
  let clock = 0;
  const timer = createRequestTimer();
  const logs = [];
  const res = fakeRes();
  trackRequest({ method: 'GET', url: '/x' }, res, { timer, now: () => clock, slowMs: 500, log: (l) => logs.push(l) });
  clock = 499;
  res.emit('finish');
  assert.equal(timer.summarize().count, 1);
  assert.deepEqual(logs, []);
});

test('trackRequest records a client-aborted request once, at close, flagged aborted', () => {
  let clock = 0;
  const timer = createRequestTimer();
  const logs = [];
  const res = fakeRes();
  res.headersSent = false;
  res.writableFinished = false;
  trackRequest({ method: 'GET', url: '/api/agents/a/workspace' }, res, { timer, now: () => clock, slowMs: 500, log: (l) => logs.push(l) });
  clock = 1500;
  res.emit('close');
  res.emit('close');
  const s = timer.summarize();
  assert.equal(s.count, 1);
  assert.equal(s.aborted, 1);
  assert.deepEqual(logs, ['[perf] slow GET /api/agents/:id/workspace 1.5s status=- aborted']);
});

test('trackRequest records a finished request once even though close follows finish', () => {
  let clock = 0;
  const timer = createRequestTimer();
  const res = fakeRes();
  trackRequest({ method: 'GET', url: '/x' }, res, { timer, now: () => clock, log: () => {} });
  clock = 10;
  res.writableFinished = true;
  res.emit('finish');
  clock = 20;
  res.emit('close');
  const s = timer.summarize();
  assert.equal(s.count, 1);
  assert.equal(s.aborted, 0);
  assert.equal(s.routes[0].max, 10);
});

test('trackRequest caps slow lines per route; the summary carries the suppressed count', () => {
  let clock = 0;
  const timer = createRequestTimer({ slowLinesPerRoute: 2 });
  const logs = [];
  for (let i = 0; i < 5; i++) {
    const res = fakeRes();
    const startedAt = clock;
    trackRequest({ method: 'GET', url: '/api/agents/a/x' }, res, { timer, now: () => clock, slowMs: 500, log: (l) => logs.push(l) });
    clock = startedAt + 800;
    res.emit('finish');
  }
  assert.equal(logs.length, 2);
  assert.equal(timer.summarize().count, 5, 'every request is still recorded');
  assert.match(formatSummaryLine({ windowMs: 60_000, summary: timer.summarize(), loop: null }),
    / slow=5 slow-suppressed=3 .* slow=5$/);
});

test('trackRequest skips server-sent-event streams', () => {
  let clock = 0;
  const timer = createRequestTimer();
  const logs = [];
  const res = fakeRes({ type: 'text/event-stream; charset=utf-8' });
  trackRequest({ method: 'GET', url: '/api/agents/a/events' }, res, { timer, now: () => clock, log: (l) => logs.push(l) });
  clock = 3_600_000;
  res.emit('close'); // the client closes the stream
  assert.equal(timer.summarize().count, 0);
  assert.deepEqual(logs, []);
});

test('trackRequest never throws out of the finish handler', () => {
  const res = fakeRes();
  trackRequest({ method: 'GET', url: '/x' }, res, {
    timer: { record() { throw new Error('boom'); } }, now: () => 0, log: () => {},
  });
  assert.doesNotThrow(() => res.emit('finish'));
});

function t2rows(timer) {
  return timer.summarize().routes.map(r => [r.route, r.count, r.max]);
}

// ── reporter ────────────────────────────────────────────────────────────────

test('createPerfReporter logs one line per tick and resets timer + histogram', () => {
  const timer = createRequestTimer();
  const histogram = fakeHistogram();
  const logs = [];
  let clock = 1_000;
  const r = createPerfReporter({ timer, histogram, intervalMs: 60_000, log: (l) => logs.push(l), now: () => clock });
  timer.record('GET /a', 10);
  clock += 60_000;
  const line = r.tick();
  assert.equal(logs.length, 1);
  assert.equal(line, logs[0]);
  assert.match(line, /^\[perf\] window=60s requests=1 aborted=0 slow=0 slow-suppressed=0 loop p50=10\.0ms p99=50\.0ms max=200\.0ms \| GET \/a n=1/);
  assert.equal(timer.summarize().count, 0);
  assert.equal(histogram.resets, 1);
});

test('createPerfReporter prints the elapsed window, not the nominal interval', () => {
  let clock = 0;
  const r = createPerfReporter({
    timer: createRequestTimer(), histogram: null, intervalMs: 60_000, log: () => {}, now: () => clock,
  });
  clock = 95_000; // a starved interval fired late
  assert.match(r.tick(), /^\[perf\] window=95s /);
  clock = 102_000; // measured from the previous reset
  assert.match(r.tick(), /^\[perf\] window=7s /);
});

test('createPerfReporter subtracts the loop resolution it was given', () => {
  const r = createPerfReporter({
    timer: createRequestTimer(), histogram: fakeHistogram({ p50: 21e6, p99: 30e6, max: 70e6 }),
    log: () => {}, now: () => 0, loopResolutionMs: 20,
  });
  assert.match(r.tick(), / loop p50=1\.0ms p99=10\.0ms max=50\.0ms$/);
});

test('createPerfReporter.start unrefs its interval and is idempotent', () => {
  const calls = [];
  const handle = { unrefd: false, unref() { this.unrefd = true; } };
  const r = createPerfReporter({
    timer: createRequestTimer(), histogram: null, intervalMs: 5, log: () => {},
    setIntervalFn: (fn, ms) => { calls.push(ms); return handle; },
  });
  r.start(); r.start();
  assert.deepEqual(calls, [5]);
  assert.equal(handle.unrefd, true);
});

// ── createPerfTiming (the shared process wiring) ────────────────────────────

function fakePerfHooks(clock) {
  const made = [];
  return {
    made,
    performance: { now: () => clock.t },
    monitorEventLoopDelay(opts) {
      const h = { ...fakeHistogram(), opts, enabled: false, enable() { this.enabled = true; } };
      made.push(h);
      return h;
    },
  };
}

test('createPerfTiming: track feeds the shared timer; start builds + enables the histogram once', () => {
  const clock = { t: 0 };
  const perfHooks = fakePerfHooks(clock);
  const logs = [];
  const intervals = [];
  const p = createPerfTiming({
    env: { AEE_SLOW_REQUEST_MS: '100' }, log: (l) => logs.push(l), perfHooks,
    setIntervalFn: (fn, ms) => { intervals.push(ms); return { unref() {} }; },
  });
  assert.equal(p.enabled, true);
  const res = fakeRes();
  p.track({ method: 'GET', url: '/internal/agents/a/x' }, res);
  clock.t = 150;
  res.emit('finish');
  assert.equal(p.timer.summarize().count, 1);
  assert.deepEqual(logs, ['[perf] slow GET /internal/agents/:id/x 150ms status=200']);

  const r = p.start();
  assert.equal(p.start(), r, 'start is idempotent');
  assert.equal(perfHooks.made.length, 1);
  assert.deepEqual(perfHooks.made[0].opts, { resolution: LOOP_RESOLUTION_MS });
  assert.equal(perfHooks.made[0].enabled, true);
  assert.deepEqual(intervals, [60_000]);
});

test('createPerfTiming: middleware tracks then calls next', () => {
  const p = createPerfTiming({ env: {}, log: () => {}, perfHooks: fakePerfHooks({ t: 0 }) });
  const res = fakeRes();
  let nexted = 0;
  p.middleware({ method: 'GET', url: '/api/x' }, res, () => { nexted++; });
  res.emit('finish');
  assert.equal(nexted, 1);
  assert.equal(p.timer.summarize().count, 1);
});

test('createPerfTiming: AEE_PERF_LOG=0 → track is a no-op and start builds nothing', () => {
  const perfHooks = fakePerfHooks({ t: 0 });
  const p = createPerfTiming({ env: { AEE_PERF_LOG: '0' }, log: () => {}, perfHooks });
  assert.equal(p.enabled, false);
  const res = fakeRes();
  p.track({ method: 'GET', url: '/x' }, res);
  res.emit('finish');
  assert.equal(p.timer.summarize().count, 0);
  assert.equal(p.start(), null);
  assert.equal(perfHooks.made.length, 0);
});
