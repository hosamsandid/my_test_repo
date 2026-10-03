'use strict';

// #2689 — team skill pools keyed by the Agent Team id, the same key seeding
// reads (orchestrator.js agentKnowledgeTeamId). Every team agent still carries
// the legacy `teamId: "default"`; create/import, adopt activation, the delete
// and move guards and the grant-save check all keyed on it and missed the pool
// the team actually seeds from.
//
// Two layers: the pure module (skill-pool-team.js), and the real api.js
// functions that use it. api.js boots listeners on require (#651), so those
// functions are sliced out of the source and run in a vm against a temp
// workspace — the behaviour is pinned, not just the presence of a call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const skillPoolTeam = require('./skill-pool-team');
const { agentPoolTeamId, poolTeamExists, squadsForPoolTeam } = skillPoolTeam;

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
const ORCH_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'orchestrator.js'), 'utf8');

// A legacy-shaped Agent Team: own id, but the human `teamId` is still "default".
const team = { id: 'uitest-chat-agent-team', role: 'team', teamId: 'default' };
const member = { id: 'uitest-chat-dev', role: 'team-member', parentTeamId: team.id, teamId: 'default' };
const standalone = { id: 'solo', role: 'agent', teamId: 'acme' };

/** Slice a top-level `function name(` / `async function name(` out of `src`. */
function sliceFunction(src, name) {
  const re = new RegExp(`\\n(async )?function ${name}\\(`);
  const m = re.exec(src);
  assert.ok(m, `function ${name} not found — this guard needs re-pointing`);
  const start = m.index + 1;
  let depth = 0;
  let i = src.indexOf('{', src.indexOf(')', start));
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

/* ─── Pure module ─────────────────────────────────────────────────────────── */

test('agentPoolTeamId: Agent Team id for a team and its members, legacy teamId only for standalone', () => {
  assert.equal(agentPoolTeamId(team), team.id);
  assert.equal(agentPoolTeamId(member), team.id);
  assert.equal(agentPoolTeamId(standalone), 'acme');
  assert.equal(agentPoolTeamId({ role: 'agent' }), 'default');
  assert.equal(agentPoolTeamId(null), 'default');
});

test('agentPoolTeamId agrees with the orchestrator seeding key (agentKnowledgeTeamId)', () => {
  const ctx = { DEFAULT_TEAM_ID: 'default' };
  vm.runInNewContext(`${sliceFunction(ORCH_SRC, 'agentKnowledgeTeamId')}; this.f = agentKnowledgeTeamId;`, ctx);
  for (const cfg of [team, member, standalone, { role: 'agent' }, { role: 'team', id: ' ' , teamId: 't' }, null]) {
    assert.equal(agentPoolTeamId(cfg), ctx.f(cfg), JSON.stringify(cfg));
  }
});

test('poolTeamExists: an Agent Team id or a legacy human team; not a member or an unknown id', () => {
  assert.equal(poolTeamExists(team.id, { agentConfig: team }), true);
  assert.equal(poolTeamExists('acme', { legacyTeams: [{ id: 'acme' }] }), true);
  assert.equal(poolTeamExists(member.id, { agentConfig: member }), false);
  assert.equal(poolTeamExists('ghost', { agentConfig: null, legacyTeams: [{ id: 'acme' }] }), false);
  assert.equal(poolTeamExists('', {}), false);
});

test('squadsForPoolTeam: the Agent Team itself, never the legacy human-team match', () => {
  const other = { id: 'other-team', role: 'team', teamId: 'default' };
  assert.deepEqual(squadsForPoolTeam([team, member, other, standalone], team.id), [team.id]);
  assert.deepEqual(squadsForPoolTeam([team, other], 'default'), []);
});

/* ─── api.js functions, run for real against a temp workspace ─────────────── */

/** vm-realm arrays/objects fail deepEqual on their foreign prototypes. */
const plain = (v) => JSON.parse(JSON.stringify(v));

function apiHarness() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-pool-team-'));
  const AGENTS_DIR = path.join(ws, 'agents');
  const POOL_DIR = path.join(ws, 'pool');
  const TEAMS_INDEX = path.join(ws, 'teams', 'index.json');
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(TEAMS_INDEX), { recursive: true });
  fs.writeFileSync(TEAMS_INDEX, JSON.stringify([{ id: 'default' }]));
  const fetchCalls = [];
  const ctx = {
    fs, path, process: { env: { ORCHESTRATOR_URL: 'http://orch' } }, JSON,
    WORKSPACE: ws, AGENTS_DIR, POOL_DIR, TEAMS_INDEX, DEFAULT_TEAM_ID: 'default',
    POOL_TEAM_ID_RE: /^[a-z0-9][a-z0-9-]{0,63}$/,
    SKILL_NAME_RE: /^[a-zA-Z0-9_-]+([.:][a-zA-Z0-9_-]+)*$/,
    skillPoolTeam,
    readJsonFile: (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } },
    fetch: async (url, opts) => { fetchCalls.push({ url, body: JSON.parse(opts.body) }); return { status: 200 }; },
  };
  const names = ['resolveTeamExists', 'safeTeamSkillDir', 'resolveGrantTier', 'blockingGrantsForDeletion',
    'agentsGrantingSkill', 'activateTransferredTeamSkill'];
  vm.runInNewContext(`${names.map((n) => sliceFunction(API_SRC, n)).join('\n')}
    this.api = { ${names.join(', ')} };`, ctx);
  const writeAgent = (cfg) => {
    fs.mkdirSync(path.join(AGENTS_DIR, cfg.id), { recursive: true });
    fs.writeFileSync(path.join(AGENTS_DIR, cfg.id, 'config.json'), JSON.stringify(cfg));
  };
  const writeSkill = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), '# s'); };
  return {
    api: ctx.api, fetchCalls, writeAgent,
    globalSkill: (name) => writeSkill(path.join(POOL_DIR, 'skills', name)),
    teamSkill: (teamId, name) => writeSkill(path.join(ws, 'teams', teamId, 'skills', name)),
    cleanup: () => fs.rmSync(ws, { recursive: true, force: true }),
  };
}

