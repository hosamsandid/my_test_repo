import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';

// Maintenance Mode (#502): a global, console-wide read of the central status
// endpoint added by #501 (GET /api/maintenance-mode). Polled independently of
// any single page/conversation so the chat lock applies across all agents and
// teams, not just whichever conversation happens to be open, and so the
// warning clears on its own (next poll tick) once an admin ends the mode —
// no reload needed.

const MaintenanceModeContext = createContext(null);

const POLL_MS = 5_000;
const TICK_MS = 1_000;

const INACTIVE = { active: false, remainingSec: 0, graceEndsAt: null };

export function MaintenanceModeProvider({ children }) {
  // Starts INACTIVE until the first poll resolves, so a page load landing
  // mid-maintenance has a brief (one round-trip) unlocked window. Accepted
  // for this client-only, non-security-boundary lock — intentional, not a
  // bug to "fix" with an extra loading state.
  const [status, setStatus] = useState(INACTIVE);
  // Polls only while a session exists (#2616): GET /api/maintenance-mode is
  // session-protected and the login screen does not show maintenance state, so
  // polling from above the auth gate only produced a 401 per tick there.
  const { authenticated } = useAuth();

  useEffect(() => {
    if (!authenticated) {
      setStatus(INACTIVE);
      return undefined;
    }
    let cancelled = false;
    const poll = () => {
      fetch('/api/maintenance-mode')
        .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
        .then(data => { if (!cancelled) setStatus(data); })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [authenticated]);

  // Ticks the displayed countdown down between polls so it doesn't sit
  // frozen for up to POLL_MS; each poll resync overwrites any drift.
  // Only armed while maintenance is actually active (#1680): when it isn't,
  // this provider wraps the whole app, so a 1s tick here would re-render every
  // useMaintenanceMode() consumer once per second for nothing. Gated on
  // status.active (not remainingSec) so the interval isn't recreated on every
  // tick — it starts when maintenance begins and stops when it ends.
  useEffect(() => {
    if (!status.active) return undefined;
    const timer = setInterval(() => {
      setStatus(s => (s.active && s.remainingSec > 0 ? { ...s, remainingSec: s.remainingSec - 1 } : s));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [status.active]);

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
