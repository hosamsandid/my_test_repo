'use strict';

// Unit tests for the Network Plan content migration (plugin #3, Phase 6, #1566).
// Dependency-free `node --test`, run by the `netzplan-broker` CI job. These cover
// the phase's acceptance criteria that are pure-model properties:
//
//   AC1  import produces a board matching the source: zones, lanes, milestones,
//        owners + colours, OR-zone behaviour, both requirement lines with the
//        same per-lane targets.
//   AC2  every milestone's done/not-done matches the source, verified lane by
//        lane — explicitly INCLUDING the two shifted-index lanes.
//   AC3  round-trip: export → import → identical document.
//   AC4  the restored non-swimlane panels are present (the #1564 normalisation
//        trade, acknowledged not defective).
//
// No engagement content is used — the fixtures are synthetic boards that exercise
// the positional-arithmetic hazards the issue names, without carrying a real plan.

const test = require('node:test');
const assert = require('node:assert');

const { legacyBoardToPlanDoc, exportPlanDoc, importPlanDoc, PlanImportError } = require('./plan-import');
const { zoneSatisfiedAt } = require('./plan-doc');

const NOW = 1_700_000_000_000;

// A synthetic legacy board that mirrors the source's positional shape and, in two
// lanes, the exact "index shifted by +1" hazard the source comments record: a
// milestone was prepended at position 0, so its DEFAULTS array is written for the
// FULL (post-prepend) milestone list. The converter must map done[i] → milestone
// i with no off-by-one.
function legacyFixture() {
  return {
    name: 'Sample Plan',
    autonomy: 1,
    zones: [
      { key: 'setup', name: 'Setup', color: '#111827' },
      { key: 'delivery', name: 'Delivery', or: true },      // OR zone
    ],
    owners: [
      { name: 'Ada', color: '#ef4444' },
      { name: 'Björn', color: '#3b82f6' },
    ],
    stepColumns: ['Q1', 'Q2', 'Q3'],
    lanes: [
      // Lane 0 — the "info gathering added at 0" lane: 4 milestones, done aligned
      // to the full list. Only "Analyse" (index 2) is done.
      {
        zone: 'setup', title: 'Discovery', owner: 'Ada',
        milestones: ['Info gathering', 'Kickoff', 'Analyse', 'Sign-off'],
        done: [false, false, true, false],
      },
      // Lane 1 — the "Mock ideation prepended at 0" lane: 3 milestones, the
      // prepended one IS done, the rest not.
      {
        zone: 'delivery', title: 'Build A', owner: 'Björn',
        milestones: ['Mock ideation', 'Implement', 'Ship'],
        done: [true, false, false],
      },
      // Lane 2 — a sibling in the OR zone; reaches "Ship" so it satisfies the zone.
      {
        zone: 'delivery', title: 'Build B',
        milestones: ['Implement', 'Ship'],
        done: [true, true],
      },
    ],
    requirements: [
      // Requirement line 1: per-lane target milestone INDEX (null = no target).
      { label: 'Go-live', color: '#16a34a', targets: [3, 2, 1] },   // Sign-off / Ship / Ship
      { label: 'MVP', targets: [2, 1, null] },                       // Analyse / Implement / —
    ],
  };
}

test('AC1: zones, lanes, milestones, owners+colours, stepColumns convert with ids', () => {
  const doc = legacyBoardToPlanDoc(legacyFixture(), { now: NOW });
  assert.equal(doc.name, 'Sample Plan');
  assert.equal(doc.settings.agentAutonomy, 1);

  // owners keyed by id, colours preserved
  const ada = doc.owners.find((o) => o.name === 'Ada');
  const bjorn = doc.owners.find((o) => o.name === 'Björn');
  assert.equal(ada.color, '#ef4444');
  assert.equal(bjorn.color, '#3b82f6');

  const sw = doc.panels[0];
  assert.equal(sw.kind, 'swimlane');
  assert.deepEqual(sw.stepColumns, ['Q1', 'Q2', 'Q3']);
  assert.equal(sw.zones.length, 2);
  assert.equal(sw.lanes.length, 3);

  // lane → owner id resolves to the right owner
  const discovery = sw.lanes.find((l) => l.title === 'Discovery');
  assert.equal(discovery.ownerId, ada.id);

  // OR zone flag preserved
  const delivery = sw.zones.find((z) => z.name === 'Delivery');
  assert.equal(delivery.or, true);
  const setup = sw.zones.find((z) => z.name === 'Setup');
  assert.equal(setup.or, false);
  assert.equal(setup.color, '#111827');
});

