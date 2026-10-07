'use strict';

/*
 * Pure decision core for #2691: when an Agent Team is deleted, drop its id from
 * every TEAM-scoped Model Provider's team set. The #2360 clone/reuse auto-append
 * (ensureTeamOnEnvProvider in api.js) adds a team to the env provider's
 * `teamIds` but nothing removed it again, so the deleted team kept showing as a
 * provider owner. Kept pure/fs-free (the #651 convention): api.js reads and
 * writes the registry, this module only decides.
 *
 * A provider must never become ownerless. When the deleted team is a
 * provider's ONLY team, the provider is left untouched and reported in `kept`
 * — that is the team's own provider, not an auto-append, and it may still be
 * bound to an environment (DELETE /api/llm-endpoints refuses in-use providers),
 * so refusing the team delete instead could dead-lock the cleanup. The Models
 * page labels such an id "deleted team" so a System Admin can reassign it.
 */

// The agent-team set a team provider serves — mirrors providerTeamSet in api.js
// (`teamIds`, falling back to the legacy single `teamId`).
function teamSetOf(ep) {
  if (!ep || ep.scope !== 'team') return [];
  return Array.isArray(ep.teamIds) && ep.teamIds.length
    ? ep.teamIds.map(String)
    : (ep.teamId ? [String(ep.teamId)] : []);
}

// Returns `{ list, pruned, kept }`: `list` is a NEW registry array (unchanged
// entries are passed through by reference), `pruned` the ids of providers the
// team was removed from, `kept` the ids of providers it is the sole owner of.
// `pruned.length === 0` means there is nothing to save.
function pruneTeamFromProviders(list, teamId) {
  const id = teamId == null ? '' : String(teamId);
  const pruned = [];
  const kept = [];
  if (!id || !Array.isArray(list)) return { list: Array.isArray(list) ? list : [], pruned, kept };
  const next = list.map((ep) => {
    const set = teamSetOf(ep);
    if (!set.includes(id)) return ep;
    const rest = set.filter(t => t !== id);
    if (!rest.length) {
      kept.push(ep.id);
      return ep;
    }
    pruned.push(ep.id);
    const out = { ...ep, teamIds: rest };
    // The legacy single `teamId` is the provider's primary owner; re-point it
    // when it named the deleted team so it never dangles either.
    if (!out.teamId || String(out.teamId) === id) out.teamId = rest[0];
    return out;
  });
  return { list: next, pruned, kept };
}

module.exports = { pruneTeamFromProviders };
