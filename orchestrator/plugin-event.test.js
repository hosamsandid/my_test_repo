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
  normalizePayloadFilter,
  matchesPayloadFilter,
  projectPayloadForTrigger,
  resolvePluginEventDeliveries,
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

// ── payloadFilter ──────────────────────────────────────────────────────────

test('normalizePayloadFilter: trims keys/values, drops blanks and non-strings, null when empty', () => {
  assert.equal(normalizePayloadFilter(undefined), null);
  assert.equal(normalizePayloadFilter(null), null);
  assert.equal(normalizePayloadFilter('x'), null);
  assert.equal(normalizePayloadFilter([]), null);
  assert.equal(normalizePayloadFilter({}), null);
  assert.equal(normalizePayloadFilter({ toStatus: '  ' }), null);
  assert.equal(normalizePayloadFilter({ toStatus: 5 }), null);            // non-string value is not a filter
  assert.deepEqual(normalizePayloadFilter({ ' toStatus ': ' Ready for Dev ', x: '' }), { toStatus: 'Ready for Dev' });
});

test('matchesPayloadFilter: no filter matches anything; every key must equal a top-level STRING field exactly', () => {
  assert.equal(matchesPayloadFilter(null, null), true);
  assert.equal(matchesPayloadFilter({}, { toStatus: 'x' }), true);
  const f = { toStatus: 'Ready for Dev' };
  assert.equal(matchesPayloadFilter(f, { toStatus: 'Ready for Dev' }), true);
  assert.equal(matchesPayloadFilter(f, { toStatus: 'ready for dev' }), false);   // case-sensitive, the labelFilter rule
  assert.equal(matchesPayloadFilter(f, { toStatus: 'In Progress' }), false);
  assert.equal(matchesPayloadFilter(f, {}), false);
  assert.equal(matchesPayloadFilter(f, null), false);                          // a filter with no payload cannot match
  assert.equal(matchesPayloadFilter(f, { toStatus: { name: 'Ready for Dev' } }), false); // only string fields compare
  assert.equal(matchesPayloadFilter({ toStatus: 'Ready for Dev', projectKey: 'KAN' }, { toStatus: 'Ready for Dev', projectKey: 'OPS' }), false);
  assert.equal(matchesPayloadFilter({ toStatus: 'Ready for Dev', projectKey: 'KAN' }, { toStatus: 'Ready for Dev', projectKey: 'KAN' }), true);
});

test('matchesPayloadFilter: a digest payload matches when ANY contained event matches', () => {
  const f = { toStatus: 'Ready for Dev' };
  const digest = { kind: 'digest', count: 2, events: [{ toStatus: 'In Progress' }, { toStatus: 'Ready for Dev' }] };
  assert.equal(matchesPayloadFilter(f, digest), true);
  assert.equal(matchesPayloadFilter(f, { kind: 'digest', count: 1, events: [{ toStatus: 'Done' }] }), false);
  assert.equal(matchesPayloadFilter(f, { kind: 'digest', count: 0, events: [] }), false);
});

test('match: payloadFilter gates the trigger; absent filter is byte-identical to today', () => {
  const ev = { pluginId: 'jira', event: 'status_changed', payload: { toStatus: 'Ready for Dev' } };
  assert.equal(matchesPluginEventTrigger(T(), ev), true);
  assert.equal(matchesPluginEventTrigger(T({ payloadFilter: { toStatus: 'Ready for Dev' } }), ev), true);
  assert.equal(matchesPluginEventTrigger(T({ payloadFilter: { toStatus: 'Done' } }), ev), false);
  // A filter on a trigger whose event does not match is still a miss.
  assert.equal(matchesPluginEventTrigger(T({ eventFilter: 'commented', payloadFilter: { toStatus: 'Ready for Dev' } }), ev), false);
  // A malformed filter (not an object) is treated as no filter, never as "match nothing".
  assert.equal(matchesPluginEventTrigger(T({ payloadFilter: 'Ready for Dev' }), ev), true);
});

