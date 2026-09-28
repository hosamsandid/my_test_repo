// Arriving in Agent Chat to reveal a just-created agent (#2521).
//
// The Flow Editor's Create-team confirmation navigates to `/chats/<agentId>`
// with router state `{ revealAgentId }`. That state asks this page for two
// things an ordinary deep link does not get:
//
//   1. Patience. The roster refreshes in the background (#2311), so the new
//      team may not be in the first payload. A normal deep link to an unknown
//      id is bounced to `/chats` at once; a reveal target is waited for (with
//      explicit refetches) for a bounded time instead, so the right agent is
//      selected once it appears rather than the page silently falling back to
//      another one. Past the bound it falls back exactly like a bad deep link
//      (the `/chats` overview) — never an error page.
//   2. Visibility. The target's row must be on screen without manual search or
//      scrolling: a persisted list filter that hides it is dropped, its team
//      group and (for a not-yet-provisioned member) its stub section are
//      expanded, and the row scrolls itself into view.
//
// Pure decisions only; the component wiring lives in AgentChat/AgentList.

import { matchesFilter } from './agent-list-model.js';

/** How long a reveal target is waited for before falling back to `/chats`. */
export const REVEAL_WAIT_MS = 20000;
/** How often the roster is re-fetched while waiting for a reveal target. */
export const REVEAL_RETRY_MS = 2000;

/**
 * The agent id the router state asks to reveal, if it is the one routed to.
 * State that names a different id (stale history entry) is ignored.
 *
 * @param {unknown} locationState  `useLocation().state`
 * @param {string|undefined} agentId  the `:agentId` route param
 * @returns {string|null}
 */
export function revealTargetFrom(locationState, agentId) {
  const id = locationState && typeof locationState === 'object' ? locationState.revealAgentId : null;
  if (typeof id !== 'string' || !id || id !== agentId) return null;
  return id;
}

/**
 * Should the page keep waiting for the reveal target (and suppress the
 * unknown-id bounce to `/chats`)?
 *
 * @param {string|null} revealId
 * @param {Array<{id:string}>|null} agents  current roster (null while loading)
 * @param {string|null} expiredFor  the reveal id whose wait already timed out
 */
export function isAwaitingReveal(revealId, agents, expiredFor) {
  if (!revealId || expiredFor === revealId) return false;
  return !(agents || []).some(a => a.id === revealId);
}

/**
 * What to change so the target's row is visible in the left list.
 *
 * @param {object|null} agent  the target's roster row
 * @param {object} filter      the list filter (`{kind:'all'|'team'|'agent', id?}`)
 * @returns {{resetFilter: boolean, groupKey: string|null}}
 *   `resetFilter` — the current filter hides the row, so drop it to "all";
 *   `groupKey` — the team group (`team:<id>`, `groupKey`'s namespace) to expand.
 */
export function revealPlan(agent, filter) {
  if (!agent) return { resetFilter: false, groupKey: null };
  return {
    resetFilter: !matchesFilter(agent, filter),
    groupKey: agent.parentTeamId ? `team:${agent.parentTeamId}` : null,
  };
}

/**
 * The chat pane's empty-state copy while no chat can be shown for the route.
 * `null` keeps the ordinary "pick an agent" card.
 *
 * @param {{waiting?: boolean, stubAgent?: {id:string, displayName?:string}|null}} o
 *   `waiting` — a reveal target is still awaited in the roster;
 *   `stubAgent` — the routed agent is a not-yet-provisioned stub (AC6): it is
 *   shown in its normal "Not initialised" state, with no chat to open and no error.
 * @returns {{title: string, hint: string}|null}
 */
export function revealEmptyStateCopy({ waiting = false, stubAgent = null } = {}) {
  if (waiting) {
    return {
      title: 'Opening your new team…',
      hint: 'Its agents appear in the list as soon as the team has finished loading.',
    };
  }
  if (stubAgent) {
    const name = stubAgent.displayName || stubAgent.id;
    return {
      title: `${name} is not initialised yet`,
      hint: 'Open its menu in the list and choose Materialize to start chatting with it.',
    };
  }
  return null;
}
