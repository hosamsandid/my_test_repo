import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { MessageCircle, Bot, Server, Users, ChevronDown, ChevronRight, GripVertical, MoreVertical, Loader2, AlertTriangle, ExternalLink } from 'lucide-react';

import { computeReorder, dropPosition } from './agent-list-dnd.js';
import { groupEnvironmentName, rowEnvironmentName } from './agent-list-env.js';
import { buildGroups, groupKey, orderModel, filterModel, stubSectionLabel, poolInstancesLabel, poolInstanceCounts, poolWaitingLabel } from './agent-list-model.js';
import { poolCapView } from '../process/pool-cap-view.js';
import { teamMembershipIndicator, membershipsByTeam, fitAdminNames } from './team-membership-view.js';
import { computeTeamAttention } from '../../context/agent-statuses.js';
import { agentState, isChatOpenable } from '../agent-lifecycle/agent-lifecycle-menu.js';
import { revealPlan } from './reveal-agent.js';
import {
  removedInstancesLabel, showRemovedInstances, removedInstanceName, removedInstanceFacts, itemUrl,
} from './removed-instance-view.js';
import {
  SHOW_ALL, NO_SELECTION_HINT, INDIVIDUAL_LABEL, selectionEntries, shownEntries, reorderAllowed,
} from './list-selection.js';

// Re-exported so `AgentChat` can populate the filter dropdown without importing
// the model module directly (the grouping logic used to live in this file).
export { buildGroups } from './agent-list-model.js';

// The accessible name of the rail's top-level `list` (#2704).
const RAIL_LABEL = 'Agents';

/**
 * A `<button>` with the browser chrome stripped so it lays out like the row
 * text it wraps (#2704): the rows' main buttons and the chevron/kebab controls
 * beside them inherit the row's font, colour and casing, and keep the
 * browser's own focus ring.
 */
const BARE_BUTTON_STYLE = {
  display: 'flex',
  alignItems: 'center',
  padding: 0,
  margin: 0,
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  font: 'inherit',
  letterSpacing: 'inherit',
  textTransform: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
};

const COLLAPSED_KEY = 'agentChat.collapsedGroups';
const ORDER_KEY = 'agentChat.sidebarOrder';

/**
 * Module-level default for the `busyIds` prop so an embedding that passes none
 * hands the memoized rows the *same* empty Set on every render (a `new Set()`
 * default would change identity each time and defeat `React.memo`).
 */
const EMPTY_BUSY = new Set();

/**
 * Shared empty membership list handed to a team group that has no rows in the
 * `GET /api/admin/memberships` payload — a *stable* reference so a memoized
 * `GroupSection` for such a team is never re-rendered by a fresh `[]` each poll.
 */
const EMPTY_MEMBERSHIPS = [];

/**
 * Per-entity collapse-state defaults, keyed by `kind` in the same `<kind>:<id>`
 * namespace `groupKey` uses for teams — matches the Agents overview page so the
 * chat sidebar behaves consistently: teams (and, since #2297, a role's pool
 * instances) default open.
 */
const DEFAULT_COLLAPSED = {
  team: false,
  pool: false,
  // #2944 AC3: a role's removed instances are history, not live activity.
  archive: true,
};

/**
 * At-rest visual treatment that reads a team's header + all its member rows
 * (active members, the nested pool-instance sub-list and the stub sub-list) as
 * ONE grouped block, clearly separated from the next team's block (#2370). A
 * subtle `--eb-bg-surface` panel + a 1px border + rounded corners draw the
 * boundary without hover/selection, and the `marginBottom` gap is what the eye
 * uses to tell where one team ends and the next begins even with many teams
 * stacked in the rail. All tokens, so it follows the active light/dark theme.
 *
 * The "Individual agents" section (a plain `SectionHeader` + ungrouped rows) is
 * deliberately NOT wrapped in this, so ungrouped agents stay visually distinct
 * from an actual team (AC6).
 */
const TEAM_BLOCK_STYLE = {
  marginBottom: 'var(--eb-space-2)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  background: 'var(--eb-bg-surface)',
};

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveCollapsed(map) {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

function loadOrder() {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      singles: Array.isArray(parsed.singles) ? parsed.singles : [],
      // Per-group member order, keyed by `<kind>:<id>` → ordered member ids.
      members: (parsed.members && typeof parsed.members === 'object' && !Array.isArray(parsed.members))
        ? parsed.members
        : {},
    };
  } catch {
    return { groups: [], singles: [], members: {} };
  }
}
function saveOrder(order) {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)); } catch {}
}

/**
 * Grouped, optionally filtered, vertical agent list for the chat left rail.
 *
 * Disabled agents stay clickable so the user can see the "agent disabled"
 * hint inside the chat panel — we don't want a silent no-op.
 *
 * @param {object[]} agents          List of `/api/matrix/agents` entries
 * @param {string|null} selectedAgentId
 * @param {(id:string)=>void} onSelect
 * @param {Record<string,string>} statuses  Map agentId → activityState
 * @param {{hidden:string[]}} filter  The rail team selection (#2740, list-selection.js)
 * @param {boolean} showDisabled  Opt-in: also list disabled agents (#1928 AC6)
 * @param {Set<string>} busyIds   ids with a lifecycle mutation in flight, owned
 *   by `RailLifecycleHost` and passed down so a **Materialize** shows progress
 *   on the row it was started from (#1957 AC5) — materializing clones the
 *   role's repositories, so it can take a while and must not look frozen.
 * @param {(target:{kind:'agent'|'team',agent?:object,group?:object}, anchor:{x:number,y:number})=>void} onRequestMenu
 *   Lifecycle quick actions (#1928). The rail only reports *where* a menu was
 *   asked for and *for what* — which entries it gets, and what they do, is the
 *   caller's business (it owns the dialogs and the API calls). Omitted → the
 *   rail renders no kebabs and right-click keeps the browser menu, so every
 *   other embedding of this list is unaffected.
 * @param {(teamId:string)=>void} onOpenTeamSettings
 *   Clicking a team's header row, anywhere but its chevron (#2213), moves the
 *   selection onto the team (via `onSelect`) and opens the Settings tab for it
 *   — a team hosts no chat of its own, so selecting one is otherwise a dead
 *   end. Omitted → the header row only toggles/selects, same as before.
 * @param {object[]} memberships  Flat `GET /api/admin/memberships` payload (all
 *   of the caller's teams), driving the team-header membership indicator (#2381).
 * @param {object[]} directory    `GET /api/users/directory` — resolves member
 *   ids to display names for that indicator.
 * @param {string|null} viewerId  The viewing user's id, so a team-of-one reads
 *   as "Private" for its owner and as that person's name for anyone else.
 * @param {(roleId:string, key:string)=>void} onOpenArchive  Opens a removed pool
 *   instance's archive (#2944). Omitted → no "Removed instances" groups.
 * @param {string|null} selectedArchiveKey  The archive open in the chat area.
 */
