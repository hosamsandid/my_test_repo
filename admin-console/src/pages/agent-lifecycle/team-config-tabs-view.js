/**
 * team-config-tabs-view.js — the flat tab row for a team's whole
 * configuration surface (#2236).
 *
 * Replaces the old two-level structure (a boxed "Environment" section holding
 * its own five-tab strip, with Skills and Plugins as separate sections below
 * it) with one row of tabs at the same level: General, then the five
 * environment tabs verbatim from `team-environment-view.js` (same ids, same
 * labels — a re-host, not a fork), then Skills and Plugins.
 */
import { TEAM_ENV_TABS } from '../agent-chat/team-environment-view.js';

export const TEAM_CONFIG_TABS = [
  { id: 'general', label: 'General' },
  ...TEAM_ENV_TABS,
  { id: 'skills', label: 'Skills' },
  { id: 'plugins', label: 'Plugins' },
];

export const DEFAULT_TEAM_CONFIG_TAB = 'general';

// The ids that are backed by the bound environment record (rendered by
// `TeamEnvironmentPanel`), as opposed to `general`/`skills`/`plugins` which
// are agent-construct fields.
export const ENV_TAB_IDS = new Set(TEAM_ENV_TABS.map(t => t.id));

// An unknown or missing tab id falls back to General rather than an empty
// surface (AC7).
export function resolveTeamConfigTab(raw) {
  const id = String(raw || '');
  return TEAM_CONFIG_TABS.some(t => t.id === id) ? id : DEFAULT_TEAM_CONFIG_TAB;
}