test('AC2: done/not-done matches lane by lane, including the two shifted-index lanes', () => {
  const doc = legacyBoardToPlanDoc(legacyFixture(), { now: NOW });
  const sw = doc.panels[0];
  const byTitle = (t) => sw.lanes.find((l) => l.title === t);

  // Lane 0 (info gathering prepended): ONLY "Analyse" done — a +1 slip would mark
  // "Kickoff" or "Sign-off" instead.
  const d = byTitle('Discovery');
  assert.deepEqual(d.milestones.map((m) => [m.label, m.done]), [
    ['Info gathering', false],
    ['Kickoff', false],
    ['Analyse', true],
    ['Sign-off', false],
  ]);

  // Lane 1 (mock ideation prepended): the prepended milestone IS the done one — a
  // -1 slip would leave it not-done and mark "Implement" instead.
  const a = byTitle('Build A');
  assert.deepEqual(a.milestones.map((m) => [m.label, m.done]), [
    ['Mock ideation', true],
    ['Implement', false],
    ['Ship', false],
  ]);

  const b = byTitle('Build B');
  assert.deepEqual(b.milestones.map((m) => [m.label, m.done]), [
    ['Implement', true],
    ['Ship', true],
  ]);
});

test('AC1: OR-zone behaviour survives — a sibling reaching a milestone satisfies the zone', () => {
  const doc = legacyBoardToPlanDoc(legacyFixture(), { now: NOW });
  const sw = doc.panels[0];
  const buildA = sw.lanes.find((l) => l.title === 'Build A'); // both in the OR 'Delivery' zone
  const buildB = sw.lanes.find((l) => l.title === 'Build B');
  const shipB = buildB.milestones.find((m) => m.label === 'Ship'); // done in Build B
  const shipA = buildA.milestones.find((m) => m.label === 'Ship'); // NOT done, owned only by Build A

  assert.equal(buildA.zoneId, buildB.zoneId); // same zone
  // OR zone: Build A hasn't reached Build B's "Ship" milestone itself, but its
  // sibling Build B has → the zone counts it satisfied for Build A too.
  assert.equal(zoneSatisfiedAt(sw, buildA, shipB.id), true);
  // And OR does not invent satisfaction: no lane has reached Build A's own "Ship".
  assert.equal(shipA.done, false);
  assert.equal(zoneSatisfiedAt(sw, buildB, shipA.id), false);

  // Flipping the zone's OR flag off removes the sibling credit (proves the flag,
  // not the ids, drives it).
  const off = JSON.parse(JSON.stringify(sw));
  off.zones.find((z) => z.id === buildA.zoneId).or = false;
  assert.equal(zoneSatisfiedAt(off, off.lanes.find((l) => l.id === buildA.id), shipB.id), false);
});

test('AC1: requirement targets map positional index → the milestone id it referred to', () => {
  const doc = legacyBoardToPlanDoc(legacyFixture(), { now: NOW });
  const sw = doc.panels[0];
  const lane = (t) => sw.lanes.find((l) => l.title === t);
  const ms = (t, label) => lane(t).milestones.find((m) => m.label === label).id;

  const goLive = sw.requirements.find((r) => r.label === 'Go-live');
  assert.equal(goLive.color, '#16a34a');
  // targets [3,2,1] → Discovery:Sign-off, Build A:Ship, Build B:Ship
  assert.equal(goLive.targets[lane('Discovery').id], ms('Discovery', 'Sign-off'));
  assert.equal(goLive.targets[lane('Build A').id], ms('Build A', 'Ship'));
  assert.equal(goLive.targets[lane('Build B').id], ms('Build B', 'Ship'));

  const mvp = sw.requirements.find((r) => r.label === 'MVP');
  // targets [2,1,null] → Discovery:Analyse, Build A:Implement, Build B: (none)
  assert.equal(mvp.targets[lane('Discovery').id], ms('Discovery', 'Analyse'));
  assert.equal(mvp.targets[lane('Build A').id], ms('Build A', 'Implement'));
  assert.equal(Object.prototype.hasOwnProperty.call(mvp.targets, lane('Build B').id), false);
});

