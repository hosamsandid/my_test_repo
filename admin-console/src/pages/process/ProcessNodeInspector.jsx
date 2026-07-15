import React, { useEffect, useState } from 'react';
import { Save, Loader2 } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import { apiCall } from '../../hooks/useApi';
import TriggersPanel from '../agent-chat/TriggersPanel';
import ConnectionsSection from './ConnectionsSection';
import { liveOps } from './edit-adapters';

// Node inspector for the Process Canvas (#331). Opened when an agent node is
// clicked. Tabs — Prompt, Triggers, Connections — that write back through
// existing endpoints; on any write it calls onChanged so the canvas re-fetches
// the graph. The Connections tab (#unified) edits the same declarative edges
// (parent / stage / dependency / data-flow) a draft does, via liveOps.
export default function ProcessNodeInspector({ node, level, nodes = [], onClose, onChanged }) {
  const [tab, setTab] = useState('prompt');
  if (!node) return null;
  const isTemplate = level === 'template' || node.role === 'template';
  const siblings = nodes.filter(n => n.id !== node.id).map(n => ({ id: n.id, displayName: n.displayName || n.id }));
  const inheritedStage = !node.stage && node.effectiveStage ? node.effectiveStage : '';

  return (
    <SidePanel open onClose={onClose} title={node.displayName || node.id} width="560px">
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-4)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
        <Badge>{node.role || 'agent'}</Badge>
        {node.sessionPolicy === 'per-invocation' && <Badge>per-invocation</Badge>}
        {node.isEntryPoint && <Badge>DM entry point</Badge>}
      </div>

      {isTemplate ? (
        <TemplateReadonly node={node} />
      ) : (
        <>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--eb-border-default)', marginBottom: 'var(--eb-space-4)' }}>
            <TabButton active={tab === 'prompt'} onClick={() => setTab('prompt')}>Prompt</TabButton>
            <TabButton active={tab === 'triggers'} onClick={() => setTab('triggers')}>Triggers</TabButton>
            <TabButton active={tab === 'connections'} onClick={() => setTab('connections')}>Connections</TabButton>
          </div>
          {tab === 'prompt' && <PromptTab agentId={node.id} onChanged={onChanged} />}
          {tab === 'triggers' && (
            <div style={{ height: 'min(60vh, 540px)', display: 'flex', flexDirection: 'column', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', overflow: 'hidden' }}>
              <TriggersPanel agentId={node.id} active onChanged={onChanged} />
            </div>
          )}
          {tab === 'connections' && (
            <ConnectionsSection node={node} siblings={siblings} inheritedStage={inheritedStage}
              ops={liveOps} onChanged={onChanged} />
          )}
        </>
      )}
    </SidePanel>
  );
}

function PromptTab({ agentId, onChanged }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Resolved per-agent shape:
  const [mode, setMode] = useState('file');   // 'file' (AGENT-PROMPT.md) | 'member'
  const [text, setText] = useState('');
  const [inherit, setInherit] = useState(false);
  const [inheritedPreview, setInheritedPreview] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await apiCall('GET', `/api/agents/${agentId}`);
        if (!alive) return;
        if (cfg.role === 'team-member') {
          setMode('member');
          const hasOverride = typeof cfg.systemPrompt === 'string' && cfg.systemPrompt.length > 0;
          setInherit(!hasOverride);
          setText(cfg.systemPrompt || '');
          if (cfg.parentTeamId) {
            try {
              const team = await apiCall('GET', `/api/agents/${cfg.parentTeamId}`);
              if (alive) setInheritedPreview(team.systemPromptTemplate || '');
            } catch { /* preview best-effort */ }
          }
        } else {
          setMode('file');
          const { content } = await apiCall('GET', `/api/agents/${agentId}/prompt`);
          if (alive) setText(content || '');
        }
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [agentId]);

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      if (mode === 'member') {
        await apiCall('PUT', `/api/agents/${agentId}`, { systemPrompt: inherit ? null : text });
      } else {
        await apiCall('PUT', `/api/agents/${agentId}/prompt`, { content: text });
      }
      setSaved(true);
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Centered><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading prompt…</Centered>;

  const editingDisabled = mode === 'member' && inherit;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      {mode === 'member' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          <input type="checkbox" checked={inherit} onChange={e => { setInherit(e.target.checked); setSaved(false); }} />
          Inherit agent prompt from team
        </label>
      )}

      <textarea
        value={editingDisabled ? inheritedPreview : text}
        onChange={e => { setText(e.target.value); setSaved(false); }}
        readOnly={editingDisabled}
        placeholder={mode === 'member' ? 'Custom agent prompt for this member…' : 'AGENT-PROMPT.md…'}
        style={{
          width: '100%', minHeight: 320, resize: 'vertical', boxSizing: 'border-box',
          fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)', lineHeight: 1.5,
          background: editingDisabled ? 'var(--eb-bg-elevated)' : 'var(--eb-bg-app)',
          color: editingDisabled ? 'var(--eb-text-muted)' : 'var(--eb-text-primary)',
          border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
          padding: 'var(--eb-space-3)', outline: 'none',
        }}
      />
      {editingDisabled && (
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Showing the team template (read-only). Untick “Inherit” to set a custom prompt for this member.
        </span>
      )}

      {error && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</span>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
        <button onClick={save} disabled={saving} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
          border: 'none', borderRadius: 'var(--eb-radius-md)', padding: '6px 14px',
          fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
          cursor: saving ? 'wait' : 'pointer',
        }}>
          {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={14} />}
          Save prompt
        </button>
        {saved && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-success)' }}>Saved.</span>}
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function TemplateReadonly({ node }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
        This is an <strong>agent template</strong> (blueprint view). Editing happens on live agents —
        switch the scope to a team, or materialise this agent via the Team Wizard.
      </div>
      <div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 4 }}>Triggers</div>
        {(node.triggers || []).length === 0
          ? <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>None.</span>
          : (node.triggers || []).map(t => (
            <div key={t.id} style={{ fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-secondary)', padding: '3px 0', borderTop: '1px solid var(--eb-border-default)' }}>
              <span>{t.type}</span>
              {t.labelFilter ? ` · 🏷 ${t.labelFilter}` : (t.events?.length ? ` · ${t.events.join(', ')}` : '')}
              {Array.isArray(t.emits) && t.emits.length > 0 && (
                <span style={{ color: 'var(--eb-status-info)' }}> → {t.emits.join(', ')}{t.emitsDerived ? ' ≈' : ''}</span>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: 'none', border: 'none', borderBottom: active ? '2px solid var(--eb-accent-primary)' : '2px solid transparent',
      color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
      padding: 'var(--eb-space-2) var(--eb-space-3)', cursor: 'pointer',
      fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: active ? 'var(--eb-font-medium)' : 'normal',
    }}>{children}</button>
  );
}

function Badge({ children }) {
  return (
    <span style={{
      fontSize: 'var(--eb-text-xs)', padding: '1px 7px', borderRadius: 'var(--eb-radius-full)',
      border: '1px solid var(--eb-border-default)', color: 'var(--eb-text-secondary)',
    }}>{children}</span>
  );
}

function Centered({ children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-6)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
      {children}
    </div>
  );
}
