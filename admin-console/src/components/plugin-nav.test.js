import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLUGINS_CHANGED_EVENT,
  notifyPluginsChanged,
  uiPlugins,
  isGlobalUiPlugin,
  pluginTitle,
  pluginsNeedingScopes,
  buildPluginNav,
} from './plugin-nav.js';

const uiPlugin = (id, extra = {}) => ({
  id,
  ok: true,
  manifest: { name: `${id} name`, ui: { routes: ['/'], ...extra } },
});

test('uiPlugins keeps only installed, ok, UI-route plugins', () => {
  const installed = [
    uiPlugin('a'),
    { id: 'no-ok', ok: false, manifest: { ui: { routes: ['/'] } } },
    { id: 'no-ui', ok: true, manifest: { name: 'x' } },
    { id: 'routes-not-array', ok: true, manifest: { ui: { routes: {} } } },
    null,
  ];
  assert.deepEqual(uiPlugins(installed).map((p) => p.id), ['a']);
});

test('uiPlugins tolerates a missing installed list', () => {
  assert.deepEqual(uiPlugins(undefined), []);
  assert.deepEqual(uiPlugins(null), []);
});

test('isGlobalUiPlugin only when ui.global === true', () => {
  assert.equal(isGlobalUiPlugin(uiPlugin('g', { global: true })), true);
  assert.equal(isGlobalUiPlugin(uiPlugin('a')), false);
  assert.equal(isGlobalUiPlugin(uiPlugin('a', { global: 'yes' })), false);
  assert.equal(isGlobalUiPlugin(null), false);
});

test('pluginTitle prefers ui.title, then manifest.name, then id', () => {
  assert.equal(pluginTitle(uiPlugin('a', { title: 'Nice' })), 'Nice');
  assert.equal(pluginTitle(uiPlugin('a')), 'a name');
  assert.equal(pluginTitle({ id: 'bare', manifest: { ui: { routes: ['/'] } } }), 'bare');
});

test('pluginsNeedingScopes lists non-global UI plugins only', () => {
  const installed = [
    uiPlugin('a'),
    uiPlugin('g', { global: true }),
    uiPlugin('b'),
    { id: 'no-ui', ok: true, manifest: {} },
  ];
  assert.deepEqual(pluginsNeedingScopes(installed), ['a', 'b']);
});

test('buildPluginNav includes global plugins with no scope lookup', () => {
  const installed = [uiPlugin('g', { global: true, title: 'Global' })];
  assert.deepEqual(buildPluginNav(installed, {}), [{ id: 'g', title: 'Global' }]);
});

test('buildPluginNav includes a non-global plugin only with visible scopes', () => {
  const installed = [uiPlugin('a', { title: 'A' }), uiPlugin('b', { title: 'B' })];
  const nav = buildPluginNav(installed, { a: ['team-1'], b: [] });
  assert.deepEqual(nav, [{ id: 'a', title: 'A' }]);
});

test('buildPluginNav drops a non-global plugin absent from the scope map', () => {
  const installed = [uiPlugin('a', { title: 'A' })];
  // Probe failed/skipped → no entry in scopesById → no nav entry.
  assert.deepEqual(buildPluginNav(installed, {}), []);
});

test('buildPluginNav yields one entry per id even when global and scoped', () => {
  const installed = [uiPlugin('g', { global: true, title: 'G' })];
  // A global plugin that also happens to have scopes still renders once.
  const nav = buildPluginNav(installed, { g: ['team-1', 'team-2'] });
  assert.deepEqual(nav, [{ id: 'g', title: 'G' }]);
});

test('buildPluginNav defaults scopesById to empty', () => {
  assert.deepEqual(buildPluginNav([uiPlugin('a')]), []);
});

test('notifyPluginsChanged dispatches PLUGINS_CHANGED_EVENT on window', () => {
  const events = [];
  const prev = global.window;
  global.window = { dispatchEvent: (e) => events.push(e.type) };
  try {
    notifyPluginsChanged();
  } finally {
    global.window = prev;
  }
  assert.deepEqual(events, [PLUGINS_CHANGED_EVENT]);
});

test('notifyPluginsChanged is inert without a window', () => {
  const prev = global.window;
  // Simulate a non-browser context; must not throw.
  global.window = undefined;
  try {
    assert.doesNotThrow(() => notifyPluginsChanged());
  } finally {
    global.window = prev;
  }
});
