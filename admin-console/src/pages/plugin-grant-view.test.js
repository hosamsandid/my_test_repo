import test from 'node:test';
import assert from 'node:assert/strict';

import {
  grantableGranularities,
  granularitySelectorState,
  quotaCeiling,
  platformMismatch,
  pluginGrantRow,
  normalizeGrantEntries,
  effectiveGrantFor,
  hasExpandableDetail,
  uninstalledGrantRows,
  UNINSTALLED_GRANT_STATUS,
} from './plugin-grant-view.js';

const TEAM_ONLY = { id: 'p', name: 'P', scopes: ['team'], platforms: ['any'] };
const BOTH = { id: 'q', name: 'Q', description: 'desc', scopes: ['team', 'agent'], platforms: ['podman'] };

test('grantableGranularities defaults to [team] when unset', () => {
  assert.deepEqual(grantableGranularities({}), ['team']);
  assert.deepEqual(grantableGranularities(BOTH), ['team', 'agent']);
});

test('a team-only manifest disables the selector with an honest hint', () => {
  const s = granularitySelectorState(TEAM_ONLY, 'team');
  assert.equal(s.disabled, true);
  assert.match(s.hint, /shared per team/);
  assert.deepEqual(s.options, ['team']);
});

test('a both-granularity manifest enables the selector', () => {
  const s = granularitySelectorState(BOTH, 'agent');
  assert.equal(s.disabled, false);
  assert.equal(s.value, 'agent');
  assert.deepEqual(s.options, ['team', 'agent']);
});

test('an out-of-range current granularity coerces to team', () => {
  assert.equal(granularitySelectorState(BOTH, 'bogus').value, 'team');
});

test('quotaCeiling states the per-scope multiplication before the toggle', () => {
  assert.deepEqual(quotaCeiling('team', 8), { granularity: 'team', scopes: 1, label: '1 scope (one shared quota, audit and resource pool)' });
  const agent = quotaCeiling('agent', 8);
  assert.equal(agent.scopes, 8);
  assert.match(agent.label, /8 scopes/);
  // Defensive: a bad member count floors to a single scope.
  assert.equal(quotaCeiling('agent', 0).scopes, 1);
  assert.equal(quotaCeiling('agent', undefined).scopes, 1);
});

test('platformMismatch: "any" always matches; else the stack runtime must be listed', () => {
  assert.deepEqual(platformMismatch(TEAM_ONLY, 'podman'), { ok: true, message: null });
  assert.deepEqual(platformMismatch(BOTH, 'podman'), { ok: true, message: null });
  const bad = platformMismatch(BOTH, 'kubernetes');
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Requires podman; this stack runs kubernetes/);
});

test('pluginGrantRow folds granted state, selector, quota and platform into one view', () => {
  const row = pluginGrantRow(BOTH, { id: 'q', scopeGranularity: 'agent' }, { memberCount: 5, stackRuntime: 'podman' });
  assert.equal(row.granted, true);
  assert.equal(row.granularity, 'agent');
  assert.equal(row.selector.disabled, false);
  assert.equal(row.quota.scopes, 5);
  assert.equal(row.platform.ok, true);

  const ungranted = pluginGrantRow(TEAM_ONLY, null, { memberCount: 3 });
  assert.equal(ungranted.granted, false);
  assert.equal(ungranted.granularity, 'team');
  assert.equal(ungranted.selector.disabled, true);
  assert.equal(ungranted.quota.scopes, 1);
});

// ── grant normalisation + inheritance (#1547) ────────────────────────────────

test('normalizeGrantEntries accepts the string shorthand as team granularity', () => {
  assert.deepEqual(normalizeGrantEntries(['podman-sandbox']), [
    { id: 'podman-sandbox', scopeGranularity: 'team' },
  ]);
});

test('normalizeGrantEntries keeps an explicit granularity and drops junk', () => {
  assert.deepEqual(
    normalizeGrantEntries([
      { id: 'a', scopeGranularity: 'agent' },
      { id: 'b', scopeGranularity: 'nonsense' },
      { id: '  ' },
      null,
      42,
    ]),
    [
      { id: 'a', scopeGranularity: 'agent' },
      { id: 'b', scopeGranularity: 'team' },
    ],
  );
});

test('normalizeGrantEntries de-duplicates on id, first entry wins', () => {
  assert.deepEqual(
    normalizeGrantEntries([{ id: 'a', scopeGranularity: 'agent' }, { id: 'a' }]),
    [{ id: 'a', scopeGranularity: 'agent' }],
  );
});

test('normalizeGrantEntries tolerates a non-array', () => {
  assert.deepEqual(normalizeGrantEntries(null), []);
  assert.deepEqual(normalizeGrantEntries(undefined), []);
  assert.deepEqual(normalizeGrantEntries('podman-sandbox'), []);
});