export default function AgentList({
  agents,
  selectedAgentId,
  onSelect,
  statuses = {},
  filter = SHOW_ALL,
  showDisabled = false,
  busyIds = EMPTY_BUSY,
  onRequestMenu = null,
  onOpenTeamSettings = null,
  memberships = EMPTY_MEMBERSHIPS,
  directory = EMPTY_MEMBERSHIPS,
  viewerId = null,
  revealRequest = null,
  onOpenArchive = null,
  selectedArchiveKey = null,
}) {
  // Index memberships by team id once per membership change (#2381). Rebuilds
  // only when the polled `memberships` array identity changes — the hook keeps
  // that reference stable across no-op polls — so a team header is not re-grouped
  // every 5s.
  const membershipMap = useMemo(() => membershipsByTeam(memberships), [memberships]);
  const [sidebarOrder, setSidebarOrder] = useState(loadOrder);
  useEffect(() => { saveOrder(sidebarOrder); }, [sidebarOrder]);

  // ── Memoized grouping pipeline (#1682) ──────────────────────────────────
  // The three layers each memoize on their own inputs, so a render that leaves
  // `agents` untouched — a status poll, or a `dragover` that only nudges the
  // drop indicator — never re-runs the ~10-pass `buildGroups`. Splitting the
  // layers means a filter change re-runs only the filter pass, not the grouping.
  const { groups: rawGroups, singles: rawSingles } = useMemo(
    () => buildGroups(agents),
    [agents],
  );
  const { orderedGroups, orderedSingles } = useMemo(
    () => orderModel(rawGroups, rawSingles, sidebarOrder),
    [rawGroups, rawSingles, sidebarOrder],
  );
  const { visibleGroups, visibleSingles, empty } = useMemo(
    () => filterModel(orderedGroups, orderedSingles, filter, showDisabled),
    [orderedGroups, orderedSingles, filter, showDisabled],
  );

  // Group and single-agent reorder are only offered when every entry is
  // selected, so the visual position matches the stored order — with teams
  // hidden a move would be ambiguous. Member-within-group reorder is
  // unambiguous for every shown team whatever else the filter hides: the
  // filter never hides a shown team's members (#1725, #2740 AC11, #2846).
  const selectionEntryList = useMemo(
    () => selectionEntries(rawGroups, rawSingles),
    [rawGroups, rawSingles],
  );
  const { groups: canReorder, members: canReorderMembers } = useMemo(
    () => reorderAllowed(selectionEntryList, filter),
    [selectionEntryList, filter],
  );
  const nothingSelected = selectionEntryList.length > 0 && shownEntries(selectionEntryList, filter).length === 0;

  // Latest ordered lists behind a ref so the reorder/drag callbacks below stay
  // referentially stable across renders — otherwise every memoized row would
  // re-render whenever the ordered lists were rebuilt.
  const orderedRef = useRef(null);
  orderedRef.current = { orderedGroups, orderedSingles };

  const currentKeysForScope = useCallback((scope) => {
    const { orderedGroups: og, orderedSingles: os } = orderedRef.current;
    if (scope === 'groups') return og.map(groupKey);
    if (scope === 'singles') return os.map(a => a.id);
    if (scope.startsWith('members:')) {
      const key = scope.slice('members:'.length);
      const g = og.find(gr => groupKey(gr) === key);
      return g ? g.children.map(a => a.id) : [];
    }
    return [];
  }, []);

  const persistScopeOrder = useCallback((scope, next) => {
    if (scope === 'groups') setSidebarOrder(prev => ({ ...prev, groups: next }));
    else if (scope === 'singles') setSidebarOrder(prev => ({ ...prev, singles: next }));
    else if (scope.startsWith('members:')) {
      const key = scope.slice('members:'.length);
      setSidebarOrder(prev => ({ ...prev, members: { ...prev.members, [key]: next } }));
    }
  }, []);

  // Single-step Alt+↑/↓ keyboard reorder, unified across groups / singles /
  // members: the row already carries its own drag scope + key, so one stable
  // callback replaces the three per-row moveGroup/moveSingle/moveMember
  // closures (which changed identity every render and defeated row memoization).
  // A move past either end is a no-op, so the same handler serves top and bottom
  // rows without per-row up/down gating.
  const reorderByOne = useCallback((scope, key, direction) => {
    const keys = currentKeysForScope(scope);
    const idx = keys.indexOf(key);
    if (idx === -1) return;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= keys.length) return;
    const next = [...keys];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    persistScopeOrder(scope, next);
  }, [currentKeysForScope, persistScopeOrder]);

  // ── Drag & drop reordering (#1304) ──────────────────────────────────────
  // Additive to the keyboard path: relocates an item in one gesture, writing
  // to the same `agentChat.sidebarOrder` key arrays so a drag-produced order is
  // indistinguishable from a keyboard-produced one after a reload (AC5/AC6).
  //
  // A "scope" pins each drag to one list — `'groups'`, `'singles'`, or
  // `'members:<groupKey>'`. The dragover handler refuses to allow a drop when
  // the target scope differs from the drag source, so an item can never leave
  // its own list (AC4): the browser only fires `drop` on a row whose `dragover`
  // called `preventDefault()`.
  const dragRef = useRef(null);                 // { scope, key } for synchronous scope checks
  const [dragging, setDragging] = useState(null); // { scope, key } — dims the dragged row
  const [dropHint, setDropHint] = useState(null); // { scope, key, position } — insertion indicator

  const clearDrag = useCallback(() => {
    dragRef.current = null;
    setDragging(null);
    setDropHint(null);
  }, []);

  // Stable across renders (idle → same `dragHandlers`), so a row's drop handlers
  // never change identity except when a drag is actually in progress.
  const dragHandlers = useMemo(() => ({
    onStart(scope, key) {
      dragRef.current = { scope, key };
      setDragging({ scope, key });
    },
    // Returns true when the drop is allowed (same scope) so the caller can
    // `preventDefault()` — the only way to enable the subsequent `drop`.
    onOver(scope, key, position) {
      const d = dragRef.current;
      if (!d || d.scope !== scope) return false;   // cross-scope → reject (AC4)
      if (d.key === key) { setDropHint(null); return true; } // over self: droppable no-op, no line
      setDropHint(cur =>
        (cur && cur.scope === scope && cur.key === key && cur.position === position)
          ? cur
          : { scope, key, position });
      return true;
    },
    onDrop(scope, key, position) {
      const d = dragRef.current;
      clearDrag();
      if (!d || d.scope !== scope) return;
      const next = computeReorder(currentKeysForScope(scope), d.key, key, position);
      if (next) persistScopeOrder(scope, next);
    },
    onEnd() { clearDrag(); },
  }), [clearDrag, currentKeysForScope, persistScopeOrder]);

  // Only the `dragging`/`dropHint` fields change mid-drag; idle it is a stable
  // object, so memoized rows outside the active drag never re-render.
  const drag = useMemo(
    () => ({ handlers: dragHandlers, dragging, dropHint }),
    [dragHandlers, dragging, dropHint],
  );

  // Persisted collapse state for any `{kind, id}` entity — teams, and since
  // #2297 a role's pool-instances sub-list (`{kind:'pool', id:<roleId>}`).
  // Keyed by `<kind>:<id>` — the namespace `groupKey` uses everywhere, so a
  // stored key stays readable across kinds.
  const [collapsedMap, setCollapsedMap] = useState(loadCollapsed);
  useEffect(() => { saveCollapsed(collapsedMap); }, [collapsedMap]);

  // A stable identity matters here too (#2297): it is now passed down as
  // `isEntityCollapsed` for a memoized `GroupSection` to compute a pool
  // sub-list's own collapse state, and a fresh function on every render would
  // defeat that row's memoization on every status poll, same as `toggleCollapsed`.
  const isCollapsed = useCallback((entity) => {
    const key = `${entity.kind}:${entity.id}`;
    if (Object.prototype.hasOwnProperty.call(collapsedMap, key)) return collapsedMap[key];
    return DEFAULT_COLLAPSED[entity.kind] ?? false;
  }, [collapsedMap]);
  // Stable so a memoized GroupSection is not forced to re-render every time the
  // parent re-renders; the previous value is read from the functional updater.
  const toggleCollapsed = useCallback((entity) => {
    const key = `${entity.kind}:${entity.id}`;
    setCollapsedMap(prev => {
      const cur = Object.prototype.hasOwnProperty.call(prev, key)
        ? prev[key]
        : (DEFAULT_COLLAPSED[entity.kind] ?? false);
      return { ...prev, [key]: !cur };
    });
  }, []);

  // #2521: a just-created agent the page asked to reveal. Its team group is
  // expanded here (persisted like a manual toggle — the user is being shown
  // the team, so leaving it open is what they would do anyway); the stub
  // section and the row's scroll-into-view are handled by the components that
  // own them, keyed on `revealId`. Only the target row gets a truthy `reveal`,
  // so the memoized rows elsewhere are untouched.
  const revealId = revealRequest?.id || null;
  const revealTeamId = useMemo(
    () => (revealId ? (agents || []).find(a => a.id === revealId)?.parentTeamId || null : null),
    [revealId, agents],
  );
  useEffect(() => {
    if (!revealRequest) return;
    const target = (agents || []).find(a => a.id === revealRequest.id) || null;
    const { groupKey: key } = revealPlan(target, filter);
    if (!key) return;
    setCollapsedMap(prev => (prev[key] === true ? { ...prev, [key]: false } : prev));
    // Re-run per request, not per roster tick: `agents` is read, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequest]);

  return (
    // A uniform `--eb-space-2` gutter around the whole list so the rounded team
    // blocks (`TEAM_BLOCK_STYLE`) breathe on every side by the SAME amount that
    // separates one team from the next (#2370 follow-up): without it the cards
    // sat flush against the rail's top/left edge while only their `marginBottom`
    // gap — and the scrollbar on the right — gave them any room. The inset also
    // aligns the ungrouped "Individual agents" rows to the same left edge as the
    // cards' outer margin.
    //
    // #2704: the rail is a named `list` of team blocks, each a `listitem` that
    // holds its header row plus a nested `list` of member rows — not a
    // `listbox`. A listbox may only own `option`s, and an option may not
    // contain the kebab/drag-grip controls every row carries; with a plain list
    // the row's main `<button>` and those controls sit side by side inside the
    // `listitem`. The empty-state hint sits outside the list so the list never
    // owns a non-`listitem` child.
    <div style={{ display: 'flex', flexDirection: 'column', padding: 'var(--eb-space-2)' }}>
      <div role="list" aria-label={RAIL_LABEL} style={{ display: 'flex', flexDirection: 'column' }}>
        {visibleGroups.map((group) => (
          <GroupSection
            key={`${group.kind}:${group.id}`}
            group={group}
            collapsed={isCollapsed(group)}
            onToggle={toggleCollapsed}
            selectedAgentId={selectedAgentId}
            onSelect={onSelect}
            statuses={statuses}
            memberReorder={canReorderMembers}
            onReorder={reorderByOne}
            drag={drag}
            groupDragKey={groupKey(group)}
            dragEnabled={canReorder && visibleGroups.length > 1}
            busyIds={busyIds}
            onRequestMenu={onRequestMenu}
            onOpenTeamSettings={onOpenTeamSettings}
            isEntityCollapsed={isCollapsed}
            teamMemberships={membershipMap.get(group.id) || EMPTY_MEMBERSHIPS}
            directory={directory}
            viewerId={viewerId}
            revealId={group.id === revealTeamId ? revealId : null}
            onOpenArchive={onOpenArchive}
            selectedArchiveKey={selectedArchiveKey}
          />
        ))}

        {visibleSingles.length > 0 && (
          <div role="listitem">
            <SectionHeader label={INDIVIDUAL_LABEL} icon={MessageCircle} />
            <div role="list" aria-label={INDIVIDUAL_LABEL}>
              {visibleSingles.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  selected={agent.id === selectedAgentId}
                  onSelect={onSelect}
                  activityState={statuses[agent.id] || 'idle'}
                  // Ungrouped: no header to hoist the environment to (#1451).
                  environmentName={rowEnvironmentName(agent)}
                  onReorder={reorderByOne}
                  drag={drag}
                  dragScope="singles"
                  dragKey={agent.id}
                  dragEnabled={canReorder && visibleSingles.length > 1}
                  onRequestMenu={onRequestMenu}
                  reveal={agent.id === revealId}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {empty && (
        <div style={{
          padding: 'var(--eb-space-4)',
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-muted)',
          textAlign: 'center',
          lineHeight: 1.5,
        }}>
          {nothingSelected ? NO_SELECTION_HINT : 'No agents match this filter.'}
        </div>
      )}
    </div>
  );
}

const GroupSection = React.memo(function GroupSection({
  group,
  collapsed,
  onToggle,
  selectedAgentId,
  onSelect,
  statuses,
  memberReorder,
  onReorder,
  drag,
  groupDragKey,
  dragEnabled,
  isEntityCollapsed,
  busyIds,
  onRequestMenu,
  onOpenTeamSettings,
  teamMemberships,
  directory,
  viewerId,
  revealId = null,
  onOpenArchive = null,
  selectedArchiveKey = null,
}) {
  const Icon = Users;
  const stubs = group.stubs || [];
  // Stubs count towards the header's total (#1957): they are members of this
  // team, and a team whose members are *all* stubs would otherwise announce
  // itself with a `0` next to a section listing several names. The team
  // `group.header` row itself is the template, not a member (it hosts no chat),
  // so it is deliberately NOT counted here (#2216).
  const count = group.children.length + stubs.length;
  const memberScope = `members:${groupDragKey}`;
  const memberDragEnabled = memberReorder && group.children.length > 1;
  const handleToggle = useCallback(() => onToggle(group), [onToggle, group]);
  // Clicking the header row anywhere but its chevron (#2213) moves the real
  // selection onto the team — `group.id` is the team's own agent id whether or
  // not its row is currently visible (a filtered-out/orphaned header) — and,
  // only when this caller may manage it, opens the Settings tab for it. An
  // unmanageable team still gets a real selection; it just gets no Settings
  // tab, matching the tab's own visibility rule elsewhere (`settingsSubject`).
  const canManageTeam = group.header ? group.header.canManage !== false : true;
  const handleActivate = useCallback(() => {
    onSelect(group.id);
    if (onOpenTeamSettings && canManageTeam) onOpenTeamSettings(group.id);
  }, [onSelect, onOpenTeamSettings, group.id, canManageTeam]);
  // Team management (AC2) hangs off the group header.
  const headerMenu = onRequestMenu
    ? anchor => onRequestMenu({ kind: 'team', group }, anchor)
    : null;
  // The Working Environment shared by this group's rows is still hoisted to the
  // group for its MEMBER rows (#1451) — they inherit it and drop their own line
  // — but since #2381 it is no longer shown on the header itself: that line now
  // carries the team-membership indicator instead.
  const groupEnv = groupEnvironmentName(group);
  // Who is behind this team (#2381, broadened #2387): "Private", the full member
  // list (Team Admins first, then Team Members), or nothing.
  // Recomputed only when this team's own membership list, the directory, or the
  // viewer changes — all stable across no-op polls — so the header is not
  // re-rendered on every 5s roster/membership tick.
  const membershipIndicator = useMemo(
    () => teamMembershipIndicator({ memberships: teamMemberships, directory, viewerId }),
    [teamMemberships, directory, viewerId],
  );
  // #2430 — roll the attention-worthy member states (a reply awaiting you / a
  // busy agent) up onto the header so a collapsed team still shows *which* team
  // needs the user. The rollup spans the team's active members and their pool
  // instances — the same ids the poll tracks; stubs carry no poll status and
  // never surface. Recomputed only when the status map or the membership shape
  // changes (the ids array is stable across a no-op poll), so it does not defeat
  // the header's memoisation. The header renders it only while collapsed (AC6).
  const memberIds = useMemo(() => {
    const ids = [];
    for (const agent of group.children) {
      ids.push(agent.id);
      if (agent.instances) for (const inst of agent.instances) ids.push(inst.id);
    }
    return ids;
  }, [group.children]);
  const attention = useMemo(
    () => computeTeamAttention(memberIds, statuses),
    [memberIds, statuses],
  );
  return (
    <div role="listitem" style={TEAM_BLOCK_STYLE}>
      <CollapsibleHeader
        label={group.displayName}
        icon={Icon}
        subtle={!group.header}
        count={count}
        attention={attention}
        membershipIndicator={membershipIndicator}
        collapsed={collapsed}
        selected={selectedAgentId === group.id}
        onToggle={handleToggle}
        onActivate={handleActivate}
        onReorder={onReorder}
        drag={drag}
        dragScope="groups"
        dragKey={groupDragKey}
        dragEnabled={dragEnabled}
        onRequestMenu={headerMenu}
      />
      {/*
       * The team's `group.header` (`role: 'team'`) is NOT rendered as a member
       * row (#2216). It is a tokenless template that hosts no chat of its own,
       * and the CollapsibleHeader above IS its interactive row: clicking it
       * selects the team and opens Settings (#2213), and it carries the team
       * kebab menu. Rendering it a second time as an AgentRow only duplicated
       * the team (a redundant, mislabeled "DISABLED" row) — a leftover from the
       * pre-#1964 model where a group header was a chat-openable orchestrator.
       */}
      {!collapsed && (group.children.length > 0 || stubs.length > 0) && (
        <div role="list" aria-label={group.displayName}>
          {group.children.map((agent) => (
            <React.Fragment key={agent.id}>
              <AgentRow
                agent={agent}
                selected={agent.id === selectedAgentId}
                onSelect={onSelect}
                activityState={statuses[agent.id] || 'idle'}
                environmentName={rowEnvironmentName(agent, groupEnv)}
                indent
                onReorder={onReorder}
                drag={drag}
                dragScope={memberScope}
                dragKey={agent.id}
                dragEnabled={memberDragEnabled}
                onRequestMenu={onRequestMenu}
                reveal={agent.id === revealId}
              />
              {/*
               * A pooled role's live instances (#2297), nested directly under it —
               * collapsible and persisted like a team group (`{kind:'pool', id}`),
               * unlike the stub section's own always-collapsed, unpersisted default.
               * Empty when the role is not pooled or has no live instances (AC1).
               */}
              {agent.instances && agent.instances.length > 0 && (
                <PoolInstancesSection
                  roleAgent={agent}
                  instances={agent.instances}
                  groupEnv={groupEnv}
                  collapsed={isEntityCollapsed({ kind: 'pool', id: agent.id })}
                  onToggle={onToggle}
                  selectedAgentId={selectedAgentId}
                  onSelect={onSelect}
                  statuses={statuses}
                  busyIds={busyIds}
                  onRequestMenu={onRequestMenu}
                />
              )}
              {/*
               * Its removed instances (#2944 AC3), read-only archives kept for the
               * role's retention — collapsed by default, hidden when there are none.
               */}
              {onOpenArchive && showRemovedInstances(agent) && (
                <RemovedInstancesSection
                  roleAgent={agent}
                  collapsed={isEntityCollapsed({ kind: 'archive', id: agent.id })}
                  onToggle={onToggle}
                  onOpenArchive={onOpenArchive}
                  selectedKey={agent.id === selectedAgentId ? selectedArchiveKey : null}
                />
              )}
            </React.Fragment>
          ))}
          {/*
           * The team's not-yet-materialized members (#1957), below the active ones
           * and behind their own collapsed sub-header. A group with no stubs renders
           * nothing at all here (AC2) — the section is never an empty affordance.
           */}
          {stubs.length > 0 && (
            <StubSection
              stubs={stubs}
              groupEnv={groupEnv}
              selectedAgentId={selectedAgentId}
              onSelect={onSelect}
              busyIds={busyIds}
              onRequestMenu={onRequestMenu}
              revealId={revealId}
            />
          )}
        </div>
      )}
    </div>
  );
});

/**
 * "Not materialized yet (N)" — the collapsed home for a team's stub members
 * (#1957).
 *
 * Collapsed by default and never persisted, unlike the group collapse state: a
 * stub section is a to-do list that empties itself as members are materialized,
 * so remembering that it was once open would keep re-opening a section that no
 * longer has anything to show. The count is on the header, so the number is
 * readable without expanding (AC2).
 *
 * Its rows are ordinary `AgentRow`s: a stub is already not chat-openable
 * (`isChatOpenable` is false for anything disabled), so clicking one opens its
 * menu — where **Materialize** sits — exactly as a paused row does. They inherit
 * the group's hoisted environment (#1451) but deliberately do not *vote* on what
 * it is: `groupEnvironmentName` keeps reading the header + active members only,
 * so adding stubs to a team can never flip an existing group's hoist.
 */
function StubSection({ stubs, groupEnv, selectedAgentId, onSelect, busyIds, onRequestMenu, revealId = null }) {
  // Collapsed by default — except when it holds the agent the page was asked
  // to reveal (#2521 AC6: a just-created stub first agent must be visible).
  const holdsReveal = !!revealId && stubs.some(s => s.id === revealId);
  const [collapsed, setCollapsed] = useState(!holdsReveal);
  useEffect(() => {
    if (holdsReveal) setCollapsed(false);
  }, [holdsReveal]);
  const [hovered, setHovered] = useState(false);
  const label = stubSectionLabel(stubs.length);
  return (
    <div role="listitem">
      <button
        type="button"
        onClick={() => setCollapsed(v => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-expanded={!collapsed}
        title="Members that exist as configuration only — materialize one to start it"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
          width: '100%',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          // #2389: stays aligned with its (now un-indented) stub rows.
          paddingLeft: 'var(--eb-space-3)',
          background: hovered ? 'var(--eb-bg-hover)' : 'transparent',
          border: 'none',
          fontSize: 'var(--eb-text-xs)',
          fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-muted)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          transition: 'background var(--eb-transition-fast)',
        }}
      >
        {collapsed
          ? <ChevronRight size={12} style={{ flexShrink: 0 }} />
          : <ChevronDown  size={12} style={{ flexShrink: 0 }} />}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
      </button>
      {!collapsed && (
        <div role="list" aria-label={label}>
          {stubs.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              selected={agent.id === selectedAgentId}
              onSelect={onSelect}
              // A stub has no chat identity, so the status poll never keys on it —
              // its row state comes from its own payload (see `AgentRow`).
              activityState="idle"
              environmentName={rowEnvironmentName(agent, groupEnv)}
              indent
              busy={busyIds.has(agent.id)}
              onRequestMenu={onRequestMenu}
              reveal={agent.id === revealId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * "Instances (N)" — a pooled role's live `<team>-<role>-i<item>` instances,
 * nested directly under the role that spawned them (#2297).
 *
 * Unlike `StubSection`, collapse state is **persisted** like a team group
 * (`{kind:'pool', id:<roleId>}` in the same `collapsedMap`, owned by the
 * parent `AgentList`) rather than local always-collapsed state: an instance
 * list is live pool activity an operator wants to keep an eye on, not a to-do
 * list that empties itself.
 *
 * Rows are ordinary `AgentRow`s at one indent level deeper than the role
 * itself — same status dot (fed by the same `statuses` poll every other
 * enabled row uses) and the same click-to-select/session-log path, so an
 * instance is inspectable exactly like any other agent.
 */
function PoolInstancesSection({ roleAgent, instances, groupEnv, collapsed, onToggle, selectedAgentId, onSelect, statuses, busyIds, onRequestMenu }) {
  const [hovered, setHovered] = useState(false);
  // #2760 AC5: the count reads against the role's cap ("5 / 3"), and an
  // over-cap count is marked, its tooltip saying what that means.
  // #2789 AC9: instances waiting on an open PR are outside the cap and are
  // counted apart ("2 / 3 active · 4 waiting").
  const cap = roleAgent.poolMaxInstances ?? null;
  const counts = poolInstanceCounts(instances);
  const label = poolInstancesLabel(counts.active, cap, counts.waiting);
  const capView = poolCapView(counts.active, cap, counts.waiting);
  const handleToggle = useCallback(
    () => onToggle({ kind: 'pool', id: roleAgent.id }),
    [onToggle, roleAgent.id],
  );
  return (
    <div role="listitem">
      <button
        type="button"
        onClick={handleToggle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-expanded={!collapsed}
        title={`Live pool instances of ${roleAgent.displayName || roleAgent.id}: ${capView.title}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
          width: '100%',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          // #2389: stays aligned with its instance rows (indent={2} → one step).
          paddingLeft: 'calc(var(--eb-space-3) + var(--eb-space-4))',
          background: hovered ? 'var(--eb-bg-hover)' : 'transparent',
          border: 'none',
          fontSize: 'var(--eb-text-xs)',
          fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-muted)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          transition: 'background var(--eb-transition-fast)',
        }}
      >
        {collapsed
          ? <ChevronRight size={12} style={{ flexShrink: 0 }} />
          : <ChevronDown  size={12} style={{ flexShrink: 0 }} />}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        {capView.over && (
          <AlertTriangle
            size={12}
            role="img"
            aria-label="Over the instance limit"
            style={{ flexShrink: 0, color: 'var(--eb-status-warning)' }}
          />
        )}
      </button>
      {!collapsed && (
        <div role="list" aria-label={label}>
          {instances.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              selected={agent.id === selectedAgentId}
              onSelect={onSelect}
              activityState={statuses[agent.id] || 'idle'}
              environmentName={rowEnvironmentName(agent, groupEnv)}
              indent={2}
              busy={busyIds.has(agent.id)}
              onRequestMenu={onRequestMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * "Removed instances (N)" — a pooled role's reaped instances whose chat history
 * and session log are still archived (#2944). Persisted collapse state like
 * "Instances" (`{kind:'archive', id:<roleId>}`), collapsed by default. The
 * roster only carries the count; the entries are fetched while the group is
 * open, and again when the count moves.
 *
 * An entry is not an agent any more, so it is not an `AgentRow`: no status dot,
 * no menu — a "Removed" badge (never a faded row), its facts, and a link to its
 * GitHub item. Clicking it opens the read-only archive view.
 */
function RemovedInstancesSection({ roleAgent, collapsed, onToggle, onOpenArchive, selectedKey }) {
  const [hovered, setHovered] = useState(false);
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const count = roleAgent.poolArchiveCount;
  const label = removedInstancesLabel(count);
  const handleToggle = useCallback(
    () => onToggle({ kind: 'archive', id: roleAgent.id }),
    [onToggle, roleAgent.id],
  );
  useEffect(() => {
    if (collapsed) return undefined;
    let live = true;
    setError(null);
    fetch(`/api/agents/${encodeURIComponent(roleAgent.id)}/pool-archive`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => { if (live) setEntries(Array.isArray(data?.entries) ? data.entries : []); })
      .catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [collapsed, roleAgent.id, count]);
  return (
    <div role="listitem">
      <button
        type="button"
        onClick={handleToggle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-expanded={!collapsed}
        title={`Removed pool instances of ${roleAgent.displayName || roleAgent.id} whose chat history and session log are still readable`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
          width: '100%',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          paddingLeft: 'calc(var(--eb-space-3) + var(--eb-space-4))',
          background: hovered ? 'var(--eb-bg-hover)' : 'transparent',
          border: 'none',
          fontSize: 'var(--eb-text-xs)',
          fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-muted)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          transition: 'background var(--eb-transition-fast)',
        }}
      >
        {collapsed
          ? <ChevronRight size={12} style={{ flexShrink: 0 }} />
          : <ChevronDown  size={12} style={{ flexShrink: 0 }} />}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
      </button>
      {!collapsed && (
        <div role="list" aria-label={label}>
          {error && (
            <div role="listitem" style={{ ...REMOVED_ROW_STYLE, color: 'var(--eb-status-error)' }}>
              Could not load removed instances ({error})
            </div>
          )}
          {!error && entries === null && (
            <div role="listitem" style={{ ...REMOVED_ROW_STYLE, color: 'var(--eb-text-muted)' }}>Loading…</div>
          )}
          {(entries || []).map((entry) => (
            <RemovedInstanceRow
              key={entry.key}
              entry={entry}
              roleAgent={roleAgent}
              selected={entry.key === selectedKey}
              onOpen={onOpenArchive}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const REMOVED_ROW_STYLE = {
  padding: 'var(--eb-space-1) var(--eb-space-3)',
  paddingLeft: 'calc(var(--eb-space-3) + var(--eb-space-4) * 2)',
  fontSize: 'var(--eb-text-xs)',
};

function RemovedInstanceRow({ entry, roleAgent, selected, onOpen }) {
  const [hovered, setHovered] = useState(false);
  const name = removedInstanceName(entry, roleAgent);
  const url = itemUrl(entry.repo, entry.item);
  const facts = removedInstanceFacts(entry);
  const open = useCallback(() => onOpen(roleAgent.id, entry.key), [onOpen, roleAgent.id, entry.key]);
  return (
    <div
      role="listitem"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...REMOVED_ROW_STYLE,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--eb-space-2)',
        background: selected ? 'var(--eb-bg-selected)' : (hovered ? 'var(--eb-bg-hover)' : 'transparent'),
        borderLeft: selected ? '3px solid var(--eb-accent-primary)' : '3px solid transparent',
      }}
    >
      <button
        type="button"
        onClick={open}
        aria-current={selected ? 'true' : undefined}
        title={`Open the archived chat history and session log of ${entry.instanceId}`}
        style={{ ...BARE_BUTTON_STYLE, flex: 1, minWidth: 0, flexDirection: 'column', alignItems: 'stretch', gap: 2 }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', minWidth: 0 }}>
          <span style={{
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)',
          }}>
            {name}
          </span>
          <span style={REMOVED_BADGE_STYLE}>Removed</span>
        </span>
        {facts.map(([k, v]) => (
          <span key={k} style={{ color: 'var(--eb-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {k}: {v}
          </span>
        ))}
      </button>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${entry.repo}#${entry.item} on GitHub`}
          aria-label={`Open ${entry.repo}#${entry.item} on GitHub`}
          style={{ flexShrink: 0, color: 'var(--eb-accent-primary)', display: 'inline-flex', paddingTop: 2 }}
        >
          <ExternalLink size={12} />
        </a>
      )}
    </div>
  );
}

// Same badge as a row's "Disabled"/"Not initialised" state (#2944 AC3: a badge,
// not opacity).
const REMOVED_BADGE_STYLE = {
  flexShrink: 0,
  padding: '0 4px',
  borderRadius: 'var(--eb-radius-sm)',
  border: '1px solid var(--eb-border-default)',
  fontSize: 'var(--eb-text-xs)',
  lineHeight: 1.5,
  color: 'var(--eb-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

function CollapsibleHeader({ label, icon: Icon, subtle, count, attention, membershipIndicator, collapsed, selected, onToggle, onActivate, onReorder, drag, dragScope, dragKey, dragEnabled, onRequestMenu }) {
  const [hovered, setHovered] = useState(false);

  const dnd = dragEnabled && drag ? makeRowDnd(drag, dragScope, dragKey) : null;

  // #2704: the header is a row *of* controls rather than one `<button>` that
  // nests them — chevron, the main select button, kebab and grip are siblings,
  // so none of them is an interactive element inside another. The row itself
  // still takes the click anywhere outside those controls (the count, the
  // attention dots, the padding): a click on the main button bubbles up here
  // too — including the one a browser synthesises for Enter/Space — and the
  // chevron/kebab/grip stop propagation so they never also activate the team.
  // The key handler lives on the row for the same reason: Alt+↑/↓ and the
  // context-menu keys work from whichever of its controls has focus.
  return (
    <div
      onClick={onActivate}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragOver={dnd ? dnd.onDragOver : undefined}
      onDrop={dnd ? dnd.onDrop : undefined}
      onContextMenu={onRequestMenu ? e => {
        e.preventDefault();
        onRequestMenu({ x: e.clientX, y: e.clientY });
      } : undefined}
      onKeyDown={e => {
        // Shift+F10 / the Menu key are the platform keyboard paths to a context
        // menu — without them the kebab would be the only keyboard route (AC9).
        if (onRequestMenu && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          onRequestMenu({ x: r.right - 8, y: r.bottom });
          return;
        }
        if (!e.altKey || !dragEnabled) return;
        if (e.key === 'ArrowUp')   { e.preventDefault(); onReorder(dragScope, dragKey, -1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); onReorder(dragScope, dragKey, 1); }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-2)',
        padding: 'var(--eb-space-3) var(--eb-space-3) var(--eb-space-1)',
        // At rest the header wears a filled band (`--eb-bg-hover`) so it reads
        // as a team header — not just an uppercase agent row — against the
        // block's `--eb-bg-surface` members area (#2370 AC1). Hover/selected
        // still layer clearly on top: hover steps up to the stronger
        // `--eb-bg-active`, selected keeps its purple-tinted fill + accent bar
        // (AC5). Top corners round to meet the enclosing block.
        background: selected ? 'var(--eb-bg-selected)' : hovered ? 'var(--eb-bg-active)' : 'var(--eb-bg-hover)',
        borderLeft: selected ? '3px solid var(--eb-accent-primary)' : '3px solid transparent',
        borderTopLeftRadius: 'var(--eb-radius-md)',
        borderTopRightRadius: 'var(--eb-radius-md)',
        // Collapsed → the header is the block's only row, so its fill must round
        // at the bottom too to sit flush inside the block's corners (AC4).
        borderBottomLeftRadius: collapsed ? 'var(--eb-radius-md)' : 0,
        borderBottomRightRadius: collapsed ? 'var(--eb-radius-md)' : 0,
        fontSize: 'var(--eb-text-xs)',
        fontWeight: 'var(--eb-font-semibold)',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: subtle ? 'var(--eb-text-muted)' : 'var(--eb-text-secondary)',
        cursor: 'pointer',
        opacity: dnd && dnd.isDragging ? 0.4 : 1,
        boxShadow: dnd ? dnd.indicatorShadow : undefined,
        transition: 'background var(--eb-transition-fast)',
      }}
    >
      {/*
       * The chevron is the ONLY expand/collapse control (#2213), a real
       * `<button>` beside the main one since #2704. `stopPropagation` keeps its
       * click off the row's own `onActivate`.
       */}
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
        title={collapsed ? 'Expand' : 'Collapse'}
        onClick={e => { e.stopPropagation(); onToggle(); }}
        style={{ ...BARE_BUTTON_STYLE, flexShrink: 0 }}
      >
        {collapsed
          ? <ChevronRight size={12} />
          : <ChevronDown  size={12} />}
      </button>
      {/*
       * The main button: selects the team (its click bubbles to the row's
       * `onActivate`). The selection is announced as `aria-current` — a plain
       * button may not carry `aria-selected` (#2704).
       */}
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        // Surfaces the (still-live) Alt+↑/↓ reorder shortcut to assistive tech now
        // that the visible arrow buttons — previously its only affordance — are gone.
        aria-keyshortcuts={dragEnabled ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        style={{ ...BARE_BUTTON_STYLE, flex: 1, minWidth: 0, gap: 'var(--eb-space-2)' }}
      >
        {Icon && <Icon size={12} style={{ flexShrink: 0 }} />}
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {label}
          </span>
          {/*
           * The team-membership indicator (#2381), in the slot that used to show
           * the team's Working Environment name (#1529, since removed from the
           * header — the env is still on the Settings tab). `textTransform`/
           * `letterSpacing` are reset so it reads as itself, not as an uppercase
           * section label. Renders nothing for a team with no visible members
           * (AC9) rather than an empty affordance.
           */}
          <MembershipLine indicator={membershipIndicator} />
        </span>
      </button>
      {/*
       * Trailing cluster order (left→right): grip → persistent count. The grip
       * sits immediately left of the always-present count so its horizontal
       * position never changes on hover (#1377). Mouse reordering is the grip's
       * drag; the keyboard path is Alt+↑/↓ (see aria-keyshortcuts above) — the
       * visible arrow buttons were removed as redundant with drag&drop (#1381).
       */}
      {onRequestMenu && (
        <KebabButton
          label={`Team actions for ${label}`}
          active={hovered}
          onOpen={onRequestMenu}
        />
      )}
      {dnd && <DragGrip dnd={dnd} active={hovered} />}
      {/*
       * #2430 — the collapsed-only attention rollup, immediately left of the
       * always-present count. It surfaces only the two states that demand the
       * user (a reply awaiting you, a busy agent), so a collapsed team still
       * reveals *which* team needs attention without expanding it. Hidden while
       * expanded, where the per-agent member dots already carry this (AC6).
       */}
      {collapsed && <AttentionRollup attention={attention} />}
      <span style={{
        flexShrink: 0,
        fontSize: 'var(--eb-text-xs)',
        fontWeight: 'var(--eb-font-medium)',
        color: 'var(--eb-text-muted)',
        textTransform: 'none',
        letterSpacing: 0,
      }}>
        {count}
      </span>
    </div>
  );
}

/**
 * #2430 — the aggregate "needs attention" marker(s) on a collapsed team header.
 * Renders a solid-green dot when the team holds at least one reply awaiting the
 * user, and/or an amber pulsing dot when at least one member is busy; both show
 * together when both are present (AC3), and nothing at all when the team is quiet
 * (AC4). The dots deliberately reuse the exact tokens and shape of the per-agent
 * member dots (`--eb-status-success` solid, `--eb-status-warning` pulsing) so the
 * collapsed marker and the expanded dots read as the same language (AC7) — no new
 * colours are introduced here.
 */
function AttentionRollup({ attention }) {
  const hasReply = !!attention && attention.hasReply;
  const hasBusy = !!attention && attention.hasBusy;
  if (!hasReply && !hasBusy) return null;
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', flexShrink: 0 }}>
      {hasReply && (
        <span
          role="img"
          title="Reply awaiting you"
          aria-label="A reply is awaiting you in this team"
          style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--eb-status-success)', flexShrink: 0 }}
        />
      )}
      {hasBusy && (
        <span
          role="img"
          className="eb-status-pulse"
          title="An agent is working"
          aria-label="An agent in this team is working"
          style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--eb-status-warning)', flexShrink: 0 }}
        />
      )}
    </span>
  );
}

/**
 * The team-header line under the team name (#2381, broadened #2387): a short
 * **Private** badge when the viewer's own team-of-one, otherwise the team's full
 * member list (Team Admins first, then Team Members). Renders nothing for
 * `kind: 'none'` (a team with no visible members — AC9).
 *
 * The names list must stay on one line and never ellipsis-cut a name mid-string
 * (AC5): `fitAdminNames` drops whole names from the tail and replaces them with a
 * compact `+N`, and the full list is always on the `title` tooltip. The fit is
 * width-driven, so the row is measured with a `ResizeObserver` and the names are
 * probed with a canvas that mirrors the row's computed font — the actual
 * decision (which names fit) lives in the pure, unit-tested `fitAdminNames`.
 */
function MembershipLine({ indicator }) {
  const kind = indicator ? indicator.kind : 'none';
  const names = indicator ? indicator.names : [];

  if (kind === 'own') {
    return <span style={ownBadgeStyle}>Private</span>;
  }
  if (kind === 'admins') {
    return <TeamAdminsLine names={names} title={indicator.title} />;
  }
  return null;
}

/**
 * A module-scoped canvas whose 2d context measures text width in the row's own
 * font. Built lazily and reused, so re-fitting on a resize never allocates.
 * Falls back to a coarse per-character estimate where no canvas is available
 * (e.g. a non-DOM test environment) — `fitAdminNames` still keeps whole names.
 */
function makeTextMeasurer(el) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return (s) => s.length * 7;
  }
  const canvas = makeTextMeasurer._canvas || (makeTextMeasurer._canvas = document.createElement('canvas'));
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return (s) => s.length * 7;
  const cs = (typeof window !== 'undefined' && window.getComputedStyle) ? window.getComputedStyle(el) : null;
  ctx.font = (cs && cs.font) || (cs ? `${cs.fontSize} ${cs.fontFamily}` : '12px sans-serif');
  return (s) => ctx.measureText(s).width;
}

function TeamAdminsLine({ names, title }) {
  const ref = useRef(null);
  const [fit, setFit] = useState(() => ({ text: names.join(', '), hiddenCount: 0, title }));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const recompute = () => {
      const measure = makeTextMeasurer(el);
      setFit(fitAdminNames(names, el.clientWidth, measure));
    };
    recompute();
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(recompute);
      ro.observe(el);
    }
    return () => { if (ro) ro.disconnect(); };
  }, [names]);

  return (
    <span ref={ref} title={fit.title || title} style={adminsLineStyle}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        {fit.text}
      </span>
      {fit.hiddenCount > 0 && (
        <span style={{ flexShrink: 0 }}>&nbsp;+{fit.hiddenCount}</span>
      )}
    </span>
  );
}

// The "Private" pill — the same quiet, bordered treatment as `AgentRow`'s state
// badge, but not uppercased (it is a word, not a section label).
const ownBadgeStyle = {
  alignSelf: 'flex-start',
  padding: '0 6px',
  borderRadius: 'var(--eb-radius-sm)',
  border: '1px solid var(--eb-border-default)',
  fontSize: 'var(--eb-text-xs)',
  fontWeight: 'var(--eb-font-medium)',
  lineHeight: 1.5,
  color: 'var(--eb-text-muted)',
  textTransform: 'none',
  letterSpacing: 0,
};

// The admin-name line — single-line, font reset so it does not read as an
// uppercase section label, `minWidth: 0` so the inner span can actually shrink
// and be measured against the available width.
const adminsLineStyle = {
  display: 'flex',
  alignItems: 'center',
  maxWidth: '100%',
  minWidth: 0,
  fontWeight: 'var(--eb-font-normal)',
  fontSize: 'var(--eb-text-xs)',
  textTransform: 'none',
  letterSpacing: 0,
  color: 'var(--eb-text-muted)',
};

function SectionHeader({ label, icon: Icon }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-3) var(--eb-space-3) var(--eb-space-1)',
      fontSize: 'var(--eb-text-xs)',
      fontWeight: 'var(--eb-font-semibold)',
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: 'var(--eb-text-secondary)',
    }}>
      {Icon && <Icon size={12} style={{ flexShrink: 0 }} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </div>
  );
}

