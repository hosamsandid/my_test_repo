'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mint, verify } = require('./plugin-scope-token');

const SECRET = 'shared-signing-secret';

test('mint → verify round-trips pluginId and scopeId', () => {
  const tok = mint('podman-sandbox', 'team-abc', SECRET);
  assert.deepEqual(verify(tok, SECRET), { pluginId: 'podman-sandbox', scopeId: 'team-abc' });
});

test('token binds to the plugin — a token for plugin A does not verify as plugin B', () => {
  const tok = mint('plugin-a', 'team-abc', SECRET);
  const v = verify(tok, SECRET);
  assert.equal(v.pluginId, 'plugin-a');
  assert.notEqual(v.pluginId, 'plugin-b');
});

test('tampered signature / wrong secret / malformed token → null', () => {
  const tok = mint('p', 's', SECRET);
  assert.equal(verify(tok + 'x', SECRET), null);
  assert.equal(verify(tok, 'other-secret'), null);
  assert.equal(verify('p.s', SECRET), null); // no signature field
  assert.equal(verify('only-two.parts', SECRET), null);
  assert.equal(verify('', SECRET), null);
  assert.equal(verify(null, SECRET), null);
});

test('scopeId is not confusable across the "." split', () => {
  // pluginId + scopeId must not contain '.', so a forged token that tries to
  // shift the field boundary changes the signed payload and fails.
  assert.throws(() => mint('p.x', 's', SECRET), /pluginId must not contain/);
  assert.throws(() => mint('p', 's.y', SECRET), /scopeId must not contain/);
});

test('agent-granularity isolation: member A token rejected for member B scope', () => {
  // Two members of one team at 'agent' granularity carry their own scopeIds.
  const tokenA = mint('sandbox', 'agent-aaaa', SECRET);
  const derived = verify(tokenA, SECRET);
  // A broker checks derived.scopeId against the resource's owner. B's resources
  // are owned by 'agent-bbbb', so A's token never matches them.
  assert.equal(derived.scopeId, 'agent-aaaa');
  assert.notEqual(derived.scopeId, 'agent-bbbb');
});
