import React, { createContext, useContext, useState, useEffect } from 'react';

// Maintenance Mode (#502): a global, console-wide read of the central status
// endpoint added by #501 (GET /api/maintenance-mode). Polled independently of
// any single page/conversation so the chat lock applies across all agents and
// teams, not just whichever conversation happens to be open, and so the
// warning clears on its own (next poll tick) once an admin ends the mode —
// no reload needed.

const MaintenanceModeContext = createContext(null);

const POLL_MS = 5_000;

const INACTIVE = { active: false, remainingSec: 0, graceEndsAt: null };

export function MaintenanceModeProvider({ children }) {
  const [status, setStatus] = useState(INACTIVE);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetch('/api/maintenance-mode')
        .then(r => (r.ok ? r.json() : INACTIVE))
        .then(data => { if (!cancelled) setStatus(data); })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  return (
    <MaintenanceModeContext.Provider value={status}>
      {children}
    </MaintenanceModeContext.Provider>
  );
}

export function useMaintenanceMode() {
  const ctx = useContext(MaintenanceModeContext);
  if (!ctx) throw new Error('useMaintenanceMode must be used within a MaintenanceModeProvider');
  return ctx;
}
