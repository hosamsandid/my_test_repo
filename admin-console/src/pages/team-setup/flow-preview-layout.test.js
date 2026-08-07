import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PREVIEW,
  ellipsize,
  bundleEdges,
  computePreviewLayout,
} from './flow-preview-layout.js';

const { NODE_W, NODE_H, COL_W, ROW_H, PAD, HEADER, LANE_STEP, LABEL_GAP, CHAR_W } = PREVIEW;

// Minimal role factory — just enough shape for bundleEdges.
const role = (id, stage, extra = {}) => ({ id, stage, ...extra });

function labelBoxes(layout) {
  return [...layout.forward, ...layout.back].map(e => ({
    text: e.labelText,
    left: e.labelX - (e.labelText.length * CHAR_W) / 2,
    right: e.labelX + (e.labelText.length * CHAR_W) / 2,
    top: e.labelY - 8,
    bottom: e.labelY + 2,
  }));
}

test('ellipsize truncates with … and keeps short strings intact', () => {
  assert.equal(ellipsize('short', 10), 'short');
  assert.equal(ellipsize('Design Scout (Gap & Evidence)', 26), 'Design Scout (Gap & Evide…');
  assert.equal(ellipsize(null, 5), '');
});

test('bundleEdges: channels + label hand-offs, deduped, no self-edges', () => {
  const bundle = {
    roles: [
      // Label hand-offs derive from role-level `emits` only (#783); a trigger
      // no longer contributes emits.
      role('author', 'Build', { emits: ['done'] }),
      role('reviewer', 'Build', {
        channels: [{ artifact: 'pr', from: 'author' }],
        triggers: [{ labelFilter: 'done' }],
      }),
    ],
  };
  const edges = bundleEdges(bundle);
  assert.deepEqual(edges.map(e => `${e.from}→${e.to}:${e.label}`).sort(),
    ['author→reviewer:PR', 'author→reviewer:done']);
});

// Two rework loops within one stage column route as brackets in that column's
// right gutter (local to the stage, not dragged into a band below the whole
// grid), each with its own staggered label line.
test('intra-column loops route in the column gutter with one label line each', () => {
  const bundle = {
    stages: ['Build'],
    roles: [
      role('author', 'Build', { emits: ['escalate'], triggers: [{ labelFilter: 'author-go' }] }),
      role('companion', 'Build', { emits: ['author-go'], triggers: [{ labelFilter: 'escalate' }] }),
    ],
  };
  const layout = computePreviewLayout(bundle);
  assert.equal(layout.back.length, 2);
  assert.equal(layout.forward.length, 0);
  // labels sit in the gutter to the right of the single column's boxes, not in
  // a lane band below the grid
  const boxRight = PAD + NODE_W;
  for (const e of layout.back) {
    assert.ok(e.labelX > boxRight, `label ${e.labelText} not in the gutter`);
    assert.ok(typeof e.d === 'string' && e.d.startsWith('M'), 'edge has a bracket path');
  }
  // each loop gets its own staggered label line
  const ys = layout.back.map(e => e.labelY).sort((a, b) => a - b);
  assert.ok(ys[1] - ys[0] >= LABEL_GAP, `labels ${ys[0]}/${ys[1]} not staggered`);
});

// Two hand-offs sharing the corridor between the same two columns are
// staggered vertically instead of overprinting.
test('forward labels sharing a corridor are staggered', () => {
  const bundle = {
    stages: ['S1', 'S2'],
    roles: [
      role('a', 'S1', { emits: ['go', 'ship'] }),
      role('b', 'S2', { triggers: [{ labelFilter: 'go' }, { labelFilter: 'ship' }] }),
    ],
  };
  const layout = computePreviewLayout(bundle);
  assert.equal(layout.forward.length, 2);
  const [y1, y2] = layout.forward.map(e => e.labelY).sort((a, b) => a - b);
  assert.ok(y2 - y1 >= LABEL_GAP, `labels ${y1}/${y2} not staggered`);
});

