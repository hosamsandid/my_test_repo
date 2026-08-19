import React, {
  createContext, useContext, useState, useEffect, useCallback, useMemo, useRef,
} from 'react';
import { apiCall } from '../../hooks/useApi';
import { sessionsFromResponse } from './sessions-active';

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

export function SessionsActiveProvider({ agentId, pollMs = DEFAULT_POLL_MS, children }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Guards a superseded fetch (agent switch / manual refresh) from overwriting
  // a newer poll's result, and lets `refresh()` share the poll's write path.
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    if (!agentId) return;
    const reqId = ++reqRef.current;
    try {
      const data = await apiCall('GET', `/api/agents/${encodeURIComponent(agentId)}/sessions/active`);
      if (reqRef.current !== reqId) return;
      setSessions(sessionsFromResponse(data));
      setError(null);
    } catch (err) {
      if (reqRef.current !== reqId) return;
      setError(err.message || 'failed to load');
    } finally {
      if (reqRef.current === reqId) setLoading(false);
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
      return undefined;
    }
    setSessions([]);
    setLoading(true);
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      if (cancelled) return;
      await load();
      if (cancelled) return;
      timer = setTimeout(tick, pollMs);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agentId, pollMs, load]);

  const value = useMemo(() => ({
    sessions,
    loading,
    error,
    // Fetch once, outside the poll cadence (e.g. right after a git action or a
    // Stop, so the shared state reflects the change without waiting a full tick).
    refresh: load,
    // Optimistic update surface shared by all consumers (Stop, deep-link
    // preselection) — writes flow back through the same state the badge reads.
    setSessions,
  }), [sessions, loading, error, load]);

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
    refresh: () => {},
    setSessions: () => {},
  };
}
