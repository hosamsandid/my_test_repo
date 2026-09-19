// Pure decisions for the `plugin-event` trigger's plugin picker.
//
// `pluginId` on a plugin-event trigger is a foreign key: the orchestrator
// matches it exactly (`plugin-event.js` matchesPluginEventTrigger) and wakes
// only agents the plugin is *granted* to (resolvePluginEventTargets). A typo
// or an ungranted plugin is therefore a listener that silently never fires —
// which is why this is a select over the installed registry, granted-first,
// and not a free-text field. No React, no fetch: the JSX feeds it the
// `installed` list from GET /api/plugins and the agent's effective grant.

export const PLACEHOLDER_LABEL = '— Select a plugin —';
export const NOT_GRANTED_SUFFIX = ' — not granted to this agent';
export const NOT_INSTALLED_SUFFIX = ' — not installed';
export const NO_PLUGINS_NOTICE = 'No plugins are installed. A System Admin installs one on the Plugins page; a Team Admin then grants it to the team.';
export const DRAFT_NOTICE = 'Any installed plugin can be named here; whether it is granted to the agent is checked when the draft is materialised.';
export const GRANT_UNKNOWN_NOTICE = 'Could not read which plugins are granted to this agent — every installed plugin is offered.';

function labelFor(entry) {
  const name = entry && entry.manifest && typeof entry.manifest.name === 'string' ? entry.manifest.name.trim() : '';
  if (!name || name === entry.id) return entry.id;
  return `${name} (${entry.id})`;
}

// { installed, grant, currentId, draft } → { options, notice }
//   installed: GET /api/plugins → body.installed
//   grant:     effectiveGrantFor(agent, parentTeam) ([{id, scopeGranularity}]),
//              or null when it cannot be known (draft mode, unreadable parent)
//   currentId: the form's current pluginId (retained if it is not installed)
//   draft:     Flow-editor draft mode — there is no agent, so no grant
export function pluginEventOptions({ installed, grant, currentId, draft = false } = {}) {
  const list = Array.isArray(installed) ? installed.filter(p => p && p.ok !== false && typeof p.id === 'string' && p.id) : [];
  const grantKnown = !draft && Array.isArray(grant);
  const grantedIds = new Set(grantKnown ? grant.map(g => (typeof g === 'string' ? g : g && g.id)).filter(Boolean) : []);
  const current = typeof currentId === 'string' ? currentId.trim() : '';

  const rows = list.map(p => {
    const granted = !grantKnown || grantedIds.has(p.id);
    return {
      value: p.id,
      // The stored value must stay selectable so an edit round-trips it, even
      // when the grant was revoked meanwhile — but it still says so.
      disabled: !granted && p.id !== current,
      label: granted ? labelFor(p) : `${labelFor(p)}${NOT_GRANTED_SUFFIX}`,
      granted,
    };
  });
  // Granted first, stable within each group (registry order).
  rows.sort((a, b) => Number(b.granted) - Number(a.granted));

  const options = [{ value: '', label: PLACEHOLDER_LABEL, disabled: false }];
  if (current && !list.some(p => p.id === current)) {
    options.push({ value: current, label: `${current}${NOT_INSTALLED_SUFFIX}`, disabled: false, retained: true });
  }
  for (const r of rows) options.push({ value: r.value, label: r.label, disabled: r.disabled });

  let notice = null;
  if (list.length === 0) notice = NO_PLUGINS_NOTICE;
  else if (draft) notice = DRAFT_NOTICE;
  else if (!grantKnown) notice = GRANT_UNKNOWN_NOTICE;

  return { options, notice };
}

// The auto-pick: exactly one real, selectable choice → its id, else ''. A
// retained (uninstalled) value is a leftover, never the one choice.
export function defaultPluginId(options) {
  const candidates = (Array.isArray(options) ? options : [])
    .filter(o => o && o.value && !o.disabled && !o.retained);
  return candidates.length === 1 ? candidates[0].value : '';
}
