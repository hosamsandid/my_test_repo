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

