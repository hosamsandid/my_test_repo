'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeAction, isActionPermitted } = require('./authz');

// The plugin #2 policy from the concept (catalog case 9 / §4.6): create-case is
// the flow-final agent's action; the other verbs are unrestricted.
const POLICY = {
  'create-case': { scopes: ['agent'], requiresFlowFinal: true },
  'delete-data': { scopes: ['agent'] },
};

test('a subcommand with no policy rule is unrestricted', () => {
  assert.deepEqual(authorizeAction(POLICY, 'trigger-run', { kind: 'team' }), { allowed: true });
  assert.deepEqual(authorizeAction({}, 'anything', { kind: 'team' }), { allowed: true });
  assert.deepEqual(authorizeAction(null, 'anything', { kind: 'agent' }), { allowed: true });
});

test('scope-restricted action: team caller refused, agent caller allowed', () => {
  const denied = authorizeAction(POLICY, 'delete-data', { kind: 'team' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'scope-not-permitted');
  assert.match(denied.reason, /restricted to agent scope/);

  assert.equal(authorizeAction(POLICY, 'delete-data', { kind: 'agent' }).allowed, true);
});

test('the acceptance case: same-team non-final agent refused create-case, final agent succeeds', () => {
  // A non-final agent of the team — refused even though it is agent-granularity.
  const nonFinal = authorizeAction(POLICY, 'create-case', {
    kind: 'agent', flowFinal: false, crossChecksPassed: true,
  });
  assert.equal(nonFinal.allowed, false);
  assert.equal(nonFinal.code, 'not-flow-final');

  // The flow-final agent whose cross-checks passed — allowed.
  const final = authorizeAction(POLICY, 'create-case', {
    kind: 'agent', flowFinal: true, crossChecksPassed: true,
  });
  assert.deepEqual(final, { allowed: true });
});

test('flow-final agent whose cross-checks have not passed is refused', () => {
  const pending = authorizeAction(POLICY, 'create-case', {
    kind: 'agent', flowFinal: true, crossChecksPassed: false,
  });
  assert.equal(pending.allowed, false);
  assert.equal(pending.code, 'cross-checks-pending');
});

test('a team-scoped token cannot express flow position at all', () => {
  const teamCaller = authorizeAction(POLICY, 'create-case', {
    kind: 'team', flowFinal: true, crossChecksPassed: true,
  });
  assert.equal(teamCaller.allowed, false);
  // Denied on the scope gate first (create-case is scopes:['agent']).
  assert.equal(teamCaller.code, 'scope-not-permitted');
});

test('flow-position rule without an explicit scope still refuses a team caller', () => {
  const policy = { publish: { requiresFlowFinal: true } };
  const teamCaller = authorizeAction(policy, 'publish', { kind: 'team', flowFinal: true, crossChecksPassed: true });
  assert.equal(teamCaller.allowed, false);
  assert.equal(teamCaller.code, 'flow-position-inexpressible');
});

test('fails closed on a malformed/absent caller', () => {
  assert.equal(authorizeAction(POLICY, 'create-case', undefined).allowed, false);
  assert.equal(authorizeAction(POLICY, 'create-case', {}).allowed, false);
  assert.equal(authorizeAction(POLICY, 'delete-data', null).allowed, false);
});

test('isActionPermitted mirrors authorizeAction.allowed', () => {
  assert.equal(isActionPermitted(POLICY, 'create-case', { kind: 'agent', flowFinal: true, crossChecksPassed: true }), true);
  assert.equal(isActionPermitted(POLICY, 'create-case', { kind: 'team' }), false);
  assert.equal(isActionPermitted(POLICY, 'trigger-run', { kind: 'team' }), true);
});
