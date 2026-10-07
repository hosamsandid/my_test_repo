'use strict';

// #571 — the knowledge helpers re-expressed over one fleet read. The parity
// tests run VERBATIM copies of the pre-#571 helpers (api.js at c824d48b7,
// copied into `legacy()` below with only their free variables injected) and the
// new fleet functions over the same fixture agents dir, and assert deep-equal
// output — key order included — for every team and caller. A divergence means
// the fleet changed what some knowledge view shows.
// Run: node --test admin-console/api/knowledge-fleet.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const kf = require('./knowledge-fleet');
const { visibleTeam, visibleAgent } = require('./scope');
const { resolveAgentTeam } = require('./agent-team');
const knowledgeSuggestions = require('./knowledge-suggestions');

/* ── Fixture agents dir ────────────────────────────────────────────────── */

const AGENTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-fleet-'));
const CONFIGS = {
  // a team agent + two members (one provisioned with an override, one stub)
  sq: { id: 'sq', role: 'team', teamId: 'tenantA', environmentId: 'env1', skills: ['s1', 's2'], token: 'TKN-team', displayName: 'Squad' },
  'sq-dev': { id: 'sq-dev', role: 'team-member', parentTeamId: 'sq', teamId: 'tenantA', environmentId: 'env1', token: 'TKN-1', skillsOverride: ['s2'], displayName: 'Dev' },
  'sq-rev': { id: 'sq-rev', role: 'team-member', parentTeamId: 'sq', teamId: 'tenantA', environmentId: 'env2' },
  // a second team whose member sits in another human tenant (multi-team)
  sq2: { id: 'sq2', role: 'team', teamId: 'tenantB', environmentId: 'env2', ownerId: 'u1' },
  'sq2-a': { id: 'sq2-a', role: 'team-member', parentTeamId: 'sq2', teamId: 'tenantA', environmentId: 'env3', token: 'TKN-2' },
  // an ephemeral / standalone agent decided by ownership, no team
  'eph-1': { id: 'eph-1', role: 'agent', ownerId: 'u1', ephemeral: true, token: 'TKN-3' },
  // a standalone agent in a human tenant, its env missing on disk
  solo: { id: 'solo', role: 'agent', teamId: 'tenantA', environmentId: 'env-missing' },
  // a team config with no `id` and no env — the bare/id-fallback split
  noenv: { role: 'team', teamId: 'tenantC' },
  // a member whose config id differs from its dir name
  'sq-odd': { id: 'sq-odd-cfg', role: 'team-member', parentTeamId: 'sq', teamId: 'tenantA' },
};
for (const [id, cfg] of Object.entries(CONFIGS)) {
  fs.mkdirSync(path.join(AGENTS_DIR, id));
  fs.writeFileSync(path.join(AGENTS_DIR, id, 'config.json'), JSON.stringify(cfg));
}
fs.mkdirSync(path.join(AGENTS_DIR, 'broken'));
fs.writeFileSync(path.join(AGENTS_DIR, 'broken', 'config.json'), '{not json');
fs.mkdirSync(path.join(AGENTS_DIR, 'no-config')); // a dir with no config.json
fs.writeFileSync(path.join(AGENTS_DIR, 'stray-file'), 'x');

const ENVS = {
  env1: { id: 'env1', knowledgeStore: { path: '/kb/one/', repoRef: { url: 'https://example.test/kb-one.git' } }, repositories: [{ url: 'https://example.test/one.git' }] },
  env2: { id: 'env2', repositories: [{ url: 'https://example.test/two.git' }] },
  env3: { id: 'env3', knowledgeStore: { path: 'kb3' } },
};
const OVERRIDES = { sq2: { knowledgeStore: { path: 'kb-two' } } };
const loadEnvironment = (id) => ENVS[id] || null;
const loadTeamKnowledgeOverrides = (teamId) => OVERRIDES[teamId] || {};
const KB_DEFAULT_STORE_PATH = 'docs/agent-knowledge/';

