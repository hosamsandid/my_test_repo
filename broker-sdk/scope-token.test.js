'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mint, verify, verifyScopeToken } = require('./scope-token');

const SECRET = 'test-signing-secret';

test('round-trips {pluginId, scopeId}', () => {
  const tok = mint('podman-sandbox', 'team-abc', SECRET);
  assert.deepEqual(verify(tok, SECRET), { pluginId: 'podman-sandbox', scopeId: 'team-abc' });
});

test('round-trips an AGENT-granularity scopeId identically (granularity-agnostic)', () => {
  const tok = mint('podman-sandbox', 'agent-aaaa', SECRET);
  // Same shape, no team/agent field — the broker cannot tell them apart.
  assert.deepEqual(verify(tok, SECRET), { pluginId: 'podman-sandbox', scopeId: 'agent-aaaa' });
});

test('forgery: a tampered signature does not verify', () => {
  const tok = mint('p', 'team-abc', SECRET);
  const forged = `${tok.slice(0, -1)}${tok.slice(-1) === 'A' ? 'B' : 'A'}`;
  assert.equal(verify(forged, SECRET), null);
});

test('forgery: wrong secret does not verify', () => {
  const tok = mint('p', 's', SECRET);
  assert.equal(verify(tok, 'other-secret'), null);
});

test('forgery: cannot swap scopeId while keeping the signature', () => {
  const a = mint('p', 'team-abc', SECRET);
  const sig = a.slice(a.lastIndexOf('.') + 1);
  // Attacker keeps a valid signature but points it at another scope.
  const swapped = `p.team-victim.${sig}`;
  assert.equal(verify(swapped, SECRET), null);
});

test('forgery: cannot swap pluginId while keeping the signature', () => {
  const a = mint('plugin-a', 'team-abc', SECRET);
  const sig = a.slice(a.lastIndexOf('.') + 1);
  const swapped = `plugin-b.team-abc.${sig}`;
  assert.equal(verify(swapped, SECRET), null);
});

test('rejects malformed tokens (too few fields / empty fields)', () => {
  assert.equal(verify('', SECRET), null);
  assert.equal(verify('onlyone', SECRET), null);
  assert.equal(verify('p.s', SECRET), null); // no signature field
  assert.equal(verify('.s.sig', SECRET), null); // empty pluginId
  assert.equal(verify('p..sig', SECRET), null); // empty scopeId
  assert.equal(verify('p.s.', SECRET), null); // empty signature
  assert.equal(verify(null, SECRET), null);
  assert.equal(verify('p.s.sig', ''), null); // no secret
});

test('mint rejects ids containing "."', () => {
  assert.throws(() => mint('p.x', 's', SECRET), /pluginId must not contain/);
  assert.throws(() => mint('p', 's.y', SECRET), /scopeId must not contain/);
  assert.throws(() => mint('', 's', SECRET), /mint requires/);
});

test('verifyScopeToken parses a Bearer header string', () => {
  const tok = mint('podman-sandbox', 'agent-xyz', SECRET);
  assert.deepEqual(
    verifyScopeToken(`Bearer ${tok}`, SECRET),
    { pluginId: 'podman-sandbox', scopeId: 'agent-xyz' },
  );
});

test('verifyScopeToken parses a request-like object', () => {
  const tok = mint('podman-sandbox', 'team-abc', SECRET);
  const req = { headers: { authorization: `Bearer ${tok}` } };
  assert.deepEqual(verifyScopeToken(req, SECRET), { pluginId: 'podman-sandbox', scopeId: 'team-abc' });
});

test('verifyScopeToken rejects a missing/blank/non-Bearer header', () => {
  assert.equal(verifyScopeToken('', SECRET), null);
  assert.equal(verifyScopeToken('Bearer ', SECRET), null);
  assert.equal(verifyScopeToken('Basic abc', SECRET), null);
  assert.equal(verifyScopeToken({ headers: {} }, SECRET), null);
  assert.equal(verifyScopeToken(undefined, SECRET), null);
});
