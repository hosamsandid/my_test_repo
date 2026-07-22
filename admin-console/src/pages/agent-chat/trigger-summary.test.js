import test from 'node:test';
import assert from 'node:assert/strict';

import {
  eventLabel,
  eventsAreLabelFilterable,
  summarizeGithubEventTrigger,
  GITHUB_EVENT_OPTIONS,
  LABEL_FILTERABLE_EVENTS,
} from './trigger-summary.js';

test('eventLabel: maps a known dotted key to its friendly label (AC1)', () => {
  assert.equal(eventLabel('issues.labeled'), 'Issue labeled');
  assert.equal(eventLabel('pull_request.merged'), 'PR merged');
  assert.equal(eventLabel('push'), 'Push');
});

test('eventLabel: unknown key falls back to the raw key, never blank (edge case)', () => {
  assert.equal(eventLabel('some.future_event'), 'some.future_event');
});

test('eventLabel: empty/nullish input yields empty string', () => {
  assert.equal(eventLabel(''), '');
  assert.equal(eventLabel(undefined), '');
  assert.equal(eventLabel(null), '');
});

test('eventsAreLabelFilterable: true only for label-carrying events', () => {
  assert.equal(eventsAreLabelFilterable(['issues.labeled']), true);
  assert.equal(eventsAreLabelFilterable(['pull_request.unlabeled']), true);
  assert.equal(eventsAreLabelFilterable(['issues.opened']), false);
  assert.equal(eventsAreLabelFilterable(['push']), false);
  assert.equal(eventsAreLabelFilterable([]), false);
  assert.equal(eventsAreLabelFilterable(undefined), false);
});

test('summarize: friendly event + required label for a labeled trigger (AC1/AC2)', () => {
  const s = summarizeGithubEventTrigger({ events: ['issues.labeled'], labelFilter: 'Dispatch' });
  assert.deepEqual(s.events, ['Issue labeled']);
  assert.equal(s.label, 'Dispatch');
});

test('summarize: no labelFilter → event only, no dangling label (AC4)', () => {
  const s = summarizeGithubEventTrigger({ events: ['issues.opened'] });
  assert.deepEqual(s.events, ['Issue opened']);
  assert.equal(s.label, null);
});

test('summarize: stale labelFilter on a non-filterable event is suppressed (AC5)', () => {
  const s = summarizeGithubEventTrigger({ events: ['issues.opened'], labelFilter: 'Dispatch' });
  assert.deepEqual(s.events, ['Issue opened']);
  assert.equal(s.label, null);
});

test('summarize: multiple events render gracefully as friendly labels (edge case)', () => {
  const s = summarizeGithubEventTrigger({
    events: ['issues.labeled', 'pull_request.labeled'],
    labelFilter: 'ready',
  });
  assert.deepEqual(s.events, ['Issue labeled', 'PR labeled']);
  assert.equal(s.label, 'ready');
});

test('summarize: unknown event key kept raw among the events (edge case)', () => {
  const s = summarizeGithubEventTrigger({ events: ['issues.labeled', 'weird.event'] });
  assert.deepEqual(s.events, ['Issue labeled', 'weird.event']);
});

test('summarize: missing/empty events → empty list, no crash (edge case)', () => {
  assert.deepEqual(summarizeGithubEventTrigger({}).events, []);
  assert.deepEqual(summarizeGithubEventTrigger({ events: null }).events, []);
  assert.deepEqual(summarizeGithubEventTrigger(undefined).events, []);
});

test('summarize: label shown when at least one of several events is filterable', () => {
  const s = summarizeGithubEventTrigger({
    events: ['push', 'issues.labeled'],
    labelFilter: 'Dispatch',
  });
  assert.equal(s.label, 'Dispatch');
});

test('constants: options and filterable set are consistent with the map', () => {
  assert.ok(GITHUB_EVENT_OPTIONS.length > 0);
  for (const key of LABEL_FILTERABLE_EVENTS) {
    assert.ok(
      GITHUB_EVENT_OPTIONS.some(o => o.value === key),
      `${key} should be a known event option`,
    );
  }
});
