import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeFlowLayout,
  acyclicEdges,
  longestPathLayers,
  countCrossings,
  WRAP_MIN_COLUMN,
  membersPerLine,
  wrapColumn,
  wrapColumns,
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

const stageBy = (map) => (id) => (id in map ? map[id] : null);

// Stage order overrides the automatic columns.
test('stage order overrides auto columns', () => {
  const ids = ['build', 'design', 'release'];
  // auto layering alone would put these all on column 0 (no edges)
  const edges = [];
  const { colOf } = computeFlowLayout(ids, edges, {
    stageOf: stageBy({ design: 'Design', build: 'Build', release: 'Release' }),
    stageOrder: ['Design', 'Build', 'Release'],
  });
  assert.equal(colOf.get('design'), 0);
  assert.equal(colOf.get('build'), 1);
  assert.equal(colOf.get('release'), 2);
});

// Unstaged nodes gravitate to the column of their neighbours.
test('unstaged node settles next to its staged neighbours', () => {
  const ids = ['a', 'mid', 'c'];
  const edges = [{ from: 'a', to: 'mid' }, { from: 'mid', to: 'c' }];
  const { colOf } = computeFlowLayout(ids, edges, {
    stageOf: stageBy({ a: 'First', c: 'Third' }), // `mid` has no stage
    stageOrder: ['First', 'Second', 'Third'],     // empty stage keeps one column
  });
  assert.equal(colOf.get('mid'), 1); // pulled between its neighbours
});

// ── stage partitioning: stages own exclusive column blocks ──────────────────

// A multi-column stage pushes the next stage past its WHOLE block — nodes of
// two stages can never share a column, so their bands can't overlap.
test('stages own disjoint contiguous column blocks', () => {
  const ids = ['a1', 'a2', 'a3', 'b1', 'b2'];
  const edges = [
    { from: 'a1', to: 'a2' }, { from: 'a2', to: 'a3' }, // stage A is 3 columns deep
    { from: 'a1', to: 'b1' },                            // b1 alone would land on column 1
    { from: 'b1', to: 'b2' },
  ];
  const { colOf } = computeFlowLayout(ids, edges, {
    stageOf: stageBy({ a1: 'A', a2: 'A', a3: 'A', b1: 'B', b2: 'B' }),
    stageOrder: ['A', 'B'],
  });
  const aMax = Math.max(colOf.get('a1'), colOf.get('a2'), colOf.get('a3'));
  const bMin = Math.min(colOf.get('b1'), colOf.get('b2'));
  assert.equal(aMax, 2);
  assert.ok(bMin > aMax); // B starts strictly after A's block
  assert.equal(colOf.get('b2'), colOf.get('b1') + 1); // internal flow preserved
});

// Stages missing from the defined order (or with no defined order at all) are
// still partitioned — ordered by where the plain layering puts their nodes.
test('stages without a defined order are derived from the graph flow', () => {
  const ids = ['r1', 'r2', 'f1', 'v1'];
  const edges = [
    { from: 'r1', to: 'r2' },
    { from: 'r2', to: 'f1' },
    { from: 'f1', to: 'v1' },
  ];
  const { colOf } = computeFlowLayout(ids, edges, {
    stageOf: stageBy({ r1: 'Reverse', r2: 'Reverse', f1: 'Forward', v1: 'Verify' }),
    stageOrder: [], // nothing authored
  });
  const rMax = Math.max(colOf.get('r1'), colOf.get('r2'));
  assert.ok(colOf.get('f1') > rMax);            // Forward past all of Reverse
  assert.ok(colOf.get('v1') > colOf.get('f1')); // Verify past Forward
});

// A back edge (rework) into an earlier stage must not drag that stage's nodes
// into the later stage's block.
test('rework edge across stages keeps the blocks separated', () => {
  const ids = ['a1', 'a2', 'b1'];
  const edges = [
    { from: 'a1', to: 'a2' },
    { from: 'a2', to: 'b1' },
    { from: 'b1', to: 'a1' }, // rework back into stage A
  ];
  const { colOf } = computeFlowLayout(ids, edges, {
    stageOf: stageBy({ a1: 'A', a2: 'A', b1: 'B' }),
    stageOrder: ['A', 'B'],
  });
  assert.ok(Math.max(colOf.get('a1'), colOf.get('a2')) < colOf.get('b1'));
});

// Crossing reduction improves a deliberately-tangled bipartite graph.
test('ordering reduces crossings vs. the naive order', () => {
  const ids = ['a1', 'a2', 'b1', 'b2'];
  // a1→b2 and a2→b1 cross if kept in input order; the sweep should uncross them.
  const edges = [{ from: 'a1', to: 'b2' }, { from: 'a2', to: 'b1' }];
  const { columns, colOf } = computeFlowLayout(ids, edges);
  assert.equal(countCrossings(columns, edges, colOf), 0);
});

// ── sibling groups (parent-child hierarchy) ─────────────────────────────────

