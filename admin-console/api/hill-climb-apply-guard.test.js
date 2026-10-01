'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  isExecutableClass,
  parseTriggerRef,
  triggerApplyGuardError,
  staleTriggerReason,
  humanGateLabelSet,
  emittedLabelSet,
} = require('./hill-climb-apply-guard');

const triggerCard = (over = {}) => ({
  id: 'card-1',
  class: 'trigger-hygiene',
  object: { kind: 'trigger', id: 'agent-x/nightly' },
  proposedChange: { action: 'delete-or-rescope', agentId: 'agent-x', triggerId: 'nightly' },
  targetMetric: 'waste.wasteRuns',
  status: 'open',
  ...over,
});

test('isExecutableClass: only trigger-hygiene is wired in this ticket', () => {
  assert.equal(isExecutableClass('trigger-hygiene'), true);
  assert.equal(isExecutableClass('prompt-improvement'), false);
  assert.equal(isExecutableClass('flow-wiring'), false);
  assert.equal(isExecutableClass('threshold-tuning'), false);
  assert.equal(isExecutableClass(undefined), false);
});

test('parseTriggerRef: prefers proposedChange, falls back to object id', () => {
  assert.deepEqual(parseTriggerRef(triggerCard()), { agentId: 'agent-x', triggerId: 'nightly' });
  assert.deepEqual(
    parseTriggerRef({ object: { id: 'agent-y/some-trigger' }, proposedChange: {} }),
    { agentId: 'agent-y', triggerId: 'some-trigger' },
  );
  // split on the first slash only (agent ids have no slash; tolerate one in the id)
  assert.deepEqual(
    parseTriggerRef({ object: { id: 'agent-z/a/b' } }),
    { agentId: 'agent-z', triggerId: 'a/b' },
  );
  assert.equal(parseTriggerRef({ object: { id: 'no-slash' } }), null);
  assert.equal(parseTriggerRef(null), null);
});

test('triggerApplyGuardError: protects intrinsic/derived/human-gate triggers', () => {
  assert.equal(triggerApplyGuardError({ id: 't', type: 'cron' }), null, 'plain trigger is deletable');
  assert.match(triggerApplyGuardError({ intrinsic: true }), /intrinsic/);
  assert.match(triggerApplyGuardError({ dataFlow: true }), /data-flow|ports/);
  assert.match(triggerApplyGuardError({ channel: true }), /channel|ports/);
  // #2032: the P3 direct hand-off listener is derived from the outcomes port,
  // so the applier must not delete it — reached either by the wakeHandoff marker
  // or by its type, since hill-climb-sweep flattens every trigger with an id.
  assert.match(triggerApplyGuardError({ wakeHandoff: true }), /hand-off|outcomes/);
  assert.match(triggerApplyGuardError({ type: 'wake-agent' }), /hand-off|outcomes/);
  assert.match(triggerApplyGuardError({ humanGate: true }), /human-gate/);
  assert.equal(triggerApplyGuardError(null), 'trigger not found');
});

test('triggerApplyGuardError: rejects a listener for a human-gate label', () => {
  const gate = new Set(['approved-for-dispatch']);
  assert.match(
    triggerApplyGuardError({ type: 'github-event', labelFilter: 'approved-for-dispatch' }, { humanGateLabels: gate }),
    /human-gate label/,
  );
  assert.equal(
    triggerApplyGuardError({ type: 'github-event', labelFilter: 'ready-for-review' }, { humanGateLabels: gate }),
    null,
  );
  assert.match(
    triggerApplyGuardError({ labelFilter: 'sec:approved' }, { humanGateLabels: ['sec:approved'] }),
    /human-gate label/,
  );
});

test('staleTriggerReason: stale when the live trigger is gone', () => {
  assert.equal(staleTriggerReason(triggerCard(), { id: 'nightly', type: 'cron' }), null);
  assert.match(staleTriggerReason(triggerCard(), null), /no longer exists|re-detect/);
  assert.match(staleTriggerReason({ object: { id: 'no-slash' } }, { id: 'x' }), /concrete trigger/);
});

