import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeFlowLayout,
  acyclicEdges,
  longestPathLayers,
  countCrossings,
} from './flow-layout.js';

// A → B → C → D linear pipeline lays out as four ordered columns.
test('linear pipeline: one node per column, in order', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }];
  const { colOf } = computeFlowLayout(ids, edges);
  assert.equal(colOf.get('a'), 0);
  assert.equal(colOf.get('b'), 1);
  assert.equal(colOf.get('c'), 2);
  assert.equal(colOf.get('d'), 3);
});

// A fan-out: root feeds two leaves that both feed a sink → sink is last.
test('diamond: sink sits past both branches', () => {
  const ids = ['root', 'x', 'y', 'sink'];
  const edges = [
    { from: 'root', to: 'x' }, { from: 'root', to: 'y' },
    { from: 'x', to: 'sink' }, { from: 'y', to: 'sink' },
  ];
  const { colOf } = computeFlowLayout(ids, edges);
  assert.equal(colOf.get('root'), 0);
  assert.equal(colOf.get('x'), 1);
  assert.equal(colOf.get('y'), 1);
  assert.equal(colOf.get('sink'), 2);
});

// A rework loop (c → a) must not wedge the longest-path layering.
test('cycle is broken so layering terminates and stays sensible', () => {
  const ids = ['a', 'b', 'c'];
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }];
  const { keep, backEdges } = acyclicEdges(ids, edges);
  assert.equal(backEdges.size, 1); // c → a dropped
  const layer = longestPathLayers(ids, keep);
  assert.equal(layer.get('a'), 0);
  assert.equal(layer.get('b'), 1);
  assert.equal(layer.get('c'), 2);
});

// Stage order overrides the automatic columns (combined mode).
test('stage order overrides auto columns', () => {
  const ids = ['build', 'design', 'release'];
  // auto layering alone would put these all on column 0 (no edges)
  const edges = [];
  const rank = { design: 0, build: 1, release: 2 };
  const { colOf } = computeFlowLayout(ids, edges, {
    stageRankOf: (id) => (id in rank ? rank[id] : null),
    stageCount: 3,
  });
  assert.equal(colOf.get('design'), 0);
  assert.equal(colOf.get('build'), 1);
  assert.equal(colOf.get('release'), 2);
});

// Unstaged nodes gravitate to the column of their neighbours.
test('unstaged node settles next to its staged neighbours', () => {
  const ids = ['a', 'mid', 'c'];
  const edges = [{ from: 'a', to: 'mid' }, { from: 'mid', to: 'c' }];
  const rank = { a: 0, c: 2 }; // `mid` has no stage
  const { colOf } = computeFlowLayout(ids, edges, {
    stageRankOf: (id) => (id in rank ? rank[id] : null),
    stageCount: 3,
  });
  assert.equal(colOf.get('mid'), 1); // pulled between its neighbours
});

// Crossing reduction improves a deliberately-tangled bipartite graph.
test('ordering reduces crossings vs. the naive order', () => {
  const ids = ['a1', 'a2', 'b1', 'b2'];
  // a1→b2 and a2→b1 cross if kept in input order; the sweep should uncross them.
  const edges = [{ from: 'a1', to: 'b2' }, { from: 'a2', to: 'b1' }];
  const { columns, colOf } = computeFlowLayout(ids, edges);
  assert.equal(countCrossings(columns, edges, colOf), 0);
});
