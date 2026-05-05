import React from 'react';
import { useApi } from '../hooks/useApi';

function ConfigRow({ label, value, mono }) {
  const isEmpty = !value;
  return (
    <tr>
      <td style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        color: 'var(--eb-text-secondary)',
        fontSize: 'var(--eb-text-sm)',
        fontWeight: 'var(--eb-font-medium)',
        whiteSpace: 'nowrap',
        borderBottom: '1px solid var(--eb-border-default)',
        width: '200px',
      }}>
        {label}
      </td>
      <td style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        fontFamily: mono ? 'var(--eb-font-mono)' : 'inherit',
        fontSize: 'var(--eb-text-sm)',
        color: isEmpty ? 'var(--eb-text-tertiary)' : 'var(--eb-text-primary)',
        borderBottom: '1px solid var(--eb-border-default)',
      }}>
        {isEmpty ? '(not set)' : value}
      </td>
    </tr>
  );
}

export default function ModelRegistry() {
  const { data: config, loading, error } = useApi('/api/llm-config');

  if (loading) return <div style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  if (error) return <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>Failed to load LLM config: {error}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
        Model Registry
      </h1>

      <div style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        background: 'var(--eb-bg-elevated)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-secondary)',
      }}>
        Settings are loaded from the <code style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', background: 'var(--eb-bg-subtle)', padding: '1px 4px', borderRadius: 'var(--eb-radius-sm)' }}>.env</code> configuration file. To change them, update the file and restart the stack.
      </div>

      <div style={{
        background: 'var(--eb-bg-elevated)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-lg)',
        overflow: 'hidden',
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            <ConfigRow label="Endpoint (Base URL)" value={config?.baseUrl} mono />
            <ConfigRow label="Auth Token"           value={config?.authToken} mono />
            <ConfigRow label="Sonnet Model"         value={config?.sonnetModel} mono />
            <ConfigRow label="Haiku Model"          value={config?.haikuModel} mono />
          </tbody>
        </table>
      </div>
    </div>
  );
}
