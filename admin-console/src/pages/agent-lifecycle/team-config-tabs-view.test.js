import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TEAM_CONFIG_TABS, DEFAULT_TEAM_CONFIG_TAB, ENV_TAB_IDS, resolveTeamConfigTab,
} from './team-config-tabs-view.js';

test('the nine tabs are exactly the ones AC2 names plus Sharing, in reading order (#2236)', () => {
  assert.deepEqual(TEAM_CONFIG_TABS.map(t => t.id), [
    'general', 'repositories', 'provider', 'toolchain', 'mcp', 'context', 'skills', 'plugins',
    'sharing',
  ]);
  assert.deepEqual(TEAM_CONFIG_TABS.map(t => t.label), [
    'General', 'Repositories', 'Model provider', 'Toolchain', 'MCP servers', 'Additional context',
    'Skills', 'Plugins', 'Sharing',
  ]);
});

test('the five environment tabs are re-hosted verbatim, not re-invented', () => {
  // team-config-tabs-view.js imports TEAM_ENV_TABS rather than declaring its
  // own copy of the ids/labels — this pins that the set in the middle of
  // TEAM_CONFIG_TABS is exactly ENV_TAB_IDS, in the same order. The trailing
  // three (skills, plugins, sharing) are agent-construct/membership tabs.
  const envIds = TEAM_CONFIG_TABS.slice(1, -3).map(t => t.id);
  assert.deepEqual(envIds, ['repositories', 'provider', 'toolchain', 'mcp', 'context']);
  assert.deepEqual([...ENV_TAB_IDS].sort(), [...envIds].sort());
});

test('ENV_TAB_IDS excludes General, Skills, Plugins and Sharing', () => {
  assert.equal(ENV_TAB_IDS.has('general'), false);
  assert.equal(ENV_TAB_IDS.has('skills'), false);
  assert.equal(ENV_TAB_IDS.has('plugins'), false);
  assert.equal(ENV_TAB_IDS.has('sharing'), false);
});

test('DEFAULT_TEAM_CONFIG_TAB is General', () => {
  assert.equal(DEFAULT_TEAM_CONFIG_TAB, 'general');
});

test('resolveTeamConfigTab: a known id round-trips unchanged', () => {
  for (const { id } of TEAM_CONFIG_TABS) {
    assert.equal(resolveTeamConfigTab(id), id);
  }
});

test('resolveTeamConfigTab: an unknown, empty or missing id falls back to General (AC7)', () => {
  assert.equal(resolveTeamConfigTab('nope'), DEFAULT_TEAM_CONFIG_TAB);
  assert.equal(resolveTeamConfigTab(''), DEFAULT_TEAM_CONFIG_TAB);
  assert.equal(resolveTeamConfigTab(undefined), DEFAULT_TEAM_CONFIG_TAB);
  assert.equal(resolveTeamConfigTab(null), DEFAULT_TEAM_CONFIG_TAB);
});

test('resolveTeamConfigTab: a non-string value is coerced, not thrown on', () => {
  assert.equal(resolveTeamConfigTab(123), DEFAULT_TEAM_CONFIG_TAB);
  assert.equal(resolveTeamConfigTab({}), DEFAULT_TEAM_CONFIG_TAB);
});
