import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTabMap, tabForAgent, withAgentTab,
  DEFAULT_RAIL_TAB, displayTab, tabRequestAppliesToOwnAgent,
} from './rail-tab-memory.js';

const TAB_KEYS = ['sessions', 'workspace', 'triggers', 'outcomes', 'knowledge', 'settings'];

test('parseTabMap: null/empty/garbage all become an empty map', () => {
  assert.deepEqual(parseTabMap(null), {});
  assert.deepEqual(parseTabMap(''), {});
  assert.deepEqual(parseTabMap('not json'), {});
  assert.deepEqual(parseTabMap('[]'), {}); // an array is not a map
  assert.deepEqual(parseTabMap('"a string"'), {});
  assert.deepEqual(parseTabMap('null'), {});
});

test('parseTabMap: a real object round-trips', () => {
  assert.deepEqual(parseTabMap('{"a":"sessions","b":"settings"}'), { a: 'sessions', b: 'settings' });
});

test('tabForAgent: no agent id, no map, or an unknown key all fall back to null', () => {
  assert.equal(tabForAgent({ a: 'settings' }, null, TAB_KEYS), null);
  assert.equal(tabForAgent(null, 'a', TAB_KEYS), null);
  assert.equal(tabForAgent({}, 'a', TAB_KEYS), null);
  // A retired tab key (e.g. the old 'log') is not in TAB_KEYS any more.
  assert.equal(tabForAgent({ a: 'log' }, 'a', TAB_KEYS), null);
});

test('tabForAgent: returns the remembered tab for that agent only', () => {
  const map = { a: 'workspace', b: 'settings' };
  assert.equal(tabForAgent(map, 'a', TAB_KEYS), 'workspace');
  assert.equal(tabForAgent(map, 'b', TAB_KEYS), 'settings');
  // A third, never-visited agent has no entry of its own.
  assert.equal(tabForAgent(map, 'c', TAB_KEYS), null);
});

test('withAgentTab: sets one agent without disturbing the others', () => {
  const map = { a: 'workspace' };
  const next = withAgentTab(map, 'b', 'settings');
  assert.deepEqual(next, { a: 'workspace', b: 'settings' });
  // Original untouched (replaced, not mutated).
  assert.deepEqual(map, { a: 'workspace' });
});

test('withAgentTab: overwrites an existing entry for the same agent', () => {
  assert.deepEqual(withAgentTab({ a: 'workspace' }, 'a', 'settings'), { a: 'settings' });
});

test('withAgentTab: a missing agent id is a no-op (returns the map as-is)', () => {
  const map = { a: 'workspace' };
  assert.deepEqual(withAgentTab(map, null, 'settings'), map);
  assert.deepEqual(withAgentTab(null, null, 'settings'), {});
});

/* ── #2426: default landing tab is Workspace, not Sessions ─────────── */

test('DEFAULT_RAIL_TAB is Workspace and is a real tab key', () => {
  assert.equal(DEFAULT_RAIL_TAB, 'workspace');
  assert.ok(TAB_KEYS.includes(DEFAULT_RAIL_TAB));
});

test('an agent with no history falls back to the Workspace default', () => {
  // The rail resolves the initial/switch tab as `tabForAgent(...) || DEFAULT_RAIL_TAB`.
  assert.equal(tabForAgent({}, 'never-opened', TAB_KEYS) || DEFAULT_RAIL_TAB, 'workspace');
  // A retired stored value ('log') is treated as no history → Workspace, not Sessions.
  assert.equal(tabForAgent({ a: 'log' }, 'a', TAB_KEYS) || DEFAULT_RAIL_TAB, 'workspace');
  // A real remembered tab still wins over the default.
  assert.equal(tabForAgent({ a: 'triggers' }, 'a', TAB_KEYS) || DEFAULT_RAIL_TAB, 'triggers');
});

/* ── #2426: a Settings override is display-only, never the open agent's ── */

test('displayTab: with no override, the open agent\'s own tab is shown', () => {
  assert.equal(displayTab('workspace', false), 'workspace');
  assert.equal(displayTab('triggers', false), 'triggers');
  assert.equal(displayTab('settings', false), 'settings'); // own, deliberate Settings (AC4)
});

test('displayTab: an override forces Settings for display without changing the own tab', () => {
  // The open agent stays on 'workspace'; only what is *displayed* becomes Settings.
  assert.equal(displayTab('workspace', true), 'settings');
  assert.equal(displayTab('knowledge', true), 'settings');
});

test('tabRequestAppliesToOwnAgent: only a Settings request under an active override is withheld', () => {
  // The cross-contamination case (#2426 AC3): a Settings request for another
  // agent must not become the open agent's own tab.
  assert.equal(tabRequestAppliesToOwnAgent('settings', true), false);
  // Own Settings (no override) still applies and is remembered (AC4).
  assert.equal(tabRequestAppliesToOwnAgent('settings', false), true);
  // Every other request applies regardless of an override being present.
  assert.equal(tabRequestAppliesToOwnAgent('knowledge', true), true);
  assert.equal(tabRequestAppliesToOwnAgent('sessions', true), true);
  assert.equal(tabRequestAppliesToOwnAgent('workspace', false), true);
});
