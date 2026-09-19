'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mint, verify } = require('./plugin-scope-token');
const {
  resolveScopeId,
  ownerLabelArg,
  isOwned,
  filterOwned,
  OWNER_LABEL_KEY,
  DEFAULT_GRANULARITY,
} = require('./plugin-scope');

const SECRET = 'sec';
const PLUGIN = 'sandbox';

const memberA = { id: 'agent-aaaa', parentTeamId: 'team-1' };
const memberB = { id: 'agent-bbbb', parentTeamId: 'team-1' };
const standalone = { id: 'agent-solo' };

test('default granularity is team', () => {
  assert.equal(DEFAULT_GRANULARITY, 'team');
});

test('resolveScopeId team granularity: members share team, standalone is self', () => {
  assert.equal(resolveScopeId(memberA, 'team'), 'team-1');
  assert.equal(resolveScopeId(memberB, 'team'), 'team-1');
  assert.equal(resolveScopeId(memberA), 'team-1'); // default
  assert.equal(resolveScopeId(standalone, 'team'), 'agent-solo');
});

test('resolveScopeId agent granularity: every member is its own scope', () => {
  assert.equal(resolveScopeId(memberA, 'agent'), 'agent-aaaa');
  assert.equal(resolveScopeId(memberB, 'agent'), 'agent-bbbb');
  assert.equal(resolveScopeId(standalone, 'agent'), 'agent-solo');
});

test('unknown granularity falls back to team; null agent → null', () => {
  assert.equal(resolveScopeId(memberA, 'galaxy'), 'team-1');
  assert.equal(resolveScopeId(null, 'team'), null);
});

// Helper: fake a broker resource owned by a scope.
function res(scopeId, name) {
  return { Names: [name], Labels: { [OWNER_LABEL_KEY]: scopeId } };
}

test('ownership label helpers stamp and filter by scope', () => {
  assert.equal(ownerLabelArg('team-1'), `${OWNER_LABEL_KEY}=team-1`);
  const all = [res('team-1', 'r1'), res('team-2', 'r2'), { Names: ['unlabelled'] }];
  assert.deepEqual(filterOwned(all, 'team-1').map((r) => r.Names[0]), ['r1']);
  assert.equal(isOwned(res('team-1', 'r'), 'team-1'), true);
  assert.equal(isOwned(res('team-1', 'r'), 'team-2'), false);
  assert.equal(isOwned({}, 'team-1'), false);
  assert.equal(isOwned(res('team-1', 'r'), ''), false);
});

// ── ACCEPTANCE: team-scoped token reaches team resources ─────────────────────
test('team granularity: member A token reaches team-owned resources', () => {
  const scopeId = resolveScopeId(memberA, 'team'); // team-1
  const token = mint(PLUGIN, scopeId, SECRET);
  const derived = verify(token, SECRET);
  const teamResources = [res('team-1', 'shared-1'), res('team-1', 'shared-2')];
  // broker filters by the token's scope
  const visible = filterOwned(teamResources, derived.scopeId);
  assert.equal(visible.length, 2);
});

// ── ACCEPTANCE: agent-scoped token from A rejected against B's resources ─────
test('agent granularity: member A token cannot reach member B resources', () => {
  const scopeA = resolveScopeId(memberA, 'agent'); // agent-aaaa
  const scopeB = resolveScopeId(memberB, 'agent'); // agent-bbbb
  const tokenA = mint(PLUGIN, scopeA, SECRET);
  const derivedA = verify(tokenA, SECRET);

  const bResources = [res(scopeB, 'b-only-1'), res(scopeB, 'b-only-2')];
  // A's token filters B's resources down to nothing — isolation holds.
  assert.deepEqual(filterOwned(bResources, derivedA.scopeId), []);

  const aResources = [res(scopeA, 'a-only')];
  assert.equal(filterOwned(aResources, derivedA.scopeId).length, 1);
});

// ── ACCEPTANCE: tearing down A leaves B untouched ────────────────────────────
test('agent granularity: teardown of A removes only A-owned resources', () => {
  const scopeA = resolveScopeId(memberA, 'agent');
  const scopeB = resolveScopeId(memberB, 'agent');
  let world = [res(scopeA, 'a1'), res(scopeA, 'a2'), res(scopeB, 'b1')];

  // Teardown = remove everything owned by A's scope (broker keys on scopeId).
  const toTearDown = filterOwned(world, scopeA);
  const names = new Set(toTearDown.flatMap((r) => r.Names));
  world = world.filter((r) => !r.Names.some((n) => names.has(n)));

  assert.deepEqual(world.map((r) => r.Names[0]), ['b1']);
  assert.equal(filterOwned(world, scopeB).length, 1); // B untouched
});

// ── the `_internal` sentinel is reserved for the orchestrator's own pushes ──
//
// `pushScopeCredentials` mints its token under scopeId `_internal`, and a broker
// accepts the credential push ONLY from that scope. AGENT_ID_RE allows a leading
// underscore, so an agent (or team of one) literally named `_internal` would
// otherwise be handed the push credential at grant time.

const { INTERNAL_SCOPE_ID, isReservedScopeId } = require('./plugin-scope');

test('the internal scope id is `_internal` and is reserved', () => {
  assert.equal(INTERNAL_SCOPE_ID, '_internal');
  assert.equal(isReservedScopeId('_internal'), true);
  assert.equal(isReservedScopeId('team-1'), false);
  assert.equal(isReservedScopeId(''), false);
  assert.equal(isReservedScopeId(null), false);
});

test('resolveScopeId never yields the reserved id — under either granularity, member or standalone', () => {
  assert.equal(resolveScopeId({ id: '_internal' }, 'team'), null);
  assert.equal(resolveScopeId({ id: '_internal' }, 'agent'), null);
  assert.equal(resolveScopeId({ id: 'agent-x', parentTeamId: '_internal' }, 'team'), null);
  // …but the member's own id is still fine at agent granularity
  assert.equal(resolveScopeId({ id: 'agent-x', parentTeamId: '_internal' }, 'agent'), 'agent-x');
});
