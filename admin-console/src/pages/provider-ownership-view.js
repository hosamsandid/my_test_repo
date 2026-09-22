// Pure view helpers for the Model-Provider Ownership control (#2360).
//
// ONE axis — "who can use this provider?" — with three answers, narrow → wide:
//
//   personal → only the owner + the agents they own      (scope: personal)
//   team     → a SET of agent teams                       (scope: team, teamIds[])
//   global   → every user and every agent team           (scope: system, global)
//
// "team" is a co-owned SET of agent teams (#2360): a provider can serve several
// teams without being duplicated. The common case is one team; cloning a team
// APPENDS the clone to the set (server-side), so a cloned team keeps a working
// provider with no copy of the secret. Storage: `scope: 'team'`, `teamId` = the
// primary (first) agent team for backward-compat, `teamIds` = the full set.
//
// The identity axis is NOT a separate control for providers: it is the auth type
// (api-key = service → any tier; subscription/oauth = human → personal, or global
// via the single-user escape hatch, never team). Pure (no React/fetch) →
// unit-tested in provider-ownership-view.test.js. UX only — the server re-checks.

import { normalizeCredential, canManageCredentialClient } from './credential-scope-view.js';

export const PROVIDER_OWNERSHIP_SCOPES = ['personal', 'team', 'global'];

// The agent-team SET a team provider serves (client mirror of api.js
// providerTeamSet): its `teamIds`, falling back to the legacy single `teamId`.
export function providerTeamSetOf(ep) {
  if (!ep || ep.scope !== 'team') return [];
  return Array.isArray(ep.teamIds) && ep.teamIds.length
    ? ep.teamIds.map(String)
    : (ep.teamId ? [String(ep.teamId)] : []);
}

// Co-owned management (#2360, decision A) — client mirror of api.js
// canManageProvider: a team provider is manageable by the admin of ANY of its
// teams (or a System Admin / the legacy owning-team rule). `v2` gates the
// co-owned widening. UX only — the API re-checks.
export function canManageProviderClient(ep, caller = {}, v2 = false) {
  if (canManageCredentialClient(ep, caller)) return true;
  if (v2 && ep && ep.scope === 'team') {
    const admin = caller.adminTeamIds || [];
    return providerTeamSetOf(ep).some(id => admin.includes(id));
  }
  return false;
}

// The three option descriptors for the radio-card control (see #2360). `team`
// now means one-or-more agent teams; `enabled`/`disabledReason` unchanged.
export function providerOwnershipOptions({ isOauth = false, isSysAdmin = false, adminTeamIds = [], canGlobalOauth = false } = {}) {
  const hasTeam = isSysAdmin || adminTeamIds.length > 0;
  return [
    {
      value: 'personal',
      label: 'Personal',
      hint: 'Only you and the agents you own.',
      enabled: true,
      disabledReason: '',
    },
    {
      value: 'team',
      label: 'Team(s)',
      hint: 'One or more agent teams. A clone of a team is added automatically — the provider is shared, never duplicated.',
      enabled: !isOauth && hasTeam,
      disabledReason: isOauth
        ? "A subscription is a single seat — it can't be shared with a team."
        : (hasTeam ? '' : 'You administer no team.'),
    },
    {
      value: 'global',
      label: 'Global',
      hint: 'Every user and every agent team.',
      enabled: isSysAdmin && (!isOauth || canGlobalOauth),
      disabledReason: !isSysAdmin
        ? 'System Admins only.'
        : (isOauth && !canGlobalOauth ? 'Confirm single-user use to publish a subscription globally.' : ''),
    },
  ];
}

// The initial control state for a NEW provider. A subscription defaults to
// Personal; otherwise Team(s) — preselected to the caller's single admin team
// when there is exactly one, else an empty set they must fill.
export function defaultProviderOwnership({ isSysAdmin = false, adminTeamIds = [], isOauth = false } = {}) {
  if (isOauth) return { scope: 'personal', teamIds: [] };
  if (!isSysAdmin && adminTeamIds.length === 1) return { scope: 'team', teamIds: [adminTeamIds[0]] };
  return { scope: 'team', teamIds: [] };
}

// The control state for an EXISTING provider. Global → global; personal → itself;
// a team provider → its team SET (`teamIds`, falling back to the legacy single
// `teamId`); a legacy `system` + assignedTeamIds record collapses to a team set
// (the multi-assign axis is now first-class again as agent teams).
export function providerOwnershipFromRecord(rec) {
  if (!rec || typeof rec !== 'object') return { scope: 'personal', teamIds: [] };
  if (rec.global === true && rec.scope === 'system') return { scope: 'global', teamIds: [] };
  const n = normalizeCredential(rec);
  if (n.scope === 'personal') return { scope: 'personal', teamIds: [] };
  if (n.scope === 'team') {
    const set = Array.isArray(rec.teamIds) && rec.teamIds.length
      ? rec.teamIds.map(String)
      : (n.teamId ? [String(n.teamId)] : []);
    return { scope: 'team', teamIds: set };
  }
  if (Array.isArray(n.assignedTeamIds) && n.assignedTeamIds.length) {
    return { scope: 'team', teamIds: n.assignedTeamIds.map(String) };
  }
  return { scope: 'global', teamIds: [] };
}

// The table's "Ownership" descriptor for a provider row — the SAME taxonomy as
// the edit dialog (Personal / Team(s) / Global), derived from the record through
// `providerOwnershipFromRecord` so the row and the dialog can never disagree
// (#2360 follow-up: the table still rendered the old System/Team/Personal
// `credentialScopeLabel`). `names` is an id→display-name map for the team set.
// Returns `{ scope, label, detail }`; pure — unit-tested here.
export function providerScopeLabel(rec, names = {}) {
  const { scope, teamIds } = providerOwnershipFromRecord(rec);
  if (scope === 'global') {
    return { scope: 'global', label: 'Global', detail: 'Every user and agent team' };
  }
  if (scope === 'personal') {
    return { scope: 'personal', label: 'Personal', detail: 'Only you and the agents you own' };
  }
  const teamNames = (teamIds || []).map(id => (names && names[id]) || id);
  return {
    scope: 'team',
    label: teamNames.length > 1 ? 'Teams' : 'Team',
    detail: teamNames.length ? teamNames.join(', ') : 'No team assigned',
  };
}

// Whether the Ownership cell should render the descriptor `detail` beside the
// scope pill (#2405). Only Team scope carries real extra information (the
// assigned team name(s)); Personal's detail ("Only you and the agents you own")
// merely repeats what the "Personal" pill already says, so it is dropped to
// declutter the column. Global renders its own single pill upstream (no detail).
export function providerScopeShowsDetail(scope) {
  return scope === 'team';
}

// Reduce the control state to the API body fields. For team(s): `teamId` = the
// primary (first) for backward-compat, `teamIds` = the full set. `global` is
// carried explicitly so an edit can RETRACT it.
export function providerOwnershipPayload({ scope, teamIds } = {}) {
  if (scope === 'global') return { scope: 'system', assignedTeamIds: [], global: true };
  if (scope === 'team') {
    const set = [...new Set((teamIds || []).map(String))];
    return { scope: 'team', teamId: set[0] || undefined, teamIds: set, global: false };
  }
  return { scope: 'personal', global: false };
}

// Is the control submittable? Personal / Global always; Team(s) needs ≥1 team.
export function providerOwnershipReady({ scope, teamIds } = {}) {
  return scope === 'personal' || scope === 'global' || (Array.isArray(teamIds) && teamIds.length > 0);
}
