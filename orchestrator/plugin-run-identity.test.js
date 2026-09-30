'use strict';

// #2562 — who a plugin CLI call acts for. These are the tamper tests (AC9) for
// the pure core: caller token, run key, run declarations, the homeserver event
// check and the credential decision.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mintCallerToken,
  verifyCallerToken,
  RunRegistry,
  chatSenderFromEvent,
  decideCredentialGrant,
  DEFAULT_RUN_TTL_MS,
  CHAT_EVENT_MAX_AGE_MS,
} = require('./plugin-run-identity');

const SECRET = 'registry-secret';
const PERSONAL_KEYS = [
  { key: 'email', required: true, secret: false },
  { key: 'api-token', required: true },
];

// ── caller token ────────────────────────────────────────────────────────────

test('caller token: round-trips the agent id; forged, re-signed and garbage tokens are rejected', () => {
  const t = mintCallerToken('team-a-developer', SECRET);
  assert.equal(verifyCallerToken(t, SECRET), 'team-a-developer');
  assert.equal(verifyCallerToken(t, 'other-secret'), null);

  // swap the agent id but keep the signature → another agent cannot be claimed
  const [prefix, , sig] = t.split('.');
  const forged = `${prefix}.${Buffer.from('team-b-developer').toString('base64url')}.${sig}`;
  assert.equal(verifyCallerToken(forged, SECRET), null);

  for (const bad of [undefined, null, '', 'x', 'aeecall1..', 'aeecall1.a.b.c', `nope.${t.split('.').slice(1).join('.')}`]) {
    assert.equal(verifyCallerToken(bad, SECRET), null, String(bad));
  }
  assert.equal(mintCallerToken('a', ''), null);
});

// ── run registry ────────────────────────────────────────────────────────────

function registry(opts = {}) {
  let n = 0;
  return new RunRegistry({
    randomBytes: (len) => Buffer.from(String(++n).padStart(len, '0').slice(0, len)),
    ...opts,
  });
}

test('run key: first request wins; a second request in the same generation revokes (fail closed)', () => {
  const r = registry();
  const first = r.issueKey('a');
  assert.equal(first.ok, true);
  assert.equal(r.begin('a', first.key, { kind: 'autonomous' }).ok, true);
  assert.equal(r.active('a').ok, true);

  // a tool call inside the container tries to mint its own key
  assert.deepEqual(r.issueKey('a'), { ok: false, reason: 'key-already-issued' });
  assert.deepEqual(r.active('a'), { ok: false, reason: 'run-key-revoked' });
  assert.equal(r.begin('a', first.key, { kind: 'autonomous' }).reason, 'run-key-revoked');
  // …and asking yet again never yields a usable key
  assert.equal(r.issueKey('a').ok, false);

  // only a respawn (resetAgent) starts a fresh generation
  r.resetAgent('a');
  assert.equal(r.issueKey('a').ok, true);
});

test('run declarations need the real key; bad kinds and incomplete chat runs are refused', () => {
  const r = registry();
  const { key } = r.issueKey('a');
  assert.equal(r.begin('a', 'guess', { kind: 'autonomous' }).reason, 'bad-run-key');
  assert.equal(r.begin('a', '', { kind: 'autonomous' }).reason, 'bad-run-key');
  assert.equal(r.begin('b', key, { kind: 'autonomous' }).reason, 'no-run-key'); // key is per agent
  assert.equal(r.begin('a', key, { kind: 'service' }).reason, 'bad-kind');
  assert.equal(r.begin('a', key, { kind: 'chat', roomId: '!r', eventId: '$e' }).reason, 'bad-chat-run');
  assert.equal(r.active('a').reason, 'no-active-run');
});

test('exactly one active run: none → refuse, two → ambiguous, end → back to one', () => {
  const r = registry();
  const { key } = r.issueKey('a');
  assert.equal(r.active('a').reason, 'no-active-run');
  const one = r.begin('a', key, { kind: 'chat', roomId: '!r', eventId: '$1', sender: '@alice:hs' });
  const two = r.begin('a', key, { kind: 'autonomous' });
  assert.equal(r.active('a').reason, 'ambiguous-run');
  assert.equal(r.end('a', 'wrong', two.runId).ok, false);
  assert.equal(r.end('a', key, two.runId).ok, true);
  const act = r.active('a');
  assert.equal(act.ok, true);
  assert.equal(act.run.sender, '@alice:hs');
  assert.equal(r.end('a', key, one.runId).ok, true);
  assert.equal(r.active('a').reason, 'no-active-run');
});

test('a declaration older than the TTL is pruned (a crashed runner never sends its end)', () => {
  let now = 1000;
  const r = registry({ now: () => now });
  const { key } = r.issueKey('a');
  r.begin('a', key, { kind: 'autonomous' });
  now += DEFAULT_RUN_TTL_MS + 1;
  assert.equal(r.active('a').reason, 'no-active-run');
});

test('consecutive chat turns from different members each resolve their own sender (AC8)', () => {
  const r = registry();
  const { key } = r.issueKey('a');
  const t1 = r.begin('a', key, { kind: 'chat', roomId: '!r', eventId: '$1', sender: '@alice:hs' });
  assert.equal(r.active('a').run.sender, '@alice:hs');
  r.end('a', key, t1.runId);
  const t2 = r.begin('a', key, { kind: 'chat', roomId: '!r', eventId: '$2', sender: '@bob:hs' });
  assert.equal(r.active('a').run.sender, '@bob:hs');
  r.end('a', key, t2.runId);
});

