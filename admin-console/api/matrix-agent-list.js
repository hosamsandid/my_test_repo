'use strict';

// Who gets into the chat's agent list — the admission rule of
// `GET /api/matrix/agents` (#1957, epic #1925).
//
// The route used to inline three `continue`s. Two of them (`enabled === false`
// unless `includeDisabled`, and `!cfg.token` unconditionally) are the reason a
// **stub** team member could not be shown in Agent Chat at all: a stub is
// config only — no Matrix user, hence no token, hence dropped before the
// disabled check ever mattered. #1957 adds a third opt-in for exactly that
// case, and pulling the rule out of the route is what makes it assertable:
// "the default response is unchanged for every other consumer" (AC8) is a
// property of this function, not something to eyeball in a 30-line loop.
//
// Visibility scoping (#302) stays in the route — it needs the caller's scope,
// which is not a property of the config.

/**
 * Is this config a **stub team member** — a member that exists as configuration
 * and triggers only, never provisioned (no Matrix user, no workspace, no
 * container)?
 *
 * Deliberately narrower than the shared client-side `agentState() === 'stub'`:
 * that predicate answers "never provisioned" for *any* role, while the chat
 * list only ever shows stubs that have a team group to sit in. A stub
 * bp-instance (an orchestrator writes one per Briefing Pack, so there can be
 * dozens) and a parentless stub have no such home, so they stay out — matching
 * the ticket's scope, and keeping the invariant the rail's grouping relies on:
 * **every stub in this payload carries a `parentTeamId`**, so none can ever
 * fall through to the orphan/"Single agents" bucket.
 */
function isStubMember(cfg) {
  return !!cfg
    && !cfg.token
    && cfg.enabled === false
    && cfg.role === 'team-member'
    && !!cfg.parentTeamId;
}

/**
 * Should this agent config appear in the chat's list?
 *
 * @param {object} cfg                     the agent's `config.json`
 * @param {boolean} o.includeDisabled      `?includeDisabled=1` — also list
 *                                         *paused* agents (#1928, decision D2)
 * @param {boolean} o.includeStubs         `?includeStubs=1` — also list stub
 *                                         team members (#1957)
 * @returns {boolean}
 */
function admitsToChatList(cfg, { includeDisabled = false, includeStubs = false } = {}) {
  if (!cfg) return false;

  // A stub is admitted (or not) *only* by its own opt-in: `stub` and `paused`
  // are different states and stay independently switchable, which is what keeps
  // them distinguishable in the rail. In particular a stub is not "a disabled
  // agent" for the purposes of `includeDisabled` — it is disabled by
  // definition, so folding it into that opt-in would make the disabled filter
  // silently mean two things.
  if (isStubMember(cfg)) return includeStubs;

  if (cfg.enabled === false && !includeDisabled) return false;
  // Any other tokenless agent has no chat identity to list and no section to
  // show it in — unchanged from before #1957.
  if (!cfg.token) return false;
  return true;
}

module.exports = { isStubMember, admitsToChatList };
