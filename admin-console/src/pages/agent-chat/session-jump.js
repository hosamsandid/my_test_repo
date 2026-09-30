// Pure helpers for "Show in session log" (#2603): jump from a chat message to
// the session log rows of the run that produced it.
//
// The chat button hands a request to the Sessions tab, which reuses the #642
// selection path (`selectRequest` → active sub-tab or finished-session group)
// and then asks the embedded SessionLogPanel to scroll to the run's first row
// and flash all of its rows. Everything deterministic lives here so it is
// unit-testable without the JSX (#651); the panels are thin adapters.

import { HOVER_SCOPE_ATTR, HOVER_ROW_ATTR, cssEscapeAttrValue } from './hover-highlight.js';

export const SHOW_IN_SESSION_LABEL = 'Show in session log';

// How long the jump flash stays on the log rows. Matches the chat's `?msg=`
// flash (#2310) so the two feel the same.
export const JUMP_HIGHLIGHT_MS = 1700;

/**
 * What identifies the session behind one chat message, or null when the
 * message gets no "Show in session log" button (AC1/AC2).
 *
 * - `{ correlationId }` when the message names its run itself: a user message
 *   (its own event id is the run's correlationId) or a trigger notice that
 *   carries `io.aee.trigger.correlationId`.
 * - `{ eventId }` for an agent reply: the run is looked up server-side from the
 *   runner's `message.posted` row, because the client can't tell which run a
 *   reply belongs to when a user message arrived while a triggered run was
 *   going.
 *
 * No button for unconfirmed messages (optimistic / thinking — no stable event
 * id yet), transcript separators, loop-record cards, and trigger notices
 * posted before the notice carried its correlationId.
 */
export function sessionJumpRef(message, agentUserId) {
  if (!message || typeof message !== 'object') return null;
  const eventId = typeof message.event_id === 'string' ? message.event_id : '';
  if (!eventId || message.isOptimistic || message.type) return null;
  if (message['io.aee.loop-record']) return null;
  const trigger = message['io.aee.trigger'];
  if (message.msgtype === 'm.notice' && trigger) {
    const cid = trigger && typeof trigger.correlationId === 'string' ? trigger.correlationId : '';
    return cid ? { correlationId: cid } : null;
  }
  if (agentUserId && message.sender === agentUserId) return { eventId };
  return { correlationId: eventId };
}

/**
 * The Sessions-tab selection request for a jump. Same shape the #642 deep-link
 * uses (`correlationId` + `ts`), plus `eventId` when the run still has to be
 * resolved, `reveal` (scroll to + flash the rows) and `source` (which notice
 * text to show if the session can't be found). `ts` makes a repeat click on
 * the same message a new request.
 */
export function buildSessionJumpRequest(ref, ts) {
  if (!ref) return null;
  const correlationId = typeof ref.correlationId === 'string' && ref.correlationId ? ref.correlationId : null;
  const eventId = typeof ref.eventId === 'string' && ref.eventId ? ref.eventId : null;
  if (!correlationId && !eventId) return null;
  return { correlationId, eventId, reveal: true, source: 'message', ts };
}

/**
 * Key of the first rendered log row of `correlationId` — the scroll target
 * (AC4: `message.received` for a user message, the run's opening row for a
 * reply). Null when no row of that run is loaded.
 */
export function firstRowKeyForCorrelation(rows, correlationId, keyOf) {
  if (!correlationId || !Array.isArray(rows)) return null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row && row.correlationId === correlationId) return keyOf(row, i);
  }
  return null;
}

/**
 * Where a jump stands once the log has loaded:
 * - 'pending'  still loading, keep waiting;
 * - 'found'    a row of the run is loaded, scroll to it;
 * - 'missing'  the load finished without a row of the run (outside the loaded
 *   window, or the log was truncated/reset) → show the not-found notice rather
 *   than leave the user on a session that doesn't show the message (AC6).
 */
export function revealStatus({ loading, rows, correlationId, keyOf }) {
  if (loading) return 'pending';
  return firstRowKeyForCorrelation(rows, correlationId, keyOf) ? 'found' : 'missing';
}

/**
 * The one-shot flash on every row of the run (AC4). CSS-driven like the hover
 * dim (#1676): the rows are matched by their existing `data-cid`, so the flash
 * never re-renders the log. Also lifts the rows out of an active hover dim so
 * the flash is visible without hovering.
 */
export function jumpHighlightCss(scope, correlationId) {
  if (!correlationId) return '';
  const s = `[${HOVER_SCOPE_ATTR}="${cssEscapeAttrValue(scope)}"]`;
  const cid = cssEscapeAttrValue(correlationId);
  return (
    `@keyframes sessionJumpFlash{`
    + `0%{background-color:var(--eb-accent-muted);box-shadow:inset 3px 0 0 var(--eb-accent-primary);}`
    + `70%{background-color:var(--eb-accent-muted);box-shadow:inset 3px 0 0 var(--eb-accent-primary);}`
    + `100%{background-color:transparent;box-shadow:inset 3px 0 0 transparent;}}`
    + `${s} [${HOVER_ROW_ATTR}="${cid}"]{animation:sessionJumpFlash ${JUMP_HIGHLIGHT_MS}ms ease-out;opacity:1;}`
  );
}

/** Text of the Sessions tab's non-blocking "not found" notice, per source. */
export function sessionNotFoundText(source) {
  if (source === 'message') {
    return "Couldn't find this message in the session logs — it may be older "
      + 'than the retained history, or its log was pruned or reset.';
  }
  return "Couldn't locate the session this event triggered — it may be older "
    + 'than the retained history, its log may have been pruned, or the agent '
    + 'has no chat room yet.';
}
