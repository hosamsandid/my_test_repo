// The "current team" shared across pages (#2850): the Agent Team the user most
// recently worked with — by selecting one of its agents (or the team entry
// itself) in Agent Chat, or by picking it in Flow Control's team picker.
// Flow Control opens on it, so switching between the two pages keeps the
// team context instead of jumping back to the first team in the list.
//
// One localStorage record per user; whichever page wrote last wins. Pure
// helpers only — the pages own the side effects (when to read and write).

const CURRENT_TEAM_PREFIX = 'aee.currentTeam.';

// Per-username key, matching `flowControl.autoRefresh.<username>`; a missing
// username (the env single-admin) falls back to a shared `anon` bucket.
export function currentTeamKey(username) {
  return `${CURRENT_TEAM_PREFIX}${username || 'anon'}`;
}

function resolveStore(store) {
  if (store) return store;
  return typeof window !== 'undefined' ? window.localStorage : null;
}

// The team an Agent Chat subject belongs to: a team entry is its own team, a
// member (pool instances included) its `parentTeamId`; anything else — a
// standalone agent, a missing row — belongs to no team (`null`).
export function teamIdOfAgent(agent) {
  if (!agent || typeof agent !== 'object') return null;
  if (agent.role === 'team') return typeof agent.id === 'string' && agent.id ? agent.id : null;
  return typeof agent.parentTeamId === 'string' && agent.parentTeamId ? agent.parentTeamId : null;
}

// `''` when nothing is remembered or storage is unavailable.
export function readCurrentTeam(username, store) {
  const ls = resolveStore(store);
  if (!ls) return '';
  try {
    const v = ls.getItem(currentTeamKey(username));
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

// A falsy team id is ignored: an agent outside any team does not clear the
// current team (#2850 AC3).
export function writeCurrentTeam(username, teamId, store) {
  if (typeof teamId !== 'string' || !teamId) return;
  const ls = resolveStore(store);
  if (!ls) return;
  try {
    ls.setItem(currentTeamKey(username), teamId);
  } catch {
    /* ignore — the worst case is the default team next visit */
  }
}

// Which team Flow Control shows: an explicit `?team=` first, then the
// remembered team, then the first team in the list. A URL or remembered id
// that is not in `teams` (deleted, or not visible to this user) is skipped
// without an error. `''` while there is no team to show (list still loading,
// or no team exists) — the page must not fetch a board for it.
export function resolveFlowControlTeam({ urlTeam, rememberedTeam, teams } = {}) {
  const list = Array.isArray(teams) ? teams : [];
  if (list.length === 0) return '';
  const known = (id) => typeof id === 'string' && id !== '' && list.some((t) => t && t.id === id);
  if (known(urlTeam)) return urlTeam;
  if (known(rememberedTeam)) return rememberedTeam;
  return list[0].id;
}
