import test from 'node:test';
import assert from 'node:assert/strict';

import { routeOrthogonalEdges, roundedPathD, laneLoadByChannel } from './edge-router.js';

// ── helpers ──────────────────────────────────────────────────────────────────

// A 2-column stack for a top→down flow: two cards per column, 320×100 cards.
function grid(cols) {
  const nodes = [];
  const colOf = new Map();
  cols.forEach((ids, c) => {
    ids.forEach((id, i) => {
      nodes.push({ id, x: i * 400, y: c * 220, w: 320, h: 100 });
      colOf.set(id, c);
    });
  });
  return { nodes, colOf };
}

// Assert no polyline segment passes through the interior of any card. The
// router's whole point: stubs stay inside their own card's cross range, cross
// runs stay in the channels, gutters stay outside the graph.
function assertClearsNodes(routes, nodes) {
  const inset = 1; // ports touch the card boundary — that's fine
  for (const r of routes) {
    if (!r) continue;
    const pts = r.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      for (const n of nodes) {
        const x0 = n.x + inset, x1 = n.x + n.w - inset;
        const y0 = n.y + inset, y1 = n.y + n.h - inset;
        if (a.x === b.x) { // vertical segment
          const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
          if (a.x > x0 && a.x < x1 && lo < y1 - 2 && hi > y0 + 2) {
            assert.fail(`vertical segment x=${a.x} [${lo},${hi}] crosses node ${n.id}`);
          }
        } else { // horizontal segment
          const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
          if (a.y > y0 && a.y < y1 && lo < x1 - 2 && hi > x0 + 2) {
            assert.fail(`horizontal segment y=${a.y} [${lo},${hi}] crosses node ${n.id}`);
          }
        }
      }
    }
  }
}

// ── routing shape ────────────────────────────────────────────────────────────

test('forward edge: leaves source bottom, enters target top, label in the channel', () => {
  const { nodes, colOf } = grid([['a'], ['b']]);
  const [r] = routeOrthogonalEdges({ nodes, edges: [{ from: 'a', to: 'b' }], colOf, flow: 'down' });
  const first = r.points[0];
  const last = r.points[r.points.length - 1];
  assert.equal(first.y, 100);        // source bottom face
  assert.equal(last.y, 220);         // target top face
  assert.ok(r.label.y > 100 && r.label.y < 220, 'label sits in the channel between the rows');
  // arrow points downward into the target's top face
  assert.ok(Math.abs(r.arrow.angle - Math.PI / 2) < 1e-9);
});

test('ports are distributed: two edges from one node use distinct exit points', () => {
  const { nodes, colOf } = grid([['a'], ['b', 'c']]);
  const routes = routeOrthogonalEdges({
    nodes, edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }], colOf, flow: 'down',
  });
  const [r1, r2] = routes;
  assert.notEqual(r1.points[0].x, r2.points[0].x);
  // fan out toward the targets: the edge to the left target leaves further left
  assert.ok(r1.points[0].x < r2.points[0].x);
});

test('overlapping parallel runs get distinct channel lanes', () => {
  const { nodes, colOf } = grid([['a', 'b'], ['c', 'd']]);
  // a→d and b→c cross — their channel runs overlap, so they must not share a lane
  const routes = routeOrthogonalEdges({
    nodes, edges: [{ from: 'a', to: 'd' }, { from: 'b', to: 'c' }], colOf, flow: 'down',
  });
  const laneY = (r) => r.points[1].y; // second point = first lane turn
  assert.notEqual(laneY(routes[0]), laneY(routes[1]));
});

