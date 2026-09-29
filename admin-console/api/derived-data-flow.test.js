'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isDerivedDataFlowTrigger, rekeyRoleKeyDerived, rederiveTeamDataFlow } = require('./derived-data-flow');

const NOW = '2026-09-29T12:00:00.000Z';
const OLD = '2026-09-01T00:00:00.000Z';

// A consumer materialised from a Flow-editor bundle: the derived trigger keeps
// its role-key id (`dev-on-push-spec`) while its producer filter names members.
const roleKeyed = { id: 'dev-on-push-spec', type: 'github-event', events: ['push'], dataFlow: true, pushedBy: ['t1-spec'], activatedAt: OLD };
const members = (dependsOn, triggers = [roleKeyed]) => [
  { id: 't1-dev', triggers, df: { dependsOn } },
  { id: 't1-spec', triggers: [], df: {} },
  { id: 't1-arch', triggers: [], df: {} },
];
const derivedOf = (list) => list.filter(t => t.dataFlow === true);

test('recognises full-id and role-key derived ids; leaves hand-authored ones', () => {
  assert.equal(isDerivedDataFlowTrigger({ id: 't1-dev-on-push-t1-spec', dataFlow: true }, 't1-dev', 't1'), true);
  assert.equal(isDerivedDataFlowTrigger(roleKeyed, 't1-dev', 't1'), true);
  assert.equal(isDerivedDataFlowTrigger({ id: 'my-push', dataFlow: true }, 't1-dev', 't1'), false);
  assert.equal(isDerivedDataFlowTrigger({ id: 'dev-on-push-spec' }, 't1-dev', 't1'), false);
  // Another team's member has no role-key match here.
  assert.equal(isDerivedDataFlowTrigger(roleKeyed, 't2-dev', 't1'), false);
});

test('re-pointing a role-keyed edge leaves exactly one derived trigger, naming the new upstream', () => {
  const next = derivedOf(rederiveTeamDataFlow('t1', members(['t1-arch']), NOW).get('t1-dev'));
  assert.equal(next.length, 1);
  assert.equal(next[0].id, 't1-dev-on-push-t1-arch');
  assert.deepEqual(next[0].pushedBy, ['t1-arch']);
  assert.equal(next[0].activatedAt, NOW); // a genuinely new upstream starts now
});

test('removing the edge leaves no derived trigger; hand-authored triggers survive', () => {
  const manual = { id: 'my-push', type: 'github-event', events: ['push'], dataFlow: true };
  const next = rederiveTeamDataFlow('t1', members([], [roleKeyed, manual]), NOW).get('t1-dev');
  assert.deepEqual(next.map(t => t.id), ['my-push']);
});

test('the same edge re-keyed to its full id keeps the role-key trigger\'s horizon', () => {
  const next = derivedOf(rederiveTeamDataFlow('t1', members(['t1-spec']), NOW).get('t1-dev'));
  assert.equal(next.length, 1);
  assert.equal(next[0].id, 't1-dev-on-push-t1-spec');
  assert.deepEqual(next[0].pushedBy, ['t1-spec']);
  assert.equal(next[0].activatedAt, OLD);
});

test('rekeyRoleKeyDerived: an existing full-id trigger wins over the role-key one', () => {
  const full = { id: 't1-dev-on-push-t1-spec', dataFlow: true, activatedAt: NOW };
  assert.deepEqual(rekeyRoleKeyDerived([roleKeyed, full], 't1-dev', 't1').map(t => t.id), ['dev-on-push-spec', 't1-dev-on-push-t1-spec']);
  assert.equal(rekeyRoleKeyDerived([roleKeyed], 't1-dev', 't1')[0].id, 't1-dev-on-push-t1-spec');
});
