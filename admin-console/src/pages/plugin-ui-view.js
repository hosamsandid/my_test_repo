// Pure state + copy for the plugin UI host page (/plugins/:id/view, #2650),
// kept React-free so it is unit-tested under `node --test` (the #651
// convention); PluginUiPage.jsx only renders it.
//
// Before #2650 the page always mounted the iframe, so an unknown or uninstalled
// plugin id showed the proxy's raw 404 body (`{"error":"plugin 'x' has no UI"}`)
// inside the frame. The page now resolves the plugin from GET /api/plugins first
// and renders a friendly "not available" state when the proxy would 404.

import { uiPlugins, pluginTitle } from '../components/plugin-nav.js';

export const PLUGINS_ROUTE = '/plugins';
export const HOME_ROUTE = '/chats';

export const PLUGIN_MISSING_COPY = {
  title: 'Plugin not available',
  body: 'This plugin is not installed, or it has no user interface to show.',
  toPlugins: 'Go to Plugins',
  toHome: 'Go to Agent Chat',
};

// Resolve the page state from the /api/plugins body.
// - body null/undefined (fetch failed, not ok): 'unknown' — keep the old
//   best-effort behaviour and show the iframe with the raw id as title.
// - plugin installed with a UI (same rule as the UI proxy in api.js and the
//   sidebar entries): 'ready' with its display name.
// - anything else: 'missing' — the proxy would answer 404.
// `canManage` picks the way back: the Plugins registry is admin-only, so other
// users are sent to the landing page instead.
export function resolvePluginUi(body, id) {
  if (!body || typeof body !== 'object') return { status: 'unknown', title: id };
  const plugin = uiPlugins(body.installed).find((p) => p.id === id);
  if (plugin) return { status: 'ready', title: pluginTitle(plugin) };
  const canManage = !!body.canManage;
  return {
    status: 'missing',
    title: id,
    back: canManage
      ? { to: PLUGINS_ROUTE, label: PLUGIN_MISSING_COPY.toPlugins }
      : { to: HOME_ROUTE, label: PLUGIN_MISSING_COPY.toHome },
  };
}

// The `{ id: displayName }` map for the tab title / breadcrumb helpers.
export function pluginTitlesFor(id, title) {
  return id && title ? { [id]: title } : {};
}
