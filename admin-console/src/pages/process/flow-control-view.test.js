import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatDuration,
  since,
  updatedAgo,
  itemRef,
  rowView,
  sessionView,
  poolView,
  needsYouView,
  boardView,
  EMPTY_TEXT,
  POOL_ACTION_TOOLTIPS,
  AUTO_REFRESH_MS,
  autoRefreshKey,
  readAutoRefresh,
  writeAutoRefresh,
  configFormRows,
  configFromForm,
} from './flow-control-view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HELP_TOPIC = path.join(here, '..', '..', '..', 'api', 'helper-chat', 'help-topics', 'flow-control.md');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const ago = (mins) => new Date(NOW - mins * 60_000).toISOString();

const STAGES = [
  { id: 'ready', label: 'Ready', roles: [] },
  { id: 't-dev', label: 'Developer', roles: ['t-dev'] },
  { id: 't-rev', label: 'Code Reviewer', roles: ['t-rev'] },
  { id: 'done', label: 'Done', roles: [] },
];

const row = (over = {}) => ({
  id: 'o/r#7',
  title: 'Add the thing',
  url: 'https://gh/o/r/issues/7',
  issue: { repo: 'o/r', number: 7, url: 'https://gh/o/r/issues/7' },
  prs: [{ repo: 'o/r', number: 70, url: 'https://gh/o/r/pull/70', state: 'open' }],
  stageId: 't-rev',
  stageIndex: 2,
  status: 'working',
  agentId: 't-rev',
  since: ago(75),
  done: false,
  needsHuman: null,
  ...over,
});

// ── durations ──────────────────────────────────────────────────────────────

test('formatDuration: compact, comparable units', () => {
  assert.equal(formatDuration(20_000), 'under 1m');
  assert.equal(formatDuration(4 * 60_000), '4m');
  assert.equal(formatDuration(60 * 60_000), '1h');
  assert.equal(formatDuration(190 * 60_000), '3h 10m');
  assert.equal(formatDuration(53 * 3600_000), '2d 5h');
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(-5), '');
});

test('since / updatedAgo: relative to an injected now; junk is blank', () => {
  assert.equal(since(ago(12), NOW), '12m');
  assert.equal(since('nope', NOW), '');
  assert.equal(updatedAgo(new Date(NOW - 2000).toISOString(), NOW), 'Updated just now');
  assert.equal(updatedAgo(new Date(NOW - 42_000).toISOString(), NOW), 'Updated 42s ago');
  assert.equal(updatedAgo(ago(3), NOW), 'Updated 3m ago');
  assert.equal(updatedAgo(null, NOW), '');
});

test('itemRef: short on a single-repo board, qualified across repos', () => {
  assert.equal(itemRef('o/r', 12, true), '#12');
  assert.equal(itemRef('o/r', 12, false), 'o/r#12');
  assert.equal(itemRef('o/r', null, true), '');
});

// ── rows (AC4, AC5) ────────────────────────────────────────────────────────

test('rowView: one row carries the issue and its PRs, the current stage and time in stage', () => {
  const v = rowView(row(), STAGES, { now: NOW });
  assert.equal(v.ref, '#7');
  assert.deepEqual(v.prs.map((p) => p.label), ['PR #70']);
  assert.equal(v.stageLabel, 'Code Reviewer');
  assert.equal(v.inStage, '1h 15m');
  assert.deepEqual(v.steps.map((s) => s.state), ['past', 'past', 'current', 'future']);
  assert.equal(v.statusText, 'working');
});

test('rowView: a PR-only row has no issue ref; a done row marks every step past', () => {
  const pr = rowView(row({ issue: null, stageId: 'done', stageIndex: 3, status: 'done', done: true }), STAGES, { now: NOW });
  assert.equal(pr.ref, '');
  assert.equal(pr.issueUrl, null);
  assert.ok(pr.steps.every((s) => s.state === 'past'));
});

test('rowView: the step list is exactly the team\'s own stages — no fixed vocabulary', () => {
  const kitchen = [
    { id: 'ready', label: 'Ready' }, { id: 'k-chef', label: 'Chef' },
    { id: 'k-taster', label: 'Taster' }, { id: 'done', label: 'Done' },
  ];
  const v = rowView(row({ stageId: 'k-chef', stageIndex: undefined }), kitchen, { now: NOW });
  assert.deepEqual(v.steps.map((s) => s.label), ['Ready', 'Chef', 'Taster', 'Done']);
  assert.equal(v.stageLabel, 'Chef');
});

