// Pure option logic for the EnvironmentOwnership control (#2695, #651).
//
// A `<select>` whose `value` matches none of its options does not show an
// error: the browser silently displays the FIRST option instead. That is how an
// environment owned by an Agent Team read "Default Team" in the picker while the
// preview beneath it said "Team · agent-studio-2-0" — and any change then wrote
// the wrong team. So the current value is always rendered as its own option,
// marked, rather than being masked by a neighbour.

// The label for an id that is not among the offered teams.
export function unknownTeamLabel(id) {
  return `${id} (not an Agent Team)`;
}

// `options` plus the current `teamId` as its own entry when it is not among
// them. An empty id adds nothing (the control renders a placeholder for that).
export function teamOptionsWithCurrent(options, teamId) {
  const list = Array.isArray(options) ? options.filter(t => t && t.id) : [];
  if (!teamId || list.some(t => t.id === teamId)) return list;
  return [...list, { id: teamId, name: unknownTeamLabel(teamId), unknown: true }];
}

// `options` plus every assigned id that is not among them, so a shared record
// assigned to a team the list no longer offers still shows a checked box the
// operator can clear — instead of an invisible assignment Save would keep.
export function teamOptionsWithAssigned(options, assignedTeamIds) {
  let list = Array.isArray(options) ? options.filter(t => t && t.id) : [];
  for (const id of Array.isArray(assignedTeamIds) ? assignedTeamIds : []) {
    list = teamOptionsWithCurrent(list, id);
  }
  return list;
}
