'use strict';

// The materialization preference of `POST /api/agents/:teamId/members` (#1958).
//
// Adding a member to a live team always materialized it — Matrix user, clone,
// container — because the route never passed a preference and the orchestrator's
// default (`opts.materialize === false` is the only stub trigger) therefore
// always won. This module is the route's half of the choice.
//
// It is a pure function rather than three lines inline because the route has two
// surviving body shapes (free-form pass-through and `templateId`) that reach the
// orchestrator by different paths, and AC5 — "defaults to materializing when it
// is absent, so existing API callers are unaffected" — is a property of the
// parse, not something to eyeball twice in a 100-line handler.
//
// Naming: the wire key is `materialize`, matching `addTeamMember`'s `opts` and
// `buildMemberFromTemplate`'s parameter. The team-create routes spell their
// (plural, whole-team) equivalent `materializeMembers`; a single member is not
// that, so the two names stay distinct on purpose.

/**
 * Read the materialization preference off a member-create request body.
 *
 * Absent (`undefined`, including a body-less POST) means **materialize now** —
 * the behaviour every caller had before this ticket. Anything present but not a
 * boolean is a client error, not a silent fallback: a caller that sends
 * `"false"` or `0` believes it is deferring, and quietly cloning a repository
 * for it is the exact failure this ticket exists to remove. `null` counts as
 * present-and-wrong for the same reason.
 *
 * @param {object} [body] the parsed request body (may be missing entirely)
 * @returns {{materialize: boolean}|{error: string}}
 */
function parseMemberMaterialize(body) {
  const raw = (body || {}).materialize;
  if (raw === undefined) return { materialize: true };
  if (typeof raw !== 'boolean') {
    return { error: '`materialize` must be a boolean (omit it to materialize now)' };
  }
  return { materialize: raw };
}

module.exports = { parseMemberMaterialize };
