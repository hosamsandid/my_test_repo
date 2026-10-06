import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { absoluteWhen } from '../../components/format-when.js';
import {
  formatDuration,
  since,
  updatedAgo,
  itemRef,
  issueCell,
  prEmptyCell,
  NO_PR_TEXT,
  NO_ISSUE_TEXT,
  rowView,
  doneTitle,
  sessionView,
  poolView,
  groupWorkingNow,
  needsYouView,
  wakeCauseText,
  WAKE_CONFIRM_TEXT,
  wakeDialogTitle,
  wakeTargetText,
  wakeNotice,
  WAKE_CAUSE_TEXT,
  boardView,
  EMPTY_TEXT,
  retentionHint,
  POOL_ACTION_TOOLTIPS,
  AUTO_REFRESH_MS,
  autoRefreshKey,
  readAutoRefresh,
  writeAutoRefresh,
  configFormRows,
  configFromForm,
  REMOVE_CONFIRM_TEXT,
  removeDialogTitle,
  RELEASE_CONFIRM_TEXT,
  releaseDialogTitle,
  releaseNotice,
  removedView,
  withoutRows,
  instanceOf,
  chatLink,
  CHAT_LINK_CLASS,
  CHAT_LINK_CSS,
} from './flow-control-view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HELP_TOPIC = path.join(here, '..', '..', '..', 'api', 'helper-chat', 'help-topics', 'flow-control.md');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const ago = (mins) => new Date(NOW - mins * 60_000).toISOString();

const STAGES = [
  { id: 'draft', label: 'Draft', roles: [] },
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
  assert.deepEqual(v.prs.map((p) => p.text), ['#70']);
  assert.equal(v.stageLabel, 'Code Reviewer');
  assert.equal(v.inStage, '1h 15m');
  assert.deepEqual(v.steps.map((s) => s.state), ['past', 'past', 'current', 'future']);
  assert.equal(v.statusText, 'working');
});

test('rowView: a PR-only row has no issue ref; a done row marks every step past', () => {
  const pr = rowView(row({ issue: null, stageId: 'done', stageIndex: 3, status: 'done', done: true }), STAGES, { now: NOW });
  assert.equal(pr.ref, '');
  assert.equal(pr.issue.url, null);
  assert.ok(pr.steps.every((s) => s.state === 'past'));
});

// ── #2800: leading Issue and Pull request columns ──────────────────────────

test('rowView #2800: issue only — issue linked, neutral "no PR yet" placeholder (AC2, AC5)', () => {
  const v = rowView(row({ prs: [] }), STAGES, { now: NOW });
  assert.deepEqual(v.issue, { text: '#7', url: 'https://gh/o/r/issues/7', title: '', empty: null });
  assert.deepEqual(v.prs, []);
  assert.deepEqual(v.prEmpty, { text: '—', title: 'No pull request yet', empty: 'pending' });
  assert.equal(NO_PR_TEXT, 'No pull request yet');
});

test('rowView #2800: issue + one PR — bare number without the "PR" prefix, linked (AC3)', () => {
  const v = rowView(row(), STAGES, { now: NOW });
  assert.equal(v.issue.text, '#7');
  assert.equal(v.prEmpty, null);
  assert.deepEqual(v.prs, [{ key: 'o/r#70', text: '#70', url: 'https://gh/o/r/pull/70', state: 'open', struck: false }]);
});

test('rowView #2800: several PRs — one entry each, backend order, merged/closed cues kept (AC3)', () => {
  const v = rowView(row({
    prs: [
      { repo: 'o/r', number: 72, url: 'u72', state: 'open' },
      { repo: 'o/r', number: 70, url: 'u70', state: 'closed' },
      { repo: 'o/r', number: 71, url: 'u71', state: 'merged' },
      { repo: 'o/r', number: 73 },
    ],
  }), STAGES, { now: NOW });
  assert.deepEqual(v.prs.map((p) => p.text), ['#72', '#70', '#71 (merged)', '#73']);
  assert.deepEqual(v.prs.map((p) => p.struck), [false, true, false, false]);
  assert.deepEqual(v.prs.map((p) => p.state), ['open', 'closed', 'merged', 'open']);
  assert.equal(v.prs[3].url, null);
  assert.ok(v.prs.every((p) => !p.text.startsWith('PR')));
});

