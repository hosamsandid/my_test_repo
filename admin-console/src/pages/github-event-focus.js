// Deep-link to one GitHub Event Log row (#2872). Dependency-free so it
// unit-tests under `node --test`; `GithubEventLog.jsx` and the Flow Control
// board's "wake never delivered" flag share it, so the link and the page that
// resolves it cannot drift.

export const EVENT_PARAM = 'event';

// The range the page loads while focusing one event: the log keeps 7 days,
// and a parked wake's event may well be older than the default 24 hours.
export const FOCUS_RANGE_KEY = '7d';

// `/github-events?event=<id>`, or null for an event that was never logged.
export function eventLogHref(eventId) {
  if (eventId == null || eventId === '') return null;
  return `/github-events?${EVENT_PARAM}=${encodeURIComponent(String(eventId))}`;
}

// The rows to show: only the focused event's when one is named, else all.
export function focusedEventRows(rows, eventId) {
  const list = Array.isArray(rows) ? rows : [];
  if (eventId == null || eventId === '') return list;
  return list.filter((r) => r && String(r.eventId) === String(eventId));
}

// The note above a focused table; it offers the way back to the full log.
export function focusNotice(eventId, count) {
  if (eventId == null || eventId === '') return null;
  return count > 0
    ? `Showing one event (${eventId}).`
    : `Event ${eventId} is not in the last 7 days of the log.`;
}
