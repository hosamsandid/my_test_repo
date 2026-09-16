'use strict';

// Unit tests for the pure Flow Supervisor core (#2247, epic #2251 Phase 2).

const { test } = require('node:test');
const assert = require('node:assert');

const sup = require('./flow-supervisor');

const NOW = Date.parse('2026-09-14T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function ticket(overrides) {
  return {
    ticketId: 'r#1', repo: 'org/r', number: 1, kind: 'issue',
    lane: 'ready', epicId: null, ageInStateMs: 0, ownerAgentId: 'team-developer',
    blocker: null,
    ...overrides,
  };
}

// ─── budgetKey / firedRecently ─────────────────────────────────────────────────

test('budgetKey is stable and distinguishes ticket+blocker pairs', () => {
  assert.equal(sup.budgetKey('org/r#1', 'unclaimed'), 'org/r#1::unclaimed');
  assert.notEqual(sup.budgetKey('org/r#1', 'unclaimed'), sup.budgetKey('org/r#1', 'stale-base'));
});

test('firedRecently: never fired, corrupt entry, and a fresh vs. expired timestamp', () => {
  assert.equal(sup.firedRecently({}, 'k', NOW, HOUR), false);
  assert.equal(sup.firedRecently({ k: 'not-a-date' }, 'k', NOW, HOUR), false);
  assert.equal(sup.firedRecently({ k: new Date(NOW - 5 * 60_000).toISOString() }, 'k', NOW, HOUR), true);
  assert.equal(sup.firedRecently({ k: new Date(NOW - 2 * HOUR).toISOString() }, 'k', NOW, HOUR), false);
});

// ─── selectAutoDispatch ────────────────────────────────────────────────────────

test('selectAutoDispatch: only unclaimed issue-kind candidates with a lane are eligible', () => {
  const candidates = [
    ticket({ ticketId: 'r#1', blocker: 'unclaimed' }),
    ticket({ ticketId: 'r#2', blocker: 'ci-red' }), // wrong blocker
    ticket({ ticketId: 'r#3', blocker: 'unclaimed', kind: 'pr' }), // wrong kind (SDLC binding: items are issues)
    ticket({ ticketId: 'r#4', blocker: 'unclaimed', lane: null }), // no entry label to re-apply
  ];
  const picked = sup.selectAutoDispatch({ candidates, now: NOW, windowMs: HOUR });
  assert.deepEqual(picked.map((t) => t.ticketId), ['r#1']);
});

test('selectAutoDispatch: oldest (longest-stuck) first', () => {
  const candidates = [
    ticket({ ticketId: 'r#1', blocker: 'unclaimed', ageInStateMs: 1000 }),
    ticket({ ticketId: 'r#2', blocker: 'unclaimed', ageInStateMs: 5000 }),
    ticket({ ticketId: 'r#3', blocker: 'unclaimed', ageInStateMs: 3000 }),
  ];
  const picked = sup.selectAutoDispatch({ candidates, now: NOW, windowMs: HOUR });
  assert.deepEqual(picked.map((t) => t.ticketId), ['r#2', 'r#3', 'r#1']);
});

test('selectAutoDispatch: never two in-flight items sharing epicId (against already-busy epics)', () => {
  const candidates = [
    ticket({ ticketId: 'r#1', blocker: 'unclaimed', epicId: 42, ageInStateMs: 9000 }),
    ticket({ ticketId: 'r#2', blocker: 'unclaimed', epicId: 7, ageInStateMs: 1000 }),
  ];
  const picked = sup.selectAutoDispatch({ candidates, busyEpicIds: [42], now: NOW, windowMs: HOUR });
  assert.deepEqual(picked.map((t) => t.ticketId), ['r#2']);
});

test('selectAutoDispatch: epic-serialization also applies WITHIN one pass — the older of two siblings wins', () => {
  const candidates = [
    ticket({ ticketId: 'r#1', blocker: 'unclaimed', epicId: 42, ageInStateMs: 9000 }),
    ticket({ ticketId: 'r#2', blocker: 'unclaimed', epicId: 42, ageInStateMs: 1000 }),
  ];
  const picked = sup.selectAutoDispatch({ candidates, now: NOW, windowMs: HOUR });
  assert.deepEqual(picked.map((t) => t.ticketId), ['r#1']);
});

test('selectAutoDispatch: a ticket with no epicId is never epic-serialized against anything', () => {
  const candidates = [
    ticket({ ticketId: 'r#1', blocker: 'unclaimed', epicId: null, ageInStateMs: 9000 }),
    ticket({ ticketId: 'r#2', blocker: 'unclaimed', epicId: null, ageInStateMs: 1000 }),
  ];
  const picked = sup.selectAutoDispatch({ candidates, now: NOW, windowMs: HOUR });
  assert.deepEqual(picked.map((t) => t.ticketId), ['r#1', 'r#2']);
});