// ── area ① (AC7, AC13) ─────────────────────────────────────────────────────

test('sessionView: role, instance, work item and running time', () => {
  const v = sessionView({
    id: 's1', agentId: 't-dev-i7', roleLabel: 'Developer', instance: 7,
    issue: { repo: 'o/r', number: 7 }, title: 'Add the thing', startedAt: ago(9),
  }, { now: NOW });
  assert.deepEqual(
    { role: v.role, instance: v.instance, item: v.item, running: v.running },
    { role: 'Developer', instance: '#7', item: '#7', running: '9m' },
  );
  const prOnly = sessionView({ agentId: 't-rev', roleLabel: 'Code Reviewer', issue: null, prs: [{ repo: 'o/r', number: 70 }], startedAt: ago(1) }, { now: NOW });
  assert.equal(prOnly.item, 'PR #70');
  assert.equal(prOnly.instance, null);
});

test('poolView: running shows "x of y busy" with Pause and Drain', () => {
  const v = poolView({ roleId: 'developer', label: 'Developer', busy: 2, capacity: 3, state: 'running' });
  assert.equal(v.occupancy, '2 of 3 busy');
  assert.equal(v.stateText, null);
  assert.deepEqual(v.actions.map((a) => [a.label, a.nextState]), [['Pause', 'paused'], ['Drain', 'draining']]);
});

test('poolView: Draining counts what still runs, then Off offers Switch on', () => {
  const draining = poolView({ roleId: 'developer', busy: 2, capacity: 3, state: 'draining' });
  assert.equal(draining.stateText, 'Draining, 2 still running');
  assert.deepEqual(draining.actions.map((a) => a.label), ['Switch on']);
  const off = poolView({ roleId: 'developer', busy: 0, capacity: 3, state: 'off', held: 4 });
  assert.equal(off.stateText, 'Off · 4 waiting');
  assert.deepEqual(off.actions.map((a) => [a.label, a.nextState]), [['Switch on', 'running']]);
});

test('poolView: Paused differs from Draining — it resumes, it never switches off', () => {
  const v = poolView({ roleId: 'developer', busy: 1, capacity: null, state: 'paused', held: 1 });
  assert.equal(v.occupancy, '1 busy');
  assert.equal(v.stateText, 'Paused, 1 still running · 1 waiting');
  assert.deepEqual(v.actions.map((a) => a.label), ['Resume']);
});

// ── AC14: tooltips a newcomer understands, and the help topic agrees ───────

test('each Pause/Drain/Resume/Switch-on tooltip says what happens to running work, new work, and how to undo', () => {
  const { pause, drain, resume, switchOn } = POOL_ACTION_TOOLTIPS;
  for (const t of [pause, drain]) {
    assert.match(t, /running instances finish/i, 'running work');
    assert.match(t, /new work waits/i, 'new work');
  }
  assert.match(pause, /Resume/);
  assert.match(drain, /Off/);
  assert.match(drain, /Switch on/);
  for (const t of [resume, switchOn]) assert.match(t, /starts now/);
  assert.ok(Object.values(POOL_ACTION_TOOLTIPS).every((t) => !/wipLimit|pool-control|instance id/i.test(t)), 'no jargon');
});

test('help-topics/flow-control.md quotes every tooltip verbatim', () => {
  const topic = fs.readFileSync(HELP_TOPIC, 'utf8').replace(/\s+/g, ' ');
  for (const [key, text] of Object.entries(POOL_ACTION_TOOLTIPS)) {
    assert.ok(topic.includes(text), `the help topic must say exactly what the ${key} tooltip says: "${text}"`);
  }
});

// ── area ② (AC8) ───────────────────────────────────────────────────────────

test('needsYouView: plain reason and waiting time', () => {
  const v = needsYouView({ id: 'o/r#61', title: 'Fix', issue: null, prs: [{ repo: 'o/r', number: 61 }], reason: 'conflict with base', since: ago(130) }, { now: NOW });
  assert.deepEqual({ ref: v.ref, reason: v.reason, waiting: v.waiting }, { ref: 'PR #61', reason: 'conflict with base', waiting: '2h 10m' });
});

// ── the whole board (AC8, AC10, empty/degraded states) ─────────────────────

