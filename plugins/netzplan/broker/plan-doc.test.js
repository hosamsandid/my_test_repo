'use strict';

// Unit tests for the Network Plan document model (plugin #3, Phase 3, #1563).
// Dependency-free `node --test`; run by the `netzplan-broker` CI job. The three
// load-bearing acceptance criteria are the id-keyed invariants:
//   - inserting a milestone mid-lane shifts no statuses and no requirement targets
//   - deleting a milestone drops only the targets that pointed at it
//   - renaming an owner updates every lane that references them

const test = require('node:test');
const assert = require('node:assert');

const {
  VERSION,
  normalizePlanDoc,
  validatePlanDoc,
  migratePlanDoc,
  newPlanDoc,
  applyMutation,
  requiredAutonomy,
  laneReachedMilestone,
  zoneSatisfiedAt,
  graphNeighbors,
} = require('./plan-doc');

const NOW = 1_700_000_000_000;

// A small populated board: one zone, two lanes, three milestones each, two
// owners, one requirement line with per-lane targets.
function seedDoc() {
  let doc = newPlanDoc({ id: 'b1', name: 'Plan', teamId: 'team-x', now: NOW });
  const pid = doc.panels[0].id;
  doc = applyMutation(doc, { type: 'add-owner', id: 'alice', name: 'Alice', color: '#f00' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-owner', id: 'bob', name: 'Bob', color: '#00f' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-zone', panelId: pid, id: 'zA', name: 'Zone A' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-lane', panelId: pid, id: 'lane1', zoneId: 'zA', ownerId: 'alice', title: 'Lane 1' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-lane', panelId: pid, id: 'lane2', zoneId: 'zA', ownerId: 'bob', title: 'Lane 2' }, { now: NOW });
  for (const laneId of ['lane1', 'lane2']) {
    for (const n of [1, 2, 3]) {
      doc = applyMutation(doc, { type: 'add-milestone', panelId: pid, laneId, id: `${laneId}-m${n}`, label: `M${n}` }, { now: NOW });
    }
  }
  doc = applyMutation(doc, { type: 'add-requirement', panelId: pid, id: 'req1', label: 'MVP', color: '#0a0' }, { now: NOW });
  doc = applyMutation(doc, { type: 'set-requirement-target', panelId: pid, id: 'req1', laneId: 'lane1', milestoneId: 'lane1-m2' }, { now: NOW });
  doc = applyMutation(doc, { type: 'set-requirement-target', panelId: pid, id: 'req1', laneId: 'lane2', milestoneId: 'lane2-m3' }, { now: NOW });
  return doc;
}

test('newPlanDoc: empty board at version 1, autonomy 0, one swimlane panel', () => {
  const doc = newPlanDoc({ id: 'b', teamId: 't', now: NOW });
  assert.equal(doc.version, VERSION);
  assert.equal(doc.settings.agentAutonomy, 0);
  assert.equal(doc.owners.length, 0);
  assert.equal(doc.panels.length, 1);
  assert.equal(doc.panels[0].kind, 'swimlane');
  assert.deepEqual(validatePlanDoc(doc), { ok: true, errors: [] });
});

test('LOAD-BEARING: inserting a milestone mid-lane shifts no statuses and no requirement targets', () => {
  let doc = seedDoc();
  const pid = doc.panels[0].id;
  // mark lane1-m2 done and confirm the requirement target points at it
  doc = applyMutation(doc, { type: 'tick-milestone', panelId: pid, id: 'lane1-m2', done: true }, { now: NOW });
  const before = doc.panels[0].lanes.find((l) => l.id === 'lane1');
  assert.equal(before.milestones.find((m) => m.id === 'lane1-m2').done, true);

  // insert a NEW milestone at index 1 (between m1 and m2)
  doc = applyMutation(doc, { type: 'add-milestone', panelId: pid, laneId: 'lane1', id: 'lane1-inserted', label: 'INS', index: 1 }, { now: NOW });

  const lane = doc.panels[0].lanes.find((l) => l.id === 'lane1');
  // order shifted (display) but ids/statuses did not move
  assert.deepEqual(lane.milestones.map((m) => m.id), ['lane1-m1', 'lane1-inserted', 'lane1-m2', 'lane1-m3']);
  assert.equal(lane.milestones.find((m) => m.id === 'lane1-m2').done, true, 'm2 still done');
  assert.equal(lane.milestones.find((m) => m.id === 'lane1-inserted').done, false);
  // the requirement target STILL points at lane1-m2 (keyed on id, not index)
  const req = doc.panels[0].requirements.find((r) => r.id === 'req1');
  assert.equal(req.targets.lane1, 'lane1-m2');
  assert.equal(req.targets.lane2, 'lane2-m3');
});

test('LOAD-BEARING: deleting a milestone drops only the targets that pointed at it', () => {
  let doc = seedDoc();
  const pid = doc.panels[0].id;
  // lane1 target = lane1-m2, lane2 target = lane2-m3. Delete lane1-m2.
  doc = applyMutation(doc, { type: 'delete-milestone', panelId: pid, laneId: 'lane1', id: 'lane1-m2' }, { now: NOW });
  const req = doc.panels[0].requirements.find((r) => r.id === 'req1');
  assert.ok(!('lane1' in req.targets), 'lane1 target dropped');
  assert.equal(req.targets.lane2, 'lane2-m3', 'lane2 target untouched');
  const lane1 = doc.panels[0].lanes.find((l) => l.id === 'lane1');
  assert.deepEqual(lane1.milestones.map((m) => m.id), ['lane1-m1', 'lane1-m3']);
});

test('LOAD-BEARING: renaming an owner updates every lane that references them (owners by id)', () => {
  let doc = seedDoc();
  doc = applyMutation(doc, { type: 'rename-owner', id: 'alice', name: 'Alicia', color: '#0f0' }, { now: NOW });
  const owner = doc.owners.find((o) => o.id === 'alice');
  assert.equal(owner.name, 'Alicia');
  assert.equal(owner.color, '#0f0');
  // lane1 still references owner id 'alice' — nothing repeated per lane to update
  assert.equal(doc.panels[0].lanes.find((l) => l.id === 'lane1').ownerId, 'alice');
});

test('deleting an owner drops the reference from every lane that named it', () => {
  let doc = seedDoc();
  doc = applyMutation(doc, { type: 'delete-owner', id: 'alice' }, { now: NOW });
  assert.ok(!doc.owners.some((o) => o.id === 'alice'));
  assert.equal(doc.panels[0].lanes.find((l) => l.id === 'lane1').ownerId, null);
  assert.equal(doc.panels[0].lanes.find((l) => l.id === 'lane2').ownerId, 'bob');
});

test('reordering milestones keeps ids and statuses, only changes order', () => {
  let doc = seedDoc();
  const pid = doc.panels[0].id;
  doc = applyMutation(doc, { type: 'tick-milestone', panelId: pid, id: 'lane1-m3', done: true }, { now: NOW });
  doc = applyMutation(doc, { type: 'reorder-milestones', panelId: pid, laneId: 'lane1', order: ['lane1-m3', 'lane1-m1', 'lane1-m2'] }, { now: NOW });
  const lane = doc.panels[0].lanes.find((l) => l.id === 'lane1');
  assert.deepEqual(lane.milestones.map((m) => m.id), ['lane1-m3', 'lane1-m1', 'lane1-m2']);
  assert.equal(lane.milestones.find((m) => m.id === 'lane1-m3').done, true);
});

test('OR zone: a sibling lane reaching a milestone satisfies the zone (not the same as done-here)', () => {
  let doc = seedDoc();
  const pid = doc.panels[0].id;
  doc = applyMutation(doc, { type: 'update-zone', panelId: pid, id: 'zA', or: true }, { now: NOW });
  // lane2 reaches m-equivalent; check zoneSatisfiedAt for lane1 via a sibling
  doc = applyMutation(doc, { type: 'tick-milestone', panelId: pid, id: 'lane2-m1', done: true }, { now: NOW });
  const panel = doc.panels[0];
  const lane1 = panel.lanes.find((l) => l.id === 'lane1');
  const lane2 = panel.lanes.find((l) => l.id === 'lane2');
  // lane1 has NOT done m1 itself
  assert.equal(laneReachedMilestone(lane1, 'lane1-m1'), false);
  // but a sibling in the OR zone reached its m1 → zone is satisfied for lane1's m1... use lane2's id
  assert.equal(laneReachedMilestone(lane2, 'lane2-m1'), true);
  // zoneSatisfiedAt: lane1 not done its own, but OR + sibling lane2 done lane2-m1
  // (uses the milestone id argument against sibling lanes)
  assert.equal(zoneSatisfiedAt(panel, lane1, 'lane2-m1'), true);
  // with OR off it would only count the lane itself
  const off = applyMutation(doc, { type: 'update-zone', panelId: pid, id: 'zA', or: false }, { now: NOW }).panels[0];
  assert.equal(zoneSatisfiedAt(off, off.lanes.find((l) => l.id === 'lane1'), 'lane2-m1'), false);
});

test('requirement lines are a list: add a third with its own label and colour', () => {
  let doc = seedDoc();
  const pid = doc.panels[0].id;
  doc = applyMutation(doc, { type: 'add-requirement', panelId: pid, id: 'req2', label: 'Beta', color: '#abc' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-requirement', panelId: pid, id: 'req3', label: 'GA', color: '#def' }, { now: NOW });
  const reqs = doc.panels[0].requirements;
  assert.deepEqual(reqs.map((r) => r.id), ['req1', 'req2', 'req3']);
  assert.equal(reqs.find((r) => r.id === 'req3').label, 'GA');
  assert.equal(reqs.find((r) => r.id === 'req3').color, '#def');
});

test('autonomy ladder: set-autonomy clamps and requiredAutonomy classifies ops', () => {
  let doc = newPlanDoc({ teamId: 't', now: NOW });
  doc = applyMutation(doc, { type: 'set-autonomy', level: 1 }, { now: NOW });
  assert.equal(doc.settings.agentAutonomy, 1);
  assert.throws(() => applyMutation(doc, { type: 'set-autonomy', level: 5 }, { now: NOW }), /autonomy level/);
  // out-of-range on normalize is clamped, not thrown
  assert.equal(normalizePlanDoc({ teamId: 't', settings: { agentAutonomy: 9 } }).settings.agentAutonomy, 2);
  assert.equal(requiredAutonomy('tick-milestone'), 1);
  assert.equal(requiredAutonomy('update-milestone'), 1);
  assert.equal(requiredAutonomy('add-lane'), 2);
  assert.equal(requiredAutonomy('delete-milestone'), 2);
  assert.equal(requiredAutonomy('rename-owner'), 2);
});

test('normalize repairs dangling references (target → deleted milestone/lane, lane → deleted owner/zone)', () => {
  const raw = {
    version: 1,
    teamId: 't',
    settings: { agentAutonomy: 0 },
    owners: [{ id: 'o1', name: 'X' }],
    panels: [{
      id: 'p1', kind: 'swimlane', title: '',
      zones: [{ id: 'z1', name: 'Z' }],
      lanes: [{ id: 'l1', zoneId: 'zGHOST', ownerId: 'oGHOST', title: 'L', milestones: [{ id: 'm1', label: 'A' }] }],
      stepColumns: [],
      requirements: [{ id: 'r1', label: 'R', targets: { l1: 'mGHOST', lGHOST: 'm1' } }],
    }],
  };
  const doc = normalizePlanDoc(raw, { now: NOW });
  const lane = doc.panels[0].lanes[0];
  assert.equal(lane.zoneId, null, 'ghost zone dropped');
  assert.equal(lane.ownerId, null, 'ghost owner dropped');
  assert.deepEqual(doc.panels[0].requirements[0].targets, {}, 'both dangling targets dropped');
});

test('applyMutation is immutable — the input document is never mutated', () => {
  const doc = seedDoc();
  const snapshot = JSON.stringify(doc);
  const next = applyMutation(doc, { type: 'tick-milestone', panelId: doc.panels[0].id, id: 'lane1-m1', done: true }, { now: NOW + 1 });
  assert.equal(JSON.stringify(doc), snapshot, 'input unchanged');
  assert.notEqual(next.updatedAt, doc.updatedAt);
});

test('unknown mutation / unknown ids throw PlanMutationError, never corrupt', () => {
  const doc = seedDoc();
  assert.throws(() => applyMutation(doc, { type: 'frobnicate' }), /unknown mutation type/);
  assert.throws(() => applyMutation(doc, { type: 'tick-milestone', id: 'nope' }), /unknown milestone/);
  assert.throws(() => applyMutation(doc, { type: 'rename-owner', id: 'ghost' }), /unknown owner/);
});

test('migrate re-normalizes and stamps the current version', () => {
  const doc = migratePlanDoc({ teamId: 't', version: 0, owners: [], panels: [] }, { now: NOW });
  assert.equal(doc.version, VERSION);
  assert.deepEqual(validatePlanDoc(doc), { ok: true, errors: [] });
});

// ─── #1564: the remaining panel primitives + panel composition ────────────────

// Add a panel of `kind` to a fresh board and return { doc, pid }.
function boardWithPanel(kind) {
  let doc = newPlanDoc({ id: 'b', teamId: 't', now: NOW });
  doc = applyMutation(doc, { type: 'add-panel', kind, id: `p-${kind}`, title: kind }, { now: NOW });
  return { doc, pid: `p-${kind}` };
}

test('panel composition: add each primitive, reorder, delete — panels[] is an ordered list', () => {
  let doc = newPlanDoc({ id: 'b', teamId: 't', now: NOW });
  const first = doc.panels[0].id; // the seeded swimlane
  doc = applyMutation(doc, { type: 'add-panel', kind: 'graph', id: 'g1' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-panel', kind: 'bipartite', id: 'bp1' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-panel', kind: 'blocks', id: 'bl1' }, { now: NOW });
  assert.deepEqual(doc.panels.map((p) => p.kind), ['swimlane', 'graph', 'bipartite', 'blocks']);

  // reorder — persists as array order (no `order` field stamped on panels)
  doc = applyMutation(doc, { type: 'reorder-panels', order: ['bl1', 'g1', 'bp1', first] }, { now: NOW });
  assert.deepEqual(doc.panels.map((p) => p.id), ['bl1', 'g1', 'bp1', first]);
  assert.ok(!('order' in doc.panels[0]), 'panels carry no order field');

  // a panel's title is editable kind-agnostically
  doc = applyMutation(doc, { type: 'set-panel-title', id: 'g1', title: 'Waves' }, { now: NOW });
  assert.equal(doc.panels.find((p) => p.id === 'g1').title, 'Waves');

  // remove
  doc = applyMutation(doc, { type: 'delete-panel', id: 'g1' }, { now: NOW });
  assert.deepEqual(doc.panels.map((p) => p.id), ['bl1', 'bp1', first]);
  assert.throws(() => applyMutation(doc, { type: 'delete-panel', id: 'ghost' }), /unknown panel/);
  // an unknown kind falls back to swimlane rather than corrupting the board
  doc = applyMutation(doc, { type: 'add-panel', kind: 'nonsense', id: 'x' }, { now: NOW });
  assert.equal(doc.panels.find((p) => p.id === 'x').kind, 'swimlane');
});

test('graph: nodes and typed dependency edges are fully editable; delete-node drops its edges', () => {
  let { doc, pid } = boardWithPanel('graph');
  doc = applyMutation(doc, { type: 'add-owner', id: 'o1', name: 'Team' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-band', panelId: pid, id: 'wave1', name: 'Wave 1' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-node', panelId: pid, id: 'n1', label: 'A', nodeType: 'service', bandId: 'wave1', ownerId: 'o1', status: 'active' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-node', panelId: pid, id: 'n2', label: 'B', nodeType: 'batch', bandId: 'wave1' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-edge', panelId: pid, id: 'e1', from: 'n1', to: 'n2', edgeType: 'blocks' }, { now: NOW });

  const g = doc.panels.find((p) => p.id === pid);
  assert.equal(g.nodes.find((n) => n.id === 'n1').type, 'service', 'node type from nodeType');
  assert.equal(g.nodes.find((n) => n.id === 'n1').bandId, 'wave1');
  assert.equal(g.nodes.find((n) => n.id === 'n1').ownerId, 'o1');
  assert.equal(g.edges[0].type, 'blocks', 'edge is typed');

  // update a node (nodeType round-trips as `type`) and an edge type
  doc = applyMutation(doc, { type: 'update-node', panelId: pid, id: 'n1', nodeType: 'gateway', status: 'done' }, { now: NOW });
  doc = applyMutation(doc, { type: 'update-edge', panelId: pid, id: 'e1', edgeType: 'depends' }, { now: NOW });
  const g2 = doc.panels.find((p) => p.id === pid);
  assert.equal(g2.nodes.find((n) => n.id === 'n1').type, 'gateway');
  assert.equal(g2.edges[0].type, 'depends');

  // no self-loop, no dangling endpoint
  assert.throws(() => applyMutation(doc, { type: 'add-edge', panelId: pid, from: 'n1', to: 'n1' }), /itself/);
  assert.throws(() => applyMutation(doc, { type: 'add-edge', panelId: pid, from: 'n1', to: 'ghost' }), /existing nodes/);

  // deleting a node drops every edge touching it (edges keyed on node id)
  doc = applyMutation(doc, { type: 'delete-node', panelId: pid, id: 'n2' }, { now: NOW });
  const g3 = doc.panels.find((p) => p.id === pid);
  assert.deepEqual(g3.nodes.map((n) => n.id), ['n1']);
  assert.equal(g3.edges.length, 0, 'edge to the deleted node dropped');
});

test('graph: hover highlight — graphNeighbors returns the node + its adjacencies, both directions', () => {
  let { doc, pid } = boardWithPanel('graph');
  for (const id of ['a', 'b', 'c', 'd']) doc = applyMutation(doc, { type: 'add-node', panelId: pid, id, label: id }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-edge', panelId: pid, from: 'a', to: 'b' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-edge', panelId: pid, from: 'c', to: 'a' }, { now: NOW });
  const panel = doc.panels.find((p) => p.id === pid);
  assert.deepEqual([...graphNeighbors(panel, 'a')].sort(), ['a', 'b', 'c'], 'a + downstream b + upstream c');
  assert.deepEqual([...graphNeighbors(panel, 'd')], ['d'], 'isolated node only itself');
  assert.equal(graphNeighbors(panel, 'ghost').size, 0, 'unknown node → empty set');
});

test('graph: delete-band unbands its nodes (never deletes them); delete-owner clears node owners too', () => {
  let { doc, pid } = boardWithPanel('graph');
  doc = applyMutation(doc, { type: 'add-owner', id: 'o1', name: 'X' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-band', panelId: pid, id: 'band1', name: 'B' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-node', panelId: pid, id: 'n1', label: 'A', bandId: 'band1', ownerId: 'o1' }, { now: NOW });
  doc = applyMutation(doc, { type: 'delete-band', panelId: pid, id: 'band1' }, { now: NOW });
  assert.equal(doc.panels.find((p) => p.id === pid).nodes.find((n) => n.id === 'n1').bandId, null);
  doc = applyMutation(doc, { type: 'delete-owner', id: 'o1' }, { now: NOW });
  assert.equal(doc.panels.find((p) => p.id === pid).nodes.find((n) => n.id === 'n1').ownerId, null);
});

test('bipartite: entries + edges on both sides; the muted style survives an update', () => {
  let { doc, pid } = boardWithPanel('bipartite');
  doc = applyMutation(doc, { type: 'add-bip-entry', panelId: pid, side: 'left', id: 'streamA', label: 'Stream A' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-bip-entry', panelId: pid, side: 'right', id: 'labelX', label: 'ready' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-bip-edge', panelId: pid, id: 'be1', from: 'streamA', to: 'labelX', edgeType: 'maps', muted: true }, { now: NOW });
  let bp = doc.panels.find((p) => p.id === pid);
  assert.equal(bp.left[0].label, 'Stream A');
  assert.equal(bp.right[0].label, 'ready');
  assert.equal(bp.edges[0].muted, true, 'muted set');
  assert.equal(bp.edges[0].type, 'maps');

  // a from that isn't a LEFT id / a to that isn't a RIGHT id is rejected
  assert.throws(() => applyMutation(doc, { type: 'add-bip-edge', panelId: pid, from: 'labelX', to: 'streamA' }), /unknown left entry/);

  // updating the edge keeps muted unless explicitly changed; then flips it
  doc = applyMutation(doc, { type: 'update-bip-edge', panelId: pid, id: 'be1', edgeType: 'routes' }, { now: NOW });
  assert.equal(doc.panels.find((p) => p.id === pid).edges[0].muted, true, 'muted survives an unrelated update');
  doc = applyMutation(doc, { type: 'update-bip-edge', panelId: pid, id: 'be1', muted: false }, { now: NOW });
  assert.equal(doc.panels.find((p) => p.id === pid).edges[0].muted, false);

  // deleting an entry drops its edges
  doc = applyMutation(doc, { type: 'delete-bip-entry', panelId: pid, side: 'left', id: 'streamA' }, { now: NOW });
  bp = doc.panels.find((p) => p.id === pid);
  assert.equal(bp.left.length, 0);
  assert.equal(bp.edges.length, 0, 'edge referencing the deleted left entry dropped');
});

test('blocks: cover, KPI tiles, callout and card columns are all expressible', () => {
  let { doc, pid } = boardWithPanel('blocks');
  doc = applyMutation(doc, { type: 'add-block', panelId: pid, id: 'cover', blockType: 'cover', heading: 'Q3 Plan', subtitle: 'Draft', body: 'The plan.' }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-block', panelId: pid, id: 'kpi', blockType: 'kpi', tiles: [{ id: 't1', label: 'Velocity', value: '42', sub: 'pts/wk' }, { id: 't2', label: 'Open', value: '7' }] }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-block', panelId: pid, id: 'call', blockType: 'callout', heading: 'Risk', body: 'Dependency slip.', chips: ['high', 'infra'] }, { now: NOW });
  doc = applyMutation(doc, { type: 'add-block', panelId: pid, id: 'cards', blockType: 'cards', tiles: [{ id: 'c1', label: 'Card 1', value: 'body 1' }] }, { now: NOW });

  const bl = doc.panels.find((p) => p.id === pid);
  assert.deepEqual(bl.blocks.map((b) => b.type), ['cover', 'kpi', 'callout', 'cards']);
  assert.equal(bl.blocks.find((b) => b.id === 'cover').heading, 'Q3 Plan');
  assert.equal(bl.blocks.find((b) => b.id === 'kpi').tiles.length, 2);
  assert.deepEqual(bl.blocks.find((b) => b.id === 'call').chips, ['high', 'infra']);

  // update replaces tiles wholesale, reorder keeps ids
  doc = applyMutation(doc, { type: 'update-block', panelId: pid, id: 'kpi', tiles: [{ id: 't1', label: 'Velocity', value: '50' }] }, { now: NOW });
  assert.equal(doc.panels.find((p) => p.id === pid).blocks.find((b) => b.id === 'kpi').tiles[0].value, '50');
  doc = applyMutation(doc, { type: 'reorder-blocks', panelId: pid, order: ['cards', 'cover', 'kpi', 'call'] }, { now: NOW });
  assert.deepEqual(doc.panels.find((p) => p.id === pid).blocks.map((b) => b.id), ['cards', 'cover', 'kpi', 'call']);
});

test('AC7: every new-primitive structural op needs autonomy 2 — no primitive has its own path', () => {
  for (const t of ['add-panel', 'delete-panel', 'reorder-panels', 'set-panel-title',
    'add-band', 'add-node', 'update-node', 'delete-node', 'add-edge', 'reorder-nodes',
    'add-bip-entry', 'add-bip-edge', 'update-bip-edge', 'delete-bip-entry',
    'add-block', 'update-block', 'delete-block', 'reorder-blocks']) {
    assert.equal(requiredAutonomy(t), 2, `${t} must gate at level 2`);
  }
  // the level-1 progress ops are unchanged (swimlane unaffected — AC6)
  assert.equal(requiredAutonomy('tick-milestone'), 1);
  assert.equal(requiredAutonomy('update-milestone'), 1);
});

test('AC6: swimlane is unaffected — a kind-scoped op refuses the wrong primitive', () => {
  const { doc, pid } = boardWithPanel('graph');
  // add-lane targets a swimlane; running it against a graph panel is refused cleanly
  assert.throws(() => applyMutation(doc, { type: 'add-lane', panelId: pid, title: 'X' }), /is a graph, not a swimlane/);
  // and add-node against the seeded swimlane is refused too
  const swimId = doc.panels[0].id;
  assert.throws(() => applyMutation(doc, { type: 'add-node', panelId: swimId, label: 'X' }), /is a swimlane, not a graph/);
});

test('graph/bipartite normalize repair dangling edges on load', () => {
  const raw = {
    version: 1, teamId: 't', settings: { agentAutonomy: 0 }, owners: [],
    panels: [
      { id: 'g', kind: 'graph', bands: [{ id: 'b1' }],
        nodes: [{ id: 'n1', bandId: 'bGHOST', ownerId: 'oGHOST' }],
        edges: [{ id: 'e1', from: 'n1', to: 'nGHOST' }, { id: 'e2', from: 'n1', to: 'n1' }] },
      { id: 'bp', kind: 'bipartite',
        left: [{ id: 'l1' }], right: [{ id: 'r1' }],
        edges: [{ id: 'be1', from: 'l1', to: 'rGHOST' }, { id: 'be2', from: 'l1', to: 'r1' }] },
    ],
  };
  const doc = normalizePlanDoc(raw, { now: NOW });
  const g = doc.panels.find((p) => p.id === 'g');
  assert.equal(g.nodes[0].bandId, null, 'ghost band dropped');
  assert.equal(g.nodes[0].ownerId, null, 'ghost owner dropped');
  assert.equal(g.edges.length, 0, 'dangling + self-loop edges dropped');
  const bp = doc.panels.find((p) => p.id === 'bp');
  assert.deepEqual(bp.edges.map((e) => e.id), ['be2'], 'only the referentially-sound bipartite edge kept');
});
