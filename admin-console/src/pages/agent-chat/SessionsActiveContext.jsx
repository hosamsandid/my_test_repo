import React, {
  createContext, useContext, useState, useEffect, useCallback, useMemo, useRef,
} from 'react';
import { apiCall } from '../../hooks/useApi';
import { sessionsFromResponse } from './sessions-active';
import { shouldTickPoll, shouldRefreshOnVisible, nextSnapshotStaleSince } from '../../context/agent-roster-poll.js';

/**
 * Shared "active sessions" poll for one selected agent (#1678).
 *
 * `GET /api/agents/:id/sessions/active` was polled by three Agent-Chat surfaces
 * at once — the RightRail "Sessions" badge (always, 3s), the SessionsPanel list
 * (3s while visible) and the DiffView running-probe (5s while visible) — so a
 * single open agent produced up to three concurrent timers hitting one endpoint
 * for one badge/count. This provider runs exactly ONE timer while an agent is
 * selected and hands every consumer the same data via `useSessionsActive()`.
 *
 * It follows the MaintenanceModeContext pattern (poll in a provider, catch
 * errors, no auth gate) but is scoped per selected agent rather than
 * console-wide, so it is mounted around RightRail in AgentChat.jsx (RightRail is
 * the common ancestor of all three consumers) with the selected agent's id — a
 * new `agentId` restarts the poll cleanly.
 *
 * The rail stays mounted across a collapse (only its body unmounts), so the
 * count is always current for the collapsed icon-rail dot too — matching the
 * old always-on RightRail count poll this replaces.
 */

const SessionsActiveContext = createContext(null);

const DEFAULT_POLL_MS = 3_000;
// #566: `apiCall` has no deadline of its own. A fetch that never settles would
// hold the snapshot stale and stop the chain (the next tick waits on it, and a
// return to the tab defers to it), so each one is aborted after this long.
export const SESSIONS_FETCH_TIMEOUT_MS = 15_000;

export function SessionsActiveProvider({ agentId, pollMs = DEFAULT_POLL_MS, children }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // #566: when the snapshot was last known fresh, or null while it is — the
  // poll was paused in a hidden tab and the refresh on return has not landed.
  // A consumer that reasons about elapsed time can judge a frozen snapshot as
  // of that moment instead of against a clock that kept running.
  const [staleSince, setStaleSince] = useState(null);

  // Guards a superseded fetch (agent switch / manual refresh) from overwriting
  // a newer poll's result, and lets `refresh()` share the poll's write path.
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    if (!agentId) return;
    const reqId = ++reqRef.current;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), SESSIONS_FETCH_TIMEOUT_MS);
    try {
      const data = await apiCall('GET', `/api/agents/${encodeURIComponent(agentId)}/sessions/active`, undefined, { signal: controller.signal });
      if (reqRef.current !== reqId) return;
      setSessions(sessionsFromResponse(data));
      setError(null);
    } catch (err) {
      if (reqRef.current !== reqId) return;
      setError(controller.signal.aborted ? 'timed out' : (err.message || 'failed to load'));
    } finally {
      clearTimeout(deadline);
      if (reqRef.current === reqId) {
        setLoading(false);
        setStaleSince((prev) => nextSnapshotStaleSince(prev, 'landed', typeof document !== 'undefined' && document.hidden, Date.now()));
      }
    }
  }, [agentId]);

  // The single poll. One self-rescheduling timer per selected agent; switching
  // agent (or clearing it) tears it down and resets to a clean loading state so
  // the previous agent's sessions never linger on the badge.
  useEffect(() => {
    if (!agentId) {
      reqRef.current += 1; // invalidate any in-flight fetch from a prior agent
      setSessions([]);
      setLoading(false);
      setError(null);
      setStaleSince(null);
      return undefined;
    }
    setSessions([]);
    setLoading(true);
    setStaleSince(null);
    let cancelled = false;
    let timer = null;
    // Paused while the tab is hidden (#566), with one immediate refresh when it
    // becomes visible again — the roster poll's rule (agent-roster-poll.js).
    // Nothing reads this badge in a background tab, and each open chat tab
    // otherwise kept hitting the console every 3 s.
    let hidden = typeof document !== 'undefined' ? document.hidden : false;
    let inFlight = false;
    // One self-rescheduling chain. `force` is the first load (which runs even
    // in a hidden tab, so a tab opened in the background shows current data
    // the moment it is looked at) and the refresh on return.
    const tick = async (force = false) => {
      if (cancelled) return;
      timer = null;
      if (force || shouldTickPoll(hidden)) {
        inFlight = true;
        try { await load(); } finally { inFlight = false; }
      }
      if (cancelled) return;
      timer = setTimeout(tick, pollMs);
    };
    tick(true);
    const onVisibilityChange = () => {
      const prevHidden = hidden;
      hidden = document.hidden;
      if (hidden) setStaleSince((prev) => nextSnapshotStaleSince(prev, 'hidden', true, Date.now()));
      if (!shouldRefreshOnVisible(prevHidden, hidden)) return;
      // A fetch already in flight is about to land — let it, rather than
      // starting a second chain. Otherwise pull the pending tick forward, so
      // the return refreshes once instead of once now and again on the timer.
      if (inFlight) return;
      if (timer) clearTimeout(timer);
      tick(true);
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [agentId, pollMs, load]);

  const value = useMemo(() => ({
    sessions,
    loading,
    error,
    stale: staleSince !== null,
    staleSince,
    // Fetch once, outside the poll cadence (e.g. right after a git action or a
    // Stop, so the shared state reflects the change without waiting a full tick).
    refresh: load,
    // Optimistic update surface shared by all consumers (Stop, deep-link
    // preselection) — writes flow back through the same state the badge reads.
    setSessions,
  }), [sessions, loading, error, staleSince, load]);

  return (
    <SessionsActiveContext.Provider value={value}>
      {children}
    </SessionsActiveContext.Provider>
  );
}

/**
 * Read the shared active-sessions state. Returns a safe inert default when used
 * outside a provider so a consumer rendered without one (or in isolation) does
 * not throw — it simply sees no sessions and a no-op refresh.
 */
export function useSessionsActive() {
  return useContext(SessionsActiveContext) || {
    sessions: [],
    loading: false,
    error: null,
    stale: false,
    staleSince: null,
    refresh: () => {},
    setSessions: () => {},
  };
}
