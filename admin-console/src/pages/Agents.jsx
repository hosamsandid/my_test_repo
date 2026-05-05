import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Trash2, Layers, ChevronDown, ChevronRight,
  Eye, FileText, Edit, MessageCircle,
} from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import StatusBadge from '../components/StatusBadge';

/* ── Shared style helpers ───────────────────────────────────────────── */
const labelStyle = {
  fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
  fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-0-5)',
};
const inputStyle = {
  width: '100%', padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
};

function PrimaryBtn({ children, onClick, disabled, saving, style = {} }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || saving}
      style={{
        padding: 'var(--eb-space-2) var(--eb-space-4)',
        background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
        border: 'none', borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
        cursor: (disabled || saving) ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
        opacity: (disabled || saving) ? 0.6 : 1, ...style,
      }}
    >{children}</button>
  );
}

function SecondaryBtn({ children, onClick, style = {} }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: 'var(--eb-space-2) var(--eb-space-4)',
        background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
        cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', ...style,
      }}
    >{children}</button>
  );
}

function IconBtn({ icon: Icon, label, onClick, danger, title }) {
  return (
    <button
      aria-label={label}
      title={title || label}
      onClick={onClick}
      style={{
        background: 'none',
        border: `1px solid ${danger ? 'var(--eb-status-error)' : 'var(--eb-border-default)'}`,
        borderRadius: 'var(--eb-radius-md)', cursor: 'pointer',
        color: danger ? 'var(--eb-status-error)' : 'var(--eb-text-secondary)',
        padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4,
        fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
      }}
    >
      <Icon size={13} />
    </button>
  );
}

/* ── Enable/Disable toggle ──────────────────────────────────────────── */
function ToggleSwitch({ checked, onChange, label }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      style={{
        width: 34, height: 18,
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
        position: 'absolute', top: 2, left: checked ? 16 : 2,
        width: 14, height: 14, borderRadius: '50%',
        background: 'white',
        transition: 'left var(--eb-transition-fast)',
      }} />
    </button>
  );
}

/* ── Agent (Blueprint) Create Form ─────────────────────────────────── */
function AgentCreateForm({ onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    id: '', displayName: '', role: 'expert', environmentId: '', systemPrompt: '',
    briefingsPath: '',
  });
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));
  const { data: environments } = useApi('/api/environments');
  const envs = environments || [];
  const canSubmit = form.id && form.displayName && form.environmentId &&
    (form.role === 'orchestrator' || form.systemPrompt);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)' }}>
          {error}
        </div>
      )}

      <div>
        <div style={labelStyle}>ID <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <input
          style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)' }}
          value={form.id}
          onChange={e => update('id', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
          placeholder="e.g. cobol-expert"
        />
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          Lowercase letters, digits, hyphens. Becomes the agent identifier.
        </div>
      </div>

      <FormInput label="Display Name *" value={form.displayName} onChange={v => update('displayName', v)} placeholder="COBOL Expert" />

      <div>
        <div style={labelStyle}>Working Environment <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <select value={form.environmentId} onChange={e => update('environmentId', e.target.value)} style={inputStyle} disabled={envs.length === 0}>
          <option value="">— please select —</option>
          {envs.map(env => (
            <option key={env.id} value={env.id}>
              {env.name} ({env.id})
              {env.repository?.url ? ' · Git' : ''}
              {Array.isArray(env.skills) && env.skills.length > 0 ? ` · ${env.skills.length} Skills` : ''}
            </option>
          ))}
        </select>
        {envs.length === 0 && (
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', marginTop: 'var(--eb-space-1)' }}>
            No Working Environments yet — create one first.
          </div>
        )}
      </div>

      <div>
        <div style={labelStyle}>Role <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <select value={form.role} onChange={e => update('role', e.target.value)} style={inputStyle}>
          <option value="expert">Expert — responds to questions</option>
          <option value="autonomous">Autonomous — runs on schedule</option>
          <option value="orchestrator">Orchestrator — holds BP tree &amp; domain memory</option>
        </select>
      </div>

      {form.role === 'orchestrator' && (
        <div>
          <div style={labelStyle}>Briefings-Verzeichnis</div>
          <input
            style={inputStyle}
            value={form.briefingsPath}
            onChange={e => update('briefingsPath', e.target.value)}
            placeholder="z.B. my-repo/artifacts/briefings"
          />
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
            Relativer Pfad im Agenten-Workspace zum Briefings-Verzeichnis.
          </div>
        </div>
      )}

      {form.role !== 'orchestrator' && (
      <div>
        <div style={labelStyle}>System Prompt <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <textarea
          value={form.systemPrompt}
          onChange={e => update('systemPrompt', e.target.value)}
          placeholder="You are an experienced COBOL developer..."
          rows={8}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}
        />
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          Shared by all instances. Memory instructions are added automatically.
        </div>
      </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <PrimaryBtn onClick={() => onSave(form)} saving={saving} disabled={!canSubmit}>
          {saving ? 'Creating…' : 'Create Agent'}
        </PrimaryBtn>
        <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
      </div>
    </div>
  );
}

/* ── Agent Edit Form ────────────────────────────────────────────────── */
function AgentEditForm({ agent, onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    displayName: agent.displayName || '',
    role: agent.role || 'expert',
    briefingsPath: agent.briefingsPath || '',
  });
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));
  const canSubmit = !!form.displayName;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)' }}>
          {error}
        </div>
      )}

      <div>
        <div style={labelStyle}>ID (read-only)</div>
        <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
          {agent.id}
        </div>
      </div>

      <div>
        <div style={labelStyle}>Working Environment (read-only)</div>
        <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
          {agent.environmentId}
        </div>
      </div>

      <FormInput label="Display Name *" value={form.displayName} onChange={v => update('displayName', v)} />

      <div>
        <div style={labelStyle}>Role</div>
        <select value={form.role} onChange={e => update('role', e.target.value)} style={inputStyle}>
          <option value="expert">Expert — responds to questions</option>
          <option value="autonomous">Autonomous — runs on schedule</option>
          <option value="orchestrator">Orchestrator — holds BP tree &amp; domain memory</option>
        </select>
      </div>

      {form.role === 'orchestrator' && (
        <div>
          <div style={labelStyle}>Briefings-Verzeichnis</div>
          <input
            style={inputStyle}
            value={form.briefingsPath}
            onChange={e => update('briefingsPath', e.target.value)}
            placeholder="z.B. my-repo/artifacts/briefings"
          />
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
            Relativer Pfad im Agenten-Workspace zum Briefings-Verzeichnis.
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <PrimaryBtn onClick={() => onSave(form)} saving={saving} disabled={!canSubmit}>
          {saving ? 'Saving…' : 'Save Changes'}
        </PrimaryBtn>
        <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
      </div>
    </div>
  );
}

