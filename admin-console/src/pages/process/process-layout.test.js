import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeGraph, computeRanks, orderWithinRanks } from './process-layout.js';

test('normalizeGraph expands null endpoints into synthetic nodes', () => {
  const { nodes, edges } = normalizeGraph({
    nodes: [{ id: 'rel' }, { id: 'dev' }],
    edges: [
      { from: null, to: 'rel', label: 'human:go-live-approved', kind: 'gate' },
      { from: null, to: 'rel', label: 'hold', kind: 'brake' },
      { from: null, to: 'dev', label: 'assigned:dev', kind: 'agent', orphan: true },
      { from: 'dev', to: null, label: 'started:dev', kind: 'agent', deadEnd: true },
    ],
  });
  const ids = nodes.map(n => n.id);
  assert.ok(ids.includes('gate:human:go-live-approved'));
  assert.ok(ids.includes('brake:hold'));
  assert.ok(ids.includes('orphan:assigned:dev'));
  assert.ok(ids.includes('deadend:started:dev'));
  // every edge now has concrete endpoints
  assert.ok(edges.every(e => e.from !== null && e.to !== null));
  const gate = nodes.find(n => n.id === 'gate:human:go-live-approved');
  assert.equal(gate.synthetic, true);
  assert.equal(gate.syntheticKind, 'gate');
  assert.equal(gate.displayName, 'human:go-live-approved');
});

test('synthetic nodes are shared across multiple edges with the same label', () => {
  const { nodes } = normalizeGraph({
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [
      { from: null, to: 'a', label: 'human:x', kind: 'gate' },
      { from: null, to: 'b', label: 'human:x', kind: 'gate' },
    ],
  });
  assert.equal(nodes.filter(n => n.id === 'gate:human:x').length, 1);
});

test('computeRanks: longest-path layering', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const edges = [
    { from: 'a', to: 'b', kind: 'agent' },
    { from: 'b', to: 'c', kind: 'agent' },
  ];
  const rank = computeRanks(nodes, edges);
  assert.equal(rank.a, 0);
  assert.equal(rank.b, 1);
  assert.equal(rank.c, 2);
});

test('computeRanks: timers and self-loops do not affect ranks', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }];
  const edges = [
    { from: 'a', to: 'a', kind: 'timer' },
    { from: 'a', to: 'b', kind: 'agent' },
  ];
  const rank = computeRanks(nodes, edges);
  assert.equal(rank.a, 0);
  assert.equal(rank.b, 1);
});

test('computeRanks: tolerates a back-edge / cycle without blowing up', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const edges = [
    { from: 'a', to: 'b', kind: 'agent' },
    { from: 'b', to: 'c', kind: 'agent' },
    { from: 'c', to: 'a', kind: 'agent' }, // back-edge
  ];
  const rank = computeRanks(nodes, edges);
  // all ranks bounded by node count + 1 (no infinite growth)
  for (const id of ['a', 'b', 'c']) assert.ok(rank[id] <= nodes.length + 1);
});

test('orderWithinRanks: groups by rank and sorts columns', () => {
  const nodes = [{ id: 'src' }, { id: 'l1' }, { id: 'l2' }];
  const edges = [
    { from: 'src', to: 'l1', kind: 'agent' },
    { from: 'src', to: 'l2', kind: 'agent' },
  ];
  const rank = computeRanks(nodes, edges);
  const { cols, ranksSorted } = orderWithinRanks(nodes, edges, rank);
  assert.deepEqual(ranksSorted, [0, 1]);
  assert.deepEqual(cols[0], ['src']);
  assert.deepEqual(new Set(cols[1]), new Set(['l1', 'l2']));
});

test('end-to-end: normalize → rank places a gate left of its consumer', () => {
  const { nodes, edges } = normalizeGraph({
    nodes: [{ id: 'rel' }],
    edges: [{ from: null, to: 'rel', label: 'human:go-live-approved', kind: 'gate' }],
  });
  const rank = computeRanks(nodes, edges);
  assert.ok(rank['gate:human:go-live-approved'] < rank['rel']);
});
