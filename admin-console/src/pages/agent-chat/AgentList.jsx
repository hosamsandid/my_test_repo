import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { MessageCircle, Bot, Server, Users, Layers, ChevronDown, ChevronRight, GripVertical, MoreVertical, Loader2 } from 'lucide-react';

import { computeReorder, dropPosition } from './agent-list-dnd.js';
import { groupEnvironmentName, rowEnvironmentName } from './agent-list-env.js';
import { buildGroups, groupKey, orderModel, filterModel, stubSectionLabel } from './agent-list-model.js';
import { agentState, isChatOpenable } from '../agent-lifecycle/agent-lifecycle-menu.js';

// Re-exported so `AgentChat` can populate the filter dropdown without importing
// the model module directly (the grouping logic used to live in this file).
export { buildGroups } from './agent-list-model.js';

const COLLAPSED_KEY = 'agentChat.collapsedGroups';
const ORDER_KEY = 'agentChat.sidebarOrder';

/**
 * Module-level default for the `busyIds` prop so an embedding that passes none
 * hands the memoized rows the *same* empty Set on every render (a `new Set()`
 * default would change identity each time and defeat `React.memo`).
 */
const EMPTY_BUSY = new Set();

/**
 * Per-group collapse-state defaults — matches the Agents overview page so the
 * chat sidebar behaves consistently: teams default open, orchestrators
 * default closed.
 */
