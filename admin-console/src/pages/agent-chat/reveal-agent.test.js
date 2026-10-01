// Tests for the Agent Chat reveal-on-arrival decisions (#2521).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  revealTargetFrom,
  isAwaitingReveal,
  revealPlan,
  REVEAL_WAIT_MS,
  REVEAL_RETRY_MS,
  revealEmptyStateCopy,
} from './reveal-agent.js';

test('revealTargetFrom: only the routed id counts', () => {
  assert.equal(revealTargetFrom({ revealAgentId: 'acme-dev' }, 'acme-dev'), 'acme-dev');
  // A stale history entry naming another agent must not reveal (or wait for) it.
  assert.equal(revealTargetFrom({ revealAgentId: 'acme-dev' }, 'other'), null);
  for (const bad of [null, undefined, 'acme-dev', {}, { revealAgentId: '' }, { revealAgentId: 42 }]) {
    assert.equal(revealTargetFrom(bad, 'acme-dev'), null, JSON.stringify(bad));
  }
});

test('isAwaitingReveal: waits until the target is in the roster', () => {
  assert.equal(isAwaitingReveal('acme-dev', null, null), true, 'roster still loading');
  assert.equal(isAwaitingReveal('acme-dev', [{ id: 'x' }], null), true, 'not in roster yet');
  assert.equal(isAwaitingReveal('acme-dev', [{ id: 'acme-dev' }], null), false, 'arrived');
});

test('isAwaitingReveal: a timed-out wait stops holding the bounce', () => {
  assert.equal(isAwaitingReveal('acme-dev', [{ id: 'x' }], 'acme-dev'), false);
  // ...but only for the id that timed out.
  assert.equal(isAwaitingReveal('acme-qa', [{ id: 'x' }], 'acme-dev'), true);
  assert.equal(isAwaitingReveal(null, [], null), false);
});

test('the wait is bounded and retried several times within the bound', () => {
  assert.ok(REVEAL_WAIT_MS > 0 && REVEAL_RETRY_MS > 0);
  assert.ok(REVEAL_WAIT_MS / REVEAL_RETRY_MS >= 3);
});

test('revealPlan (#2740): a selection that hides the target ticks only its entry back in', () => {
  const agent = { id: 'acme-dev', role: 'team-member', parentTeamId: 'acme' };
  assert.equal(revealPlan(agent, { hidden: [] }).showKey, null);
  assert.equal(revealPlan(agent, { hidden: ['team:other'] }).showKey, null);
  assert.equal(revealPlan(agent, { hidden: ['team:acme', 'team:other'] }).showKey, 'team:acme');
  // An ungrouped row is revealed through the Individual agents block.
  assert.equal(revealPlan({ id: 'solo', role: 'orchestrator' }, { hidden: ['singles'] }).showKey, 'singles');
});

test('revealPlan: names the team group to expand', () => {
  assert.equal(revealPlan({ id: 'acme-dev', role: 'team-member', parentTeamId: 'acme' }, { hidden: [] }).groupKey, 'team:acme');
  // A stub member lives in the same group (its own sub-section is opened by the row).
  assert.equal(revealPlan({ id: 'acme-qa', role: 'team-member', parentTeamId: 'acme', enabled: false }, { hidden: [] }).groupKey, 'team:acme');
  assert.equal(revealPlan({ id: 'solo', role: 'agent' }, { hidden: [] }).groupKey, null);
  assert.deepEqual(revealPlan(null, { hidden: [] }), { showKey: null, groupKey: null });
});

test('revealEmptyStateCopy: waiting, stub, or the ordinary card', () => {
  assert.match(revealEmptyStateCopy({ waiting: true }).title, /new team/);
  const stub = revealEmptyStateCopy({ stubAgent: { id: 'acme-qa', displayName: 'QA' } });
  assert.match(stub.title, /^QA is not initialised yet$/);
  assert.match(stub.hint, /Materialize/);
  assert.doesNotMatch(`${stub.title} ${stub.hint}`, /error|fail/i, 'AC6: a stub is not an error');
  assert.match(revealEmptyStateCopy({ stubAgent: { id: 'acme-qa' } }).title, /^acme-qa /);
  // Waiting wins: the stub state is only known once the row has arrived.
  assert.match(revealEmptyStateCopy({ waiting: true, stubAgent: { id: 'x' } }).title, /new team/);
  assert.equal(revealEmptyStateCopy({}), null);
  assert.equal(revealEmptyStateCopy(), null);
});
