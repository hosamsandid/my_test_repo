import React, { useState } from 'react';
import { useApi } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';

const COLUMNS = [
  { key: 'name',    label: 'Skill Name' },
  { key: 'source',  label: 'Source', render: v => (
    <span style={{
      padding: '1px 8px',
      borderRadius: 'var(--eb-radius-sm)',
      fontSize: 'var(--eb-text-xs)',
      fontWeight: 'var(--eb-font-medium)',
      background: v === 'pool' ? 'var(--eb-accent-muted)' : 'var(--eb-status-info-bg)',
      color: v === 'pool' ? 'var(--eb-accent-primary)' : 'var(--eb-status-info)',
      border: `1px solid ${v === 'pool' ? 'var(--eb-accent-primary)' : 'var(--eb-status-info)'}`,
    }}>
      {v}
    </span>
  )},
  { key: 'agentId', label: 'Agent', render: v => v ? (
    <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span>
  ) : (
    <span style={{ color: 'var(--eb-text-muted)' }}>—</span>
  )},
];

export default function SkillsRegistry() {
  const { data: skills, loading, error } = useApi('/api/skills');
  const [selectedSkill, setSelectedSkill] = useState(null);
  const [skillContent, setSkillContent] = useState(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState(null);

  async function openSkill(row) {
    setSelectedSkill(row);
    setSkillContent(null);
    setContentError(null);
    setContentLoading(true);
    try {
      const params = new URLSearchParams({ source: row.source });
      if (row.agentId) params.set('agentId', row.agentId);
      const res = await fetch(`/api/skills/${encodeURIComponent(row.name)}/content?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSkillContent(data.content);
    } catch (e) {
      setContentError(e.message);
    } finally {
      setContentLoading(false);
    }
  }

  if (loading) {
    return (
      <div aria-busy="true" style={{ height: 300, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
    );
  }

  if (error) {
    return (
      <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>
        Failed to load skills: {error}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
        Skills Registry
      </h1>

      <div style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-secondary)',
      }}>
        Skills are filesystem-managed. Add skills via the workspace volumes under <code style={{ fontFamily: 'var(--eb-font-mono)' }}>skills/&lt;name&gt;/SKILL.md</code>.
      </div>

      <DataTable
        columns={COLUMNS}
        data={skills ?? []}
        onRowClick={openSkill}
        emptyText="No skills found in the pool or in agent workspaces."
      />

      <SidePanel
        open={!!selectedSkill}
        onClose={() => setSelectedSkill(null)}
        title={selectedSkill ? `${selectedSkill.name} (${selectedSkill.source})` : ''}
        width="560px"
      >
        {contentLoading && (
          <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading...</div>
        )}
        {contentError && (
          <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
            Failed to load skill content: {contentError}
          </div>
        )}
        {skillContent != null && !contentLoading && (
          <pre style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 'var(--eb-text-sm)',
            fontFamily: 'var(--eb-font-mono)',
            color: 'var(--eb-text-primary)',
            lineHeight: 1.6,
            margin: 0,
          }}>
            {skillContent || '(empty)'}
          </pre>
        )}
      </SidePanel>
    </div>
  );
}
