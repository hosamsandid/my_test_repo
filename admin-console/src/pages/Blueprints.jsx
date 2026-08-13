import React, { useState, useCallback } from 'react';
import { Plus, Trash2, Layers, ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import IdField from '../components/IdField';
import { ID_FORMAT_HINT } from '../components/id-field-view';
import { missingFieldsHint } from './submit-hint.js';
import useAutoDerivedId from '../hooks/useAutoDerivedId';
import StatusBadge from '../components/StatusBadge';

const hasRepos = (env) =>
  (Array.isArray(env?.repositories) && env.repositories.length > 0) ||
  !!env?.repository?.url;

/* ── Helpers ───────────────────────────────────────────────────────── */
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

function PrimaryBtn({ children, onClick, disabled, saving, style = {}, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || saving}
      title={title}
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

/* ── Blueprint Create Form ─────────────────────────────────────────── */
function BlueprintCreateForm({ onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    id: '', displayName: '', role: 'agent', environmentId: '', systemPrompt: '',
  });
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName: v => update('displayName', v),
    setId:   v => update('id', v),
    getName: () => form.displayName,
  });
  const { data: environments } = useApi('/api/environments');
  const envs = environments || [];
  const canSubmit = form.id && form.displayName && form.systemPrompt && form.environmentId;
  // Explain a disabled "Create Blueprint" by naming the still-empty required
  // fields (in form order) — see submit-hint.js.
  const submitHint = missingFieldsHint([
    { label: 'Display Name', filled: !!form.displayName },
    { label: 'ID', filled: !!form.id },
    { label: 'Working Environment', filled: !!form.environmentId },
    { label: 'System Prompt', filled: !!form.systemPrompt },
  ]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)' }}>
          {error}
        </div>
      )}

      <FormInput label="Display Name *" value={form.displayName} onChange={handleNameChange} placeholder="COBOL Agent" />

      <IdField
        value={form.id}
        onChange={handleIdChange}
        isAutoDerived={isAutoDerived()}
        onResetAuto={resetAutoDerive}
        placeholder="e.g. cobol-agent"
        helpText={<>Auto-derived from Display Name; edit to override. {ID_FORMAT_HINT} Becomes the agent identifier.</>}
      />

      <div>
        <div style={labelStyle}>Working Environment <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <select value={form.environmentId} onChange={e => update('environmentId', e.target.value)} style={inputStyle} disabled={envs.length === 0}>
          <option value="">— please select —</option>
          {envs.map(env => (
            <option key={env.id} value={env.id}>
              {env.name} ({env.id})
              {hasRepos(env) ? ' · Git' : ''}
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
          <option value="agent">Agent — responds to questions</option>
        </select>
      </div>

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

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <PrimaryBtn onClick={() => onSave(form)} saving={saving} disabled={!canSubmit} title={submitHint || undefined}>
          {saving ? 'Creating…' : 'Create Blueprint'}
        </PrimaryBtn>
        <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
      </div>
    </div>
  );
}

/* ── Instance Create Form ──────────────────────────────────────────── */
function InstanceCreateForm({ blueprint, onSave, onCancel, saving, error }) {
  const nextNum = (blueprint.instances?.length ?? 0) + 1;
  const [form, setForm] = useState({
    instanceId: `${blueprint.id}-${nextNum}`,
    displayName: `${blueprint.displayName} ${nextNum}`,
  });
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));
  const canSubmit = form.instanceId && form.displayName;
  const submitHint = missingFieldsHint([
    { label: 'Instance ID', filled: !!form.instanceId },
    { label: 'Display Name', filled: !!form.displayName },
  ]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)' }}>
          {error}
        </div>
      )}

      <div style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-info-bg)', border: '1px solid var(--eb-status-info)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)' }}>
        New instance of <strong>{blueprint.displayName}</strong>. Gets its own workspace and sessions. Memory is shared with all other instances of this blueprint.
      </div>

      <div>
        <div style={labelStyle}>Instance ID <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <input
          style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)' }}
          value={form.instanceId}
          onChange={e => update('instanceId', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
        />
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          {ID_FORMAT_HINT} Identifies the agent in URLs and as the workspace folder name.
        </div>
      </div>

      <FormInput
        label="Display Name *"
        value={form.displayName}
        onChange={v => update('displayName', v)}
      />

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <PrimaryBtn onClick={() => onSave(form)} saving={saving} disabled={!canSubmit} title={submitHint || undefined}>
          {saving ? 'Creating instance…' : 'Create Instance'}
        </PrimaryBtn>
        <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
      </div>
    </div>
  );
}

