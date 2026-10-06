// Pure view helper for the Skills Registry's "Install into agent" selector
// (#2836): groups the installable agents under their agent team so entries
// that share a display name (several "My Assistant"s) can be told apart.
// Kept pure (no React, no fetch) so it is unit-tested; SkillsRegistry.jsx
// renders each group as an <optgroup>.
//
// Team membership is `parentTeamId` — the same notion the Agent Chat left rail
// groups by (agent-chat/agent-list-model.js `buildGroups`). Team names come
// from the page's `teamNames` id→name map (the Skills table's Scope column
// lookup), falling back to the team id while names are unknown.

export const NO_TEAM_LABEL = 'No team';

const byText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

// `agents`: [{ id, displayName, parentTeamId? }]; `teamNames`: { [teamId]: name }.
// Returns [{ key, teamId, label, agents: [{ id, displayName }] }] — team groups
// sorted by name (case-insensitive), agents sorted by display name, and a final
// "No team" group (teamId null) only when some agent has no known team. A team
// name shared by two different teams gets its id appended so the labels differ.
export function groupInstallTargets(agents = [], teamNames = {}) {
  const names = teamNames && typeof teamNames === 'object' ? teamNames : {};
  const buckets = new Map();
  const orphans = [];
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || !a.id) continue;
    const row = { id: a.id, displayName: a.displayName || a.id };
    const teamId = typeof a.parentTeamId === 'string' && a.parentTeamId ? a.parentTeamId : null;
    if (!teamId) { orphans.push(row); continue; }
    if (!buckets.has(teamId)) buckets.set(teamId, []);
    buckets.get(teamId).push(row);
  }

  const groups = [...buckets.entries()].map(([teamId, rows]) => ({
    teamId,
    name: names[teamId] || teamId,
    agents: rows,
  }));

  const nameCounts = new Map();
  for (const g of groups) {
    const k = g.name.toLocaleLowerCase();
    nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
  }

  const sortAgents = rows => rows.sort((a, b) => byText(a.displayName, b.displayName) || byText(a.id, b.id));
  const out = groups
    .sort((a, b) => byText(a.name, b.name) || byText(a.teamId, b.teamId))
    .map(g => ({
      key: `team:${g.teamId}`,
      teamId: g.teamId,
      label: nameCounts.get(g.name.toLocaleLowerCase()) > 1 && g.name !== g.teamId
        ? `${g.name} (${g.teamId})`
        : g.name,
      agents: sortAgents(g.agents),
    }));

  if (orphans.length) {
    out.push({ key: 'no-team', teamId: null, label: NO_TEAM_LABEL, agents: sortAgents(orphans) });
  }
  return out;
}
