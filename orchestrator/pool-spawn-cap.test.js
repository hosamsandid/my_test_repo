'use strict';

// #2760 — the per-role `maxInstances` cap under concurrent dispatch, EXECUTED:
// the real `routePooledDispatch` / `startPoolSpawn` / `_retryPooledDispatch` /
// `_cappedInstanceIdsForRole` / `_liveInstanceIdsForRole` are sliced out of
// orchestrator.js (the monolith starts a service on require) and run in a vm
// against an in-memory agent store whose `spawnPoolInstance` only completes
// when the test says so. Several dispatches for DISTINCT items arriving before
// any spawn finishes used to all pass the cap check (only on-disk instances
// counted) — against the pre-#2760 code the first test spawns five, not three.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const agentPool = require('./agent-pool');
const admissionControl = require('./admission-control');
const poolSpawnSlots = require('./pool-spawn-slots');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function slice(name) {
  const m = SRC.match(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.ok(m, `orchestrator.js defines ${name}`);
  const start = m.index + 1;
  const end = SRC.indexOf('\n}\n', start);
  return SRC.slice(start, end + 2);
}

const FUNCS = ['_liveInstanceIdsForRole', '_cappedInstanceIdsForRole', 'startPoolSpawn', 'routePooledDispatch', '_retryPooledDispatch'];
const CODE = FUNCS.map(slice).join('\n');

const TEAM = 't';
const ROLE = 't-developer';

function issueEntry(n) {
  return { github: { repo: 'o/r', payload: { action: 'labeled', issue: { number: n } } } };
}

function harness({ maxInstances = 3, existing = [] } = {}) {
  const configs = new Map();
  configs.set(ROLE, { id: ROLE, role: 'team-member', parentTeamId: TEAM, pool: { enabled: true, maxInstances } });
  const instanceCfg = (id, item) => ({ id, role: 'team-member', parentTeamId: TEAM, poolInstance: true, poolOf: ROLE, poolItem: item });
  for (const item of existing) configs.set(`${ROLE}-i${item}`, instanceCfg(`${ROLE}-i${item}`, item));

  const spawns = [];     // { instanceId, itemKey, resolve, reject }
  const delivered = [];  // [agentId, entry]
  const timers = [];
  const ctx = vm.createContext({
    agentPool, admissionControl, poolSpawnSlots,
    poolSpawns: poolSpawnSlots.createSpawnSlots(),
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return {}; },
    listAgentIds: () => [...configs.keys()],
    loadAgentConfig: (id) => configs.get(id) || null,
    loadPoolControl: () => ({}),
    loadPausedHold: () => ({}),
    savePausedHold: () => {},
    spawnPoolInstance: (teamId, cfg, instanceId, itemKey) => new Promise((resolve, reject) => {
      spawns.push({
        instanceId, itemKey,
        resolve: () => { configs.set(instanceId, instanceCfg(instanceId, itemKey)); resolve({ id: instanceId, reused: false }); },
        reject: () => reject(new Error('GitHub lookup failed')),
      });
    }),
  });
  vm.runInContext(CODE, ctx);
  // The real enqueuePending's pooled branch, reduced to what this test needs:
  // route through the pool, and record where the dispatch finally lands.
  ctx.enqueuePending = (agentId, entry) => {
    const pooled = ctx.routePooledDispatch(agentId, entry);
    if (pooled && (pooled.held || pooled.spawning)) return true;
    delivered.push([pooled ? pooled.targetId : agentId, entry]);
    return true;
  };
  const flush = () => new Promise((r) => setImmediate(r));
  return { ctx, configs, spawns, delivered, timers, flush, dispatch: (n) => ctx.enqueuePending(ROLE, issueEntry(n)) };
}

