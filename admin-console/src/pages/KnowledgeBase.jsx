import React, { useState } from 'react';
import { useApi } from '../hooks/useApi';
import SidePanel from '../components/SidePanel';

function SourceBadge({ source }) {
  const isPool = source === 'pool';
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 8px',
      borderRadius: 'var(--eb-radius-sm)',
      fontSize: 'var(--eb-text-xs)',
      fontWeight: 'var(--eb-font-medium)',
      background: isPool ? 'var(--eb-accent-muted)' : 'var(--eb-status-info-bg)',
      color: isPool ? 'var(--eb-accent-primary)' : 'var(--eb-status-info)',
      border: `1px solid ${isPool ? 'var(--eb-accent-primary)' : 'var(--eb-status-info)'}`,
    }}>
      {source}
    </span>
  );
}

function SkillCard({ skill, onClick }) {
  return (
    <button
      onClick={() => onClick(skill)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--eb-space-2)',
        padding: 'var(--eb-space-4)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-lg)',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'border-color var(--eb-transition-fast)',
        width: '100%',
      }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--eb-border-hover)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--eb-border-default)'}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--eb-space-2)' }}>
        <span style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
          {skill.name}
        </span>
        <SourceBadge source={skill.source} />
      </div>
      {skill.agentId && (
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
          Agent: {skill.agentId}
        </span>
      )}
    </button>
  );
}

export default function KnowledgeBase() {
  const { data: skills, loading, error } = useApi('/api/skills');
  const [selectedSkill, setSelectedSkill] = useState(null);
  const [skillContent, setSkillContent] = useState(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState(null);

  async function openSkill(skill) {
    setSelectedSkill(skill);
    setSkillContent(null);
    setContentError(null);
    setContentLoading(true);
    try {
      const params = new URLSearchParams({ source: skill.source });
      if (skill.agentId) params.set('agentId', skill.agentId);
      const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}/content?${params}`);
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
      <div aria-busy="true" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 'var(--eb-space-4)' }}>
        {[1, 2, 3, 4].map(i => (
          <div key={i} style={{ height: 80, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>
        Failed to load knowledge base: {error}
      </div>
    );
  }

  const allSkills = skills ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
          Knowledge Base
        </h1>
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
          {allSkills.length} {allSkills.length === 1 ? 'skill' : 'skills'} found
        </span>
      </div>

      {allSkills.length === 0 ? (
        <div style={{
          padding: 'var(--eb-space-12)',
          textAlign: 'center',
          background: 'var(--eb-bg-surface)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-lg)',
          color: 'var(--eb-text-muted)',
          fontSize: 'var(--eb-text-sm)',
        }}>
          No skills found. Add skills under <code style={{ fontFamily: 'var(--eb-font-mono)' }}>skills/&lt;name&gt;/SKILL.md</code> in either workspace.
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 'var(--eb-space-4)',
        }}>
          {allSkills.map((skill, i) => (
            <SkillCard
              key={`${skill.source}-${skill.agentId || ''}-${skill.name}-${i}`}
              skill={skill}
              onClick={openSkill}
            />
          ))}
        </div>
      )}

      <SidePanel
        open={!!selectedSkill}
        onClose={() => { setSelectedSkill(null); setSkillContent(null); }}
        title={selectedSkill ? `${selectedSkill.name}` : ''}
        width="560px"
      >
        {selectedSkill && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
            <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
              <SourceBadge source={selectedSkill.source} />
              {selectedSkill.agentId && (
                <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
                  {selectedSkill.agentId}
                </span>
              )}
            </div>
            {contentLoading && <div style={{ color: 'var(--eb-text-muted)' }}>Loading...</div>}
            {contentError && <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load: {contentError}</div>}
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
          </div>
        )}
      </SidePanel>
    </div>
  );
}
