/**
 * Pure text for the D2 "this chat's agent vanished from the roster" inline
 * notice (#2311) — the live-roster poll now can remove the currently-open
 * chat's agent (pool reap, deletion from another tab, etc.) while the user is
 * looking at it. Per D2 the chat stays exactly where it is (transcript
 * preserved, no auto-navigate to the unrelated empty state) and gets this
 * notice instead. Kept as a pure module so the wording is unit-tested,
 * mirroring `stubSectionLabel`/`poolInstancesLabel` in `agent-list-model.js`.
 *
 * Deliberately generic ("removed or is no longer available") rather than
 * asserting a specific cause (pool-reaped vs. deleted by a teammate vs.
 * disabled elsewhere): a roster diff alone can't tell those apart, and a wrong
 * specific claim is worse than an honest general one.
 */
export function agentRemovedNoticeText(displayName) {
  const name = displayName ? `"${displayName}"` : 'This agent';
  return `${name} was removed or is no longer available. This conversation is preserved below, but the chat is no longer live.`;
}