const groupBy = (map) => (id) => (id in map ? map[id] : null);

// All children of one parent share a column, even when a hand-off between the
// siblings would otherwise stagger them into consecutive columns.
test('sibling group shares one column despite intra-group hand-offs', () => {
  const ids = ['p', 'c1', 'c2'];
  const edges = [
    { from: 'p', to: 'c1' }, { from: 'p', to: 'c2' }, // hierarchy
    { from: 'c1', to: 'c2' },                          // hand-off between siblings
  ];
  const { colOf } = computeFlowLayout(ids, edges, { groupOf: groupBy({ c1: 'p', c2: 'p' }) });
  assert.equal(colOf.get('p'), 0);
  assert.equal(colOf.get('c1'), 1);
  assert.equal(colOf.get('c2'), 1); // without the group c2 would land on column 2
});

// A consumer outside the group still sits past the whole group.
test('downstream node comes after the whole sibling group', () => {
  const ids = ['p', 'c1', 'c2', 'd'];
  const edges = [
    { from: 'p', to: 'c1' }, { from: 'p', to: 'c2' },
    { from: 'c2', to: 'd' },
  ];
  const { colOf } = computeFlowLayout(ids, edges, { groupOf: groupBy({ c1: 'p', c2: 'p' }) });
  assert.equal(colOf.get('c1'), 1);
  assert.equal(colOf.get('c2'), 1);
  assert.equal(colOf.get('d'), 2);
});

// A pulled-forward sibling (fed by a longer chain) drags the group with it, so
// the group still shares one column.
test('group snaps to its deepest member', () => {
  const ids = ['p', 'x', 'y', 'c1', 'c2'];
  const edges = [
    { from: 'p', to: 'c1' }, { from: 'p', to: 'c2' },
    { from: 'x', to: 'y' }, { from: 'y', to: 'c2' }, // c2 alone would be col 2
  ];
  const { colOf } = computeFlowLayout(ids, edges, { groupOf: groupBy({ c1: 'p', c2: 'p' }) });
  assert.equal(colOf.get('c1'), colOf.get('c2'));
  assert.ok(colOf.get('c2') >= 2);
});

// Group members stay contiguous within their column even when an unrelated
// node lands in the same column between them (input order would interleave).
test('sibling group is contiguous within its column', () => {
  const ids = ['p', 'x', 'c1', 'y', 'c2'];
  const edges = [
    { from: 'p', to: 'c1' }, { from: 'p', to: 'c2' },
    { from: 'x', to: 'y' }, // unrelated pipeline whose `y` shares column 1
  ];
  const { columns, colOf } = computeFlowLayout(ids, edges, { groupOf: groupBy({ c1: 'p', c2: 'p' }) });
  const col = columns[colOf.get('c1')];
  assert.equal(colOf.get('c1'), colOf.get('c2'));
  assert.equal(Math.abs(col.indexOf('c1') - col.indexOf('c2')), 1); // adjacent
});

// Nested hierarchy: grandchildren form their own group one column further.
test('nested groups: grandchildren sit one column past their parent group', () => {
  const ids = ['p', 'c1', 'c2', 'g1', 'g2'];
  const edges = [
    { from: 'p', to: 'c1' }, { from: 'p', to: 'c2' },
    { from: 'c1', to: 'g1' }, { from: 'c1', to: 'g2' },
  ];
  const { colOf } = computeFlowLayout(ids, edges, {
    groupOf: groupBy({ c1: 'p', c2: 'p', g1: 'c1', g2: 'c1' }),
  });
  assert.equal(colOf.get('c1'), colOf.get('c2'));
  assert.equal(colOf.get('g1'), colOf.get('g2'));
  assert.equal(colOf.get('g1'), colOf.get('c1') + 1);
});

// With stages in play, the group still ends up in one column (the group's
// stage — the first member's non-empty stage — wins for all members).
test('groups survive the stage partitioning', () => {
  const ids = ['p', 'c1', 'c2'];
  const edges = [{ from: 'p', to: 'c1' }, { from: 'p', to: 'c2' }];
  const { colOf } = computeFlowLayout(ids, edges, {
    stageOf: stageBy({ p: 'Plan', c2: 'Impl' }), // c1 unstaged
    stageOrder: ['Plan', 'Mid', 'Impl'],
    groupOf: groupBy({ c1: 'p', c2: 'p' }),
  });
  assert.equal(colOf.get('c1'), colOf.get('c2'));
  assert.ok(colOf.get('c1') > colOf.get('p'));
});


// ── over-wide column wrapping ───────────────────────────────────────────────
// One column is one layer, and for a hierarchy that is every sibling of one
// parent — a BriefingPack pack with 270 children used to lay them out in a
// single ~100 000px line. These lock in the wrapping that bounds it.

// The renderer's real numbers for a top→down flow: 320px card + 50px gap, with a
// 6 000px cross-axis budget.
const CARD = 320 + 50;
const BUDGET = 6000;
const wrapOpts = (over = {}) => ({ crossExtent: CARD, maxCrossExtent: BUDGET, ...over });
const ids = (n, p = 'n') => Array.from({ length: n }, (_, i) => p + i);

