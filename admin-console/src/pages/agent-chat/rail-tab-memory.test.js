import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTabMap, tabForAgent, withAgentTab } from './rail-tab-memory.js';

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
