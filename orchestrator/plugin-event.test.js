'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PLUGIN_EVENT_TRIGGER_TYPE,
  PLUGIN_EVENT_PENDING_KIND,
  SUMMARY_MAX,
  clampSummary,
  validatePluginEventRequest,
  matchesPluginEventTrigger,
  resolvePluginEventTargets,
  buildPluginEventEntry,
  buildPluginEventLogEvent,
} = require('./plugin-event');

// ── validatePluginEventRequest ─────────────────────────────────────────────

test('validate: event is required; summary/eventId/payload optional and type-checked', () => {
  assert.equal(validatePluginEventRequest(null).ok, false);
  assert.equal(validatePluginEventRequest({}).ok, false);
  assert.equal(validatePluginEventRequest({ event: '  ' }).ok, false);

  const r = validatePluginEventRequest({ event: ' status_changed ', summary: ' hi ', eventId: 'PROJ-1:9', payload: { a: 1 } });
  assert.deepEqual(r.value, { event: 'status_changed', summary: 'hi', eventId: 'PROJ-1:9', payload: { a: 1 } });

  assert.equal(validatePluginEventRequest({ event: 'x', summary: 5 }).ok, false);
  assert.equal(validatePluginEventRequest({ event: 'x', payload: [1, 2] }).ok, false);
  assert.equal(validatePluginEventRequest({ event: 'x', eventId: 7 }).ok, false);

  // An explicit null for an optional key is accepted like an omitted one — the
  // Jira broker sends `eventId: null` for a burst digest (would 400 otherwise).
  const nulls = validatePluginEventRequest({ event: 'x', summary: null, eventId: null, payload: null });
  assert.equal(nulls.ok, true);
  assert.deepEqual(nulls.value, { event: 'x', summary: '', eventId: null, payload: null });
});

test('clampSummary: truncates at SUMMARY_MAX code points with an ellipsis', () => {
  assert.equal(clampSummary('short'), 'short');
  const long = 'x'.repeat(SUMMARY_MAX + 50);
  const clamped = clampSummary(long);
  assert.equal(Array.from(clamped).length, SUMMARY_MAX);
  assert.ok(clamped.endsWith('…'));
});

// ── matchesPluginEventTrigger ──────────────────────────────────────────────

const T = (over = {}) => ({ id: 't1', type: PLUGIN_EVENT_TRIGGER_TYPE, pluginId: 'jira', prompt: 'do it', ...over });

test('match: type + pluginId + enabled; eventFilter empty matches any, else exact', () => {
  assert.equal(matchesPluginEventTrigger(T(), { pluginId: 'jira', event: 'status_changed' }), true);          // no filter → any
  assert.equal(matchesPluginEventTrigger(T({ eventFilter: 'status_changed' }), { pluginId: 'jira', event: 'status_changed' }), true);
  assert.equal(matchesPluginEventTrigger(T({ eventFilter: 'status_changed' }), { pluginId: 'jira', event: 'commented' }), false);
  assert.equal(matchesPluginEventTrigger(T({ pluginId: 'other' }), { pluginId: 'jira', event: 'x' }), false);
  assert.equal(matchesPluginEventTrigger(T({ enabled: false }), { pluginId: 'jira', event: 'x' }), false);
  assert.equal(matchesPluginEventTrigger({ type: 'github-event', pluginId: 'jira' }, { pluginId: 'jira', event: 'x' }), false);
});

// ── resolvePluginEventTargets ──────────────────────────────────────────────

test('resolve: only in-scope + granted agents with a matching trigger; first match per agent', () => {
  const agents = [
    { agentId: 'a1', inScope: true, granted: true, triggers: [T({ id: 'x1', eventFilter: 'status_changed' })] },
    { agentId: 'a2', inScope: true, granted: false, triggers: [T({ id: 'x2' })] },              // not granted
    { agentId: 'a3', inScope: false, granted: true, triggers: [T({ id: 'x3' })] },              // wrong scope
    { agentId: 'a4', inScope: true, granted: true, triggers: [T({ id: 'x4', eventFilter: 'commented' })] }, // filter miss
    { agentId: 'a5', inScope: true, granted: true, triggers: [
      T({ id: 'first', eventFilter: 'status_changed' }), T({ id: 'second' }),
    ] },
  ];
  const targets = resolvePluginEventTargets({ pluginId: 'jira', event: 'status_changed' }, agents);
  assert.deepEqual(targets, [
    { agentId: 'a1', triggerId: 'x1' },
    { agentId: 'a5', triggerId: 'first' },
  ]);
});

// ── buildPluginEventEntry ──────────────────────────────────────────────────

test('entry: kind + source + only the fields that are present', () => {
  assert.deepEqual(
    buildPluginEventEntry({ pluginId: 'jira', event: 'status_changed', triggerId: 't1' }),
    { kind: PLUGIN_EVENT_PENDING_KIND, source: 'internal-plugin', pluginId: 'jira', event: 'status_changed', triggerId: 't1' },
  );
  const full = buildPluginEventEntry({ pluginId: 'jira', event: 'e', summary: 's', payload: { x: 1 }, eventId: 'E-1', triggerId: 't' });
  assert.equal(full.summary, 's');
  assert.deepEqual(full.payload, { x: 1 });
  assert.equal(full.eventId, 'E-1');
});

test('log event: plugin actor, no repo, event in the action slot', () => {
  const e = buildPluginEventLogEvent({ pluginId: 'jira', event: 'status_changed', summary: 'PROJ-1', eventId: 'E-1', now: 'T' });
  assert.equal(e.actor.login, 'plugin:jira');
  assert.equal(e.repo.name, null);
  assert.equal(e.payload.action, 'status_changed');
  assert.equal(e.id, 'E-1');
});
