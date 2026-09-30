import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REFIRABLE_REASONS,
  EVENT_RANGES,
  DEFAULT_EVENT_RANGE,
  rangeSince,
  hasGithubEventTrigger,
  dropReasonText,
  outcomeView,
  canRefire,
  sessionCorrelationId,
  workItemText,
  refireDialog,
  refiredText,
} from './agent-events-view.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const drop = (reason, extra = {}) => ({
  key: 'k', ts: '2026-09-28T10:00:00Z', eventId: '555', repo: 'org/repo', event: 'pull_request.labeled',
  label: 'ready-for-review', wakeLabel: 'ready-for-review', triggerId: 't1', status: 'dropped', reason,
  workItem: { kind: 'pr', number: 42, title: 'Add thing', url: 'https://github.com/org/repo/pull/42' },
  refired: null, twin: null, ...extra,
});

test('AC1: the tab is for agents with a GitHub-event trigger only', () => {
  assert.equal(hasGithubEventTrigger([{ type: 'cron' }, { type: 'github-event' }]), true);
  assert.equal(hasGithubEventTrigger([{ type: 'cron' }, { type: 'loop' }]), false);
  assert.equal(hasGithubEventTrigger(null), false);
});

test('AC2: time-range presets, default 24h, widest = 7-day retention', () => {
  assert.deepEqual(EVENT_RANGES.map(r => r.key), ['1h', '24h', '7d']);
  assert.equal(DEFAULT_EVENT_RANGE, '24h');
  const now = Date.parse('2026-09-29T00:00:00Z');
  assert.equal(rangeSince('1h', now), '2026-09-28T23:00:00.000Z');
  assert.equal(rangeSince('bogus', now), '2026-09-28T00:00:00.000Z');
});

test('AC3: every required drop reason reads as plain language, naming the ignored label', () => {
  for (const r of ['wake-already-armed', 'label-filter', 'throttle', 'internal-dedup', 'self-claim-label', 'history-horizon']) {
    const text = dropReasonText(drop(r));
    assert.ok(text.length > 20 && !text.startsWith('Dropped ('), `${r}: ${text}`);
  }
  assert.match(dropReasonText(drop('label-filter', { label: 'next-wave', wakeLabel: null })), /'next-wave'/);
  assert.match(dropReasonText(drop('self-claim-label', { label: 'ready:wip', wakeLabel: null })), /'ready:wip'/);
  assert.match(dropReasonText(drop('wake-already-armed')), /'ready-for-review'/);
  assert.equal(dropReasonText(drop('meteor')), 'Dropped (meteor).');
});

test('outcomeView distinguishes delivered / re-fired / digested / dropped', () => {
  assert.deepEqual(outcomeView({ status: 'delivered' }), { tone: 'success', text: 'delivered' });
  assert.equal(outcomeView({ status: 'delivered', source: 'manual-refire' }).text, 'delivered (fired again)');
  assert.equal(outcomeView({ status: 'digest' }).text, 'digested');
  assert.deepEqual(outcomeView(drop('throttle')), { tone: 'warning', text: 'dropped · throttle' });
  assert.equal(outcomeView(drop('label-filter')).tone, 'muted');
});

test('AC4: only delivered rows link to their session, by the runner correlationId', () => {
  assert.equal(sessionCorrelationId({ status: 'delivered', triggerId: 't1', eventId: 'refire:ab' }), 'trigger:t1:gh:refire:ab');
  assert.equal(sessionCorrelationId(drop('throttle')), null);
});

test('AC5/AC7: Fire again is offered only on the three protection drops, to a manager, once', () => {
  assert.deepEqual([...REFIRABLE_REASONS], ['wake-already-armed', 'throttle', 'internal-dedup']);
  for (const r of REFIRABLE_REASONS) assert.equal(canRefire(drop(r), { canManage: true }), true, r);
  for (const r of ['label-filter', 'self-claim-label', 'history-horizon', 'push-duplicate']) {
    assert.equal(canRefire(drop(r), { canManage: true }), false, r);
  }
  assert.equal(canRefire(drop('throttle'), { canManage: false }), false, 'read-only for a member');
  assert.equal(canRefire(drop('throttle'), {}), false);
  assert.equal(canRefire(drop('throttle', { refired: { eventId: 'refire:x', by: 'ana', at: 't' } }), { canManage: true }), false);
  assert.equal(canRefire(drop('throttle', { workItem: null }), { canManage: true }), false);
  assert.equal(canRefire({ ...drop('throttle'), status: 'delivered' }, { canManage: true }), false);
});