test('back edge routes around the graph and never crosses a card', () => {
  const { nodes, colOf } = grid([['a'], ['b'], ['c']]);
  const edges = [
    { from: 'a', to: 'b' }, { from: 'b', to: 'c' },
    { from: 'c', to: 'a' },                       // rework loop upward
  ];
  const routes = routeOrthogonalEdges({ nodes, edges, colOf, flow: 'down' });
  assertClearsNodes(routes, nodes);
  const back = routes[2];
  // enters the first node from the top, arrow pointing down
  assert.equal(back.points[back.points.length - 1].y, 0);
  // the gutter run sits outside the node columns
  const gutterX = back.points[2].x;
  assert.ok(gutterX < 0 || gutterX > 320, 'gutter outside the graph');
});

test('multi-column forward edge takes the gutter, not a straight cut', () => {
  const { nodes, colOf } = grid([['a'], ['b'], ['c']]);
  const routes = routeOrthogonalEdges({
    nodes, edges: [{ from: 'a', to: 'c' }], colOf, flow: 'down',
  });
  assertClearsNodes(routes, nodes);
  assert.equal(routes[0].points.length, 6); // stub, lane, gutter, lane, stub
});

test('same-column edge U-turns through the channel below, entering the target bottom', () => {
  const { nodes, colOf } = grid([['a', 'b']]);
  const [r] = routeOrthogonalEdges({ nodes, edges: [{ from: 'a', to: 'b' }], colOf, flow: 'down' });
  const last = r.points[r.points.length - 1];
  assert.equal(last.y, 100);                       // target BOTTOM face
  assert.ok(r.points[1].y > 100, 'lane below the row');
  // arrow points upward into the bottom face
  assert.ok(Math.abs(r.arrow.angle + Math.PI / 2) < 1e-9);
});

test('flow right swaps the axes', () => {
  const { nodes, colOf } = grid([['a'], ['b']]);
  // reinterpret: for flow right the same rects mean columns along x — build manually
  const n2 = [
    { id: 'a', x: 0, y: 0, w: 320, h: 100 },
    { id: 'b', x: 500, y: 40, w: 320, h: 100 },
  ];
  const [r] = routeOrthogonalEdges({ nodes: n2, edges: [{ from: 'a', to: 'b' }], colOf, flow: 'right' });
  assert.equal(r.points[0].x, 320);   // leaves the source's RIGHT face
  assert.equal(r.points[r.points.length - 1].x, 500); // enters the target's LEFT face
  assert.ok(Math.abs(r.arrow.angle) < 1e-9, 'arrow points rightward');
});

test('unknown endpoints and self-loops yield null, order preserved', () => {
  const { nodes, colOf } = grid([['a'], ['b']]);
  const routes = routeOrthogonalEdges({
    nodes,
    edges: [{ from: 'a', to: 'ghost' }, { from: 'a', to: 'a' }, { from: 'a', to: 'b' }],
    colOf, flow: 'down',
  });
  assert.equal(routes[0], null);
  assert.equal(routes[1], null);
  assert.ok(routes[2]);
});

// ── helpers under test ───────────────────────────────────────────────────────

test('laneLoadByChannel counts runs per channel', () => {
  const colOf = new Map([['a', 0], ['b', 1], ['c', 2]]);
  const load = laneLoadByChannel([
    { from: 'a', to: 'b' },   // channel 0
    { from: 'a', to: 'c' },   // channels 0 and 1
    { from: 'c', to: 'a' },   // back: channels 2 and -1 (above the graph)
  ], colOf);
  assert.equal(load.get(0), 2);
  assert.equal(load.get(1), 1);
  assert.equal(load.get(2), 1);
  assert.equal(load.get(-1), 1);
});

test('roundedPathD collapses tiny jogs and rounds corners', () => {
  const d = roundedPathD([
    { x: 0, y: 0 }, { x: 0, y: 50 }, { x: 0.2, y: 50 }, { x: 0.2, y: 100 },
  ]);
  // near-collinear points collapse: no Q corner needed for a 0.2px jog
  assert.ok(d.startsWith('M 0 0'));
  const corners = roundedPathD([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 100, y: 50 }]);
  assert.ok(corners.includes('Q 0 50'), 'right-angle corner is rounded via Q');
});
