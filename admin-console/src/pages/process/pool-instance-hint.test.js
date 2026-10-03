import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  instanceStatusText, instanceLabel, poolInstanceHint, poolInstanceHintsByNode,
  isPoolInstanceRow, poolInstanceRoleMap,
} from './pool-instance-hint.js';

const READ = {
  roles: [
    {
      agentId: 'acme-specifier',
      instances: [
        { instanceId: 'acme-specifier-i71', item: 71, status: 'running' },
        { instanceId: 'acme-specifier-i72', item: 72, status: 'waiting' },
        { instanceId: 'acme-specifier-i9', item: 9, status: 'timed-out' },
      ],
    },
    { agentId: 'acme-developer', instances: [] },
  ],
};

test('#2814 AC4: the hint counts running, waiting-for-PR and timed-out instances', () => {
  const hint = poolInstanceHint(READ, 'acme-specifier');
  assert.equal(hint.count, 3);
  assert.equal(hint.text, '3 running');
  assert.match(hint.title, /#71 \(running\), #72 \(waiting for PR\), #9 \(timed out\)/);
});

test('#2814 AC4: zero live instances → no hint (the node looks as it does today)', () => {
  assert.equal(poolInstanceHint(READ, 'acme-developer'), null);
  assert.equal(poolInstanceHint(READ, 'acme-unknown'), null);
  assert.equal(poolInstanceHint(null, 'acme-specifier'), null);
  assert.equal(poolInstanceHint({ roles: [{ agentId: 'x' }] }, 'x'), null, 'an older orchestrator without `instances`');
});

test('#2814 AC5: one line per instance with its number and state', () => {
  assert.deepEqual(poolInstanceHint(READ, 'acme-specifier').instances, [
    { instanceId: 'acme-specifier-i71', label: '#71', status: 'running', statusText: 'running' },
    { instanceId: 'acme-specifier-i72', label: '#72', status: 'waiting', statusText: 'waiting for PR' },
    { instanceId: 'acme-specifier-i9', label: '#9', status: 'timed-out', statusText: 'timed out' },
  ]);
});

test('#2814: an instance without an item number is labelled by its id', () => {
  assert.equal(instanceLabel({ instanceId: 'acme-x-i1', item: null }), 'acme-x-i1');
  assert.equal(instanceStatusText('something-new'), 'something-new');
});

test('#2814: hints by node only carry roles with live instances', () => {
  const byNode = poolInstanceHintsByNode(READ);
  assert.deepEqual(Object.keys(byNode), ['acme-specifier']);
});

test('#2814 AC7: an instance is recognised by its config flag, never by its id shape', () => {
  assert.equal(isPoolInstanceRow({ id: 'acme-dev-i3', poolInstance: true, poolOf: 'acme-dev' }), true);
  assert.equal(isPoolInstanceRow({ id: 'acme-dev-i3' }), false);
  assert.deepEqual(
    poolInstanceRoleMap([
      { id: 'acme-dev-i3', poolInstance: true, poolOf: 'acme-dev' },
      { id: 'acme-helper-i4' },
      { id: 'acme-dev' },
    ]),
    { 'acme-dev-i3': 'acme-dev' },
  );
});
