import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionTriggers, isDerivedTrigger, scheduleText, derivedChannelTrigger } from './input-rows.js';

test('partitionTriggers separates manual from reconciler-derived triggers', () => {
  const triggers = [
    { id: 'a', type: 'cron', cron: '0 9 * * *' },
    { id: 'b', type: 'github-event', events: ['pull_request.opened'], channel: true },
    { id: 'c', type: 'github-event', events: ['push'], dataFlow: true },
    { id: 'd', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready' },
    null,
    'not-an-object',
  ];
  const { manual, derived } = partitionTriggers(triggers);
  assert.deepEqual(manual.map(t => t.id), ['a', 'd']);
  assert.deepEqual(derived.map(t => t.id), ['b', 'c']);
});

test('partitionTriggers tolerates non-array input', () => {
  assert.deepEqual(partitionTriggers(undefined), { manual: [], derived: [] });
  assert.deepEqual(partitionTriggers(null), { manual: [], derived: [] });
});

test('isDerivedTrigger only flags channel/dataFlow markers', () => {
  assert.equal(isDerivedTrigger({ channel: true }), true);
  assert.equal(isDerivedTrigger({ dataFlow: true }), true);
  assert.equal(isDerivedTrigger({ type: 'github-event' }), false);
  assert.equal(isDerivedTrigger(null), false);
});

test('scheduleText renders a plain-language sentence per type', () => {
  assert.equal(
    scheduleText({ type: 'cron', cron: '0 9 * * *' }),
    'On schedule — Every day at 09:00',
  );
  assert.equal(scheduleText({ type: 'once', at: '2026-08-01T09:00:00Z' }), 'Once at 2026-08-01T09:00:00Z');
  assert.equal(scheduleText({ type: 'http', id: 'hook1' }, 'dev-1'), 'Webhook — POST /hooks/dev-1/hook1');
  assert.equal(scheduleText({ type: 'http', id: 'hook1' }), 'Webhook (HTTP call)');
  assert.equal(
    scheduleText({ type: 'github-event', events: ['pull_request.opened'] }),
    'Wakes on PR opened',
  );
  assert.equal(
    scheduleText({ type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready' }),
    'Wakes on Issue labeled · label “ready”',
  );
  assert.equal(
    scheduleText({ type: 'jira-event', projectKey: 'ENG' }),
    'Wakes on status change in ENG',
  );
  assert.equal(
    scheduleText({ type: 'jira-event', projectKey: 'ENG', statusFilter: 'Ready for Dev' }),
    'Wakes on status change in ENG · to “Ready for Dev”',
  );
});

// ─── derivedChannelTrigger (#958) ────────────────────────────────────────────
// The channel row reads the claim back off the listener the backend derived,
// rather than re-deriving the `<wake>:wip` convention in the UI.

test('derivedChannelTrigger matches on (artifact, label), not on the channel from', () => {
  const derived = [
    { id: 'rev-on-pr-dev', channel: true, type: 'github-event',
      events: ['pull_request.labeled'], labelFilter: 'ready-for-test',
      claim: { remove: 'ready-for-test', add: 'ready-for-test:wip' } },
  ];
  // Consolidation (#826): several producers share ONE listener, so a channel
  // from a different producer still resolves to it.
  const t = derivedChannelTrigger(derived, { artifact: 'pr', from: 'someone-else', label: 'ready-for-test' });
  assert.equal(t.id, 'rev-on-pr-dev');
  assert.deepEqual(t.claim, { remove: 'ready-for-test', add: 'ready-for-test:wip' });
});

test('derivedChannelTrigger distinguishes the pr and issue event families', () => {
  const derived = [
    { id: 'on-pr', channel: true, events: ['pull_request.labeled'], labelFilter: 'go' },
    { id: 'on-issue', channel: true, events: ['issues.labeled'], labelFilter: 'go' },
  ];
  assert.equal(derivedChannelTrigger(derived, { artifact: 'pr', label: 'go' }).id, 'on-pr');
  assert.equal(derivedChannelTrigger(derived, { artifact: 'issue', label: 'go' }).id, 'on-issue');
});

test('derivedChannelTrigger returns null for an unlabelled channel or no match', () => {
  const derived = [{ id: 'on-pr', channel: true, events: ['pull_request.labeled'], labelFilter: 'go' }];
  assert.equal(derivedChannelTrigger(derived, { artifact: 'pr' }), null);         // "opened" channel
  assert.equal(derivedChannelTrigger(derived, { artifact: 'pr', label: '' }), null);
  assert.equal(derivedChannelTrigger(derived, { artifact: 'pr', label: 'other' }), null);
  assert.equal(derivedChannelTrigger([], { artifact: 'pr', label: 'go' }), null);
  assert.equal(derivedChannelTrigger(undefined, { artifact: 'pr', label: 'go' }), null);
  assert.equal(derivedChannelTrigger(derived, null), null);
});

test('derivedChannelTrigger ignores a hand-authored trigger with the same label', () => {
  // Only reconciler-owned (channel: true) listeners are derived from a port.
  const triggers = [{ id: 'mine', events: ['pull_request.labeled'], labelFilter: 'go' }];
  assert.equal(derivedChannelTrigger(triggers, { artifact: 'pr', label: 'go' }), null);
});
