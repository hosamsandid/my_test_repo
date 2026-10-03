'use strict';

// Which agent configs are ROLES of a live team's flow (#2814) — the one filter
// the three live graph builders in api.js share: `GET /api/process/graph`,
// `GET /api/flows/graph` and the live export `GET /api/process/template`
// (which "Edit as draft" also reads).
//
// Left out:
//   - the team agent itself (`role: 'team'`) — a template holder with no
//     triggers of its own;
//   - an auto-scaled pool instance (`poolInstance: true`) — temporary capacity
//     of its `poolOf` role, not a role. Rendering it gave the canvas a second
//     node with a copy of every inbound edge, and the export a phantom role.
//     Filtered by the config flag, never by id shape: a hand-created member
//     whose id merely ends in `-i3` is still a role (same rule as #2585);
//   - with a `team` scope, anything outside that team.
//
// Pure: takes the parsed config.json (or `{}` when unreadable).

function isLiveGraphMember(cfg, team = null) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  if ((c.role || 'agent') === 'team') return false;
  if (c.poolInstance === true) return false;
  if (team && c.parentTeamId !== team) return false;
  return true;
}

module.exports = { isLiveGraphMember };
