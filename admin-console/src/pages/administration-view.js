// Pure decisions for the **Administration** page (#2085, epic #2076 P6, D10).
//
// The *Access* nav entry is dissolved rather than renamed: `/teams` and its page
// are retired (the Share dialog, #2082, is where a team's members are managed
// now) and the two halves only a System Admin still needs move onto this page as
// tabs — the all-teams cleanup view (D5) and the tiered resource ownership
// (D7/D12). This module owns everything about those tabs that is not JSX, so the
// page component stays a renderer (#651). `users-view.js` keeps the Users tab's
// own row/validation logic; nothing here duplicates it.
//
// Two things are deliberately NOT re-derived here:
//   • the resource **tier** semantics come from `credential-scope-view.js`,
//     which #2083 made the one definition shared by credentials, working
//     environments and MCP servers. A second copy is how a shared record gets
//     silently un-shared.
//   • `groupAgentsForOwnership` moved in from the retired `teams-ownership.js`
//     verbatim (it was already pure and covered); `agentTeamTenant` came with
//     the page and collapsed with it — nothing read it but its own test.

import { credentialScopeLabel, normalizeCredential, ownershipPayload } from './credential-scope-view.js';

/* ── Tabs ──────────────────────────────────────────────────────────────── */

// The tab order is the reading order the ticket asks for: who may sign in, then
// which teams exist, then what those teams own. The array IS the display order —
// there is no separate rank field to drift out of step with it.
export const ADMIN_TABS = [
  { id: 'users', label: 'Users' },
  { id: 'teams', label: 'All Teams' },
  { id: 'resources', label: 'Resources' },
];

export const DEFAULT_ADMIN_TAB = 'users';

// Resolve the `?tab=` query parameter. An unknown or absent value lands on
// Users, which is the page's pre-#2085 content — so an existing `/users`
// bookmark opens exactly what it used to.
export function resolveAdminTab(raw) {
  const id = String(raw || '');
  return ADMIN_TABS.some(t => t.id === id) ? id : DEFAULT_ADMIN_TAB;
}

/* ── All Teams (the D5 cleanup view) ───────────────────────────────────── */

const TEAM_ROLE = 'team';
const MEMBER_ROLE = 'team-member';

function agentLabel(a) {
  return (a && (a.displayName || a.id)) || '';
}

function byLabel(a, b) {
  return agentLabel(a).localeCompare(agentLabel(b)) || String(a.id).localeCompare(String(b.id));
}

// One row per **Agent Team** — a `role: 'team'` agent. That is the referent a
// membership points at since P1 (§3.3), so "every team a System Admin can clean
// up" is the Agent Team list, not the legacy access-scope list (which no longer
// has a create path at all since #2081 and is retired by A3.3).
//
// Every displayed value is flattened onto a top-level key because DataTable
// filters and sorts by `row[col.key]` only — a count nested under `_team` would
// render but neither sort nor filter.
export function allTeamRows(agents, memberships, users) {
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
  const grants = Array.isArray(memberships) ? memberships.filter(Boolean) : [];
  const people = Array.isArray(users) ? users.filter(Boolean) : [];

  const nameByUserId = new Map(people.map(u => [u.id, u.displayName || u.subject || u.id]));

  const agentCount = new Map();
  for (const a of list) {
    if (a.role === MEMBER_ROLE && a.parentTeamId) {
      agentCount.set(a.parentTeamId, (agentCount.get(a.parentTeamId) || 0) + 1);
    }
  }

  const adminCount = new Map();
  const peopleCount = new Map();
  for (const m of grants) {
    if (!m.teamId) continue;
    peopleCount.set(m.teamId, (peopleCount.get(m.teamId) || 0) + 1);
    if (m.role === 'team-admin') adminCount.set(m.teamId, (adminCount.get(m.teamId) || 0) + 1);
  }

  return list
    .filter(a => a.role === TEAM_ROLE)
    .sort(byLabel)
    .map(team => {
      const admins = adminCount.get(team.id) || 0;
      const humans = peopleCount.get(team.id) || 0;
      return {
        id: team.id,
        name: agentLabel(team),
        // An unowned team is reported as such rather than blank: D6's own rule
        // ends in "else unset", so `ownerId` is legitimately absent on a team
        // whose access scope had no member at migration time (#2077 Amendment 1).
        owner: team.ownerId ? (nameByUserId.get(team.ownerId) || team.ownerId) : '—',
        agents: agentCount.get(team.id) || 0,
        people: humans,
        // The number that matters for D4: a team with no admin left is one only
        // a System Admin can still change, which is exactly what this view is
        // for. Rendered as text so it sorts and filters like every other column.
        admins,
        enabled: team.enabled === false ? 'Disabled' : 'Enabled',
        _team: team,
      };
    });
}

// Whether this team is currently un-administrable — nobody but a System Admin
// can change it. D5 says no orphan-recovery machinery is needed *because* an
// admin can always re-admin such a team; this view is where they would see one.
export function isUnadministered(row) {
  return !!row && row.admins === 0;
}

// The facts the delete confirmation must state. Deleting a `role: 'team'` agent
// already cascades both ways — its member agents (#1960) and its human
// memberships (#2081) — so the honest confirmation names both counts rather
// than the vague "and its members".
export function teamDeleteImpact(row) {
  if (!row) return null;
  const parts = [];
  parts.push(row.agents === 1 ? '1 member agent is deleted' : `${row.agents} member agents are deleted`);
  parts.push(row.people === 1 ? '1 person loses their membership' : `${row.people} people lose their membership`);
  return {
    title: `Delete team "${row.name}"?`,
    // Stated because it is the one consequence that is NOT reversible by
    // re-creating the team: the member agents' workspaces go with them.
    detail: `${parts.join(' and ')}. This cannot be undone — the member agents' workspaces are deleted with them.`,
  };
}

