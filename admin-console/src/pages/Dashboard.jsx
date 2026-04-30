import React from 'react';
import { useApi } from '../hooks/useApi';
import StatGrid from '../components/StatGrid';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';

function Skeleton() {
  return (
    <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--eb-space-4)' }}>
        {[1, 2, 3, 4].map(i => (
          <div key={i} style={{ height: 96, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
        ))}
      </div>
      <div style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
    </div>
  );
}

const AGENT_COLS = [
  { key: 'id',          label: 'ID' },
  { key: 'displayName', label: 'Name' },
  { key: 'role',        label: 'Role' },
  { key: 'enabled',     label: 'Status', sortable: false, render: v => <StatusBadge enabled={v !== false} /> },
];

export default function Dashboard() {
  const { data: dash, loading: dashLoading, error: dashError } = useApi('/api/dashboard');
  const { data: agents, loading: agentsLoading, error: agentsError } = useApi('/api/agents');

  if (dashLoading || agentsLoading) return <Skeleton />;

  if (dashError) {
    return (
      <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>
        Failed to load dashboard: {dashError}
      </div>
    );
  }

  const stats = dash ? [
    { label: 'Total Agents',    value: dash.agents?.total    ?? 0 },
    { label: 'Active',          value: dash.agents?.active   ?? 0, status: 'success' },
    { label: 'Disabled',        value: dash.agents?.disabled ?? 0, status: dash.agents?.disabled > 0 ? 'warning' : undefined },
    { label: 'Scheduled Jobs',  value: dash.jobs?.total      ?? 0 },
    { label: 'Skills',          value: dash.skills?.total    ?? 0 },
  ] : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-6)' }}>
      <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
        Dashboard
      </h1>

      <StatGrid stats={stats} />

      <section>
        <h2 style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', marginBottom: 'var(--eb-space-3)' }}>
          Agents
        </h2>
        {agentsError ? (
          <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
            Failed to load agents: {agentsError}
          </div>
        ) : (
          <DataTable
            columns={AGENT_COLS}
            data={agents ?? []}
            emptyText="No agents found. Add agents via Agent Manager."
          />
        )}
      </section>
    </div>
  );
}