test('AC1/AC7: five dispatches for distinct items before any spawn completes start only maxInstances spawns', async () => {
  const h = harness({ maxInstances: 3 });
  for (const n of [1, 2, 3, 4, 5]) h.dispatch(n);
  assert.deepEqual(h.spawns.map((s) => s.itemKey), [1, 2, 3], 'only three instances may be provisioning at once');
  // The two refused ones take the ordinary max-instances path (unchanged, AC3).
  assert.deepEqual(h.delivered.map(([id, e]) => [id, e.github.payload.issue.number]), [[ROLE, 4], [ROLE, 5]]);
  for (const s of h.spawns) s.resolve();
  await h.flush();
  const live = [...h.configs.values()].filter((c) => c.poolInstance).length;
  assert.equal(live, 3);
});

test('AC1: provisioning instances and on-disk instances share one cap', () => {
  const h = harness({ maxInstances: 3, existing: [10, 11] });
  for (const n of [1, 2, 3]) h.dispatch(n);
  assert.deepEqual(h.spawns.map((s) => s.itemKey), [1]);
});

test('AC4: a second dispatch for an item still provisioning joins that spawn and lands on the instance', async () => {
  const h = harness({ maxInstances: 2 });
  h.dispatch(1);
  h.dispatch(1);
  h.dispatch(2);
  assert.deepEqual(h.spawns.map((s) => s.itemKey), [1, 2], 'no second spawn for item 1, and item 2 still fits');
  assert.equal(h.delivered.length, 0, 'nothing written to the template or a not-yet-existing instance');
  h.spawns[0].resolve();
  await h.flush();
  assert.deepEqual(h.delivered.map(([id]) => id), [`${ROLE}-i1`, `${ROLE}-i1`], 'both item-1 dispatches land on its instance');
});

test('AC2: a completed spawn keeps counting (now on disk); a failed spawn frees its slot for the next dispatch', async () => {
  const h = harness({ maxInstances: 2 });
  h.dispatch(1);
  h.dispatch(2);
  h.spawns[0].resolve();
  h.spawns[1].reject();
  await h.flush();
  h.dispatch(3);
  assert.deepEqual(h.spawns.map((s) => s.itemKey), [1, 2, 3], 'item 2’s failed slot is reusable; item 1 still holds its own');
  h.dispatch(4);
  assert.equal(h.spawns.length, 3, 'cap of 2 reached again (i1 live + i3 provisioning)');
});

test('edge case: a failed spawn is retried with backoff, re-checking the cap; retries are bounded', async () => {
  const h = harness({ maxInstances: 1 });
  h.dispatch(7);
  h.spawns[0].reject();
  await h.flush();
  assert.equal(h.timers.length, 1, 'one retry scheduled');
  assert.equal(h.timers[0].ms, poolSpawnSlots.SPAWN_RETRY_DELAYS_MS[0]);
  h.timers[0].fn();
  assert.equal(h.spawns.length, 2, 'the retry re-routes the same dispatch and spawns again');
  assert.equal(h.spawns[1].itemKey, 7);
  for (let i = 1; i < poolSpawnSlots.SPAWN_RETRY_DELAYS_MS.length + 1; i++) {
    h.spawns[i].reject();
    await h.flush();
    if (h.timers[i]) h.timers[i].fn();
  }
  assert.equal(h.timers.length, poolSpawnSlots.SPAWN_RETRY_DELAYS_MS.length, 'no retry beyond the last delay');
});

test('AC6: a cap lowered below the live count starts nothing new but still routes an existing item to its instance', () => {
  const h = harness({ maxInstances: 2, existing: [1, 2, 3] });
  h.dispatch(4);
  assert.equal(h.spawns.length, 0);
  h.dispatch(2);
  assert.deepEqual(h.delivered.at(-1)[0], `${ROLE}-i2`);
});

test('blank cap: no per-role limit applies (the team WIP limit governs upstream)', () => {
  const h = harness({ maxInstances: null });
  for (const n of [1, 2, 3, 4, 5]) h.dispatch(n);
  assert.equal(h.spawns.length, 5);
});
