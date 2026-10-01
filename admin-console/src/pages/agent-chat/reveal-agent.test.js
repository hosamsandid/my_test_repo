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

test('revealPlan: a filter that hides the target is dropped', () => {
  const agent = { id: 'acme-dev', role: 'team-member', parentTeamId: 'acme' };
  assert.equal(revealPlan(agent, { kind: 'all' }).resetFilter, false);
  assert.equal(revealPlan(agent, { kind: 'team', id: 'acme' }).resetFilter, false);
  assert.equal(revealPlan(agent, { kind: 'team', id: 'other' }).resetFilter, true);
  assert.equal(revealPlan(agent, { kind: 'agent', id: 'someone' }).resetFilter, true);
  assert.equal(revealPlan(agent, { kind: 'agent', id: 'acme-dev' }).resetFilter, false);
});

test('revealPlan: names the team group to expand', () => {
  assert.equal(revealPlan({ id: 'acme-dev', role: 'team-member', parentTeamId: 'acme' }, { kind: 'all' }).groupKey, 'team:acme');
  // A stub member lives in the same group (its own sub-section is opened by the row).
  assert.equal(revealPlan({ id: 'acme-qa', role: 'team-member', parentTeamId: 'acme', enabled: false }, { kind: 'all' }).groupKey, 'team:acme');
  assert.equal(revealPlan({ id: 'solo', role: 'agent' }, { kind: 'all' }).groupKey, null);
  assert.deepEqual(revealPlan(null, { kind: 'all' }), { resetFilter: false, groupKey: null });
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

test('#2705 AC2 — revealEmptyStateCopy: a Materialize in flight replaces the stub prompt', () => {
  const stub = { id: 'acme-qa', displayName: 'QA' };
  const copy = revealEmptyStateCopy({ stubAgent: stub, materializingAgent: stub });
  assert.equal(copy.title, 'Materializing QA…');
  assert.equal(copy.busy, true);
  // It must not keep telling the user to choose what is already running.
  assert.doesNotMatch(`${copy.title} ${copy.hint}`, /choose Materialize|not initialised|disabled/i);
  assert.match(revealEmptyStateCopy({ materializingAgent: { id: 'acme-qa' } }).title, /^Materializing acme-qa…$/);
  // The plain stub card carries no busy flag.
  assert.equal(revealEmptyStateCopy({ stubAgent: stub }).busy, undefined);
  // Waiting for a new team still wins.
  assert.match(revealEmptyStateCopy({ waiting: true, materializingAgent: stub }).title, /new team/);
});
