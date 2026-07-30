import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rowLabels, rowArtifact, consumerCandidates, wireConsumerSpec, unwireConsumerSpec, currentConsumers,
} from './outcome-routing.js';

// #1003 — pure specs for the per-row consumer picker (concept §4.2).

const node = { id: 'ba', displayName: 'Business Analyst' };
const peers = [
  { id: 'ba', displayName: 'Business Analyst' },
  { id: 'dev', displayName: 'Developer', triggers: [
    { id: 't1', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready' },
  ] },
  { id: 'qa', displayName: 'QA', channels: [{ artifact: 'issue', from: 'ba', label: 'go' }] },
  { id: 'p', displayName: 'BA Human', kind: 'human' },
];

const labelOpt = { id: 'ready', actions: [{ type: 'setLabel', label: 'ready' }] };
const issueOpt = { id: 'ticket', actions: [{ type: 'openIssue' }] };
const mixedOpt = { id: 'm', actions: [{ type: 'openPr' }, { type: 'setLabel', label: 'x' }] };
const noneOpt = { id: 'stop', actions: [{ type: 'none' }] };

test('rowLabels / rowArtifact read the actions', () => {
  assert.deepEqual(rowLabels(labelOpt), ['ready']);
  assert.deepEqual(rowLabels(issueOpt), []);
  assert.equal(rowArtifact(issueOpt), 'issue');
  assert.equal(rowArtifact(mixedOpt), 'pr');
  assert.equal(rowArtifact(labelOpt), null);
});

test('consumerCandidates excludes self and human roles', () => {
  assert.deepEqual(consumerCandidates(node, peers).map(c => c.id), ['dev', 'qa']);
});

test('wireConsumerSpec: label wins over artifact; terminal rows wire nothing', () => {
  assert.deepEqual(wireConsumerSpec(labelOpt), { kind: 'label', label: 'ready' });
  assert.deepEqual(wireConsumerSpec(issueOpt), { kind: 'channel', artifact: 'issue' });
  assert.deepEqual(wireConsumerSpec(mixedOpt), { kind: 'label', label: 'x' });
  assert.equal(wireConsumerSpec(noneOpt), null);
});

test('unwireConsumerSpec finds the matching listener or channel on the target', () => {
  assert.deepEqual(
    unwireConsumerSpec(labelOpt, node, peers[1]),
    { kind: 'label', triggerId: 't1', label: 'ready' },
  );
  assert.deepEqual(
    unwireConsumerSpec(issueOpt, node, peers[2]),
    { kind: 'channel', artifact: 'issue', label: 'go' },
  );
  // A channel from a DIFFERENT producer does not match.
  assert.equal(unwireConsumerSpec(issueOpt, { id: 'other' }, peers[2]), null);
  assert.equal(unwireConsumerSpec(labelOpt, node, peers[2]), null);
});

test('currentConsumers lists wired peers with their unwire specs', () => {
  const wired = currentConsumers(labelOpt, node, peers);
  assert.deepEqual(wired, [{ id: 'dev', name: 'Developer', spec: { kind: 'label', triggerId: 't1', label: 'ready' } }]);
  const viaChannel = currentConsumers(issueOpt, node, peers);
  assert.deepEqual(viaChannel.map(w => w.id), ['qa']);
  // Humans never appear as signal consumers.
  assert.ok(!currentConsumers(mixedOpt, node, peers).some(w => w.id === 'p'));
});
