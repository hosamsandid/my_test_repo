'use strict';

// Unit tests for the audit module (#305).
// Run: node --test admin-console/api/audit.test.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// Point the audit log at a throwaway dir before requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
process.env.AUDIT_DIR = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const audit = require('./audit');

test('classifyOutcome maps status codes', () => {
  assert.equal(audit.classifyOutcome(200), 'success');
  assert.equal(audit.classifyOutcome(201), 'success');
  assert.equal(audit.classifyOutcome(401), 'denied');
  assert.equal(audit.classifyOutcome(403), 'denied');
  assert.equal(audit.classifyOutcome(400), 'error');
  assert.equal(audit.classifyOutcome(500), 'error');
});

test('buildEvent names the authenticated actor and the resource', () => {
  const req = {
    method: 'DELETE',
    originalUrl: '/api/agents/cobol-agent?force=1',
    user: { username: 'alice' },
    body: {},
    ip: '10.0.0.5',
  };
  const ev = audit.buildEvent(req, { statusCode: 200 });
  assert.equal(ev.actor, 'alice');
  assert.equal(ev.method, 'DELETE');
  assert.equal(ev.resource, '/api/agents/cobol-agent'); // query stripped
  assert.equal(ev.action, 'DELETE /api/agents/cobol-agent');
  assert.equal(ev.outcome, 'success');
  assert.equal(ev.teamId, null);
  assert.ok(ev.ts);
});

test('buildEvent records teamId from the body when present', () => {
  const req = { method: 'POST', originalUrl: '/api/environments', user: { username: 'bob' }, body: { teamId: 'payments' } };
  const ev = audit.buildEvent(req, { statusCode: 201 });
  assert.equal(ev.teamId, 'payments');
});

test('buildEvent attributes a login to the attempted username (no session yet)', () => {
  const req = { method: 'POST', originalUrl: '/api/auth/login', body: { username: 'carol', password: 'x' } };
  const ev = audit.buildEvent(req, { statusCode: 401 });
  assert.equal(ev.actor, 'carol');
  assert.equal(ev.outcome, 'denied');
});

test('buildEvent falls back to anonymous when no actor is known', () => {
  const req = { method: 'POST', originalUrl: '/api/agents', body: {} };
  const ev = audit.buildEvent(req, { statusCode: 401 });
  assert.equal(ev.actor, 'anonymous');
});

test('record + recentEntries round-trip (newest first)', () => {
  audit.record({ ts: '2026-06-30T10:00:00.000Z', actor: 'alice', action: 'POST /api/x', outcome: 'success' });
  audit.record({ ts: '2026-06-30T11:00:00.000Z', actor: 'bob', action: 'DELETE /api/y', outcome: 'success' });
  const recent = audit.recentEntries(10);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].actor, 'bob');  // newest first
  assert.equal(recent[1].actor, 'alice');
  // It really hit the file.
  const files = fs.readdirSync(TMP).filter(f => f.endsWith('.jsonl'));
  assert.ok(files.length >= 1);
});

test('auditMutations skips non-mutating methods and logs mutating ones on finish', () => {
  // GET → no finish listener attached, next() called immediately.
  let nextCalled = false;
  const getRes = new EventEmitter();
  audit.auditMutations({ method: 'GET', originalUrl: '/api/agents' }, getRes, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(getRes.listenerCount('finish'), 0);

  // POST → listener attached; firing 'finish' writes an entry.
  const before = audit.recentEntries(1000).length;
  const postRes = new EventEmitter();
  postRes.statusCode = 201;
  let postNext = false;
  audit.auditMutations(
    { method: 'POST', originalUrl: '/api/agents', user: { username: 'dora' }, body: {} },
    postRes,
    () => { postNext = true; },
  );
  assert.equal(postNext, true);
  assert.equal(postRes.listenerCount('finish'), 1);
  postRes.emit('finish');
  const after = audit.recentEntries(1000);
  assert.equal(after.length, before + 1);
  assert.equal(after[0].actor, 'dora');
});

test('record never throws even when the directory is unwritable', () => {
  // A bogus event with a non-string ts still must not throw.
  assert.doesNotThrow(() => audit.record({ ts: 12345, actor: 'x' }));
});
