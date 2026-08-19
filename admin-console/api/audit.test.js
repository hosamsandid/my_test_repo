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

test('recentEntries returns the newest N across day files, cost bounded by N (#1684)', () => {
  // Far-future dates so these sort newest regardless of what earlier tests wrote
  // into the shared AUDIT_DIR (the module captured the dir at load time).
  const older = path.join(audit.AUDIT_DIR, 'audit-2099-12-30.jsonl');
  const newer = path.join(audit.AUDIT_DIR, 'audit-2099-12-31.jsonl');
  fs.writeFileSync(older,
    Array.from({ length: 5 }, (_, i) => JSON.stringify({ ts: `2099-12-30T00:00:0${i}.000Z`, actor: `old-${i}` })).join('\n') + '\n');
  fs.writeFileSync(newer,
    Array.from({ length: 5 }, (_, i) => JSON.stringify({ ts: `2099-12-31T00:00:0${i}.000Z`, actor: `new-${i}` })).join('\n') + '\n');
  try {
    // Requesting 3 must return the newest 3 (from the newest day file), newest first.
    const three = audit.recentEntries(3);
    assert.deepEqual(three.map(e => e.actor), ['new-4', 'new-3', 'new-2']);

    // Boundedness: reading 3 must not open the older day file at all.
    const realOpen = fs.openSync;
    const opened = [];
    fs.openSync = (p, ...a) => { opened.push(path.basename(String(p))); return realOpen.call(fs, p, ...a); };
    try { audit.recentEntries(3); } finally { fs.openSync = realOpen; }
    assert.ok(!opened.includes('audit-2099-12-30.jsonl'), 'older day file must not be opened');
    assert.ok(opened.includes('audit-2099-12-31.jsonl'));

    // A page spanning the boundary still reads correctly, newest first.
    const seven = audit.recentEntries(7);
    assert.deepEqual(seven.map(e => e.actor), ['new-4', 'new-3', 'new-2', 'new-1', 'new-0', 'old-4', 'old-3']);
  } finally {
    fs.rmSync(older, { force: true });
    fs.rmSync(newer, { force: true });
  }
});

test('record never throws even when the directory is unwritable', () => {
  // A bogus event with a non-string ts still must not throw.
  assert.doesNotThrow(() => audit.record({ ts: 12345, actor: 'x' }));
});
