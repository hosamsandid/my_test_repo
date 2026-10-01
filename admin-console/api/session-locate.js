'use strict';

// Resolve a chat message to the session-log run that produced it (#2603).
//
// Agent Chat's "Show in session log" button needs the correlationId of the run
// behind a message. For a user message that is its own Matrix event id (the
// runner stamps `message.received` with it), but an agent reply cannot be
// attributed reliably on the client: a triggered run's reply can land after a
// user message typed while the run was going, so "the previous user message"
// would name the wrong session. The runner records the authoritative mapping
// instead — every reply it posts leaves a `message.posted` row carrying the
// reply's `eventId` and the run's `correlationId`. This looks that row up.
//
// Pure; the route in api.js does the file IO (archives + live file).

/**
 * @param {Array<object>} events  Parsed session-log rows, any order.
 * @param {string} eventId        Matrix event id of the chat message.
 * @returns {?string} the correlationId of the run, or null when the log has
 *   no row for this message (never logged, pruned, or a Reset removed it).
 */
function locateCorrelationId(events, eventId) {
  if (typeof eventId !== 'string' || !eventId || !Array.isArray(events)) return null;
  let ownRun = false;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'message.posted' && ev.eventId === eventId
        && typeof ev.correlationId === 'string' && ev.correlationId) {
      return ev.correlationId;
    }
    // A user message is its own run: its rows carry its event id.
    if (ev.correlationId === eventId) ownRun = true;
  }
  return ownRun ? eventId : null;
}

module.exports = { locateCorrelationId };