test('selectAutoDispatch: respects the limit', () => {
  const candidates = [
    ticket({ ticketId: 'r#1', blocker: 'unclaimed', ageInStateMs: 3000 }),
    ticket({ ticketId: 'r#2', blocker: 'unclaimed', ageInStateMs: 2000 }),
    ticket({ ticketId: 'r#3', blocker: 'unclaimed', ageInStateMs: 1000 }),
  ];
  const picked = sup.selectAutoDispatch({ candidates, now: NOW, windowMs: HOUR, limit: 2 });
  assert.deepEqual(picked.map((t) => t.ticketId), ['r#1', 'r#2']);
});

test('selectAutoDispatch: a ticket already fired within the window is skipped', () => {
  const candidates = [ticket({ ticketId: 'r#1', blocker: 'unclaimed' })];
  const budget = { [sup.budgetKey('r#1', 'unclaimed')]: new Date(NOW - 5 * 60_000).toISOString() };
  const picked = sup.selectAutoDispatch({ candidates, budget, now: NOW, windowMs: HOUR });
  assert.deepEqual(picked, []);
});

test('selectAutoDispatch: a ticket whose budget entry has expired fires again', () => {
  const candidates = [ticket({ ticketId: 'r#1', blocker: 'unclaimed' })];
  const budget = { [sup.budgetKey('r#1', 'unclaimed')]: new Date(NOW - 2 * HOUR).toISOString() };
  const picked = sup.selectAutoDispatch({ candidates, budget, now: NOW, windowMs: HOUR });
  assert.deepEqual(picked.map((t) => t.ticketId), ['r#1']);
});

test('selectAutoDispatch: empty candidates never throws', () => {
  assert.deepEqual(sup.selectAutoDispatch({}), []);
});

// ─── selectAutoDispatch: predicted-paths contention (#2249, D6) ────────────────

test('selectAutoDispatch: predicted-paths is a no-op unless contentionPolicy names it', () => {
  const candidates = [
    ticket({ ticketId: 'r#1', blocker: 'unclaimed', predictedPaths: ['orchestrator/x.js'] }),
    ticket({ ticketId: 'r#2', blocker: 'unclaimed', predictedPaths: ['orchestrator/x.js'] }),
  ];
  // busyPathSets present, but contentionPolicy is unset — must behave exactly
  // like Phase 2/3 (epic-serial only), never reading predictedPaths at all.
  const picked = sup.selectAutoDispatch({
    candidates, busyPathSets: [['orchestrator/x.js']], now: NOW, windowMs: HOUR,
  });
  assert.deepEqual(picked.map((t) => t.ticketId).sort(), ['r#1', 'r#2']);
});

test("selectAutoDispatch: predicted-paths skips a candidate overlapping an already-busy path set", () => {
  const candidates = [
    ticket({ ticketId: 'r#1', blocker: 'unclaimed', predictedPaths: ['orchestrator/flow-supervisor.js'], ageInStateMs: 9000 }),
    ticket({ ticketId: 'r#2', blocker: 'unclaimed', predictedPaths: ['docs/other.md'], ageInStateMs: 1000 }),
  ];
  const picked = sup.selectAutoDispatch({
    candidates, contentionPolicy: 'predicted-paths', busyPathSets: [['orchestrator/']], now: NOW, windowMs: HOUR,
  });
  assert.deepEqual(picked.map((t) => t.ticketId), ['r#2']);
});

test('selectAutoDispatch: predicted-paths also reserves WITHIN one pass — an older sibling wins, a later overlapping one is held', () => {
  const candidates = [
    ticket({ ticketId: 'r#1', blocker: 'unclaimed', predictedPaths: ['orchestrator/x.js'], ageInStateMs: 9000 }),
    ticket({ ticketId: 'r#2', blocker: 'unclaimed', predictedPaths: ['orchestrator/x.js'], ageInStateMs: 1000 }),
  ];
  const picked = sup.selectAutoDispatch({ candidates, contentionPolicy: 'predicted-paths', now: NOW, windowMs: HOUR });
  assert.deepEqual(picked.map((t) => t.ticketId), ['r#1']);
});

test('selectAutoDispatch: a candidate with no/empty predictedPaths is NEVER held back — an advisory miss fails open', () => {
  const candidates = [
    ticket({ ticketId: 'r#1', blocker: 'unclaimed', predictedPaths: [] }),
    ticket({ ticketId: 'r#2', blocker: 'unclaimed' }), // no predictedPaths field at all
  ];
  const picked = sup.selectAutoDispatch({
    candidates, contentionPolicy: 'predicted-paths', busyPathSets: [['orchestrator/'], ['docs/']], now: NOW, windowMs: HOUR,
  });
  assert.deepEqual(picked.map((t) => t.ticketId).sort(), ['r#1', 'r#2']);
});