test('rowView #2800: PR only — warning placeholder "No linked issue", distinct from the empty-PR one (AC6)', () => {
  const v = rowView(row({ issue: null }), STAGES, { now: NOW });
  assert.deepEqual(v.issue, { text: '—', url: null, title: 'No linked issue', empty: 'missing' });
  assert.equal(NO_ISSUE_TEXT, 'No linked issue');
  assert.deepEqual(v.prs.map((p) => p.text), ['#70']);
  assert.notEqual(v.issue.empty, prEmptyCell([]).empty);
  assert.notEqual(v.issue.title, prEmptyCell([]).title);
});

test('rowView #2800: multi-repo board — full owner/repo#N refs in both columns (AC2, AC3)', () => {
  const v = rowView(row({
    prs: [{ repo: 'o/other', number: 9, url: 'u9', state: 'merged' }],
  }), STAGES, { now: NOW, singleRepo: false });
  assert.equal(v.issue.text, 'o/r#7');
  assert.deepEqual(v.prs.map((p) => p.text), ['o/other#9 (merged)']);
  assert.equal(v.ref, 'o/r#7');
});

test('issueCell #2800: falls back to the row url when the issue carries none', () => {
  assert.equal(issueCell({ repo: 'o/r', number: 7 }, 'https://row', true).url, 'https://row');
  assert.equal(issueCell({ repo: 'o/r', number: 7 }, null, true).url, null);
  assert.equal(prEmptyCell(undefined).title, 'No pull request yet');
});

