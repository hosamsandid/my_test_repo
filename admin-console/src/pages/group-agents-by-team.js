// Pure decisions for the Model Providers respawn dialog (PR #1049, widened by
// #1501). No React dependency, so they're unit-tested directly
// (group-agents-by-team.test.js) even though this repo has no JSX/component
// test runner yet (#651).

// Groups bound-agents for the respawn dialog: one group per parent team (sorted
// by name), standalone agents (no parentTeamId) last under one synthetic group,
// so a large squad-heavy list stays scannable.
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

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// Where the hidden agents live, as a phrase — "in another team", "in 2 other
// teams", "outside your teams", or both halves joined. Returns '' when there is
// nothing to place, so a caller drops the clause entirely rather than printing a
// dangling preposition: a hidden agent with no team boundary is real (someone
// else's standalone agent), and so is a signal that can place neither.
function hiddenWhere({ teamCount = 0, standalone = 0 } = {}) {
  const parts = [];
  if (teamCount === 1) parts.push('in another team');
  else if (teamCount > 1) parts.push(`in ${teamCount} other teams`);
  if (standalone > 0) parts.push('outside your teams');
  return parts.join(' and ');
}

// The #1501 aggregate signal: bound agents the caller may not see are reported
// as a count, never omitted. An operator deciding whether to rotate a shared
// credential needs the true blast radius even when the identities in it are none
// of their business. Returns null when nothing is hidden.
export function hiddenAgentsNotice(hidden) {
  const count = (hidden && hidden.count) || 0;
  if (count <= 0) return null;
  const where = hiddenWhere(hidden);
  const tail = where ? ` ${where}` : '';
  return `${plural(count, 'further agent', 'further agents')}${tail} `
    + `${count === 1 ? 'is' : 'are'} also bound to this provider and will be restarted, `
    + `but ${count === 1 ? 'is' : 'are'} not shown here.`;
}

// The respawn prompt's lead sentence. Two shapes, because the all-hidden case is
// real (a shared, system-scoped credential whose only consumers belong to teams
// the caller is not in) and the counted-only wording is the honest one there.
export function boundAgentsLead(visibleCount, hidden) {
  const hiddenCount = (hidden && hidden.count) || 0;
  if (visibleCount === 0) {
    const where = hiddenWhere(hidden);
    const tail = where ? ` ${where}` : '';
    const one = hiddenCount === 1;
    return `${plural(hiddenCount, 'agent', 'agents')}${tail} `
      + `${one ? 'is' : 'are'} enabled and bound to this provider and will be restarted. `
      + `You do not have access to ${one ? 'it' : 'them'}, so ${one ? 'it is' : 'they are'} not listed.`;
  }
  return `The following ${visibleCount === 1 ? 'agent is' : `${visibleCount} agents are`} `
    + 'enabled and bound to this provider, and will be restarted:';
}

// The follow-up alert's lead when some agents could not be restarted. Hidden
// failures are counted, not named — but they are never silently dropped: an
// agent still running on a rotated-away credential is exactly what this alert
// exists to surface, whether or not the caller may see whose it is.
export function respawnFailureLead(failedCount, hiddenSkipped = 0) {
  const total = failedCount + hiddenSkipped;
  const base = `${plural(total, 'agent', 'agents')} could not be restarted — `
    + `if currently running, ${total === 1 ? 'it may' : 'they may'} still be using the old credentials`;
  if (hiddenSkipped === 0) return `${base}:`;
  if (failedCount === 0) {
    return `${base}. You do not have access to `
      + `${hiddenSkipped === 1 ? 'it' : 'them'}, so ${hiddenSkipped === 1 ? 'it is' : 'they are'} not listed.`;
  }
  return `${base}. ${hiddenSkipped} of them you do not have access to and cannot be listed:`;
}
