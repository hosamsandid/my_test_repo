// ─── Plugin Tokens page — pure view logic (#2562) ────────────────────────────
//
// The page lists every installed plugin whose manifest declares a personal
// credential tier (`personalCredentials`, e.g. Jira's e-mail + API token) and
// the CALLER's own status for it. The API returns metadata only — set/unset, a
// preview and when it was saved — so nothing here ever holds a stored secret.
// Kept apart from the JSX so node:test covers it (the #651 convention).

// A warning when the team-side connection this plugin needs (Jira: the site) is
// not set anywhere the caller's plugin is granted — a personal token alone can't
// work in chat until a Team Admin sets it. → string | null (null = nothing to
// warn about: connected already, or the plugin has no team-connection concept).
export function teamConnectionNote(plugin) {
  const tc = plugin && plugin.teamConnection;
  if (!tc || tc.configured) return null;
  if (!tc.granted) {
    return `This plugin is not granted to any of your teams yet, so it can't be used in chat until a Team Admin grants it and sets it up.`;
  }
  return `Your team's ${plugin.name || 'plugin'} site isn't set yet — until a Team Admin sets it in Agent Chat → Settings → Plugins, chat will still be refused even with your token below.`;
}

// → { state: 'set' | 'incomplete' | 'unset', label, setAt }
export function describePluginTokenStatus(plugin) {
  const keys = (plugin && plugin.keys) || {};
  const anySet = Object.values(keys).some((k) => k && k.set);
  const setAt = (plugin && plugin.setAt) || null;
  if (plugin && plugin.complete && anySet) return { state: 'set', label: 'Set', setAt };
  if (anySet) return { state: 'incomplete', label: 'Incomplete — chat turns are refused until every required field is set', setAt };
  return { state: 'unset', label: 'Not set — chat turns using this plugin are refused', setAt: null };
}

// The form starts with non-secret values pre-filled (the API discloses those,
// e.g. the e-mail) and secret fields empty.
export function initialFormValues(plugin) {
  const out = {};
  for (const c of (plugin && plugin.credentials) || []) {
    const meta = plugin.keys && plugin.keys[c.key];
    out[c.key] = !c.secret && meta && typeof meta.value === 'string' ? meta.value : '';
  }
  return out;
}

// What a Save sends. An empty SECRET field means "keep the stored one" and is
// omitted — the store would otherwise treat '' as "clear this key". Non-secret
// fields are always sent as typed (so clearing one is deliberate).
export function valuesToSubmit(plugin, form) {
  const values = {};
  for (const c of (plugin && plugin.credentials) || []) {
    const v = typeof form[c.key] === 'string' ? form[c.key].trim() : '';
    if (c.secret && !v) continue;
    values[c.key] = v;
  }
  return values;
}

// Required fields still missing after this save → reasons the Save is blocked.
export function submitBlockers(plugin, form) {
  const blockers = [];
  for (const c of (plugin && plugin.credentials) || []) {
    if (!c.required) continue;
    const typed = typeof form[c.key] === 'string' && form[c.key].trim() !== '';
    const stored = !!(c.secret && plugin.keys && plugin.keys[c.key] && plugin.keys[c.key].set);
    if (!typed && !stored) blockers.push(c.key);
  }
  return blockers;
}
