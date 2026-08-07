import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupEnvironmentName, rowEnvironmentName } from './agent-list-env.js';

const member = (id, environmentName) => ({ id, role: 'team-member', environmentName });

test('a group whose rows all share one environment hoists it', () => {
  const group = {
    header: { id: 'agent-studio-2-0', role: 'team', environmentName: 'Agent Studio' },
    children: [
      member('business-analyst', 'Agent Studio'),
      member('developer', 'Agent Studio'),
      member('code-reviewer', 'Agent Studio'),
    ],
  };
  assert.equal(groupEnvironmentName(group), 'Agent Studio');
  // …and every row then renders single-line.
  for (const row of [group.header, ...group.children]) {
    assert.equal(rowEnvironmentName(row, 'Agent Studio'), null);
  }
});

test('a headerless group (orphaned members) still hoists a shared environment', () => {
  const group = {
    header: null,
    children: [member('intake-curator', 'accessio-env'), member('context-analyst', 'accessio-env')],
  };
  assert.equal(groupEnvironmentName(group), 'accessio-env');
});

test('a deviating member keeps its own environment line', () => {
  const group = {
    header: { id: 'team', role: 'team', environmentName: 'Agent Studio' },
    children: [
      member('a', 'Agent Studio'),
      member('b', 'Agent Studio'),
      member('c', 'legacy-env'),
    ],
  };
  const env = groupEnvironmentName(group);
  assert.equal(env, 'Agent Studio');
  assert.equal(rowEnvironmentName(group.children[1], env), null);
  assert.equal(rowEnvironmentName(group.children[2], env), 'legacy-env');
});

test('no majority environment → nothing is hoisted, every row keeps its line', () => {
  const group = {
    header: null,
    children: [member('a', 'env-a'), member('b', 'env-b')],
  };
  const env = groupEnvironmentName(group);
  assert.equal(env, null);
  assert.equal(rowEnvironmentName(group.children[0], env), 'env-a');
  assert.equal(rowEnvironmentName(group.children[1], env), 'env-b');
});

test('a tie between two equally common environments is never resolved arbitrarily', () => {
  const group = {
    header: null,
    children: [
      member('a', 'env-a'), member('b', 'env-a'),
      member('c', 'env-b'), member('d', 'env-b'),
    ],
  };
  assert.equal(groupEnvironmentName(group), null);
});

test('a single row is not worth hoisting — it would just move the line', () => {
  assert.equal(groupEnvironmentName({ header: null, children: [member('a', 'env-a')] }), null);
  assert.equal(
    groupEnvironmentName({ header: { id: 't', environmentName: 'env-a' }, children: [] }),
    null,
  );
});

test('rows without an environment neither vote nor block the hoist', () => {
  const group = {
    header: null,
    children: [member('a', 'Agent Studio'), member('b', 'Agent Studio'), member('c', undefined)],
  };
  const env = groupEnvironmentName(group);
  assert.equal(env, 'Agent Studio');
  // The env-less row renders nothing, exactly as it did before.
  assert.equal(rowEnvironmentName(group.children[2], env), null);
});

test('empty / malformed groups are tolerated', () => {
  assert.equal(groupEnvironmentName(undefined), null);
  assert.equal(groupEnvironmentName({}), null);
  assert.equal(groupEnvironmentName({ header: null, children: [] }), null);
});

test('an ungrouped row (no group env) always shows its own environment', () => {
  assert.equal(rowEnvironmentName({ id: 'solo', environmentName: 'Agent Studio' }), 'Agent Studio');
  assert.equal(rowEnvironmentName({ id: 'solo' }), null);
  assert.equal(rowEnvironmentName(undefined), null);
});
