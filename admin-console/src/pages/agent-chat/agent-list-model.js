/**
 * Pure grouping / ordering / filtering model for the Agent Chat left rail
 * (#1682).
 *
 * The grouping pipeline (`buildGroups`, ~10 filter/sort/map passes) used to run
 * inline in `AgentList.jsx` on *every* render — including on every `dragover`
 * during a drag-reorder, which made drag-and-drop janky as the agent count
 * grew. Splitting the pipeline into three pure layers lets the component wrap
 * each one in `useMemo`, so a render that does not change `agents` (a status
 * poll, or a `dragover` that only moves the drop indicator) never re-groups.
 *
 * Everything here is dependency-free so it lands in the `admin-console-src` CI
 * job under `node --test`; the JSX list stays uncovered per the #651 convention
 * (mirrors agent-list-dnd.js / agent-list-env.js / message-draft.js).
 */

/** Stable key for a group across the ordering / drag / collapse maps. */
export function groupKey(g) {
  return `${g.kind}:${g.id}`;
}

/**
 * Build the grouped structure used by both the list and the filter dropdown.
 * Exported so AgentChat can populate the filter without duplicating the
 * grouping logic.
 *
 * Returns `{ groups: [{ kind, id, displayName, header?, children[] }], singles: [] }`.
 *  - `kind` is either `'team'` or `'orchestrator'`.
 *  - `header` is the matching parent agent row when one is visible — absent
 *    when the parent is only referenced by orphaned children (e.g. a team
 *    has no Matrix presence, or an orchestrator stub is disabled).
 */
export function buildGroups(agents) {
  const byName = (a, b) =>
    (a.displayName || a.id).localeCompare(b.displayName || b.id);

  const teamRows         = agents.filter(a => a.role === 'team');
  const memberRows       = agents.filter(a => a.role === 'team-member');
  const orchestratorRows = agents.filter(a => a.role === 'orchestrator');
  const bpInstanceRows   = agents.filter(a => a.role === 'bp-instance');
  const others = agents.filter(a =>
    a.role !== 'team' &&
    a.role !== 'team-member' &&
    a.role !== 'orchestrator' &&
    a.role !== 'bp-instance',
  );

  // Union of team / orchestrator ids that should appear as a section: real
  // parent rows, plus any parent id referenced by a visible child.
  const teamIds = new Set([
    ...teamRows.map(t => t.id),
    ...memberRows.map(m => m.parentTeamId).filter(Boolean),
  ]);
  const orchestratorIds = new Set([
    ...orchestratorRows.map(o => o.id),
    ...bpInstanceRows.map(b => b.parentOrchestratorId).filter(Boolean),
  ]);

  const teamGroups = [...teamIds].map(id => {
    const header   = teamRows.find(t => t.id === id) || null;
    const children = memberRows.filter(m => m.parentTeamId === id).sort(byName);
    return {
      kind: 'team',
      id,
      displayName: header?.displayName || id,
      header,
      children,
    };
  });

  const orchestratorGroups = [...orchestratorIds].map(id => {
    const header   = orchestratorRows.find(o => o.id === id) || null;
    const children = bpInstanceRows.filter(b => b.parentOrchestratorId === id).sort(byName);
    return {
      kind: 'orchestrator',
      id,
      displayName: header?.displayName || id,
      header,
      children,
    };
  });

  const groups = [...teamGroups, ...orchestratorGroups].sort(
    (a, b) => a.displayName.localeCompare(b.displayName),
  );

  // Orphans: children whose parent is not in the visible set.
  const orphans = [
    ...memberRows.filter(m => !m.parentTeamId || !teamIds.has(m.parentTeamId)),
    ...bpInstanceRows.filter(b => !b.parentOrchestratorId || !orchestratorIds.has(b.parentOrchestratorId)),
  ];

  const singles = [...others, ...orphans].sort(byName);

  return { groups, singles };
}

/**
 * Apply a stored key order to an items array. Items matching stored keys come
 * first (in stored order); items not yet in the stored order are appended.
 */
export function applyStoredOrder(items, storedKeys, getKey) {
  if (!storedKeys.length) return items;
  const keyed = new Map(items.map(item => [getKey(item), item]));
  const ordered = storedKeys.map(k => keyed.get(k)).filter(Boolean);
  const rest = items.filter(item => !storedKeys.includes(getKey(item)));
  return [...ordered, ...rest];
}

/**
 * Layer 2 — apply the persisted sidebar order to the raw groups/singles.
 * Groups keep their stored order; within each group its members keep their own
 * stored order on top of the alphabetical baseline.
 */
export function orderModel(rawGroups, rawSingles, sidebarOrder) {
  const members = (sidebarOrder && sidebarOrder.members) || {};
  const groupKeys = (sidebarOrder && sidebarOrder.groups) || [];
  const singleKeys = (sidebarOrder && sidebarOrder.singles) || [];

  const orderedGroups = applyStoredOrder(rawGroups, groupKeys, groupKey)
    .map(group => ({
      ...group,
      children: applyStoredOrder(group.children, members[groupKey(group)] || [], a => a.id),
    }));
  const orderedSingles = applyStoredOrder(rawSingles, singleKeys, a => a.id);
  return { orderedGroups, orderedSingles };
}

/**
 * Decide whether an agent passes the current filter spec.
 *  - { kind: 'all' }                       → everyone
 *  - { kind: 'team', id }                  → the team header (if visible) + its members
 *  - { kind: 'orchestrator', id }          → the orchestrator header (if visible) + its bp-instances
 *  - { kind: 'agent', id }                 → only the agent with this id
 */
export function matchesFilter(agent, filter) {
  if (!filter || filter.kind === 'all') return true;
  if (filter.kind === 'team') {
    if (agent.role === 'team'        && agent.id === filter.id) return true;
    if (agent.role === 'team-member' && agent.parentTeamId === filter.id) return true;
    return false;
  }
  if (filter.kind === 'orchestrator') {
    if (agent.role === 'orchestrator' && agent.id === filter.id) return true;
    if (agent.role === 'bp-instance'  && agent.parentOrchestratorId === filter.id) return true;
    return false;
  }
  if (filter.kind === 'agent') return agent.id === filter.id;
  return true;
}

/**
 * Layer 3 — apply the current filter to the ordered groups/singles. Groups with
 * neither a matching header nor any matching child drop out entirely.
 */
export function filterModel(orderedGroups, orderedSingles, filter) {
  const visibleGroups = orderedGroups
    .map(group => {
      const header   = group.header   && matchesFilter(group.header,   filter) ? group.header   : null;
      const children = group.children.filter(c => matchesFilter(c, filter));
      return { ...group, header, children };
    })
    .filter(group => group.header || group.children.length > 0);

  const visibleSingles = orderedSingles.filter(a => matchesFilter(a, filter));

  return {
    visibleGroups,
    visibleSingles,
    empty: visibleGroups.length === 0 && visibleSingles.length === 0,
  };
}

/**
 * Convenience composition of all three layers — the whole pipeline in one call.
 * The component runs the layers separately (each in its own `useMemo`) so a
 * change to only one input re-runs only the layers downstream of it; this
 * helper is the single-shot equivalent used by tests.
 */
export function buildAgentListModel(agents, sidebarOrder, filter) {
  const { groups, singles } = buildGroups(agents);
  const { orderedGroups, orderedSingles } = orderModel(groups, singles, sidebarOrder);
  return filterModel(orderedGroups, orderedSingles, filter);
}
