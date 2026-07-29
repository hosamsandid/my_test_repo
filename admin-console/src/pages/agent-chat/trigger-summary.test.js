import test from 'node:test';
import assert from 'node:assert/strict';

import {
  eventLabel,
  eventsAreLabelFilterable,
  summarizeGithubEventTrigger,
  summarizeLoopTrigger,
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

test('summarizeLoopTrigger: budget + until + verifier joined with · (concept §4.5)', () => {
  const s = summarizeLoopTrigger({
    type: 'loop',
    maxIterations: 25,
    until: { command: 'npm test' },
    verify: { agentId: 'team-x-code-reviewer' },
  });
  assert.equal(s, '≤25 iter · until: npm test · ✓ team-x-code-reviewer');
});

test('summarizeLoopTrigger: compacts a token budget (2M / 500k) and prefers agentId over command', () => {
  assert.equal(
    summarizeLoopTrigger({ maxIterations: 10, maxTokens: 2_000_000 }),
    '≤10 iter · ≤2M tok',
  );
  assert.equal(
    summarizeLoopTrigger({ maxIterations: 3, maxTokens: 500_000 }),
    '≤3 iter · ≤500k tok',
  );
  // agentId wins when both are (unusually) present
  assert.equal(
    summarizeLoopTrigger({ maxIterations: 1, verify: { command: 'x', agentId: 'rev' } }),
    '≤1 iter · ✓ rev',
  );
});

test('summarizeLoopTrigger: command-form verifier and bare loop fallback', () => {
  assert.equal(
    summarizeLoopTrigger({ maxIterations: 5, verify: { command: 'npm run lint' } }),
    '≤5 iter · ✓ npm run lint',
  );
  // No usable fields → never blank
  assert.equal(summarizeLoopTrigger({ type: 'loop' }), 'loop');
  assert.equal(summarizeLoopTrigger({}), 'loop');
  assert.equal(summarizeLoopTrigger(null), 'loop');
});
