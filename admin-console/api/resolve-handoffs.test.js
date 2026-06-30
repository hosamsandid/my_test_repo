'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveHandoffs } = require('./resolve-handoffs');
const { buildUnifiedGraph } = require('./unified-graph');

// A mixed flow: 'a' hands off three ways — a label to 'b', an artifact to 'c',
// and 'd' depends on 'a'. (dependency edge is from:a → to:d.)
function mixedGraph() {
  return buildUnifiedGraph([
    { id: 'a', triggers: [{ id: 't', type: 'github-event', events: ['x'], from: 'any-except-self', emits: ['go'] }], outputs: [{ path: 'spec.md' }] },
    { id: 'b', triggers: [{ id: 't2', type: 'github-event', labelFilter: 'go', from: 'any-except-self', emits: [] }] },
    { id: 'c', triggers: [], inputs: [{ path: 'spec.md' }] },
    { id: 'd', triggers: [], dependsOn: ['a'] },
  ]);
}

test('resolves downstream hand-offs across all edge types from one node', () => {
  const { targets } = resolveHandoffs(mixedGraph(), 'a');
  const tos = targets.map(t => `${t.on}:${t.to}`).sort();
  assert.deepEqual(tos, ['artifact:c', 'dependency:d', 'label:b']);
});

test('artifact production and label emission fan out through the same resolver (decision 4)', () => {
  // Only the artifact path was written → the artifact target still resolves,
  // and (label unrestricted here) the label target too — the mechanism is unified.
  const g = mixedGraph();
  const onlyPaths = resolveHandoffs(g, { node: 'a', paths: ['spec.md'], labels: [] });
  assert.ok(onlyPaths.targets.find(t => t.on === 'artifact' && t.to === 'c'));
  assert.ok(!onlyPaths.targets.find(t => t.on === 'label'), 'empty label set suppresses label edges');

  const onlyLabel = resolveHandoffs(g, { node: 'a', labels: ['go'], paths: [] });
  assert.ok(onlyLabel.targets.find(t => t.on === 'label' && t.to === 'b'));
  assert.ok(!onlyLabel.targets.find(t => t.on === 'artifact'), 'empty path set suppresses artifact edges');
});

test('label filter narrows to the emitted labels', () => {
  const g = buildUnifiedGraph([
    { id: 'a', triggers: [{ id: 't', type: 'github-event', events: ['x'], from: 'any-except-self', emits: ['go', 'stop'] }] },
    { id: 'b', triggers: [{ id: 't2', type: 'github-event', labelFilter: 'go', emits: [] }] },
    { id: 'c', triggers: [{ id: 't3', type: 'github-event', labelFilter: 'stop', emits: [] }] },
  ]);
  const { targets } = resolveHandoffs(g, { node: 'a', labels: ['go'] });
  assert.deepEqual(targets.filter(t => t.on === 'label').map(t => t.to), ['b']);
});

test('dependency edges fire on completion, are suppressed when not completed', () => {
  const g = mixedGraph();
  assert.ok(resolveHandoffs(g, { node: 'a', completed: true }).targets.find(t => t.on === 'dependency'));
  assert.ok(!resolveHandoffs(g, { node: 'a', completed: false }).targets.find(t => t.on === 'dependency'));
});

test('Layer 0: a node never hands off to itself', () => {
  const g = buildUnifiedGraph([
    // cron self-loop + a self artifact (consumes own output) must never appear.
    { id: 'a', triggers: [{ id: 'c', type: 'cron', cron: '0 9 * * 1', emits: [] }] },
  ]);
  assert.deepEqual(resolveHandoffs(g, 'a').targets, []);
});

test('hierarchy (on:parent) edges never route — parents are view-only', () => {
  const g = buildUnifiedGraph([
    { id: 'p', triggers: [], children: ['c'] },
    { id: 'c', triggers: [], parent: 'p' },
  ]);
  // p → c exists as a parent edge, but resolving from the parent yields nothing.
  assert.ok(g.edges.find(e => e.on === 'parent' && e.from === 'p' && e.to === 'c'));
  assert.deepEqual(resolveHandoffs(g, 'p').targets, []);
});

test('unknown / empty source yields no targets', () => {
  assert.deepEqual(resolveHandoffs(mixedGraph(), 'zzz').targets, []);
  assert.deepEqual(resolveHandoffs(mixedGraph(), {}).targets, []);
  assert.deepEqual(resolveHandoffs(null, 'a').targets, []);
});