test('humanGateLabelSet: extracts only humanGate-flagged label names', () => {
  const cfg = {
    labels: [
      { name: 'approved-for-dispatch', humanGate: true },
      { name: 'ready-for-review', humanGate: false },
      { name: 'sec:approved', humanGate: true, brake: false },
      { name: '' , humanGate: true },
      null,
    ],
  };
  const s = humanGateLabelSet(cfg);
  assert.equal(s.has('approved-for-dispatch'), true);
  assert.equal(s.has('sec:approved'), true);
  assert.equal(s.has('ready-for-review'), false);
  assert.equal(s.size, 2);
  assert.deepEqual([...humanGateLabelSet({})], []);
  assert.deepEqual([...humanGateLabelSet(null)], []);
});

test('triggerApplyGuardError: protects a Flow label hand-off listener (#2710)', () => {
  // What wireLabelHandoff writes: a plain github-event listener with no derived flag.
  const listener = {
    id: 't1790817163431', type: 'github-event', events: ['issues.labeled'],
    labelFilter: 'ready-for-review', claim: { remove: 'ready-for-review', add: 'in-review' },
    description: 'Wake when `ready-for-review` is added to an issue (from Dev)',
  };
  const handoffLabels = emittedLabelSet([
    { outcomes: { options: [{ actions: [{ type: 'setLabel', label: 'ready-for-review' }] }] } },
  ]);
  assert.match(triggerApplyGuardError(listener, { handoffLabels }), /hand-off label 'ready-for-review'/);
  assert.match(triggerApplyGuardError(listener, { handoffLabels: ['ready-for-review'] }), /hand-off label/);
  // Nobody emits the label any more → a genuinely dead listener stays deletable.
  assert.equal(triggerApplyGuardError(listener, { handoffLabels: new Set(['other']) }), null);
  assert.equal(triggerApplyGuardError(listener), null);
});

test('emittedLabelSet: outcomes setLabel actions plus legacy emits', () => {
  const s = emittedLabelSet([
    { emits: ['ready-for-qa', ' ', null] },
    { outcomes: { options: [
      { actions: [{ type: 'setLabel', label: 'ready-for-review' }, { type: 'openPr' }] },
      { actions: [{ type: 'setLabel', label: '' }] },
    ] } },
    null,
  ]);
  assert.deepEqual([...s].sort(), ['ready-for-qa', 'ready-for-review']);
  assert.deepEqual([...emittedLabelSet(null)], []);
});

// Source guards (#2710 review S1): the pure guard is covered above, but the
// production wiring is not exercised by any route test — pin it so a refactor
// cannot silently drop the hand-off protection or the trigger age stamp.
test('apply route passes the team members\' emitted labels as handoffLabels (#2710)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'api.js'), 'utf8');
  const start = src.indexOf("app.post('/api/teams/:teamId/hill-climb/cards/:cardId/apply'");
  assert.ok(start > 0, 'apply route present');
  const body = src.slice(start, src.indexOf('\napp.', start + 1));
  assert.match(body, /if \(cfg && cfg\.parentTeamId === teamId\) teamMembers\.push\(\{ emits: cfg\.emits, outcomes: cfg\.outcomes \}\);/);
  assert.match(body, /handoffLabels: hillClimbApplyGuard\.emittedLabelSet\(teamMembers\),/);
});

test('POST /api/agents/:id/triggers stamps createdAt on every trigger type (#2710)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'api.js'), 'utf8');
  const start = src.indexOf("app.post('/api/agents/:id/triggers'");
  assert.ok(start > 0, 'trigger POST route present');
  const body = src.slice(start, src.indexOf('triggers.push(newTrigger);', start));
  assert.match(body, /\n  if \(!newTrigger\.createdAt\) newTrigger\.createdAt = now;/, 'createdAt stamped outside any type branch');
});
