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

import { agentState } from '../agent-lifecycle/agent-lifecycle-menu.js';

/** Stable key for a group across the ordering / drag / collapse maps. */
export function groupKey(g) {
  return `${g.kind}:${g.id}`;
}

/**
 * A **not-yet-materialized** member (#1957): configuration and triggers only —
 * no Matrix user, no workspace, no container. Derived from the shared
 * `agentState()` rather than re-read off the payload, so the rail and the
 * lifecycle menu can never disagree about what a stub is.
 *
 * Such a row is only in the list because the chat asked for it
 * (`?includeStubs=1`), and the endpoint only ever ships stubs that are team
 * members with a `parentTeamId` — which is what lets `buildGroups` treat "is a
 * stub" as "belongs in its team's not-materialized section" without a second
 * shape check.
 */
export function isStub(agent) {
  return agentState(agent) === 'stub';
}

/**
 * The collapsed section's label. Its count is the point — AC2 wants the number
 * readable *without* expanding — so it is built here rather than assembled in
 * the JSX, and the tests can hold the wording.
 */
export function stubSectionLabel(count) {
  return `Not materialized yet (${count})`;
}

/**
 * Build the grouped structure used by both the list and the filter dropdown.
 * Exported so AgentChat can populate the filter without duplicating the
 * grouping logic.
 *
 * Returns `{ groups: [{ kind, id, displayName, header?, children[], stubs[] }], singles: [] }`.
 *  - `kind` is either `'team'` or `'orchestrator'`.
 *  - `header` is the matching parent agent row when one is visible — absent
 *    when the parent is only referenced by orphaned children (e.g. a team
 *    has no Matrix presence, or an orchestrator stub is disabled).
 *  - `stubs` are the team's not-yet-materialized members (#1957), split out of
 *    `children` rather than mixed in: they render in their own collapsed
 *    section, are not chat-openable and are not drag-reorderable, so keeping
 *    them out of `children` means every existing consumer of that array (the
 *    stored member order, the member drag scope, the group's own count) keeps
 *    describing exactly the rows it used to. An orchestrator group is always
 *    `stubs: []` — a stub bp-instance is out of scope and the endpoint never
 *    ships one.
 */
export function buildGroups(agents) {
  const byName = (a, b) =>
    (a.displayName || a.id).localeCompare(b.displayName || b.id);

  const teamRows         = agents.filter(a => a.role === 'team');
  const memberRows       = agents.filter(a => a.role === 'team-member' && !isStub(a));
  const stubRows         = agents.filter(a => a.role === 'team-member' && isStub(a));
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
  // A stub member counts towards its team's existence too — a team created with
  // deferred materialization may have *nothing but* stubs, and it has to appear
  // (AC1, and the all-stubs edge case) rather than look like an empty list.
  const teamIds = new Set([
    ...teamRows.map(t => t.id),
    ...memberRows.map(m => m.parentTeamId).filter(Boolean),
    ...stubRows.map(m => m.parentTeamId).filter(Boolean),
  ]);
  const orchestratorIds = new Set([
    ...orchestratorRows.map(o => o.id),
    ...bpInstanceRows.map(b => b.parentOrchestratorId).filter(Boolean),
  ]);

  const teamGroups = [...teamIds].map(id => {
    const header   = teamRows.find(t => t.id === id) || null;
    const children = memberRows.filter(m => m.parentTeamId === id).sort(byName);
    const stubs    = stubRows.filter(m => m.parentTeamId === id).sort(byName);
    return {
      kind: 'team',
      id,
      displayName: header?.displayName || id,
      header,
      children,
      stubs,
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
      // Always empty — kept so every group has the same shape and the renderer
      // needs no per-kind branch.
      stubs: [],
    };
  });

  const groups = [...teamGroups, ...orchestratorGroups].sort(
    (a, b) => a.displayName.localeCompare(b.displayName),
  );

  // Orphans: children whose parent is not in the visible set. A stub is only
  // ever orphaned by having no `parentTeamId` at all (its team id is in
  // `teamIds` by construction above) — the endpoint never ships such a row, but
  // listing it beats dropping it silently, which is the one outcome the user
  // could not tell from a missing agent.
  const orphans = [
    ...memberRows.filter(m => !m.parentTeamId || !teamIds.has(m.parentTeamId)),
    ...stubRows.filter(m => !m.parentTeamId || !teamIds.has(m.parentTeamId)),
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
 * Disabled agents are hidden from the chat list unless the caller opted in
 * (#1928 / epic decision D2). The chat's list source only returns disabled
 * agents when asked, so with the opt-in off this predicate is a no-op — it is
 * the guard that keeps a *stale* disabled row (an agent disabled in another tab,
 * still in the last fetched payload) from lingering as a chat-openable row.
 *
 * A **stub** is exempt (#1957): it is `enabled: false` by definition, so folding
 * it into this predicate would mean the disabled opt-in silently governed two
 * different states — and the not-materialized section would appear and vanish
 * with a filter that is about paused agents. Stubs are governed by their own
 * list opt-in (`?includeStubs=1`) and their own collapsed section instead.
 */
export function passesDisabledFilter(agent, showDisabled) {
  if (showDisabled) return true;
  if (isStub(agent)) return true;
  return !agent || agent.enabled !== false;
}

/**
 * Layer 3 — apply the current filter to the ordered groups/singles. Groups with
 * neither a matching header nor any matching child drop out entirely.
 *
 * `showDisabled` (default off, matching the pre-#1928 behaviour) additionally
 * admits `enabled: false` rows.
 */
export function filterModel(orderedGroups, orderedSingles, filter, showDisabled = false) {
  const keep = a => matchesFilter(a, filter) && passesDisabledFilter(a, showDisabled);

  const visibleGroups = orderedGroups
    .map(group => {
      const header   = group.header && keep(group.header) ? group.header : null;
      const children = group.children.filter(keep);
      // The team filter narrows the stub section exactly like the member list;
      // a group whose only surviving rows are stubs still belongs in the list
      // (a fully-deferred team is the whole point of #1957).
      const stubs    = (group.stubs || []).filter(keep);
      return { ...group, header, children, stubs };
    })
    .filter(group => group.header || group.children.length > 0 || group.stubs.length > 0);

  const visibleSingles = orderedSingles.filter(keep);

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
export function buildAgentListModel(agents, sidebarOrder, filter, showDisabled = false) {
  const { groups, singles } = buildGroups(agents);
  const { orderedGroups, orderedSingles } = orderModel(groups, singles, sidebarOrder);
  return filterModel(orderedGroups, orderedSingles, filter, showDisabled);
}
