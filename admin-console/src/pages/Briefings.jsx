import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { BPGraph } from './briefings/BPGraph';

export default function Briefings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedFlow = searchParams.get('flow');
  const { data: agents } = useApi('/api/agents');

  const orchestrators = (agents || []).filter(a => a.role === 'orchestrator');

  function selectFlow(id) {
    setSearchParams({ flow: id });
  }

  const selectedAgent = orchestrators.find(a => a.id === selectedFlow);

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Linke Spalte: Orchestrator-Liste */}
      <div style={{
        width: 280, flexShrink: 0,
        borderRight: '1px solid var(--eb-border-default)',
        overflowY: 'auto',
        padding: 'var(--eb-space-4)',
      }}>
        <div style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Flows
        </div>
        {orchestrators.length === 0 && (
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
            Kein Orchestrator-Agent vorhanden.<br />
            Lege einen Agenten mit Rolle &ldquo;Orchestrator&rdquo; an.
          </div>
        )}
        {orchestrators.map(a => (
          <button
            key={a.id}
            onClick={() => selectFlow(a.id)}
            style={{
              width: '100%', textAlign: 'left',
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              borderRadius: 'var(--eb-radius-md)',
              border: 'none',
              background: selectedFlow === a.id ? 'var(--eb-accent-primary)' : 'transparent',
              color: selectedFlow === a.id ? 'white' : 'var(--eb-text-primary)',
              cursor: 'pointer',
              fontSize: 'var(--eb-text-sm)',
              marginBottom: 'var(--eb-space-1)',
            }}
          >
            {a.displayName}
          </button>
        ))}
      </div>

      {/* Rechte Fläche: Graph */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {!selectedAgent ? (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)',
          }}>
            Flow auswählen
          </div>
        ) : (
          <BPGraph
            orchestratorId={selectedAgent.id}
            workspacePath={`/workspace/agents/${selectedAgent.id}`}
          />
        )}
      </div>
    </div>
  );
}
