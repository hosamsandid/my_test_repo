import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Trash2, Layers, ChevronDown, ChevronRight,
  Edit, MessageCircle, RefreshCw, Power, PowerOff,
} from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';

const hasRepos = (env) =>
  (Array.isArray(env?.repositories) && env.repositories.length > 0) ||
  !!env?.repository?.url;

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

function IconBtn({ icon: Icon, label, onClick, danger, title, disabled }) {
  return (
    <button
      aria-label={label}
      title={title || label}
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'none',
        border: `1px solid ${danger ? 'var(--eb-status-error)' : 'var(--eb-border-default)'}`,
        borderRadius: 'var(--eb-radius-md)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: danger ? 'var(--eb-status-error)' : 'var(--eb-text-secondary)',
        padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4,
        fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Icon size={13} />
    </button>
  );
}

/* ── Enable/Disable toggle ──────────────────────────────────────────── */
function ToggleSwitch({ checked, onChange, label, disabled }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      style={{
        width: 34, height: 18,
        borderRadius: 'var(--eb-radius-full)',
        border: 'none',
        background: checked ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)',
        position: 'relative',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background var(--eb-transition-fast)',
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
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

/* ── Agent state derivation ────────────────────────────────────────── */
// Three states: stub (no token, never activated), active (token + enabled),
// paused (token + disabled). Drive UI off this single function.
function agentState(agent) {
  if (!agent.token && agent.enabled === false) return 'stub';
  if (agent.enabled === false) return 'paused';
  return 'active';
}

function StateBadge({ state }) {
  const cfg = {
    stub:    { bg: 'var(--eb-bg-app)',            color: 'var(--eb-text-muted)',     label: 'Not initialised' },
    paused:  { bg: 'var(--eb-status-warning-bg)', color: 'var(--eb-status-warning)', label: 'Paused' },
    active:  { bg: 'var(--eb-status-success-bg)', color: 'var(--eb-status-success)', label: 'Active' },
  }[state] || { bg: 'var(--eb-bg-app)', color: 'var(--eb-text-muted)', label: state };
  return (
    <span style={{
      fontSize: 'var(--eb-text-xs)', color: cfg.color, background: cfg.bg,
      padding: '2px 8px', borderRadius: 'var(--eb-radius-full)',
      border: `1px solid ${cfg.color}`,
    }}>{cfg.label}</span>
  );
}

/* ── Agent Create Form ─────────────────────────────────────────────── */
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
              {hasRepos(env) ? ' · Git' : ''}
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
          <option value="orchestrator">Orchestrator — manages BPs in a directory</option>
        </select>
      </div>

      {form.role === 'orchestrator' && (
        <div>
          <div style={labelStyle}>Briefings Directory</div>
          <input
            style={inputStyle}
            value={form.briefingsPath}
            onChange={e => update('briefingsPath', e.target.value)}
            placeholder="e.g. my-repo"
          />
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
            Relative path in the agent workspace. The <code>artifacts/briefings/</code> subdirectory is appended automatically. On creation, a stub is added for every BP found here.
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
        <div style={labelStyle}>Role (read-only)</div>
        <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
          {agent.role}
        </div>
      </div>

      <div>
        <div style={labelStyle}>Working Environment (read-only)</div>
        <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
          {agent.environmentId}
        </div>
      </div>

      <FormInput label="Display Name *" value={form.displayName} onChange={v => update('displayName', v)} />

      {agent.role === 'orchestrator' && (
        <div>
          <div style={labelStyle}>Briefings Directory</div>
          <input
            style={inputStyle}
            value={form.briefingsPath}
            onChange={e => update('briefingsPath', e.target.value)}
            placeholder="e.g. my-repo"
          />
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

/* ── Agent Row ──────────────────────────────────────────────────────── */
function AgentRow({ agent, onActivate, onDeactivate, onToggleEnabled, onEdit, onDelete, navigate, indent, busy }) {
  const state = agentState(agent);
  const isStub = state === 'stub';
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        paddingLeft: indent ? 'var(--eb-space-8)' : 'var(--eb-space-4)',
        borderTop: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
        opacity: isStub ? 0.85 : 1,
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <span style={{ fontSize: 'var(--eb-text-sm)' }}>{agent.displayName}</span>
        <span style={{ fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-muted)' }}>
          @{agent.id}:local
        </span>
        <StateBadge state={state} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        {isStub ? (
          <PrimaryBtn
            onClick={() => onActivate(agent)}
            saving={busy}
            style={{ padding: '4px 10px', fontSize: 'var(--eb-text-xs)' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Power size={13} /> Activate
            </span>
          </PrimaryBtn>
        ) : (
          <>
            <ToggleSwitch
              checked={state === 'active'}
              onChange={() => onToggleEnabled(agent)}
              label={state === 'active' ? 'Disable' : 'Enable'}
              disabled={busy}
            />
            <IconBtn
              icon={PowerOff}
              label="Deactivate"
              title="Deactivate — reset to stub state"
              onClick={() => onDeactivate(agent)}
              disabled={busy}
            />
          </>
        )}
        <IconBtn icon={Edit} label="Edit" onClick={() => onEdit(agent)} disabled={isStub} />
        <IconBtn
          icon={MessageCircle}
          label="Open chat"
          title={isStub ? 'Stub — activate first' : 'Open chat'}
          onClick={() => !isStub && navigate(`/chats/${agent.id}`)}
          disabled={isStub}
        />
        <IconBtn icon={Trash2} label="Delete" danger onClick={() => onDelete(agent)} />
      </div>
    </div>
  );
}

/* ── Orchestrator Card (with bp-instance children) ─────────────────── */
function OrchestratorCard({ agent, onEdit, onDelete, onSyncBps, onActivate, onDeactivate, onToggleEnabled, onEditChild, onDeleteChild, navigate, syncing, busyIds }) {
  const [expanded, setExpanded] = useState(true);
  const children = agent.children || [];
  const state = agentState(agent);
  const isStub = state === 'stub';

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
          <div style={{ fontWeight: 'var(--eb-font-semibold)', fontSize: 'var(--eb-text-md)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
            {agent.displayName}
            <StateBadge state={state} />
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
            {agent.id} · orchestrator · env: {agent.environmentId}
            {agent.briefingsPath ? ` · path: ${agent.briefingsPath}` : ''}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
          <span style={{
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
            background: 'var(--eb-bg-app)', padding: '2px 8px',
            borderRadius: 'var(--eb-radius-full)', border: '1px solid var(--eb-border-default)',
          }}>
            {children.length} BP{children.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={() => onSyncBps(agent)}
            disabled={syncing || isStub}
            title={isStub ? 'Activate the orchestrator first' : 'Re-scan the briefings directory'}
            style={{
              background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)', cursor: (syncing || isStub) ? 'not-allowed' : 'pointer',
              padding: '4px 10px', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 4, color: 'var(--eb-text-secondary)',
              opacity: (syncing || isStub) ? 0.5 : 1,
            }}
          >
            <RefreshCw size={13} /> {syncing ? 'Syncing…' : 'Sync BPs'}
          </button>
          {isStub ? (
            <PrimaryBtn
              onClick={() => onActivate(agent)}
              saving={busyIds.has(agent.id)}
              style={{ padding: '4px 10px', fontSize: 'var(--eb-text-xs)' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Power size={13} /> Activate
              </span>
            </PrimaryBtn>
          ) : (
            <>
              <ToggleSwitch
                checked={state === 'active'}
                onChange={() => onToggleEnabled(agent)}
                label={state === 'active' ? 'Disable' : 'Enable'}
                disabled={busyIds.has(agent.id)}
              />
              <IconBtn
                icon={PowerOff}
                label="Deactivate"
                title="Deactivate — reset to stub state"
                onClick={() => onDeactivate(agent)}
                disabled={busyIds.has(agent.id)}
              />
            </>
          )}
          <IconBtn icon={Edit} label="Edit" onClick={() => onEdit(agent)} />
          <IconBtn icon={MessageCircle} label="Open chat" onClick={() => !isStub && navigate(`/chats/${agent.id}`)} disabled={isStub} />
          <IconBtn icon={Trash2} label="Delete" danger onClick={() => onDelete(agent)} />
        </div>
      </div>

      {/* Children */}
      {expanded && (
        children.length === 0 ? (
          <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', textAlign: 'center', padding: 'var(--eb-space-4)' }}>
            {isStub
              ? 'Activate the orchestrator to load its Briefing Packs.'
              : 'No Briefing Packs found. Click Sync BPs to re-scan the directory.'}
          </div>
        ) : (
          children.map((child) => (
            <AgentRow
              key={child.id}
              agent={child}
              indent
              navigate={navigate}
              busy={busyIds.has(child.id)}
              onActivate={onActivate}
              onDeactivate={onDeactivate}
              onToggleEnabled={onToggleEnabled}
              onEdit={onEditChild}
              onDelete={onDeleteChild}
            />
          ))
        )
      )}
    </div>
  );
}

/* ── Leaf Agent Card (expert / autonomous) ─────────────────────────── */
function LeafAgentCard({ agent, onEdit, onDelete, onToggleEnabled, onDeactivate, navigate, busy }) {
  const state = agentState(agent);

  return (
    <div style={{
      background: 'var(--eb-bg-surface)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
        padding: 'var(--eb-space-4)',
        background: 'var(--eb-bg-elevated)',
      }}>
        <Layers size={18} style={{ color: 'var(--eb-text-secondary)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 'var(--eb-font-semibold)', fontSize: 'var(--eb-text-md)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
            {agent.displayName}
            <StateBadge state={state} />
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
            {agent.id} · {agent.role} · env: {agent.environmentId}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <ToggleSwitch
            checked={state === 'active'}
            onChange={() => onToggleEnabled(agent)}
            label={state === 'active' ? 'Disable' : 'Enable'}
            disabled={busy}
          />
          <IconBtn
            icon={PowerOff}
            label="Deactivate"
            title="Deactivate — reset to stub state"
            onClick={() => onDeactivate(agent)}
            disabled={busy}
          />
          <IconBtn icon={Edit} label="Edit" onClick={() => onEdit(agent)} />
          <IconBtn icon={MessageCircle} label="Open chat" onClick={() => navigate(`/chats/${agent.id}`)} />
          <IconBtn icon={Trash2} label="Delete" danger onClick={() => onDelete(agent)} />
        </div>
      </div>
    </div>
  );
}

/* ── Main Component ─────────────────────────────────────────────────── */
export default function Agents() {
  const navigate = useNavigate();
  const { data: rawAgents, loading, error, refetch } = useApi('/api/agents');

  const [panelMode, setPanelMode] = useState(null); // null | 'create' | 'edit'
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deactivateTarget, setDeactivateTarget] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [syncingId, setSyncingId] = useState(null);
  const [busyIds, setBusyIds] = useState(new Set());

  const agents = rawAgents || [];
  const bpInstances = agents.filter(a => a.role === 'bp-instance');
  const orchestrators = agents
    .filter(a => a.role === 'orchestrator')
    .map(o => ({ ...o, children: bpInstances.filter(c => c.parentOrchestratorId === o.id) }));
  const leaves = agents.filter(a => a.role !== 'orchestrator' && a.role !== 'bp-instance');

  function openPanel(mode, agent) {
    setSaveError(null);
    setSelectedAgent(agent);
    setPanelMode(mode);
  }
  function closePanel() {
    setPanelMode(null);
    setSelectedAgent(null);
    setSaveError(null);
  }

  function markBusy(id, busy) {
    setBusyIds(prev => {
      const next = new Set(prev);
      if (busy) next.add(id); else next.delete(id);
      return next;
    });
  }

  async function handleCreateAgent(form) {
    setSaving(true);
    setSaveError(null);
    try {
      await apiCall('POST', '/api/agents', form);
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
      await apiCall('PUT', `/api/agents/${selectedAgent.id}`, form);
      closePanel();
      refetch();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate(agent) {
    markBusy(agent.id, true);
    try {
      await apiCall('PUT', `/api/agents/${agent.id}`, { enabled: true });
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(agent.id, false);
    }
  }

  async function handleToggleEnabled(agent) {
    markBusy(agent.id, true);
    try {
      await apiCall('PUT', `/api/agents/${agent.id}`, { enabled: agent.enabled === false });
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(agent.id, false);
    }
  }

  async function handleSyncBps(agent) {
    setSyncingId(agent.id);
    try {
      await apiCall('POST', `/api/agents/${agent.id}/sync-bps`);
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setSyncingId(null);
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

  async function handleDeactivateConfirmed() {
    const target = deactivateTarget;
    setDeactivateTarget(null);
    if (!target) return;
    markBusy(target.id, true);
    try {
      await apiCall('POST', `/api/agents/${target.id}/deactivate`);
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(target.id, false);
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

  const totalCount = orchestrators.length + leaves.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>Agents</h1>
          <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', margin: 'var(--eb-space-1) 0 0' }}>
            Each agent runs as its own Matrix user. Orchestrator agents auto-list one stub per Briefing Pack — activate to materialise.
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

      {totalCount === 0 ? (
        <div style={{
          padding: 'var(--eb-space-8)', textAlign: 'center',
          background: 'var(--eb-bg-surface)', border: '1px dashed var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-lg)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)',
        }}>
          No agents yet. Click <strong>+ New Agent</strong> to create the first one.
        </div>
      ) : (
        <>
          {orchestrators.map(o => (
            <OrchestratorCard
              key={o.id}
              agent={o}
              navigate={navigate}
              syncing={syncingId === o.id}
              busyIds={busyIds}
              onEdit={a => openPanel('edit', a)}
              onDelete={a => setDeleteTarget(a)}
              onSyncBps={handleSyncBps}
              onActivate={handleActivate}
              onDeactivate={a => setDeactivateTarget(a)}
              onToggleEnabled={handleToggleEnabled}
              onEditChild={a => openPanel('edit', a)}
              onDeleteChild={a => setDeleteTarget(a)}
            />
          ))}
          {leaves.map(a => (
            <LeafAgentCard
              key={a.id}
              agent={a}
              navigate={navigate}
              busy={busyIds.has(a.id)}
              onEdit={ag => openPanel('edit', ag)}
              onDelete={ag => setDeleteTarget(ag)}
              onDeactivate={ag => setDeactivateTarget(ag)}
              onToggleEnabled={handleToggleEnabled}
            />
          ))}
        </>
      )}

      <SidePanel open={panelMode === 'create'} onClose={closePanel} title="New Agent" width="540px" loading={saving}>
        <AgentCreateForm onSave={handleCreateAgent} onCancel={closePanel} saving={saving} error={saveError} />
      </SidePanel>

      <SidePanel
        open={panelMode === 'edit' && !!selectedAgent}
        onClose={closePanel}
        title={`Edit Agent — ${selectedAgent?.displayName ?? ''}`}
        width="480px"
        loading={saving}
      >
        {selectedAgent && panelMode === 'edit' && (
          <AgentEditForm agent={selectedAgent} onSave={handleEditAgent} onCancel={closePanel} saving={saving} error={saveError} />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Agent"
        message={
          deleteTarget?.role === 'orchestrator'
            ? `Delete orchestrator "${deleteTarget.displayName}"? Its BP-instance children must be deleted separately.`
            : `Delete agent "${deleteTarget?.displayName ?? deleteTarget?.id}"? This removes the workspace and all associated data.`
        }
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={!!deactivateTarget}
        title="Deactivate Agent"
        message={
          `Reset "${deactivateTarget?.displayName ?? deactivateTarget?.id}" to its stub state? ` +
          `This stops the agent process, deactivates its Matrix user, and wipes the workspace. ` +
          `The stub config is kept so the agent can be reactivated later — but session history, ` +
          `cloned repositories, and any in-workspace state will be lost.`
        }
        variant="danger"
        confirmLabel="Deactivate"
        onConfirm={handleDeactivateConfirmed}
        onCancel={() => setDeactivateTarget(null)}
      />
    </div>
  );
}
