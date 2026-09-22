// Pure view helpers for the Model-Provider Ownership control (#2360).
//
// The redesign collapses the old "Global checkbox + System(assign to teams) /
// Team-owned" pair into ONE axis — the question "who can use this provider?" —
// with three mutually exclusive answers, narrow → wide:
//
//   personal → only the owner + the agents they own      (scope: personal)
//   team     → one team; copied when the team is cloned  (scope: team, teamId)
//   global   → every user and every agent team           (scope: system, global)
//
// The identity axis is NOT a separate control for providers: it is the auth type
// (api-key = service → any tier; subscription/oauth = human → personal, or global
// via the single-user escape hatch, never team). So these helpers take `isOauth`
// and constrain the options accordingly. Pure (no React, no fetch) → unit-tested
// in provider-ownership-view.test.js; the JSX lives in ProviderOwnership.jsx.
//
// UX only — the server re-checks every rule (canCreateCredential / resolveGlobalFlag).

import { normalizeCredential } from './credential-scope-view.js';

export const PROVIDER_OWNERSHIP_SCOPES = ['personal', 'team', 'global'];

// The three option descriptors for the radio-card control, each with an
// `enabled` flag and, when disabled, a `disabledReason` (the option stays
// VISIBLE for discoverability, per the agreed design). Inputs:
//   isOauth       — the effective auth type is a subscription seat.
//   isSysAdmin    — the caller has full visibility.
//   adminTeamIds  — teams the caller administers (for the non-admin team gate).
//   canGlobalOauth— the single-user escape hatch applies (compliance ack), so an
//                   oauth provider MAY be global.
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
      label: 'Team',
      hint: "One team. Copied with the team when it's cloned.",
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
// Personal (the only non-hatch tier it may hold); otherwise Team (the common
// shared case) — preselected to the caller's single admin team when there is
// exactly one, else left blank so they must choose.
export function defaultProviderOwnership({ isSysAdmin = false, adminTeamIds = [], isOauth = false } = {}) {
  if (isOauth) return { scope: 'personal', teamId: '' };
  if (!isSysAdmin && adminTeamIds.length === 1) return { scope: 'team', teamId: adminTeamIds[0] };
  return { scope: 'team', teamId: '' };
}

// The control state for an EXISTING provider. A global record → global; a
// personal/team record → itself; a legacy `system` + assignedTeamIds record
// collapses to its first assigned team (else global) — the migration off the
// removed multi-assign axis, surfaced the moment an admin edits it.
export function providerOwnershipFromRecord(rec) {
  if (!rec || typeof rec !== 'object') return { scope: 'personal', teamId: '' };
  if (rec.global === true && rec.scope === 'system') return { scope: 'global', teamId: '' };
  const n = normalizeCredential(rec);
  if (n.scope === 'personal') return { scope: 'personal', teamId: '' };
  if (n.scope === 'team') return { scope: 'team', teamId: n.teamId || '' };
  if (Array.isArray(n.assignedTeamIds) && n.assignedTeamIds.length) {
    return { scope: 'team', teamId: String(n.assignedTeamIds[0]) };
  }
  return { scope: 'global', teamId: '' };
}

// Reduce the control state to the API body fields. `global` is carried
// explicitly so an edit can RETRACT it (global → team/personal). Off the global
// scope it is `false`; the server ignores it for non-admins.
export function providerOwnershipPayload({ scope, teamId } = {}) {
  if (scope === 'global') return { scope: 'system', assignedTeamIds: [], global: true };
  if (scope === 'team') return { scope: 'team', teamId: teamId || undefined, global: false };
  return { scope: 'personal', global: false };
}

// Is the control in a submittable state? Personal / Global need nothing more;
// Team needs a chosen team.
export function providerOwnershipReady({ scope, teamId } = {}) {
  return scope === 'personal' || scope === 'global' || !!teamId;
}
