import React, { useState, useCallback } from 'react';
import { Edit, Trash2, FileText, Plus, Copy, Folder } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import StatusBadge from '../components/StatusBadge';
import FormInput from '../components/FormInput';
import DirectoryPicker from '../components/DirectoryPicker';

const hasRepos = (env) =>
  (Array.isArray(env?.repositories) && env.repositories.length > 0) ||
  !!env?.repository?.url;

/* ── Toggle switch ─────────────────────────────────────────────────── */
function ToggleSwitch({ checked, onChange, label }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      style={{
        width: 40, height: 22,
        borderRadius: 'var(--eb-radius-full)',
        border: 'none',
        background: checked ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)',
        position: 'relative',
        cursor: 'pointer',
        transition: 'background var(--eb-transition-fast)',
        flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 20 : 2,
        width: 18, height: 18, borderRadius: '50%',
        background: 'white',
        transition: 'left var(--eb-transition-fast)',
      }} />
    </button>
  );
}

/* ── Info banner ───────────────────────────────────────────────────── */
function InfoBanner({ children }) {
  return (
    <div style={{
      padding: 'var(--eb-space-3) var(--eb-space-4)',
      background: 'var(--eb-status-info-bg)',
      border: '1px solid var(--eb-status-info)',
      borderRadius: 'var(--eb-radius-md)',
      fontSize: 'var(--eb-text-sm)',
      color: 'var(--eb-text-primary)',
    }}>
      {children}
    </div>
  );
}

