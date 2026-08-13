import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeServerSubmitState,
  describeCredentialSubmitState,
} from './mcp-server-submit-state.js';

const fieldsOf = result => result.reasons.map(r => r.field);

/* ── server form: happy paths ────────────────────────────────────────── */

test('stdio server with name, id and command can save', () => {
  const r = describeServerSubmitState({ name: 'Wiki', id: 'wiki', transport: 'stdio', command: 'node' });
  assert.equal(r.canSave, true);
  assert.deepEqual(r.reasons, []);
});

test('http server with name, id and url can save (command ignored)', () => {
  const r = describeServerSubmitState({ name: 'Wiki', id: 'wiki', transport: 'http', url: 'https://mcp.example/api', command: '' });
  assert.equal(r.canSave, true);
});

test('sse server is gated on url like http', () => {
  const r = describeServerSubmitState({ name: 'Wiki', id: 'wiki', transport: 'sse', url: 'https://mcp.example/api' });
  assert.equal(r.canSave, true);
});

/* ── server form: missing fields ─────────────────────────────────────── */

test('empty stdio form lists name, id and command in form order', () => {
  const r = describeServerSubmitState({ transport: 'stdio' });
  assert.equal(r.canSave, false);
  assert.deepEqual(fieldsOf(r), ['name', 'id', 'command']);
});

test('empty http form asks for the url, not a command', () => {
  const r = describeServerSubmitState({ transport: 'http' });
  assert.equal(r.canSave, false);
  assert.deepEqual(fieldsOf(r), ['name', 'id', 'url']);
});

test('stdio server missing only the command cannot save', () => {
  const r = describeServerSubmitState({ name: 'Wiki', id: 'wiki', transport: 'stdio', command: '   ' });
  assert.equal(r.canSave, false);
  assert.deepEqual(fieldsOf(r), ['command']);
});

test('http server missing only the url cannot save', () => {
  const r = describeServerSubmitState({ name: 'Wiki', id: 'wiki', transport: 'http', url: '' });
  assert.equal(r.canSave, false);
  assert.deepEqual(fieldsOf(r), ['url']);
});

test('whitespace-only name and id do not count as filled', () => {
  const r = describeServerSubmitState({ name: '  ', id: '\t', transport: 'stdio', command: 'node' });
  assert.deepEqual(fieldsOf(r), ['name', 'id']);
});

test('missing transport is treated as stdio (command-gated)', () => {
  const r = describeServerSubmitState({ name: 'Wiki', id: 'wiki' });
  assert.deepEqual(fieldsOf(r), ['command']);
});

test('server helper tolerates no argument', () => {
  const r = describeServerSubmitState();
  assert.equal(r.canSave, false);
  assert.deepEqual(fieldsOf(r), ['name', 'id', 'command']);
});

/* ── credential form ─────────────────────────────────────────────────── */

test('credential with name and secret can save', () => {
  const r = describeCredentialSubmitState({ name: 'Token', secret: 'abc123' });
  assert.equal(r.canSave, true);
  assert.deepEqual(r.reasons, []);
});

test('empty credential form lists name then secret', () => {
  const r = describeCredentialSubmitState({});
  assert.equal(r.canSave, false);
  assert.deepEqual(fieldsOf(r), ['name', 'secret']);
});

test('credential missing only the secret cannot save', () => {
  const r = describeCredentialSubmitState({ name: 'Token', secret: '  ' });
  assert.equal(r.canSave, false);
  assert.deepEqual(fieldsOf(r), ['secret']);
});

test('credential helper tolerates no argument', () => {
  const r = describeCredentialSubmitState();
  assert.equal(r.canSave, false);
  assert.deepEqual(fieldsOf(r), ['name', 'secret']);
});

test('every reason carries a human-readable message', () => {
  for (const r of [describeServerSubmitState({ transport: 'http' }), describeCredentialSubmitState({})]) {
    for (const reason of r.reasons) {
      assert.equal(typeof reason.message, 'string');
      assert.ok(reason.message.length > 0);
    }
  }
});
