'use strict';

// Unit tests for the hill-climbing anomaly-sweep history substrate (#1221).
// Run: node --test orchestrator/anomaly-history.test.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the history at a throwaway teams dir before requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anomaly-history-test-'));
process.env.HILL_CLIMB_TEAMS_DIR = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const history = require('./anomaly-history');

const DAY = 24 * 60 * 60 * 1000;

test('historyPath places the file under teams/<teamId>/hill-climb/', () => {
  assert.equal(
    history.historyPath('team-x'),
    path.join(TMP, 'team-x', 'hill-climb', 'anomaly-history.jsonl'),
  );
});

test('historyPath rejects an unsafe team id (traversal guard)', () => {
  assert.equal(history.historyPath('../evil'), null);
  assert.equal(history.historyPath(''), null);
  assert.equal(history.historyPath('a/b'), null);
});

test('buildHistoryEntry keeps the ranked anomaly list, count and errors', () => {
  const now = Date.parse('2026-08-03T10:00:00Z');
  const entry = history.buildHistoryEntry({
    anomalies: [
      { class: 'wake-not-claimed', objectId: 'org/repo#42', severity: 'warn' },
      { class: 'claim-stalled', objectId: 'org/repo#43', severity: 'warn' },
    ],
    errors: ['org/repo: timeout'],
    // extra fields are ignored — only ts/count/anomalies/errors are persisted
    repos: ['org/repo'],
  }, now);
  assert.equal(entry.ts, '2026-08-03T10:00:00.000Z');
  assert.equal(entry.count, 2);
  assert.equal(entry.anomalies.length, 2);
  assert.equal(entry.anomalies[0].objectId, 'org/repo#42');
  assert.deepEqual(entry.errors, ['org/repo: timeout']);
});

test('buildHistoryEntry tolerates a missing/empty result (errors-only line)', () => {
  const entry = history.buildHistoryEntry({ errors: ['boom'] });
  assert.equal(entry.count, 0);
  assert.deepEqual(entry.anomalies, []);
  assert.deepEqual(entry.errors, ['boom']);
  assert.ok(entry.ts);

  const empty = history.buildHistoryEntry();
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.anomalies, []);
  assert.deepEqual(empty.errors, []);
});

test('retainRecentLines keeps lines inside the window and drops older ones', () => {
  const now = Date.parse('2026-08-03T12:00:00Z');
  const lines = [
    JSON.stringify({ ts: new Date(now).toISOString(), count: 1 }),          // now
    JSON.stringify({ ts: new Date(now - 89 * DAY).toISOString(), count: 0 }), // inside 90d
    JSON.stringify({ ts: new Date(now - 91 * DAY).toISOString(), count: 0 }), // expired
    JSON.stringify({ ts: new Date(now - 400 * DAY).toISOString(), count: 0 }), // long expired
    '', // blank — dropped
  ];
  const kept = history.retainRecentLines(lines, now, 90);
  assert.equal(kept.length, 2);
});

test('retainRecentLines keeps unparseable or undatable lines rather than losing data', () => {
  const now = Date.parse('2026-08-03T12:00:00Z');
  const lines = [
    'not json at all',
    JSON.stringify({ count: 3 }), // no ts
    JSON.stringify({ ts: 'not-a-date' }),
    JSON.stringify({ ts: new Date(now - 400 * DAY).toISOString() }), // expired → dropped
  ];
  const kept = history.retainRecentLines(lines, now, 90);
  assert.equal(kept.length, 3);
});

test('record appends one JSONL line per sweep and round-trips', () => {
  history.record('team-rt', history.buildHistoryEntry({ anomalies: [{ class: 'gate-idle' }] }));
  history.record('team-rt', history.buildHistoryEntry({ anomalies: [] }));
  const p = history.historyPath('team-rt');
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).count, 1);
  assert.equal(JSON.parse(lines[1]).count, 0);
});

test('record never throws on an unsafe team id or a malformed entry', () => {
  assert.doesNotThrow(() => history.record('../evil', { ts: 'x' }));
  assert.doesNotThrow(() => history.record('team-rt', undefined));
});

test('pruneOldEntries rewrites the file dropping only expired lines', () => {
  const now = Date.parse('2026-08-03T12:00:00Z');
  const p = history.historyPath('team-prune');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, [
    JSON.stringify({ ts: new Date(now - 100 * DAY).toISOString(), count: 0 }), // expired
    JSON.stringify({ ts: new Date(now - 10 * DAY).toISOString(), count: 1 }),  // kept
    JSON.stringify({ ts: new Date(now).toISOString(), count: 2 }),             // kept
  ].join('\n') + '\n');
  history.pruneOldEntries('team-prune', now, 90);
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).count, 1);
});

test('pruneOldEntries leaves the file untouched when nothing expired', () => {
  const now = Date.parse('2026-08-03T12:00:00Z');
  const p = history.historyPath('team-fresh');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const content = JSON.stringify({ ts: new Date(now).toISOString(), count: 0 }) + '\n';
  fs.writeFileSync(p, content);
  const before = fs.statSync(p).mtimeMs;
  history.pruneOldEntries('team-fresh', now, 90);
  assert.equal(fs.readFileSync(p, 'utf8'), content);
  assert.equal(fs.statSync(p).mtimeMs, before); // no rewrite
});

test('pruneOldEntries does not throw when the file does not exist yet', () => {
  assert.doesNotThrow(() => history.pruneOldEntries('never-swept'));
});