/* ── Edit form ─────────────────────────────────────────────────────── */
function AgentEditForm({ agent, onSave, onCancel }) {
  const [form, setForm] = useState({
    displayName: agent.displayName || '',
    role: agent.role || 'expert',
    enabled: agent.enabled !== false,
  });

  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-0-5)' }}>
          ID (read-only)
        </div>
        <div style={{
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-bg-app)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-sm)',
          fontFamily: 'var(--eb-font-mono)',
          color: 'var(--eb-text-muted)',
        }}>
          {agent.id}
        </div>
      </div>

      <FormInput
        label="Display Name"
        value={form.displayName}
        onChange={v => update('displayName', v)}
      />

      <div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-0-5)' }}>
          Role
        </div>
        <select
          value={form.role}
          onChange={e => update('role', e.target.value)}
          style={{
            width: '100%',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            color: 'var(--eb-text-primary)',
            fontSize: 'var(--eb-text-sm)',
            fontFamily: 'inherit',
            outline: 'none',
          }}
        >
          <option value="expert">Expert</option>
          <option value="autonomous">Autonomous</option>
          <option value="orchestrator">Orchestrator</option>
        </select>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
        <ToggleSwitch
          checked={form.enabled}
          onChange={v => update('enabled', v)}
          label="Agent enabled"
        />
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          {form.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={() => onSave(form)}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          Save Changes
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
            cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Create form ───────────────────────────────────────────────────── */
function AgentCreateForm({ onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    id: '', displayName: '', role: 'expert', environmentId: '',
    systemPrompt: '', schedule: '', taskPrompt: '',
    briefingsPath: '',
  });
  const [showDirPicker, setShowDirPicker] = useState(false);
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const { data: environments } = useApi('/api/environments');
  const envs = environments || [];

  const labelStyle = { fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-0-5)' };
  const inputStyle = { width: '100%', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' };

  const canSubmit = form.id && form.displayName && form.environmentId &&
    (form.role === 'orchestrator' || form.systemPrompt);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)' }}>
          {error}
        </div>
      )}

      {envs.length === 0 && (
        <div role="alert" style={{
          color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-3)', background: 'var(--eb-status-warning-bg)',
          border: '1px solid var(--eb-status-warning)',
          borderRadius: 'var(--eb-radius-md)',
        }}>
          No Working Environment has been created yet. Create one first under <strong>Working Environments</strong>.
        </div>
      )}

      <div>
        <div style={labelStyle}>ID <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <input style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)' }} value={form.id} onChange={e => update('id', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="e.g. cobol-expert" />
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>Only lowercase letters, digits and hyphens. Becomes @id:local.</div>
      </div>

      <FormInput label="Display Name *" value={form.displayName} onChange={v => update('displayName', v)} placeholder="COBOL Expert" />

      <div>
        <div style={labelStyle}>Working Environment <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <select value={form.environmentId} onChange={e => update('environmentId', e.target.value)} style={inputStyle} disabled={envs.length === 0}>
          <option value="">— please select —</option>
          {envs.map(env => (
            <option key={env.id} value={env.id}>
              {env.name} ({env.id})
              {hasRepos(env) ? ' · Git' : ''}
              {Array.isArray(env.skills) && env.skills.length > 0 ? ` · ${env.skills.length} Skills` : ''}
            </option>
          ))}
        </select>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          Defines the skills, repository and context the agent gets in its workspace.
        </div>
      </div>

      <div>
        <div style={labelStyle}>Role <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <select value={form.role} onChange={e => update('role', e.target.value)} style={inputStyle}>
          <option value="expert">Expert — responds to questions in the room</option>
          <option value="autonomous">Autonomous — runs on its own schedule</option>
          <option value="orchestrator">Orchestrator</option>
        </select>
      </div>

      {form.role === 'autonomous' && (
        <>
          <div>
            <div style={labelStyle}>Cron Schedule</div>
            <input style={inputStyle} value={form.schedule} onChange={e => update('schedule', e.target.value)} placeholder="0 8 * * 1-5 (Mon–Fri at 8 AM)" />
          </div>
          <div>
            <div style={labelStyle}>Task Prompt (run on every trigger)</div>
            <textarea value={form.taskPrompt} onChange={e => update('taskPrompt', e.target.value)} placeholder="What the agent should do on every trigger..." rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
          </div>
        </>
      )}

      {form.role === 'orchestrator' && (
        <div>
          <div style={labelStyle}>Briefings-Verzeichnis</div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              value={form.briefingsPath}
              onChange={e => update('briefingsPath', e.target.value)}
              placeholder="z.B. briefings/"
            />
            <button
              type="button"
              onClick={() => setShowDirPicker(true)}
              disabled={!form.id}
              title={form.id ? 'Verzeichnis auswählen' : 'Bitte zuerst eine Agent-ID eingeben'}
              style={{
                display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)',
                padding: 'var(--eb-space-2) var(--eb-space-3)',
                background: 'var(--eb-bg-elevated)',
                border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-md)',
                color: 'var(--eb-text-secondary)',
                cursor: form.id ? 'pointer' : 'not-allowed',
                fontSize: 'var(--eb-text-sm)',
                fontFamily: 'inherit',
                flexShrink: 0,
                opacity: form.id ? 1 : 0.5,
              }}
            >
              <Folder size={15} />
              Durchsuchen
            </button>
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
            Pfad im Agenten-Workspace, in dem BriefingPacks abgelegt werden.
          </div>
        </div>
      )}

      {form.role !== 'orchestrator' && (
        <div>
          <div style={labelStyle}>System Prompt <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
          <textarea value={form.systemPrompt} onChange={e => update('systemPrompt', e.target.value)} placeholder="You are an experienced COBOL developer..." rows={8} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={() => onSave(form)}
          disabled={saving || !canSubmit}
          style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit', opacity: (saving || !canSubmit) ? 0.6 : 1 }}
        >
          {saving ? 'Creating agent…' : 'Create agent'}
        </button>
        <button onClick={onCancel} style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)', cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit' }}>
          Cancel
        </button>
      </div>

      {saving && (
        <div style={{ padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-info-bg)', border: '1px solid var(--eb-status-info)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-info)' }}>
          {form.role === 'orchestrator'
            ? 'Setting up the orchestrator — provisioning the Matrix user, preparing the workspace, cloning repositories, and initializing the BriefingPack loop. This may take a minute or two, please wait.'
            : 'Setting up the agent — provisioning the Matrix user, preparing the workspace, and cloning repositories. This may take a moment, please wait.'}
        </div>
      )}

      {showDirPicker && form.id && (
        <DirectoryPicker
          agentId={form.id}
          onSelect={(selectedPath) => {
            update('briefingsPath', selectedPath);
            setShowDirPicker(false);
          }}
          onClose={() => setShowDirPicker(false)}
        />
      )}
    </div>
  );
}

