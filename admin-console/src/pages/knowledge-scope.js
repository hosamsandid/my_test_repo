// Pure helpers for the team-scoped Knowledge page (#560).
//
// The page shows exactly one team's knowledge at a time and loads a team's
// slice only after it has been selected. These helpers keep the selection /
// deep-link / header-count logic testable outside React.

// Extract the team id a deep link wants pre-selected. Accepts the canonical
// `?team=<id>` and the legacy `?scope=team:<id>`. Returns null when neither is
// present. `search` is a location.search string (with or without a leading '?')
// or a URLSearchParams instance.
export function parseTeamParam(search) {
  let params;
  if (search instanceof URLSearchParams) {
    params = search;
  } else {
    const s = typeof search === 'string' ? search : '';
    params = new URLSearchParams(s.startsWith('?') ? s.slice(1) : s);
  }
  const team = (params.get('team') || '').trim();
  if (team) return team;
  const scope = (params.get('scope') || '').trim();
  if (scope.startsWith('team:')) {
    const id = scope.slice('team:'.length).trim();
    if (id) return id;
  }
  return null;
}

// Resolve a wanted team id against the loaded team list. Returns the id only
// when it names a team that actually exists; otherwise null (→ the empty
// "choose a team" screen). A stale deep link therefore never selects a
// non-existent team, and a team deleted/renamed between loads falls back
// cleanly instead of erroring.
export function resolveSelectedTeam(wantedId, teams) {
  if (!wantedId || !Array.isArray(teams)) return null;
  return teams.some((t) => t && t.id === wantedId) ? wantedId : null;
}

// Header summary counts for a single team's loaded data slice. Scoped to the
// selected team only — never a cross-team sum.
export function teamTotals(teamData) {
  const c = teamData && teamData.graph && teamData.graph.counts;
  return {
    items: (c && c.items) || 0,
    today: (c && c.today) || 0,
    converged: (c && c.converged) || 0,
    skills: (c && c.skills) || 0,
    agents: (c && c.agents) || 0,
  };
}

// The SSE stream URL scoped to one team, or null when no team is selected (so
// useSSE opens no connection until there is a team in view).
export function streamScopeUrl(teamId) {
  if (!teamId) return null;
  return `/api/knowledge/stream?scope=team:${encodeURIComponent(teamId)}`;
}
