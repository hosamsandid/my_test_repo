'use strict';

// Unit tests for the GitHub event-log reader (#469).
// Run: node --test admin-console/api/github-event-log.test.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the reader at a throwaway dir before requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'github-event-log-read-test-'));
process.env.GITHUB_EVENT_LOG_DIR = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const eventLog = require('./github-event-log');

function writeDay(day, lines) {
  fs.writeFileSync(
    path.join(TMP, `github-events-${day}.jsonl`),
    lines.map(l => JSON.stringify(l)).join('\n') + '\n',
  );
}

test('filterEntries sorts newest first and caps at the default limit', () => {
  const entries = [
    { ts: '2026-07-01T10:00:00.000Z', eventId: '1' },
    { ts: '2026-07-03T10:00:00.000Z', eventId: '3' },
    { ts: '2026-07-02T10:00:00.000Z', eventId: '2' },
  ];
  const out = eventLog.filterEntries(entries, {});
  assert.deepEqual(out.map(e => e.eventId), ['3', '2', '1']);
});

test('filterEntries applies since/until bounds', () => {
  const entries = [
    { ts: '2026-07-01T00:00:00.000Z', eventId: 'old' },
    { ts: '2026-07-05T00:00:00.000Z', eventId: 'mid' },
    { ts: '2026-07-10T00:00:00.000Z', eventId: 'new' },
  ];
  const out = eventLog.filterEntries(entries, {
    sinceMs: Date.parse('2026-07-02T00:00:00.000Z'),
    untilMs: Date.parse('2026-07-09T00:00:00.000Z'),
  });
  assert.deepEqual(out.map(e => e.eventId), ['mid']);
});

test('filterEntries respects an explicit limit, within the hard cap', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ ts: `2026-07-01T00:00:${String(i).padStart(2, '0')}.000Z`, eventId: String(i) }));
  const out = eventLog.filterEntries(entries, { limit: 3 });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(e => e.eventId), ['9', '8', '7']);
});

test('filterEntries never drops a row with an unparsable timestamp', () => {
  const entries = [{ ts: 'not-a-date', eventId: 'weird' }];
  const out = eventLog.filterEntries(entries, { sinceMs: Date.now() });
  assert.equal(out.length, 1);
});

test('queryEntries reads across day files and merges them', () => {
  writeDay('2026-07-06', [{ ts: '2026-07-06T09:00:00.000Z', eventId: 'a', repo: 'org/repo' }]);
  writeDay('2026-07-07', [{ ts: '2026-07-07T09:00:00.000Z', eventId: 'b', repo: 'org/repo' }]);
  const out = eventLog.queryEntries({});
  assert.deepEqual(out.map(e => e.eventId).sort(), ['a', 'b']);
});

test('queryEntries applies a since filter across files', () => {
  const out = eventLog.queryEntries({ since: '2026-07-07T00:00:00.000Z' });
  assert.deepEqual(out.map(e => e.eventId), ['b']);
});

test('queryEntries skips corrupt lines without throwing', () => {
  fs.writeFileSync(path.join(TMP, 'github-events-2026-07-08.jsonl'), 'not json\n' + JSON.stringify({ ts: '2026-07-08T00:00:00.000Z', eventId: 'c' }) + '\n');
  const out = eventLog.queryEntries({ since: '2026-07-08T00:00:00.000Z' });
  assert.deepEqual(out.map(e => e.eventId), ['c']);
});

test('queryEntries without a window reads only the tail, bounded by limit (#1684)', () => {
  writeDay('2026-07-20', Array.from({ length: 5 }, (_, i) => ({ ts: `2026-07-20T00:00:0${i}.000Z`, eventId: `old-${i}` })));
  writeDay('2026-07-21', Array.from({ length: 5 }, (_, i) => ({ ts: `2026-07-21T00:00:0${i}.000Z`, eventId: `new-${i}` })));

  const realOpen = fs.openSync;
  const opened = [];
  fs.openSync = (p, ...a) => { opened.push(path.basename(String(p))); return realOpen.call(fs, p, ...a); };
  let out;
  try { out = eventLog.queryEntries({ limit: 2 }); } finally { fs.openSync = realOpen; }

  // Newest first, capped at the limit.
  assert.deepEqual(out.map(e => e.eventId), ['new-4', 'new-3']);
  // Boundedness: the older day file (and the earlier-written ones) stay closed.
  assert.ok(opened.includes('github-events-2026-07-21.jsonl'));
  assert.ok(!opened.includes('github-events-2026-07-20.jsonl'), 'older day file must not be opened');

  // Cleanup so the trailing "missing dir" test still starts from a known state.
  fs.rmSync(path.join(TMP, 'github-events-2026-07-20.jsonl'), { force: true });
  fs.rmSync(path.join(TMP, 'github-events-2026-07-21.jsonl'), { force: true });
});

test('queryEntries returns [] when the log directory does not exist', () => {
  const before = process.env.GITHUB_EVENT_LOG_DIR;
  // listDayFiles reads EVENT_LOG_DIR captured at module load, so simulate
  // "missing" by pointing readdir at a path that was never created — done
  // by deleting TMP itself (last-touching test; nothing runs after it that
  // depends on TMP's contents).
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.deepEqual(eventLog.queryEntries({}), []);
  process.env.GITHUB_EVENT_LOG_DIR = before;
});
