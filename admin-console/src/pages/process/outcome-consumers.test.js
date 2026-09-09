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

/* ── direct hand-offs (#2057) ─────────────────────────────────────────── */

import {
  outcomeHandoffs, handoffStatement,
  HANDOFF_OK, HANDOFF_UNRESOLVED, HANDOFF_DISABLED,
} from './outcome-consumers.js';
import { WAKE_EDGE_LEGEND } from './wake-edge-view.js';

// A flow whose peers mirror what `GET /api/process/graph` returns: agents with a
// `triggers` view (the derived `wake-agent` listener included), a human role and
// an actor pseudo-node.
const wakePeers = [
  { id: 'dev', displayName: 'Developer' },
  { id: 'reviewer', displayName: 'Code Reviewer', triggers: [{ id: 'w1', type: 'wake-agent', enabled: true }] },
  { id: 'docs', displayName: 'Documentation Sync', triggers: [{ id: 'w2', type: 'wake-agent', enabled: false }] },
  { id: 'qa', displayName: 'QA' },
  { id: 'maintainer', displayName: 'Maintainer', kind: 'human' },
  { id: '@github', displayName: 'GitHub', kind: 'actor' },
];
const handoffTo = (to, extra) => ({ id: 'o', actions: [{ type: 'wakeAgent', to, ...extra }] });

test('#2057 AC1: a hand-off to a resolvable, enabled agent is a consumer', () => {
  assert.deepEqual(outcomeHandoffs(handoffTo('reviewer'), node, wakePeers),
    [{ to: 'reviewer', name: 'Code Reviewer', state: HANDOFF_OK }]);
  // A target with no derived listener yet (a draft, or one the reconciler has
  // not visited) is still ok — the listener is derived, never authored.
  assert.deepEqual(outcomeHandoffs(handoffTo('qa'), node, wakePeers),
    [{ to: 'qa', name: 'QA', state: HANDOFF_OK }]);
});

test('#2057 AC2: the healthy statement is uniform and reuses the canvas/event-log wording', () => {
  const [h] = outcomeHandoffs(handoffTo('reviewer'), node, wakePeers);
  assert.deepEqual(handoffStatement(h), { tone: 'neutral', text: 'wakes Code Reviewer (direct hand-off)' });
  assert.equal(WAKE_EDGE_LEGEND, 'direct hand-off');
  // AC3 — not warning-coloured: it describes a correctly wired hand-off.
  assert.equal(handoffStatement(h).tone, 'neutral');
});

test('#2057 AC6: an unresolved target is reported, warning-coloured, and never a consumer', () => {
  // A stale id from an import.
  assert.deepEqual(outcomeHandoffs(handoffTo('gone'), node, wakePeers),
    [{ to: 'gone', name: 'gone', state: HANDOFF_UNRESOLVED }]);
  // A person has no queue; an actor pseudo-node is not an agent either.
  assert.equal(outcomeHandoffs(handoffTo('maintainer'), node, wakePeers)[0].state, HANDOFF_UNRESOLVED);
  assert.equal(outcomeHandoffs(handoffTo('@github'), node, wakePeers)[0].state, HANDOFF_UNRESOLVED);
  // A self-hand-off is refused on delivery, so it must not read as a consumer.
  assert.equal(outcomeHandoffs(handoffTo('dev'), node, wakePeers)[0].state, HANDOFF_UNRESOLVED);
  const s = handoffStatement(outcomeHandoffs(handoffTo('gone'), node, wakePeers)[0]);
  assert.deepEqual(s, { tone: 'warning', text: 'hands off directly to gone — target unresolved' });
});