test('BoardTable #2800: Issue · Pull request lead the columns; the title cell carries no number line (#651 source guard)', () => {
  const jsx = fs.readFileSync(path.join(here, '..', 'FlowControl.jsx'), 'utf8');
  const head = jsx.slice(jsx.indexOf('function BoardTable'), jsx.indexOf('function BoardRow'));
  const order = ['>Issue<', '>Pull request<', '>Work item<', '>Progress<', '>Stage<', '>In stage<'].map((h) => head.indexOf(h));
  assert.ok(order.every((i) => i > 0), `all headers present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const body = jsx.slice(jsx.indexOf('function BoardRow'), jsx.indexOf('function StageProgress'));
  assert.doesNotMatch(body, /row\.ref|issueUrl|p\.label/);
  assert.match(jsx, /const numberCellStyle = \{ \.\.\.cellStyle, whiteSpace: 'nowrap'/);
});

// ── #2643: time since completion on done rows ─────────────────────────────────

const doneRow = (over = {}) => row({ stageId: 'done', stageIndex: 3, status: 'done', done: true, ...over });

test('rowView: a done row shows the time since completion, in the same format as other rows (AC1)', () => {
  const v = rowView(doneRow({ since: ago(135) }), STAGES, { now: NOW });
  assert.equal(v.inStage, '2h 15m');
  assert.equal(v.inStage, since(ago(135), NOW));
});

test('rowView: a PR-only done row shows the time since its merge/close (AC2)', () => {
  const v = rowView(doneRow({ issue: null, since: ago(7) }), STAGES, { now: NOW });
  assert.equal(v.inStage, '7m');
});

test('rowView: hovering a done row\'s value gives the absolute completion time (AC3)', () => {
  const at = ago(135);
  const v = rowView(doneRow({ since: at }), STAGES, { now: NOW });
  assert.equal(v.inStageTitle, `Finished ${absoluteWhen(at)}`);
  assert.ok(absoluteWhen(at));
  assert.equal(doneTitle(doneRow({ since: at })), v.inStageTitle);
});

test('rowView: a done row without a usable completion time stays empty — no placeholder, no NaN (AC4)', () => {
  for (const bad of [undefined, null, '', 'not-a-date']) {
    const v = rowView(doneRow({ since: bad }), STAGES, { now: NOW });
    assert.equal(v.inStage, '', `since=${bad}`);
    assert.equal(v.inStageTitle, '', `since=${bad}`);
  }
});

test('rowView: rows that are not done keep their value and get no tooltip (AC5)', () => {
  const v = rowView(row(), STAGES, { now: NOW });
  assert.equal(v.inStage, '1h 15m');
  assert.equal(v.inStageTitle, '');
  assert.equal(doneTitle(null), '');
});

test('rowView: done edge cases — just inside retention, and a completion slightly in the future', () => {
  assert.equal(rowView(doneRow({ since: ago(23 * 60 + 59) }), STAGES, { now: NOW }).inStage, '23h 59m');
  const future = rowView(doneRow({ since: ago(-2) }), STAGES, { now: NOW });
  assert.equal(future.inStage, 'under 1m');
});

test('rowView: the value follows the injected now, so each refresh advances it (AC6)', () => {
  const r = doneRow({ since: ago(10) });
  assert.equal(rowView(r, STAGES, { now: NOW }).inStage, '10m');
  assert.equal(rowView(r, STAGES, { now: NOW + 30 * 60_000 }).inStage, '40m');
});

test('BoardRow renders In stage for done rows too, with the view\'s tooltip (#651 source guard)', () => {
  const jsx = fs.readFileSync(path.join(here, '..', 'FlowControl.jsx'), 'utf8');
  assert.doesNotMatch(jsx, /row\.done \? '' : row\.inStage/);
  assert.match(jsx, /title=\{row\.inStageTitle\}/);
});

test('rowView: the step list is exactly the team\'s own stages — no fixed vocabulary', () => {
  const kitchen = [
    { id: 'draft', label: 'Draft' }, { id: 'k-chef', label: 'Chef' },
    { id: 'k-taster', label: 'Taster' }, { id: 'done', label: 'Done' },
  ];
  const v = rowView(row({ stageId: 'k-chef', stageIndex: undefined }), kitchen, { now: NOW });
  assert.deepEqual(v.steps.map((s) => s.label), ['Draft', 'Chef', 'Taster', 'Done']);
  assert.equal(v.stageLabel, 'Chef');
});

// ── #2637: Draft and "Remove from board" ─────────────────────────────────────

test('rowView: an unreleased item reads Draft · awaiting release — never "released" (AC1, AC2)', () => {
  const v = rowView(row({ stageId: 'draft', stageIndex: 0, status: 'draft', removable: true }), STAGES, { now: NOW });
  assert.equal(v.stageLabel, 'Draft');
  assert.equal(v.statusText, 'awaiting release');
  assert.deepEqual(v.steps.map((s) => [s.label, s.state]).slice(0, 2), [['Draft', 'current'], ['Developer', 'future']]);
  assert.equal(v.removable, true);
  for (const status of ['draft', 'ready', 'working', 'queued', 'idle', 'done']) {
    assert.doesNotMatch(rowView(row({ status }), STAGES).statusText, /released/);
  }
});

test('rowView: a released item is up next at its role and offers no removal (AC4, AC5)', () => {
  const v = rowView(row({ stageId: 't-dev', stageIndex: 1, status: 'queued', removable: false }), STAGES, { now: NOW });
  assert.equal(v.stageLabel, 'Developer');
  assert.equal(v.statusText, 'up next');
  assert.equal(v.removable, false);
  assert.equal(rowView(row(), STAGES).removable, false); // absent → not offered
});

test('remove confirmation says only the board entry goes and the ticket stays unchanged (AC6)', () => {
  assert.match(REMOVE_CONFIRM_TEXT, /only the board entry is removed/i);
  assert.match(REMOVE_CONFIRM_TEXT, /GitHub ticket stays unchanged/);
  assert.equal(removeDialogTitle('#2563'), 'Remove #2563 from the board?');
  assert.equal(removeDialogTitle(''), 'Remove this item from the board?');
  const topic = fs.readFileSync(HELP_TOPIC, 'utf8');
  assert.match(topic, /only the board entry is\s+removed — the GitHub ticket stays unchanged/);
});

test('withoutRows: a removed row leaves the board (and Needs you) at once, before the next snapshot (AC6)', () => {
  const data = { rows: [row({ id: 'a' }), row({ id: 'b' })], needsHuman: [{ id: 'a' }, { id: 'c' }], stages: STAGES };
  const next = withoutRows(data, ['a']);
  assert.deepEqual(next.rows.map((r) => r.id), ['b']);
  assert.deepEqual(next.needsHuman.map((n) => n.id), ['c']);
  assert.equal(next.stages, STAGES);
  assert.equal(withoutRows(null, ['a']), null);
});

test('boardView: removed items are counted and listed for Restore (AC9)', () => {
  const v = boardView({
    repos: ['o/r'], stages: STAGES, rows: [row()],
    removed: [
      { id: 'o/r#2563', removalId: 'o/r#2563', title: 'Concept', url: 'u', issue: { repo: 'o/r', number: 2563 }, prs: [], removedAt: ago(90) },
      { id: 'o/r#91', title: 'PR only', issue: null, prs: [{ repo: 'o/r', number: 91 }], removedAt: ago(5) },
    ],
  }, NOW);
  assert.equal(v.removedLabel, 'Removed (2)');
  assert.deepEqual(v.removed.map((r) => [r.ref, r.removalId, r.removedAgo]), [['#2563', 'o/r#2563', '1h 30m'], ['PR #91', 'o/r#91', '5m']]);
  assert.deepEqual(boardView({}, NOW).removed, []);
  assert.equal(removedView({ id: 'x', removedAt: ago(1) }, { now: NOW }).title, '(untitled)');
});

// ── jump to the working agent's chat (#2723) ───────────────────────────────

test('chatLink: in-console href to the exact agent, named for the role and instance (AC1, AC2, AC6)', () => {
  assert.deepEqual(chatLink('t-dev-i2716', 'Developer'), { to: '/chats/t-dev-i2716', label: 'Open chat with Developer #2716' });
  assert.deepEqual(chatLink('t-rev', 'Code Reviewer'), { to: '/chats/t-rev', label: 'Open chat with Code Reviewer' });
  assert.equal(chatLink('a b/c', '').to, '/chats/a%20b%2Fc');
  assert.equal(chatLink('a b/c', '').label, 'Open chat with a b/c');
  assert.equal(chatLink('t-dev-i9', 'Developer', null).label, 'Open chat with Developer');
  for (const none of [null, undefined, '', 42]) assert.equal(chatLink(none, 'Developer'), null);
});

test('instanceOf: reads the pool item from a <template>-i<item> id', () => {
  assert.equal(instanceOf('team-developer-i2716'), 2716);
  assert.equal(instanceOf('team-developer'), null);
  assert.equal(instanceOf(null), null);
});

test('rowView: a working row with a running agent links to that pool instance, not the template (AC1, AC2)', () => {
  const v = rowView(row({ stageId: 't-dev', stageIndex: 1, roleId: 't-dev', roleLabel: 'Developer', agentId: 't-dev-i2716' }), STAGES, { now: NOW });
  assert.deepEqual(v.chat, { to: '/chats/t-dev-i2716', label: 'Open chat with Developer #2716' });
});

test('rowView: without a roleLabel the stage label names the link target', () => {
  assert.equal(rowView(row(), STAGES).chat.label, 'Open chat with Code Reviewer');
});

test('rowView: working only by a claim label (no agentId) is not a link (AC4)', () => {
  assert.equal(rowView(row({ agentId: null }), STAGES).chat, null);
  assert.equal(rowView(row({ agentId: undefined }), STAGES).chat, null);
});

test('rowView: rows with any other status are not links, even with an agentId (AC5)', () => {
  for (const status of ['queued', 'idle', 'draft', 'done']) {
    assert.equal(rowView(row({ status, agentId: 't-dev-i7' }), STAGES).chat, null, status);
  }
});

test('sessionView: every running session links to its own agent (AC3)', () => {
  const pooled = sessionView({ id: 's1', agentId: 't-dev-i7', roleLabel: 'Developer', instance: 7, startedAt: ago(1) });
  assert.deepEqual(pooled.chat, { to: '/chats/t-dev-i7', label: 'Open chat with Developer #7' });
  const plain = sessionView({ id: 's2', agentId: 't-rev', roleId: 't-rev', instance: null, startedAt: ago(1) });
  assert.deepEqual(plain.chat, { to: '/chats/t-rev', label: 'Open chat with t-rev' });
  // The server's instance number is authoritative — never re-derived from the id.
  assert.equal(sessionView({ agentId: 'x-i9', roleLabel: 'X', instance: null }).chat.label, 'Open chat with X');
  const two = boardView({ sessions: [
    { id: 'a', agentId: 't-dev-i7', roleLabel: 'Developer', instance: 7 },
    { id: 'b', agentId: 't-dev-i8', roleLabel: 'Developer', instance: 8 },
  ] }).sessions.map((s) => s.chat.to);
  assert.deepEqual(two, ['/chats/t-dev-i7', '/chats/t-dev-i8']);
});

test('chat link CSS gives hover and keyboard-focus affordances', () => {
  assert.match(CHAT_LINK_CSS, new RegExp(`\\.${CHAT_LINK_CLASS}:hover \\{[^}]*text-decoration: underline`));
  assert.match(CHAT_LINK_CSS, new RegExp(`\\.${CHAT_LINK_CLASS}:focus-visible \\{[^}]*outline`));
});

test('FlowControl wires the chat links: router Link, stage cell and Working-now line (#651 source guard)', () => {
  const jsx = fs.readFileSync(path.join(here, '..', 'FlowControl.jsx'), 'utf8');
  assert.match(jsx, /import \{ Link as RouterLink(, [^}]*)? \} from 'react-router';/);
  assert.match(jsx, /<style>\{CHAT_LINK_CSS\}<\/style>/);
  assert.match(jsx, /if \(!chat\) return children;/);
  assert.match(jsx, /<RouterLink to=\{chat\.to\} title=\{chat\.label\} aria-label=\{chat\.label\} className=\{CHAT_LINK_CLASS\}/);
  assert.match(jsx, /<ChatLink chat=\{row\.chat\}>\s*<div[^>]*>\{row\.stageLabel\}<\/div>\s*<div[^>]*>\{row\.statusText\}<\/div>\s*<\/ChatLink>/);
  assert.match(jsx, /<ChatLink chat=\{s\.chat\}>\s*\{s\.role\}/);
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

test('#2789 poolView: instances waiting on a PR are named apart — "on a PR", never confused with held work', () => {
  const v = poolView({ roleId: 'developer', busy: 2, capacity: 3, state: 'running', waiting: 4 });
  assert.equal(v.occupancy, '2 of 3 busy · 4 waiting on a PR');
  const d = poolView({ roleId: 'developer', busy: 0, capacity: 3, state: 'draining', waiting: 1, held: 2 });
  assert.equal(d.stateText, 'Draining, 0 still running · 1 waiting on a PR · 2 waiting');
  assert.match(POOL_ACTION_TOOLTIPS.drain, /waiting on an open pull request/, 'AC8: the drain says it waits for them');
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

test('needsYouView: a wake never delivered names each label, its cause and the Event Log row (#2872)', () => {
  const v = needsYouView({
    id: 'o/r#2819', title: 'Release button', issue: { repo: 'o/r', number: 2819 }, prs: [],
    reason: 'wake never delivered', since: ago(1094),
    wakes: [
      { repo: 'o/r', number: 2820, kind: 'pr', label: 'ready-for-review', roles: [{ id: 't-rev', label: 'Code Reviewer' }], cause: 'history-horizon', eventId: '123', since: ago(1094) },
      { repo: 'o/r', number: 2862, kind: 'pr', label: 'changes-requested', cause: 'not-seen', eventId: null, since: ago(1000) },
    ],
  }, { now: NOW });
  assert.equal(v.reason, 'wake never delivered');
  assert.deepEqual(v.wakes, [
    {
      ref: 'PR #2820', label: 'ready-for-review', cause: 'history-horizon', text: WAKE_CAUSE_TEXT['history-horizon'], href: '/github-events?event=123',
      roles: [{ id: 't-rev', label: 'Code Reviewer' }], target: 'Wake Code Reviewer for PR #2820 (ready-for-review)',
    },
    {
      ref: 'PR #2862', label: 'changes-requested', cause: 'not-seen', text: 'never reported by the GitHub Events API', href: null,
      roles: [], target: 'Wake its agent for PR #2862 (changes-requested)',
    },
  ]);
  assert.equal(v.canWake, true);
  const other = needsYouView({ id: 'x', reason: 'conflict with base' }, { now: NOW });
  assert.deepEqual([other.wakes, other.canWake], [[], false]);
});

test('wakeCauseText: the four causes the board reports (#2872)', () => {
  assert.equal(wakeCauseText({ cause: 'history-horizon' }), 'older than its agent\u2019s trigger (flow re-applied or team moved)');
  assert.equal(wakeCauseText({ cause: 'wake-already-armed' }), 're-add dropped as already armed');
  assert.equal(wakeCauseText({ cause: 'not-seen' }), 'never reported by the GitHub Events API');
  assert.equal(wakeCauseText({ cause: 'dropped', dropReason: 'throttle' }), 'dropped (throttle)');
  assert.equal(wakeCauseText({ cause: 'dropped' }), 'dropped (unknown)');
  assert.equal(wakeCauseText(null), '');
});

test('boardView: an orphaned claim flagged needs-help shows amber on its working row and in Needs you with its waiting time (#2734)', () => {
  const needsHuman = { reason: 'stuck — no progress, needs help', since: ago(75) };
  const stuck = row({ stageId: 't-dev', stageIndex: 1, agentId: null, needsHuman });
  const v = boardView({
    stages: STAGES, rows: [stuck], sessions: [], pools: [], repos: ['o/r'], generatedAt: ago(0),
    needsHuman: [{ id: stuck.id, title: stuck.title, url: stuck.url, issue: stuck.issue, prs: stuck.prs, ...needsHuman }],
  }, NOW);
  assert.equal(v.activeRows[0].status, 'working');
  assert.equal(v.activeRows[0].blocked, true);
  assert.deepEqual(v.needsYou.map((n) => [n.ref, n.reason, n.waiting]), [['#7', 'stuck — no progress, needs help', '1h 15m']]);
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
  assert.equal(v.activeRows.length, 1);
  assert.equal(v.stale, true);
  assert.match(v.warning, /unreachable/);
  assert.equal(v.needsYou.length, 1);
});

test('boardView: qualifies refs only on a multi-repo board; flags a team without a repository', () => {
  const multi = boardView({ stages: STAGES, rows: [row()], repos: ['o/r', 'o/s'], generatedAt: ago(0) }, NOW);
  assert.equal(multi.activeRows[0].ref, 'o/r#7');
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

// ── #2607: "Recently completed" is its own section ─────────────────────────

const boardOf = (rows, extra = {}) => boardView({ stages: STAGES, rows, repos: ['o/r'], generatedAt: ago(0), ...extra }, NOW);

test('boardView: an all-active board has no done rows and is not empty (#2607)', () => {
  const v = boardOf([row({ id: 'a' }), row({ id: 'b' })]);
  assert.deepEqual(v.activeRows.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(v.doneRows, []);
  assert.equal(v.empty, false);
});

test('boardView: an all-done board leaves "In progress" empty (#2607)', () => {
  const v = boardOf([row({ id: 'a', done: true, status: 'done' }), row({ id: 'b', done: true, status: 'done' })]);
  assert.deepEqual(v.activeRows, []);
  assert.deepEqual(v.doneRows.map((r) => r.id), ['a', 'b']);
  assert.equal(v.empty, true);
  assert.equal(v.emptyText, 'Nothing in progress');
});

test('boardView: a mixed board puts each row in exactly one section, order kept (#2607)', () => {
  const v = boardOf([row({ id: 'a' }), row({ id: 'b', done: true }), row({ id: 'c' }), row({ id: 'd', done: true })]);
  assert.deepEqual(v.activeRows.map((r) => r.id), ['a', 'c']);
  assert.deepEqual(v.doneRows.map((r) => r.id), ['b', 'd']);
  assert.ok(v.activeRows.every((r) => !r.done));
  assert.ok(v.doneRows.every((r) => r.done));
  assert.ok(!('rows' in v), 'no mixed row list');
});

test('boardView: a stale snapshot still sorts rows by their done flag (#2607)', () => {
  const v = boardOf([row({ id: 'a' }), row({ id: 'b', done: true })], { stale: true });
  assert.deepEqual(v.activeRows.map((r) => r.id), ['a']);
  assert.deepEqual(v.doneRows.map((r) => r.id), ['b']);
});

test('retentionHint: states the retention window, with a fallback (#2607)', () => {
  assert.equal(retentionHint(24), 'Kept for 24 h · configurable in columns settings');
  assert.equal(retentionHint(1.5), 'Kept for 1.5 h · configurable in columns settings');
  for (const none of [0, null, undefined, 'x', -3]) {
    assert.equal(retentionHint(none), 'Kept for a limited time · configurable in columns settings');
  }
  assert.equal(boardOf([], { config: { doneRetentionHours: 48 } }).retentionHint, 'Kept for 48 h · configurable in columns settings');
  assert.equal(boardOf([], { doneRetentionHours: 12 }).retentionHint, 'Kept for 12 h · configurable in columns settings');
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

test('needsYouView: a stuck row carries its releasable claims; other rows carry none (#2754)', () => {
  const v = needsYouView({
    id: 'o/r#7', title: 'Fix', issue: { repo: 'o/r', number: 7 }, prs: [], reason: 'stuck — no progress, needs help', since: ago(75),
    release: [
      { repo: 'o/r', number: 7, kind: 'issue', claim: 'ready:wip', wake: 'ready' },
      { repo: 'o/r', number: 61, kind: 'pr', claim: 'ready-to-merge:wip', wake: 'ready-to-merge' },
      { repo: 'o/r', number: 8, kind: 'issue' },
    ],
  }, { now: NOW });
  assert.deepEqual(v.release, [
    { ref: '#7', claim: 'ready:wip', wake: 'ready', text: 'ready:wip → ready' },
    { ref: 'PR #61', claim: 'ready-to-merge:wip', wake: 'ready-to-merge', text: 'ready-to-merge:wip → ready-to-merge' },
  ]);
  const plain = needsYouView({ id: 'o/r#61', title: 'Fix', issue: null, prs: [{ repo: 'o/r', number: 61 }], reason: 'conflict with base', since: ago(130) }, { now: NOW });
  assert.deepEqual(plain.release, []);
});

test('release dialog copy says what changes on GitHub (#2754)', () => {
  assert.equal(releaseDialogTitle('#7'), 'Release the claim on #7?');
  assert.equal(releaseDialogTitle(''), 'Release this claim?');
  assert.match(RELEASE_CONFIRM_TEXT, /wake label/);
  assert.match(RELEASE_CONFIRM_TEXT, /next poll/);
});

test('a successful release leaves a notice saying what happens next (#2754)', () => {
  assert.equal(releaseNotice({ released: 1 }, '#7'), 'Claim released on #7 — its agent picks it up on the next poll (within about a minute).');
  assert.equal(releaseNotice({ released: 2 }, ''), '2 claims released — its agent picks it up on the next poll (within about a minute).');
  assert.equal(releaseNotice({ released: 0 }, '#7'), null);
  assert.equal(releaseNotice(null, '#7'), null);
});

test('#2795: a PR held by its hand-off gate shows "waiting for CI" on the row', () => {
  const held = rowView(row({ gateHold: { number: 41, waitingFor: ['ci', 'conflict'], since: ago(10), agentIds: ['rev'] } }), STAGES, { now: NOW });
  assert.equal(held.gateText, 'waiting for CI / conflict-free');
  assert.match(held.gateTitle, /^PR #41's hand-off is held until the PR is green and conflict-free \(held 10m\)/);
  assert.equal(rowView(row({ gateHold: { number: 41, waitingFor: ['ci'] } }), STAGES, { now: NOW }).gateText, 'waiting for CI');
  assert.equal(rowView(row({ gateHold: { number: 41, waitingFor: [] } }), STAGES, { now: NOW }).gateText, 'hand-off gate resolving');
  const free = rowView(row(), STAGES, { now: NOW });
  assert.equal(free.gateText, '');
  assert.equal(free.gateTitle, '');
  const jsx = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'FlowControl.jsx'), 'utf8');
  assert.match(jsx, /\{row\.gateText && <div style=\{mutedStyle\} title=\{row\.gateTitle\}>⏳ \{row\.gateText\}<\/div>\}/);
});

// #2848 — running instances nested beneath their pool line.
test('groupWorkingNow: pooled instances go beneath their own pool, in server order (AC1, AC2, edge: stable order)', () => {
  const v = boardView({
    sessions: [
      { id: 'a', agentId: 't-dev-i8', roleId: 't-dev', roleLabel: 'Developer', instance: 8, startedAt: ago(9) },
      { id: 'b', agentId: 't-rev-i3', roleId: 't-rev', roleLabel: 'Reviewer', instance: 3, startedAt: ago(5) },
      { id: 'c', agentId: 't-dev-i7', roleId: 't-dev', roleLabel: 'Developer', instance: 7, startedAt: ago(2) },
    ],
    pools: [
      { agentId: 't-rev', roleId: 'rev', label: 'Reviewer', busy: 1, capacity: 3 },
      { agentId: 't-dev', roleId: 'dev', label: 'Developer', busy: 2, capacity: 3 },
    ],
  }, NOW);
  assert.deepEqual(v.sessions, []);
  assert.deepEqual(v.pools.map((p) => [p.label, p.instances.map((s) => s.id)]), [
    ['Reviewer', ['b']],
    ['Developer', ['a', 'c']],
  ]);
});

test('groupWorkingNow: instance lines keep their content and chat link (AC3)', () => {
  const v = boardView({
    repos: ['o/r'],
    sessions: [{ id: 'a', agentId: 't-dev-i7', roleId: 't-dev', roleLabel: 'Developer', instance: 7, issue: { repo: 'o/r', number: 7 }, title: 'Fix it', startedAt: ago(3) }],
    pools: [{ agentId: 't-dev', roleId: 'dev', label: 'Developer', busy: 1, capacity: 3 }],
  }, NOW);
  const s = v.pools[0].instances[0];
  assert.deepEqual(s, sessionView({ id: 'a', agentId: 't-dev-i7', roleId: 't-dev', roleLabel: 'Developer', instance: 7, issue: { repo: 'o/r', number: 7 }, title: 'Fix it', startedAt: ago(3) }, { now: NOW }));
  assert.equal(s.chat.to, '/chats/t-dev-i7');
  assert.equal(s.instance, '#7');
});

test('groupWorkingNow: idle pools have no children; non-pooled and unmatched runs stay top level (AC4, AC5, AC6)', () => {
  const v = boardView({
    sessions: [
      { id: 'plain', agentId: 't-po', roleId: 't-po', roleLabel: 'PO' },
      { id: 'orphan', agentId: 't-qa-i4', roleId: 't-qa', roleLabel: 'QA', instance: 4 },
      { id: 'noRole', agentId: 't-x', roleLabel: 'X' },
    ],
    pools: [{ agentId: 't-dev', roleId: 'dev', label: 'Developer', busy: 0, capacity: 3, state: 'paused' }],
  }, NOW);
  assert.deepEqual(v.sessions.map((s) => s.id), ['plain', 'orphan', 'noRole']);
  assert.deepEqual(v.pools[0].instances, []);
  assert.equal(v.pools[0].stateText, 'Paused');
});

test('groupWorkingNow: a draining pool keeps its finishing instances and its badge; no run is lost or doubled', () => {
  const sessions = [
    { id: 'a', roleId: 't-dev', role: 'Developer' },
    { id: 'b', roleId: 't-po', role: 'PO' },
  ];
  const pools = [poolView({ agentId: 't-dev', roleId: 'dev', label: 'Developer', busy: 1, state: 'draining' })];
  const g = groupWorkingNow(sessions, pools);
  assert.equal(g.pools[0].stateText, 'Draining, 1 still running');
  const all = [...g.sessions, ...g.pools.flatMap((p) => p.instances)].map((s) => s.id).sort();
  assert.deepEqual(all, ['a', 'b']);
  assert.deepEqual(groupWorkingNow(undefined, undefined), { sessions: [], pools: [] });
});

test('help topic says pooled instances are listed beneath their role (AC8)', () => {
  const md = fs.readFileSync(HELP_TOPIC, 'utf8');
  const section = md.split('## Who is working right now')[1].split('\n## ')[0];
  assert.match(section, /indented directly beneath/);
});

test('Wake again copy: dialog title, target line and the notice after a click (#2873)', () => {
  assert.equal(wakeDialogTitle('#2813'), 'Wake the agent for #2813 again?');
  assert.equal(wakeDialogTitle(''), 'Wake the agent again?');
  assert.match(WAKE_CONFIRM_TEXT, /no label is changed/);
  assert.match(WAKE_CONFIRM_TEXT, /own instance/);
  assert.match(WAKE_CONFIRM_TEXT, /readiness gate/);
  assert.equal(
    wakeTargetText({ ref: 'PR #2844', label: 'ready-for-review-prod', roles: [{ id: 'a', label: 'Code Reviewer' }, { id: 'b' }] }),
    'Wake Code Reviewer and b for PR #2844 (ready-for-review-prod)',
  );
  assert.equal(
    wakeNotice({ woken: 1, results: [{ ok: true, delivered: 1, held: 0 }] }, '#2813'),
    'Wake delivered again for #2813 — its agent starts on its next check (within a few seconds).',
  );
  assert.equal(
    wakeNotice({ woken: 2, results: [{ ok: true, delivered: 0, held: 1 }] }, null),
    '2 wakes delivered again — its hand-off waits for CI first.',
  );
  assert.equal(wakeNotice({ woken: 0 }, '#1'), null);
  assert.equal(wakeNotice(null, '#1'), null);
});

test('help topic quotes the Wake again confirmation (#2873)', () => {
  const topic = fs.readFileSync(HELP_TOPIC, 'utf8').replace(/\s+/g, ' ');
  assert.ok(topic.includes(WAKE_CONFIRM_TEXT), 'flow-control.md must quote WAKE_CONFIRM_TEXT');
});
