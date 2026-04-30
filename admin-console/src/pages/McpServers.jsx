import React from 'react';
import { useApi } from '../hooks/useApi';
import DataTable from '../components/DataTable';

export default function McpServers() {
  const { data: mcpServers, loading, error } = useApi('/api/mcp');

  // mcpServers is an object keyed by server name
  const rows = mcpServers
    ? Object.entries(mcpServers).map(([name, cfg]) => ({
        name,
        command: Array.isArray(cfg.command) ? cfg.command[0] : (cfg.command || cfg.cmd || '—'),
        args: Array.isArray(cfg.args) ? cfg.args.length : (Array.isArray(cfg.command) ? cfg.command.length - 1 : 0),
        transport: cfg.transport || 'stdio',
      }))
    : [];

  const COLS = [
    { key: 'name',      label: 'Server Name', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)' }}>{v}</span> },
    { key: 'command',   label: 'Command' },
    { key: 'args',      label: 'Args count', align: 'right' },
    { key: 'transport', label: 'Transport' },
  ];

  if (loading) {
    return <div style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }

  if (error) {
    return (
      <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>
        Failed to load MCP config: {error}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
        MCP Servers
      </h1>

      <div style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        background: 'var(--eb-status-info-bg)',
        border: '1px solid var(--eb-status-info)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-primary)',
      }}>
        MCP-Konfiguration liegt im Pool-Volume unter <code style={{ fontFamily: 'var(--eb-font-mono)' }}>.claude/settings.json</code>. Diese Ansicht ist schreibgeschuetzt.
      </div>

      <DataTable
        columns={COLS}
        data={rows}
        emptyText="No MCP servers configured or settings.json not found."
      />
    </div>
  );
}
