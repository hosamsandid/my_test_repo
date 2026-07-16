'use strict';

// Unit tests for the admin-console-side usage-record reader (#654).
// Run: node --test admin-console/api/usage-log.test.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-log-reader-test-'));
process.env.USAGE_LOG_DIR = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const usageLog = require('./usage-log');

function writeDay(day, records) {
  fs.writeFileSync(
    path.join(TMP, `usage-${day}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}

test('readRecords merges every day file, newest bucketed last', () => {
  writeDay('2026-07-15', [{ ts: '2026-07-15T09:00:00.000Z', agentId: 'a' }]);
  writeDay('2026-07-16', [
    { ts: '2026-07-16T10:00:00.000Z', agentId: 'b' },
    { ts: '2026-07-16T14:00:00.000Z', agentId: 'c' },
  ]);
  const recs = usageLog.readRecords();
  assert.deepEqual(recs.map((r) => r.agentId).sort(), ['a', 'b', 'c']);
});

test('readRecords skips whole day files ending before since', () => {
  const recs = usageLog.readRecords({ since: '2026-07-16T00:00:00.000Z' });
  assert.deepEqual(recs.map((r) => r.agentId).sort(), ['b', 'c']);
});

test('readRecords skips corrupt lines without throwing', () => {
  fs.writeFileSync(path.join(TMP, 'usage-2026-07-17.jsonl'), '{bad json\n{"ts":"2026-07-17T01:00:00.000Z","agentId":"d"}\n');
  const recs = usageLog.readRecords({ since: '2026-07-17T00:00:00.000Z' });
  assert.deepEqual(recs.map((r) => r.agentId), ['d']);
});

test('readRecords returns [] when the directory does not exist', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.deepEqual(usageLog.readRecords(), []);
});
