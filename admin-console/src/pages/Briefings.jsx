import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GitBranch, Server, ChevronLeft, ChevronRight } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { BPGraph } from './briefings/BPGraph';

function FlowRow({ agent, environmentName, selected, onSelect }) {
  return (
    <button
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
      <GitBranch size={18} style={{ flexShrink: 0, color: selected ? 'var(--eb-accent-primary)' : 'var(--eb-text-muted)' }} />
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
        {environmentName && (
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
            {environmentName}
          </div>
        )}
      </div>
    </button>
  );
}

export default function Briefings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [navCollapsed, setNavCollapsed] = useState(false);
  const selectedFlow = searchParams.get('flow');
  const { data: agents } = useApi('/api/agents');
  const { data: environments } = useApi('/api/environments');

  const orchestrators = (agents || []).filter(a => a.role === 'orchestrator');
  const envNameById = new Map((environments || []).map(e => [e.id, e.name]));

  function selectFlow(id) {
    setSearchParams({ flow: id });
  }

  const selectedAgent = orchestrators.find(a => a.id === selectedFlow);

  return (
    <div style={{
      display: 'flex',
      height: 'calc(100vh - var(--eb-header-height))',
      margin: 'calc(-1 * var(--eb-space-6))',
      background: 'var(--eb-bg-app)',
      overflow: 'hidden',
    }}>
      {/* Linke Spalte: Flow-Liste */}
      <div style={{
        width: navCollapsed ? 40 : 260,
        minWidth: navCollapsed ? 40 : 260,
        height: '100%',
        borderRight: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width var(--eb-transition-normal), min-width var(--eb-transition-normal)',
        flexShrink: 0,
      }}>
        {navCollapsed ? (
          /* Collapsed: nur Expand-Button */
          <button
            onClick={() => setNavCollapsed(false)}
            title="Flows einblenden"
            aria-label="Flows einblenden"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              padding: 'var(--eb-space-3) 0',
              background: 'none',
              border: 'none',
              borderBottom: '1px solid var(--eb-border-default)',
              color: 'var(--eb-text-secondary)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
          >
            <ChevronRight size={16} />
          </button>
        ) : (
          <>
            {/* Header mit Titel + Collapse-Button */}
            <div style={{
              padding: 'var(--eb-space-3) var(--eb-space-3) var(--eb-space-3) var(--eb-space-4)',
              borderBottom: '1px solid var(--eb-border-default)',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <div>
                <div style={{
                  fontSize: 'var(--eb-text-md)',
                  fontWeight: 'var(--eb-font-semibold)',
                  color: 'var(--eb-text-primary)',
                }}>
                  Flows
                </div>
                <div style={{
                  fontSize: 'var(--eb-text-xs)',
                  color: 'var(--eb-text-muted)',
                  marginTop: 'var(--eb-space-1)',
                }}>
                  {orchestrators.length > 0
                    ? `${orchestrators.length} flow${orchestrators.length !== 1 ? 's' : ''}`
                    : ''}
                </div>
              </div>
              <button
                onClick={() => setNavCollapsed(true)}
                title="Flows ausblenden"
                aria-label="Flows ausblenden"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--eb-text-secondary)',
                  cursor: 'pointer',
                  padding: 'var(--eb-space-1)',
                  display: 'flex',
                  alignItems: 'center',
                  flexShrink: 0,
                }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
              >
                <ChevronLeft size={16} />
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {orchestrators.length === 0 ? (
                <div style={{
                  padding: 'var(--eb-space-4)',
                  fontSize: 'var(--eb-text-sm)',
                  color: 'var(--eb-text-muted)',
                  textAlign: 'center',
                  lineHeight: 1.5,
                }}>
                  No orchestrator agent yet.<br />
                  Create an agent with role <strong>Orchestrator</strong>.
                </div>
              ) : (
                orchestrators.map(a => (
                  <FlowRow
                    key={a.id}
                    agent={a}
                    environmentName={envNameById.get(a.environmentId) || a.environmentId || null}
                    selected={selectedFlow === a.id}
                    onSelect={() => selectFlow(a.id)}
                  />
                ))
              )}
            </div>
          </>
        )}
      </div>

      {/* Right pane: graph */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {!selectedAgent ? (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)',
          }}>
            Select a flow
          </div>
        ) : (
          <BPGraph
            orchestratorId={selectedAgent.id}
            workspacePath={selectedAgent.briefingsPath
                ? `/workspace/agents/${selectedAgent.id}/${selectedAgent.briefingsPath}`
                : `/workspace/agents/${selectedAgent.id}`}
          />
        )}
      </div>
    </div>
  );
}