// api.js's own pure helpers, as of c824d48b7.
function agentKnowledgeTeam(cfg) {
  if (!cfg) return 'default';
  if (typeof cfg.parentTeamId === 'string' && cfg.parentTeamId.trim()) return cfg.parentTeamId;
  if (cfg.role === 'team' && typeof cfg.id === 'string' && cfg.id.trim()) return cfg.id;
  return cfg.teamId || 'default';
}
function agentMetaForScope(cfg) {
  return { teamId: resolveAgentTeam(cfg), ownerId: cfg && cfg.ownerId };
}
function readJsonFile(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}
function listAgentDirs() {
  try {
    return fs.readdirSync(AGENTS_DIR).filter(name => {
      const p = path.join(AGENTS_DIR, name);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'config.json'));
    });
  } catch {
    return [];
  }
}

/* ── Verbatim c824d48b7 helpers ────────────────────────────────────────── */

function legacy() {
  function knowledgeTeamVisible(scope, knowledgeTeamId) {
    if (!scope) return false;
    if (scope.all) return true;
    if (visibleTeam(scope, knowledgeTeamId)) return true;
    for (const id of listAgentDirs()) {
      const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
      if (agentKnowledgeTeam(cfg) !== knowledgeTeamId) continue;
      if (visibleTeam(scope, cfg.teamId)) return true;
    }
    return false;
  }
  function resolveTeamStorePath(teamId) {
    for (const id of listAgentDirs()) {
      const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
      if (agentKnowledgeTeam(cfg) !== teamId || !cfg.environmentId) continue;
      // #570: the KB store path is keyed per team — overlay the team's overrides.
      const env = knowledgeSuggestions.mergeTeamKnowledgeConfig(loadEnvironment(cfg.environmentId), loadTeamKnowledgeOverrides(teamId));
      const p = env && env.knowledgeStore && typeof env.knowledgeStore.path === 'string'
        ? env.knowledgeStore.path : null;
      if (p) return p.replace(/^\/+|\/+$/g, '') + '/';
    }
    return KB_DEFAULT_STORE_PATH;
  }
  function resolveTeamRepoUrl(teamId) {
    for (const id of listAgentDirs()) {
      const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
      if (agentKnowledgeTeam(cfg) !== teamId || !cfg.environmentId) continue;
      // #570: the KB repoRef is keyed per team — overlay the team's overrides.
      const env = knowledgeSuggestions.mergeTeamKnowledgeConfig(loadEnvironment(cfg.environmentId), loadTeamKnowledgeOverrides(teamId));
      const ref = env && env.knowledgeStore && env.knowledgeStore.repoRef;
      if (ref && ref.url) return ref.url;
      const repos = (env && env.repositories) || [];
      if (repos[0] && repos[0].url) return repos[0].url;
    }
    return null;
  }
  function teamAgentIds(teamId) {
    return listAgentDirs().filter(id => {
      const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
      return agentKnowledgeTeam(cfg) === teamId;
    });
  }
  function knowledgeTeamByAgent() {
    const map = new Map();
    for (const id of listAgentDirs()) {
      const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
      map.set(id, agentKnowledgeTeam({ ...cfg, id: cfg.id || id }));
    }
    return map;
  }
  function knowledgeScopeTeams(parsed, scope) {
    if (parsed.kind === 'team') return [parsed.id];
    if (parsed.kind === 'agent') {
      const cfg = readJsonFile(path.join(AGENTS_DIR, parsed.id, 'config.json'), {});
      return [agentKnowledgeTeam({ ...cfg, id: cfg.id || parsed.id })];
    }
    // global: every team that has agents, narrowed by membership scope.
    const teams = new Set();
    for (const id of listAgentDirs()) {
      const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
      teams.add(agentKnowledgeTeam({ ...cfg, id: cfg.id || id }));
    }
    return [...teams].filter(t => knowledgeTeamVisible(scope, t));
  }
  function gatherKnowledgeAgents(scope, teamIds) {
    const set = new Set(teamIds);
    const agents = [];
    for (const id of listAgentDirs()) {
      const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
      if (cfg.role === 'team') continue; // template holder, not a contributor
      const teamId = agentKnowledgeTeam({ ...cfg, id: cfg.id || id });
      if (!set.has(teamId)) continue;
      if (!visibleAgent(scope, agentMetaForScope(cfg))) continue;
      agents.push({ id, parentTeamId: teamId, environmentId: cfg.environmentId || null, displayName: cfg.displayName || id });
    }
    return agents;
  }
  function teamEnvironment(teamId) {
    let ids;
    try { ids = fs.readdirSync(AGENTS_DIR); } catch { return null; }
    for (const id of ids) {
      const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
      if (!cfg) continue;
      if (agentKnowledgeTeam({ ...cfg, id: cfg.id || id }) === teamId && cfg.environmentId) {
        const env = loadEnvironment(cfg.environmentId);
        if (env) return env;
      }
    }
    return null;
  }
  // The head of augmentSkillActivation: the team grant + the member walk.
  function skillActivationInputs(teamId) {
    const teamCfg = readJsonFile(path.join(AGENTS_DIR, teamId, 'config.json'), null);
    if (!teamCfg || teamCfg.role !== 'team') return null;
    const teamSkills = Array.isArray(teamCfg.skills) ? teamCfg.skills : [];

    let members = [];
    try {
      members = fs.readdirSync(AGENTS_DIR)
        .map(id => readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null))
        .filter(c => c && c.role === 'team-member' && c.parentTeamId === teamId);
    } catch { /* no agents dir */ }
    return { teamSkills, members };
  }
  return {
    knowledgeTeamVisible, resolveTeamStorePath, resolveTeamRepoUrl, teamAgentIds, knowledgeTeamByAgent,
    knowledgeScopeTeams, gatherKnowledgeAgents, teamEnvironment, skillActivationInputs,
  };
}

