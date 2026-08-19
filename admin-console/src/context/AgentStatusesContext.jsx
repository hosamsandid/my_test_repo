import React, { createContext, useContext, useState, useEffect } from 'react';

// Shared agent-status poll (#1677). GET /api/agents/statuses was independently
// polled on a 5s beat by three surfaces at once — the Shell nav badge, the
// Agent-Chat list, and Maintenance Mode — so with the chat page open the
// endpoint was hit up to three times every interval, each request doing
// uncached per-agent filesystem work. This provider polls once and every
// subscriber reads the same payload, so the endpoint is requested at most once
// per interval regardless of how many components need it. Mirrors the
// MaintenanceModeContext pattern (mounted above the router in index.jsx).

const AgentStatusesContext = createContext(null);

const POLL_MS = 5_000;

export function AgentStatusesProvider({ children }) {
  // The raw /api/agents/statuses list; starts empty until the first poll
  // resolves. Each consumer derives its own view (see context/agent-statuses.js).
  const [statuses, setStatuses] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetch('/api/agents/statuses')
        .then(r => (r.ok ? r.json() : []))
        .then(list => { if (!cancelled) setStatuses(Array.isArray(list) ? list : []); })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  return (
    <AgentStatusesContext.Provider value={statuses}>
      {children}
    </AgentStatusesContext.Provider>
  );
}

export function useAgentStatuses() {
  const ctx = useContext(AgentStatusesContext);
  if (ctx === null) throw new Error('useAgentStatuses must be used within an AgentStatusesProvider');
  return ctx;
}
