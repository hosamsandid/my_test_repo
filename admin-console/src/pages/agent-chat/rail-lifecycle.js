/**
 * rail-lifecycle.js — pure decisions for the chat left rail's lifecycle quick
 * actions (#1928, epic #1925 Phase 1).
 *
 * The rail now hosts the agent/team management actions that used to live only on
 * the Agents page. Everything here is the part of that surface that is a
 * *decision* rather than markup: where a popup menu may sit, whether the
 * disabled-agents opt-in is on, and the few facts the shared dialogs need that
 * the chat's list payload doesn't hand over directly (a team's member list, a
 * member's team lock).
 *
 * Dependency-free and unit-tested per the #651 convention; the JSX menu and the
 * dialog host are thin renderers over these.
 */

import { buildAgentMenu, buildTeamMenu } from '../agent-lifecycle/agent-lifecycle-menu.js';

/**
 * Per-user opt-in to seeing disabled agents in the rail (AC6/AC7). Stored under
 * the rail's own `agentChat.` namespace and with the same shape as its sibling
 * rail state (`agentChat.collapsedGroups`, `agentChat.sidebarOrder`) so the
 * whole rail persists one way — see the open question 2 answer in the PR.
 */
export const SHOW_DISABLED_KEY = 'agentChat.showDisabled';

export function loadShowDisabled(storage) {
  try {
    return (storage ?? localStorage).getItem(SHOW_DISABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveShowDisabled(value, storage) {
  try {
    (storage ?? localStorage).setItem(SHOW_DISABLED_KEY, value ? 'true' : 'false');
  } catch { /* ignore quota / privacy mode */ }
}

/**
 * Place a popup menu near a click point, kept fully inside the viewport.
 *
 * The rail is a scrolling container, so the menu is portaled and positioned in
 * *viewport* coordinates. Preferred placement is below-right of the pointer; a
 * menu that would overflow flips to the other side of the point rather than
 * being merely nudged, so it never covers the row it belongs to.
 */
export function clampMenuPosition({
  x, y, width, height, viewportWidth, viewportHeight, margin = 8,
}) {
  let left = x;
  if (left + width > viewportWidth - margin) left = x - width;          // flip left
  if (left < margin) left = Math.max(margin, viewportWidth - width - margin);

  let top = y;
  if (top + height > viewportHeight - margin) top = y - height;         // flip up
  if (top < margin) top = Math.max(margin, viewportHeight - height - margin);

  return { left: Math.round(left), top: Math.round(top) };
}

/** `{id, displayName}` options for the clone/import parent-team pickers. */
export function teamOptions(agents) {
  return (agents || [])
    .filter(a => a && a.role === 'team')
    .map(a => ({ id: a.id, displayName: a.displayName || a.id }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Every id currently in the list — seeds the clone dialog's id suggestion. */
export function existingIds(agents) {
  return new Set((agents || []).filter(Boolean).map(a => a.id));
}

/**
 * The shape `renderDeleteMessage` / the delete confirm expect: the agent plus
 * its `children` (a team's members, an orchestrator's bp-instances), so deleting
 * a team says how many members go with it.
 */
export function deleteTargetFor(agent, agents) {
  if (!agent) return null;
  const list = agents || [];
  const children =
    agent.role === 'team'         ? list.filter(a => a.parentTeamId === agent.id)
    : agent.role === 'orchestrator' ? list.filter(a => a.parentOrchestratorId === agent.id)
    : [];
  return { ...agent, children };
}

/**
 * The team lock (AC5): a member whose parent team is disabled cannot be enabled
 * on its own — the Agents page renders that toggle disabled, and the chat menu
 * must say the same. A team that is not in the list at all (the opt-in is off,
 * so a disabled team is invisible) leaves the member unlocked — we do not guess
 * a lock from an absence.
 */
export function isTeamLocked(agent, agents) {
  if (!agent || agent.role !== 'team-member' || !agent.parentTeamId) return false;
  const team = (agents || []).find(a => a && a.id === agent.parentTeamId);
  return !!team && team.enabled === false;
}

/**
 * The rail-header "+" menu (AC3). Both entries reuse an existing surface rather
 * than growing a second create form in the chat: **New agent** hands over to the
 * Create launcher, **Import agent** opens the Agents page's own import dialog
 * inline (it is the shared `ImportAgentForm`, so the chat cannot drift from it).
 */
export function buildCreateMenu() {
  return [
    { key: 'new-agent', label: 'New agent…', disabled: false },
    { key: 'import-agent', label: 'Import agent…', disabled: false },
  ];
}

/**
 * Resolve a menu request from the rail into the items to render and the menu's
 * accessible name — the one place that decides *which* menu a click gets, so
 * the host component stays a renderer.
 *
 * `agents` is whatever list the caller has (the chat's own list, widened with
 * the scoped `/api/agents` configs when those have arrived): it is read only to
 * look up the team lock and the team row's `canManage`, both of which the server
 * re-enforces, so a not-yet-loaded list degrades to "offered, then refused"
 * rather than to a wrong action.
 *
 * @param {{kind:'agent'|'team'|'create', agent?:object, group?:object}} o.target
 * @param {object[]} o.agents
 * @param {Set<string>} o.busyIds     ids with a mutation in flight
 * @param {{id:string,displayName?:string}[]} o.missingRoles  team menu only
 */
export function railMenuItems({ target, agents = [], busyIds = new Set(), missingRoles = [] } = {}) {
  if (!target) return { items: [], label: '' };

  if (target.kind === 'create') {
    return { items: buildCreateMenu(), label: 'Add an agent' };
  }

  if (target.kind === 'agent') {
    const agent = target.agent;
    if (!agent) return { items: [], label: '' };
    return {
      label: `Actions for ${agent.displayName || agent.id}`,
      items: buildAgentMenu({
        agent,
        // Absent (an older payload) means "no reason to think otherwise" — the
        // route still decides; `false` is only ever an explicit server verdict.
        canManage: agent.canManage !== false,
        locked: isTeamLocked(agent, agents),
        busy: busyIds.has(agent.id),
      }),
    };
  }

  if (target.kind === 'team') {
    const group = target.group;
    if (!group?.id) return { items: [], label: '' };
    const team = group.header || (agents || []).find(a => a && a.id === group.id && a.role === 'team') || null;
    return {
      label: `Team actions for ${group.displayName || group.id}`,
      items: buildTeamMenu({
        team,
        teamId: group.id,
        canManage: team ? team.canManage !== false : true,
        busy: busyIds.has(group.id),
        missingRoles,
      }),
    };
  }

  return { items: [], label: '' };
}
