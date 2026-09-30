// Decisions behind the "Materialize now" checkbox in the flow editor's
// "Add agent" dialog on a LIVE team (#2558).
//
// That dialog used to post to `/api/agents/:teamId/members` without a
// `materialize` key, so every agent sketched into a live team was provisioned
// on the spot — Matrix user, workspace seed, clone, container — which takes
// minutes and pulls the user out of the flow. The stub path already exists end
// to end (#1958: `addTeamMember`'s stub branch, Agent Chat's "Not materialized
// yet" section and its Materialize entry); this module only exposes it here.
//
// The label, hint, request shape and success notice are REUSED from the Agent
// Chat rail's "Add member" dialog (`agent-chat/add-member-view.js`) — it is the
// closest single-agent surface, so the two cannot drift apart. The one
// deliberate divergence is the default (see below).
//
// Pure and dependency-free per the #651 convention; the JSX that renders it is
// covered by the source-reading guard in `add-role-materialize-wiring.test.js`.

import {
  MATERIALIZE_NOW_HINT, MATERIALIZE_NOW_LABEL, addMemberBody, addMemberNotice,
} from '../agent-chat/add-member-view.js';

export { MATERIALIZE_NOW_HINT as ADD_ROLE_MATERIALIZE_HINT, MATERIALIZE_NOW_LABEL as ADD_ROLE_MATERIALIZE_LABEL };

/**
 * Default state of the checkbox: OFF. Unlike the rail "Add member" dialog and
 * the team-create wizard (both default ON), this dialog is where a team's
 * composition is iterated on, one role after another — so adding stays fast
 * and provisioning is an explicit opt-in (#2558 AC2, confirmed by the issue
 * author). Do not "align" it with the other two.
 */
export const ADD_ROLE_MATERIALIZE_DEFAULT = false;

/**
 * The materialization part of the POST body. Always explicit, like
 * `addMemberBody`: the backend default is materialize-now, so omitting the key
 * would silently undo this dialog's default.
 */
export function addRoleMaterializeBody({ materializeNow = ADD_ROLE_MATERIALIZE_DEFAULT } = {}) {
  return addMemberBody({ materializeNow: materializeNow === true });
}

/** Primary-button label — the deferred mode says so on the button, as in the rail dialog. */
export function addRoleSubmitLabel({ busy, materializeNow, live } = {}) {
  if (busy) return 'Adding…';
  if (!live) return 'Add agent';
  return materializeNow === true ? 'Add agent' : 'Add agent (stub)';
}

/**
 * Post-create notice, read from the mode the SERVER reports (`materialized:
 * false` on a stub; absent on the materializing branch) — never from what was
 * requested (#2558 AC6). Same wording as the rail dialog.
 */
export function addRoleNotice(result) {
  return addMemberNotice(result);
}
