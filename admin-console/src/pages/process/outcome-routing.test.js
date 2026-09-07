import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rowLabels, rowArtifact, consumerCandidates, wireConsumerSpec, unwireConsumerSpec, currentConsumers,
  outcomeDropDialog, openEndMarker, edgeOpensProducerOutcome, labelEdgeHasListener,
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

// #1192 — edge-click routing: a label hand-off edge opens its edit dialog even
// when outcome-keyed (symmetric with create); other outcome edges focus Outcomes.

test('edgeOpensProducerOutcome: a label hand-off edge is NOT short-circuited, even when outcome-keyed', () => {
  // outcome-keyed label edge → false → opens EditLabelHandoff (has Delivery).
  assert.equal(edgeOpensProducerOutcome({ on: 'label', from: 'a', to: 'b', outcome: 'o1' }), false);
  // plain (non-outcome) label edge → false → same edit dialog as before.
  assert.equal(edgeOpensProducerOutcome({ on: 'label', from: 'a', to: 'b' }), false);
});

test('edgeOpensProducerOutcome: a non-label outcome edge still focuses the producer Outcomes', () => {
  assert.equal(edgeOpensProducerOutcome({ on: 'github', from: 'a', to: 'b', outcome: 'opens-pr' }), true);
});

test('edgeOpensProducerOutcome: guards missing outcome / from', () => {
  assert.equal(edgeOpensProducerOutcome({ on: 'github', from: 'a' }), false);         // no outcome
  assert.equal(edgeOpensProducerOutcome({ on: 'github', outcome: 'o' }), false);       // no from (actor-sourced)
  assert.equal(edgeOpensProducerOutcome(null), false);
  assert.equal(edgeOpensProducerOutcome(undefined), false);
});

// #1195 — a fan-in/feedback label edge has no backing listener trigger.

test('labelEdgeHasListener: true only when the edge carries a triggerId', () => {
  assert.equal(labelEdgeHasListener({ on: 'label', from: 'a', to: 'b', triggerId: 't1' }), true);
  // fan-in / feedback edge (channel-label loop) → no triggerId → false.
  assert.equal(labelEdgeHasListener({ on: 'label', from: 'reworker', to: 'cr', label: 'ready-for-review', outcome: 'ready-for-review' }), false);
  assert.equal(labelEdgeHasListener({ on: 'label', from: 'a', to: 'b', triggerId: '' }), false);
  assert.equal(labelEdgeHasListener(null), false);
  assert.equal(labelEdgeHasListener(undefined), false);
});

test('#2031: a direct hand-off edge opens its OWN dialog, not the producer Outcomes', () => {
  // A wake edge always carries an `outcome` (edgeId keys on it), so without the
  // exception every click would jump to the Routing tab and EditWakeHandoffDialog
  // would be unreachable code. Mutation check: the pre-#2031 rule intercepted it.
  const edge = { on: 'wake', from: 'dev', to: 'rev', outcome: 'hand-off-rev' };
  assert.equal(edgeOpensProducerOutcome(edge), false);
  const preChange = !!(edge.outcome && edge.from && edge.on !== 'label');
  assert.equal(preChange, true, 'the old rule DID swallow it — which is what this fixes');
  // The opens-PR/issue edges still focus the Outcomes: they carry no per-edge
  // state to edit, so there is no dialog for them to open.
  assert.equal(edgeOpensProducerOutcome({ on: 'github', from: 'a', to: 'b', outcome: 'opens-pr' }), true);
});

test('#2031: consumerCandidates excludes the actor pseudo-nodes, not just humans', () => {
  // On a LIVE team `peers` is the graph's node list, which carries @github /
  // @external / @timer as `kind: 'actor'`. An exclusion list of `!== 'human'`
  // offered all three as pickable consumers and hand-off targets, which the
  // server then refuses as "not a role in this flow".
  const peers = [
    { id: 'dev', displayName: 'Developer' },
    { id: 'lead', displayName: 'Tech Lead', kind: 'human' },
    { id: '@github', displayName: 'GitHub', kind: 'actor' },
    { id: '@external', displayName: 'External system', kind: 'actor' },
    { id: '@timer', displayName: 'Schedule', kind: 'actor' },
    { id: 'rev', displayName: 'Reviewer', kind: 'agent' },
  ];
  assert.deepEqual(consumerCandidates({ id: 'ba' }, peers).map(c => c.id), ['dev', 'rev']);
  // A draft's roles carry no `kind` at all — they must still be candidates.
  assert.deepEqual(consumerCandidates({ id: 'ba' }, [{ id: 'dev', displayName: 'D' }]).map(c => c.id), ['dev']);
});
