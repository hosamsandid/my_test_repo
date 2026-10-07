'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_GRANULARITY,
  normalizeGrant,
  normalizeGrantList,
  effectivePlugins,
  hasPluginGrant,
  pluginGrantFor,
  planAgentPluginGrantEdit,
  planPluginSync,
  uninstalledRevokeGrant,
} = require('./plugin-grants');

// ---- normalizeGrant ---------------------------------------------------------

test('string shorthand normalises to a team-granularity grant', () => {
  assert.deepEqual(normalizeGrant('dummy-echo'), { id: 'dummy-echo', scopeGranularity: 'team' });
  assert.deepEqual(normalizeGrant('  x '), { id: 'x', scopeGranularity: 'team' });
});

test('object entry keeps a valid granularity, coerces an invalid one to the default', () => {
  assert.deepEqual(normalizeGrant({ id: 'p', scopeGranularity: 'agent' }), { id: 'p', scopeGranularity: 'agent' });
  assert.deepEqual(normalizeGrant({ id: 'p', scopeGranularity: 'nonsense' }), { id: 'p', scopeGranularity: DEFAULT_GRANULARITY });
  assert.deepEqual(normalizeGrant({ id: 'p' }), { id: 'p', scopeGranularity: 'team' });
});

test('unusable entries are dropped (fail-soft)', () => {
  assert.equal(normalizeGrant(''), null);
  assert.equal(normalizeGrant({}), null);
  assert.equal(normalizeGrant({ id: 42 }), null);
  assert.equal(normalizeGrant(null), null);
});

test('normalizeGrantList de-dupes on id with last-wins (a flip appended later wins)', () => {
  const list = normalizeGrantList(['a', { id: 'a', scopeGranularity: 'agent' }, 'b']);
  assert.deepEqual(list, [
    { id: 'a', scopeGranularity: 'agent' },
    { id: 'b', scopeGranularity: 'team' },
  ]);
});

// ---- effectivePlugins (mirrors effectiveSkills) -----------------------------

test('standalone / team agents use their own plugins[]', () => {
  assert.deepEqual(effectivePlugins({ role: 'agent', plugins: ['a'] }), [{ id: 'a', scopeGranularity: 'team' }]);
  assert.deepEqual(effectivePlugins({ role: 'team', plugins: [{ id: 'x', scopeGranularity: 'agent' }] }), [{ id: 'x', scopeGranularity: 'agent' }]);
});

test('missing plugins field resolves to empty — env never contributes', () => {
  assert.deepEqual(effectivePlugins({ role: 'agent' }), []);
  assert.deepEqual(effectivePlugins(null), []);
});

test('team-member inherits the parent team grant unless it has an override', () => {
  const team = { role: 'team', id: 't1', plugins: [{ id: 'p', scopeGranularity: 'agent' }] };
  const loadCfg = (id) => (id === 't1' ? team : null);
  const member = { role: 'team-member', id: 't1-dev', parentTeamId: 't1' };
  assert.deepEqual(effectivePlugins(member, loadCfg), [{ id: 'p', scopeGranularity: 'agent' }]);

  const overridden = { role: 'team-member', id: 't1-dev', parentTeamId: 't1', pluginsOverride: ['q'] };
  assert.deepEqual(effectivePlugins(overridden, loadCfg), [{ id: 'q', scopeGranularity: 'team' }]);

  const clearedOverride = { role: 'team-member', parentTeamId: 't1', pluginsOverride: [] };
  assert.deepEqual(effectivePlugins(clearedOverride, loadCfg), []);
});

// Removal guard (#1962): `bp-instance` used to inherit the parent
// orchestrator's grant. Both roles went with the BriefingPack model, so
// `team-member`/`parentTeamId` is the only inheritance path left.
test('a leftover bp-instance no longer inherits through parentOrchestratorId', () => {
  const orch = { role: 'orchestrator', id: 'o1', plugins: ['p'] };
  const loadCfg = (id) => (id === 'o1' ? orch : null);
  assert.deepEqual(
    effectivePlugins({ role: 'bp-instance', parentOrchestratorId: 'o1' }, loadCfg),
    [],
  );
});

// ---- hasPluginGrant / pluginGrantFor ----------------------------------------

test('hasPluginGrant reflects a non-empty resolved grant', () => {
  assert.equal(hasPluginGrant([{ id: 'p', scopeGranularity: 'team' }]), true);
  assert.equal(hasPluginGrant([]), false);
  assert.equal(hasPluginGrant(null), false);
});

test('pluginGrantFor returns the entry or null', () => {
  assert.deepEqual(pluginGrantFor(['p'], 'p'), { id: 'p', scopeGranularity: 'team' });
  assert.equal(pluginGrantFor(['p'], 'q'), null);
});