/* ── Agent Prompt Editor (base system prompt) ───────────────────────── */
function AgentPromptEditor({ agent, onClose, saving, setSaving, setError, error }) {
  const [content, setContent] = React.useState(agent.systemPrompt || '');

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await apiCall('PUT', `/api/blueprints/${agent.id}`, { systemPrompt: content });
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)', height: '100%' }}>
      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{error}</div>
      )}
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-info-bg)', border: '1px solid var(--eb-status-info)', borderRadius: 'var(--eb-radius-md)' }}>
        Changes apply to new instances only. Existing instances already have this prompt seeded in their workspace.
      </div>
      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        rows={16}
        style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', flex: 1, minHeight: 300 }}
      />
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <PrimaryBtn onClick={handleSave} saving={saving}>{saving ? 'Saving…' : 'Save Prompt'}</PrimaryBtn>
        <SecondaryBtn onClick={onClose}>Cancel</SecondaryBtn>
      </div>
    </div>
  );
}

/* ── Session Create Form ────────────────────────────────────────────── */
function SessionCreateForm({ agent, onSave, onCancel, saving, error }) {
  const nextNum = (agent.instances?.length ?? 0) + 1;
  const [form, setForm] = useState({
    instanceId: `${agent.id}-${nextNum}`,
    displayName: `${agent.displayName} ${nextNum}`,
  });
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));
  const canSubmit = form.instanceId && form.displayName;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)' }}>
          {error}
        </div>
      )}

      <div style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-info-bg)', border: '1px solid var(--eb-status-info)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)' }}>
        New instance of <strong>{agent.displayName}</strong>. Gets its own workspace and chat history. Memory is shared with all other instances of this agent.
      </div>

      <div>
        <div style={labelStyle}>Instance ID <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <input
          style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)' }}
          value={form.instanceId}
          onChange={e => update('instanceId', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
        />
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          Becomes @id:local in Matrix.
        </div>
      </div>

      <FormInput label="Display Name *" value={form.displayName} onChange={v => update('displayName', v)} />

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <PrimaryBtn onClick={() => onSave(form)} saving={saving} disabled={!canSubmit}>
          {saving ? 'Creating instance…' : 'Create Instance'}
        </PrimaryBtn>
        <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
      </div>
    </div>
  );
}

