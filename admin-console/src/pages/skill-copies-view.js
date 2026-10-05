// Pure view helper for the skill detail panel's "Copies & origin" tab (#2840),
// which replaced the former Lineage + Usage tabs. It shapes the lineage
// payload's `copies` (GET /api/skills/:name/lineage) into human-readable,
// team-grouped rows, explains every drift badge in plain language and writes
// the origin sentence. Kept pure (no React, no fetch) so it is unit-tested;
// SkillsRegistry.jsx renders the result.
//
// Team membership of an agent copy is the agent's `parentTeamId` (a `team`
// agent is its own team) — the same notion as the Install selector (#2836,
// skill-install-target-view.js). A copy's own `teamId` is the legacy access
// scope (e.g. `default`) and is deliberately NOT used for grouping. Team names
// come from the page's `teamNames` id→name map, falling back to the id.

export const NO_TEAM_LABEL = 'No team';
export const GLOBAL_POOL_LABEL = 'Global pool';
// The text filter is only offered once the list gets long (AC11).
export const COPIES_FILTER_THRESHOLD = 10;

// Detail tab ids. `lineage` / `usage` were the two tabs this one replaced;
// deep links and saved state naming them land on the merged tab (AC1).
export const COPIES_TAB_ID = 'copies';
const LEGACY_TAB_ALIASES = { lineage: COPIES_TAB_ID, usage: COPIES_TAB_ID };

export function resolveViewerTab(tab, tabIds = []) {
  const id = LEGACY_TAB_ALIASES[tab] || tab;
  return tabIds.includes(id) ? id : null;
}

// One plain-language sentence per drift state plus what (if anything) to do
// about it (AC9). Shown as the badge tooltip and in the tab's legend.
export const DRIFT_EXPLANATIONS = {
  'in-sync': {
    label: 'in sync',
    meaning: 'This copy matches the skill it was taken from.',
    action: 'Nothing to do.',
  },
  outdated: {
    label: 'outdated',
    meaning: 'The skill this copy was taken from has changed since; this copy has not been edited.',
    action: 'Use Update to bring it to the current version — nothing is lost.',
  },
  diverged: {
    label: 'diverged',
    meaning: 'This copy was edited locally; the skill it was taken from has not changed.',
    action: 'Keep it if the edits are wanted, or Overwrite to discard them.',
  },
  conflict: {
    label: 'conflict',
    meaning: 'Both this copy and the skill it was taken from have changed.',
    action: 'Compare the two and decide; Overwrite discards the local edits.',
  },
  orphaned: {
    label: 'orphaned',
    meaning: 'The skill this copy was taken from no longer exists.',
    action: 'The copy keeps working; nothing to do unless you want to remove it.',
  },
  unknown: {
    label: 'unknown',
    meaning: 'This copy predates version tracking, so it cannot be compared with the skill it was taken from.',
    action: 'Nothing to do; it cannot be updated automatically.',
  },
};

export const DRIFT_LEGEND_ORDER = ['in-sync', 'outdated', 'diverged', 'conflict', 'orphaned', 'unknown'];

// Tooltip text for a drift badge, or null for a state without a badge (AC10 —
// a copy with no drift information shows no badge at all).
export function driftTooltip(state) {
  const e = DRIFT_EXPLANATIONS[state];
  return e ? `${e.meaning} ${e.action}` : null;
}

const byText = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });

// agents: [{ id, displayName?, role?, parentTeamId? }] → Map id → agent.
export function indexAgents(agents) {
  const map = new Map();
  for (const a of Array.isArray(agents) ? agents : []) {
    if (a && typeof a.id === 'string' && a.id) map.set(a.id, a);
  }
  return map;
}

function agentTeamId(agent) {
  if (!agent) return null;
  if (typeof agent.parentTeamId === 'string' && agent.parentTeamId) return agent.parentTeamId;
  if (agent.role === 'team') return agent.id;
  return null;
}

function teamLabel(teamId, teamNames) {
  if (!teamId) return NO_TEAM_LABEL;
  return (teamNames && teamNames[teamId]) || teamId;
}