test('AC2 guard: a done-array whose length ≠ its lane milestone count is refused LOUD', () => {
  const legacy = legacyFixture();
  legacy.lanes[0].done = [true, false, true]; // 3 flags for 4 milestones (a +1 slip)
  assert.throws(() => legacyBoardToPlanDoc(legacy, { now: NOW }), PlanImportError);
});

test('AC guard: a requirement target index out of range is refused LOUD', () => {
  const legacy = legacyFixture();
  legacy.requirements[0].targets = [9, 2, 1]; // index 9 has no milestone in lane 0
  assert.throws(() => legacyBoardToPlanDoc(legacy, { now: NOW }), PlanImportError);
});

test('AC guard: a targets array shorter/longer than the lane count is refused LOUD', () => {
  const legacy = legacyFixture();
  legacy.requirements[0].targets = [3, 2]; // 2 targets, 3 lanes
  assert.throws(() => legacyBoardToPlanDoc(legacy, { now: NOW }), PlanImportError);
});

test('guard: an unknown zone key or owner name is refused LOUD (silent drift prevention)', () => {
  const badZone = legacyFixture();
  badZone.lanes[0].zone = 'nope';
  assert.throws(() => legacyBoardToPlanDoc(badZone, { now: NOW }), PlanImportError);

  const badOwner = legacyFixture();
  badOwner.lanes[0].owner = 'Nobody';
  assert.throws(() => legacyBoardToPlanDoc(badOwner, { now: NOW }), PlanImportError);
});

test('AC4: extra non-swimlane panels ride along after the swimlane, editable primitives', () => {
  const legacy = legacyFixture();
  legacy.panels = [
    { kind: 'blocks', title: 'Cover', blocks: [{ type: 'cover', heading: 'Programme' }] },
    {
      kind: 'graph', title: 'Waves',
      bands: [{ id: 'w1', name: 'Wave 1' }],
      nodes: [{ id: 'n1', label: 'App A', bandId: 'w1' }, { id: 'n2', label: 'App B', bandId: 'w1' }],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', type: 'depends' }],
    },
    {
      kind: 'bipartite', title: 'Stream → Label',
      left: [{ id: 'sL', label: 'Stream' }],
      right: [{ id: 'sR', label: 'Board' }],
      edges: [{ id: 'be1', from: 'sL', to: 'sR', type: 'maps' }],
    },
  ];
  const doc = legacyBoardToPlanDoc(legacy, { now: NOW });
  assert.deepEqual(doc.panels.map((p) => p.kind), ['swimlane', 'blocks', 'graph', 'bipartite']);
  const graph = doc.panels.find((p) => p.kind === 'graph');
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1); // referential soundness kept the edge
  const bip = doc.panels.find((p) => p.kind === 'bipartite');
  assert.equal(bip.edges.length, 1);
});

test('AC3: round-trip export → import → identical document', () => {
  const doc = legacyBoardToPlanDoc(legacyFixture(), { now: NOW });
  const exported = exportPlanDoc(doc);
  const reimported = importPlanDoc(exported);
  assert.deepEqual(reimported, exported);
  // and stable across a second round — export is canonical/idempotent
  assert.deepEqual(exportPlanDoc(reimported), exported);
});

test('AC3: export is a copy, not an alias (mutating the export never touches the source)', () => {
  const doc = legacyBoardToPlanDoc(legacyFixture(), { now: NOW });
  const exported = exportPlanDoc(doc);
  exported.panels[0].lanes[0].milestones[0].done = true;
  assert.equal(doc.panels[0].lanes[0].milestones[0].done, false);
});

test('empty legacy board → a valid empty PlanDoc (one empty swimlane)', () => {
  const doc = legacyBoardToPlanDoc({}, { now: NOW });
  assert.equal(doc.version, 1);
  assert.equal(doc.panels.length, 1);
  assert.equal(doc.panels[0].kind, 'swimlane');
  assert.equal(doc.panels[0].lanes.length, 0);
  assert.equal(doc.settings.agentAutonomy, 0);
});

test('a non-object legacy input is refused', () => {
  assert.throws(() => legacyBoardToPlanDoc(null), PlanImportError);
  assert.throws(() => legacyBoardToPlanDoc([]), PlanImportError);
});