test('resolve: two agents on the same plugin are routed apart by their payloadFilter', () => {
  const agents = [
    { agentId: 'ba', inScope: true, granted: true, triggers: [T({ id: 'ba-t', payloadFilter: { toStatus: 'Ready for Refinement' } })] },
    { agentId: 'dev', inScope: true, granted: true, triggers: [T({ id: 'dev-t', payloadFilter: { toStatus: 'Ready for Dev' } })] },
    { agentId: 'any', inScope: true, granted: true, triggers: [T({ id: 'any-t' })] },
  ];
  const targets = resolvePluginEventTargets(
    { pluginId: 'jira', event: 'status_changed', payload: { toStatus: 'Ready for Dev' } }, agents);
  assert.deepEqual(targets, [{ agentId: 'dev', triggerId: 'dev-t' }, { agentId: 'any', triggerId: 'any-t' }]);
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

// ── projectPayloadForTrigger ───────────────────────────────────────────────

const DIGEST = (events, extra = {}) => ({ kind: 'digest', count: events.length, events, ...extra });
const ev = (issueKey, toStatus) => ({ id: `${issueKey}:1`, issueKey, toStatus });

test('project: no payloadFilter → payload passes through untouched (same reference), projected null', () => {
  const d = DIGEST([ev('KAN-1', 'Ready for Dev'), ev('KAN-2', 'Done')]);
  const r = projectPayloadForTrigger(T(), d);
  assert.equal(r.payload, d);
  assert.equal(r.projected, null);
  // a non-digest payload is never projected either, filter or not
  const single = { id: 'KAN-9:1', toStatus: 'Ready for Dev' };
  assert.equal(projectPayloadForTrigger(T({ payloadFilter: { toStatus: 'Ready for Dev' } }), single).payload, single);
  assert.equal(projectPayloadForTrigger(T(), null).payload, null);
});

test('project: a digest is narrowed to the events matching THIS trigger; count recomputed; other fields copied', () => {
  const d = DIGEST(
    [ev('KAN-1', 'Ready for Refinement'), ev('KAN-2', 'Ready for Dev'), ev('KAN-3', 'Ready for Dev'), ev('KAN-4', 'Done')],
    { projectKey: 'KAN', truncated: true },
  );
  const r = projectPayloadForTrigger(T({ payloadFilter: { toStatus: 'Ready for Dev' } }), d);
  assert.deepEqual(r.payload, {
    kind: 'digest', projectKey: 'KAN', truncated: true, count: 2,
    events: [ev('KAN-2', 'Ready for Dev'), ev('KAN-3', 'Ready for Dev')],
  });
  assert.deepEqual(r.projected, { kept: 2, total: 4 });
  // the source digest is not mutated
  assert.equal(d.events.length, 4);
  assert.equal(d.count, 4);
});

test('project: when every inline event matches, the payload passes through byte-identical (count untouched)', () => {
  // The broker inlines the first 20 of 25 — `count: 25` must survive so the
  // "there are more" signal is not destroyed by a projection that removed nothing.
  const d = DIGEST(Array.from({ length: 20 }, (_, i) => ev(`KAN-${i}`, 'Ready for Dev')), { count: 25, truncated: true });
  const r = projectPayloadForTrigger(T({ payloadFilter: { toStatus: 'Ready for Dev' } }), d);
  assert.equal(r.payload, d);
  assert.equal(r.projected, null);
});

test('project: total is the digest count when it is an integer ≥ inline length, else the inline length', () => {
  const events = [ev('KAN-1', 'Ready for Dev'), ev('KAN-2', 'Done')];
  const t = T({ payloadFilter: { toStatus: 'Ready for Dev' } });
  assert.deepEqual(projectPayloadForTrigger(t, DIGEST(events, { count: 40 })).projected, { kept: 1, total: 40 });
  assert.deepEqual(projectPayloadForTrigger(t, DIGEST(events, { count: 'x' })).projected, { kept: 1, total: 2 });
  assert.deepEqual(projectPayloadForTrigger(t, DIGEST(events, { count: 1 })).projected, { kept: 1, total: 2 });
});

// ── resolvePluginEventDeliveries ───────────────────────────────────────────

test('deliveries: same targets as resolvePluginEventTargets, each with its own projected payload + summary', () => {
  const d = DIGEST(
    [ev('KAN-1', 'Ready for Refinement'), ev('KAN-2', 'Ready for Dev'), ev('KAN-3', 'Ready for Dev'), ev('KAN-4', 'Ready for Dev')],
    { projectKey: 'KAN' },
  );
  const agents = [
    { agentId: 'ba', inScope: true, granted: true, triggers: [T({ id: 'ba-t', payloadFilter: { toStatus: 'Ready for Refinement' } })] },
    { agentId: 'dev', inScope: true, granted: true, triggers: [T({ id: 'dev-t', payloadFilter: { toStatus: 'Ready for Dev' } })] },
    { agentId: 'any', inScope: true, granted: true, triggers: [T({ id: 'any-t' })] },
    { agentId: 'qa', inScope: true, granted: true, triggers: [T({ id: 'qa-t', payloadFilter: { toStatus: 'In Review' } })] },
    { agentId: 'other-team', inScope: false, granted: true, triggers: [T({ id: 'x' })] },
  ];
  const req = { pluginId: 'jira', event: 'status_changed', payload: d, summary: '4 status changes in KAN' };
  const out = resolvePluginEventDeliveries(req, agents);
  assert.deepEqual(out.map(({ agentId, triggerId }) => ({ agentId, triggerId })), resolvePluginEventTargets(req, agents));
  assert.deepEqual(out.map((o) => o.agentId), ['ba', 'dev', 'any']);

  const ba = out[0], dev = out[1], any = out[2];
  assert.deepEqual(ba.payload.events.map((e) => e.issueKey), ['KAN-1']);
  assert.equal(ba.payload.count, 1);
  assert.equal(ba.summary, '4 status changes in KAN — 1 of 4 match this trigger');
  assert.deepEqual(dev.payload.events.map((e) => e.issueKey), ['KAN-2', 'KAN-3', 'KAN-4']);
  assert.equal(dev.summary, '4 status changes in KAN — 3 of 4 match this trigger');
  // no filter → whole digest, original summary, same reference
  assert.equal(any.payload, d);
  assert.equal(any.summary, '4 status changes in KAN');
});

test('deliveries: a single (non-digest) event keeps payload + summary as sent', () => {
  const payload = { id: 'KAN-2:1', toStatus: 'Ready for Dev' };
  const agents = [{ agentId: 'dev', inScope: true, granted: true, triggers: [T({ id: 'dev-t', payloadFilter: { toStatus: 'Ready for Dev' } })] }];
  const [o] = resolvePluginEventDeliveries({ pluginId: 'jira', event: 'status_changed', payload, summary: 'KAN-2: To Do → Ready for Dev' }, agents);
  assert.equal(o.payload, payload);
  assert.equal(o.summary, 'KAN-2: To Do → Ready for Dev');
});

test('deliveries: an empty broker summary gets a standalone projected line; the suffix is re-clamped', () => {
  const d = DIGEST([ev('KAN-1', 'Ready for Dev'), ev('KAN-2', 'Done')]);
  const agents = [{ agentId: 'dev', inScope: true, granted: true, triggers: [T({ payloadFilter: { toStatus: 'Ready for Dev' } })] }];
  assert.equal(resolvePluginEventDeliveries({ pluginId: 'jira', event: 'e', payload: d, summary: '' }, agents)[0].summary,
    '1 of 2 events match this trigger');
  const long = 'x'.repeat(SUMMARY_MAX);
  const s = resolvePluginEventDeliveries({ pluginId: 'jira', event: 'e', payload: d, summary: long }, agents)[0].summary;
  assert.equal(Array.from(s).length, SUMMARY_MAX);
  assert.ok(s.endsWith('…'));
});
