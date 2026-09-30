// Pure view helpers for the plugin grant UI (plugin system Phase 2, #1518).
//
// The grant panel is a tri-state activation surface (the checkmark pattern from
// PR #1287) plus a per-grant granularity selector. Everything decidable about
// how a row renders — which granularities the manifest offers, whether the
// selector is enabled, the quota ceiling a granularity implies, and whether the
// plugin's declared platforms match the running stack — lives here as pure,
// dependency-free functions (the #651 convention), so it lands in the
// admin-console-src CI job and the JSX shell stays a thin renderer. The server
// re-enforces the grantability rule (plugin-manifest.js assertGranularityGrantable).
//
// No imports: this module is unit-tested with node --test and bundled by Vite.

export const DEFAULT_GRANULARITY = 'team';

// Client-side mirror of plugin-grants.js `normalizeGrantList` (#1547). A grant
// entry is `{ id, scopeGranularity }`; a bare string is the team-granularity
// shorthand. Needed here because the console bundle cannot require the
// orchestrator's CommonJS module, and the picker has to render a stored grant
// in either shape. The SERVER remains the authority — this only decides how an
// existing grant is displayed.
export function normalizeGrantEntries(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    let id = null;
    let granularity = DEFAULT_GRANULARITY;
    if (typeof entry === 'string') {
      id = entry.trim();
    } else if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
      id = entry.id.trim();
      if (entry.scopeGranularity === 'agent' || entry.scopeGranularity === 'team') {
        granularity = entry.scopeGranularity;
      }
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, scopeGranularity: granularity });
  }
  return out;
}

// The grant an agent construct actually carries, following the same inheritance
// rule as effectivePlugins(): a team-member with its own `pluginsOverride`
// REPLACES the team's set; absent means inherit. Everything else carries its
// own `plugins[]`.
export function effectiveGrantFor(agent, parentTeam) {
  if (!agent) return [];
  if (agent.role === 'team-member') {
    if (Array.isArray(agent.pluginsOverride)) return normalizeGrantEntries(agent.pluginsOverride);
    return normalizeGrantEntries(parentTeam && parentTeam.plugins);
  }
  return normalizeGrantEntries(agent.plugins);
}

// Which granularities a manifest's broker honours (mirror of plugin-manifest.js
// grantableGranularities, duplicated here so the console bundle needs no
// server module — the two are asserted equivalent by the shared enum).
export function grantableGranularities(manifest) {
  const scopes = manifest && Array.isArray(manifest.scopes) ? manifest.scopes : null;
  return scopes && scopes.length ? scopes.slice() : [DEFAULT_GRANULARITY];
}

// The granularity selector's render state for one plugin.
//   { options, value, disabled, hint }
// Disabled with an honest hint when the manifest offers only "team" — there is
// nothing to choose, and the UI says why rather than showing a dead control.
export function granularitySelectorState(manifest, current) {
  const options = grantableGranularities(manifest);
  const value = options.includes(current) ? current : DEFAULT_GRANULARITY;
  if (options.length <= 1) {
    return {
      options,
      value,
      disabled: true,
      hint: 'This plugin is shared per team — it does not offer per-agent scopes.',
    };
  }
  return {
    options,
    value,
    disabled: false,
    hint: 'Per-agent scopes isolate each member behind the broker (separate quotas, audit and resources).',
  };
}

// The worst-case scope footprint a granularity implies. Quotas are per scope, so
// "agent" on an N-member squad multiplies the ceiling N-fold (§4.6/§5). Stated
// BEFORE the toggle so an admin sees the cost instead of discovering it as a
// full disk. `memberCount` is the number of members that would carry the grant.
export function quotaCeiling(granularity, memberCount) {
  const n = Number.isFinite(memberCount) && memberCount > 0 ? Math.floor(memberCount) : 1;
  const scopes = granularity === 'agent' ? n : 1;
  return {
    granularity: granularity === 'agent' ? 'agent' : 'team',
    scopes,
    label: scopes === 1
      ? '1 scope (one shared quota, audit and resource pool)'
      : `${scopes} scopes (each member gets its own quota, audit and resource pool)`,
  };
}

// Honest platform match between the plugin's declared platforms and the running
// stack. `["any"]` always matches; otherwise the stack runtime must be listed.
// Returns { ok, message } — message set only on a mismatch, for a warning chip.
export function platformMismatch(manifest, stackRuntime) {
  const platforms = manifest && Array.isArray(manifest.platforms) && manifest.platforms.length
    ? manifest.platforms
    : ['any'];
  if (platforms.includes('any')) return { ok: true, message: null };
  if (stackRuntime && platforms.includes(stackRuntime)) return { ok: true, message: null };
  return {
    ok: false,
    message: `Requires ${platforms.join(' / ')}; this stack runs ${stackRuntime || 'an unknown runtime'}.`,
  };
}

// Does a row have anything to say beyond its header (#2269 AC3)? The expand
// affordance only renders when there is: a description to show in full, a
// platform mismatch to explain, or (once granted) the Scope/quota controls.
export function hasExpandableDetail(row) {
  if (!row) return false;
  return !!(row.description || (row.platform && !row.platform.ok) || row.granted);
}

// Fold everything into a single row view the JSX renders directly.
//   manifest      : the installed plugin's normalised manifest
//   grant         : the resolved grant entry for this agent/team, or null
//   memberCount   : members that would carry a team-level grant (for the ceiling)
//   stackRuntime  : the running stack runtime ("podman" locally)
export function pluginGrantRow(manifest, grant, { memberCount = 1, stackRuntime = null } = {}) {
  const granted = !!grant;
  const granularity = grant && grant.scopeGranularity ? grant.scopeGranularity : DEFAULT_GRANULARITY;
  return {
    id: manifest.id,
    name: manifest.name || manifest.id,
    description: manifest.description || '',
    granted,
    granularity,
    selector: granularitySelectorState(manifest, granularity),
    quota: quotaCeiling(granularity, memberCount),
    platform: platformMismatch(manifest, stackRuntime),
  };
}


// Grants whose plugin is not installed (or whose manifest no longer validates)
// — #2651. Uninstalling a plugin deliberately keeps its grants, but the picker
// renders one row per INSTALLED plugin, so such a grant was invisible and could
// only be revoked by re-installing the plugin first. These rows let the
// Plugins tab show it and offer a Revoke, which the server accepts without a
// manifest. `installed` is the /api/plugins `installed` list ({ id, ok, manifest }).
export const UNINSTALLED_GRANT_STATUS = 'Plugin not installed';
export const UNINSTALLED_GRANT_HINT =
  'The plugin is not installed (or its manifest is invalid), but this grant is still '
  + 'active. Its broker is gone, so the command cannot work; revoking removes the command and the capability note from the '
  + 'agent. Re-installing the plugin would restore the grant instead.';

export function uninstalledGrantRows(grant, installed) {
  // An unknown installed list (still loading, or the fetch failed) must not
  // make every grant look orphaned: that would offer Revoke on working grants.
  if (!Array.isArray(installed)) return [];
  const live = new Set(installed
    .filter((p) => p && p.ok && p.manifest)
    .map((p) => p.id));
  return normalizeGrantEntries(grant)
    .filter((g) => !live.has(g.id))
    .map((g) => ({
      id: g.id,
      granularity: g.scopeGranularity,
      status: UNINSTALLED_GRANT_STATUS,
      revokeLabel: `Revoke the ${g.id} grant`,
    }));
}
