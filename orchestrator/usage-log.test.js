'use strict';

// Unit tests for the token-usage record writer (#654).
// Run: node --test orchestrator/usage-log.test.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the log at a throwaway dir before requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-log-test-'));
process.env.USAGE_LOG_DIR = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const usageLog = require('./usage-log');

test('dayOf buckets by the record ts, not wall clock', () => {
  assert.equal(usageLog.dayOf({ ts: '2026-07-15T09:15:00.000Z' }), '2026-07-15');
  assert.equal(usageLog.dayOf({ ts: '2026-07-16T23:59:59.999Z' }), '2026-07-16');
});

test('dayOf falls back to today for a missing/unusable ts', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(usageLog.dayOf({}), today);
  assert.equal(usageLog.dayOf({ ts: 12345 }), today);
  assert.equal(usageLog.dayOf({ ts: 'not-a-date' }), today);
  assert.equal(usageLog.dayOf(null), today);
});

test('record round-trip: one JSONL line per record, bucketed by record ts', () => {
  const rec = {
    ts: '2026-07-16T10:00:00.000Z', agentId: 'team-a-developer', teamId: 'team-a',
    tokens: { input: 10, output: 42, cacheCreationInput: 8141, cacheReadInput: 17718 },
  };
  assert.equal(usageLog.record(rec), true);
  const fp = path.join(TMP, 'usage-2026-07-16.jsonl');
  assert.ok(fs.existsSync(fp));
  const lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[lines.length - 1]).agentId, 'team-a-developer');
});

test('records for different days land in different files', () => {
  usageLog.record({ ts: '2026-07-15T09:15:00.000Z', agentId: 'team-b-ba' });
  usageLog.record({ ts: '2026-07-16T14:30:00.000Z', agentId: 'team-a-code-reviewer' });
  assert.ok(fs.existsSync(path.join(TMP, 'usage-2026-07-15.jsonl')));
  assert.ok(fs.existsSync(path.join(TMP, 'usage-2026-07-16.jsonl')));
});

test('record never throws on a malformed entry', () => {
  assert.doesNotThrow(() => usageLog.record(undefined));
});