// ---- planAgentPluginGrantEdit -----------------------------------------------

test('standalone activate appends; deactivate removes; idempotent', () => {
  const cfg = { role: 'agent', plugins: ['a'] };
  assert.deepEqual(planAgentPluginGrantEdit(cfg, 'b', true), {
    field: 'plugins',
    list: [{ id: 'a', scopeGranularity: 'team' }, { id: 'b', scopeGranularity: 'team' }],
  });
  // Re-activating the same id at the same granularity is a no-op set upsert.
  assert.deepEqual(planAgentPluginGrantEdit(cfg, 'a', true).list, [{ id: 'a', scopeGranularity: 'team' }]);
  assert.deepEqual(planAgentPluginGrantEdit(cfg, 'a', false).list, []);
});

test('granularity flip on a live grant replaces the entry in place (re-mint semantics)', () => {
  const cfg = { role: 'agent', plugins: [{ id: 'p', scopeGranularity: 'team' }, { id: 'other', scopeGranularity: 'team' }] };
  const out = planAgentPluginGrantEdit(cfg, { id: 'p', scopeGranularity: 'agent' }, true);
  assert.equal(out.field, 'plugins');
  // 'p' flipped to agent granularity, position moved to the end, 'other' untouched.
  assert.deepEqual(out.list, [
    { id: 'other', scopeGranularity: 'team' },
    { id: 'p', scopeGranularity: 'agent' },
  ]);
});

test('team-member writes pluginsOverride, materialising the inherited set first', () => {
  const team = { role: 'team', id: 't', plugins: ['inherited'] };
  const loadCfg = (id) => (id === 't' ? team : null);
  const member = { role: 'team-member', parentTeamId: 't' }; // no override yet → inherits
  const out = planAgentPluginGrantEdit(member, 'added', true, loadCfg);
  assert.equal(out.field, 'pluginsOverride');
  assert.deepEqual(out.list, [
    { id: 'inherited', scopeGranularity: 'team' },
    { id: 'added', scopeGranularity: 'team' },
  ]);
});

// ---- planPluginSync (mirrors planSkillSync) ---------------------------------

test('planPluginSync: unmaterialised member is a stub; plain member syncs', () => {
  const plan = planPluginSync({
    members: [
      { id: 'm-stub' },
      { id: 'm-live', token: 't' },
    ],
    grant: { id: 'p', scopeGranularity: 'agent' },
  });
  assert.deepEqual(plan, [
    { agentId: 'm-stub', action: 'stub' },
    { agentId: 'm-live', action: 'sync' },
  ]);
});

test('planPluginSync: override member skips unless carrying the plugin or opted in', () => {
  const members = [
    { id: 'm-has', token: 't', pluginsOverride: [{ id: 'p', scopeGranularity: 'team' }] },
    { id: 'm-skip', token: 't', pluginsOverride: ['other'] },
    { id: 'm-optin', token: 't', pluginsOverride: ['other'] },
  ];
  const plan = planPluginSync({ members, grant: 'p', includeMembers: ['m-optin'] });
  assert.deepEqual(plan, [
    { agentId: 'm-has', action: 'sync' },
    { agentId: 'm-skip', action: 'skip-override' },
    { agentId: 'm-optin', action: 'sync-override' },
  ]);
});

// ---- uninstalledRevokeGrant (#2651) -----------------------------------------

test('a deactivate of a still-held grant resolves without a manifest, keeping its granularity', () => {
  const held = [{ id: 'patterns-catalog', scopeGranularity: 'agent' }, 'dummy-echo'];
  assert.deepEqual(uninstalledRevokeGrant(false, held, 'patterns-catalog'), { id: 'patterns-catalog', scopeGranularity: 'agent' });
  assert.deepEqual(uninstalledRevokeGrant(false, held, ' dummy-echo '), { id: 'dummy-echo', scopeGranularity: 'team' });
});

test('an id the construct does not carry is not revocable (the caller keeps the not-installed error)', () => {
  assert.equal(uninstalledRevokeGrant(false, ['dummy-echo'], 'nope'), null);
  assert.equal(uninstalledRevokeGrant(false, [], 'nope'), null);
  assert.equal(uninstalledRevokeGrant(false, ['dummy-echo'], ''), null);
  assert.equal(uninstalledRevokeGrant(false, ['dummy-echo'], null), null);
});

test('an ACTIVATE of an uninstalled plugin never qualifies, even when the grant is held', () => {
  assert.equal(uninstalledRevokeGrant(true, ['dummy-echo'], 'dummy-echo'), null);
});
