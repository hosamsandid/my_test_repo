'use strict';

// Unit tests for the client-error telemetry sink (#1974).
// Run: node --test admin-console/api/client-error-log.test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the log at a throwaway dir before requiring the module (it captures
// the dir at load time) — the audit.test.js idiom.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'client-error-test-'));
process.env.CLIENT_ERROR_DIR = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const clientErrorLog = require('./client-error-log');

const { buildClientErrorEvent, record, logLine } = clientErrorLog;

function dayFiles() {
  return fs.readdirSync(TMP).filter(f => f.endsWith('.jsonl')).sort();
}

/* ─── buildClientErrorEvent: validation ────────────────────────────── */

test('buildClientErrorEvent requires a message', () => {
  assert.deepEqual(buildClientErrorEvent({}), { ok: false, error: 'message is required' });
  assert.deepEqual(buildClientErrorEvent({ message: '   ' }), { ok: false, error: 'message is required' });
  assert.deepEqual(buildClientErrorEvent(null), { ok: false, error: 'message is required' });
  assert.deepEqual(buildClientErrorEvent('not an object'), { ok: false, error: 'message is required' });
  // A non-string message is not coerced — a client sending one is broken.
  assert.equal(buildClientErrorEvent({ message: 42 }).ok, false);
});

test('buildClientErrorEvent keeps the triage fields', () => {
  const { ok, event } = buildClientErrorEvent({
    message: 'boom', name: 'TypeError', componentStack: 'at ToolBlock',
    fingerprint: 'TypeError|boom|at ToolBlock', route: '/chats/dev-1',
    agentId: 'dev-1', sessionId: '!room:local', eventId: '$e1', scope: 'event',
  }, { now: () => Date.parse('2026-09-03T12:00:00Z') });

  assert.equal(ok, true);
  assert.equal(event.ts, '2026-09-03T12:00:00.000Z');
  assert.equal(event.scope, 'event');
  assert.equal(event.message, 'boom');
  assert.equal(event.name, 'TypeError');
  assert.equal(event.componentStack, 'at ToolBlock');
  assert.equal(event.route, '/chats/dev-1');
  assert.equal(event.agentId, 'dev-1');
  assert.equal(event.sessionId, '!room:local');
  assert.equal(event.eventId, '$e1');
});

test('the timestamp is the SERVER clock, so a skewed browser cannot pick the day file', () => {
  const { event } = buildClientErrorEvent(
    { message: 'x', ts: '1999-01-01T00:00:00.000Z' },
    { now: () => Date.parse('2026-09-03T12:00:00Z') },
  );
  assert.equal(event.ts, '2026-09-03T12:00:00.000Z');
  // The client's own claim is kept alongside, so clock skew stays diagnosable.
  assert.equal(event.clientTs, '1999-01-01T00:00:00.000Z');
});

test('the actor comes from the server session, never from the request body', () => {
  const { event } = buildClientErrorEvent(
    { message: 'x', actor: 'i-am-admin' },
    { actor: 'real.person' },
  );
  assert.equal(event.actor, 'real.person');
});

test('an unknown scope falls back to app', () => {
  assert.equal(buildClientErrorEvent({ message: 'x', scope: 'root' }).event.scope, 'app');
  assert.equal(buildClientErrorEvent({ message: 'x' }).event.scope, 'app');
});

test('every field is length-capped server-side — the client is not the authority', () => {
  const { event } = buildClientErrorEvent({
    message: 'm'.repeat(9000),
    name: 'n'.repeat(9000),
    componentStack: 's'.repeat(9000),
    fingerprint: 'f'.repeat(9000),
    route: '/r'.repeat(9000),
    agentId: 'a'.repeat(9000),
  });
  assert.equal(event.message.length, clientErrorLog.LIMITS.message);
  assert.equal(event.name.length, clientErrorLog.LIMITS.name);
  assert.equal(event.componentStack.length, clientErrorLog.LIMITS.componentStack);
  assert.equal(event.fingerprint.length, clientErrorLog.LIMITS.fingerprint);
  assert.equal(event.route.length, clientErrorLog.LIMITS.route);
  assert.equal(event.agentId.length, clientErrorLog.LIMITS.id);
});