/* ── The fleet side ────────────────────────────────────────────────────── */

const errors = [];
function fleet() {
  return kf.buildKnowledgeFleet(listAgentDirs(), {
    readConfig: (id) => readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null),
    onEntryError: (id, err) => errors.push([id, err.message]),
    agentKnowledgeTeam,
    agentMetaForScope,
  });
}

const OLD = legacy();
const F = fleet();
const TEAMS = ['sq', 'sq2', 'default', 'tenantA', 'tenantB', 'tenantC', 'noenv', 'solo', 'eph-1', 'nope'];
const SCOPES = {
  admin: { all: true, teamIds: new Set(), roles: new Map(), userId: null },
  tenantA: { all: false, teamIds: new Set(['tenantA']), roles: new Map(), userId: 'u2' },
  tenantB: { all: false, teamIds: new Set(['tenantB']), roles: new Map(), userId: 'u1' },
  tenantC: { all: false, teamIds: new Set(['tenantC']), roles: new Map(), userId: 'u3' },
  ownerOnly: { all: false, teamIds: new Set(), roles: new Map(), userId: 'u1' },
  nobody: { all: false, teamIds: new Set(), roles: new Map(), userId: 'u9' },
  none: null,
};
const PARSED = [
  { kind: 'global', id: null, scope: 'global' },
  { kind: 'team', id: 'sq', scope: 'team:sq' },
  { kind: 'agent', id: 'sq-dev', scope: 'agent:sq-dev' },
  { kind: 'agent', id: 'noenv', scope: 'agent:noenv' },
  { kind: 'agent', id: 'broken', scope: 'agent:broken' },
  { kind: 'agent', id: 'ghost', scope: 'agent:ghost' },
];

test('the fixture reaches every edge: a malformed config, a config-less dir, a stray file', () => {
  assert.ok(listAgentDirs().includes('broken'));
  assert.ok(!listAgentDirs().includes('no-config'));
  assert.ok(!listAgentDirs().includes('stray-file'));
});

test('knowledgeTeamVisible: identical for every team × caller', () => {
  for (const [name, scope] of Object.entries(SCOPES)) {
    for (const t of TEAMS) {
      assert.equal(kf.knowledgeTeamVisible(F, scope, t, { visibleTeam }), OLD.knowledgeTeamVisible(scope, t), `${name} / ${t}`);
    }
  }
});

test('knowledgeTeamVisible: a lazy fleet is only built past the cheap checks', () => {
  let built = 0;
  const lazy = () => { built += 1; return F; };
  assert.equal(kf.knowledgeTeamVisible(lazy, null, 'sq', { visibleTeam }), false);
  assert.equal(kf.knowledgeTeamVisible(lazy, SCOPES.admin, 'sq', { visibleTeam }), true);
  assert.equal(kf.knowledgeTeamVisible(lazy, SCOPES.tenantA, 'tenantA', { visibleTeam }), true, 'a direct membership');
  assert.equal(built, 0);
  for (const [name, scope] of Object.entries(SCOPES)) {
    for (const t of TEAMS) {
      assert.equal(kf.knowledgeTeamVisible(lazy, scope, t, { visibleTeam }), kf.knowledgeTeamVisible(F, scope, t, { visibleTeam }), `${name} / ${t}`);
    }
  }
  assert.ok(built > 0, 'non-vacuous: some answer needed the fleet');
});