/* ── Prompt editor ─────────────────────────────────────────────────── */
function PromptEditor({ agentId, onClose }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  React.useEffect(() => {
    fetch(`/api/agents/${agentId}/prompt`)
      .then(r => r.json())
      .then(d => { setContent(d.content || ''); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [agentId]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await apiCall('PUT', `/api/agents/${agentId}/prompt`, { content });
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ color: 'var(--eb-text-muted)' }}>Loading prompt...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)', height: '100%' }}>
      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
          {error}
        </div>
      )}
      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        placeholder="Enter the agent's system prompt (AGENT-PROMPT.md)..."
        style={{
          flex: 1,
          minHeight: 400,
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
          color: 'var(--eb-text-primary)',
          fontSize: 'var(--eb-text-sm)',
          fontFamily: 'var(--eb-font-mono)',
          resize: 'vertical',
          outline: 'none',
        }}
      />
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit',
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Save Prompt'}
        </button>
        <button
          onClick={onClose}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
            cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Clone form ────────────────────────────────────────────────────── */
function AgentCloneForm({ sourceAgent, onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    newId: '',
    newDisplayName: `Copy of ${sourceAgent.displayName || sourceAgent.id}`,
  });
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const labelStyle = { fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-0-5)' };
  const inputStyle = { width: '100%', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' };

  const canSubmit = form.newId && form.newDisplayName;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)' }}>
          {error}
        </div>
      )}

      <InfoBanner>
        Clones the full workspace of <strong>{sourceAgent.displayName || sourceAgent.id}</strong> —
        including memory, skills, prompt and triggers. Session history is not copied.
      </InfoBanner>

      <div>
        <div style={labelStyle}>Neue ID <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <input
          style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)' }}
          value={form.newId}
          onChange={e => update('newId', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
          placeholder="e.g. cobol-expert-2"
        />
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          Only lowercase letters, digits and hyphens. Becomes @id:local.
        </div>
      </div>

      <FormInput
        label="Display Name *"
        value={form.newDisplayName}
        onChange={v => update('newDisplayName', v)}
        placeholder="COBOL Expert 2"
      />

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={() => onSave(form)}
          disabled={saving || !canSubmit}
          style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit', opacity: (saving || !canSubmit) ? 0.6 : 1 }}
        >
          {saving ? 'Cloning agent…' : 'Clone agent'}
        </button>
        <button
          onClick={onCancel}
          style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)', cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Main component ────────────────────────────────────────────────── */
export default function AgentManager() {
  const { data: agents, loading, error, refetch } = useApi('/api/agents');
  const [panelMode, setPanelMode] = useState(null); // null | 'create' | 'edit' | 'prompt' | 'clone'
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState(null);

  const COLUMNS = [
    { key: 'id',          label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'displayName', label: 'Name' },
    { key: 'role',        label: 'Role', render: v => <span style={{ textTransform: 'capitalize' }}>{v || '--'}</span> },
    { key: 'environmentId', label: 'Environment', render: v => v ? (
      <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span>
    ) : <span style={{ color: 'var(--eb-text-muted)' }}>—</span> },
    { key: 'enabled',     label: 'Status', sortable: false, render: (v) => <StatusBadge enabled={v !== false} /> },
    {
      key: '_actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <div style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
          <ActionBtn icon={Edit} label="Edit" onClick={() => { setSelectedAgent(row); setPanelMode('edit'); }} />
          <ActionBtn icon={FileText} label="Prompt" onClick={() => { setSelectedAgent(row); setPanelMode('prompt'); }} />
          <ActionBtn icon={Copy} label="Clone" onClick={() => { setCloneError(null); setSelectedAgent(row); setPanelMode('clone'); }} />
          <ActionBtn icon={Trash2} label="Delete" danger onClick={() => setDeleteTarget(row)} />
        </div>
      ),
    },
  ];

  async function handleToggleEnabled(agent) {
    try {
      await apiCall('PUT', `/api/agents/${agent.id}`, { enabled: !(agent.enabled !== false) });
      refetch();
    } catch (e) {
      setActionError(e.message);
    }
  }

  async function handleSaveEdit(form) {
    try {
      await apiCall('PUT', `/api/agents/${selectedAgent.id}`, form);
      setPanelMode(null);
      setSelectedAgent(null);
      refetch();
    } catch (e) {
      setActionError(e.message);
    }
  }

  async function handleCreate(form) {
    setCreating(true);
    setCreateError(null);
    try {
      await apiCall('POST', '/api/agents', form);
      setPanelMode(null);
      refetch();
    } catch (e) {
      setCreateError(e.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleClone(form) {
    setCloning(true);
    setCloneError(null);
    try {
      await apiCall('POST', `/api/agents/${selectedAgent.id}/clone`, {
        newId: form.newId,
        newDisplayName: form.newDisplayName,
      });
      setPanelMode(null);
      setSelectedAgent(null);
      refetch();
    } catch (e) {
      setCloneError(e.message);
    } finally {
      setCloning(false);
    }
  }

  async function handleDelete() {
    try {
      await apiCall('DELETE', `/api/agents/${deleteTarget.id}`);
      setDeleteTarget(null);
      refetch();
    } catch (e) {
      setActionError(e.message);
      setDeleteTarget(null);
    }
  }

  if (loading) {
    return (
      <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        {[1, 2, 3].map(i => (
          <div key={i} style={{ height: 48, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-md)' }} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" style={{
        padding: 'var(--eb-space-6)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-status-error)',
        borderRadius: 'var(--eb-radius-lg)',
        color: 'var(--eb-status-error)',
      }}>
        Failed to load agents: {error}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
          Agent Manager
        </h1>
        <button
          onClick={() => { setCreateError(null); setPanelMode('create'); }}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          <Plus size={15} /> New Agent
        </button>
      </div>

      {actionError && (
        <div role="alert" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-error-bg)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
          Error: {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer', fontSize: 'var(--eb-text-sm)' }}>Dismiss</button>
        </div>
      )}

      <DataTable
        columns={COLUMNS}
        data={[...(agents ?? [])].sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id))}
        emptyText="No agents yet. Click 'New Agent' to create the first one."
      />

      {/* Create agent panel */}
      <SidePanel
        open={panelMode === 'create'}
        onClose={() => setPanelMode(null)}
        title="New Agent"
        width="520px"
        loading={creating}
      >
        <AgentCreateForm
          onSave={handleCreate}
          onCancel={() => setPanelMode(null)}
          saving={creating}
          error={createError}
        />
      </SidePanel>

      {/* Edit config panel */}
      <SidePanel
        open={panelMode === 'edit' && !!selectedAgent}
        onClose={() => { setPanelMode(null); setSelectedAgent(null); }}
        title={`Edit: ${selectedAgent?.displayName || selectedAgent?.id}`}
      >
        {selectedAgent && panelMode === 'edit' && (
          <AgentEditForm
            agent={selectedAgent}
            onSave={handleSaveEdit}
            onCancel={() => { setPanelMode(null); setSelectedAgent(null); }}
          />
        )}
      </SidePanel>

      {/* Edit prompt panel */}
      <SidePanel
        open={panelMode === 'prompt' && !!selectedAgent}
        onClose={() => { setPanelMode(null); setSelectedAgent(null); }}
        title={`Prompt: ${selectedAgent?.displayName || selectedAgent?.id}`}
        width="600px"
      >
        {selectedAgent && panelMode === 'prompt' && (
          <PromptEditor
            agentId={selectedAgent.id}
            onClose={() => { setPanelMode(null); setSelectedAgent(null); refetch(); }}
          />
        )}
      </SidePanel>

      {/* Clone panel */}
      <SidePanel
        open={panelMode === 'clone' && !!selectedAgent}
        onClose={() => { setPanelMode(null); setSelectedAgent(null); }}
        title={`Clone: ${selectedAgent?.displayName || selectedAgent?.id}`}
        width="480px"
        loading={cloning}
      >
        {selectedAgent && panelMode === 'clone' && (
          <AgentCloneForm
            sourceAgent={selectedAgent}
            onSave={handleClone}
            onCancel={() => { setPanelMode(null); setSelectedAgent(null); }}
            saving={cloning}
            error={cloneError}
          />
        )}
      </SidePanel>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Agent"
        message={`Are you sure you want to permanently delete agent "${deleteTarget?.displayName || deleteTarget?.id}"? This will remove the agent directory and all its data.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function ActionBtn({ icon: Icon, label, onClick, danger }) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      title={label}
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)',
        padding: 'var(--eb-space-1) var(--eb-space-2)',
        background: 'var(--eb-bg-elevated)',
        border: `1px solid ${danger ? 'var(--eb-status-error)' : 'var(--eb-border-default)'}`,
        borderRadius: 'var(--eb-radius-md)',
        color: danger ? 'var(--eb-status-error)' : 'var(--eb-text-secondary)',
        cursor: 'pointer', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
      }}
    >
      <Icon size={13} />
    </button>
  );
}