test('AC5a: the dialog names the reason; internal-dedup says "already processed once" and links the twin', () => {
  assert.match(refireDialog(drop('wake-already-armed')).why, /already been woken for 'ready-for-review' on #42 Add thing/);
  assert.match(refireDialog(drop('throttle')).why, /rate cap/);
  const d = refireDialog(drop('internal-dedup', { twin: { eventId: 'label-fastpath:x', triggerId: 't1', ts: '2026-09-28T09:00:00Z' } }));
  assert.match(d.why, /already processed once/);
  assert.deepEqual(d.twin, { correlationId: 'trigger:t1:gh:label-fastpath:x', ts: '2026-09-28T09:00:00Z' });
  assert.equal(refireDialog(drop('internal-dedup')).twin, null, 'twin unknown → no link');
  assert.equal(refireDialog(drop('throttle', { twin: { eventId: 'x', triggerId: 't1' } })).twin, null);
  assert.match(refireDialog(drop('throttle')).what, /same trigger prompt/);
});

test('AC6: a re-fired row says who and when', () => {
  assert.equal(refiredText(drop('throttle', { refired: { eventId: 'r', by: 'ana', at: 'T' } })), 'Fired again by ana · T');
  assert.equal(refiredText(drop('throttle')), '');
  assert.equal(workItemText(drop('throttle')), '#42 Add thing');
  assert.equal(workItemText({ workItem: { number: 3 } }), '#3');
});

// ── Drift guard: JSX wiring (JSX itself is not executed under node:test) ────

const RAIL = fs.readFileSync(path.join(HERE, 'RightRail.jsx'), 'utf8');
const PANEL = fs.readFileSync(path.join(HERE, 'EventsPanel.jsx'), 'utf8');

test('RightRail registers the Events tab, gated on a GitHub-event trigger', () => {
  assert.match(RAIL, /const TAB_KEYS = \[[^\]]*'events'/);
  assert.match(RAIL, /\.\.\.\(showEvents \? \[\{ key: 'events',[^\n]*label: 'Events'/);
  assert.match(RAIL, /hasGithubEventTrigger\(triggers\)/);
  assert.match(RAIL, /hasEventTrigger === false && tab === 'events'/, 'a hidden persisted Events tab falls back');
  assert.match(RAIL, /<EventsPanel agentId=\{agentId\} active=\{effectiveTab === 'events'\} canManage=\{agentCanManage\} \/>/);
});

test('EventsPanel reads the agent-scoped endpoint and gates Fire again on canRefire', () => {
  assert.match(PANEL, /`\/api\/agents\/\$\{encodeURIComponent\(id\)\}\/github-events\?since=/);
  assert.match(PANEL, /apiCall\('POST', `\/api\/agents\/\$\{encodeURIComponent\(agentId\)\}\/github-events\/refire`/);
  assert.match(PANEL, /\{canRefire\(row, \{ canManage \}\) && \(/);
  assert.match(PANEL, /inFlightRef\.current\) return;/, 'double-click guard');
  assert.match(PANEL, /\?session=\$\{encodeURIComponent\(correlationId\)\}/);
});

test('#2571 AC8: a producer-filter drop names who pushed, or says the producer is unknown; never re-firable', () => {
  assert.match(dropReasonText({ ...drop('producer-filter'), producer: 't1-review' }), /^Pushed by `t1-review`, not in producer filter/);
  assert.match(dropReasonText({ ...drop('producer-filter'), producer: null }), /^Producer unknown/);
  assert.equal(canRefire(drop('producer-filter'), { canManage: true }), false);
});

test('#2570: a branch-filter drop names the pushed branch (or tag) in plain language', () => {
  assert.equal(dropReasonText(drop('branch-filter', { ref: 'refs/heads/agent-knowledge' })),
    "Branch 'agent-knowledge' is not in this trigger's branch filter, so the push was ignored.");
  assert.match(dropReasonText(drop('branch-filter', { ref: 'refs/tags/v1.2' })), /^Tag 'v1\.2' is not/);
  assert.match(dropReasonText(drop('branch-filter', {})), /^This branch is not/);
  assert.equal(canRefire(drop('branch-filter'), { canManage: true }), false);
});

test('#2602 AC4: a knowledge-branch drop names the KB branch and is never re-firable', () => {
  assert.equal(dropReasonText(drop('knowledge-branch', { ref: 'refs/heads/agent-knowledge' })),
    "Branch 'agent-knowledge' is a knowledge-base branch — pushes to it never wake push triggers.");
  assert.doesNotMatch(dropReasonText(drop('knowledge-branch', {})), /branch filter/);
  assert.equal(canRefire(drop('knowledge-branch'), { canManage: true }), false);
});
