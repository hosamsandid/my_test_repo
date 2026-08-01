import { useState, useEffect, useCallback, useRef } from 'react';
import { UNAUTHORIZED_EVENT } from '../auth/AuthContext';

// A 401 means the session expired or was cleared — notify the AuthProvider so
// the console drops back to the login screen instead of showing broken pages.
function notifyIfUnauthorized(status) {
  if (status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

export function useApi(url) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Track whether data was ever successfully loaded for this URL.
  // On refetch we skip the loading=true flip so mounted components (e.g.
  // OrchestratorCard) are not unmounted and don't lose their local state.
  const hasData = useRef(false);

  const fetchData = useCallback(async () => {
    // A falsy URL means "nothing to fetch" — callers use this to skip a request
    // for scopes whose data is derived client-side (e.g. drafts/imports).
    if (!url) { setData(null); setError(null); setLoading(false); return; }
    if (!hasData.current) setLoading(true);
    setError(null);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        notifyIfUnauthorized(res.status);
        throw new Error(`HTTP ${res.status}`);
      }
      hasData.current = true;
      setData(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    hasData.current = false;
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

export async function apiCall(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    notifyIfUnauthorized(res.status);
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}
