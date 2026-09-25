'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withUnexpectedErrors } = require('./unexpected-error');

// Minimal fake res capturing status + the RAW text written, so a test can
// assert what went on the wire byte-for-byte (a leaked message must not be
// hidden behind a JSON.parse).
function fakeRes(overrides = {}) {
  return {
    statusCode: null,
    headers: null,
    text: null,
    headersSent: false,
    writeHeadCalls: 0,
    writeHead(status, headers) { this.writeHeadCalls += 1; this.statusCode = status; this.headers = headers; },
    end(text) { this.text = text; },
    ...overrides,
  };
}

// Capture console.error across one call AND the turn after it. The restore has
// to wait for that turn: an async handler's log comes from the trailing
// `.catch`, which fires after `fn()` has already returned, so restoring in a
// `finally` around `fn()` would let that line escape to the real console and
// leave every assertion about `calls` on an async path vacuous.
async function captureErrorsAsync(fn) {
  const calls = [];
  const original = console.error;
  console.error = (...args) => calls.push(args);
  try {
    await fn();
    // Give a trailing `.catch` microtask a turn before restoring judgement.
    await new Promise((r) => setImmediate(r));
  } finally {
    console.error = original;
  }
  return calls;
}

const LEAK = "EACCES: permission denied, mkdir '/plugin-state/github-issues/prefs'";

test('a rejected handler: 500 + a literal, and the message is not on the wire', async () => {
  const res = fakeRes();
  const listener = withUnexpectedErrors('netzplan-broker', async () => { throw new Error(LEAK); });
  await captureErrorsAsync(() => { listener({}, res); return new Promise((r) => setImmediate(r)); });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.headers, { 'Content-Type': 'application/json' });
  assert.equal(res.text, JSON.stringify({ error: 'internal error' }));
  assert.doesNotMatch(res.text, /EACCES/);
  assert.doesNotMatch(res.text, /plugin-state/);
});

test('a synchronously-throwing handler: same containment', async () => {
  const res = fakeRes();
  const listener = withUnexpectedErrors('gke-broker', () => { throw new Error(LEAK); });
  await captureErrorsAsync(() => listener({}, res));

  assert.equal(res.statusCode, 500);
  assert.equal(res.text, JSON.stringify({ error: 'internal error' }));
  assert.doesNotMatch(res.text, /EACCES/);
});

test('headers already sent: no second writeHead, still ends with the literal', async () => {
  const res = fakeRes({ headersSent: true });
  const listener = withUnexpectedErrors('test-mgmt-broker', () => { throw new Error('boom'); });
  await captureErrorsAsync(() => listener({}, res));

  assert.equal(res.writeHeadCalls, 0, 'writing headers twice throws ERR_HTTP_HEADERS_SENT');
  assert.equal(res.statusCode, null);
  assert.equal(res.text, JSON.stringify({ error: 'internal error' }));
});

test('a throwing res.end is swallowed — nothing escapes the listener', async () => {
  const res = fakeRes({ end() { throw new Error('socket already destroyed'); } });
  const listener = withUnexpectedErrors('podman-mcp', () => { throw new Error('boom'); });
  // The assertion is that this does not throw.
  await captureErrorsAsync(() => listener({}, res));
});

test('the operator keeps the detail: one console.error with the tag and the error object', async () => {
  const res = fakeRes();
  const err = new Error(LEAK);
  const listener = withUnexpectedErrors('github-issues-broker', () => { throw err; });
  const calls = await captureErrorsAsync(() => listener({}, res));

  assert.equal(calls.length, 1, 'exactly one log line per unexpected error');
  assert.deepEqual(calls[0], ['[github-issues-broker] unhandled:', err],
    'the tag and the ORIGINAL error object — passing err.message would lose the stack');
});

test('a resolving handler: the helper does nothing', async () => {
  const res = fakeRes();
  const listener = withUnexpectedErrors('netzplan-broker', async (_req, r) => {
    r.writeHead(200, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify({ ok: true }));
  });
  const calls = await captureErrorsAsync(() => { listener({}, res); return new Promise((r) => setImmediate(r)); });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.text), { ok: true });
  assert.equal(calls.length, 0);
});