/* ── Shared Memory Viewer ──────────────────────────────────────────── */
const MEMORY_TABS = ['context.md', 'log.md', 'facts.md', 'entities.md', 'users.md'];

function MemoryViewer({ blueprintId, onClose }) {
  const [activeTab, setActiveTab] = useState('context.md');
  const { data: raw, loading } = useApi(`/api/blueprints/${blueprintId}/memory/${activeTab}`);
  const content = typeof raw === 'object' && raw !== null ? raw.content : raw;

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
      <div style={{ display: 'flex', borderBottom: '1px solid var(--eb-border-default)', flexWrap: 'wrap' }}>
        {MEMORY_TABS.map(tab => (
          <button key={tab} style={tabStyle(tab)} onClick={() => setActiveTab(tab)}>{tab}</button>
        ))}
      </div>
      {loading ? (
        <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading…</div>
      ) : (
        <pre style={{
          flex: 1,
          margin: 0,
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-bg-app)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-xs)',
          fontFamily: 'var(--eb-font-mono)',
          color: 'var(--eb-text-primary)',
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          minHeight: 200,
        }}>
          {(typeof content === 'string' ? content : '') || '(empty)'}
        </pre>
      )}
      <SecondaryBtn onClick={onClose}>Close</SecondaryBtn>
    </div>
  );
}

