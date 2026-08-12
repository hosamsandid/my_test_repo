// Pure view helpers for the Plugins-page team-assignment control (#1691).
//
// The Plugins page installs a plugin; granting it to a team used to live only
// in the Agents-page edit form. This control closes that discoverability gap by
// letting an admin assign an installed plugin to one or more teams straight
// from its card — reusing the existing activation path
// (`POST /api/agents/:teamId/plugins/{activate,deactivate}`, team construct),
// never a new grant mechanism or data model.
//
// Everything decidable about how the control renders — which teams are
// grantable, which already carry the plugin, the status summary, the empty and
// no-grantable-team states, and which scope granularity a grant made here
// should use — lives here as pure, dependency-free functions (the #651
// convention), so it lands in the admin-console-src CI job and the JSX stays a
// thin renderer. The server re-enforces grantability (`proxyPluginActivation`
// + the orchestrator grant store); this is a courtesy bound, not the control.

import { normalizeGrantEntries, platformMismatch } from './plugin-grant-view.js';

// The team constructs the current user may grant to. `GET /api/agents` is
// already team-scoped server-side (`visibleAgent`), and the activation proxy
// re-checks the same visibility, so every `role: 'team'` agent the caller can
// see here is one it may grant to. Each carries its normalised current grant
// so the checklist can reflect the persisted team-level `plugins[]`.
export function grantableTeams(agents) {
  const list = Array.isArray(agents) ? agents : (agents && agents.agents) || [];
  return list
    .filter((a) => a && a.role === 'team' && typeof a.id === 'string' && a.id)
    .map((a) => ({
      id: a.id,
      name: (typeof a.name === 'string' && a.name) || a.id,
      plugins: normalizeGrantEntries(a.plugins),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Does a team's persisted team-level grant include this plugin? Reads the team
// agent's own `plugins[]` (the whole-squad grant) — deliberately NOT a member's
// `pluginsOverride`, so the displayed state stays honest about the team grant
// even when a member has overridden it (AC7).
export function teamHasPlugin(team, pluginId) {
  return !!(team && Array.isArray(team.plugins) && team.plugins.some((g) => g && g.id === pluginId));
}

// The per-plugin assignment view the card renders directly.
//   rows          : one checklist row per grantable team ({ id, name, granted })
//   grantedNames  : names of the teams that currently carry the plugin
//   grantedCount  : how many teams carry it
//   summary       : compact "Assigned to N teams: …" / empty-state line (AC3/AC6)
//   noTeams       : the caller can grant to no team at all (AC8 — a hint, not an error)
export function pluginAssignmentState(pluginId, teams) {
  const list = Array.isArray(teams) ? teams : [];
  const rows = list.map((t) => ({ id: t.id, name: t.name, granted: teamHasPlugin(t, pluginId) }));
  const grantedNames = rows.filter((r) => r.granted).map((r) => r.name);
  return {
    rows,
    grantedNames,
    grantedCount: grantedNames.length,
    noTeams: rows.length === 0,
    summary: grantedNames.length
      ? `Assigned to ${grantedNames.length} team${grantedNames.length === 1 ? '' : 's'}: ${grantedNames.join(', ')}`
      : 'Not assigned to any team yet',
  };
}

// Open question 1 (resolved in favour of the recommendation): a grant made from
// this page reuses the plugin's manifest `defaultScopeGranularity`, so the same
// plugin behaves identically whether granted here or on the Agents page. Absent
// or out-of-scope → the platform default `team` (or the sole offered scope).
export function assignmentGranularity(row) {
  const scopes = row && Array.isArray(row.scopes) && row.scopes.length ? row.scopes : ['team'];
  const dflt = row && row.defaultScopeGranularity;
  if ((dflt === 'team' || dflt === 'agent') && scopes.includes(dflt)) return dflt;
  return scopes.includes('team') ? 'team' : scopes[0];
}

// Whether the control may grant at all, and why not. Platform mismatch (a
// Podman-only plugin on a non-Podman stack) gates it with the plugin's own
// mismatch message — the same signal the install/grant surfaces already show.
// An invalid manifest (`row.ok === false`) is never grantable.
export function assignmentGate(row, stackRuntime) {
  if (!row || row.ok === false) {
    return { ok: false, reason: 'This plugin’s manifest is invalid, so it cannot be assigned.' };
  }
  const platform = platformMismatch({ platforms: row.platforms }, stackRuntime);
  if (!platform.ok) return { ok: false, reason: platform.message };
  return { ok: true, reason: null };
}