test('a non-function handler is refused at wiring time', () => {
  // The teardownScopeEndpoint precedent: fail where the mistake is, not on the
  // first request.
  assert.throws(() => withUnexpectedErrors('x', undefined), /requires a handler/);
  assert.throws(() => withUnexpectedErrors('x', {}), /requires a handler/);
});

// ─── Source ratchet: every broker routes through the shared handler ──────────
//
// The behavioural tests above cover the handler; this covers the WIRING, which
// is what diverged six ways. One read per broker replaces the per-broker
// source-slicing guard that used to live under plugins/netzplan/broker/.
//
// Strip comments before asserting an absence — a comment explaining what was
// removed is not a reintroduction of it (the baseline-coverage-help-copy.js
// convention). LINE comments go first: several brokers document a `/ui/*` route
// in a `//` header, and stripping blocks first would read that as an opening
// `/*` and swallow the rest of the file.
const stripComments = (src) => src
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');
const BROKER_SERVERS = fs.readdirSync(PLUGINS_DIR)
  .map((id) => ({ id, file: path.join(PLUGINS_DIR, id, 'broker', 'server.js') }))
  .filter(({ file }) => fs.existsSync(file));

test('the ratchet is not vacuous — it reads every broker server.js', () => {
  assert.ok(BROKER_SERVERS.length >= 6,
    `expected at least the six reference brokers, found ${BROKER_SERVERS.length}`);
});

// The full `http.createServer(...)` argument of one broker, by balanced-paren
// scan — exact for both the one-liner form and a reverted inline callback, so
// the absence assertion can never drift into unrelated code further down.
function createServerArg(src) {
  const open = src.indexOf('http.createServer(');
  assert.notEqual(open, -1, 'no http.createServer — update this ratchet');
  let depth = 0;
  for (let i = open + 'http.createServer'.length; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 'http.createServer('.length, i);
    }
  }
  assert.fail('unbalanced http.createServer( — update this ratchet');
}

// The destructured `require('../../../broker-sdk')` statement of one broker.
// Read raw: an import line is never a comment, and the header comments are what
// make whole-file matching fragile.
function sdkImport(file) {
  const src = fs.readFileSync(file, 'utf8');
  const at = src.indexOf("require('../../../broker-sdk')");
  assert.notEqual(at, -1, `${file}: no broker-sdk require — update this ratchet`);
  const from = src.lastIndexOf('const {', at);
  assert.notEqual(from, -1, `${file}: the broker-sdk require is not a destructure — update this ratchet`);
  return src.slice(from, at);
}

for (const { id, file } of BROKER_SERVERS) {
  test(`${id}: http.createServer goes through withUnexpectedErrors`, () => {
    const arg = createServerArg(stripComments(fs.readFileSync(file, 'utf8')));
    assert.match(arg, /^withUnexpectedErrors\(/,
      `${id}: pass handleRequest through withUnexpectedErrors instead of an inline catch`);
    assert.match(sdkImport(file), /\bwithUnexpectedErrors\b/,
      `${id}: withUnexpectedErrors must come from the SDK, not a local copy`);
  });

  test(`${id}: no exception message on the wire from the createServer callback`, () => {
    const arg = createServerArg(stripComments(fs.readFileSync(file, 'utf8')));
    assert.doesNotMatch(arg, /err\.message/,
      `${id}: the unexpected-error path must not put the exception message on the wire`);
  });
}

test('the ratchet predicates fire on the pre-fix shape', () => {
  // Prove each predicate detects the inline clone this change removed.
  const reverted = [
    'const httpServer = http.createServer((req, res) => {',
    '  handleRequest(req, res).catch((err) => {',
    "    try { res.end(JSON.stringify({ error: (err && err.message) || String(err) })); } catch {}",
    '  });',
    '});',
  ].join('\n');
  const arg = createServerArg(reverted);
  assert.doesNotMatch(arg, /^withUnexpectedErrors\(/);
  assert.match(stripComments(arg), /err\.message/);
  // and the stripper itself must not swallow real code
  assert.match(stripComments('// err.message\nres.end(err.message);'), /res\.end\(err\.message\)/);
  assert.doesNotMatch(stripComments("// err.message\nres.end('x');"), /err\.message/);
});