/* ── Resources (tiered ownership, D7/D12) ──────────────────────────────── */

// Split the agent list into Agent Teams and standalone agents (moved verbatim
// from `teams-ownership.js`, #568).
//
// Returns `{ agentTeams, standaloneAgents }` where:
//   - `agentTeams` is `[{ team, members }]` — one entry per `role: "team"`
//     agent, `members` being its `team-member` agents (sorted). This is the
//     unit of assignment: the whole group moves together.
//   - `standaloneAgents` is every other agent — a `role: "agent"` with no
//     parent, still assignable individually. The grouping is role-agnostic
//     rather than an allow-list, so a leftover config from a retired role
//     (#1964) lands here and stays assignable instead of vanishing.
//
// Edge cases:
//   - E1: a team with no members yields `members: []` (still assignable).
//   - E2: an orphan `team-member` whose `parentTeamId` names no existing team
//     agent is treated as standalone (individually assignable) rather than
//     hidden or bucketed under an "unknown team" — the page never crashes and
//     the agent stays reachable.
export function groupAgentsForOwnership(agents) {
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
  const teamIds = new Set(list.filter(a => a.role === TEAM_ROLE).map(a => a.id));

  const membersByParent = new Map();
  const standaloneAgents = [];
  for (const a of list) {
    if (a.role === TEAM_ROLE) continue; // team agents head their own group
    if (a.role === MEMBER_ROLE && a.parentTeamId && teamIds.has(a.parentTeamId)) {
      if (!membersByParent.has(a.parentTeamId)) membersByParent.set(a.parentTeamId, []);
      membersByParent.get(a.parentTeamId).push(a);
    } else {
      // Standalone, or an orphan team-member (E2) whose parent is gone.
      standaloneAgents.push(a);
    }
  }

  const agentTeams = list
    .filter(a => a.role === TEAM_ROLE)
    .sort(byLabel)
    .map(team => ({
      team,
      members: (membersByParent.get(team.id) || []).slice().sort(byLabel),
    }));

  return { agentTeams, standaloneAgents: standaloneAgents.sort(byLabel) };
}

// The one-line tier summary for a Working Environment.
//
// This is the whole reason the Resources section had to be reworked rather than
// carried over: before #2083 an environment had a single `teamId` and a flat
// team dropdown was a faithful control. It now carries the same
// `{scope, teamId, assignedTeamIds}` triple a credential does, and a bare
// `PUT { teamId }` against a **shared** record reads as `scope: 'team'` on the
// server (`normalizeCredential`) — i.e. the old one-click select would silently
// un-share it. So the row states the tier first and edits it as a tier.
//
// `label` says **Shared**, not "System": that is the word §5 uses for this tier
// on environments and MCP servers, and the word the Working Environments form
// already shows. The `scope` value stays the wire value (`system`) so nothing
// downstream has to translate back.
export function environmentTierSummary(env, teamNames = {}) {
  const tier = credentialScopeLabel(env, teamNames);
  if (tier.scope === 'system') {
    return {
      scope: 'system',
      label: 'Shared',
      detail: tier.teams.length
        ? tier.teams.join(', ')
        // Not a hypothetical: an unassigned shared record is reachable by no
        // team at all, only by a System Admin — worth saying plainly on the one
        // page that can fix it.
        : 'Not assigned to any team — System Admins only',
    };
  }
  if (tier.scope === 'personal') {
    // A3.2 refuses the personal tier for environments, so this is a record in a
    // state the platform does not create. Report it rather than rendering it as
    // a team the reader could then reassign.
    return { scope: 'personal', label: 'Personal', detail: 'Unsupported tier for an environment' };
  }
  return { scope: 'team', label: 'Team', detail: tier.detail };
}

// Why Save is refused, or null when the pending ownership is submittable. A
// team-tier record with no team selected would 400 server-side; saying so on
// the button is cheaper than a round trip.
export function environmentOwnershipError(ownership) {
  const own = ownership || {};
  if (own.scope === 'personal') return 'An environment cannot be personal — pick Shared or Team-owned.';
  if (own.scope !== 'system' && !own.teamId) return 'Pick the team that owns this environment.';
  return null;
}

// The `PUT /api/environments/:id` body. Delegates to the shared
// `ownershipPayload` so this page and the Working Environments form send the
// identical shape — the server's `isRetier` check compares against the stored
// record, so echoing an unchanged tier back is explicitly not an operator act.
export function environmentOwnershipPatch(ownership) {
  return ownershipPayload(ownership);
}

// Has the pending ownership actually moved the record? Used only to keep Save
// inert on a no-op — the server decides what counts as a re-tier.
export function ownershipUnchanged(env, ownership) {
  const before = normalizeCredential(env || {});
  const after = ownership || {};
  if ((before.scope === 'system') !== (after.scope === 'system')) return false;
  if (before.scope === 'system') {
    const a = [...(before.assignedTeamIds || [])].sort().join(',');
    const b = [...new Set((after.assignedTeamIds || []).map(String))].sort().join(',');
    return a === b;
  }
  return (before.teamId || '') === (after.teamId || '');
}