// The team an entry is grouped under: the team-pool copy's own team, an agent
// copy's agent team; null for the global copy and for unresolvable agents.
function copyTeamId(copy, agentsById) {
  if (copy.tier === 'team') return typeof copy.teamId === 'string' && copy.teamId ? copy.teamId : null;
  if (copy.tier === 'agent') return agentTeamId(agentsById.get(copy.agentId));
  return null;
}

// Turn the lineage `copies` into the grouped view (AC4–6, AC14–16):
//   { viewed: entry|null, groups: [{ key, kind, label, entries: [entry] }], total }
// entry = { key, copy, tier, teamId, teamLabel, label, secondary, title, viewed }.
// The viewed copy is pulled out and listed first; the rest are grouped:
// global pool, then one group per team (alphabetical by name; team-pool copy
// first, then agents alphabetical), then a final "No team" group. Every copy
// appears exactly once.
export function buildCopiesView(copies = [], { agents = [], teamNames = {} } = {}) {
  const agentsById = agents instanceof Map ? agents : indexAgents(agents);
  const names = teamNames && typeof teamNames === 'object' ? teamNames : {};
  const list = (Array.isArray(copies) ? copies : []).filter(c => c && typeof c === 'object' && c.tier);

  const entries = list.map((copy, i) => {
    const teamId = copyTeamId(copy, agentsById);
    const tLabel = teamLabel(teamId, names);
    const base = { key: `${copy.tier}:${copy.teamId ?? ''}:${copy.agentId ?? ''}:${i}`, copy, tier: copy.tier, teamId, teamLabel: tLabel, viewed: !!copy.viewed };
    if (copy.tier === 'global') {
      return { ...base, label: GLOBAL_POOL_LABEL, name: GLOBAL_POOL_LABEL, secondary: null, title: 'The global pool copy, available to every team' };
    }
    if (copy.tier === 'team') {
      return { ...base, label: `Team pool · ${tLabel}`, name: tLabel, secondary: teamId && tLabel !== teamId ? teamId : null, title: `The team pool copy of ${tLabel}` };
    }
    const agent = agentsById.get(copy.agentId);
    const display = (agent && agent.displayName) || copy.agentId || 'unknown agent';
    return {
      ...base,
      name: display,
      label: `${display} · ${tLabel}`,
      secondary: copy.agentId && copy.agentId !== display ? copy.agentId : null,
      title: `Agent ${display} (${copy.agentId}) in ${tLabel}`,
    };
  });

  // AC16: two agents of the same display name in the same team get their id
  // as a suffix (a different team already tells them apart via the label).
  const dupCount = new Map();
  for (const e of entries) {
    if (e.tier !== 'agent') continue;
    const k = `${e.teamId ?? ''}\u0000${e.name.toLocaleLowerCase()}`;
    dupCount.set(k, (dupCount.get(k) || 0) + 1);
  }
  for (const e of entries) {
    if (e.tier !== 'agent') continue;
    const k = `${e.teamId ?? ''}\u0000${e.name.toLocaleLowerCase()}`;
    if (dupCount.get(k) > 1 && e.copy.agentId && e.copy.agentId !== e.name) {
      e.label = `${e.name} (${e.copy.agentId}) · ${e.teamLabel}`;
    }
  }

  const viewed = entries.find(e => e.viewed) || null;
  const rest = entries.filter(e => e !== viewed);

  const global = rest.filter(e => e.tier === 'global');
  const teams = new Map();
  const noTeam = [];
  for (const e of rest) {
    if (e.tier === 'global') continue;
    if (!e.teamId) { noTeam.push(e); continue; }
    if (!teams.has(e.teamId)) teams.set(e.teamId, []);
    teams.get(e.teamId).push(e);
  }

  const sortEntries = arr => arr.sort((a, b) =>
    (a.tier === b.tier ? 0 : a.tier === 'team' ? -1 : b.tier === 'team' ? 1 : 0)
    || byText(a.name, b.name)
    || byText(a.copy.agentId || '', b.copy.agentId || ''));

  const groups = [];
  if (global.length) groups.push({ key: 'global', kind: 'global', label: GLOBAL_POOL_LABEL, entries: global });
  [...teams.entries()]
    .map(([teamId, arr]) => ({ key: `team:${teamId}`, kind: 'team', teamId, label: teamLabel(teamId, names), entries: sortEntries(arr) }))
    .sort((a, b) => byText(a.label, b.label) || byText(a.teamId, b.teamId))
    .forEach(g => groups.push(g));
  if (noTeam.length) groups.push({ key: 'no-team', kind: 'no-team', label: NO_TEAM_LABEL, entries: sortEntries(noTeam) });

  return { viewed, groups, total: entries.length };
}