test('the event is a whitelist — an extra posted key never reaches the log', () => {
  const { event } = buildClientErrorEvent({
    message: 'boom',
    chatBody: 'what the user typed',
    cookie: 'aee_session=abc',
    nested: { anything: true },
  });
  assert.ok(!('chatBody' in event));
  assert.ok(!('cookie' in event));
  assert.ok(!('nested' in event));
  assert.deepEqual(Object.keys(event).sort(), ['message', 'scope', 'ts']);
});

test('empty optional fields are dropped rather than stored blank', () => {
  const { event } = buildClientErrorEvent({ message: 'boom', route: '', agentId: '' });
  assert.deepEqual(Object.keys(event).sort(), ['message', 'scope', 'ts']);
});

/* ─── record: the fs sink ──────────────────────────────────────────── */

test('record appends one JSONL line to the day file', () => {
  const { event } = buildClientErrorEvent(
    { message: 'first', route: '/agents' },
    { now: () => Date.parse('2026-09-03T08:00:00Z') },
  );
  record(event);
  const files = dayFiles();
  assert.ok(files.includes('client-errors-2026-09-03.jsonl'));
  const lines = fs.readFileSync(path.join(TMP, 'client-errors-2026-09-03.jsonl'), 'utf8')
    .trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).message, 'first');
});

test('record buckets by day and appends within a day', () => {
  const mk = (msg, iso) => buildClientErrorEvent({ message: msg }, { now: () => Date.parse(iso) }).event;
  record(mk('same-day', '2026-09-03T09:00:00Z'));
  record(mk('next-day', '2026-09-04T09:00:00Z'));

  const today = fs.readFileSync(path.join(TMP, 'client-errors-2026-09-03.jsonl'), 'utf8').trim().split('\n');
  assert.equal(today.length, 2); // the previous test's line plus same-day
  assert.ok(dayFiles().includes('client-errors-2026-09-04.jsonl'));
});

test('record never throws when the log directory cannot be created', () => {
  // The failure is forced with ENOTDIR (a FILE where a parent directory is
  // expected) rather than by chmod-ing a dir read-only: the test suite often
  // runs as root, which ignores permission bits, and that would make this
  // assertion silently vacuous.
  const blocker = path.join(os.tmpdir(), `client-error-file-${process.pid}`);
  fs.writeFileSync(blocker, 'not a directory');
  const original = process.env.CLIENT_ERROR_DIR;
  const target = path.join(blocker, 'sub');
  try {
    // Prove the path really is unusable, so the test cannot rot into a no-op.
    assert.throws(() => fs.mkdirSync(target, { recursive: true }), { code: 'ENOTDIR' });

    delete require.cache[require.resolve('./client-error-log')];
    process.env.CLIENT_ERROR_DIR = target;
    const fresh = require('./client-error-log');
    assert.doesNotThrow(() => fresh.record({ ts: '2026-09-03T00:00:00.000Z', message: 'x' }));
  } finally {
    fs.rmSync(blocker, { force: true });
    delete require.cache[require.resolve('./client-error-log')];
    process.env.CLIENT_ERROR_DIR = original;
    require('./client-error-log');
  }
});

test('record tolerates a malformed ts without crashing', () => {
  assert.doesNotThrow(() => record({ ts: undefined, message: 'x' }));
});

/* ─── logLine: the container-log surface ───────────────────────────── */

test('logLine names the scope, route, agent and message', () => {
  const line = logLine({ scope: 'event', route: '/chats/dev-1', agentId: 'dev-1', message: 'bad shape' });
  assert.ok(line.startsWith('[client-error] event'));
  assert.ok(line.includes('route=/chats/dev-1'));
  assert.ok(line.includes('agent=dev-1'));
  assert.ok(line.includes('bad shape'));
});

test('logLine omits the parts an event does not carry', () => {
  assert.equal(logLine({ scope: 'app', message: 'boom' }), '[client-error] app: boom');
});