// A label wider than the corridor would overhang the node boxes on a same-row
// edge — it must be nudged into the row gap below the boxes.
test('oversized label is nudged off the node row', () => {
  const bundle = {
    stages: ['S1', 'S2'],
    roles: [
      role('a', 'S1', { emits: ['requirements:approved'] }),
      role('b', 'S2', { triggers: [{ labelFilter: 'requirements:approved' }] }),
    ],
  };
  const layout = computePreviewLayout(bundle);
  assert.equal(layout.forward.length, 1);
  const rowBottom = PAD + HEADER + NODE_H;
  assert.ok(layout.forward[0].labelY - 8 >= rowBottom, 'label still intersects the node row');
});

// The issue's reproduction case: the curated Extended SDLC template (10 roles,
// several loops + PR channels) must render with no overlapping labels and no
// label sitting inside a node box.
//
// The edge set comes from the SERVER graph via previewEdgesFromGraph (#1009):
// since #831 retired flat `emits` in favour of authored outcomes, the local
// bundleEdges derivation no longer sees the label hand-offs — which is exactly
// the preview-vs-Flows divergence #1009 closed. This test therefore exercises
// the same data path the wizard now renders.
test('extended-sdlc preview: labels neither overlap nor cover node boxes', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { processTemplateToUnified, buildUnifiedGraph } = require('../../../api/unified-graph.js');
  const bundle = JSON.parse(readFileSync(
    new URL('../../../../orchestrator/skill-pool/process-templates/extended-sdlc.json', import.meta.url), 'utf8'));
  const flow = processTemplateToUnified(bundle);
  const graph = buildUnifiedGraph(flow.nodes, flow.edges, { labels: flow.labels, humans: bundle.humans || [] });
  const layout = computePreviewLayout(bundle, previewEdgesFromGraph(graph));
  assert.ok(layout.back.length > 0, 'expected rework/escalation loops');
  const boxes = labelBoxes(layout);
  assert.ok(boxes.length >= 10, 'expected a busy preview');

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]; const b = boxes[j];
      const overlap = a.left < b.right - 1 && b.left < a.right - 1
        && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      assert.ok(!overlap, `labels overlap: "${a.text}" and "${b.text}"`);
    }
  }
  for (const l of boxes) {
    for (const n of layout.nodes) {
      const covers = l.left < n.x + NODE_W && n.x < l.right
        && l.top < n.y + NODE_H && n.y < l.bottom;
      assert.ok(!covers, `label "${l.text}" sits on node ${n.role.id}`);
    }
    assert.ok(l.bottom <= layout.height && l.top >= 0, `label "${l.text}" clipped vertically`);
    assert.ok(l.left >= 0 && l.right <= layout.width, `label "${l.text}" clipped horizontally`);
  }
});

// Forward edge paths must start ≥3 px past the source box right edge and end
// ≥6 px before the target box left edge (acceptance criteria, #548).
// Back edge paths must also end ≥6 px before the target box left edge.
test('forward and back edge endpoints respect required gaps', () => {
  const bundle = {
    stages: ['S1', 'S2'],
    roles: [
      role('a', 'S1', { emits: ['go'] }),
      role('b', 'S2', { triggers: [{ labelFilter: 'go' }], emits: ['back'] }),
      role('c', 'S1', { triggers: [{ labelFilter: 'back' }] }),
    ],
  };
  const layout = computePreviewLayout(bundle);
  const aNode = layout.nodes.find(n => n.role.id === 'a');
  const bNode = layout.nodes.find(n => n.role.id === 'b');
  const fwd = layout.forward[0];
  const bkEdge = layout.back[0];

  // Extract the start point of the forward edge (M x y).
  const fwdStart = fwd.d.match(/^M\s+([\d.]+)\s+([\d.]+)/);
  const fwdStartX = parseFloat(fwdStart[1]);
  assert.ok(fwdStartX >= aNode.x + NODE_W + 3,
    `forward start gap too small: ${fwdStartX} vs box right ${aNode.x + NODE_W}`);

  // Extract the last coordinate of the forward edge cubic bezier (... x2 y2).
  const fwdEnd = fwd.d.match(/([\d.]+)\s+([\d.]+)$/);
  const fwdEndX = parseFloat(fwdEnd[1]);
  assert.ok(bNode.x - fwdEndX >= 6,
    `forward end gap too small: box.x=${bNode.x}, path ends at ${fwdEndX}`);

  // Back edge: last segment ends at [e.b.x - offset, entryY]; extract last L point.
  const bkEnd = bkEdge.d.match(/([\d.]+)\s+([\d.]+)$/);
  const bkEndX = parseFloat(bkEnd[1]);
  const cNode = layout.nodes.find(n => n.role.id === 'c');
  assert.ok(cNode.x - bkEndX >= 6,
    `back edge end gap too small: box.x=${cNode.x}, path ends at ${bkEndX}`);
});

