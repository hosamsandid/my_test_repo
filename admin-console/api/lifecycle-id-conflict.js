'use strict';

// lifecycle-id-conflict.js — the id-conflict answer for Clone and Import
// (#2684), kept pure so it is testable without the express app.
//
// A clone/import with no target team is folded into a team of one by the
// orchestrator (`teamOfOneIdConflict`), and that team claims the derived
// `<id>-team`. So for those two an id is only free when both are, and the 409
// names a suggestion that is free by that same rule — the `suggestedId` the
// create route already answers with (#2218).

const { suggestFreeAgentId } = require('./agent-id-resolution');

// exists(id) — is there already an agent dir for this id?
function lifecycleIdTaken(id, standalone, exists) {
  return exists(id) || (standalone && exists(`${id}-team`));
}

// Returns the 409 body, or null when `id` is free. `what` finishes the
// sentence ("… choose a different id<what>.").
function lifecycleIdConflict(id, { standalone, exists, what = '' }) {
  if (!lifecycleIdTaken(id, standalone, exists)) return null;
  let suggestedId;
  try {
    suggestedId = suggestFreeAgentId(id, (c) => lifecycleIdTaken(c, standalone, exists));
  } catch { /* id-sequence-exhausted — omit the suggestion, not the refusal */ }
  const reason = exists(id)
    ? `Agent '${id}' already exists`
    : `Agent '${id}' would get the team '${id}-team', which already exists`;
  return {
    error: `${reason} — choose a different id${what}.`,
    code: 'id-conflict',
    agentId: id,
    ...(suggestedId ? { suggestedId } : {}),
  };
}

module.exports = { lifecycleIdTaken, lifecycleIdConflict };
