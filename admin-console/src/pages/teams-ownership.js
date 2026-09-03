// Pure helpers for the Teams page's Resource-Ownership section (#568).
//
// An Agent Team — a `role: "team"` agent plus its `role: "team-member"` agents
// (each carrying `parentTeamId`) — shares one per-tenant knowledge base and so
// must move between tenant Teams as one unit, never per member. These helpers
// turn the flat agent list into groups the UI renders with a single
// team-assignment control per Agent Team, keeping standalone agents
// individually assignable. Kept outside React so the grouping is testable.

const TEAM_ROLE = 'team';
const MEMBER_ROLE = 'team-member';

function label(a) {
  return (a && (a.displayName || a.id)) || '';
}

function byLabel(a, b) {
  return label(a).localeCompare(label(b)) || String(a.id).localeCompare(String(b.id));
}

// Split the agent list into Agent Teams and standalone agents.
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

// The tenant `teamId` an Agent Team currently sits in, taken from its parent
// team agent (members inherit it — see the #568 cascade). Falls back to the
// default tenant when unset.
export function agentTeamTenant(team, defaultTeamId) {
  return (team && team.teamId) || defaultTeamId;
}
