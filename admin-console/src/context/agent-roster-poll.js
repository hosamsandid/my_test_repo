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
