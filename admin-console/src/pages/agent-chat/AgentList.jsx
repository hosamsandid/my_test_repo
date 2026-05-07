import React, { useState } from 'react';
import { MessageCircle, Bot, Clock, Server, MailOpen } from 'lucide-react';

/**
 * Vertical list of selectable agents in the left rail.
 *
 * Disabled agents stay clickable so the user can see the "agent disabled"
 * hint inside the chat panel — we don't want a silent no-op.
 *
 * @param {object[]} agents          List of `/api/matrix/agents` entries
 * @param {string|null} selectedAgentId
 * @param {(id:string)=>void} onSelect
 * @param {Record<string,string>} statuses  Map agentId → activityState
 */
export default function AgentList({ agents, selectedAgentId, onSelect, onMarkAsUnread, statuses = {} }) {
  const sorted = [...agents].sort((a, b) =>
    (a.displayName || a.id).localeCompare(b.displayName || b.id)
  );
  return (
    <div role="listbox" style={{ display: 'flex', flexDirection: 'column' }}>
      {sorted.map(agent => (
        <AgentRow
          key={agent.id}
          agent={agent}
          selected={agent.id === selectedAgentId}
          onSelect={() => onSelect(agent.id)}
          onMarkAsUnread={onMarkAsUnread ? () => onMarkAsUnread(agent.id) : null}
          activityState={statuses[agent.id] || 'idle'}
        />
      ))}
    </div>
  );
}

function iconForRole(role) {
  switch (role) {
    case 'expert':      return Bot;
    default:            return MessageCircle;
  }
}

const STATUS_DOT = {
  busy:    { color: 'var(--eb-status-warning)', label: 'Verarbeitet…',        pulse: true  },
  unread:  { color: 'var(--eb-status-success)', label: 'Neue Nachricht',       pulse: false },
  idle:    { color: 'var(--eb-text-muted)',     label: 'Wartet auf Eingabe',  pulse: false },
  problem: { color: 'var(--eb-status-error)',   label: 'Nicht verfügbar',      pulse: false },
};

function AgentRow({ agent, selected, onSelect, onMarkAsUnread, activityState = 'idle' }) {
  const Icon = iconForRole(agent.role);
  const dot = STATUS_DOT[activityState] ?? STATUS_DOT.problem;
  const [hovered, setHovered] = useState(false);

  // The "mark as unread" button is shown on hover when the agent is not
  // already unread and not in an error/offline state.
  const canMarkUnread = onMarkAsUnread && activityState !== 'unread' && activityState !== 'problem';

  return (
    <button
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-3)',
        width: '100%',
        padding: 'var(--eb-space-2) var(--eb-space-3)',
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
        <div style={{
          fontSize: 'var(--eb-text-md)',
          fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {agent.displayName || agent.id}
        </div>
        {agent.environmentName && (
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            marginTop: 2,
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            <Server size={10} style={{ flexShrink: 0 }} />
            {agent.environmentName}
          </div>
        )}
      </div>

      <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
        {hovered && canMarkUnread && (
          <span
            role="button"
            title="Als ungelesen markieren"
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
