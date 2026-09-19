import test from 'node:test';
import assert from 'node:assert/strict';

import {
  eventLabel,
  eventsAreLabelFilterable,
  summarizeGithubEventTrigger,
  summarizeLoopTrigger,
  claimBodyFor,
  transportBodyFor,
  summarizeLoopEdge,
  hasClaim,
  summarizeClaimEdge,
  claimTooltip,
  isLaunchedLoop,
  isStandingSubscription,
  CLAIM_MARKER,
  GITHUB_EVENT_OPTIONS,
  LABEL_FILTERABLE_EVENTS,
  INTERNAL_EVENT_LABELS,
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

test('summarizeLoopTrigger: flow hand-off verifier renders "→ flow"', () => {
  assert.equal(
    summarizeLoopTrigger({ maxIterations: 10, verify: { flow: true } }),
    '≤10 iter · → flow',
  );
});

test('summarizeLoopEdge: budget + until + agent verifier from the redacted edge summary (#936 AC2)', () => {
  // The graph-edge summary carries verify as { mode, agentId? } — never the
  // raw command string (redacted by process-graph triggerView).
  const s = summarizeLoopEdge({
    maxIterations: 25,
    until: { command: 'npm test' },
    verify: { mode: 'agent', agentId: 'team-x-code-reviewer' },
  });
  assert.equal(s, '≤25 iter · until: npm test · ✓ team-x-code-reviewer');
});

test('summarizeLoopEdge: command verifier renders "✓ check" (no command string leaks)', () => {
  const s = summarizeLoopEdge({ maxIterations: 10, maxTokens: 2_000_000, verify: { mode: 'command' } });
  assert.equal(s, '≤10 iter · ≤2M tok · ✓ check');
});

test('summarizeLoopEdge: self-graded verifier renders "✓ self"; token budget compacts (500k)', () => {
  assert.equal(
    summarizeLoopEdge({ maxIterations: 3, maxTokens: 500_000, verify: { mode: 'self-graded' } }),
    '≤3 iter · ≤500k tok · ✓ self',
  );
});

test('summarizeLoopEdge: flow hand-off verifier renders "→ flow"', () => {
  assert.equal(
    summarizeLoopEdge({ maxIterations: 10, verify: { mode: 'flow' } }),
    '≤10 iter · → flow',
  );
});

test('summarizeLoopEdge: missing/blank summary never blank (edge case)', () => {
  assert.equal(summarizeLoopEdge({ maxIterations: 5 }), '≤5 iter');
  assert.equal(summarizeLoopEdge({}), 'loop');
  assert.equal(summarizeLoopEdge(null), 'loop');
  assert.equal(summarizeLoopEdge(undefined), 'loop');
});

// ─── claim labels (#958) ─────────────────────────────────────────────────────

test('hasClaim accepts only a well-formed claim blob', () => {
  assert.equal(hasClaim({ remove: 'ready', add: 'ready:wip' }), true);
  assert.equal(hasClaim(null), false);
  assert.equal(hasClaim(undefined), false);
  assert.equal(hasClaim({ remove: 'ready' }), false);
  assert.equal(hasClaim({ add: 'ready:wip' }), false);
  assert.equal(hasClaim({ remove: '', add: 'ready:wip' }), false);
  assert.equal(hasClaim('ready:wip'), false);
});

test('summarizeClaimEdge abbreviates a conventional claim to its suffix', () => {
  // `ready` is already on the chip, so the badge shows only what is added.
  assert.equal(summarizeClaimEdge({ remove: 'ready', add: 'ready:wip' }), `${CLAIM_MARKER} wip`);
  assert.equal(summarizeClaimEdge({ remove: 'ready-2', add: 'ready-2:wip' }), `${CLAIM_MARKER} wip`);
});

test('summarizeClaimEdge shows a non-conventional claim whole rather than mis-abbreviating', () => {
  assert.equal(summarizeClaimEdge({ remove: 'ready', add: 'in-progress' }), `${CLAIM_MARKER} in-progress`);
});

test('summarizeClaimEdge is blank when there is no claim (no stray badge)', () => {
  assert.equal(summarizeClaimEdge(null), '');
  assert.equal(summarizeClaimEdge(undefined), '');
  assert.equal(summarizeClaimEdge({ remove: 'ready' }), '');
});

test('claimTooltip spells the swap out in full', () => {
  assert.equal(claimTooltip({ remove: 'ready', add: 'ready:wip' }),
    'Claims the label when it wakes: ready → ready:wip');
  assert.equal(claimTooltip(null), '');
});

/* ── #1006: raw-layer claim stamping (claimBodyFor) ─────────────────────── */

test('claimBodyFor stamps the derived claim on claimed .labeled listeners', () => {
  assert.deepEqual(
    claimBodyFor({ labelFilter: 'ready', events: ['issues.labeled'], claimOn: true, isEdit: false }),
    { remove: 'ready', add: 'ready:wip' },
  );
  assert.deepEqual(
    claimBodyFor({ labelFilter: 'go', events: ['pull_request.labeled'], claimOn: true, isEdit: true }),
    { remove: 'go', add: 'go:wip' },
  );
});

test('claimBodyFor: opt-out preserved; unlabeled/raw events never claim', () => {
  // Opt-out on create → field omitted; on edit → explicit null clears.
  assert.equal(claimBodyFor({ labelFilter: 'x', events: ['issues.labeled'], claimOn: false, isEdit: false }), undefined);
  assert.equal(claimBodyFor({ labelFilter: 'x', events: ['issues.labeled'], claimOn: false, isEdit: true }), null);
  // An .unlabeled or raw event has no wake label to take over.
  assert.equal(claimBodyFor({ labelFilter: 'x', events: ['issues.unlabeled'], claimOn: true, isEdit: false }), undefined);
  assert.equal(claimBodyFor({ labelFilter: null, events: ['issues.labeled'], claimOn: true, isEdit: false }), undefined);
});

test('isLaunchedLoop: only a loop tagged launched=true qualifies (#1020)', () => {
  assert.equal(isLaunchedLoop({ type: 'loop', launched: true }), true);
  assert.equal(isLaunchedLoop({ type: 'loop' }), false);           // declarative loop
  assert.equal(isLaunchedLoop({ type: 'loop', launched: false }), false);
  assert.equal(isLaunchedLoop({ type: 'cron', launched: true }), false);
  assert.equal(isLaunchedLoop(null), false);
  assert.equal(isLaunchedLoop(undefined), false);
});

test('isStandingSubscription: the chat Triggers list excludes every loop (#1020 AC4)', () => {
  for (const type of ['cron', 'once', 'http', 'github-event']) {
    assert.equal(isStandingSubscription({ type }), true, `${type} is a standing subscription`);
  }
  // Both a declarative and a chat-launched loop are kept OUT of the list.
  assert.equal(isStandingSubscription({ type: 'loop' }), false);
  assert.equal(isStandingSubscription({ type: 'loop', launched: true }), false);
  assert.equal(isStandingSubscription(null), false);
});

/* ── #1189: delivery-transport body for a github-event label listener ────── */

test('transportBodyFor: a label listener writes an explicit value (github too, to clear on toggle-off)', () => {
  assert.equal(
    transportBodyFor({ showTransport: true, transport: 'internal', isEdit: true, priorTransport: undefined }),
    'internal');
  // Toggling internal → github must write 'github' explicitly so the PUT merge
  // clears a stored 'internal' rather than leaving it in place.
  assert.equal(
    transportBodyFor({ showTransport: true, transport: 'github', isEdit: true, priorTransport: 'internal' }),
    'github');
});

test('transportBodyFor: a plain non-label trigger keeps no transport key', () => {
  assert.equal(
    transportBodyFor({ showTransport: false, transport: 'github', isEdit: false, priorTransport: undefined }),
    undefined);
});

test('transportBodyFor: a no-longer-label listener with a stale transport is cleared to github on edit', () => {
  assert.equal(
    transportBodyFor({ showTransport: false, transport: 'github', isEdit: true, priorTransport: 'internal' }),
    'github');
  // …but a create with no label listener still omits it.
  assert.equal(
    transportBodyFor({ showTransport: false, transport: 'internal', isEdit: false, priorTransport: undefined }),
    undefined);
});

// ── platform-synthesized event keys (#2032) ─────────────────────────────────

test('eventLabel renders the direct-hand-off key in plain language', () => {
  // Without this the GitHub Event Log's Event column shows the raw
  // `handoff.wake` on a row whose Repository / Type / Work item are all `—`.
  assert.equal(eventLabel('handoff.wake'), 'direct hand-off');
});

test('handoff.wake is NOT offered as a subscribable trigger event', () => {
  // GITHUB_EVENT_OPTIONS is the trigger editor's <select>. Nobody can subscribe
  // to a hand-off with a `github-event` trigger — the consumer's listener is a
  // derived `wake-agent` trigger — so offering it there would author a trigger
  // that can never fire.
  assert.equal(GITHUB_EVENT_OPTIONS.some(o => o.value === 'handoff.wake'), false);
  assert.equal(LABEL_FILTERABLE_EVENTS.has('handoff.wake'), false);
  assert.equal(INTERNAL_EVENT_LABELS.has('handoff.wake'), true);
});

test('plugin.event reads in plain language and is not a subscribable github event (Jira plan §4B)', () => {
  assert.equal(eventLabel('plugin.event'), 'plugin event');
  assert.equal(GITHUB_EVENT_OPTIONS.some(o => o.value === 'plugin.event'), false);
  assert.equal(INTERNAL_EVENT_LABELS.has('plugin.event'), true);
});
