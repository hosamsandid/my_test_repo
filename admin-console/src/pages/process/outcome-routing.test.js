import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rowLabels, rowArtifact, consumerCandidates, wireConsumerSpec, unwireConsumerSpec, currentConsumers,
  outcomeDropDialog, openEndMarker,
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

// #1035 — an outcome-port drag onto a human routes to the person delivery
// dialog, not the agent channel/hand-off forms (which throw `role … not found`
// on a human target). The `outcome` here is the resolved drag payload.
const humanNode = { id: 'ba-human', kind: 'human', displayName: 'BA Human' };
const agentNode = { id: 'dev', displayName: 'Developer' };
const issueDrag = { id: 'ticket', artifact: 'issue', label: '' };
const prDrag = { id: 'pr', artifact: 'pr', label: '' };
const labelDrag = { id: 'ready', artifact: null, label: 'ready' };

test('outcomeDropDialog: any outcome onto a human routes to the person delivery dialog', () => {
  assert.equal(outcomeDropDialog(issueDrag, humanNode), 'person');
  assert.equal(outcomeDropDialog(prDrag, humanNode), 'person');
  // setLabel onto a human also routes to the person dialog (not the agent
  // hand-off form) — a person does not emit an agent's label.
  assert.equal(outcomeDropDialog(labelDrag, humanNode), 'person');
});

test('outcomeDropDialog: drops onto an agent are unchanged (channel vs hand-off)', () => {
  assert.equal(outcomeDropDialog(issueDrag, agentNode), 'channel');
  assert.equal(outcomeDropDialog(prDrag, agentNode), 'channel');
  assert.equal(outcomeDropDialog(labelDrag, agentNode), 'handoff');
  // No/undefined target node behaves like an agent target (no human).
  assert.equal(outcomeDropDialog(labelDrag, null), 'handoff');
  assert.equal(outcomeDropDialog(prDrag, undefined), 'channel');
});

// #1037 — open-end marker round-trips through normalize (load) + finalize (save).

test('openEndMarker: terminal outcome yields {terminal:true}', () => {
  assert.deepEqual(openEndMarker({ id: 'done', terminal: true }), { terminal: true });
});

test('openEndMarker: external with a note is preserved and trimmed', () => {
  assert.deepEqual(openEndMarker({ external: { note: 'CI workflow' } }), { external: { note: 'CI workflow' } });
  assert.deepEqual(openEndMarker({ external: { note: '  CI workflow  ' } }), { external: { note: 'CI workflow' } });
});

test('openEndMarker: external with an empty/blank note collapses to {external:{}}', () => {
  assert.deepEqual(openEndMarker({ external: {} }), { external: {} });
  assert.deepEqual(openEndMarker({ external: { note: '' } }), { external: {} });
  assert.deepEqual(openEndMarker({ external: { note: '   ' } }), { external: {} });
});

test('openEndMarker: an unmarked outcome yields no marker fields', () => {
  assert.deepEqual(openEndMarker({ id: 'x', actions: [{ type: 'setLabel', label: 'y' }] }), {});
  assert.deepEqual(openEndMarker({}), {});
  assert.deepEqual(openEndMarker(null), {});
  assert.deepEqual(openEndMarker(undefined), {});
});

test('openEndMarker: terminal wins if both are somehow present (mirrors marker derivation)', () => {
  assert.deepEqual(openEndMarker({ terminal: true, external: { note: 'x' } }), { terminal: true });
});

test('openEndMarker: a non-true terminal or non-object external is ignored', () => {
  assert.deepEqual(openEndMarker({ terminal: false }), {});
  assert.deepEqual(openEndMarker({ terminal: 'yes' }), {});
  assert.deepEqual(openEndMarker({ external: null }), {});
  assert.deepEqual(openEndMarker({ external: 'nope' }), {});
  assert.deepEqual(openEndMarker({ external: ['a'] }), {});
});
