'use strict';

// Tests for the GET /api/assist/model-options logic (#1210). The route is a
// three-line wrapper (getScope → buildAssistModelOptions → res.json) and the
// admin-api suite has no HTTP harness, so we exercise the full payload builder
// against scopes produced by the real computeScope — this is the route test the
// AC calls for (Team-Member-of-A / no-membership / System-Admin scenarios).
// Run: node --test admin-console/api/assist-model-options.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeScope } = require('./scope');
const { buildAssistModelOptions, maskAssistProvider } = require('./assist-model-options');

const users = [
  { id: 'u-sys', subject: 'sys@corp.com', systemAdmin: true },
  { id: 'u-a', subject: 'alice@corp.com' },   // team-member of team A only
  { id: 'u-none', subject: 'nomad@corp.com' }, // no memberships
];
const memberships = [
  { userId: 'u-a', teamId: 'team-a', role: 'team-member' },
];

// A realistic registry: team-a key, team-b key, a system key assigned to team-a,
// a system key assigned to no team, and an oauth-token provider (never billable).
const endpoints = [
  { id: 'ep-a', name: 'Team A key', authType: 'api-key', scope: 'team', teamId: 'team-a',
    authTokenId: 'ep-a-tok', baseUrl: 'https://proxy/a', defaultModelId: 'claude-sonnet-4-6',
    models: [{ id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', kind: 'sonnet' }] },
  { id: 'ep-b', name: 'Team B key', authType: 'api-key', scope: 'team', teamId: 'team-b',
    authTokenId: 'ep-b-tok', baseUrl: 'https://proxy/b', models: [] },
  { id: 'ep-sys-a', name: 'Shared (A)', authType: 'api-key', scope: 'system', assignedTeamIds: ['team-a'],
    authTokenId: 'ep-sys-a-tok', baseUrl: 'https://proxy/sys', models: [{ id: 'm1' }] },
  { id: 'ep-sys-none', name: 'Shared (unassigned)', authType: 'api-key', scope: 'system', assignedTeamIds: [],
    authTokenId: 'ep-sys-none-tok', baseUrl: 'https://proxy/sysn', models: [] },
  { id: 'ep-oauth', name: 'Seat token', authType: 'oauth-token', scope: 'system', assignedTeamIds: ['team-a'],
    authTokenId: 'ep-oauth-tok', models: [{ id: 'x' }] },
];

const ids = (opts) => opts.providers.map(p => p.id).sort();

test('Team Member of team A sees exactly team A\'s usable providers (no oauth, no other team)', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const opts = buildAssistModelOptions(alice, endpoints, { envBaseUrl: 'https://env' });
  assert.deepEqual(ids(opts), ['ep-a', 'ep-sys-a']); // team-a team key + system key assigned to team-a
  assert.equal(opts.envFallbackActive, false);        // providers exist → no env fallback
});

test('user with no memberships gets an empty provider list', () => {
  const nomad = computeScope({ username: 'nomad@corp.com', adminUsername: 'admin', users, memberships });
  const opts = buildAssistModelOptions(nomad, endpoints, { envBaseUrl: 'https://env' });
  assert.deepEqual(opts.providers, []);
  // Providers ARE registered platform-wide, the caller just can't see any — this
  // is NOT the bootstrap env-fallback state.
  assert.equal(opts.envFallbackActive, false);
});

test('System Admin (scope.all) sees all non-oauth providers, oauth excluded', () => {
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  const opts = buildAssistModelOptions(sys, endpoints, { envBaseUrl: '' });
  assert.deepEqual(ids(opts), ['ep-a', 'ep-b', 'ep-sys-a', 'ep-sys-none']); // every api-key provider, oauth dropped
});

test('env admin behaves like a System Admin', () => {
  const env = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  const opts = buildAssistModelOptions(env, endpoints, {});
  assert.deepEqual(ids(opts), ['ep-a', 'ep-b', 'ep-sys-a', 'ep-sys-none']);
});

test('envFallbackActive: only when zero providers registered AND ANTHROPIC_BASE_URL set', () => {
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(buildAssistModelOptions(sys, [], { envBaseUrl: 'https://env' }).envFallbackActive, true);
  assert.equal(buildAssistModelOptions(sys, [], { envBaseUrl: '   ' }).envFallbackActive, false); // blank → false
  assert.equal(buildAssistModelOptions(sys, [], {}).envFallbackActive, false);                    // no base url
  assert.equal(buildAssistModelOptions(sys, endpoints, { envBaseUrl: 'https://env' }).envFallbackActive, false); // providers exist
});

test('masking: never leaks token material, defaults model from catalog', () => {
  const masked = maskAssistProvider(endpoints[0]);
  assert.deepEqual(masked, {
    id: 'ep-a',
    name: 'Team A key',
    scope: 'team',
    models: [{ id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', kind: 'sonnet' }],
    defaultModelId: 'claude-sonnet-4-6',
  });
  assert.equal('authTokenId' in masked, false);
  assert.equal('baseUrl' in masked, false);
  // A system endpoint reports scope 'system'; missing defaultModelId falls back to first model id.
  const sysMasked = maskAssistProvider(endpoints[2]);
  assert.equal(sysMasked.scope, 'system');
  assert.equal(sysMasked.defaultModelId, 'm1');
  // No models and no default → null, not undefined.
  assert.equal(maskAssistProvider(endpoints[1]).defaultModelId, null);
});
