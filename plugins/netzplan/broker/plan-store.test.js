'use strict';

// Unit tests for the Network Plan document store (plugin #3, Phase 3, #1563).
// Dependency-free `node --test` (fs + a tmp dir); run by the `netzplan-broker`
// CI job. Covers the acceptance criteria that are store properties:
//   - state is server-side and survives a restart (persisted to the state dir)
//   - the autonomy ladder is enforced when the broker is called directly
//   - teardown removes a scope's documents (idempotent)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PlanStore } = require('./plan-store');

let clock = 1_700_000_000_000;
function makeStore() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netzplan-state-'));
  return { store: new PlanStore({ stateDir, now: () => (clock += 1) }), stateDir };
}

test('load on first touch returns an empty board pinned to the scope', () => {
  const { store } = makeStore();
  const doc = store.load('team-x');
  assert.equal(doc.teamId, 'team-x');
  assert.equal(doc.id, 'team-x');
  assert.equal(doc.settings.agentAutonomy, 0);
  assert.equal(doc.panels.length, 1);
});

test('a saved / mutated board survives a fresh store over the same dir (podman restart)', () => {
  const { store, stateDir } = makeStore();
  const pid = store.load('team-x').panels[0].id;
  store.mutate('team-x', { type: 'add-lane', panelId: pid, id: 'l1', title: 'Build' });
  store.mutate('team-x', { type: 'add-milestone', panelId: pid, laneId: 'l1', id: 'm1', label: 'A' });
  store.mutate('team-x', { type: 'tick-milestone', panelId: pid, id: 'm1', done: true });

  // a brand-new store instance over the SAME dir = the sidecar after a restart
  const restarted = new PlanStore({ stateDir, now: () => 1 });
  const doc = restarted.load('team-x');
  const lane = doc.panels[0].lanes.find((l) => l.id === 'l1');
  assert.ok(lane, 'lane persisted');
  assert.equal(lane.milestones.find((m) => m.id === 'm1').done, true, 'tick persisted');
});

test('two scopes are isolated (one team never sees another\'s board)', () => {
  const { store } = makeStore();
  const pid = store.load('team-a').panels[0].id;
  store.mutate('team-a', { type: 'add-lane', panelId: pid, id: 'la', title: 'A' });
  const other = store.load('team-b');
  assert.equal(other.panels[0].lanes.length, 0);
});

test('autonomy ladder enforced on a direct broker mutate (the bypass-the-CLI case)', () => {
  const { store } = makeStore();
  const pid = store.load('team-x').panels[0].id;
  store.mutate('team-x', { type: 'add-lane', panelId: pid, id: 'l1', title: 'X' });
  store.mutate('team-x', { type: 'add-milestone', panelId: pid, laneId: 'l1', id: 'm1', label: 'A' });

  // level 0 (default): tick refused
  let r = store.mutate('team-x', { type: 'tick-milestone', panelId: pid, id: 'm1', done: true }, { enforceAutonomy: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'autonomy-forbidden');
  // structural refused too
  r = store.mutate('team-x', { type: 'add-lane', panelId: pid, id: 'l2', title: 'Y' }, { enforceAutonomy: true });
  assert.equal(r.ok, false);

  // raise to 1 (a human console write — not autonomy-gated) → tick allowed
  store.mutate('team-x', { type: 'set-autonomy', level: 1 });
  r = store.mutate('team-x', { type: 'tick-milestone', panelId: pid, id: 'm1', done: true }, { enforceAutonomy: true });
  assert.equal(r.ok, true);
  assert.equal(r.doc.panels[0].lanes[0].milestones[0].done, true);
  // ...but a structural edit still needs level 2
  r = store.mutate('team-x', { type: 'add-lane', panelId: pid, id: 'l2', title: 'Y' }, { enforceAutonomy: true });
  assert.equal(r.ok, false);
});

test('teardown removes a scope\'s document and is idempotent', () => {
  const { store } = makeStore();
  store.save('team-x', store.load('team-x'));
  assert.equal(store.count('team-x'), 1);
  assert.equal(store.teardown('team-x'), 1);
  assert.equal(store.count('team-x'), 0);
  assert.equal(store.teardown('team-x'), 0, 'second teardown is a no-op');
});

test('a malformed scopeId is rejected (path-safety defense in depth)', () => {
  const { store } = makeStore();
  assert.throws(() => store.load('../escape'), /invalid scopeId/);
  assert.throws(() => store.load(''), /invalid scopeId/);
});

// ── content migration: import / export round-trip (#1566) ─────────────────────

test('import stores a full document, pinned to the scope', () => {
  const { store } = makeStore();
  const doc = store.import('team-x', {
    name: 'Imported',
    owners: [{ id: 'o1', name: 'Ada', color: '#f00' }],
    panels: [{ id: 'p1', kind: 'swimlane', title: 'Plan', zones: [{ id: 'z1', name: 'Z' }], lanes: [{ id: 'l1', zoneId: 'z1', title: 'Lane', milestones: [{ id: 'm1', label: 'A', done: true }] }], requirements: [] }],
  });
  assert.equal(doc.name, 'Imported');
  assert.equal(doc.id, 'team-x');
  assert.equal(doc.teamId, 'team-x');
  assert.equal(doc.panels[0].lanes[0].milestones[0].done, true);
  // survives a fresh store over the same dir (persisted like every write)
  const reloaded = store.load('team-x');
  assert.equal(reloaded.name, 'Imported');
});

test('AC3: export (load) → import → identical document (byte-stable round-trip)', () => {
  const { store } = makeStore();
  const pid = store.load('team-x').panels[0].id;
  store.mutate('team-x', { type: 'add-lane', panelId: pid, id: 'l1', title: 'Build' });
  store.mutate('team-x', { type: 'add-milestone', panelId: pid, laneId: 'l1', id: 'm1', label: 'A' });
  store.mutate('team-x', { type: 'tick-milestone', panelId: pid, id: 'm1', done: true });

  const exported = store.load('team-x');            // what the /api/export route returns
  const afterImport = store.import('team-x', exported); // re-import the exported doc
  assert.deepEqual(afterImport, exported);          // identical, timestamps and all
  assert.deepEqual(store.load('team-x'), exported); // and persisted identically
});

test('import preserves the board autonomy (governance), never taking it from the document', () => {
  const { store } = makeStore();
  // Team-Admin sets the board to level 2.
  store.mutate('team-x', { type: 'set-autonomy', level: 2 });
  assert.equal(store.load('team-x').settings.agentAutonomy, 2);
  // A document that claims autonomy 0 must NOT lower the board's governance.
  const after = store.import('team-x', { name: 'X', settings: { agentAutonomy: 0 }, owners: [], panels: [] });
  assert.equal(after.settings.agentAutonomy, 2, 'autonomy is /admin-only, not import-set');
});
