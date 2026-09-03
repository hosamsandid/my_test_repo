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

import { buildAgentMenu, buildTeamMenu, isChatOpenable } from '../agent-lifecycle/agent-lifecycle-menu.js';

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
 * The chat's list endpoint, widened only when the opt-in is on. Kept here rather
 * than inline in the page so the one place that turns the preference into a URL
 * is the same place that reads the preference — and so the default really is the
 * pre-#1928 URL, byte for byte (AC6: with the filter off the chat shows exactly
 * what it shows today).
 */
export function matrixAgentsUrl(showDisabled) {
  return showDisabled ? '/api/matrix/agents?includeDisabled=1' : '/api/matrix/agents';
}

/**
 * Widen the chat's list entries with the full agent configs from the scoped
 * `GET /api/agents`, which the lifecycle host loads lazily on the first menu it
 * is asked for.
 *
 * The chat payload is deliberately thin (no `labels[]`, no member tree), but two
 * decisions need the config: which loop-closing roles a team is missing, and how
 * many members a team-delete confirm has to name. Conversely only the chat
 * payload carries `canManage`, so the merge is one-directional per field: config
 * fields win (they are the fuller record), `canManage` is carried over from the
 * chat entry.
 *
 * Either side may be missing — before the fetch lands, and for a config-only
 * agent that has no chat identity — so both are tolerated and the result is
 * always a list.
 */
export function mergeAgentConfigs(chatAgents, configs) {
  const chat = (chatAgents || []).filter(Boolean);
  if (!Array.isArray(configs) || configs.length === 0) return chat;

  const byId = new Map(chat.map(a => [a.id, a]));
  const out = configs.filter(Boolean).map(cfg => {
    const seen = byId.get(cfg.id);
    byId.delete(cfg.id);
    return seen ? { ...cfg, canManage: seen.canManage } : cfg;
  });
  // A chat row with no config (unreadable config.json) still belongs in the list
  // — dropping it would make a visible row menu-less.
  for (const left of byId.values()) out.push(left);
  return out;
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
 * Would a freshly imported agent be visible in the rail right now? (#1956 AC4 /
 * the filtered-import edge case.)
 *
 * Import is reachable from the page header, which is *outside* the rail and so
 * knows nothing about the rail's filter. With a narrowed filter the imported
 * agent lands in the list and is immediately filtered back out — success, and
 * nothing appears. Rather than silently widening the filter (the user set it on
 * purpose) the success notice says so.
 *
 * Conservative on purpose: it answers "is this agent inside the current filter"
 * only for the cases the filter spec makes decidable from the import response
 * (`agentId` + `parentTeamId`), and reports *visible* whenever it cannot tell —
 * a wrong "hidden" note next to an agent the user can plainly see is worse than
 * no note.
 *
 * @returns {string|null} the note to append to the success message, or null
 */
export function importedAgentFilterNote(filter, agentId, parentTeamId) {
  const kind = filter && filter.kind;
  if (!kind || kind === 'all') return null;
  // Names the option verbatim as the filter's <select> renders it.
  const HIDDEN = ' The list filter is hiding it — switch it to "All agents" to see it.';
  if (kind === 'agent') return filter.id === agentId ? null : HIDDEN;
  if (kind === 'team' || kind === 'orchestrator') {
    return filter.id === parentTeamId ? null : HIDDEN;
  }
  return null;
}

/**
 * The activity states in which "mark as unread" has nothing to do: the row is
 * already unread, or it is not a readable chat at all. Kept as data so the one
 * rule survives a reword — it is the same set the hover icon used before #1938
 * moved the action into the menu.
 */
const NOT_MARKABLE_STATES = new Set(['unread', 'disabled', 'offline', 'problem']);

/**
 * May this row be marked unread? A **local view action**, so the answer depends
 * only on the row's unread + chat-openable state and never on `canManage`
 * (#1938 AC6) — nothing is mutated on the server.
 */
export function canMarkUnread(agent, activityState = 'idle') {
  if (!isChatOpenable(agent)) return false;
  return !NOT_MARKABLE_STATES.has(activityState);
}

/**
 * The chat-rail-only "Mark as unread" entry (#1938).
 *
 * It lives here rather than in the shared `buildAgentMenu` because the Agents
 * management page renders that same descriptor and has no unread concept at
 * all. This layer already knows it is the Agent-Chat rail, so the chat-only
 * action is prepended here and the shared descriptor stays free of it.
 *
 * The entry is **always present** and merely disabled when it does not apply
 * (D2) — a stable list beats a menu whose first row moves depending on whether
 * the agent happens to be unread — and it carries **no** hint: unlike a refused
 * mutation there is nothing to explain, the row's own indicator already says it.
 */
export function markUnreadItem(agent, activityState) {
  return {
    key: 'mark-unread',
    label: 'Mark as unread',
    disabled: !canMarkUnread(agent, activityState),
  };
}

/**
 * The chat-rail-only "What these actions do…" entry (#1972).
 *
 * The row menu is one of the surfaces the epic gives a "?", and a menu cannot
 * host a button: `RowContextMenu` renders a flat list of real, index-walked
 * entries, so a help *item* is the only affordance that does not break its
 * keyboard traversal. Like `markUnreadItem` it is chat-only and lives here
 * rather than in the shared `buildAgentMenu` the Agents page also renders —
 * that page's own topic already covers lifecycle.
 *
 * Always last, always enabled, and fenced off from the actions above it: it is
 * the one entry that changes nothing.
 */
export function helpMenuItem() {
  return { key: 'help', label: 'What these actions do…', disabled: false, separated: true };
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
 * @param {{kind:'agent'|'team', agent?:object, group?:object}} o.target
 * @param {object[]} o.agents
 * @param {Set<string>} o.busyIds     ids with a mutation in flight
 * @param {string} o.activityState    the row's activity state (agent menu only,
 *                                    from the chat's status poll) — decides
 *                                    whether "Mark as unread" applies (#1938)
 */
export function railMenuItems({
  target, agents = [], busyIds = new Set(), activityState = 'idle',
} = {}) {
  if (!target) return { items: [], label: '' };

  if (target.kind === 'agent') {
    const agent = target.agent;
    if (!agent) return { items: [], label: '' };
    const lifecycle = buildAgentMenu({
      agent,
      // Absent (an older payload) means "no reason to think otherwise" — the
      // route still decides; `false` is only ever an explicit server verdict.
      canManage: agent.canManage !== false,
      locked: isTeamLocked(agent, agents),
      busy: busyIds.has(agent.id),
    });
    // The view action leads (#1938 D1) and the lifecycle group is fenced off
    // from it: `separated` is a hint to the renderer, not a pseudo-item, so the
    // menu's keyboard traversal still walks a flat list of real entries.
    return {
      label: `Actions for ${agent.displayName || agent.id}`,
      items: [
        markUnreadItem(agent, activityState),
        ...lifecycle.map((item, i) => (i === 0 ? { ...item, separated: true } : item)),
        helpMenuItem(),
      ],
    };
  }

  if (target.kind === 'team') {
    const group = target.group;
    if (!group?.id) return { items: [], label: '' };
    const team = group.header || (agents || []).find(a => a && a.id === group.id && a.role === 'team') || null;
    return {
      label: `Team actions for ${group.displayName || group.id}`,
      items: [
        ...buildTeamMenu({
          team,
          teamId: group.id,
          canManage: team ? team.canManage !== false : true,
          busy: busyIds.has(group.id),
        }),
        helpMenuItem(),
      ],
    };
  }

  return { items: [], label: '' };
}
