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

// ── #2525: agent-scoped Events tab ──────────────────────────────────────────

const DEV = 'developer';
const armedDrop = {
  ts: '2026-09-28T10:00:00.000Z', eventId: '100', repo: 'org/repo', event: 'issues.labeled', label: 'ready',
  workItem: { kind: 'issue', number: 7, title: 'T', url: 'u' },
  outcomes: [
    { agentId: DEV, triggerId: 't1', status: 'dropped', reason: 'wake-already-armed', digest: false, wakeLabel: 'ready' },
    { agentId: DEV, triggerId: 't2', status: 'dropped', reason: 'label-filter', digest: false },
    { agentId: 'reviewer', triggerId: 'r1', status: 'delivered', reason: null, digest: false },
  ],
};
const refireRow = {
  ts: '2026-09-28T11:00:00.000Z', eventId: 'refire:abc', repo: 'org/repo', event: 'issues.labeled', label: 'ready',
  workItem: { kind: 'issue', number: 7 }, source: 'manual-refire', refiredBy: 'ana',
  refireOf: { eventId: '100', reason: 'wake-already-armed', ts: armedDrop.ts },
  outcomes: [{ agentId: DEV, triggerId: 't1', status: 'delivered', reason: null, digest: false, wakeLabel: 'ready' }],
};

test('projectAgentRows (#2525): one row per trigger outcome of this agent only, newest first', () => {
  const rows = eventLog.projectAgentRows([armedDrop, refireRow], DEV);
  assert.deepEqual(rows.map(r => [r.eventId, r.triggerId, r.status]), [
    ['refire:abc', 't1', 'delivered'],
    ['100', 't1', 'dropped'],
    ['100', 't2', 'dropped'],
  ]);
  assert.equal(new Set(rows.map(r => r.key)).size, 3, 'row keys are unique');
  assert.deepEqual(eventLog.projectAgentRows([armedDrop], 'nobody'), []);
});

test('projectAgentRows (#2525): a re-fired drop carries who/when; the other trigger does not', () => {
  const rows = eventLog.projectAgentRows([armedDrop, refireRow], DEV);
  const t1 = rows.find(r => r.eventId === '100' && r.triggerId === 't1');
  const t2 = rows.find(r => r.eventId === '100' && r.triggerId === 't2');
  assert.deepEqual(t1.refired, { eventId: 'refire:abc', by: 'ana', at: '2026-09-28T11:00:00.000Z' });
  assert.equal(t2.refired, null);
  const re = rows.find(r => r.eventId === 'refire:abc');
  assert.equal(re.source, 'manual-refire');
  assert.equal(re.refiredBy, 'ana');
  assert.equal(re.refireOf.eventId, '100');
});

test('projectAgentRows (#2525): an internal-dedup drop names its earlier twin delivery', () => {
  const twin = {
    ts: '2026-09-28T09:00:00.000Z', eventId: 'label-fastpath:x', repo: 'org/repo', event: 'issues.labeled', label: 'ready',
    workItem: { kind: 'issue', number: 7 }, source: 'internal',
    outcomes: [{ agentId: DEV, triggerId: 't1', status: 'delivered', wakeLabel: 'ready' }],
  };
  const dedup = {
    ...armedDrop, eventId: '101',
    outcomes: [{ agentId: DEV, triggerId: 't1', status: 'dropped', reason: 'internal-dedup', wakeLabel: 'ready' }],
  };
  const rows = eventLog.projectAgentRows([twin, dedup], DEV);
  assert.deepEqual(rows.find(r => r.eventId === '101').twin,
    { eventId: 'label-fastpath:x', triggerId: 't1', ts: '2026-09-28T09:00:00.000Z' });
  assert.equal(rows.find(r => r.eventId === 'label-fastpath:x').twin, null);
});

test('queryAgentEntries (#2525): filters by agent before capping and honours the window', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const noise = Array.from({ length: 30 }, (_, i) => ({
    ts: `2026-09-28T12:${String(i).padStart(2, '0')}:00.000Z`, eventId: `n${i}`, repo: 'org/repo', event: 'push',
    outcomes: [{ agentId: 'other', triggerId: 'o', status: 'delivered' }],
  }));
  writeDay('2026-09-20', [{ ...armedDrop, ts: '2026-09-20T10:00:00.000Z', eventId: 'old' }]);
  writeDay('2026-09-28', [armedDrop, refireRow, ...noise]);
  const now = Date.parse('2026-09-29T00:00:00Z');
  const rows = eventLog.queryAgentEntries({ agentId: DEV, limit: 3, now });
  assert.deepEqual(rows.map(r => r.eventId), ['refire:abc', '100', '100'], 'noise never crowds out the agent rows; the 7-day default window excludes old');
  const wide = eventLog.queryAgentEntries({ agentId: DEV, since: '2026-09-01T00:00:00Z', now });
  assert.ok(wide.some(r => r.eventId === 'old'));
  const narrow = eventLog.queryAgentEntries({ agentId: DEV, since: '2026-09-28T10:30:00Z', now });
  assert.deepEqual(narrow.map(r => r.eventId), ['refire:abc']);
  assert.deepEqual(eventLog.queryAgentEntries({ agentId: '' }), []);
});