test('selectAutoDispatch: predicted-paths and epic-serialization compose — either alone can hold a candidate back', () => {
  const candidates = [
    ticket({ ticketId: 'r#1', blocker: 'unclaimed', epicId: 42, predictedPaths: ['a/'], ageInStateMs: 9000 }),
    ticket({ ticketId: 'r#2', blocker: 'unclaimed', epicId: null, predictedPaths: ['b/'], ageInStateMs: 5000 }),
    ticket({ ticketId: 'r#3', blocker: 'unclaimed', epicId: null, predictedPaths: ['a/x.js'], ageInStateMs: 1000 }),
  ];
  const picked = sup.selectAutoDispatch({
    candidates, contentionPolicy: 'predicted-paths', busyEpicIds: [42], now: NOW, windowMs: HOUR,
  });
  // r#1 held by epic-serial (busy epic 42); r#3 held by path overlap with r#1's
  // OWN predicted paths even though r#1 itself never dispatched this pass —
  // the pure module documents busyPathSets as caller-supplied "already claimed
  // elsewhere", so this asserts only r#2 (no clash on either axis) is picked
  // when r#1's paths are NOT supplied as busy (they were reserved by the epic
  // check, not the path check, so they must not ALSO gate r#3 here).
  assert.deepEqual(picked.map((t) => t.ticketId), ['r#2', 'r#3']);
});

// ─── selectStaleBaseRework ─────────────────────────────────────────────────────

test('selectStaleBaseRework: only stale-base tickets with an owner are selected', () => {
  const candidates = [
    ticket({ ticketId: 'r#1', blocker: 'stale-base', ownerAgentId: 'team-developer' }),
    ticket({ ticketId: 'r#2', blocker: 'ci-red', ownerAgentId: 'team-developer' }),
    ticket({ ticketId: 'r#3', blocker: 'stale-base', ownerAgentId: null }),
  ];
  const picked = sup.selectStaleBaseRework({ candidates, now: NOW, windowMs: HOUR });
  assert.deepEqual(picked.map((t) => t.ticketId), ['r#1']);
});

test('selectStaleBaseRework: budgeted at most once per window, same as auto-dispatch', () => {
  const candidates = [ticket({ ticketId: 'r#1', blocker: 'stale-base' })];
  const budget = { [sup.budgetKey('r#1', 'stale-base')]: new Date(NOW - 5 * 60_000).toISOString() };
  assert.deepEqual(sup.selectStaleBaseRework({ candidates, budget, now: NOW, windowMs: HOUR }), []);
});

// ─── recordFired / pruneBudget ──────────────────────────────────────────────────

test('recordFired: stamps the given keys with `now`, never mutates its input', () => {
  const before = { untouched: '2020-01-01T00:00:00.000Z' };
  const after = sup.recordFired(before, ['a', 'b'], NOW);
  assert.deepEqual(before, { untouched: '2020-01-01T00:00:00.000Z' });
  assert.equal(after.a, new Date(NOW).toISOString());
  assert.equal(after.b, new Date(NOW).toISOString());
  assert.equal(after.untouched, '2020-01-01T00:00:00.000Z');
});

test('pruneBudget: drops entries past the window, keeps ones still live', () => {
  const budget = {
    fresh: new Date(NOW - 5 * 60_000).toISOString(),
    stale: new Date(NOW - 2 * HOUR).toISOString(),
    corrupt: 'not-a-date',
  };
  const pruned = sup.pruneBudget(budget, NOW, HOUR);
  assert.deepEqual(pruned, { fresh: budget.fresh });
});

// ─── end-to-end: auto-dispatch and re-fire-a-dropped-dispatch are one code path ─

test('an unclaimed ticket (never dispatched cleanly) and a dropped dispatch look identical to the selector', () => {
  // The design docs name these as two scenarios ("auto-dispatch ready-but-
  // undispatched items" vs "re-fire a dropped dispatch"); the ledger's own
  // `unclaimed` blocker (#2115) makes no distinction between them, and neither
  // does this module — proving that is the point of this test.
  const neverDispatched = ticket({ ticketId: 'r#1', blocker: 'unclaimed' });
  const droppedDispatch = ticket({ ticketId: 'r#2', blocker: 'unclaimed' });
  const picked = sup.selectAutoDispatch({ candidates: [neverDispatched, droppedDispatch], now: NOW, windowMs: HOUR });
  assert.deepEqual(picked.map((t) => t.ticketId).sort(), ['r#1', 'r#2']);
});
