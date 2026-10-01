// Shared helper for the step library: locating the Agent Chat left rail
// (`AgentList.jsx`) and its rows. Single source so agents.js, access.js and
// team-config.js never diverge on the rail's ARIA structure.
//
// Since #2704 the rail is a `list` named "Agents" (no longer a `listbox`): each
// team is a `listitem` holding its header row and a nested `list` of member
// rows. Every row — team header or agent — is a `listitem` whose MAIN control
// is a plain `<button>` whose accessible name starts with the row's label; the
// kebab ("Actions for <label>" / "Team actions for <label>") and the chevron
// ("Expand <label>" / "Collapse <label>") are sibling buttons whose names
// start with a verb instead, so anchoring the name at the label picks the main
// button alone.

// The rail itself. Named, so it is unambiguous on the page — the filter
// `<select>`'s native options and the composer's slash-command `listbox` are
// different roles entirely.
function agentRail(page) {
  return page.getByRole('list', { name: 'Agents', exact: true });
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The main select button of the row labelled `label` (an agent's
// `displayName || id`, or a team's display name). The name is anchored at the
// start only: a row's name also carries its environment line / state badge
// (agent) or membership line (team header).
function railRowButton(rail, label) {
  return rail.getByRole('button', { name: new RegExp(`^${escapeRegExp(label)}`) });
}

module.exports = { agentRail, railRowButton };
