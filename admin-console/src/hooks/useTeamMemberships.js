import { useCallback, useEffect, useRef, useState } from 'react';

import { apiCall } from './useApi.js';
import { shouldTickPoll, shouldRefreshOnVisible } from '../context/agent-roster-poll.js';

// Live team-membership + directory feed for the Agent Chat left-rail header
// indicator (#2381).
//
// The team header shows who is behind each team — "Own" or the Team Admin
// name(s) — from the SAME data the Sharing tab reads: `GET /api/admin/memberships`
// (no `teamId` filter → every team the caller may see, scoped server-side) and
// `GET /api/users/directory`. AC6 asks the indicator to refresh when membership
// or admin roles change "consistent with how the rest of the rail already
// refreshes on roster changes", so this polls on the SAME ~5s cadence as
// `AgentRosterContext.jsx` and pauses while the tab is hidden, reusing that
// provider's pure scheduling helpers (`agent-roster-poll.js`).
//
// Stable-reference discipline (the load-bearing part): the rail's `GroupSection`
// is `React.memo`, and the membership/directory arrays are threaded into it. A
// poll that returns an unchanged payload must therefore hand back the SAME array
// reference, or every team header would re-render every 5s and defeat the
// #1682/#2311 memoization. We keep the last raw JSON per endpoint and skip the
// `setState` entirely when it is byte-identical — the mirror of `roster-diff`'s
// no-op skip, cheap here because both payloads are small.

const POLL_MS = 5_000;

/**
 * @param {boolean} [enabled=true] Gate the poll (e.g. only while the rail is
 *   mounted). When false the hook idles and reports empty lists.
 * @returns {{ memberships: object[], directory: object[] }}
 */
export function useTeamMemberships(enabled = true) {
  const [memberships, setMemberships] = useState([]);
  const [directory, setDirectory] = useState([]);

  // Last raw JSON per endpoint, so an unchanged tick skips setState and keeps
  // the array reference stable for the memoized rail rows downstream.
  const rawMembershipsRef = useRef(null);
  const rawDirectoryRef = useRef(null);
  const stoppedRef = useRef(false);
  const hiddenRef = useRef(typeof document !== 'undefined' ? document.hidden : false);

  const fetchOnce = useCallback(async () => {
    if (stoppedRef.current || !enabled) return;
    try {
      const [m, dir] = await Promise.all([
        apiCall('GET', '/api/admin/memberships'),
        apiCall('GET', '/api/users/directory'),
      ]);
      const mList = Array.isArray(m) ? m : [];
      const dList = Array.isArray(dir) ? dir : [];
      const mRaw = JSON.stringify(mList);
      const dRaw = JSON.stringify(dList);
      if (mRaw !== rawMembershipsRef.current) { rawMembershipsRef.current = mRaw; setMemberships(mList); }
      if (dRaw !== rawDirectoryRef.current) { rawDirectoryRef.current = dRaw; setDirectory(dList); }
    } catch (e) {
      // A 401 is already routed to the login flow by `apiCall`
      // (`notifyIfUnauthorized`); stop polling behind an expired session. Any
      // other failure is a soft miss — the header indicator is decorative, so a
      // dropped tick just leaves the last good lists on screen (AC13 spirit).
      if (e && e.status === 401) stoppedRef.current = true;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    stoppedRef.current = false;
    fetchOnce();

    const timer = setInterval(() => {
      if (!shouldTickPoll(hiddenRef.current)) return;
      fetchOnce();
    }, POLL_MS);

    function onVisibilityChange() {
      const prevHidden = hiddenRef.current;
      const nextHidden = document.hidden;
      hiddenRef.current = nextHidden;
      if (shouldRefreshOnVisible(prevHidden, nextHidden)) fetchOnce();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, fetchOnce]);

  return { memberships, directory };
}

export default useTeamMemberships;