test('AC1 resolveTeamExists: an Agent Team target is found (was "Team not found"), legacy index still works', (t) => {
  const h = apiHarness();
  t.after(h.cleanup);
  h.writeAgent(team);
  h.writeAgent(member);
  assert.equal(h.api.resolveTeamExists(team.id), true);
  assert.equal(h.api.resolveTeamExists('default'), true);
  assert.equal(h.api.resolveTeamExists(member.id), false, 'a member is not a pool target');
  assert.equal(h.api.resolveTeamExists('nope'), false);
  assert.equal(h.api.resolveTeamExists('../agents'), false);
});

test('AC1 create/import write to teams/<id>/skills — the pool seeding reads for that Agent Team', () => {
  // Both routes gate on resolveTeamExists(teamId) and then write via the
  // teamId-keyed dir resolvers, so the target id IS the pool dir.
  const create = API_SRC.slice(API_SRC.indexOf("app.post('/api/skills',"), API_SRC.indexOf("app.post('/api/skills',") + 2500);
  assert.match(create, /resolveTeamExists\(teamId\)/);
  assert.match(create, /safeTeamSkillDir\(teamId, name\)/);
  const imp = API_SRC.slice(API_SRC.indexOf("app.post('/api/skills/import',"));
  assert.match(imp.slice(0, imp.indexOf('\napp.', 1)), /resolveTeamExists\(plan\.teamId\)/);
});

test('AC2 adopt activation: activates on the Agent Team that owns the pool, not on legacy-teamId squads', async (t) => {
  const h = apiHarness();
  t.after(h.cleanup);
  h.writeAgent(team);
  h.writeAgent(member);
  h.writeAgent({ id: 'other-team', role: 'team', teamId: 'default' });
  const results = await h.api.activateTransferredTeamSkill(team.id, 'web-search');
  assert.deepEqual(plain(results.map((r) => r.squadId)), [team.id]);
  assert.deepEqual(plain(h.fetchCalls.map((c) => c.url)), [`http://orch/internal/teams/${team.id}/skills/activate`]);
  assert.equal(h.fetchCalls[0].body.skillName, 'web-search');
  assert.deepEqual(plain(await h.api.activateTransferredTeamSkill('default', 'web-search')), [],
    'the legacy human-team id no longer fans out to every team agent');
});

test('AC3 delete guard: a team copy shadows the global one — deleting the global copy is not blocked', (t) => {
  const h = apiHarness();
  t.after(h.cleanup);
  h.writeAgent({ ...team, skills: ['web-search'] });
  h.globalSkill('web-search');
  h.teamSkill(team.id, 'web-search');
  assert.deepEqual(plain(h.api.blockingGrantsForDeletion({ tier: 'global', name: 'web-search' })), []);
});

test('AC3 delete guard: deleting the team copy the team resolves to IS blocked', (t) => {
  const h = apiHarness();
  t.after(h.cleanup);
  h.writeAgent({ ...team, skills: ['web-search'] });
  h.writeAgent({ ...member, skillsOverride: ['web-search'] });
  h.teamSkill(team.id, 'web-search');
  const ids = h.api.blockingGrantsForDeletion({ tier: 'team', teamId: team.id, name: 'web-search' }).map((b) => b.id);
  assert.deepEqual(plain(ids).sort(), [member.id, team.id].sort());
});

test('AC3 delete guard: without a team copy, deleting the global copy is blocked as before', (t) => {
  const h = apiHarness();
  t.after(h.cleanup);
  h.writeAgent({ ...team, skills: ['web-search'] });
  h.globalSkill('web-search');
  assert.deepEqual(plain(h.api.blockingGrantsForDeletion({ tier: 'global', name: 'web-search' }).map((b) => b.id)), [team.id]);
});

test('move guard: grants are attributed to their Agent Team pool, not the legacy teamId', (t) => {
  const h = apiHarness();
  t.after(h.cleanup);
  h.writeAgent({ ...team, skills: ['web-search'] });
  h.writeAgent({ ...member, skillsOverride: ['web-search'] });
  const out = h.api.agentsGrantingSkill('web-search');
  assert.deepEqual(plain(out.map((a) => a.teamId)), [team.id, team.id]);
});

test('AC4 grant save: known skill names come from the construct\'s Agent Team pool', () => {
  const put = API_SRC.slice(API_SRC.indexOf("app.put('/api/agents/:id',"));
  const body = put.slice(0, put.indexOf('\napp.', 1));
  assert.match(body, /knownSkillNamesFor\(skillPoolTeam\.agentPoolTeamId\(/,
    'a team-only skill must be grantable — the legacy cfg.teamId rejected it as unknown');
  assert.doesNotMatch(body, /knownSkillNamesFor\(cfg\.teamId\)/);
});
