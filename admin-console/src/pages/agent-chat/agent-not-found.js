/**
 * Pure helpers for the "deep link to an unknown agent" notice (#2619).
 *
 * A `/chats/<id>` route naming an agent that is not in the viewer's roster
 * (deleted, typo, stale bookmark, or an agent of a team the viewer can't see)
 * is bounced to `/chats` by `AgentChat`'s redirect effect. The bounce used to
 * be silent — the user landed on the generic "Pick an agent" card with no hint
 * that the link they followed was dead. Now the redirect carries the requested
 * id in the router state and the empty state names it instead, consistent
 * with the "Linked message not found" notice for an unknown `?msg=` (#2310).
 *
 * The roster only lists agents the viewer may see, so "does not exist" and
 * "exists in a team you can't access" are indistinguishable here — and must
 * stay so: the copy deliberately says "not found or no access" so a shared
 * link never reveals whether an inaccessible agent exists.
 */

// Router-state key the redirect sets and the `/chats` empty state reads.
export const AGENT_NOT_FOUND_STATE_KEY = 'agentNotFoundId';

// A URL segment is attacker/typo-controlled; keep the echoed id readable.
export const MAX_ECHOED_ID_LENGTH = 80;

/** Router state for `navigate('/chats', { replace: true, state })`. */
export function agentNotFoundState(agentId) {
  return { [AGENT_NOT_FOUND_STATE_KEY]: agentId };
}

/** The requested id carried by the redirect, or null for any other state. */
export function agentNotFoundFrom(state) {
  const id = state && typeof state === 'object' ? state[AGENT_NOT_FOUND_STATE_KEY] : null;
  return typeof id === 'string' && id ? id : null;
}

/** Empty-state copy naming the unknown agent. */
export function agentNotFoundCopy(agentId) {
  const shown = agentId.length > MAX_ECHOED_ID_LENGTH
    ? `${agentId.slice(0, MAX_ECHOED_ID_LENGTH)}…`
    : agentId;
  return {
    title: `Agent "${shown}" not found`,
    hint: 'It may have been deleted, or you don\'t have access to it. Pick another agent on the left to start chatting.',
  };
}