const DEFAULT_COLLAPSED = {
  team: false,
  orchestrator: true,
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
 * @param {{kind:'all'}|{kind:'team',id:string}|{kind:'orchestrator',id:string}|{kind:'agent',id:string}} filter
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
 */
export default function AgentList({
  agents,
  selectedAgentId,
  onSelect,
  statuses = {},
  filter = { kind: 'all' },
  showDisabled = false,
  busyIds = EMPTY_BUSY,
  onRequestMenu = null,
}) {
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

  // Group and single-agent reorder are only offered when the full unfiltered
  // list is visible so that the visual position matches the stored order — under
  // a filter you cannot see the other groups/singles, so a move would be
  // ambiguous.
  const canReorder = filter.kind === 'all';
  // Member-within-group reorder, by contrast, is unambiguous under a single-team
  // filter too: that view shows the team's complete, ordered member set, and the
  // drag writes the same complete per-group order it would in the unfiltered view
  // (#1725). Orchestrator (bp-instance ordering) / single-agent filters stay out.
  const canReorderMembers = filter.kind === 'all' || filter.kind === 'team';

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

  // Persisted per-group collapse state. Keyed by `<kind>:<id>` so team and
  // orchestrator ids can collide without clobbering each other.
  const [collapsedMap, setCollapsedMap] = useState(loadCollapsed);
  useEffect(() => { saveCollapsed(collapsedMap); }, [collapsedMap]);

  function isCollapsed(group) {
    const key = `${group.kind}:${group.id}`;
    if (Object.prototype.hasOwnProperty.call(collapsedMap, key)) return collapsedMap[key];
    return DEFAULT_COLLAPSED[group.kind] ?? false;
  }
  // Stable so a memoized GroupSection is not forced to re-render every time the
  // parent re-renders; the previous value is read from the functional updater.
  const toggleCollapsed = useCallback((group) => {
    const key = `${group.kind}:${group.id}`;
    setCollapsedMap(prev => {
      const cur = Object.prototype.hasOwnProperty.call(prev, key)
        ? prev[key]
        : (DEFAULT_COLLAPSED[group.kind] ?? false);
      return { ...prev, [key]: !cur };
    });
  }, []);

  return (
    <div role="listbox" style={{ display: 'flex', flexDirection: 'column' }}>
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
        />
      ))}

      {visibleSingles.length > 0 && (
        <>
          <SectionHeader label="Single agents" icon={MessageCircle} />
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
            />
          ))}
        </>
      )}

      {empty && (
        <div style={{
          padding: 'var(--eb-space-4)',
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-muted)',
          textAlign: 'center',
          lineHeight: 1.5,
        }}>
          No agents match this filter.
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
  busyIds,
  onRequestMenu,
}) {
  const Icon = group.kind === 'team' ? Users : Layers;
  const stubs = group.stubs || [];
  // Stubs count towards the header's total (#1957): they are members of this
  // team, and a team whose members are *all* stubs would otherwise announce
  // itself with a `0` next to a section listing several names.
  const count = group.children.length + stubs.length + (group.header ? 1 : 0);
  const memberScope = `members:${groupDragKey}`;
  const memberDragEnabled = memberReorder && group.children.length > 1;
  const handleToggle = useCallback(() => onToggle(group), [onToggle, group]);
  // Team management (AC2) hangs off the group header. An orchestrator group gets
  // no header menu: its lifecycle actions stay on the Agents page (epic D4).
  const headerMenu = onRequestMenu && group.kind === 'team'
    ? anchor => onRequestMenu({ kind: 'team', group }, anchor)
    : null;
  // The Working Environment shared by this group's rows is shown once, on the
  // header; rows that inherit it drop their own line (#1451).
  const groupEnv = groupEnvironmentName(group);
  return (
    <>
      <CollapsibleHeader
        label={group.displayName}
        icon={Icon}
        subtle={!group.header}
        count={count}
        environmentName={groupEnv}
        collapsed={collapsed}
        onToggle={handleToggle}
        onReorder={onReorder}
        drag={drag}
        dragScope="groups"
        dragKey={groupDragKey}
        dragEnabled={dragEnabled}
        onRequestMenu={headerMenu}
      />
      {!collapsed && group.header && (
        <AgentRow
          agent={group.header}
          selected={group.header.id === selectedAgentId}
          onSelect={onSelect}
          activityState={statuses[group.header.id] || 'idle'}
          environmentName={rowEnvironmentName(group.header, groupEnv)}
          onRequestMenu={onRequestMenu}
        />
      )}
      {!collapsed && group.children.map((agent) => (
        <AgentRow
          key={agent.id}
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
        />
      ))}
      {/*
       * The team's not-yet-materialized members (#1957), below the active ones
       * and behind their own collapsed sub-header. A group with no stubs renders
       * nothing at all here (AC2) — the section is never an empty affordance.
       */}
      {!collapsed && stubs.length > 0 && (
        <StubSection
          stubs={stubs}
          groupEnv={groupEnv}
          selectedAgentId={selectedAgentId}
          onSelect={onSelect}
          busyIds={busyIds}
          onRequestMenu={onRequestMenu}
        />
      )}
    </>
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
function StubSection({ stubs, groupEnv, selectedAgentId, onSelect, busyIds, onRequestMenu }) {
  const [collapsed, setCollapsed] = useState(true);
  const [hovered, setHovered] = useState(false);
  const label = stubSectionLabel(stubs.length);
  return (
    <>
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
      {!collapsed && stubs.map((agent) => (
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
        />
      ))}
    </>
  );
}

function CollapsibleHeader({ label, icon: Icon, subtle, count, environmentName, collapsed, onToggle, onReorder, drag, dragScope, dragKey, dragEnabled, onRequestMenu }) {
  const [hovered, setHovered] = useState(false);

  const dnd = dragEnabled && drag ? makeRowDnd(drag, dragScope, dragKey) : null;

  return (
    <button
      type="button"
      onClick={onToggle}
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
      // Surfaces the (still-live) Alt+↑/↓ reorder shortcut to assistive tech now
      // that the visible arrow buttons — previously its only affordance — are gone.
      aria-keyshortcuts={dragEnabled ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
      aria-expanded={!collapsed}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-2)',
        width: '100%',
        padding: 'var(--eb-space-3) var(--eb-space-3) var(--eb-space-1)',
        background: hovered ? 'var(--eb-bg-hover)' : 'transparent',
        border: 'none',
        borderTop: 'none',
        fontSize: 'var(--eb-text-xs)',
        fontWeight: 'var(--eb-font-semibold)',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: subtle ? 'var(--eb-text-muted)' : 'var(--eb-text-secondary)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'left',
        opacity: dnd && dnd.isDragging ? 0.4 : 1,
        boxShadow: dnd ? dnd.indicatorShadow : undefined,
        transition: 'background var(--eb-transition-fast)',
      }}
    >
      {collapsed
        ? <ChevronRight size={12} style={{ flexShrink: 0 }} />
        : <ChevronDown  size={12} style={{ flexShrink: 0 }} />}
      {Icon && <Icon size={12} style={{ flexShrink: 0 }} />}
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        {/*
         * The group's shared Working Environment — shown once here instead of on
         * every member row (#1451). `textTransform`/`letterSpacing` are reset so
         * the env name reads as itself, not as an uppercase section label.
         */}
        {environmentName && (
          <span
            title={environmentName}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              maxWidth: '100%',
              fontWeight: 'var(--eb-font-normal)',
              textTransform: 'none',
              letterSpacing: 0,
              color: 'var(--eb-text-muted)',
              overflow: 'hidden',
            }}
          >
            <Server size={10} style={{ flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {environmentName}
            </span>
          </span>
        )}
      </span>
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
    </button>
  );
}

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
    case 'orchestrator':  return Layers;
    case 'bp-instance':   return Bot;
    default:              return MessageCircle;
  }
}

