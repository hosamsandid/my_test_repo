'use strict';

// Source-reading drift guard for the #569 sweep-tick wiring. orchestrator.js
// can't be `require`d in a unit test; the pure halves (fleet-snapshot.js,
// sweep-tick.js, the maintenance memo) are unit-tested on their own. Pinned here:
//   1. the five 60 s ticks enumerate teams from ONE fleet snapshot each and
//      never scan the fleet themselves;
//   2. `_teamPooledRoles` answers from the snapshot when given one, and the
//      sweeps that run for every team pass it down;
//   3. the snapshot only picks candidates — every reap re-reads from disk;
//   4. the cap checks never read the snapshot;
//   5. the five ticks start in distinct stagger slots and log slow runs;
//   6. the unchanged pool-waiting write is skipped;
//   7. only the hot agent pull uses the maintenance memo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function fn(name) {
  const re = new RegExp(`\\n(?:async )?function ${name}\\(`);
  const m = re.exec(SRC);
  assert.ok(m, `${name} not found — this guard needs re-pointing`);
  const start = m.index + 1;
  const rest = SRC.slice(start + 1);
  const end = rest.search(/\n(?:async )?function /);
  return SRC.slice(start, end === -1 ? undefined : start + 1 + end);
}

function arrowConst(name) {
  const start = SRC.indexOf(`const ${name} = async () => {`);
  assert.ok(start > 0, `const ${name} not found — this guard needs re-pointing`);
  const rest = SRC.slice(start);
  const end = rest.indexOf('\n  };\n');
  return rest.slice(0, end);
}

const TICKS = [
  ['runAdmissionTick', 'admission', 0, 'ADMISSION_TICK_INTERVAL_MS'],
  ['runPoolReapTick', 'pool-reap', 1, 'POOL_REAP_TICK_INTERVAL_MS'],
  ['runProvisioningReapTick', 'provisioning-reap', 2, 'PROVISIONING_REAP_TICK_INTERVAL_MS'],
  ['runFlowSupervisorTick', 'flow-supervisor', 3, 'FLOW_SUPERVISOR_TICK_INTERVAL_MS'],
  ['runRecurringPoolTick', 'recurring-pool', 4, 'RECURRING_POOL_TICK_INTERVAL_MS'],
];

test('the guard is not vacuous: every slice has a body', () => {
  for (const [name] of TICKS) assert.ok(arrowConst(name).length > 200, `${name} came back empty`);
  for (const name of ['_teamPooledRoles', 'poolReapSweepTeam', 'provisioningReapSweep', '_liveInstanceIdsForRole']) {
    assert.ok(fn(name).length > 200, `${name} came back empty`);
  }
});

