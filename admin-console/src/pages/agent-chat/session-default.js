// Pure helpers for "show the most recent finished session by default" (#910).
//
// The Sessions tab used to fall back to a "No active sessions." empty state the
// moment a run ended, hiding the log you most likely wanted to read. It now
// defaults to the newest finished session whenever nothing is active. Two rules
// carry that behaviour, and both are pure so they are unit-testable without the
// JSX (SessionsPanel does the IO):
//
//   1. which finished session is on screen (auto-default vs. explicit pick), and
//   2. how much finished-session history has to be loaded to resolve rule 1.
//
// The distinction between an *auto-default* and an *explicitly picked* session
// (`pinned`) is what keeps the pre-existing "jumps to live when a new session
// opens" behaviour intact without yanking a user out of a session they chose to
// read (Open Question 1 → auto-switch only from the auto-default).

// Finished-session slice loaded while the "Finished sessions" control is
// collapsed. Resolving "the most recent" only needs the newest entry, so a
// handful is plenty — the full page is fetched once the control is expanded (or
// while an explicit selection is being viewed, so it can't scroll out of the
// loaded slice).
export const IDLE_HISTORY_LIMIT = 5;

// `GET .../sessions/history` is newest-first (buildSessionHistory sorts by
// endedAt desc), so the head of the list is the session that ended last.
export function latestFinishedId(history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const first = history[0];
  return (first && first.id) || null;
}

/**
 * The finished session that should be on screen.
 *
 * - `pinned` (user picked one from the dropdown, or a #642 deep-link
 *   preselected one) → never overridden; the caller keeps showing it.
 * - an active session exists → nothing historical; the live session takes over
 *   (AC3, and the pre-#910 behaviour from the idle state).
 * - otherwise → the most recently finished session, which also means the view
 *   tracks the *newest* finished session as runs end (AC4/AC5), and stays
 *   `null` (idle empty state) when there is no finished session at all (AC2).
 *
 * @param {object}  o
 * @param {boolean} o.pinned      an explicit selection is being viewed
 * @param {boolean} o.hasActive   at least one session is currently running
 * @param {Array}   o.history     finished sessions, newest-first
 * @param {?string} o.current     currently viewed finished-session id
 * @returns {?string} the finished-session id to show, or null for none
 */
export function resolveHistoricalId({
  pinned = false, hasActive = false, history = [], current = null,
} = {}) {
  if (pinned) return current;
  if (hasActive) return null;
  return latestFinishedId(history);
}

/**
 * How many finished sessions to request.
 *
 * A collapsed, auto-defaulting panel only needs the newest slice; the full page
 * is needed once the dropdown is expanded (it lists them all) or while an
 * explicit selection is being viewed — an entry outside the loaded slice would
 * otherwise vanish from the view when the list refreshes.
 */
export function historyFetchLimit({
  historyOpen = false, pinned = false, fullLimit = 100, idleLimit = IDLE_HISTORY_LIMIT,
} = {}) {
  return (historyOpen || pinned) ? fullLimit : Math.min(idleLimit, fullLimit);
}
