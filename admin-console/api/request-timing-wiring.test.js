'use strict';

// Source-reading guard for the #555 request-timing wiring in api.js: the timing
// middleware observes every /api request (mounted first — before CORS, the body
// parser, the global limiter and the auth gate), honours AEE_PERF_LOG, and the
// once-a-minute reporter is started in app.listen (createPerfTiming owns the
// event-loop-delay histogram).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

test('the timing middleware is mounted on /api before every other middleware', () => {
  const trackAt = SRC.indexOf("app.use('/api', perfTiming.middleware);");
  assert.notEqual(trackAt, -1, 'the timing middleware is not wired');
  const later = {
    cors: 'app.use(cors());',
    'body parser': "app.use(express.json({ limit: '10mb' }));",
    'global limiter': "app.use('/api/', globalApiLimiter);",
    'audit trail': "app.use('/api', audit.auditMutations);",
    'auth gate': "app.use('/api', auth.gate);",
  };
  for (const [name, anchor] of Object.entries(later)) {
    const at = SRC.indexOf(anchor);
    assert.notEqual(at, -1, `${name} mount moved — re-anchor this guard`);
    assert.ok(trackAt < at, `timing must run before the ${name} so its time / its answers are measured too`);
  }
  assert.equal(SRC.slice(0, trackAt).match(/\bapp\.use\(/g), null, 'no middleware may precede the timing middleware');
});

test('the wiring reads process.env through createPerfTiming (AEE_PERF_LOG=0 disables)', () => {
  assert.match(SRC, /const perfTiming = requestTiming\.createPerfTiming\(\{\s*env: process\.env, log: \(line\) => console\.log\(line\),\s*\}\)/,
    'summary and slow lines share one stream (stdout), so one grep reads both');
  assert.match(SRC, /if \(perfTiming\.enabled\) app\.use\('\/api', perfTiming\.middleware\);/);
});

test('the reporter (and its event-loop-delay histogram) is started in app.listen', () => {
  const listenAt = SRC.indexOf("app.listen(4000, '0.0.0.0', () => {");
  assert.notEqual(listenAt, -1);
  assert.match(SRC.slice(listenAt), /try \{ perfTiming\.start\(\); \}/);
});
