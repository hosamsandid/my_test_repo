// #2535: every event key the GitHub poller can write to the Event Log reads in
// plain language, without adding anything to the trigger editor's event list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  eventLabel,
  eventFilterText,
  GITHUB_EVENT_OPTIONS,
  INTERNAL_EVENT_LABELS,
  DISPLAY_EVENT_LABELS,
} from './agent-chat/trigger-summary.js';
import { columnFilterText, rowMatchesFilter } from '../components/data-table-view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const POLLER_SRC = path.join(here, '..', '..', '..', 'orchestrator', 'github-poller.js');
const EVENT_LOG_JSX = path.join(here, 'GithubEventLog.jsx');

// The poller's `TYPE_KEY` bases × the actions the GitHub Events API documents
// for each type (a base with no action is keyed on its own), plus the event
// types it keys by their lower-cased type name because TYPE_KEY lacks them.
const POLLER_EVENT_KEYS = [
  'push',
  'pull_request.opened', 'pull_request.edited', 'pull_request.closed', 'pull_request.merged',
  'pull_request.reopened', 'pull_request.assigned', 'pull_request.unassigned',
  'pull_request.review_requested', 'pull_request.review_request_removed',
  'pull_request.labeled', 'pull_request.unlabeled', 'pull_request.synchronize',
  'pull_request_review.created',
  'pull_request_review_comment.created',
  'issue_comment.created', 'issue_comment.edited', 'issue_comment.deleted',
  'issues.opened', 'issues.edited', 'issues.closed', 'issues.reopened',
  'issues.assigned', 'issues.unassigned', 'issues.labeled', 'issues.unlabeled',
  'create',
  'delete',
  'release.published', 'release.created', 'release.edited', 'release.prereleased',
  'release.released', 'release.unpublished', 'release.deleted',
  'fork',
  'watch.started',
  'commit_comment.created',
  'member.added', 'public', 'gollum',
];

test('AC1: pull_request_review.created shows a plain-language name', () => {
  assert.equal(eventLabel('pull_request_review.created'), 'PR review submitted');
});

test('AC2: every event key the poller can produce has a plain-language label', () => {
  for (const key of POLLER_EVENT_KEYS) {
    const label = eventLabel(key);
    assert.notEqual(label, key, `${key} falls back to its raw key`);
    assert.ok(label.trim(), `${key} renders blank`);
  }
});

test('AC2 drift guard: the key list covers every TYPE_KEY base in the poller', () => {
  const src = fs.readFileSync(POLLER_SRC, 'utf8');
  const block = src.match(/const TYPE_KEY = \{([\s\S]*?)\};/);
  assert.ok(block, 'TYPE_KEY not found in orchestrator/github-poller.js');
  const bases = [...block[1].matchAll(/:\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(bases.length >= 12, 'TYPE_KEY parse looks wrong');
  for (const base of bases) {
    assert.ok(
      POLLER_EVENT_KEYS.some(k => k === base || k.startsWith(`${base}.`)),
      `TYPE_KEY base "${base}" has no keys in POLLER_EVENT_KEYS — add its actions and labels`,
    );
  }
});

test('AC3: unknown or hand-edited keys still fall back to the raw key', () => {
  assert.equal(eventLabel('some.future_event'), 'some.future_event');
  assert.equal(eventLabel('pull_request_review.dismissed'), 'pull_request_review.dismissed');
  assert.equal(eventLabel('custom'), 'custom');
});

test('AC4: the trigger editor\'s selectable event list is unchanged', () => {
  assert.deepEqual(GITHUB_EVENT_OPTIONS.map(o => o.value), [
    'push',
    'pull_request.opened',
    'pull_request.closed',
    'pull_request.merged',
    'pull_request.reopened',
    'pull_request.labeled',
    'pull_request.unlabeled',
    'pull_request_review.submitted',
    'pull_request_review_comment.created',
    'issue_comment.created',
    'issues.opened',
    'issues.closed',
    'issues.labeled',
    'issues.unlabeled',
    'release.published',
  ]);
  for (const key of DISPLAY_EVENT_LABELS.keys()) {
    assert.equal(GITHUB_EVENT_OPTIONS.some(o => o.value === key), false, `${key} leaked into the editor`);
  }
});

test('internal keys keep their existing labels', () => {
  assert.equal(eventLabel('handoff.wake'), 'direct hand-off');
  assert.equal(eventLabel('plugin.event'), 'plugin event');
  for (const key of INTERNAL_EVENT_LABELS.keys()) assert.equal(DISPLAY_EVENT_LABELS.has(key), false);
});

test('display-only labels never shadow a selectable one', () => {
  for (const o of GITHUB_EVENT_OPTIONS) assert.equal(DISPLAY_EVENT_LABELS.has(o.value), false, o.value);
});

test('AC5: the Event column search matches both the friendly name and the raw key', () => {
  const eventCol = { key: 'event', filterValue: eventFilterText };
  const rows = [
    { event: 'pull_request_review.created' },
    { event: 'issues.labeled' },
  ];
  const hits = (q) => rows.filter(r => rowMatchesFilter(r, [eventCol], q)).map(r => r.event);
  assert.deepEqual(hits('PR review submitted'), ['pull_request_review.created']);
  assert.deepEqual(hits('pull_request_review.created'), ['pull_request_review.created']);
  assert.deepEqual(hits('Issue labeled'), ['issues.labeled']);
});

test('eventFilterText: unknown key is not duplicated; nullish is empty', () => {
  assert.equal(eventFilterText('some.future_event'), 'some.future_event');
  assert.equal(eventFilterText('push'), 'Push push');
  assert.equal(eventFilterText(undefined), '');
  assert.equal(columnFilterText({ key: 'event', filterValue: eventFilterText }, { event: null }), '');
});

test('AC5 wiring: the Event Log\'s Event column searches via eventFilterText', () => {
  const jsx = fs.readFileSync(EVENT_LOG_JSX, 'utf8');
  const start = jsx.indexOf("{ key: 'event', label: 'Event'");
  const end = jsx.indexOf("{ key: 'actor'", start);
  assert.ok(start >= 0 && end > start, 'Event column not found in GithubEventLog.jsx');
  assert.match(jsx.slice(start, end), /filterValue:\s*eventFilterText\b/);
});
