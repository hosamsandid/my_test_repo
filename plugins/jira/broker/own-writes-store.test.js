'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OwnWritesStore, fieldKey } = require('./own-writes-store');

function tmpStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-own-'));
  return new OwnWritesStore({ stateDir: dir, ...opts });
}

test('an untouched scope snapshots as four empty sections', () => {
  assert.deepEqual(tmpStore().snapshot('team-1'), { comments: {}, issues: {}, fields: {}, descriptions: {} });
});

test('record* land in their section, keyed as the extractors look them up', () => {
  const s = tmpStore({ now: () => Date.parse('2026-01-01T12:00:00Z') });
  s.recordIssue('team-1', 'KAN-1');
  s.recordComment('team-1', 'KAN-1', '10042');
  s.recordField('team-1', 'KAN-1', ' Team ');
  s.recordDescription('team-1', 'KAN-1');
  const snap = s.snapshot('team-1');
  assert.deepEqual(snap.issues, { 'KAN-1': '2026-01-01T12:00:00.000Z' });
  assert.deepEqual(Object.keys(snap.comments), ['KAN-1:c10042']);
  assert.deepEqual(Object.keys(snap.fields), [fieldKey('KAN-1', 'team')]);
  assert.deepEqual(Object.keys(snap.descriptions), ['KAN-1']);
});

test('fieldKey case-folds and trims the field ref', () => {
  assert.equal(fieldKey('KAN-1', ' Fix Version '), 'KAN-1|fix version');
  assert.equal(fieldKey('KAN-1', 'customfield_10020'), 'KAN-1|customfield_10020');
});

test('reap drops entries past retention and rewrites only when something expired', () => {
  let now = Date.parse('2026-01-01T12:00:00Z');
  const s = tmpStore({ retentionMs: 60_000, now: () => now });
  s.recordIssue('team-1', 'KAN-1');
  assert.equal(s.reap('team-1'), 0);
  now += 30_000;
  s.recordIssue('team-1', 'KAN-2');
  now += 45_000; // KAN-1 is 75s old, KAN-2 45s
  assert.equal(s.reap('team-1'), 1);
  assert.deepEqual(Object.keys(s.snapshot('team-1').issues), ['KAN-2']);
  assert.equal(s.reap('empty-team'), 0);
});

test('scopes are isolated; teardown removes the file and is idempotent', () => {
  const s = tmpStore();
  s.recordIssue('team-1', 'KAN-1');
  assert.deepEqual(s.snapshot('team-2').issues, {});
  assert.equal(s.teardown('team-1'), 1);
  assert.equal(s.teardown('team-1'), 0);
  assert.deepEqual(s.snapshot('team-1').issues, {});
});

test('a corrupt file reads as empty instead of failing the poll', () => {
  const s = tmpStore();
  fs.mkdirSync(s.dir, { recursive: true });
  fs.writeFileSync(path.join(s.dir, 'team-1.json'), '{nope');
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try { assert.deepEqual(s.snapshot('team-1').issues, {}); } finally { process.stderr.write = orig; }
});

test('an invalid scopeId is refused (path-traversal guard)', () => {
  assert.throws(() => tmpStore().recordIssue('../x', 'KAN-1'), /invalid scopeId/);
});
