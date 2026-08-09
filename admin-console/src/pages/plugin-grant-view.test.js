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
