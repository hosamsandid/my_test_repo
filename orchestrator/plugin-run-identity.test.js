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
  buildSetupMessage,
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

test('a declaration whose end never arrived is dropped by the next declaration (#2952)', () => {
  const r = registry();
  const { key } = r.issueKey('a');
  r.begin('a', key, { kind: 'chat', roomId: '!r', eventId: '$1', sender: '@alice:hs' }, { live: [] });
  // the end of $1 is lost; the runner no longer lists it as in flight
  r.begin('a', key, { kind: 'chat', roomId: '!r', eventId: '$2', sender: '@alice:hs' }, { live: [] });
  const act = r.active('a');
  assert.equal(act.ok, true);
  assert.equal(act.run.eventId, '$2');
});

test('a run the runner still lists as in flight is kept, so two live runs stay ambiguous (#2952)', () => {
  const r = registry();
  const { key } = r.issueKey('a');
  const one = r.begin('a', key, { kind: 'chat', roomId: '!r', eventId: '$1', sender: '@alice:hs' }, { live: [] });
  r.begin('a', key, { kind: 'chat', roomId: '!r', eventId: '$2', sender: '@bob:hs' }, { live: [one.runId] });
  assert.equal(r.active('a').reason, 'ambiguous-run');
});

test('a refused declaration drops nothing; without a `live` list nothing is dropped (#2952)', () => {
  const r = registry();
  const { key } = r.issueKey('a');
  r.begin('a', key, { kind: 'chat', roomId: '!r', eventId: '$1', sender: '@alice:hs' });
  assert.equal(r.begin('a', 'guess', { kind: 'autonomous' }, { live: [] }).reason, 'bad-run-key');
  assert.equal(r.begin('a', key, { kind: 'service' }, { live: [] }).reason, 'bad-kind');
  assert.equal(r.active('a').ok, true);
  r.begin('a', key, { kind: 'autonomous' }); // an older runner sends no list
  assert.equal(r.active('a').reason, 'ambiguous-run');
  r.begin('a', key, { kind: 'autonomous' }, { live: 'not-a-list' });
  assert.equal(r.active('a').reason, 'ambiguous-run');
});