test('projectAgentRows (#2571): a producer-filter drop carries who pushed (null = unknown)', () => {
  const push = (eventId, producer) => ({
    ts: '2026-09-29T10:00:00.000Z', eventId, repo: 'org/repo', event: 'push',
    outcomes: [{ agentId: DEV, triggerId: 'p', status: 'dropped', reason: 'producer-filter', digest: false, producer }],
  });
  const rows = eventLog.projectAgentRows([push('1', 't1-review'), push('2', null)], DEV);
  assert.deepEqual(rows.map(r => r.producer), ['t1-review', null]);
  assert.equal('producer' in eventLog.projectAgentRows([armedDrop], DEV)[0], false);
});

test('projectAgentRows (#2570): a push row carries its ref so a branch-filter drop can name the branch', () => {
  const push = {
    ts: '2026-09-29T10:00:00.000Z', eventId: 'p1', repo: 'o/r', event: 'push', ref: 'refs/heads/agent-knowledge',
    outcomes: [{ agentId: 'dev', triggerId: 'on-push', status: 'dropped', reason: 'branch-filter' }],
  };
  const [row] = eventLog.projectAgentRows([push], 'dev');
  assert.equal(row.ref, 'refs/heads/agent-knowledge');
  assert.equal(row.reason, 'branch-filter');
});

// ── #2596: naming/linking the pool instance a pooled delivery ran on ──────
test('projectPoolInstance names an existing instance by its display name', () => {
  const configs = {
    'team-developer': { displayName: 'Developer' },
    'team-developer-i2562': { displayName: 'Developer · #2562' },
  };
  const r = eventLog.projectPoolInstance(
    { agentId: 'team-developer', status: 'delivered', instanceId: 'team-developer-i2562' },
    (id) => configs[id] || null,
  );
  assert.equal(r.instanceName, 'Developer · #2562');
  assert.equal(r.instanceExists, true);
  assert.equal(r.instanceItem, '2562');
  assert.equal(r.poolRoleName, 'Developer');
});

test('projectPoolInstance marks a reaped instance and still names it after its ticket', () => {
  const r = eventLog.projectPoolInstance(
    { agentId: 'team-developer', status: 'delivered', instanceId: 'team-developer-i2562' },
    (id) => (id === 'team-developer' ? { displayName: 'Developer' } : null),
  );
  assert.equal(r.instanceExists, false);
  assert.equal(r.instanceName, 'Developer · #2562');
  assert.equal(r.poolRoleName, 'Developer');
});

test('projectPoolInstance falls back to the ids when no config is readable', () => {
  const r = eventLog.projectPoolInstance(
    { agentId: 'team-developer', status: 'delivered', instanceId: 'team-developer-i7' },
    () => null,
  );
  assert.equal(r.instanceName, 'team-developer-i7');
  assert.equal(r.poolRoleName, 'team-developer');
  assert.equal(r.instanceExists, false);
});

test('projectPoolInstance leaves non-pooled and pre-#2596 outcomes untouched', () => {
  const o = { agentId: 'dev', status: 'delivered', agentName: 'dev' };
  let calls = 0;
  assert.equal(eventLog.projectPoolInstance(o, () => { calls++; return null; }), o);
  assert.equal(calls, 0, 'no config read for a row without an instance');
});

test('projectAgentRows (#2795): a readiness-gate row carries its gates and cancel reason', () => {
  const entry = {
    ts: '2026-10-03T10:00:00.000Z', eventId: '900', repo: 'org/repo', event: 'pull_request.labeled', label: 'ready-for-review',
    workItem: { kind: 'pr', number: 9 },
    outcomes: [
      { agentId: DEV, triggerId: 'g1', status: 'held', reason: 'readiness-gate', gates: ['ci', 'conflict'], wakeLabel: 'ready-for-review' },
      { agentId: DEV, triggerId: 'g2', status: 'dropped', reason: 'gate-cancelled', cancelReason: 'closed' },
      { agentId: DEV, triggerId: 'g3', status: 'dropped', reason: 'wake-already-armed', cancelReason: 'stray' },
    ],
  };
  const rows = eventLog.projectAgentRows([entry], DEV);
  const by = Object.fromEntries(rows.map(r => [r.triggerId, r]));
  assert.deepEqual(by.g1.gates, ['ci', 'conflict']);
  assert.equal(by.g2.cancelReason, 'closed');
  assert.ok(!('gates' in by.g3) && !('cancelReason' in by.g3));
});

test('projectAgentRows (#2822): a comment-label drop names the required label', () => {
  const comment = {
    ts: '2026-10-04T10:00:00.000Z', eventId: 'c1', repo: 'o/r', event: 'issue_comment.created',
    workItem: { kind: 'issue', number: 4 },
    outcomes: [{ agentId: 'dev', triggerId: 'answer', status: 'dropped', reason: 'comment-label', requireLabel: 'clarifying' }],
  };
  const [row] = eventLog.projectAgentRows([comment], 'dev');
  assert.equal(row.reason, 'comment-label');
  assert.equal(row.requireLabel, 'clarifying');
  assert.equal('requireLabel' in eventLog.projectAgentRows([armedDrop], DEV)[0], false);
});