const STATUS_DOT = {
  busy:    { color: 'var(--eb-status-warning)', label: 'Working…',          pulse: true  },
  unread:  { color: 'var(--eb-status-success)', label: 'New message',       pulse: false },
  active:  { color: 'var(--eb-status-info)',    label: 'Active session',    pulse: false },
  idle:    { color: 'var(--eb-text-muted)',     label: 'Waiting for input', pulse: false },
  // #1119 — 'disabled' (intentionally off, one-click enable to chat) and
  // 'offline' (container not running — a real problem) used to collapse into a
  // single red "Unavailable" dot, so the user couldn't tell which action was
  // required. They now render as two distinct dots with actionable tooltips.
  disabled: { color: 'var(--eb-status-warning)', label: 'Disabled — enable it to chat',   pulse: false },
  offline:  { color: 'var(--eb-status-error)',   label: 'Offline — container not running', pulse: false },
  // #1957 — a stub is not a paused agent: there is nothing to un-pause, the
  // agent has never been provisioned. A muted dot rather than the amber
  // "disabled" one, so the two states stay tellable apart at a glance.
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
const AgentRow = React.memo(function AgentRow({ agent, selected, onSelect, activityState = 'idle', environmentName = null, indent = false, busy = false, onReorder, drag, dragScope, dragKey, dragEnabled, onRequestMenu }) {
  const Icon = iconForRole(agent.role);
  const [hovered, setHovered] = useState(false);

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

  const requestMenu = onRequestMenu
    ? anchor => onRequestMenu({ kind: 'agent', agent }, anchor)
    : null;

  const dnd = dragEnabled && drag ? makeRowDnd(drag, dragScope, dragKey) : null;

  return (
    <button
      role="option"
      aria-selected={selected}
      aria-disabled={!openable || undefined}
      // A disabled agent has no chat to open (the DM route rejects it), so the
      // row opens its own menu instead — Enable sits right there, which beats
      // both a silent no-op and a dead-end "agent disabled" panel (AC6). A stub
      // has no chat *identity* at all (the DM route 409s on a tokenless agent),
      // so the same rule covers it, pointing at Materialize instead (#1957 AC3).
      title={!openable ? dot.label : undefined}
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
      // Surfaces the (still-live) Alt+↑/↓ reorder shortcut to assistive tech now
      // that the visible arrow buttons — previously its only affordance — are gone.
      aria-keyshortcuts={dragEnabled ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-3)',
        width: '100%',
        padding: 'var(--eb-space-2) var(--eb-space-3)',
        paddingLeft: indent ? 'calc(var(--eb-space-3) + var(--eb-space-4))' : 'var(--eb-space-3)',
        background: selected ? 'var(--eb-bg-selected)' : hovered ? 'var(--eb-bg-hover)' : 'transparent',
        borderLeft: selected ? '3px solid var(--eb-accent-primary)' : '3px solid transparent',
        borderTop: 'none',
        borderRight: 'none',
        borderBottom: '1px solid transparent',
        color: selected ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'left',
        opacity: dnd && dnd.isDragging ? 0.4 : 1,
        boxShadow: dnd ? dnd.indicatorShadow : undefined,
        transition: 'background var(--eb-transition-fast)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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
      </div>

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
            title={dot.label}
            className={dot.pulse ? 'eb-status-pulse' : undefined}
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: dot.color,
              flexShrink: 0,
            }}
          />
        )}
      </span>
    </button>
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
 * Rendered as a `span[role=button]`: the rows it sits in are themselves
 * `<button>`s, and a nested `<button>` is invalid HTML that browsers recover
 * from by hoisting it out of its parent — the same reason the drag grip beside
 * it is a span. Always mounted while a menu is available (faint at rest,
 * full-strength on row hover) so its width never shifts the trailing cluster,
 * and `stopPropagation` keeps a click off the row's own select/collapse
 * handler.
 */
function KebabButton({ label, active, onOpen }) {
  function open(e) {
    e.stopPropagation();
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    onOpen({ x: r.right, y: r.bottom + 2 });
  }
  return (
    <span
      role="button"
      tabIndex={0}
      aria-haspopup="menu"
      aria-label={label}
      title="Actions"
      onClick={open}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') open(e);
      }}
      style={{
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
    </span>
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

