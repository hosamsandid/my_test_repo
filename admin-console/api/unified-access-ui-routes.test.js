'use strict';

// Source-shape guard for PR7's backend enforcement + governance route (#2360).
// api.js boots on require and cannot be imported; this reads its source (the
// tiered-resource-routes.test.js technique).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function routeBody(opening) {
  const start = SRC.indexOf(opening);
  assert.ok(start > 0, `'${opening}' not found — re-point this guard`);
  const end = SRC.indexOf('\napp.', start + opening.length);
  assert.ok(end > start, `end of '${opening}' not found`);
  return SRC.slice(start, end);
}

// ── oauth-not-team enforcement (deferred from PR2, gated) ───────────────────

test('POST /api/llm-endpoints refuses a team-shared subscription behind the flag', () => {
  const body = routeBody("app.post('/api/llm-endpoints'");
  assert.match(
    body,
    /if \(RESOURCE_ACCESS_V2 && isOauth && !globalGate\.global && ownership\.scope !== 'personal'\)/,
    'a subscription must be personal or global, never team-shared — only behind the flag',
  );
  assert.match(body, /code: 'oauth-not-team'/);
});

test('PUT /api/llm-endpoints applies the same oauth rule to the effective auth type', () => {
  const body = routeBody("app.put('/api/llm-endpoints/:id'");
  assert.match(body, /if \(RESOURCE_ACCESS_V2 && isOauth && !globalGate\.global && ownership\.scope !== 'personal'\)/);
  assert.match(body, /code: 'oauth-not-team'/);
});

// ── governance: the masked personal-resources view ─────────────────────────

