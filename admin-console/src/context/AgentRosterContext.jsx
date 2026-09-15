import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { UNAUTHORIZED_EVENT } from '../auth/AuthContext';
import { mergeRoster } from '../pages/agent-chat/roster-diff.js';
import { shouldTickPoll, shouldRefreshOnVisible } from './agent-roster-poll.js';

// Live-roster poll for the Agent Chat left rail (#2311).
//
// `GET /api/matrix/agents` used to be fetched exactly once (`useApi`), so a
// pool instance spawned elsewhere, a rename, or a removal never showed up
// without a manual reload. This provider polls the same endpoint on its own
// ~5s beat — independent from, but the same cadence as, the existing
// `/api/agents/statuses` poll in `AgentStatusesContext.jsx` (D1: piggyback the
// *cadence*, not the request — merging the two calls would couple two
// unrelated payloads for no benefit, and AC9 only requires that this addition
// not speed up the existing status beat, which a second independent timer
// never does).
//
// Singleton-context pattern mirrors `AgentStatusesContext.jsx` exactly (#1677):
// one poll per mounted provider regardless of how many components consume the
// roster, so Agent Chat never requests the endpoint more than once per
// interval no matter how many rail pieces end up reading it (AC9).
//
// Kept scoped to Agent Chat (mounted inside `AgentChat.jsx`, not globally in
// `index.jsx` like `AgentStatusesProvider`) — #2311 D4 is rail-only, and there
// is no reason to poll the roster on pages that don't render it.

const AgentRosterContext = createContext(null);

const POLL_MS = 5_000;

/**
 * @param {boolean} showDisabled Per-user opt-in (#1928) — widens the query,
 *   same URL builder the rail already used for its one-shot fetch.
 * @param {(showDisabled:boolean)=>string} buildUrl Reused from the caller so
 *   there is exactly one place (`rail-lifecycle.js`'s `matrixAgentsUrl`) that
 *   turns the preference into a URL.
 */
export function AgentRosterProvider({ showDisabled, buildUrl, children }) {
  const url = buildUrl(showDisabled);

  const [agents, setAgents] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Whether a request for the CURRENT url has ever succeeded — mirrors
  // `useApi`'s `hasData` flicker-avoidance ref: a refetch (or a background
  // poll tick) with data already on screen never flips `loading` back to
  // true, so mounted rail rows aren't unmounted (AC6).
  const hasDataRef = useRef(false);
  // Set once on a 401 (AC14): stops all further fetching for this provider
  // instance — there is no point retrying behind an expired session, and the
  // UNAUTHORIZED_EVENT dispatch below already routes the app back to login.
  const stoppedRef = useRef(false);
  const hiddenRef = useRef(typeof document !== 'undefined' ? document.hidden : false);

  // `reason` distinguishes a foreground fetch (initial load, url change, or an
  // explicit caller-triggered `refetch()` — e.g. after a lifecycle mutation)
  // from a background poll tick / visibility-triggered refresh:
  //  - 'foreground': behaves exactly like the old `useApi` — flips `loading`
  //    while there's no data yet, and surfaces a failure via `error` (AC13
  //    only carves out the POLL path; a user-triggered refetch keeps its
  //    existing error-surfacing behavior).
  //  - 'poll': never touches `loading`, never shows a spinner/skeleton over a
  //    populated rail (AC6), and never replaces a working roster with the
  //    error/Retry UI on failure (AC13) — a failed tick is silently skipped,
  //    the previous good roster stays on screen, and polling continues at the
  //    same fixed interval (no backoff, no request-storm risk).
  const fetchOnce = useCallback(async (reason) => {
    if (stoppedRef.current) return;
    const silent = reason === 'poll';
    if (reason === 'foreground' && !hasDataRef.current) setLoading(true);

    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 401) {
          // AC14: route through the same mechanism every other API caller
          // uses, and stop polling — no retry loop behind an expired session.
          stoppedRef.current = true;
          window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const fetched = await res.json();
      hasDataRef.current = true;
      setAgents(prev => {
        const { list, changed } = mergeRoster(prev, Array.isArray(fetched) ? fetched : []);
        // AC7: bail out of the state update entirely when nothing diffable
        // changed, so a poll tick over a stable roster never re-triggers the
        // grouping memo chain or any effect keyed on the `agents` reference.
        return changed ? list : prev;
      });
      setError(null);
    } catch (e) {
      if (!silent) setError(e.message);
      // else: AC13 — a failed background tick leaves the last good roster (and
      // any existing error state) exactly as it was; it's already logged by
      // the browser's own network console, no need to escalate here.
    } finally {
      if (reason === 'foreground') setLoading(false);
    }
  }, [url]);

  // Foreground load: on mount, and whenever the url changes (the showDisabled
  // toggle) — mirrors `useApi`'s "reset hasData on url change" behavior.
  useEffect(() => {
    hasDataRef.current = false;
    fetchOnce('foreground');
  }, [fetchOnce]);

  // Background interval poll + visibility pause/resume (D5).
  useEffect(() => {
    const timer = setInterval(() => {
      if (!shouldTickPoll(hiddenRef.current)) return;
      fetchOnce('poll');
    }, POLL_MS);

    function onVisibilityChange() {
      const prevHidden = hiddenRef.current;
      const nextHidden = document.hidden;
      hiddenRef.current = nextHidden;
      if (shouldRefreshOnVisible(prevHidden, nextHidden)) {
        fetchOnce('poll');
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetchOnce]);

  const refetch = useCallback(() => fetchOnce('foreground'), [fetchOnce]);

  const value = { agents, loading, error, refetch };
  return (
    <AgentRosterContext.Provider value={value}>
      {children}
    </AgentRosterContext.Provider>
  );
}

export function useAgentRoster() {
  const ctx = useContext(AgentRosterContext);
  if (ctx === null) throw new Error('useAgentRoster must be used within an AgentRosterProvider');
  return ctx;
}
