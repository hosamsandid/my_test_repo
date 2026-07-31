// Groups bound-agents for the respawn dialog (PR #1049): one group per parent
// team (sorted by name), standalone agents (no parentTeamId) last under one
// synthetic group, so a large squad-heavy list stays scannable. Pure — no
// React dependency — so it's unit-tested directly (group-agents-by-team.test.js)
// even though this repo has no JSX/component test runner yet (#651).
export function groupAgentsByTeam(agents) {
  const byTeam = new Map();
  const standalone = [];
  for (const a of agents) {
    if (!a.teamId) {
      standalone.push(a);
      continue;
    }
    if (!byTeam.has(a.teamId)) {
      byTeam.set(a.teamId, { key: a.teamId, name: a.teamName || a.teamId, agents: [] });
    }
    byTeam.get(a.teamId).agents.push(a);
  }
  const groups = [...byTeam.values()].sort((x, y) => x.name.localeCompare(y.name));
  if (standalone.length > 0) {
    groups.push({ key: '__standalone__', name: 'Standalone agents', agents: standalone });
  }
  return groups;
}
