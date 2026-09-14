import React, { createContext, useContext, useState, useEffect } from 'react';

// Agent pools feature flag (#2302): a thin client mirror of the server-side
// AEE_POOLS_ENABLED boot flag (GET /api/pools-mode). The value is fixed for
// the lifetime of the server process, so this fetches once on mount rather
// than polling like Maintenance Mode does.
//
// Starts OFF until the fetch resolves — the same fail-safe-default tradeoff
// MaintenanceModeContext takes: a page load landing before the first
// response briefly sees the disabled/hidden treatment, never the enabled one.

const PoolsFeatureContext = createContext(null);

export function PoolsFeatureProvider({ children }) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/pools-mode')
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(data => { if (!cancelled) setEnabled(!!(data && data.enabled)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <PoolsFeatureContext.Provider value={enabled}>
      {children}
    </PoolsFeatureContext.Provider>
  );
}

export function usePoolsEnabled() {
  const ctx = useContext(PoolsFeatureContext);
  if (ctx === null) throw new Error('usePoolsEnabled must be used within a PoolsFeatureProvider');
  return ctx;
}
