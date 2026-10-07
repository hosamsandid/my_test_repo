'use strict';

// Request-duration + event-loop-delay measurement (#555).
//
// Preprod was reported slower than test with no number to say where. This
// module is the measurement: per-route rolling duration samples summarised as
// p50/p90/max/count, plus a formatter for the process's event-loop delay, folded
// into one `[perf]` log line per window. Pure and dependency-free — the caller
// supplies the clock, the histogram (perf_hooks.monitorEventLoopDelay) and the
// logger, so every decision here is unit-tested. `createPerfTiming` is the thin
// process wiring on top, shared by both servers.
//
// Byte-identical in admin-console/api/request-timing.js and
// orchestrator/request-timing.js (parity-tested) — change both together.

const DEFAULT_MAX_ROUTES = 200;
const DEFAULT_SAMPLES_PER_ROUTE = 256;
const DEFAULT_SLOW_MS = 500;
const DEFAULT_TOP_N = 8;
const DEFAULT_SLOW_LINES_PER_ROUTE = 5;
const OVERFLOW_ROUTE = '(other)';
const MAX_SEGMENTS = 8;

// Collections whose next path segment is a resource id (agent ids are slugs
// like `cobol-agent`, so no id-shape test can catch them). Covers the `:param`
// families of the console's /api routes and the orchestrator's /internal ladder.
const ID_COLLECTIONS = new Set([
  'agents', 'teams', 'skills', 'llm-endpoints', 'plugins', 'drafts', 'item',
  'environments', 'blueprints', 'users', 'rooms', 'ssh-keys', 'mcp-servers',
  'flows', 'promotion-suggestions', 'github-tokens', 'agent-templates',
  'plugin-credentials', 'work-items', 'toolchains', 'scripts',
  'process-templates', 'mcp-credentials', 'owners', 'triggers', 'pending',
  'sessions', 'pool-control', 'cards',
  // …/session/:roomId, …/memory/:file, plugins/:id/credentials/:scopeId,
  // …/prompt-history/:version, drafts/:id/access/:userId.
  'session', 'memory', 'credentials', 'prompt-history', 'access',
]);

