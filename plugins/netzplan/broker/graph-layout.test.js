'use strict';

// Unit tests for the pure graph-layout module (ui/graph-layout.js). Matches the
// broker's existing `node --test` discipline (plan-doc.test.js, etc.). The
// module is dual-mode (browser <script> + CommonJS); here we exercise the
// CommonJS export.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const PlanLayout = require('./ui/graph-layout');

function panel({ bands = [], nodes = [], edges = [] }) {
  return { id: 'p-1', kind: 'graph', title: '', bands, nodes, edges };
}

test('columnsOf: a linear feed-chain lays out into successive columns', () => {
  const ids = ['a', 'b', 'c'];
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }];
  const col = PlanLayout.columnsOf(ids, edges);
  assert.equal(col.a, 0);
  assert.equal(col.b, 1);
  assert.equal(col.c, 2);
});

test('columnsOf: a diamond puts the sink one past its deepest feeder', () => {
  const ids = ['a', 'b', 'c', 'd'];
  // a → b → d, a → c → d
  const edges = [
    { from: 'a', to: 'b' }, { from: 'a', to: 'c' },
    { from: 'b', to: 'd' }, { from: 'c', to: 'd' },
  ];
  const col = PlanLayout.columnsOf(ids, edges);
  assert.equal(col.a, 0);
  assert.equal(col.b, 1);
  assert.equal(col.c, 1);
  assert.equal(col.d, 2);
});

test('columnsOf: a cycle still terminates and assigns every node a finite column', () => {
  const ids = ['a', 'b', 'c'];
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }];
  const col = PlanLayout.columnsOf(ids, edges);
  ids.forEach((id) => {
    assert.equal(typeof col[id], 'number');
    assert.ok(Number.isFinite(col[id]));
  });
});

test('compute: bands stack top-to-bottom by order without vertical overlap', () => {
  const p = panel({
    bands: [
      { id: 'b1', name: 'Phase 1', color: '#111', order: 0 },
      { id: 'b2', name: 'Phase 2', color: '#222', order: 1 },
    ],
    nodes: [
      { id: 'n1', label: 'A', bandId: 'b1', order: 0 },
      { id: 'n2', label: 'B', bandId: 'b2', order: 0 },
    ],
    edges: [],
  });
  const L = PlanLayout.compute(p);
  assert.equal(L.bands.length, 2);
  assert.equal(L.bands[0].id, 'b1');
  assert.equal(L.bands[1].id, 'b2');
  // band 2 begins below band 1's bottom
  assert.ok(L.bands[1].top >= L.bands[0].top + L.bands[0].height,
    'second band starts at or below the first band bottom');
});

test('compute: two nodes in the same band+column get distinct, non-overlapping rows', () => {
  const p = panel({
    bands: [{ id: 'b1', name: 'P', color: '#111', order: 0 }],
    nodes: [
      { id: 'n1', label: 'A', bandId: 'b1', order: 0 },
      { id: 'n2', label: 'B', bandId: 'b1', order: 1 },
    ],
    edges: [], // no edges → both in column 0
  });
  const L = PlanLayout.compute(p);
  const a = L.nodes.find((n) => n.id === 'n1');
  const b = L.nodes.find((n) => n.id === 'n2');
  assert.equal(a.col, 0);
  assert.equal(b.col, 0);
  assert.notEqual(a.subrow, b.subrow);
  // vertical spans do not overlap
  assert.ok(a.y + a.h <= b.y || b.y + b.h <= a.y, 'stacked nodes do not overlap');
});

test('compute: a feed-edge moves the downstream node into a later column (greater x)', () => {
  const p = panel({
    bands: [{ id: 'b1', name: 'P', color: '#111', order: 0 }],
    nodes: [
      { id: 'n1', label: 'A', bandId: 'b1', order: 0 },
      { id: 'n2', label: 'B', bandId: 'b1', order: 1 },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', type: 'depends' }],
  });
  const L = PlanLayout.compute(p);
  const a = L.nodes.find((n) => n.id === 'n1');
  const b = L.nodes.find((n) => n.id === 'n2');
  assert.equal(a.col, 0);
  assert.equal(b.col, 1);
  assert.ok(b.x > a.x, 'downstream node sits to the right');
  // the single edge is anchored from a's right face to b's left face
  assert.equal(L.edges.length, 1);
  const e = L.edges[0];
  assert.equal(e.x1, a.x + a.w);
  assert.equal(e.x2, b.x);
  assert.equal(e.backward, false);
});

test('compute: an unbanded node gets a synthetic band so it still renders', () => {
  const p = panel({
    bands: [{ id: 'b1', name: 'P', color: '#111', order: 0 }],
    nodes: [{ id: 'n1', label: 'orphan', bandId: null, order: 0 }],
    edges: [],
  });
  const L = PlanLayout.compute(p);
  const synthetic = L.bands.find((b) => b.synthetic);
  assert.ok(synthetic, 'a synthetic band exists');
  assert.equal(synthetic.id, '');
  const n = L.nodes.find((x) => x.id === 'n1');
  assert.ok(n.y >= synthetic.top, 'orphan node lives inside the synthetic band');
});

test('compute: an edge to a missing node is dropped rather than throwing', () => {
  const p = panel({
    bands: [{ id: 'b1', name: 'P', color: '#111', order: 0 }],
    nodes: [{ id: 'n1', label: 'A', bandId: 'b1', order: 0 }],
    edges: [{ id: 'e1', from: 'n1', to: 'ghost', type: 'depends' }],
  });
  const L = PlanLayout.compute(p);
  assert.equal(L.edges.length, 0);
});

test('compute: an empty panel yields empty geometry with a positive canvas size', () => {
  const L = PlanLayout.compute(panel({}));
  assert.equal(L.nodes.length, 0);
  assert.equal(L.edges.length, 0);
  assert.ok(L.width > 0);
  assert.ok(L.height > 0);
});
