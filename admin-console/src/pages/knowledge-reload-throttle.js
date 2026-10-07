/**
 * Throttle for the Knowledge page's feed-driven graph reloads (#571).
 *
 * Every live-feed event (a harvest, a consolidation step…) used to schedule a
 * full `GET /api/knowledge/graph` reload of its team 400 ms later. A streaming
 * feed therefore meant a graph rebuild every ~0.5 s per open tab, and the
 * graph build was the console's worst route (#555).
 *
 * The throttle reloads a team at most once per `intervalMs` while events
 * stream. Events that land inside a window fold into ONE trailing reload, so
 * the last event is always reflected. A hidden tab reloads nothing and catches
 * up once when it becomes visible again. The reloads after the user's own
 * mutations do not go through here and stay immediate.
 *
 * Pure: timers, clock and visibility are injected, so the decisions are
 * unit-testable without a DOM (#651 convention).
 */

import { shouldRefreshOnVisible } from '../context/agent-roster-poll.js';

export const FEED_RELOAD_INTERVAL_MS = 8000;
export const FEED_RELOAD_DEBOUNCE_MS = 400;

/** How long to wait before the next reload of a team last reloaded at `lastAt`. */
export function feedReloadDelayMs({ lastAt, now, intervalMs = FEED_RELOAD_INTERVAL_MS, debounceMs = FEED_RELOAD_DEBOUNCE_MS }) {
  const since = lastAt == null ? Infinity : now - lastAt;
  return Math.max(debounceMs, intervalMs - since);
}

export function createFeedReloadThrottle({
  reload,
  intervalMs = FEED_RELOAD_INTERVAL_MS,
  debounceMs = FEED_RELOAD_DEBOUNCE_MS,
  now = () => Date.now(),
  isHidden = () => false,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
}) {
  // teamId -> { lastAt, timer, hiddenPending }
  const teams = new Map();
  const slot = (teamId) => {
    if (!teams.has(teamId)) teams.set(teamId, { lastAt: null, timer: null, hiddenPending: false });
    return teams.get(teamId);
  };

  function fire(teamId) {
    const s = slot(teamId);
    s.timer = null;
    if (isHidden()) {
      s.hiddenPending = true;
      return;
    }
    s.hiddenPending = false;
    s.lastAt = now();
    reload(teamId);
  }

  function request(teamId) {
    if (!teamId) return;
    const s = slot(teamId);
    if (isHidden()) {
      s.hiddenPending = true;
      return;
    }
    if (s.timer != null) return; // a trailing reload is already scheduled — it covers this event
    s.timer = setTimer(() => fire(teamId), feedReloadDelayMs({ lastAt: s.lastAt, now: now(), intervalMs, debounceMs }));
  }

  // Call on every `visibilitychange` with the previous and current hidden flag:
  // the hidden → visible edge schedules one catch-up per team that missed events.
  function visibilityChanged(prevHidden, nextHidden) {
    if (!shouldRefreshOnVisible(prevHidden, nextHidden)) return;
    for (const [teamId, s] of teams) {
      if (s.hiddenPending) {
        s.hiddenPending = false;
        request(teamId);
      }
    }
  }

  function dispose() {
    for (const s of teams.values()) {
      if (s.timer != null) clearTimer(s.timer);
      s.timer = null;
    }
    teams.clear();
  }

  return { request, visibilityChanged, dispose };
}