test('boardView: area ② is null when nothing needs a person; empty board reads "Nothing in progress"', () => {
  const v = boardView({ stages: STAGES, rows: [], needsHuman: [], sessions: [], pools: [], repos: ['o/r'], generatedAt: ago(0) }, NOW);
  assert.equal(v.needsYou, null);
  assert.equal(v.empty, true);
  assert.equal(v.emptyText, 'Nothing in progress');
  assert.equal(EMPTY_TEXT, 'Nothing in progress');
});

test('boardView: stale snapshot keeps its rows and surfaces the warning', () => {
  const v = boardView({
    stages: STAGES, rows: [row()], needsHuman: [{ id: 'o/r#7', reason: 'checks failing', since: ago(5), issue: { repo: 'o/r', number: 7 } }],
    repos: ['o/r'], generatedAt: ago(10), stale: true, warning: 'GitHub is unreachable — showing the last known state from X.',
  }, NOW);
  assert.equal(v.rows.length, 1);
  assert.equal(v.stale, true);
  assert.match(v.warning, /unreachable/);
  assert.equal(v.needsYou.length, 1);
});

test('boardView: qualifies refs only on a multi-repo board; flags a team without a repository', () => {
  const multi = boardView({ stages: STAGES, rows: [row()], repos: ['o/r', 'o/s'], generatedAt: ago(0) }, NOW);
  assert.equal(multi.rows[0].ref, 'o/r#7');
  const none = boardView({ stages: STAGES, rows: [], repos: [], generatedAt: ago(0) }, NOW);
  assert.equal(none.noRepos, true);
  const maint = boardView({ maintenance: true, repos: [], generatedAt: ago(0) }, NOW);
  assert.equal(maint.noRepos, false);
  assert.equal(maint.maintenance, true);
});

test('boardView: none of the removed surfaces are produced (AC10)', () => {
  const v = boardView({ stages: STAGES, rows: [row()], repos: ['o/r'], generatedAt: ago(0) }, NOW);
  for (const gone of ['summary', 'epics', 'rollups', 'backlog', 'openPrs', 'lanes']) {
    assert.ok(!(gone in v), `"${gone}" must not come back`);
  }
});

// ── AC12: auto-refresh, remembered per user ────────────────────────────────

function memoryStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('auto-refresh: every 30 s, on by default, remembered per user', () => {
  assert.equal(AUTO_REFRESH_MS, 30_000);
  const store = memoryStore();
  assert.equal(autoRefreshKey('ada'), 'flowControl.autoRefresh.ada');
  assert.equal(autoRefreshKey(null), 'flowControl.autoRefresh.anon');
  assert.equal(readAutoRefresh('ada', store), true);
  writeAutoRefresh('ada', false, store);
  assert.equal(readAutoRefresh('ada', store), false);
  assert.equal(readAutoRefresh('bob', store), true, 'one user\'s choice never leaks to another');
  writeAutoRefresh('ada', true, store);
  assert.equal(readAutoRefresh('ada', store), true);
});

test('auto-refresh: an unreadable store falls back to on', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readAutoRefresh('ada', broken), true);
  assert.doesNotThrow(() => writeAutoRefresh('ada', false, broken));
});

// ── AC6 / AC9: column configuration ────────────────────────────────────────

test('configFormRows / configFromForm: round-trip rename, merge, hide and retention; blanks drop out', () => {
  const roles = [{ id: 't-dev', label: 'Developer' }, { id: 't-rev', label: 'Code Reviewer' }, { id: 't-rew', label: 'Reworker' }];
  const config = { doneRetentionHours: 48, stages: { 't-rev': { label: 'Review' }, 't-rew': { mergeInto: 't-rev' } } };
  const form = configFormRows(roles, config);
  assert.deepEqual(form.map((r) => [r.id, r.derivedLabel, r.label, r.hidden, r.mergeInto]), [
    ['t-dev', 'Developer', '', false, ''],
    ['t-rev', 'Code Reviewer', 'Review', false, ''],
    ['t-rew', 'Reworker', '', false, 't-rev'],
  ]);
  form[0].hidden = true;
  form[1].label = '  ';
  assert.deepEqual(configFromForm(form, '48'), {
    doneRetentionHours: 48,
    stages: { 't-dev': { hidden: true }, 't-rew': { mergeInto: 't-rev' } },
  });
  assert.equal(configFromForm([], 'x').doneRetentionHours, 24);
  assert.deepEqual(configFromForm([{ id: 'a', mergeInto: 'a' }], 24).stages, {}, 'merging into itself is no merge');
});