// ── homeserver event check ──────────────────────────────────────────────────

test('chatSenderFromEvent: takes the sender from the server copy; refuses agent-sent, stale, wrong-room and non-message events', () => {
  const now = 10_000_000;
  const ev = { type: 'm.room.message', room_id: '!r', sender: '@alice:hs', origin_server_ts: now - 1000 };
  const opts = { roomId: '!r', agentMatrixId: '@agent:hs', now };
  assert.deepEqual(chatSenderFromEvent(ev, opts), { ok: true, sender: '@alice:hs' });
  assert.equal(chatSenderFromEvent(null, opts).reason, 'event-not-found');
  assert.equal(chatSenderFromEvent({ ...ev, type: 'm.reaction' }, opts).reason, 'not-a-message');
  assert.equal(chatSenderFromEvent({ ...ev, room_id: '!other' }, opts).reason, 'room-mismatch');
  // the agent naming one of its OWN messages cannot borrow a person's identity
  assert.equal(chatSenderFromEvent({ ...ev, sender: '@agent:hs' }, opts).reason, 'sender-is-agent');
  assert.equal(chatSenderFromEvent({ ...ev, sender: '' }, opts).reason, 'no-sender');
  assert.equal(chatSenderFromEvent({ ...ev, origin_server_ts: now - CHAT_EVENT_MAX_AGE_MS - 1 }, opts).reason, 'event-too-old');
});

// ── the credential decision ─────────────────────────────────────────────────

const chat = { ok: true, run: { kind: 'chat', sender: '@alice:hs' } };
const auto = { ok: true, run: { kind: 'autonomous' } };

test('decision: autonomous run → service account, non-interactive (AC7)', () => {
  assert.deepEqual(decideCredentialGrant({ active: auto, senderUserId: null, personalValues: null, personalKeys: PERSONAL_KEYS }),
    { ok: true, mode: 'service', interactive: false });
});

test('decision: chat run with a trusted sender and a personal credential → personal, interactive (AC2/AC3)', () => {
  const d = decideCredentialGrant({ active: chat, senderUserId: 'alice', personalValues: { email: 'a@b.c', 'api-token': 't' }, personalKeys: PERSONAL_KEYS });
  assert.equal(d.ok, true);
  assert.equal(d.mode, 'personal');
  assert.equal(d.interactive, true);
  assert.equal(d.userId, 'alice');
  assert.deepEqual(d.values, { email: 'a@b.c', 'api-token': 't' });
});

test('decision: a chat run NEVER yields the service account (AC4/AC5/AC6)', () => {
  // no personal credential
  let d = decideCredentialGrant({ active: chat, senderUserId: 'alice', personalValues: null, personalKeys: PERSONAL_KEYS, pluginName: 'Jira' });
  assert.equal(d.ok, false);
  assert.equal(d.status, 424);
  assert.equal(d.code, 'personal-credential-required');
  assert.match(d.message, /Plugin Tokens \(\/plugin-tokens\)/);
  assert.match(d.message, /Nothing was sent to Jira/);
  // incomplete personal credential
  d = decideCredentialGrant({ active: chat, senderUserId: 'alice', personalValues: { email: 'a@b.c' }, personalKeys: PERSONAL_KEYS });
  assert.equal(d.code, 'personal-credential-required');
  // untrusted / unresolvable sender
  d = decideCredentialGrant({ active: chat, senderUserId: null, personalValues: { email: 'a', 'api-token': 'b' }, personalKeys: PERSONAL_KEYS });
  assert.equal(d.code, 'untrusted-sender');
  assert.equal(d.status, 403);
  for (const x of [d]) assert.notEqual(x.mode, 'service');
});

test('decision: no run / ambiguous / revoked → refused with that reason', () => {
  for (const reason of ['no-active-run', 'ambiguous-run', 'run-key-revoked']) {
    const d = decideCredentialGrant({ active: { ok: false, reason }, senderUserId: 'alice', personalValues: {}, personalKeys: PERSONAL_KEYS });
    assert.equal(d.ok, false);
    assert.equal(d.code, reason);
    assert.equal(d.status, 403);
  }
  assert.equal(decideCredentialGrant({ active: null }).code, 'no-active-run');
});

test('the forgeable AEE_ACTING_SENDER env var plays no part in the decision (D6)', () => {
  const before = process.env.AEE_ACTING_SENDER;
  process.env.AEE_ACTING_SENDER = 'mallory';
  try {
    const d = decideCredentialGrant({ active: chat, senderUserId: 'alice', personalValues: { email: 'a', 'api-token': 'b' }, personalKeys: PERSONAL_KEYS });
    assert.equal(d.userId, 'alice');
  } finally {
    if (before === undefined) delete process.env.AEE_ACTING_SENDER; else process.env.AEE_ACTING_SENDER = before;
  }
  const src = require('node:fs').readFileSync(require.resolve('./plugin-run-identity'), 'utf8');
  assert.equal(/process\.env/.test(src), false);
});
