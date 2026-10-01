// Pure derivation of the dynamic UI-plugin nav entries (#1595) from the
// /api/plugins payload + per-plugin scope lookups, plus the cross-component
// invalidation signal (#1679). Kept out of Shell.jsx so the discovery rules can
// be unit-tested (admin-console-src CI job, #651 convention); Shell owns only
// the fetching/caching around these helpers.
//
// Before #1679 Shell re-ran the whole discovery — one GET /api/plugins plus an
// N+1 fan-out of GET /api/plugins/:id/scopes — on every route change (the effect
// was keyed on `location.pathname`). Discovery is session-scoped: it only needs
// to run once and then whenever the installed-plugin set or an agent's plugin
// grant actually changes. Callers that mutate either (Plugins install/uninstall,
// Agents plugin grant) fire PLUGINS_CHANGED_EVENT to ask Shell to re-discover.

// Mirrors the UNAUTHORIZED_EVENT window-event convention in AuthContext: a bare
// window Event any component can dispatch and Shell listens for.
export const PLUGINS_CHANGED_EVENT = 'aee-plugins-changed';

// Fire-and-forget helper so call sites don't repeat the `new Event(...)` dance.
// Guarded so importing this module in a non-browser (node:test) context is inert.
export function notifyPluginsChanged() {
  if (typeof window !== 'undefined' && window.dispatchEvent) {
    window.dispatchEvent(new Event(PLUGINS_CHANGED_EVENT));
  }
}

// A plugin contributes a nav entry only when it is installed, healthy (`ok`),
// and declares UI routes.
export function uiPlugins(installed) {
  return (installed || []).filter(
    (p) => p && p.ok && p.manifest && p.manifest.ui && Array.isArray(p.manifest.ui.routes),
  );
}

// `ui.global: true` (#1599) shows the entry to every authenticated user with no
// grant, so no scope lookup is needed for it.
export function isGlobalUiPlugin(p) {
  return !!(p && p.manifest && p.manifest.ui && p.manifest.ui.global === true);
}

export function pluginTitle(p) {
  return (p.manifest.ui && p.manifest.ui.title) || p.manifest.name || p.id;
}

// The plugin ids that still need a GET /scopes probe (installed UI plugins that
// are not globally visible). The caller fetches these once, caches them, and
// passes the result to buildPluginNav — no per-navigation refetch.
export function pluginsNeedingScopes(installed) {
  return uiPlugins(installed)
    .filter((p) => !isGlobalUiPlugin(p))
    .map((p) => p.id);
}

// Build the `{ id, title }[]` nav entries.
// - installed: raw /api/plugins `installed` array.
// - scopesById: { [pluginId]: scopes[] } for the non-global plugins that were
//   probed. A non-global plugin absent from the map (probe failed/skipped)
//   contributes no entry; a global plugin needs no entry in the map.
// One entry per plugin id, so a globally-visible + team-granted plugin never
// renders twice (AC5, #1599).
export function buildPluginNav(installed, scopesById = {}) {
  const out = [];
  for (const p of uiPlugins(installed)) {
    const title = pluginTitle(p);
    if (isGlobalUiPlugin(p)) {
      out.push({ id: p.id, title });
      continue;
    }
    const scopes = scopesById[p.id];
    if (Array.isArray(scopes) && scopes.length) out.push({ id: p.id, title });
  }
  return out;
}

// `{ [pluginId]: displayName }` for every installed UI plugin (#2650), so the
// breadcrumb names a plugin viewer the way the sidebar entry does instead of by
// its raw id. Not scope-filtered: a name is not access, the proxy still decides.
export function pluginTitleMap(installed) {
  const out = {};
  for (const p of uiPlugins(installed)) out[p.id] = pluginTitle(p);
  return out;
}