// Column geometry is unchanged in spirit: one column per stage, unstaged roles
// in a trailing column.
test('unstaged roles land in a trailing column', () => {
  const bundle = {
    stages: ['S1'],
    roles: [role('a', 'S1'), role('x', undefined)],
  };
  const layout = computePreviewLayout(bundle);
  const xs = new Map(layout.nodes.map(n => [n.role.id, n.x]));
  assert.equal(xs.get('a'), PAD);
  assert.equal(xs.get('x'), PAD + COL_W);
  assert.equal(layout.width, PAD * 2 + COL_W + NODE_W);
});

// ─── #1009: the preview renders the SERVER edge set ──────────────────────────

import { previewEdgesFromGraph } from './flow-preview-layout.js';

test('#1009: previewEdgesFromGraph maps server edges onto the preview model', () => {
  const graph = { edges: [
    { from: 'ba', to: 'dev', on: 'github', artifact: 'issue', label: 'ready-for-implementation', gate: 'human' },
    { from: 'dev', to: 'reviewer', on: 'github', artifact: 'pr' },
    { from: 'reviewer', to: 'rework', on: 'label', label: 'revisions-required' },
    { from: 'a', to: 'b', on: 'dependency' },
    { from: 'a', to: 'b', on: 'artifact', label: 'report.md' },
    { from: 'x', to: 'y', on: 'review' },
  ] };
  assert.deepEqual(previewEdgesFromGraph(graph), [
    { from: 'ba', to: 'dev', label: 'ready-for-implementation', gate: true, styleKey: 'gate' },
    { from: 'dev', to: 'reviewer', label: 'PR', gate: false, styleKey: 'pr' },
    { from: 'reviewer', to: 'rework', label: 'revisions-required', gate: false, styleKey: 'label' },
    { from: 'a', to: 'b', label: 'depends-on', gate: false, styleKey: 'dependency' },
    { from: 'a', to: 'b', label: 'report.md', gate: false, styleKey: 'artifact' },
    { from: 'x', to: 'y', label: 'review', gate: false, styleKey: 'review' },
  ]);
});

test('#1009: actor/self edges and null endpoints are dropped (no box to attach to)', () => {
  const graph = { edges: [
    { from: null, to: 'dev', on: 'label', label: 'approved', kind: 'gate' }, // unbound gate edge
    { from: '@github', to: 'triage', on: 'event' },
    { from: '@timer', to: 'curator', on: 'timer' },
    { from: 'looper', to: 'looper', on: 'loop' },
  ] };
  assert.deepEqual(previewEdgesFromGraph(graph), []);
  assert.deepEqual(previewEdgesFromGraph(null), []);
  assert.deepEqual(previewEdgesFromGraph({}), []);
});

test('#1009: computePreviewLayout uses the server edge set when provided', () => {
  const bundle = {
    stages: ['S1', 'S2'],
    roles: [role('a', 'S1', { emits: ['go'] }), role('b', 'S2', {
      triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'go' }],
    })],
  };
  // Local derivation sees the label hand-off; the server override replaces it.
  const local = computePreviewLayout(bundle);
  assert.equal(local.forward.length, 1);
  assert.equal(local.forward[0].label, 'go');
  const server = computePreviewLayout(bundle, [
    { from: 'a', to: 'b', label: 'ready', gate: false, styleKey: 'issue' },
  ]);
  assert.equal(server.forward.length, 1);
  assert.equal(server.forward[0].label, 'ready');
  assert.equal(server.forward[0].styleKey, 'issue');
});