test('membersPerLine fits as many as the budget allows', () => {
  // 6000 / 370 = 16.2 → 16 across
  assert.equal(membersPerLine(16, CARD, BUDGET), 16);
  assert.equal(membersPerLine(5, CARD, BUDGET), 5, 'a short column is never padded out');
});

test('membersPerLine balances the lines instead of leaving a near-empty last one', () => {
  // 17 members with room for 16 → 2 lines, so 9 + 8 rather than 16 + 1
  assert.equal(membersPerLine(17, CARD, BUDGET), 9);
  // 270 → ceil(270/16) = 17 lines → ceil(270/17) = 16 per line
  assert.equal(membersPerLine(270, CARD, BUDGET), 16);
});

test('membersPerLine degrades safely on nonsense input', () => {
  assert.equal(membersPerLine(50, 10000, 100), 1, 'a card wider than the whole budget');
  assert.equal(membersPerLine(0, CARD, BUDGET), 1, 'an empty column');
  assert.equal(membersPerLine(5, 0, BUDGET), 5, 'a zero extent must not divide by zero');
  // No budget means "unbounded", NOT "one per line": a missing option must never
  // shred a flow into single-card rows.
  assert.equal(membersPerLine(5, CARD, 0), 5);
  assert.equal(membersPerLine(5, CARD, undefined), 5);
});

test('a column inside the budget is returned untouched, as one row', () => {
  const col = ids(16);
  const rows = wrapColumn(col, wrapOpts());
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], col);
  assert.notEqual(rows[0], col, 'returns a copy, not the array the caller passed in');
});

test('small columns are never wrapped, even under a tiny budget', () => {
  const col = ids(WRAP_MIN_COLUMN);
  assert.deepEqual(wrapColumn(col, wrapOpts({ maxCrossExtent: 1 })), [col]);
  // one past the threshold the budget starts to apply again
  assert.ok(wrapColumn(ids(WRAP_MIN_COLUMN + 1), wrapOpts({ maxCrossExtent: 1 })).length > 1);
});

test('the 270-sibling BriefingPack column wraps into a bounded block', () => {
  const rows = wrapColumn(ids(270), wrapOpts());
  assert.equal(rows.length, 17);
  assert.equal(rows[0].length, 16);
  assert.equal(rows.at(-1).length, 270 - 16 * 16, 'the remainder lands in the last row');
  const widest = Math.max(...rows.map(r => r.length));
  assert.ok(widest * CARD <= BUDGET, `block is ${widest * CARD}px wide, budget ${BUDGET}px`);
});

test('wrapping preserves order, loses nothing and duplicates nothing', () => {
  const col = ids(270);
  const flat = wrapColumn(col, wrapOpts()).flat();
  assert.deepEqual(flat, col);
  assert.equal(new Set(flat).size, col.length);
});

test('the block stays bounded as the column keeps growing', () => {
  for (const n of [40, 120, 270, 648, 2000]) {
    const rows = wrapColumn(ids(n), wrapOpts());
    const widest = Math.max(...rows.map(r => r.length));
    assert.ok(widest * CARD <= BUDGET, `n=${n}: ${widest * CARD}px exceeds the budget`);
    assert.equal(rows.flat().length, n, `n=${n}: members lost`);
  }
});

test('a left→right flow wraps on measured card heights, not the card width', () => {
  // cross axis is y there, so the extent is the card height + a 34px gap
  const rows = wrapColumn(ids(100), { crossExtent: 120 + 34, maxCrossExtent: BUDGET });
  assert.equal(membersPerLine(100, 154, BUDGET), 34);
  assert.equal(rows.length, 3);
  assert.equal(rows.flat().length, 100);
});

test('wrapColumns applies per column and can size each one differently', () => {
  const cols = [ids(3, 'a'), ids(270, 'b'), ids(9, 'c')];
  const rows = wrapColumns(cols, {
    crossExtentOf: col => (col[0].startsWith('c') ? 3000 : CARD),
    maxCrossExtent: BUDGET,
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], [cols[0]], 'short column: single row');
  assert.equal(rows[1].length, 17, 'wide column: wrapped');
  // 9 cards at 3000px each would be 27 000px, but 9 > WRAP_MIN_COLUMN so it wraps
  assert.ok(rows[2].length > 1, 'a column of very wide cards wraps too');
  assert.deepEqual(rows.flat().flat().sort(), [...cols.flat()].sort());
});

test('wrapColumns accepts a constant extent and tolerates an empty graph', () => {
  assert.deepEqual(wrapColumns([[]], { crossExtentOf: CARD, maxCrossExtent: BUDGET }), [[[]]]);
  assert.deepEqual(wrapColumns([], { crossExtentOf: CARD, maxCrossExtent: BUDGET }), []);
  assert.deepEqual(wrapColumns(undefined, {}), []);
});
