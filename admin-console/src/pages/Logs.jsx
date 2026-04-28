import React, { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import LogStream from '../components/LogStream';

const STATIC_CONTAINERS = ['orchestrator', 'claude-bridge', 'conduwuit'];

export default function Logs() {
  const { data: agentContainers } = useApi('/api/containers');
  const [selectedContainer, setSelectedContainer] = useState('orchestrator');
  const [streamKey, setStreamKey] = useState(0);

  const allContainers = [
    ...STATIC_CONTAINERS,
    ...(agentContainers ?? []).map(c => c.name).filter(n => !STATIC_CONTAINERS.includes(n)),
  ];

  function handleSelect(name) {
    setSelectedContainer(name);
    setStreamKey(k => k + 1);
  }

  function handleClear() {
    setStreamKey(k => k + 1);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
          Logs
        </h1>
        <button
          onClick={handleClear}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            color: 'var(--eb-text-secondary)',
            cursor: 'pointer',
            fontSize: 'var(--eb-text-sm)',
            fontFamily: 'inherit',
          }}
        >
          Clear
        </button>
      </div>

      {/* Container selector */}
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
        {allContainers.map(name => {
          const isActive = selectedContainer === name;
          return (
            <button
              key={name}
              onClick={() => handleSelect(name)}
              style={{
                padding: 'var(--eb-space-2) var(--eb-space-3)',
                background: isActive ? 'var(--eb-bg-selected)' : 'var(--eb-bg-surface)',
                border: `1px solid ${isActive ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
                borderRadius: 'var(--eb-radius-md)',
                color: isActive ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
                cursor: 'pointer',
                fontSize: 'var(--eb-text-sm)',
                fontFamily: 'var(--eb-font-mono)',
                transition: 'all var(--eb-transition-fast)',
              }}
            >
              {name}
            </button>
          );
        })}
      </div>

      {/* Log stream */}
      <LogStream key={`${selectedContainer}-${streamKey}`} container={selectedContainer} />
    </div>
  );
}
