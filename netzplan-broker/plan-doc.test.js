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
