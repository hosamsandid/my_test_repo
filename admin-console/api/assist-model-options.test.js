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
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  const opts = buildAssistModelOptions(alice, endpoints, { envBaseUrl: 'https://env' });
  assert.deepEqual(ids(opts), ['ep-a', 'ep-sys-a']); // team-a team key + system key assigned to team-a
  assert.equal(opts.envFallbackActive, false);        // providers exist → no env fallback
});

test('user with no memberships gets an empty provider list', () => {
  const nomad = computeScope({ username: 'nomad@corp.com', users, memberships });
  const opts = buildAssistModelOptions(nomad, endpoints, { envBaseUrl: 'https://env' });
  assert.deepEqual(opts.providers, []);
  // Providers ARE registered platform-wide, the caller just can't see any — this
  // is NOT the bootstrap env-fallback state.
  assert.equal(opts.envFallbackActive, false);
});

test('a global provider is offered to a user in no team (#2136)', () => {
  const nomad = computeScope({ username: 'nomad@corp.com', users, memberships });
  const withGlobal = [...endpoints,
    { id: 'ep-global', name: 'House model', authType: 'api-key', scope: 'system',
      assignedTeamIds: [], global: true, baseUrl: 'https://proxy/g', models: [{ id: 'g1' }] }];
  const opts = buildAssistModelOptions(nomad, withGlobal, { envBaseUrl: 'https://env' });
  assert.deepEqual(ids(opts), ['ep-global']);              // the teamless user reaches exactly the global one
  assert.equal(opts.providers[0].global, true);            // and it is badged global
  // A team member sees the global provider ALONGSIDE their own, with no duplication.
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  assert.deepEqual(ids(buildAssistModelOptions(alice, withGlobal, {})), ['ep-a', 'ep-global', 'ep-sys-a']);
});

test('System Admin (scope.all) sees all non-oauth providers, oauth excluded', () => {
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  const opts = buildAssistModelOptions(sys, endpoints, { envBaseUrl: '' });
  assert.deepEqual(ids(opts), ['ep-a', 'ep-b', 'ep-sys-a', 'ep-sys-none']); // every api-key provider, oauth dropped
});

test('a subject with no user record sees no provider (#2059)', () => {
  // This used to assert that `username: 'admin'` behaved like a System Admin,
  // via the env-admin branch of computeScope. That branch is gone: the seeded
  // administrator is an ordinary System-Admin RECORD (covered by the test
  // above), and a subject with no record fails closed like any other.
  const unknown = computeScope({ username: 'admin', users, memberships });
  assert.equal(unknown.all, false);
  assert.deepEqual(ids(buildAssistModelOptions(unknown, endpoints, {})), []);
});

test('envFallbackActive: only when zero providers registered AND ANTHROPIC_BASE_URL set', () => {
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  assert.equal(buildAssistModelOptions(sys, [], { envBaseUrl: 'https://env' }).envFallbackActive, true);
  assert.equal(buildAssistModelOptions(sys, [], { envBaseUrl: '   ' }).envFallbackActive, false); // blank → false
  assert.equal(buildAssistModelOptions(sys, [], {}).envFallbackActive, false);                    // no base url
  assert.equal(buildAssistModelOptions(sys, endpoints, { envBaseUrl: 'https://env' }).envFallbackActive, false); // providers exist
});

// ---- exclusionHint (#1402) -------------------------------------------------

test('exclusionHint: null when providers are available', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  const opts = buildAssistModelOptions(alice, endpoints, {});
  assert.equal(opts.exclusionHint, null);
});

test('exclusionHint: null when envFallbackActive (zero registered providers)', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  const opts = buildAssistModelOptions(alice, [], { envBaseUrl: 'https://env' });
  assert.equal(opts.envFallbackActive, true);
  assert.equal(opts.exclusionHint, null);
});

test('exclusionHint: null when no providers registered and no env fallback', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  const opts = buildAssistModelOptions(alice, [], {});
  assert.equal(opts.exclusionHint, null);
});

test('exclusionHint: all-oauth-token when every registered provider is oauth-token', () => {
  const oauthOnly = [
    { id: 'o1', authType: 'oauth-token', scope: 'system', assignedTeamIds: ['team-a'], models: [] },
    { id: 'o2', authType: 'oauth-token', scope: 'team', teamId: 'team-a', models: [] },
  ];
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  const opts = buildAssistModelOptions(alice, oauthOnly, {});
  assert.deepEqual(opts.providers, []);
  assert.equal(opts.exclusionHint, 'all-oauth-token');
});

test('exclusionHint: no-team-overlap when non-oauth providers exist but caller has no matching team', () => {
  const nomad = computeScope({ username: 'nomad@corp.com', users, memberships });
  const opts = buildAssistModelOptions(nomad, endpoints, {});
  assert.deepEqual(opts.providers, []);
  assert.equal(opts.exclusionHint, 'no-team-overlap');
});

test('exclusionHint: no-team-overlap not all-oauth when registry is mixed and caller has no overlap', () => {
  const mixed = [
    { id: 'o1', authType: 'oauth-token', scope: 'system', assignedTeamIds: ['team-a'], models: [] },
    { id: 'api1', authType: 'api-key', scope: 'team', teamId: 'team-b', models: [] },
  ];
  const nomad = computeScope({ username: 'nomad@corp.com', users, memberships });
  const opts = buildAssistModelOptions(nomad, mixed, {});
  assert.deepEqual(opts.providers, []);
  assert.equal(opts.exclusionHint, 'no-team-overlap');
});

test('masking: never leaks token material, defaults model from catalog', () => {
  const masked = maskAssistProvider(endpoints[0]);
  assert.deepEqual(masked, {
    id: 'ep-a',
    name: 'Team A key',
    scope: 'team',
    global: false,
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
