// Run: node --test admin-console/src/pages/plugin-ui-view.test.js
//
// #2650: the plugin UI host page (/plugins/:id/view) showed the proxy's raw 404
// JSON for an unknown plugin and named the page by the raw plugin id. The state
// + copy live in plugin-ui-view.js; the JSX wiring is covered by the source
// guard at the bottom (the #651 convention — JSX itself stays uncovered).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_MISSING_COPY, PLUGINS_ROUTE, HOME_ROUTE, resolvePluginUi, pluginTitlesFor,
} from './plugin-ui-view.js';

const uiPlugin = (id, extra = {}) => ({
  id,
  ok: true,
  manifest: { name: `${id} name`, ui: { routes: ['/'], ...extra } },
});

test('an installed UI plugin is ready and named by its display name', () => {
  const body = { installed: [uiPlugin('patterns-catalog', { title: 'Patterns Catalog' })] };
  assert.deepEqual(resolvePluginUi(body, 'patterns-catalog'), { status: 'ready', title: 'Patterns Catalog' });
  // no ui.title → manifest.name, same rule as the sidebar entry
  assert.equal(resolvePluginUi({ installed: [uiPlugin('np')] }, 'np').title, 'np name');
});

test('an unknown plugin id is missing, not an iframe onto the raw 404', () => {
  const v = resolvePluginUi({ installed: [uiPlugin('np')], canManage: true }, 'nope-xyz');
  assert.equal(v.status, 'missing');
  assert.equal(v.title, 'nope-xyz');
});

test('plugins the UI proxy would 404 are missing too (mirrors api.js pluginUiProxy)', () => {
  const cases = {
    'no ui': { id: 'a', ok: true, manifest: { name: 'A' } },
    'no routes': { id: 'a', ok: true, manifest: { name: 'A', ui: { title: 'A' } } },
    'broken manifest': { id: 'a', ok: false, manifest: { name: 'A', ui: { routes: ['/'] } } },
  };
  for (const [label, entry] of Object.entries(cases)) {
    assert.equal(resolvePluginUi({ installed: [entry] }, 'a').status, 'missing', label);
  }
  assert.equal(resolvePluginUi({}, 'a').status, 'missing', 'no installed list');
});

test('the way back is the Plugins registry for admins, Agent Chat otherwise', () => {
  assert.deepEqual(
    resolvePluginUi({ installed: [], canManage: true }, 'x').back,
    { to: PLUGINS_ROUTE, label: PLUGIN_MISSING_COPY.toPlugins },
  );
  assert.deepEqual(
    resolvePluginUi({ installed: [], canManage: false }, 'x').back,
    { to: HOME_ROUTE, label: PLUGIN_MISSING_COPY.toHome },
  );
  assert.equal(PLUGINS_ROUTE, '/plugins');
});

test('a failed lookup is unknown — the page keeps its best-effort iframe', () => {
  assert.deepEqual(resolvePluginUi(null, 'np'), { status: 'unknown', title: 'np' });
  assert.deepEqual(resolvePluginUi(undefined, 'np'), { status: 'unknown', title: 'np' });
});

test('pluginTitlesFor builds the id → name map for the title helpers', () => {
  assert.deepEqual(pluginTitlesFor('np', 'Network Plan'), { np: 'Network Plan' });
  assert.deepEqual(pluginTitlesFor('np', ''), {});
  assert.deepEqual(pluginTitlesFor('', 'X'), {});
});

// --- source guard: PluginUiPage.jsx wiring -------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const jsx = fs.readFileSync(path.join(here, 'PluginUiPage.jsx'), 'utf8');

test('PluginUiPage resolves its state through resolvePluginUi', () => {
  assert.match(jsx, /resolvePluginUi\(body, id\)/);
});

test('PluginUiPage renders the missing state with copy, id and way back — no iframe', () => {
  const missing = jsx.match(/if \(view\.status === 'missing'\) \{([\s\S]*?)\n  \}\n/);
  assert.ok(missing, 'missing-state branch present');
  const block = missing[1];
  assert.match(block, /\{PLUGIN_MISSING_COPY\.title\}/);
  assert.match(block, /\{PLUGIN_MISSING_COPY\.body\}/);
  assert.match(block, /<pre[^>]*>\{id\}<\/pre>/);
  assert.match(block, /<Link to=\{view\.back\.to\}[^>]*>\{view\.back\.label\}<\/Link>/);
  assert.doesNotMatch(block, /<iframe/);
});

test('PluginUiPage mounts no iframe while the lookup is pending', () => {
  assert.match(jsx, /if \(view\.status === 'loading'\) return <div style=\{pageStyle\} \/>;/);
  // a stale resolution for another id reads as loading
  assert.match(jsx, /resolved && resolved\.id === id \? resolved : \{ status: 'loading'/);
});

test('PluginUiPage sets the tab title from the display name', () => {
  assert.match(jsx, /documentTitleForPath\(pathname, pluginTitlesFor\(id, view\.title\)\)/);
});