/* ── Session Edit Form ──────────────────────────────────────────────── */
function SessionEditForm({ session, onSave, onCancel, saving, error }) {
  const [displayName, setDisplayName] = useState(session.displayName || '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)' }}>
          {error}
        </div>
      )}

      <div>
        <div style={labelStyle}>ID (read-only)</div>
        <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
          {session.id}
        </div>
      </div>

      <FormInput label="Display Name *" value={displayName} onChange={setDisplayName} />

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <PrimaryBtn onClick={() => onSave({ displayName })} saving={saving} disabled={!displayName}>
          {saving ? 'Saving…' : 'Save'}
        </PrimaryBtn>
        <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
      </div>
    </div>
  );
}

/* ── Shared Memory Viewer ───────────────────────────────────────────── */
function MemoryViewer({ agentId, onClose }) {
  const { data: contextData, loading: loadingCtx } = useApi(`/api/blueprints/${agentId}/memory/context.md`);
  const { data: logData, loading: loadingLog } = useApi(`/api/blueprints/${agentId}/memory/log.md`);

  const [activeTab, setActiveTab] = useState('context');
  const raw = activeTab === 'context' ? contextData : logData;
  const content = typeof raw === 'object' && raw !== null ? raw.content : raw;
  const loading = activeTab === 'context' ? loadingCtx : loadingLog;

  const tabStyle = (tab) => ({
    padding: 'var(--eb-space-2) var(--eb-space-3)',
    background: activeTab === tab ? 'var(--eb-bg-selected)' : 'transparent',
    border: 'none',
    borderBottom: activeTab === tab ? '2px solid var(--eb-accent-primary)' : '2px solid transparent',
    color: activeTab === tab ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
    cursor: 'pointer',
    fontSize: 'var(--eb-text-sm)',
    fontFamily: 'inherit',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', height: '100%' }}>
      <div style={{ display: 'flex', borderBottom: '1px solid var(--eb-border-default)' }}>
        <button style={tabStyle('context')} onClick={() => setActiveTab('context')}>context.md</button>
        <button style={tabStyle('log')} onClick={() => setActiveTab('log')}>log.md</button>
      </div>
      {loading ? (
        <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading…</div>
      ) : (
        <pre style={{
          flex: 1, margin: 0,
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-bg-app)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-xs)',
          fontFamily: 'var(--eb-font-mono)',
          color: 'var(--eb-text-primary)',
          overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          minHeight: 200,
        }}>
          {(typeof content === 'string' ? content : '') || '(empty)'}
        </pre>
      )}
      <SecondaryBtn onClick={onClose}>Close</SecondaryBtn>
    </div>
  );
}

/* ── Session Row ────────────────────────────────────────────────────── */
function SessionRow({ session, idx, onToggleEnabled, onEdit, onDelete, navigate }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        borderTop: idx === 0 ? 'none' : '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
      }}
    >
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: session.enabled !== false ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 'var(--eb-text-sm)' }}>{session.displayName}</span>
        <span style={{ marginLeft: 8, fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-muted)' }}>@{session.id}:local</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <ToggleSwitch
          checked={session.enabled !== false}
          onChange={() => onToggleEnabled(session)}
          label={`${session.enabled !== false ? 'Disable' : 'Enable'} instance`}
        />
        <IconBtn icon={Edit} label="Edit instance" onClick={() => onEdit(session)} />
        <IconBtn icon={MessageCircle} label="Open chat" title="Open chat" onClick={() => navigate(`/chats/${session.id}`)} />
        <IconBtn icon={Trash2} label="Delete instance" danger onClick={() => onDelete(session)} />
      </div>
    </div>
  );
}

