'use strict';

// Unit tests for the per-tick fleet snapshot (#569).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildFleetSnapshot, childrenOf, idsWithPrefix, createUnreadableConfigReporter,
  pooledRolesOf, wantsAdmissionSweep, wantsFlowSupervisorSweep, wantsRecurringPoolSweep,
} = require('./fleet-snapshot');

function fixture() {
  return new Map([
    ['t1', { id: 't1', role: 'team', wipLimit: 2 }],
    ['t1-dev', { id: 't1-dev', role: 'team-member', parentTeamId: 't1', pool: { enabled: true }, skillsOverride: ['a'] }],
    ['t1-dev-i7', { id: 't1-dev-i7', role: 'team-member', parentTeamId: 't1', poolInstance: true, poolOf: 't1-dev' }],
    ['broken', 'THROW'],
    ['t2', { id: 't2', role: 'team' }],
    ['t2-solo', { id: 't2-solo', role: 'team-member', parentTeamId: 't2' }],
    ['gone', null],
    ['loner', { id: 'loner', role: 'agent' }],
  ]);
}

function build(configs = fixture(), errors = []) {
  let reads = 0;
  const fleet = buildFleetSnapshot([...configs.keys()], {
    loadConfig: (id) => {
      reads++;
      const c = configs.get(id);
      if (c === 'THROW') throw new Error('torn config.json');
      return c ? structuredClone(c) : null;
    },
    onEntryError: (id, err) => errors.push([id, err.message]),
  });
  return { fleet, reads, errors };
}

test('one read per agent, in disk order, ids kept as listed', () => {
  const { fleet, reads } = build();
  assert.equal(reads, 8);
  assert.deepEqual(fleet.ids, ['t1', 't1-dev', 't1-dev-i7', 'broken', 't2', 't2-solo', 'gone', 'loner']);
});

test('team enumeration matches the old role === "team" filter', () => {
  assert.deepEqual(build().fleet.teamIds, ['t1', 't2']);
});

test('a config that throws is skipped as null and reported — the rest of the sweep is intact', () => {
  const errors = [];
  const { fleet } = build(fixture(), errors);
  assert.equal(fleet.configById.get('broken'), null);
  assert.equal(fleet.configById.get('gone'), null);
  assert.deepEqual(errors, [['broken', 'torn config.json']]);
  assert.equal(fleet.configById.get('t2').role, 'team');
});

test('the parent index lists each team\'s children in disk order', () => {
  const { fleet } = build();
  assert.deepEqual(childrenOf(fleet, 't1').map((c) => c.id), ['t1-dev', 't1-dev-i7']);
  assert.deepEqual(childrenOf(fleet, 't2').map((c) => c.id), ['t2-solo']);
  assert.deepEqual(childrenOf(fleet, 'loner'), []);
  assert.deepEqual(childrenOf(null, 't1'), []);
  assert.equal(childrenOf(fleet, 't1')[0].cfg, fleet.configById.get('t1-dev'), 'same object as configById');
});

test('idsWithPrefix narrows to a role\'s instance prefix with snapshot configs', () => {
  const { fleet } = build();
  assert.deepEqual(idsWithPrefix(fleet, 't1-dev-i').map((e) => e.id), ['t1-dev-i7']);
  assert.equal(idsWithPrefix(fleet, 't1-dev-i')[0].cfg.poolOf, 't1-dev');
  assert.deepEqual(idsWithPrefix(null, 't1-'), []);
});

test('configs and indexes are deep-frozen — a sweep cannot leak a mutation into the next team', () => {
  const { fleet } = build();
  const dev = fleet.configById.get('t1-dev');
  assert.ok(Object.isFrozen(dev));
  assert.ok(Object.isFrozen(dev.pool));
  assert.ok(Object.isFrozen(dev.skillsOverride));
  assert.throws(() => { dev.pool.enabled = false; }, TypeError);
  assert.throws(() => { dev.skillsOverride.push('b'); }, TypeError);
  assert.throws(() => { fleet.teamIds.push('x'); }, TypeError);
  assert.throws(() => { childrenOf(fleet, 't1').push({}); }, TypeError);
});

test('unreadable configs are kept on the snapshot with their error', () => {
  const { fleet } = build();
  assert.deepEqual([...fleet.unreadable.keys()], ['broken']);
  assert.equal(fleet.unreadable.get('broken').message, 'torn config.json');
});

test('the unreadable-config reporter warns once per agent across ticks, again only after a clean read', () => {
  const lines = [];
  const report = createUnreadableConfigReporter({ warn: (l) => lines.push(l) });
  const broken = build().fleet;
  for (const tick of ['admission', 'pool-reap', 'provisioning-reap', 'flow-supervisor', 'recurring-pool']) report(broken, tick);
  report(broken, 'admission');
  assert.deepEqual(lines, ['[Orchestrator] admission tick: config of broken unreadable, skipped: torn config.json']);

  const fixed = fixture();
  fixed.set('broken', { id: 'broken', role: 'agent' });
  report(build(fixed).fleet, 'pool-reap');
  assert.equal(lines.length, 1, 'a clean read is not itself a warning');
  report(broken, 'flow-supervisor');
  assert.equal(lines.length, 2, 'broken again after a clean read warns again');
  assert.match(lines[1], /^\[Orchestrator\] flow-supervisor tick: config of broken unreadable/);
});