/* ── Blueprint Card ────────────────────────────────────────────────── */
function BlueprintCard({ blueprint, onDelete, onNewInstance, onViewMemory }) {
  const [expanded, setExpanded] = useState(true);
  const instances = blueprint.instances || [];

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
            {blueprint.displayName}
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
            {blueprint.id} · {blueprint.role} · env: {blueprint.environmentId}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
          <span style={{
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
            background: 'var(--eb-bg-app)', padding: '2px 8px',
            borderRadius: 'var(--eb-radius-full)', border: '1px solid var(--eb-border-default)',
          }}>
            {instances.length} instance{instances.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={() => onViewMemory(blueprint)}
            title="View shared memory"
            style={{ background: 'none', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', cursor: 'pointer', color: 'var(--eb-text-secondary)', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)' }}
          >
            <Eye size={13} /> Memory
          </button>
          <button
            onClick={() => onNewInstance(blueprint)}
            style={{ background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', cursor: 'pointer', padding: '4px 10px', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}
          >
            <Plus size={13} /> New Instance
          </button>
          <button
            onClick={() => onDelete(blueprint)}
            title="Delete blueprint"
            style={{ background: 'none', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', cursor: 'pointer', color: 'var(--eb-status-error)', padding: '4px 8px', display: 'flex' }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Instances */}
      {expanded && (
        <div style={{ padding: instances.length === 0 ? 'var(--eb-space-4)' : 0 }}>
          {instances.length === 0 ? (
            <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', textAlign: 'center', padding: 'var(--eb-space-4)' }}>
              No instances yet. Click <strong>+ New Instance</strong> to create the first one.
            </div>
          ) : (
            instances.map((inst, idx) => (
              <div
                key={inst.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
                  padding: 'var(--eb-space-3) var(--eb-space-4)',
                  borderTop: idx === 0 ? 'none' : '1px solid var(--eb-border-default)',
                  background: 'var(--eb-bg-surface)',
                }}
              >
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--eb-accent-primary)', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 'var(--eb-text-sm)' }}>{inst.displayName}</span>
                  <span style={{ marginLeft: 8, fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-muted)' }}>{inst.id}</span>
                </div>
                <StatusBadge enabled={inst.enabled !== false} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ── Main Component ────────────────────────────────────────────────── */
export default function Blueprints() {
  const { data: blueprints, loading, error, refetch } = useApi('/api/blueprints');

  const [panelMode, setPanelMode] = useState(null); // 'create' | 'instance' | 'memory'
  const [selectedBlueprint, setSelectedBlueprint] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  async function handleCreateBlueprint(form) {
    setSaving(true);
    setSaveError(null);
    try {
      await apiCall('POST', '/api/blueprints', form);
      setPanelMode(null);
      refetch();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateInstance(form) {
    setSaving(true);
    setSaveError(null);
    try {
      await apiCall('POST', `/api/blueprints/${selectedBlueprint.id}/instances`, form);
      setPanelMode(null);
      setSelectedBlueprint(null);
      refetch();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    try {
      await apiCall('DELETE', `/api/blueprints/${deleteTarget.id}`);
      setDeleteTarget(null);
      refetch();
    } catch (e) {
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
        Failed to load blueprints: {error}
      </div>
    );
  }

  const list = blueprints ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {/* Title bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
            Agent Blueprints
          </h1>
          <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', margin: 'var(--eb-space-1) 0 0' }}>
            Define a blueprint once. Spin up multiple instances — each with its own workspace, all sharing memory.
          </p>
        </div>
        <PrimaryBtn onClick={() => { setSaveError(null); setPanelMode('create'); }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Plus size={15} /> New Blueprint</span>
        </PrimaryBtn>
      </div>

      {/* Blueprint cards */}
      {list.length === 0 ? (
        <div style={{
          padding: 'var(--eb-space-8)', textAlign: 'center',
          background: 'var(--eb-bg-surface)', border: '1px dashed var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-lg)', color: 'var(--eb-text-muted)',
          fontSize: 'var(--eb-text-sm)',
        }}>
          No blueprints yet. Create your first one to get started.
        </div>
      ) : (
        list.map(bp => (
          <BlueprintCard
            key={bp.id}
            blueprint={bp}
            onDelete={setDeleteTarget}
            onNewInstance={(bp) => { setSaveError(null); setSelectedBlueprint(bp); setPanelMode('instance'); }}
            onViewMemory={(bp) => { setSelectedBlueprint(bp); setPanelMode('memory'); }}
          />
        ))
      )}

      {/* Create blueprint panel */}
      <SidePanel
        open={panelMode === 'create'}
        onClose={() => { setPanelMode(null); setSaveError(null); }}
        title="New Blueprint"
        width="540px"
        loading={saving}
      >
        <BlueprintCreateForm
          onSave={handleCreateBlueprint}
          onCancel={() => { setPanelMode(null); setSaveError(null); }}
          saving={saving}
          error={saveError}
        />
      </SidePanel>

      {/* Create instance panel */}
      <SidePanel
        open={panelMode === 'instance' && !!selectedBlueprint}
        onClose={() => { setPanelMode(null); setSelectedBlueprint(null); setSaveError(null); }}
        title={`New Instance — ${selectedBlueprint?.displayName ?? ''}`}
        width="480px"
        loading={saving}
      >
        {selectedBlueprint && panelMode === 'instance' && (
          <InstanceCreateForm
            blueprint={selectedBlueprint}
            onSave={handleCreateInstance}
            onCancel={() => { setPanelMode(null); setSelectedBlueprint(null); setSaveError(null); }}
            saving={saving}
            error={saveError}
          />
        )}
      </SidePanel>

      {/* Memory viewer panel */}
      <SidePanel
        open={panelMode === 'memory' && !!selectedBlueprint}
        onClose={() => { setPanelMode(null); setSelectedBlueprint(null); }}
        title={`Shared Memory — ${selectedBlueprint?.displayName ?? ''}`}
        width="560px"
      >
        {selectedBlueprint && panelMode === 'memory' && (
          <MemoryViewer
            blueprintId={selectedBlueprint.id}
            onClose={() => { setPanelMode(null); setSelectedBlueprint(null); }}
          />
        )}
      </SidePanel>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Blueprint"
        message={`Delete blueprint "${deleteTarget?.displayName ?? deleteTarget?.id}"? This removes the blueprint and its shared memory. All instances must be deleted first.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