test('each tick builds one snapshot and never scans the fleet itself', () => {
  for (const [name, tick] of TICKS) {
    const src = arrowConst(name);
    assert.match(src, new RegExp(`buildTickFleet\\("${tick}"\\)`), `${name} builds its snapshot`);
    assert.equal(src.match(/buildTickFleet\(/g).length, 1, `${name} builds exactly one snapshot`);
    assert.doesNotMatch(src, /listAgentIds\(|loadAgentConfig\(/, `${name} must not scan the fleet directly`);
  }
});

test('every tick logs its own enumeration failure — the snapshot is never built inside a call\'s argument list', () => {
  for (const [name, prefix] of [
    ['runAdmissionTick', '[Admission] team enumeration failed'],
    ['runPoolReapTick', '[AgentPool] reap team enumeration failed'],
    ['runProvisioningReapTick', '[Provisioning] agent enumeration failed'],
    ['runFlowSupervisorTick', '[FlowSupervisor] team enumeration failed'],
    ['runRecurringPoolTick', '[AgentPool] recurring-pool team enumeration failed'],
  ]) {
    const src = arrowConst(name);
    const build = src.indexOf('fleet = buildTickFleet(');
    const log = src.indexOf(`console.warn(\`${prefix}: \${err.message}\`);`);
    assert.ok(build > 0 && log > build, `${name}: the snapshot build is caught and logged as "${prefix}"`);
    assert.doesNotMatch(src, /\(\w+\(Date\.now\(\), \{ fleet: buildTickFleet\(/, `${name}: never built in an argument list`);
  }
  // The sweep's own message is still the one an operator greps for.
  assert.match(fn('provisioningReapSweep'), /console\.warn\(`\[Provisioning\] agent enumeration failed: \$\{err\.message\}`\);/);
});

test('mutation-proved: the old per-tick enumeration would fail the check above', () => {
  const real = arrowConst('runAdmissionTick');
  const buggy = real.replace(
    'const teamIds = fleet.teamIds',
    'const teamIds = listAgentIds().filter((id) => loadAgentConfig(id))',
  );
  assert.notEqual(buggy, real, 'sanity: the mutation applied');
  assert.throws(() => assert.doesNotMatch(buggy, /listAgentIds\(|loadAgentConfig\(/), assert.AssertionError);
});

test('listAgentIds(prefix) (the cap checks\' scan) matches listAgentIds() narrowed by prefix, on a real dir', () => {
  const vm = require('node:vm');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-prefix-'));
  for (const [name, withConfig] of [['t-dev', true], ['t-dev-i1', true], ['t-dev-i2', false], ['t-dev-i30', true], ['u-dev-i1', true]]) {
    fs.mkdirSync(path.join(dir, name));
    if (withConfig) fs.writeFileSync(path.join(dir, name, 'config.json'), '{}');
  }
  const ctx = vm.createContext({ fs, path, AGENTS_DIR: dir });
  vm.runInContext(fn('listAgentIds'), ctx);
  const all = [...ctx.listAgentIds()];
  assert.deepEqual([...all].sort(), ['t-dev', 't-dev-i1', 't-dev-i30', 'u-dev-i1'], 'no prefix lists every agent');
  const expected = all.filter((id) => id.startsWith('t-dev-i'));
  assert.deepEqual([...ctx.listAgentIds('t-dev-i')], expected);
  assert.deepEqual([...expected].sort(), ['t-dev-i1', 't-dev-i30']);
  ctx.AGENTS_DIR = path.join(dir, 'missing');
  assert.deepEqual([...ctx.listAgentIds('t-dev-i')], [], 'no agents dir reads as none');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the snapshot is built from one listAgentIds() and loadAgentConfig, reported through one shared warn-once reporter', () => {
  const start = SRC.indexOf('const buildTickFleet = ');
  assert.ok(start > 0);
  const src = SRC.slice(start, SRC.indexOf('\n  };', start));
  assert.match(src, /fleetSnapshot\.buildFleetSnapshot\(listAgentIds\(\), \{ loadConfig: loadAgentConfig \}\)/);
  assert.match(src, /reportUnreadableConfigs\(fleet, tick\);/);
  assert.doesNotMatch(src, /onEntryError/, 'a per-tick warn would repeat 5×/min per torn config');
  assert.equal(SRC.match(/fleetSnapshot\.createUnreadableConfigReporter\(/g).length, 1, 'one reporter shared by every tick');
});

test('_teamPooledRoles answers from the snapshot when given one, and falls back to disk otherwise', () => {
  const src = fn('_teamPooledRoles');
  assert.match(src.split('\n')[0], /function _teamPooledRoles\(teamId, fleet = null\)/);
  assert.match(src, /fleet\s*\? fleetSnapshot\.childrenOf\(fleet, teamId\)\s*: listAgentIds\(\)/);
});

test('the every-team sweep passes the snapshot through all three of its _teamPooledRoles reads', () => {
  const reap = fn('poolReapSweepTeam');
  assert.match(reap.split('\n')[0], /poolReapSweepTeam\(teamId, now = Date\.now\(\), fleet = null\)/);
  assert.match(reap, /_teamPooledRoles\(teamId, fleet\)/);
  assert.doesNotMatch(reap, /_teamPooledRoles\(teamId\)/);
  assert.doesNotMatch(reap, /listAgentIds\(\)/);
  assert.match(reap, /settlePoolDrains\(teamId, fleet\)/);
  assert.match(reap, /_pruneArchivedPoolLogs\(teamId, now, fleet\)/);
  assert.match(fn('settlePoolDrains'), /_teamPooledRoles\(teamId, fleet\)/);
  assert.match(fn('_pruneArchivedPoolLogs'), /_teamPooledRoles\(teamId, fleet\)/);
  assert.match(arrowConst('runPoolReapTick'), /await poolReapSweepTeam\(teamId, Date\.now\(\), fleet\);/);
});

test('the snapshot only picks reap candidates — each is re-read from disk before any decision', () => {
  const reap = fn('poolReapSweepTeam');
  const pick = reap.indexOf('fleetSnapshot.idsWithPrefix(fleet, prefix)');
  const reread = reap.indexOf('cfg = loadAgentConfig(id);');
  const decide = reap.indexOf('agentPool.nextWaitRecord(');
  assert.ok(pick > 0 && reread > pick && decide > reread, 'pick → fresh read → decide');
  assert.match(reap, /if \(!cfg \|\| !cfg\.poolInstance \|\| cfg\.poolOf !== role\.id\) continue;/);

  const prov = fn('provisioningReapSweep');
  const provPick = prov.indexOf('c._provisioning === true');
  const provReread = prov.indexOf('cfg = loadAgentConfig(id);');
  assert.ok(provPick > 0 && provReread > provPick);
  assert.match(prov, /if \(!cfg \|\| cfg\._provisioning !== true\) continue;/);
});

test('the opt-in sweeps keep their own fresh team-config reads (the tick only pre-filters)', () => {
  assert.match(fn('admissionSweepTeam'), /teamCfg = loadAgentConfig\(teamId\);/);
  assert.match(fn('flowSupervisorSweepTeam'), /teamCfg = loadAgentConfig\(teamId\);/);
  assert.match(fn('recurringPoolSweepTeam'), /teamCfg = loadAgentConfig\(teamId\);/);
  // Its role cfg feeds startPoolSpawn — the re-read role, never a frozen snapshot.
  assert.match(fn('recurringPoolSweepTeam'), /for \(const role of _freshTeamPooledRoles\(teamId, fleet\)\)/);
  assert.match(fn('flowSupervisorSweepTeam'), /_freshTeamPooledRoles\(teamId, fleet\)/);
  for (const name of ['recurringPoolSweepTeam', 'flowSupervisorSweepTeam']) {
    assert.doesNotMatch(fn(name), /_teamPooledRoles\(teamId(, fleet)?\)/, `${name} must not act on snapshot roles`);
  }
  const fresh = fn('_freshTeamPooledRoles');
  assert.match(fresh, /if \(!fleet\) return _teamPooledRoles\(teamId\);/);
  assert.match(fresh, /_teamPooledRoles\(teamId, fleet\)\.map\(\(r\) => _rereadPooledRole\(teamId, r\.id\)\)\.filter\(Boolean\)/);
});

test('the opt-in ticks pre-filter with the pure fleet-snapshot predicates and pass the snapshot down', () => {
  for (const [name, predicate, sweep] of [
    ['runAdmissionTick', 'wantsAdmissionSweep', 'admissionSweepTeam'],
    ['runFlowSupervisorTick', 'wantsFlowSupervisorSweep', 'flowSupervisorSweepTeam'],
    ['runRecurringPoolTick', 'wantsRecurringPoolSweep', 'recurringPoolSweepTeam'],
  ]) {
    const src = arrowConst(name);
    assert.match(src, new RegExp(`fleet\\.teamIds\\.filter\\(\\(id\\) => fleetSnapshot\\.${predicate}\\(fleet, id\\)\\)`));
    assert.match(src, new RegExp(`await ${sweep}\\(teamId, \\{ fleet \\}\\);`));
  }
  // The full-fleet member walk behind admission + the supervisor's ledger.
  assert.match(fn('admissionSweepTeam'), /_flowTeamMembers\(teamId, fleet\)/);
  assert.match(fn('computeTeamTicketLedger'), /_flowTeamMembers\(teamId, fleet\)/);
  assert.match(fn('_ensurePredictedPaths'), /_flowTeamMembers\(teamId, fleet\)/);
  assert.match(fn('flowSupervisorSweepTeam'), /computeTeamTicketLedger\(teamId, \{ now, fleet \}\)/);
});

test('_flowTeamMembers with a snapshot reads only the team\'s own members, each fresh from disk', () => {
  const vm = require('node:vm');
  const fleetSnapshot = require('./fleet-snapshot');
  const disk = new Map([
    ['t', { id: 't', role: 'team' }],
    ['t-dev', { id: 't-dev', role: 'team-member', parentTeamId: 't', environmentId: 'env-1', emits: ['ready'] }],
    ['t-qa', { id: 't-qa', role: 'team-member', parentTeamId: 't' }],
    ['u', { id: 'u', role: 'team' }],
    ['u-dev', { id: 'u-dev', role: 'team-member', parentTeamId: 'u' }],
  ]);
  const fleet = fleetSnapshot.buildFleetSnapshot([...disk.keys()], { loadConfig: (id) => structuredClone(disk.get(id)) });
  // Edited after the snapshot: the member walk must see the edit.
  disk.set('t-dev', { ...disk.get('t-dev'), environmentId: 'env-2' });
  disk.set('t-qa', { ...disk.get('t-qa'), parentTeamId: 'u' }); // moved away
  const configReads = [];
  const triggerReads = [];
  const ctx = vm.createContext({
    fleetSnapshot,
    listAgentIds: () => { throw new Error('a snapshot walk must not list the fleet'); },
    loadAgentConfig: (id) => { configReads.push(id); return structuredClone(disk.get(id) || null); },
    agentStatePath: (id, f) => `${id}/${f}`,
    fs: { readFileSync: (p) => { triggerReads.push(p); return '[]'; } },
  });
  vm.runInContext(`${fn('_flowLiftEmits')}\n${fn('_flowTeamMembers')}`, ctx);
  const { members, envIds } = ctx._flowTeamMembers('t', fleet);
  assert.deepEqual(configReads, ['t-dev', 't-qa'], 'one fresh read per snapshot member, nobody else');
  assert.deepEqual([...members.map((m) => m.id)], ['t-dev'], 'a member that moved away since the snapshot is dropped');
  assert.deepEqual([...envIds], ['env-2'], 'the fresh config wins over the snapshot');
  assert.deepEqual(triggerReads, ['t-dev/triggers.json'], 'triggers.json only for actual members');
});

test('the maxInstances cap checks read live disk, never a snapshot, narrowed by prefix first', () => {
  for (const name of ['_liveInstanceIdsForRole', '_liveInstancesForRole']) {
    const src = fn(name);
    assert.match(src, /listAgentIds\(prefix\)/);
    assert.doesNotMatch(src, /fleet/);
  }
  const src = fn('listAgentIds');
  assert.ok(src.indexOf('f.startsWith(prefix)') < src.indexOf('fs.existsSync(path.join(AGENTS_DIR, f, "config.json"))'),
    'the prefix filter runs before the per-dir existsSync');
});

test('the five ticks start in distinct stagger slots and log slow runs', () => {
  for (const [name, tick, slot, interval] of TICKS) {
    assert.match(SRC, new RegExp(`startSweepTick\\(${slot}, ${interval}, ${name}, \\(\\) => \\{\\n\\s+const \\w+Timer = setInterval\\(${name}, ${interval}\\);`));
    assert.match(arrowConst(name), new RegExp(`logSlowTick\\("${tick}", tickStartedAt\\)`));
  }
  assert.match(SRC, /const SWEEP_TICK_SLOTS = 5;/);
  // One common-base schedule over all five, armed once after the last one
  // registered — never a per-tick fraction of its own interval.
  const arm = SRC.slice(SRC.indexOf('const armSweepTicks = () => {'), SRC.indexOf('const logSlowTick = '));
  assert.match(arm, /sweepTick\.sweepTickSchedule\(sweepTickSlots\.map\(/);
  assert.match(arm, /setTimeout\(\(\) => \{ void s\.run\(\); s\.start\(\); \}, schedule\[i\]\.firstRunMs\)/);
  assert.doesNotMatch(SRC, /tickOffsetMs/);
  const lastRegistered = SRC.indexOf('startSweepTick(4, RECURRING_POOL_TICK_INTERVAL_MS');
  const armed = SRC.indexOf('\n  armSweepTicks();');
  assert.ok(lastRegistered > 0 && armed > lastRegistered, 'armed after every tick registered');
  assert.equal(SRC.match(/\n\s+armSweepTicks\(\);/g).length, 1);
});

test('the unchanged pool-waiting write is skipped — unless the file on disk is not clean', () => {
  const reap = fn('poolReapSweepTeam');
  assert.match(reap, /const \{ waiting: prevWaiting, intact: prevWaitingIntact \} = loadPoolWaitingFile\(teamId\);/);
  assert.match(reap, /if \(agentPool\.poolWaitingNeedsWrite\(\{ intact: prevWaitingIntact, prev: prevWaiting, next: nextWaiting \}\)\) \{\n\s+savePoolWaiting\(teamId, nextWaiting\);/);
  const load = fn('loadPoolWaitingFile');
  assert.match(load, /err\.code !== "ENOENT"\) return \{ waiting: \{\}, intact: false \}/, 'an unreadable file is not intact; a missing one is');
  assert.match(load, /return agentPool\.parsePoolWaitingFile\(text\);/);
  assert.match(fn('loadPoolWaiting'), /return loadPoolWaitingFile\(teamId\)\.waiting;/);
});

test('pool-waiting.json is written atomically (tmp + rename), on a real dir', () => {
  const vm = require('node:vm');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-waiting-'));
  const target = path.join(dir, 'team', 'pool-waiting.json');
  const writes = [];
  const fsSpy = { ...fs, writeFileSync: (p, ...rest) => { writes.push(p); return fs.writeFileSync(p, ...rest); } };
  const ctx = vm.createContext({ fs: fsSpy, path, process, console, poolWaitingPath: () => target });
  vm.runInContext(fn('savePoolWaiting'), ctx);
  assert.equal(ctx.savePoolWaiting('team', { a: { waiting: true } }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { a: { waiting: true } });
  assert.equal(writes.length, 1);
  assert.notEqual(writes[0], target, 'never written in place');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['pool-waiting.json'], 'no tmp file left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only the agent pull uses the maintenance memo; gates keep the uncached read', () => {
  const start = SRC.indexOf("req.url === '/internal/maintenance-mode'");
  assert.ok(start > 0);
  assert.match(SRC.slice(start, start + 200), /readMaintenanceStateCached\(\)/);
  assert.equal(SRC.match(/readMaintenanceStateCached\(\)/g).length, 1);
  assert.match(arrowConst('runFlowSupervisorTick'), /readMaintenanceState\(\)/);
});

// #569 review (findings 1 + 2): the reaps are irreversible, so the role's
// budgets / pooled status are judged on a fresh read, not on the snapshot the
// tick took before a whole fleet of GitHub awaits. Run the real sweep code in
// a vm against stubbed I/O where the snapshot and the disk disagree.
function reapHarness({ diskRole, snapshotMaxRuntimeMs = 1_000, archivedAgoMs = null }) {
  const vm = require('node:vm');
  const agentPool = require('./agent-pool');
  const fleetSnapshot = require('./fleet-snapshot');
  const now = Date.parse('2026-10-06T12:00:00Z');
  const team = 't';
  const role = 't-dev';
  const inst = 't-dev-i7';
  const instanceCfg = {
    id: inst, role: 'team-member', parentTeamId: team, poolInstance: true, poolOf: role,
    poolRepo: 'o/r', poolItem: 7, poolSpawnedAt: new Date(now - 3_600_000).toISOString(),
  };
  const snapshotRole = {
    id: role, role: 'team-member', parentTeamId: team,
    pool: { enabled: true, teardown: { maxRuntimeMs: snapshotMaxRuntimeMs, retainLogsMs: 1_000 } },
  };
  const disk = new Map([[team, { id: team, role: 'team' }], [role, diskRole], [inst, instanceCfg]]);
  const fleet = fleetSnapshot.buildFleetSnapshot([team, role, inst], {
    loadConfig: (id) => structuredClone(id === role ? snapshotRole : disk.get(id)),
  });
  const deleted = [];
  const stamped = [];
  const pruned = [];
  const archiveRoot = path.join('/hc', team, 'pool-archive');
  const fsStub = {
    readdirSync: (p) => {
      if (p !== archiveRoot || archivedAgoMs == null) throw new Error('ENOENT');
      return [{ name: inst, isDirectory: () => true }];
    },
    readFileSync: () => JSON.stringify({ archivedAt: new Date(now - archivedAgoMs).toISOString() }),
    rmSync: (p) => pruned.push(p),
  };
  const ctx = vm.createContext({
    agentPool, fleetSnapshot, fs: fsStub, path,
    console: { log() {}, warn() {}, error() {} },
    HILL_CLIMB_TEAMS_DIR: '/hc',
    knowledgeFeed: { safeTeamSegment: (s) => s },
    listAgentIds: (prefix = '') => [...disk.keys()].filter((id) => id.startsWith(prefix)),
    loadAgentConfig: (id) => (disk.has(id) ? structuredClone(disk.get(id)) : null),
    loadPoolWaitingFile: () => ({ waiting: {}, intact: true }),
    savePoolWaiting: () => true,
    settlePoolDrains: () => {},
    _poolInstanceIsBusy: () => true, // busy → no open-PR lookup, never waiting
    _openPullsForRepo: async () => ({ ok: true, prs: [] }),
    _readInstanceStatus: () => ({ state: 'working' }),
    stampMirrorLabel: async (repo, item, label) => { stamped.push(`${repo}#${item}:${label}`); return true; },
    _internalSelfDelete: async (id) => { deleted.push(id); },
  });
  vm.runInContext(['_teamPooledRoles', '_rereadPooledRole', 'poolReapSweepTeam', '_pruneArchivedPoolLogs'].map(fn).join('\n'), ctx);
  return { run: () => ctx.poolReapSweepTeam(team, now, fleet), deleted, stamped, pruned };
}

const REAP_BASE_ROLE = { id: 't-dev', role: 'team-member', parentTeamId: 't' };

test('a hard timeout is judged on the role as it is on disk, not on the snapshot', async () => {
  // Sanity (non-vacuous): disk agrees with the 1 s snapshot budget → reaped.
  const agree = reapHarness({ diskRole: { ...REAP_BASE_ROLE, pool: { enabled: true, teardown: { maxRuntimeMs: 1_000 } } } });
  await agree.run();
  assert.deepEqual(agree.deleted, ['t-dev-i7']);
  assert.deepEqual(agree.stamped, ['o/r#7:needs-human']);

  // The operator raised the budget after the snapshot was taken → kept.
  const raised = reapHarness({ diskRole: { ...REAP_BASE_ROLE, pool: { enabled: true, teardown: { maxRuntimeMs: 86_400_000 } } } });
  await raised.run();
  assert.deepEqual(raised.deleted, []);
  assert.deepEqual(raised.stamped, []);

  // Pooling switched off after the snapshot → no reap at all.
  const off = reapHarness({ diskRole: { ...REAP_BASE_ROLE, pool: { enabled: false } } });
  await off.run();
  assert.deepEqual(off.deleted, []);
  assert.deepEqual(off.stamped, []);
});

test('the archive prune reads retainLogsMs from the role as it is on disk', async () => {
  const longBudget = { maxRuntimeMs: 86_400_000 };
  // Archived 1 h ago; the snapshot's 1 s retention would prune it.
  const agree = reapHarness({ archivedAgoMs: 3_600_000, diskRole: { ...REAP_BASE_ROLE, pool: { enabled: true, teardown: { ...longBudget, retainLogsMs: 1_000 } } } });
  await agree.run();
  assert.equal(agree.pruned.length, 1, 'sanity: a matching disk config prunes');

  const raised = reapHarness({ archivedAgoMs: 3_600_000, diskRole: { ...REAP_BASE_ROLE, pool: { enabled: true, teardown: { ...longBudget, retainLogsMs: 86_400_000 } } } });
  await raised.run();
  assert.deepEqual(raised.pruned, [], 'a raised retention keeps the archive');

  const off = reapHarness({ archivedAgoMs: 3_600_000, diskRole: { ...REAP_BASE_ROLE, pool: { enabled: false } } });
  await off.run();
  assert.deepEqual(off.pruned, [], 'a role no longer pooled prunes nothing');
});