test('the reporter tolerates a snapshot without the unreadable index', () => {
  const lines = [];
  const report = createUnreadableConfigReporter({ warn: (l) => lines.push(l) });
  report(null, 'admission');
  report({}, 'admission');
  assert.deepEqual(lines, []);
});

// ── tick pre-filters (#569 review) ─────────────────────────────────────────
// Each mirrors its sweep's own early returns; a team the predicate drops is
// one the sweep would have returned null for.

function opts(entries) {
  return buildFleetSnapshot(entries.map(([id]) => id), {
    loadConfig: (id) => structuredClone(entries.find(([e]) => e === id)[1]),
  });
}
const pooled = (teamId, pool = { enabled: true }) => [`${teamId}-dev`, { id: `${teamId}-dev`, role: 'team-member', parentTeamId: teamId, pool }];
const instance = (teamId) => [`${teamId}-dev-i1`, { id: `${teamId}-dev-i1`, role: 'team-member', parentTeamId: teamId, poolInstance: true, poolOf: `${teamId}-dev`, pool: { enabled: true } }];

test('pooledRolesOf: the team\'s pooled templates only — never an instance, never another team\'s', () => {
  const fleet = opts([
    ['a', { role: 'team' }], pooled('a'), instance('a'),
    ['a-plain', { role: 'team-member', parentTeamId: 'a' }],
    ['a-off', { role: 'team-member', parentTeamId: 'a', pool: { enabled: false } }],
    ['b', { role: 'team' }], pooled('b'),
  ]);
  assert.deepEqual(pooledRolesOf(fleet, 'a').map((r) => r.id), ['a-dev']);
  assert.equal(pooledRolesOf(fleet, 'a')[0].pool.enabled, true, 'carries the normalized pool');
  assert.deepEqual(pooledRolesOf(fleet, 'nope'), []);
  assert.deepEqual(pooledRolesOf(null, 'a'), []);
});

test('wantsAdmissionSweep: only a team whose wipLimit is in force (admissionSweepTeam\'s first return)', () => {
  const fleet = opts([
    ['lim', { role: 'team', wipLimit: 2 }],
    ['none', { role: 'team' }],
    ['zero', { role: 'team', wipLimit: 0 }],
    ['junk', { role: 'team', wipLimit: 'lots' }],
  ]);
  assert.deepEqual(fleet.teamIds.filter((id) => wantsAdmissionSweep(fleet, id)), ['lim']);
  assert.equal(wantsAdmissionSweep(fleet, 'missing'), false);
});

test('wantsFlowSupervisorSweep: autoDispatch.enabled === true AND a wipLimit AND a pooled role — each is required', () => {
  const on = { enabled: true };
  const fleet = opts([
    ['ok', { role: 'team', wipLimit: 2, autoDispatch: on }], pooled('ok'),
    ['no-auto', { role: 'team', wipLimit: 2 }], pooled('no-auto'),
    ['auto-off', { role: 'team', wipLimit: 2, autoDispatch: { enabled: false } }], pooled('auto-off'),
    ['auto-truthy', { role: 'team', wipLimit: 2, autoDispatch: { enabled: 'yes' } }], pooled('auto-truthy'),
    ['no-limit', { role: 'team', autoDispatch: on }], pooled('no-limit'),
    ['no-pool', { role: 'team', wipLimit: 2, autoDispatch: on }],
    ['only-instance', { role: 'team', wipLimit: 2, autoDispatch: on }], instance('only-instance'),
  ]);
  assert.deepEqual(fleet.teamIds.filter((id) => wantsFlowSupervisorSweep(fleet, id)), ['ok']);
});

test('wantsRecurringPoolSweep: only a team with a pooled role that configured a workSource', () => {
  const ws = { items: ['x'], outputDir: 'out' };
  const fleet = opts([
    ['rec', { role: 'team' }], pooled('rec', { enabled: true, workSource: ws }),
    ['sdlc', { role: 'team', wipLimit: 3 }], pooled('sdlc'),
    ['bad-ws', { role: 'team' }], pooled('bad-ws', { enabled: true, workSource: { items: [] } }),
    ['off', { role: 'team' }], pooled('off', { enabled: false, workSource: ws }),
  ]);
  assert.deepEqual(fleet.teamIds.filter((id) => wantsRecurringPoolSweep(fleet, id)), ['rec']);
});

test('no loader / no ids yields an empty snapshot', () => {
  const fleet = buildFleetSnapshot(undefined, { loadConfig: () => { throw new Error('never'); } });
  assert.deepEqual([...fleet.ids], []);
  assert.deepEqual([...fleet.teamIds], []);
});
