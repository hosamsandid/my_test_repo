import React, { createContext, useContext, useState, useEffect } from 'react';

// Unified resource-access feature flag (#2360): a thin client mirror of the
// server-side AEE_RESOURCE_ACCESS_V2 boot flag (GET /api/resource-access-mode).
// The value is fixed for the lifetime of the server process, so this fetches
// once on mount rather than polling.
//
// Starts OFF until the fetch resolves — the same fail-safe default: a page load
// landing before the first response briefly sees the legacy (scope-tabs)
// treatment, never the new identity/scope one, so nothing enables early.

const ResourceAccessContext = createContext(null);

export function ResourceAccessProvider({ children }) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/resource-access-mode')
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(data => { if (!cancelled) setEnabled(!!(data && data.enabled)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <ResourceAccessContext.Provider value={enabled}>
      {children}
    </ResourceAccessContext.Provider>
  );
}

export function useResourceAccessV2() {
  const ctx = useContext(ResourceAccessContext);
  if (ctx === null) throw new Error('useResourceAccessV2 must be used within a ResourceAccessProvider');
  return ctx;
}
