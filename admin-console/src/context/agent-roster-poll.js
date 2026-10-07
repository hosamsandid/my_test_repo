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

/**
 * When a polled snapshot was last known fresh, or `null` while it is (#566). A
 * poll paused in a hidden tab keeps showing its last response, which can be
 * minutes old by the time the tab is looked at again, and a consumer that reads
 * "nothing is running" off it against a clock that kept running would draw a
 * conclusion the data never supported. The timestamp lets it judge the
 * snapshot as of the moment it was taken instead. So:
 *
 *   - `'hidden'`: the tab went to the background — the snapshot starts aging
 *     now, or keeps the earlier moment if it was already aging (hide → show →
 *     hide before the refresh lands does not make old data look newer);
 *   - `'landed'`: a fetch settled (success OR error, so a failing refresh can
 *     never hold a consumer in "stale" forever) — fresh, unless it landed while
 *     the tab is still hidden, where it ages from now with no tick to replace it.
 *
 * @param {number|null} prevSince
 * @param {'hidden'|'landed'} event
 * @param {boolean} hidden  `document.hidden` at the event
 * @param {number} now      `Date.now()` at the event
 * @returns {number|null}
 */
export function nextSnapshotStaleSince(prevSince, event, hidden, now) {
  const prev = Number.isFinite(prevSince) ? prevSince : null;
  if (event === 'hidden') return prev ?? now;
  if (event === 'landed') return hidden ? now : null;
  return prev;
}