/* ── Agent Card ─────────────────────────────────────────────────────── */
function AgentCard({ agent, onEdit, onEditPrompt, onViewMemory, onNewSession, onDelete, onToggleSessionEnabled, onEditSession, onDeleteSession, navigate }) {
  const [expanded, setExpanded] = useState(true);
  const sessions = agent.instances || [];

  return (
    <div style={{
      background: 'var(--eb-bg-surface)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
        padding: 'var(--eb-space-4)',
        background: 'var(--eb-bg-elevated)',
        borderBottom: expanded ? '1px solid var(--eb-border-default)' : 'none',
      }}>
        <button
          onClick={() => setExpanded(e => !e)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--eb-text-secondary)', padding: 0, display: 'flex' }}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <Layers size={18} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 'var(--eb-font-semibold)', fontSize: 'var(--eb-text-md)' }}>
            {agent.displayName}
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
            {agent.id} · {agent.role} · env: {agent.environmentId}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
          <span style={{
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
            background: 'var(--eb-bg-app)', padding: '2px 8px',
            borderRadius: 'var(--eb-radius-full)', border: '1px solid var(--eb-border-default)',
          }}>
            {sessions.length} instance{sessions.length !== 1 ? 's' : ''}
          </span>
          <IconBtn icon={Edit} label="Edit agent" title="Edit agent" onClick={() => onEdit(agent)} />
          <IconBtn icon={FileText} label="Edit prompt" title="Edit system prompt" onClick={() => onEditPrompt(agent)} />
          <IconBtn icon={Eye} label="View shared memory" title="View shared memory" onClick={() => onViewMemory(agent)} />
          <button
            onClick={() => onNewSession(agent)}
            style={{
              background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
              border: 'none', borderRadius: 'var(--eb-radius-md)', cursor: 'pointer',
              padding: '4px 10px', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            <Plus size={13} /> New Instance
          </button>
          <IconBtn icon={Trash2} label="Delete agent" danger onClick={() => onDelete(agent)} />
        </div>
      </div>

      {/* Sessions */}
      {expanded && (
        <div style={{ padding: sessions.length === 0 ? 'var(--eb-space-4)' : 0 }}>
          {sessions.length === 0 ? (
            <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', textAlign: 'center', padding: 'var(--eb-space-4)' }}>
              No instances yet. Click <strong>+ New Instance</strong> to create the first one.
            </div>
          ) : (
            sessions.map((sess, idx) => (
              <SessionRow
                key={sess.id}
                session={sess}
                idx={idx}
                onToggleEnabled={onToggleSessionEnabled}
                onEdit={onEditSession}
                onDelete={onDeleteSession}
                navigate={navigate}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ── Main Component ─────────────────────────────────────────────────── */
export default function Agents() {
  const navigate = useNavigate();
  const { data: agents, loading, error, refetch } = useApi('/api/blueprints');

  // panel mode: null | 'create' | 'edit-agent' | 'prompt' | 'session' | 'edit-session' | 'memory'
  const [panelMode, setPanelMode] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null); // { type: 'agent'|'session', item }
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [actionError, setActionError] = useState(null);

  function openPanel(mode, agent, session = null) {
    setSaveError(null);
    setSelectedAgent(agent);
    setSelectedSession(session);
    setPanelMode(mode);
  }

  function closePanel() {
    setPanelMode(null);
    setSelectedAgent(null);
    setSelectedSession(null);
    setSaveError(null);
  }

  async function handleCreateAgent(form) {
    setSaving(true);
    setSaveError(null);
    try {
      await apiCall('POST', '/api/blueprints', form);
      closePanel();
      refetch();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleEditAgent(form) {
    setSaving(true);
    setSaveError(null);
    try {
      await apiCall('PUT', `/api/blueprints/${selectedAgent.id}`, form);
      closePanel();
      refetch();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateSession(form) {
    setSaving(true);
    setSaveError(null);
    try {
      await apiCall('POST', `/api/blueprints/${selectedAgent.id}/instances`, form);
      closePanel();
      refetch();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleEditSession(form) {
    setSaving(true);
    setSaveError(null);
    try {
      await apiCall('PUT', `/api/agents/${selectedSession.id}`, form);
      closePanel();
      refetch();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleSessionEnabled(session) {
    try {
      await apiCall('PUT', `/api/agents/${session.id}`, { enabled: session.enabled === false });
      refetch();
    } catch (e) {
      setActionError(e.message);
    }
  }

  async function handleDelete() {
    try {
      if (deleteTarget.type === 'agent') {
        await apiCall('DELETE', `/api/blueprints/${deleteTarget.item.id}`);
      } else {
        await apiCall('DELETE', `/api/agents/${deleteTarget.item.id}`);
      }
      setDeleteTarget(null);
      refetch();
    } catch (e) {
      setActionError(e.message);
      setDeleteTarget(null);
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        {[1, 2].map(i => (
          <div key={i} style={{ height: 72, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" style={{ padding: 'var(--eb-space-6)', background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-lg)', color: 'var(--eb-status-error)' }}>
        Failed to load agents: {error}
      </div>
    );
  }

  const list = agents ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {/* Title bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>Agents</h1>
          <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', margin: 'var(--eb-space-1) 0 0' }}>
            Define an agent once. Spin up multiple instances — each with its own workspace, all sharing memory.
          </p>
        </div>
        <PrimaryBtn onClick={() => openPanel('create', null)}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Plus size={15} /> New Agent</span>
        </PrimaryBtn>
      </div>

      {actionError && (
        <div role="alert" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-error-bg)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer', fontSize: 'var(--eb-text-sm)' }}>Dismiss</button>
        </div>
      )}

      {/* Agent cards */}
      {list.length === 0 ? (
        <div style={{
          padding: 'var(--eb-space-8)', textAlign: 'center',
          background: 'var(--eb-bg-surface)', border: '1px dashed var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-lg)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)',
        }}>
          No agents yet. Click <strong>+ New Agent</strong> to create the first one.
        </div>
      ) : (
        list.map(agent => (
          <AgentCard
            key={agent.id}
            agent={agent}
            navigate={navigate}
            onEdit={a => openPanel('edit-agent', a)}
            onEditPrompt={a => openPanel('prompt', a)}
            onViewMemory={a => openPanel('memory', a)}
            onNewSession={a => openPanel('session', a)}
            onDelete={a => setDeleteTarget({ type: 'agent', item: a })}
            onToggleSessionEnabled={handleToggleSessionEnabled}
            onEditSession={s => {
              const parentAgent = list.find(a => a.instances?.some(i => i.id === s.id));
              openPanel('edit-session', parentAgent, s);
            }}
            onDeleteSession={s => setDeleteTarget({ type: 'session', item: s })}
          />
        ))
      )}

      {/* Create agent panel */}
      <SidePanel open={panelMode === 'create'} onClose={closePanel} title="New Agent" width="540px" loading={saving}>
        <AgentCreateForm onSave={handleCreateAgent} onCancel={closePanel} saving={saving} error={saveError} />
      </SidePanel>

      {/* Edit agent panel */}
      <SidePanel
        open={panelMode === 'edit-agent' && !!selectedAgent}
        onClose={closePanel}
        title={`Edit Agent — ${selectedAgent?.displayName ?? ''}`}
        width="480px"
        loading={saving}
      >
        {selectedAgent && panelMode === 'edit-agent' && (
          <AgentEditForm agent={selectedAgent} onSave={handleEditAgent} onCancel={closePanel} saving={saving} error={saveError} />
        )}
      </SidePanel>

      {/* Edit prompt panel */}
      <SidePanel
        open={panelMode === 'prompt' && !!selectedAgent}
        onClose={closePanel}
        title={`System Prompt — ${selectedAgent?.displayName ?? ''}`}
        width="600px"
        loading={saving}
      >
        {selectedAgent && panelMode === 'prompt' && (
          <AgentPromptEditor
            agent={selectedAgent}
            onClose={closePanel}
            saving={saving}
            setSaving={setSaving}
            error={saveError}
            setError={setSaveError}
          />
        )}
      </SidePanel>

      {/* Create session panel */}
      <SidePanel
        open={panelMode === 'session' && !!selectedAgent}
        onClose={closePanel}
        title={`New Instance — ${selectedAgent?.displayName ?? ''}`}
        width="480px"
        loading={saving}
      >
        {selectedAgent && panelMode === 'session' && (
          <SessionCreateForm agent={selectedAgent} onSave={handleCreateSession} onCancel={closePanel} saving={saving} error={saveError} />
        )}
      </SidePanel>

      {/* Edit session panel */}
      <SidePanel
        open={panelMode === 'edit-session' && !!selectedSession}
        onClose={closePanel}
        title={`Edit Instance — ${selectedSession?.displayName ?? ''}`}
        width="400px"
        loading={saving}
      >
        {selectedSession && panelMode === 'edit-session' && (
          <SessionEditForm session={selectedSession} onSave={handleEditSession} onCancel={closePanel} saving={saving} error={saveError} />
        )}
      </SidePanel>

      {/* Memory viewer panel */}
      <SidePanel
        open={panelMode === 'memory' && !!selectedAgent}
        onClose={closePanel}
        title={`Shared Memory — ${selectedAgent?.displayName ?? ''}`}
        width="560px"
      >
        {selectedAgent && panelMode === 'memory' && (
          <MemoryViewer agentId={selectedAgent.id} onClose={closePanel} />
        )}
      </SidePanel>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={deleteTarget?.type === 'agent' ? 'Delete Agent' : 'Delete Instance'}
        message={
          deleteTarget?.type === 'agent'
            ? `Delete agent "${deleteTarget.item.displayName ?? deleteTarget.item.id}"? This removes the agent and its shared memory. All instances must be deleted first.`
            : `Delete instance "${deleteTarget?.item.displayName ?? deleteTarget?.item.id}"? This removes the workspace and all instance data.`
        }
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
