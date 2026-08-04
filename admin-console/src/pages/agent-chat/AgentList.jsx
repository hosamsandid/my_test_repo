import React, { useState, useEffect } from 'react';
import { MessageCircle, Bot, Server, MailOpen, Users, Layers, ChevronDown, ChevronRight, ArrowUp, ArrowDown } from 'lucide-react';

const COLLAPSED_KEY = 'agentChat.collapsedGroups';
const ORDER_KEY = 'agentChat.sidebarOrder';

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
 * Apply a stored key order to an items array. Items matching stored keys come
 * first (in stored order); items not yet in the stored order are appended.
 */
function applyStoredOrder(items, storedKeys, getKey) {
  if (!storedKeys.length) return items;
  const keyed = new Map(items.map(item => [getKey(item), item]));
  const ordered = storedKeys.map(k => keyed.get(k)).filter(Boolean);
  const rest = items.filter(item => !storedKeys.includes(getKey(item)));
  return [...ordered, ...rest];
}

/**
 * Build the grouped structure used by both the list and the filter
 * dropdown. Exported so AgentChat can populate the filter without
 * duplicating the grouping logic.
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
 * Decide whether an agent passes the current filter spec.
 *  - { kind: 'all' }                       → everyone
 *  - { kind: 'team', id }                  → the team header (if visible) + its members
 *  - { kind: 'orchestrator', id }          → the orchestrator header (if visible) + its bp-instances
 *  - { kind: 'agent', id }                 → only the agent with this id
 */