function iconForRole(role) {
  switch (role) {
    case 'agent':         return Bot;
    case 'team':          return Users;
    case 'team-member':   return Bot;
    default:              return MessageCircle;
  }
}

// #2429 — a four-colour model (green / amber / grey / red), with the only
// non-colour variable being *fill* on green: a **solid** green dot is a reply
// awaiting you (an unread response from an agent you manually messaged), a
// **hollow** green dot is FYI activity from an auto-triggered run you never need
// to review. Net changes from the old model: blue `active` is gone (folded into
// the neutral grey idle dot); `disabled` moved off amber onto neutral grey (amber
// now means "working" only); green split into solid vs hollow. The solid/hollow
// distinction carries meaning without relying on colour, which keeps it legible
// for colour-blind users (AC11 / edge case). Colour tokens are unchanged
// (`--eb-status-*`, `--eb-text-muted`) — this only re-maps state→token + adds the
// hollow variant.
const STATUS_DOT = {
  busy:        { color: 'var(--eb-status-warning)', label: 'Working…',            pulse: true  },
  unread:      { color: 'var(--eb-status-success)', label: 'Reply awaiting you',  pulse: false },
  'unread-auto': { color: 'var(--eb-status-success)', label: 'Activity — nothing needed from you', pulse: false, hollow: true },
  idle:        { color: 'var(--eb-text-muted)',     label: 'Idle',               pulse: false },
  // #1119 — 'disabled' (intentionally off, one-click enable to chat) and
  // 'offline' (container not running — a real problem) stay two distinct dots
  // with actionable tooltips. #2429 moves 'disabled' onto neutral grey (it is not
  // a "working" state, so it no longer shares amber with busy); 'offline' remains
  // the red "problem" dot.
  disabled: { color: 'var(--eb-text-muted)',     label: 'Disabled — enable it to chat',   pulse: false },
  offline:  { color: 'var(--eb-status-error)',   label: 'Offline — container not running', pulse: false },
  // #1957 — a stub is not a paused agent: there is nothing to un-pause, the
  // agent has never been provisioned. A muted grey dot, matching disabled/idle.
  stub:     { color: 'var(--eb-text-muted)',     label: 'Not initialised — materialize it to chat', pulse: false },
  // Kept as a fallback for any unrecognised state (see STATUS_DOT lookup below).
  problem: { color: 'var(--eb-status-error)',   label: 'Unavailable',       pulse: false },
};