test('a member with no override inherits the team grant', () => {
  const member = { role: 'team-member' };
  const team = { plugins: [{ id: 'podman-sandbox', scopeGranularity: 'agent' }] };
  assert.deepEqual(effectiveGrantFor(member, team), [
    { id: 'podman-sandbox', scopeGranularity: 'agent' },
  ]);
});

test('a member override REPLACES the team grant, it does not merge', () => {
  const member = { role: 'team-member', pluginsOverride: [{ id: 'test-mgmt' }] };
  const team = { plugins: [{ id: 'podman-sandbox' }] };
  assert.deepEqual(effectiveGrantFor(member, team), [
    { id: 'test-mgmt', scopeGranularity: 'team' },
  ]);
});

test('an EMPTY member override is still an override — it grants nothing', () => {
  const member = { role: 'team-member', pluginsOverride: [] };
  const team = { plugins: [{ id: 'podman-sandbox' }] };
  assert.deepEqual(effectiveGrantFor(member, team), []);
});

test('a standalone agent carries its own grant, ignoring any team', () => {
  const agent = { role: 'agent', plugins: [{ id: 'x' }] };
  assert.deepEqual(effectiveGrantFor(agent, { plugins: [{ id: 'y' }] }), [
    { id: 'x', scopeGranularity: 'team' },
  ]);
});

// ── expand affordance (#2269 AC3) ────────────────────────────────────────────

test('hasExpandableDetail: nothing to say when ungranted, matched platform, no description', () => {
  const row = pluginGrantRow(TEAM_ONLY, null, { stackRuntime: 'podman' });
  assert.equal(hasExpandableDetail(row), false);
});

test('hasExpandableDetail: a description alone is expandable', () => {
  const row = pluginGrantRow(BOTH, null, { stackRuntime: 'podman' });
  assert.equal(hasExpandableDetail(row), true);
});

test('hasExpandableDetail: a platform mismatch alone is expandable', () => {
  const podmanOnlyNoDesc = { id: 'r', name: 'R', scopes: ['team'], platforms: ['podman'] };
  const row = pluginGrantRow(podmanOnlyNoDesc, null, { stackRuntime: 'kubernetes' });
  assert.equal(row.description, '');
  assert.equal(hasExpandableDetail(row), true);
});

test('hasExpandableDetail: a granted row is expandable (Scope/quota controls)', () => {
  const row = pluginGrantRow(TEAM_ONLY, { id: 'p', scopeGranularity: 'team' }, { stackRuntime: 'podman' });
  assert.equal(hasExpandableDetail(row), true);
});

test('hasExpandableDetail tolerates junk', () => {
  assert.equal(hasExpandableDetail(null), false);
  assert.equal(hasExpandableDetail(undefined), false);
});

// ---- uninstalledGrantRows (#2651) -------------------------------------------

test('a grant whose plugin is not installed becomes a revocable row', () => {
  const installed = [{ id: 'p', ok: true, manifest: TEAM_ONLY }];
  const rows = uninstalledGrantRows(['p', { id: 'patterns-catalog', scopeGranularity: 'agent' }], installed);
  assert.deepEqual(rows, [{
    id: 'patterns-catalog',
    granularity: 'agent',
    status: UNINSTALLED_GRANT_STATUS,
    revokeLabel: 'Revoke the patterns-catalog grant',
  }]);
});

test('an installed entry with an invalid manifest counts as not installed (the server refuses it too)', () => {
  const rows = uninstalledGrantRows(['p'], [{ id: 'p', ok: false, manifest: null }]);
  assert.deepEqual(rows.map((r) => r.id), ['p']);
});

test('no grant, or every grant installed, yields no rows', () => {
  const installed = [{ id: 'p', ok: true, manifest: TEAM_ONLY }];
  assert.deepEqual(uninstalledGrantRows([], installed), []);
  assert.deepEqual(uninstalledGrantRows(['p'], installed), []);
  assert.deepEqual(uninstalledGrantRows(null, null), []);
});

test('an unknown installed list (still loading, or the fetch failed) yields no rows', () => {
  // Otherwise every working grant would be offered for Revoke as "not installed".
  assert.deepEqual(uninstalledGrantRows(['p', 'q'], null), []);
  assert.deepEqual(uninstalledGrantRows(['p'], undefined), []);
  assert.deepEqual(uninstalledGrantRows(['p'], {}), []);
});

test('a known but empty installed list still reports every grant', () => {
  assert.deepEqual(uninstalledGrantRows(['p'], []).map((r) => r.id), ['p']);
});
