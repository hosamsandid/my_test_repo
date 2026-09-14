/**
 * Pure per-agent tab memory for the right rail (#2267).
 *
 * The rail used to persist a single "last active tab" under one global
 * localStorage key — so switching from any agent to any other agent carried
 * over whatever tab happened to be active, rather than restoring the tab the
 * user was last on *for that specific agent*. This keys the same persisted
 * value by agent id instead, so each agent remembers its own tab.
 *
 * `RightRail.jsx` owns the localStorage read/write (an impure side effect);
 * this module only decides what the stored blob means.
 */

/** Parse a raw localStorage string into an agentId → tab map, defensively. */
export function parseTabMap(raw) {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The remembered tab for one agent, or null when there is none — or when the
 * stored value is no longer a valid tab key (e.g. a retired tab). Callers
 * fall back to the default tab on null, same as "no history yet" (AC3).
 */
export function tabForAgent(map, agentId, tabKeys) {
  if (!agentId || !map) return null;
  const v = map[agentId];
  return tabKeys.includes(v) ? v : null;
}

/** Record (or replace) the remembered tab for one agent. */
export function withAgentTab(map, agentId, tab) {
  if (!agentId) return map || {};
  return { ...(map || {}), [agentId]: tab };
}