function matchesFilter(agent, filter) {
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
 * Grouped, optionally filtered, vertical agent list for the chat left rail.
 *
 * Disabled agents stay clickable so the user can see the "agent disabled"
 * hint inside the chat panel — we don't want a silent no-op.
 *
 * @param {object[]} agents          List of `/api/matrix/agents` entries
 * @param {string|null} selectedAgentId
 * @param {(id:string)=>void} onSelect
 * @param {(id:string)=>void} onMarkAsUnread
 * @param {Record<string,string>} statuses  Map agentId → activityState
 * @param {{kind:'all'}|{kind:'team',id:string}|{kind:'orchestrator',id:string}|{kind:'agent',id:string}} filter
 */
export default function AgentList({
  agents,
  selectedAgentId,
  onSelect,
  onMarkAsUnread,
  statuses = {},
  filter = { kind: 'all' },
}) {
  const { groups: rawGroups, singles: rawSingles } = buildGroups(agents);

  const [sidebarOrder, setSidebarOrder] = useState(loadOrder);
  useEffect(() => { saveOrder(sidebarOrder); }, [sidebarOrder]);

  const groupKey = g => `${g.kind}:${g.id}`;

  // Groups keep their stored order; within each group its members (children)
  // keep their own stored order on top of the alphabetical baseline.
  const orderedGroups = applyStoredOrder(rawGroups, sidebarOrder.groups, groupKey)
    .map(group => ({
      ...group,
      children: applyStoredOrder(
        group.children,
        sidebarOrder.members[groupKey(group)] || [],
        a => a.id,
      ),
    }));
  const orderedSingles = applyStoredOrder(rawSingles, sidebarOrder.singles, a => a.id);

  // Arrows are only shown when the full unfiltered list is visible so that
  // the visual position matches the stored order.
  const canReorder = filter.kind === 'all';

  function moveGroup(group, direction) {
    const keys = orderedGroups.map(groupKey);
    const idx = keys.indexOf(groupKey(group));
    if (idx === -1) return;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= keys.length) return;
    const newKeys = [...keys];
    [newKeys[idx], newKeys[newIdx]] = [newKeys[newIdx], newKeys[idx]];
    setSidebarOrder(prev => ({ ...prev, groups: newKeys }));
  }

  function moveSingle(agent, direction) {
    const keys = orderedSingles.map(a => a.id);
    const idx = keys.indexOf(agent.id);
    if (idx === -1) return;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= keys.length) return;
    const newKeys = [...keys];
    [newKeys[idx], newKeys[newIdx]] = [newKeys[newIdx], newKeys[idx]];
    setSidebarOrder(prev => ({ ...prev, singles: newKeys }));
  }

  // Reorder a member (child agent) within its team/orchestrator group. Order is
  // persisted per group in the same localStorage record as the group order.
  function moveMember(group, agent, direction) {
    const key = groupKey(group);
    const sourceGroup = orderedGroups.find(g => groupKey(g) === key);
    if (!sourceGroup) return;
    const keys = sourceGroup.children.map(a => a.id);
    const idx = keys.indexOf(agent.id);
    if (idx === -1) return;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= keys.length) return;
    const newKeys = [...keys];
    [newKeys[idx], newKeys[newIdx]] = [newKeys[newIdx], newKeys[idx]];
    setSidebarOrder(prev => ({ ...prev, members: { ...prev.members, [key]: newKeys } }));
  }

  const visibleGroups = orderedGroups
    .map(group => {
      const header   = group.header   && matchesFilter(group.header,   filter) ? group.header   : null;
      const children = group.children.filter(c => matchesFilter(c, filter));
      return { ...group, header, children };
    })
    .filter(group => group.header || group.children.length > 0);

  const visibleSingles = orderedSingles.filter(a => matchesFilter(a, filter));

  const empty = visibleGroups.length === 0 && visibleSingles.length === 0;

  // Persisted per-group collapse state. Keyed by `<kind>:<id>` so team and
  // orchestrator ids can collide without clobbering each other.
  const [collapsedMap, setCollapsedMap] = useState(loadCollapsed);
  useEffect(() => { saveCollapsed(collapsedMap); }, [collapsedMap]);

  function isCollapsed(group) {
    const key = `${group.kind}:${group.id}`;
    if (Object.prototype.hasOwnProperty.call(collapsedMap, key)) return collapsedMap[key];
    return DEFAULT_COLLAPSED[group.kind] ?? false;
  }
  function toggleCollapsed(group) {
    const key = `${group.kind}:${group.id}`;
    setCollapsedMap(prev => ({ ...prev, [key]: !isCollapsed(group) }));
  }

  return (
    <div role="listbox" style={{ display: 'flex', flexDirection: 'column' }}>
      {visibleGroups.map((group, i) => (
        <GroupSection
          key={`${group.kind}:${group.id}`}
          group={group}
          collapsed={isCollapsed(group)}
          onToggle={() => toggleCollapsed(group)}
          selectedAgentId={selectedAgentId}
          onSelect={onSelect}
          onMarkAsUnread={onMarkAsUnread}
          statuses={statuses}
          onMoveUp={canReorder && i > 0 ? () => moveGroup(group, -1) : null}
          onMoveDown={canReorder && i < visibleGroups.length - 1 ? () => moveGroup(group, 1) : null}
          canReorderMembers={canReorder}
          onMoveMember={moveMember}
        />
      ))}

      {visibleSingles.length > 0 && (
        <>
          <SectionHeader label="Single agents" icon={MessageCircle} />
          {visibleSingles.map((agent, i) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              selected={agent.id === selectedAgentId}
              onSelect={() => onSelect(agent.id)}
              onMarkAsUnread={onMarkAsUnread ? () => onMarkAsUnread(agent.id) : null}
              activityState={statuses[agent.id] || 'idle'}
              onMoveUp={canReorder && i > 0 ? () => moveSingle(agent, -1) : null}
              onMoveDown={canReorder && i < visibleSingles.length - 1 ? () => moveSingle(agent, 1) : null}
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

function GroupSection({
  group,
  collapsed,
  onToggle,
  selectedAgentId,
  onSelect,
  onMarkAsUnread,
  statuses,
  onMoveUp,
  onMoveDown,
  canReorderMembers,
  onMoveMember,
}) {
  const Icon = group.kind === 'team' ? Users : Layers;
  const count = group.children.length + (group.header ? 1 : 0);
  return (
    <>
      <CollapsibleHeader
        label={group.displayName}
        icon={Icon}
        subtle={!group.header}
        count={count}
        collapsed={collapsed}
        onToggle={onToggle}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
      />
      {!collapsed && group.header && (
        <AgentRow
          agent={group.header}
          selected={group.header.id === selectedAgentId}
          onSelect={() => onSelect(group.header.id)}
          onMarkAsUnread={onMarkAsUnread ? () => onMarkAsUnread(group.header.id) : null}
          activityState={statuses[group.header.id] || 'idle'}
        />
      )}
      {!collapsed && group.children.map((agent, ci) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          selected={agent.id === selectedAgentId}
          onSelect={() => onSelect(agent.id)}
          onMarkAsUnread={onMarkAsUnread ? () => onMarkAsUnread(agent.id) : null}
          activityState={statuses[agent.id] || 'idle'}
          indent
          onMoveUp={canReorderMembers && onMoveMember && ci > 0 ? () => onMoveMember(group, agent, -1) : null}
          onMoveDown={canReorderMembers && onMoveMember && ci < group.children.length - 1 ? () => onMoveMember(group, agent, 1) : null}
        />
      ))}
    </>
  );
}

function CollapsibleHeader({ label, icon: Icon, subtle, count, collapsed, onToggle, onMoveUp, onMoveDown }) {
  const [hovered, setHovered] = useState(false);
  const canMove = onMoveUp || onMoveDown;
  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={e => {
        if (!e.altKey) return;
        if (e.key === 'ArrowUp'   && onMoveUp)   { e.preventDefault(); onMoveUp();   }
        if (e.key === 'ArrowDown' && onMoveDown)  { e.preventDefault(); onMoveDown(); }
      }}
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
        transition: 'background var(--eb-transition-fast)',
      }}
    >
      {collapsed
        ? <ChevronRight size={12} style={{ flexShrink: 0 }} />
        : <ChevronDown  size={12} style={{ flexShrink: 0 }} />}
      {Icon && <Icon size={12} style={{ flexShrink: 0 }} />}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {hovered && canMove && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          {onMoveUp && (
            <MoveButton
              icon={ArrowUp}
              title="Move up (Alt+↑)"
              onClick={e => { e.stopPropagation(); onMoveUp(); }}
            />
          )}
          {onMoveDown && (
            <MoveButton
              icon={ArrowDown}
              title="Move down (Alt+↓)"
              onClick={e => { e.stopPropagation(); onMoveDown(); }}
            />
          )}
        </span>
      )}
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
  // Kept as a fallback for any unrecognised state (see STATUS_DOT lookup below).
  problem: { color: 'var(--eb-status-error)',   label: 'Unavailable',       pulse: false },
};

function AgentRow({ agent, selected, onSelect, onMarkAsUnread, activityState = 'idle', indent = false, onMoveUp, onMoveDown }) {
  const Icon = iconForRole(agent.role);
  const dot = STATUS_DOT[activityState] ?? STATUS_DOT.problem;
  const [hovered, setHovered] = useState(false);

  // The "mark as unread" button is shown on hover when the agent is not
  // already unread and not in a disabled/offline/error state.
  const canMarkUnread = onMarkAsUnread
    && activityState !== 'unread'
    && activityState !== 'disabled'
    && activityState !== 'offline'
    && activityState !== 'problem';
  const canMove = onMoveUp || onMoveDown;

  return (
    <button
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={e => {
        if (!e.altKey) return;
        if (e.key === 'ArrowUp'   && onMoveUp)   { e.preventDefault(); onMoveUp();   }
        if (e.key === 'ArrowDown' && onMoveDown)  { e.preventDefault(); onMoveDown(); }
      }}
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
        transition: 'background var(--eb-transition-fast)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Icon size={18} style={{ flexShrink: 0, color: selected ? 'var(--eb-accent-primary)' : 'var(--eb-text-muted)' }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          title={agent.displayName || agent.id}
          style={{
            fontSize: 'var(--eb-text-md)',
            fontWeight: 'var(--eb-font-medium)',
            color: 'var(--eb-text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {agent.displayName || agent.id}
        </div>
        {agent.environmentName && (
          <div
            title={agent.environmentName}
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
              {agent.environmentName}
            </span>
          </div>
        )}
      </div>

      <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
        {hovered && canMarkUnread && (
          <span
            role="button"
            title="Mark as unread"
            onClick={e => { e.stopPropagation(); onMarkAsUnread(); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              borderRadius: 'var(--eb-radius-sm)',
              color: 'var(--eb-text-muted)',
              cursor: 'pointer',
              transition: 'color var(--eb-transition-fast)',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
          >
            <MailOpen size={12} />
          </span>
        )}
        {hovered && canMove && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {onMoveUp && (
              <MoveButton
                icon={ArrowUp}
                title="Move up (Alt+↑)"
                onClick={e => { e.stopPropagation(); onMoveUp(); }}
              />
            )}
            {onMoveDown && (
              <MoveButton
                icon={ArrowDown}
                title="Move down (Alt+↓)"
                onClick={e => { e.stopPropagation(); onMoveDown(); }}
              />
            )}
          </span>
        )}
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
      </span>
    </button>
  );
}

function MoveButton({ icon: Icon, title, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <span
      role="button"
      aria-label={title}
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 14,
        height: 14,
        borderRadius: 'var(--eb-radius-sm)',
        color: hovered ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
        cursor: 'pointer',
        transition: 'color var(--eb-transition-fast)',
      }}
    >
      <Icon size={10} />
    </span>
  );
}
