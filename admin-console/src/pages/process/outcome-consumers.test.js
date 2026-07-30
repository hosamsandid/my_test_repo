import test from 'node:test';
import assert from 'node:assert/strict';

import { consumersFor, labelConsumers, outcomeHandsOffToHuman } from './outcome-consumers.js';

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

// ── #981: brake labels hand off to a person, never "no consumer" ─────────────

test('outcomeHandsOffToHuman: true for a brake-flagged setLabel, false otherwise', () => {
  const labels = [
    { name: 'human-decision-required', humanGate: false, brake: true },
    { name: 'ready-for-test', humanGate: false, brake: false },
    { name: 'dispatch', humanGate: true, brake: false },
  ];
  const opt = (label) => ({ actions: [{ type: 'setLabel', label }] });
  assert.equal(outcomeHandsOffToHuman(opt('human-decision-required'), labels), true);
  assert.equal(outcomeHandsOffToHuman(opt('ready-for-test'), labels), false);
  // A gate label is not a hand-off — an agent may not set it at all.
  assert.equal(outcomeHandsOffToHuman(opt('dispatch'), labels), false);
  // Unknown label / no registry → no hand-off.
  assert.equal(outcomeHandsOffToHuman(opt('whatever'), labels), false);
  assert.equal(outcomeHandsOffToHuman(opt('human-decision-required'), undefined), false);
});

test('outcomeHandsOffToHuman: trims and ignores non-setLabel actions', () => {
  const labels = [{ name: 'needs-decision', brake: true }];
  assert.equal(outcomeHandsOffToHuman({ actions: [{ type: 'setLabel', label: ' needs-decision ' }] }, labels), true);
  assert.equal(outcomeHandsOffToHuman({ actions: [{ type: 'openPr' }] }, labels), false);
});

// ── #1001 (D4): a bound human reviewer is an artifact consumer ───────────────

import { outcomeHumanReviewers } from './outcome-consumers.js';

const humans = [
  { id: 'ba-human', name: 'BA Human', consumes: [{ artifact: 'issue', from: 'dev' }] },
  { id: 'maintainer', name: 'Maintainer', consumes: [{ artifact: 'pr', from: 'dev' }] },
  { id: 'other', name: 'Elsewhere', consumes: [{ artifact: 'issue', from: 'someone-else' }] },
  { id: 'label-only', name: 'Decider', consumes: [{ label: 'hold' }] },
];

test('outcomeHumanReviewers matches the artifact kind and the producing node', () => {
  assert.deepEqual(outcomeHumanReviewers({ actions: [{ type: 'openIssue' }] }, node, humans), ['BA Human']);
  assert.deepEqual(outcomeHumanReviewers({ actions: [{ type: 'openPr' }] }, node, humans), ['Maintainer']);
  // Both artifact actions union their reviewers.
  assert.deepEqual(
    outcomeHumanReviewers({ actions: [{ type: 'openIssue' }, { type: 'openPr' }] }, node, humans),
    ['BA Human', 'Maintainer'],
  );
});

test('outcomeHumanReviewers ignores non-artifact actions, other producers, label consumes', () => {
  // setLabel-only outcome: nothing to review.
  assert.deepEqual(outcomeHumanReviewers({ actions: [{ type: 'setLabel', label: 'ready' }] }, node, humans), []);
  // A consume bound to a different producer does not count.
  assert.deepEqual(outcomeHumanReviewers({ actions: [{ type: 'openIssue' }] }, { id: 'qa' }, humans), []);
  // Degenerate inputs stay empty.
  assert.deepEqual(outcomeHumanReviewers(null, node, humans), []);
  assert.deepEqual(outcomeHumanReviewers({ actions: [{ type: 'openIssue' }] }, node, null), []);
  assert.deepEqual(outcomeHumanReviewers({ actions: [{ type: 'openIssue' }] }, node, [null, {}]), []);
});

test('outcomeHumanReviewers falls back displayName → name → id and accepts graph human nodes', () => {
  // Raw registry entry without a name.
  assert.deepEqual(
    outcomeHumanReviewers({ actions: [{ type: 'openPr' }] }, node,
      [{ id: 'rev', consumes: [{ artifact: 'pr', from: 'dev' }] }]),
    ['rev'],
  );
  // A graph `kind: 'human'` node carries displayName instead of name.
  assert.deepEqual(
    outcomeHumanReviewers({ actions: [{ type: 'openPr' }] }, node,
      [{ id: 'rev', displayName: 'Reviewer', kind: 'human', consumes: [{ artifact: 'pr', from: 'dev' }] }]),
    ['Reviewer'],
  );
});
