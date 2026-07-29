import test from 'node:test';
import assert from 'node:assert/strict';

import { consumersFor, labelConsumers } from './outcome-consumers.js';

const node = { id: 'dev' };

const peers = [
  { id: 'dev', displayName: 'Developer', triggers: [{ labelFilter: 'ready' }] },
  { id: 'reviewer', displayName: 'Code Reviewer', triggers: [{ labelFilter: 'ready-for-review' }] },
  { id: 'reworker', displayName: 'Reworker', triggers: [{ labelFilter: 'revisions-required' }] },
  { id: 'qa', displayName: 'QA', channels: [{ artifact: 'pr', from: 'dev' }] },
  { id: 'triage', displayName: 'Triage', channels: [{ artifact: 'issue', from: 'someone-else' }] },
];

test('setLabel outcome resolves the peers listening on that label', () => {
  const o = { actions: [{ type: 'setLabel', label: 'ready-for-review' }] };
  assert.deepEqual(consumersFor(o, node, peers), ['Code Reviewer']);
});

test('an outcome with several labels unions its consumers', () => {
  const o = { actions: [
    { type: 'setLabel', label: 'ready-for-review' },
    { type: 'setLabel', label: 'revisions-required' },
  ] };
  assert.deepEqual(consumersFor(o, node, peers), ['Code Reviewer', 'Reworker']);
});

test('openPr resolves peers with a pr channel from this node', () => {
  assert.deepEqual(consumersFor({ actions: [{ type: 'openPr' }] }, node, peers), ['QA']);
});

test('openIssue ignores a channel pointing at another producer', () => {
  assert.deepEqual(consumersFor({ actions: [{ type: 'openIssue' }] }, node, peers), []);
});

test('the node never consumes its own outcome', () => {
  // 'dev' itself listens on `ready`, but a self-edge is not a hand-off.
  assert.deepEqual(consumersFor({ actions: [{ type: 'setLabel', label: 'ready' }] }, node, peers), []);
});

test('a peer counted once even when it listens and consumes a channel', () => {
  const both = [{ id: 'qa', displayName: 'QA', triggers: [{ labelFilter: 'done' }], channels: [{ artifact: 'pr', from: 'dev' }] }];
  const o = { actions: [{ type: 'setLabel', label: 'done' }, { type: 'openPr' }] };
  assert.deepEqual(consumersFor(o, node, both), ['QA']);
});

test('a peer without a displayName falls back to its id', () => {
  const anon = [{ id: 'bare-agent', triggers: [{ labelFilter: 'done' }] }];
  assert.deepEqual(consumersFor({ actions: [{ type: 'setLabel', label: 'done' }] }, node, anon), ['bare-agent']);
});

test('a terminal (none) outcome has no consumers', () => {
  assert.deepEqual(consumersFor({ actions: [{ type: 'none' }] }, node, peers), []);
});

test('a blank setLabel label matches nothing', () => {
  const blank = [{ id: 'x', triggers: [{ labelFilter: '' }] }];
  assert.deepEqual(consumersFor({ actions: [{ type: 'setLabel', label: '' }] }, node, blank), []);
});

test('missing option / peers degrade to an empty list', () => {
  assert.deepEqual(consumersFor(null, node, peers), []);
  assert.deepEqual(consumersFor({}, node, null), []);
  assert.deepEqual(consumersFor({ actions: [{ type: 'setLabel', label: 'ready-for-review' }] }, null, peers), ['Code Reviewer']);
});

test('labelConsumers is the flat-emit shorthand for a single label', () => {
  assert.deepEqual(labelConsumers('revisions-required', node, peers), ['Reworker']);
  assert.deepEqual(labelConsumers('nobody-listens', node, peers), []);
  assert.deepEqual(labelConsumers('', node, peers), []);
  assert.deepEqual(labelConsumers(null, node, peers), []);
});