test('resolveTeamStorePath / resolveTeamRepoUrl / teamAgentIds / teamEnvironment: identical per team', () => {
  const deps = {
    loadEnvironment, loadTeamKnowledgeOverrides,
    mergeTeamKnowledgeConfig: knowledgeSuggestions.mergeTeamKnowledgeConfig,
    defaultStorePath: KB_DEFAULT_STORE_PATH,
  };
  for (const t of TEAMS) {
    assert.equal(kf.resolveTeamStorePath(F, t, deps), OLD.resolveTeamStorePath(t), `store path ${t}`);
    assert.equal(kf.resolveTeamRepoUrl(F, t, deps), OLD.resolveTeamRepoUrl(t), `repo url ${t}`);
    assert.deepEqual(kf.teamAgentIds(F, t), OLD.teamAgentIds(t), `agent ids ${t}`);
    assert.deepEqual(kf.teamEnvironment(F, t, { loadEnvironment }), OLD.teamEnvironment(t), `env ${t}`);
  }
  // Non-vacuous: the overrides and the default path are both exercised.
  assert.equal(OLD.resolveTeamStorePath('sq'), 'kb/one/');
  assert.equal(OLD.resolveTeamStorePath('sq2'), 'kb-two/');
  assert.equal(OLD.resolveTeamStorePath('nope'), KB_DEFAULT_STORE_PATH);
  assert.equal(OLD.resolveTeamRepoUrl('sq'), 'https://example.test/kb-one.git', 'a KB repoRef wins');
  assert.equal(OLD.resolveTeamRepoUrl('sq2'), 'https://example.test/two.git', 'else the first repository');
  assert.equal(OLD.resolveTeamRepoUrl('nope'), null);
});

test('knowledgeTeamByAgent: identical map, entry order included', () => {
  assert.deepEqual([...kf.knowledgeTeamByAgent(F)], [...OLD.knowledgeTeamByAgent()]);
});

test('knowledgeScopeTeams: identical for every scope kind × caller', () => {
  for (const [name, scope] of Object.entries(SCOPES)) {
    for (const parsed of PARSED) {
      const got = kf.knowledgeScopeTeams(F, parsed, {
        agentKnowledgeTeam,
        isVisible: (t) => kf.knowledgeTeamVisible(F, scope, t, { visibleTeam }),
      });
      assert.deepEqual(got, OLD.knowledgeScopeTeams(parsed, scope), `${name} / ${parsed.scope}`);
    }
  }
});

test('gatherKnowledgeAgents: identical rows, key order included, for every caller', () => {
  const teamSets = [['sq'], ['sq', 'sq2'], ['default', 'tenantA', 'tenantC'], TEAMS];
  for (const [name, scope] of Object.entries(SCOPES)) {
    for (const teamIds of teamSets) {
      const got = kf.gatherKnowledgeAgents(F, scope, teamIds, { visibleAgent });
      const want = OLD.gatherKnowledgeAgents(scope, teamIds);
      assert.equal(JSON.stringify(got), JSON.stringify(want), `${name} / ${teamIds}`);
    }
  }
});

test('augmentSkillActivation inputs: same grant, same members in the fields it reads', () => {
  for (const t of TEAMS) {
    const old = OLD.skillActivationInputs(t);
    const grant = kf.teamSkillGrant(F, t);
    if (!old) { assert.equal(grant, null, t); continue; }
    assert.deepEqual(grant.skills, old.teamSkills, t);
    // `id` is deliberately NOT the legacy `cfg.id` (see the next test), so the
    // parity check covers every other field.
    const project = (m) => ({
      displayName: m.displayName, parentTeamId: m.parentTeamId, teamId: m.teamId,
      skillsOverride: m.skillsOverride, provisioned: !!m.token,
    });
    const got = kf.teamMembers(F, t).map(({ id, ...rest }) => rest);
    assert.equal(JSON.stringify(got), JSON.stringify(old.members.map(project)), t);
  }
  assert.equal(kf.teamMembers(F, 'sq').length, 3, 'non-vacuous: sq has three members');
});

