const test = require('node:test');
const assert = require('node:assert/strict');

const { guardCredentialRefChange } = require('./credential-ref-guard');

test('no change (same id) is allowed', () => {
  assert.deepEqual(guardCredentialRefChange({ prev: 'tok-a', next: 'tok-a', prevVisible: false }), { ok: true });
});

test('nothing bound before → any set is allowed (nothing to protect)', () => {
  assert.deepEqual(guardCredentialRefChange({ prev: null, next: 'tok-a', prevVisible: false, nextVisible: true }), { ok: true });
  assert.deepEqual(guardCredentialRefChange({ prev: '', next: 'tok-a', prevVisible: false, nextVisible: true }), { ok: true });
});

test('previously-bound token the caller CAN see → change/clear allowed as normal', () => {
  assert.deepEqual(guardCredentialRefChange({ prev: 'tok-a', next: null, prevVisible: true }), { ok: true });
  assert.deepEqual(guardCredentialRefChange({ prev: 'tok-a', next: 'tok-b', prevVisible: true, nextVisible: true }), { ok: true });
});

test('the data-loss case: clearing an invisible bound token is REJECTED', () => {
  const out = guardCredentialRefChange({ prev: 'personal-thorsten', next: null, prevVisible: false });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(out.code, 'protected_credential_clear');
});

test('swapping an invisible bound token for ANOTHER invisible one is REJECTED', () => {
  const out = guardCredentialRefChange({ prev: 'personal-thorsten', next: 'personal-alex', prevVisible: false, nextVisible: false });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(out.code, 'protected_credential_swap');
});

test('replacing an invisible bound token with one the caller CAN see is allowed', () => {
  assert.deepEqual(
    guardCredentialRefChange({ prev: 'personal-thorsten', next: 'team-token', prevVisible: false, nextVisible: true }),
    { ok: true },
  );
});

test('the `kind` label is woven into the message (github token / SSH key reuse)', () => {
  const out = guardCredentialRefChange({ prev: 'k1', next: null, prevVisible: false, kind: 'SSH key' });
  assert.match(out.error, /SSH key set that is not visible to you/);
});

test('falsy/empty inputs are treated as "unset" consistently', () => {
  // undefined prev = nothing bound
  assert.deepEqual(guardCredentialRefChange({ prev: undefined, next: 'x', prevVisible: false, nextVisible: true }), { ok: true });
});
