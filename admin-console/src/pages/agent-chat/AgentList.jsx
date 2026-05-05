import React from 'react';
import { MessageCircle, Bot, Brain, Clock, Server } from 'lucide-react';

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
export default function AgentList({ agents, selectedAgentId, onSelect, statuses = {} }) {
  return (
    <div role="listbox" style={{ display: 'flex', flexDirection: 'column' }}>
      {agents.map(agent => (
        <AgentRow
          key={agent.id}
          agent={agent}
          selected={agent.id === selectedAgentId}
          onSelect={() => onSelect(agent.id)}
          activityState={statuses[agent.id] || 'idle'}
        />
      ))}
    </div>
  );
}

function iconForRole(role) {
  switch (role) {
    case 'synthesizer': return Brain;
    case 'autonomous':  return Clock;
    case 'expert':      return Bot;
    default:            return MessageCircle;
  }
}

const STATUS_DOT = {
  busy:     { color: 'var(--eb-status-warning)', label: 'Arbeitet gerade…', pulse: true },
  idle:     { color: 'var(--eb-status-success)', label: 'Bereit',           pulse: false },
  offline:  { color: 'var(--eb-status-error)',   label: 'Offline',          pulse: false },
  disabled: { color: 'var(--eb-text-muted)',     label: 'Deaktiviert',      pulse: false },
};

function AgentRow({ agent, selected, onSelect, activityState = 'idle' }) {
  const Icon = iconForRole(agent.role);
  const dot = STATUS_DOT[activityState] ?? STATUS_DOT.idle;

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
        background: selected ? 'var(--eb-bg-selected)' : 'transparent',
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
      onMouseEnter={e => {
        if (!selected) e.currentTarget.style.background = 'var(--eb-bg-hover)';
      }}
      onMouseLeave={e => {
        if (!selected) e.currentTarget.style.background = 'transparent';
      }}
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
    </button>
  );
}
