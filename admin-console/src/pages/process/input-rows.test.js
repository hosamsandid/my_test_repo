import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionTriggers, isDerivedTrigger, scheduleText } from './input-rows.js';

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
});