// Text filter over team name, agent display name and agent id (AC11). Keeps
// the group structure; a group whose own label matches keeps all entries;
// empty groups are dropped. A blank query returns the groups unchanged.
export function filterCopyGroups(groups = [], query = '') {
  const q = String(query || '').trim().toLocaleLowerCase();
  if (!q) return groups;
  const hit = s => typeof s === 'string' && s.toLocaleLowerCase().includes(q);
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const entries = hit(g.label) ? g.entries : g.entries.filter(e =>
      hit(e.label) || hit(e.name) || hit(e.teamLabel) || hit(e.copy.agentId) || hit(e.teamId));
    if (entries.length) out.push({ ...g, entries });
  }
  return out;
}

export function shouldOfferCopyFilter(total) {
  return Number.isInteger(total) && total > COPIES_FILTER_THRESHOLD;
}

// The plain-language origin sentence (AC2/AC17), as segments so the JSX can
// emphasise names: [{ text, strong? }]. `sourceGone` appends the "no longer
// exists" note. null origin → hand-authored.
export function describeOrigin(origin, { agents = [], teamNames = {}, sourceGone = false } = {}) {
  if (!origin || typeof origin !== 'object' || !origin.tier) {
    return [{ text: 'No recorded origin (hand-authored).' }];
  }
  const agentsById = agents instanceof Map ? agents : indexAgents(agents);
  const names = teamNames && typeof teamNames === 'object' ? teamNames : {};
  const parts = [];
  if (origin.tier === 'global') {
    parts.push({ text: 'Taken from the ' }, { text: 'global pool', strong: true });
  } else if (origin.tier === 'team') {
    parts.push({ text: 'Taken from the team pool of ' }, { text: teamLabel(origin.teamId, names), strong: true });
  } else if (origin.tier === 'agent') {
    const agent = agentsById.get(origin.agentId);
    parts.push({ text: 'Taken from agent ' }, { text: (agent && agent.displayName) || origin.agentId || 'unknown agent', strong: true });
    const tId = agentTeamId(agent);
    if (tId) parts.push({ text: ' (team ' }, { text: teamLabel(tId, names), strong: true }, { text: ')' });
  } else if (origin.tier === 'external') {
    parts.push({ text: 'Imported from a file' });
  } else {
    parts.push({ text: `Taken from ${origin.tier}` });
  }
  if (origin.action) parts.push({ text: ` by ${origin.action}` });
  const hash = typeof origin.sourceHash === 'string' ? origin.sourceHash.slice(0, 6) : '';
  const version = Number.isInteger(origin.sourceVersion) ? `v${origin.sourceVersion}` : '';
  const ver = [version, hash].filter(Boolean).join(' · ');
  if (ver) parts.push({ text: ', version ' }, { text: ver, mono: true });
  if (sourceGone) parts.push({ text: ' — this source no longer exists' });
  parts.push({ text: '.' });
  return parts;
}

// "Lives in N places — 1 global, 0 team, 21 agent." (AC3).
export function copiesSummaryText(summary) {
  if (!summary || !Number.isInteger(summary.total)) return null;
  const t = summary.byTier || {};
  return `Lives in ${summary.total} place${summary.total === 1 ? '' : 's'} — ${t.global || 0} global, ${t.team || 0} team, ${t.agent || 0} agent.`;
}