// Static children of an id collection — kept literal, not collapsed to `:id`.
const STATIC_CHILDREN = new Set([
  'processes', 'orphans', 'import', 'ephemeral', 'team-of-one-migration',
  'statuses', 'reconcile', 'resync', 'activate', 'deactivate', 'history',
  'active', 'source', 'merge',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{8,}$/i;
const NUMERIC_RE = /^\d+$/;
// Matrix sigils: room `!`, user `@`, event `$`, alias `#`.
const MATRIX_RE = /^[!@$#]/;

function decodeSegment(seg) {
  try { return decodeURIComponent(seg); } catch { return seg; }
}

function isIdLike(seg) {
  return NUMERIC_RE.test(seg) || UUID_RE.test(seg) || HEX_RE.test(seg) || MATRIX_RE.test(seg);
}

// Collapse a raw URL path into a route template: query dropped, id-shaped
// segments and the segment after an id collection become `:id`.
function collapsePath(url) {
  const pathOnly = String(url || '/').split(/[?#]/)[0] || '/';
  const parts = pathOnly.split('/');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (out.length > MAX_SEGMENTS) { out.push('…'); break; }
    const raw = parts[i];
    if (raw === '') { out.push(raw); continue; }
    const seg = decodeSegment(raw);
    const prev = i > 0 ? decodeSegment(parts[i - 1]) : '';
    if (isIdLike(seg)) out.push(':id');
    else if (ID_COLLECTIONS.has(prev) && !STATIC_CHILDREN.has(seg)) out.push(':id');
    else out.push(seg);
  }
  return out.join('/') || '/';
}

// The route key for one request: METHOD + template. Prefers the matched express
// route (`req.route.path`, joined with `req.baseUrl`); falls back to collapsing
// the raw URL (raw http servers, 404s, middleware-answered requests).
function routeKey(req) {
  const method = (req && req.method) || 'GET';
  const routePath = req && req.route && req.route.path;
  if (typeof routePath === 'string') {
    return `${method} ${(req.baseUrl || '')}${routePath}`;
  }
  return `${method} ${collapsePath((req && (req.originalUrl || req.url)) || '/')}`;
}

// Nearest-rank percentile over an ascending-sorted array.
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

// Bounded per-route sample store. Each route keeps a ring of its most recent
// `samplesPerRoute` durations (percentiles are over the ring; count/total/max
// are exact for the window); past `maxRoutes` distinct keys, new routes pool
// into one overflow bucket so a URL-cardinality bug cannot grow memory. It also
// caps the immediate slow lines at `slowLinesPerRoute` per route per window: a
// stalled loop makes every request slow at once, and a synchronous log write
// per request (stdout to a pipe is synchronous on Linux) would add to the stall.
// The rest are counted and surface in the window's summary line instead.
function createRequestTimer({
  maxRoutes = DEFAULT_MAX_ROUTES,
  samplesPerRoute = DEFAULT_SAMPLES_PER_ROUTE,
  slowLinesPerRoute = DEFAULT_SLOW_LINES_PER_ROUTE,
} = {}) {
  let routes = new Map();

  function bucketFor(route) {
    let b = routes.get(route);
    if (b) return b;
    if (routes.size >= maxRoutes) {
      route = OVERFLOW_ROUTE;
      b = routes.get(route);
      if (b) return b;
    }
    b = { samples: [], next: 0, count: 0, totalMs: 0, maxMs: 0, aborted: 0, slow: 0, slowSuppressed: 0 };
    routes.set(route, b);
    return b;
  }

  // `aborted`: the client went away before the response finished. Still a
  // sample — it is how long the server had the request when the client gave up.
  function record(route, ms, { aborted = false } = {}) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const b = bucketFor(route);
    if (aborted) b.aborted += 1;
    if (b.samples.length < samplesPerRoute) b.samples.push(ms);
    else { b.samples[b.next] = ms; b.next = (b.next + 1) % samplesPerRoute; }
    b.count += 1;
    b.totalMs += ms;
    if (ms > b.maxMs) b.maxMs = ms;
  }

  // Count one slow request; true while the route is under its line budget for
  // this window, false (and counted as suppressed) once it is spent.
  function admitSlowLine(route) {
    const b = bucketFor(route);
    b.slow += 1;
    if (b.slow <= slowLinesPerRoute) return true;
    b.slowSuppressed += 1;
    return false;
  }

  // Routes ranked by total time spent (count × duration) — the routes that
  // load the event loop most, which a p90 ranking alone would miss.
  function summarize({ topN = DEFAULT_TOP_N } = {}) {
    const rows = [];
    let count = 0;
    let aborted = 0;
    let slow = 0;
    let slowSuppressed = 0;
    for (const [route, b] of routes) {
      const sorted = b.samples.slice().sort((x, y) => x - y);
      rows.push({
        route,
        count: b.count,
        totalMs: b.totalMs,
        p50: percentile(sorted, 50),
        p90: percentile(sorted, 90),
        max: b.maxMs,
        aborted: b.aborted,
        slow: b.slow,
      });
      count += b.count;
      aborted += b.aborted;
      slow += b.slow;
      slowSuppressed += b.slowSuppressed;
    }
    rows.sort((a, z) => z.totalMs - a.totalMs || z.count - a.count || (a.route < z.route ? -1 : 1));
    return { count, aborted, slow, slowSuppressed, routes: topN > 0 ? rows.slice(0, topN) : rows };
  }

  function reset() { routes = new Map(); }

  return { record, admitSlowLine, summarize, reset, size: () => routes.size };
}

// Event-loop delay from a perf_hooks histogram (values in ns) → ms, or null for
// an empty / unavailable histogram. monitorEventLoopDelay samples the full gap
// between two ticks of a `resolutionMs` timer, so an idle loop reads ≈ the
// resolution itself; subtracting it (floored at 0, as fastify's under-pressure
// does) leaves the delay proper.
function eventLoopDelayMs(histogram, { resolutionMs = 0 } = {}) {
  if (!histogram || typeof histogram.percentile !== 'function') return null;
  const rawMax = histogram.max;
  if (!Number.isFinite(rawMax) || rawMax <= 0) return null;
  const ms = (ns) => (Number.isFinite(ns) && ns >= 0 ? Math.max(0, ns / 1e6 - resolutionMs) : null);
  return { p50: ms(histogram.percentile(50)), p99: ms(histogram.percentile(99)), max: ms(rawMax) };
}

function fmtMs(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

function fmtLoopMs(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? '-' : `${n.toFixed(1)}ms`;
}

// One `[perf]` line for a window:
//   [perf] window=60s requests=812 aborted=3 slow=14 slow-suppressed=4 loop p50=0.6ms p99=28.2ms max=192.0ms | GET /api/matrix/agents n=240 p50=120ms p90=340ms max=1.2s total=41.0s slow=9; …
// `slow` counts requests over the threshold, `slow-suppressed` those whose own
// `[perf] slow` line was capped away. A route row carries `slow=N` / `aborted=N`
// only when non-zero.
function formatSummaryLine({ windowMs, summary, loop }) {
  const head = [
    '[perf]',
    `window=${Math.round((windowMs || 0) / 1000)}s`,
    `requests=${summary ? summary.count : 0}`,
    `aborted=${(summary && summary.aborted) || 0}`,
    `slow=${(summary && summary.slow) || 0}`,
    `slow-suppressed=${(summary && summary.slowSuppressed) || 0}`,
    loop
      ? `loop p50=${fmtLoopMs(loop.p50)} p99=${fmtLoopMs(loop.p99)} max=${fmtLoopMs(loop.max)}`
      : 'loop -',
  ].join(' ');
  const rows = (summary && summary.routes) || [];
  if (!rows.length) return head;
  const body = rows.map(r =>
    `${r.route} n=${r.count} p50=${fmtMs(r.p50)} p90=${fmtMs(r.p90)} max=${fmtMs(r.max)} total=${fmtMs(r.totalMs)}`
    + (r.slow ? ` slow=${r.slow}` : '')
    + (r.aborted ? ` aborted=${r.aborted}` : ''),
  ).join('; ');
  return `${head} | ${body}`;
}

function formatSlowLine({ route, ms, status, aborted = false }) {
  return `[perf] slow ${route} ${fmtMs(ms)} status=${status ?? '-'}${aborted ? ' aborted' : ''}`;
}

// `AEE_PERF_LOG=0` disables; `AEE_SLOW_REQUEST_MS` sets the immediate-log
// threshold (default 500, a non-positive / unparsable value keeps the default).
function perfConfigFromEnv(env = {}) {
  const enabled = String(env.AEE_PERF_LOG ?? '').trim() !== '0';
  const n = Number.parseInt(env.AEE_SLOW_REQUEST_MS, 10);
  const slowMs = Number.isFinite(n) && n > 0 ? n : DEFAULT_SLOW_MS;
  return { enabled, slowMs };
}

// Attach timing to one request/response pair (express or raw http). Recorded
// exactly once: at `finish`, or — for a client that disconnected first, which
// never fires `finish` — at `close`, flagged aborted. The route key is read
// then, after routing has set `req.route`. Server-sent-event streams are
// skipped: their duration is the connection's lifetime.
function trackRequest(req, res, { timer, now, slowMs = DEFAULT_SLOW_MS, log, routeOf = routeKey }) {
  const startedAt = now();
  let done = false;
  const settle = (aborted) => {
    if (done) return;
    done = true;
    try {
      const type = typeof res.getHeader === 'function' ? String(res.getHeader('content-type') || '') : '';
      if (type.startsWith('text/event-stream')) return;
      const ms = now() - startedAt;
      const route = routeOf(req);
      timer.record(route, ms, { aborted });
      const status = aborted && res.headersSent === false ? null : res.statusCode;
      if (ms >= slowMs && timer.admitSlowLine(route) && log) log(formatSlowLine({ route, ms, status, aborted }));
    } catch { /* timing must never break a response */ }
  };
  res.once('finish', () => settle(false));
  res.once('close', () => settle(!res.writableFinished));
}

// The periodic reporter: every `intervalMs` logs one summary line and resets
// the window (timer + histogram). `window=` is the time actually elapsed since
// the last reset (a delayed timer or a manual tick is reported truthfully), not
// the nominal interval. The interval is unref'd so it never keeps a process —
// or a test run — alive.
function createPerfReporter({
  timer, histogram, intervalMs = 60_000, log, setIntervalFn = setInterval, topN,
  now = () => Date.now(), loopResolutionMs = 0,
}) {
  let handle = null;
  let windowStart = now();
  function reset() {
    timer.reset();
    if (histogram && typeof histogram.reset === 'function') histogram.reset();
    windowStart = now();
  }
  function tick() {
    const line = formatSummaryLine({
      windowMs: now() - windowStart,
      summary: timer.summarize({ topN }),
      loop: eventLoopDelayMs(histogram, { resolutionMs: loopResolutionMs }),
    });
    reset();
    log(line);
    return line;
  }
  function start() {
    if (handle) return;
    reset();
    handle = setIntervalFn(() => { try { tick(); } catch { /* never throw from a timer */ } }, intervalMs);
    if (handle && typeof handle.unref === 'function') handle.unref();
  }
  function stop() {
    if (handle) clearInterval(handle);
    handle = null;
  }
  return { tick, start, stop };
}

const LOOP_RESOLUTION_MS = 20;

// The process wiring both servers share (so it is covered and parity-checked
// here instead of duplicated in api.js / orchestrator.js): reads the env config
// once, owns the window's timer, and hands back
//   - `track(req, res)` / `middleware` for the request path — one hoisted
//     options object, no per-request allocation beyond the listeners;
//   - `start()` for the reporter, which creates + enables the event-loop
//     histogram. perf_hooks is injectable so this stays unit-testable.
// Summary and slow lines both go to the one `log`, so they share a stream and
// one grep reads them all. Disabled (`AEE_PERF_LOG=0`) → `track` is a no-op and
// `start` does nothing.
function createPerfTiming({
  env = {},
  log,
  intervalMs = 60_000,
  loopResolutionMs = LOOP_RESOLUTION_MS,
  perfHooks = require('node:perf_hooks'),
  setIntervalFn = setInterval,
} = {}) {
  const config = perfConfigFromEnv(env);
  const timer = createRequestTimer();
  const now = () => perfHooks.performance.now();
  const trackOpts = { timer, now, slowMs: config.slowMs, log };
  let reporter = null;

  function track(req, res) {
    if (config.enabled) trackRequest(req, res, trackOpts);
  }
  function middleware(req, res, next) {
    track(req, res);
    next();
  }
  function start() {
    if (!config.enabled || reporter) return reporter;
    const histogram = perfHooks.monitorEventLoopDelay({ resolution: loopResolutionMs });
    histogram.enable();
    reporter = createPerfReporter({ timer, histogram, intervalMs, log, setIntervalFn, now, loopResolutionMs });
    reporter.start();
    return reporter;
  }
  return { enabled: config.enabled, config, timer, track, middleware, start };
}

module.exports = {
  collapsePath,
  routeKey,
  percentile,
  createRequestTimer,
  eventLoopDelayMs,
  formatSummaryLine,
  formatSlowLine,
  perfConfigFromEnv,
  trackRequest,
  createPerfReporter,
  createPerfTiming,
  DEFAULT_SLOW_MS,
  LOOP_RESOLUTION_MS,
  OVERFLOW_ROUTE,
};
