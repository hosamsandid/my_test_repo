'use strict';

// Run: node --test admin-console/api/chat-send-identity.test.js
//
// #2721 AC4/AC5/AC9: a human's send resolves to their own identity, is
// provisioned on demand, and is refused (null) — never the shared admin —
// when no identity can be established.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveChatSendIdentity,
  usableIdentity,
  CHAT_IDENTITY_NOT_READY,
  CHAT_IDENTITY_NOT_READY_MESSAGE,
} = require('./chat-send-identity');

const JANE = { matrixUserId: '@u-0123456789abcdef:local', accessToken: 'jane-token' };
const OPERATOR = { matrixUserId: '@u-fedcba9876543210:local', accessToken: 'op-token' };

function fakeStore({ users = {}, operator = {} } = {}) {
  return {
    users,
    operator,
    readIdentity: (id) => users[id] || null,
    readOperatorIdentity: (subject) => operator[subject] || null,
  };
}

test('a user with an identity sends as that identity, without provisioning', async () => {
  let provisioned = 0;
  const identity = await resolveChatSendIdentity({
    userId: 'u-1', username: 'jane', store: fakeStore({ users: { 'u-1': JANE } }),
    provisionUser: async () => { provisioned += 1; },
  });
  assert.equal(identity, JANE);
  assert.equal(provisioned, 0);
});

test('a missing identity is provisioned before the send, then used', async () => {
  const store = fakeStore();
  const calls = [];
  const identity = await resolveChatSendIdentity({
    userId: 'u-1', username: 'jane', store,
    provisionUser: async (id) => { calls.push(id); store.users[id] = JANE; },
  });
  assert.deepEqual(calls, ['u-1']);
  assert.equal(identity, JANE);
});

test('no identity and a failing provisioning resolves to null — no fallback', async () => {
  const identity = await resolveChatSendIdentity({
    userId: 'u-1', username: 'jane', store: fakeStore(),
    provisionUser: async () => { throw new Error('503 chat identity not ready'); },
  });
  assert.equal(identity, null, 'the caller must refuse the send, not pick another account');
});

test('a stored shared-admin or agent id is never usable on a person\'s behalf (AC7)', async () => {
  for (const matrixUserId of ['@admin:local', '@k-zyskowski_accent:local', '@cobol-agent:local']) {
    const identity = await resolveChatSendIdentity({
      userId: 'u-1', store: fakeStore({ users: { 'u-1': { matrixUserId, accessToken: 'shared' } } }),
      provisionUser: async () => {},
    });
    assert.equal(identity, null, `${matrixUserId} must not be sent as`);
  }
});

test('the single operator (no user record) gets its own identity, keyed by its login subject (AC9)', async () => {
  const store = fakeStore();
  const calls = [];
  const identity = await resolveChatSendIdentity({
    userId: null, username: 'admin', operator: true, store,
    provisionUser: async () => { throw new Error('must not be called'); },
    provisionOperator: async (subject) => { calls.push(subject); store.operator[subject] = OPERATOR; },
  });
  assert.deepEqual(calls, ['admin']);
  assert.equal(identity, OPERATOR);
  assert.notEqual(identity.matrixUserId, '@admin:local');
});

test('a caller with neither a user record nor operator scope has nobody to send as', async () => {
  let called = false;
  const identity = await resolveChatSendIdentity({
    userId: null, username: 'stranger', operator: false, store: fakeStore({ operator: { stranger: OPERATOR } }),
    provisionUser: async () => { called = true; },
    provisionOperator: async () => { called = true; },
  });
  assert.equal(identity, null);
  assert.equal(called, false);
});

test('usableIdentity requires a token and a personal Matrix id', () => {
  assert.equal(usableIdentity(JANE), JANE);
  assert.equal(usableIdentity({ matrixUserId: JANE.matrixUserId }), null);
  assert.equal(usableIdentity({ accessToken: 't' }), null);
  assert.equal(usableIdentity(null), null);
});

test('the refusal code and message are stable for the UI', () => {
  assert.equal(CHAT_IDENTITY_NOT_READY, 'chat-identity-not-ready');
  assert.match(CHAT_IDENTITY_NOT_READY_MESSAGE, /not ready yet/);
  assert.match(CHAT_IDENTITY_NOT_READY_MESSAGE, /not sent/);
});
