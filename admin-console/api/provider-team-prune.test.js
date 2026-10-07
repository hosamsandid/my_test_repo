'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { pruneTeamFromProviders } = require('./provider-team-prune');

// #2691 — a deleted Agent Team leaves every team provider's set it was in.

test('pruneTeamFromProviders: drops the team from a co-owned (auto-appended) set', () => {
  const list = [{ id: 'p1', scope: 'team', teamId: 'alpha', teamIds: ['alpha', 'alpha-clone'] }];
  const { list: next, pruned, kept } = pruneTeamFromProviders(list, 'alpha-clone');
  assert.deepEqual(pruned, ['p1']);
  assert.deepEqual(kept, []);
  assert.deepEqual(next[0].teamIds, ['alpha']);
  assert.equal(next[0].teamId, 'alpha');
  assert.deepEqual(list[0].teamIds, ['alpha', 'alpha-clone'], 'input is not mutated');
});

test('pruneTeamFromProviders: re-points the legacy primary teamId when it named the deleted team', () => {
  const list = [{ id: 'p1', scope: 'team', teamId: 'alpha', teamIds: ['alpha', 'beta'] }];
  const { list: next } = pruneTeamFromProviders(list, 'alpha');
  assert.deepEqual(next[0].teamIds, ['beta']);
  assert.equal(next[0].teamId, 'beta');
});

test('pruneTeamFromProviders: never makes a provider ownerless — a sole owner is kept, not pruned', () => {
  const list = [
    { id: 'own', scope: 'team', teamId: 'alpha', teamIds: ['alpha'] },
    { id: 'legacy', scope: 'team', teamId: 'alpha' },
  ];
  const { list: next, pruned, kept } = pruneTeamFromProviders(list, 'alpha');
  assert.deepEqual(pruned, []);
  assert.deepEqual(kept, ['own', 'legacy']);
  assert.equal(next[0], list[0]);
  assert.equal(next[1], list[1]);
});

test('pruneTeamFromProviders: leaves global/personal providers and unrelated teams alone', () => {
  const list = [
    { id: 'g', scope: 'system', global: true, teamIds: ['alpha', 'beta'] },
    { id: 'me', scope: 'personal', userId: 'u1' },
    { id: 'other', scope: 'team', teamId: 'beta', teamIds: ['beta', 'gamma'] },
  ];
  const { list: next, pruned } = pruneTeamFromProviders(list, 'alpha');
  assert.deepEqual(pruned, []);
  assert.deepEqual(next, list);
});

test('pruneTeamFromProviders: tolerates a missing team id or registry', () => {
  assert.deepEqual(pruneTeamFromProviders([], ''), { list: [], pruned: [], kept: [] });
  assert.deepEqual(pruneTeamFromProviders(null, 'alpha'), { list: [], pruned: [], kept: [] });
});

// ── api.js wiring: auto-append on reuse is undone on team delete ────────────

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function sliceFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  return SRC.slice(start, SRC.indexOf('\n}\n', start) + 2);
}

test('api.js: removeTeamFromProviders undoes ensureTeamOnEnvProvider (round trip over a live registry)', () => {
  let registry = [{ id: 'p1', scope: 'team', teamId: 'alpha', teamIds: ['alpha'] }];
  let saves = 0;
  const ctx = {
    pruneTeamFromProviders,
    listLlmEndpoints: () => JSON.parse(JSON.stringify(registry)),
    saveLlmEndpointsIndex: (list) => { saves += 1; registry = list; },
    console: { warn: () => {} },
    String,
    Array,
  };
  vm.createContext(ctx);
  vm.runInContext(
    [sliceFn('providerTeamSet'), sliceFn('ensureTeamOnEnvProvider'), sliceFn('removeTeamFromProviders')].join('\n')
      + '\nthis.ensure = ensureTeamOnEnvProvider; this.remove = removeTeamFromProviders;',
    ctx,
  );

  ctx.ensure({ llmEndpointId: 'p1' }, 'uitest-q05-t');
  assert.deepEqual([...registry[0].teamIds], ['alpha', 'uitest-q05-t'], 'reuse appends the team');

  ctx.remove('uitest-q05-t');
  assert.deepEqual([...registry[0].teamIds], ['alpha'], 'delete removes it again');
  assert.equal(registry[0].teamId, 'alpha');

  const before = saves;
  ctx.remove('alpha');
  assert.equal(saves, before, 'a sole owner is not removed — nothing is saved');
  assert.deepEqual([...registry[0].teamIds], ['alpha']);

  ctx.listLlmEndpoints = () => { throw new Error('disk gone'); };
  vm.runInContext('this.remove("x")', ctx); // best-effort: never throws
});

test('api.js: DELETE /api/agents/:id prunes a deleted TEAM from providers only after the orchestrator delete succeeded', () => {
  const start = SRC.indexOf("app.delete('/api/agents/:id', ");
  const body = SRC.slice(start, SRC.indexOf('\napp.', start + 10));
  const okGate = body.indexOf('if (!resp.ok)');
  const prune = body.indexOf("if (delCfg && delCfg.role === 'team') removeTeamFromProviders(id);");
  assert.ok(okGate > 0 && prune > okGate, 'prune runs after the !resp.ok early return');
});

test('api.js: a rolled-back team creation removes the auto-appended team again', () => {
  const start = SRC.indexOf("app.post('/api/teams', ");
  const body = SRC.slice(start, SRC.indexOf('\napp.post', start + 10));
  assert.match(body, /await rollbackDelete\(created\.team, 'team'\);\s*\n\s*\/\/[^\n]*\n\s*removeTeamFromProviders\(created\.team\);/);
});

test('api.js: GET /api/llm-endpoints flags team ids that name no current Agent Team', () => {
  const start = SRC.indexOf("app.get('/api/llm-endpoints', ");
  const body = SRC.slice(start, SRC.indexOf('\n});', start));
  assert.match(body, /\.\.\.deletedTeamIdsView\(ep\)/);
  assert.match(sliceFn('deletedTeamIdsView'), /providerTeamSet\(ep\)\.filter\(t => !agentTeamExists\(t\)\)/);
});