test('GET /api/admin/personal-resources is flag-gated, System-Admin-only, and masked', () => {
  const body = routeBody("app.get('/api/admin/personal-resources'");
  assert.match(body, /if \(!RESOURCE_ACCESS_V2\)/, 'dark when the unified model is off');
  assert.match(body, /if \(!scope\.all\)/, 'System-Admin-only');
  assert.match(body, /listPersonalResources\(\{/);
  // The masking is delegated to the pure module — the route must not hand-build
  // a record that could leak a token/baseUrl.
  assert.doesNotMatch(body, /authTokenId|baseUrl|privateKey/, 'the route must not touch secret-bearing fields');
});

// ── Agent-Team re-key: providerUsableByTeam matches the agent-team id (#2360) ──

test('providerUsableByTeam adds an agent-team team-service match behind the flag, keeping the legacy tenant match', () => {
  const start = SRC.indexOf('function providerUsableByTeam(');
  assert.ok(start > 0, 'providerUsableByTeam not found');
  const body = SRC.slice(start, SRC.indexOf('\n}', start));
  // Legacy compat: the tenant match stays (a 'default'-stamped provider works).
  assert.match(body, /credentialVisibleToTeam\(ep, teamId\)/);
  // The re-key + multi-team: a team provider serves a SET of agent teams
  // (teamIds, falling back to teamId); usable if agentTeamId is in the set.
  assert.match(body, /if \(!RESOURCE_ACCESS_V2 \|\| !agentTeamId\) return false;/);
  assert.match(body, /ep\.scope === 'team'/);
  assert.match(body, /Array\.isArray\(ep\.teamIds\)/);
  assert.match(body, /set\.map\(String\)\.includes\(String\(agentTeamId\)\)/);
});

// ── §14 / E10: personal-provider transition guard (subscription hard, api-key soft) ──

test('providerUsableByTeam voids the oauth lend for a multi-human squad (E9)', () => {
  const start = SRC.indexOf('function providerUsableByTeam(');
  const body = SRC.slice(start, SRC.indexOf('\n}', start));
  // The api-key lend still resolves; only a 'block' (personal oauth + ≥2 humans)
  // withdraws usability. Single-sourced through the pure policy module.
  assert.match(body, /personalDefaultTransitionRisk\(\{ provider: ep, humanMemberCount: teamHumanMemberCount\(agentTeamId\) \}\)/);
  assert.match(body, /risk\.level === 'block'.*return false/s);
});

test('teamHumanMemberCount counts squad memberships fresh (no cache)', () => {
  const start = SRC.indexOf('function teamHumanMemberCount(');
  assert.ok(start > 0, 'teamHumanMemberCount not found');
  const body = SRC.slice(start, SRC.indexOf('\n}', start));
  assert.match(body, /readJsonFile\(MEMBERSHIPS_INDEX, \[\]\)/);
  assert.match(body, /filter\(m => m && m\.teamId === teamId\)\.length/);
});

test('model-options surfaces the soft personalProviderNotice behind the flag', () => {
  const body = routeBody("app.get('/api/agents/:id/model-options'");
  assert.match(body, /RESOURCE_ACCESS_V2 && endpoint/);
  assert.match(body, /personalDefaultTransitionRisk\(\{ provider: endpoint, humanMemberCount: teamHumanMemberCount\(resolveAgentTeam\(cfg\)\) \}\)/);
  assert.match(body, /personalProviderNotice: providerRisk/);
});

// ── §14 / E10 follow-up: pickDefaultLlmBinding prefers a creator-usable provider ──

test('providerUsableAtCreation covers global / own-personal / new-squad team, by ownership', () => {
  const start = SRC.indexOf('function providerUsableAtCreation(');
  assert.ok(start > 0, 'providerUsableAtCreation not found');
  const body = SRC.slice(start, SRC.indexOf('\n}', start));
  assert.match(body, /if \(isGlobalProvider\(ep\)\) return true;/);
  // Ownership-direct (NOT the runtime lend): the creator's membership is written
  // a phase later, so the personal case matches on userId, not on membership.
  assert.match(body, /ep\.scope === 'personal'\) return .*String\(ep\.userId\) === String\(creatorUserId\)/s);
  assert.match(body, /ep\.scope === 'team'/);
});

test('pickDefaultLlmBinding is gated and falls back to endpoints[0]', () => {
  const start = SRC.indexOf('function pickDefaultLlmBinding(');
  const body = SRC.slice(start, SRC.indexOf('\n}', start));
  // Legacy blind pick is the untouched default.
  assert.match(body, /let ep = endpoints\[0\];/);
  // The preference is dark unless the flag is on AND a creator context is given.
  assert.match(body, /if \(RESOURCE_ACCESS_V2 && pref && pref\.creatorUserId\)/);
  assert.match(body, /endpoints\.find\(e => providerUsableAtCreation\(e, pref\)\)/);
});

test('every team/agent creation site passes a creatorUserId preference', () => {
  // Standalone quick-create + both POST /api/teams handlers (non-stream + stream).
  const calls = SRC.match(/(pickDefaultLlmBinding|defaultLlmEndpointForTeam)\(\{ creatorUserId: getScope\(req\)\.userId/g) || [];
  assert.ok(calls.length >= 3, `expected ≥3 preference-passing creation sites, found ${calls.length}`);
});

// ── Multi-team providers: co-owned management + team-set + clone auto-append (#2360) ──

test('canManageProvider is co-owned: any team in the set (flagged), else legacy', () => {
  const start = SRC.indexOf('function canManageProvider(');
  assert.ok(start > 0, 'canManageProvider not found');
  const body = SRC.slice(start, SRC.indexOf('\n}', start));
  assert.match(body, /if \(scope && scope\.all\) return true;/);
  assert.match(body, /RESOURCE_ACCESS_V2 && ep && ep\.scope === 'team'/);
  assert.match(body, /providerTeamSet\(ep\)\.some\(t => canManageTeam\(scope, t\)\)/);
});

test('provider create persists the team SET and validates it (resolveProviderTeamSet)', () => {
  const start = SRC.indexOf("app.post('/api/llm-endpoints'");
  const body = SRC.slice(start, SRC.indexOf('\napp.', start + 10));
  assert.match(body, /resolveProviderTeamSet\(scope, req\.body/);
  assert.match(body, /\{ teamIds: providerTeamIds \}/);
});

test('provider DELETE allows co-owned deletion (canManageProvider) plus the personal break-glass', () => {
  const start = SRC.indexOf("app.delete('/api/llm-endpoints/:id'");
  const body = SRC.slice(start, SRC.indexOf('\napp.', start + 10));
  assert.match(body, /!canDeleteCredential\(scope, ep\) && !canManageProvider\(scope, ep\)/);
});

test('cloning/reusing an env auto-appends the team to a team-scoped provider (best-effort)', () => {
  const gStart = SRC.indexOf('function ensureTeamOnEnvProvider(');
  assert.ok(gStart > 0, 'ensureTeamOnEnvProvider not found');
  const g = SRC.slice(gStart, SRC.indexOf('\n}', gStart));
  assert.match(g, /if \(!ep \|\| ep\.scope !== 'team'\) return;/, 'only team-scoped providers');
  assert.match(g, /ep\.teamIds = \[\.\.\.set, String\(teamAgentId\)\]/);
  // wired into the team-materialize path
  const teams = SRC.indexOf("app.post('/api/teams'");
  const teamsBody = SRC.slice(teams, SRC.indexOf('\napp.post', teams + 10));
  assert.match(teamsBody, /ensureTeamOnEnvProvider\(reusedEnv, teamId\)/);
});
