'use strict';

// #566/#571 — the clear-on-successful-write middleware shared by the roster
// and knowledge-graph caches.
// Run: node --test admin-console/api/invalidate-on-write.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { invalidateOnSuccessfulWrite } = require('./invalidate-on-write');

// Drive one request through the middleware: the handler sets `status`, then ends.
function run({ method = 'POST', url = '/api/x', status = 200 } = {}) {
  const r = { cleared: 0, ended: 0, nexted: 0, endArgs: [] };
  const origEnd = function end(...args) { r.ended += 1; r.endArgs.push(args); return 'ret'; };
  const res = { statusCode: 200, end: origEnd };
  const mw = invalidateOnSuccessfulWrite((m, u) => m === 'POST' && u.startsWith('/api/x'), () => { r.cleared += 1; });
  mw({ method, originalUrl: url }, res, () => { r.nexted += 1; });
  res.statusCode = status;
  r.ret = res.end('body');
  r.restored = res.end === origEnd;
  return r;
}

test('a matching write clears once its handler responds successfully', () => {
  const r = run();
  assert.equal(r.nexted, 1);
  assert.equal(r.cleared, 1);
  assert.equal(r.ended, 1);
  assert.equal(r.ret, 'ret', 'the original end runs and its return value passes through');
  assert.deepEqual(r.endArgs, [['body']]);
  assert.equal(r.restored, true, 'res.end is restored — one decision per request');
});

test('a refused or failed write leaves the cache alone', () => {
  for (const status of [400, 403, 404, 500]) {
    const r = run({ status });
    assert.equal(r.cleared, 0, String(status));
    assert.equal(r.ended, 1);
  }
});

test('a non-matching request is passed through untouched', () => {
  const r = run({ method: 'GET' });
  assert.equal(r.nexted, 1);
  assert.equal(r.cleared, 0);
  assert.equal(r.restored, true);
});

test('the clear is decided at res.end, not when the request arrives', () => {
  let cleared = 0;
  const res = { statusCode: 200, end() {} };
  invalidateOnSuccessfulWrite(() => true, () => { cleared += 1; })({ method: 'POST', originalUrl: '/api/x' }, res, () => {});
  assert.equal(cleared, 0, 'nothing before the handler responds');
  res.end();
  res.end();
  assert.equal(cleared, 1, 'a second end() call does not clear again');
});
