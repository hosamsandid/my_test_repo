/**
 * Pure scheduling decisions for the Agent Chat roster poll (#2311 D5).
 *
 * Kept separate from `AgentRosterContext.jsx`'s `setInterval`/
 * `document.visibilitychange` wiring so the pause-while-hidden /
 * refresh-on-visible behavior is unit-testable without mocking the DOM.
 */

/** Whether a regular interval tick should actually issue a fetch. */
export function shouldTickPoll(hidden) {
  return !hidden;
}

/**
 * Whether a `visibilitychange` transition should trigger one immediate
 * out-of-band refresh (on top of resuming the normal interval): only the
 * hidden → visible edge does, matching D5 ("pause while hidden, one immediate
 * refresh on becoming visible again") — a visible → hidden transition, or two
 * events that don't actually flip the flag, refresh nothing.
 */
export function shouldRefreshOnVisible(prevHidden, nextHidden) {
  return prevHidden === true && nextHidden === false;
}

/**
 * Whether a roster response must be dropped because a fetch issued AFTER it
 * has already been applied (#2705). The 5 s poll and an explicit `refetch()`
 * overlap freely; a slow poll that left before a mutation (e.g. a Materialize
 * flipping `enabled`) can land after the refetch that followed it, and applying
 * it would roll the row back to its pre-mutation state for one poll cycle.
 *
 * @param {number} seq         the response's request sequence number
 * @param {number} appliedSeq  the sequence number of the newest applied response
 */
export function isStaleRosterResponse(seq, appliedSeq) {
  return seq < appliedSeq;
}