test('teamMembers keys each member by its directory, not cfg.id', () => {
  // A config id that differs from its dir must not redirect the manifest reads.
  const sqDirs = listAgentDirs().filter((id) => ['sq-dev', 'sq-odd', 'sq-rev'].includes(id));
  assert.deepEqual(kf.teamMembers(F, 'sq').map((m) => m.id), sqDirs);
  assert.ok(sqDirs.includes('sq-odd'), 'non-vacuous: the dir whose config id is sq-odd-cfg');
  // A member config with no `id` at all used to yield `id: undefined`, which
  // `path.join(AGENTS_DIR, m.id)` in augmentSkillActivation throws on — a 500
  // for the whole team graph.
  const f = kf.buildKnowledgeFleet(['t', 'm-noid'], {
    readConfig: (id) => (id === 't' ? { id: 't', role: 'team' } : { role: 'team-member', parentTeamId: 't' }),
    agentKnowledgeTeam, agentMetaForScope,
  });
  const members = kf.teamMembers(f, 't');
  assert.deepEqual(members.map((m) => m.id), ['m-noid']);
  assert.doesNotThrow(() => path.join(AGENTS_DIR, members[0].id));
});

test('no token ever reaches the fleet', () => {
  const dump = JSON.stringify(F.entries);
  assert.doesNotMatch(dump, /TKN-/);
  assert.ok(F.entries.every((e) => !('token' in e)));
  assert.equal(F.byId.get('sq-dev').provisioned, true);
  assert.equal(F.byId.get('sq-rev').provisioned, false);
});

test('a malformed config reads as empty (as before), is reported once, and never poisons the rest', () => {
  assert.deepEqual(errors.filter(([id]) => id === 'broken').length, 1);
  assert.equal(F.byId.get('broken').knowledgeTeam, 'default');
  assert.equal(F.entries.length, listAgentDirs().length);
});

test('a reader that throws is reported and read as empty', () => {
  const errs = [];
  const f = kf.buildKnowledgeFleet(['a', 'b'], {
    readConfig: (id) => { if (id === 'a') throw new Error('EIO'); return { id: 'b', role: 'team' }; },
    onEntryError: (id, err) => errs.push([id, err.message]),
    agentKnowledgeTeam, agentMetaForScope,
  });
  assert.deepEqual(errs, [['a', 'EIO']]);
  assert.equal(f.byId.get('b').knowledgeTeam, 'b');
});

test('a clean read is reported through onEntryOk, a broken one only through onEntryError', () => {
  const ok = [];
  const bad = [];
  kf.buildKnowledgeFleet(['a', 'b', 'c'], {
    readConfig: (id) => { if (id === 'a') throw new Error('Unexpected token'); return id === 'b' ? null : { id }; },
    onEntryError: (id, err) => bad.push([id, err.message]),
    onEntryOk: (id) => ok.push(id),
    agentKnowledgeTeam, agentMetaForScope,
  });
  assert.deepEqual(bad, [['a', 'Unexpected token'], ['b', 'config.json unreadable']]);
  assert.deepEqual(ok, ['c']);
});

test('entry warnings: once per broken streak, again on a new cause or after a fix', () => {
  const w = kf.createEntryWarnings();
  const e1 = new Error('Unexpected token n in JSON at position 1');
  assert.equal(w.shouldWarn('a', e1), true);
  assert.equal(w.shouldWarn('a', e1), false, 'the same breakage on the next build stays quiet');
  assert.equal(w.shouldWarn('b', e1), true, 'per agent');
  assert.equal(w.shouldWarn('a', new Error('EACCES')), true, 'a different cause is news');
  w.ok('a');
  assert.equal(w.size, 1, 'a fixed config is forgotten');
  assert.equal(w.shouldWarn('a', e1), true, 'a re-break after a clean read is logged again');
});

test('fleet entries are frozen', () => {
  const e = F.byId.get('sq');
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e.skills) && Object.isFrozen(F.entries));
  assert.throws(() => { e.skills.push('x'); }, TypeError);
});
