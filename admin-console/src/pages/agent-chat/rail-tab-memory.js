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

/**
 * The default landing tab for an agent with no remembered tab of its own
 * (#2426). Settings is a rare, deliberate destination and Sessions was found
 * to be a poor first thing to see — so a first-ever selection, or a fall-back
 * when a remembered tab is no longer showable, lands on the agent's Workspace.
 * A single constant so "the default tab" has exactly one definition instead of
 * a `'sessions'` literal scattered across the rail.
 */
export const DEFAULT_RAIL_TAB = 'workspace';

/**
 * The tab the rail actually *shows*, which is not always the open agent's own
 * remembered tab (#2426).
 *
 * When the Settings tab is pointed at a DIFFERENT agent than the open chat — a
 * team header-row click routed here, or the row-menu "Settings…" on a disabled
 * or otherwise-not-open agent — that is a transient, per-visit view of someone
 * else's configuration. It must drive only what is *displayed*, never the open
 * agent's own `tab` state (which stays put and keeps being persisted as-is), so
 * that clearing the override falls straight back to the open agent's real tab
 * and nothing writes 'settings' into an agent that was never asked for its own
 * Settings (AC1, AC3).
 *
 * @param {string}  ownTab            the open agent's own tab state
 * @param {boolean} settingsOverride  `settingsSubject(...).override` — a
 *                                    Settings tab aimed at another agent
 * @returns {string}
 */
export function displayTab(ownTab, settingsOverride) {
  return settingsOverride ? 'settings' : ownTab;
}

/**
 * Whether an external `openTabRequest` should update the OPEN agent's own tab.
 *
 * Every request but one does: the "N learned" Knowledge jump, a `?session=`
 * deep link, an own-Settings request (AC4), etc. The exception is a Settings
 * request raised for an override agent (AC3) — applying it would flip the open
 * agent's `tab` to 'settings' and then persist it into that agent's slot, the
 * exact cross-contamination #2426 is about. The override drives the *displayed*
 * tab via {@link displayTab} instead, so this returns false and the open
 * agent's own tab is left untouched.
 *
 * @param {string}  requestTab        the requested tab key
 * @param {boolean} settingsOverride  `settingsSubject(...).override`
 * @returns {boolean}
 */
export function tabRequestAppliesToOwnAgent(requestTab, settingsOverride) {
  return !(requestTab === 'settings' && settingsOverride);
}
