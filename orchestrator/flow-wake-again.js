'use strict';

// "Wake again" on the Flow Control board (#2873, epic #2880).
//
// A row flagged "wake never delivered" (#2872) carries a wake label on GitHub
// that never reached its agent: the poller dropped the one `labeled` event
// (`history-horizon`, `wake-already-armed`, …) or the Events API never
// reported it. Unlike "Release claim" (#2754), nothing on GitHub needs to
// change — the label is already there. So this action does not touch labels
// and does not depend on the Events API: it delivers the wake in-process,
// through the same label fast-path a console-applied label uses, to the
// consumer ROLE TEMPLATES only. A pooled role's template routes the wake onto
// the item's own instance (`planPoolDispatch`), exactly like a poller delivery;
// a live instance of another item is never woken. A gated PR hand-off (#2795)
// opens a readiness hold instead of being delivered.
//
// Only ever on an explicit click: the route re-reads a FRESH board and refuses
// unless the row is still parked, re-checks on GitHub that each wake label is
// still on an open item, and every delivery is one Event Log line
// (`source: 'flow-control'`, the acting user as the event's actor).
//
// Pure, so it unit-tests without a network or a filesystem.

const flowBoard = require('./flow-board');

// The `source` the delivery's Event Log line carries.
const WAKE_AGAIN_SOURCE = 'flow-control';

// The in-flight key for one row. A double-click, or two people clicking at
// once, hits this before any await — the concurrent half of "at most once";
// the delivered/queued state the fresh board then sees is the persisted half.
function wakeAgainKey(teamId, rowId) {
  return `${teamId}::${rowId}`;
}

// Which wakes a fresh board row lets a person deliver again, or why not.
function planWakeAgain(board, rowId) {
  if (!board || board.stale) {
    return { ok: false, status: 503, error: 'GitHub could not be read just now — try again in a moment' };
  }
  const row = (Array.isArray(board.rows) ? board.rows : []).find((r) => r && r.id === rowId);
  if (!row) return { ok: false, status: 404, error: 'That item is not on the board' };
  const block = row.needsHuman;
  if (!block || block.reason !== flowBoard.REASONS.wakeLost) {
    return { ok: false, status: 409, error: 'This item is no longer parked on an undelivered wake' };
  }
  const wakes = (Array.isArray(block.wakes) ? block.wakes : [])
    .filter((w) => w && typeof w.label === 'string' && w.label && Array.isArray(w.roles) && w.roles.length);
  if (!wakes.length) return { ok: false, status: 409, error: 'No agent is switched on to pick this wake up' };
  return { ok: true, row, wakes };
}

// The GitHub re-check for one wake, from the raw issue/PR object: the item is
// still open and still carries the wake label. `detail` null = GitHub could
// not be read, which refuses rather than guesses.
function checkWakeStillPresent(detail, { label }) {
  if (!detail || typeof detail !== 'object') {
    return { ok: false, warning: 'could not read the item on GitHub' };
  }
  if (detail.state === 'closed' || detail.merged === true) {
    return { ok: false, warning: 'the item is closed' };
  }
  const labels = (Array.isArray(detail.labels) ? detail.labels : [])
    .map((l) => (typeof l === 'string' ? l : l && l.name));
  if (!labels.includes(label)) return { ok: false, warning: `${label} is no longer on the item` };
  return { ok: true };
}

// The poller listeners a wake goes to: only the parked wake's consumer role
// templates. A pool instance inherits its role's trigger, so the raw listener
// list includes every live instance — and with it another item's (#2875).
function templateListeners(listeners, roleIds) {
  const roles = new Set(Array.isArray(roleIds) ? roleIds : []);
  return (Array.isArray(listeners) ? listeners : []).filter((l) => l && roles.has(l.agentId));
}

module.exports = {
  WAKE_AGAIN_SOURCE,
  wakeAgainKey,
  planWakeAgain,
  checkWakeStillPresent,
  templateListeners,
};