test('#2057 AC7: a target whose hand-off input is switched off is warning-coloured', () => {
  assert.deepEqual(outcomeHandoffs(handoffTo('docs'), node, wakePeers),
    [{ to: 'docs', name: 'Documentation Sync', state: HANDOFF_DISABLED }]);
  assert.deepEqual(handoffStatement({ to: 'docs', name: 'Documentation Sync', state: HANDOFF_DISABLED }),
    { tone: 'warning', text: "hands off directly to Documentation Sync — target's hand-off input is disabled" });
  // One enabled listener is enough (the runner takes the first enabled one).
  const mixed = [{ id: 'docs', displayName: 'Docs', triggers: [
    { type: 'wake-agent', enabled: false }, { type: 'wake-agent', enabled: true },
  ] }];
  assert.equal(outcomeHandoffs(handoffTo('docs'), node, mixed)[0].state, HANDOFF_OK);
});

test('#2057 AC8/AC10: a hand-off is derived independently of labels and markers', () => {
  // Mixed actions: the label's subscribers come from consumersFor, the hand-off
  // from here — neither at the expense of the other.
  const mixed = { id: 'o', actions: [
    { type: 'setLabel', label: 'ready-for-review' },
    { type: 'wakeAgent', to: 'reviewer' },
  ] };
  assert.deepEqual(consumersFor(mixed, node, peers), ['Code Reviewer']);
  assert.equal(outcomeHandoffs(mixed, node, wakePeers).length, 1);
  // A `terminal`/`external` marker is a sibling field and changes nothing here,
  // so the panel can render the contradiction rather than hide half of it.
  assert.equal(outcomeHandoffs({ ...handoffTo('reviewer'), terminal: true }, node, wakePeers).length, 1);
  assert.equal(outcomeHandoffs({ ...handoffTo('reviewer'), external: {} }, node, wakePeers).length, 1);
});

test('#2057: two hand-offs name both targets; one target is named once', () => {
  const two = { id: 'o', actions: [
    { type: 'wakeAgent', to: 'reviewer' }, { type: 'wakeAgent', to: 'qa' },
  ] };
  assert.deepEqual(outcomeHandoffs(two, node, wakePeers).map(h => h.to), ['reviewer', 'qa']);
  const dup = { id: 'o', actions: [
    { type: 'wakeAgent', to: 'reviewer', note: 'a' }, { type: 'wakeAgent', to: 'reviewer', note: 'b' },
  ] };
  assert.deepEqual(outcomeHandoffs(dup, node, wakePeers).map(h => h.to), ['reviewer']);
});

test('#2057: a `to`-less hand-off names nobody, and degenerate input stays empty', () => {
  assert.deepEqual(outcomeHandoffs(handoffTo(''), node, wakePeers), []);
  assert.deepEqual(outcomeHandoffs({ id: 'o', actions: [{ type: 'wakeAgent' }] }, node, wakePeers), []);
  assert.deepEqual(outcomeHandoffs({ id: 'o', actions: [{ type: 'wakeAgent', to: '   ' }] }, node, wakePeers), []);
  assert.deepEqual(outcomeHandoffs({ actions: [{ type: 'setLabel', label: 'x' }] }, node, wakePeers), []);
  assert.deepEqual(outcomeHandoffs(null, node, wakePeers), []);
  assert.deepEqual(outcomeHandoffs(handoffTo('reviewer'), node, null), [
    { to: 'reviewer', name: 'reviewer', state: HANDOFF_UNRESOLVED }]);
  assert.deepEqual(outcomeHandoffs(handoffTo('reviewer'), null, [{ id: 'reviewer' }]), [
    { to: 'reviewer', name: 'reviewer', state: HANDOFF_OK }]);
  assert.deepEqual(outcomeHandoffs({ actions: null }, node, wakePeers), []);
});

test('#2057 AC14: the pre-existing consumer cases are unaffected by the new derivation', () => {
  // A label / artifact / none outcome yields no hand-off at all, so every
  // existing branch of both surfaces still sees exactly what it saw before.
  for (const o of [
    { actions: [{ type: 'setLabel', label: 'ready-for-review' }] },
    { actions: [{ type: 'openPr' }] },
    { actions: [{ type: 'openIssue' }] },
    { actions: [{ type: 'none' }] },
    { actions: [] },
  ]) assert.deepEqual(outcomeHandoffs(o, node, wakePeers), []);
});