test('a chat run carries the io.aee.author stamp through to the active run', () => {
  const r = registry();
  const { key } = r.issueKey('a');
  r.begin('a', key, { kind: 'chat', roomId: '!r', eventId: '$1', sender: '@admin:local', author: { userId: 'u-1', subject: 'admin' } });
  assert.deepEqual(r.active('a').run.author, { userId: 'u-1', subject: 'admin' });
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

test('chatSenderFromEvent: surfaces the io.aee.author stamp when the event carries one', () => {
  const now = 10_000_000;
  const base = { type: 'm.room.message', room_id: '!r', sender: '@admin:local', origin_server_ts: now - 1000 };
  const opts = { roomId: '!r', agentMatrixId: '@agent:hs', now };
  // In the single-operator model the sender is the shared admin identity; the
  // acting human is only named by the stamp.
  const withStamp = { ...base, content: { body: 'hi', 'io.aee.author': { userId: 'u-1', subject: 'admin' } } };
  assert.deepEqual(chatSenderFromEvent(withStamp, opts), { ok: true, sender: '@admin:local', author: { userId: 'u-1', subject: 'admin' } });
  // A partial stamp keeps whichever half is present; a junk stamp is dropped.
  assert.deepEqual(chatSenderFromEvent({ ...base, content: { 'io.aee.author': { subject: 'admin' } } }, opts).author, { userId: null, subject: 'admin' });
  assert.equal(chatSenderFromEvent({ ...base, content: { 'io.aee.author': 'nope' } }, opts).author, undefined);
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

test('decision: a failed credential read is a retryable refusal, never "add your token" (#2954)', () => {
  // the read threw, so the adapter has no values and no site answer
  const d = decideCredentialGrant({
    active: chat, senderUserId: 'alice', personalValues: null, personalKeys: PERSONAL_KEYS,
    teamSiteConfigured: false, credentialReadFailed: true, pluginName: 'Jira',
  });
  assert.equal(d.ok, false);
  assert.equal(d.status, 503);
  assert.equal(d.code, 'credential-read-failed');
  assert.match(d.message, /try again in a moment/);
  assert.match(d.message, /Nothing was sent to Jira/);
  assert.doesNotMatch(d.message, /Plugin Tokens|add your/);
  assert.equal(d.missing, undefined);
  // an autonomous run never reads a personal credential — unaffected
  assert.equal(decideCredentialGrant({ active: auto, credentialReadFailed: true }).mode, 'service');
  // the sender check still comes first
  assert.equal(decideCredentialGrant({ active: chat, senderUserId: null, credentialReadFailed: true }).code, 'untrusted-sender');
});

test('decision: a chat turn with token AND team site both present → personal grant', () => {
  const d = decideCredentialGrant({ active: chat, senderUserId: 'alice', personalValues: { email: 'a@b.c', 'api-token': 't' }, personalKeys: PERSONAL_KEYS, teamSiteConfigured: true });
  assert.equal(d.ok, true);
  assert.equal(d.mode, 'personal');
});

test('decision: interactive setup gaps are aggregated into ONE refusal with a full checklist', () => {
  // both the personal token AND the team site are missing → one message, both items
  const both = decideCredentialGrant({ active: chat, senderUserId: 'alice', personalValues: null, personalKeys: PERSONAL_KEYS, teamSiteConfigured: false, pluginName: 'Jira' });
  assert.equal(both.ok, false);
  assert.equal(both.status, 424);
  assert.equal(both.code, 'setup-required');
  assert.equal(both.missing.length, 2);
  assert.deepEqual(both.missing.map((m) => m.item).sort(), ['personal-credential', 'team-site']);
  assert.deepEqual(both.missing.map((m) => m.who).sort(), ['team-admin', 'you']);
  assert.match(both.message, /Plugin Tokens \(\/plugin-tokens\)/);
  assert.match(both.message, /Team Admin/);
  assert.match(both.message, /Nothing was sent to Jira/);

  // only the site missing (token present) → keeps the stable no-site code, one item
  const siteOnly = decideCredentialGrant({ active: chat, senderUserId: 'alice', personalValues: { email: 'a@b.c', 'api-token': 't' }, personalKeys: PERSONAL_KEYS, teamSiteConfigured: false, pluginName: 'Jira' });
  assert.equal(siteOnly.code, 'no-site');
  assert.deepEqual(siteOnly.missing.map((m) => m.item), ['team-site']);
  assert.doesNotMatch(siteOnly.message, /Plugin Tokens/);

  // only the token missing, site present → keeps personal-credential-required
  const tokenOnly = decideCredentialGrant({ active: chat, senderUserId: 'alice', personalValues: null, personalKeys: PERSONAL_KEYS, teamSiteConfigured: true, pluginName: 'Jira' });
  assert.equal(tokenOnly.code, 'personal-credential-required');
  assert.deepEqual(tokenOnly.missing.map((m) => m.item), ['personal-credential']);

  // a plugin that declares no interactive connection (teamSiteConfigured undefined)
  // is never gated on a site — unchanged behaviour for non-Jira plugins
  const noSiteConcept = decideCredentialGrant({ active: chat, senderUserId: 'alice', personalValues: null, personalKeys: PERSONAL_KEYS, pluginName: 'Echo' });
  assert.equal(noSiteConcept.code, 'personal-credential-required');
});

test('buildSetupMessage lists every item and adapts its lead-in to the count', () => {
  const one = buildSetupMessage([{ what: 'X', how: 'do X' }], 'Jira');
  assert.match(one, /one thing still needs/);
  const two = buildSetupMessage([{ what: 'X', how: 'do X' }, { what: 'Y', how: 'do Y' }], 'Jira');
  assert.match(two, /a few things still need/);
  assert.match(two, /• X — do X/);
  assert.match(two, /• Y — do Y/);
});

test('decision: the untrusted-sender message tells "not a team member" apart from "could not identify the sender"', () => {
  // a real account was found but is not on this agent's team → the honest
  // cross-team message (never the misleading blame when the person IS a member)
  const notMember = decideCredentialGrant({ active: chat, senderUserId: null, senderResolved: true, personalKeys: PERSONAL_KEYS, pluginName: 'Jira' });
  assert.equal(notMember.code, 'untrusted-sender');
  assert.match(notMember.message, /not a member of this agent's team/);
  assert.doesNotMatch(notMember.message, /could not identify/);
  // no account at all resolved from the sender (e.g. the shared admin identity
  // with no author stamp) → say THAT, not "not a team member"
  const unresolved = decideCredentialGrant({ active: chat, senderUserId: null, senderResolved: false, personalKeys: PERSONAL_KEYS, pluginName: 'Jira' });
  assert.equal(unresolved.code, 'untrusted-sender');
  assert.match(unresolved.message, /could not identify who sent this chat message/);
  assert.doesNotMatch(unresolved.message, /not a member/);
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