/**
 * One agent row. `environmentName` is resolved by the caller (agent-list-env.js)
 * rather than read off `agent`: inside a group the shared env lives on the
 * header, so an inheriting row is passed `null` and renders single-line (#1451).
 */
// `onSelect` is the id-taking callback straight from the parent (a stable
// `useCallback`), so wrapping the row in `React.memo` (#1682)
// actually pays off: a status poll re-renders only the rows whose
// `activityState` string changed, not the whole list. The per-row click
// closures are built inside — they only matter when the row does re-render.
const AgentRow = React.memo(function AgentRow({ agent, selected, onSelect, activityState = 'idle', environmentName = null, indent = false, busy = false, onReorder, drag, dragScope, dragKey, dragEnabled, onRequestMenu, reveal = false }) {
  const Icon = iconForRole(agent.role);
  const [hovered, setHovered] = useState(false);

  // #2521: the row the page was asked to reveal scrolls itself into view —
  // on mount too, which is what covers a row that only renders once its
  // group or stub section has been expanded for the reveal.
  const rowRef = useRef(null);
  useEffect(() => {
    if (reveal) rowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [reveal]);

  // A disabled agent is only ever in this list because the caller opted in
  // (#1928 AC6); a stub, because the chat always asks for them (#1957). Both
  // read their state from the row's own payload rather than the `statuses`
  // poll, which is keyed on the enabled-agent list and would leave such a row
  // looking idle.
  const openable = isChatOpenable(agent);
  const stub = agentState(agent) === 'stub';
  const dot = openable
    ? (STATUS_DOT[activityState] ?? STATUS_DOT.problem)
    : (stub ? STATUS_DOT.stub : STATUS_DOT.disabled);
  // The word next to the name. "Not initialised" is the Agents page's own
  // vocabulary for this state (AC3) — the same agent must not be called two
  // different things depending on which surface you are looking at.
  const stateBadge = openable ? null : (stub ? 'Not initialised' : 'Disabled');
  // #2789: a pool instance kept alive for review feedback on its open PR.
  const waitingLabel = poolWaitingLabel(agent);

  const requestMenu = onRequestMenu
    ? anchor => onRequestMenu({ kind: 'agent', agent }, anchor)
    : null;

  const dnd = dragEnabled && drag ? makeRowDnd(drag, dragScope, dragKey) : null;

  return (
    // #2704: a `listitem` row holding the main select `<button>` and, beside
    // it, the kebab/grip/status cluster — never nested inside it. The row takes
    // the click anywhere (a click on the main button, including the one a
    // browser synthesises for Enter/Space, bubbles up here; the kebab and grip
    // stop propagation), the right-click, the drop and the keys, so Alt+↑/↓
    // and Shift+F10 work from whichever of its controls has focus.
    <div
      ref={rowRef}
      role="listitem"
      // A disabled agent has no chat to open (the DM route rejects it), so the
      // row opens its own menu instead — Enable sits right there, which beats
      // both a silent no-op and a dead-end "agent disabled" panel (AC6). A stub
      // has no chat *identity* at all (the DM route 409s on a tokenless agent),
      // so the same rule covers it, pointing at Materialize instead (#1957 AC3).
      onClick={e => {
        if (openable) { onSelect(agent.id); return; }
        if (requestMenu) requestMenu({ x: e.clientX, y: e.clientY });
      }}
      onDragOver={dnd ? dnd.onDragOver : undefined}
      onDrop={dnd ? dnd.onDrop : undefined}
      onContextMenu={requestMenu ? e => {
        e.preventDefault();
        requestMenu({ x: e.clientX, y: e.clientY });
      } : undefined}
      onKeyDown={e => {
        if (requestMenu && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          requestMenu({ x: r.right - 8, y: r.bottom });
          return;
        }
        if (!e.altKey || !dragEnabled) return;
        if (e.key === 'ArrowUp')   { e.preventDefault(); onReorder(dragScope, dragKey, -1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); onReorder(dragScope, dragKey, 1); }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-3)',
        padding: 'var(--eb-space-2) var(--eb-space-3)',
        // #2389: plain member/stub rows sit flush with the card's base padding.
        // The old extra `--eb-space-4` step signalled an agent hierarchy the rail
        // no longer draws — team membership is shown on the card itself now
        // (#2381/#2387) — so it was just eating horizontal space and truncating
        // longer names. Pool-instance rows (indent={2}) keep ONE step of indent so
        // a role and its spawned instances stay visually distinct (#2297, AC3).
        paddingLeft: (typeof indent === 'number' && indent > 1)
          ? `calc(var(--eb-space-3) + var(--eb-space-4) * ${indent - 1})`
          : 'var(--eb-space-3)',
        background: selected ? 'var(--eb-bg-selected)' : hovered ? 'var(--eb-bg-hover)' : 'transparent',
        borderLeft: selected ? '3px solid var(--eb-accent-primary)' : '3px solid transparent',
        borderBottom: '1px solid transparent',
        color: selected ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
        cursor: 'pointer',
        opacity: dnd && dnd.isDragging ? 0.4 : 1,
        boxShadow: dnd ? dnd.indicatorShadow : undefined,
        transition: 'background var(--eb-transition-fast)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/*
       * The selected row is announced as `aria-current` — a plain button may
       * not carry `aria-selected` (#2704).
       */}
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        aria-disabled={!openable || undefined}
        title={!openable ? dot.label : undefined}
        // Surfaces the (still-live) Alt+↑/↓ reorder shortcut to assistive tech now
        // that the visible arrow buttons — previously its only affordance — are gone.
        aria-keyshortcuts={dragEnabled ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        style={{ ...BARE_BUTTON_STYLE, flex: 1, minWidth: 0, gap: 'var(--eb-space-3)' }}
      >
        <Icon size={18} style={{ flexShrink: 0, color: selected ? 'var(--eb-accent-primary)' : 'var(--eb-text-muted)' }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', minWidth: 0 }}>
            <span
              title={agent.displayName || agent.id}
              style={{
                fontSize: 'var(--eb-text-md)',
                fontWeight: 'var(--eb-font-medium)',
                color: openable ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {agent.displayName || agent.id}
            </span>
            {/*
             * The word, not just the amber dot: with the opt-in on, a disabled row
             * sits among enabled ones and has to read as disabled at a glance
             * (AC6) — a colour alone would also fail anyone who can't see it. The
             * same applies to a stub, which says "Not initialised" (#1957 AC3):
             * two different states must not wear one badge.
             */}
            {stateBadge && (
              <span style={{
                flexShrink: 0,
                padding: '0 4px',
                borderRadius: 'var(--eb-radius-sm)',
                border: '1px solid var(--eb-border-default)',
                fontSize: 'var(--eb-text-xs)',
                lineHeight: 1.5,
                color: 'var(--eb-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}>
                {stateBadge}
              </span>
            )}
          </div>
          {environmentName && (
            <div
              title={environmentName}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                marginTop: 2,
                maxWidth: '100%',
                fontSize: 'var(--eb-text-xs)',
                color: 'var(--eb-text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              <Server size={10} style={{ flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {environmentName}
              </span>
            </div>
          )}
          {waitingLabel && (
            <div
              title={`${waitingLabel} — kept alive so review feedback returns to this instance; not counted against the role's instance limit`}
              style={{
                marginTop: 2,
                fontSize: 'var(--eb-text-xs)',
                color: 'var(--eb-text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {waitingLabel}
            </div>
          )}
        </div>
      </button>

      <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
        {/*
         * Trailing cluster order (left→right): kebab → grip → persistent status
         * dot. Every one of them is *always rendered* — hover only changes the
         * kebab's and the grip's opacity — so the grip's horizontal position is
         * fixed, which is what the #1377 order was for. It is now fixed
         * outright: the hover-*revealed* mark-as-unread mail icon that used to
         * lead this cluster is gone, its action being a "Mark as unread" entry
         * in the kebab menu instead (#1938). The visible up/down arrow reorder
         * buttons were removed as redundant with drag&drop; the keyboard path
         * stays as Alt+↑/↓ (see aria-keyshortcuts above) (#1381).
         */}
        {requestMenu && (
          <KebabButton
            label={`Actions for ${agent.displayName || agent.id}`}
            active={hovered}
            onOpen={requestMenu}
          />
        )}
        {dnd && <DragGrip dnd={dnd} active={hovered} />}
        {/*
         * A lifecycle mutation in flight replaces the status dot with a spinner
         * (#1957 AC5). Materializing a role that declares repositories does the
         * clone now, so the operation can take a while: the dot alone would
         * leave the row looking untouched for the whole of it. It takes the
         * dot's slot rather than adding one, so the cluster's width is stable.
         */}
        {busy ? (
          <Loader2
            size={12}
            aria-label="Working…"
            style={{ flexShrink: 0, color: 'var(--eb-text-muted)', animation: 'spin 1s linear infinite' }}
          />
        ) : (
          <span
            // `role="img"` so the label is allowed on the span (#2704): now that
            // the dot sits beside the row button instead of inside it, its
            // `aria-label` is exposed and a bare span may not carry one.
            role="img"
            title={dot.label}
            aria-label={dot.label}
            className={dot.pulse ? 'eb-status-pulse' : undefined}
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              // #2429 — a hollow dot (auto-triggered activity) is drawn as an
              // outline ring: transparent fill + a coloured border, so it reads
              // as clearly non-demanding next to the filled "for you" dot and the
              // difference does not rely on colour alone.
              background: dot.hollow ? 'transparent' : dot.color,
              boxShadow: dot.hollow ? `inset 0 0 0 1.5px ${dot.color}` : undefined,
              flexShrink: 0,
            }}
          />
        )}
      </span>
    </div>
  );
});

/**
 * Bundle the DOM drag handlers + derived visual state for one draggable row.
 * Returns `null`-safely only via the `dragEnabled && drag` guard at the call
 * site, so callers can treat a returned object as "drag is on for this row".
 */
function makeRowDnd(drag, scope, key) {
  const { handlers, dragging, dropHint } = drag;

  const isDragging = !!dragging && dragging.scope === scope && dragging.key === key;
  const indicator = dropHint && dropHint.scope === scope && dropHint.key === key
    ? dropHint.position
    : null;
  const indicatorShadow =
    indicator === 'before' ? 'inset 0 2px 0 0 var(--eb-accent-primary)'
    : indicator === 'after' ? 'inset 0 -2px 0 0 var(--eb-accent-primary)'
    : undefined;

  return {
    isDragging,
    indicatorShadow,
    // Drop-target handlers live on the whole row so you can drop anywhere on it.
    onDragOver(e) {
      const position = dropPosition(e.clientY, e.currentTarget.getBoundingClientRect());
      // Only same-scope drags are droppable; preventDefault is what unlocks drop.
      if (handlers.onOver(scope, key, position)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }
    },
    onDrop(e) {
      e.preventDefault();
      const position = dropPosition(e.clientY, e.currentTarget.getBoundingClientRect());
      handlers.onDrop(scope, key, position);
    },
    // Drag *source* handlers live on the grip only, so a plain click on the row
    // still selects the agent and never starts a drag (AC7).
    onGripDragStart(e) {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', key); // required for Firefox to start the drag
      handlers.onStart(scope, key);
    },
    onGripDragEnd(e) {
      e.stopPropagation();
      handlers.onEnd();
    },
  };
}

/**
 * The kebab that opens a row's / group's lifecycle menu (#1928). Anchored at its
 * own box rather than the pointer so the menu lands in the same place however it
 * was opened, and it is a real focusable control so the menu is reachable by
 * keyboard without knowing the Shift+F10 convention (AC9).
 *
 * A real `<button>` since #2704: it sits beside the row's main button rather
 * than inside it (it used to be a `span[role=button]` nested in the row's own
 * `<button>`, which axe flags as nested-interactive). Always mounted while a
 * menu is available (faint at rest, full-strength on row hover) so its width
 * never shifts the trailing cluster, and `stopPropagation` keeps a click off
 * the row's own select/activate handler.
 */
function KebabButton({ label, active, onOpen }) {
  function open(e) {
    e.stopPropagation();
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    onOpen({ x: r.right, y: r.bottom + 2 });
  }
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-label={label}
      title="Actions"
      onClick={open}
      style={{
        ...BARE_BUTTON_STYLE,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        flexShrink: 0,
        borderRadius: 'var(--eb-radius-sm)',
        color: 'var(--eb-text-muted)',
        cursor: 'pointer',
        opacity: active ? 1 : 0.35,
        transition: 'opacity var(--eb-transition-fast), color var(--eb-transition-fast)',
      }}
      onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
      onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
    >
      <MoreVertical size={13} />
    </button>
  );
}

/**
 * The dedicated drag handle. A separate draggable element (not the whole row)
 * is what keeps click-to-select and drag-to-reorder from conflicting (AC7).
 * Always mounted while reordering is available so the drag lifecycle survives
 * the hover state flipping mid-drag; faint at rest, full-strength on hover as
 * the drag affordance (AC9).
 */
function DragGrip({ dnd, active }) {
  return (
    <span
      // `role="img"`: a bare span may not carry `aria-label` (#2704). The grip
      // is mouse-only; the keyboard path is the row's Alt+↑/↓.
      role="img"
      aria-label="Drag to reorder"
      title="Drag to reorder"
      draggable
      onDragStart={dnd.onGripDragStart}
      onDragEnd={dnd.onGripDragEnd}
      onClick={e => e.stopPropagation()}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 12,
        height: 14,
        flexShrink: 0,
        color: 'var(--eb-text-muted)',
        cursor: 'grab',
        opacity: active ? 1 : 0.35,
        transition: 'opacity var(--eb-transition-fast)',
      }}
    >
      <GripVertical size={12} />
    </span>
  );
}

