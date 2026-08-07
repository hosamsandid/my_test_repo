import test from 'node:test';
import assert from 'node:assert/strict';

import {
  grantableGranularities,
  granularitySelectorState,
  quotaCeiling,
  platformMismatch,
  pluginGrantRow,
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
